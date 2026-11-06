// Mee Terminal — P2 กราฟ (KLineChart 10) : panels 1/2/4, lazy load, แท่งสดจาก MT5, เครื่องมือวาด
"use strict";

const TFS = ["M1", "M5", "M15", "M30", "H1", "H4", "D1", "W1", "MN1"];
const TF_PERIOD = {
  M1: { type: "minute", span: 1 }, M5: { type: "minute", span: 5 }, M15: { type: "minute", span: 15 },
  M30: { type: "minute", span: 30 }, H1: { type: "hour", span: 1 }, H4: { type: "hour", span: 4 },
  D1: { type: "day", span: 1 }, W1: { type: "week", span: 1 }, MN1: { type: "month", span: 1 },
};
const PAGE = 1000;
const BAR_CACHE = new Map();         // acct|symbol|tf -> { bars (ชุดแรก), more, at } เก็บล่าสุด BAR_CACHE_MAX ชุด
const BAR_CACHE_MAX = 24, BAR_CACHE_TTL = 30 * 60e3;
const PREFETCH_TFS = ["M15", "H1", "M5", "H4", "M30", "M1"];
const TIMEZONES = { "Asia/Bangkok": "เวลาไทย", "America/New_York": "New York", UTC: "UTC" };

// เครื่องมือวาด: [overlay name, ไอคอน, คำอธิบาย]
const DRAW_TOOLS = [
  ["segment", "╱", "เส้นเทรนด์"],
  ["rayLine", "↗", "Ray"],
  ["straightLine", "⤢", "เส้นยาวสุด"],
  ["horizontalStraightLine", "─", "เส้นแนวนอน"],
  ["horizontalRayLine", "⟶", "แนวนอน ray"],
  ["verticalStraightLine", "│", "เส้นแนวตั้ง"],
  ["priceChannelLine", "⫽", "Channel"],
  ["rectBox", "▭", "กล่อง"],
  ["fibRetracement", "Fib", "Fibonacci (ตั้งค่าระดับ/สีได้ที่ ⚙)"],
  ["textLabel", "T", "ข้อความ"],
  ["measure", "📏", "วัดระยะ (ไม้บรรทัด): แตะจุดเริ่ม -> จุดจบ · แตะกราฟอีกครั้ง = ลบ"],
];

const DARK_STYLES = {
  grid: { horizontal: { color: "#1f232b" }, vertical: { color: "#1f232b" } },
  candle: {
    bar: {
      upColor: "#26a69a", downColor: "#ef5350", noChangeColor: "#8a91a0",
      upBorderColor: "#26a69a", downBorderColor: "#ef5350", noChangeBorderColor: "#8a91a0",
      upWickColor: "#26a69a", downWickColor: "#ef5350", noChangeWickColor: "#8a91a0",
    },
    tooltip: { showRule: "none", text: { color: "#c9ced8" } },
    priceMark: { high: { color: "#c9ced8" }, low: { color: "#c9ced8" },
      // เส้นราคาล่าสุดของ KLineChart ถูกหนีบไว้ขอบกราฟตอนราคาอยู่นอกจอ -> ปิด แล้ววาดเส้น Bid เอง (app.js) แบบ TradingView
      last: { show: false, upColor: "#26a69a", downColor: "#ef5350", noChangeColor: "#8a91a0" } },
  },
  indicator: { tooltip: { showRule: "none", text: { color: "#c9ced8" } } },
  xAxis: { axisLine: { color: "#2a2f3a" }, tickLine: { color: "#2a2f3a" }, tickText: { color: "#8a91a0" } },
  yAxis: { axisLine: { color: "#2a2f3a" }, tickLine: { color: "#2a2f3a" }, tickText: { color: "#8a91a0" } },
  separator: { color: "#2a2f3a" },
  crosshair: {
    horizontal: { line: { color: "#5d6474" }, text: { backgroundColor: "#2a2f3a", borderColor: "#2a2f3a" } },
    vertical: { line: { color: "#5d6474" }, text: { backgroundColor: "#2a2f3a", borderColor: "#2a2f3a" } },
  },
};

// จอสัมผัส: ขยายพื้นที่แตะของวงกลม (จุดปรับตำแหน่งวัตถุ) ออกไปอีก TOUCH_SLOP px โดยภาพที่วาดเท่าเดิม
const TOUCH_SLOP = 14;
const LINE_SLOP = 10;
if (typeof isTouchUI === "function" && isTouchUI()) {
  const origDraw = klinecharts.getFigureClass("circle").prototype.drawImp;
  klinecharts.registerFigure({
    name: "circle",
    checkEventOn: (p, attrs) => [].concat(attrs).some((a) => {
      const dx = p.x - a.x, dy = p.y - a.y, r = a.r + TOUCH_SLOP;
      return dx * dx + dy * dy <= r * r;
    }),
    draw: (ctx, attrs, styles) => origDraw.call(null, ctx, attrs, styles),
  });
  // ตัวเส้นของวัตถุ (trend/ray/แนวนอน/แนวตั้ง/Fib/channel): เดิมแตะโดนเมื่อห่างเส้น < 2px -> ขยายเป็น LINE_SLOP px
  const origLine = klinecharts.getFigureClass("line").prototype.drawImp;
  const segDist2 = (p, a, b) => {
    const vx = b.x - a.x, vy = b.y - a.y, L = vx * vx + vy * vy;
    const t = L ? Math.max(0, Math.min(1, ((p.x - a.x) * vx + (p.y - a.y) * vy) / L)) : 0;
    const dx = p.x - (a.x + t * vx), dy = p.y - (a.y + t * vy);
    return dx * dx + dy * dy;
  };
  klinecharts.registerFigure({
    name: "line",
    checkEventOn: (p, attrs) => [].concat(attrs).some((a) => {
      const c = a.coordinates || [];
      for (let i = 1; i < c.length; i++) if (segDist2(p, c[i - 1], c[i]) <= LINE_SLOP * LINE_SLOP) return true;
      return false;
    }),
    draw: (ctx, attrs, styles) => origLine.call(null, ctx, attrs, styles),
  });
}

// ---------- overlay ที่ KLineChart ไม่มีให้ ----------
klinecharts.registerOverlay({
  name: "rectBox",
  totalStep: 3,
  needDefaultPointFigure: true,
  needDefaultXAxisFigure: true,
  needDefaultYAxisFigure: true,
  createPointFigures: ({ overlay, coordinates }) => {
    if (coordinates.length < 2) return [];
    const [a, b] = coordinates;
    const ln = overlay.styles?.line || {};
    const color = ln.color || "#2f81f7";
    return [{
      type: "rect",
      attrs: { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) },
      styles: { style: "stroke_fill", color: withAlpha(color, 0.12), borderColor: color, borderSize: ln.size || 1,
        borderStyle: ln.style || "solid", borderDashedValue: [4, 3] },
    }];
  },
});

// ซูมจากแท่ง TF ใหญ่: ไฮไลต์ช่วงเวลาของแท่งเดิมเต็มความสูงกราฟ
klinecharts.registerOverlay({
  name: "drillZone",
  totalStep: 3,
  needDefaultPointFigure: false,
  createPointFigures: ({ coordinates, bounding }) => {
    if (coordinates.length < 2) return [];
    const [a, b] = coordinates;
    return [{
      type: "rect",
      attrs: { x: Math.min(a.x, b.x), y: 0, width: Math.max(2, Math.abs(b.x - a.x)), height: bounding.height },
      styles: { style: "fill", color: "rgba(47,129,247,0.12)" },
      ignoreEvent: true,
    }];
  },
});

// ไม้บรรทัดแบบ TradingView: ระยะราคา (+%), จุด, จำนวนแท่ง, ช่วงเวลา, volume — ชั่วคราว ไม่บันทึก
function fmtSpan(ms) {
  const m = Math.round(Math.abs(ms) / 60000);
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60;
  return [d ? `${d}d` : "", h ? `${h}h` : "", mm || (!d && !h) ? `${mm}m` : ""].filter(Boolean).join(" ");
}
klinecharts.registerOverlay({
  name: "measure",
  totalStep: 3,
  needDefaultPointFigure: false,
  createPointFigures: ({ chart, overlay, coordinates }) => {
    if (coordinates.length < 2) return [];
    const [a, b] = coordinates;
    const [p1, p2] = overlay.points;
    if (p1?.value == null || p2?.value == null) return [];
    const digits = chart.getSymbol?.()?.pricePrecision ?? 2;
    const dp = p2.value - p1.value, pct = p1.value ? (dp / p1.value) * 100 : 0;
    const pts = Math.round(dp * 10 ** digits);
    const i1 = p1.dataIndex ?? 0, i2 = p2.dataIndex ?? 0;
    const list = chart.getDataList?.() || [];
    const per = chart.getPeriod?.();
    const perMs = ({ second: 1e3, minute: 6e4, hour: 36e5, day: 864e5, week: 6048e5, month: 2592e6, year: 31536e6 })[per?.type] * (per?.span || 1) || 6e4;
    let vol = 0;
    for (let k = Math.max(0, Math.min(i1, i2)); k <= Math.min(list.length - 1, Math.max(i1, i2)); k++) vol += list[k]?.volume || 0;
    const up = dp >= 0;
    const col = up ? "#2962ff" : "#f23645";
    const x1 = Math.min(a.x, b.x), x2 = Math.max(a.x, b.x), y1 = Math.min(a.y, b.y), y2 = Math.max(a.y, b.y);
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    const sign = (v) => (v > 0 ? "+" : v < 0 ? "−" : "");
    const line1 = `${sign(dp)}${Math.abs(dp).toFixed(digits)} (${sign(pct)}${Math.abs(pct).toFixed(2)}%) ${sign(pts)}${Math.abs(pts).toLocaleString("en-US")} จุด`;
    const line2 = `${i2 - i1} แท่ง, ${fmtSpan((i2 - i1) * perMs)}${vol ? ` · Vol ${Math.round(vol).toLocaleString("en-US")}` : ""}`;
    const ty = up ? y1 - 34 : y2 + 8;   // ป้ายอยู่ปลายทางที่ลากไป (ขึ้น = บน, ลง = ล่าง)
    const txt = (y, text) => ({ type: "text", ignoreEvent: true, attrs: { x: mx, y, text, align: "center", baseline: "top" },
      styles: { color: "#fff", size: 12, backgroundColor: col, borderSize: 0, borderRadius: 3, paddingLeft: 6, paddingRight: 6, paddingTop: 2, paddingBottom: 2 } });
    return [
      { type: "rect", ignoreEvent: true, attrs: { x: x1, y: y1, width: x2 - x1, height: y2 - y1 }, styles: { style: "fill", color: up ? "rgba(41,98,255,0.18)" : "rgba(242,54,69,0.18)" } },
      { type: "line", ignoreEvent: true, attrs: { coordinates: [{ x: mx, y: a.y }, { x: mx, y: b.y }] }, styles: { color: col, size: 1 } },
      { type: "line", ignoreEvent: true, attrs: { coordinates: [{ x: a.x, y: my }, { x: b.x, y: my }] }, styles: { color: col, size: 1 } },
      { type: "polygon", ignoreEvent: true, attrs: { coordinates: [{ x: mx - 4, y: b.y + (up ? 7 : -7) }, { x: mx + 4, y: b.y + (up ? 7 : -7) }, { x: mx, y: b.y }] }, styles: { style: "fill", color: col } },
      txt(ty, line1), txt(ty + 17, line2),
    ];
  },
});

klinecharts.registerOverlay({
  name: "textLabel",
  totalStep: 2,
  needDefaultPointFigure: true,
  createPointFigures: ({ overlay, coordinates }) => [{
    type: "text",
    attrs: { x: coordinates[0].x, y: coordinates[0].y, text: String(overlay.extendData ?? ""), align: "left", baseline: "bottom" },
    styles: { color: overlay.styles?.line?.color || "#e6e8ec", size: 11 + 2 * (overlay.styles?.line?.size || 1),
      backgroundColor: "rgba(0,0,0,0)", borderSize: 0, paddingLeft: 0, paddingRight: 0 },
  }],
});

function withAlpha(hex, a) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || "");
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
}

// ---------- Fibonacci retracement แบบ TradingView: ระดับ/สี/พื้นหลังปรับได้ ----------
const FIB_DEFAULT = {
  levels: [
    { v: 0, c: "#787b86", on: true }, { v: 0.236, c: "#f23645", on: true }, { v: 0.382, c: "#ff9800", on: true },
    { v: 0.5, c: "#4caf50", on: true }, { v: 0.618, c: "#089981", on: true }, { v: 0.786, c: "#00bcd4", on: true },
    { v: 1, c: "#787b86", on: true }, { v: 1.618, c: "#2962ff", on: true }, { v: 2.618, c: "#f23645", on: false },
    { v: 3.618, c: "#9c27b0", on: false }, { v: 4.236, c: "#e91e63", on: false },
  ],
  fill: true, opacity: 0.15, showPrice: true, showLevel: true, trend: true, reverse: false,
  extendLeft: false, extendRight: false, width: 1,
};
function fibDefault() { return { ...FIB_DEFAULT, ...store("wt.fibDefault", {}) }; }

klinecharts.registerOverlay({
  name: "fibRetracement",
  totalStep: 3,
  needDefaultPointFigure: true,
  needDefaultXAxisFigure: true,
  needDefaultYAxisFigure: true,
  createPointFigures: ({ chart, overlay, coordinates, bounding, yAxis }) => {
    if (coordinates.length < 2 || overlay.points.length < 2 || !yAxis) return [];
    const cfg = { ...FIB_DEFAULT, ...(typeof overlay.extendData === "object" ? overlay.extendData : {}) };
    const [a, b] = coordinates;
    const start = overlay.points[0].value, end = overlay.points[1].value;
    const prec = chart.getSymbol()?.pricePrecision ?? 2;
    const left = cfg.extendLeft ? 0 : Math.min(a.x, b.x);
    const right = cfg.extendRight ? bounding.width : Math.max(a.x, b.x);
    // TradingView: 0 ที่จุดปลาย, 1 ที่จุดเริ่ม (reverse = สลับ)
    const priceOf = (lv) => (cfg.reverse ? start + (end - start) * lv : end + (start - end) * lv);
    const lv = cfg.levels.filter((l) => l.on).map((l) => ({ ...l, p: priceOf(l.v), y: yAxis.convertToPixel(priceOf(l.v)) }))
      .sort((x, y) => x.v - y.v);
    const figs = [];
    if (cfg.fill) {
      for (let i = 0; i < lv.length - 1; i++) {
        const y1 = lv[i].y, y2 = lv[i + 1].y;
        figs.push({ type: "rect", ignoreEvent: true, attrs: { x: left, y: Math.min(y1, y2), width: right - left, height: Math.abs(y2 - y1) },
          styles: { style: "fill", color: withAlpha(lv[i + 1].c, cfg.opacity) } });
      }
    }
    for (const l of lv) {
      figs.push({ type: "line", attrs: { coordinates: [{ x: left, y: l.y }, { x: right, y: l.y }] },
        styles: { color: l.c, size: cfg.width, style: "solid" } });
      const parts = [];
      if (cfg.showLevel) parts.push(String(l.v));
      if (cfg.showPrice) parts.push(cfg.showLevel ? `(${l.p.toFixed(prec)})` : l.p.toFixed(prec));
      if (parts.length) {
        const inside = left < 120;
        figs.push({ type: "text", ignoreEvent: true,
          attrs: { x: inside ? Math.max(left, 0) + 4 : left - 6, y: l.y, text: parts.join(" "), align: inside ? "left" : "right", baseline: inside ? "bottom" : "middle" },
          styles: { color: l.c, size: 12, backgroundColor: "rgba(0,0,0,0)", borderSize: 0, paddingLeft: 0, paddingRight: 0 } });
      }
    }
    if (cfg.trend) {
      figs.push({ type: "line", attrs: { coordinates: [a, b] }, styles: { color: "#8a91a0", size: 1, style: "dashed", dashedValue: [5, 5] } });
    }
    return figs;
  },
});

