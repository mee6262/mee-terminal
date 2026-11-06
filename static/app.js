// Mee Terminal — P1 realtime (account / watchlist / positions / pending)
"use strict";

const $ = (id) => document.getElementById(id);
const TYPE_NAMES = ["BUY", "SELL", "BUY LIMIT", "SELL LIMIT", "BUY STOP", "SELL STOP", "BUY STOP LIMIT", "SELL STOP LIMIT"];
const STALE_MS = 60000;

async function api(path, opts = {}) {
  const r = await fetch(path, {
    ...opts,
    headers: { "Content-Type": "application/json", "X-Requested-With": "wt", ...(opts.headers || {}) },
  });
  if (r.status === 401) { location.href = "/login"; throw new Error("unauthorized"); }
  return r;
}

// ---------- การตั้งค่า: เก็บที่ server (ใช้ได้ทุกเครื่อง) + สำเนาใน localStorage ไว้ใช้ตอนต่อ server ไม่ได้ ----------
const prefs = {};
const prefTimers = {};
let prefsFromServer = false;

function localGet(key) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : undefined; } catch (_) { return undefined; }
}
function localSet(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch (_) {} }

function store(key, fallback) {
  if (key in prefs) return prefs[key];
  const v = localGet(key);
  return v === undefined ? fallback : v;
}

function save(key, value) {
  prefs[key] = value;
  localSet(key, value);
  clearTimeout(prefTimers[key]);
  prefTimers[key] = setTimeout(() => {
    api(`/api/prefs/${encodeURIComponent(key)}`, { method: "PUT", body: JSON.stringify({ value }) }).catch(() => {});
  }, 500);
}

async function loadPrefs() {
  try {
    const r = await api("/api/prefs");
    if (!r.ok) return;
    const server = await r.json();
    prefsFromServer = true;
    if (Object.keys(server).length === 0) {
      // ครั้งแรก: อัปโหลดการตั้งค่าของเครื่องนี้ขึ้น server
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith("wt.")) { const v = localGet(k); if (v !== undefined) save(k, v); }
      }
      return;
    }
    for (const [k, v] of Object.entries(server)) { prefs[k] = v; localSet(k, v); }
  } catch (_) { /* ออฟไลน์: ใช้ localStorage ไปก่อน */ }
}

const state = {
  acct: null,
  ws: null,
  retry: 0,
  digits: {},          // symbol -> digits
  quotes: {},          // symbol -> {bid, ask, prevBid, recv}
  watch: [],
  lastError: "",
  positions: [],
  orders: [],
};

function fmt(n, d = 2) {
  if (n === null || n === undefined || Number.isNaN(n)) return "–";
  return Number(n).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
}
function px(sym, v) { return v ? Number(v).toFixed(state.digits[sym] ?? 5) : "–"; }
// สกุลเงินบัญชี -> สัญลักษณ์ (ไม่รู้จัก = ต่อท้ายด้วยรหัสสกุล)
const CCY_SYM = { USD: "$", USC: "¢", USX: "¢", THB: "฿", EUR: "€", GBP: "£", JPY: "¥", CNY: "¥", INR: "₹", KRW: "₩",
  IDR: "Rp", VND: "₫", PHP: "₱", MYR: "RM", SGD: "S$", AUD: "A$", CAD: "C$", NZD: "NZ$", HKD: "HK$", CHF: "CHF ", BTC: "₿" };
function money(n, ccy, d = 2) {
  if (n === null || n === undefined || Number.isNaN(n)) return "–";
  const v = fmt(Math.abs(n), d);
  const sg = n < 0 ? "-" : "";
  const sym = CCY_SYM[(ccy || "").toUpperCase()];
  return sym ? `${sg}${sym}${v}` : `${sg}${v}${ccy ? " " + ccy : ""}`;
}
function signCls(v) { return v > 0 ? "up" : v < 0 ? "down" : ""; }
function el(tag, text, cls) {
  const e = document.createElement(tag);
  if (text !== undefined) e.textContent = text;
  if (cls) e.className = cls;
  return e;
}

// ---------- status ----------
function setDot(id, ok) {
  const cls = "dot " + (ok === null ? "" : ok ? "ok" : "bad");
  $(id).className = cls;
  // รายละเอียดตอนเอาเมาส์ชี้จุด (แถบบน)
  const tip = id === "dot-ws" ? "tip-ws" : "tip-mt5";
  $(tip).className = cls;
  $(`${tip}-t`).textContent = ok === null ? (id === "dot-ws" ? "กำลังต่อ…" : "–")
    : ok ? "เชื่อมต่อแล้ว" : id === "dot-ws" ? "หลุด — กำลังต่อใหม่" : (state.lastError || "ไม่เชื่อมต่อ");
}
function banner(msg) { const b = $("banner"); b.hidden = !msg; b.textContent = msg || ""; }

