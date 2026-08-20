# TrialShield

## Run locally

1. Start the search service with `powershell -ExecutionPolicy Bypass -File .\backend.ps1`.
2. Open `chrome://extensions`, enable Developer mode, and choose **Load unpacked**.
3. Select this directory and reload the extension after changing its files.

The Gemini key is read only by the local PowerShell service from `.env`; it is not
packaged into the Chrome extension. Search requests use Gemini with Google
Search grounding and return five official free-trial pages.

Searches are cached for 30 minutes to reduce Gemini requests. Temporary 429 and
5xx responses use exponential backoff, with `gemini-3.5-flash-lite` as the
primary model and `gemini-2.5-flash` as a fallback.

If the separate Google Search grounding quota is exhausted, the backend falls
back to an ungrounded Gemini result instead of returning a 429. The page
analyzer should still be used to verify the provider's current trial terms.

### Port already in use

Only one backend can listen on port 8787. Stop the older terminal with
`Ctrl+C`, or use the exact `Stop-Process -Id <PID>` command printed by the new
backend. Then start `backend.ps1` again. If no PID is shown, wait a few seconds
for Windows to release the socket and retry.
