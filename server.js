require("dotenv").config();

const express = require("express");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const crypto = require("crypto");
const { Pool } = require("pg");
const TelegramBot = require("node-telegram-bot-api");

const app = express();
const PORT = Number(process.env.PORT || 10000);
const APP_BASE_URL = process.env.APP_BASE_URL || `http://localhost:${PORT}`;
const INTEREST_RATE = Number(process.env.INTEREST_RATE || 5);
const MIN_LOAN_AMOUNT = Number(process.env.MIN_LOAN_AMOUNT || 50000);
const MAX_LOAN_AMOUNT = Number(process.env.MAX_LOAN_AMOUNT || 5000000);
const DEFAULT_TERM_MONTHS = Number(process.env.DEFAULT_TERM_MONTHS || 3);
const DEV_SHOW_CODES = String(process.env.DEV_SHOW_CODES || "false").toLowerCase() === "true";

const adminIds = new Set(
  String(process.env.TELEGRAM_ADMIN_IDS || "")
    .split(",")
    .map(v => v.trim())
    .filter(Boolean)
);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false
});

app.use(helmet({
  contentSecurityPolicy: false
}));
app.use(express.json({ limit: "100kb" }));
app.use(express.urlencoded({ extended: false }));
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false
}));
app.use(express.static("public"));

async function db(query, params = []) {
  const result = await pool.query(query, params);
  return result;
}

async function initDb() {
  await db(`
    CREATE TABLE IF NOT EXISTS loan_applications (
      id BIGSERIAL PRIMARY KEY,
      application_no VARCHAR(40) UNIQUE NOT NULL,
      full_name VARCHAR(160) NOT NULL,
      phone VARCHAR(30) NOT NULL,
      national_id VARCHAR(80) NOT NULL,
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
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      approved_by_telegram_id VARCHAR(80),
      approved_at TIMESTAMPTZ,
      confirmed_at TIMESTAMPTZ
    )
  `);
}

function money(value) {
  return new Intl.NumberFormat("en-TZ", {
    style: "currency",
    currency: "TZS",
    maximumFractionDigits: 0
  }).format(Number(value));
}

function calculateLoan(amount, months, annualRate) {
  const principal = Number(amount);
  const n = Number(months);
  const monthlyRate = Number(annualRate) / 100 / 12;

  // Simple amortization calculation.
  let monthly;
  if (monthlyRate === 0) {
    monthly = principal / n;
  } else {
    monthly = principal * monthlyRate * Math.pow(1 + monthlyRate, n) /
      (Math.pow(1 + monthlyRate, n) - 1);
  }

  const total = monthly * n;
  return {
    monthly: Math.round(monthly * 100) / 100,
    total: Math.round(total * 100) / 100
  };
}