// ---------- watchlist ----------
function renderWatch() {
  const tb = $("watch");
  tb.replaceChildren();
  if (!state.watch.length) {
    const tr = el("tr"); const td = el("td", "ยังไม่มี symbol", "empty"); td.colSpan = 7; tr.append(td); tb.append(tr);
    return;
  }
  for (const sym of state.watch) {
    const tr = el("tr"); tr.dataset.sym = sym; tr.className = "clickable";
    tr.addEventListener("click", (e) => { if (e.target.tagName !== "BUTTON" && !e.target.closest(".drag")) state.charts?.openSymbol(sym); });
    const h = el("td", "⋮⋮", "drag"); h.title = "ลากเพื่อจัดเรียง";
    h.addEventListener("pointerdown", (e) => dragWatch(e, tr));
    tr.append(h, el("td", sym), el("td", "–", "r bid"), el("td", "–", "r ask"), el("td", "–", "r spr"), el("td", "–", "r age muted"));
    const td = el("td", undefined, "r"); const btn = el("button", "×"); btn.title = "ลบ";
    btn.addEventListener("click", () => removeSymbol(sym)); td.append(btn); tr.append(td);
    tb.append(tr);
    paintQuote(sym);
  }
}

// ลากที่จับ ⋮⋮ เพื่อจัดเรียง (เมาส์/นิ้ว) -> บันทึกลำดับใหม่
function dragWatch(e, tr) {
  e.preventDefault();
  const tb = $("watch");
  const id = e.pointerId;
  tr.classList.add("dragging");
  // ฟังที่ window: การย้ายแถวใน DOM ทำให้ pointer capture บนที่จับหลุด
  const move = (ev) => {
    if (ev.pointerId !== id) return;
    const rows = [...tb.querySelectorAll("tr[data-sym]")].filter((r) => r !== tr);
    const next = rows.find((r) => { const b = r.getBoundingClientRect(); return ev.clientY < b.top + b.height / 2; });
    if (next) { if (tr.nextSibling !== next) tb.insertBefore(tr, next); }
    else if (tb.lastElementChild !== tr) tb.append(tr);
    const sc = tb.closest(".scroll"), b = sc?.getBoundingClientRect();
    if (b && ev.clientY < b.top + 24) sc.scrollTop -= 8;
    else if (b && ev.clientY > b.bottom - 24) sc.scrollTop += 8;
  };
  const up = (ev) => {
    if (ev.pointerId !== id) return;
    if (ev.type === "pointerup") move(ev);
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", up);
    tr.classList.remove("dragging");
    const order = [...tb.querySelectorAll("tr[data-sym]")].map((r) => r.dataset.sym);
    if (order.join() !== state.watch.join()) { state.watch = order; saveWatch(); }
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", up);
}

function paintQuote(sym) {
  const q = state.quotes[sym];
  const tr = $("watch").querySelector(`tr[data-sym="${CSS.escape(sym)}"]`);
  if (!q || !tr) return;
  const dir = q.prevBid === undefined ? "" : q.bid > q.prevBid ? "up" : q.bid < q.prevBid ? "down" : "";
  tr.querySelector(".bid").textContent = px(sym, q.bid);
  tr.querySelector(".ask").textContent = px(sym, q.ask);
  tr.querySelector(".bid").className = "r bid " + dir;
  tr.querySelector(".ask").className = "r ask " + dir;
  const pts = Math.round((q.ask - q.bid) * Math.pow(10, state.digits[sym] ?? 5));
  tr.querySelector(".spr").textContent = pts;
}

function tickAges() {
  const now = Date.now();
  for (const tr of $("watch").querySelectorAll("tr[data-sym]")) {
    const q = state.quotes[tr.dataset.sym];
    const cell = tr.querySelector(".age");
    if (!q) { cell.textContent = "–"; continue; }
    const s = Math.floor((now - q.recv) / 1000);
    cell.textContent = s < 1 ? "สด" : s < 60 ? `${s}s` : `${Math.floor(s / 60)}m`;
    tr.classList.toggle("stale", now - q.recv > STALE_MS);
  }
}

function subscribe() {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    const bars = state.charts ? state.charts.barKeys() : [];
    // ราคาสด: กลุ่มที่เปิดอยู่ก่อน แล้วคู่บนกราฟ ไม้ที่ถือ และกลุ่มอื่น (worker รับสูงสุด 50)
    const syms = [...new Set([...state.watch, ...(state.charts?.panels.map((p) => p.symbol) || []),
      ...state.positions.map((p) => p.symbol), ...state.orders.map((o) => o.symbol), ...wgAllSymbols()])].slice(0, 50);
    state.ws.send(JSON.stringify({ op: "subscribe", symbols: syms, bars }));
  }
}

