const DATA_BASE = "./data/current";

// Словарь сокращений для команд
const TEAM_RENAMES = {
  "Динамо-Москва": "Динамо М",
  "Спартак-Москва": "Спартак",
  "Динамо Махачкала": "Динамо Мх",
  "ПФК ЦСКА": "ЦСКА"
};

// ─────────────────────────────────────────────
// ХЕЛПЕРЫ ДЛЯ LIVE-ТАЙМЕРА МАТЧА
// ─────────────────────────────────────────────

// Возвращает текущую минуту матча или null, если матч не идет
function calculateMatchMinute(match, secondHalfConfirmed = false, broadcastEvents = null) {
    if (!match || match.status !== 1 && match.status !== 2 && match.status !== 3) {
        return null;
    }
    
    // Время начала текущего статуса (тайма)
    const startTimeStr = match.dateStartStatus;
    if (!startTimeStr) return null;
    
    const startTime = new Date(startTimeStr.replace(' ', 'T') + '+03:00').getTime();
    const now = new Date().getTime();
    
    let diffSeconds = Math.floor((now - startTime) / 1000);
    if (diffSeconds < 0) diffSeconds = 0;
    
    let minutes = Math.floor(diffSeconds / 60);
    
    if (match.status === 1) {
        // Фолбэк без broadcast: после 60 мин считаем перерывом
        if (minutes >= 60) return "Перерыв";
        return minutes > 45 ? `45+${minutes - 45}'` : `${minutes}'`;
        } else if (match.status === 2) {
        // Хак с перерывом — только если broadcast не подтвердил начало 2-го тайма
        if (!secondHalfConfirmed && minutes < 15) return "Перерыв";
        let total = 45 + minutes;

        // Страховка: если dateStartStatus врёт, ориентируемся на последнее событие 2-го тайма
        if (secondHalfConfirmed && broadcastEvents && broadcastEvents.length) {
            const times = broadcastEvents
                .filter(e => e.periodNumber === 2 && typeof e.time === 'number')
                .map(e => e.time);
            const lastEventMin = Math.max(45, ...times);
            if (Math.abs(total - lastEventMin) > 6) total = lastEventMin;
        }

        return total > 90 ? `90+${total - 90}'` : `${total}'`;
    } else if (match.status === 3) {
        // Хак с перерывом — только если broadcast не подтвердил начало 2-го тайма
        if (!secondHalfConfirmed && minutes < 15) return "Перерыв";
        
        // Если это 2-й тайм (confirmed), но API ошибочно поставил статус 3
        if (secondHalfConfirmed) {
            const total = 45 + minutes;
            return total > 90 ? `90+${total - 90}'` : `${total}'`;
        }
        
        // Если это реальное доп. время (овертайм)
        return `${90 + minutes}'`;
    }
    
    return null;
}

// Возвращает красивый текст статуса (например, "1-й тайм, 23'")
function getMatchStatusDisplay(match, broadcastEvents = null) {
    if (!match) return { text: "Нет данных", isLive: false, minute: null };

    // ─── Ранний выход для завершённых и не начавшихся матчей ───
    // Делаем это ДО анализа broadcast, иначе неполный/частичный broadcast
    // (например, есть GamePeriodEnd(1), но ещё нет GamePeriodOpen(2))
    // ошибочно покажет "Перерыв" для уже завершённого матча.
    if (match.status === 4) {
        return { text: "Завершён", isLive: false, minute: null };
    }
    if (match.status === 0) {
        return { text: "Не начался", isLive: false, minute: null };
    }

    // 1. Самая надежная проверка — по событиям из broadcast
    if (broadcastEvents && broadcastEvents.length > 0) {
        let isHalf1Ended = false;
        let isHalf2Started = false;
        let isHalf2Ended = false;

        for (const e of broadcastEvents) {
            if (e.type === "GamePeriodEnd") {
                if (e.periodNumber === 1) isHalf1Ended = true;
                if (e.periodNumber === 2) isHalf2Ended = true;
            }
            if (e.type === "GamePeriodOpen") {
                if (e.periodNumber === 2) isHalf2Started = true;
            }
        }

        // 2-й тайм официально закрыт в broadcast (GamePeriodEnd, periodNumber: 2)
        // → матч завершён. Это ФИНАЛЬНЫЙ факт, broadcast приоритетнее поля status.
        // Проверяем РАНЬШЕ "Перерыва", иначе неполный broadcast (есть GamePeriodEnd(1),
        // но ещё нет GamePeriodOpen(2)) ошибочно покажет "Перерыв" для завершённого матча.
        if (isHalf2Ended) {
            return { text: "Завершён", isLive: false, minute: null };
        }

        // Если 1-й тайм закончился, но 2-й еще не начался — это ПЕРЕРЫВ.
        // Сюда доходим только если isHalf2Ended === false (второй тайм не закрыт),
        // поэтому status !== 4 здесь не нужен — но оставим на всякий случай.
        if (isHalf1Ended && !isHalf2Started && match.status !== 4) {
            return { text: "Перерыв", isLive: true, minute: null };
        }

        // Проверяем, есть ли события овертайма
        let isOvertimeStarted = false;
        for (const e of broadcastEvents) {
            if (e.type === "GamePeriodOpen" && (e.periodNumber === 3 || e.periodNumber === 4)) {
                isOvertimeStarted = true;
            }
        }

        // Если 2-й тайм уже начался, но еще не закончился
        if (isHalf2Started && !isHalf2Ended) {
            const liveMinute = calculateMatchMinute(match, true, broadcastEvents);
            
            // Если статус 3 (Доп. время), но событий овертайма нет — показываем обычный 2-й тайм
            if (match.status === 3 && !isOvertimeStarted) {
                return { text: `2-й тайм${liveMinute ? `, ${liveMinute}` : ''}`, isLive: true, minute: liveMinute };
            }
            
            return { text: `2-й тайм${liveMinute ? `, ${liveMinute}` : ''}`, isLive: true, minute: liveMinute };
        }
    }

    // 2. Если событий нет — отталкиваемся от статуса и времени
    const liveMinute = calculateMatchMinute(match);

    // Если calculateMatchMinute вернула "Перерыв" (сработал костыль по времени) — показываем его
    if (liveMinute === "Перерыв") {
        return { text: "Перерыв", isLive: true, minute: null };
    }

    switch (match.status) {
        case 0:
            return { text: "Не начался", isLive: false, minute: null };
        case 1:
            return { text: `1-й тайм${liveMinute ? `, ${liveMinute}` : ''}`, isLive: true, minute: liveMinute };
        case 2:
            return { text: `2-й тайм${liveMinute ? `, ${liveMinute}` : ''}`, isLive: true, minute: liveMinute };
        case 3:
            return { text: `Доп. время${liveMinute ? `, ${liveMinute}` : ''}`, isLive: true, minute: liveMinute };
        case 4:
            return { text: "Завершён", isLive: false, minute: null };
        case 5:
            return { text: "Перерыв", isLive: true, minute: null };
        default:
            return { text: "Идёт матч", isLive: true, minute: null };
    }
}

function formatTeamName(name) {
  if (!name) return "?";
  return TEAM_RENAMES[name] || name;
}

// Универсальная функция для вывода логотипа команды (или заглушки с буквой)
function getTeamLogoHtml(club, className = "team-logo-img", size = 24) {
    if (!club) return "";
    const logoBase = `${DATA_BASE}/`;
    
    if (club.logo) {
        return `<img src="${logoBase}${club.logo}" class="${className}" alt="${formatTeamName(club.name)}">`;
    }
    
    const teamName = formatTeamName(club.name);
    const color = TEAM_COLORS[teamName] || club.color || "#9ca3af";
    const shortName = teamName.substring(0, 1).toUpperCase();
    return `<div class="team-logo ${className}" style="background:${color};">${shortName}</div>`;
}

// Формат имени игрока:
// 1. Если nickname есть — только он.
// 2. Иначе — public_name + public_lastname (если есть хоть что-то).
// 3. Иначе — name + lastname.
function formatPlayerName(player) {
  if (!player) return "";
  
  const nickname = (player.nickname || "").trim();
  if (nickname) return nickname;
  
  // Для игроков из players_all.json
  const pubName = (player.public_name || "").trim();
  const pubLastname = (player.public_lastname || "").trim();
  if (pubName || pubLastname) {
    const shortName = pubName ? pubName.split(' ')[0] : "";
    return `${shortName} ${pubLastname}`.trim();
  }
  
  // Для тренеров и остальных
  const name = (player.name || "").trim();
  const lastname = (player.lastname || "").trim();
  
  const shortName = name ? name.split(' ')[0] : "";
  
  // Берем только первое слово из фамилии (например, из "Альба Кабельо" сделает "Альба")
  const shortLastname = lastname ? lastname.split(' ')[0] : "";
  
  return `${shortName} ${shortLastname}`.trim();
}

// ─────────────────────────────────────────────
// ЕДИНОЕ ФОРМАТИРОВАНИЕ ДАТ (всегда МСК)
// ─────────────────────────────────────────────
// Тайм-зона пользователя (автоопределение браузера).
// Фолбэк — Europe/Moscow, если браузер не отдал зону.
const USER_TZ = (() => {
    try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone || "Europe/Moscow";
    } catch (e) {
        return "Europe/Moscow";
    }
})();

// Оставляем алиас, чтобы не менять все formatMatch* функции —
// они используют MSK_TZ, но теперь это зона пользователя.
const MSK_TZ = USER_TZ;

// Нормализация строки даты.
// Поддерживает форматы:
//   "2026-10-31UTC17:30:00"  → 2026-10-31T17:30:00+03:00
//   "2026-10-31T17:30:00Z"   → как есть (UTC)
//   "2026-10-31T17:30:00"    → дописываем +03:00
function normalizeMatchDate(dateString) {
    if (!dateString) return null;
    let s = String(dateString).trim();

    // "YYYY-MM-DDUTC HH:MM[:SS[.mmm]]" → "YYYY-MM-DDTHH:MM[:SS[.mmm]]+03:00"
    s = s.replace(/^(\d{4}-\d{2}-\d{2})UTC(\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)$/, '$1T$2+03:00');

    // Если зоны всё ещё нет — считаем московской
    if (!/(Z|[+-]\d{2}:?\d{2})$/.test(s)) {
        s = s.replace(' ', 'T') + '+03:00';
    }

    const d = new Date(s);
    return isNaN(d.getTime()) ? null : d;
}

// Возвращает true, если дата = "время не назначено"
// (полночь без реального времени: "2027-02-28UTC00:00:00" или "...T00:00:00")
function isTimeUnknown(dateString) {
    if (!dateString) return true;
    return /[T ]00:00(?::00(?:\.0+)?)?$/.test(String(dateString).replace('UTC', 'T'));
}

// Основной форматтер: "31.10.2026, 17:30"
function formatMatchDateTime(dateString, opts = {}) {
    const d = normalizeMatchDate(dateString);
    if (!d) return dateString || "";
    return d.toLocaleString("ru-RU", {
        timeZone: MSK_TZ,
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        ...opts
    });
}

// Только время: "17:30"
function formatMatchTime(dateString) {
    const d = normalizeMatchDate(dateString);
    if (!d) return "";
    return d.toLocaleTimeString("ru-RU", {
        timeZone: MSK_TZ,
        hour: '2-digit',
        minute: '2-digit'
    });
}

// Только дата: "31.10.2026"
function formatMatchDateOnly(dateString) {
    const d = normalizeMatchDate(dateString);
    if (!d) return "";
    return d.toLocaleDateString("ru-RU", {
        timeZone: MSK_TZ,
        day: '2-digit',
        month: '2-digit',
        year: 'numeric'
    });
}

// Длинный заголовок группы в календаре: "Суббота, 31 октября 2026 г."
function formatMatchDateLong(dateString) {
    const d = normalizeMatchDate(dateString);
    if (!d) return "";
    return d.toLocaleDateString("ru-RU", {
        timeZone: MSK_TZ,
        weekday: 'long',
        day: 'numeric',
        month: 'long',
        year: 'numeric'
    });
}

// ─────────────────────────────────────────────
// ХЕЛПЕРЫ (единая точка для повторяющейся логики)
// ─────────────────────────────────────────────

// 1. Компараторы сортировки матчей по дате
function compareMatchesByDateAsc(a, b) {
    return (normalizeMatchDate(a.date)?.getTime() || 0) - (normalizeMatchDate(b.date)?.getTime() || 0);
}
function compareMatchesByDateDesc(a, b) {
    return (normalizeMatchDate(b.date)?.getTime() || 0) - (normalizeMatchDate(a.date)?.getTime() || 0);
}

// 2. Отображение даты-времени для строки календаря/профиля клуба
function getMatchDateTimeDisplay(match) {
    if (!match.stadium || isTimeUnknown(match.date)) {
        return { isUnknown: true, time: "", dateTimeStr: "Время не назначено" };
    }
    const time = formatMatchTime(match.date);
    const dateTimeStr = formatMatchDateOnly(match.date) + ", " + time;
    return { isUnknown: false, time, dateTimeStr };
}

// 3. Отображение счёта и статуса
function getMatchScoreDisplay(match, broadcastEvents = null) {
    // Используем нашу новую функцию для получения красивого текста
    const statusInfo = getMatchStatusDisplay(match, broadcastEvents);
    
    if (match.status === 4) {
        return {
            score: `${match.goalH} - ${match.goalA}`,
            statusText: statusInfo.text,
            isLive: false
        };
    }
    
    if (match.status !== 0) {
        // Для живых матчей (идет, перерыв, доп. время) добавляем пульсирующую точку
        const livePrefix = statusInfo.isLive ? `<span class="live-dot live-dot--inline"></span>` : '';
        return {
            score: `${match.goalH || 0} - ${match.goalA || 0}`,
            statusText: `${livePrefix}${statusInfo.text}`,
            isLive: statusInfo.isLive
        };
    }
    
    // Для будущих матчей в календаре оставляем статус пустым (в главном меню он перезаписывается на дату)
    return { score: "— : —", statusText: "", isLive: false };
}

// 4. Класс подсветки результата для клуба
function getMatchResultClass(match, clubId) {
    if (match.status !== 4) return "";
    const isHome = match.homeId === clubId;
    const isAway = match.awayId === clubId;
    if (!isHome && !isAway) return "";

    const goalsFor = isHome ? match.goalH : match.goalA;
    const goalsAgainst = isHome ? match.goalA : match.goalH;

    if (goalsFor > goalsAgainst) return "res-win";
    if (goalsFor < goalsAgainst) return "res-loss";
    return "res-draw";
}

// 5. HTML для колонки со стадионом
function getStadiumInfoHtml(match, { emptyClass = false } = {}) {
    const info = getStadiumInfo(match);
    if (!info) {
        return emptyClass
            ? `<div class="cal-info-empty">Стадион не назначен</div>`
            : "Стадион не назначен";
    }
    return `<div>${info.city}</div><div>${info.stadium}</div>`;
}

// 6. Установить значение в кастомном селекте
function setCustomSelectValue(type, value, labelText) {
    const labelEl = document.getElementById(`label-${type}`);
    if (labelEl) labelEl.textContent = labelText;

    const optionsEl = document.getElementById(`options-${type}`);
    if (optionsEl) {
        optionsEl.querySelectorAll('.select-option').forEach(opt => {
            opt.classList.remove('selected');
            if (opt.getAttribute('data-value') === String(value)) {
                opt.classList.add('selected');
            }
        });
    }
}

// 7. Переключиться на вкладку «Календарь»
function switchToCalendarTab() {
    const btn = Array.from(document.querySelectorAll('.tab-btn'))
        .find(b => b.textContent === 'Календарь');
    if (btn) switchTab('calendar', { target: btn });
}

// 8. Последние 5 завершённых матчей клуба
function getClubLast5Matches(clubId) {
    return allCalendarMatches
        .filter(m => m.status === 4 && (m.homeId === clubId || m.awayId === clubId))
        .sort(compareMatchesByDateAsc)
        .slice(-5);
}

