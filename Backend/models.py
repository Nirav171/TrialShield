"""SQLAlchemy ORM models for TrialShield's local hackathon database."""

from datetime import UTC, datetime
from typing import Any

from sqlalchemy import DateTime, Float, ForeignKey, Integer, JSON, String
from sqlalchemy.orm import Mapped, mapped_column, relationship

try:
    from .database import Base
except ImportError:
    from database import Base


def _utc_now() -> datetime:
    """Return a naive UTC timestamp, which SQLite stores consistently."""

    return datetime.now(UTC).replace(tzinfo=None)


class Merchant(Base):
    """A trial provider identified by its unique website domain."""

    __tablename__ = "merchants"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    domain: Mapped[str] = mapped_column(
        String(255), nullable=False, unique=True, index=True
    )
    category: Mapped[str] = mapped_column(
        String(100), nullable=False, default="uncategorized"
    )
    tags: Mapped[list[str]] = mapped_column(JSON, nullable=False, default=list)
    trust_score: Mapped[float] = mapped_column(Float, nullable=False, default=50.0)
    avg_risk_score: Mapped[float] = mapped_column(
        Float, nullable=False, default=50.0
    )
    verification_amount: Mapped[float] = mapped_column(
        Float, nullable=False, default=0.0
    )
    cancellation_difficulty: Mapped[str] = mapped_column(
        String(50), nullable=False, default="unknown"
    )
    successful_cancellations: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0
    )
    failed_cancellations: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime, nullable=False, default=_utc_now
    )

    trials: Mapped[list["Trial"]] = relationship(
        back_populates="merchant",
        cascade="all, delete-orphan",
    )


class Trial(Base):
    """One locally protected trial enrollment."""

    __tablename__ = "trials"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    merchant_id: Mapped[int] = mapped_column(
        ForeignKey("merchants.id"), nullable=False, index=True
    )
    trial_days: Mapped[int] = mapped_column(Integer, nullable=False, default=7)
    renewal_date: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    renewal_amount: Mapped[float] = mapped_column(
        Float, nullable=False, default=0.0
    )
    currency: Mapped[str] = mapped_column(
        String(10), nullable=False, default="USD"
    )
    billing_frequency: Mapped[str] = mapped_column(
        String(50), nullable=False, default="unknown"
    )
    risk_score: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    status: Mapped[str] = mapped_column(
        String(50), nullable=False, default="protected"
    )
    cancellation_status: Mapped[str] = mapped_column(
        String(50), nullable=False, default="not_started"
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime, nullable=False, default=_utc_now
    )

    merchant: Mapped["Merchant"] = relationship(back_populates="trials")
    virtual_card: Mapped["VirtualCard | None"] = relationship(
        back_populates="trial",
        uselist=False,
        cascade="all, delete-orphan",
        single_parent=True,
    )
    audit_events: Mapped[list["AuditEvent"]] = relationship(
        back_populates="trial",
        cascade="all, delete-orphan",
    )


class VirtualCard(Base):
    """A simulated card record; it is never usable on a payment network."""

    __tablename__ = "virtual_cards"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    trial_id: Mapped[int] = mapped_column(
        ForeignKey("trials.id"), nullable=False, unique=True, index=True
    )
    card_number: Mapped[str] = mapped_column(
        String(16), nullable=False, unique=True
    )
    expiry_month: Mapped[int] = mapped_column(Integer, nullable=False)
    expiry_year: Mapped[int] = mapped_column(Integer, nullable=False)
    cvv: Mapped[str] = mapped_column(String(3), nullable=False)
    merchant_lock: Mapped[str] = mapped_column(String(255), nullable=False)
    balance: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    spend_limit: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    status: Mapped[str] = mapped_column(
        String(50), nullable=False, default="active"
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime, nullable=False, default=_utc_now
    )

    trial: Mapped["Trial"] = relationship(
        back_populates="virtual_card",
        uselist=False,
    )


class AuditEvent(Base):
    """Evidence recorded for a protected-trial lifecycle action."""

    __tablename__ = "audit_events"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    trial_id: Mapped[int] = mapped_column(
        ForeignKey("trials.id"), nullable=False, index=True
    )
    event_type: Mapped[str] = mapped_column(String(100), nullable=False)
    description: Mapped[str] = mapped_column(String, nullable=False)
    # `metadata` is reserved by SQLAlchemy's declarative API. The Python name
    # is event_metadata while the SQLite column is still named metadata.
    event_metadata: Mapped[dict[str, Any]] = mapped_column(
        "metadata", JSON, nullable=False, default=dict
    )
    timestamp: Mapped[datetime] = mapped_column(
        DateTime, nullable=False, default=_utc_now
    )

    trial: Mapped["Trial"] = relationship(back_populates="audit_events")
