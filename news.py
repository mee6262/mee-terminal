"""ปฏิทินข่าวเศรษฐกิจ (TradingView economic calendar) — ยกมาจาก mt5_dashboard/main.py (/api/news) แทบไม่แก้
เปลี่ยนแค่: pytz -> zoneinfo, requests -> httpx, cache อยู่ในโมดูลนี้"""
import time
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import httpx


_UTC = timezone.utc


class pytz:  # shim ให้โค้ดเดิมใช้ได้โดยไม่ต้องลง pytz
    timezone = ZoneInfo
    utc = _UTC


# 🆕 [Dashboard] หน้า News — ปฏิทินข่าวเศรษฐกิจสัปดาห์นี้ (มีค่า Actual/Forecast/Previous)
# ⚠️ ForexFactory free feed (ff_calendar_thisweek.json) มีแค่ forecast/previous — "ไม่มี actual เลย"
# จึงใช้ปฏิทินของ TradingView (economic-calendar.tradingview.com) แทน: เหตุการณ์/ระดับความสำคัญ
# ชุดเดียวกัน + มี actual ครบ + คืน currency มาตรงๆ ไม่ต้อง map country→currency เอง
TV_CALENDAR_URL = "https://economic-calendar.tradingview.com/events"
NEWS_COUNTRIES = "US,EU,GB,JP,AU,NZ"  # สกุลที่ชุดคู่เทรดปัจจุบันเกี่ยวข้อง (EUR/USD/GBP/JPY/AUD/NZD + ทอง/คริปโตอิง USD)
_NEWS_TTL_SEC = 1800  # cache 30 นาที — กัน hammer ต้นทาง
_news_cache = {"fetched_at": None, "events": None, "ts": 0.0}
_TH_DAYS = ["จันทร์", "อังคาร", "พุธ", "พฤหัสบดี", "ศุกร์", "เสาร์", "อาทิตย์"]
_TV_IMPACT = {1: "High", 0: "Medium", -1: "Low"}
_CUR_PREFIX_UNITS = {"$", "£", "€", "¥", "A$", "C$", "NZ$", "Fr", "CHF", "R$", "S$", "HK$"}


def _fmt_news_value(v, unit, scale):
    """แปลงค่าดิบ (number/None) + unit ('%','£',...) + scale ('K','M','B','T') เป็นสตริงพร้อมโชว์"""
    if v is None or v == "":
        return ""
    try:
        s = f"{float(v):g}"
    except (TypeError, ValueError):
        s = str(v).strip()
    if scale:
        s = f"{s}{scale}"
    if unit == "%":
        return f"{s}%"
    if unit:
        return f"{unit}{s}" if unit in _CUR_PREFIX_UNITS else f"{s} {unit}"
    return s


