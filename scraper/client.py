"""HTTP-клиент. Если API не ответил — возвращает данные из локального архива."""
import json
import time
import logging
from pathlib import Path
import requests

log = logging.getLogger(__name__)

BASE = "https://api.premierliga.ru/api"

HEADERS = {
    "Accept": "*/*",
    "Accept-Language": "ru-RU,ru;q=0.9,en;q=0.8",
    "Content-Type": "application/json",
    "Origin": "https://premierliga.ru",
    "Referer": "https://premierliga.ru/",
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/154.0.0.0 Safari/537.36"
    ),
}


session = requests.Session()
session.headers.update(HEADERS)


def _save_raw(name: str, data) -> None:
    """Сохраняет сырой ответ в один файл на эндпоинт. Перезаписывает только при изменении."""
    raw_dir = Path("data/raw")
    raw_dir.mkdir(parents=True, exist_ok=True)
    
    path = raw_dir / f"{name}.json"
    
    # Если файл есть и данные не изменились — не перезаписываем
    if path.exists():
        try:
            with path.open(encoding="utf-8") as f:
                if json.load(f) == data:
                    return
        except Exception:
            pass
    
    with path.open("w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    log.info(f"Сырой ответ обновлён: {path}")


def get(endpoint: str, retries: int = 3) -> dict | None:
    """GET с retry. При полном провале — None."""
    url = f"{BASE}/{endpoint}"
    for attempt in range(1, retries + 1):
        try:
            r = session.get(url, timeout=15)
            r.raise_for_status()
            data = r.json()
            _save_raw(endpoint, data)
            return data
        except (requests.RequestException, ValueError) as e:
            log.warning(f"GET {endpoint} попытка {attempt}/{retries}: {e}")
            time.sleep(2 ** attempt)
    log.error(f"GET {endpoint}: все попытки провалены")
    return None


def post(endpoint: str, payload: dict, retries: int = 2) -> dict | list | None:
    """POST с retry. 400 → None (payload не подошёл)."""
    url = f"{BASE}/{endpoint}"
    for attempt in range(1, retries + 1):
        try:
            # Принудительно просим сервер закрыть соединение после ответа.
            # Это защищает от того, что ответ для команды 3 "прилипнет" к запросу для команды 4.
            session.headers.update({"Connection": "close"})
            
            r = session.post(url, json=payload, timeout=20)
            if r.status_code == 400:
                return None
            r.raise_for_status()
            data = r.json()
            
            # Сохраняем сырой ответ с ID в имени файла
            name_with_id = f"{endpoint}_{payload.get('club', payload.get('id', 'none'))}"
            if endpoint != "getPlayerProfile":
                _save_raw(name_with_id, data) 
            
            return data
        except (requests.RequestException, ValueError) as e:
            log.warning(f"POST {endpoint} (payload: {payload}) попытка {attempt}/{retries}: {e}")
            time.sleep(2 ** attempt)
    return None


def post_with_fallback(
    endpoint: str,
    candidates: list[dict],
    fallback_path: Path,
) -> tuple[dict | list | None, bool]:
    """
    Пробует payload по очереди. Если все провалились — читает fallback_path.
    """
    for payload in candidates:
        result = post(endpoint, payload)
        if result is not None:
            return result, False  # API ответил, архив не нужен

    # Если API не ответил, проверяем, есть ли локальный файл (в current/)
    # ВАЖНО: fallback_path теперь должен указывать на data/current/
    if fallback_path.exists():
        log.warning(f"{endpoint}: API не ответил, беру локальные данные из {fallback_path}")
        with fallback_path.open(encoding="utf-8") as f:
            return json.load(f), True

    log.error(f"{endpoint}: API не ответил и локальных данных нет")
    return None, False