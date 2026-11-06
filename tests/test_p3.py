"""P3: ระบบเทรด — validation, lot จาก risk, guards, fail-closed, audit, dedupe, gateway proxy"""
import json
import os
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))
os.environ["WT_NO_AUTOAPP"] = "1"

import fake_mt5  # noqa: E402,F401
import MetaTrader5 as mt5  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import trading  # noqa: E402
import worker  # noqa: E402
from trading import TradeError, check_levels, check_pending_price, check_volume, day_start_utc, lot_from_risk  # noqa: E402

KEY = "k" * 32
WH = {"X-Worker-Key": KEY}


class Pure(unittest.TestCase):
    def test_volume(self):
        self.assertEqual(check_volume(0.03, 0.01, 100, 0.01), 0.03)
        for bad in (0, -1, 0.005, 0.015, 101, float("nan")):
            with self.assertRaises(TradeError):
                check_volume(bad, 0.01, 100, 0.01)

    def test_levels(self):
        check_levels("buy", 100, 99, 101)
        check_levels("sell", 100, 101, 99)
        check_levels("buy", 100, 0, 0)
        for side, sl, tp in (("buy", 101, 0), ("buy", 0, 99), ("sell", 99, 0), ("sell", 0, 101), ("buy", 100, 0)):
            with self.assertRaises(TradeError):
                check_levels(side, 100, sl, tp)

    def test_pending(self):
        check_pending_price("buy", "limit", 99, 100, 100.2)
        check_pending_price("sell", "stop", 99, 100, 100.2)
        check_pending_price("buy", "stop_limit", 101, 100, 100.2, 100.5)
        for args in (("buy", "limit", 101, 100, 100.2), ("sell", "limit", 99, 100, 100.2),
                     ("buy", "stop", 100, 100, 100.2), ("buy", "stop_limit", 101, 100, 100.2, 101.5),
                     ("sell", "stop_limit", 99, 100, 100.2, 98), ("buy", "limit", 0, 100, 100.2)):
            with self.assertRaises(TradeError):
                check_pending_price(*args)

    def test_lot_from_risk(self):
        self.assertEqual(lot_from_risk(100, 1000, 0.01, 100, 0.01), 0.1)
        self.assertEqual(lot_from_risk(105, 1000, 0.01, 100, 0.01), 0.1)      # ปัดลง ไม่ปัดขึ้น
        self.assertEqual(lot_from_risk(1e9, 1000, 0.01, 100, 0.01), 100)
        with self.assertRaises(TradeError):
            lot_from_risk(5, 1000, 0.01, 100, 0.01)                             # ต่ำกว่า min -> ไม่ยิง min เงียบๆ
        with self.assertRaises(TradeError):
            lot_from_risk(100, 0, 0.01, 100, 0.01)                              # tick_value 0

    def test_day_start(self):
        now = datetime(2026, 9, 28, 20, 0, tzinfo=timezone.utc)                # 16:00 NY (EDT)
        self.assertEqual(day_start_utc(now, "16:59 America/New_York"), datetime(2026, 9, 27, 20, 59, tzinfo=timezone.utc))
        now = datetime(2026, 9, 28, 21, 30, tzinfo=timezone.utc)
        self.assertEqual(day_start_utc(now, "16:59 America/New_York"), datetime(2026, 9, 28, 20, 59, tzinfo=timezone.utc))


