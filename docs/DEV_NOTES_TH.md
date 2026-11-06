# web_terminal

แผน: `../mt5_dashboard/WEB_TERMINAL_PLAN.md`

## Deploy P0 บน VPS (Windows)
1. `git pull`
2. `cd web_terminal` → `venv\Scripts\python.exe hash_password.py` → ได้บรรทัด `WT_PASS_HASH=...`
3. สร้าง `web_terminal\.env` จาก `.env.example` ใส่ค่าจากข้อ 2
4. `pm2 start ecosystem.config.js` → `pm2 save`
5. เพิ่ม `Caddyfile.snippet` ต่อท้าย Caddyfile เดิม → `caddy reload --config <path Caddyfile>`
6. เปิด https://terminal.example.com → ต้องเด้งไปหน้า login

## Deploy P1 (realtime) บน VPS
1. `git pull`
2. `venv\Scripts\pip.exe install -r requirements.txt` (ต้องมี websockets>=14)
3. สร้าง key: `venv\Scripts\python.exe -c "import secrets;print(secrets.token_urlsafe(32))"` → ใส่ `WT_WORKER_KEY=...` ใน `.env`
4. เช็ค `accounts.json` (terminal_path ของ MT5 T2, ใส่ `login` ได้ถ้าอยากให้ worker ปฏิเสธเมื่อ terminal ล็อกอินบัญชีอื่น)
5. `pm2 start ecosystem.config.js` → `pm2 save` (จะมี web-terminal + wt-worker-demo)
6. MT5 T2 ต้องเปิดอยู่และล็อกอิน demo; ตั้งค่า Tools > Options > Expert Advisors > Allow algorithmic trading

## Acceptance P0
- ในเครื่อง: `python -m unittest discover -s tests -v` → 29/29 (P0 17 + P1 12)
- บน VPS:
  - `curl -I https://terminal.example.com/api/auth/check` → 401
  - จากเครื่องอื่น: `curl http://example.com:8100/healthz` → ต่อไม่ได้ (bind 127.0.0.1)
  - ล็อกอินผิด 5 ครั้ง → ครั้งที่ 6 ได้ 429

## ลืมรหัส / สงสัยว่ารหัสหลุด
- สร้าง hash ใหม่ (ข้อ 2) → แก้ .env → `pm2 restart web-terminal --update-env`
- เตะทุก session: ลบไฟล์ `web_terminal.db` แล้ว restart

## Acceptance P1
- หน้าเว็บ: แถบบนมี badge `DEMO · <login>` + จุด WS/MT5 เขียว + ping
- เปิด MT5 T2 คู่กับเว็บ ช่วงตลาดเปิด 10 นาที: bid/ask ในเว็บตามทันภายใน ≤1 วินาที
- เปิด/ปิดไม้ใน MT5 เอง → ตาราง Positions ในเว็บเปลี่ยนภายใน ~1 วินาที
- `pm2 stop wt-worker-demo` → เว็บขึ้นแถบแดง; `pm2 start` → กลับมาเองไม่ต้อง refresh

## Deploy P2 (กราฟ)
- `git pull` → `pm2 restart web-terminal wt-worker-demo` (ไม่มี dependency ใหม่ — KLineChart อยู่ใน static/vendor)
- ไม่ต้องแก้ .env

## Acceptance P2
- กราฟ XAUUSD ขึ้น, เปลี่ยน TF M1..MN ได้, เลื่อนซ้ายสุดแล้วโหลดแท่งเก่าเพิ่มเอง
- แท่ง 20 แท่งล่าสุด (M15) OHLC ตรงกับ MT5 T2 (เอาเมาส์ชี้ดู tooltip เทียบ Data Window ใน MT5)
- แท่งล่าสุดขยับตามราคา; พอขึ้นแท่งใหม่ แท่งก่อนหน้าปิดตรงกับ MT5
- ตลาดเปิด: ไม่มีแถบเตือน "เวลา server ดูเหมือน UTC..." (ถ้ามี ให้แก้ server_utc_offset_h ตามที่บอก)
- วาดเส้น → refresh หน้า → เส้นยังอยู่; เปลี่ยน TF เส้นยังอยู่; คลิกขวาที่เส้น = ลบ, เลือกแล้วกด Delete = ลบ
- ปุ่ม ▥/⊞ แบ่ง 2/4 กราฟ; คลิกแถวใน Watchlist = เปลี่ยน symbol ของกราฟที่เลือกอยู่ (กรอบฟ้า)

