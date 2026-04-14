import type { VercelRequest, VercelResponse } from "@vercel/node";
import { Telegraf, Context } from "telegraf";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { Redis } from "@upstash/redis";
import { Update, Message } from "telegraf/types";

// ---------------------------------------------------------------------------
// ENV
// ---------------------------------------------------------------------------

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN!;
const GEMINI_KEY = process.env.GEMINI_API_KEY!;
const WEBHOOK_URL = process.env.WEBHOOK_URL!;

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------

const bot = new Telegraf(BOT_TOKEN);
const genAI = new GoogleGenerativeAI(GEMINI_KEY);
const redis = Redis.fromEnv(); // uses UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN

// ---------------------------------------------------------------------------
// Redis keys
// ---------------------------------------------------------------------------

const bufferKey = (chatId: number) => `partsbot:buffer:${chatId}`;
const resultKey = (chatId: number) => `partsbot:result:${chatId}`;
const lockKey = (chatId: number) => `partsbot:lock:${chatId}`;

// TTL for stored data (1 hour — more than enough for a session)
const TTL_SECONDS = 3600;

// ---------------------------------------------------------------------------
// Buffer helpers (Redis-backed)
// ---------------------------------------------------------------------------

async function getBuffer(chatId: number): Promise<string[]> {
  const data = await redis.get<string[]>(bufferKey(chatId));
  return data ?? [];
}

async function pushToBuffer(chatId: number, ...fileIds: string[]): Promise<number> {
  const buf = await getBuffer(chatId);
  buf.push(...fileIds);
  await redis.set(bufferKey(chatId), buf, { ex: TTL_SECONDS });
  return buf.length;
}

async function clearBuffer(chatId: number): Promise<void> {
  await redis.del(bufferKey(chatId));
}

async function popBuffer(chatId: number): Promise<string[]> {
  const buf = await getBuffer(chatId);
  await redis.del(bufferKey(chatId));
  return buf;
}

async function setLastResult(chatId: number, text: string): Promise<void> {
  await redis.set(resultKey(chatId), text, { ex: TTL_SECONDS });
}

async function getLastResult(chatId: number): Promise<string | null> {
  return redis.get<string>(resultKey(chatId));
}

// Simple lock to prevent double-processing of /done
async function acquireLock(chatId: number): Promise<boolean> {
  const result = await redis.set(lockKey(chatId), "1", { nx: true, ex: 30 });
  return result === "OK";
}