// เส้นราคาของ position / pending / preview + ปุ่ม chip บนเส้น (แบบ Exness / myfxbook)
// extendData: { color, dashed, chips: [{ key, text, bg, fg, border, dashed }] }
const CHIP_SIZE = 12;
// ลำดับซ้อน (สูง = อยู่บน + ได้รับแตะก่อน): ร่างออเดอร์ > ไม้จริง > alert ราคา > เส้น Ask
const LINE_Z = { preview: 1000, replay: 900, trade: 800, palert: 600, quote: 100 };
const ACTION_CHIPS = new Set(["ok", "cancel", "x", "be", "tp", "sl", "oco", "exp"]);
const chipHits = new Map();   // overlay id -> [{key, x, y, w, h}] พิกัดใน main pane (ใช้จับลากชิป TP/SL)
klinecharts.registerOverlay({
  name: "tradeLine",
  totalStep: 2,
  needDefaultPointFigure: false,
  needDefaultYAxisFigure: true,
  createPointFigures: ({ overlay, coordinates, bounding }) => {
    const d = overlay.extendData || {};
    const y = coordinates[0].y;
    const figs = [
      // แถบใส ±7px ให้จับลากง่าย (โดยเฉพาะบนมือถือ) — เส้นจริงบางแค่ 1px
      { key: "band", type: "rect", ignoreEvent: !!d.passive, attrs: { x: 0, y: y - 7, width: bounding.width, height: 14 },
        styles: { style: "fill", color: "rgba(0,0,0,0.001)", borderSize: 0 } },
      { key: "line", type: "line", ignoreEvent: !!d.passive, attrs: { coordinates: [{ x: 0, y }, { x: bounding.width, y }] },
        styles: { color: d.color, size: 1, style: d.dashed ? "dashed" : "solid", dashedValue: [4, 3] } },
    ];
    const chips = d.chips || [];
    const padX = 7, gap = 3;
    const widths = chips.map((c) => klinecharts.utils.calcTextWidth(c.text, CHIP_SIZE) + padX * 2);
    const total = widths.reduce((a, w) => a + w + gap, 0);
    let x = Math.max(4, bounding.width - 4 - total);   // ชิดขวา (ติดแกนราคา)
    const hits = [];
    chips.forEach((c, i) => {
      hits.push({ key: c.key, x, y: y - (CHIP_SIZE + 8) / 2 - 3, w: widths[i], h: CHIP_SIZE + 14 });
      figs.push({
        key: `chip:${c.key}`, type: "text",
        attrs: { x, y, text: c.text, align: "left", baseline: "middle" },
        styles: {
          style: "stroke_fill", color: c.fg || "#fff", backgroundColor: c.bg || d.color,
          borderColor: c.border || c.bg || d.color, borderSize: 1, borderStyle: c.dashed ? "dashed" : "solid",
          borderDashedValue: [3, 2], borderRadius: 4, size: CHIP_SIZE,
          paddingLeft: padX, paddingRight: padX, paddingTop: 4, paddingBottom: 4,
        },
      });
      x += widths[i] + gap;
    });
    chipHits.set(overlay.id, hits);
    return figs;
  },
});

// โซน R:R ของร่างออเดอร์ (แบบ Long/Short Position ของ TradingView): เขียว = entry→TP, แดง = entry→SL
// extendData: { entry, sl, tp, top: "ข้อความในโซน TP", bottom: "ข้อความในโซน SL" }
klinecharts.registerOverlay({
  name: "rrZone",
  totalStep: 2,
  needDefaultPointFigure: false,
  createPointFigures: ({ overlay, bounding, yAxis }) => {
    const d = overlay.extendData || {};
    if (!yAxis || !d.entry) return [];
    const x0 = Math.round(bounding.width * 0.5), x1 = bounding.width - 70;
    if (x1 - x0 < 40) return [];
    const ye = yAxis.convertToPixel(d.entry);
    const figs = [];
    const box = (lvl, color, text) => {
      const y = yAxis.convertToPixel(lvl);
      figs.push({ type: "rect", ignoreEvent: true, attrs: { x: x0, y: Math.min(y, ye), width: x1 - x0, height: Math.abs(y - ye) },
        styles: { style: "fill", color } });
      if (text) figs.push({ type: "text", ignoreEvent: true,
        attrs: { x: (x0 + x1) / 2, y: (y + ye) / 2, text, align: "center", baseline: "middle" },
        styles: { color: "#e6e8ec", size: 11, backgroundColor: "rgba(15,17,21,0.55)", borderSize: 0, borderRadius: 3,
          paddingLeft: 5, paddingRight: 5, paddingTop: 2, paddingBottom: 2 } });
    };
    if (d.tp) box(d.tp, "rgba(38,166,154,0.16)", d.top);
    if (d.sl) box(d.sl, "rgba(239,83,80,0.16)", d.bottom);
    return figs;
  },
});

// ไม้ในอดีตบนกราฟ: เส้นประจากจุดเข้า -> จุดออก + จุด + ผลสุทธิ
// extendData: { win, label, side }
klinecharts.registerOverlay({
  name: "histTrade",
  totalStep: 3,
  needDefaultPointFigure: false,
  createPointFigures: ({ overlay, coordinates }) => {
    if (coordinates.length < 2) return [];
    const d = overlay.extendData || {};
    const color = d.win ? "#26a69a" : "#ef5350";
    const [a, b] = coordinates;
    const tri = (p, up, c) => ({ type: "polygon", ignoreEvent: true,
      attrs: { coordinates: up ? [{ x: p.x, y: p.y - 1 }, { x: p.x - 5, y: p.y + 8 }, { x: p.x + 5, y: p.y + 8 }]
                               : [{ x: p.x, y: p.y + 1 }, { x: p.x - 5, y: p.y - 8 }, { x: p.x + 5, y: p.y - 8 }] },
      styles: { style: "fill", color: c } });
    const buy = d.side === "buy";
    return [
      { type: "line", ignoreEvent: true, attrs: { coordinates: [a, b] }, styles: { color, size: 1, style: "dashed", dashedValue: [3, 3] } },
      tri(a, buy, buy ? "#2f81f7" : "#f0a030"),
      { type: "circle", ignoreEvent: true, attrs: { x: b.x, y: b.y, r: 3 }, styles: { style: "fill", color } },
      { type: "text", ignoreEvent: true, attrs: { x: b.x + 6, y: b.y, text: d.label || "", align: "left", baseline: "middle" },
        styles: { color, size: 11, backgroundColor: "rgba(15,17,21,0.6)", borderSize: 0, paddingLeft: 3, paddingRight: 3, paddingTop: 1, paddingBottom: 1 } },
    ];
  },
});

// ---------- 1 panel = 1 กราฟ ----------
class ChartPanel {
  constructor(mgr, idx, cfg) {
    this.mgr = mgr;
    this.idx = idx;
    this.symbol = cfg.symbol;
    this.tf = TFS.includes(cfg.tf) ? cfg.tf : "M15";
    this.barCb = null;          // callback ของ KLineChart สำหรับแท่งสด
    this.saveTimer = null;
    this.loadingDrawings = false;
    this.lineMap = new Map();    // "group:key" -> {id, line, dragging}
    this.lineWant = {};          // group -> lines ล่าสุด (ใช้ตอนข้อมูลแท่งยังไม่มา)
    this.picker = null;          // แตะกราฟเพื่อเลือกราคา (วาง alert / เครื่องมือ Long-Short): callback(value)
    this.zoneId = null;          // โซน R:R
    this.zoneWant = null;
    this.histIds = [];           // ไม้ในอดีต
    this.histWant = [];

    this.el = document.createElement("div");
    this.el.className = "chart-panel";
    this.el.addEventListener("pointerdown", () => mgr.setActive(this.idx), true);

    const head = document.createElement("div");
    head.className = "chart-head";
    this.symInput = document.createElement("input");
    this.symInput.setAttribute("list", "sym-list");
    this.symInput.className = "sym-input";
    this.symInput.value = this.symbol;
    this.symInput.addEventListener("change", () => this.setSymbol(this.symInput.value.trim()));
    const symDd = document.createElement("button");
    symDd.type = "button";
    symDd.className = "sym-dd";
    symDd.textContent = "▾";
    symDd.title = "เลือกจาก watchlist";
    symDd.addEventListener("click", (e) => { e.stopPropagation(); openSymMenu(this, symDd); });
    const symWrap = document.createElement("span");
    symWrap.className = "sym-wrap";
    symWrap.append(this.symInput, symDd);
    head.append(symWrap);
    this.tfBtns = {};
    const tfWrap = document.createElement("div");
    tfWrap.className = "tf-wrap";
    for (const tf of TFS) {
      const b = document.createElement("button");
      b.textContent = tf === "MN1" ? "MN" : tf;
      b.className = "tf";
      b.addEventListener("click", () => this.setTf(tf));
      this.tfBtns[tf] = b;
      tfWrap.append(b);
    }
    head.append(tfWrap);
    // OHLC ของแท่งใต้ crosshair (ไม่มี crosshair = แท่งล่าสุด) — ย่อฟอนต์เองให้พอดีช่อง
    this.ohlc = document.createElement("div");
    this.ohlc.className = "ohlc";
    head.append(this.ohlc);
    this.msg = document.createElement("span");
    this.msg.className = "muted small chart-msg";
    head.append(this.msg);
    this.hoverIdx = null;

    this.body = document.createElement("div");
    this.body.className = "chart-body";
    // ปุ่ม » แบบ TradingView: โผล่เมื่อเลื่อนย้อนหลังจนไม่เห็นแท่งล่าสุด กดแล้วกลับไปแท่งล่าสุด
    this.rtBtn = document.createElement("button");
    this.rtBtn.type = "button";
    this.rtBtn.className = "rt-btn";
    this.rtBtn.textContent = "»";
    this.rtBtn.title = "เลื่อนไปแท่งล่าสุด";
    this.rtBtn.hidden = true;
    this.rtBtn.addEventListener("click", (e) => { e.stopPropagation(); if (this.anchor) this.exitAnchor(); else this.chart.scrollToRealTime(250); });
    for (const t of ["pointerdown", "mousedown", "touchstart", "mouseup", "touchend"]) this.rtBtn.addEventListener(t, (e) => e.stopPropagation(), { passive: true });   // ไม่ให้ KLineChart เริ่มลากกราฟ
    this.body.append(this.rtBtn);
    // นับถอยหลังปิดแท่ง ใต้ป้ายราคาล่าสุดบนแกนราคา (แบบ TradingView)
    // ป้ายราคาบนแกนแบบ TradingView: Bid + นับถอยหลังปิดแท่ง (2 บรรทัด) และ Ask — อยู่ที่ราคาจริง หลุดจอ = ซ่อน
    this.tagBid = document.createElement("div");
    this.tagBid.className = "px-tag bid";
    this.tagBid.hidden = true;
    this.tagBid.append(document.createElement("b"), document.createElement("span"));
    this.tagAsk = document.createElement("div");
    this.tagAsk.className = "px-tag ask";
    this.tagAsk.hidden = true;
    // ป้ายราคาของ crosshair (ของ KLineChart วาดบน canvas อยู่ใต้ป้าย Bid/Ask ที่เป็น HTML) -> ทำเป็น HTML ทับอีกชั้น
    this.tagCross = document.createElement("div");
    this.tagCross.className = "px-tag cross";
    this.tagCross.hidden = true;
    this.body.append(this.tagAsk, this.tagBid, this.tagCross);
    this.quote = null;
    this.xline = document.createElement("div");   // crosshair ที่ซิงก์มาจากกราฟอื่น
    this.xline.className = "sync-x";
    this.xline.hidden = true;
    this.body.append(this.xline);
    // crosshair + ป้ายราคา/เวลา ตอนลากวัตถุด้วยนิ้ว (บนคอม KLineChart วาด crosshair ตามเมาส์ให้อยู่แล้ว)
    this.dragV = document.createElement("div");
    this.dragV.className = "drag-x";
    this.dragH = document.createElement("div");
    this.dragH.className = "drag-y";
    this.tagDragPx = document.createElement("div");
    this.tagDragPx.className = "px-tag cross";
    this.tagDragTm = document.createElement("div");
    this.tagDragTm.className = "px-tag cross tm";
    for (const el of [this.dragV, this.dragH, this.tagDragPx, this.tagDragTm]) { el.hidden = true; this.body.append(el); }
    this.lastPointer = "mouse";
    this.body.addEventListener("pointerdown", (e) => { this.lastPointer = e.pointerType || "mouse"; }, { capture: true, passive: true });
    for (const t of ["pointerup", "pointercancel"]) this.body.addEventListener(t, () => this.hideDragCross(), { capture: true, passive: true });
    // รายชื่ออินดิเคเตอร์แบบ TradingView: ซ่อน (👁) / ตั้งค่า / ลบ + พับเก็บทั้งกลุ่ม
    this.legend = document.createElement("div");
    this.legend.className = "ind-legend";
    for (const t of ["pointerdown", "mousedown", "touchstart", "mouseup", "touchend", "click"]) this.legend.addEventListener(t, (e) => e.stopPropagation(), { passive: true });
    this.body.append(this.legend);
    this.el.append(head, this.body);
  }

