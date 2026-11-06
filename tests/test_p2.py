"""P2: แท่งสดจาก worker + UTC offset + drawings API"""
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

import worker  # noqa: E402
from auth import hash_password  # noqa: E402
from drawings import clean_overlays  # noqa: E402

KEY = "k" * 32
ORIGIN = "https://terminal.example.com"
H = {"X-Requested-With": "wt"}


class BarsStream(unittest.TestCase):
    def tearDown(self):
        mt5.copy_rates_from_pos, mt5.copy_rates_from = self._orig

    def setUp(self):
        mt5.reset()
        self._orig = (mt5.copy_rates_from_pos, mt5.copy_rates_from)
        self.bars = [{"time": 1000, "open": 1, "high": 2, "low": 0.5, "close": 1.5, "tick_volume": 3},
                     {"time": 1900, "open": 1.5, "high": 2, "low": 1, "close": 1.7, "tick_volume": 4}]
        mt5.copy_rates_from_pos = lambda s, tf, a, n: [dict(b) for b in self.bars][-n:]
        self.app = worker.create_app("demo", KEY, start_poller=False)
        self.c = TestClient(self.app)
        self.p = self.app.state.poller

    def recv_type(self, ws, t, limit=10):
        for _ in range(limit):
            m = json.loads(ws.receive_text())
            if m["type"] == t:
                return m
        raise AssertionError(f"no {t}")

    def test_bars_sent_on_change_only(self):
        with self.c.websocket_connect("/stream", headers={"X-Worker-Key": KEY}) as ws:
            ws.send_text(json.dumps({"op": "subscribe", "symbols": [],
                                     "bars": [["XAUUSD", "m15"], ["XAUUSD", "BAD"], "junk"]}))
            ws.send_text(json.dumps({"op": "ping", "t": 1}))
            self.recv_type(ws, "pong")
            self.assertEqual(self.p.hub.bar_keys(), {("XAUUSD", "M15")})
            self.p._poll_bars()
            m = self.recv_type(ws, "bars")
            self.assertEqual((m["symbol"], m["tf"], len(m["bars"])), ("XAUUSD", "M15", 2))
            self.assertEqual(m["bars"][-1], [1900, 1.5, 2.0, 1.0, 1.7, 4])
            self.p._poll_bars()                       # ไม่เปลี่ยน -> ไม่ส่ง
            self.bars[-1]["close"] = 1.8
            self.p._poll_bars()
            ws.send_text(json.dumps({"op": "ping", "t": 2}))
            m = json.loads(ws.receive_text())
            self.assertEqual((m["type"], m["bars"][-1][4]), ("bars", 1.8))
            self.assertEqual(json.loads(ws.receive_text())["type"], "pong")

    def test_unknown_symbol_bars_skipped(self):
        with self.c.websocket_connect("/stream", headers={"X-Worker-Key": KEY}) as ws:
            ws.send_text(json.dumps({"op": "subscribe", "symbols": [], "bars": [["NOPE", "M1"]]}))
            ws.send_text(json.dumps({"op": "ping", "t": 1}))
            self.recv_type(ws, "pong")
            self.p._poll_bars()
            self.assertIn("NOPE", self.p._bad_symbols)

    def test_utc_offset_applied(self):
        self.p.offset_s = 3 * 3600
        calls = {}
        mt5.copy_rates_from = lambda s, tf, to, n: calls.setdefault("to", to) and [dict(b) for b in self.bars]
        h = {"X-Worker-Key": KEY}
        r = self.c.get("/rates", params={"symbol": "XAUUSD", "count": 2}, headers=h).json()
        self.assertEqual(r[0][0], 1000 - 3 * 3600)
        self.c.get("/rates", params={"symbol": "XAUUSD", "count": 2, "to": 50000}, headers=h)
        self.assertEqual(int(calls["to"].timestamp()), 50000 + 3 * 3600)   # ส่งเป็น datetime UTC
        self.assertEqual(self.p.status()["server_utc_offset_h"], 3)


class DrawingsValidation(unittest.TestCase):
    def test_clean(self):
        out = clean_overlays([{"name": "segment", "points": [{"timestamp": 1, "value": 2.5, "dataIndex": 9}],
                               "extendData": "x", "onClick": "evil", "styles": {}}])
        self.assertEqual(out, [{"name": "segment", "points": [{"timestamp": 1, "value": 2.5}],
                                "extendData": "x", "styles": {}}])

    def test_rejects(self):
        for bad in (None, {}, [{"name": 1, "points": []}], [{"name": "s", "points": [{"timestamp": "a", "value": 1}]}],
                    [{"name": "s", "points": []}] * 501):
            with self.assertRaises(ValueError):
                clean_overlays(bad)


