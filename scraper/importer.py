"""Импорт данных с детектом нового сезона и архивацией старого."""
import functools
import json
import logging
import re
import requests


from pathlib import Path
from datetime import datetime, timezone, timedelta

import time
from client import get, post, post_with_fallback
from validator import (
    validate_init, validate_clubs, validate_stages, validate_matches,
)

log = logging.getLogger(__name__)

TEAM_RENAMES = {
    "Динамо-Москва": "Динамо М",
    "Спартак-Москва": "Спартак",
    "Динамо Махачкала": "Динамо Мх",
    "ПФК ЦСКА": "ЦСКА"
}

def format_team_name(name):
    if not name:
        return "?"
    return TEAM_RENAMES.get(name, name)

def _clean_club_profile(raw: dict) -> dict:
    """Оставляет только безопасные и нужные фронтенду поля."""
    return {
        "id": raw.get("id"),
        "name": raw.get("name"),
        "nameShort": raw.get("nameShort"),
        "year": raw.get("year"),
        "city": raw.get("city"),
        "color": raw.get("color"),
        "logo": raw.get("logo"),
        "site": raw.get("site"),
        "phone": raw.get("phone"),
        "email": raw.get("email"),
        "address": raw.get("address"),
        "achievements": raw.get("achievements"),
        "socials": {
            "telegram": raw.get("socials", {}).get("telegram"),
            "vkontakte": raw.get("socials", {}).get("vkontakte"),
            "youtube": raw.get("socials", {}).get("youtube"),
        }
    }


def _clean_countries(raw: list | dict) -> list:
    """
    Оставляет только нужные поля для фронтенда (id, name, iso, flag).
    Работает и со списком стран, и с одиночным объектом.
    """
    if raw is None:
        return []

    items = raw if isinstance(raw, list) else [raw]
    result = []
    for c in items:
        if not isinstance(c, dict):
            continue
        result.append({
            "id": c.get("id"),
            "name": c.get("name"),
            "iso": c.get("iso") or c.get("code") or c.get("shortName"),
            "flag": c.get("flag") or c.get("flagUrl"),
        })
    return result


def _translit(text: str) -> str:
    """Переводит кириллицу в латиницу для безопасных имен папок и URL."""
    ru = "абвгдеёжзийклмнопрстуфхцчшщъыьэюя"
    en = "a b v g d e e zh z i y k l m n o p r s t u f h ts ch sh sch _ y _ e yu ya".split()
    mapping = {ord(r): e for r, e in zip(ru, en)}
    mapping.update({ord('ъ'): '', ord('ь'): ''})
    res = text.lower().translate(mapping)
    # Оставляем только латиницу, цифры и дефисы/подчёркивания
    return "".join(c for c in res if c.isascii() and (c.isalnum() or c in "-_")).strip()

# Автоматическое создание нужных папок при запуске
DATA_DIR = Path("data")
CURRENT_DIR = DATA_DIR / "frontend"   # всё, что читает сайт
INTERNAL_DIR = DATA_DIR / "internal"  # только для скрапера
ARCHIVE_DIR = DATA_DIR / "archive"
SEASONS_FILE = DATA_DIR / "seasons.json"
META_FILE = DATA_DIR / "meta.json"

# Принудительно создаем папки, если их нет
CURRENT_DIR.mkdir(parents=True, exist_ok=True)
ARCHIVE_DIR.mkdir(parents=True, exist_ok=True)
(DATA_DIR / "frontend").mkdir(parents=True, exist_ok=True)


def _is_stale(path: Path, days: int) -> bool:
    """True, если файла нет или он старше N дней."""
    if not path.exists():
        return True
    age = time.time() - path.stat().st_mtime
    return age > days * 24 * 3600

def _events_missing_final(path: Path) -> bool:
    """True, если файла событий нет или в broadcast нет окончания 2-го тайма."""
    try:
        broadcast = json.loads(path.read_text(encoding="utf-8")).get("broadcast") or []
    except Exception:
        return True
    return not any(
        e.get("type") == "GamePeriodEnd" and e.get("periodNumber") == 2
        for e in broadcast
    )


def _saved_status(path: Path):
    """Возвращает status из сохранённого файла матча или None, если файла нет / он битый."""
    try:
        return json.loads(path.read_text(encoding="utf-8")).get("status")
    except Exception:
        return None


def _load_json(path: Path, default=None):
    if path.exists():
        with path.open(encoding="utf-8") as f:
            return json.load(f)
    return default


def _save_json(path: Path, data) -> None:
    """Сохраняет файл, только если данные изменились."""
    # Проверяем, существует ли файл и совпадают ли данные
    if path.exists():
        try:
            existing = json.loads(path.read_text(encoding="utf-8"))
            if existing == data:
                # Данные идентичны — ничего не делаем (не перезаписываем)
                return
        except Exception:
            pass  # Если файл битый, перезапишем его
    
    # Если файла нет или данные новые — сохраняем
    path.parent.mkdir(parents=True, exist_ok=True)
    
    # Функция для рекурсивного удаления переменных с CDN-ссылками
    def clean_cdn(obj):
        if isinstance(obj, dict):
            return {k: clean_cdn(v) for k, v in obj.items() 
                    if not (isinstance(v, str) and "https://cdn.premierliga.ru/" in v)}
        elif isinstance(obj, list):
            return [clean_cdn(item) for item in obj]
        return obj
    
    # Очищаем данные от CDN-ссылок
    cleaned_data = clean_cdn(data)
    
    with path.open("w", encoding="utf-8") as f:
        json.dump(cleaned_data, f, ensure_ascii=False, indent=2)
    log.info(f"Сохранено (были изменения): {path}")


def _season_data(tournament_id: int, tournaments: list | None) -> dict:
    """Возвращает ID папки (латиница) и красивое имя (кириллица)."""
    raw_name = f"Сезон {tournament_id}"
    short_name = f"season-{tournament_id}"
    
    if tournaments:
        for t in tournaments:
            if t.get("id") == tournament_id:
                # Берем nameForSelect (например "2026/27")
                nfs = t.get("nameForSelect")
                if nfs:
                    raw_name = f"Сезон {nfs.replace('/', '/')}"
                    short_name = f"rpl-{nfs.replace('/', '-')}" # rpl-2026-27
                else:
                    raw_name = t.get("name") or raw_name
                    short_name = _translit(raw_name)
                break
                
    return {
        "id": short_name,      # Для папки и URL (rpl-2026-27)
        "name": raw_name       # Для отображения на сайте
    }


def _archive_current_season(current_season: dict) -> None:
    """Копирует ВСЁ дерево data/current в data/archive/<season_name>/ (мерж, без перезаписи)."""
    import shutil

    season_name = current_season.get("id", current_season.get("name"))
    target = ARCHIVE_DIR / season_name

    if target.exists():
        log.info(f"Архив {target} уже есть — досоздаю недостающие файлы")
    else:
        target.mkdir(parents=True, exist_ok=True)

    copied = 0
    for src in CURRENT_DIR.rglob("*"):
        if not src.is_file():
            continue
        rel = src.relative_to(CURRENT_DIR)
        dst = target / rel
        if dst.exists():
            continue  # не перезаписываем уже заархивированное
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dst)
        copied += 1

    log.info(f"Сезон {season_name}: заархивировано файлов: {copied} → {target}")
    if (target / "players_all.json").exists():
        log.info(f"Справочник игроков заархивирован: {target / 'players_all.json'}")


def _find_current_stage(matches_raw: list) -> int | None:
    """Возвращает ID текущего тура (ближайшего к now() среди незавершённых)."""
    now = datetime.now()
    best_stage = None
    min_diff = float('inf')

    for block in matches_raw:
        stage_id = block.get("stage")
        block_matches = block.get("matches", [])
        if not block_matches:
            continue

        has_unfinished = any(m.get("status") != 4 for m in block_matches)
        if not has_unfinished:
            continue

        try:
            first_date_str = block_matches[0]["date"].replace("UTC", " ")
            first_date = datetime.strptime(first_date_str[:19], "%Y-%m-%d %H:%M:%S")
            # Берём самый ранний тур с незавершёнными матчами (тур не сменится, пока есть статус != 4)
            diff = first_date.timestamp()
            if diff < min_diff:
                min_diff = diff
                best_stage = stage_id
        except Exception as e:
            log.warning(f"Ошибка парсинга даты тура {stage_id}: {e}")
            if best_stage is None:
                best_stage = stage_id

    return best_stage