## Deploy P3 (เทรด)
- `git pull` → `pm2 restart web-terminal wt-worker-demo` (ไม่มี dependency ใหม่)
- accounts.json บัญชี demo: `"trading": true`, `"allow_real": false`, guards max_lot 5 / max_positions 30
- MT5 T2 ต้องเปิดปุ่ม **Algo Trading** (สีเขียว) ไม่งั้นทุกคำสั่งได้ retcode 10027
- audit log: `web_terminal\logs\audit_demo.jsonl` (ทุกคำสั่ง ทั้งผ่าน/ไม่ผ่าน)

## Acceptance P3 (บน demo เท่านั้น, BTCUSDm เทสได้วันเสาร์-อาทิตย์)
ทำทุกข้อ แล้วเทียบกับ MT5 T2 ว่าตรงกัน:
1. Market BUY / SELL lot เอง ใส่ SL+TP → position ขึ้นทั้งเว็บและ MT5, SL/TP ตรง
2. Risk% 0.5 + SL → lot ที่ได้ × ระยะ SL ≈ 0.5% ของ balance (ดูบรรทัด "เสี่ยง ...")
3. Buy/Sell Limit, Buy/Sell Stop, Buy Stop Limit → pending ขึ้นใน MT5 ชนิดตรง
4. แตะเส้น/แถวในตาราง → แผงเปลี่ยนเป็น "แก้ไข #ticket"; ลากเส้น SL/TP → ขึ้น ✓ ยืนยัน/ยกเลิก บนเส้น → ยืนยัน → MT5 เปลี่ยนตาม; ยกเลิก → กลับค่าเดิม
5. ลากเส้นราคา pending → ยืนยัน → MT5 ย้ายราคา; ชิป TP/SL เส้นประบนเส้นราคา = เพิ่ม TP/SL
5b. $ บนเส้น SL/TP และช่อง "ถ้าโดน SL / ถ้าถึง TP" ตรงกับที่ MT5 คำนวณ (ลากเส้นใน MT5 ดูเทียบ)
5c. แตะรูปที่วาด → ปุ่ม "⌫ ลบที่เลือก" ใช้ได้ (มือถือ)
6. SL/TP (ปุ่มในตาราง), ปิดบางส่วน ½, ปิด ✕, ปิดทั้งหมด, ยกเลิกทั้งหมด
7. คำสั่งผิด (lot 0.015, SL ผิดฝั่ง, Buy Limit เหนือราคา) → ขึ้นข้อความแดง และ **ไม่มี** รายการใหม่ใน MT5 Journal
8. ปิดปุ่ม Algo Trading ใน MT5 → ส่งคำสั่ง → ข้อความบอกให้เปิด Algo Trading

## P4 อินดิเคเตอร์ (Pine → JS)
- ไฟล์: `static/indicators/core.js` (กรอบ: toggle + หน้าตั้งค่าจาก inputs + prefs), `static/indicators/<name>.js`
- เทสต์ตรรกะ: `node --test tests/js/*.js`
- Liquidity Zones: ปุ่ม "ƒx อินดิเคเตอร์" → ติ๊กเปิด → ⚙ ตั้งค่า 11 ช่องตามต้นฉบับ
- Acceptance (ทำบน TV คู่กับเว็บ, symbol/TF เดียวกัน, ค่าเริ่มต้น):
  - TV ไม่ export กล่อง/label ออก CSV → เทียบด้วยตา 3 จุด: โซน EQH/EQL ตำแหน่งเดียวกัน, สถานะ swept ตรง, ตัวเลข "Nx EQH (vol)" ตรง (vol ต่างได้เพราะ TV ใช้ volume ของ feed ตัวเอง)
  - ถ้าเจอ pivot ที่ TV มีแต่เว็บไม่มี (หรือกลับกัน) ตรงยอดที่สูงเท่ากันเป๊ะ = กติกาเท่ากันของ pivot ต้องแก้ (lzPivot)
