"""FastAPI routes for TrialShield page analysis and risk scoring."""

import re
from typing import List

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from models import (
    HealthCheck,
    PageAnalysisResponse,
    RiskFactor,
    RiskLevel,
    RiskScoreResponse,
    TrialPage,
)


app = FastAPI(
    title="TrialShield API",
    description="Validates free-trial details and calculates explainable risk scores.",
    version="1.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
)


@app.get("/", response_model=HealthCheck, tags=["health"])
@app.get("/check", response_model=HealthCheck, tags=["health"])
def check() -> HealthCheck:
    """Default health route for local and deployment checks."""

    return HealthCheck()


def _is_missing(value: object) -> bool:
    return value is None or (isinstance(value, str) and not value.strip())


@app.post("/analyze-page", response_model=PageAnalysisResponse, tags=["trials"])
def analyze_page(trial: TrialPage) -> PageAnalysisResponse:
    """Validate structured page data and report gaps or contradictory terms."""

    tracked_fields = {
        "trial_start": trial.trial_start,
        "trial_duration": trial.trial_duration,
        "cancellation_terms": trial.cancellation_terms,
        "minimum_fee": trial.minimum_fee,
        "payment_method_required": trial.payment_method_required,
        "auto_renews": trial.auto_renews,
        "evidence": trial.evidence,
    }
    missing_fields = [name for name, value in tracked_fields.items() if _is_missing(value) or value == []]
    completeness_score = round(100 * (len(tracked_fields) - len(missing_fields)) / len(tracked_fields))

    warnings: List[str] = []
    if not trial.has_free_trial:
        warnings.append("The supplied page data does not contain a confirmed free trial.")
    if trial.auto_renews is True and _is_missing(trial.cancellation_terms):
        warnings.append("The trial auto-renews, but cancellation terms were not supplied.")
    if trial.payment_method_required is True and _is_missing(trial.minimum_fee):
        warnings.append("A payment method is required, but the starting charge is unclear.")
    if trial.cancellation_terms and re.search(
        r"non[- ]?refundable|cancellation fee|early termination|minimum commitment",
        trial.cancellation_terms,
        re.IGNORECASE,
    ):
        warnings.append("The cancellation text may contain a fee or minimum commitment.")
    if len(trial.evidence) == 0:
        warnings.append("No supporting page-text evidence was supplied.")

    return PageAnalysisResponse(
        trial=trial,
        completeness_score=completeness_score,
        missing_fields=missing_fields,
        warnings=warnings,
    )


def _factor(code: str, label: str, points: int, explanation: str) -> RiskFactor:
    return RiskFactor(code=code, label=label, points=points, explanation=explanation)


def _has_nonzero_fee(value: str | None) -> bool:
    if not value or re.search(r"\bno\s+(?:upfront|initial)\s+(?:fee|charge)\b", value, re.IGNORECASE):
        return False
    amounts = re.findall(r"\d+(?:[.,]\d{1,2})?", value)
    return any(float(amount.replace(",", ".")) > 0 for amount in amounts)


def _risk_level(score: int) -> RiskLevel:
    if score >= 80:
        return RiskLevel.critical
    if score >= 60:
        return RiskLevel.high
    if score >= 30:
        return RiskLevel.medium
    return RiskLevel.low


@app.post("/risk-score", response_model=RiskScoreResponse, tags=["risk"])
def risk_score(trial: TrialPage) -> RiskScoreResponse:
    """Calculate a transparent risk score from validated trial details."""

    factors: List[RiskFactor] = []

    if not trial.has_free_trial:
        factors.append(_factor("trial_unconfirmed", "Trial not confirmed", 15, "The page data does not clearly confirm a free trial."))

    if trial.auto_renews is True:
        factors.append(_factor("auto_renewal", "Automatic renewal", 30, "The subscription may start charging automatically after the trial."))
    elif trial.auto_renews is None:
        factors.append(_factor("unknown_renewal", "Renewal unclear", 12, "The page data does not state whether the trial renews automatically."))

    if trial.payment_method_required is True:
        factors.append(_factor("payment_required", "Payment method required", 20, "A payment method is required before the trial can begin."))
    elif trial.payment_method_required is None:
        factors.append(_factor("unknown_payment", "Payment requirement unclear", 8, "The payment-method requirement was not identified."))

    if _has_nonzero_fee(trial.minimum_fee):
        factors.append(_factor("starting_fee", "Non-zero starting fee", 15, f"The detected starting fee is {trial.minimum_fee}."))

    if not trial.cancellation_terms:
        factors.append(_factor("missing_cancellation", "Cancellation terms missing", 20, "The extension could not identify cancellation terms."))
    elif re.search(
        r"non[- ]?refundable|cancellation fee|early termination|minimum commitment|no refunds?",
        trial.cancellation_terms,
        re.IGNORECASE,
    ):
        factors.append(_factor("restrictive_cancellation", "Restrictive cancellation terms", 20, "The cancellation terms mention a fee, commitment, or refund restriction."))

    if not trial.trial_duration:
        factors.append(_factor("unknown_duration", "Trial duration missing", 8, "The length of the trial was not identified."))
    if not trial.evidence:
        factors.append(_factor("missing_evidence", "No supporting evidence", 10, "No relevant page text was included for verification."))

    score = min(100, sum(item.points for item in factors))
    level = _risk_level(score)
    summary = (
        "No material trial risks were detected from the supplied fields."
        if not factors
        else f"{len(factors)} risk factor{'s' if len(factors) != 1 else ''} produced a {level.value} risk rating."
    )

    return RiskScoreResponse(
        source_url=trial.source_url,
        provider_name=trial.provider_name,
        score=score,
        level=level,
        factors=factors,
        summary=summary,
    )
