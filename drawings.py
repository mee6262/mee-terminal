"""เก็บเส้น/รูปที่วาดบนกราฟ ต่อ symbol (ใช้ร่วมทุก TF และทุกบัญชี แบบ TradingView)"""
import json
import re
import sqlite3
import threading
import time

MAX_BYTES = 256 * 1024
MAX_OVERLAYS = 500
SYMBOL_RE = re.compile(r"^[A-Za-z0-9._#-]{1,32}$")
ALLOWED_KEYS = {"name", "points", "extendData", "styles", "lock", "visible", "mode"}


def clean_overlays(raw) -> list:
    if not isinstance(raw, list) or len(raw) > MAX_OVERLAYS:
        raise ValueError(f"overlays ต้องเป็น list ไม่เกิน {MAX_OVERLAYS} ชิ้น")
    out = []
    for o in raw:
        if not isinstance(o, dict) or not isinstance(o.get("name"), str) or not isinstance(o.get("points"), list):
            raise ValueError("overlay ต้องมี name + points")
        pts = []
        for pt in o["points"][:10]:
            if not isinstance(pt, dict):
                raise ValueError("point ผิดรูปแบบ")
            ts, val = pt.get("timestamp"), pt.get("value")
            if not isinstance(ts, (int, float)) or not isinstance(val, (int, float)):
                raise ValueError("point ต้องมี timestamp + value เป็นตัวเลข")
            pts.append({"timestamp": ts, "value": val})
        out.append({k: (pts if k == "points" else v) for k, v in o.items() if k in ALLOWED_KEYS})
    if len(json.dumps(out)) > MAX_BYTES:
        raise ValueError("ข้อมูลใหญ่เกิน 256KB")
    return out


class DrawingStore:
    def __init__(self, db_path: str):
        self._conn = sqlite3.connect(db_path, check_same_thread=False)
        self._lock = threading.Lock()
        with self._lock:
            self._conn.execute(
                "CREATE TABLE IF NOT EXISTS drawings (symbol TEXT PRIMARY KEY, data TEXT NOT NULL, updated REAL NOT NULL)")
            self._conn.commit()

    def get(self, symbol: str) -> list:
        with self._lock:
            row = self._conn.execute("SELECT data FROM drawings WHERE symbol=?", (symbol,)).fetchone()
        return json.loads(row[0]) if row else []

    def put(self, symbol: str, overlays: list) -> None:
        with self._lock:
            self._conn.execute(
                "INSERT INTO drawings(symbol, data, updated) VALUES (?,?,?) "
                "ON CONFLICT(symbol) DO UPDATE SET data=excluded.data, updated=excluded.updated",
                (symbol, json.dumps(overlays), time.time()))
            self._conn.commit()


PREF_KEY_RE = re.compile(r"^wt\.[A-Za-z0-9._-]{1,60}$")
PREF_MAX_BYTES = 64 * 1024
PREF_MAX_KEYS = 500


class PrefStore:
    """การตั้งค่าหน้าเว็บ (watchlist, layout กราฟ, lot, Fib default ฯลฯ) — เก็บที่ server ใช้ได้ทุกเครื่อง"""

    def __init__(self, db_path: str):
        self._conn = sqlite3.connect(db_path, check_same_thread=False)
        self._lock = threading.Lock()
        with self._lock:
            self._conn.execute(
                "CREATE TABLE IF NOT EXISTS prefs (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated REAL NOT NULL)")
            self._conn.commit()

    def all(self) -> dict:
        with self._lock:
            rows = self._conn.execute("SELECT key, value FROM prefs").fetchall()
        return {k: json.loads(v) for k, v in rows}

    def put(self, key: str, value) -> None:
        if not PREF_KEY_RE.match(key):
            raise ValueError("key ไม่ถูกต้อง")
        data = json.dumps(value)
        if len(data) > PREF_MAX_BYTES:
            raise ValueError("ค่าใหญ่เกิน 64KB")
        with self._lock:
            n = self._conn.execute("SELECT COUNT(*) FROM prefs WHERE key<>?", (key,)).fetchone()[0]
            if n >= PREF_MAX_KEYS:
                raise ValueError("จำนวนการตั้งค่าเต็ม")
            self._conn.execute(
                "INSERT INTO prefs(key, value, updated) VALUES (?,?,?) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated=excluded.updated",
                (key, data, time.time()))
            self._conn.commit()


REPLAY_MAX_BYTES = 512 * 1024
REPLAY_MAX_ROWS = 200


class ReplayStore:
    """ผลรอบ Bar Replay (สรุป + ไม้ + สถานะไว้เล่นต่อ) — เก็บที่ server ดูได้ทุกเครื่อง, สำรองไปกับ db"""

    def __init__(self, db_path: str):
        self._conn = sqlite3.connect(db_path, check_same_thread=False)
        self._lock = threading.Lock()
        with self._lock:
            self._conn.execute(
                "CREATE TABLE IF NOT EXISTS replay_sessions (sid INTEGER PRIMARY KEY, data TEXT NOT NULL, updated REAL NOT NULL)")
            self._conn.commit()

    def list(self) -> list:
        with self._lock:
            rows = self._conn.execute("SELECT data FROM replay_sessions ORDER BY updated DESC").fetchall()
        return [json.loads(r[0]) for r in rows]

    def put(self, sid: int, value: dict) -> None:
        if not isinstance(value, dict) or not isinstance(value.get("trades", []), list):
            raise ValueError("ข้อมูลรอบ replay ไม่ถูกต้อง")
        value = {**value, "sid": sid}
        data = json.dumps(value)
        if len(data) > REPLAY_MAX_BYTES:
            raise ValueError("รอบนี้ใหญ่เกิน 512KB")
        with self._lock:
            self._conn.execute(
                "INSERT INTO replay_sessions(sid, data, updated) VALUES (?,?,?) "
                "ON CONFLICT(sid) DO UPDATE SET data=excluded.data, updated=excluded.updated",
                (sid, data, time.time()))
            self._conn.execute("DELETE FROM replay_sessions WHERE sid NOT IN "
                               "(SELECT sid FROM replay_sessions ORDER BY updated DESC LIMIT ?)", (REPLAY_MAX_ROWS,))
            self._conn.commit()

    def delete(self, sid: int) -> None:
        with self._lock:
            self._conn.execute("DELETE FROM replay_sessions WHERE sid=?", (sid,))
            self._conn.commit()


