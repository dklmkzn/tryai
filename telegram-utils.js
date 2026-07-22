// telegram-utils.js — версия 1.1.1
// Утилиты для работы с Telegram: логирование, уведомления, обработка ссылок, self-ping.

const axios = require('axios');

// ===== ФУНКЦИИ =====

function logToAdmin(adminChatId, bot, message) {
    const alwaysShow = [
        'Self-ping failed:',
        'Недостаточно параметров в /process',
        'Дежурный пинг не удался:',
        'RENDER_URL не определён, вебхук не может быть установлен',
        'Ошибка установки вебхука:'
    ];
    const isAlways = alwaysShow.some(prefix => message.includes(prefix));
    // В этой версии мы не проверяем DIAGNOSTIC_MODE, так как это делается в вызывающем коде.
    // Мы просто логируем в консоль и отправляем админу, если он есть.
    console.log(message);
    if (adminChatId && bot) {
        bot.sendMessage(adminChatId, `📝 ${message}`).catch(() => {});
    }
}

async function notifyAdmin(adminChatId, bot, message) {
    if (!adminChatId) {
        console.warn('Администратор ещё не назначен, уведомление не отправлено:', message);
        return;
    }
    try {
        await bot.sendMessage(adminChatId, `⚠️ ${message}`);
    } catch (e) {
        console.error('Не удалось отправить уведомление админу:', e.message);
    }
}

function isUsernameMatchMask(username, mask) {
    if (!username || !mask) return false;
    if (mask.length !== 3 || mask[1] !== '*') return false;
    const first = mask[0];
    const last = mask[2];
    return username[0] === first && username[username.length - 1] === last;
}

function scheduleSelfPing(params, renderUrl) {
    const url = `${renderUrl}/process?` + new URLSearchParams(params).toString();
    setTimeout(() => {
        axios.get(url).catch(err => console.error('Self-ping failed:', err.message));
    }, 1000);
}

async function processUrl(chatId, text, originalMessageId, deps) {
    // deps: { bot, tasks, adminChatId, logToAdmin, notifyAdmin, getShortUrl, scheduleSelfPing, renderUrl }
    const { bot, tasks, adminChatId, logToAdmin, notifyAdmin, getShortUrl, scheduleSelfPing, renderUrl } = deps;

    const urlMatch = text.match(/https?:\/\/[^\s]+/);
    if (!urlMatch) return;

    const originalUrl = urlMatch[0];
    logToAdmin(adminChatId, bot, `🔗 Обработка ссылки: ${originalUrl}`);

    try {
        const shortResult = await getShortUrl(originalUrl);
        if (shortResult.status === 'error') {
            await bot.sendMessage(chatId, '❌ Не удалось получить ссылку на пересказ.');
            await notifyAdmin(adminChatId, bot, `Ошибка получения shortUrl: ${originalUrl} - ${shortResult.message}`);
            return;
        }
        const shortUrl = shortResult.sharing_url;

        let sentMsg;
        if (originalMessageId) {
            await bot.editMessageText(`✅ Ссылка на пересказ: ${shortUrl}\nТекст готовится, ожидайте...`, {
                chat_id: chatId,
                message_id: originalMessageId
            });
            sentMsg = { message_id: originalMessageId };
        } else {
            sentMsg = await bot.sendMessage(chatId, `✅ Ссылка на пересказ: ${shortUrl}\nТекст готовится, ожидайте...`);
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

        scheduleSelfPing(params, renderUrl);
        logToAdmin(adminChatId, bot, `✅ Задача создана: ${taskId}`);
    } catch (e) {
        console.error('Ошибка при обработке ссылки:', e);
        await bot.sendMessage(chatId, 'Произошла ошибка при обработке ссылки.');
        await notifyAdmin(adminChatId, bot, `Ошибка обработки ссылки: ${e.message}`);
    }
}

// ===== ЭКСПОРТ =====
module.exports = {
    logToAdmin,
    notifyAdmin,
    isUsernameMatchMask,
    scheduleSelfPing,
    processUrl
};
