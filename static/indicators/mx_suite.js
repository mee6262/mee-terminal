// "Mxwll Suite" (Pine v5, MPL-2.0 © Mxwll Capital) — แปลงเป็น JS สำหรับ Mee Terminal
// ต้นฉบับ: ~/Desktop/mxwll suite mee ver.rtf (946 บรรทัด) = ต้นฉบับ Mxwll Price Action Suite + Fib 0.65 / 0.886 เปิดไว้
// ส่วนประกอบ (ตามต้นฉบับทีละขั้น):
//   pivot แบบ Mxwll: high[len] > max(high 0..len-1) = ขาขึ้น (0), low[len] < min = ขาลง (1) — swing เกิดตอนสลับสถานะ
//   External (25): HH/LH, HL/LL + Swing Order Block (กล่องบาง 0.2%) + BoS/CHoCH เมื่อ close ตัดระดับ swing ล่าสุด
//   Internal (3): I-BoS / I-CHoCH
//   Auto Fibs: เส้นหลักจาก swing ล่าสุด -> high/low สุดตั้งแต่ swing ฝั่งตรงข้าม + ระดับ fib 10 ช่อง
//   Area of Interest: max/min ของ open/close 50 แท่ง ± ATR(14)
//   FVG: 3 แท่งสีเดียวกันติดกัน -> กล่องจากแท่งกลาง ลบเมื่อถูกแตะ (เลือกหดตามราคาได้ / แสดงเฉพาะอันใกล้สุด)
//   Rolling 4H / 1D High-Low (เส้น aqua) + Dashboard (session NY / Asia / London, นับถอยหลัง, ระดับ volume 4H/24H)
//   พื้นหลัง session NY 09:30-16:00 / Asia 20:00-02:00 / London 03:00-11:30 (เวลา New York)
// ต่างจาก TradingView:
//   - TF > 1 นาที ต้นฉบับใช้แท่ง M1 (request.security_lower_tf) คิด 4H/1D ย้อนหลัง — ที่นี่ใช้แท่งบนกราฟที่อยู่ในช่วง 4 ชม./24 ชม. ล่าสุด
//   - Dashboard ใช้ตรรกะเดิมทั้งหมด รวมจุดแปลกของต้นฉบับ (ช่วง Asia 20:00-02:00 ไม่เคยเข้าเงื่อนไข -> ขึ้น Dead Zone,
//     20:00-24:00 "Next Session Open" เป็น NaN) เพื่อให้ตรงกับที่เห็นบน TradingView
//   - volume = tick volume ของ MT5, คำนวณจากแท่งที่โหลดอยู่ในกราฟ
"use strict";

const MX_C = { aqua: "#00BCD4", red: "#FF5252", blue: "#2962FF", gray: "#787B86", lime: "#00E676", yellow: "#FFEB3B", orange: "#FF9800" };
const MX_MAX_BOXES = 500;
const mxNy = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });

// offset ของ NY เปลี่ยนเฉพาะตอนต้นชั่วโมง UTC (DST) -> ถาม Intl ครั้งเดียวต่อชั่วโมง แล้วคิดเองด้วย getUTC* (เร็วกว่า formatToParts ทุกแท่ง ~10 เท่า)
const mxNyOff = new Map();
function mxNyParts(ms) {
  const hk = Math.floor(ms / 3600000);
  let off = mxNyOff.get(hk);
  if (off === undefined) {
    const base = hk * 3600000, o = {};
    for (const p of mxNy.formatToParts(new Date(base))) o[p.type] = +p.value;
    if (o.hour === 24) o.hour = 0;
    off = Date.UTC(o.year, o.month - 1, o.day, o.hour, o.minute) - base;
    if (mxNyOff.size > 50000) mxNyOff.clear();
    mxNyOff.set(hk, off);
  }
  const d = new Date(ms + off);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), hour: d.getUTCHours(), minute: d.getUTCMinutes() };
}

// timestamp("America/New_York", y, m, d, hh, mm) -> ms (แปลงผ่าน offset ของ NY ณ วันนั้น)
function mxNyTs(y, mo, d, hh, mm) {
  const guess = Date.UTC(y, mo - 1, d, hh, mm);
  const p = mxNyParts(guess);
  const off = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - guess;
  return guess - off;
}

