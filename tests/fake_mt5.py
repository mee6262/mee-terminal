"""MetaTrader5 ปลอมสำหรับเทสต์บน Mac — ใส่เข้า sys.modules ก่อน import worker"""
import os
import sys
import types

# เทสต์ใช้ accounts.json ใน repo (มี demo/cent) ไม่ใช่ accounts.local.json ของเครื่องที่รันจริง
os.environ.setdefault("WT_ACCOUNTS_LOCAL", os.path.join(os.path.dirname(__file__), "_no_local_accounts.json"))
from collections import namedtuple

Account = namedtuple("Account", "login server name currency leverage balance equity margin margin_free margin_level profit trade_mode trade_allowed")
Tick = namedtuple("Tick", "bid ask time_msc")
Pos = namedtuple("Pos", "ticket symbol type volume price_open price_current sl tp profit swap magic comment time")
Ord = namedtuple("Ord", "ticket symbol type volume_current price_open sl tp magic comment time_setup price_stoplimit",
                 defaults=(0.0,))
Sym = namedtuple("Sym", "name description digits visible path")
SymInfo = namedtuple("SymInfo", "name visible")

m = types.ModuleType("MetaTrader5")
for i, tf in enumerate(["M1", "M5", "M15", "M30", "H1", "H4", "D1", "W1", "MN1"]):
    setattr(m, f"TIMEFRAME_{tf}", i + 1)

m.state = {}


def reset(login=111):
    m.state.clear()
    m.state.update(
        up=True, init_ok=True, login=login, init_calls=0,
        ticks={"XAUUSD": Tick(2650.10, 2650.36, 1)},
        positions=[], orders=[], balance=1000.0, term_path="",
    )


def initialize(path=None, **kw):
    m.state["init_calls"] += 1
    m.state["init_kw"] = kw
    return m.state["init_ok"]


m.initialize = initialize
m.shutdown = lambda: None
m.last_error = lambda: (-1, "fake")
TermInfo = namedtuple("TermInfo", "path trade_allowed")
m.terminal_info = lambda: TermInfo(m.state.get("term_path", "x"), m.state.get("algo", True)) if m.state["up"] else None
m.account_info = lambda: Account(m.state["login"], "Exness-Demo", "t", "USD", 500, m.state["balance"],
                                 m.state.get("equity", m.state["balance"]), 0.0, m.state["balance"], 0.0, 0.0,
                                 m.state.get("trade_mode", 0), True) if m.state["up"] else None
m.symbol_info = lambda s: SymInfo(s, True) if s in m.state["ticks"] else None
m.symbol_select = lambda s, on=True: s in m.state["ticks"]
m.symbol_info_tick = lambda s: m.state["ticks"].get(s)
m.positions_get = lambda ticket=None: tuple(p for p in m.state["positions"] if ticket is None or p.ticket == ticket)
m.orders_get = lambda ticket=None: tuple(o for o in m.state["orders"] if ticket is None or o.ticket == ticket)
m.symbols_get = lambda: tuple(Sym(s, s, 2 if s == "XAUUSD" else 5, True, "x") for s in m.state["ticks"])


def _rates(n):
    return [{"time": 1_700_000_000 + 60 * i, "open": 1.0, "high": 2.0, "low": 0.5, "close": 1.5, "tick_volume": 10}
            for i in range(n)]


m.copy_rates_from_pos = lambda s, tf, start, n: _rates(n)
m.copy_rates_from = lambda s, tf, to, n: _rates(n)
m.reset = reset
m.Pos, m.Tick = Pos, Tick
reset()
sys.modules["MetaTrader5"] = m


# ---------- P3 trading ----------
for i, n in enumerate(["BUY", "SELL", "BUY_LIMIT", "SELL_LIMIT", "BUY_STOP", "SELL_STOP", "BUY_STOP_LIMIT", "SELL_STOP_LIMIT"]):
    setattr(m, f"ORDER_TYPE_{n}", i)
m.ORDER_STATE_CANCELED, m.ORDER_STATE_PARTIAL, m.ORDER_STATE_FILLED, m.ORDER_STATE_REJECTED, m.ORDER_STATE_EXPIRED = 2, 3, 4, 5, 6
HistOrd = namedtuple("HistOrd", "ticket state")
m.HistOrd = HistOrd
m.history_orders_get = lambda ticket=None: tuple(o for o in m.state.get("hist_orders", []) if ticket is None or o.ticket == ticket)
m.TRADE_ACTION_DEAL, m.TRADE_ACTION_PENDING, m.TRADE_ACTION_SLTP, m.TRADE_ACTION_MODIFY, m.TRADE_ACTION_REMOVE = 1, 5, 6, 7, 8
m.ORDER_FILLING_FOK, m.ORDER_FILLING_IOC, m.ORDER_FILLING_RETURN = 0, 1, 2
m.ORDER_TIME_GTC = 0
FullSym = namedtuple("FullSym", "name visible digits point volume_min volume_max volume_step trade_tick_size "
                     "trade_tick_value trade_tick_value_loss trade_contract_size trade_stops_level trade_mode "
                     "currency_profit filling_mode description path")
Result = namedtuple("Result", "retcode comment order deal price volume")
Deal = namedtuple("Deal", "type profit commission swap fee")


def _full(s):
    gold = s == "XAUUSD"
    return FullSym(s, True, 2 if gold else 5, 0.01 if gold else 1e-5, 0.01, 100.0, 0.01, 0.01 if gold else 1e-5,
                   1.0, 1.0, 100 if gold else 100000, 0, m.state.get("sym_trade_mode", 4), "USD", 1, s, "x")


m.symbol_info = lambda s: _full(s) if s in m.state["ticks"] else None


def order_calc_profit(otype, sym, vol, a, b):
    if m.state.get("calc_profit_zero"):
        return 0.0
    cs = 100 if sym == "XAUUSD" else 100000
    return (b - a) * cs * vol * (1 if otype == 0 else -1)


m.order_calc_profit = order_calc_profit
m.order_calc_margin = lambda otype, sym, vol, price: vol * price * (100 if sym == "XAUUSD" else 100000) / 500


def order_send(req):
    m.state.setdefault("sent", []).append(dict(req))
    code = m.state.get("next_retcode", 10009)
    return Result(code, "fake", 1234, 5678, req.get("price", 0), req.get("volume", 0))


m.order_send = order_send
def history_deals_get(frm=None, to=None, position=None):
    ds = m.state.get("deals", [])
    if position is not None:
        return tuple(d for d in m.state.get("all_deals", ds) if getattr(d, "position_id", None) == position)
    return tuple(ds)


m.history_deals_get = history_deals_get
m.Ord, m.Deal = Ord, Deal

m.COPY_TICKS_ALL = 1


def _ts(x):
    assert not isinstance(x, int), "MT5 ต้องได้ datetime"
    return int(x.timestamp())


def copy_ticks_range(sym, a, b, flags):
    a, b = _ts(a), _ts(b)
    return [t for t in m.state.get("tick_hist", []) if a * 1000 <= t["time_msc"] < b * 1000] or None


def copy_rates_range(sym, tf, a, b):
    a, b = _ts(a), _ts(b)
    return [r for r in m.state.get("m1_hist", []) if a <= r["time"] <= b] or None


m.copy_ticks_range = copy_ticks_range
m.copy_rates_range = copy_rates_range

FullDeal = namedtuple("FullDeal", "ticket time_msc type entry position_id symbol magic volume price profit commission swap fee comment")
m.FullDeal = FullDeal
