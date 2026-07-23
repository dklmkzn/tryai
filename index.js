// index.js — версия 1.1.16
const VERSION = '1.1.16';
const express = require('express');
const axios = require('axios');
const TelegramBot = require('node-telegram-bot-api');

const state = require('./config');
const yandex = require('./yandex-utils');
const tgUtils = require('./telegram-utils');

const BOT_TOKEN = process.env.BOT_TOKEN;
const RENDER_URL = process.env.RENDER_EXTERNAL_URL || process.env.RENDER_URL;
const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.json());

const bot = new TelegramBot(BOT_TOKEN);
const tasks = new Map();
let adminChatId = null;
const greetedUsers = new Map();

// Устанавливаем токен из состояния (если есть)
yandex.setYandexToken(state.YANDEX_TOKEN);

// ===== ФУНКЦИЯ ЛОГИРОВАНИЯ =====
function log(message, level = 'info', diagnosticMode = false) {
    tgUtils.logMessage(adminChatId, bot, message, level, diagnosticMode || state.DIAGNOSTIC_MODE);
}

// ===== ВЫВОД ВЕРСИЙ В ЛИЧКУ (если диагностика включена) =====
function logVersions() {
    const versions = {
        'config.js': state.VERSION || '1.1.16',
        'index.js': VERSION,
        'yandex-utils.js': yandex.VERSION || '1.1.25',
        'telegram-utils.js': tgUtils.VERSION || '1.1.16'
    };
    const msg = `📋 Версии модулей:\n${Object.entries(versions).map(([k, v]) => `${k}: ${v}`).join('\n')}`;
    log(msg, 'info');
}

