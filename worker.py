"""web_terminal worker — เจ้าของ MT5 connection ของ 1 บัญชี (WEB_TERMINAL_PLAN.md P1)

รัน: WT_ACCOUNT=demo WT_WORKER_KEY=... uvicorn worker:app --host 127.0.0.1 --port <port จาก accounts.json>
- เรียก MT5 ทุกครั้งผ่าน _mt5_lock (MetaTrader5 python ไม่ thread-safe)
- poller thread เดียว: tick ของ symbol ที่มีคนดู (throttle ≤10/วินาที/symbol) + account/positions/orders ทุก 500ms ส่งเมื่อเปลี่ยน
- ทุก request ต้องมี header X-Worker-Key ตรงกับ WT_WORKER_KEY (กัน process อื่นในเครื่องยิงเข้ามา)
"""
import asyncio
import hmac
import json
import logging
import ntpath
import os
import threading
import time
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from dataclasses import dataclass, field
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse

import mt5proc
from mt5proc import mt5

from accounts import load_accounts
from autobe import AutoBE, for_symbol
from pending_rules import PendingRules
from trading import TradeError, Trader, _c, autobe_target

EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)
TICK_MIN_INTERVAL = 0.1     # วินาที/symbol
STATE_INTERVAL = 0.5        # account/positions/orders
BAR_INTERVAL = 0.25         # แท่งล่าสุดของกราฟที่เปิดอยู่ (copy_rates 2 แท่ง = ตรงกับ MT5 100%)
MAX_BAR_SUBS = 8            # (symbol, tf) ต่อ client
RATES_SYNC_TRIES, RATES_SYNC_WAIT = 9, 0.5   # /rates: รอ MT5 โหลดประวัติที่ขาด (แท่งล่าสุดเก่ากว่า tick) สูงสุด ~4 วินาที
STATUS_INTERVAL = 2.0
DAY_INTERVAL = 10.0         # สรุปกำไรวันนี้ (history_deals_get)
DEFAULT_DAY_RESET = "00:00 Asia/Bangkok"
DEALS_MAX_SEC = 7 * 86400
POLL_INTERVAL = 0.05
RECONNECT_BACKOFF = (1, 2, 5, 10, 30)
CLIENT_QUEUE_MAX = 2000
INIT_TIMEOUT_MS = 20000     # MetaTrader5 ถือ GIL ระหว่าง initialize -> ทั้ง process ค้างตามนี้ ต้องสั้น

TIMEFRAMES = {
    "M1": "TIMEFRAME_M1", "M5": "TIMEFRAME_M5", "M15": "TIMEFRAME_M15", "M30": "TIMEFRAME_M30",
    "H1": "TIMEFRAME_H1", "H4": "TIMEFRAME_H4", "D1": "TIMEFRAME_D1", "W1": "TIMEFRAME_W1",
    "MN1": "TIMEFRAME_MN1",
}
TF_MINUTES = {"M1": 1, "M5": 5, "M15": 15, "M30": 30, "H1": 60, "H4": 240, "D1": 1440, "W1": 10080, "MN1": 43200}
LTF_MAX_TIMES = 300


def ltf_seconds(tf: str) -> int:
    """TF ย่อยแบบ Pine VP Order Blocks: round(นาทีของกราฟ/15) นาที, ต่ำกว่า 1 = 30 วินาที"""
    n = round(TF_MINUTES[tf] / 15)
    return 30 if n < 1 else n * 60


DEAL_BUY, DEAL_SELL = 0, 1
ENTRY_IN, ENTRY_OUT, ENTRY_INOUT, ENTRY_OUT_BY = 0, 1, 2, 3
HISTORY_MAX_DAYS = 400
HISTORY_LOOKBACK_DAYS = 45     # หา deal เข้าของไม้ที่เปิดก่อนช่วง: ดึงย้อนทีเดียว (เร็ว) แทนการถามทีละไม้
HISTORY_PER_POSITION_MAX = 30  # ที่ยังหาไม่เจอจริงๆ ค่อยถามทีละไม้ (MT5 ถือ GIL ทุกครั้ง — ถามเยอะ = worker ค้างทั้งตัว)


def deal_cost(d) -> float:
    return float(d.profit) + float(d.commission) + float(d.swap) + float(getattr(d, "fee", 0.0) or 0.0)


def aggregate_deals(deals, offset_s: int = 0) -> dict:
    """รวม deal ของ MT5 เป็นรายไม้ (position_id) + รายการฝาก/ถอน
    - ราคาเข้า/ออก = เฉลี่ยถ่วงด้วย volume, เวลาเข้า = deal เข้าแรก, เวลาออก = deal ออกสุดท้าย
    - net = profit + commission + swap + fee ของทุก deal ในไม้
    - ปิดครบ (volume ออก ≥ เข้า) = closed, ไม่งั้น open (ปิดบางส่วน)"""
    pos: dict[int, dict] = {}
    balance = []
    for d in sorted(deals, key=lambda x: (x.time_msc, x.ticket)):
        t = int(d.time_msc) // 1000 - offset_s
        if d.type not in (DEAL_BUY, DEAL_SELL):
            balance.append({"ticket": d.ticket, "time": t, "type": int(d.type), "amount": deal_cost(d), "comment": d.comment})
            continue
        p = pos.setdefault(int(d.position_id), {
            "position_id": int(d.position_id), "symbol": d.symbol, "side": None, "magic": int(d.magic),
            "vol_in": 0.0, "vol_out": 0.0, "px_in": 0.0, "px_out": 0.0, "time_open": None, "time_close": None,
            "commission": 0.0, "swap": 0.0, "fee": 0.0, "profit": 0.0, "comment": "", "deals": 0, "reversed": False,
        })
        p["deals"] += 1
        p["commission"] += float(d.commission)
        p["swap"] += float(d.swap)
        p["fee"] += float(getattr(d, "fee", 0.0) or 0.0)
        p["profit"] += float(d.profit)
        v, px = float(d.volume), float(d.price)
        if d.entry == ENTRY_IN:
            if p["side"] is None:
                p["side"] = "buy" if d.type == DEAL_BUY else "sell"
                p["time_open"] = t
                p["comment"] = d.comment
            p["px_in"] = (p["px_in"] * p["vol_in"] + px * v) / (p["vol_in"] + v)
            p["vol_in"] += v
        else:
            if d.entry == ENTRY_INOUT:
                p["reversed"] = True
            p["px_out"] = (p["px_out"] * p["vol_out"] + px * v) / (p["vol_out"] + v)
            p["vol_out"] += v
            p["time_close"] = t
    trades = []
    for p in pos.values():
        p["net"] = round(p["profit"] + p["commission"] + p["swap"] + p["fee"], 2)
        p["closed"] = p["vol_out"] > 0 and p["vol_out"] >= p["vol_in"] - 1e-9
        for k in ("commission", "swap", "fee", "profit"):
            p[k] = round(p[k], 2)
        p["vol_in"], p["vol_out"] = round(p["vol_in"], 8), round(p["vol_out"], 8)
        trades.append(p)
    trades.sort(key=lambda x: (x["time_close"] or x["time_open"] or 0), reverse=True)
    return {"trades": trades, "balance": balance}


