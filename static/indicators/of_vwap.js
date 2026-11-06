// "Order Flow VWAP Deviation [LuxAlgo]" (Pine v6, CC BY-NC-SA 4.0 © LuxAlgo) — แปลงเป็น JS สำหรับ Mee Terminal
// ต้นฉบับ: ~/Desktop/Order Flow VWAP Deviation [LuxAlgo].rtf (320 บรรทัด, 13 inputs)
// ตรรกะตามต้นฉบับ:
//   VWAP (hlc3) + แถบ ±k×SD รีเซ็ตตาม Session/Week/Month/Year
//   Stop Zones: pivot high/low (lookback ซ้าย=ขวา) -> เส้นประยืดขวาจนราคาแตะ, แตะพร้อม volume > SMA20×1.2 = จุด "Stops Triggered"
//   IFVG (ปิดไว้เป็นค่าเริ่มต้น): FVG ที่แท่งกลางตัวใหญ่ (> SMA50 ของตัวแท่ง × filter) ถูกปิดทะลุ = กล่อง IFVG จนราคาปิดกลับ
//   Volume Profile ล่วงหน้า: สะสม close/volume ตั้งแต่แท่ง anchor (18:00 GMT-4) -> แถวสูงสุด = POC (เหลือง),
//   แถว > เฉลี่ย×1.5 = Stop Zone (ส้ม) พร้อม "1.8x" + B/S (ซื้อ/ขายโดยประมาณจากตำแหน่ง close ในแท่ง)
// ต่างจาก TradingView:
//   - timeframe.change("D"/"W"/"M"/"12M") ใช้เวลา UTC (= เวลา server Exness): วันเริ่ม 00:00, สัปดาห์เริ่มวันอาทิตย์
//   - แท่ง anchor = แท่งแรกที่ช่วงเวลาแท่ง "ทับ" ช่วง session (TF ใหญ่กว่า 1 นาทีก็ยังเจอ anchor)
//   - volume = tick volume ของ MT5, คำนวณจากแท่งที่โหลดอยู่ในกราฟ
//   - fill แถบใช้ไล่สีต่อแท่ง (แดง/เขียว 10% ที่ขอบ -> 0% ที่ VWAP) เหมือนต้นฉบับ
"use strict";

const OFV_MAX_LINES = 500;
const OFV_RED = "#f23645", OFV_GREEN = "#089981";

function ofvPivot(bars, i, left, right, isHigh) {
  const c = i - right;
  if (c - left < 0) return null;
  const v = isHigh ? bars[c].high : bars[c].low;
  for (let k = 1; k <= left; k++) { const o = isHigh ? bars[c - k].high : bars[c - k].low; if (isHigh ? o >= v : o <= v) return null; }
  for (let k = 1; k <= right; k++) { const o = isHigh ? bars[c + k].high : bars[c + k].low; if (isHigh ? o > v : o < v) return null; }
  return v;
}

// รอบใหม่ของ VWAP (UTC): Session = วัน, Week = อาทิตย์, Month, Year
function ofvPeriodKey(ms, anchor) {
  const d = new Date(ms);
  if (anchor === "Week") return Math.floor((ms / 1000 - 3 * 86400) / 604800);
  if (anchor === "Month") return d.getUTCFullYear() * 12 + d.getUTCMonth();
  if (anchor === "Year") return d.getUTCFullYear();
  return Math.floor(ms / 86400000);
}

// "1800-1801" + "GMT-4" -> แท่ง [open, open+tf) ทับช่วงนั้นไหม
function ofvInSession(ms, tfMs, sess, tz) {
  const m = /^(\d{2})(\d{2})-(\d{2})(\d{2})$/.exec(sess || "");
  if (!m) return false;
  const off = tz === "GMT-5" ? -300 : tz === "GMT-4" ? -240 : 0;
  const a = +m[1] * 60 + +m[2], b = +m[3] * 60 + +m[4];
  const len = ((b - a) + 1440) % 1440 || 1440;
  const start = ms / 60000 + off, end = start + Math.max(1, tfMs / 60000);
  // ช่วง session ของวันนั้น/วันก่อน ที่อาจทับแท่ง
  const day0 = Math.floor(start / 1440) * 1440;
  for (const d of [day0 - 1440, day0, day0 + 1440]) {
    const s = d + a, e = s + len;
    if (s < end && e > start) return true;
  }
  return false;
}