// calculatePivots(length) ของ Mxwll — คืนอาร์เรย์ top/bot ต่อแท่ง (0 = ไม่มี)
function mxPivots(bars, len) {
  const n = bars.length, top = new Array(n).fill(0), bot = new Array(n).fill(0);
  let intra = 0;
  for (let i = 0; i < n; i++) {
    if (!(i > len + 1)) continue;
    let up = -Infinity, dn = Infinity;
    for (let k = i - len + 1; k <= i; k++) { up = Math.max(up, bars[k].high); dn = Math.min(dn, bars[k].low); }
    const cHi = bars[i - len].high, cLo = bars[i - len].low;
    const prev = intra;
    intra = cHi > up ? 0 : cLo < dn ? 1 : prev;
    top[i] = intra === 0 && prev !== 0 ? cHi : 0;
    bot[i] = intra === 1 && prev !== 1 ? cLo : 0;
  }
  return { top, bot };
}

function mxPercentileNR(arr, p, sorted) {
  const s = sorted ? arr : [...arr].sort((a, b) => a - b);
  const r = Math.max(1, Math.ceil((p / 100) * s.length));
  return s[Math.min(s.length, r) - 1];
}

function mxCalc(bars, cfg) {
  const n = bars.length;
  const st = { n, labels: [], lines: [], hiBlocks: [], loBlocks: [], fvg: [], main: null, fibs: [], aoe: null, roll: {}, sessBg: [], events: {} };
  if (n < 5) return st;
  const intSens = parseInt(cfg.intSens, 10) || 3, extSens = parseInt(cfg.extSens, 10) || 25;
  const ext = mxPivots(bars, extSens), int = mxPivots(bars, intSens);
  const fibP = cfg.showFibs ? (extSens === 25 ? ext : mxPivots(bars, 25)) : null;
  const tfMs = Math.min(...bars.slice(-20).map((b, i, a) => (i ? b.timestamp - a[i - 1].timestamp : Infinity)));
  const big = { moving: 0, upaxis: 0, upaxis2: 0, dnaxis: 0, dnaxis2: 0, upside: 1, downside: 1 };
  const ks = { movingSmall: 0 };      // keyValues ของ internals (ค่าที่ยังไม่ put = undefined = na)
  let prevUp = null, prevDn = null, prevUpS, prevDnS;
  let counterFibs = 0;
  const events = {};
  const drawChar = (x, y, str, col, down, i) => {
    st.lines.push({ x1: x, x2: i, y, col, dashed: true });
    st.labels.push({ x: Math.round((x + i) / 2), y, text: str, col, pos: down ? "above" : "below", size: 11 });
  };
  // ATR(14) แบบ RMA
  const atr = new Array(n).fill(null);
  let rma = null;
  for (let i = 0; i < n; i++) {
    const b = bars[i], tr = i ? Math.max(b.high - b.low, Math.abs(b.high - bars[i - 1].close), Math.abs(b.low - bars[i - 1].close)) : b.high - b.low;
    if (i < 14) { rma = (rma ?? 0) + tr; if (i === 13) rma /= 14; atr[i] = i === 13 ? rma : null; }
    else { rma = (rma * 13 + tr) / 14; atr[i] = rma; }
  }
  // AOE state
  let aoeHi = null, aoeLo = null;
  // FVG
  const fvgDn = [], fvgUp = [];
  // Session bg
  for (let i = 0; i < n; i++) {
    const b = bars[i];
    // ---------- External structure ----------
    if (ext.top[i] !== 0) {
      big.upside = 1;
      const x1 = i - extSens;
      const txt = ext.top[i] > big.upaxis ? "HH" : "LH";
      if (cfg.showHHLH) st.labels.push({ x: x1, y: ext.top[i], text: txt, col: cfg.bearC, pos: "above", size: 11, swing: true });
      if (cfg.showOB) st.hiBlocks.push({ left: x1, top: ext.top[i], bottom: ext.top[i] * 0.998 });
      big.upaxis = ext.top[i]; big.upaxis2 = x1;
      if (fibP === ext) counterFibs = 1;
    }
    if (ext.bot[i] !== 0) {
      big.downside = 1;
      const x1 = i - extSens;
      const txt = ext.bot[i] < big.dnaxis ? "LL" : "HL";
      if (cfg.showHLLL) st.labels.push({ x: x1, y: ext.bot[i], text: txt, col: cfg.bullC, pos: "below", size: 11, swing: true });
      if (cfg.showOB) st.loBlocks.push({ left: x1, top: ext.bot[i], bottom: ext.bot[i] * 1.002 });
      big.dnaxis = ext.bot[i]; big.dnaxis2 = x1;
      if (fibP === ext) counterFibs = -1;
    }
    if (fibP && fibP !== ext) { if (fibP.top[i] !== 0) counterFibs = 1; if (fibP.bot[i] !== 0) counterFibs = -1; }
    if (cfg.showExt) {
      const c0 = b.close, c1 = i ? bars[i - 1].close : null;
      if (c1 != null && prevUp != null && c0 > big.upaxis && c1 <= prevUp && big.upside !== 0) {
        const str = big.moving < 0 ? (cfg.extStru !== "BoS" ? "CHoCH" : "") : (cfg.extStru !== "CHoCH" ? "BoS" : "");
        if (cfg.extStru === "All" || cfg.extStru.includes(str)) { drawChar(big.upaxis2, big.upaxis, str, cfg.bullC, true, i); if (i === n - 1) events.ext_bull = { level: big.upaxis, kind: str }; }
        big.upside = 0; big.moving = 1;
      }
      if (c1 != null && prevDn != null && c0 < big.dnaxis && c1 >= prevDn && big.downside !== 0) {
        const str = big.moving > 0 ? (cfg.extStru !== "BoS" ? "CHoCH" : "") : (cfg.extStru !== "CHoCH" ? "BoS" : "");
        if (cfg.extStru === "All" || cfg.extStru.includes(str)) { drawChar(big.dnaxis2, big.dnaxis, str, cfg.bearC, false, i); if (i === n - 1) events.ext_bear = { level: big.dnaxis, kind: str }; }
        big.downside = 0; big.moving = -1;
      }
      prevUp = big.upaxis; prevDn = big.dnaxis;
    }
    // ---------- Order blocks: ลบเมื่อราคาปิดผ่าน + จำกัดจำนวน (ตามต้นฉบับ: ลบเกิน 1 อัน) ----------
    for (const [arr, hi] of [[st.hiBlocks, true], [st.loBlocks, false]]) {
      for (let k = arr.length - 1; k >= 0; k--) if (hi ? b.close >= arr[k].top : b.close <= arr[k].bottom) arr.splice(k, 1);
      if (arr.length > cfg.showLast && cfg.showLast !== 0) arr.splice(0, arr.length - cfg.showLast + 1);
    }
    // ---------- Internals ----------
    if (cfg.showInt) {
      if (int.top[i] !== 0) { ks.upsideSmall = 1; ks.upaxisSmall = int.top[i]; ks.upaxis2Small = i - intSens; }
      if (int.bot[i] !== 0) { ks.downsideSmall = 1; ks.dnaxisSmall = int.bot[i]; ks.dnaxis2Small = i - intSens; }
      const c0 = b.close, c1 = i ? bars[i - 1].close : null;
      if (ks.upaxisSmall != null && prevUpS != null && c1 != null && c0 > ks.upaxisSmall && c1 <= prevUpS && ks.upsideSmall !== 0) {
        const str = ks.movingSmall < 0 ? (cfg.intStru !== "BoS" ? "I-CHoCH" : "") : (cfg.intStru !== "CHoCH" ? "I-BoS" : "");
        if (cfg.intStru === "All" || (str && str.includes(cfg.intStru))) { drawChar(ks.upaxis2Small, ks.upaxisSmall, str, cfg.bullC, true, i); if (i === n - 1) events.int_bull = { level: ks.upaxisSmall, kind: str }; }
        ks.upsideSmall = 0; ks.movingSmall = 1;
      }
      if (ks.dnaxisSmall != null && prevDnS != null && c1 != null && c0 < ks.dnaxisSmall && c1 >= prevDnS && ks.downsideSmall !== 0) {
        const str = ks.movingSmall > 0 ? (cfg.intStru !== "BoS" ? "I-CHoCH" : "") : (cfg.intStru !== "CHoCH" ? "I-BoS" : "");
        if (cfg.intStru === "All" || (str && str.includes(cfg.intStru))) { drawChar(ks.dnaxis2Small, ks.dnaxisSmall, str, cfg.bearC, false, i); if (i === n - 1) events.int_bear = { level: ks.dnaxisSmall, kind: str }; }
        ks.downsideSmall = 0; ks.movingSmall = -1;
      }
      prevUpS = ks.upaxisSmall; prevDnS = ks.dnaxisSmall;
    }
    // ---------- Area of Interest ----------
    if (cfg.showAOE && i + 1 > 50) {
      let mx = -Infinity, mn = Infinity;
      for (let k = i - 49; k <= i; k++) { mx = Math.max(mx, bars[k].close, bars[k].open); mn = Math.min(mn, bars[k].close, bars[k].open); }
      const a = atr[i] ?? 0;
      if (!aoeHi) { aoeHi = { top: mx * 1.01 }; aoeLo = { bottom: mn * 0.99 }; }
      const hiOn = b.close <= aoeHi.top * 1.01;
      aoeHi = { top: mx + a, bottom: mx, left: hiOn ? i - 50 : i + 5, on: hiOn };
      const loOn = b.close >= aoeLo.bottom * 0.99;
      aoeLo = loOn ? { top: mn, bottom: mn - a, left: i - 50, on: true } : { top: mn, bottom: -a, left: i + 5, on: false };
    }
    // ---------- FVG ----------
    if (cfg.showFVG && i >= 2) {
      const sg = (k) => Math.sign(bars[k].close - bars[k].open);
      const sum = sg(i) + sg(i - 1) + sg(i - 2);
      const col = cfg.closeOnly ? null : true;
      if (sum === -3) fvgDn.push({ left: i - 1, top: bars[i - 2].low, bottom: b.high, shown: !!col, created: i });
      if (sum === 3) fvgUp.push({ left: i - 1, top: b.low, bottom: bars[i - 2].high, shown: !!col, created: i });
      for (let k = fvgDn.length - 1; k >= 0; k--) {
        const f = fvgDn[k];
        if (b.high >= f.top) fvgDn.splice(k, 1);
        else if (cfg.contract && b.high > f.bottom) f.bottom = b.high;
      }
      for (let k = fvgUp.length - 1; k >= 0; k--) {
        const f = fvgUp[k];
        if (b.low <= f.bottom) fvgUp.splice(k, 1);
        else if (cfg.contract && b.low < f.top) f.top = b.low;
      }
    }
    // ---------- พื้นหลัง session (เวลา NY ของแท่ง) ----------
    const p = mxNyParts(b.timestamp);
    const hm = p.hour * 60 + p.minute;
    const inR = (a, b2) => (b2 >= a ? hm >= a && hm <= b2 : hm >= a || hm <= b2);
    st.sessBg[i] = [inR(570, 960) ? cfg.nyCol : null, inR(1200, 120) ? cfg.asCol : null, inR(180, 690) ? cfg.loCol : null];
  }
  // ---------- สถานะ ณ แท่งสุดท้าย ----------
  const last = n - 1;
  st.labels = st.labels.slice(-490);   // max_labels_count / max_lines_count = 500 (เผื่อ fib/4H/1D) — ของเก่าสุดหายก่อน
  st.lines = st.lines.slice(-480);
  // Fib main line
  if (cfg.showFibs && counterFibs !== 0) {
    let x1, y1, x2 = null, y2 = null;
    if (counterFibs === 1) {
      x1 = big.upaxis2; y1 = big.upaxis;
      let lo = 1e8;
      for (let k = 0; k <= last - big.dnaxis2 && last - k >= 0; k++) { const v = bars[last - k].low; lo = Math.min(v, lo); if (lo === v) { x2 = last - k; y2 = lo; } }
    } else {
      x1 = big.dnaxis2; y1 = big.dnaxis;
      let hi = 0;
      for (let k = 0; k <= last - big.upaxis2 && last - k >= 0; k++) { const v = bars[last - k].high; hi = Math.max(v, hi); if (hi === v) { x2 = last - k; y2 = hi; } }
    }
    if (x2 != null) {
      if (x2 < x1) [x1, y1, x2, y2] = [x2, y2, x1, y1];
      st.main = { x1, y1, x2, y2, col: y2 < y1 ? "#F24968" : "#14D990" };
      const sub = y1 - y2;
      for (let k = 1; k <= 10; k++) {
        if (!cfg[`show${k}`]) continue;
        const f = cfg[`fib${k}`];
        st.fibs.push({ y: sub * f + y2, col: cfg[`fib${k}col`], text: String(f), x1: x2 });
      }
    }
  }
  st.aoe = cfg.showAOE && aoeHi ? { hi: aoeHi, lo: aoeLo, right: last + 5 } : null;
  // FVG closest only
  if (cfg.showFVG && cfg.closeOnly) {
    const c = bars[last].close;
    for (const [arr, key] of [[fvgDn, "bottom"], [fvgUp, "top"]]) {
      let best = null, d = Infinity;
      for (let k = arr.length - 1; k >= 0; k--) { const dd = Math.abs(c - arr[k][key]); d = Math.min(d, dd); if (dd === d) best = arr[k]; }
      if (best) best.shown = true;
    }
  }
  const boxesLeft = MX_MAX_BOXES - st.hiBlocks.length - st.loBlocks.length - 2;
  st.fvg = [...fvgDn.map((f) => ({ ...f, up: false })), ...fvgUp.map((f) => ({ ...f, up: true }))].filter((f) => f.shown)
    .sort((a, b) => a.created - b.created).slice(-Math.max(0, boxesLeft));
  // Rolling 4H / 1D: ช่วงเวลาย้อนหลังจากแท่งล่าสุด + volume สะสมต่อแท่ง (ใช้จัดระดับ activity)
  for (const [key, mins, show, lab] of [["4h", 240, cfg.show4H, cfg.show4hLab], ["1d", 1440, cfg.show1D, cfg.show1DLab]]) {
    const win = mins * 60000;
    const vols = [];
    let lo = 0, sum = 0;
    for (let i = 0; i < n; i++) {
      sum += bars[i].volume || 0;
      while (bars[lo].timestamp <= bars[i].timestamp - win) { sum -= bars[lo].volume || 0; lo++; }
      if (bars[i].timestamp - bars[0].timestamp + tfMs >= win) vols.push(sum);
    }
    const cur = sum;
    let hi = 0, low = 1e8, hiX = last, loX = last;
    for (let i = last; i >= lo; i--) {     // ใหม่ -> เก่า เหมือนต้นฉบับ (เท่ากัน = แท่งเก่ากว่า)
      hi = Math.max(hi, bars[i].high); if (hi === bars[i].high) hiX = i;
      low = Math.min(low, bars[i].low); if (low === bars[i].low) loX = i;
    }
    st.roll[key] = { show, lab, tag: key === "4h" ? "240" : "1D", hi, low, hiX, loX, vol: cur, vols };
  }
  const act = (r) => {
    if (!r.vols.length) return "";
    const sv = Float64Array.from(r.vols).sort();   // เรียงครั้งเดียวใช้ 4 percentile
    const [p1, p2, p3, p4] = [10, 33, 50, 66].map((q) => mxPercentileNR(sv, q, true));
    return r.vol <= p1 ? "Very Low" : r.vol <= p2 ? "Low" : r.vol <= p3 ? "Average" : r.vol <= p4 ? "High" : "Very High";
  };
  st.act4h = act(st.roll["4h"]); st.act1d = act(st.roll["1d"]);
  st.events = {
    ext_bull: events.ext_bull || null, ext_bear: events.ext_bear || null,
    int_bull: events.int_bull || null, int_bear: events.int_bear || null,
    new_hh: ext.top[last] !== 0 ? { level: ext.top[last] } : null, new_ll: ext.bot[last] !== 0 ? { level: ext.bot[last] } : null,
  };
  return st;
}