def bucket_bars(rows, t0: int, step: int) -> list:
    """rows = [(t_utc, high, low, vol)] -> [[h, l, v], ...] ตามช่วง step วินาทีนับจาก t0 (เรียงตามเวลา)"""
    out: dict[int, list] = {}
    for t, hi, lo, v in rows:
        k = (t - t0) // step
        if k < 0:
            continue
        b = out.get(k)
        if b is None:
            out[k] = [hi, lo, v]
        else:
            b[0] = max(b[0], hi); b[1] = min(b[1], lo); b[2] += v
    return [out[k] for k in sorted(out)]

_mt5_lock = threading.RLock()      # ข้อมูล (poller + endpoint อ่าน)
_trade_lock = threading.Lock()     # ส่งคำสั่ง: ทีละคำสั่ง — โหมด process ลูก ไม่ต้องถือ _mt5_lock ระหว่างรอโบรก
log = logging.getLogger("wt.worker")
if not log.handlers:
    _h = logging.StreamHandler()
    _h.setFormatter(logging.Formatter("%(levelname)s: [worker] %(message)s"))
    log.addHandler(_h)
    log.setLevel(logging.INFO)
    log.propagate = False


def _account_dict(a) -> dict:
    return {
        "login": a.login, "server": a.server, "name": a.name, "currency": a.currency,
        "leverage": a.leverage, "balance": a.balance, "equity": a.equity, "margin": a.margin,
        "margin_free": a.margin_free, "margin_level": a.margin_level, "profit": a.profit,
        "trade_mode": a.trade_mode,  # 0 demo, 1 contest, 2 real
    }


def _position_dict(p) -> dict:
    return {
        "ticket": p.ticket, "symbol": p.symbol, "type": p.type, "volume": p.volume,
        "price_open": p.price_open, "price_current": p.price_current, "sl": p.sl, "tp": p.tp,
        "profit": p.profit, "swap": p.swap, "magic": p.magic, "comment": p.comment, "time": p.time,
    }


def _order_dict(o) -> dict:
    return {
        "ticket": o.ticket, "symbol": o.symbol, "type": o.type, "volume": o.volume_current,
        "price_open": o.price_open, "sl": o.sl, "tp": o.tp, "magic": o.magic,
        "comment": o.comment, "time": o.time_setup,
    }


def _quiet_disconnects(loop) -> None:
    """Windows (Proactor): ปลายทางปิด socket ก่อน -> asyncio พิมพ์ traceback ConnectionResetError/"socket.send() raised
    exception" รัวๆ ทั้งที่ไม่มีอะไรเสีย (worker ยังทำงาน) — ปิดเสียงเฉพาะกรณีนี้ ที่เหลือพิมพ์ตามปกติ"""
    logging.getLogger("asyncio").setLevel(logging.ERROR)
    default = loop.get_exception_handler()

    def handler(lp, ctx):
        if isinstance(ctx.get("exception"), (ConnectionResetError, ConnectionAbortedError, BrokenPipeError)):
            return
        if default:
            default(lp, ctx)
        else:
            lp.default_exception_handler(ctx)
    loop.set_exception_handler(handler)


def rates_to_list(data, offset_s: int = 0) -> list:
    """[[t_utc, o, h, l, c, tick_vol], ...] — MT5 ให้เวลาเป็นเวลา server ลบ offset ให้เป็น UTC จริง"""
    return [[int(r["time"]) - offset_s, float(r["open"]), float(r["high"]), float(r["low"]),
             float(r["close"]), int(r["tick_volume"])] for r in data]


class MT5Bridge:
    """ต่อ/ต่อใหม่ MT5 + เช็คบัญชีตรง config (fail closed)"""

    def __init__(self, account: dict):
        self.account = account
        self.connected = False
        self.error = "ยังไม่ได้เชื่อมต่อ"
        self._next_try = 0.0
        self._fails = 0

    def ensure(self) -> bool:
        """เรียกใต้ _mt5_lock เท่านั้น — process ลูกค้าง/ตาย = ถือว่าหลุด รอบหน้าเชื่อมใหม่ใน process ใหม่"""
        try:
            return self._ensure()
        except Exception as e:   # process ลูกค้าง / ข้อมูลผิดรูป — ห้ามวน initialize ทุก request: พักตาม backoff
            self.connected, self.error = False, f"เชื่อม MT5 ผิดพลาด: {e!r}"
            log.error("MT5 ensure: %r", e)
            self._next_try = time.monotonic() + RECONNECT_BACKOFF[min(self._fails, len(RECONNECT_BACKOFF) - 1)]
            self._fails += 1
            return False

    def _ensure(self) -> bool:
        if self.connected and mt5.terminal_info() is not None:
            return True
        self.connected = False
        now = time.monotonic()
        if now < self._next_try:
            return False
        path = self.account["terminal_path"]
        portable = bool(self.account.get("portable"))
        log.info("MT5 initialize(path=%s, portable=%s) ครั้งที่ %d ...", path, portable, self._fails + 1)
        t0 = time.monotonic()
        ok = mt5.initialize(path=path, portable=portable, timeout=INIT_TIMEOUT_MS)
        took = time.monotonic() - t0
        if ok:
            term = mt5.terminal_info()
            info = mt5.account_info()
            want = self.account.get("login")
            want_dir = ntpath.normcase(ntpath.dirname(path))
            got_dir = ntpath.normcase(getattr(term, "path", "") or "")
            if term is not None and got_dir and got_dir != want_dir:
                # initialize(path) อาจไปเกาะ terminal ตัวอื่นที่เปิดอยู่ (บทเรียนจาก standard_daytrade_live.py)
                ok, self.error = False, f"ต่อได้ terminal ผิดตัว: {term.path} (ต้องการ {ntpath.dirname(path)})"
                mt5.shutdown()
            elif info is None:
                ok, self.error = False, "terminal เปิดอยู่แต่ไม่ได้ล็อกอินบัญชี"
            elif want and info.login != want:
                ok, self.error = False, f"terminal ล็อกอินบัญชี {info.login} ไม่ตรงกับ config {want}"
                mt5.shutdown()
        else:
            self.error = f"initialize ล้มเหลว: {mt5.last_error()}"
        if ok:
            mt5proc.mt5_trade.set_init({"path": path, "portable": portable, "timeout": INIT_TIMEOUT_MS})
            log.info("MT5 เชื่อมต่อแล้ว login=%s ใช้เวลา %.1fs", info.login, took)
            self.connected, self.error, self._fails = True, "", 0
            return True
        log.warning("MT5 ไม่สำเร็จ (%.1fs): %s", took, self.error)
        self._next_try = now + RECONNECT_BACKOFF[min(self._fails, len(RECONNECT_BACKOFF) - 1)]
        self._fails += 1
        return False


