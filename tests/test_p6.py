"""P6: จุดทุน (BE) ปุ่มเดียว + Auto BE, ความเสี่ยงต่อไม้, สรุปวันนี้, deal ปิดไม้, alert เส้นราคา, สถานะระบบ"""
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
import MetaTrader5 as mt5  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import autobe  # noqa: E402
import worker  # noqa: E402
from auth import hash_password  # noqa: E402
from trading import autobe_target, be_target, sl_at_or_past  # noqa: E402

KEY = "k" * 32
WH = {"X-Worker-Key": KEY}
ORIGIN = "https://terminal.example.com"
PASSWORD = "correct horse battery"
RR = {"mode": "rr", "rr": 1.0, "lock_points": 0}


class Pure(unittest.TestCase):
    def test_be_target(self):
        self.assertAlmostEqual(be_target("buy", 2640, 0.01, 20), 2640.2)
        self.assertAlmostEqual(be_target("sell", 2640, 0.01, 20), 2639.8)
        self.assertTrue(sl_at_or_past("buy", 2640.0, 2640.0, 0.01))
        self.assertTrue(sl_at_or_past("sell", 2639.0, 2640.0, 0.01))
        self.assertFalse(sl_at_or_past("buy", 0, 2640.0, 0.01))
        self.assertFalse(sl_at_or_past("buy", 2630, 2640.0, 0.01))

    def test_autobe_rr(self):
        # buy 2640 SL 2630 (R = 10) -> ต้องได้กำไร (bid) ≥ 2650
        self.assertIsNone(autobe_target(RR, "buy", 2640, 2630, 2649.99, 2650.2, 0.01))
        self.assertEqual(autobe_target(RR, "buy", 2640, 2630, 2650.0, 2650.2, 0.01), 2640)
        # sell ใช้ ask
        self.assertIsNone(autobe_target(RR, "sell", 2640, 2650, 2629.8, 2630.01, 0.01))
        self.assertEqual(autobe_target(RR, "sell", 2640, 2650, 2629.8, 2630.0, 0.01), 2640)
        # ไม่มี SL / SL อยู่ทุนแล้ว / SL ฝั่งกำไรแล้ว = ไม่ทำ
        self.assertIsNone(autobe_target(RR, "buy", 2640, 0, 2700, 2700.2, 0.01))
        self.assertIsNone(autobe_target(RR, "buy", 2640, 2640, 2700, 2700.2, 0.01))
        self.assertIsNone(autobe_target(RR, "buy", 2640, 2645, 2700, 2700.2, 0.01))
        # 2R + ล็อก 50 จุด
        cfg = {"mode": "rr", "rr": 2, "lock_points": 50}
        self.assertIsNone(autobe_target(cfg, "buy", 2640, 2630, 2659, 2659.2, 0.01))
        self.assertAlmostEqual(autobe_target(cfg, "buy", 2640, 2630, 2660, 2660.2, 0.01), 2640.5)

    def test_autobe_points(self):
        cfg = {"mode": "points", "points": 300, "lock_points": 0}
        self.assertIsNone(autobe_target(cfg, "buy", 2640, 0, 2642.99, 2643.2, 0.01))
        self.assertEqual(autobe_target(cfg, "buy", 2640, 0, 2643.0, 2643.2, 0.01), 2640)   # ไม่มี SL ก็ได้
        self.assertEqual(autobe_target(cfg, "sell", 2640, 2660, 2636.8, 2637.0, 0.01), 2640)
        # lock ไกลกว่าราคาปัจจุบัน -> ตั้งไม่ได้ ไม่ยิง
        self.assertIsNone(autobe_target({**cfg, "lock_points": 400}, "buy", 2640, 0, 2643.5, 2643.7, 0.01))

    def test_validate(self):
        c = autobe.validate({"on": 1, "mode": "points", "points": "250", "symbols": "XAUUSD, BTCUSD",
                             "per_symbol": {"BTCUSD": {"points": 5000, "lock_points": ""}}})
        self.assertEqual((c["on"], c["points"], c["symbols"]), (True, 250.0, ["BTCUSD", "XAUUSD"]))
        self.assertEqual(c["per_symbol"], {"BTCUSD": {"points": 5000.0}})
        self.assertEqual(autobe.for_symbol(c, "BTCUSD")["points"], 5000.0)
        self.assertIsNone(autobe.for_symbol(c, "EURUSD"))
        c2 = autobe.validate({"symbols": "BTCUSDc", "per_symbol": {"XAUUSDc": {"lock_points": 100}}})
        self.assertEqual(autobe.for_symbol(c2, "XAUUSDc")["lock_points"], 100.0)   # ตั้งรายตัว = รวมอยู่ในรายการ
        for bad in ({"mode": "x"}, {"rr": 0}, {"rr": "abc"}, {"points": -1}, {"lock_points": -5}):
            with self.assertRaises(ValueError):
                autobe.validate(bad)