// ---------- watchlist หลายกลุ่ม: state.watch = คู่ของกลุ่มที่เปิดอยู่ ----------
// prefs wt.wgroups.<acct> = { active, groups: [{ name, syms }] } · wt.watch.<acct> = ทุกคู่รวมกัน (ตัวส่งแจ้งข่าวใช้)
const WG_MAX = 20;
function wgLoad(acct) {
  let g = store(`wt.wgroups.${acct}`, null);
  if (!g || !Array.isArray(g.groups) || !g.groups.length) g = { active: 0, groups: [{ name: "หลัก", syms: store(`wt.watch.${acct}`, ["XAUUSD", "EURUSD"]) }] };
  g.active = Math.min(Math.max(0, g.active | 0), g.groups.length - 1);
  state.wg = g;
  state.watch = [...g.groups[g.active].syms];
}
function wgAllSymbols() { return [...new Set((state.wg?.groups || []).flatMap((g) => g.syms))]; }
function saveWatch() {
  state.wg.groups[state.wg.active].syms = [...state.watch];
  save(`wt.wgroups.${state.acct}`, state.wg);
  save(`wt.watch.${state.acct}`, wgAllSymbols());
  renderWGroups();   // จำนวนคู่บนแท็บ
}
function wgSwitch(i) {
  if (i === state.wg.active || !state.wg.groups[i]) return;
  state.wg.active = i;
  state.watch = [...state.wg.groups[i].syms];
  saveWatch(); renderWGroups(); renderWatch(); subscribe();
}
async function wgName(title, value = "") {
  const v = await modal({ title, fields: [{ name: "n", label: "ชื่อกลุ่ม (เช่น ทอง, FX, Crypto)", value }], ok: "บันทึก" });
  const n = v?.n?.trim().slice(0, 20);
  return n || null;
}
async function wgAdd() {
  if (state.wg.groups.length >= WG_MAX) { toast(`สร้างได้ไม่เกิน ${WG_MAX} กลุ่ม`, false); return; }
  const n = await wgName("เพิ่มกลุ่ม watchlist");
  if (!n) return;
  state.wg.groups.push({ name: n, syms: [] });
  state.wg.active = state.wg.groups.length - 1;
  state.watch = [];
  saveWatch(); renderWGroups(); renderWatch(); subscribe();
  $("add-sym")?.focus();
}
function wgMenu(anchor, i) {
  const g = state.wg.groups;
  const move = (d) => {
    const j = i + d;
    [g[i], g[j]] = [g[j], g[i]];
    if (state.wg.active === i) state.wg.active = j; else if (state.wg.active === j) state.wg.active = i;
    saveWatch(); renderWGroups();
  };
  popMenu(anchor, [
    { label: "✏️ เปลี่ยนชื่อ", onClick: async () => { const n = await wgName("เปลี่ยนชื่อกลุ่ม", g[i].name); if (n) { g[i].name = n; saveWatch(); renderWGroups(); } } },
    { label: "◀ ย้ายไปซ้าย", disabled: i === 0, onClick: () => move(-1) },
    { label: "▶ ย้ายไปขวา", disabled: i === g.length - 1, onClick: () => move(1) },
    "sep",
    { label: "🗑 ลบกลุ่มนี้", sub: `${g[i].syms.length} คู่`, danger: true, disabled: g.length < 2, onClick: async () => {
      if (!(await modal({ title: `ลบกลุ่ม "${g[i].name}"`, lines: ["ลบแค่กลุ่ม — ไม่กระทบไม้/ออเดอร์"], ok: "ลบ", danger: true }))) return;
      g.splice(i, 1);
      state.wg.active = Math.min(state.wg.active >= i && state.wg.active > 0 ? state.wg.active - 1 : state.wg.active, g.length - 1);
      state.watch = [...g[state.wg.active].syms];
      saveWatch(); renderWGroups(); renderWatch(); subscribe();
    } },
  ]);
}
function renderWGroups() {
  const box = $("wgroups");
  if (!box || !state.wg) return;
  box.replaceChildren(...state.wg.groups.map((g, i) => {
    const b = el("button", undefined, "wg-tab" + (i === state.wg.active ? " on" : ""));
    b.type = "button";
    b.append(g.name, el("small", ` ${g.syms.length}`, "muted"));
    b.title = i === state.wg.active ? "แตะอีกครั้ง = เปลี่ยนชื่อ / ย้าย / ลบ" : `สลับไปกลุ่ม ${g.name}`;
    b.addEventListener("click", () => (i === state.wg.active ? wgMenu(b, i) : wgSwitch(i)));
    return b;
  }), Object.assign(el("button", "+", "wg-tab wg-add"), { type: "button", title: "เพิ่มกลุ่ม", onclick: wgAdd }));
}
function addSymbol(sym) {
  sym = sym.trim();
  if (!sym || state.watch.includes(sym) || state.watch.length >= 50) return;
  state.watch.push(sym); saveWatch(); renderWatch(); subscribe();
}
function removeSymbol(sym) {
  state.watch = state.watch.filter((s) => s !== sym);
  delete state.quotes[sym]; saveWatch(); renderWatch(); subscribe();
}

