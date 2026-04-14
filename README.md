# Partsbot — Telegram-бот для извлечения цен запчастей

Telegram-бот для автосервиса: принимает скриншоты с ценами запчастей, извлекает данные через Google Gemini Vision и форматирует для вставки в Google Таблицы.

## Стек

- **Runtime:** Node.js + TypeScript
- **Telegram:** Telegraf
- **AI:** Google Gemini 2.5 Flash (Vision)
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

## Ограничения

### Буфер фото хранится в памяти

Vercel serverless functions — stateless. Буфер фото (`Map` по `chat_id`) живёт только пока функция «тёплая». При холодном старте (после нескольких минут бездействия) буфер сбрасывается.

**На практике это значит:** если отправить фото, подождать 5-10 минут и нажать `/done` — буфер может оказаться пуст.

**Рекомендация для продакшена:** заменить `Map` на внешнее хранилище:
- [Vercel KV](https://vercel.com/docs/storage/vercel-kv) (Redis-совместимое, встроено в Vercel)
- Upstash Redis
- Любой внешний Redis

Замена минимальная — нужно переписать функции `getBuffer`, `clearBuffer` и хранение `lastResults` на async-обращения к KV.

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
