// TrialShield background service worker
//
// Orchestrates the local website-wide scanner while leaving the existing live
// page monitor independent. Crawled pages are opened only in inactive tabs;
// page content is analyzed inside the extension and never sent to a backend,
// telemetry service, or third party.

const WARNING_COLOR = "#c0392b";
const NEUTRAL_COLOR = "#2f7d3d";

const CRAWL_MAX_PAGES = 20;
const CRAWL_MAX_DEPTH = 2;
const CRAWL_MAX_CONCURRENT = 2;
const CRAWL_TAB_TIMEOUT_MS = 15000;

const activeCrawls = new Map(); // site -> { running, sourceTabId, active, crawlTabIds, canceled }
const crawlTabs = new Map(); // tabId -> { site, url, createdByScanner }

function hostnameFromUrl(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "") || "unknown-site";
  } catch {
    return "unknown-site";
  }
}

function scannerKey(site) {
  return `trialshield_scanner:${site}`;
}

function computeBadge(data) {
  if (!data) return { text: "", color: NEUTRAL_COLOR };

  const onPaidPlan = data.plan?.status === "paid";
  const hasWarning =
    !onPaidPlan &&
    ((data.trial?.detected && data.trial?.paymentRequired === true) ||
      data.renewal?.automatic === true ||
      data.cancellation?.changed === true);

  if (hasWarning) return { text: "!", color: WARNING_COLOR };

  const hasPositiveSignal = (!onPaidPlan && data.trial?.detected) || data.cancellation?.stepsObserved > 0;
  if (hasPositiveSignal) return { text: "\u2713", color: NEUTRAL_COLOR };

  return { text: "", color: NEUTRAL_COLOR };
}

async function setBadgeForTab(tabId, badge) {
  try {
    await chrome.action.setBadgeText({ tabId, text: badge.text });
    if (badge.text) await chrome.action.setBadgeBackgroundColor({ tabId, color: badge.color });
  } catch {
    // The tab may have been closed between receipt and the badge update.
  }
}

function getOrCreateCrawlRun(site, sourceTabId) {
  let run = activeCrawls.get(site);
  if (!run) {
    run = {
      running: false,
      sourceTabId,
      active: new Set(),
      crawlTabIds: new Set(),
      canceled: false
    };
    activeCrawls.set(site, run);
  } else if (sourceTabId != null) {
    run.sourceTabId = sourceTabId;
  }
  return run;
}

async function readScannerState(site) {
  const stored = await chrome.storage.local.get(scannerKey(site));
  return stored[scannerKey(site)] || null;
}

async function writeScannerState(site, updater) {
  const key = scannerKey(site);
  const stored = await chrome.storage.local.get(key);
  const state = stored[key] || {
    version: 4,
    site,
    currentUrl: null,
    scanStatus: "idle",
    limits: {
      maxPages: CRAWL_MAX_PAGES,
      maxDepth: CRAWL_MAX_DEPTH,
      maxConcurrent: CRAWL_MAX_CONCURRENT,
      timeoutMs: CRAWL_TAB_TIMEOUT_MS
    },
    discoveredPages: [],
    queuedPages: [],
    analyzedPages: [],
    scannedPages: [],
    failedPages: [],
    activeScans: {},
    summary: {
      cancellation: {
        found: false,
        pages: [],
        path: [],
        stepsObserved: 0,
        message: "Cancellation information not found during automatic scan."
      }
    },
    lastUpdated: Date.now()
  };

  state.version = Math.max(4, Number(state.version) || 0);
  state.limits = {
    maxPages: CRAWL_MAX_PAGES,
    maxDepth: CRAWL_MAX_DEPTH,
    maxConcurrent: CRAWL_MAX_CONCURRENT,
    timeoutMs: CRAWL_TAB_TIMEOUT_MS,
    ...(state.limits || {})
  };
  state.summary = state.summary && typeof state.summary === "object" ? state.summary : {};
  state.summary.cancellation = state.summary.cancellation && typeof state.summary.cancellation === "object"
    ? state.summary.cancellation
    : {
        found: false,
        pages: [],
        path: [],
        stepsObserved: 0,
        message: "Cancellation information not found during automatic scan."
      };
  state.discoveredPages = Array.isArray(state.discoveredPages) ? state.discoveredPages : [];
  state.queuedPages = Array.isArray(state.queuedPages) ? state.queuedPages : [];
  state.analyzedPages = Array.isArray(state.analyzedPages) ? state.analyzedPages : [];
  state.scannedPages = Array.isArray(state.scannedPages) ? state.scannedPages : [];
  state.failedPages = Array.isArray(state.failedPages) ? state.failedPages : [];
  state.activeScans = state.activeScans && typeof state.activeScans === "object" ? state.activeScans : {};

  const updated = await updater(state);
  updated.lastUpdated = Date.now();
  await chrome.storage.local.set({ [key]: updated });
  return updated;
}

