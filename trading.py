"""P3 ระบบเทรด — ตรวจคำสั่ง + สร้าง request + ยิง MT5 (เรียกใต้ _mt5_lock ของ worker เท่านั้น)

หลัก fail closed:
- บัญชีต้องเปิด "trading": true ใน accounts.json ไม่งั้นปฏิเสธทุกคำสั่ง
- terminal เป็นบัญชี REAL (trade_mode 2) แต่ไม่ได้ตั้ง "allow_real": true -> ปฏิเสธ
- lot คำนวณไม่ได้ (tick_value/calc_profit = 0) -> error ห้ามตกเป็น volume_min เงียบๆ
- lot ไม่ใช่ทวีคูณ volume_step / ต่ำกว่า min / เกิน max -> ปฏิเสธ ไม่ปัดเอง
"""
import json
import math
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

from mt5proc import MT5Timeout, mt5, mt5_trade   # ข้อมูล = process ลูก "data", order_send = process ลูก "trade"

SIDES = ("buy", "sell")
KINDS = ("market", "limit", "stop", "stop_limit")
ORDER_TYPE = {
    ("buy", "market"): "ORDER_TYPE_BUY", ("sell", "market"): "ORDER_TYPE_SELL",
    ("buy", "limit"): "ORDER_TYPE_BUY_LIMIT", ("sell", "limit"): "ORDER_TYPE_SELL_LIMIT",
    ("buy", "stop"): "ORDER_TYPE_BUY_STOP", ("sell", "stop"): "ORDER_TYPE_SELL_STOP",
    ("buy", "stop_limit"): "ORDER_TYPE_BUY_STOP_LIMIT", ("sell", "stop_limit"): "ORDER_TYPE_SELL_STOP_LIMIT",
}
OK_RETCODES = {10008, 10009, 10010}  # PLACED, DONE, DONE_PARTIAL
UNCERTAIN_RETCODES = {10012, 10031}  # TIMEOUT, CONNECTION — ผลจริงอาจต่างจากที่ตอบ
RETCODE_TH = {
    10004: "Requote — ราคาเปลี่ยน ลองใหม่",
    10006: "โบรกปฏิเสธคำสั่ง",
    10007: "คำสั่งถูกยกเลิก",
    10008: "วาง pending แล้ว",
    10009: "สำเร็จ",
    10010: "สำเร็จบางส่วน",
    10011: "ประมวลผลผิดพลาด",
    10012: "หมดเวลา — โบรกยังไม่ตอบ คำสั่งอาจค้างอยู่ที่ server และถูก fill ทีหลัง ดูตาราง positions/pending ก่อนส่งซ้ำ",
    10013: "คำสั่งไม่ถูกต้อง",
    10014: "lot ไม่ถูกต้อง",
    10015: "ราคาไม่ถูกต้อง",
    10016: "SL/TP ไม่ถูกต้อง (ใกล้ราคาเกินไปหรือผิดฝั่ง)",
    10017: "symbol นี้ปิดการเทรด",
    10018: "ตลาดปิด",
    10019: "margin ไม่พอ",
    10020: "ราคาเปลี่ยน",
    10021: "ไม่มีราคาให้ประมวลผล",
    10022: "วันหมดอายุไม่ถูกต้อง",
    10023: "สถานะคำสั่งเปลี่ยนไปแล้ว",
    10024: "ส่งคำสั่งถี่เกินไป",
    10025: "ไม่มีอะไรเปลี่ยน (SL/TP เดิม)",
    10026: "server ปิด autotrading",
    10027: "MT5 ปิด Algo Trading อยู่ — กดปุ่ม Algo Trading ใน terminal ให้เป็นสีเขียว",
    10028: "คำสั่งถูกล็อกอยู่",
    10029: "คำสั่ง/position ถูก freeze",
    10030: "filling mode ไม่รองรับ",
    10031: "ไม่ได้เชื่อมต่อ server เทรด",
    10033: "จำนวน pending เต็มลิมิต",
    10034: "volume รวมของ symbol เต็มลิมิต",
    10036: "position ถูกปิดไปแล้ว",
}


class TradeError(Exception):
    """ข้อผิดพลาดที่ตั้งใจแจ้งผู้ใช้ (HTTP 400)"""


CLOSE_WHICH = ("all", "profit", "loss")


def close_filter(pos, symbol: str | None, which: str, side: str | None) -> bool:
    """ปิดหลายไม้: which = all | profit (กำไร+swap > 0) | loss (< 0), side = buy/sell/None, symbol = None ทุกตัว"""
    if symbol and pos.symbol != symbol:
        return False
    if side and ("buy" if pos.type == 0 else "sell") != side:
        return False
    net = pos.profit + getattr(pos, "swap", 0.0)
    return which == "all" or (which == "profit" and net > 0) or (which == "loss" and net < 0)


def _c(name: str) -> int:
    return getattr(mt5, name)


def retcode_text(code: int | None) -> str:
    return RETCODE_TH.get(code, f"retcode {code}")


# ---------------------------------------------------------------- pure helpers (เทสต์ได้โดยไม่ต้องมี MT5)
def check_volume(volume: float, vmin: float, vmax: float, step: float) -> float:
    if not isinstance(volume, (int, float)) or not math.isfinite(volume) or volume <= 0:
        raise TradeError("lot ต้องเป็นตัวเลขมากกว่า 0")
    if volume < vmin - 1e-9:
        raise TradeError(f"lot {volume} ต่ำกว่าขั้นต่ำ {vmin}")
    if volume > vmax + 1e-9:
        raise TradeError(f"lot {volume} เกินสูงสุด {vmax}")
    steps = round(volume / step)
    if abs(steps * step - volume) > step * 1e-6:
        raise TradeError(f"lot {volume} ไม่ใช่ทวีคูณของ {step}")
    return round(steps * step, 8)


