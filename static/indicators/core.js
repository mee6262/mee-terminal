// Mee Terminal — กรอบอินดิเคเตอร์ที่แปลงจาก Pine (P4)
// แต่ละตัวเรียก defineIndicator({ name, title, inputs, calc, draw })
//   inputs: [{ key, label, type: int|float|bool|color|colort|select, default, min, max, step, options, group, tooltip }]
//           colort = สี + ความโปร่งใสแบบ Pine: default { c: "#rrggbb", t: 0-100 }
//   calc(bars, cfg) -> state          (bars = [{timestamp, open, high, low, close, volume}] เรียงเก่า→ใหม่)
//   draw(ctx, state, h, cfg)          (h = { x(idx), y(price), from, to, width, height, digits })
// ตั้งค่า/เปิดปิด เก็บใน prefs "wt.ind" = { name: { on, cfg } } (sync ทุกเครื่อง)
"use strict";

const WT_INDICATORS = {};

// ทุกตัวที่แปลงจาก TV มีชุดนี้ต่อท้าย: วาดหลังแท่งเทียน + ความทึบ (กล่อง/โซนไม่บังแท่ง)
const IND_LAYER_BEHIND = "หลังแท่งเทียน";
const IND_DISPLAY_INPUTS = [
  { key: "_layer", label: "ตำแหน่ง", type: "select", options: [IND_LAYER_BEHIND, "หน้าแท่งเทียน"], default: IND_LAYER_BEHIND, group: "การแสดงผล" },
  { key: "_opacity", label: "ความทึบ (%)", type: "int", default: 100, min: 10, max: 100, group: "การแสดงผล", tooltip: "ลดลงเพื่อให้จางลงทั้งตัว" },
];
let indOff = null;   // canvas พักภาพก่อนแปะหลังแท่งเทียน (ใช้ร่วมกันทุกตัว วาดทีละตัว)

function defineIndicator(def) {
  if (!def.inputs.some((i) => i.key === "_layer")) def.inputs = [...def.inputs, ...IND_DISPLAY_INPUTS];
  WT_INDICATORS[def.name] = def;
  klinecharts.registerIndicator({
    name: `wt_${def.name}`,
    shortName: def.title,
    series: "price",
    figures: [],
    calc: (dataList, indicator) => {
      const cfg = { ...indDefaults(def), ...(indicator.extendData || {}) };
      let state = null;
      try { state = def.calc(dataList, cfg); } catch (e) { console.error(def.name, e); }
      const out = dataList.map(() => ({}));
      if (out.length) out[out.length - 1] = { __state: state };
      return out;
    },
    draw: ({ ctx, chart, indicator, bounding, xAxis, yAxis }) => {
      const state = indicator.result?.[indicator.result.length - 1]?.__state;
      if (!state) return true;
      const cfg = { ...indDefaults(def), ...(indicator.extendData || {}) };
      const vr = chart.getVisibleRange();
      const h = {
        x: (idx) => xAxis.convertToPixel(idx),
        y: (price) => yAxis.convertToPixel(price),
        from: vr.from, to: vr.to, width: bounding.width, height: bounding.height,
        digits: chart.getSymbol()?.pricePrecision ?? 2,
      };
      const behind = cfg._layer === IND_LAYER_BEHIND;
      const alpha = Math.min(100, Math.max(10, Number(cfg._opacity) || 100)) / 100;
      if (!behind && alpha >= 1) {
        ctx.save();
        try { def.draw(ctx, state, h, cfg); } catch (e) { console.error(def.name, e); }
        ctx.restore();
        return true;
      }
      // วาดลง canvas พักด้วยลำดับปกติ แล้วแปะทีเดียว: destination-over = ไปอยู่ใต้แท่งเทียน/กริดที่วาดไว้แล้ว
      const W = ctx.canvas.width, H = ctx.canvas.height;
      if (!indOff) indOff = document.createElement("canvas");
      if (indOff.width !== W || indOff.height !== H) { indOff.width = W; indOff.height = H; }
      const o = indOff.getContext("2d");
      o.setTransform(1, 0, 0, 1, 0, 0);
      o.clearRect(0, 0, W, H);
      o.setTransform(ctx.getTransform());
      o.save();
      try { def.draw(o, state, h, cfg); } catch (e) { console.error(def.name, e); }
      o.restore();
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = alpha;
      ctx.globalCompositeOperation = behind ? "destination-over" : "source-over";
      ctx.drawImage(indOff, 0, 0);
      ctx.restore();
      return true;
    },
  });
}

