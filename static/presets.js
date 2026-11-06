// Mee Terminal — ชุด SL/TP สำเร็จรูปต่อ symbol (ระยะเป็นจุด หรือ ATR) + คีย์ลัดบนคอม
"use strict";

// ---------- ชุด SL/TP ----------
// prefs "wt.presets" = { "_all": [preset], "XAUUSD": [preset] }
// preset = { id, name, sl: { type: "pts"|"atr", v }, tp: { type: "rr"|"pts", v } }
const PRESET_BUILTIN = [
  { id: "b1", name: "ATR×1.5 · 2R", sl: { type: "atr", v: 1.5 }, tp: { type: "rr", v: 2 } },
  { id: "b2", name: "ATR×1 · 1.5R", sl: { type: "atr", v: 1 }, tp: { type: "rr", v: 1.5 } },
];

function presetStore() { return store("wt.presets", {}); }

function presetsFor(sym) {
  const all = presetStore();
  const mine = all[sym] || [], common = all._all || [];
  return mine.length || common.length ? [...mine, ...common] : PRESET_BUILTIN;
}

// ATR(14) ของ TF ที่กราฟ active แสดงอยู่ (แท่งปิดแล้ว)
function currentAtr(sym, n = 14) {
  const p = state.charts?.panels.find((x) => x.symbol === sym) || state.charts?.panels[state.charts.active];
  const bars = p?.chart.getDataList() || [];
  if (bars.length < n + 2) return 0;
  let sum = 0;
  for (let i = bars.length - 1 - n; i < bars.length - 1; i++) {
    const b = bars[i], pc = bars[i - 1].close;
    sum += Math.max(b.high - b.low, Math.abs(b.high - pc), Math.abs(b.low - pc));
  }
  return sum / n;
}

function presetLabel(p) {
  const sl = p.sl.type === "atr" ? `ATR×${p.sl.v}` : `${p.sl.v}จ`;
  const tp = p.tp.type === "rr" ? `${p.tp.v}R` : `${p.tp.v}จ`;
  return p.name || `${sl} · ${tp}`;
}

function applyPreset(p) {
  const sym = edit ? edit.symbol : ticketSymbol();
  const d = state.digits[sym] ?? 5;
  const point = 10 ** -d;
  let slDist = p.sl.type === "atr" ? currentAtr(sym) * p.sl.v : p.sl.v * point;
  if (!(slDist > 0)) { toast("คำนวณ ATR ไม่ได้ (แท่งยังไม่พอ) — ใช้แบบจุดแทน", false); return; }
  const tpDist = p.tp.type === "rr" ? slDist * p.tp.v : p.tp.v * point;
  const fix = (v) => Number(v.toFixed(d));
  if (edit) {   // แก้ไม้ที่มีอยู่: วาง SL/TP รอบราคาเข้าของไม้นั้น
    const e = editEntry(), s = edit.side === "sell" ? -1 : 1;
    edit.sl = fix(e - s * slDist); edit.tp = fix(e + s * tpDist); edit.focus = "sl";
    paintEdit();
    return;
  }
  const q = state.quotes[sym];
  if (!q) { toast("ยังไม่มีราคา — เพิ่ม symbol นี้ใน Watchlist", false); return; }
  const $t = (id) => document.getElementById(id);
  let side, entry;
  if (ticket.kind === "market") {
    side = ticket.rrSide || "buy";
    entry = side === "buy" ? q.ask : q.bid;
  } else {
    const n = newOrderDraft();
    entry = n.entry || n.price || q.bid;
    side = n.side || ticket.rrSide || "buy";
  }
  const s = side === "sell" ? -1 : 1;
  const sl = fix(entry - s * slDist), tp = fix(entry + s * tpDist);
  $t("tk-sl").value = sl.toFixed(d);
  $t("tk-tp").value = tp.toFixed(d);
  if (ticket.kind === "market") {
    ticket.rrSide = side;
    // ยังไม่ขยับเส้น + กดส่งอีกฝั่ง = กลับด้านให้ (alignAutoSide ใน trade.js)
    ticket.auto = { sym, sl, tp, dSl: slDist, dTp: tpDist, base: side };
  }
  scheduleCalc(); paintEst("tk"); syncLines();
}

