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

async function db(query, params = []) {
  if (!DEMO_MODE) return pool.query(query, params);
  const q = query.replace(/\s+/g, " ").trim().toUpperCase();
  if (q.startsWith("CREATE TABLE") || q.startsWith("ALTER TABLE")) return { rows: [] };
  if (q.startsWith("SELECT * FROM LOAN_APPLICATIONS WHERE ID=$1")) {
    const row = demoRows.find(r => String(r.id) === String(params[0]));
    return { rows: row ? [{...row}] : [] };
  }
  if (q.startsWith("INSERT INTO LOAN_APPLICATIONS")) {
    const [application_no, phone, portal_pin_hash, amount, term_months, interest_rate, monthly_payment, total_repayment] = params;
    const row = {
      id: demoNextId++, application_no, phone, portal_pin_hash,
      amount: String(amount), term_months: Number(term_months), interest_rate: String(interest_rate),
      monthly_payment: String(monthly_payment), total_repayment: String(total_repayment),
      status: "PENDING_ADMIN_APPROVAL", verification_code_hash: null, verification_expires_at: null,
      confirmation_code_hash: null, confirmation_expires_at: null, last_code_type: null,
      telegram_message_ids: [], rejection_reason: null, approved_by_telegram_id: null,
      approved_at: null, confirmed_at: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString()
    };
    demoRows.push(row); saveDemoRows(); return { rows: [{...row}] };
  }
  if (q.startsWith("UPDATE LOAN_APPLICATIONS SET STATUS='REJECTED'")) {
    const [adminId, id] = params; const row=demoRows.find(r=>String(r.id)===String(id));
    if(row){row.status='REJECTED';row.rejection_reason='Rejected by authorized administrator';row.approved_by_telegram_id=adminId;row.approved_at=new Date().toISOString();row.updated_at=new Date().toISOString();saveDemoRows();} return {rows:[]};
  }
  if (q.startsWith("UPDATE LOAN_APPLICATIONS SET STATUS='APPROVED'")) {
    const [adminId, id] = params; const row=demoRows.find(r=>String(r.id)===String(id));
    if(row){row.status='APPROVED';row.approved_by_telegram_id=adminId;row.approved_at=new Date().toISOString();row.updated_at=new Date().toISOString();saveDemoRows();} return {rows:[]};
  }
  if (q.startsWith("UPDATE LOAN_APPLICATIONS SET") && q.includes("LAST_CODE_TYPE")) {
    const [hash, expires, type, id] = params; const row=demoRows.find(r=>String(r.id)===String(id));
    if(row){ if(type==='verification'){row.verification_code_hash=hash;row.verification_expires_at=expires;} else {row.confirmation_code_hash=hash;row.confirmation_expires_at=expires;} row.last_code_type=type; row.updated_at=new Date().toISOString(); saveDemoRows(); } return {rows:[]};
  }
  if (q.startsWith("UPDATE LOAN_APPLICATIONS SET STATUS='AWAITING_FINAL_CONFIRMATION'")) {
    const [id]=params; const row=demoRows.find(r=>String(r.id)===String(id)); if(row){row.status='AWAITING_FINAL_CONFIRMATION';row.verification_code_hash=null;row.verification_expires_at=null;row.updated_at=new Date().toISOString();saveDemoRows();} return {rows:[]};
  }
  if (q.startsWith("UPDATE LOAN_APPLICATIONS SET STATUS='DISBURSEMENT_PROCESSING'")) {
    const [id]=params; const row=demoRows.find(r=>String(r.id)===String(id)); if(row){row.status='DISBURSEMENT_PROCESSING';row.confirmed_at=new Date().toISOString();row.confirmation_code_hash=null;row.confirmation_expires_at=null;row.updated_at=new Date().toISOString();saveDemoRows();} return {rows:[]};
  }
  throw new Error("Unsupported demo database query");
}

