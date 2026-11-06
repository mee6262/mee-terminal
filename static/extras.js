// Mee Terminal — P6: ปิดบางส่วน, จุดทุน (BE) + Auto BE, alert เส้นราคา, โซน R:R (Long/Short), ไม้ในอดีตบนกราฟ,
// เทมเพลตอินดิเคเตอร์, ความเสี่ยงรวม + สรุปวันนี้, สถานะระบบ
"use strict";

const mkx = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; };
const acctUrl = (path) => `/api/a/${encodeURIComponent(state.acct)}/${path}`;

function openDialog(title, build, { wide = true } = {}) {
  const dlg = document.getElementById("modal");
  const form = dlg.querySelector("form");
  form.replaceChildren();
  form.classList.toggle("wide", wide);
  form.append(mkx("h3", { textContent: title }));
  const close = () => { form.classList.remove("wide"); dlg.close(); };
  dlg.oncancel = (e) => { e.preventDefault(); close(); };
  form.onsubmit = (e) => e.preventDefault();
  build(form, close);
  if (!dlg.open) dlg.showModal();
  return close;
}

// ---------- ปิดบางส่วน: ปุ่ม 25/50/75% + ใส่ lot เอง ----------
function stepLot(vol, pct, spec) {
  const step = spec?.volume_step || 0.01, vmin = spec?.volume_min || step;
  const dec = Math.max(0, -Math.floor(Math.log10(step) + 1e-9));
  let v = Math.floor((vol * pct) / step + 1e-9) * step;
  v = Math.max(v, vmin);
  const rest = vol - v;
  if (rest > 1e-9 && rest < vmin - 1e-9) v = vol;   // เหลือต่ำกว่าขั้นต่ำ = ปิดทั้งหมด
  return Number(Math.min(v, vol).toFixed(dec));
}

async function openPartial(p) {
  const spec = await loadSpec(p.symbol);
  openDialog(`ปิดบางส่วน #${p.ticket} ${p.symbol}`, (form, close) => {
    form.append(mkx("p", { className: "modal-line", textContent: `ถืออยู่ ${p.volume} lot · กำไรตอนนี้ ${plMoney(p.profit)}` }));
    const inp = mkx("input", { type: "text", inputMode: "decimal", value: String(stepLot(p.volume, 0.5, spec)) });
    const est = mkx("div", { className: "tk-info" });
    const paint = () => {
      const v = num(inp.value);
      est.textContent = v > 0 && v <= p.volume ? `ปิด ${v} lot ≈ ${plMoney(p.profit * v / p.volume)} · เหลือ ${Number((p.volume - v).toFixed(8))} lot` : "lot ไม่ถูกต้อง";
    };
    inp.oninput = paint;
    const quick = mkx("div", { className: "seg quick" });
    for (const pct of [0.25, 0.5, 0.75, 1]) {
      const b = mkx("button", { type: "button", textContent: pct === 1 ? "ทั้งหมด" : `${pct * 100}%` });
      b.onclick = () => { inp.value = String(stepLot(p.volume, pct, spec)); paint(); };
      quick.append(b);
    }
    const go = mkx("button", { type: "submit", className: "btn-danger", textContent: "ปิด" });
    const cancel = mkx("button", { type: "button", className: "btn-ghost", textContent: "ยกเลิก" });
    cancel.onclick = close;
    form.append(quick, mkx("label", { className: "modal-field" }, mkx("span", { textContent: "ปิด lot" }), inp), est,
      mkx("div", { className: "modal-btns" }, cancel, go));
    form.onsubmit = (e) => {
      e.preventDefault();
      const v = num(inp.value);
      if (!(v > 0 && v <= p.volume)) return;
      close();
      tradeCall("trade/position/close", { ticket: p.ticket, ...(v < p.volume ? { volume: v } : {}), client_id: cid() });
    };
    paint();
    setTimeout(() => inp.select(), 0);
  });
}

// ---------- จุดทุน (BE) ----------
const be = { cfg: null, loadedFor: null };

async function loadAutoBE() {
  if (!state.acct) return null;
  const acct = state.acct;
  try {
    const r = await api(acctUrl("autobe"));
    if (r.ok && acct === state.acct) { be.cfg = await r.json(); be.loadedFor = acct; }
  } catch (_) { /* worker ยังไม่ขึ้น */ }
  paintAutoBE();
  return be.cfg;
}

function beLock(symbol) {
  const c = be.cfg;
  if (!c) return 0;
  return Number(c.per_symbol?.[symbol]?.lock_points ?? c.lock_points ?? 0);
}

function breakeven(p) {
  tradeCall("trade/position/breakeven", { ticket: p.ticket, lock_points: beLock(p.symbol), client_id: cid() });
}

async function breakevenAll() {
  const sym = ticketSymbol();
  const mine = state.positions.filter((p) => p.symbol === sym);
  const all = state.positions.length;
  if (!all) return;
  const v = await new Promise((resolve) => openDialog("เลื่อน SL ไปจุดทุน", (form, close) => {
    form.append(mkx("p", { className: "modal-line", textContent: "ไม้ที่ราคายังไม่เลยจุดทุน / SL อยู่ทุนแล้ว จะถูกข้าม" }));
    const b1 = mkx("button", { type: "button", className: "btn-primary", textContent: `เฉพาะ ${sym} (${mine.length})`, disabled: !mine.length });
    const b2 = mkx("button", { type: "button", className: "btn-primary", textContent: `ทุก symbol (${all})` });
    const x = mkx("button", { type: "button", className: "btn-ghost", textContent: "ยกเลิก" });
    b1.onclick = () => { close(); resolve("sym"); };
    b2.onclick = () => { close(); resolve("all"); };
    x.onclick = () => { close(); resolve(null); };
    form.append(mkx("div", { className: "modal-btns three" }, x, b1, b2));
  }, { wide: false }));
  if (!v) return;
  tradeCall("trade/position/breakeven", { ...(v === "sym" ? { symbol: sym } : {}), lock_points: v === "sym" ? beLock(sym) : (be.cfg?.lock_points || 0), client_id: cid() });
}

function paintAutoBE() {
  const b = document.getElementById("autobe-btn");
  if (!b) return;
  const c = be.cfg;
  const on = !!c?.on;
  b.textContent = on ? `🛡 Auto BE: ${c.mode === "points" ? `${c.points} จุด` : `${c.rr}R`}` : "🛡 Auto BE: ปิด";
  b.classList.toggle("on", on);
}