  mount(parent) {
    parent.append(this.el);
    this.chart = klinecharts.init(this.body, { styles: typeof chartStyles === "function" ? chartStyles() : DARK_STYLES, timezone: this.mgr.timezone, locale: "en-US" });
    this.applyVol();
    this.chart.subscribeAction("onVisibleRangeChange", () => { this.paintRt(); if (this.hoverIdx == null) this.paintOhlc(); this.paintCdSoon(); });
    for (const a of ["onScroll", "onZoom"]) this.chart.subscribeAction(a, () => { this.paintCdSoon(); this.mgr.syncTime(this); });
    this.chart.subscribeAction("onZoom", () => this.saveZoom());
    this.chart.subscribeAction("onCrosshairChange", (c) => {
      const res = c && c.x != null ? this.chart.convertFromPixel([{ x: c.x, y: c.y ?? 0 }], { paneId: c.paneId || "candle_pane" }) : null;
      const pt = Array.isArray(res) ? res[0] : res;
      const idx = pt?.dataIndex;
      this.hoverIdx = Number.isInteger(idx) ? idx : null;
      if (this.hoverIdx != null) this.watchCross();
      this.paintCrossTag(c, pt);
      this.paintOhlcSoon();
      this.mgr.syncCross(this, this.hoverIdx != null ? this.chart.getDataList()[this.hoverIdx]?.timestamp : null);
    });
    this.body.addEventListener("mouseleave", () => { this.hoverIdx = null; this.tagCross.hidden = true; this.paintOhlcSoon(); this.mgr.syncCross(this, null); });
    new ResizeObserver(() => { this.ohlcFit = null; this.paintOhlcSoon(); }).observe(this.ohlc);
    this.chart.setDataLoader({
      getBars: (p) => this.getBars(p),
      subscribeBar: (p) => { this.barCb = p.callback; this.mgr.resubscribe(); },
      unsubscribeBar: () => { this.barCb = null; this.mgr.resubscribe(); },
    });
    this.paintTf();
    this.applySymbol();
    this.initChipPull();
    this.applyIndicators();
  }

  applyVol() {
    const on = store("wt.showVol", true);
    this.chart.removeIndicator({ name: "VOL" });
    if (on) {
      this.chart.createIndicator({ name: "VOL", paneId: "vol" });
      this.chart.setPaneOptions({ id: "vol", height: 60 });
    }
  }

  // ---------- ป้ายราคาของเส้นออเดอร์ + alert ราคาบนแกนราคา (position / pending / TP / SL / ร่าง / alert) — อยู่ใต้ป้าย Bid/Ask ----------
  paintLineTags(br, mr) {
    this.lineTags ??= new Map();
    const main = this.chart.getDom("candle_pane", "main");
    if (!br || !mr) {
      if (!main) return;
      br = this.body.getBoundingClientRect(); mr = main.getBoundingClientRect();
    }
    const last = this.chart.getDataList().at(-1);
    const d = this.chart.getSymbol()?.pricePrecision ?? 2;
    const seen = new Set();
    for (const [k, rec] of this.lineMap) {
      if (!(k.startsWith("trade:") || k.startsWith("preview:") || k.startsWith("palert:") || k.startsWith("replay:")) || !last) continue;
      const v = this.chart.getOverlays({ id: rec.id })[0]?.points?.[0]?.value ?? rec.line.value;   // ระหว่างลาก = ค่าสด
      const pt = this.chart.convertToPixel({ timestamp: last.timestamp, value: v }, { paneId: "candle_pane" });
      const y = Array.isArray(pt) ? pt[0]?.y : pt?.y;
      if (y == null || y < 0 || y > mr.height) continue;
      seen.add(k);
      let el = this.lineTags.get(k);
      if (!el) {
        el = document.createElement("div");
        el.className = "px-tag line";
        this.body.append(el);
        this.lineTags.set(k, el);
      }
      el.textContent = Number(v).toFixed(d);
      el.style.background = rec.line.color;
      el.style.left = `${mr.right - br.left}px`;
      el.style.width = `${Math.max(0, br.right - mr.right)}px`;
      el.style.top = `${mr.top - br.top + y - 9}px`;
    }
    for (const [k, el] of this.lineTags) if (!seen.has(k)) { el.remove(); this.lineTags.delete(k); }
  }

  paintLineTagsSoon() {
    if (this.ltRaf) return;
    this.ltRaf = requestAnimationFrame(() => { this.ltRaf = 0; this.paintLineTags(); });
  }

  // ---------- นับถอยหลังปิดแท่ง ----------
  paintCdSoon() {
    if (this.cdRaf) return;
    this.cdRaf = requestAnimationFrame(() => { this.cdRaf = 0; this.paintCd(); });
  }