- VP Order Blocks: ใช้แท่ง TF ย่อย = round(นาทีกราฟ/15) (M1/M5 = 30 วินาทีจาก tick, M15 = 1m, M30 = 2m, H1 = 4m, H4 = 16m, D1 = 96m จาก M1)
  - OB ที่ MT5 ไม่มีข้อมูล TF ย่อย = ไม่แสดง (เหมือนต้นฉบับ) และขึ้นจำนวนมุมล่างซ้าย "VP OB: N OB ไม่มีข้อมูล..."
  - Acceptance: เทียบกับ TV ด้วยตา 3 จุด — ตำแหน่งกรอบ OB, แท่งที่ถูก mitigate, รูปร่าง histogram (ช่องที่ยาวสุด) ใกล้กัน
    (volume ต่างกันได้เพราะ feed คนละเจ้า แต่ช่อง volume สูงสุดควรตรงเป็นส่วนใหญ่)

## P5 ประวัติเทรด
- เดสก์ท็อป: ปุ่ม "📜 ประวัติ" บนแถบบน / มือถือ: แท็บ "ประวัติ"
- ข้อมูลจาก MT5 history deals รวมเป็นรายไม้ (เข้า/ออกเฉลี่ยถ่วง volume, net = profit+คอม+swap+fee, ปิดบางส่วน)
- สรุป: กำไรสุทธิ, จำนวนไม้, เฉลี่ยได้/เสีย, เสียหนักสุด, DD สูงสุดของเงินสะสม, ค่าคอม+swap, ฝาก/ถอน + กราฟเงินสะสม
- กรอง: ช่วงเวลา (วันนี้/7/30/เดือนนี้/90/กำหนดเอง), symbol, ที่มา (มือ magic 0 / บอท)
- แตะไม้ = journal: โน้ต, tag, ภาพ (📷 ถ่ายจากกราฟ หรือ 🖼 อัปโหลด ย่อให้อัตโนมัติ), เปิดกราฟที่ไม้นั้น; ส่งออก CSV (รวมโน้ต/tag)
- Acceptance: เทียบ 5 ไม้ล่าสุดกับแท็บ History ใน MT5 T2 — ราคาเข้า/ออก, lot, กำไรสุทธิ ตรงกัน; ยอดรวมช่วงเดียวกันตรงกับ MT5 report

## Alert อินดิเคเตอร์ → Telegram
- ตัวส่ง: `alerts/alert_service.js` (Node ≥18, pm2 ชื่อ `wt-alerts`) ใช้ไฟล์อินดิเคเตอร์ชุดเดียวกับหน้าเว็บ
- Telegram: อ่าน TELEGRAM_TOKEN/TELEGRAM_CHAT_ID จาก `web_terminal/.env` ถ้าไม่มีใช้ของ `../.env` (ระบบเดิม)
- ตั้งกฎ: ƒx อินดิเคเตอร์ → 🔔 แจ้งเตือน Telegram → เลือกอินดิเคเตอร์/เหตุการณ์/symbol/TF → + เพิ่มกฎ
  - VP Order Blocks: 6 เหตุการณ์ตาม alertcondition ต้นฉบับ
  - Liquidity Zones: new EQH/EQL, EQH/EQL swept (ต้นฉบับไม่มี alert — เพิ่มเอง)
- เช็คทุก 10 วินาที ส่งเมื่อมีแท่งปิดใหม่เท่านั้น (ไม่ส่งย้อนหลังตอนเริ่ม/เพิ่มกฎ)
- Acceptance: กด "ส่งข้อความทดสอบ" → เข้า Telegram ใน ~10 วิ; ตั้งกฎ M1 แล้วรอให้เกิดเหตุการณ์ → ข้อความตรงกับที่เห็นบนกราฟ
- Market Sessions & TPO (+Forecast) (Pine "Mxwll Sessions"): ใช้ได้ TF M1–H4 (D1 ขึ้นไปขึ้นข้อความแจ้ง)
  - กรอบ NY/London/Asia ตามเวลา New York (DST อัตโนมัติ), pre/post market, TPO Bars/Letters, POC/naked POC, Forecast Bars/Line
  - ตัด: บรรทัด OI (TradingView-only); ต้นฉบับไม่มี alert และไม่มีตาราง dashboard
  - Acceptance: เทียบ TV 1 วัน (M5 หรือ M15): ขอบกรอบ session, ตำแหน่ง POC, จำนวนแท่ง forecast

