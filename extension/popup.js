const form = document.querySelector("#search-form");
const input = document.querySelector("#search-input");
const results = document.querySelector("#results");
const resultCount = document.querySelector("#result-count");
const details = document.querySelector("#trial-details");
const analysisStatus = document.querySelector("#analysis-status");
const detailsList = document.querySelector("#details-list");
const siteScanStatus = document.querySelector("#site-scan-status");
const siteScanStart = document.querySelector("#site-scan-start");
const scanCountDiscovered = document.querySelector("#scan-count-discovered");
const scanCountAnalyzed = document.querySelector("#scan-count-analyzed");
const scanCountRelevant = document.querySelector("#scan-count-relevant");
const scanTrialSummary = document.querySelector("#scan-trial-summary");
const scanPaymentSummary = document.querySelector("#scan-payment-summary");
const scanRenewalSummary = document.querySelector("#scan-renewal-summary");
const scanCancellationSummary = document.querySelector("#scan-cancellation-summary");
const scanCancellationPath = document.querySelector("#scan-cancellation-path");
const scanManualNote = document.querySelector("#scan-manual-note");
const scanPages = document.querySelector("#scan-pages");

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
    link.addEventListener("click", (event) => {
      event.preventDefault();
      chrome.tabs.update({ url: trial.url });
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
  resultCount.textContent = "Searching current free-trial offers available in India...";
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

async function analyzeActivePage() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !/^https?:/.test(tab.url || "")) return;

  details.hidden = false;
  try {
    let response;
    try {
      response = await chrome.tabs.sendMessage(tab.id, { type: "TRIALSHIELD_ANALYZE" });
    } catch {
      // No content script listening yet - this happens on tabs that were
      // already open before the extension was installed/reloaded. Inject it
      // now (permission already granted via "scripting") and retry once.
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["scanner.js", "content.js"] });
      response = await chrome.tabs.sendMessage(tab.id, { type: "TRIALSHIELD_ANALYZE" });
    }
    if (!response?.ok) throw new Error(response?.error || "Analysis unavailable");
    const trial = response.trial;
    analysisStatus.textContent = trial.has_free_trial
      ? "Possible free-trial terms detected. Verify them on the provider's checkout page."
      : "No clear free-trial terms were detected on this page.";
    addDetail("Provider", trial.provider_name);
    addDetail("Starts", trial.trial_start);
    addDetail("Duration", trial.trial_duration);
    addDetail("Starting fee", trial.minimum_fee);
    addDetail("Payment method required", trial.payment_method_required);
    addDetail("Auto-renewal", trial.auto_renews);
    addDetail("Cancellation terms", trial.cancellation_terms);
    addDetail("Evidence", trial.evidence);
  } catch {
    analysisStatus.textContent = "This page can't be analyzed (browser-restricted page or extension store page).";
  }
}

