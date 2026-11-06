// Mee Terminal — Order flow จาก Binance futures (ตัวเก็บ = flow.py / pm2 wt-flow) ใช้กับ BTC/ETH บนกราฟ Exness
// Delta ต่อแท่ง, CVD, Open Interest (หน้าต่างล่าง) + Volume Profile ซื้อ/ขาย และจุดล้างพอร์ต (บนกราฟราคา)
// เปิดจากหมวด "📊 Order Flow" ในหน้าต่างอินดิเคเตอร์ — ค่าตั้งเก็บร่วมกับ wt.basic
"use strict";

const FLOW = { symbols: ["BTCUSDT", "ETHUSDT"], cache: new Map(), ver: 0, warned: new Set(), timer: null };
const FLOW_TF_SEC = { M1: 60, M5: 300, M15: 900, M30: 1800, H1: 3600, H4: 14400, D1: 86400, W1: 604800, MN1: 2678400 };
const FLOW_UP = "#26a69a", FLOW_DN = "#ef5350";

// BTCUSDm / BTCUSD / BTCUSDc -> BTCUSDT
function flowSym(sym) {
  const s = String(sym || "").toUpperCase().replace(/[^A-Z]/g, "");
  const m = /^(BTC|ETH)USD/.exec(s);
  const b = m ? `${m[1]}USDT` : null;
  return b && FLOW.symbols.includes(b) ? b : null;
}

function flowKeysOn() {
  const prefs = basicPrefs();
  return BASIC_INDICATORS.filter((b) => b.cat === "flow" && prefs[b.key]?.on && !prefs[b.key]?.hidden);
}

function flowEntry(panel) {
  const bs = flowSym(panel.symbol);
  if (!bs) return null;
  const k = `${bs}|${panel.tf}`;
  if (!FLOW.cache.has(k)) FLOW.cache.set(k, { bs, tf: panel.tf, rows: new Map(), from: null, profile: null, profKey: "", liq: [], liqAt: 0, busy: false });
  return FLOW.cache.get(k);
}

// ---------- ดึงข้อมูล ----------
async function flowGet(path, params) {
  const r = await api(`/api/flow/${path}?${new URLSearchParams(params)}`);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.detail || `HTTP ${r.status}`);
  return j;
}

async function flowSync(panel, force = false) {
  const on = flowKeysOn();
  if (!on.length || !panel.chart) return;
  const e = flowEntry(panel);
  if (!e) {
    if (!FLOW.warned.has(panel.symbol)) { FLOW.warned.add(panel.symbol); toast(`Order flow มีเฉพาะ ${FLOW.symbols.map((s) => s.replace("USDT", "")).join(" / ")} (ข้อมูลจาก Binance)`, false, 5000); }
    return;
  }
  if (e.busy) return;
  if (panel.chart.getSymbol()?.ticker !== panel.symbol) return;   // เพิ่งเปลี่ยน symbol: แท่งยังเป็นของตัวเก่า
  const bars = panel.chart.getDataList();
  if (!bars.length) return;
  const tfs = FLOW_TF_SEC[panel.tf] || 60;
  const first = Math.floor(bars[0].timestamp / 1000), last = Math.floor(bars[bars.length - 1].timestamp / 1000);
  e.busy = true;
  let changed = false;
  try {
    // แท่ง: ครั้งแรก/เลื่อนย้อนหลัง = ทั้งช่วง, ไม่งั้นแค่ 3 แท่งท้าย (แท่งปัจจุบันยังวิ่ง)
    const full = e.from == null || first < e.from || e.to == null || e.to < last - 3 * tfs;
    const frm = full ? first : last - 2 * tfs;
    const j = await flowGet("bars", { symbol: e.bs, tf: panel.tf, frm, to: last + tfs });
    for (const r of j.bars) e.rows.set(r.t, r);
    e.from = full ? first : Math.min(e.from, first);
    e.to = last;
    changed = true;
    const vr = panel.chart.getVisibleRange();
    const a = bars[Math.max(0, Math.floor(vr.realFrom ?? vr.from))], b = bars[Math.min(bars.length - 1, Math.ceil(vr.realTo ?? vr.to) - 1)];
    if (on.some((s) => s.key === "FVP") && a && b) {
      const rows = basicParams(BASIC_BY_KEY.FVP, basicPrefs().FVP)[0];
      const pk = `${a.timestamp}|${b.timestamp}|${rows}`;
      if (force || pk !== e.profKey || Date.now() - (e.profAt || 0) > 15000) {
        e.profile = await flowGet("profile", { symbol: e.bs, frm: Math.floor(a.timestamp / 1000), to: Math.floor(b.timestamp / 1000) + tfs, rows });
        e.profKey = pk; e.profAt = Date.now();
      }
    }
    if (on.some((s) => s.key === "FLIQ") && (force || Date.now() - e.liqAt > 10000)) {
      e.liq = (await flowGet("liq", { symbol: e.bs, frm: first, to: last + tfs })).liq;
      e.liqAt = Date.now();
    }
  } catch (err) {
    if (!FLOW.warned.has("err")) { FLOW.warned.add("err"); toast(`Order flow: ${err.message}`, false, 6000); }
  } finally {
    e.busy = false;
  }
  if (changed) flowRedraw(panel);
}