// ---------- account / positions / orders ----------
function renderAccount(a) {
  state.account = a;
  const c = a.currency;
  $("s-balance").textContent = money(a.balance, c);
  $("s-equity").textContent = money(a.equity, c);
  $("s-profit").textContent = money(a.profit, c); $("s-profit").className = signCls(a.profit);
  $("s-margin").textContent = money(a.margin, c);
  $("s-free").textContent = money(a.margin_free, c);
  $("s-level").textContent = a.margin ? fmt(a.margin_level, 0) + "%" : "–";
  const m = $("mode");
  const demo = a.trade_mode === 0;
  m.replaceChildren(demo ? "DEMO" : "REAL", el("span", ` · ${a.login} · ${a.currency}`, "b-more"));
  m.className = "badge " + (demo ? "demo" : "real");
  const te = $("top-eq");
  te.replaceChildren(el("span", "Equity ", "muted"), el("b", money(a.equity, c), signCls(a.profit)));
  paintRisk();
  if (state.day) renderDay(state.day);
}

function renderTable(tbodyId, rows, cols, emptyText, actions, onRow, sig) {
  const tb = $(tbodyId);
  // โครงสร้างเดิม (sig เท่าเดิม) -> แก้เฉพาะข้อความ/คลาสที่เปลี่ยน ไม่สร้างแถวและปุ่มใหม่ทุกครั้งที่ราคาขยับ
  if (sig != null && rows.length && tb.dataset.sig === sig) {
    rows.forEach((r, i) => {
      const tds = tb.rows[i]?.cells;
      if (!tds) return;
      cols.forEach(([fn, cls], j) => {
        const td = tds[j], v = String(fn(r) ?? ""), c = typeof cls === "function" ? cls(r) : cls;
        if (td.textContent !== v) td.textContent = v;
        if ((td.className || "") !== (c || "")) td.className = c || "";
      });
    });
    return;
  }
  tb.dataset.sig = sig ?? "";
  tb.replaceChildren();
  if (!rows.length) {
    const tr = el("tr"); const td = el("td", emptyText, "empty"); td.colSpan = cols.length + (actions ? 1 : 0); tr.append(td); tb.append(tr);
    return;
  }
  for (const r of rows) {
    const tr = el("tr");
    for (const [fn, cls] of cols) {
      const v = fn(r);
      tr.append(el("td", v, typeof cls === "function" ? cls(r) : cls));
    }
    if (actions) { const td = el("td", undefined, "r acts"); td.append(...actions(r)); tr.append(td); }
    if (onRow) { tr.className = "clickable"; tr.addEventListener("click", () => onRow(r)); }
    tb.append(tr);
  }
}

function renderPositions(rows) {
  state.positions = rows;
  $("pos-count").textContent = rows.length ? `(${rows.length})` : "";
  renderTable("positions", rows, [
    [(r) => r.ticket, ""], [(r) => r.symbol, ""], [(r) => TYPE_NAMES[r.type] ?? r.type, (r) => r.type === 0 ? "up" : "down"],
    [(r) => fmt(r.volume), "r"], [(r) => px(r.symbol, r.price_open), "r"], [(r) => px(r.symbol, r.price_current), "r"],
    [(r) => px(r.symbol, r.sl), "r"], [(r) => px(r.symbol, r.tp), "r"], [(r) => fmt(r.swap), "r"],
    [(r) => fmt(r.profit), (r) => "r " + signCls(r.profit)], [(r) => r.magic || "มือ", "muted"],
  ], "ไม่มี position", (r) => [
    actionBtn("SL/TP", "แก้ SL/TP", () => positionAction("sltp", r)),
    actionBtn("BE", "เลื่อน SL ไปจุดทุน", () => breakeven(r)),
    actionBtn("½", "ปิดบางส่วน", () => positionAction("partial", r)),
    actionBtn(hist.journal[String(r.ticket)] ? "📝" : "🏷", "บันทึก/แท็กไม้นี้", () => journalForPosition(r)),
    actionBtn("✕", "ปิด", () => positionAction("close", r), "danger"),
  ], (r) => startEdit("pos", r.ticket),
  rows.map((r) => [r.ticket, r.type, r.volume, r.price_open, r.sl, r.tp, r.magic, !!hist.journal[String(r.ticket)]].join()).join("|") + "|" + Object.keys(state.digits).length);
  renderCards("pos-cards", "pos", rows);
  if (newsState.data) renderNewsAlert();
  paintOrderCount();
  syncTradeLines();
  paintRisk();
  histOnPositions(rows);
  paintDockCounts();
}

function pendingRuleTitle(r) {
  const t = [r.oco ? `OCO กับ #${r.oco}` : "", r.expire ? `หมดอายุในอีก ${fmtLeft(r.expire - Date.now() / 1000)}` : ""].filter(Boolean).join(" · ");
  return t ? `${t} — กดเพื่อแก้` : "ตั้งหมดอายุ / จับคู่ OCO";
}