  // ---------- ซิงก์หลายกราฟ ----------
  indexAtOrBefore(ts) {
    const list = this.chart.getDataList();
    let lo = 0, hi = list.length - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid].timestamp <= ts) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return ans;
  }

  showXLine(ts) {
    const el = this.xline;
    const main = this.chart.getDom("candle_pane", "main");
    const idx = ts == null ? -1 : this.indexAtOrBefore(ts);
    if (idx < 0 || !main) {
      el.hidden = true;
      if (this.syncHover) { this.syncHover = false; this.hoverIdx = null; this.paintOhlcSoon(); }
      return;
    }
    const list = this.chart.getDataList();
    const pt = this.chart.convertToPixel({ timestamp: list[idx].timestamp, value: list[idx].close }, { paneId: "candle_pane" });
    const x = Array.isArray(pt) ? pt[0]?.x : pt?.x;
    const br = this.body.getBoundingClientRect(), mr = main.getBoundingClientRect();
    if (x == null || x < 0 || x > mr.width) { el.hidden = true; } else {
      el.hidden = false;
      el.style.left = `${mr.left - br.left + x}px`;
      el.style.top = `${mr.top - br.top}px`;
      el.style.height = `${br.bottom - mr.top - 24}px`;
    }
    this.syncHover = true;
    this.hoverIdx = idx;
    this.paintOhlcSoon();
  }

  // เวลาที่ขอบขวาของส่วนที่มองเห็น (null = เห็นแท่งล่าสุดอยู่)
  rightTs() {
    const list = this.chart.getDataList();
    const vr = this.chart.getVisibleRange();
    if (!list.length || vr.realTo >= list.length) return null;
    return list[Math.max(0, Math.min(list.length - 1, vr.realTo - 1))].timestamp;
  }

  setQuote(bid, ask) {
    this.quote = { bid, ask };
    this.paintCdSoon();
  }

  paintCd() {
    const last = this.chart.getDataList().at(-1);
    const main = this.chart.getDom("candle_pane", "main");
    if (!last || !main) { this.tagBid.hidden = this.tagAsk.hidden = true; return; }
    const br = this.body.getBoundingClientRect(), mr = main.getBoundingClientRect();
    this.paintLineTags(br, mr);
    const d = this.chart.getSymbol()?.pricePrecision ?? 2;
    const place = (el, value, h) => {
      const pt = this.chart.convertToPixel({ timestamp: last.timestamp, value }, { paneId: "candle_pane" });
      const y = Array.isArray(pt) ? pt[0]?.y : pt?.y;
      if (y == null || y < 0 || y > mr.height) { el.hidden = true; return false; }
      el.hidden = false;
      el.style.left = `${mr.right - br.left}px`;
      el.style.width = `${Math.max(0, br.right - mr.right)}px`;
      el.style.top = `${mr.top - br.top + y - h / 2}px`;
      return true;
    };
    const bid = this.quote?.bid ?? last.close;
    const left = barCloseMs(last.timestamp, this.tf) - Date.now();
    const cd = left > 0 && left < 40 * 86400000 ? barCdText(left) : "";   // ตลาดปิด / ไม่มีแท่งใหม่ = ไม่แสดงเวลา
    this.tagBid.className = "px-tag bid " + (bid >= last.open ? "up" : "down") + (cd ? " two" : "");
    this.tagBid.firstChild.textContent = bid.toFixed(d);
    this.tagBid.lastChild.textContent = cd;
    const bidShown = place(this.tagBid, bid, cd ? 34 : 18);
    const ask = this.quote?.ask;
    if (ask == null) { this.tagAsk.hidden = true; return; }
    this.tagAsk.textContent = ask.toFixed(d);
    if (place(this.tagAsk, ask, 18) && bidShown) {
      // ป้าย Ask ชนป้าย Bid (สเปรดแคบ) -> ดันขึ้นไปเหนือ Bid
      const tb = parseFloat(this.tagBid.style.top), ta = parseFloat(this.tagAsk.style.top);
      if (ta + 18 > tb) this.tagAsk.style.top = `${tb - 18}px`;
    }
  }

  paintCrossTag(c, pt) {
    const main = this.chart.getDom("candle_pane", "main");
    if (!c || c.y == null || (c.paneId && c.paneId !== "candle_pane") || pt?.value == null || !main) { this.tagCross.hidden = true; return; }
    const br = this.body.getBoundingClientRect(), mr = main.getBoundingClientRect();
    if (c.y < 0 || c.y > mr.height) { this.tagCross.hidden = true; return; }
    this.tagCross.hidden = false;
    this.watchCross();
    this.tagCross.textContent = Number(pt.value).toFixed(this.chart.getSymbol()?.pricePrecision ?? 2);
    this.tagCross.style.left = `${mr.right - br.left}px`;
    this.tagCross.style.width = `${Math.max(0, br.right - mr.right)}px`;
    this.tagCross.style.top = `${mr.top - br.top + c.y - 9}px`;
  }

  // ลากจุด/วัตถุด้วยนิ้ว: เส้นประแนวตั้ง+แนวนอนผ่านจุดที่ลาก พร้อมป้ายราคา (แกนขวา) และเวลา (แกนล่าง)
  paintDragCross(e) {
    if (this.lastPointer === "mouse") return;
    const ov = e?.overlay;
    const paneId = ov?.paneId || "candle_pane";
    const main = this.chart.getDom(paneId, "main");
    if (!ov || !main) return;
    const m = /point_(\d+)$/.exec(e.figure?.key || "");
    const p = m ? ov.points?.[+m[1]] : (e.figure ? null : ov.points?.[ov.points.length - 1]);
    let x = e.x, y = e.y, value = null, ts = null;
    if (p && p.value != null && (p.timestamp != null || p.dataIndex != null)) {
      const px = this.chart.convertToPixel({ timestamp: p.timestamp, dataIndex: p.dataIndex, value: p.value }, { paneId });
      const q = Array.isArray(px) ? px[0] : px;
      if (q?.x != null && q?.y != null) { x = q.x; y = q.y; }
      value = p.value;
      ts = p.timestamp;
    }
    if (x == null || y == null) return;
    if (value == null || ts == null) {
      const v = this.chart.convertFromPixel([{ x, y }], { paneId });
      const q = Array.isArray(v) ? v[0] : v;
      value ??= q?.value;
      ts ??= q?.timestamp ?? this.chart.getDataList()[q?.dataIndex]?.timestamp;
    }
    const br = this.body.getBoundingClientRect(), mr = main.getBoundingClientRect();
    const top = mr.top - br.top, left = mr.left - br.left;
    if (y < 0 || y > mr.height || x < 0 || x > mr.width) { this.hideDragCross(); return; }
    this.tagCross.hidden = true;
    Object.assign(this.dragH.style, { left: `${left}px`, width: `${mr.width}px`, top: `${top + y}px` });
    Object.assign(this.dragV.style, { left: `${left + x}px`, top: "0px", height: `${br.height - 24}px` });
    this.dragH.hidden = this.dragV.hidden = false;
    if (value != null && paneId === "candle_pane") {
      this.tagDragPx.textContent = Number(value).toFixed(this.chart.getSymbol()?.pricePrecision ?? 2);
      Object.assign(this.tagDragPx.style, { left: `${mr.right - br.left}px`, width: `${Math.max(0, br.right - mr.right)}px`, top: `${top + y - 9}px` });
      this.tagDragPx.hidden = false;
    } else this.tagDragPx.hidden = true;
    if (ts != null) {
      this.tagDragTm.textContent = new Date(ts).toLocaleString("en-GB", { timeZone: this.mgr.timezone || undefined,
        weekday: "short", day: "2-digit", month: "short", year: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).replace(/,/g, "");
      this.tagDragTm.hidden = false;
      const w = this.tagDragTm.offsetWidth;
      const tl = Math.max(0, Math.min(br.width - w, left + x - w / 2));
      Object.assign(this.tagDragTm.style, { left: `${tl}px`, top: `${br.height - 22}px` });
    } else this.tagDragTm.hidden = true;
  }

  hideDragCross() {
    if (!this.dragV) return;
    this.dragV.hidden = this.dragH.hidden = this.tagDragPx.hidden = this.tagDragTm.hidden = true;
  }

  // KLineChart ไม่แจ้ง onCrosshairChange ตอน crosshair หายไป (มือถือ: แตะที่อื่น / เลื่อนกราฟ) -> เช็คสถานะจริงเป็นระยะขณะป้ายแสดงอยู่
  watchCross() {
    if (this.crossTimer) return;
    this.crossTimer = setInterval(() => {
      const c = this.chart?.getChartStore?.()?.getCrosshair?.();
      if (!c || c.paneId !== "candle_pane" || c.y == null) this.tagCross.hidden = true;   // อยู่หน้าต่างล่าง = ซ่อนแค่ป้ายราคา
      if (!c || !c.paneId) {        // crosshair หายแล้ว: OHLC กลับไปแท่งล่าสุด
        this.tagCross.hidden = true;
        if (this.hoverIdx != null) { this.hoverIdx = null; this.paintOhlcSoon(); this.mgr.syncCross(this, null); }
        clearInterval(this.crossTimer);
        this.crossTimer = null;
      }
    }, 200);
  }

  // ---------- OHLC บนหัวกราฟ ----------
  paintOhlcSoon() {
    if (this.ohlcRaf) return;
    this.ohlcRaf = requestAnimationFrame(() => { this.ohlcRaf = 0; this.paintOhlc(); });
  }

  paintOhlc() {
    const list = this.chart.getDataList();
    const i = this.hoverIdx != null && this.hoverIdx >= 0 && this.hoverIdx < list.length ? this.hoverIdx : list.length - 1;
    const b = list[i];
    const el = this.ohlc;
    if (!b) { el.replaceChildren(); return; }
    const d = this.chart.getSymbol()?.pricePrecision ?? 2;
    const f = (v) => Number(v).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
    const prev = list[i - 1]?.close ?? b.open;
    const ch = b.close - prev;
    const cls = b.close >= b.open ? "up" : "down";
    const mk = (tag, text, c) => { const e = document.createElement(tag); e.textContent = text; if (c) e.className = c; return e; };
    const parts = [];
    for (const [k, v] of [["O", b.open], ["H", b.high], ["L", b.low], ["C", b.close]]) parts.push(mk("span", k, "k"), mk("b", f(v), cls));
    parts.push(mk("b", `${ch >= 0 ? "+" : ""}${f(ch)} (${ch >= 0 ? "+" : ""}${(prev ? (ch / prev) * 100 : 0).toFixed(2)}%)`, ch >= 0 ? "up" : "down"));
    if (b.volume != null) parts.push(mk("span", "Vol", "k"), mk("b", Number(b.volume).toLocaleString("en-US"), "v"));
    el.replaceChildren(...parts);
    // ย่อฟอนต์ให้พอดี: วัดใหม่เมื่อความยาวข้อความ/ความกว้างเปลี่ยน
    const key = `${el.textContent.length}|${el.clientWidth}`;
    if (this.ohlcFit?.key === key) { el.style.fontSize = `${this.ohlcFit.size}px`; return; }
    let size = 12;
    el.style.fontSize = `${size}px`;
    while (el.scrollWidth > el.clientWidth + 1 && size > 8) { size -= 0.5; el.style.fontSize = `${size}px`; }
    this.ohlcFit = { key, size };
  }

  // ---------- รายชื่ออินดิเคเตอร์ ----------
  paintLegend() {
    const prefs = typeof WT_INDICATORS === "undefined" ? {} : indPrefs();
    const rows = Object.values(typeof WT_INDICATORS === "undefined" ? {} : WT_INDICATORS).filter((d) => prefs[d.name]?.on)
      .map((d) => ({ key: d.name, title: d.title, hidden: !!prefs[d.name]?.hidden }));
    if (typeof basicLegendRows === "function") rows.push(...basicLegendRows());
    rows.push({ key: "__vol", title: "Volume", hidden: !store("wt.showVol", true) });
    const fold = !!store("wt.legendFold", false);
    const mk = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; };
    const L = this.legend;
    L.replaceChildren();
    L.classList.toggle("fold", fold);
    const tog = mk("button", { type: "button", className: "lg-fold", title: fold ? "แสดงรายชื่ออินดิเคเตอร์" : "ย่อเก็บ",
      textContent: fold ? `›  ${rows.length}` : "‹" });
    tog.onclick = () => { save("wt.legendFold", !fold); this.mgr.panels.forEach((p) => p.paintLegend()); };
    if (fold) { L.append(tog); return; }
    for (const r of rows) {
      const eye = mk("button", { type: "button", title: r.hidden ? "แสดง" : "ซ่อน", textContent: r.hidden ? "◌" : "👁" });
      const basic = r.key.startsWith("b:") ? r.key.slice(2) : null;
      eye.onclick = () => {
        if (r.key === "__vol") { save("wt.showVol", r.hidden); this.mgr.panels.forEach((p) => { p.applyVol(); p.paintLegend(); }); }
        else if (basic) setBasicPref(basic, { hidden: !r.hidden });
        else setIndPref(r.key, { hidden: !r.hidden });
      };
      const btns = [eye];
      if (r.key !== "__vol") {
        const gear = mk("button", { type: "button", title: "ตั้งค่า", textContent: "⚙" });
        gear.onclick = () => (basic ? openBasicSettings(basic) : openIndicatorSettings(r.key));
        const x = mk("button", { type: "button", title: "ลบออกจากกราฟ", textContent: "✕" });
        x.onclick = () => (basic ? setBasicPref(basic, { on: false }) : setIndPref(r.key, { on: false }));
        btns.push(gear, x);
      }
      L.append(mk("div", { className: "lg-row" + (r.hidden ? " off" : "") }, mk("span", { className: "lg-name", textContent: r.title }), mk("span", { className: "lg-btns" }, ...btns)));
    }
    L.append(tog);
  }

  // อินดิเคเตอร์จาก Pine (P4): วาดซ้อนบน candle pane ตาม prefs "wt.ind"
  applyIndicators() {
    if (typeof WT_INDICATORS === "undefined") return;
    const prefs = indPrefs();
    this.paintLegend();
    for (const name of Object.keys(WT_INDICATORS)) {
      this.chart.removeIndicator({ name: `wt_${name}` });
      if (prefs[name]?.on && !prefs[name]?.hidden) {
        this.chart.createIndicator({ name: `wt_${name}`, paneId: "candle_pane",
          extendData: { ...indConfig(name), __ctx: { acct: this.mgr.acct(), symbol: this.symbol, tf: this.tf } } }, true);
      }
    }
    if (typeof applyBasics === "function") applyBasics(this);
    if (typeof applyNewsLines === "function") applyNewsLines(this);
    if (typeof applyLevels === "function") applyLevels(this);
  }

  // กดที่ชิป TP/SL แล้วลาก = ตั้งระดับตามนิ้ว/เมาส์เลย (KLineChart ไม่ได้รับ event ระหว่างนี้)
  initChipPull() {
    let pull = null;
    const mainRect = () => this.chart.getDom("candle_pane", "main")?.getBoundingClientRect();
    const pt = (e) => (e.touches?.[0] || e.changedTouches?.[0] || e);
    const block = (e) => { if (pull) { e.stopPropagation(); if (e.cancelable) e.preventDefault(); } };
    const valueAt = (clientY) => {
      const r = mainRect();
      const res = this.chart.convertFromPixel([{ x: 10, y: clientY - r.top }], { paneId: "candle_pane" });
      return (Array.isArray(res) ? res[0] : res)?.value;
    };
    this.body.addEventListener("pointerdown", (e) => {
      if (this.measureDone) { this.measureDone = false; this.chart.removeOverlay({ groupId: "measure" }); }   // แตะหลังวัดเสร็จ = ลบไม้บรรทัด
      const r = mainRect();
      if (!r) return;
      const x = e.clientX - r.left, y = e.clientY - r.top;
      // Shift/Alt + คลิก (คอม) = ร่าง pending ที่ราคานั้น
      if ((e.shiftKey || e.altKey) && e.pointerType === "mouse" && y >= 0 && y <= r.height) {
        const v = valueAt(e.clientY);
        if (v != null && this.mgr.onModClick(this, v, e)) {
          e.stopPropagation();
          e.preventDefault();
          pull = { group: null, moved: true };
          return;
        }
      }
      if (this.picker) {
        const cb = this.picker;
        this.picker = null;
        this.body.classList.remove("picking");
        this.mgr.pickDone();
        e.stopPropagation();
        e.preventDefault();
        pull = { group: null, moved: true };   // บล็อก mouse/click ที่ตามมา ไม่ให้ KLineChart เลือก/ลากอะไร
        if (y >= 0 && y <= r.height) {
          const res = this.chart.convertFromPixel([{ x, y }], { paneId: "candle_pane" });
          const p0 = Array.isArray(res) ? res[0] : res;
          if (p0?.value != null) cb(p0.value, p0.timestamp);   // ราคา + เวลาของแท่งที่แตะ (Bar Replay ใช้เลือกจุดเริ่ม)
        }
        return;
      }
      // ชิปปุ่ม (✓ ส่ง / ✕ / BE / TP / SL) จับเองทั้งหมด — ไม่พึ่ง hit-test ของ KLineChart (เส้นอื่นที่ทับอยู่แย่งแตะได้)
      // ไล่จากชั้นบนสุด: ร่างออเดอร์ > ไม้จริง > alert ราคา; ชิปชื่อ/กำไร ปล่อยให้ KLineChart (ลากเส้นจากป้ายได้)
      const recs = [...this.lineMap].sort((a, b) => (LINE_Z[b[0].split(":")[0]] ?? 0) - (LINE_Z[a[0].split(":")[0]] ?? 0));
      for (const [k, rec] of recs) {
        const hit = (chipHits.get(rec.id) || []).find((h) => ACTION_CHIPS.has(h.key) &&
          x >= h.x && x <= h.x + h.w && y >= h.y && y <= h.y + h.h);
        if (hit) {
          pull = { group: k.split(":")[0], line: rec.line, key: hit.key, y0: e.clientY, moved: false };
          this.mgr.overlayHitAt = Date.now();
          e.stopPropagation();
          e.preventDefault();
          return;
        }
      }
    }, { capture: true });
    for (const t of ["mousedown", "touchstart", "mouseup", "click"]) this.body.addEventListener(t, block, { capture: true, passive: false });
    // แตะพื้นกราฟเฉยๆ = ยกเลิกร่างออเดอร์ (ไม่นับ: ลากเลื่อนกราฟ, โดนเส้น/ชิป/รูปวาด, กำลังวาด)
    let tap = null;
    this.body.addEventListener("pointerdown", (e) => { tap = pull ? null : { x: e.clientX, y: e.clientY, t: Date.now() }; }, { capture: true });
    this.body.addEventListener("pointerup", (e) => {
      const t0 = tap;
      tap = null;
      if (!t0 || pull || Math.hypot(e.clientX - t0.x, e.clientY - t0.y) > 6 || Date.now() - t0.t > 500) return;
      if (e.target.closest("button, .ind-legend, .drill-menu")) return;
      // แตะสองครั้งที่แท่ง (คอม: ดับเบิลคลิก) = เมนูซูมลง TF เล็ก
      const prev = this.lastTap;
      this.lastTap = { x: e.clientX, y: e.clientY, t: Date.now() };
      if (prev && Date.now() - prev.t < 350 && Math.hypot(e.clientX - prev.x, e.clientY - prev.y) < 30 && !this.replay) {
        this.lastTap = null;
        const r = mainRect();
        if (r && e.clientY >= r.top && e.clientY <= r.bottom && !this.chart.getOverlays({ groupId: "user" }).some((o) => o.currentStep !== -1)) {
          const res = this.chart.convertFromPixel([{ x: e.clientX - r.left, y: e.clientY - r.top }], { paneId: "candle_pane" });
          const idx = (Array.isArray(res) ? res[0] : res)?.dataIndex;
          const bar = Number.isInteger(idx) ? this.chart.getDataList()[idx] : null;
          if (bar) { this.openDrillMenu(bar.timestamp, e.clientX, e.clientY); return; }
        }
      }
      setTimeout(() => {
        if (Date.now() - (this.mgr.overlayHitAt || 0) < 700) return;
        if (this.chart.getOverlays({ groupId: "user" }).some((o) => o.currentStep !== -1)) return;   // กำลังวาด
        this.mgr.chartTapped(this);
      }, 80);
    });
    const move = (e) => {
      if (!pull) return;
      const cy = pt(e).clientY;
      if (pull.key !== "tp" && pull.key !== "sl") return;   // ลากได้เฉพาะชิป TP/SL
      if (!pull.moved && Math.abs(cy - pull.y0) < 4) return;
      pull.moved = true;
      if (e.cancelable) e.preventDefault();
      const v = valueAt(cy);
      if (v != null) this.mgr.linePulled(pull.group, pull.line, pull.key, v);
    };
    const up = () => {
      if (!pull) return;
      const p = pull;
      setTimeout(() => { pull = null; }, 0);   // ปล่อย mouseup/click ที่ตามมาถูกบล็อกก่อน
      if (!p.moved) this.mgr.lineClicked(p.group, p.line, p.key);
    };
    window.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("touchmove", move, { passive: false });
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  }

  pick(cb) {
    this.picker = cb;
    this.body.classList.toggle("picking", !!cb);
  }

  // ---------- โซน R:R ----------
  setZone(z) {
    this.zoneWant = z;
    const last = this.chart.getDataList().at(-1);
    if (!z || !last) {
      if (this.zoneId) { this.chart.removeOverlay({ id: this.zoneId }); this.zoneId = null; }
      return;
    }
    const pts = [{ timestamp: last.timestamp, value: z.entry }];
    if (this.zoneId && this.chart.getOverlays({ id: this.zoneId }).length) {
      this.chart.overrideOverlay({ id: this.zoneId, extendData: { ...z }, points: pts });
    } else {
      this.zoneId = this.chart.createOverlay({ name: "rrZone", groupId: "rr", lock: true, extendData: { ...z }, points: pts, zLevel: -1 });
    }
  }

  // ---------- ไม้ในอดีต ----------
  setHist(items) {
    if (this.replay?.blind) items = [];   // replay แบบซ่อนวันที่: ไม่โชว์ไม้จริง (บอกช่วงเวลาได้)
    this.histWant = items;
    for (const id of this.histIds) this.chart.removeOverlay({ id });
    this.histIds = [];
    if (!this.chart.getDataList().length) return;
    for (const t of items) {
      const id = this.chart.createOverlay({ name: "histTrade", groupId: "hist", lock: true, extendData: t.ext,
        points: [{ timestamp: t.t0, value: t.p0 }, { timestamp: t.t1, value: t.p1 }] });
      if (id) this.histIds.push(id);
    }
  }

  // ช่วงราคาที่มองเห็นอยู่ (ใช้วางระยะ TP/SL เริ่มต้นให้อยู่ในจอ)
  visibleSpan() {
    const { from, to } = this.chart.getVisibleRange();
    const bars = this.chart.getDataList().slice(Math.max(0, from), to);
    if (!bars.length) return 0;
    return Math.max(...bars.map((b) => b.high)) - Math.min(...bars.map((b) => b.low));
  }

  dispose() {
    if (this.replay && typeof replayStop === "function") replayStop({ reload: false, silent: true });
    clearInterval(this.crossTimer);
    clearTimeout(this.saveTimer);
    klinecharts.dispose(this.body);
    this.el.remove();
  }

  // ---------- data ----------
  async getBars({ type, timestamp, symbol, period, callback }) {
    if (this.replay) { replayGetBars(this, type, callback); return; }   // Bar Replay: แท่งจากชุดที่ดึงไว้ ถึงตำแหน่งที่เล่น
    if (this.anchor && type !== "forward") { this.getBarsAnchored(type, symbol, callback); return; }   // ซูมจากแท่ง: โหลดรอบเวลานั้น
    if (type === "backward") { callback([], { backward: false, forward: true }); return; }
    if (type !== "forward") this.held = null;   // โหลดใหม่ทั้งชุด -> แท่งที่พักไว้ล้าสมัย
    const tf = this.tf;
    const params = new URLSearchParams({ symbol: symbol.ticker, tf, count: PAGE });
    if (type === "forward" && timestamp) params.set("to", Math.floor(timestamp / 1000) - 1);
    // เคยเปิด symbol|TF นี้ไม่นาน: ดึงแค่แท่งที่เกิดใหม่ตั้งแต่ครั้งก่อน (+3 เผื่อแท่งที่ยังวิ่ง) แล้วต่อกับชุดเดิม — สลับไปมาไม่ต้องโหลด 1000 แท่งใหม่
    const ckey = `${this.mgr.acct()}|${symbol.ticker}|${tf}`;
    const cached = type === "init" ? BAR_CACHE.get(ckey) : null;
    const want = cached ? Math.ceil((Date.now() - cached.at) / (TF_MS[tf] || 60e3)) + 3 : 0;
    const partial = cached && Date.now() - cached.at < BAR_CACHE_TTL && want < PAGE / 2;
    if (partial) params.set("count", want);
    const fetchedAt = Date.now();
    // แท่งที่จำไว้ขาดไม่เกินไม่กี่แท่ง: วาดทันทีไม่รอเน็ต แล้วเติมแท่งล่าสุดตามหลัง (applyBars ต่อได้ <= 3 แท่ง)
    if (partial && want <= 5 && cached.bars.length) {
      callback(cached.bars.map((b) => ({ ...b })), { forward: cached.more, backward: false });
      setTimeout(() => { this.restoreZoom(); this.reapplyLines(); this.setZone(this.zoneWant); this.setHist(this.histWant); this.paintOhlc(); }, 0);
      try {
        const r = await api(`/api/a/${encodeURIComponent(this.mgr.acct())}/rates?${params}`);
        if (!r.ok || this.chart.getSymbol()?.ticker !== symbol.ticker || this.tf !== tf || this.replay || this.anchor) return;
        const rows = await r.json();
        if (!rows.length || !this.barCb) return;
        this.applyBars(rows);
        BAR_CACHE.delete(ckey);
        BAR_CACHE.set(ckey, { bars: this.chart.getDataList().slice(-PAGE).map((b) => ({ ...b })), more: cached.more, at: fetchedAt });
      } catch (_) { /* เน็ตหลุด: แท่งสดจาก websocket เติมให้เอง */ }
      return;
    }
    try {
      const r = await api(`/api/a/${encodeURIComponent(this.mgr.acct())}/rates?${params}`);
      const stale = () => this.chart.getSymbol()?.ticker !== symbol.ticker || this.tf !== tf || !!this.replay;   // เข้า replay ระหว่างรอ = ทิ้ง
      if (stale()) return;              // เปลี่ยน symbol/TF ระหว่างรอ — ทิ้ง
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        this.msg.textContent = j.detail || `โหลดแท่งไม่ได้ (${r.status})`;
        callback([], false);
        return;
      }
      const rows = await r.json();
      this.msg.textContent = "";
      let bars = rows.map(toBar);
      let more = rows.length >= PAGE;
      if (type === "init") {
        // ต่อได้เฉพาะเมื่อชุดใหม่ซ้อนกับชุดเดิม (ไม่มีช่องว่าง) ไม่งั้นโหลดเต็มใหม่
        if (partial && bars.length && cached.bars.length && bars[0].timestamp <= cached.bars.at(-1).timestamp) {
          bars = cached.bars.filter((b) => b.timestamp < bars[0].timestamp).concat(bars).slice(-PAGE);
          more = cached.more;
        } else if (partial) {
          BAR_CACHE.delete(ckey);
          return this.getBars({ type, timestamp, symbol, period, callback });
        }
        BAR_CACHE.delete(ckey);
        // เก็บสำเนา (KLineChart อาจแก้ array/แท่งที่ส่งให้) และไม่เก็บชุดว่าง
        if (bars.length) BAR_CACHE.set(ckey, { bars: bars.map((b) => ({ ...b })), more, at: fetchedAt });
        while (BAR_CACHE.size > BAR_CACHE_MAX) BAR_CACHE.delete(BAR_CACHE.keys().next().value);
      }
      if (type === "init") setTimeout(() => { this.restoreZoom(); this.reapplyLines(); this.setZone(this.zoneWant); this.setHist(this.histWant); this.paintOhlc(); this.prefetchTfs(); }, 0);
      if (type === "forward") {
        const first = this.chart.getDataList()[0];
        const older = first ? bars.filter((b) => b.timestamp < first.timestamp) : bars;
        callback(older, { forward: rows.length >= PAGE && older.length > 0, backward: false });
      } else {
        callback(bars, { forward: more, backward: false });
      }
    } catch (_) {
      this.msg.textContent = "เชื่อมต่อไม่ได้";
      callback([], false);
    }
  }

  // ---------- ซูมจากแท่ง (แตะสองครั้งที่แท่ง -> เลือก TF เล็ก) ----------
  // anchor = { t, span } ms: กราฟโหลดรอบเวลา t แทนแท่งล่าสุด, เลื่อนขวาโหลดแท่งใหม่กว่าต่อ, ถึงปัจจุบัน = กลับเป็นกราฟสด
  async getBarsAnchored(type, symbol, callback) {
    const tf = this.tf, a = this.anchor, ms = TF_MS[tf] || 60e3;
    const acct = encodeURIComponent(this.mgr.acct());
    const stale = () => this.chart.getSymbol()?.ticker !== symbol.ticker || this.tf !== tf || this.anchor !== a || !!this.replay;
    const isLive = (bars) => !bars.length || Date.now() - bars.at(-1).timestamp < 3 * ms;
    try {
      if (type === "init") {
        const to = Math.floor((a.t + a.span + 300 * ms) / 1000);
        const r = await api(`/api/a/${acct}/rates?${new URLSearchParams({ symbol: symbol.ticker, tf, count: PAGE, to })}`);
        if (stale()) return;
        if (!r.ok) { const j = await r.json().catch(() => ({})); this.msg.textContent = j.detail || `โหลดแท่งไม่ได้ (${r.status})`; callback([], false); return; }
        const rows = await r.json();
        const bars = rows.map(toBar);
        if (!bars.length || bars.at(-1).timestamp < a.t) this.msg.textContent = `MT5 ไม่มีแท่ง ${tf} ช่วงนี้`;
        else this.msg.textContent = "";
        const live = isLive(bars);
        if (live) this.anchor = null;
        callback(bars, { forward: rows.length >= PAGE, backward: !live });
        setTimeout(() => {
          this.restoreZoom(); this.reapplyLines(); this.setZone(this.zoneWant); this.setHist(this.histWant); this.paintOhlc();
          this.showDrill(a);
          const vr = this.chart.getVisibleRange();   // scrollToTimestamp วางเวลาไว้ขอบขวา -> เลื่อนครึ่งจอให้แท่งเดิมอยู่กลาง
          this.chart.scrollToTimestamp(a.t + a.span / 2 + Math.max(0, (vr.to - vr.from) / 2) * ms, 0);
          this.paintRt();
        }, 0);
        return;
      }
      // backward = แท่งใหม่กว่าที่มีอยู่ (ข้ามช่วงตลาดปิดได้สูงสุด 6 ช่วง)
      const last = this.chart.getDataList().at(-1);
      if (!last) { callback([], { backward: false, forward: true }); return; }
      let frm = Math.floor(last.timestamp / 1000) + 1, bars = [];
      for (let i = 0; i < 6 && !bars.length && frm * 1000 < Date.now(); i++) {
        const to = frm + Math.floor((PAGE * ms) / 1000);
        const r = await api(`/api/a/${acct}/rates_range?${new URLSearchParams({ symbol: symbol.ticker, tf, frm, to })}`);
        if (stale()) return;
        if (!r.ok) break;
        bars = (await r.json()).map(toBar).filter((b) => b.timestamp > last.timestamp);
        frm = to + 1;
      }
      const live = !bars.length || isLive(bars);   // ไม่มีแท่งใหม่กว่านี้แล้ว (หรือถึงปัจจุบัน) = กลับเป็นกราฟสด
      if (live) this.anchor = null;
      callback(bars, { backward: !live, forward: true });
      this.paintRt();
    } catch (_) {
      this.msg.textContent = "เชื่อมต่อไม่ได้";
      callback([], false);
    }
  }

  drill(tf, t, span) {
    if (this.replay) return;
    this.anchor = { t, span };
    this.clearDrill();
    if (tf === this.tf) { this.chart.resetData(); return; }
    this.tf = tf;
    this.paintTf();
    this.mgr.saveLayout();
    this.chart.setPeriod(TF_PERIOD[tf]);
    this.applyIndicators();
    this.mgr.panelChanged(this);
  }

  exitAnchor() {
    this.anchor = null;
    this.clearDrill();
    this.chart.resetData();   // โหลดชุดล่าสุดใหม่
  }

  showDrill(a) {
    this.clearDrill();
    const ms = TF_MS[this.tf] || 60e3;
    this.chart.createOverlay({ name: "drillZone", groupId: "drill", lock: true, zLevel: -1,
      points: [{ timestamp: a.t, value: 0 }, { timestamp: a.t + Math.max(a.span - ms, 0), value: 0 }] });
  }

  clearDrill() { this.chart?.removeOverlay({ groupId: "drill" }); }

  openDrillMenu(ts, cx, cy) {
    this.closeDrillMenu();
    const lower = TFS.slice(0, TFS.indexOf(this.tf)).filter((tf) => TF_MS[tf]);
    if (!lower.length) return;
    const span = this.tf === "MN1" ? (() => { const d = new Date(ts); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) - ts; })()
      : (TF_MS[this.tf] || 60e3);
    const menu = document.createElement("div");
    menu.className = "drill-menu";
    const title = document.createElement("div");
    title.className = "drill-title";
    title.textContent = `ซูมแท่ง ${this.tf} ${new Date(ts).toLocaleString("en-GB", { timeZone: this.mgr.timezone, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}`;
    menu.append(title);
    for (const tf of lower.slice(-4).reverse()) {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = tf;
      b.addEventListener("click", (e) => { e.stopPropagation(); this.closeDrillMenu(); this.drill(tf, ts, span); });
      menu.append(b);
    }
    for (const t of ["pointerdown", "mousedown", "touchstart", "mouseup", "touchend", "click"]) menu.addEventListener(t, (e) => e.stopPropagation(), { passive: true });
    const r = this.body.getBoundingClientRect();
    menu.style.left = `${Math.min(Math.max(cx - r.left - 60, 4), r.width - 140)}px`;
    menu.style.top = `${Math.min(Math.max(cy - r.top - 20, 4), r.height - 60)}px`;
    this.body.append(menu);
    this.drillMenu = menu;
    this.drillAway = (e) => { if (!menu.contains(e.target)) this.closeDrillMenu(); };
    setTimeout(() => document.addEventListener("pointerdown", this.drillAway, true), 0);
  }

  closeDrillMenu() {
    if (this.drillAway) document.removeEventListener("pointerdown", this.drillAway, true);
    this.drillAway = null;
    this.drillMenu?.remove();
    this.drillMenu = null;
  }

  onBars(m) {
    if (this.replay || this.anchor) return;   // Bar Replay / ดูแท่งเก่าจากการซูม: ไม่รับแท่งสด
    if (!this.barCb || m.symbol !== this.symbol || m.tf !== this.tf) return;
    // แท็บ/กราฟถูกซ่อน: เก็บแท่งไว้ (ทับตาม timestamp) ไม่คำนวณ/วาด -> กลับมาเห็นเมื่อไหร่ใส่ครบทุกแท่งทันที
    if (this.isHidden()) {
      this.held ||= new Map();
      for (const row of m.bars) this.held.set(row[0], row);
      return;
    }
    this.applyBars(m.bars);
  }

  // จำระยะซูม (ความกว้างแท่ง) ต่อกราฟ ต่อเครื่อง: เปลี่ยน TF/symbol หรือเปิดใหม่ ใช้ค่าเดิม
  saveZoom() {
    const sp = this.chart.getBarSpace();
    const bar = typeof sp === "number" ? sp : sp?.bar;
    if (!(bar > 0)) return;
    clearTimeout(this.zoomSaveT);
    this.zoomSaveT = setTimeout(() => { const z = store("wt.zoom", {}); z[this.idx] = +bar.toFixed(2); save("wt.zoom", z); }, 400);
  }

  restoreZoom() {
    const bar = store("wt.zoom", {})[this.idx];
    if (bar > 0) this.chart.setBarSpace(bar);
  }

  isHidden() { return document.hidden || !this.el.getClientRects().length; }

  gapReload() {
    const now = Date.now();
    if (now - (this.gapAt || 0) < 15000) return;   // ไม่วนโหลด (เช่น ช่วงตลาดปิดสุดสัปดาห์ที่ช่องว่างเป็นของจริง)
    this.gapAt = now;
    BAR_CACHE.delete(`${this.mgr.acct()}|${this.symbol}|${this.tf}`);
    this.chart.resetData();
  }

  // ดึง TF อื่นของ symbol นี้เก็บไว้ล่วงหน้า (ทีละ TF ตอนว่าง) -> กดเปลี่ยน TF ครั้งแรกก็ไม่ต้องรอโหลด 1000 แท่ง
  prefetchTfs() {
    const sym = this.symbol, acct = this.mgr.acct();
    if (this.prefetched === `${acct}|${sym}`) return;
    this.prefetched = `${acct}|${sym}`;
    setTimeout(async () => {
      for (const tf of PREFETCH_TFS) {
        const k = `${acct}|${sym}|${tf}`;
        if (this.symbol !== sym || this.replay || document.hidden) { this.prefetched = null; return; }
        if (tf === this.tf || BAR_CACHE.has(k)) continue;
        try {
          const r = await api(`/api/a/${encodeURIComponent(acct)}/rates?${new URLSearchParams({ symbol: sym, tf, count: PAGE })}`);
          const rows = r.ok ? await r.json() : [];
          if (rows.length && !BAR_CACHE.has(k)) BAR_CACHE.set(k, { bars: rows.map(toBar), more: rows.length >= PAGE, at: Date.now() });
          while (BAR_CACHE.size > BAR_CACHE_MAX) BAR_CACHE.delete(BAR_CACHE.keys().next().value);
        } catch (_) { /* ไว้โหลดตอนกดจริง */ }
        await new Promise((res) => setTimeout(res, 250));
      }
    }, 2500);
  }

  flushHeld() {
    if (!this.held || this.isHidden()) return;
    const rows = [...this.held.values()].sort((a, b) => a[0] - b[0]);
    this.held = null;
    if (this.barCb && !this.replay) this.applyBars(rows);
  }

  applyBars(rows) {
    // worker ส่ง 2 แท่ง (ปิดแล้ว + ปัจจุบัน) — แท่งที่เหมือนในกราฟอยู่แล้วไม่ต้องส่ง (ทุกครั้งที่ส่ง KLineChart คำนวณอินดิเคเตอร์ใหม่ทั้งหมด)
    const list = this.chart.getDataList();
    const minTs = list.length > 1 ? list[list.length - 2].timestamp : 0;   // แก้ได้แค่แท่งก่อนสุดท้ายขึ้นไป
    const last = list.at(-1);
    for (const row of rows) {
      const b = toBar(row);
      if (b.timestamp < minTs) continue;
      // แท่งสดห่างจากแท่งล่าสุดในกราฟเกิน 3 แท่ง = ชุดที่โหลดมาไม่ครบ (MT5 ยังโหลดประวัติคู่นี้ไม่เสร็จ) -> โหลดใหม่เอง
      if (last && b.timestamp - last.timestamp > 3 * (TF_MS[this.tf] || 60e3) && TF_MS[this.tf] && this.tf !== "W1") {
        this.gapReload();
        return;
      }
      const ex = list.findLast?.((x) => x.timestamp === b.timestamp);
      if (ex && ex.open === b.open && ex.high === b.high && ex.low === b.low && ex.close === b.close && ex.volume === b.volume) continue;
      this.barCb(b);
    }
    this.paintRt();
    this.paintCdSoon();
    if (this.hoverIdx == null) this.paintOhlcSoon();
  }

  paintRt() {
    const n = this.chart.getDataList().length;
    const vr = this.chart.getVisibleRange();
    this.rtBtn.hidden = !this.anchor && (!n || vr.realTo >= n);   // realTo = index ถัดจากแท่งขวาสุดที่เห็น; ดูแท่งเก่าจากการซูม = โชว์เสมอ
  }

  // ---------- symbol / TF ----------
  applySymbol() {
    if (this.replay && typeof replayStop === "function") replayStop({ reload: false });   // เปลี่ยน symbol/TF ระหว่าง replay = จบ replay
    const digits = this.mgr.digits(this.symbol);
    this.anchor = null;
    this.clearDrill();
    if (this.mgr.drawing?.panel === this) this.mgr.drawEnded();   // เปลี่ยน symbol/TF = เส้นที่วาดค้างหายไปด้วย
    if (this.mgr.selectedOverlay?.panel === this) this.mgr.setSelected(null);   // เส้นของ symbol เดิมหายไป -> ซ่อนแถบลอย
    this.clearLines();
    this.setZone(null);
    this.setHist([]);
    this.symInput.value = this.symbol;
    this.chart.setPeriod(TF_PERIOD[this.tf]);
    this.chart.setSymbol({ ticker: this.symbol, pricePrecision: digits, volumePrecision: 0 });
    this.loadDrawings();
    this.applyIndicators();
  }

  setSymbol(sym) {
    if (!sym || sym === this.symbol) { this.symInput.value = this.symbol; return; }
    this.symbol = sym;
    this.mgr.saveLayout();
    this.applySymbol();
    this.mgr.panelChanged(this);
    this.mgr.syncSymbol(this, sym);
  }

  setTf(tf) {
    if (this.replay && typeof replaySetTf === "function") { replaySetTf(this, tf); return; }   // replay: สลับ TF ได้ (>= TF ฐาน)
    this.clearDrill();
    if (this.anchor) { this.anchor = null; if (tf === this.tf) { this.chart.resetData(); return; } }   // กด TF เอง = กลับกราฟสด
    if (tf === this.tf) return;
    this.tf = tf;
    this.paintTf();
    this.mgr.saveLayout();
    this.chart.setPeriod(TF_PERIOD[tf]);
    this.applyIndicators();
    this.mgr.panelChanged(this);
  }

  paintTf() {
    for (const [tf, b] of Object.entries(this.tfBtns)) b.classList.toggle("on", tf === this.tf);
  }

  refreshPrecision() {
    const d = this.mgr.digits(this.symbol);
    if (this.chart.getSymbol()?.pricePrecision !== d) {
      this.chart.setSymbol({ ticker: this.symbol, pricePrecision: d, volumePrecision: 0 });
    }
  }

  // ---------- เส้นเทรด ----------
  clearLines() {
    for (const rec of this.lineMap.values()) this.chart.removeOverlay({ id: rec.id });
    this.lineMap.clear();
  }

  reapplyLines() {
    for (const [group, lines] of Object.entries(this.lineWant)) this.setLines(group, lines);
  }

  setLines(group, lines) {
    this.lineWant[group] = lines;
    this.paintLineTagsSoon();   // ป้ายราคาบนแกน (วาดหลังสร้าง/ย้ายเส้นเสร็จ)
    const last = this.chart.getDataList().at(-1);
    if (!last) return;
    const want = new Map(lines.map((l) => [`${group}:${l.key}`, l]));
    for (const [k, rec] of this.lineMap) {
      if (k.startsWith(group + ":") && !want.has(k) && !rec.dragging) {
        this.chart.removeOverlay({ id: rec.id });
        this.lineMap.delete(k);
      }
    }
    for (const [k, l] of want) {
      // passive = เส้นดูอย่างเดียว (Ask) — ไม่รับแตะ ไม่บังปุ่มของเส้นอื่น
      const ext = { color: l.color, dashed: !!l.dashed, chips: l.chips || [], passive: !!l.locked && !(l.chips || []).length };
      let rec = this.lineMap.get(k);
      // KLineChart merge extendData แบบรวม array ทีละช่อง -> ชุด chip เปลี่ยนโครง (เพิ่ม/ลดปุ่ม) ต้องสร้างเส้นใหม่
      const shape = (c) => (c || []).map((x) => x.key).join(",");
      if (rec && !rec.dragging && (shape(rec.line.chips) !== shape(l.chips) || !!rec.line.locked !== !!l.locked)) {
        this.chart.removeOverlay({ id: rec.id });
        this.lineMap.delete(k);
        rec = null;
      }
      if (!rec) {
        const r = { id: null, line: l, dragging: false };
        r.id = this.chart.createOverlay({
          name: "tradeLine", groupId: group, lock: !!l.locked, extendData: ext, zLevel: LINE_Z[group] ?? 300,
          styles: { text: { backgroundColor: l.color, borderColor: l.color, color: "#fff" } },   // ป้ายราคาบนแกน Y สีเดียวกับเส้น
          points: [{ timestamp: last.timestamp, value: l.value }],
          onClick: (e) => { this.mgr.overlayHitAt = Date.now(); this.mgr.lineClicked(group, r.line, (e.figure?.key || "").replace("chip:", "")); },
          onPressedMoveStart: () => { this.mgr.overlayHitAt = Date.now(); r.dragging = true; },
          onPressedMoving: (e) => {
            this.paintLineTagsSoon();
            // ลาก TP/SL: คำนวณกำไร/ขาดทุนบนชิป + โซน R:R ตามตำแหน่งสดๆ (ชิปเปลี่ยนแค่ข้อความ โครงเดิม)
            const v = e?.overlay?.points?.[0]?.value;
            const chips = v != null ? this.mgr.lineMoving(group, r.line, v) : null;
            if (chips) this.chart.overrideOverlay({ id: r.id, extendData: { color: r.line.color, dashed: !!r.line.dashed, chips, passive: false } });
            return false;
          },
          onPressedMoveEnd: (e) => {
            const v = e.overlay.points[0]?.value;
            // กดแล้วปล่อยโดยไม่ลาก = คลิก (onClick จัดการ) ไม่ใช่การย้ายเส้น
            if (v != null && Math.abs(v - r.line.value) <= Math.abs(r.line.value) * 1e-9) { r.dragging = false; return; }
            const revert = () => {
              r.dragging = false;
              r.stale = true;
              this.reapplyLines();   // กลับไปที่ค่าล่าสุดจาก MT5 (ถ้าเส้นหายไประหว่างรอ ก็ถูกลบที่นี่)
            };
            if (v == null) { revert(); return; }
            // settle: คำสั่งผ่าน — ให้ sync รอบหน้า snap เส้นไปที่ค่าจริงจาก MT5
            this.mgr.lineDragged(group, r.line, v, revert, () => { r.dragging = false; r.stale = true; this.reapplyLines(); });
          },
        });
        this.lineMap.set(k, r);
      } else if (rec.dragging) {
        // กำลังลาก/รอยืนยัน — ห้ามแตะ (rec.line = ค่าเดิมไว้ revert)
      } else if (rec.stale || rec.line.value !== l.value || JSON.stringify(rec.line.chips) !== JSON.stringify(l.chips)
                 || rec.line.color !== l.color) {
        const recolor = rec.line.color !== l.color ? { styles: { text: { backgroundColor: l.color, borderColor: l.color, color: "#fff" } } } : {};
        this.chart.overrideOverlay({ id: rec.id, extendData: ext, points: [{ timestamp: last.timestamp, value: l.value }], ...recolor });
        rec.line = l;
        rec.stale = false;
      }
    }
  }

  // เลื่อนเส้นชั่วคราว (เช่น SL/TP ตามราคาเข้าที่กำลังลาก) — rec.line คงค่าเดิม, stale = รอบ sync หน้ากลับไปค่าที่ต้องการ
  moveLineTo(group, key, value) {
    const rec = this.lineMap.get(`${group}:${key}`), last = this.chart.getDataList().at(-1);
    if (!rec || rec.dragging || !last || value == null) return;
    this.chart.overrideOverlay({ id: rec.id, points: [{ timestamp: last.timestamp, value }] });
    rec.stale = true;
    this.paintLineTagsSoon();
  }

  // ---------- drawings ----------
  overlayEvents() {
    const save = () => this.scheduleSave();
    const end = () => { this.hideDragCross(); save(); };
    return {
      onDrawing: (e) => this.paintDragCross(e),
      onPressedMoving: (e) => this.paintDragCross(e),
      onDrawEnd: end,
      onPressedMoveEnd: end,
      onRemoved: save,
      onRightClick: (e) => { this.chart.removeOverlay({ id: e.overlay.id }); return true; },
      onDoubleClick: (e) => { this.mgr.setSelected({ panel: this, id: e.overlay.id }); openDrawingSettings(this, e.overlay.id); },
      onSelected: (e) => { this.mgr.overlayHitAt = Date.now(); this.mgr.setSelected({ panel: this, id: e.overlay.id }); },
      onClick: () => { this.mgr.overlayHitAt = Date.now(); },
      onDeselected: (e) => { if (this.mgr.selectedOverlay?.id === e.overlay.id) this.mgr.setSelected(null); },
    };
  }

  // คืน id ของเส้นที่เริ่มวาด (null = ไม่ได้เริ่ม) — วาดเสร็จแจ้ง mgr.drawEnded ให้ปุ่มเครื่องมือเลิกสถานะ "กดอยู่"
  startDrawing(name) {
    if (name === "measure") {   // ไม้บรรทัด: ชั่วคราว (group แยก ไม่บันทึก) — แตะกราฟหลังวัดเสร็จ = ลบ
      this.chart.removeOverlay({ groupId: "measure" });
      this.measureDone = false;
      const id = this.chart.createOverlay({ name: "measure", groupId: "measure", lock: true,
        onDrawEnd: () => { this.mgr.drawEnded(id); setTimeout(() => { this.measureDone = true; }, 0); return false; } });
      return id;
    }
    const o = { name, groupId: "user", ...this.overlayEvents() };
    const save = o.onDrawEnd;
    o.onDrawEnd = (e) => { this.mgr.drawEnded(e?.overlay?.id); return save(e); };
    if (name === "fibRetracement") o.extendData = fibDefault();
    if (name === "textLabel") {
      const text = prompt("ข้อความ");
      if (!text) return null;
      o.extendData = text.slice(0, 200);
    }
    return this.chart.createOverlay(o);
  }

  // ยกเลิกเส้นที่ยังวาดไม่เสร็จ (กดปุ่มเครื่องมือซ้ำ / Esc)
  cancelDrawing() {
    for (const g of ["user", "measure"]) {
      for (const o of this.chart.getOverlays({ groupId: g })) if (o.currentStep !== -1) this.chart.removeOverlay({ id: o.id });
    }
  }

  userOverlays() {
    // currentStep -1 = วาดเสร็จแล้ว; ตัวที่กำลังวาดค้างไม่บันทึก
    return this.chart.getOverlays({ groupId: "user" }).filter((o) => o.currentStep === -1 && o.points.length);
  }

  scheduleSave() {
    if (this.loadingDrawings) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.saveDrawings(), 400);
  }

  serializeDrawings() {
    return this.userOverlays().map((o) => ({
      name: o.name,
      points: o.points.filter((p) => p.timestamp != null && p.value != null)
        .map((p) => ({ timestamp: p.timestamp, value: p.value })),
      extendData: typeof o.extendData === "string" || (o.extendData && typeof o.extendData === "object") ? o.extendData : undefined,
      styles: o.name === "fibRetracement" ? undefined : pickStyles(o.styles),
      lock: o.lock,
      visible: o.visible,
    }));
  }

  async saveDrawings() {
    const overlays = this.serializeDrawings();
    this.mgr.history(this.symbol).record(overlays);
    await this.putDrawings(this.symbol, overlays);
    if (typeof syncDrawingAlerts === "function") syncDrawingAlerts(this.symbol, overlays);
  }

  // ผูก alert กับเส้น: เก็บ id ไว้ใน extendData ของเส้น (บันทึกไปกับเส้น)
  linkDrawingAlert(overlayId, alertId) {
    const o = this.chart.getOverlays({ id: overlayId })[0];
    if (!o) return;
    const ext = o.extendData && typeof o.extendData === "object" ? { ...o.extendData, alertId } : { alertId };
    this.chart.overrideOverlay({ id: overlayId, extendData: ext });
    this.saveDrawings();
  }

  async putDrawings(sym, overlays) {
    const r = await api(`/api/drawings/${encodeURIComponent(sym)}`, { method: "PUT", body: JSON.stringify({ overlays }) });
    if (!r.ok) { this.msg.textContent = "บันทึกเส้นไม่สำเร็จ"; return; }
    this.mgr.drawingsChanged(this, sym);
    this.mgr.paintHistoryButtons();
  }

  applyDrawings(overlays) {
    this.loadingDrawings = true;
    try {
      this.chart.removeOverlay({ groupId: "user" });
      for (const o of overlays) this.chart.createOverlay({ ...o, groupId: "user", ...this.overlayEvents() });
    } finally {
      this.loadingDrawings = false;
    }
  }

  // แทนที่เส้นด้วยค่าใหม่ (สร้างใหม่ เพราะ KLineChart merge array ใน extendData ทีละช่อง) แล้วบันทึก
  replaceDrawing(id, patch) {
    const o = this.chart.getOverlays({ id })[0];
    if (!o) return;
    const base = {
      name: o.name, groupId: "user", lock: o.lock, visible: o.visible,
      points: o.points.map((p) => ({ timestamp: p.timestamp, value: p.value })),
      extendData: o.extendData, styles: pickStyles(o.styles),
    };
    this.loadingDrawings = true;
    this.chart.removeOverlay({ id });
    this.loadingDrawings = false;
    this.chart.createOverlay({ ...base, ...patch, ...this.overlayEvents() });
    this.mgr.setSelected(null);
    this.saveDrawings();
  }

  // ย้อนกลับ / ไปข้างหน้า (สถานะเส้นทั้งหมดของ symbol นี้)
  async undoRedo(dir) {
    const snap = this.mgr.history(this.symbol)[dir]();
    if (!snap) return;
    this.applyDrawings(snap);
    this.mgr.setSelected(null);
    await this.putDrawings(this.symbol, snap);
    if (typeof syncDrawingAlerts === "function") syncDrawingAlerts(this.symbol, snap);
  }

  async loadDrawings() {
    const sym = this.symbol;
    this.loadingDrawings = true;
    try {
      const r = await api(`/api/drawings/${encodeURIComponent(sym)}`);
      if (!r.ok || sym !== this.symbol) return;
      const { overlays } = await r.json();
      this.mgr.history(sym).baseline(overlays);
      this.chart.removeOverlay({ groupId: "user" });
      for (const o of overlays) {
        this.chart.createOverlay({ ...o, groupId: "user", ...this.overlayEvents() });
      }
      this.mgr.paintHistoryButtons();
    } finally {
      this.loadingDrawings = false;
    }
  }

  clearDrawings() {
    this.loadingDrawings = true;
    this.chart.removeOverlay({ groupId: "user" });
    this.loadingDrawings = false;
    this.saveDrawings();
  }
}

