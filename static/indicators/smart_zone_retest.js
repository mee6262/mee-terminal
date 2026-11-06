// "Smart Zone Retest — Rejection & CHoCH Confirmation v2" (Pine v6, MPL-2.0, FXProSystems) — แปลงเป็น JS สำหรับ Mee Terminal
// ต้นฉบับ: SmartZoneRetest_Indicator.txt (1001 บรรทัด)
// ตรรกะตามต้นฉบับทีละขั้น (ทำเฉพาะแท่งปิดแล้ว = barstate.isconfirmed):
//   1) swing pivot (Pivot Period Zone) = โครงสร้าง
//   2) จัดการเทรดที่เปิด: SL ก่อน TP ในแท่งเดียวกัน, TP1-3 ปิดบางส่วน, BE หลัง TP1 (ถ้าเปิด)
//   3) โซนรอ: ปิดเกิน SL / หมดอายุ = ทิ้ง; แตะโซน → (CHoCH) → ปิดออกนอก proximal + แท่ง rejection = สัญญาณ
//   4) spike ที่วิ่งอยู่: จบเมื่อแท่งสวนทาง/ครบ Max Impulse → ผ่าน filter = สร้างโซน
//   5-6) ปิดเกิน swing high/low → หา origin pivot ย้อนหลัง → เริ่ม spike candidate
//   วัตถุวาด (box/line/label) จำลอง API ของ Pine + จำกัด 500 ต่อชนิด (เก่าสุดถูกลบก่อน เหมือน TV)
// ไม่ได้แปลง: watermark / ป้าย Telegram ของผู้ขาย (ตัดออก), alert() ข้อความยาว (ใช้ระบบแจ้งเตือน Telegram ของเว็บแทน)
// ข้อควรรู้:
//   CHoCH TF ≠ กราฟ: ดึงแท่ง TF นั้นจาก MT5 (/rates_range) — TF ย่อย = security_lower_tf, TF ใหญ่ = lookahead + [1]
//   ประวัติ TF ย่อยใน MT5 ไม่ถึงต้นกราฟ / ยาวเกิน 50,000 แท่ง → ช่วงต้นกราฟไม่มี CHoCH (state.note แจ้ง)
//   syminfo.currency เดาจากชื่อ symbol (XAUUSDc → USD); format.mintick ใช้ทศนิยมของราคาในกราฟ
//   คำนวณจากแท่งที่โหลดอยู่ในกราฟ (TV คำนวณจากประวัติทั้งหมด) → โซน/เทรดช่วงต้นกราฟอาจต่าง
"use strict";

const SZ_MAX = 500;
const SZ_TF = { M1: 60, M5: 300, M15: 900, M30: 1800, H1: 3600, H4: 14400, D1: 86400 };
const SZ_PINE_TF = { 1: "M1", 5: "M5", 15: "M15", 60: "H1", 240: "H4" };
const SZ_WARM = 200;            // แท่ง TF CHoCH ก่อนต้นกราฟ ให้ swing/trend อุ่นเครื่อง
const SZ_RANGE_MAX = 50000;     // rates_range รับได้ ≤ 60000 แท่ง
const SZ_ENTRY = "#787b86", SZ_SL = "#f23645", SZ_TP = "#089981";

// ตาราง preset: [minSpike, power, pivot, slAtr, rr, wide, age, imp, chochTF(Pine)]
const SZ_PRESETS = {
  "Gold (XAUUSD)": { M5: [3, 3.5, 10, 0.3, 1.3, 1.8, 60, 8, 1], M15: [4, 4.0, 7, 0.3, 1.5, 2.0, 100, 10, 5], H1: [4, 4.5, 5, 0.3, 1.0, 2.2, 150, 12, 15], H4: [5, 5.5, 4, 0.35, 1.0, 2.5, 200, 15, 60], D1: [5, 6.0, 3, 0.4, 1.0, 3.0, 250, 18, 240] },
  "Forex Majors": { M5: [4, 3.0, 10, 0.25, 1.5, 1.5, 80, 10, 1], M15: [4, 3.5, 8, 0.25, 1.5, 1.8, 120, 12, 5], H1: [5, 4.0, 6, 0.3, 1.5, 2.0, 180, 15, 15], H4: [5, 4.5, 4, 0.3, 1.0, 2.2, 220, 18, 60], D1: [5, 5.0, 3, 0.35, 1.0, 2.5, 260, 20, 240] },
  "JPY Pairs": { M5: [4, 3.5, 9, 0.25, 1.3, 1.8, 70, 9, 1], M15: [4, 4.0, 7, 0.3, 1.5, 2.0, 110, 11, 5], H1: [4, 4.5, 5, 0.3, 1.5, 2.2, 160, 14, 15], H4: [5, 5.0, 4, 0.35, 1.0, 2.5, 200, 16, 60], D1: [5, 5.5, 3, 0.4, 1.0, 2.8, 250, 18, 240] },
  "Indices": { M5: [3, 4.0, 10, 0.3, 1.3, 2.0, 50, 8, 1], M15: [4, 4.5, 7, 0.35, 1.5, 2.2, 80, 10, 5], H1: [4, 5.0, 5, 0.35, 1.5, 2.5, 130, 12, 15], H4: [5, 5.5, 4, 0.4, 1.0, 3.0, 180, 15, 60], D1: [5, 6.0, 3, 0.45, 1.0, 3.5, 220, 18, 240] },
  "Crypto (BTC/ETH majors)": { M5: [3, 4.5, 10, 0.4, 1.3, 2.2, 50, 8, 1], M15: [4, 5.0, 7, 0.4, 1.5, 2.5, 90, 10, 5], H1: [4, 5.5, 5, 0.45, 1.5, 2.8, 140, 12, 15], H4: [5, 6.0, 4, 0.5, 1.0, 3.2, 190, 15, 60], D1: [5, 6.5, 3, 0.55, 1.0, 3.8, 240, 18, 240] },
};