function openAutoBE() {
  const c = { ...(be.cfg || { on: false, mode: "rr", rr: 1, points: 300, lock_points: 0, symbols: [], per_symbol: {} }) };
  openDialog(`Auto BE — บัญชี ${state.acct}`, (form, close) => {
    const acc = state.account;
    const warn = [];
    if (c.trading === false) warn.push("บัญชีนี้ปิดการเทรดใน accounts.json (trading: false) — Auto BE จะไม่ทำงาน");
    if (acc?.trade_mode === 2 && !state.status?.allow_real) warn.push("บัญชีเงินจริงแต่ยังไม่ตั้ง allow_real — Auto BE จะไม่ทำงานจนกว่าจะเปิด");
    for (const w of warn) form.append(mkx("div", { className: "tk-info bad", textContent: "⚠️ " + w }));
    form.append(mkx("p", { className: "modal-line muted", textContent: "worker เป็นคนเลื่อนให้ — ทำงานแม้ปิดเว็บ/ปิดมือถือ · เลื่อน SL ไปราคาเข้า (+ล็อกกำไร) เมื่อกำไรถึงเงื่อนไข ครั้งเดียวต่อไม้" }));
    const on = mkx("input", { type: "checkbox", checked: !!c.on });
    form.append(mkx("label", { className: "chk ind-field" }, on, "เปิด Auto BE"));
    const mode = mkx("select", {}, mkx("option", { value: "rr", textContent: "RR — กำไรถึงกี่เท่าของระยะ SL" }),
      mkx("option", { value: "points", textContent: "ระยะ — กำไรถึงกี่จุด" }));
    mode.value = c.mode;
    const rr = mkx("input", { type: "number", step: "0.1", min: "0.1", max: "20", value: String(c.rr) });
    const pts = mkx("input", { type: "number", step: "1", min: "1", value: String(c.points) });
    const lock = mkx("input", { type: "number", step: "1", min: "0", value: String(c.lock_points) });
    const syms = mkx("input", { type: "text", value: (c.symbols || []).join(", "), placeholder: "เว้นว่าง = ทุก symbol (ตัวที่ตั้งรายตัวด้านล่างรวมให้อัตโนมัติ)" });
    syms.setAttribute("list", "sym-list");
    const rrRow = mkx("label", { className: "ind-field" }, mkx("span", { textContent: "RR (เช่น 1 = กำไร 1R)" }), rr);
    const ptRow = mkx("label", { className: "ind-field" }, mkx("span", { textContent: "ระยะกำไร (จุด)" }), pts);
    const swap = () => { rrRow.style.display = mode.value === "rr" ? "" : "none"; ptRow.style.display = mode.value === "points" ? "" : "none"; };   // hidden ถูก CSS display ทับ
    mode.onchange = swap;
    form.append(mkx("label", { className: "ind-field" }, mkx("span", { textContent: "เงื่อนไข" }), mode), rrRow, ptRow,
      mkx("label", { className: "ind-field", title: "SL ใหม่ = ราคาเข้า + จุดนี้ (ฝั่งกำไร) ไว้ครอบค่าคอม/สเปรด" },
        mkx("span", { textContent: "ล็อกกำไรเพิ่ม (จุด)" }), lock),
      mkx("label", { className: "ind-field" }, mkx("span", { textContent: "เฉพาะ symbol" }), syms));
    const sym = ticketSymbol();
    const d = state.digits[sym];
    if (d != null) form.append(mkx("div", { className: "muted small", textContent: `ตัวอย่าง ${sym}: 1 จุด = ${(10 ** -d).toFixed(d)} · 100 จุด = ${(100 * 10 ** -d).toFixed(d)}` }));

    // ค่าเฉพาะ symbol (ระยะเป็นจุดต่างกันมาก เช่น BTC กับ EURUSD)
    form.append(mkx("div", { className: "ind-group", textContent: "ค่าเฉพาะ symbol (ทับค่าหลัก, เว้นว่าง = ใช้ค่าหลัก)" }));
    const perBox = mkx("div", { className: "per-sym" });
    const rows = [];
    const addRow = (s = "", o = {}) => {
      const r = { s: mkx("input", { type: "text", value: s, placeholder: "symbol" }),
        rr: mkx("input", { type: "number", step: "0.1", value: o.rr ?? "", placeholder: "RR" }),
        points: mkx("input", { type: "number", step: "1", value: o.points ?? "", placeholder: "จุด" }),
        lock: mkx("input", { type: "number", step: "1", value: o.lock_points ?? "", placeholder: "ล็อก" }) };
      r.s.setAttribute("list", "sym-list");
      const x = mkx("button", { type: "button", className: "btn-ghost ind-gear", textContent: "✕" });
      const row = mkx("div", { className: "per-row" }, r.s, r.rr, r.points, r.lock, x);
      x.onclick = () => { row.remove(); rows.splice(rows.indexOf(r), 1); };
      rows.push(r);
      perBox.append(row);
    };
    for (const [s, o] of Object.entries(c.per_symbol || {})) addRow(s, o);
    const add = mkx("button", { type: "button", className: "btn-ghost", textContent: "+ เพิ่ม symbol" });
    add.onclick = () => addRow(ticketSymbol());
    form.append(perBox, add);

    const err = mkx("div", { className: "tk-info bad" });
    const cancel = mkx("button", { type: "button", className: "btn-ghost", textContent: "ยกเลิก" });
    cancel.onclick = close;
    const ok = mkx("button", { type: "submit", className: "btn-primary", textContent: "บันทึก" });
    form.append(err, mkx("div", { className: "modal-btns" }, cancel, ok));
    swap();
    form.onsubmit = async (e) => {
      e.preventDefault();
      const per = {};
      for (const r of rows) {
        const s = r.s.value.trim();
        if (!s) continue;
        per[s] = { rr: r.rr.value, points: r.points.value, lock_points: r.lock.value };
      }
      const body = { on: on.checked, mode: mode.value, rr: num(rr.value), points: num(pts.value), lock_points: num(lock.value),
        symbols: syms.value, per_symbol: per };
      ok.disabled = true;
      try {
        const res = await api(acctUrl("autobe"), { method: "POST", body: JSON.stringify(body) });
        const j = await res.json().catch(() => ({}));
        if (!res.ok) { err.textContent = j.detail || `บันทึกไม่ได้ (${res.status})`; return; }
        be.cfg = { ...be.cfg, ...j };
        paintAutoBE();
        close();
        toast(j.on ? "✓ เปิด Auto BE แล้ว" : "✓ ปิด Auto BE แล้ว");
      } finally { ok.disabled = false; }
    };
  });
}

