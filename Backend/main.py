"""FastAPI application and routes for the TrialShield hackathon demo."""

from __future__ import annotations

import re

from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session, selectinload

try:
    from .database import create_db, get_db
    from .models import AuditEvent, Trial, VirtualCard
    from .schemas import (
        AuditEventResponse,
        CancellationAttemptRequest,
        CancellationAttemptResponse,
        EvidenceAnalysisRequest,
        EvidenceAnalysisResponse,
        EvidenceFlag,
        HealthCheck,
        PageAnalysisResponse,
        ProtectTrialRequest,
        ProtectTrialResponse,
        RiskFactor,
        RiskLevel,
        RiskScoreResponse,
        SearchRequest,
        SearchResponse,
        TrialPage,
        TrialResponse,
    )
    from .services import (
        analyze_evidence_texts,
        create_protected_trial,
        log_event,
        record_cancellation_attempt,
        search_free_trials,
    )
except ImportError:
    from database import create_db, get_db
    from models import AuditEvent, Trial, VirtualCard
    from schemas import (
        AuditEventResponse,
        CancellationAttemptRequest,
        CancellationAttemptResponse,
        EvidenceAnalysisRequest,
        EvidenceAnalysisResponse,
        EvidenceFlag,
        HealthCheck,
        PageAnalysisResponse,
        ProtectTrialRequest,
        ProtectTrialResponse,
        RiskFactor,
        RiskLevel,
        RiskScoreResponse,
        SearchRequest,
        SearchResponse,
        TrialPage,
        TrialResponse,
    )
    from services import (
        analyze_evidence_texts,
        create_protected_trial,
        log_event,
        record_cancellation_attempt,
        search_free_trials,
    )


