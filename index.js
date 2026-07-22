// index.js — версия 1.0.10

// ===== ИНДИВИДУАЛЬНЫЕ НАСТРОЙКИ (переменные по умолчанию) =====
let allowedDomains = ['nplus1.ru', 'naked-science.ru', '300.ya.ru'];
let allowedUsernames = [];
let allowedChannels = [];
let allowedGroups = [];
let allowedChannelsNoDomainCheck = [];
let allowedGroupsNoDomainCheck = [];
let YANDEX_TOKEN = process.env.YANDEX_TOKEN || '';
let DIAGNOSTIC_MODE = process.env.DIAGNOSTIC_ENABLED === 'true' || false;
let ACTIVE_INTERVAL = 3000;
let MAX_ACTIVE_ATTEMPTS = 100;
let LONG_INTERVAL = 60000;
let MAX_LONG_ATTEMPTS = 20;
let PING_MIN_INTERVAL = 10 * 60 * 1000;
let PING_MAX_INTERVAL = 13 * 60 * 1000;

// ===== ИМПОРТЫ =====
const express = require('express');
const axios = require('axios');
const TelegramBot = require('node-telegram-bot-api');
const cheerio = require('cheerio');

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

// ===== ЛОГИРОВАНИЕ =====
function logToAdmin(message) {
    const alwaysShow = [
        'Self-ping failed:',
        'Недостаточно параметров в /process',
        'Дежурный пинг не удался:',
        'RENDER_URL не определён, вебхук не может быть установлен',
        'Ошибка установки вебхука:'
    ];
    const isAlways = alwaysShow.some(prefix => message.includes(prefix));
    if (isAlways) {
        console.log(message);
        if (adminChatId) bot.sendMessage(adminChatId, `📝 ${message}`).catch(() => {});
    } else if (DIAGNOSTIC_MODE) {
        console.log(message);
        if (adminChatId) bot.sendMessage(adminChatId, `📝 ${message}`).catch(() => {});
    }
}

// ===== ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ =====

function isUsernameMatchMask(username, mask) {
    if (!username || !mask) return false;
    if (mask.length !== 3 || mask[1] !== '*') return false;
    const first = mask[0];
    const last = mask[2];
    return username[0] === first && username[username.length - 1] === last;
}

