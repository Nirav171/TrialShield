"""Database setup for the local TrialShield demo."""

from collections.abc import Generator
import os
from pathlib import Path

from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker
from sqlalchemy.pool import StaticPool


# The repository contains an older database.db with a different table layout.
# Use a new filename so the safe refactor never overwrites that existing data.
DATABASE_PATH = Path(__file__).resolve().parent / "trialshield.db"
DATABASE_URL = os.getenv(
    "TRIALSHIELD_DATABASE_URL",
    f"sqlite:///{DATABASE_PATH.as_posix()}",
)

# Tests commonly use an in-memory SQLite database. StaticPool makes the same
# in-memory connection visible to FastAPI's worker threads.
if DATABASE_URL == "sqlite:///:memory:":
    engine = create_engine(
        DATABASE_URL,
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
else:
    engine = create_engine(
        DATABASE_URL,
        connect_args={"check_same_thread": False}
        if DATABASE_URL.startswith("sqlite")
        else {},
    )

SessionLocal = sessionmaker(
    bind=engine,
    class_=Session,
    autoflush=False,
    expire_on_commit=False,
)


class Base(DeclarativeBase):
    """Declarative base shared by every TrialShield ORM model."""


def get_db() -> Generator[Session, None, None]:
    """Provide one database session per request and always close it."""

    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def create_db() -> None:
    """Import the ORM models, then create any missing demo tables."""

    # Importing models registers its four tables on Base.metadata. Keeping this
    # import local avoids putting ORM declarations in the database setup file.
    try:
        from . import models  # noqa: F401
    except ImportError:
        import models  # type: ignore[no-redef]  # noqa: F401

    Base.metadata.create_all(bind=engine)