def import_all() -> dict:
    """
    Главная функция импорта.
    Возвращает dict со статусом.
    """
    status = {"api_ok": True, "from_archive": [], "errors": [], "warnings": []}

    # ─── 1. init ───
    init_raw = get("init")
    if init_raw is None:
        # Fallback: берём текущий сезон из seasons.json
        seasons = _load_json(SEASONS_FILE, [])
        current_season = next((s for s in seasons if s.get("is_current")), None)
        if current_season:
            log.warning("init: API не ответил, беру tournament_id из seasons.json")
            init_raw = {"currentTournament": current_season["tournament_id"]}
            status["from_archive"].append("init")
            status["api_ok"] = False
        else:
            status["errors"].append("init недоступен и нет fallback в seasons.json")
            return status

    try:
        init = validate_init(init_raw)
    except Exception as e:
        status["errors"].append(f"init validation: {e}")
        return status

    # meta больше не хранит last_init — только диагностику
    meta = _load_json(META_FILE, {})
    meta.pop("last_init", None)
    meta["last_updated"] = datetime.now(timezone.utc).isoformat()
    _save_json(META_FILE, meta)

    tournament_id = init.currentTournament
    log.info(f"Текущий турнир (сезон): {tournament_id}")

    # ─── 2. Реестр сезонов ───
    seasons = _load_json(SEASONS_FILE, [])
    current = next((s for s in seasons if s.get("is_current")), None)

    if current is None or current.get("tournament_id") != tournament_id:
        # НОВЫЙ СЕЗОН!
        log.info(f"Обнаружен новый сезон: {tournament_id}")
        if current:
            _archive_current_season(current)
            current["is_current"] = False
            current["is_archived"] = True

            # Чистим current/ от данных прошлого сезона, чтобы не смешивать
            import shutil
            for sub in ("clubs_data", "matches"):
                p = CURRENT_DIR / sub
                if p.exists():
                    shutil.rmtree(p, ignore_errors=True)
            for fname in (
                "current_tour.json", 
                "matches_flat.json", 
                "standings.json",
                "players_all.json",  # <--- Добавили: удаляем после архивации
            ):
                p = CURRENT_DIR / fname
                if p.exists():
                    p.unlink()
            log.info("Очищены clubs_data/, matches/, current_tour.json, matches_flat.json, standings.json, players_all.json")

        # Пробуем достать имя
        tournaments_raw = None
        from_arch = False
        try:
            tournaments_raw, from_arch = post_with_fallback(
                "getTournaments",
                [{"type": 1, "clubsData": True}],
                INTERNAL_DIR / "getTournaments.json",
            )
            if from_arch:
                status["from_archive"].append("getTournaments")
        except Exception as e:
            log.warning(f"Не удалось скачать getTournaments: {e}")

        if tournaments_raw is not None and not from_arch:
            _save_json(INTERNAL_DIR / "getTournaments.json", tournaments_raw)

        s_data = _season_data(tournament_id, tournaments_raw)
        new_season = {
            "tournament_id": tournament_id,
            "id": s_data["id"],          # <--- Добавили ID (rpl-2026-27)
            "name": s_data["name"],      # <--- Красивое имя для сайта
            "is_current": True,
            "is_archived": False,
            "created_at": datetime.now(timezone.utc).isoformat(),
        }
        seasons = [s for s in seasons if s.get("tournament_id") != tournament_id]
        seasons.append(new_season)
        _save_json(SEASONS_FILE, seasons)
        current = new_season

    # ─── 3. Справочники (клубы, туры) ───
      # Если API упадет, мы будем искать данные в текущей рабочей папке
    season_archive = INTERNAL_DIR 

    clubs_raw, fa = post_with_fallback(
        "getClubs",
        [{"tournament": tournament_id}, {"tournamentId": tournament_id}],
        season_archive / "getClubs.json",
    )
    if fa:
        status["from_archive"].append("getClubs")
    if clubs_raw:
        try:
            # Сохраняем сырой ответ отдельно — он нужен для fallback (с URL логотипов)
            if not fa:
                _save_json(season_archive / "getClubs.json", clubs_raw)

            clubs = validate_clubs(clubs_raw)
            clubs_list = [c.model_dump() for c in clubs]
            
            # Создаем папку для логотипов
            logos_dir = CURRENT_DIR / "logos"
            logos_dir.mkdir(parents=True, exist_ok=True)
            # Создаем папку для данных клубов
            clubs_data_dir = CURRENT_DIR / "clubs_data"
            clubs_data_dir.mkdir(parents=True, exist_ok=True)
            
            log.info("Начинаю скачивание логотипов и данных клубов...")
            all_stadiums_dict = {}
            stadiums_file = CURRENT_DIR / "stadiums.json"
            prev_stadiums = _load_json(stadiums_file, {})
            stadiums_stale = _is_stale(stadiums_file, days=30)
            for c in clubs_list:
                club_id = c["id"]
                
                # ─── Скачивание логотипа ───
                if c.get("logo"):
                    logo_url = c["logo"]
                    filename = logo_url.split("/")[-1]
                    filepath = logos_dir / filename
                    
                    if not filepath.exists():
                        try:
                            img_res = requests.get(logo_url, timeout=10)
                            img_res.raise_for_status()
                            with open(filepath, "wb") as f:
                                f.write(img_res.content)
                            log.info(f"Скачан логотип: {filename}")
                        except Exception as e:
                            log.warning(f"Не удалось скачать логотип {logo_url}: {e}")
                    
                    c["logo"] = f"logos/{filename}"

                # ─── Скачивание профиля клуба, игроков и тренеров ───
                club_dir = clubs_data_dir / str(club_id)
                club_dir.mkdir(parents=True, exist_ok=True)
                
                profile_file = club_dir / "profile.json"
                stadium_file = club_dir / "stadium.json"
                players_file = INTERNAL_DIR / "clubs_data" / str(club_id) / "players.json"
                staffs_file = INTERNAL_DIR / "clubs_data" / str(club_id) / "staffs.json"
                
                # Профиль и стадион — обновляем раз в 30 дней
                clean_profile_file = DATA_DIR / "frontend" / "clubs_data" / str(club_id) / "club_profile.json"
                if _is_stale(clean_profile_file, days=30):
                    log.info(f"Скачиваю профиль клуба {club_id}...")
                    profile_raw = post("getClubProfile", {"id": club_id})
                    if profile_raw:
                        # Сырой профиль не сохраняем: сайт читает только club_profile.json из frontend/
                        
                        # 2. Создаем чистый для фронтенда в отдельной папке
                        frontend_club_dir = DATA_DIR / "frontend" / "clubs_data" / str(club_id)
                        frontend_club_dir.mkdir(parents=True, exist_ok=True)
                        
                        clean_file = frontend_club_dir / "club_profile.json"
                        
                        # Заодно подменим ссылку на логотип, чтобы она вела на наш локальный файл
                        clean_data = _clean_club_profile(profile_raw)
                        if c.get("logo"):
                            clean_data["logo"] = f"logos/{c['logo'].split('/')[-1]}"
                            
                        _save_json(clean_file, clean_data)
                    time.sleep(0.5)
                
                if stadiums_stale or str(club_id) not in prev_stadiums:
                    stadium_raw = post("getClubStadium", {"id": club_id})
                    if stadium_raw:
                        all_stadiums_dict[str(club_id)] = stadium_raw
                    time.sleep(0.5)
                
                # Год основания берём из очищенного профиля (он нужен для clubs.json)
                c["year"] = _load_json(DATA_DIR / "frontend" / "clubs_data" / str(club_id) / "club_profile.json", {}).get("year")

                # Добавляем стадион в общий словарь для быстрой загрузки на фронте
                if str(club_id) not in all_stadiums_dict and prev_stadiums.get(str(club_id)):
                    try:
                        stadium_data = prev_stadiums[str(club_id)]
                        if stadium_data and stadium_data.get("name"):
                            all_stadiums_dict[str(club_id)] = stadium_data
                    except Exception as e:
                        log.warning(f"Не удалось прочитать стадион для клуба {club_id}: {e}")
                
                # Игроки — раз в 7 дней
                if _is_stale(players_file, days=5):
                    log.info(f"Скачиваю игроков клуба {club_id}...")
                    players_raw = post("getClubPlayers", {"tournament": tournament_id, "club": club_id})
                    if players_raw:
                        if isinstance(players_raw, list):
                            players_raw = [{k: v for k, v in p.items() if k not in ("photo", "photoBig")} for p in players_raw]
                        _save_json(players_file, players_raw)
                    time.sleep(0.5)
                
                # Тренеры — раз в 5 дней
                if _is_stale(staffs_file, days=5):
                    log.info(f"Скачиваю тренеров клуба {club_id}...")
                    staffs_raw = post("getClubStaffs", {"tournament": tournament_id, "club": club_id})
                    
                    # Проверяем, есть ли уже данные в файле (ваши ручные правки)
                    existing = []
                    if staffs_file.exists():
                        try:
                            existing = json.loads(staffs_file.read_text(encoding="utf-8"))
                        except Exception:
                            pass

                    # ЛОГИКА ЗАЩИТЫ РУЧНЫХ ПРАВОК:
                    # Если API вернул пустоту/ошибку, НО в файле уже есть данные — оставляем файл как есть!
                    if not staffs_raw:
                        if isinstance(existing, list) and len(existing) > 0:
                            log.warning(
                                f"Тренеры для клуба {club_id}: API отдал пустоту, "
                                f"НО в файле есть ручные данные ({len(existing)} чел.). Оставляю файл без изменений."
                            )
                        else:
                            log.warning(
                                f"Тренеры для клуба {club_id} недоступны в API и файл пуст. Сохраняю пустой список."
                            )
                            _save_json(staffs_file, [])
                            status["warnings"].append(
                                f"Клуб {club_id}: тренеры недоступны в API"
                            )
                    else:
                        # API вернул данные! (Скорее всего, вы их там обновили)
                        # Внимание: если вы хотите, чтобы скрипт НИКОГДА не затирал ручные данные, 
                        # даже когда API что-то отдает, можно дописать сюда проверку:
                        # if existing and len(existing) > 0 and len(staffs_raw) < len(existing): ...
                        # Но пока оставим так: если API отдает данные — сохраняем их.
                        _save_json(staffs_file, staffs_raw)
                        log.info(f"Тренеры для клуба {club_id} успешно обновлены из API.")
                        
                    time.sleep(1)
            
            # Сохраняем общий файл со стадионами
            all_stadiums_dict = {k: {f: v for f, v in s.items() if f != "photo"} for k, s in all_stadiums_dict.items()}
            _save_json(CURRENT_DIR / "stadiums.json", all_stadiums_dict)
            
            # Сохраняем обновленный clubs.json с локальными путями
            _save_json(CURRENT_DIR / "clubs.json", clubs_list)
            _build_player_profiles(clubs_list, status)

                        # ─── Создаем единый справочник игроков (players_all.json) ───
            log.info("Создаю единый справочник игроков...")
            players_all_file = CURRENT_DIR / "players_all.json"

            if not _is_stale(players_all_file, days=30):
                log.info("Справочник players_all.json свежий (менее 30 дней), пропускаю.")
            else:
                all_players_dict = {}
                
                # 1. Собираем базовые данные из players.json клубов
                for c in clubs_list:
                    club_id = c["id"]
                    players_file = INTERNAL_DIR / "clubs_data" / str(club_id) / "players.json"
                    if players_file.exists():
                        try:
                            players_list = json.loads(players_file.read_text(encoding="utf-8"))
                            if isinstance(players_list, list):
                                for p in players_list:
                                    if p.get("id"):
                                        all_players_dict[str(p["id"])] = p
                        except Exception as e:
                            log.warning(f"Не удалось прочитать players.json для клуба {club_id}: {e}")

                # 1.5. Собираем ID из lineups (для тех, кто ушёл)
                lineups_dir = CURRENT_DIR / "matches"
                all_lineup_ids = set()
                if lineups_dir.exists():
                    for lineup_file in lineups_dir.glob("lineups_*.json"):
                        try:
                            lineups_data = json.loads(lineup_file.read_text(encoding="utf-8"))
                            protocol = lineups_data.get("protocol") or lineups_data
                            for side in ("clubH", "clubA"):
                                club_data = protocol.get(side) or {}
                                for p in club_data.get("players", []):
                                    if p.get("id"):
                                        all_lineup_ids.add(p["id"])
                        except Exception:
                            pass

                log.info(f"Игроков из players.json: {len(all_players_dict)}, из lineups: {len(all_lineup_ids)}")

                # 2. Обогащаем через getPlayerProfile только тех, кого нет в players.json (т.е. ушедших из клуба)
                enriched = 0
                
                # Игроки, которых нет в players.json (только из lineups)
                missing_ids = all_lineup_ids - set(int(k) for k in all_players_dict.keys() if k.isdigit())
                
                log.info(f"Игроков, которых нет в players.json (нужен getPlayerProfile): {len(missing_ids)}")
                
                for pid in missing_ids:
                    pid_str = str(pid)
                    
                    try:
                        profile_raw = post("getPlayerProfile", {"id": int(pid)})
                        if profile_raw and isinstance(profile_raw, dict):
                            # Сохраняем в общий словарь
                            all_players_dict[pid_str] = profile_raw
                            enriched += 1
                        time.sleep(0.2)
                    except Exception as e:
                        log.warning(f"Ошибка профиля {pid}: {e}")
                
                log.info(f"Обогащено профилей (ушедших игроков): {enriched}")
                
                # ─── Защита от перезаписи неполными данными ───
                existing_players = _load_json(players_all_file, {})
                existing_count = len(existing_players) if isinstance(existing_players, dict) else 0
                new_count = len(all_players_dict)

                if new_count == 0:
                    log.warning("Справочник игроков пуст — НЕ перезаписываю существующий файл.")
                    status["warnings"].append("players_all.json: пустой результат, файл не перезаписан")
                elif existing_count > 0 and new_count < existing_count * 0.8:
                    # Если новый справочник меньше старого на 20%+ — считаем это подозрительным
                    log.warning(
                        f"Новый справочник ({new_count}) меньше старого ({existing_count}) "
                        f"более чем на 20% — НЕ перезаписываю."
                    )
                    status["warnings"].append(
                        f"players_all.json: новый ({new_count}) < старый ({existing_count}) на 20%+, файл не перезаписан"
                    )
                else:
                    all_players_dict = {k: {f: v for f, v in p.items() if f not in ("photo", "photoBig")} for k, p in all_players_dict.items()}
                    _save_json(players_all_file, all_players_dict)
                    log.info(f"Справочник игроков сохранен: {new_count} записей (было: {existing_count}).")

        except Exception as e:
            status["errors"].append(f"getClubs validation: {e}")

    # ─── 3.1. Страны (getCountry) ───
    countries_file = CURRENT_DIR / "countries.json"
    countries_frontend_dir = DATA_DIR / "frontend" / "countries"
    countries_frontend_file = countries_frontend_dir / "countries.json"

    if _is_stale(countries_frontend_file, days=30):
        log.info("Скачиваю страны (getCountry)...")
        countries_raw = post("getCountry", {})
        if countries_raw:
            # Сырой countries.json не сохраняем: сайт читает только frontend/countries/countries.json
            countries_frontend_dir.mkdir(parents=True, exist_ok=True)
            clean_countries = _clean_countries(countries_raw)
            _save_json(countries_frontend_file, clean_countries)
            log.info(f"Страны сохранены (raw + frontend), всего: {len(clean_countries)}")
        else:
            if countries_frontend_file.exists():
                log.warning("getCountry: API не ответил, оставляю существующий countries.json")
                status["warnings"].append("getCountry: API не ответил, использованы старые данные")
            else:
                log.warning("getCountry: API не ответил и локального файла нет")
                status["warnings"].append("getCountry: нет данных (API не ответил, файла нет)")
        time.sleep(0.5)
    else:
        log.info("Страны свежие (менее 30 дней), пропускаю getCountry")

    stages_raw, fa = post_with_fallback(
        "getStages",
        [{"tournament": tournament_id}, {"tournamentId": tournament_id}],
        season_archive / "getStages.json",
    )
    if fa:
        status["from_archive"].append("getStages")
    if stages_raw:
        try:
            if not fa:
                _save_json(season_archive / "getStages.json", stages_raw)

            stages = validate_stages(stages_raw)
            _save_json(CURRENT_DIR / "stages.json", [s.model_dump() for s in stages])
        except Exception as e:
            status["errors"].append(f"getStages validation: {e}")

    # ─── 4. Матчи ───
    matches_raw, fa = post_with_fallback(
        "getMatches",
        [{"tournament": tournament_id}, {"tournamentId": tournament_id}],
        season_archive / "matches.json",
    )
    if fa:
        status["from_archive"].append("getMatches")
    if matches_raw:
        try:
            if not fa:
                _save_json(INTERNAL_DIR / "matches_raw.json", matches_raw)
            blocks = validate_matches(matches_raw)
            if not fa:
                _save_json(INTERNAL_DIR / "matches.json", [b.model_dump() for b in blocks])
            
            # ─── Скачивание детальной информации по всем матчам ───
            matches_dir = CURRENT_DIR / "matches"
            matches_dir.mkdir(parents=True, exist_ok=True)
            
            # Универсальный парсинг структуры — с сохранением stage у каждого матча
            all_matches = []
            if isinstance(matches_raw, list):
                for block in matches_raw:
                    if isinstance(block, dict):
                        if "matches" in block and isinstance(block["matches"], list):
                            stage_id = block.get("stage")
                            for m in block["matches"]:
                                m["_stage"] = stage_id   # ← только добавляем _stage, ничего больше
                                all_matches.append(m)
                        elif "id" in block and "clubH" in block:
                            all_matches.append(block)
            elif isinstance(matches_raw, dict):
                if "matches" in matches_raw and isinstance(matches_raw["matches"], list):
                    for m in matches_raw["matches"]:
                        m["_stage"] = matches_raw.get("stage")
                        all_matches.append(m)
                else:
                    all_matches = [matches_raw]

            current_stage_id = _find_current_stage(matches_raw)
            log.info(f"Текущий тур: {current_stage_id}")

            total_matches = len(all_matches)
            log.info(f"Начинаю скачивание деталей матчей (всего матчей в сезоне: {total_matches})...")
            
            for m in all_matches:
                match_id = m.get("id")
                if not match_id:
                    continue
                
                detail_file = matches_dir / f"match_{match_id}.json"
                
                # Логика обновления:
                # 1. Если файла нет — качаем.
                # 2. Если матч идет прямо сейчас (status 1, 2, 3) — качаем, чтобы обновить счет.
                # 3. Если матч завершен (status 4) и файл есть — пропускаем (экономим время).
                # 4. Если матч будущий (status 0) и файл есть — пропускаем.
                is_current_stage = (m.get("_stage") == current_stage_id)
                # Матч завершён по списку API, но сохранённый файл ещё не со статусом 4 — перекачать
                needs_final_refresh = (
                    m.get("status") == 4
                    and datetime.strptime(str(m.get("date", ""))[:10], "%Y-%m-%d").date()
                        >= datetime.now().date() - timedelta(days=3)
                    and _saved_status(detail_file) != 4
                )
                should_fetch_detail = (
                    needs_final_refresh or
                    not detail_file.exists()                 # первый раз
                    or m.get("status") not in (0, 4)         # матч идёт
                    or is_current_stage                       # текущий тур — всегда
                )

                if should_fetch_detail:
                    detail_raw = post("getFullDataMatch", {"id": match_id})
                    if detail_raw:
                        for _k in ("broadcastLink", "broadcastDescription", "videoReviewLink", "ticketsLink", "winline"):
                            detail_raw.pop(_k, None)
                        _save_json(detail_file, detail_raw)
                        log.info(
                            f"Сохранены детали матча {match_id} "
                            f"(статус: {m.get('status')}, тур: {'текущий' if is_current_stage else 'другой'})"
                        )
                        
                        # ─── Проверка неполных данных ───
                        missing = []
                        for field in ("matchOfficials", "weather", "winline", "ticketsLink", "broadcastLink"):
                            if not detail_raw.get(field):
                                missing.append(field)
                        
                        # Судьи: если есть только делегат — тоже warning
                        officials = detail_raw.get("matchOfficials") or []
                        has_main_ref = any(o.get("position") == "Главный судья" for o in officials)
                        if officials and not has_main_ref and m.get("status") == 0:
                            missing.append("Главный судья (назначен только делегат)")
                        
                        if missing:
                            status["warnings"].append(f"Матч {match_id}: нет {missing}")
                    else:
                        log.warning(f"Не удалось получить детали для матча {match_id}")
                        status["warnings"].append(f"Матч {match_id}: getFullDataMatch не ответил")
                    
                    time.sleep(0.5)

                # Составы: текущий тур — всегда пробуем; иначе — только если матч не будущий
                lineups_file = matches_dir / f"lineups_{match_id}.json"
                should_fetch_lineups = (
                    is_current_stage
                    or (m.get("status") != 0 and not lineups_file.exists())
                    or (m.get("status") not in (0, 4) and lineups_file.exists())
                )

                if should_fetch_lineups:
                    lineups_raw = post("getLineups", {"id": match_id})
                    if lineups_raw:
                        # Очищаем от лишних фото перед сохранением
                        lineups_clean = _clean_events_and_lineups(lineups_raw)
                        _save_json(lineups_file, lineups_clean)
                        
                        # ─── Проверка неполных данных ───
                        protocol = lineups_raw.get("protocol") or {}
                        club_h = protocol.get("clubH") or []
                        club_a = protocol.get("clubA") or []
                        if not club_h or not club_a:
                            status["warnings"].append(
                                f"Матч {match_id}: составы пустые "
                                f"(clubH: {len(club_h)}, clubA: {len(club_a)})"
                            )
                    else:
                        log.warning(f"Не удалось получить составы для матча {match_id} (возможно, API не отдает)")
                        status["warnings"].append(f"Матч {match_id}: getLineups не ответил")
                    time.sleep(0.5)

                # События: текущий тур — всегда пробуем; иначе — только если матч не будущий
                events_file = matches_dir / f"events_{match_id}.json"
                # Матч завершён, но в сохранённых событиях нет окончания 2-го тайма — перекачать
                events_need_final = (
                    m.get("status") == 4
                    and events_file.exists()
                    and datetime.strptime(str(m.get("date", ""))[:10], "%Y-%m-%d").date()
                        >= datetime.now().date() - timedelta(days=3)
                    and _events_missing_final(events_file)
                )
                should_fetch_events = (
                    is_current_stage
                    or (m.get("status") != 0 and not events_file.exists())
                    or (m.get("status") not in (0, 4) and events_file.exists())
                    or events_need_final
                )

                if should_fetch_events:
                    events_raw = post("getEvents", {"id": match_id})
                    if events_raw:
                        # Очищаем от лишних фото перед сохранением
                        events_clean = _clean_events_and_lineups(events_raw)
                        _save_json(events_file, events_clean)
                        log.info(f"Сохранены события матча {match_id}")
                        
                        # ─── Проверка неполных данных ───
                        protocol_events = events_raw.get("protocol") or []
                        if not protocol_events and m.get("status") == 4:
                            status["warnings"].append(
                                f"Матч {match_id}: завершён, но события пустые"
                            )
                    else:
                        log.warning(f"Не удалось получить события для матча {match_id}")
                        status["warnings"].append(f"Матч {match_id}: getEvents не ответил")
                    time.sleep(0.5)
        except Exception as e:
            status["errors"].append(f"getMatches validation: {e}")

    # ─── 4.5. Сборка единого справочника тренеров ───
    _build_staffs_all(tournament_id, status)

    # ─── 5. Сборка плоской таблицы + standings ───
    _build_flat_and_standings(status)

    # ─── 5.1. Клубная статистика игроков ───
    _build_club_stats(tournament_id, status)
    _build_players_season_stats(status)
    
    status["current_season"] = current["name"]
    status["api_ok"] = len(status["from_archive"]) == 0
    _save_json(META_FILE, {**meta, "import_status": status})
    return status


