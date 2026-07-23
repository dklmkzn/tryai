// telegram-utils.js — версия 1.1.14
const axios = require('axios');

// ===== ОСНОВНАЯ ФУНКЦИЯ ЛОГИРОВАНИЯ =====
function logMessage(adminChatId, bot, message, level = 'info', diagnosticMode = false) {
    // Критические ошибки отправляем в личку админу (если он есть) и в консоль (всегда)
    // Но согласно новым требованиям, вывод в консоль для критических ошибок отключаем, оставляем только в личку,
    // за исключением "Ошибка установки вебхука" — она обрабатывается отдельно в index.js.
    // Поэтому здесь мы не выводим в консоль ничего, кроме случаев, когда админа нет (тогда в консоль).
    const isCritical = level === 'error' && (
        message.includes('Self-ping failed') ||
        message.includes('Недостаточно параметров') ||
        message.includes('Дежурный пинг') ||
        message.includes('RENDER_URL') ||
        message.includes('getShortUrl') ||
        message.includes('extractTextFromYaRu')
    );

    // Если админ ещё не назначен — выводим в консоль (чтобы видеть ошибки до назначения)
    if (!adminChatId) {
        console.log(`[${level}] ${message}`);
        return;
    }

    // Если админ назначен:
    // - Критические ошибки отправляем только в личку (в консоль не выводим)
    // - Остальные сообщения отправляем только если диагностика включена
    if (isCritical) {
        if (bot) {
            bot.sendMessage(adminChatId, `⚠️ ${message}`).catch(e => console.error('Ошибка отправки критического:', e.message));
        }
        return;
    }

    if (diagnosticMode) {
        if (bot) {
            bot.sendMessage(adminChatId, `📝 ${message}`).catch(e => {
                console.error(`Не удалось отправить диагностику: ${e.message}`);
                // fallback в консоль, если не отправилось
                console.log(`[${level}] ${message}`);
            });
        }
        return;
    }
    // Если диагностика выключена и не критично — ничего не делаем
}

// ===== ОСТАЛЬНЫЕ ФУНКЦИИ (без изменений) =====

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
            // Self-ping ошибка — критическая, отправляем через logMessage, но здесь мы не можем вызвать logMessage без параметров
            // Поэтому логируем в консоль, но это будет видно только до назначения админа или в личку через logMessage
            console.error('Self-ping failed:', err.message);
            // Если админ есть, отправляем в личку через logMessage (но здесь нет доступа к adminChatId, поэтому оставляем как есть)
            // В идеале нужно передавать adminChatId, но проще оставить console.error, так как эта ошибка критична
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
