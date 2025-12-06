/************************************************************
 OTT PULSE INDIA – Weekly OTT Digest Bot
 Author: ChatGPT (for MsquareDigitalHub)
*************************************************************/

process.env.TZ = "Asia/Kolkata";

// Imports
const { Telegraf } = require("telegraf");
const cron = require("node-cron");
const Parser = require("rss-parser");
const express = require("express");
const fetch = require("node-fetch");
const cheerio = require("cheerio");
const OpenAI = require("openai");

// Environment Vars (Render automatically injects these)
const BOT_TOKEN = process.env.BOT_TOKEN;
const GROUP_CHAT_ID = process.env.GROUP_CHAT_ID;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const WEBHOOK_URL = process.env.WEBHOOK_URL;

// Initialize
const bot = new Telegraf(BOT_TOKEN);
const app = express();
app.use(express.json());
const parser = new Parser();
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// ---------------------- WELCOME MESSAGE -----------------------

const WELCOME_MESSAGE = `
🎉 *Welcome to OTT Pulse India!*

Your weekly destination for curated OTT updates across  
Tamil, Telugu, Malayalam, Kannada, Hindi, English & Korean.

✨ What You Get:
• Weekly AI-curated OTT Digest  
• Top 12 Picks of the Week  
• AI Summary of OTT Trends  
• Title of The Week (with critic review)  
• Top 5 Cinema Headlines  

Stay updated. Stay entertained.  
*Powered by MsquareDigitalhub.com*
`;

// Send welcome message when new user joins
bot.on("new_chat_members", async (ctx) => {
  try {
    await ctx.reply(WELCOME_MESSAGE, { parse_mode: "Markdown" });
  } catch (e) {}
});

// ---------------------- BLOCK USER MESSAGES -----------------------

bot.on("message", async (ctx) => {
  const from = ctx.message.from;

  // Allow only admin to send commands
  if (ctx.message.text?.startsWith("/broadcast") && from.id == 206392794) {
    const text = ctx.message.text.replace("/broadcast", "").trim();
    if (text.length > 0) {
      await bot.telegram.sendMessage(GROUP_CHAT_ID, `📢 *Admin Broadcast*\n${text}`, {
        parse_mode: "Markdown",
      });
    }
    return;
  }

  // Block all other user messages
  if (!from.is_bot) {
    try {
      await bot.telegram.deleteMessage(ctx.chat.id, ctx.message.message_id);
    } catch (e) {}
  }
});

// ---------------------- RSS Sources -----------------------

const FEEDS = [
  { url: "https://www.filmibeat.com/rss/feeds/bollywood-fb.xml", lang: "Hindi" },
  { url: "https://www.filmibeat.com/rss/feeds/tamil-fb.xml", lang: "Tamil" },
  { url: "https://www.filmibeat.com/rss/feeds/telugu-fb.xml", lang: "Telugu" },
  { url: "https://www.filmibeat.com/rss/feeds/kannada-fb.xml", lang: "Kannada" },
  { url: "https://www.filmibeat.com/rss/feeds/malayalam-fb.xml", lang: "Malayalam" },
  { url: "https://www.filmibeat.com/rss/feeds/english-hollywood-fb.xml", lang: "English" },
  { url: "https://www.filmibeat.com/rss/feeds/korean-fb.xml", lang: "Korean" },
  { url: "https://www.filmibeat.com/rss/feeds/ott-fb.xml", lang: "Mixed" },
  { url: "https://www.filmibeat.com/rss/feeds/english-latest-web-series-fb.xml", lang: "English" },
];

// ---------------------- Helper Fetch Functions -----------------------

async function fetchArticle(url) {
  try {
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla" } });
    const html = await res.text();
    const $ = cheerio.load(html);
    const txt = $("article").text().replace(/\s+/g, " ").trim();
    return txt.slice(0, 4000);
  } catch {
    return "";
  }
}

