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

  // --- Negation-aware detection ---------------------------------------------
  // A plain keyword hit like "free trial" also matches sentences such as
  // "Spotify doesn't offer a free trial", "no free trial available", or
  // "there isn't a trial for this plan". This checks a small window of text
  // immediately before (and within) the matched sentence for a negator, and
  // discounts/drops matches that are actually negative statements.
  const NEGATION_WINDOW = /\b(no|not|n't|never|without|isn't|aren't|wasn't|weren't|doesn't|don't|didn't|won't|can't|cannot|unavailable|discontinued|ended|removed|no longer)\b[^.!?\n]{0,40}$/i;

  function isNegatedContext(text, matchIndex) {
    const start = Math.max(0, matchIndex - 60);
    const window = text.slice(start, matchIndex);
    return NEGATION_WINDOW.test(window);
  }

  // Returns true only if the pattern matches somewhere in `text` AND that
  // specific occurrence is not preceded by a negator in the same sentence.
  function detectPositive(text, pattern) {
    const re = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g");
    let match;
    while ((match = re.exec(text)) !== null) {
      if (!isNegatedContext(text, match.index)) return true;
      if (match.index === re.lastIndex) re.lastIndex++; // avoid infinite loop on zero-width matches
    }
    return false;
  }

  // --- "Free trial" vs. "free plan" disambiguation ---------------------------
  // A page can say "free trial" in passing (nav links, comparisons, a trial
  // offered only on paid tiers) while the plan actually relevant to the
  // visitor is a permanently-free plan ($0, no card, no expiry). We only want
  // to flag a genuine free TRIAL: a temporary offer that is expected to
  // convert to a paid charge. So a raw keyword hit is not enough — we also
  // require some corroborating "this will eventually cost money" signal, and
  // we let explicit "free forever" language veto a bare keyword hit.
  const FREE_FOREVER_PATTERN =
    /free forever|forever free|always free|100% free|completely free|free version\b|free tier\b(?!.*trial)|free plan\b(?!.*trial)|no credit card,? ever|free,? no strings attached|free for as long as you (?:like|want)/i;

  const TRIAL_CONVERSION_SIGNAL =
    /(?:then|after (?:that|your trial|the trial)|once (?:the |your )?trial (?:ends?|is over)|renews? at|billed at|you'?ll be charged|will be charged|automatically (?:renews?|converts?) (?:to|into) (?:the )?(?:paid|premium|full))\s*[:\-]?\s*(?:[$€£₹]\s?\d+(?:[.,]\d{1,2})?)?/i;

  function hasTrialCorroboration(text, { duration, paymentRequired, autoRenews, fee } = {}) {
    if (paymentRequired === true || autoRenews === true) return true;
    if (duration) return true;
    if (fee && TRIAL_CONVERSION_SIGNAL.test(text)) return true;
    return TRIAL_CONVERSION_SIGNAL.test(text);
  }

  // Decides whether a page describes a genuine free TRIAL (temporary, expected
  // to convert to a paid charge) as opposed to a plan that is simply free.
  function isGenuineFreeTrial(text, signals) {
    const keywordHit = detectPositive(text, /free trial|trial period|try (?:it )?free/i);
    if (!keywordHit) return false;
    const explicitlyFreeForever = detectPositive(text, FREE_FOREVER_PATTERN);
    const corroborated = hasTrialCorroboration(text, signals);
    // A page that explicitly claims to be free forever AND has no signal that
    // money will eventually be charged is treated as a free plan, not a trial.
    if (explicitlyFreeForever && !corroborated) return false;
    return corroborated;
  }

  // Evidence sentences must show real "this costs money eventually" signal,
  // not just any sentence that happens to contain the word "trial" or
  // "cancel" (that was pulling in unrelated page text as "evidence").
  const EVIDENCE_SENTENCE_PATTERN =
    /free trial|trial period|\d+[\s-]*(?:day|week|month)s?[\s-]*trial|auto.?renew|payment method required|(?:credit|debit) card required|charged (?:automatically|after)|then\s*(?:[$€£₹]\s?\d+)|renews? at\s*(?:[$€£₹]\s?\d+)/i;

  function nearbyEvidence(text, isTrial) {
    if (!isTrial) return [];
    return text
      .split(/(?<=[.!?])\s+|\n+/)
      .filter((sentence) => EVIDENCE_SENTENCE_PATTERN.test(sentence))
      .map((sentence) => sentence.trim().slice(0, 300))
      .filter((sentence, index, all) => sentence && all.indexOf(sentence) === index)
      .slice(0, MAX_EVIDENCE);
  }

  function feeFromContext(text) {
    // Only trust a currency amount if it appears in a sentence that also
    // talks about the trial/signup/checkout, not just any price on the page.
    const contextPattern = /free trial|trial|sign\s*up|checkout|subscription|plan|today|to start/i;
    const sentences = text.split(/(?<=[.!?])\s+|\n+/);
    for (const sentence of sentences) {
      if (!contextPattern.test(sentence)) continue;
      const match =
        sentence.match(/((?:\$|\u20ac|\u00a3|\u20b9)\s*\d+(?:[.,]\d{1,2})?)(?:\s+(?:today|to start))?/i) ||
        sentence.match(/(no (?:upfront|initial) (?:fee|charge))/i);
      if (match) return (match[1] || match[0]).trim();
    }
    return null;
  }

  function analyzeTrialPage() {
    const text = normalizedPageText();
    const duration = firstMatch(text, [
      /(?:free\s+)?trial(?:\s+period)?(?:\s+(?:for|of|lasts?))?\s+(\d+\s*(?:day|week|month)s?)/i,
      /(\d+\s*(?:day|week|month)s?)\s+(?:free\s+)?trial/i
    ]);
    const start = firstMatch(text, [
      /trial (?:starts?|begins?)\s+(today|immediately|on[^.\n]{1,50})/i,
      /(starts? (?:today|immediately|when you (?:sign up|subscribe)))/i
    ], duration ? "When signup is completed" : null);
    const fee = feeFromContext(text);
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
    const hasFreeTrial = isGenuineFreeTrial(text, { duration, paymentRequired, autoRenews, fee });
    const evidence = nearbyEvidence(text, hasFreeTrial);

    return {
      schema_version: "1.0",
      source_url: location.href,
      provider_name: document.querySelector('meta[property="og:site_name"]')?.content || location.hostname.replace(/^www\./, ""),
      page_title: document.title || null,
      has_free_trial: hasFreeTrial,
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

  // ---------------------------------------------------------------------
  // Phase 2 constants: trial / payment / renewal / cancellation detection.
  // ---------------------------------------------------------------------
  const CURRENCY_SYMBOL_PATTERN = /[$€£₹]/;

  // --- Negation-aware detection (see identical helper in the analyzer IIFE
  // above) — duplicated here since this monitor runs in its own closure and
  // has no access to that scope. Prevents "doesn't offer a free trial",
  // "no free trial available", etc. from being reported as a positive hit.
  const MONITOR_NEGATION_WINDOW = /\b(no|not|n't|never|without|isn't|aren't|wasn't|weren't|doesn't|don't|didn't|won't|can't|cannot|unavailable|discontinued|ended|removed|no longer)\b[^.!?\n]{0,40}$/i;

  function monitorIsNegatedContext(text, matchIndex) {
    const start = Math.max(0, matchIndex - 60);
    const window = text.slice(start, matchIndex);
    return MONITOR_NEGATION_WINDOW.test(window);
  }

  function detectPositive(text, pattern) {
    const re = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g");
    let match;
    while ((match = re.exec(text)) !== null) {
      if (!monitorIsNegatedContext(text, match.index)) return true;
      if (match.index === re.lastIndex) re.lastIndex++;
    }
    return false;
  }

  // --- "Free trial" vs. "free plan" disambiguation (see identical helper in
  // the analyzer IIFE above; duplicated because this monitor has its own
  // closure). A bare "free trial" keyword hit is not enough to flag a trial —
  // it must be corroborated by a signal that money will eventually be
  // charged, and explicit "free forever" language can veto an uncorroborated
  // hit so permanently-free plans aren't reported as trials.
  const MONITOR_FREE_FOREVER_PATTERN =
    /free forever|forever free|always free|100% free|completely free|free version\b|free tier\b(?!.*trial)|free plan\b(?!.*trial)|no credit card,? ever|free,? no strings attached|free for as long as you (?:like|want)/i;

  const MONITOR_TRIAL_CONVERSION_SIGNAL =
    /(?:then|after (?:that|your trial|the trial)|once (?:the |your )?trial (?:ends?|is over)|renews? at|billed at|you'?ll be charged|will be charged|automatically (?:renews?|converts?) (?:to|into) (?:the )?(?:paid|premium|full))\s*[:\-]?\s*(?:[$€£₹]\s?\d+(?:[.,]\d{1,2})?)?/i;

  function monitorIsGenuineFreeTrial(text, { duration, paymentRequired, automaticRenewal, priceAfterTrial } = {}) {
    const keywordHit = detectPositive(
      text,
      /free trial|trial period|try (?:it |this )?free|start(?:ing)? your trial|\d+[\s-]*(?:day|week|month)s?[\s-]*trial|trial ends?\b/i
    );
    if (!keywordHit) return false;
    const corroborated =
      paymentRequired === true ||
      automaticRenewal === true ||
      Boolean(duration) ||
      Boolean(priceAfterTrial) ||
      MONITOR_TRIAL_CONVERSION_SIGNAL.test(text);
    const explicitlyFreeForever = detectPositive(text, MONITOR_FREE_FOREVER_PATTERN);
    if (explicitlyFreeForever && !corroborated) return false;
    return corroborated;
  }

  const CANCELLATION_STEPS = [
    {
      label: "Subscription",
      patterns: [/\byour subscription\b/i, /\byour membership\b/i, /\bsubscription overview\b/i]
    },
    {
      label: "Manage Plan",
      patterns: [/\bmanage plan\b/i, /\bmanage subscription\b/i, /\bsubscription settings\b/i, /\bbilling settings\b/i]
    },
    {
      label: "Cancel Subscription",
      patterns: [/\bcancel subscription\b/i, /\bcancel plan\b/i, /\bend membership\b/i, /\bturn off (?:auto-?)?renewal\b/i, /\bdisable auto-?renewal\b/i, /\bcancel my account\b/i]
    },
    {
      label: "Cancellation Reason",
      patterns: [/\bcancellation reason\b/i, /\bwhy are you (?:leaving|canceling|cancelling)\b/i, /\btell us why\b/i, /\breason for (?:canceling|cancelling)\b/i]
    },
    {
      label: "Confirm Cancellation",
      patterns: [/\bconfirm cancellation\b/i, /\bcancellation confirmed\b/i, /\bsubscription (?:has been |is )?cancel(?:l)?ed\b/i, /\byour plan (?:has been |was )?cancel(?:l)?ed\b/i]
    }
  ];

  // A cancellation attempt is considered stale (and archived) if this much
  // time passes without a new cancellation-flow signal on the same site.
  const CANCELLATION_ATTEMPT_TIMEOUT_MS = 10 * 60 * 1000;
  const MAX_TIMELINE_EVENTS = 60;
  const MAX_CANCELLATION_HISTORY = 10;

  // --- Plan status (free vs. paid) detection --------------------------------
  // Purpose: once a user has upgraded off a free/trial plan, trial/renewal/
  // cancellation warnings are no longer relevant to them. These patterns look
  // for language that describes the ACCOUNT'S CURRENT plan (not marketing
  // copy), so "upgrade to Pro" alone doesn't flip status - it has to read
  // like a statement of the account's present state.
  const PLAN_NAME = "(?:pro|premium|paid|plus|business|team|starter\\+|gold)";
  const PLAN_STATUS_PATTERNS = {
    paid: [
      new RegExp(`you'?re (?:currently )?on (?:the |a )?${PLAN_NAME}\\s*plan`, "i"),
      new RegExp(`current plan:?\\s*${PLAN_NAME}\\b`, "i"),
      new RegExp(`your (?:current )?plan:?\\s*${PLAN_NAME}\\b`, "i"),
      /thanks for (?:subscribing|upgrading)\b/i,
      /you'?ve (?:successfully )?upgraded\b/i,
      /your subscription is active\b/i,
      new RegExp(`manage your ${PLAN_NAME} subscription`, "i"),
      new RegExp(`downgrade to (?:the )?free plan`, "i")
    ],
    free: [
      /you'?re (?:currently )?on the free plan\b/i,
      /current plan:?\s*free\b/i,
      /your (?:current )?plan:?\s*free\b/i,
      /you are on a free (?:plan|account)\b/i,
      /you'?re not (?:currently )?subscribed\b/i
    ]
  };

  // Returns { status: 'paid' | 'free' | null, label: string | null }.
  // Checked in this order because an explicit "current plan" statement is a
  // stronger, less ambiguous signal than generic upsell copy.
  function detectPlanStatus(text) {
    for (const pattern of PLAN_STATUS_PATTERNS.paid) {
      const match = text.match(pattern);
      if (match) return { status: "paid", label: match[0].trim().slice(0, 120) };
    }
    for (const pattern of PLAN_STATUS_PATTERNS.free) {
      const match = text.match(pattern);
      if (match) return { status: "free", label: match[0].trim().slice(0, 120) };
    }
    return { status: null, label: null };
  }

  // Serializes read-modify-write access to the per-site session record so
  // concurrent scans (e.g. a fast scan followed by a debounced one) can't
  // clobber each other.
  let sessionWriteQueue = Promise.resolve();

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
    return redactSensitiveText(String(str || "").trim().replace(/\s+/g, " ")).slice(0, MAX_ITEM_LENGTH);
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
  // `bodyText` is passed in so it's only computed once per scan.
  function collectRelevantText(bodyText) {
    const items = [];

    document.querySelectorAll("h1, h2, h3").forEach((el) => {
      if (items.length >= MAX_RELEVANT_ITEMS) return;
      if (isVisible(el) && el.innerText?.trim()) dedupePush(items, el.innerText);
    });

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
    return !!document.querySelector([
      'input[autocomplete="cc-number"]',
      'input[autocomplete="cc-exp"]',
      'input[autocomplete="cc-csc"]',
      'input[name*="card" i]',
      'input[id*="card" i]',
      'input[name*="billing" i]',
      'input[id*="billing" i]'
    ].join(','));
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

  // =========================================================================
  // Phase 2 — Trial, Payment & Cancellation Intelligence
  //
  // Everything below reads ONLY visible label/heading/button/sentence text
  // (never form field .value) and folds what it finds into a per-hostname
  // "subscription journey" record in chrome.storage.local. Nothing here
  // makes a network request or touches credential fields.
  // =========================================================================

  function firstMatch(text, patterns, fallback = null) {
    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match) return (match[1] || match[0]).trim();
    }
    return fallback;
  }

  // --- Trial detection -----------------------------------------------------
  function analyzeTrial(text) {
    const duration = firstMatch(text, [
      /(?:free\s+)?trial(?:\s+period)?(?:\s+(?:for|of|lasts?))?\s+(\d+\s*(?:day|week|month)s?)/i,
      /(\d+\s*(?:day|week|month)s?)\s+(?:free\s+)?trial/i
    ]);

    const priceAfterTrial = firstMatch(text, [
      /(?:then|after (?:that|your trial|the trial)|renews at|billed at|you'?ll be charged)\s*[:\-]?\s*((?:[$€£₹]\s?\d+(?:[.,]\d{1,2})?)(?:\s*\/\s*(?:mo|month|yr|year|wk|week))?)/i,
      /((?:[$€£₹]\s?\d+(?:[.,]\d{1,2})?)\s*\/\s*(?:mo|month|yr|year|wk|week))/i
    ]);

    const currency = priceAfterTrial?.match(CURRENCY_SYMBOL_PATTERN)?.[0] || null;

    const billingFrequency = firstMatch(text, [
      /\/\s*(month|mo|year|yr|week|wk)\b/i,
      /\b(monthly|annually|yearly|weekly)\b/i
    ], null)?.toLowerCase().replace(/^mo$/, "month").replace(/^yr$/, "year").replace(/^wk$/, "week") || null;

    const paymentRequired = /(?:credit|debit) card required|payment method required|valid payment method/i.test(text)
      ? true
      : /no (?:credit )?card required/i.test(text)
        ? false
        : null;

    const automaticRenewal = /automatically renew|auto-?renew|charged (?:automatically|after (?:the )?trial)|unless you cancel/i.test(text)
      ? true
      : /does not automatically renew|no auto-?renewal/i.test(text)
        ? false
        : null;

    const detected = monitorIsGenuineFreeTrial(text, { duration, paymentRequired, automaticRenewal, priceAfterTrial });

    return { detected, duration, priceAfterTrial, currency, billingFrequency, paymentRequired, automaticRenewal };
  }

  // --- Payment page detection ----------------------------------------------
  function analyzePayment(text, pageType, paymentFormPresent, paymentMeta = {}) {
    const contextualHit = /payment method|credit card|debit card|billing address|card details|\bsubscribe\b|checkout|\bpay\b|billing/i.test(text);
    const pageDetected = pageType === "payment" || pageType === "checkout" || paymentFormPresent || contextualHit;
    const methodRequired = paymentFormPresent
      ? true
      : /payment method required|valid payment method|card required/i.test(text)
        ? true
        : /no (?:credit )?card required/i.test(text)
          ? false
          : null;

    const subscriptionPrice = firstMatch(text, [
      /(?:subscription|plan|membership|renews?|billed|charged)[^\n.]{0,120}?((?:[$€£₹]\s?\d+(?:[.,]\d{1,2})?)(?:\s*\/\s*(?:mo|month|yr|year|wk|week))?)/i,
      /((?:[$€£₹]\s?\d+(?:[.,]\d{1,2})?)\s*\/\s*(?:mo|month|yr|year|wk|week))/i
    ]);

    const billingFrequency = firstMatch(text, [
      /\/\s*(month|mo|year|yr|week|wk)\b/i,
      /\b(monthly|annually|yearly|weekly)\b/i
    ], null)?.toLowerCase().replace(/^mo$/, "month").replace(/^yr$/, "year").replace(/^wk$/, "week") || null;

    const billingAddress = paymentMeta.billingAddress ?? /\bbilling (?:address|details|information)\b/i.test(text);
    const cardAvailable = paymentMeta.cardAvailable ?? /\b(?:credit|debit) card\b|\bcard details\b/i.test(text);

    return { pageDetected, methodRequired, cardAvailable, billingAddress, subscriptionPrice, billingFrequency };
  }

  // --- Renewal detection -----------------------------------------------------
  function analyzeRenewal(trialInfo) {
    return { automatic: trialInfo.automaticRenewal, price: trialInfo.priceAfterTrial };
  }

  // --- Cancellation step detection ------------------------------------------
  // Returns the ordered list of canonical step labels found on THIS page
  // (a single page, e.g. a confirmation dialog, may match more than one).
  function detectCancellationStepsOnPage(text) {
    const found = [];
    for (const step of CANCELLATION_STEPS) {
      if (step.patterns.some((pattern) => pattern.test(text))) found.push(step.label);
    }
    return found;
  }

  function redactSensitiveText(text) {
    return String(text || "")
      // Card-number-like runs.
      .replace(/\b(?:\d[ -]?){12,19}\d\b/g, "[redacted]")
      // Common authentication-code forms.
      .replace(/\b(otp|one[- ]time code|verification code|authentication code)\s*[:#-]?\s*\d{4,8}\b/gi, (_match, label) => `${label} [redacted]`)
      // Never persist password/PIN/CVV/CVC values even if a site echoes them in visible text.
      .replace(/\b(pin|passcode|password|cvv|cvc)\s*[:#-]?[^.!?\n]{0,120}/gi, (_match, label) => `${label} [redacted]`)
      .replace(/\b(?:secret|private key|access token|session token)\s*[:#-]?[^.!?\n]{0,120}/gi, (_match, label) => `${label} [redacted]`);
  }

  function redactedVisibleText(text, max = 6000) {
    return redactSensitiveText(text).slice(0, max);
  }

  function visibleElements(selector, limit = 60) {
    return Array.from(document.querySelectorAll(selector))
      .filter(isVisible)
      .slice(0, limit);
  }

  function collectWebsitePageMetadata(bodyText) {
    const headings = visibleElements("h1, h2, h3", 30)
      .map((el) => clip(el.innerText || ""))
      .filter(Boolean);

    const buttons = visibleElements("button, input[type=submit], [role=button]", 50)
      .map((el) => clip(el.innerText || el.getAttribute("aria-label") || el.getAttribute("title") || el.value || ""))
      .filter(Boolean);

    const links = visibleElements("a[href]", 80)
      .map((el) => {
        const href = el.getAttribute("href");
        const label = el.innerText || el.getAttribute("aria-label") || el.getAttribute("title") || "";
        if (!href || /^(mailto:|tel:|javascript:|data:|blob:)/i.test(href)) return null;
        try {
          const resolved = new URL(href, location.href);
          return { label: clip(label), url: resolved.toString().slice(0, 1000) };
        } catch {
          return null;
        }
      })
      .filter(Boolean);

    const labels = visibleElements("label, [aria-label]", 50)
      .map((el) => clip(el.innerText || el.getAttribute("aria-label") || ""))
      .filter(Boolean);

    const formLabels = [];
    const paymentInputs = { card: false, billingAddress: false };
    visibleElements("form", 25).forEach((form) => {
      Array.from(form.querySelectorAll("label, legend, [aria-label]"))
        .filter(isVisible)
        .slice(0, 40)
        .forEach((el) => {
          const label = clip(el.innerText || el.getAttribute("aria-label") || "");
          if (label && !formLabels.includes(label) && formLabels.length < 80) formLabels.push(label);
        });

      // Read only non-secret field metadata, never .value.
      Array.from(form.querySelectorAll("input, select, textarea")).forEach((input) => {
        const type = String(input.getAttribute("type") || "").toLowerCase();
        const autocomplete = String(input.getAttribute("autocomplete") || "").toLowerCase();
        const name = String(input.getAttribute("name") || "").toLowerCase();
        const id = String(input.getAttribute("id") || "").toLowerCase();
        if (autocomplete === "cc-number" || type === "card" || /card.?number|credit.?card|debit.?card/.test(name + " " + id)) {
          paymentInputs.card = true;
        }
        if (/street|address|postal|zip|city|state|country/.test(autocomplete) || /billing.?address|address.?1|postal|zip/.test(name + " " + id)) {
          paymentInputs.billingAddress = true;
        }
      });
    });

    return {
      headings: [...new Set(headings)].slice(0, 30),
      buttons: [...new Set(buttons)].slice(0, 50),
      links: links.slice(0, 80),
      labels: [...new Set(labels)].slice(0, 50),
      formLabels: [...new Set(formLabels)].slice(0, 80),
      paymentInputs,
      visibleText: redactedVisibleText(relevantText.join("\n"), 6000)
    };
  }

  function detectAccessState(text) {
    const passwordField = !!document.querySelector('input[type="password"]');
    const loginLanguage = /\b(?:sign in|log in|login|member login|account login)\b/i.test(text);
    const blockedLanguage = /access denied|forbidden|request blocked|verify you are human|enable javascript to continue|checking your browser/i.test(text);

    if (blockedLanguage) {
      return { status: "blocked_or_protected", requiresManualVisit: true };
    }
    if (passwordField && loginLanguage) {
      return { status: "login_required", requiresManualVisit: true };
    }
    return { status: "accessible", requiresManualVisit: false };
  }

  function analyzeWebsitePage() {
    const bodyText = document.body?.innerText || "";
    const metadata = collectWebsitePageMetadata(bodyText);
    const relevantText = collectRelevantText(bodyText);
    const pageType = classifyPageType(relevantText);
    const access = detectAccessState(bodyText);
    const trialInfo = analyzeTrial([document.title || "", location.href, bodyText, ...relevantText].join(" "));
    const paymentFormPresent = hasPaymentForm();
    const paymentInfo = analyzePayment(
      [document.title || "", location.href, bodyText, ...metadata.labels, ...metadata.formLabels].join(" "),
      pageType,
      paymentFormPresent,
      {
        cardAvailable: metadata.paymentInputs.card || /\b(?:credit|debit) card\b|\bcard details\b/i.test(bodyText),
        billingAddress: metadata.paymentInputs.billingAddress || /\bbilling (?:address|details|information)\b/i.test(bodyText)
      }
    );
    const renewalInfo = analyzeRenewal(trialInfo);
    const cancellationSteps = detectCancellationStepsOnPage(bodyText + " " + metadata.buttons.join(" ") + " " + metadata.labels.join(" "));
    const meaningfulTextLength = bodyText.replace(/\s+/g, " ").trim().length;
    const requiresManualVisit = access.requiresManualVisit || meaningfulTextLength < 40;

    return {
      schemaVersion: "3.0",
      url: location.href,
      normalizedUrl: (() => { try { const u = new URL(location.href); u.hash = ""; return u.toString(); } catch { return location.href; } })(),
      title: document.title || null,
      pageType,
      access: { ...access, requiresManualVisit },
      metadata,
      findings: {
        trial: {
          detected: trialInfo.detected,
          duration: trialInfo.duration,
          start: firstMatch(bodyText, [/trial (?:starts?|begins?)\s+(today|immediately|on[^.\n]{1,60})/i, /(starts? (?:today|immediately|when you (?:sign up|subscribe)))/i], trialInfo.duration ? "When signup is completed" : null),
          priceAfterTrial: trialInfo.priceAfterTrial,
          paymentRequired: trialInfo.paymentRequired
        },
        payment: {
          pageDetected: paymentInfo.pageDetected,
          required: paymentInfo.methodRequired,
          cardAvailable: paymentInfo.cardAvailable,
          billingAddress: paymentInfo.billingAddress,
          subscriptionPrice: paymentInfo.subscriptionPrice,
          billingFrequency: paymentInfo.billingFrequency
        },
        renewal: {
          automatic: renewalInfo.automatic,
          price: renewalInfo.price
        },
        cancellation: {
          detected: cancellationSteps.length > 0,
          steps: cancellationSteps
        },
        subscription: {
          detected: /subscription|membership|manage plan|manage subscription/i.test([document.title || "", location.href, bodyText].join(" ")),
          price: paymentInfo.subscriptionPrice || trialInfo.priceAfterTrial,
          billingFrequency: paymentInfo.billingFrequency || trialInfo.billingFrequency
        }
      },
      cancellation: {
        found: cancellationSteps.length > 0,
        steps: cancellationSteps
      },
      requiresManualVisit,
      analyzedAt: new Date().toISOString()
    };
  }

  function hostnameKey() {
    return location.hostname.replace(/^www\./, "") || "unknown-site";
  }

  // Bump this whenever detection logic changes in a way that could flip a
  // previously-stored true/false verdict (e.g. the negation-awareness fix
  // below). Sessions persist in chrome.storage.local and use "sticky"
  // semantics (see mergeJourney), so a session built under an older,
  // buggier detector would otherwise keep a stale "Free trial detected"
  // forever, even after the code is fixed and even after the current page
  // is re-scanned, because sticky merging never un-sets a true value.
  const DETECTOR_VERSION = 2;

  function emptySession() {
    return {
      detectorVersion: DETECTOR_VERSION,
      currentSite: {},
      trial: { detected: false, duration: null, priceAfterTrial: null, currency: null, billingFrequency: null, paymentRequired: null, automaticRenewal: null },
      payment: { pageDetected: false, methodRequired: null, cardAvailable: null, billingAddress: null, subscriptionPrice: null, billingFrequency: null },
      renewal: { automatic: null, price: null },
      // Current account plan, as opposed to the trial/renewal terms above.
      // null = not yet determined; "free" or "paid" once a confident
      // "current plan" statement has been seen on some page of the site.
      plan: { status: null, label: null, lastConfirmedAt: null },
      cancellation: { stepsObserved: 0, currentSteps: [], history: [], changed: false, lastChange: null, attemptStartedAt: null, lastSignalAt: null },
      timeline: [],
      loggedEvents: [], // internal: event keys already recorded, prevents duplicate timeline spam
      lastUpdated: 0
    };
  }

  function pushTimelineEvent(session, key, label) {
    if (session.loggedEvents.includes(key)) return;
    session.loggedEvents.push(key);
    session.timeline.push({ time: new Date().toLocaleTimeString(), label, at: Date.now() });
    if (session.timeline.length > MAX_TIMELINE_EVENTS) session.timeline.shift();
  }

  // Merges the current page's findings into the running session using
  // "sticky" semantics: once something true/non-null is observed, it is
  // kept even if a later page in the same flow doesn't repeat it, because
  // the journey (landing -> pricing -> trial -> payment -> confirmation)
  // spans multiple page loads.
  function mergeJourney(session, snapshot, text) {
    session.currentSite = {
      url: snapshot.url,
      hostname: hostnameKey(),
      pageType: snapshot.pageType,
      title: snapshot.title
    };

    // Trial
    const trialInfo = analyzeTrial(text);
    if (trialInfo.detected) session.trial.detected = true;
    session.trial.duration = trialInfo.duration || session.trial.duration;
    session.trial.priceAfterTrial = trialInfo.priceAfterTrial || session.trial.priceAfterTrial;
    session.trial.currency = trialInfo.currency || session.trial.currency;
    session.trial.billingFrequency = trialInfo.billingFrequency || session.trial.billingFrequency;
    if (trialInfo.paymentRequired !== null) session.trial.paymentRequired = trialInfo.paymentRequired;
    if (trialInfo.automaticRenewal !== null) session.trial.automaticRenewal = trialInfo.automaticRenewal;

    // Payment
    const paymentFormPresent = hasPaymentForm();
    const paymentInfo = analyzePayment(text, snapshot.pageType, paymentFormPresent, {
      cardAvailable: /\b(?:credit|debit) card\b|\bcard details\b/i.test(text),
      billingAddress: /\bbilling (?:address|details|information)\b/i.test(text)
    });
    if (paymentInfo.pageDetected) session.payment.pageDetected = true;
    if (paymentInfo.methodRequired !== null) session.payment.methodRequired = paymentInfo.methodRequired;
    if (paymentInfo.cardAvailable) session.payment.cardAvailable = true;
    if (paymentInfo.billingAddress) session.payment.billingAddress = true;
    session.payment.subscriptionPrice = paymentInfo.subscriptionPrice || session.payment.subscriptionPrice;
    session.payment.billingFrequency = paymentInfo.billingFrequency || session.payment.billingFrequency;

    // Renewal (derived from trial info, kept as its own top-level field per spec)
    const renewalInfo = analyzeRenewal(session.trial);
    session.renewal.automatic = renewalInfo.automatic;
    session.renewal.price = renewalInfo.price;

    // Plan status (free vs. paid). Unlike trial/payment/renewal fields above,
    // this is NOT sticky-true-forever: it reflects the most recent confident
    // reading, because a user can legitimately move from free -> paid, and
    // (less commonly) paid -> free after cancelling. A page with no plan
    // language leaves the previous known status untouched.
    const planInfo = detectPlanStatus(text);
    if (planInfo.status && planInfo.status !== session.plan.status) {
      const previousStatus = session.plan.status;
      session.plan.status = planInfo.status;
      session.plan.label = planInfo.label;
      session.plan.lastConfirmedAt = Date.now();
      if (previousStatus === "free" && planInfo.status === "paid") {
        pushTimelineEvent(session, `plan_upgraded:${Date.now()}`, "Upgraded to a paid plan");
      } else if (previousStatus === "paid" && planInfo.status === "free") {
        pushTimelineEvent(session, `plan_downgraded:${Date.now()}`, "Moved back to the free plan");
      } else if (!previousStatus) {
        pushTimelineEvent(session, `plan_detected:${planInfo.status}`, `Current plan detected: ${planInfo.status}`);
      }
    } else if (planInfo.status === session.plan.status && planInfo.label) {
      session.plan.lastConfirmedAt = Date.now();
    }

    // Cancellation flow tracking
    const stepsOnPage = detectCancellationStepsOnPage(text);
    if (stepsOnPage.length) {
      const now = Date.now();
      const gapExceeded = session.cancellation.lastSignalAt && (now - session.cancellation.lastSignalAt > CANCELLATION_ATTEMPT_TIMEOUT_MS);
      if (gapExceeded) {
        // Previous attempt went stale; archive it before starting a new one.
        archiveCancellationAttempt(session);
      }
      if (!session.cancellation.attemptStartedAt) session.cancellation.attemptStartedAt = now;
      session.cancellation.lastSignalAt = now;

      for (const label of stepsOnPage) {
        if (!session.cancellation.currentSteps.includes(label)) {
          session.cancellation.currentSteps.push(label);
          pushTimelineEvent(session, `cancel_step:${label}`, `Cancellation step observed: ${label}`);
        }
      }
      session.cancellation.stepsObserved = session.cancellation.currentSteps.length;

      // Reaching the final step completes this attempt right away.
      if (stepsOnPage.includes("Confirm Cancellation")) {
        archiveCancellationAttempt(session);
      }
    }

    // Meaningful, deduplicated timeline events (page-type based).
    if (trialInfo.detected) pushTimelineEvent(session, "trial_detected", "Trial detected");
    if (snapshot.pageType === "pricing") pushTimelineEvent(session, "pricing_detected", "Pricing detected");
    if (snapshot.pageType === "signup") pushTimelineEvent(session, "signup_detected", "Signup detected");
    if (paymentInfo.pageDetected) pushTimelineEvent(session, "payment_page_detected", "Payment page detected");
    if (session.payment.methodRequired === true) pushTimelineEvent(session, "payment_required", "Payment required");
    if (session.renewal.automatic === true) pushTimelineEvent(session, "auto_renewal_detected", "Auto-renewal detected");
    if (snapshot.pageType === "confirmation") pushTimelineEvent(session, "confirmation_detected", "Confirmation detected");

    session.lastUpdated = Date.now();
    return session;
  }

  // Closes out the in-progress cancellation attempt: records it in history,
  // compares its length to the previous attempt on this site, and flags a
  // neutral "process changed" note if the step count differs. This never
  // asserts intent (e.g. "made harder on purpose") - just reports the fact.
  function archiveCancellationAttempt(session) {
    const steps = session.cancellation.currentSteps;
    if (!steps.length) return;

    const previous = session.cancellation.history[session.cancellation.history.length - 1] || null;
    const completed = { steps: [...steps], count: steps.length, at: Date.now() };
    session.cancellation.history.push(completed);
    if (session.cancellation.history.length > MAX_CANCELLATION_HISTORY) session.cancellation.history.shift();

    if (previous && previous.count !== completed.count) {
      session.cancellation.changed = true;
      session.cancellation.lastChange = { previousSteps: previous.count, currentSteps: completed.count };
      pushTimelineEvent(
        session,
        `cancel_changed:${previous.count}->${completed.count}:${Date.now()}`,
        `Cancellation process changed (previous: ${previous.count} steps, current: ${completed.count} steps)`
      );
    }

    session.cancellation.currentSteps = [];
    session.cancellation.attemptStartedAt = null;
    session.cancellation.lastSignalAt = null;
  }

  // Reads-modifies-writes the per-hostname session record. Calls are
  // serialized through sessionWriteQueue so overlapping scans can't race.
  function queueSessionUpdate(snapshot, bodyText) {
    sessionWriteQueue = sessionWriteQueue.then(async () => {
      const key = `trialshield_state:${hostnameKey()}`;
      try {
        const stored = await chrome.storage.local.get(key);
        const staleDetector = stored[key] && stored[key].detectorVersion !== DETECTOR_VERSION;
        const base = (stored[key] && !staleDetector) ? stored[key] : emptySession();
        const session = { ...emptySession(), ...base };
        // Deep-merge nested objects that were spread shallowly above.
        session.trial = { ...emptySession().trial, ...(base.trial || {}) };
        session.payment = { ...emptySession().payment, ...(base.payment || {}) };
        session.renewal = { ...emptySession().renewal, ...(base.renewal || {}) };
        session.plan = { ...emptySession().plan, ...(base.plan || {}) };
        session.cancellation = { ...emptySession().cancellation, ...(base.cancellation || {}) };
        session.timeline = base.timeline || [];
        session.loggedEvents = base.loggedEvents || [];
        session.detectorVersion = DETECTOR_VERSION;

        const updated = mergeJourney(session, snapshot, bodyText);
        await chrome.storage.local.set({ [key]: updated });

        chrome.runtime.sendMessage({ type: "TRIALSHIELD_JOURNEY_UPDATED", hostname: hostnameKey(), data: updated }).catch(() => {});
      } catch (error) {
        // Storage can fail (quota, context invalidated on extension reload,
        // etc.) - never let it throw and break the page's monitoring loop.
        console.warn("TrialShield: session update failed", error);
      }
    });
  }

  function buildSnapshot(bodyText) {
    const relevantText = collectRelevantText(bodyText);
    return {
      url: location.href,
      title: document.title || null,
      pageType: classifyPageType(relevantText),
      relevantText,
      timestamp: Date.now()
    };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "TRIALSHIELD_ANALYZE_WEBSITE_PAGE") return;
    try {
      sendResponse({ ok: true, analysis: analyzeWebsitePage() });
    } catch (error) {
      sendResponse({ ok: false, error: error instanceof Error ? error.message : "Website analysis unavailable" });
    }
  });

  function scanAndMaybeUpdate() {
    const now = Date.now();
    if (now - lastScanTime < MIN_SCAN_INTERVAL_MS) return;

    const bodyText = (document.body?.innerText || "").slice(0, MAX_BODY_TEXT_LENGTH);
    const snapshot = buildSnapshot(bodyText);
    const hash = hashString(snapshot.pageType + "|" + snapshot.relevantText.join("|"));
    const urlChanged = snapshot.url !== lastUrl;

    if (!urlChanged && hash === lastSnapshotHash) return; // no meaningful change

    lastScanTime = now;
    lastUrl = snapshot.url;
    lastSnapshotHash = hash;

    // Keyed by hostname (not URL) and overwritten each scan, so this never
    // accumulates one entry per page visited on an SPA (Phase 3 hardening).
    chrome.storage.local.set({ [`trialshield_monitor:${hostnameKey()}`]: snapshot });

    // Best-effort notification for the popup/background (Phase 3 wiring).
    // No listener is guaranteed to exist yet, so failures are ignored.
    chrome.runtime.sendMessage({ type: "TRIALSHIELD_PAGE_UPDATED", data: snapshot }).catch(() => {});

    // Phase 2: fold this scan into the site's running subscription-journey
    // state (trial / payment / renewal / cancellation / timeline).
    queueSessionUpdate(snapshot, bodyText);
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

  // One-time cleanup of legacy per-URL monitor snapshots from before this
  // key was switched to per-hostname (Phase 3 hardening: prevents unbounded
  // chrome.storage.local growth on sites visited across many sessions).
  function pruneLegacyMonitorKeys() {
    chrome.storage.local.get(null, (all) => {
      if (chrome.runtime.lastError) return;
      const legacy = Object.keys(all || {}).filter(
        (key) => key.startsWith("trialshield_monitor:") && /^trialshield_monitor:https?:\/\//.test(key)
      );
      if (legacy.length) chrome.storage.local.remove(legacy);
    });
  }

  function init() {
    pruneLegacyMonitorKeys();
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