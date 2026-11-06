// Mee Terminal — หน้าตั้งค่า: แสดงบนกราฟ / ปฏิทินข่าว / การเทรด / แท็ก journal / การแจ้งเตือน / ธีม
// เก็บใน prefs "wt.settings" (sync ทุกเครื่อง, ตัวส่งแจ้งเตือนบน VPS อ่านส่วน news/cal ด้วย)
// โหลดใน <head>: ตั้งธีมก่อนหน้าเว็บวาด (กันจอกระพริบ) — ฟังก์ชันอื่นถูกเรียกหลัง app.js โหลดแล้ว
"use strict";

const SETTINGS_DEFAULTS = {
  chart: { grid: true, tpsl: true, news: true, lineAlpha: 100, pdhl: false, pwhl: false },
  cal: { High: true, Medium: false, Low: false },
  news: { alertMin: 15, scope: "watch", warnTrade: true, warnMin: 15 },
  tags: ["ตามแผน", "ผิดแผน", "FOMO", "ไล่ราคา", "เข้าเร็วไป", "ออกเร็วไป", "ปล่อยกำไรวิ่ง", "ข่าว", "ทดสอบ"],
  theme: "dark",
  ui: "glass",        // glass = Liquid Glass, classic = หน้าตาเดิม
  uiLite: false,      // ปิดเบลอกระจก (เครื่องช้า)
};
const THEME_MQ = window.matchMedia("(prefers-color-scheme: light)");

function settingsAll() {
  const raw = (typeof store === "function" ? store("wt.settings", null) : null)
    || (() => { try { return JSON.parse(localStorage.getItem("wt.settings")); } catch (_) { return null; } })() || {};
  const out = {};
  for (const [k, v] of Object.entries(SETTINGS_DEFAULTS)) {
    out[k] = v && typeof v === "object" && !Array.isArray(v) ? { ...v, ...(raw[k] || {}) } : raw[k] ?? v;
  }
  return out;
}

// setting("chart.grid") -> true
function setting(path) {
  return path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), settingsAll());
}

function setSetting(path, value) {
  const all = settingsAll();
  const keys = path.split(".");
  let o = all;
  for (const k of keys.slice(0, -1)) o = o[k] = { ...(o[k] || {}) };
  o[keys.at(-1)] = value;
  save("wt.settings", all);
  applySettings();
}

// ---------- ธีม ----------
function themeIsLight() {
  const t = setting("theme");
  return t === "light" || (t === "system" && THEME_MQ.matches);
}

function applyTheme() {
  const light = themeIsLight();
  document.documentElement.dataset.theme = light ? "light" : "dark";
  document.documentElement.classList.toggle("glass", setting("ui") !== "classic");
  document.documentElement.classList.toggle("glass-lite", !!setting("uiLite"));
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", light ? "#ffffff" : "#0f1115");
}
applyTheme();
THEME_MQ.addEventListener?.("change", () => { if (setting("theme") === "system") applySettings(); });

const LIGHT_STYLES = {
  grid: { horizontal: { color: "#eef0f3" }, vertical: { color: "#eef0f3" } },
  candle: {
    tooltip: { text: { color: "#3b4252" } },
    priceMark: { high: { color: "#3b4252" }, low: { color: "#3b4252" } },
  },
  indicator: { tooltip: { text: { color: "#3b4252" } } },
  xAxis: { axisLine: { color: "#d8dce3" }, tickLine: { color: "#d8dce3" }, tickText: { color: "#6b7280" } },
  yAxis: { axisLine: { color: "#d8dce3" }, tickLine: { color: "#d8dce3" }, tickText: { color: "#6b7280" } },
  separator: { color: "#d8dce3" },
  crosshair: {
    horizontal: { line: { color: "#9aa1ad" }, text: { backgroundColor: "#4b5563", borderColor: "#4b5563" } },
    vertical: { line: { color: "#9aa1ad" }, text: { backgroundColor: "#4b5563", borderColor: "#4b5563" } },
  },
};

