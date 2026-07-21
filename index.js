// index.js — полная финальная версия
const express = require('express');
const axios = require('axios');
const TelegramBot = require('node-telegram-bot-api');
const cheerio = require('cheerio');

// ===== КОНФИГУРАЦИЯ (переменные окружения) =====
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_USERNAME_MASK = process.env.ADMIN_USERNAME_MASK || 'd*n'; // первая и последняя буква
const YANDEX_TOKEN = process.env.YANDEX_TOKEN;
const RENDER_URL = process.env.RENDER_EXTERNAL_URL || process.env.RENDER_URL;
const PORT = process.env.PORT || 3000;

// Параметры проверки готовности контента
const ACTIVE_INTERVAL = 3000;          // 3 секунды
const MAX_ACTIVE_ATTEMPTS = 100;       // 5 минут
const LONG_INTERVAL = 60000;           // 1 минута
const MAX_LONG_ATTEMPTS = 20;          // ещё 20 минут

// Параметры дежурного пинга (случайный интервал 10-13 минут)
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

// Глобальное хранилище задач (Map) – для локального контроля
const tasks = new Map();

// Переменная для chat_id администратора (заполняется при первом подходящем сообщении)
let adminChatId = null;

// ===== ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ =====

// Проверка соответствия username маске (первая и последняя буква)
function isUsernameMatchMask(username) {
    if (!username || !ADMIN_USERNAME_MASK) return false;
    const first = ADMIN_USERNAME_MASK[0];
    const last = ADMIN_USERNAME_MASK[ADMIN_USERNAME_MASK.length - 1];
    return username[0] === first && username[username.length - 1] === last;
}

// Отправка уведомления администратору (только если он уже назначен)
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

// Получение короткой ссылки через API Яндекса
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

// Извлечение текста со страницы 300.ya.ru через cheerio
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

// Парсинг содержимого (ваша логика из newbot.js)
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

// Форматирование новости с разделением на части (если длиннее 4096 символов)
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

// Отправка контента пользователю (с разбивкой на части)
async function sendContentToUser(chatId, content) {
    const parts = formatNews(content.title, content.content);
    for (const part of parts) {
        await bot.sendMessage(chatId, part, { parse_mode: 'HTML' });
    }
    if (content.origin) {
        await bot.sendMessage(chatId, `🔗 Оригинал: ${content.origin}`);
    }
}

// ===== ФУНКЦИЯ SELF-PING (отправка запроса на /process) =====
function scheduleSelfPing(params) {
    const url = `${RENDER_URL}/process?` + new URLSearchParams(params).toString();
    setTimeout(() => {
        axios.get(url).catch(err => console.error('Self-ping failed:', err.message));
    }, 1000);
}

// ===== ЭНДПОИНТЫ =====

// 1. Вебхук от Telegram
app.post('/webhook', async (req, res) => {
    // Немедленно отвечаем Telegram
    res.sendStatus(200);

    const { message } = req.body;
    if (!message || !message.text) return;

    const chatId = message.chat.id;
    const chatType = message.chat.type;
    const text = message.text;

    // === НАЗНАЧЕНИЕ АДМИНИСТРАТОРА (только в личке) ===
    if (!adminChatId && chatType === 'private') {
        const username = message.from?.username;
        if (username && isUsernameMatchMask(username)) {
            adminChatId = chatId;
            console.log(`Администратор назначен: ${username} (chat_id: ${adminChatId})`);
            await bot.sendMessage(adminChatId, '✅ Вы назначены администратором бота. Уведомления об ошибках будут приходить сюда.');
        } else {
            if (username) {
                await bot.sendMessage(chatId, '❌ Ваш username не подходит для роли администратора.');
            }
            return; // не обрабатываем ссылки от неадминов в личке
        }
    }

    // === ПРОВЕРКА РАЗРЕШЁННЫХ КАНАЛОВ/ГРУПП И АВТОРА ===
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

    // Для каналов: если автор отсутствует (анонимный пост) – разрешаем, иначе проверяем
    if (isChannel && !message.from) {
        console.log(`Анонимный пост в канале ${chatId}, обрабатываем`);
    } else {
        if (!isAdmin && !isAllowedUser) {
            console.log(`Пользователь ${username || 'без username'} (ID: ${userId}) не разрешён`);
            return;
        }
    }

    // === ОБРАБОТКА ССЫЛОК ===
    const urlMatch = text.match(/https?:\/\/[^\s]+/);
    if (!urlMatch) return;

    const originalUrl = urlMatch[0];

    // Проверка домена
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

        // Отправляем пользователю первое сообщение
        await bot.sendMessage(chatId, `✅ Ссылка на пересказ: ${shortUrl}\nТекст готовится, ожидайте...`);

        // Создаём задачу (сохраняем в Map для локального контроля)
        const taskId = `task_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
        const params = {
            shortUrl,
            chatId,
            attempt: 1,
            phase: 'active'
        };
        tasks.set(taskId, { ...params, createdAt: Date.now() });

        // Запускаем первую проверку через 3 секунды
        scheduleSelfPing(params);
    } catch (e) {
        console.error('Ошибка в вебхуке:', e);
        await bot.sendMessage(chatId, 'Произошла ошибка при обработке ссылки.');
        await notifyAdmin(`Ошибка в вебхуке: ${e.message}`);
    }
});

// 2. Эндпоинт для обработки задачи (self-ping)
app.get('/process', async (req, res) => {
    res.sendStatus(200);

    const { shortUrl, chatId, attempt, phase } = req.query;
    if (!shortUrl || !chatId) {
        console.warn('Недостаточно параметров в /process');
        return;
    }

    const attemptNum = parseInt(attempt) || 0;
    const currentPhase = phase || 'active';

    try {
        const content = await extractTextFromYaRu(shortUrl);
        if (content.status === 200 && content.content && content.content.length > 100) {
            await sendContentToUser(chatId, content);
            // Удаляем задачу из Map (если есть)
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

// 3. Эндпоинт для дежурного пинга (поддержание активности)
app.get('/ping', (req, res) => {
    res.sendStatus(200);
});

// 4. Эндпоинт статуса (опционально)
app.get('/status', (req, res) => {
    res.json({
        uptime: process.uptime(),
        tasksCount: tasks.size,
        activeTasks: Array.from(tasks.keys()),
        adminSet: !!adminChatId
    });
});

// ===== ЗАПУСК СЕРВЕРА И НАСТРОЙКА ВЕБХУКА =====

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

// Функция установки вебхука через прямой HTTP-запрос
async function setWebhook(url) {
    if (!url) {
        console.error('RENDER_URL не определён, вебхук не может быть установлен');
        return false;
    }
    const apiUrl = `https://api.telegram.org/bot${BOT_TOKEN}/setWebhook?url=${encodeURIComponent(url)}`;
    try {
        const response = await axios.get(apiUrl);
        if (response.data && response.data.ok) {
            console.log(`Вебхук успешно установлен на ${url}`);
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
    console.log(`Бот запущен на порту ${PORT}`);
    const webhookUrl = `${RENDER_URL}/webhook`;
    await setWebhook(webhookUrl);
    startPingScheduler();
    console.log(`Ожидание первого сообщения от пользователя с username, соответствующим маске "${ADMIN_USERNAME_MASK}"`);
});