def check_levels(side: str, entry: float, sl: float, tp: float) -> None:
    """SL/TP ต้องอยู่ถูกฝั่งของราคาเข้า (0 = ไม่ตั้ง)"""
    if side == "buy":
        if sl and sl >= entry:
            raise TradeError(f"BUY: SL {sl} ต้องต่ำกว่าราคาเข้า {entry}")
        if tp and tp <= entry:
            raise TradeError(f"BUY: TP {tp} ต้องสูงกว่าราคาเข้า {entry}")
    else:
        if sl and sl <= entry:
            raise TradeError(f"SELL: SL {sl} ต้องสูงกว่าราคาเข้า {entry}")
        if tp and tp >= entry:
            raise TradeError(f"SELL: TP {tp} ต้องต่ำกว่าราคาเข้า {entry}")


def check_pending_price(side: str, kind: str, price: float, bid: float, ask: float, stoplimit: float = 0) -> None:
    if not price or price <= 0:
        raise TradeError("ต้องใส่ราคาของ pending")
    if kind == "limit":
        if side == "buy" and price >= ask:
            raise TradeError(f"BUY LIMIT ต้องต่ำกว่า ask {ask}")
        if side == "sell" and price <= bid:
            raise TradeError(f"SELL LIMIT ต้องสูงกว่า bid {bid}")
    elif kind in ("stop", "stop_limit"):
        if side == "buy" and price <= ask:
            raise TradeError(f"BUY STOP ต้องสูงกว่า ask {ask}")
        if side == "sell" and price >= bid:
            raise TradeError(f"SELL STOP ต้องต่ำกว่า bid {bid}")
        if kind == "stop_limit":
            if not stoplimit or stoplimit <= 0:
                raise TradeError("STOP LIMIT ต้องใส่ราคา limit")
            if side == "buy" and stoplimit >= price:
                raise TradeError("BUY STOP LIMIT: ราคา limit ต้องต่ำกว่าราคา stop")
            if side == "sell" and stoplimit <= price:
                raise TradeError("SELL STOP LIMIT: ราคา limit ต้องสูงกว่าราคา stop")


def lot_from_risk(risk_money: float, loss_per_lot: float, vmin: float, vmax: float, step: float) -> float:
    if not loss_per_lot or loss_per_lot <= 0 or not math.isfinite(loss_per_lot):
        raise TradeError("คำนวณมูลค่าความเสี่ยงต่อ lot ไม่ได้ (tick_value = 0) — ใส่ lot เอง")
    raw = risk_money / loss_per_lot
    lot = math.floor(raw / step + 1e-9) * step
    if lot < vmin - 1e-9:
        raise TradeError(f"ความเสี่ยง {risk_money:.2f} ไม่พอสำหรับ lot ขั้นต่ำ {vmin} "
                         f"(lot ขั้นต่ำเสี่ยง {loss_per_lot * vmin:.2f})")
    return round(min(lot, vmax), 8)


def normalize_price(value: float, tick_size: float, digits: int) -> float:
    if not value:
        return 0.0
    if tick_size and tick_size > 0:
        value = round(value / tick_size) * tick_size
    return round(value, digits)


def day_start_utc(now_utc: datetime, reset: str) -> datetime:
    """reset = "HH:MM Area/City" เช่น "16:59 America/New_York" -> เวลาเริ่มวันเทรดล่าสุด (UTC)"""
    hm, tz = reset.split()
    h, m = (int(x) for x in hm.split(":"))
    local = now_utc.astimezone(ZoneInfo(tz))
    start = local.replace(hour=h, minute=m, second=0, microsecond=0)
    if start > local:
        start -= timedelta(days=1)
    return start.astimezone(timezone.utc)


def be_target(side: str, open_px: float, point: float, lock_points: float = 0.0) -> float:
    """ราคา SL จุดทุน: ราคาเข้า ± lock_points (บวก = ล็อกกำไรไว้เท่านั้นจุด)"""
    return open_px + (1 if side == "buy" else -1) * lock_points * point


def sl_at_or_past(side: str, sl: float, target: float, point: float) -> bool:
    """SL เดิมอยู่ที่ target หรือดีกว่าแล้ว (ไม่ต้องเลื่อน)"""
    if not sl:
        return False
    return sl >= target - point / 2 if side == "buy" else sl <= target + point / 2