// เก็บเฉพาะสไตล์ที่ผู้ใช้ตั้ง (สี/หนา/เส้นประ) — ไม่เก็บ default ทั้งก้อนของ KLineChart
function pickStyles(st) {
  const l = st?.line;
  if (!l || (!l.color && !l.size && !l.style)) return undefined;
  return { line: { color: l.color, size: l.size, style: l.style, dashedValue: l.style === "dashed" ? [6, 4] : undefined } };
}

// เวลาปิดแท่ง (ms): เดือน = ต้นเดือนถัดไป, ที่เหลือ = เวลาเปิด + ความยาว TF
const TF_MS = { M1: 60e3, M5: 300e3, M15: 900e3, M30: 1800e3, H1: 3600e3, H4: 14400e3, D1: 86400e3, W1: 604800e3 };
function barCloseMs(ts, tf) {
  if (tf === "MN1") { const d = new Date(ts); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1); }
  return ts + (TF_MS[tf] || 0);
}
function barCdText(ms) {
  const s = Math.floor(ms / 1000), d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  const p = (n) => String(n).padStart(2, "0");
  if (d > 0) return `${d}d ${p(h)}:${p(m)}`;
  return h > 0 ? `${p(h)}:${p(m)}:${p(x)}` : `${p(m)}:${p(x)}`;
}

