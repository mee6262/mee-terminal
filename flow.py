"""Order flow จาก Binance USDⓈ-M futures (ฟรี, เรียลไทม์) — pm2: wt-flow (127.0.0.1:8110)

เก็บต่อ symbol ต่อนาที (UTC): volume ฝั่งซื้อ/ขายที่กดเข้า (aggressor), จำนวน trade, volume ตามระดับราคา (bin),
open interest (REST ทุก 60 วิ), funding rate (markPrice@1s) + รายการล้างพอร์ต (forceOrder) — SQLite เก็บ 30 วัน
หน้าเว็บดึงผ่าน gateway /api/flow/* : delta / CVD / volume profile / จุดล้างพอร์ต / OI

- aggTrade m=true = ผู้ซื้อเป็น maker -> ฝั่งขายกดเข้า (sell), m=false = ฝั่งซื้อกดเข้า (buy)
- forceOrder S=SELL = บังคับขาย = long โดนล้าง, S=BUY = short โดนล้าง (Binance ส่งแค่รายการใหญ่สุดต่อวินาที)
- ช่วงที่ service ไม่ได้รัน = ไม่มีข้อมูล (ไม่ backfill)
env: WT_WORKER_KEY, WT_FLOW_SYMBOLS (default BTCUSDT:5,ETHUSDT:0.5 = symbol:ขนาด bin ราคา), WT_FLOW_DB
"""
import asyncio
import calendar
import json
import logging
import os
import sqlite3
import ssl
import threading
import time
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path

import certifi
import httpx
import websockets
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse

log = logging.getLogger("wt.flow")
BASE = Path(__file__).resolve().parent
# Binance แยก endpoint futures แล้ว: market stream อยู่ที่ /market (ของเดิม /stream ต่อได้แต่ไม่มีข้อมูล) — ลองตามลำดับ
WS_URLS = ("wss://fstream.binance.com/market/stream?streams=", "wss://fstream.binance.com/stream?streams=")
SILENT_SEC = 60                  # ต่อได้แต่ไม่มีข้อมูลเกินนี้ = ต่อใหม่ (สลับ endpoint)
OI_URL = "https://fapi.binance.com/fapi/v1/openInterest"
KEEP_DAYS = 30
MAX_BUCKETS = 3000
TF_SEC = {"M1": 60, "M5": 300, "M15": 900, "M30": 1800, "H1": 3600, "H4": 14400, "D1": 86400, "W1": 604800}
WEEK_ANCHOR = 3 * 86400          # 1970-01-01 = วันพฤหัส -> แท่ง W1 ของ MT5 เริ่มวันอาทิตย์


def parse_symbols(raw: str) -> dict:
    out = {}
    for part in (raw or "").split(","):
        if not part.strip():
            continue
        sym, _, b = part.strip().partition(":")
        out[sym.upper()] = float(b or 1)
    return out


def bucket_of(t: int, tf: str) -> int:
    """เวลาเริ่มแท่ง (UTC วินาที) ของ TF — ตรงกับแท่ง MT5 ที่เวลา server = UTC"""
    if tf == "MN1":
        d = datetime.fromtimestamp(t, tz=timezone.utc)
        return calendar.timegm((d.year, d.month, 1, 0, 0, 0))
    s = TF_SEC[tf]
    if tf == "W1":
        return (t - WEEK_ANCHOR) // s * s + WEEK_ANCHOR
    return t // s * s