function hostnameFromUrl(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

function pathnameFor(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname || "/"}${parsed.search || ""}`;
  } catch {
    return url;
  }
}

function openPage(url) {
  if (!url) return;
  chrome.tabs.update({ url }).catch(() => {});
  window.close();
}

function findFirstFinding(state, predicate) {
  return (state?.analyzedPages || [])
    .slice()
    .sort((a, b) => (b.score || 0) - (a.score || 0))
    .find((page) => predicate(page.websiteAnalysis?.findings || {})) || null;
}

function renderFindingValue(element, text, sourcePage = null, kind = "neutral") {
  element.replaceChildren();
  element.className = `finding-value finding-${kind}`;
  const line = document.createElement("span");
  line.textContent = text;
  element.append(line);
  if (sourcePage?.url) {
    const source = document.createElement("button");
    source.type = "button";
    source.className = "source-link";
    source.textContent = `Found on ${pathnameFor(sourcePage.url)}`;
    source.addEventListener("click", () => openPage(sourcePage.url));
    element.append(source);
  }
}

function renderWebsiteScan(state) {
  if (!state) {
    siteScanStatus.textContent = "Waiting for scan data…";
    scanCountDiscovered.textContent = "0 pages discovered";
    scanCountAnalyzed.textContent = "0 analyzed";
    scanCountRelevant.textContent = "0 relevant";
    renderFindingValue(scanTrialSummary, "No trial information yet.");
    renderFindingValue(scanPaymentSummary, "No payment information yet.");
    renderFindingValue(scanRenewalSummary, "No renewal information yet.");
    renderFindingValue(scanCancellationSummary, "Cancellation information not found during automatic scan.");
    scanCancellationPath.textContent = "";
    scanManualNote.hidden = true;
    scanPages.replaceChildren();
    return;
  }

  const discovered = state.summary?.discoveredCount ?? state.discoveredPages?.length ?? 0;
  const analyzed = state.summary?.analyzedCount ?? state.analyzedPages?.length ?? 0;
  const relevant = state.summary?.relevantCount ?? state.analyzedPages?.filter((page) => {
    const f = page.websiteAnalysis?.findings || {};
    return (page.score || 0) >= 20 || f.trial?.detected || f.payment?.pageDetected || f.payment?.required === true || f.renewal?.automatic === true || f.cancellation?.detected || f.subscription?.detected;
  }).length ?? 0;

  scanCountDiscovered.textContent = `${discovered} page${discovered === 1 ? "" : "s"} discovered`;
  scanCountAnalyzed.textContent = `${analyzed} analyzed`;
  scanCountRelevant.textContent = `${relevant} relevant`;

  if (state.scanStatus === "scanning") siteScanStatus.textContent = "Scanning…";
  else if (state.scanStatus === "partial") siteScanStatus.textContent = "Partial scan";
  else if (state.scanStatus === "complete") siteScanStatus.textContent = "Scan complete";
  else siteScanStatus.textContent = "Scan ready";

  const trialPage = findFirstFinding(state, (f) => f.trial?.detected);
  const paymentPage = findFirstFinding(state, (f) => f.payment?.pageDetected || f.payment?.required === true);
  const renewalPage = findFirstFinding(state, (f) => f.renewal?.automatic === true);
  const cancellationPage = findFirstFinding(state, (f) => f.cancellation?.detected);

  if (trialPage) {
    const trial = trialPage.websiteAnalysis.findings.trial;
    const duration = trial.duration ? ` · ${trial.duration}` : "";
    renderFindingValue(scanTrialSummary, `✓ ${trial.duration ? trial.duration : "Trial detected"}`, trialPage, "ok");
  } else {
    renderFindingValue(scanTrialSummary, "No clear trial found on analyzed pages.");
  }

  if (paymentPage) {
    const payment = paymentPage.websiteAnalysis.findings.payment;
    const price = payment.subscriptionPrice ? ` · ${payment.subscriptionPrice}` : "";
    const text = payment.required === true ? `⚠ Payment required${price}` : `Payment page found${price}`;
    renderFindingValue(scanPaymentSummary, text, paymentPage, payment.required === true ? "warning" : "neutral");
  } else {
    renderFindingValue(scanPaymentSummary, "No payment finding on analyzed pages.");
  }

  if (renewalPage) {
    const renewal = renewalPage.websiteAnalysis.findings.renewal;
    renderFindingValue(scanRenewalSummary, renewal.price ? `⚠ ${renewal.price}` : "⚠ Automatic renewal detected", renewalPage, "warning");
  } else {
    renderFindingValue(scanRenewalSummary, "No automatic-renewal finding on analyzed pages.");
  }

  const cancellation = state.summary?.cancellation;
  if (cancellation?.found) {
    const steps = cancellation.stepsObserved || 0;
    renderFindingValue(scanCancellationSummary, `✓ Found · ${steps} step${steps === 1 ? "" : "s"} observed`, cancellationPage, "ok");
  } else {
    renderFindingValue(scanCancellationSummary, "Cancellation information not found during automatic scan.");
  }

  scanCancellationPath.textContent = cancellation?.path?.length
    ? `Observed path: ${cancellation.path.map(pathnameFor).join(" → ")}`
    : cancellation?.found
      ? "Cancellation was observed, but no multi-page path could be established from discovered links."
      : "This does not mean cancellation is unavailable; protected, dynamic, or unvisited pages may still contain it.";

  const manualPages = state.summary?.manualVisitRequired || [];
  const failedPages = state.failedPages || [];
  if (manualPages.length || failedPages.length) {
    scanManualNote.hidden = false;
    scanManualNote.textContent = `Some pages were not fully scannable: ${manualPages.length} require manual visit${manualPages.length === 1 ? "" : "s"}${failedPages.length ? `, ${failedPages.length} could not be accessed` : ""}.`;
  } else {
    scanManualNote.hidden = true;
  }

  scanPages.replaceChildren();
  const pagesToShow = (state.analyzedPages || [])
    .slice()
    .sort((a, b) => (b.score || 0) - (a.score || 0))
    .slice(0, 20);

  for (const page of pagesToShow) {
    const item = document.createElement("li");
    item.className = "scan-page";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "scan-page-button";
    const title = document.createElement("strong");
    const meta = document.createElement("span");
    const finding = document.createElement("span");
    const analysis = page.websiteAnalysis;
    const f = analysis?.findings || {};
    const tags = [];
    if (f.trial?.detected) tags.push("Trial");
    if (f.payment?.pageDetected || f.payment?.required === true) tags.push("Payment");
    if (f.renewal?.automatic === true) tags.push("Renewal");
    if (f.cancellation?.detected) tags.push("Cancellation");
    if (analysis?.requiresManualVisit) tags.push("Manual visit");
    title.textContent = page.title || pathnameFor(page.url);
    meta.textContent = pathnameFor(page.url);
    finding.textContent = tags.length ? tags.join(" · ") : "No relevant subscription signal found";
    button.append(title, meta, finding);
    button.addEventListener("click", () => openPage(page.url));
    item.append(button);
    scanPages.append(item);
  }
}

async function loadWebsiteScan(tab) {
  if (!tab?.url || !/^https?:/.test(tab.url)) {
    renderWebsiteScan(null);
    siteScanStart.disabled = true;
    return;
  }
  siteScanStart.disabled = false;
  const hostname = hostnameFromUrl(tab.url);
  const key = `trialshield_scanner:${hostname}`;
  const stored = await chrome.storage.local.get(key).catch(() => ({}));
  renderWebsiteScan(stored[key] || null);

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === "local" && changes[key]) renderWebsiteScan(changes[key].newValue || null);
  });
}

siteScanStart.addEventListener("click", async () => {
  siteScanStart.disabled = true;
  siteScanStatus.textContent = "Scanning…";
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) {
    chrome.runtime.sendMessage({ type: "TRIALSHIELD_SCANNER_START", tabId: tab.id, url: tab.url }).catch(() => {});
  }
  setTimeout(() => { siteScanStart.disabled = false; }, 900);
});

resultCount.textContent = "Search for music, design, fitness, streaming, or another service available in India.";
(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  await loadWebsiteScan(tab);
  await analyzeActivePage();
})();

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
