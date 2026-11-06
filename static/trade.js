// Mee Terminal — P3 ระบบเทรด: order ticket, dialog ยืนยัน, จัดการ position/pending, เส้นบนกราฟ
"use strict";

// ---------- dialog / toast ----------
function modal({ title, lines = [], fields = [], ok = "ยืนยัน", danger = false }) {
  return new Promise((resolve) => {
    const dlg = document.getElementById("modal");
    const form = dlg.querySelector("form");
    form.replaceChildren();
    const h = document.createElement("h3"); h.textContent = title; form.append(h);
    for (const l of lines) { const p = document.createElement("p"); p.className = "modal-line"; p.textContent = l; form.append(p); }
    const inputs = {};
    for (const f of fields) {
      const lab = document.createElement("label"); lab.className = "modal-field";
      const span = document.createElement("span"); span.textContent = f.label;
      const inp = document.createElement("input");
      inp.type = "text"; inp.inputMode = "decimal"; inp.value = f.value ?? ""; inp.placeholder = f.placeholder || "";
      inputs[f.name] = inp; lab.append(span, inp); form.append(lab);
    }
    const row = document.createElement("div"); row.className = "modal-btns";
    const cancel = document.createElement("button"); cancel.type = "button"; cancel.textContent = "ยกเลิก"; cancel.className = "btn-ghost";
    const go = document.createElement("button"); go.type = "submit"; go.textContent = ok; go.className = danger ? "btn-danger" : "btn-primary";
    row.append(cancel, go); form.append(row);
    const done = (v) => { dlg.close(); resolve(v); };
    cancel.onclick = () => done(null);
    dlg.oncancel = (e) => { e.preventDefault(); done(null); };
    form.onsubmit = (e) => {
      e.preventDefault();
      const out = {};
      for (const [k, inp] of Object.entries(inputs)) out[k] = inp.value.trim();
      done(out);
    };
    dlg.showModal();
    (Object.values(inputs)[0] || go).focus();
  });
}

function toast(msg, ok = true, ms = 0) {
  const box = document.getElementById("toasts");
  const t = document.createElement("div");
  t.className = "toast " + (ok ? "ok" : "bad");
  t.textContent = msg;
  box.append(t);
  setTimeout(() => t.remove(), ms || (ok ? 4000 : 9000));
}

const num = (v) => { const n = parseFloat(String(v).replace(",", ".")); return Number.isFinite(n) ? n : 0; };
const cid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random());

// คำสั่งเปิดไม้ใหม่: ส่งได้ทีละคำสั่ง + จำว่าคำสั่งล่าสุด "ไม่รู้ผล" (timeout) ไว้เตือนก่อนส่งซ้ำ
const tradeGuard = { busy: false, uncertainAt: 0 };
const UNCERTAIN_MS = 5 * 60000;

async function confirmAfterUncertain() {
  if (Date.now() - tradeGuard.uncertainAt > UNCERTAIN_MS) return true;
  const ok = await modal({ title: "⚠️ คำสั่งก่อนหน้ายังไม่รู้ผล", danger: true, ok: "ส่งอีกคำสั่ง",
    lines: ["คำสั่งล่าสุดหมดเวลา/ไม่ได้คำตอบจากโบรก — อาจยังค้างที่ server และถูก fill ทีหลัง (ไม้ซ้อน)",
      "ดูตาราง Positions / Pending และประวัติใน MT5 ก่อน", "ยังต้องการส่งคำสั่งใหม่จริงไหม?"] });
  if (ok) tradeGuard.uncertainAt = 0;
  return !!ok;
}

async function tradeCall(path, body) {
  const opening = path === "trade/order";
  if (opening && tradeGuard.busy) { toast("มีคำสั่งกำลังส่งอยู่ — รอผลก่อน (กันไม้ซ้อน)", false); return null; }
  if (opening && !(await confirmAfterUncertain())) return null;
  if (opening && typeof newsNearTrade === "function" && !(await newsNearTrade(body.symbol))) return null;
  let r;
  tradeGuard.busy = opening || tradeGuard.busy;
  try {
    r = await api(`/api/a/${encodeURIComponent(state.acct)}/${path}`, { method: "POST", body: JSON.stringify(body) });
  } catch (_) {
    if (opening) tradeGuard.uncertainAt = Date.now();
    toast("⚠️ ส่งไม่ถึงเซิร์ฟเวอร์ — ไม่แน่ใจว่าคำสั่งถึง MT5 หรือไม่ ตรวจตาราง positions/pending ก่อนส่งซ้ำ", false, 20000);
    return null;
  } finally {
    if (opening) tradeGuard.busy = false;
  }
  const j = await r.json().catch(() => ({}));
  if (r.status === 504 || j.uncertain) {
    if (opening) tradeGuard.uncertainAt = Date.now();
    toast(`⚠️ ${j.detail || j.message || "ไม่รู้ผลคำสั่ง"}`, false, 20000);
    return r.ok ? j : null;
  }
  if (!r.ok) { toast(j.detail || `ผิดพลาด ${r.status}`, false); return null; }
  const extra = j.broker_comment && j.broker_comment !== "fake" ? ` (${j.broker_comment})` : "";
  toast((j.ok ? "✓ " : "✗ ") + (j.message || "") + extra, !!j.ok);
  return j;
}

function confirmOn() { return store(`wt.confirm.${state.acct}`, true); }

// ---------- order ticket ----------
const ticket = { kind: "market", mode: "lot", calcTimer: null, calcSeq: 0, lastCalc: null };

function ticketSymbol() { return state.charts?.panels[state.charts.active]?.symbol || state.watch[0] || "XAUUSD"; }

function initTicket() {
  const $t = (id) => document.getElementById(id);
  for (const b of document.querySelectorAll("#tk-kinds button")) {
    b.addEventListener("click", () => {
      ticket.kind = b.dataset.kind;
      // pending: วางเส้นร่างที่ราคาปัจจุบันเลย แล้วค่อยลากไปที่ต้องการ
      const q = state.quotes[ticketSymbol()];
      const d = state.digits[ticketSymbol()] ?? 5;
      if (ticket.kind !== "market" && q) {
        if (!$t("tk-price").value) $t("tk-price").value = q.bid.toFixed(d);
        if (ticket.kind === "stop_limit" && !$t("tk-stoplimit").value) $t("tk-stoplimit").value = q.bid.toFixed(d);
      }
      paintTicket(); scheduleCalc(); paintEst("tk"); syncLines();
      autoRiskLines();
    });
  }
  for (const b of document.querySelectorAll("#tk-mode button")) {
    b.addEventListener("click", () => {
      ticket.mode = b.dataset.mode;
      $t("tk-vol").value = ticket.mode === "lot" ? store("wt.tk.lot", "0.01") : store("wt.tk.risk", "1");
      paintTicket(); scheduleCalc();
      autoRiskLines();
    });
  }
  for (const id of ["tk-price", "tk-stoplimit", "tk-sl", "tk-tp", "tk-vol"]) {
    $t(id).addEventListener("input", () => { scheduleCalc(); paintEst("tk"); syncLines(); });
  }
  // พิมพ์ราคาเข้าเอง: SL/TP เลื่อนตามเหมือนลากเส้น — คิดตอนพิมพ์เสร็จ (change) เทียบกับค่าตอนเริ่มแก้ (focus)
  for (const id of ["tk-price", "tk-stoplimit"]) {
    $t(id).addEventListener("focus", () => { ticket.entrySnap = newOrderDraft(); });
    $t(id).addEventListener("change", () => {
      if (isDraftEntry(id)) followDraftEntry(ticket.entrySnap);
      ticket.entrySnap = newOrderDraft();
      scheduleCalc(); paintEst("tk"); syncLines();
    });
  }
  $t("tk-vol").addEventListener("change", () => save(ticket.mode === "lot" ? "wt.tk.lot" : "wt.tk.risk", $t("tk-vol").value));
  $t("tk-buy").addEventListener("click", () => submitOrder("buy"));
  $t("tk-sell").addEventListener("click", () => submitOrder("sell"));
  $t("tk-clear").addEventListener("click", () => {
    for (const id of ["tk-price", "tk-stoplimit", "tk-sl", "tk-tp"]) $t(id).value = "";
    ticket.rrSide = null;
    ticket.auto = null;
    scheduleCalc(); syncPreview();
  });
  $t("tk-confirm").addEventListener("change", (e) => save(`wt.confirm.${state.acct}`, e.target.checked));
  $t("tk-vol").value = store("wt.tk.lot", "0.01");
  initTicketRules();
  paintTicket();
}

