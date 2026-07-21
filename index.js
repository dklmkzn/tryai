// index.js — финальная версия
const express = require('express');
const axios = require('axios');
const TelegramBot = require('node-telegram-bot-api');
const cheerio = require('cheerio');

// ===== КОНФИГУРАЦИЯ =====
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_USERNAME_MASK = process.env.ADMIN_USERNAME_MASK || 'd*n';
const YANDEX_TOKEN = process.env.YANDEX_TOKEN;
const RENDER_URL = process.env.RENDER_EXTERNAL_URL || process.env.RENDER_URL;
const PORT = process.env.PORT || 3000;

const ACTIVE_INTERVAL = 3000;
const MAX_ACTIVE_ATTEMPTS = 100;
const LONG_INTERVAL = 60000;
const MAX_LONG_ATTEMPTS = 20;

const PING_MIN_INTERVAL = 10 * 60 * 1000;
const PING_MAX_INTERVAL = 13 * 60 * 1000;

// ===== РАЗРЕШЁННЫЕ ДОМЕНЫ, ПОЛЬЗОВАТЕЛИ (username), КАНАЛЫ И ГРУППЫ (ID) =====
const allowedDomains = ['nplus1.ru', 'naked-science.ru', '300.ya.ru'];
const allowedUsernames = []; // пока пусто — только админ имеет доступ
const allowedChannels = ['-1001390761594', '-1002753237331', '-1002872429524', '-1002507851276'];   // замените на реальные ID каналов
const allowedGroups = [];     // замените на реальные ID групп

// ===== ИНИЦИАЛИЗАЦИЯ =====
const app = express();
app.use(express.json());

const bot = new TelegramBot(BOT_TOKEN);

const tasks = new Map();
let adminChatId = null;

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

// ===== ФУНКЦИИ ДЛЯ 300.YA.RU =====

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

async function sendContentToUser(chatId, content, shortUrl) {
    const parts = formatNews(content.title, content.content);
    const reply_markup = {
        inline_keyboard: [
            [{ text: 'Открыть пересказ на 300.ya.ru', url: shortUrl }]
        ]
    };
    for (const part of parts) {
        await bot.sendMessage(chatId, part, { parse_mode: 'HTML', reply_markup });
    }
}

// ===== SELF-PING =====
function scheduleSelfPing(params) {
    const url = `${RENDER_URL}/process?` + new URLSearchParams(params).toString();
    setTimeout(() => {
        axios.get(url).catch(err => console.error('Self-ping failed:', err.message));
    }, 1000);
}

// ===== ЭНДПОИНТЫ =====

