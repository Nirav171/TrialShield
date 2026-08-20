const API_BASE = "http://127.0.0.1:8000";

const form = document.querySelector("#search-form");
const input = document.querySelector("#search-input");
const results = document.querySelector("#results");
const resultCount = document.querySelector("#result-count");

const details = document.querySelector("#trial-details");
const analysisStatus = document.querySelector("#analysis-status");
const analysisScore = document.querySelector("#analysis-score");
const riskPill = document.querySelector("#risk-pill");
const summaryGrid = document.querySelector("#summary-grid");
const warningList = document.querySelector("#warning-list");
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

function hostnameFromUrl(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

async function getStorageKeyForCurrentTab() {
  const tab = await activeTab();
  if (!tab?.id) return null;
  return `trialshield_trial_for_tab:${tab.id}`;
}

async function restoreProtectedTrialId() {
  const key = await getStorageKeyForCurrentTab();
  if (!key) return;

  const stored = await chrome.storage.local.get([key, "trialshield_latest_trial_id"]).catch(() => ({}));
  protectedTrialId = stored[key] || stored.trialshield_latest_trial_id || null;

  if (protectedTrialId) {
    cancelTrialButton.hidden = false;
  }
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

async function getJson(path) {
  const response = await fetch(`${API_BASE}${path}`);
  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(payload?.detail || `Request failed with status ${response.status}`);
  }

  return payload;
}

function sourceLabel(source) {
  if (!source) return "unknown";
  if (source.startsWith("gemini:")) return "Gemini";
  if (source === "fallback:no_api_key") return "offline fallback: no Gemini key";
  if (source.startsWith("fallback:")) return "offline fallback";
  return source;
}

function renderResults(items, query, source) {
  results.replaceChildren();
  resultCount.textContent = items.length
    ? `${items.length} results for "${query}" · ${sourceLabel(source)}`
    : `No results found for "${query}".`;

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
    resultCount.textContent = "Enter a category first.";
    results.replaceChildren();
    return;
  }

  const button = form.querySelector("button");
  button.disabled = true;
  button.textContent = "Searching";
  resultCount.textContent = "Finding official trial pages…";
  results.replaceChildren();

  try {
    const payload = await postJson("/search", { query });
    renderResults(payload.results || [], query, payload.source || "unknown");
  } catch (error) {
    resultCount.textContent = error instanceof TypeError
      ? "FastAPI is offline on port 8000."
      : error.message;
  } finally {
    button.disabled = false;
    button.textContent = "Search";
  }
});

function setRisk(score, level) {
  const text = Number.isFinite(score) ? `${score}/100` : "—";
  riskPill.textContent = text;
  analysisScore.textContent = level ? `${text} · ${level}` : text;

  riskPill.className = "risk-pill";
  if (score >= 80) riskPill.classList.add("critical");
  else if (score >= 60) riskPill.classList.add("high");
  else if (score >= 30) riskPill.classList.add("medium");
  else riskPill.classList.add("low");
}

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

function addSummary(label, value, tone = "neutral") {
  const item = document.createElement("div");
  item.className = `summary-card ${tone}`;

  const small = document.createElement("span");
  const strong = document.createElement("strong");

  small.textContent = label;
  strong.textContent = value || "Unknown";

  item.append(small, strong);
  summaryGrid.append(item);
}

function renderWarnings(warnings, flags) {
  warningList.replaceChildren();

  const items = [
    ...(warnings || []).slice(0, 3),
    ...(flags || []).slice(0, 3).map((flag) => flag.label)
  ];

  for (const item of [...new Set(items)].slice(0, 4)) {
    const li = document.createElement("li");
    li.textContent = item;
    warningList.append(li);
  }
}