## P6 จัดการไม้ + ความเสี่ยง + alert ราคา + สถานะระบบ
- Deploy: `git pull` → `pm2 restart web-terminal wt-worker-demo wt-alerts --update-env` (ถ้าบัญชี cent ขึ้นแล้ว restart `wt-worker-cent` ด้วย)
- ปิดบางส่วน: ปุ่ม ½ / "ปิดบางส่วน" → 25/50/75/ทั้งหมด (ปัดลงตาม volume_step, เหลือต่ำกว่า lot ขั้นต่ำ = ปิดทั้งหมด)
- BE: ปุ่ม BE ในตาราง/การ์ด/แผงแก้ไข/ชิป BE บนเส้นไม้ที่กำไร; ปุ่ม BE หัวตาราง = เฉพาะ symbol หรือทุก symbol
  - SL = ราคาเข้า + "ล็อกกำไร (จุด)" จากค่า Auto BE; ราคายังไม่เลยทุน = ปฏิเสธ; SL ทุนแล้ว = ข้าม
- Auto BE (🛡 หัวตาราง Positions): worker เลื่อนให้ทุก 0.5 วิ ทำงานแม้ปิดเว็บ, ครั้งเดียวต่อไม้
  - โหมด RR (กำไร ≥ rr × ระยะ SL เดิม, ไม้ต้องมี SL) หรือ ระยะ (กำไร ≥ N จุด), ล็อกกำไร, เฉพาะ symbol, ค่าเฉพาะราย symbol
  - โบรกปฏิเสธ = รอ 60 วิก่อนลองใหม่; บัญชีเทรดไม่ได้ (trading false / REAL ไม่ allow) = ไม่ทำอะไร
  - ค่าเก็บที่ `logs/autobe_<บัญชี>.json`, ทุกครั้งที่เลื่อนลง audit log
- แถบบน/การ์ดบัญชี: "เสี่ยง" = ขาดทุนรวมถ้าทุกไม้โดน SL (order_calc_profit), ⚠ นับไม้ไม่มี SL; "วันนี้" = กำไรปิดแล้วตั้งแต่ 00:00 เวลาไทย (ตั้ง `day_reset` ใน accounts.json ได้ เช่น "16:59 America/New_York")
- Telegram (ตั้งที่ ƒx → 🔔): แจ้งไม้ปิด (TP/SL/ปิดเอง + ผลสุทธิ), แจ้ง Auto BE — เริ่มนับตอน wt-alerts เริ่ม ไม่ส่งย้อนหลัง
- alert เส้นราคา: ปุ่ม 🔔 บนแถบกราฟ → แตะที่ราคา → เส้นส้ม ลากย้ายได้, แตะชิปแก้ราคา/โน้ต, ✕ ลบ; ยิงครั้งเดียวแล้วปิดตัวเอง (เช็คทุก 2 วิ: ราคาล่าสุด + ไส้แท่ง M1 หลังตั้ง)
- 📐L / 📐S: แตะที่ราคาเข้า → ร่าง Long/Short (market ถ้าแตะใกล้ราคา, ไม่งั้น limit/stop) SL:TP = 1:2, lot จาก Risk%, โซนเขียว/แดง + R:R + เงินเสี่ยงบนกราฟ → ✓ ส่ง
- 🕘 ไม้เก่า: ไม้ที่ปิดแล้ว 30 วันล่าสุดของ symbol นั้น (▲ ฝั่งเข้า, ● จุดออก + ผลสุทธิ)
- เทมเพลตอินดิเคเตอร์: ƒx → เทมเพลต → ตั้งชื่อ → บันทึกชุดนี้ / ใช้ / ลบ
- 🩺 สถานะระบบ (แถบบน / แท็บบัญชีบนมือถือ): worker+MT5 ทุกบัญชี, เวลา server ที่ตั้ง vs วัดได้, wt-alerts + Telegram, ปฏิทินข่าว
- Acceptance (demo): BE ไม้ที่กำไร → SL = ราคาเข้าใน MT5; Auto BE ระยะเล็ก (เช่น 30 จุด) → SL เลื่อนเอง + Telegram; ปิดครึ่ง → lot เหลือถูก; alert ราคาใกล้ราคาปัจจุบัน → Telegram แล้วเส้นหาย