function ofvCalc(bars, cfg) {
  const n = bars.length;
  const out = { vwap: [], up: [], lo: [], lines: [], stopHi: [], stopLo: [], ifvg: [], anchors: [], profile: null, events: {} };
  if (n < 3) return out;
  const tfMs = n > 1 ? Math.min(...bars.slice(-20).map((b, i, a) => (i ? b.timestamp - a[i - 1].timestamp : Infinity))) : 60000;
  const L = cfg.pivotLookback;
  // VWAP
  let key = null, sv = 0, svv = 0, spv = 0;
  // Stop lines
  const upper = [], lower = [];
  // IFVG
  const bearF = [], bullF = [], boxes = [];
  const vol = bars.map((b) => b.volume || 0);
  const body = bars.map((b) => Math.abs(b.close - b.open));
  const sma = (arr, len, i) => { if (i < len - 1) return null; let s = 0; for (let k = i - len + 1; k <= i; k++) s += arr[k]; return s / len; };
  // Session profile
  let sess = [];
  let prevIn = false;
  for (let i = 0; i < n; i++) {
    const b = bars[i];
    // --- VWAP ---
    const k = ofvPeriodKey(b.timestamp, cfg.vwapAnchor);
    if (k !== key) { key = k; sv = 0; svv = 0; spv = 0; }
    const src = (b.high + b.low + b.close) / 3, v = vol[i];
    sv += v; spv += src * v; svv += src * src * v;
    if (sv > 0) {
      const vw = spv / sv, sd = Math.sqrt(Math.max(0, svv / sv - vw * vw));
      out.vwap[i] = vw; out.up[i] = vw + cfg.stdDevMult * sd; out.lo[i] = vw - cfg.stdDevMult * sd;
    } else out.vwap[i] = out.up[i] = out.lo[i] = null;
    // --- Stop lines ---
    const ph = ofvPivot(bars, i, L, L, true), pl = ofvPivot(bars, i, L, L, false);
    if (ph != null) {
      const ln = { x1: i - L, x2: i, y: ph, hi: true, del: false };
      out.lines.push(ln); upper.unshift(ln);
      if (upper.length > cfg.maxActiveLines) upper.pop().del = true;
    }
    if (pl != null) {
      const ln = { x1: i - L, x2: i, y: pl, hi: false, del: false };
      out.lines.push(ln); lower.unshift(ln);
      if (lower.length > cfg.maxActiveLines) lower.pop().del = true;
    }
    const avg20 = sma(vol, 20, i);
    let trigU = false, trigL = false;
    for (let j = upper.length - 1; j >= 0; j--) {
      const ln = upper[j];
      ln.x2 = i;
      if (b.high >= ln.y) { if (avg20 != null && v > avg20 * 1.2) trigU = true; upper.splice(j, 1); }
    }
    for (let j = lower.length - 1; j >= 0; j--) {
      const ln = lower[j];
      ln.x2 = i;
      if (b.low <= ln.y) { if (avg20 != null && v > avg20 * 1.2) trigL = true; lower.splice(j, 1); }
    }
    out.stopHi[i] = trigU ? b.high : null; out.stopLo[i] = trigL ? b.low : null;   // ราคาไว้วางจุดเหนือ/ใต้แท่ง
    // --- IFVG ---
    if (i >= 2) {
      const avgBody = sma(body, 50, i);
      const valid = avgBody != null && body[i - 1] > avgBody * cfg.ifvgVolFilter;
      if (cfg.showIFVG && valid && b.high < bars[i - 2].low) bearF.unshift({ top: bars[i - 2].low, btm: b.high, bar: i - 1 });
      if (cfg.showIFVG && valid && b.low > bars[i - 2].high) bullF.unshift({ top: b.low, btm: bars[i - 2].high, bar: i - 1 });
    }
    if (cfg.showIFVG) {
      const push = (f, bull) => {
        boxes.unshift({ left: f.bar, right: i + 10, top: f.top, btm: f.btm, bull, lblX: i, created: i });
        if (boxes.length > cfg.ifvgHistory) boxes.pop();
      };
      for (let j = bearF.length - 1; j >= 0; j--) if (b.close > bearF[j].top) { push(bearF[j], true); bearF.splice(j, 1); }
      for (let j = bullF.length - 1; j >= 0; j--) if (b.close < bullF[j].btm) { push(bullF[j], false); bullF.splice(j, 1); }
    }
    for (let j = boxes.length - 1; j >= 0; j--) {
      const x = boxes[j];
      if (x.bull ? b.close < x.btm : b.close > x.top) boxes.splice(j, 1);
      else if (i < x.right) x.right = i + 5;
    }
    // --- Forward volume collection ---
    const inS = ofvInSession(b.timestamp, tfMs, cfg.sessionAnchor, cfg.sessionTz);
    const anchor = inS && !prevIn;
    prevIn = inS;
    if (anchor) { sess = []; out.anchors.push(i); }
    const rng = Math.max(b.high - b.low, 1e-10);
    sess.push([b.close, v, v * (b.close - b.low) / rng, v * (b.high - b.close) / rng]);
  }
  out.ifvg = boxes;
  // เส้นที่ถูกลบ (หลุดจาก max active) ไม่วาด + จำกัด 500 เส้นล่าสุดเหมือน max_lines_count
  out.lines = out.lines.filter((l) => !l.del).slice(-OFV_MAX_LINES);
  // --- Profile ที่แท่งสุดท้าย ---
  if (sess.length) {
    const rows = cfg.vpRows;
    let hi = -Infinity, lo = Infinity;
    for (const [p] of sess) { hi = Math.max(hi, p); lo = Math.min(lo, p); }
    const size = (hi - lo) / rows;
    if (size > 0) {
      const bins = Array.from({ length: rows }, () => [0, 0, 0]);
      for (const [p, v, bv, sv2] of sess) {
        const k = Math.min(rows - 1, Math.max(0, Math.floor((p - lo) / size)));
        bins[k][0] += v; bins[k][1] += bv; bins[k][2] += sv2;
      }
      let maxV = 0, tot = 0, poc = 0;
      bins.forEach((x, k) => { tot += x[0]; if (x[0] > maxV) { maxV = x[0]; poc = k; } });
      out.profile = { lo, size, bins, maxV, avg: tot / rows, poc, x: n - 1 + cfg.vpOffset };
    }
  }
  const last = n - 1;
  out.events = {
    stop_high: out.stopHi[last] != null ? { level: out.stopHi[last] } : null,
    stop_low: out.stopLo[last] != null ? { level: out.stopLo[last] } : null,
  };
  for (const bull of [true, false]) {
    const x = boxes.find((y) => y.created === last && y.bull === bull);
    out.events[bull ? "ifvg_bull" : "ifvg_bear"] = x ? { top: x.top, bot: x.btm } : null;
  }
  out.tfMs = tfMs;
  return out;
}

