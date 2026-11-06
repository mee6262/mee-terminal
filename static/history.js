// Mee Terminal — P5 ประวัติเทรด: รายไม้จาก MT5 deals + สรุป + กราฟเงินสะสม + journal (โน้ต/tag/ภาพ) + CSV
"use strict";

const hist = { data: null, journal: {}, loading: false };

const HIST_RANGES = { today: "วันนี้", d7: "7 วัน", d30: "30 วัน", month: "เดือนนี้", d90: "90 วัน", custom: "กำหนดเอง" };

function histRange() {
  const sel = store("wt.hist.range", "d30");
  const now = new Date();
  const day0 = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const s = (d) => Math.floor(d.getTime() / 1000);
  const to = s(now) + 60;
  switch (sel) {
    case "today": return [s(day0), to];
    case "d7": return [s(day0) - 6 * 86400, to];
    case "month": return [s(new Date(now.getFullYear(), now.getMonth(), 1)), to];
    case "d90": return [s(day0) - 89 * 86400, to];
    case "custom": {
      const f = document.getElementById("h-from").value, t = document.getElementById("h-to").value;
      if (f && t) return [s(new Date(`${f}T00:00:00`)), s(new Date(`${t}T23:59:59`))];
      return [s(day0) - 29 * 86400, to];
    }
    default: return [s(day0) - 29 * 86400, to];
  }
}

async function loadHistory() {
  if (hist.loading || !state.acct) return;
  hist.loading = true;
  const box = document.getElementById("hist-msg");
  box.textContent = "กำลังโหลด…";
  try {
    const [frm, to] = histRange();
    const [r, j] = await Promise.all([
      api(`/api/a/${encodeURIComponent(state.acct)}/history?frm=${frm}&to=${to}`),
      api(`/api/journal/${encodeURIComponent(state.acct)}`),
    ]);
    const data = await r.json();
    if (!r.ok) { box.textContent = data.detail || `โหลดไม่ได้ (${r.status})`; return; }
    hist.data = data;
    hist.journal = j.ok ? await j.json() : {};
    box.textContent = "";
    fillSymbolFilter();
    renderHistory();
  } catch (_) {
    box.textContent = "เชื่อมต่อไม่ได้";
  } finally {
    hist.loading = false;
  }
}

function fillSymbolFilter() {
  const sel = document.getElementById("h-sym");
  const cur = sel.value;
  const syms = [...new Set(hist.data.trades.map((t) => t.symbol))].sort();
  sel.replaceChildren(new Option("ทุก symbol", ""), ...syms.map((s) => new Option(s, s)));
  sel.value = syms.includes(cur) ? cur : "";
  fillTagFilter();
}

function fillTagFilter() {
  const sel = document.getElementById("h-tag");
  const cur = sel.value;
  const used = new Set(Object.values(hist.journal).flatMap((j) => j.tags || []));
  const tags = [...new Set([...(typeof setting === "function" ? setting("tags") : []).filter((t) => used.has(t)), ...[...used].sort()])];
  sel.replaceChildren(new Option("ทุกแท็ก", ""), new Option("(ไม่มีแท็ก)", "-"), ...tags.map((t) => new Option(`🏷 ${t}`, t)));
  sel.value = cur === "-" || tags.includes(cur) ? cur : "";
}

function histTrades() {
  if (!hist.data) return [];
  const sym = document.getElementById("h-sym").value;
  const src = document.getElementById("h-src").value;
  const tag = document.getElementById("h-tag").value;
  const tagsOf = (t) => hist.journal[String(t.position_id)]?.tags || [];
  return hist.data.trades.filter((t) => t.vol_out > 0
    && (!sym || t.symbol === sym)
    && (!tag || (tag === "-" ? !tagsOf(t).length : tagsOf(t).includes(tag)))
    && (src === "all" || (src === "manual" ? t.magic === 0 : t.magic !== 0)));
}