## เดสก์ท็อปเต็มจอพอดี (แบบ Exness) — จอกว้างกว่า 700px
- ซ้าย: แถบไอคอน (⭐ ราคา / 📋 ออเดอร์ / 📜 ประวัติ / 📰 ข่าว / 🩺 ระบบ) + Watchlist (ลากขอบขวาปรับกว้าง, ⭐ ซ่อน/แสดง)
- กลาง: กราฟเต็มพื้นที่ + dock ล่าง แท็บ Positions / Pending (กดแท็บที่เปิดอยู่หรือ ▾ = พับ, ลากขอบบนปรับสูง, ดับเบิลคลิกขอบ = พับ/กาง)
- ขวา: ช่องส่งคำสั่ง — ปุ่ม 📝 ออเดอร์ (หรือ F9) แสดง/ซ่อน, ⧉ = ลอยเป็นหน้าต่างลากย้ายได้ / ยึดข้างจอ
- ⛶ เต็มจอ: เหลือแถบบน + กราฟ, กด 📝 ออเดอร์ = หน้าต่างลอย, Esc ออก
- ล่างสุด: แถบสถานะบัญชี (Balance, Equity, Profit, Margin, Free, Level, วันนี้, เสี่ยง)
- ขนาด/การซ่อนแผงจำไว้ในเบราว์เซอร์เครื่องนั้น (ไม่ sync ข้ามเครื่อง เพราะขนาดจอต่างกัน); มือถือใช้หน้าตาเดิม

## MT5 แยก process (กัน worker ค้างเวลาโบรกไม่ตอบ)
- worker เรียก MT5 ผ่าน `mt5proc.py`: process ลูก "data" (ราคา/กราฟ/ประวัติ) + "trade" (order_send) — โบรกค้าง = รอแค่ลูก trade, หน้าเว็บ/ราคายังเดิน และขึ้นแถบ "⏳ รอโบรกตอบคำสั่ง…"
- ลูกไม่ตอบ: data 60 วิ / trade 300 วิ -> kill แล้วเปิดใหม่เอง (คำสั่งที่ค้างแจ้ง "ไม่รู้ผล")
- log เริ่มต้น worker ต้องมี `MT5 โหมด: process ลูก (data + trade)` และ `mt5 data: เปิด process ลูก pid=…`
- ถ้ามีปัญหา กลับไปโหมดเดิม: ใส่ `WT_MT5_INPROC=1` ใน web_terminal/.env แล้ว `pm2 restart wt-worker-demo wt-worker-cent --update-env`

## แจ้งเตือนเด้งบนเครื่อง (Web Push)
- ติดตั้งครั้งเดียวบน VPS: `venv\Scripts\pip install pywebpush` แล้ว `pm2 restart web-terminal`
- เปิดบนแต่ละเครื่อง: ƒx → 🔔 แจ้งเตือน Telegram → "📲 เปิดแจ้งเตือนบนเครื่องนี้" → อนุญาต → กด "ทดสอบ"
- iPhone: ต้องเพิ่มเว็บลงหน้าจอหลัก แล้วเปิดจากไอคอนก่อน (iOS 16.4+) · ส่งทุกรายการเดียวกับ Telegram (อินดิเคเตอร์, alert ราคา/เส้น/กรอบ, ไม้ปิด, Auto BE)
- VAPID key สร้างเองครั้งแรก เก็บใน web_terminal.db

## อื่นๆ รอบนี้
- ชุด SL/TP (ใต้ช่อง SL/TP): จุด หรือ ATR(14)×k, TP เป็น R หรือจุด, ตั้งต่อ symbol / ทุก symbol (⚙) — ใช้กับไม้ที่แก้ไขได้ด้วย
- คีย์ลัดคอม: B / S ส่ง, Shift+คลิกกราฟ = BUY pending, Alt+คลิก = SELL pending, Esc ยกเลิก, ? ดูทั้งหมด
- 🔗 (โหมด 2/4 กราฟ): ซิงก์ crosshair / symbol / เวลา
- alert เส้นที่วาด: เลือกเส้นเทรนด์/Ray/เส้นยาวสุด/แนวนอน/กล่อง แล้วกด 🔔 ข้าง ✕ ⚙ — ผูกกับเส้น: ย้ายเส้น = alert ย้ายตาม, ลบเส้น (รวมลบทั้งหมด/ย้อนกลับ) = ยกเลิก alert
- ประวัติ → 📊 สถิติเชิงลึก