def autobe_target(cfg: dict, side: str, open_px: float, sl: float, bid: float, ask: float, point: float) -> float | None:
    """Auto BE: คืนราคา SL ใหม่ถ้าถึงเงื่อนไข ไม่งั้น None
    mode rr     : กำไร (ราคาปิดฝั่งตรงข้าม) ≥ rr × ระยะ SL เดิม — ต้องมี SL ฝั่งขาดทุน
    mode points : กำไร ≥ points จุด (ไม่มี SL ก็ได้)"""
    ref = bid if side == "buy" else ask
    gain = (ref - open_px) if side == "buy" else (open_px - ref)
    target = be_target(side, open_px, point, float(cfg.get("lock_points") or 0))
    if sl_at_or_past(side, sl, target, point):
        return None
    if cfg.get("mode") == "points":
        need = float(cfg.get("points") or 0) * point
        if need <= 0:
            return None
    else:
        if not sl:
            return None
        risk = (open_px - sl) if side == "buy" else (sl - open_px)
        if risk <= 0:
            return None
        need = float(cfg.get("rr") or 0) * risk
        if need <= 0:
            return None
    if gain + point / 2 < need:
        return None
    # SL ใหม่ต้องอยู่ฝั่งขาดทุนของราคาปัจจุบัน (ไม่งั้นโบรกปฏิเสธ)
    if (side == "buy" and target >= ref) or (side == "sell" and target <= ref):
        return None
    return target


