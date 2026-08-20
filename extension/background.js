const WARNING_COLOR = "#c0392b";
const NEUTRAL_COLOR = "#2f7d3d";

function computeBadge(data) {
  if (!data) return { text: "", color: NEUTRAL_COLOR };

  const onPaidPlan = data.plan?.status === "paid";

  const hasTrialWarning =
    !onPaidPlan &&
    (
      data.trial?.paymentRequired === true ||
      data.payment?.methodRequired === true ||
      data.renewal?.automatic === true
    );

  const hasCancellationChange = data.cancellation?.changed === true;

  if (hasTrialWarning || hasCancellationChange) {
    return { text: "!", color: WARNING_COLOR };
  }

  const hasPositiveSignal =
    (!onPaidPlan && data.trial?.detected) ||
    data.cancellation?.stepsObserved > 0;

  if (hasPositiveSignal) {
    return { text: "\u2713", color: NEUTRAL_COLOR };
  }

  return { text: "", color: NEUTRAL_COLOR };
}

async function setBadgeForTab(tabId, badge) {
  try {
    await chrome.action.setBadgeText({ tabId, text: badge.text });
    if (badge.text) {
      await chrome.action.setBadgeBackgroundColor({
        tabId,
        color: badge.color
      });
    }
  } catch {
    // Tab may have closed. Nothing to do.
  }
}

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type !== "TRIALSHIELD_JOURNEY_UPDATED") return;

  const tabId = sender.tab?.id;
  if (tabId == null) return;

  setBadgeForTab(tabId, computeBadge(message.data));
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") {
    chrome.action.setBadgeText({ tabId, text: "" }).catch(() => {});
  }
});