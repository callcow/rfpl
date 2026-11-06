"""Запуск импорта. Возвращает exit code для GitHub Actions."""
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
# За сколько до старта ОДИН раз будим скрипт, чтобы подтянуть составы
LINEUPS_LEAD_SEC = 70 * 60          # 70 минут
# За сколько до старта начинаем частые проверки (live-режим)
PRE_MATCH_WINDOW_SEC = 10 * 60      # 10 минут
# Как часто проверять во время матча и в предматчевом окне
LIVE_INTERVAL_SEC = 5 * 60          # 3 минуты
# Как часто проверять после завершения матча
POST_MATCH_WINDOW_SEC = 20 * 60     # 20 минут
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

    Логика на каждый будущий матч:
      1) ОДИН раз за LINEUPS_LEAD_SEC (70 мин) до старта — тянем составы.
      2) Затем тишина до PRE_MATCH_WINDOW_SEC (10 мин) до старта.
      3) С 10-минутного окна и до конца матча — частые проверки каждые LIVE_INTERVAL_SEC.
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

    # 1. Есть live-матч (статус 1/2/3) — частые проверки
    for m in matches:
        if m.get("status") in (1, 2, 3):
            return {
                "next_run": (now + timedelta(seconds=LIVE_INTERVAL_SEC)).isoformat(),
                "reason": f"Матч {m['id']} в прямом эфире",
                "updated_at": now.isoformat(),
            }

    # 2. Собираем будущие матчи (status == 0)
    future = []
    for m in matches:
        if m.get("status") != 0:
            continue
        try:
            start = parse_match_date(m["date"]).astimezone(timezone.utc)
            if start > now:
                future.append((start, m))
        except Exception:
            continue

    if not future:
        return {
            "next_run": (now + timedelta(hours=IDLE_INTERVAL_HOURS)).isoformat(),
            "reason": "Нет будущих матчей в текущем туре",
            "updated_at": now.isoformat(),
        }

    future.sort(key=lambda x: x[0])
    soonest_start, soonest_match = future[0]
    delta = (soonest_start - now).total_seconds()

    # 3. Предматчевое окно (10 мин) или матч уже должен был начаться, но статус ещё 0
    if delta <= PRE_MATCH_WINDOW_SEC:
        return {
            "next_run": (now + timedelta(seconds=LIVE_INTERVAL_SEC)).isoformat(),
            "reason": f"Предматчевое окно: матч {soonest_match['id']} через {int(delta/60)} мин",
            "updated_at": now.isoformat(),
        }

    # 4. Окно составов (70 мин) — будим РОВНО ОДИН раз
    if delta <= LINEUPS_LEAD_SEC:
        window_for = (soonest_start - timedelta(seconds=LINEUPS_LEAD_SEC)).isoformat()

        # читаем next_run.json, чтобы понять, будили ли уже для этого окна
        last_window = None
        if NEXT_RUN_FILE.exists():
            try:
                existing = json.loads(NEXT_RUN_FILE.read_text(encoding="utf-8"))
                last_window = existing.get("lineups_window_for")
            except Exception:
                last_window = None

        if last_window != window_for:
            # Ещё не будили для этого окна — будим сейчас И запоминаем окно
            return {
                "next_run": now.isoformat(),
                "reason": f"Пора тянуть составы для матча {soonest_match['id']} "
                          f"(старт {soonest_start.isoformat()})",
                "updated_at": now.isoformat(),
                "lineups_window_for": window_for,
            }

        # Уже будили — ждём 10-минутного окна
        wake_at = soonest_start - timedelta(seconds=PRE_MATCH_WINDOW_SEC)
        return {
            "next_run": wake_at.isoformat(),
            "reason": f"Составы уже тянули, ждём 10-мин окна для матча {soonest_match['id']}",
            "updated_at": now.isoformat(),
            "lineups_window_for": window_for,
        }

    # 5. До матча ещё далеко (> 70 мин) — планируем пробуждение за 70 мин до старта
    wake_at = soonest_start - timedelta(seconds=LINEUPS_LEAD_SEC)
    window_for = wake_at.isoformat()

    # сохраняем lineups_window_for из старого next_run.json, если он относится к этому же окну
    last_window = None
    if NEXT_RUN_FILE.exists():
        try:
            existing = json.loads(NEXT_RUN_FILE.read_text(encoding="utf-8"))
            last_window = existing.get("lineups_window_for")
        except Exception:
            last_window = None

    result = {
        "next_run": wake_at.isoformat(),
        "reason": f"Ждём окна составов для матча {soonest_match['id']} "
                  f"(старт {soonest_start.isoformat()})",
        "updated_at": now.isoformat(),
    }
    if last_window == window_for:
        result["lineups_window_for"] = last_window
    return result


def write_next_run():
    """Пишет next_run.json в data/current."""
    try:
        data = compute_next_run()

        # сохраняем lineups_window_for из старого файла, если новый его не вернул
        if "lineups_window_for" not in data and NEXT_RUN_FILE.exists():
            try:
                existing = json.loads(NEXT_RUN_FILE.read_text(encoding="utf-8"))
                if "lineups_window_for" in existing:
                    data["lineups_window_for"] = existing["lineups_window_for"]
            except Exception:
                pass

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