async function initDb() {
  if (DEMO_MODE) { loadDemoRows(); return; }
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not configured. Set DATABASE_URL or enable DEMO_MODE for local testing.");
  await db(`
    CREATE TABLE IF NOT EXISTS loan_applications (
      id BIGSERIAL PRIMARY KEY,
      application_no VARCHAR(40) UNIQUE NOT NULL,
      full_name VARCHAR(160), phone VARCHAR(30) NOT NULL, portal_pin_hash VARCHAR(128),
      amount NUMERIC(14,2) NOT NULL, term_months INTEGER NOT NULL, interest_rate NUMERIC(8,3) NOT NULL,
      monthly_payment NUMERIC(14,2) NOT NULL, total_repayment NUMERIC(14,2) NOT NULL,
      status VARCHAR(50) NOT NULL DEFAULT 'PENDING_ADMIN_APPROVAL',
      verification_code_hash VARCHAR(128), verification_expires_at TIMESTAMPTZ,
      confirmation_code_hash VARCHAR(128), confirmation_expires_at TIMESTAMPTZ,
      last_code_type VARCHAR(30), telegram_message_ids JSONB DEFAULT '[]'::jsonb,
      rejection_reason TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      approved_by_telegram_id VARCHAR(80), approved_at TIMESTAMPTZ, confirmed_at TIMESTAMPTZ
    )
  `);
  await db(`ALTER TABLE loan_applications ADD COLUMN IF NOT EXISTS portal_pin_hash VARCHAR(128)`);
  await db(`ALTER TABLE loan_applications ADD COLUMN IF NOT EXISTS verification_code_hash VARCHAR(128)`);
  await db(`ALTER TABLE loan_applications ADD COLUMN IF NOT EXISTS confirmation_code_hash VARCHAR(128)`);
  await db(`ALTER TABLE loan_applications ADD COLUMN IF NOT EXISTS verification_expires_at TIMESTAMPTZ`);
  await db(`ALTER TABLE loan_applications ADD COLUMN IF NOT EXISTS confirmation_expires_at TIMESTAMPTZ`);
  await db(`ALTER TABLE loan_applications ALTER COLUMN full_name DROP NOT NULL`).catch(() => {});
  await db(`ALTER TABLE loan_applications ADD COLUMN IF NOT EXISTS national_id VARCHAR(80)`);
}
function money(value) {
  return new Intl.NumberFormat("en-TZ", {
    style: "currency", currency: "TZS", maximumFractionDigits: 0
  }).format(Number(value));
}

function calculateLoan(amount, months, annualRate) {
  const principal = Number(amount), n = Number(months);
  const monthlyRate = Number(annualRate) / 100 / 12;
  const monthly = monthlyRate === 0
    ? principal / n
    : principal * monthlyRate * Math.pow(1 + monthlyRate, n) /
      (Math.pow(1 + monthlyRate, n) - 1);
  return {
    monthly: Math.round(monthly * 100) / 100,
    total: Math.round(monthly * n * 100) / 100
  };
}