function ofvDraw(ctx, st, h, cfg) {
  const from = Math.max(0, h.from - 1), to = Math.min(st.vwap.length, h.to + 1);
  const light = typeof themeIsLight === "function" && themeIsLight();
  const fg = light ? "#131722" : "#d1d4dc";
  // anchor bar = พื้นเหลือง
  const barW = Math.max(1, h.x(1) - h.x(0));
  ctx.fillStyle = pineColor("#ffeb3b", 80);
  for (const a of st.anchors) if (a >= from && a <= to) ctx.fillRect(h.x(a) - barW / 2, 0, barW, h.height);
  // fill แถบ: ไล่สีจากขอบ (10%) -> VWAP (0%) ต่อช่วงแท่ง
  for (let i = from + 1; i < to; i++) {
    const v0 = st.vwap[i - 1], v1 = st.vwap[i];
    if (v0 == null || v1 == null) continue;
    for (const [band, col] of [[st.up, OFV_RED], [st.lo, OFV_GREEN]]) {
      const b0 = band[i - 1], b1 = band[i];
      const yb = h.y((b0 + b1) / 2), yv = h.y((v0 + v1) / 2);
      if (Math.abs(yb - yv) < 0.5) continue;
      const g = ctx.createLinearGradient(0, yb, 0, yv);
      g.addColorStop(0, pineColor(col, 90)); g.addColorStop(1, pineColor(col, 100));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(h.x(i - 1), h.y(b0)); ctx.lineTo(h.x(i), h.y(b1)); ctx.lineTo(h.x(i), h.y(v1)); ctx.lineTo(h.x(i - 1), h.y(v0));
      ctx.closePath(); ctx.fill();
    }
  }
  const plot = (arr, color) => {
    ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.beginPath();
    let pen = false;
    for (let i = from; i < to; i++) {
      if (arr[i] == null) { pen = false; continue; }
      const x = h.x(i), y = h.y(arr[i]);
      if (pen) ctx.lineTo(x, y); else { ctx.moveTo(x, y); pen = true; }
    }
    ctx.stroke();
  };
  plot(st.vwap, pineColor(fg, 50)); plot(st.up, OFV_RED); plot(st.lo, OFV_GREEN);
  // Stop lines
  ctx.save(); ctx.setLineDash([4, 4]);
  for (const l of st.lines) {
    if (l.x2 < h.from - 1 || l.x1 > h.to + 1) continue;
    ctx.strokeStyle = pineColor(l.hi ? OFV_RED : OFV_GREEN, 60);
    const y = Math.round(h.y(l.y)) + 0.5;
    ctx.beginPath(); ctx.moveTo(h.x(l.x1), y); ctx.lineTo(h.x(l.x2), y); ctx.stroke();
  }
  ctx.restore();
  // Stops Triggered: วงกลมเหนือ/ใต้แท่ง
  for (let i = from; i < to; i++) {
    for (const [px, hi] of [[st.stopHi[i], true], [st.stopLo[i], false]]) {
      if (px == null) continue;
      ctx.fillStyle = pineColor(hi ? OFV_RED : OFV_GREEN, 50);
      ctx.beginPath(); ctx.arc(h.x(i), hi ? h.y(px) - 8 : h.y(px) + 8, 3, 0, Math.PI * 2); ctx.fill();
    }
  }
  // IFVG
  ctx.font = "10px -apple-system, 'Segoe UI', sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
  for (const x of st.ifvg) {
    const col = x.bull ? OFV_GREEN : OFV_RED;
    const x1 = h.x(x.left), x2 = h.x(x.right), yt = h.y(x.top), yb = h.y(x.btm);
    ctx.fillStyle = pineColor(col, 85); ctx.fillRect(x1, yt, x2 - x1, yb - yt);
    ctx.strokeStyle = pineColor(col, 60); ctx.strokeRect(x1 + 0.5, yt + 0.5, x2 - x1, yb - yt);
    ctx.fillStyle = col; ctx.fillText("IFVG", h.x(x.lblX), (yt + yb) / 2);
  }
  // Profile (ด้านขวาของแท่งล่าสุด ความกว้างเป็นจำนวนแท่ง)
  const p = st.profile;
  if (p) {
    const x0 = h.x(p.x), barPx = h.x(p.x + 1) - x0;
    ctx.textAlign = "left";
    p.bins.forEach(([v, bv, sv], k) => {
      if (!(v > 0)) return;
      const w = Math.round((v / p.maxV) * cfg.vpWidth);
      const isStop = v > p.avg * cfg.stopThreshold;
      const col = k === p.poc ? pineColor("#FFEB3B", 10) : isStop ? pineColor("#ff9800", 30) : pineColor("#5b9cf6", 60);
      const yt = h.y(p.lo + (k + 1) * p.size), yb = h.y(p.lo + k * p.size);
      ctx.fillStyle = col;
      ctx.fillRect(x0, yt, w * barPx, Math.max(1, yb - yt));
      if (isStop || k === p.poc) {
        const yc = (yt + yb) / 2, xr = x0 + w * barPx + 3;
        const txt = `${(Math.round((v / p.avg) * 10) / 10).toString()}x`;
        ctx.fillStyle = k === p.poc ? "#FFEB3B" : "#ff9800";
        ctx.fillText(txt, xr, yc);
        ctx.fillStyle = bv > sv ? OFV_GREEN : OFV_RED;
        ctx.fillText(bv > sv ? "B" : "S", xr + ctx.measureText(txt).width + 3, yc);
      }
    });
  }
}

