# สำรองข้อมูลอัตโนมัติ: วันละชุด, ไม่ทับชุดของวันเดียวกัน, เก็บ 14 ชุด, db ที่ได้เปิดอ่านได้
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import backup  # noqa: E402


class Backup(unittest.TestCase):
    def test_daily_keep_and_extras(self):
        base = Path(tempfile.mkdtemp())
        db = base / "web_terminal.db"
        c = sqlite3.connect(db)
        c.execute("CREATE TABLE t (v TEXT)")
        c.execute("INSERT INTO t VALUES ('x')")
        c.commit()
        (base / ".env").write_text("WT_WORKER_KEY=abc\n")
        (base / "logs").mkdir()
        (base / "logs" / "autobe_cent.json").write_text("{}")
        (base / "logs" / "trade_audit.jsonl").write_text("")      # ไม่สำรอง log อื่น
        dest = base / "backups"
        extras = backup.extra_files(base)
        self.assertEqual(sorted(f.name for f in extras), [".env", "autobe_cent.json"])
        out = backup.run_backup(db, dest, extras, day="2026-09-01")
        self.assertEqual(sorted(p.name for p in out.iterdir()), [".env", "autobe_cent.json", "web_terminal.db"])
        chk = sqlite3.connect(out / "web_terminal.db")
        self.assertEqual(chk.execute("SELECT v FROM t").fetchone(), ("x",))
        chk.close()   # Windows: ไฟล์ที่เปิดค้างลบไม่ได้ -> โฟลเดอร์เก่าไม่ถูกตัด
        self.assertIsNone(backup.run_backup(db, dest, extras, day="2026-09-01"))   # วันเดียวกันไม่ทำซ้ำ
        c.close()
        for d in range(2, 20):
            backup.run_backup(db, dest, extras, keep=14, day=f"2026-09-{d:02d}")
        days = sorted(p.name for p in dest.iterdir())
        self.assertEqual((len(days), days[0], days[-1]), (14, "2026-09-06", "2026-09-19"))
        self.assertEqual(backup.last_backup(dest), "2026-09-19")
        self.assertIsNone(backup.run_backup(base / "none.db", dest, []))


if __name__ == "__main__":
    unittest.main()
