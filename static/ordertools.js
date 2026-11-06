// Mee Terminal — ปิดหลายไม้ตามเงื่อนไข + pending: หมดอายุ / OCO (worker ยกเลิกให้เอง แม้ปิดเว็บ)
"use strict";

// "42 นาที" / "3 ชม. 12 นาที" / "2 วัน"
function fmtLeft(sec) {
  if (!(sec > 0)) return "หมดเวลา";
  const m = Math.ceil(sec / 60);
  if (m < 60) return `${m} นาที`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} ชม.${m % 60 ? ` ${m % 60} นาที` : ""}`;
  return `${Math.floor(h / 24)} วัน`;
}

// ---------- เมนูลอยทั่วไป (ใต้ปุ่มที่กด) ----------
function popMenu(anchor, items) {
  document.getElementById("pop-menu")?.remove();
  const m = mkx("div", { id: "pop-menu", className: "pop-menu" });
  for (const it of items) {
    if (it === "sep") { m.append(mkx("div", { className: "pm-sep" })); continue; }
    if (it.head) { m.append(mkx("div", { className: "pm-head muted small", textContent: it.head })); continue; }
    const b = mkx("button", { type: "button", className: "pm-row" + (it.danger ? " danger-text" : ""), disabled: !!it.disabled },
      mkx("span", { textContent: it.label }), mkx("span", { className: "muted pm-sub", textContent: it.sub || "" }));
    b.onclick = () => { close(); it.onClick(); };
    m.append(b);
  }
  document.body.append(m);
  const r = anchor.getBoundingClientRect();
  const below = innerHeight - r.bottom;
  m.style.left = `${Math.max(4, Math.min(r.right - m.offsetWidth, innerWidth - m.offsetWidth - 4))}px`;
  if (below < m.offsetHeight + 8 && r.top > below) m.style.bottom = `${innerHeight - r.top + 4}px`;
  else m.style.top = `${r.bottom + 4}px`;
  const away = (e) => { if (!m.contains(e.target) && !anchor.contains(e.target)) close(); };
  const esc = (e) => { if (e.key === "Escape") close(); };
  function close() { m.remove(); document.removeEventListener("pointerdown", away, true); document.removeEventListener("keydown", esc); }
  setTimeout(() => { document.addEventListener("pointerdown", away, true); document.addEventListener("keydown", esc); }, 0);
}

// ---------- ปิดหลายไม้ ----------
function openCloseMenu(anchor) {
  const ccy = state.account?.currency;
  const sym = state.charts?.panels[state.charts.active]?.symbol;
  const net = (p) => p.profit + (p.swap || 0);
  const group = (f) => { const xs = state.positions.filter(f); return { n: xs.length, sum: xs.reduce((a, p) => a + net(p), 0) }; };
  const sub = (g) => (g.n ? `${g.n} ไม้ · ${money(g.sum, ccy)}` : "ไม่มี");
  const item = (label, f, body, danger = true) => {
    const g = group(f);
    return { label, sub: sub(g), danger, disabled: !g.n, onClick: () => closeMany(label, g, body) };
  };
  const ords = state.orders.length, ordsSym = state.orders.filter((o) => o.symbol === sym).length;
  const items = [{ head: "ปิด position" },
    item("ปิดทั้งหมด", () => true, {}),
    item("ปิดเฉพาะที่กำไร", (p) => net(p) > 0, { which: "profit" }, false),
    item("ปิดเฉพาะที่ขาดทุน", (p) => net(p) < 0, { which: "loss" }),
    item("ปิดเฉพาะ BUY", (p) => p.type === 0, { side: "buy" }),
    item("ปิดเฉพาะ SELL", (p) => p.type === 1, { side: "sell" })];
  if (sym) items.push(item(`ปิดเฉพาะ ${sym}`, (p) => p.symbol === sym, { symbol: sym }));
  items.push("sep", { head: "Pending" },
    { label: "ยกเลิก pending ทั้งหมด", sub: ords ? `${ords} รายการ` : "ไม่มี", danger: true, disabled: !ords, onClick: () => cancelMany({}, ords) });
  items.push({ label: "⚖️ ปรับ risk pending…", sub: ords ? `${ords} รายการ` : "ไม่มี", disabled: !ords, onClick: () => openRerisk(null) });
  if (sym) items.push({ label: `ยกเลิก pending ${sym}`, sub: ordsSym ? `${ordsSym} รายการ` : "ไม่มี", danger: true, disabled: !ordsSym, onClick: () => cancelMany({ symbol: sym }, ordsSym) });
  popMenu(anchor, items);
}

async function closeMany(label, g, body) {
  const ok = await modal({ title: label, danger: true, ok: `ปิด ${g.n} ไม้`,
    lines: [`${g.n} ไม้ รวมตอนนี้ ${money(g.sum, state.account?.currency)} (ราคาจริงตอนปิดอาจต่างเล็กน้อย)`, "ยืนยันทุกครั้ง (ไม่ขึ้นกับตัวเลือกยืนยัน)"] });
  if (ok) tradeCall("trade/positions/close_all", body);
}

async function cancelMany(body, n) {
  if (!(await modal({ title: body.symbol ? `ยกเลิก pending ${body.symbol}` : "ยกเลิกทุก pending", lines: [`${n} รายการ`], ok: `ยกเลิก ${n} รายการ`, danger: true }))) return;
  tradeCall("trade/orders/cancel_all", body);
}

// ---------- หมดอายุ ----------
const EXPIRY_CHOICES = [["", "ไม่หมดอายุ"], ["900", "15 นาที"], ["1800", "30 นาที"], ["3600", "1 ชั่วโมง"], ["14400", "4 ชั่วโมง"],
  ["eod", "สิ้นวันนี้ (23:59 เวลาเครื่อง)"], ["custom", "กำหนดเวลาเอง…"]];

function expiryOptions(sel) {
  sel.replaceChildren(...EXPIRY_CHOICES.map(([v, t]) => mkx("option", { value: v, textContent: t })));
}

// ค่าจาก select (+ช่องวันเวลา) -> UTC วินาที หรือ null
function expiryTs(choice, customValue) {
  if (!choice) return null;
  const now = Date.now() / 1000;
  if (choice === "eod") { const d = new Date(); d.setHours(23, 59, 0, 0); return d.getTime() / 1000 > now ? d.getTime() / 1000 : null; }
  if (choice === "custom") { const t = customValue ? new Date(customValue).getTime() / 1000 : NaN; return t > now ? t : NaN; }
  return now + Number(choice);
}

function localInputValue(ts) {
  const d = new Date(ts * 1000);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ---------- หน้าส่งคำสั่ง: แถวหมดอายุ / OCO (เฉพาะ pending) ----------
function initTicketRules() {
  const sel = document.getElementById("tk-exp"), at = document.getElementById("tk-exp-at");
  expiryOptions(sel);
  sel.value = store("wt.tk.exp", "");
  if (sel.value === "custom") sel.value = "";
  at.hidden = true;
  sel.onchange = () => {
    at.hidden = sel.value !== "custom";
    if (!at.hidden && !at.value) at.value = localInputValue(Date.now() / 1000 + 3600);
    if (sel.value !== "custom") save("wt.tk.exp", sel.value);
  };
  paintTicketRules();
}

function paintTicketRules() {
  const pending = ticket.kind !== "market";
  const row = document.getElementById("tk-rules");
  if (!row) return;
  row.hidden = !pending;
  const oco = document.getElementById("tk-oco");
  const keep = oco.value;
  const sym = ticketSymbol();
  const list = [...state.orders].sort((a, b) => (b.symbol === sym) - (a.symbol === sym) || b.ticket - a.ticket);
  oco.replaceChildren(mkx("option", { value: "", textContent: "ไม่จับคู่" }),
    ...list.map((o) => mkx("option", { value: String(o.ticket), textContent: `#${o.ticket} ${o.symbol} ${TYPE_NAMES[o.type]} @ ${px(o.symbol, o.price_open)}${o.oco ? " (มีคู่แล้ว)" : ""}` })));
  oco.value = list.some((o) => String(o.ticket) === keep) ? keep : "";
}

