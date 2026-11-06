// "Dynamic Liquidity Zones" (Pine v6, MPL-2.0) — แปลงเป็น JS สำหรับ Mee Terminal
// ต้นฉบับ: ~/Desktop/Dynamic Liquidity Zones, Liquidity Zones.rtf (223 บรรทัด, 11 inputs)
// ตรรกะตามต้นฉบับทีละขั้น:
//   pivot high/low (left/right) -> เทียบกับ pivot เก่าล่าสุด ≤50 ตัว (ใหม่→เก่า) ตัวแรกที่ห่าง ≤ threshold% = โซน EQH/EQL
//   โซนยืดขวาทุกแท่งจนถูก sweep (high > top / low < bottom ตั้งแต่แท่งหลังสร้าง)
//   label รวมกลุ่มโซนที่ห่างกัน ≤ threshold*3 เป็น "Nx EQH (vol)"
//   จำกัด activeZones ≤ maxZones (โซนที่หลุดจากการติดตามค้างรูปสุดท้ายไว้ เหมือน Pine)
//   max_boxes_count / max_labels_count = 500 (ของเก่าสุดถูกลบก่อน เหมือน TradingView)
// ไม่ได้แปลง: - (ต้นฉบับไม่มี table/dashboard)
// ข้อควรรู้: volume = tick volume ของ MT5; คำนวณจากแท่งที่โหลดอยู่ในกราฟ (TV คำนวณจากประวัติทั้งหมด)
"use strict";

const LZ_MAX_BOXES = 500;
const LZ_MAX_LABELS = 500;
const LZ_FG = "#d1d4dc";   // chart.fg_color ของ TV ธีมมืด

// ta.pivothigh / ta.pivotlow: ค่าที่ center ต้องมากกว่าฝั่งซ้าย (strict) และไม่น้อยกว่าฝั่งขวา
// 🔴 กติกาเท่ากันยังไม่ได้เทียบกับ TradingView จริง — เช็คตอน parity test
function lzPivot(bars, i, left, right, isHigh) {
  const c = i - right;
  if (c - left < 0) return null;
  const v = isHigh ? bars[c].high : bars[c].low;
  for (let k = 1; k <= left; k++) {
    const o = isHigh ? bars[c - k].high : bars[c - k].low;
    if (isHigh ? o >= v : o <= v) return null;
  }
  for (let k = 1; k <= right; k++) {
    const o = isHigh ? bars[c + k].high : bars[c + k].low;
    if (isHigh ? o > v : o < v) return null;
  }
  return v;
}

function lzFormatVol(v) {
  const one = (x) => { const s = x.toFixed(1); return s.endsWith(".0") ? s.slice(0, -2) : s; };
  if (v >= 1e6) return `${one(v / 1e6)}M`;
  if (v >= 1000) return `${one(v / 1000)}K`;
  return String(Math.round(v));
}

