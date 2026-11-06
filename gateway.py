"""web_terminal gateway — จุดเข้าเดียวของเว็บ (WEB_TERMINAL_PLAN.md)

P0: auth + security headers + static
P1: proxy REST (อ่านอย่างเดียว) + WebSocket ไป worker ของแต่ละบัญชี — gateway ไม่แตะ MT5 เอง
รัน: uvicorn gateway:app --host 127.0.0.1 --port 8100   (Caddy ทำ HTTPS อยู่ข้างหน้า)

env:
  WT_PASS_HASH     (บังคับ) ได้จาก `python hash_password.py`
  WT_ORIGIN        (บังคับ) เช่น https://terminal.example.com — POST ที่ Origin ไม่ตรงถูกปฏิเสธ
  WT_DB            path SQLite (default web_terminal.db ข้างไฟล์นี้)
  WT_COOKIE_SECURE 1 (default) / 0 เฉพาะทดสอบบน http://127.0.0.1
  WT_WORKER_KEY    (บังคับ) key ร่วมกับ worker ทุกตัว
"""
import asyncio
import hashlib
import hmac
import json
import math
import os
import re
import sys
import threading
import time
import uuid
from pathlib import Path

import httpx
import websockets
from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from accounts import build_accounts, clean_entry, detect_kind, load_accounts, save_accounts
import backup
import news
import push
from auth import SESSION_TTL_SEC, AuthStore, verify_password
from drawings import ACCT_RE, SYMBOL_RE, AlertLog, DrawingStore, JournalStore, PrefStore, ReplayStore, clean_overlays

BASE = Path(__file__).resolve().parent
STATIC = BASE / "static"
COOKIE = "wt_session"
CSRF_HEADER = "x-requested-with"
CSRF_VALUE = "wt"
TRUSTED_PROXIES = {"127.0.0.1", "::1"}

# เส้นทางที่เข้าได้โดยไม่ต้องล็อกอิน
PUBLIC_PATHS = {"/login", "/api/auth/login", "/healthz", "/static/login.js", "/static/style.css",
                # เบราว์เซอร์ดึง manifest/ไอคอนโดยไม่แนบ cookie (เพิ่มลงหน้าจอหลัก)
                "/static/manifest.webmanifest", "/static/icon-192.png", "/static/icon-512.png",
                "/static/apple-touch-icon.png", "/static/favicon-32.png",
                "/sw.js"}   # service worker (แจ้งเตือน Web Push) — ไม่มีข้อมูลลับ

# endpoint ของ worker ที่ gateway ยอมส่งต่อ (GET อย่างเดียวใน P1)
WORKER_GET_PATHS = {"status", "account", "positions", "orders", "symbols", "rates", "symbol_spec", "ltf", "history",
                    "autobe", "prules", "rates_range"}
WORKER_POST_PATHS = {"calc", "trade/order", "trade/order/modify", "trade/order/cancel", "trade/orders/cancel_all",
                     "trade/position/modify", "trade/position/close", "trade/positions/close_all",
                     "trade/position/breakeven", "autobe", "prules", "trade/orders/rerisk", "rerisk_preview"}
WS_CLIENT_OPS = {"subscribe", "ping"}
FLOW_PATHS = {"status", "bars", "profile", "liq"}    # order flow Binance (flow.py / pm2 wt-flow)
PALERTS_KEY = "wt.palerts"       # alert เส้นราคา — แก้ผ่าน /api/palerts เท่านั้น (server เป็นเจ้าของ ตัวส่งปิดเองเมื่อยิงแล้ว)
PALERTS_MAX = 100
RESERVED_PREFS = {PALERTS_KEY}

SECURITY_HEADERS = {
    "X-Frame-Options": "DENY",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": (
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; "
        "connect-src 'self' {ws_origin}; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
    ),
    "Cache-Control": "no-store",
}


class LoginBody(BaseModel):
    password: str


