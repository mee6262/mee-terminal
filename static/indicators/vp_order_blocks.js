// "Volume Profile Bar-Magnified Order Blocks [JacobMagleby]" (Pine v5, MPL-2.0) — แปลงเป็น JS สำหรับ Mee Terminal
// ต้นฉบับ: ~/Desktop/Volume Profile Bar-Magnified Order Blocks [JacobMagleby].rtf (283 บรรทัด, 7 inputs)
// ตรรกะตามต้นฉบับ:
//   OB = แท่ง [tuning-1] สีหนึ่ง ตามด้วยแท่งสีตรงข้ามทั้งหมดจนถึงแท่งปัจจุบัน (bear: ขึ้น→ลงล้วน / bull: ลง→ขึ้นล้วน)
//   กรอบ = high/low ของแท่ง OB; แบ่ง amountOfBoxes ช่อง; volume ต่อช่อง = volume ของแท่ง TF ย่อย × สัดส่วนที่ทับช่อง
//   TF ย่อย = round(นาทีกราฟ/15) นาที (<1 = 30 วินาที) — worker สร้างจาก tick (30s) หรือ M1
//   volume รวม 0 (ไม่มีข้อมูล TF ย่อย) = ทิ้ง OB เหมือนต้นฉบับ -> นับแสดงเป็นสถานะแทน
//   mitigation: Close/Wick ทะลุ 100/75/50/25% ของกรอบ = ลบ; เก็บได้ไม่เกิน floor(500/amountOfBoxes) บล็อก
//   สร้าง/ลบเฉพาะแท่งที่ปิดแล้ว (barstate.isconfirmed) แท่งล่าสุดแค่ยืดขวา
// 🔴 คงบั๊กต้นฉบับไว้: "25%" ใช้ระยะคงที่ 0.25 หน่วยราคา (ไม่ใช่ 25% ของกรอบ)
// ไม่ได้แปลง: alertcondition 6 ตัว (ทำตอนทำ alert → Telegram)
"use strict";

const VP_MITIGATION = [
  "Close Engulfs 100% Of Order Block", "Close Engulfs 75% Of Order Block",
  "Close Engulfs 50% Of Order Block", "Close Engulfs 25% Of Order Block",
  "Wick Engulfs 100% Of Order Block", "Wick Engulfs 75% Of Order Block",
  "Wick Engulfs 50% Of Order Block", "Wick Engulfs 25% Of Order Block",
];

function vpCondition(bars, i, tuning) {
  // checkObCondition: ลูป i = tuning-1 .. 0 (bars ago)
  const at = (ago) => bars[i - ago];
  let bear = false;
  for (let k = tuning - 1; k >= 0; k--) {
    const b = at(k);
    if (k === tuning - 1) { if (b.close <= b.open) break; }
    else { if (b.close > b.open) break; if (k === 0) bear = true; }
  }
  let bull = false;
  for (let k = tuning - 1; k >= 0; k--) {
    const b = at(k);
    if (k === tuning - 1) { if (b.close >= b.open) break; }
    else { if (b.close < b.open) break; if (k === 0) bull = true; }
  }
  return { bear, bull };
}

function vpVolumes(top, bot, n, ltf) {
  const vols = new Array(n).fill(0);
  const inc = (top - bot) / n;
  for (let g = 0; g < n; g++) {
    const tg = top - inc * g, bg = top - inc * (g + 1);
    for (const [h, l, v] of ltf) {
      if (l <= tg && h >= bg) {
        const reg = (Math.min(h, tg) - Math.max(l, bg)) / (h - l);
        const add = reg * v;
        if (Number.isFinite(add)) vols[g] += add;   // nz(): แท่ง TF ย่อยที่ high==low ได้ 0
      }
    }
  }
  return vols;
}

