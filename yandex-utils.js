// yandex-utils.js — версия 1.1.14
const axios = require('axios');
const cheerio = require('cheerio');

let configYandexToken = '';

function setYandexToken(token) {
    configYandexToken = token;
    // Это сообщение выводится в консоль только при старте (токен пустой) и при загрузке конфига (токен установлен)
    // Мы его оставляем, так как оно относится к стартовым диагностическим сообщениям (пункт 2-4)
    console.log(`[setYandexToken] токен ${token ? 'установлен (первые 10: ' + token.substring(0,10) + '...)' : 'пустой'}`);
}

function safeLog(adminChatId, bot, message, level, diagnosticMode, logFn) {
    if (logFn) {
        logFn(message, level, diagnosticMode);
    } else {
        // fallback — если logFn не передана, пишем в консоль (но у нас всегда передаётся)
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

async function getShortUrl(articleUrl, yandexToken, logFn = null, adminChatId = null, bot = null, diagnosticMode = false) {
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

async function extractTextFromYaRu(url, yandexToken, logFn = null, adminChatId = null, bot = null, diagnosticMode = false) {
    try {
        const response = await axios.get(url, {
            headers: { 'User-Agent': 'Mozilla/5.0' },
            timeout: 15000,
            responseType: 'text'
        });
        const $ = cheerio.load(response.data);
        const originLink = $('a').filter((i, el) => $(el).text().includes('Перейти на оригинал')).attr('href') || '';
        const fullText = $('body').text();

        // === ПРОВЕРКА НА НЕСТАБИЛЬНОСТЬ (только явные технические маркеры) ===
        const isUnstable = (
            fullText.includes('__sveltekit_') ||
            fullText.includes('mc.yandex.ru') ||
            fullText.includes('Краткий пересказ ... доступен только пользователям Яндекс Браузера')
        );

        // Если маркеры есть И текст короткий (< 500 символов) — считаем нестабильным
        if (isUnstable && fullText.length < 500) {
            safeLog(adminChatId, bot, `Страница ещё не стабилизирована (маркеры + короткий текст, длина ${fullText.length})`, 'info', diagnosticMode, logFn);
            return { status: 202, title: '', content: '', origin: '' };
        }

        // Если длина >= 500 или маркеров нет — считаем стабильной
        safeLog(adminChatId, bot, `📄 Получена стабильная страница ${url}, длина ${fullText.length}`, 'info', diagnosticMode, logFn);

        const { title, content } = parseContent(fullText);
        return { status: 200, title, content, origin: originLink };
    } catch (e) {
        const errMsg = `Ошибка получения контента с ${url}: ${e.message}`;
        safeLog(adminChatId, bot, errMsg, 'error', diagnosticMode, logFn);
        if (e.response) {
            safeLog(adminChatId, bot, `Статус: ${e.response.status}`, 'error', diagnosticMode, logFn);
        }
        return { status: 500, title: 'Error', content: e.message, origin: '' };
    }
}

function parseContent(fullText) {
    let cleaned = fullText.replace(/Данный формат временно недоступен для этого видео/gi, '');

    const parts = cleaned.split(/(Пользовательское соглашение|API|Как использовать API)/i);
    if (parts.length > 1) {
        cleaned = parts[0].trim();
    }

    cleaned = cleaned.replace(/©.*$/gm, '');

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

module.exports = {
    getShortUrl,
    extractTextFromYaRu,
    parseContent,
    formatNews,
    setYandexToken
};