// 9. Расчёт статистики матча
function calculateMatchStats(events, homeClubId, awayClubId, half = 'all') {
    const stats = {
        corner: { h: 0, a: 0 },
        shot: { h: 0, a: 0 },
        shotOnTarget: { h: 0, a: 0 },
        foul: { h: 0, a: 0 },
        offside: { h: 0, a: 0 },
        yellow: { h: 0, a: 0 },
        red: { h: 0, a: 0 },
    };
    events.forEach(e => {
        const evHalf = (e.time <= 45) ? '1' : '2';
        if (half !== 'all' && evHalf !== half) return;
        const isHome = e.club === homeClubId;
        const isAway = e.club === awayClubId;
        if (!isHome && !isAway) return;
        const side = isHome ? 'h' : 'a';
        if (e.action === "Corner") stats.corner[side]++;
        else if (e.action === "Shot") stats.shot[side]++;
        else if (e.action === "ShotOnTarget") stats.shotOnTarget[side]++;
        else if (e.action === "Foul") stats.foul[side]++;
        else if (e.action === "Offside") stats.offside[side]++;
        else if (e.action === "YellowCard") stats.yellow[side]++;
        else if (e.action === "RedCard") stats.red[side]++;
    });
    return stats;
}

// 10. HTML строк статистики
function renderStatsRowsHtml(stats) {
    const statRow = (label, h, a) => {
        const total = h + a;
        const hPct = total > 0 ? (h / total) * 100 : 50;
        return `
            <div class="stat-row">
                <div class="stat-labels">
                    <span>${h}</span>
                    <span class="stat-label-text">${label}</span>
                    <span>${a}</span>
                </div>
                <div class="stat-bar">
                    <div class="stat-bar-home" style="width: ${hPct}%;"></div>
                    <div class="stat-bar-away" style="width: ${100 - hPct}%;"></div>
                </div>
            </div>
        `;
    };
    return `
        ${statRow('Угловые', stats.corner.h, stats.corner.a)}
        ${statRow('Удары', stats.shot.h, stats.shot.a)}
        ${statRow('Удары в створ', stats.shotOnTarget.h, stats.shotOnTarget.a)}
        ${statRow('Фолы', stats.foul.h, stats.foul.a)}
        ${statRow('Офсайды', stats.offside.h, stats.offside.a)}
        ${statRow('Жёлтые карточки', stats.yellow.h, stats.yellow.a)}
        ${stats.red.h + stats.red.a > 0 ? statRow('Красные карточки', stats.red.h, stats.red.a) : ''}
    `;
}

const TEAM_COLORS = {
  "Зенит": "#0055a5", "Спартак": "#d10000", "Краснодар": "#006d3d",
  "ЦСКА": "#b3001b", "Динамо": "#0055a5", "Локомотив": "#c00000",
  "Рубин": "#8b0000", "Ростов": "#f5c500", "Крылья Советов": "#0055a5",
  "Ахмат": "#008000", "Пари НН": "#0055a5", "Динамо Мх": "#0055a5",
  "Оренбург": "#ff4500", "Сочи": "#000000", "Факел": "#0000ff",
  "Акрон": "#800080", "Балтика": "#0055a5", "Химки": "#d10000",
  "Динамо-Москва": "#0055a5"
};

// Маппинг ID стран (из API premierliga) → ISO 3166-1 alpha-2 (для флагов)
const COUNTRY_ISO = {
  1: "ua", 2: "ru", 3: "kz", 4: "uz", 5: "tm", 6: "ge",
  8: "bg", 9: "am", 10: "by", 11: "cr", 12: "mk", 13: "ro",
  14: "az", 15: "ar", 16: "ba", 17: "br", 18: "hu", 19: "it",
  20: "cm", 21: "kg", 23: "lv", 24: "lt", 25: "md", 26: "ng",
  27: "pl", 29: "sn", 30: "cs", 31: "sk", 32: "si", 33: "tj",
  34: "hr", 35: "cz", 36: "ee", 37: "za", 38: "ma", 40: "be",
  41: "uy", 42: "mz", 43: "py", 44: "tr", 45: "cl", 46: "mw",
  47: "gb", 48: "gr", 50: "pe", 51: "gh", 52: "ca", 61: "fr",
  81: "ve", 82: "pt", 83: "no", 84: "ao", 85: "cy", 86: "kr",
  101: "at", 102: "jm", 103: "pa", 104: "ch", 105: "ml", 106: "ci",
  107: "zw", 109: "fi", 110: "gn", 111: "co", 130: "de", 150: "vc",
  170: "il", 190: "al", 210: "es", 230: "dk", 231: "nl", 232: "gb-eng",
  250: "se", 251: "nz", 270: "is", 290: "gb-sct", 291: "au", 310: "rs",
  311: "sl", 312: "tn", 313: "jp", 330: "gb-wls", 331: "ie", 332: "mx",
  333: "us", 350: "mc", 370: "gy", 371: "eg", 390: "zm", 410: "cg",
  430: "cd", 450: "bf", 470: "tg", 490: "bj", 530: "rs", 531: "me",
  550: "kp", 570: "ir", 590: "na", 610: "ec", 630: "ne", 632: "bo",
  633: "lr", 634: "sv", 638: "td", 639: "ga", 640: "cv", 641: "tt",
  642: "lu", 643: "et", 645: "qa", 646: "iq", 647: "gm", 648: "bi",
  649: "cn", 650: "sa", 651: "ae", 652: "dz", 653: "gw", 654: "ly",
  655: "ye", 656: "sd", 657: "sr", 658: "mt", 659: "hn", 660: "in"
};

// Маппинг русских названий стран → ISO (для тренеров, у которых приходит текст)
const COUNTRY_NAME_TO_ISO = {
  "Россия": "ru", "Украина": "ua", "Беларусь": "by", "Казахстан": "kz",
  "Узбекистан": "uz", "Туркменистан": "tm", "Грузия": "ge", "Болгария": "bg",
  "Армения": "am", "Коста-Рика": "cr", "Северная Македония": "mk", "Румыния": "ro",
  "Азербайджан": "az", "Аргентина": "ar", "Босния и Герцеговина": "ba", "Бразилия": "br",
  "Венгрия": "hu", "Италия": "it", "Камерун": "cm", "Кыргызстан": "kg",
  "Латвия": "lv", "Литва": "lt", "Молдова": "md", "Нигерия": "ng",
  "Польша": "pl", "Сенегал": "sn", "Сербия": "rs", "Словакия": "sk",
  "Словения": "si", "Таджикистан": "tj", "Хорватия": "hr", "Чехия": "cz",
  "Эстония": "ee", "ЮАР": "za", "Марокко": "ma", "Бельгия": "be",
  "Уругвай": "uy", "Мозамбик": "mz", "Парагвай": "py", "Турция": "tr",
  "Чили": "cl", "Малави": "mw", "Великобритания": "gb", "Греция": "gr",
  "Перу": "pe", "Гана": "gh", "Канада": "ca", "Франция": "fr",
  "Венесуэла": "ve", "Португалия": "pt", "Норвегия": "no", "Ангола": "ao",
  "Кипр": "cy", "Южная Корея": "kr", "Австрия": "at", "Ямайка": "jm",
  "Панама": "pa", "Швейцария": "ch", "Мали": "ml", "Кот-д'Ивуар": "ci",
  "Зимбабве": "zw", "Финляндия": "fi", "Гвинея": "gn", "Колумбия": "co",
  "Германия": "de", "Сент-Винсент и Гренадины": "vc", "Израиль": "il",
  "Албания": "al", "Испания": "es", "Дания": "dk", "Нидерланды": "nl",
  "Англия": "gb-eng", "Швеция": "se", "Новая Зеландия": "nz", "Исландия": "is",
  "Шотландия": "gb-sct", "Австралия": "au", "Словения": "sl", "Тунис": "tn",
  "Япония": "jp", "Уэльс": "gb-wls", "Ирландия": "ie", "Мексика": "mx",
  "США": "us", "Монако": "mc", "Гайана": "gy", "Египет": "eg",
  "Замбия": "zm", "Конго": "cg", "ДР Конго": "cd", "Буркина-Фасо": "bf",
  "Того": "tg", "Бенин": "bj", "Черногория": "me", "Северная Корея": "kp",
  "Иран": "ir", "Намибия": "na", "Эквадор": "ec", "Нигер": "ne",
  "Боливия": "bo", "Либерия": "lr", "Сальвадор": "sv", "Чад": "td",
  "Габон": "ga", "Кабо-Верде": "cv", "Тринидад и Тобаго": "tt", "Люксембург": "lu",
  "Эфиопия": "et", "Катар": "qa", "Ирак": "iq", "Гамбия": "gm",
  "Бурунди": "bi", "Китай": "cn", "Саудовская Аравия": "sa", "ОАЭ": "ae",
  "Алжир": "dz", "Гвинея-Бисау": "gw", "Ливия": "ly", "Йемен": "ye",
  "Судан": "sd", "Суринам": "sr", "Мальта": "mt", "Гондурас": "hn",
  "Индия": "in"
};

// Хелпер: получить URL флага по ID (число) или названию (строка)
function getCountryFlagUrl(countryIdOrName) {
  if (!countryIdOrName) return null;
  
  // 1. Если пришло число (ID) — ищем в мэппинге
  if (typeof countryIdOrName === 'number') {
    const iso = COUNTRY_ISO[countryIdOrName];
    return iso ? `./data/current/flags/${iso}.png` : null;
  }
  
  // 2. Если пришла строка (название) — сначала ищем в нашем прямом словаре
  if (typeof countryIdOrName === 'string') {
    const cleanName = countryIdOrName.trim();
    const iso = COUNTRY_NAME_TO_ISO[cleanName];
    if (iso) {
      return `./data/current/flags/${iso}.png`;
    }
    
    // Если в словаре нет, пробуем найти в загруженных странах (на случай нестандартных)
    const country = Object.values(window._countries || {}).find(c => 
      c.name && c.name.toLowerCase() === cleanName.toLowerCase()
    );
    
    if (country) {
      const countryIso = country.iso || country.code || country.shortName;
      if (countryIso) return `./data/current/flags/${countryIso.toLowerCase()}.png`;
      if (country.id && COUNTRY_ISO[country.id]) return `./data/current/flags/${COUNTRY_ISO[country.id]}.png`;
    }
  }
  
  return null;
}

// Хелпер: получить название страны по ID или имени
function getCountryName(countryIdOrName) {
  if (!countryIdOrName) return "";
  if (typeof countryIdOrName === 'string') return countryIdOrName; // Для тренеров уже приходит название
  return window._countries?.[countryIdOrName]?.name || "";
}

// Универсальная функция форматирования даты матча
function getFormattedMatchDate(dateString, isFutureNoDate = false, isOverview = false) {
    if (!dateString) {
        return isOverview ? 'Не указана' : '';
    }
    if (isFutureNoDate || isTimeUnknown(dateString)) {
        return isOverview ? 'Не назначено' : 'Время не назначено';
    }
    return formatMatchDateTime(dateString);
}

// Универсальная функция для вывода имени с флагом
function getPlayerNameWithFlag(person, isRight = false) {
    if (!person) return "";
    
    const name = formatPlayerName(person);
    
    // Пытаемся получить ISO код флага (с учетом того, что у тренеров текст, а у игроков ID)
    let isoCode = null;
    
    if (typeof person.citizenship === 'number') {
        isoCode = COUNTRY_ISO[person.citizenship];
    } else if (typeof person.citizenship === 'string') {
        const cleanName = person.citizenship.trim();
        isoCode = COUNTRY_NAME_TO_ISO[cleanName];
        if (!isoCode && cleanName.length === 2) {
            isoCode = cleanName.toLowerCase(); // На случай, если уже пришло "ru"
        }
    }

    // Флаг не нашли — просто возвращаем имя без флага
    if (!isoCode) return name;

    const flagUrl = `./data/current/flags/${isoCode}.png`;
    const countryName = getCountryName(person.citizenship) || person.citizenship || "Неизвестно";
    const flagHtml = `<img src="${flagUrl}" class="player-flag player-flag--inline" title="${countryName}" alt="${countryName}">`;

    return `<span class="person-with-flag${isRight ? ' person-with-flag--right' : ''}">${flagHtml} <span>${name}</span></span>`;
}

let allMatchesData = [];
let allFlatMatches = [];
let allClubs = {};
let allCalendarMatches = [];
let globalClubsList = [];
let allStadiums = {};
window._seasons = [];
window._stages = [];

// Переключение вкладок
window.switchTab = function(tabId, event) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.content-section').forEach(s => s.classList.remove('active'));
  
  if (event && event.target) {
    event.target.classList.add('active');
  }
  document.getElementById(`tab-${tabId}`).classList.add('active');

  // Если переключаемся на главную или календарь — просто перерисовываем из кэша
  // (не делаем fetch, чтобы не мигало)
  if (tabId === 'matches' && allMatchesData) {
      const grid = document.getElementById("matches-grid");
      if (grid) grid.innerHTML = allMatchesData.map(m => renderMatchCard(m)).join("");
  } else if (tabId === 'calendar') {
      applyCalendarFilters();
  }
};

async function loadJSON(name) {
  const res = await fetch(`${DATA_BASE}/${name}.json`);
  if (!res.ok) throw new Error(`Не удалось загрузить ${name}.json`);
  return res.json();
}