@dataclass(eq=False)
class Client:
    queue: asyncio.Queue
    loop: asyncio.AbstractEventLoop
    symbols: set = field(default_factory=set)
    bars: set = field(default_factory=set)   # {(symbol, tf)}
    dead: bool = False


class Hub:
    """ส่ง event จาก poller thread เข้า asyncio queue ของแต่ละ client"""

    def __init__(self):
        self._lock = threading.Lock()
        self.clients: set[Client] = set()

    def add(self, c: Client):
        with self._lock:
            self.clients.add(c)

    def remove(self, c: Client):
        with self._lock:
            self.clients.discard(c)

    def symbols(self) -> set:
        with self._lock:
            out = set()
            for c in self.clients:
                out |= c.symbols
            return out

    def bar_keys(self) -> set:
        with self._lock:
            out = set()
            for c in self.clients:
                out |= c.bars
            return out

    def send(self, msg: dict, symbol: str | None = None, bar_key: tuple | None = None):
        data = json.dumps(msg, separators=(",", ":"))
        with self._lock:
            if bar_key is not None:
                targets = [c for c in self.clients if bar_key in c.bars]
            else:
                targets = [c for c in self.clients if symbol is None or symbol in c.symbols]
        for c in targets:
            c.loop.call_soon_threadsafe(_put, c, data)


def _put(c: Client, data: str):
    if c.dead:
        return
    try:
        c.queue.put_nowait(data)
    except asyncio.QueueFull:
        c.dead = True  # client ช้าเกิน -> ตัดทิ้ง ให้ต่อใหม่แล้วได้ snapshot สด
        c.queue._queue.clear()  # noqa: SLF001
        c.queue.put_nowait(None)