function paintTicket() {
  const $t = (id) => document.getElementById(id);
  for (const b of document.querySelectorAll("#tk-kinds button")) b.classList.toggle("on", b.dataset.kind === ticket.kind);
  for (const b of document.querySelectorAll("#tk-mode button")) b.classList.toggle("on", b.dataset.mode === ticket.mode);
  $t("tk-price-row").hidden = ticket.kind === "market";
  $t("tk-stoplimit-row").hidden = ticket.kind !== "stop_limit";
  $t("tk-price-label").textContent = ticket.kind === "stop_limit" ? "ราคา Stop" : "ราคา";
  $t("tk-vol-label").textContent = ticket.mode === "lot" ? "Lot" : "Risk %";
  $t("tk-confirm").checked = confirmOn();
  $t("tk-sym").textContent = ticketSymbol();
  paintTicketRules();
  paintTicketQuote();
  paintPresets();
}

function paintTicketQuote() {
  const sym = ticketSymbol();
  const q = state.quotes[sym];
  document.getElementById("tk-sym").textContent = sym;
  document.getElementById("tk-bid").textContent = q ? px(sym, q.bid) : "–";
  document.getElementById("tk-ask").textContent = q ? px(sym, q.ask) : "–";
  if (ticket.kind === "market" && !edit) paintEst("tk");
}

function ticketBody(side) {
  const $v = (id) => num(document.getElementById(id).value);
  const body = { symbol: ticketSymbol(), side, kind: ticket.kind, sl: $v("tk-sl"), tp: $v("tk-tp") };
  if (ticket.kind !== "market") body.price = $v("tk-price");
  if (ticket.kind === "stop_limit") body.stoplimit = $v("tk-stoplimit");
  if (ticket.mode === "lot") body.volume = $v("tk-vol"); else body.risk_pct = $v("tk-vol");
  return body;   // หมดอายุ / OCO ใส่ตอนส่ง (addTicketRules)
}

function scheduleCalc() {
  clearTimeout(ticket.calcTimer);
  ticket.calcTimer = setTimeout(runCalc, 300);
}

async function runCalc() {
  const info = document.getElementById("tk-info");
  const sl = num(document.getElementById("tk-sl").value);
  const q = state.quotes[ticketSymbol()];
  if (!q) { info.textContent = "ยังไม่มีราคา — เพิ่ม symbol นี้ใน Watchlist"; return; }
  // ประมาณฝั่งจาก SL: SL ต่ำกว่าราคา = buy
  const side = sl && sl > q.bid ? "sell" : "buy";
  const seq = ++ticket.calcSeq;
  let j;
  try {
    const r = await api(`/api/a/${encodeURIComponent(state.acct)}/calc`, { method: "POST", body: JSON.stringify(ticketBody(side)) });
    j = await r.json();
    if (seq !== ticket.calcSeq) return;
    if (!r.ok) { info.textContent = j.detail || "คำนวณไม่ได้"; info.className = "tk-info bad"; ticket.lastCalc = null; return; }
  } catch (_) { return; }
  ticket.lastCalc = j;
  const parts = [];
  if (j.volume) parts.push(`lot ${j.volume}`);
  if (j.risk_money != null) parts.push(`เสี่ยง ${fmt(j.risk_money)} ${j.currency} (${j.risk_pct}%)`);
  else if (!sl) parts.push("ไม่มี SL");
  const tpv = num(document.getElementById("tk-tp").value);
  const rr = sl && tpv && j.entry ? Math.abs(tpv - j.entry) / Math.abs(j.entry - sl) : null;
  if (rr && Number.isFinite(rr)) parts.push(`R:R 1:${rr.toFixed(2)}`);
  if (j.margin != null) parts.push(`margin ${fmt(j.margin)}`);
  info.textContent = parts.join(" · ") + (sl ? ` · คิดแบบ ${side.toUpperCase()}` : "");
  info.className = "tk-info";
  paintEst("tk");
  if (ticket.mode === "risk") syncLines();   // lot จาก risk% เพิ่งได้ -> อัปเดต $ บนเส้น
}

// Market + Risk%: วางเส้น SL/TP ให้เลย (ฝั่ง BUY: SL ต่ำกว่า 1 ส่วน, TP สูงกว่า 2 ส่วน) — ลากปรับได้, กด SELL = กลับด้านให้เอง
function autoRiskLines() {
  const $t = (id) => document.getElementById(id);
  if (edit || ticket.kind !== "market" || ticket.mode !== "risk" || $t("tk-sl").value || $t("tk-tp").value) return;
  const sym = ticketSymbol();
  const q = state.quotes[sym];
  if (!q) return;
  const d = state.digits[sym] ?? 5;
  const span = state.charts?.panels[state.charts.active]?.visibleSpan() || q.ask * 0.01;
  const dist = span * 0.1;
  const sl = Number((q.ask - dist).toFixed(d)), tp = Number((q.ask + 2 * dist).toFixed(d));
  $t("tk-sl").value = sl.toFixed(d);
  $t("tk-tp").value = tp.toFixed(d);
  ticket.rrSide = "buy";
  ticket.auto = { sym, sl, tp, dSl: q.ask - sl, dTp: tp - q.ask };
  scheduleCalc(); paintEst("tk"); syncLines();
}

// เส้นที่วางให้อัตโนมัติยังไม่ถูกแตะ แต่กดส่งอีกฝั่ง -> กลับด้าน SL/TP รอบราคาปัจจุบัน
function alignAutoSide(side) {
  const a = ticket.auto;
  if (!a || a.sym !== ticketSymbol()) return;
  const $t = (id) => document.getElementById(id);
  const sl = num($t("tk-sl").value), tp = num($t("tk-tp").value);
  if (sl !== a.sl || tp !== a.tp) { ticket.auto = null; return; }   // ผู้ใช้ปรับเองแล้ว ไม่ยุ่ง
  const q = state.quotes[a.sym];
  if (!q) return;
  const d = state.digits[a.sym] ?? 5;
  if (side === "sell" && sl < q.bid) {
    $t("tk-sl").value = (q.bid + a.dSl).toFixed(d);
    $t("tk-tp").value = (q.bid - a.dTp).toFixed(d);
  } else if (side === "buy" && sl > q.ask) {
    $t("tk-sl").value = (q.ask - a.dSl).toFixed(d);
    $t("tk-tp").value = (q.ask + a.dTp).toFixed(d);
  } else return;
  ticket.auto = { ...a, sl: num($t("tk-sl").value), tp: num($t("tk-tp").value) };
  ticket.rrSide = side;
  paintEst("tk"); syncLines();
}

