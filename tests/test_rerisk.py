"""ปรับ risk pending: lot ใหม่จาก balance/เงินที่กำหนด, ลบ+วางใหม่ราคา/SL/TP เดิม, ข้ามใบที่เท่าเดิม/ไม่มี SL, คืนใบเดิมถ้าวางใหม่ไม่ผ่าน"""
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

import trading  # noqa: E402
from trading import TradeError, Trader  # noqa: E402

Ord = fake_mt5.Ord


def buy_limit(ticket, vol, price=2640.0, sl=2630.0, tp=2680.0):
    # XAUUSD fake: ขาดทุนต่อ lot = ระยะ * 100 -> SL ห่าง 10 = 1000/lot
    return Ord(ticket, "XAUUSD", 2, vol, price, sl, tp, 7, "web", 0)


class Rerisk(unittest.TestCase):
    def setUp(self):
        mt5.reset()
        mt5.state["balance"] = 20000.0
        self.t = Trader({"name": "t", "trading": True, "guards": {"max_positions": 2}}, 0, Path(tempfile.mkdtemp()))

    def sent(self):
        return mt5.state.get("sent", [])

    def test_dry_run_from_balance(self):
        mt5.state["orders"] = [buy_limit(1, 0.10), buy_limit(2, 0.20)]
        r = self.t.rerisk_orders({"risk_pct": 1, "dry_run": True})
        self.assertEqual(r["risk_money"], 200.0)
        rows = {x["ticket"]: x for x in r["results"]}
        self.assertEqual((rows[1]["old_risk"], rows[1]["new_volume"], rows[1]["same"]), (100.0, 0.2, False))
        self.assertTrue(rows[2]["same"])
        self.assertEqual(self.sent(), [])            # dry run ไม่ส่งอะไร

    def test_replace_keeps_levels_and_skips_same(self):
        mt5.state["orders"] = [buy_limit(1, 0.10), buy_limit(2, 0.20)]
        r = self.t.rerisk_orders({"risk_pct": 1})
        self.assertTrue(r["ok"], r)
        acts = [(s["action"], s.get("order"), s.get("volume")) for s in self.sent()]
        self.assertEqual(acts, [(8, 1, None), (5, None, 0.2)])       # ลบ #1 แล้ววางใหม่ 0.2, #2 ข้าม
        new = self.sent()[-1]
        self.assertEqual({k: new[k] for k in ("type", "price", "sl", "tp", "magic")},
                         {"type": 2, "price": 2640.0, "sl": 2630.0, "tp": 2680.0, "magic": 7})
        rows = {x["ticket"]: x for x in r["results"]}
        self.assertEqual(rows[1]["new_ticket"], 1234)
        self.assertTrue(rows[2]["skipped"])

    def test_fixed_money_and_selected_tickets(self):
        mt5.state["orders"] = [buy_limit(1, 0.10), buy_limit(2, 0.10)]
        r = self.t.rerisk_orders({"risk_money": 300, "tickets": [2]})
        self.assertEqual([x["ticket"] for x in r["results"]], [2])
        self.assertEqual(self.sent()[-1]["volume"], 0.3)
        with self.assertRaises(TradeError):
            self.t.rerisk_orders({"risk_money": 300, "tickets": [99]})
        with self.assertRaises(TradeError):
            self.t.rerisk_orders({"tickets": [1]})

    def test_no_sl_is_skipped(self):
        mt5.state["orders"] = [buy_limit(1, 0.10, sl=0.0)]
        r = self.t.rerisk_orders({"risk_pct": 1})
        self.assertFalse(r["ok"])
        self.assertIn("ไม่มี SL", r["results"][0]["message"])
        self.assertEqual(self.sent(), [])

    def test_guard_blocks_before_cancel(self):
        self.t.guards["max_lot"] = 0.15
        mt5.state["orders"] = [buy_limit(1, 0.10)]
        r = self.t.rerisk_orders({"risk_pct": 1})
        self.assertFalse(r["ok"])
        self.assertIn("max_lot", r["results"][0]["message"])
        self.assertEqual(self.sent(), [])            # ไม่ลบใบเดิมถ้าใบใหม่ผิด guard

    def test_max_positions_not_counted_when_replacing(self):
        mt5.state["orders"] = [buy_limit(1, 0.10), buy_limit(2, 0.10)]   # เต็ม max_positions=2 แล้ว
        r = self.t.rerisk_orders({"risk_pct": 1})
        self.assertTrue(r["ok"], r)

    def test_restore_old_when_new_rejected(self):
        mt5.state["orders"] = [buy_limit(1, 0.10)]
        calls = []
        real = trading.mt5_trade.order_send

        def send(req):
            calls.append(req)
            res = real(req)
            if len(calls) == 2:                      # วางใบใหม่ -> โบรกปฏิเสธ
                return res._replace(retcode=10019)
            return res
        trading.mt5_trade.order_send = send
        try:
            r = self.t.rerisk_orders({"risk_pct": 1})
        finally:
            trading.mt5_trade.order_send = real
        row = r["results"][0]
        self.assertFalse(row["ok"])
        self.assertTrue(row["restored"])
        self.assertEqual([c.get("volume") for c in calls], [None, 0.2, 0.1])


if __name__ == "__main__":
    unittest.main()
