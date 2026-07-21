// index.js — полная финальная версия
const express = require('express');
const axios = require('axios');
const TelegramBot = require('node-telegram-bot-api');
const cheerio = require('cheerio');

// ===== РАЗРЕШЁННЫЕ ДОМЕНЫ, ПОЛЬЗОВАТЕЛИ (username), КАНАЛЫ И ГРУППЫ (ID) =====
const allowedDomains = ['nplus1.ru', 'naked-science.ru', '300.ya.ru'];
const allowedUsernames = []; // пока пусто — только админ имеет доступ
const allowedChannels = ['-1001390761594', '-1002753237331', '-1002872429524', '-1002507851276'];   // замените на реальные ID каналов
const allowedGroups = [];     // замените на реальные ID групп

// Списки исключений для проверки домена (в этих каналах/группах домен не проверяем даже при наличии текста)
const allowedChannelsNoDomainCheck = ['-1001390761594']; // замените
const allowedGroupsNoDomainCheck = [''];   // замените

// ===== ФЛАГ ЛОГИРОВАНИЯ ССЫЛОК =====
const LOG_URLS = true;   // true – выводить ссылки в лог, false – не выводить

// ===== ВЕРСИЯ =====
const VERSION = '1.0.2';

// ===== КОНФИГУРАЦИЯ (переменные окружения) =====
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_USERNAME_MASK = process.env.ADMIN_USERNAME_MASK || 'd*n';
const YANDEX_TOKEN = process.env.YANDEX_TOKEN;
const RENDER_URL = process.env.RENDER_EXTERNAL_URL || process.env.RENDER_URL;
const PORT = process.env.PORT || 3000;

// Параметры проверки готовности контента
const ACTIVE_INTERVAL = 3000;
const MAX_ACTIVE_ATTEMPTS = 100;
const LONG_INTERVAL = 60000;
const MAX_LONG_ATTEMPTS = 20;

// Параметры дежурного пинга
const PING_MIN_INTERVAL = 10 * 60 * 1000;
const PING_MAX_INTERVAL = 13 * 60 * 1000;

// ===== ИНИЦИАЛИЗАЦИЯ =====
const app = express();
app.use(express.json());

const bot = new TelegramBot(BOT_TOKEN);
const tasks = new Map();
let adminChatId = null;

// ===== ЛОГИРОВАНИЕ В КОНСОЛЬ И В ЛИЧКУ АДМИНА =====
function logToAdmin(message) {
    console.log(message);
    if (adminChatId) {
        bot.sendMessage(adminChatId, `📝 ${message}`).catch(() => {});
    }
}

// ===== ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ =====

function isUsernameMatchMask(username) {
    if (!username || !ADMIN_USERNAME_MASK) return false;
    const first = ADMIN_USERNAME_MASK[0];
    const last = ADMIN_USERNAME_MASK[ADMIN_USERNAME_MASK.length - 1];
    return username[0] === first && username[username.length - 1] === last;
}

