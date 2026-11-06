// Market Sessions & TPO: เวลา NY, กรอบ session, pre/post, TPO/POC, forecast
const test = require("node:test");
const assert = require("node:assert");
const { stCalc, stIn, stNyMinutes, stLeftmost, stRightmost, stFmtVol, ST_DEF } = require("../../static/indicators/sessions_tpo.js");

const cfg = (o = {}) => ({ ...Object.fromEntries(ST_DEF.inputs.map((i) => [i.key, i.default])), __ctx: { tf: "M5" }, ...o });
// M5 ต่อเนื่อง 3 วัน เริ่ม 2026-09-21 00:00 UTC (NY = EDT, UTC-4) ราคาแกว่งแบบ sine
function mkBars(days = 3, tf = 5) {
  const t0 = Date.UTC(2026, 8, 21, 0, 0);
  const out = [];
  for (let k = 0; k < (days * 1440) / tf; k++) {
    const t = t0 + k * tf * 60000, base = 100 + 5 * Math.sin(k / 40) + 0.5 * Math.sin(k / 3);
    const o = base, c = base + 0.2 * Math.sin(k / 2);
    out.push({ timestamp: t, open: o, close: c, high: Math.max(o, c) + 0.3, low: Math.min(o, c) - 0.3, volume: 100 });
  }
  return out;
}

test("เวลา New York รวม DST + ช่วง session ข้ามเที่ยงคืน", () => {
  assert.strictEqual(stNyMinutes(Date.UTC(2026, 8, 21, 13, 30)), 9 * 60 + 30);   // EDT
  assert.strictEqual(stNyMinutes(Date.UTC(2026, 0, 5, 14, 30)), 9 * 60 + 30);    // EST
  assert.ok(stIn("0930-1601", 570) && !stIn("0930-1601", 961) && stIn("0930-1601", 960));
  assert.ok(stIn("2000-0501", 1300) && stIn("2000-0501", 100) && !stIn("2000-0501", 301));
});

test("binary search แบบ Pine", () => {
  const a = [1, 2, 3, 4];
  assert.deepStrictEqual([stLeftmost(a, 2.5), stRightmost(a, 2.5), stLeftmost(a, 3), stRightmost(a, 3)], [1, 2, 2, 2]);
});

test("กรอบ NY/London/Asia + pre/post + ข้อความ", () => {
  const st = stCalc(mkBars(), cfg());
  const titles = st.rows.map((r) => r.label.text.split("\n")[0]);
  assert.ok(titles.includes("New York") && titles.includes("London") && titles.includes("Asia"));
  const ny = st.rows.find((r) => r.label.text.startsWith("New York"));
  assert.ok(ny.pre && ny.post, "NY มี pre และ post");
  assert.match(ny.label.text, /Range: [\d.]+%\nVol: [\d.]+K?\n∆: /);
  assert.ok(ny.top >= ny.post.top - 1e-9 && ny.top === ny.pre.top, "post ขยายกรอบ session/pre");
  assert.ok(!/OI/.test(ny.label.text), "ตัด OI");
});

test("TPO profile + naked POC ตอนจบ session", () => {
  const st = stCalc(mkBars(), cfg());
  assert.ok(st.profiles.length >= 3);
  const p = st.profiles[0];
  assert.strictEqual(p.items.length, 20);                       // Bars: ชั้น 1..20
  assert.strictEqual(p.items.filter((x) => x.color === "#6929F2").length, 1);
  assert.ok(st.pocs.length >= 1);
  const letters = stCalc(mkBars(), cfg({ profileType: "Letters" })).profiles[0];
  assert.strictEqual(letters.items.length, 21);
  assert.ok(letters.items.some((x) => /A/.test(x.text)));
});

test("Forecast ฉายเฉพาะตอนอยู่ใน session", () => {
  const all = mkBars();
  // ตัดให้แท่งสุดท้ายอยู่กลาง NY วันที่ 3 (NY 12:00 = 16:00 UTC)
  const cut = all.filter((b) => b.timestamp <= Date.UTC(2026, 8, 23, 16, 0));
  const st = stCalc(cut, cfg());
  const ny = st.proj.find((p) => p.col === "#6929F2");
  assert.ok(ny && ny.boxes.length > 1);
  const line = stCalc(cut, cfg({ proj: "Line" })).proj.find((p) => p.col === "#6929F2");
  assert.ok(line.line.length > 1);
  assert.strictEqual(stCalc(cut, cfg({ proj: "None" })).proj.length, 0);
});

test("TF ไม่รองรับ (D1) = แจ้งเตือนแทน", () => {
  assert.ok(stCalc(mkBars(1), cfg({ __ctx: { tf: "D1" } })).unsupported);
});

test("ปิด session / format volume / inputs 15 ตัว", () => {
  const st = stCalc(mkBars(), cfg({ showAS: false }));
  assert.ok(!st.rows.some((r) => r.label.text.startsWith("Asia")));
  assert.strictEqual(stFmtVol(12345), "12.345K");
  assert.strictEqual(stFmtVol(-1500000), "-1.5M");
  assert.strictEqual(ST_DEF.inputs.length, 15);
});
