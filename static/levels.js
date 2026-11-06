// Mee Terminal — เส้น High/Low ของวันก่อน (PDH/PDL) และสัปดาห์ก่อน (PWH/PWL)
// ใช้แท่ง D1 / W1 ของโบรกตรงๆ (ตัดวันตามเวลา server เหมือน MT5) — เปิด/ปิดที่ ตั้งค่า > แสดงบนกราฟ
// Bar Replay: ใช้แท่ง D1/W1 ของวัน/สัปดาห์ก่อนเวลาที่เล่นถึงเท่านั้น (ไม่เห็นอนาคต)
"use strict";

const LEVELS_STYLE = {
  pdh: { label: "PDH", color: "#f0b90b" }, pdl: { label: "PDL", color: "#f0b90b" },
  pwh: { label: "PWH", color: "#a78bfa" }, pwl: { label: "PWL", color: "#a78bfa" },
};
const LEVELS_REFRESH_MS = 5 * 60e3;
let levelsVer = 0;

const levelsOn = () => ({ d: setting("chart.pdhl") === true, w: setting("chart.pwhl") === true });

klinecharts.registerIndicator({
  name: "wtlevels",
  shortName: "PDH/PWH",
  series: "price",
  figures: [],
  calc: (dataList) => dataList.map(() => ({})),
  draw: ({ ctx, chart, bounding, yAxis }) => {
    const p = state.charts?.panels.find((x) => x.chart === chart);
    const lv = p?.levels;
    if (!lv) return true;
    const digits = chart.getSymbol()?.pricePrecision ?? 2;
    ctx.save();
    ctx.font = "10px -apple-system, 'Segoe UI', sans-serif";
    ctx.textBaseline = "middle";
    const drawn = [];
    for (const k of ["pdh", "pdl", "pwh", "pwl"]) {
      const v = lv[k];
      if (v == null) continue;
      const y = Math.round(yAxis.convertToPixel(v)) + 0.5;
      if (y < 0 || y > bounding.height) continue;
      const st = LEVELS_STYLE[k];
      ctx.strokeStyle = st.color;
      ctx.globalAlpha = 0.75;
      ctx.setLineDash([6, 4]);
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(bounding.width, y); ctx.stroke();
      ctx.setLineDash([]);
      // ป้ายชิดขวา (ซ้ายของแกนราคา) — ระดับชนกันเลื่อนป้ายลง
      let ty = y;
      while (drawn.some((d) => Math.abs(d - ty) < 12)) ty += 12;
      drawn.push(ty);
      const text = `${st.label} ${Number(v).toFixed(digits)}`;
      const w = ctx.measureText(text).width + 8;
      ctx.globalAlpha = 0.9;
      ctx.fillStyle = st.color;
      ctx.fillRect(bounding.width - w - 4, ty - 7, w, 14);
      ctx.fillStyle = "#111";
      ctx.fillText(text, bounding.width - w, ty);
    }
    ctx.restore();
    return true;
  },
});

// ---- หาแท่งวัน/สัปดาห์ก่อนหน้า (เวลา server ของโบรก) ----
// โบรกมีแท่ง D1 วันอาทิตย์สั้นๆ (XAU/FX เปิด ~22:00) -> รวมเข้าวันจันทร์ ไม่งั้นวันจันทร์ PDH/PDL = ช่วง 2 ชม.ของวันอาทิตย์
// เสาร์-อาทิตย์ที่ตลาดปิด = วันที่ผ่านมาคือศุกร์ / สัปดาห์ที่ผ่านมาคือสัปดาห์นี้ (ไม่ใช่ข้ามไปพฤหัส/สัปดาห์ก่อน)
// symbol ที่มีแท่งวันเสาร์ (คริปโต 24/7) ไม่รวมวัน ใช้วันปฏิทินตรงๆ
const LV_DAY = 86400e3;
const lvOffMs = () => (state.status?.server_utc_offset_h || 0) * 3600e3;
const lvDow = (ms) => new Date(Math.floor(ms / LV_DAY) * LV_DAY).getUTCDay();
const lvNonstop = (d1) => d1.some((b) => lvDow(b.timestamp + lvOffMs()) === 6);

function lvDayKey(msSrv, nonstop) {
  const d0 = Math.floor(msSrv / LV_DAY) * LV_DAY, dow = new Date(d0).getUTCDay();
  if (nonstop) return d0;
  return dow === 6 ? d0 + 2 * LV_DAY : dow === 0 ? d0 + LV_DAY : d0;
}

function lvWeekKey(msSrv, nonstop) {
  if (!nonstop && lvDow(msSrv) === 6) msSrv += LV_DAY;   // เสาร์ตลาดปิด = นับเป็นสัปดาห์หน้าแล้ว
  const d0 = Math.floor(msSrv / LV_DAY) * LV_DAY;
  return d0 - new Date(d0).getUTCDay() * LV_DAY;   // แท่ง W1 ของ MT5 เริ่มวันอาทิตย์
}

