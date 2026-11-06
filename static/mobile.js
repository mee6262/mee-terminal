// Mee Terminal — โหมดมือถือ (≤700px): กราฟเต็มจอ, แถบ SELL/lot/BUY, แท็บล่าง, ช่องส่งคำสั่งเป็นแผ่นเลื่อนขึ้น
"use strict";

const mq = window.matchMedia("(max-width: 700px)");
const isMobile = () => document.body.classList.contains("mobile");

function setTab(tab) {
  document.body.dataset.tab = tab;
  for (const b of document.querySelectorAll("#mtabs button")) b.classList.toggle("on", b.dataset.tab === tab);
  if (tab !== "chart") { closeSheet(); if (typeof edit !== "undefined" && edit) exitEdit(); }
  if (tab === "chart") requestAnimationFrame(() => state.charts?.resizeAll());
  if (tab === "history") loadHistory();
  if (tab === "news") { renderNews(); requestAnimationFrame(scrollNewsToNow); }
}

function openSheet() {
  if (!isMobile()) return;
  if (document.body.dataset.tab !== "chart") setTab("chart");
  document.body.classList.add("sheet-open");
  autoRiskLines();
}
// ปิดแผ่น: ร่างออเดอร์ใหม่ และการแก้ไม้/pending ยังค้างบนกราฟ — ลากแก้ต่อได้ แล้วกด ✓ ยืนยัน / ยกเลิก บนเส้น
function closeSheet() {
  document.body.classList.remove("sheet-open");
  if (typeof edit !== "undefined" && edit && !edit.focus) {
    // ยังไม่ได้แตะเส้นไหน: ให้ปุ่มยืนยัน/ยกเลิกขึ้นบนเส้นหลักของไม้นี้
    edit.focus = edit.kind === "ord" ? "price" : edit.sl ? "sl" : edit.tp ? "tp" : null;
    if (!edit.focus) exitEdit(); else syncLines();
  }
}

function applyMobile() {
  document.body.classList.toggle("mobile", mq.matches);
  document.body.classList.toggle("desk", !mq.matches);
  if (!document.body.dataset.tab) document.body.dataset.tab = "chart";
  state.charts?.setForceSingle(mq.matches);
  if (!mq.matches) closeSheet();
  requestAnimationFrame(() => state.charts?.resizeAll());
}

// ---------- แถบ SELL | lot | BUY ----------
// แถบล่าง: โหมด Lot = ช่องนี้คือ lot, โหมด Risk% = ช่องนี้คือ % ความเสี่ยง (lot คิดจาก SL ตอนส่ง)
const qRisk = () => ticket.mode === "risk";
function qStep() {
  if (qRisk()) return 0.1;
  const s = specs[ticketSymbol()];
  return s?.volume_step || 0.01;
}
function qSetRisk(v) {
  v = Math.min(100, Math.max(0.1, Math.round(v * 10) / 10));
  const txt = String(v);
  document.getElementById("tk-vol").value = txt;
  save("wt.tk.risk", txt);
  paintQVol();
  scheduleCalc();
}
function qSetVol(v) {
  if (qRisk()) { qSetRisk(v); return; }
  const step = qStep();
  const min = specs[ticketSymbol()]?.volume_min || step;
  v = Math.max(min, Math.round(v / step) * step);
  const txt = String(Number(v.toFixed(8)));
  document.getElementById("q-vol").value = txt;
  save("wt.tk.lot", txt);
  if (ticket.mode === "lot") { document.getElementById("tk-vol").value = txt; scheduleCalc(); }
}

async function quickOrder(side) {
  if (qRisk()) { await submitOrder(side); return; }   // Risk%: ส่งแบบเดียวกับช่องส่งคำสั่ง (lot จาก risk% + SL)
  alignAutoSide(side);
  const vol = num(document.getElementById("q-vol").value);
  const sym = ticketSymbol();
  const sl = num(document.getElementById("tk-sl").value), tp = num(document.getElementById("tk-tp").value);
  const body = { symbol: sym, side, kind: "market", volume: vol, sl, tp };
  if (confirmOn()) {
    const lines = [`${side.toUpperCase()} MARKET ${sym} ${vol} lot`, `SL ${sl || "–"} · TP ${tp || "–"}`];
    if (!(await modal({ title: `ยืนยันส่งคำสั่ง (${state.acct})`, lines, ok: side.toUpperCase(), danger: side === "sell" }))) return;
  }
  const btn = document.getElementById(side === "buy" ? "q-buy" : "q-sell");
  btn.disabled = true;
  try {
    const r = await tradeCall("trade/order", { ...body, client_id: cid() });
    if (r?.ok) {
      for (const id of ["tk-sl", "tk-tp"]) document.getElementById(id).value = "";
      paintEst("tk"); syncLines();
    }
  } finally {
    btn.disabled = false;
  }
}

