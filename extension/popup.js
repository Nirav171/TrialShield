const API_BASE = "http://127.0.0.1:8000";

const form = document.querySelector("#search-form");
const input = document.querySelector("#search-input");
const results = document.querySelector("#results");
const resultCount = document.querySelector("#result-count");

const details = document.querySelector("#trial-details");
const analysisStatus = document.querySelector("#analysis-status");
const detailsList = document.querySelector("#details-list");
const protectTrialButton = document.querySelector("#protect-trial");
const cancelTrialButton = document.querySelector("#cancel-trial");
const protectionStatus = document.querySelector("#protection-status");
const auditPanel = document.querySelector("#audit-panel");
const auditList = document.querySelector("#audit-list");

let analyzedTrial = null;
let analyzedRiskScore = 0;
let protectedTrialId = null;

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function postJson(path, body) {
  const response = await fetch(`${API_BASE}${path}`, {
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
        : `Request failed with status ${response.status}`;
    throw new Error(detail);
  }

  return payload;
}

function renderResults(items, query, source) {
  results.replaceChildren();
  resultCount.textContent = items.length
    ? `${items.length} trials found for "${query}" (${source}).`
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
      const tab = await activeTab();
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
  resultCount.textContent = "Asking Gemini for official trial pages...";
  results.replaceChildren();

  try {
    const payload = await postJson("/search", { query });
    renderResults(payload.results || [], query, payload.source || "unknown");
  } catch (error) {
    resultCount.textContent = error instanceof TypeError
      ? "FastAPI is offline. Start it on port 8000."
      : error.message;
  } finally {
    button.disabled = false;
    button.textContent = "Search";
  }
});

function addDetail(label, value) {
  if (value === null || value === undefined || value === "" || value === false) return;

  const term = document.createElement("dt");
  const description = document.createElement("dd");

  term.textContent = label;
  description.textContent = Array.isArray(value)
    ? value.join("; ")
    : String(value);

  detailsList.append(term, description);
}

function renderBackendAnalysis(state) {
  details.hidden = false;
  detailsList.replaceChildren();
  auditList.replaceChildren();
  auditPanel.hidden = true;

  analyzedTrial = null;
  analyzedRiskScore = 0;
  protectTrialButton.hidden = true;
  cancelTrialButton.hidden = true;
  protectionStatus.textContent = "";

  if (state.status === "error") {
    analysisStatus.textContent = `Analysis failed: ${state.error}`;
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
  addDetail("Duration", trial.trial_duration);
  addDetail("Starting fee", trial.minimum_fee);
  addDetail("Recurring charge", trial.recurring_charge);
  addDetail("Payment required", trial.payment_method_required);
  addDetail("Auto-renewal", trial.auto_renews);
  addDetail("Cancellation terms", trial.cancellation_terms);
  addDetail("Completeness", `${payload.completeness_score}%`);
  addDetail("Warnings", payload.warnings);
  addDetail(
    "Risk factors",
    payload.risk?.factors?.map((factor) => `${factor.label} (+${factor.points})`)
  );
  addDetail(
    "Evidence flags",
    payload.evidence_flags?.map((flag) => `${flag.label}: ${flag.explanation}`)
  );
  addDetail("Evidence", trial.evidence);
}

async function analyzeActivePage() {
  const tab = await activeTab();
  if (!tab?.id || !/^https?:/.test(tab.url || "")) {
    details.hidden = false;
    analysisStatus.textContent = "Open a normal http(s) website to analyze it.";
    return;
  }

  details.hidden = false;
  analysisStatus.textContent = "Analyzing this page with FastAPI...";

  try {
    let response;
    try {
      response = await chrome.tabs.sendMessage(tab.id, { type: "TRIALSHIELD_ANALYZE" });
    } catch {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["content.js"]
      });
      response = await chrome.tabs.sendMessage(tab.id, { type: "TRIALSHIELD_ANALYZE" });
    }

    if (!response?.ok) throw new Error(response?.error || "Page analysis unavailable.");

    const trial = response.trial;
    const [pageAnalysis, risk] = await Promise.all([
      postJson("/analyze-page", trial),
      postJson("/risk-score", trial)
    ]);

    renderBackendAnalysis({
      status: "complete",
      result: { ...pageAnalysis, risk }
    });
  } catch (error) {
    const message = error instanceof TypeError
      ? "FastAPI backend is offline. Start it on port 8000."
      : error instanceof Error
        ? error.message
        : "This page could not be analyzed.";

    renderBackendAnalysis({ status: "error", error: message });
  }
}

