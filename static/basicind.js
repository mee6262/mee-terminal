// Mee Terminal — อินดิเคเตอร์พื้นฐานแบบ MT5 (MA/EMA/BB/SAR/Envelopes/Ichimoku/Alligator + RSI/MACD/Stochastic/CCI/WPR/Momentum/ADX/ATR/StdDev/OBV/AO)
// ใช้ของในตัว KLineChart ที่สูตรตรงกับ MT5, ที่ไม่ตรง/ไม่มีเขียนเอง (ชื่อขึ้นต้น WT_)
// ค่าตั้ง/เปิดปิด เก็บใน prefs "wt.basic" = { KEY: { on, hidden, params } } (sync ทุกเครื่อง)
"use strict";

// ---------- สูตรช่วย ----------
function _sma(vals, n, i) {
  if (i < n - 1) return null;
  let s = 0;
  for (let k = i - n + 1; k <= i; k++) { if (vals[k] == null) return null; s += vals[k]; }
  return s / n;
}
function _smma(vals, n) {   // Smoothed MA แบบ MT5 (ค่าแรก = SMA)
  const out = new Array(vals.length).fill(null);
  let prev = null;
  for (let i = 0; i < vals.length; i++) {
    if (i === n - 1) prev = _sma(vals, n, i);
    else if (i >= n) prev = (prev * (n - 1) + vals[i]) / n;
    out[i] = prev;
  }
  return out;
}
function _hhll(list, n, i) {
  let hh = -Infinity, ll = Infinity;
  for (let k = Math.max(0, i - n + 1); k <= i; k++) { hh = Math.max(hh, list[k].high); ll = Math.min(ll, list[k].low); }
  return [hh, ll];
}

// ---------- ตัวที่เขียนเอง ----------
klinecharts.registerIndicator({
  name: "WT_STOCH", shortName: "Stoch", calcParams: [5, 3, 3], minValue: 0, maxValue: 100,
  figures: [{ key: "k", title: "%K: ", type: "line" }, { key: "d", title: "%D: ", type: "line" }],
  calc: (list, ind) => {   // MT5 Stochastic: %K = Σ(close−LL)/Σ(HH−LL) ช่วง slowing ×100, %D = SMA(%K)
    const [kp, dp, sl] = ind.calcParams;
    const num = [], den = [], k = [];
    list.forEach((b, i) => { const [hh, ll] = _hhll(list, kp, i); num.push(i >= kp - 1 ? b.close - ll : null); den.push(i >= kp - 1 ? hh - ll : null); });
    for (let i = 0; i < list.length; i++) {
      const n = _sma(num, sl, i), d = _sma(den, sl, i);
      k.push(n == null || d == null ? null : d === 0 ? 100 : (n / d) * 100);
    }
    return list.map((_, i) => ({ k: k[i], d: _sma(k, dp, i) }));
  },
});

klinecharts.registerIndicator({
  name: "WT_ATR", shortName: "ATR", calcParams: [14],
  figures: [{ key: "atr", title: "ATR: ", type: "line" }],
  calc: (list, ind) => {   // MT5 ATR = SMA ของ True Range
    const tr = list.map((b, i) => (i ? Math.max(b.high - b.low, Math.abs(b.high - list[i - 1].close), Math.abs(b.low - list[i - 1].close)) : b.high - b.low));
    return list.map((_, i) => ({ atr: _sma(tr, ind.calcParams[0], i) }));
  },
});

klinecharts.registerIndicator({
  name: "WT_STD", shortName: "StdDev", calcParams: [20],
  figures: [{ key: "sd", title: "SD: ", type: "line" }],
  calc: (list, ind) => {
    const n = ind.calcParams[0], c = list.map((b) => b.close);
    return list.map((_, i) => {
      const m = _sma(c, n, i);
      if (m == null) return {};
      let s = 0;
      for (let k = i - n + 1; k <= i; k++) s += (c[k] - m) ** 2;
      return { sd: Math.sqrt(s / n) };
    });
  },
});

