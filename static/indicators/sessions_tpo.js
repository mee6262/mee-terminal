// "Market Sessions and TPO (+Forecast)" — Pine: indicator("Mxwll Sessions"), © Mxwll Capital, MPL-2.0
// ต้นฉบับ: ~/Desktop/Market Sessions and TPO (+Forecast).rtf (634 บรรทัด, 15 inputs) — แปลงเป็น JS สำหรับ Mee Terminal
// ส่วนประกอบ (ตามต้นฉบับ):
//   1) กรอบ session NY / London / Asia (เวลา America/New_York, ช่วงเวลาขึ้นกับ TF) + ข้อความ Range% / Vol / ∆
//   2) Pre-market (OPEN) / Post-market (CLOSE) กรอบเส้นประ; ช่วง post ขยายกรอบ session+pre ให้ครอบ post ด้วย
//   3) TPO profile ตอนจบ session: 21 ระดับ นับคาบ 30 นาทีที่ผ่านแต่ละระดับ (Bars / Letters), POC ม่วง, single print แดง
//   4) Naked POC: เส้น POC ยืดขวาจนราคาแตะ
//   5) Forecast: ระหว่าง session ฉายแท่งที่เหลือจาก median % เปลี่ยนแปลงต่อตำแหน่งแท่งของ session ในอดีต (Bars/Line)
// ตัดออก: บรรทัด "OI" (ต้นฉบับดึง open interest จาก ticker เฉพาะของ TradingView — MT5 ไม่มี)
// 🔴 คง quirk ต้นฉบับ: (ก) POC กรณีสูงสุดเท่ากันหลายชั้น เทียบ |mid - จำนวน| แทน |mid - ตำแหน่ง| (ข) Forecast คอลัมน์แรก
//    ใช้เฉพาะ session แรก (columnPlace เริ่ม 0 ครั้งแรก, 1 ครั้งต่อไป) (ค) ATR ในลูปแท่งฉายที่ 2 เป็นต้นไปไม่ขึ้นกับ "Use ATR"
// ต่างจากต้นฉบับโดยเจตนา: คอลัมน์ TPO คิดจากคาบ 30 นาทีจริงในช่วง session (ต้นฉบับอิง bar_index/ขนาดคาบ ซึ่งเพี้ยนเมื่อมีช่องว่างเวลา)
"use strict";

const ST_LETTERS = (() => {
  const base = [];
  for (let c = 65; c <= 90; c++) base.push(" " + String.fromCharCode(c));
  for (let c = 97; c <= 122; c++) base.push(" " + String.fromCharCode(c));
  return base;
})();
const ST_TF_MIN = { M1: 1, M5: 5, M15: 15, M30: 30, H1: 60, H4: 240 };

const stNyFmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour12: false, hour: "2-digit", minute: "2-digit" });
// offset ของ NY เปลี่ยนเฉพาะต้นชั่วโมง UTC -> ถาม Intl ครั้งเดียวต่อชั่วโมง (ผลเท่าเดิม เร็วกว่ามาก)
const stNyOff = new Map();
function stNyMinutes(ms) {
  const hk = Math.floor(ms / 3600000);
  let off = stNyOff.get(hk);
  if (off === undefined) {
    const p = stNyFmt.formatToParts(new Date(hk * 3600000));
    const h = Number(p.find((x) => x.type === "hour").value) % 24;
    off = ((h * 60 + Number(p.find((x) => x.type === "minute").value)) - (hk % 24) * 60 + 1440) % 1440;
    if (stNyOff.size > 50000) stNyOff.clear();
    stNyOff.set(hk, off);
  }
  return (Math.floor(ms / 60000) % 1440 + off) % 1440;
}

