// node --test tests/js/*.js   — ตรรกะ Smart Zone Retest เทียบกับ Pine ต้นฉบับ (สถานการณ์สังเคราะห์)
const test = require("node:test");
const assert = require("node:assert");
const { szCalc, szAtr, szChoch, SZ_DEF } = require("../../static/indicators/smart_zone_retest.js");

const cfg = (o = {}) => ({ ...Object.fromEntries(SZ_DEF.inputs.map((i) => [i.key, i.default])),
  pivotLen: 2, minSpike: 3, useMove: false, useWide: false, atrLen: 3, showStats: true, ...o });
const mk = (rows) => rows.map(([o, h, l, c], i) => ({ timestamp: i * 300000, open: o, high: h, low: l, close: c, volume: 1 }));

// swing high 108 (แท่ง 2) → spike ขึ้น 5-8 ทะลุ 108 ที่แท่ง 7 → จบ spike แท่ง 9 = โซน 100–103 (SL 99.8)
// แท่ง 12 pin bar แตะโซนปิดเหนือ 103 = Long 104.4 · risk 4.6 · TP1 109 / TP2 113.6 / TP3 118.2
const BASE = [
  [105, 106, 104, 104.5], [104.5, 105, 103, 103.5], [103.5, 108, 103, 104], [104, 105, 102, 102.5], [102.5, 103, 100, 100.5],
  [100.5, 103, 100.2, 102.8], [102.8, 106, 102.5, 105.8], [105.8, 109, 105.5, 108.8], [108.8, 111, 108.5, 110.8], [110.8, 111, 109, 109.2],
  [109, 109.5, 106, 106.5], [106.5, 107, 103.5, 104], [104, 104.6, 102.5, 104.4],
];
const WIN = [...BASE, [104.4, 109.5, 104, 109.2], [109.2, 119, 109, 118.5]];

test("ATR = rma เริ่มด้วย sma", () => {
  const a = szAtr(mk([[1, 2, 1, 1.5], [1, 3, 1, 2], [2, 4, 1, 3], [3, 4, 3, 3.5]]), 3);
  assert.ok(Number.isNaN(a[1]));
  assert.strictEqual(a[2], (1 + 2 + 3) / 3);
  assert.strictEqual(a[3], (2 * 2 + 1) / 3);
});

test("spike หลังทะลุ swing high → โซน demand: distal = origin low, proximal = max(high origin, low แท่งทะลุ)", () => {
  const st = szCalc(mk(BASE.slice(0, 10)), cfg({ __allConfirmed: true }));
  assert.strictEqual(st.boxes.length, 1);
  const b = st.boxes[0];
  assert.deepStrictEqual([b.x1, b.x2, b.top, b.bot, b.dir], [4, 9, 103, 100, 1]);
  assert.deepStrictEqual(st.events.long_setup, { top: 103, bot: 100 });
});

test("retest + pin bar → Long signal ที่ราคาปิด, ระดับ SL/TP ตาม R", () => {
  const st = szCalc(mk(BASE), cfg({ __allConfirmed: true }));
  assert.strictEqual(st.shapes.length, 1);
  assert.deepStrictEqual([st.shapes[0].i, st.shapes[0].dir], [12, 1]);
  assert.strictEqual(st.events.long_sig.level, 104.4);
  assert.match(st.events.long_sig.kind, /SL 99\.8 · TP1 109\.0 · PinBar/);
  const ys = st.lines.map((l) => +l.y.toFixed(4));
  assert.deepStrictEqual(ys, [104.4, 99.8, 109, 113.6, 118.2]);
  assert.strictEqual(st.boxes[0].x2, 12);
});

test("TP1-3 ปิดบางส่วน 40/30/30 → +1.9R", () => {
  const st = szCalc(mk(WIN), cfg({ __allConfirmed: true }));
  assert.deepStrictEqual([st.stats.nSig, st.stats.nWin, st.stats.nLoss], [1, 1, 0]);
  assert.ok(Math.abs(st.stats.netR - 1.9) < 1e-9);
  assert.match(st.labels[4].text, /^TP3 ✔ \+90 \| Total \+1\.9R \+190$/);
});

test("แท่งสุดท้ายยังไม่ปิด (กราฟสด) ไม่ถูกประมวลผล", () => {
  const st = szCalc(mk(WIN), cfg());
  assert.deepStrictEqual([st.stats.nWin, st.stats.nLoss], [0, 0]);
  assert.ok(Math.abs(st.stats.netR) < 1e-9);
});

test("SL ก่อน TP ในแท่งเดียวกัน → -1R", () => {
  const st = szCalc(mk([...BASE, [104.4, 120, 99, 100]]), cfg({ __allConfirmed: true }));
  assert.deepStrictEqual([st.stats.nWin, st.stats.nLoss], [0, 1]);
  assert.ok(Math.abs(st.stats.netR + 1) < 1e-9);
});

test("ปิด Pin Bar เหลือ Engulfing → แท่ง 12 ไม่ใช่สัญญาณ", () => {
  const st = szCalc(mk(BASE), cfg({ __allConfirmed: true, usePin: false }));
  assert.strictEqual(st.shapes.length, 0);
});