klinecharts.registerIndicator({
  name: "WT_MOM", shortName: "Momentum", calcParams: [14],
  figures: [{ key: "mom", title: "MOM: ", type: "line" }],
  calc: (list, ind) => list.map((b, i) => ({ mom: i >= ind.calcParams[0] ? (b.close / list[i - ind.calcParams[0]].close) * 100 : null })),
});

klinecharts.registerIndicator({
  name: "WT_ENV", shortName: "Envelopes", series: "price", shouldOhlc: true, calcParams: [14, 0.1],
  figures: [{ key: "up", title: "Up: ", type: "line" }, { key: "dn", title: "Down: ", type: "line" }],
  calc: (list, ind) => {
    const [n, dev] = ind.calcParams, c = list.map((b) => b.close);
    return list.map((_, i) => { const m = _sma(c, n, i); return m == null ? {} : { up: m * (1 + dev / 100), dn: m * (1 - dev / 100) }; });
  },
});

klinecharts.registerIndicator({
  name: "WT_ICHI", shortName: "Ichimoku", series: "price", shouldOhlc: true, calcParams: [9, 26, 52],
  figures: [{ key: "tenkan", title: "Tenkan: ", type: "line" }, { key: "kijun", title: "Kijun: ", type: "line" },
    { key: "spanA", title: "SpanA: ", type: "line" }, { key: "spanB", title: "SpanB: ", type: "line" }, { key: "chikou", title: "Chikou: ", type: "line" }],
  calc: (list, ind) => {   // Senkou เลื่อนไปข้างหน้า kijun แท่ง (ส่วนที่เลยแท่งล่าสุดไม่แสดง), Chikou เลื่อนย้อนหลัง
    const [t, k, s] = ind.calcParams;
    const mid = (n, i) => { const [hh, ll] = _hhll(list, n, i); return i >= n - 1 ? (hh + ll) / 2 : null; };
    const tk = list.map((_, i) => mid(t, i)), kj = list.map((_, i) => mid(k, i)), sb = list.map((_, i) => mid(s, i));
    return list.map((b, i) => {
      const j = i - k;
      return {
        tenkan: tk[i], kijun: kj[i],
        spanA: j >= 0 && tk[j] != null && kj[j] != null ? (tk[j] + kj[j]) / 2 : null,
        spanB: j >= 0 ? sb[j] : null,
        chikou: i + k < list.length ? list[i + k].close : null,
      };
    });
  },
});

klinecharts.registerIndicator({
  name: "WT_ALLI", shortName: "Alligator", series: "price", shouldOhlc: true, calcParams: [13, 8, 5],
  figures: [{ key: "jaw", title: "Jaw: ", type: "line" }, { key: "teeth", title: "Teeth: ", type: "line" }, { key: "lips", title: "Lips: ", type: "line" }],
  calc: (list, ind) => {   // SMMA ของ (H+L)/2 เลื่อนไปข้างหน้า 8/5/3 แท่ง
    const [j, t, l] = ind.calcParams, med = list.map((b) => (b.high + b.low) / 2);
    const J = _smma(med, j), T = _smma(med, t), L = _smma(med, l);
    const sh = (arr, s, i) => (i - s >= 0 ? arr[i - s] : null);
    return list.map((_, i) => ({ jaw: sh(J, 8, i), teeth: sh(T, 5, i), lips: sh(L, 3, i) }));
  },
});