function onAutoBEEvent(ev) {
  const d = state.digits[ev.symbol] ?? 5;
  if (ev.ok) toast(`🛡 Auto BE #${ev.ticket} ${ev.symbol}: SL → ${Number(ev.sl).toFixed(d)}`);
  else toast(`Auto BE #${ev.ticket} ไม่สำเร็จ: ${ev.message}`, false);
}

// ---------- alert เส้นราคา ----------
const pa = { items: [], timer: null };

async function loadPriceAlerts() {
  try {
    const r = await api("/api/palerts");
    if (r.ok) pa.items = await r.json();
  } catch (_) { return; }
  syncLines();
}

function priceAlertsFor(symbol) {   // เส้นสีส้มของ alert ราคา (alert ที่ผูกกับเส้นวาด ใช้เส้นนั้นแสดงแทน)
  return pa.items.filter((a) => a.on && a.acct === state.acct && a.symbol === symbol && (a.kind || "level") === "level" && a.src !== "drawing");
}

// ราคาบนเส้นเทรนด์ ณ เวลา t (วินาที) — ตรงกับ lineValue() ใน alerts/alert_service.js
function alertLineValue(a, t) {
  const L = a.p1.t <= a.p2.t ? a.p1 : a.p2, R = a.p1.t <= a.p2.t ? a.p2 : a.p1;
  if (a.ext !== "both" && t < L.t) return null;
  if ((a.ext || "none") === "none" && t > R.t) return null;
  return a.p1.v + (a.p2.v - a.p1.v) * (t - a.p1.t) / (a.p2.t - a.p1.t);
}

function alertDesc(a, d) {
  const f = (v) => Number(v).toFixed(d);
  if (a.kind === "box") return `กรอบ ${f(a.bottom)} – ${f(a.top)}`;
  if (a.kind === "line") {
    const v = alertLineValue(a, Date.now() / 1000);
    return `เส้นเทรนด์ ${a.dir === "up" ? "▲" : "▼"}${v != null ? ` (ตอนนี้ ≈ ${f(v)})` : " (เส้นหมดช่วงแล้ว)"}`;
  }
  return `${a.dir === "up" ? "▲" : "▼"} ${f(a.level)}`;
}

function alertDirNow(a) {
  if (a.kind === "box") return "enter";
  const q = state.quotes[a.symbol];
  const v = a.kind === "line" ? alertLineValue(a, Date.now() / 1000) : a.level;
  return q && v != null && v < q.bid ? "down" : "up";
}

// รูปร่าง alert จากเส้น/กล่องที่วาด: { body } หรือ { error } — ใช้ทั้งตอนตั้งและตอนเส้นถูกย้าย
function drawingAlertBody(o, q) {
  const P = (p) => ({ t: p.timestamp / 1000, v: p.value });
  const pts = o.points || [];
  if ((o.name === "horizontalStraightLine" || o.name === "horizontalRayLine") && pts.length) {
    const level = pts[0].value;
    return { body: { kind: "level", level, dir: q && level < q.bid ? "down" : "up" } };
  }
  if (["segment", "rayLine", "straightLine"].includes(o.name) && pts.length >= 2) {
    if (o.name === "rayLine" && pts[1].timestamp <= pts[0].timestamp) return { error: "Ray นี้ชี้ไปทางซ้าย (อดีต) ราคาไม่มีทางตัดอีก — วาด Ray ไปทางขวาแทน" };
    const body = { kind: "line", p1: P(pts[0]), p2: P(pts[1]), ext: o.name === "segment" ? "none" : o.name === "rayLine" ? "right" : "both" };
    const v = alertLineValue(body, Date.now() / 1000);
    if (v == null) return { error: "เส้นนี้สิ้นสุดก่อนเวลาปัจจุบัน — ใช้ Ray หรือเส้นยาวสุดถ้าต้องการให้ต่อไปทางขวา" };
    body.dir = q && v < q.bid ? "down" : "up";
    return { body };
  }
  if (o.name === "rectBox" && pts.length >= 2) {
    const top = Math.max(pts[0].value, pts[1].value), bottom = Math.min(pts[0].value, pts[1].value);
    return { body: { kind: "box", top, bottom, dir: "enter" }, inside: q && q.bid >= bottom && q.bid <= top };
  }
  return { error: "ตั้ง alert ได้กับ เส้นเทรนด์ / Ray / เส้นยาวสุด / เส้นแนวนอน / กล่อง" };
}

