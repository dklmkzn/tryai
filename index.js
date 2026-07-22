// index.js — версия 1.1.1
// Точка входа: инициализация Express, вебхук, эндпоинты /process, /ping, /status, запуск.

const express = require('express');
const axios = require('axios');
const TelegramBot = require('node-telegram-bot-api');

// Подключаем модули с логикой
const config = require('./config');          // переменные, applyConfig, extractConfig, loadConfigFromPinned
const yandex = require('./yandex-utils');    // getShortUrl, extractTextFromYaRu, parseContent, formatNews
const tgUtils = require('./telegram-utils'); // processUrl, scheduleSelfPing, logToAdmin, notifyAdmin, isUsernameMatchMask, normalizeId

// ===== КОНФИГУРАЦИЯ (неизменяемые переменные окружения) =====
const BOT_TOKEN = process.env.BOT_TOKEN;
const RENDER_URL = process.env.RENDER_EXTERNAL_URL || process.env.RENDER_URL;
const PORT = process.env.PORT || 3000;

// ===== ИНИЦИАЛИЗАЦИЯ =====
const app = express();
app.use(express.json());

const bot = new TelegramBot(BOT_TOKEN);
const tasks = new Map(); // хранилище задач (self-ping)

// Передаём зависимые объекты в модули (для доступа к bot, tasks, adminChatId и т.д.)
// В нашем случае модули будут использовать глобальные переменные из этого файла,
// но чтобы избежать цикличных зависимостей, мы передадим их через параметры или оставим в общем доступе.
// В упрощённом варианте можно объявить их здесь и обращаться через require, но проще экспортировать функции, принимающие bot, tasks и т.п.

// Однако для простоты я покажу вариант с общими глобальными переменными (adminChatId, tasks, bot).
// Модули будут обращаться к ним через замыкание, если мы их экспортируем как функции, принимающие эти зависимости.
// В данном файле мы инициализируем всё и передаём в функции.

// ===== ГЛОБАЛЬНЫЕ ПЕРЕМЕННЫЕ (используются в модулях) =====
let adminChatId = null;
const greetedUsers = new Map();

// ===== ПОДКЛЮЧЕНИЕ ФУНКЦИЙ ИЗ МОДУЛЕЙ =====
// Чтобы не переопределять функции, мы будем использовать экспортированные функции, передавая им зависимости.
// Вместо этого я просто скопирую сюда обновлённые функции из предыдущих ответов, но для чистоты разделения оставлю их в модулях.
// Я перепишу логику так, чтобы модули экспортировали функции, которые используют глобальные переменные из этого файла (через замыкание).
// Для простоты я сделаю так, чтобы в index.js были только эндпоинты и запуск, а все функции будут взяты из модулей.
// Но поскольку мы ещё не создали файлы модулей, я временно вставлю код функций прямо сюда, но с комментариями, что они должны быть вынесены.

// В реальном проекте вы создадите файлы config.js, yandex-utils.js, telegram-utils.js и подключите их.
// Здесь я даю index.js так, как будто модули уже есть.

// Для демонстрации я приведу рабочий index.js, который использует модули (которые мы ещё не написали, но они будут позже).
// Пока я просто покажу структуру.

// ВАЖНО: это пример, но вы можете использовать его как основу.

