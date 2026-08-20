# TrialShield

TrialShield is a local hackathon demo that analyzes trial terms and creates a
simulated merchant-locked card record. It does not create real payment cards or
provide real payment-network protection.

## Run the FastAPI backend

1. Install Python 3.12 or newer.
2. From the repository root, install the dependencies:

   ```powershell
   py -m pip install -r requirements.txt
   ```

3. Start FastAPI from the backend directory:

   ```powershell
   Set-Location .\Backend
   py -m uvicorn main:app --reload
   ```

4. Open <http://127.0.0.1:8000/docs> to inspect and try the API routes.

The cleaned models use `Backend/trialshield.db`. The older `database.db` and
`database.backup.db` files are left untouched because they use an incompatible
schema from an earlier prototype.

## Run the existing search service

In a second PowerShell window, run:

```powershell
powershell -ExecutionPolicy Bypass -File .\extension\backend.ps1
```

It continues to serve `POST http://127.0.0.1:8787/search`. Its Gemini key stays
in the local `.env` file and is not included in the extension.

## Load the Chrome extension

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Choose **Load unpacked** and select the `extension` directory.
4. Reload the extension after changing its files.

The popup keeps search on port `8787`. For the active webpage, it sends the
structured object from `content.js` to FastAPI's `/analyze-page` and
`/risk-score` routes. The **Protect this trial** button calls `/protect-trial`
and displays the returned simulated card details.

## Test `/protect-trial`

With FastAPI running, execute this from the repository root:

```powershell
$body = @{
  provider_name = "Example Stream"
  source_url = "https://www.example.com/free-trial"
  trial_duration = "14 days"
  renewal_amount = "₹999/month"
  currency = "INR"
  billing_frequency = "monthly"
  risk_score = 62
  evidence = @(
    "Start a 14-day free trial."
    "Renews for ₹999/month unless cancelled."
  )
} | ConvertTo-Json

$protected = Invoke-RestMethod `
  -Method Post `
  -Uri http://127.0.0.1:8000/protect-trial `
  -ContentType "application/json" `
  -Body $body

$protected
Invoke-RestMethod "http://127.0.0.1:8000/trials/$($protected.trial_id)/audit-events"
```

The request creates one merchant (or reuses it by domain), one trial, one
simulated card, and `PROTECTION_ENABLED` plus `CARD_CREATED` audit events.

To test the payment fallback without claiming cancellation:

```powershell
Invoke-RestMethod `
  -Method Post `
  -Uri "http://127.0.0.1:8000/trials/$($protected.trial_id)/freeze-card"
```

The response always says: “Payment method frozen as fallback. Cancellation is
not confirmed.”