def _clean_player_profile(raw: dict) -> dict:
    """Оставляет нужные поля из getPlayerProfile."""
    birthday = raw.get("birthday") or ""
    return {
        "patroname": raw.get("patroname") or None,
        "height": raw.get("height"),
        "weight": raw.get("weight"),
        "birthday": birthday.split("UTC")[0] or None,
    }


def _save_player_photos(raw: dict, clean: dict):
    """Скачивает photo и photoSmall во frontend/players/ как имя_фамилия.ext.
    В clean записывает относительные пути вида players/имя_фамилия.png."""
    name = _translit(f"{raw.get('name', '')}_{raw.get('lastname', '')}")
    if not name:
        return
    out_dir = DATA_DIR / "frontend" / "players"
    out_dir.mkdir(parents=True, exist_ok=True)
    for key in ("photo", "photoSmall"):
        url = raw.get(key)
        if not url:
            continue
        ext = url.split("?")[0].rsplit(".", 1)[-1].lower() or "png"
        suffix = "_small" if key == "photoSmall" else ""
        fname = f"{name}{suffix}.{ext}"
        path = out_dir / fname
        if not path.exists():
            try:
                r = requests.get(url, timeout=10)
                r.raise_for_status()
                path.write_bytes(r.content)
                log.info(f"Скачано фото игрока: {fname}")
            except Exception as e:
                log.warning(f"Не удалось скачать фото {url}: {e}")
                continue
        clean[key] = f"players/{fname}"