function draftActive() {
  const v = (id) => document.getElementById(id).value;
  return ticket.kind !== "market" || !!ticket.rrSide || !!(v("tk-sl") || v("tk-tp") || v("tk-price") || v("tk-stoplimit"));
}

// แตะพื้นกราฟโดยไม่ได้ส่ง = ล้างร่าง (และเลิกแก้ไขไม้) — ปิดแผงส่งคำสั่งเฉยๆ ร่างยังอยู่
function discardDraft() {
  if (edit) exitEdit();
  else if (draftActive()) cancelDraft();
  ticket.auto = null;
}

function onChartTapped() {
  if (!edit && !draftActive()) return;
  discardDraft();
}

async function submitOrder(side) {
  alignAutoSide(side);
  const body = ticketBody(side);
  if (!addTicketRules(body)) return;
  const btn = document.getElementById(side === "buy" ? "tk-buy" : "tk-sell");
  if (confirmOn()) {
    const sym = body.symbol;
    const vol = body.volume ? `${body.volume} lot` : `risk ${body.risk_pct}%`;
    const where = body.kind === "market" ? "ราคาตลาด" : `@ ${body.price}` + (body.stoplimit ? ` → limit ${body.stoplimit}` : "");
    const lines = [`${side.toUpperCase()} ${body.kind.replace("_", " ").toUpperCase()} ${sym} ${vol} ${where}`,
      `SL ${body.sl || "–"} · TP ${body.tp || "–"}`];
    if (body.expire_ts) lines.push(`⏱ หมดอายุ ${new Date(body.expire_ts * 1000).toLocaleString("th-TH", { dateStyle: "short", timeStyle: "short" })}`);
    if (body.oco_with) lines.push(`🔗 OCO กับ #${body.oco_with}`);
    if (ticket.lastCalc?.risk_money != null) lines.push(`ความเสี่ยงโดยประมาณ ${fmt(ticket.lastCalc.risk_money)} ${ticket.lastCalc.currency}`);
    if (!(await modal({ title: `ยืนยันส่งคำสั่ง (${state.acct})`, lines, ok: side === "buy" ? "BUY" : "SELL", danger: side === "sell" }))) return;
  }
  btn.disabled = true;
  try {
    const r = await tradeCall("trade/order", { ...body, client_id: cid() });
    if (r?.ok) {   // ส่งสำเร็จ: ล้างราคา/SL/TP ทันที เส้นร่างจะได้ไม่ค้างทับเส้นของออเดอร์จริง
      for (const id of ["tk-price", "tk-stoplimit", "tk-sl", "tk-tp"]) document.getElementById(id).value = "";
      ticket.rrSide = null;
      ticket.auto = null;
      scheduleCalc(); paintEst("tk"); syncLines();
    }
  } finally {
    btn.disabled = false;
  }
}

// ---------- สเปก symbol (ใช้คิด $ ที่ระดับ SL/TP บนเส้น) ----------
const specs = {};
async function loadSpec(sym) {
  if (specs[sym] !== undefined) return specs[sym];
  specs[sym] = null;
  try {
    const r = await api(`/api/a/${encodeURIComponent(state.acct)}/symbol_spec?symbol=${encodeURIComponent(sym)}`);
    if (r.ok) { specs[sym] = await r.json(); paintEst("tk"); if (edit) paintEst("ed"); syncLines(); }
  } catch (_) { /* ลองใหม่รอบหน้า */ delete specs[sym]; }
  return specs[sym];
}

// กำไร/ขาดทุนโดยประมาณ (สกุลบัญชี) ถ้าราคาไปถึง level — ใช้ tick_value/tick_size
function pnlAt(sym, side, entry, level, volume) {
  const s = specs[sym];
  if (!s) { loadSpec(sym); return null; }
  if (!s.tick_size || !s.tick_value || !volume || !entry || !level) return null;
  return (level - entry) * (side === "buy" ? 1 : -1) * volume * s.tick_value / s.tick_size;
}

const COLORS = { buy: "#26a69a", sell: "#ef5350", sl: "#f0a030", tp: "#26a69a", pend: "#d29922", draft: "#2f81f7" };
const cur = () => document.getElementById("mode").textContent.split("·").pop()?.trim() || "";
// กำไร/ขาดทุนบนชิป: +$12.30 / -¢45.00 (plMoney() อยู่ใน app.js)
function plMoney(v) { return v == null ? "…" : `${v >= 0 ? "+" : ""}${money(v, cur())}`; }
const chipBg = () => (typeof themeIsLight === "function" && themeIsLight() ? "#ffffff" : "#15181e");   // ป้ายโปร่ง: พื้นตามธีม
const chip = (key, text, color, opts = {}) => ({ key, text, bg: opts.solid ? color : chipBg(), fg: opts.solid ? "#fff" : color, border: color, dashed: !!opts.dashed });

// ---------- โหมดแก้ไข (เลือก position/pending แล้วแก้ในช่องส่งคำสั่ง) ----------
let edit = null;   // {kind:'pos'|'ord', ticket, symbol, side, typeName, volume, entry, price, stoplimit, sl, tp, isStopLimit, focus}

function findLive(kind, ticket) {
  return kind === "pos" ? state.positions.find((p) => p.ticket === ticket) : state.orders.find((o) => o.ticket === ticket);
}

function startEdit(kind, ticket, overrides = {}) {
  const x = findLive(kind, ticket);
  if (!x) return;
  const side = kind === "pos" ? (x.type === 0 ? "buy" : "sell") : ([2, 4, 6].includes(x.type) ? "buy" : "sell");
  edit = {
    kind, ticket, symbol: x.symbol, side, typeName: TYPE_NAMES[x.type], volume: x.volume,
    entry: x.price_open, price: kind === "ord" ? x.price_open : 0, stoplimit: x.price_stoplimit || 0,
    isStopLimit: kind === "ord" && (x.type === 6 || x.type === 7), sl: x.sl || 0, tp: x.tp || 0, focus: null,
    ...overrides,
  };
  if (state.charts && state.charts.panels[state.charts.active]?.symbol !== x.symbol) state.charts.openSymbol(x.symbol);
  loadSpec(x.symbol);
  paintEdit();
  openSheet();
  if (!isMobile()) showTicket();
}

function exitEdit() { edit = null; paintEdit(); }

function editEntry() { return edit.kind === "ord" ? (edit.isStopLimit ? edit.stoplimit : edit.price) : edit.entry; }