function renderOrders(rows) {
  state.orders = rows;
  $("ord-count").textContent = rows.length ? `(${rows.length})` : "";
  renderTable("orders", rows, [
    [(r) => r.ticket, ""], [(r) => r.symbol, ""], [(r) => TYPE_NAMES[r.type] ?? r.type, ""],
    [(r) => fmt(r.volume), "r"], [(r) => px(r.symbol, r.price_open), "r"],
    [(r) => px(r.symbol, r.sl), "r"], [(r) => px(r.symbol, r.tp), "r"], [(r) => r.magic || "มือ", "muted"],
  ], "ไม่มี pending", (r) => [
    actionBtn("แก้", "แก้ราคา/SL/TP", () => orderAction("edit", r)),
    actionBtn(r.oco || r.expire ? `${r.oco ? "🔗" : ""}${r.expire ? "⏱" : ""}` : "⏱🔗", pendingRuleTitle(r), () => openPendingRules(r)),
    actionBtn("⚖️", "ปรับ risk (คิด lot ใหม่จากเงินในพอร์ต)", () => openRerisk([r.ticket])),
    actionBtn("✕", "ยกเลิก", () => orderAction("cancel", r), "danger"),
  ], (r) => startEdit("ord", r.ticket));
  renderCards("ord-cards", "ord", rows);
  paintTicketRules();
  paintOrderCount();
  paintDockCounts();
  syncTradeLines();
}

// ---------- การ์ดทีละไม้ (มือถือ) — อัปเดตข้อความในที่เดิม ไม่สร้างใหม่ทุก 0.5 วินาที กดปุ่มไม่หลุด ----------
function renderCards(boxId, kind, rows) {
  const box = $(boxId);
  const want = rows.map((r) => r.ticket).join(",");
  if (box.dataset.keys !== want) {
    box.dataset.keys = want;
    box.replaceChildren();
    if (!rows.length) box.append(el("div", kind === "pos" ? "ไม่มี position" : "ไม่มี pending", "empty card-empty"));
    for (const r of rows) box.append(buildCard(kind, r.ticket));
  }
  for (const r of rows) fillCard(box.querySelector(`[data-ticket="${r.ticket}"]`), kind, r);
}

// R:R = ระยะ TP / ระยะ SL จากราคาเข้า (null ถ้าไม่มี SL/TP หรือ SL เลยทุนแล้ว)
function rrOf(buy, entry, sl, tp) {
  if (!sl || !tp || !entry) return null;
  const risk = buy ? entry - sl : sl - entry, rew = buy ? tp - entry : entry - tp;
  return risk > 0 && rew > 0 ? rew / risk : null;
}

// ปัดการ์ดไปซ้าย = ปุ่มลัดด้านหลัง (มือถือ) · แตะที่อื่น / ปัดกลับ = ปิด
const SWIPE_W = 152;
let swipeOpen = null;
function closeSwipe() { if (swipeOpen) { swipeOpen.style.transform = ""; const w = swipeOpen.parentElement; setTimeout(() => w.classList.remove("sw"), 200); swipeOpen = null; } }
document.addEventListener("pointerdown", (e) => { if (swipeOpen && !swipeOpen.parentElement.contains(e.target)) closeSwipe(); }, true);
function initSwipe(card) {
  let x0 = 0, y0 = 0, base = 0, dx = 0, mode = null, id = null;
  card.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse" || e.target.closest("button")) return;
    x0 = e.clientX; y0 = e.clientY; base = swipeOpen === card ? -SWIPE_W : 0; dx = base; mode = null; id = e.pointerId;
  });
  card.addEventListener("pointermove", (e) => {
    if (e.pointerId !== id) return;
    const mx = e.clientX - x0, my = e.clientY - y0;
    if (!mode) {
      if (Math.abs(mx) < 10 && Math.abs(my) < 10) return;
      mode = Math.abs(mx) > Math.abs(my) ? "x" : "y";
      if (mode === "x") { card.setPointerCapture(id); card.style.transition = "none"; card.parentElement.classList.add("sw"); }
    }
    if (mode !== "x") return;
    dx = Math.max(-SWIPE_W - 30, Math.min(0, base + mx));
    card.style.transform = `translateX(${dx}px)`;
  });
  const end = (e) => {
    if (e.pointerId !== id) return;
    id = null;
    if (mode !== "x") return;
    card.style.transition = "";
    card.dataset.swiped = "1";
    setTimeout(() => delete card.dataset.swiped, 50);
    if (dx < -SWIPE_W / 2) {
      if (swipeOpen && swipeOpen !== card) closeSwipe();
      card.style.transform = `translateX(${-SWIPE_W}px)`;
      swipeOpen = card;
    } else { card.style.transform = ""; if (swipeOpen === card) swipeOpen = null; setTimeout(() => { if (swipeOpen !== card) card.parentElement.classList.remove("sw"); }, 200); }
  };
  card.addEventListener("pointerup", end);
  card.addEventListener("pointercancel", end);
}