def create_app() -> FastAPI:
    pass_hash = os.environ.get("WT_PASS_HASH", "").strip()
    origin = os.environ.get("WT_ORIGIN", "").strip().rstrip("/")
    if not pass_hash.startswith("scrypt$"):
        raise RuntimeError("WT_PASS_HASH ไม่ได้ตั้ง หรือผิดรูปแบบ — รัน python hash_password.py ก่อน")
    if not origin.startswith("https://") and os.environ.get("WT_COOKIE_SECURE", "1") != "0":
        raise RuntimeError("WT_ORIGIN ต้องเป็น https://... (ตั้ง WT_COOKIE_SECURE=0 เฉพาะทดสอบในเครื่อง)")
    cookie_secure = os.environ.get("WT_COOKIE_SECURE", "1") != "0"
    worker_key = os.environ.get("WT_WORKER_KEY", "")
    if len(worker_key) < 16:
        raise RuntimeError("WT_WORKER_KEY ต้องยาว ≥16 ตัวอักษร")
    env_acc = os.environ.get("WT_ACCOUNTS")
    accounts_path = Path(env_acc) if env_acc else (BASE / "accounts.local.json" if (BASE / "accounts.local.json").exists() else BASE / "accounts.json")
    save_path = Path(env_acc) if env_acc else BASE / "accounts.local.json"   # หน้าเว็บบันทึกลง local (ไม่อยู่ใน git)
    accounts = load_accounts(accounts_path)
    ws_origin = "ws" + origin[4:] if origin.startswith("http") else ""
    headers_tpl = {k: v.format(ws_origin=ws_origin) for k, v in SECURITY_HEADERS.items()}
    db_path = os.environ.get("WT_DB", str(BASE / "web_terminal.db"))
    backup_dir = Path(os.environ.get("WT_BACKUP_DIR", str(Path(db_path).parent / "backups")))
    if os.environ.get("WT_BACKUP", "1") != "0":
        backup.start(Path(db_path), backup_dir, BASE)   # วันละชุด เก็บ 14 วัน (backups/YYYY-MM-DD)
    store = AuthStore(db_path)
    drawings = DrawingStore(db_path)
    prefs = PrefStore(db_path)
    replays = ReplayStore(db_path)
    journal = JournalStore(db_path)
    alert_log = AlertLog(db_path)
    pushes = push.PushStore(db_path, os.environ.get("WT_VAPID_SUB") or origin or "mailto:admin@localhost")
    alert_rt = {"last_seen": 0.0, "test_at": None, "telegram": None}
    palerts_lock = threading.Lock()
    started = time.time()

    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
    # client เดียวใช้ร่วม: สร้าง AsyncClient ใหม่ทุก request โหลด SSL context ~0.4 วินาทีและบล็อก event loop
    # keepalive_expiry 2s < keep-alive ของ uvicorn (5s) -> ไม่ส่งคำสั่งลง connection ที่ worker กำลังปิด
    # ผูกกับ event loop ที่สร้าง: loop ใหม่ (เช่น TestClient แต่ละชุด) = สร้างใหม่
    _http: dict = {}

    def http() -> httpx.AsyncClient:
        loop = asyncio.get_running_loop()
        if _http.get("loop") is not loop:
            _http.update(loop=loop, cli=httpx.AsyncClient(
                trust_env=False, limits=httpx.Limits(max_keepalive_connections=20, keepalive_expiry=2)))
        return _http["cli"]
    app.state.store = store

    def client_ip(request: Request) -> str:
        host = request.client.host if request.client else ""
        if host in TRUSTED_PROXIES:
            # Caddy ต่อ IP จริงไว้ท้ายสุดของ X-Forwarded-For — ค่าที่ client ปลอมมาจะอยู่ด้านหน้า
            xff = request.headers.get("x-forwarded-for", "")
            if xff:
                return xff.split(",")[-1].strip()
        return host

    def internal_ok(request: Request) -> bool:
        # เรียกจากในเครื่องเท่านั้น: ต่อตรง 127.0.0.1 (ไม่ผ่าน Caddy = ไม่มี X-Forwarded-For) + มี worker key
        host = request.client.host if request.client else ""
        key = request.headers.get("x-worker-key") or ""
        return (host in TRUSTED_PROXIES and "x-forwarded-for" not in request.headers
                and hmac.compare_digest(key, worker_key))

    @app.middleware("http")
    async def guard(request: Request, call_next):
        path = request.url.path
        method = request.method.upper()
        if path.startswith("/internal/"):
            if not internal_ok(request):
                return _secure(JSONResponse({"detail": "forbidden"}, status_code=403), headers_tpl)
            return _secure(await call_next(request), headers_tpl)

        if method not in ("GET", "HEAD", "OPTIONS"):
            # CSRF: ต้องมี header ที่ฟอร์มข้ามเว็บใส่ไม่ได้ + Origin (ถ้ามี) ต้องตรง
            if request.headers.get(CSRF_HEADER) != CSRF_VALUE:
                return _secure(JSONResponse({"detail": "csrf"}, status_code=403), headers_tpl)
            req_origin = request.headers.get("origin")
            if req_origin is not None and req_origin.rstrip("/") != origin:
                return _secure(JSONResponse({"detail": "bad origin"}, status_code=403), headers_tpl)

        if path not in PUBLIC_PATHS and not store.valid_session(request.cookies.get(COOKIE)):
            if path.startswith("/api/") or path.startswith("/ws/") or method != "GET":
                return _secure(JSONResponse({"detail": "unauthorized"}, status_code=401), headers_tpl)
            return _secure(RedirectResponse("/login", status_code=303), headers_tpl)

        resp = await call_next(request)
        if path.startswith("/static/") and resp.status_code == 200:
            # ?v=<hash เนื้อไฟล์> (ใส่ให้ใน html) = เนื้อหาไม่เปลี่ยนแน่นอน -> เก็บในเครื่องได้เลย; ไม่มี v = ถาม server ทุกครั้ง (ETag -> 304)
            resp.headers["Cache-Control"] = "private, max-age=31536000, immutable" if request.query_params.get("v") else "no-cache"
        return _secure(resp, headers_tpl)

    @app.get("/healthz")
    def healthz():
        return {"ok": True}

    @app.get("/login")
    def login_page():
        return versioned_html("login.html")

    @app.post("/api/auth/login")
    def login(body: LoginBody, request: Request):
        ip = client_ip(request)
        wait = store.locked_for(ip)
        if wait > 0:
            raise HTTPException(status_code=429, detail=f"ล็อกอินผิดหลายครั้ง รออีก {int(wait // 60) + 1} นาที")
        if not verify_password(body.password, pass_hash):
            store.record_attempt(ip, ok=False)
            raise HTTPException(status_code=401, detail="รหัสผ่านไม่ถูกต้อง")
        store.record_attempt(ip, ok=True)
        token = store.create_session(ip, request.headers.get("user-agent", ""))
        resp = JSONResponse({"ok": True})
        resp.set_cookie(COOKIE, token, max_age=SESSION_TTL_SEC, httponly=True,
                        secure=cookie_secure, samesite="strict", path="/")
        return resp

    @app.post("/api/auth/logout")
    def logout(request: Request):
        store.delete_session(request.cookies.get(COOKIE))
        resp = JSONResponse({"ok": True})
        resp.delete_cookie(COOKIE, path="/", secure=cookie_secure, httponly=True, samesite="strict")
        return resp

    @app.post("/api/auth/logout-all")
    def logout_all():
        store.delete_all_sessions()
        resp = JSONResponse({"ok": True})
        resp.delete_cookie(COOKIE, path="/", secure=cookie_secure, httponly=True, samesite="strict")
        return resp

    @app.get("/api/auth/check")
    def auth_check():
        return {"ok": True}

    # ---------- P1: บัญชี + proxy ไป worker ----------
    def worker_base(acct: str) -> str:
        if acct not in accounts:
            raise HTTPException(status_code=404, detail="ไม่พบบัญชี")
        return f"127.0.0.1:{accounts[acct]['port']}"

    @app.get("/api/accounts")
    def list_accounts():
        return [{"name": n, "kind": a["kind"]} for n, a in accounts.items()]

    # ---------- ตั้งค่าบัญชี MT5 จากหน้าเว็บ (แก้ accounts.json; เปิด/ปิด worker ด้วย pm2 เอง) ----------
    async def worker_account(a: dict) -> dict | None:
        try:
            r = await http().get(f"http://127.0.0.1:{a['port']}/account", timeout=4, headers={"X-Worker-Key": worker_key})
            return r.json() if r.status_code == 200 else None
        except httpx.HTTPError:
            return None

    def raw_accounts() -> list[dict]:
        src = save_path if save_path.exists() else accounts_path
        return json.loads(src.read_text(encoding="utf-8-sig"))["accounts"]

    @app.get("/api/admin/accounts")
    async def admin_accounts():
        rows = raw_accounts()
        live = await asyncio.gather(*(worker_account(a) for a in rows))
        return {"accounts": [{**a, "live": lv} for a, lv in zip(rows, live)]}

    probe_lock = asyncio.Lock()   # ตรวจทีละ terminal (แต่ละครั้งอาจเปิด MT5 ใหม่ 1 ตัว)

    @app.post("/api/admin/accounts/probe")
    async def admin_probe(body: dict):
        if probe_lock.locked():
            raise HTTPException(status_code=429, detail="กำลังตรวจ terminal อื่นอยู่ — รอสักครู่")
        async with probe_lock:
            return await _admin_probe(body)

    async def _admin_probe(body: dict):
        path = str(body.get("terminal_path") or "").strip()
        if not path.lower().endswith("terminal64.exe"):
            raise HTTPException(status_code=400, detail="path ต้องชี้ไปที่ terminal64.exe")
        # terminal ที่มี worker ต่ออยู่แล้ว: ถาม worker (ไม่เปิด IPC ซ้อน)
        norm = path.lower().replace("/", "\\")
        for a in raw_accounts():
            if a["terminal_path"].lower().replace("/", "\\") == norm and a.get("name") != body.get("name"):
                raise HTTPException(status_code=400, detail=f"terminal นี้ใช้กับบัญชี {a['name']} อยู่แล้ว")
            if a["terminal_path"].lower().replace("/", "\\") == norm:
                lv = await worker_account(a)
                if lv:
                    return {"ok": True, "source": "worker", **lv, "kind": detect_kind(lv.get("currency"), lv.get("server")),
                            "mode": {0: "demo", 1: "contest", 2: "real"}.get(lv.get("trade_mode"), "")}
        if not os.path.isfile(path):
            raise HTTPException(status_code=400, detail="ไม่พบไฟล์นี้บนเครื่อง VPS")
        portable = bool(body.get("portable"))
        proc = await asyncio.create_subprocess_exec(
            sys.executable, str(BASE / "mt5probe.py"), path, "1" if portable else "0",
            cwd=str(BASE), stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            env={**os.environ, "PYTHONUTF8": "1"})
        try:
            out, _err = await asyncio.wait_for(proc.communicate(), timeout=60)
        except asyncio.TimeoutError:
            proc.kill()
            return {"ok": False, "error": "terminal ไม่ตอบใน 60 วินาที — ลองสลับตัวเลือก portable"}
        try:
            return json.loads(out.decode("utf-8", "replace").strip().splitlines()[-1])
        except (ValueError, IndexError):
            return {"ok": False, "error": "ตรวจไม่สำเร็จ (ไม่มีผลลัพธ์)"}

    @app.post("/api/admin/accounts")
    def admin_save(body: dict, request: Request):
        ip = client_ip(request)
        wait = store.locked_for(ip)
        if wait > 0:
            raise HTTPException(status_code=429, detail=f"ใส่รหัสผิดหลายครั้ง รออีก {int(wait // 60) + 1} นาที")
        if not verify_password(str(body.get("password") or ""), pass_hash):
            store.record_attempt(ip, ok=False)
            raise HTTPException(status_code=403, detail="รหัสผ่านเว็บไม่ถูกต้อง")
        store.record_attempt(ip, ok=True)
        current = raw_accounts()
        try:
            entries = build_accounts(list(body.get("accounts") or []), current)
        except (ValueError, KeyError, TypeError) as e:
            raise HTTPException(status_code=400, detail=str(e))
        if not entries:
            raise HTTPException(status_code=400, detail="ต้องมีอย่างน้อย 1 บัญชี")
        save_accounts(entries, save_path)
        fresh = load_accounts(save_path)
        accounts.clear()
        accounts.update(fresh)
        old = {a["name"]: a for a in current}
        added = [a["name"] for a in entries if a["name"] not in old]
        removed = [n for n in old if n not in fresh]
        def same(a: dict, b: dict) -> bool:   # เทียบหลังจัดรูปแบบเดียวกัน (ไม่ให้ค่าว่าง/ลำดับ key ทำให้ดูเหมือนเปลี่ยน)
            try:
                return clean_entry(a, a) == clean_entry(b, b)
            except (ValueError, KeyError, TypeError):
                return a == b
        changed = [a["name"] for a in entries if a["name"] in old and not same(a, old[a["name"]])]
        cmds = [f"pm2 start ecosystem.config.js --only wt-worker-{n}" for n in added]
        cmds += [f"pm2 delete wt-worker-{n}" for n in removed]
        cmds += [f"pm2 restart wt-worker-{n} --update-env" for n in changed]
        if added or removed:
            cmds.append("pm2 save")
        return {"ok": True, "added": added, "removed": removed, "changed": changed, "commands": cmds}

    @app.get("/api/a/{acct}/{path}")
    async def worker_get(acct: str, path: str, request: Request):
        if path not in WORKER_GET_PATHS:
            raise HTTPException(status_code=404, detail="not found")
        url = f"http://{worker_base(acct)}/{path}"
        try:
            r = await http().get(url, timeout=15, params=dict(request.query_params), headers={"X-Worker-Key": worker_key})
        except httpx.HTTPError:
            raise HTTPException(status_code=503, detail=f"worker ของบัญชี {acct} ไม่ตอบ")
        return Response(r.content, status_code=r.status_code, media_type="application/json")   # ส่งต่อตรง ไม่ parse/serialize ซ้ำ

    @app.post("/api/a/{acct}/{path:path}")
    async def worker_post(acct: str, path: str, request: Request):
        if path not in WORKER_POST_PATHS:
            raise HTTPException(status_code=404, detail="not found")
        body = await request.body()
        if len(body) > 16 * 1024:
            raise HTTPException(status_code=413, detail="ข้อมูลใหญ่เกิน")
        url = f"http://{worker_base(acct)}/{path}"
        try:
            r = await http().post(url, timeout=30, content=body, headers={
                "X-Worker-Key": worker_key, "Content-Type": "application/json",
                "X-Client-IP": client_ip(request)})
        except httpx.HTTPError:
            # ไม่รู้ว่าคำสั่งไปถึง MT5 หรือยัง -> ห้ามบอกว่าล้มเหลว ให้ไปดูตาราง
            raise HTTPException(status_code=504, detail="worker ไม่ตอบ — ไม่แน่ใจว่าคำสั่งถึง MT5 หรือไม่ ดูตาราง positions/pending ก่อนส่งซ้ำ")
        return JSONResponse(r.json(), status_code=r.status_code)

    @app.websocket("/ws/{acct}")
    async def ws_proxy(ws: WebSocket, acct: str):
        # HTTP middleware ไม่ครอบ websocket -> เช็ค session + Origin เองที่นี่ (กัน cross-site WS hijack)
        if not store.valid_session(ws.cookies.get(COOKIE)):
            await ws.close(code=4401)
            return
        if (ws.headers.get("origin") or "").rstrip("/") != origin:
            await ws.close(code=4403)
            return
        if acct not in accounts:
            await ws.close(code=4404)
            return
        await ws.accept()
        url = f"ws://127.0.0.1:{accounts[acct]['port']}/stream"
        try:
            async with websockets.connect(url, additional_headers={"X-Worker-Key": worker_key},
                                          open_timeout=20, max_size=2 ** 22) as up:
                async def down():
                    async for msg in up:
                        await ws.send_text(msg)

                async def upward():
                    while True:
                        text = await ws.receive_text()
                        try:
                            msg = json.loads(text)
                        except json.JSONDecodeError:
                            continue
                        if isinstance(msg, dict) and msg.get("op") in WS_CLIENT_OPS:
                            await up.send(json.dumps(msg))

                tasks = [asyncio.create_task(down()), asyncio.create_task(upward())]
                done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
                for t in pending:
                    t.cancel()
                for t in done:   # อีกฝั่งปิดไปแล้ว = ปกติ — อ่าน exception ทิ้ง ไม่ให้ขึ้น "Task exception was never retrieved"
                    if not t.cancelled():
                        t.exception()
        except (OSError, websockets.WebSocketException, asyncio.TimeoutError) as e:
            status = getattr(getattr(e, "response", None), "status_code", None)
            if status == 403:
                why = "WT_WORKER_KEY ของ gateway กับ worker ไม่ตรงกัน"
            elif isinstance(e, (OSError, asyncio.TimeoutError)):
                why = f"ต่อ worker ที่ 127.0.0.1:{accounts[acct]['port']} ไม่ได้ (pm2 wt-worker-{acct} ไม่ได้รัน?)"
            else:
                why = f"{type(e).__name__}: {e}"
            try:
                await ws.send_text(json.dumps({"type": "status", "mt5": False, "worker": False,
                                               "error": f"worker ของบัญชี {acct}: {why}"}))
            except (RuntimeError, WebSocketDisconnect):
                pass
        except WebSocketDisconnect:
            pass
        try:
            await ws.close(code=1011)
        except (RuntimeError, WebSocketDisconnect):   # มือถือตัดไปก่อน = ปกติ ไม่ต้องขึ้น traceback
            pass

    # ---------- P2: drawings ----------
    def check_symbol(symbol: str):
        if not SYMBOL_RE.match(symbol):
            raise HTTPException(status_code=400, detail="symbol ไม่ถูกต้อง")

    @app.get("/api/drawings/{symbol}")
    def get_drawings(symbol: str):
        check_symbol(symbol)
        return {"symbol": symbol, "overlays": drawings.get(symbol)}

    @app.put("/api/drawings/{symbol}")
    async def put_drawings(symbol: str, request: Request):
        check_symbol(symbol)
        body = await request.body()
        if len(body) > 300 * 1024:
            raise HTTPException(status_code=413, detail="ข้อมูลใหญ่เกิน")
        try:
            overlays = clean_overlays(json.loads(body).get("overlays"))
        except (ValueError, AttributeError) as e:
            raise HTTPException(status_code=400, detail=str(e))
        drawings.put(symbol, overlays)
        return {"ok": True, "count": len(overlays)}

    # ---------- ผลรอบ Bar Replay ----------
    @app.get("/api/replay")
    def replay_list():
        return replays.list()

    @app.put("/api/replay/{sid}")
    async def replay_put(sid: int, request: Request):
        body = await request.body()
        if len(body) > 520 * 1024:
            raise HTTPException(status_code=413, detail="ข้อมูลใหญ่เกิน")
        try:
            payload = json.loads(body)
            if not isinstance(payload, dict) or "value" not in payload:
                raise ValueError("body ต้องเป็น {\"value\": ...}")
            replays.put(sid, payload["value"])
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))
        return {"ok": True}

    @app.delete("/api/replay/{sid}")
    def replay_delete(sid: int):
        replays.delete(sid)
        return {"ok": True}

    # ---------- การตั้งค่าที่ sync ข้ามเครื่อง ----------
    @app.get("/api/prefs")
    def get_prefs():
        return prefs.all()

    @app.put("/api/prefs/{key}")
    async def put_pref(key: str, request: Request):
        if key in RESERVED_PREFS:
            raise HTTPException(status_code=400, detail="key นี้แก้ผ่าน endpoint เฉพาะ")
        body = await request.body()
        if len(body) > 70 * 1024:
            raise HTTPException(status_code=413, detail="ข้อมูลใหญ่เกิน")
        try:
            payload = json.loads(body)
            if not isinstance(payload, dict) or "value" not in payload:
                raise ValueError("body ต้องเป็น {\"value\": ...}")
            prefs.put(key, payload["value"])
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))
        return {"ok": True}

    # ---------- alert อินดิเคเตอร์ -> Telegram (ตัวส่ง = alerts/alert_service.js) ----------
    @app.get("/internal/alerts/config")
    def internal_alert_config(telegram: int | None = None):
        alert_rt["last_seen"] = time.time()
        if telegram is not None:
            alert_rt["telegram"] = bool(telegram)
        all_prefs = prefs.all()
        return {"rules": all_prefs.get("wt.alerts", []), "ind": all_prefs.get("wt.ind", {}),
                "palerts": [a for a in all_prefs.get(PALERTS_KEY, []) if a.get("on")],
                "notify": {"close": True, "autobe": True, "orders": True, "system": True, **(all_prefs.get("wt.notify") or {})},
                "accounts": {n: a["port"] for n, a in accounts.items()}, "test_at": alert_rt["test_at"],
                "settings": all_prefs.get("wt.settings") or {},
                "watch": {n: all_prefs.get(f"wt.watch.{n}") or [] for n in accounts}}

    @app.get("/internal/news")
    def internal_news():
        """ปฏิทินข่าวให้ตัวส่งแจ้งเตือน (ข่าวล่วงหน้า) — cache เดียวกับหน้าเว็บ"""
        try:
            return news.get_news()
        except RuntimeError as e:
            raise HTTPException(status_code=503, detail=str(e))

    @app.post("/internal/alerts/palert_fired")
    async def internal_palert_fired(request: Request):
        body = json.loads(await request.body() or b"{}")
        with palerts_lock:
            items = prefs.all().get(PALERTS_KEY, [])
            for a in items:
                if a.get("id") == body.get("id"):
                    a["on"] = False
                    a["fired_at"] = time.time()
                    a["fired_price"] = body.get("price")
            prefs.put(PALERTS_KEY, items)
        return {"ok": True}

    @app.post("/internal/alerts/fired")
    async def internal_alert_fired(request: Request):
        body = json.loads(await request.body() or b"{}")
        if body.get("rule_id") == "test":
            alert_rt["test_at"] = None
        alert_log.add(body.get("rule_id", "?"), body.get("text", ""), bool(body.get("ok")), body.get("error"))
        return {"ok": True}

    # ---------- Web Push ----------
    @app.get("/sw.js")
    def service_worker():
        return FileResponse(STATIC / "sw.js", media_type="text/javascript", headers={"Cache-Control": "no-cache"})

    @app.get("/api/push/key")
    def push_key():
        if not push.available():
            raise HTTPException(status_code=503, detail="ยังไม่ได้ติดตั้ง pywebpush บน server — รัน: pip install pywebpush แล้ว restart web-terminal")
        return {"publicKey": pushes.vapid()["public"], "devices": pushes.count()}

    @app.post("/api/push/subscribe")
    async def push_subscribe(request: Request):
        body = json.loads(await request.body() or b"{}")
        try:
            pushes.add(body.get("subscription") or {}, request.headers.get("user-agent", ""))
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))
        return {"ok": True, "devices": pushes.count()}

    @app.post("/api/push/unsubscribe")
    async def push_unsubscribe(request: Request):
        body = json.loads(await request.body() or b"{}")
        pushes.remove(str(body.get("endpoint") or ""))
        return {"ok": True, "devices": pushes.count()}

    @app.post("/api/push/test")
    def push_test():
        return pushes.send_all("Mee Terminal", "✅ ทดสอบแจ้งเตือนบนเครื่อง (Web Push)", "test")

    @app.post("/internal/push/send")
    async def internal_push_send(request: Request):
        body = json.loads(await request.body() or b"{}")
        text = str(body.get("text") or "")
        title, _, rest = text.partition("\n")
        return await asyncio.to_thread(pushes.send_all, title or "Mee Terminal", rest, str(body.get("tag") or ""))

    @app.get("/api/alerts/status")
    def alerts_status():
        age = time.time() - alert_rt["last_seen"] if alert_rt["last_seen"] else None
        return {"service_alive": age is not None and age < 60, "last_seen_sec": age, "log": alert_log.recent(30)}

    @app.post("/api/alerts/test")
    def alerts_test():
        alert_rt["test_at"] = time.time()
        return {"ok": True}

    # ---------- alert เส้นราคา (ลากบนกราฟ) ----------
    def palert_clean(body: dict, old: dict | None = None) -> dict:
        out = dict(old or {})
        if "acct" in body or old is None:
            acct = str(body.get("acct", ""))
            if acct not in accounts:
                raise HTTPException(status_code=400, detail="ไม่พบบัญชี")
            out["acct"] = acct
        if "symbol" in body or old is None:
            sym = str(body.get("symbol", ""))
            if not SYMBOL_RE.match(sym):
                raise HTTPException(status_code=400, detail="symbol ไม่ถูกต้อง")
            out["symbol"] = sym
        def num(v, what):
            try:
                x = float(v)
            except (TypeError, ValueError):
                x = float("nan")
            if not math.isfinite(x) or x <= 0:
                raise HTTPException(status_code=400, detail=f"{what} ไม่ถูกต้อง")
            return x

        kind = body.get("kind", out.get("kind", "level"))
        if kind not in ("level", "line", "box"):
            raise HTTPException(status_code=400, detail="kind ต้องเป็น level/line/box")
        out["kind"] = kind
        if kind == "level" and ("level" in body or old is None):
            out["level"] = num(body.get("level"), "ราคา")
        if kind == "line" and ("p1" in body or old is None):
            # เส้นเทรนด์: 2 จุด (เวลา UTC วินาที, ราคา) + ต่อเส้น none/right/both
            p1, p2 = body.get("p1") or {}, body.get("p2") or {}
            out["p1"] = {"t": num(p1.get("t"), "เวลาจุด 1"), "v": num(p1.get("v"), "ราคาจุด 1")}
            out["p2"] = {"t": num(p2.get("t"), "เวลาจุด 2"), "v": num(p2.get("v"), "ราคาจุด 2")}
            if out["p1"]["t"] == out["p2"]["t"]:
                raise HTTPException(status_code=400, detail="เส้นแนวตั้งตั้ง alert ไม่ได้")
            ext = body.get("ext", "none")
            if ext not in ("none", "right", "both"):
                raise HTTPException(status_code=400, detail="ext ต้องเป็น none/right/both")
            out["ext"] = ext
        if kind == "box" and ("top" in body or old is None):
            top, bottom = num(body.get("top"), "ขอบบน"), num(body.get("bottom"), "ขอบล่าง")
            if top <= bottom:
                raise HTTPException(status_code=400, detail="ขอบบนต้องสูงกว่าขอบล่าง")
            out["top"], out["bottom"] = top, bottom
        if "dir" in body or old is None:
            allowed = ("enter",) if kind == "box" else ("up", "down")
            if body.get("dir") not in allowed:
                raise HTTPException(status_code=400, detail=f"dir ต้องเป็น {'/'.join(allowed)}")
            out["dir"] = body["dir"]
        if "note" in body:
            out["note"] = str(body.get("note") or "")[:100]
        if "src" in body:   # "drawing" = ผูกกับเส้นที่วาด (หน้าเว็บลบ/ย้ายตามเส้น)
            out["src"] = "drawing" if body.get("src") == "drawing" else ""
        if "on" in body:
            out["on"] = bool(body["on"])
            if out["on"]:
                out.pop("fired_at", None)
                out.pop("fired_price", None)
        return out

    @app.get("/api/palerts")
    def palerts_list():
        return prefs.all().get(PALERTS_KEY, [])

    @app.post("/api/palerts")
    async def palerts_add(request: Request):
        body = json.loads(await request.body() or b"{}")
        item = palert_clean(body)
        item.update(id=uuid.uuid4().hex[:12], on=True, created=time.time(), note=item.get("note", ""))
        with palerts_lock:
            items = prefs.all().get(PALERTS_KEY, [])
            items = [a for a in items if a.get("on") or time.time() - (a.get("fired_at") or 0) < 7 * 86400]
            if len(items) >= PALERTS_MAX:
                raise HTTPException(status_code=400, detail=f"ตั้งได้ไม่เกิน {PALERTS_MAX} alert")
            items.append(item)
            prefs.put(PALERTS_KEY, items)
        return item

    @app.put("/api/palerts/{aid}")
    async def palerts_update(aid: str, request: Request):
        body = json.loads(await request.body() or b"{}")
        with palerts_lock:
            items = prefs.all().get(PALERTS_KEY, [])
            for i, a in enumerate(items):
                if a.get("id") == aid:
                    items[i] = palert_clean(body, a)
                    prefs.put(PALERTS_KEY, items)
                    return items[i]
        raise HTTPException(status_code=404, detail="ไม่พบ alert")

    @app.delete("/api/palerts/{aid}")
    def palerts_delete(aid: str):
        with palerts_lock:
            items = prefs.all().get(PALERTS_KEY, [])
            prefs.put(PALERTS_KEY, [a for a in items if a.get("id") != aid])
        return {"ok": True}

    # ---------- สถานะระบบ ----------
    # ---------- order flow (Binance) ----------
    flow_port = int(os.environ.get("WT_FLOW_PORT", "8110"))

    @app.get("/api/flow/{path}")
    async def flow_get(path: str, request: Request):
        if path not in FLOW_PATHS:
            raise HTTPException(status_code=404, detail="not found")
        try:
            r = await http().get(f"http://127.0.0.1:{flow_port}/{path}", timeout=10, params=dict(request.query_params),
                              headers={"X-Worker-Key": worker_key})
        except httpx.HTTPError:
            raise HTTPException(status_code=503, detail="ตัวเก็บ order flow ไม่ตอบ (pm2 wt-flow ไม่ได้รัน?)")
        return JSONResponse(r.json(), status_code=r.status_code)

    @app.get("/api/health")
    async def health():
        async def one(name: str, a: dict) -> dict:
            row = {"name": name, "kind": a["kind"], "port": a["port"], "trading": bool(a.get("trading")),
                   "allow_real": bool(a.get("allow_real")), "server_utc_offset_h": a.get("server_utc_offset_h", 0)}
            t0 = time.perf_counter()
            try:
                r = await http().get(f"http://127.0.0.1:{a['port']}/status", timeout=5, headers={"X-Worker-Key": worker_key})
                row["latency_ms"] = round((time.perf_counter() - t0) * 1000)
                row["worker"] = r.status_code == 200
                if r.status_code == 200:
                    row.update({k: v for k, v in r.json().items() if k not in ("type", "account")})
            except httpx.HTTPError as e:
                row["worker"] = False
                row["error"] = f"worker ไม่ตอบ ({type(e).__name__})"
            return row
        rows = await asyncio.gather(*(one(n, a) for n, a in accounts.items()))
        try:
            fr = await http().get(f"http://127.0.0.1:{flow_port}/status", timeout=3, headers={"X-Worker-Key": worker_key})
            flow = fr.json() if fr.status_code == 200 else {"error": f"HTTP {fr.status_code}"}
        except httpx.HTTPError:
            flow = {"error": "ไม่ได้รัน"}
        age = time.time() - alert_rt["last_seen"] if alert_rt["last_seen"] else None
        return {"accounts": rows, "gateway_uptime_sec": round(time.time() - started), "server_time": time.time(),
                "alerts": {"alive": age is not None and age < 60, "last_seen_sec": age, "telegram": alert_rt["telegram"]},
                "flow": {k: flow.get(k) for k in ("connected", "error", "symbols", "last_msg_sec", "trades")},
                "news": news.cache_info(), "backup": backup.last_backup(backup_dir)}

    # ---------- ปฏิทินข่าว (TradingView economic calendar, cache 30 นาที) ----------
    @app.get("/api/news")
    def get_news(force: int = 0):
        try:
            return news.get_news(force=bool(force))
        except RuntimeError as e:
            raise HTTPException(status_code=502, detail=str(e))

    # ---------- P5: journal ประจำไม้ ----------
    def check_acct(acct: str):
        if not ACCT_RE.match(acct) or acct not in accounts:
            raise HTTPException(status_code=404, detail="ไม่พบบัญชี")

    @app.get("/api/journal/{acct}")
    def journal_list(acct: str):
        check_acct(acct)
        return journal.list(acct)

    @app.put("/api/journal/{acct}/{pid}")
    async def journal_put(acct: str, pid: int, request: Request):
        check_acct(acct)
        try:
            body = json.loads(await request.body())
            journal.put(acct, pid, body.get("note", ""), body.get("tags", []))
        except (ValueError, AttributeError) as e:
            raise HTTPException(status_code=400, detail=str(e))
        return {"ok": True}

    @app.put("/api/journal/{acct}/{pid}/image")
    async def journal_image_put(acct: str, pid: int, request: Request):
        check_acct(acct)
        raw = await request.body()
        if len(raw) > 1024 * 1024:
            raise HTTPException(status_code=413, detail="ภาพใหญ่เกิน")
        try:
            data_url = json.loads(raw).get("data")
            if data_url is None:
                journal.put_image(acct, pid, None, None)
                return {"ok": True}
            head, _, b64 = data_url.partition(",")
            mime = head.removeprefix("data:").removesuffix(";base64")
            if mime not in ("image/jpeg", "image/png") or not head.endswith(";base64"):
                raise ValueError("ต้องเป็นภาพ jpeg/png แบบ data URL")
            import base64, binascii
            try:
                img = base64.b64decode(b64, validate=True)
            except binascii.Error:
                raise ValueError("base64 ไม่ถูกต้อง")
            journal.put_image(acct, pid, img, mime)
        except (ValueError, AttributeError) as e:
            raise HTTPException(status_code=400, detail=str(e))
        return {"ok": True}

    @app.get("/api/journal/{acct}/{pid}/image")
    def journal_image(acct: str, pid: int):
        check_acct(acct)
        got = journal.image(acct, pid)
        if not got:
            raise HTTPException(status_code=404, detail="ไม่มีภาพ")
        return Response(content=got[0], media_type=got[1])

    @app.get("/")
    def index():
        return versioned_html("index.html")

    app.mount("/static", StaticFiles(directory=STATIC), name="static")
    return app


