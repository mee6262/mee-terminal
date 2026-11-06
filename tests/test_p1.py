"""P1 acceptance: worker (MT5 ปลอม) + gateway proxy/WS"""
import asyncio
import json
import os
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))
os.environ["WT_NO_AUTOAPP"] = "1"

import fake_mt5  # noqa: E402,F401  (ต้องมาก่อน worker)
import MetaTrader5 as mt5  # noqa: E402
import uvicorn  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from starlette.websockets import WebSocketDisconnect  # noqa: E402

import worker  # noqa: E402
from auth import hash_password  # noqa: E402

KEY = "k" * 32
ORIGIN = "https://terminal.example.com"
PASSWORD = "correct horse battery"


def wait_for(cond, timeout=3.0):
    end = time.time() + timeout
    while time.time() < end:
        if cond():
            return True
        time.sleep(0.02)
    return False


class Worker(unittest.TestCase):
    def setUp(self):
        mt5.reset()
        self.app = worker.create_app("demo", KEY, start_poller=False)
        self.c = TestClient(self.app)
        self.h = {"X-Worker-Key": KEY}

    def test_key_required(self):
        self.assertEqual(self.c.get("/account").status_code, 403)
        self.assertEqual(self.c.get("/account", headers={"X-Worker-Key": "x" * 32}).status_code, 403)
        with self.assertRaises(WebSocketDisconnect):
            with self.c.websocket_connect("/stream") as ws:
                ws.receive_text()

    def test_rest(self):
        a = self.c.get("/account", headers=self.h).json()
        self.assertEqual((a["login"], a["trade_mode"]), (111, 0))
        self.assertEqual(self.c.get("/symbols", headers=self.h).json()[0]["name"], "XAUUSD")
        r = self.c.get("/rates", params={"symbol": "XAUUSD", "tf": "H1", "count": 3}, headers=self.h).json()
        self.assertEqual(len(r), 3)
        self.assertEqual(len(r[0]), 6)
        self.assertEqual(self.c.get("/rates", params={"symbol": "NOPE"}, headers=self.h).status_code, 404)
        self.assertEqual(self.c.get("/rates", params={"symbol": "XAUUSD", "tf": "M2"}, headers=self.h).status_code, 400)

    def test_wrong_login_fails_closed(self):
        import accounts
        cfg = accounts.load_accounts()
        cfg["demo"]["login"] = 999
        br = worker.MT5Bridge(cfg["demo"])
        self.assertFalse(br.ensure())
        self.assertIn("999", br.error)

    def test_login_switch_while_running_stops(self):
        import accounts
        cfg = accounts.load_accounts()
        cfg["demo"]["login"] = mt5.state["login"]
        br = worker.MT5Bridge(cfg["demo"])
        self.assertTrue(br.ensure())
        pl = worker.Poller(br, worker.Hub())
        old = mt5.state["login"]
        try:
            mt5.state["login"] = old + 1           # เปลี่ยนบัญชีใน terminal
            pl._poll_state()
            self.assertFalse(br.connected)
            self.assertIn(str(old + 1), br.error)
            self.assertFalse(br.ensure())            # เชื่อมใหม่ก็ไม่ผ่านจนกว่าจะแก้ config
        finally:
            mt5.state["login"] = old

    def test_mt5_down_returns_503_and_reconnects(self):
        mt5.state["up"] = False
        mt5.state["init_ok"] = False
        self.assertEqual(self.c.get("/account", headers=self.h).status_code, 503)
        mt5.state["up"] = True
        mt5.state["init_ok"] = True
        self.app.state.poller.bridge._next_try = 0
        self.assertEqual(self.c.get("/account", headers=self.h).status_code, 200)

    def test_stream_tick_throttle_and_state(self):
        poller = self.app.state.poller
        with self.c.websocket_connect("/stream", headers=self.h) as ws:
            self.assertEqual(json.loads(ws.receive_text())["type"], "status")
            ws.send_text(json.dumps({"op": "subscribe", "symbols": ["XAUUSD", "NOPE"]}))
            self.assertTrue(wait_for(lambda: poller.hub.symbols() == {"XAUUSD", "NOPE"}))
            poller.poll_once(100.0, True, False)
            got = [json.loads(ws.receive_text()) for _ in range(6)]
            types = [g["type"] for g in got]
            self.assertIn("day", types)         # สรุปกำไรวันนี้ (ทุก 10 วินาที)
            self.assertIn("tick", types)
            self.assertIn("error", types)       # NOPE
            self.assertIn("account", types)
            self.assertIn("positions", types)
            self.assertIn("orders", types)
            # ราคาเปลี่ยนภายใน 100ms -> ยังไม่ส่ง; พ้นแล้ว -> ส่งค่าล่าสุด
            mt5.state["ticks"]["XAUUSD"] = mt5.Tick(2651.0, 2651.2, 2)
            poller.poll_once(100.05, False, False)
            mt5.state["ticks"]["XAUUSD"] = mt5.Tick(2652.0, 2652.2, 3)
            poller.poll_once(100.2, True, False)   # state ไม่เปลี่ยน -> ไม่ส่ง
            ws.send_text(json.dumps({"op": "ping", "t": 7}))
            m1 = json.loads(ws.receive_text())
            self.assertEqual((m1["type"], m1["bid"]), ("tick", 2652.0))
            self.assertEqual(json.loads(ws.receive_text()), {"type": "pong", "t": 7})
            # position ใหม่ -> ส่ง positions
            mt5.state["positions"] = [mt5.Pos(1, "XAUUSD", 0, 0.01, 2650, 2652, 0, 0, 2.0, 0, 0, "", 0)]
            poller.poll_once(101.0, True, False)
            m2 = json.loads(ws.receive_text())
            self.assertEqual((m2["type"], m2["data"][0]["ticket"]), ("positions", 1))

    def test_new_client_gets_snapshot(self):
        poller = self.app.state.poller
        poller.poll_once(1.0, True, False)
        with self.c.websocket_connect("/stream", headers=self.h) as ws:
            kinds = {json.loads(ws.receive_text())["type"] for _ in range(5)}
        self.assertEqual(kinds, {"status", "account", "positions", "orders", "day"})