class WorkerP6(unittest.TestCase):
    def setUp(self):
        mt5.reset()
        self.tmp = tempfile.mkdtemp()
        os.environ["WT_AUDIT_DIR"] = self.tmp
        self.app = worker.create_app("demo", KEY, start_poller=False)
        self.poller = self.app.state.poller
        self.c = TestClient(self.app)

    def post(self, path, body):
        return self.c.post(path, json=body, headers=WH)

    def sent(self):
        return mt5.state.get("sent", [])

    def test_breakeven_endpoint(self):
        # bid 2650.10: buy 2640 เลยทุนแล้ว, buy 2655 ยังไม่เลย, sell ที่ทุนแล้ว
        mt5.state["positions"] = [mt5.Pos(1, "XAUUSD", 0, 0.05, 2640, 2650, 2630, 2680, 5, 0, 0, "", 0),
                                  mt5.Pos(2, "XAUUSD", 0, 0.05, 2655, 2650, 0, 0, -2, 0, 0, "", 0),
                                  mt5.Pos(3, "XAUUSD", 1, 0.05, 2660, 2650, 2660, 0, 5, 0, 0, "", 0)]
        r = self.post("/trade/position/breakeven", {"ticket": 1, "lock_points": 20}).json()
        self.assertTrue(r["ok"], r)
        self.assertEqual({k: self.sent()[-1][k] for k in ("action", "position", "sl", "tp")},
                         {"action": 6, "position": 1, "sl": 2640.2, "tp": 2680})
        r = self.post("/trade/position/breakeven", {"ticket": 2}).json()
        self.assertFalse(r["ok"])
        self.assertIn("ยังไม่เลยจุดทุน", r["message"])
        n = len(self.sent())
        r = self.post("/trade/position/breakeven", {"symbol": "XAUUSD"}).json()
        self.assertEqual(len(r["results"]), 3)
        self.assertEqual(len(self.sent()), n + 1)          # ยิงจริงแค่ไม้ 1 (ไม้ 3 ทุนแล้ว, ไม้ 2 ไม่ได้)
        self.assertIn("1/3", r["message"])
        mt5.state["trade_mode"] = 2                           # REAL ไม่ allow -> ไม่ยิง
        self.assertIn("allow_real", self.post("/trade/position/breakeven", {"ticket": 1}).json()["message"])

    def test_autobe_config_and_run(self):
        self.assertFalse(self.c.get("/autobe", headers=WH).json()["on"])
        self.assertEqual(self.post("/autobe", {"mode": "nope"}).status_code, 400)
        cfg = self.post("/autobe", {"on": True, "mode": "rr", "rr": 1}).json()
        self.assertTrue(cfg["on"])
        self.assertTrue((Path(self.tmp) / "autobe_demo.json").exists())
        # ยังไม่ถึง 1R: buy 2645 SL 2635, bid 2650.10 (กำไร 5.1 < 10)
        mt5.state["positions"] = [mt5.Pos(5, "XAUUSD", 0, 0.05, 2645, 2650, 2635, 0, 5, 0, 0, "", 0)]
        self.poller.poll_once(1.0, True, False)
        self.assertEqual(self.sent(), [])
        # ถึง 1R
        mt5.state["ticks"]["XAUUSD"] = mt5.Tick(2655.0, 2655.2, 2)
        self.poller.poll_once(2.0, True, False)
        self.assertEqual({k: self.sent()[-1][k] for k in ("action", "position", "sl")}, {"action": 6, "position": 5, "sl": 2645})
        ev = self.c.get("/autobe_events", headers=WH).json()
        self.assertEqual((ev["events"][-1]["ticket"], ev["events"][-1]["ok"]), (5, True))
        self.assertEqual(self.c.get("/autobe_events", params={"after": ev["events"][-1]["seq"]}, headers=WH).json()["events"], [])
        # โบรกปฏิเสธ -> รอ 60 วินาทีก่อนลองใหม่ (ไม่ยิงรัว)
        mt5.state["sent"] = []
        mt5.state["next_retcode"] = 10006
        mt5.state["positions"] = [mt5.Pos(6, "XAUUSD", 0, 0.05, 2645, 2655, 2635, 0, 5, 0, 0, "", 0)]
        self.poller.poll_once(3.0, True, False)
        self.poller.poll_once(4.0, True, False)
        self.assertEqual(len(self.sent()), 1)
        # บัญชีเทรดไม่ได้ -> ไม่ทำอะไรเลย
        mt5.state["sent"] = []
        mt5.state["trade_mode"] = 2
        mt5.state["positions"] = [mt5.Pos(7, "XAUUSD", 0, 0.05, 2645, 2655, 2635, 0, 5, 0, 0, "", 0)]
        self.poller.poll_once(5.0, True, False)
        self.assertEqual(self.sent(), [])

    def test_timeout_marked_uncertain(self):
        # 10012 = โบรกไม่ตอบ: server อาจ fill ทีหลัง -> ต้องบอกหน้าเว็บว่า "ไม่รู้ผล" ไม่ใช่ล้มเหลวเฉยๆ
        mt5.state["next_retcode"] = 10012
        r = self.post("/trade/order", {"symbol": "XAUUSD", "side": "buy", "kind": "market", "volume": 0.01}).json()
        self.assertFalse(r["ok"])
        self.assertTrue(r["uncertain"])
        self.assertIn("ก่อนส่งซ้ำ", r["message"])
        mt5.state["next_retcode"] = 10006
        self.assertNotIn("uncertain", self.post("/trade/order", {"symbol": "XAUUSD", "side": "buy", "kind": "market", "volume": 0.01}).json())

    def test_risk_and_day(self):
        mt5.state["positions"] = [mt5.Pos(1, "XAUUSD", 0, 0.05, 2640, 2650, 2630, 0, 5, 0, 0, "", 0),
                                  mt5.Pos(2, "XAUUSD", 1, 0.10, 2660, 2650, 0, 0, 5, 0, 0, "", 0)]
        mt5.state["deals"] = [mt5.Deal(0, 12.5, -0.7, 0, 0), mt5.Deal(1, -3.0, -0.7, 0, 0), mt5.Deal(2, 500, 0, 0, 0)]
        self.poller.poll_once(1.0, True, False)
        pos = {p["ticket"]: p for p in self.poller.snapshot["positions"]}
        self.assertEqual(pos[1]["risk"], -50.0)            # (2630-2640) × 100 × 0.05
        self.assertIsNone(pos[2]["risk"])
        day = self.poller.snapshot["day"]
        self.assertEqual((day["realized"], day["closed"], day["start_balance"]), (8.1, 2, 991.9))
        self.assertEqual(day["reset"], "00:00 Asia/Bangkok")

    def test_deals_feed(self):
        D = mt5.FullDeal
        now = int(__import__("time").time())
        ins = D(1, (now - 600) * 1000, 0, 0, 77, "XAUUSD", 0, 0.1, 2640.0, 0, -0.35, 0, 0, "")
        out = D(2, (now - 60) * 1000, 1, 1, 77, "XAUUSD", 0, 0.1, 2650.0, 100.0, -0.35, -1.0, 0, "[tp 2650]")
        mt5.state["deals"] = [ins, out]
        mt5.state["all_deals"] = [ins, out]
        r = self.c.get("/deals", params={"frm": now - 300}, headers=WH).json()
        self.assertEqual(len(r["deals"]), 1)
        d = r["deals"][0]
        self.assertEqual((d["side"], d["open"], d["price"], d["net"], d["position_id"]), ("buy", 2640.0, 2650.0, 98.65, 77))