def _build_player_profiles(clubs_list: list, status: dict):
    """Качает getPlayerProfile для игроков клубов (отчество, рост, вес, дата рождения).
    Кэш: data/current/player_profiles.json. Уже загруженных игроков не запрашивает повторно."""
    profiles_file = INTERNAL_DIR / "player_profiles.json"
    profiles = _load_json(profiles_file, {})
    if not isinstance(profiles, dict):
        profiles = {}

    player_ids = set()
    for c in clubs_list:
        players_file = INTERNAL_DIR / "clubs_data" / str(c["id"]) / "players.json"
        if not players_file.exists():
            continue
        try:
            players_list = json.loads(players_file.read_text(encoding="utf-8"))
        except Exception:
            continue
        if isinstance(players_list, list):
            for p in players_list:
                if p.get("id"):
                    player_ids.add(p["id"])

    now_utc = datetime.now(timezone.utc)

    def _needs_fetch(pid) -> bool:
        p = profiles.get(str(pid))
        if p is None:
            return True
        if "photo" in p and not str(p["photo"]).startswith("http"):
            return False
        if "photo" in p:
            return True  # старая запись с CDN-ссылкой: загрузить фото локально
        checked = p.get("checked_at")
        if not checked:
            return True
        try:
            return (now_utc - datetime.fromisoformat(checked)).days >= 30
        except Exception:
            return True

    to_fetch = [pid for pid in player_ids if _needs_fetch(pid)]
    log.info(f"Профили игроков: всего {len(player_ids)}, новых для загрузки {len(to_fetch)}")

    fetched = 0
    for pid in to_fetch:
        raw = post("getPlayerProfile", {"id": pid})
        if raw and isinstance(raw, dict):
            profiles[str(pid)] = _clean_player_profile(raw)
            _save_player_photos(raw, profiles[str(pid)])
            profiles[str(pid)]["checked_at"] = datetime.now(timezone.utc).isoformat()
            fetched += 1
        time.sleep(0.3)

    if fetched:
        _save_json(profiles_file, profiles)
        log.info(f"Профили игроков сохранены: +{fetched}")


