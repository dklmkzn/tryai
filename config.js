// config.js — версия 1.1.7
// Состояние бота в едином объекте state, экспортируемом по ссылке.

const state = {
    allowedDomains: ['nplus1.ru', 'naked-science.ru', '300.ya.ru'],
    allowedUsernames: [],
    allowedChannels: [],
    allowedGroups: [],
    allowedChannelsNoDomainCheck: [],
    allowedGroupsNoDomainCheck: [],
    YANDEX_TOKEN: '',
    DIAGNOSTIC_MODE: false,
    ACTIVE_INTERVAL: 3000,
    MAX_ACTIVE_ATTEMPTS: 100,
    LONG_INTERVAL: 60000,
    MAX_LONG_ATTEMPTS: 20,
    PING_MIN_INTERVAL: 10 * 60 * 1000,
    PING_MAX_INTERVAL: 13 * 60 * 1000
};

// ===== ВСПОМОГАТЕЛЬНАЯ ФУНКЦИЯ ДЛЯ ЛОГИРОВАНИЯ =====
function safeLog(adminChatId, bot, message, level, diagnosticMode, logFn) {
    if (logFn) {
        logFn(message, level, diagnosticMode);
    } else {
        console.log(`[${level}] ${message}`);
    }
}

// ===== ОСНОВНЫЕ ФУНКЦИИ =====

function normalizeId(id) {
    const str = id.toString();
    if (str.startsWith('-100')) return str.substring(4);
    return str;
}

function extractConfig(text, logFn = null, adminChatId = null, bot = null, diagnosticMode = false) {
    if (!text) {
        safeLog(adminChatId, bot, 'extractConfig: текст пуст', 'warn', diagnosticMode, logFn);
        return null;
    }
    let match = text.match(/\[\[\[\s*([\s\S]*?)\s*\]\]\]/);
    let inner = null;
    if (match) {
        inner = match[1].trim();
        safeLog(adminChatId, bot, 'extractConfig: найден маркер [[[ ... ]]]', 'info', diagnosticMode, logFn);
    } else {
        safeLog(adminChatId, bot, 'extractConfig: маркер не найден, ищем JSON-массив', 'info', diagnosticMode, logFn);
        const arrayMatch = text.match(/(\[\s*\[[\s\S]*?\]\s*\])/);
        if (arrayMatch) {
            inner = arrayMatch[1].trim();
            safeLog(adminChatId, bot, 'extractConfig: найден JSON-массив', 'info', diagnosticMode, logFn);
        } else {
            safeLog(adminChatId, bot, 'extractConfig: JSON-массив не найден', 'warn', diagnosticMode, logFn);
            return null;
        }
    }
    inner = inner.replace(/^\uFEFF/, '').trim();
    if (inner.startsWith('"') && inner.endsWith('"')) {
        inner = inner.substring(1, inner.length - 1);
    }
    inner = inner.replace(/\u00A0/g, ' ');
    try {
        const arr = JSON.parse(inner);
        if (Array.isArray(arr) && arr.length === 14) {
            safeLog(adminChatId, bot, `extractConfig: успешно извлечён массив из ${arr.length} элементов`, 'info', diagnosticMode, logFn);
            return arr;
        } else {
            safeLog(adminChatId, bot, `extractConfig: массив имеет длину ${arr.length}, ожидается 14`, 'warn', diagnosticMode, logFn);
            return null;
        }
    } catch (e) {
        safeLog(adminChatId, bot, `extractConfig: ошибка парсинга JSON: ${e.message}`, 'error', diagnosticMode, logFn);
        safeLog(adminChatId, bot, `Текст, который парсили: ${inner}`, 'error', diagnosticMode, logFn);
        return null;
    }
}

function applyConfig(arr) {
    if (!Array.isArray(arr) || arr.length !== 14) {
        throw new Error('Массив должен содержать ровно 14 элементов');
    }
    state.allowedDomains = arr[0] || [];
    state.allowedUsernames = arr[1] || [];
    state.allowedChannels = arr[2] || [];
    state.allowedGroups = arr[3] || [];
    state.allowedChannelsNoDomainCheck = arr[4] || [];
    state.allowedGroupsNoDomainCheck = arr[5] || [];
    state.YANDEX_TOKEN = arr[6] || '';
    state.DIAGNOSTIC_MODE = typeof arr[7] === 'boolean' ? arr[7] : false;
    state.ACTIVE_INTERVAL = typeof arr[8] === 'number' ? arr[8] : 3000;
    state.MAX_ACTIVE_ATTEMPTS = typeof arr[9] === 'number' ? arr[9] : 100;
    state.LONG_INTERVAL = typeof arr[10] === 'number' ? arr[10] : 60000;
    state.MAX_LONG_ATTEMPTS = typeof arr[11] === 'number' ? arr[11] : 20;
    state.PING_MIN_INTERVAL = typeof arr[12] === 'number' ? arr[12] : 10 * 60 * 1000;
    state.PING_MAX_INTERVAL = typeof arr[13] === 'number' ? arr[13] : 13 * 60 * 1000;
}