// ta.pivothigh/low: center > ฝั่งซ้าย (strict), >= ฝั่งขวา — กติกาเดียวกับ liquidity_zones.js
function szPivot(hi, lo, i, len, isHigh) {
  const c = i - len;
  if (c - len < 0) return null;
  const src = isHigh ? hi : lo;
  const v = src[c];
  for (let k = 1; k <= len; k++) { const o = src[c - k]; if (isHigh ? o >= v : o <= v) return null; }
  for (let k = 1; k <= len; k++) { const o = src[c + k]; if (isHigh ? o > v : o < v) return null; }
  return v;
}

// ta.atr = rma(true range) เริ่มด้วย sma ของ len แท่งแรก
function szAtr(bars, len) {
  const out = new Array(bars.length).fill(NaN);
  let sum = 0, prev = NaN;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const tr = i ? Math.max(b.high - b.low, Math.abs(b.high - bars[i - 1].close), Math.abs(b.low - bars[i - 1].close)) : b.high - b.low;
    if (i < len) { sum += tr; if (i === len - 1) prev = sum / len; }
    else prev = (prev * (len - 1) + tr) / len;
    out[i] = prev;
  }
  return out;
}

// f_choch บนชุดแท่งใดก็ได้ → [bull[], bear[]] (1/0 ต่อแท่ง)
function szChoch(series, len) {
  const hi = series.map((b) => b.high), lo = series.map((b) => b.low);
  const bull = new Array(series.length).fill(0), bear = new Array(series.length).fill(0);
  let sh = NaN, sl = NaN, shUsed = true, slUsed = true, trend = 0;
  for (let i = 0; i < series.length; i++) {
    const ph = szPivot(hi, lo, i, len, true), pl = szPivot(hi, lo, i, len, false);
    if (ph != null) { sh = ph; shUsed = false; }
    if (pl != null) { sl = pl; slUsed = false; }
    const c = series[i].close;
    if (!Number.isNaN(sh) && !shUsed && c > sh) { shUsed = true; if (trend === -1) bull[i] = 1; trend = 1; }
    if (!Number.isNaN(sl) && !slUsed && c < sl) { slUsed = true; if (trend === 1) bear[i] = 1; trend = -1; }
  }
  return [bull, bear];
}

// str.tostring(v, "#.##")
function szNum(v, d = 2) { const s = (Math.round(v * 10 ** d) / 10 ** d).toFixed(d); return s.includes(".") ? s.replace(/\.?0+$/, "") : s; }
function szSgn(v) { return (v >= 0 ? "+" : "") + szNum(v); }

