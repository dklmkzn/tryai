// yandex-utils.js — версия 1.1.2
// Функции для работы с 300.ya.ru: получение shortUrl, парсинг страницы, форматирование новости.
// Логирование через logMessage (если передан) или console (если не передан).

const axios = require('axios');
const cheerio = require('cheerio');

let configYandexToken = '';

function setYandexToken(token) {
    configYandexToken = token;
}

// Вспомогательная функция для логирования
function safeLog(adminChatId, bot, message, level, diagnosticMode, logFn) {
    if (logFn) {
        logFn(adminChatId, bot, message, level, diagnosticMode);
    } else {
        console.log(`[${level}] ${message}`);
    }
}

async function getShortUrl(articleUrl, yandexToken, logFn = null, adminChatId = null, bot = null, diagnosticMode = false) {
    if (articleUrl.includes('300.ya.ru')) {
        safeLog(adminChatId, bot, 'getShortUrl: уже ссылка на 300.ya.ru', 'info', diagnosticMode, logFn);
        return { status: 'success', sharing_url: articleUrl };
    }
    try {
        const response = await axios.post(
            'https://300.ya.ru/api/sharing-url',
            { article_url: articleUrl },
            {
                headers: {
                    'Authorization': yandexToken || configYandexToken,
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
            const requestData = [
                { article_url: articleUrl },
            {
                headers: {
                    'Authorization': yandexToken || configYandexToken,
                    'Content-Type': 'application/json'
                },
                timeout: 10000
            }
                ]
        safeLog(adminChatId, bot, `${diagnosticMode} Запрос к 300.ya.ru: ${JSON.stringify(requestData)}`, 'info', true, logFn);
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

        // Диагностика
        const diagMsg = `📄 Получена страница ${url}, первые 500 символов:\n${fullText.substring(0, 500)}\n🔍 Фраза "Данный формат временно недоступен для этого видео" ${fullText.includes('Данный формат временно недоступен для этого видео') ? 'ПРИСУТСТВУЕТ' : 'ОТСУТСТВУЕТ'}`;
        safeLog(adminChatId, bot, diagMsg, 'info', diagnosticMode, logFn);

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
    // ... (без изменений, так как это не логирует)
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
    // ... (без изменений)
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

module.exports = {
    getShortUrl,
    extractTextFromYaRu,
    parseContent,
    formatNews,
    setYandexToken
};