// เลือกเส้น/กล่องบนกราฟ แล้วกด 🔔 -> alert ผูกกับเส้นนั้น (ลบเส้น = ลบ alert, ย้ายเส้น = alert ย้ายตาม)
async function createDrawingAlert(panel, id) {
  const o = panel.chart.getOverlays({ id })[0];
  if (!o || !o.points?.length) return;
  const sym = panel.symbol;
  const q = state.quotes[sym];
  if (!q) { toast("ยังไม่มีราคา — เพิ่ม symbol นี้ใน Watchlist", false); return; }
  if (o.extendData?.alertId && pa.items.some((a) => a.id === o.extendData.alertId && a.on)) { toast("เส้นนี้มี alert อยู่แล้ว", false); return; }
  const g = drawingAlertBody(o, q);
  if (g.error) { toast(g.error, false); return; }
  if (g.inside) { toast("ราคาอยู่ในกรอบอยู่แล้ว — alert แบบกรอบแจ้งตอนราคาเข้ามา", false); return; }
  const r = await api("/api/palerts", { method: "POST", body: JSON.stringify({ acct: state.acct, symbol: sym, src: "drawing", ...g.body }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { toast(j.detail || "ตั้ง alert ไม่ได้", false); return; }
  pa.items.push(j);
  panel.linkDrawingAlert(id, j.id);
  toast(`🔔 ตั้ง alert ${sym}: ${alertDesc(j, state.digits[sym] ?? 5)} — ผูกกับเส้นนี้ (ย้าย = ย้ายตาม, ลบ = ยกเลิก)`);
}

// หลังบันทึกเส้นของ symbol หนึ่ง: alert ที่ผูกกับเส้น — เส้นหาย = ลบ, ตำแหน่งเปลี่ยน = อัปเดต
async function syncDrawingAlerts(symbol, overlays) {
  const byId = new Map();
  for (const o of overlays) if (o.extendData && typeof o.extendData === "object" && o.extendData.alertId) byId.set(o.extendData.alertId, o);
  const mine = pa.items.filter((a) => a.src === "drawing" && a.acct === state.acct && a.symbol === symbol);
  const q = state.quotes[symbol];
  const same = (a, b) => Math.abs(a - b) <= Math.abs(b) * 1e-9 + 1e-9;
  let changed = false;
  for (const a of mine) {
    const o = byId.get(a.id);
    if (!o) {   // เส้นถูกลบ (ลบเอง / ลบทั้งหมด / ย้อนกลับ)
      await api(`/api/palerts/${encodeURIComponent(a.id)}`, { method: "DELETE" }).catch(() => {});
      pa.items = pa.items.filter((x) => x.id !== a.id);
      if (a.on) toast(`ยกเลิก alert ${symbol} (${alertDesc(a, state.digits[symbol] ?? 5)}) เพราะลบเส้นแล้ว`);
      changed = true;
      continue;
    }
    const g = drawingAlertBody(o, q);
    if (g.error) continue;
    const b = g.body;
    const moved = b.kind === "level" ? !same(a.level, b.level)
      : b.kind === "box" ? !same(a.top, b.top) || !same(a.bottom, b.bottom)
      : !same(a.p1.t, b.p1.t) || !same(a.p1.v, b.p1.v) || !same(a.p2.t, b.p2.t) || !same(a.p2.v, b.p2.v) || a.ext !== b.ext;
    if (moved) {
      const r = await api(`/api/palerts/${encodeURIComponent(a.id)}`, { method: "PUT", body: JSON.stringify(b) });
      if (r.ok) { Object.assign(a, await r.json()); changed = true; }
    }
  }
  if (changed) syncLines();
}
function priceAlertLines(symbol) {
  const d = state.digits[symbol] ?? 5;
  return priceAlertsFor(symbol).map((a) => ({
    key: a.id, value: a.level, color: "#ff9800", dashed: true, ref: { id: a.id },
    chips: [chip("main", `🔔 ${a.dir === "up" ? "▲" : "▼"} ${Number(a.level).toFixed(d)}${a.note ? " · " + a.note : ""}`, "#ff9800"), chip("x", "✕", "#8a91a0")],
  }));
}

function alertDir(symbol, level) {
  const q = state.quotes[symbol];
  return q && level < q.bid ? "down" : "up";
}

async function addPriceAlert(symbol, level) {
  const d = state.digits[symbol] ?? 5;
  level = Number(Number(level).toFixed(d));
  const r = await api("/api/palerts", { method: "POST", body: JSON.stringify({ acct: state.acct, symbol, level, dir: alertDir(symbol, level) }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { toast(j.detail || "ตั้ง alert ไม่ได้", false); return; }
  toast(`🔔 ตั้ง alert ${symbol} ที่ ${level.toFixed(d)} — ลากเส้นเพื่อย้ายได้`);
  pa.items.push(j);
  syncLines();
}

async function updatePriceAlert(id, patch) {
  const r = await api(`/api/palerts/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(patch) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) toast(j.detail || "แก้ alert ไม่ได้", false);
  await loadPriceAlerts();
}

async function deletePriceAlert(id) {
  await api(`/api/palerts/${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => {});
  pa.items = pa.items.filter((a) => a.id !== id);
  syncLines();
}

function editPriceAlert(a) {
  const d = state.digits[a.symbol] ?? 5;
  openDialog(`alert ราคา ${a.symbol}`, (form, close) => {
    const lvl = mkx("input", { type: "text", inputMode: "decimal", value: Number(a.level).toFixed(d) });
    const note = mkx("input", { type: "text", value: a.note || "", maxLength: 100, placeholder: "โน้ต (แสดงใน Telegram)" });
    const del = mkx("button", { type: "button", className: "btn-ghost danger-text", textContent: "ลบ" });
    del.onclick = () => { close(); deletePriceAlert(a.id); };
    const ok = mkx("button", { type: "submit", className: "btn-primary", textContent: "บันทึก" });
    form.append(mkx("label", { className: "modal-field" }, mkx("span", { textContent: "ราคา" }), lvl),
      mkx("label", { className: "modal-field" }, mkx("span", { textContent: "โน้ต" }), note),
      mkx("div", { className: "muted small", textContent: "แจ้ง Telegram ครั้งเดียวเมื่อราคาแตะ แล้วปิดตัวเอง" }),
      mkx("div", { className: "modal-btns" }, del, ok));
    form.onsubmit = (e) => {
      e.preventDefault();
      const level = num(lvl.value);
      if (!(level > 0)) return;
      close();
      updatePriceAlert(a.id, { level, dir: alertDir(a.symbol, level), note: note.value.trim() });
    };
  }, { wide: false });
}

// เรียกจาก trade.js (group "palert")
function onPriceAlertClicked(line, key) {
  const a = pa.items.find((x) => x.id === line.ref.id);
  if (!a) return;
  if (key === "x") deletePriceAlert(a.id);
  else editPriceAlert(a);
}

function onPriceAlertDragged(line, value, settle) {
  settle();
  const a = pa.items.find((x) => x.id === line.ref.id);
  if (!a) return;
  const level = Number(Number(value).toFixed(state.digits[a.symbol] ?? 5));
  a.level = level;
  updatePriceAlert(a.id, { level, dir: alertDir(a.symbol, level) });
}

function priceAlertSection(form) {
  form.append(mkx("div", { className: "ind-group", textContent: "alert เส้นราคา (ปุ่ม 🔔 บนแถบกราฟ แล้วแตะที่ราคา)" }));
  const box = mkx("div", { className: "alert-rules" });
  const paint = () => {
    box.replaceChildren();
    const mine = pa.items.filter((a) => a.acct === state.acct).sort((x, y) => (y.on - x.on) || x.symbol.localeCompare(y.symbol));
    if (!mine.length) box.append(mkx("div", { className: "muted small", textContent: "ยังไม่มี" }));
    for (const a of mine) {
      const d = state.digits[a.symbol] ?? 5;
      const st = a.on ? "รอ" : a.fired_at ? `แตะแล้ว ${new Date(a.fired_at * 1000).toLocaleString("th-TH", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}` : "ปิด";
      const re = mkx("button", { type: "button", className: "btn-ghost ind-gear", textContent: a.on ? "ปิด" : "เปิดใหม่" });
      re.onclick = async () => { await updatePriceAlert(a.id, { on: !a.on, dir: alertDirNow(a) }); paint(); };
      const del = mkx("button", { type: "button", className: "btn-ghost ind-gear", textContent: "✕" });
      del.onclick = async () => { await deletePriceAlert(a.id); paint(); };
      box.append(mkx("div", { className: "ind-row" + (a.on ? "" : " muted") },
        mkx("span", { textContent: `${a.symbol} ${alertDesc(a, d)}${a.note ? " · " + a.note : ""} · ${st}` }),
        mkx("span", { className: "row" }, re, del)));
    }
  };
  paint();
  form.append(box);
}

// ---------- Web Push (แจ้งเตือนบนเครื่องนี้) ----------
function b64uToBytes(s) {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const raw = atob((s + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

async function pushState() {
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
    const ios = /iPhone|iPad/.test(navigator.userAgent);
    return { supported: false, why: ios ? "iPhone: ต้องเพิ่มเว็บนี้ลงหน้าจอหลัก แล้วเปิดจากไอคอน (iOS 16.4+) ก่อน" : "เบราว์เซอร์นี้ไม่รองรับ Web Push" };
  }
  const reg = await navigator.serviceWorker.getRegistration("/");
  const sub = reg ? await reg.pushManager.getSubscription() : null;
  return { supported: true, sub, perm: Notification.permission };
}

async function pushEnable() {
  const r = await api("/api/push/key");
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.detail || `server ${r.status}`);
  if ((await Notification.requestPermission()) !== "granted") throw new Error("ไม่ได้อนุญาตการแจ้งเตือน (เปิดได้ที่ตั้งค่าของเบราว์เซอร์/เครื่อง)");
  const reg = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
  await navigator.serviceWorker.ready;
  const opts = { userVisibleOnly: true, applicationServerKey: b64uToBytes(j.publicKey) };
  let sub;
  try {
    sub = await reg.pushManager.subscribe(opts);
  } catch (e1) {
    // subscription เก่าค้าง (key เปลี่ยน/เคยสมัครแล้ว) -> ยกเลิกแล้วสมัครใหม่อีกครั้ง
    const old = await reg.pushManager.getSubscription().catch(() => null);
    if (old) await old.unsubscribe().catch(() => {});
    try {
      sub = await reg.pushManager.subscribe(opts);
    } catch (e2) {
      const ua = navigator.userAgent;
      const hint = navigator.brave ? "Brave: เปิด brave://settings/privacy → \"Use Google services for push messaging\" แล้วลองใหม่"
        : /Line|FBAN|FBAV|Instagram|Telegram/i.test(ua) ? "เบราว์เซอร์ในแอป (LINE/Telegram/FB) ไม่รองรับ — เปิดด้วย Chrome หรือเพิ่มลงหน้าจอหลักใน Safari"
        : /iPhone|iPad/.test(ua) ? "iPhone: ต้องเปิดจากไอคอนบนหน้าจอหลัก (iOS 16.4+) และเปิดแจ้งเตือนของแอปนี้ใน การตั้งค่า → การแจ้งเตือน"
        : "บริการ push ของเบราว์เซอร์ปฏิเสธ — ลองปิด VPN/ตัวบล็อกโฆษณา หรือใช้ Chrome/Edge/Safari ตัวปกติ (ไม่ใช่โหมดไม่ระบุตัวตน)";
      throw new Error(`${e2.message || e2} — ${hint}`);
    }
  }
  const s = await api("/api/push/subscribe", { method: "POST", body: JSON.stringify({ subscription: sub.toJSON() }) });
  if (!s.ok) throw new Error((await s.json().catch(() => ({}))).detail || "ลงทะเบียนไม่สำเร็จ");
}

async function pushDisable() {
  const st = await pushState();
  if (st.sub) {
    await api("/api/push/unsubscribe", { method: "POST", body: JSON.stringify({ endpoint: st.sub.endpoint }) }).catch(() => {});
    await st.sub.unsubscribe().catch(() => {});
  }
}

function pushSection(form) {
  form.append(mkx("div", { className: "ind-group", textContent: "แจ้งเตือนเด้งบนเครื่องนี้ (Web Push) — ส่งพร้อม Telegram ทุกรายการ" }));
  const info = mkx("div", { className: "tk-info", textContent: "กำลังเช็ค…" });
  const btn = mkx("button", { type: "button", className: "btn-ghost", textContent: "…" });
  const test = mkx("button", { type: "button", className: "btn-ghost", textContent: "ทดสอบ" });
  const paint = async () => {
    const st = await pushState();
    if (!st.supported) { info.textContent = st.why; btn.hidden = test.hidden = true; return; }
    btn.hidden = false;
    test.hidden = !st.sub;
    info.textContent = st.sub ? "✅ เครื่องนี้รับแจ้งเตือนอยู่" : st.perm === "denied" ? "❌ เครื่องนี้บล็อกการแจ้งเตือน — เปิดในตั้งค่าเบราว์เซอร์ก่อน" : "เครื่องนี้ยังไม่รับแจ้งเตือน";
    btn.textContent = st.sub ? "ปิดบนเครื่องนี้" : "📲 เปิดแจ้งเตือนบนเครื่องนี้";
    btn.onclick = async () => {
      btn.disabled = true;
      try { st.sub ? await pushDisable() : await pushEnable(); } catch (e) { toast(String(e.message || e), false); }
      btn.disabled = false;
      paint();
    };
  };
  test.onclick = async () => {
    const r = await api("/api/push/test", { method: "POST" });
    const j = await r.json().catch(() => ({}));
    toast(j.sent ? `ส่งแล้ว ${j.sent} เครื่อง` : (j.error || j.errors?.[0] || "ส่งไม่สำเร็จ"), !!j.sent);
  };
  form.append(info, mkx("div", { className: "row" }, btn, test));
  paint().catch(() => { info.textContent = "เช็คไม่ได้"; });
}

function notifySection(form) {
  const dflt = { close: true, autobe: true, orders: true, system: true };
  const n = { ...dflt, ...store("wt.notify", {}) };
  form.append(mkx("div", { className: "ind-group", textContent: "แจ้งเตือนบัญชี → Telegram + Push (ทุกบัญชี)" }));
  for (const [k, label] of [["close", "ไม้ปิด (ชน TP/SL/ปิดเอง) พร้อมผลสุทธิ"], ["autobe", "Auto BE เลื่อน SL"],
    ["orders", "OCO ยกเลิกอีกฝั่ง / pending หมดอายุ"], ["system", "ระบบมีปัญหา (worker/MT5 หลุด, คำสั่งไม่รู้ผล, รอโบรกนาน)"]]) {
    const cb = mkx("input", { type: "checkbox", checked: !!n[k] });
    cb.onchange = () => save("wt.notify", { ...dflt, ...store("wt.notify", {}), [k]: cb.checked });
    form.append(mkx("label", { className: "chk ind-field" }, cb, label));
  }
}

// ---------- โซน R:R ของร่างออเดอร์ + เครื่องมือ Long/Short ----------
function zoneFor(panel) {
  let z = null;
  if (typeof dragLive !== "undefined" && dragLive && dragLive.symbol === panel.symbol && dragLive.entry) z = { ...dragLive };   // กำลังลากเส้น
  else if (edit && edit.symbol === panel.symbol) {
    const e = editEntry();
    if (e && (edit.sl || edit.tp)) z = { entry: e, sl: edit.sl, tp: edit.tp, side: edit.side, volume: edit.volume, symbol: edit.symbol };
  } else if (!edit) {
    const n = newOrderDraft();
    if (n.symbol === panel.symbol && n.entry && (n.sl || n.tp)) {
      const side = n.side || (n.tp ? (n.tp > n.entry ? "buy" : "sell") : (n.sl < n.entry ? "buy" : "sell"));
      z = { entry: n.entry, sl: n.sl, tp: n.tp, side, volume: n.volume, symbol: n.symbol };
    }
  }
  if (!z) return null;
  const risk = z.sl ? Math.abs(z.entry - z.sl) : 0, reward = z.tp ? Math.abs(z.tp - z.entry) : 0;
  if (!risk && !reward) return null;
  const loss = z.sl ? pnlAt(z.symbol, z.side, z.entry, z.sl, z.volume) : null, gain = z.tp ? pnlAt(z.symbol, z.side, z.entry, z.tp, z.volume) : null;
  const pct = (v) => (state.account?.balance && v != null ? ` (${Math.abs(v / state.account.balance * 100).toFixed(2)}%)` : "");
  const lot = z.volume ? ` · ${z.volume} lot` : "";
  return {
    entry: z.entry, sl: z.sl || 0, tp: z.tp || 0,
    top: z.tp ? `${risk ? `R:R 1:${(reward / risk).toFixed(2)}` : "TP"}${gain != null ? " · " + plMoney(gain) : ""}` : "",
    bottom: z.sl ? `เสี่ยง${loss != null ? " " + plMoney(loss) + pct(loss) : ""}${lot}` : "",
  };
}

function syncZones() {
  if (!state.charts) return;
  const active = state.charts.panels[state.charts.active];
  state.charts.panels.forEach((p) => { if (!p.replay) p.setZone(p === active ? zoneFor(p) : null); });   // replay จัดการโซนเอง
}

// แตะกราฟที่ราคาเข้า -> ตั้งร่าง: SL ห่าง 1 ส่วน, TP 2 ส่วน (R:R 1:2), ขนาด lot จาก Risk%
function placeRR(side, panel, price) {
  const sym = panel.symbol;
  const q = state.quotes[sym];
  if (!q) { toast("ยังไม่มีราคา — เพิ่ม symbol นี้ใน Watchlist", false); return; }
  exitEdit();
  const d = state.digits[sym] ?? 5;
  const mkt = side === "buy" ? q.ask : q.bid;
  const span = panel.visibleSpan() || mkt * 0.01;
  let entry = price, kind;
  if (Math.abs(price - mkt) < span * 0.02) { kind = "market"; entry = mkt; }
  else if (side === "buy") kind = price < mkt ? "limit" : "stop";
  else kind = price > mkt ? "limit" : "stop";
  const dist = span * 0.1;
  const sign = side === "buy" ? 1 : -1;
  const $t = (id) => document.getElementById(id);
  ticket.kind = kind;
  $t("tk-price").value = kind === "market" ? "" : entry.toFixed(d);
  $t("tk-stoplimit").value = "";
  $t("tk-sl").value = (entry - sign * dist).toFixed(d);
  $t("tk-tp").value = (entry + sign * 2 * dist).toFixed(d);
  if (ticket.mode !== "risk") { ticket.mode = "risk"; $t("tk-vol").value = store("wt.tk.risk", "1"); }
  ticket.rrSide = side;
  showTicket();
  paintTicket(); scheduleCalc(); paintEst("tk"); syncLines();
  toast(`📐 ${side === "buy" ? "Long" : "Short"} ${kind.toUpperCase()} — ลากเส้น SL/TP ปรับได้ · lot คิดจาก Risk% · กด ✓ ส่ง บนเส้น`);
}

// ---------- ไม้ในอดีตบนกราฟ ----------
const hx = { on: false, cache: {}, loading: {} };   // on อ่านจาก prefs ตอน initExtras (store อยู่ใน app.js ที่โหลดทีหลัง)
const HX_DAYS = 30;
const HX_CACHE_MS = 5 * 60000;   // /history หนักสำหรับ MT5 (ถือ GIL ทั้ง worker) — ดึงไม่บ่อย

async function pastTrades(acct) {
  const c = hx.cache[acct];
  if (c && Date.now() - c.at < HX_CACHE_MS) return c.trades;
  if (hx.loading[acct]) return hx.loading[acct];
  const now = Math.floor(Date.now() / 1000);
  hx.loading[acct] = (async () => {
    try {
      const r = await api(`/api/a/${encodeURIComponent(acct)}/history?frm=${now - HX_DAYS * 86400}&to=${now + 60}`);
      if (!r.ok) return c?.trades || [];
      const j = await r.json();
      hx.cache[acct] = { at: Date.now(), trades: j.trades.filter((t) => t.closed && t.time_open && t.time_close), ccy: j.currency };
      return hx.cache[acct].trades;
    } catch (_) { return c?.trades || []; } finally { delete hx.loading[acct]; }
  })();
  return hx.loading[acct];
}

async function syncHist() {
  if (!state.charts) return;
  if (!hx.on) { state.charts.panels.forEach((p) => p.setHist([])); return; }
  const acct = state.acct;
  const trades = await pastTrades(acct);
  if (acct !== state.acct) return;
  state.charts.panels.forEach((p) => {
    const mine = trades.filter((t) => t.symbol === p.symbol).slice(0, 300);
    p.setHist(mine.map((t) => ({ t0: t.time_open * 1000, p0: t.px_in, t1: t.time_close * 1000, p1: t.px_out,
      ext: { win: t.net >= 0, side: t.side, label: `${t.side === "buy" ? "B" : "S"} ${t.vol_in} ${plMoney(t.net)}` } })));
  });
}

let lastPosCount = 0;
function histOnPositions(rows) {
  if (rows.length < lastPosCount && hx.on) {   // มีไม้ปิด: ดึงใหม่ครั้งเดียวหลังนิ่ง 5 วิ (ปิดหลายไม้พร้อมกัน = ดึงรอบเดียว)
    clearTimeout(hx.refetch);
    hx.refetch = setTimeout(() => { delete hx.cache[state.acct]; syncHist(); }, 5000);
  }
  lastPosCount = rows.length;
}

// ---------- เทมเพลตอินดิเคเตอร์ ----------
function templateSection(form) {
  form.append(mkx("div", { className: "ind-group", textContent: "เทมเพลต (ชุดเปิด/ปิด + ค่าตั้งของทุกตัว)" }));
  const tpl = () => store("wt.indTpl", {});
  const sel = mkx("select");
  const fill = () => {
    const names = Object.keys(tpl()).sort();
    sel.replaceChildren(...(names.length ? names.map((n) => mkx("option", { value: n, textContent: n })) : [mkx("option", { value: "", textContent: "— ยังไม่มี —" })]));
  };
  fill();
  const load = mkx("button", { type: "button", className: "btn-ghost ind-gear", textContent: "ใช้" });
  load.onclick = () => {
    const t = tpl()[sel.value];
    if (!t) return;
    save("wt.ind", JSON.parse(JSON.stringify(t)));
    state.charts?.panels.forEach((p) => p.applyIndicators());
    toast(`ใช้เทมเพลต "${sel.value}" แล้ว`);
    openIndicatorList();
  };
  const del = mkx("button", { type: "button", className: "btn-ghost ind-gear", textContent: "ลบ" });
  del.onclick = () => {
    if (!sel.value || !confirm(`ลบเทมเพลต "${sel.value}"?`)) return;
    const all = { ...tpl() }; delete all[sel.value]; save("wt.indTpl", all); fill();
  };
  const name = mkx("input", { type: "text", placeholder: "ชื่อเทมเพลต", maxLength: 40 });
  const add = mkx("button", { type: "button", className: "btn-ghost ind-gear", textContent: "บันทึกชุดนี้" });
  add.onclick = () => {
    const n = name.value.trim();
    if (!n) { name.focus(); return; }
    const all = { ...tpl() };
    if (all[n] && !confirm(`ทับเทมเพลต "${n}"?`)) return;
    if (!all[n] && Object.keys(all).length >= 30) { toast("เก็บได้ไม่เกิน 30 เทมเพลต", false); return; }
    all[n] = JSON.parse(JSON.stringify(indPrefs()));
    save("wt.indTpl", all);
    name.value = "";
    fill(); sel.value = n;
    toast(`บันทึกเทมเพลต "${n}" แล้ว`);
  };
  form.append(mkx("div", { className: "tpl-row" }, sel, load, del), mkx("div", { className: "tpl-row" }, name, add));
}

// ---------- ความเสี่ยงรวม + สรุปวันนี้ ----------
function paintRisk() {
  const ccy = state.account?.currency;
  const bal = state.account?.balance || 0;
  let risk = 0, locked = 0, noSl = 0;
  for (const p of state.positions) {
    if (p.risk == null) { if (!p.sl) noSl++; continue; }
    if (p.risk < 0) risk += p.risk; else locked += p.risk;
  }
  const txt = state.positions.length
    ? `${money(risk, ccy)}${bal ? ` (${(Math.abs(risk) / bal * 100).toFixed(2)}%)` : ""}` : "–";
  const sr = document.getElementById("s-risk");
  if (sr) { sr.textContent = txt; sr.className = risk < 0 ? "down" : ""; sr.title = locked ? `ล็อกกำไรไว้แล้ว ${money(locked, ccy)}` : ""; }
  const tr = document.getElementById("top-risk");
  if (tr) {
    tr.replaceChildren();
    if (state.positions.length) {
      tr.append(mkx("span", { className: "muted", textContent: "เสี่ยง " }), mkx("b", { className: risk < 0 ? "down" : "", textContent: txt }));
      if (noSl) tr.append(mkx("b", { className: "warn", textContent: ` ⚠ ไม่มี SL ${noSl}` }));
      tr.title = "ขาดทุนรวมถ้าทุกไม้โดน SL" + (locked ? ` · ล็อกกำไรแล้ว ${money(locked, ccy)}` : "");
    }
  }
}

function renderDay(d) {
  state.day = d;
  const td = document.getElementById("top-day");
  if (td) {
    // ยอดวันนี้ = ปิดแล้ว + ไม้ที่ยังเปิดอยู่ (equity สด - balance ต้นวัน) -> นับไม้ที่เปิดเองจากแอป MT5 ด้วย
    const ccy = state.account?.currency, eq = state.account?.equity, sb = d.start_balance;
    const total = eq != null && sb > 0 ? eq - sb : d.realized;
    const pct = eq != null && sb > 0 ? Math.round(total / sb * 1e4) / 100 : d.day_pct;
    const sgn = (v) => (v > 0 ? "+" : "") + money(v, ccy);
    td.replaceChildren(mkx("span", { className: "muted", textContent: "วันนี้ " }),
      mkx("b", { className: signCls(total), textContent: sgn(total) }),
      ...(pct != null ? [mkx("span", { className: "muted", textContent: ` ${pct >= 0 ? "+" : ""}${pct}%` })] : []));
    td.title = `ปิดแล้ว ${d.closed} ไม้ ${sgn(d.realized)} · ยังเปิด ${sgn(total - d.realized)} · % เทียบ balance ต้นวัน`;
  }
  const el2 = document.getElementById("s-day");
  if (!el2) return;
  const ccy = state.account?.currency;
  el2.textContent = `${money(d.realized, ccy)} · ${d.closed} ไม้`;
  el2.className = signCls(d.realized);
  const lim = d.daily_loss_pct;
  el2.title = `ตั้งแต่ ${new Date(d.day_start * 1000).toLocaleString("th-TH", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}`
    + (d.day_pct != null ? ` · equity เทียบต้นวัน ${d.day_pct >= 0 ? "+" : ""}${d.day_pct}%` : "")
    + (lim ? ` · ลิมิตขาดทุน/วัน ${lim}% (เหลือ ${Math.max(0, lim + Math.min(0, d.day_pct ?? 0)).toFixed(2)}%)` : "");
}

// ---------- สถานะระบบ ----------
async function openHealth() {
  openDialog("🩺 สถานะระบบ", (form, close) => {
    const box = mkx("div", { className: "health", textContent: "กำลังเช็ค…" });
    const again = mkx("button", { type: "button", className: "btn-ghost", textContent: "⟳ เช็คใหม่" });
    const x = mkx("button", { type: "button", className: "btn-primary", textContent: "ปิด" });
    x.onclick = close;
    form.append(box, mkx("div", { className: "modal-btns" }, again, x));
    const run = async () => {
      box.textContent = "กำลังเช็ค…";
      let j;
      try { const r = await api("/api/health"); j = await r.json(); } catch (_) { box.textContent = "ติดต่อ gateway ไม่ได้"; return; }
      box.replaceChildren();
      const row = (ok, title, detail) => box.append(mkx("div", { className: "h-row" },
        mkx("span", { className: "h-dot " + (ok === true ? "ok" : ok === false ? "bad" : "warn") }),
        mkx("b", { textContent: title }), mkx("span", { className: "muted", textContent: detail })));
      row(true, "Gateway", `ทำงานมา ${fmtAgo(j.gateway_uptime_sec)} · เวลาเครื่องเรา ${(Date.now() / 1000 - j.server_time).toFixed(1)} วิ ต่างจาก server`);
      for (const a of j.accounts) {
        if (!a.worker) { row(false, `บัญชี ${a.name} (${a.kind})`, a.error || "worker ไม่ตอบ — pm2 ls ดู wt-worker-" + a.name); continue; }
        const off = a.server_offset_est_h;
        const offOk = off == null || off === a.server_utc_offset_h;
        const parts = [`MT5 ${a.mt5 ? "เชื่อมต่อ" : "ไม่เชื่อมต่อ"}`, `ตอบใน ${a.latency_ms} ms`,
          `เวลา server: ตั้ง UTC${fmtOff(a.server_utc_offset_h)}${off != null ? ` / วัดได้ UTC${fmtOff(off)}` : " / ยังวัดไม่ได้ (ตลาดปิด?)"}`,
          `เทรด ${a.trading ? (a.allow_real ? "ได้ (รวม REAL)" : "ได้ (ไม่รวม REAL)") : "ปิด"}`, `Auto BE ${a.autobe ? "เปิด" : "ปิด"}`,
          `MT5 ${a.mt5_mode === "subprocess" ? "แยก process" : "process เดียว"}`];
        if (a.error) parts.push(a.error);
        row(a.mt5 && offOk ? true : a.mt5 ? null : false, `บัญชี ${a.name} (${a.kind})`, parts.join(" · "));
        if (!offOk) box.append(mkx("div", { className: "tk-info bad", textContent: `⚠️ ${a.name}: เวลา server ไม่ตรง — แก้ server_utc_offset_h เป็น ${off} ใน accounts.json แล้ว restart worker` }));
      }
      const al = j.alerts;
      row(al.alive ? (al.telegram === false ? null : true) : false, "ตัวส่ง alert (wt-alerts)",
        al.alive ? `ทำงาน · ติดต่อล่าสุด ${Math.round(al.last_seen_sec)} วิที่แล้ว · Telegram ${al.telegram == null ? "?" : al.telegram ? "ตั้งแล้ว" : "ยังไม่ตั้ง TELEGRAM_TOKEN/CHAT_ID"}`
          : "ไม่ได้รัน — บน VPS: pm2 start ecosystem.config.js");
      const fl = j.flow || {};
      row(fl.connected ? (fl.last_msg_sec != null && fl.last_msg_sec < 30 ? true : null) : false, "Order flow Binance (wt-flow)",
        fl.connected ? `${(fl.symbols || []).join(", ")} · ข้อมูลล่าสุด ${fmtAgo(fl.last_msg_sec)} ที่แล้ว · ${Number(fl.trades || 0).toLocaleString()} trade ตั้งแต่เริ่ม`
          : fl.error || "ไม่ได้รัน — บน VPS: pm2 start ecosystem.config.js --only wt-flow");
      const nw = j.news;
      row(nw?.age_sec != null ? nw.age_sec < 7200 : null, "ปฏิทินข่าว", nw?.age_sec != null ? `ดึงล่าสุด ${fmtAgo(nw.age_sec)} ที่แล้ว` : "ยังไม่ได้ดึง");
      const bk = j.backup, bkAge = bk ? (Date.now() - Date.parse(`${bk}T00:00:00`)) / 864e5 : null;
      row(bk ? bkAge < 2 : null, "สำรองข้อมูลอัตโนมัติ", bk ? `ชุดล่าสุด ${bk} · เก็บ 14 วัน ที่ web_terminal\\backups` : "ยังไม่มี (สำรองครั้งแรก 1 นาทีหลังเปิด gateway)");
    };
    again.onclick = run;
    run();
  });
}
const fmtOff = (h) => `${h >= 0 ? "+" : ""}${h}`;
function fmtAgo(s) {
  if (s == null) return "–";
  if (s < 90) return `${Math.round(s)} วิ`;
  if (s < 5400) return `${Math.round(s / 60)} นาที`;
  if (s < 172800) return `${(s / 3600).toFixed(1)} ชม.`;
  return `${Math.round(s / 86400)} วัน`;
}

// ---------- ปุ่มบนแถบกราฟ ----------
function extraTools(mgr) {
  const btn = (text, title, fn) => { const b = mkx("button", { type: "button", className: "tool", textContent: text, title }); b.onclick = () => fn(b); return b; };
  const long = btn("📐L", "Long position: แตะที่ราคาเข้า -> SL/TP R:R 1:2 + lot จาก Risk%", (b) => mgr.startPick(b, (p, v) => placeRR("buy", p, v)));
  const short = btn("📐S", "Short position: แตะที่ราคาเข้า -> SL/TP R:R 1:2 + lot จาก Risk%", (b) => mgr.startPick(b, (p, v) => placeRR("sell", p, v)));
  const bell = btn("🔔", "ตั้ง alert ราคา: แตะที่ราคา -> แจ้ง Telegram เมื่อราคาแตะ", (b) => mgr.startPick(b, (p, v) => addPriceAlert(p.symbol, v)));
  const hist = btn("🕘", `แสดง/ซ่อนไม้ที่ปิดแล้ว ${HX_DAYS} วันล่าสุดบนกราฟ`, (b) => {
    hx.on = !hx.on; save("wt.showHist", hx.on); b.classList.toggle("on", hx.on); syncHist();
  });
  hist.append(mkx("span", { className: "lbl", textContent: " ไม้เก่า" }));
  hist.classList.toggle("on", hx.on);
  return [long, short, bell, hist];
}

// ---------- เริ่ม ----------
function initExtras() {
  hx.on = !!store("wt.showHist", false);
  document.getElementById("autobe-btn")?.addEventListener("click", openAutoBE);
  document.getElementById("be-all")?.addEventListener("click", breakevenAll);
  document.getElementById("nav-health")?.addEventListener("click", openHealth);
  document.getElementById("m-health")?.addEventListener("click", openHealth);
  document.getElementById("ed-be")?.addEventListener("click", () => { const x = edit && findLive("pos", edit.ticket); if (x) breakeven(x); });
  loadPriceAlerts();
  setInterval(loadPriceAlerts, 20000);
}

function onAccountSelected() {
  be.cfg = null;
  paintAutoBE();
  loadAutoBE();
  loadPriceAlerts();
  lastPosCount = 0;
  state.day = null;
  const sd = document.getElementById("s-day");
  if (sd) sd.textContent = "–";
  setTimeout(syncHist, 0);
}