function lzCalc(bars, cfg) {
  const { leftLen, rightLen, thresholdPct, maxZones, showVolume, deleteOnSweep } = cfg;
  const zones = [];          // ทุกโซนที่เคยสร้าง (รวมที่หลุดการติดตาม) เพื่อวาด
  const active = [];         // เทียบเท่า activeZones ของ Pine
  const hist = { high: [], low: [] };
  let labelSerial = 0;
  const newLabel = () => ++labelSerial;

  for (let i = 0; i < bars.length; i++) {
    for (const isHigh of [true, false]) {
      const p = lzPivot(bars, i, leftLen, rightLen, isHigh);
      if (p == null) continue;
      const pivotIdx = i - rightLen;
      const vol = bars[pivotIdx].volume || 0;
      const list = hist[isHigh ? "high" : "low"];
      for (const prev of list) {
        const diff = Math.abs(p - prev.price) / prev.price * 100;
        if (diff <= thresholdPct) {
          const top = Math.max(p, prev.price), bottom = Math.min(p, prev.price);
          const z = {
            isHigh, left: prev.idx, right: i, top, bottom, mid: (top + bottom) / 2,
            sweepLevel: isHigh ? top : bottom, totalVol: prev.vol + vol, createdIdx: i,
            swept: false, deleted: false, text: "",
            p1: { idx: prev.idx, price: prev.price, vol: prev.vol }, p2: { idx: pivotIdx, price: p, vol },
            showVol: showVolume, labelIds: [],
          };
          // ลำดับการสร้าง label ตาม Pine: lbl, b1, b2, (v1, v2)
          z.labelIds.push(newLabel(), newLabel(), newLabel());
          if (showVolume) z.labelIds.push(newLabel(), newLabel());
          z.boxId = zones.length + 1;
          zones.push(z);
          active.push(z);
          break;
        }
      }
      list.unshift({ price: p, idx: pivotIdx, vol });
      if (list.length > 50) list.pop();
    }

    // --- Manage Active Zones ---
    if (active.length) {
      const b = bars[i];
      for (let k = active.length - 1; k >= 0; k--) {
        const z = active[k];
        z.right = i;
        if (i > z.createdIdx && (z.isHigh ? b.high > z.sweepLevel : b.low < z.sweepLevel)) {
          z.swept = true;
          z.sweptIdx = i;
          if (deleteOnSweep) z.deleted = true;
          else z.text = `Swept ${z.isHigh ? "EQH" : "EQL"}${showVolume ? ` (${lzFormatVol(z.totalVol)})` : ""}`;
          active.splice(k, 1);
        }
      }
      while (active.length > maxZones) active.shift();
      // f_consolidateLabels
      for (const z of active) z.text = "";
      const done = new Set();
      for (let a = 0; a < active.length; a++) {
        if (done.has(a)) continue;
        const base = active[a];
        done.add(a);
        let vol = base.totalVol, count = 1;
        for (let c = a + 1; c < active.length; c++) {
          if (done.has(c)) continue;
          const comp = active[c];
          if (base.isHigh === comp.isHigh && Math.abs(base.sweepLevel - comp.sweepLevel) / base.sweepLevel * 100 <= thresholdPct * 3) {
            vol += comp.totalVol; count++; done.add(c);
          }
        }
        base.text = `${count > 1 ? `${count}x ` : ""}${base.isHigh ? "EQH" : "EQL"}${showVolume ? ` (${lzFormatVol(vol)})` : ""}`;
      }
    }
  }
  // TV เก็บ object ที่ยังอยู่ได้ไม่เกิน max_*_count — ตัวเก่าสุดถูกลบก่อน (ที่ถูก delete ไปแล้วไม่นับ)
  const visibleZones = zones.filter((z) => !z.deleted);
  const boxCut = visibleZones.length > LZ_MAX_BOXES ? visibleZones[visibleZones.length - LZ_MAX_BOXES - 1].boxId : 0;
  const serials = visibleZones.flatMap((z) => z.labelIds);
  const labelCut = serials.length > LZ_MAX_LABELS ? serials[serials.length - LZ_MAX_LABELS - 1] : 0;
  // เหตุการณ์ ณ แท่งสุดท้าย (ต้นฉบับไม่มี alertcondition — เพิ่มเองสำหรับ Telegram)
  const last = bars.length - 1;
  const events = { new_eqh: null, new_eql: null, swept_eqh: null, swept_eql: null };
  for (const z of zones) {
    if (z.createdIdx === last) events[z.isHigh ? "new_eqh" : "new_eql"] = { top: z.top, bot: z.bottom, vol: z.totalVol };
    if (z.swept && z.sweptIdx === last) events[z.isHigh ? "swept_eqh" : "swept_eql"] = { top: z.top, bot: z.bottom, vol: z.totalVol };
  }
  return { zones: visibleZones, boxCut, labelCut, events };
}

