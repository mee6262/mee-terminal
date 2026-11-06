"""MetaTrader5 ใน process ลูก — กัน worker ค้างทั้งตัวเวลา MT5/โบรกไม่ตอบ

ปัญหาเดิม (2026-09-27): MetaTrader5 python ถือ GIL ระหว่างรอ terminal -> order_send รอโบรก 3 นาที = worker ค้างทั้ง process
(WebSocket หลุด, ราคาไม่เดิน). แก้: เรียก MT5 ใน process ลูก 2 ตัว
  mt5        = ข้อมูล (poller, กราฟ, ประวัติ, ตรวจคำสั่ง)
  mt5_trade  = ส่งคำสั่ง (order_send) — โบรกช้า = รอแค่ตัวนี้ ราคา/หน้าเว็บยังเดิน
process หลักรอผลผ่าน Pipe (ปล่อย GIL) — ลูกไม่ตอบเกินเวลา = kill แล้วเปิดใหม่ (คำสั่งต่อไปเชื่อม MT5 ใหม่เอง)

ใช้แทน `import MetaTrader5 as mt5` ได้เลย: ค่าคงที่ (ORDER_TYPE_BUY ฯลฯ) อ่านจาก module จริงในเครื่อง, ฟังก์ชันไปทำในลูก
- namedtuple ของ MT5 ส่งข้าม process เป็นโครงเดียวกัน (อ่าน .ticket / ._asdict() ได้เหมือนเดิม)
- เทสต์บน Mac (fake_mt5) หรือ env WT_MT5_INPROC=1 = เรียกตรงใน process เดิม (แบบเก่า)
"""
import collections
import logging
import multiprocessing as mp
import os
import threading

try:
    import MetaTrader5 as _real
except ImportError:          # process ลูกของเทสต์ (Mac ไม่มี MetaTrader5) — ใช้ module ที่ส่งชื่อมาแทน
    _real = None

log = logging.getLogger("wt.worker")

INPROC = os.environ.get("WT_MT5_INPROC") == "1" or _real is None or hasattr(_real, "reset")   # fake_mt5 มี reset()
SUBPROC = not INPROC
DATA_TIMEOUT = 60.0        # วินาที: เกินนี้ถือว่าลูกค้าง -> kill (initialize มี timeout 20 วิของมันเองอยู่แล้ว)
TRADE_TIMEOUT = 300.0      # order_send รอโบรกได้นาน (เจอจริง 3 นาที) — เกินนี้ kill + แจ้ง "ไม่รู้ผล"


class MT5Timeout(RuntimeError):
    """ลูกไม่ตอบภายในเวลาที่กำหนด (ถูก kill แล้ว) — ผลของคำสั่งที่ค้างอยู่ไม่รู้"""


# ---------- ส่ง namedtuple ข้าม process ----------
_NT = "__nt__"


def _fields_of(v):
    """ชื่อฟิลด์ของ namedtuple (Python) หรือ structseq (C — แบบที่ MetaTrader5 ใช้จริง เช่น AccountInfo, TradePosition)"""
    if not isinstance(v, tuple):
        return None
    t = type(v)
    f = getattr(t, "_fields", None) or getattr(t, "__match_args__", None)
    return tuple(f) if f else None


def _pack(v):
    f = _fields_of(v)
    if f:
        return (_NT, type(v).__name__, f, tuple(_pack(getattr(v, k)) for k in f))
    if isinstance(v, tuple):
        return tuple(_pack(x) for x in v)
    if isinstance(v, list):
        return [_pack(x) for x in v]
    return v


_nt_types: dict = {}


def _unpack(v):
    if isinstance(v, tuple) and len(v) == 4 and v[0] == _NT:
        key = (v[1], v[2])
        cls = _nt_types.get(key)
        if cls is None:
            cls = _nt_types[key] = collections.namedtuple(v[1], v[2])
        return cls(*(_unpack(x) for x in v[3]))
    if isinstance(v, tuple):
        return tuple(_unpack(x) for x in v)
    if isinstance(v, list):
        return [_unpack(x) for x in v]
    return v