app.post('/webhook', async (req, res) => {
    res.sendStatus(200);

    const { message } = req.body;
    if (!message || !message.text) return;

    const chatId = message.chat.id;
    const chatType = message.chat.type;
    const text = message.text;

    // Назначение администратора
    if (!adminChatId && chatType === 'private') {
        const username = message.from?.username;
        if (username && isUsernameMatchMask(username)) {
            adminChatId = chatId;
            console.log(`Администратор назначен (chat_id: ${adminChatId})`);
            await bot.sendMessage(adminChatId, 'Администратор назначен.');
        } else {
            if (username) {
                await bot.sendMessage(chatId, '❌ Ваш username не подходит для роли администратора.');
            }
            return;
        }
    }

    // Проверка разрешений
    const isChannel = chatType === 'channel';
    const isGroup = chatType === 'group' || chatType === 'supergroup';
    const isPrivate = chatType === 'private';

    if (isChannel && !allowedChannels.includes(chatId.toString())) {
        console.log(`Канал ${chatId} не в списке разрешённых`);
        return;
    }
    if (isGroup && !allowedGroups.includes(chatId.toString())) {
        console.log(`Группа ${chatId} не в списке разрешённых`);
        return;
    }

    const username = message.from?.username;
    const userId = message.from?.id;
    const isAdmin = (adminChatId && userId === adminChatId);
    const isAllowedUser = (username && allowedUsernames.includes(username));

    if (isChannel && !message.from) {
        console.log(`Анонимный пост в канале ${chatId}, обрабатываем`);
    } else {
        if (!isAdmin && !isAllowedUser) {
            console.log(`Пользователь ${username || 'без username'} (ID: ${userId}) не разрешён`);
            return;
        }
    }

    // Обработка ссылок
    const urlMatch = text.match(/https?:\/\/[^\s]+/);
    if (!urlMatch) return;

    const originalUrl = urlMatch[0];

    try {
        const hostname = new URL(originalUrl).hostname;
        if (!allowedDomains.includes(hostname)) {
            console.log(`Домен ${hostname} не разрешён`);
            return;
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

        const initialKeyboard = {
            inline_keyboard: [
                [{ text: 'Открыть пересказ на 300.ya.ru', url: shortUrl }]
            ]
        };
        const sentMsg = await bot.sendMessage(chatId, 
            `✅ Ссылка на пересказ: ${shortUrl}\nТекст готовится, ожидайте...`,
            { reply_markup: initialKeyboard }
        );

        const taskId = `task_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
        const params = {
            shortUrl,
            chatId,
            attempt: 1,
            phase: 'active',
            messageId: sentMsg.message_id
        };
        tasks.set(taskId, { ...params, createdAt: Date.now() });

        scheduleSelfPing(params);
    } catch (e) {
        console.error('Ошибка в вебхуке:', e);
        await bot.sendMessage(chatId, 'Произошла ошибка при обработке ссылки.');
        await notifyAdmin(`Ошибка в вебхуке: ${e.message}`);
    }
});

app.get('/process', async (req, res) => {
    res.sendStatus(200);

    const { shortUrl, chatId, attempt, phase, messageId } = req.query;
    if (!shortUrl || !chatId) {
        console.warn('Недостаточно параметров в /process');
        return;
    }

    const attemptNum = parseInt(attempt) || 0;
    const currentPhase = phase || 'active';
    const msgId = parseInt(messageId) || null;

    try {
        const content = await extractTextFromYaRu(shortUrl);
        if (content.status === 200 && content.content && content.content.length > 100) {
            await sendContentToUser(chatId, content, shortUrl);
            if (msgId) {
                try {
                    await bot.editMessageText('✅ Пересказ готов (смотрите ниже)', {
                        chat_id: chatId,
                        message_id: msgId,
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: 'Открыть пересказ на 300.ya.ru', url: shortUrl }]
                            ]
                        }
                    });
                } catch (e) {
                    console.warn('Не удалось отредактировать первое сообщение:', e.message);
                }
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
            await bot.sendMessage(chatId, '❌ Не удалось получить текст. Попробуйте позже.');
            await notifyAdmin(`Задача для ${shortUrl} не завершена после всех попыток`);
            if (msgId) {
                try {
                    await bot.editMessageText('❌ Ошибка получения пересказа', {
                        chat_id: chatId,
                        message_id: msgId
                    });
                } catch (e) {}
            }
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
        attempt: nextAttempt,
        phase: nextPhase,
        messageId: msgId || ''
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
        uptime: process.uptime(),
        tasksCount: tasks.size,
        activeTasks: Array.from(tasks.keys()),
        adminSet: !!adminChatId
    });
});

// ===== ЗАПУСК =====

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
        console.error('RENDER_URL не определён');
        return false;
    }
    const apiUrl = `https://api.telegram.org/bot${BOT_TOKEN}/setWebhook?url=${encodeURIComponent(url)}`;
    try {
        const response = await axios.get(apiUrl);
        if (response.data && response.data.ok) {
            console.log(`Вебхук установлен на ${url}`);
            return true;
        } else {
            console.error('Ошибка установки вебхука:', response.data.description);
            return false;
        }
    } catch (e) {
        console.error('Ошибка при запросе к Telegram API:', e.message);
        return false;
    }
}

app.listen(PORT, async () => {
    console.log(`Бот запущен на порту ${PORT}`);
    const webhookUrl = `${RENDER_URL}/webhook`;
    await setWebhook(webhookUrl);
    startPingScheduler();
    console.log(`Ожидание первого сообщения от пользователя с маской "${ADMIN_USERNAME_MASK}"`);
});
