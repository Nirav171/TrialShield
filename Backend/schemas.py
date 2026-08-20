"""Pydantic request and response schemas for the TrialShield API."""

from datetime import datetime
from enum import Enum
from typing import Any
from urllib.parse import urlparse

from pydantic import BaseModel, ConfigDict, Field, field_validator


def _validate_http_url(value: str) -> str:
    """Accept only absolute HTTP(S) URLs with a hostname."""

    parsed = urlparse(value.strip())
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise ValueError("source_url must be a valid http(s) URL")
    return value.strip()


class HealthCheck(BaseModel):
    status: str = "ok"
    service: str = "TrialShield API"


class TrialPage(BaseModel):
    """Structured trial information extracted by extension/content.js."""

    schema_version: str | None = None
    source_url: str
    provider_name: str = Field(min_length=1, max_length=255)
    page_title: str | None = None
    has_free_trial: bool = False
    trial_start: str | None = None
    trial_duration: str | None = None
    cancellation_terms: str | None = None
    minimum_fee: str | None = None
    payment_method_required: bool | None = None
    auto_renews: bool | None = None
    currency: str | None = None
    evidence: list[str] = Field(default_factory=list)
    analyzed_at: str | None = None

    validate_source_url = field_validator("source_url")(_validate_http_url)


class PageAnalysisResponse(BaseModel):
    trial: TrialPage
    completeness_score: int
    missing_fields: list[str]
    warnings: list[str]


class RiskFactor(BaseModel):
    code: str
    label: str
    points: int
    explanation: str


class RiskLevel(str, Enum):
    low = "low"
    medium = "medium"
    high = "high"
    critical = "critical"


class RiskScoreResponse(BaseModel):
    source_url: str
    provider_name: str
    score: int
    level: RiskLevel
    factors: list[RiskFactor]
    summary: str


class ProtectTrialRequest(BaseModel):
    provider_name: str = Field(min_length=1, max_length=255)
    source_url: str
    trial_duration: str | None = None
    renewal_amount: str | None = None
    currency: str = Field(default="USD", min_length=1, max_length=10)
    billing_frequency: str = Field(default="unknown", min_length=1, max_length=50)
    risk_score: float = Field(default=0.0, ge=0, le=100)
    evidence: list[str] = Field(default_factory=list)

    validate_source_url = field_validator("source_url")(_validate_http_url)


class VirtualCardResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    card_number: str
    expiry_month: int
    expiry_year: int
    cvv: str
    merchant_lock: str
    balance: float
    spend_limit: float
    status: str


class ProtectTrialResponse(BaseModel):
    trial_id: int
    merchant_id: int
    card: VirtualCardResponse
    message: str


class AuditEventResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    trial_id: int
    event_type: str
    description: str
    event_metadata: dict[str, Any]
    timestamp: datetime


class TrialResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    merchant_id: int
    trial_days: int
    renewal_date: datetime
    renewal_amount: float
    currency: str
    billing_frequency: str
    risk_score: float
    status: str
    cancellation_status: str
    created_at: datetime
    virtual_card: VirtualCardResponse | None = None