function szCalc(bars, cfg) {
  const n = bars.length;
  const st = { boxes: [], lines: [], labels: [], shapes: [], stats: null, note: "", events: { long_sig: null, short_sig: null, long_setup: null, short_setup: null } };
  if (n < 3) return st;

  // ---- TF กราฟ + preset ----
  const tfSec = SZ_TF[cfg.__ctx?.tf] || Math.round(Math.min(...bars.slice(-20).map((b, i, a) => (i ? b.timestamp - a[i - 1].timestamp : Infinity))) / 1000) || 60;
  const bucket = tfSec <= 300 ? "M5" : tfSec <= 900 ? "M15" : tfSec <= 3600 ? "H1" : tfSec <= 14400 ? "H4" : "D1";
  const usePreset = cfg.preset !== "Manual (use inputs below)" && SZ_PRESETS[cfg.preset];
  const p = usePreset ? SZ_PRESETS[cfg.preset][bucket] : null;
  const minSpike = p ? p[0] : cfg.minSpike;
  const movePower = p ? p[1] : cfg.movePower;
  const pivotLen = p ? p[2] : cfg.pivotLen;
  const slThr = p ? p[3] : cfg.slThr;
  const slUnit = p ? "ATR Multiple" : cfg.slUnit;
  const rr = p ? p[4] : cfg.rr;
  const tp1R = p ? p[4] : cfg.tp1R, tp2R = p ? p[4] + 1 : cfg.tp2R, tp3R = p ? p[4] + 2 : cfg.tp3R;
  const maxZoneAtr = p ? p[5] : cfg.maxZoneAtr;
  const maxAge = p ? p[6] : cfg.maxAge;
  const maxImp = p ? p[7] : cfg.maxImp;
  const chochTF = p && cfg.autoChoch ? SZ_PINE_TF[p[8]] : cfg.chochTF;

  const useMulti = cfg.useMulti;
  const pSum = cfg.tp1P + cfg.tp2P + cfg.tp3P;
  const w1 = useMulti ? (pSum > 0 ? cfg.tp1P / pSum : 1) : 1;
  const w2 = useMulti ? (pSum > 0 ? cfg.tp2P / pSum : 0) : 0;
  const w3 = useMulti ? (pSum > 0 ? cfg.tp3P / pSum : 0) : 0;
  const r1 = useMulti ? tp1R : rr, r2 = tp2R, r3 = tp3R;
  const riskAmt = cfg.acctBal * cfg.riskPct / 100;
  const setupMode = cfg.dispMode === "Setup";

  const sym = cfg.__ctx?.symbol || "";
  const m = /^[A-Z]{3}([A-Z]{3})/.exec(sym);
  const ccy = m ? m[1] : "";
  const digits = Math.min(5, Math.max(0, ...bars.slice(-50).map((b) => { const s = String(b.close); return s.includes(".") ? s.split(".")[1].length : 0; })));
  const px = (v) => v.toFixed(digits);
  const money = (v) => szSgn(v) + (ccy ? ` ${ccy}` : "");

  // ---- วัตถุวาดแบบ Pine: สร้างเกินเพดาน → ลบตัวเก่าสุดที่ยังอยู่ ----
  const reg = { box: st.boxes, line: st.lines, label: st.labels };
  const ptr = { box: 0, line: 0, label: 0 }, live = { box: 0, line: 0, label: 0 };
  const mkObj = (kind, o) => {
    o.deleted = false; o.kind = kind;
    reg[kind].push(o); live[kind]++;
    if (live[kind] > SZ_MAX) {
      const arr = reg[kind];
      while (arr[ptr[kind]].deleted) ptr[kind]++;
      arr[ptr[kind]].deleted = true; live[kind]--;
    }
    return o;
  };
  const del = (o) => { if (o && !o.deleted) { o.deleted = true; live[o.kind]--; } };

  // ---- ข้อมูลรายแท่ง ----
  const hi = bars.map((b) => b.high), lo = bars.map((b) => b.low);
  const atr = szAtr(bars, cfg.atrLen);
  const last = n - 1;
  const allConfirmed = !!cfg.__allConfirmed;

  // ---- CHoCH: ดึงแท่ง TF ของ CHoCH จาก MT5 ตรง ๆ (ไม่ประกอบจากแท่งกราฟ) ----
  let bullCh = new Array(n).fill(0), bearCh = new Array(n).fill(0);
  if (cfg.useChoch) {
    const chSec = SZ_TF[chochTF] || tfSec;
    if (chSec === tfSec) [bullCh, bearCh] = szChoch(bars, cfg.chLen);
    else {
      // ต้องมีแท่ง TF CHoCH ที่ปิดแล้วครบถึงปลายแท่งกราฟที่ปิดล่าสุด
      const needTo = Math.round(bars[last].timestamp / 1000) + (allConfirmed ? tfSec : 0);
      let frm = Math.round(bars[0].timestamp / 1000) - SZ_WARM * chSec;
      frm = Math.max(frm, needTo - SZ_RANGE_MAX * chSec);
      const get = cfg.__tfGet || szTfGet;
      const ser = get(cfg.__ctx || {}, chochTF, frm, needTo);
      if (ser === undefined) st.note = `กำลังโหลดแท่ง ${chochTF} สำหรับ CHoCH…`;
      else if (ser === null || !ser.length) st.note = `ดึงแท่ง ${chochTF} ไม่ได้ — CHoCH ยังไม่ทำงาน`;
      else {
        const [sb, ss] = szChoch(ser, cfg.chLen);
        if (chSec < tfSec) {
          // security_lower_tf: CHoCH ใด ๆ ในแท่งย่อยของแท่งกราฟนั้น (array.max)
          let j = 0;
          for (let i = 0; i < n; i++) {
            const t0 = bars[i].timestamp, t1 = Math.min(i < last ? bars[i + 1].timestamp : Infinity, t0 + tfSec * 1000);
            while (j < ser.length && ser[j].timestamp < t0) j++;
            for (let k = j; k < ser.length && ser[k].timestamp < t1; k++) { if (sb[k]) bullCh[i] = 1; if (ss[k]) bearCh[i] = 1; }
          }
        } else {
          // TF ใหญ่ + lookahead + [1]: แท่งแรกของแท่งใหญ่ใหม่ = ผล CHoCH ของแท่งใหญ่ที่เพิ่งปิด
          let j = -1, prev = -1;
          for (let i = 0; i < n; i++) {
            while (j + 1 < ser.length && ser[j + 1].timestamp <= bars[i].timestamp) j++;
            if (i > 0 && j !== prev && j >= 1) { bullCh[i] = sb[j - 1]; bearCh[i] = ss[j - 1]; }
            prev = j;
          }
        }
        if (ser[0].timestamp > bars[0].timestamp) st.note = `CHoCH ${chochTF} เริ่มมีข้อมูลตั้งแต่กลางกราฟ`;
      }
    }
  }

  // ---- state ----
  const zones = [], fin = [], trades = [];
  let cBull = null, cBear = null;
  let swH = NaN, swHIdx = 0, swHUsed = true, swL = NaN, swLIdx = 0, swLUsed = true;
  let nSig = 0, nWin = 0, nLoss = 0, nBE = 0, netR = 0;

  const buffer = (distal, height, a) => !cfg.useSL ? 0
    : slUnit === "% of Price" ? distal * slThr / 100 : slUnit === "ATR Multiple" ? a * slThr : height * slThr;

  const addLvl = (lns, lbs, k, i, y, txt, color, dashed, setup, above) => {
    lns[k] = mkObj("line", { x1: i, x2: i + 1, y, color, dashed, dotted: false, extend: setup });
    lbs[k] = mkObj("label", { x: i + 1, y, text: txt, color, above });
  };
  const tpTxt = (name, dir, entry, price, r, w) => `${name} ${px(price)} | ${szSgn(dir * (price - entry) / entry * 100)}% | ${szNum(r)}R | ${money(w * r * riskAmt)}${useMulti ? ` (${Math.round(w * 100)}%)` : ""}`;
  const mkLevels = (dir, entry, sl, setup, i) => {
    const rk = Math.abs(entry - sl);
    const lns = new Array(5).fill(null), lbs = new Array(5).fill(null);
    addLvl(lns, lbs, 0, i, entry, `Entry ${px(entry)} | Risk ${szNum(riskAmt)}${ccy ? ` ${ccy}` : ""} (${szNum(cfg.riskPct)}%)`, SZ_ENTRY, true, setup, dir === 1);
    addLvl(lns, lbs, 1, i, sl, `SL ${px(sl)} | ${szSgn(dir * (sl - entry) / entry * 100)}% | ${money(-riskAmt)}`, SZ_SL, false, setup, dir === -1);
    if (w1 > 0) { const v = entry + dir * r1 * rk; addLvl(lns, lbs, 2, i, v, tpTxt(useMulti ? "TP1" : "TP", dir, entry, v, r1, w1), SZ_TP, false, setup, dir === 1); }
    if (w2 > 0) { const v = entry + dir * r2 * rk; addLvl(lns, lbs, 3, i, v, tpTxt("TP2", dir, entry, v, r2, w2), SZ_TP, false, setup, dir === 1); }
    if (w3 > 0) { const v = entry + dir * r3 * rk; addLvl(lns, lbs, 4, i, v, tpTxt("TP3", dir, entry, v, r3, w3), SZ_TP, false, setup, dir === 1); }
    return [lns, lbs];
  };
  const delArrays = (lns, lbs) => { (lns || []).forEach(del); (lbs || []).forEach(del); };
  const dropLevels = (z) => { delArrays(z.lns, z.lbs); z.lns = null; z.lbs = null; };
  const delZone = (z) => { if (!z.hidden) { del(z.bx); dropLevels(z); z.hidden = true; } };
  const delTrade = (t) => { if (!t.hidden) { delArrays(t.lns, t.lbs); t.lns = null; t.lbs = null; t.hidden = true; } };
  const clearFinished = () => { fin.forEach(delZone); fin.length = 0; trades.forEach(delTrade); };

  const addZone = (dir, dist, prox, x0, a, i) => {
    const h = Math.abs(prox - dist);
    const buf = buffer(dist, h, a);
    const z = { dir, distal: dist, prox, slp: dir === 1 ? dist - buf : dist + buf, x0, born: i, entered: false, choch: false, hidden: false, lns: null, lbs: null };
    z.bx = mkObj("box", { x1: x0, x2: i, top: Math.max(dist, prox), bot: Math.min(dist, prox), dir });
    if (setupMode && cfg.showEntry) [z.lns, z.lbs] = mkLevels(dir, prox, z.slp, true, i);
    return z;
  };
  const addTrade = (dir, entry, sl, i) => {
    const rk = Math.abs(entry - sl);
    const t = { dir, entry, sl, slCur: sl, risk: rk, t1: entry + dir * r1 * rk, t2: entry + dir * r2 * rk, t3: entry + dir * r3 * rk,
      h1: false, h2: false, h3: false, rem: 1, rR: 0, start: i, active: true, hidden: false, lns: null, lbs: null };
    if (cfg.showEntry) [t.lns, t.lbs] = mkLevels(dir, entry, sl, false, i);
    return t;
  };
  const moveSLtoBE = (t, i) => {
    t.slCur = t.entry;
    if (!t.hidden && t.lns && t.lns[1]) {
      t.lns.push(t.lns[1]); t.lbs.push(t.lbs[1]);
      t.lns[1] = mkObj("line", { x1: i, x2: i + 1, y: t.entry, color: SZ_SL, dashed: false, dotted: true, extend: false });
      t.lbs[1] = mkObj("label", { x: i + 1, y: t.entry, text: `SL → BE ${px(t.entry)} | 0% | ${money(0)}`, color: SZ_SL, above: t.dir === -1 });
    }
  };
  const updLabel = (t, k, txt, done) => {
    if (cfg.showEntry && !t.hidden && t.lbs && t.lbs[k]) {
      t.lbs[k].text = txt;
      if (done) t.lbs[k].color = t.rR > 0.05 ? SZ_TP : t.rR < -0.05 ? SZ_SL : SZ_ENTRY;
    }
  };
  // f_step: ป้อนแท่งเข้า spike → true ถ้ายังวิ่งต่อ
  const step = (c, dir, b) => {
    const dc = dir * (b.close - b.open) > 0;
    c.run = dc ? c.run + 1 : 0;
    c.maxRun = Math.max(c.maxRun, c.run);
    c.ext = dir === 1 ? Math.max(c.ext, b.high) : Math.min(c.ext, b.low);
    if (!c.brkFound && dir * (b.close - c.oOpp) > 0) { c.brkFound = true; c.brkEdge = dir === 1 ? b.low : b.high; }
    return dc;
  };
  const tryZone = (c, dir, a, i) => {
    if (c.maxRun < minSpike) return false;
    const edge = c.brkFound ? c.brkEdge : c.oOpp;
    const prox = dir === 1 ? Math.max(c.oOpp, edge) : Math.min(c.oOpp, edge);
    const zh = Math.abs(prox - c.distal);
    const powerOK = !cfg.useMove || Math.abs(c.ext - c.distal) >= movePower * a;
    const wideOK = !cfg.useWide || zh <= maxZoneAtr * a;
    const tick = 10 ** -digits;
    if (!(powerOK && wideOK && zh > tick)) return false;
    if (cfg.onlyLast && setupMode) { zones.forEach(delZone); clearFinished(); }
    if (zones.length >= cfg.maxZones) delZone(zones.shift());
    zones.push(addZone(dir, c.distal, prox, c.orig, a, i));
    return true;
  };

  for (let i = 0; i < n; i++) {
    const confirmed = allConfirmed || i < last;
    if (!confirmed) continue;
    const b = bars[i], a = atr[i];
    const ph = szPivot(hi, lo, i, pivotLen, true), pl = szPivot(hi, lo, i, pivotLen, false);

    // rejection
    const rng = b.high - b.low, body = Math.abs(b.close - b.open);
    const loW = Math.min(b.open, b.close) - b.low, upW = b.high - Math.max(b.open, b.close);
    const tick = 10 ** -digits;
    const bullPin = rng > 0 && loW >= cfg.pinRatio * Math.max(body, tick) && loW >= 0.5 * rng;
    const bearPin = rng > 0 && upW >= cfg.pinRatio * Math.max(body, tick) && upW >= 0.5 * rng;
    const pb = bars[i - 1];
    const bullEng = !!pb && pb.close < pb.open && b.close > b.open && b.close >= pb.open && b.open <= pb.close;
    const bearEng = !!pb && pb.close > pb.open && b.close < b.open && b.close <= pb.open && b.open >= pb.close;
    const anyPat = !cfg.usePin && !cfg.useEngulf;
    const rejBull = !cfg.useReject || anyPat || (cfg.usePin && bullPin) || (cfg.useEngulf && bullEng);
    const rejBear = !cfg.useReject || anyPat || (cfg.usePin && bearPin) || (cfg.useEngulf && bearEng);

    // 1) โครงสร้าง
    if (ph != null) { swH = ph; swHIdx = i - pivotLen; swHUsed = false; }
    if (pl != null) { swL = pl; swLIdx = i - pivotLen; swLUsed = false; }

    // 2) เทรดที่เปิดอยู่
    for (const t of trades) {
      if (!t.active || i <= t.start) continue;
      const isL = t.dir === 1;
      let closedNow = false;
      if (!t.hidden && t.lns) for (let k = 0; k <= 4; k++) if (t.lns[k]) t.lns[k].x2 = i;
      if (isL ? b.low <= t.slCur : b.high >= t.slCur) {
        const rs = (isL ? t.slCur - t.entry : t.entry - t.slCur) / t.risk;
        const leg = t.rem * rs;
        t.rR += leg; t.rem = 0; closedNow = true;
        updLabel(t, 1, `${rs < -0.01 ? "SL ✘ " : "BE ➜ "}${money(leg * riskAmt)} | Total ${szSgn(t.rR)}R ${money(t.rR * riskAmt)}`, true);
      } else {
        const stages = [[w1, "h1", "t1", r1, 2, useMulti ? "TP1" : "TP"], [w2, "h2", "t2", r2, 3, "TP2"], [w3, "h3", "t3", r3, 4, "TP3"]];
        for (const [w, hk, tk, r, slot, name] of stages) {
          if (w > 0 && !t[hk] && (isL ? b.high >= t[tk] : b.low <= t[tk])) {
            t[hk] = true; t.rem -= w; t.rR += w * r;
            const done = t.rem <= 0.0001;
            if (done) closedNow = true;
            updLabel(t, slot, `${name} ✔ ${money(w * r * riskAmt)}${done ? ` | Total ${szSgn(t.rR)}R ${money(t.rR * riskAmt)}` : ""}`, done);
            if (slot === 2 && useMulti && cfg.beAfterTP1) moveSLtoBE(t, i);
          }
        }
      }
      if (closedNow) {
        t.active = false; netR += t.rR;
        if (t.rR > 0.05) nWin++; else if (t.rR < -0.05) nLoss++; else nBE++;
      }
    }

    // 3) โซนรอ retest
    for (let zi = zones.length - 1; zi >= 0; zi--) {
      const z = zones[zi];
      const isLong = z.dir === 1;
      let res = 0;
      if (isLong ? b.close < z.slp : b.close > z.slp) res = 2;
      else if (i - z.born > maxAge) res = 2;
      else {
        const touchNow = isLong ? b.low <= z.prox : b.high >= z.prox;
        if (touchNow) z.entered = true;
        if (z.entered && (isLong ? bullCh[i] > 0 : bearCh[i] > 0)) z.choch = true;
        const exitOK = isLong ? b.close > z.prox : b.close < z.prox;
        const rejOK = isLong ? rejBull : rejBear;
        const chOK = !cfg.useChoch || z.choch;
        const touchOK = !cfg.useReject || touchNow;
        if (z.entered && exitOK && rejOK && chOK && touchOK) res = 1;
      }
      if (res === 0) { if (!z.hidden) z.bx.x2 = i; }
      else if (res === 2) { delZone(z); zones.splice(zi, 1); }
      else {
        if (cfg.onlyLast) clearFinished();
        const entry = b.close;
        if (!z.hidden) { z.bx.x2 = i; dropLevels(z); }
        const tr = addTrade(z.dir, entry, z.slp, i);
        trades.push(tr); fin.push(z); zones.splice(zi, 1);
        nSig++;
        let cf = "";
        if (cfg.useReject) cf += isLong ? (bullPin ? "PinBar " : "") + (bullEng ? "Engulfing " : "") : (bearPin ? "PinBar " : "") + (bearEng ? "Engulfing " : "");
        if (cfg.useChoch) cf += `CHoCH(${chochTF})`;
        if (!setupMode) st.shapes.push({ i, dir: z.dir, y: isLong ? b.low : b.high });
        if (i === last) st.events[isLong ? "long_sig" : "short_sig"] = { level: entry, kind: `SL ${px(z.slp)} · TP1 ${px(tr.t1)}${cf ? ` · ${cf.trim()}` : ""}` };
      }
    }
    if (fin.length > 200) fin.shift();
    if (trades.length > 200) trades.shift();

    // 4) spike ที่วิ่งอยู่
    if (cBull) {
      const cont = step(cBull, 1, b);
      if (!cont || i - cBull.orig >= maxImp) {
        if (tryZone(cBull, 1, a, i) && i === last) st.events.long_setup = { top: zones[zones.length - 1].bx.top, bot: zones[zones.length - 1].bx.bot };
        cBull = null;
      }
    }
    if (cBear) {
      const cont = step(cBear, -1, b);
      if (!cont || i - cBear.orig >= maxImp) {
        if (tryZone(cBear, -1, a, i) && i === last) st.events.short_setup = { top: zones[zones.length - 1].bx.top, bot: zones[zones.length - 1].bx.bot };
        cBear = null;
      }
    }

    // 5-6) structure break → spike candidate
    for (const dir of [1, -1]) {
      const isB = dir === 1;
      const sw = isB ? swH : swL;
      if (Number.isNaN(sw) || (isB ? swHUsed : swLUsed) || !(isB ? b.close > sw : b.close < sw)) continue;
      if (isB) swHUsed = true; else swLUsed = true;
      if ((isB ? cBull : cBear) || !(isB ? b.close > b.open : b.close < b.open)) continue;
      const nn = Math.min(i - (isB ? swHIdx : swLIdx) - 1, 490);
      let ext = isB ? b.low : b.high, oOff = 0;
      for (let k = 1; k <= nn && i - k >= 0; k++) {
        const v = isB ? bars[i - k].low : bars[i - k].high;
        if (isB ? v < ext : v > ext) { ext = v; oOff = k; }
      }
      if (oOff < 1 || oOff > maxImp) continue;
      const o = bars[i - oOff];
      const c = { orig: i - oOff, distal: ext, oOpp: isB ? o.high : o.low, brkEdge: NaN, brkFound: false, run: 0, maxRun: 0, ext: isB ? o.high : o.low };
      for (let k = oOff - 1; k >= 0; k--) step(c, dir, bars[i - k]);
      if (isB) cBull = c; else cBear = c;
    }
  }

  if (cfg.showStats) {
    const closed = nWin + nLoss + nBE;
    st.stats = { nSig, nWin, nBE, nLoss, wr: closed ? nWin * 100 / closed : 0, netR, netPL: money(netR * riskAmt) };
  }
  st.boxes = st.boxes.filter((o) => !o.deleted);
  st.lines = st.lines.filter((o) => !o.deleted);
  st.labels = st.labels.filter((o) => !o.deleted);
  return st;
}