// ===== ОБРАБОТЧИК ВЕБХУКА =====
app.post('/webhook', async (req, res) => {
    res.sendStatus(200);

    const update = req.body;
    const message = update.message || update.channel_post;
    if (!message || !message.text) return;

    const chatId = message.chat.id;
    const chatType = message.chat.type;
    const text = message.text;
    const username = message.from?.username || 'без username';
    const userId = message.from?.id;
    const chatIdStrNorm = state.normalizeId(chatId);

    if (chatType === 'private') {
        if (chatId === adminChatId) {
            // Конфиг через [[[
            if (text.includes('[[')) {
                const arr = state.extractConfig(text, log, adminChatId, bot, state.DIAGNOSTIC_MODE);
                if (arr) {
                    try {
                        state.applyConfig(arr);
                        yandex.setYandexToken(state.YANDEX_TOKEN);
                        await state.updatePinnedConfig(adminChatId, bot, arr, log, state.DIAGNOSTIC_MODE);
                        await bot.sendMessage(adminChatId, '✅ Конфиг обновлён и закреплён.');
                        if (state.DIAGNOSTIC_MODE) logVersions();
                    } catch (e) {
                        await bot.sendMessage(adminChatId, `❌ Ошибка: ${e.message}`);
                    }
                } else {
                    await bot.sendMessage(adminChatId, '❌ Не удалось извлечь конфиг.');
                }
                return;
            }

            // /reload
            if (text.startsWith('/reload')) {
                const loaded = await state.loadConfigFromPinned(adminChatId, bot, log, true);
                if (loaded) {
                    yandex.setYandexToken(state.YANDEX_TOKEN);
                    await bot.sendMessage(adminChatId, '✅ Конфиг перезагружен.');
                    if (state.DIAGNOSTIC_MODE) logVersions();
                } else {
                    await bot.sendMessage(adminChatId, '❌ Не удалось загрузить конфиг.');
                }
                return;
            }

            // /unpin
            if (text.startsWith('/unpin')) {
                try {
                    const chat = await bot.getChat(adminChatId);
                    const pinned = chat.pinned_message;
                    if (!pinned) {
                        await bot.sendMessage(adminChatId, 'ℹ️ Закреплённое сообщение не найдено.');
                        return;
                    }
                    await bot.unpinChatMessage(adminChatId);
                    await bot.deleteMessage(adminChatId, pinned.message_id);
                    await bot.sendMessage(adminChatId, '✅ Закреплённое сообщение удалено.');
                } catch (e) {
                    await bot.sendMessage(adminChatId, `❌ Ошибка: ${e.message}`);
                }
                return;
            }

            // /new — запуск деплоя
            if (text.startsWith('/new')) {
                const hookId = state.DEPLOY_HOOK_ID;
                if (!hookId) {
                    await bot.sendMessage(adminChatId, '❌ Deploy Hook ID не задан в конфиге.');
                    return;
                }
                const hookUrl = `https://api.render.com/deploy/${hookId}`;
                try {
                    const response = await axios.post(hookUrl);
                    if (response.status === 200 || response.status === 204) {
                        await bot.sendMessage(adminChatId, '✅ Деплой запущен! Ожидайте обновления.');
                        log(`Запущен деплой через hook: ${hookUrl}`, 'info');
                    } else {
                        await bot.sendMessage(adminChatId, `⚠️ Деплой вернул статус ${response.status}`);
                    }
                } catch (e) {
                    await bot.sendMessage(adminChatId, `❌ Ошибка при запуске деплоя: ${e.message}`);
                    log(`Ошибка деплоя: ${e.message}`, 'error');
                }
                return;
            }

            // Обработка ссылки
            await tgUtils.processUrl(chatId, text, null, {
                bot,
                tasks,
                adminChatId,
                logMessage: tgUtils.logMessage,
                notifyAdmin: tgUtils.notifyAdmin,
                getShortUrl: yandex.getShortUrl,
                scheduleSelfPing: tgUtils.scheduleSelfPing,
                renderUrl: RENDER_URL,
                diagnosticMode: state.DIAGNOSTIC_MODE
            });
            return;
        }

        // === АДМИНИСТРАТОР ЕЩЁ НЕ НАЗНАЧЕН ===
        if (!adminChatId) {
            if (!greetedUsers.has(chatId)) {
                greetedUsers.set(chatId, true);
                await bot.sendMessage(chatId, 'Здравствуйте!');
                return;
            }

            const maskMatch = text.match(/^([a-zA-Zа-яА-Я])\*([a-zA-Zа-яА-Я])$/);
            if (maskMatch) {
                const mask = maskMatch[0];
                if (tgUtils.isUsernameMatchMask(username, mask)) {
                    adminChatId = chatId;
                    let greeting = '✅ Вы назначились администратором.';
                    try {
                        const configLoaded = await state.loadConfigFromPinned(adminChatId, bot, log, state.DIAGNOSTIC_MODE);
                        if (configLoaded) {
                            yandex.setYandexToken(state.YANDEX_TOKEN);
                            if (state.DIAGNOSTIC_MODE) logVersions();
                        } else {
                            greeting += '\nКонфиг не найден, используются значения по умолчанию.';
                        }
                    } catch (e) {
                        log(`Ошибка загрузки конфига: ${e.message}`, 'error');
                        greeting += '\n⚠️ Ошибка загрузки конфига.';
                    }
                    await bot.sendMessage(adminChatId, greeting);
                    return;
                } else {
                    await bot.sendMessage(chatId, 'Здравствуйте!');
                    return;
                }
            } else {
                greetedUsers.set(chatId, true);
                await bot.sendMessage(chatId, 'Здравствуйте!', { parse_mode: 'Markdown' });
                return;
            }
        }
    }

    // === КАНАЛЫ И ГРУППЫ ===
    const isChannel = chatType === 'channel';
    const isGroup = chatType === 'group' || chatType === 'supergroup';

    if (isChannel) {
        if (!state.allowedChannels.includes(chatIdStrNorm)) {
            log(`❌ Канал ${chatId} не разрешён`, 'error');
            return;
        }
    }
    if (isGroup) {
        if (!state.allowedGroups.includes(chatIdStrNorm)) {
            log(`❌ Группа ${chatId} не разрешена`, 'error');
            return;
        }
    }

    const isAdmin = (adminChatId && userId === adminChatId);
    const isAllowedUser = (username && state.allowedUsernames.includes(username));

    if (isChannel && !message.from) {
        log(`ℹ️ Анонимный пост в канале ${chatId}`, 'info');
    } else {
        if (!isAdmin && !isAllowedUser) {
            log(`❌ Пользователь ${username} не разрешён`, 'error');
            return;
        }
    }

    const isDomainCheckSkipped = (isChannel && state.allowedChannelsNoDomainCheck.includes(chatIdStrNorm)) ||
                                 (isGroup && state.allowedGroupsNoDomainCheck.includes(chatIdStrNorm));
    const urlMatch = text.match(/https?:\/\/[^\s]+/);
    if (!urlMatch) {
        log(`ℹ️ Ссылка не найдена`, 'info');
        return;
    }
    const originalUrl = urlMatch[0];

    if (!isDomainCheckSkipped) {
        try {
            const hostname = new URL(originalUrl).hostname;
            if (!state.allowedDomains.includes(hostname)) {
                log(`❌ Домен ${hostname} не разрешён`, 'error');
                return;
            }
        } catch (e) {
            log(`Ошибка парсинга URL: ${e.message}`, 'error');
            return;
        }
    } else {
        log(`⏩ Проверка домена пропущена`, 'info');
    }

    const isForward = !!(message.forward_from || message.forward_from_chat || message.forward_date);
    const hasOnlyUrl = text.trim() === originalUrl;
    let editMessageId = null;
    if (!isForward && hasOnlyUrl) {
        editMessageId = message.message_id;
    }

    await tgUtils.processUrl(chatId, text, editMessageId, {
        bot,
        tasks,
        adminChatId,
        logMessage: tgUtils.logMessage,
        notifyAdmin: tgUtils.notifyAdmin,
        getShortUrl: yandex.getShortUrl,
        scheduleSelfPing: tgUtils.scheduleSelfPing,
        renderUrl: RENDER_URL,
        diagnosticMode: state.DIAGNOSTIC_MODE
    });
});

