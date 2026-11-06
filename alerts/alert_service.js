// Mee Terminal — ตัวส่ง alert อินดิเคเตอร์เข้า Telegram (รันบน VPS ผ่าน pm2: wt-alerts)
// - ใช้ไฟล์อินดิเคเตอร์ชุดเดียวกับหน้าเว็บ (static/indicators/*.js) -> ผลตรงกับที่เห็นบนกราฟ
// - เช็คทุก POLL_MS: ถ้ามีแท่งปิดใหม่ของ (บัญชี, symbol, TF) ใน rule -> คำนวณด้วยแท่งที่ปิดแล้วเท่านั้น -> ส่งเหตุการณ์ของแท่งนั้น
// - เริ่มโปรแกรม/เพิ่ม rule ใหม่: จำแท่งล่าสุดไว้ก่อน ไม่ยิงย้อนหลัง
// - รอบเร็ว (FAST_MS): alert เส้นราคา, แจ้งไม้ปิด (deal ออก), แจ้ง Auto BE เลื่อน SL — เริ่มนับจากตอนเปิดโปรแกรม ไม่ส่งย้อนหลัง
// env: WT_WORKER_KEY, TELEGRAM_TOKEN, TELEGRAM_CHAT_ID, WT_GATEWAY (default http://127.0.0.1:8100)
"use strict";

const path = require("path");

if (Number(process.versions.node.split(".")[0]) < 18) {
  console.error(`[alerts] ต้องใช้ Node 18 ขึ้นไป (ตอนนี้ ${process.version})`);
  process.exit(1);
}

const { lzCalc, LZ_DEF } = require(path.join(__dirname, "..", "static", "indicators", "liquidity_zones.js"));
const { vpCalc, VP_DEF } = require(path.join(__dirname, "..", "static", "indicators", "vp_order_blocks.js"));
const { ofvCalc, OFV_DEF } = require(path.join(__dirname, "..", "static", "indicators", "of_vwap.js"));
const { mxCalc, MX_DEF } = require(path.join(__dirname, "..", "static", "indicators", "mx_suite.js"));
const { szCalc, SZ_DEF } = require(path.join(__dirname, "..", "static", "indicators", "smart_zone_retest.js"));

const INDICATORS = {
  liquidity_zones: { def: LZ_DEF, calc: lzCalc },
  vp_order_blocks: { def: VP_DEF, calc: vpCalc },
  of_vwap: { def: OFV_DEF, calc: ofvCalc },
  mx_suite: { def: MX_DEF, calc: mxCalc },
  smart_zone_retest: { def: SZ_DEF, calc: szCalc },
};
const POLL_MS = 10000;
const FAST_MS = 2000;
const BARS = 500;
const GATEWAY = process.env.WT_GATEWAY || "http://127.0.0.1:8100";
const KEY = process.env.WT_WORKER_KEY || "";
const TG_TOKEN = process.env.TELEGRAM_TOKEN || "";
const TG_CHAT = process.env.TELEGRAM_CHAT_ID || "";
const TF_MIN = { M1: 1, M5: 5, M15: 15, M30: 30, H1: 60, H4: 240, D1: 1440, W1: 10080, MN1: 43200 };

const log = (...a) => console.log(`[alerts ${new Date().toISOString()}]`, ...a);
// fetch ของ Node ซ่อนสาเหตุจริงไว้ใน e.cause (เช่น ECONNREFUSED) — ดึงออกมาให้อ่านรู้เรื่อง
const why = (e) => [e?.message, e?.cause?.code, e?.cause?.message].filter(Boolean).join(" / ");
let gatewayOk = null;
// log ข้อผิดพลาดซ้ำๆ (เช่น worker บัญชีหนึ่งปิดอยู่) แค่ครั้งแรก + ทุก 10 นาที
const quiet = new Map();
function logQuiet(key, ...a) {
  const msg = a.join(" ");
  const q = quiet.get(key);
  if (q && q.msg === msg && Date.now() - q.at < 600000) return;
  quiet.set(key, { msg, at: Date.now() });
  log(...a);
}
let lastConf = null;

