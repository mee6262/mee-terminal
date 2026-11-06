// Mee Terminal — Bar Replay (แบบ TradingView) + ออเดอร์จำลอง
// เฟส 1: เลือกจุดเริ่ม (วันเวลา / แตะบนกราฟ) -> เล่น ▶ / หยุด ⏸ / ทีละแท่ง ⏭ / ความเร็ว / ออก
// เฟส 2: ออเดอร์จำลอง Market / Limit / Stop (Lot หรือ Risk%), ลากเส้น TP/SL บนกราฟ, ชน TP/SL อัตโนมัติ, สรุปผล + บันทึกรอบ
// ไม่ยุ่งกับ MT5 จริงเลย: ข้อมูลแท่งดึงครั้งเดียว (/rates_range), ออเดอร์เก็บในหน้าเว็บ, ผลรอบเก็บใน localStorage ของเครื่องนี้
// สมมติ: ราคาแท่ง = Bid, Ask = Bid + สเปรดคงที่ (สเปรดสดตอนเริ่ม), ไม่มี slippage/swap/ค่าคอม, แท่งเดียวชนทั้ง TP และ SL = โดน SL ก่อน
"use strict";

const RP_BEFORE = 300;            // แท่งก่อนจุดเริ่มให้เห็นบริบท
const RP_AFTER = 50000;           // ช่วงหลังจุดเริ่มที่ดึงมาเล่นได้ (นับเป็นช่องเวลา TF ฐาน รวมเสาร์-อาทิตย์; worker รับรวมไม่เกิน 60,000)
const RP_SPEEDS = [1, 2, 5, 10, 20];
const RP_KEY = "wt.replay.sessions";
const RP = { panel: null };

function rpTfMs(tf) { return ({ M1: 6e4, M5: 3e5, M15: 9e5, M30: 18e5, H1: 36e5, H4: 144e5, D1: 864e5, W1: 6048e5, MN1: 2592e6 })[tf] || 6e4; }
const rpDigits = () => state.digits[RP.sym] ?? 5;
const rpFmt = (v) => Number(v).toFixed(rpDigits());
const rpNow = () => RP.bars[RP.cursor];
const rpBid = () => rpNow().close;
const rpAsk = () => rpNow().close + RP.spread;

