"""P5: ประวัติเทรด (รวม deal เป็นรายไม้) + journal"""
import base64
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
import MetaTrader5 as mt5  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import worker  # noqa: E402
from auth import hash_password  # noqa: E402

KEY = "k" * 32
ORIGIN = "https://terminal.example.com"
H = {"X-Requested-With": "wt"}
D = mt5.FullDeal


def deal(ticket, t, typ, entry, pid, vol, price, profit=0.0, comm=0.0, swap=0.0, fee=0.0, sym="XAUUSD", magic=0):
    return D(ticket, t * 1000, typ, entry, pid, sym, magic, vol, price, profit, comm, swap, fee, "")


class Aggregate(unittest.TestCase):
    def test_simple_and_partial(self):
        deals = [
            deal(1, 100, 0, 0, 7, 0.10, 2000.0, comm=-0.5),                 # buy in
            deal(2, 200, 1, 1, 7, 0.04, 2010.0, profit=4.0, comm=-0.2),     # ปิดบางส่วน
            deal(3, 300, 1, 1, 7, 0.06, 2020.0, profit=12.0, swap=-1.0),    # ปิดที่เหลือ
            deal(4, 150, 1, 0, 8, 0.05, 2005.0),                            # sell in ยังไม่ปิด
            deal(5, 50, 2, 0, 0, 0, 0, profit=1000.0),                      # ฝากเงิน
        ]
        out = worker.aggregate_deals(deals, offset_s=10)
        t7 = next(t for t in out["trades"] if t["position_id"] == 7)
        self.assertEqual((t7["side"], t7["vol_in"], t7["vol_out"], t7["closed"]), ("buy", 0.1, 0.1, True))
        self.assertAlmostEqual(t7["px_out"], (2010 * 0.04 + 2020 * 0.06) / 0.1)
        self.assertEqual((t7["time_open"], t7["time_close"]), (90, 290))
        self.assertEqual(t7["net"], round(4 + 12 - 0.5 - 0.2 - 1.0, 2))
        t8 = next(t for t in out["trades"] if t["position_id"] == 8)
        self.assertEqual((t8["side"], t8["closed"], t8["time_close"]), ("sell", False, None))
        self.assertEqual(out["balance"][0]["amount"], 1000.0)
        self.assertEqual(out["trades"][0]["position_id"], 7)   # เรียงล่าสุดก่อน

    def test_reversal_flagged(self):
        deals = [deal(1, 100, 0, 0, 9, 0.1, 10.0), deal(2, 200, 1, 2, 9, 0.2, 11.0, profit=1.0)]
        t = worker.aggregate_deals(deals)["trades"][0]
        self.assertTrue(t["reversed"])


class HistoryEndpoint(unittest.TestCase):
    def setUp(self):
        mt5.reset()
        self.c = TestClient(worker.create_app("demo", KEY, start_poller=False))
        self.h = {"X-Worker-Key": KEY}

    def test_fetches_missing_entry_deals(self):
        entry = deal(1, 100, 0, 0, 7, 0.1, 2000.0)
        exit_ = deal(2, 5000, 1, 1, 7, 0.1, 2010.0, profit=10.0)
        mt5.state["deals"] = [exit_]                 # ช่วงที่ขอมีแค่ deal ออก
        mt5.state["all_deals"] = [entry, exit_]
        r = self.c.get("/history", params={"frm": 1000, "to": 9000}, headers=self.h).json()
        t = r["trades"][0]
        self.assertEqual((t["side"], t["px_in"], t["closed"], t["net"]), ("buy", 2000.0, True, 10.0))
        self.assertEqual(r["currency"], "USD")

    def test_range_validation(self):
        self.assertEqual(self.c.get("/history", params={"frm": 10, "to": 5}, headers=self.h).status_code, 400)
        self.assertEqual(self.c.get("/history", params={"frm": 0, "to": 500 * 86400}, headers=self.h).status_code, 400)


class JournalAPI(unittest.TestCase):
    def setUp(self):
        import gateway
        tmp = tempfile.mkdtemp()
        os.environ.update(WT_PASS_HASH=hash_password("pw-123456789"), WT_ORIGIN=ORIGIN, WT_COOKIE_SECURE="1",
                          WT_DB=os.path.join(tmp, "j.db"), WT_WORKER_KEY=KEY,
                          WT_ACCOUNTS=str(HERE.parent / "accounts.json"))
        self.c = TestClient(gateway.create_app(), base_url=ORIGIN)
        self.c.post("/api/auth/login", json={"password": "pw-123456789"}, headers=H)

    def test_note_tags_image(self):
        self.assertEqual(self.c.get("/api/journal/demo").json(), {})
        self.assertEqual(self.c.put("/api/journal/demo/7", json={"note": "เข้าตาม OB", "tags": ["OB", "London"]}, headers=H).status_code, 200)
        j = self.c.get("/api/journal/demo").json()["7"]
        self.assertEqual((j["note"], j["tags"], j["has_image"]), ("เข้าตาม OB", ["OB", "London"], False))
        png = base64.b64encode(b"\x89PNG fake").decode()
        self.assertEqual(self.c.put("/api/journal/demo/7/image", json={"data": f"data:image/png;base64,{png}"}, headers=H).status_code, 200)
        self.assertTrue(self.c.get("/api/journal/demo").json()["7"]["has_image"])
        img = self.c.get("/api/journal/demo/7/image")
        self.assertEqual((img.status_code, img.headers["content-type"], img.content), (200, "image/png", b"\x89PNG fake"))
        self.assertEqual(self.c.get("/api/journal/demo").json()["7"]["note"], "เข้าตาม OB")   # ภาพไม่ลบโน้ต
        self.c.put("/api/journal/demo/7/image", json={"data": None}, headers=H)
        self.assertEqual(self.c.get("/api/journal/demo/7/image").status_code, 404)

    def test_validation(self):
        self.assertEqual(self.c.get("/api/journal/nope").status_code, 404)
        self.assertEqual(self.c.put("/api/journal/demo/7", json={"note": "x" * 5000}, headers=H).status_code, 400)
        self.assertEqual(self.c.put("/api/journal/demo/7", json={"note": "", "tags": ["a" * 40]}, headers=H).status_code, 400)
        self.assertEqual(self.c.put("/api/journal/demo/7/image", json={"data": "data:text/html;base64,PGI+"}, headers=H).status_code, 400)
        self.assertEqual(self.c.put("/api/journal/demo/7/image", json={"data": "data:image/png;base64,@@@"}, headers=H).status_code, 400)
        self.assertEqual(self.c.put("/api/journal/demo/7", json={"note": "x"}).status_code, 403)
        self.assertEqual(TestClient(self.c.app, base_url=ORIGIN).get("/api/journal/demo").status_code, 401)