// ข้อมูลเปลี่ยน -> ให้ KLineChart คำนวณใหม่ (extendData เปลี่ยน = calc ใหม่)
function flowRedraw(panel) {
  FLOW.ver++;
  for (const spec of flowKeysOn()) panel.chart.overrideIndicator({ name: spec.klc, extendData: { panel: panel.idx, v: FLOW.ver } });
}

function flowStart() {
  if (FLOW.timer) return;
  api("/api/flow/status").then((r) => (r.ok ? r.json() : null)).then((j) => { if (j?.symbols?.length) FLOW.symbols = j.symbols; }).catch(() => {});
  FLOW.timer = setInterval(() => {
    if (document.hidden || !flowKeysOn().length) return;
    state.charts?.panels.forEach((p) => { if (!p.isHidden?.()) flowSync(p); });   // กราฟที่ซ่อน (layout/หน้าอื่นบนมือถือ) ไม่ดึง
  }, 3000);
}

// เรียกจาก applyBasics หลังสร้างอินดิเคเตอร์ใหม่ (เปลี่ยน symbol/TF/เปิดปิด)
function flowApplied(panel) {
  flowStart();
  if (flowKeysOn().length) setTimeout(() => flowSync(panel, true), 300);
}

function flowRowsFor(ind) {
  const p = state.charts?.panels[ind.extendData?.panel ?? -1];
  return p ? flowEntry(p) : null;
}

// ---------- อินดิเคเตอร์ ----------
klinecharts.registerIndicator({
  name: "WT_FDELTA", shortName: "Delta (Binance)", precision: 2,
  figures: [{ key: "delta", title: "Δ: ", type: "bar", baseValue: 0,
    styles: ({ data }) => ({ color: (data.current?.delta ?? 0) >= 0 ? FLOW_UP : FLOW_DN }) }],
  calc: (list, ind) => {
    const e = flowRowsFor(ind);
    return list.map((b) => {
      const r = e?.rows.get(Math.floor(b.timestamp / 1000));
      return r ? { delta: r.buy - r.sell } : {};
    });
  },
});

klinecharts.registerIndicator({
  name: "WT_FCVD", shortName: "CVD (Binance)", precision: 2, calcParams: [24],
  figures: [{ key: "cvd", title: "CVD: ", type: "line" }],
  calc: (list, ind) => {   // สะสม delta ตั้งแต่แท่งแรกที่มีข้อมูล รีเซ็ตทุก N ชม. (นับจาก 00:00 UTC)
    const e = flowRowsFor(ind);
    const per = Math.max(1, ind.calcParams[0]) * 3600;
    let acc = null, seg = null;
    return list.map((b) => {
      const t = Math.floor(b.timestamp / 1000);
      const r = e?.rows.get(t);
      if (!r) return {};
      const s = Math.floor(t / per);
      if (s !== seg) { seg = s; acc = 0; }
      acc += r.buy - r.sell;
      return { cvd: acc };
    });
  },
});

klinecharts.registerIndicator({
  name: "WT_FOI", shortName: "Open Interest (Binance)", precision: 0, shouldFormatBigNumber: true,
  figures: [{ key: "oi", title: "OI: ", type: "line" }],
  calc: (list, ind) => {
    const e = flowRowsFor(ind);
    return list.map((b) => { const r = e?.rows.get(Math.floor(b.timestamp / 1000)); return r?.oi != null ? { oi: r.oi } : {}; });
  },
});