function scoreFor(state, url) {
  return state.discoveredPages.find((page) => page.url === url)?.score || 0;
}

function depthFor(state, url) {
  return state.discoveredPages.find((page) => page.url === url)?.depth ?? CRAWL_MAX_DEPTH + 1;
}

function sortQueueInState(state) {
  state.queuedPages = [...new Set(state.queuedPages || [])]
    .filter((url) => !state.scannedPages.includes(url) && !state.failedPages.includes(url) && !state.activeScans?.[url])
    .sort((a, b) => scoreFor(state, b) - scoreFor(state, a));
  return state;
}

function markScanStartedInState(state, url) {
  state.queuedPages = (state.queuedPages || []).filter((candidate) => candidate !== url);
  state.activeScans = state.activeScans || {};
  state.activeScans[url] = Date.now();
  state.scanStatus = "scanning";
  return state;
}

function isHttpUrl(url) {
  try {
    return /^https?:$/.test(new URL(url).protocol);
  } catch {
    return false;
  }
}

function waitForTabComplete(tabId) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timeoutId;

    const cleanup = () => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timeoutId);
    };

    const finish = (result) => {
      cleanup();
      result instanceof Error ? reject(result) : resolve(result);
    };

    const listener = (updatedTabId, changeInfo, tab) => {
      if (updatedTabId !== tabId) return;
      if (changeInfo.status === "complete") finish(tab);
    };

    chrome.tabs.onUpdated.addListener(listener);
    timeoutId = setTimeout(() => finish(new Error("Page load timed out")), CRAWL_TAB_TIMEOUT_MS);

    chrome.tabs.get(tabId)
      .then((tab) => {
        if (tab?.status === "complete") finish(tab);
      })
      .catch((error) => finish(error instanceof Error ? error : new Error("Unable to inspect crawl tab")));
  });
}

async function requestPageScan(tabId) {
  const crawl = await chrome.tabs.sendMessage(tabId, { type: "TRIALSHIELD_CRAWL_SCAN" });
  if (!crawl?.ok) return crawl;

  const website = await chrome.tabs.sendMessage(tabId, { type: "TRIALSHIELD_ANALYZE_WEBSITE_PAGE" });
  const trial = await chrome.tabs.sendMessage(tabId, { type: "TRIALSHIELD_ANALYZE" });
  return {
    ...crawl,
    websiteAnalysis: website?.ok ? website.analysis : null,
    trialAnalysis: trial?.ok ? trial.trial : null
  };
}

function isCrawlCanceled(site) {
  return activeCrawls.get(site)?.canceled === true;
}

async function createAndScanTab(site, url, run) {
  if (!isHttpUrl(url)) throw new Error("Unsupported crawl URL");
  if (run.canceled) throw new Error("Scan canceled");

  const tab = await chrome.tabs.create({ url, active: false });
  run.crawlTabIds.add(tab.id);
  crawlTabs.set(tab.id, { site, url, createdByScanner: true });

  try {
    await waitForTabComplete(tab.id);
    if (run.canceled) throw new Error("Scan canceled");

    const loaded = await chrome.tabs.get(tab.id);
    const expected = new URL(url);
    const actual = loaded?.url ? new URL(loaded.url) : null;
    if (!actual) throw new Error("Unable to determine loaded page");
    if (actual.origin !== expected.origin) {
      throw new Error("Redirected outside the same origin; page not scanned");
    }

    const response = await requestPageScan(tab.id);
    if (!response?.ok) throw new Error(response?.error || "Page scan unavailable");
    return response;
  } finally {
    crawlTabs.delete(tab.id);
    run.crawlTabIds.delete(tab.id);
    try {
      await chrome.tabs.remove(tab.id);
    } catch {
      // If the user/browser already closed it, cleanup is complete.
    }
  }
}

function discoveredEntry(state, url) {
  return state.discoveredPages.find((page) => page.url === url) || null;
}