class Minute:
    __slots__ = ("t", "buy", "sell", "n", "vp")

    def __init__(self, t: int):
        self.t, self.buy, self.sell, self.n, self.vp = t, 0.0, 0.0, 0, {}

    def add(self, price: float, qty: float, sell: bool, bin_size: float) -> None:
        k = int(price // bin_size)
        v = self.vp.get(k)
        if v is None:
            v = self.vp[k] = [0.0, 0.0]
        if sell:
            self.sell += qty
            v[1] += qty
        else:
            self.buy += qty
            v[0] += qty
        self.n += 1

    def row(self) -> dict:
        return {"t": self.t, "buy": self.buy, "sell": self.sell, "n": self.n,
                "vp": {str(k): [round(a, 6), round(b, 6)] for k, (a, b) in self.vp.items()}}


class FlowStore:
    def __init__(self, db_path: str, symbols: dict):
        self.symbols = symbols
        self._conn = sqlite3.connect(db_path, check_same_thread=False)
        self._lock = threading.Lock()
        with self._lock:
            self._conn.execute("CREATE TABLE IF NOT EXISTS m1 (sym TEXT NOT NULL, t INTEGER NOT NULL, buy REAL, sell REAL, n INTEGER,"
                               " vp TEXT, oi REAL, fr REAL, PRIMARY KEY (sym, t))")
            self._conn.execute("CREATE TABLE IF NOT EXISTS liq (sym TEXT NOT NULL, t REAL NOT NULL, side TEXT, price REAL, qty REAL)")
            self._conn.execute("CREATE INDEX IF NOT EXISTS liq_st ON liq (sym, t)")
            self._conn.commit()
        self.cur: dict[str, Minute] = {}
        self.oi: dict[str, float] = {}
        self.fr: dict[str, float] = {}
        self.mark: dict[str, float] = {}
        self.last_msg = 0.0
        self.connected = False
        self.error = ""
        self.count = 0

    # ----- รับข้อมูล -----
    def on_trade(self, sym: str, t_ms: int, price: float, qty: float, sell: bool) -> None:
        t = t_ms // 60000 * 60
        m = self.cur.get(sym)
        if m is None or t > m.t:
            if m is not None:
                self.flush(sym, m)
            m = self.cur[sym] = Minute(t)
        elif t < m.t:          # trade มาช้าข้ามนาที (หายาก) -> นับในนาทีปัจจุบัน
            pass
        m.add(price, qty, sell, self.symbols[sym])
        self.count += 1

    def on_liq(self, sym: str, t_ms: int, side: str, price: float, qty: float) -> None:
        with self._lock:
            self._conn.execute("INSERT INTO liq(sym, t, side, price, qty) VALUES (?,?,?,?,?)", (sym, t_ms / 1000, side, price, qty))
            self._conn.commit()

    def flush(self, sym: str, m: Minute) -> None:
        r = m.row()
        with self._lock:
            self._conn.execute("INSERT OR REPLACE INTO m1(sym, t, buy, sell, n, vp, oi, fr) VALUES (?,?,?,?,?,?,?,?)",
                               (sym, r["t"], r["buy"], r["sell"], r["n"], json.dumps(r["vp"], separators=(",", ":")),
                                self.oi.get(sym), self.fr.get(sym)))
            self._conn.commit()

    def roll(self, now: float | None = None) -> None:
        """นาทีที่จบแล้วแต่ไม่มี trade ใหม่มาดัน -> บันทึก"""
        t = int((now or time.time()) // 60 * 60)
        for sym, m in list(self.cur.items()):
            if m.t < t:
                if m.n:
                    self.flush(sym, m)
                self.cur[sym] = Minute(t)

    def prune(self, now: float | None = None) -> None:
        cut = (now or time.time()) - KEEP_DAYS * 86400
        with self._lock:
            self._conn.execute("DELETE FROM m1 WHERE t < ?", (cut,))
            self._conn.execute("DELETE FROM liq WHERE t < ?", (cut,))
            self._conn.commit()

    # ----- อ่าน -----
    def _rows(self, sym: str, frm: int, to: int, cols: str) -> list:
        with self._lock:
            rows = self._conn.execute(f"SELECT {cols} FROM m1 WHERE sym=? AND t>=? AND t<? ORDER BY t", (sym, frm, to)).fetchall()
        m = self.cur.get(sym)
        if m is not None and m.n and frm <= m.t < to:     # นาทีที่ยังไม่จบ (ที่มี trade แล้ว)
            r = m.row()
            live = {"t": r["t"], "buy": r["buy"], "sell": r["sell"], "n": r["n"], "vp": json.dumps(r["vp"]),
                    "oi": self.oi.get(sym), "fr": self.fr.get(sym)}
            rows.append(tuple(live[c.strip()] for c in cols.split(",")))
        return rows

    def bars(self, sym: str, tf: str, frm: int, to: int) -> list:
        out: dict[int, dict] = {}
        for t, buy, sell, n, oi, fr in self._rows(sym, frm, to, "t, buy, sell, n, oi, fr"):
            b = bucket_of(t, tf)
            o = out.get(b)
            if o is None:
                if len(out) >= MAX_BUCKETS:
                    break
                o = out[b] = {"t": b, "buy": 0.0, "sell": 0.0, "n": 0, "oi": None, "fr": None}
            o["buy"] += buy or 0
            o["sell"] += sell or 0
            o["n"] += n or 0
            if oi is not None:
                o["oi"] = oi
            if fr is not None:
                o["fr"] = fr
        for o in out.values():
            o["buy"], o["sell"] = round(o["buy"], 4), round(o["sell"], 4)
        return list(out.values())

    def profile(self, sym: str, frm: int, to: int, max_rows: int = 80) -> dict:
        size = self.symbols[sym]
        acc: dict[int, list] = {}
        for (vp,) in self._rows(sym, frm, to, "vp"):
            for k, (b, s) in json.loads(vp or "{}").items():
                a = acc.setdefault(int(k), [0.0, 0.0])
                a[0] += b
                a[1] += s
        if not acc:
            return {"bin": size, "rows": []}
        lo, hi = min(acc), max(acc)
        step = max(1, -(-(hi - lo + 1) // max_rows))      # รวม bin ติดกันให้เหลือไม่เกิน max_rows แถว
        rows: dict[int, list] = {}
        for k, (b, s) in acc.items():
            g = rows.setdefault((k - lo) // step, [0.0, 0.0])
            g[0] += b
            g[1] += s
        return {"bin": size * step, "rows": [[round((lo + g * step) * size, 8), round(b, 4), round(s, 4)] for g, (b, s) in sorted(rows.items())]}

    def liqs(self, sym: str, frm: float, to: float) -> list:
        with self._lock:
            rows = self._conn.execute("SELECT t, side, price, qty FROM liq WHERE sym=? AND t>=? AND t<? ORDER BY t LIMIT 5000",
                                      (sym, frm, to)).fetchall()
        return [{"t": t, "side": side, "price": p, "qty": q} for t, side, p, q in rows]

    def status(self) -> dict:
        return {"connected": self.connected, "error": self.error, "symbols": list(self.symbols),
                "last_msg_sec": round(time.time() - self.last_msg, 1) if self.last_msg else None, "trades": self.count,
                "oi": self.oi, "funding": self.fr, "mark": self.mark}


def handle(store: FlowStore, msg: dict) -> None:
    d = msg.get("data", msg)
    e = d.get("e")
    if e == "aggTrade":
        s = d["s"]
        if s in store.symbols:
            store.on_trade(s, int(d["T"]), float(d["p"]), float(d["q"]), bool(d["m"]))
    elif e == "forceOrder":
        o = d["o"]
        if o["s"] in store.symbols:
            store.on_liq(o["s"], int(o["T"]), o["S"], float(o.get("ap") or o["p"]), float(o.get("z") or o["q"]))
    elif e == "markPriceUpdate":
        if d["s"] in store.symbols:
            store.fr[d["s"]] = float(d["r"]) if d.get("r") not in (None, "") else None
            store.mark[d["s"]] = float(d["p"])


async def run_stream(store: FlowStore) -> None:
    streams = "/".join(f"{s.lower()}@{k}" for s in store.symbols for k in ("aggTrade", "forceOrder", "markPrice@1s"))
    delay, turn = 1, 0
    while True:
        url = WS_URLS[turn % len(WS_URLS)]
        got = False
        try:
            # CA ของ certifi (เดียวกับ httpx) — Python บางชุดไม่มี CA ของระบบ
            ctx = ssl.create_default_context(cafile=certifi.where())
            async with websockets.connect(url + streams, open_timeout=20, ping_interval=20, max_size=2 ** 20, ssl=ctx) as ws:
                store.connected, store.error = True, ""
                log.info("ต่อ Binance ได้แล้ว %s (%s)", list(store.symbols), url.split("?")[0])
                while True:
                    try:
                        raw = await asyncio.wait_for(ws.recv(), SILENT_SEC)
                    except asyncio.TimeoutError:
                        raise ConnectionError(f"ไม่มีข้อมูล {SILENT_SEC} วินาที")
                    store.last_msg = time.time()
                    got, delay = True, 1
                    try:
                        handle(store, json.loads(raw))
                    except (KeyError, ValueError, TypeError) as ex:
                        log.debug("ข้าม message: %r", ex)
        except asyncio.CancelledError:
            raise
        except Exception as ex:  # noqa: BLE001 — เครือข่ายหลุดได้หลายแบบ: ต่อใหม่เสมอ
            store.error = f"{type(ex).__name__}: {ex}"[:300]
            log.warning("Binance หลุด: %s — ต่อใหม่ใน %s วินาที", store.error, delay)
        store.connected = False
        if not got:                     # endpoint นี้ไม่มีข้อมูล -> ลองอีกตัว (หลุดปกติหลังได้ข้อมูล = ต่อที่เดิม)
            turn += 1
        await asyncio.sleep(delay)
        delay = min(60, delay * 2)     # Binance ตัดทุก 24 ชม. เป็นปกติ / โดนบล็อก = ถอยห่าง


async def run_timers(store: FlowStore) -> None:
    last_prune = 0.0
    async with httpx.AsyncClient(timeout=10) as cli:
        while True:
            for s in store.symbols:
                try:
                    r = await cli.get(OI_URL, params={"symbol": s})
                    if r.status_code == 200:
                        store.oi[s] = float(r.json()["openInterest"])
                except (httpx.HTTPError, KeyError, ValueError):
                    pass
            for _ in range(12):            # OI ทุก 60 วิ, ปิดนาทีทุก 5 วิ
                store.roll()
                if time.time() - last_prune > 3600:
                    last_prune = time.time()
                    store.prune()
                await asyncio.sleep(5)


def create_app(key: str | None = None, db_path: str | None = None, symbols: dict | None = None, start: bool = True) -> FastAPI:
    key = key if key is not None else os.environ.get("WT_WORKER_KEY", "")
    if len(key) < 16:
        raise RuntimeError("WT_WORKER_KEY ต้องยาว ≥16 ตัวอักษร")
    store = FlowStore(db_path or os.environ.get("WT_FLOW_DB", str(BASE / "flow.db")),
                      symbols or parse_symbols(os.environ.get("WT_FLOW_SYMBOLS", "BTCUSDT:5,ETHUSDT:0.5")))

    @asynccontextmanager
    async def lifespan(_app):
        tasks = [asyncio.create_task(run_stream(store)), asyncio.create_task(run_timers(store))] if start else []
        yield
        for t in tasks:
            t.cancel()
        for s, m in list(store.cur.items()):
            store.flush(s, m)

    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)
    app.state.store = store

    @app.middleware("http")
    async def guard(request: Request, call_next):
        import hmac
        if not hmac.compare_digest(request.headers.get("x-worker-key") or "", key):
            return JSONResponse({"detail": "forbidden"}, status_code=403)
        return await call_next(request)

    def sym_ok(symbol: str) -> str:
        s = symbol.upper()
        if s not in store.symbols:
            raise HTTPException(status_code=404, detail=f"ไม่มี order flow ของ {symbol} (มี {', '.join(store.symbols)})")
        return s

    @app.get("/status")
    def status():
        return store.status()

    @app.get("/bars")
    def bars(symbol: str, tf: str, frm: int, to: int):
        if tf not in TF_SEC and tf != "MN1":
            raise HTTPException(status_code=400, detail="tf ไม่ถูกต้อง")
        return {"symbol": sym_ok(symbol), "tf": tf, "bars": store.bars(sym_ok(symbol), tf, frm, to)}

    @app.get("/profile")
    def profile(symbol: str, frm: int, to: int, rows: int = 80):
        return store.profile(sym_ok(symbol), frm, to, max(10, min(200, rows)))

    @app.get("/liq")
    def liq(symbol: str, frm: float, to: float):
        return {"liq": store.liqs(sym_ok(symbol), frm, to)}

    return app


if os.environ.get("WT_NO_AUTOAPP") != "1":
    logging.basicConfig(level=logging.INFO, format="%(levelname)s: [flow] %(message)s")
    logging.getLogger("httpx").setLevel(logging.WARNING)   # ไม่ log ทุก request ไป Binance (~380 KB/วัน)
    app = create_app()
