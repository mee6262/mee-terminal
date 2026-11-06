"""Web Push — แจ้งเตือนเด้งบนมือถือ/คอม โดยตรงจากเว็บ (ใช้คู่กับ Telegram)

- ต้องติดตั้ง pywebpush ใน venv: `pip install pywebpush` (ไม่มี = ฟีเจอร์นี้ปิด ส่วนอื่นทำงานปกติ)
- VAPID key สร้างครั้งแรกอัตโนมัติ เก็บใน SQLite (ไฟล์ .db ไม่ขึ้น git)
- iPhone: ต้อง "เพิ่มลงหน้าจอหลัก" แล้วเปิดจากไอคอนก่อน (iOS 16.4+) ถึงจะขอสิทธิ์แจ้งเตือนได้
"""
import base64
import json
import logging
import sqlite3
import threading
import time

log = logging.getLogger("wt.push")

try:
    from pywebpush import WebPushException, webpush
except ImportError:          # ยังไม่ได้ติดตั้ง
    webpush = None
    WebPushException = Exception

MAX_SUBS = 20


def available() -> bool:
    return webpush is not None


def _b64u(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def gen_vapid() -> dict:
    """คู่กุญแจ P-256: private = DER (PKCS8) base64url (pywebpush รับตรง), public = จุดแบบ uncompressed base64url (ให้เบราว์เซอร์)"""
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    key = ec.generate_private_key(ec.SECP256R1())
    der = key.private_bytes(serialization.Encoding.DER, serialization.PrivateFormat.PKCS8, serialization.NoEncryption())
    pub = key.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
    return {"private": _b64u(der), "public": _b64u(pub)}


class PushStore:
    def __init__(self, db_path: str, sub_claim: str):
        self._conn = sqlite3.connect(db_path, check_same_thread=False)
        self._lock = threading.Lock()
        self.sub_claim = sub_claim   # VAPID "sub": URL เว็บ (https://...) หรือ mailto:
        with self._lock:
            self._conn.execute("CREATE TABLE IF NOT EXISTS push_subs (endpoint TEXT PRIMARY KEY, sub TEXT NOT NULL,"
                               " ua TEXT, created REAL NOT NULL)")
            self._conn.execute("CREATE TABLE IF NOT EXISTS push_kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)")
            self._conn.commit()

    def vapid(self) -> dict:
        with self._lock:
            row = self._conn.execute("SELECT v FROM push_kv WHERE k='vapid'").fetchone()
            if row:
                return json.loads(row[0])
            v = gen_vapid()
            self._conn.execute("INSERT INTO push_kv(k, v) VALUES ('vapid', ?)", (json.dumps(v),))
            self._conn.commit()
            return v

    def add(self, sub: dict, ua: str = "") -> None:
        ep = str(sub.get("endpoint") or "")
        keys = sub.get("keys") or {}
        if not ep.startswith("https://") or not keys.get("p256dh") or not keys.get("auth"):
            raise ValueError("subscription ไม่ถูกต้อง")
        with self._lock:
            n = self._conn.execute("SELECT COUNT(*) FROM push_subs WHERE endpoint<>?", (ep,)).fetchone()[0]
            if n >= MAX_SUBS:
                raise ValueError(f"ลงทะเบียนได้ไม่เกิน {MAX_SUBS} เครื่อง")
            self._conn.execute("INSERT INTO push_subs(endpoint, sub, ua, created) VALUES (?,?,?,?) "
                               "ON CONFLICT(endpoint) DO UPDATE SET sub=excluded.sub, ua=excluded.ua",
                               (ep, json.dumps({"endpoint": ep, "keys": {"p256dh": keys["p256dh"], "auth": keys["auth"]}}),
                                ua[:200], time.time()))
            self._conn.commit()

    def remove(self, endpoint: str) -> None:
        with self._lock:
            self._conn.execute("DELETE FROM push_subs WHERE endpoint=?", (endpoint,))
            self._conn.commit()

    def all(self) -> list:
        with self._lock:
            rows = self._conn.execute("SELECT sub FROM push_subs").fetchall()
        return [json.loads(r[0]) for r in rows]

    def count(self) -> int:
        with self._lock:
            return self._conn.execute("SELECT COUNT(*) FROM push_subs").fetchone()[0]

    def send_all(self, title: str, body: str, tag: str = "") -> dict:
        """ส่งทุกเครื่อง — เครื่องที่ยกเลิกไปแล้ว (404/410) ลบทิ้ง"""
        if not available():
            return {"ok": False, "error": "ยังไม่ได้ติดตั้ง pywebpush", "sent": 0}
        v = self.vapid()
        payload = json.dumps({"title": title[:120], "body": body[:600], "tag": tag[:64]}, ensure_ascii=False)
        sent, errors = 0, []
        for sub in self.all():
            try:
                webpush(subscription_info=sub, data=payload, vapid_private_key=v["private"],
                        vapid_claims={"sub": self.sub_claim}, ttl=3600, timeout=10)
                sent += 1
            except WebPushException as e:
                code = getattr(getattr(e, "response", None), "status_code", None)
                if code in (404, 410):
                    self.remove(sub["endpoint"])
                else:
                    errors.append(f"{code or ''} {e}"[:200])
            except Exception as e:  # เครือข่าย ฯลฯ — ห้ามทำให้ตัวส่ง alert ล้ม
                errors.append(repr(e)[:200])
        if errors:
            log.warning("web push errors: %s", errors[:3])
        return {"ok": sent > 0 or not errors, "sent": sent, "errors": errors[:5]}
