// telegram-utils.js — утилиты для работы с Telegram

const config = require('./config');
const { getShortUrl, extractTextFromYaRu, formatNews } = require('./yandex-utils');

// ===== ПЕРЕМЕННЫЕ ДЛЯ ЭКСПОРТА (будут заполнены в index.js) =====
let botInstance = null;
let adminChatId = null;
let tasks = null;
let scheduleSelfPingFn = null;
let logToAdminFn = null;

// ===== УСТАНОВКА ЗАВИСИМОСТЕЙ =====
function setDependencies(bot, adminId, tasksMap, scheduleFn, logFn) {
    botInstance = bot;
    adminChatId = adminId;
    tasks = tasksMap;
    scheduleSelfPingFn = scheduleFn;
    logToAdminFn = logFn;
}

// ===== ФУНКЦИЯ ЛОГИРОВАНИЯ =====
function logToAdmin(message) {
    if (logToAdminFn) {
        logToAdminFn(message);
    } else {
        console.log(message);
        if (adminChatId && botInstance) {
            botInstance.sendMessage(adminChatId, `📝 ${message}`).catch(() => {});
        }
    }
}

// ===== УВЕДОМЛЕНИЕ АДМИНА =====
async function notifyAdmin(message) {
    if (!adminChatId) {
        console.warn('Администратор ещё не назначен, уведомление не отправлено:', message);
        return;
    }
    try {
        await botInstance.sendMessage(adminChatId, `⚠️ ${message}`);
    } catch (e) {
        console.error('Не удалось отправить уведомление админу:', e.message);
    }
}

// ===== ОБРАБОТКА ССЫЛОК (без проверки домена) =====
async function processUrl(chatId, text, originalMessageId = null) {
    const urlMatch = text.match(/https?:\/\/[^\s]+/);
    if (!urlMatch) return;

    const originalUrl = urlMatch[0];
    logToAdmin(`🔗 Обработка ссылки: ${originalUrl}`);

    try {
        const shortResult = await getShortUrl(originalUrl);
        if (shortResult.status === 'error') {
            await botInstance.sendMessage(chatId, '❌ Не удалось получить ссылку на пересказ.');
            await notifyAdmin(`Ошибка получения shortUrl: ${originalUrl} - ${shortResult.message}`);
            return;
        }
        const shortUrl = shortResult.sharing_url;

        let sentMsg;
        if (originalMessageId) {
            await botInstance.editMessageText(`✅ Ссылка на пересказ: ${shortUrl}\nТекст готовится, ожидайте...`, {
                chat_id: chatId,
                message_id: originalMessageId
            });
            sentMsg = { message_id: originalMessageId };
        } else {
            sentMsg = await botInstance.sendMessage(chatId, `✅ Ссылка на пересказ: ${shortUrl}\nТекст готовится, ожидайте...`);
        }

        const taskId = `task_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
        const params = {
            shortUrl,
            chatId,
            messageId: sentMsg.message_id,
            attempt: 1,
            phase: 'active'
        };
        tasks.set(taskId, { ...params, createdAt: Date.now() });

        if (scheduleSelfPingFn) {
            scheduleSelfPingFn(params);
        }
        logToAdmin(`✅ Задача создана: ${taskId}`);
    } catch (e) {
        console.error('Ошибка при обработке ссылки:', e);
        await botInstance.sendMessage(chatId, 'Произошла ошибка при обработке ссылки.');
        await notifyAdmin(`Ошибка обработки ссылки: ${e.message}`);
    }
}

// ===== ПРОВЕРКА СООТВЕТСТВИЯ USERNAME МАСКЕ =====
function isUsernameMatchMask(username, mask) {
    if (!username || !mask) return false;
    if (mask.length !== 3 || mask[1] !== '*') return false;
    const first = mask[0];
    const last = mask[2];
    return username[0] === first && username[username.length - 1] === last;
}

// ===== НОРМАЛИЗАЦИЯ ID (удаление -100) =====
function normalizeId(id) {
    const str = id.toString();
    if (str.startsWith('-100')) return str.substring(4);
    return str;
}

module.exports = {
    setDependencies,
    logToAdmin,
    notifyAdmin,
    processUrl,
    isUsernameMatchMask,
    normalizeId
};