function indDefaults(def) {
  return Object.fromEntries(def.inputs.map((i) => [i.key, i.default]));
}

function indPrefs() { return store("wt.ind", {}); }

function indConfig(name) {
  const def = WT_INDICATORS[name];
  return { ...indDefaults(def), ...(indPrefs()[name]?.cfg || {}) };
}

function setIndPref(name, patch) {
  const all = { ...indPrefs() };
  all[name] = { ...(all[name] || {}), ...patch };
  save("wt.ind", all);
  state.charts?.panels.forEach((p) => p.applyIndicators());
}

// สี Pine: color.new(c, transp 0-100) -> rgba
function pineColor(hex, transp = 0) {
  const m = /^#?([0-9a-f]{6})/i.exec(hex || "");
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${(1 - transp / 100).toFixed(3)})`;
}

// ---------- หน้าต่าง: เลือกอินดิเคเตอร์ (หมวด พื้นฐาน / อินดิเคเตอร์ของฉัน / ที่ใช้อยู่ + ค้นหา) ----------
function openIndicatorList(cat) {
  cat = cat || store("wt.indCat", "basic");
  const dlg = document.getElementById("modal");
  const form = dlg.querySelector("form");
  form.replaceChildren();
  form.classList.add("wide", "ind-picker");
  const mk = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; };
  const close = () => { form.classList.remove("wide", "ind-picker"); dlg.close(); };
  const x = mk("button", { type: "button", className: "btn-ghost ip-x", textContent: "✕", title: "ปิด" });
  x.onclick = close;
  form.append(mk("div", { className: "ip-head" }, mk("h3", { textContent: "อินดิเคเตอร์" }), x));
  const q = mk("input", { type: "search", placeholder: "🔍 ค้นหา เช่น RSI, MACD, Liquidity…", className: "ip-search" });
  form.append(q);

  // รายการทั้งหมดในรูปแบบเดียวกัน
  const items = () => {
    const prefs = indPrefs();
    const mine = Object.values(WT_INDICATORS).map((d) => ({ id: `w:${d.name}`, cat: "mine", title: d.title, desc: d.desc || "แปลงจาก TradingView (Pine)",
      on: !!prefs[d.name]?.on, toggle: (v) => setIndPref(d.name, { on: v, hidden: false }), gear: () => openIndicatorSettings(d.name) }));
    const basic = typeof BASIC_INDICATORS === "undefined" ? [] : BASIC_INDICATORS.map((b) => ({ id: `b:${b.key}`, cat: b.cat || "basic", title: b.title,
      desc: `${b.desc}${b.pane === "main" ? " · บนกราฟ" : " · หน้าต่างล่าง"}`, on: basicOn(b.key),
      toggle: (v) => setBasicPref(b.key, { on: v, hidden: false }), gear: b.key === "VOL" ? null : () => openBasicSettings(b.key) }));
    return [...basic, ...mine];
  };
  const cats = [["basic", "📈 พื้นฐาน (MT5)"], ["mine", "⭐ อินดิเคเตอร์ของฉัน"], ["flow", "📊 Order Flow (BTC/ETH)"], ["on", "✅ ที่ใช้อยู่"]];
  const side = mk("div", { className: "ip-cats" });
  const list = mk("div", { className: "ip-list" });
  const paint = () => {
    const all = items();
    const query = q.value.trim().toLowerCase();
    side.replaceChildren(...cats.map(([k, label]) => {
      const n = k === "on" ? all.filter((i) => i.on).length : all.filter((i) => i.cat === k).length;
      const b = mk("button", { type: "button", className: "ip-cat" + (k === cat && !query ? " on" : ""), textContent: `${label}  ${n}` });
      b.onclick = () => { cat = k; save("wt.indCat", k); q.value = ""; paint(); };
      return b;
    }));
    const shown = all.filter((i) => (query ? `${i.title} ${i.desc} ${i.id}`.toLowerCase().includes(query) : cat === "on" ? i.on : i.cat === cat));
    list.replaceChildren();
    if (!shown.length) list.append(mk("div", { className: "muted small ip-empty", textContent: query ? "ไม่พบ" : cat === "on" ? "ยังไม่ได้เปิดตัวไหน" : "—" }));
    for (const it of shown) {
      const row = mk("div", { className: "ip-row" + (it.on ? " on" : "") });
      const main = mk("button", { type: "button", className: "ip-main", title: it.on ? "กดเพื่อเอาออกจากกราฟ" : "กดเพื่อเพิ่มบนกราฟ" },
        mk("span", { className: "ip-check", textContent: it.on ? "✓" : "+" }),
        mk("span", { className: "ip-text" }, mk("b", { textContent: it.title }), mk("small", { className: "muted", textContent: (query ? (it.cat === "mine" ? "⭐ " : it.cat === "flow" ? "📊 " : "📈 ") : "") + it.desc })));
      main.onclick = () => { it.toggle(!it.on); paint(); };
      row.append(main);
      if (it.gear) { const g = mk("button", { type: "button", className: "btn-ghost ind-gear", textContent: "⚙", title: "ตั้งค่า" }); g.onclick = it.gear; row.append(g); }
      list.append(row);
    }
  };
  q.oninput = paint;
  form.append(mk("div", { className: "ip-body" }, side, list));
  if (typeof templateSection === "function") templateSection(form);
  const bell = mk("button", { type: "button", className: "btn-ghost", textContent: "🔔 แจ้งเตือน Telegram / เครื่องนี้" });
  bell.onclick = () => { form.classList.remove("ind-picker"); openAlertManager(); };
  form.append(bell);
  dlg.oncancel = (e) => { e.preventDefault(); close(); };
  form.onsubmit = (e) => e.preventDefault();
  paint();
  if (!dlg.open) dlg.showModal();
  if (!document.body.classList.contains("mobile")) setTimeout(() => q.focus(), 0);
}

// ---------- หน้าต่างตั้งค่า: สร้างจาก inputs ของ Pine ----------
function openIndicatorSettings(name) {
  const def = WT_INDICATORS[name];
  const cfg = indConfig(name);
  const dlg = document.getElementById("modal");
  const form = dlg.querySelector("form");
  form.replaceChildren();
  form.classList.remove("ind-picker");
  form.classList.add("wide");
  const mk = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; };
  form.append(mk("h3", { textContent: `ตั้งค่า ${def.title}` }));
  const fields = {};
  let group = null;
  for (const inp of def.inputs) {
    if (inp.group && inp.group !== group) { group = inp.group; form.append(mk("div", { className: "ind-group", textContent: group })); }
    let el;
    if (inp.type === "bool") el = mk("input", { type: "checkbox", checked: !!cfg[inp.key] });
    else if (inp.type === "color") el = mk("input", { type: "color", value: cfg[inp.key] });
    else if (inp.type === "colort") {
      const c = mk("input", { type: "color", value: cfg[inp.key].c });
      const t = mk("input", { type: "number", min: "0", max: "100", step: "1", value: String(cfg[inp.key].t), title: "ความโปร่งใส 0-100" });
      el = mk("span", { className: "colort" }, c, t, "%");
      el.read = () => ({ c: c.value, t: Math.min(100, Math.max(0, Math.round(Number(t.value) || 0))) });
    }
    else if (inp.type === "select") el = mk("select", {}, ...inp.options.map((o) => mk("option", { value: o, textContent: o, selected: cfg[inp.key] === o })));
    else el = mk("input", { type: "number", value: String(cfg[inp.key]), step: String(inp.step ?? (inp.type === "int" ? 1 : "any")),
      ...(inp.min != null ? { min: String(inp.min) } : {}), ...(inp.max != null ? { max: String(inp.max) } : {}) });
    fields[inp.key] = el;
    const row = inp.type === "bool"
      ? mk("label", { className: "chk ind-field", title: inp.tooltip || "" }, el, inp.label)
      : mk("label", { className: "ind-field", title: inp.tooltip || "" }, mk("span", { textContent: inp.label }), el);
    form.append(row);
  }
  const err = mk("div", { className: "tk-info bad" });
  const reset = mk("button", { type: "button", className: "btn-ghost", textContent: "ค่าเริ่มต้น" });
  reset.onclick = () => { setIndPref(name, { cfg: {} }); openIndicatorSettings(name); };
  const back = mk("button", { type: "button", className: "btn-ghost", textContent: "ย้อนกลับ" });
  back.onclick = () => openIndicatorList();
  // ไม่ใช้ submit ของเบราว์เซอร์: step 0.01 ทำให้ 0.236 / 0.886 ถูกปฏิเสธ ("ค่าใกล้เคียงคือ 0.23 และ 0.24") — ตรวจเองด้านล่าง
  const ok = mk("button", { type: "button", className: "btn-primary", textContent: "บันทึก" });
  form.append(err, mk("div", { className: "modal-btns three" }, back, reset, ok));
  ok.onclick = () => form.onsubmit(new Event("submit"));
  form.onsubmit = (e) => {
    e.preventDefault();
    const out = {};
    for (const inp of def.inputs) {
      const el = fields[inp.key];
      let v = inp.type === "bool" ? el.checked : inp.type === "colort" ? el.read()
        : inp.type === "color" || inp.type === "select" ? el.value : Number(el.value);
      if (inp.type === "int") v = Math.round(v);
      if ((inp.type === "int" || inp.type === "float") && (!Number.isFinite(v) || (inp.min != null && v < inp.min) || (inp.max != null && v > inp.max))) {
        err.textContent = `${inp.label}: ต้องอยู่ระหว่าง ${inp.min ?? "-∞"} ถึง ${inp.max ?? "∞"}`;
        return;
      }
      out[inp.key] = v;
    }
    setIndPref(name, { cfg: out, on: true });
    openIndicatorList();
  };
  dlg.oncancel = (e) => { e.preventDefault(); form.classList.remove("wide"); dlg.close(); };
  if (!dlg.open) dlg.showModal();
}

// ---------- แจ้งเตือน Telegram (ตัวส่งจริง = alerts/alert_service.js บน VPS) ----------
const TF_LIST = ["M1", "M5", "M15", "M30", "H1", "H4", "D1", "W1", "MN1"];

async function openAlertManager() {
  const dlg = document.getElementById("modal");
  const form = dlg.querySelector("form");
  form.replaceChildren();
  form.classList.add("wide");
  const mk = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; };
  form.append(mk("h3", { textContent: "แจ้งเตือนอินดิเคเตอร์ → Telegram" }));
  const status = mk("div", { className: "tk-info", textContent: "กำลังเช็คตัวส่ง…" });
  form.append(status);

  const rulesBox = mk("div", { className: "alert-rules" });
  form.append(mk("div", { className: "ind-group", textContent: "กฎที่ตั้งไว้ (เช็คทุกครั้งที่แท่งปิด)" }), rulesBox);
  const paintRules = () => {
    const rules = store("wt.alerts", []);
    rulesBox.replaceChildren();
    if (!rules.length) rulesBox.append(mk("div", { className: "muted small", textContent: "ยังไม่มีกฎ" }));
    for (const r of rules) {
      const def = WT_INDICATORS[r.indicator];
      const on = mk("input", { type: "checkbox", checked: !!r.on });
      on.onchange = () => save("wt.alerts", store("wt.alerts", []).map((x) => (x.id === r.id ? { ...x, on: on.checked } : x)));
      const del = mk("button", { type: "button", className: "btn-ghost ind-gear", textContent: "✕", title: "ลบ" });
      del.onclick = () => { save("wt.alerts", store("wt.alerts", []).filter((x) => x.id !== r.id)); paintRules(); };
      rulesBox.append(mk("div", { className: "ind-row" },
        mk("label", { className: "chk" }, on, `${r.symbol} ${r.tf} · ${def?.title || r.indicator} · ${def?.alerts?.[r.event] || r.event}`), del));
    }
  };
  paintRules();

  // เพิ่มกฎ
  const withAlerts = Object.values(WT_INDICATORS).filter((d) => d.alerts);
  const indSel = mk("select", {}, ...withAlerts.map((d) => mk("option", { value: d.name, textContent: d.title })));
  const evSel = mk("select");
  const fillEv = () => evSel.replaceChildren(...Object.entries(WT_INDICATORS[indSel.value].alerts).map(([k, v]) => mk("option", { value: k, textContent: v })));
  indSel.onchange = fillEv; fillEv();
  const p = state.charts?.panels[state.charts.active];
  const sym = mk("input", { type: "text", value: p?.symbol || "", placeholder: "symbol" });
  sym.setAttribute("list", "sym-list");
  const tf = mk("select", {}, ...TF_LIST.map((t) => mk("option", { value: t, textContent: t, selected: t === p?.tf })));
  const add = mk("button", { type: "button", className: "btn-primary", textContent: "+ เพิ่มกฎ" });
  const err = mk("div", { className: "tk-info bad" });
  add.onclick = () => {
    const s = sym.value.trim();
    if (!s) { err.textContent = "ใส่ symbol"; return; }
    const rules = store("wt.alerts", []);
    if (rules.length >= 50) { err.textContent = "ตั้งได้ไม่เกิน 50 กฎ"; return; }
    if (rules.some((x) => x.acct === state.acct && x.symbol === s && x.tf === tf.value && x.indicator === indSel.value && x.event === evSel.value)) {
      err.textContent = "มีกฎนี้อยู่แล้ว"; return;
    }
    const id = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now())).slice(0, 12);
    save("wt.alerts", [...rules, { id, on: true, acct: state.acct, symbol: s, tf: tf.value, indicator: indSel.value, event: evSel.value }]);
    err.textContent = "";
    paintRules();
  };
  form.append(mk("div", { className: "ind-group", textContent: "เพิ่มกฎ (ใช้ค่าตั้งของอินดิเคเตอร์ตัวนั้นที่บันทึกไว้)" }),
    mk("div", { className: "alert-add" }, indSel, evSel, sym, tf, add), err);

  const logBox = mk("div", { className: "alert-log" });
  const test = mk("button", { type: "button", className: "btn-ghost", textContent: "ส่งข้อความทดสอบ" });
  test.onclick = async () => { await api("/api/alerts/test", { method: "POST" }); toast("ส่งคำขอแล้ว — ข้อความควรเข้า Telegram ภายใน ~10 วินาที"); };
  const refresh = async () => {
    try {
      const r = await api("/api/alerts/status");
      const j = await r.json();
      status.textContent = j.service_alive ? "✅ ตัวส่ง alert (pm2: wt-alerts) ทำงานอยู่" : "❌ ตัวส่ง alert ไม่ได้รัน — บน VPS: cd web_terminal แล้ว pm2 start ecosystem.config.js";
      status.className = "tk-info" + (j.service_alive ? "" : " bad");
      logBox.replaceChildren(...(j.log.length ? j.log.slice(0, 10) : []).map((x) => mk("div", { className: "alert-log-row" + (x.ok ? "" : " bad") },
        mk("span", { className: "muted", textContent: new Date(x.ts * 1000).toLocaleString("th-TH", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) }),
        mk("span", { textContent: (x.ok ? "✓ " : "✗ ") + x.text.split("\n")[0] + (x.error ? ` — ${x.error}` : "") }))));
      if (!j.log.length) logBox.append(mk("div", { className: "muted small", textContent: "ยังไม่มีการแจ้งเตือน" }));
    } catch (_) { status.textContent = "เช็คสถานะไม่ได้"; }
  };
  const back = mk("button", { type: "button", className: "btn-ghost", textContent: "ย้อนกลับ" });
  back.onclick = () => openIndicatorList();
  if (typeof notifySection === "function") { notifySection(form); pushSection(form); priceAlertSection(form); }
  form.append(mk("div", { className: "ind-group", textContent: "ส่งล่าสุด" }), logBox, mk("div", { className: "modal-btns" }, back, test));
  form.onsubmit = (e) => e.preventDefault();
  dlg.oncancel = (e) => { e.preventDefault(); form.classList.remove("wide"); dlg.close(); };
  if (!dlg.open) dlg.showModal();
  refresh();
}