def _build_flat_and_standings(status: dict | None = None):
    """Собирает matches_flat.json и standings.json из текущих файлов."""
    clubs = _load_json(CURRENT_DIR / "clubs.json", [])
    stages = _load_json(CURRENT_DIR / "stages.json", [])
    matches_raw = _load_json(INTERNAL_DIR / "matches.json", [])
    raw_matches_data = _load_json(INTERNAL_DIR / "matches_raw.json", [])
    
    if status is None:
        status = {"warnings": []}

    clubs_by_id = {c["id"]: c for c in clubs}
    stages_by_id = {s["id"]: s for s in stages}

    flat = []
    table: dict[int, dict] = {}

    for block in matches_raw:
        stage_info = stages_by_id.get(block["stage"], {})
        for m in block.get("matches", []):
            home = clubs_by_id.get(m["clubH"], {})
            away = clubs_by_id.get(m["clubA"], {})

            flat.append({
                "matchId": m["id"],
                "tour": stage_info.get("name", f"тур {block['stage']}"),
                "stageId": block["stage"],
                "date": m["date"],
                "status": m["status"],
                "homeId": m["clubH"],
                "awayId": m["clubA"],
                "home": format_team_name(home.get("name")),
                "away": format_team_name(away.get("name")),
                "goalH": m["goalH"],
                "goalA": m["goalA"],
                "city": m.get("city"),
                "stadium": m.get("stadium"),
            })

            # Считаем таблицу только для завершённых матчей
            if m.get("status") == 4 and m.get("goalH") is not None:
                for club_id, gf, ga in [
                    (m["clubH"], m["goalH"], m["goalA"]),
                    (m["clubA"], m["goalA"], m["goalH"]),
                ]:
                    t = table.setdefault(club_id, {
                        "clubId": club_id,
                        "club": format_team_name(clubs_by_id.get(club_id, {}).get("name")),
                        "played": 0, "won": 0, "drawn": 0, "lost": 0,
                        "goalsFor": 0, "goalsAgainst": 0, "points": 0,
                        "maxPoints": 0, # <--- Добавили
                    })
                    t["played"] += 1
                    t["goalsFor"] += gf
                    t["goalsAgainst"] += ga
                    
                    if gf > ga:
                        t["won"] += 1
                        t["points"] += 3
                        t["maxPoints"] += 3
                    elif gf == ga:
                        t["drawn"] += 1
                        t["points"] += 1
                        t["maxPoints"] += 3
                    else:
                        t["lost"] += 1
                        t["maxPoints"] += 3

     # Функция для расчета очков в личных встречах между двумя командами
    def get_h2h_points(team1_id, team2_id):
        points = 0
        for block in matches_raw:
            for m in block.get("matches", []):
                if m.get("status") == 4:
                    if m["clubH"] == team1_id and m["clubA"] == team2_id:
                        if m["goalH"] > m["goalA"]: points += 3
                        elif m["goalH"] == m["goalA"]: points += 1
                    elif m["clubH"] == team2_id and m["clubA"] == team1_id:
                        if m["goalA"] > m["goalH"]: points += 3
                        elif m["goalA"] == m["goalH"]: points += 1
        return points

    def custom_sort(item1, item2):
        # 1. Очки
        if item1["points"] != item2["points"]:
            return item2["points"] - item1["points"]
        # 2. Личные встречи
        h2h1 = get_h2h_points(item1["clubId"], item2["clubId"])
        h2h2 = get_h2h_points(item2["clubId"], item1["clubId"])
        if h2h1 != h2h2:
            return h2h2 - h2h1
        # 3. Разница мячей
        diff1 = item1["goalsFor"] - item1["goalsAgainst"]
        diff2 = item2["goalsFor"] - item2["goalsAgainst"]
        if diff1 != diff2:
            return diff2 - diff1
        # 4. Забитые
        return item2["goalsFor"] - item1["goalsFor"]

    # Сортировка с учетом личных встреч
    standings = sorted(table.values(), key=functools.cmp_to_key(custom_sort))
    
    # Собираем реальную форму (последние 5 матчей) для каждой команды
    team_forms = {club_id: [] for club_id in table.keys()}
    
    # Сортируем все матчи по дате, чтобы найти последние
    all_played_matches = []
    for block in matches_raw:
        for m in block.get("matches", []):
            if m.get("status") == 4 and m.get("goalH") is not None:
                all_played_matches.append(m)
                
    all_played_matches.sort(key=lambda x: x["date"])

    for m in all_played_matches:
        # Записываем результат для хозяев
        if m["clubH"] in team_forms:
            if m["goalH"] > m["goalA"]: team_forms[m["clubH"]].append("w")
            elif m["goalH"] == m["goalA"]: team_forms[m["clubH"]].append("d")
            else: team_forms[m["clubH"]].append("l")
            
        # Записываем результат для гостей
        if m["clubA"] in team_forms:
            if m["goalA"] > m["goalH"]: team_forms[m["clubA"]].append("w")
            elif m["goalA"] == m["goalH"]: team_forms[m["clubA"]].append("d")
            else: team_forms[m["clubA"]].append("l")

    for i, row in enumerate(standings, 1):
        row["position"] = i
        row["goalDiff"] = row["goalsFor"] - row["goalsAgainst"]
        
        # Считаем процент очков (от максимума)
        if row["maxPoints"] > 0:
            row["pointsPercent"] = round((row["points"] / row["maxPoints"]) * 100, 1)
        else:
            row["pointsPercent"] = 0.0
            
        # Берем последние 5 матчей
        form_list = team_forms.get(row["clubId"], [])
        row["form"] = form_list[-5:] # Оставляем только 5 последних

    _save_json(CURRENT_DIR / "matches_flat.json", flat)
    _save_json(CURRENT_DIR / "standings.json", standings)
    
    # Диагностика
    if not flat:
        status["warnings"].append("matches_flat пуст (matches.json пуст или не распарсен)")
    if not standings:
        status["warnings"].append("Таблица пуста (нет завершённых матчей)")
    
    # Диагностика
    if not standings:
        log.warning("Таблица пуста: нет завершённых матчей или matches.json пуст")
    if not flat:
        log.warning("matches_flat пуст: matches.json пуст или не распарсен")

    # ─── Определение текущего тура ───
    from datetime import datetime
    now = datetime.now()
    
    best_stage = None
    min_diff = float('inf')

    for block in matches_raw:
        stage_id = block["stage"]
        block_matches = block.get("matches", [])
        
        if not block_matches:
            continue
            
        # Если есть незавершенные матчи (включая будущие)
        has_unfinished = any(m.get("status") != 4 for m in block_matches)
        
        if has_unfinished:
            try:
                # Берем дату первого матча в туре
                first_date_str = block_matches[0]["date"]
                # Заменяем UTC на пробел, чтобы корректно распарсить
                first_date_str = first_date_str.replace("UTC", " ")
                first_date = datetime.strptime(first_date_str[:19], "%Y-%m-%d %H:%M:%S")
                
                # Берём самый ранний тур с незавершёнными матчами (тур не сменится, пока есть статус != 4)
                diff = first_date.timestamp()
                
                # Если это самый близкий тур к текущему моменту
                if diff < min_diff:
                    min_diff = diff
                    best_stage = stage_id
            except Exception as e:
                log.warning(f"Ошибка парсинга даты тура {stage_id}: {e}")
                if best_stage is None:
                    best_stage = stage_id

    if best_stage is not None:
        stage_info = stages_by_id.get(best_stage, {})
        current_tour_matches = []

        # Загружаем список трансляций MatchTV для проверки 4K
        matchtv_items = []
        try:
            mtv_resp = requests.get(
                "https://matchtv.ru/api/v1/videohub/shelves/125/data?limit=25&offset=0",
                headers={"User-Agent": "Mozilla/5.0"},
                timeout=10,
            )
            if mtv_resp.ok:
                mtv_data = mtv_resp.json()
                matchtv_items = mtv_data.get("result", {}).get("items", [])
        except Exception as e:
            log.warning(f"Не удалось загрузить данные MatchTV для проверки 4K: {e}")

        for b in matches_raw:
            if b["stage"] == best_stage:
                for m in b.get("matches", []):
                    m_copy = dict(m)
                    wl = m.get("winline")
                    if not wl:
                        raw_match = next(
                            (rm for rb in (raw_matches_data or []) for rm in rb.get("matches", []) if rm.get("id") == m.get("id")),
                            None
                        )
                        if raw_match:
                            wl = raw_match.get("winline")
                    link = (wl or {}).get("link") or ""
                    try:
                        m_copy["wid"] = int(link.rstrip("/").split("/")[-1]) if link else None
                    except (ValueError, IndexError):
                        m_copy["wid"] = None

                    # Получаем ссылку на поток Winline по wid
                    m_copy["stream"] = None
                    if m_copy["wid"]:
                        try:
                            resp = requests.get(
                                f"https://winline.ru/api/v2/videostream/source/73?idEvent={m_copy['wid']}",
                                headers={"User-Agent": "Mozilla/5.0"},
                                timeout=10,
                            )
                            stream_text = resp.text
                            url_m = re.search(r'": "(.*?)"', stream_text)
                            if url_m:
                                url = url_m.group(1).replace("start", "playlist")
                                # Формируем итоговый URL с 1080p50fps
                                if len(url) >= 91:
                                    stream_url = url[:91] + "/1080p50fps" + url[91:]
                                else:
                                    stream_url = url

                                # Шифруем ссылку в Base64, чтобы её не было видно в исходниках
                                import base64
                                stream_url = base64.b64encode(stream_url.encode('utf-8')).decode('utf-8')

                            

                                # Проверяем, является ли матч 4K по данным MatchTV
                                home_name = format_team_name(clubs_by_id.get(m["clubH"], {}).get("name"))
                                away_name = format_team_name(clubs_by_id.get(m["clubA"], {}).get("name"))
                                target_title = f"{home_name} - {away_name}"
                                is_4k = False
                                for item in matchtv_items:
                                    if item.get("title") == target_title and item.get("is4k"):
                                        is_4k = True
                                        break
                                if is_4k:
                                    stream_url = stream_url.replace("/1080p50fps/", "/2160/")
                                m_copy["stream"] = stream_url
                            else:
                                m_copy["stream"] = None
                        except Exception as e:
                            log.warning(f"Не удалось получить stream для wid={m_copy['wid']}: {e}")
                            m_copy["stream"] = None

                    current_tour_matches.append(m_copy)
        current_tour_data = {
            "stageId": best_stage,
            "name": stage_info.get("name", f"Тур {best_stage}"),
            "matches": current_tour_matches
        }
        _save_json(CURRENT_DIR / "current_tour.json", current_tour_data)
        log.info(f"Определен текущий тур: {current_tour_data['name']} (ID: {best_stage})")
    else:
        log.warning("Не удалось определить текущий тур (возможно, все матчи сезона завершены).")
        # Явно сбрасываем, чтобы фронт не показывал тур прошлого сезона
        _save_json(CURRENT_DIR / "current_tour.json", {
            "stageId": None,
            "name": "Сезон завершён",
            "matches": []
        })
        