async function init() {
  try {
    const [standings, matches, currentTour, seasons, clubs, stages] = await Promise.all([
      loadJSON("standings"),
      loadJSON("matches_flat"),
      loadJSON("current_tour").catch(() => null),
      fetch("./data/seasons.json").then(r => r.json()).catch(() => null),
      loadJSON("clubs").catch(() => []),
      loadJSON("stages").catch(() => [])
    ]);
    window._stages = stages || [];
    
    if (seasons && seasons.length > 0) {
      window._seasons = seasons;
    if (currentTour) {
      const tourTitleEl = document.getElementById("tour-title");
      if (tourTitleEl) tourTitleEl.textContent = currentTour.name;
    }
    }

    // Показываем, в какой зоне отображается время
    try {
      const tzLabel = new Intl.DateTimeFormat("ru-RU", {
          timeZone: USER_TZ,
          timeZoneName: 'short'
      }).formatToParts(new Date()).find(p => p.type === 'timeZoneName')?.value || USER_TZ;
      const noteEl = document.getElementById("timezone-note");
      if (noteEl) noteEl.textContent = `Время указано в вашей зоне: ${tzLabel}`;
    } catch (e) {
      console.warn("Не удалось определить тайм-зону", e);
    }

    // Загрузка стран для флагов
    try {
      const countriesRes = await fetch(`./data/frontend/countries/countries.json`);
      if (countriesRes.ok) {
        const countries = await countriesRes.json();
        window._countries = {};
        countries.forEach(c => {
          if (c.id) window._countries[c.id] = c;
        });
        console.log(`Загружено стран: ${countries.length}`);
      }
    } catch (e) {
      console.warn("Не удалось загрузить countries.json", e);
    }

    if (clubs && clubs.length > 0) {
        globalClubsList = clubs;
        clubs.forEach(c => allClubs[c.id] = c);
        
        // Загружаем один общий файл со стадионами
        try {
            const res = await fetch(`${DATA_BASE}/stadiums.json`);
            if (res.ok) {
                const stadiumsData = await res.json();
                Object.keys(stadiumsData).forEach(clubId => {
                    if (stadiumsData[clubId] && stadiumsData[clubId].name) {
                        allStadiums[clubId] = stadiumsData[clubId];
                    }
                });
            }
        } catch (e) {
            console.warn("Не удалось загрузить stadiums.json", e);
        }

        // Загружаем единый справочник всех игроков (для гражданства и амплуа)
        try {
            const resPlayers = await fetch(`${DATA_BASE}/players_all.json`);
            if (resPlayers.ok) {
                window._allPlayers = await resPlayers.json();
                console.log(`Справочник игроков загружен (current): ${Object.keys(window._allPlayers).length} чел.`);
            }
        } catch (e) {
            console.warn("Не удалось загрузить players_all.json", e);
            window._allPlayers = {};
        }

        // Загружаем единый справочник ВСЕХ тренеров сезона (включая ушедших)
        try {
            const resStaffs = await fetch(`${DATA_BASE}/staffs_all.json`);
            if (resStaffs.ok) {
                window._allStaffs = await resStaffs.json();
                const totalStaffs = Object.keys(window._allStaffs).length;
                console.log(`Справочник тренеров загружен: ${totalStaffs} чел.`);

                // ─── ДИАГНОСТИКА: ищем тренеров без страны ───
                const missingCitizenship = [];
                Object.values(window._allStaffs).forEach(staff => {
                    // Проверяем, пустое ли поле citizenship
                    if (!staff.citizenship || String(staff.citizenship).trim() === "") {
                        missingCitizenship.push(staff);
                    }
                });

                if (missingCitizenship.length > 0) {
                    console.warn(`⚠️ Найдено тренеров без страны (${missingCitizenship.length} чел.). Добавьте им "citizenship" в staffs_all.json:`);
                    // Выводим красивой таблицей в консоль (в Chrome/Firefox работает)
                    if (console.table) {
                        console.table(missingCitizenship.map(s => ({
                            ID: s.id,
                            Имя: s.name,
                            Фамилия: s.lastname,
                            Клуб: s.club || "—"
                        })));
                    } else {
                        // Фолбэк для старых браузеров
                        missingCitizenship.forEach(s => console.log(`- ID: ${s.id}, ${s.name} ${s.lastname}`));
                    }
                } else {
                    console.log("✅ У всех тренеров в справочнике указана страна.");
                }
                // ─────────────────────────────────────────────

            } else {
                window._allStaffs = {};
                console.warn("Файл staffs_all.json не найден на сервере.");
            }
        } catch (e) {
            console.warn("Не удалось загрузить staffs_all.json", e);
            window._allStaffs = {};
        }
    }

    allFlatMatches = matches;

        // ─── ПОДГРУЗКА ВРЕМЕНИ НАЧАЛА (dateStartStatus) И СОБЫТИЙ ДЛЯ ВСЕХ МАТЧЕЙ ───
    if (!window._currentMatchBroadcast) window._currentMatchBroadcast = {};

    // Собираем ID ВСЕХ матчей (и с главной, и из календаря)
    const allMatchIds = new Set();
    if (matches) matches.forEach(m => allMatchIds.add(m.matchId || m.id));
    if (currentTour && currentTour.matches) currentTour.matches.forEach(m => allMatchIds.add(m.id));

    const detailPromises = Array.from(allMatchIds).map(async (matchId) => {
        // Ищем матч во всех источниках: на главной, в текущем туре и в календаре (matches)
        const flatM = allMatchesData.find(x => x.id === matchId)
                   || (currentTour?.matches || []).find(x => x.id === matchId);
                   
        // Ищем этот же матч в matches_flat (для календаря)
        const calM = matches.find(x => (x.matchId || x.id) === matchId);
        
        // Берем статус из любого найденного источника
        const status = flatM?.status ?? calM?.status;

        // 1. Детали нужны только для live-матчей (чтобы взять dateStartStatus)
        const needsDetail = status === 1 || status === 2 || status === 3;
        const needsEvents = needsDetail; // события нужны только live

        if (needsDetail) {
            try {
                const res = await fetch(`${DATA_BASE}/matches/match_${matchId}.json`, { cache: 'no-store' });
                if (res.ok) {
                    const detailData = await res.json();
                    if (detailData?.dateStartStatus) {
                        // Сохраняем в данные главной страницы
                        if (flatM) flatM.dateStartStatus = detailData.dateStartStatus;
                        // Сохраняем в данные календаря
                        if (calM) calM.dateStartStatus = detailData.dateStartStatus;
                    }
                }
            } catch (e) {}
        }

    if (needsEvents) {
        try {
            const evRes = await fetch(`${DATA_BASE}/matches/events_${matchId}.json`, { cache: 'no-store' });
            if (evRes.ok) {
                const ev = await evRes.json();
                window._currentMatchBroadcast[matchId] = ev.broadcast || [];
            }
        } catch (e) {}
    }
});
    
    // Ждем загрузки всех деталей
    await Promise.all(detailPromises);
    // ─────────────────────────────────────────────────────────────────

    const matchesGrid = document.getElementById("matches-grid");
    if (currentTour && currentTour.matches) {
      allMatchesData = [...currentTour.matches].sort((a, b) => {
        const aIsLive = (a.status !== 4 && a.status !== 0);
        const bIsLive = (b.status !== 4 && b.status !== 0);
        if (aIsLive && !bIsLive) return -1;
        if (!aIsLive && bIsLive) return 1;
        return compareMatchesByDateAsc(a, b);
      });
      matchesGrid.innerHTML = allMatchesData.map(m => renderMatchCard(m)).join("");
    }

    allCalendarMatches = matches;
    populateFilters();

    renderCalendar(allCalendarMatches);

    renderClubs();

    const tbody = document.querySelector("#standings-table tbody");
    if (standings) {
      tbody.innerHTML = standings.map(r => {
        const teamName = formatTeamName(r.club);
        const color = TEAM_COLORS[teamName] || "#9ca3af";
        const shortName = teamName.substring(0, 1).toUpperCase();
        const clubInfo = allClubs[r.clubId]; 
        const logoBase = `${DATA_BASE}/`;

        const logoHtml = clubInfo?.logo 
            ? `<img src="${logoBase}${clubInfo.logo}" class="team-logo-img standings-logo" alt="${teamName}">` 
            : `<div class="team-logo standings-logo" style="background:${color};">${shortName}</div>`;

        let formHtml = "";
        if (r.form && r.form.length > 0) {
            formHtml = r.form.map((type, index) => {
                let letter = "";
                if (type === 'w') letter = "В";
                else if (type === 'd') letter = "Н";
                else if (type === 'l') letter = "П";
                
                return `<div class="form-dot form-${type} team-clickable" data-club="${r.clubId}" data-idx="${index}" onclick="event.stopPropagation(); filterByMatchForm(${r.clubId}, ${index})">${letter}</div>`;
            }).join("");
        } else {
            formHtml = "<span class='form-empty'>—</span>";
        }

        return `
          <tr class="team-clickable" onclick="openClubModal(${r.clubId})">
            <td>${r.position}</td>
            <td>
              ${logoHtml}
              ${teamName}
            </td>
            <td>${r.played}</td>
            <td>${r.won}</td>
            <td>${r.drawn}</td>
            <td>${r.lost}</td>
            <td>${r.goalsFor}-${r.goalsAgainst}</td>
            <td><b>${r.points}</b></td>
            <td>${r.pointsPercent}</td>
            <td><div class="form-dots">${formHtml}</div></td>
          </tr>
        `;
      }).join("");
    }

               // ─── ГЛОБАЛЬНЫЙ ТАЙМЕР ДЛЯ LIVE-ОБНОВЛЕНИЙ ───
    // Сбрасываем время последнего обновления, чтобы не дергать API сразу после init
    window._lastLiveUpdate = Date.now(); 

    // Опрос live-матчей раз в 2 минуты (данные в GitHub Actions обновляются раз в 5 мин)
    setInterval(() => {
        const now = Date.now();
        if (!window._lastLiveUpdate || now - window._lastLiveUpdate > 120000) {
            window._lastLiveUpdate = now;
            updateLiveMatches(); 
        }

        // 1. Обновляем карточки на главной
        if (allMatchesData && allMatchesData.length > 0) {
            allMatchesData.forEach(m => {
                if (m.status !== 0) { // Обновляем и живые, и завершенные (если они есть в кэше)
                    const badge = document.getElementById(`match-badge-${m.id}`);
                    if (badge) {
                        // Берем события из кэша (если они есть)
                        const broadcast = window._currentMatchBroadcast && window._currentMatchBroadcast[m.id || m.matchId] 
                            ? window._currentMatchBroadcast[m.id || m.matchId] 
                            : null;
                        const statusInfo = getMatchStatusDisplay(m, broadcast);
                        
                        // Находим точку внутри бейджа (если она есть)
                        const existingDot = badge.querySelector('.live-dot');
                        
                        if (statusInfo.isLive) {
                            // Если точка уже есть — просто обновляем текст
                            if (existingDot) {
                                // Убираем старый текст, оставляем точку
                                badge.innerHTML = '';
                                badge.appendChild(existingDot);
                                badge.appendChild(document.createTextNode(statusInfo.text));
                            } else {
                                // Если точки нет (например, матч только что начался) — добавляем
                                badge.innerHTML = `<span class="live-dot"></span>${statusInfo.text}`;
                            }
                            badge.classList.add('live-status');
                        } else {
                            // Матч закончился — убираем точку и класс
                            badge.innerHTML = statusInfo.text;
                            badge.classList.remove('live-status');
                        }
                    }
                }
            });
        }

        // 2. Обновляем статусы в календаре
        if (allCalendarMatches && allCalendarMatches.length > 0) {
            allCalendarMatches.forEach(m => {
                if (m.status !== 0) { // Обновляем и живые, и завершенные
                    const statusEl = document.getElementById(`cal-status-${m.matchId || m.id}`);
                    if (statusEl) {
                        const broadcast = window._currentMatchBroadcast && window._currentMatchBroadcast[m.matchId || m.id] ? window._currentMatchBroadcast[m.matchId || m.id] : null;
                        const statusInfo = getMatchStatusDisplay(m, broadcast);
                        
                        // Для календаря делаем так же: сохраняем точку, обновляем текст
                        const existingDot = statusEl.querySelector('.live-dot');
                        
                        if (statusInfo.isLive) {
                            if (existingDot) {
                                statusEl.innerHTML = '';
                                statusEl.appendChild(existingDot);
                                statusEl.appendChild(document.createTextNode(statusInfo.text));
                            } else {
                                statusEl.innerHTML = `<span class="live-dot live-dot--inline"></span>${statusInfo.text}`;
                            }
                            statusEl.parentElement.classList.add('live');
                        } else {
                            statusEl.innerHTML = statusInfo.text;
                            statusEl.parentElement.classList.remove('live');
                        }
                    }
                }
            });
        }
    }, 1000);

  } catch (e) {
    console.error(e);
    document.getElementById("matches-grid").innerHTML = `<div class="load-error">Ошибка: ${e.message}</div>`;
  }
}

function renderMatchCard(m) {
    const flatMatch = allFlatMatches.find(f => f.matchId === m.id);
    const homeClub = allClubs[m.clubH];
    const awayClub = allClubs[m.clubA];

    const homeName = formatTeamName(flatMatch?.home || homeClub?.name);
    const awayName = formatTeamName(flatMatch?.away || awayClub?.name);

    const homeLogoHtml = getTeamLogoHtml(homeClub, "team-logo-img", 29);
    const awayLogoHtml = getTeamLogoHtml(awayClub, "team-logo-img", 29);

    const scoreH = m.goalH !== null ? m.goalH : "—";
    const scoreA = m.goalA !== null ? m.goalA : "—";

    // Получаем события для проверки перерыва (если они уже загружены)
    const broadcast = window._currentMatchBroadcast && window._currentMatchBroadcast[m.id] ? window._currentMatchBroadcast[m.id] : null;
    const statusInfo = getMatchStatusDisplay(m, broadcast);
    let statusText = statusInfo.text;
    let isLive = statusInfo.isLive;

    // Если матч идет, добавляем пульсирующую точку
    if (isLive) {
        statusText = `<span class="live-dot"></span>${statusText}`;
    }

    // Если матч еще не начался (status 0), принудительно показываем дату и время
    if (m.status === 0) {
        if (isTimeUnknown(m.date)) {
            statusText = "Время не назначено";
        } else {
            const d = normalizeMatchDate(m.date);
            if (d) {
                // Получаем день недели (сб, вс, пн...)
                const weekday = d.toLocaleDateString("ru-RU", { timeZone: USER_TZ, weekday: 'short' }).replace('.', '');
                // Получаем день и месяц в формате ДД.ММ (31.10)
                const dayMonth = d.toLocaleDateString("ru-RU", { timeZone: USER_TZ, day: '2-digit', month: '2-digit' });
                // Получаем время ЧЧ:ММ (18:00)
                const timeStr = formatMatchTime(m.date);
                
                statusText = `${weekday}, ${dayMonth}, ${timeStr}`;
            } else {
                statusText = "Время не назначено";
            }
        }
    }

    const stadium = m.stadium || "Стадион";
    const tourName = flatMatch ? flatMatch.tour : (m.tour || 'Тур');

    return `
      <div class="match-card ${isLive ? 'live' : ''}" onclick="openMatchModal(${m.id})">
                <div class="match-header">
          <span>${tourName}</span>
          <span class="badge ${isLive ? 'live-status' : ''}" id="match-badge-${m.id}">
            ${isLive ? `<span class="live-dot"></span>` : ''}${statusText}
          </span>
        </div>
        
        <div class="team-row">
          <div class="team-info team-clickable" onclick="event.stopPropagation(); openClubModal(${m.clubH})">
            ${homeLogoHtml}
            ${homeName}
          </div>
          <div class="team-score">${scoreH}</div>
        </div>
        
        <div class="team-row">
          <div class="team-info team-clickable" onclick="event.stopPropagation(); openClubModal(${m.clubA})">
            ${awayLogoHtml}
            ${awayName}
          </div>
          <div class="team-score">${scoreA}</div>
        </div>

        <div class="match-footer">
          <span class="stadium-name" title="${stadium}">${String(stadium).startsWith('«') ? stadium : `«${stadium}»`}</span>
          <span class="match-watch">Смотреть</span>
        </div>
      </div>
    `;
}

// ─── ФУНКЦИЯ ОБНОВЛЕНИЯ ЖИВЫХ МАТЧЕЙ (СЧЕТ, ГОЛЫ, СОБЫТИЯ) ───
async function updateLiveMatches() {
    // Собираем ВСЕ матчи, которые могут быть в лайве (статусы 1, 2, 3)
    const liveIds = new Set();
    
    if (allMatchesData) {
        allMatchesData.filter(m => m.status !== 0 && m.status !== 4).forEach(m => liveIds.add(m.id));
    }
    if (allCalendarMatches) {
        allCalendarMatches.filter(m => m.status !== 0 && m.status !== 4).forEach(m => liveIds.add(m.matchId || m.id));
    }

    if (liveIds.size === 0) return;

    for (const matchId of liveIds) {
        try {
            // 1. Запрашиваем детали матча (там есть счет)
            const res = await fetch(`${DATA_BASE}/matches/match_${matchId}.json`);
            if (res.ok) {
                const freshData = await res.json();
                
                // Обновляем данные в памяти
                const updateObj = (list, isCalendar) => {
                    const m = list.find(x => (isCalendar ? (x.matchId === matchId || x.id === matchId) : x.id === matchId));
                    if (m) {
                        if (freshData.goalH !== undefined) m.goalH = freshData.goalH;
                        if (freshData.goalA !== undefined) m.goalA = freshData.goalA;
                        if (freshData.status !== undefined) m.status = freshData.status;
                        if (freshData.dateStartStatus) m.dateStartStatus = freshData.dateStartStatus;
                    }
                };
                
                updateObj(allMatchesData, false);
                updateObj(allCalendarMatches, true);

                // Обновляем broadcast, чтобы корректно определять перерыв / 2-й тайм
                try {
                    const evRes = await fetch(`${DATA_BASE}/matches/events_${matchId}.json`, { cache: 'no-store' });
                    if (evRes.ok) {
                        const ev = await evRes.json();
                        window._currentMatchBroadcast = window._currentMatchBroadcast || {};
                        window._currentMatchBroadcast[matchId] = ev.broadcast || [];
                    }
                } catch (_) {}

                // 2. Обновляем визуальную карточку на главной
                const card = document.querySelector(`.match-card[onclick="openMatchModal(${matchId})"]`);
                if (card) {
                    // Обновляем счет
                    const scores = card.querySelectorAll('.team-score');
                    if (scores.length === 2) {
                        scores[0].innerText = freshData.goalH !== null ? freshData.goalH : '—';
                        scores[1].innerText = freshData.goalA !== null ? freshData.goalA : '—';
                    }
                    
                    // Обновляем бейдж на главной (правильный ID - match-badge)
                    const badge = document.getElementById(`match-badge-${matchId}`);
                    if (badge) {
                        // Берем события из кэша!
                        const currentBroadcast = window._currentMatchBroadcast && window._currentMatchBroadcast[matchId] 
                            ? window._currentMatchBroadcast[matchId] 
                            : null;
                        const statusInfo = getMatchStatusDisplay(freshData, currentBroadcast);
                        const existingDot = badge.querySelector('.live-dot');
                        if (statusInfo.isLive) {
                            if (existingDot) {
                                badge.innerHTML = '';
                                badge.appendChild(existingDot);
                                badge.appendChild(document.createTextNode(statusInfo.text));
                            } else {
                                badge.innerHTML = `<span class="live-dot"></span>${statusInfo.text}`;
                            }
                            badge.classList.add('live-status');
                        } else {
                            badge.innerHTML = statusInfo.text;
                            badge.classList.remove('live-status');
                        }
                    }
                }

                // 3. Обновляем счет и статус в календаре
                const calRow = document.querySelector(`.calendar-row[onclick="openMatchModal(${matchId})"]`);
                if (calRow) {
                    const calScore = calRow.querySelector('.cal-score');
                    if (calScore) {
                        calScore.innerText = `${freshData.goalH !== null ? freshData.goalH : '—'} - ${freshData.goalA !== null ? freshData.goalA : '—'}`;
                    }
                    
                    const statusEl = document.getElementById(`cal-status-${matchId}`);
                    if (statusEl) {
                        // Берем события из кэша!
                        const currentBroadcast = window._currentMatchBroadcast && window._currentMatchBroadcast[matchId] 
                            ? window._currentMatchBroadcast[matchId] 
                            : null;
                        const statusInfo = getMatchStatusDisplay(freshData, currentBroadcast);
                        const existingDot = statusEl.querySelector('.live-dot');
                        
                        if (statusInfo.isLive) {
                            if (existingDot) {
                                statusEl.innerHTML = '';
                                statusEl.appendChild(existingDot);
                                statusEl.appendChild(document.createTextNode(statusInfo.text));
                            } else {
                                statusEl.innerHTML = `<span class="live-dot live-dot--inline"></span>${statusInfo.text}`;
                            }
                            statusEl.parentElement.classList.add('live');
                        } else {
                            statusEl.innerHTML = statusInfo.text;
                            statusEl.parentElement.classList.remove('live');
                        }
                    }
                }
            }
        } catch (e) {
            console.warn(`Не удалось обновить матч ${matchId}`, e);
        }
    }
}

