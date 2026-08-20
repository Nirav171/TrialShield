// TrialShield Manifest V3 service worker.
//
// Keep the existing navigation, analysis, storage, and badge behavior.
importScripts("background.js");

const FASTAPI_PROTECT_URL = "http://127.0.0.1:8000/protect-trial";

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "TRIALSHIELD_PROTECT_TRIAL") return;

  // Returning true keeps sendResponse alive while the FastAPI call runs.
  (async () => {
    try {
      if (!Number.isInteger(message.tabId)) {
        throw new Error("The selected website tab is missing");
      }

      // content.js reads the selected page and creates the small
      // ProtectTrialRequest object accepted by FastAPI.
      const extracted = await chrome.tabs.sendMessage(message.tabId, {
        type: "TRIALSHIELD_BUILD_PROTECTION_PAYLOAD",
        riskScore: message.riskScore
      });
      if (!extracted?.ok || !extracted.protection) {
        throw new Error(extracted?.error || "Trial details are missing");
      }

      // FastAPI validates this JSON body using ProtectTrialRequest.
      const response = await fetch(FASTAPI_PROTECT_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(extracted.protection)
      });

      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        const detail = typeof payload?.detail === "string"
          ? payload.detail
          : Array.isArray(payload?.detail)
            ? payload.detail.map((item) => item.msg).join("; ")
            : "Trial protection failed";
        throw new Error(detail);
      }

      sendResponse({ ok: true, result: payload });
    } catch (error) {
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : "Unknown protection error"
      });
    }
  })();

  return true;
});