function paintEdit() {
  const on = !!edit;
  document.getElementById("tk-new").hidden = on;
  document.getElementById("tk-edit").hidden = !on;
  if (on) {
    const $e = (id) => document.getElementById(id);
    $e("ed-title").textContent = `แก้ไข #${edit.ticket} · ${edit.typeName} ${edit.volume} ${edit.symbol}`;
    $e("ed-price-row").hidden = edit.kind !== "ord";
    $e("ed-stoplimit-row").hidden = !edit.isStopLimit;
    const d = state.digits[edit.symbol] ?? 5;
    for (const f of ["price", "stoplimit", "sl", "tp"]) {
      const inp = $e(`ed-${f}`);
      if (document.activeElement !== inp) inp.value = edit[f] ? Number(edit[f]).toFixed(d) : "";
    }
    $e("ed-closepos").textContent = edit.kind === "pos" ? "ปิด position" : "ยกเลิกคำสั่ง";
    $e("ed-partial").hidden = edit.kind !== "pos";
    paintEst("ed");
    paintPresets();
  }
  paintEst("tk");
  syncLines();
}

function paintEst(prefix) {
  let loss = null, profit = null;
  if (prefix === "ed" && edit) {
    const e = editEntry();
    if (edit.sl) loss = pnlAt(edit.symbol, edit.side, e, edit.sl, edit.volume);
    if (edit.tp) profit = pnlAt(edit.symbol, edit.side, e, edit.tp, edit.volume);
  } else if (prefix === "tk") {
    const n = newOrderDraft();
    if (n.sl) loss = pnlAt(n.symbol, n.side, n.entry, n.sl, n.volume);
    if (n.tp) profit = pnlAt(n.symbol, n.side, n.entry, n.tp, n.volume);
  }
  document.getElementById(`${prefix}-loss`).textContent = loss == null ? "–" : plMoney(loss);
  document.getElementById(`${prefix}-profit`).textContent = profit == null ? "–" : plMoney(profit);
}

async function submitEdit() {
  if (!edit) return;
  const e = edit;
  const btn = document.getElementById("ed-ok");
  btn.disabled = true;
  try {
    const r = e.kind === "pos"
      ? await tradeCall("trade/position/modify", { ticket: e.ticket, sl: e.sl || 0, tp: e.tp || 0 })
      : await tradeCall("trade/order/modify", { ticket: e.ticket, price: e.price, sl: e.sl || 0, tp: e.tp || 0,
        ...(e.isStopLimit ? { stoplimit: e.stoplimit } : {}) });
    if (r?.ok && edit === e) exitEdit();
  } finally {
    btn.disabled = false;
  }
}

function initEdit() {
  const $e = (id) => document.getElementById(id);
  for (const f of ["price", "stoplimit", "sl", "tp"]) {
    $e(`ed-${f}`).addEventListener("input", (ev) => { if (edit) { edit[f] = num(ev.target.value); edit.focus = f; paintEst("ed"); syncLines(); } });
  }
  // พิมพ์ราคาเข้าของ pending เอง: SL/TP เลื่อนตามระยะเดิม (เหมือนลากเส้น)
  for (const f of ["price", "stoplimit"]) {
    $e(`ed-${f}`).addEventListener("focus", () => { if (edit) edit.entrySnap = editEntry(); });
    $e(`ed-${f}`).addEventListener("change", () => {
      if (!edit || edit.kind !== "ord" || (f === "price" && edit.isStopLimit)) return;
      const d = state.digits[edit.symbol] ?? 5;
      Object.assign(edit, followStops(edit.entrySnap, editEntry(), null, null, edit.sl, edit.tp, d));
      edit.entrySnap = editEntry();
      paintEdit();
    });
  }
  $e("ed-ok").addEventListener("click", submitEdit);
  $e("ed-cancel").addEventListener("click", exitEdit);
  $e("ed-x").addEventListener("click", exitEdit);
  $e("ed-closepos").addEventListener("click", () => {
    const x = edit && findLive(edit.kind, edit.ticket);
    if (!x) return;
    edit.kind === "pos" ? positionAction("close", x) : orderAction("cancel", x);
  });
  $e("ed-partial").addEventListener("click", () => { const x = edit && findLive("pos", edit.ticket); if (x) positionAction("partial", x); });
}

// ---------- ออเดอร์ใหม่: ร่างจากช่องส่งคำสั่ง ----------
function newOrderDraft() {
  const v = (id) => num(document.getElementById(id).value);
  const symbol = ticketSymbol();
  const q = state.quotes[symbol];
  const sl = v("tk-sl"), tp = v("tk-tp");
  let side = null, entry = 0;
  if (ticket.kind === "market") {
    side = sl ? (q && sl > q.bid ? "sell" : "buy") : tp ? (q && tp < q.bid ? "sell" : "buy") : "buy";
    entry = q ? (side === "buy" ? q.ask : q.bid) : 0;
  } else {
    const price = v("tk-price");
    entry = ticket.kind === "stop_limit" ? v("tk-stoplimit") : price;
    if (q && price) {
      if (ticket.kind === "limit") side = price < q.bid ? "buy" : price > q.ask ? "sell" : null;
      else side = price > q.ask ? "buy" : price < q.bid ? "sell" : null;
    }
  }
  // Risk%: คิด lot ในหน้าเว็บทันทีจากระยะ SL (ลากเส้นแล้วเห็นเลย) — ไม่ได้ค่อยใช้ผลจาก server
  const volume = ticket.mode === "lot" ? v("tk-vol") : (riskLot(symbol, side, entry, sl) ?? ticket.lastCalc?.volume ?? 0);
  return { symbol, side, entry, sl, tp, volume, price: v("tk-price"), stoplimit: v("tk-stoplimit") };
}

// lot จาก Risk% = balance × % ÷ ขาดทุนต่อ 1 lot ถ้าโดน SL (ปัดลงตาม volume_step แบบเดียวกับ server)
function riskLot(symbol, side, entry, sl) {
  const pct = num(document.getElementById("tk-vol").value), bal = state.account?.balance, sp = specs[symbol];
  if (!pct || !bal || !sl || !entry || !side || !sp) return null;
  const per = Math.abs(pnlAt(symbol, side, entry, sl, 1) || 0);
  if (!per) return null;
  const step = sp.volume_step || 0.01, vmin = sp.volume_min || 0.01, vmax = sp.volume_max || 100;
  const v = Math.floor((bal * pct / 100) / per / step + 1e-9) * step;
  return Number(Math.min(vmax, Math.max(vmin, v)).toFixed(4));
}