// bars เรียงเวลา (timestamp = UTC ms), nowUtc = เวลาที่ถือเป็น "ตอนนี้" -> {high, low} ของช่วงก่อนหน้า หรือ null
function levelsPrev(bars, nowUtc, keyFn, nonstop) {
  const off = lvOffMs(), cur = keyFn(nowUtc + off, nonstop);
  let key = null, high = -Infinity, low = Infinity;
  for (let i = bars.length - 1; i >= 0; i--) {
    const k = keyFn(bars[i].timestamp + off, nonstop);
    if (k >= cur) continue;
    if (key == null) key = k; else if (k !== key) break;
    high = Math.max(high, bars[i].high); low = Math.min(low, bars[i].low);
  }
  return key == null ? null : { high, low };
}

// แท่ง D1/W1 ไม่ขึ้นกับ TF ของกราฟ: เปลี่ยน TF แล้ว applyLevels ถูกเรียกหลายรอบ -> ใช้ผลเดิมภายใน 60 วินาที
const LV_FETCH = new Map();
function levelsFetch(panel, tf, count) {
  const k = `${state.acct}|${panel.symbol}|${tf}|${count}`, hit = LV_FETCH.get(k);
  if (hit && Date.now() - hit.at < 60e3) return hit.p;
  const p = api(`/api/a/${encodeURIComponent(state.acct)}/rates?${new URLSearchParams({ symbol: panel.symbol, tf, count })}`)
    .then(async (r) => { if (!r.ok) throw new Error("rates"); return (await r.json()).map(toBar); });
  p.catch(() => LV_FETCH.delete(k));
  LV_FETCH.set(k, { p, at: Date.now() });
  return p;
}

function levelsRedraw(panel) {
  levelsVer++;
  panel.chart.overrideIndicator({ name: "wtlevels", extendData: { v: levelsVer } });
}

async function levelsRefresh(panel) {
  const on = levelsOn();
  if ((!on.d && !on.w) || panel.replay) return;
  const sym = panel.symbol;
  try {
    const [d1, w1] = await Promise.all([levelsFetch(panel, "D1", 12), on.w ? levelsFetch(panel, "W1", 3) : []]);
    if (panel.symbol !== sym || panel.replay) return;
    const now = Date.now(), ns = lvNonstop(d1);
    const d = on.d ? levelsPrev(d1, now, lvDayKey, ns) : null, w = on.w ? levelsPrev(w1, now, lvWeekKey, ns) : null;
    panel.levels = { pdh: d?.high, pdl: d?.low, pwh: w?.high, pwl: w?.low };
    panel.levelsAt = now;
    panel.levelsDay = lvDayKey(now + lvOffMs(), ns);
    panel.levelsNs = ns;
    levelsRedraw(panel);
  } catch (_) { /* worker ไม่ตอบ: ไว้รอบหน้า */ }
}

// Bar Replay: เรียกทุกแท่งที่เดิน
async function levelsReplayTick(panel) {
  const on = levelsOn();
  if (!on.d && !on.w) return;
  if ((!RP.views.D1 && !(await rpEnsureView("D1", true))) || (on.w && !RP.views.W1 && !(await rpEnsureView("W1", true)))) return;
  if (panel.replay !== RP || !RP.bars) return;
  const now = RP.bars[RP.cursor].timestamp, upTo = (v) => v.bars.filter((b) => b.timestamp <= now);
  const d1 = upTo(RP.views.D1), ns = lvNonstop(RP.views.D1.bars);
  const d = on.d ? levelsPrev(d1, now, lvDayKey, ns) : null, w = on.w ? levelsPrev(upTo(RP.views.W1), now, lvWeekKey, ns) : null;
  const next = { pdh: d?.high, pdl: d?.low, pwh: w?.high, pwl: w?.low };
  if (JSON.stringify(next) === JSON.stringify(panel.levels)) return;
  panel.levels = next;
  levelsRedraw(panel);
}

function applyLevels(panel) {
  const c = panel.chart;
  if (!c) return;
  c.removeIndicator({ name: "wtlevels" });
  const on = levelsOn();
  if (!on.d && !on.w) { panel.levels = null; return; }
  c.createIndicator({ name: "wtlevels", paneId: "candle_pane" }, true);
  panel.levels = null;
  if (panel.replay) levelsReplayTick(panel); else levelsRefresh(panel);
}

// วันใหม่/สัปดาห์ใหม่: ดึงใหม่เป็นระยะ (แท่ง D1/W1 ก่อนหน้าเปลี่ยนแค่ตอนขึ้นวันใหม่)
setInterval(() => {
  state.charts?.panels.forEach((p) => {
    if (p.replay || p.levels === undefined || p.isHidden?.()) return;
    const dayRolled = p.levelsDay != null && lvDayKey(Date.now() + lvOffMs(), p.levelsNs) !== p.levelsDay;   // ขึ้นวันใหม่ = ดึงทันที
    if (dayRolled || Date.now() - (p.levelsAt || 0) > LEVELS_REFRESH_MS) levelsRefresh(p);
  });
}, 60e3);