async function releaseLock(chatId: number): Promise<void> {
  await redis.del(lockKey(chatId));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Download a Telegram photo by file_id and return base64 + mime */
async function downloadPhoto(fileId: string): Promise<{ base64: string; mimeType: string }> {
  const fileRes = await fetch(
    `https://api.telegram.org/bot${BOT_TOKEN}/getFile?file_id=${fileId}`
  );
  const fileJson = (await fileRes.json()) as { ok: boolean; result?: { file_path?: string } };
  if (!fileJson.ok || !fileJson.result?.file_path) {
    throw new Error(`getFile failed for ${fileId}`);
  }

  const downloadUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${fileJson.result.file_path}`;
  const imgRes = await fetch(downloadUrl);
  if (!imgRes.ok) throw new Error(`Failed to download file: ${imgRes.status}`);

  const arrayBuf = await imgRes.arrayBuffer();
  const base64 = Buffer.from(arrayBuf).toString("base64");

  return { base64, mimeType: "image/jpeg" };
}

// ---------------------------------------------------------------------------
// Gemini system prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `Ты помощник автомеханика. Твоя задача — извлечь информацию о запчастях со скриншотов (сайты поставщиков или программа закупки) и отформатировать в строго заданный вид для Google Таблиц.

ФОРМАТ ВЫВОДА:
Одна строка на каждую уникальную запчасть.
Каждая строка: [название запчасти]\\t[варианты через \\]

Каждый вариант цены: ЦЕНА*КОЛ-ВОПоставщикИлиБренд
- ЦЕНА — розничная цена в рублях, только цифры без пробелов и знака ₽
- КОЛ-ВО — количество (если не указано — 1)
- ПоставщикИлиБренд — краткое название без пробелов (zfrussia, nibk, Bosch, FILTRON и т.п.)

ПРИМЕР ВЫВОДА (разделитель между колонками — Tab):
передние тормозные диски\t8500*2zfrussia\\10800*2nibk
фильтр топливный\t1190*1LYNX\\1230*1Bosch\\1310*1FILTRON\\2020*1EUROREPAR\\3230*1MANN

ПРАВИЛА:
- Бери ТОЛЬКО розничную цену (не закупочную/себестоимость)
- Если видны колонки "Цена розница" и "Цена закупочная" — бери "Цена розница"
- Если скриншот с сайта поставщика — бери указанную цену как есть
- Включай ВСЕ варианты поставщиков/брендов со скриншота
- Убирай пробелы и знак ₽ из цен
- Только строки в указанном формате, без пояснений и вступлений
- Несколько разных запчастей на одном скриншоте — каждую отдельной строкой
- Разделитель между названием и ценами — строго символ табуляции (\\t)`;

// ---------------------------------------------------------------------------
// Gemini call
// ---------------------------------------------------------------------------

/** Retry helper for transient errors (503, 429, network) */
async function withRetry<T>(fn: () => Promise<T>, maxAttempts = 4): Promise<T> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const isRetryable =
        message.includes("503") ||
        message.includes("429") ||
        message.includes("Service Unavailable") ||
        message.includes("overloaded") ||
        message.includes("high demand") ||
        message.includes("RESOURCE_EXHAUSTED");

      if (!isRetryable || attempt === maxAttempts) throw err;

      const delayMs = 3000 * attempt;
      console.log(`Gemini attempt ${attempt} failed (${message}), retrying in ${delayMs}ms...`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw new Error("Unreachable");
}

async function processWithGemini(fileIds: string[]): Promise<string> {
  const photos = await Promise.all(fileIds.map(downloadPhoto));

  const model = genAI.getGenerativeModel({
    model: "gemini-2.5-flash",
    systemInstruction: SYSTEM_PROMPT,
  });

  const imageParts = photos.map((p) => ({
    inlineData: { data: p.base64, mimeType: p.mimeType },
  }));

  const text = await withRetry(async () => {
    const result = await model.generateContent([
      ...imageParts,
      { text: "Извлеки данные о запчастях со всех приложенных скриншотов." },
    ]);

    const response = result.response;
    const t = response.text();

    if (!t || t.trim().length === 0) {
      throw new Error("Gemini вернул пустой ответ");
    }

    return t.trim();
  });

  return text;
}

// ---------------------------------------------------------------------------
// Album debounce (in-memory is OK here — only within a single invocation)
// ---------------------------------------------------------------------------

const mediaGroupTimers = new Map<string, NodeJS.Timeout>();
const mediaGroupBatches = new Map<string, { chatId: number; fileIds: string[] }>();

// ---------------------------------------------------------------------------
// Bot handlers
// ---------------------------------------------------------------------------

bot.start((ctx) => {
  return ctx.reply(
    "Привет! Я помогу извлечь цены запчастей со скриншотов.\n\n" +
      "Как пользоваться:\n" +
      "1. Отправь один или несколько скриншотов с ценами\n" +
      "2. Я подтвержу получение каждого фото\n" +
      "3. Когда все фото отправлены — нажми /done\n" +
      "4. Я обработаю их через AI и выдам таблицу для вставки в Google Sheets\n\n" +
      "Команды:\n" +
      "/done — обработать накопленные скриншоты\n" +
      "/clear — очистить буфер без обработки"
  );
});

bot.command("clear", async (ctx) => {
  const chatId = ctx.chat.id;
  const buf = await getBuffer(chatId);
  const count = buf.length;
  await clearBuffer(chatId);
  return ctx.reply(count > 0 ? `Буфер очищен (было ${count} фото).` : "Буфер и так пуст.");
});

bot.command("done", async (ctx) => {
  const chatId = ctx.chat.id;

  // Prevent double-processing if Telegram retries or user taps twice
  const locked = await acquireLock(chatId);
  if (!locked) {
    return ctx.reply("Уже обрабатываю, подожди...");
  }

  try {
    const fileIds = await popBuffer(chatId);

    if (fileIds.length === 0) {
      return ctx.reply("Буфер пуст. Сначала отправь скриншоты.");
    }

    await ctx.reply(`Обрабатываю ${fileIds.length} фото через AI...`);

    const text = await processWithGemini(fileIds);
    await setLastResult(chatId, text);

    await ctx.reply(`\`\`\`\n${text}\n\`\`\``, {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [{ text: "✅ Скопировать", callback_data: "copy_result" }],
        ],
      },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Неизвестная ошибка";
    console.error("Gemini error:", message);
    await ctx.reply(`Ошибка при обработке: ${message}\nПопробуй отправить фото заново.`);
  } finally {
    await releaseLock(chatId);
  }
});