// ---------- รายการ ----------
// params: [{ label, def }] | list: true = ใส่หลายค่าคั่น , (เช่น MA หลายเส้น)
const BASIC_INDICATORS = [
  { key: "MA", klc: "MA", pane: "main", title: "Moving Average (SMA)", desc: "เส้นค่าเฉลี่ยธรรมดา ใส่ได้หลายเส้น", list: { label: "ช่วง (คั่นด้วย ,)", def: [20, 50] } },
  { key: "EMA", klc: "EMA", pane: "main", title: "Moving Average (EMA)", desc: "ค่าเฉลี่ยถ่วงน้ำหนักล่าสุด ใส่ได้หลายเส้น", list: { label: "ช่วง (คั่นด้วย ,)", def: [21, 50] } },
  { key: "BOLL", klc: "BOLL", pane: "main", title: "Bollinger Bands", desc: "กรอบ SMA ± k × SD", params: [{ label: "ช่วง", def: 20 }, { label: "Deviation", def: 2 }] },
  { key: "SAR", klc: "SAR", pane: "main", title: "Parabolic SAR", desc: "จุดกลับตัวตามเทรนด์", params: [{ label: "Step เริ่ม (%)", def: 2 }, { label: "Step เพิ่ม (%)", def: 2 }, { label: "สูงสุด (%)", def: 20 }] },
  { key: "ENV", klc: "WT_ENV", pane: "main", title: "Envelopes", desc: "SMA ± %", params: [{ label: "ช่วง", def: 14 }, { label: "Deviation %", def: 0.1 }] },
  { key: "ICHI", klc: "WT_ICHI", pane: "main", title: "Ichimoku Kinko Hyo", desc: "Tenkan / Kijun / Senkou A-B / Chikou", params: [{ label: "Tenkan", def: 9 }, { label: "Kijun", def: 26 }, { label: "Senkou B", def: 52 }] },
  { key: "ALLI", klc: "WT_ALLI", pane: "main", title: "Alligator (Bill Williams)", desc: "SMMA 3 เส้น เลื่อนไปข้างหน้า", params: [{ label: "Jaw", def: 13 }, { label: "Teeth", def: 8 }, { label: "Lips", def: 5 }] },
  { key: "VOL", klc: "VOL", pane: "sub", title: "Volume", desc: "ปริมาณ tick volume" },
  { key: "RSI", klc: "RSI", pane: "sub", title: "Relative Strength Index", desc: "RSI", list: { label: "ช่วง (คั่นด้วย ,)", def: [14] } },
  { key: "MACD", klc: "MACD", pane: "sub", title: "MACD", desc: "Fast / Slow / Signal", params: [{ label: "Fast EMA", def: 12 }, { label: "Slow EMA", def: 26 }, { label: "Signal", def: 9 }] },
  { key: "STOCH", klc: "WT_STOCH", pane: "sub", title: "Stochastic Oscillator", desc: "แบบ MT5 (%K, %D, Slowing)", params: [{ label: "%K", def: 5 }, { label: "%D", def: 3 }, { label: "Slowing", def: 3 }] },
  { key: "CCI", klc: "CCI", pane: "sub", title: "Commodity Channel Index", desc: "CCI", params: [{ label: "ช่วง", def: 14 }] },
  { key: "WR", klc: "WR", pane: "sub", title: "Williams' Percent Range", desc: "%R", list: { label: "ช่วง (คั่นด้วย ,)", def: [14] } },
  { key: "MOM", klc: "WT_MOM", pane: "sub", title: "Momentum", desc: "close / close[n] × 100 (แบบ MT5)", params: [{ label: "ช่วง", def: 14 }] },
  { key: "DMI", klc: "DMI", pane: "sub", title: "ADX (DMI)", desc: "+DI / −DI / ADX", params: [{ label: "ช่วง DI", def: 14 }, { label: "ช่วง ADX", def: 14 }] },
  { key: "ATR", klc: "WT_ATR", pane: "sub", title: "Average True Range", desc: "ATR (SMA ของ TR แบบ MT5)", params: [{ label: "ช่วง", def: 14 }] },
  { key: "STD", klc: "WT_STD", pane: "sub", title: "Standard Deviation", desc: "ส่วนเบี่ยงเบนมาตรฐานของราคาปิด", params: [{ label: "ช่วง", def: 20 }] },
  { key: "OBV", klc: "OBV", pane: "sub", title: "On Balance Volume", desc: "OBV + เส้นค่าเฉลี่ย", params: [{ label: "ช่วงค่าเฉลี่ย", def: 30 }] },
  { key: "AO", klc: "AO", pane: "sub", title: "Awesome Oscillator", desc: "SMA5 − SMA34 ของ (H+L)/2", params: [{ label: "เร็ว", def: 5 }, { label: "ช้า", def: 34 }] },
  // Order flow จริงจาก Binance futures (flow.js) — ใช้ได้กับ BTC / ETH
  { key: "FDELTA", klc: "WT_FDELTA", pane: "sub", cat: "flow", title: "Delta (ซื้อ − ขาย ต่อแท่ง)", desc: "volume ฝั่งซื้อที่กดเข้า − ฝั่งขาย · BTC/ETH" },
  { key: "FCVD", klc: "WT_FCVD", pane: "sub", cat: "flow", title: "CVD (Cumulative Volume Delta)", desc: "delta สะสม — ราคาขึ้นแต่ CVD ลง = แรงซื้อไม่ตาม", params: [{ label: "รีเซ็ตทุก (ชม., 24 = รายวัน)", def: 24 }] },
  { key: "FOI", klc: "WT_FOI", pane: "sub", cat: "flow", title: "Open Interest", desc: "สัญญาคงค้าง (อัปเดตทุก 1 นาที) — เพิ่ม = เงินใหม่เข้า" },
  { key: "FVP", klc: "WT_FVP", pane: "main", cat: "flow", title: "Volume Profile (ซื้อ/ขายจริง)", desc: "ช่วงที่มองเห็น + POC + Value Area",
    params: [{ label: "จำนวนแถว", def: 80 }, { label: "ความกว้าง (% ของกราฟ)", def: 25 }, { label: "Value Area (%)", def: 70 }] },
  { key: "FLIQ", klc: "WT_FLIQ", pane: "main", cat: "flow", title: "Liquidations (จุดล้างพอร์ต)", desc: "แดง = long โดนล้าง, เขียว = short โดนล้าง · ขนาดตามมูลค่า",
    params: [{ label: "แสดงเมื่อมูลค่า ≥ (พัน $)", def: 10 }] },
];
const BASIC_BY_KEY = Object.fromEntries(BASIC_INDICATORS.map((b) => [b.key, b]));

