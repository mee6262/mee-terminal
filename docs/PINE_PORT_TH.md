# คู่มือสั่ง AI แปลงอินดิเคเตอร์ Pine → Mee Terminal

ใช้กับ AI ที่เปิดไฟล์ในโปรเจกต์ได้ (Claude Code, Cursor ฯลฯ) หรือ AI แชททั่วไป (แนบไฟล์เอง)

## ไฟล์ที่ต้องให้ AI อ่าน / แนบ

| ไฟล์ | ทำไม |
|---|---|
| โค้ด Pine ต้นฉบับ (.txt / .rtf / .pine) | ต้นฉบับที่จะแปลง |
| `web_terminal/static/indicators/core.js` | กรอบ `defineIndicator` — รูปแบบ inputs / calc / draw ที่ระบบรับ |
| `web_terminal/static/indicators/of_vwap.js` | ตัวอย่างที่แปลงแล้ว (เส้น, กล่อง, label, alert) — ให้ทำตามแบบนี้ |
| `web_terminal/tests/js/test_ofvwap_mxwll.js` | ตัวอย่าง test |
| `web_terminal/static/index.html` | ต้องเพิ่ม `<script>` ของไฟล์ใหม่ |
| `web_terminal/alerts/alert_service.js` | (ถ้าอยากได้แจ้งเตือน Telegram จากอินดิเคเตอร์นี้) |

ตัวอย่างอื่นที่ใช้ได้: `liquidity_zones.js` (โซน/pivot), `sessions_tpo.js` (session ตามเวลา NY), `mx_suite.js` (ตัวใหญ่ หลายส่วน)

## ข้อความสั่ง (คัดลอกไปใช้ แก้ส่วนใน < >)

```
แปลงอินดิเคเตอร์ Pine ในไฟล์ <ชื่อไฟล์ Pine> เป็นอินดิเคเตอร์ของ Mee Terminal (web_terminal)

อ่านก่อน: web_terminal/static/indicators/core.js (กรอบ defineIndicator) และ
web_terminal/static/indicators/of_vwap.js (ตัวอย่างที่แปลงแล้ว) — ทำตามรูปแบบเดียวกัน

ต้องทำ:
1. สร้าง web_terminal/static/indicators/<ชื่อสั้น a-z_>.js
   - const <X>_DEF = { name, title, inputs, calc, draw, alerts? }
   - inputs ครบทุกตัวของต้นฉบับ (type: int|float|bool|color|colort|select, default, min/max/step, group, tooltip)
     ทุกส่วนที่วาดต้องมี bool เปิด/ปิด + สีตั้งได้
   - calc(bars, cfg) -> state (bars = [{timestamp, open, high, low, close, volume}] เก่า->ใหม่) — ห้ามแตะ DOM
   - draw(ctx, state, h, cfg) วาดด้วย canvas: h.x(index), h.y(price), h.from/h.to (ช่วงแท่งที่เห็น), h.width, h.height, h.digits
   - ท้ายไฟล์: if (typeof module !== "undefined") module.exports = { <ฟังก์ชันหลัก>, <X>_DEF }; else defineIndicator(<X>_DEF);
2. เพิ่ม <script src="/static/indicators/<ชื่อ>.js"></script> ใน web_terminal/static/index.html ต่อจาก indicators ตัวอื่น
3. เขียน test ที่ web_terminal/tests/js/test_<ชื่อ>.js (node:test) ตรวจสูตรหลักกับตัวเลขที่คำนวณมือได้
4. (ถ้ามี alertcondition) ใส่ alerts: { event_key: "ชื่อที่แสดง" } ใน DEF และให้ calc คืน state.events = { event_key: {...} | null }
   แล้วเพิ่มใน INDICATORS ของ web_terminal/alerts/alert_service.js

กติกา:
- ตรรกะตามต้นฉบับทุกบรรทัด (รวมจุดแปลกของต้นฉบับ) — ห้ามปรับสูตรเอง ถ้าจำเป็นต้องต่างให้เขียนไว้ในคอมเมนต์หัวไฟล์ "ต่างจาก TradingView"
- ไม่มี look-ahead: ค่าที่แท่ง i ใช้ได้แค่แท่ง 0..i (pivot ต้องยืนยันหลัง right bars แบบ Pine)
- ตัด table.new / dashboard ทิ้ง (ยกเว้นขอให้ทำ)
- เวลา: bars.timestamp เป็น UTC ms; session แบบ Pine ("0930-1600", timezone) ให้แปลงเองแบบใน sessions_tpo.js
- ชื่อตัวแปร/ฟังก์ชันระดับบนสุดต้องขึ้นต้นด้วย prefix เฉพาะตัว (เช่น xyz...) — ไฟล์ static ทุกไฟล์ใช้ global scope ร่วมกัน ชื่อซ้ำจะทับกันเงียบๆ
  ตรวจด้วย: grep -rn "function <ชื่อ>" web_terminal/static
- ห้ามใช้ innerHTML / library ภายนอก
- ทดสอบ: cd web_terminal && node --test tests/js/*.js ต้องผ่านทั้งหมด
- คอมเมนต์ภาษาไทย หัวไฟล์ระบุชื่อต้นฉบับ + license ของผู้เขียน Pine
```

## หลังแปลงเสร็จ

1. บนเครื่อง dev: `node --test tests/js/*.js` ผ่าน
2. commit + push → บน VPS ดับเบิลคลิก `update.bat` (หรือ `git pull`) → รีเฟรชหน้าเว็บ
3. หน้าเว็บ: ƒx อินดิเคเตอร์ → หมวด "อินดิเคเตอร์ของฉัน" → เปิดตัวใหม่ → ⚙️ ตั้งค่า เทียบกับ TradingView (ภาพเดียวกัน TF เดียวกัน)
4. ถ้าเพิ่ม alert: `pm2 restart wt-alerts` แล้วตั้งที่ 🔔
5. ตัวที่ต่างจาก TV เล็กน้อยเป็นเรื่องปกติ: volume ของ MT5 = tick volume, จำนวนแท่งที่โหลดไม่เท่า TV, เวลา server ต่างกัน

## ข้อผิดพลาดที่ AI มักทำ (บอกไว้ล่วงหน้าได้)

- ใช้ `ta.pivothigh` แล้ววางจุดที่แท่ง pivot ทันที (Pine ยืนยันช้ากว่า right bars แท่ง)
- `var` ใน Pine = ค่าค้างข้ามแท่ง ต้องเป็นตัวแปรนอก loop ไม่ใช่ประกาศใหม่ทุกแท่ง
- `na` ต้องเป็น `NaN`/`null` และระวัง `nz()`
- `request.security` (ขอข้อมูล TF อื่น) ระบบยังไม่มี — ให้รวมแท่งจาก TF ปัจจุบันเอง หรือบอกว่าทำไม่ได้
- ตั้งชื่อ global ซ้ำกับไฟล์อื่น (เช่น `money`, `fmt`) → ฟังก์ชันของระบบพัง
