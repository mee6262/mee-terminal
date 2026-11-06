// node --test tests/js/*.js — ตรรกะ VP Order Blocks เทียบกับ Pine ต้นฉบับ
const test = require("node:test");
const assert = require("node:assert");
const { vpCalc, vpCondition, vpVolumes, vpGradient, VP_DEF } = require("../../static/indicators/vp_order_blocks.js");

const defaults = Object.fromEntries(VP_DEF.inputs.map((i) => [i.key, i.default]));
const cfg = (o = {}) => ({ ...defaults, tuning: 3, amountOfBoxes: 4, __ctx: {}, __ltfGet: () => [[10, 6, 100]], ...o });
// [open, close] -> แท่ง (high/low ครอบ)
const mk = (oc, hl) => oc.map(([o, c], i) => ({ timestamp: i * 60000, open: o, close: c, high: hl?.[i]?.[0] ?? Math.max(o, c) + 0.5, low: hl?.[i]?.[1] ?? Math.min(o, c) - 0.5, volume: 1 }));

test("เงื่อนไข OB: bear = แท่ง[tuning-1] ขึ้น ตามด้วยลง/ทรงตัว, bull กลับกัน", () => {
  const b = mk([[5, 5], [5, 5], [5, 5], [7, 8], [8, 7], [7, 6]]);
  assert.deepStrictEqual(vpCondition(b, 5, 3), { bear: true, bull: false });
  const u = mk([[5, 5], [5, 5], [5, 5], [8, 7], [7, 8], [8, 9]]);
  assert.deepStrictEqual(vpCondition(u, 5, 3), { bear: false, bull: true });
  const x = mk([[5, 5], [5, 5], [5, 5], [7, 8], [8, 9], [9, 8]]);
  assert.deepStrictEqual(vpCondition(x, 5, 3), { bear: false, bull: false });
});

test("volume ต่อช่อง = volume TF ย่อย × สัดส่วนที่ทับช่อง, แท่ง high==low ได้ 0", () => {
  // กรอบ 10..6 แบ่ง 4 ช่อง (10-9, 9-8, 8-7, 7-6); แท่งย่อย 10..8 vol 100 -> 50/50/0/0
  assert.deepStrictEqual(vpVolumes(10, 6, 4, [[10, 8, 100]]), [50, 50, 0, 0]);
  assert.deepStrictEqual(vpVolumes(10, 6, 4, [[9, 9, 100]]), [0, 0, 0, 0]);
});

test("สร้าง OB จากแท่ง[tuning-1] เฉพาะแท่งที่ปิดแล้ว; ไม่มีข้อมูล TF ย่อย = ไม่แสดงแต่นับ", () => {
  const b = mk([[5, 5], [5, 5], [5, 5], [7, 8], [8, 7], [7, 6], [6, 6.5], [6.5, 6.6]], [null, null, null, [10, 6]]);
  const st = vpCalc(b, cfg());
  assert.strictEqual(st.blocks.length, 1);
  const blk = st.blocks[0];
  assert.deepStrictEqual([blk.dir, blk.leftIdx, blk.top, blk.bot], ["Bear", 3, 10, 6]);
  assert.strictEqual(blk.rightTime, b.at(-1).timestamp);
  const st2 = vpCalc(b, cfg({ __ltfGet: () => null }));
  assert.deepStrictEqual([st2.blocks.length, st2.missing], [0, 1]);
  const st3 = vpCalc(b, cfg({ __ltfGet: () => undefined }));
  assert.deepStrictEqual([st3.blocks.length, st3.pending], [0, 1]);
});

test("แท่งล่าสุด (ยังไม่ปิด) ไม่สร้าง OB", () => {
  const b = mk([[5, 5], [5, 5], [5, 5], [7, 8], [8, 7], [7, 6]]);
  assert.strictEqual(vpCalc(b, cfg()).blocks.length, 0);
});