## P7 ตั้งค่า / ปิดหลายไม้ / OCO+หมดอายุ / ข่าวบนกราฟ / แท็ก / แจ้งเตือนระบบ
- ⚙️ ตั้งค่า: คอม = แถบซ้ายเหนือ "ออก", มือถือ = หน้า "บัญชี" — เส้นตาราง, เส้น TP/SL, เส้นข่าว, ระดับข่าว (สูง/กลาง/ต่ำ), แจ้งข่าวล่วงหน้า, เตือนก่อนส่งคำสั่งใกล้ข่าว, ยืนยันก่อนส่ง, แท็ก journal, การแจ้งเตือน, ธีม สว่าง/มืด/ตามเครื่อง (prefs `wt.settings`)
- ปิด… ▾ (Positions): ทั้งหมด / เฉพาะกำไร / ขาดทุน / BUY / SELL / symbol ในกราฟ + ยกเลิก pending ทั้งหมด/เฉพาะ symbol — ยืนยันทุกครั้ง
- Pending หมดอายุ + OCO: เลือกในหน้าส่งคำสั่ง (Limit/Stop) หรือปุ่ม ⏱🔗 ในตาราง Pending · worker ยกเลิกเอง (ไฟล์ `logs/prules_<acct>.json`) ไม่ใช้ expiration ของโบรก: ใช้ได้ทุกโบรก ไม่ต้องแปลงเวลา server · OCO: ตัวหนึ่ง fill → ยกเลิกอีกตัว, ตัวหนึ่งถูกยกเลิกเอง → เลิกจับคู่
- 📰 ข่าวบนกราฟ: เส้นแนวตั้งตรงเวลาข่าวของสกุลใน symbol (ทอง/คริปโต = USD) ปุ่ม 📰 บนแถบกราฟ = ซ่อน/แสดง
- แท็ก journal: แตะเลือก (ตั้งชุดแท็กใน ⚙️) · 🏷 ในตาราง Positions = บันทึกไม้ที่ยังเปิด · ประวัติ: กรองตามแท็ก + ตาราง "แท็ก" ในสถิติเชิงลึก
- wt-alerts แจ้งเพิ่ม (Telegram+Push, เปิด/ปิดใน ⚙️): OCO/หมดอายุ, คำสั่งไม่รู้ผล, worker ไม่ตอบ/MT5 หลุด > 60 วิ (และตอนกลับมา — worker ที่ปิดไว้ตั้งแต่แรกไม่แจ้ง), รอโบรก > 60 วิ, ข่าวล่วงหน้า N นาที (สกุลใน watchlist / ที่มีไม้ / ทุกสกุล)
- Deploy: `git pull` แล้ว `pm2 restart web-terminal wt-worker-demo wt-worker-cent wt-alerts --update-env`
- Watchlist หลายกลุ่ม: แท็บใต้หัว Watchlist (+ = เพิ่มกลุ่ม, แตะแท็บที่เปิดอยู่ = เปลี่ยนชื่อ/ย้าย/ลบ) · ▾ บนกราฟแสดงทุกกลุ่ม · ราคาสดทุกกลุ่ม (รวมไม่เกิน 50 คู่) · prefs `wt.wgroups.<acct>`

## Order flow จาก Binance (BTC/ETH) — pm2 `wt-flow`
- `flow.py` ต่อ Binance futures (ฟรี): aggTrade (ฝั่งที่กดเข้า), forceOrder (ล้างพอร์ต), markPrice (funding) + OI ทุก 60 วิ → `flow.db` เก็บ 30 วัน (รายนาที + volume ตามระดับราคา) · ช่วงที่ไม่ได้รัน = ไม่มีข้อมูล (ไม่ backfill)
- เปิดครั้งแรก: `git pull` → `pip install -r requirements.txt` (certifi) → `pm2 start ecosystem.config.js --only wt-flow` → `pm2 restart web-terminal --update-env` → `pm2 save`
- เช็ค: 🩺 สถานะระบบ → "Order flow Binance" · ใช้ RAM ~50–100 MB, CPU ~1%
- หน้าเว็บ: ƒx → 📊 Order Flow: Delta, CVD (รีเซ็ตทุก N ชม.), Open Interest, Volume Profile (ช่วงที่มองเห็น + POC + Value Area), Liquidations — ใช้กับ BTCUSD*/ETHUSD* (ราคา Binance ต่างจาก Exness เล็กน้อย)
- symbol อื่น: `.env` → `WT_FLOW_SYMBOLS=BTCUSDT:5,ETHUSDT:0.5,SOLUSDT:0.05` (symbol:ขนาด bin ราคา) แล้วแก้ `flowSym()` ใน static/flow.js