function analyzedEntry(state, url) {
  return state.analyzedPages.find((page) => page.url === url) || null;
}

function isRelevantAnalyzedPage(page) {
  const findings = page.websiteAnalysis?.findings || {};
  return (page.score || 0) >= 20 ||
    !!findings.trial?.detected ||
    !!findings.payment?.pageDetected ||
    findings.payment?.required === true ||
    findings.renewal?.automatic === true ||
    !!findings.cancellation?.detected ||
    !!findings.subscription?.detected;
}

function rebuildWebsiteSummary(state) {
  const cancellationPages = state.analyzedPages
    .filter((page) => page.websiteAnalysis?.findings?.cancellation?.detected)
    .sort((a, b) => (a.depth - b.depth) || (a.analyzedAt - b.analyzedAt));

  const stepSet = new Set();
  for (const page of cancellationPages) {
    for (const step of page.websiteAnalysis?.findings?.cancellation?.steps || []) stepSet.add(step);
  }

  const candidateTargets = [...cancellationPages];
  let bestPath = [];
  for (const target of candidateTargets) {
    const path = [];
    const seen = new Set();
    let cursorUrl = target.url;

    while (cursorUrl && !seen.has(cursorUrl)) {
      seen.add(cursorUrl);
      const analyzed = analyzedEntry(state, cursorUrl);
      const discovered = discoveredEntry(state, cursorUrl);
      if (!analyzed && !discovered) break;

      const eligible = !!analyzed && (
        analyzed.websiteAnalysis?.findings?.cancellation?.detected ||
        /account|subscription|billing|cancellation|manage|cancel/i.test(analyzed.websiteAnalysis?.pageType || "") ||
        (discovered?.score || 0) >= 60
      );
      if (eligible || cursorUrl === target.url) path.unshift(cursorUrl);
      cursorUrl = discovered?.sourceUrl || null;
    }

    if (path.length > bestPath.length) bestPath = path;
  }

  const manualPages = state.analyzedPages.filter((page) => page.websiteAnalysis?.requiresManualVisit);
  const failedPages = state.failedPages || [];
  const relevantPages = state.analyzedPages.filter(isRelevantAnalyzedPage);
  const found = cancellationPages.length > 0;

  state.summary = state.summary || {};
  state.summary.cancellation = {
    found,
    pages: found ? cancellationPages.map((page) => page.url) : [],
    path: bestPath,
    stepsObserved: stepSet.size,
    observedSteps: [...stepSet],
    message: found ? null : "Cancellation information not found during automatic scan.",
    manualVisitPages: manualPages.map((page) => page.url),
    failedPages: failedPages.slice(),
    caveat: found
      ? "Observed on accessible pages only; the scan does not claim that unvisited or protected pages lack cancellation information."
      : "This does not mean cancellation is unavailable; protected, JavaScript-dependent, or unvisited pages may still contain it."
  };

  state.summary.manualVisitRequired = manualPages.map((page) => ({
    url: page.url,
    reason: page.websiteAnalysis?.access?.status || "dynamic page"
  }));
  state.summary.discoveredCount = state.discoveredPages.length;
  state.summary.analyzedCount = state.analyzedPages.length;
  state.summary.relevantCount = relevantPages.length;
  state.summary.failedCount = failedPages.length;
  state.summary.partial = manualPages.length > 0 || failedPages.length > 0;
  state.summary.relevantPages = relevantPages.map((page) => ({
    url: page.url,
    title: page.title || null,
    pageType: page.websiteAnalysis?.pageType || "unknown",
    score: page.score || 0
  }));

  // Unified website findings are a local aggregate, not a replacement for the
  // existing live monitor. The current page can be merged into this summary
  // by the background scan without interrupting the live-monitor storage key.
  const findingSources = [];
  for (const page of relevantPages) {
    const f = page.websiteAnalysis?.findings || {};
    if (f.trial?.detected) findingSources.push({ type: "trial", url: page.url });
    if (f.payment?.pageDetected || f.payment?.required === true) findingSources.push({ type: "payment", url: page.url });
    if (f.renewal?.automatic === true) findingSources.push({ type: "renewal", url: page.url });
    if (f.cancellation?.detected) findingSources.push({ type: "cancellation", url: page.url });
  }
  state.summary.findingSources = findingSources;
  return state;
}

function buildPartialOrCompleteStatus(state) {
  if ((state.queuedPages || []).length || Object.keys(state.activeScans || {}).length) return "scanning";
  return state.summary?.partial ? "partial" : "complete";
}