// "HHMM-HHMM" (เวลา NY) -> bar อยู่ใน session ถ้า start <= เวลาเปิดแท่ง < end (ข้ามเที่ยงคืนได้)
const stSessCache = new Map();   // "HHMM-HHMM" -> [s, e] (แยกสตริงครั้งเดียว ไม่ใช่ทุกแท่ง)
function stIn(sess, m) {
  let r = stSessCache.get(sess);
  if (!r) {
    r = [Number(sess.slice(0, 2)) * 60 + Number(sess.slice(2, 4)), Number(sess.slice(5, 7)) * 60 + Number(sess.slice(7, 9))];
    stSessCache.set(sess, r);
  }
  const [s, e] = r;
  return e > s ? m >= s && m < e : m >= s || m < e;
}

function stFmtVol(v) {
  const a = Math.abs(v), sg = v < 0 ? "-" : "";
  const f = (x) => String(Number(x.toFixed(3)));
  if (a >= 1e9) return `${sg}${f(a / 1e9)}B`;
  if (a >= 1e6) return `${sg}${f(a / 1e6)}M`;
  if (a >= 1e3) return `${sg}${f(a / 1e3)}K`;
  return `${sg}${f(a)}`;
}

function stMedian(vals) {
  const a = vals.filter((x) => Number.isFinite(x)).sort((x, y) => x - y);
  if (!a.length) return NaN;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

// array.binary_search_leftmost / rightmost ของ Pine (อาเรย์เรียงน้อย→มาก)
function stLeftmost(arr, v) {
  let r = -1;
  for (let i = 0; i < arr.length; i++) { if (arr[i] <= v) r = i; else break; }
  const eq = arr.indexOf(v);
  return eq >= 0 ? eq : r;
}
function stRightmost(arr, v) {
  for (let i = arr.length - 1; i >= 0; i--) if (arr[i] === v) return i;
  for (let i = 0; i < arr.length; i++) if (arr[i] > v) return i;
  return arr.length;
}

function stCalc(bars, cfg) {
  const tf = ST_TF_MIN[cfg.__ctx?.tf];
  if (!tf) return { unsupported: true, rows: [], profiles: [], pocs: [], proj: [] };
  const n = bars.length, last = n - 1;
  const nyM = bars.map((b) => stNyMinutes(b.timestamp));
  const small = tf <= 30;
  const S = [
    { title: "New York", show: cfg.showNY, col: cfg.NYcol, activate: true, projCond: false,
      sess: small ? "0930-1601" : "0900-1601", pre: tf <= 5 ? "0630-0931" : tf <= 30 ? "0630-0931" : "0600-1000",
      open: small ? "0930-0931" : "0900-0901", body: small ? "0931-1601" : "0901-1601", close: "1600-1601", post: "1600-2001" },
    { title: "London", show: cfg.showLONDON, col: cfg.LONDONcol, activate: true, projCond: false,
      sess: small ? "0300-1131" : "0300-1101", pre: tf <= 5 ? "0005-0301" : "0000-0301",
      open: "0300-0301", body: small ? "0301-1130" : "0301-1100", close: small ? "1130-1131" : "1100-1101",
      post: tf <= 15 ? "1130-1245" : tf <= 30 ? "1130-1300" : "1100-1300" },
    { title: "Asia", show: cfg.showAS, col: cfg.AScol, activate: false, projCond: true,
      sess: "2000-0501", pre: "1900-2001", open: "2000-2001", body: "2001-0501", close: "0500-0501", post: "0200-0500" },
  ];
  for (const s of S) {
    s.rows = []; s.st = { timE: 0, HIGH: 0, LOW: 0, vol: 0, delta: 0 }; s.preBar = 0;
    s.flag = (key, i) => (i < 0 ? 0 : stIn(s[key], nyM[i]) ? 1 : 0);
    s.proj = { rows: [], hi: [], lo: [], colPlace: -1, maxPlace: 0, index: 0 };
  }
  const profiles = [], pocs = [];
  const calcTime = Math.floor(600 / tf) + 5;
  // ATR(14) แบบ Pine (RMA)
  const atr = new Array(n).fill(NaN);
  let trSum = 0;
  for (let i = 0; i < n; i++) {
    const b = bars[i], pc = i ? bars[i - 1].close : NaN;
    const tr = i ? Math.max(b.high - b.low, Math.abs(b.high - pc), Math.abs(b.low - pc)) : b.high - b.low;
    if (i < 14) { trSum += tr; if (i === 13) atr[i] = trSum / 14; }
    else atr[i] = (atr[i - 1] * 13 + tr) / 14;
  }

  for (let i = 0; i < n; i++) {
    const b = bars[i];
    // ---------- newObject ----------
    for (const s of S) {
      if (!s.show) continue;
      const t = s.flag("sess", i), t1 = s.flag("sess", i - 1), st = s.st;
      if (t > t1) {
        st.timE = i; st.HIGH = b.high; st.LOW = b.low; st.vol = b.volume || 0;
        st.delta = Math.sign(b.close - b.open) === -1 ? -(b.volume || 0) : (b.volume || 0);
        s.rows.push({ left: i, right: i, top: st.HIGH, bottom: st.LOW, label: { x: i, y: st.HIGH, text: s.title }, pre: null, post: null });
      }
      if (t > 0 && t === t1 && s.rows.length) {
        st.HIGH = Math.max(b.high, st.HIGH); st.vol += b.volume || 0;
        st.LOW = Math.min(b.low, st.LOW);
        st.delta += Math.sign(b.close - b.open) === -1 ? -(b.volume || 0) : (b.volume || 0);
        const r = s.rows[s.rows.length - 1];
        r.top = st.HIGH; r.right = i; r.bottom = st.LOW;
        const fin = (r.top - r.bottom) / ((r.top + r.bottom) / 2) * 100;
        r.label = { x: Math.trunc((st.timE + i) / 2), y: st.HIGH,
          text: `${s.title}\nRange: ${fin.toFixed(2)}%\nVol: ${stFmtVol(st.vol)}\n∆: ${stFmtVol(st.delta)}` };
      }
    }
    // ---------- preSessionDraw ----------
    for (const s of S) {
      if (!cfg.prep || !s.show || !s.activate || !s.rows.length) continue;
      const r = s.rows[s.rows.length - 1];
      s.preBar = s.flag("pre", i - 1) < 1 && s.flag("pre", i) > 0 ? i : s.preBar === 0 ? i : s.preBar;
      if (s.flag("open", i - 1) < 1 && s.flag("open", i) > 0) {
        r.pre = { left: s.preBar, right: i, top: b.high, bottom: b.low, label: { x: i, y: b.high } };
      }
      if (s.flag("body", i) === 1 && r.pre) { r.pre.top = r.top; r.pre.bottom = r.bottom; r.pre.label.y = r.top; }
    }
    // ---------- postSessionDraw ----------
    for (const s of S) {
      if (!s.show || !s.rows.length) continue;
      const r = s.rows[s.rows.length - 1];
      if (s.flag("close", i - 1) < 1 && s.flag("close", i) > 0) {
        if (cfg.profileType !== "None") profiles.push(stProfile(r, i, bars, tf, cfg, s.col, pocs));
        if (s.activate && cfg.posp) r.post = { left: i, right: i, top: b.high, bottom: b.low, label: { x: i, y: b.high } };
      }
      if (s.activate && s.flag("post", i) > 0 && r.pre && r.post) {
        const mx = Math.max(b.high, r.top), mn = Math.min(b.low, r.bottom);
        r.post.label.y = mx; r.post.top = mx; r.post.right = i; r.post.bottom = mn;
        r.pre.top = mx; r.pre.bottom = mn; r.bottom = mn; r.top = mx; r.label.y = mx; r.pre.label.y = mx;
      }
    }
    // ---------- collectData (Forecast) ----------
    if (cfg.proj !== "None") {
      for (const s of S) {
        const p = s.proj, c1 = s.flag("body", i), c2 = s.flag("body", i - 1);
        if (c1 === 1) {
          p.colPlace += 1;
          p.maxPlace = Math.max(p.colPlace, p.maxPlace);
          if (c2 === 0) { p.rows.push(new Array(calcTime).fill(NaN)); p.hi.push(new Array(calcTime).fill(NaN)); p.lo.push(new Array(calcTime).fill(NaN)); p.index = i; }
          if (p.rows.length && p.colPlace < calcTime && i > 0) {
            const k = p.rows.length - 1, pc = bars[i - 1].close, oc = Math.max(b.open, b.close), mc = Math.min(b.open, b.close);
            p.rows[k][p.colPlace] = (b.close - pc) / pc;
            p.hi[k][p.colPlace] = (b.high - oc) / oc;
            p.lo[k][p.colPlace] = (b.low - mc) / mc;
          }
        } else p.colPlace = 0;
      }
    }
    // ---------- lineDelete (naked POC) ----------
    for (const l of pocs) {
      if (!l.touched && b.high >= l.y && b.low <= l.y) l.touched = true;
      if (!l.touched) l.x2 = i;
    }
  }

  // ---------- Forecast ณ แท่งล่าสุด ----------
  const proj = [];
  if (cfg.proj !== "None" && n > 1) {
    for (const s of S) {
      const p = s.proj;
      if (s.projCond && stIn("0300-0501", nyM[last])) continue;
      if (!p.rows.length || s.flag("body", last) !== 1) continue;
      const cols = p.maxPlace + 1, start = last - p.index;
      const med = (m, j) => stMedian(m.map((row) => row[j]));
      const out = { col: s.col, boxes: [], wicks: [], line: [] };
      const c1 = bars[last - 1].close;
      if (cfg.proj === "Line") {
        let x = last, y = bars[last].close;
        let ny = c1 * (1 + med(p.rows, start));
        out.line.push([x, y, x + 1, ny]);
        x += 1; y = ny;
        for (let j = start + 1; j < cols; j++) { ny = y * (1 + med(p.rows, j)); out.line.push([x, y, x + 1, ny]); x += 1; y = ny; }
      } else {
        const addBox = (x1, top, bottom, j, applyAtr) => {
          if (applyAtr) { const sg = Math.sign(bottom - top); if (sg === 1) bottom += atr[last]; else if (sg === -1) bottom -= atr[last]; }
          const mx = Math.max(top, bottom), mn = Math.min(top, bottom);
          out.boxes.push({ x1, x2: x1 + 2, top, bottom });
          out.wicks.push([x1 + 1, mx, mx * (1 + med(p.hi, j))], [x1 + 1, mn, mn * (1 + med(p.lo, j))]);
          return { x2: x1 + 2, bottom };
        };
        let prev = addBox(last, c1, c1 * (1 + med(p.rows, start)), start, cfg.use);
        if (start + 1 < cols - 2) {
          for (let j = start + 1; j <= Math.min(start + 26, cols - 1); j++) prev = addBox(prev.x2, prev.bottom, prev.bottom * (1 + med(p.rows, j)), j, true);
        }
      }
      proj.push(out);
    }
  }

  // ---------- ล้างของเก่ากว่า pre-market แรก (ตามต้นฉบับ) ----------
  const pres = S.flatMap((s) => s.rows.filter((r) => r.pre).map((r) => r.pre.left));
  const earliest = pres.length ? Math.min(...pres) : -Infinity;
  const rows = S.flatMap((s) => (s.show ? s.rows.map((r) => ({ ...r, col: s.col })) : [])).filter((r) => r.left >= earliest);
  return {
    rows, profiles: profiles.filter((p) => p.left >= earliest), pocs: pocs.filter((l) => l.x1 >= earliest), proj,
    times: bars.map((b) => b.timestamp),
  };
}

function stProfile(r, i, bars, tf, cfg, col, pocs) {
  const calc = (r.top - r.bottom) / 20;
  const level = Array.from({ length: 21 }, (_, k) => r.bottom + calc * k);
  const letters = cfg.profileType === "Letters";
  const lab = new Array(21).fill(""), bsize = new Array(21).fill(0);
  // คาบ 30 นาที (TF ≥ 30 = แท่งละคาบ) ตั้งแต่ต้น session ถึงแท่งปัจจุบัน
  const cols = [];
  for (let k = r.left; k <= i; k++) {
    const key = tf >= 30 ? k : Math.floor(bars[k].timestamp / 1800000);
    const last = cols[cols.length - 1];
    if (last && last.key === key) { last.h = Math.max(last.h, bars[k].high); last.l = Math.min(last.l, bars[k].low); }
    else cols.push({ key, h: bars[k].high, l: bars[k].low });
  }
  cols.forEach((c, ci) => {
    const hiIdx = Math.max(0, Math.min(20, stLeftmost(level, c.h)));
    const loIdx = Math.max(0, Math.min(20, stRightmost(level, c.l)));
    for (let x = Math.min(loIdx, hiIdx); x <= Math.max(loIdx, hiIdx); x++) {
      if (letters) lab[x] += ST_LETTERS[ci % 52];
      else bsize[x] += 1;
    }
  });
  if (letters) for (let k = 0; k <= 20; k++) bsize[k] = lab[k].split(" ").length;
  const mx = Math.max(...bsize);
  let nearest = 1000;
  if (bsize.indexOf(mx) !== bsize.lastIndexOf(mx)) {
    const mid = Math.round(bsize.length / 2);
    for (let k = 0; k <= 20; k++) if (Math.abs(mid - bsize[k]) < nearest && bsize[k] === mx) nearest = k;   // 🔴 quirk ต้นฉบับ
  }
  const start = letters ? 0 : 1;
  const items = [];
  for (let k = start; k <= 20; k++) {
    const isPoc = nearest === 1000 ? bsize[k] === mx : k === nearest;
    const color = isPoc ? "#6929F2" : bsize[k] === 1 ? "#F24968" : letters ? "#ffffff" : col;
    if (isPoc && cfg.poc) {
      const y = letters ? level[k] : (level[k] + level[k - 1]) / 2;
      pocs.push({ x1: r.left, x2: i, y, touched: false });
    }
    items.push({ k, color, top: level[k], bottom: letters ? level[k] : level[k - 1], size: bsize[k], text: lab[k] });
  }
  return { left: r.left, letters, items };
}

function stDraw(ctx, st, h, cfg) {
  if (st.unsupported) {
    ctx.font = "11px -apple-system, 'Segoe UI', Tahoma, sans-serif";
    ctx.fillStyle = "rgba(210,153,34,.9)"; ctx.textBaseline = "top";
    ctx.fillText("Sessions/TPO: ใช้ได้กับ TF M1–H4", 8, h.height - 18);
    return;
  }
  const font = "10px -apple-system, 'Segoe UI', Tahoma, sans-serif";
  const vis = (a, b) => b >= h.from - 2 && a <= h.to + 2;
  const box = (x1, x2, top, bottom, fill, stroke, dashed) => {
    const X1 = h.x(x1), X2 = h.x(x2), Y1 = h.y(top), Y2 = h.y(bottom);
    if (fill && !cfg.removeBG) { ctx.fillStyle = fill; ctx.fillRect(X1, Math.min(Y1, Y2), X2 - X1, Math.abs(Y2 - Y1)); }
    if (stroke && !cfg.removeBor) {
      ctx.save(); if (dashed) ctx.setLineDash([4, 3]);
      ctx.strokeStyle = stroke; ctx.lineWidth = 1; ctx.strokeRect(X1 + 0.5, Math.min(Y1, Y2) + 0.5, X2 - X1, Math.abs(Y2 - Y1));
      ctx.restore();
    }
  };
  const text = (x, y, s, color, align = "center", base = "bottom") => {
    ctx.font = font; ctx.fillStyle = color; ctx.textAlign = align; ctx.textBaseline = base;
    const lines = s.split("\n");
    lines.forEach((ln, k) => ctx.fillText(ln, h.x(x), h.y(y) - 3 - (lines.length - 1 - k) * 12));
  };
  for (const r of st.rows) {
    const right = Math.max(r.right, r.post?.right ?? r.right);
    if (!vis(r.pre?.left ?? r.left, right)) continue;
    box(r.left, r.right, r.top, r.bottom, pineColor(r.col, 90), r.col, false);
    if (r.pre) { box(r.pre.left, r.pre.right, r.pre.top, r.pre.bottom, pineColor(r.col, 90), r.col, true); text(r.pre.label.x, r.pre.label.y, "OPEN", "#ffffff"); }
    if (r.post) { box(r.post.left, r.post.right, r.post.top, r.post.bottom, pineColor(r.col, 90), r.col, true); text(r.post.label.x, r.post.label.y, "CLOSE", "#ffffff"); }
    text(r.label.x, r.label.y, r.label.text, r.col);
  }
  for (const p of st.profiles) {
    if (!vis(p.left, p.left + 60)) continue;
    for (const it of p.items) {
      if (p.letters) {
        ctx.font = "10px Menlo, Consolas, monospace"; ctx.fillStyle = it.color; ctx.textAlign = "left"; ctx.textBaseline = "middle";
        ctx.fillText(it.text, h.x(p.left), h.y(it.top));
      } else {
        box(p.left, p.left + it.size * cfg.mult, it.top, it.bottom, pineColor(it.color, 80), pineColor(it.color, 80), false);
      }
    }
  }
  ctx.strokeStyle = pineColor("#ff5252", 60); ctx.lineWidth = 2;
  for (const l of st.pocs) {
    if (!vis(l.x1, l.x2)) continue;
    ctx.beginPath(); ctx.moveTo(h.x(l.x1), h.y(l.y)); ctx.lineTo(h.x(l.x2), h.y(l.y)); ctx.stroke();
  }
  for (const p of st.proj) {
    ctx.lineWidth = 1;
    for (const b of p.boxes) box(b.x1, b.x2, b.top, b.bottom, pineColor(p.col, 80), p.col, false);
    ctx.strokeStyle = p.col;
    for (const [x, y1, y2] of p.wicks) { ctx.beginPath(); ctx.moveTo(h.x(x), h.y(y1)); ctx.lineTo(h.x(x), h.y(y2)); ctx.stroke(); }
    if (p.line.length) {
      ctx.save(); ctx.setLineDash([2, 3]); ctx.beginPath();
      for (const [x1, y1, x2, y2] of p.line) { ctx.moveTo(h.x(x1), h.y(y1)); ctx.lineTo(h.x(x2), h.y(y2)); }
      ctx.stroke(); ctx.restore();
    }
  }
}

const ST_DEF = {
  name: "sessions_tpo",
  title: "Market Sessions & TPO",
  inputs: [
    { key: "proj", label: "Show Projection", type: "select", default: "Bars", options: ["Bars", "Line", "None"] },
    { key: "profileType", label: "Profile Type", type: "select", default: "Bars", options: ["Letters", "Bars", "None"] },
    { key: "mult", label: "Profile Bar Multiplier", type: "int", default: 1, min: 1 },
    { key: "use", label: "Use ATR in Projection", type: "bool", default: true },
    { key: "removeBor", label: "Remove Box Border Color", type: "bool", default: false },
    { key: "removeBG", label: "Remove Box BG Color", type: "bool", default: false },
    { key: "prep", label: "Show Pre-Market", type: "bool", default: true },
    { key: "posp", label: "Show Post-Market", type: "bool", default: true },
    { key: "poc", label: "Show Naked POCs", type: "bool", default: true },
    { key: "showNY", label: "New York", type: "bool", default: true, group: "New York" },
    { key: "NYcol", label: "New York Color", type: "color", default: "#6929F2", group: "New York" },
    { key: "showLONDON", label: "London", type: "bool", default: true, group: "London" },
    { key: "LONDONcol", label: "London Color", type: "color", default: "#F24968", group: "London" },
    { key: "showAS", label: "Asia", type: "bool", default: true, group: "Asia" },
    { key: "AScol", label: "Asia Color", type: "color", default: "#39FF14", group: "Asia" },
  ],
  calc: stCalc,
  draw: stDraw,
};

if (typeof module !== "undefined") module.exports = { stCalc, stIn, stNyMinutes, stLeftmost, stRightmost, stFmtVol, ST_DEF };
else defineIndicator(ST_DEF);
