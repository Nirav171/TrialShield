const form = document.querySelector("#search-form");
const input = document.querySelector("#search-input");
const results = document.querySelector("#results");
const resultCount = document.querySelector("#result-count");
const details = document.querySelector("#trial-details");
const analysisStatus = document.querySelector("#analysis-status");
const detailsList = document.querySelector("#details-list");
const protectTrialButton = document.querySelector("#protect-trial");
const protectionStatus = document.querySelector("#protection-status");
let analyzedTrial = null;
let analyzedRiskScore = 0;

function renderResults(items, query) {
  results.replaceChildren();
  resultCount.textContent = items.length
    ? `${items.length} trials found for "${query}".`
    : `No trials found for "${query}".`;

  for (const trial of items) {
    const item = document.createElement("li");
    const link = document.createElement("a");
    const name = document.createElement("strong");
    const note = document.createElement("span");
    link.className = "result-link";
    link.href = trial.url;
    name.textContent = trial.name;
    note.textContent = trial.description;
    link.append(name, note);
    link.addEventListener("click", async (event) => {
      event.preventDefault();
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) return;
      await chrome.tabs.update(tab.id, { url: trial.url });
      window.close();
    });
    item.append(link);
    results.append(item);
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const query = input.value.trim();
  if (!query) {
    resultCount.textContent = "Enter the type of free trial you want to find.";
    results.replaceChildren();
    return;
  }

  const button = form.querySelector("button");
  button.disabled = true;
  button.textContent = "Searching...";
  resultCount.textContent = "Searching current free-trial offers...";
  results.replaceChildren();

  try {
    const response = await fetch("http://127.0.0.1:8787/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query })
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Search failed");
    renderResults(payload.results, query);
  } catch (error) {
    resultCount.textContent = error instanceof TypeError
      ? "Search service is offline. Start backend.ps1 and try again."
      : error.message;
  } finally {
    button.disabled = false;
    button.textContent = "Search";
  }
});

function addDetail(label, value) {
  if (value === null || value === undefined || value === "") return;
  const term = document.createElement("dt");
  const description = document.createElement("dd");
  term.textContent = label;
  description.textContent = Array.isArray(value) ? value.join("; ") : String(value);
  detailsList.append(term, description);
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = typeof payload?.detail === "string"
      ? payload.detail
      : Array.isArray(payload?.detail)
        ? payload.detail.map((item) => item.msg).join("; ")
        : "FastAPI request failed";
    throw new Error(detail);
  }
  return payload;
}

function renderBackendAnalysis(state) {
  details.hidden = false;
  detailsList.replaceChildren();
  analyzedTrial = null;
  analyzedRiskScore = 0;
  protectTrialButton.hidden = true;
  protectionStatus.textContent = "";

  if (!state || state.status === "waiting") {
    analysisStatus.textContent = "Waiting for the selected website to load...";
    return;
  }
  if (state.status === "analyzing") {
    analysisStatus.textContent = "FastAPI is analyzing the selected website...";
    return;
  }
  if (state.status === "error") {
    analysisStatus.textContent = `Analysis failed: ${state.error}. Make sure FastAPI is running.`;
    return;
  }

  const payload = state.result;
  const trial = payload.trial;
  analyzedTrial = trial;
  analyzedRiskScore = payload.risk?.score || 0;
  protectTrialButton.hidden = false;
  analysisStatus.textContent = payload.risk
    ? `Risk: ${payload.risk.score}/100 (${payload.risk.level}). ${payload.risk.summary}`
    : "Analysis complete.";
  addDetail("Provider", trial.provider_name);
  addDetail("Free trial", trial.has_free_trial ? "Yes" : "Not confirmed");
  addDetail("Starts", trial.trial_start);
  addDetail("Duration", trial.trial_duration);
  addDetail("Starting fee", trial.minimum_fee);
  addDetail("Recurring charge", trial.recurring_charge);
  addDetail("Payment method required", trial.payment_method_required);
  addDetail("Auto-renewal", trial.auto_renews);
  addDetail("Cancellation terms", trial.cancellation_terms);
  addDetail("Completeness", `${payload.completeness_score}%`);
  addDetail("Warnings", payload.warnings);
  addDetail("Risk factors", payload.risk?.factors?.map((factor) => `${factor.label} (+${factor.points})`));
  addDetail("Evidence", trial.evidence);
}

