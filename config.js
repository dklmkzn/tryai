// config.js — версия 1.1.2
// Настройки бота: переменные, applyConfig, extractConfig, loadConfigFromPinned.

// ===== ПЕРЕМЕННЫЕ (по умолчанию) =====
let allowedDomains = ['nplus1.ru', 'naked-science.ru', '300.ya.ru'];
let allowedUsernames = [];
let allowedChannels = [];
let allowedGroups = [];
let allowedChannelsNoDomainCheck = [];
let allowedGroupsNoDomainCheck = [];
let YANDEX_TOKEN = process.env.YANDEX_TOKEN || '';
let DIAGNOSTIC_MODE = process.env.DIAGNOSTIC_ENABLED === 'true' || false;
let ACTIVE_INTERVAL = 3000;
let MAX_ACTIVE_ATTEMPTS = 100;
let LONG_INTERVAL = 60000;
let MAX_LONG_ATTEMPTS = 20;
let PING_MIN_INTERVAL = 10 * 60 * 1000;
let PING_MAX_INTERVAL = 13 * 60 * 1000;

// ===== ФУНКЦИЯ ЛОГИРОВАНИЯ (устанавливается извне) =====
let logFn = console.log; // по умолчанию — консоль

function setLogFunction(fn) {
    if (typeof fn === 'function') {
        logFn = fn;
    }
}

// ===== ФУНКЦИИ =====

function normalizeId(id) {
    const str = id.toString();
    if (str.startsWith('-100')) return str.substring(4);
    return str;
}

function extractConfig(text) {
    if (!text) {
        logFn('extractConfig: текст пуст', 'info');
        return null;
    }
    let match = text.match(/\[\[\[\s*([\s\S]*?)\s*\]\]\]/);
    let inner = null;
    if (match) {
        inner = match[1].trim();
        logFn('extractConfig: найден маркер [[[ ... ]]]', 'info');
    } else {
        logFn('extractConfig: маркер не найден, ищем JSON-массив', 'info');
        const arrayMatch = text.match(/(\[\s*\[[\s\S]*?\]\s*\])/);
        if (arrayMatch) {
            inner = arrayMatch[1].trim();
            logFn('extractConfig: найден JSON-массив', 'info');
        } else {
            logFn('extractConfig: JSON-массив не найден', 'info');
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
            logFn(`extractConfig: успешно извлечён массив из ${arr.length} элементов`, 'info');
            return arr;
        } else {
            logFn(`extractConfig: массив имеет длину ${arr.length}, ожидается 14`, 'info');
            return null;
        }
    } catch (e) {
        logFn(`extractConfig: ошибка парсинга JSON: ${e.message}`, 'error');
        logFn(`Текст, который парсили: ${inner}`, 'error');
        return null;
    }
}

function applyConfig(arr) {
    if (!Array.isArray(arr) || arr.length !== 14) {
        throw new Error('Массив должен содержать ровно 14 элементов');
    }
    allowedDomains = arr[0] || [];
    allowedUsernames = arr[1] || [];
    allowedChannels = arr[2] || [];
    allowedGroups = arr[3] || [];
    allowedChannelsNoDomainCheck = arr[4] || [];
    allowedGroupsNoDomainCheck = arr[5] || [];
    YANDEX_TOKEN = arr[6] || '';
    DIAGNOSTIC_MODE = typeof arr[7] === 'boolean' ? arr[7] : false;
    ACTIVE_INTERVAL = typeof arr[8] === 'number' ? arr[8] : 3000;
    MAX_ACTIVE_ATTEMPTS = typeof arr[9] === 'number' ? arr[9] : 100;
    LONG_INTERVAL = typeof arr[10] === 'number' ? arr[10] : 60000;
    MAX_LONG_ATTEMPTS = typeof arr[11] === 'number' ? arr[11] : 20;
    PING_MIN_INTERVAL = typeof arr[12] === 'number' ? arr[12] : 10 * 60 * 1000;
    PING_MAX_INTERVAL = typeof arr[13] === 'number' ? arr[13] : 13 * 60 * 1000;
    logFn('✅ Конфиг применён', 'info');
}

async function loadConfigFromPinned(adminChatId, bot) {
    if (!adminChatId) {
        logFn('loadConfigFromPinned: adminChatId не задан', 'warn');
        return false;
    }
    try {
        const chat = await bot.getChat(adminChatId);
        const pinned = chat.pinned_message;
        if (!pinned) {
            logFn('loadConfigFromPinned: закреплённое сообщение отсутствует', 'info');
            if (adminChatId) {
                bot.sendMessage(adminChatId, 'ℹ️ Закреплённое сообщение не найдено.').catch(() => {});
            }
            return false;
        }
        if (!pinned.text) {
            logFn('loadConfigFromPinned: закреплённое сообщение не содержит текст', 'info');
            if (adminChatId) {
                bot.sendMessage(adminChatId, 'ℹ️ Закреплённое сообщение не содержит текст.').catch(() => {});
            }
            return false;
        }
        logFn(`loadConfigFromPinned: текст закреплённого сообщения получен, длина = ${pinned.text.length}`, 'info');
        const arr = extractConfig(pinned.text);
        if (arr) {
            applyConfig(arr);
            logFn('loadConfigFromPinned: конфиг успешно применён', 'info');
            if (adminChatId) {
                bot.sendMessage(adminChatId, '✅ Конфиг загружен из закреплённого сообщения.').catch(() => {});
            }
            return true;
        } else {
            logFn('loadConfigFromPinned: не удалось извлечь массив из закреплённого сообщения', 'info');
            if (adminChatId) {
                bot.sendMessage(adminChatId, '❌ Не удалось извлечь массив из закреплённого сообщения.').catch(() => {});
            }
            return false;
        }
    } catch (e) {
        logFn(`loadConfigFromPinned: ошибка: ${e.message}`, 'error');
        if (adminChatId) {
            bot.sendMessage(adminChatId, `❌ Ошибка загрузки конфига: ${e.message}`).catch(() => {});
        }
        return false;
    }
}

module.exports = {
    allowedDomains,
    allowedUsernames,
    allowedChannels,
    allowedGroups,
    allowedChannelsNoDomainCheck,
    allowedGroupsNoDomainCheck,
    YANDEX_TOKEN,
    DIAGNOSTIC_MODE,
    ACTIVE_INTERVAL,
    MAX_ACTIVE_ATTEMPTS,
    LONG_INTERVAL,
    MAX_LONG_ATTEMPTS,
    PING_MIN_INTERVAL,
    PING_MAX_INTERVAL,
    normalizeId,
    extractConfig,
    applyConfig,
    loadConfigFromPinned,
    setLogFunction
};