// ===== /process =====
app.get('/process', async (req, res) => {
    res.sendStatus(200);

    const { shortUrl, originalUrl, chatId, messageId, attempt, phase } = req.query;
    if (!shortUrl || !chatId || !messageId || !originalUrl) {
        log('Недостаточно параметров в /process', 'error');
        return;
    }

    const attemptNum = parseInt(attempt) || 0;
    const currentPhase = phase || 'active';

    try {
        if (adminChatId) {
            bot.sendMessage(adminChatId, `📝 [index.js] Вызов extractTextFromYaRu с originalUrl=${originalUrl}, shortUrl=${shortUrl}`).catch(() => {});
        }

        const content = await yandex.extractTextFromYaRu(
            originalUrl,
            shortUrl,
            state.YANDEX_TOKEN,
            tgUtils.logMessage,
            adminChatId,
            bot,
            state.DIAGNOSTIC_MODE,
            state.COOKIES
        );

        if (content.status === 200 && content.content && content.content.length > 100) {
            const parts = yandex.formatNews(content.title, content.content);
            const keyboard = {
                inline_keyboard: [
                    [{ text: 'Открыть пересказ на 300.ya.ru', url: shortUrl }]
                ]
            };
            await bot.editMessageText(parts[0], {
                chat_id: chatId,
                message_id: parseInt(messageId),
                parse_mode: 'HTML',
                reply_markup: keyboard
            });
            if (parts.length > 1) {
                for (let i = 1; i < parts.length; i++) {
                    await new Promise(resolve => setTimeout(resolve, 500));
                    await bot.sendMessage(chatId, parts[i], {
                        parse_mode: 'HTML',
                        reply_markup: keyboard
                    });
                }
            }
            if (content.origin) {
                log(`🔗 Оригинал (не отправлен): ${content.origin}`, 'info');
            }
            for (const [key, val] of tasks.entries()) {
                if (val.shortUrl === shortUrl && val.chatId === chatId) {
                    tasks.delete(key);
                    break;
                }
            }
            return;
        } else if (content.status === 202) {
            log('Страница ещё не стабилизирована, ожидание...', 'info');
        }
    } catch (e) {
        log(`Ошибка проверки контента: ${e.message}`, 'error');
        if (e.message && e.message.includes('ETELEGRAM')) {
            log(`Текст, вызвавший ошибку (первые 500): ${parts ? parts[0]?.substring(0,500) : 'нет данных'}`, 'error');
        }
    }

    // Если контент не готов, планируем следующую проверку
    let nextAttempt = attemptNum + 1;
    let nextPhase = currentPhase;

    if (currentPhase === 'active') {
        if (nextAttempt > state.MAX_ACTIVE_ATTEMPTS) {
            nextPhase = 'long';
            nextAttempt = 1;
        }
    }

    if (currentPhase === 'long') {
        if (nextAttempt > state.MAX_LONG_ATTEMPTS) {
            await bot.editMessageText('❌ Не удалось получить текст. Попробуйте позже.', {
                chat_id: chatId,
                message_id: parseInt(messageId)
            });
            tgUtils.notifyAdmin(adminChatId, bot, `Задача для ${shortUrl} не завершена после всех попыток`);
            for (const [key, val] of tasks.entries()) {
                if (val.shortUrl === shortUrl && val.chatId === chatId) {
                    tasks.delete(key);
                    break;
                }
            }
            return;
        }
    }

    const interval = (nextPhase === 'active') ? state.ACTIVE_INTERVAL : state.LONG_INTERVAL;

    const params = {
        shortUrl,
        originalUrl,
        chatId,
        messageId,
        attempt: nextAttempt,
        phase: nextPhase
    };
    for (const [key, val] of tasks.entries()) {
        if (val.shortUrl === shortUrl && val.chatId === chatId) {
            tasks.set(key, { ...params, updatedAt: Date.now() });
            break;
        }
    }
    setTimeout(() => {
        tgUtils.scheduleSelfPing(params, RENDER_URL);
    }, interval);
});

