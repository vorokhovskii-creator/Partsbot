import type { VercelRequest, VercelResponse } from "@vercel/node";
import { Telegraf, Context } from "telegraf";
import { GoogleGenerativeAI } from "@google/generative-ai";
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

export const bot = new Telegraf(BOT_TOKEN);
export const genAI = new GoogleGenerativeAI(GEMINI_KEY);

// ---------------------------------------------------------------------------
// In-memory state (resets on cold start — see README)
// ---------------------------------------------------------------------------

/** Per-chat buffer of Telegram file_id's awaiting /done */
const photoBuffers = new Map<number, string[]>();

/** Debounce timers for media-group batching */
const mediaGroupTimers = new Map<string, NodeJS.Timeout>();
const mediaGroupBatches = new Map<string, { chatId: number; fileIds: string[] }>();

/** Stores the last extracted plain text per chat so "copy" button can resend */
const lastResults = new Map<number, string>();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getBuffer(chatId: number): string[] {
  if (!photoBuffers.has(chatId)) photoBuffers.set(chatId, []);
  return photoBuffers.get(chatId)!;
}

function clearBuffer(chatId: number): void {
  photoBuffers.delete(chatId);
}

/** Download a Telegram photo by file_id and return base64 + mime */
async function downloadPhoto(fileId: string): Promise<{ base64: string; mimeType: string }> {
  // 1. getFile → file_path
  const fileRes = await fetch(
    `https://api.telegram.org/bot${BOT_TOKEN}/getFile?file_id=${fileId}`
  );
  const fileJson = (await fileRes.json()) as { ok: boolean; result?: { file_path?: string } };
  if (!fileJson.ok || !fileJson.result?.file_path) {
    throw new Error(`getFile failed for ${fileId}`);
  }

  // 2. Download binary
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

async function processWithGemini(fileIds: string[]): Promise<string> {
  // Download all photos in parallel
  const photos = await Promise.all(fileIds.map(downloadPhoto));

  const model = genAI.getGenerativeModel({
    model: "gemini-2.5-flash",
    systemInstruction: SYSTEM_PROMPT,
  });

  const imageParts = photos.map((p) => ({
    inlineData: { data: p.base64, mimeType: p.mimeType },
  }));

  const result = await model.generateContent([
    ...imageParts,
    { text: "Извлеки данные о запчастях со всех приложенных скриншотов." },
  ]);

  const response = result.response;
  const text = response.text();

  if (!text || text.trim().length === 0) {
    throw new Error("Gemini вернул пустой ответ");
  }

  return text.trim();
}

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

bot.command("clear", (ctx) => {
  const chatId = ctx.chat.id;
  const buf = getBuffer(chatId);
  const count = buf.length;
  clearBuffer(chatId);
  return ctx.reply(count > 0 ? `Буфер очищен (было ${count} фото).` : "Буфер и так пуст.");
});

bot.command("done", async (ctx) => {
  const chatId = ctx.chat.id;
  const buf = getBuffer(chatId);

  if (buf.length === 0) {
    return ctx.reply("Буфер пуст. Сначала отправь скриншоты.");
  }

  const fileIds = [...buf];
  clearBuffer(chatId);

  await ctx.reply(`Обрабатываю ${fileIds.length} фото через AI...`);

  try {
    const text = await processWithGemini(fileIds);
    lastResults.set(chatId, text);

    // Send formatted result with copy button
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
  }
});

// Handle "copy" callback
bot.action("copy_result", async (ctx) => {
  const chatId = ctx.chat?.id;
  if (!chatId) return ctx.answerCbQuery("Ошибка");

  await ctx.answerCbQuery("Скопировано!");

  const text = lastResults.get(chatId);
  if (text) {
    // Send as plain text so user can select & copy on desktop
    await ctx.reply(text);
  }
});

// Handle photo messages (single and album)
bot.on("photo", (ctx) => {
  const chatId = ctx.chat.id;
  const photos = ctx.message.photo;
  // Take the highest resolution (last element)
  const fileId = photos[photos.length - 1].file_id;
  const mediaGroupId = ctx.message.media_group_id;

  if (mediaGroupId) {
    // Album mode — debounce 500ms
    handleAlbumPhoto(chatId, mediaGroupId, fileId, ctx);
  } else {
    // Single photo
    const buf = getBuffer(chatId);
    buf.push(fileId);
    ctx.reply(`Фото добавлено (${buf.length}). Отправь ещё или нажми /done`);
  }
});

function handleAlbumPhoto(
  chatId: number,
  mediaGroupId: string,
  fileId: string,
  ctx: Context<Update.MessageUpdate<Message.PhotoMessage>>
): void {
  // Accumulate file IDs for this media group
  if (!mediaGroupBatches.has(mediaGroupId)) {
    mediaGroupBatches.set(mediaGroupId, { chatId, fileIds: [] });
  }
  mediaGroupBatches.get(mediaGroupId)!.fileIds.push(fileId);

  // Clear any existing timer for this group
  const existingTimer = mediaGroupTimers.get(mediaGroupId);
  if (existingTimer) clearTimeout(existingTimer);

  // Set debounce timer
  const timer = setTimeout(() => {
    const batch = mediaGroupBatches.get(mediaGroupId);
    if (batch) {
      const buf = getBuffer(batch.chatId);
      buf.push(...batch.fileIds);
      ctx.reply(`Фото добавлено (${buf.length}). Отправь ещё или нажми /done`);
    }
    // Cleanup
    mediaGroupBatches.delete(mediaGroupId);
    mediaGroupTimers.delete(mediaGroupId);
  }, 500);

  mediaGroupTimers.set(mediaGroupId, timer);
}

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
  // Always return 200 to Telegram regardless of internal errors
  try {
    if (req.method !== "POST") {
      res.status(200).json({ ok: true, method: req.method });
      return;
    }

    await ensureWebhook();

    // Process the update
    await bot.handleUpdate(req.body as Update);
  } catch (err) {
    console.error("Webhook handler error:", err);
  }

  res.status(200).json({ ok: true });
}
