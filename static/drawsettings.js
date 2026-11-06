// Mee Terminal — ตั้งค่าเส้นที่วาด: Fibonacci (ระดับ/สี/พื้นหลัง) และเส้นทั่วไป (สี/หนา/เส้นประ)
"use strict";

function openDrawingSettings(panel, id) {
  const o = panel.chart.getOverlays({ id })[0];
  if (!o) return;
  const dlg = document.getElementById("modal");
  const form = dlg.querySelector("form");
  form.replaceChildren();
  form.classList.add("wide");
  const h = document.createElement("h3");
  form.append(h);

  const mk = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; };
  const check = (label, value) => {
    const inp = mk("input", { type: "checkbox", checked: !!value });
    return [mk("label", { className: "chk" }, inp, label), inp];
  };

  let collect;
  if (o.name === "fibRetracement") {
    h.textContent = "ตั้งค่า Fibonacci";
    const cfg = JSON.parse(JSON.stringify({ ...fibDefault(), ...(typeof o.extendData === "object" ? o.extendData : {}) }));
    const list = mk("div", { className: "fib-levels" });
    const rows = [];
    const addRow = (l) => {
      const on = mk("input", { type: "checkbox", checked: !!l.on });
      const v = mk("input", { type: "text", inputMode: "decimal", value: String(l.v), className: "fib-v" });
      const c = mk("input", { type: "color", value: l.c });
      const del = mk("button", { type: "button", className: "btn-ghost fib-del", textContent: "✕", title: "ลบระดับ" });
      const row = mk("div", { className: "fib-row" }, on, v, c, del);
      const rec = { on, v, c, row };
      del.onclick = () => { row.remove(); rows.splice(rows.indexOf(rec), 1); };
      rows.push(rec);
      list.append(row);
    };
    cfg.levels.forEach(addRow);
    const add = mk("button", { type: "button", className: "btn-ghost", textContent: "+ เพิ่มระดับ" });
    add.onclick = () => addRow({ v: 0.5, c: "#2f81f7", on: true });

    const [fillL, fill] = check("พื้นหลังสี", cfg.fill);
    const op = mk("input", { type: "range", min: "0.03", max: "0.5", step: "0.01", value: String(cfg.opacity) });
    const [priceL, showPrice] = check("แสดงราคา", cfg.showPrice);
    const [levelL, showLevel] = check("แสดงระดับ", cfg.showLevel);
    const [trendL, trend] = check("เส้นประแนวโน้ม", cfg.trend);
    const [revL, reverse] = check("กลับด้าน (0↔1)", cfg.reverse);
    const [extLL, extL] = check("ยืดซ้าย", cfg.extendLeft);
    const [extRL, extR] = check("ยืดขวา", cfg.extendRight);
    const width = mk("select", {}, ...[1, 2, 3].map((n) => mk("option", { value: String(n), textContent: `หนา ${n}`, selected: cfg.width === n })));
    form.append(list, add,
      mk("div", { className: "opt-grid" }, fillL, mk("label", { className: "chk" }, "ความเข้ม", op), priceL, levelL, trendL, revL, extLL, extRL, width));
    const setDefault = check("ใช้เป็นค่าเริ่มต้นของ Fib ใหม่", false);
    form.append(setDefault[0]);

    collect = () => {
      const levels = rows.map((r) => ({ v: parseFloat(r.v.value.replace(",", ".")), c: r.c.value, on: r.on.checked }))
        .filter((l) => Number.isFinite(l.v)).sort((a, b) => a.v - b.v);
      const out = {
        levels, fill: fill.checked, opacity: parseFloat(op.value), showPrice: showPrice.checked, showLevel: showLevel.checked,
        trend: trend.checked, reverse: reverse.checked, extendLeft: extL.checked, extendRight: extR.checked, width: parseInt(width.value, 10),
      };
      if (setDefault[1].checked) save("wt.fibDefault", out);
      return { extendData: out };
    };
  } else {
    h.textContent = "ตั้งค่าเส้น";
    const ln = o.styles?.line || {};
    const color = mk("input", { type: "color", value: /^#[0-9a-f]{6}$/i.test(ln.color || "") ? ln.color : "#2f81f7" });
    const width = mk("select", {}, ...[1, 2, 3, 4].map((n) => mk("option", { value: String(n), textContent: `หนา ${n}`, selected: (ln.size || 1) === n })));
    const [dashL, dashed] = check("เส้นประ", ln.style === "dashed");
    const swatches = mk("div", { className: "swatches" },
      ...["#2f81f7", "#f23645", "#089981", "#ff9800", "#9c27b0", "#e6e8ec", "#ffeb3b", "#00bcd4"].map((c) => {
        const b = mk("button", { type: "button", className: "swatch", title: c });
        b.style.background = c;
        b.onclick = () => { color.value = c; };
        return b;
      }));
    form.append(mk("div", { className: "opt-grid" }, mk("label", { className: "chk" }, "สี", color), width, dashL), swatches);
    collect = () => ({ styles: { line: { color: color.value, size: parseInt(width.value, 10), style: dashed.checked ? "dashed" : "solid",
      dashedValue: dashed.checked ? [6, 4] : undefined } } });
  }

  const cancel = mk("button", { type: "button", className: "btn-ghost", textContent: "ยกเลิก" });
  const ok = mk("button", { type: "submit", className: "btn-primary", textContent: "บันทึก" });
  form.append(mk("div", { className: "modal-btns" }, cancel, ok));
  const close = () => { form.classList.remove("wide"); dlg.close(); };
  cancel.onclick = close;
  dlg.oncancel = (e) => { e.preventDefault(); close(); };
  form.onsubmit = (e) => { e.preventDefault(); const patch = collect(); close(); panel.replaceDrawing(id, patch); };
  dlg.showModal();
}