app = FastAPI(
    title="TrialShield API",
    description=(
        "Local trial-risk analysis, Gemini-powered trial discovery, simulated "
        "card protection, automatic cancellation attempts, and audit evidence."
    ),
    version="2.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)

create_db()


@app.get("/", response_model=HealthCheck, tags=["health"])
@app.get("/check", response_model=HealthCheck, tags=["health"])
def check() -> HealthCheck:
    return HealthCheck()


@app.post("/search", response_model=SearchResponse, tags=["gemini"])
def search_trials(request: SearchRequest) -> SearchResponse:
    try:
        results, source = search_free_trials(request.query)
        return SearchResponse(results=results, source=source)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    except RuntimeError as error:
        raise HTTPException(status_code=502, detail=str(error)) from error


def _is_missing(value: object) -> bool:
    return value is None or (isinstance(value, str) and not value.strip())


@app.post("/evidence/analyze", response_model=EvidenceAnalysisResponse, tags=["analysis"])
def analyze_evidence(request: EvidenceAnalysisRequest) -> EvidenceAnalysisResponse:
    flags = analyze_evidence_texts(request.evidence)
    summary = (
        "No major evidence flags detected."
        if not flags
        else f"{len(flags)} evidence flag{'s' if len(flags) != 1 else ''} detected."
    )
    return EvidenceAnalysisResponse(
        source_url=request.source_url,
        flags=flags,
        summary=summary,
    )


@app.post("/analyze-page", response_model=PageAnalysisResponse, tags=["analysis"])
def analyze_page(trial: TrialPage) -> PageAnalysisResponse:
    tracked_fields = {
        "trial_start": trial.trial_start,
        "trial_duration": trial.trial_duration,
        "cancellation_terms": trial.cancellation_terms,
        "minimum_fee": trial.minimum_fee,
        "recurring_charge": trial.recurring_charge,
        "payment_method_required": trial.payment_method_required,
        "auto_renews": trial.auto_renews,
        "evidence": trial.evidence,
    }

    missing_fields = [
        name
        for name, value in tracked_fields.items()
        if _is_missing(value) or value == []
    ]
    completeness_score = round(
        100 * (len(tracked_fields) - len(missing_fields)) / len(tracked_fields)
    )

    warnings: list[str] = []
    if not trial.has_free_trial:
        warnings.append("The supplied page data does not confirm a free trial.")
    if trial.auto_renews is True and _is_missing(trial.cancellation_terms):
        warnings.append("The trial auto-renews, but cancellation terms were not found.")
    if trial.payment_method_required is True and _is_missing(trial.minimum_fee):
        warnings.append("A payment method is required, but the first charge is unclear.")
    if trial.cancellation_terms and re.search(
        r"non[- ]?refundable|cancellation fee|early termination|"
        r"minimum commitment|no refunds?",
        trial.cancellation_terms,
        re.IGNORECASE,
    ):
        warnings.append("Cancellation text may contain a fee or commitment.")
    if not trial.evidence:
        warnings.append("No supporting page-text evidence was supplied.")

    evidence_flags = analyze_evidence_texts(
        trial.evidence
        + [
            value
            for value in [
                trial.cancellation_terms,
                trial.minimum_fee,
                trial.recurring_charge,
            ]
            if value
        ]
    )

    return PageAnalysisResponse(
        trial=trial,
        completeness_score=completeness_score,
        missing_fields=missing_fields,
        warnings=warnings,
        evidence_flags=evidence_flags,
    )


def _factor(code: str, label: str, points: int, explanation: str) -> RiskFactor:
    return RiskFactor(
        code=code,
        label=label,
        points=points,
        explanation=explanation,
    )


def _has_nonzero_fee(value: str | None) -> bool:
    if not value:
        return False
    if re.search(
        r"\bno\s+(?:upfront|initial|starting)?\s*(?:fee|charge)\b",
        value,
        re.IGNORECASE,
    ):
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


@app.post("/risk-score", response_model=RiskScoreResponse, tags=["analysis"])
def risk_score(trial: TrialPage) -> RiskScoreResponse:
    factors: list[RiskFactor] = []

    if not trial.has_free_trial:
        factors.append(
            _factor(
                "trial_unconfirmed",
                "Trial not confirmed",
                15,
                "The page data does not clearly confirm a free trial.",
            )
        )

    if trial.auto_renews is True:
        factors.append(
            _factor(
                "auto_renewal",
                "Automatic renewal",
                30,
                "The subscription may charge automatically after the trial.",
            )
        )
    elif trial.auto_renews is None:
        factors.append(
            _factor(
                "unknown_renewal",
                "Renewal unclear",
                12,
                "The page does not clearly say whether the trial renews automatically.",
            )
        )

    if trial.payment_method_required is True:
        factors.append(
            _factor(
                "payment_required",
                "Payment method required",
                20,
                "A payment method appears to be required before the trial starts.",
            )
        )
    elif trial.payment_method_required is None:
        factors.append(
            _factor(
                "unknown_payment",
                "Payment requirement unclear",
                8,
                "The extension did not identify whether payment details are required.",
            )
        )

    if _has_nonzero_fee(trial.minimum_fee):
        factors.append(
            _factor(
                "starting_fee",
                "Non-zero starting fee",
                15,
                f"The detected starting fee is {trial.minimum_fee}.",
            )
        )

    if trial.recurring_charge:
        factors.append(
            _factor(
                "recurring_charge_detected",
                "Recurring charge detected",
                12,
                f"The detected recurring charge is {trial.recurring_charge}.",
            )
        )

    if not trial.cancellation_terms:
        factors.append(
            _factor(
                "missing_cancellation",
                "Cancellation terms missing",
                20,
                "Cancellation terms were not identified on the page.",
            )
        )
    elif re.search(
        r"non[- ]?refundable|cancellation fee|early termination|"
        r"minimum commitment|no refunds?|contact support|email support",
        trial.cancellation_terms,
        re.IGNORECASE,
    ):
        factors.append(
            _factor(
                "restrictive_cancellation",
                "Restrictive cancellation terms",
                20,
                "The terms mention friction, fees, support contact, or refund limits.",
            )
        )

    if not trial.trial_duration:
        factors.append(
            _factor(
                "unknown_duration",
                "Trial duration missing",
                8,
                "The length of the trial was not identified.",
            )
        )

    if not trial.evidence:
        factors.append(
            _factor(
                "missing_evidence",
                "No supporting evidence",
                10,
                "No relevant page evidence was captured.",
            )
        )

    evidence_flags = analyze_evidence_texts(trial.evidence)
    for flag in evidence_flags:
        if flag.severity == "high":
            factors.append(
                _factor(
                    f"evidence_{flag.code}",
                    flag.label,
                    10,
                    flag.explanation,
                )
            )

    score = min(100, sum(item.points for item in factors))
    level = _risk_level(score)

    summary = (
        "No material trial risks were detected from the supplied fields."
        if not factors
        else (
            f"{len(factors)} risk factor"
            f"{'s' if len(factors) != 1 else ''} produced a "
            f"{level.value} risk rating."
        )
    )

    return RiskScoreResponse(
        source_url=trial.source_url,
        provider_name=trial.provider_name,
        score=score,
        level=level,
        factors=factors,
        summary=summary,
    )


@app.post(
    "/protect-trial",
    response_model=ProtectTrialResponse,
    status_code=201,
    tags=["trials"],
)
def protect_trial(
    request: ProtectTrialRequest,
    db: Session = Depends(get_db),
) -> ProtectTrialResponse:
    try:
        trial, card = create_protected_trial(db, request)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    except SQLAlchemyError as error:
        raise HTTPException(
            status_code=500,
            detail="The protected trial could not be saved.",
        ) from error
    except RuntimeError as error:
        raise HTTPException(status_code=500, detail=str(error)) from error

    return ProtectTrialResponse(
        trial_id=trial.id,
        merchant_id=trial.merchant_id,
        card=card,
        message="TrialShield protection enabled. This is a simulated card only.",
    )


@app.get("/trials", response_model=list[TrialResponse], tags=["trials"])
def list_trials(db: Session = Depends(get_db)) -> list[Trial]:
    try:
        return list(
            db.scalars(
                select(Trial)
                .options(selectinload(Trial.virtual_card))
                .order_by(Trial.created_at.desc())
            ).all()
        )
    except SQLAlchemyError as error:
        raise HTTPException(
            status_code=500,
            detail="Protected trials could not be loaded.",
        ) from error


@app.get("/trials/{trial_id}", response_model=TrialResponse, tags=["trials"])
def get_trial(trial_id: int, db: Session = Depends(get_db)) -> Trial:
    try:
        trial = db.scalar(
            select(Trial)
            .options(selectinload(Trial.virtual_card))
            .where(Trial.id == trial_id)
        )
    except SQLAlchemyError as error:
        raise HTTPException(
            status_code=500,
            detail="The protected trial could not be loaded.",
        ) from error

    if trial is None:
        raise HTTPException(status_code=404, detail="Trial not found")
    return trial


@app.post(
    "/trials/{trial_id}/cancel-attempt",
    response_model=CancellationAttemptResponse,
    tags=["trials"],
)
def cancel_attempt(
    trial_id: int,
    request: CancellationAttemptRequest,
    db: Session = Depends(get_db),
) -> CancellationAttemptResponse:
    try:
        result = record_cancellation_attempt(db, trial_id, request)
        return CancellationAttemptResponse(**result)
    except ValueError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    except SQLAlchemyError as error:
        raise HTTPException(
            status_code=500,
            detail="The cancellation attempt could not be recorded.",
        ) from error


@app.post("/trials/{trial_id}/freeze-card", tags=["trials"])
def freeze_card(trial_id: int, db: Session = Depends(get_db)) -> dict[str, object]:
    try:
        trial = db.get(Trial, trial_id)
        if trial is None:
            raise HTTPException(status_code=404, detail="Trial not found")

        card = db.scalar(select(VirtualCard).where(VirtualCard.trial_id == trial_id))
        if card is None:
            raise HTTPException(status_code=404, detail="Virtual card not found")

        already_frozen = card.status.casefold() == "frozen"
        card.status = "frozen"

        if trial.status.casefold() != "cancelled":
            trial.status = "payment_blocked"
            trial.cancellation_status = (
                trial.cancellation_status
                if trial.cancellation_status == "confirmed"
                else "unresolved"
            )

        if already_frozen:
            db.commit()
            db.refresh(trial)
            db.refresh(card)
        else:
            log_event(
                db,
                trial.id,
                "PAYMENT_BLOCKED_FALLBACK",
                "Payment method frozen as fallback. Cancellation is not confirmed.",
                {
                    "card_id": card.id,
                    "card_status": card.status,
                    "cancellation_confirmed": False,
                },
            )

        return {
            "trial_id": trial.id,
            "trial_status": trial.status,
            "cancellation_status": trial.cancellation_status,
            "card_status": card.status,
            "already_frozen": already_frozen,
            "message": (
                "Payment method frozen as fallback. Cancellation is not confirmed."
            ),
        }

    except HTTPException:
        raise
    except SQLAlchemyError as error:
        db.rollback()
        raise HTTPException(
            status_code=500,
            detail="The simulated card could not be frozen.",
        ) from error


@app.get(
    "/trials/{trial_id}/audit-events",
    response_model=list[AuditEventResponse],
    tags=["trials"],
)
def list_audit_events(
    trial_id: int,
    db: Session = Depends(get_db),
) -> list[AuditEvent]:
    try:
        if db.get(Trial, trial_id) is None:
            raise HTTPException(status_code=404, detail="Trial not found")

        return list(
            db.scalars(
                select(AuditEvent)
                .where(AuditEvent.trial_id == trial_id)
                .order_by(AuditEvent.timestamp.asc(), AuditEvent.id.asc())
            ).all()
        )

    except HTTPException:
        raise
    except SQLAlchemyError as error:
        raise HTTPException(
            status_code=500,
            detail="Audit events could not be loaded.",
        ) from error