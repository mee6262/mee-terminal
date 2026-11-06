"""Web Push: VAPID สร้างครั้งเดียว, ลงทะเบียน/ยกเลิก, ส่งทุกเครื่อง + ลบเครื่องที่ยกเลิกแล้ว (410), endpoint ต้องล็อกอิน/ภายใน"""
import base64
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))
os.environ["WT_NO_AUTOAPP"] = "1"

import fake_mt5  # noqa: E402,F401
from fastapi.testclient import TestClient  # noqa: E402

import push  # noqa: E402
from auth import hash_password  # noqa: E402

KEY = "k" * 32
ORIGIN = "https://terminal.example.com"
PASSWORD = "correct horse battery"
SUB = {"endpoint": "https://push.example/abc", "keys": {"p256dh": "BP" + "a" * 80, "auth": "x" * 22}}


class FakeResp:
    def __init__(self, code):
        self.status_code = code


class FakeWPE(Exception):
    def __init__(self, msg, code):
        super().__init__(msg)
        self.response = FakeResp(code)


class Store(unittest.TestCase):
    def setUp(self):
        self.s = push.PushStore(os.path.join(tempfile.mkdtemp(), "p.db"), ORIGIN)
        self.orig = (push.webpush, push.WebPushException)

    def tearDown(self):
        push.webpush, push.WebPushException = self.orig

    def test_vapid_stable_and_valid(self):
        v = self.s.vapid()
        self.assertEqual(v, self.s.vapid())
        pub = base64.urlsafe_b64decode(v["public"] + "==")
        self.assertEqual((len(pub), pub[0]), (65, 4))                 # P-256 uncompressed point

    def test_add_remove_and_send(self):
        with self.assertRaises(ValueError):
            self.s.add({"endpoint": "http://insecure", "keys": {}})
        self.s.add(SUB)
        self.s.add({**SUB, "endpoint": "https://push.example/gone"})
        self.assertEqual(self.s.count(), 2)
        calls = []

        def fake(subscription_info, data, vapid_private_key, vapid_claims, **kw):
            calls.append((subscription_info["endpoint"], json.loads(data)["title"], vapid_claims["sub"]))
            if subscription_info["endpoint"].endswith("gone"):
                raise FakeWPE("gone", 410)
        push.webpush, push.WebPushException = fake, FakeWPE
        r = self.s.send_all("หัวข้อ", "เนื้อหา", "price")
        self.assertEqual(r["sent"], 1)
        self.assertEqual(self.s.count(), 1)                               # 410 = ลบทิ้ง
        self.assertEqual(calls[0][1:], ("หัวข้อ", ORIGIN))

    def test_without_pywebpush(self):
        push.webpush = None
        self.assertFalse(push.available())
        self.assertIn("pywebpush", self.s.send_all("a", "b")["error"])


class Gateway(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        tmp = tempfile.mkdtemp()
        acc = Path(tmp) / "accounts.json"
        acc.write_text(json.dumps({"accounts": [{"name": "demo", "kind": "std", "terminal_path": "x", "port": 18399}]}))
        os.environ.update(WT_PASS_HASH=hash_password(PASSWORD), WT_ORIGIN=ORIGIN, WT_COOKIE_SECURE="1",
                          WT_DB=os.path.join(tmp, "g.db"), WT_WORKER_KEY=KEY, WT_ACCOUNTS=str(acc))
        import gateway
        gateway.TRUSTED_PROXIES.add("testclient")
        cls.gapp = gateway.create_app()

    def client(self):
        c = TestClient(self.gapp, base_url=ORIGIN)
        assert c.post("/api/auth/login", json={"password": PASSWORD}, headers={"X-Requested-With": "wt"}).status_code == 200
        return c

    def test_endpoints(self):
        anon = TestClient(self.gapp, base_url=ORIGIN)
        self.assertEqual(anon.get("/sw.js").status_code, 200)             # service worker เปิดสาธารณะ
        self.assertEqual(anon.get("/api/push/key").status_code, 401)
        c = self.client()
        H = {"X-Requested-With": "wt"}
        orig = push.webpush
        try:
            push.webpush = None
            self.assertEqual(c.get("/api/push/key").status_code, 503)
            push.webpush = lambda **kw: None
            self.assertEqual(len(c.get("/api/push/key").json()["publicKey"]), 87)
            self.assertEqual(c.post("/api/push/subscribe", json={"subscription": SUB}, headers=H).json()["devices"], 1)
            self.assertEqual(c.post("/api/push/test", headers=H).json()["sent"], 1)
            self.assertEqual(anon.post("/internal/push/send", json={"text": "a\nb"}).status_code, 403)
            r = anon.post("/internal/push/send", json={"text": "🔔 หัว\nเนื้อ"}, headers={"X-Worker-Key": KEY})
            self.assertEqual(r.json()["sent"], 1)
            self.assertEqual(c.post("/api/push/unsubscribe", json={"endpoint": SUB["endpoint"]}, headers=H).json()["devices"], 0)
        finally:
            push.webpush = orig


if __name__ == "__main__":
    unittest.main()