async function loadConfigFromPinned(adminChatId, bot, logFn = null, diagnosticMode = false) {
    if (!adminChatId) {
        safeLog(adminChatId, bot, 'loadConfigFromPinned: adminChatId не задан', 'warn', diagnosticMode, logFn);
        return false;
    }
    try {
        const chat = await bot.getChat(adminChatId);
        const pinned = chat.pinned_message;
        if (!pinned) {
            safeLog(adminChatId, bot, 'loadConfigFromPinned: закреплённое сообщение отсутствует', 'info', diagnosticMode, logFn);
            if (adminChatId) {
                bot.sendMessage(adminChatId, 'ℹ️ Закреплённое сообщение не найдено.').catch(() => {});
            }
            return false;
        }
        if (!pinned.text) {
            safeLog(adminChatId, bot, 'loadConfigFromPinned: закреплённое сообщение не содержит текст', 'warn', diagnosticMode, logFn);
            if (adminChatId) {
                bot.sendMessage(adminChatId, 'ℹ️ Закреплённое сообщение не содержит текст.').catch(() => {});
            }
            return false;
        }
        safeLog(adminChatId, bot, `loadConfigFromPinned: текст закреплённого сообщения получен, длина = ${pinned.text.length}`, 'info', diagnosticMode, logFn);
        const arr = extractConfig(pinned.text, logFn, adminChatId, bot, diagnosticMode);
        if (arr) {
            applyConfig(arr);
            safeLog(adminChatId, bot, 'loadConfigFromPinned: конфиг успешно применён', 'info', diagnosticMode, logFn);
            if (adminChatId) {
                bot.sendMessage(adminChatId, '✅ Конфиг загружен из закреплённого сообщения.').catch(() => {});
            }
            return true;
        } else {
            safeLog(adminChatId, bot, 'loadConfigFromPinned: не удалось извлечь массив из закреплённого сообщения', 'warn', diagnosticMode, logFn);
            if (adminChatId) {
                bot.sendMessage(adminChatId, '❌ Не удалось извлечь массив из закреплённого сообщения.').catch(() => {});
            }
            return false;
        }
    } catch (e) {
        safeLog(adminChatId, bot, `loadConfigFromPinned: ошибка: ${e.message}`, 'error', diagnosticMode, logFn);
        if (adminChatId) {
            bot.sendMessage(adminChatId, `❌ Ошибка загрузки конфига: ${e.message}`).catch(() => {});
        }
        return false;
    }
}

async function updatePinnedConfig(adminChatId, bot, arr, logFn = null, diagnosticMode = false) {
    if (!adminChatId) return false;
    try {
        const chat = await bot.getChat(adminChatId);
        const oldPinned = chat.pinned_message;
        if (oldPinned) {
            try {
                await bot.unpinChatMessage(adminChatId);
                await bot.deleteMessage(adminChatId, oldPinned.message_id);
                safeLog(adminChatId, bot, 'Старое закреплённое сообщение удалено', 'info', diagnosticMode, logFn);
            } catch (e) {
                safeLog(adminChatId, bot, `Не удалось удалить старое: ${e.message}`, 'warn', diagnosticMode, logFn);
            }
        }
        const text = `[[[\n${JSON.stringify(arr)}\n]]]`;
        const sent = await bot.sendMessage(adminChatId, text);
        await bot.pinChatMessage(adminChatId, sent.message_id);
        safeLog(adminChatId, bot, 'Новое закреплённое сообщение установлено', 'info', diagnosticMode, logFn);
        return true;
    } catch (e) {
        safeLog(adminChatId, bot, `Ошибка в updatePinnedConfig: ${e.message}`, 'error', diagnosticMode, logFn);
        return false;
    }
}

module.exports = state;
