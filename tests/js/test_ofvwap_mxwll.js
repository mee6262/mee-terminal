// Order Flow VWAP Deviation + Mxwll Suite: สูตรหลักตามต้นฉบับ Pine
const test = require("node:test");
const assert = require("node:assert");
const { ofvCalc, ofvInSession, ofvPeriodKey, OFV_DEF } = require("../../static/indicators/of_vwap.js");
const { mxCalc, mxPivots, mxDashboard, mxPercentileNR, MX_DEF } = require("../../static/indicators/mx_suite.js");

const dflt = (def) => Object.fromEntries(def.inputs.map((i) => [i.key, i.default]));
const bar = (t, o, h, l, c, v = 100) => ({ timestamp: t, open: o, high: h, low: l, close: c, volume: v });

test("VWAP: hlc3 ถ่วง volume + SD, รีเซ็ตวันใหม่ (UTC)", () => {
  const d0 = Date.UTC(2026, 8, 21, 22, 0);
  const bars = [bar(d0, 10, 12, 8, 10, 1), bar(d0 + 36e5, 10, 13, 11, 12, 3), bar(d0 + 72e5, 20, 21, 19, 20, 2)];
  const s = ofvCalc(bars, { ...dflt(OFV_DEF), pivotLookback: 10 });
  assert.ok(Math.abs(s.vwap[1] - (10 * 1 + 12 * 3) / 4) < 1e-9);
  const sd = Math.sqrt((100 * 1 + 144 * 3) / 4 - s.vwap[1] ** 2);
  assert.ok(Math.abs(s.up[1] - (s.vwap[1] + 2 * sd)) < 1e-9);
  assert.strictEqual(s.vwap[2], 20);                       // แท่งที่ 3 อยู่วันใหม่ -> เริ่มใหม่
  assert.notStrictEqual(ofvPeriodKey(d0 + 36e5, "Session"), ofvPeriodKey(d0 + 72e5, "Session"));
});

test("VP anchor: แท่งที่ทับ 18:00 GMT-4 (22:00 UTC) — TF ใหญ่ก็เจอ", () => {
  assert.ok(ofvInSession(Date.UTC(2026, 8, 20, 22, 0), 60000, "1800-1801", "GMT-4"));
  assert.ok(!ofvInSession(Date.UTC(2026, 8, 20, 21, 59), 60000, "1800-1801", "GMT-4"));
  assert.ok(ofvInSession(Date.UTC(2026, 8, 20, 20, 0), 4 * 36e5, "1800-1801", "GMT-4"));
  assert.ok(ofvInSession(Date.UTC(2026, 8, 20, 18, 0), 60000, "1800-1801", "UTC"));
});

test("Stop lines: pivot high -> เส้นยืดจนราคาแตะ, แตะพร้อม volume สูง = Stops Triggered", () => {
  const bars = [];
  const t0 = Date.UTC(2026, 8, 21);
  for (let i = 0; i < 60; i++) {
    const hi = i === 15 ? 110 : 100 + (i % 3);
    bars.push(bar(t0 + i * 6e4, 99, i === 40 ? 111 : hi, 95, 100, i === 40 ? 1000 : 100));
  }
  const s = ofvCalc(bars, { ...dflt(OFV_DEF), pivotLookback: 10 });
  const ln = s.lines.find((l) => l.hi && l.y === 110);
  assert.ok(ln && ln.x1 === 15 && ln.x2 === 40, JSON.stringify(ln));
  assert.strictEqual(s.stopHi[40], 111);
});

test("Mxwll pivots: high[len] > max ของ len แท่งล่าสุด ตอนสลับสถานะ", () => {
  // สถานะเริ่ม = 0 (ขาขึ้น) -> swing high แรกนับได้หลังเกิด swing low ก่อน (ตามต้นฉบับ)
  const highs = [5, 5, 5, 5, 1, 5, 5, 5, 9, 5, 5, 5, 5];
  const bars = highs.map((h, i) => bar(i * 6e4, h, h, h === 1 ? 0.5 : h - 0.5, h));
  const p = mxPivots(bars, 3);
  assert.strictEqual(p.bot.indexOf(0.5), 7);               // low แท่ง 4 ยืนยันที่แท่ง 7
  assert.strictEqual(p.top.indexOf(9), 11);                // high แท่ง 8 ยืนยันที่แท่ง 11
});

test("Mxwll: คำนวณครบ + percentile + dashboard ตามเวลา NY", () => {
  const bars = [];
  let p = 2000;
  const t0 = Date.UTC(2026, 8, 1);
  for (let i = 0; i < 1500; i++) {
    const o = p; p += Math.sin(i / 23) * 3 + ((i * 7919) % 13 - 6) * 0.3;
    bars.push(bar(t0 + i * 9e5, o, Math.max(o, p) + 1, Math.min(o, p) - 1, p, 100 + (i % 50)));
  }
  const s = mxCalc(bars, dflt(MX_DEF));
  assert.ok(s.labels.some((l) => /BoS|CHoCH/.test(l.text)));
  assert.ok(s.main && s.fibs.length === 7);               // mee ver: 0.236 0.382 0.5 0.618 0.786 0.65 0.886
  assert.ok(s.hiBlocks.length <= 10 && s.loBlocks.length <= 10);   // showLast 10 (เกินแล้วต้นฉบับลบ 2 อัน)
  assert.strictEqual(mxPercentileNR([5, 1, 3, 2, 4], 50), 3);
  const ny = (h, m) => Date.UTC(2026, 8, 28, h + 4, m);   // ก.ย. = EDT (UTC-4)
  assert.deepStrictEqual([mxDashboard(ny(10, 0)).s1, mxDashboard(ny(10, 0)).close], ["New York", "6h0m"]);
  assert.strictEqual(mxDashboard(ny(4, 0)).s1, "London");
  assert.strictEqual(mxDashboard(ny(21, 0)).s1, "Dead Zone");   // ต้นฉบับ: ช่วง Asia ไม่เคยเข้าเงื่อนไข
});
