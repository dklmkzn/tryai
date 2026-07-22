// config.js — версия 1.1.2
// Настройки бота: переменные конфигурации, функции applyConfig, extractConfig, loadConfigFromPinned.
// Логирование через logMessage (если передан) или console (если не передан).

// ===== ПЕРЕМЕННЫЕ (по умолчанию, перезаписываются через applyConfig) =====
let allowedDomains = ['nplus1.ru', 'naked-science.ru', '300.ya.ru'];
let allowedUsernames = [];
let allowedChannels = [];
let allowedGroups = [];
let allowedChannelsNoDomainCheck = [];
let allowedGroupsNoDomainCheck = [];
let YANDEX_TOKEN = process.env.YANDEX_TOKEN || '';
let DIAGNOSTIC_MODE = process.env.DIAGNOSTIC_ENABLED === 'true' || true;
let ACTIVE_INTERVAL = 3000;
let MAX_ACTIVE_ATTEMPTS = 100;
let LONG_INTERVAL = 60000;
let MAX_LONG_ATTEMPTS = 20;
let PING_MIN_INTERVAL = 10 * 60 * 1000;
let PING_MAX_INTERVAL = 13 * 60 * 1000;

// ===== ВСПОМОГАТЕЛЬНАЯ ФУНКЦИЯ ДЛЯ ЛОГИРОВАНИЯ (если не передана, использует console) =====
function safeLog(adminChatId, bot, message, level, diagnosticMode, logFn) {
    if (logFn) {
        logFn(adminChatId, bot, message, level, diagnosticMode);
    } else {
        // fallback: выводим в консоль
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
    // Не логируем здесь, так как логирование будет в вызывающем коде
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
        bot.sendMessage(adminChatId, pinned.text).catch(() => {});
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
                bot.sendMessage(adminChatId, '❌ Не удалось извлечь массив из закреплённого сообщения. Проверьте, что он содержит маркер [[[ ... ]]] или валидный JSON-массив.').catch(() => {});
                bot.sendMessage(adminChatId, '❌ Не удалось извлечь массив из закреплённого сообщения. Проверьте, что он содержит маркер [[[ ... ]]] или валидный JSON-массив.').catch(() => {});
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

// ===== ЭКСПОРТ =====
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
    loadConfigFromPinned
};