# ---------- process ลูก ----------
def _child(conn, module_name: str) -> None:
    import importlib
    m = importlib.import_module(module_name)
    init_kw = None
    while True:
        try:
            op, name, args, kw = conn.recv()
        except (EOFError, OSError):
            return
        try:
            if op == "init_kw":
                init_kw = args[0]
                res = True
            else:
                if op == "call_ensure" and init_kw is not None and m.terminal_info() is None:
                    # ลูกส่งคำสั่ง: เชื่อม terminal เองก่อนใช้ (หลังเปิดใหม่/terminal restart) — ไม่สำเร็จ = ไม่ส่งคำสั่งเลย
                    if not m.initialize(**init_kw):
                        conn.send(("err", f"MT5Init: process ส่งคำสั่งเชื่อม terminal ไม่ได้ {m.last_error()}"))
                        continue
                fn = getattr(m, name)
                # ห้ามส่ง **{} ว่างไป: CPython ส่ง dict ว่างให้ฟังก์ชัน C -> MetaTrader5 order_send/order_check
                # ถือว่าเป็นการเรียกแบบ keyword แล้วปฏิเสธ request ที่ส่งแบบ positional: (-2, 'Unnamed arguments not allowed')
                res = fn(*args, **kw) if kw else fn(*args)
            # ผลว่าง (None) = ดู last_error ของ process นี้ทันที (process อื่นไม่รู้ error ของลูกตัวนี้)
            conn.send(("ok", _pack(res), _pack(m.last_error()) if res is None and hasattr(m, "last_error") else None))
        except Exception as e:  # ส่งกลับให้ฝั่งแม่ raise ต่อ
            conn.send(("err", f"{type(e).__name__}: {e}"))


class Proxy:
    def __init__(self, label: str, timeout: float, module: str = "MetaTrader5", ensure: bool = False):
        self._label, self._timeout, self._module, self._ensure = label, timeout, module, ensure
        self._lock = threading.Lock()
        self._proc = None
        self._conn = None
        self._init_kw = None
        self.none_error = None     # last_error ของลูก ตอนคำสั่งล่าสุดคืน None

    # ----- lifecycle -----
    def _start(self):
        ctx = mp.get_context("spawn")
        parent, child = ctx.Pipe()
        p = ctx.Process(target=_child, args=(child, self._module), daemon=True, name=f"mt5-{self._label}")
        p.start()
        child.close()
        self._proc, self._conn = p, parent
        log.info("mt5 %s: เปิด process ลูก pid=%s", self._label, p.pid)
        if self._init_kw is not None:
            self._send_recv("init_kw", "", (self._init_kw,), {}, 10.0)

    def _kill(self):
        p, self._proc = self._proc, None
        try:
            if self._conn:
                self._conn.close()
        except OSError:
            pass
        self._conn = None
        if p is not None and p.is_alive():
            p.kill()
            p.join(5)

    def close(self):
        with self._lock:
            self._kill()

    def pid(self):
        return self._proc.pid if self._proc is not None and self._proc.is_alive() else None

    def set_init(self, kw: dict) -> None:
        """ค่า initialize (path/portable/timeout) — ลูกส่งคำสั่งใช้เชื่อม terminal เอง"""
        self._init_kw = dict(kw)
        with self._lock:
            if self._proc is not None and self._proc.is_alive():
                try:
                    self._send_recv("init_kw", "", (self._init_kw,), {}, 10.0)
                except MT5Timeout:
                    pass

    # ----- call -----
    def _send_recv(self, op, name, args, kw, timeout):
        try:
            self._conn.send((op, name, args, kw))
            ready = self._conn.poll(timeout)
        except (OSError, EOFError, BrokenPipeError):
            ready = False
        if not ready:
            log.error("mt5 %s: %s ไม่ตอบใน %.0f วินาที -> kill process ลูก", self._label, name or op, timeout)
            self._kill()
            raise MT5Timeout(f"MT5 ({self._label}) ไม่ตอบใน {timeout:.0f} วินาที ขณะ {name or op}")
        try:
            msg = self._conn.recv()
        except (EOFError, OSError):
            self._kill()
            raise MT5Timeout(f"process MT5 ({self._label}) ปิดไประหว่าง {name}")
        if msg[0] == "err":
            raise RuntimeError(msg[1])
        self.none_error = msg[2] if len(msg) > 2 else None
        return _unpack(msg[1])

    def call(self, name, args=(), kw=None, timeout=None):
        with self._lock:
            if self._proc is None or not self._proc.is_alive():
                self._kill()
                self._start()
            return self._send_recv("call_ensure" if self._ensure else "call", name, tuple(args), kw or {},
                                   timeout or self._timeout)

    def __getattr__(self, name):
        attr = getattr(_real, name)
        if not callable(attr) or isinstance(attr, type):
            return attr

        def fn(*args, **kw):
            return self.call(name, args, kw)
        fn.__name__ = name
        return fn


class _Direct:
    """โหมดเดิม: เรียก module ตรง (เทสต์ / WT_MT5_INPROC=1) — อ่าน attribute ทุกครั้ง เทสต์ monkeypatch ได้"""

    def __getattr__(self, name):
        return getattr(_real, name)

    def set_init(self, kw):
        pass

    @property
    def none_error(self):
        return _real.last_error()

    def pid(self):
        return os.getpid()

    def close(self):
        pass


if SUBPROC:
    mt5 = Proxy("data", DATA_TIMEOUT)
    mt5_trade = Proxy("trade", TRADE_TIMEOUT, ensure=True)
else:
    mt5 = _Direct()
    mt5_trade = mt5
