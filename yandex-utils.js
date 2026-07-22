// yandex-utils.js — версия 1.1.1
// Функции для работы с 300.ya.ru: получение shortUrl, парсинг страницы, форматирование новости.

const axios = require('axios');
const cheerio = require('cheerio');

// ===== ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ (используют глобальный YANDEX_TOKEN из config) =====
let YANDEX_TOKEN = ''; // будет установлено через applyConfig

// Мы не можем напрямую импортировать YANDEX_TOKEN из config, так как он может меняться.
// Поэтому будем передавать его через замыкание при вызове getShortUrl и extractTextFromYaRu.
// Вместо этого я буду использовать глобальный объект config, но для простоты сделаем так:
// В index.js мы передадим YANDEX_TOKEN как параметр в функции.

// Однако проще всего сделать так, чтобы функции принимали YANDEX_TOKEN как аргумент.
// Но я перепишу их с использованием глобальной переменной из config, если она экспортируется.

// В этом файле мы будем использовать переменную configYandexToken, которую установим из вне.
let configYandexToken = '';

function setYandexToken(token) {
    configYandexToken = token;
}

async function getShortUrl(articleUrl, yandexToken) {
    if (articleUrl.includes('300.ya.ru')) {
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
        return { status: 'success', sharing_url: response.data.sharing_url };
    } catch (e) {
        console.error('❌ Ошибка получения shortUrl:', e.message);
        if (e.response) {
            console.error('Статус:', e.response.status, 'Данные:', JSON.stringify(e.response.data));
        }
        return { status: 'error', message: e.message };
    }
}

async function extractTextFromYaRu(url, yandexToken, logToAdmin = null, adminChatId = null, bot = null) {
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
        const msg = `📄 Получена страница ${url}, первые 500 символов:\n${fullText.substring(0, 500)}\n🔍 Фраза "Данный формат временно недоступен для этого видео" ${fullText.includes('Данный формат временно недоступен для этого видео') ? 'ПРИСУТСТВУЕТ' : 'ОТСУТСТВУЕТ'}`;
        if (logToAdmin && adminChatId && bot) {
            logToAdmin(adminChatId, bot, msg);
        } else {
            console.log(msg);
        }

        const { title, content } = parseContent(fullText);
        return { status: 200, title, content, origin: originLink };
    } catch (e) {
        console.error('❌ Ошибка получения контента с', url, e.message);
        if (e.response) {
            console.error('Статус:', e.response.status);
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

// ===== ЭКСПОРТ =====
module.exports = {
    getShortUrl,
    extractTextFromYaRu,
    parseContent,
    formatNews,
    setYandexToken
};