// Dashboard (timenow = ตอนวาด) — ตรรกะเดิมของต้นฉบับ
function mxDashboard(now) {
  const p = mxNyParts(now);
  const h = p.hour, m = p.minute;
  const inR = (sh, sm, eh, em) => (h > sh || (h === sh && m >= sm)) && (h < eh || (h === eh && m <= em));
  const ts = (d, hh, mm) => mxNyTs(p.year, p.month, d, hh, mm);
  const dayAdj = h < 2 ? p.day + 1 : p.day;
  let col, till, s1, s2;
  if (inR(9, 30, 16, 0)) [col, till, s1, s2] = ["#f24968", ts(p.day, 16, 0), "New York", "Asia"];
  else if (inR(20, 0, 2, 0)) [col, till, s1, s2] = ["#14D990", ts(dayAdj, 2, 0), "Asia", "London"];
  else if (inR(3, 0, 11, 30)) [col, till, s1, s2] = ["#F2B807", ts(p.day, 11, 30), "London", "New York"];
  else [col, till, s1, s2] = ["#787B86", null, "Dead Zone", (h > 16 || h < 3) ? "London" : (h >= 11 && h < 20) ? "Asia" : "New York"];
  let till2 = inR(9, 30, 16, 0) ? ts(p.day, 20, 0) : inR(20, 0, 2, 0) ? ts(p.day, 3, 0) : inR(3, 0, 11, 30) ? ts(p.day, 9, 30) : null;
  if (till2 == null) till2 = h < 9 || (h === 9 && m < 30) ? ts(p.day, 9, 30) : h < 20 ? ts(p.day, 20, 0) : h < 3 ? ts(p.day, 3, 0) : null;
  const diff = (t) => (t == null ? [NaN, NaN] : [Math.floor((t - now) / 3600000), Math.floor(((t - now) % 3600000) / 60000)]);
  const [hh, mm] = diff(till), [hh2, mm2] = diff(till2);
  return { col, s1, s2, close: s1 !== "Dead Zone" ? `${hh}h${mm}m` : "Dead Zone", open: `${hh2}h:${mm2}m` };
}

