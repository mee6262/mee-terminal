"""โหลด accounts.json — 1 entry = 1 บัญชี = 1 worker process (MetaTrader5 python ผูก 1 terminal ต่อ process)

ฟิลด์:
  name           ชื่อสั้น ใช้ใน URL (a-z0-9_-)
  kind           cent | std | prop
  terminal_path  path ของ terminal64.exe
  port           พอร์ต worker (bind 127.0.0.1 เท่านั้น)
  portable       (optional) true ถ้า terminal ติดตั้งแบบ portable (ทางลัดมี /portable) — ไม่ตรง = IPC -10003 ค้าง ~100 วินาที
  server_utc_offset_h (optional, default 0) เวลา server ของโบรก - UTC; worker แปลงเวลาแท่งเป็น UTC จริงก่อนส่ง
                 หน้าเว็บเตือนเองถ้าเวลา tick สดไม่ตรงค่านี้
  trading        (default false) true = เปิดให้ส่งคำสั่งเทรดจากเว็บ
  allow_real     (default false) ต้อง true ถ้า terminal เป็นบัญชี REAL ไม่งั้นทุกคำสั่งถูกปฏิเสธ
  magic, deviation  magic ของออเดอร์จากเว็บ (default 0 = เหมือนเทรดมือ), slippage points (default 20)
  guards         (optional) max_lot, max_positions, max_risk_pct, require_sl, daily_loss_pct,
                 day_reset ("16:59 America/New_York" สำหรับ FTP prop)
  login          (optional) ถ้าใส่ worker จะเช็คว่า terminal ล็อกอินบัญชีนี้อยู่จริง ไม่ตรง = ไม่ยอมทำงาน
"""
import json
import os
import re
from pathlib import Path

_BASE = Path(__file__).resolve().parent
# accounts.local.json (ไม่อยู่ใน git — หน้าเว็บบันทึกลงไฟล์นี้) มาก่อน accounts.json -> git pull ไม่ชน
# WT_ACCOUNTS_LOCAL: เทสต์ชี้ไปไฟล์ที่ไม่มี -> ใช้ accounts.json ใน repo ไม่ขึ้นกับบัญชีจริงบนเครื่อง
LOCAL_FILE = Path(os.environ.get("WT_ACCOUNTS_LOCAL") or _BASE / "accounts.local.json")
ACCOUNTS_FILE = LOCAL_FILE if LOCAL_FILE.exists() else _BASE / "accounts.json"
_NAME_RE = re.compile(r"^[a-z0-9_-]{1,32}$")


def validate_accounts(entries: list[dict]) -> dict[str, dict]:
    out: dict[str, dict] = {}
    ports = set()
    for a in entries:
        name = a["name"]
        if not _NAME_RE.match(name):
            raise ValueError(f"ชื่อบัญชีไม่ถูกต้อง: {name!r} (a-z0-9_- เท่านั้น)")
        if name in out:
            raise ValueError(f"ชื่อบัญชีซ้ำ: {name}")
        port = int(a["port"])
        if port in ports:
            raise ValueError(f"พอร์ตซ้ำ: {port}")
        if a.get("kind") not in ("cent", "std", "prop"):
            raise ValueError(f"{name}: kind ต้องเป็น cent|std|prop")
        ports.add(port)
        out[name] = {**a, "port": port, "login": int(a["login"]) if a.get("login") else None}
    return out


def load_accounts(path: Path | str | None = None) -> dict[str, dict]:
    path = path or (LOCAL_FILE if LOCAL_FILE.exists() else _BASE / "accounts.json")
    raw = json.loads(Path(path).read_text(encoding="utf-8-sig"))
    return validate_accounts(raw["accounts"])


# ---------- แก้จากหน้าเว็บ ----------
PORT_BASE = 8101
_GUARD_NUM = ("max_lot", "max_risk_pct", "daily_loss_pct")
_DAY_RESET_RE = re.compile(r"^\d{1,2}:\d{2} [A-Za-z_]+/[A-Za-z_]+$")


