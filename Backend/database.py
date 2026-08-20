"""TrialShield SQLAlchemy 2.0 database setup and ORM models."""

from collections.abc import Generator
from datetime import datetime
from pathlib import Path
from typing import Any, Optional

from sqlalchemy import DateTime, Float, ForeignKey, Integer, JSON, String, create_engine
from sqlalchemy.orm import (
    DeclarativeBase,
    Mapped,
    Session,
    mapped_column,
    relationship,
    sessionmaker,
)
//dfd

DATABASE_PATH = Path(__file__).resolve().parent / "database.db"
DATABASE_URL = f"sqlite:///{DATABASE_PATH.as_posix()}"

engine = create_engine(
    DATABASE_URL,
    connect_args={"check_same_thread": False},
)

SessionLocal = sessionmaker(
    bind=engine,
    class_=Session,
    autoflush=False,
    expire_on_commit=False,
)


class Base(DeclarativeBase):
    """Declarative base shared by all TrialShield tables."""


class Merchant(Base):
    """A website or service that offers protected free trials."""

    __tablename__ = "merchants"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    domain: Mapped[str] = mapped_column(String(255), nullable=False, unique=True)
    category: Mapped[str] = mapped_column(
        String(100), nullable=False, default="uncategorized"
    )
    trust_score: Mapped[float] = mapped_column(Float, nullable=False, default=50.0)
    avg_risk_score: Mapped[float] = mapped_column(Float, nullable=False, default=50.0)
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
        DateTime, nullable=False, default=datetime.utcnow
    )

    # One merchant has many protected trials.
    trials: Mapped[list["Trial"]] = relationship(
        back_populates="merchant",
        cascade="all, delete-orphan",
    )


class Trial(Base):
    """One protected free-trial enrollment."""

    __tablename__ = "trials"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    merchant_id: Mapped[int] = mapped_column(
        ForeignKey("merchants.id"), nullable=False, index=True
    )
    trial_days: Mapped[int] = mapped_column(Integer, nullable=False)
    renewal_date: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    renewal_amount: Mapped[float] = mapped_column(
        Float, nullable=False, default=0.0
    )
    currency: Mapped[str] = mapped_column(
        String(10), nullable=False, default="USD"
    )
    billing_frequency: Mapped[str] = mapped_column(
        String(50), nullable=False, default="monthly"
    )
    risk_score: Mapped[float] = mapped_column(Float, nullable=False, default=50.0)
    status: Mapped[str] = mapped_column(
        String(50), nullable=False, default="active"
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime, nullable=False, default=datetime.utcnow
    )

    # Many trials belong to one merchant.
    merchant: Mapped["Merchant"] = relationship(back_populates="trials")

    # One trial has at most one virtual card. VirtualCard.trial_id is unique,
    # which enforces the one-to-one relationship at the database level.
    virtual_card: Mapped[Optional["VirtualCard"]] = relationship(
        back_populates="trial",
        uselist=False,
        cascade="all, delete-orphan",
        single_parent=True,
    )

    # One trial has many lifecycle audit events.
    audit_events: Mapped[list["AuditEvent"]] = relationship(
        back_populates="trial",
        cascade="all, delete-orphan",
    )


class VirtualCard(Base):
    """A simulated merchant-bound virtual card for exactly one trial."""

    __tablename__ = "virtual_cards"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    trial_id: Mapped[int] = mapped_column(
        ForeignKey("trials.id"), nullable=False, unique=True
    )
    merchant_lock: Mapped[str] = mapped_column(String(255), nullable=False)
    balance: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    spend_limit: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    status: Mapped[str] = mapped_column(
        String(50), nullable=False, default="active"
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime, nullable=False, default=datetime.utcnow
    )

    # Each virtual card belongs to exactly one trial.
    trial: Mapped["Trial"] = relationship(
        back_populates="virtual_card",
        uselist=False,
    )


class AuditEvent(Base):
    """An event recorded during a trial's lifecycle."""

    __tablename__ = "audit_events"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    trial_id: Mapped[int] = mapped_column(
        ForeignKey("trials.id"), nullable=False, index=True
    )
    event_type: Mapped[str] = mapped_column(String(100), nullable=False)
    description: Mapped[str] = mapped_column(String, nullable=False)
    # SQLAlchemy reserves the declarative attribute name `metadata`. The Python
    # attribute is `event_metadata`, while the database column remains `metadata`.
    event_metadata: Mapped[dict[str, Any]] = mapped_column(
        "metadata", JSON, nullable=False, default=dict
    )
    timestamp: Mapped[datetime] = mapped_column(
        DateTime, nullable=False, default=datetime.utcnow
    )

    # Many audit events belong to one trial.
    trial: Mapped["Trial"] = relationship(back_populates="audit_events")


def get_db() -> Generator[Session, None, None]:
    """Yield a database session and guarantee that it is closed afterward."""

    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def create_db() -> None:
    """Create the four TrialShield tables if they do not already exist."""

    Base.metadata.create_all(bind=engine)