function mxDraw(ctx, st, h, cfg) {
  if (!st.n) return;
  const from = Math.max(0, h.from - 1), to = Math.min(st.n, h.to + 1);
  const barW = Math.max(1, h.x(1) - h.x(0));
  const text = (t, x, y, col, size = 11, align = "left", base = "middle") => {
    ctx.font = `${size}px -apple-system, 'Segoe UI', Tahoma, sans-serif`; ctx.fillStyle = col; ctx.textAlign = align; ctx.textBaseline = base; ctx.fillText(t, x, y);
  };
  // พื้นหลัง session
  for (let i = from; i < to; i++) {
    const s = st.sessBg[i];
    if (!s) continue;
    for (const c of s) if (c) { ctx.fillStyle = pineColor(c, cfg.tra); ctx.fillRect(h.x(i) - barW / 2, 0, barW, h.height); }
  }
  const box = (l, r, t, b, bg, border, label, labelCol) => {
    const x1 = h.x(l), x2 = h.x(r), y1 = h.y(t), y2 = h.y(b);
    const y = Math.min(y1, y2), hh = Math.max(1, Math.abs(y2 - y1));
    if (bg) { ctx.fillStyle = bg; ctx.fillRect(x1, y, x2 - x1, hh); }
    if (border) { ctx.strokeStyle = border; ctx.lineWidth = 1; ctx.strokeRect(x1 + 0.5, y + 0.5, x2 - x1, hh); }
    if (label && x2 > x1) text(label, (x1 + x2) / 2, y + hh / 2, labelCol, 11, "center");
  };
  const right = st.n - 1 + 5;
  // Swing order blocks
  for (const b of st.hiBlocks) box(b.left, right, b.top, b.bottom, pineColor(MX_C.red, 95), pineColor(MX_C.red, 75));
  for (const b of st.loBlocks) box(b.left, right, b.top, b.bottom, pineColor(MX_C.blue, 95), pineColor(MX_C.blue, 75));
  // FVG
  const fc = pineColor(cfg.fvgcol, cfg.fvgtra);
  for (const f of st.fvg) box(f.left, st.n - 1, f.top, f.bottom, fc, fc);
  // Area of Interest
  if (st.aoe) {
    const { hi, lo } = st.aoe;
    if (hi.on) box(hi.left, st.aoe.right, hi.top, hi.bottom, pineColor("#F24968", 90), null, "Area of Interest", pineColor("#F24968", 33));
    if (lo.on) box(lo.left, st.aoe.right, lo.top, lo.bottom, pineColor("#14D990", 90), null, "Area of Interest", pineColor("#14D990", 33));
  }
  // เส้น BoS/CHoCH (ประ) + ป้าย
  ctx.save(); ctx.setLineDash([4, 3]); ctx.lineWidth = 1;
  for (const l of st.lines) {
    if (l.x2 < h.from - 1 || l.x1 > h.to + 1) continue;
    const y = Math.round(h.y(l.y)) + 0.5;
    ctx.strokeStyle = l.col; ctx.beginPath(); ctx.moveTo(h.x(l.x1), y); ctx.lineTo(h.x(l.x2), y); ctx.stroke();
  }
  ctx.restore();
  for (const lb of st.labels) {
    if (lb.x < h.from - 2 || lb.x > h.to + 2 || !lb.text) continue;
    const y = h.y(lb.y);
    text(lb.text, h.x(lb.x), lb.pos === "above" ? y - 3 : y + 3, lb.col, lb.size, "center", lb.pos === "above" ? "bottom" : "top");
  }
  // Auto fib
  if (st.main) {
    const m = st.main;
    ctx.save(); ctx.setLineDash([6, 4]); ctx.lineWidth = 2; ctx.strokeStyle = m.col;
    ctx.beginPath(); ctx.moveTo(h.x(m.x1), h.y(m.y1)); ctx.lineTo(h.x(m.x2), h.y(m.y2)); ctx.stroke();
    ctx.restore();
    for (const f of st.fibs) {
      const y = Math.round(h.y(f.y)) + 0.5;
      ctx.strokeStyle = pineColor(f.col, 75); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(h.x(f.x1), y); ctx.lineTo(h.x(st.n - 1 + 5), y); ctx.stroke();
      text(f.text, h.x(st.n - 1 + 5) + 4, y, f.col, 11);
    }
  }
  // Rolling 4H / 1D high-low
  for (const r of Object.values(st.roll)) {
    if (!r.show) continue;
    ctx.strokeStyle = MX_C.aqua; ctx.lineWidth = 1;
    for (const [x, y] of [[r.hiX, r.hi], [r.loX, r.low]]) {
      const yy = Math.round(h.y(y)) + 0.5;
      ctx.beginPath(); ctx.moveTo(h.x(x), yy); ctx.lineTo(h.x(st.n - 1), yy); ctx.stroke();
    }
    if (r.lab) { text(`${r.tag}H`, h.x(st.n - 1) + 4, h.y(r.hi), MX_C.aqua, 10); text(`${r.tag}L`, h.x(st.n - 1) + 4, h.y(r.low), MX_C.aqua, 10); }
  }
  // Dashboard มุมขวาบน
  if (cfg.showDashboard) {
    const d = mxDashboard(Date.now());
    const rows = [["Session:", d.s1], ["Session Close:", d.close], ["Next Session:", d.s2], ["Next Session Open:", d.open], ["4-Hr Volume:", st.act4h], ["24-Hr Volume:", st.act1d]];
    ctx.font = "11px -apple-system, 'Segoe UI', Tahoma, sans-serif";
    const w1 = Math.max(...rows.map((r) => ctx.measureText(r[0]).width)) + 12, w2 = Math.max(...rows.map((r) => ctx.measureText(String(r[1])).width)) + 12;
    const rh = 18, x0 = h.width - w1 - w2 - 8, y0 = 30;
    ctx.fillStyle = "#20222C"; ctx.fillRect(x0, y0, w1 + w2, rh * rows.length);
    ctx.strokeStyle = "#363843"; ctx.lineWidth = 1;
    rows.forEach((r, k) => {
      const y = y0 + k * rh;
      ctx.strokeRect(x0 + 0.5, y + 0.5, w1, rh); ctx.strokeRect(x0 + w1 + 0.5, y + 0.5, w2, rh);
      text(r[0], x0 + 6, y + rh / 2, "#ffffff");
      text(String(r[1]), x0 + w1 + w2 / 2, y + rh / 2, "#ffffff", 11, "center");
    });
  }
}