## ⏪ Bar Replay (ฝึกเทรดย้อนหลัง, ออเดอร์จำลอง)
- เข้า: คอม = แถบซ้าย ⏪ Replay (เหนือ ระบบ/ตั้งค่า), มือถือ = หน้าบัญชี → ⏪ Bar Replay · ใช้ symbol/TF ของกราฟที่เลือกอยู่
- เลือกจุดเริ่ม: วันเวลา หรือ 📍 แตะแท่งบนกราฟ · ดึงแท่งครั้งเดียวผ่าน worker `/rates_range` (ก่อนจุดเริ่ม 300 + หลัง ≤ 20,000 แท่ง, ประวัติขึ้นกับ MT5)
- ▶/⏸ (Space), ⏭ (→), ความเร็ว 1–20 แท่ง/วิ, ⏹ ออก = สรุปผล + บันทึก (localStorage เครื่องนี้, ดูที่ ⏪ → ผลรอบที่ผ่านมา)
- ออเดอร์จำลอง: BUY/SELL (B/S), ⌖ Pending แตะราคา → Limit/Stop, Lot หรือ Risk% (SL = ATR14×1.5), ลาก/เพิ่ม TP-SL บนเส้น 🧪 เหมือนของจริง
- สมมติ: ราคาแท่ง = Bid, Ask = Bid + สเปรดสดตอนเริ่ม, ไม่มี slippage/swap/คอม, แท่งเดียวชนทั้ง TP/SL = SL ก่อน, pending ที่ fill แท่งนี้เริ่มเช็ค TP/SL แท่งถัดไป
- ระหว่าง replay: ปุ่มส่งคำสั่งจริง (หน้าส่งคำสั่ง/แถบล่างมือถือ) ถูกปิด, เส้นออเดอร์จริงไม่แสดงบนกราฟที่ replay, เปลี่ยน symbol/TF = จบ replay

## 🏦 บัญชี MT5 จากหน้าเว็บ (ตั้งค่า -> บัญชี MT5)
- เพิ่ม / แก้ / ลบ บัญชี = บันทึกลง `accounts.local.json` (ไม่อยู่ใน git, git pull ไม่ชน; มีไฟล์นี้แล้วใช้แทน `accounts.json` ทั้ง gateway / worker / ecosystem; สำรองเป็น .bak) ต้องใส่รหัสผ่านเว็บยืนยัน
- 🔍 ตรวจสอบบัญชี: gateway รัน `mt5probe.py` เปิด terminal ตาม path -> อ่านเลขบัญชี / server / สกุล / demo-real -> ตั้ง kind (USC = cent) + ล็อกเลขบัญชีให้ ไม่ใช้รหัส MT5 (อ่านบัญชีที่ MT5 จำไว้)
- terminal ที่มี worker ต่ออยู่แล้ว ถาม worker แทน (ไม่เปิด IPC ซ้อน); terminal เดียวกันใช้ได้ 1 บัญชี; port ว่าง = ให้อัตโนมัติจาก 8101
- gateway ใช้รายการใหม่ทันที แต่ worker ต้องเปิด/ปิดเอง: หน้าเว็บแสดงคำสั่ง pm2 ให้คัดลอก (`pm2 start ecosystem.config.js --only wt-worker-<ชื่อ>` / `pm2 delete` / `pm2 restart`) แล้ว `pm2 save`
- ติดตั้ง MT5 ตัวใหม่ + login ครั้งแรก (ติ๊กจำรหัส) ทำผ่าน RDP เหมือนเดิม

## 🔄 อัปเดต: `update.bat` (ดับเบิลคลิกบน VPS)
- git pull → pip install (เฉพาะเมื่อ requirements.txt เปลี่ยน) → `pm2 startOrRestart ecosystem.config.js --update-env` + `pm2 save`
- แก้แค่ static / docs / tests / .md = ไม่ restart (บอกให้รีเฟรชหน้าเว็บ)
- บัญชีใหม่ใน accounts(.local).json ถูกเปิด worker ให้เองด้วย startOrRestart

