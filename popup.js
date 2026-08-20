const form = document.querySelector("#search-form");
const input = document.querySelector("#search-input");
const results = document.querySelector("#results");
const resultCount = document.querySelector("#result-count");
const details = document.querySelector("#trial-details");
const analysisStatus = document.querySelector("#analysis-status");
const detailsList = document.querySelector("#details-list");

function renderResults(items, query) {
  results.replaceChildren();
  resultCount.textContent = items.length
    ? `${items.length} trials found for "${query}".`
    : `No trials found for "${query}".`;

  for (const trial of items) {
    const item = document.createElement("li");
    const link = document.createElement("a");
    const name = document.createElement("strong");
    const note = document.createElement("span");
    link.className = "result-link";
    link.href = trial.url;
    name.textContent = trial.name;
    note.textContent = trial.description;
    link.append(name, note);
    link.addEventListener("click", (event) => {
      event.preventDefault();
      chrome.tabs.update({ url: trial.url });
      window.close();
    });
    item.append(link);
    results.append(item);
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const query = input.value.trim();
  if (!query) {
    resultCount.textContent = "Enter the type of free trial you want to find.";
    results.replaceChildren();
    return;
  }

  const button = form.querySelector("button");
  button.disabled = true;
  button.textContent = "Searching...";
  resultCount.textContent = "Searching current free-trial offers...";
  results.replaceChildren();

  try {
    const response = await fetch("http://127.0.0.1:8787/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query })
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Search failed");
    renderResults(payload.results, query);
  } catch (error) {
    resultCount.textContent = error instanceof TypeError
      ? "Search service is offline. Start backend.ps1 and try again."
      : error.message;
  } finally {
    button.disabled = false;
    button.textContent = "Search";
  }
});

function addDetail(label, value) {
  if (value === null || value === undefined || value === "") return;
  const term = document.createElement("dt");
  const description = document.createElement("dd");
  term.textContent = label;
  description.textContent = Array.isArray(value) ? value.join("; ") : String(value);
  detailsList.append(term, description);
}

async function analyzeActivePage() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !/^https?:/.test(tab.url || "")) return;

  details.hidden = false;
  try {
    const response = await chrome.tabs.sendMessage(tab.id, { type: "TRIALSHIELD_ANALYZE" });
    if (!response?.ok) throw new Error(response?.error || "Analysis unavailable");
    const trial = response.trial;
    analysisStatus.textContent = trial.has_free_trial
      ? "Possible free-trial terms detected. Verify them on the provider's checkout page."
      : "No clear free-trial terms were detected on this page.";
    addDetail("Provider", trial.provider_name);
    addDetail("Starts", trial.trial_start);
    addDetail("Duration", trial.trial_duration);
    addDetail("Starting fee", trial.minimum_fee);
    addDetail("Payment method required", trial.payment_method_required);
    addDetail("Auto-renewal", trial.auto_renews);
    addDetail("Cancellation terms", trial.cancellation_terms);
    addDetail("Evidence", trial.evidence);
  } catch {
    analysisStatus.textContent = "Reload this page once after installing the extension to analyze it.";
  }
}

resultCount.textContent = "Search for music, design, fitness, streaming, or another service.";
analyzeActivePage();
