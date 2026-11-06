"""P0 acceptance: cd web_terminal && python -m unittest discover -s tests -v"""
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
os.environ["WT_NO_AUTOAPP"] = "1"

from fastapi.testclient import TestClient  # noqa: E402

import auth  # noqa: E402
from auth import AuthStore, hash_password, verify_password  # noqa: E402

ORIGIN = "https://terminal.example.com"
PASSWORD = "correct horse battery"
H = {"X-Requested-With": "wt"}


def make_client():
    import gateway
    tmp = tempfile.mkdtemp()
    os.environ.update(WT_PASS_HASH=hash_password(PASSWORD), WT_ORIGIN=ORIGIN,
                      WT_DB=os.path.join(tmp, "t.db"), WT_COOKIE_SECURE="1",
                      WT_WORKER_KEY="k" * 32)
    return TestClient(gateway.create_app(), base_url=ORIGIN)


class PasswordHash(unittest.TestCase):
    def test_roundtrip(self):
        h = hash_password("abc123456789")
        self.assertTrue(verify_password("abc123456789", h))
        self.assertFalse(verify_password("abc123456780", h))

    def test_salted(self):
        self.assertNotEqual(hash_password("x" * 12), hash_password("x" * 12))

    def test_garbage_hash_rejected(self):
        for bad in ("", "plain", "bcrypt$1$2$3$4$5", "scrypt$a$b$c$d$e"):
            self.assertFalse(verify_password("x", bad))


class RateLimit(unittest.TestCase):
    def setUp(self):
        self.s = AuthStore(":memory:")

    def test_lock_after_max_fails(self):
        t = 1000.0
        for i in range(auth.MAX_FAILS - 1):
            self.s.record_attempt("1.2.3.4", False, now=t + i)
        self.assertEqual(self.s.locked_for("1.2.3.4", now=t + 10), 0)
        self.s.record_attempt("1.2.3.4", False, now=t + 10)
        self.assertGreater(self.s.locked_for("1.2.3.4", now=t + 11), 0)
        self.assertEqual(self.s.locked_for("5.6.7.8", now=t + 11), 0)  # IP อื่นไม่โดน
        self.assertEqual(self.s.locked_for("1.2.3.4", now=t + 10 + auth.LOCK_SEC + 1), 0)

    def test_success_resets_count(self):
        t = 1000.0
        for i in range(auth.MAX_FAILS - 1):
            self.s.record_attempt("ip", False, now=t + i)
        self.s.record_attempt("ip", True, now=t + 20)
        self.s.record_attempt("ip", False, now=t + 21)
        self.assertEqual(self.s.locked_for("ip", now=t + 22), 0)

    def test_session_expiry(self):
        tok = self.s.create_session("ip", "ua", now=0)
        self.assertTrue(self.s.valid_session(tok, now=10))
        self.assertFalse(self.s.valid_session(tok, now=auth.SESSION_TTL_SEC + 1))
        self.assertFalse(self.s.valid_session("forged", now=10))
        self.assertFalse(self.s.valid_session(None))


class Gateway(unittest.TestCase):
    def setUp(self):
        self.c = make_client()

    def login(self, pw=PASSWORD, headers=H):
        return self.c.post("/api/auth/login", json={"password": pw}, headers=headers)

    def test_every_protected_route_needs_session(self):
        import gateway
        app = self.c.app
        routes = [r for r in app.routes if getattr(r, "path", None)]
        checked = 0
        for r in routes:
            path = r.path.replace("{path:path}", "x")
            if path in gateway.PUBLIC_PATHS:
                continue
            for m in (getattr(r, "methods", None) or {"GET"}):
                hdr = H if m != "GET" else {}
                resp = self.c.request(m, path, headers=hdr, follow_redirects=False)
                ok = (403,) if path.startswith("/internal/") else (401, 303)   # internal = key + localhost เท่านั้น
                self.assertIn(resp.status_code, ok, f"{m} {path} -> {resp.status_code}")
                checked += 1
        self.assertGreaterEqual(checked, 5)
        # static ที่ไม่ใช่หน้า login ก็ต้องล็อก
        self.assertEqual(self.c.get("/static/app.js", follow_redirects=False).status_code, 303)

    def test_login_flow_and_cookie_flags(self):
        r = self.login()
        self.assertEqual(r.status_code, 200)
        sc = r.headers["set-cookie"].lower()
        for flag in ("httponly", "secure", "samesite=strict", "max-age="):
            self.assertIn(flag, sc)
        self.assertEqual(self.c.get("/api/auth/check").status_code, 200)
        self.assertEqual(self.c.get("/").status_code, 200)
        self.assertEqual(self.c.post("/api/auth/logout", headers=H).status_code, 200)
        self.assertEqual(self.c.get("/api/auth/check").status_code, 401)

    def test_wrong_password(self):
        self.assertEqual(self.login("nope").status_code, 401)
        self.assertEqual(self.c.get("/api/auth/check").status_code, 401)

    def test_lockout_blocks_even_correct_password(self):
        for _ in range(auth.MAX_FAILS):
            self.login("nope")
        self.assertEqual(self.login().status_code, 429)

    def test_csrf_header_required(self):
        self.assertEqual(self.login(headers={}).status_code, 403)
        self.login()
        self.assertEqual(self.c.post("/api/auth/logout").status_code, 403)

    def test_bad_origin_rejected(self):
        r = self.login(headers={**H, "Origin": "https://evil.example"})
        self.assertEqual(r.status_code, 403)
        self.assertEqual(self.login(headers={**H, "Origin": ORIGIN}).status_code, 200)

    def test_security_headers(self):
        r = self.c.get("/login")
        self.assertEqual(r.headers["x-frame-options"], "DENY")
        self.assertIn("frame-ancestors 'none'", r.headers["content-security-policy"])
        self.assertEqual(self.c.get("/api/auth/check").headers["x-content-type-options"], "nosniff")

    def test_no_api_docs_exposed(self):
        for p in ("/docs", "/openapi.json", "/redoc"):
            self.assertIn(self.c.get(p, follow_redirects=False).status_code, (303, 401, 404))

    def test_logout_all_kills_other_sessions(self):
        self.login()
        other = TestClient(self.c.app, base_url=ORIGIN)
        other.post("/api/auth/login", json={"password": PASSWORD}, headers=H)
        self.assertEqual(other.get("/api/auth/check").status_code, 200)
        self.c.post("/api/auth/logout-all", headers=H)
        self.assertEqual(other.get("/api/auth/check").status_code, 401)


class StartupFailsClosed(unittest.TestCase):
    def test_missing_hash_refuses_to_start(self):
        import gateway
        old = os.environ.pop("WT_PASS_HASH", None)
        try:
            with self.assertRaises(RuntimeError):
                gateway.create_app()
        finally:
            if old:
                os.environ["WT_PASS_HASH"] = old

    def test_http_origin_refused(self):
        import gateway
        os.environ.update(WT_PASS_HASH=hash_password(PASSWORD), WT_ORIGIN="http://x", WT_COOKIE_SECURE="1")
        with self.assertRaises(RuntimeError):
            gateway.create_app()


if __name__ == "__main__":
    unittest.main()
