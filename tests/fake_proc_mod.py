"""module แทน MetaTrader5 ใน process ลูก สำหรับเทสต์ mt5proc (Mac ไม่มี MetaTrader5)"""
import time
from collections import namedtuple

Pos = namedtuple("TradePosition", "ticket symbol sl")
_state = {"init": 0}


def initialize(**kw):
    _state["init"] += 1
    _state["kw"] = kw
    return not kw.get("fail")


def last_error():
    return (-10004, "No IPC connection") if not _state["init"] else (1, "Success")


def order_send(req):
    return None if req.get("bad") else {"retcode": 10009}


def terminal_info():
    return Pos(1, "term", 0.0) if _state["init"] else None


def inits():
    return _state["init"]


def echo(x):
    return x


def positions():
    return (Pos(7, "XAUUSD", 2640.5), Pos(8, "EURUSD", 0.0))


def slow(s):
    time.sleep(s)
    return "late"


def boom():
    raise ValueError("bad request")


def cstruct():
    """structseq (ชนิดเดียวกับที่ MetaTrader5 คืน) — ไม่มี _fields/_asdict แบบ namedtuple"""
    import os
    return os.stat(".")
