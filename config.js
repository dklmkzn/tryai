// config.js — версия 1.1.1
// Настройки бота: переменные конфигурации, функции applyConfig, extractConfig, loadConfigFromPinned.

// ===== ПЕРЕМЕННЫЕ (по умолчанию, перезаписываются через applyConfig) =====
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

// ===== ФУНКЦИИ =====

function normalizeId(id) {
    const str = id.toString();
    if (str.startsWith('-100')) return str.substring(4);
    return str;
}

function extractConfig(text) {
    if (!text) {
        console.log('extractConfig: текст пуст');
        return null;
    }
    let match = text.match(/\[\[\[\s*([\s\S]*?)\s*\]\]\]/);
    let inner = null;
    if (match) {
        inner = match[1].trim();
        console.log('extractConfig: найден маркер [[[ ... ]]]');
    } else {
        console.log('extractConfig: маркер не найден, ищем JSON-массив');
        const arrayMatch = text.match(/(\[\s*\[[\s\S]*?\]\s*\])/);
        if (arrayMatch) {
            inner = arrayMatch[1].trim();
            console.log('extractConfig: найден JSON-массив');
        } else {
            console.log('extractConfig: JSON-массив не найден');
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
            console.log(`extractConfig: успешно извлечён массив из ${arr.length} элементов`);
            return arr;
        } else {
            console.log(`extractConfig: массив имеет длину ${arr.length}, ожидается 14`);
            return null;
        }
    } catch (e) {
        console.error('extractConfig: ошибка парсинга JSON:', e.message);
        console.error('Текст, который парсили:', inner);
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
    console.log('✅ Конфиг применён');
}

async function loadConfigFromPinned(adminChatId, bot) {
    if (!adminChatId) {
        console.warn('loadConfigFromPinned: adminChatId не задан');
        return false;
    }
    try {
        const chat = await bot.getChat(adminChatId);
        const pinned = chat.pinned_message;
        if (!pinned) {
            console.log('loadConfigFromPinned: закреплённое сообщение отсутствует');
            if (adminChatId) {
                bot.sendMessage(adminChatId, 'ℹ️ Закреплённое сообщение не найдено.').catch(() => {});
            }
            return false;
        }
        if (!pinned.text) {
            console.log('loadConfigFromPinned: закреплённое сообщение не содержит текст');
            if (adminChatId) {
                bot.sendMessage(adminChatId, 'ℹ️ Закреплённое сообщение не содержит текст.').catch(() => {});
            }
            return false;
        }
        console.log('loadConfigFromPinned: текст закреплённого сообщения получен, длина =', pinned.text.length);
        const arr = extractConfig(pinned.text);
        if (arr) {
            applyConfig(arr);
            console.log('loadConfigFromPinned: конфиг успешно применён');
            if (adminChatId) {
                bot.sendMessage(adminChatId, '✅ Конфиг загружен из закреплённого сообщения.').catch(() => {});
            }
            return true;
        } else {
            console.log('loadConfigFromPinned: не удалось извлечь массив из закреплённого сообщения');
            if (adminChatId) {
                bot.sendMessage(adminChatId, '❌ Не удалось извлечь массив из закреплённого сообщения. Проверьте, что он содержит маркер [[[ ... ]]] или валидный JSON-массив.').catch(() => {});
            }
            return false;
        }
    } catch (e) {
        console.error('loadConfigFromPinned: ошибка:', e);
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
