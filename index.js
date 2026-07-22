// index.js — версия 1.1.3
// Точка входа: инициализация Express, вебхук, эндпоинты /process, /ping, /status, запуск.
// Логирование: до назначения админа — консоль, после — только в личку (если DIAGNOSTIC_MODE=true),
// критические ошибки — всегда.
// Передаём log как logFn во все вызовы loadConfigFromPinned.

const express = require('express');
const axios = require('axios');
const TelegramBot = require('node-telegram-bot-api');

// Подключаем модули
const config = require('./config');
const yandex = require('./yandex-utils');
const tgUtils = require('./telegram-utils');

// ===== КОНФИГУРАЦИЯ (неизменяемые переменные окружения) =====
const BOT_TOKEN = process.env.BOT_TOKEN;
const RENDER_URL = process.env.RENDER_EXTERNAL_URL || process.env.RENDER_URL;
const PORT = process.env.PORT || 3000;

// ===== ИНИЦИАЛИЗАЦИЯ =====
const app = express();
app.use(express.json());

const bot = new TelegramBot(BOT_TOKEN);
const tasks = new Map();
let adminChatId = null;
const greetedUsers = new Map();

// Устанавливаем YANDEX_TOKEN в yandex-utils (для случаев, когда он не передан в функции)
yandex.setYandexToken(config.YANDEX_TOKEN);