function paintPresets() {
  const box = document.getElementById(edit ? "ed-presets" : "tk-presets");
  if (!box) return;
  const sym = edit ? edit.symbol : ticketSymbol();
  if (box.dataset.sym === sym && box.dataset.v === JSON.stringify(presetsFor(sym))) return;   // ไม่เปลี่ยน = ไม่วาดใหม่ (กดไม่หลุด)
  box.dataset.sym = sym;
  box.dataset.v = JSON.stringify(presetsFor(sym));
  box.replaceChildren();
  for (const p of presetsFor(sym)) {
    const b = mkx("button", { type: "button", className: "preset", textContent: presetLabel(p),
      title: `SL ${p.sl.type === "atr" ? `ATR(14)×${p.sl.v}` : `${p.sl.v} จุด`} · TP ${p.tp.type === "rr" ? `${p.tp.v}R` : `${p.tp.v} จุด`}` });
    b.onclick = () => applyPreset(p);
    box.append(b);
  }
  const g = mkx("button", { type: "button", className: "preset gear", textContent: "⚙", title: "จัดการชุด SL/TP" });
  g.onclick = openPresetManager;
  box.append(g);
}

function openPresetManager() {
  const sym = ticketSymbol();
  openDialog(`ชุด SL/TP — ${sym}`, (form, close) => {
    const list = mkx("div", { className: "alert-rules" });
    const paint = () => {
      list.replaceChildren();
      const all = presetStore();
      const groups = [[sym, all[sym] || []], ["_all", all._all || []]];
      let any = false;
      for (const [key, items] of groups) {
        for (const p of items) {
          any = true;
          const del = mkx("button", { type: "button", className: "btn-ghost ind-gear", textContent: "✕" });
          del.onclick = () => { const a = { ...presetStore() }; a[key] = (a[key] || []).filter((x) => x.id !== p.id); save("wt.presets", a); paint(); paintPresets(); };
          list.append(mkx("div", { className: "ind-row" }, mkx("span", { textContent: `${presetLabel(p)}  ${key === "_all" ? "· ทุก symbol" : ""}` }), del));
        }
      }
      if (!any) list.append(mkx("div", { className: "muted small", textContent: `ยังไม่ได้ตั้ง — ใช้ชุดเริ่มต้น: ${PRESET_BUILTIN.map(presetLabel).join(", ")}` }));
    };
    paint();
    const name = mkx("input", { type: "text", placeholder: "ชื่อ (เว้นว่าง = ตั้งให้)", maxLength: 24 });
    const slT = mkx("select", {}, mkx("option", { value: "atr", textContent: "SL = ATR(14) ×" }), mkx("option", { value: "pts", textContent: "SL = จุด" }));
    const slV = mkx("input", { type: "number", step: "any", value: "1.5" });
    const tpT = mkx("select", {}, mkx("option", { value: "rr", textContent: "TP = R ×" }), mkx("option", { value: "pts", textContent: "TP = จุด" }));
    const tpV = mkx("input", { type: "number", step: "any", value: "2" });
    const allSym = mkx("input", { type: "checkbox" });
    const err = mkx("div", { className: "tk-info bad" });
    const add = mkx("button", { type: "button", className: "btn-primary", textContent: "+ เพิ่มชุด" });
    add.onclick = () => {
      const sv = num(slV.value), tv = num(tpV.value);
      if (!(sv > 0) || !(tv > 0)) { err.textContent = "ค่าต้องมากกว่า 0"; return; }
      const key = allSym.checked ? "_all" : sym;
      const a = { ...presetStore() };
      if ((a[key] || []).length >= 8) { err.textContent = "ได้ไม่เกิน 8 ชุดต่อกลุ่ม"; return; }
      const id = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now())).slice(0, 8);
      a[key] = [...(a[key] || []), { id, name: name.value.trim(), sl: { type: slT.value, v: sv }, tp: { type: tpT.value, v: tv } }];
      save("wt.presets", a);
      err.textContent = ""; name.value = "";
      paint(); paintPresets();
    };
    const d = state.digits[sym];
    const x = mkx("button", { type: "button", className: "btn-ghost", textContent: "ปิด" });
    x.onclick = close;
    form.append(list, mkx("div", { className: "ind-group", textContent: "เพิ่มชุดใหม่" }),
      mkx("label", { className: "ind-field" }, mkx("span", { textContent: "ชื่อ" }), name),
      mkx("label", { className: "ind-field" }, slT, slV), mkx("label", { className: "ind-field" }, tpT, tpV),
      mkx("label", { className: "chk ind-field" }, allSym, "ใช้กับทุก symbol"),
      d != null ? mkx("div", { className: "muted small", textContent: `${sym}: 1 จุด = ${(10 ** -d).toFixed(d)} · ATR(14) ตอนนี้ ≈ ${currentAtr(sym).toFixed(d)}` }) : "",
      err, mkx("div", { className: "modal-btns" }, x, add));
  });
}