def _build_staffs_all(tournament_id: int, status: dict):
    """Собирает единый справочник тренеров (staffs_all.json).
    1. Берет актуальные данные из staffs.json клубов (там есть гражданство).
    2. Добавляет тренеров из lineups_*.json, которых нет в staffs.json (ушедшие).
    3. Сохраняет ваши ручные правки citizenship.
    """
    log.info("Собираю единый справочник тренеров (staffs_all.json)...")
    staffs_all_file = CURRENT_DIR / "staffs_all.json"
    
    # 1. Загружаем существующий справочник (где вы уже вписали страны)
    existing_staffs = _load_json(staffs_all_file, {})
    if not isinstance(existing_staffs, dict):
        existing_staffs = {}
        
    # 2. Собираем тренеров из АКТУАЛЬНЫХ staffs.json (там есть гражданство)
    clubs_data_dir = INTERNAL_DIR / "clubs_data"
    current_staffs_map = {}  # id -> data
    
    if clubs_data_dir.exists():
        for club_dir in clubs_data_dir.iterdir():
            if not club_dir.is_dir():
                continue
            staffs_file = club_dir / "staffs.json"
            if staffs_file.exists():
                try:
                    staffs_list = json.loads(staffs_file.read_text(encoding="utf-8"))
                    if isinstance(staffs_list, list):
                        for s in staffs_list:
                            if s.get("id"):
                                # Приводим к нашему единому формату
                                current_staffs_map[str(s["id"])] = {
                                    "id": s["id"],
                                    "name": s.get("name", ""),
                                    "lastname": s.get("lastname", ""),
                                    "citizenship": s.get("citizenship"),
                                    "club": int(club_dir.name) if club_dir.name.isdigit() else None,
                                    "isCurrentCoach": s.get("isCurrentCoach"),
                                }
                except Exception as e:
                    log.warning(f"Ошибка чтения staffs.json для клуба {club_dir.name}: {e}")

    # 3. Собираем всех тренеров из lineups (там могут быть ушедшие, но нет гражданства)
    matches_dir = CURRENT_DIR / "matches"
    found_in_lineups = {}
    
    if matches_dir.exists():
        for lineups_file in matches_dir.glob("lineups_*.json"):
            try:
                lineups_data = json.loads(lineups_file.read_text(encoding="utf-8"))
                protocol = lineups_data.get("protocol") or lineups_data
                for side in ("clubH", "clubA"):
                    club_data = protocol.get(side) or {}
                    club_id = club_data.get("id")
                    coaches = club_data.get("coaches", [])
                    for c in coaches:
                        if c.get("id"):
                            found_in_lineups[str(c["id"])] = {
                                "id": c["id"],
                                "name": c.get("name", ""),
                                "lastname": c.get("lastname", ""),
                                "citizenship": None,  # В lineups гражданства нет
                                "club": club_id,
                            }
            except Exception as e:
                log.warning(f"Ошибка чтения {lineups_file.name}: {e}")

    # 4. Мержим всё вместе
    added_count = 0
    updated_count = 0
    
    # Сначала обновляем/добавляем актуальных тренеров (у которых есть шанс получить гражданство из API)
    for cid_str, coach_data in current_staffs_map.items():
        if cid_str not in existing_staffs:
            existing_staffs[cid_str] = coach_data
            added_count += 1
        else:
            existing = existing_staffs[cid_str]
            # Обновляем имя/фамилию/клуб
            existing["name"] = coach_data["name"] or existing.get("name")
            existing["lastname"] = coach_data["lastname"] or existing.get("lastname")
            if coach_data.get("club"):
                existing["club"] = coach_data["club"]
            existing["isCurrentCoach"] = coach_data.get("isCurrentCoach")
            
            # ГЛАВНОЕ: Если API дал гражданство, а у нас пусто — обновляем.
            # Если у нас УЖЕ есть гражданство (вы вписали) — НЕ ТРОГАЕМ.
            if coach_data.get("citizenship") is not None and not existing.get("citizenship"):
                existing["citizenship"] = coach_data["citizenship"]
                updated_count += 1

    # Теперь добавляем ушедших тренеров из lineups
    for cid_str, coach_data in found_in_lineups.items():
        if cid_str not in existing_staffs:
            # Этого тренера нет ни в staffs, ни в нашем файле — добавляем (citizenship: null)
            existing_staffs[cid_str] = coach_data
            added_count += 1
        else:
            # Тренер уже есть (возможно, вы ему вписали страну вручную)
            existing = existing_staffs[cid_str]
            # Обновляем имя/фамилию, если они были пустые
            if not existing.get("name") and coach_data.get("name"):
                existing["name"] = coach_data["name"]
            if not existing.get("lastname") and coach_data.get("lastname"):
                existing["lastname"] = coach_data["lastname"]
            # Гражданство НЕ ТРОГАЕМ.

    # 5. Сохраняем, только если реально были изменения
    existing_count_before = len(_load_json(staffs_all_file, {}))
    if True:  # _save_json сам пропускает запись, если содержимое не изменилось
        _save_json(staffs_all_file, existing_staffs)
        log.info(f"Справочник тренеров обновлен: +{added_count} новых, ~{updated_count} обновлено. Всего: {len(existing_staffs)}")
    else:
        log.info(f"Справочник тренеров без изменений ({len(existing_staffs)} чел.)")