if __name__ == "__main__":
    unittest.main()


class NewsModule(unittest.TestCase):
    def test_assessment_rules(self):
        import news
        up = news._assess_news_event("CPI YoY", "USD", 3.2, 3.0, 2.9)
        self.assertEqual((up["tone"], up["category"]), ("positive", "เงินเฟ้อ"))
        down = news._assess_news_event("Unemployment Rate", "USD", 4.5, 4.2, 4.1)
        self.assertEqual(down["tone"], "negative")
        self.assertEqual(news._assess_news_event("Fed Chair Powell Speaks", "USD", None, None, None)["tone"], "neutral")
        self.assertEqual(news._assess_news_event("GDP Growth Rate", "EUR", None, 0.3, 0.2)["tone"], "pending")
        self.assertIsNone(news._assess_news_event("Some Holiday", "JPY", None, None, None))

    def test_build_and_cache_fallback(self):
        import news
        ev = news._build_news_events([{"date": "2026-09-28T12:30:00.000Z", "currency": "USD", "importance": 1,
                                       "title": "Non Farm Payrolls", "actual": None, "forecast": 150, "previous": 142, "scale": "K"}])[0]
        self.assertEqual((ev["impact"], ev["time_th"], ev["forecast"], ev["day_key"]), ("High", "19:30", "150K", "2026-09-28"))
        news._news_cache.update(events=[ev], fetched_at="x", ts=0)
        orig = news.httpx.get
        news.httpx.get = lambda *a, **k: (_ for _ in ()).throw(OSError("offline"))
        try:
            r = news.get_news()
        finally:
            news.httpx.get = orig
        self.assertTrue(r["stale"])
        self.assertEqual(r["events"][0]["title"], "Non Farm Payrolls")


class AlertsAPI(unittest.TestCase):
    def setUp(self):
        import gateway
        gateway.TRUSTED_PROXIES.add("testclient")    # TestClient ต่อมาจาก host ชื่อนี้ (จริง = 127.0.0.1)
        tmp = tempfile.mkdtemp()
        os.environ.update(WT_PASS_HASH=hash_password("pw-123456789"), WT_ORIGIN=ORIGIN, WT_COOKIE_SECURE="1",
                          WT_DB=os.path.join(tmp, "a.db"), WT_WORKER_KEY=KEY,
                          WT_ACCOUNTS=str(HERE.parent / "accounts.json"))
        self.c = TestClient(gateway.create_app(), base_url=ORIGIN)

    def tearDown(self):
        import gateway
        gateway.TRUSTED_PROXIES.discard("testclient")

    def test_internal_requires_key_and_no_proxy(self):
        self.assertEqual(self.c.get("/internal/alerts/config").status_code, 403)
        self.assertEqual(self.c.get("/internal/alerts/config", headers={"X-Worker-Key": "x" * 32}).status_code, 403)
        self.assertEqual(self.c.get("/internal/alerts/config", headers={"X-Worker-Key": KEY, "X-Forwarded-For": "1.2.3.4"}).status_code, 403)
        self.assertEqual(self.c.get("/internal/alerts/config", headers={"X-Worker-Key": KEY}).status_code, 200)

    def test_flow(self):
        wk = {"X-Worker-Key": KEY}
        self.c.post("/api/auth/login", json={"password": "pw-123456789"}, headers=H)
        self.assertFalse(self.c.get("/api/alerts/status").json()["service_alive"])
        rule = {"id": "r1", "on": True, "acct": "demo", "symbol": "BTCUSDm", "tf": "M5", "indicator": "vp_order_blocks", "event": "new_bull"}
        self.c.put("/api/prefs/wt.alerts", json={"value": [rule]}, headers=H)
        self.c.post("/api/alerts/test", headers=H)
        conf = self.c.get("/internal/alerts/config", headers=wk).json()
        self.assertEqual((conf["rules"], conf["accounts"]["demo"]), ([rule], 8101))
        self.assertIsNotNone(conf["test_at"])
        self.c.post("/internal/alerts/fired", json={"rule_id": "test", "text": "t", "ok": True}, headers=wk)
        self.c.post("/internal/alerts/fired", json={"rule_id": "r1", "text": "🔔 x", "ok": False, "error": "chat not found"}, headers=wk)
        self.assertIsNone(self.c.get("/internal/alerts/config", headers=wk).json()["test_at"])
        st = self.c.get("/api/alerts/status").json()
        self.assertTrue(st["service_alive"])
        self.assertEqual([(x["rule_id"], x["ok"], x["error"]) for x in st["log"]], [("r1", False, "chat not found"), ("test", True, None)])