// ---------- คีย์ลัด (คอม) ----------
// B / S = ส่ง BUY / SELL ตามช่องส่งคำสั่ง · Shift+คลิกกราฟ = BUY Limit/Stop ตรงนั้น · Alt+คลิก = SELL · Esc = ยกเลิกร่าง · ? = วิธีใช้
function placePendingAt(side, price) {
  const sym = ticketSymbol();
  const q = state.quotes[sym];
  if (!q) return;
  exitEdit();
  const d = state.digits[sym] ?? 5;
  ticket.kind = side === "buy" ? (price < q.ask ? "limit" : "stop") : (price > q.bid ? "limit" : "stop");
  ticket.rrSide = null; ticket.auto = null;
  const $t = (id) => document.getElementById(id);
  $t("tk-price").value = Number(price).toFixed(d);
  $t("tk-stoplimit").value = ""; $t("tk-sl").value = ""; $t("tk-tp").value = "";
  showTicket();
  paintTicket(); scheduleCalc(); paintEst("tk"); syncLines();
  toast(`${side.toUpperCase()} ${ticket.kind.toUpperCase()} @ ${Number(price).toFixed(d)} — กดชิป TP/SL หรือชุด SL/TP แล้ว ✓ ส่ง`);
}

function onChartModClick(panel, value, e) {
  if (!isDesk()) return false;
  if (panel.symbol !== ticketSymbol()) return false;
  placePendingAt(e.altKey ? "sell" : "buy", value);
  return true;
}

function showHotkeys() {
  openDialog("คีย์ลัด", (form, close) => {
    for (const [k, t] of [["B", "ส่ง BUY (ตามช่องส่งคำสั่ง — Market หรือ pending ที่ร่างไว้)"], ["S", "ส่ง SELL"],
      ["Shift + คลิกกราฟ", "ร่าง BUY Limit/Stop ที่ราคานั้น"], ["Alt + คลิกกราฟ", "ร่าง SELL Limit/Stop ที่ราคานั้น"],
      ["Esc", "ยกเลิกร่าง / เลิกแก้ไข / ยกเลิกการแตะเลือกราคา"], ["F9", "เปิด/ซ่อนช่องส่งคำสั่ง"], ["Ctrl+Z / Ctrl+Shift+Z", "ย้อน / ทำซ้ำ เส้นที่วาด"], ["?", "หน้านี้"]]) {
      form.append(mkx("div", { className: "ind-row" }, mkx("b", { className: "kbd", textContent: k }), mkx("span", { className: "muted", textContent: t })));
    }
    form.append(mkx("div", { className: "muted small", textContent: "ยืนยันก่อนส่งยังทำงานตามที่ตั้งไว้ · ไม่ทำงานตอนพิมพ์ในช่องกรอก" }));
    const x = mkx("button", { type: "button", className: "btn-primary", textContent: "ปิด" });
    x.onclick = close;
    form.append(x);
  }, { wide: false });
}

function initHotkeys() {
  document.addEventListener("keydown", (e) => {
    if (!isDesk() || e.ctrlKey || e.metaKey || e.repeat) return;
    if (/INPUT|SELECT|TEXTAREA/.test(document.activeElement?.tagName) || document.getElementById("modal").open) return;
    const k = e.key;
    if (k === "b" || k === "B") { e.preventDefault(); submitOrder("buy"); }
    else if (k === "s" || k === "S") { e.preventDefault(); submitOrder("sell"); }
    else if (k === "?") { e.preventDefault(); showHotkeys(); }
    else if (k === "Escape") {
      state.charts?.panels.forEach((p) => { p.measureDone = false; p.chart.removeOverlay({ groupId: "measure" }); });   // ลบไม้บรรทัด
      state.charts?.cancelDraw();   // เส้นที่กำลังวาดค้าง
      if (state.charts?.pickBtn) state.charts.cancelPick();
      else discardDraft();
    }
  });
}