JOURNAL_NOTE_MAX = 4000
JOURNAL_IMG_MAX = 700 * 1024
ACCT_RE = re.compile(r"^[a-z0-9_-]{1,32}$")


class JournalStore:
    """บันทึกประจำไม้ (โน้ต / tag / ภาพกราฟ) ต่อ บัญชี + position_id"""

    def __init__(self, db_path: str):
        self._conn = sqlite3.connect(db_path, check_same_thread=False)
        self._lock = threading.Lock()
        with self._lock:
            self._conn.execute(
                "CREATE TABLE IF NOT EXISTS journal (acct TEXT NOT NULL, pid INTEGER NOT NULL, note TEXT NOT NULL DEFAULT '',"
                " tags TEXT NOT NULL DEFAULT '[]', img BLOB, img_type TEXT, updated REAL NOT NULL, PRIMARY KEY (acct, pid))")
            self._conn.commit()

    def list(self, acct: str) -> dict:
        with self._lock:
            rows = self._conn.execute(
                "SELECT pid, note, tags, img IS NOT NULL, updated FROM journal WHERE acct=?", (acct,)).fetchall()
        return {str(pid): {"note": n, "tags": json.loads(t), "has_image": bool(hi), "updated": u} for pid, n, t, hi, u in rows}

    def put(self, acct: str, pid: int, note: str, tags: list) -> None:
        if not isinstance(note, str) or len(note) > JOURNAL_NOTE_MAX:
            raise ValueError(f"โน้ตยาวเกิน {JOURNAL_NOTE_MAX} ตัวอักษร")
        if not isinstance(tags, list) or len(tags) > 20 or not all(isinstance(x, str) and 0 < len(x) <= 30 for x in tags):
            raise ValueError("tag ไม่เกิน 20 อัน อันละไม่เกิน 30 ตัวอักษร")
        with self._lock:
            self._conn.execute(
                "INSERT INTO journal(acct, pid, note, tags, updated) VALUES (?,?,?,?,?) "
                "ON CONFLICT(acct, pid) DO UPDATE SET note=excluded.note, tags=excluded.tags, updated=excluded.updated",
                (acct, pid, note, json.dumps(tags, ensure_ascii=False), time.time()))
            self._conn.commit()

    def put_image(self, acct: str, pid: int, data: bytes | None, mime: str | None) -> None:
        if data is not None and len(data) > JOURNAL_IMG_MAX:
            raise ValueError("ภาพใหญ่เกิน 700KB")
        with self._lock:
            self._conn.execute(
                "INSERT INTO journal(acct, pid, img, img_type, updated) VALUES (?,?,?,?,?) "
                "ON CONFLICT(acct, pid) DO UPDATE SET img=excluded.img, img_type=excluded.img_type, updated=excluded.updated",
                (acct, pid, data, mime, time.time()))
            self._conn.commit()

    def image(self, acct: str, pid: int):
        with self._lock:
            row = self._conn.execute("SELECT img, img_type FROM journal WHERE acct=? AND pid=?", (acct, pid)).fetchone()
        return (row[0], row[1]) if row and row[0] is not None else None


class AlertLog:
    """ประวัติ alert ที่ส่ง Telegram แล้ว (ตัวส่งจริงคือ alerts/alert_service.js)"""

    def __init__(self, db_path: str):
        self._conn = sqlite3.connect(db_path, check_same_thread=False)
        self._lock = threading.Lock()
        with self._lock:
            self._conn.execute(
                "CREATE TABLE IF NOT EXISTS alert_log (id INTEGER PRIMARY KEY AUTOINCREMENT, ts REAL NOT NULL,"
                " rule_id TEXT NOT NULL, text TEXT NOT NULL, ok INTEGER NOT NULL, error TEXT)")
            self._conn.commit()

    def add(self, rule_id: str, text: str, ok: bool, error: str | None) -> None:
        with self._lock:
            self._conn.execute("INSERT INTO alert_log(ts, rule_id, text, ok, error) VALUES (?,?,?,?,?)",
                               (time.time(), str(rule_id)[:64], str(text)[:2000], int(bool(ok)), (error or "")[:500] or None))
            self._conn.execute("DELETE FROM alert_log WHERE id NOT IN (SELECT id FROM alert_log ORDER BY id DESC LIMIT 1000)")
            self._conn.commit()

    def recent(self, limit: int = 50) -> list:
        with self._lock:
            rows = self._conn.execute(
                "SELECT ts, rule_id, text, ok, error FROM alert_log ORDER BY id DESC LIMIT ?", (limit,)).fetchall()
        return [{"ts": ts, "rule_id": r, "text": t, "ok": bool(ok), "error": e} for ts, r, t, ok, e in rows]