function szDraw(ctx, st, h, cfg) {
  const lw = cfg.drawW;
  const vis = (x1, x2) => !(x2 < h.from - 1 || x1 > h.to + 1);
  for (const bx of st.boxes) {
    if (!vis(bx.x1, bx.x2)) continue;
    const c = bx.dir === 1 ? cfg.bullClr : cfg.bearClr;
    const x1 = h.x(bx.x1), x2 = h.x(bx.x2), yt = h.y(bx.top), yb = h.y(bx.bot);
    ctx.fillStyle = pineColor(c.c, c.t);
    ctx.fillRect(x1, yt, x2 - x1, Math.max(1, yb - yt));
    ctx.strokeStyle = pineColor(c.c, 70);   // color.new(base, 70) = ตั้งความโปร่งใสใหม่เป็น 70
    ctx.lineWidth = lw;
    ctx.strokeRect(x1, yt, x2 - x1, Math.max(1, yb - yt));
  }
  for (const ln of st.lines) {
    if (!ln.extend && !vis(ln.x1, ln.x2)) continue;
    if (ln.x1 > h.to + 1) continue;
    const y = h.y(ln.y);
    ctx.save();
    ctx.strokeStyle = ln.color; ctx.lineWidth = lw;
    if (ln.dashed) ctx.setLineDash([6, 4]); else if (ln.dotted) ctx.setLineDash([2, 3]);
    ctx.beginPath(); ctx.moveTo(h.x(ln.x1), y); ctx.lineTo(ln.extend ? h.width : h.x(ln.x2), y); ctx.stroke();
    ctx.restore();
  }
  const px = { Small: 10, Normal: 12, Large: 14, Huge: 18 }[cfg.lblSize] || 12;
  const fam = cfg.lblFont === "Monospace" ? "ui-monospace, Menlo, Consolas, monospace" : "-apple-system, 'Segoe UI', Tahoma, sans-serif";
  ctx.font = `${cfg.lblBold ? "bold " : ""}${px}px ${fam}`;
  ctx.textAlign = "left";
  for (const lb of st.labels) {
    if (lb.x < h.from - 200 || lb.x > h.to + 1) continue;
    ctx.fillStyle = lb.color;
    ctx.textBaseline = lb.above ? "bottom" : "top";
    ctx.fillText(lb.text, h.x(lb.x) + 2, h.y(lb.y) + (lb.above ? -2 : 2));
  }
  // plotshape: สามเหลี่ยม + "Long/Short Signal"
  ctx.font = "10px -apple-system, 'Segoe UI', Tahoma, sans-serif";
  ctx.textAlign = "center";
  for (const s of st.shapes) {
    if (s.i < h.from || s.i > h.to) continue;
    const x = h.x(s.i);
    const y = h.y(s.y) + (s.dir === 1 ? 6 : -6);
    const col = s.dir === 1 ? cfg.sigBull : cfg.sigBear;
    ctx.fillStyle = col;
    ctx.beginPath();
    if (s.dir === 1) { ctx.moveTo(x, y); ctx.lineTo(x - 5, y + 8); ctx.lineTo(x + 5, y + 8); }
    else { ctx.moveTo(x, y); ctx.lineTo(x - 5, y - 8); ctx.lineTo(x + 5, y - 8); }
    ctx.fill();
    ctx.textBaseline = s.dir === 1 ? "top" : "bottom";
    ctx.fillText(s.dir === 1 ? "Long Signal" : "Short Signal", x, s.dir === 1 ? y + 10 : y - 10);
  }
  const rows = [];
  if (st.stats) {
    const s = st.stats;
    rows.push(["TRH Stats", ""], ["Signals", String(s.nSig)], ["Wins", String(s.nWin)], ["Break-even", String(s.nBE)], ["Losses", String(s.nLoss)],
      ["Win rate", `${szNum(s.wr)}%`], ["Net R", szSgn(s.netR)], ["Net P/L", s.netPL]);
  }
  if (st.note) rows.push([st.note, ""]);
  if (rows.length) {
    ctx.font = "11px -apple-system, 'Segoe UI', Tahoma, sans-serif";
    ctx.textBaseline = "top";
    const w0 = Math.max(...rows.map((r) => ctx.measureText(r[0]).width)), w1 = Math.max(...rows.map((r) => ctx.measureText(r[1]).width));
    const W = w0 + w1 + 20, x = h.width - W - 70, y0 = 8;
    ctx.fillStyle = "rgba(30,34,45,0.85)";
    ctx.fillRect(x, y0, W, rows.length * 16 + 6);
    rows.forEach(([k, v], r) => {
      ctx.fillStyle = "#d1d4dc"; ctx.textAlign = "left"; ctx.fillText(k, x + 6, y0 + 4 + r * 16);
      ctx.textAlign = "right"; ctx.fillText(v, x + W - 6, y0 + 4 + r * 16);
    });
  }
}