// เพิ่ม expire_ts / oco_with ลงคำสั่ง pending — คืน false ถ้าเวลาที่กรอกใช้ไม่ได้
function addTicketRules(body) {
  if (body.kind === "market") return true;
  const ts = expiryTs(document.getElementById("tk-exp").value, document.getElementById("tk-exp-at").value);
  if (Number.isNaN(ts)) { toast("เวลาหมดอายุต้องอยู่ในอนาคต", false); return false; }
  if (ts) body.expire_ts = Math.round(ts);
  const oco = document.getElementById("tk-oco").value;
  if (oco) body.oco_with = Number(oco);
  return true;
}

// ---------- pending ที่มีอยู่: ตั้ง OCO / หมดอายุ ----------
function openPendingRules(o) {
  openDialog(`⏱🔗 pending #${o.ticket} ${o.symbol} ${TYPE_NAMES[o.type]} @ ${px(o.symbol, o.price_open)}`, (form, close) => {
    const info = mkx("div", { className: "tk-info" });
    form.append(mkx("p", { className: "modal-line muted small", textContent: "worker บน VPS ยกเลิกให้เอง แม้ปิดหน้าเว็บ (ใช้ได้ทุกโบรก)" }));
    // หมดอายุ
    const sel = mkx("select"); expiryOptions(sel);
    const at = mkx("input", { type: "datetime-local" });
    if (o.expire) { sel.value = "custom"; at.value = localInputValue(o.expire); } else sel.value = "";
    at.hidden = sel.value !== "custom";
    sel.onchange = () => { at.hidden = sel.value !== "custom"; if (!at.hidden && !at.value) at.value = localInputValue(Date.now() / 1000 + 3600); };
    form.append(mkx("label", { className: "modal-field" }, mkx("span", { textContent: o.expire ? `หมดอายุ (เหลือ ${fmtLeft(o.expire - Date.now() / 1000)})` : "หมดอายุ" }), sel), at);
    // OCO
    const oco = mkx("select", {}, mkx("option", { value: "", textContent: "ไม่จับคู่" }),
      ...state.orders.filter((x) => x.ticket !== o.ticket).sort((a, b) => (b.symbol === o.symbol) - (a.symbol === o.symbol))
        .map((x) => mkx("option", { value: String(x.ticket), textContent: `#${x.ticket} ${x.symbol} ${TYPE_NAMES[x.type]} @ ${px(x.symbol, x.price_open)}` })));
    oco.value = o.oco ? String(o.oco) : "";
    form.append(mkx("label", { className: "modal-field" }, mkx("span", { textContent: "🔗 OCO กับ (ตัวหนึ่ง fill → ยกเลิกอีกตัว)" }), oco), info);
    const cancel = mkx("button", { type: "button", className: "btn-ghost", textContent: "ยกเลิก" });
    cancel.onclick = close;
    const ok = mkx("button", { type: "submit", className: "btn-primary", textContent: "บันทึก" });
    form.append(mkx("div", { className: "modal-btns" }, cancel, ok));
    form.onsubmit = async (e) => {
      e.preventDefault();
      const ts = expiryTs(sel.value, at.value);
      if (Number.isNaN(ts)) { info.textContent = "เวลาหมดอายุต้องอยู่ในอนาคต"; info.className = "tk-info bad"; return; }
      const ops = [];
      const same = o.expire ? sel.value === "custom" && at.value === localInputValue(o.expire) : !ts;
      if (!same) ops.push({ op: "expire", ticket: o.ticket, ts: ts ? Math.round(ts) : null });
      const want = oco.value ? Number(oco.value) : null;
      if (want !== (o.oco ?? null)) ops.push(want ? { op: "link", a: o.ticket, b: want } : { op: "unlink", ticket: o.ticket });
      ok.disabled = true;
      try {
        for (const body of ops) {
          const r = await api(acctUrl("prules"), { method: "POST", body: JSON.stringify(body) });
          if (!r.ok) { info.textContent = (await r.json().catch(() => ({}))).detail || "บันทึกไม่สำเร็จ"; info.className = "tk-info bad"; return; }
        }
        toast(ops.length ? "✓ บันทึกกฎ pending แล้ว" : "ไม่มีอะไรเปลี่ยน");
        close();
      } finally { ok.disabled = false; }
    };
  });
}

