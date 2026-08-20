"""Business logic for TrialShield.

This file is intentionally self-contained and robust for the hackathon demo.

It supports:
- Gemini-powered trial search through the official Gemini REST API
- automatic Gemini model discovery through models.list
- protected-trial creation
- simulated virtual-card creation
- audit/evidence logging
- cancellation-result recording
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
import json
import os
from pathlib import Path
import re
import secrets
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen

from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

try:
    from .models import AuditEvent, Merchant, Trial, VirtualCard
    from .schemas import CancellationAttemptRequest, EvidenceFlag, ProtectTrialRequest
except ImportError:
    from models import AuditEvent, Merchant, Trial, VirtualCard
    from schemas import CancellationAttemptRequest, EvidenceFlag, ProtectTrialRequest


GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta"
_GEMINI_MODEL_CACHE: str | None = None

CURATED_FALLBACK_TRIALS = [
    {
        "name": "Canva Pro",
        "url": "https://www.canva.com/pro/",
        "description": "Official Canva Pro page with design-tool trial and plan information.",
    },
    {
        "name": "Adobe Creative Cloud",
        "url": "https://www.adobe.com/creativecloud/plans.html",
        "description": "Official Adobe plans page for Creative Cloud subscriptions and trials.",
    },
    {
        "name": "Spotify Premium",
        "url": "https://www.spotify.com/premium/",
        "description": "Official Spotify Premium page with music subscription and offer information.",
    },
    {
        "name": "Apple Music",
        "url": "https://www.apple.com/apple-music/",
        "description": "Official Apple Music page with music subscription and trial information.",
    },
    {
        "name": "YouTube Music Premium",
        "url": "https://www.youtube.com/musicpremium",
        "description": "Official YouTube Music Premium page with music subscription details.",
    },
]


def _utc_now() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


def _read_env_file(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if not path.exists():
        return values

    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip().strip('"').strip("'")

    return values


def _env_value(name: str) -> str | None:
    direct = os.getenv(name)
    if direct:
        return direct.strip().strip('"').strip("'")

    backend_dir = Path(__file__).resolve().parent
    repo_root = backend_dir.parent

    candidate_files = [
        backend_dir / ".env",
        repo_root / ".env",
        repo_root / "extension" / ".env",
    ]

    for file_path in candidate_files:
        value = _read_env_file(file_path).get(name)
        if value:
            return value.strip().strip('"').strip("'")

    return None


def get_gemini_api_key() -> str | None:
    api_key = _env_value("GEMINI_API_KEY") or _env_value("GOOGLE_API_KEY")
    if not api_key:
        return None

    api_key = api_key.strip().strip('"').strip("'")

    if api_key.lower().startswith("bearer ") or api_key.startswith("ya29."):
        raise ValueError(
            "GEMINI_API_KEY must be a Google AI Studio API key, not an OAuth token."
        )

    if api_key.lower() in {"your_key_here", "your_api_key_here", "api_key"}:
        raise ValueError("GEMINI_API_KEY is still a placeholder value.")

    return api_key


def _gemini_request(
    path_or_url: str,
    api_key: str,
    *,
    method: str = "GET",
    payload: dict[str, Any] | None = None,
    timeout: int = 25,
) -> dict[str, Any]:
    if path_or_url.startswith("http"):
        url = path_or_url
    else:
        url = f"{GEMINI_API_BASE}{path_or_url}"

    headers = {
        "Content-Type": "application/json",
        "x-goog-api-key": api_key,
    }

    data = None
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")

    request = Request(url, data=data, headers=headers, method=method)

    with urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def _list_gemini_models(api_key: str) -> list[dict[str, Any]]:
    models: list[dict[str, Any]] = []
    next_page_token: str | None = None

    for _ in range(10):
        path = "/models"
        if next_page_token:
            path += f"?pageToken={next_page_token}"

        response = _gemini_request(path, api_key, method="GET", timeout=20)
        models.extend(response.get("models", []))
        next_page_token = response.get("nextPageToken")

        if not next_page_token:
            break

    return models


def _model_priority(model_name: str) -> tuple[int, str]:
    name = model_name.lower()

    if "embedding" in name or "aqa" in name or "imagen" in name:
        return (-100, name)

    score = 0

    if "flash" in name:
        score += 1000
    if "lite" in name:
        score += 100
    if "pro" in name:
        score += 50

    # Prefer newer families when the key has access to them.
    version_match = re.search(r"gemini-(\d+)(?:\.(\d+))?", name)
    if version_match:
        major = int(version_match.group(1))
        minor = int(version_match.group(2) or "0")
        score += major * 100 + minor * 10

    # Avoid preview/experimental aliases unless nothing better exists.
    if "preview" in name:
        score -= 20
    if "exp" in name or "experimental" in name:
        score -= 40
    if "latest" in name:
        score -= 10

    return (score, name)


def get_available_gemini_model(api_key: str) -> str:
    """Return one model name that this API key can actually use.

    Important: do not hardcode Gemini model names. Google may retire aliases.
    The Gemini API tells callers to use models.list and check
    supportedGenerationMethods.
    """

    global _GEMINI_MODEL_CACHE

    if _GEMINI_MODEL_CACHE:
        return _GEMINI_MODEL_CACHE

    models = _list_gemini_models(api_key)

    candidates: list[str] = []
    for model in models:
        name = str(model.get("name") or "").strip()
        supported_methods = model.get("supportedGenerationMethods") or []
        if not name:
            continue
        if "generateContent" not in supported_methods:
            continue
        if "embedding" in name.lower():
            continue
        candidates.append(name)

    if not candidates:
        raise RuntimeError(
            "Gemini API key is valid, but no model supporting generateContent "
            "was returned by models.list."
        )

    candidates.sort(key=_model_priority, reverse=True)
    _GEMINI_MODEL_CACHE = candidates[0]
    print(f"TrialShield Gemini model selected: {_GEMINI_MODEL_CACHE}")
    return _GEMINI_MODEL_CACHE


def extract_domain(url: str) -> str:
    parsed = urlparse((url or "").strip())
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise ValueError("source_url must be a valid http(s) URL")
    return parsed.hostname.lower().removeprefix("www.")


def parse_trial_days(trial_duration: str | None) -> int:
    text = trial_duration or ""
    match = re.search(
        r"(\d+)\s*(day|week|month)s?\b",
        text,
        re.IGNORECASE,
    )
    if not match:
        return 7

    amount = int(match.group(1))
    unit = match.group(2).lower()

    if unit == "week":
        return amount * 7
    if unit == "month":
        return amount * 30
    return amount


def parse_amount(value: str | None) -> float:
    if not value:
        return 0.0

    patterns = [
        r"(?:₹|Rs\.?|INR)\s*(\d[\d,]*(?:\.\d+)?)",
        r"(\d[\d,]*(?:\.\d+)?)\s*(?:rupees|INR)",
        r"(?:\$|€|£)\s*(\d[\d,]*(?:\.\d+)?)",
        r"(\d[\d,]*(?:\.\d+)?)",
    ]

    for pattern in patterns:
        match = re.search(pattern, value, re.IGNORECASE)
        if match:
            return float(match.group(1).replace(",", ""))

    return 0.0


def _passes_luhn_check(number: str) -> bool:
    digits = [int(digit) for digit in number]
    total = 0
    parity = len(digits) % 2

    for index, digit in enumerate(digits):
        if index % 2 == parity:
            digit *= 2
            if digit > 9:
                digit -= 9
        total += digit

    return total % 10 == 0


def generate_card_number(db: Session) -> str:
    for _ in range(100):
        # Starts with 9 and deliberately fails Luhn so it is visibly demo-only.
        number = "9" + "".join(secrets.choice("0123456789") for _ in range(15))

        if _passes_luhn_check(number):
            number = number[:-1] + str((int(number[-1]) + 1) % 10)

        exists = db.scalar(
            select(VirtualCard.id).where(VirtualCard.card_number == number)
        )
        if exists is None:
            return number

    raise RuntimeError("Could not generate a unique simulated card number")


def generate_cvv() -> str:
    return f"{secrets.randbelow(1000):03d}"


def create_virtual_card(
    db: Session,
    trial: Trial,
    merchant_domain: str,
    renewal_amount: float,
) -> VirtualCard:
    now = _utc_now()
    spend_limit = max(float(renewal_amount or 0.0), 1.0)

    card = VirtualCard(
        trial_id=trial.id,
        card_number=generate_card_number(db),
        expiry_month=now.month,
        expiry_year=now.year + 3,
        cvv=generate_cvv(),
        merchant_lock=merchant_domain,
        balance=spend_limit,
        spend_limit=spend_limit,
        status="active",
    )
    db.add(card)
    db.flush()
    return card


def log_event(
    db: Session,
    trial_id: int,
    event_type: str,
    description: str,
    event_metadata: dict[str, object] | None = None,
    *,
    commit: bool = True,
) -> AuditEvent:
    event = AuditEvent(
        trial_id=trial_id,
        event_type=event_type,
        description=description,
        event_metadata=dict(event_metadata or {}),
    )

    try:
        db.add(event)
        if commit:
            db.commit()
            db.refresh(event)
        else:
            db.flush()
        return event
    except SQLAlchemyError:
        db.rollback()
        raise


def create_protected_trial(
    db: Session,
    request: ProtectTrialRequest,
) -> tuple[Trial, VirtualCard]:
    merchant_domain = extract_domain(request.source_url)
    trial_days = parse_trial_days(request.trial_duration)
    renewal_amount = parse_amount(request.renewal_amount)
    renewal_date = _utc_now() + timedelta(days=trial_days)

    try:
        merchant = db.scalar(select(Merchant).where(Merchant.domain == merchant_domain))
        if merchant is None:
            merchant = Merchant(
                name=request.provider_name.strip(),
                domain=merchant_domain,
            )
            db.add(merchant)
            db.flush()
        else:
            merchant.name = request.provider_name.strip() or merchant.name

        trial = Trial(
            merchant_id=merchant.id,
            trial_days=trial_days,
            renewal_date=renewal_date,
            renewal_amount=renewal_amount,
            currency=request.currency.upper(),
            billing_frequency=request.billing_frequency.lower(),
            risk_score=float(request.risk_score),
            status="protected",
            cancellation_status="not_started",
        )
        db.add(trial)
        db.flush()

        card = create_virtual_card(db, trial, merchant_domain, renewal_amount)

        db.add_all(
            [
                AuditEvent(
                    trial_id=trial.id,
                    event_type="PROTECTION_ENABLED",
                    description="TrialShield protection was enabled for this trial.",
                    event_metadata={
                        "source_url": request.source_url,
                        "provider_name": request.provider_name,
                        "trial_duration": request.trial_duration,
                        "renewal_amount": request.renewal_amount,
                        "currency": request.currency.upper(),
                        "billing_frequency": request.billing_frequency.lower(),
                        "risk_score": request.risk_score,
                        "evidence": request.evidence,
                    },
                ),
                AuditEvent(
                    trial_id=trial.id,
                    event_type="CARD_CREATED",
                    description="A simulated merchant-locked virtual card was created.",
                    event_metadata={
                        "card_id": card.id,
                        "merchant_lock": merchant_domain,
                        "spend_limit": card.spend_limit,
                        "simulation": True,
                        "real_payment_card": False,
                    },
                ),
            ]
        )

        db.commit()
        db.refresh(trial)
        db.refresh(card)
        return trial, card

    except Exception:
        db.rollback()
        raise


def analyze_evidence_texts(evidence: list[str]) -> list[EvidenceFlag]:
    joined = "\n".join(evidence or "")
    flags: list[EvidenceFlag] = []

    checks = [
        (
            "auto_renewal",
            "Auto-renewal language",
            "high",
            r"auto(?:matically)?[- ]?renew|renews? automatically|unless you cancel|charged after",
            "The page suggests the trial may renew automatically.",
        ),
        (
            "payment_required",
            "Payment method required",
            "medium",
            r"payment method required|credit card required|debit card required|valid payment method",
            "The trial may require a payment method before activation.",
        ),
        (
            "unclear_cancellation",
            "Cancellation is unclear",
            "medium",
            r"cancel(?:lation)?[^.\n]{0,100}(?:before|within|contact|support|email|phone)",
            "The cancellation path may require extra action or timing.",
        ),
        (
            "fee_or_commitment",
            "Fee or commitment language",
            "high",
            r"cancellation fee|early termination|minimum commitment|non[- ]?refundable|no refunds?",
            "The evidence mentions a possible fee, commitment, or refund restriction.",
        ),
        (
            "confirmation",
            "Cancellation confirmation",
            "low",
            r"cancel(?:led|ed|lation confirmed)|subscription (?:has been )?cancel(?:led|ed)|plan (?:has been )?cancel(?:led|ed)",
            "The evidence contains cancellation confirmation language.",
        ),
    ]

    for code, label, severity, pattern, explanation in checks:
        match = re.search(pattern, joined, re.IGNORECASE)
        if match:
            flags.append(
                EvidenceFlag(
                    code=code,
                    label=label,
                    severity=severity,
                    explanation=explanation,
                    evidence=match.group(0)[:240],
                )
            )

    return flags


def _looks_cancelled(request: CancellationAttemptRequest) -> bool:
    if request.confirmation_detected:
        return True

    text = "\n".join(request.evidence + request.attempted_actions)
    return bool(
        re.search(
            r"cancel(?:led|ed|lation confirmed)|subscription (?:has been |is )?"
            r"cancel(?:led|ed)|plan (?:has been |is )?cancel(?:led|ed)|"
            r"you will not be charged|auto[- ]?renewal (?:is )?off",
            text,
            re.IGNORECASE,
        )
    )


def record_cancellation_attempt(
    db: Session,
    trial_id: int,
    request: CancellationAttemptRequest,
) -> dict[str, Any]:
    try:
        trial = db.get(Trial, trial_id)
        if trial is None:
            raise ValueError("Trial not found")

        card = db.scalar(select(VirtualCard).where(VirtualCard.trial_id == trial_id))
        merchant = db.get(Merchant, trial.merchant_id)

        confirmed = _looks_cancelled(request)

        if confirmed:
            trial.status = "cancelled"
            trial.cancellation_status = "confirmed"
            if card is not None:
                card.status = "frozen"
            if merchant is not None:
                merchant.successful_cancellations += 1

            event_type = "CANCELLATION_CONFIRMED"
            description = "Automatic cancellation flow found confirmation evidence."
            message = "Cancellation confirmed and evidence was saved."
        else:
            trial.status = "payment_blocked"
            trial.cancellation_status = "unresolved"
            if card is not None:
                card.status = "frozen"
            if merchant is not None:
                merchant.failed_cancellations += 1

            event_type = "CANCELLATION_UNCONFIRMED_FALLBACK"
            description = (
                "Automatic cancellation could not confirm success; simulated card "
                "was frozen as fallback protection."
            )
            message = (
                "Cancellation was not confirmed. The simulated card was frozen as fallback."
            )

        event = AuditEvent(
            trial_id=trial.id,
            event_type=event_type,
            description=description,
            event_metadata={
                "source_url": request.source_url,
                "final_url": request.final_url,
                "page_title": request.page_title,
                "attempted_actions": request.attempted_actions,
                "evidence": request.evidence,
                "confirmation_detected": confirmed,
                "raw_status": request.raw_status,
                "reason": request.reason,
                "card_frozen": card is not None and card.status == "frozen",
            },
        )
        db.add(event)
        db.commit()
        db.refresh(event)
        db.refresh(trial)
        if card is not None:
            db.refresh(card)

        return {
            "trial_id": trial.id,
            "status": trial.status,
            "cancellation_status": trial.cancellation_status,
            "card_status": card.status if card is not None else None,
            "confirmed": confirmed,
            "audit_event_id": event.id,
            "message": message,
        }

    except Exception:
        db.rollback()
        raise


def _safe_json_from_gemini_text(text: str) -> dict[str, Any]:
    cleaned = text.strip()
    cleaned = re.sub(r"^```(?:json)?\s*", "", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"\s*```$", "", cleaned)
    return json.loads(cleaned)


def _validate_search_results(items: list[dict[str, Any]]) -> list[dict[str, str]]:
    clean: list[dict[str, str]] = []
    seen_hosts: set[str] = set()

    for item in items:
        name = str(item.get("name") or "").strip()
        url = str(item.get("url") or "").strip()
        description = str(item.get("description") or "").strip()

        parsed = urlparse(url)
        if parsed.scheme != "https" or not parsed.hostname:
            continue

        host = parsed.hostname.lower().removeprefix("www.")

        if host in seen_hosts:
            continue

        if any(
            blocked in host
            for blocked in [
                "google.",
                "bing.",
                "duckduckgo.",
                "reddit.",
                "youtube.com",
                "facebook.com",
                "x.com",
                "twitter.com",
            ]
        ):
            continue

        if not name or not description:
            continue

        seen_hosts.add(host)
        clean.append(
            {
                "name": name[:100],
                "url": url,
                "description": description[:240],
            }
        )

        if len(clean) == 5:
            break

    return clean


def _fallback_search_results(query: str) -> list[dict[str, str]]:
    words = set(re.findall(r"[a-z0-9]+", query.lower()))
    ranked: list[tuple[int, dict[str, str]]] = []

    for item in CURATED_FALLBACK_TRIALS:
        haystack = f"{item['name']} {item['description']}".lower()
        score = sum(1 for word in words if word in haystack)
        ranked.append((score, item))

    ranked.sort(key=lambda pair: pair[0], reverse=True)
    return [dict(item) for _, item in ranked[:5]]


def search_free_trials(query: str) -> tuple[list[dict[str, str]], str]:
    query = query.strip()
    if not query:
        raise ValueError("Query must not be empty")

    try:
        api_key = get_gemini_api_key()
    except ValueError:
        raise

    if not api_key:
        return _fallback_search_results(query), "fallback:no_gemini_key"

    prompt = f"""