function previewLines() {
  const lines = [];
  if (edit) {
    const s = edit.symbol, e = editEntry();
    const confirmChips = [chip("ok", "✓ ยืนยัน", COLORS.draft, { solid: true }), chip("cancel", "ยกเลิก", "#8a91a0")];
    const withConfirm = (f, chips) => (edit.focus === f ? [...chips, ...confirmChips] : chips);
    if (edit.kind === "ord") {
      const pc = [chip("main", `${edit.typeName} ${edit.volume}`, COLORS.draft, { solid: true })];
      if (!edit.tp) pc.push(chip("tp", "TP", COLORS.tp, { dashed: true }));
      if (!edit.sl) pc.push(chip("sl", "SL", COLORS.sl, { dashed: true }));
      lines.push({ key: "ed:price", value: edit.price, color: COLORS.draft, dashed: true, field: "price", chips: [...pc, ...confirmChips] });
      if (edit.isStopLimit) lines.push({ key: "ed:stoplimit", value: edit.stoplimit, color: COLORS.draft, dashed: true, field: "stoplimit",
        chips: withConfirm("stoplimit", [chip("main", "LIMIT", COLORS.draft)]) });
    }
    if (edit.sl) lines.push({ key: "ed:sl", value: edit.sl, color: COLORS.sl, dashed: true, field: "sl",
      chips: withConfirm("sl", [chip("main", "SL", COLORS.sl), chip("pl", plMoney(pnlAt(s, edit.side, e, edit.sl, edit.volume)), COLORS.sl), chip("x", "✕", "#8a91a0")]) });
    if (edit.tp) lines.push({ key: "ed:tp", value: edit.tp, color: COLORS.tp, dashed: true, field: "tp",
      chips: withConfirm("tp", [chip("main", "TP", COLORS.tp), chip("pl", plMoney(pnlAt(s, edit.side, e, edit.tp, edit.volume)), COLORS.tp), chip("x", "✕", "#8a91a0")]) });
    return { symbol: edit.symbol, lines };
  }
  const n = newOrderDraft();
  const sideTxt = n.side ? n.side.toUpperCase() : "";   // ยังอยู่ที่ราคาปัจจุบัน = ยังไม่รู้ฝั่ง ลากก่อน
  const kindTxt = ticket.kind.replace("_", " ").toUpperCase();
  if (ticket.kind !== "market" && n.price) {
    const chips = [chip("main", `${sideTxt} ${kindTxt} ${n.volume || ""}`.trim(), COLORS.draft, { solid: true })];
    if (!n.tp) chips.push(chip("tp", "TP", COLORS.tp, { dashed: true }));
    if (!n.sl) chips.push(chip("sl", "SL", COLORS.sl, { dashed: true }));
    if (n.side) chips.push(chip("ok", "✓ ส่ง", COLORS.draft, { solid: true }));
    chips.push(chip("cancel", "✕", "#8a91a0"));
    lines.push({ key: "pv:price", value: n.price, color: COLORS.draft, dashed: true, field: "tk-price", chips });
  }
  if (ticket.kind === "stop_limit" && n.stoplimit) {
    lines.push({ key: "pv:stoplimit", value: n.stoplimit, color: COLORS.draft, dashed: true, field: "tk-stoplimit", chips: [chip("main", "LIMIT", COLORS.draft)] });
  }
  if (ticket.kind === "market" && ticket.rrSide && n.entry && (n.sl || n.tp)) {   // เครื่องมือ Long/Short แบบ market: เส้นราคาเข้า + ปุ่มส่ง
    const s = (n.side || ticket.rrSide).toUpperCase();
    lines.push({ key: "pv:entry", value: n.entry, color: COLORS.draft, dashed: true, locked: true,
      chips: [chip("main", `${s} MARKET ${n.volume || ""}`.trim(), COLORS.draft, { solid: true }),
        chip("ok", "✓ ส่ง", COLORS.draft, { solid: true }), chip("cancel", "✕", "#8a91a0")] });
  }
  const side = n.side || "buy";
  if (n.sl) lines.push({ key: "pv:sl", value: n.sl, color: COLORS.sl, dashed: true, field: "tk-sl",
    chips: [chip("main", "SL", COLORS.sl), chip("pl", plMoney(pnlAt(n.symbol, side, n.entry, n.sl, n.volume)), COLORS.sl), chip("x", "✕", "#8a91a0")] });
  if (n.tp) lines.push({ key: "pv:tp", value: n.tp, color: COLORS.tp, dashed: true, field: "tk-tp",
    chips: [chip("main", "TP", COLORS.tp), chip("pl", plMoney(pnlAt(n.symbol, side, n.entry, n.tp, n.volume)), COLORS.tp), chip("x", "✕", "#8a91a0")] });
  return { symbol: n.symbol, lines };
}

// " · 2.5R" ต่อท้ายป้าย TP (เฉพาะเมื่อมี SL ฝั่งขาดทุน)
function rLabel(field, side, entry, sl, tp) {
  if (field !== "tp" || typeof rrOf !== "function") return "";
  const rr = rrOf(side === "buy", entry, sl, tp);
  return rr ? ` · ${rr.toFixed(1)}R` : "";
}

// ---------- เส้น position / pending จริง ----------
function tradeLinesFor(symbol) {
  const lines = [];
  const showTpSl = typeof setting !== "function" || setting("chart.tpsl") !== false;
  const hidden = (kind, t) => edit && edit.kind === kind && edit.ticket === t;
  for (const p of state.positions.filter((x) => x.symbol === symbol)) {
    const side = p.type === 0 ? "buy" : "sell";
    const ref = { kind: "pos", ticket: p.ticket };
    if (hidden("pos", p.ticket)) {   // กำลังแก้: เหลือเส้นราคาเข้าไว้อ้างอิง SL/TP ร่าง
      const chips = [chip("main", `${side.toUpperCase()} ${p.volume}`, COLORS[side], { solid: true }), chip("pl", plMoney(p.profit), p.profit >= 0 ? COLORS.buy : COLORS.sell)];
      if (!edit.tp) chips.push(chip("tp", "TP", COLORS.tp, { dashed: true }));
      if (!edit.sl) chips.push(chip("sl", "SL", COLORS.sl, { dashed: true }));
      chips.push(chip("ok", "✓ ยืนยัน", COLORS.draft, { solid: true }), chip("cancel", "ยกเลิก", "#8a91a0"));
      lines.push({ key: `p${p.ticket}:open`, value: p.price_open, color: COLORS[side], locked: true, ref: { ...ref, field: "open" }, chips });
      continue;
    }
    const chips = [chip("main", `${side.toUpperCase()} ${p.volume}`, COLORS[side], { solid: true }),
      chip("pl", plMoney(p.profit), p.profit >= 0 ? COLORS.buy : COLORS.sell)];
    const atBe = p.sl && (side === "buy" ? p.sl >= p.price_open : p.sl <= p.price_open);
    if (p.profit > 0 && !atBe) chips.push(chip("be", "BE", COLORS.draft, { dashed: true }));
    if (!p.tp) chips.push(chip("tp", "TP", COLORS.tp, { dashed: true }));
    if (!p.sl) chips.push(chip("sl", "SL", COLORS.sl, { dashed: true }));
    chips.push(chip("x", "✕", "#8a91a0"));
    lines.push({ key: `p${p.ticket}:open`, value: p.price_open, color: COLORS[side], locked: true, ref: { ...ref, field: "open" }, chips });
    for (const f of ["sl", "tp"]) {
      if (!p[f] || !showTpSl) continue;
      lines.push({ key: `p${p.ticket}:${f}`, value: p[f], color: COLORS[f], dashed: true, ref: { ...ref, field: f },
        chips: [chip("main", f.toUpperCase(), COLORS[f]), chip("pl", plMoney(pnlAt(symbol, side, p.price_open, p[f], p.volume)) + rLabel(f, side, p.price_open, p.sl, p.tp), COLORS[f]), chip("x", "✕", "#8a91a0")] });
    }
  }
  for (const o of state.orders.filter((x) => x.symbol === symbol)) {
    if (hidden("ord", o.ticket)) continue;
    const side = [2, 4, 6].includes(o.type) ? "buy" : "sell";
    const ref = { kind: "ord", ticket: o.ticket };
    const chips = [chip("main", `${TYPE_NAMES[o.type]} ${o.volume}`, COLORS.pend, { solid: true })];
    if (o.oco) chips.push(chip("oco", `🔗 #${o.oco}`, COLORS.pend));
    if (o.expire) chips.push(chip("exp", `⏱ ${fmtLeft(o.expire - Date.now() / 1000)}`, COLORS.pend));
    if (!o.tp) chips.push(chip("tp", "TP", COLORS.tp, { dashed: true }));
    if (!o.sl) chips.push(chip("sl", "SL", COLORS.sl, { dashed: true }));
    chips.push(chip("x", "✕", "#8a91a0"));
    lines.push({ key: `o${o.ticket}:price`, value: o.price_open, color: COLORS.pend, dashed: true, ref: { ...ref, field: "price" }, chips });
    const entry = o.price_stoplimit || o.price_open;
    for (const f of ["sl", "tp"]) {
      if (!o[f] || !showTpSl) continue;
      lines.push({ key: `o${o.ticket}:${f}`, value: o[f], color: COLORS[f], dashed: true, ref: { ...ref, field: f },
        chips: [chip("main", f.toUpperCase(), COLORS[f]), chip("pl", plMoney(pnlAt(symbol, side, entry, o[f], o.volume)) + rLabel(f, side, entry, o.sl, o.tp), COLORS[f]), chip("x", "✕", "#8a91a0")] });
    }
  }
  return lines;
}