// ===== ЭНДПОИНТЫ =====

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

    // Логирование (используем функцию из модуля)
    tgUtils.logToAdmin(adminChatId, bot, `📥 Вебхук: chatId=${chatId} (норм: ${chatIdStr}), type=${chatType}, user=${username}`);

    // === ОБРАБОТКА ЛИЧНЫХ СООБЩЕНИЙ ===
    if (chatType === 'private') {
        // Если администратор уже назначен
        if (chatId === adminChatId) {
            // Проверяем наличие маркера [[[ (команда конфига)
            if (text.includes('[[')) {
                const arr = config.extractConfig(text);
                if (arr) {
                    try {
                        config.applyConfig(arr);
                        await bot.sendMessage(adminChatId, '✅ Конфиг обновлён.');
                    } catch (e) {
                        await bot.sendMessage(adminChatId, `❌ Ошибка применения конфига: ${e.message}`);
                    }
                } else {
                    await bot.sendMessage(adminChatId, '❌ Не удалось извлечь конфиг. Убедитесь, что он обёрнут в [[[ ... ]]] и содержит валидный JSON-массив из 14 элементов.');
                }
                return;
            }

            // Команда перезагрузки конфига из закреплённого сообщения
            if (text.startsWith('/reload')) {
                const loaded = await config.loadConfigFromPinned(adminChatId, bot);
                if (loaded) {
                    await bot.sendMessage(adminChatId, '✅ Конфиг перезагружен из закреплённого сообщения.');
                } else {
                    await bot.sendMessage(adminChatId, '❌ Не удалось загрузить конфиг. Убедитесь, что закреплённое сообщение содержит маркер [[[ ... ]]] и валидный массив.');
                }
                return;
            }

            // Если это не команда и не конфиг — обрабатываем как ссылку (домен не проверяем)
            await tgUtils.processUrl(chatId, text, null, { bot, tasks, adminChatId, logToAdmin: tgUtils.logToAdmin, notifyAdmin: tgUtils.notifyAdmin, getShortUrl: yandex.getShortUrl, scheduleSelfPing: tgUtils.scheduleSelfPing });
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
                    console.log(`Администратор назначен`); // без ID
                    let greeting = '✅ Вы назначились администратором бота.';
                    const configLoaded = await config.loadConfigFromPinned(adminChatId, bot);
                    if (configLoaded) {
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
            tgUtils.logToAdmin(adminChatId, bot, `❌ Канал ${chatId} (норм: ${chatIdStr}) не в списке разрешённых`);
            return;
        }
    }
    if (isGroup) {
        if (!config.allowedGroups.includes(chatIdStr)) {
            tgUtils.logToAdmin(adminChatId, bot, `❌ Группа ${chatId} (норм: ${chatIdStr}) не в списке разрешённых`);
            return;
        }
    }

    const isAdmin = (adminChatId && userId === adminChatId);
    const isAllowedUser = (username && config.allowedUsernames.includes(username));

    if (isChannel && !message.from) {
        tgUtils.logToAdmin(adminChatId, bot, `ℹ️ Анонимный пост в канале ${chatId}, обрабатываем`);
    } else {
        if (!isAdmin && !isAllowedUser) {
            tgUtils.logToAdmin(adminChatId, bot, `❌ Пользователь ${username} не разрешён`);
            return;
        }
    }

    // === ПРОВЕРКА ДОМЕНА (если чат не в списке исключений) ===
    const isDomainCheckSkipped = (isChannel && config.allowedChannelsNoDomainCheck.includes(chatIdStr)) ||
                                 (isGroup && config.allowedGroupsNoDomainCheck.includes(chatIdStr));

    const urlMatch = text.match(/https?:\/\/[^\s]+/);
    if (!urlMatch) {
        tgUtils.logToAdmin(adminChatId, bot, `ℹ️ Ссылка не найдена в тексте`);
        return;
    }
    const originalUrl = urlMatch[0];

    if (!isDomainCheckSkipped) {
        try {
            const hostname = new URL(originalUrl).hostname;
            if (!config.allowedDomains.includes(hostname)) {
                tgUtils.logToAdmin(adminChatId, bot, `❌ Домен ${hostname} не разрешён`);
                return;
            }
        } catch (e) {
            console.error('Ошибка парсинга URL:', e);
            return;
        }
    } else {
        tgUtils.logToAdmin(adminChatId, bot, `⏩ Проверка домена пропущена (чат в списке исключений)`);
    }

    // Определяем, можно ли редактировать сообщение
    const isForward = !!(message.forward_from || message.forward_from_chat || message.forward_date);
    const hasOnlyUrl = text.trim() === originalUrl;
    let editMessageId = null;
    if (!isForward && hasOnlyUrl) {
        editMessageId = message.message_id;
    }

    // Вызываем обработку ссылки
    await tgUtils.processUrl(chatId, text, editMessageId, { bot, tasks, adminChatId, logToAdmin: tgUtils.logToAdmin, notifyAdmin: tgUtils.notifyAdmin, getShortUrl: yandex.getShortUrl, scheduleSelfPing: tgUtils.scheduleSelfPing });
});