test("mitigation Bear: close > bot + 100% ของกรอบ = ลบ (แท่งปิดแล้วเท่านั้น)", () => {
  const base = [[5, 5], [5, 5], [5, 5], [7, 8], [8, 7], [7, 6], [6, 6.5]];
  const b = mk([...base, [9, 10.5], [10, 10]], [null, null, null, [10, 6]]);
  // (แท่ง 5 ลง → 6,7 ขึ้น เกิด bull OB ใหม่ที่แท่ง 5 ด้วย — ถูกตามต้นฉบับ จึงนับเฉพาะ Bear)
  assert.strictEqual(vpCalc(b, cfg()).blocks.filter((x) => x.dir === "Bear").length, 0);
  const keep = mk([...base, [9, 9.9], [10, 10]], [null, null, null, [10, 6]]);
  assert.strictEqual(vpCalc(keep, cfg()).blocks.filter((x) => x.dir === "Bear").length, 1);
  // Wick 50%: high > 6 + 2 = 8 -> ลบ
  const w = mk([...base, [7, 7.5], [7, 7]], [null, null, null, [10, 6], null, null, null, [8.5, 7]]);
  assert.strictEqual(vpCalc(w, cfg({ mitigationMethod: "Wick Engulfs 50% Of Order Block" })).blocks.filter((x) => x.dir === "Bear").length, 0);
});

test("🔴 บั๊กต้นฉบับ 25% = 0.25 หน่วยราคา (ไม่ใช่ 25% ของกรอบ)", () => {
  // bear bot 6: break ถ้า close > 6.25 (ถ้าเป็น 25% จริงจะเป็น 7)
  const b = mk([[5, 5], [5, 5], [5, 5], [7, 8], [8, 7], [7, 6], [6, 6.1], [6.2, 6.3], [6, 6]], [null, null, null, [10, 6]]);
  assert.strictEqual(vpCalc(b, cfg({ mitigationMethod: "Close Engulfs 25% Of Order Block" })).blocks.filter((x) => x.dir === "Bear").length, 0);
});

test("สีไล่ระดับแบบ color.from_gradient", () => {
  const lo = { c: "#000000", t: 0 }, hi = { c: "#ffffff", t: 100 };
  assert.strictEqual(vpGradient(0, 0, 10, lo, hi), "rgba(0,0,0,1.000)");
  assert.strictEqual(vpGradient(5, 0, 10, lo, hi), "rgba(128,128,128,0.500)");
});

test("inputs ครบ 7 ตัวตามต้นฉบับ + mitigation 8 แบบ", () => {
  assert.strictEqual(VP_DEF.inputs.length, 7);
  assert.strictEqual(VP_DEF.inputs[2].options.length, 8);
});

test("alert events ณ แท่งสุดท้าย: new bear OB + touch โซน volume สูงสุด", () => {
  // OB bear ที่แท่ง 3 (กรอบ 10..6) ยืนยันที่แท่ง 5; ส่งเฉพาะแท่งที่ปิดแล้ว (__allConfirmed)
  const b = mk([[5, 5], [5, 5], [5, 5], [7, 8], [8, 7], [7, 6]], [null, null, null, [10, 6]]);
  const st = vpCalc(b, cfg({ __allConfirmed: true, __ltfGet: () => [[10, 9, 100], [9, 6, 10]] }));
  assert.deepStrictEqual(st.events.new_bear, { top: 10, bot: 6 });
  assert.strictEqual(st.events.new_bull, null);
  // ช่อง volume สูงสุด = 10..9 ; close แท่งสุดท้าย 6 ไม่อยู่ในโซน -> ไม่ touch
  assert.strictEqual(st.events.bear_touch, null);
  const st2 = vpCalc(mk([[5, 5], [5, 5], [5, 5], [7, 8], [8, 7], [7, 6], [6, 6], [9.2, 9.5]], [null, null, null, [10, 6]]),
    cfg({ __allConfirmed: true, __ltfGet: () => [[10, 9, 100], [9, 6, 10]] }));
  assert.deepStrictEqual(st2.events.bear_touch, { top: 10, bot: 9 });
  assert.ok(st2.events.new_bull);   // แท่ง 5 ลง -> 6,7 ขึ้น = bull OB ใหม่ในแท่งเดียวกัน
});
