// The returned plain object matches the shape a backend Pydantic model can validate.
// DOM text is untrusted input: this script only extracts and reports it.
(() => {
  const MAX_TEXT_LENGTH = 250_000;
  const MAX_EVIDENCE = 5;

  function normalizedPageText() {
    return (document.body?.innerText || "")
      .replace(/\u00a0/g, " ")
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .slice(0, MAX_TEXT_LENGTH);
  }

  function firstMatch(text, patterns, fallback = null) {
    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match) return (match[1] || match[0]).trim();
    }
    return fallback;
  }

  function nearbyEvidence(text) {
    return text
      .split(/(?<=[.!?])\s+|\n+/)
      .filter((sentence) => /free trial|trial period|cancel|auto.?renew|payment method|credit card/i.test(sentence))
      .map((sentence) => sentence.trim().slice(0, 300))
      .filter((sentence, index, all) => sentence && all.indexOf(sentence) === index)
      .slice(0, MAX_EVIDENCE);
  }

  function analyzeTrialPage() {
    const text = normalizedPageText();
    const evidence = nearbyEvidence(text);
    const duration = firstMatch(text, [
      /(?:free\s+)?trial(?:\s+period)?(?:\s+(?:for|of|lasts?))?\s+(\d+\s*(?:day|week|month)s?)/i,
      /(\d+\s*(?:day|week|month)s?)\s+(?:free\s+)?trial/i
    ]);
    const start = firstMatch(text, [
      /trial (?:starts?|begins?)\s+(today|immediately|on[^.\n]{1,50})/i,
      /(starts? (?:today|immediately|when you (?:sign up|subscribe)))/i
    ], duration ? "When signup is completed" : null);
    const fee = firstMatch(text, [
      /((?:\$|\u20ac|\u00a3|\u20b9)\s*\d+(?:[.,]\d{1,2})?)(?:\s+(?:today|to start))?/i,
      /(no (?:upfront|initial) (?:fee|charge))/i
    ]);
    const cancellation = firstMatch(text, [
      /((?:cancel|cancellation)[^.\n]{0,180}(?:\.|$))/i,
      /((?:no cancellation fee|cancel anytime)[^.\n]{0,120})/i
    ]);
    const paymentRequired = /(?:credit|debit) card required|payment method required|valid payment method/i.test(text)
      ? true
      : /no (?:credit )?card required/i.test(text)
        ? false
        : null;
    const autoRenews = /automatically renew|auto.?renew|charged (?:automatically|after (?:the )?trial)|unless you cancel/i.test(text)
      ? true
      : /does not automatically renew|no auto.?renewal/i.test(text)
        ? false
        : null;

    return {
      schema_version: "1.0",
      source_url: location.href,
      provider_name: document.querySelector('meta[property="og:site_name"]')?.content || location.hostname.replace(/^www\./, ""),
      page_title: document.title || null,
      has_free_trial: /free trial|trial period|try (?:it )?free/i.test(text),
      trial_start: start,
      trial_duration: duration,
      cancellation_terms: cancellation,
      minimum_fee: fee,
      payment_method_required: paymentRequired,
      auto_renews: autoRenews,
      currency: fee?.match(/[\$\u20ac\u00a3\u20b9]/)?.[0] || null,
      evidence,
      analyzed_at: new Date().toISOString()
    };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "TRIALSHIELD_ANALYZE") return;
    try {
      const trial = analyzeTrialPage();
      chrome.storage.local.set({ [`trial:${location.href}`]: trial });
      sendResponse({ ok: true, trial });
    } catch (error) {
      sendResponse({ ok: false, error: error instanceof Error ? error.message : "Unknown analysis error" });
    }
  });
})();

