// ตัวส่ง alert: คำนวณด้วยไฟล์อินดิเคเตอร์เดียวกับหน้าเว็บ + ข้อความ
const test = require("node:test");
const assert = require("node:assert");
const { evaluate, message } = require("../../alerts/alert_service.js");

test("evaluate Liquidity Zones ส่งเหตุการณ์ของแท่งสุดท้าย", async () => {
  const hl = [[10, 9], [11, 9], [15, 9], [11, 9], [10, 9], [11, 9], [15.001, 9], [12, 9]];
  const bars = hl.map(([h, l], i) => ({ timestamp: i * 60000, open: l, close: h, high: h, low: l, volume: 10 }));
  const ev = await evaluate({ indicator: "liquidity_zones", symbol: "X", tf: "M1" }, 0, bars, { liquidity_zones: { cfg: { leftLen: 2, rightLen: 1 } } });
  assert.ok(ev.new_eqh);
});

test("ข้อความ Telegram มีชื่อเหตุการณ์ symbol TF ราคา และโซน", () => {
  const t = message({ indicator: "vp_order_blocks", event: "bull_rej", symbol: "BTCUSDm", tf: "M5", acct: "demo" },
    { timestamp: Date.UTC(2026, 8, 27, 1, 15), close: 84012.34 }, { top: 84030, bot: 83990 }, 2);
  assert.match(t, /Confirmed Rejection Off Bullish Max Volume Zone/);
  assert.match(t, /BTCUSDm M5/);
  assert.match(t, /84012\.34/);
  assert.match(t, /83990\.00 – 84030\.00/);
});

const { priceHit, lineValue, closeMessage, autobeMessage, priceMessage, money } = require("../../alerts/alert_service.js");

test("alert ราคา: แตะด้วยราคาล่าสุด หรือไส้แท่ง M1 ที่เริ่มหลังตั้ง", () => {
  const created = 1_700_000_030;             // วินาที (กลางนาที)
  const up = { dir: "up", level: 100, created };
  assert.strictEqual(priceHit(up, 99.9, []), null);
  assert.strictEqual(priceHit(up, 100, []).price, 100);
  // แท่งที่เริ่มก่อนตั้ง (ไส้ 101 อาจเกิดก่อนตั้ง) ไม่นับ; แท่งหลังตั้งนับ
  assert.strictEqual(priceHit(up, 99, [{ timestamp: 1_700_000_000_000 - 0, high: 101, low: 98 }]), null);
  assert.strictEqual(priceHit(up, 99, [{ timestamp: 1_700_000_040_000 + 20_000, high: 100.5, low: 98 }]).wick, true);
  const dn = { dir: "down", level: 90, created };
  assert.strictEqual(priceHit(dn, 90.1, [{ timestamp: 1_700_000_060_000, high: 95, low: 90.01 }]), null);
  assert.strictEqual(priceHit(dn, 89.9, []).price, 89.9);
});

test("ข้อความไม้ปิด / Auto BE / alert ราคา", () => {
  assert.strictEqual(money(12.3, "USD"), "+$12.30");
  assert.strictEqual(money(-4500, "USC"), "-¢4,500.00");
  const c = closeMessage({ symbol: "XAUUSD", side: "buy", volume: 0.1, reason: 5, open: 2640, price: 2650, net: 98.65, time: 1_790_000_000 }, "USD", 2, "demo");
  assert.match(c, /🎯 ปิดไม้ XAUUSD BUY 0.1 lot · ชน TP/);
  assert.match(c, /2640\.00 → 2650\.00/);
  assert.match(c, /\+\$98\.65/);
  const b = autobeMessage({ ok: true, symbol: "XAUUSD", side: "sell", volume: 0.2, mode: "rr", rr: 1, old_sl: 2660, sl: 2650, open: 2650 }, 2, "demo");
  assert.match(b, /🛡 Auto BE · XAUUSD SELL 0.2 lot \(กำไรถึง 1R\)/);
  assert.match(b, /SL 2660\.00 → 2650\.00/);
  assert.match(autobeMessage({ ok: false, symbol: "X", ticket: 5, message: "ตลาดปิด" }, 2), /ไม่สำเร็จ.*\n.*ตลาดปิด/);
  assert.match(priceMessage({ symbol: "BTCUSDm", dir: "down", level: 80000, note: "แนวรับ", acct: "demo" }, 79999.5, 2), /ลงถึง 80000\.00[\s\S]*📝 แนวรับ/);
});

