# ตั้งค่าบัญชี MT5 จากหน้าเว็บ: ตรวจ/บันทึก accounts.json, port อัตโนมัติ, path ห้ามซ้ำ, ต้องใส่รหัสเว็บ, ตรวจชนิดบัญชี
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))

import fake_mt5  # noqa: E402,F401
from fastapi.testclient import TestClient  # noqa: E402

import accounts  # noqa: E402
import mt5probe  # noqa: E402
from auth import hash_password  # noqa: E402

KEY = "k" * 32
ORIGIN = "https://terminal.example.com"
PASSWORD = "correct horse battery"
H = {"X-Requested-With": "wt"}
T1 = "C:\\Program Files\\MetaTrader 5\\terminal64.exe"
T2 = "C:\\MT5 cent\\terminal64.exe"


class AccountsLogic(unittest.TestCase):
    def test_detect_kind(self):
        self.assertEqual(accounts.detect_kind("USC", "Exness-MT5Real8"), "cent")
        self.assertEqual(accounts.detect_kind("USD", "Exness-MT5Trial"), "std")
        self.assertEqual(accounts.detect_kind("USD", "Broker-Cent"), "cent")

    def test_build_ports_paths_guards(self):
        cur = [{"name": "demo", "kind": "std", "terminal_path": T1, "port": 8101, "custom": 1}]
        out = accounts.build_accounts([
            {"name": "demo", "kind": "std", "terminal_path": T1, "port": 8101, "guards": {"max_lot": "5", "max_positions": 30}},
            {"name": "cent", "kind": "cent", "terminal_path": T2, "guards": {"day_reset": "16:59 America/New_York", "require_sl": True}},
        ], cur)
        self.assertEqual([a["port"] for a in out], [8101, 8102])
        self.assertEqual(out[0]["custom"], 1)                       # ฟิลด์ที่หน้าเว็บไม่รู้จักยังอยู่
        self.assertEqual(out[0]["guards"], {"max_lot": 5.0, "max_positions": 30})
        self.assertTrue(out[1]["guards"]["require_sl"])
        with self.assertRaises(ValueError):                        # terminal เดียวกัน 2 บัญชี
            accounts.build_accounts([{"name": "a", "kind": "std", "terminal_path": T1},
                                     {"name": "b", "kind": "std", "terminal_path": T1.upper()}], [])
        for bad in ({"name": "A!", "kind": "std", "terminal_path": T1}, {"name": "a", "kind": "xx", "terminal_path": T1},
                    {"name": "a", "kind": "std", "terminal_path": "C:\\x\\evil.exe"},
                    {"name": "a", "kind": "std", "terminal_path": T1, "guards": {"day_reset": "rm -rf"}}):
            with self.assertRaises(ValueError):
                accounts.build_accounts([bad], [])

    def test_probe_reads_logged_in_account(self):
        r = mt5probe.probe(T1, False)
        self.assertTrue(r["ok"])
        self.assertEqual((r["login"], r["mode"], r["kind"]), (111, "demo", "std"))


class GatewayAccountsAdmin(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.mkdtemp()
        self.acc = Path(tmp) / "accounts.json"
        self.acc.write_text(json.dumps({"accounts": [
            {"name": "demo", "kind": "std", "terminal_path": T1, "port": 18298}]}))
        os.environ.update(WT_PASS_HASH=hash_password(PASSWORD), WT_ORIGIN=ORIGIN, WT_COOKIE_SECURE="1",
                          WT_DB=os.path.join(tmp, "g.db"), WT_WORKER_KEY=KEY, WT_ACCOUNTS=str(self.acc))
        import gateway
        self.c = TestClient(gateway.create_app(), base_url=ORIGIN)
        assert self.c.post("/api/auth/login", json={"password": PASSWORD}, headers=H).status_code == 200

    def test_list_save_and_reload(self):
        got = self.c.get("/api/admin/accounts").json()["accounts"]
        self.assertEqual(got[0]["name"], "demo")
        self.assertIsNone(got[0]["live"])                          # worker ไม่ได้รัน
        new = [got[0], {"name": "cent", "kind": "cent", "terminal_path": T2, "trading": True}]
        self.assertEqual(self.c.post("/api/admin/accounts", json={"password": "nope", "accounts": new}, headers=H).status_code, 403)
        r = self.c.post("/api/admin/accounts", json={"password": PASSWORD, "accounts": new}, headers=H).json()
        self.assertEqual((r["added"], r["removed"], r["changed"]), (["cent"], [], []))
        self.assertIn("pm2 start ecosystem.config.js --only wt-worker-cent", r["commands"])
        saved = json.loads(self.acc.read_text())["accounts"]
        self.assertEqual(saved[1]["port"], 8101)
        self.assertTrue(self.acc.with_suffix(".json.bak").exists())
        # gateway ใช้รายการใหม่ทันที (ไม่ต้อง restart)
        self.assertEqual([a["name"] for a in self.c.get("/api/accounts").json()], ["demo", "cent"])
        r = self.c.post("/api/admin/accounts", json={"password": PASSWORD, "accounts": [saved[1]]}, headers=H).json()
        self.assertEqual(r["removed"], ["demo"])
        self.assertIn("pm2 delete wt-worker-demo", r["commands"])
        # ต้องมี CSRF header + login
        self.assertEqual(self.c.post("/api/admin/accounts", json={"password": PASSWORD, "accounts": []}).status_code, 403)
        self.assertEqual(TestClient(self.c.app, base_url=ORIGIN).get("/api/admin/accounts").status_code, 401)

    def test_replay_sessions_store(self):
        rec = {"sym": "XAUUSD", "tf": "M5", "trades": [{"pnl": 1.5}], "state": {"cursorTs": 1}}
        self.assertEqual(self.c.put("/api/replay/111", json={"value": rec}, headers=H).status_code, 200)
        self.assertEqual(self.c.put("/api/replay/222", json={"value": {**rec, "sym": "EURUSD"}}, headers=H).status_code, 200)
        self.assertEqual(self.c.put("/api/replay/111", json={"value": {**rec, "trades": []}}, headers=H).status_code, 200)   # ทับรอบเดิม
        got = self.c.get("/api/replay").json()
        self.assertEqual([(x["sid"], x["sym"], len(x["trades"])) for x in got], [(111, "XAUUSD", 0), (222, "EURUSD", 1)])
        self.assertEqual(self.c.put("/api/replay/3", json={"value": {"trades": "x"}}, headers=H).status_code, 400)
        self.assertEqual(self.c.put("/api/replay/3", json={"value": rec}).status_code, 403)          # ไม่มี CSRF header
        self.c.delete("/api/replay/222", headers=H)
        self.assertEqual([x["sid"] for x in self.c.get("/api/replay").json()], [111])

    def test_probe_validation(self):
        bad = self.c.post("/api/admin/accounts/probe", json={"terminal_path": "C:\\x\\cmd.exe"}, headers=H)
        self.assertEqual(bad.status_code, 400)
        used = self.c.post("/api/admin/accounts/probe", json={"terminal_path": T1, "name": "other"}, headers=H)
        self.assertEqual(used.status_code, 400)
        missing = self.c.post("/api/admin/accounts/probe", json={"terminal_path": "C:\\none\\terminal64.exe"}, headers=H)
        self.assertEqual(missing.status_code, 400)


if __name__ == "__main__":
    unittest.main()