async function getJson(url, headers = {}, timeoutMs = 20000) {
  const r = await fetch(url, { headers: { "X-Worker-Key": KEY, ...headers }, signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error(`${url.split("?")[0]} -> HTTP ${r.status}`);
  return r.json();
}

async function postJson(url, body) {
  await fetch(url, { method: "POST", headers: { "X-Worker-Key": KEY, "Content-Type": "application/json" },
    body: JSON.stringify(body), signal: AbortSignal.timeout(10000) }).catch(() => {});
}

async function telegram(text) {
  if (!TG_TOKEN || !TG_CHAT) return { ok: false, error: "ยังไม่ได้ตั้ง TELEGRAM_TOKEN / TELEGRAM_CHAT_ID" };
  try {
    // ข้อความธรรมดา ไม่ใช้ parse_mode (กัน Markdown พังจาก _ ในชื่อ symbol)
    const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TG_CHAT, text, disable_web_page_preview: true }), signal: AbortSignal.timeout(15000),
    });
    const j = await r.json().catch(() => ({}));
    return j.ok ? { ok: true } : { ok: false, error: j.description || `HTTP ${r.status}` };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

// สัญลักษณ์สกุลเงินบัญชี (ตรงกับ money() ในหน้าเว็บ)
const CCY_SYM = { USD: "$", USC: "¢", USX: "¢", THB: "฿", EUR: "€", GBP: "£", JPY: "¥", CNY: "¥", AUD: "A$", CAD: "C$", SGD: "S$", HKD: "HK$", BTC: "₿" };
function money(n, ccy) {
  const v = Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const sym = CCY_SYM[(ccy || "").toUpperCase()];
  return (n < 0 ? "-" : n > 0 ? "+" : "") + (sym ? `${sym}${v}` : `${v} ${ccy || ""}`.trim());
}

// MT5 DEAL_REASON_*
const REASON = { 0: "ปิดเอง (MT5)", 1: "ปิดเอง (มือถือ)", 2: "ปิดเอง (เว็บ)", 3: "บอท/EA", 4: "ชน SL", 5: "ชน TP", 6: "Stop Out", 7: "Rollover", 8: "VMargin", 9: "Split" };

function closeMessage(d, ccy, digits, acct) {
  const f = (v) => Number(v).toFixed(digits);
  const icon = d.reason === 5 ? "🎯" : d.reason === 4 ? "🛑" : d.reason === 6 ? "⚠️" : d.net >= 0 ? "✅" : "❌";
  const lines = [`${icon} ปิดไม้ ${d.symbol} ${d.side.toUpperCase()} ${d.volume} lot · ${REASON[d.reason] ?? "ปิด"}`,
    `${d.open != null ? f(d.open) + " → " : "ออก "}${f(d.price)}`, `ผลสุทธิ ${money(d.net, ccy)}`];
  if (acct) lines.push(`บัญชี ${acct} · ${thTime(d.time * 1000)}`);
  return lines.join("\n");
}

function autobeMessage(ev, digits, acct) {
  const f = (v) => Number(v).toFixed(digits);
  const how = ev.mode === "points" ? `กำไรถึง ${ev.points} จุด` : `กำไรถึง ${ev.rr}R`;
  if (!ev.ok) return `❗ Auto BE เลื่อน SL ไม่สำเร็จ ${ev.symbol} #${ev.ticket}\n${ev.message}${acct ? `\nบัญชี ${acct}` : ""}`;
  return [`🛡 Auto BE · ${ev.symbol} ${String(ev.side).toUpperCase()} ${ev.volume} lot (${how})`,
    `SL ${ev.old_sl ? f(ev.old_sl) : "ไม่มี"} → ${f(ev.sl)} (ราคาเข้า ${f(ev.open)})`, acct ? `บัญชี ${acct}` : ""].filter(Boolean).join("\n");
}

const TYPE_TH = { 2: "Buy Limit", 3: "Sell Limit", 4: "Buy Stop", 5: "Sell Stop", 6: "Buy Stop Limit", 7: "Sell Stop Limit" };

// OCO / หมดอายุ (worker ยกเลิก pending ให้) / คำสั่งไม่รู้ผล
function orderRuleMessage(ev, digits, acct) {
  const f = (v) => (v == null ? "" : Number(v).toFixed(digits));
  const what = `${ev.symbol} ${TYPE_TH[ev.type] || "pending"} ${ev.volume ?? ""} lot @ ${f(ev.price)}`.replace(/\s+/g, " ");
  const tail = acct ? `บัญชี ${acct}` : "";
  if (ev.kind === "uncertain") {
    return [`⚠️ ไม่รู้ผลคำสั่ง ${ev.action || ""} ${ev.symbol || ""} ${ev.side ? String(ev.side).toUpperCase() : ""}`.replace(/\s+/g, " ").trim(),
      ev.message, "ดูตาราง positions/pending ก่อนส่งซ้ำ", tail].filter(Boolean).join("\n");
  }
  if (!ev.ok) return [`❗ ${ev.kind === "oco" ? "OCO" : "หมดอายุ"}: ยกเลิก #${ev.ticket} ไม่สำเร็จ (จะลองใหม่)`, what, ev.message, tail].filter(Boolean).join("\n");
  if (ev.kind === "oco") return [`🔗 OCO · #${ev.filled} ถูก fill แล้ว → ยกเลิก #${ev.ticket}`, what, tail].filter(Boolean).join("\n");
  return [`⏱ pending หมดอายุ → ยกเลิก #${ev.ticket}`, what, tail].filter(Boolean).join("\n");
}