const MX_FIB_DEF = [[0.236, true, MX_C.gray], [0.382, true, MX_C.lime], [0.5, true, MX_C.yellow], [0.618, true, MX_C.orange], [0.786, true, MX_C.red],
  [0.65, true, MX_C.gray], [0.886, true, MX_C.gray], [0, false, MX_C.gray], [0, false, MX_C.gray], [0, false, MX_C.gray]];

const MX_DEF = {
  name: "mx_suite",
  title: "Mxwll Suite",
  desc: "SMC BoS/CHoCH, Swing OB, HH/LL, Auto Fib, FVG, AOI, 4H/1D High-Low, Dashboard",
  alerts: {
    ext_bull: "BoS/CHoCH ขาขึ้น (External)",
    ext_bear: "BoS/CHoCH ขาลง (External)",
    int_bull: "I-BoS/I-CHoCH ขาขึ้น (Internal)",
    int_bear: "I-BoS/I-CHoCH ขาลง (Internal)",
    new_hh: "Swing High ใหม่ (HH/LH)",
    new_ll: "Swing Low ใหม่ (HL/LL)",
  },
  inputs: [
    { key: "bullC", label: "Bull Color", type: "color", default: "#14D990", group: "Smart Money Concepts" },
    { key: "bearC", label: "Bear Color", type: "color", default: "#F24968", group: "Smart Money Concepts" },
    { key: "showInt", label: "Show Internals", type: "bool", default: true, group: "Smart Money Concepts" },
    { key: "intSens", label: "Internals Sensitivity", type: "select", options: ["3", "5", "8"], default: "3", group: "Smart Money Concepts" },
    { key: "intStru", label: "Internal Structure", type: "select", options: ["All", "BoS", "CHoCH"], default: "All", group: "Smart Money Concepts" },
    { key: "showExt", label: "Show Externals", type: "bool", default: true, group: "Smart Money Concepts" },
    { key: "extSens", label: "Externals Sensitivity", type: "select", options: ["10", "25", "50"], default: "25", group: "Smart Money Concepts" },
    { key: "extStru", label: "External Structure", type: "select", options: ["All", "BoS", "CHoCH"], default: "All", group: "Smart Money Concepts" },
    { key: "showOB", label: "Show Order Blocks", type: "bool", default: true, group: "Swing Blocks" },
    { key: "showLast", label: "Swing Order Blocks", type: "int", default: 10, min: 0, group: "Swing Blocks" },
    { key: "showHHLH", label: "Show HH/LH", type: "bool", default: true, group: "Swing Blocks" },
    { key: "showHLLL", label: "Show LH/LL", type: "bool", default: true, group: "Swing Blocks" },
    { key: "showAOE", label: "Show Area of Interest", type: "bool", default: true, group: "Swing Blocks" },
    { key: "show1D", label: "Show Previous Day High", type: "bool", default: true, group: "High/Low" },
    { key: "show1DLab", label: "Show 1 Day Labels", type: "bool", default: true, group: "High/Low" },
    { key: "show4H", label: "Show 4 Hour High", type: "bool", default: true, group: "High/Low" },
    { key: "show4hLab", label: "Show 4 Hour Labels", type: "bool", default: true, group: "High/Low" },
    { key: "showFVG", label: "Show Fair Value Gaps", type: "bool", default: true, group: "FVG" },
    { key: "contract", label: "Contract Violated FVG", type: "bool", default: false, group: "FVG" },
    { key: "closeOnly", label: "Show Closest Up/Down FVG Only", type: "bool", default: false, group: "FVG" },
    { key: "fvgcol", label: "FVG Color", type: "color", default: "#F2B807", group: "FVG" },
    { key: "fvgtra", label: "FVG Transparency", type: "int", default: 80, min: 0, max: 100, group: "FVG" },
    { key: "showDashboard", label: "Show Dashboard", type: "bool", default: true, group: "Dashboard" },
    { key: "showFibs", label: "Show Auto Fibs", type: "bool", default: true, group: "Auto Fibs" },
    ...MX_FIB_DEF.flatMap(([v, on, col], k) => [
      { key: `show${k + 1}`, label: `Fib ${k + 1} แสดง`, type: "bool", default: on, group: "Auto Fibs" },
      { key: `fib${k + 1}`, label: `Fib ${k + 1} ระดับ`, type: "float", default: v, min: 0, step: 0.01, group: "Auto Fibs" },
      { key: `fib${k + 1}col`, label: `Fib ${k + 1} สี`, type: "color", default: col, group: "Auto Fibs" },
    ]),
    { key: "nyCol", label: "NY Color", type: "color", default: "#f24968", group: "Sessions" },
    { key: "asCol", label: "Asia Color", type: "color", default: "#14D990", group: "Sessions" },
    { key: "loCol", label: "London Color", type: "color", default: "#F2B807", group: "Sessions" },
    { key: "tra", label: "Transparency", type: "int", default: 98, min: 0, max: 100, group: "Sessions" },
  ],
  calc: mxCalc,
  draw: mxDraw,
};

if (typeof module !== "undefined") module.exports = { mxCalc, mxPivots, mxDashboard, mxPercentileNR, mxNyParts, MX_DEF };
else defineIndicator(MX_DEF);