# ---------------------------------------------------------------- Trader
class Trader:
    def __init__(self, account: dict, offset_s: int, audit_dir: Path):
        self.account = account
        self.offset_s = offset_s
        self.guards = account.get("guards") or {}
        self.magic = int(account.get("magic") or 0)
        self.deviation = int(account.get("deviation") or 20)
        self.audit_path = audit_dir / f"audit_{account['name']}.jsonl"
        audit_dir.mkdir(parents=True, exist_ok=True)
        self._audit_lock = threading.Lock()
        self._recent: dict[str, tuple[float, dict]] = {}   # client_id -> (ts, result) กันกดซ้ำ

    # ---------- audit ----------
    def audit(self, action: str, req: dict, result: dict, client_ip: str = "") -> None:
        line = json.dumps({"ts": datetime.now(timezone.utc).isoformat(timespec="milliseconds"), "ip": client_ip,
                           "action": action, "req": req, "result": result}, ensure_ascii=False, default=str)
        with self._audit_lock, open(self.audit_path, "a", encoding="utf-8") as f:
            f.write(line + "\n")

    def dedupe(self, client_id: str | None) -> dict | None:
        now = time.time()
        for k in [k for k, (t, _) in self._recent.items() if now - t > 60]:
            del self._recent[k]
        if client_id and client_id in self._recent:
            return {**self._recent[client_id][1], "duplicate": True}
        return None

    def remember(self, client_id: str | None, result: dict) -> None:
        if client_id:
            self._recent[client_id] = (time.time(), result)

    # ---------- preconditions ----------
    def require_trading(self) -> None:
        if not self.account.get("trading"):
            raise TradeError(f"บัญชี {self.account['name']} ปิดการเทรดใน accounts.json (trading: false)")
        acc = mt5.account_info()
        if acc is None:
            raise TradeError("อ่านข้อมูลบัญชีไม่ได้")
        if acc.trade_mode == 2 and not self.account.get("allow_real"):
            raise TradeError("terminal นี้เป็นบัญชี REAL แต่ accounts.json ไม่ได้ตั้ง allow_real: true")
        if not acc.trade_allowed:
            raise TradeError("บัญชีนี้ถูกปิดการเทรด (investor password?)")
        term = mt5.terminal_info()
        if term is not None and not term.trade_allowed:
            raise TradeError(RETCODE_TH[10027])

    def symbol(self, name: str):
        info = mt5.symbol_info(name)
        if info is None:
            raise TradeError(f"ไม่พบ symbol {name}")
        if not info.visible:
            mt5.symbol_select(name, True)
        return info

    def tick(self, name: str):
        t = mt5.symbol_info_tick(name)
        if t is None or not t.bid or not t.ask:
            raise TradeError(f"ไม่มีราคา {name} ตอนนี้ (ตลาดปิด?)")
        return t

    @staticmethod
    def filling(info, market: bool) -> int:
        if not market:
            return _c("ORDER_FILLING_RETURN")
        fm = int(info.filling_mode or 0)
        if fm & 1:
            return _c("ORDER_FILLING_FOK")
        if fm & 2:
            return _c("ORDER_FILLING_IOC")
        return _c("ORDER_FILLING_RETURN")

    def symbol_spec(self, name: str) -> dict:
        info = self.symbol(name)
        return {
            "name": info.name, "digits": info.digits, "point": info.point,
            "volume_min": info.volume_min, "volume_max": info.volume_max, "volume_step": info.volume_step,
            "tick_size": info.trade_tick_size, "tick_value": info.trade_tick_value,
            "contract_size": info.trade_contract_size, "stops_level": info.trade_stops_level,
            "trade_mode": info.trade_mode, "currency_profit": info.currency_profit,
            "trading": bool(self.account.get("trading")),
        }

    def loss_per_lot(self, info, side: str, entry: float, sl: float) -> float:
        """ขาดทุน (สกุลบัญชี) ต่อ 1 lot ถ้าโดน SL — ใช้ order_calc_profit ก่อน, fallback tick_value/tick_size"""
        otype = _c("ORDER_TYPE_BUY" if side == "buy" else "ORDER_TYPE_SELL")
        v = mt5.order_calc_profit(otype, info.name, 1.0, entry, sl)
        if v is not None and v < 0:
            return -float(v)
        tv = info.trade_tick_value_loss or info.trade_tick_value
        if tv and info.trade_tick_size:
            return abs(entry - sl) / info.trade_tick_size * tv
        return 0.0

    def entry_price(self, side: str, kind: str, price: float, stoplimit: float, tick) -> float:
        if kind == "market":
            return tick.ask if side == "buy" else tick.bid
        return stoplimit if kind == "stop_limit" else price

    # ---------- guards ----------
    def day_pnl_loss_pct(self) -> tuple[float, float]:
        """(ขาดทุนวันนี้ % ของ balance ต้นวัน, balance ต้นวัน) — ต้นวันตาม guards.day_reset"""
        acc = mt5.account_info()
        reset = self.guards.get("day_reset", "00:00 UTC")
        start = day_start_utc(datetime.now(timezone.utc), reset)
        frm = datetime.fromtimestamp(start.timestamp() + self.offset_s, tz=timezone.utc)
        to = datetime.fromtimestamp(time.time() + self.offset_s + 86400, tz=timezone.utc)
        deals = mt5.history_deals_get(frm, to) or ()
        realized = sum(d.profit + d.commission + d.swap + getattr(d, "fee", 0.0)
                       for d in deals if d.type in (0, 1))  # BUY/SELL deals (ไม่รวมฝาก/ถอน)
        start_balance = acc.balance - realized
        if start_balance <= 0:
            return 0.0, start_balance
        return max(0.0, (start_balance - acc.equity) / start_balance * 100), start_balance

    def check_guards(self, info, volume: float, risk_money: float | None, replacing: bool = False) -> None:
        """replacing = วางแทนใบเดิม (จำนวนไม้ไม่เพิ่ม) -> ไม่เช็ค max_positions"""
        g = self.guards
        if g.get("max_lot") and volume > float(g["max_lot"]) + 1e-9:
            raise TradeError(f"lot {volume} เกิน max_lot {g['max_lot']} ของบัญชี")
        if g.get("max_positions") and not replacing:
            n = len(mt5.positions_get() or ()) + len(mt5.orders_get() or ())
            if n >= int(g["max_positions"]):
                raise TradeError(f"position+pending {n} ถึง max_positions {g['max_positions']} แล้ว")
        if g.get("require_sl") and risk_money is None:
            raise TradeError("บัญชีนี้บังคับใส่ SL")
        acc = mt5.account_info()
        if g.get("max_risk_pct") and risk_money is not None:
            pct = risk_money / acc.balance * 100
            if pct > float(g["max_risk_pct"]) + 1e-9:
                raise TradeError(f"ความเสี่ยงไม้นี้ {pct:.2f}% เกิน max_risk_pct {g['max_risk_pct']}%")
        if g.get("daily_loss_pct"):
            loss_pct, start_bal = self.day_pnl_loss_pct()
            add = (risk_money or 0) / start_bal * 100 if start_bal > 0 else 0
            if loss_pct + add > float(g["daily_loss_pct"]) - 1e-9:
                raise TradeError(f"daily loss {loss_pct:.2f}% + ไม้นี้ {add:.2f}% จะเกินลิมิต {g['daily_loss_pct']}%")

    def check_modify_guards(self, symbol: str, buy: bool, volume: float, entry: float, sl: float, old_sl: float) -> None:
        """แก้ SL ของไม้/pending ที่มีอยู่: ห้ามลบ SL (require_sl) และห้ามขยาย SL จนเสี่ยงเกิน max_risk_pct
        (ขยับเข้าใกล้ / ล็อกกำไร ทำได้เสมอ แม้ไม้เดิมเสี่ยงเกินลิมิตอยู่แล้ว)"""
        g = self.guards
        if g.get("require_sl") and not sl:
            raise TradeError("บัญชีนี้บังคับใส่ SL — ลบ SL ไม่ได้")
        if not g.get("max_risk_pct") or not sl:
            return
        typ = _c("ORDER_TYPE_BUY" if buy else "ORDER_TYPE_SELL")
        loss = lambda lvl: max(0.0, -float(mt5.order_calc_profit(typ, symbol, volume, entry, lvl) or 0.0)) if lvl else float("inf")
        new, old = loss(sl), loss(old_sl)
        if new <= old + 1e-9:
            return
        acc = mt5.account_info()
        pct = new / acc.balance * 100 if acc and acc.balance > 0 else 0.0
        if pct > float(g["max_risk_pct"]) + 1e-9:
            raise TradeError(f"SL ใหม่เสี่ยง {pct:.2f}% เกิน max_risk_pct {g['max_risk_pct']}%")

    # ---------- actions ----------
    def calc(self, p: dict) -> dict:
        side, kind = p.get("side"), p.get("kind", "market")
        if side not in SIDES or kind not in KINDS:
            raise TradeError("side/kind ไม่ถูกต้อง")
        info = self.symbol(p["symbol"])
        t = self.tick(info.name)
        entry = self.entry_price(side, kind, float(p.get("price") or 0), float(p.get("stoplimit") or 0), t)
        sl = float(p.get("sl") or 0)
        out = {"entry": entry, "digits": info.digits, "currency": mt5.account_info().currency}
        if sl:
            check_levels(side, entry, sl, 0)
            lpl = self.loss_per_lot(info, side, entry, sl)
            out["loss_per_lot"] = lpl
            if p.get("risk_pct"):
                risk_money = mt5.account_info().balance * float(p["risk_pct"]) / 100
                out["volume"] = lot_from_risk(risk_money, lpl, info.volume_min, info.volume_max, info.volume_step)
            elif p.get("volume"):
                out["volume"] = check_volume(float(p["volume"]), info.volume_min, info.volume_max, info.volume_step)
            if "volume" in out:
                out["risk_money"] = round(lpl * out["volume"], 2)
                out["risk_pct"] = round(out["risk_money"] / mt5.account_info().balance * 100, 3)
        elif p.get("risk_pct"):
            raise TradeError("คำนวณจาก risk% ต้องใส่ SL")
        vol = out.get("volume") or (float(p["volume"]) if p.get("volume") else None)
        if vol:
            otype = _c(ORDER_TYPE[(side, "market")])
            m = mt5.order_calc_margin(otype, info.name, vol, entry)
            out["margin"] = round(m, 2) if m is not None else None
        return out

    def place(self, p: dict) -> dict:
        self.require_trading()
        side, kind = p.get("side"), p.get("kind", "market")
        if side not in SIDES or kind not in KINDS:
            raise TradeError("side/kind ไม่ถูกต้อง")
        info = self.symbol(str(p.get("symbol", "")))
        if info.trade_mode == 0:
            raise TradeError(f"{info.name} ปิดการเทรด")
        if info.trade_mode == 3:
            raise TradeError(f"{info.name} ปิดได้อย่างเดียว (close only)")
        if (info.trade_mode == 1 and side == "sell") or (info.trade_mode == 2 and side == "buy"):
            raise TradeError(f"{info.name} เปิดได้แค่ฝั่งเดียว")
        t = self.tick(info.name)
        d, ts = info.digits, info.trade_tick_size
        price = normalize_price(float(p.get("price") or 0), ts, d)
        stoplimit = normalize_price(float(p.get("stoplimit") or 0), ts, d)
        sl = normalize_price(float(p.get("sl") or 0), ts, d)
        tp = normalize_price(float(p.get("tp") or 0), ts, d)
        if kind != "market":
            check_pending_price(side, kind, price, t.bid, t.ask, stoplimit)
        entry = self.entry_price(side, kind, price, stoplimit, t)
        check_levels(side, entry, sl, tp)

        if p.get("risk_pct"):
            if not sl:
                raise TradeError("คำนวณจาก risk% ต้องใส่ SL")
            risk_money = mt5.account_info().balance * float(p["risk_pct"]) / 100
            volume = lot_from_risk(risk_money, self.loss_per_lot(info, side, entry, sl),
                                   info.volume_min, info.volume_max, info.volume_step)
        else:
            volume = check_volume(float(p.get("volume") or 0), info.volume_min, info.volume_max, info.volume_step)
        risk = self.loss_per_lot(info, side, entry, sl) * volume if sl else None
        self.check_guards(info, volume, risk)

        req = {
            "symbol": info.name, "volume": volume, "type": _c(ORDER_TYPE[(side, kind)]),
            "sl": sl, "tp": tp, "magic": self.magic, "comment": str(p.get("comment") or "web")[:31],
            "type_filling": self.filling(info, kind == "market"), "type_time": _c("ORDER_TIME_GTC"),
        }
        if kind == "market":
            req.update(action=_c("TRADE_ACTION_DEAL"), price=entry, deviation=self.deviation)
        else:
            req.update(action=_c("TRADE_ACTION_PENDING"), price=price)
            if kind == "stop_limit":
                req["stoplimit"] = stoplimit
        return self.send(req, extra={"risk_money": round(risk, 2) if risk is not None else None})

    def modify_position(self, p: dict) -> dict:
        self.require_trading()
        pos = self._position(int(p["ticket"]))
        info = self.symbol(pos.symbol)
        sl = normalize_price(float(p.get("sl") or 0), info.trade_tick_size, info.digits)
        tp = normalize_price(float(p.get("tp") or 0), info.trade_tick_size, info.digits)
        t = self.tick(pos.symbol)
        side = "buy" if pos.type == 0 else "sell"
        ref = t.bid if side == "buy" else t.ask   # position ปิดที่ราคาฝั่งตรงข้าม
        check_levels(side, ref, sl, tp)
        self.check_modify_guards(pos.symbol, side == "buy", pos.volume, pos.price_open, sl, pos.sl)
        return self.send({"action": _c("TRADE_ACTION_SLTP"), "position": pos.ticket, "symbol": pos.symbol,
                          "sl": sl, "tp": tp, "magic": pos.magic})

    def close_position(self, p: dict) -> dict:
        self.require_trading()
        pos = self._position(int(p["ticket"]))
        info = self.symbol(pos.symbol)
        vol = pos.volume
        if p.get("volume"):
            vol = check_volume(float(p["volume"]), info.volume_min, pos.volume, info.volume_step)
            rest = round(pos.volume - vol, 8)
            if 0 < rest < info.volume_min - 1e-9:
                raise TradeError(f"ปิดแล้วเหลือ {rest} ต่ำกว่า lot ขั้นต่ำ {info.volume_min} — ปิดทั้งหมดแทน")
        t = self.tick(pos.symbol)
        buy = pos.type == 0
        return self.send({
            "action": _c("TRADE_ACTION_DEAL"), "position": pos.ticket, "symbol": pos.symbol, "volume": vol,
            "type": _c("ORDER_TYPE_SELL" if buy else "ORDER_TYPE_BUY"), "price": t.bid if buy else t.ask,
            "deviation": self.deviation, "magic": pos.magic, "comment": "web close",
            "type_filling": self.filling(info, True), "type_time": _c("ORDER_TIME_GTC"),
        })

    def breakeven_one(self, pos, lock_points: float = 0.0) -> dict:
        """เลื่อน SL ของ position ไปจุดทุน (+lock_points) เก็บ TP เดิม"""
        info = self.symbol(pos.symbol)
        side = "buy" if pos.type == 0 else "sell"
        target = normalize_price(be_target(side, pos.price_open, info.point, lock_points), info.trade_tick_size, info.digits)
        if sl_at_or_past(side, pos.sl, target, info.point):
            return {"ok": True, "message": "SL อยู่ที่จุดทุนหรือดีกว่าแล้ว", "skipped": True}
        t = self.tick(pos.symbol)
        ref = t.bid if side == "buy" else t.ask
        if (side == "buy" and target >= ref) or (side == "sell" and target <= ref):
            raise TradeError(f"#{pos.ticket} ราคายังไม่เลยจุดทุน — ตั้ง SL ที่ {target} ไม่ได้")
        return self.send({"action": _c("TRADE_ACTION_SLTP"), "position": pos.ticket, "symbol": pos.symbol,
                          "sl": target, "tp": pos.tp, "magic": pos.magic}, extra={"sl": target})

    def breakeven(self, p: dict) -> dict:
        """{ticket} = ไม้เดียว / {symbol} = ทุกไม้ของ symbol / {} = ทุกไม้ — lock_points (จุด) optional"""
        self.require_trading()
        lock = float(p.get("lock_points") or 0)
        if p.get("ticket"):
            return self.breakeven_one(self._position(int(p["ticket"])), lock)
        sym, which, side = p.get("symbol"), p.get("which") or "all", p.get("side")
        if which not in CLOSE_WHICH or side not in (None, "", "buy", "sell"):
            raise TradeError("ตัวเลือกปิดไม่ถูกต้อง")
        positions = [x for x in (mt5.positions_get() or ()) if close_filter(x, sym, which, side)]
        if not positions:
            return {"ok": True, "results": [], "message": "ไม่มีไม้ที่ตรงเงื่อนไข"}
        results = []
        for pos in positions:
            try:
                results.append({"ticket": pos.ticket, **self.breakeven_one(pos, lock)})
            except TradeError as e:
                results.append({"ticket": pos.ticket, "ok": False, "message": str(e)})
        moved = sum(1 for r in results if r.get("ok") and not r.get("skipped"))
        return {"ok": all(r.get("ok") for r in results), "results": results,
                "message": f"เลื่อน SL ไปจุดทุน {moved}/{len(results)} ไม้" + (
                    f" (ข้าม {sum(1 for r in results if r.get('skipped'))} ที่อยู่ทุนแล้ว)" if any(r.get("skipped") for r in results) else "")}

    def position_risk(self, pos) -> float | None:
        """กำไร/ขาดทุนถ้าโดน SL (สกุลบัญชี) — ติดลบ = เสี่ยงอยู่, บวก = ล็อกกำไรแล้ว, None = ไม่มี SL/คิดไม่ได้"""
        if not pos.sl:
            return None
        v = mt5.order_calc_profit(_c("ORDER_TYPE_BUY" if pos.type == 0 else "ORDER_TYPE_SELL"),
                                  pos.symbol, pos.volume, pos.price_open, pos.sl)
        return round(float(v), 2) if v is not None else None

    def day_summary(self, reset: str) -> dict:
        """สรุปวันนี้: กำไรที่ปิดแล้ว (net), จำนวนไม้ที่ปิด, balance ต้นวัน, ลิมิต daily loss"""
        acc = mt5.account_info()
        start = day_start_utc(datetime.now(timezone.utc), reset)
        frm = datetime.fromtimestamp(start.timestamp() + self.offset_s, tz=timezone.utc)
        to = datetime.fromtimestamp(time.time() + self.offset_s + 86400, tz=timezone.utc)
        deals = [d for d in (mt5.history_deals_get(frm, to) or ()) if d.type in (0, 1)]
        realized = sum(d.profit + d.commission + d.swap + (getattr(d, "fee", 0.0) or 0.0) for d in deals)
        closed = sum(1 for d in deals if getattr(d, "entry", 1) in (1, 2, 3))
        start_balance = acc.balance - realized if acc else 0.0
        out = {"realized": round(realized, 2), "closed": closed, "start_balance": round(start_balance, 2),
               "day_start": int(start.timestamp()), "reset": reset,
               "daily_loss_pct": self.guards.get("daily_loss_pct")}
        if acc and start_balance > 0:
            out["day_pct"] = round((acc.equity - start_balance) / start_balance * 100, 2)
        return out

    def close_all(self, p: dict) -> dict:
        self.require_trading()
        sym, which, side = p.get("symbol"), p.get("which") or "all", p.get("side")
        if which not in CLOSE_WHICH or side not in (None, "", "buy", "sell"):
            raise TradeError("ตัวเลือกปิดไม่ถูกต้อง")
        positions = [x for x in (mt5.positions_get() or ()) if close_filter(x, sym, which, side)]
        if not positions:
            return {"ok": True, "results": [], "message": "ไม่มีไม้ที่ตรงเงื่อนไข"}
        results = []
        for pos in positions:
            try:
                results.append({"ticket": pos.ticket, **self.close_position({"ticket": pos.ticket})})
            except TradeError as e:
                results.append({"ticket": pos.ticket, "ok": False, "message": str(e)})
        return {"ok": all(r.get("ok") for r in results), "results": results,
                "message": f"ปิด {sum(1 for r in results if r.get('ok'))}/{len(results)} ไม้"}

    def modify_order(self, p: dict) -> dict:
        self.require_trading()
        o = self._order(int(p["ticket"]))
        info = self.symbol(o.symbol)
        n = lambda k, dflt: normalize_price(float(p[k]), info.trade_tick_size, info.digits) if k in p and p[k] is not None else dflt
        price, sl, tp, stoplimit = n("price", o.price_open), n("sl", o.sl), n("tp", o.tp), n("stoplimit", o.price_stoplimit)
        side = "buy" if o.type in (2, 4, 6) else "sell"
        entry = stoplimit if o.type in (6, 7) else price
        check_levels(side, entry, sl, tp)
        # pending: ราคาเข้าอาจเลื่อนด้วย -> เทียบความเสี่ยงที่ราคาเข้าใหม่กับ SL เดิม
        self.check_modify_guards(o.symbol, side == "buy", o.volume_current, entry, sl, o.sl)
        req = {"action": _c("TRADE_ACTION_MODIFY"), "order": o.ticket, "symbol": o.symbol, "price": price,
               "sl": sl, "tp": tp, "type_time": _c("ORDER_TIME_GTC")}
        if o.type in (6, 7):
            req["stoplimit"] = stoplimit
        return self.send(req)

    def cancel_order(self, p: dict) -> dict:
        self.require_trading()
        o = self._order(int(p["ticket"]))
        return self.send({"action": _c("TRADE_ACTION_REMOVE"), "order": o.ticket})

    def cancel_all(self, p: dict) -> dict:
        self.require_trading()
        sym = p.get("symbol")
        orders = [x for x in (mt5.orders_get() or ()) if not sym or x.symbol == sym]
        results = []
        for o in orders:
            try:
                results.append({"ticket": o.ticket, **self.cancel_order({"ticket": o.ticket})})
            except TradeError as e:
                results.append({"ticket": o.ticket, "ok": False, "message": str(e)})
        return {"ok": all(r.get("ok") for r in results), "results": results,
                "message": f"ยกเลิก {sum(1 for r in results if r.get('ok'))}/{len(results)} รายการ"}

    # ---------- ปรับ lot ของ pending ตามความเสี่ยงใหม่ (ลบแล้ววางใหม่ ราคา/SL/TP เดิม) ----------
    def _rerisk_plan(self, o, risk_money: float, balance: float) -> dict:
        info = self.symbol(o.symbol)
        side = "buy" if o.type in (2, 4, 6) else "sell"
        kind = {2: "limit", 3: "limit", 4: "stop", 5: "stop", 6: "stop_limit", 7: "stop_limit"}.get(o.type)
        row = {"ticket": o.ticket, "symbol": o.symbol, "type": o.type, "price": o.price_open, "sl": o.sl,
               "old_volume": o.volume_current}
        if kind is None:
            return {**row, "ok": False, "message": "ไม่ใช่ pending"}
        if not o.sl:
            return {**row, "ok": False, "message": "ไม่มี SL — คิด lot จากความเสี่ยงไม่ได้"}
        entry = o.price_stoplimit if kind == "stop_limit" else o.price_open
        lpl = self.loss_per_lot(info, side, entry, o.sl)
        row["old_risk"] = round(lpl * o.volume_current, 2)
        try:
            vol = lot_from_risk(risk_money, lpl, info.volume_min, info.volume_max, info.volume_step)
        except TradeError as e:
            return {**row, "ok": False, "message": str(e)}
        row.update(new_volume=vol, new_risk=round(lpl * vol, 2),
                   new_risk_pct=round(lpl * vol / balance * 100, 3) if balance > 0 else None,
                   side=side, kind=kind, _info=info, _o=o)
        row["same"] = abs(vol - o.volume_current) < 1e-9
        return row

    def rerisk_orders(self, p: dict) -> dict:
        """{tickets?:[..] (ว่าง = ทุก pending), symbol?, risk_pct | risk_money, dry_run?}
        lot ใหม่ = ความเสี่ยงที่กำหนด / ขาดทุนต่อ lot ที่ SL เดิม · ลบ pending เดิมแล้ววางใหม่ (ราคา/SL/TP/หมดอายุเดิม)
        ผลแต่ละใบมี new_ticket ให้ worker ย้ายกฎ OCO/หมดอายุตาม"""
        acc = mt5.account_info()
        if p.get("risk_money"):
            risk_money = float(p["risk_money"])
        elif p.get("risk_pct"):
            risk_money = acc.balance * float(p["risk_pct"]) / 100
        else:
            raise TradeError("ใส่ risk% หรือจำนวนเงินเสี่ยง")
        if not (risk_money > 0 and math.isfinite(risk_money)):
            raise TradeError("ความเสี่ยงต้องมากกว่า 0")
        want = {int(t) for t in (p.get("tickets") or [])}
        sym = p.get("symbol")
        orders = [o for o in (mt5.orders_get() or ()) if (not want or o.ticket in want) and (not sym or o.symbol == sym)]
        if want and len(orders) < len(want):
            missing = sorted(want - {o.ticket for o in orders})
            raise TradeError(f"ไม่พบ pending {', '.join(map(str, missing))} (ถูก fill/ยกเลิกไปแล้ว?)")
        plans = [self._rerisk_plan(o, risk_money, acc.balance) for o in orders]
        public = lambda r: {k: v for k, v in r.items() if not k.startswith("_")}
        head = {"risk_money": round(risk_money, 2), "balance": acc.balance, "currency": acc.currency}
        if p.get("dry_run"):
            return {"ok": True, "dry_run": True, **head, "results": [public(r) for r in plans]}
        self.require_trading()
        results = []
        for r in plans:
            if not r.get("ok", True) or r.get("same"):
                results.append({**public(r), "ok": r.get("ok", True), "skipped": True,
                                "message": r.get("message") or "lot เท่าเดิม ไม่ต้องวางใหม่"})
                continue
            results.append(self._rerisk_one(r, public(r)))
        done = sum(1 for r in results if r.get("ok") and not r.get("skipped"))
        skipped = sum(1 for r in results if r.get("skipped"))
        return {"ok": all(r.get("ok") for r in results), **head, "results": results,
                "message": f"วางใหม่ {done}/{len(results)} ใบ" + (f" (ข้าม {skipped})" if skipped else "")}

    def _rerisk_one(self, r: dict, row: dict) -> dict:
        o, info = r["_o"], r["_info"]
        try:
            self.check_guards(info, r["new_volume"], r["new_risk"], replacing=True)
        except TradeError as e:
            return {**row, "ok": False, "message": str(e)}
        req = {"action": _c("TRADE_ACTION_PENDING"), "symbol": o.symbol, "type": o.type, "price": o.price_open,
               "sl": o.sl, "tp": o.tp, "magic": o.magic, "comment": (o.comment or "web")[:31],
               "type_filling": self.filling(info, False)}
        tt = getattr(o, "type_time", None)
        exp = getattr(o, "time_expiration", 0)
        if tt is not None and exp:
            req.update(type_time=tt, expiration=exp)
        else:
            req["type_time"] = _c("ORDER_TIME_GTC")
        if o.type in (6, 7):
            req["stoplimit"] = o.price_stoplimit
        c = self.send({"action": _c("TRADE_ACTION_REMOVE"), "order": o.ticket})
        if not c.get("ok"):
            return {**row, "ok": False, "uncertain": c.get("uncertain"), "message": f"ลบใบเดิมไม่สำเร็จ: {c.get('message')}"}
        n = self.send({**req, "volume": r["new_volume"]})
        if n.get("ok"):
            return {**row, "ok": True, "new_ticket": n.get("order"), "message": f"{o.volume_current} → {r['new_volume']} lot"}
        if n.get("uncertain"):
            return {**row, "ok": False, "uncertain": True, "message": f"ลบใบเดิมแล้ว แต่วางใหม่ไม่รู้ผล: {n.get('message')} — ดูตาราง pending"}
        back = self.send({**req, "volume": o.volume_current})   # วางใหม่ไม่ผ่าน -> คืนใบเดิม (lot เดิม)
        if back.get("ok"):
            return {**row, "ok": False, "new_ticket": back.get("order"), "restored": True,
                    "message": f"วางใหม่ไม่ผ่าน ({n.get('message')}) — คืนใบเดิม lot {o.volume_current} แล้ว"}
        return {**row, "ok": False, "uncertain": back.get("uncertain"),
                "message": f"⚠️ ลบใบเดิมแล้ว วางใหม่ไม่ผ่าน ({n.get('message')}) และคืนใบเดิมไม่ผ่าน ({back.get('message')})"}

    # ---------- internals ----------
    def _position(self, ticket: int):
        res = mt5.positions_get(ticket=ticket)
        if not res:
            raise TradeError(f"ไม่พบ position {ticket} (ปิดไปแล้ว?)")
        return res[0]

    def _order(self, ticket: int):
        res = mt5.orders_get(ticket=ticket)
        if not res:
            raise TradeError(f"ไม่พบ pending {ticket} (ถูก fill/ยกเลิกไปแล้ว?)")
        return res[0]

    def send(self, req: dict, extra: dict | None = None) -> dict:
        try:
            r = mt5_trade.order_send(req)
        except MT5Timeout as e:
            return {"ok": False, "retcode": None, "uncertain": True, "request": req,
                    "message": f"{e} — คำสั่งอาจค้างที่โบรกและถูก fill ทีหลัง ดูตาราง positions/pending ก่อนส่งซ้ำ"}
        except RuntimeError as e:
            if "MT5Init" in str(e):   # เชื่อม terminal ไม่ได้ = ยังไม่ได้ส่งคำสั่งแน่นอน
                return {"ok": False, "retcode": None, "request": req, "message": f"ส่งไม่ได้ — {e}"}
            raise
        if r is None:
            err = mt5_trade.none_error
            code, msg = None, f"order_send คืนค่าว่าง: {err} — ไม่แน่ใจว่าถึงโบรกไหม ดูตาราง positions/pending ก่อนส่งซ้ำ"
            return {"ok": False, "retcode": code, "message": msg, "request": req, "uncertain": True, "mt5_error": str(err)}
        ok = r.retcode in OK_RETCODES
        out = {"ok": ok, "retcode": r.retcode, "message": retcode_text(r.retcode),
               "broker_comment": getattr(r, "comment", ""), "order": getattr(r, "order", 0),
               "deal": getattr(r, "deal", 0), "price": getattr(r, "price", 0), "volume": getattr(r, "volume", 0),
               "request": req}
        if r.retcode in UNCERTAIN_RETCODES:
            out["uncertain"] = True   # ไม่รู้ผลจริง: server อาจ fill ทีหลัง (เจอจริง 2026-09-27 BTCUSDm timeout 3 นาทีแล้ว fill)
        if extra:
            out.update(extra)
        return out