// ---------- เบราว์เซอร์: แคชแท่ง TF ของ CHoCH ----------
// คืน bars | undefined (กำลังโหลดครั้งแรก) | null (ดึงไม่ได้); ข้อมูลเก่าใช้ต่อระหว่างดึงใหม่
const szSeries = new Map();
function szTfGet(ctx, tf, frm, needTo) {
  if (typeof api !== "function" || !ctx.acct || !ctx.symbol) return null;
  const key = `${ctx.acct}|${ctx.symbol}|${tf}`;
  const e = szSeries.get(key);
  const sec = SZ_TF[tf];
  const lastTs = e?.bars?.length ? e.bars[e.bars.length - 1].timestamp / 1000 : -Infinity;
  const stale = !e || frm < e.frm || lastTs + sec <= needTo;   // มีแท่ง TF นี้เปิดใหม่หลังดึงครั้งก่อน
  if (stale && !e?.busy && Date.now() - (e?.at || 0) > 5000) szFetch(key, ctx, tf, Math.min(frm, e?.frm ?? frm), needTo + sec);
  return e?.bars;
}

async function szFetch(key, ctx, tf, frm, to) {
  const prev = szSeries.get(key);
  szSeries.set(key, { ...(prev || {}), busy: true, frm: prev?.frm ?? frm });
  let bars = null;
  try {
    const r = await api(`/api/a/${encodeURIComponent(ctx.acct)}/rates_range?symbol=${encodeURIComponent(ctx.symbol)}&tf=${tf}&frm=${frm}&to=${to}`);
    if (r.ok) bars = (await r.json()).map((x) => ({ timestamp: x[0] * 1000, open: x[1], high: x[2], low: x[3], close: x[4] }));
  } catch (_) { /* null = ดึงไม่ได้ */ }
  szSeries.set(key, { bars: bars ?? prev?.bars ?? null, frm: bars ? frm : prev?.frm ?? frm, at: Date.now(), busy: false });
  state.charts?.panels.filter((p) => p.symbol === ctx.symbol).forEach((p) => p.applyIndicators());
}