class _Server(threading.Thread):
    def __init__(self, app, port):
        super().__init__(daemon=True)
        self.server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="error"))

    def run(self):
        self.server.run()


class GatewayP1(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        mt5.reset()
        tmp = tempfile.mkdtemp()
        cls.port = 18101
        acc = Path(tmp) / "accounts.json"
        acc.write_text(json.dumps({"accounts": [
            {"name": "demo", "kind": "std", "terminal_path": "x", "port": cls.port},
            {"name": "dead", "kind": "cent", "terminal_path": "x", "port": 18199}]}))
        os.environ.update(WT_PASS_HASH=hash_password(PASSWORD), WT_ORIGIN=ORIGIN, WT_COOKIE_SECURE="1",
                          WT_DB=os.path.join(tmp, "g.db"), WT_WORKER_KEY=KEY, WT_ACCOUNTS=str(acc))
        cls.wapp = worker.create_app("demo", KEY, start_poller=True)
        cls.srv = _Server(cls.wapp, cls.port)
        cls.srv.start()
        assert wait_for(lambda: cls.srv.server.started, 5)
        import gateway
        cls.gapp = gateway.create_app()

    @classmethod
    def tearDownClass(cls):
        cls.srv.server.should_exit = True
        cls.wapp.state.poller.stop_evt.set()

    def client(self, login=True):
        c = TestClient(self.gapp, base_url=ORIGIN)
        if login:
            r = c.post("/api/auth/login", json={"password": PASSWORD}, headers={"X-Requested-With": "wt"})
            assert r.status_code == 200
        return c

    @staticmethod
    def wsh(c, origin=ORIGIN):
        # TestClient ต่อ WS เป็น ws:// -> cookie Secure ไม่ถูกแนบเอง ต้องใส่ header ตรงๆ
        h = {"Origin": origin}
        tok = c.cookies.get("wt_session")
        if tok:
            h["Cookie"] = f"wt_session={tok}"
        return h

    def test_accounts_and_proxy(self):
        c = self.client()
        self.assertEqual([a["name"] for a in c.get("/api/accounts").json()], ["demo", "dead"])
        self.assertEqual(c.get("/api/a/demo/account").json()["login"], 111)
        self.assertEqual(len(c.get("/api/a/demo/rates", params={"symbol": "XAUUSD", "count": 5}).json()), 5)
        self.assertEqual(c.get("/api/a/demo/stream").status_code, 404)     # ไม่อยู่ใน allowlist
        self.assertEqual(c.get("/api/a/nope/account").status_code, 404)
        self.assertEqual(c.get("/api/a/dead/account").status_code, 503)

    def test_proxy_requires_login(self):
        self.assertEqual(self.client(login=False).get("/api/a/demo/account").status_code, 401)

    def test_ws_requires_session_and_origin(self):
        c = self.client(login=False)
        with self.assertRaises(WebSocketDisconnect) as e:
            with c.websocket_connect("/ws/demo", headers=self.wsh(c)) as ws:
                ws.receive_text()
        self.assertEqual(e.exception.code, 4401)
        c = self.client()
        with self.assertRaises(WebSocketDisconnect) as e:
            with c.websocket_connect("/ws/demo", headers=self.wsh(c, "https://evil.example")) as ws:
                ws.receive_text()
        self.assertEqual(e.exception.code, 4403)

    def test_ws_end_to_end_ticks(self):
        c = self.client()
        with c.websocket_connect("/ws/demo", headers=self.wsh(c)) as ws:
            ws.send_text(json.dumps({"op": "subscribe", "symbols": ["XAUUSD"]}))
            ws.send_text(json.dumps({"op": "bogus"}))       # ถูกทิ้งที่ gateway
            seen, t0 = set(), time.time()
            tick = None
            while time.time() - t0 < 5 and not ({"account", "tick"} <= seen):
                m = json.loads(ws.receive_text())
                seen.add(m["type"])
                if m["type"] == "tick":
                    tick = m
            self.assertIn("account", seen)
            self.assertEqual(tick["symbol"], "XAUUSD")
            ws.send_text(json.dumps({"op": "ping", "t": 42}))
            while True:
                m = json.loads(ws.receive_text())
                if m["type"] == "pong":
                    self.assertEqual(m["t"], 42)
                    break

    def test_ws_dead_worker_reports_status(self):
        c = self.client()
        with c.websocket_connect("/ws/dead", headers=self.wsh(c)) as ws:
            m = json.loads(ws.receive_text())
        self.assertEqual((m["type"], m["mt5"], m.get("worker")), ("status", False, False))

    def test_csp_allows_wss_self(self):
        r = self.client().get("/")
        self.assertIn("wss://terminal.example.com", r.headers["content-security-policy"])


if __name__ == "__main__":
    unittest.main()


class TerminalPathCheck(unittest.TestCase):
    def test_wrong_terminal_fails_closed(self):
        mt5.reset()
        mt5.state["term_path"] = r"C:\Program Files\MetaTrader 5"
        br = worker.MT5Bridge({"name": "demo", "terminal_path": r"C:\Program Files\MetaTrader 5 T2\terminal64.exe", "login": None})
        self.assertFalse(br.ensure())
        self.assertIn("ผิดตัว", br.error)
        mt5.reset()
        mt5.state["term_path"] = r"c:\program files\metatrader 5 t2"
        br = worker.MT5Bridge({"name": "demo", "terminal_path": r"C:\Program Files\MetaTrader 5 T2\terminal64.exe", "login": None})
        self.assertTrue(br.ensure())


class PortableFlag(unittest.TestCase):
    def test_portable_passed_through(self):
        for flag in (True, False):
            mt5.reset()
            br = worker.MT5Bridge({"name": "d", "terminal_path": "x", "login": None, "portable": flag})
            self.assertTrue(br.ensure())
            self.assertIs(mt5.state["init_kw"]["portable"], flag)

    def test_repo_demo_account_is_portable(self):
        import accounts
        self.assertTrue(accounts.load_accounts()["demo"]["portable"])