function renderBackendAnalysis(state) {
  details.hidden = false;
  summaryGrid.replaceChildren();
  warningList.replaceChildren();
  detailsList.replaceChildren();
  auditList.replaceChildren();
  auditPanel.hidden = true;

  analyzedTrial = null;
  analyzedRiskScore = 0;
  protectTrialButton.hidden = true;
  protectionStatus.textContent = "";

  if (state.status === "error") {
    setRisk(NaN, null);
    analysisStatus.textContent = `Analysis failed: ${state.error}`;
    return;
  }

  const payload = state.result;
  const trial = payload.trial;
  const risk = payload.risk;

  analyzedTrial = trial;
  analyzedRiskScore = risk?.score || 0;

  setRisk(analyzedRiskScore, risk?.level);
  protectTrialButton.hidden = false;
  cancelTrialButton.hidden = !protectedTrialId;

  analysisStatus.textContent = risk?.summary || "Analysis complete.";

  addSummary("Provider", trial.provider_name);
  addSummary("Trial", trial.trial_duration || (trial.has_free_trial ? "Detected" : "Unclear"), trial.has_free_trial ? "ok" : "warn");
  addSummary("Payment", trial.payment_method_required === true ? "Required" : trial.payment_method_required === false ? "Not required" : "Unclear", trial.payment_method_required === true ? "warn" : "neutral");
  addSummary("Renewal", trial.auto_renews === true ? "Auto-renews" : trial.auto_renews === false ? "No auto-renew" : "Unclear", trial.auto_renews === true ? "warn" : "neutral");
  addSummary("Charge", trial.recurring_charge || trial.minimum_fee || "Unknown", trial.recurring_charge ? "warn" : "neutral");
  addSummary("Evidence", `${trial.evidence?.length || 0} snippets`, trial.evidence?.length ? "ok" : "warn");

  renderWarnings(payload.warnings, payload.evidence_flags);

  addDetail("Provider", trial.provider_name);
  addDetail("Page title", trial.page_title);
  addDetail("URL", trial.source_url);
  addDetail("Free trial", trial.has_free_trial ? "Yes" : "Not confirmed");
  addDetail("Duration", trial.trial_duration);
  addDetail("Starting fee", trial.minimum_fee);
  addDetail("Recurring charge", trial.recurring_charge);
  addDetail("Payment required", trial.payment_method_required);
  addDetail("Auto-renewal", trial.auto_renews);
  addDetail("Cancellation terms", trial.cancellation_terms);
  addDetail("Completeness", `${payload.completeness_score}%`);
  addDetail("Warnings", payload.warnings);
  addDetail("Risk factors", risk?.factors?.map((factor) => `${factor.label} (+${factor.points})`));
  addDetail("Evidence flags", payload.evidence_flags?.map((flag) => `${flag.label}: ${flag.explanation}`));
  addDetail("Evidence", trial.evidence);
}

async function analyzeActivePage() {
  const tab = await activeTab();

  if (!tab?.id || !/^https?:/.test(tab.url || "")) {
    details.hidden = false;
    analysisStatus.textContent = "Open a normal website to analyze it.";
    return;
  }

  details.hidden = false;
  analysisStatus.textContent = "Scanning current page…";

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
      ? "FastAPI backend is offline on port 8000."
      : error instanceof Error
        ? error.message
        : "This page could not be analyzed.";

    renderBackendAnalysis({ status: "error", error: message });
  }
}

protectTrialButton.addEventListener("click", async () => {
  if (!analyzedTrial) return;

  protectTrialButton.disabled = true;
  protectTrialButton.textContent = "Protecting";
  protectionStatus.textContent = "Creating simulated card and audit record…";

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

    const key = await getStorageKeyForCurrentTab();
    if (key) {
      await chrome.storage.local.set({
        [key]: protectedTrialId,
        trialshield_latest_trial_id: protectedTrialId
      });
    }

    protectionStatus.textContent = result.message;
    protectTrialButton.textContent = "Protected";
    cancelTrialButton.hidden = false;

    addSummary("Protected ID", String(result.trial_id), "ok");
    addSummary("Card", result.card.status, "ok");

    addDetail("Trial ID", result.trial_id);
    addDetail("Simulated card number", result.card.card_number);
    addDetail("Expiry", `${String(result.card.expiry_month).padStart(2, "0")}/${result.card.expiry_year}`);
    addDetail("Simulated CVV", result.card.cvv);
    addDetail("Merchant lock", result.card.merchant_lock);
    addDetail("Card status", result.card.status);
  } catch (error) {
    protectionStatus.textContent = error instanceof Error ? error.message : "Trial protection failed.";
    protectTrialButton.disabled = false;
    protectTrialButton.textContent = "Protect";
  }
});