function syncLines() {
  if (!state.charts) return;
  if (edit && !findLive(edit.kind, edit.ticket)) edit = null, paintEdit();   // ไม้ถูกปิด/fill ไปแล้ว
  const pv = previewLines();
  const active = state.charts.panels[state.charts.active];
  state.charts.panels.forEach((p) => {
    // กราฟที่กำลัง Bar Replay: ไม่แสดงเส้นออเดอร์/ร่าง/alert จริง (เส้นจำลองวาดโดย replay.js)
    p.setLines("trade", !p.replay && state.charts.showTrades ? fadeLines(tradeLinesFor(p.symbol)) : []);
    p.setLines("preview", !p.replay && p === active && p.symbol === pv.symbol ? pv.lines : []);
    p.setLines("palert", p.replay ? [] : priceAlertLines(p.symbol));
  });
  syncZones();
}
// ความทึบของเส้น/ป้าย position+pending (⚙️ ตั้งค่า -> แสดงบนกราฟ) — ตัวหนังสือบนป้ายคงทึบไว้ให้อ่านได้
function fadeLines(lines) {
  const a = Math.min(100, Math.max(10, Number(typeof setting === "function" ? setting("chart.lineAlpha") : 100) || 100)) / 100;
  if (a >= 1) return lines;
  const f = (c, k = a) => (c ? withAlpha(c, k) : c);
  return lines.map((l) => ({ ...l, color: f(l.color),
    chips: (l.chips || []).map((c) => ({ ...c, bg: f(c.bg), border: f(c.border) })) }));
}

// ชื่อเดิมที่ app.js เรียก
const syncTradeLines = syncLines;
const syncPreview = syncLines;

function defaultDistance(price, other) {
  if (other) return Math.abs(price - other);
  const span = state.charts?.panels[state.charts.active]?.visibleSpan() || 0;
  return span > 0 ? span * 0.2 : price * 0.003;   // 20% ของช่วงที่มองเห็น = อยู่ในจอเสมอ
}

// ลากออกจากชิป TP/SL: ตั้งระดับตามตำแหน่งที่ลากสด ๆ
let pullRaf = 0;
function onLinePulled(group, line, key, value) {
  if (group === "replay") { replayLinePulled(line, key, value); return; }
  const apply = () => {
    pullRaf = 0;
    if (group === "trade") {
      const { kind, ticket: t } = line.ref;
      const x = findLive(kind, t);
      if (!x) return;
      const v = Number(Number(value).toFixed(state.digits[x.symbol] ?? 5));
      if (edit && edit.kind === kind && edit.ticket === t) { edit[key] = v; edit.focus = key; paintEdit(); }
      else startEdit(kind, t, { [key]: v, focus: key });
    } else if (edit) {
      edit[key] = Number(Number(value).toFixed(state.digits[edit.symbol] ?? 5));
      edit.focus = key;
      paintEdit();
    } else {
      document.getElementById(key === "tp" ? "tk-tp" : "tk-sl").value = Number(value).toFixed(state.digits[ticketSymbol()] ?? 5);
      paintEst("tk"); syncLines(); scheduleCalc();
    }
  };
  pendingPull = apply;
  if (!pullRaf) pullRaf = requestAnimationFrame(() => pendingPull());
}
let pendingPull = () => {};

function levelFor(key, side, entry, other) {
  const sign = side === "sell" ? -1 : 1;
  const dist = defaultDistance(entry, other);
  return key === "tp" ? entry + sign * dist : entry - sign * dist;
}

function setEditLevel(key) {
  const e = editEntry();
  const lvl = levelFor(key, edit.side, e, key === "tp" ? edit.sl : edit.tp);
  edit[key] = Number(lvl.toFixed(state.digits[edit.symbol] ?? 5));
  edit.focus = key;
  paintEdit();
}

// ยกเลิกร่าง pending: ล้างราคา/SL/TP แล้วกลับไป Market (กด Limit/Stop ใหม่ = เส้นร่างขึ้นที่ราคาปัจจุบันทันที)
function cancelDraft() {
  for (const id of ["tk-price", "tk-stoplimit", "tk-sl", "tk-tp"]) document.getElementById(id).value = "";
  ticket.kind = "market";
  ticket.rrSide = null;
  ticket.auto = null;
  paintTicket(); scheduleCalc(); paintEst("tk"); syncLines();
}

function setNewLevel(key) {
  const n = newOrderDraft();
  const entry = n.entry || n.price;
  if (!entry) return;
  const lvl = levelFor(key, n.side || "buy", entry, key === "tp" ? n.sl : n.tp);
  document.getElementById(key === "tp" ? "tk-tp" : "tk-sl").value = lvl.toFixed(state.digits[n.symbol] ?? 5);
  scheduleCalc(); paintEst("tk"); syncLines();
}