function populateFilters() {
    const optionsTour = document.getElementById("options-tour");
    const optionsClub = document.getElementById("options-club");

    optionsTour.innerHTML = '<div class="select-option" data-value="all">Все туры</div>';
    optionsClub.innerHTML = '<div class="select-option" data-value="all">Все клубы</div>';

    const uniqueTours = [...new Set(allCalendarMatches.map(m => m.tour))].filter(Boolean).sort((a, b) => {
        const numA = parseInt(a.replace(/\D/g, ''));
        const numB = parseInt(b.replace(/\D/g, ''));
        return numA - numB;
    });

    uniqueTours.forEach(tour => {
        optionsTour.innerHTML += `<div class="select-option" data-value="${tour}">${tour}</div>`;
    });

    const uniqueClubs = [...globalClubsList].sort((a, b) => {
        const nameA = formatTeamName(a.name);
        const nameB = formatTeamName(b.name);
        return nameA.localeCompare(nameB, 'ru');
    });
    uniqueClubs.forEach(club => {
        const displayName = formatTeamName(club.name);
        optionsClub.innerHTML += `<div class="select-option" data-value="${club.id}">${displayName}</div>`;
    });
    
    setupCustomSelects();
}

let filterState = {
    tour: "all",
    club: "all",
    place: "all",
    status: "all"
};

function toggleDropdown(id) {
    const select = document.getElementById(`custom-${id}`);
    if (select.classList.contains('disabled')) return;

    document.querySelectorAll('.custom-select').forEach(el => {
        if (el.id !== `custom-${id}`) el.classList.remove('open');
    });

    select.classList.toggle('open');
}

function setupCustomSelects() {
    document.querySelectorAll('.select-option').forEach(option => {
        option.addEventListener('click', function(e) {
            e.stopPropagation();
            
            const parentSelect = this.closest('.custom-select');
            const type = parentSelect.id.replace('custom-', '');
            const value = this.getAttribute('data-value');
            const text = this.textContent;

            filterState[type] = value;
            
            document.getElementById(`label-${type}`).textContent = text;
            document.getElementById(`options-${type}`).querySelectorAll('.select-option').forEach(opt => opt.classList.remove('selected'));
            this.classList.add('selected');

            parentSelect.classList.remove('open');

            applyCalendarFilters();
        });
    });
}

document.addEventListener('click', function(e) {
    if (!e.target.closest('.custom-select')) {
        document.querySelectorAll('.custom-select').forEach(el => el.classList.remove('open'));
    }
});

function applyCalendarFilters() {
    const resetBtn = document.getElementById("btn-reset-filters");
    const customPlace = document.getElementById("custom-place");
    const customStatus = document.getElementById("custom-status");
    
    if (filterState.club === "all") {
        customPlace.classList.add('disabled');
        filterState.place = "all";
        document.getElementById("label-place").textContent = "Везде";
    } else {
        customPlace.classList.remove('disabled');
    }

    if (filterState.tour !== "all") {
        customPlace.classList.add('disabled');
        customStatus.classList.add('disabled');
        
        filterState.place = "all";
        filterState.status = "all";
        document.getElementById("label-place").textContent = "Везде";
        document.getElementById("label-status").textContent = "Все";
    } else {
        customStatus.classList.remove('disabled');
        if (filterState.club !== "all") {
             customPlace.classList.remove('disabled');
        }
    }

    const isFiltered = (filterState.tour !== "all" || filterState.club !== "all" || filterState.status !== "all");
    if (isFiltered) {
        resetBtn.classList.remove("hidden");
    } else {
        resetBtn.classList.add("hidden");
    }

    let filtered = allCalendarMatches;

    if (filterState.tour !== "all") {
        filtered = filtered.filter(m => m.tour === filterState.tour);
    }

    if (filterState.club !== "all") {
        const clubId = parseInt(filterState.club);
        if (filterState.place === "home") {
            filtered = filtered.filter(m => m.homeId === clubId);
        } else if (filterState.place === "away") {
            filtered = filtered.filter(m => m.awayId === clubId);
        } else {
            filtered = filtered.filter(m => m.homeId === clubId || m.awayId === clubId);
        }
    }

    if (filterState.status === "future") {
        filtered = filtered.filter(m => m.status === 0);
    } else if (filterState.status === "past") {
        filtered = filtered.filter(m => m.status === 4);
    }

    renderCalendar(filtered);
}

function resetCalendarFilters() {
    filterState = { tour: "all", club: "all", place: "all", status: "all" };
    
    setCustomSelectValue("tour", "all", "Все туры");
    setCustomSelectValue("club", "all", "Все клубы");
    setCustomSelectValue("place", "all", "Везде");
    setCustomSelectValue("status", "all", "Все");

    document.getElementById("custom-place").classList.add('disabled');
    document.getElementById("custom-status").classList.remove('disabled');
    document.getElementById("btn-reset-filters").classList.add("hidden");
    
    renderCalendar(allCalendarMatches);
}

function renderCalendar(matchesData) {
    const calendarList = document.getElementById("calendar-list");
    if (!calendarList) return;

    let sortedMatches = [...matchesData].sort(compareMatchesByDateAsc);
    
    if (filterState.status === "past") {
        sortedMatches.reverse();
    }

    const groupedByDate = {};
    sortedMatches.forEach(m => {
        if (!m.date) return;
        const dateKey = formatMatchDateLong(m.date);
        if (!groupedByDate[dateKey]) groupedByDate[dateKey] = [];
        groupedByDate[dateKey].push(m);
    });

    let html = "";

    for (const [dateTitle, dayMatches] of Object.entries(groupedByDate)) {
        const formattedTitle = dateTitle.charAt(0).toUpperCase() + dateTitle.slice(1);
        
        html += `<h3 class="calendar-date-title">${formattedTitle}</h3>`;
        html += `<div class="calendar-day">`;

        dayMatches.forEach(m => {
            const homeClub = allClubs[m.homeId];
            const awayClub = allClubs[m.awayId];  
            
            const homeLogo = getTeamLogoHtml(homeClub, "cal-logo", 24);
            const awayLogo = getTeamLogoHtml(awayClub, "cal-logo", 24);

            const { dateTimeStr } = getMatchDateTimeDisplay(m);
            // Передаем события broadcast, чтобы сразу отрисовать правильный статус (Перерыв)
            const broadcast = window._currentMatchBroadcast && window._currentMatchBroadcast[m.matchId || m.id] 
                ? window._currentMatchBroadcast[m.matchId || m.id] 
                : null;
            const { score, statusText, isLive } = getMatchScoreDisplay(m, broadcast);
            const statusClass = isLive ? "cal-status live" : "cal-status";
            
            // Оборачиваем текст статуса в span с ID для таймера
            const finalStatusText = `<span id="cal-status-${m.matchId || m.id}">${statusText}</span>`;

            const tourName = m.tour || "";
            const stadium = m.stadium || "";

            // Подсветка результата, если включен фильтр по команде
            let resultClass = "";
            if (filterState.club !== "all") {
                resultClass = getMatchResultClass(m, parseInt(filterState.club));
            }

            html += `
                <div class="calendar-row ${resultClass}${m.status === 4 ? '' : ' no-video'}" onclick="openMatchModal(${m.matchId || m.id})">
                    <div class="cal-col-left">
                        <div class="cal-tour team-clickable" onclick="event.stopPropagation(); filterByTour('${tourName}')">${tourName}</div>
                        <div class="cal-date">${dateTimeStr}</div>
                    </div>
                    <div class="cal-col-status">
                        <span class="${statusClass}">${finalStatusText}</span>
                    </div>
                    <div class="cal-col-match">
                        <span class="cal-team home team-clickable ${filterState.club === String(m.homeId) ? 'active-team-filter' : ''}" onclick="event.stopPropagation(); openClubModal(${m.homeId})">${formatTeamName(m.home)}</span>
                        ${homeLogo}
                        <span class="cal-score">${score}</span>
                        ${awayLogo}
                        <span class="cal-team away team-clickable ${filterState.club === String(m.awayId) ? 'active-team-filter' : ''}" onclick="event.stopPropagation(); openClubModal(${m.awayId})">${formatTeamName(m.away)}</span>
                    </div>
                    <div class="cal-col-info">
                        ${getStadiumInfoHtml(m, { emptyClass: true })}
                    </div>
                    <div class="cal-col-link">
                    ${m.status === 4 ? `
                        <button class="btn-video" title="Смотреть обзор">
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
                            Видеообзор
                        </button>
                    ` : ''}
                    </div>
                </div>
            `;
        });

        html += `</div>`;
    }

    calendarList.innerHTML = html;
}

function renderClubs() {
    const grid = document.getElementById("clubs-grid");
    if (!grid) return;

    if (!globalClubsList || globalClubsList.length === 0) {
        grid.innerHTML = "<p class='empty-note'>Клубы не загружены</p>";
        return;
    }

    const sortedClubs = [...globalClubsList].sort((a, b) => {
        const nameA = formatTeamName(a.name).toLowerCase();
        const nameB = formatTeamName(b.name).toLowerCase();
        return nameA.localeCompare(nameB, 'ru');
    });

    grid.innerHTML = sortedClubs.map(club => {
        const teamName = formatTeamName(club.name);
        const logoHtml = getTeamLogoHtml(club, "club-logo-img", 80);

        return `
          <div class="club-card team-clickable" onclick="openClubModal(${club.id})">
            <div class="club-card-header">
              ${logoHtml}
            </div>
            <div class="club-card-body">
              <h3 class="club-name">${teamName}</h3>
              <p class="club-city">${club.city || "Город не указан"}</p>
            </div>
          </div>
        `;
    }).join("");
}

function getStadiumInfo(match) {
    let displayCity = match.city;
    let displayStadium = match.stadium;
    
    // Если стадиона нет в матче, берем домашний стадион из кэша
    if (!displayStadium && allStadiums[match.homeId]) {
        const sObj = allStadiums[match.homeId];
        if (typeof sObj === 'object' && sObj !== null) {
            displayStadium = sObj.name;
            if (!displayCity && sObj.city) displayCity = sObj.city;
        } else {
            displayStadium = sObj;
        }
        if (!displayCity) displayCity = allClubs[match.homeId]?.city || "";
    }
    
    if (!displayStadium) return null; // Возвращаем null, если стадиона нет
    
    // Форматируем стадион (добавляем кавычки, если их нет)
    const stadiumStr = String(displayStadium);
    const formattedStadium = stadiumStr.startsWith('«') ? stadiumStr : `«${stadiumStr}»`;
    
    return {
        city: displayCity || "",
        stadium: formattedStadium
    };
}

function getFallbackStadiumInfo(clubId) {
    // Ищем последний завершенный матч, где этот клуб был хозяином
    const pastHomeMatches = allCalendarMatches
        .filter(m => m.homeId === clubId && m.status === 4 && m.stadium)
        .sort(compareMatchesByDateDesc);
        
    if (pastHomeMatches.length > 0) {
        return { stadium: pastHomeMatches[0].stadium, city: pastHomeMatches[0].city };
    }
    
    // Если дома не нашли, ищем любой завершенный матч, где клуб играл
    const anyPastMatches = allCalendarMatches
        .filter(m => (m.homeId === clubId || m.awayId === clubId) && m.status === 4 && m.stadium)
        .sort((a, b) => (normalizeMatchDate(b.date)?.getTime() || 0) - (normalizeMatchDate(a.date)?.getTime() || 0));
        
    if (anyPastMatches.length > 0) {
        return { stadium: anyPastMatches[0].stadium, city: anyPastMatches[0].city };
    }
    
    return { stadium: 'Не указан', city: 'Город не указан' };
}


function getMatchDetails(clubId, formIndex) {
    return getClubLast5Matches(clubId)[formIndex];
}

document.addEventListener('mouseover', function(e) {
    const dot = e.target.closest('.form-dot[data-club]');
    if (!dot) return;

    const clubId = parseInt(dot.getAttribute('data-club'));
    const index = parseInt(dot.getAttribute('data-idx'));
    const match = getMatchDetails(clubId, index);

    if (!match) return;

    let tooltip = document.getElementById('form-tooltip');
    if (!tooltip) {
        tooltip = document.createElement('div');
        tooltip.id = 'form-tooltip';
        document.body.appendChild(tooltip);
    }

    const dateStr = formatMatchDateOnly(match.date);
    
    tooltip.innerHTML = `
        <div class="tt-tour">${match.tour}</div>
        <div class="tt-date">${dateStr}</div>
        <div class="tt-match">
            <span>${formatTeamName(match.home)}</span>
            <span class="tt-score">${match.goalH} : ${match.goalA}</span>
            <span>${formatTeamName(match.away)}</span>
        </div>
    `;

    tooltip.style.display = 'block';
    
    const rect = dot.getBoundingClientRect();
    tooltip.style.left = `${rect.left + window.scrollX + rect.width / 2 - tooltip.offsetWidth / 2}px`;
    tooltip.style.top = `${rect.top + window.scrollY - tooltip.offsetHeight - 8}px`;
});

document.addEventListener('mouseout', function(e) {
    const dot = e.target.closest('.form-dot[data-club]');
    if (!dot) return;
    
    const tooltip = document.getElementById('form-tooltip');
    if (tooltip) {
        tooltip.style.display = 'none';
    }
});

window.filterByMatchForm = function(clubId, formIndex) {
    const last5 = getClubLast5Matches(clubId);
    const targetMatch = last5[formIndex];
    
    if (!targetMatch) return;

    resetCalendarFilters();
    
    switchToCalendarTab();

    filterState.tour = targetMatch.tour;
    setCustomSelectValue("tour", targetMatch.tour, targetMatch.tour);

    applyCalendarFilters();

    setTimeout(() => {
        const rows = document.querySelectorAll('.calendar-row');
        for (let row of rows) {
            if (row.textContent.includes(targetMatch.home) && row.textContent.includes(targetMatch.away)) {
                row.scrollIntoView({ behavior: 'smooth', block: 'center' });
                row.classList.add('row-highlight');
                setTimeout(() => row.classList.remove('row-highlight'), 2000);
                break;
            }
        }
    }, 100);
};

