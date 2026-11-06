"""order flow (flow.py): รวมนาที -> แท่ง TF, volume profile, จุดล้างพอร์ต, แปลงข้อความ Binance, API ต้องมี key"""
import os
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
os.environ["WT_NO_AUTOAPP"] = "1"

from fastapi.testclient import TestClient  # noqa: E402

import flow  # noqa: E402

KEY = "k" * 32
T0 = 1_790_000_100          # หาร 300 ลงตัว (ต้นแท่ง M5)


class Flow(unittest.TestCase):
    def setUp(self):
        self.db = str(Path(tempfile.mkdtemp()) / "f.db")
        self.st = flow.FlowStore(self.db, {"BTCUSDT": 5.0})

    def test_bucket(self):
        self.assertEqual(flow.bucket_of(T0 + 59, "M1"), T0)
        self.assertEqual(flow.bucket_of(T0, "H1") % 3600, 0)
        w = flow.bucket_of(T0, "W1")
        self.assertEqual(__import__("datetime").datetime.utcfromtimestamp(w).weekday(), 6)   # อาทิตย์ เหมือน MT5
        self.assertEqual(flow.bucket_of(T0, "MN1") % 86400, 0)
        self.assertEqual(flow.parse_symbols("btcusdt:5, ETHUSDT:0.5"), {"BTCUSDT": 5.0, "ETHUSDT": 0.5})

    def test_trades_bars_profile(self):
        h = lambda p, q, m, t: flow.handle(self.st, {"stream": "x", "data": {"e": "aggTrade", "s": "BTCUSDT", "p": str(p), "q": str(q), "m": m, "T": t * 1000}})
        h(100.0, 1.0, False, T0)          # ซื้อกดเข้า
        h(101.0, 0.5, True, T0 + 10)      # ขายกดเข้า (buyer = maker)
        h(107.0, 2.0, False, T0 + 70)     # นาทีถัดไป -> นาทีแรกถูกบันทึก
        self.st.oi["BTCUSDT"] = 1234.0
        bars = self.st.bars("BTCUSDT", "M1", T0, T0 + 120)
        self.assertEqual([(b["t"], b["buy"], b["sell"], b["n"]) for b in bars], [(T0, 1.0, 0.5, 2), (T0 + 60, 2.0, 0.0, 1)])
        self.assertEqual(bars[-1]["oi"], 1234.0)             # นาทีที่ยังไม่จบ ใส่ OI ล่าสุด
        m5 = self.st.bars("BTCUSDT", "M5", T0 - 300, T0 + 300)
        self.assertEqual((len(m5), m5[0]["buy"], m5[0]["sell"]), (1, 3.0, 0.5))
        pf = self.st.profile("BTCUSDT", T0, T0 + 120)
        self.assertEqual(pf, {"bin": 5.0, "rows": [[100.0, 1.0, 0.5], [105.0, 2.0, 0.0]]})
        pf = self.st.profile("BTCUSDT", T0, T0 + 120, max_rows=1)   # รวม bin
        self.assertEqual(pf, {"bin": 10.0, "rows": [[100.0, 3.0, 0.5]]})
        self.st.roll(now=T0 + 200)                            # ปิดนาทีที่ค้าง
        self.assertEqual(len(self.st.bars("BTCUSDT", "M1", T0, T0 + 300)), 2)

    def test_liq_and_mark(self):
        flow.handle(self.st, {"data": {"e": "forceOrder", "o": {"s": "BTCUSDT", "S": "SELL", "q": "0.5", "p": "99", "ap": "100", "z": "0.5", "T": T0 * 1000}}})
        flow.handle(self.st, {"data": {"e": "forceOrder", "o": {"s": "XRPUSDT", "S": "BUY", "q": "1", "p": "1", "T": T0 * 1000}}})
        flow.handle(self.st, {"data": {"e": "markPriceUpdate", "s": "BTCUSDT", "p": "100.5", "r": "0.0001"}})
        self.assertEqual(self.st.liqs("BTCUSDT", T0 - 1, T0 + 1), [{"t": T0, "side": "SELL", "price": 100.0, "qty": 0.5}])
        self.assertEqual((self.st.mark["BTCUSDT"], self.st.fr["BTCUSDT"]), (100.5, 0.0001))

    def test_api(self):
        app = flow.create_app(KEY, self.db, {"BTCUSDT": 5.0}, start=False)
        c = TestClient(app)
        self.assertEqual(c.get("/status").status_code, 403)
        H = {"X-Worker-Key": KEY}
        self.assertEqual(c.get("/bars", params={"symbol": "XAUUSD", "tf": "M1", "frm": 0, "to": 1}, headers=H).status_code, 404)
        self.assertEqual(c.get("/bars", params={"symbol": "btcusdt", "tf": "X", "frm": 0, "to": 1}, headers=H).status_code, 400)
        self.assertEqual(c.get("/bars", params={"symbol": "btcusdt", "tf": "M1", "frm": 0, "to": 1}, headers=H).json()["bars"], [])
        self.assertFalse(c.get("/status", headers=H).json()["connected"])


if __name__ == "__main__":
    unittest.main()
