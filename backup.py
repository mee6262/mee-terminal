"""สำรองข้อมูลอัตโนมัติวันละครั้ง (gateway รันเป็น thread เบื้องหลัง)

backups/YYYY-MM-DD/  web_terminal.db (sqlite backup API = ปลอดภัยแม้ระบบเขียนอยู่)
                     + .env, accounts.local.json, logs/autobe_*.json, logs/prules_*.json
เก็บ KEEP_DAYS ชุดล่าสุด ชุดเก่ากว่านั้นลบทิ้ง
กู้คืน: pm2 stop all -> คัดลอกไฟล์จากโฟลเดอร์วันที่ต้องการกลับไปที่เดิม -> pm2 start all
"""
import logging
import re
import shutil
import sqlite3
import threading
import time
from pathlib import Path

log = logging.getLogger("backup")
KEEP_DAYS = 14
CHECK_EVERY_SEC = 3600
_DAY_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def extra_files(base: Path) -> list[Path]:
    files = [base / ".env", base / "accounts.local.json"]
    logs = base / "logs"
    if logs.is_dir():
        files += sorted(logs.glob("autobe_*.json")) + sorted(logs.glob("prules_*.json"))
    return [f for f in files if f.is_file()]


def run_backup(db_path: Path, dest: Path, extras: list[Path], keep: int = KEEP_DAYS, day: str | None = None) -> Path | None:
    """สำรองชุดของวันนี้ถ้ายังไม่มี -> คืน path โฟลเดอร์ (None = มีแล้ว / ไม่มี db)"""
    db_path, dest = Path(db_path), Path(dest)
    if not db_path.is_file():
        return None
    day = day or time.strftime("%Y-%m-%d")
    out = dest / day
    if (out / db_path.name).exists():
        return None
    out.mkdir(parents=True, exist_ok=True)
    tmp = out / (db_path.name + ".tmp")
    src = sqlite3.connect(str(db_path))
    dst = sqlite3.connect(str(tmp))
    try:
        src.backup(dst)
    finally:
        dst.close()
        src.close()
    tmp.replace(out / db_path.name)
    for f in extras:
        shutil.copy2(f, out / f.name)
    days = sorted(p for p in dest.iterdir() if p.is_dir() and _DAY_RE.match(p.name))
    for old in days[:-keep]:
        shutil.rmtree(old, ignore_errors=True)
    return out


def last_backup(dest: Path) -> str | None:
    dest = Path(dest)
    if not dest.is_dir():
        return None
    days = sorted(p.name for p in dest.iterdir() if p.is_dir() and _DAY_RE.match(p.name))
    return days[-1] if days else None


def start(db_path: Path, dest: Path, base: Path, first_delay: float = 60) -> threading.Thread:
    def loop():
        time.sleep(first_delay)
        while True:
            try:
                got = run_backup(db_path, dest, extra_files(base))
                if got:
                    log.info("สำรองข้อมูลแล้ว: %s", got)
            except Exception as e:  # สำรองพลาดต้องไม่ทำให้ gateway ล้ม
                log.error("สำรองข้อมูลไม่สำเร็จ: %r", e)
            time.sleep(CHECK_EVERY_SEC)
    t = threading.Thread(target=loop, name="wt-backup", daemon=True)
    t.start()
    return t
