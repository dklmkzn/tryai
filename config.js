// config.js — версия 1.1.28
// Состояние и методы бота.
// Кодирование/декодирование закреплённого сообщения: весь JSON → Base64.

const VERSION = '1.1.28';

const state = {
    VERSION,
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
    PING_MAX_INTERVAL: 13 * 60 * 1000,
    DEPLOY_HOOK_URL: '',
    COOKIES: '',

    // ===== ОБФУСКАЦИЯ (устаревшие методы, оставлены для совместимости, но не используются) =====
    encodeConfig(arr) { return arr; },
    decodeConfig(arr) { return arr; },
    encodeString(str) { return str; },
    decodeString(str) { return str; },

    // ===== ЛОГИРОВАНИЕ =====
    safeLog(adminChatId, bot, message, level, diagnosticMode, logFn) {
        if (logFn) {
            logFn(message, level, diagnosticMode);
        } else {
            if (diagnosticMode) {
                console.log(`[${level}] ${message}`);
            }
        }
    },

    // ===== МЕТОДЫ =====
    normalizeId(id) {
        const str = id.toString();
        if (str.startsWith('-100')) return str.substring(4);
        return str;
    },

    // Извлечение массива из текста (для команд от админа, без кодирования)
    extractConfig(text, logFn = null, adminChatId = null, bot = null, diagnosticMode = false) {
        if (!text) {
            this.safeLog(adminChatId, bot, 'extractConfig: текст пуст', 'warn', diagnosticMode, logFn);
            return null;
        }
        let match = text.match(/\[\[\[\s*([\s\S]*?)\s*\]\]\]/);
        let inner = null;
        if (match) {
            inner = match[1].trim();
            this.safeLog(adminChatId, bot, 'extractConfig: найден маркер [[[ ... ]]]', 'info', diagnosticMode, logFn);
        } else {
            this.safeLog(adminChatId, bot, 'extractConfig: маркер не найден, ищем JSON-массив', 'info', diagnosticMode, logFn);
            const arrayMatch = text.match(/(\[\s*\[[\s\S]*?\]\s*\])/);
            if (arrayMatch) {
                inner = arrayMatch[1].trim();
                this.safeLog(adminChatId, bot, 'extractConfig: найден JSON-массив', 'info', diagnosticMode, logFn);
            } else {
                this.safeLog(adminChatId, bot, 'extractConfig: JSON-массив не найден', 'warn', diagnosticMode, logFn);
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
            if (Array.isArray(arr) && arr.length === 16) {
                this.safeLog(adminChatId, bot, `extractConfig: успешно извлечён массив из ${arr.length} элементов`, 'info', diagnosticMode, logFn);
                return arr;
            } else {
                this.safeLog(adminChatId, bot, `extractConfig: массив имеет длину ${arr.length}, ожидается 16`, 'warn', diagnosticMode, logFn);
                return null;
            }
        } catch (e) {
            this.safeLog(adminChatId, bot, `extractConfig: ошибка парсинга JSON: ${e.message}`, 'error', diagnosticMode, logFn);
            this.safeLog(adminChatId, bot, `Текст, который парсили: ${inner}`, 'error', diagnosticMode, logFn);
            return null;
        }
    },

    applyConfig(arr) {
        if (!Array.isArray(arr) || arr.length !== 16) {
            throw new Error('Массив должен содержать ровно 16 элементов');
        }
        this.allowedDomains = arr[0] || [];
        this.allowedUsernames = arr[1] || [];
        this.allowedChannels = arr[2] || [];
        this.allowedGroups = arr[3] || [];
        this.allowedChannelsNoDomainCheck = arr[4] || [];
        this.allowedGroupsNoDomainCheck = arr[5] || [];
        this.YANDEX_TOKEN = arr[6] || '';
        this.DIAGNOSTIC_MODE = typeof arr[7] === 'boolean' ? arr[7] : false;
        this.ACTIVE_INTERVAL = typeof arr[8] === 'number' ? arr[8] : 3000;
        this.MAX_ACTIVE_ATTEMPTS = typeof arr[9] === 'number' ? arr[9] : 100;
        this.LONG_INTERVAL = typeof arr[10] === 'number' ? arr[10] : 60000;
        this.MAX_LONG_ATTEMPTS = typeof arr[11] === 'number' ? arr[11] : 20;
        this.PING_MIN_INTERVAL = typeof arr[12] === 'number' ? arr[12] : 10 * 60 * 1000;
        this.PING_MAX_INTERVAL = typeof arr[13] === 'number' ? arr[13] : 13 * 60 * 1000;
        this.DEPLOY_HOOK_URL = arr[14] || '';
        this.COOKIES = arr[15] || '';
    },

    // Загрузка из закреплённого сообщения (декодируем Base64 → JSON → массив)
    async loadConfigFromPinned(adminChatId, bot, logFn = null, diagnosticMode = false) {
        if (!adminChatId) {
            this.safeLog(adminChatId, bot, 'loadConfigFromPinned: adminChatId не задан', 'warn', diagnosticMode, logFn);
            return false;
        }
        try {
            const chat = await bot.getChat(adminChatId);
            const pinned = chat.pinned_message;
            if (!pinned) {
                this.safeLog(adminChatId, bot, 'loadConfigFromPinned: закреплённое сообщение отсутствует', 'info', diagnosticMode, logFn);
                return false;
            }
            if (!pinned.text) {
                this.safeLog(adminChatId, bot, 'loadConfigFromPinned: закреплённое сообщение не содержит текст', 'warn', diagnosticMode, logFn);
                return false;
            }
            const match = pinned.text.match(/\[\[\[\s*([\s\S]*?)\s*\]\]\]/);
            if (!match) {
                this.safeLog(adminChatId, bot, 'loadConfigFromPinned: не найден маркер [[[', 'warn', diagnosticMode, logFn);
                return false;
            }
            const encoded = match[1].trim();
            // Декодируем Base64
            const jsonString = Buffer.from(encoded, 'base64').toString('utf8');
            const arr = JSON.parse(jsonString);
            if (Array.isArray(arr) && arr.length === 16) {
                this.applyConfig(arr);
                this.safeLog(adminChatId, bot, 'loadConfigFromPinned: конфиг успешно применён (декодирован из JSON)', 'info', diagnosticMode, logFn);
                return true;
            } else {
                this.safeLog(adminChatId, bot, `loadConfigFromPinned: массив имеет длину ${arr.length}, ожидается 16`, 'warn', diagnosticMode, logFn);
                return false;
            }
        } catch (e) {
            this.safeLog(adminChatId, bot, `loadConfigFromPinned: ошибка: ${e.message}`, 'error', diagnosticMode, logFn);
            return false;
        }
    },

    // Сохранение в закреплённое сообщение (JSON → Base64)
    async updatePinnedConfig(adminChatId, bot, arr, logFn = null, diagnosticMode = false) {
        if (!adminChatId) return false;
        try {
            const chat = await bot.getChat(adminChatId);
            const oldPinned = chat.pinned_message;
            if (oldPinned) {
                try {
                    await bot.unpinChatMessage(adminChatId);
                    await bot.deleteMessage(adminChatId, oldPinned.message_id);
                    this.safeLog(adminChatId, bot, 'Старое закреплённое сообщение удалено', 'info', diagnosticMode, logFn);
                } catch (e) {
                    this.safeLog(adminChatId, bot, `Не удалось удалить старое: ${e.message}`, 'warn', diagnosticMode, logFn);
                }
            }
            // 1. Превращаем массив в JSON-строку
            const jsonString = JSON.stringify(arr);
            // 2. Кодируем в Base64
            const encoded = Buffer.from(jsonString, 'utf8').toString('base64');
            const text = `[[[\n${encoded}\n]]]`;
            const sent = await bot.sendMessage(adminChatId, text);
            await bot.pinChatMessage(adminChatId, sent.message_id);
            this.safeLog(adminChatId, bot, 'Новое закреплённое сообщение установлено (закодирован JSON)', 'info', diagnosticMode, logFn);
            return true;
        } catch (e) {
            this.safeLog(adminChatId, bot, `Ошибка в updatePinnedConfig: ${e.message}`, 'error', diagnosticMode, logFn);
            return false;
        }
    }
};

module.exports = state;
