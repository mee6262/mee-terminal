"""กฎของ pending order ที่ worker ดูแลเอง (ไม่พึ่งโบรก) — เก็บเป็นไฟล์ข้าง audit log ต่อบัญชี

  oco     [[a, b], ...]  คู่ OCO: ตัวหนึ่ง fill -> ยกเลิกอีกตัวทันที; ตัวหนึ่งถูกยกเลิก/หมดอายุเอง -> เลิกจับคู่ (อีกตัวอยู่ต่อ)
  expire  {ticket: ts}   หมดอายุ (UTC วินาที): ถึงเวลาแล้วยังไม่ fill -> worker ยกเลิกให้
ทำเองแทน ORDER_TIME_SPECIFIED ของโบรก: ไม่ต้องแปลงเวลา server/UTC และใช้ได้ทุกโบรก (worker รันตลอดใต้ pm2)
"""
import json
import threading
import time
from pathlib import Path

MAX_OCO = 50
MAX_EXPIRE = 200
RETRY_SEC = 30            # ยกเลิกไม่สำเร็จ รอเท่านี้ก่อนลองใหม่
GONE_GRACE_SEC = 30       # pending หายไปแต่ยังหาไม่เจอว่า fill ไหม (history อาจช้า) รอได้เท่านี้แล้วถือว่าถูกยกเลิก


class PendingRules:
    def __init__(self, path: Path):
        self.path = path
        self._lock = threading.Lock()
        self.oco: list[list[int]] = []
        self.expire: dict[int, float] = {}
        self.fail_until: dict[int, float] = {}
        self.gone_since: dict[int, float] = {}
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
            self.oco = [[int(a), int(b)] for a, b in raw.get("oco", [])][:MAX_OCO]
            self.expire = {int(k): float(v) for k, v in (raw.get("expire") or {}).items()}
        except (OSError, ValueError, TypeError, AttributeError):
            pass

    # ----- อ่าน/เขียน -----
    def _save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps({"oco": self.oco, "expire": {str(k): v for k, v in self.expire.items()}}), encoding="utf-8")
        tmp.replace(self.path)

    def get(self) -> dict:
        with self._lock:
            return {"oco": [list(x) for x in self.oco], "expire": {str(k): v for k, v in self.expire.items()}}

    def empty(self) -> bool:
        return not self.oco and not self.expire

    def partner(self, ticket: int) -> int | None:
        for a, b in self.oco:
            if ticket in (a, b):
                return b if ticket == a else a
        return None

    def link(self, a: int, b: int) -> None:
        a, b = int(a), int(b)
        if a == b:
            raise ValueError("เลือก pending คนละตัว")
        with self._lock:
            self.oco = [x for x in self.oco if a not in x and b not in x]   # ตัวหนึ่งอยู่ได้คู่เดียว
            if len(self.oco) >= MAX_OCO:
                raise ValueError(f"จับคู่ OCO ได้ไม่เกิน {MAX_OCO} คู่")
            self.oco.append([a, b])
            self._save()

    def unlink(self, ticket: int) -> None:
        with self._lock:
            self.oco = [x for x in self.oco if int(ticket) not in x]
            self._save()

    def set_expire(self, ticket: int, ts: float | None) -> None:
        with self._lock:
            if ts is None:
                self.expire.pop(int(ticket), None)
            else:
                if len(self.expire) >= MAX_EXPIRE and int(ticket) not in self.expire:
                    raise ValueError(f"ตั้งเวลาหมดอายุได้ไม่เกิน {MAX_EXPIRE} รายการ")
                self.expire[int(ticket)] = float(ts)
            self._save()

    def annotate(self, order: dict) -> dict:
        """ใส่ oco/expire ลงแถว pending ที่ส่งให้หน้าเว็บ"""
        t = order["ticket"]
        p = self.partner(t)
        if p is not None:
            order["oco"] = p
        if t in self.expire:
            order["expire"] = self.expire[t]
        return order

    # ----- งานต่อรอบ (เรียกจาก poller) -----
    def due(self, alive: set, filled, now: float | None = None) -> list[dict]:
        """คืนงานที่ต้องทำ [{"cancel": ticket, "why": "oco"|"expire", ...}] และล้างกฎที่หมดความหมาย
        alive = ticket pending ที่ยังอยู่, filled(ticket) -> True/False/None (None = ยังไม่รู้)"""
        now = now or time.time()
        jobs, changed = [], False
        with self._lock:
            keep = []
            for a, b in self.oco:
                gone = [t for t in (a, b) if t not in alive]
                if not gone:
                    keep.append([a, b])
                    continue
                if len(gone) == 2:
                    changed = True
                    continue
                x = gone[0]
                y = b if x == a else a
                f = filled(x)
                if f is None and now - self.gone_since.setdefault(x, now) < GONE_GRACE_SEC:
                    keep.append([a, b])     # รอ history
                    continue
                self.gone_since.pop(x, None)
                changed = True
                if f and self.fail_until.get(y, 0) <= now:
                    jobs.append({"cancel": y, "why": "oco", "filled": x})
                    keep.append([a, b])     # เก็บคู่ไว้จนยกเลิกสำเร็จ (done() ลบให้)
            if changed:
                self.oco = keep
            for t, ts in list(self.expire.items()):
                if t not in alive:
                    del self.expire[t]
                    changed = True
                elif now >= ts and self.fail_until.get(t, 0) <= now and not any(j["cancel"] == t for j in jobs):
                    jobs.append({"cancel": t, "why": "expire", "at": ts})
            if changed:
                self._save()
        return jobs

    def done(self, job: dict, ok: bool, now: float | None = None) -> None:
        t = job["cancel"]
        with self._lock:
            if ok:
                self.oco = [x for x in self.oco if t not in x]
                self.expire.pop(t, None)
                self.fail_until.pop(t, None)
                self._save()
            else:
                self.fail_until[t] = (now or time.time()) + RETRY_SEC