class GatewayP6(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        tmp = tempfile.mkdtemp()
        acc = Path(tmp) / "accounts.json"
        acc.write_text(json.dumps({"accounts": [
            {"name": "demo", "kind": "std", "terminal_path": "x", "port": 18299}]}))
        os.environ.update(WT_PASS_HASH=hash_password(PASSWORD), WT_ORIGIN=ORIGIN, WT_COOKIE_SECURE="1",
                          WT_DB=os.path.join(tmp, "g.db"), WT_WORKER_KEY=KEY, WT_ACCOUNTS=str(acc))
        import gateway
        gateway.TRUSTED_PROXIES.add("testclient")    # TestClient ต่อมาจาก host ชื่อนี้ (จริง = 127.0.0.1)
        cls.gapp = gateway.create_app()

    def client(self):
        c = TestClient(self.gapp, base_url=ORIGIN)
        assert c.post("/api/auth/login", json={"password": PASSWORD}, headers={"X-Requested-With": "wt"}).status_code == 200
        return c

    def test_palerts_crud_and_fire(self):
        c = self.client()
        H = {"X-Requested-With": "wt"}
        self.assertEqual(c.post("/api/palerts", json={"acct": "nope", "symbol": "XAUUSD", "level": 1, "dir": "up"}, headers=H).status_code, 400)
        self.assertEqual(c.post("/api/palerts", json={"acct": "demo", "symbol": "XAUUSD", "level": -1, "dir": "up"}, headers=H).status_code, 400)
        a = c.post("/api/palerts", json={"acct": "demo", "symbol": "XAUUSD", "level": 2700.5, "dir": "up"}, headers=H).json()
        self.assertTrue(a["on"])
        u = c.put(f"/api/palerts/{a['id']}", json={"level": 2710, "dir": "up"}, headers=H).json()
        self.assertEqual(u["level"], 2710.0)
        # client เขียนทับ key นี้ผ่าน prefs ไม่ได้
        self.assertEqual(c.put("/api/prefs/wt.palerts", json={"value": []}, headers=H).status_code, 400)
        # ตัวส่งเห็นใน config แล้วแจ้งว่ายิงแล้ว -> ปิดเอง
        ic = TestClient(self.gapp, base_url=ORIGIN)
        ih = {"X-Worker-Key": KEY}
        conf = ic.get("/internal/alerts/config", params={"telegram": 1}, headers=ih).json()
        self.assertEqual([x["id"] for x in conf["palerts"]], [a["id"]])
        self.assertTrue(conf["notify"]["close"])
        ic.post("/internal/alerts/palert_fired", json={"id": a["id"], "price": 2710.2}, headers=ih)
        self.assertEqual(ic.get("/internal/alerts/config", headers=ih).json()["palerts"], [])
        got = c.get("/api/palerts").json()
        self.assertEqual((got[0]["on"], got[0]["fired_price"]), (False, 2710.2))
        # เปิดใหม่ = ล้างสถานะยิงแล้ว
        self.assertNotIn("fired_at", c.put(f"/api/palerts/{a['id']}", json={"on": True}, headers=H).json())
        c.delete(f"/api/palerts/{a['id']}", headers=H)
        self.assertEqual(c.get("/api/palerts").json(), [])

    def test_palert_line_and_box(self):
        c = self.client()
        H = {"X-Requested-With": "wt"}
        line = {"acct": "demo", "symbol": "XAUUSD", "kind": "line", "dir": "up", "ext": "right",
                "p1": {"t": 1_790_000_000, "v": 2600}, "p2": {"t": 1_790_003_600, "v": 2610}}
        a = c.post("/api/palerts", json=line, headers=H).json()
        self.assertEqual((a["kind"], a["ext"], a["p2"]["v"]), ("line", "right", 2610.0))
        bad = {**line, "p2": {"t": 1_790_000_000, "v": 2610}}
        self.assertEqual(c.post("/api/palerts", json=bad, headers=H).status_code, 400)     # แนวตั้ง
        box = {"acct": "demo", "symbol": "XAUUSD", "kind": "box", "dir": "enter", "top": 2650, "bottom": 2640}
        self.assertEqual(c.post("/api/palerts", json=box, headers=H).json()["kind"], "box")
        self.assertEqual(c.post("/api/palerts", json={**box, "top": 2630}, headers=H).status_code, 400)
        self.assertEqual(c.post("/api/palerts", json={**box, "dir": "up"}, headers=H).status_code, 400)
        for x in c.get("/api/palerts").json():
            c.delete(f"/api/palerts/{x['id']}", headers=H)

    def test_health(self):
        c = self.client()
        h = c.get("/api/health").json()
        self.assertEqual(h["accounts"][0]["name"], "demo")
        self.assertFalse(h["accounts"][0]["worker"])          # ไม่มี worker ที่ port นี้
        self.assertIn("alive", h["alerts"])
        self.assertEqual(self.client().get("/api/health").status_code, 200)
        self.assertEqual(TestClient(self.gapp, base_url=ORIGIN).get("/api/health").status_code, 401)


if __name__ == "__main__":
    unittest.main()
