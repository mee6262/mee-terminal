// Mee Terminal — ตั้งค่าบัญชี MT5 (ตั้งค่า -> บัญชี MT5): เพิ่ม / แก้ / ลบ แล้วบันทึกลง accounts.json
// ระบบตรวจว่า terminal login บัญชีอะไร (เลขบัญชี, server, สกุล, demo/real -> cent/std) — เปิด/ปิด worker ด้วย pm2 เอง
"use strict";

const ACC_MODE = { 0: "DEMO", 1: "CONTEST", 2: "REAL" };
const accKindOf = (cur, server) => {
  const c = String(cur || "");
  return ["USC", "USc", "EUC"].includes(c) || c.toLowerCase().endsWith("cent") || String(server || "").toLowerCase().includes("cent") ? "cent" : "std";
};

async function openAccountManager() {
  let rows = [], live = {}, dirty = false;
  try {
    const r = await api("/api/admin/accounts");
    const j = await r.json();
    if (!r.ok) throw new Error(j.detail || r.status);
    rows = j.accounts.map(({ live: lv, ...a }) => { live[a.name] = lv; return a; });
  } catch (e) { toast(`โหลดรายการบัญชีไม่ได้: ${e.message}`, false); return; }

  const liveLine = (a) => {
    const lv = live[a.name];
    if (!lv) return mkx("div", { className: "muted small", textContent: "worker ไม่ได้รัน / ยังไม่ได้เปิดด้วย pm2" });
    const mode = ACC_MODE[lv.trade_mode] ?? lv.trade_mode;
    const warn = [];
    if (accKindOf(lv.currency, lv.server) !== a.kind && a.kind !== "prop") warn.push(`สกุล ${lv.currency} น่าจะเป็น ${accKindOf(lv.currency, lv.server)}`);
    if (lv.trade_mode === 2 && !a.allow_real) warn.push("REAL แต่ยังไม่อนุญาตเทรดจริง");
    if (a.login && a.login !== lv.login) warn.push(`ล็อกไว้ #${a.login} แต่ terminal เป็น #${lv.login}`);
    return mkx("div", { className: "small" },
      mkx("b", { className: `acc-mode ${mode === "REAL" ? "real" : "demo"}`, textContent: mode }), ` #${lv.login} · ${lv.server} · ${lv.currency}`,
      ...warn.map((w) => mkx("div", { className: "acc-warn", textContent: `⚠️ ${w}` })));
  };

  const list = () => openDialog("🏦 บัญชี MT5", (form, close) => {
    form.append(mkx("p", { className: "muted small", textContent: "1 บัญชี = 1 โปรแกรม MT5 (login + ติ๊กจำรหัสไว้ใน MT5) — บันทึกแล้วรันคำสั่ง pm2 ที่แสดงบน VPS" }));
    for (const a of rows) {
      const edit = mkx("button", { type: "button", className: "btn-ghost", textContent: "แก้ไข" });
      edit.onclick = () => editor(a);
      const del = mkx("button", { type: "button", className: "btn-ghost danger", textContent: "ลบ" });
      del.onclick = () => {
        if (rows.length === 1) { toast("ต้องมีอย่างน้อย 1 บัญชี", false); return; }
        if (!confirm(`ลบบัญชี ${a.name}? (ไฟล์ MT5 ไม่ถูกลบ)`)) return;
        rows = rows.filter((x) => x !== a); dirty = true; list();
      };
      form.append(mkx("div", { className: "acc-card" },
        mkx("div", { className: "acc-head" }, mkx("b", { textContent: a.name }), mkx("span", { className: "tag-chip", textContent: a.kind }),
          a.trading ? mkx("span", { className: "muted small", textContent: "เทรดได้" }) : mkx("span", { className: "muted small", textContent: "ดูอย่างเดียว" }),
          mkx("span", { className: "acc-acts" }, edit, del)),
        liveLine(a),
        mkx("div", { className: "muted small acc-path", textContent: `${a.terminal_path}${a.portable ? " (portable)" : ""} · port ${a.port || "อัตโนมัติ"}` })));
    }
    const add = mkx("button", { type: "button", className: "btn-ghost", textContent: "➕ เพิ่มบัญชี" });
    add.onclick = () => editor(null);
    const saveBtn = mkx("button", { type: "button", className: "btn-primary", textContent: "💾 บันทึก", disabled: !dirty });
    saveBtn.onclick = () => saver();
    const cls = mkx("button", { type: "button", className: "btn-ghost", textContent: dirty ? "ยกเลิก" : "ปิด" });
    cls.onclick = () => { if (!dirty || confirm("ยังไม่ได้บันทึก — ทิ้งการแก้ไข?")) close(); };
    form.append(mkx("div", { className: "modal-btns" }, add, cls, saveBtn));
  });

  const editor = (a) => openDialog(a ? `แก้ไขบัญชี ${a.name}` : "เพิ่มบัญชี", (form) => {
    const g = a?.guards || {};
    const inp = (label, value, props = {}) => {
      const i = mkx("input", { type: "text", value: value ?? "", ...props });
      form.append(mkx("label", { className: "set-row" }, mkx("span", { textContent: label }), i));
      return i;
    };
    const chk = (label, on, hint) => {
      const c = mkx("input", { type: "checkbox", checked: !!on });
      form.append(mkx("label", { className: "set-row chk" }, c, mkx("span", {}, label, hint ? mkx("small", { className: "muted", textContent: hint }) : "")));
      return c;
    };
    const name = inp("ชื่อ (a-z 0-9 _ -)", a?.name, { placeholder: "เช่น cent2", maxLength: 32, readOnly: !!a });
    const path = inp("Path terminal64.exe", a?.terminal_path, { placeholder: "C:\\Program Files\\MetaTrader 5\\terminal64.exe" });
    const portable = chk("Portable", a?.portable, "ติดตั้งแบบ portable (ทางลัดมี /portable) — ไม่ตรงจะเชื่อมไม่ได้");
    const out = mkx("div", { className: "acc-probe muted small" });
    const probe = mkx("button", { type: "button", className: "btn-ghost", textContent: "🔍 ตรวจสอบบัญชี" });
    form.append(mkx("div", { className: "set-btns" }, probe), out);
    const kind = mkx("select", {}, ...["std", "cent", "prop"].map((k) => mkx("option", { value: k, textContent: k })));
    kind.value = a?.kind || "std";
    form.append(mkx("label", { className: "set-row" }, mkx("span", { textContent: "ชนิดบัญชี" }), kind));
    const login = inp("ล็อกเลขบัญชี (ว่าง = ใช้ที่ terminal login อยู่)", a?.login, { inputMode: "numeric" });
    const trading = chk("อนุญาตส่งคำสั่งเทรดจากเว็บ", a ? a.trading : true);
    const real = chk("อนุญาตบัญชี REAL", a?.allow_real, "ต้องเปิดถ้า terminal เป็นบัญชีจริง ไม่งั้นทุกคำสั่งถูกปฏิเสธ");
    const off = inp("เวลา server - UTC (ชม.)", a?.server_utc_offset_h ?? 0, { inputMode: "decimal" });
    const magic = inp("Magic", a?.magic ?? 0, { inputMode: "numeric" });
    const dev = inp("Slippage (points)", a?.deviation ?? 20, { inputMode: "numeric" });
    form.append(mkx("div", { className: "set-title", textContent: "ตัวกันความเสี่ยง (ว่าง = ไม่จำกัด)" }));
    const maxLot = inp("Lot สูงสุดต่อไม้", g.max_lot, { inputMode: "decimal" });
    const maxPos = inp("จำนวนไม้เปิดพร้อมกันสูงสุด", g.max_positions, { inputMode: "numeric" });
    const maxRisk = inp("Risk สูงสุดต่อไม้ (%)", g.max_risk_pct, { inputMode: "decimal" });
    const dayLoss = inp("ขาดทุนต่อวันสูงสุด (%)", g.daily_loss_pct, { inputMode: "decimal" });
    const dayReset = inp("เวลาตัดวัน", g.day_reset, { placeholder: "16:59 America/New_York" });
    const reqSl = chk("ต้องมี SL ทุกไม้", g.require_sl);

    probe.onclick = async () => {
      out.textContent = "กำลังตรวจ… (terminal ที่ยังไม่เปิดจะถูกเปิด อาจใช้เวลาถึง 1 นาที)";
      probe.disabled = true;
      try {
        const r = await api("/api/admin/accounts/probe", { method: "POST", body: JSON.stringify({ terminal_path: path.value.trim(), portable: portable.checked, name: a?.name }) });
        const j = await r.json();
        if (!r.ok || !j.ok) { out.textContent = `❌ ${j.detail || j.error}`; return; }
        const mode = ACC_MODE[j.trade_mode] ?? j.mode;
        out.replaceChildren(mkx("b", { className: `acc-mode ${mode === "REAL" ? "real" : "demo"}`, textContent: mode }),
          ` #${j.login} · ${j.name || ""} · ${j.server} · ${j.currency} · 1:${j.leverage} · ยอด ${fmt(j.balance)}`,
          mkx("div", { textContent: `→ ตั้งชนิดเป็น ${j.kind} และล็อกเลขบัญชี #${j.login} ให้แล้ว${mode === "REAL" && !real.checked ? " — ⚠️ เป็นบัญชี REAL ติ๊ก \"อนุญาตบัญชี REAL\" เองถ้าจะเทรด" : ""}` }));
        if (kind.value !== "prop") kind.value = j.kind;
        login.value = j.login;
      } catch (e) { out.textContent = `❌ ${e.message}`; } finally { probe.disabled = false; }
    };

    const ok = mkx("button", { type: "button", className: "btn-primary", textContent: "ตกลง" });
    const back = mkx("button", { type: "button", className: "btn-ghost", textContent: "กลับ" });
    back.onclick = list;
    ok.onclick = () => {
      const nm = name.value.trim();
      if (!/^[a-z0-9_-]{1,32}$/.test(nm)) { toast("ชื่อใช้ได้แค่ a-z 0-9 _ -", false); return; }
      if (!a && rows.some((x) => x.name === nm)) { toast("ชื่อนี้มีแล้ว", false); return; }
      if (!/terminal64\.exe$/i.test(path.value.trim())) { toast("Path ต้องชี้ไปที่ terminal64.exe", false); return; }
      const e = {
        ...(a || {}), name: nm, terminal_path: path.value.trim(), portable: portable.checked, kind: kind.value,
        login: login.value.trim() ? Number(login.value) : null, trading: trading.checked, allow_real: real.checked,
        server_utc_offset_h: Number(off.value) || 0, magic: Number(magic.value) || 0, deviation: Number(dev.value) || 20,
        guards: { ...g, max_lot: maxLot.value.trim(), max_positions: maxPos.value.trim(), max_risk_pct: maxRisk.value.trim(),
          daily_loss_pct: dayLoss.value.trim(), day_reset: dayReset.value.trim(), require_sl: reqSl.checked },
      };
      rows = a ? rows.map((x) => (x === a ? e : x)) : [...rows, e];
      dirty = true;
      list();
    };
    form.append(mkx("div", { className: "modal-btns" }, back, ok));
  });

  const saver = () => openDialog("💾 บันทึกบัญชี", (form, close) => {
    form.append(mkx("p", { className: "small", textContent: "ใส่รหัสผ่านเว็บเพื่อยืนยัน" }));
    const pw = mkx("input", { type: "password", autocomplete: "current-password", placeholder: "รหัสผ่านเว็บ" });
    const msg = mkx("div", { className: "acc-probe small" });
    form.append(pw, msg);
    const back = mkx("button", { type: "button", className: "btn-ghost", textContent: "กลับ" });
    back.onclick = list;
    const go = mkx("button", { type: "button", className: "btn-primary", textContent: "บันทึก" });
    go.onclick = async () => {
      go.disabled = true;
      try {
        const r = await api("/api/admin/accounts", { method: "POST", body: JSON.stringify({ password: pw.value, accounts: rows }) });
        const j = await r.json();
        if (!r.ok) { msg.textContent = `❌ ${j.detail}`; return; }
        dirty = false;
        form.replaceChildren(mkx("h3", { textContent: "✅ บันทึกแล้ว (accounts.local.json)" }));
        if (j.commands.length) {
          const cmd = j.commands.join("\n");
          const copy = mkx("button", { type: "button", className: "btn-ghost", textContent: "📋 คัดลอก" });
          copy.onclick = () => navigator.clipboard?.writeText(cmd).then(() => toast("คัดลอกแล้ว"));
          form.append(mkx("p", { className: "small", textContent: "รันบน VPS ในโฟลเดอร์ web_terminal:" }),
            mkx("pre", { className: "acc-cmd", textContent: cmd }), mkx("div", { className: "set-btns" }, copy));
        } else form.append(mkx("p", { className: "muted small", textContent: "ไม่มี worker ที่ต้องเปิด/รีสตาร์ท" }));
        const reload = mkx("button", { type: "button", className: "btn-primary", textContent: "เสร็จ (โหลดหน้าใหม่)" });
        reload.onclick = () => { close(); location.reload(); };
        form.append(mkx("div", { className: "modal-btns" }, reload));
      } catch (e) { msg.textContent = `❌ ${e.message}`; } finally { go.disabled = false; }
    };
    pw.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); go.click(); } };
    form.append(mkx("div", { className: "modal-btns" }, back, go));
    setTimeout(() => pw.focus(), 50);
  });

  list();
}
