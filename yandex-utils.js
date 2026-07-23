// yandex-utils.js — версия 1.1.19
// Добавлен метод получения пересказа через API 300.ya.ru/generation с куками.
// В случае ошибки выполняется fallback на парсинг страницы (старый способ).
// Если и парсинг не даёт результата, отправляется ошибка админу.

const axios = require('axios');
const cheerio = require('cheerio');

let configYandexToken = '';

function setYandexToken(token) {
    configYandexToken = token;
    console.log(`[setYandexToken] токен ${token ? 'установлен (первые 10: ' + token.substring(0,10) + '...)' : 'пустой'}`);
}

function safeLog(adminChatId, bot, message, level, diagnosticMode, logFn) {
    if (logFn) {
        logFn(message, level, diagnosticMode);
    } else {
        console.log(`[${level}] ${message}`);
    }
}

function escapeHtml(text) {
    if (!text) return '';
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

// ===== НОВЫЙ МЕТОД: ПОЛУЧЕНИЕ ПЕРЕСКАЗА ЧЕРЕЗ API =====
async function getSummaryViaApi(articleUrl, cookieString, logFn = null, adminChatId = null, bot = null, diagnosticMode = false) {
    const BASE_URL = 'https://300.ya.ru/api';
    const session = axios.create({
        headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Origin': 'https://300.ya.ru',
            'Referer': 'https://300.ya.ru/',
            'X-Requested-With': 'XMLHttpRequest'
        },
        timeout: 30000
    });

    // Добавляем куки
    if (cookieString) {
        const cookies = {};
        cookieString.split(';').forEach(item => {
            const [key, value] = item.trim().split('=');
            if (key && value) cookies[key] = value;
        });
        session.defaults.headers.Cookie = Object.entries(cookies)
            .map(([k, v]) => `${k}=${v}`)
            .join('; ');
    }

    try {
        // 1. Запускаем генерацию
        const startPayload = { article_url: articleUrl, type: 'article', ignore_cache: false };
        const startResp = await session.post(`${BASE_URL}/generation`, startPayload);
        const startData = startResp.data;

        const statusCode = startData.status_code;
        if (statusCode === 2) {
            // Сразу готово
            return { status: 'success', data: startData };
        } else if (statusCode === 3) {
            throw new Error(`Ошибка генерации (status_code=3): ${JSON.stringify(startData)}`);
        }

        const sessionId = startData.session_id;
        if (!sessionId) throw new Error('Не получен session_id');

        let pollInterval = (startData.poll_interval_ms || 2000) / 1000;
        let attempts = 0;
        const maxAttempts = 60; // ~2 минуты

        // 2. Опрашиваем до готовности
        while (attempts < maxAttempts) {
            await new Promise(resolve => setTimeout(resolve, pollInterval * 1000));
            attempts++;
            const pollPayload = { session_id: sessionId, type: 'article' };
            const pollResp = await session.post(`${BASE_URL}/generation`, pollPayload);
            const pollData = pollResp.data;
            const status = pollData.status_code;
            if (status === 2) {
                return { status: 'success', data: pollData };
            } else if (status === 3) {
                throw new Error(`Ошибка генерации при опросе: ${JSON.stringify(pollData)}`);
            }
            if (pollData.poll_interval_ms) {
                pollInterval = pollData.poll_interval_ms / 1000;
            }
        }
        throw new Error('Превышено время ожидания генерации');
    } catch (e) {
        safeLog(adminChatId, bot, `Ошибка API-генерации: ${e.message}`, 'error', diagnosticMode, logFn);
        return { status: 'error', message: e.message };
    }
}

// ===== ФОРМАТИРОВАНИЕ РЕЗУЛЬТАТА ИЗ API =====
function formatSummaryFromApi(data) {
    // data: { title, thesis, chapters, sharing_url }
    let parts = [];
    if (data.title) {
        parts.push(`<b>${escapeHtml(data.title)}</b>`);
    }
    if (data.thesis && data.thesis.length) {
        parts.push('<b>Подробные тезисы</b>');
        data.thesis.forEach((t, i) => {
            parts.push(`• ${escapeHtml(t.content)}`);
        });
    }
    if (data.chapters && data.chapters.length) {
        data.chapters.forEach((ch, i) => {
            const chTitle = escapeHtml(ch.content || `Глава ${i+1}`);
            parts.push(`<b>${chTitle}</b>`);
            if (ch.theses && ch.theses.length) {
                ch.theses.forEach(t => {
                    parts.push(`• ${escapeHtml(t.content)}`);
                });
            }
        });
    }
    // Добавляем ссылку на 300.ya.ru (если есть)
    if (data.sharing_url) {
        parts.push(`<a href="${escapeHtml(data.sharing_url)}">Открыть пересказ на 300.ya.ru</a>`);
    }
    return parts.join('\n');
}

