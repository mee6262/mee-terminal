"""ตรวจว่า terminal MT5 ตัวหนึ่ง login บัญชีอะไรอยู่ — gateway เรียกเป็น subprocess (หน้าเว็บ ตั้งค่า -> บัญชี MT5)

รัน: python mt5probe.py <path terminal64.exe> <portable 0|1>  -> JSON 1 บรรทัดทาง stdout
ไม่ใช้รหัสผ่าน: อ่านบัญชีที่ terminal จำไว้ (login ค้างไว้ใน MT5 เอง) — ถ้า terminal ยังไม่เปิด MT5 จะเปิดให้
"""
import json
import sys

TRADE_MODES = {0: "demo", 1: "contest", 2: "real"}


def probe(path: str, portable: bool) -> dict:
    import MetaTrader5 as mt5
    from accounts import detect_kind
    if not mt5.initialize(path=path, portable=portable, timeout=20000):
        err = mt5.last_error()
        hint = " — ลองสลับตัวเลือก portable" if err and err[0] == -10003 else ""
        return {"ok": False, "error": f"เชื่อม terminal ไม่ได้: {err}{hint}"}
    try:
        a = mt5.account_info()
        if a is None:
            return {"ok": False, "error": "terminal ยังไม่ได้ login บัญชี — เปิด MT5 แล้ว login (ติ๊กจำรหัส) ก่อน"}
        t = getattr(mt5, "terminal_info", lambda: None)()
        return {
            "ok": True, "login": a.login, "server": a.server, "name": a.name, "company": getattr(a, "company", ""),
            "currency": a.currency, "leverage": a.leverage, "balance": a.balance,
            "trade_mode": a.trade_mode, "mode": TRADE_MODES.get(a.trade_mode, str(a.trade_mode)),
            "kind": detect_kind(a.currency, a.server),
            "terminal": {"name": getattr(t, "name", ""), "company": getattr(t, "company", ""),
                         "data_path": getattr(t, "data_path", "")} if t else None,
        }
    finally:
        mt5.shutdown()


if __name__ == "__main__":
    try:
        out = probe(sys.argv[1], sys.argv[2] == "1")
    except Exception as e:  # ส่งกลับเป็น JSON เสมอ
        out = {"ok": False, "error": f"{type(e).__name__}: {e}"}
    print(json.dumps(out, ensure_ascii=False))
