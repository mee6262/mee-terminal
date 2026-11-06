"""Auth สำหรับ web_terminal — รหัสผ่านเดียว + session cookie (WEB_TERMINAL_PLAN.md P0)

- รหัสผ่านเก็บเป็น scrypt hash (stdlib ล้วน ไม่ต้องลง bcrypt บน VPS) ใน env WT_PASS_HASH
- session token สุ่ม 32 byte, DB เก็บแค่ sha256 ของ token (DB หลุด = ใช้ session ไม่ได้)
- ล็อกอินผิดครบ MAX_FAILS ใน WINDOW_SEC ต่อ IP -> ล็อก LOCK_SEC (เก็บใน SQLite รอด restart)
"""
import base64
import hashlib
import hmac
import secrets
import sqlite3
import threading
import time

SESSION_TTL_SEC = 7 * 24 * 3600
MAX_FAILS = 5
WINDOW_SEC = 15 * 60
LOCK_SEC = 15 * 60

_SCRYPT_N, _SCRYPT_R, _SCRYPT_P = 2 ** 15, 8, 1
_SCRYPT_MAXMEM = 64 * 1024 * 1024


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    dk = hashlib.scrypt(password.encode(), salt=salt, n=_SCRYPT_N, r=_SCRYPT_R, p=_SCRYPT_P,
                        maxmem=_SCRYPT_MAXMEM, dklen=32)
    b64 = lambda b: base64.b64encode(b).decode()
    return f"scrypt${_SCRYPT_N}${_SCRYPT_R}${_SCRYPT_P}${b64(salt)}${b64(dk)}"


def verify_password(password: str, stored: str) -> bool:
    try:
        algo, n, r, p, salt_b64, dk_b64 = stored.split("$")
        if algo != "scrypt":
            return False
        salt, expected = base64.b64decode(salt_b64), base64.b64decode(dk_b64)
        dk = hashlib.scrypt(password.encode(), salt=salt, n=int(n), r=int(r), p=int(p),
                            maxmem=_SCRYPT_MAXMEM, dklen=len(expected))
    except (ValueError, TypeError):
        return False
    return hmac.compare_digest(dk, expected)


def _token_key(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


class AuthStore:
    def __init__(self, db_path: str):
        self._conn = sqlite3.connect(db_path, check_same_thread=False)
        self._lock = threading.Lock()
        with self._lock:
            self._conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS sessions (
                    token_key TEXT PRIMARY KEY, created REAL NOT NULL, expires REAL NOT NULL,
                    ip TEXT, user_agent TEXT);
                CREATE TABLE IF NOT EXISTS login_attempts (
                    ip TEXT NOT NULL, ts REAL NOT NULL, ok INTEGER NOT NULL);
                CREATE INDEX IF NOT EXISTS ix_attempts_ip_ts ON login_attempts(ip, ts);
                """
            )
            self._conn.commit()

    # ---------- rate limit ----------
    def locked_for(self, ip: str, now: float | None = None) -> float:
        """วินาทีที่ IP นี้ยังถูกล็อกอยู่ (0 = ไม่ล็อก)
        นับเฉพาะครั้งที่ผิดหลังล็อกอินสำเร็จครั้งล่าสุดใน WINDOW_SEC"""
        now = time.time() if now is None else now
        with self._lock:
            rows = self._conn.execute(
                "SELECT ts, ok FROM login_attempts WHERE ip=? AND ts>=? ORDER BY ts",
                (ip, now - WINDOW_SEC - LOCK_SEC),
            ).fetchall()
        fails = []
        for ts, ok in rows:
            if ok:
                fails = []
            else:
                fails.append(ts)
        # หา fail ครั้งที่ MAX_FAILS ที่เกิดภายใน WINDOW_SEC ของกันและกัน
        for i in range(len(fails) - MAX_FAILS + 1):
            if fails[i + MAX_FAILS - 1] - fails[i] <= WINDOW_SEC:
                unlock_at = fails[i + MAX_FAILS - 1] + LOCK_SEC
                if unlock_at > now:
                    return unlock_at - now
        return 0.0

    def record_attempt(self, ip: str, ok: bool, now: float | None = None) -> None:
        now = time.time() if now is None else now
        with self._lock:
            self._conn.execute("INSERT INTO login_attempts(ip, ts, ok) VALUES (?,?,?)", (ip, now, int(ok)))
            self._conn.execute("DELETE FROM login_attempts WHERE ts < ?", (now - 7 * 24 * 3600,))
            self._conn.commit()

    # ---------- sessions ----------
    def create_session(self, ip: str, user_agent: str, now: float | None = None) -> str:
        now = time.time() if now is None else now
        token = secrets.token_urlsafe(32)
        with self._lock:
            self._conn.execute(
                "INSERT INTO sessions(token_key, created, expires, ip, user_agent) VALUES (?,?,?,?,?)",
                (_token_key(token), now, now + SESSION_TTL_SEC, ip, (user_agent or "")[:300]),
            )
            self._conn.execute("DELETE FROM sessions WHERE expires < ?", (now,))
            self._conn.commit()
        return token

    def valid_session(self, token: str | None, now: float | None = None) -> bool:
        if not token:
            return False
        now = time.time() if now is None else now
        with self._lock:
            row = self._conn.execute(
                "SELECT expires FROM sessions WHERE token_key=?", (_token_key(token),)
            ).fetchone()
        return bool(row) and row[0] > now

    def delete_session(self, token: str | None) -> None:
        if not token:
            return
        with self._lock:
            self._conn.execute("DELETE FROM sessions WHERE token_key=?", (_token_key(token),))
            self._conn.commit()

    def delete_all_sessions(self) -> None:
        with self._lock:
            self._conn.execute("DELETE FROM sessions")
            self._conn.commit()