class Poller(threading.Thread):
    def __init__(self, bridge: MT5Bridge, hub: Hub):
        super().__init__(daemon=True, name="mt5-poller")
        self.bridge, self.hub = bridge, hub
        self.stop_evt = threading.Event()
        self.snapshot: dict[str, dict] = {}   # account/positions/orders ล่าสุดที่ส่งไป
        self._last_state_sig: dict[str, str] = {}
        self._tick_sent: dict[str, tuple] = {}    # symbol -> (bid, ask, sent_monotonic)
        self._selected: set[str] = set()
        self._bad_symbols: set[str] = set()
        self._bar_sent: dict[tuple, tuple] = {}   # (symbol, tf) -> signature แท่งล่าสุดที่ส่งไป
        self._next_bars = 0.0
        self.offset_s = int(float(bridge.account.get("server_utc_offset_h") or 0) * 3600)
        self.offset_est_h: float | None = None     # ประมาณจาก tick สด: เวลา server - UTC จริง
        self.trader: Trader | None = None          # ตั้งหลังสร้าง (create_app)
        self.autobe: AutoBE | None = None
        self.prules: PendingRules | None = None
        self.day_reset = DEFAULT_DAY_RESET
        self._risk_cache: dict[tuple, float | None] = {}
        self._next_day = 0.0
        self.boot = int(time.time())
        self.trade_since = 0.0                     # กำลังรอผลคำสั่งจากโบรกตั้งแต่เมื่อไหร่ (0 = ไม่มี)
        self.last_poll = 0.0

    def run(self):
        next_state = next_status = 0.0
        while not self.stop_evt.is_set():
            t0 = time.monotonic()
            try:
                self.poll_once(t0, t0 >= next_state, t0 >= next_status)
            except Exception as e:  # poller ต้องไม่ตาย
                self.hub.send({"type": "error", "message": f"poller: {e!r}"})
            if t0 >= next_state:
                next_state = t0 + STATE_INTERVAL
            if t0 >= next_status:
                next_status = t0 + STATUS_INTERVAL
            self.stop_evt.wait(max(0.0, POLL_INTERVAL - (time.monotonic() - t0)))

    def poll_once(self, now: float, do_state: bool, do_status: bool):
        with _mt5_lock:
            ok = self.bridge.ensure()
            if ok:
                self._poll_ticks(now)
                if now >= self._next_bars:
                    self._next_bars = now + BAR_INTERVAL
                    self._poll_bars()
                if do_state:
                    self._poll_state()
                if now >= self._next_day and self.trader is not None:
                    self._next_day = now + DAY_INTERVAL
                    self._poll_day()
            self.last_poll = time.time()
        if do_status:
            self.hub.send(self.status())

    def status(self) -> dict:
        return {"type": "status", "mt5": self.bridge.connected, "error": self.bridge.error,
                "account": self.bridge.account["name"], "t": int(time.time() * 1000),
                "server_utc_offset_h": self.offset_s / 3600, "server_offset_est_h": self.offset_est_h,
                "autobe": bool(self.autobe and self.autobe.cfg.get("on")), "boot": self.boot,
                "trading": bool(self.bridge.account.get("trading")), "allow_real": bool(self.bridge.account.get("allow_real")),
                "mt5_mode": "subprocess" if mt5proc.SUBPROC else "inproc",
                "trade_wait_s": round(time.time() - self.trade_since) if self.trade_since else None}

    def _poll_ticks(self, now: float):
        for sym in self.hub.symbols():
            if sym in self._bad_symbols:
                continue
            if sym not in self._selected:
                if mt5.symbol_info(sym) is None or not mt5.symbol_select(sym, True):
                    self._bad_symbols.add(sym)
                    self.hub.send({"type": "error", "symbol": sym, "message": f"ไม่พบ symbol {sym}"}, symbol=sym)
                    continue
                self._selected.add(sym)
            t = mt5.symbol_info_tick(sym)
            if t is None:
                continue
            prev = self._tick_sent.get(sym)
            if prev and prev[0] == t.bid and prev[1] == t.ask:
                continue
            if prev and now - prev[2] < TICK_MIN_INTERVAL:
                continue  # ค่าล่าสุดจะถูกส่งรอบถัดไปที่พ้น throttle
            self._tick_sent[sym] = (t.bid, t.ask, now)
            lag = t.time_msc / 1000 - time.time()
            if abs(lag - round(lag / 1800) * 1800) < 120:   # tick สด (ห่างจากครึ่งชั่วโมงเต็ม < 2 นาที)
                self.offset_est_h = round(lag / 1800) / 2
            self.hub.send({"type": "tick", "symbol": sym, "bid": t.bid, "ask": t.ask,
                           "time_msc": t.time_msc}, symbol=sym)

    def _poll_state(self):
        acc = mt5.account_info()
        want = self.bridge.account.get("login")
        if acc is not None and want and acc.login != want:
            # เปลี่ยนบัญชีใน terminal ระหว่างทำงาน แต่ config ล็อกเลขบัญชีไว้ -> หยุด (Auto BE/OCO/คำสั่ง ต้องไม่ไปโดนบัญชีอื่น)
            self.bridge.connected = False
            self.bridge.error = f"terminal เปลี่ยนเป็นบัญชี {acc.login} ไม่ตรงกับที่ล็อกไว้ {want} — แก้ใน ตั้งค่า > บัญชี MT5"
            log.warning(self.bridge.error)
            mt5.shutdown()
            return
        pos = mt5.positions_get()
        ords = mt5.orders_get()
        state = {}
        if acc is not None:
            state["account"] = _account_dict(acc)
        if pos is not None:
            if self.autobe is not None and self.trader is not None and self.autobe.cfg.get("on"):
                pos = self._run_autobe(pos)
            rows = []
            keep = {}
            for p in pos:
                d = _position_dict(p)
                k = (p.ticket, p.sl, p.volume, p.price_open)
                if k not in self._risk_cache and self.trader is not None:
                    self._risk_cache[k] = self.trader.position_risk(p)
                d["risk"] = keep[k] = self._risk_cache.get(k)
                rows.append(d)
            self._risk_cache = keep
            state["positions"] = sorted(rows, key=lambda x: x["ticket"])
        if ords is not None:
            if self.prules is not None and self.trader is not None and not self.prules.empty():
                ords = self._run_prules(ords, pos)
            ann = self.prules.annotate if self.prules is not None else (lambda d: d)
            state["orders"] = sorted((ann(_order_dict(o)) for o in ords), key=lambda x: x["ticket"])
        for kind, data in state.items():
            sig = json.dumps(data, sort_keys=True)
            if self._last_state_sig.get(kind) != sig:
                self._last_state_sig[kind] = sig
                self.snapshot[kind] = data
                self.hub.send({"type": kind, "data": data})

    def _run_autobe(self, positions):
        """เลื่อน SL ไปจุดทุนเมื่อถึงเงื่อนไข — คืน positions ชุดใหม่ถ้ามีการแก้ (ให้ตารางเห็น SL ใหม่ทันที)"""
        cfg = self.autobe.get()
        self.autobe.forget_missing({p.ticket for p in positions})
        try:
            self.trader.require_trading()   # บัญชีเทรดไม่ได้ (trading false / REAL ไม่ allow) = ไม่ทำอะไร ไม่แจ้งรัว
        except TradeError:
            return positions
        changed = False
        for p in positions:
            c = for_symbol(cfg, p.symbol)
            if c is None or not self.autobe.can_try(p.ticket):
                continue
            info = mt5.symbol_info(p.symbol)
            t = mt5.symbol_info_tick(p.symbol)
            if info is None or t is None or not t.bid or not t.ask:
                continue
            side = "buy" if p.type == 0 else "sell"
            target = autobe_target(c, side, p.price_open, p.sl, t.bid, t.ask, info.point)
            if target is None:
                continue
            try:
                res = self.trader.breakeven_one(p, float(c.get("lock_points") or 0))
            except TradeError as e:
                res = {"ok": False, "message": str(e)}
            if not res.get("ok"):
                self.autobe.failed(p.ticket)
            elif not res.get("skipped"):
                changed = True
            ev = self.autobe.add_event({"ticket": p.ticket, "symbol": p.symbol, "side": side, "volume": p.volume,
                                        "open": p.price_open, "old_sl": p.sl, "sl": res.get("sl", target),
                                        "ok": bool(res.get("ok")), "message": res.get("message", ""),
                                        "mode": c["mode"], "rr": c["rr"], "points": c["points"]})
            self.trader.audit("autobe", {"ticket": p.ticket, "symbol": p.symbol, "cfg": c}, res, "worker")
            log.info("autobe #%s %s -> %s %s", p.ticket, p.symbol, res.get("retcode"), res.get("message"))
            self.hub.send({"type": "autobe", "data": ev})
        return (mt5.positions_get() or positions) if changed else positions

    def _order_filled(self, ticket: int, positions) -> bool | None:
        """pending ที่หายไป fill ไหม: มี position ที่เกิดจากมัน = fill, history บอกสถานะ, ไม่งั้น None (ยังไม่รู้)"""
        if any(getattr(p, "identifier", p.ticket) == ticket for p in positions or ()):
            return True
        h = mt5.history_orders_get(ticket=ticket)
        if not h:
            return None
        st = h[0].state
        if st in (_c("ORDER_STATE_FILLED"), _c("ORDER_STATE_PARTIAL")):
            return True
        return False if st in (_c("ORDER_STATE_CANCELED"), _c("ORDER_STATE_EXPIRED"), _c("ORDER_STATE_REJECTED")) else None

    def _run_prules(self, ords, positions):
        """OCO + หมดอายุ (worker ยกเลิกเอง) — คืน orders ชุดใหม่ถ้ามีการยกเลิก"""
        try:
            self.trader.require_trading()
        except TradeError:
            return ords
        by_ticket = {o.ticket: o for o in ords}
        jobs = self.prules.due(set(by_ticket), lambda t: self._order_filled(t, positions))
        changed = False
        for job in jobs:
            o = by_ticket.get(job["cancel"])
            try:
                res = self.trader.cancel_order({"ticket": job["cancel"]})
            except TradeError as e:
                res = {"ok": False, "message": str(e)}
            ok = bool(res.get("ok"))
            self.prules.done(job, ok)
            changed = changed or ok
            ev = self.autobe.add_event({"kind": job["why"], "ticket": job["cancel"], "filled": job.get("filled"),
                                        "symbol": getattr(o, "symbol", ""), "type": getattr(o, "type", None),
                                        "volume": getattr(o, "volume_current", None), "price": getattr(o, "price_open", None),
                                        "ok": ok, "message": res.get("message", "")})
            self.trader.audit(f"prules/{job['why']}", job, res, "worker")
            log.info("prules %s #%s -> %s %s", job["why"], job["cancel"], res.get("retcode"), res.get("message"))
            self.hub.send({"type": "prule", "data": ev})
        return (mt5.orders_get() or ()) if changed else ords

    def _poll_day(self):
        try:
            data = self.trader.day_summary(self.day_reset)
        except Exception as e:  # สรุปวันไม่ควรทำให้ poller ล้ม
            log.warning("day summary: %r", e)
            return
        sig = json.dumps(data, sort_keys=True)
        if self._last_state_sig.get("day") != sig:
            self._last_state_sig["day"] = sig
            self.snapshot["day"] = data
            self.hub.send({"type": "day", "data": data})

    def _poll_bars(self):
        for key in self.hub.bar_keys():
            sym, tf = key
            if sym in self._bad_symbols:
                continue
            if sym not in self._selected:
                if mt5.symbol_info(sym) is None or not mt5.symbol_select(sym, True):
                    self._bad_symbols.add(sym)
                    continue
                self._selected.add(sym)
            data = mt5.copy_rates_from_pos(sym, getattr(mt5, TIMEFRAMES[tf]), 0, 2)
            if data is None or len(data) == 0:
                continue
            bars = rates_to_list(data, self.offset_s)
            sig = tuple(bars[-1])
            if self._bar_sent.get(key) == sig:
                continue
            self._bar_sent[key] = sig
            self.hub.send({"type": "bars", "symbol": sym, "tf": tf, "bars": bars}, bar_key=key)

    def force_state(self):
        """หลังส่งคำสั่ง: poll account/positions/orders ทันที ไม่ต้องรอรอบ 500ms"""
        self._poll_state()
        self._next_day = 0.0

    def forget_bars(self, key: tuple):
        self._bar_sent.pop(key, None)

    def forget_symbol(self, sym: str):
        """ให้ tick แรกของ client ใหม่ส่งทันทีแม้ราคาไม่เปลี่ยน"""
        self._tick_sent.pop(sym, None)