async function notifyAdmin(message) {
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

// ===== ФУНКЦИИ ДЛЯ РАБОТЫ С 300.YA.RU =====

async function getShortUrl(articleUrl) {
    if (articleUrl.includes('300.ya.ru')) {
        return { status: 'success', sharing_url: articleUrl };
    }
    try {
        const response = await axios.post(
            'https://300.ya.ru/api/sharing-url',
            { article_url: articleUrl },
            {
                headers: {
                    'Authorization': YANDEX_TOKEN,
                    'Content-Type': 'application/json'
                },
                timeout: 10000
            }
        );
        return { status: 'success', sharing_url: response.data.sharing_url };
    } catch (e) {
        return { status: 'error', message: e.message };
    }
}

async function extractTextFromYaRu(url) {
    try {
        const response = await axios.get(url, {
            headers: { 'User-Agent': 'Mozilla/5.0' },
            timeout: 15000,
            responseType: 'text'
        });
        const $ = cheerio.load(response.data);
        const originLink = $('a').filter((i, el) => $(el).text().includes('Перейти на оригинал')).attr('href') || '';
        const fullText = $('body').text();
        const { title, content } = parseContent(fullText);
        return { status: 200, title, content, origin: originLink };
    } catch (e) {
        return { status: 500, title: 'Error', content: e.message, origin: '' };
    }
}

function parseContent(fullText) {
    const isYandexGptSummary = /YandexGPT\s+краткий пересказ статьи от нейросети/im.test(fullText);
    const startMarker = /Пересказ сделан (.{0,50}?)Обновить/s;
    const startMatch = fullText.match(startMarker);
    const endMarker = /Для улучшения качества предложите свой вариант/im;
    const endMatch = fullText.match(endMarker);
    const dividerMarker = isYandexGptSummary 
        ? /Кратко\s+Подробно/im 
        : /\d{2}:\d{2}:\d{2}/;
    const dividerMatch = fullText.match(dividerMarker);

    let contentText = fullText;
    let titleText = '';

    if (startMatch && dividerMatch && endMatch) {
        const startPos = startMatch.index + startMatch[0].length;
        const dividerPos = dividerMatch.index;
        const endPos = endMatch.index;
        const title = fullText.slice(startPos, dividerPos).trim();
        contentText = fullText.slice(dividerPos + dividerMatch[0].length, endPos).trim();
        titleText = title || '';
        if (!isYandexGptSummary) {
            contentText = contentText.replace(/\d{2}:\d{2}:\d{2}/g, '');
        }
    }

    const cleanText = contentText
        .replace(/\s{2,}/g, '\n')
        .replace(/(\n)(?![•\s])/g, '\n\n')
        .replace(/\n{3,}/g, '\n\n')
        .replace(/Для улучшения качества[\s\S]*$/im, '')
        .trim();

    return { title: titleText, content: cleanText };
}

function formatNews(title, content) {
    const BUTTON_TEXT = 'Открыть пересказ на 300.ya.ru';
    const BUTTON_URL_LENGTH = 30;
    const BUTTON_TOTAL_LENGTH = BUTTON_TEXT.length + BUTTON_URL_LENGTH + 10;
    const MAX_MESSAGE_LENGTH = 4096 - BUTTON_TOTAL_LENGTH - 30;

    const fullTitle = title ? `${title}\nПересказ YandexGPT на 300.ya.ru` : 'Пересказ YandexGPT на 300.ya.ru';
    const formattedTitle = title ? `<b>${title}</b>` : '';
    const fullText = formattedTitle + (content ? `\n<blockquote>\n<b>Пересказ YandexGPT на 300.ya.ru</b>\n\n${content}</blockquote>` : '');

    if (fullText.length <= MAX_MESSAGE_LENGTH) {
        return [fullText];
    }

    const blocks = fullText.split(/\n(?![•.])/g);
    const messageParts = [];
    let currentPart = '';

    for (let i = 0; i < blocks.length; i++) {
        const block = blocks[i];
        const isLastBlock = i === blocks.length - 1;
        const blockWithClosingTag = block + (!isLastBlock ? '</blockquote>' : '');

        if (currentPart.length + blockWithClosingTag.length <= MAX_MESSAGE_LENGTH) {
            currentPart += `\n` + block;
        } else {
            if (currentPart.trim()) {
                if (!isLastBlock) {
                    currentPart += '</blockquote>';
                }
                messageParts.push(currentPart);
            }
            if (!isLastBlock) {
                currentPart = '<blockquote>' + block;
            } else {
                currentPart = block;
            }
        }
    }
    if (currentPart.trim()) {
        messageParts.push(currentPart);
    }
    return messageParts;
}

function scheduleSelfPing(params) {
    const url = `${RENDER_URL}/process?` + new URLSearchParams(params).toString();
    setTimeout(() => {
        axios.get(url).catch(err => console.error('Self-ping failed:', err.message));
    }, 1000);
}

// ===== ЭНДПОИНТЫ =====

app.post('/webhook', async (req, res) => {
    res.sendStatus(200);

    // === УНИВЕРСАЛЬНАЯ ОБРАБОТКА: message И channel_post ===
    const update = req.body;
    const message = update.message || update.channel_post;
    if (!message || !message.text) {
        // Если это не сообщение и не пост в канале — игнорируем
        return;
    }

    const chatId = message.chat.id;
    const chatType = message.chat.type;
    const text = message.text;
    const username = message.from?.username || 'без username';
    const userId = message.from?.id;

    // === ДИАГНОСТИКА ВСЕХ ВХОДЯЩИХ ВЕБХУКОВ ===
    logToAdmin(`📥 Вебхук: chatId=${chatId}, type=${chatType}, user=${username}, text=${text.substring(0, 80)}${text.length > 80 ? '...' : ''}`);

    // Назначение администратора (только в личке)
    if (!adminChatId && chatType === 'private') {
        if (username && isUsernameMatchMask(username)) {
            adminChatId = chatId;
            console.log(`Администратор назначен (chat_id: ${adminChatId})`);
            await bot.sendMessage(adminChatId, '✅ Вы назначились администратором бота.');
        } else {
            if (username) {
                await bot.sendMessage(chatId, '❌ Ваш username не подходит для роли администратора.');
            }
            return;
        }
    }

    // === ПРОВЕРКА РАЗРЕШЁННЫХ КАНАЛОВ/ГРУПП И АВТОРА ===
    const isChannel = chatType === 'channel';
    const isGroup = chatType === 'group' || chatType === 'supergroup';
    const isPrivate = chatType === 'private';

    if (isChannel) {
        if (!allowedChannels.includes(chatId.toString())) {
            logToAdmin(`❌ Канал ${chatId} не в списке разрешённых (allowedChannels: ${JSON.stringify(allowedChannels)})`);
            return;
        } else {
            logToAdmin(`✅ Канал ${chatId} разрешён`);
        }
    }
    if (isGroup) {
        if (!allowedGroups.includes(chatId.toString())) {
            logToAdmin(`❌ Группа ${chatId} не в списке разрешённых (allowedGroups: ${JSON.stringify(allowedGroups)})`);
            return;
        } else {
            logToAdmin(`✅ Группа ${chatId} разрешена`);
        }
    }

    const isAdmin = (adminChatId && userId === adminChatId);
    const isAllowedUser = (username && allowedUsernames.includes(username));

    // Для каналов: анонимные посты пропускаем, иначе проверяем автора
    if (isChannel && !message.from) {
        logToAdmin(`ℹ️ Анонимный пост в канале ${chatId}, обрабатываем`);
    } else {
        if (!isAdmin && !isAllowedUser) {
            logToAdmin(`❌ Пользователь ${username} (ID: ${userId}) не разрешён (allowedUsernames: ${JSON.stringify(allowedUsernames)})`);
            return;
        } else {
            logToAdmin(`✅ Пользователь ${username} разрешён`);
        }
    }

    // === ОБРАБОТКА ССЫЛОК ===
    const urlMatch = text.match(/https?:\/\/[^\s]+/);
    if (!urlMatch) {
        logToAdmin(`ℹ️ Ссылка не найдена в тексте`);
        return;
    }

    const originalUrl = urlMatch[0];
    logToAdmin(`🔗 Исходный URL: ${originalUrl}`);

    try {
        const hostname = new URL(originalUrl).hostname;
        if (!allowedDomains.includes(hostname)) {
            logToAdmin(`❌ Домен ${hostname} не разрешён (allowedDomains: ${JSON.stringify(allowedDomains)})`);
            return;
        } else {
            logToAdmin(`✅ Домен ${hostname} разрешён`);
        }
    } catch (e) {
        console.error('Ошибка парсинга URL:', e);
        return;
    }

    try {
        const shortResult = await getShortUrl(originalUrl);
        if (shortResult.status === 'error') {
            await bot.sendMessage(chatId, '❌ Не удалось получить ссылку на пересказ.');
            await notifyAdmin(`Ошибка получения shortUrl: ${originalUrl} - ${shortResult.message}`);
            return;
        }
        const shortUrl = shortResult.sharing_url;

        // Отправляем первое сообщение (будет отредактировано позже)
        const sentMsg = await bot.sendMessage(chatId, `✅ Ссылка на пересказ: ${shortUrl}\nТекст готовится, ожидайте...`);

        // Создаём задачу с сохранением message_id
        const taskId = `task_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
        const params = {
            shortUrl,
            chatId,
            messageId: sentMsg.message_id,
            attempt: 1,
            phase: 'active'
        };
        tasks.set(taskId, { ...params, createdAt: Date.now() });

        scheduleSelfPing(params);
        logToAdmin(`✅ Задача создана: ${taskId}`);
    } catch (e) {
        console.error('Ошибка в вебхуке:', e);
        await bot.sendMessage(chatId, 'Произошла ошибка при обработке ссылки.');
        await notifyAdmin(`Ошибка в вебхуке: ${e.message}`);
    }
});

app.get('/process', async (req, res) => {
    res.sendStatus(200);

    const { shortUrl, chatId, messageId, attempt, phase } = req.query;
    if (!shortUrl || !chatId || !messageId) {
        console.warn('Недостаточно параметров в /process');
        return;
    }

    const attemptNum = parseInt(attempt) || 0;
    const currentPhase = phase || 'active';

    try {
        const content = await extractTextFromYaRu(shortUrl);
        if (content.status === 200 && content.content && content.content.length > 100) {
            // Контент готов — редактируем первое сообщение
            const parts = formatNews(content.title, content.content);
            const keyboard = {
                inline_keyboard: [
                    [{ text: 'Открыть пересказ на 300.ya.ru', url: shortUrl }]
                ]
            };
            // Редактируем первое сообщение первой частью
            await bot.editMessageText(parts[0], {
                chat_id: chatId,
                message_id: parseInt(messageId),
                parse_mode: 'HTML',
                reply_markup: keyboard
            });
            // Отправляем дополнительные части
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
                await bot.sendMessage(chatId, `🔗 Оригинал: ${content.origin}`);
            }
            // Удаляем задачу
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

    // Контент не готов — планируем следующую проверку
    let nextAttempt = attemptNum + 1;
    let nextPhase = currentPhase;

    if (currentPhase === 'active') {
        if (nextAttempt > MAX_ACTIVE_ATTEMPTS) {
            nextPhase = 'long';
            nextAttempt = 1;
        }
    }

    if (currentPhase === 'long') {
        if (nextAttempt > MAX_LONG_ATTEMPTS) {
            // Превышены все попытки — ошибка
            await bot.editMessageText('❌ Не удалось получить текст. Попробуйте позже.', {
                chat_id: chatId,
                message_id: parseInt(messageId)
            });
            await notifyAdmin(`Задача для ${shortUrl} не завершена после всех попыток`);
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

    // Сохраняем обновлённые параметры в Map
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
        scheduleSelfPing(params);
    }, interval);
});

app.get('/ping', (req, res) => {
    res.sendStatus(200);
});

app.get('/status', (req, res) => {
    res.json({
        version: VERSION,
        uptime: process.uptime(),
        tasksCount: tasks.size,
        activeTasks: Array.from(tasks.keys()),
        adminSet: !!adminChatId
    });
});

// ===== ЗАПУСК СЕРВЕРА И УСТАНОВКА ВЕБХУКА =====

function startPingScheduler() {
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
    console.log(`Бот запущен, версия ${VERSION}, порт ${PORT}`);
    const webhookUrl = `${RENDER_URL}/webhook`;
    await setWebhook(webhookUrl);
    startPingScheduler();
    console.log(`Ожидание первого сообщения от пользователя с маской "${ADMIN_USERNAME_MASK}"`);
});
