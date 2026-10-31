"""Валидация ответов API. Если структура изменилась — падаем с понятной ошибкой."""
from pydantic import BaseModel, Field, ValidationError
from typing import Optional
from datetime import datetime
import logging

log = logging.getLogger(__name__)


class InitResponse(BaseModel):
    currentTournament: int
    currentStage: Optional[int] = None


class Club(BaseModel):
    id: int
    name: str
    city: Optional[str] = None
    logo: Optional[str] = None
    color: Optional[str] = None
    nameShort: Optional[str] = None


class Stage(BaseModel):
    id: int
    name: str
    # добавь поля по факту


class Match(BaseModel):
    id: int
    date: str
    status: int
    clubH: int
    clubA: int
    goalH: Optional[int] = None
    goalA: Optional[int] = None
    city: Optional[str] = None
    stadium: Optional[str] = None


class MatchBlock(BaseModel):
    stage: int
    matches: list[Match]


def validate_init(data: dict) -> InitResponse:
    try:
        return InitResponse(**data)
    except ValidationError as e:
        log.error(f"init.json не прошёл валидацию: {e}")
        raise


def validate_clubs(data: list) -> list[Club]:
    try:
        return [Club(**c) for c in data]
    except ValidationError as e:
        log.error(f"getClubs не прошёл валидацию: {e}")
        raise


def validate_stages(data: list) -> list[Stage]:
    try:
        return [Stage(**s) for s in data]
    except ValidationError as e:
        log.error(f"getStages не прошёл валидацию: {e}")
        raise


def validate_matches(data: list) -> list[MatchBlock]:
    try:
        return [MatchBlock(**b) for b in data]
    except ValidationError as e:
        log.error(f"getMatches не прошёл валидацию: {e}")
        raise