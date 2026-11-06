// Mee Terminal — สถิติเชิงลึกหน้าประวัติเทรด: แยก symbol / ฝั่ง / ชั่วโมง / วัน / ระยะถือ + การกระจายกำไร + สตรีค
// ใช้ไม้ที่ปิดครบแล้วในช่วง+ตัวกรองที่เลือกอยู่ เวลาเป็นเวลาไทย (ตอนเปิดไม้)
"use strict";

const TH_DAYS = ["อา", "จ", "อ", "พ", "พฤ", "ศ", "ส"];
const HOLD_BUCKETS = [[300, "<5น."], [1800, "5–30น."], [7200, "30น.–2ชม."], [28800, "2–8ชม."], [86400, "8–24ชม."], [Infinity, ">1วัน"]];

function thParts(tSec) {
  const d = new Date((tSec + 7 * 3600) * 1000);   // เวลาไทย = UTC+7 (ไม่มี DST)
  return { hour: d.getUTCHours(), dow: d.getUTCDay() };
}

function groupBy(trades, keyFn, order) {
  const m = new Map();
  for (const t of trades) {
    const k = keyFn(t);
    const g = m.get(k) || { key: k, n: 0, net: 0, wins: 0, losses: 0 };
    g.n++; g.net += t.net;
    if (t.net > 0) g.wins++; else if (t.net < 0) g.losses++;
    m.set(k, g);
  }
  const rows = [...m.values()];
  if (order) rows.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
  else rows.sort((a, b) => b.net - a.net);
  return rows;
}

function deepStats(trades) {
  const closed = trades.filter((t) => t.closed && t.time_open && t.time_close).sort((a, b) => a.time_close - b.time_close);
  const grossWin = closed.filter((t) => t.net > 0).reduce((a, t) => a + t.net, 0);
  const grossLoss = -closed.filter((t) => t.net < 0).reduce((a, t) => a + t.net, 0);
  let run = 0, bestRun = 0, worstRun = 0;
  for (const t of closed) {
    run = t.net > 0 ? (run > 0 ? run + 1 : 1) : t.net < 0 ? (run < 0 ? run - 1 : -1) : 0;
    bestRun = Math.max(bestRun, run); worstRun = Math.min(worstRun, run);
  }
  const hours = Array.from({ length: 24 }, (_, h) => ({ key: h, n: 0, net: 0 }));
  const days = Array.from({ length: 7 }, (_, d) => ({ key: d, n: 0, net: 0 }));
  for (const t of closed) {
    const p = thParts(t.time_open);
    hours[p.hour].n++; hours[p.hour].net += t.net;
    days[p.dow].n++; days[p.dow].net += t.net;
  }
  const holdLabel = (t) => HOLD_BUCKETS.find(([s]) => t.time_close - t.time_open < s)[1];
  // การกระจายกำไรต่อไม้: 12 ช่องเท่ากันระหว่างต่ำสุด-สูงสุด
  let bins = [];
  if (closed.length) {
    const lo = Math.min(...closed.map((t) => t.net)), hi = Math.max(...closed.map((t) => t.net));
    const k = 12, w = (hi - lo) / k || 1;
    bins = Array.from({ length: k }, (_, i) => ({ from: lo + i * w, to: lo + (i + 1) * w, n: 0 }));
    for (const t of closed) bins[Math.min(k - 1, Math.floor((t.net - lo) / w))].n++;
  }
  return {
    n: closed.length,
    pf: grossLoss > 0 ? grossWin / grossLoss : null,
    expectancy: closed.length ? closed.reduce((a, t) => a + t.net, 0) / closed.length : 0,
    bestRun, worstRun,
    bySymbol: groupBy(closed, (t) => t.symbol),
    // ไม้หนึ่งมีได้หลายแท็ก -> นับในทุกแท็กของมัน
    byTag: groupBy(closed.flatMap((t) => { const tg = hist.journal?.[String(t.position_id)]?.tags || []; return (tg.length ? tg : ["(ไม่มีแท็ก)"]).map((k) => ({ ...t, _tag: k })); }), (t) => t._tag),
    bySide: groupBy(closed, (t) => (t.side === "buy" ? "BUY" : "SELL"), ["BUY", "SELL"]),
    byHold: groupBy(closed, holdLabel, HOLD_BUCKETS.map((b) => b[1])),
    hours, days, bins,
  };
}