// ===== ИЗВЛЕЧЕНИЕ ТЕКСТА (сначала API, потом парсинг) =====
async function extractTextFromYaRu(url, yandexToken, logFn = null, adminChatId = null, bot = null, diagnosticMode = false, cookieString = '') {
    try {
        // 1. Пробуем получить через API (если есть куки)
        if (cookieString) {
            const apiResult = await getSummaryViaApi(url, cookieString, logFn, adminChatId, bot, diagnosticMode);
            if (apiResult.status === 'success') {
                const data = apiResult.data;
                const content = formatSummaryFromApi(data);
                safeLog(adminChatId, bot, '✅ Контент получен через API', 'info', diagnosticMode, logFn);
                return {
                    status: 200,
                    title: data.title || '',
                    content: content,
                    origin: data.sharing_url || ''
                };
            } else {
                safeLog(adminChatId, bot, `⚠️ API вернул ошибку, переходим к парсингу страницы: ${apiResult.message}`, 'warn', diagnosticMode, logFn);
                // Падаем в парсинг
            }
        }

        // 2. Fallback: парсинг страницы (старый способ)
        const response = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
                'Accept-Encoding': 'gzip, deflate, br',
                'Connection': 'keep-alive',
                'Upgrade-Insecure-Requests': '1',
                'Referer': 'https://300.ya.ru/'
            },
            timeout: 15000,
            responseType: 'text'
        });
        const $ = cheerio.load(response.data);
        const originLink = $('a').filter((i, el) => $(el).text().includes('Перейти на оригинал')).attr('href') || '';
        const fullText = $('body').text();

        safeLog(adminChatId, bot, `📄 Получена страница (парсинг), длина ${fullText.length}`, 'info', diagnosticMode, logFn);

        const { title, content } = parseContent(fullText);
        if (!content || content.length < 100) {
            // Если контент слишком короткий, возможно, страница не загрузилась или требует авторизации
            safeLog(adminChatId, bot, `⚠️ Парсинг дал короткий контент (${content ? content.length : 0} символов), возможно, требуется авторизация.`, 'warn', diagnosticMode, logFn);
            return { status: 500, title: 'Ошибка', content: 'Не удалось получить контент. Проверьте куки или токен.', origin: '' };
        }
        return { status: 200, title, content, origin: originLink };
    } catch (e) {
        const errMsg = `Ошибка получения контента (парсинг): ${e.message}`;
        safeLog(adminChatId, bot, errMsg, 'error', diagnosticMode, logFn);
        if (e.response) {
            safeLog(adminChatId, bot, `Статус: ${e.response.status}`, 'error', diagnosticMode, logFn);
        }
        return { status: 500, title: 'Error', content: errMsg, origin: '' };
    }
}

// ===== ОСТАЛЬНЫЕ ФУНКЦИИ (parseContent, formatNews, getShortUrl) без изменений =====
// ... (они остаются как в версии 1.1.18)

// Для краткости я не повторяю их здесь, но они должны быть вставлены из предыдущей версии.
// Ниже приведу их в полном виде.

