"""P7: ปิดหลายไม้ตามเงื่อนไข, pending หมดอายุ + OCO (worker ดูแลเอง), เหตุการณ์คำสั่งไม่รู้ผล, ตั้งค่าส่งให้ตัวแจ้งเตือน"""
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
from pending_rules import PendingRules  # noqa: E402
from trading import close_filter  # noqa: E402

KEY = "k" * 32
WH = {"X-Worker-Key": KEY}


def pos(ticket, typ=0, profit=0.0, swap=0.0, sym="XAUUSD"):
    return mt5.Pos(ticket, sym, typ, 0.01, 2650, 2650, 0, 0, profit, swap, 0, "", 0)


class Pure(unittest.TestCase):
    def test_close_filter(self):
        a, b, c = pos(1, 0, 5), pos(2, 1, -3), pos(3, 0, 1, -2, "EURUSD")
        pick = lambda **k: [p.ticket for p in (a, b, c) if close_filter(p, k.get("symbol"), k.get("which", "all"), k.get("side"))]
        self.assertEqual(pick(), [1, 2, 3])
        self.assertEqual(pick(which="profit"), [1])
        self.assertEqual(pick(which="loss"), [2, 3])          # กำไร 1 + swap -2 = ขาดทุน
        self.assertEqual(pick(symbol="XAUUSD", side="buy"), [1])

    def test_rules_store(self):
        d = tempfile.mkdtemp()
        r = PendingRules(Path(d) / "p.json")
        r.link(10, 11)
        r.link(10, 12)                                        # ตัวหนึ่งอยู่ได้คู่เดียว
        self.assertEqual(r.get()["oco"], [[10, 12]])
        r.set_expire(20, 1000.0)
        self.assertEqual(PendingRules(Path(d) / "p.json").get(), {"oco": [[10, 12]], "expire": {"20": 1000.0}})
        with self.assertRaises(ValueError):
            r.link(5, 5)
        # expire ถึงเวลา
        self.assertEqual(r.due({10, 12, 20}, lambda t: None, now=999.0), [])
        jobs = r.due({10, 12, 20}, lambda t: None, now=1000.0)
        self.assertEqual(jobs, [{"cancel": 20, "why": "expire", "at": 1000.0}])
        r.done(jobs[0], False, now=1000.0)                    # ยกเลิกไม่สำเร็จ -> รอ 30 วิ
        self.assertEqual(r.due({10, 12, 20}, lambda t: None, now=1010.0), [])
        self.assertEqual(len(r.due({10, 12, 20}, lambda t: None, now=1031.0)), 1)
        # OCO: 10 fill -> ยกเลิก 12
        jobs = r.due({12}, lambda t: t == 10, now=2000.0)
        self.assertEqual(jobs, [{"cancel": 12, "why": "oco", "filled": 10}])
        r.done(jobs[0], True)
        self.assertEqual(r.get()["oco"], [])
        # OCO: ตัวหนึ่งถูกยกเลิกเอง -> เลิกคู่ ไม่ยุ่งอีกตัว
        r.link(30, 31)
        self.assertEqual(r.due({31}, lambda t: False, now=3000.0), [])
        self.assertEqual(r.get()["oco"], [])
        # ยังไม่รู้ว่า fill ไหม -> รอ history ได้ 30 วิ แล้วถือว่ายกเลิก
        r.link(40, 41)
        self.assertEqual(r.due({41}, lambda t: None, now=4000.0), [])
        self.assertEqual(r.get()["oco"], [[40, 41]])
        self.assertEqual(r.due({41}, lambda t: None, now=4031.0), [])
        self.assertEqual(r.get()["oco"], [])