const OFV_DEF = {
  name: "of_vwap",
  title: "Order Flow VWAP Deviation",
  desc: "LuxAlgo · VWAP ±SD, Stop Zones, IFVG, Volume Profile ล่วงหน้า",
  alerts: {
    stop_high: "Stops Triggered High (ราคาแตะเส้น stop บน + volume สูง)",
    stop_low: "Stops Triggered Low (ราคาแตะเส้น stop ล่าง + volume สูง)",
    ifvg_bull: "IFVG ขาขึ้นใหม่",
    ifvg_bear: "IFVG ขาลงใหม่",
  },
  inputs: [
    { key: "vwapAnchor", label: "VWAP Anchor", type: "select", options: ["Session", "Week", "Month", "Year"], default: "Session", group: "VWAP Settings", tooltip: "Session = วัน (00:00 UTC)" },
    { key: "stdDevMult", label: "Std. Dev Multiplier", type: "float", default: 2.0, min: 0.5, step: 0.1, group: "VWAP Settings" },
    { key: "pivotLookback", label: "Pivot Lookback (Stop Zones)", type: "int", default: 50, min: 10, group: "Stop Zones (Pivots)" },
    { key: "maxActiveLines", label: "Max Active Lines", type: "int", default: 10, min: 1, max: 50, group: "Stop Zones (Pivots)" },
    { key: "vpRows", label: "Profile Rows", type: "int", default: 50, min: 10, max: 100, group: "Volume Profile & Stop Zones" },
    { key: "vpWidth", label: "Profile Max Width (Bars)", type: "int", default: 30, min: 5, group: "Volume Profile & Stop Zones" },
    { key: "vpOffset", label: "Profile Right Offset", type: "int", default: 10, min: 0, group: "Volume Profile & Stop Zones" },
    { key: "sessionAnchor", label: "Anchor Time Range (HHMM-HHMM)", type: "select", options: ["1800-1801", "1700-1701", "0000-0001", "0930-0931", "0300-0301", "2000-2001"], default: "1800-1801", group: "Volume Profile & Stop Zones" },
    { key: "sessionTz", label: "Timezone", type: "select", options: ["GMT-5", "GMT-4", "UTC"], default: "GMT-4", group: "Volume Profile & Stop Zones" },
    { key: "stopThreshold", label: "Stop Zone Volume Multiplier", type: "float", default: 1.5, min: 1.0, step: 0.1, group: "Volume Profile & Stop Zones" },
    { key: "showIFVG", label: "Show IFVGs", type: "bool", default: false, group: "Inversion Fair Value Gaps (IFVGs)" },
    { key: "ifvgVolFilter", label: "IFVG Volatility Filter", type: "float", default: 1.2, min: 0.5, step: 0.1, group: "Inversion Fair Value Gaps (IFVGs)" },
    { key: "ifvgHistory", label: "Max Active IFVGs", type: "int", default: 5, min: 1, max: 20, group: "Inversion Fair Value Gaps (IFVGs)" },
  ],
  calc: ofvCalc,
  draw: ofvDraw,
};

if (typeof module !== "undefined") module.exports = { ofvCalc, ofvInSession, ofvPeriodKey, OFV_DEF };
else defineIndicator(OFV_DEF);
