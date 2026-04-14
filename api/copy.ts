import type { VercelRequest, VercelResponse } from "@vercel/node";
import { Redis } from "@upstash/redis";

const redis = Redis.fromEnv();
const resultKey = (chatId: number) => `partsbot:result:${chatId}`;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const chatId = Number(req.query.id);
  if (!chatId || isNaN(chatId)) {
    res.status(400).send("Missing id");
    return;
  }

  const data = await redis.get<string>(resultKey(chatId));
  if (!data) {
    res.status(404).send("Результат не найден или устарел. Отправь /done заново.");
    return;
  }

  // Escape HTML
  const escaped = data
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

  const html = `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Partsbot — Копировать</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    background: #1a1a2e;
    color: #e0e0e0;
    padding: 20px;
    min-height: 100vh;
  }
  .container { max-width: 900px; margin: 0 auto; }
  h1 { font-size: 1.3rem; margin-bottom: 8px; color: #fff; }
  .hint { font-size: 0.85rem; color: #888; margin-bottom: 16px; }
  #data {
    background: #0d1117;
    border: 1px solid #333;
    border-radius: 8px;
    padding: 16px;
    font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace;
    font-size: 0.9rem;
    line-height: 1.6;
    white-space: pre;
    overflow-x: auto;
    tab-size: 4;
    -moz-tab-size: 4;
    cursor: text;
    user-select: all;
    -webkit-user-select: all;
  }
  .btn {
    display: inline-block;
    margin-top: 16px;
    padding: 12px 24px;
    background: #238636;
    color: #fff;
    border: none;
    border-radius: 6px;
    font-size: 1rem;
    cursor: pointer;
    transition: background 0.2s;
  }
  .btn:hover { background: #2ea043; }
  .btn.copied { background: #1a7f37; }
  .instructions {
    margin-top: 20px;
    padding: 12px 16px;
    background: #161b22;
    border: 1px solid #333;
    border-radius: 8px;
    font-size: 0.85rem;
    color: #999;
    line-height: 1.5;
  }
</style>
</head>
<body>
<div class="container">
  <h1>Результат Partsbot</h1>
  <p class="hint">Нажми кнопку ниже или выдели текст вручную (Ctrl+A в блоке, затем Ctrl+C)</p>
  <pre id="data">${escaped}</pre>
  <button class="btn" id="copyBtn" onclick="copyData()">Скопировать для Google Sheets</button>
  <div class="instructions">
    <strong>Как вставить:</strong><br>
    1. Нажми "Скопировать" выше<br>
    2. Открой Google Sheets<br>
    3. Выбери ячейку A1 (или нужную)<br>
    4. Ctrl+V (Cmd+V на Mac)<br>
    Названия попадут в столбец A, цены — в столбец B.
  </div>
</div>
<script>
async function copyData() {
  const el = document.getElementById('data');
  const btn = document.getElementById('copyBtn');
  try {
    await navigator.clipboard.writeText(el.textContent);
    btn.textContent = 'Скопировано!';
    btn.classList.add('copied');
    setTimeout(() => {
      btn.textContent = 'Скопировать для Google Sheets';
      btn.classList.remove('copied');
    }, 2000);
  } catch {
    // Fallback: select all text in pre block
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    document.execCommand('copy');
    btn.textContent = 'Скопировано!';
    btn.classList.add('copied');
  }
}
</script>
</body>
</html>`;

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.status(200).send(html);
}