function paintQVol() {
  const inp = document.getElementById("q-vol");
  if (document.activeElement === inp) return;
  if (qRisk()) {
    inp.value = `${num(document.getElementById("tk-vol").value) || 1}%`;
    inp.title = `Risk% — lot ${ticket.lastCalc?.volume ?? "…"} (คิดจาก SL)`;
  } else if (inp.value.endsWith("%")) {
    inp.value = store("wt.tk.lot", "0.01");
    inp.title = "";
  }
  inp.classList.toggle("risk", qRisk());
}

function paintQuickQuote() {
  paintQVol();
  const sym = ticketSymbol();
  const q = state.quotes[sym];
  document.getElementById("q-bid").textContent = q ? px(sym, q.bid) : "–";
  document.getElementById("q-ask").textContent = q ? px(sym, q.ask) : "–";
}

function initMobile() {
  const $m = (id) => document.getElementById(id);
  for (const b of document.querySelectorAll("#mtabs button")) b.addEventListener("click", () => setTab(b.dataset.tab));
  $m("q-more").addEventListener("click", () => (document.body.classList.contains("sheet-open") ? closeSheet() : openSheet()));
  $m("sheet-x").addEventListener("click", closeSheet);
  $m("sheet-handle").addEventListener("click", closeSheet);
  // ปัดแผ่นลงเพื่อปิด
  let y0 = null;
  const sheet = $m("ticket");
  sheet.addEventListener("touchstart", (e) => { y0 = sheet.scrollTop <= 0 ? e.touches[0].clientY : null; }, { passive: true });
  sheet.addEventListener("touchend", (e) => { if (y0 != null && e.changedTouches[0].clientY - y0 > 70) closeSheet(); y0 = null; });
  $m("q-sell").addEventListener("click", () => quickOrder("sell"));
  $m("q-buy").addEventListener("click", () => quickOrder("buy"));
  $m("q-minus").addEventListener("click", () => qSetVol(num($m("q-vol").value) - qStep()));
  $m("q-plus").addEventListener("click", () => qSetVol(num($m("q-vol").value) + qStep()));
  $m("q-vol").addEventListener("change", () => qSetVol(num($m("q-vol").value)));
  $m("q-vol").value = store("wt.tk.lot", "0.01");
  $m("m-draw").addEventListener("click", () => {
    document.body.classList.toggle("draw-open");
    drawH();
    requestAnimationFrame(() => state.charts?.resizeAll());
  });
  // ความสูงจริงของแถบเครื่องมือ (ต่างตามธีม/ขนาดจอ) -> CSS หักออกจากกราฟพอดี ไม่เหลือช่องว่างล่าง
  const drawH = () => {
    const tb = $("chart-toolbar");
    if (!document.body.classList.contains("draw-open") || !tb) return;
    const cs = getComputedStyle(tb);
    document.body.style.setProperty("--drawh", `${tb.getBoundingClientRect().height + parseFloat(cs.marginTop) + parseFloat(cs.marginBottom)}px`);
  };
  addEventListener("resize", drawH);
  // บัญชี: สำเนาของ select บนแถบบน
  const main = $m("acct"), mirror = $m("m-acct");
  const syncAcct = () => { mirror.replaceChildren(...[...main.options].map((o) => new Option(o.textContent, o.value))); mirror.value = main.value; };
  new MutationObserver(syncAcct).observe(main, { childList: true });
  main.addEventListener("change", syncAcct);
  mirror.addEventListener("change", () => { main.value = mirror.value; main.dispatchEvent(new Event("change")); });
  $m("m-logout").addEventListener("click", () => $m("logout").click());
  $m("m-settings").addEventListener("click", openSettings);
  $m("m-replay").addEventListener("click", () => { if (typeof setTab === "function") setTab("chart"); openReplay(); });
  mq.addEventListener("change", applyMobile);
  applyMobile();
  setInterval(paintQuickQuote, 250);
}

function paintOrderCount() {
  const n = state.positions.length + state.orders.length;
  document.getElementById("m-count").textContent = n ? String(n) : "";
}

