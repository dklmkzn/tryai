// index.js — главный файл бота

const express = require('express');
const axios = require('axios');
const TelegramBot = require('node-telegram-bot-api');
const config = require('./config');
const yandex = require('./yandex-utils');
const telegramUtils = require('./telegram-utils');

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

// ===== ПОДКЛЮЧЕНИЕ ЗАВИСИМОСТЕЙ ДЛЯ TELEGRAM-UTILS =====
telegramUtils.setDependencies(bot, adminChatId, tasks, scheduleSelfPing, telegramUtils.logToAdmin);

// ===== ФУНКЦИЯ SELF-PING =====
function scheduleSelfPing(params) {
    const url = `${RENDER_URL}/process?` + new URLSearchParams(params).toString();
    setTimeout(() => {
        axios.get(url).catch(err => console.error('Self-ping failed:', err.message));
    }, 1000);
}

// ===== ОБНОВЛЕНИЕ ADMINCHATID В TELEGRAM-UTILS =====
function updateAdminChatId(newId) {
    adminChatId = newId;
    telegramUtils.setDependencies(bot, adminChatId, tasks, scheduleSelfPing, telegramUtils.logToAdmin);
}

// ===== ЛОГИРОВАНИЕ (используем функцию из telegram-utils) =====
// Она уже определена там и использует adminChatId

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
    const chatIdStr = telegramUtils.normalizeId(chatId);

    telegramUtils.logToAdmin(`📥 Вебхук: chatId=${chatId} (норм: ${chatIdStr}), type=${chatType}, user=${username}`);

    // === ОБРАБОТКА ЛИЧНЫХ СООБЩЕНИЙ ===
    if (chatType === 'private') {
        // Если администратор уже назначен
        if (chatId === adminChatId) {
            // Проверяем наличие маркера [[[ (команда конфига)
            if (text.includes('[