// ชื่อเส้น (ตามลำดับเส้นของอินดิเคเตอร์นั้น) + สีเริ่มต้นแบบ MT5 — ตัวที่เป็นแท่ง/จุด (Volume, AO, SAR) ไม่มีให้ตั้ง
const KLC_LINE_COLORS = ["#FF9600", "#935EBD", "#1677FF", "#E11D74", "#01C5C4"];
const BASIC_LINES = {
  MA: (p) => p.map((n) => `MA ${n}`), EMA: (p) => p.map((n) => `EMA ${n}`), RSI: (p) => p.map((n) => `RSI ${n}`), WR: (p) => p.map((n) => `%R ${n}`),
  BOLL: ["Upper", "Middle", "Lower"], MACD: ["MACD", "Signal"], CCI: ["CCI"], DMI: ["+DI", "−DI", "ADX", "ADXR"], OBV: ["OBV", "MA"],
  ENV: ["Upper", "Lower"], ICHI: ["Tenkan-sen", "Kijun-sen", "Senkou Span A", "Senkou Span B", "Chikou Span"], ALLI: ["Jaw", "Teeth", "Lips"],
  STOCH: ["%K (Main)", "%D (Signal)"], ATR: ["ATR"], STD: ["StdDev"], MOM: ["Momentum"], FCVD: ["CVD"], FOI: ["OI"],
};
const BASIC_LINE_DEFAULTS = {
  BOLL: ["#1677FF", "#FF9600", "#1677FF"], ENV: ["#1677FF", "#E11D74"], ICHI: ["#E11D74", "#1677FF", "#F4A460", "#D8BFD8", "#32CD32"],
  ALLI: ["#1677FF", "#E11D74", "#26A69A"], FCVD: ["#2f81f7"], FOI: ["#f0a030"], STOCH: ["#26A69A", "#E11D74"], MACD: ["#9E9E9E", "#E11D74"], DMI: ["#26A69A", "#E11D74", "#1677FF", "#935EBD"],
};

