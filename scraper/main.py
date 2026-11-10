import json
import logging
import sys
from datetime import datetime, timezone, timedelta
from pathlib import Path

from importer import import_all

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
)
log = logging.getLogger(__name__)

CURRENT_DIR = Path("data/frontend")
NEXT_RUN_FILE = CURRENT_DIR / "next_run.json"

# ─── Настройки «умного» расписания ───
# Сколько секунд до старта матча начинать частые проверки
PRE_MATCH_WINDOW_SEC = 70 * 60      # 70 минут
# Как часто проверять во время матча (в секундах)
LIVE_INTERVAL_SEC = 2 * 60          # 3 минут
# Как часто проверять после завершения матча (чтобы поймать обновление статуса)
POST_MATCH_WINDOW_SEC = 1 * 60     # 1 минут
# Как часто проверять «на всякий случай», когда матчей нет
IDLE_INTERVAL_HOURS = 6


def parse_match_date(s: str) -> datetime:
    """'2026-10-31UTC17:30:00' -> aware datetime (МСК)."""
    # Заменяем UTC на +03:00 (МСК)
    iso = s.replace("UTC", "T") + "+03:00"
    return datetime.fromisoformat(iso)


def compute_next_run() -> dict:
    """
    Смотрит current_tour.json и решает, когда в следующий раз будить GitHub Actions.
    Возвращает dict для записи в next_run.json.
    """
    tour_file = CURRENT_DIR / "current_tour.json"
    if not tour_file.exists():
        return {
            "next_run": None,
            "reason": "current_tour.json отсутствует",
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }

    tour = json.loads(tour_file.read_text(encoding="utf-8"))
    matches = tour.get("matches", [])
    now = datetime.now(timezone.utc)

    # 1. Есть ли live-матч (статус 1/2/3)?
    for m in matches:
        if m.get("status") in (1, 2, 3):
            next_dt = now + timedelta(seconds=LIVE_INTERVAL_SEC)
            return {
                "next_run": next_dt.isoformat(),
                "reason": f"Матч {m['id']} в прямом эфире",
                "updated_at": now.isoformat(),
            }

    # 2. Есть ли матч, который скоро начнётся (в пределах PRE_MATCH_WINDOW_SEC)?
    soonest_start = None
    soonest_match = None
    for m in matches:
        if m.get("status") != 0:
            continue
        try:
            start = parse_match_date(m["date"]).astimezone(timezone.utc)
        except Exception:
            continue
        delta = (start - now).total_seconds()
        # Матч начнётся в пределах 10 минут или уже должен был начаться
        if -POST_MATCH_WINDOW_SEC <= delta <= PRE_MATCH_WINDOW_SEC:
            if soonest_start is None or start < soonest_start:
                soonest_start = start
                soonest_match = m

    if soonest_start is not None:
        next_dt = now + timedelta(seconds=LIVE_INTERVAL_SEC)
        return {
            "next_run": next_dt.isoformat(),
            "reason": f"Матч {soonest_match['id']} начнётся {soonest_start.isoformat()}",
            "updated_at": now.isoformat(),
        }

    # 3. Есть ли ближайший будущий матч — ставим проверку за 10 минут до старта
    future_matches = []
    for m in matches:
        if m.get("status") != 0:
            continue
        try:
            start = parse_match_date(m["date"]).astimezone(timezone.utc)
            if start > now:
                future_matches.append((start, m))
        except Exception:
            continue

    if future_matches:
        future_matches.sort(key=lambda x: x[0])
        soonest_start, soonest_match = future_matches[0]
        # Будим за PRE_MATCH_WINDOW_SEC до старта (минимум через 5 минут)
        wake_at = max(now + timedelta(seconds=LIVE_INTERVAL_SEC),
                      soonest_start - timedelta(seconds=PRE_MATCH_WINDOW_SEC))
        return {
            "next_run": wake_at.isoformat(),
            "reason": f"Ближайший матч {soonest_match['id']} в {soonest_start.isoformat()}",
            "updated_at": now.isoformat(),
        }

    # 4. Матчей нет — проверяем раз в IDLE_INTERVAL_HOURS
    next_dt = now + timedelta(hours=IDLE_INTERVAL_HOURS)
    return {
        "next_run": next_dt.isoformat(),
        "reason": "Нет будущих матчей в текущем туре",
        "updated_at": now.isoformat(),
    }


def write_next_run():
    """Пишет next_run.json в data/current."""
    try:
        data = compute_next_run()
        NEXT_RUN_FILE.parent.mkdir(parents=True, exist_ok=True)
        NEXT_RUN_FILE.write_text(
            json.dumps(data, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        log.info(f"next_run.json: {data.get('reason')} → {data.get('next_run')}")
    except Exception as e:
        log.error(f"Не удалось записать next_run.json: {e}")


def main() -> int:
    log.info("=== Начало импорта ===")
    status = import_all()
    log.info(f"Статус: {status}")

    if status["errors"]:
        log.error(f"Ошибки: {status['errors']}")
        if not status.get("current_season"):
            return 1

    if not status["api_ok"]:
        log.warning(f"Использован архив для: {status['from_archive']}")

    # Вычисляем, когда будить в следующий раз
    write_next_run()

    log.info("=== Импорт завершён ===")
    return 0


if __name__ == "__main__":
    sys.exit(main())