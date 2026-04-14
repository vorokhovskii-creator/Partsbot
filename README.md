# Partsbot — Telegram-бот для извлечения цен запчастей

Telegram-бот для автосервиса: принимает скриншоты с ценами запчастей, извлекает данные через Google Gemini Vision и форматирует для вставки в Google Таблицы.

## Стек

- **Runtime:** Node.js + TypeScript
- **Telegram:** Telegraf
- **AI:** Google Gemini 2.5 Flash (Vision)
- **Storage:** Upstash Redis (REST API)
- **Deploy:** Vercel (serverless, webhook-режим)

## Как работает

1. Отправляешь боту скриншоты с ценами (по одному или альбомом)
2. Бот накапливает фото в буфере
3. Команда `/done` — бот скачивает все фото, отправляет в Gemini, возвращает отформатированную таблицу
4. Результат можно скопировать и вставить в Google Sheets (формат с Tab-разделителями)

## Переменные окружения

```
TELEGRAM_BOT_TOKEN=токен от @BotFather
GEMINI_API_KEY=ключ Google AI Studio (https://aistudio.google.com/apikey)
WEBHOOK_URL=https://your-project.vercel.app
UPSTASH_REDIS_REST_URL=https://your-redis.upstash.io
UPSTASH_REDIS_REST_TOKEN=токен из Upstash Console
```

## Локальный запуск (ngrok)

### 1. Установи зависимости

```bash
npm install
```

### 2. Создай `.env` из примера

```bash
cp .env.example .env
# заполни TELEGRAM_BOT_TOKEN и GEMINI_API_KEY
```

### 3. Запусти ngrok

```bash
ngrok http 3000
```

Скопируй HTTPS-адрес из ngrok (например `https://abc123.ngrok-free.app`) и впиши в `.env`:

```
WEBHOOK_URL=https://abc123.ngrok-free.app
```

### 4. Запусти Vercel dev

```bash
npx vercel dev --listen 3000
```

### 5. Установи webhook вручную

```bash
curl -X POST "https://api.telegram.org/bot<YOUR_TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://abc123.ngrok-free.app/api/webhook"}'
```

Бот готов — отправляй скриншоты.

## Deploy на Vercel

### 1. Установи Vercel CLI

```bash
npm i -g vercel
```

### 2. Залинкуй проект

```bash
vercel
```

### 3. Добавь переменные окружения

```bash
vercel env add TELEGRAM_BOT_TOKEN
vercel env add GEMINI_API_KEY
vercel env add WEBHOOK_URL
vercel env add UPSTASH_REDIS_REST_URL
vercel env add UPSTASH_REDIS_REST_TOKEN
```

`WEBHOOK_URL` — итоговый URL проекта на Vercel (например `https://partsbot.vercel.app`).

### 4. Деплой

```bash
vercel --prod
```

Webhook устанавливается автоматически при первом запросе к боту. Если нужно установить вручную:

```bash
curl -X POST "https://api.telegram.org/bot<YOUR_TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://partsbot.vercel.app/api/webhook"}'
```

## Хранилище (Upstash Redis)

Буфер фото хранится в **Upstash Redis** — REST-based Redis, который работает на любой serverless-платформе.

### Настройка

**Вариант 1 — через Vercel Marketplace (проще):**
1. Зайди в [Vercel Marketplace](https://vercel.com/marketplace?category=storage&search=redis)
2. Установи Upstash Redis integration
3. Переменные `UPSTASH_REDIS_REST_URL` и `UPSTASH_REDIS_REST_TOKEN` добавятся автоматически

**Вариант 2 — вручную:**
1. Зарегистрируйся на [console.upstash.com](https://console.upstash.com)
2. Создай бесплатную Redis-базу (free tier: 10k запросов/день)
3. Скопируй `UPSTASH_REDIS_REST_URL` и `UPSTASH_REDIS_REST_TOKEN` из дашборда
4. Добавь их в Vercel env или в `.env` для локальной разработки

### Зачем Redis?

Vercel serverless functions — stateless. Каждый webhook-запрос может попасть в отдельный инстанс. Без внешнего хранилища фото, отправленное в одном запросе, будет потеряно к моменту `/done` в следующем.

## Команды бота

| Команда  | Описание                              |
|----------|---------------------------------------|
| `/start` | Приветствие и инструкция              |
| `/done`  | Обработать накопленные скриншоты      |
| `/clear` | Очистить буфер без обработки          |

## Формат вывода

Бот возвращает данные в формате, готовом для вставки в Google Таблицы:

```
передние тормозные диски	8500*2zfrussia\10800*2nibk
фильтр топливный	1190*1LYNX\1230*1Bosch\1310*1FILTRON
```

Разделитель между колонками — символ табуляции (`\t`). При вставке в Google Sheets данные автоматически разнесутся по ячейкам.