// ===== ЭНДПОИНТ /process =====
app.get('/process', async (req, res) => {
    res.sendStatus(200);

    const { shortUrl, chatId, messageId, attempt, phase } = req.query;
    if (!shortUrl || !chatId || !messageId) {
        console.warn('Недостаточно параметров в /process');
        if (adminChatId) {
            bot.sendMessage(adminChatId, '⚠️ Недостаточно параметров в /process').catch(() => {});
        }
        return;
    }

    const attemptNum = parseInt(attempt) || 0;
    const currentPhase = phase || 'active';

    try {
        const content = await yandex.extractTextFromYaRu(shortUrl);
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
                tgUtils.logToAdmin(adminChatId, bot, `🔗 Оригинал (не отправлен пользователю): ${content.origin}`);
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
        console.error('Ошибка при проверке контента:', e);
    }

    // Если контент не готов, планируем следующую проверку
    let nextAttempt = attemptNum + 1;
    let nextPhase = currentPhase;
    const MAX_ACTIVE_ATTEMPTS = config.MAX_ACTIVE_ATTEMPTS;
    const MAX_LONG_ATTEMPTS = config.MAX_LONG_ATTEMPTS;
    const ACTIVE_INTERVAL = config.ACTIVE_INTERVAL;
    const LONG_INTERVAL = config.LONG_INTERVAL;

    if (currentPhase === 'active') {
        if (nextAttempt > MAX_ACTIVE_ATTEMPTS) {
            nextPhase = 'long';
            nextAttempt = 1;
        }
    }

    if (currentPhase === 'long') {
        if (nextAttempt > MAX_LONG_ATTEMPTS) {
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

    const interval = (nextPhase === 'active') ? ACTIVE_INTERVAL : LONG_INTERVAL;

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
        tgUtils.scheduleSelfPing(params, { RENDER_URL });
    }, interval);
});

// ===== ЭНДПОИНТ /ping =====
app.get('/ping', (req, res) => {
    res.sendStatus(200);
});

// ===== ЭНДПОИНТ /status =====
app.get('/status', (req, res) => {
    res.json({
        version: '1.1.1',
        uptime: process.uptime(),
        tasksCount: tasks.size,
        activeTasks: Array.from(tasks.keys()),
        adminSet: !!adminChatId,
        diagnosticMode: config.DIAGNOSTIC_MODE
    });
});

// ===== ЗАПУСК =====
function startPingScheduler() {
    const PING_MIN_INTERVAL = config.PING_MIN_INTERVAL;
    const PING_MAX_INTERVAL = config.PING_MAX_INTERVAL;
    const randomInterval = () => {
        const min = PING_MIN_INTERVAL;
        const max = PING_MAX_INTERVAL;
        return Math.floor(Math.random() * (max - min + 1)) + min;
    };

    function doPing() {
        axios.get(`${RENDER_URL}/ping`)
            .catch(err => console.error('Дежурный пинг не удался:', err.message));
        const next = randomInterval();
        setTimeout(doPing, next);
    }

    setTimeout(doPing, 10000);
}

async function setWebhook(url) {
    if (!url) {
        console.error('RENDER_URL не определён, вебхук не может быть установлен');
        return false;
    }
    const apiUrl = `https://api.telegram.org/bot${BOT_TOKEN}/setWebhook?url=${encodeURIComponent(url)}`;
    try {
        const response = await axios.get(apiUrl);
        if (response.data && response.data.ok) {
            console.log(`Вебхук установлен на ${url}`);
            return true;
        } else {
            console.error('Ошибка установки вебхука:', response.data.description || 'неизвестная ошибка');
            return false;
        }
    } catch (e) {
        console.error('Ошибка при запросе к Telegram API:', e.message);
        return false;
    }
}

app.listen(PORT, async () => {
    console.log(`Бот запущен, версия 1.1.1, порт ${PORT}`);
    const webhookUrl = `${RENDER_URL}/webhook`;
    await setWebhook(webhookUrl);
    startPingScheduler();
    console.log(`Диагностический режим: ${config.DIAGNOSTIC_MODE ? 'ВКЛЮЧЁН' : 'ВЫКЛЮЧЕН'}`);
    console.log('Бот готов к работе. Напишите в личку "Здравствуйте!" для начала.');
});