const SZ_G = { G0: "INSTRUMENT PRESET", G1: "SPIKE FILTER | MOVEMENT", G2: "POSITION MANAGEMENT", GT: "TAKE PROFIT | MULTI-STAGE", GR: "RISK & BALANCE (hypothetical P/L)",
  GRJ: "ENTRY CONFIRMATION | REJECTION", GCH: "ENTRY CONFIRMATION | CHOCH", G3: "DISPLAY SETTING", G5: "STYLE", G6: "ADVANCED" };

const SZ_DEF = {
  name: "smart_zone_retest",
  title: "Smart Zone Retest",
  desc: "โซน spike + retest (Rejection / CHoCH) พร้อม Entry/SL/TP1-3 · แปลงจาก TradingView (Pine)",
  alerts: {
    long_sig: "TRH Long Signal",
    short_sig: "TRH Short Signal",
    long_setup: "TRH Long Setup (demand zone)",
    short_setup: "TRH Short Setup (supply zone)",
  },
  inputs: [
    { key: "preset", label: "Instrument Preset", type: "select", options: ["Manual (use inputs below)", ...Object.keys(SZ_PRESETS)], default: "Manual (use inputs below)", group: SZ_G.G0,
      tooltip: "Auto-fills spike/pivot/SL(ATR)/RR/TP1-3/wide/age/impulse ตาม TF กราฟ (<=5m, <=15m, <=1h, <=4h, >4h)" },
    { key: "minSpike", label: "Minimum Spike Bars", type: "int", default: 4, min: 1, max: 30, group: SZ_G.G1, tooltip: "Minimum number of CONSECUTIVE same-direction candles inside the impulsive leg." },
    { key: "useMove", label: "Movement Power", type: "bool", default: true, group: SZ_G.G1 },
    { key: "movePower", label: "Movement Power (x ATR)", type: "float", default: 4.5, min: 0.1, step: 0.1, group: SZ_G.G1, tooltip: "Impulse range must be >= this value x ATR." },
    { key: "pivotLen", label: "Pivot Period Zone", type: "int", default: 5, min: 1, max: 50, group: SZ_G.G1 },
    { key: "useSL", label: "Stop-Loss Threshold", type: "bool", default: true, group: SZ_G.G2 },
    { key: "slThr", label: "Stop-Loss Threshold value", type: "float", default: 0.2, min: 0, step: 0.05, group: SZ_G.G2, tooltip: "Buffer beyond the distal edge (unit in ADVANCED)." },
    { key: "rr", label: "Risk-Reward Ratio (single TP)", type: "float", default: 2.0, min: 0.1, step: 0.1, group: SZ_G.G2 },
    { key: "useWide", label: "Wide Zone Filter", type: "bool", default: true, group: SZ_G.G2 },
    { key: "maxZoneAtr", label: "Wide Zone Filter (x ATR)", type: "float", default: 2.5, min: 0.1, step: 0.1, group: SZ_G.G2 },
    { key: "useMulti", label: "Multi-Stage Take Profit", type: "bool", default: true, group: SZ_G.GT },
    { key: "tp1R", label: "TP1 Reward (R)", type: "float", default: 1.0, min: 0.1, step: 0.1, group: SZ_G.GT },
    { key: "tp1P", label: "TP1 Close %", type: "float", default: 40, min: 0, max: 100, step: 5, group: SZ_G.GT },
    { key: "tp2R", label: "TP2 Reward (R)", type: "float", default: 2.0, min: 0.1, step: 0.1, group: SZ_G.GT },
    { key: "tp2P", label: "TP2 Close %", type: "float", default: 30, min: 0, max: 100, step: 5, group: SZ_G.GT },
    { key: "tp3R", label: "TP3 Reward (R)", type: "float", default: 3.0, min: 0.1, step: 0.1, group: SZ_G.GT },
    { key: "tp3P", label: "TP3 Close %", type: "float", default: 30, min: 0, max: 100, step: 5, group: SZ_G.GT },
    { key: "beAfterTP1", label: "Move SL to Break-even after TP1", type: "bool", default: false, group: SZ_G.GT },
    { key: "acctBal", label: "Account Balance", type: "float", default: 10000, min: 1, step: 100, group: SZ_G.GR },
    { key: "riskPct", label: "Risk % per Trade", type: "float", default: 1.0, min: 0.01, max: 100, step: 0.1, group: SZ_G.GR },
    { key: "useReject", label: "Rejection Confirmation", type: "bool", default: true, group: SZ_G.GRJ },
    { key: "usePin", label: "Pin Bar", type: "bool", default: true, group: SZ_G.GRJ },
    { key: "useEngulf", label: "Engulfing", type: "bool", default: true, group: SZ_G.GRJ },
    { key: "pinRatio", label: "Pin Bar: wick >= N x body", type: "float", default: 2.0, min: 0.5, step: 0.25, group: SZ_G.GRJ },
    { key: "useChoch", label: "CHoCH Confirmation", type: "bool", default: false, group: SZ_G.GCH },
    { key: "chochTF", label: "CHoCH Timeframe", type: "select", options: Object.keys(SZ_TF), default: "M15", group: SZ_G.GCH, tooltip: "ต่ำกว่ากราฟ = CHoCH ในแท่งย่อย, สูงกว่ากราฟ = แท่งใหญ่ที่ปิดแล้ว (ดึงแท่งจาก MT5)" },
    { key: "chLen", label: "CHoCH Pivot Length", type: "int", default: 3, min: 1, max: 20, group: SZ_G.GCH },
    { key: "autoChoch", label: "Auto CHoCH Timeframe (from preset)", type: "bool", default: true, group: SZ_G.GCH },
    { key: "dispMode", label: "Display Mode", type: "select", options: ["Signal", "Setup"], default: "Signal", group: SZ_G.G3 },
    { key: "showEntry", label: "Show Entry Levels", type: "bool", default: true, group: SZ_G.G3 },
    { key: "onlyLast", label: "Only Display the Last Position", type: "bool", default: false, group: SZ_G.G3 },
    { key: "drawW", label: "Setup Width Drawing", type: "int", default: 2, min: 1, max: 5, group: SZ_G.G3 },
    { key: "lblSize", label: "Level Label Size", type: "select", options: ["Small", "Normal", "Large", "Huge"], default: "Large", group: SZ_G.G3 },
    { key: "lblFont", label: "Level Label Font", type: "select", options: ["Monospace", "Default"], default: "Monospace", group: SZ_G.G3 },
    { key: "lblBold", label: "Bold Level Labels", type: "bool", default: true, group: SZ_G.G3 },
    { key: "bullClr", label: "Long / Demand Zone", type: "colort", default: { c: "#4caf50", t: 78 }, group: SZ_G.G5 },
    { key: "bearClr", label: "Short / Supply Zone", type: "colort", default: { c: "#f23645", t: 78 }, group: SZ_G.G5 },
    { key: "sigBull", label: "Long Signal", type: "color", default: "#1b8a2f", group: SZ_G.G5 },
    { key: "sigBear", label: "Short Signal", type: "color", default: "#a3151a", group: SZ_G.G5 },
    { key: "atrLen", label: "ATR Length", type: "int", default: 14, min: 1, group: SZ_G.G6 },
    { key: "maxImp", label: "Max Impulse Length (bars)", type: "int", default: 15, min: 3, max: 100, group: SZ_G.G6 },
    { key: "maxAge", label: "Zone Max Age (bars)", type: "int", default: 300, min: 10, group: SZ_G.G6 },
    { key: "maxZones", label: "Max Active Zones", type: "int", default: 30, min: 1, max: 100, group: SZ_G.G6 },
    { key: "slUnit", label: "Stop-Loss Threshold Unit", type: "select", options: ["% of Price", "ATR Multiple", "Zone Height Multiple"], default: "% of Price", group: SZ_G.G6 },
    { key: "showStats", label: "Show Stats Table", type: "bool", default: false, group: SZ_G.G6 },
  ],
  calc: szCalc,
  draw: szDraw,
};

if (typeof module !== "undefined") module.exports = { szCalc, szPivot, szAtr, szChoch, SZ_DEF };
else defineIndicator(SZ_DEF);