// Volume Profile ช่วงที่มองเห็น: แท่งซื้อ(เขียว)/ขาย(แดง) ชิดขวา + POC + Value Area
klinecharts.registerIndicator({
  name: "WT_FVP", shortName: "Volume Profile (Binance)", series: "price", figures: [], calcParams: [80, 25, 70],
  calc: (list) => list.map(() => ({})),
  draw: ({ ctx, indicator, bounding, yAxis }) => {
    const e = flowRowsFor(indicator);
    const pf = e?.profile;
    if (!pf?.rows?.length) return true;
    const [, widthPct, vaPct] = indicator.calcParams;
    const tot = pf.rows.map((r) => r[1] + r[2]);
    const max = Math.max(...tot);
    const all = tot.reduce((a, v) => a + v, 0);
    if (!max) return true;
    const poc = tot.indexOf(max);
    // value area: ขยายจาก POC ไปฝั่งที่ volume มากกว่า จนครบ vaPct%
    let lo = poc, hi = poc, sum = tot[poc];
    while (sum < all * vaPct / 100 && (lo > 0 || hi < tot.length - 1)) {
      const up = hi < tot.length - 1 ? tot[hi + 1] : -1, dn = lo > 0 ? tot[lo - 1] : -1;
      if (up >= dn) sum += tot[++hi]; else sum += tot[--lo];
    }
    const W = bounding.width * Math.min(60, Math.max(5, widthPct)) / 100;
    const right = bounding.width - 2;
    ctx.save();
    for (let i = 0; i < pf.rows.length; i++) {
      const [price, buy, sell] = pf.rows[i];
      const y1 = yAxis.convertToPixel(price + pf.bin), y2 = yAxis.convertToPixel(price);
      const h = Math.max(1, Math.abs(y2 - y1) - 1), y = Math.min(y1, y2);
      if (y > bounding.height || y + h < 0) continue;
      const wb = (buy / max) * W, ws = (sell / max) * W;
      const inVa = i >= lo && i <= hi;
      ctx.globalAlpha = inVa ? 0.45 : 0.22;
      ctx.fillStyle = FLOW_DN; ctx.fillRect(right - ws, y, ws, h);
      ctx.fillStyle = FLOW_UP; ctx.fillRect(right - ws - wb, y, wb, h);
    }
    ctx.globalAlpha = 0.9;
    ctx.strokeStyle = "#f0a030"; ctx.lineWidth = 1; ctx.setLineDash([4, 3]);
    const py = Math.round(yAxis.convertToPixel(pf.rows[poc][0] + pf.bin / 2)) + 0.5;
    ctx.beginPath(); ctx.moveTo(right - W * 1.1, py); ctx.lineTo(right, py); ctx.stroke();
    ctx.setLineDash([]);
    ctx.font = "10px -apple-system, sans-serif"; ctx.fillStyle = "#f0a030"; ctx.textAlign = "right"; ctx.textBaseline = "bottom";
    ctx.fillText("POC", right - W * 1.1 - 3, py + 4);
    ctx.restore();
    return true;
  },
});

// จุดล้างพอร์ต: วงกลมที่เวลา/ราคา ขนาดตามมูลค่า — แดง = long โดนล้าง (บังคับขาย), เขียว = short โดนล้าง
klinecharts.registerIndicator({
  name: "WT_FLIQ", shortName: "Liquidations (Binance)", series: "price", figures: [], calcParams: [10],
  calc: (list) => list.map(() => ({})),
  draw: ({ ctx, chart, indicator, bounding, xAxis, yAxis }) => {
    const e = flowRowsFor(indicator);
    if (!e?.liq?.length) return true;
    const minUsd = Math.max(0, indicator.calcParams[0]) * 1000;
    const bars = chart.getDataList();
    const per = chart.getPeriod();
    const periodMs = (PERIOD_MS[per?.type] || 6e4) * (per?.span || 1);
    ctx.save();
    ctx.font = "10px -apple-system, sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    for (const l of e.liq) {
      const usd = l.price * l.qty;
      if (usd < minUsd) continue;
      const idx = tsToIndex(bars, l.t * 1000, periodMs);
      if (idx == null) continue;
      const x = xAxis.convertToPixel(idx), y = yAxis.convertToPixel(l.price);
      if (x < 0 || x > bounding.width || y < 0 || y > bounding.height) continue;
      const r = Math.min(18, 3 + Math.sqrt(usd / 5000));
      const col = l.side === "SELL" ? FLOW_DN : FLOW_UP;
      ctx.globalAlpha = 0.35; ctx.fillStyle = col;
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = 0.9; ctx.strokeStyle = col; ctx.lineWidth = 1; ctx.stroke();
      if (usd >= 100000) { ctx.fillStyle = col; ctx.fillText(`$${usd >= 1e6 ? (usd / 1e6).toFixed(1) + "M" : Math.round(usd / 1000) + "k"}`, x, y - r - 6); }
    }
    ctx.restore();
    return true;
  },
});