// ===== /ping, /status =====
app.get('/ping', (req, res) => res.sendStatus(200));

app.get('/status', (req, res) => {
    res.json({
        version: VERSION,
        uptime: process.uptime(),
        tasksCount: tasks.size,
        activeTasks: Array.from(tasks.keys()),
        adminSet: !!adminChatId,
        diagnosticMode: state.DIAGNOSTIC_MODE
    });
});

// ===== ЗАПУСК =====
function startPingScheduler() {
    const randomInterval = () => {
        const min = state.PING_MIN_INTERVAL;
        const max = state.PING_MAX_INTERVAL;
        return Math.floor(Math.random() * (max - min + 1)) + min;
    };

    function doPing() {
        axios.get(`${RENDER_URL}/ping`).catch(err => {
            console.error('Дежурный пинг не удался:', err.message);
            if (adminChatId) {
                tgUtils.logMessage(adminChatId, bot, `⚠️ Дежурный пинг не удался: ${err.message}`, 'error', state.DIAGNOSTIC_MODE);
            }
        });
        const next = randomInterval();
        setTimeout(doPing, next);
    }
    setTimeout(doPing, 10000);
}

async function setWebhook(url) {
    if (!url) {
        const msg = 'RENDER_URL не определён, вебхук не может быть установлен';
        console.error(msg);
        return false;
    }
    const apiUrl = `https://api.telegram.org/bot${BOT_TOKEN}/setWebhook?url=${encodeURIComponent(url)}`;
    try {
        const response = await axios.get(apiUrl);
        if (response.data && response.data.ok) {
            console.log(`Вебхук установлен на ${url}`);
            if (adminChatId) {
                tgUtils.logMessage(adminChatId, bot, `✅ Вебхук установлен на ${url}`, 'info', state.DIAGNOSTIC_MODE);
            }
            return true;
        } else {
            const msg = `Ошибка установки вебхука: ${response.data.description || 'неизвестная ошибка'}`;
            console.error(msg);
            if (adminChatId) {
                tgUtils.logMessage(adminChatId, bot, `⚠️ ${msg}`, 'error', state.DIAGNOSTIC_MODE);
            }
            return false;
        }
    } catch (e) {
        const msg = `Ошибка при запросе к Telegram API: ${e.message}`;
        console.error(msg);
        if (adminChatId) {
            tgUtils.logMessage(adminChatId, bot, `⚠️ ${msg}`, 'error', state.DIAGNOSTIC_MODE);
        }
        return false;
    }
}

app.listen(PORT, async () => {
    console.log(`Бот запущен, версия ${VERSION}, порт ${PORT}`);
    const webhookUrl = `${RENDER_URL}/webhook`;
    await setWebhook(webhookUrl);
    startPingScheduler();
    console.log(`Диагностический режим: ${state.DIAGNOSTIC_MODE ? 'ВКЛЮЧЁН' : 'ВЫКЛЮЧЕН'}`);
    console.log('Бот готов к работе.');
});