function basicLineNames(spec, params) {
  const f = BASIC_LINES[spec.key];
  return !f ? [] : typeof f === "function" ? f(params) : f;
}

// สไตล์เส้นที่ใช้จริง: ค่าที่ผู้ใช้ตั้ง > ค่าเริ่มต้นแบบ MT5 > สีวนของกราฟ
function basicLineStyles(spec, pref, params) {
  return basicLineNames(spec, params).map((_, i) => {
    const u = pref?.lines?.[i] || {};
    const color = u.color || BASIC_LINE_DEFAULTS[spec.key]?.[i] || KLC_LINE_COLORS[i % KLC_LINE_COLORS.length];
    const size = u.size || 1;
    const kind = u.style || "solid";
    // จุดไข่ปลา = เส้นประช่วงสั้นเท่าความหนา
    const dashedValue = kind === "dotted" ? [size, size * 2 + 1] : [6, 4];
    return { color, size, style: kind === "solid" ? "solid" : "dashed", smooth: false, dashedValue, kind };
  });
}

function basicPrefs() { return store("wt.basic", {}); }

function basicParams(spec, pref) {
  if (spec.list) return pref?.params?.length ? pref.params : spec.list.def;
  return (spec.params || []).map((p, i) => pref?.params?.[i] ?? p.def);
}

function basicOn(key) {
  if (key === "VOL") return !!store("wt.showVol", true);
  return !!basicPrefs()[key]?.on;
}

function setBasicPref(key, patch) {
  if (key === "VOL") {
    if ("on" in patch) save("wt.showVol", !!patch.on);
    if ("hidden" in patch) save("wt.showVol", !patch.hidden);
  } else {
    const all = { ...basicPrefs() };
    all[key] = { ...(all[key] || {}), ...patch };
    save("wt.basic", all);
  }
  state.charts?.panels.forEach((p) => { p.applyVol(); p.applyIndicators(); });
}

// เรียกจาก ChartPanel.applyIndicators — สร้างใหม่ทั้งชุดตาม prefs
function applyBasics(panel) {
  const c = panel.chart, prefs = basicPrefs();
  // หน้าต่างล่างแต่ละอัน ~18% ของกราฟ (50–100px) — ไม่บีบกราฟราคาจนหายบนจอเล็ก
  const subs = BASIC_INDICATORS.filter((b) => b.pane === "sub" && b.key !== "VOL" && prefs[b.key]?.on && !prefs[b.key]?.hidden).length;
  const bodyH = panel.body.clientHeight || 400;
  const subH = Math.round(Math.max(50, Math.min(100, (bodyH * (subs > 2 ? 0.5 : 0.36)) / Math.max(1, subs))));
  for (const spec of BASIC_INDICATORS) {
    if (spec.key === "VOL") continue;
    c.removeIndicator({ name: spec.klc });
    const pref = prefs[spec.key];
    if (!pref?.on || pref.hidden) continue;
    const calcParams = basicParams(spec, pref);
    const lines = basicLineStyles(spec, pref, calcParams).map(({ kind, ...l }) => l);
    const styles = lines.length ? { lines } : undefined;
    const ext = spec.cat === "flow" ? { extendData: { panel: panel.idx, v: 0 } } : {};
    if (spec.pane === "main") c.createIndicator({ name: spec.klc, calcParams, paneId: "candle_pane", styles, ...ext }, true);
    else {
      const paneId = `b_${spec.key}`;
      c.createIndicator({ name: spec.klc, calcParams, paneId, styles, ...ext });
      c.setPaneOptions({ id: paneId, height: subH });
    }
  }
  if (typeof flowApplied === "function") flowApplied(panel);
}