// สไตล์กราฟตามธีม + เส้นตาราง (ChartPanel ใช้ตอนสร้าง และ applySettings ใช้ตอนเปลี่ยน)
function chartStyles() {
  const merge = (a, b) => {
    const o = { ...a };
    for (const [k, v] of Object.entries(b || {})) o[k] = v && typeof v === "object" && !Array.isArray(v) ? merge(a?.[k] || {}, v) : v;
    return o;
  };
  const base = themeIsLight() ? merge(DARK_STYLES, LIGHT_STYLES) : DARK_STYLES;
  const extra = { grid: { show: setting("chart.grid") !== false } };
  if (isTouchUI()) {
    // จอสัมผัส: จุดปรับตำแหน่งวัตถุใหญ่แบบ TradingView (วงแหวนน้ำเงินไส้สีพื้น) — วงนอก radius+border = พื้นที่แตะ
    const fill = themeIsLight() ? "#ffffff" : "#0f1115";
    extra.overlay = { point: { color: fill, borderColor: "#2962ff", borderSize: 3, radius: 10,
      activeColor: fill, activeBorderColor: "#2962ff", activeBorderSize: 4, activeRadius: 11 } };
  }
  return merge(base, extra);
}

// จอสัมผัสเป็นหลัก (มือถือ/แท็บเล็ต)
function isTouchUI() {
  return !!(window.matchMedia && window.matchMedia("(pointer: coarse)").matches);
}

function applySettings() {
  applyTheme();
  if (typeof state === "undefined" || !state.charts) return;
  const st = chartStyles();
  for (const p of state.charts.panels) {
    p.chart.setStyles(st);
    if (typeof applyNewsLines === "function") applyNewsLines(p);
    if (typeof applyLevels === "function") applyLevels(p);
  }
  syncLines();
}