function renderDeepStats(trades) {
  const box = document.getElementById("hist-deep");
  if (!box) return;
  const s = deepStats(trades);
  const cur = hist.data?.currency || "";
  const m2 = (v) => `${v >= 0 ? "+" : ""}${fmt(v)}`;
  box.replaceChildren();
  if (!s.n) { box.append(mkx("div", { className: "muted small", textContent: "ยังไม่มีไม้ที่ปิดครบในช่วงนี้" })); return; }

  const kpi = mkx("div", { className: "deep-kpi" });
  for (const [k, v, c] of [["Profit factor", s.pf == null ? "∞" : s.pf.toFixed(2), s.pf == null || s.pf >= 1 ? "up" : "down"],
    ["เฉลี่ยต่อไม้", `${m2(s.expectancy)} ${cur}`, signCls(s.expectancy)],
    ["ได้ติดกันสูงสุด", `${s.bestRun} ไม้`, "up"], ["เสียติดกันสูงสุด", `${-s.worstRun} ไม้`, "down"]]) {
    kpi.append(mkx("div", {}, mkx("span", { className: "muted", textContent: k }), mkx("b", { className: c, textContent: v })));
  }
  box.append(kpi);

  const table = (title, rows, labelFn = (r) => r.key) => {
    const t = mkx("table", { className: "tbl deep-tbl" });
    const head = mkx("tr");
    for (const h of [title, "ไม้", "สุทธิ", "เฉลี่ย/ไม้", "ได้ / เสีย"]) head.append(mkx("th", { textContent: h, className: h === title ? "" : "r" }));
    t.append(mkx("thead", {}, head));
    const body = mkx("tbody");
    for (const r of rows) {
      body.append(mkx("tr", {}, mkx("td", { textContent: labelFn(r) }), mkx("td", { className: "r", textContent: String(r.n) }),
        mkx("td", { className: "r " + signCls(r.net), textContent: m2(r.net) }), mkx("td", { className: "r " + signCls(r.net), textContent: m2(r.net / r.n) }),
        mkx("td", { className: "r muted", textContent: `${r.wins} / ${r.losses}` })));
    }
    t.append(body);
    return mkx("div", { className: "deep-card" }, t);
  };

  // แท่งบวก/ลบรอบเส้นศูนย์ (ชั่วโมง / วัน)
  const bars = (title, rows, labelFn) => {
    const max = Math.max(1e-9, ...rows.map((r) => Math.abs(r.net)));
    const wrap = mkx("div", { className: "deep-bars" });
    for (const r of rows) {
      const hPct = (Math.abs(r.net) / max) * 100;
      const col = mkx("div", { className: "db-col", title: `${labelFn(r)} · ${r.n} ไม้ · ${m2(r.net)} ${cur}` });
      const up = mkx("div", { className: "db-half up" }), dn = mkx("div", { className: "db-half dn" });
      const bar = mkx("i", { className: r.net >= 0 ? "pos" : "neg" });
      bar.style.height = `${r.n ? Math.max(hPct, 2) : 0}%`;
      (r.net >= 0 ? up : dn).append(bar);
      col.append(up, dn, mkx("span", { className: "db-lbl", textContent: labelFn(r) }));
      wrap.append(col);
    }
    return mkx("div", { className: "deep-card" }, mkx("div", { className: "deep-title", textContent: title }), wrap);
  };

  const hist2 = () => {
    const max = Math.max(1, ...s.bins.map((b) => b.n));
    const wrap = mkx("div", { className: "deep-bars dist" });
    for (const b of s.bins) {
      const col = mkx("div", { className: "db-col", title: `${m2(b.from)} ถึง ${m2(b.to)} ${cur} · ${b.n} ไม้` });
      const bar = mkx("i", { className: (b.from + b.to) / 2 >= 0 ? "pos" : "neg" });
      bar.style.height = `${(b.n / max) * 100}%`;
      col.append(mkx("div", { className: "db-full" }, bar), mkx("span", { className: "db-lbl", textContent: b.n ? String(b.n) : "" }));
      wrap.append(col);
    }
    return mkx("div", { className: "deep-card" }, mkx("div", { className: "deep-title", textContent: `การกระจายกำไรต่อไม้ (${m2(s.bins[0].from)} … ${m2(s.bins.at(-1).to)} ${cur})` }), wrap);
  };

  box.append(
    bars("สุทธิตามชั่วโมงที่เปิดไม้ (เวลาไทย)", s.hours, (r) => String(r.key)),
    bars("สุทธิตามวัน", [1, 2, 3, 4, 5, 6, 0].map((d) => s.days[d]), (r) => TH_DAYS[r.key]),
    hist2(),
    table("แท็ก", s.byTag), table("Symbol", s.bySymbol), table("ฝั่ง", s.bySide), table("ระยะถือ", s.byHold));
}