window.filterByTour = function(tourName) {
    resetCalendarFilters();
    
    switchToCalendarTab();
    
    filterState.tour = tourName;
    setCustomSelectValue("tour", tourName, tourName);
    
    const resetBtn = document.getElementById("btn-reset-filters");
    if (resetBtn) resetBtn.classList.remove("hidden");
    
    applyCalendarFilters();
};

window.filterByTeam = function(clubId) {
    resetCalendarFilters();
    
    switchToCalendarTab();
    
    filterState.club = String(clubId);
    
    const club = allClubs[clubId];
    const clubName = club ? formatTeamName(club.name) : "Выбранный клуб";
    
    setCustomSelectValue("club", String(clubId), clubName);
    
    const resetBtn = document.getElementById("btn-reset-filters");
    if (resetBtn) resetBtn.classList.remove("hidden");
    
    applyCalendarFilters();
};

// Открытие модального окна матча
window.openMatchModal = async function(matchId) {
    if (typeof matchId === 'string') matchId = parseInt(matchId, 10);
    const modal = document.getElementById('match-modal');
    const body = document.getElementById('modal-body');
    
    // Инициализируем кэш игроков клубов, если его нет
    if (!window._clubPlayersCache) {
        window._clubPlayersCache = {};
    }
    
    body.innerHTML = '<div class="modal-state">Загрузка данных матча...</div>';
    modal.classList.add('active');
    document.body.classList.add('modal-open');

    // Сброс справочника (на случай, если предыдущий матч был архивным)
    window._allPlayersArchive = null;

    // Сброс данных предыдущего матча, чтобы не «протекали» в новый
    window._matchScorers = [];
    window._currentBroadcastEvents = null;
    window._currentHomeClub = null;
    window._currentAwayClub = null;
    window._matchAmplua = {};
    window._matchCitizenship = {};

    try {
        let data = null;
        let isFallback = false;

        try {
            const res = await fetch(`./data/current/matches/match_${matchId}.json`);
            if (res.ok) {
                data = await res.json();
            } else {
                throw new Error('Файл не найден');
            }
        } catch (e) {
            isFallback = true;
            const flatMatch = allFlatMatches.find(f => f.matchId === matchId);
            if (!flatMatch) throw new Error('Матч не найден');

            data = {
                id: matchId,
                clubH: flatMatch.homeId,
                clubA: flatMatch.awayId,
                goalH: flatMatch.goalH,
                goalA: flatMatch.goalA,
                date: flatMatch.date,
                stadium: flatMatch.stadium,
                city: flatMatch.city,
                tournament: '',
                stage: '',
                matchOfficials: [],
                weather: 'Нет данных',
                attendance: null,
                winline: null,
                broadcastLink: null,
                ticketsLink: null,
                status: flatMatch.status
            };
        }
        
        // Если матч архивный (из папки archive), подгружаем справочник игроков из архива
        if (isFallback && !window._allPlayersArchive) {
            try {
                // Найдём сезон матча в сезонах
                const seasons = window._seasons || [];
                const archivedSeasons = seasons.filter(s => s.is_archived && s.id);
                
                for (const season of archivedSeasons) {
                    const archivePath = `./data/archive/${season.id}/players_all.json`;
                    const archRes = await fetch(archivePath);
                    if (archRes.ok) {
                        window._allPlayersArchive = await archRes.json();
                        console.log(`Архивный справочник загружен (${season.id}): ${Object.keys(window._allPlayersArchive).length} чел.`);
                        break;
                    }
                }
            } catch (e) {
                console.warn("Не удалось загрузить архивный справочник", e);
            }
        }

        const homeClub = allClubs[data.clubH];
        const awayClub = allClubs[data.clubA];
        const logoBase = `${DATA_BASE}/`;

        const homeLogo = homeClub?.logo ? `<img src="${logoBase}${homeClub.logo}" class="modal-team-logo">` : "";
        const awayLogo = awayClub?.logo ? `<img src="${logoBase}${awayClub.logo}" class="modal-team-logo">` : "";

        // Данные тренеров уже загружены в window._allStaffs при инициализации (staffs_all.json)
        // Поэтому здесь ничего скачивать не нужно.

        // Судьи
        let officialsHtml = "";
        if (data.matchOfficials && data.matchOfficials.length > 0) {
            const mainRef = data.matchOfficials.find(o => o.position === "Главный судья");
            const otherRefs = data.matchOfficials.filter(o => o.position !== "Главный судья");
            
                        if (mainRef) {
                const hasMore = otherRefs.length > 0;
                officialsHtml = `
                    <div class="official-block">
                        <div class="official-header">
                            <div class="official-main-info">
                                <span class="official-role official-role--short">Главный судья:</span>
                                <span class="official-role official-role--all">Все судьи:</span>
                                <span class="official-name-bold">${formatPlayerName(mainRef)}</span>
                            </div>
                            ${hasMore ? `
                                <button onclick="toggleOfficials(this, event)" class="official-toggle-btn">
                                    <span class="toggle-more">Ещё</span><span class="toggle-less">Скрыть</span>
                                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
                                </button>
                            ` : ''}
                        </div>
                        ${hasMore ? `
                            <div class="official-details">
                                <div class="official-row">
                                    <div class="official-role-gray">Главный судья:</div>
                                    <div class="official-name">${formatPlayerName(mainRef)}</div>
                                </div>
                                ${otherRefs.map(o => `
                                    <div class="official-row">
                                        <div class="official-role-gray">${o.position}:</div>
                                        <div class="official-name">${formatPlayerName(o)}</div>
                                    </div>
                                `).join('')}
                            </div>
                        ` : ''}
                    </div>
                `;
            }
        }

        // Документы
        let documentsHtml = "";
        if (data.documents && (data.documents.protocol || data.documents.lineup)) {
            documentsHtml = `
                <div class="modal-documents">
                    ${data.documents.protocol ? `<a href="${data.documents.protocol}" target="_blank" class="doc-btn doc-protocol">📄 <span>Протокол (PDF)</span></a>` : ''}
                    ${data.documents.lineup ? `<a href="${data.documents.lineup}" target="_blank" class="doc-btn doc-lineup">📋 <span>Составы (PDF)</span></a>` : ''}
                </div>
            `;
        }

        // Предзагрузка событий (чтобы не делать 2 запроса)
        let matchEvents = null;
        let matchBroadcast = [];
        try {
            const evRes = await fetch(`./data/current/matches/events_${matchId}.json`);
            if (evRes.ok) {
                const ev = await evRes.json();
                matchEvents = ev.protocol || [];
                matchBroadcast = ev.broadcast || [];
                
                // Сохраняем для главной страницы
                if (!window._currentMatchBroadcast) window._currentMatchBroadcast = {};
                window._currentMatchBroadcast[matchId] = matchBroadcast;
            }
        } catch (err) {
            console.log('events не загружены', err);
        }

        // ─── Загрузка составов ───
        let lineupsHtml = '<div class="empty-state">Составы не загружены</div>';
        let hasLineups = false; // <-- Выносим флаг сюда
        let lineupsData = null; // <-- Сохраняем данные
        
        try {
            const lineupsRes = await fetch(`./data/current/matches/lineups_${matchId}.json`);
            if (lineupsRes.ok) {
                lineupsData = await lineupsRes.json();
                const lineups = lineupsData;
                const protocol = lineups.protocol || lineups;

                
                if (protocol.clubH && protocol.clubA) {
                    // ─── Карта событий по игрокам ───
                    const playerEvents = {};
                    
                    // Собираем амплуа и гражданство из broadcast (это есть всегда)
                    if (!window._matchAmplua) window._matchAmplua = {};
                    if (!window._matchCitizenship) window._matchCitizenship = {};
                    
                    matchBroadcast.forEach(ev => {
                        if (ev.player1) {
                            if (ev.player1.amplua !== undefined) {
                                window._matchAmplua[ev.player1.id] = ev.player1.amplua;
                            }
                            if (ev.player1.citizenship !== undefined) {
                                window._matchCitizenship[ev.player1.id] = ev.player1.citizenship;
                            }
                        }
                        if (ev.player2) {
                            if (ev.player2.amplua !== undefined) {
                                window._matchAmplua[ev.player2.id] = ev.player2.amplua;
                            }
                            if (ev.player2.citizenship !== undefined) {
                                window._matchCitizenship[ev.player2.id] = ev.player2.citizenship;
                            }
                        }
                    });

                    // 1. Собираем ВСЕ события (и из протокола, и из broadcast) в единый массив
                    const combinedEvents = [];

                    if (matchEvents) {
                        matchEvents.forEach(ev => {
                            combinedEvents.push({ source: 'protocol', ...ev });
                        });
                    }

                    if (matchBroadcast) {
                        matchBroadcast.forEach(ev => {
                            combinedEvents.push({ source: 'broadcast', ...ev });
                        });
                    }

                    // 2. Сортируем по времени (чтобы события шли по порядку)
                    combinedEvents.sort((a, b) => (a.time + (a.extra || 0) / 100) - (b.time + (b.extra || 0) / 100));

                    // 3. Единый проход по всем событиям с жесткой проверкой на дубли
                    combinedEvents.forEach(ev => {
                        const min = `${ev.time}${ev.extra ? `+${ev.extra}` : ''}'`;
                        
                        // --- ЗАМЕНЫ ---
                        if ((ev.type === 2 || ev.action === "Substitution") && ev.player1 && ev.player2) {
                            const isDupOut = (playerEvents[ev.player1.id] || []).some(e => e.type === 'out');
                            const isDupIn = (playerEvents[ev.player2.id] || []).some(e => e.type === 'in');
                            
                            if (!isDupOut) {
                                if (!playerEvents[ev.player1.id]) playerEvents[ev.player1.id] = [];
                                playerEvents[ev.player1.id].push({ type: 'out', min });
                            }
                            if (!isDupIn) {
                                if (!playerEvents[ev.player2.id]) playerEvents[ev.player2.id] = [];
                                playerEvents[ev.player2.id].push({ type: 'in', min });
                            }
                        }
                        
                        // --- ЖЕЛТЫЕ КАРТОЧКИ ---
                        else if (ev.type === 3 || ev.action === "YellowCard") {
                            if (ev.player1) {
                                const isDup = (playerEvents[ev.player1.id] || []).some(e => e.type === 'yellow');
                                if (!isDup) {
                                    if (!playerEvents[ev.player1.id]) playerEvents[ev.player1.id] = [];
                                    playerEvents[ev.player1.id].push({ type: 'yellow', min });
                                }
                            }
                        }
                        
                        // --- КРАСНЫЕ КАРТОЧКИ ---
                        else if (ev.type === 4 || ev.action === "RedCard") {
                            if (ev.player1) {
                                const isDup = (playerEvents[ev.player1.id] || []).some(e => e.type === 'red');
                                if (!isDup) {
                                    if (!playerEvents[ev.player1.id]) playerEvents[ev.player1.id] = [];
                                    playerEvents[ev.player1.id].push({ type: 'red', min });
                                }
                            }
                        }
                        
                        // --- ГОЛЫ И АССИСТЫ ---
                        else if (ev.type === 1 || ev.type === 10 || ev.action === "Goal") {
                            if (ev.player1) {
                                const isDup = (playerEvents[ev.player1.id] || []).some(e => e.type === 'goal');
                                if (!isDup) {
                                    if (!playerEvents[ev.player1.id]) playerEvents[ev.player1.id] = [];
                                    playerEvents[ev.player1.id].push({ type: 'goal', min });
                                }
                                
                                // Ассистент (берем из этого же события, если он есть)
                                if (ev.player2) {
                                    const isAssistDup = (playerEvents[ev.player2.id] || []).some(e => e.type === 'assist');
                                    if (!isAssistDup) {
                                        if (!playerEvents[ev.player2.id]) playerEvents[ev.player2.id] = [];
                                        playerEvents[ev.player2.id].push({ type: 'assist', min });
                                    }
                                }
                            }
                        }
                        
                        // --- АВТОГОЛЫ ---
                        else if (ev.type === 11 || ev.action === "AutoGoal") {
                            if (ev.player1) {
                                const isDup = (playerEvents[ev.player1.id] || []).some(e => e.type === 'autogoal');
                                if (!isDup) {
                                    if (!playerEvents[ev.player1.id]) playerEvents[ev.player1.id] = [];
                                    playerEvents[ev.player1.id].push({ type: 'autogoal', min });
                                }
                            }
                        }
                    });
                    
                    const renderPlayer = (p, player, isReserve = false, isRight = false) => {
                        const captainMark = p.captain ? `<span class="player-captain">(К)</span>` : "";
                        const num = player.number != null ? player.number : '';
                        
                        // Иконки событий игрока
                        const events = playerEvents[player.id] || [];
                        const eventsHtml = events.map(e => {
                            if (e.type === 'goal') return `<span class="pev" title="Гол ${e.min}">⚽</span>`;
                            if (e.type === 'autogoal') return `<span class="pev-autogoal" title="Автогол ${e.min}">⚽ <small>(автогол)</small></span>`;
                            if (e.type === 'yellow') return `<span class="pev" title="Жёлтая ${e.min}">🟨</span>`;
                            if (e.type === 'red') return `<span class="pev" title="Красная ${e.min}">🟥</span>`;
                            if (e.type === 'out') return `<span class="pev-out" title="Заменён ${e.min}">↓ ${e.min}</span>`;
                            if (e.type === 'in') return `<span class="pev-in" title="Вышел ${e.min}">↑ ${e.min}</span>`;
                            if (e.type === 'assist') return `<span class="pev-assist" title="Голевой пас ${e.min}">(А)</span>`;
                            return '';
                        }).join('');
                        
                        // Определяем амплуа и гражданство
                        // Приоритет 1: p.amplua (точное амплуа на этот матч из lineups.main/reserve)
                        // Приоритет 2: players_all.json (общий справочник, всегда актуален)
                        let amplua = p.amplua;
                        let citizenship = undefined;

                        // Если амплуа нет в матче — берем из общего справочника (текущего или архивного)
                        if (amplua === undefined) {
                            const pSource = 
                                (window._allPlayers && window._allPlayers[player.id]) ||
                                (window._allPlayersArchive && window._allPlayersArchive[player.id]);
                            if (pSource && pSource.amplua !== undefined) {
                                amplua = pSource.amplua;
                            }
                        }

                        // Гражданство: сначала текущий справочник, потом архивный
                        const playerSource = 
                            (window._allPlayers && window._allPlayers[player.id]) ||
                            (window._allPlayersArchive && window._allPlayersArchive[player.id]);
                        
                        if (playerSource && playerSource.citizenship !== undefined) {
                            citizenship = playerSource.citizenship;
                        }
                        
                        let positionLabel = '';
                        if (amplua === 0) positionLabel = 'ВР';
                        else if (amplua === 1) positionLabel = 'ЗЩ';
                        else if (amplua === 2) positionLabel = 'ПЗ';
                        else if (amplua === 3) positionLabel = 'НП';

                        // Берем страну из найденного поля citizenship
                        const countryId = citizenship;
                        const flagUrl = getCountryFlagUrl(countryId);
                        const countryName = getCountryName(countryId);
                        
                        // Отладка (можешь убрать, когда заработает)
                        // console.log("Игрок:", player.name, "| ID страны:", countryId, "| Флаг:", flagUrl);
                        
                        const flagHtml = flagUrl 
                            ? `<img src="${flagUrl}" class="player-flag" title="${countryName}" alt="${countryName}">` 
                            : "";

                        // Кружочек с номером (без флага)
                        const numberCircle = `
                            <div class="player-circle${isReserve ? ' player-circle--reserve' : ''}">${num}</div>
                        `;

                        // Блок с номером и позицией рядом с ним
                        const numberAndPosition = isRight
                            ? `
                                <div class="player-number-pos">
                                    ${numberCircle}
                                    ${positionLabel ? `<span class="player-pos-text">${positionLabel}</span>` : ''}
                                </div>
                            `
                            : `
                                <div class="player-number-pos">
                                    ${positionLabel ? `<span class="player-pos-text">${positionLabel}</span>` : ''}
                                    ${numberCircle}
                                </div>
                            `;

                        // Текст (имя + иконки) без позиции
                        const textBlock = isRight 
                            ? `
                                <div class="player-name-events is-right">
                                    ${eventsHtml || ''}
                                    ${captainMark ? `<span class="player-captain">(К)</span>` : ''}
                                    <span class="player-name">${formatPlayerName(player)}</span>
                                    ${flagHtml}
                                </div>
                            `
                            : `
                                <div class="player-name-events is-left">
                                    ${flagHtml}
                                    <span class="player-name">${formatPlayerName(player)}</span>
                                    ${captainMark ? `<span class="player-captain">(К)</span>` : ''}
                                    ${eventsHtml || ''}
                                </div>
                            `;

                        if (isRight) {
                            return `
                                <div class="player-row is-right">
                                    ${textBlock}
                                    ${numberAndPosition}
                                </div>
                            `;
                        }
                        
                        return `
                            <div class="player-row is-left">
                                ${numberAndPosition}
                                ${textBlock}
                            </div>
                        `;
                    };

                    const renderCoach = (clubData, isRight = false) => {
                        if (!clubData || !clubData.coaches || clubData.coaches.length === 0) return "";
                        const rawCoach = clubData.coaches[0];
                        const alignClass = isRight ? 'align-right' : 'align-left';

                        // Берем имя и фамилию из lineups (там они всегда актуальные)
                        // А гражданство — ТОЛЬКО из staffs_all.json (window._allStaffs)
                        let coach = { 
                            ...rawCoach,
                            // Принудительно ставим гражданство из справочника (или null)
                            citizenship: (window._allStaffs && window._allStaffs[rawCoach.id]?.citizenship) || null
                        };

                        // Используем нашу новую универсальную функцию
                        const nameHtml = getPlayerNameWithFlag(coach, isRight);

                        return `
                            <div class="lineup-coach">
                                <div class="lineup-section-title ${alignClass}">Главный тренер</div>
                                <div class="lineup-coach-name ${alignClass}">${nameHtml}</div>
                            </div>
                        `;
                    };  

                    const renderMainOnly = (clubData, isRight = false) => {
                        if (!clubData || !clubData.players) return "";
                        const playersMap = {};
                        clubData.players.forEach(p => playersMap[p.id] = p);
                        const mainHtml = (clubData.main || []).map(p => {
                            const player = playersMap[p.id];
                            return player ? renderPlayer(p, player, false, isRight) : "";
                        }).join('');
                        const alignClass = isRight ? 'align-right' : 'align-left';
                        return `
                            <div class="lineup-section-title ${alignClass}">Стартовый состав</div>
                            ${mainHtml || `<div class="lineup-empty ${alignClass}">Не указан</div>`}
                        `;
                    };

                    const renderReserveOnly = (clubData, isRight = false) => {
                        if (!clubData || !clubData.players) return "";
                        const playersMap = {};
                        clubData.players.forEach(p => playersMap[p.id] = p);
                        const reserveHtml = (clubData.reserve || []).map(p => {
                            const player = playersMap[p.id];
                            return player ? renderPlayer(p, player, true, isRight) : "";
                        }).join('');
                        const alignClass = isRight ? 'align-right' : 'align-left';
                        return `
                            <div class="lineup-section-title ${alignClass}">Запасные</div>
                            ${reserveHtml || `<div class="lineup-empty ${alignClass}">Нет</div>`}
                        `;
                    };

                    lineupsHtml = `
                        <div class="lineups-wrapper" id="lineups-container">
                            <!-- КНОПКИ ПЕРЕКЛЮЧЕНИЯ ДЛЯ МОБИЛЬНЫХ -->
                            <div class="mobile-lineup-switch">
                                <button class="active" onclick="switchMobileLineup('home', event)">${formatTeamName(homeClub?.name)}</button>
                                <button onclick="switchMobileLineup('away', event)">${formatTeamName(awayClub?.name)}</button>
                            </div>

                            <!-- ЛЕГЕНДА -->
                            <div class="lineup-legend">
                                <span><span class="legend-captain">(К)</span> — капитан</span>
                                <span><span class="legend-assist">(А)</span> — голевой пас</span>
                                <span>⚽ — гол</span>
                                <span>🟨 — жёлтая карточка</span>
                                <span>🟥 — красная карточка</span>
                            </div>

                            <!-- ЗАГОЛОВКИ КОМАНД -->
                            <div class="lineup-teams-header">
                                <div class="team-name-left">${formatTeamName(homeClub?.name)}</div>
                                <div class="team-name-right">${formatTeamName(awayClub?.name)}</div>
                            </div>

                            <!-- СТАРТОВЫЙ СОСТАВ -->
                            <div class="lineup-grid">
                                <div>${renderMainOnly(protocol.clubH, false)}</div>
                                <div>${renderMainOnly(protocol.clubA, true)}</div>
                            </div>

                            <!-- ЗАПАСНЫЕ -->
                            <div class="lineup-grid">
                                <div>${renderReserveOnly(protocol.clubH, false)}</div>
                                <div>${renderReserveOnly(protocol.clubA, true)}</div>
                            </div>

                            <!-- ГЛАВНЫЕ ТРЕНЕРЫ -->
                            <div class="lineup-grid">
                                <div>${renderCoach(protocol.clubH, false)}</div>
                                <div>${renderCoach(protocol.clubA, true)}</div>
                            </div>
                        </div>
                    `;
                    
                    // Устанавливаем флаг прямо здесь, используя уже загруженные данные
                    const clubHPlayers = (protocol.clubH?.players || []).length;
                    const clubAPlayers = (protocol.clubA?.players || []).length;
                    const clubHMain = (protocol.clubH?.main || []).length;
                    const clubAMain = (protocol.clubA?.main || []).length;
                    hasLineups = (clubHPlayers > 0 || clubAPlayers > 0 || clubHMain > 0 || clubAMain > 0);
                }
            }
        } catch (e) {
            console.log("Составы не загружены", e);
        }

        // ─── Загрузка событий и статистики ───
        let eventsHtml = '<div class="empty-state">События не загружены</div>';
        let statsHtml = '<div class="empty-state">Статистика не загружена</div>';
        let hasEvents = false;
        
        try {
            // ВАЖНО: в live-матче protocol может быть пустым, а все события — в broadcast.
            // Поэтому входим в блок, если есть ХОТЯ БЫ один из источников.
            if ((matchEvents && matchEvents.length > 0) || (matchBroadcast && matchBroadcast.length > 0)) {
                const protocolEvents = matchEvents || [];
                const broadcastEvents = matchBroadcast || [];
                
                // ─── События ───
                // Рендерим, если есть хоть что-то: события из protocol ИЛИ из broadcast
                if (protocolEvents.length > 0 || broadcastEvents.length > 0) {
                    const allEvents = [];
                    
                    protocolEvents.forEach(e => {
                        if ([1, 2, 3, 4, 10, 11].includes(e.type) || e.action === "Goal" || e.action === "YellowCard") {
                            // Проверяем, нет ли уже такого гола в broadcast (чтобы не дублировать, когда время сдвинуто)
                            if (e.type === 1 || e.type === 10) {
                                const hasBroadcastGoal = broadcastEvents.some(b => 
                                    b.action === "Goal" && 
                                    b.player1?.id === e.player1?.id && 
                                    b.club === e.club &&
                                    Math.abs(b.time - e.time) <= 2
                                );
                                if (hasBroadcastGoal) return; // Пропускаем, так как возьмем из broadcast
                            }
                            
                            allEvents.push({ ...e, _source: 'protocol' });
                        }
                    });
                    
                    broadcastEvents.forEach(e => {
                        if (e.action === "Goal") {
                            const existingIdx = allEvents.findIndex(
                                p => p.type === 1 && p.time === e.time && p.club === e.club
                            );
                            if (existingIdx !== -1) {
                                allEvents[existingIdx] = { ...e, _type: 'goal', _clubId: e.club };
                            } else {
                                allEvents.push({ ...e, _type: 'goal', _clubId: e.club });
                            }
                        }
                        if (e.action === "AutoGoal") {
                            // Для автогола клуб в событии - это тот, кто забил в свои ворота.
                            // Значит, гол засчитывается противоположной команде.
                            const oppositeClubId = (e.club === homeClub?.id) ? awayClub?.id : homeClub?.id;
                            
                            // Проверяем, нет ли уже такого события из protocol (type 11)
                            const existingIdx = allEvents.findIndex(
                                p => (p.type === 11 || p.action === "AutoGoal" || p._type === 'autogoal') && p.time === e.time && p.player1?.id === e.player1?.id
                            );
                            if (existingIdx === -1) {
                                allEvents.push({ ...e, _type: 'autogoal', _clubId: oppositeClubId });
                            }
                        }
                        if (e.action === "AppointedPenalty") {
                            const hasGoal = protocolEvents.some(p => 
                                p.type === 10 && p.time === e.time && p.club === e.club
                            );
                            if (!hasGoal) {
                                allEvents.push({
                                    ...e,
                                    _penalty: true,
                                    _penaltyMissed: e.isPenaltyRealized === false,
                                    _clubId: e.club,
                                    _isAppointed: true // <--- ДОБАВИЛИ ФЛАГ
                                });
                            }
                        }
                        if (e.action === "Corner") {
                            allEvents.push({ ...e, _isCorner: true, _clubId: e.club });
                        }
                    });
                    
                    // Убираем дубли назначенных пенальти, если позже был забит гол с пенальти или промах
                    const filteredEvents = allEvents.filter((e, idx, arr) => {
                        if (e._isAppointed) {
                            return !arr.some(other => 
                                other !== e && 
                                (other.type === 10 || other.action === "PenaltyGoal") && 
                                other.club === e.club && 
                                Math.abs(other.time - e.time) <= 2 // Проверяем, нет ли реализации рядом
                            );
                        }
                        return true;
                    });

                    // Убираем дубли голов, если событие из protocol дублирует broadcast (разница во времени до 2 минут)
                    const finalEvents = filteredEvents.filter((e, idx, arr) => {
                        // Если это гол из protocol (нет пометки _source: 'broadcast')
                        if ((e.type === 1 || e.type === 10) && e._source !== 'broadcast') {
                            // Ищем такой же гол в broadcast (по игроку и клубу)
                            const hasBroadcastDuplicate = arr.some(other => 
                                other._source === 'broadcast' && 
                                (other.action === "Goal") &&
                                other.player1?.id === e.player1?.id && 
                                other.club === e.club &&
                                Math.abs(other.time - e.time) <= 2 // Проверяем разницу в 1-2 минуты
                            );
                            if (hasBroadcastDuplicate) return false; // Отбрасываем дубль из protocol
                        }
                        return true;
                    });

                    finalEvents.sort((a, b) => (a.time + (a.extra || 0) / 100) - (b.time + (b.extra || 0) / 100));
                    allEvents.length = 0; // Очищаем старый массив
                    allEvents.push(...finalEvents);
                    
                    // Собираем список голов для отображения под счетом
                    window._matchScorers = [];
                    
                    // Чтобы избежать дублей из broadcast (когда гол приходит без ассистента на минуту позже)
                    const processedGoals = [];

                    allEvents.forEach(e => {
                        // Игнорируем назначенные пенальти, которые не были реализованы, чтобы не путать счет
                        if (e._isAppointed) return;

                        if (e.action === "Goal" || e.type === 1 || e.type === 10 || e.action === "AutoGoal" || e.type === 11 || e._type === 'autogoal' || e._penalty) {
                            if ((e._penalty && e._penaltyMissed) || (e.action === "AppointedPenalty" && e.isPenaltyRealized === false)) return;
                            
                            let scorerText = "";
                            let time = `${e.time}${e.extra ? `+${e.extra}` : ''}`;
                            
                            // Проверяем, был ли это гол с пенальти по данным broadcast
                            const isPenaltyGoal = (e.type === 10) || 
                                (e.action === "Goal" && broadcastEvents.some(b => 
                                    b.action === "AppointedPenalty" && 
                                    b.time === e.time && 
                                    b.club === e.club && 
                                    b.isPenaltyRealized === true
                                ));

                            // Функция для сокращения имени: "Кирилл Глебов" -> "К. Глебов"
                            const getShortName = (player) => {
                                if (!player) return "";
                                let fullName = formatPlayerName(player);
                                if (!fullName) return "";
                                
                                const parts = fullName.trim().split(" ");
                                if (parts.length > 1) {
                                    // Берем первую букву первого слова и добавляем точку
                                    const firstLetter = parts[0].charAt(0).toUpperCase();
                                    // Берем все остальные слова (фамилию)
                                    const lastName = parts.slice(1).join(" ");
                                    return `${firstLetter}. ${lastName}`;
                                }
                                return fullName;
                            };

                            if (e.type === 11 || e.action === "AutoGoal" || e._type === 'autogoal') {
                                scorerText = `<span class="scorer-time">${time}</span> <span class="scorer-name">${getShortName(e.player1)}</span> <span class="scorer-extra">(автогол)</span>`;
                            } else if (isPenaltyGoal || e._penalty) {
                                scorerText = `<span class="scorer-time">${time}</span> <span class="scorer-name">${getShortName(e.player1)}</span> <span class="scorer-extra">(пен.)</span>`;
                            } else {
                                scorerText = `<span class="scorer-time">${time}</span> <span class="scorer-name">${getShortName(e.player1)}</span>`;
                                if (e.player2) {
                                    // Сокращаем и ассистента тоже, если нужно (сейчас там никнейм или фамилия)
                                    const assistName = e.player2.nickname ? e.player2.nickname : (e.player2.public_lastname || e.player2.lastname);
                                    scorerText += ` <span class="scorer-extra">(${assistName})</span>`;
                                }
                            }
                            
                            // Определяем, в чью пользу гол
                            let scoringClubId = e.club;
                            
                            // Если это автогол (в протоколе type 11 или пришел из broadcast), 
                            // засчитываем его ПРОТИВОПОЛОЖНОЙ команде.
                            if (e.type === 11 || e.action === "AutoGoal" || e._type === 'autogoal') {
                                scoringClubId = (e.club === homeClub?.id) ? awayClub?.id : homeClub?.id;
                            }
                            
                            // Проверка на дубль: если уже есть гол этого игрока за эту же минуту (+/- 1 мин)
                            const isDuplicate = processedGoals.some(g => 
                                g.playerId === e.player1?.id && 
                                g.clubId === scoringClubId && 
                                Math.abs(g.time - e.time) <= 1
                            );

                            if (!isDuplicate) {
                                window._matchScorers.push({ clubId: scoringClubId, text: scorerText });
                                processedGoals.push({ 
                                    playerId: e.player1?.id, 
                                    clubId: scoringClubId, 
                                    time: e.time 
                                });
                            }
                        }
                    });
                    
                    const renderEventRow = (e) => {
                        let icon = "";
                        let label = "";
                        let extraNote = "";
                        
                        // Проверяем, является ли событие пенальти (назначен или забит)
                        const isPenaltyEvent = e._penalty || e.type === 10 || (e.action === "AppointedPenalty");
                        const isMissedPenalty = e._penaltyMissed || (e.action === "AppointedPenalty" && e.isPenaltyRealized === false);

                        if (isPenaltyEvent && !e.isOwnGoal) {
                            if (isMissedPenalty) {
                                icon = "❌"; label = "Незабитый пенальти";
                                extraNote = " (пен.)";
                            } else {
                                icon = "⚽"; label = "Гол с пенальти";
                                extraNote = " (пен.)";
                            }
                        } else if (e._isCorner) {
                            icon = "🚩"; label = "Угловой";
                        } else if (e.action === "Goal" || e._type === 'goal') {
                            icon = "⚽"; label = "Гол";
                            if (e.isPenaltyRealized === true) extraNote = " (пен.)";
                            if (e.player2) extraNote += ` <span class="event-assist">(${e.player2.nickname ? e.player2.nickname : (e.player2.public_lastname || e.player2.lastname)})</span>`;
                        } else if (e.type === 1 || e.type === 10) {
                            icon = "⚽"; label = "Гол";
                            if (e.isOwnGoal) extraNote += " (авт.)";
                            if (e.player2) extraNote += ` <span class="event-assist">(${e.player2.nickname ? e.player2.nickname : (e.player2.public_lastname || e.player2.lastname)})</span>`;
                        } else if (e.type === 11 || e.action === "AutoGoal" || e._type === 'autogoal') {
                            icon = "⚽"; label = "Автогол";
                        } else if (e.type === 3 || e.action === "YellowCard") {
                            icon = "🟨"; label = "Жёлтая";
                        } else if (e.type === 4 || e.action === "RedCard") {
                            icon = "🟥"; label = "Красная";
                        } else if (e.type === 2 || e.action === "Substitution") {
                            icon = "🔄"; label = "Замена";
                        }
                        
                        let text = e.player1 ? formatPlayerName(e.player1) : "";
                        if (e.player2 && (e.type === 2 || e.action === "Substitution")) {
                            text += ` → ${formatPlayerName(e.player2)}`;
                        }
                        
                        if (e.type === 11 || e.action === "AutoGoal" || e._type === 'autogoal') {
                            text += " (автогол)";
                        }
                        
                        // Просто добавляем extraNote, так как для пенальти там уже прописано " (пен.)"
                        text += extraNote;
                        
                        const time = `${e.time}${e.extra ? `+${e.extra}` : ''}`;
                        const half = e.time <= 45 ? 1 : 2;
                        
                        let eventClubId = e.club;
                        
                        // Если это автогол, он засчитывается в пользу ПРОТИВОПОЛОЖНОЙ команды.
                        // Поэтому для отображения меняем ID клуба.
                        if (e.type === 11 || e.action === "AutoGoal" || e._type === 'autogoal') {
                            eventClubId = (e.club === homeClub?.id) ? awayClub?.id : homeClub?.id;
                        }
                        
                        const isHome = eventClubId === homeClub?.id;
                        const isAway = eventClubId === awayClub?.id;
                        
                        if (isHome) {
                            return `
                                <div class="event-row is-home" data-half="${half}">
                                    <div class="event-text-right">${text} <span class="ev-icon-l">${icon}</span></div>
                                    <div class="event-time">${time}</div>
                                    <div></div>
                                </div>
                            `;
                        }
                        if (isAway) {
                            return `
                                <div class="event-row is-away" data-half="${half}">
                                    <div></div>
                                    <div class="event-time">${time}</div>
                                    <div class="event-text-left"><span class="ev-icon-r">${icon}</span> ${text}</div>
                                </div>
                            `;
                        }
                        return `
                            <div class="event-row" data-half="${half}">
                                <div></div>
                                <div class="event-time">${time}</div>
                                <div class="event-text-left"><span class="ev-icon-r">${icon}</span> ${text}</div>
                            </div>
                        `;
                    };
                    
                    eventsHtml = `
                        <div class="tab-pad">
                            <div class="half-buttons-wrapper">
                                <button class="event-half-btn active" onclick="filterEventsByHalf('all', event)">Все</button>
                                <button class="event-half-btn" onclick="filterEventsByHalf('1', event)">1-й тайм</button>
                                <button class="event-half-btn" onclick="filterEventsByHalf('2', event)">2-й тайм</button>
                            </div>
                            <div id="events-list">
                                ${allEvents.map(renderEventRow).join('')}
                            </div>
                        </div>
                    `;
                }
                
                // ─── Статистика ───
                if (broadcastEvents.length > 0) {
                    window._currentBroadcastEvents = broadcastEvents;
                    window._currentHomeClub = homeClub;
                    window._currentAwayClub = awayClub;
                    
                    const stats = calculateMatchStats(broadcastEvents, homeClub?.id, awayClub?.id);
                    
                    statsHtml = `
                        <div class="tab-pad">
                            <div class="half-buttons-wrapper">
                                <button class="stats-half-btn active" onclick="filterStatsByHalf('all', event)">Весь матч</button>
                                <button class="stats-half-btn" onclick="filterStatsByHalf('1', event)">1-й тайм</button>
                                <button class="stats-half-btn" onclick="filterStatsByHalf('2', event)">2-й тайм</button>
                            </div>
                            
                            <div id="stats-list" data-all='${JSON.stringify(stats)}'>
                                <div class="stats-header">
                                    <span>${formatTeamName(homeClub?.name)}</span>
                                    <span>${formatTeamName(awayClub?.name)}</span>
                                </div>
                                <div id="stats-rows">
                                    ${renderStatsRowsHtml(stats)}
                                </div>
                            </div>
                        </div>
                    `;
                }
            }
            // Устанавливаем флаг hasEvents прямо здесь
            hasEvents = !!(eventsHtml && eventsHtml.indexOf('События не загружены') === -1);
        } catch (e) {
            console.log("События/статистика не загружены", e);
        }

        // Флаги — есть ли данные (hasLineups уже вычислен выше, второй запрос не нужен)
        const hasStats = !!(statsHtml && statsHtml.indexOf('Статистика не загружена') === -1);

        // Будущий матч без назначенного времени
        const isFutureNoDate = (data.status === 0) && isTimeUnknown(data.date);

        // Получаем стадион и город (из матча или из истории)
        let displayStadium = data.stadium;
        let displayCity = data.city;
        if (!displayStadium || !displayCity || isFutureNoDate) {
            const fallback = getFallbackStadiumInfo(data.clubH);
            if (!displayStadium) displayStadium = fallback.stadium;
            if (!displayCity) displayCity = fallback.city;
        }

        body.innerHTML = `
            <div class="match-modal-wrapper">
                <div class="match-top-header">
                    ${(() => {
                        const parts = [];
                        parts.push('РПЛ');
                        
                        const seasons = window._seasons || [];
                        const curSeason = seasons.find(s => s.is_current);
                        if (curSeason && curSeason.name) {
                            const seasonYear = curSeason.name.replace(/^Сезон\s+/i, '').trim();
                            if (seasonYear) parts.push(seasonYear);
                        }
                        
                        const stages = window._stages || [];
                        const stageId = data.stage || data.stageId;
                        if (stageId) {
                            const stage = stages.find(s => s.id === stageId);
                            if (stage && stage.name) parts.push(stage.name);
                            else parts.push(`Тур ${stageId}`);
                        }
                        
                        return `<div class="match-breadcrumbs">${parts.join(' · ')}</div>`;
                    })()}
                    
                    <div class="match-datetime">${getFormattedMatchDate(data.date, isFutureNoDate)}</div>
                </div>
                
                <div class="match-scoreboard-wrapper">
                    <div class="match-scoreboard">
                        <!-- ДОМАШНЯЯ КОМАНДА -->
                        <div class="score-team-block is-home">
                             ${homeLogo}
                             <span class="score-team-name">${formatTeamName(homeClub?.name)}</span>
                            <div class="score-team-scorers">
                                ${(() => {
                                    const events = window._matchScorers || [];
                                    const homeScorers = events.filter(e => e.clubId === homeClub?.id);
                                    if (homeScorers.length === 0) return "";
                                    return homeScorers.map(e => `<div class="scorer-item">${e.text}</div>`).join('');
                                })()}
                            </div>
                        </div>

                        <!-- СЧЕТ -->
                        <div class="score-numbers-wrapper">
                            <div class="score-numbers">
                                ${data.goalH !== null ? data.goalH : '—'} : ${data.goalA !== null ? data.goalA : '—'}
                            </div>
                            
                            <!-- ДИНАМИЧЕСКИЙ СТАТУС -->
                            <div id="match-live-status" class="modal-live-status ${getMatchStatusDisplay(data, matchBroadcast).isLive ? 'live' : ''}">
                                ${(() => {
                                    const statusInfo = getMatchStatusDisplay(data, matchBroadcast);
                                    if (statusInfo.isLive) {
                                        return `<span class="live-dot"></span> <span id="match-minute-text">${statusInfo.text}</span>`;
                                    }
                                    return `<span id="match-minute-text">${statusInfo.text}</span>`;
                                })()}
                            </div>
                        </div>

                        <!-- ГОСТЕВАЯ КОМАНДА -->
                        <div class="score-team-block is-away">
                            ${awayLogo}
                            <span class="score-team-name">${formatTeamName(awayClub?.name)}</span>
                            <div class="score-team-scorers">
                                ${(() => {
                                    const events = window._matchScorers || [];
                                    const awayScorers = events.filter(e => e.clubId === awayClub?.id);
                                    if (awayScorers.length === 0) return "";
                                    return awayScorers.map(e => `<div class="scorer-item">${e.text}</div>`).join('');
                                })()}
                            </div>
                        </div>
                    </div>
                </div>

                <!-- Вкладки (скрываем, если время не назначено) -->
                ${!isFutureNoDate ? `
                <div class="match-tabs-nav">
                    <button class="match-tab-btn active" onclick="switchMatchTab('overview', event)">Обзор</button>
                    ${hasLineups ? `<button class="match-tab-btn" onclick="switchMatchTab('lineups', event)">Составы</button>` : ''}
                    ${hasStats ? `<button class="match-tab-btn" onclick="switchMatchTab('stats', event)">Статистика</button>` : ''}
                    ${hasEvents ? `<button class="match-tab-btn" onclick="switchMatchTab('events', event)">События</button>` : ''}
                </div>
                ` : ''}

                <!-- Контент вкладок (Обзор показываем всегда) -->
                <div id="match-tab-overview" class="match-tab-pane active">
                    <div class="match-overview-box">
                        <div class="overview-row">
                            <span class="overview-label">Дата и время</span>
                            <span class="overview-value">${getFormattedMatchDate(data.date, isFutureNoDate, true)}</span>
                        </div>
                        <div class="overview-row">
                            <span class="overview-label">Стадион</span>
                            <span class="overview-value text-right">${displayStadium} (${displayCity})</span>
                        </div>
                        ${data.weather ? `
                            <div class="overview-row">
                                <span class="overview-label">Погода</span>
                                <span class="overview-value">${data.weather}</span>
                            </div>
                        ` : ''}
                        ${data.attendance ? `
                            <div class="overview-row no-border">
                                <span class="overview-label">Посещаемость</span>
                                <span class="overview-value">${data.attendance.toLocaleString('ru-RU')} чел.</span>
                            </div>
                        ` : ''}
                        
                        ${officialsHtml ? `<div class="officials-wrap">${officialsHtml}</div>` : ''}
                    </div>
                    
                    ${documentsHtml}
                </div>

                ${!isFutureNoDate && hasLineups ? `<div id="match-tab-lineups" class="match-tab-pane">${lineupsHtml}</div>` : ''}
                ${!isFutureNoDate && hasStats ? `<div id="match-tab-stats" class="match-tab-pane">${statsHtml}</div>` : ''}
                ${!isFutureNoDate && hasEvents ? `<div id="match-tab-events" class="match-tab-pane">${eventsHtml}</div>` : ''}

                ${isFallback && data.status !== 0 ? `<div class="fallback-note">Расширенная статистика появится после обновления базы данных.</div>` : ''}
            </div>
        `;
        // Запускаем локальный таймер, чтобы обновлять минуту каждую секунду
        // Сначала удаляем старый таймер, если он был (чтобы не было дублей)
        if (window._matchTimer) clearInterval(window._matchTimer);
        if (window._matchReloadTimer) clearInterval(window._matchReloadTimer);
        
        if (data && data.status !== 0 && data.status !== 4) {
            // 1) Тик минуты каждую секунду
            window._matchTimer = setInterval(() => {
                // Берем актуальные события из кэша (если они обновились)
                const currentBroadcast = window._currentMatchBroadcast && window._currentMatchBroadcast[matchId] 
                    ? window._currentMatchBroadcast[matchId] 
                    : matchBroadcast;
                const statusInfo = getMatchStatusDisplay(data, currentBroadcast);
                const textEl = document.getElementById('match-minute-text');
                const wrapEl = document.getElementById('match-live-status');
                if (textEl) {
                    textEl.innerText = statusInfo.text;
                }
                if (wrapEl) {
                    if (statusInfo.isLive) {
                        wrapEl.classList.add('live');
                    } else {
                        wrapEl.classList.remove('live');
                    }
                }
            }, 1000); // Обновляем каждую секунду

                        // 2) Периодическая перезагрузка данных матча (счёт, события, статистика)
            const LIVE_RELOAD_MS = 120000; // Обновляем раз в 2 минуты (синхронизация с GitHub Actions)
            const currentMatchId = matchId;
            let lastSnapshot = JSON.stringify({
                h: data.goalH, a: data.goalA, s: data.status,
                ev: (matchEvents || []).length, bc: (matchBroadcast || []).length
            });

            window._matchReloadTimer = setInterval(async () => {
                const modal = document.getElementById('match-modal');
                if (!modal || !modal.classList.contains('active')) return;

                try {
                    const detailRes = await fetch(`./data/current/matches/match_${currentMatchId}.json`, { cache: 'no-store' });
                    if (!detailRes.ok) return;
                    const freshDetail = await detailRes.json();

                    let freshProtocol = [];
                    let freshBroadcast = [];
                    try {
                        const evRes = await fetch(`./data/current/matches/events_${currentMatchId}.json`, { cache: 'no-store' });
                        if (evRes.ok) {
                            const ev = await evRes.json();
                            freshProtocol = ev.protocol || [];
                            freshBroadcast = ev.broadcast || [];
                        }
                    } catch (_) {}

                    const snapshot = JSON.stringify({
                        h: freshDetail.goalH, a: freshDetail.goalA, s: freshDetail.status,
                        ev: freshProtocol.length, bc: freshBroadcast.length
                    });

                    // Если ничего не изменилось — не трогаем DOM
                    if (snapshot === lastSnapshot) return;
                    lastSnapshot = snapshot;

                    // Запоминаем активную вкладку
                    const activeTabBtn = document.querySelector('#match-modal .match-tab-btn.active');
                    let activeTab = 'overview';
                    if (activeTabBtn) {
                        const m = activeTabBtn.getAttribute('onclick')?.match(/switchMatchTab\('(\w+)'/);
                        if (m) activeTab = m[1];
                    }

                    // Перезагружаем модалку (это обновит счёт, события, статистику, вкладки)
                    await openMatchModal(currentMatchId);

                    // Восстанавливаем активную вкладку
                    setTimeout(() => {
                        const btn = document.querySelector(`#match-modal .match-tab-btn[onclick*="switchMatchTab('${activeTab}'"]`);
                        if (btn) switchMatchTab(activeTab, { target: btn });
                    }, 50);
                } catch (e) {
                    // тихо игнорируем
                }
            }, LIVE_RELOAD_MS);
        }

    } catch (e) {
        console.error(e);
        body.innerHTML = `<div class="modal-state modal-state--error">Ошибка загрузки данных: ${e.message}</div>`;
    }
};

window.toggleOfficials = function(btn, event) {
    if (event) event.stopPropagation();
    const block = btn.closest('.official-block');
    if (block) block.classList.toggle('is-open');
};

// Функция переключения вкладок в модалке матча
window.switchMatchTab = function(tabId, event) {
    document.querySelectorAll('.match-tab-btn').forEach(btn => {
        btn.classList.remove('active');
    });
    
    if (event && event.target) {
        event.target.classList.add('active');
    }
    
    ['overview', 'lineups', 'stats', 'events'].forEach(id => {
        const el = document.getElementById(`match-tab-${id}`);
        if (el) el.classList.remove('active');
    });
    
    const target = document.getElementById(`match-tab-${tabId}`);
    if (target) target.classList.add('active');
};

window.switchMobileLineup = function(side, event) {
    const container = document.getElementById('lineups-container');
    if (!container) return;
    
    // Переключаем класс
    if (side === 'away') {
        container.classList.add('show-away');
    } else {
        container.classList.remove('show-away');
    }
    
    // Меняем активную кнопку
    const buttons = container.querySelectorAll('.mobile-lineup-switch button');
    buttons.forEach(btn => btn.classList.remove('active'));
    if (event && event.target) {
        event.target.classList.add('active');
    }
};

// Точечное обновление содержимого вкладок "События" и "Статистика" в открытой модалке
window.updateModalEventsAndStats = function(data, homeClub, awayClub, protocolEvents, broadcastEvents) {
    // Обновляем статистику
    if (broadcastEvents && broadcastEvents.length > 0) {
        window._currentBroadcastEvents = broadcastEvents;
        window._currentHomeClub = homeClub;
        window._currentAwayClub = awayClub;

        const stats = calculateMatchStats(broadcastEvents, homeClub?.id, awayClub?.id);
        const statsRows = document.getElementById('stats-rows');
        if (statsRows) {
            statsRows.innerHTML = renderStatsRowsHtml(stats);
        }
        const statsList = document.getElementById('stats-list');
        if (statsList) {
            statsList.setAttribute('data-all', JSON.stringify(stats));
        }
    }

    // Пересобираем события (проще всего — перерисовать список внутри вкладки)
    // Найдём контейнер вкладки events
    const eventsPane = document.getElementById('match-tab-events');
    if (!eventsPane) return;

    // Используем ту же логику, что в openMatchModal, но упрощённо:
    // перерисуем только #events-list
    const eventsListEl = eventsPane.querySelector('#events-list');
    if (!eventsListEl) return;

    // Собираем allEvents так же, как в openMatchModal (упрощённо, без дублей-фильтров для краткости)
    const allEvents = [];
    (protocolEvents || []).forEach(e => {
        if ([1, 2, 3, 4, 10, 11].includes(e.type)) allEvents.push({ ...e, _source: 'protocol' });
    });
    (broadcastEvents || []).forEach(e => {
        if (e.action === "Goal") allEvents.push({ ...e, _type: 'goal', _clubId: e.club });
        if (e.action === "AutoGoal") {
            const opp = (e.club === homeClub?.id) ? awayClub?.id : homeClub?.id;
            allEvents.push({ ...e, _type: 'autogoal', _clubId: opp });
        }
        if (e.action === "AppointedPenalty") allEvents.push({ ...e, _penalty: true, _clubId: e.club, _isAppointed: true, _penaltyMissed: e.isPenaltyRealized === false });
        if (e.action === "Corner") allEvents.push({ ...e, _isCorner: true, _clubId: e.club });
    });

    // Убираем назначенные пенальти, если был гол
    const filtered = allEvents.filter((e, idx, arr) => {
        if (e._isAppointed) {
            return !arr.some(o => o !== e && (o.type === 10 || o.action === "PenaltyGoal") && o.club === e.club && Math.abs(o.time - e.time) <= 2);
        }
        return true;
    });

    filtered.sort((a, b) => (a.time + (a.extra || 0) / 100) - (b.time + (b.extra || 0) / 100));

    // Рендер — используем ту же renderEventRow, что и в openMatchModal.
    // Она локальная внутри openMatchModal, поэтому просто перерисуем HTML-строку,
    // вызвав перегенерацию через небольшую хелпер-функцию.
    // Для простоты: если renderEventRow недоступна — просто перезагрузим модалку целиком.
    // Но чтобы не усложнять — используем перерисовку через сохранённую глобальную функцию.
    if (typeof window._renderEventRowForLive === 'function') {
        eventsListEl.innerHTML = filtered.map(window._renderEventRowForLive).join('');
    }
};

window.closeMatchModal = function(event) {
    if (event) event.stopPropagation();
    const modal = document.getElementById('match-modal');
    modal.classList.remove('active');
    document.body.classList.remove('modal-open');
    
    // Останавливаем таймер матча
    if (window._matchTimer) {
        clearInterval(window._matchTimer);
        window._matchTimer = null;
    }
    // Останавливаем таймер live-перезагрузки
    if (window._matchReloadTimer) {
        clearInterval(window._matchReloadTimer);
        window._matchReloadTimer = null;
    }
};

// Открытие модального окна клуба
window.openClubModal = async function(clubId) {
    const modal = document.getElementById('club-modal');
    const body = document.getElementById('club-modal-body');
    
    body.innerHTML = '<div class="modal-state">Загрузка данных клуба...</div>';
    modal.classList.add('active');
    document.body.classList.add('modal-open');

    try {
        const res = await fetch(`./data/frontend/clubs_data/${clubId}/club_profile.json`);
        let profile = null;
        if (res.ok) {
            profile = await res.json();
        }

        const club = allClubs[clubId];
        const clubLogo = getTeamLogoHtml(club, "club-modal-logo", 80);

        let staffsHtml = "";
        const staffsRes = await fetch(`./data/current/clubs_data/${clubId}/staffs.json`);
        if (staffsRes.ok) {
            const staffs = await staffsRes.json();
            if (Array.isArray(staffs) && staffs.length > 0) {
                staffsHtml = `
                    <div class="club-staffs-box">
                        <h3 class="club-section-title">Главный тренер</h3>
                        <div class="club-staffs-list">
                            ${staffs.filter(s => {
                                // 1. Если есть явный флаг, что он главный тренер
                                if (s.isCurrentCoach === true) return true;
                                
                                // 2. Если поле position есть, проверяем его (игнорируя регистр и пробелы)
                                if (s.position) {
                                    const pos = String(s.position).trim().toLowerCase();
                                    if (pos.includes("главный") || pos.includes("тренер")) return true;
                                }
                                
                                // 3. Если вообще нет поля position (как в вашем JSON) — считаем, что это тренер
                                if (!s.position) return true;
                                
                                return false;
                            }).map(s => {
                                // Берем гражданство ТОЛЬКО из единого справочника staffs_all.json
                                const mergedStaff = {
                                    ...s,
                                    citizenship: (window._allStaffs && window._allStaffs[s.id]?.citizenship) || null
                                };
                                return `
                                    <div class="club-staff-item">
                                        ${getPlayerNameWithFlag(mergedStaff, false)}
                                    </div>
                                `;
                            }).join('')}
                        </div>
                    </div>
                `;
            }
        }

        let playersHtml = '<div class="text-muted-light">Состав пока не загружен</div>';
        const playersRes = await fetch(`./data/current/clubs_data/${clubId}/players.json`);
        if (playersRes.ok) {
            const players = await playersRes.json();
            if (players && players.length > 0) {
                const ampluaNames = { 0: "Вратари", 1: "Защитники", 2: "Полузащитники", 3: "Нападающие" };
                
                const grouped = players.reduce((acc, p) => {
                    if (!acc[p.amplua]) acc[p.amplua] = [];
                    acc[p.amplua].push(p);
                    return acc;
                }, {});

                playersHtml = Object.entries(grouped).map(([amp, list]) => `
                    <div class="club-players-group">
                        <div class="club-players-title">${ampluaNames[amp] || "Другие"}</div>
                        <div class="club-players-grid">
                            ${list.sort((a,b) => a.number - b.number).map(p => {
                                return `
                                    <div class="club-player-card" onclick="closeClubModal(event); filterByTeam(${clubId})">
                                        <div class="club-player-number">${p.number || '-'}</div>
                                        <div class="club-player-name">
                                            ${getPlayerNameWithFlag(p, false)}
                                        </div>
                                    </div>
                                `;
                            }).join('')}
                        </div>
                    </div>
                `).join('');
            }
        }

                let stadiumHtml = "";
        const stadiumRes = await fetch(`./data/current/clubs_data/${clubId}/stadium.json`);
        if (stadiumRes.ok) {
            const stadium = await stadiumRes.json();
            if (stadium && stadium.name) {
                stadiumHtml = `
                    <div class="club-stadium-box">
                        <div class="club-stadium-icon">🏟</div>
                        <div>
                            <div class="club-stadium-name">${stadium.name}</div>
                            <div class="club-stadium-capacity">Вместимость: ${stadium.capacity ? stadium.capacity.toLocaleString('ru-RU') : '-'} чел.</div>
                        </div>
                    </div>
                `;
            }
        }

                // Подготовка матчей клуба
        const clubMatches = allFlatMatches.filter(m => m.homeId === clubId || m.awayId === clubId);
        
        // Сортируем будущие (ближайшие сверху) и прошедшие (последние сверху)
        const allFutureMatches = clubMatches
            .filter(m => m.status === 0)
            .sort(compareMatchesByDateAsc);
        const allPastMatches = clubMatches
            .filter(m => m.status === 4)
            .sort(compareMatchesByDateDesc);

        // Берем: 1 будущий и 5 прошедших для старта
        const futureFirst = allFutureMatches.slice(0, 1);
        const futureRest = allFutureMatches.slice(1);
        const pastFirst5 = allPastMatches.slice(0, 5);
        const pastRest = allPastMatches.slice(5);

        const renderClubMatchRow = (m) => {
            const homeClub = allClubs[m.homeId];
            const awayClub = allClubs[m.awayId];
            
            const homeLogo = getTeamLogoHtml(homeClub, "cal-logo", 24);
            const awayLogo = getTeamLogoHtml(awayClub, "cal-logo", 24);
            
            const { dateTimeStr } = getMatchDateTimeDisplay(m);
            const broadcast = window._currentMatchBroadcast && window._currentMatchBroadcast[m.matchId || m.id] 
                ? window._currentMatchBroadcast[m.matchId || m.id] 
                : null;
            const { score } = getMatchScoreDisplay(m, broadcast);
            const resultClass = getMatchResultClass(m, clubId);
            const tourName = m.tour || "";

            return `
                <div class="calendar-row club-matches-row ${resultClass}${m.status === 4 ? '' : ' no-video'}" onclick="closeClubModal(event); openMatchModal(${m.matchId || m.id})">
                    <div class="cal-col-left">
                        <div class="cal-tour">${tourName}</div>
                        <div class="cal-date">${dateTimeStr}</div>
                    </div>
                    <div class="cal-col-status"></div>
                    <div class="cal-col-match">
                        <span class="cal-team home">${formatTeamName(m.home)}</span>
                        ${homeLogo}
                        <span class="cal-score">${score}</span>
                        ${awayLogo}
                        <span class="cal-team away">${formatTeamName(m.away)}</span>
                    </div>
                    <div class="cal-col-info">
                        ${getStadiumInfoHtml(m)}
                    </div>
                </div>
            `;
        };

        const matchesHtml = `
            <div class="club-matches-wrapper">
                <!-- СЛЕДУЮЩИЙ МАТЧ (СВЕРХУ) -->
                <div class="club-matches-section">
                    <h3 class="club-section-title">Следующий матч</h3>
                    ${futureFirst.length ? futureFirst.map(renderClubMatchRow).join('') : '<div class="club-empty">Нет будущих матчей</div>'}
                    
                    ${futureRest.length ? `
                        <div id="future-matches-rest">
                            ${futureRest.map(renderClubMatchRow).join('')}
                        </div>
                        <button id="btn-show-future" class="btn-show-all-matches" onclick="document.getElementById('future-matches-rest').style.display='block'; this.style.display='none'; document.getElementById('btn-hide-future').style.display='block';">Показать все будущие матчи</button>
                        <button id="btn-hide-future" class="btn-show-all-matches" onclick="document.getElementById('future-matches-rest').style.display='none'; this.style.display='none'; document.getElementById('btn-show-future').style.display='block';">Скрыть все будущие матчи</button>
                    ` : ''}
                </div>

                <!-- ПРОШЕДШИЕ МАТЧИ (СНИЗУ) -->
                <div class="club-matches-section">
                    <h3 class="club-section-title">Прошедшие матчи</h3>
                    ${pastFirst5.length ? pastFirst5.map(renderClubMatchRow).join('') : '<div class="club-empty">Нет прошедших матчей</div>'}
                    
                    ${pastRest.length ? `
                        <div id="past-matches-rest">
                            ${pastRest.map(renderClubMatchRow).join('')}
                        </div>
                        <button id="btn-show-past" class="btn-show-all-matches" onclick="document.getElementById('past-matches-rest').style.display='block'; this.style.display='none'; document.getElementById('btn-hide-past').style.display='block';">Показать все прошедшие матчи</button>
                        <button id="btn-hide-past" class="btn-show-all-matches" onclick="document.getElementById('past-matches-rest').style.display='none'; this.style.display='none'; document.getElementById('btn-show-past').style.display='block';">Скрыть все прошедшие матчи</button>
                    ` : ''}
                </div>
            </div>
        `;

        body.innerHTML = `
            <div class="club-modal-header">
                <div class="club-modal-logo-wrapper">
                    ${clubLogo}
                </div>
                <h2 class="club-modal-title">${club?.name || 'Клуб'}</h2>
                <p class="club-modal-subtitle">${profile?.city || club?.city || ''} · Основан в ${profile?.year || '-'}</p>
            </div>

            <div class="club-info-panel">
                ${staffsHtml}
                ${stadiumHtml}
            </div>

            <div class="match-tabs-nav">
                <button class="match-tab-btn active" onclick="switchClubTab('squad', event)">Состав</button>
                <button class="match-tab-btn" onclick="switchClubTab('matches', event)">Матчи</button>
            </div>

            <div id="club-tab-squad" class="club-tab-pane active">
                <div class="club-squad-wrapper">
                    ${playersHtml}
                </div>
            </div>

            <div id="club-tab-matches" class="club-tab-pane">
                ${matchesHtml}
            </div>
        `;
    } catch (e) {
        console.error(e);
        body.innerHTML = `<div class="modal-state modal-state--error">Ошибка загрузки: ${e.message}</div>`;
    }
};

window.switchClubTab = function(tabId, event) {
    document.querySelectorAll('#club-modal .match-tab-btn').forEach(btn => {
        btn.classList.remove('active');
    });
    
    if (event && event.target) {
        event.target.classList.add('active');
    }
    
    ['squad', 'matches'].forEach(id => {
        const el = document.getElementById(`club-tab-${id}`);
        if (el) el.classList.remove('active');
    });
    
    const target = document.getElementById(`club-tab-${tabId}`);
    if (target) target.classList.add('active');

    // Сбрасываем развёрнутые списки при переходе на вкладку "Матчи"
    if (tabId === 'matches') {
        const futureRest = document.getElementById('future-matches-rest');
        const btnShowFuture = document.getElementById('btn-show-future');
        const btnHideFuture = document.getElementById('btn-hide-future');
        if (futureRest) futureRest.style.display = 'none';
        if (btnShowFuture) btnShowFuture.style.display = 'block';
        if (btnHideFuture) btnHideFuture.style.display = 'none';

        const pastRest = document.getElementById('past-matches-rest');
        const btnShowPast = document.getElementById('btn-show-past');
        const btnHidePast = document.getElementById('btn-hide-past');
        if (pastRest) pastRest.style.display = 'none';
        if (btnShowPast) btnShowPast.style.display = 'block';
        if (btnHidePast) btnHidePast.style.display = 'none';
    }
};

window.closeClubModal = function(event) {
    if (event) event.stopPropagation();
    const modal = document.getElementById('club-modal');
    modal.classList.remove('active');
    document.body.classList.remove('modal-open');
};

window.filterEventsByHalf = function(half, event) {
    document.querySelectorAll('.event-half-btn').forEach(btn => {
        btn.classList.remove('active');
    });
    if (event && event.target) {
        event.target.classList.add('active');
    }
    
    document.querySelectorAll('.event-row').forEach(row => {
        row.classList.toggle('hidden', !(half === 'all' || row.dataset.half === half));
    });
};

window.filterStatsByHalf = function(half, event) {
    document.querySelectorAll('.stats-half-btn').forEach(btn => {
        btn.classList.remove('active');
    });
    if (event && event.target) {
        event.target.classList.add('active');
    }
    
    if (!window._currentBroadcastEvents || !window._currentHomeClub || !window._currentAwayClub) return;
    
    const events = window._currentBroadcastEvents;
    const homeClubId = window._currentHomeClub.id;
    const awayClubId = window._currentAwayClub.id;
    
    const stats = calculateMatchStats(events, homeClubId, awayClubId, half);
    
    const rows = document.getElementById('stats-rows');
    if (rows) {
        rows.innerHTML = renderStatsRowsHtml(stats);
    }
};

document.addEventListener("DOMContentLoaded", init);