// ---------- เข้า replay ----------
function openReplay() {
  const p = state.charts?.panels[state.charts.active];
  if (!p) return;
  openDialog("⏪ Bar Replay", (form, close) => {
    const local = (ms) => { const d = new Date(ms); const z = (n) => String(n).padStart(2, "0"); return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}T${z(d.getHours())}:${z(d.getMinutes())}`; };
    form.append(mkx("p", { className: "modal-line muted small", textContent: `${p.symbol} · ${p.tf} (เปลี่ยน symbol บนกราฟก่อนเริ่ม) — ไม่ส่งคำสั่งจริง ออเดอร์เป็นแบบจำลองทั้งหมด` }));
    // TF ฐาน = ความละเอียดที่ราคาเดิน: ระหว่าง replay สลับดู TF ที่ใหญ่กว่าได้ทุกตัว (แท่งใหญ่ประกอบจากแท่งฐานที่เดินไปแล้ว ไม่เห็นอนาคต)
    const maxI = TFS.indexOf(p.tf);
    const baseSel = mkx("select", {}, ...TFS.slice(0, maxI + 1).map((t) => mkx("option", { value: t, textContent: t })));
    const want = store("wt.replay.base", "M5");
    baseSel.value = TFS.indexOf(want) >= 0 && TFS.indexOf(want) <= maxI ? want : p.tf;
    const baseHint = mkx("small", { className: "muted" });
    const paintHint = () => { baseHint.textContent = `ดูได้: ${TFS.slice(TFS.indexOf(baseSel.value)).join(" ")} · เล่นต่อเนื่องได้ ~${rpSpan(baseSel.value)}`; };
    baseSel.onchange = paintHint; paintHint();
    const at = mkx("input", { type: "datetime-local", value: local(Date.now() - 7 * 86400000) });
    // 🙈 ซ่อนวันที่: สุ่มจุดเริ่มให้เองและไม่บอก — แกนเวลา / เส้นข่าว / ไม้จริงบนกราฟถูกซ่อนจนจบรอบ
    const blind = mkx("input", { type: "checkbox", checked: !!store("wt.replay.blind", false) });
    const blindNote = mkx("div", { className: "muted small", textContent: "🙈 วันที่จะถูกสุ่มในช่วงด้านล่างและซ่อนไว้ — เห็นวันที่ตอนดูสรุปผลหลังจบ" });
    // 🎲 สุ่มจุดเริ่มในช่วงที่เลือก (ถึง 7 วันก่อน) — วันเสาร์/อาทิตย์เลื่อนไปจันทร์ ฝึกแบบไม่เลือกช่วงเอง
    const rndRange = mkx("select", {}, ...[[90, "3 เดือน"], [365, "1 ปี"], [1095, "3 ปี"], [1825, "5 ปี"]].map(([v, t]) => mkx("option", { value: String(v), textContent: `สุ่มใน ${t}` })));
    rndRange.value = String(store("wt.replay.rnd", 365));
    const rnd = mkx("button", { type: "button", className: "btn-ghost", textContent: "🎲 สุ่ม" });
    rnd.onclick = () => {
      save("wt.replay.rnd", Number(rndRange.value));
      const hi = Date.now() - 7 * 864e5, lo = Date.now() - Number(rndRange.value) * 864e5;
      const d = new Date(lo + Math.random() * (hi - lo));
      d.setMinutes(0, 0, 0);
      const wd = d.getDay();
      if (wd === 6 || wd === 0) { d.setDate(d.getDate() + (wd === 6 ? 2 : 1)); d.setHours(9); }
      at.value = local(d.getTime());
      return d.getTime();
    };
    const atField = mkx("label", { className: "modal-field" }, mkx("span", { textContent: "เริ่มที่ (เวลาเครื่อง)" }), at);
    const paintBlind = () => { atField.hidden = blind.checked; blindNote.hidden = !blind.checked; rnd.hidden = blind.checked; pick.hidden = blind.checked; };
    blind.onchange = () => { save("wt.replay.blind", blind.checked); paintBlind(); };
    const bal = mkx("input", { type: "number", min: "1", step: "any", value: String(Math.round(store("wt.replay.balance", state.account?.balance || 10000))) });
    form.append(mkx("label", { className: "modal-field" }, mkx("span", { textContent: "TF ฐาน (เดินทีละ)" }), baseSel), baseHint,
      mkx("label", { className: "set-row chk" }, blind, mkx("span", { textContent: "🙈 ซ่อนวันที่ (ฝึกแบบไม่รู้ช่วงเวลา)" })),
      atField, blindNote,
      mkx("div", { className: "row rp-rnd" }, rndRange, rnd),
      mkx("label", { className: "modal-field" }, mkx("span", { textContent: `ทุนเริ่มต้น (${state.account?.currency || ""})` }), bal));
    const err = mkx("div", { className: "tk-info bad" });
    const pick = mkx("button", { type: "button", className: "btn-ghost", textContent: "📍 เลือกจุดบนกราฟ" });
    const go = mkx("button", { type: "button", className: "btn-primary", textContent: "▶ เริ่ม" });
    const hist = mkx("button", { type: "button", className: "btn-ghost", textContent: "📊 ผลรอบที่ผ่านมา" });
    const saveBal = () => { save("wt.replay.base", baseSel.value); const b = Number(bal.value); if (b > 0) save("wt.replay.balance", b); return b > 0 ? b : 10000; };
    pick.onclick = () => {
      const b = saveBal();
      close();
      toast("แตะที่แท่งบนกราฟเพื่อเลือกจุดเริ่ม replay");
      state.charts.startPick(document.createElement("span"), (panel, _v, ts) => { if (ts) replayStart(panel, ts, b, null, baseSel.value); });
    };
    go.onclick = () => {
      const t = blind.checked ? rnd.onclick() : new Date(at.value).getTime();
      if (!Number.isFinite(t) || t >= Date.now()) { err.textContent = "เลือกเวลาในอดีต"; return; }
      const b = saveBal();
      close();
      replayStart(p, t, b, null, baseSel.value, blind.checked);
    };
    hist.onclick = () => rpHistory();
    form.append(err, mkx("div", { className: "modal-btns three" }, hist, pick, go));
    paintBlind();
  }, { wide: false });
}

async function replayStart(panel, startMs, balance, resume = null, base = panel.tf, blind = !!resume?.blind) {
  if (RP.panel) replayStop({ silent: true, reload: RP.panel !== panel });
  if (TFS.indexOf(base) < 0 || TFS.indexOf(base) > TFS.indexOf(panel.tf)) base = panel.tf;
  const tfMs = rpTfMs(base);
  const frm = Math.floor((startMs - RP_BEFORE * tfMs) / 1000), to = Math.floor(Math.min(Date.now(), startMs + RP_AFTER * tfMs) / 1000);
  toast("กำลังโหลดแท่งสำหรับ replay…");
  let rows;
  try {
    const r = await api(`/api/a/${encodeURIComponent(state.acct)}/rates_range?${new URLSearchParams({ symbol: panel.symbol, tf: base, frm, to })}`);
    rows = await r.json();
    if (!r.ok) { toast(rows.detail || `โหลดไม่ได้ (${r.status})`, false); return; }
  } catch (_) { toast("เชื่อมต่อไม่ได้", false); return; }
  const bars = rows.map(toBar);
  let cursor = -1;
  for (let i = 0; i < bars.length; i++) if (bars[i].timestamp <= startMs) cursor = i;
  if (cursor < 0) cursor = 0;
  if (bars.length < 2 || cursor >= bars.length - 1) { toast("ไม่มีแท่งหลังจุดเริ่ม — MT5 อาจไม่มีประวัติช่วงนั้น", false); return; }
  const q = state.quotes[panel.symbol];
  Object.assign(RP, {
    panel, sym: panel.symbol, tf: base, base, vtf: base, views: {}, pre: [], blind, bars, cursor, startIdx: cursor, startMs, playing: false, timer: null, speed: store("wt.replay.speed", 1),
    spread: q ? Math.max(0, q.ask - q.bid) : 0, balance0: balance, pos: [], ord: [], closed: [], seq: 0, hist: [], sid: Date.now(),
    mode: store("wt.replay.mode", "lot"), lot: store("wt.replay.lot", 0.01), risk: store("wt.replay.risk", 1), dragZone: false,
  });
  if (resume?.state) {   // เล่นต่อจากรอบที่บันทึกไว้
    const st = resume.state;
    let c = RP.cursor;
    for (let i = 0; i < bars.length; i++) if (bars[i].timestamp <= st.cursorTs) c = i;
    Object.assign(RP, { cursor: c, sid: resume.sid, pos: rpClone(st.pos), ord: rpClone(st.ord), closed: rpClone(resume.trades), seq: st.seq || 0,
      spread: st.spread ?? RP.spread });
  }
  loadSpec(panel.symbol);
  if (panel.tf !== base && !(await rpLoadView(panel.tf))) return;   // เริ่มด้วยการดู TF ที่ใหญ่กว่าฐาน
  panel.replay = RP;
  document.body.classList.add("replaying");
  rpBuildBar();
  rpPaintTfs();
  if (blind) { rpBlindAxis(panel, true); panel.setHist([]); applyNewsLines(panel); }
  if (typeof applyLevels === "function") applyLevels(panel);   // PDH/PWH ตามเวลาที่เล่น ไม่ใช่ของวันนี้
  panel.chart.resetData();   // โหลดแท่งใหม่ผ่าน replayGetBars (setPeriod ค่าเดิม = ไม่โหลดซ้ำ)
  syncLines();
}

// dataLoader ตอน replay: ให้แท่งถึงตำแหน่งที่เล่น (ไม่โหลดย้อนเพิ่ม)
function replayGetBars(panel, type, callback) {
  if (type !== "init") { callback([], { forward: false, backward: false }); return; }
  callback(rpViewBars(), { forward: false, backward: false });
  setTimeout(() => { panel.reapplyLines(); rpAfterStep(); panel.chart.scrollToRealTime(0); }, 0);
}

// ---------- MTF: ดู TF ที่ใหญ่กว่าฐาน ----------
// แท่งที่ปิดแล้ว ณ เวลาที่เล่นถึง = แท่งจาก MT5 ตรงๆ, แท่งที่กำลังก่อตัว = รวมจากแท่งฐานที่เดินผ่านแล้วเท่านั้น (ไม่เห็นอนาคต)
function rpSpan(base) {
  const d = (RP_AFTER * rpTfMs(base)) / 864e5;   // ช่วงตามปฏิทิน
  return d >= 730 ? `${(d / 365).toFixed(1)} ปี` : d >= 60 ? `${Math.round(d / 30)} เดือน` : `${Math.round(d)} วัน`;
}

async function rpFetch(tf, frm, to) {
  const r = await api(`/api/a/${encodeURIComponent(state.acct)}/rates_range?${new URLSearchParams({ symbol: RP.sym, tf, frm: Math.floor(frm / 1000), to: Math.floor(to / 1000) })}`);
  const j = await r.json();
  if (!r.ok) throw new Error(j.detail || `HTTP ${r.status}`);
  return j.map(toBar);
}

function rpBucket(v, ts) {   // index แท่ง TF ใหญ่ที่ครอบเวลา ts (-1 = ไม่มี)
  let lo = 0, hi = v.bars.length - 1, k = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (v.bars[m].timestamp <= ts) { k = m; lo = m + 1; } else hi = m - 1; }
  return k >= 0 && ts < v.ends[k] ? k : -1;
}

// โหลดแท่ง TF ใหญ่ทั้งช่วง replay (ใช้เฉพาะแท่งที่ปิดแล้ว ณ เวลาที่เล่น) — quiet = ไม่แจ้งเตือน (เช่น เส้น PDH/PWH)
async function rpEnsureView(tf, quiet = false) {
  if (RP.views[tf]) return true;
  const tfMs = rpTfMs(tf), last = RP.bars.at(-1).timestamp + rpTfMs(RP.base);
  if (!quiet) toast(`กำลังโหลด ${tf} สำหรับ replay…`);
  try {
    const bars = await rpFetch(tf, RP.startMs - RP_BEFORE * tfMs, last);
    if (!bars.length) { if (!quiet) toast(`ไม่มีแท่ง ${tf} ช่วงนี้`, false); return false; }
    const ends = bars.map((b, i) => (i + 1 < bars.length ? bars[i + 1].timestamp : b.timestamp + tfMs));
    RP.views[tf] = { bars, ends };
    return true;
  } catch (e) { if (!quiet) toast(`โหลด ${tf} ไม่ได้: ${e.message}`, false); return false; }
}

async function rpLoadView(tf) {
  if (tf === RP.base) { RP.vtf = tf; return true; }
  if (!(await rpEnsureView(tf))) return false;
  // แท่งที่กำลังก่อตัวเริ่มก่อนแท่งฐานชุดแรก (เช่น W1/MN): ดึงแท่งฐานช่วงต้นแท่งมาเพิ่ม
  const v = RP.views[tf], k = rpBucket(v, RP.bars[RP.cursor].timestamp), first = RP.pre[0]?.timestamp ?? RP.bars[0].timestamp;
  if (k >= 0 && v.bars[k].timestamp < first) {
    try {
      const add = (await rpFetch(RP.base, v.bars[k].timestamp, first - 1)).filter((b) => b.timestamp < first);
      RP.pre = add.concat(RP.pre);
    } catch (e) { toast(`โหลดแท่งฐานช่วงต้น ${tf} ไม่ได้ — แท่งปัจจุบันอาจไม่ครบ`, false); }
  }
  RP.vtf = tf;
  return true;
}

// แท่ง TF ใหญ่ index k รวมจากแท่งฐานถึงตำแหน่งที่เล่น
function rpFormBar(v, k) {
  const t0 = v.bars[k].timestamp, t1 = Math.min(v.ends[k], RP.bars[RP.cursor].timestamp + 1);
  let o = null, h = -Infinity, l = Infinity, c = 0, vol = 0;
  const add = (b) => { if (b.timestamp < t0 || b.timestamp >= t1) return; if (o == null) o = b.open; h = Math.max(h, b.high); l = Math.min(l, b.low); c = b.close; vol += b.volume || 0; };
  for (const b of RP.pre) add(b);
  let lo = 0, hi = RP.cursor;
  while (lo < hi) { const m = (lo + hi) >> 1; if (RP.bars[m].timestamp < t0) lo = m + 1; else hi = m; }
  for (let i = lo; i <= RP.cursor; i++) add(RP.bars[i]);
  return o == null ? null : { timestamp: t0, open: o, high: h, low: l, close: c, volume: vol };
}

function rpViewBars() {
  if (RP.vtf === RP.base) return RP.bars.slice(0, RP.cursor + 1);
  const v = RP.views[RP.vtf], now = RP.bars[RP.cursor].timestamp, out = [];
  for (let i = 0; i < v.bars.length && v.bars[i].timestamp <= now; i++) {
    if (v.ends[i] <= now + rpTfMs(RP.base)) out.push(v.bars[i]);            // ปิดแล้ว ณ เวลาที่เล่น
    else { const f = rpFormBar(v, i); if (f) out.push(f); break; }          // กำลังก่อตัว
  }
  return out;
}

// เปลี่ยน TF ระหว่าง replay (ต้อง >= TF ฐาน) — ไม้/ออเดอร์/เวลาเดิม
async function replaySetTf(panel, tf) {
  if (TFS.indexOf(tf) < TFS.indexOf(RP.base)) { toast(`replay นี้เดินทีละ ${RP.base} — ดูได้ ${TFS.slice(TFS.indexOf(RP.base)).join(" ")} (เริ่มใหม่ด้วย TF ฐานเล็กกว่าเพื่อดู ${tf})`, false); return; }
  if (tf === panel.tf) return;
  rpPlay(false);
  if (!(await rpLoadView(tf)) || RP.panel !== panel) return;
  panel.tf = tf;
  panel.paintTf();
  rpPaintTfs();
  panel.setZone(null);
  panel.chart.setPeriod(TF_PERIOD[tf]);   // -> replayGetBars (แท่งของ TF ใหม่ถึงเวลาที่เล่น)
  panel.applyIndicators();
}

// ซ่อน/คืนวันเวลาบนแกนล่าง + ป้ายเวลาของ crosshair
function rpBlindAxis(panel, on) {
  panel.chart.setStyles({ xAxis: { tickText: { show: !on } }, crosshair: { vertical: { text: { show: !on } } } });
}

function rpPaintTfs() {
  const p = RP.panel;
  if (!p?.tfBtns) return;
  for (const [tf, b] of Object.entries(p.tfBtns)) b.classList.toggle("rp-off", TFS.indexOf(tf) < TFS.indexOf(RP.base));
}

const rpClone = (x) => JSON.parse(JSON.stringify(x || []));

// สถานะก่อนเดินแต่ละแท่ง (ไว้ย้อนกลับ ⏮) — ไม้ที่ปิดแล้วไม่เปลี่ยน เก็บแค่จำนวน
function rpSnap() {
  RP.hist.push({ cursor: RP.cursor, pos: rpClone(RP.pos), ord: rpClone(RP.ord), closed: RP.closed.length, seq: RP.seq });
  if (RP.hist.length > 5000) RP.hist.shift();
}

function rpBack() {
  if (!RP.panel) return;
  rpPlay(false);
  const h = RP.hist.pop();
  if (!h) { toast("ย้อนได้ถึงจุดเริ่ม (หรือจุดที่กดเล่นต่อ) เท่านั้น", false); return; }
  Object.assign(RP, { cursor: h.cursor, pos: h.pos, ord: h.ord, closed: RP.closed.slice(0, h.closed), seq: h.seq });
  RP.panel.setZone(null);
  RP.panel.chart.resetData();   // วาดแท่งใหม่ถึงตำแหน่งที่ย้อน (replayGetBars)
}

// บันทึกรอบ (กดได้ตลอด ไม่ต้องจบ) — รอบเดียวกันบันทึกซ้ำ = ทับของเดิม, เก็บสถานะไว้กดเล่นต่อได้
function rpRecord() {
  return { sid: RP.sid, sym: RP.sym, tf: RP.base, vtf: RP.vtf, blind: !!RP.blind, startMs: RP.startMs, from: RP.bars[RP.startIdx]?.timestamp, to: rpNow()?.timestamp,
    balance0: RP.balance0, trades: RP.closed.slice(), currency: state.account?.currency || "", saved: Date.now(),
    state: { cursorTs: rpNow()?.timestamp, pos: rpClone(RP.pos), ord: rpClone(RP.ord), seq: RP.seq, spread: RP.spread } };
}

// ผลรอบเก็บที่ server (ดูได้ทุกเครื่อง + สำรองไปกับ db) — localStorage เป็นสำเนาไว้ใช้ตอนต่อ server ไม่ได้
function rpPut(rec) { return api(`/api/replay/${rec.sid}`, { method: "PUT", body: JSON.stringify({ value: rec }) }); }

async function rpSessions() {
  try {
    const r = await api("/api/replay");
    if (!r.ok) throw new Error(r.status);
    let list = await r.json();
    const local = localGet(RP_KEY) || [];
    if (!localGet("wtl.replay.migrated") && local.length) {   // ย้ายผลรอบเดิมของเครื่องนี้ขึ้น server ครั้งเดียว
      const have = new Set(list.map((x) => x.sid));
      for (const [i, x] of local.slice().reverse().entries()) {
        const rec = { ...x, sid: x.sid || x.saved || Date.now() + i };
        if (!have.has(rec.sid)) await rpPut(rec);
      }
      list = await (await api("/api/replay")).json();
    }
    localSet("wtl.replay.migrated", true);
    localSet(RP_KEY, list.slice(0, 30));
    return list;
  } catch (_) { return localGet(RP_KEY) || []; }
}

function rpSave(rec = rpRecord()) {
  const list = (localGet(RP_KEY) || []).filter((x) => !(rec.sid && x.sid === rec.sid));
  list.unshift(rec);
  localSet(RP_KEY, list.slice(0, 30));
  const msg = `💾 บันทึกรอบ replay แล้ว${rec.state?.pos?.length || rec.state?.ord?.length ? " (รวมไม้ที่ยังเปิด)" : ""} — เล่นต่อได้ที่ ⏪ → ผลรอบที่ผ่านมา`;
  rpPut(rec).then((r) => toast(r.ok ? msg : "บันทึกในเครื่องนี้แล้ว แต่ส่งขึ้น server ไม่ได้ — ลองกด 💾 อีกครั้ง", r.ok))
    .catch(() => toast("บันทึกในเครื่องนี้แล้ว แต่ส่งขึ้น server ไม่ได้ — ลองกด 💾 อีกครั้ง", false));
}

async function replayResume(rec) {
  const p = state.charts?.panels[state.charts.active];
  if (!p) return;
  if (RP.panel) replayStop({ silent: true });
  if (p.symbol !== rec.sym) p.setSymbol(rec.sym);
  const view = rec.vtf || rec.tf;
  if (p.tf !== view) p.setTf(view);
  await replayStart(p, rec.startMs || rec.from, rec.balance0, rec, rec.tf);
}

function replayStop({ silent = false, reload = true } = {}) {
  const panel = RP.panel;
  if (!panel) return;
  clearInterval(RP.timer);
  const summary = rpStats();
  const snapshot = rpRecord();
  RP.bar?.remove();
  for (const b of Object.values(panel.tfBtns || {})) b.classList.remove("rp-off");
  if (RP.blind) rpBlindAxis(panel, false);
  panel.replay = null;
  RP.panel = null;
  document.body.classList.remove("replaying");
  panel.setZone(null);
  panel.setLines("replay", []);
  if (reload) panel.applySymbol();
  syncLines();
  if (!silent && summary.n) rpSummary(snapshot, true);
}

// ---------- แถบควบคุม ----------
function rpBuildBar() {
  const p = RP.panel;
  RP.bar?.remove();
  const bar = mkx("div", { className: "replay-bar" });
  const btn = (text, title, fn, cls = "") => { const b = mkx("button", { type: "button", className: `rp-btn ${cls}`, textContent: text, title }); b.onclick = fn; return b; };
  RP.el = {};
  RP.el.time = mkx("span", { className: "rp-time" });
  RP.el.play = btn("▶", "เล่น / หยุด (Space)", () => rpPlay(!RP.playing));
  const back = btn("⏮", "ย้อนแท่งก่อนหน้า (←) — ไม้/ออเดอร์ย้อนตาม", () => rpBack());
  const step = btn("⏭", "ไปแท่งถัดไปของ TF ที่ดูอยู่ (→)", () => { rpPlay(false); rpStep(); });
  const speed = mkx("select", { className: "rp-speed", title: "ความเร็ว (แท่ง/วินาที)" }, ...RP_SPEEDS.map((s) => mkx("option", { value: String(s), textContent: `${s}x` })));
  speed.value = String(RP.speed);
  speed.onchange = () => { RP.speed = Number(speed.value); save("wt.replay.speed", RP.speed); if (RP.playing) rpPlay(true); };
  const exit = btn("⏹ ออก", "จบ replay", () => replayStop(), "rp-exit");
  // ออเดอร์จำลอง
  const modeBtn = btn(RP.mode === "lot" ? "Lot" : "Risk%", "สลับ Lot / Risk% (Risk% ใช้ SL = ATR14×1.5)", () => {
    RP.mode = RP.mode === "lot" ? "risk" : "lot"; save("wt.replay.mode", RP.mode);
    modeBtn.textContent = RP.mode === "lot" ? "Lot" : "Risk%"; vol.value = String(RP.mode === "lot" ? RP.lot : RP.risk);
  }, "rp-mode");
  const vol = mkx("input", { className: "rp-vol", inputMode: "decimal", value: String(RP.mode === "lot" ? RP.lot : RP.risk) });
  vol.onchange = () => { const v = Number(vol.value); if (v > 0) { if (RP.mode === "lot") { RP.lot = v; save("wt.replay.lot", v); } else { RP.risk = v; save("wt.replay.risk", v); } } };
  RP.el.sell = btn("SELL", "Sell ราคาตลาด (S)", () => rpMarket("sell"), "rp-sell");
  RP.el.buy = btn("BUY", "Buy ราคาตลาด (B)", () => rpMarket("buy"), "rp-buy");
  const pend = btn("⌖ Pending", "แตะราคาบนกราฟ -> เลือก Limit/Stop", (e) => {
    rpPlay(false);
    state.charts.startPick(e.currentTarget, (_p, v) => rpPendingAt(v));
  });
  RP.el.pl = mkx("span", { className: "rp-pl" });
  const stats = btn("📊", "สรุปผลรอบนี้", () => rpSummary(null, false));
  const saveBtn = btn("💾", "บันทึกรอบนี้ (ไม่ต้องจบ — กลับมาเล่นต่อได้)", () => rpSave());
  bar.append(mkx("span", { className: "rp-badge", textContent: "⏪ REPLAY" }), RP.el.time, back, RP.el.play, step, speed,
    mkx("span", { className: "rp-sep" }), modeBtn, vol, RP.el.sell, RP.el.buy, pend,
    mkx("span", { className: "rp-sep" }), RP.el.pl, stats, saveBtn, exit);
  for (const t of ["pointerdown", "mousedown", "touchstart"]) bar.addEventListener(t, (e) => e.stopPropagation(), { passive: true });
  p.el.insertBefore(bar, p.body);
  RP.bar = bar;
  requestAnimationFrame(() => p.chart.resize());
}

function rpPlay(on) {
  RP.playing = on;
  clearInterval(RP.timer);
  if (on) RP.timer = setInterval(rpStep, 1000 / RP.speed);
  if (RP.el) RP.el.play.textContent = on ? "⏸" : "▶";
}

function rpStep() {
  if (!RP.panel) return;
  if (RP.cursor >= RP.bars.length - 1) { rpPlay(false); toast("ถึงแท่งล่าสุดที่มีแล้ว"); return; }
  rpSnap();
  RP.cursor++;
  rpProcess(rpNow());
  if (RP.vtf === RP.base) RP.panel.barCb?.(rpNow());
  else {
    // ดู TF ใหญ่: ⏭ = ไปจนจบแท่ง TF นั้น (fill / TP / SL ยังเช็คทีละแท่งฐาน)
    const v = RP.views[RP.vtf], k = rpBucket(v, rpNow().timestamp);
    while (k >= 0 && RP.cursor < RP.bars.length - 1 && RP.bars[RP.cursor + 1].timestamp < v.ends[k]) { RP.cursor++; rpProcess(rpNow()); }
    const f = k >= 0 ? rpFormBar(v, k) : null;
    if (f) RP.panel.barCb?.(f);
  }
  rpAfterStep();
}

function rpAfterStep() {
  const p = RP.panel;
  if (!p) return;
  const b = rpNow();
  p.setQuote(rpBid(), rpAsk());
  p.setLines("quote", [
    { key: "bid", value: rpBid(), color: b.close < b.open ? "#ef5350" : "#26a69a", dashed: true, locked: true, chips: [] },
    { key: "ask", value: rpAsk(), color: "#f23645", dashed: true, locked: true, chips: [] },
  ]);
  rpRenderLines();
  if (typeof levelsReplayTick === "function") levelsReplayTick(p);
  p.paintRt(); p.paintOhlcSoon();
  const d = new Date(b.timestamp);
  const z = (n) => String(n).padStart(2, "0");
  RP.el.time.textContent = RP.blind ? `🙈 แท่งที่ ${RP.cursor - RP.startIdx}`
    : `${z(d.getDate())}/${z(d.getMonth() + 1)}/${String(d.getFullYear()).slice(2)} ${z(d.getHours())}:${z(d.getMinutes())}`;
  RP.el.sell.textContent = `SELL ${rpFmt(rpBid())}`;
  RP.el.buy.textContent = `BUY ${rpFmt(rpAsk())}`;
  const s = rpStats();
  const fl = RP.pos.reduce((a, x) => a + (rpPnl(x, x.side === "buy" ? rpBid() : rpAsk()) || 0), 0);
  RP.el.pl.textContent = `ปิดแล้ว ${plMoney(s.net)} · ${s.n} ไม้${RP.pos.length ? ` · ลอย ${plMoney(fl)}` : ""}`;
  RP.el.pl.className = `rp-pl ${signCls(s.net + fl)}`;
}

// ---------- ออเดอร์จำลอง ----------
function rpPnl(x, exitPx) { return pnlAt(RP.sym, x.side, x.open ?? x.price, exitPx, x.vol); }

function rpAtr(n = 14) {
  const b = RP.vtf === RP.base ? RP.bars : rpViewBars(), i = RP.vtf === RP.base ? RP.cursor : b.length - 1;
  let s = 0, c = 0;
  for (let k = Math.max(1, i - n + 1); k <= i && b[k]; k++) { s += Math.max(b[k].high - b[k].low, Math.abs(b[k].high - b[k - 1].close), Math.abs(b[k].low - b[k - 1].close)); c++; }
  return c ? s / c : 0;
}

// ขนาด lot: Lot = ตามที่ใส่, Risk% = เสี่ยง % ของทุน (ทุนเริ่ม + กำไรที่ปิดแล้ว) ตามระยะ SL
function rpVolume(side, entry, sl, byRisk = RP.mode === "risk", riskPct = RP.risk, quiet = false) {
  const spec = specs[RP.sym];
  const step = spec?.volume_step || 0.01, vmin = spec?.volume_min || 0.01, vmax = spec?.volume_max || 100;
  let v = RP.lot;
  if (byRisk) {
    const per = sl ? Math.abs(pnlAt(RP.sym, side, entry, sl, 1) || 0) : 0;
    if (!per) { if (!quiet) toast("คิด Risk% ไม่ได้ (ยังไม่มีสเปก symbol / ไม่มี SL) — ใช้ lot ขั้นต่ำ", false); v = vmin; }
    else v = ((RP.balance0 + rpStats().net) * riskPct / 100) / per;
  }
  v = Math.floor(v / step + 1e-9) * step;
  return Number(Math.min(vmax, Math.max(vmin, v)).toFixed(4));
}

function rpMarket(side) {
  if (!RP.panel) return;
  const entry = side === "buy" ? rpAsk() : rpBid();
  const sl = RP.mode === "risk" ? Number((entry - (side === "buy" ? 1 : -1) * rpAtr() * 1.5).toFixed(rpDigits())) : 0;
  const x = { id: ++RP.seq, side, vol: rpVolume(side, entry, sl), open: entry, sl, tp: 0, t0: rpNow().timestamp };
  x.riskAtOpen = sl ? Math.abs(rpPnl(x, sl) || 0) : 0;
  RP.pos.push(x);
  toast(`🧪 ${side.toUpperCase()} ${x.vol} @ ${rpFmt(entry)} (จำลอง)`);
  rpAfterStep();
}

function rpPendingAt(price) {
  const px = Number(Number(price).toFixed(rpDigits()));
  const above = px > rpBid();
  const types = above ? [["sell_limit", "Sell Limit"], ["buy_stop", "Buy Stop"]] : [["buy_limit", "Buy Limit"], ["sell_stop", "Sell Stop"]];
  const anchor = RP.bar || document.body;
  popMenu(anchor, [{ head: `ราคา ${rpFmt(px)} (จำลอง)` }, ...types.map(([t, label]) => ({ label, onClick: () => {
    const side = t.startsWith("buy") ? "buy" : "sell";
    const sl = RP.mode === "risk" ? Number((px - (side === "buy" ? 1 : -1) * rpAtr() * 1.5).toFixed(rpDigits())) : 0;
    // byRisk: pending ที่ตั้งแบบ Risk% คำนวณ lot ใหม่ทุกครั้งที่ย้าย SL / ราคาเข้า (จนกว่าจะ fill)
    RP.ord.push({ id: ++RP.seq, type: t, side, price: px, sl, tp: 0, vol: rpVolume(side, px, sl), byRisk: RP.mode === "risk", riskPct: RP.risk });
    rpAfterStep();
  } }))]);
}

function rpClose(x, px, reason) {
  RP.pos = RP.pos.filter((y) => y !== x);
  const pnl = rpPnl(x, px) || 0;
  RP.closed.push({ side: x.side, vol: x.vol, open: x.open, close: px, t0: x.t0, t1: rpNow().timestamp, pnl, r: x.riskAtOpen ? pnl / x.riskAtOpen : null, reason,
    tags: x.tags || [], note: x.note || "", sym: RP.sym });
}

// แท่งใหม่: pending fill / ชน SL-TP (ราคาแท่ง = Bid, ฝั่ง Ask = +สเปรด)
function rpProcess(b) {
  const sp = RP.spread;
  const filled = [];
  for (const o of RP.ord.slice()) {
    let px = null;
    if (o.type === "buy_limit" && b.low + sp <= o.price) px = Math.min(o.price, b.open + sp);
    else if (o.type === "buy_stop" && b.high + sp >= o.price) px = Math.max(o.price, b.open + sp);
    else if (o.type === "sell_limit" && b.high >= o.price) px = Math.max(o.price, b.open);
    else if (o.type === "sell_stop" && b.low <= o.price) px = Math.min(o.price, b.open);
    if (px == null) continue;
    RP.ord = RP.ord.filter((y) => y !== o);
    const x = { id: o.id, side: o.side, vol: o.vol, open: px, sl: o.sl, tp: o.tp, t0: b.timestamp, tags: o.tags || [], note: o.note || "" };
    x.riskAtOpen = x.sl ? Math.abs(rpPnl(x, x.sl) || 0) : 0;
    RP.pos.push(x);
    filled.push(x);
  }
  for (const x of RP.pos.slice()) {
    if (filled.includes(x)) continue;     // เพิ่ง fill แท่งนี้: เริ่มเช็ค TP/SL แท่งถัดไป
    if (x.side === "buy") {
      const slHit = x.sl && b.low <= x.sl, tpHit = x.tp && b.high >= x.tp;
      if (slHit) rpClose(x, Math.min(x.sl, b.open), "SL");
      else if (tpHit) rpClose(x, Math.max(x.tp, b.open), "TP");
    } else {
      const slHit = x.sl && b.high + sp >= x.sl, tpHit = x.tp && b.low + sp <= x.tp;
      if (slHit) rpClose(x, Math.max(x.sl, b.open + sp), "SL");
      else if (tpHit) rpClose(x, Math.min(x.tp, b.open + sp), "TP");
    }
  }
}

// ---------- เส้นบนกราฟ (ใช้ tradeLine เดียวกับของจริง) ----------
const RP_TYPE = { buy_limit: "BUY LIMIT", sell_limit: "SELL LIMIT", buy_stop: "BUY STOP", sell_stop: "SELL STOP" };
function rpLines() {
  const lines = [];
  const lvl = (x, kind, f, entry) => {
    if (!x[f]) return;
    lines.push({ key: `${kind}${x.id}:${f}`, value: x[f], color: COLORS[f], dashed: true, ref: { kind, id: x.id, field: f },
      chips: [chip("main", `🧪 ${f.toUpperCase()}`, COLORS[f]), chip("pl", plMoney(pnlAt(RP.sym, x.side, entry, x[f], x.vol)), COLORS[f]), chip("x", "✕", "#8a91a0")] });
  };
  for (const x of RP.pos) {
    const cur = x.side === "buy" ? rpBid() : rpAsk();
    const pl = rpPnl(x, cur);
    const chips = [chip("main", `🧪 ${x.side.toUpperCase()} ${x.vol}`, COLORS[x.side], { solid: true }), chip("pl", plMoney(pl), (pl ?? 0) >= 0 ? COLORS.buy : COLORS.sell)];
    if (!x.tp) chips.push(chip("tp", "TP", COLORS.tp, { dashed: true }));
    if (!x.sl) chips.push(chip("sl", "SL", COLORS.sl, { dashed: true }));
    chips.push(chip("tag", x.tags?.length ? `🏷${x.tags.length}` : "🏷", "#8a91a0"));
    chips.push(chip("x", "✕", "#8a91a0"));
    lines.push({ key: `p${x.id}:open`, value: x.open, color: COLORS[x.side], locked: true, ref: { kind: "p", id: x.id, field: "open" }, chips });
    lvl(x, "p", "sl", x.open); lvl(x, "p", "tp", x.open);
  }
  for (const o of RP.ord) {
    const chips = [chip("main", `🧪 ${RP_TYPE[o.type]} ${o.vol}`, COLORS.pend, { solid: true })];
    if (!o.tp) chips.push(chip("tp", "TP", COLORS.tp, { dashed: true }));
    if (!o.sl) chips.push(chip("sl", "SL", COLORS.sl, { dashed: true }));
    chips.push(chip("tag", o.tags?.length ? `🏷${o.tags.length}` : "🏷", "#8a91a0"));
    chips.push(chip("x", "✕", "#8a91a0"));
    lines.push({ key: `o${o.id}:price`, value: o.price, color: COLORS.pend, dashed: true, ref: { kind: "o", id: o.id, field: "price" }, chips });
    lvl(o, "o", "sl", o.price); lvl(o, "o", "tp", o.price);
  }
  return lines;
}

function rpRenderLines() { RP.panel?.setLines("replay", rpLines()); }

function rpFind(ref) { return (ref.kind === "p" ? RP.pos : RP.ord).find((x) => x.id === ref.id); }

// pending แบบ Risk%: lot ตามระยะ SL ล่าสุด (ไม่มี SL = คง lot เดิม)
function rpResize(x) {
  if (x && x.byRisk && x.price != null && x.sl) x.vol = rpVolume(x.side, x.price, x.sl, true, x.riskPct);
}

function replayLineClicked(line, key) {
  const x = rpFind(line.ref);
  if (!x) return;
  const f = line.ref.field;
  if (key === "tag") { rpPlay(false); rpTagEditor(x, "แท็ก / โน้ตไม้นี้ (จำลอง)", () => rpAfterStep()); return; }
  if (key === "x") {
    if (f === "open") rpClose(x, x.side === "buy" ? rpBid() : rpAsk(), "ปิดเอง");
    else if (f === "price") RP.ord = RP.ord.filter((y) => y !== x);
    else x[f] = 0;
  } else if (key === "tp" || key === "sl") {
    const entry = x.open ?? x.price;
    x[key] = Number(levelFor(key, x.side, entry, key === "tp" ? x.sl : x.tp).toFixed(rpDigits()));
    if (key === "sl" && x.open != null && !x.riskAtOpen) x.riskAtOpen = Math.abs(rpPnl(x, x.sl) || 0);
  } else return;
  rpResize(x);
  rpAfterStep();
}

function replayLineDragged(line, value, settle) {
  const x = rpFind(line.ref);
  settle();
  RP.panel?.setZone(null);
  if (!x) return;
  const f = line.ref.field;
  const v = Number(Number(value).toFixed(rpDigits()));
  if (f === "sl" || f === "tp" || f === "price") x[f] = v;
  if (f === "sl" && x.open != null && !x.riskAtOpen) x.riskAtOpen = Math.abs(rpPnl(x, v) || 0);
  rpResize(x);
  rpAfterStep();
}

function replayLinePulled(line, key, value) {
  const x = rpFind(line.ref);
  if (!x || (key !== "tp" && key !== "sl")) return;
  x[key] = Number(Number(value).toFixed(rpDigits()));
  rpResize(x);
  rpRenderLines();
}

// ระหว่างลาก: กำไร/ขาดทุนบนชิป + โซน R:R ตามเส้น
function replayLineMoving(line, value) {
  const x = rpFind(line.ref);
  const f = line.ref.field;
  if (!x || (f !== "sl" && f !== "tp")) return null;
  const entry = x.open ?? x.price;
  const z = { sl: x.sl, tp: x.tp, [f]: value };
  const risk = z.sl ? Math.abs(entry - z.sl) : 0, reward = z.tp ? Math.abs(z.tp - entry) : 0;
  RP.panel.setZone({ entry, sl: z.sl || 0, tp: z.tp || 0,
    top: z.tp ? `${risk ? `R:R 1:${(reward / risk).toFixed(2)} · ` : ""}${plMoney(pnlAt(RP.sym, x.side, entry, z.tp, x.vol))}` : "",
    bottom: z.sl ? `เสี่ยง ${plMoney(pnlAt(RP.sym, x.side, entry, z.sl, x.vol))}` : "" });
  let vol = x.vol;
  if (f === "sl" && x.byRisk && x.price != null) vol = rpVolume(x.side, x.price, value, true, x.riskPct, true);   // lot ใหม่ตามระยะ SL สดๆ
  const pl = pnlAt(RP.sym, x.side, entry, value, vol);
  return (line.chips || []).map((c) => (c.key === "pl" ? { ...c, text: `${plMoney(pl)}${vol !== x.vol ? ` · ${vol} lot` : ""}` } : c));
}

// ---------- แท็ก / โน้ตต่อไม้ (แท็กชุดเดียวกับ Journal ใน ตั้งค่า) ----------
function rpTagEditor(t, title, onDone) {
  openDialog(`🏷 ${title}`, (form, close) => {
    const on = new Set(t.tags || []);
    const all = [...new Set([...(setting("tags") || []), ...on])];
    const chips = mkx("div", { className: "tag-chips" });
    const paint = () => chips.replaceChildren(...all.map((tag) => {
      const b = mkx("button", { type: "button", className: `tag-chip${on.has(tag) ? " on" : ""}`, textContent: tag });
      b.onclick = () => { on.has(tag) ? on.delete(tag) : on.add(tag); paint(); };
      return b;
    }));
    paint();
    const note = mkx("textarea", { rows: 3, maxLength: 1000, placeholder: "โน้ต: เหตุผลที่เข้า / สิ่งที่เรียนรู้", value: t.note || "" });
    form.append(chips, note);
    const ok = mkx("button", { type: "button", className: "btn-primary", textContent: "บันทึก" });
    const cancel = mkx("button", { type: "button", className: "btn-ghost", textContent: "ยกเลิก" });
    cancel.onclick = close;
    ok.onclick = () => { t.tags = all.filter((x) => on.has(x)); t.note = note.value.trim(); close(); onDone?.(); };
    form.append(mkx("div", { className: "modal-btns" }, cancel, ok));
  }, { wide: false });
}

// สรุปรวมทุกรอบที่บันทึก: กรอง symbol / แท็ก, R สะสม, แยกตามแท็ก / symbol
function rpOverview(list) {
  const all = [];
  for (const s0 of list) for (const t of s0.trades || []) all.push({ ...t, sym: t.sym || s0.sym, cur: s0.currency, blind: !!s0.blind });
  all.sort((a, b) => (a.t1 || 0) - (b.t1 || 0));
  const syms = [...new Set(all.map((t) => t.sym))].sort();
  const tags = [...new Set(all.flatMap((t) => t.tags || []))].sort();
  openDialog("📈 สรุปรวม Replay ทุกรอบ", (form, close) => {
    const fSym = mkx("select", {}, mkx("option", { value: "", textContent: "ทุก symbol" }), ...syms.map((x) => mkx("option", { value: x, textContent: x })));
    const fTag = mkx("select", {}, mkx("option", { value: "", textContent: "ทุกแท็ก" }), mkx("option", { value: "-", textContent: "(ไม่มีแท็ก)" }), ...tags.map((x) => mkx("option", { value: x, textContent: x })));
    const body = mkx("div");
    form.append(mkx("div", { className: "row rp-rnd" }, fSym, fTag), body);
    const agg = (ts) => {
      const n = ts.length, w = ts.filter((t) => t.pnl > 0).length, rs = ts.filter((t) => t.r != null).map((t) => t.r);
      const gw = ts.filter((t) => t.pnl > 0).reduce((a, t) => a + t.pnl, 0), gl = -ts.filter((t) => t.pnl < 0).reduce((a, t) => a + t.pnl, 0);
      return { n, win: n ? (w / n) * 100 : 0, avgR: rs.length ? rs.reduce((a, r) => a + r, 0) / rs.length : null, sumR: rs.reduce((a, r) => a + r, 0),
        net: ts.reduce((a, t) => a + t.pnl, 0), pf: gl ? gw / gl : null };
    };
    const fmtR = (r) => (r == null ? "–" : `${r >= 0 ? "+" : ""}${r.toFixed(2)}R`);
    const table = (title, groups) => {
      const t = mkx("table", { className: "tbl deep-tbl" });
      t.append(mkx("thead", {}, mkx("tr", {}, ...[title, "ไม้", "Win", "R เฉลี่ย", "R รวม", "PF"].map((h) => mkx("th", { textContent: h })))));
      const tb = mkx("tbody");
      for (const [k, ts] of groups.sort((a, b) => agg(b[1]).sumR - agg(a[1]).sumR)) {
        const a = agg(ts);
        tb.append(mkx("tr", {}, mkx("td", { textContent: k }), mkx("td", { className: "r", textContent: String(a.n) }),
          mkx("td", { className: "r", textContent: `${a.win.toFixed(0)}%` }), mkx("td", { className: `r ${a.avgR >= 0 ? "up" : "down"}`, textContent: fmtR(a.avgR) }),
          mkx("td", { className: `r ${a.sumR >= 0 ? "up" : "down"}`, textContent: fmtR(a.sumR) }), mkx("td", { className: "r", textContent: a.pf == null ? (a.n ? "∞" : "–") : a.pf.toFixed(2) })));
      }
      t.append(tb);
      return mkx("div", { className: "scroll rp-scroll" }, t);
    };
    const group = (ts, keyFn) => { const m = new Map(); for (const t of ts) for (const k of keyFn(t)) { if (!m.has(k)) m.set(k, []); m.get(k).push(t); } return [...m]; };
    const paint = () => {
      const ts = all.filter((t) => (!fSym.value || t.sym === fSym.value)
        && (!fTag.value || (fTag.value === "-" ? !(t.tags || []).length : (t.tags || []).includes(fTag.value))));
      const a = agg(ts);
      const kpi = mkx("div", { className: "deep-kpi" });
      for (const [k, v, c] of [["ไม้", `${a.n} (จาก ${list.length} รอบ)`, ""], ["Win rate", `${a.win.toFixed(0)}%`, ""], ["R เฉลี่ย", fmtR(a.avgR), a.avgR >= 0 ? "up" : "down"],
        ["R รวม", fmtR(a.sumR), a.sumR >= 0 ? "up" : "down"], ["Profit factor", a.pf == null ? (a.n ? "∞" : "–") : a.pf.toFixed(2), ""],
        ["สุทธิ (เงิน)", fSym.value ? plMoney(a.net) : "เลือก symbol", signCls(a.net)]]) {
        kpi.append(mkx("div", {}, mkx("span", { className: "muted", textContent: k }), mkx("b", { className: c, textContent: v })));
      }
      // R สะสมตามลำดับเวลาออก (ใช้ R เพราะแต่ละรอบทุนต่างกัน)
      const cv = mkx("canvas", { className: "rp-curve" });
      const rs = ts.filter((t) => t.r != null);
      body.replaceChildren(kpi, mkx("div", { className: "muted small", textContent: `R สะสม (${rs.length} ไม้ที่มี SL)` }), cv,
        table("แท็ก", group(ts, (t) => ((t.tags || []).length ? t.tags : ["(ไม่มีแท็ก)"]))), table("Symbol", group(ts, (t) => [t.sym])));
      requestAnimationFrame(() => {
        const dpr = window.devicePixelRatio || 1, W = cv.clientWidth || 300, H = 110;
        cv.width = W * dpr; cv.height = H * dpr;
        const g = cv.getContext("2d");
        g.scale(dpr, dpr);
        let c = 0;
        const pts = [0, ...rs.map((t) => (c += t.r))];
        const lo = Math.min(0, ...pts), hi = Math.max(0, ...pts), sy = (v) => H - 6 - ((v - lo) / (hi - lo || 1)) * (H - 12);
        g.strokeStyle = "rgba(138,145,160,.5)"; g.setLineDash([3, 3]);
        g.beginPath(); g.moveTo(0, sy(0)); g.lineTo(W, sy(0)); g.stroke(); g.setLineDash([]);
        g.strokeStyle = c >= 0 ? "#26a69a" : "#ef5350"; g.lineWidth = 2;
        g.beginPath();
        pts.forEach((v, i) => { const x = (i / Math.max(1, pts.length - 1)) * W; i ? g.lineTo(x, sy(v)) : g.moveTo(x, sy(v)); });
        g.stroke();
      });
    };
    fSym.onchange = fTag.onchange = paint;
    paint();
    const x = mkx("button", { type: "button", className: "btn-primary", textContent: "ปิด" });
    const back = mkx("button", { type: "button", className: "btn-ghost", textContent: "กลับ" });
    x.onclick = close; back.onclick = () => rpHistory();
    form.append(mkx("div", { className: "modal-btns" }, back, x));
  });
}

// ---------- สรุปผล ----------
function rpStats(trades = RP.closed || [], balance0 = RP.balance0 || 0) {
  const n = trades.length, wins = trades.filter((t) => t.pnl > 0).length;
  const net = trades.reduce((a, t) => a + t.pnl, 0);
  const rs = trades.filter((t) => t.r != null).map((t) => t.r);
  let eq = balance0, peak = balance0, dd = 0;
  for (const t of trades) { eq += t.pnl; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq); }
  const gw = trades.filter((t) => t.pnl > 0).reduce((a, t) => a + t.pnl, 0), gl = -trades.filter((t) => t.pnl < 0).reduce((a, t) => a + t.pnl, 0);
  return { n, wins, losses: trades.filter((t) => t.pnl < 0).length, net, winRate: n ? (wins / n) * 100 : 0,
    avgR: rs.length ? rs.reduce((a, r) => a + r, 0) / rs.length : null, maxDD: dd, ddPct: balance0 ? (dd / balance0) * 100 : 0,
    pf: gl ? gw / gl : null, best: n ? Math.max(...trades.map((t) => t.pnl)) : 0, worst: n ? Math.min(...trades.map((t) => t.pnl)) : 0 };
}

function rpSummary(snap, askSave) {
  const s0 = snap || rpRecord();
  const s = rpStats(s0.trades, s0.balance0);
  const hide = s0.blind && RP.panel && s0.sid === RP.sid;   // ยังเล่นแบบซ่อนวันที่อยู่: สรุประหว่างทางไม่บอกวันที่
  const dt = (ms) => (hide ? "🙈" : ms ? new Date(ms).toLocaleString("th-TH", { dateStyle: "short", timeStyle: "short" }) : "–");
  openDialog(`📊 Replay ${s0.sym} ${s0.vtf && s0.vtf !== s0.tf ? `${s0.vtf} (ฐาน ${s0.tf})` : s0.tf}`, (form, close) => {
    form.append(mkx("p", { className: "modal-line muted small", textContent: `${dt(s0.from)} → ${dt(s0.to)} · ทุน ${money(s0.balance0, s0.currency)}` }));
    const kpi = mkx("div", { className: "deep-kpi" });
    for (const [k, v, c] of [["สุทธิ", plMoney(s.net), signCls(s.net)], ["ไม้", `${s.n} (ได้ ${s.wins} / เสีย ${s.losses})`, ""],
      ["Win rate", `${s.winRate.toFixed(0)}%`, ""], ["R เฉลี่ย", s.avgR == null ? "–" : `${s.avgR >= 0 ? "+" : ""}${s.avgR.toFixed(2)}R`, s.avgR >= 0 ? "up" : "down"],
      ["Profit factor", s.pf == null ? (s.n ? "∞" : "–") : s.pf.toFixed(2), ""], ["DD สูงสุด", `${money(-s.maxDD, s0.currency)} (${s.ddPct.toFixed(1)}%)`, "down"]]) {
      kpi.append(mkx("div", {}, mkx("span", { className: "muted", textContent: k }), mkx("b", { className: c, textContent: v })));
    }
    form.append(kpi);
    if (s0.trades.length) {
      const t = mkx("table", { className: "tbl deep-tbl rp-trades" });
      t.append(mkx("thead", {}, mkx("tr", {}, ...["เข้า", "ฝั่ง", "Lot", "เข้า→ออก", "ผล", "R", "", "🏷 (แตะเพื่อแก้)"].map((h) => mkx("th", { textContent: h })))));
      const body = mkx("tbody");
      for (const x of s0.trades.slice().reverse()) {
        body.append(mkx("tr", {}, mkx("td", { textContent: dt(x.t0) }), mkx("td", { className: x.side === "buy" ? "up" : "down", textContent: x.side.toUpperCase() }),
          mkx("td", { className: "r", textContent: String(x.vol) }), mkx("td", { textContent: `${Number(x.open).toFixed(state.digits[s0.sym] ?? 5)} → ${Number(x.close).toFixed(state.digits[s0.sym] ?? 5)}` }),
          mkx("td", { className: "r " + signCls(x.pnl), textContent: plMoney(x.pnl) }), mkx("td", { className: "r", textContent: x.r == null ? "–" : x.r.toFixed(2) }),
          mkx("td", { className: "muted", textContent: x.reason }),
          mkx("td", { className: "rp-tags", textContent: `${(x.tags || []).join(", ")}${x.note ? " 📝" : ""}` || "🏷" })));
        const row = body.lastChild;
        row.classList.add("clickable");
        row.onclick = () => rpTagEditor(x, `แท็ก / โน้ต ${x.side.toUpperCase()} ${dt(x.t0)}`, () => {
          // รอบที่บันทึกแล้ว (หรือรอบที่เล่นอยู่ที่บันทึกไว้) -> ส่งขึ้น server ด้วย
          const saved = (localGet(RP_KEY) || []).some((y) => y.sid === s0.sid);
          if (saved && !(RP.panel && s0.sid === RP.sid)) rpSave(s0);
          else if (saved) rpSave();
          rpSummary(s0, askSave);
        });
      }
      t.append(body);
      form.append(mkx("div", { className: "scroll rp-scroll" }, t));
    }
    const btns = [];
    if (askSave) {
      const sv = mkx("button", { type: "button", className: "btn-primary", textContent: "💾 บันทึกผลรอบนี้" });
      sv.onclick = () => { rpSave(s0); close(); };
      btns.push(sv);
    }
    const x = mkx("button", { type: "button", className: askSave ? "btn-ghost" : "btn-primary", textContent: askSave ? "ไม่บันทึก" : "ปิด" });
    x.onclick = close;
    form.append(mkx("div", { className: "modal-btns" }, x, ...btns));
  });
}

async function rpHistory() {
  const list = await rpSessions();
  openDialog("📊 ผลรอบ replay ที่บันทึกไว้", (form, close) => {
    if (!list.length) form.append(mkx("p", { className: "muted", textContent: "ยังไม่มี — กด 💾 ระหว่าง replay หรือบันทึกตอนจบ" }));
    list.forEach((s0, i) => {
      const s = rpStats(s0.trades, s0.balance0);
      const row = mkx("button", { type: "button", className: "ip-main rp-hist" },
        mkx("span", { className: "ip-text" }, mkx("b", { textContent: `${s0.sym} ${s0.vtf || s0.tf} · ${s0.blind ? "🙈 ซ่อนวันที่" : new Date(s0.from).toLocaleDateString("th-TH")}` }),
          mkx("small", { className: "muted", textContent: `${s.n} ไม้ · win ${s.winRate.toFixed(0)}% · ${s.avgR == null ? "" : s.avgR.toFixed(2) + "R · "}${plMoney(s.net)}` })));
      row.onclick = () => rpSummary(s0, false);
      const del = mkx("button", { type: "button", className: "btn-ghost ind-gear", textContent: "🗑", title: "ลบ" });
      del.onclick = async () => {
        if (!confirm("ลบผลรอบนี้?")) return;
        await api(`/api/replay/${s0.sid}`, { method: "DELETE" }).catch(() => {});
        list.splice(i, 1); localSet(RP_KEY, list.slice(0, 30)); rpHistory();
      };
      const kids = [row];
      if (s0.state?.cursorTs) {
        const go = mkx("button", { type: "button", className: "btn-ghost ind-gear", textContent: "▶", title: s0.blind ? "เล่นต่อ" : `เล่นต่อจาก ${new Date(s0.state.cursorTs).toLocaleString("th-TH", { dateStyle: "short", timeStyle: "short" })}` });
        go.onclick = () => { close(); replayResume(s0); };
        kids.push(go);
      }
      form.append(mkx("div", { className: "ip-row" }, ...kids, del));
    });
    const x = mkx("button", { type: "button", className: "btn-primary", textContent: "ปิด" });
    x.onclick = close;
    const ov = mkx("button", { type: "button", className: "btn-ghost", textContent: "📈 สรุปรวมทุกรอบ" });
    ov.onclick = () => rpOverview(list);
    ov.disabled = !list.some((s0) => (s0.trades || []).length);
    form.append(mkx("div", { className: "modal-btns" }, ov, x));
  });
}

// คีย์ลัดตอน replay: Space เล่น/หยุด, → ทีละแท่ง, B/S ออเดอร์จำลอง (แทนคำสั่งจริง)
document.addEventListener("keydown", (e) => {
  if (!RP.panel || e.ctrlKey || e.metaKey) return;
  if (/INPUT|SELECT|TEXTAREA/.test(document.activeElement?.tagName) || document.getElementById("modal")?.open) return;
  if (e.key === " ") { e.preventDefault(); e.stopImmediatePropagation(); rpPlay(!RP.playing); }
  else if (e.key === "ArrowRight") { e.preventDefault(); e.stopImmediatePropagation(); rpPlay(false); rpStep(); }
  else if (e.key === "ArrowLeft") { e.preventDefault(); e.stopImmediatePropagation(); rpBack(); }
  else if (e.key === "b" || e.key === "B") { e.preventDefault(); e.stopImmediatePropagation(); rpMarket("buy"); }
  else if (e.key === "s" || e.key === "S") { e.preventDefault(); e.stopImmediatePropagation(); rpMarket("sell"); }
}, true);