// ---------------------------------------------------------------------------
// TrialShield continuous monitor (Phase 1)
// Watches the page locally (DOM mutations + SPA navigation) and keeps a
// lightweight, structured snapshot of "relevant" content + a page-type
// classification in chrome.storage.local. No raw DOM, no full page text,
// and no sensitive form values are ever stored.
// Runs independently of the on-demand TRIALSHIELD_ANALYZE handler above.
// ---------------------------------------------------------------------------
(() => {
  if (window.__trialShieldMonitorInitialized) return;
  window.__trialShieldMonitorInitialized = true;

  const DEBOUNCE_MS = 600; // wait for a burst of mutations to settle
  const MIN_SCAN_INTERVAL_MS = 1000; // throttle: never scan more often than this
  const POLL_FALLBACK_MS = 2000; // catches SPA nav that bypasses pushState/replaceState
  const MAX_RELEVANT_ITEMS = 40;
  const MAX_ITEM_LENGTH = 300;
  const MAX_BODY_TEXT_LENGTH = 250_000;

  // Fields whose surrounding text must never be captured, per the security
  // requirement: only labels/terms may be read, never credential values.
  const SENSITIVE_FIELD_SELECTOR = [
    'input[type="password"]',
    'input[autocomplete*="cc-"]',
    'input[name*="card" i]',
    'input[id*="card" i]',
    'input[name*="cvv" i]',
    'input[name*="cvc" i]',
    'input[name*="otp" i]',
    'input[name*="pin" i]',
    'input[autocomplete="one-time-code"]'
  ].join(",");

  const RELEVANT_KEYWORDS =
    /free trial|trial period|trial ends|try (?:it )?free|pricing|price|renew|billing|invoice|cancel|subscription|membership|payment method|credit card|debit card|checkout|manage plan|auto-?renew/i;

  const KEYWORD_MAP = {
    checkout: ["checkout", "review your order", "complete your order", "place order"],
    payment: ["payment method", "credit card", "debit card", "card details", "billing address", "pay now"],
    billing: ["billing history", "billing settings", "invoice", "billing information"],
    subscription: ["subscription", "manage plan", "your plan", "membership"],
    cancellation: ["cancel subscription", "cancel plan", "end membership", "turn off renewal", "disable auto-renewal", "cancel my account", "manage subscription"],
    confirmation: ["order confirmed", "thank you for", "confirmation number", "receipt", "subscription confirmed", "you're all set"],
    trial: ["free trial", "trial period", "try it free", "start your trial", "trial ends"],
    signup: ["sign up", "create account", "create your account", "register"],
    account: ["account settings", "my account", "profile settings"],
    pricing: ["pricing", "plans & pricing", "choose a plan", "compare plans"]
  };

  let observer = null;
  let debounceTimer = null;
  let pollTimer = null;
  let lastScanTime = 0;
  let lastUrl = "";
  let lastSnapshotHash = "";

  function hashString(str) {
    let hash = 5381;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
    }
    return hash.toString(36);
  }

  function isVisible(el) {
    return !!(el && el.offsetParent !== null);
  }

  // Defense-in-depth: redact any 13-19 digit run (card-number length) so
  // that even a mis-coded page that echoes an entered value into visible
  // text can never leak it through a captured snapshot.
  function redactSensitiveNumbers(str) {
    return str.replace(/\b(?:\d[ -]?){12,19}\d\b/g, "[redacted]");
  }

  function clip(str) {
    return redactSensitiveNumbers(str.trim().replace(/\s+/g, " ")).slice(0, MAX_ITEM_LENGTH);
  }

  function dedupePush(list, value) {
    if (!value) return;
    const clipped = clip(value);
    if (clipped && !list.includes(clipped) && list.length < MAX_RELEVANT_ITEMS) {
      list.push(clipped);
    }
  }

  // Collects structured, non-sensitive "relevant" text: headings, keyword
  // sentences, buttons/links, form labels, and open dialogs/modals.
  function collectRelevantText() {
    const items = [];

    document.querySelectorAll("h1, h2, h3").forEach((el) => {
      if (items.length >= MAX_RELEVANT_ITEMS) return;
      if (isVisible(el) && el.innerText?.trim()) dedupePush(items, el.innerText);
    });

    const bodyText = (document.body?.innerText || "").slice(0, MAX_BODY_TEXT_LENGTH);
    bodyText
      .split(/(?<=[.!?])\s+|\n+/)
      .filter((sentence) => RELEVANT_KEYWORDS.test(sentence))
      .forEach((sentence) => dedupePush(items, sentence));

    document.querySelectorAll('button, a, [role="button"], input[type="submit"]').forEach((el) => {
      if (items.length >= MAX_RELEVANT_ITEMS) return;
      const label = el.innerText || el.value || el.getAttribute("aria-label") || "";
      if (label && RELEVANT_KEYWORDS.test(label) && isVisible(el)) dedupePush(items, label);
    });

    // NOTE: we only ever read label text/aria-label here - never an input's
    // `.value` - so entered card/CVV/OTP/password values can't be captured.
    // Labels like "Card number" or "Billing address" are fine to keep; they
    // are terms, not credentials (see SENSITIVE_FIELD_SELECTOR usage below,
    // which is used only for page-type classification, never for reading
    // input values).
    document.querySelectorAll("label, [aria-label]").forEach((el) => {
      if (items.length >= MAX_RELEVANT_ITEMS) return;
      const label = el.innerText || el.getAttribute("aria-label") || "";
      if (label && RELEVANT_KEYWORDS.test(label) && isVisible(el)) dedupePush(items, label);
    });

    document.querySelectorAll('[role="dialog"], [aria-modal="true"], dialog').forEach((el) => {
      if (items.length >= MAX_RELEVANT_ITEMS) return;
      if (isVisible(el) && el.innerText?.trim()) dedupePush(items, el.innerText);
    });

    return items;
  }

  function hasPaymentForm() {
    return !!document.querySelector(SENSITIVE_FIELD_SELECTOR);
  }

  function classifyPageType(relevantText) {
    const url = location.href.toLowerCase();
    const headings = Array.from(document.querySelectorAll("h1, h2, h3"))
      .map((el) => el.innerText || "")
      .join(" ")
      .toLowerCase();
    const combinedText = relevantText.join(" ").toLowerCase();

    const scores = {};
    for (const [type, phrases] of Object.entries(KEYWORD_MAP)) {
      let score = 0;
      for (const phrase of phrases) {
        if (url.includes(phrase.replace(/\s+/g, "-")) || url.includes(phrase.replace(/\s+/g, ""))) score += 3;
        if (headings.includes(phrase)) score += 2;
        if (combinedText.includes(phrase)) score += 1;
      }
      scores[type] = score;
    }

    if (hasPaymentForm()) {
      scores.payment = (scores.payment || 0) + 3;
      scores.checkout = (scores.checkout || 0) + 1;
    }

    const [bestType, bestScore] = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
    if (bestScore > 0) return bestType;
    if (location.pathname === "/" || location.pathname === "") return "landing";
    return "unknown";
  }

  function buildSnapshot() {
    const relevantText = collectRelevantText();
    return {
      url: location.href,
      title: document.title || null,
      pageType: classifyPageType(relevantText),
      relevantText,
      timestamp: Date.now()
    };
  }

  function scanAndMaybeUpdate() {
    const now = Date.now();
    if (now - lastScanTime < MIN_SCAN_INTERVAL_MS) return;

    const snapshot = buildSnapshot();
    const hash = hashString(snapshot.pageType + "|" + snapshot.relevantText.join("|"));
    const urlChanged = snapshot.url !== lastUrl;

    if (!urlChanged && hash === lastSnapshotHash) return; // no meaningful change

    lastScanTime = now;
    lastUrl = snapshot.url;
    lastSnapshotHash = hash;

    chrome.storage.local.set({ [`trialshield_monitor:${snapshot.url}`]: snapshot });

    // Best-effort notification for the popup/background (Phase 3 wiring).
    // No listener is guaranteed to exist yet, so failures are ignored.
    chrome.runtime.sendMessage({ type: "TRIALSHIELD_PAGE_UPDATED", data: snapshot }).catch(() => {});
  }

  function scheduleScan() {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(scanAndMaybeUpdate, DEBOUNCE_MS);
  }

  function startObserving() {
    if (observer) return;
    observer = new MutationObserver(() => scheduleScan());
    observer.observe(document.body, { childList: true, subtree: true });
  }

  function patchHistoryForSpaNav() {
    ["pushState", "replaceState"].forEach((method) => {
      const original = history[method];
      history[method] = function (...args) {
        const result = original.apply(this, args);
        window.dispatchEvent(new Event("trialshield:locationchange"));
        return result;
      };
    });
    window.addEventListener("popstate", () => window.dispatchEvent(new Event("trialshield:locationchange")));
    window.addEventListener("hashchange", () => window.dispatchEvent(new Event("trialshield:locationchange")));
    window.addEventListener("trialshield:locationchange", scheduleScan);
  }

  function startFallbackPolling() {
    // Catches SPA frameworks that navigate without pushState/replaceState/hashchange.
    pollTimer = setInterval(() => {
      if (location.href !== lastUrl) scheduleScan();
    }, POLL_FALLBACK_MS);
  }

  function cleanup() {
    if (observer) observer.disconnect();
    if (debounceTimer) clearTimeout(debounceTimer);
    if (pollTimer) clearInterval(pollTimer);
  }

  function init() {
    scanAndMaybeUpdate(); // initial scan
    startObserving();
    patchHistoryForSpaNav();
    startFallbackPolling();
    window.addEventListener("pagehide", cleanup);
  }

  if (document.body) {
    init();
  } else {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  }
})();