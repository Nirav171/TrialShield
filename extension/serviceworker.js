importScripts("background.js");

const FASTAPI_BASE = "http://127.0.0.1:8000";

async function postJson(path, body) {
  const response = await fetch(`${FASTAPI_BASE}${path}`, {
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
        : `FastAPI request failed with status ${response.status}`;
    throw new Error(detail);
  }

  return payload;
}

async function sendToContent(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"]
    });
    return await chrome.tabs.sendMessage(tabId, message);
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "TRIALSHIELD_PROTECT_TRIAL") {
    (async () => {
      try {
        if (!Number.isInteger(message.tabId)) {
          throw new Error("The selected website tab is missing.");
        }

        const extracted = await sendToContent(message.tabId, {
          type: "TRIALSHIELD_BUILD_PROTECTION_PAYLOAD",
          riskScore: message.riskScore
        });

        if (!extracted?.ok || !extracted.protection) {
          throw new Error(extracted?.error || "Trial details are missing.");
        }

        const result = await postJson("/protect-trial", extracted.protection);

        await chrome.storage.local.set({
          trialshield_latest_trial_id: result.trial_id,
          [`trialshield_trial_for_tab:${message.tabId}`]: result.trial_id
        });

        sendResponse({ ok: true, result });
      } catch (error) {
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : "Trial protection failed."
        });
      }
    })();

    return true;
  }

  if (message?.type === "TRIALSHIELD_AUTO_CANCEL") {
    (async () => {
      try {
        if (!Number.isInteger(message.tabId)) {
          throw new Error("The selected website tab is missing.");
        }

        const trialId = Number(message.trialId);
        if (!Number.isInteger(trialId) || trialId <= 0) {
          throw new Error("A protected trial id is required before cancellation.");
        }

        const extracted = await sendToContent(message.tabId, {
          type: "TRIALSHIELD_AUTOMATIC_CANCEL"
        });

        if (!extracted?.ok || !extracted.cancellation) {
          throw new Error(extracted?.error || "Cancellation evidence is missing.");
        }

        const result = await postJson(
          `/trials/${trialId}/cancel-attempt`,
          extracted.cancellation
        );

        sendResponse({
          ok: true,
          result,
          cancellation: extracted.cancellation
        });
      } catch (error) {
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : "Automatic cancellation failed."
        });
      }
    })();

    return true;
  }

  return false;
});