test("alert เส้นเทรนด์ / กรอบ", () => {
  // เส้นขึ้นจาก 100 (t=0) ไป 110 (t=1000) ต่อไปทางขวา -> t=2000 = 120
  const ln = { kind: "line", dir: "up", ext: "right", p1: { t: 0, v: 100 }, p2: { t: 1000, v: 110 }, created: 0 };
  assert.strictEqual(lineValue(ln, 2000), 120);
  assert.strictEqual(lineValue(ln, -10), null);                                  // ก่อนจุดซ้าย
  assert.strictEqual(lineValue({ ...ln, ext: "none" }, 2000), null);             // เส้นสั้น หมดช่วงแล้ว
  assert.strictEqual(lineValue({ ...ln, ext: "both" }, -1000), 90);
  assert.strictEqual(priceHit(ln, 119.9, [], 2000), null);
  const h = priceHit(ln, 120.1, [], 2000);
  assert.ok(h && !h.wick && Math.abs(h.at - 120) < 1e-9);
  const dnl = { ...ln, dir: "down" };
  assert.ok(priceHit(dnl, 125, [{ timestamp: 1_970_000, high: 126, low: 119.5 }], 2000).wick);   // ไส้แท่งลงแตะเส้น (~120.0)
  const box = { kind: "box", dir: "enter", top: 2650, bottom: 2640, created: 0 };
  assert.strictEqual(priceHit(box, 2655, []), null);
  assert.strictEqual(priceHit(box, 2645, []).price, 2645);
  assert.ok(priceHit(box, 2660, [{ timestamp: 60_000, high: 2661, low: 2649 }]).wick);
  assert.match(priceMessage({ ...box, symbol: "XAUUSD", acct: "demo" }, 2645, 2), /เข้ากรอบ 2640\.00 – 2650\.00/);
  assert.match(priceMessage({ ...ln, symbol: "XAUUSD", acct: "demo" }, 120.1, 2, false, 120), /ตัดเส้นเทรนด์ขึ้น ที่ 120\.00/);
});

test("Auto BE: ส่งเหตุการณ์ที่เกิดหลังตัวส่งเริ่ม (รวม 2-3 วิแรกหลัง deploy) ไม่ส่งซ้ำ ไม่ส่งของเก่า", () => {
  const { autobeToSend } = require("../../alerts/alert_service.js");
  const start = 1000;
  const j = { boot: 1, events: [{ seq: 1, ts: 900 }, { seq: 2, ts: 998 }, { seq: 3, ts: 1003 }] };
  let r = autobeToSend(undefined, j, start);
  assert.deepStrictEqual(r.events.map((e) => e.seq), [2, 3]);           // 900 = ก่อนเริ่มนาน (ไม่ส่ง), 998 = ช่วงเผื่อ 5 วิ
  r = autobeToSend(r.next, { boot: 1, events: [...j.events, { seq: 4, ts: 1010 }] }, start);
  assert.deepStrictEqual(r.events.map((e) => e.seq), [4]);               // ไม่ซ้ำ
  r = autobeToSend(r.next, { boot: 2, events: [{ seq: 1, ts: 1500 }] }, start);
  assert.deepStrictEqual(r.events.map((e) => e.seq), [1]);               // worker restart: seq เริ่มใหม่ ยังส่ง
  r = autobeToSend(r.next, { boot: 2, events: [{ seq: 1, ts: 1500 }] }, start);
  assert.deepStrictEqual(r.events, []);
});