class WorkerTrading(unittest.TestCase):
    def setUp(self):
        mt5.reset()
        self.tmp = tempfile.mkdtemp()
        os.environ["WT_AUDIT_DIR"] = self.tmp
        self.app = worker.create_app("demo", KEY, start_poller=False)
        self.tr = self.app.state.trader
        self.c = TestClient(self.app)

    def post(self, path, body):
        return self.c.post(f"/trade/{path}", json=body, headers=WH).json()

    def sent(self):
        return mt5.state.get("sent", [])

    def test_market_buy_request(self):
        r = self.post("order", {"symbol": "XAUUSD", "side": "buy", "kind": "market", "volume": 0.02,
                                "sl": 2640.004, "tp": 2670, "client_id": "a1"})
        self.assertTrue(r["ok"], r)
        req = self.sent()[-1]
        self.assertEqual((req["action"], req["type"], req["volume"], req["price"]), (1, 0, 0.02, 2650.36))
        self.assertEqual(req["sl"], 2640.0)                       # normalize ตาม tick size
        self.assertEqual(req["type_filling"], mt5.ORDER_FILLING_FOK)
        self.assertEqual(r["risk_money"], round((2650.36 - 2640.0) * 100 * 0.02, 2))

    def test_dedupe_same_client_id(self):
        body = {"symbol": "XAUUSD", "side": "buy", "kind": "market", "volume": 0.01, "client_id": "same"}
        self.post("order", body)
        r2 = self.post("order", body)
        self.assertTrue(r2.get("duplicate"))
        self.assertEqual(len(self.sent()), 1)

    def test_pending_and_stop_limit(self):
        self.assertTrue(self.post("order", {"symbol": "XAUUSD", "side": "sell", "kind": "limit", "volume": 0.01,
                                            "price": 2660, "sl": 2670})["ok"])
        req = self.sent()[-1]
        self.assertEqual((req["action"], req["type"], req["type_filling"]), (5, 3, mt5.ORDER_FILLING_RETURN))
        self.assertTrue(self.post("order", {"symbol": "XAUUSD", "side": "buy", "kind": "stop_limit", "volume": 0.01,
                                            "price": 2660, "stoplimit": 2655, "sl": 2645})["ok"])
        self.assertEqual((self.sent()[-1]["type"], self.sent()[-1]["stoplimit"]), (6, 2655))

    def test_rejections_never_reach_mt5(self):
        cases = [
            {"symbol": "XAUUSD", "side": "buy", "kind": "market", "volume": 0.015},
            {"symbol": "XAUUSD", "side": "buy", "kind": "market", "volume": 6},             # max_lot 5
            {"symbol": "XAUUSD", "side": "buy", "kind": "market", "volume": 0.01, "sl": 2660},
            {"symbol": "XAUUSD", "side": "buy", "kind": "limit", "volume": 0.01, "price": 2700},
            {"symbol": "XAUUSD", "side": "up", "kind": "market", "volume": 0.01},
            {"symbol": "NOPE", "side": "buy", "kind": "market", "volume": 0.01},
            {"symbol": "XAUUSD", "side": "buy", "kind": "market", "risk_pct": 1},            # risk% ไม่มี SL
            {"symbol": "XAUUSD", "side": "buy", "kind": "market"},
        ]
        for body in cases:
            r = self.post("order", body)
            self.assertFalse(r["ok"], body)
            self.assertEqual(r.get("rejected_by"), "web", body)
        self.assertEqual(self.sent(), [])

    def test_trading_disabled_fail_closed(self):
        self.tr.account = {**self.tr.account, "trading": False}
        r = self.post("order", {"symbol": "XAUUSD", "side": "buy", "kind": "market", "volume": 0.01})
        self.assertFalse(r["ok"])
        self.assertIn("trading: false", r["message"])
        self.assertEqual(self.sent(), [])

    def test_real_account_needs_allow_real(self):
        mt5.state["trade_mode"] = 2
        r = self.post("order", {"symbol": "XAUUSD", "side": "buy", "kind": "market", "volume": 0.01})
        self.assertIn("REAL", r["message"])
        self.tr.account = {**self.tr.account, "allow_real": True}
        self.assertTrue(self.post("order", {"symbol": "XAUUSD", "side": "buy", "kind": "market", "volume": 0.01})["ok"])

    def test_algo_trading_off(self):
        mt5.state["algo"] = False
        r = self.post("order", {"symbol": "XAUUSD", "side": "buy", "kind": "market", "volume": 0.01})
        self.assertIn("Algo Trading", r["message"])

    def test_broker_reject_reported(self):
        mt5.state["next_retcode"] = 10019
        r = self.post("order", {"symbol": "XAUUSD", "side": "buy", "kind": "market", "volume": 0.01})
        self.assertEqual((r["ok"], r["retcode"], r["message"]), (False, 10019, "margin ไม่พอ"))

    def test_risk_pct_lot(self):
        # balance 1000, risk 1% = 10$, SL 10.36 ห่าง -> loss/lot = 1036 -> 0.0096 -> < min 0.01 -> ปฏิเสธ
        r = self.post("order", {"symbol": "XAUUSD", "side": "buy", "kind": "market", "risk_pct": 1, "sl": 2640})
        self.assertFalse(r["ok"])
        mt5.state["balance"] = 100000
        r = self.post("order", {"symbol": "XAUUSD", "side": "buy", "kind": "market", "risk_pct": 1, "sl": 2640})
        self.assertTrue(r["ok"], r)
        self.assertEqual(self.sent()[-1]["volume"], 0.96)

    def test_tick_value_fallback(self):
        mt5.state["calc_profit_zero"] = True
        mt5.state["balance"] = 100000
        mt5.state["ticks"]["EURUSD"] = mt5.Tick(1.0850, 1.0851, 1)
        r = self.c.post("/calc", json={"symbol": "EURUSD", "side": "buy", "sl": 1.0800, "risk_pct": 1}, headers=WH).json()
        # tick_value 1 / tick_size 1e-5 * (1.0851-1.08) = 510 ต่อ lot -> 1000/510 = 1.96
        self.assertEqual(r["volume"], 1.96)

    def test_guards(self):
        self.tr.guards = {"max_positions": 1}
        mt5.state["positions"] = [mt5.Pos(1, "XAUUSD", 0, 0.01, 2650, 2650, 0, 0, 0, 0, 0, "", 0)]
        self.assertIn("max_positions", self.post("order", {"symbol": "XAUUSD", "side": "buy", "kind": "market", "volume": 0.01})["message"])
        self.tr.guards = {"require_sl": True}
        self.assertIn("SL", self.post("order", {"symbol": "XAUUSD", "side": "buy", "kind": "market", "volume": 0.01})["message"])
        self.tr.guards = {"max_risk_pct": 1}
        r = self.post("order", {"symbol": "XAUUSD", "side": "buy", "kind": "market", "volume": 0.02, "sl": 2640})
        self.assertIn("max_risk_pct", r["message"])                   # 20.72$ = 2.07% ของ 1000
        self.tr.guards = {"daily_loss_pct": 4, "day_reset": "16:59 America/New_York"}
        mt5.state["deals"] = [mt5.Deal(1, -30.0, 0, 0, 0)]              # วันนี้เสียไป 30 -> ต้นวัน 1030
        mt5.state["equity"] = 1000
        r = self.post("order", {"symbol": "XAUUSD", "side": "buy", "kind": "market", "volume": 0.01, "sl": 2640})
        self.assertTrue(r["ok"], r)                                    # 2.91% + 1.01% = 3.92% < 4%
        mt5.state["sent"] = []
        r = self.post("order", {"symbol": "XAUUSD", "side": "buy", "kind": "market", "volume": 0.02, "sl": 2640})
        self.assertIn("daily loss", r["message"])                     # 2.91% + 2.01% > 4%
        self.assertEqual(self.sent(), [])

    def test_modify_guards(self):
        # หลังเปิดไม้: ลบ SL / ขยาย SL เกิน max_risk_pct ไม่ได้ แต่ขยับเข้าใกล้ได้เสมอ
        mt5.state["positions"] = [mt5.Pos(7, "XAUUSD", 0, 0.02, 2650, 2650, 2645, 0, 0, 0, 0, "", 0)]   # เสี่ยง 10$ = 1%
        self.tr.guards = {"require_sl": True, "max_risk_pct": 1.5}
        mod = lambda sl: self.post("position/modify", {"ticket": 7, "sl": sl, "tp": 0})
        self.assertIn("ลบ SL ไม่ได้", mod(0)["message"])
        self.assertIn("max_risk_pct", mod(2640)["message"])            # 20$ = 2%
        self.assertEqual(self.sent(), [])
        self.assertTrue(mod(2643)["ok"])                               # 14$ = 1.4% ผ่าน
        self.tr.guards = {"max_risk_pct": 0.5}
        self.assertTrue(mod(2648)["ok"])                               # เกินลิมิตอยู่แล้ว แต่ขยับเข้าใกล้ = ได้
        mt5.state["orders"] = [mt5.Ord(9, "XAUUSD", 2, 0.02, 2640, 2635, 0, 0, "", 0)]   # buy limit เสี่ยง 10$
        self.tr.guards = {"max_risk_pct": 1.5}
        r = self.post("order/modify", {"ticket": 9, "price": 2640, "sl": 2625})
        self.assertIn("max_risk_pct", r["message"])                   # 30$ = 3%

    def test_position_actions(self):
        mt5.state["positions"] = [mt5.Pos(7, "XAUUSD", 0, 0.05, 2640, 2650, 2630, 2680, 5, 0, 0, "", 0)]
        self.assertTrue(self.post("position/modify", {"ticket": 7, "sl": 2645, "tp": 0})["ok"])
        self.assertEqual({k: self.sent()[-1][k] for k in ("action", "position", "sl", "tp")},
                         {"action": 6, "position": 7, "sl": 2645, "tp": 0})
        self.assertFalse(self.post("position/modify", {"ticket": 7, "sl": 2655})["ok"])   # SL เหนือ bid ของ buy
        self.assertTrue(self.post("position/close", {"ticket": 7, "volume": 0.02})["ok"])
        req = self.sent()[-1]
        self.assertEqual((req["type"], req["volume"], req["price"], req["position"]), (1, 0.02, 2650.10, 7))
        self.assertIn("ทวีคูณ", self.post("position/close", {"ticket": 7, "volume": 0.045})["message"])
        self.assertIn("เกินสูงสุด", self.post("position/close", {"ticket": 7, "volume": 0.06})["message"])
        self.assertIn("ไม่พบ position", self.post("position/close", {"ticket": 99})["message"])
        r = self.post("positions/close_all", {"symbol": "XAUUSD"})
        self.assertEqual(len(r["results"]), 1)

    def test_order_actions(self):
        mt5.state["orders"] = [mt5.Ord(9, "XAUUSD", 2, 0.01, 2640, 2630, 2660, 0, "", 0)]
        self.assertTrue(self.post("order/modify", {"ticket": 9, "price": 2641})["ok"])
        req = self.sent()[-1]
        self.assertEqual((req["action"], req["order"], req["price"], req["sl"], req["tp"]), (7, 9, 2641, 2630, 2660))
        self.assertTrue(self.post("order/cancel", {"ticket": 9})["ok"])
        self.assertEqual(self.sent()[-1], {"action": 8, "order": 9})
        self.assertEqual(self.post("orders/cancel_all", {})["message"], "ยกเลิก 1/1 รายการ")

    def test_audit_written(self):
        self.post("order", {"symbol": "XAUUSD", "side": "buy", "kind": "market", "volume": 0.01})
        self.post("order", {"symbol": "XAUUSD", "side": "buy", "kind": "market", "volume": 0.015})
        lines = (Path(self.tmp) / "audit_demo.jsonl").read_text(encoding="utf-8").strip().splitlines()
        self.assertEqual(len(lines), 2)
        self.assertEqual(json.loads(lines[0])["result"]["ok"], True)
        self.assertEqual(json.loads(lines[1])["result"]["ok"], False)

    def test_bad_input(self):
        self.assertEqual(self.c.post("/trade/nope", json={}, headers=WH).status_code, 404)
        self.assertEqual(self.c.post("/trade/order", content=b"x", headers=WH).status_code, 400)
        self.assertFalse(self.post("position/close", {})["ok"])
        self.assertEqual(self.c.post("/trade/order", json={}).status_code, 403)   # ไม่มี key


if __name__ == "__main__":
    unittest.main()
