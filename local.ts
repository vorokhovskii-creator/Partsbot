import { bot } from "./api/webhook";

console.log("Starting bot in polling mode...");

bot.launch().then(() => {
  console.log("Bot is running!");
}).catch((err) => {
  console.error("Failed to launch bot:", err);
});

// Enable graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