def _build_club_stats(tournament_id: int, status: dict):
    """Собирает агрегированную статистику игроков клуба по завершённым матчам.
    Сохраняет data/current/clubs_data/<clubId>/club_stats.json
    """
    log.info("Собираю клубную статистику игроков (club_stats.json)...")

    clubs = _load_json(CURRENT_DIR / "clubs.json", [])
    if not clubs:
        log.warning("club_stats: clubs.json пуст, пропускаю.")
        return

    matches_dir = CURRENT_DIR / "matches"
    clubs_data_dir = INTERNAL_DIR / "clubs_data"

    # 1. Загружаем всех игроков из players.json по клубам (база для агрегатов)
    profiles = _load_json(INTERNAL_DIR / "player_profiles.json", {})
    if not isinstance(profiles, dict):
        profiles = {}
    club_players = {}  # clubId -> {playerId: playerData}
    for c in clubs:
        cid = c["id"]
        players_file = clubs_data_dir / str(cid) / "players.json"
        if not players_file.exists():
            continue
        try:
            players_list = json.loads(players_file.read_text(encoding="utf-8"))
        except Exception as e:
            log.warning(f"club_stats: не прочитал players.json клуба {cid}: {e}")
            continue
        if not isinstance(players_list, list):
            continue
        club_players[cid] = {}
        for p in players_list:
            if p.get("id"):
                club_players[cid][p["id"]] = {
                    "id": p["id"],
                    "name": p.get("name", ""),
                    "lastname": p.get("lastname", ""),
                    "amplua": p.get("amplua"),
                    "number": p.get("number"),
                    "citizenship": p.get("citizenship"),
                    "lineupType": p.get("lineupType"),
                    "nickname": p.get("nickname"),
                    "public_lastname": p.get("public_lastname"),
                    "public_name": p.get("public_name"),
                    "patroname": profiles.get(str(p["id"]), {}).get("patroname"),
                    "height": profiles.get(str(p["id"]), {}).get("height"),
                    "weight": profiles.get(str(p["id"]), {}).get("weight"),
                    "birthday": profiles.get(str(p["id"]), {}).get("birthday"),
                    "photo": profiles.get(str(p["id"]), {}).get("photo"),
                    "photoSmall": profiles.get(str(p["id"]), {}).get("photoSmall"),
                    "matchesInSquad": 0,
                    "matchesStarted": 0,
                    "matchesSubIn": 0,
                    "minutesPlayed": 0,
                    "captainMatches": 0,
                    "goals": 0,
                    "penaltyGoals": 0,
                    "penaltyMissed": 0,
                    "ownGoals": 0,
                    "assists": 0,
                    "yellowCards": 0,
                    "redCards": 0,
                    "shots": 0,
                    "shotsOnTarget": 0,
                    "fouls": 0,
                    "corners": 0,
                    "offsides": 0,
                }

    # 2. Собираем ID завершённых матчей из matches_flat.json
    flat = _load_json(CURRENT_DIR / "matches_flat.json", [])
    finished = [m for m in flat if m.get("status") == 4]
    if not finished:
        log.info("club_stats: нет завершённых матчей.")
        # Всё равно сохраняем пустые файлы для единообразия фронта
        _write_club_stats_files(club_players, tournament_id, 0)
        return

    match_score = {m.get("matchId"): (m.get("goalH") or 0, m.get("goalA") or 0) for m in finished if m.get("matchId")}
    STAT_KEYS = ("goals", "conceded", "fouls", "corners", "offsides", "yellow", "red")
    halves_acc = {c["id"]: {f"{k}{h}": 0 for k in STAT_KEYS for h in (1, 2)} for c in clubs}
    att_acc = {c["id"]: [] for c in clubs}
    match_club_map = {}
    for m in finished:
        mid = m.get("matchId")
        if mid:
            match_club_map[mid] = (m.get("homeId"), m.get("awayId"))

    # 3. Проходим по завершённым матчам: lineups → заявка/старт/минуты, events → голы/карточки/удары
    processed = 0
    club_matches = {c["id"]: 0 for c in clubs}
    club_corners = {c["id"]: 0 for c in clubs}
    for mid, (home_id, away_id) in match_club_map.items():
        if not home_id or not away_id:
            continue
        club_matches[home_id] = club_matches.get(home_id, 0) + 1
        club_matches[away_id] = club_matches.get(away_id, 0) + 1

        # 3.1. Составы
        lineups_file = matches_dir / f"lineups_{mid}.json"
        lineups = None
        if lineups_file.exists():
            try:
                lineups = json.loads(lineups_file.read_text(encoding="utf-8"))
            except Exception:
                lineups = None

        if lineups:
            protocol = lineups.get("protocol") or lineups
            for side_key, club_id in (("clubH", home_id), ("clubA", away_id)):
                cd = protocol.get(side_key) or {}
                if not club_players.get(club_id):
                    continue
                players_map = {p["id"]: p for p in cd.get("players", []) if p.get("id")}
                # main/reserve — списки ОБЪЕКТОВ игроков, берём из них id
                main_ids = set(
                    (m.get("id") if isinstance(m, dict) else m)
                    for m in (cd.get("main") or [])
                    if (m.get("id") if isinstance(m, dict) else m)
                )
                reserve_ids = set(
                    (m.get("id") if isinstance(m, dict) else m)
                    for m in (cd.get("reserve") or [])
                    if (m.get("id") if isinstance(m, dict) else m)
                )
                all_ids = set(players_map.keys())
                captain_ids = set(m.get("id") for m in (cd.get("main") or []) if isinstance(m, dict) and m.get("captain"))

                for pid in all_ids:
                    if pid not in club_players[club_id]:
                        # Игрок есть в матче, но нет в актуальном players.json — пропускаем
                        # (ушёл из клуба — его статистику не ведём в профиле текущего клуба)
                        continue
                    stats = club_players[club_id][pid]
                    stats["matchesInSquad"] += 1
                    is_main = pid in main_ids
                    if is_main:
                        stats["matchesStarted"] += 1
                    # Капитан
                    if pid in captain_ids:
                        stats["captainMatches"] += 1

        # 3.2. События
        events_file = matches_dir / f"events_{mid}.json"
        if events_file.exists():
            try:
                ev_data = json.loads(events_file.read_text(encoding="utf-8"))
            except Exception:
                ev_data = {}

            protocol_events = ev_data.get("protocol") or []
            broadcast_events = ev_data.get("broadcast") or []

            # Счётчики замен: player1.id -> минута выхода (в events протокола: type 2 = замена,
            # player1 уходит, player2 выходит)
            sub_in_minutes = {}   # pid -> [minutes]
            sub_out_minutes = {}  # pid -> [minutes]

            for e in protocol_events:
                etype = e.get("type")
                e_club = e.get("club")
                t = e.get("time")
                extra = e.get("extra") or 0
                minute_abs = (t or 0) + extra

                if etype == 2:  # замена
                    p1 = (e.get("player1") or {}).get("id")
                    p2 = (e.get("player2") or {}).get("id")
                    if p2:
                        sub_in_minutes.setdefault(p2, []).append(minute_abs)
                    if p1:
                        sub_out_minutes.setdefault(p1, []).append(minute_abs)

            # minutesPlayed: старт — до конца матча или до замены; вышедший на замену — с минуты выхода до конца
            # Для простоты считаем: старт играет 90 (или до замены), запасной — 90 - минута_выхода
            def _match_last_minute(bc_events):
                last = 90
                for be in bc_events:
                    if be.get("type") == "GamePeriodEnd" and be.get("periodNumber") == 2:
                        last = max(last, (be.get("time") or 0) + (be.get("extra") or 0))
                return last
            match_end = _match_last_minute(broadcast_events)

            for side_key, club_id in (("clubH", home_id), ("clubA", away_id)):
                if not lineups:
                    continue
                protocol = lineups.get("protocol") or lineups
                cd = protocol.get(side_key) or {}
                main_ids = set(
                    (m.get("id") if isinstance(m, dict) else m)
                    for m in (cd.get("main") or [])
                    if (m.get("id") if isinstance(m, dict) else m)
                )
                reserve_ids = set(
                    (m.get("id") if isinstance(m, dict) else m)
                    for m in (cd.get("reserve") or [])
                    if (m.get("id") if isinstance(m, dict) else m)
                )
                if not club_players.get(club_id):
                    continue
                for pid in main_ids | reserve_ids:
                    if pid not in club_players[club_id]:
                        continue
                    stats = club_players[club_id][pid]
                    if pid in main_ids:
                        out_min = min(sub_out_minutes.get(pid, [match_end]))
                        stats["minutesPlayed"] += max(0, out_min)
                    elif pid in reserve_ids:
                        in_mins = sub_in_minutes.get(pid)
                        if in_mins:
                            stats["matchesSubIn"] += 1
                            stats["minutesPlayed"] += max(0, match_end - in_mins[0])

                    # Вратарская статистика: считаем один раз здесь, фронт читает готовые поля
                    if stats.get("amplua") == 0 and (pid in main_ids or sub_in_minutes.get(pid)):
                        conceded = match_score.get(mid, (0, 0))[1] if side_key == "clubH" else match_score.get(mid, (0, 0))[0]
                        stats["gkMatches"] = stats.get("gkMatches", 0) + 1
                        stats["gkConceded"] = stats.get("gkConceded", 0) + conceded
                        if conceded == 0:
                            stats["cleanSheets"] = stats.get("cleanSheets", 0) + 1

            # Голы / карточки / автоголы (из protocol надёжнее)
            for e in protocol_events:
                etype = e.get("type")
                e_club = e.get("club")
                p1 = (e.get("player1") or {}).get("id")
                p2 = (e.get("player2") or {}).get("id")

                if etype == 1 or etype == 10:  # гол
                    if p1 and club_players.get(e_club) and p1 in club_players[e_club]:
                        club_players[e_club][p1]["goals"] += 1
                        if etype == 10:
                            club_players[e_club][p1]["penaltyGoals"] += 1
                    # ассисты считаются из broadcast (action == "Goal", player2)
                elif etype == 11:  # автогол
                    if p1 and club_players.get(e_club) and p1 in club_players[e_club]:
                        club_players[e_club][p1]["ownGoals"] += 1
                elif etype == 5:  # не реализованный пенальти
                    if p1 and club_players.get(e_club) and p1 in club_players[e_club]:
                        club_players[e_club][p1]["penaltyMissed"] += 1
                elif etype == 3:  # жёлтая
                    if p1 and club_players.get(e_club) and p1 in club_players[e_club]:
                        club_players[e_club][p1]["yellowCards"] += 1
                elif etype == 4:  # красная
                    if p1 and club_players.get(e_club) and p1 in club_players[e_club]:
                        club_players[e_club][p1]["redCards"] += 1

            # Удары / фолы / углы / офсайды (из broadcast — по player1.id и club)
            for be in broadcast_events:
                action = be.get("action")
                b_club = be.get("club")
                pid = (be.get("player1") or {}).get("id")
                if not action or not b_club:
                    continue
                if action == "Corner" and b_club in club_corners:
                    club_corners[b_club] += 1
                if not club_players.get(b_club):
                    continue
                if action == "Goal":
                    a_id = (be.get("player2") or {}).get("id")
                    if a_id and a_id in club_players[b_club]:
                        club_players[b_club][a_id]["assists"] += 1
                if pid and pid in club_players[b_club]:
                    pstats = club_players[b_club][pid]
                    if action == "Shot":
                        pstats["shots"] += 1
                    elif action == "ShotOnTarget":
                        pstats["shotsOnTarget"] += 1
                    elif action == "Foul":
                        pstats["fouls"] += 1
                    elif action == "Corner":
                        pstats["corners"] += 1
                    elif action == "Offside":
                        pstats["offsides"] += 1

        # 3.3. Полоски по таймам и посещаемость домашних матчей
        ev_h_path = matches_dir / f"events_{mid}.json"
        ev_h = {}
        if ev_h_path.exists():
            try:
                ev_h = json.loads(ev_h_path.read_text(encoding="utf-8"))
            except Exception:
                ev_h = {}
        h_end = 45
        for be in (ev_h.get("broadcast") or []):
            if be.get("type") == "GamePeriodEnd" and be.get("periodNumber") == 1:
                h_end = (be.get("time") or 0) + (be.get("extra") or 0)
        opp = {home_id: away_id, away_id: home_id}
        for be in (ev_h.get("broadcast") or []):
            b_club = be.get("club")
            if b_club not in halves_acc:
                continue
            h = 1 if ((be.get("time") or 0) + (be.get("extra") or 0)) <= h_end else 2
            if be.get("action") == "Corner":
                halves_acc[b_club][f"corners{h}"] += 1
            elif be.get("action") == "Foul":
                halves_acc[b_club][f"fouls{h}"] += 1
            elif be.get("action") == "Offside":
                halves_acc[b_club][f"offsides{h}"] += 1
        for e in (ev_h.get("protocol") or []):
            e_club = e.get("club")
            et = e.get("type")
            h = 1 if ((e.get("time") or 0) + (e.get("extra") or 0)) <= h_end else 2
            if et in (1, 10) and e_club in halves_acc:
                halves_acc[e_club][f"goals{h}"] += 1
                if opp.get(e_club) in halves_acc:
                    halves_acc[opp[e_club]][f"conceded{h}"] += 1
            elif et == 11 and e_club in halves_acc:
                halves_acc[e_club][f"conceded{h}"] += 1
            elif et == 3 and e_club in halves_acc:
                halves_acc[e_club][f"yellow{h}"] += 1
            elif et == 4 and e_club in halves_acc:
                halves_acc[e_club][f"red{h}"] += 1

        if home_id in att_acc:
            m_path = matches_dir / f"match_{mid}.json"
            if m_path.exists():
                try:
                    att = json.loads(m_path.read_text(encoding="utf-8")).get("attendance")
                    if att:
                        att_acc[home_id].append(int(att))
                except Exception:
                    pass

        processed += 1

    # 4. Сохраняем файлы
    _write_club_stats_files(club_players, tournament_id, processed, club_matches, club_corners, halves_acc, att_acc)
    log.info(f"club_stats: обработано матчей: {processed}, клубов: {len(club_players)}")


PS_KEYS = ["matchesInSquad", "matchesPlayed", "matchesStarted", "matchesSubIn", "minutesPlayed", "captainMatches",
           "goals", "penaltyGoals", "penaltyMissed", "ownGoals", "assists", "yellowCards", "redCards", "secondYellowCards",
           "shots", "shotsOnTarget", "fouls", "corners", "offsides",
           "gkMatches", "gkConceded", "cleanSheets"]
PS_MATCH_KEYS = ("goals", "assists", "yellowCards", "redCards")


