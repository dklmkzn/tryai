// index.js — версия 1.0.8

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

// ===== ЗАГРУЗКА ИЗ ЗАКРЕПЛЁННОГО СООБЩЕНИЯ =====
async function loadConfigFromPinned() {
    if (!adminChatId) return false;
    try {
        const chat = await bot.getChat(adminChatId);
        const pinned = chat.pinned_message;
        if (pinned && pinned.text) {
            const match = pinned.text.match(/(\[[\s\S]*?\])/);
            if (match) {
                const arr = JSON.parse(match[1]);
                applyConfig(arr);
                logToAdmin('✅ Конфиг загружен из закреплённого сообщения');
                return true;
            }
        }
    } catch (e) {
        console.error('Ошибка загрузки конфига из закреплённого:', e);
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

    logToAdmin(`📥 Вебхук: chatId=${chatId} (норм: ${chatIdStr}), type=${chatType}, user=${username}, text=${text.substring(0, 80)}${text.length > 80 ? '...' : ''}`);

    // === ОБРАБОТКА ЛИЧНЫХ СООБЩЕНИЙ ===
    if (chatType === 'private') {
        if (chatId === adminChatId) {
if (text.trim().startsWith('[')) {
    let cleanText = '';
    // Диагностика: выводим точный текст сообщения
    console.log('=== ТЕКСТ СООБЩЕНИЯ ===');
    console.log(text);
    console.log('=== ДЛИНА: ' + text.length);
    console.log('=== ПЕРВЫЕ 20 СИМВОЛОВ: ' + JSON.stringify(text.substring(0, 20)));
    console.log('=== ПОСЛЕДНИЕ 20 СИМВОЛОВ: ' + JSON.stringify(text.substring(text.length - 20)));
    
    try {
        // Попытка очистить текст от возможных BOM и лишних пробелов
        let cleanText = text.trim();
        // Если текст обёрнут в кавычки, снимаем их
        if (cleanText.startsWith('"') && cleanText.endsWith('"')) {
            cleanText = cleanText.substring(1, cleanText.length - 1);
        }
        // Заменяем возможные неразрывные пробелы на обычные
        cleanText = cleanText.replace(/\u00A0/g, ' ');
        // Если есть символы BOM (U+FEFF) — удаляем
        cleanText = cleanText.replace(/^\uFEFF/, '');
        
        const arr = JSON.parse(cleanText);
                    applyConfig(arr);
                    await bot.sendMessage(adminChatId, '✅ Конфиг обновлён и закреплён.');
    } catch (e) {
        // Выводим ошибку с текстом, который не удалось распарсить
        console.error('Ошибка парсинга JSON. Текст, вызвавший ошибку:');
        console.error(cleanText);
        await bot.sendMessage(adminChatId, `❌ Ошибка: ${e.message}\nПроверьте текст сообщения.`);
    }
}
            return;
        }

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
                    console.log(`Администратор назначен (chat_id: ${adminChatId})`);
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

    // === ПРОВЕРКА РАЗРЕШЁННЫХ КАНАЛОВ/ГРУПП (с нормализацией ID) ===
    const isChannel = chatType === 'channel';
    const isGroup = chatType === 'group' || chatType === 'supergroup';

    if (isChannel) {
        if (!allowedChannels.includes(chatIdStr)) {
            logToAdmin(`❌ Канал ${chatId} (норм: ${chatIdStr}) не в списке разрешённых (allowedChannels: ${JSON.stringify(allowedChannels)})`);
            return;
        } else {
            logToAdmin(`✅ Канал ${chatId} разрешён`);
        }
    }
    if (isGroup) {
        if (!allowedGroups.includes(chatIdStr)) {
            logToAdmin(`❌ Группа ${chatId} (норм: ${chatIdStr}) не в списке разрешённых (allowedGroups: ${JSON.stringify(allowedGroups)})`);
            return;
        } else {
            logToAdmin(`✅ Группа ${chatId} разрешена`);
        }
    }

    const isAdmin = (adminChatId && userId === adminChatId);
    const isAllowedUser = (username && allowedUsernames.includes(username));

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

    // === ПРОВЕРКА ДОМЕНА (с нормализацией ID) ===
    const isDomainCheckSkipped = (isChannel && allowedChannelsNoDomainCheck.includes(chatIdStr)) ||
                                 (isGroup && allowedGroupsNoDomainCheck.includes(chatIdStr));

    if (!isDomainCheckSkipped) {
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
    } else {
        logToAdmin(`⏩ Проверка домена пропущена (чат в списке исключений)`);
    }

    try {
        const shortResult = await getShortUrl(originalUrl);
        if (shortResult.status === 'error') {
            await bot.sendMessage(chatId, '❌ Не удалось получить ссылку на пересказ.');
            await notifyAdmin(`Ошибка получения shortUrl: ${originalUrl} - ${shortResult.message}`);
            return;
        }
        const shortUrl = shortResult.sharing_url;

        const sentMsg = await bot.sendMessage(chatId, `✅ Ссылка на пересказ: ${shortUrl}\nТекст готовится, ожидайте...`);

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
        if (adminChatId) {
            bot.sendMessage(adminChatId, '⚠️ Недостаточно параметров в /process').catch(() => {});
        }
        return;
    }

    const attemptNum = parseInt(attempt) || 0;
    const currentPhase = phase || 'active';

    try {
        const content = await extractTextFromYaRu(shortUrl);
        if (content.status === 200 && content.content && content.content.length > 100) {
            const parts = formatNews(content.title, content.content);
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
                logToAdmin(`🔗 Оригинал (не отправлен пользователю): ${content.origin}`);
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
        version: '1.0.8',
        uptime: process.uptime(),
        tasksCount: tasks.size,
        activeTasks: Array.from(tasks.keys()),
        adminSet: !!adminChatId,
        diagnosticMode: DIAGNOSTIC_MODE
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
    console.log(`Бот запущен, версия 1.0.8, порт ${PORT}`);
    const webhookUrl = `${RENDER_URL}/webhook`;
    await setWebhook(webhookUrl);
    startPingScheduler();
    console.log(`Диагностический режим: ${DIAGNOSTIC_MODE ? 'ВКЛЮЧЁН' : 'ВЫКЛЮЧЕН'}`);
    console.log('Бот готов к работе. Напишите в личку "Здравствуйте!" для начала.');
});