// ---------- ข่าว: สกุลที่เกี่ยวกับ symbol (ตรงกับ news.js หน้าเว็บ) ----------
const NON_FIAT = new Set(["XAU", "XAG", "BTC", "ETH", "US3", "NAS", "US1", "UST", "USO"]);
function symbolCurrencies(sym) {
  const s = (sym || "").toUpperCase().replace(/[^A-Z]/g, "").replace(/(M|C)$/, "");
  const out = s.length >= 6 ? [s.slice(0, 3), s.slice(3, 6)].filter((x) => !NON_FIAT.has(x)) : [];
  if (/XAU|XAG|BTC|ETH|US30|NAS|US500|USTEC|USOIL/.test(s)) out.push("USD");   // ทอง/คริปโต/ดัชนี ผูก USD
  return [...new Set(out)];
}

const IMPACT_ICON = { High: "🔴", Medium: "🟠", Low: "🟡" };
// ข่าวที่ต้องเตือนตอนนี้: impact ที่เปิด + สกุลในขอบเขต + เหลือ ≤ min นาที + ยังไม่เคยส่ง
function newsDue(events, { impacts, currencies, min, sent, now = Date.now() / 1000 }) {
  return (events || []).filter((e) => e.ts && impacts.has(e.impact) && (!currencies || currencies.has(e.currency))
    && e.ts > now && e.ts - now <= min * 60 && !sent.has(`${e.ts}|${e.currency}|${e.title}`));
}

function newsMessage(list, now = Date.now() / 1000) {
  const left = Math.max(1, Math.round((list[0].ts - now) / 60));
  return [`📰 ข่าวอีก ${left} นาที (${list[0].time_th} น.)`, ...list.map((e) => `${IMPACT_ICON[e.impact] || "•"} ${e.currency} ${e.title}${e.forecast ? ` · คาด ${e.forecast}` : ""}`),
    "ระวังสเปรดกว้าง/ราคากระชาก"].join("\n");
}

function priceMessage(a, price, digits, wick = false, hitAt = null) {
  const f = (v) => Number(v).toFixed(digits);
  const w = wick ? " (ไส้แท่ง M1 แตะ)" : "";
  const head = a.kind === "box" ? `🔔 ราคา ${a.symbol} เข้ากรอบ ${f(a.bottom)} – ${f(a.top)}${w}`
    : a.kind === "line" ? `🔔 ราคา ${a.symbol} ตัดเส้นเทรนด์${a.dir === "up" ? "ขึ้น" : "ลง"} ที่ ${f(hitAt ?? price)}${w}`
    : `🔔 ราคา ${a.symbol} ${a.dir === "up" ? "ขึ้นถึง" : "ลงถึง"} ${f(a.level)}${w}`;
  return [head, `ราคาตอนนี้ ${f(price)}`,
    a.note ? `📝 ${a.note}` : "", `บัญชี ${a.acct} · ${thTime(Date.now())}`].filter(Boolean).join("\n");
}

// ราคาบนเส้นเทรนด์ ณ เวลา t (วินาที UTC): ext none = เฉพาะช่วงระหว่าง 2 จุด, right = ต่อไปทางขวา, both = ยาวสุด
function lineValue(a, t) {
  const { p1, p2 } = a;
  const L = p1.t <= p2.t ? p1 : p2, R = p1.t <= p2.t ? p2 : p1;
  if (a.ext !== "both" && t < L.t) return null;
  if ((a.ext || "none") === "none" && t > R.t) return null;
  return p1.v + (p2.v - p1.v) * (t - p1.t) / (p2.t - p1.t);
}

