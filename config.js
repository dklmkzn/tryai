// config.js — версия 1.1.5
// Настройки бота: переменные конфигурации, функции applyConfig, extractConfig,
// loadConfigFromPinned, updatePinnedConfig (с циклом открепления всех сообщений).

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

// ===== ЛОГИРОВАНИЕ =====
function safeLog(adminChatId, bot, message, level, diagnosticMode, logFn) {
    //bot.sendMessage(adminChatId, message);
    if (logFn) {
        logFn(message, level);
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
}

// ===== РАБОТА С ЗАКРЕПЛЁННЫМИ СООБЩЕНИЯМИ =====

async function updatePinnedConfig(adminChatId, bot, arr, logFn = null, diagnosticMode = false) {
    if (!adminChatId) return false;
    try {
        // Получаем информацию о чате
        const chat = await bot.getChat(adminChatId);
        // Открепляем ВСЕ закреплённые сообщения (цикл)
        let pinned = chat.pinned_message;
        let iteration = 0;
        while (pinned && iteration < 10) { // защита от бесконечного цикла
            try {
                await bot.unpinChatMessage(adminChatId, pinned.message_id);
                safeLog(adminChatId, bot, `Откреплено сообщение ${pinned.message_id}`, 'info', diagnosticMode, logFn);
                // После открепления получаем обновлённый список
                const updatedChat = await bot.getChat(adminChatId);
                pinned = updatedChat.pinned_message;
            } catch (e) {
                safeLog(adminChatId, bot, `Ошибка открепления: ${e.message}`, 'warn', diagnosticMode, logFn);
                break;
            }
            iteration++;
        }
        // Удаляем старые сообщения (если они от бота)
        // (Мы не можем удалить все, но можем удалить последнее откреплённое, если нужно)
        // Однако для чистоты лучше просто открепить и оставить их в истории.
        // Если хотите удалять, можно добавить deleteMessage, но это необязательно.

        // Формируем текст нового сообщения (только массив)
        const text = `[[[\n${JSON.stringify(arr)}\n]]]`;

        // Отправляем новое сообщение
        const sent = await bot.sendMessage(adminChatId, text);

        // Закрепляем его
        try {
            await bot.pinChatMessage(adminChatId, sent.message_id);
            safeLog(adminChatId, bot, 'Новое закреплённое сообщение установлено', 'info', diagnosticMode, logFn);
        } catch (e) {
            safeLog(adminChatId, bot, `Не удалось закрепить сообщение: ${e.message}`, 'warn', diagnosticMode, logFn);
        }

                // === ДОБАВЛЕННАЯ ПРОВЕРКА ===
        // Ждём 1 секунду, чтобы Telegram успел обновить закреп
        await new Promise(resolve => setTimeout(resolve, 1000));

        // Проверяем, что закрепилось именно наше сообщение
        const updatedChat = await bot.getChat(adminChatId);
        const newPinned = updatedChat.pinned_message;
        if (newPinned && newPinned.message_id === sent.message_id) {
            safeLog(adminChatId, bot, 'Проверка: закреплённое сообщение совпадает с отправленным', 'info', diagnosticMode, logFn);
        } else {
            // Если закрепилось что-то другое или не закрепилось ничего
            safeLog(adminChatId, bot, `Проверка: закреплённое сообщение не совпадает! Ожидалось message_id=${sent.message_id}, получено ${newPinned ? newPinned.message_id : 'null'}`, 'warn', diagnosticMode, logFn);
            // Можно попробовать закрепить повторно
            if (newPinned && newPinned.message_id !== sent.message_id) {
                try {
                    await bot.unpinChatMessage(adminChatId);
                    await bot.pinChatMessage(adminChatId, sent.message_id);
                    safeLog(adminChatId, bot, 'Повторная попытка закрепления выполнена', 'info', diagnosticMode, logFn);
                } catch (e2) {
                    safeLog(adminChatId, bot, `Повторная попытка закрепления не удалась: ${e2.message}`, 'error', diagnosticMode, logFn);
                }
            }
        }
        // ==========================


        return true;
    } catch (e) {
        safeLog(adminChatId, bot, `Ошибка в updatePinnedConfig: ${e.message}`, 'error', diagnosticMode, logFn);
        return false;
    }
}

async function loadConfigFromPinned(adminChatId, bot, logFn = null, diagnosticMode = false) {
    if (!adminChatId) return false;
    try {
        const chat = await bot.getChat(adminChatId);
        const pinned = chat.pinned_message;
        if (!pinned) {
            safeLog(adminChatId, bot, 'Закреплённое сообщение отсутствует', 'info', diagnosticMode, logFn);
            return false;
        }
        if (!pinned.text) {
            safeLog(adminChatId, bot, 'Закреплённое сообщение не содержит текст', 'warn', diagnosticMode, logFn);
            return false;
        }
        safeLog(adminChatId, bot, `Текст закреплённого сообщения: ${pinned.text}...`, 'info', diagnosticMode, logFn);


        
        const arr = extractConfig(pinned.text, logFn, adminChatId, bot, diagnosticMode);
        if (arr) {
            applyConfig(arr);
            safeLog(adminChatId, bot, 'Конфиг загружен из закреплённого сообщения', 'info', diagnosticMode, logFn);
            return true;
        } else {
            safeLog(adminChatId, bot, 'Не удалось извлечь массив из закреплённого сообщения', 'warn', diagnosticMode, logFn);
            return false;
        }
    } catch (e) {
        safeLog(adminChatId, bot, `Ошибка загрузки конфига: ${e.message}`, 'error', diagnosticMode, logFn);
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
    updatePinnedConfig
};
