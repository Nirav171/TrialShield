// TrialShield website-wide scanner (Phase 2)
//
// Runs entirely inside the extension. The content script discovers and scores
// same-origin destinations from the current DOM; the background service worker
// consumes the persisted queue by opening inactive tabs and asking this script
// for a local page scan. No page content is sent to any external service.
(() => {
  if (window.__trialShieldScannerInitialized) return;
  window.__trialShieldScannerInitialized = true;

  // --- Scan-scope limits ----------------------------------------------------
  const MAX_PAGES = 20;
  const MAX_DEPTH = 2;
  const MAX_CONCURRENT = 2;
  const MAX_LINKS_PER_PAGE = 80;
  const MAX_LINK_TEXT = 180;
  const MAX_CONTEXT_TEXT = 300;
  const MAX_ANALYSIS_EVIDENCE = 8;

  const VERY_HIGH_PRIORITY = [
    ["payment", 100], ["checkout", 100], ["subscription", 100],
    ["cancellation", 100], ["cancel", 100], ["billing", 90], ["renewal", 90]
  ];
  const HIGH_PRIORITY = [
    ["pricing", 80], ["trial", 80], ["free-trial", 80],
    ["signup", 70], ["membership", 70], ["account", 60]
  ];
  const MEDIUM_PRIORITY = [
    ["terms", 30], ["refund", 30], ["refund-policy", 30], ["faq", 20],
    ["help", 20], ["support", 20]
  ];
  const LOW_PRIORITY = ["blog", "news", "careers", "press", "gallery"];
  const TRACKING_PARAMS = new Set([
    "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
    "utm_id", "gclid", "dclid", "fbclid", "msclkid", "mc_cid", "mc_eid",
    "ref", "referrer", "source"
  ]);
  const DOWNLOAD_EXTENSIONS = /\.(?:pdf|docx?|xlsx?|pptx?|csv|zip|rar|7z|tar|gz|jpg|jpeg|png|gif|webp|svg|mp4|webm|mp3|wav)(?:$|\?)/i;

  // --- Negation-aware detection ---------------------------------------------
  // A raw "free trial" keyword hit also matches negative statements like
  // "Spotify doesn't offer a free trial" or "no free trial available".
  // Check a short window before each match for a negator and discard hits
  // that turn out to be denials rather than offers.
  const NEGATION_WINDOW = /\b(no|not|n't|never|without|isn't|aren't|wasn't|weren't|doesn't|don't|didn't|won't|can't|cannot|unavailable|discontinued|ended|removed|no longer)\b[^.!?\n]{0,40}$/i;

  function isNegatedContext(text, matchIndex) {
    const start = Math.max(0, matchIndex - 60);
    const window = text.slice(start, matchIndex);
    return NEGATION_WINDOW.test(window);
  }

  function detectPositive(text, pattern) {
    const re = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g");
    let match;
    while ((match = re.exec(text)) !== null) {
      if (!isNegatedContext(text, match.index)) return true;
      if (match.index === re.lastIndex) re.lastIndex++; // avoid infinite loop on zero-width matches
    }
    return false;
  }

  // --- "Free trial" vs. "free plan" disambiguation (see identical helper in
  // content.js; duplicated here since the scanner runs in its own closure).
  // A bare "free trial" keyword hit isn't enough — many sites use "free plan"
  // / "try it free" language for a permanently-free, $0, no-card tier. We
  // only report hasFreeTrial when there's also a signal the offer converts
  // to a paid charge, and let explicit "free forever" language veto an
  // uncorroborated hit.
  const FREE_FOREVER_PATTERN =
    /free forever|forever free|always free|100% free|completely free|free version\b|free tier\b(?!.*trial)|free plan\b(?!.*trial)|no credit card,? ever|free,? no strings attached|free for as long as you (?:like|want)/i;

  const TRIAL_CONVERSION_SIGNAL =
    /(?:then|after (?:that|your trial|the trial)|once (?:the |your )?trial (?:ends?|is over)|renews? at|billed at|you'?ll be charged|will be charged|automatically (?:renews?|converts?) (?:to|into) (?:the )?(?:paid|premium|full))\s*[:\-]?\s*(?:[$€£₹]\s?\d+(?:[.,]\d{1,2})?)?|\d+[\s-]*(?:day|week|month)s?[\s-]*(?:free\s+)?trial|(?:credit|debit) card required|payment method required|valid payment method/i;

  function isGenuineFreeTrial(text) {
    const keywordHit = detectPositive(text, /free trial|trial period|try (?:it )?free/i);
    if (!keywordHit) return false;
    const corroborated = TRIAL_CONVERSION_SIGNAL.test(text);
    const explicitlyFreeForever = detectPositive(text, FREE_FOREVER_PATTERN);
    if (explicitlyFreeForever && !corroborated) return false;
    return corroborated;
  }

  const stateWriteQueue = new Map();

  function hostnameKey() {
    return location.hostname.replace(/^www\./, "") || "unknown-site";
  }

  function siteKeyFromHost(hostname) {
    return String(hostname || "").replace(/^www\./, "") || "unknown-site";
  }

  function normalizeUrl(rawUrl) {
    try {
      const url = new URL(rawUrl, location.href);
      if (!/^https?:$/.test(url.protocol)) return null;
      url.hash = "";
      for (const key of Array.from(url.searchParams.keys())) {
        if (TRACKING_PARAMS.has(key.toLowerCase())) url.searchParams.delete(key);
      }
      if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
        url.pathname = url.pathname.slice(0, -1);
      }
      return url.toString();
    } catch {
      return null;
    }
  }

  function isSameOrigin(url) {
    try {
      return new URL(url).origin === location.origin;
    } catch {
      return false;
    }
  }

  function isDownloadUrl(url) {
    try {
      return DOWNLOAD_EXTENSIONS.test(new URL(url).pathname);
    } catch {
      return true;
    }
  }

  function isObviousLowPriority(url) {
    const haystack = url.toLowerCase();
    return LOW_PRIORITY.some((keyword) =>
      new RegExp(`(?:^|[/_.-])${keyword}(?:[/_.-]|$)`, "i").test(haystack)
    );
  }

  function safeText(value, max = MAX_CONTEXT_TEXT) {
    return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
  }

  function surroundingText(anchor) {
    const parts = [];
    const parent = anchor.closest("li, nav, header, footer, section, article, div");
    if (parent) parts.push(parent.innerText || "");
    if (anchor.previousElementSibling) parts.push(anchor.previousElementSibling.innerText || "");
    if (anchor.nextElementSibling) parts.push(anchor.nextElementSibling.innerText || "");
    return safeText(parts.join(" "), MAX_CONTEXT_TEXT);
  }

  function keywordScore(text, table) {
    const haystack = text.toLowerCase();
    let score = 0;
    for (const [keyword, weight] of table) {
      const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (new RegExp(`(?:^|[\\s/_:.#?&=-])${escaped}(?:$|[\\s/_:.#?&=-])`, "i").test(haystack)) {
        score += weight;
      }
    }
    return score;
  }

  function scoreRelevance(url, linkText = "", surrounding = "", pageTitle = "") {
    const urlScore = keywordScore(url, [...VERY_HIGH_PRIORITY, ...HIGH_PRIORITY, ...MEDIUM_PRIORITY]);
    const textScore = keywordScore(linkText, [...VERY_HIGH_PRIORITY, ...HIGH_PRIORITY, ...MEDIUM_PRIORITY]);
    const contextScore = keywordScore(surrounding, [...VERY_HIGH_PRIORITY, ...HIGH_PRIORITY, ...MEDIUM_PRIORITY]);
    const titleScore = keywordScore(pageTitle, [...VERY_HIGH_PRIORITY, ...HIGH_PRIORITY, ...MEDIUM_PRIORITY]);

    // Preserve the requested signal weights: the strongest source signal
    // wins, while URL/text/context/title can each establish relevance.
    let score = Math.max(urlScore, textScore, contextScore, titleScore);
    if (isObviousLowPriority(url)) score = Math.min(score, 5);
    return Math.max(0, Math.min(100, score));
  }

  function getPageTitle() {
    return safeText(document.title, 180);
  }

  function discoverLinksFromPage() {
    const found = new Map();
    const currentTitle = getPageTitle();

    const addCandidate = (raw, text = "", context = "", source = "anchor") => {
      if (!raw || /^(#|mailto:|tel:|javascript:|data:|blob:)/i.test(raw)) return;
      const normalized = normalizeUrl(raw);
      if (!normalized || !isSameOrigin(normalized) || isDownloadUrl(normalized)) return;

      const linkText = safeText(text, MAX_LINK_TEXT);
      const surrounding = safeText(context, MAX_CONTEXT_TEXT);
      const score = scoreRelevance(normalized, linkText, surrounding, currentTitle);
      const current = found.get(normalized);
      const candidate = {
        url: normalized,
        score,
        linkText,
        surroundingText: surrounding,
        source
      };
      if (!current || candidate.score > current.score || (candidate.score === current.score && !current.linkText && linkText)) {
        found.set(normalized, candidate);
      }
    };

    document.querySelectorAll("a[href]").forEach((anchor) => {
      addCandidate(
        anchor.getAttribute("href"),
        anchor.innerText || anchor.getAttribute("aria-label") || anchor.getAttribute("title") || "",
        surroundingText(anchor),
        "anchor"
      );
    });

    // Buttons are considered only when the destination is explicitly exposed
    // through a safe URL-bearing attribute. We do not execute onclick handlers.
    document.querySelectorAll("button[data-href], [role='button'][data-href], button[data-url], [role='button'][data-url]")
      .forEach((button) => {
        addCandidate(
          button.getAttribute("data-href") || button.getAttribute("data-url"),
          button.innerText || button.getAttribute("aria-label") || button.getAttribute("title") || "",
          surroundingText(button),
          "button"
        );
      });

    const canonical = document.querySelector("link[rel='canonical'][href]");
    if (canonical) addCandidate(canonical.getAttribute("href"), "canonical", document.title || "", "canonical");

    const ogUrl = document.querySelector("meta[property='og:url'][content]");
    if (ogUrl) addCandidate(ogUrl.getAttribute("content"), "og:url", document.title || "", "metadata");

    return Array.from(found.values())
      .sort((a, b) => b.score - a.score || a.url.localeCompare(b.url))
      .slice(0, MAX_LINKS_PER_PAGE);
  }

  function emptyScannerState(site, currentUrl) {
    return {
      version: 4,
      site,
      currentUrl,
      startedAt: Date.now(),
      scanStatus: "idle",
      limits: { maxPages: MAX_PAGES, maxDepth: MAX_DEPTH, maxConcurrent: MAX_CONCURRENT },
      discoveredPages: [],
      queuedPages: [],
      analyzedPages: [],
      scannedPages: [],
      failedPages: [],
      activeScans: {},
      lastUpdated: Date.now()
    };
  }

  function normalizeStoredState(stored, site, currentUrl) {
    const base = emptyScannerState(site, currentUrl);
    const state = stored ? { ...base, ...stored } : base;
    state.version = 4;
    state.site = site;
    state.summary = state.summary && typeof state.summary === "object" ? state.summary : {};
    state.summary.cancellation = state.summary.cancellation && typeof state.summary.cancellation === "object"
      ? state.summary.cancellation
      : { found: false, pages: [], stepsObserved: 0, message: "Cancellation information not found during automatic scan." };
    state.currentUrl = currentUrl;
    state.discoveredPages = Array.isArray(state.discoveredPages) ? state.discoveredPages : [];
    state.queuedPages = Array.isArray(state.queuedPages) ? state.queuedPages : [];
    state.analyzedPages = Array.isArray(state.analyzedPages) ? state.analyzedPages : [];
    state.scannedPages = Array.isArray(state.scannedPages) ? state.scannedPages : [];
    state.failedPages = Array.isArray(state.failedPages) ? state.failedPages : [];
    state.activeScans = state.activeScans && typeof state.activeScans === "object" ? state.activeScans : {};
    return state;
  }

  function getStateKey(site = hostnameKey()) {
    return `trialshield_scanner:${siteKeyFromHost(site)}`;
  }

  async function getState() {
    const site = hostnameKey();
    const currentUrl = normalizeUrl(location.href) || location.href;
    const key = getStateKey(site);
    const stored = await chrome.storage.local.get(key);
    return { key, state: normalizeStoredState(stored[key], site, currentUrl) };
  }

  function stateContainsUrl(state, url) {
    return state.discoveredPages.some((page) => page.url === url) ||
      state.scannedPages.includes(url) || state.failedPages.includes(url) ||
      Object.prototype.hasOwnProperty.call(state.activeScans, url);
  }

  function queueUrl(state, candidate, depth, sourceUrl) {
    const existing = state.discoveredPages.find((page) => page.url === candidate.url);
    if (existing) {
      existing.score = Math.max(existing.score || 0, candidate.score || 0);
      if (!existing.linkText && candidate.linkText) existing.linkText = candidate.linkText;
      if (!existing.surroundingText && candidate.surroundingText) existing.surroundingText = candidate.surroundingText;
      return false;
    }
    if (candidate.score <= 0) return false;
    if (state.discoveredPages.length >= MAX_PAGES || depth > MAX_DEPTH || stateContainsUrl(state, candidate.url)) return false;

    state.discoveredPages.push({
      url: candidate.url,
      depth,
      score: candidate.score || 0,
      linkText: candidate.linkText || "",
      surroundingText: candidate.surroundingText || "",
      sourceUrl: sourceUrl || null,
      discoveredAt: Date.now()
    });
    state.queuedPages.push(candidate.url);
    return true;
  }

  function sortQueue(state) {
    const scoreOf = (url) => state.discoveredPages.find((page) => page.url === url)?.score || 0;
    state.queuedPages = [...new Set(state.queuedPages)]
      .filter((url) => !state.scannedPages.includes(url) && !state.failedPages.includes(url) && !state.activeScans[url])
      .sort((a, b) => scoreOf(b) - scoreOf(a));
  }

  async function updateScannerState() {
    const { key, state } = await getState();
    const currentUrl = normalizeUrl(location.href) || location.href;
    const currentPage = state.discoveredPages.find((page) => page.url === currentUrl);
    const currentDepth = currentPage?.depth ?? 0;

    if (!currentPage) {
      state.discoveredPages.push({
        url: currentUrl,
        depth: 0,
        score: 0,
        linkText: getPageTitle(),
        surroundingText: "",
        sourceUrl: null,
        discoveredAt: Date.now()
      });
    }

    if (currentDepth <= MAX_DEPTH) {
      const discovered = discoverLinksFromPage();
      for (const candidate of discovered) {
        if (state.discoveredPages.length >= MAX_PAGES) break;
        const pageDepth = currentDepth + 1;
        if (pageDepth <= MAX_DEPTH) queueUrl(state, candidate, pageDepth, currentUrl);
      }
    }

    // The page currently visible to the user is already being monitored by
    // content.js, so it is considered observed, but background crawling still
    // gets its own page record when requested.
    const previousUrl = state.currentUrl;
    state.currentUrl = currentUrl;
    state.lastUpdated = Date.now();
    sortQueue(state);
    await chrome.storage.local.set({ [key]: state });
    if (previousUrl && previousUrl !== currentUrl) {
      chrome.runtime.sendMessage({
        type: "TRIALSHIELD_SCANNER_PAGE_CHANGED",
        previousUrl,
        url: currentUrl,
        site: hostnameKey()
      }).catch(() => {});
    }
    chrome.runtime.sendMessage({
      type: "TRIALSHIELD_SCANNER_QUEUE_UPDATED",
      site,
      url: currentUrl,
      queueSize: state.queuedPages.length
    }).catch(() => {});
    return state;
  }

  // Evidence sentences must contain a real signal (a duration, a required
  // payment method, an auto-renew clause, a price, an active cancellation
  // flow) rather than just any sentence that happens to mention "trial",
  // "payment", or "cancel" in passing - that was pulling in unrelated page
  // text (even chat/help text) as "evidence".
  const EVIDENCE_SENTENCE_PATTERN =
    /free trial|trial period|\d+[\s-]*(?:day|week|month)s?[\s-]*trial|auto.?renew|payment method required|(?:credit|debit) card required|charged (?:automatically|after)|then\s*(?:[$€£₹]\s?\d+)|renews? at\s*(?:[$€£₹]\s?\d+)|cancel (?:subscription|plan|membership|my account)|billing (?:history|settings)|refund policy/i;

  function extractLocalPageSignals() {
    const bodyText = (document.body?.innerText || "")
      .replace(/\u00a0/g, " ")
      .replace(/\s+/g, " ")
      .slice(0, 250000);
    const title = getPageTitle();
    const url = normalizeUrl(location.href) || location.href;
    const relevantText = [title, url, bodyText.slice(0, 5000)].join(" ");
    const hasFreeTrial = isGenuineFreeTrial(bodyText);
    const evidence = bodyText
      .split(/(?<=[.!?])\s+|\n+/)
      .filter((sentence) => EVIDENCE_SENTENCE_PATTERN.test(sentence))
      .map((sentence) => safeText(sentence, 300))
      .filter((sentence, index, all) => sentence && all.indexOf(sentence) === index)
      .slice(0, MAX_ANALYSIS_EVIDENCE);

    const pageSignals = {
      hasFreeTrial,
      payment: /payment method|credit card|debit card|card details|checkout|billing/i.test(relevantText),
      cancellation: /cancel(?:lation)?(?:\s+(?:subscription|plan|membership|account))?|turn off renewal|disable auto.?renewal/i.test(relevantText),
      renewal: /auto.?renew|automatically renew|charged (?:automatically|after (?:the )?trial)|unless you cancel/i.test(relevantText),
      pricing: /pricing|plans?|\$\s*\d+|€\s*\d+|£\s*\d+|₹\s*\d+/i.test(relevantText),
      pageTitle: title,
      evidence,
      scannedAt: new Date().toISOString()
    };

    return pageSignals;
  }

  async function handleCrawlScan(sendResponse) {
    try {
      const links = discoverLinksFromPage();
      const pageSignals = extractLocalPageSignals();
      const currentUrl = normalizeUrl(location.href) || location.href;
      const { key, state } = await getState();
      const current = state.discoveredPages.find((page) => page.url === currentUrl);
      const depth = current?.depth ?? 0;

      if (depth < MAX_DEPTH) {
        for (const link of links) {
          if (state.discoveredPages.length >= MAX_PAGES) break;
          queueUrl(state, link, depth + 1, currentUrl);
        }
      }

      const pageRecord = {
        url: currentUrl,
        title: pageSignals.pageTitle || null,
        depth,
        score: current?.score || 0,
        sourceUrl: current?.sourceUrl || null,
        pageSignals,
        websiteAnalysis: null,
        analyzedAt: Date.now()
      };
      const existingIndex = state.analyzedPages.findIndex((page) => page.url === currentUrl);
      if (existingIndex >= 0) state.analyzedPages[existingIndex] = pageRecord;
      else state.analyzedPages.push(pageRecord);

      state.scannedPages = [...new Set([...state.scannedPages, currentUrl])];
      state.queuedPages = state.queuedPages.filter((url) => url !== currentUrl);
      delete state.activeScans[currentUrl];
      sortQueue(state);
      state.lastUpdated = Date.now();
      await chrome.storage.local.set({ [key]: state });
      chrome.runtime.sendMessage({
        type: "TRIALSHIELD_SCANNER_QUEUE_UPDATED",
        site: hostnameKey(),
        url: currentUrl,
        queueSize: state.queuedPages.length
      }).catch(() => {});

      sendResponse({
        ok: true,
        url: currentUrl,
        depth,
        pageSignals,
        links,
        queue: state.queuedPages.slice(0, MAX_PAGES)
      });
    } catch (error) {
      sendResponse({ ok: false, error: error instanceof Error ? error.message : "Crawler scan failed" });
    }
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "TRIALSHIELD_CRAWL_SCAN") return;
    handleCrawlScan(sendResponse);
    return true;
  });

  let navigationRefreshTimer = null;

  function scheduleNavigationRefresh() {
    if (navigationRefreshTimer) clearTimeout(navigationRefreshTimer);
    navigationRefreshTimer = setTimeout(() => {
      navigationRefreshTimer = null;
      updateScannerState().catch(() => {});
    }, 250);
  }

  function init() {
    window.addEventListener("trialshield:locationchange", scheduleNavigationRefresh);
    window.addEventListener("popstate", scheduleNavigationRefresh);
    window.addEventListener("hashchange", scheduleNavigationRefresh);
    updateScannerState().catch(() => {});
  }

  if (document.body) init();
  else document.addEventListener("DOMContentLoaded", init, { once: true });

  // Expose only hard limits to the background orchestrator. No page content is
  // exposed globally; all content stays in the message/storage flow above.
  window.__trialShieldScannerLimits = Object.freeze({ MAX_PAGES, MAX_DEPTH, MAX_CONCURRENT });
})();