function vpCalc(bars, cfg) {
  const get = cfg.__ltfGet || vpLtfGet;
  const ctx = cfg.__ctx || {};
  const { tuning, amountOfBoxes: n, mitigationMethod: mm } = cfg;
  const maxBlocks = Math.floor(500 / n);
  const useClose = mm.includes("Close");
  const pct = mm.includes("100%") ? 1 : mm.includes("75%") ? 0.75 : mm.includes("50%") ? 0.5 : null;
  const blocks = [];
  let missing = 0, pending = 0;
  const last = bars.length - 1;
  const allConfirmed = !!cfg.__allConfirmed;   // alert service ส่งมาเฉพาะแท่งที่ปิดแล้ว
  // alertcondition ของต้นฉบับ ณ แท่งสุดท้าย
  // null = ไม่เกิด, { top, bot } = เกิด (โซนที่เกี่ยวข้อง)
  const ev = { new_bull: null, new_bear: null, bull_touch: null, bear_touch: null, bull_rej: null, bear_rej: null };

  for (let i = 0; i < bars.length; i++) {
    const confirmed = allConfirmed || i < last;
    if (i >= tuning && confirmed) {
      const { bear, bull } = vpCondition(bars, i, tuning);
      if (bull || bear) {
        const c = i - (tuning - 1);
        const top = bars[c].high, bot = bars[c].low;
        const ltf = get(ctx, Math.round(bars[c].timestamp / 1000));
        if (ltf === undefined) pending++;
        else if (ltf === null) missing++;
        else {
          const vols = vpVolumes(top, bot, n, ltf);
          if (vols.reduce((a, b) => a + b, 0) !== 0) {
            blocks.push({ dir: bull ? "Bull" : "Bear", top, bot, leftIdx: c, leftTime: bars[c].timestamp, vols });
            if (i === last) ev[bull ? "new_bull" : "new_bear"] = { top, bot };
          }
        }
      }
    }
    const b = bars[i];
    for (let k = blocks.length - 1; k >= 0; k--) {
      const blk = blocks[k];
      blk.rightTime = b.timestamp;
      const hv = Math.max(...blk.vols);
      const inc = (blk.top - blk.bot) / n;
      blk.vols.forEach((v, g) => { if (v === hv) { blk.hTop = blk.top - inc * g; blk.hBot = blk.top - inc * (g + 1); } });
      if (i === last) {
        const bullB = blk.dir === "Bull";
        const z = { top: blk.hTop, bot: blk.hBot };
        const k = bullB ? "bull_touch" : "bear_touch";
        if (b.close <= blk.hTop && b.close >= blk.hBot) ev[k] = ev[k] || z;
        if (confirmed && bullB && b.low <= blk.hBot && b.close >= blk.hBot) ev.bull_rej = ev.bull_rej || z;
        if (confirmed && !bullB && b.high >= blk.hTop && b.close <= blk.hTop) ev.bear_rej = ev.bear_rej || z;
      }
      if (!confirmed) continue;
      const diff = blk.top - blk.bot;
      const start = blk.dir === "Bull" ? blk.top : blk.bot;
      const src = useClose ? b.close : blk.dir === "Bull" ? b.low : b.high;
      let incm = pct == null ? 0.25 : Math.abs(diff * pct);   // 🔴 บั๊กต้นฉบับ: 25% = 0.25 คงที่
      incm *= blk.dir === "Bull" ? -1 : 1;
      const brk = start + incm;
      const broke = (blk.dir === "Bull" && src < brk) || (blk.dir === "Bear" && src > brk);
      if (broke || k < blocks.length - 1 - maxBlocks) blocks.splice(k, 1);
    }
  }
  return { blocks, missing, pending, times: bars.map((x) => x.timestamp), events: ev };
}

