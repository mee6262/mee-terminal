// node --test tests/js/*.js   — ตรรกะ Liquidity Zones เทียบกับพฤติกรรม Pine ต้นฉบับ
const test = require("node:test");
const assert = require("node:assert");
const { lzCalc, lzPivot, lzFormatVol, LZ_DEF } = require("../../static/indicators/liquidity_zones.js");

const cfg = (o = {}) => ({ ...Object.fromEntries(LZ_DEF.inputs.map((i) => [i.key, i.default])), leftLen: 2, rightLen: 1, ...o });
// สร้างแท่งจาก high/low (open/close กลาง ๆ)
const bars = (hl) => hl.map(([h, l], i) => ({ timestamp: i, open: (h + l) / 2, close: (h + l) / 2, high: h, low: l, volume: 100 + i }));

// สองยอดเท่ากันที่ index 2 และ 6 (left 2 / right 1) -> EQH ยืนยันที่แท่ง 7
const eqh = [[10, 9], [11, 9], [15, 9], [11, 9], [10, 9], [11, 9], [15.001, 9], [12, 9], [12, 9]];

test("pivot high ต้องสูงกว่าซ้าย left แท่งและไม่ต่ำกว่าขวา right แท่ง", () => {
  const b = bars(eqh);
  assert.strictEqual(lzPivot(b, 3, 2, 1, true), 15);       // ยืนยันที่ 3 (center 2)
  assert.strictEqual(lzPivot(b, 2, 2, 1, true), null);     // center 1 ไม่ใช่ pivot
  assert.strictEqual(lzPivot(b, 1, 2, 1, true), null);     // ซ้ายไม่พอ
});

test("EQH: สร้างโซนตอนยืนยัน pivot ที่สอง กรอบจาก pivot แรกถึงแท่งปัจจุบัน ยังไม่ sweep", () => {
  const st = lzCalc(bars(eqh), cfg());
  assert.strictEqual(st.zones.length, 1);
  const z = st.zones[0];
  assert.deepStrictEqual([z.isHigh, z.left, z.createdIdx, z.right, z.top, z.bottom], [true, 2, 7, 8, 15.001, 15]);
  assert.strictEqual(z.swept, false);
  assert.strictEqual(z.totalVol, 102 + 106);
  assert.strictEqual(z.text, "EQH (208)");
});

test("sweep เริ่มเช็คแท่งหลังสร้าง: high > top -> Swept EQH, หยุดยืดขวา", () => {
  const st = lzCalc(bars([...eqh, [15.2, 9], [16, 9]]), cfg());
  const z = st.zones[0];
  assert.strictEqual(z.swept, true);
  assert.strictEqual(z.sweptIdx, 9);
  assert.strictEqual(z.right, 9);
  assert.strictEqual(z.text, "Swept EQH (208)");
});

test("แท่งที่สร้างโซนเอง ทะลุ top ไม่นับเป็น sweep", () => {
  const b = bars(eqh);
  b[7].high = 20;   // แท่งยืนยัน (right=1) สูงกว่า top — ต้นฉบับเช็คตั้งแต่ bar_index > createdIdx
  b[6].high = 15.001;
  const st = lzCalc(b, cfg());
  // แท่ง 7 สูงกว่า pivot 6 -> pivot 6 ไม่เกิด (ขวาต้องไม่สูงกว่า) จึงไม่มีโซน
  assert.strictEqual(st.zones.length, 0);
});

test("ห่างเกิน threshold -> ไม่มีโซน", () => {
  const b = bars(eqh.map(([h, l], i) => (i === 6 ? [15.1, l] : [h, l])));
  assert.strictEqual(lzCalc(b, cfg()).zones.length, 0);
});

test("deleteOnSweep ลบโซนที่ถูก sweep", () => {
  const st = lzCalc(bars([...eqh, [16, 9]]), cfg({ deleteOnSweep: true }));
  assert.strictEqual(st.zones.length, 0);
});

test("EQL ฝั่งต่ำ + showVolume ปิด", () => {
  const low = eqh.map(([h, l]) => [30 - l, 30 - h]);   // กลับด้าน
  const st = lzCalc(bars(low), cfg({ showVolume: false }));
  assert.strictEqual(st.zones.length, 1);
  assert.strictEqual(st.zones[0].isHigh, false);
  assert.strictEqual(st.zones[0].text, "EQL");
  assert.strictEqual(st.zones[0].labelIds.length, 3);
});

test("รวม label โซนที่อยู่ใกล้กัน (≤ threshold×3) เป็น Nx", () => {
  // ยอด 15 สามครั้ง -> โซน (2,6) และ (6,10) ระดับเดียวกัน
  const hl = [[10, 9], [11, 9], [15, 9], [11, 9], [10, 9], [11, 9], [15, 9], [11, 9], [10, 9], [11, 9], [15, 9], [12, 9], [12, 9]];
  const st = lzCalc(bars(hl), cfg());
  assert.strictEqual(st.zones.length, 2);
  assert.strictEqual(st.zones[0].text, "2x EQH (424)");
  assert.strictEqual(st.zones[1].text, "");
});

test("maxZones: โซนเกินถูกเลิกติดตาม (ค้างรูปเดิม ไม่ถูก sweep ทีหลัง)", () => {
  const hl = [[10, 9], [11, 9], [15, 9], [11, 9], [10, 9], [11, 9], [15, 9], [11, 9], [10, 9], [11, 9], [15, 9], [12, 9], [12, 9], [20, 9]];
  const st = lzCalc(bars(hl), cfg({ maxZones: 1 }));
  assert.strictEqual(st.zones[0].swept, false);     // หลุดการติดตามก่อนแท่ง 13
  assert.strictEqual(st.zones[1].swept, true);
});

test("format volume แบบ Pine (#.#K / #.#M)", () => {
  assert.strictEqual(lzFormatVol(950), "950");
  assert.strictEqual(lzFormatVol(1000), "1K");
  assert.strictEqual(lzFormatVol(1250), "1.3K");
  assert.strictEqual(lzFormatVol(2500000), "2.5M");
});

test("inputs ครบ 11 ตัวตามต้นฉบับ", () => {
  assert.strictEqual(LZ_DEF.inputs.length, 11);
});

test("alert events: new EQH ที่แท่งยืนยัน และ swept ที่แท่ง sweep", () => {
  const st = lzCalc(bars(eqh.slice(0, 8)), cfg());      // แท่ง 7 = แท่งยืนยัน
  assert.ok(st.events.new_eqh);
  assert.strictEqual(st.events.swept_eqh, null);
  const st2 = lzCalc(bars([...eqh, [15.2, 9]]), cfg());
  assert.ok(st2.events.swept_eqh);
  assert.strictEqual(st2.events.new_eqh, null);
});
