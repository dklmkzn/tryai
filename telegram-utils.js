// telegram-utils.js — версия 1.1.26
// Утилиты для работы с Telegram: логирование, обработка ссылок, self-ping.

const axios = require('axios');

// ===== ЛОГИРОВАНИЕ (критические ошибки всегда, остальное по флагу) =====
function logMessage(adminChatId, bot, message, level = 'info', diagnosticMode = false) {
    const isCritical = level === 'error' && (
        message.includes('Self-ping failed') ||
        message.includes('Недостаточно параметров') ||
        message.includes('Дежурный пинг') ||
        message.includes('RENDER_URL') ||
        message.includes('getShortUrl') ||
        message.includes('extractTextFromYaRu')
    );

    // Критические ошибки всегда выводятся в консоль и отправляются админу (если он есть)
    if (isCritical) {
        console.error(`[${level}] ${message}`);
        if (adminChatId && bot) {
            bot.sendMessage(adminChatId, `⚠️ ${message}`).catch(e => console.error('Ошибка отправки критического:', e.message));
        }
        return;
    }

    // Если админ не назначен — выводим в консоль (полезно до назначения)
    if (!adminChatId) {
        console.log(`[${level}] ${message}`);
        return;
    }

    // Если диагностика включена — отправляем в личку
    if (diagnosticMode) {
        if (bot) {
            bot.sendMessage(adminChatId, `📝 ${message}`).catch(e => {
                console.error(`Не удалось отправить диагностику: ${e.message}`);
                console.log(`[${level}] ${message}`);
            });
        }
        return;
    }
    // Если диагностика выключена и не критично — ничего не делаем
}

function logToAdmin(adminChatId, bot, message) {
    logMessage(adminChatId, bot, message, 'info', false);
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
        axios.get(url).catch(err => {
            console.error('Self-ping failed:', err.message);
        });
    }, 1000);
}

async function processUrl(chatId, text, originalMessageId, deps) {
    const { bot, tasks, adminChatId, logMessage, notifyAdmin, getShortUrl, scheduleSelfPing, renderUrl, diagnosticMode } = deps;

    const urlMatch = text.match(/https?:\/\/[^\s]+/);
    if (!urlMatch) return;

    const originalUrl = urlMatch[0];
    logMessage(adminChatId, bot, `🔗 Обработка ссылки: ${originalUrl}`, 'info', diagnosticMode);

    try {
        const shortResult = await getShortUrl(originalUrl, null, logMessage, adminChatId, bot, diagnosticMode);
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
        logMessage(adminChatId, bot, `✅ Задача создана: ${taskId}`, 'info', diagnosticMode);
    } catch (e) {
        console.error('Ошибка при обработке ссылки:', e);
        await bot.sendMessage(chatId, 'Произошла ошибка при обработке ссылки.');
        await notifyAdmin(adminChatId, bot, `Ошибка обработки ссылки: ${e.message}`);
    }
}

module.exports = {
    logMessage,
    logToAdmin,
    notifyAdmin,
    isUsernameMatchMask,
    scheduleSelfPing,
    processUrl
};
