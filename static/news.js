// Mee Terminal — ปฏิทินข่าวเศรษฐกิจ (ยกแบบจากหน้า News ของ dashboard เดิม): นับถอยหลังข่าวแดง, กรอง, แยกวัน, วิเคราะห์ผลต่อค่าเงิน
"use strict";

const newsState = { data: null, loading: false };
const NEWS_ALERT_SEC = 1800;
const NON_FIAT = new Set(["XAU", "XAG", "BTC", "ETH", "US3", "NAS", "US1", "UST", "USO"]);

function symbolCurrencies(sym) {
  const s = (sym || "").toUpperCase().replace(/[^A-Z]/g, "").replace(/(M|C)$/, "");
  if (s.length < 6) return [];
  return [s.slice(0, 3), s.slice(3, 6)].filter((x) => !NON_FIAT.has(x));
}

function heldCurrencies() {
  const set = new Set();
  for (const x of [...(state.positions || []), ...(state.orders || [])]) symbolCurrencies(x.symbol).forEach((c) => set.add(c));
  // ทอง/คริปโต ผูก USD
  if ([...(state.positions || []), ...(state.orders || [])].some((x) => /XAU|XAG|BTC|ETH/.test(x.symbol))) set.add("USD");
  return set;
}

async function loadNews(force = false) {
  if (newsState.loading) return;
  newsState.loading = true;
  const upd = document.getElementById("news-updated");
  try {
    const r = await api(`/api/news${force ? "?force=1" : ""}`);
    const j = await r.json();
    if (!r.ok) { upd.textContent = j.detail || "โหลดข่าวไม่ได้"; return; }
    newsState.data = j;
    upd.textContent = `อัปเดต ${(j.fetched_at || "").replace("T", " ").slice(5, 16)}${j.stale ? " · ⚠️ ใช้ข้อมูลเก่า (ดึงใหม่ไม่ได้)" : ""}`;
    fillNewsCurrencies();
    renderNews();
    renderNewsAlert();
    if (typeof refreshNewsLines === "function") refreshNewsLines();
  } catch (_) {
    upd.textContent = "เชื่อมต่อไม่ได้";
  } finally {
    newsState.loading = false;
  }
}

function fillNewsCurrencies() {
  const sel = document.getElementById("news-cur");
  const cur = store("wt.news.cur", "ALL");
  const codes = [...new Set(newsState.data.events.map((e) => e.currency).filter(Boolean))].sort();
  sel.replaceChildren(new Option("ทุกสกุล", "ALL"), ...codes.map((c) => new Option(c, c)));
  sel.value = codes.includes(cur) ? cur : "ALL";
}

function fmtCountdown(sec) {
  if (sec < 0) return "ผ่านไปแล้ว";
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
  if (h >= 24) return `อีก ${Math.floor(h / 24)} วัน ${h % 24} ชม.`;
  if (h > 0) return `อีก ${h} ชม. ${m} นาที`;
  if (m > 0) return `อีก ${m} นาที`;
  return "กำลังจะประกาศ";
}

function nextHigh(mine, myOnly) {
  const now = Date.now() / 1000;
  return (newsState.data?.events || []).filter((e) => e.impact === "High" && e.ts && e.ts > now && (!myOnly || mine.has(e.currency)))
    .sort((a, b) => a.ts - b.ts)[0] || null;
}

function boldText(parent, s) {
  // **คำ** -> ตัวหนา (ไม่ใช้ innerHTML)
  String(s || "").split(/(\*\*.+?\*\*)/).forEach((part) => {
    if (/^\*\*.+\*\*$/.test(part)) parent.append(el("b", part.slice(2, -2)));
    else if (part) parent.append(document.createTextNode(part));
  });
}

// เปิดหน้าข่าว: เลื่อนไปข่าวถัดไปที่ยังไม่ประกาศ (ข้ามของสัปดาห์ที่ผ่านมา)
function scrollNewsToNow() {
  const first = document.querySelector("#news-list .news-item:not(.past)");
  if (first) first.closest(".news-day")?.scrollIntoView({ block: "start" });
}