async def _json_body(request: Request) -> dict:
    try:
        body = await request.json()
    except ValueError:
        raise HTTPException(status_code=400, detail="body ต้องเป็น JSON")
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="body ต้องเป็น object")
    return body


def create_app(account_name: str | None = None, worker_key: str | None = None,
               start_poller: bool = True) -> FastAPI:
    account_name = account_name or os.environ.get("WT_ACCOUNT", "")
    worker_key = worker_key if worker_key is not None else os.environ.get("WT_WORKER_KEY", "")
    if len(worker_key) < 16:
        raise RuntimeError("WT_WORKER_KEY ต้องยาว ≥16 ตัวอักษร")
    accounts = load_accounts()
    if account_name not in accounts:
        raise RuntimeError(f"ไม่พบบัญชี {account_name!r} ใน accounts.json")

    bridge = MT5Bridge(accounts[account_name])
    hub = Hub()
    poller = Poller(bridge, hub)
    @asynccontextmanager
    async def lifespan(_app):
        _quiet_disconnects(asyncio.get_running_loop())
        log.info("MT5 โหมด: %s", "process ลูก (data + trade)" if mt5proc.SUBPROC else "ใน process เดียว (WT_MT5_INPROC)")
        if start_poller:
            poller.start()
        yield
        poller.stop_evt.set()
        mt5proc.mt5.close()
        mt5proc.mt5_trade.close()

    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)
    app.state.poller = poller

    def key_ok(value: str | None) -> bool:
        return value is not None and hmac.compare_digest(value, worker_key)

    @app.middleware("http")
    async def require_key(request: Request, call_next):
        if not key_ok(request.headers.get("x-worker-key")):
            return JSONResponse({"detail": "forbidden"}, status_code=403)
        return await call_next(request)

    def need_mt5():
        if not bridge.ensure():
            raise HTTPException(status_code=503, detail=bridge.error or "MT5 ไม่พร้อม")

    @app.get("/status")
    def status():
        return poller.status()

    @app.get("/account")
    def account():
        with _mt5_lock:
            need_mt5()
            a = mt5.account_info()
        if a is None:
            raise HTTPException(status_code=503, detail="account_info ว่าง")
        return _account_dict(a)

    @app.get("/positions")
    def positions():
        with _mt5_lock:
            need_mt5()
            return [_position_dict(p) for p in (mt5.positions_get() or ())]

    @app.get("/orders")
    def orders():
        with _mt5_lock:
            need_mt5()
            return [_order_dict(o) for o in (mt5.orders_get() or ())]

    @app.get("/symbols")
    def symbols():
        with _mt5_lock:
            need_mt5()
            syms = mt5.symbols_get() or ()
            return [{"name": s.name, "description": s.description, "digits": s.digits,
                     "visible": bool(s.visible), "path": s.path} for s in syms]

    @app.get("/ltf")
    def ltf(symbol: str, tf: str, times: str = "last"):
        """แท่ง TF ย่อยของแท่งกราฟที่ระบุ (สำหรับ VP Order Blocks) — 30 วินาทีสร้างจาก tick, ที่เหลือรวมจาก M1
        คืน { ltf_sec, bars: { "<t>": [[h,l,v],...] | null } }  null = MT5 ไม่มีข้อมูลช่วงนั้น"""
        tf = tf.upper()
        if tf not in TF_MINUTES:
            raise HTTPException(status_code=400, detail="tf ไม่ถูกต้อง")
        step = ltf_seconds(tf)
        span = TF_MINUTES[tf] * 60
        off = poller.offset_s
        out, errors = {}, {}
        utc = lambda x: datetime.fromtimestamp(x, tz=timezone.utc)   # MT5 python: ใช้ datetime UTC (int บาง build ไม่รับ)
        with _mt5_lock:
            need_mt5()
            if mt5.symbol_info(symbol) is None:
                raise HTTPException(status_code=404, detail=f"ไม่พบ symbol {symbol}")
            if times == "last":   # ตรวจเช็คด้วยมือ: 3 แท่งที่ปิดแล้วล่าสุด
                rr = mt5.copy_rates_from_pos(symbol, getattr(mt5, TIMEFRAMES[tf]), 1, 3)
                ts = [] if rr is None else [int(r["time"]) - off for r in rr]
            else:
                try:
                    ts = [int(x) for x in times.split(",") if x][:LTF_MAX_TIMES]
                except ValueError:
                    raise HTTPException(status_code=400, detail="times ต้องเป็นตัวเลขคั่นด้วย ,")
        # คืน lock ทีละแท่ง: ดึง tick หลายแท่งใช้เวลาหลายวินาที ไม่ให้ /rates /calc ของหน้าจอต้องรอทั้งก้อน
        for t in ts:
            with _mt5_lock:
                a, b = t + off, t + span + off
                if step == 30:
                    ticks = mt5.copy_ticks_range(symbol, utc(a), utc(b), mt5.COPY_TICKS_ALL)
                    rows = [] if ticks is None else [
                        (int(x["time_msc"]) // 1000 - off, float(x["bid"]), float(x["bid"]), 1)
                        for x in ticks if x["bid"] > 0]
                else:
                    rates = mt5.copy_rates_range(symbol, mt5.TIMEFRAME_M1, utc(a), utc(b - 1))
                    rows = [] if rates is None else [
                        (int(r["time"]) - off, float(r["high"]), float(r["low"]), int(r["tick_volume"])) for r in rates]
                out[str(t)] = bucket_bars(rows, t, step) or None
                if out[str(t)] is None:
                    errors[str(t)] = str(mt5.last_error())
        if errors:
            log.warning("ltf %s %s: %d/%d ไม่มีข้อมูล เช่น %s", symbol, tf, len(errors), len(ts), next(iter(errors.values())))
        return {"ltf_sec": step, "bars": out, "errors": errors}

    @app.get("/history")
    def history(frm: int, to: int):
        """ไม้ที่มี deal ออกในช่วง [frm, to] (UTC วินาที) — ดึง deal เข้าของไม้ที่เปิดก่อน frm มาเติมให้ครบ"""
        if to <= frm or to - frm > HISTORY_MAX_DAYS * 86400:
            raise HTTPException(status_code=400, detail=f"ช่วงเวลาต้องไม่เกิน {HISTORY_MAX_DAYS} วัน")
        off = poller.offset_s
        utc = lambda x: EPOCH + timedelta(seconds=x)   # fromtimestamp ติดลบ = OSError บน Windows (ช่วงย้อนหลังก่อน 1970)
        with _mt5_lock:
            need_mt5()
            deals = mt5.history_deals_get(utc(frm + off), utc(to + off))
            if deals is None:
                raise HTTPException(status_code=503, detail=f"history_deals_get ล้มเหลว: {mt5.last_error()}")
            deals = list(deals)
            have_in = {d.position_id for d in deals if d.entry == ENTRY_IN}
            missing = {d.position_id for d in deals if d.type in (DEAL_BUY, DEAL_SELL) and d.position_id not in have_in}
            if missing:
                older = mt5.history_deals_get(utc(frm + off - HISTORY_LOOKBACK_DAYS * 86400), utc(frm + off)) or ()
                seen = {d.ticket for d in deals}
                deals += [d for d in older if d.position_id in missing and d.ticket not in seen]
                have_in = {d.position_id for d in deals if d.entry == ENTRY_IN}
                missing -= have_in
            for pid in list(missing)[:HISTORY_PER_POSITION_MAX]:
                extra = mt5.history_deals_get(position=pid) or ()
                seen = {d.ticket for d in deals}
                deals += [d for d in extra if d.ticket not in seen]
            acc = mt5.account_info()
        out = aggregate_deals(deals, off)
        out["currency"] = acc.currency if acc else ""
        return out

    @app.get("/rates")
    def rates(symbol: str, tf: str = "M15", count: int = Query(500, ge=1, le=5000), to: int | None = None):
        tf = tf.upper()
        if tf not in TIMEFRAMES:
            raise HTTPException(status_code=400, detail=f"tf ต้องเป็น {', '.join(TIMEFRAMES)}")
        # MT5 ขอครั้งแรกของ symbol/TF ที่ไม่ได้เปิดนาน: ได้ประวัติเก่าในเครื่องก่อน แล้วค่อยโหลดส่วนที่ขาดเบื้องหลัง
        # -> แท่งล่าสุดห่างจาก tick ปัจจุบันเกิน 2 แท่ง = ยังโหลดไม่ครบ: ปล่อย lock รอแล้วดึงใหม่ (สูงสุด ~4 วินาที)
        for attempt in range(RATES_SYNC_TRIES):
            with _mt5_lock:
                need_mt5()
                if mt5.symbol_info(symbol) is None:
                    raise HTTPException(status_code=404, detail=f"ไม่พบ symbol {symbol}")
                mt5.symbol_select(symbol, True)
                tfc = getattr(mt5, TIMEFRAMES[tf])
                if to is not None:
                    data = mt5.copy_rates_from(symbol, tfc, datetime.fromtimestamp(to + poller.offset_s, tz=timezone.utc), count)
                    break
                data = mt5.copy_rates_from_pos(symbol, tfc, 0, count)
                tick = mt5.symbol_info_tick(symbol)
            if data is None or not len(data) or not getattr(tick, "time", 0) or tf in ("W1", "MN1"):
                break
            if tick.time - int(data[-1]["time"]) <= 2 * TF_SEC[tf]:
                break
            if attempt < RATES_SYNC_TRIES - 1:
                time.sleep(RATES_SYNC_WAIT)
        if data is None:
            raise HTTPException(status_code=503, detail=f"copy_rates ล้มเหลว: {mt5.last_error()}")
        return rates_to_list(data, poller.offset_s)

    TF_SEC = {"M1": 60, "M5": 300, "M15": 900, "M30": 1800, "H1": 3600, "H4": 14400, "D1": 86400, "W1": 604800, "MN1": 2592000}
    REPLAY_MAX_BARS = 60000

    @app.get("/rates_range")
    def rates_range(symbol: str, frm: int, to: int, tf: str = "M15"):
        """แท่งช่วงเวลา [frm, to] (UTC วินาที) — ใช้กับ Bar Replay"""
        tf = tf.upper()
        if tf not in TIMEFRAMES:
            raise HTTPException(status_code=400, detail=f"tf ต้องเป็น {', '.join(TIMEFRAMES)}")
        if to <= frm:
            raise HTTPException(status_code=400, detail="ช่วงเวลาไม่ถูกต้อง")
        if (to - frm) / TF_SEC[tf] > REPLAY_MAX_BARS:
            raise HTTPException(status_code=400, detail=f"ช่วงยาวเกิน {REPLAY_MAX_BARS:,} แท่ง — เลือกวันเริ่มใกล้ขึ้นหรือ TF ใหญ่ขึ้น")
        with _mt5_lock:
            need_mt5()
            if mt5.symbol_info(symbol) is None:
                raise HTTPException(status_code=404, detail=f"ไม่พบ symbol {symbol}")
            mt5.symbol_select(symbol, True)
            off = poller.offset_s
            utc = lambda x: datetime.fromtimestamp(x + off, tz=timezone.utc)
            data = mt5.copy_rates_range(symbol, getattr(mt5, TIMEFRAMES[tf]), utc(frm), utc(to))
        if data is None:
            raise HTTPException(status_code=503, detail=f"copy_rates_range ล้มเหลว: {mt5.last_error()} (MT5 อาจไม่มีประวัติช่วงนี้)")
        return rates_to_list(data, poller.offset_s)

    # ---------- P3: เทรด ----------
    trader = Trader(accounts[account_name], poller.offset_s,
                    Path(os.environ.get("WT_AUDIT_DIR", str(Path(__file__).resolve().parent / "logs"))))
    app.state.trader = trader
    autobe = AutoBE(trader.audit_path.parent / f"autobe_{account_name}.json")
    prules = PendingRules(trader.audit_path.parent / f"prules_{account_name}.json")
    poller.trader, poller.autobe, poller.prules = trader, autobe, prules
    acct_cfg = accounts[account_name]
    poller.day_reset = (acct_cfg.get("day_reset") or (acct_cfg.get("guards") or {}).get("day_reset") or DEFAULT_DAY_RESET)
    app.state.autobe = autobe
    actions = {
        "order": trader.place, "order/modify": trader.modify_order, "order/cancel": trader.cancel_order,
        "orders/cancel_all": trader.cancel_all, "position/modify": trader.modify_position,
        "position/close": trader.close_position, "positions/close_all": trader.close_all,
        "position/breakeven": trader.breakeven, "orders/rerisk": lambda b: rerisk(b),
    }

    def rerisk(body: dict) -> dict:
        """ปรับ lot pending ตามความเสี่ยงใหม่ แล้วย้าย OCO/หมดอายุจาก ticket เดิมไป ticket ใหม่"""
        snap = {}
        for o in (mt5.orders_get() or ()):
            snap[o.ticket] = (prules.partner(o.ticket), prules.get()["expire"].get(str(o.ticket)))
        res = trader.rerisk_orders({**body, "dry_run": False})
        moved = {r["ticket"]: int(r["new_ticket"]) for r in res.get("results", []) if r.get("new_ticket")}
        for old, new in moved.items():
            partner, exp = snap.get(old, (None, None))
            try:
                if exp:
                    prules.set_expire(new, float(exp))
                if partner is not None and (partner not in moved or old < partner):
                    prules.link(new, moved.get(partner, partner))
            except (TypeError, ValueError) as e:
                res["rules_error"] = str(e)
        return res

    @app.get("/autobe")
    def autobe_get():
        return {**autobe.get(), "trading": bool(acct_cfg.get("trading"))}

    @app.post("/autobe")
    async def autobe_set(request: Request):
        body = await _json_body(request)
        try:
            cfg = autobe.set(body)
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))
        trader.audit("autobe/config", body, cfg, request.headers.get("x-client-ip", ""))
        log.info("autobe config: %s", cfg)
        return cfg

    @app.get("/prules")
    def prules_get():
        return prules.get()

    @app.post("/prules")
    async def prules_set(request: Request):
        """{op: link, a, b} | {op: unlink, ticket} | {op: expire, ticket, ts (UTC วินาที หรือ null)}"""
        body = await _json_body(request)
        op = body.get("op")
        try:
            with _mt5_lock:
                need_mt5()
                alive = {o.ticket for o in (mt5.orders_get() or ())}
            if op == "link":
                a, b = int(body["a"]), int(body["b"])
                if a not in alive or b not in alive:
                    raise ValueError("ไม่พบ pending (fill/ยกเลิกไปแล้ว?)")
                prules.link(a, b)
            elif op == "unlink":
                prules.unlink(int(body["ticket"]))
            elif op == "expire":
                t, ts = int(body["ticket"]), body.get("ts")
                if ts is not None:
                    ts = float(ts)
                    if t not in alive:
                        raise ValueError("ไม่พบ pending (fill/ยกเลิกไปแล้ว?)")
                    if ts <= time.time():
                        raise ValueError("เวลาหมดอายุต้องอยู่ในอนาคต")
                prules.set_expire(t, ts)
            else:
                raise ValueError("op ไม่ถูกต้อง")
        except (KeyError, TypeError, ValueError) as e:
            raise HTTPException(status_code=400, detail=str(e))
        trader.audit("prules/config", body, prules.get(), request.headers.get("x-client-ip", ""))
        with _mt5_lock:
            poller.force_state()
        return prules.get()

    @app.get("/tick")
    def tick(symbol: str):
        with _mt5_lock:
            need_mt5()
            if mt5.symbol_info(symbol) is None:
                raise HTTPException(status_code=404, detail=f"ไม่พบ symbol {symbol}")
            mt5.symbol_select(symbol, True)
            t = mt5.symbol_info_tick(symbol)
        if t is None or not t.bid:
            raise HTTPException(status_code=503, detail=f"ไม่มีราคา {symbol}")
        return {"bid": t.bid, "ask": t.ask, "time_msc": t.time_msc}

    @app.get("/autobe_events")
    def autobe_events(after: int = 0):
        return {"boot": poller.boot, "events": autobe.events_after(after)}

    @app.get("/deals")
    def deals(frm: int):
        """deal ปิดไม้ (entry OUT/INOUT/OUT_BY) ตั้งแต่ frm (UTC วินาที) — ให้ตัวส่ง Telegram แจ้งไม้ปิด"""
        now = int(time.time())
        frm = max(frm, now - DEALS_MAX_SEC)
        off = poller.offset_s
        utc = lambda x: datetime.fromtimestamp(x, tz=timezone.utc)
        with _mt5_lock:
            need_mt5()
            got = mt5.history_deals_get(utc(frm + off), utc(now + off + 60))
            if got is None:
                raise HTTPException(status_code=503, detail=f"history_deals_get ล้มเหลว: {mt5.last_error()}")
            out = []
            for d in got:
                if d.type not in (DEAL_BUY, DEAL_SELL) or d.entry not in (ENTRY_OUT, ENTRY_INOUT, ENTRY_OUT_BY):
                    continue
                t = int(d.time_msc) // 1000 - off
                if t < frm:
                    continue
                ins = [x for x in (mt5.history_deals_get(position=d.position_id) or ()) if x.entry == ENTRY_IN]
                vin = sum(float(x.volume) for x in ins)
                out.append({
                    "ticket": int(d.ticket), "time": t, "symbol": d.symbol, "position_id": int(d.position_id),
                    # deal ปิดของไม้ BUY เป็นฝั่ง SELL
                    "side": "buy" if d.type == DEAL_SELL else "sell", "volume": float(d.volume),
                    "price": float(d.price), "net": round(deal_cost(d), 2), "reason": int(getattr(d, "reason", -1)),
                    "open": round(sum(float(x.price) * float(x.volume) for x in ins) / vin, 10) if vin else None,
                    "comment": d.comment, "magic": int(d.magic),
                })
            acc = mt5.account_info()
        out.sort(key=lambda x: (x["time"], x["ticket"]))
        return {"deals": out, "currency": acc.currency if acc else ""}

    @app.get("/symbol_spec")
    def symbol_spec(symbol: str):
        with _mt5_lock:
            need_mt5()
            try:
                return trader.symbol_spec(symbol)
            except TradeError as e:
                raise HTTPException(status_code=404, detail=str(e))

    @app.post("/calc")
    async def calc(request: Request):
        body = await _json_body(request)
        with _mt5_lock:
            need_mt5()
            try:
                return trader.calc(body)
            except TradeError as e:
                raise HTTPException(status_code=400, detail=str(e))

    @app.post("/rerisk_preview")
    async def rerisk_preview(request: Request):
        body = await _json_body(request)
        with _mt5_lock:
            need_mt5()
            try:
                return trader.rerisk_orders({**body, "dry_run": True})
            except TradeError as e:
                raise HTTPException(status_code=400, detail=str(e))

    def _apply_new_pending_rules(ticket: int, body: dict, result: dict) -> None:
        """pending ใหม่จากหน้าส่งคำสั่ง: expire_ts = หมดอายุ, oco_with = จับคู่กับ pending ที่มีอยู่"""
        try:
            if body.get("expire_ts"):
                prules.set_expire(ticket, float(body["expire_ts"]))
            if body.get("oco_with"):
                prules.link(ticket, int(body["oco_with"]))
        except (TypeError, ValueError) as e:
            result["rules_error"] = str(e)
            result["message"] = f"{result.get('message', '')} · ตั้งกฎ pending ไม่สำเร็จ: {e}"

    @app.post("/trade/{action:path}")
    async def trade(action: str, request: Request):
        fn = actions.get(action)
        if fn is None:
            raise HTTPException(status_code=404, detail="not found")
        body = await _json_body(request)
        ip = request.headers.get("x-client-ip", "")
        cid = str(body.get("client_id") or "")[:64] or None
        # process ลูก: ถือแค่ _trade_lock ระหว่างรอโบรก (poller/กราฟเดินต่อ); โหมดเดิมต้องถือ _mt5_lock (MT5 ไม่ thread-safe)
        with (_trade_lock if mt5proc.SUBPROC else _mt5_lock):
            dup = trader.dedupe(cid)
            if dup is not None:
                return dup
            with _mt5_lock:
                need_mt5()
            poller.trade_since = time.time()
            try:
                result = fn(body)
            except TradeError as e:
                result = {"ok": False, "message": str(e), "rejected_by": "web"}
            except (KeyError, TypeError, ValueError) as e:
                result = {"ok": False, "message": f"ข้อมูลคำสั่งไม่ครบ/ผิดรูปแบบ: {e!r}", "rejected_by": "web"}
            except mt5proc.MT5Timeout as e:
                result = {"ok": False, "uncertain": True, "message": f"{e} — ไม่รู้ผลคำสั่ง ดูตาราง positions/pending ก่อนส่งซ้ำ"}
            finally:
                poller.trade_since = 0.0
            trader.remember(cid, result)
            if action == "order" and result.get("ok") and result.get("order") and body.get("kind", "market") != "market":
                _apply_new_pending_rules(int(result["order"]), body, result)
            if result.get("uncertain"):
                autobe.add_event({"kind": "uncertain", "action": action, "symbol": body.get("symbol", ""),
                                  "side": body.get("side"), "ticket": body.get("ticket"), "ok": False,
                                  "message": result.get("message", "")})
            with _mt5_lock:
                poller.force_state()
        trader.audit(action, body, result, ip)
        log.info("trade %s %s -> %s %s", action, {k: body.get(k) for k in ("symbol", "side", "kind", "volume", "ticket")},
                 result.get("retcode"), result.get("message"))
        return result

    @app.websocket("/stream")
    async def stream(ws: WebSocket):
        if not key_ok(ws.headers.get("x-worker-key")):
            await ws.close(code=4403)
            return
        await ws.accept()
        client = Client(queue=asyncio.Queue(maxsize=CLIENT_QUEUE_MAX), loop=asyncio.get_running_loop())
        hub.add(client)
        await ws.send_text(json.dumps(poller.status()))
        for kind, data in list(poller.snapshot.items()):
            await ws.send_text(json.dumps({"type": kind, "data": data}))

        async def sender():
            while True:
                data = await client.queue.get()
                if data is None:
                    await ws.close(code=4408)  # ช้าเกิน
                    return
                try:
                    await ws.send_text(data)
                except (RuntimeError, OSError, WebSocketDisconnect):
                    return   # gateway ปิดไปแล้ว — หยุดส่ง ไม่ต้องเขียนใส่ socket ที่ตายซ้ำๆ

        send_task = asyncio.create_task(sender())
        try:
            while True:
                msg = json.loads(await ws.receive_text())
                op = msg.get("op")
                if op == "subscribe":
                    new = {str(s)[:32] for s in msg.get("symbols", [])[:50]}
                    for s in new - client.symbols:
                        poller.forget_symbol(s)
                    client.symbols = new
                    bars = set()
                    for item in msg.get("bars", [])[:MAX_BAR_SUBS]:
                        if isinstance(item, list) and len(item) == 2 and str(item[1]).upper() in TIMEFRAMES:
                            bars.add((str(item[0])[:32], str(item[1]).upper()))
                    for k in bars - client.bars:
                        poller.forget_bars(k)
                    client.bars = bars
                elif op == "ping":
                    await client.queue.put(json.dumps({"type": "pong", "t": msg.get("t")}))
        except (WebSocketDisconnect, json.JSONDecodeError, RuntimeError):
            pass
        finally:
            hub.remove(client)
            send_task.cancel()

    return app


if os.environ.get("WT_NO_AUTOAPP") != "1":
    app = create_app()