// color.from_gradient ของ Pine: ไล่ RGBA เชิงเส้น
function vpGradient(v, lo, hi, cLo, cHi) {
  const t = hi > lo ? Math.min(1, Math.max(0, (v - lo) / (hi - lo))) : 1;
  const rgba = (o) => { const n = parseInt(o.c.slice(1), 16); return [n >> 16, (n >> 8) & 255, n & 255, 1 - o.t / 100]; };
  const a = rgba(cLo), b = rgba(cHi);
  const m = a.map((x, k) => x + (b[k] - x) * t);
  return `rgba(${Math.round(m[0])},${Math.round(m[1])},${Math.round(m[2])},${m[3].toFixed(3)})`;
}

function vpDraw(ctx, st, h, cfg) {
  const ts = st.times;
  // เวลา -> ตำแหน่ง index แบบทศนิยม (xloc.bar_time)
  const idxOf = (t) => {
    let lo = 0, hi = ts.length - 1;
    if (t >= ts[hi]) return hi + (hi > 0 ? (t - ts[hi]) / (ts[hi] - ts[hi - 1]) : 0);
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (ts[mid] <= t) lo = mid; else hi = mid; }
    return lo + (t - ts[lo]) / (ts[hi] - ts[lo]);
  };
  const xOfTime = (t) => { const f = idxOf(t), i = Math.floor(f); return h.x(i) + (h.x(i + 1) - h.x(i)) * (f - i); };
  const n = cfg.amountOfBoxes;
  for (const blk of st.blocks) {
    const ri = idxOf(blk.rightTime);
    if (ri < h.from - 1 || blk.leftIdx > h.to + 1) continue;
    const x1 = xOfTime(blk.leftTime), x2 = xOfTime(blk.rightTime);
    const yT = h.y(blk.top), yB = h.y(blk.bot);
    ctx.fillStyle = pineColor(cfg.obLinefillColor.c, cfg.obLinefillColor.t);
    ctx.fillRect(x1, yT, x2 - x1, yB - yT);
    const hv = Math.max(...blk.vols), lv = Math.min(...blk.vols);
    const ratio = (blk.rightTime - blk.leftTime) / hv;
    const inc = (blk.top - blk.bot) / n;
    ctx.lineWidth = 2;
    for (let g = 0; g < n; g++) {
      const col = vpGradient(blk.vols[g], lv, hv, cfg.obLowVolumeColor, cfg.obHighVolumeColor);
      const gx2 = xOfTime(blk.leftTime + Math.round(blk.vols[g] * ratio));
      const gy1 = h.y(blk.top - inc * g), gy2 = h.y(blk.top - inc * (g + 1));
      ctx.fillStyle = col; ctx.strokeStyle = col;
      ctx.fillRect(x1, gy1, gx2 - x1, gy2 - gy1);
      ctx.strokeRect(x1 + 1, gy1 + 1, Math.max(0, gx2 - x1 - 2), Math.max(0, gy2 - gy1 - 2));
    }
    ctx.strokeStyle = pineColor(cfg.obBorderColor.c, cfg.obBorderColor.t);
    ctx.beginPath(); ctx.moveTo(x1, yT); ctx.lineTo(x2, yT); ctx.moveTo(x1, yB); ctx.lineTo(x2, yB); ctx.stroke();
  }
  const note = [st.pending ? `กำลังโหลด TF ย่อย ${st.pending} แท่ง…` : "", st.missing ? `${st.missing} OB ไม่มีข้อมูล TF ย่อยใน MT5 (ไม่แสดง)${typeof vpLastError !== "undefined" && vpLastError ? ` — ${vpLastError}` : ""}` : ""].filter(Boolean).join(" · ");
  if (note) {
    ctx.font = "11px -apple-system, 'Segoe UI', Tahoma, sans-serif";
    ctx.fillStyle = "rgba(210,153,34,.9)";
    ctx.textAlign = "left"; ctx.textBaseline = "top";
    ctx.fillText(`VP OB: ${note}`, 8, h.height - 18);
  }
}

// ---------- ดึงแท่ง TF ย่อยจาก worker (เบราว์เซอร์) ----------
const vpCache = new Map();      // "acct|sym|tf|t" -> [[h,l,v]] | null
const vpQueue = new Map();      // "acct|sym|tf" -> Set(t)
let vpTimer = 0;
let vpLastError = "";   // ข้อความจาก MT5/HTTP ตอนไม่มีข้อมูล (แสดงบนกราฟช่วยวินิจฉัย)

