// Mee Terminal — เดสก์ท็อปเต็มจอพอดีแบบ Exness (body.desk): watchlist ซ้าย (ลากกว้าง/ซ่อน), dock Positions-Pending (แท็บ/พับ/ลากสูง),
// ช่องส่งคำสั่งขวา (ซ่อน/ลอยลากย้าย), โหมดเต็มจอ (ช่องส่งคำสั่งเป็นหน้าต่างลอย) — ขนาดจอต่างกันทุกเครื่อง จึงเก็บใน localStorage ไม่ sync
"use strict";

const LAY_KEY = "wt.layout.desk";
let lay = null;   // อ่านใน initLayout (localGet อยู่ใน app.js)
let fsOn = false, fsTk = false;
const isDesk = () => document.body.classList.contains("desk");
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function saveLay() { localSet(LAY_KEY, lay); }

let layRaf = 0;
function chartsResize() {
  if (layRaf) return;
  layRaf = requestAnimationFrame(() => { layRaf = 0; state.charts?.resizeAll(); });
}

function applyLayout() {
  if (!lay) return;
  const b = document.body;
  b.classList.toggle("l-hide", !lay.left);
  b.classList.toggle("dock-fold", !!lay.dockFold);
  b.dataset.dt = lay.dockTab;
  b.classList.toggle("fs", fsOn);
  b.classList.toggle("tk-float", fsOn || !!lay.tkFloat);
  b.classList.toggle("tk-hide", fsOn ? !fsTk : !lay.tk);
  b.style.setProperty("--lw", `${lay.lw}px`);
  b.style.setProperty("--dh", `${dockH()}px`);
  placeFloat();
  for (const t of document.querySelectorAll("#dock-tabs [data-dt]")) t.classList.toggle("on", t.dataset.dt === lay.dockTab && !lay.dockFold);
  document.getElementById("dock-fold").textContent = lay.dockFold ? "▴" : "▾";
  document.getElementById("rail-watch").classList.toggle("on", lay.left);
  document.getElementById("rail-dock").classList.toggle("on", !lay.dockFold);
  document.getElementById("tb-order").classList.toggle("off", b.classList.contains("tk-hide"));
  document.getElementById("tb-fs").textContent = fsOn ? "🗗" : "⛶";
  document.getElementById("tb-fs").title = fsOn ? "ออกจากเต็มจอ (Esc)" : "เต็มจอ (Esc ออก)";
  document.getElementById("tk-float").title = lay.tkFloat ? "ยึดข้างจอ" : "ลอย (ลากย้ายได้)";
  document.getElementById("tk-float").hidden = fsOn;   // เต็มจอ = ลอยเสมอ
  chartsResize();
}

// ความสูง dock ที่ใช้จริง: เหลือให้กราฟอย่างน้อย ~300px และ dock ไม่เกิน 60% (จอเล็ก/ย่อหน้าต่าง) — ค่าที่บันทึกไว้ไม่เปลี่ยน
function dockH() {
  const avail = document.getElementById("center")?.clientHeight || 0;
  return avail ? Math.round(clamp(lay.dh, 90, Math.max(90, Math.min(avail * 0.6, avail - 300)))) : lay.dh;
}

// ---------- หน้าต่างลอย ----------
function placeFloat() {
  const tk = document.getElementById("ticket");
  const w = 330, h = Math.min(tk.offsetHeight || 520, window.innerHeight - 60);
  const x = clamp(lay.fx ?? window.innerWidth - w - 24, 4, Math.max(4, window.innerWidth - w - 4));
  const y = clamp(lay.fy ?? 70, 4, Math.max(4, window.innerHeight - Math.min(h, 120)));
  document.body.style.setProperty("--fx", `${x}px`);
  document.body.style.setProperty("--fy", `${y}px`);
}

function initFloatDrag() {
  const tk = document.getElementById("ticket");
  const head = tk.querySelector(".panel-head");
  head.addEventListener("pointerdown", (e) => {
    if (!isDesk() || !document.body.classList.contains("tk-float")) return;
    if (e.target.closest("button, input, label, select")) return;
    e.preventDefault();
    const r = tk.getBoundingClientRect();
    const dx = e.clientX - r.left, dy = e.clientY - r.top;
    head.setPointerCapture(e.pointerId);
    const move = (ev) => {
      lay.fx = clamp(ev.clientX - dx, 4, window.innerWidth - r.width - 4);
      lay.fy = clamp(ev.clientY - dy, 4, window.innerHeight - 60);
      placeFloat();
    };
    const up = () => {
      head.removeEventListener("pointermove", move);
      head.removeEventListener("pointerup", up);
      head.removeEventListener("pointercancel", up);
      saveLay();
    };
    head.addEventListener("pointermove", move);
    head.addEventListener("pointerup", up);
    head.addEventListener("pointercancel", up);
  });
}