// ---------- event จากเส้นบนกราฟ ----------
function onLineClicked(group, line, key) {
  if (group === "replay") { replayLineClicked(line, key); return; }
  if (group === "palert") { onPriceAlertClicked(line, key); return; }
  if (group === "trade") {
    const { kind, ticket: t, field } = line.ref;
    const x = findLive(kind, t);
    if (!x) return;
    if (key === "be" && kind === "pos") { breakeven(x); return; }
    if ((key === "oco" || key === "exp") && kind === "ord") { openPendingRules(x); return; }
    if (key === "x") {
      if (field === "open" || field === "price") kind === "pos" ? positionAction("close", x) : orderAction("cancel", x);
      else startEdit(kind, t, { [field]: 0, focus: field });   // ลบ SL/TP = ร่างก่อน กดยืนยันอีกที
    } else if (key === "ok" || key === "cancel") {
      if (edit) key === "ok" ? submitEdit() : exitEdit();
    } else if ((key === "tp" || key === "sl") && edit && edit.kind === kind && edit.ticket === t) {
      setEditLevel(key);   // กำลังแก้ไม้นี้อยู่: เพิ่มระดับในร่างเดิม ไม่ล้างค่าที่ลากไว้
    } else if (key === "tp" || key === "sl") {
      const side = kind === "pos" ? (x.type === 0 ? 1 : -1) : ([2, 4, 6].includes(x.type) ? 1 : -1);
      const entry = x.price_stoplimit || x.price_open;
      const dist = defaultDistance(entry, key === "tp" ? x.sl : x.tp);
      const lvl = key === "tp" ? entry + side * dist : entry - side * dist;
      startEdit(kind, t, { [key]: Number(lvl.toFixed(state.digits[x.symbol] ?? 5)), focus: key });
    } else {
      startEdit(kind, t);
    }
    return;
  }
  // preview
  if (key === "tp" || key === "sl") { edit ? setEditLevel(key) : setNewLevel(key); return; }
  if (key === "ok") { edit ? submitEdit() : (newOrderDraft().side && submitOrder(newOrderDraft().side)); return; }
  if (key === "cancel") {
    if (edit) exitEdit();
    else cancelDraft();
    return;
  }
  if (key === "x") {
    if (edit) { edit[line.field] = 0; edit.focus = line.field; paintEdit(); }
    else { document.getElementById(line.field).value = ""; scheduleCalc(); paintEst("tk"); syncLines(); }
  }
}

// ระหว่างลากเส้น TP/SL (ไม้จริง / ร่าง / แก้ไข): โซน R:R ตามเส้น + คืนชิปที่มีกำไร/ขาดทุนใหม่
let dragLive = null;
// ลากราคาเข้าของ pending / ร่าง: SL/TP เลื่อนตามสดๆ (คิดจากค่าตอนเริ่มลาก ไม่สะสม)
let dragFollow = null;   // { line, base: { entry, side, sl, tp }, ref }
function entryDragKind(group, line) {
  if (group === "trade") {
    const { kind, ticket: t, field } = line.ref || {};
    const x = kind === "ord" && findLive(kind, t);
    return x && (field === "stoplimit" || (field === "price" && !x.price_stoplimit)) ? "trade" : null;
  }
  if (group !== "preview") return null;
  if (edit) return edit.kind === "ord" && (line.field === "stoplimit" || (line.field === "price" && !edit.isStopLimit)) ? "edit" : null;
  return line.field === "tk-stoplimit" || (line.field === "tk-price" && ticket.kind !== "stop_limit") ? "draft" : null;
}

function draftSideAt(price, fallback) {
  const q = state.quotes[ticketSymbol()];
  if (!q || ticket.kind === "stop_limit") return fallback;
  if (ticket.kind === "limit") return price < q.bid ? "buy" : price > q.ask ? "sell" : fallback;
  return price > q.ask ? "buy" : price < q.bid ? "sell" : fallback;
}

function followMoving(group, line, value) {
  const k = entryDragKind(group, line);
  if (!k) return false;
  if (!dragFollow || dragFollow.line !== line) {
    if (k === "trade") {
      const x = findLive("ord", line.ref.ticket);
      dragFollow = { line, kind: k, base: { entry: x.price_stoplimit || x.price_open, sl: x.sl, tp: x.tp }, sym: x.symbol, t: x.ticket };
    } else if (k === "edit") dragFollow = { line, kind: k, base: { entry: editEntry(), sl: edit.sl, tp: edit.tp }, sym: edit.symbol };
    else { const n = newOrderDraft(); dragFollow = { line, kind: k, base: { entry: n.entry, side: n.side || sideFromStops(n.entry, n.sl, n.tp), sl: n.sl, tp: n.tp }, sym: n.symbol }; }
  }
  const b = dragFollow.base, d = state.digits[dragFollow.sym] ?? 5;
  if (!b.entry) return true;
  if (k === "trade") {
    const f = followStops(b.entry, value, null, null, b.sl, b.tp, d);
    state.charts?.panels.forEach((p) => {
      if (b.sl) p.moveLineTo("trade", `o${dragFollow.t}:sl`, f.sl);
      if (b.tp) p.moveLineTo("trade", `o${dragFollow.t}:tp`, f.tp);
    });
  } else if (k === "edit") {
    Object.assign(edit, followStops(b.entry, value, null, null, b.sl, b.tp, d));
    syncLines();
  } else {
    const side = draftSideAt(value, b.side);
    const f = followStops(b.entry, value, b.side, side, b.sl, b.tp, d);
    if (f.sl) document.getElementById("tk-sl").value = f.sl.toFixed(d);
    if (f.tp) document.getElementById("tk-tp").value = f.tp.toFixed(d);
    paintEst("tk"); syncLines();
    // ป้ายบนเส้นเปลี่ยน BUY <-> SELL ทันทีระหว่างลาก (โครงชิปเดิม เปลี่ยนแค่ข้อความ)
    if (line.field === "tk-price" && side && ticket.kind !== "stop_limit")
      return (line.chips || []).map((c) => (c.key === "main" ? { ...c, text: c.text.replace(/^((BUY|SELL) )?/, `${side.toUpperCase()} `) } : c));
  }
  return true;
}

// ปล่อยเส้น: คืนค่า SL/TP ก่อนลาก แล้วให้ขั้นตอนปกติคิดจากค่าเดิม (ไม่เลื่อนซ้ำ)
function followRestore(line) {
  const f = dragFollow;
  dragFollow = null;
  if (!f || f.line !== line) return;
  if (f.kind === "edit" && edit) { edit.sl = f.base.sl; edit.tp = f.base.tp; }
  if (f.kind === "draft") {
    const d = state.digits[f.sym] ?? 5;
    document.getElementById("tk-sl").value = f.base.sl ? f.base.sl.toFixed(d) : "";
    document.getElementById("tk-tp").value = f.base.tp ? f.base.tp.toFixed(d) : "";
  }
}

function onLineMoving(group, line, value) {
  if (group === "replay") return replayLineMoving(line, value);
  const fm = followMoving(group, line, value);
  if (fm) return Array.isArray(fm) ? fm : null;
  let z = null, field = null;
  if (group === "trade") {
    const { kind, ticket: t, field: f } = line.ref;
    const x = (f === "sl" || f === "tp") && findLive(kind, t);
    if (!x) return null;
    field = f;
    z = { symbol: x.symbol, side: kind === "pos" ? (x.type === 0 ? "buy" : "sell") : ([2, 4, 6].includes(x.type) ? "buy" : "sell"),
      entry: kind === "pos" ? x.price_open : (x.price_stoplimit || x.price_open), volume: x.volume, sl: x.sl || 0, tp: x.tp || 0 };
  } else if (group === "preview") {
    field = { sl: "sl", "tk-sl": "sl", tp: "tp", "tk-tp": "tp" }[line.field];
    if (!field) return null;
    if (edit) z = { symbol: edit.symbol, side: edit.side, entry: editEntry(), volume: edit.volume, sl: edit.sl, tp: edit.tp };
    else {
      const n = newOrderDraft();
      if (!n.entry) return null;
      const guess = field === "sl" ? (value < n.entry ? "buy" : "sell") : (value > n.entry ? "buy" : "sell");
      z = { symbol: n.symbol, side: n.side || ticket.rrSide || guess, entry: n.entry, volume: n.volume, sl: n.sl, tp: n.tp };
      if (field === "sl" && ticket.mode === "risk") {
        // Risk%: lot / เงิน เปลี่ยนตามระยะ SL สดๆ — เขียนค่าเข้าช่อง SL ด้วย ป้ายราคาเข้า/TP และช่องประมาณการในแผงจะอัปเดตตาม
        z.volume = riskLot(z.symbol, z.side, z.entry, value) ?? z.volume;
        document.getElementById("tk-sl").value = Number(value).toFixed(state.digits[z.symbol] ?? 5);
        z[field] = value; dragLive = z;
        paintEst("tk"); syncLines();
        const pl = pnlAt(z.symbol, z.side, z.entry, value, z.volume);
        return (line.chips || []).map((c) => (c.key === "pl" ? { ...c, text: `${plMoney(pl)} · ${z.volume} lot` } : c));
      }
    }
  } else return null;
  z[field] = value;
  dragLive = z;
  syncZones();
  const pl = pnlAt(z.symbol, z.side, z.entry, value, z.volume);
  return (line.chips || []).map((c) => (c.key === "pl" ? { ...c, text: plMoney(pl) } : c));
}