def _build_players_season_stats(status: dict):
    """players_stats.json: статистика игрока за сезон по всем клубам.
    Клуб берётся из состава конкретного матча, поэтому матчи за прошлый клуб сохраняются.
    club_stats.json клубов этим не затрагивается."""
    log.info("Собираю статистику игроков за сезон (players_stats.json)...")
    flat = _load_json(CURRENT_DIR / "matches_flat.json", []) or []
    players_all = _load_json(CURRENT_DIR / "players_all.json", {}) or {}
    profiles_all = _load_json(INTERNAL_DIR / "player_profiles.json", {}) or {}
    matches_dir = CURRENT_DIR / "matches"

    stats = {}       # (pid, clubId) -> {ключ: значение}
    names = {}       # pid -> имена из составов (там есть никнейм, как в модалке матча)
    match_recs = {}  # pid -> {matchId: запись}
    
    club_rosters = {}
    for c in _load_json(CURRENT_DIR / "clubs.json", []) or []:
        cid = c["id"]
        pl = _load_json(INTERNAL_DIR / "clubs_data" / str(cid) / "players.json", []) or []
        club_rosters[cid] = [p.get("id") for p in pl if p.get("id")]

    def get_s(pid, cid):
        if (pid, cid) not in stats:
            stats[(pid, cid)] = {k: 0 for k in PS_KEYS}
        return stats[(pid, cid)]

    for m in flat:
        if m.get("status") != 4 or not m.get("matchId"):
            continue
        mid = m["matchId"]
        hid, aid = m.get("homeId"), m.get("awayId")
        lu = _load_json(matches_dir / f"lineups_{mid}.json")
        if not lu:
            continue
        ev = _load_json(matches_dir / f"events_{mid}.json", {}) or {}
        protocol = lu.get("protocol") or lu
        pev = ev.get("protocol") or []
        bc = ev.get("broadcast") or []

        end = 90
        for be in bc:
            if be.get("type") == "GamePeriodEnd" and be.get("periodNumber") == 2:
                end = max(end, (be.get("time") or 0) + (be.get("extra") or 0))

        sub_in, sub_out = {}, {}
        for e in pev:
            if e.get("type") == 2:
                minute = (e.get("time") or 0) + (e.get("extra") or 0)
                p1 = (e.get("player1") or {}).get("id")
                p2 = (e.get("player2") or {}).get("id")
                if p2:
                    sub_in.setdefault(p2, []).append(minute)
                if p1:
                    sub_out.setdefault(p1, []).append(minute)

        score_h, score_a = m.get("goalH") or 0, m.get("goalA") or 0

        def bump(pid, cid, key, n=1):
            if not pid or not cid:
                return
            get_s(pid, cid)[key] += n
            rec = match_recs.get(pid, {}).get(mid)
            if rec is not None and key in PS_MATCH_KEYS:
                rec[key] += n

        for side, cid in (("clubH", hid), ("clubA", aid)):
            if not cid:
                continue
            cd = protocol.get(side) or {}
            main = {(x.get("id") if isinstance(x, dict) else x): x for x in (cd.get("main") or [])}
            reserve_ids = {(x.get("id") if isinstance(x, dict) else x) for x in (cd.get("reserve") or [])}
            conceded_here = score_a if side == "clubH" else score_h
            
            cd_players_map = {pl.get("id"): pl for pl in (cd.get("players") or []) if pl.get("id")}
            roster_ids = set(club_rosters.get(cid, [])) | set(cd_players_map.keys())

            for pid in roster_ids:
                pl = cd_players_map.get(pid)
                in_squad = pl is not None
                
                if not pl:
                    pl = players_all.get(str(pid))
                    if not pl:
                        continue
                
                if pl.get("nickname") or pl.get("public_name") or pl.get("public_lastname") or pid not in names:
                    names[pid] = {"nickname": pl.get("nickname"), "public_name": pl.get("public_name"),
                                  "public_lastname": pl.get("public_lastname")}
                entry = main.get(pid)
                in_main = entry is not None
                amplua = entry.get("amplua") if in_main else None
                if amplua is None:
                    amplua = pl.get("amplua")
                if amplua is None:
                    amplua = (players_all.get(str(pid)) or {}).get("amplua")

                s = get_s(pid, cid)
                if in_squad:
                    s["matchesInSquad"] += 1
                _d = str(m.get("date") or "")[:10]
                if _d and (not s.get("from") or _d < s["from"]):
                    s["from"] = _d
                if _d and (not s.get("to") or _d > s["to"]):
                    s["to"] = _d
                if in_main:
                    s["matchesStarted"] += 1
                    if entry.get("captain"):
                        s["captainMatches"] += 1
                    minutes = max(0, min(sub_out.get(pid, [end])))
                elif sub_in.get(pid):
                    s["matchesSubIn"] += 1
                    minutes = max(0, end - min(sub_in[pid]))
                else:
                    minutes = 0
                s["minutesPlayed"] += minutes

                played = in_main or bool(sub_in.get(pid))
                if played:
                    get_s(pid, cid)["matchesPlayed"] += 1
                match_recs.setdefault(pid, {})[mid] = {
                    "matchId": mid, "clubId": cid, "minutes": minutes, "started": in_main, "played": played, "in_squad": in_squad,
                    "from": 1 if in_main else (min(sub_in[pid]) if sub_in.get(pid) else None),
                    "to": min(sub_out.get(pid, [end])) if in_main else end,
                    "date": m.get("date"), "tour": m.get("tour"), "homeId": hid, "awayId": aid,
                    "goalH": score_h, "goalA": score_a,
                    "goals": 0, "assists": 0, "yellowCards": 0, "redCards": 0,
                }
                if not played:
                    continue
                if amplua == 0:
                    s["gkMatches"] += 1
                    s["gkConceded"] += conceded_here
                    if conceded_here == 0:
                        s["cleanSheets"] += 1


        for e in pev:
            t = e.get("type")
            cid = e.get("club")
            pid = (e.get("player1") or {}).get("id")
            if t in (1, 10):
                bump(pid, cid, "goals")
            if t == 10:
                bump(pid, cid, "penaltyGoals")
            elif t == 11:
                bump(pid, cid, "ownGoals")
            elif t == 5:
                bump(pid, cid, "penaltyMissed")
            elif t == 3:
                bump(pid, cid, "yellowCards")
            elif t == 4:
                bump(pid, cid, "redCards")

        shot_keys = {"Shot": "shots", "ShotOnTarget": "shotsOnTarget", "Foul": "fouls",
                     "Corner": "corners", "Offside": "offsides"}
        for be in bc:
            action = be.get("action")
            cid = be.get("club")
            pid = (be.get("player1") or {}).get("id")
            if not action or not cid:
                continue
            if action == "Goal":
                bump((be.get("player2") or {}).get("id"), cid, "assists")
            if action == "RedYellowCard":
                bump(pid, cid, "secondYellowCards")
            if action in shot_keys:
                bump(pid, cid, shot_keys[action])

    out = {}
    for (pid, cid), s in stats.items():
        o = out.setdefault(str(pid), {"id": pid, "total": {k: 0 for k in PS_KEYS}, "clubs": {}, "matches": []})
        o["clubs"][str(cid)] = s
        for k in PS_KEYS:
            o["total"][k] += s[k]
    for pid, recs in match_recs.items():
        if str(pid) in out:
            out[str(pid)]["matches"] = sorted(recs.values(), key=lambda r: r["matchId"])
    for sid, o in out.items():
        pa = players_all.get(sid) or {}
        pr = profiles_all.get(sid) or {}
        nm = names.get(int(sid)) or {}
        o["identity"] = {
            "id": o["id"], "name": pa.get("name", ""), "lastname": pa.get("lastname", ""),
            "amplua": pa.get("amplua"), "number": pa.get("number"),
            "citizenship": pa.get("citizenship"), "birthday": pa.get("birthday"),
            "nickname": nm.get("nickname") or pa.get("nickname"),
            "public_name": nm.get("public_name") or pa.get("public_name"),
            "public_lastname": nm.get("public_lastname") or pa.get("public_lastname"),
            "photo": pr.get("photo"), "photoSmall": pr.get("photoSmall"),
        }

    current_club = {}
    for c in _load_json(CURRENT_DIR / "clubs.json", []) or []:
        pl = _load_json(INTERNAL_DIR / "clubs_data" / str(c["id"]) / "players.json", []) or []
        for p in pl:
            if p.get("id"):
                current_club[str(p["id"])] = c["id"]
    for sid, o in out.items():
        o["currentClub"] = current_club.get(sid)

    _save_json(CURRENT_DIR / "players_stats.json", out)
    log.info(f"players_stats: игроков {len(out)}")


def _clean_events_and_lineups(data: dict) -> dict:
    """Удаляет поля photo и photoBig из вложенных объектов игроков (player1, player2 и т.д.), 
    чтобы не раздувать файлы events_*.json и lineups_*.json."""
    if not isinstance(data, dict):
        return data
    
    cleaned = {}
    for key, value in data.items():
        if isinstance(value, dict):
            # Если это объект игрока (например, в player1, player2)
            if "id" in value and ("name" in value or "lastname" in value or "nickname" in value):
                cleaned_val = {k: v for k, v in value.items() if k not in ("photo", "photoBig")}
                # Рекурсивно проверяем вложенные поля на всякий случай
                cleaned[key] = _clean_events_and_lineups(cleaned_val)
            else:
                cleaned[key] = _clean_events_and_lineups(value)
        elif isinstance(value, list):
            cleaned[key] = [_clean_events_and_lineups(item) for item in value]
        else:
            cleaned[key] = value
    return cleaned

def _write_club_stats_files(club_players: dict, tournament_id: int, matches_played: int, club_matches: dict | None = None, club_corners: dict | None = None, halves_acc: dict | None = None, att_acc: dict | None = None):
    """Сохраняет club_stats.json для каждого клуба."""
    from datetime import datetime, timezone, timedelta
    seasons = _load_json(DATA_DIR / "seasons.json", [])
    season_name = ""
    for s in seasons:
        if s.get("tournament_id") == tournament_id and s.get("is_current"):
            season_name = s.get("name", "")
            break

    updated_at = datetime.now(timezone.utc).isoformat()

    for cid, players in club_players.items():
        out = {
            "clubId": cid,
            "season": season_name,
            "updatedAt": updated_at,
            "matchesPlayed": (club_matches or {}).get(cid, matches_played),
            "corners": (club_corners or {}).get(cid, 0),
            "halves": (halves_acc or {}).get(cid, {}),
            "avgHomeAttendance": round(sum(att_acc[cid]) / len(att_acc[cid])) if (att_acc and att_acc.get(cid)) else 0,
            "players": players,
        }
        path = CURRENT_DIR / "clubs_data" / str(cid) / "club_stats.json"
        for p in out["players"].values():
            p.pop("photoBig", None)
            for key in ("photo", "photoSmall"):
                if str(p.get(key) or "").startswith("http"):
                    p.pop(key, None)
        # Сравниваем без updatedAt: дата меняется только если данные реально изменились
        if path.exists():
            try:
                old = json.loads(path.read_text(encoding="utf-8"))
                new_norm = json.loads(json.dumps(out, ensure_ascii=False))
                if {k: v for k, v in old.items() if k != "updatedAt"} == {k: v for k, v in new_norm.items() if k != "updatedAt"}:
                    continue
            except Exception:
                pass
        _save_json(path, out)