test("OCO / หมดอายุ / คำสั่งไม่รู้ผล: ข้อความ", () => {
  const { orderRuleMessage } = require("../../alerts/alert_service.js");
  const base = { symbol: "XAUUSD", type: 5, volume: 0.01, price: 2635, ticket: 602, ok: true };
  assert.match(orderRuleMessage({ ...base, kind: "oco", filled: 601 }, 2, "demo"), /OCO · #601 ถูก fill แล้ว → ยกเลิก #602\nXAUUSD Sell Stop 0\.01 lot @ 2635\.00/);
  assert.match(orderRuleMessage({ ...base, kind: "expire" }, 2, "demo"), /หมดอายุ/);
  assert.match(orderRuleMessage({ ...base, kind: "oco", ok: false, message: "x" }, 2), /ไม่สำเร็จ/);
  assert.match(orderRuleMessage({ kind: "uncertain", action: "order", symbol: "XAUUSD", side: "buy", message: "timeout" }, 2, "demo"), /ไม่รู้ผลคำสั่ง order XAUUSD BUY/);
});

test("ข่าวล่วงหน้า: กรอง impact/สกุล/เวลา ไม่ส่งซ้ำ", () => {
  const { newsDue, newsMessage, symbolCurrencies } = require("../../alerts/alert_service.js");
  assert.deepStrictEqual(symbolCurrencies("XAUUSDm"), ["USD"]);
  assert.deepStrictEqual(symbolCurrencies("EURGBP"), ["EUR", "GBP"]);
  const now = 10000;
  const ev = [{ ts: now + 600, impact: "High", currency: "USD", title: "CPI", time_th: "19:30" },
    { ts: now + 600, impact: "Medium", currency: "USD", title: "X", time_th: "19:30" },
    { ts: now + 3600, impact: "High", currency: "USD", title: "Late", time_th: "20:30" },
    { ts: now + 300, impact: "High", currency: "JPY", title: "BoJ", time_th: "19:25" },
    { ts: now - 60, impact: "High", currency: "USD", title: "Past", time_th: "19:19" }];
  const sent = new Set();
  const due = newsDue(ev, { impacts: new Set(["High"]), currencies: new Set(["USD"]), min: 15, sent, now });
  assert.deepStrictEqual(due.map((e) => e.title), ["CPI"]);
  sent.add(`${now + 600}|USD|CPI`);
  assert.deepStrictEqual(newsDue(ev, { impacts: new Set(["High"]), currencies: new Set(["USD"]), min: 15, sent, now }), []);
  assert.strictEqual(newsDue(ev, { impacts: new Set(["High", "Medium"]), currencies: null, min: 15, sent: new Set(), now }).length, 3);
  assert.match(newsMessage(due, now), /ข่าวอีก 10 นาที \(19:30 น\.\)\n🔴 USD CPI/);
});

test("สถานะระบบ: เตือนหลังหลุดเกิน 60 วิ ครั้งเดียว + แจ้งตอนกลับมา, worker ที่ปิดไว้ตั้งแต่แรกไม่เตือน", () => {
  const { sysStep, sysMessage } = require("../../alerts/alert_service.js");
  const st = { seen: false, workerDown: null, mt5Down: null, notified: new Set(), waitNotified: false };
  assert.deepStrictEqual(sysStep(st, null, 0), []);
  assert.deepStrictEqual(sysStep(st, null, 100), []);                  // ไม่เคยเห็นทำงาน = ตั้งใจปิด
  assert.deepStrictEqual(sysStep(st, { mt5: true }, 110), []);
  assert.deepStrictEqual(sysStep(st, null, 120), []);
  assert.deepStrictEqual(sysStep(st, null, 181), [["worker", "down"]]);
  assert.deepStrictEqual(sysStep(st, null, 300), []);                  // ไม่ซ้ำ
  assert.deepStrictEqual(sysStep(st, { mt5: true }, 420), [["worker", "up", 5]]);
  assert.deepStrictEqual(sysStep(st, { mt5: false, error: "e" }, 430), []);
  assert.deepStrictEqual(sysStep(st, { mt5: true }, 440), []);          // หลุดสั้นๆ ไม่แจ้ง
  assert.deepStrictEqual(sysStep(st, { mt5: true, trade_wait_s: 75 }, 450), [["wait", "down", 75]]);
  assert.deepStrictEqual(sysStep(st, { mt5: true, trade_wait_s: 80 }, 455), []);
  assert.match(sysMessage("demo", ["worker", "down"]), /worker บัญชี demo ไม่ตอบ/);
});