function applicationNo() {
  return `LP-${new Date().getFullYear()}-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
}

function generateCode(length = 6) {
  const min = Math.pow(10, length - 1);
  const max = Math.pow(10, length) - 1;
  return String(crypto.randomInt(min, max + 1));
}

function hashCode(code) {
  return crypto.createHash("sha256").update(String(code)).digest("hex");
}

function maskPhone(phone) {
  const s = String(phone);
  if (s.length < 7) return s;
  return s.slice(0, 4) + "••••" + s.slice(-2);
}

async function sendSms(phone, message) {
  // Production integration point.
  // Connect only to an SMS provider authorized by the business.
  console.log(`[SMS ${process.env.SMS_PROVIDER || "console"}] ${phone}: ${message}`);
  return { sent: true };
}

async function getApplication(id) {
  const result = await db(`SELECT * FROM loan_applications WHERE id = $1`, [id]);
  return result.rows[0];
}

async function notifyTelegram(application) {
  if (!bot || adminIds.size === 0) {
    console.warn("Telegram bot/admin IDs are not configured.");
    return;
  }

  const text =
`🔔 NEW LOAN APPLICATION

Application: ${application.application_no}
Customer: ${application.full_name}
Phone: ${maskPhone(application.phone)}

Amount: ${money(application.amount)}
Period: ${application.term_months} Months
Interest: ${application.interest_rate}%
Monthly: ${money(application.monthly_payment)}
Total: ${money(application.total_repayment)}

Status: 🟠 PENDING APPROVAL`;

  const keyboard = {
    inline_keyboard: [
      [
        { text: "✅ APPROVE", callback_data: `approve:${application.id}` },
        { text: "❌ REJECT", callback_data: `reject:${application.id}` }
      ],
      [
        { text: "📄 DETAILS", callback_data: `details:${application.id}` }
      ]
    ]
  };

  const ids = [];
  for (const adminId of adminIds) {
    try {
      const sent = await bot.sendMessage(adminId, text, { reply_markup: keyboard });
      ids.push({ chat_id: adminId, message_id: sent.message_id });
    } catch (err) {
      console.error(`Telegram send failed for admin ${adminId}:`, err.message);
    }
  }

  if (ids.length) {
    await db(
      `UPDATE loan_applications SET telegram_message_ids = $1, updated_at = NOW() WHERE id = $2`,
      [JSON.stringify(ids), application.id]
    );
  }
}

let bot = null;

if (process.env.TELEGRAM_BOT_TOKEN) {
  bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });

  bot.onText(/\/start/, async (msg) => {
    const id = String(msg.from.id);
    if (!adminIds.has(id)) {
      return bot.sendMessage(msg.chat.id, "⛔ You are not an authorized loan administrator.");
    }
    bot.sendMessage(
      msg.chat.id,
      "✅ Loan Admin Bot is active.\n\nNew applications will appear here for approval."
    );
  });

  bot.on("callback_query", async (query) => {
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
        text: `Already processed: ${application.status}`,
        show_alert: true
      });
    }

    if (action === "reject") {
      await db(
        `UPDATE loan_applications
         SET status='REJECTED', rejection_reason='Rejected by Telegram administrator',
             approved_by_telegram_id=$1, approved_at=NOW(), updated_at=NOW()
         WHERE id=$2`,
        [adminId, id]
      );

      await bot.answerCallbackQuery(query.id, { text: "Application rejected." });
      await bot.editMessageReplyMarkup(
        { inline_keyboard: [] },
        { chat_id: query.message.chat.id, message_id: query.message.message_id }
      ).catch(() => {});

      await bot.sendMessage(
        query.message.chat.id,
        `❌ ${application.application_no} REJECTED\n\nThe customer will be returned to the verification step.`
      ).catch(() => {});
      return;
    }

    await db(
      `UPDATE loan_applications
       SET status='APPROVED', approved_by_telegram_id=$1, approved_at=NOW(), updated_at=NOW()
       WHERE id=$2`,
      [adminId, id]
    );

    await bot.answerCallbackQuery(query.id, { text: "Application approved." });
    await bot.editMessageReplyMarkup(
      { inline_keyboard: [] },
      { chat_id: query.message.chat.id, message_id: query.message.message_id }
    ).catch(() => {});

    await bot.sendMessage(
      query.message.chat.id,
      `✅ ${application.application_no} APPROVED\n\nCustomer can continue to the verification-code step.`
    ).catch(() => {});
  });

  bot.on("polling_error", (err) => console.error("Telegram polling error:", err.message));
}

app.get("/api/config", (req, res) => {
  res.json({
    interestRate: INTEREST_RATE,
    minLoanAmount: MIN_LOAN_AMOUNT,
    maxLoanAmount: MAX_LOAN_AMOUNT,
    defaultTermMonths: DEFAULT_TERM_MONTHS
  });
});

app.post("/api/calculate", (req, res) => {
  const amount = Number(req.body.amount);
  const term = Number(req.body.termMonths);

  if (!Number.isFinite(amount) || !Number.isFinite(term) ||
      amount < MIN_LOAN_AMOUNT || amount > MAX_LOAN_AMOUNT ||
      term < 1 || term > 60) {
    return res.status(400).json({ error: "Invalid loan amount or period." });
  }

  const result = calculateLoan(amount, term, INTEREST_RATE);
  res.json({
    amount,
    termMonths: term,
    interestRate: INTEREST_RATE,
    monthlyPayment: result.monthly,
    totalRepayment: result.total
  });
});

app.post("/api/applications", async (req, res) => {
  try {
    const fullName = String(req.body.fullName || "").trim();
    const phone = String(req.body.phone || "").trim();
    const nationalId = String(req.body.nationalId || "").trim();
    const amount = Number(req.body.amount);
    const termMonths = Number(req.body.termMonths);

    if (!fullName || fullName.length < 3) {
      return res.status(400).json({ error: "Enter a valid full name." });
    }
    if (!/^[0-9+\\s-]{9,20}$/.test(phone)) {
      return res.status(400).json({ error: "Enter a valid phone number." });
    }
    if (!nationalId || nationalId.length < 5) {
      return res.status(400).json({ error: "Enter a valid NIDA/ID number." });
    }
    if (!Number.isFinite(amount) || amount < MIN_LOAN_AMOUNT || amount > MAX_LOAN_AMOUNT) {
      return res.status(400).json({ error: `Amount must be between ${money(MIN_LOAN_AMOUNT)} and ${money(MAX_LOAN_AMOUNT)}.` });
    }
    if (!Number.isInteger(termMonths) || termMonths < 1 || termMonths > 60) {
      return res.status(400).json({ error: "Select a valid repayment period." });
    }

    const loan = calculateLoan(amount, termMonths, INTEREST_RATE);
    const no = applicationNo();

    const result = await db(
      `INSERT INTO loan_applications
       (application_no, full_name, phone, national_id, amount, term_months, interest_rate, monthly_payment, total_repayment)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING *`,
      [no, fullName, phone, nationalId, amount, termMonths, INTEREST_RATE, loan.monthly, loan.total]
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
    res.status(500).json({ error: "Unable to create the application right now." });
  }
});

app.post("/api/applications/:id/verify-details", async (req, res) => {
  try {
    const application = await getApplication(req.params.id);
    if (!application) return res.status(404).json({ error: "Application not found." });

    const phone = String(req.body.phone || "").trim();
    const nationalId = String(req.body.nationalId || "").trim();

    if (phone !== application.phone || nationalId !== application.national_id) {
      return res.status(400).json({ error: "The details do not match this application." });
    }

    if (application.status === "REJECTED") {
      return res.json({ ok: true, status: "REJECTED" });
    }

    res.json({
      ok: true,
      status: application.status,
      applicationNo: application.application_no
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Verification failed." });
  }
});

app.get("/api/applications/:id/status", async (req, res) => {
  try {
    const application = await getApplication(req.params.id);
    if (!application) return res.status(404).json({ error: "Application not found." });

    res.json({
      status: application.status,
      applicationNo: application.application_no,
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

  await db(
    `UPDATE loan_applications
     SET ${hashColumn}=$1, ${expiresColumn}=$2, last_code_type=$3, updated_at=NOW()
     WHERE id=$4`,
    [hashCode(code), expires, type, id]
  );

  const label = type === "verification" ? "verification" : "final confirmation";
  await sendSms(
    application.phone,
    `Your loan application ${application.application_no} ${label} code is ${code}. It expires in 30 seconds.`
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
    res.json({
      ok: true,
      expiresAt: issued.expiresAt,
      ...(DEV_SHOW_CODES ? { devCode: issued.code } : {})
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not send verification code." });
  }
});

app.post("/api/applications/:id/verify-code", async (req, res) => {
  try {
    const application = await getApplication(req.params.id);
    if (!application) return res.status(404).json({ error: "Application not found." });

    if (application.status !== "APPROVED") {
      return res.status(400).json({ error: "Application is not approved." });
    }

    const code = String(req.body.code || "").trim();
    if (!code || hashCode(code) !== application.verification_code_hash) {
      return res.status(400).json({ error: "Incorrect or expired code." });
    }

    if (!application.verification_expires_at || new Date(application.verification_expires_at).getTime() < Date.now()) {
      return res.status(400).json({ error: "Code has expired. Please resend." });
    }

    await db(
      `UPDATE loan_applications SET status='AWAITING_FINAL_CONFIRMATION', updated_at=NOW() WHERE id=$1`,
      [application.id]
    );

    const confirmation = await issueCode(application.id, "confirmation");

    res.json({
      ok: true,
      status: "AWAITING_FINAL_CONFIRMATION",
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
    res.json({
      ok: true,
      expiresAt: issued.expiresAt,
      ...(DEV_SHOW_CODES ? { devCode: issued.code } : {})
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not resend confirmation code." });
  }
});

app.post("/api/applications/:id/confirm", async (req, res) => {
  try {
    const application = await getApplication(req.params.id);
    if (!application) return res.status(404).json({ error: "Application not found." });

    if (application.status !== "AWAITING_FINAL_CONFIRMATION") {
      return res.status(400).json({ error: "Application is not awaiting confirmation." });
    }

    const code = String(req.body.code || "").trim();
    if (!code || hashCode(code) !== application.confirmation_code_hash) {
      return res.status(400).json({ error: "Incorrect or expired confirmation code." });
    }

    if (!application.confirmation_expires_at || new Date(application.confirmation_expires_at).getTime() < Date.now()) {
      return res.status(400).json({ error: "Confirmation code has expired. Please resend." });
    }

    await db(
      `UPDATE loan_applications
       SET status='CONFIRMED', confirmed_at=NOW(), updated_at=NOW()
       WHERE id=$1`,
      [application.id]
    );

    res.json({
      ok: true,
      status: "CONFIRMED",
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

initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Loan portal running at ${APP_BASE_URL}`);
      console.log(`Telegram admins configured: ${adminIds.size}`);
    });
  })
  .catch(err => {
    console.error("Database initialization failed:", err);
    process.exit(1);
  });