class WorkerP7(unittest.TestCase):
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

    def events(self):
        return self.c.get("/autobe_events", headers=WH).json()["events"]

    def test_close_all_which(self):
        mt5.state["positions"] = [pos(1, 0, 5), pos(2, 1, -3)]
        r = self.post("/trade/positions/close_all", {"which": "loss"}).json()
        self.assertEqual([x["ticket"] for x in r["results"]], [2])
        self.assertEqual(self.sent()[-1]["position"], 2)
        self.assertIn("ไม่มีไม้", self.post("/trade/positions/close_all", {"which": "profit", "side": "sell"}).json()["message"])
        self.assertFalse(self.post("/trade/positions/close_all", {"which": "x"}).json()["ok"])

    def test_expire_and_oco(self):
        mt5.state["orders"] = [mt5.Ord(100, "XAUUSD", 4, 0.01, 2660, 0, 0, 0, "", 0), mt5.Ord(101, "XAUUSD", 5, 0.01, 2640, 0, 0, 0, "", 0)]
        self.assertEqual(self.post("/prules", {"op": "expire", "ticket": 100, "ts": 1}).status_code, 400)   # อดีต
        self.assertEqual(self.post("/prules", {"op": "link", "a": 100, "b": 999}).status_code, 400)
        self.assertEqual(self.post("/prules", {"op": "link", "a": 100, "b": 101}).json()["oco"], [[100, 101]])
        self.poller.poll_once(1.0, True, False)
        orders = self.poller.snapshot["orders"]
        self.assertEqual([o.get("oco") for o in orders], [101, 100])
        # 100 fill -> position ใหม่ -> worker ยกเลิก 101
        mt5.state["orders"] = [mt5.Ord(101, "XAUUSD", 5, 0.01, 2640, 0, 0, 0, "", 0)]
        mt5.state["positions"] = [pos(100)]
        self.poller.poll_once(2.0, True, False)
        self.assertEqual({k: self.sent()[-1][k] for k in ("action", "order")}, {"action": 8, "order": 101})
        ev = self.events()[-1]
        self.assertEqual((ev["kind"], ev["ticket"], ev["filled"], ev["ok"]), ("oco", 101, 100, True))
        self.assertEqual(self.c.get("/prules", headers=WH).json()["oco"], [])

    def test_new_pending_with_rules_and_uncertain_event(self):
        import time
        mt5.state["orders"] = [mt5.Ord(1234, "XAUUSD", 2, 0.01, 2600, 0, 0, 0, "", 0), mt5.Ord(77, "XAUUSD", 5, 0.01, 2600, 0, 0, 0, "", 0)]
        r = self.post("/trade/order", {"symbol": "XAUUSD", "side": "buy", "kind": "limit", "price": 2600, "volume": 0.01,
                                       "expire_ts": time.time() + 3600, "oco_with": 77}).json()
        self.assertTrue(r["ok"], r)
        got = self.c.get("/prules", headers=WH).json()
        self.assertEqual((got["oco"], list(got["expire"])), ([[1234, 77]], ["1234"]))
        mt5.state["next_retcode"] = 10012
        self.post("/trade/order", {"symbol": "XAUUSD", "side": "buy", "kind": "market", "volume": 0.01})
        self.assertEqual(self.events()[-1]["kind"], "uncertain")


class ReplayRange(unittest.TestCase):
    def setUp(self):
        mt5.reset()
        os.environ["WT_AUDIT_DIR"] = tempfile.mkdtemp()
        self.c = TestClient(worker.create_app("demo", KEY, start_poller=False))

    def test_rates_range(self):
        mt5.state["m1_hist"] = [{"time": 1000 + 60 * i, "open": 1, "high": 2, "low": 0.5, "close": 1.5, "tick_volume": 3} for i in range(10)]
        r = self.c.get("/rates_range", params={"symbol": "XAUUSD", "tf": "M1", "frm": 1060, "to": 1240}, headers=WH)
        self.assertEqual([x[0] for x in r.json()], [1060, 1120, 1180, 1240])
        self.assertEqual(self.c.get("/rates_range", params={"symbol": "XAUUSD", "tf": "M1", "frm": 0, "to": 60 * 70000}, headers=WH).status_code, 400)
        self.assertEqual(self.c.get("/rates_range", params={"symbol": "XAUUSD", "tf": "M1", "frm": 10, "to": 5}, headers=WH).status_code, 400)

    def test_rates_waits_for_history_sync(self):
        # MT5 ส่งประวัติเก่าก่อน (แท่งล่าสุดห่าง tick 5 ชม.) แล้วค่อยครบ -> /rates รอจนได้ชุดที่ต่อถึงปัจจุบัน
        from collections import namedtuple
        T = namedtuple("T", "bid ask time_msc time")
        now = 1_800_000_000
        mt5.state["ticks"]["XAUUSD"] = T(2650.1, 2650.3, now * 1000, now)
        calls = []
        def rates(s, tf, start, n):
            calls.append(1)
            end = now - 5 * 3600 if len(calls) < 3 else now
            return [{"time": end - 300 * (n - 1 - i), "open": 1, "high": 2, "low": 0.5, "close": 1.5, "tick_volume": 3} for i in range(n)]
        old_fn, old_wait = mt5.copy_rates_from_pos, worker.RATES_SYNC_WAIT
        mt5.copy_rates_from_pos, worker.RATES_SYNC_WAIT = rates, 0
        try:
            r = self.c.get("/rates", params={"symbol": "XAUUSD", "tf": "M5", "count": 5}, headers=WH).json()
            self.assertEqual((len(calls), r[-1][0]), (3, now))
            calls.clear()
            mt5.state["ticks"]["XAUUSD"] = T(2650.1, 2650.3, 0, now + 10 * 3600)   # ยังไม่ครบตลอด -> เลิกรอแล้วส่งที่มี
            r = self.c.get("/rates", params={"symbol": "XAUUSD", "tf": "M5", "count": 5}, headers=WH).json()
            self.assertEqual(len(calls), worker.RATES_SYNC_TRIES)
            self.assertEqual(len(r), 5)
        finally:
            mt5.copy_rates_from_pos, worker.RATES_SYNC_WAIT = old_fn, old_wait


if __name__ == "__main__":
    unittest.main()
