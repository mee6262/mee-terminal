# Mee Terminal

เว็บเทรดสำหรับ **MetaTrader 5** เปิดผ่านเบราว์เซอร์ได้ทั้งคอมและมือถือ (ติดตั้งเป็นแอปบน iPhone/Android ได้)
รันบน Windows VPS ของเราเอง ข้อมูลและรหัสผ่านอยู่ในเครื่องเราเท่านั้น

A self-hosted web trading terminal for MetaTrader 5 (desktop + mobile PWA). Windows only, because it uses the official `MetaTrader5` Python package. Docs are in Thai.

> ⚠️ **คำเตือน** ระบบนี้ส่งคำสั่งซื้อขายจริงได้ ใช้ด้วยความเสี่ยงของตัวเอง ทดสอบบนบัญชี demo ก่อนเสมอ
> ไม่มีการรับประกันใดๆ ผู้เขียนไม่รับผิดชอบความเสียหายจากการใช้งาน การเทรด forex / ทองคำ มีความเสี่ยงสูง อาจสูญเสียเงินทั้งหมด

## ทำอะไรได้บ้าง

- **กราฟ** (KLineChart) ทุก TF, แบ่ง 1/2/4 กราฟ, เครื่องมือวาด, PDH/PDL/PWH/PWL, เปลี่ยน TF ทันทีจาก cache
- **เทรด** Market / Limit / Stop / Stop Limit, คำนวณ lot จาก % ความเสี่ยง, ลากเส้น SL/TP/ราคา pending บนกราฟ, ปิดบางส่วน, BE, Auto BE, OCO, pending หมดอายุ
- **ความปลอดภัยของคำสั่ง**: guard max lot / max positions ต่อบัญชี, บัญชี REAL ต้องอนุญาตเอง, audit log ทุกคำสั่ง
- **อินดิเคเตอร์** แปลงจาก Pine Script: Liquidity Zones, VP Order Blocks, Market Sessions & TPO, OF VWAP, Smart Zone Retest และพื้นฐาน (EMA ฯลฯ)
- **แจ้งเตือน** Telegram + Web Push (เด้งบนมือถือ) จากเหตุการณ์อินดิเคเตอร์และราคา — ทำงานแม้ปิดเว็บ
- **ประวัติเทรด** สรุปกำไร/DD/กราฟเงินสะสม, journal (โน้ต แท็ก รูป), ส่งออก CSV
- **Bar Replay** ฝึกเทรดย้อนหลังพร้อมออเดอร์จำลอง
- **ข่าวเศรษฐกิจ**, order flow BTC/ETH จาก Binance (delta / CVD / OI)
- **หลายบัญชี**: 1 บัญชี = 1 MT5 = 1 worker, เพิ่ม/แก้บัญชีจากหน้าเว็บ
- สำรองข้อมูลอัตโนมัติรายวัน, หน้าสถานะระบบ

## โครงสร้าง

| ส่วน | ชื่อใน pm2 | พอร์ต | หน้าที่ |
|---|---|---|---|
| gateway | `web-terminal` | 8100 | หน้าเว็บ + login + ส่งต่อคำสั่งไป worker |
| worker | `wt-worker-<ชื่อบัญชี>` | 8101, 8102 … | คุยกับ MT5 (1 บัญชี ต่อ 1 worker) |
| order flow | `wt-flow` | 8110 | ข้อมูล Binance (BTC/ETH) |
| แจ้งเตือน | `wt-alerts` | – | Telegram / Web Push |
| Caddy | (แยก) | 80 / 443 | HTTPS + โดเมน → 127.0.0.1:8100 |

ทุกพอร์ตยกเว้น 80/443 ฟังแค่ `127.0.0.1` เข้าจากนอกเครื่องไม่ได้ ทุกอย่างต้องผ่าน Caddy (HTTPS) + login

## สิ่งที่ต้องมี