// ---------- หน้าตั้งค่า ----------
function openSettings() {
  const dlg = document.getElementById("modal");
  openDialog("⚙️ การตั้งค่า", (form, close) => {
    form.classList.add("settings-page");
    const done = () => { form.classList.remove("settings-page"); close(); };
    dlg.oncancel = (e) => { e.preventDefault(); done(); };
    // ไปหน้าต่างอื่น (Auto BE, preset ...) จากหน้านี้
    const go = (fn) => () => { form.classList.remove("settings-page"); fn(); };
    const sec = (title, ...kids) => form.append(mkx("section", { className: "set-sec" }, mkx("div", { className: "set-title", textContent: title }), ...kids));
    const check = (label, path, hint) => {
      const cb = mkx("input", { type: "checkbox", checked: setting(path) !== false });
      cb.onchange = () => setSetting(path, cb.checked);
      return mkx("label", { className: "set-row chk" }, cb, mkx("span", {}, label, hint ? mkx("small", { className: "muted", textContent: hint }) : ""));
    };
    const select = (label, path, options, conv = (v) => v) => {
      const sel = mkx("select", {}, ...options.map(([v, t]) => mkx("option", { value: String(v), textContent: t })));
      sel.value = String(setting(path));
      sel.onchange = () => setSetting(path, conv(sel.value));
      return mkx("label", { className: "set-row" }, mkx("span", { textContent: label }), sel);
    };
    const btn = (text, fn) => { const b = mkx("button", { type: "button", className: "btn-ghost", textContent: text }); b.onclick = fn; return b; };

    sec("แสดงบนกราฟ",
      check("เส้นตารางบนกราฟ", "chart.grid"),
      check("เส้น TP / SL", "chart.tpsl", "ของ position และ pending"),
      select("ความทึบเส้น/ป้ายออเดอร์ (position, limit, stop, TP, SL)", "chart.lineAlpha",
        [100, 85, 70, 55, 40, 25].map((v) => [v, v === 100 ? "100% (ทึบ)" : `${v}%`]), Number),
      check("เส้นข่าวเศรษฐกิจ", "chart.news", "เส้นแนวตั้งตรงเวลาข่าว ตามระดับผลกระทบด้านล่าง"),
      check("เส้น High / Low วันก่อน (PDH / PDL)", "chart.pdhl", "จากแท่ง D1 ของโบรก"),
      check("เส้น High / Low สัปดาห์ก่อน (PWH / PWL)", "chart.pwhl", "จากแท่ง W1 ของโบรก"));

    sec("ปฏิทินทางเศรษฐกิจ",
      mkx("div", { className: "muted small set-hint", textContent: "ระดับที่เลือกใช้กับ เส้นบนกราฟ · แจ้งเตือนล่วงหน้า · คำเตือนก่อนส่งคำสั่ง" }),
      check("🔴 ผลกระทบสูง", "cal.High"), check("🟠 ผลกระทบกลาง", "cal.Medium"), check("🟡 ผลกระทบต่ำ", "cal.Low"),
      select("แจ้งเตือนล่วงหน้า (Telegram/Push)", "news.alertMin", [[0, "ปิด"], [5, "5 นาที"], [10, "10 นาที"], [15, "15 นาที"], [30, "30 นาที"], [60, "1 ชั่วโมง"]], Number),
      select("สกุลที่แจ้ง", "news.scope", [["watch", "สกุลใน watchlist"], ["held", "สกุลที่มีไม้/pending"], ["all", "ทุกสกุล"]]),
      check("เตือนก่อนส่งคำสั่ง ถ้าใกล้ข่าวของ symbol นั้น", "news.warnTrade"),
      select("ใกล้ข่าว = ภายใน", "news.warnMin", [[5, "5 นาที"], [10, "10 นาที"], [15, "15 นาที"], [30, "30 นาที"], [60, "1 ชั่วโมง"]], Number));

    const confirmCb = mkx("input", { type: "checkbox", checked: confirmOn() });
    confirmCb.onchange = () => { save(`wt.confirm.${state.acct}`, confirmCb.checked); const t = document.getElementById("tk-confirm"); if (t) t.checked = confirmCb.checked; };
    sec("การเทรด",
      mkx("label", { className: "set-row chk" }, confirmCb, mkx("span", {}, "ยืนยันก่อนส่งคำสั่ง", mkx("small", { className: "muted", textContent: `บัญชี ${state.acct}` }))),
      mkx("div", { className: "set-btns" }, btn("🛡 Auto BE", go(openAutoBE)), btn("⚡ SL/TP preset", go(openPresetManager)), btn("⌨️ คีย์ลัด", go(showHotkeys))));

    // แท็ก journal: เพิ่ม/ลบ แตะเลือกได้ในหน้าบันทึกไม้
    const chips = mkx("div", { className: "tag-chips" });
    const paintTags = () => {
      chips.replaceChildren(...setting("tags").map((t) => {
        const x = mkx("button", { type: "button", className: "tag-x", textContent: "✕", title: "ลบ" });
        x.onclick = () => { setSetting("tags", setting("tags").filter((v) => v !== t)); paintTags(); };
        return mkx("span", { className: "tag-chip on" }, t, x);
      }));
    };
    const tagIn = mkx("input", { type: "text", placeholder: "แท็กใหม่ เช่น London, OB", maxLength: 30 });
    const addTag = () => {
      const v = tagIn.value.trim().replace(/,/g, " ");
      if (!v) return;
      if (!setting("tags").includes(v)) setSetting("tags", [...setting("tags"), v].slice(0, 40));
      tagIn.value = ""; paintTags(); tagIn.focus();
    };
    tagIn.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); addTag(); } };
    paintTags();
    sec("แท็กบันทึกไม้ (Journal)", chips,
      mkx("div", { className: "row tag-add" }, tagIn, btn("เพิ่ม", addTag)),
      mkx("div", { className: "set-btns" }, btn("ค่าเริ่มต้น", () => { setSetting("tags", [...SETTINGS_DEFAULTS.tags]); paintTags(); })));

    const notif = mkx("div");
    notifySection(notif);
    sec("การแจ้งเตือน", ...notif.childNodes,
      mkx("div", { className: "set-btns" }, btn("🔔 Telegram / แจ้งเตือนเครื่องนี้", go(openAlertManager)), btn("🩺 สถานะระบบ", go(openHealth))));

    sec("บัญชี MT5",
      mkx("div", { className: "muted small set-hint", textContent: "เพิ่ม / แก้ / ลบบัญชี — กำหนด path ของ MT5 แต่ละตัว ระบบตรวจเองว่าเป็นบัญชีอะไร" }),
      mkx("div", { className: "set-btns" }, btn("🏦 จัดการบัญชี", go(openAccountManager))));

    sec("การแสดงผล", select("ธีม", "theme", [["light", "☀️ โหมดสว่าง"], ["dark", "🌙 โหมดมืด"], ["system", "📱 ตามการตั้งค่าอุปกรณ์"]]),
      select("หน้าตา", "ui", [["glass", "Liquid Glass (ใหม่)"], ["classic", "แบบเดิม"]]),
      select("เอฟเฟกต์กระจก", "uiLite", [[false, "เต็ม (เบลอ)"], [true, "ลดเอฟเฟกต์ (เครื่องช้า)"]], (v) => v === "true"));

    const ok = mkx("button", { type: "button", className: "btn-primary", textContent: "ปิด" });
    ok.onclick = done;
    form.append(mkx("div", { className: "modal-btns" }, ok));
  });
}