Find exactly five legitimate official websites relevant to this free-trial search:

{query!r}

Rules:
- Return only JSON.
- Use official provider websites only.
- Do not return search engines, affiliate pages, coupon sites, blogs, shortened links, or comparison pages.
- Prefer pages likely to mention free trials, pricing, subscriptions, music plans, software plans, or subscription trials.
- Do not invent fake domains.

JSON shape:
{{
  "results": [
    {{"name": "Provider", "url": "https://official.example/path", "description": "Short useful summary"}}
  ]
}}
""".strip()

    payload = {
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {
            "responseMimeType": "application/json",
            "responseSchema": {
                "type": "OBJECT",
                "properties": {
                    "results": {
                        "type": "ARRAY",
                        "minItems": 5,
                        "maxItems": 5,
                        "items": {
                            "type": "OBJECT",
                            "properties": {
                                "name": {"type": "STRING"},
                                "url": {"type": "STRING"},
                                "description": {"type": "STRING"},
                            },
                            "required": ["name", "url", "description"],
                        },
                    }
                },
                "required": ["results"],
            },
        },
    }

    try:
        model_name = get_available_gemini_model(api_key)
        response_json = _gemini_request(
            f"/{model_name}:generateContent",
            api_key,
            method="POST",
            payload=payload,
            timeout=30,
        )

        text = (
            response_json.get("candidates", [{}])[0]
            .get("content", {})
            .get("parts", [{}])[0]
            .get("text", "")
        )

        parsed = _safe_json_from_gemini_text(text)
        results = _validate_search_results(parsed.get("results", []))

        if len(results) < 3:
            fallback_urls = {item["url"] for item in results}
            for fallback in _fallback_search_results(query):
                if fallback["url"] not in fallback_urls:
                    results.append(fallback)
                    fallback_urls.add(fallback["url"])
                if len(results) == 5:
                    break

        if not results:
            return _fallback_search_results(query), f"fallback:{model_name}:empty_result"

        return results[:5], f"gemini:{model_name}"

    except HTTPError as error:
        body = error.read().decode("utf-8", errors="replace")
        return (
            _fallback_search_results(query),
            f"fallback:gemini_http_{error.code}:{body[:120]}",
        )
    except (URLError, TimeoutError, json.JSONDecodeError, KeyError, IndexError) as error:
        return (
            _fallback_search_results(query),
            f"fallback:gemini_failed:{str(error)[:120]}",
        )
    except RuntimeError as error:
        return (
            _fallback_search_results(query),
            f"fallback:gemini_unavailable:{str(error)[:120]}",
        )