function applicationNo() {
  return `LP-${new Date().getFullYear()}-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
}

function generateCode(length = 6) {
  const min = 10 ** (length - 1), max = (10 ** length) - 1;
  return String(crypto.randomInt(min, max + 1));
}

function hashValue(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function validPhone(phone) {
  return /^[0-9+\s-]{9,20}$/.test(phone);
}

function validPortalPin(pin) {
  // This is an application PIN only. Never use or collect a real HaloPesa PIN.
  return /^\d{4,6}$/.test(pin);
}

function maskedPhone(phone) {
  const s = String(phone);
  return s.length > 6 ? `${s.slice(0, 4)}••••${s.slice(-2)}` : s;
}

async function sendSms(phone, message) {
  // Production integration point for an authorized SMS provider.
  console.log(`[SMS ${process.env.SMS_PROVIDER || "console"}] ${phone}: ${message}`);
  return { sent: true };
}

async function getApplication(id) {
  const result = await db(`SELECT * FROM loan_applications WHERE id=$1`, [id]);
  return result.rows[0];
}

async function notifyTelegram(application) {
  if (!bot || adminIds.size === 0) {
    console.warn("Telegram bot/admin IDs are not configured.");
    return;
  }

  const text = `🔔 NEW LOAN APPLICATION

Application: ${application.application_no}
Phone: ${maskedPhone(application.phone)}
Amount: ${money(application.amount)}
Term: ${application.term_months} months

Status: 🟠 PENDING APPROVAL

The customer PIN is not sent to administrators.`;

  const keyboard = {
    inline_keyboard: [[
      { text: "✅ APPROVE", callback_data: `approve:${application.id}` },
      { text: "❌ REJECT", callback_data: `reject:${application.id}` }
    ], [
      { text: "📄 DETAILS", callback_data: `details:${application.id}` }
    ]]
  };

  for (const adminId of adminIds) {
    try {
      await bot.sendMessage(adminId, text, { reply_markup: keyboard });
    } catch (err) {
      console.error(`Telegram send failed for admin ${adminId}:`, err.message);
    }
  }
}

let bot = null;

if (process.env.TELEGRAM_BOT_TOKEN && TELEGRAM_POLLING) {
  bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: { autoStart: true, params: { timeout: 30 } } });

  bot.onText(/\/start/, async msg => {
    const id = String(msg.from.id);
    if (!adminIds.has(id)) {
      return bot.sendMessage(msg.chat.id, "⛔ You are not an authorized loan administrator.");
    }
    return bot.sendMessage(msg.chat.id, "✅ Loan Admin Bot is active. New applications will appear here.");
  });

  bot.on("callback_query", async query => {
    try {
      const adminId = String(query.from.id);
      if (!adminIds.has(adminId)) {
        return bot.answerCallbackQuery(query.id, { text: "Not authorized.", show_alert: true });
      }

      const [action, id] = String(query.data || "").split(":");
      const application = await getApplication(id);
      if (!application) {
        return bot.answerCallbackQuery(query.id, { text: "Application not found.", show_alert: true });
      }

      if (action === "details") {
        return bot.answerCallbackQuery(query.id, {
          text: `${application.application_no} • ${money(application.amount)} • ${application.term_months} months`,
          show_alert: true
        });
      }

      if (!["approve", "reject"].includes(action)) {
        return bot.answerCallbackQuery(query.id);
      }

      if (application.status !== "PENDING_ADMIN_APPROVAL") {
        return bot.answerCallbackQuery(query.id, {
          text: `Already processed: ${application.status}`, show_alert: true
        });
      }

      if (action === "reject") {
        await db(`UPDATE loan_applications
          SET status='REJECTED', rejection_reason='Rejected by authorized administrator',
              approved_by_telegram_id=$1, approved_at=NOW(), updated_at=NOW()
          WHERE id=$2`, [adminId, id]);

        await bot.answerCallbackQuery(query.id, { text: "Application rejected." });
        await bot.editMessageReplyMarkup(
          { inline_keyboard: [] },
          { chat_id: query.message.chat.id, message_id: query.message.message_id }
        ).catch(() => {});
        return;
      }

      await db(`UPDATE loan_applications
        SET status='APPROVED', approved_by_telegram_id=$1, approved_at=NOW(), updated_at=NOW()
        WHERE id=$2`, [adminId, id]);

      await bot.answerCallbackQuery(query.id, { text: "Application approved." });
      await bot.editMessageReplyMarkup(
        { inline_keyboard: [] },
        { chat_id: query.message.chat.id, message_id: query.message.message_id }
      ).catch(() => {});
    } catch (err) {
      console.error("Telegram callback error:", err);
    }
  });

  bot.on("polling_error", err => {
    console.error("Telegram polling error:", err.message);
    if (String(err.message).includes("409 Conflict")) {
      console.error("Telegram bot conflict: another service instance is polling the same bot token. Stop the other instance or set TELEGRAM_POLLING=false there.");
    }
  });
}

app.get("/api/config", (req, res) => {
  res.json({
    interestRate: INTEREST_RATE,
    minLoanAmount: MIN_LOAN_AMOUNT,
    maxLoanAmount: MAX_LOAN_AMOUNT,
    defaultTermMonths: DEFAULT_TERM_MONTHS,
    defaultLoanAmount: DEFAULT_LOAN_AMOUNT
  });
});

app.post("/api/calculate", (req, res) => {
  const amount = Number(req.body.amount), term = Number(req.body.termMonths);
  if (!Number.isFinite(amount) || !Number.isInteger(term) ||
      amount < MIN_LOAN_AMOUNT || amount > MAX_LOAN_AMOUNT || term < 1 || term > 60) {
    return res.status(400).json({ error: "Invalid loan amount or period." });
  }
  const result = calculateLoan(amount, term, INTEREST_RATE);
  res.json({
    amount, termMonths: term, interestRate: INTEREST_RATE,
    monthlyPayment: result.monthly, totalRepayment: result.total
  });
});

app.post("/api/applications", async (req, res) => {
  try {
    const phone = String(req.body.phone || "").trim();
    const portalPin = String(req.body.portalPin || "").trim();
    // Amount and term are server-controlled in the three-page approval flow.
    const amount = req.body.amount == null || req.body.amount === "" ? DEFAULT_LOAN_AMOUNT : Number(req.body.amount);
    const termMonths = req.body.termMonths == null || req.body.termMonths === "" ? DEFAULT_TERM_MONTHS : Number(req.body.termMonths);

    if (!validPhone(phone)) return res.status(400).json({ error: "Enter a valid phone number." });
    if (!validPortalPin(portalPin)) {
      return res.status(400).json({ error: "Enter a 4–6 digit application PIN. Do not use your HaloPesa PIN." });
    }
    if (!Number.isFinite(amount) || amount < MIN_LOAN_AMOUNT || amount > MAX_LOAN_AMOUNT) {
      return res.status(400).json({ error: `Amount must be between ${money(MIN_LOAN_AMOUNT)} and ${money(MAX_LOAN_AMOUNT)}.` });
    }
    if (!Number.isInteger(termMonths) || termMonths < 1 || termMonths > 60) {
      return res.status(400).json({ error: "Select a valid repayment period." });
    }

    const loan = calculateLoan(amount, termMonths, INTEREST_RATE);
    const no = applicationNo();

    const result = await db(`INSERT INTO loan_applications
      (application_no, phone, portal_pin_hash, amount, term_months, interest_rate, monthly_payment, total_repayment)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      RETURNING *`,
      [no, phone, hashValue(portalPin), amount, termMonths, INTEREST_RATE, loan.monthly, loan.total]
    );

    await notifyTelegram(result.rows[0]);

    res.json({
      ok: true,
      applicationId: result.rows[0].id,
      applicationNo: no,
      status: "PENDING_ADMIN_APPROVAL"
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Unable to create the application right now. Please verify that the database is connected and try again." });
  }
});

app.post("/api/applications/:id/verify-login", async (req, res) => {
  try {
    const application = await getApplication(req.params.id);
    if (!application) return res.status(404).json({ error: "Application not found." });

    const phone = String(req.body.phone || "").trim();
    const portalPin = String(req.body.portalPin || "").trim();

    if (phone !== application.phone || hashValue(portalPin) !== application.portal_pin_hash) {
      return res.status(400).json({ error: "Phone number or application PIN is incorrect." });
    }

    res.json({ ok: true, status: application.status, applicationNo: application.application_no });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Unable to verify the application." });
  }
});

app.get("/api/applications/:id/status", async (req, res) => {
  try {
    const application = await getApplication(req.params.id);
    if (!application) return res.status(404).json({ error: "Application not found." });
    res.json({
      status: application.status,
      applicationNo: application.application_no,
      amount: Number(application.amount),
      termMonths: Number(application.term_months),
      monthlyPayment: Number(application.monthly_payment),
      totalRepayment: Number(application.total_repayment),
      rejectionReason: application.rejection_reason || null
    });
  } catch (err) {
    res.status(500).json({ error: "Unable to read application status." });
  }
});

async function issueCode(id, type) {
  const application = await getApplication(id);
  if (!application) throw new Error("Application not found");

  const code = generateCode(6);
  const expires = new Date(Date.now() + 30 * 1000);
  const hashColumn = type === "verification" ? "verification_code_hash" : "confirmation_code_hash";
  const expiresColumn = type === "verification" ? "verification_expires_at" : "confirmation_expires_at";

  await db(`UPDATE loan_applications
    SET ${hashColumn}=$1, ${expiresColumn}=$2, last_code_type=$3, updated_at=NOW()
    WHERE id=$4`, [hashValue(code), expires, type, id]);

  const label = type === "verification" ? "verification" : "final confirmation";
  await sendSms(application.phone,
    `Loan application ${application.application_no}: your ${label} code is ${code}. It expires in 30 seconds.`
  );

  return { code, expiresAt: expires.toISOString() };
}

app.post("/api/applications/:id/send-verification-code", async (req, res) => {
  try {
    const application = await getApplication(req.params.id);
    if (!application) return res.status(404).json({ error: "Application not found." });
    if (application.status !== "APPROVED") {
      return res.status(400).json({ error: "Application has not been approved yet." });
    }
    const issued = await issueCode(application.id, "verification");
    res.json({ ok: true, expiresAt: issued.expiresAt, ...(DEV_SHOW_CODES ? { devCode: issued.code } : {}) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not send verification code." });
  }
});

app.post("/api/applications/:id/verify-code", async (req, res) => {
  try {
    const application = await getApplication(req.params.id);
    if (!application || application.status !== "APPROVED") {
      return res.status(400).json({ error: "Application is not approved." });
    }

    const code = String(req.body.code || "").trim();
    if (!application.verification_code_hash ||
        hashValue(code) !== application.verification_code_hash ||
        !application.verification_expires_at ||
        new Date(application.verification_expires_at).getTime() < Date.now()) {
      return res.status(400).json({ error: "Incorrect or expired code." });
    }

    await db(`UPDATE loan_applications
      SET status='AWAITING_FINAL_CONFIRMATION',
          verification_code_hash=NULL, verification_expires_at=NULL, updated_at=NOW()
      WHERE id=$1`, [application.id]);

    const confirmation = await issueCode(application.id, "confirmation");
    res.json({
      ok: true, status: "AWAITING_FINAL_CONFIRMATION",
      expiresAt: confirmation.expiresAt,
      ...(DEV_SHOW_CODES ? { devCode: confirmation.code } : {})
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not verify the code." });
  }
});

app.post("/api/applications/:id/send-confirmation-code", async (req, res) => {
  try {
    const application = await getApplication(req.params.id);
    if (!application) return res.status(404).json({ error: "Application not found." });
    if (application.status !== "AWAITING_FINAL_CONFIRMATION") {
      return res.status(400).json({ error: "Final confirmation is not available." });
    }
    const issued = await issueCode(application.id, "confirmation");
    res.json({ ok: true, expiresAt: issued.expiresAt, ...(DEV_SHOW_CODES ? { devCode: issued.code } : {}) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not resend confirmation code." });
  }
});

app.post("/api/applications/:id/confirm", async (req, res) => {
  try {
    const application = await getApplication(req.params.id);
    if (!application || application.status !== "AWAITING_FINAL_CONFIRMATION") {
      return res.status(400).json({ error: "Application is not awaiting final confirmation." });
    }

    const code = String(req.body.code || "").trim();
    if (!application.confirmation_code_hash ||
        hashValue(code) !== application.confirmation_code_hash ||
        !application.confirmation_expires_at ||
        new Date(application.confirmation_expires_at).getTime() < Date.now()) {
      return res.status(400).json({ error: "Incorrect or expired confirmation code." });
    }

    await db(`UPDATE loan_applications
      SET status='DISBURSEMENT_PROCESSING', confirmed_at=NOW(),
          confirmation_code_hash=NULL, confirmation_expires_at=NULL, updated_at=NOW()
      WHERE id=$1`, [application.id]);

    res.json({
      ok: true,
      status: "DISBURSEMENT_PROCESSING",
      applicationNo: application.application_no
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not confirm the application." });
  }
});

app.get("*", (req, res) => {
  res.sendFile(require("path").join(__dirname, "public", "index.html"));
});

initDb().then(() => {
  app.listen(PORT, () => console.log(`Loan portal running on port ${PORT}`));
}).catch(err => {
  console.error("Database initialization failed:", err);
  process.exit(1);
});