// alert ราคา: ราคาล่าสุดแตะ หรือแท่ง M1 ที่เริ่มหลังตั้ง alert ไส้แตะ (จับไส้สั้นๆ ระหว่างรอบ)
// level = เส้นแนวนอน, line = เส้นเทรนด์ (ราคาเส้น ณ เวลานั้น), box = ราคาเข้าช่วงบน-ล่างของกรอบ
// คืน { price, wick, at } หรือ null
function priceHit(a, bid, bars, nowSec = Date.now() / 1000) {
  const after = Math.ceil((a.created || 0) / 60) * 60 * 1000;
  const kind = a.kind || "level";
  const lvlAt = (t) => (kind === "line" ? lineValue(a, t) : a.level);
  const cross = (hi, lo, v) => v != null && (a.dir === "up" ? hi >= v : lo <= v);
  if (bid != null) {
    if (kind === "box" ? bid >= a.bottom && bid <= a.top : cross(bid, bid, lvlAt(nowSec))) return { price: bid, wick: false, at: kind === "line" ? lvlAt(nowSec) : null };
  }
  for (const b of bars || []) {
    if (b.timestamp < after) continue;
    if (kind === "box") { if (b.high >= a.bottom && b.low <= a.top) return { price: bid, wick: true, at: null }; continue; }
    const v = lvlAt(b.timestamp / 1000 + 30);
    if (cross(b.high, b.low, v)) return { price: bid, wick: true, at: kind === "line" ? v : null };
  }
  return null;
}

function defaults(def) { return Object.fromEntries(def.inputs.map((i) => [i.key, i.default])); }