_VER_CACHE: dict = {}
_STATIC_REF = re.compile(r'(["\'])/static/([^"\'?#]+)\1')


def static_ver(rel: str) -> str | None:
    """hash เนื้อไฟล์ static (แคชตาม mtime) — git pull แล้วรีเฟรชได้ไฟล์ใหม่เลยโดยไม่ต้อง restart"""
    f = (STATIC / rel).resolve()
    if STATIC.resolve() not in f.parents or not f.is_file():
        return None
    mt = f.stat().st_mtime_ns
    got = _VER_CACHE.get(rel)
    if got and got[0] == mt:
        return got[1]
    h = hashlib.sha1(f.read_bytes()).hexdigest()[:10]
    _VER_CACHE[rel] = (mt, h)
    return h


def versioned_html(name: str) -> Response:
    """html ต้องไม่แคช (no-store จาก guard) แต่ไฟล์ที่อ้างถึงแนบ ?v=hash -> แคชยาวได้ เปลี่ยนเมื่อเนื้อไฟล์เปลี่ยน"""
    html = (STATIC / name).read_text(encoding="utf-8")

    def sub(m):
        v = static_ver(m.group(2))
        return f"{m.group(1)}/static/{m.group(2)}?v={v}{m.group(1)}" if v else m.group(0)
    return Response(_STATIC_REF.sub(sub, html), media_type="text/html; charset=utf-8")


def _secure(resp: Response, headers: dict) -> Response:
    for k, v in headers.items():
        resp.headers.setdefault(k, v)
    return resp


if os.environ.get("WT_NO_AUTOAPP") != "1":
    app = create_app()