function buildCard(kind, ticket) {
  const wrap = el("div", undefined, "tcard-wrap");
  wrap.dataset.ticket = ticket;
  const c = el("div", undefined, "tcard");
  const top = el("div", undefined, "tcard-top");
  top.append(el("span", undefined, "tc-side"), el("b", undefined, "tc-sym"), el("span", undefined, "tc-vol muted"), el("b", undefined, "tc-main"));
  const mid = el("div", undefined, "tcard-mid");
  mid.append(el("span", undefined, "tc-price"), el("span", undefined, "tc-levels"));
  const bar = el("div", undefined, "tc-bar");
  bar.append(el("i", undefined, "tc-bar-entry"), el("i", undefined, "tc-bar-now"));
  const acts = el("div", undefined, "tcard-acts");
  const find = () => findLive(kind, ticket);
  const back = el("div", undefined, "tc-swipe");
  const sbtn = (text, cls, fn) => {
    const b = el("button", text, cls);
    b.type = "button";
    b.onclick = (e) => { e.stopPropagation(); closeSwipe(); fn(); };
    return b;
  };
  if (kind === "pos") back.append(sbtn("BE", "sw-be", () => { const x = find(); if (x) breakeven(x); }),
    sbtn("ปิด", "sw-close", () => { const x = find(); if (x) positionAction("close", x); }));
  else back.append(sbtn("ปรับ risk", "sw-be", () => openRerisk([ticket])),
    sbtn("ยกเลิก", "sw-close", () => { const x = find(); if (x) orderAction("cancel", x); }));
  if (kind === "pos") {
    acts.append(actionBtn("SL/TP", "แก้ SL/TP", () => startEdit("pos", ticket)),
      actionBtn("BE", "เลื่อน SL ไปจุดทุน", () => { const x = find(); if (x) breakeven(x); }),
      actionBtn("ปิดบางส่วน", "ปิดบางส่วน", () => { const x = find(); if (x) positionAction("partial", x); }),
      actionBtn("🏷", "บันทึก/แท็กไม้นี้", () => { const x = find(); if (x) journalForPosition(x); }),
      actionBtn("ปิด", "ปิด position", () => { const x = find(); if (x) positionAction("close", x); }, "danger"));
  } else {
    acts.append(actionBtn("แก้ไข", "แก้ราคา/SL/TP", () => startEdit("ord", ticket)),
      actionBtn("⏱🔗", "หมดอายุ / OCO", () => { const x = find(); if (x) openPendingRules(x); }),
      actionBtn("⚖️", "ปรับ risk", () => openRerisk([ticket])),
      actionBtn("ยกเลิก", "ยกเลิกคำสั่ง", () => { const x = find(); if (x) orderAction("cancel", x); }, "danger"));
  }
  c.append(top, mid, bar, acts);
  c.addEventListener("click", () => {
    if (c.dataset.swiped) return;
    if (swipeOpen) { closeSwipe(); return; }
    startEdit(kind, ticket);
  });
  initSwipe(c);
  wrap.append(back, c);
  return wrap;
}

function fillCard(c, kind, r) {
  if (!c) return;
  const buy = kind === "pos" ? r.type === 0 : [2, 4, 6].includes(r.type);
  const side = c.querySelector(".tc-side");
  side.textContent = kind === "pos" ? (buy ? "BUY" : "SELL") : TYPE_NAMES[r.type];
  side.className = "tc-side " + (buy ? "buy" : "sell");
  c.querySelector(".tc-sym").textContent = r.symbol;
  c.querySelector(".tc-vol").textContent = `${r.volume} lot`;
  const main = c.querySelector(".tc-main");
  if (kind === "pos") { main.textContent = `${r.profit >= 0 ? "+" : ""}${fmt(r.profit)}`; main.className = "tc-main " + signCls(r.profit); }
  else { main.textContent = px(r.symbol, r.price_open); main.className = "tc-main"; }
  c.querySelector(".tc-price").textContent = kind === "pos"
    ? `${px(r.symbol, r.price_open)} → ${px(r.symbol, r.price_current)}`
    : `#${r.ticket}${r.oco ? ` · 🔗 #${r.oco}` : ""}${r.expire ? ` · ⏱ ${fmtLeft(r.expire - Date.now() / 1000)}` : ""}`;
  const rk = kind === "pos" && r.risk != null ? ` (${money(r.risk, state.account?.currency)})` : "";
  const entry = kind === "pos" ? r.price_open : (r.price_stoplimit || r.price_open);
  const rr = rrOf(buy, entry, r.sl, r.tp);
  c.querySelector(".tc-levels").textContent = `SL ${r.sl ? px(r.symbol, r.sl) : "–"}${rk} · TP ${r.tp ? px(r.symbol, r.tp) : "–"}${rr ? ` · ${rr.toFixed(1)}R` : ""}`;
  // แถบ SL -> TP: ซ้าย = SL, ขวา = TP, ขีด = ราคาเข้า, จุด = ราคาตอนนี้ (pending: ราคาตลาด)
  const bar = c.querySelector(".tc-bar");
  const q = state.quotes[r.symbol];
  const now = kind === "pos" ? r.price_current : q ? (buy ? q.ask : q.bid) : null;
  const ok = !!(r.sl && r.tp && r.sl !== r.tp);
  bar.hidden = !ok;
  if (ok) {
    const pct = (v) => Math.max(0, Math.min(100, (v - r.sl) / (r.tp - r.sl) * 100));
    bar.style.setProperty("--e", `${pct(entry)}%`);
    const raw = now == null ? null : (now - r.sl) / (r.tp - r.sl);
    const show = now != null && (kind === "pos" || (raw >= 0 && raw <= 1));   // pending: ราคาอยู่นอกช่วง = ไม่แสดงจุด
    bar.querySelector(".tc-bar-now").hidden = !show;
    if (show) bar.style.setProperty("--n", `${pct(now)}%`);
  }
}

