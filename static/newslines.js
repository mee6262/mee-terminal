// Mee Terminal — ข่าวเศรษฐกิจบนกราฟ (เส้นแนวตั้งตรงเวลาข่าว) + เตือนก่อนส่งคำสั่งเมื่อใกล้ข่าวของ symbol นั้น
// ระดับผลกระทบ/เปิดปิด ตั้งในหน้าตั้งค่า (wt.settings: chart.news, cal.*, news.warnTrade/warnMin)
"use strict";

const NEWS_COLORS = { High: "#f23645", Medium: "#ff9800", Low: "#e2b93b" };
const NEWS_ICONS = { High: "🔴", Medium: "🟠", Low: "🟡" };

// สกุลที่เกี่ยวกับ symbol: คู่เงิน = 2 สกุล, ทอง/คริปโต/ดัชนี US = USD
function relevantCurrencies(sym) {
  const out = new Set(symbolCurrencies(sym));
  if (/XAU|XAG|BTC|ETH|US30|NAS|US500|USTEC|USOIL/i.test(sym || "")) out.add("USD");
  return out;
}

function newsForSymbol(sym) {
  const cal = setting("cal") || {};
  const cur = relevantCurrencies(sym);
  return (newsState.data?.events || []).filter((e) => e.ts && cal[e.impact] && cur.has(e.currency));
}

// เวลา (วินาที) -> ตำแหน่ง index ของแท่ง (ทศนิยมได้, เลยแท่งล่าสุดไปอนาคตได้)
function tsToIndex(bars, ms, periodMs) {
  const n = bars.length;
  if (!n || ms < bars[0].timestamp) return null;
  const last = bars[n - 1].timestamp;
  if (ms >= last) return n - 1 + (ms - last) / periodMs;
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (bars[mid].timestamp <= ms) lo = mid; else hi = mid; }
  return lo + Math.min(1, (ms - bars[lo].timestamp) / periodMs);
}

const PERIOD_MS = { second: 1e3, minute: 6e4, hour: 36e5, day: 864e5, week: 6048e5, month: 2592e6, year: 31536e6 };

klinecharts.registerIndicator({
  name: "wtnews",
  shortName: "News",
  series: "price",
  figures: [],
  calc: (dataList) => dataList.map(() => ({})),
  draw: ({ ctx, chart, bounding, xAxis }) => {
    const sym = chart.getSymbol()?.ticker;
    const events = sym ? newsForSymbol(sym) : [];
    if (!events.length) return true;
    const bars = chart.getDataList();
    const per = chart.getPeriod();
    const periodMs = (PERIOD_MS[per?.type] || 6e4) * (per?.span || 1);
    const light = typeof themeIsLight === "function" && themeIsLight();
    ctx.save();
    ctx.font = "10px -apple-system, 'Segoe UI', sans-serif";
    ctx.textBaseline = "middle";
    const seen = new Map();   // ข่าวเวลาเดียวกันรวมเป็นเส้นเดียว
    for (const e of events) {
      const k = e.ts;
      if (!seen.has(k)) seen.set(k, []);
      seen.get(k).push(e);
    }
    for (const [ts, list] of seen) {
      const idx = tsToIndex(bars, ts * 1000, periodMs);
      if (idx == null) continue;
      const x = Math.round(xAxis.convertToPixel(idx)) + 0.5;
      if (x < 0 || x > bounding.width) continue;
      const top = list.find((e) => e.impact === "High") || list.find((e) => e.impact === "Medium") || list[0];
      const col = NEWS_COLORS[top.impact] || "#8a91a0";
      ctx.strokeStyle = col;
      ctx.globalAlpha = ts * 1000 > Date.now() ? 0.85 : 0.45;
      ctx.setLineDash([4, 4]);
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, bounding.height); ctx.stroke();
      ctx.setLineDash([]);
      // ป้ายแนวตั้งเลียบเส้น (แบบ event ของ TradingView)
      const label = `${top.time_th} ${[...new Set(list.map((e) => e.currency))].join("/")} ${top.title}${list.length > 1 ? ` +${list.length - 1}` : ""}`;
      const text = label.length > 42 ? label.slice(0, 41) + "…" : label;
      ctx.save();
      ctx.translate(x - 7, 8);
      ctx.rotate(Math.PI / 2);
      const w = ctx.measureText(text).width + 8;
      ctx.globalAlpha = 0.9;
      ctx.fillStyle = light ? "rgba(255,255,255,0.85)" : "rgba(15,17,21,0.75)";
      ctx.fillRect(0, -7, w, 13);
      ctx.fillStyle = col;
      ctx.fillText(text, 4, 0);
      ctx.restore();
    }
    ctx.restore();
    return true;
  },
});

function applyNewsLines(panel) {
  const c = panel.chart;
  if (!c) return;
  c.removeIndicator({ name: "wtnews" });
  if (panel.replay?.blind) return;   // replay แบบซ่อนวันที่: เส้นข่าวบอกวันเวลาได้
  if (setting("chart.news") !== false && newsState.data) c.createIndicator({ name: "wtnews", paneId: "candle_pane" }, true);
}

function refreshNewsLines() {
  state.charts?.panels.forEach((p) => applyNewsLines(p));
}

// ก่อนส่งคำสั่งเปิดไม้: มีข่าวของ symbol นี้ภายใน ±N นาที -> ถามก่อน (คืน true = ส่งต่อ)
async function newsNearTrade(sym) {
  if (!setting("news.warnTrade") || !sym) return true;
  const win = (Number(setting("news.warnMin")) || 15) * 60;
  const now = Date.now() / 1000;
  const near = newsForSymbol(sym).filter((e) => e.ts - now <= win && now - e.ts <= 300);
  if (!near.length) return true;
  const lines = near.slice(0, 5).map((e) => `${NEWS_ICONS[e.impact] || "•"} ${e.time_th} ${e.currency} ${e.title} · ${e.ts > now ? `อีก ${fmtLeft(e.ts - now)}` : "เพิ่งออก"}`);
  lines.push("ช่วงข่าวสเปรดกว้าง ราคากระชาก SL อาจ slip");
  return !!(await modal({ title: `⚠️ ใกล้ข่าว ${sym}`, lines, ok: "ส่งต่อ", danger: true }));
}