function renderNews() {
  if (!newsState.data) return;
  const mine = heldCurrencies();
  // ข่าวแดงตัวถัดไป
  const nx = nextHigh(mine, false);
  const nb = document.getElementById("news-next");
  nb.hidden = !nx;
  if (nx) {
    const left = nx.ts - Date.now() / 1000;
    nb.className = "news-next" + (left < NEWS_ALERT_SEC ? " hot" : "");
    nb.replaceChildren(el("span", "📢 ข่าวแดงตัวถัดไป", "muted"), el("b", nx.currency, mine.has(nx.currency) ? "mine" : ""),
      el("span", nx.title), el("span", `${nx.day_label} ${nx.time_th}`, "muted"), el("b", fmtCountdown(left), "cd"));
    if (mine.has(nx.currency)) nb.append(el("div", "⚠️ มีไม้ของสกุลนี้อยู่ตอนนี้", "mine-note"));
  }

  const impact = document.getElementById("news-impact").value;
  const cur = document.getElementById("news-cur").value;
  const todayOnly = document.getElementById("news-today").checked;
  const mineOnly = document.getElementById("news-mine").checked;
  const rank = { High: 3, Medium: 2, Low: 1, Holiday: 0 };
  const min = impact === "high" ? 3 : impact === "medium" ? 2 : 0;
  const todayKey = new Date().toLocaleDateString("sv-SE");
  const events = newsState.data.events.filter((e) => (cur === "ALL" || e.currency === cur) && (!todayOnly || e.day_key === todayKey)
    && (!mineOnly || mine.has(e.currency)) && (rank[e.impact] ?? 0) >= min);
  const list = document.getElementById("news-list");
  list.replaceChildren();
  if (!events.length) { list.append(el("div", "ไม่มีข่าวตรงกับตัวกรองนี้", "empty card-empty")); return; }
  const now = Date.now() / 1000;
  let day = null, box = null;
  for (const e of events) {
    if (e.day_key !== day) {
      day = e.day_key;
      const g = el("div", undefined, "news-day" + (e.day_key === todayKey ? " today" : ""));
      g.append(el("div", e.day_label + (e.day_key === todayKey ? " · วันนี้" : ""), "news-day-h"));
      box = el("div", undefined, "news-items");
      g.append(box);
      list.append(g);
    }
    const past = e.ts && e.ts < now;
    const it = el("div", undefined, "news-item" + (past ? " past" : "") + (e.soon ? " soon" : "") + (mine.has(e.currency) ? " mine" : ""));
    const top = el("div", undefined, "news-top");
    top.append(el("span", e.time_th || "–", "news-time"), el("b", e.currency, "news-cur"),
      el("span", e.impact, `news-imp ${e.impact.toLowerCase()}`), el("span", e.title, "news-title"));
    const nums = el("div", undefined, "news-nums");
    for (const [k, v] of [["จริง", e.actual], ["คาด", e.forecast], ["ก่อน", e.previous]]) {
      const c = el("span"); c.append(el("span", k + " ", "muted"), el("b", v || "–")); nums.append(c);
    }
    it.append(top, nums);
    if (e.assessment) {
      const a = el("div", undefined, `news-assess ${e.assessment.tone}`);
      a.append(el("span", `${e.assessment.category} · `, "muted"));
      boldText(a, e.assessment.text);
      it.append(a);
    }
    if (e.source_url) {
      const l = el("a", e.source || "ที่มา", "news-src");
      l.href = e.source_url; l.target = "_blank"; l.rel = "noopener noreferrer";
      it.append(l);
    }
    box.append(it);
  }
}

// แถบเตือนบนหน้ากราฟ: ข่าวแดงของสกุลที่มีไม้อยู่ เหลือ < 30 นาที
function renderNewsAlert() {
  const bar = document.getElementById("news-alert");
  const mine = heldCurrencies();
  const ev = mine.size ? nextHigh(mine, true) : null;
  const left = ev ? ev.ts - Date.now() / 1000 : Infinity;
  bar.hidden = !ev || left > NEWS_ALERT_SEC;
  if (bar.hidden) return;
  bar.replaceChildren(el("b", "⚠️ ข่าวแรงใกล้ถึง"), el("b", ev.currency), el("span", ev.title), el("span", ev.time_th, "muted"),
    el("b", fmtCountdown(left), "cd"), el("span", "มีไม้ของสกุลนี้อยู่ — ระวังสเปรดกว้าง/ราคากระชาก", "muted small"));
}

// แถบเตือน/แบนเนอร์บนสุดกินความสูง → ส่ง --topx ให้ CSS หักออกจากกราฟมือถือ (ไม่ให้หน้าเลื่อน)
function watchTopBars() {
  const bars = ["banner", "news-alert"].map((id) => document.getElementById(id)).filter(Boolean);
  const upd = () => document.body.style.setProperty("--topx", `${bars.reduce((s, b) => s + (b.hidden ? 0 : b.offsetHeight), 0)}px`);
  if (window.ResizeObserver) { const ro = new ResizeObserver(upd); bars.forEach((b) => ro.observe(b)); }
  upd();
}

function initNews() {
  watchTopBars();
  const $n = (id) => document.getElementById(id);
  const f = store("wt.news.f", { impact: "medium", today: false, mine: false });
  $n("news-impact").value = f.impact;
  $n("news-today").checked = !!f.today;
  $n("news-mine").checked = !!f.mine;
  const saveF = () => save("wt.news.f", { impact: $n("news-impact").value, today: $n("news-today").checked, mine: $n("news-mine").checked });
  for (const id of ["news-impact", "news-today", "news-mine"]) $n(id).addEventListener("change", () => { saveF(); renderNews(); });
  $n("news-cur").addEventListener("change", () => { save("wt.news.cur", $n("news-cur").value); renderNews(); });
  $n("news-refresh").addEventListener("click", () => loadNews(true));
  $n("nav-news").addEventListener("click", () => showView(document.body.classList.contains("view-news") ? "chart" : "news"));
  loadNews();
  setInterval(() => { renderNewsAlert(); if (document.body.classList.contains("view-news") || document.body.dataset.tab === "news") renderNews(); }, 30000);
  setInterval(() => loadNews(), 30 * 60 * 1000);
}