function basicLegendRows() {
  const prefs = basicPrefs();
  return BASIC_INDICATORS.filter((s) => s.key !== "VOL" && prefs[s.key]?.on)
    .map((s) => {
      const p = basicParams(s, prefs[s.key]);
      return { key: `b:${s.key}`, title: s.cat === "flow" ? `📊 ${s.title.split(" (")[0]}` : `${s.klc.replace("WT_", "")} (${p.join(", ")})`, hidden: !!prefs[s.key]?.hidden };
    });
}

function openBasicSettings(key) {
  const spec = BASIC_BY_KEY[key];
  if (!spec || key === "VOL") return;
  const pref = basicPrefs()[key] || {};
  const cur = basicParams(spec, pref);
  openDialog(`ตั้งค่า ${spec.title}`, (form, close) => {
    const inputs = [];
    if (spec.list) {
      const inp = mkx("input", { type: "text", value: cur.join(", ") });
      inputs.push(inp);
      form.append(mkx("label", { className: "ind-field" }, mkx("span", { textContent: spec.list.label }), inp));
    } else {
      (spec.params || []).forEach((p, i) => {
        const inp = mkx("input", { type: "number", step: "any", value: String(cur[i]) });
        inputs.push(inp);
        form.append(mkx("label", { className: "ind-field" }, mkx("span", { textContent: p.label }), inp));
      });
    }
    // สี / ความหนา / ประเภทเส้น ทีละเส้น (แบบแท็บ Colors ของ MT5)
    const lineRows = [];
    const names = basicLineNames(spec, cur);
    if (names.length) {
      form.append(mkx("div", { className: "ind-group", textContent: "เส้น" }));
      basicLineStyles(spec, pref, cur).forEach((st, i) => {
        const color = mkx("input", { type: "color", value: /^#[0-9a-f]{6}$/i.test(st.color) ? st.color : "#1677ff" });
        const size = mkx("select", {}, ...[1, 2, 3, 4].map((n) => mkx("option", { value: String(n), textContent: `${n}px`, selected: st.size === n })));
        const kind = mkx("select", {}, ...[["solid", "━━ ทึบ"], ["dashed", "╍╍ ประ"], ["dotted", "┈┈ จุด"]].map(([v, t]) => mkx("option", { value: v, textContent: t, selected: st.kind === v })));
        lineRows.push({ color, size, kind });
        form.append(mkx("div", { className: "line-row" }, mkx("span", { textContent: names[i] }), color, size, kind));
      });
    }
    const err = mkx("div", { className: "tk-info bad" });
    const reset = mkx("button", { type: "button", className: "btn-ghost", textContent: "ค่าเริ่มต้น" });
    reset.onclick = () => { setBasicPref(key, { params: null, lines: null }); close(); };
    const ok = mkx("button", { type: "submit", className: "btn-primary", textContent: "บันทึก" });
    form.append(err, mkx("div", { className: "modal-btns" }, reset, ok));
    form.onsubmit = (e) => {
      e.preventDefault();
      const vals = spec.list ? inputs[0].value.split(/[,\s]+/).filter(Boolean).map(Number) : inputs.map((x) => Number(x.value));
      if (!vals.length || vals.some((v) => !Number.isFinite(v) || v <= 0) || (spec.list && vals.length > 6)) { err.textContent = spec.list ? "ใส่ตัวเลข > 0 ได้ 1–6 ค่า" : "ค่าต้องเป็นตัวเลข > 0"; return; }
      // จำนวนเส้นเปลี่ยนตามจำนวนค่า (เช่น MA 2 -> 3 เส้น): เส้นใหม่ใช้ค่าเริ่มต้น
      const lines = lineRows.map((r) => ({ color: r.color.value, size: Number(r.size.value), style: r.kind.value }));
      setBasicPref(key, { params: vals, lines, on: true });
      close();
    };
  }, { wide: false });
}
