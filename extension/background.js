// TrialShield background service worker (Phase 3)
//
// Purely local wiring: content.js -> background.js -> action badge / popup.
// This file never makes a network request and never reads page content
// itself - it only receives the already-sanitized, structured journey
// summaries content.js computes (trial/payment/renewal/cancellation), and
// uses them to keep the toolbar icon badge in sync with the active tab.
//
// The popup does NOT depend on this file to render (it reads
// chrome.storage.local directly and listens to chrome.storage.onChanged),
// so a slow or restarted service worker never blocks the popup UI - this
// worker only adds the badge as a lightweight "glanceable" indicator.

const WARNING_COLOR = "#c0392b";
const NEUTRAL_COLOR = "#2f7d3d";

function computeBadge(data) {
  if (!data) return { text: "", color: NEUTRAL_COLOR };

  // Once the site confirms the account is on a paid plan, trial/renewal
  // warnings no longer apply to this user - stop badging them. This is the
  // only thing that gates a "!" warning off: cancellation-flow info is still
  // useful to a paid user, so it isn't suppressed here.
  const onPaidPlan = data.plan?.status === "paid";

  const hasWarning =
    !onPaidPlan &&
    ((data.trial?.detected && data.trial?.paymentRequired === true) ||
      data.renewal?.automatic === true ||
      data.cancellation?.changed === true);

  if (hasWarning) return { text: "!", color: WARNING_COLOR };

  const hasPositiveSignal = (!onPaidPlan && data.trial?.detected) || data.cancellation?.stepsObserved > 0;
  if (hasPositiveSignal) return { text: "\u2713", color: NEUTRAL_COLOR }; // checkmark

  return { text: "", color: NEUTRAL_COLOR };
}

async function setBadgeForTab(tabId, badge) {
  try {
    await chrome.action.setBadgeText({ tabId, text: badge.text });
    if (badge.text) await chrome.action.setBadgeBackgroundColor({ tabId, color: badge.color });
  } catch {
    // Tab can close between the message arriving and this call resolving;
    // that's fine, nothing to clean up.
  }
}

chrome.runtime.onMessage.addListener((message, sender) => {
  // Only react to the Phase 2 journey-update broadcast; ignore everything
  // else (e.g. the on-demand TRIALSHIELD_ANALYZE request/response pair,
  // which content.js/popup.js already handle directly between themselves).
  if (message?.type !== "TRIALSHIELD_JOURNEY_UPDATED") return;
  const tabId = sender.tab?.id;
  if (tabId == null) return;
  setBadgeForTab(tabId, computeBadge(message.data));
});

// Clear a stale badge the moment a tab starts navigating, so a warning from
// the previous page never lingers on screen before the next scan completes.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") {
    chrome.action.setBadgeText({ tabId, text: "" }).catch(() => {});
  }
});