def _week_range_utc():
    """ช่วง จ.00:00 – อา.23:59 ของสัปดาห์นี้ (อิงเวลาไทย) แปลงเป็น ISO UTC ให้ TradingView"""
    tz = pytz.timezone("Asia/Bangkok")
    now_th = datetime.now(tz)
    monday = (now_th - timedelta(days=now_th.weekday())).replace(hour=0, minute=0, second=0, microsecond=0)
    sunday_end = monday + timedelta(days=13, hours=23, minutes=59, seconds=59)   # สัปดาห์นี้ + สัปดาห์หน้า (ดูล่วงหน้าได้ช่วงเสาร์-อาทิตย์)
    fmt = lambda d: d.astimezone(pytz.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    return fmt(monday), fmt(sunday_end)


# (keyword ในชื่อข่าว, rule, หมวดไทย) — เช็คตามลำดับ เจอตัวแรกที่ตรง
#   up_good   = ตัวเลขยิ่งสูง ยิ่งหนุนค่าเงินของข่าวนั้น (เงินเฟ้อ/จ้างงาน/PMI/GDP/ดอกเบี้ย/การค้า)
#   down_good = ยิ่งต่ำ ยิ่งหนุน (อัตราว่างงาน / ยอดขอรับสวัสดิการว่างงาน)
#   context   = ตีความจากตัวเลขตรงๆ ไม่ได้ ต้องดูเนื้อหา (ถ้อยแถลง/ประชุม/สต็อกน้ำมัน)
_INDICATOR_RULES = [
    (("unemployment", "jobless claims", "jobless rate", "claimant count", "initial claims", "continuing claims"), "down_good", "การจ้างงาน"),
    (("inflation rate", "cpi", "consumer price", "producer price", "producer prices", "ppi", "pce price", "core pce", "hicp", "inflation expectations", "inflation gauge"), "up_good", "เงินเฟ้อ"),
    (("interest rate decision", "rate decision", "rate statement", "cash rate", "bank rate", "policy rate", "deposit facility", "fed interest rate", "monetary policy statement"), "up_good", "อัตราดอกเบี้ย"),
    (("gdp",), "up_good", "การเติบโต (GDP)"),
    (("non farm", "non-farm", "nonfarm", "payrolls", "employment change", "adp employment", "employment report", "jolts", "job openings", "job quits", "participation rate"), "up_good", "การจ้างงาน"),
    (("average earnings", "hourly earnings", "wage price", "wage growth", "labour costs", "labor costs"), "up_good", "ค่าจ้าง"),
    (("retail sales", "retail trade", "consumer spending", "personal spending", "household spending"), "up_good", "การบริโภค"),
    (("pmi", "ism ", "ivey", "business confidence", "consumer confidence", "consumer sentiment", "economic sentiment", "business climate", "ifo ", "zew ", "tankan", "sentix", "nab business", "westpac consumer", "gfk consumer"), "up_good", "ความเชื่อมั่น/PMI"),
    (("industrial production", "manufacturing production", "factory orders", "durable goods", "machinery orders", "machine tool orders", "capacity util"), "up_good", "ภาคการผลิต"),
    (("building permits", "housing starts", "home sales", "building approvals", "construction output", "construction pmi", "construction orders", "house price", "housing price", "dwelling price", "mortgage approvals", "mortgage lending", "home loans", "housing credit"), "up_good", "ภาคอสังหาฯ"),
    (("balance of trade", "trade balance", "current account", "goods trade"), "up_good", "ดุลการค้า"),
    (("crude oil", "gasoline stocks", "distillate", "eia ", "api crude", "oil inventories", "crude oil stocks", "natural gas stocks"), "context", "สต็อกพลังงาน"),
    (("speaks", "speech", "press conference", "testimony", "meeting minutes", "monetary policy meeting", "mpc ", "fomc member", "governor "), "context", "ถ้อยแถลง/ประชุม"),
]


def _classify_indicator(title):
    t = (title or "").lower()
    for keys, rule, cat in _INDICATOR_RULES:
        if any(k in t for k in keys):
            return rule, cat
    return None, None


def _assess_news_event(title, currency, actual, forecast, previous):
    """คืน dict {tone, category, text} อธิบายผลกระทบต่อค่าเงิน — หรือ None ถ้าจัดหมวดข่าวนี้ไม่ได้"""
    rule, cat = _classify_indicator(title)
    if rule is None:
        return None
    cur = currency or "สกุลเงินนี้"

    if rule == "context":
        return {"tone": "neutral", "category": cat,
                "text": f"ดูที่เนื้อหา/น้ำเสียงมากกว่าตัวเลข — ท่าทีเข้มงวด (hawkish) มักหนุน {cur}, ผ่อนคลาย (dovish) มักกดดัน {cur}"}

    up_good = (rule == "up_good")
    eff_more = f"หนุน {cur} แข็งค่า" if up_good else f"กดดัน {cur} อ่อนค่า"
    eff_less = f"กดดัน {cur} อ่อนค่า" if up_good else f"หนุน {cur} แข็งค่า"

    def _num(v):
        try:
            return float(v)
        except (TypeError, ValueError):
            return None

    a, f_val, p = _num(actual), _num(forecast), _num(previous)

    if a is None:
        return {"tone": "pending", "category": cat,
                "text": f"ยังไม่ประกาศ — ถ้าออกมา **สูงกว่าคาด** มัก{eff_more}, **ต่ำกว่าคาด** มัก{eff_less}"}

    ref, ref_word = (f_val, "คาด") if f_val is not None else (p, "ครั้งก่อน")
    if ref is None:
        return {"tone": "neutral", "category": cat, "text": "ไม่มีตัวเลขคาดการณ์/ครั้งก่อนให้เทียบ"}

    delta = a - ref
    if abs(delta) <= abs(ref) * 0.001 + 1e-9:
        same = "ตามคาด" if ref_word == "คาด" else "เท่าครั้งก่อน"
        return {"tone": "neutral", "category": cat, "text": f"ออกมา **{same}** → ผลกระทบต่อ {cur} จำกัด"}

    higher = delta > 0
    tone = "positive" if (higher == up_good) else "negative"
    eff = eff_more if higher else eff_less
    word = ("สูงกว่า" if higher else "ต่ำกว่า") + ref_word
    return {"tone": tone, "category": cat, "text": f"ออกมา **{word}** → {eff}"}


def _build_news_events(raw):
    tz = pytz.timezone("Asia/Bangkok")
    now_th = datetime.now(tz)
    events = []
    for it in raw or []:
        dt = None
        try:
            d = datetime.fromisoformat(str(it.get("date", "")).replace("Z", "+00:00"))
            if d.tzinfo is not None:
                dt = d.astimezone(tz)
        except (TypeError, ValueError):
            pass
        unit, scale = it.get("unit"), it.get("scale")
        currency = str(it.get("currency") or "").strip().upper()
        title = str(it.get("title") or "").strip()
        ev = {
            "currency": currency,
            "impact": _TV_IMPACT.get(it.get("importance"), "Low"),
            "title": title,
            "actual": _fmt_news_value(it.get("actual"), unit, scale),
            "forecast": _fmt_news_value(it.get("forecast"), unit, scale),
            "previous": _fmt_news_value(it.get("previous"), unit, scale),
            "assessment": _assess_news_event(title, currency, it.get("actual"), it.get("forecast"), it.get("previous")),
            # 🆕 [Phase 7] ที่มาของตัวเลข + ลิงก์ออก (บาง event ไม่มี)
            "source": str(it.get("source") or "").strip(),
            "source_url": str(it.get("source_url") or "").strip(),
        }
        if dt is not None:
            ev["day_key"] = dt.strftime("%Y-%m-%d")
            ev["day_label"] = f"{_TH_DAYS[dt.weekday()]} {dt.strftime('%d/%m')}"
            ev["time_th"] = dt.strftime("%H:%M")
            ev["soon"] = 0 <= (dt - now_th).total_seconds() <= 3600
            # 🆕 [Phase 7] epoch วินาที — ให้ frontend นับถอยหลังได้ตรงๆ ไม่ต้อง parse วันที่ไทยเอง
            ev["ts"] = int(dt.timestamp())
            ev["_sort"] = dt.timestamp()
        else:
            ev.update({"day_key": "tbd", "day_label": "ไม่ระบุเวลา", "time_th": "",
                       "soon": False, "ts": None, "_sort": float("inf")})
        events.append(ev)
    events.sort(key=lambda e: e["_sort"])
    for e in events:
        e.pop("_sort", None)
    return events


_news_cache = {"events": None, "fetched_at": None, "ts": 0.0}


def get_news(force: bool = False) -> dict:
    """สัปดาห์นี้ (จ.–อา. เวลาไทย) cache 30 นาที; ดึงไม่ได้แต่มี cache = คืน cache + stale"""
    now = time.time()
    have = _news_cache["events"] is not None
    if have and not force and now - _news_cache["ts"] < _NEWS_TTL_SEC:
        return {"fetched_at": _news_cache["fetched_at"], "stale": False, "events": _news_cache["events"]}
    try:
        frm, to = _week_range_utc()
        r = httpx.get(TV_CALENDAR_URL, params={"from": frm, "to": to, "countries": NEWS_COUNTRIES}, timeout=12,
                      headers={"User-Agent": "Mozilla/5.0 (compatible; MeeTerminal/1.0)",
                               "Origin": "https://www.tradingview.com", "Referer": "https://www.tradingview.com/"})
        r.raise_for_status()
        payload = r.json()
        raw = payload.get("result") if isinstance(payload, dict) else None
        if not isinstance(raw, list):
            raise ValueError("รูปแบบข้อมูลปฏิทินไม่ตรงตามที่คาด")
    except Exception as e:  # noqa: BLE001 — ต้นทางภายนอก ล้มได้หลายแบบ
        if have:
            return {"fetched_at": _news_cache["fetched_at"], "stale": True, "events": _news_cache["events"]}
        raise RuntimeError(f"ดึงปฏิทินข่าวไม่สำเร็จ: {e}")
    events = _build_news_events(raw)
    fetched_at = datetime.now(ZoneInfo("Asia/Bangkok")).strftime("%Y-%m-%dT%H:%M:%S")
    _news_cache.update(events=events, fetched_at=fetched_at, ts=now)
    return {"fetched_at": fetched_at, "stale": False, "events": events}


def cache_info() -> dict:
    """สำหรับหน้าสถานะระบบ: ดึงข่าวล่าสุดเมื่อไหร่ (วินาทีที่แล้ว)"""
    ts = _news_cache["ts"]
    return {"fetched_at": _news_cache["fetched_at"], "age_sec": round(time.time() - ts) if ts else None}