function fmtTime(t) {
  if (!t) return "–";
  const d = new Date(t * 1000);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getDate())}/${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function fmtDur(s) {
  if (s == null || s < 0) return "–";
  if (s < 3600) return `${Math.round(s / 60)}น.`;
  if (s < 86400) return `${(s / 3600).toFixed(1)}ชม.`;
  return `${(s / 86400).toFixed(1)}วัน`;
}

function histStats(trades) {
  const closed = [...trades].sort((a, b) => a.time_close - b.time_close);
  let cum = 0, peak = 0, maxDD = 0;
  const curve = closed.map((t) => { cum += t.net; peak = Math.max(peak, cum); maxDD = Math.max(maxDD, peak - cum); return [t.time_close, cum]; });
  const wins = closed.filter((t) => t.net > 0), losses = closed.filter((t) => t.net < 0);
  const sum = (a, f) => a.reduce((x, t) => x + f(t), 0);
  return {
    curve, net: cum, n: closed.length, wins: wins.length, losses: losses.length,
    avgWin: wins.length ? sum(wins, (t) => t.net) / wins.length : 0,
    avgLoss: losses.length ? sum(losses, (t) => t.net) / losses.length : 0,
    worst: losses.length ? Math.min(...losses.map((t) => t.net)) : 0,
    costs: sum(closed, (t) => t.commission + t.swap + t.fee), maxDD,
  };
}

function renderHistory() {
  const trades = histTrades();
  const st = histStats(trades);
  const cur = hist.data?.currency || "";
  const money2 = (v) => `${v >= 0 ? "+" : ""}${fmt(v)}`;
  const deposits = (hist.data?.balance || []).reduce((a, b) => a + b.amount, 0);
  const cards = [
    ["กำไรสุทธิ", `${money2(st.net)} ${cur}`, signCls(st.net)],
    ["จำนวนไม้", `${st.n} (ได้ ${st.wins} / เสีย ${st.losses})`, ""],
    ["เฉลี่ยไม้ได้", money2(st.avgWin), "up"],
    ["เฉลี่ยไม้เสีย", money2(st.avgLoss), "down"],
    ["เสียหนักสุด", money2(st.worst), "down"],
    ["Drawdown สูงสุด", `-${fmt(st.maxDD)}`, "down"],
    ["ค่าคอม+swap", money2(st.costs), signCls(st.costs)],
    ["ฝาก/ถอนในช่วง", money2(deposits), ""],
  ];
  const box = document.getElementById("hist-stats");
  box.replaceChildren(...cards.map(([k, v, c]) => { const d = el("div"); d.append(el("span", k, "muted"), el("b", v, c)); return d; }));
  drawCurve(st.curve);
  renderDeepStats(trades);

  const tb = document.getElementById("hist-rows");
  tb.replaceChildren();
  const cardsBox = document.getElementById("hist-cards");
  cardsBox.replaceChildren();
  if (!trades.length) {
    const tr = el("tr"); const td = el("td", "ไม่มีไม้ที่ปิดในช่วงนี้", "empty"); td.colSpan = 11; tr.append(td); tb.append(tr);
    cardsBox.append(el("div", "ไม่มีไม้ที่ปิดในช่วงนี้", "empty card-empty"));
    return;
  }
  for (const t of trades) {
    const j = hist.journal[String(t.position_id)];
    const jIcon = j && (j.note || j.tags?.length || j.has_image) ? "📝" : "";
    const part = t.closed ? "" : " (บางส่วน)";
    const tr = el("tr", undefined, "clickable");
    tr.append(el("td", fmtTime(t.time_close)), el("td", t.symbol), el("td", (t.side || "").toUpperCase() + part, t.side === "buy" ? "up" : "down"),
      el("td", fmt(t.vol_out), "r"), el("td", px(t.symbol, t.px_in), "r"), el("td", px(t.symbol, t.px_out), "r"),
      el("td", fmtDur(t.time_close - t.time_open), "r"), el("td", fmt(t.commission + t.swap + t.fee), "r"),
      el("td", money2(t.net), "r " + signCls(t.net)), el("td", t.magic ? String(t.magic) : "มือ", "muted"), el("td", jIcon));
    tr.addEventListener("click", () => openJournal(t));
    tb.append(tr);

    const c = el("div", undefined, "tcard");
    const top = el("div", undefined, "tcard-top");
    const side = el("span", (t.side || "").toUpperCase(), "tc-side " + (t.side === "buy" ? "buy" : "sell"));
    top.append(side, el("b", t.symbol, "tc-sym"), el("span", `${fmt(t.vol_out)} lot${part}`, "tc-vol muted"), el("b", money2(t.net), "tc-main " + signCls(t.net)));
    const mid = el("div", undefined, "tcard-mid");
    mid.append(el("span", `${px(t.symbol, t.px_in)} → ${px(t.symbol, t.px_out)}`), el("span", `${fmtTime(t.time_close)} · ${fmtDur(t.time_close - t.time_open)} ${jIcon}`));
    c.append(top, mid);
    c.addEventListener("click", () => openJournal(t));
    cardsBox.append(c);
  }
}

function drawCurve(curve) {
  const cv = document.getElementById("hist-curve");
  const w = cv.clientWidth, h = cv.clientHeight;
  const dpr = window.devicePixelRatio || 1;
  cv.width = w * dpr; cv.height = h * dpr;
  const g = cv.getContext("2d");
  g.scale(dpr, dpr);
  g.clearRect(0, 0, w, h);
  if (curve.length < 1) return;
  const pts = [[curve[0][0] - 1, 0], ...curve];
  const vs = pts.map((p) => p[1]);
  const lo = Math.min(0, ...vs), hi = Math.max(0, ...vs);
  const pad = 8, span = hi - lo || 1;
  const x = (i) => pad + (i / (pts.length - 1 || 1)) * (w - pad * 2);
  const y = (v) => pad + (1 - (v - lo) / span) * (h - pad * 2);
  g.strokeStyle = "#2a2f3a"; g.lineWidth = 1;
  g.beginPath(); g.moveTo(pad, y(0)); g.lineTo(w - pad, y(0)); g.stroke();
  g.strokeStyle = pts.at(-1)[1] >= 0 ? "#26a69a" : "#ef5350"; g.lineWidth = 2;
  g.beginPath();
  pts.forEach((p, i) => (i ? g.lineTo(x(i), y(p[1])) : g.moveTo(x(i), y(p[1]))));
  g.stroke();
  g.fillStyle = "#8a91a0"; g.font = "11px -apple-system, sans-serif";
  g.fillText(`${fmt(hi)}`, pad, pad + 10);
  g.fillText(`${fmt(lo)}`, pad, h - pad);
}

function exportCsv() {
  const trades = histTrades();
  const iso = (t) => (t ? new Date(t * 1000).toISOString() : "");
  const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const head = ["position_id", "symbol", "side", "volume", "open_time_utc", "open_price", "close_time_utc", "close_price",
    "commission", "swap", "fee", "profit", "net", "magic", "closed", "note", "tags"];
  const rows = trades.map((t) => {
    const j = hist.journal[String(t.position_id)] || {};
    return [t.position_id, t.symbol, t.side, t.vol_out, iso(t.time_open), t.px_in, iso(t.time_close), t.px_out,
      t.commission, t.swap, t.fee, t.profit, t.net, t.magic, t.closed, j.note || "", (j.tags || []).join("|")].map(q).join(",");
  });
  const blob = new Blob(["﻿" + [head.join(","), ...rows].join("\n")], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `trades_${state.acct}_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------- journal ต่อไม้ ----------
function openJournal(t) {
  const dlg = document.getElementById("modal");
  const form = dlg.querySelector("form");
  form.replaceChildren();
  form.classList.add("wide");
  const mk = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; };
  const pid = String(t.position_id);
  const j = hist.journal[pid] || { note: "", tags: [], has_image: false };
  form.append(mk("h3", { textContent: `#${pid} · ${t.symbol} ${(t.side || "").toUpperCase()} ${fmt(t.vol_out)} · ${t.net >= 0 ? "+" : ""}${fmt(t.net)}${t.open ? " (ยังเปิดอยู่)" : ""}` }));
  form.append(mk("p", { className: "modal-line muted", textContent: t.open ? `เข้า @ ${px(t.symbol, t.px_in)} — บันทึกไว้ก่อน ปิดไม้แล้วดูได้ในหน้าประวัติ`
    : `เข้า ${fmtTime(t.time_open)} @ ${px(t.symbol, t.px_in)} → ออก ${fmtTime(t.time_close)} @ ${px(t.symbol, t.px_out)}` }));
  // แท็ก: แตะเลือกจากชุดที่ตั้งไว้ (⚙️ ตั้งค่า) + พิมพ์เพิ่มเองได้
  const preset = typeof setting === "function" ? setting("tags") : [];
  const chosen = new Set(j.tags || []);
  const chipBox = mk("div", { className: "tag-chips" });
  const paintChips = () => {
    chipBox.replaceChildren(...[...new Set([...preset, ...chosen])].map((tg) => {
      const b = mk("button", { type: "button", className: "tag-chip" + (chosen.has(tg) ? " on" : ""), textContent: tg });
      b.onclick = () => { chosen.has(tg) ? chosen.delete(tg) : chosen.add(tg); paintChips(); };
      return b;
    }));
  };
  paintChips();
  const tags = mk("input", { type: "text", value: "", placeholder: "แท็กอื่น คั่นด้วย , (ไม่ต้องใส่ก็ได้)" });
  const note = mk("textarea", { rows: 3, value: j.note, placeholder: "โน้ต (ไม่บังคับ): เหตุผลเข้า/ออก, สิ่งที่ทำถูก/ผิด" });
  form.append(mk("div", { className: "modal-field" }, mk("span", { textContent: "แท็ก" }), chipBox), tags, mk("label", { className: "modal-field" }, "โน้ต", note));
  const img = mk("img", { className: "journal-img", alt: "" });
  img.hidden = !j.has_image;
  if (j.has_image) img.src = `/api/journal/${encodeURIComponent(state.acct)}/${pid}/image?v=${j.updated}`;
  let newImage;   // undefined = ไม่เปลี่ยน, null = ลบ, string = dataURL ใหม่
  const snap = mk("button", { type: "button", className: "btn-ghost", textContent: "📷 ถ่ายจากกราฟ" });
  snap.onclick = () => { close(); startSnap(t); };
  const file = mk("input", { type: "file", accept: "image/png,image/jpeg" });
  file.hidden = true;
  const up = mk("button", { type: "button", className: "btn-ghost", textContent: "🖼 อัปโหลดภาพ" });
  up.onclick = () => file.click();
  file.onchange = async () => {
    const f = file.files?.[0];
    if (!f) return;
    try { newImage = await shrinkImage(f); img.src = newImage; img.hidden = false; err.textContent = ""; }
    catch (_) { err.textContent = "อ่านภาพไม่ได้"; }
  };
  const del = mk("button", { type: "button", className: "btn-ghost danger-text", textContent: "ลบภาพ" });
  del.onclick = () => { newImage = null; img.hidden = true; };
  const goto = mk("button", { type: "button", className: "btn-ghost", textContent: "📈 เปิดกราฟที่ไม้นี้" });
  goto.onclick = () => {
    form.classList.remove("wide"); dlg.close();
    showView("chart");
    state.charts?.openSymbol(t.symbol);
    setTimeout(() => state.charts?.panels[state.charts.active]?.chart.scrollToTimestamp(t.time_open * 1000), 800);
  };
  goto.hidden = !!t.open;
  form.append(img, mk("div", { className: "ed-more" }, snap, up), mk("div", { className: "ed-more" }, goto, del), file);
  const err = mk("div", { className: "tk-info bad" });
  const cancel = mk("button", { type: "button", className: "btn-ghost", textContent: "ยกเลิก" });
  const ok = mk("button", { type: "submit", className: "btn-primary", textContent: "บันทึก" });
  form.append(err, mk("div", { className: "modal-btns" }, cancel, ok));
  const close = () => { form.classList.remove("wide"); dlg.close(); };
  cancel.onclick = close;
  dlg.oncancel = (e) => { e.preventDefault(); close(); };
  form.onsubmit = async (e) => {
    e.preventDefault();
    const tagList = [...new Set([...chosen, ...tags.value.split(",").map((s) => s.trim().slice(0, 30)).filter(Boolean)])].slice(0, 20);
    ok.disabled = true;
    try {
      const base = `/api/journal/${encodeURIComponent(state.acct)}/${pid}`;
      const r = await api(base, { method: "PUT", body: JSON.stringify({ note: note.value, tags: tagList }) });
      if (!r.ok) { err.textContent = (await r.json().catch(() => ({}))).detail || "บันทึกไม่สำเร็จ"; return; }
      if (newImage !== undefined) {
        const ri = await api(`${base}/image`, { method: "PUT", body: JSON.stringify({ data: newImage }) });
        if (!ri.ok) { err.textContent = (await ri.json().catch(() => ({}))).detail || "บันทึกภาพไม่สำเร็จ"; return; }
      }
      const jr = await api(`/api/journal/${encodeURIComponent(state.acct)}`);
      if (jr.ok) hist.journal = await jr.json();
      if (hist.data) { fillTagFilter(); renderHistory(); }
      close();
    } finally {
      ok.disabled = false;
    }
  };
  dlg.showModal();
}

// บันทึกไม้ที่ยังเปิดอยู่ (ตาราง positions) — position_id = ticket ของ position
async function journalForPosition(p) {
  try {
    const jr = await api(`/api/journal/${encodeURIComponent(state.acct)}`);
    if (jr.ok) hist.journal = await jr.json();
  } catch (_) { /* ใช้ของเดิม */ }
  openJournal({ position_id: p.ticket, symbol: p.symbol, side: p.type === 0 ? "buy" : "sell", vol_out: p.volume, net: p.profit,
    px_in: p.price_open, time_open: 0, open: true });
}

// ย่อภาพให้ไม่เกิน 1600px / jpeg (server รับ ≤700KB)
function shrinkImage(fileOrUrl) {
  return new Promise((resolve, reject) => {
    const im = new Image();
    im.onload = () => {
      const k = Math.min(1, 1600 / Math.max(im.width, im.height));
      const cv = document.createElement("canvas");
      cv.width = Math.round(im.width * k); cv.height = Math.round(im.height * k);
      cv.getContext("2d").drawImage(im, 0, 0, cv.width, cv.height);
      let q = 0.85, out = cv.toDataURL("image/jpeg", q);
      while (out.length > 900 * 1024 && q > 0.4) { q -= 0.15; out = cv.toDataURL("image/jpeg", q); }
      resolve(out);
    };
    im.onerror = reject;
    im.src = typeof fileOrUrl === "string" ? fileOrUrl : URL.createObjectURL(fileOrUrl);
  });
}

// ถ่ายจากกราฟ: ไปหน้ากราฟที่ไม้นั้น แล้วกดปุ่มลอยเพื่อถ่าย+แนบ
let snapFor = null;
function startSnap(t) {
  snapFor = t;
  showView("chart");
  if (typeof setTab === "function" && document.body.classList.contains("mobile")) setTab("chart");
  state.charts?.openSymbol(t.symbol);
  if (t.time_open) setTimeout(() => state.charts?.panels[state.charts.active]?.chart.scrollToTimestamp(t.time_open * 1000), 800);
  const bar = document.getElementById("snap-bar");
  bar.querySelector("span").textContent = `แนบภาพให้ไม้ #${t.position_id} ${t.symbol} — จัดกราฟให้เห็นจุดเข้า/ออกแล้วกดถ่าย`;
  bar.hidden = false;
}

async function doSnap() {
  const t = snapFor;
  const p = state.charts?.panels[state.charts.active];
  if (!t || !p) return;
  const raw = p.chart.getConvertPictureUrl(true, "jpeg", "#0f1115");
  if (!raw || raw.length < 200) { toast("ถ่ายภาพกราฟไม่ได้", false); return; }
  const data = await shrinkImage(raw);
  const r = await api(`/api/journal/${encodeURIComponent(state.acct)}/${t.position_id}/image`, { method: "PUT", body: JSON.stringify({ data }) });
  if (!r.ok) { toast((await r.json().catch(() => ({}))).detail || "บันทึกภาพไม่สำเร็จ", false); return; }
  toast(`แนบภาพให้ไม้ #${t.position_id} แล้ว`);
  endSnap();
  if (document.body.classList.contains("mobile")) setTab("history"); else showView("history");
}

function endSnap() { snapFor = null; document.getElementById("snap-bar").hidden = true; }

// ---------- สลับหน้า (เดสก์ท็อป) ----------
// view: chart | history | news — เดสก์ท็อปใช้ class บน body, มือถือใช้แท็บล่าง
function showView(view) {
  document.body.classList.toggle("view-history", view === "history");
  document.body.classList.toggle("view-news", view === "news");
  document.getElementById("nav-history").classList.toggle("on", view === "history");
  document.getElementById("nav-news").classList.toggle("on", view === "news");
  if (document.body.classList.contains("mobile") && typeof setTab === "function") setTab(view);
  if (view === "history") loadHistory();
  else if (view === "news") { renderNews(); requestAnimationFrame(scrollNewsToNow); }
  else requestAnimationFrame(() => state.charts?.resizeAll());
}

function initHistory() {
  const $h = (id) => document.getElementById(id);
  const range = $h("h-range");
  range.replaceChildren(...Object.entries(HIST_RANGES).map(([k, v]) => new Option(v, k)));
  range.value = store("wt.hist.range", "d30");
  const paintCustom = () => { $h("h-custom").hidden = range.value !== "custom"; };
  paintCustom();
  range.addEventListener("change", () => { save("wt.hist.range", range.value); paintCustom(); if (range.value !== "custom") loadHistory(); });
  for (const id of ["h-from", "h-to"]) $h(id).addEventListener("change", loadHistory);
  for (const id of ["h-sym", "h-src", "h-tag"]) $h(id).addEventListener("change", renderHistory);
  $h("h-refresh").addEventListener("click", loadHistory);
  $h("h-csv").addEventListener("click", exportCsv);
  $h("snap-go").addEventListener("click", doSnap);
  $h("snap-x").addEventListener("click", endSnap);
  $h("nav-history").addEventListener("click", () => showView(document.body.classList.contains("view-history") ? "chart" : "history"));
  window.addEventListener("resize", () => { if (hist.data) drawCurve(histStats(histTrades()).curve); });
}