// Handle "copy" callback
bot.action("copy_result", async (ctx) => {
  const chatId = ctx.chat?.id;
  if (!chatId) return ctx.answerCbQuery("Ошибка");

  await ctx.answerCbQuery("Скопировано!");

  const text = await getLastResult(chatId);
  if (text) {
    await ctx.reply(text);
  }
});

// Handle photo messages (single and album)
bot.on("photo", async (ctx) => {
  const chatId = ctx.chat.id;
  const photos = ctx.message.photo;
  const fileId = photos[photos.length - 1].file_id;
  const mediaGroupId = ctx.message.media_group_id;

  if (mediaGroupId) {
    // Album mode — debounce 500ms
    // In-memory batch is fine here: all photos in an album arrive
    // as separate webhooks but typically hit the same warm instance
    // within milliseconds. If they don't, each photo is saved individually.
    if (!mediaGroupBatches.has(mediaGroupId)) {
      mediaGroupBatches.set(mediaGroupId, { chatId, fileIds: [] });
    }
    mediaGroupBatches.get(mediaGroupId)!.fileIds.push(fileId);

    const existingTimer = mediaGroupTimers.get(mediaGroupId);
    if (existingTimer) clearTimeout(existingTimer);

    const timer = setTimeout(async () => {
      try {
        const batch = mediaGroupBatches.get(mediaGroupId);
        if (batch) {
          const newLen = await pushToBuffer(batch.chatId, ...batch.fileIds);
          await ctx.reply(`Фото добавлено (${newLen}). Отправь ещё или нажми /done`);
        }
      } catch (e) {
        console.error("Album batch error:", e);
      } finally {
        mediaGroupBatches.delete(mediaGroupId);
        mediaGroupTimers.delete(mediaGroupId);
      }
    }, 500);

    mediaGroupTimers.set(mediaGroupId, timer);
  } else {
    // Single photo — save to Redis immediately
    const newLen = await pushToBuffer(chatId, fileId);
    await ctx.reply(`Фото добавлено (${newLen}). Отправь ещё или нажми /done`);
  }
});

// ---------------------------------------------------------------------------
// Webhook setup (runs once per cold start)
// ---------------------------------------------------------------------------

let webhookSet = false;

async function ensureWebhook(): Promise<void> {
  if (webhookSet) return;
  try {
    await bot.telegram.setWebhook(`${WEBHOOK_URL}/api/webhook`);
    webhookSet = true;
    console.log("Webhook set:", `${WEBHOOK_URL}/api/webhook`);
  } catch (err) {
    console.error("Failed to set webhook:", err);
  }
}

// ---------------------------------------------------------------------------
// Vercel serverless handler
// ---------------------------------------------------------------------------

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    if (req.method !== "POST") {
      res.status(200).json({ ok: true, method: req.method });
      return;
    }

    await ensureWebhook();
    await bot.handleUpdate(req.body as Update);
  } catch (err) {
    console.error("Webhook handler error:", err);
  }

  res.status(200).json({ ok: true });
}