- Windows 10/11 หรือ Windows Server 2019+ (VPS แนะนำ RAM ≥ 4 GB)
- [Python 3.11+](https://python.org) 64-bit, [Node.js LTS](https://nodejs.org), [Git](https://git-scm.com)
- MetaTrader 5 ของโบรกที่ใช้ + บัญชี (เริ่มจาก demo)
- โดเมนที่ชี้มาที่ IP ของเครื่อง (ใช้ DuckDNS ฟรีได้ แต่ wifi องค์กรบางที่บล็อก — โดเมนจริงผ่านง่ายกว่า) + เปิดพอร์ต 80/443
- [Caddy](https://caddyserver.com/download) สำหรับ HTTPS (ขอใบรับรอง Let's Encrypt ให้เอง)

## ติดตั้ง

### 1. โปรแกรมพื้นฐาน

```bat
npm install -g pm2
```

### 2. MT5

ทำทีละบัญชี:
1. ติดตั้ง MT5 — ตัวที่ 2 ขึ้นไปติดตั้งคนละโฟลเดอร์ (เช่น `C:\Program Files\MetaTrader 5 T2\`)
2. File → Login → ใส่บัญชี ติ๊ก **Save password**
3. Tools → Options → Community → ติ๊ก **Python integration** (ถ้ามีตัวเลือกนี้ ไม่ติ๊ก worker จะต่อไม่ได้)
4. Tools → Options → Expert Advisors → ติ๊ก **Allow algorithmic trading** และกดปุ่ม **Algo Trading** ให้เขียว

### 3. ดึงโค้ด + library

```bat
cd C:\
git clone https://github.com/mee6262/mee-terminal.git
cd mee-terminal
python -m venv venv
venv\Scripts\pip.exe install -r requirements.txt
```

### 4. ไฟล์ `.env`

```bat
copy .env.example .env
venv\Scripts\python.exe hash_password.py
venv\Scripts\python.exe -c "import secrets;print(secrets.token_urlsafe(32))"
```

เปิด `.env` ด้วย Notepad แล้วใส่:

```ini
WT_PASS_HASH=<บรรทัดที่ได้จาก hash_password.py>
WT_ORIGIN=https://terminal.example.com
WT_WORKER_KEY=<ค่าสุ่มที่ได้>
# ไม่บังคับ: แจ้งเตือน Telegram
TELEGRAM_TOKEN=<token จาก @BotFather>
TELEGRAM_CHAT_ID=<chat id ของเรา>
```

- `WT_ORIGIN` = โดเมนจริงที่ใช้เปิดเว็บ (https และสะกดตรงเป๊ะ ไม่งั้น login แล้วเด้งกลับ)
- **ห้าม commit / ส่ง `.env` ให้ใคร** (อยู่ใน `.gitignore` แล้ว)

### 5. บัญชี MT5

แก้ `accounts.json` ให้ `terminal_path` ตรงกับเครื่อง (path ใน JSON ใช้ `\\`):

```json
{ "accounts": [
  { "name": "demo", "kind": "std", "terminal_path": "C:\\Program Files\\MetaTrader 5\\terminal64.exe",
    "port": 8101, "portable": false, "login": null, "server_utc_offset_h": 0,
    "trading": true, "allow_real": false, "magic": 0, "deviation": 20,
    "guards": { "max_lot": 5, "max_positions": 30 } }
] }
```

- `allow_real: false` = บัญชี REAL ส่งคำสั่งไม่ได้ (กันพลาด) — เปิดเองเมื่อพร้อม
- `portable` ต้องตรงกับวิธีติดตั้ง MT5 (ทางลัดมี `/portable` = true)
- `server_utc_offset_h` = เวลา server ของโบรกเทียบ UTC (ถ้ากราฟเวลาเพี้ยน หน้าเว็บจะบอกค่าที่ควรใช้)
- เพิ่ม/แก้บัญชีทีหลังได้จากหน้าเว็บ: ตั้งค่า → บัญชี MT5 → จัดการบัญชี (บันทึกลง `accounts.local.json`)

### 6. เปิดด้วย pm2

```bat
pm2 start ecosystem.config.js
pm2 save
pm2 ls
```

ต้องเห็น `web-terminal`, `wt-worker-…`, `wt-flow`, `wt-alerts` เป็น **online**

กัน log โตจนดิสก์เต็ม:

```bat
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 10M
pm2 set pm2-logrotate:retain 7
pm2 set pm2-logrotate:compress true
```

### 7. โดเมน + HTTPS (Caddy)

`C:\Caddy\Caddyfile`:

```
terminal.example.com {
	encode gzip
	reverse_proxy 127.0.0.1:8100
}
```

ทดสอบ: `caddy run --config C:\Caddy\Caddyfile` (รอบแรกขอใบรับรองเอง — DNS ต้องชี้ถูก และพอร์ต 80/443 ต้องเปิดก่อน)

ให้รันถาวรเป็น Windows service (เปิดเองตอนบูต + restart เองถ้าล่ม) — PowerShell แบบ Administrator:

```powershell
sc.exe create caddy binPath= "`"C:\Caddy\caddy.exe`" run --config C:\Caddy\Caddyfile --adapter caddyfile" start= delayed-auto
sc.exe failure caddy reset= 86400 actions= restart/5000/restart/10000/restart/30000
Start-Service caddy
```

> service รันเป็น LocalSystem — ถ้าเคยรัน Caddy มือมาก่อนและอยากใช้ใบรับรองเดิม ตั้ง env `XDG_DATA_HOME` / `XDG_CONFIG_HOME` ของ service ให้ชี้ `%APPDATA%` ของ user เดิม

### 8. เปิดเองหลังรีบูต

วางทางลัดของ `start_all.ps1` ใน Startup folder (`shell:startup`) เช่นไฟล์ `start_all.cmd`:

```bat
powershell -NoProfile -ExecutionPolicy Bypass -File C:\mee-terminal\start_all.ps1
```

สคริปต์เปิด MT5 ก่อน → Caddy → `pm2 resurrect` (ข้ามตัวที่รันอยู่แล้ว, `-DryRun` ดูว่าจะทำอะไร)
ใช้ทางนี้ทางเดียว อย่าใช้ `pm2-windows-startup` ซ้อน (จะได้ pm2 daemon 2 ตัว)

### 9. ตรวจว่าใช้ได้

- [ ] เปิด `https://terminal.example.com` → หน้า login → เข้าได้
- [ ] แถบบนมี `DEMO/REAL` + จุดเขียว 2 จุด, ราคาวิ่ง, กราฟขึ้น
- [ ] ตั้งค่า → สถานะระบบ: worker ทุกบัญชีเขียว
- [ ] ส่งคำสั่ง 0.01 lot บน demo แล้วปิด → ตรงกับใน MT5
- [ ] มือถือ: Safari → Share → Add to Home Screen (ต้องทำก่อนถึงจะเปิด Web Push บน iPhone ได้)

## อัปเดต

ดับเบิลคลิก `update.bat` — git pull → pip (ถ้า requirements เปลี่ยน) → pm2 restart (ถ้าแก้ฝั่ง server) ถ้าแก้แค่หน้าเว็บ บอกให้รีเฟรชเฉยๆ

## สำรอง / กู้คืน

- สำรองเองวันละชุดที่ `backups\YYYY-MM-DD\` (เก็บ 14 วัน): `web_terminal.db`, `.env`, `accounts.local.json`, ค่า Auto BE / OCO
- backups อยู่ในเครื่องเดียวกัน — คัดลอกออกไปเก็บที่อื่นเป็นระยะ
- กู้คืน: `pm2 stop all` → คัดลอกไฟล์กลับ → `pm2 start all`
- ลืมรหัสเว็บ: รัน `hash_password.py` ใหม่ → แก้ `WT_PASS_HASH` → `pm2 restart web-terminal --update-env`
- สงสัยรหัสหลุด: ทำข้อบน + ลบ `web_terminal.db` (เตะทุก session; การตั้งค่าในเว็บจะหายด้วย)

## ความปลอดภัย

- login เดียว (รหัสผ่าน hash แบบ scrypt), session 7 วัน, ล็อก IP 5 ครั้งผิด
- ตรวจ Origin ทุก POST, security headers / CSP, worker รับเฉพาะ key ร่วมจาก gateway
- ทุกบริการภายในฟังแค่ `127.0.0.1`
- แนะนำ: ใช้รหัสยาว, ปิด RDP จากภายนอกหรือจำกัด IP, เปิด Windows Update เป็นระยะ

## ปัญหาที่เจอบ่อย

| อาการ | วิธีแก้ |
|---|---|
| worker: `Pipe server didn't answer` / `-10003` | MT5 → Options → Community ติ๊ก **Python integration**; ตรวจ `portable` ให้ตรงกับการติดตั้ง |
| worker: "ต่อได้ terminal ผิดตัว" | `terminal_path` ผิด หรือ MT5 2 ตัวใช้โฟลเดอร์เดียวกัน |
| ส่งคำสั่งได้ retcode 10027 / AutoTrading disabled | ปุ่ม Algo Trading ใน MT5 ต้องเขียว |
| "บัญชี REAL แต่ไม่ได้ตั้ง allow_real" | ติ๊กอนุญาตในหน้าจัดการบัญชี (ตั้งใจให้ต้องทำเอง) |
| login แล้วเด้งกลับหน้า login | `WT_ORIGIN` ไม่ตรงกับโดเมนที่เปิดจริง |
| เว็บไม่ขึ้น / ใบรับรองไม่ออก | DNS ยังไม่ชี้ IP นี้ หรือพอร์ต 80/443 ปิดอยู่ |
| `pip install` error `cp874` | ใช้ `requirements.txt` ล่าสุด (ASCII ล้วน) |
| เข้าจาก wifi ที่ทำงาน/โรงพยาบาลไม่ได้ | เครือข่ายบล็อกโดเมนฟรี (เช่น duckdns) — ใช้เน็ตมือถือ/VPN หรือโดเมนจริง |

## ทดสอบ

```bat
venv\Scripts\python.exe -m unittest discover -s tests
for %f in (tests\js\*.js) do node %f
```

ใช้ MT5 ปลอม (`tests/fake_mt5.py`) ไม่ต้องเปิด MT5 จริง

## เอกสารอื่น

- `docs/DEV_NOTES_TH.md` — รายละเอียดฟีเจอร์ + acceptance แต่ละรอบ
- `docs/PINE_PORT_TH.md` — วิธีให้ AI แปลงอินดิเคเตอร์ Pine Script มาใส่ระบบ
- `docs/PERF_PLAN.md` — งานปรับความเร็ว

## License

โค้ดของโปรเจ็กต์: **MIT** (ดู `LICENSE`) ยกเว้นไฟล์ต่อไปนี้ที่แปลงจาก Pine Script ของผู้เขียนอื่น ใช้ license ของต้นฉบับ:

| ไฟล์ | ต้นฉบับ | License |
|---|---|---|
| `static/indicators/liquidity_zones.js` | Dynamic Liquidity Zones | MPL-2.0 |
| `static/indicators/mx_suite.js` | Mxwll Price Action Suite © Mxwll Capital | MPL-2.0 |
| `static/indicators/sessions_tpo.js` | Market Sessions and TPO © Mxwll Capital | MPL-2.0 |
| `static/indicators/smart_zone_retest.js` | Smart Zone Retest © FXProSystems | MPL-2.0 |
| `static/indicators/vp_order_blocks.js` | Volume Profile Bar-Magnified Order Blocks © JacobMagleby | MPL-2.0 |
| `static/indicators/of_vwap.js` | Order Flow VWAP Deviation © LuxAlgo | **CC BY-NC-SA 4.0** (ห้ามใช้เชิงพาณิชย์) |
| `static/vendor/klinecharts-*.min.js` | KLineChart | Apache-2.0 |
