import type { VercelRequest, VercelResponse } from "@vercel/node";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { Redis } from "@upstash/redis";

// ---------------------------------------------------------------------------
// ENV
// ---------------------------------------------------------------------------

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN!;
const GEMINI_KEY = process.env.GEMINI_API_KEY!;
const WEBHOOK_URL = process.env.WEBHOOK_URL!;

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------

const genAI = new GoogleGenerativeAI(GEMINI_KEY);
const redis = Redis.fromEnv();

// ---------------------------------------------------------------------------
// Redis keys
// ---------------------------------------------------------------------------

const bufferKey = (chatId: number) => `partsbot:buffer:${chatId}`;
const resultKey = (chatId: number) => `partsbot:result:${chatId}`;

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

// ---------------------------------------------------------------------------
// Telegram API helpers (direct fetch, no framework)
// ---------------------------------------------------------------------------

async function tgApi(method: string, body: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  return json;
}

async function sendMessage(
  chatId: number,
  text: string,
  extra?: Record<string, unknown>
): Promise<void> {
  await tgApi("sendMessage", { chat_id: chatId, text, ...extra });
}

// ---------------------------------------------------------------------------
// Photo download
// ---------------------------------------------------------------------------

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
// Gemini
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
      console.log(`Gemini attempt ${attempt}/${maxAttempts} failed, retrying in ${delayMs}ms...`);
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

  return withRetry(async () => {
    const result = await model.generateContent([
      ...imageParts,
      { text: "Извлеки данные о запчастях со всех приложенных скриншотов." },
    ]);

    const t = result.response.text();
    if (!t || t.trim().length === 0) {
      throw new Error("Gemini вернул пустой ответ");
    }
    // Gemini may return literal "\t" instead of real tab characters
    return t.trim().replace(/\\t/g, "\t");
  });
}

// ---------------------------------------------------------------------------
// Update handler — process Telegram update synchronously before responding
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function handleUpdate(update: any): Promise<void> {
  // --- Message ---
  const msg = update.message;
  if (!msg) return;

  const chatId: number = msg.chat.id;
  const text: string | undefined = msg.text;

  // /start
  if (text === "/start") {
    await sendMessage(
      chatId,
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
    return;
  }

  // /clear
  if (text === "/clear") {
    const buf = await getBuffer(chatId);
    const count = buf.length;
    await clearBuffer(chatId);
    await sendMessage(
      chatId,
      count > 0 ? `Буфер очищен (было ${count} фото).` : "Буфер и так пуст."
    );
    return;
  }

  // /done
  if (text === "/done") {
    const fileIds = await popBuffer(chatId);
    console.log(`/done from ${chatId}: buffer had ${fileIds.length} photos`);

    if (fileIds.length === 0) {
      await sendMessage(chatId, "Буфер пуст. Сначала отправь скриншоты.");
      return;
    }

    await sendMessage(chatId, `Обрабатываю ${fileIds.length} фото через AI...`);

    try {
      const result = await processWithGemini(fileIds);
      await setLastResult(chatId, result);

      // Text preview with | separator for quick glance in chat
      const preview = result
        .split("\n")
        .map((line) => {
          const [name, prices] = line.split("\t");
          return prices ? `${name}  |  ${prices}` : line;
        })
        .join("\n");

      const copyUrl = `${WEBHOOK_URL}/api/copy?id=${chatId}`;

      await sendMessage(
        chatId,
        `Готово!\n\n${preview}\n\nДля вставки в Google Sheets:`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: "\u{1F4CB} Скопировать для Google Sheets", url: copyUrl }],
            ],
          },
        }
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Неизвестная ошибка";
      console.error("Gemini error:", message);
      await sendMessage(
        chatId,
        `Ошибка при обработке: ${message}\nПопробуй отправить фото заново.`
      );
    }
    return;
  }

  // Photo
  if (msg.photo && Array.isArray(msg.photo) && msg.photo.length > 0) {
    const fileId = msg.photo[msg.photo.length - 1].file_id;
    const newLen = await pushToBuffer(chatId, fileId);
    console.log(`Photo from ${chatId}: file_id=${fileId}, buffer now ${newLen}`);
    await sendMessage(chatId, `Фото добавлено (${newLen}). Отправь ещё или нажми /done`);
    return;
  }
}

// ---------------------------------------------------------------------------
// Vercel serverless handler
// ---------------------------------------------------------------------------

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    res.status(200).json({ ok: true });
    return;
  }

  try {
    await handleUpdate(req.body);
  } catch (err) {
    console.error("Webhook handler error:", err);
  }

  // Always 200 so Telegram doesn't retry
  res.status(200).json({ ok: true });
}
