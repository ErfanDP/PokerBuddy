import express from "express";
import { Telegraf } from "telegraf";

const token = process.env.TELEGRAM_TOKEN;
if (!token) {
  console.error("Missing TELEGRAM_TOKEN");
  process.exit(1);
}

const bot = new Telegraf(token);

// Simple command/handler
bot.command("start", (ctx) => ctx.reply("Hello from Render!"));
bot.on("text", (ctx) => ctx.reply(`You said: ${ctx.message.text}`));

// Express app for webhook
const app = express();
app.use(express.json());

// IMPORTANT: unique path that includes the token (recommended)
const secretPath = `/webhook/${token}`;

// Telegram will post updates here
app.post(secretPath, (req, res) => {
  bot.handleUpdate(req.body, res).then(() => {
    // Telegraf handles the response internally if needed
    res.status(200).end();
  }).catch(() => res.status(200).end());
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`);

  // Optional: remove any old webhook and set the new one
  const host = process.env.RENDER_EXTERNAL_URL || `https://YOUR_SERVICE.onrender.com`;
  const url = `${host}${secretPath}`;
  try {
    await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url })
    });
    console.log("Webhook set to:", url);
  } catch (e) {
    console.error("Failed to set webhook automatically. You can set it manually later.");
  }
});

// (If you ever want to run locally with polling: bot.launch(); but don't mix with webhooks)
