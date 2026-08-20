(() => {
  if (window.__trialShieldContentLoaded) return;
  window.__trialShieldContentLoaded = true;

  const MAX_TEXT_LENGTH = 220000;
  const MAX_EVIDENCE = 10;
  const MAX_ACTIONS = 8;

  const TRIAL_KEYWORDS =
    /free trial|trial period|try (?:it |this )?free|start(?:ing)? your trial|trial ends?|auto-?renew|payment method|credit card|debit card|billing|subscription|membership|cancel/i;

  const CONFIRMATION_PATTERN =
    /cancel(?:led|ed|lation confirmed)|subscription (?:has been |is )?cancel(?:led|ed)|plan (?:has been |is )?cancel(?:led|ed)|you will not be charged|auto[- ]?renewal (?:is )?off|renewal (?:has been )?(?:turned off|disabled)/i;

  const CANCEL_ACTION_PATTERN =
    /cancel subscription|cancel plan|cancel trial|cancel membership|end membership|turn off renewal|disable auto-?renewal|stop renewal|manage subscription|manage plan|subscription settings|billing settings|confirm cancellation|yes, cancel|continue to cancel|confirm cancel/i;

  const AVOID_CLICK_PATTERN =
    /keep|never mind|go back|not now|close|dismiss|upgrade|subscribe now|start trial|begin trial|checkout|pay now|place order/i;

  function cleanText(value) {
    return String(value || "")
      .replace(/\u00a0/g, " ")
      .replace(/\b(?:\d[ -]?){12,19}\d\b/g, "[redacted]")
      .replace(/\s+/g, " ")
      .trim();
  }

  function pageText() {
    return cleanText(document.body?.innerText || "").slice(0, MAX_TEXT_LENGTH);
  }

  function textHash(value) {
    let hash = 5381;
    for (let i = 0; i < value.length; i++) {
      hash = ((hash << 5) + hash + value.charCodeAt(i)) | 0;
    }
    return String(hash);
  }

  function sentences(text) {
    return text
      .split(/(?<=[.!?])\s+|\n+/)
      .map(cleanText)
      .filter(Boolean);
  }

  function firstMatch(text, patterns, fallback = null) {
    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match) return cleanText(match[1] || match[0]);
    }
    return fallback;
  }

  function evidenceFromText(text, limit = MAX_EVIDENCE) {
    const found = sentences(text)
      .filter((sentence) => TRIAL_KEYWORDS.test(sentence))
      .map((sentence) => sentence.slice(0, 280));

    return [...new Set(found)].slice(0, limit);
  }

  function amountNearTrial(text) {
    return firstMatch(text, [
      /(?:after (?:the )?trial|then|renews? at|you'?ll be charged|billed at)[^\d$€£₹]{0,50}((?:[$€£₹]|Rs\.?|INR)\s*\d[\d,]*(?:[.,]\d{1,2})?(?:\s*(?:\/|per)\s*(?:month|year|week|mo|yr|wk))?)/i,
      /((?:[$€£₹]|Rs\.?|INR)\s*\d[\d,]*(?:[.,]\d{1,2})?\s*(?:\/|per)\s*(?:month|year|week|mo|yr|wk))/i
    ]);
  }

  function startingFee(text) {
    return firstMatch(text, [
      /(no (?:upfront|initial|starting)?\s*(?:fee|charge))/i,
      /(?:today|to start|starting at|starts at)[^\d$€£₹]{0,30}((?:[$€£₹]|Rs\.?|INR)\s*\d[\d,]*(?:[.,]\d{1,2})?)/i,
      /((?:[$€£₹]|Rs\.?|INR)\s*0(?:[.,]00)?\s*(?:today|to start)?)/i
    ]);
  }

  function currencyCode(raw) {
    const text = raw || "";
    if (/₹|Rs\.?|INR/i.test(text)) return "INR";
    if (/€/.test(text)) return "EUR";
    if (/£/.test(text)) return "GBP";
    if (/\$/.test(text)) return "USD";
    return "USD";
  }

  function billingFrequency(text) {
    const match = text.match(/(?:\/|per\s+)(month|year|week|mo|yr|wk)|\b(monthly|yearly|annually|weekly)\b/i);
    if (!match) return "unknown";

    const value = cleanText(match[1] || match[2]).toLowerCase();
    return {
      mo: "monthly",
      month: "monthly",
      monthly: "monthly",
      yr: "yearly",
      year: "yearly",
      yearly: "yearly",
      annually: "yearly",
      wk: "weekly",
      week: "weekly",
      weekly: "weekly"
    }[value] || value;
  }

  function providerName() {
    return (
      document.querySelector('meta[property="og:site_name"]')?.content ||
      document.querySelector("h1")?.innerText ||
      location.hostname.replace(/^www\./, "")
    ).trim().slice(0, 255);
  }

  function analyzeTrialPage() {
    const text = pageText();
    const recurring = amountNearTrial(text);
    const fee = startingFee(text);

    const cancellation = firstMatch(text, [
      /((?:cancel|cancellation|turn off renewal|disable auto-?renewal)[^.]{0,220}(?:\.|$))/i,
      /((?:cancel anytime|no cancellation fee|contact support to cancel)[^.]{0,180}(?:\.|$))/i
    ]);

    const duration = firstMatch(text, [
      /(?:free\s+)?trial(?:\s+period)?(?:\s+(?:for|of|lasts?))?\s+(\d+\s*(?:day|week|month)s?)/i,
      /(\d+\s*(?:day|week|month)s?)\s+(?:free\s+)?trial/i
    ]);

    const paymentRequired = /(?:credit|debit) card required|payment method required|valid payment method|enter your card/i.test(text)
      ? true
      : /no (?:credit |debit )?card required|no payment method required/i.test(text)
        ? false
        : null;

    const autoRenews = /automatically renew|auto-?renew|charged (?:automatically|after (?:the )?trial)|unless you cancel/i.test(text)
      ? true
      : /does not automatically renew|no auto-?renewal|will not automatically renew/i.test(text)
        ? false
        : null;

    return {
      schema_version: "2.1",
      source_url: location.href,
      provider_name: providerName(),
      page_title: document.title || null,
      has_free_trial: /free trial|trial period|try (?:it |this )?free|\d+\s*(?:day|week|month)s?\s+trial/i.test(text),
      trial_start: duration ? "When signup is completed" : null,
      trial_duration: duration,
      cancellation_terms: cancellation,
      minimum_fee: fee,
      recurring_charge: recurring,
      payment_method_required: paymentRequired,
      auto_renews: autoRenews,
      currency: currencyCode(recurring || fee || ""),
      evidence: evidenceFromText(text),
      analyzed_at: new Date().toISOString()
    };
  }

  function buildProtectionPayload(riskScore) {
    const trial = analyzeTrialPage();

    return {
      provider_name: trial.provider_name,
      source_url: trial.source_url,
      trial_duration: trial.trial_duration,
      renewal_amount: trial.recurring_charge || trial.minimum_fee,
      currency: trial.currency || "USD",
      billing_frequency: billingFrequency(`${trial.recurring_charge || ""} ${pageText().slice(0, 1200)}`),
      risk_score: Number.isFinite(Number(riskScore)) ? Number(riskScore) : 0,
      evidence: trial.evidence
    };
  }

  function isVisible(element) {
    if (!element) return false;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      style.visibility !== "hidden" &&
      style.display !== "none" &&
      Number(style.opacity || "1") > 0.05
    );
  }

  function clickableLabel(element) {
    return cleanText(
      element.innerText ||
      element.value ||
      element.getAttribute("aria-label") ||
      element.getAttribute("title") ||
      ""
    );
  }

  function candidateClickTargets(clickCounts = {}) {
    const elements = Array.from(
      document.querySelectorAll('button, a, [role="button"], input[type="button"], input[type="submit"]')
    );

    return elements
      .filter(isVisible)
      .map((element, index) => ({ element, index, label: clickableLabel(element) }))
      .filter(({ label }) => label && CANCEL_ACTION_PATTERN.test(label))
      .filter(({ label }) => !AVOID_CLICK_PATTERN.test(label))
      .filter(({ label }) => (clickCounts[label.toLowerCase()] || 0) < 2)
      .map((candidate) => {
        const label = candidate.label.toLowerCase();
        let score = 1;

        if (/confirm cancellation|yes, cancel|confirm cancel/.test(label)) score += 70;
        if (/cancel subscription|cancel plan|cancel trial|cancel membership/.test(label)) score += 60;
        if (/turn off renewal|disable auto-?renewal|stop renewal/.test(label)) score += 55;
        if (/continue to cancel/.test(label)) score += 45;
        if (/manage subscription|manage plan|subscription settings|billing settings/.test(label)) score += 25;

        return { ...candidate, score };
      })
      .sort((a, b) => b.score - a.score || a.index - b.index);
  }

  function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function performAutomaticCancellation() {
    const attemptedActions = [];
    const evidence = [];
    const clickCounts = {};
    const seenPageHashes = new Set();
    let reason = null;

    for (let step = 0; step < MAX_ACTIONS; step++) {
      const beforeText = pageText();
      const beforeHash = textHash(beforeText);
      seenPageHashes.add(beforeHash);

      for (const item of evidenceFromText(beforeText, 6)) {
        if (!evidence.includes(item)) evidence.push(item);
      }

      if (CONFIRMATION_PATTERN.test(beforeText)) {
        return {
          source_url: location.href,
          page_title: document.title || null,
          attempted_actions: attemptedActions,
          evidence,
          confirmation_detected: true,
          final_url: location.href,
          raw_status: "confirmed",
          reason: "Cancellation confirmation language was detected."
        };
      }

      const target = candidateClickTargets(clickCounts)[0];

      if (!target) {
        reason = "No visible cancellation button or link was found on this page.";
        break;
      }

      const labelKey = target.label.toLowerCase();
      clickCounts[labelKey] = (clickCounts[labelKey] || 0) + 1;
      attemptedActions.push(target.label.slice(0, 160));

      target.element.scrollIntoView({ behavior: "smooth", block: "center" });
      await wait(250);
      target.element.click();
      await wait(1200);

      const afterText = pageText();
      const afterHash = textHash(afterText);

      if (CONFIRMATION_PATTERN.test(afterText)) {
        for (const item of evidenceFromText(afterText, 8)) {
          if (!evidence.includes(item)) evidence.push(item);
        }

        return {
          source_url: location.href,
          page_title: document.title || null,
          attempted_actions: attemptedActions,
          evidence,
          confirmation_detected: true,
          final_url: location.href,
          raw_status: "confirmed",
          reason: "Cancellation confirmation language was detected."
        };
      }

      if (seenPageHashes.has(afterHash) && candidateClickTargets(clickCounts).length === 0) {
        reason = "Cancellation controls stopped changing before confirmation was detected.";
        break;
      }
    }

    const finalText = pageText();
    for (const item of evidenceFromText(finalText, 8)) {
      if (!evidence.includes(item)) evidence.push(item);
    }

    const confirmed = CONFIRMATION_PATTERN.test(finalText);

    return {
      source_url: location.href,
      page_title: document.title || null,
      attempted_actions: attemptedActions,
      evidence,
      confirmation_detected: confirmed,
      final_url: location.href,
      raw_status: confirmed ? "confirmed" : "unresolved",
      reason: confirmed
        ? "Cancellation confirmation language was detected."
        : reason || "Cancellation flow ended without confirmation evidence."
    };
  }

  function hostnameKey() {
    return location.hostname.replace(/^www\./, "") || "unknown-site";
  }

  function classifyPageType(text) {
    const path = location.pathname.toLowerCase();
    if (/checkout|payment|billing/.test(path) || /payment method|card details|billing address/i.test(text)) return "payment";
    if (/pricing|plans/.test(path) || /choose a plan|pricing|plans/i.test(text)) return "pricing";
    if (/cancel subscription|manage subscription|subscription settings/i.test(text)) return "subscription";
    if (/free trial|trial period|start your trial/i.test(text)) return "trial";
    if (/sign up|create account|register/i.test(text)) return "signup";
    if (/confirmation|thank you|receipt/i.test(text)) return "confirmation";
    return "unknown";
  }

  async function updateMonitorState() {
    const text = pageText();
    const trial = analyzeTrialPage();
    const key = `trialshield_state:${hostnameKey()}`;
    const stored = await chrome.storage.local.get(key).catch(() => ({}));
    const previous = stored[key] || {};

    const cancellationSteps = [];
    if (/manage subscription|manage plan|subscription settings|billing settings/i.test(text)) cancellationSteps.push("Manage Subscription");
    if (/cancel subscription|cancel plan|cancel trial|end membership/i.test(text)) cancellationSteps.push("Cancel Subscription");
    if (/confirm cancellation|yes, cancel|continue to cancel/i.test(text)) cancellationSteps.push("Confirm Cancellation");
    if (CONFIRMATION_PATTERN.test(text)) cancellationSteps.push("Cancellation Confirmed");

    const state = {
      currentSite: {
        url: location.href,
        hostname: hostnameKey(),
        pageType: classifyPageType(text),
        title: document.title || null
      },
      trial: {
        detected: previous.trial?.detected || trial.has_free_trial,
        duration: trial.trial_duration || previous.trial?.duration || null,
        priceAfterTrial: trial.recurring_charge || previous.trial?.priceAfterTrial || null,
        currency: trial.currency || previous.trial?.currency || null,
        billingFrequency: billingFrequency(text),
        paymentRequired: trial.payment_method_required
      },
      payment: {
        pageDetected: /payment method|card details|billing address|checkout/i.test(text),
        methodRequired: trial.payment_method_required
      },
      renewal: {
        automatic: trial.auto_renews,
        price: trial.recurring_charge
      },
      plan: previous.plan || { status: null, label: null, lastConfirmedAt: null },
      cancellation: {
        stepsObserved: Math.max(previous.cancellation?.stepsObserved || 0, cancellationSteps.length),
        currentSteps: cancellationSteps,
        history: previous.cancellation?.history || [],
        changed: previous.cancellation?.changed || false,
        lastChange: previous.cancellation?.lastChange || null
      },
      timeline: previous.timeline || [],
      lastUpdated: Date.now()
    };

    await chrome.storage.local.set({ [key]: state });
    chrome.runtime.sendMessage({
      type: "TRIALSHIELD_JOURNEY_UPDATED",
      hostname: hostnameKey(),
      data: state
    }).catch(() => {});
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "TRIALSHIELD_ANALYZE") {
      try {
        const trial = analyzeTrialPage();
        updateMonitorState().catch(() => {});
        sendResponse({ ok: true, trial });
      } catch (error) {
        sendResponse({ ok: false, error: error instanceof Error ? error.message : "Unknown analysis error" });
      }
      return true;
    }

    if (message?.type === "TRIALSHIELD_BUILD_PROTECTION_PAYLOAD") {
      try {
        sendResponse({ ok: true, protection: buildProtectionPayload(message.riskScore) });
      } catch (error) {
        sendResponse({ ok: false, error: error instanceof Error ? error.message : "Unknown protection error" });
      }
      return true;
    }

    if (message?.type === "TRIALSHIELD_AUTOMATIC_CANCEL") {
      performAutomaticCancellation()
        .then((result) => sendResponse({ ok: true, cancellation: result }))
        .catch((error) => {
          sendResponse({
            ok: false,
            error: error instanceof Error ? error.message : "Automatic cancellation failed"
          });
        });
      return true;
    }

    return false;
  });

  let timer = null;

  function scheduleMonitorUpdate() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => updateMonitorState().catch(() => {}), 700);
  }

  if (document.body) {
    scheduleMonitorUpdate();
    new MutationObserver(scheduleMonitorUpdate).observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true
    });
  } else {
    document.addEventListener("DOMContentLoaded", scheduleMonitorUpdate, { once: true });
  }
})();