test("BE หลัง TP1: แท่งย้อนลงมาที่ entry = ปิด +0.4R เส้น SL เดิมยังอยู่", () => {
  const st = szCalc(mk([...BASE, [104.4, 109.5, 104.5, 109.2], [109.2, 109.3, 104, 104.2]]), cfg({ __allConfirmed: true, beAfterTP1: true }));
  assert.ok(Math.abs(st.stats.netR - 0.4) < 1e-9);
  assert.strictEqual(st.stats.nWin, 1);
  assert.strictEqual(st.lines.filter((l) => l.dotted).length, 1);
  assert.strictEqual(st.lines.length, 6);
});

test("CHoCH: เทรนด์ลงแล้วปิดเหนือ swing high = bullish CHoCH", () => {
  const rows = [[10, 10, 9, 9.5], [9.5, 9.6, 8, 8.2], [8.2, 8.3, 6, 6.5], [6.5, 9, 6.4, 8.8], [8.8, 8.9, 7, 7.2], [7.2, 7.3, 5, 5.2],
    [5.2, 5.5, 3, 3.2], [3.2, 6, 3.1, 5.8], [5.8, 6.2, 5, 5.9], [5.9, 9.5, 5.8, 9.4]];
  const [bull, bear] = szChoch(mk(rows), 1);
  assert.strictEqual(bear.indexOf(1), -1);
  // แท่ง 5 ปิดใต้ swing low 6 → เทรนด์ลง (ยังไม่ใช่ CHoCH เพราะ trend เดิม = 0); แท่ง 9 ปิดเหนือ swing high 9 → bullish CHoCH
  assert.deepStrictEqual(bull.map((v, i) => (v ? i : -1)).filter((i) => i >= 0), [9]);
});

// CHoCH จาก TF อื่น (แท่งดึงจาก MT5 ผ่าน __tfGet) — รูปแบบ bullish CHoCH ที่ index 9 ของชุด
const CH = [[10, 10, 9, 9.5], [9.5, 9.6, 8, 8.2], [8.2, 8.3, 6, 6.5], [6.5, 9, 6.4, 8.8], [8.8, 8.9, 7, 7.2], [7.2, 7.3, 5, 5.2],
  [5.2, 5.5, 3, 3.2], [3.2, 6, 3.1, 5.8], [5.8, 6.2, 5, 5.9], [5.9, 9.5, 5.8, 9.4], [9.4, 9.6, 9, 9.2]];
const series = (stepMs, idx9At) => CH.map(([o, h, l, c], k) => ({ timestamp: idx9At + (k - 9) * stepMs, open: o, high: h, low: l, close: c }));
const chCfg = (tf, get) => cfg({ __allConfirmed: true, useChoch: true, chLen: 1, chochTF: tf, __ctx: { tf: "M5" }, __tfGet: get });

test("CHoCH TF ย่อย (M1): CHoCH ในแท่งย่อยของแท่ง 12 → Long ที่แท่ง 12; ขอช่วงถึงปลายแท่งปิดล่าสุด", () => {
  const req = [];
  const st = szCalc(mk(BASE), chCfg("M1", (_c, tf, frm, to) => { req.push([tf, frm, to]); return series(60000, 12 * 300000 + 120000); }));
  assert.deepStrictEqual(req, [["M1", -200 * 60, 12 * 300 + 300]]);
  assert.deepStrictEqual(st.shapes.map((s) => s.i), [12]);
  assert.match(st.events.long_sig.kind, /CHoCH\(M1\)/);
});

test("CHoCH TF ย่อย: CHoCH เกิดหลังแท่ง 12 → แท่ง 12 ยังไม่ใช่สัญญาณ", () => {
  const st = szCalc(mk(BASE), chCfg("M1", () => series(60000, 13 * 300000)));
  assert.strictEqual(st.shapes.length, 0);
});

test("CHoCH TF ใหญ่ (M15): ใช้ผลของแท่งใหญ่ที่เพิ่งปิด ณ แท่งกราฟแรกของแท่งใหญ่ถัดไป", () => {
  // CHoCH ที่แท่ง M15 idx 9 (เริ่ม 2.7e6) → แท่งกราฟ 12 (3.6e6) = แท่งแรกของ M15 idx 10
  const st = szCalc(mk(BASE), chCfg("M15", () => series(900000, 12 * 300000 - 900000)));
  assert.deepStrictEqual(st.shapes.map((s) => s.i), [12]);
  // แท่งใหญ่ที่มี CHoCH ยังไม่ปิด (แท่ง 12 อยู่ในแท่งใหญ่นั้นเอง) → ไม่ใช้
  const st2 = szCalc(mk(BASE), chCfg("M15", () => series(900000, 12 * 300000)));
  assert.strictEqual(st2.shapes.length, 0);
});

test("แท่ง TF CHoCH ยังโหลดไม่เสร็จ / ดึงไม่ได้ → ไม่มีสัญญาณ + แจ้งบนกราฟ", () => {
  const a = szCalc(mk(BASE), chCfg("M1", () => undefined));
  assert.strictEqual(a.shapes.length, 0);
  assert.match(a.note, /กำลังโหลด/);
  const b = szCalc(mk(BASE), chCfg("M1", () => null));
  assert.match(b.note, /ดึงแท่ง M1 ไม่ได้/);
});