function thTime(ms) {
  return new Date(ms).toLocaleString("th-TH", { timeZone: "Asia/Bangkok", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

// ---------- แท่ง TF ย่อยสำหรับ VP OB (cache ต่อ symbol/tf) ----------
const ltfCache = new Map();
async function ltfPrefetch(port, symbol, tf, times) {
  const need = times.filter((t) => !ltfCache.has(`${symbol}|${tf}|${t}`));
  for (let i = 0; i < need.length; i += 300) {
    const chunk = need.slice(i, i + 300);
    const j = await getJson(`http://127.0.0.1:${port}/ltf?symbol=${encodeURIComponent(symbol)}&tf=${tf}&times=${chunk.join(",")}`);
    for (const t of chunk) ltfCache.set(`${symbol}|${tf}|${t}`, j.bars[String(t)] ?? null);
  }
  if (ltfCache.size > 20000) ltfCache.clear();
}

async function evaluate(rule, port, bars, indCfg) {
  const ind = INDICATORS[rule.indicator];
  const cfg = { ...defaults(ind.def), ...(indCfg[rule.indicator]?.cfg || {}), __allConfirmed: true };
  if (rule.indicator === "vp_order_blocks") {
    // รอบแรกเก็บเวลาแท่ง OB ที่ต้องใช้ -> ดึง -> คำนวณจริง
    const want = [];
    ind.calc(bars, { ...cfg, __ltfGet: (_ctx, t) => { want.push(t); return null; } });
    await ltfPrefetch(port, rule.symbol, rule.tf, [...new Set(want)]);
    cfg.__ltfGet = (_ctx, t) => ltfCache.get(`${rule.symbol}|${rule.tf}|${t}`) ?? null;
  }
  if (rule.indicator === "smart_zone_retest" && cfg.useChoch) {
    // CHoCH ใช้แท่ง TF อื่น: รอบแรกเก็บช่วงที่ต้องใช้ -> ดึงจาก MT5 -> คำนวณจริง (ดึงไม่ได้ = ไม่มี CHoCH = ไม่มีสัญญาณ)
    const want = [];
    ind.calc(bars, { ...cfg, __tfGet: (_ctx, tf, frm, to) => { want.push({ tf, frm, to }); return null; } });
    const series = {};
    for (const w of want) {
      try {
        const raw = await getJson(`http://127.0.0.1:${port}/rates_range?symbol=${encodeURIComponent(rule.symbol)}&tf=${w.tf}&frm=${w.frm}&to=${w.to + 1}`);
        series[w.tf] = raw.map((x) => ({ timestamp: x[0] * 1000, open: x[1], high: x[2], low: x[3], close: x[4] }));
      } catch (_) { series[w.tf] = null; }
    }
    cfg.__tfGet = (_ctx, tf) => series[tf] ?? null;
  }
  return ind.calc(bars, cfg).events || {};
}

function message(rule, bar, detail, digits) {
  const ind = INDICATORS[rule.indicator];
  const f = (v) => Number(v).toFixed(digits);
  const lines = [`🔔 ${ind.def.title} · ${ind.def.alerts[rule.event]}`, `${rule.symbol} ${rule.tf} · แท่งปิด ${thTime(bar.timestamp)} (เวลาไทย)`, `ราคาปิด ${f(bar.close)}`];
  if (detail && typeof detail === "object" && detail.top != null) lines.push(`โซน ${f(detail.bot)} – ${f(detail.top)}`);
  if (detail && typeof detail === "object" && detail.level != null) lines.push(`ระดับ ${f(detail.level)}${detail.kind ? ` (${detail.kind})` : ""}`);
  if (rule.acct) lines.push(`บัญชี ${rule.acct}`);
  return lines.join("\n");
}

const lastBar = new Map();   // "acct|symbol|tf" -> timestamp ของแท่งปิดล่าสุดที่ประมวลผลแล้ว
const digitsCache = new Map();

async function tick() {
  let conf;
  try {
    conf = await getJson(`${GATEWAY}/internal/alerts/config?telegram=${TG_TOKEN && TG_CHAT ? 1 : 0}`);
  } catch (e) {
    if (gatewayOk !== false) log(`ต่อ gateway ${GATEWAY} ไม่ได้: ${why(e)} — จะลองใหม่ทุก ${POLL_MS / 1000} วินาที`);
    gatewayOk = false;
    return;
  }
  if (gatewayOk !== true) log(`ต่อ gateway ได้แล้ว — กฎที่เปิดอยู่ ${(conf.rules || []).filter((r) => r.on).length} กฎ`);
  gatewayOk = true;
  lastConf = conf;
  if (conf.test_at) {
    const r = await telegram(`✅ Mee Terminal: ทดสอบการแจ้งเตือน ${thTime(Date.now())}`);
    await postJson(`${GATEWAY}/internal/alerts/fired`, { rule_id: "test", text: "ทดสอบการแจ้งเตือน", ok: r.ok, error: r.error });
    log("test", r.ok ? "ส่งแล้ว" : r.error);
  }
  const rules = (conf.rules || []).filter((r) => r.on && INDICATORS[r.indicator] && INDICATORS[r.indicator].def.alerts[r.event] && TF_MIN[r.tf]);
  // จัดกลุ่มตาม (บัญชี, symbol, TF) ดึงแท่งครั้งเดียว
  const groups = new Map();
  for (const r of rules) {
    const k = `${r.acct}|${r.symbol}|${r.tf}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  for (const [k, rs] of groups) {
    const [acct, symbol, tf] = k.split("|");
    const port = conf.accounts[acct];
    if (!port) continue;
    try {
      const raw = await getJson(`http://127.0.0.1:${port}/rates?symbol=${encodeURIComponent(symbol)}&tf=${tf}&count=${BARS + 1}`);
      if (raw.length < 3) continue;
      const bars = raw.slice(0, -1).map((r) => ({ timestamp: r[0] * 1000, open: r[1], high: r[2], low: r[3], close: r[4], volume: r[5] }));
      const closed = bars[bars.length - 1];
      const seen = lastBar.get(k);
      lastBar.set(k, closed.timestamp);
      if (seen === undefined || closed.timestamp <= seen) continue;   // ยังไม่มีแท่งปิดใหม่ / เพิ่งเริ่ม
      if (!digitsCache.has(symbol)) {
        const spec = await getJson(`http://127.0.0.1:${port}/symbol_spec?symbol=${encodeURIComponent(symbol)}`).catch(() => null);
        digitsCache.set(symbol, spec?.digits ?? 5);
      }
      const byInd = new Map();
      for (const r of rs) {
        if (!byInd.has(r.indicator)) byInd.set(r.indicator, await evaluate(r, port, bars, conf.ind || {}));
        const detail = byInd.get(r.indicator)[r.event];
        if (!detail) continue;
        const text = message(r, closed, detail, digitsCache.get(symbol));
        const res = await telegram(text);
        await postJson(`${GATEWAY}/internal/alerts/fired`, { rule_id: r.id, text, ok: res.ok, error: res.error });
        await postJson(`${GATEWAY}/internal/push/send`, { text, tag: "ind" });
        log(r.id, r.symbol, r.tf, r.event, res.ok ? "ส่งแล้ว" : res.error);
      }
    } catch (e) {
      log(k, "ผิดพลาด:", why(e));
    }
  }
  // ลืม group ที่ไม่มี rule แล้ว (เพิ่มกลับมาใหม่ = เริ่มนับใหม่ ไม่ยิงย้อนหลัง)
  for (const k of [...lastBar.keys()]) if (!groups.has(k)) lastBar.delete(k);
}

// ---------- รอบเร็ว: alert ราคา / ไม้ปิด / Auto BE ----------
const firedPrice = new Set();           // กันยิงซ้ำระหว่างรอ gateway ปิด alert
const dealState = new Map();            // acct -> { frm, seen:Set }
const beState = new Map();              // acct -> { boot, seq }
const beFailNotified = new Set();       // ticket ที่แจ้งว่าเลื่อนไม่สำเร็จไปแล้ว (แจ้งครั้งเดียว)
const ccyCache = new Map();

async function digitsOf(port, symbol) {
  if (!digitsCache.has(symbol)) {
    const spec = await getJson(`http://127.0.0.1:${port}/symbol_spec?symbol=${encodeURIComponent(symbol)}`).catch(() => null);
    if (!spec) return 5;
    digitsCache.set(symbol, spec.digits ?? 5);
  }
  return digitsCache.get(symbol);
}

async function send(ruleId, text) {
  const res = await telegram(text);
  await postJson(`${GATEWAY}/internal/alerts/fired`, { rule_id: ruleId, text, ok: res.ok, error: res.error });
  await postJson(`${GATEWAY}/internal/push/send`, { text, tag: String(ruleId).split(":")[0] });   // แจ้งบนเครื่องที่ลงทะเบียน Web Push ด้วย
  log(ruleId, text.split("\n")[0], res.ok ? "ส่งแล้ว" : res.error);
  return res;
}

async function checkPriceAlerts(conf) {
  const groups = new Map();
  for (const a of conf.palerts || []) {
    if (!a.on || firedPrice.has(a.id) || !conf.accounts[a.acct]) continue;
    const k = `${a.acct}|${a.symbol}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(a);
  }
  for (const [k, list] of groups) {
    const [acct, symbol] = k.split("|");
    const port = conf.accounts[acct];
    try {
      const t = await getJson(`http://127.0.0.1:${port}/tick?symbol=${encodeURIComponent(symbol)}`);
      const raw = await getJson(`http://127.0.0.1:${port}/rates?symbol=${encodeURIComponent(symbol)}&tf=M1&count=3`);
      const bars = raw.map((r) => ({ timestamp: r[0] * 1000, high: r[2], low: r[3] }));
      for (const a of list) {
        const hit = priceHit(a, t.bid, bars);
        if (hit == null) continue;
        firedPrice.add(a.id);
        await send(`price:${a.id}`, priceMessage(a, t.bid, await digitsOf(port, symbol), hit.wick, hit.at));
        await postJson(`${GATEWAY}/internal/alerts/palert_fired`, { id: a.id, price: hit.at ?? (hit.wick && a.kind !== "box" ? a.level : t.bid) });
      }
    } catch (e) {
      logQuiet(`pa:${k}`, k, "alert ราคา ผิดพลาด:", why(e));
    }
  }
  const live = new Set((conf.palerts || []).map((a) => a.id));
  for (const id of [...firedPrice]) if (!live.has(id)) firedPrice.delete(id);
}

async function checkClosedDeals(conf) {
  const now = Math.floor(Date.now() / 1000);
  for (const [acct, port] of Object.entries(conf.accounts)) {
    let st = dealState.get(acct);
    if (!st) { st = { frm: now, seen: new Set() }; dealState.set(acct, st); }   // เริ่มนับจากตอนนี้ ไม่ส่งย้อนหลัง
    try {
      const j = await getJson(`http://127.0.0.1:${port}/deals?frm=${st.frm - 120}`);
      ccyCache.set(acct, j.currency);
      for (const d of j.deals) {
        if (st.seen.has(d.ticket) || d.time < st.frm - 5) continue;
        st.seen.add(d.ticket);
        if (conf.notify?.close) await send(`close:${acct}:${d.ticket}`, closeMessage(d, j.currency, await digitsOf(port, d.symbol), acct));
      }
      if (j.deals.length) st.frm = Math.max(st.frm, Math.max(...j.deals.map((d) => d.time)));
      if (st.seen.size > 5000) st.seen = new Set([...st.seen].slice(-1000));
    } catch (e) {
      logQuiet(`deal:${acct}`, acct, "ดึง deal ไม่ได้:", why(e));
    }
  }
}

const SERVICE_START = Date.now() / 1000;

// เหตุการณ์ Auto BE ที่ต้องส่ง: ครั้งแรกส่งเฉพาะที่เกิดหลังตัวส่งนี้เริ่ม (deploy = restart worker+ตัวส่งพร้อมกัน
// Auto BE อาจยิงใน 2-3 วินาทีแรกก่อนตัวส่งต่อติด — เดิมถือเป็น "ย้อนหลัง" แล้วไม่ส่ง), worker restart = seq เริ่มใหม่
function autobeToSend(st, j, startSec = SERVICE_START) {
  const maxSeq = j.events.reduce((m, e) => Math.max(m, e.seq), 0);
  if (!st || st.boot !== j.boot) {
    const since = st ? 0 : startSec - 5;
    return { events: j.events.filter((e) => (e.ts || 0) >= since), next: { boot: j.boot, seq: maxSeq } };
  }
  return { events: j.events.filter((e) => e.seq > st.seq), next: { boot: j.boot, seq: Math.max(st.seq, maxSeq) } };
}

async function checkAutoBE(conf) {
  for (const [acct, port] of Object.entries(conf.accounts)) {
    const st = beState.get(acct);
    try {
      // worker restart แล้ว seq เก่าอาจสูงกว่าของใหม่ -> ขอทั้งหมดเมื่อไม่แน่ใจ (after=0) แล้วกรองเอง
      const j = await getJson(`http://127.0.0.1:${port}/autobe_events?after=0`);
      const { events, next } = autobeToSend(st, j);
      beState.set(acct, next);
      for (const ev of events) {
        if (ev.kind === "oco" || ev.kind === "expire" || ev.kind === "uncertain") {
          if (!(ev.kind === "uncertain" ? conf.notify?.system : conf.notify?.orders)) continue;
          await send(`${ev.kind}:${acct}:${ev.ticket ?? ev.seq}`, orderRuleMessage(ev, ev.symbol ? await digitsOf(port, ev.symbol) : 5, acct));
          continue;
        }
        if (!conf.notify?.autobe) continue;
        if (!ev.ok) { if (beFailNotified.has(ev.ticket)) continue; beFailNotified.add(ev.ticket); }
        await send(`autobe:${acct}:${ev.ticket}`, autobeMessage(ev, await digitsOf(port, ev.symbol), acct));
      }
    } catch (e) {
      logQuiet(`be:${acct}`, acct, "ดึง Auto BE ไม่ได้:", why(e));
    }
  }
}

// ---------- สถานะระบบ: worker ไม่ตอบ / MT5 หลุด / ส่งคำสั่งค้าง ----------
const SYS_DOWN_SEC = 60;
const SYS_WAIT_SEC = 60;
const sysState = new Map();     // acct -> { seen, workerDown, mt5Down, notified: Set, waitNotified }

function sysStep(st, s, now) {
  // s = ผล /status หรือ null (worker ไม่ตอบ) -> คืนข้อความที่ต้องส่ง [] (เตือนเฉพาะหลังเคยเห็น worker ทำงาน: worker ที่ตั้งใจปิดไว้ไม่แจ้ง)
  const out = [];
  const mins = (t) => Math.max(1, Math.round((now - t) / 60));
  if (!s) {
    if (!st.seen) return out;
    st.workerDown ??= now;
    if (now - st.workerDown >= SYS_DOWN_SEC && !st.notified.has("worker")) { st.notified.add("worker"); out.push(["worker", "down"]); }
    return out;
  }
  st.seen = true;
  if (st.workerDown != null) { if (st.notified.delete("worker")) out.push(["worker", "up", mins(st.workerDown)]); st.workerDown = null; }
  if (!s.mt5) {
    st.mt5Down ??= now;
    if (now - st.mt5Down >= SYS_DOWN_SEC && !st.notified.has("mt5")) { st.notified.add("mt5"); out.push(["mt5", "down", s.error || ""]); }
  } else if (st.mt5Down != null) {
    if (st.notified.delete("mt5")) out.push(["mt5", "up", mins(st.mt5Down)]);
    st.mt5Down = null;
  }
  if (s.trade_wait_s != null && s.trade_wait_s >= SYS_WAIT_SEC) {
    if (!st.waitNotified) { st.waitNotified = true; out.push(["wait", "down", s.trade_wait_s]); }
  } else st.waitNotified = false;
  return out;
}

function sysMessage(acct, [what, dir, extra]) {
  if (what === "worker") return dir === "down" ? `🔴 worker บัญชี ${acct} ไม่ตอบเกิน ${SYS_DOWN_SEC} วินาที\nหน้าเว็บ/Auto BE/OCO ของบัญชีนี้หยุด — เช็ค pm2 wt-worker-${acct}`
    : `🟢 worker บัญชี ${acct} กลับมาแล้ว (หายไป ~${extra} นาที)`;
  if (what === "mt5") return dir === "down" ? `🔴 MT5 บัญชี ${acct} หลุดเกิน ${SYS_DOWN_SEC} วินาที${extra ? `\n${extra}` : ""}`
    : `🟢 MT5 บัญชี ${acct} ต่อได้แล้ว (หลุดไป ~${extra} นาที)`;
  return `⏳ บัญชี ${acct}: รอผลคำสั่งจากโบรกนาน ${extra} วินาที — อย่าเพิ่งส่งซ้ำ`;
}

async function checkSystem(conf) {
  const now = Date.now() / 1000;
  for (const [acct, port] of Object.entries(conf.accounts)) {
    let st = sysState.get(acct);
    if (!st) { st = { seen: false, workerDown: null, mt5Down: null, notified: new Set(), waitNotified: false }; sysState.set(acct, st); }
    const s = await getJson(`http://127.0.0.1:${port}/status`, {}, 8000).catch(() => null);
    for (const m of sysStep(st, s, now)) {
      if (conf.notify?.system) await send(`sys:${acct}:${m[0]}`, sysMessage(acct, m));
      else log("sys", acct, m.join(" "));
    }
  }
}

// ---------- ข่าวล่วงหน้า ----------
let newsCache = { at: 0, events: [] };
const newsSent = new Set();
async function checkNews(conf) {
  const cfg = { alertMin: 15, scope: "watch", ...(conf.settings?.news || {}) };
  const cal = { High: true, Medium: false, Low: false, ...(conf.settings?.cal || {}) };
  const min = Number(cfg.alertMin) || 0;
  if (!min) return;
  if (Date.now() - newsCache.at > 10 * 60 * 1000) {
    try { newsCache = { at: Date.now(), events: (await getJson(`${GATEWAY}/internal/news`)).events || [] }; }
    catch (e) { logQuiet("news", "ดึงข่าวไม่ได้:", why(e)); newsCache.at = Date.now() - 8 * 60 * 1000; return; }
  }
  let currencies = null;
  if (cfg.scope !== "all") {
    currencies = new Set();
    for (const [acct, port] of Object.entries(conf.accounts)) {
      let syms = [];
      if (cfg.scope === "held") {
        const [p, o] = await Promise.all([getJson(`http://127.0.0.1:${port}/positions`).catch(() => []), getJson(`http://127.0.0.1:${port}/orders`).catch(() => [])]);
        syms = [...(Array.isArray(p) ? p : []), ...(Array.isArray(o) ? o : [])].map((x) => x.symbol);
      } else syms = conf.watch?.[acct] || [];
      for (const sym of syms) symbolCurrencies(sym).forEach((c) => currencies.add(c));
    }
    if (!currencies.size) return;
  }
  const impacts = new Set(Object.keys(cal).filter((k) => cal[k]));
  const due = newsDue(newsCache.events, { impacts, currencies, min, sent: newsSent });
  const byTs = new Map();
  for (const e of due) { newsSent.add(`${e.ts}|${e.currency}|${e.title}`); if (!byTs.has(e.ts)) byTs.set(e.ts, []); byTs.get(e.ts).push(e); }
  for (const [ts, list] of byTs) await send(`news:${ts}`, newsMessage(list));
  if (newsSent.size > 2000) newsSent.clear();
}

let dealTurn = 0;
async function fastTick() {
  const conf = lastConf;
  if (!conf) return;
  await checkPriceAlerts(conf);
  if (dealTurn++ % 3 === 0) {             // ไม้ปิด + Auto BE ทุก ~6 วินาที
    await checkClosedDeals(conf);
    await checkAutoBE(conf);
    await checkSystem(conf);
  }
  if (dealTurn % 15 === 1) await checkNews(conf);   // ~30 วินาที
}

async function main() {
  if (KEY.length < 16) { console.error("[alerts] ไม่มี WT_WORKER_KEY"); process.exit(1); }
  log(`เริ่มทำงาน gateway=${GATEWAY} telegram=${TG_TOKEN && TG_CHAT ? "ตั้งแล้ว" : "ยังไม่ตั้ง"}`);
  (async () => {
    for (;;) {
      try { await fastTick(); } catch (e) { log("รอบเร็วล้ม:", why(e)); }
      await new Promise((r) => setTimeout(r, FAST_MS));
    }
  })();
  for (;;) {
    try { await tick(); } catch (e) { log("รอบนี้ล้ม:", why(e)); }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

if (require.main === module) main();
module.exports = { evaluate, message, INDICATORS, priceHit, lineValue, closeMessage, autobeMessage, priceMessage, money, autobeToSend,
  orderRuleMessage, symbolCurrencies, newsDue, newsMessage, sysStep, sysMessage };