function normalizeId(id) {
    const str = id.toString();
    if (str.startsWith('-100')) return str.substring(4);
    return str;
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

// ===== ИЗВЛЕЧЕНИЕ КОНФИГА ИЗ ТЕКСТА (по маркеру [[[ ... ]]]) =====
function extractConfig(text) {
    if (!text) return null;
    const match = text.match(/\[\[\[\s*([\s\S]*?)\s*\]\]\]/);
    if (!match) return null;
    let inner = match[1].trim();
    inner = inner.replace(/^\uFEFF/, '').trim();
    if (inner.startsWith('"') && inner.endsWith('"')) {
        inner = inner.substring(1, inner.length - 1);
    }
    inner = inner.replace(/\u00A0/g, ' ');
    try {
        const arr = JSON.parse(inner);
        if (Array.isArray(arr) && arr.length === 14) {
            return arr;
        }
    } catch (e) {
        console.error('Ошибка парсинга JSON в извлечённом конфиге:', e.message);
        console.error('Текст, который парсили:', inner);
        return null;
    }
    return null;
}

// ===== ПРИМЕНЕНИЕ КОНФИГА =====
function applyConfig(arr) {
    if (!Array.isArray(arr) || arr.length !== 14) {
        throw new Error('Массив должен содержать ровно 14 элементов');
    }
    allowedDomains = arr[0] || [];
    allowedUsernames = arr[1] || [];
    allowedChannels = arr[2] || [];
    allowedGroups = arr[3] || [];
    allowedChannelsNoDomainCheck = arr[4] || [];
    allowedGroupsNoDomainCheck = arr[5] || [];
    YANDEX_TOKEN = arr[6] || '';
    DIAGNOSTIC_MODE = typeof arr[7] === 'boolean' ? arr[7] : false;
    ACTIVE_INTERVAL = typeof arr[8] === 'number' ? arr[8] : 3000;
    MAX_ACTIVE_ATTEMPTS = typeof arr[9] === 'number' ? arr[9] : 100;
    LONG_INTERVAL = typeof arr[10] === 'number' ? arr[10] : 60000;
    MAX_LONG_ATTEMPTS = typeof arr[11] === 'number' ? arr[11] : 20;
    PING_MIN_INTERVAL = typeof arr[12] === 'number' ? arr[12] : 10 * 60 * 1000;
    PING_MAX_INTERVAL = typeof arr[13] === 'number' ? arr[13] : 13 * 60 * 1000;
    logToAdmin('✅ Конфиг применён');
}

// ===== ЗАГРУЗКА КОНФИГА ИЗ ЗАКРЕПЛЁННОГО СООБЩЕНИЯ =====
async function loadConfigFromPinned() {
    if (!adminChatId) return false;
    try {
        const chat = await bot.getChat(adminChatId);
        const pinned = chat.pinned_message;
        if (pinned && pinned.text) {
            const arr = extractConfig(pinned.text);
            if (arr) {
                applyConfig(arr);
                logToAdmin('✅ Конфиг загружен из закреплённого сообщения');
                return true;
            }
        }
    } catch (e) {
        console.error('Ошибка при получении закреплённого сообщения:', e);
        if (adminChatId) {
            bot.sendMessage(adminChatId, `❌ Ошибка загрузки конфига: ${e.message}`).catch(() => {});
        }
    }
    return false;
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
        logToAdmin(`❌ Ошибка получения shortUrl: ${e.message}`);
        if (e.response) {
            logToAdmin(`Статус: ${e.response.status}, данные: ${JSON.stringify(e.response.data)}`);
        }
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
        logToAdmin(`❌ Ошибка получения контента с ${url}: ${e.message}`);
        if (e.response) {
            logToAdmin(`Статус: ${e.response.status}`);
        }
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

    let cleanText = contentText
        .replace(/\s{2,}/g, '\n')
        .replace(/(\n)(?![•\s])/g, '\n\n')
        .replace(/\n{3,}/g, '\n\n')
        .replace(/Для улучшения качества[\s\S]*$/im, '')
        .trim();

    cleanText = cleanText.replace(/Данный формат временно недоступен для этого видео/gi, '').trim();

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

// ===== ОБЩАЯ ФУНКЦИЯ ОБРАБОТКИ ССЫЛОК =====
async function processUrl(chatId, text, originalMessageId = null) {
    const urlMatch = text.match(/https?:\/\/[^\s]+/);
    if (!urlMatch) return;

    const originalUrl = urlMatch[0];
    logToAdmin(`🔗 Обработка ссылки: ${originalUrl}`);

    // Проверка домена (если chatId не админ, то проверяем по списку)
    let isAdmin = (adminChatId && chatId === adminChatId);
    if (!isAdmin) {
        try {
            const hostname = new URL(originalUrl).hostname;
            if (!allowedDomains.includes(hostname)) {
                logToAdmin(`❌ Домен ${hostname} не разрешён`);
                return;
            }
        } catch (e) {
            console.error('Ошибка парсинга URL:', e);
            return;
        }
    }

    try {
        const shortResult = await getShortUrl(originalUrl);
        if (shortResult.status === 'error') {
            await bot.sendMessage(chatId, '❌ Не удалось получить ссылку на пересказ.');
            await notifyAdmin(`Ошибка получения shortUrl: ${originalUrl} - ${shortResult.message}`);
            return;
        }
        const shortUrl = shortResult.sharing_url;

        let sentMsg;
        if (originalMessageId) {
            // Если мы редактируем уже существующее сообщение (например, в канале)
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

        scheduleSelfPing(params);
        logToAdmin(`✅ Задача создана: ${taskId}`);
    } catch (e) {
        console.error('Ошибка при обработке ссылки:', e);
        await bot.sendMessage(chatId, 'Произошла ошибка при обработке ссылки.');
        await notifyAdmin(`Ошибка обработки ссылки: ${e.message}`);
    }
}

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
    const chatIdStr = normalizeId(chatId);

    logToAdmin(`📥 Вебхук: chatId=${chatId} (норм: ${chatIdStr}), type=${chatType}, user=${username}`);

    // === ОБРАБОТКА ЛИЧНЫХ СООБЩЕНИЙ ===
    if (chatType === 'private') {
        // Если администратор уже назначен
        if (chatId === adminChatId) {
            // Проверяем наличие маркера [[[ (команда конфига)
            if (text.includes('[[[')) {
                const arr = extractConfig(text);
                if (arr) {
                    try {
                        applyConfig(arr);
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
                const loaded = await loadConfigFromPinned();
                if (loaded) {
                    await bot.sendMessage(adminChatId, '✅ Конфиг перезагружен из закреплённого сообщения.');
                } else {
                    await bot.sendMessage(adminChatId, '❌ Не удалось загрузить конфиг. Убедитесь, что закреплённое сообщение содержит маркер [[[ ... ]]] и валидный массив.');
                }
                return;
            }

            // Если это не команда и не конфиг — обрабатываем как ссылку
            await processUrl(chatId, text);
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
                if (isUsernameMatchMask(username, mask)) {
                    adminChatId = chatId;
                    console.log(`Администратор назначен`); // без ID
                    let greeting = '✅ Вы назначились администратором бота.';
                    const configLoaded = await loadConfigFromPinned();
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
        if (!allowedChannels.includes(chatIdStr)) {
            logToAdmin(`❌ Канал ${chatId} (норм: ${chatIdStr}) не в списке разрешённых`);
            return;
        }
    }
    if (isGroup) {
        if (!allowedGroups.includes(chatIdStr)) {
            logToAdmin(`❌ Группа ${chatId} (норм: ${chatIdStr}) не в списке разрешённых`);
            return;
        }
    }

    const isAdmin = (adminChatId && userId === adminChatId);
    const isAllowedUser = (username && allowedUsernames.includes(username));

    if (isChannel && !message.from) {
        logToAdmin(`ℹ️ Анонимный пост в канале ${chatId}, обрабатываем`);
    } else {
        if (!isAdmin && !isAllowedUser) {
            logToAdmin(`❌ Пользователь ${username} не разрешён`);
            return;
        }
    }

    // Проверка домена для каналов/групп (если не в списке исключений)
    const isDomainCheckSkipped = (isChannel && allowedChannelsNoDomainCheck.includes(chatIdStr)) ||
                                 (isGroup && allowedGroupsNoDomainCheck.includes(chatIdStr));

    if (!isDomainCheckSkipped) {
        // Домен будет проверен внутри processUrl, поэтому передаём флаг, что это не админ
        // Но мы уже проверили админа выше, поэтому processUrl сама проверит домен
        await processUrl(chatId, text, message.message_id);
    } else {
        logToAdmin(`⏩ Проверка домена пропущена (чат в списке исключений)`);
        await processUrl(chatId, text, message.message_id);
    }
});

// ===== ОСТАЛЬНЫЕ ЭНДПОИНТЫ (без изменений) =====
app.get('/process', async (req, res) => {
    res.sendStatus(200);
    // ... (код без изменений, он использует глобальные переменные)
});

app.get('/ping', (req, res) => {
    res.sendStatus(200);
});

app.get('/status', (req, res) => {
    res.json({
        version: '1.0.10',
        uptime: process.uptime(),
        tasksCount: tasks.size,
        activeTasks: Array.from(tasks.keys()),
        adminSet: !!adminChatId,
        diagnosticMode: DIAGNOSTIC_MODE
    });
});

// ===== ЗАПУСК =====
// ... (код запуска без изменений)