async function aiExtractMovieInfo(summary, title, link) {
  const prompt = `
Extract movie/web-series details from this text.

Return JSON ONLY:
{
"title": "",
"cast": [],
"director": "",
"genre": [],
"synopsis": "",
"ott": "",
"score": 0-10
}

TEXT:
${summary}
`;

  try {
    const resp = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.1,
      messages: [{ role: "user", content: prompt }],
    });

    const json = JSON.parse(resp.choices[0].message.content);
    json.link = link;
    json.title = json.title || title;
    return json;
  } catch {
    return { title, cast: [], director: "", genre: [], synopsis: "", score: 0, link };
  }
}

// ---------------------- Core Movie Collector -----------------------

async function collectMovies() {
  let movies = [];

  for (const feed of FEEDS) {
    try {
      const rss = await parser.parseURL(feed.url);
      for (const item of rss.items.slice(0, 5)) {
        const articleText = await fetchArticle(item.link || "");
        const details = await aiExtractMovieInfo(articleText, item.title, item.link);
        details.lang = feed.lang;
        movies.push(details);
      }
    } catch (e) {}
  }

  // remove duplicates
  const unique = {};
  movies.forEach((m) => (unique[m.title] = m));
  return Object.values(unique);
}

// ---------------------- AI Ranking & Digest Builder -----------------------

async function buildDigest() {
  const movies = await collectMovies();

  const regions = movies.filter((m) => ["Hindi", "Tamil", "Telugu", "Kannada", "Malayalam"].includes(m.lang));
  const english = movies.filter((m) => m.lang === "English");
  const korean = movies.filter((m) => m.lang === "Korean");

  const topRegional = regions.sort((a, b) => b.score - a.score).slice(0, 6);
  const topEnglish = english.sort((a, b) => b.score - a.score).slice(0, 4);
  const topKorean = korean.sort((a, b) => b.score - a.score).slice(0, 2);

  const titleOfWeek = [...topRegional, ...topEnglish, ...topKorean].sort((a, b) => b.score - a.score)[0];

  // AI Summary
  const summaryPrompt = `
Create a short OTT summary for India including trends, language performance, OTT activity, and patterns.
Keep under 80 words.
Movies: ${JSON.stringify(topRegional.concat(topEnglish, topKorean))}
`;
  const summaryResp = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: summaryPrompt }],
  });
  const summary = summaryResp.choices[0].message.content;

  // Critic Review
  const criticPrompt = `
Write a 50-word international critic review for this title:
${JSON.stringify(titleOfWeek)}
`;
  const criticResp = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: criticPrompt }],
  });
  const critic = criticResp.choices[0].message.content;

  // Format Message
  let msg = `🎬 *OTT WEEKLY DIGEST*\n\n`;

  msg += `🔥 *Regional Top Picks (6)*\n`;
  topRegional.forEach((m, i) => (msg += `${i + 1}) *${m.title}* — ${m.genre.join(", ")}\n`));

  msg += `\n🌍 *English Picks (4)*\n`;
  topEnglish.forEach((m, i) => (msg += `${i + 1}) *${m.title}*\n`));

  msg += `\n🇰🇷 *Korean Picks (2)*\n`;
  topKorean.forEach((m, i) => (msg += `${i + 1}) *${m.title}*\n`));

  msg += `\n⭐ *Title of the Week*\n*${titleOfWeek.title}*\n${critic}\n`;

  msg += `\n🧠 *AI Summary:*\n${summary}\n`;

  return msg;
}

// ---------------------- Cron Job (Every 2 minutes for testing) -----------------------

cron.schedule("*/2 * * * *", async () => {
  try {
    const digest = await buildDigest();
    await bot.telegram.sendMessage(GROUP_CHAT_ID, digest, { parse_mode: "Markdown" });
  } catch (e) {
    console.log("Cron Error:", e.message);
  }
});

// ---------------------- Webhook for Render Hosting -----------------------

app.post("/bot", (req, res) => {
  bot.handleUpdate(req.body);
  res.sendStatus(200);
});

app.get("/", (req, res) => res.json({ status: "running" }));

app.listen(3000, async () => {
  if (WEBHOOK_URL) {
    await bot.telegram.setWebhook(WEBHOOK_URL + "/bot");
  }
  console.log("BOT RUNNING on Render...");
});