async function renderAuditTrail(trialId, cancellation) {
  auditPanel.hidden = false;
  auditList.replaceChildren();

  try {
    const events = await getJson(`/trials/${trialId}/audit-events`);
    for (const event of events.slice(-5)) {
      const li = document.createElement("li");
      li.textContent = `${event.event_type}: ${event.description}`;
      auditList.append(li);
    }
  } catch {
    const li = document.createElement("li");
    li.textContent = `Actions: ${(cancellation.attempted_actions || []).join(" → ") || "None"}`;
    auditList.append(li);
  }
}

cancelTrialButton.addEventListener("click", async () => {
  if (!protectedTrialId) {
    protectionStatus.textContent = "Protect the trial first so evidence can be linked.";
    return;
  }

  cancelTrialButton.disabled = true;
  cancelTrialButton.textContent = "Trying";
  protectionStatus.textContent = "Trying visible cancellation controls…";

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
    cancelTrialButton.textContent = result.confirmed ? "Confirmed" : "Fallback logged";

    addSummary("Cancel status", result.cancellation_status, result.confirmed ? "ok" : "warn");
    addSummary("Card status", result.card_status || "Unknown", "warn");

    await renderAuditTrail(protectedTrialId, cancellation);
  } catch (error) {
    protectionStatus.textContent = error instanceof Error
      ? error.message
      : "Automatic cancellation failed.";
    cancelTrialButton.disabled = false;
    cancelTrialButton.textContent = "Auto-cancel";
  }
});

function relativeTime(ts) {
  if (!ts) return "";
  const seconds = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (seconds < 2) return "Last scan: just now";
  if (seconds < 60) return `Last scan: ${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `Last scan: ${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return `Last scan: ${hours}h ago`;
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
    pageTypeEl.textContent = "Monitoring unavailable.";
    statusText.textContent = "Idle";
    return;
  }

  const key = `trialshield_state:${hostname}`;
  const stored = await chrome.storage.local.get(key).catch(() => ({}));
  const data = stored[key];

  if (!data) {
    pageTypeEl.textContent = "Current page: —";
    statusDot.className = "dot dot-idle";
    statusText.textContent = "Idle";
    return;
  }

  pageTypeEl.textContent = `Current page: ${data.currentSite?.pageType || "unknown"}`;
  statusDot.className = "dot dot-active";
  statusText.textContent = "Monitoring";

  alertsEl.replaceChildren();

  const alerts = [];
  if (data.payment?.methodRequired === true) alerts.push("Payment required");
  if (data.renewal?.automatic === true) alerts.push("Auto-renewal");
  if (data.cancellation?.stepsObserved > 0) alerts.push("Cancel controls found");

  for (const alert of alerts.slice(0, 3)) {
    const li = document.createElement("li");
    li.className = "alert alert-warning";
    li.textContent = alert;
    alertsEl.append(li);
  }

  planEl.textContent = `Plan: ${data.plan?.status || "unknown"}`;
  trialEl.textContent = data.trial?.detected
    ? data.trial.duration || "Detected"
    : "No";
  paymentEl.textContent = data.payment?.methodRequired === true
    ? "Required"
    : data.payment?.pageDetected
      ? "Seen"
      : "Unknown";
  renewalEl.textContent = data.renewal?.automatic === true
    ? data.renewal.price || "Yes"
    : "Unknown";
  cancellationEl.textContent = data.cancellation?.stepsObserved
    ? `${data.cancellation.stepsObserved} step(s)`
    : "None";
  lastScanEl.textContent = relativeTime(data.lastUpdated);
}

resultCount.textContent = "Search for a free-trial category.";
restoreProtectedTrialId().then(() => analyzeActivePage());
renderMonitor();