protectTrialButton.addEventListener("click", async () => {
  if (!analyzedTrial) return;

  protectTrialButton.disabled = true;
  protectTrialButton.textContent = "Starting protection...";
  protectionStatus.textContent = "Sending trial details to FastAPI...";

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error("The selected website tab is unavailable");

    const response = await chrome.runtime.sendMessage({
      type: "TRIALSHIELD_PROTECT_TRIAL",
      tabId: tab.id,
      riskScore: analyzedRiskScore
    });
    if (!response?.ok) throw new Error(response?.error || "Trial protection failed");

    const result = response.result;
    addDetail("Simulated card number", result.card.card_number);
    addDetail("Expiry", `${String(result.card.expiry_month).padStart(2, "0")}/${result.card.expiry_year}`);
    addDetail("Simulated CVV", result.card.cvv);
    addDetail("Merchant lock", result.card.merchant_lock);
    addDetail("Card status", result.card.status);
    protectionStatus.textContent = result.message;
    protectTrialButton.textContent = "TrialShield protection started";
  } catch (error) {
    protectionStatus.textContent = error instanceof Error ? error.message : "Trial protection failed";
    protectTrialButton.disabled = false;
    protectTrialButton.textContent = "Protect this trial";
  }
});

async function loadActivePageAnalysis() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !/^https?:/.test(tab.url || "")) return;
  details.hidden = false;
  analysisStatus.textContent = "Analyzing this page with FastAPI...";
  try {
    let response;
    try {
      response = await chrome.tabs.sendMessage(tab.id, { type: "TRIALSHIELD_ANALYZE" });
    } catch {
      // No content script listening yet - this happens on tabs that were
      // already open before the extension was installed/reloaded. Inject it
      // now (permission already granted via "scripting") and retry once.
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
      response = await chrome.tabs.sendMessage(tab.id, { type: "TRIALSHIELD_ANALYZE" });
    }
    if (!response?.ok) throw new Error(response?.error || "Analysis unavailable");
    const trial = response.trial;
    const [pageAnalysis, risk] = await Promise.all([
      postJson("http://127.0.0.1:8000/analyze-page", trial),
      postJson("http://127.0.0.1:8000/risk-score", trial)
    ]);
    renderBackendAnalysis({
      status: "complete",
      result: { ...pageAnalysis, risk }
    });
  } catch (error) {
    const message = error instanceof TypeError
      ? "FastAPI backend is offline. Start it on port 8000 and try again."
      : error instanceof Error
        ? error.message
        : "This page could not be analyzed.";
    renderBackendAnalysis({ status: "error", error: message });
  }
}

resultCount.textContent = "Search for music, design, fitness, streaming, or another service.";
loadActivePageAnalysis();