function onPruleEvent(ev) {
  const what = `#${ev.ticket} ${ev.symbol}`;
  if (!ev.ok) toast(`ยกเลิก pending ${what} ไม่สำเร็จ (จะลองใหม่): ${ev.message}`, false);
  else toast(ev.kind === "oco" ? `🔗 OCO: #${ev.filled} fill แล้ว → ยกเลิก ${what}` : `⏱ pending ${what} หมดอายุ → ยกเลิกแล้ว`);
}

// ---------- ปรับ risk pending: คิด lot ใหม่จากเงินในพอร์ตตอนนี้ (หรือจำนวนเงินที่กำหนด) แล้วลบ+วางใหม่ ----------
function openRerisk(only) {
  const ccy = state.account?.currency || "";
  const pref = store("wt.rerisk", { mode: "pct", val: "1" });
  openDialog("⚖️ ปรับ risk pending", (form, close) => {
    form.append(mkx("p", { className: "modal-line muted small",
      textContent: "คิด lot ใหม่จาก SL เดิม แล้วลบใบเดิม + วางใหม่ (ราคา/SL/TP/หมดอายุ/OCO เดิม) · ใบที่ lot เท่าเดิมจะข้าม" }));
    const mode = mkx("select", {}, mkx("option", { value: "pct", textContent: "% ของ balance" }),
      mkx("option", { value: "money", textContent: `จำนวนเงิน (${ccy})` }));
    mode.value = pref.mode;
    const val = mkx("input", { type: "text", inputMode: "decimal", value: pref.val });
    form.append(mkx("div", { className: "modal-btns" },
      mkx("label", { className: "modal-field" }, mkx("span", { textContent: "เสี่ยงต่อใบ" }), mode),
      mkx("label", { className: "modal-field" }, mkx("span", { textContent: "ค่า" }), val)));
    const head = mkx("div", { className: "tk-info" });
    const list = mkx("div", { className: "rr-list" });
    const allBox = mkx("input", { type: "checkbox" });
    form.append(mkx("label", { className: "rr-all small" }, allBox, mkx("span", { textContent: " เลือกทั้งหมด" })), list, head);
    const picked = new Set(state.orders.filter((o) => !only || only.includes(o.ticket)).map((o) => o.ticket));
    let preview = null, seq = 0, timer = null;
    const cancel = mkx("button", { type: "button", className: "btn-ghost", textContent: "ปิด" });
    cancel.onclick = close;
    const ok = mkx("button", { type: "submit", className: "btn-primary", textContent: "ลบและวางใหม่", disabled: true });
    form.append(mkx("div", { className: "modal-btns" }, cancel, ok));

    const body = () => {
      const v = num(val.value);
      return mode.value === "pct" ? { risk_pct: v } : { risk_money: v };
    };
    const changed = () => (preview?.results || []).filter((r) => picked.has(r.ticket) && r.new_volume != null && !r.same);
    const paint = () => {
      allBox.checked = state.orders.length > 0 && state.orders.every((o) => picked.has(o.ticket));
      const rows = preview?.results || state.orders.map((o) => ({ ticket: o.ticket, symbol: o.symbol, type: o.type, price: o.price_open, old_volume: o.volume }));
      list.replaceChildren(...rows.map((r) => {
        const cb = mkx("input", { type: "checkbox", checked: picked.has(r.ticket) });
        cb.onchange = () => { cb.checked ? picked.add(r.ticket) : picked.delete(r.ticket); paint(); };
        const lot = r.new_volume != null ? `${r.old_volume} → ${r.new_volume} lot` : `${r.old_volume} lot`;
        const risk = r.new_volume != null ? `เสี่ยง ${money(r.old_risk, ccy)} → ${money(r.new_risk, ccy)}` : (r.message || "");
        return mkx("label", { className: "rr-row" + (r.ok === false ? " bad" : r.same ? " muted" : "") }, cb,
          mkx("span", { className: "rr-what", textContent: `#${r.ticket} ${r.symbol} ${TYPE_NAMES[r.type] ?? ""} @ ${px(r.symbol, r.price)}` }),
          mkx("span", { className: "rr-lot", textContent: r.same ? `${lot} (เท่าเดิม)` : lot }),
          mkx("span", { className: "rr-risk muted", textContent: risk }));
      }));
      const n = changed().length;
      ok.disabled = !n;
      ok.textContent = n ? `ลบและวางใหม่ ${n} ใบ` : "ไม่มีใบที่ต้องเปลี่ยน";
    };
    const load = () => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        const my = ++seq;
        const b = body();
        if (!(Object.values(b)[0] > 0)) { head.textContent = "ใส่ค่าความเสี่ยงมากกว่า 0"; head.className = "tk-info bad"; preview = null; paint(); return; }
        save("wt.rerisk", { mode: mode.value, val: val.value });
        const r = await api(acctUrl("rerisk_preview"), { method: "POST", body: JSON.stringify(b) }).catch(() => null);
        if (my !== seq) return;
        const j = r ? await r.json().catch(() => ({})) : {};
        if (!r || !r.ok) { head.textContent = j.detail || "คำนวณไม่ได้"; head.className = "tk-info bad"; preview = null; paint(); return; }
        preview = j;
        head.className = "tk-info";
        head.textContent = `balance ${money(j.balance, ccy)} · เสี่ยงใบละ ${money(j.risk_money, ccy)}` +
          (mode.value === "money" && j.balance > 0 ? ` (${(j.risk_money / j.balance * 100).toFixed(2)}%)` : "");
        paint();
      }, 250);
    };
    allBox.onchange = () => { picked.clear(); if (allBox.checked) state.orders.forEach((o) => picked.add(o.ticket)); paint(); };
    mode.onchange = load; val.oninput = load;
    form.onsubmit = async (e) => {
      e.preventDefault();
      const xs = changed();
      if (!xs.length) return;
      if (!(await modal({ title: `ลบและวางใหม่ ${xs.length} ใบ`, danger: true, ok: "ยืนยัน",
        lines: [...xs.slice(0, 8).map((r) => `#${r.ticket} ${r.symbol} ${r.old_volume} → ${r.new_volume} lot (${money(r.new_risk, ccy)})`),
          ...(xs.length > 8 ? [`… อีก ${xs.length - 8} ใบ`] : []), "ระหว่างลบ-วางใหม่ (ไม่ถึงวินาที) ถ้าราคาแตะ ใบนั้นจะไม่ถูก fill"] }))) { openRerisk([...picked]); return; }
      const j = await tradeCall("trade/orders/rerisk", { ...body(), tickets: xs.map((r) => r.ticket), client_id: cid() });
      const bad = (j?.results || []).filter((r) => !r.ok);
      if (bad.length) await modal({ title: "บางใบไม่สำเร็จ", lines: bad.map((r) => `#${r.ticket} ${r.symbol}: ${r.message}`), ok: "รับทราบ" });
    };
    paint(); load();
  });
}