function toBar(r) {
  return { timestamp: r[0] * 1000, open: r[1], high: r[2], low: r[3], close: r[4], volume: r[5] };
}

// ---------- ตัวจัดการทั้งหน้า ----------
class ChartManager {
  constructor({ grid, toolbar, getAcct, getDigits, onSubscribe, onPanelChanged, onLineDragged, onLineClicked, onLinePulled, extraTools, onChartTapped }) {
    this.onChartTapped = onChartTapped || (() => {});
    this.onModClick = (p, v, e) => (typeof onChartModClick === "function" ? onChartModClick(p, v, e) : false);
    this.overlayHitAt = 0;
    this.extraTools = extraTools || (() => []);
    this.onLinePulled = onLinePulled || (() => {});
    this.onPanelChanged = onPanelChanged || (() => {});
    this.onLineDragged = onLineDragged || (() => {});
    this.onLineClicked = onLineClicked || (() => {});
    this.grid = grid;
    this.toolbar = toolbar;
    this.acct = getAcct;
    this.digits = (s) => getDigits(s) ?? 5;
    this.onSubscribe = onSubscribe;
    this.panels = [];
    this.active = 0;
    this.selectedOverlay = null;
    const saved = store("wt.charts", null);
    this.layout = [1, 2, 4].includes(saved?.layout) ? saved.layout : 1;
    this.configs = Array.isArray(saved?.panels) ? saved.panels : [];
    this.timezone = TIMEZONES[saved?.timezone] ? saved.timezone : "Asia/Bangkok";
    this.showTrades = store("wt.showTrades", true);
    this.forceSingle = window.matchMedia("(max-width: 700px)").matches;
    this.hist = {};
    this.buildToolbar();
    this.build();
    window.addEventListener("resize", () => this.panels.forEach((p) => p.chart.resize()));
    // นับถอยหลังแท่ง + ใส่แท่งที่พักไว้ตอนกราฟถูกซ่อน (กลับมาแสดงผ่านทางไหนก็ได้: สลับแท็บ/หน้า/layout)
    setInterval(() => this.panels.forEach((p) => { if (p.held) p.flushHeld(); if (!p.isHidden()) p.paintCd(); }), 1000);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) this.panels.forEach((p) => p.flushHeld()); });
    document.addEventListener("keydown", (e) => {
      const typing = /INPUT|SELECT|TEXTAREA/.test(document.activeElement?.tagName);
      if (!typing && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        this.panels[this.active]?.undoRedo(e.shiftKey ? "redo" : "undo"); e.preventDefault(); return;
      }
      if (!typing && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") {
        this.panels[this.active]?.undoRedo("redo"); e.preventDefault(); return;
      }
      if ((e.key === "Delete" || e.key === "Backspace") && this.selectedOverlay && !/INPUT|SELECT|TEXTAREA/.test(document.activeElement?.tagName)) {
        this.deleteSelected();
        e.preventDefault();
      }
    });
  }

  // ปุ่มเครื่องมือวาด: กด = ติดกรอบ (กำลังวาด), วาดเสร็จ = คืนกลับ, กดซ้ำ = ยกเลิก
  toggleDraw(name) {
    const p = this.panels[this.active];
    if (!p) return;
    const again = this.drawing?.name === name;
    this.cancelDraw();
    if (again) return;
    const id = p.startDrawing(name);
    if (id) { this.drawing = { name, panel: p, id }; this.paintDrawBtns(); }
  }

  cancelDraw() {
    if (this.drawing) this.drawing.panel.cancelDrawing();
    this.drawing = null;
    this.paintDrawBtns();
  }

  drawEnded(id) {
    if (this.drawing && (!id || this.drawing.id === id)) { this.drawing = null; this.paintDrawBtns(); }
  }

  paintDrawBtns() {
    for (const [n, b] of Object.entries(this.drawBtns || {})) b.classList.toggle("on", this.drawing?.name === n);
  }

  buildToolbar() {
    this.drawBtns = {};
    const tb = this.toolbar;
    tb.replaceChildren();
    const lay = document.createElement("div");
    lay.className = "tool-group";
    for (const n of [1, 2, 4]) {
      const b = document.createElement("button");
      b.textContent = n === 1 ? "▢" : n === 2 ? "▥" : "⊞";
      b.title = `${n} กราฟ`;
      b.className = "tool" + (n === this.layout ? " on" : "");
      b.addEventListener("click", () => { this.layout = n; this.build(); this.buildToolbar(); });
      lay.append(b);
    }
    this.syncBtn = document.createElement("button");
    this.syncBtn.textContent = "🔗";
    this.syncBtn.title = "ซิงก์ crosshair / symbol / เวลา ระหว่างกราฟ";
    this.syncBtn.className = "tool";
    this.syncBtn.addEventListener("click", () => this.openSyncMenu());
    lay.append(this.syncBtn);
    this.paintSyncBtn();
    const draw = document.createElement("div");
    draw.className = "tool-group";
    for (const [name, icon, label] of DRAW_TOOLS) {
      const b = document.createElement("button");
      b.textContent = icon; b.title = label; b.className = "tool";
      b.addEventListener("click", () => this.toggleDraw(name));
      this.drawBtns[name] = b;
      draw.append(b);
    }
    const hist = document.createElement("div");
    hist.className = "tool-group";
    this.undoBtn = document.createElement("button");
    this.undoBtn.textContent = "↶"; this.undoBtn.title = "ย้อนกลับ (Ctrl+Z)"; this.undoBtn.className = "tool";
    this.undoBtn.addEventListener("click", () => this.panels[this.active]?.undoRedo("undo"));
    this.redoBtn = document.createElement("button");
    this.redoBtn.textContent = "↷"; this.redoBtn.title = "ไปข้างหน้า (Ctrl+Shift+Z)"; this.redoBtn.className = "tool";
    this.redoBtn.addEventListener("click", () => this.panels[this.active]?.undoRedo("redo"));
    hist.append(this.undoBtn, this.redoBtn);
    const fx = document.createElement("button");
    fx.append("ƒx", Object.assign(document.createElement("span"), { className: "lbl", textContent: " อินดิเคเตอร์" }));
    fx.title = "อินดิเคเตอร์: พื้นฐาน MT5 / ของฉัน (จาก TradingView) + ค้นหา"; fx.className = "tool";
    fx.addEventListener("click", () => openIndicatorList());
    hist.append(fx);
    const eye = document.createElement("button");
    eye.className = "tool" + (this.showTrades ? " on" : "");
    eye.replaceChildren(this.showTrades ? "👁" : "🚫", Object.assign(document.createElement("span"), { className: "lbl", textContent: " ออเดอร์" }));
    eye.title = "ซ่อน/แสดงเส้นออเดอร์บนกราฟ";
    eye.addEventListener("click", () => {
      this.showTrades = !this.showTrades;
      save("wt.showTrades", this.showTrades);
      eye.className = "tool" + (this.showTrades ? " on" : "");
      eye.replaceChildren(this.showTrades ? "👁" : "🚫", Object.assign(document.createElement("span"), { className: "lbl", textContent: " ออเดอร์" }));
      this.onPanelChanged(this.panels[this.active]);
    });
    hist.append(eye);
    const newsBtn = document.createElement("button");
    const paintNewsBtn = () => {
      const on = typeof setting !== "function" || setting("chart.news") !== false;
      newsBtn.className = "tool" + (on ? " on" : "");
      newsBtn.replaceChildren("📰", Object.assign(document.createElement("span"), { className: "lbl", textContent: " ข่าว" }));
    };
    newsBtn.title = "ซ่อน/แสดงเส้นข่าวบนกราฟ (ระดับข่าวตั้งใน ⚙️ ตั้งค่า)";
    newsBtn.addEventListener("click", () => { setSetting("chart.news", setting("chart.news") === false); paintNewsBtn(); });
    paintNewsBtn();
    hist.append(newsBtn);
    // ลบ / ตั้งค่า / alert ของเส้นที่เลือก ย้ายไปแถบลอย (objBar) ที่ขึ้นตอนแตะเลือกเส้น
    const del = document.createElement("button");
    del.textContent = "🗑"; del.title = "ลบเส้นทั้งหมดของ symbol นี้"; del.className = "tool";
    del.addEventListener("click", () => {
      const p = this.panels[this.active];
      if (p && confirm(`ลบเส้นทั้งหมดของ ${p.symbol}?`)) p.clearDrawings();
    });
    draw.append(del);
    const tz = document.createElement("select");
    for (const [v, label] of Object.entries(TIMEZONES)) {
      const o = document.createElement("option"); o.value = v; o.textContent = label; tz.append(o);
    }
    tz.value = this.timezone;
    tz.addEventListener("change", () => {
      this.timezone = tz.value;
      this.panels.forEach((p) => p.chart.setTimezone(this.timezone));
      this.saveLayout();
    });
    const extra = document.createElement("div");
    extra.className = "tool-group";
    for (const b of this.extraTools(this)) extra.append(b);
    tb.append(lay, hist, draw, extra, tz);
    this.paintHistoryButtons();
  }

  build() {
    this.drawing = null;
    this.paintDrawBtns?.();
    this.panels.forEach((p) => p.dispose());
    this.panels = [];
    this.setSelected(null);
    const n = this.count();
    this.grid.className = `chart-grid grid-${n}`;
    const defaults = ["XAUUSD", "EURUSD", "GBPUSD", "USDJPY"];
    for (let i = 0; i < n; i++) {
      const cfg = this.configs[i] || { symbol: defaults[i], tf: "M15" };
      const p = new ChartPanel(this, i, cfg);
      this.panels.push(p);
      p.mount(this.grid);
    }
    this.setActive(Math.min(this.active, n - 1));
    this.paintSyncBtn();
    this.saveLayout();
    this.resubscribe();
    this.onPanelChanged(this.panels[this.active]);
  }

  setActive(i) {
    const changed = this.active !== i;
    this.active = i;
    this.panels.forEach((p, j) => p.el.classList.toggle("active", j === i && this.count() > 1));
    if (changed) this.onPanelChanged(this.panels[i]);
    this.paintHistoryButtons();
  }

  panelChanged(p) { this.onPanelChanged(p); }

  // มือถือ: บังคับกราฟเดียว (ไม่แก้ค่า layout ที่บันทึกไว้สำหรับจอใหญ่)
  count() { return this.forceSingle ? 1 : this.layout; }

  setForceSingle(on) {
    if (!!this.forceSingle === on) return;
    this.forceSingle = on;
    if (on) this.active = 0;
    this.build();
  }

  resizeAll() { this.panels.forEach((p) => { p.chart.resize(); p.flushHeld(); }); }

  lineDragged(group, line, value, revert, settle) { this.onLineDragged(group, line, value, revert, settle); }

  lineMoving(group, line, value) { return typeof onLineMoving === "function" ? onLineMoving(group, line, value) : null; }

  lineClicked(group, line, key) { this.onLineClicked(group, line, key); }

  linePulled(group, line, key, value) { this.overlayHitAt = Date.now(); this.onLinePulled(group, line, key, value); }

  chartTapped(p) {
    if (this.selectedOverlay) this.setSelected(null);   // แตะที่ว่าง = เลิกเลือกเส้น ซ่อนแถบลอย
    this.onChartTapped(p);
  }

  history(sym) {
    if (!this.hist[sym]) {
      const h = { undoStack: [], redoStack: [], cur: null };
      h.baseline = (snap) => { if (h.cur === null) h.cur = JSON.stringify(snap); };
      h.record = (snap) => {
        const j = JSON.stringify(snap);
        if (j === h.cur) return;
        if (h.cur !== null) h.undoStack.push(h.cur);
        if (h.undoStack.length > 100) h.undoStack.shift();
        h.redoStack = [];
        h.cur = j;
      };
      h.undo = () => {
        if (!h.undoStack.length) return null;
        h.redoStack.push(h.cur);
        h.cur = h.undoStack.pop();
        return JSON.parse(h.cur);
      };
      h.redo = () => {
        if (!h.redoStack.length) return null;
        h.undoStack.push(h.cur);
        h.cur = h.redoStack.pop();
        return JSON.parse(h.cur);
      };
      this.hist[sym] = h;
    }
    return this.hist[sym];
  }

  paintHistoryButtons() {
    const p = this.panels?.[this.active];
    const h = p ? this.history(p.symbol) : null;
    if (this.undoBtn) this.undoBtn.disabled = !h?.undoStack.length;
    if (this.redoBtn) this.redoBtn.disabled = !h?.redoStack.length;
  }

  setSelected(sel) {
    this.selectedOverlay = sel;
    this.paintObjBar();
  }

  // ---------- แถบลอยจัดการเส้นที่เลือก (แบบ TradingView): ลาก / สี / หนา / ประ / alert / ล็อก / ตั้งค่า / ลบ ----------
  paintObjBar() {
    const sel = this.selectedOverlay;
    const o = sel && sel.panel.chart.getOverlays({ id: sel.id })[0];
    if (!o) { if (this.objBar) this.objBar.hidden = true; return; }
    if (!this.objBar) {
      this.objBar = document.createElement("div");
      this.objBar.className = "obj-bar";
      for (const t of ["pointerdown", "mousedown", "touchstart", "click"]) this.objBar.addEventListener(t, (e) => e.stopPropagation(), { passive: true });
      document.body.append(this.objBar);
    }
    const bar = this.objBar;
    const mk = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; };
    const ln = o.styles?.line || {};
    const color = /^#[0-9a-f]{6}$/i.test(ln.color || "") ? ln.color : "#2f81f7";
    const size = ln.size || 1;
    const dashed = ln.style === "dashed";
    const isFib = o.name === "fibRetracement";
    // แก้สไตล์ทันทีโดยไม่สร้างเส้นใหม่ (เส้นยังถูกเลือกอยู่ แถบไม่หาย)
    const restyle = (patch) => {
      const line = { color, size, style: dashed ? "dashed" : "solid", ...patch };
      line.dashedValue = line.style === "dashed" ? [6, 4] : undefined;
      sel.panel.chart.overrideOverlay({ id: sel.id, styles: { line } });
      sel.panel.scheduleSave();
      this.paintObjBar();
    };
    const btn = (text, title, fn, cls = "") => { const b = mk("button", { type: "button", className: "ob-btn " + cls, textContent: text, title }); b.onclick = fn; return b; };
    const handle = mk("span", { className: "ob-handle", textContent: "⠿", title: "ลากย้ายแถบ" });
    const kids = [handle];
    if (!isFib) {
      const c = btn("✎", "สีเส้น", () => { pop.hidden = !pop.hidden; }, "ob-color");
      c.style.setProperty("--c", color);
      const pop = mk("div", { className: "ob-pop", hidden: true });
      for (const sw of ["#2f81f7", "#f23645", "#089981", "#ff9800", "#9c27b0", "#e6e8ec", "#ffeb3b", "#00bcd4", "#787b86"]) {
        const b = mk("button", { type: "button", className: "swatch" + (sw === color ? " on" : ""), title: sw });
        b.style.background = sw;
        b.onclick = () => restyle({ color: sw });
        pop.append(b);
      }
      const custom = mk("input", { type: "color", value: color, title: "สีอื่น" });
      custom.onchange = () => restyle({ color: custom.value });
      pop.append(custom);
      kids.push(mk("span", { className: "ob-wrap" }, c, pop));
      const w = btn("", `ความหนา ${size} (กดเพื่อเปลี่ยน)`, () => restyle({ size: size % 4 + 1 }), "ob-width");
      w.append(mk("i", {}));
      w.lastChild.style.height = `${size + 1}px`;
      kids.push(w, btn(dashed ? "┅" : "━", dashed ? "เส้นประ (กดเป็นเส้นทึบ)" : "เส้นทึบ (กดเป็นเส้นประ)", () => restyle({ style: dashed ? "solid" : "dashed" })));
    }
    const alertOk = ["segment", "rayLine", "straightLine", "horizontalStraightLine", "horizontalRayLine", "rectBox"].includes(o.name);
    if (alertOk && typeof createDrawingAlert === "function") {
      const aid = o.extendData && typeof o.extendData === "object" ? o.extendData.alertId : null;
      const active = aid && typeof pa !== "undefined" && pa.items.some((a) => a.id === aid && a.on);
      kids.push(btn("🔔", active ? "มี alert อยู่ — กดเพื่อยกเลิก" : "ตั้ง alert (แจ้ง Telegram เมื่อราคาตัด/เข้า — ผูกกับเส้นนี้)", async () => {
        if (active) { await deletePriceAlert(aid); toast("ยกเลิก alert ของเส้นนี้แล้ว"); } else await createDrawingAlert(sel.panel, sel.id);
        this.paintObjBar();
      }, active ? "on" : ""));
    }
    kids.push(
      btn(o.lock ? "🔒" : "🔓", o.lock ? "ล็อกอยู่ (ลากเส้นไม่ได้) — กดเพื่อปลด" : "ล็อกไม่ให้ลากเส้นพลาด", () => {
        sel.panel.chart.overrideOverlay({ id: sel.id, lock: !o.lock }); sel.panel.scheduleSave(); this.paintObjBar();
      }, o.lock ? "on" : ""),
      btn("⚙", "ตั้งค่าทั้งหมด", () => openDrawingSettings(sel.panel, sel.id)),
      btn("🗑", "ลบเส้นนี้ (Delete)", () => this.deleteSelected(), "danger"));
    bar.replaceChildren(...kids);
    bar.hidden = false;
    this.placeObjBar(sel.panel);
    // ลากย้ายแถบ (จำตำแหน่งเทียบกับกราฟไว้ในเครื่อง)
    handle.onpointerdown = (e) => {
      e.preventDefault();
      const r = bar.getBoundingClientRect(), dx = e.clientX - r.left, dy = e.clientY - r.top;
      handle.setPointerCapture(e.pointerId);
      const move = (ev) => {
        const br = sel.panel.body.getBoundingClientRect();
        const x = Math.max(0, Math.min(window.innerWidth - r.width, ev.clientX - dx));
        const y = Math.max(0, Math.min(window.innerHeight - r.height, ev.clientY - dy));
        bar.style.left = `${x}px`; bar.style.top = `${y}px`;
        this.objPos = { x: (x - br.left) / Math.max(1, br.width), y: y - br.top };
      };
      const up = () => { handle.onpointermove = handle.onpointerup = null; localSet("wt.objbar", this.objPos); };
      handle.onpointermove = move;
      handle.onpointerup = up;
    };
  }

  placeObjBar(panel) {
    const bar = this.objBar;
    const br = panel.body.getBoundingClientRect();
    this.objPos = this.objPos || localGet("wt.objbar") || null;
    const w = bar.offsetWidth, h = bar.offsetHeight;
    let x = this.objPos ? br.left + this.objPos.x * br.width : br.left + (br.width - w) / 2;
    let y = this.objPos ? br.top + this.objPos.y : br.top + 10;
    x = Math.max(4, Math.min(window.innerWidth - w - 4, x));
    y = Math.max(4, Math.min(window.innerHeight - h - 4, y));
    bar.style.left = `${x}px`; bar.style.top = `${y}px`;
  }

  deleteSelected() {
    const s = this.selectedOverlay;
    if (!s) return;
    s.panel.chart.removeOverlay({ id: s.id });   // onRemoved -> บันทึกเอง
    this.setSelected(null);
  }

  openSymbol(sym) { this.panels[this.active]?.setSymbol(sym); }

  // แตะกราฟ (panel ที่ active) เพื่อเลือกราคา — ปุ่มที่กดค้างสถานะไว้จนแตะหรือกดซ้ำ
  startPick(btn, cb) {
    const p = this.panels[this.active];
    if (!p) return;
    const again = this.pickBtn === btn;
    this.cancelPick();
    if (again) return;
    this.pickBtn = btn;
    btn?.classList.add("on");
    p.msg.textContent = "แตะที่กราฟเพื่อเลือกราคา (กดปุ่มซ้ำ = ยกเลิก)";
    p.pick((v, ts) => cb(p, v, ts));
  }

  cancelPick() {
    this.panels.forEach((p) => { if (p.picker) { p.pick(null); p.msg.textContent = ""; } });
    this.pickDone();
  }

  // ---------- ซิงก์หลายกราฟ (crosshair / symbol / เวลา) ----------
  syncOn(k) { return this.count() > 1 && !!store("wt.sync", { cross: true, sym: false, time: false })[k]; }

  syncCross(src, ts) {
    if (!this.syncOn("cross")) return;
    for (const p of this.panels) if (p !== src) p.showXLine(ts);
  }

  syncSymbol(src, sym) {
    if (this.syncing || !this.syncOn("sym")) return;
    this.syncing = true;
    try { for (const p of this.panels) if (p !== src) p.setSymbol(sym); } finally { this.syncing = false; }
  }

  syncTime(src) {
    if (this.syncingTime || !this.syncOn("time")) return;
    this.syncingTime = true;
    try {
      const ts = src.rightTs();
      for (const p of this.panels) {
        if (p === src) continue;
        if (ts == null) { p.chart.scrollToRealTime(0); continue; }
        const idx = p.indexAtOrBefore(ts);
        if (idx >= 0) p.chart.scrollToDataIndex(idx, 0);
      }
    } finally {
      setTimeout(() => { this.syncingTime = false; }, 30);   // scroll ที่สั่งเองก็ยิง onScroll — กันวนกลับ
    }
  }

  openSyncMenu() {
    const cur = { cross: true, sym: false, time: false, ...store("wt.sync", {}) };
    openDialog("ซิงก์กราฟ (โหมด 2/4 กราฟ)", (form, close) => {
      for (const [k, t] of [["cross", "Crosshair — ชี้แท่งไหน กราฟอื่นขึ้นเส้นเวลาเดียวกัน + OHLC"], ["sym", "Symbol — เปลี่ยนคู่เงินกราฟหนึ่ง ทุกกราฟเปลี่ยนตาม"],
        ["time", "เวลา — เลื่อนกราฟหนึ่ง กราฟอื่นเลื่อนไปช่วงเวลาเดียวกัน"]]) {
        const cb = mkx("input", { type: "checkbox", checked: !!cur[k] });
        cb.onchange = () => { cur[k] = cb.checked; save("wt.sync", { ...cur }); this.paintSyncBtn(); if (k === "cross" && !cb.checked) this.panels.forEach((p) => p.showXLine(null)); };
        form.append(mkx("label", { className: "chk ind-field" }, cb, t));
      }
      const x = mkx("button", { type: "button", className: "btn-primary", textContent: "ปิด" });
      x.onclick = close;
      form.append(x);
    }, { wide: false });
  }

  paintSyncBtn() {
    if (!this.syncBtn) return;
    const s = { cross: true, ...store("wt.sync", {}) };
    this.syncBtn.hidden = this.count() < 2;
    this.syncBtn.classList.toggle("on", !!(s.cross || s.sym || s.time));
  }

  pickDone() {
    this.pickBtn?.classList.remove("on");
    this.pickBtn = null;
    this.panels.forEach((p) => { if (p.msg.textContent.startsWith("แตะที่กราฟ")) p.msg.textContent = ""; });
  }

  saveLayout() {
    this.panels.forEach((p, i) => { this.configs[i] = { symbol: p.symbol, tf: p.tf }; });
    save("wt.charts", { layout: this.layout, panels: this.configs, timezone: this.timezone });
  }

  barKeys() {
    const keys = new Map();
    for (const p of this.panels) if (p.barCb) keys.set(`${p.symbol}|${p.tf}`, [p.symbol, p.tf]);
    return [...keys.values()];
  }

  resubscribe() { this.onSubscribe(); }

  onBars(m) { this.panels.forEach((p) => p.onBars(m)); }

  drawingsChanged(src, sym) {
    for (const p of this.panels) if (p !== src && p.symbol === sym) p.loadDrawings();
  }

  // เปลี่ยนบัญชี / symbol list มาใหม่
  reload() { this.panels.forEach((p) => p.applySymbol()); }
  refreshPrecision() { this.panels.forEach((p) => p.refreshPrecision()); }
}