function onLineDragged(group, line, value, revert, settle) {
  if (group === "replay") { replayLineDragged(line, value, settle); return; }
  followRestore(line);
  if (dragLive) { dragLive = null; syncZones(); }
  if (group === "palert") { onPriceAlertDragged(line, value, settle); return; }
  if (group === "trade") {
    revert();   // เส้นจริงกลับที่เดิม แล้วเปิดโหมดแก้ไขพร้อมค่าใหม่ (ยืนยันจากเส้นร่างหรือปุ่มในแผง)
    const { kind, ticket: t, field } = line.ref;
    const x = findLive(kind, t), d = state.digits[x?.symbol] ?? 5;
    const v = Number(Number(value).toFixed(d));
    const over = { [field]: v, focus: field };
    // ลากราคาเข้าของ pending: SL/TP เลื่อนตามด้วยระยะเดิม
    const isEntry = kind === "ord" && x && (field === "stoplimit" || (field === "price" && !x.price_stoplimit));
    if (isEntry) Object.assign(over, followStops(x.price_stoplimit || x.price_open, v, null, null, x.sl, x.tp, d));
    startEdit(kind, t, over);
    return;
  }
  settle();
  if (edit) {
    const d = state.digits[edit.symbol] ?? 5, before = editEntry();
    edit[line.field] = Number(Number(value).toFixed(d));
    if (edit.kind === "ord" && (line.field === "stoplimit" || (line.field === "price" && !edit.isStopLimit)))
      Object.assign(edit, followStops(before, editEntry(), null, null, edit.sl, edit.tp, d));
    edit.focus = line.field;
    paintEdit();
  } else {
    const d = state.digits[ticketSymbol()] ?? 5, before = newOrderDraft();
    document.getElementById(line.field).value = Number(value).toFixed(d);
    if (isDraftEntry(line.field)) followDraftEntry(before);
    scheduleCalc(); paintEst("tk"); syncLines();
  }
}

function isDraftEntry(id) { return id === "tk-stoplimit" || (id === "tk-price" && ticket.kind !== "stop_limit"); }

// ร่างใหม่: SL/TP ตามราคาเข้า — เลื่อนข้ามราคาตลาดจน Buy Limit <-> Sell Limit (หรือ Stop) สลับ = SL/TP กลับด้านเอง
function followDraftEntry(before) {
  if (!before?.entry) return;
  const d = state.digits[ticketSymbol()] ?? 5, after = newOrderDraft();
  const f = followStops(before.entry, after.entry, before.side || sideFromStops(before.entry, before.sl, before.tp), after.side, before.sl, before.tp, d);
  if (f.sl) document.getElementById("tk-sl").value = f.sl.toFixed(d);
  if (f.tp) document.getElementById("tk-tp").value = f.tp.toFixed(d);
}

// ร่างวางที่ราคาปัจจุบันพอดี (ยังไม่รู้ฝั่ง): ดูฝั่งจาก SL/TP ที่ตั้งไว้ (SL ใต้ / TP เหนือราคาเข้า = buy)
function sideFromStops(entry, sl, tp) {
  if (!entry) return null;
  if (sl) return sl < entry ? "buy" : "sell";
  if (tp) return tp > entry ? "buy" : "sell";
  return null;
}

// ราคาเข้าเลื่อน -> SL/TP เลื่อนตามระยะเดิม; ฝั่งเปลี่ยน (buy <-> sell) = กลับด้านรอบราคาเข้า
function followStops(oldEntry, newEntry, oldSide, newSide, sl, tp, digits) {
  if (!oldEntry || !newEntry) return {};
  const k = oldSide && newSide && oldSide !== newSide ? -1 : 1;
  const mv = (v) => (v ? Number((newEntry + (v - oldEntry) * k).toFixed(digits)) : v);
  return { sl: mv(sl), tp: mv(tp) };
}

function onPanelChanged() {
  if (!state.charts) return;
  if (edit && state.charts.panels[state.charts.active]?.symbol !== edit.symbol) exitEdit();
  paintTicket(); scheduleCalc(); syncLines(); syncHist();
}

function actionBtn(text, title, fn, cls = "") {
  const b = document.createElement("button");
  b.textContent = text; b.title = title; b.className = "act " + cls;
  b.addEventListener("click", (e) => { e.stopPropagation(); fn(); });
  return b;
}

// ---------- ปุ่มในตาราง ----------
async function positionAction(kind, p) {
  if (kind === "sltp") {
    const v = await modal({ title: `SL/TP #${p.ticket} ${p.symbol}`, lines: ["เว้นว่างหรือ 0 = ไม่ตั้ง"],
      fields: [{ name: "sl", label: "SL", value: p.sl || "" }, { name: "tp", label: "TP", value: p.tp || "" }], ok: "บันทึก" });
    if (v) tradeCall("trade/position/modify", { ticket: p.ticket, sl: num(v.sl), tp: num(v.tp) });
  } else if (kind === "partial") {
    openPartial(p);
  } else if (kind === "close") {
    if (confirmOn() && !(await modal({ title: "ปิด position", lines: [`#${p.ticket} ${p.symbol} ${p.volume} lot กำไร ${fmt(p.profit)}`], ok: "ปิด", danger: true }))) return;
    tradeCall("trade/position/close", { ticket: p.ticket, client_id: cid() });
  }
}

async function orderAction(kind, o) {
  if (kind === "edit") {
    const fields = [{ name: "price", label: "ราคา", value: o.price_open }, { name: "sl", label: "SL", value: o.sl || "" }, { name: "tp", label: "TP", value: o.tp || "" }];
    const v = await modal({ title: `แก้ pending #${o.ticket} ${o.symbol}`, fields, ok: "บันทึก" });
    if (v) tradeCall("trade/order/modify", { ticket: o.ticket, price: num(v.price), sl: num(v.sl), tp: num(v.tp) });
  } else if (kind === "cancel") {
    if (confirmOn() && !(await modal({ title: "ยกเลิก pending", lines: [`#${o.ticket} ${TYPE_NAMES[o.type]} ${o.symbol} ${o.volume} @ ${o.price_open}`], ok: "ยกเลิกคำสั่ง", danger: true }))) return;
    tradeCall("trade/order/cancel", { ticket: o.ticket });
  }
}
