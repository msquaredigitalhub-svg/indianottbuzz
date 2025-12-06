/**********************************************************************
 OTT PULSE INDIA – Weekly OTT Digest Bot
 Author: ChatGPT (for MsquareDigitalHub)
**********************************************************************/

process.env.TZ = "Asia/Kolkata";

/* ===================== Imports ====================== */
const { Telegraf } = require("telegraf");
const cron = require("node-cron");
const Parser = require("rss-parser");
const express = require("express");
const fetch = require("node-fetch");
const cheerio = require("cheerio");
const OpenAI = require("openai");

/* ===================== ENV (Render injects these) ====================== */
const BOT_TOKEN = process.env.BOT_TOKEN;
const GROUP_CHAT_ID = process.env.GROUP_CHAT_ID; 
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const WEBHOOK_URL = process.env.WEBHOOK_URL;

const bot = new Telegraf(BOT_TOKEN);
const app = express();
app.use(express.json());

// AI Client
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// RSS Parser
const parser = new Parser({
  headers: { "User-Agent": "Mozilla/5.0" },
});

/* ===================== FILMIBEAT FEEDS ====================== */
const FEEDS = {
  regional: [
    "https://www.filmibeat.com/rss/feeds/bollywood-fb.xml",
    "https://www.filmibeat.com/rss/feeds/tamil-fb.xml",
    "https://www.filmibeat.com/rss/feeds/telugu-fb.xml",
    "https://www.filmibeat.com/rss/feeds/kannada-fb.xml",
    "https://www.filmibeat.com/rss/feeds/malayalam-fb.xml"
  ],
  english: [
    "https://www.filmibeat.com/rss/feeds/english-hollywood-fb.xml"
  ],
  korean: [
    "https://www.filmibeat.com/rss/feeds/korean-fb.xml"
  ],
  headlines: [
    "https://www.filmibeat.com/rss/feeds/interviews-fb.xml",
    "https://www.filmibeat.com/rss/feeds/english-viral-fb.xml",
    "https://www.filmibeat.com/rss/feeds/ott-fb.xml"
  ]
};

/* ===================== FETCH ARTICLE TEXT ====================== */
async function fetchArticle(url) {
  try {
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    const html = await res.text();
    const $ = cheerio.load(html);
    return $("article").text().replace(/\s+/g, " ").trim().slice(0, 4000);
  } catch (e) {
    return "";
  }
}

/* ===================== AI METADATA EXTRACTION ====================== */
async function aiExtract(title, snippet, article) {
  try {
    const msg = `
Extract: Title, Cast, Director, Genre, OTT Platform, 2-line synopsis.
Return JSON only.
Title: ${title}
Snippet: ${snippet}
Article: ${article}
`;

    const aiResp = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "Extract clean metadata for Indian OTT users. JSON only." },
        { role: "user", content: msg }
      ]
    });

    return JSON.parse(aiResp.choices[0].message.content);
  } catch {
    return { title, synopsis: snippet };
  }
}

/* ===================== LOAD ALL MOVIES ====================== */
async function loadAllMovies() {
  let movies = [];

  const loadFromFeed = async (url, lang) => {
    try {
      const rss = await parser.parseURL(url);
      for (const item of rss.items.slice(0, 10)) {
        const article = await fetchArticle(item.link || "");
        const meta = await aiExtract(item.title, item.contentSnippet || "", article);
        movies.push({ lang, ...meta, link: item.link });
        await new Promise(res => setTimeout(res, 300));
      }
    } catch (e) {}
  };

  for (const url of FEEDS.regional) await loadFromFeed(url, "regional");
  for (const url of FEEDS.english) await loadFromFeed(url, "english");
  for (const url of FEEDS.korean) await loadFromFeed(url, "korean");

  return movies;
}

/* ===================== RANK & SELECT ====================== */
function pickTop(movies, lang, count) {
  const filtered = movies.filter(m => m.lang === lang);
  return filtered.slice(0, count);
}

/* ===================== AI SUMMARY + TITLE OF WEEK ====================== */
async function aiSummaryAndReview(all12) {
  const prompt = `
Choose best title out of these. Then write:
1) 50-word critic review (international critic tone)
2) 4-line weekly summary
Return in JSON.
Movies: ${JSON.stringify(all12)}
`;

  const res = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: "You are a professional OTT analyst." },
      { role: "user", content: prompt }
    ]
  });

  return JSON.parse(res.choices[0].message.content);
}

/* ===================== TOP HEADLINES ====================== */
async function getTopHeadlines() {
  let headlines = [];
  for (const url of FEEDS.headlines) {
    try {
      const rss = await parser.parseURL(url);
      headlines.push(...rss.items.slice(0, 2).map(i => i.title));
    } catch {}
  }
  return headlines.slice(0, 5);
}

/* ===================== FORMAT MESSAGE ====================== */
function formatMessage({ regional, english, korean, critic, summary, headlines }) {
  let txt = `📅 *WEEKLY OTT DIGEST – INDIA*\n\n`;

  txt += `🔥 *Top Regional Picks* (6)\n`;
  regional.forEach(m => {
    txt += `• *${m.title}* — ${m.genre || ""}\n`;
  });

  txt += `\n🌍 *Top English Picks* (4)\n`;
  english.forEach(m => {
    txt += `• *${m.title}* — ${m.genre || ""}\n`;
  });

  txt += `\n🇰🇷 *Top Korean Picks* (2)\n`;
  korean.forEach(m => {
    txt += `• *${m.title}*\n`;
  });

  txt += `\n⭐ *Title of the Week*: *${critic.title}*\n`;
  txt += `${critic.review}\n`;

  txt += `\n🧠 *AI Summary*\n${summary}\n`;

  txt += `\n📰 *Top 5 Headlines*\n`;
  headlines.forEach(h => (txt += `• ${h}\n`));

  txt += `\nPowered by *MsquareDigitalHub.com*`;

  return txt;
}

/* ===================== BROADCAST JOB ====================== */
async function runDigest() {
  console.log("Running 2-min digest generation…");

  const movies = await loadAllMovies();
  const regional = pickTop(movies, "regional", 6);
  const english = pickTop(movies, "english", 4);
  const korean = pickTop(movies, "korean", 2);

  const all12 = [...regional, ...english, ...korean].slice(0, 12);
  const critic = await aiSummaryAndReview(all12);
  const headlines = await getTopHeadlines();

  const msg = formatMessage({
    regional,
    english,
    korean,
    critic,
    summary: critic.summary,
    headlines
  });

  await bot.telegram.sendMessage(GROUP_CHAT_ID, msg, { parse_mode: "Markdown" });
}

/* ===================== CRON (Every 2 Minutes For Testing) ====================== */
cron.schedule("*/2 * * * *", runDigest);

/* ===================== WEBHOOK ====================== */
app.post("/bot", (req, res) => {
  bot.handleUpdate(req.body);
  res.sendStatus(200);
});

bot.telegram.setWebhook(WEBHOOK_URL + "/bot");

/* ===================== START SERVER ====================== */
app.listen(3000, () => console.log("Bot running on Port 3000"));