## 💾 สำรองข้อมูลอัตโนมัติ (gateway)
- วันละชุดที่ `web_terminal\backups\YYYY-MM-DD\` เก็บ 14 วัน: `web_terminal.db` (sqlite backup API ปลอดภัยขณะใช้งาน) + `.env` + `accounts.local.json` + `logs\autobe_*.json` / `prules_*.json`
- ชุดแรก 1 นาทีหลังเปิด gateway แล้วเช็คทุกชั่วโมง; ดูสถานะที่ 🩺 สถานะระบบ; ปิดได้ด้วย `WT_BACKUP=0`, ย้ายที่ `WT_BACKUP_DIR=...`
- กู้คืน: `pm2 stop all` → คัดลอกไฟล์จากโฟลเดอร์วันที่ต้องการกลับที่เดิม (`web_terminal.db`, `.env`, `accounts.local.json` ไว้ใน web_terminal, `*.json` ไว้ใน logs) → `pm2 start all`
- backups อยู่เครื่องเดียวกับระบบ — ย้ายเครื่อง/กัน VPS พัง ให้คัดลอกโฟลเดอร์ backups ออกไปเก็บที่อื่นเป็นระยะ

## ⚡ Performance (2026-09-29/30) — รายละเอียด `docs/PERF_PLAN.md`
- tick วาดรวมต่อเฟรม, ตาราง positions แก้เฉพาะช่อง, Mxwll/Sessions calc เร็วขึ้น 2-4x (ผลเท่าเดิม), กราฟที่ซ่อนไม่คำนวณ, static แคช ?v=hash, แคชแท่งฝั่ง browser
- ข้อที่ยังไม่ทำ (ทำเมื่อยังรู้สึกหน่วง): 8 lazy-load อินดิเคเตอร์, 15 จำกัด DPR, 16 ลดแท่งเริ่มต้นมือถือ

## Replay: ผลรอบบน server / 🙈 ซ่อนวันที่ · เส้น PDH/PWH
- ผลรอบ replay เก็บในตาราง `replay_sessions` (web_terminal.db, 200 รอบล่าสุด) — `/api/replay` GET / PUT {sid} / DELETE {sid}; localStorage เป็นสำเนาตอนออฟไลน์; รอบเก่าในเบราว์เซอร์ย้ายขึ้นเองครั้งแรก
- 🙈 ซ่อนวันที่: สุ่มจุดเริ่มให้เอง, ซ่อนแกนเวลา + ป้ายเวลา crosshair + เส้นข่าว + ไม้จริงบนกราฟ, แถบบอก "แท่งที่ N"; เห็นวันที่ตอนสรุปหลังจบ
- ตั้งค่า > แสดงบนกราฟ: เส้น PDH/PDL (D1 ก่อนหน้า) และ PWH/PWL (W1 ก่อนหน้า) จากแท่งของโบรก (`static/levels.js`); ตอน replay ใช้แท่ง D1/W1 ที่ปิดแล้ว ณ เวลาที่เล่น
- แท็ก/โน้ตต่อไม้ใน replay: ชิป 🏷 บนเส้นไม้/pending จำลอง หรือแตะแถวในสรุปผล (แท็กชุดเดียวกับ Journal ใน ตั้งค่า) — แก้รอบที่บันทึกแล้วส่งขึ้น server เอง
- 📊 ผลรอบที่ผ่านมา → 📈 สรุปรวมทุกรอบ: กรอง symbol / แท็ก, win rate, R เฉลี่ย / R รวม, PF, กราฟ R สะสม, ตารางแยกแท็ก / symbol (เงินรวมโชว์เมื่อเลือก symbol เดียว)

## worker ต่อ MT5 ไม่ได้: "Pipe server didn't answer" / MT5Timeout ขณะ initialize (2026-11-01)
- สาเหตุ: MT5 Tools > Options > Community > "Python integration" ถูกปิด → terminal ไม่สร้าง `\.\pipe\MT5.Terminal.*`
- แก้: ติ๊ก Python integration แล้ว restart MT5 (หรือปิด MT5 แล้วแก้ `config\common.ini` [Common] `Services=` ให้มีบิต 0x40)
- หลังรีบูต VPS: Startup `start_all.cmd` เปิด MT5, Caddy, pm2 เอง (`start_all.ps1`)