// ===== ФУНКЦИЯ ЛОГИРОВАНИЯ (обёртка для удобства) =====
function log(message, level = 'info') {
    tgUtils.logMessage(adminChatId, bot, message, level, config.DIAGNOSTIC_MODE);
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
    const chatIdStr = config.normalizeId(chatId);

    log(`📥 Вебхук: chatId=${chatId} (норм: ${chatIdStr}), type=${chatType}, user=${username}`, 'info');

    // === ОБРАБОТКА ЛИЧНЫХ СООБЩЕНИЙ ===
    if (chatType === 'private') {
        // Если администратор уже назначен
        if (chatId === adminChatId) {
            // Проверяем наличие маркера [[[ (команда конфига)
            if (text.includes('[[')) {
                const arr = config.extractConfig(text, log, adminChatId, bot, config.DIAGNOSTIC_MODE);
                if (arr) {
                    try {
                        config.applyConfig(arr);
                        // Обновляем YANDEX_TOKEN в yandex-utils
                        yandex.setYandexToken(config.YANDEX_TOKEN);
                        await bot.sendMessage(adminChatId, '✅ Конфиг обновлён.');
                    } catch (e) {
                        await bot.sendMessage(adminChatId, `❌ Ошибка применения конфига: ${e.message}`);
                    }
                } else {
                    await bot.sendMessage(adminChatId, '❌ Не удалось извлечь конфиг. Убедитесь, что он обёрнут в [[[ ... ]]] и содержит валидный JSON-массив из 14 элементов.');
                }
                return;
            }

            // Команда удаления закреплённого сообщения (если оно от бота)
if (text.startsWith('/unpin')) {
    try {
        const chat = await bot.getChat(adminChatId);
        const pinned = chat.pinned_message;
        if (!pinned) {
            await bot.sendMessage(adminChatId, 'ℹ️ Закреплённое сообщение не найдено.');
            return;
        }
        // Удаляем сообщение (бот должен быть его автором)
        await bot.deleteMessage(adminChatId, pinned.message_id);
        await bot.sendMessage(adminChatId, '✅ Закреплённое сообщение удалено.');
    } catch (e) {
        await bot.sendMessage(adminChatId, `❌ Ошибка: ${e.message}`);
    }
    return;
}
            
            // Команда перезагрузки конфига из закреплённого сообщения
            if (text.startsWith('/reload')) {
                const loaded = await config.loadConfigFromPinned(adminChatId, bot, log, config.DIAGNOSTIC_MODE);
                if (loaded) {
                    yandex.setYandexToken(config.YANDEX_TOKEN);
                    await bot.sendMessage(adminChatId, '✅ Конфиг перезагружен из закреплённого сообщения.');
                } else {
                    await bot.sendMessage(adminChatId, '❌ Не удалось загрузить конфиг. Убедитесь, что закреплённое сообщение содержит маркер [[[ ... ]]] и валидный массив.');
                }
                return;
            }

            // Если это не команда и не конфиг — обрабатываем как ссылку (домен не проверяем)
            await tgUtils.processUrl(chatId, text, null, {
                bot,
                tasks,
                adminChatId,
                logMessage: tgUtils.logMessage,
                notifyAdmin: tgUtils.notifyAdmin,
                getShortUrl: yandex.getShortUrl,
                scheduleSelfPing: tgUtils.scheduleSelfPing,
                renderUrl: RENDER_URL,
                diagnosticMode: config.DIAGNOSTIC_MODE
            });
            return;
        }

        // Если администратор ещё не назначен
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
                    // Админ назначен — теперь логи будут управляться диагностикой
                    log(`Администратор назначен`, 'info');
                    let greeting = '✅ Вы назначились администратором бота.';
                    const configLoaded = await config.loadConfigFromPinned(adminChatId, bot, log, config.DIAGNOSTIC_MODE);
                    if (configLoaded) {
                        yandex.setYandexToken(config.YANDEX_TOKEN);
                        greeting += '\nКонфиг загружен из закреплённого сообщения.';
                    } else {
                        greeting += '\nКонфиг не найден, используются значения по умолчанию.';
                    }
                    await bot.sendMessage(adminChatId, greeting);
                    return;
                } else {
                    await bot.sendMessage(chatId, '❌ Маска не подходит для вашего username. Попробуйте ещё раз.');
                    return;
                }
            } else {
                greetedUsers.set(chatId, true);
                await bot.sendMessage(chatId, 'Здравствуйте! Отправьте маску вида `б*б` (например, d*n) для проверки.', { parse_mode: 'Markdown' });
                return;
            }
        }
    }

    // === ДАЛЕЕ ОБРАБОТКА КАНАЛОВ И ГРУПП ===
    const isChannel = chatType === 'channel';
    const isGroup = chatType === 'group' || chatType === 'supergroup';

    if (isChannel) {
        if (!config.allowedChannels.includes(chatIdStr)) {
            log(`❌ Канал ${chatId} (норм: ${chatIdStr}) не в списке разрешённых`, 'error');
            return;
        }
    }
    if (isGroup) {
        if (!config.allowedGroups.includes(chatIdStr)) {
            log(`❌ Группа ${chatId} (норм: ${chatIdStr}) не в списке разрешённых`, 'error');
            return;
        }
    }

    const isAdmin = (adminChatId && userId === adminChatId);
    const isAllowedUser = (username && config.allowedUsernames.includes(username));

    if (isChannel && !message.from) {
        log(`ℹ️ Анонимный пост в канале ${chatId}, обрабатываем`, 'info');
    } else {
        if (!isAdmin && !isAllowedUser) {
            log(`❌ Пользователь ${username} не разрешён`, 'error');
            return;
        }
    }

    // === ПРОВЕРКА ДОМЕНА (если чат не в списке исключений) ===
    const isDomainCheckSkipped = (isChannel && config.allowedChannelsNoDomainCheck.includes(chatIdStr)) ||
                                 (isGroup && config.allowedGroupsNoDomainCheck.includes(chatIdStr));

    const urlMatch = text.match(/https?:\/\/[^\s]+/);
    if (!urlMatch) {
        log(`ℹ️ Ссылка не найдена в тексте`, 'info');
        return;
    }
    const originalUrl = urlMatch[0];

    if (!isDomainCheckSkipped) {
        try {
            const hostname = new URL(originalUrl).hostname;
            if (!config.allowedDomains.includes(hostname)) {
                log(`❌ Домен ${hostname} не разрешён`, 'error');
                return;
            }
        } catch (e) {
            log(`Ошибка парсинга URL: ${e.message}`, 'error');
            return;
        }
    } else {
        log(`⏩ Проверка домена пропущена (чат в списке исключений)`, 'info');
    }

    // Определяем, можно ли редактировать сообщение
    const isForward = !!(message.forward_from || message.forward_from_chat || message.forward_date);
    const hasOnlyUrl = text.trim() === originalUrl;
    let editMessageId = null;
    if (!isForward && hasOnlyUrl) {
        editMessageId = message.message_id;
    }

    // Вызываем обработку ссылки
    await tgUtils.processUrl(chatId, text, editMessageId, {
        bot,
        tasks,
        adminChatId,
        logMessage: tgUtils.logMessage,
        notifyAdmin: tgUtils.notifyAdmin,
        getShortUrl: yandex.getShortUrl,
        scheduleSelfPing: tgUtils.scheduleSelfPing,
        renderUrl: RENDER_URL,
        diagnosticMode: config.DIAGNOSTIC_MODE
    });
});