function lzDraw(ctx, st, h, cfg) {
  const font = "11px -apple-system, 'Segoe UI', Tahoma, sans-serif";
  ctx.font = font;
  for (const z of st.zones) {
    if (z.right < h.from - 1 || z.left > h.to + 1) continue;
    const col = z.isHigh ? cfg.bearColor : cfg.bullColor;
    const x1 = h.x(z.left), x2 = h.x(z.right);
    const yt = h.y(z.top), yb = h.y(z.bottom), ym = h.y(z.mid);
    const lblOn = (n) => z.labelIds[n] > st.labelCut;
    if (z.boxId > st.boxCut) {
      ctx.fillStyle = z.swept ? pineColor(LZ_FG, 95) : pineColor(col, cfg.zoneTransp);
      ctx.strokeStyle = z.swept ? pineColor(LZ_FG, 80) : col;
      ctx.lineWidth = 1;
      ctx.fillRect(x1, yt, x2 - x1, Math.max(1, yb - yt));
      ctx.strokeRect(x1 + 0.5, yt + 0.5, x2 - x1, Math.max(1, yb - yt));
    }
    if (cfg.showMidline) {
      ctx.save();
      ctx.setLineDash([4, 3]);
      ctx.strokeStyle = z.swept ? pineColor(LZ_FG, 80) : cfg.midlineColor;
      ctx.beginPath(); ctx.moveTo(x1, ym); ctx.lineTo(x2, ym); ctx.stroke();
      ctx.restore();
    }
    // จุดวงกลมที่ pivot ทั้งสอง (style_circle)
    for (const [n, p] of [[1, z.p1], [2, z.p2]]) {
      if (!lblOn(n)) continue;
      ctx.fillStyle = z.swept ? pineColor(LZ_FG, 85) : col;
      ctx.beginPath(); ctx.arc(h.x(p.idx), h.y(p.price), 4, 0, Math.PI * 2); ctx.fill();
    }
    // volume ที่ pivot (EQH อยู่เหนือจุด, EQL อยู่ใต้จุด) — swept แล้วต้นฉบับลบข้อความ
    if (z.showVol && !z.swept) {
      ctx.fillStyle = col;
      ctx.textAlign = "center";
      ctx.textBaseline = z.isHigh ? "bottom" : "top";
      for (const [n, p] of [[3, z.p1], [4, z.p2]]) {
        if (!lblOn(n)) continue;
        ctx.fillText(lzFormatVol(p.vol), h.x(p.idx), h.y(p.price) + (z.isHigh ? -7 : 7));
      }
    }
    // ข้อความโซน ชิดขวาของโซน (style_label_left)
    if (z.text && lblOn(0)) {
      ctx.fillStyle = z.swept ? pineColor(LZ_FG, 75) : col;
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText(z.text, x2 + 6, ym);
    }
  }
}

const LZ_DEF = {
  name: "liquidity_zones",
  title: "Liquidity Zones",
  // ต้นฉบับไม่มี alertcondition — เพิ่มเอง
  alerts: {
    new_eqh: "New EQH zone (เพิ่มเอง)",
    new_eql: "New EQL zone (เพิ่มเอง)",
    swept_eqh: "EQH swept (เพิ่มเอง)",
    swept_eql: "EQL swept (เพิ่มเอง)",
  },
  inputs: [
    { key: "leftLen", label: "Pivot Left Length", type: "int", default: 8, min: 1, group: "Liquidity Detection", tooltip: "Number of bars to the left required for a pivot." },
    { key: "rightLen", label: "Pivot Right Length", type: "int", default: 3, min: 1, group: "Liquidity Detection", tooltip: "Number of bars to the right required for a pivot." },
    { key: "thresholdPct", label: "Equality Threshold (%)", type: "float", default: 0.03, min: 0, step: 0.01, group: "Liquidity Detection", tooltip: "Maximum percentage difference to consider two highs/lows 'equal'." },
    { key: "maxZones", label: "Max Active Zones", type: "int", default: 100, min: 1, max: 100, group: "Liquidity Detection", tooltip: "Maximum number of active (unswept) liquidity lines to track." },
    { key: "bullColor", label: "Bullish Zone Color", type: "color", default: "#089981", group: "Visuals" },
    { key: "bearColor", label: "Bearish Zone Color", type: "color", default: "#f23645", group: "Visuals" },
    { key: "zoneTransp", label: "Zone Transparency", type: "int", default: 85, min: 0, max: 100, group: "Visuals" },
    { key: "showMidline", label: "Show Midline", type: "bool", default: false, group: "Visuals" },
    { key: "midlineColor", label: "Midline Color", type: "color", default: "#787b86", group: "Visuals" },
    { key: "showVolume", label: "Show Volume", type: "bool", default: true, group: "Visuals" },
    { key: "deleteOnSweep", label: "Delete on Sweep", type: "bool", default: false, group: "Visuals" },
  ],
  calc: lzCalc,
  draw: lzDraw,
};

if (typeof module !== "undefined") module.exports = { lzCalc, lzPivot, lzFormatVol, LZ_DEF };
else defineIndicator(LZ_DEF);