// ---------------------------------------------------------------------------
// TrialShield monitoring dashboard (Phase 3)
//
// Reads the per-hostname "subscription journey" record that content.js
// (Phase 1/2) keeps in chrome.storage.local and renders it here. This never
// asks the content script to do fresh work - it only reads what's already
// been observed - and it stays live via chrome.storage.onChanged while the
// popup is open, so no polling loop is needed.
// ---------------------------------------------------------------------------
(() => {
  const pageTypeEl = document.querySelector("#monitor-page-type");
  const statusDot = document.querySelector("#monitor-dot");
  const statusText = document.querySelector("#monitor-status-text");
  const alertsEl = document.querySelector("#monitor-alerts");
  const planEl = document.querySelector("#monitor-plan");
  const trialEl = document.querySelector("#monitor-trial");
  const paymentEl = document.querySelector("#monitor-payment");
  const renewalEl = document.querySelector("#monitor-renewal");
  const cancellationEl = document.querySelector("#monitor-cancellation");
  const lastScanEl = document.querySelector("#monitor-lastscan");

  const PAGE_TYPE_LABELS = {
    unknown: "Unknown",
    landing: "Landing page",
    pricing: "Pricing",
    trial: "Free trial",
    signup: "Sign up",
    account: "Account",
    subscription: "Subscription",
    billing: "Billing",
    payment: "Payment / Checkout",
    checkout: "Payment / Checkout",
    confirmation: "Confirmation"
  };

  let hostname = null;
  let refreshTimer = null;

  function hostnameFromUrl(url) {
    try {
      return new URL(url).hostname.replace(/^www\./, "");
    } catch {
      return null;
    }
  }

  function relativeTime(ts) {
    if (!ts) return "No scans yet on this site.";
    const seconds = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (seconds < 2) return "Last scan: just now";
    if (seconds < 60) return `Last scan: ${seconds} seconds ago`;
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `Last scan: ${minutes} minute${minutes === 1 ? "" : "s"} ago`;
    const hours = Math.round(minutes / 60);
    return `Last scan: ${hours} hour${hours === 1 ? "" : "s"} ago`;
  }

  function addAlert(list, text, kind) {
    // Keep the alert list short and meaningful - this is a glanceable
    // summary, not a notification feed.
    if (list.length >= 3) return;
    list.push({ text, kind });
  }

  function buildAlerts(data) {
    const alerts = [];
    const onPaidPlan = data.plan?.status === "paid";

    // Trial/renewal warnings only make sense while the account is actually
    // on a free/trial plan. Once we've seen a "current plan: paid" style
    // statement on this site, stop surfacing them - show that fact instead.
    if (onPaidPlan) {
      addAlert(alerts, "You're on a paid plan here - trial alerts are paused", "ok");
    } else {
      if (data.trial?.detected && data.payment?.methodRequired === true) {
        addAlert(alerts, "Payment required for the free trial", "warning");
      }
      if (data.renewal?.automatic === true) {
        addAlert(
          alerts,
          data.renewal.price ? `Trial automatically renews at ${data.renewal.price}` : "Trial automatically renews",
          "warning"
        );
      }
    }

    // Cancellation-flow changes stay relevant regardless of plan status.
    if (data.cancellation?.changed && data.cancellation.lastChange) {
      const { previousSteps, currentSteps } = data.cancellation.lastChange;
      addAlert(alerts, `Cancellation process changed (${previousSteps} → ${currentSteps} steps)`, "warning");
    }
    if (!alerts.length && data.cancellation?.stepsObserved > 0) {
      addAlert(alerts, "Cancellation option found on this site", "ok");
    }
    return alerts;
  }

  function renderAlerts(data) {
    const alerts = buildAlerts(data);
    alertsEl.replaceChildren();
    for (const alert of alerts) {
      const item = document.createElement("li");
      item.className = `alert ${alert.kind === "warning" ? "alert-warning" : "alert-ok"}`;
      item.textContent = `${alert.kind === "warning" ? "⚠" : "✓"} ${alert.text}`;
      alertsEl.append(item);
    }
  }

  function renderPlan(plan) {
    if (plan?.status === "paid") {
      planEl.textContent = "💳 Paid plan detected";
    } else if (plan?.status === "free") {
      planEl.textContent = "Free plan";
    } else {
      planEl.textContent = "No plan information yet";
    }
  }

  function renderTrial(trial, plan) {
    if (plan?.status === "paid") {
      trialEl.textContent = "Not applicable - already on a paid plan";
      return;
    }
    if (!trial?.detected) {
      trialEl.textContent = "No trial detected on this site yet";
      return;
    }
    const parts = ["✓ Free trial detected"];
    if (trial.duration) parts.push(trial.duration);
    trialEl.textContent = parts.join(" · ");
  }

  function renderPayment(payment) {
    if (payment?.methodRequired === true) {
      paymentEl.textContent = "⚠ Payment method required";
    } else if (payment?.methodRequired === false) {
      paymentEl.textContent = "✓ No payment method required";
    } else if (payment?.pageDetected) {
      paymentEl.textContent = "Payment page detected";
    } else {
      paymentEl.textContent = "No payment information yet";
    }
  }

  function renderRenewal(renewal) {
    if (renewal?.automatic === true) {
      renewalEl.textContent = renewal.price ? `⚠ Auto-renews · ${renewal.price}` : "⚠ Auto-renews";
    } else if (renewal?.automatic === false) {
      renewalEl.textContent = "✓ Does not auto-renew";
    } else {
      renewalEl.textContent = "No renewal information yet";
    }
  }

  function renderCancellation(cancellation) {
    const observed = cancellation?.stepsObserved || 0;
    if (!observed) {
      cancellationEl.textContent = "No cancellation flow observed yet";
      return;
    }
    const suffix = cancellation.changed ? " (process changed)" : "";
    cancellationEl.textContent = `${observed} step${observed === 1 ? "" : "s"} observed${suffix}`;
  }

  function render(data) {
    if (!data) {
      pageTypeEl.textContent = "Current page: —";
      statusDot.className = "dot dot-idle";
      statusText.textContent = "Not monitored yet";
      alertsEl.replaceChildren();
      planEl.textContent = "No plan information yet";
      trialEl.textContent = "No trial information yet";
      paymentEl.textContent = "No payment information yet";
      renewalEl.textContent = "No renewal information yet";
      cancellationEl.textContent = "No cancellation flow observed yet";
      lastScanEl.textContent = "";
      return;
    }

    const pageType = data.currentSite?.pageType || "unknown";
    pageTypeEl.textContent = `Current page: ${PAGE_TYPE_LABELS[pageType] || "Unknown"}`;

    statusDot.className = "dot dot-active";
    statusText.textContent = "Monitoring this website";

    renderAlerts(data);
    renderPlan(data.plan);
    renderTrial(data.trial, data.plan);
    renderPayment(data.payment);
    renderRenewal(data.renewal);
    renderCancellation(data.cancellation);
    lastScanEl.textContent = relativeTime(data.lastUpdated);
  }

  async function loadAndRender() {
    if (!hostname) return;
    try {
      const key = `trialshield_state:${hostname}`;
      const stored = await chrome.storage.local.get(key);
      render(stored[key] || null);
    } catch {
      // Extension context can be invalidated right as the popup opens
      // (e.g. right after a reload); fail quietly, nothing to show yet.
    }
  }

  async function init() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url || !/^https?:/.test(tab.url)) {
      pageTypeEl.textContent = "Monitoring is unavailable on this page.";
      statusText.textContent = "Not monitored";
      return;
    }
    hostname = hostnameFromUrl(tab.url);
    await loadAndRender();

    // Live updates while the popup stays open. Only re-render when this
    // site's own key changes, so unrelated storage writes don't cause work.
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== "local") return;
      const key = `trialshield_state:${hostname}`;
      if (changes[key]) render(changes[key].newValue || null);
    });

    // Cheap, text-only refresh of the "last scan" relative time; does not
    // re-fetch from storage or rebuild the rest of the dashboard.
    refreshTimer = setInterval(async () => {
      const key = `trialshield_state:${hostname}`;
      const stored = await chrome.storage.local.get(key).catch(() => ({}));
      const data = stored[key];
      if (data?.lastUpdated) lastScanEl.textContent = relativeTime(data.lastUpdated);
    }, 5000);
  }

  window.addEventListener("unload", () => {
    if (refreshTimer) clearInterval(refreshTimer);
  });

  init();
})();
