"""mt5proc: MT5 ใน process ลูกจริง (spawn) — ส่ง namedtuple ข้าม process, ค้าง = kill + เปิดใหม่, error ส่งกลับ, ลูก trade เชื่อมเอง"""
import sys
import time
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))

import fake_mt5  # noqa: E402,F401
import mt5proc  # noqa: E402


class ProxyTest(unittest.TestCase):
    def setUp(self):
        self.p = mt5proc.Proxy("t", 5.0, module="fake_proc_mod")

    def tearDown(self):
        self.p.close()

    def test_namedtuple_roundtrip(self):
        pos = self.p.call("positions")
        self.assertEqual((pos[0].ticket, pos[0].symbol, pos[0].sl), (7, "XAUUSD", 2640.5))
        self.assertEqual(pos[1]._asdict()["symbol"], "EURUSD")
        self.assertEqual(self.p.call("echo", ({"a": [1, 2]},)), {"a": [1, 2]})
        self.assertNotEqual(self.p.pid(), None)

    def test_c_structseq_keeps_field_names(self):
        # MetaTrader5 คืน structseq (เหมือน os.stat_result) ไม่ใช่ namedtuple — เคยหลุดเป็น tuple เปล่าบน VPS (info.login พัง)
        import os
        st = self.p.call("cstruct")
        self.assertEqual(st.st_size, os.stat(".").st_size)
        self.assertIn("st_mode", st._asdict())

    def test_hang_kills_and_restarts(self):
        pid = (self.p.call("echo", (1,)), self.p.pid())[1]
        t0 = time.time()
        with self.assertRaises(mt5proc.MT5Timeout):
            self.p.call("slow", (30,), timeout=1.0)
        self.assertLess(time.time() - t0, 10)
        self.assertIsNone(self.p.pid())
        self.assertEqual(self.p.call("echo", (2,)), 2)          # เปิด process ใหม่เอง
        self.assertNotEqual(self.p.pid(), pid)

    def test_error_propagates(self):
        with self.assertRaises(RuntimeError) as e:
            self.p.call("boom")
        self.assertIn("bad request", str(e.exception))
        self.assertEqual(self.p.call("echo", (3,)), 3)          # ลูกยังอยู่

    def test_none_result_carries_child_error_and_init_failure(self):
        t = mt5proc.Proxy("tr2", 5.0, module="fake_proc_mod", ensure=True)
        try:
            t.set_init({"fail": True})
            with self.assertRaises(RuntimeError) as e:      # เชื่อมไม่ได้ = ไม่เรียก order_send เลย
                t.call("order_send", ({},))
            self.assertIn("MT5Init", str(e.exception))
            t.set_init({"path": "x"})
            self.assertIsNone(t.call("order_send", ({"bad": True},)))
            self.assertEqual(t.none_error, (1, "Success"))  # error ของ process ลูกตัวนี้เอง
        finally:
            t.close()

    def test_trade_child_initializes_itself(self):
        t = mt5proc.Proxy("tr", 5.0, module="fake_proc_mod", ensure=True)
        try:
            t.set_init({"path": "x", "portable": True, "timeout": 20000})
            self.assertEqual(t.call("inits"), 1)                 # terminal_info None -> initialize ก่อนเรียก
            self.assertEqual(t.call("inits"), 1)                 # เชื่อมแล้ว ไม่ initialize ซ้ำ
        finally:
            t.close()


if __name__ == "__main__":
    unittest.main()
