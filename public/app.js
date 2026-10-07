const state = {
  page: 1,
  applicationId: null,
  applicationNo: null,
  fullName: "",
  phone: "",
  nationalId: "",
  amount: 1000000,
  termMonths: 3,
  interestRate: 5,
  monthlyPayment: 0,
  totalRepayment: 0,
  verifyTimer: null,
  confirmTimer: null
};

const $ = (id) => document.getElementById(id);
const pages = [...document.querySelectorAll(".page")];
const stepEls = [...document.querySelectorAll(".step")];

function money(n) {
  return new Intl.NumberFormat("en-TZ", {
    style: "currency",
    currency: "TZS",
    maximumFractionDigits: 0
  }).format(Number(n || 0));
}

function showPage(page) {
  state.page = page;
  pages.forEach(p => p.classList.toggle("active", p.dataset.page === String(page)));
  stepEls.forEach((s, i) => {
    s.classList.toggle("active", i === Number(page) - 1);
    s.classList.toggle("done", i < Number(page) - 1);
  });
  window.scrollTo({top: 0, behavior: "smooth"});
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
  updateCalculator();
}

async function calculate() {
  const r = await fetch("/api/calculate", {
    method: "POST",
    headers: {"Content-Type":"application/json"},
    body: JSON.stringify({amount: state.amount, termMonths: state.termMonths})
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || "Calculation failed");
  state.monthlyPayment = data.monthlyPayment;
  state.totalRepayment = data.totalRepayment;
  $("monthlyOutput").textContent = money(data.monthlyPayment);
  $("totalOutput").textContent = money(data.totalRepayment);
}

async function updateCalculator() {
  state.amount = Number($("amount").value);
  state.termMonths = Number($("term").value);
  $("amountOutput").textContent = money(state.amount);
  $("termOutput").textContent = `${state.termMonths} Month${state.termMonths === 1 ? "" : "s"}`;
  try { await calculate(); } catch {}
}

function setError(id, message) {
  const el = $(id);
  el.textContent = message;
  el.classList.toggle("hidden", !message);
}

function startTimer(targetId, seconds, onExpire) {
  const el = $(targetId);
  clearInterval(state[targetId === "verifyTimer" ? "verifyTimer" : "confirmTimer"]);
  let remaining = seconds;
  el.textContent = remaining;
  const key = targetId === "verifyTimer" ? "verifyTimer" : "confirmTimer";
  state[key] = setInterval(() => {
    remaining -= 1;
    el.textContent = Math.max(remaining, 0);
    if (remaining <= 0) {
      clearInterval(state[key]);
      onExpire?.();
    }
  }, 1000);
}

async function issueVerificationCode() {
  const r = await fetch(`/api/applications/${state.applicationId}/send-verification-code`, {
    method: "POST"
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || "Could not send code.");
  if (data.devCode) {
    $("devVerification").textContent = `DEVELOPMENT CODE: ${data.devCode}`;
    $("devVerification").classList.remove("hidden");
  }
  startTimer("verifyTimer", 30, () => {});
}

async function issueConfirmationCode() {
  const r = await fetch(`/api/applications/${state.applicationId}/send-confirmation-code`, {
    method: "POST"
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || "Could not send code.");
  if (data.devCode) {
    $("devConfirmation").textContent = `DEVELOPMENT CODE: ${data.devCode}`;
    $("devConfirmation").classList.remove("hidden");
  }
  startTimer("confirmTimer", 30, () => {});
}

$("detailsForm").addEventListener("submit", e => {
  e.preventDefault();
  state.fullName = $("fullName").value.trim();
  state.phone = $("phone").value.trim();
  state.nationalId = $("nationalId").value.trim();
  showPage(2);
});

$("amount").addEventListener("input", updateCalculator);
$("term").addEventListener("input", updateCalculator);

$("continueToPage3").addEventListener("click", () => {
  $("verifyId").value = state.nationalId;
  $("verifyPhone").value = state.phone;
  showPage(3);
});

$("verifyForm").addEventListener("submit", async e => {
  e.preventDefault();
  setError("page3Error", "");
  const btn = e.submitter;
  if (btn) btn.disabled = true;

  try {
    if (!state.applicationId) {
      const create = await fetch("/api/applications", {
        method: "POST",
        headers: {"Content-Type":"application/json"},
        body: JSON.stringify({
          fullName: state.fullName,
          phone: state.phone,
          nationalId: state.nationalId,
          amount: state.amount,
          termMonths: state.termMonths
        })
      });
      const data = await create.json();
      if (!create.ok) throw new Error(data.error || "Could not create application.");
      state.applicationId = data.applicationId;
      state.applicationNo = data.applicationNo;
      $("applicationNumber").textContent = state.applicationNo;
    }

    $("waitingBox").classList.remove("hidden");
    await waitForApproval();
  } catch (err) {
    setError("page3Error", err.message);
  } finally {
    if (btn) btn.disabled = false;
  }
});

async function waitForApproval() {
  const started = Date.now();
  while (Date.now() - started < 10 * 60 * 1000) {
    const r = await fetch(`/api/applications/${state.applicationId}/status`);
    const data = await r.json();

    if (data.status === "APPROVED") {
      $("waitingBox").classList.add("hidden");
      showPage(4);
      await issueVerificationCode();
      return;
    }

    if (data.status === "REJECTED") {
      $("waitingBox").classList.add("hidden");
      setError("page3Error", "Your application was rejected. Please check your details and submit again.");
      state.applicationId = null;
      return;
    }

    await new Promise(resolve => setTimeout(resolve, 3000));
  }

  $("waitingBox").classList.add("hidden");
  setError("page3Error", "Approval is taking longer than expected. Please try again shortly.");
}

$("verifyCodeBtn").addEventListener("click", async () => {
  setError("page4Error", "");
  try {
    const r = await fetch(`/api/applications/${state.applicationId}/verify-code`, {
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({code:$("verificationCode").value.trim()})
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || "Verification failed.");

    $("finalAmount").textContent = money(state.amount);
    $("finalTerm").textContent = `${state.termMonths} Months`;
    $("finalMonthly").textContent = money(state.monthlyPayment);
    $("finalTotal").textContent = money(state.totalRepayment);
    showPage(5);

    if (data.devCode) {
      $("devConfirmation").textContent = `DEVELOPMENT CODE: ${data.devCode}`;
      $("devConfirmation").classList.remove("hidden");
    }
    startTimer("confirmTimer", 30, () => {});
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
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({code:$("confirmationCode").value.trim()})
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
