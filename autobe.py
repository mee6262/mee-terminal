"""Auto BE (เลื่อน SL ไปจุดทุนอัตโนมัติ) — ค่าตั้งต่อบัญชี เก็บเป็นไฟล์ข้าง audit log ของ worker

ค่าตั้ง:
  on           เปิด/ปิด
  mode         "rr" = กำไรถึง rr × ระยะ SL เดิม | "points" = กำไรถึง points จุด (point ของ symbol)
  rr           เช่น 1.0 = กำไร 1R
  points       เช่น 300 (XAUUSD 2 digits: 300 จุด = $3.00)
  lock_points  ล็อกกำไรเพิ่มจากราคาเข้า (0 = ทุนพอดี) — ใช้กันค่าคอม/สเปรด
  symbols      [] = ทุก symbol, ไม่งั้นเฉพาะที่ระบุ
  per_symbol   {"XAUUSD": {"points": 300, "lock_points": 20}} ทับค่าหลักรายตัว (ระยะเป็นจุดต่างกันมากข้าม symbol)
"""
import json
import threading
import time
from collections import deque
from pathlib import Path

DEFAULT = {"on": False, "mode": "rr", "rr": 1.0, "points": 300, "lock_points": 0, "symbols": [], "per_symbol": {}}
RETRY_SEC = 60          # ไม้ที่เลื่อนไม่สำเร็จ รอเท่านี้ก่อนลองใหม่ (กันยิงรัวใส่โบรก)
MAX_SYMBOLS = 100


def _num(v, lo: float, hi: float, name: str) -> float:
    try:
        x = float(v)
    except (TypeError, ValueError):
        raise ValueError(f"{name} ต้องเป็นตัวเลข")
    if not (lo <= x <= hi):
        raise ValueError(f"{name} ต้องอยู่ระหว่าง {lo} ถึง {hi}")
    return x


def validate(raw: dict) -> dict:
    if not isinstance(raw, dict):
        raise ValueError("ค่าตั้งต้องเป็น object")
    cfg = {**DEFAULT}
    cfg["on"] = bool(raw.get("on", False))
    mode = raw.get("mode", "rr")
    if mode not in ("rr", "points"):
        raise ValueError("mode ต้องเป็น rr หรือ points")
    cfg["mode"] = mode
    cfg["rr"] = _num(raw.get("rr", DEFAULT["rr"]), 0.1, 20, "RR")
    cfg["points"] = _num(raw.get("points", DEFAULT["points"]), 1, 10_000_000, "ระยะ (จุด)")
    cfg["lock_points"] = _num(raw.get("lock_points", 0), 0, 10_000_000, "ล็อกกำไร (จุด)")
    syms = raw.get("symbols") or []
    if isinstance(syms, str):
        syms = [x.strip() for x in syms.split(",")]
    cfg["symbols"] = sorted({str(x).strip()[:32] for x in syms if str(x).strip()})[:MAX_SYMBOLS]
    per = {}
    for sym, o in list((raw.get("per_symbol") or {}).items())[:MAX_SYMBOLS]:
        if not isinstance(o, dict):
            continue
        item = {}
        if o.get("points") not in (None, ""):
            item["points"] = _num(o["points"], 1, 10_000_000, f"{sym} ระยะ")
        if o.get("lock_points") not in (None, ""):
            item["lock_points"] = _num(o["lock_points"], 0, 10_000_000, f"{sym} ล็อกกำไร")
        if o.get("rr") not in (None, ""):
            item["rr"] = _num(o["rr"], 0.1, 20, f"{sym} RR")
        if item:
            per[str(sym).strip()[:32]] = item
    cfg["per_symbol"] = per
    return cfg


def for_symbol(cfg: dict, symbol: str) -> dict | None:
    """ค่าที่ใช้กับ symbol นี้ (None = ไม่ครอบคลุม)"""
    # มีรายการ symbol = เฉพาะที่ระบุ — symbol ที่ตั้งค่ารายตัวไว้ (per_symbol) นับว่าเลือกแล้วด้วย
    # (เคยตั้ง symbols = BTCUSDc แต่ตั้งค่ารายตัว XAUUSDc ไว้ -> XAUUSDc ไม่เคยถูกเลื่อน)
    if cfg["symbols"] and symbol not in cfg["symbols"] and symbol not in cfg["per_symbol"]:
        return None
    return {**cfg, **cfg["per_symbol"].get(symbol, {})}


class AutoBE:
    def __init__(self, path: Path):
        self.path = path
        self._lock = threading.Lock()
        self.cfg = dict(DEFAULT)
        self.fail_until: dict[int, float] = {}   # ticket -> เวลาที่ลองใหม่ได้
        self.events: deque = deque(maxlen=200)   # เหตุการณ์ล่าสุด (ให้ตัวส่ง Telegram ดึง)
        self.seq = 0
        try:
            self.cfg = validate(json.loads(path.read_text(encoding="utf-8")))
        except (OSError, ValueError):
            pass

    def get(self) -> dict:
        with self._lock:
            return dict(self.cfg)

    def set(self, raw: dict) -> dict:
        cfg = validate(raw)
        with self._lock:
            self.cfg = cfg
            self.path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self.path.with_suffix(".tmp")
            tmp.write_text(json.dumps(cfg, ensure_ascii=False, indent=1), encoding="utf-8")
            tmp.replace(self.path)
            self.fail_until.clear()
        return cfg

    def can_try(self, ticket: int, now: float | None = None) -> bool:
        return self.fail_until.get(ticket, 0) <= (now or time.time())

    def failed(self, ticket: int, now: float | None = None) -> None:
        self.fail_until[ticket] = (now or time.time()) + RETRY_SEC

    def forget_missing(self, alive: set) -> None:
        for t in [t for t in self.fail_until if t not in alive]:
            del self.fail_until[t]

    def add_event(self, ev: dict) -> dict:
        with self._lock:
            self.seq += 1
            ev = {**ev, "seq": self.seq, "ts": time.time()}
            self.events.append(ev)
            return ev

    def events_after(self, seq: int) -> list:
        with self._lock:
            return [e for e in self.events if e["seq"] > seq]
