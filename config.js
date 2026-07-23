// config.js — версия 1.1.27
// Состояние и методы бота, обфускация данных в закреплённом сообщении.

const VERSION = '1.1.27';

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

    // ===== ОБФУСКАЦИЯ =====
    encodeConfig(arr) {
        if (!Array.isArray(arr)) return arr;
        return arr.map(item => {
            if (Array.isArray(item)) return this.encodeConfig(item);
            if (typeof item === 'string') return this.encodeString(item);
            return item;
        });
    },
    decodeConfig(arr) {
        if (!Array.isArray(arr)) return arr;
        return arr.map(item => {
            if (Array.isArray(item)) return this.decodeConfig(item);
            if (typeof item === 'string') return this.decodeString(item);
            return item;
        });
    },
    encodeString(str) {
        if (!str) return '';
        let encoded = str.replace(/\d/g, d => 9 - parseInt(d));
        encoded = Buffer.from(encoded, 'utf8').toString('base64');
        return encoded;
    },
    decodeString(str) {
        if (!str) return '';
        let decoded = Buffer.from(str, 'base64').toString('utf8');
        decoded = decoded.replace(/\d/g, d => 9 - parseInt(d));
        return decoded;
    },

    // ===== ЛОГИРОВАНИЕ (критические ошибки через logFn, остальное по флагу) =====
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
                return arr; // возвращаем как есть (закодированный)
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
            const arr = this.extractConfig(pinned.text, logFn, adminChatId, bot, diagnosticMode);

           
            if (arr) {
                // Декодируем массив
                const decodedArr = this.decodeConfig(arr);


// ===== ОТЛАДОЧНАЯ ПЕЧАТЬ =====
try {
    await bot.sendMessage(adminChatId, `📋 Декодированный массив:\n\`\`\`json\n${JSON.stringify(decodedArr, null, 2)}\n\`\`\``, { parse_mode: 'Markdown' });
} catch (e) {
    console.error('Не удалось отправить отладку:', e.message);
}
// ============================

                
                this.applyConfig(decodedArr);
                this.safeLog(adminChatId, bot, 'loadConfigFromPinned: конфиг успешно применён (декодирован)', 'info', diagnosticMode, logFn);
                return true;
            } else {
                this.safeLog(adminChatId, bot, 'loadConfigFromPinned: не удалось извлечь массив', 'error', diagnosticMode, logFn);
                return false;
            }
        } catch (e) {
            this.safeLog(adminChatId, bot, `loadConfigFromPinned: ошибка: ${e.message}`, 'error', diagnosticMode, logFn);
            return false;
        }
    },

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
            // Кодируем массив перед сохранением
            const encodedArr = this.encodeConfig(arr);
            const text = `[[[\n${JSON.stringify(encodedArr)}\n]]]`;
            const sent = await bot.sendMessage(adminChatId, text);
            await bot.pinChatMessage(adminChatId, sent.message_id);
            this.safeLog(adminChatId, bot, 'Новое закреплённое сообщение установлено (закодировано)', 'info', diagnosticMode, logFn);
            return true;
        } catch (e) {
            this.safeLog(adminChatId, bot, `Ошибка в updatePinnedConfig: ${e.message}`, 'error', diagnosticMode, logFn);
            return false;
        }
    }
};

module.exports = state;
