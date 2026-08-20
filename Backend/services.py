"""Small business-logic helpers for the TrialShield hackathon backend."""

from datetime import UTC, datetime, timedelta
import re
import secrets
from urllib.parse import urlparse

from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

try:
    from .models import AuditEvent, Merchant, Trial, VirtualCard
    from .schemas import ProtectTrialRequest
except ImportError:
    from models import AuditEvent, Merchant, Trial, VirtualCard
    from schemas import ProtectTrialRequest


def extract_domain(url: str) -> str:
    """Return a normalized hostname from an absolute HTTP(S) URL."""

    parsed = urlparse((url or "").strip())
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise ValueError("source_url must be a valid http(s) URL")
    return parsed.hostname.lower().removeprefix("www.")


def parse_trial_days(trial_duration: str | None) -> int:
    """Turn simple duration text into days, defaulting unknown values to 7."""

    match = re.search(
        r"(\d+)\s*(day|week|month)s?\b",
        trial_duration or "",
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
    """Extract the first non-negative decimal amount from display text."""

    match = re.search(r"\d[\d,]*(?:\.\d+)?", value or "")
    if not match:
        return 0.0
    try:
        return float(match.group(0).replace(",", ""))
    except ValueError:
        return 0.0


def _passes_luhn_check(number: str) -> bool:
    """Return whether a number passes Luhn; generated demo IDs must not."""

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
    """Generate a unique 16-digit, deliberately non-network-valid demo ID."""

    for _ in range(100):
        # Major payment networks do not use a 9 issuer prefix. We also ensure
        # the value fails Luhn so it cannot be mistaken for a usable card.
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
    """Generate a three-digit value for the simulated local card record."""

    return f"{secrets.randbelow(1000):03d}"


def create_virtual_card(
    db: Session,
    trial: Trial,
    merchant_domain: str,
    spend_limit: float,
) -> VirtualCard:
    """Create and flush a merchant-locked simulated card for one trial."""

    now = datetime.now(UTC)
    card = VirtualCard(
        trial_id=trial.id,
        card_number=generate_card_number(db),
        expiry_month=now.month,
        expiry_year=now.year + 3,
        cvv=generate_cvv(),
        merchant_lock=merchant_domain,
        balance=0.0,
        spend_limit=max(0.0, spend_limit),
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
) -> AuditEvent:
    """Persist and return one reusable audit-evidence event."""

    event = AuditEvent(
        trial_id=trial_id,
        event_type=event_type,
        description=description,
        event_metadata=dict(event_metadata or {}),
    )
    try:
        db.add(event)
        db.commit()
        db.refresh(event)
        return event
    except SQLAlchemyError:
        db.rollback()
        raise


def create_protected_trial(
    db: Session,
    request: ProtectTrialRequest,
) -> tuple[Trial, VirtualCard]:
    """Create the merchant, trial, card, and initial evidence atomically."""

    merchant_domain = extract_domain(request.source_url)
    trial_days = parse_trial_days(request.trial_duration)
    renewal_amount = parse_amount(request.renewal_amount)
    renewal_date = datetime.now(UTC).replace(tzinfo=None) + timedelta(
        days=trial_days
    )

    try:
        merchant = db.scalar(
            select(Merchant).where(Merchant.domain == merchant_domain)
        )
        if merchant is None:
            merchant = Merchant(
                name=request.provider_name.strip(),
                domain=merchant_domain,
            )
            db.add(merchant)
            db.flush()

        trial = Trial(
            merchant_id=merchant.id,
            trial_days=trial_days,
            renewal_date=renewal_date,
            renewal_amount=renewal_amount,
            currency=request.currency.upper(),
            billing_frequency=request.billing_frequency.lower(),
            risk_score=request.risk_score,
            status="protected",
            cancellation_status="not_started",
        )
        db.add(trial)
        db.flush()

        card = create_virtual_card(
            db,
            trial,
            merchant_domain,
            renewal_amount,
        )

        # Add both evidence rows before the commit so protection is all-or-none.
        db.add_all(
            [
                AuditEvent(
                    trial_id=trial.id,
                    event_type="PROTECTION_ENABLED",
                    description="Simulated trial protection was enabled.",
                    event_metadata={
                        "source_url": request.source_url,
                        "risk_score": request.risk_score,
                        "evidence": request.evidence,
                    },
                ),
                AuditEvent(
                    trial_id=trial.id,
                    event_type="CARD_CREATED",
                    description=(
                        "A simulated merchant-locked virtual card was created."
                    ),
                    event_metadata={
                        "card_id": card.id,
                        "merchant_lock": merchant_domain,
                        "simulation": True,
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