// ---------- ช่องส่งคำสั่ง ----------
function setTicket(show) {
  if (fsOn) fsTk = show; else lay.tk = show;
  saveLay();
  applyLayout();
  if (show) autoRiskLines();   // Risk% ค้างไว้: เปิดแผงแล้วเส้น SL/TP ขึ้นเลย
  else if (edit) exitEdit();    // ร่างออเดอร์ใหม่ยังอยู่บนกราฟ — ล้างเมื่อแตะพื้นกราฟ หรือ ✕ บนเส้น
}
function ticketShown() { return !document.body.classList.contains("tk-hide"); }
// เรียกจาก trade.js/extras.js ตอนเริ่มแก้ไขไม้ / วางร่าง Long-Short
function showTicket() { if (lay && isDesk() && !ticketShown()) setTicket(true); }

// ---------- เต็มจอ ----------
function setFs(on) {
  fsOn = on;
  if (on) fsTk = false;   // เต็มจอ: กด 📝 ออเดอร์ แล้วหน้าต่างลอยขึ้นมา
  try {
    if (on && !document.fullscreenElement) document.documentElement.requestFullscreen?.().catch(() => {});
    if (!on && document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
  } catch (_) { /* เบราว์เซอร์ไม่รองรับ: ยังซ่อนแผงต่างๆ ได้ */ }
  applyLayout();
}

// ---------- ตัวลาก ----------
function dragSplit(el, onMove, onEnd) {
  el.addEventListener("pointerdown", (e) => {
    if (!isDesk()) return;
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    el.classList.add("drag");
    const move = (ev) => onMove(ev);
    const up = () => {
      el.classList.remove("drag");
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      saveLay();
      onEnd?.();
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  });
}

function paintDockCounts() {
  const n1 = state.positions.length, n2 = state.orders.length;
  document.getElementById("dt-pos").textContent = n1 ? String(n1) : "";
  document.getElementById("dt-ord").textContent = n2 ? String(n2) : "";
}

function initLayout() {
  lay = {
    lw: 300, dh: 240, left: window.innerWidth >= 1200, dockFold: false, dockTab: "pos",
    tk: true, tkFloat: false, fx: null, fy: null,
    ...(localGet(LAY_KEY) || {}),
  };
  const $l = (id) => document.getElementById(id);
  const lpanel = $l("lpanel"), center = $l("center");
  dragSplit($l("split-left"), (ev) => {
    lay.lw = Math.round(clamp(ev.clientX - lpanel.getBoundingClientRect().left, 200, 560));
    document.body.style.setProperty("--lw", `${lay.lw}px`);
    chartsResize();
  });
  dragSplit($l("split-dock"), (ev) => {
    const r = center.getBoundingClientRect();
    lay.dh = Math.round(clamp(r.bottom - ev.clientY, 90, r.height - 220));
    document.body.style.setProperty("--dh", `${lay.dh}px`);
    chartsResize();
  });
  $l("split-dock").addEventListener("dblclick", () => { lay.dockFold = !lay.dockFold; saveLay(); applyLayout(); });
  for (const t of document.querySelectorAll("#dock-tabs [data-dt]")) {
    t.addEventListener("click", () => {
      if (lay.dockTab === t.dataset.dt && !lay.dockFold) lay.dockFold = true;   // กดแท็บที่เปิดอยู่ = พับ
      else { lay.dockTab = t.dataset.dt; lay.dockFold = false; }
      saveLay(); applyLayout();
    });
  }
  $l("dock-fold").addEventListener("click", () => { lay.dockFold = !lay.dockFold; saveLay(); applyLayout(); });
  $l("rail-dock").addEventListener("click", () => {
    if (document.body.classList.contains("view-history") || document.body.classList.contains("view-news")) { showView("chart"); lay.dockFold = false; }
    else lay.dockFold = !lay.dockFold;
    saveLay(); applyLayout();
  });
  $l("rail-watch").addEventListener("click", () => { lay.left = !lay.left; saveLay(); applyLayout(); });
  $l("tb-order").addEventListener("click", () => setTicket(!ticketShown()));
  $l("tk-hide").addEventListener("click", () => setTicket(false));
  $l("tk-float").addEventListener("click", () => { lay.tkFloat = !lay.tkFloat; saveLay(); applyLayout(); });
  $l("tb-fs").addEventListener("click", () => setFs(!fsOn));
  document.addEventListener("fullscreenchange", () => { if (!document.fullscreenElement && fsOn) setFs(false); });
  document.addEventListener("keydown", (e) => {
    if (!isDesk()) return;
    if (e.key === "F9") { e.preventDefault(); setTicket(!ticketShown()); }
    else if (e.key === "Escape" && fsOn && !document.fullscreenElement) setFs(false);
  });
  window.addEventListener("resize", () => { if (isDesk()) applyLayout(); });
  // กราฟต้องวาดใหม่ทุกครั้งที่กรอบเปลี่ยนขนาด (ลากตัวแบ่ง, พับ dock, ซ่อนแผง)
  if (window.ResizeObserver) new ResizeObserver(chartsResize).observe($l("chart-grid"));
  initFloatDrag();
  applyLayout();
}