// ---------- websocket ----------
const tickDirty = new Set();
let tickRaf = 0;
function flushTicks() {
  tickRaf = 0;
  const syms = [...tickDirty];
  tickDirty.clear();
  const tsym = ticketSymbol();
  for (const sym of syms) {
    const q = state.quotes[sym];
    if (!q) continue;
    paintQuote(sym);
    if (sym === tsym) paintTicketQuote();
    // เส้น Bid / Ask บนกราฟ
    state.charts?.panels.forEach((p) => {
      if (p.symbol !== sym || p.replay) return;   // กราฟ Bar Replay ใช้ราคาจากแท่งที่เล่น
      // Bid (= ราคาแท่ง) สีตามแท่งปัจจุบัน + Ask แดงประ — อยู่ที่ราคาจริงเสมอ เลื่อนกราฟแล้วหลุดจอไปด้วยกัน
      p.setQuote(q.bid, q.ask);
      const bar = p.chart.getDataList().at(-1);
      const bidColor = bar && q.bid < bar.open ? "#ef5350" : "#26a69a";
      p.setLines("quote", [
        { key: "bid", value: q.bid, color: bidColor, dashed: true, locked: true, chips: [] },
        { key: "ask", value: q.ask, color: "#f23645", dashed: true, locked: true, chips: [] },
      ]);
    });
  }
}
function onMessage(ev) {
  const m = JSON.parse(ev.data);
  switch (m.type) {
    case "tick": {
      // เก็บราคาทันที (ตรรกะที่อ่าน state.quotes ได้ค่าล่าสุดเสมอ) แต่วาดรวมครั้งเดียวต่อเฟรม — วาดค่าล่าสุด ไม่หน่วง tick
      const prev = state.quotes[m.symbol];
      state.quotes[m.symbol] = { bid: m.bid, ask: m.ask, prevBid: prev?.bid, recv: Date.now() };
      if (m.symbol === ticketSymbol() && !prev) scheduleCalc();
      tickDirty.add(m.symbol);
      if (!tickRaf) tickRaf = requestAnimationFrame(flushTicks);
      break;
    }
    case "bars": state.charts?.onBars(m); break;
    case "account": renderAccount(m.data); break;
    case "positions": renderPositions(m.data); break;
    case "orders": renderOrders(m.data); break;
    case "day": renderDay(m.data); break;
    case "autobe": onAutoBEEvent(m.data); break;
    case "prule": onPruleEvent(m.data); break;
    case "status":
      if (state.status && state.status.autobe !== m.autobe) loadAutoBE();
      state.status = m;
      state.lastError = m.mt5 ? "" : (m.error || "MT5 ไม่เชื่อมต่อ");
      setDot("dot-mt5", !!m.mt5);
      if (m.mt5 && m.server_offset_est_h != null && m.server_offset_est_h !== m.server_utc_offset_h) {
        state.lastError = `⚠️ เวลา server ดูเหมือน UTC${m.server_offset_est_h >= 0 ? "+" : ""}${m.server_offset_est_h} ` +
          `แต่ตั้งไว้ ${m.server_utc_offset_h} — แก้ server_utc_offset_h ใน accounts.json (กราฟเวลาเพี้ยน)`;
      }
      // คำสั่งค้างรอโบรก: MT5 อยู่ใน process แยกแล้ว ราคา/กราฟยังเดิน — บอกให้รอ ไม่กดซ้ำ
      banner(m.trade_wait_s > 4 ? `⏳ รอโบรกตอบคำสั่งมา ${m.trade_wait_s} วินาที — ราคาและกราฟยังเดินปกติ อย่ากดส่งซ้ำ` : state.lastError);
      break;
    case "pong":
      if (typeof m.t === "number") $("ping").textContent = `${Math.round(performance.now() - m.t)} ms`;
      break;
    case "error":
      banner(m.message);
      break;
  }
}

