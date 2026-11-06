// pm2 สำหรับ web_terminal แยกจาก ecosystem.config.js หลัก (ไม่แตะไฟล์ production เดิม)
// ใช้: cd web_terminal && pm2 start ecosystem.config.js && pm2 save
// secrets อยู่ใน web_terminal/.env (gitignored) — ดู .env.example
const path = require("path");
const fs = require("fs");
const VENV = path.join(__dirname, "venv", "Scripts");

function loadDotEnv(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  let text = fs.readFileSync(file, "utf8");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

const dotenv = loadDotEnv(path.join(__dirname, ".env"));
const rootEnv = {};
// accounts.local.json (บันทึกจากหน้าเว็บ ไม่อยู่ใน git) มาก่อน accounts.json
const accFile = ["accounts.local.json", "accounts.json"].map((f) => path.join(__dirname, f)).find((f) => fs.existsSync(f));
const accounts = JSON.parse(fs.readFileSync(accFile, "utf8").replace(/^\uFEFF/, "")).accounts;
const common = { interpreter: "none", cwd: __dirname, autorestart: true, restart_delay: 5000, time: true };
const UVICORN = path.join(VENV, "uvicorn.exe");

module.exports = {
  apps: [
    {
      ...common,
      name: "web-terminal",
      script: UVICORN,
      args: "gateway:app --host 127.0.0.1 --port 8100 --proxy-headers --forwarded-allow-ips 127.0.0.1",
      env: { PYTHONUTF8: "1", ...dotenv },
    },
    // 1 worker ต่อ 1 บัญชีใน accounts.json (เพิ่มบัญชี = แก้ accounts.json แล้ว pm2 start ecosystem.config.js ใหม่)
    ...accounts.map((a) => ({
      ...common,
      name: `wt-worker-${a.name}`,
      script: UVICORN,
      args: `worker:app --host 127.0.0.1 --port ${a.port} --no-access-log`,   // access log = /tick /rates จาก wt-alerts ทุก 2 วินาที (~10-100 MB/วัน); WARNING/ERROR ยังลง log
      restart_delay: 10000,
      env: { PYTHONUTF8: "1", WT_WORKER_KEY: dotenv.WT_WORKER_KEY, WT_ACCOUNT: a.name,
        WT_MT5_INPROC: dotenv.WT_MT5_INPROC || "" },   // "1" = เรียก MT5 ใน process เดียว (โหมดเดิม ไว้ถอยกลับ)
    })),
    // order flow จาก Binance futures (BTC/ETH): delta / CVD / volume profile / ล้างพอร์ต / OI
    {
      ...common,
      name: "wt-flow",
      script: UVICORN,
      args: "flow:app --host 127.0.0.1 --port 8110 --no-access-log",
      env: { PYTHONUTF8: "1", WT_WORKER_KEY: dotenv.WT_WORKER_KEY, WT_FLOW_SYMBOLS: dotenv.WT_FLOW_SYMBOLS || "BTCUSDT:5,ETHUSDT:0.5" },
    },
    // alert อินดิเคเตอร์ -> Telegram (Node ตัวเดียวกับที่ pm2 ใช้)
    {
      ...common,
      name: "wt-alerts",
      script: path.join(__dirname, "alerts", "alert_service.js"),
      interpreter: "node",
      env: {
        WT_WORKER_KEY: dotenv.WT_WORKER_KEY,
        TELEGRAM_TOKEN: dotenv.TELEGRAM_TOKEN || rootEnv.TELEGRAM_TOKEN || "",
        TELEGRAM_CHAT_ID: dotenv.TELEGRAM_CHAT_ID || rootEnv.TELEGRAM_CHAT_ID || "",
      },
    },
  ],
};