async function storeScanResult(site, url, result) {
  return writeScannerState(site, (state) => {
    const discovered = discoveredEntry(state, url);
    const existingIndex = state.analyzedPages.findIndex((page) => page.url === url);
    const page = {
      url,
      title: result?.websiteAnalysis?.title || discovered?.title || result?.trialAnalysis?.page_title || null,
      depth: discovered?.depth ?? 0,
      score: discovered?.score || 0,
      sourceUrl: discovered?.sourceUrl || null,
      websiteAnalysis: result?.websiteAnalysis || null,
      trialAnalysis: result?.trialAnalysis || null,
      analyzedAt: Date.now()
    };

    if (existingIndex >= 0) state.analyzedPages[existingIndex] = { ...state.analyzedPages[existingIndex], ...page };
    else state.analyzedPages.push(page);

    state.scannedPages = [...new Set([...(state.scannedPages || []), url])];
    state.queuedPages = (state.queuedPages || []).filter((candidate) => candidate !== url);
    delete state.activeScans[url];
    rebuildWebsiteSummary(state);
    state.scanStatus = buildPartialOrCompleteStatus(state);
    return state;
  });
}

async function markScanFailed(site, url, error, run) {
  await writeScannerState(site, (state) => {
    delete state.activeScans?.[url];
    state.failedPages = [...new Set([...(state.failedPages || []), url])].slice(-CRAWL_MAX_PAGES);
    state.queuedPages = (state.queuedPages || []).filter((candidate) => candidate !== url);
    state.lastError = error || "Unable to scan page";
    rebuildWebsiteSummary(state);
    state.scanStatus = run?.canceled ? "partial" : buildPartialOrCompleteStatus(state);
    return state;
  });
}

async function processOneUrl(site, url, run) {
  run.active.add(url);
  try {
    await writeScannerState(site, (state) => markScanStartedInState(state, url));
    if (run.canceled) return null;

    const result = await createAndScanTab(site, url, run);
    if (run.canceled) return null;

    await storeScanResult(site, url, result);
    return result;
  } catch (error) {
    if (!run.canceled) {
      await markScanFailed(site, url, error instanceof Error ? error.message : "Unable to scan page", run);
    }
    return null;
  } finally {
    run.active.delete(url);
  }
}

async function scanCurrentTabOnce(site, sourceTabId) {
  if (sourceTabId == null) return false;
  try {
    const tab = await chrome.tabs.get(sourceTabId);
    if (!tab?.url || hostnameFromUrl(tab.url) !== site || !isHttpUrl(tab.url)) return false;
    const normalized = normalizeUrlForState(tab.url);
    const state = await readScannerState(site);
    if (state?.scannedPages?.includes(normalized)) return true;

    const response = await requestPageScan(sourceTabId);
    if (!response?.ok) return false;
    await storeScanResult(site, normalized, response);
    return true;
  } catch {
    return false;
  }
}

function normalizeUrlForState(url) {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return url;
  }
}

async function pickNextUrls(site, run) {
  const state = await readScannerState(site);
  if (!state || run.canceled) return [];

  const capacity = Math.max(0, CRAWL_MAX_CONCURRENT - run.active.size);
  if (!capacity) return [];

  sortQueueInState(state);
  const candidates = [];
  for (const url of state.queuedPages || []) {
    if (candidates.length >= capacity) break;
    if (depthFor(state, url) > CRAWL_MAX_DEPTH) continue;
    if (run.active.has(url)) continue;
    candidates.push(url);
  }
  return candidates;
}

async function finishCrawl(site) {
  const run = activeCrawls.get(site);
  const state = await readScannerState(site);
  if (!state) return;

  await writeScannerState(site, (current) => {
    sortQueueInState(current);
    rebuildWebsiteSummary(current);
    if (!current.queuedPages.length && !Object.keys(current.activeScans || {}).length && !run?.active.size) {
      current.scanStatus = run?.canceled ? "partial" : buildPartialOrCompleteStatus(current);
    } else if (run?.canceled) {
      current.scanStatus = "partial";
    }
    return current;
  });
}

async function cancelCrawl(site, reason = "Scan canceled") {
  const run = activeCrawls.get(site);
  if (!run) return;

  run.canceled = true;
  for (const tabId of [...run.crawlTabIds]) {
    try {
      await chrome.tabs.remove(tabId);
    } catch {
      // Already closed.
    }
  }

  await writeScannerState(site, (state) => {
    state.scanStatus = "partial";
    state.lastError = reason;
    for (const url of Object.keys(state.activeScans || {})) delete state.activeScans[url];
    sortQueueInState(state);
    rebuildWebsiteSummary(state);
    return state;
  }).catch(() => {});
}