function connect() {
  if (state.ws) { state.ws.onclose = null; state.ws.close(); }
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(`${proto}//${location.host}/ws/${encodeURIComponent(state.acct)}`);
  state.ws = ws;
  setDot("dot-ws", null);
  ws.onopen = () => { state.retry = 0; setDot("dot-ws", true); subscribe(); ping(); };
  ws.onmessage = onMessage;
  ws.onclose = async (ev) => {
    setDot("dot-ws", false); setDot("dot-mt5", null);
    if (ev.code === 4401) { location.href = "/login"; return; }
    const wait = Math.min(10000, 1000 * Math.pow(2, state.retry++));
    banner(`${state.lastError || "การเชื่อมต่อหลุด"} — ต่อใหม่ใน ${Math.round(wait / 1000)} วินาที`);
    setTimeout(connect, wait);
  };
}

function ping() {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify({ op: "ping", t: performance.now() }));
  }
}

// ---------- boot ----------
async function loadSymbols() {
  try {
    const r = await api(`/api/a/${encodeURIComponent(state.acct)}/symbols`);
    if (!r.ok) return;
    const list = await r.json();
    const dl = $("sym-list"); dl.replaceChildren();
    for (const s of list) {
      state.digits[s.name] = s.digits;
      const o = el("option"); o.value = s.name; o.label = s.description || ""; dl.append(o);
    }
    renderWatch(); renderPositions(state.positions); renderOrders(state.orders);  // วาดใหม่ด้วย digits ที่ถูก
    state.charts?.refreshPrecision();
  } catch (_) { /* worker ยังไม่ขึ้น — WS จะแสดงสถานะเอง */ }
}

function selectAccount(name) {
  state.acct = name; save("wt.acct", name);
  state.quotes = {};
  wgLoad(name);
  renderWGroups(); renderWatch(); renderPositions([]); renderOrders([]);
  loadSymbols();
  exitEdit();
  for (const k of Object.keys(specs)) delete specs[k];
  hist.data = null;
  renderNewsAlert?.();
  if (document.body.classList.contains("view-history") || document.body.dataset.tab === "history") loadHistory();
  if (state.charts) { state.charts.reload(); paintTicket(); }
  else {
    state.charts = new ChartManager({
      grid: $("chart-grid"), toolbar: $("chart-toolbar"),
      getAcct: () => state.acct, getDigits: (s) => state.digits[s], onSubscribe: subscribe,
      onPanelChanged, onLineDragged, onLineClicked, onLinePulled, extraTools, onChartTapped,
    });
    onPanelChanged();
  }
  onAccountSelected();
  connect();
}

async function boot() {
  const r = await api("/api/accounts");
  const accts = await r.json();
  const sel = $("acct");
  for (const a of accts) { const o = el("option", `${a.name} (${a.kind})`); o.value = a.name; sel.append(o); }
  const saved = store("wt.acct", null);
  sel.value = accts.some((a) => a.name === saved) ? saved : accts[0]?.name;
  sel.addEventListener("change", () => selectAccount(sel.value));
  if (sel.value) selectAccount(sel.value);
}

async function start() {
  await loadPrefs();
  if (typeof applyTheme === "function") applyTheme();   // ธีมที่ sync มาจาก server อาจต่างจากที่ตั้งตอนโหลดหน้า (localStorage)
  initTicket();
  initEdit();
  initMobile();
  initLayout();
  initHistory();
  initNews();
  initExtras();
  initHotkeys();
  $("close-all").addEventListener("click", (e) => openCloseMenu(e.currentTarget));
  $("cancel-all").addEventListener("click", (e) => openCloseMenu(e.currentTarget));
  $("nav-settings").addEventListener("click", openSettings);
  $("nav-replay").addEventListener("click", () => (state.charts?.panels.some((p) => p.replay) ? replayStop() : openReplay()));
  $("add-form").addEventListener("submit", (e) => { e.preventDefault(); addSymbol($("add-sym").value); $("add-sym").value = ""; });
  $("logout").addEventListener("click", async () => {
    await api("/api/auth/logout", { method: "POST" }).catch(() => {});
    location.href = "/login";
  });
  setInterval(tickAges, 1000);
  setInterval(ping, 5000);
  boot();
}
// เริ่มหลังโหลดสคริปต์ครบทุกไฟล์ (mobile.js / layout.js อยู่หลัง app.js) — ถ้าเรียกทันที fetch prefs อาจเสร็จก่อนไฟล์หลังโหลด
// แล้ว initLayout ยังไม่มี = หน้าว่าง (เจอจริงตอนเทสต์)
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
else start();