def _num(v, lo, hi, cast=float):
    if v in (None, ""):
        return None
    x = cast(v)
    if not lo <= x <= hi:
        raise ValueError(f"ค่า {v} อยู่นอกช่วง {lo}-{hi}")
    return x


def clean_entry(d: dict, old: dict | None = None) -> dict:
    """รับเฉพาะฟิลด์ที่รู้จัก + ตรวจชนิด/ช่วง; ฟิลด์ที่หน้าเว็บไม่รู้จักของเดิมเก็บไว้"""
    e = dict(old or {})
    e["name"] = str(d.get("name", "")).strip()
    e["kind"] = d.get("kind")
    path = str(d.get("terminal_path", "")).strip()
    if not path.lower().endswith("terminal64.exe"):
        raise ValueError(f"{e['name']}: path ต้องชี้ไปที่ terminal64.exe")
    e["terminal_path"] = path
    e["portable"] = bool(d.get("portable"))
    e["trading"] = bool(d.get("trading"))
    e["allow_real"] = bool(d.get("allow_real"))
    e["server_utc_offset_h"] = _num(d.get("server_utc_offset_h"), -12, 14) or 0
    e["magic"] = _num(d.get("magic"), 0, 2**31 - 1, int) or 0
    e["deviation"] = _num(d.get("deviation"), 0, 1000, int) or 20
    e["login"] = _num(d.get("login"), 1, 2**63 - 1, int)
    if d.get("port"):
        e["port"] = _num(d.get("port"), 1024, 65535, int)
    g = dict(e.get("guards") or {})
    gin = d.get("guards") or {}
    for k in _GUARD_NUM:
        v = _num(gin.get(k), 0, 1e6)
        if v is None:
            g.pop(k, None)
        else:
            g[k] = v
    mp = _num(gin.get("max_positions"), 0, 10000, int)
    if mp is None:
        g.pop("max_positions", None)
    else:
        g["max_positions"] = mp
    g["require_sl"] = bool(gin.get("require_sl"))
    if not g["require_sl"]:
        g.pop("require_sl")
    dr = str(gin.get("day_reset") or "").strip()
    if dr and not _DAY_RESET_RE.match(dr):
        raise ValueError(f"{e['name']}: day_reset ต้องเป็นแบบ '16:59 America/New_York'")
    if dr:
        g["day_reset"] = dr
    else:
        g.pop("day_reset", None)
    e["guards"] = g
    return e


def build_accounts(new: list[dict], current: list[dict]) -> list[dict]:
    """รายการจากหน้าเว็บ -> entries ที่ผ่านการตรวจ (ใส่ port ว่างให้เอง, path ห้ามซ้ำ)"""
    old = {a["name"]: a for a in current}
    out = [clean_entry(d, old.get(str(d.get("name", "")).strip())) for d in new]
    used = {int(a["port"]) for a in out if a.get("port")}
    for a in out:
        if not a.get("port"):
            p = PORT_BASE
            while p in used or p == 8100 or p == 8110:
                p += 1
            a["port"] = p
            used.add(p)
    paths = [a["terminal_path"].lower().replace("/", "\\") for a in out]
    if len(set(paths)) != len(paths):
        raise ValueError("terminal เดียวกันใช้ได้กับบัญชีเดียว (1 terminal = 1 worker)")
    validate_accounts(out)
    return out


def save_accounts(entries: list[dict], path: Path | str = LOCAL_FILE) -> None:
    """เขียนแบบ atomic + สำรองไฟล์เดิมเป็น accounts.json.bak"""
    path = Path(path)
    validate_accounts(entries)
    if path.exists():
        path.with_suffix(".json.bak").write_bytes(path.read_bytes())
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps({"accounts": entries}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    tmp.replace(path)


def detect_kind(currency: str | None, server: str | None = "") -> str:
    """USC / USc หรือ server ชื่อมี cent -> cent ไม่งั้น std (prop เลือกเอง)"""
    c = (currency or "").strip()
    return "cent" if c in ("USC", "USc", "EUC") or c.lower().endswith("cent") or "cent" in (server or "").lower() else "std"