function parseContent(fullText) {
    // ... (как в версии 1.1.18)
    let cleaned = fullText.replace(/Данный формат временно недоступен для этого видео/gi, '');
    const parts = cleaned.split(/(Пользовательское соглашение|API|Как использовать API)/i);
    if (parts.length > 1) {
        cleaned = parts[0].trim();
    }
    cleaned = cleaned.replace(/©.*$/gm, '');
    cleaned = cleaned
        .replace(/Скачайте Браузер.*$/gim, '')
        .replace(/Краткий пересказ этой и любых других статей доступны только пользователям Яндекс Браузера.*$/gim, '')
        .replace(/Войти.*$/gim, '');
    cleaned = cleaned.replace(/\s{2,}/g, '\n').trim();

    const isYandexGptSummary = /YandexGPT\s+краткий пересказ статьи от нейросети/im.test(cleaned);
    const startMarker = /Пересказ сделан (.{0,50}?)Обновить/s;
    const startMatch = cleaned.match(startMarker);
    const endMarker = /Для улучшения качества предложите свой вариант/im;
    const endMatch = cleaned.match(endMarker);
    const dividerMarker = isYandexGptSummary
        ? /Кратко\s+Подробно/im
        : /\d{2}:\d{2}:\d{2}/;
    const dividerMatch = cleaned.match(dividerMarker);

    let contentText = cleaned;
    let titleText = '';

    if (startMatch && dividerMatch && endMatch) {
        const startPos = startMatch.index + startMatch[0].length;
        const dividerPos = dividerMatch.index;
        const endPos = endMatch.index;
        const title = cleaned.slice(startPos, dividerPos).trim();
        contentText = cleaned.slice(dividerPos + dividerMatch[0].length, endPos).trim();
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
    // ... (как в версии 1.1.18)
    const safeTitle = escapeHtml(title);
    const safeContent = escapeHtml(content);

    const BUTTON_TEXT = 'Открыть пересказ на 300.ya.ru';
    const BUTTON_URL_LENGTH = 30;
    const BUTTON_TOTAL_LENGTH = BUTTON_TEXT.length + BUTTON_URL_LENGTH + 10;
    const MAX_MESSAGE_LENGTH = 4096 - BUTTON_TOTAL_LENGTH - 30;

    const fullTitle = safeTitle ? `${safeTitle}\nПересказ YandexGPT на 300.ya.ru` : 'Пересказ YandexGPT на 300.ya.ru';
    const formattedTitle = safeTitle ? `<b>${safeTitle}</b>` : '';
    const fullText = formattedTitle + (safeContent ? `\n<blockquote>\n<b>Пересказ YandexGPT на 300.ya.ru</b>\n\n${safeContent}</blockquote>` : '');

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

// getShortUrl остаётся без изменений (был в версии 1.1.18)
async function getShortUrl(articleUrl, yandexToken, logFn = null, adminChatId = null, bot = null, diagnosticMode = false) {
    // ... (код как в 1.1.18)
    const usedToken = yandexToken || configYandexToken;
    const tokenPreview = usedToken ? usedToken.substring(0,10) + '...' : 'НЕ ЗАДАН';
    safeLog(adminChatId, bot, `[getShortUrl] используемый токен: ${tokenPreview} (передан yandexToken=${!!yandexToken}, configYandexToken=${!!configYandexToken})`, 'info', diagnosticMode, logFn);

    if (articleUrl.includes('300.ya.ru')) {
        safeLog(adminChatId, bot, 'getShortUrl: уже ссылка на 300.ya.ru', 'info', diagnosticMode, logFn);
        return { status: 'success', sharing_url: articleUrl };
    }

    const requestData = [
        { article_url: articleUrl },
        {
            headers: {
                'Authorization': usedToken ? `OAuth ${usedToken}` : '',
                'Content-Type': 'application/json'
            },
            timeout: 10000
        }
    ];
    safeLog(adminChatId, bot, `Запрос к 300.ya.ru: ${JSON.stringify(requestData)}`, 'info', diagnosticMode, logFn);

    try {
        const response = await axios.post(
            'https://300.ya.ru/api/sharing-url',
            { article_url: articleUrl },
            {
                headers: {
                    'Authorization': usedToken ? `OAuth ${usedToken}` : '',
                    'Content-Type': 'application/json'
                },
                timeout: 10000
            }
        );
        safeLog(adminChatId, bot, `getShortUrl: успешно получена ссылка ${response.data.sharing_url}`, 'info', diagnosticMode, logFn);
        return { status: 'success', sharing_url: response.data.sharing_url };
    } catch (e) {
        const errMsg = `Ошибка получения shortUrl: ${e.message}`;
        safeLog(adminChatId, bot, errMsg, 'error', diagnosticMode, logFn);
        if (e.response) {
            safeLog(adminChatId, bot, `Статус: ${e.response.status}, Данные: ${JSON.stringify(e.response.data)}`, 'error', diagnosticMode, logFn);
        }
        return { status: 'error', message: e.message };
    }
}

module.exports = {
    getShortUrl,
    extractTextFromYaRu,
    parseContent,
    formatNews,
    setYandexToken
};
