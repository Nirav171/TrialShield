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