// ===== ЭНДПОИНТ /process =====
app.get('/process', async (req, res) => {
    res.sendStatus(200);

    const { shortUrl, chatId, messageId, attempt, phase } = req.query;
    if (!shortUrl || !chatId || !messageId) {
        log('Недостаточно параметров в /process', 'error');
        return;
    }

    const attemptNum = parseInt(attempt) || 0;
    const currentPhase = phase || 'active';

    try {
        const content = await yandex.extractTextFromYaRu(
            shortUrl,
            config.YANDEX_TOKEN,
            tgUtils.logMessage,
            adminChatId,
            bot,
            config.DIAGNOSTIC_MODE
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
                log(`🔗 Оригинал (не отправлен пользователю): ${content.origin}`, 'info');
            }
            for (const [key, val] of tasks.entries()) {
                if (val.shortUrl === shortUrl && val.chatId === chatId) {
                    tasks.delete(key);
                    break;
                }
            }
            return;
        }
    } catch (e) {
        log(`Ошибка при проверке контента: ${e.message}`, 'error');
    }

    // Если контент не готов, планируем следующую проверку
    let nextAttempt = attemptNum + 1;
    let nextPhase = currentPhase;

    if (currentPhase === 'active') {
        if (nextAttempt > config.MAX_ACTIVE_ATTEMPTS) {
            nextPhase = 'long';
            nextAttempt = 1;
        }
    }

    if (currentPhase === 'long') {
        if (nextAttempt > config.MAX_LONG_ATTEMPTS) {
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

    const interval = (nextPhase === 'active') ? config.ACTIVE_INTERVAL : config.LONG_INTERVAL;

    const params = {
        shortUrl,
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

// ===== ЭНДПОИНТ /ping =====
app.get('/ping', (req, res) => {
    res.sendStatus(200);
});

// ===== ЭНДПОИНТ /status =====
app.get('/status', (req, res) => {
    res.json({
        version: '1.1.3',
        uptime: process.uptime(),
        tasksCount: tasks.size,
        activeTasks: Array.from(tasks.keys()),
        adminSet: !!adminChatId,
        diagnosticMode: config.DIAGNOSTIC_MODE
    });
});

// ===== ЗАПУСК =====
function startPingScheduler() {
    const randomInterval = () => {
        const min = config.PING_MIN_INTERVAL;
        const max = config.PING_MAX_INTERVAL;
        return Math.floor(Math.random() * (max - min + 1)) + min;
    };

    function doPing() {
        axios.get(`${RENDER_URL}/ping`)
            .catch(err => {
                // Критическая ошибка — выводим в консоль и, если админ есть, отправляем через logMessage
                console.error('Дежурный пинг не удался:', err.message);
                if (adminChatId) {
                    tgUtils.logMessage(adminChatId, bot, `⚠️ Дежурный пинг не удался: ${err.message}`, 'error', config.DIAGNOSTIC_MODE);
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
        if (adminChatId) {
            tgUtils.logMessage(adminChatId, bot, `⚠️ ${msg}`, 'error', config.DIAGNOSTIC_MODE);
        }
        return false;
    }
    const apiUrl = `https://api.telegram.org/bot${BOT_TOKEN}/setWebhook?url=${encodeURIComponent(url)}`;
    try {
        const response = await axios.get(apiUrl);
        if (response.data && response.data.ok) {
            console.log(`Вебхук установлен на ${url}`);
            if (adminChatId) {
                tgUtils.logMessage(adminChatId, bot, `✅ Вебхук установлен на ${url}`, 'info', config.DIAGNOSTIC_MODE);
            }
            return true;
        } else {
            const msg = `Ошибка установки вебхука: ${response.data.description || 'неизвестная ошибка'}`;
            console.error(msg);
            if (adminChatId) {
                tgUtils.logMessage(adminChatId, bot, `⚠️ ${msg}`, 'error', config.DIAGNOSTIC_MODE);
            }
            return false;
        }
    } catch (e) {
        const msg = `Ошибка при запросе к Telegram API: ${e.message}`;
        console.error(msg);
        if (adminChatId) {
            tgUtils.logMessage(adminChatId, bot, `⚠️ ${msg}`, 'error', config.DIAGNOSTIC_MODE);
        }
        return false;
    }
}

app.listen(PORT, async () => {
    console.log(`Бот запущен, версия 1.1.3, порт ${PORT}`);
    const webhookUrl = `${RENDER_URL}/webhook`;
    await setWebhook(webhookUrl);
    startPingScheduler();
    console.log(`Диагностический режим: ${config.DIAGNOSTIC_MODE ? 'ВКЛЮЧЁН' : 'ВЫКЛЮЧЕН'}`);
    console.log('Бот готов к работе. Напишите в личку "Здравствуйте!" для начала.');
});