class DrawingsAPI(unittest.TestCase):
    def setUp(self):
        import gateway
        tmp = tempfile.mkdtemp()
        os.environ.update(WT_PASS_HASH=hash_password("pw-123456789"), WT_ORIGIN=ORIGIN, WT_COOKIE_SECURE="1",
                          WT_DB=os.path.join(tmp, "d.db"), WT_WORKER_KEY=KEY,
                          WT_ACCOUNTS=str(HERE.parent / "accounts.json"))
        self.c = TestClient(gateway.create_app(), base_url=ORIGIN)

    def test_requires_login_and_csrf(self):
        self.assertEqual(self.c.get("/api/drawings/XAUUSD").status_code, 401)
        self.c.post("/api/auth/login", json={"password": "pw-123456789"}, headers=H)
        self.assertEqual(self.c.put("/api/drawings/XAUUSD", json={"overlays": []}).status_code, 403)

    def test_roundtrip(self):
        self.c.post("/api/auth/login", json={"password": "pw-123456789"}, headers=H)
        self.assertEqual(self.c.get("/api/drawings/XAUUSD").json()["overlays"], [])
        ov = [{"name": "rectBox", "points": [{"timestamp": 1, "value": 2}, {"timestamp": 3, "value": 4}]}]
        self.assertEqual(self.c.put("/api/drawings/XAUUSD", json={"overlays": ov}, headers=H).status_code, 200)
        self.assertEqual(self.c.get("/api/drawings/XAUUSD").json()["overlays"], ov)
        self.assertEqual(self.c.get("/api/drawings/EURUSD").json()["overlays"], [])
        self.assertEqual(self.c.put("/api/drawings/XAU$USD", json={"overlays": []}, headers=H).status_code, 400)
        self.assertEqual(self.c.put("/api/drawings/XAUUSD", json={"overlays": "x"}, headers=H).status_code, 400)
        self.assertEqual(self.c.put("/api/drawings/XAUUSD", content=b"not json", headers=H).status_code, 400)


if __name__ == "__main__":
    unittest.main()


class PrefsAPI(unittest.TestCase):
    def setUp(self):
        import gateway
        tmp = tempfile.mkdtemp()
        os.environ.update(WT_PASS_HASH=hash_password("pw-123456789"), WT_ORIGIN=ORIGIN, WT_COOKIE_SECURE="1",
                          WT_DB=os.path.join(tmp, "p.db"), WT_WORKER_KEY=KEY,
                          WT_ACCOUNTS=str(HERE.parent / "accounts.json"))
        self.c = TestClient(gateway.create_app(), base_url=ORIGIN)

    def test_prefs(self):
        self.assertEqual(self.c.get("/api/prefs").status_code, 401)
        self.c.post("/api/auth/login", json={"password": "pw-123456789"}, headers=H)
        self.assertEqual(self.c.get("/api/prefs").json(), {})
        self.assertEqual(self.c.put("/api/prefs/wt.watch.demo", json={"value": ["XAUUSD", "BTCUSDm"]}, headers=H).status_code, 200)
        self.c.put("/api/prefs/wt.charts", json={"value": {"layout": 2}}, headers=H)
        self.c.put("/api/prefs/wt.watch.demo", json={"value": ["EURUSD"]}, headers=H)
        self.assertEqual(self.c.get("/api/prefs").json(), {"wt.watch.demo": ["EURUSD"], "wt.charts": {"layout": 2}})
        self.assertEqual(self.c.put("/api/prefs/evil", json={"value": 1}, headers=H).status_code, 400)
        self.assertEqual(self.c.put("/api/prefs/wt.x", json={"nope": 1}, headers=H).status_code, 400)
        self.assertEqual(self.c.put("/api/prefs/wt.x", json={"value": "a" * 70000}, headers=H).status_code, 400)
        self.assertEqual(self.c.put("/api/prefs/wt.x", json={"value": 1}).status_code, 403)   # CSRF


class LowerTF(unittest.TestCase):
    def setUp(self):
        mt5.reset()
        self.c = TestClient(worker.create_app("demo", KEY, start_poller=False))
        self.h = {"X-Worker-Key": KEY}

    def test_ltf_seconds(self):
        self.assertEqual([worker.ltf_seconds(t) for t in ("M1", "M5", "M15", "M30", "H1", "H4", "D1")],
                         [30, 30, 60, 120, 240, 960, 5760])

    def test_bucket(self):
        rows = [(100, 5, 4, 1), (110, 6, 3, 2), (131, 7, 6, 1), (90, 9, 9, 9)]
        self.assertEqual(worker.bucket_bars(rows, 100, 30), [[6, 3, 3], [7, 6, 1]])

    def test_ticks_30s_for_m5(self):
        t0 = 1_700_000_100
        mt5.state["tick_hist"] = [{"time_msc": (t0 + s) * 1000, "bid": 100 + s, "ask": 0} for s in (0, 10, 40, 299, 300)]
        r = self.c.get("/ltf", params={"symbol": "XAUUSD", "tf": "M5", "times": f"{t0},{t0 + 3000}"}, headers=self.h).json()
        self.assertEqual(r["ltf_sec"], 30)
        self.assertEqual(r["bars"][str(t0)], [[110, 100, 2], [140, 140, 1], [399, 399, 1]])   # 300 = แท่งถัดไป ไม่นับ
        self.assertIsNone(r["bars"][str(t0 + 3000)])

    def test_m1_buckets_for_h1(self):
        t0 = 1_700_002_800
        mt5.state["m1_hist"] = [{"time": t0 + 60 * k, "high": 10 + k, "low": 5, "tick_volume": 2} for k in range(60)]
        r = self.c.get("/ltf", params={"symbol": "XAUUSD", "tf": "H1", "times": str(t0)}, headers=self.h).json()
        bars = r["bars"][str(t0)]
        self.assertEqual((r["ltf_sec"], len(bars)), (240, 15))
        self.assertEqual(bars[0], [13, 5, 8])

    def test_ltf_bad_input(self):
        self.assertEqual(self.c.get("/ltf", params={"symbol": "XAUUSD", "tf": "M7", "times": "1"}, headers=self.h).status_code, 400)
        self.assertEqual(self.c.get("/ltf", params={"symbol": "XAUUSD", "tf": "M5", "times": "a"}, headers=self.h).status_code, 400)
        self.assertEqual(self.c.get("/ltf", params={"symbol": "NOPE", "tf": "M5", "times": "1"}, headers=self.h).status_code, 404)