async function cancelCrawlsForSourceTabExcept(sourceTabId, keepSite) {
  const cancellations = [];
  for (const [site, run] of activeCrawls.entries()) {
    if (run.sourceTabId === sourceTabId && site !== keepSite) {
      cancellations.push(cancelCrawl(site, "Scan canceled because the current tab changed domain"));
    }
  }
  await Promise.all(cancellations);
}

async function pumpCrawl(site, sourceTabId = null) {
  const run = getOrCreateCrawlRun(site, sourceTabId);
  if (run.running) return;
  run.running = true;
  run.canceled = false;

  try {
    let state = await readScannerState(site);
    if (!state) return;

    // Current page has priority over queued background pages. This calls the
    // exact same local analysis path used for an inactive crawl tab, without
    // navigating or blocking the user's page.
    if (sourceTabId != null && !isCrawlCanceled(site)) {
      await scanCurrentTabOnce(site, sourceTabId);
      state = await readScannerState(site);
      if (!state) return;
    }

    while (!run.canceled) {
      const nextUrls = await pickNextUrls(site, run);
      if (!nextUrls.length) break;
      await Promise.all(nextUrls.map((url) => processOneUrl(site, url, run)));
    }
  } finally {
    run.running = false;
    await finishCrawl(site);

    const latest = await readScannerState(site);
    if (!run.canceled && latest?.queuedPages?.length && !run.active.size) {
      setTimeout(() => pumpCrawl(site, run.sourceTabId), 0);
    }
  }
}

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type === "TRIALSHIELD_SCANNER_START") {
    const sourceTabId = Number.isInteger(message.tabId) ? message.tabId : sender.tab?.id;
    const site = hostnameFromUrl(message.url || sender.tab?.url || "");
    if (site !== "unknown-site") {
      cancelCrawlsForSourceTabExcept(sourceTabId, site)
        .finally(() => pumpCrawl(site, sourceTabId ?? null))
        .catch(() => {});
    }
    return;
  }

  if (message?.type === "TRIALSHIELD_SCANNER_PAGE_CHANGED") {
    const tabId = sender.tab?.id;
    const newSite = hostnameFromUrl(message.url || sender.tab?.url || "");
    if (tabId == null || newSite === "unknown-site") return;
    cancelCrawlsForSourceTabExcept(tabId, newSite).catch(() => {});
    return;
  }

  if (message?.type === "TRIALSHIELD_JOURNEY_UPDATED") {
    const tabId = sender.tab?.id;
    if (tabId == null) return;
    setBadgeForTab(tabId, computeBadge(message.data));
    return;
  }

  if (message?.type === "TRIALSHIELD_SCANNER_QUEUE_UPDATED") {
    const sourceTabId = sender.tab?.id;
    const site = hostnameFromUrl(sender.tab?.url || message.url || "");
    if (site === "unknown-site") return;
    pumpCrawl(site, sourceTabId ?? null).catch(() => {});
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "loading") {
    chrome.action.setBadgeText({ tabId, text: "" }).catch(() => {});
  }

  if (changeInfo.url && crawlTabs.has(tabId) && !isHttpUrl(changeInfo.url)) {
    chrome.tabs.remove(tabId).catch(() => {});
    return;
  }

  if (!changeInfo.url || !tab?.url || !isHttpUrl(tab.url)) return;

  const currentSite = hostnameFromUrl(tab.url);
  cancelCrawlsForSourceTabExcept(tabId, currentSite).catch(() => {});
});

chrome.tabs.onRemoved.addListener((tabId) => {
  const crawl = crawlTabs.get(tabId);
  if (crawl) {
    crawlTabs.delete(tabId);
    const run = activeCrawls.get(crawl.site);
    run?.crawlTabIds.delete(tabId);
    if (run?.active.has(crawl.url)) {
      markScanFailed(crawl.site, crawl.url, "Crawl tab closed before scan completed", run).catch(() => {});
    }
  }

  for (const [site, run] of activeCrawls.entries()) {
    if (run.sourceTabId === tabId) cancelCrawl(site, "Scan canceled because the source tab was closed").catch(() => {});
  }
});