function vpLtfGet(ctx, t) {
  const key = `${ctx.acct}|${ctx.symbol}|${ctx.tf}`;
  const hit = vpCache.get(`${key}|${t}`);
  if (hit === "loading") return undefined;
  if (hit !== undefined) return hit;
  if (!vpQueue.has(key)) vpQueue.set(key, new Set());
  vpQueue.get(key).add(t);
  clearTimeout(vpTimer);
  vpTimer = setTimeout(vpFlush, 30);
  return undefined;
}

async function vpFlush() {
  const jobs = [...vpQueue.entries()];
  vpQueue.clear();
  for (const [key, set] of jobs) {
    const [acct, symbol, tf] = key.split("|");
    const times = [...set];
    for (const t of times) vpCache.set(`${key}|${t}`, vpCache.get(`${key}|${t}`) ?? "loading");
    for (let i = 0; i < times.length; i += 300) {
      const chunk = times.slice(i, i + 300);
      try {
        const r = await api(`/api/a/${encodeURIComponent(acct)}/ltf?symbol=${encodeURIComponent(symbol)}&tf=${tf}&times=${chunk.join(",")}`);
        const j = r.ok ? await r.json() : null;
        // ตอบผิดพลาด = ถือว่าไม่มีข้อมูล (null) กันยิงซ้ำวน
        for (const t of chunk) vpCache.set(`${key}|${t}`, j ? (j.bars[String(t)] ?? null) : null);
        const e = j ? Object.values(j.errors || {})[0] : `HTTP ${r.status}`;
        if (e) vpLastError = e;
      } catch (_) {
        for (const t of chunk) vpCache.set(`${key}|${t}`, null);
      }
    }
    state.charts?.panels.filter((p) => p.symbol === symbol && p.tf === tf).forEach((p) => p.applyIndicators());
  }
}

const VP_DEF = {
  name: "vp_order_blocks",
  title: "VP Order Blocks",
  // alertcondition 6 ตัวของต้นฉบับ (ชื่อตามต้นฉบับ)
  alerts: {
    bull_touch: "Price Inside Bullish Max Volume Zone",
    bear_touch: "Price Inside Bearish Max Volume Zone",
    bull_rej: "Confirmed Rejection Off Bullish Max Volume Zone",
    bear_rej: "Confirmed Rejection Off Bearish Max Volume Zone",
    new_bull: "New Bullish Order Block",
    new_bear: "New Bearish Order Block",
  },
  inputs: [
    { key: "tuning", label: "Tuning", type: "int", default: 7, min: 1, group: "Main Settings" },
    { key: "amountOfBoxes", label: "Amount Of Grids", type: "int", default: 10, min: 1, max: 500, group: "Main Settings" },
    { key: "mitigationMethod", label: "Mitigation Method", type: "select", default: VP_MITIGATION[0], options: VP_MITIGATION, group: "Main Settings" },
    { key: "obHighVolumeColor", label: "High Volume", type: "colort", default: { c: "#ffeb3b", t: 35 }, group: "Color Settings" },
    { key: "obLowVolumeColor", label: "Low Volume", type: "colort", default: { c: "#ff9800", t: 35 }, group: "Color Settings" },
    { key: "obBorderColor", label: "Border", type: "colort", default: { c: "#787b86", t: 85 }, group: "Color Settings" },
    { key: "obLinefillColor", label: "Fill", type: "colort", default: { c: "#787b86", t: 75 }, group: "Color Settings" },
  ],
  calc: vpCalc,
  draw: vpDraw,
};

if (typeof module !== "undefined") module.exports = { vpCalc, vpCondition, vpVolumes, vpGradient, VP_DEF };
else defineIndicator(VP_DEF);