// ---------- ▾ ข้างชื่อ symbol: เลือกคู่จาก watchlist (ลอยบน body เพราะหัวกราฟ overflow:hidden) ----------
function openSymMenu(panel, anchor) {
  let m = document.getElementById("sym-menu");
  if (m) { m.remove(); if (m.dataset.panel === String(panel.idx)) return; }
  m = document.createElement("div");
  m.id = "sym-menu";
  m.dataset.panel = String(panel.idx);
  // กลุ่มที่เปิดอยู่ก่อน แล้วกลุ่มอื่น (มีหลายกลุ่ม = ขึ้นหัวชื่อกลุ่ม)
  const groups = state.wg?.groups?.length ? state.wg.groups.map((g, i) => ({ ...g, i })) : [{ name: "", syms: state.watch || [], i: 0 }];
  const act = state.wg?.active ?? 0;
  groups.sort((a, b) => (b.i === act) - (a.i === act));
  const rows = [];
  for (const g of groups) {
    if (groups.length > 1) rows.push({ head: `${g.i === act ? "● " : ""}${g.name}` });
    for (const sym of g.syms) rows.push({ sym });
  }
  if (!rows.some((r) => r.sym)) m.append(Object.assign(document.createElement("div"), { className: "muted small sm-empty", textContent: "watchlist ว่าง" }));
  for (const r of rows) {
    if (r.head) { m.append(Object.assign(document.createElement("div"), { className: "muted small sm-head", textContent: r.head })); continue; }
    const sym = r.sym;
    const q = state.quotes?.[sym];
    const b = document.createElement("button");
    b.type = "button";
    b.className = "sm-row" + (sym === panel.symbol ? " on" : "");
    b.append(Object.assign(document.createElement("b"), { textContent: sym }),
      Object.assign(document.createElement("span"), { className: "muted", textContent: q ? px(sym, q.bid) : "" }));
    b.onclick = () => { close(); panel.setSymbol(sym); };
    m.append(b);
  }
  document.body.append(m);
  const r = panel.symInput.getBoundingClientRect();
  m.style.left = `${Math.max(4, Math.min(r.left, innerWidth - m.offsetWidth - 4))}px`;
  m.style.top = `${r.bottom + 4}px`;
  m.style.maxHeight = `${Math.max(120, innerHeight - r.bottom - 16)}px`;
  const away = (e) => { if (!m.contains(e.target) && e.target !== anchor) close(); };
  const esc = (e) => { if (e.key === "Escape") close(); };
  function close() { m.remove(); document.removeEventListener("pointerdown", away, true); document.removeEventListener("keydown", esc); }
  setTimeout(() => { document.addEventListener("pointerdown", away, true); document.addEventListener("keydown", esc); }, 0);
}