protectTrialButton.addEventListener("click", async () => {
  if (!analyzedTrial) return;

  protectTrialButton.disabled = true;
  protectTrialButton.textContent = "Starting protection...";
  protectionStatus.textContent = "Creating simulated card and audit evidence...";

  try {
    const tab = await activeTab();
    if (!tab?.id) throw new Error("The selected website tab is unavailable.");

    const response = await chrome.runtime.sendMessage({
      type: "TRIALSHIELD_PROTECT_TRIAL",
      tabId: tab.id,
      riskScore: analyzedRiskScore
    });

    if (!response?.ok) throw new Error(response?.error || "Trial protection failed.");

    const result = response.result;
    protectedTrialId = result.trial_id;

    addDetail("Trial ID", result.trial_id);
    addDetail("Simulated card number", result.card.card_number);
    addDetail("Expiry", `${String(result.card.expiry_month).padStart(2, "0")}/${result.card.expiry_year}`);
    addDetail("Simulated CVV", result.card.cvv);
    addDetail("Merchant lock", result.card.merchant_lock);
    addDetail("Card status", result.card.status);

    protectionStatus.textContent = result.message;
    protectTrialButton.textContent = "Protection started";
    cancelTrialButton.hidden = false;
  } catch (error) {
    protectionStatus.textContent = error instanceof Error ? error.message : "Trial protection failed.";
    protectTrialButton.disabled = false;
    protectTrialButton.textContent = "Protect this trial";
  }
});

cancelTrialButton.addEventListener("click", async () => {
  if (!protectedTrialId) {
    protectionStatus.textContent = "Protect the trial first so cancellation evidence can be linked.";
    return;
  }

  cancelTrialButton.disabled = true;
  cancelTrialButton.textContent = "Attempting cancellation...";
  protectionStatus.textContent = "Trying visible cancellation controls and recording evidence...";

  try {
    const tab = await activeTab();
    if (!tab?.id) throw new Error("The selected website tab is unavailable.");

    const response = await chrome.runtime.sendMessage({
      type: "TRIALSHIELD_AUTO_CANCEL",
      tabId: tab.id,
      trialId: protectedTrialId
    });

    if (!response?.ok) throw new Error(response?.error || "Automatic cancellation failed.");

    const result = response.result;
    const cancellation = response.cancellation;

    protectionStatus.textContent = result.message;
    cancelTrialButton.textContent = result.confirmed
      ? "Cancellation confirmed"
      : "Fallback card freeze logged";

    auditPanel.hidden = false;
    auditList.replaceChildren();

    const items = [
      `Audit event #${result.audit_event_id}`,
      `Status: ${result.status}`,
      `Cancellation status: ${result.cancellation_status}`,
      `Card status: ${result.card_status}`,
      `Actions: ${(cancellation.attempted_actions || []).join(" → ") || "None"}`,
      `Evidence: ${(cancellation.evidence || []).slice(0, 4).join(" | ") || "None"}`
    ];

    for (const text of items) {
      const li = document.createElement("li");
      li.textContent = text;
      auditList.append(li);
    }
  } catch (error) {
    protectionStatus.textContent = error instanceof Error
      ? error.message
      : "Automatic cancellation failed.";
    cancelTrialButton.disabled = false;
    cancelTrialButton.textContent = "Try automatic cancellation";
  }
});

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

async function renderMonitor() {
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

  const tab = await activeTab();
  const hostname = hostnameFromUrl(tab?.url || "");
  if (!hostname) {
    pageTypeEl.textContent = "Monitoring is unavailable on this page.";
    statusText.textContent = "Not monitored";
    return;
  }

  const key = `trialshield_state:${hostname}`;
  const stored = await chrome.storage.local.get(key).catch(() => ({}));
  const data = stored[key];

  if (!data) {
    pageTypeEl.textContent = "Current page: —";
    statusDot.className = "dot dot-idle";
    statusText.textContent = "Not monitored yet";
    return;
  }

  pageTypeEl.textContent = `Current page: ${data.currentSite?.pageType || "unknown"}`;
  statusDot.className = "dot dot-active";
  statusText.textContent = "Monitoring this website";

  alertsEl.replaceChildren();
  const alerts = [];
  if (data.payment?.methodRequired === true) alerts.push("Payment required");
  if (data.renewal?.automatic === true) alerts.push("Auto-renewal detected");
  if (data.cancellation?.stepsObserved > 0) alerts.push("Cancellation controls found");

  for (const alert of alerts.slice(0, 3)) {
    const li = document.createElement("li");
    li.className = "alert alert-warning";
    li.textContent = alert;
    alertsEl.append(li);
  }

  planEl.textContent = data.plan?.status || "No plan information yet";
  trialEl.textContent = data.trial?.detected
    ? `Free trial detected${data.trial.duration ? ` · ${data.trial.duration}` : ""}`
    : "No trial detected";
  paymentEl.textContent = data.payment?.methodRequired === true
    ? "Payment method required"
    : data.payment?.pageDetected
      ? "Payment page detected"
      : "No payment information yet";
  renewalEl.textContent = data.renewal?.automatic === true
    ? `Auto-renews${data.renewal.price ? ` · ${data.renewal.price}` : ""}`
    : "No renewal information yet";
  cancellationEl.textContent = data.cancellation?.stepsObserved
    ? `${data.cancellation.stepsObserved} cancellation step(s) observed`
    : "No cancellation flow observed yet";
  lastScanEl.textContent = relativeTime(data.lastUpdated);
}

resultCount.textContent = "Search for music, design, fitness, streaming, or another service.";
analyzeActivePage();
renderMonitor();