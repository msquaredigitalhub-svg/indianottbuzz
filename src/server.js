/**************************************************************
 OTT PULSE INDIA — Weekly OTT Digest Bot (Crash-proof single file)
 Author: ChatGPT for MsquareDigitalhub
 Notes:
 - Cron: every 2 minutes (testing)
 - Posts ONLY to group (no DMs)
 - Optional OpenAI enrichment (if OPENAI_API_KEY present)
 - Defensively coded to avoid crashes
**************************************************************/

// Set timezone for cron and date formatting
process.env.TZ = process.env.TZ || "Asia/Kolkata";

// Core imports (required)
const express = require("express");
const { Telegraf } = require("telegraf");
const cron = require("node-cron");
const Parser = require("rss-parser");
const path = require("path");
const fs = require("fs");

// Optional imports — load safely
let fetch = null;
let cheerio = null;
let OpenAI = null;
try {
  fetch = require("node-fetch"); // optional: used for HTML fetch
} catch (e) {
  console.warn("Optional module 'node-fetch' not installed — article fetching will be basic.");
}
try {
  cheerio = require("cheerio"); // optional: used to extract article text
} catch (e) {
  console.warn("Optional module 'cheerio' not installed — article parsing will be basic.");
}
try {
  OpenAI = require("openai"); // optional: OpenAI client for enrichment
} catch (e) {
  console.warn("Optional module 'openai' not installed — AI enrichment disabled.");
}

// lowdb v7 usage (file-based JSON db)
const { Low } = (() => {
  try {
    return require("lowdb");
  } catch (e) {
    console.error("Missing required dependency 'lowdb'. Install it in package.json.");
    process.exit(1);
  }
})();
const { JSONFile } = (() => {
  try {
    return require("lowdb/node");
  } catch (e) {
    console.error("Missing required dependency 'lowdb/node'. Install it in package.json.");
    process.exit(1);
  }
})();

// env
require("dotenv").config();
const BOT_TOKEN = process.env.BOT_TOKEN || "";
const GROUP_CHAT_ID_ENV = process.env.GROUP_CHAT_ID || "";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const WEBHOOK_URL = process.env.WEBHOOK_URL || "";
const ADMIN_ID_ENV = process.env.ADMIN_ID || "";
const WELCOME_MESSAGE = process.env.WELCOME_MESSAGE || `🎉 Welcome to OTT Pulse India!

You're in the official channel for weekly AI-curated OTT updates across Tamil, Telugu, Malayalam, Kannada, Hindi, English & Korean.

What's here:
• Weekly curated OTT Digest (Top 12: 6 regional, 4 English, 2 Korean)
• Title of the Week (50-word critic review)
• AI summary & Top 5 headlines
• Hype meter and upcoming OTT calendar

Powered by MsquareDigitalhub.com`;

if (!BOT_TOKEN) {
  console.error("ERROR: BOT_TOKEN is not set in environment. Exiting.");
  process.exit(1);
}

// instantiate parser and express
const parser = new Parser();
const app = express();
app.use(express.json());

// DB setup
const DB_FILE = path.join(process.cwd(), "db.json");
const adapter = new JSONFile(DB_FILE);
const db = new Low(adapter);

async function initDB() {
  try {
    await db.read();
    db.data = db.data || { users: {}, adminId: null, groupId: null, lastRun: null };
    // ensure keys exist
    db.data.users = db.data.users || {};
    await db.write();
    console.log("✓ DB initialized:", DB_FILE);
  } catch (e) {
    console.error("✗ DB initialization error:", e?.message || e);
    // Try to create file with defaults
    try {
      fs.writeFileSync(DB_FILE, JSON.stringify({ users: {}, adminId: null, groupId: null, lastRun: null }, null, 2));
      db.data = { users: {}, adminId: null, groupId: null, lastRun: null };
      console.log("✓ DB file created with defaults");
    } catch (err) {
      console.error("✗ Failed to create DB file:", err?.message || err);
      process.exit(1);
    }
  }
}

// Telegraf bot
const bot = new Telegraf(BOT_TOKEN);

// Helper: safe function wrapper
function safeRun(fn, label = "task") {
  return async (...args) => {
    try {
      await fn(...args);
    } catch (e) {
      console.error(`✗ Unhandled error in ${label}:`, e?.message || e);
    }
  };
}

// Optional OpenAI client
let openaiClient = null;
if (OPENAI_API_KEY && OpenAI) {
  try {
    openaiClient = new OpenAI.OpenAI({ apiKey: OPENAI_API_KEY });
    console.log("✓ OpenAI client initialized (enrichment enabled)");
  } catch (e) {
    console.warn("⚠ OpenAI initialization error — enrichment disabled:", e.message || e);
    openaiClient = null;
  }
} else {
  console.log("ℹ OpenAI enrichment disabled (no key or client library).");
}

// Filmibeat RSS feeds recommended
const FEEDS = [
  { url: "https://www.filmibeat.com/rss/feeds/filmibeat-fb.xml", lang: "Multi" },
  { url: "https://www.filmibeat.com/rss/feeds/bollywood-fb.xml", lang: "Hindi" },
  { url: "https://www.filmibeat.com/rss/feeds/tamil-fb.xml", lang: "Tamil" },
  { url: "https://www.filmibeat.com/rss/feeds/tamil-reviews-fb.xml", lang: "Tamil" },
  { url: "https://www.filmibeat.com/rss/feeds/telugu-fb.xml", lang: "Telugu" },
  { url: "https://www.filmibeat.com/rss/feeds/kannada-fb.xml", lang: "Kannada" },
  { url: "https://www.filmibeat.com/rss/feeds/malayalam-fb.xml", lang: "Malayalam" },
  { url: "https://www.filmibeat.com/rss/feeds/english-hollywood-fb.xml", lang: "English" },
  { url: "https://www.filmibeat.com/rss/feeds/english-latest-web-series-fb.xml", lang: "English" },
  { url: "https://www.filmibeat.com/rss/feeds/ott-fb.xml", lang: "Multi" },
  { url: "https://www.filmibeat.com/rss/feeds/korean-fb.xml", lang: "Korean" }
];

// safe fetch article text (uses optional fetch + cheerio)
async function fetchArticleTextSafe(url) {
  try {
    if (!fetch) return "";
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, timeout: 15000 });
    if (!res.ok) return "";
    const html = await res.text();
    if (cheerio) {
      const $ = cheerio.load(html);
      // try a few selectors commonly used on Filmibeat
      const selectors = ["article", ".article-content", ".content", ".story", "#article-body"];
      for (const sel of selectors) {
        const el = $(sel);
        if (el && el.text().trim().length > 200) {
          return el.text().replace(/\s+/g, " ").trim();
        }
      }
      // fallback whole body
      return $("body").text().replace(/\s+/g, " ").trim().slice(0, 32000);
    } else {
      // fallback: return first 800 chars of html (less ideal)
      return html.slice(0, 32000);
    }
  } catch (e) {
    console.warn("⚠ fetchArticleTextSafe failed:", e?.message || e);
    return "";
  }
}

// basic heuristic dedupe-normalize
function normalizeTitle(t) {
  if (!t) return "";
  return t.replace(/\s+–.*$/,"").replace(/\s+—.*$/,"").replace(/\|.*$/,"").trim().toLowerCase();
}

// AI enrichment function — best-effort and defensive
async function enrichWithAI(item) {
  // item: {title, link, snippet}
  if (!openaiClient) {
    // enrichment disabled — return minimal structure
    return {
      title: item.title || "",
      cast: [],
      director: "",
      genre: [],
      short_synopsis: item.snippet || "",
      source_url: item.link || "",
      confidence: 0
    };
  }

  // Build a compact prompt asking for JSON only
  const sys = "You extract movie/web-series metadata from an article snippet. Return ONLY valid JSON with fields: title, cast (array), director, genre (array), short_synopsis (1-2 sentences), source_url, confidence (0-1).";
  const user = `Title: ${item.title}\nURL: ${item.link}\nSnippet/Article: ${item.snippet || ""}\n\nReturn the JSON object. If you are unsure, use empty arrays/strings and set confidence accordingly.`;

  try {
    // Use chat completions endpoint (gpt-4o-mini or default)
    const resp = await openaiClient.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: sys },
        { role: "user", content: user }
      ],
      temperature: 0.0,
      max_tokens: 400
    });

    const text = resp?.choices?.[0]?.message?.content || "";
    // extract JSON substring
    const idx = text.indexOf("{");
    const jsonText = idx >= 0 ? text.slice(idx) : text;
    try {
      const data = JSON.parse(jsonText);
      data.title = data.title || item.title || "";
      data.source_url = data.source_url || item.link || "";
      return data;
    } catch (e) {
      console.warn("⚠ OpenAI returned non-JSON or parsing failed; falling back to snippet. Raw:", text.slice(0,300));
      return {
        title: item.title || "",
        cast: [],
        director: "",
        genre: [],
        short_synopsis: item.snippet || "",
        source_url: item.link || "",
        confidence: 0
      };
    }
  } catch (e) {
    console.warn("⚠ OpenAI call failed:", e?.message || e);
    return {
      title: item.title || "",
      cast: [],
      director: "",
      genre: [],
      short_synopsis: item.snippet || "",
      source_url: item.link || "",
      confidence: 0
    };
  }
}

// collect from RSS with safe parsing and de-dup
async function collectMoviesFromFeeds(limitPerFeed = 6) {
  const results = {}; // key = normalizedTitle -> info
  for (const feed of FEEDS) {
    try {
      const rss = await parser.parseURL(feed.url).catch(err => { throw new Error(`RSS fetch failed: ${err?.message || err}`); });
      const items = Array.isArray(rss.items) ? rss.items.slice(0, limitPerFeed) : [];
      for (const item of items) {
        const titleRaw = item.title || item.title?.trim?.() || "";
        if (!titleRaw) continue;
        const norm = normalizeTitle(titleRaw);
        if (!norm) continue;
        if (results[norm]) continue; // dedupe
        // quick filter for OTT/webseries terms (soft)
        const combined = `${titleRaw} ${item.contentSnippet || ""}`.toLowerCase();
        // We still include broadly; the AI later picks the best of them.
        const snippet = (item.contentSnippet || "").slice(0, 1000);
        const link = item.link || "";
        // fetch article text (best effort)
        let articleText = "";
        try {
          articleText = await fetchArticleTextSafe(link);
        } catch (e) {
          articleText = snippet;
        }
        // attempt enrichment (best effort)
        const aiData = await enrichWithAI({ title: titleRaw, link, snippet: articleText || snippet });
        // store minimal reliable structure — prefer AI fields if present
        results[norm] = {
          title: aiData.title || titleRaw,
          link: aiData.source_url || link,
          lang: feed.lang || "Multi",
          cast: Array.isArray(aiData.cast) ? aiData.cast : [],
          director: aiData.director || "",
          genre: Array.isArray(aiData.genre) ? aiData.genre : [],
          short_synopsis: aiData.short_synopsis || snippet || "",
          pubDate: item.pubDate || new Date().toISOString(),
          confidence: typeof aiData.confidence === "number" ? aiData.confidence : 0
        };
      }
    } catch (e) {
      console.warn(`⚠ Failed to parse feed ${feed.url}:`, e?.message || e);
      continue;
    }
  }
  return results;
}

// ranking & selection: pick 6 regional + 4 english + 2 korean
function pickTop12(allItemsMap) {
  const items = Object.values(allItemsMap);
  // simple scoring heuristic: confidence + recency
  const scored = items.map(it => {
    const ageHours = Math.max(0, (Date.now() - (new Date(it.pubDate || Date.now())).getTime()) / 3600000);
    const score = (it.confidence || 0) * 0.7 + Math.max(0, 1 - ageHours / 168) * 0.3;
    return { ...it, score };
  });
  // group by language categories for selection
  const regionalLangs = ["Tamil", "Telugu", "Malayalam", "Kannada", "Hindi"];
  const regionalPool = scored.filter(s => regionalLangs.includes(s.lang));
  const englishPool = scored.filter(s => s.lang === "English");
  const koreanPool = scored.filter(s => s.lang === "Korean");

  // sort descending by score then by date
  const sortFn = (a,b) => (b.score - a.score) || (new Date(b.pubDate) - new Date(a.pubDate));
  regionalPool.sort(sortFn);
  englishPool.sort(sortFn);
  koreanPool.sort(sortFn);

  // pick top counts, but ensure fallback messaging if not enough
  const regionalPick = regionalPool.slice(0, 6);
  const englishPick = englishPool.slice(0, 4);
  const koreanPick = koreanPool.slice(0, 2);

  return {
    regional: regionalPick,
    english: englishPick,
    korean: koreanPick
  };
}

// Generate 50-word critic review for "title of the week" — uses AI if available, else short fallback
async function generateCriticReview(item) {
  if (!item) return "";
  if (!openaiClient) {
    // fallback: short synthetic critic-ish line (no AI)
    const s = `${item.title} — ${item.genre?.[0] || "Genre"}: ${item.short_synopsis || "An interesting new release."}`;
    return (s.length > 250) ? s.slice(0,250) : s;
  }

  try {
    const prompt = `You are an international film critic. Write an honest, spoiler-free, 50-word review in the tone of a respected international critic for this title: "${item.title}". Use concise language, single paragraph, avoid spoilers. Include final judgement in one short sentence.`;
    const resp = await openaiClient.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "You are an international film critic." },
        { role: "user", content: prompt }
      ],
      temperature: 0.45,
      max_tokens: 120
    });
    const text = resp?.choices?.[0]?.message?.content || "";
    // ensure approx 50 words: trim if longer
    const words = text.split(/\s+/).filter(Boolean);
    return words.slice(0, 55).join(" ");
  } catch (e) {
    console.warn("⚠ Critic review generation failed:", e?.message || e);
    return `${item.title} — ${item.short_synopsis?.slice(0,200) || ""}`;
  }
}

// message formatting (Telegram Markdown)
async function formatDigest(selected) {
  const when = new Date().toLocaleString("en-IN", { weekday:'short', year:'numeric', month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' });
  let msg = `🎬 *WEEKLY OTT DIGEST*\n📅 ${when}\n\n`;

  // Regional
  msg += `🇮🇳 *Regional Picks (${selected.regional.length}/6)*\n`;
  if (selected.regional.length < 6) {
    msg += `_Not enough regional titles this week worth recommending._\n\n`;
  } else {
    for (let i=0;i<selected.regional.length;i++){
      const m = selected.regional[i];
      msg += `${i+1}. *${m.title}* (${m.lang})\n`;
      if (m.cast && m.cast.length) msg += `   👥 ${m.cast.slice(0,4).join(", ")}\n`;
      if (m.director) msg += `   🎬 ${m.director}\n`;
      if (m.genre && m.genre.length) msg += `   🏷 ${m.genre.join(", ")}\n`;
      if (m.short_synopsis) msg += `   📝 ${m.short_synopsis.slice(0,180)}\n`;
      msg += `   🔗 ${m.link}\n\n`;
    }
  }

  // English
  msg += `🌍 *English Picks (${selected.english.length}/4)*\n`;
  if (selected.english.length < 4) {
    msg += `_Not enough English titles this week worth recommending._\n\n`;
  } else {
    for (let i=0;i<selected.english.length;i++){
      const m = selected.english[i];
      msg += `${i+1}. *${m.title}*\n`;
      if (m.cast && m.cast.length) msg += `   👥 ${m.cast.slice(0,4).join(", ")}\n`;
      if (m.director) msg += `   🎬 ${m.director}\n`;
      if (m.short_synopsis) msg += `   📝 ${m.short_synopsis.slice(0,180)}\n`;
      msg += `   🔗 ${m.link}\n\n`;
    }
  }

  // Korean
  msg += `🇰🇷 *Korean Picks (${selected.korean.length}/2)*\n`;
  if (selected.korean.length < 2) {
    msg += `_Not enough Korean titles this week worth recommending._\n\n`;
  } else {
    for (let i=0;i<selected.korean.length;i++){
      const m = selected.korean[i];
      msg += `${i+1}. *${m.title}*\n`;
      if (m.cast && m.cast.length) msg += `   👥 ${m.cast.slice(0,4).join(", ")}\n`;
      if (m.director) msg += `   🎬 ${m.director}\n`;
      if (m.short_synopsis) msg += `   📝 ${m.short_synopsis.slice(0,180)}\n`;
      msg += `   🔗 ${m.link}\n\n`;
    }
  }

  // Title of the week (pick best among all)
  const all = [...selected.regional, ...selected.english, ...selected.korean];
  all.sort((a,b) => (b.score || 0) - (a.score || 0));
  const top = all[0];
  if (top) {
    const review = await generateCriticReview(top);
    msg += `🎖 *Title of the Week*: *${top.title}* (${top.lang})\n`;
    msg += `📝 _${review}_\n\n`;
  }

  // AI summary and top 5 headlines (simple)
  msg += `🧠 *AI Summary of the Week*\n`;
  // Basic summary (if OpenAI available we could make fancier)
  msg += `_Fast takeaway:_ ${all.length} candidate items scanned. Top languages: ${[...new Set(all.map(x=>x.lang))].slice(0,5).join(", ")}.\n\n`;

  // Simple Top 5 headlines — pick most recent items (fallback)
  const top5 = all.slice(0,5);
  if (top5.length) {
    msg += `📰 *Top 5 Headlines*\n`;
    for (let i=0;i<top5.length;i++){
      const h = top5[i];
      msg += `${i+1}. ${h.title} — ${h.lang}\n   ${h.link}\n\n`;
    }
  }

  msg += `\nPowered by MsquareDigitalhub.com`;
  return msg;
}

// Broadcast function — posts only to group
async function broadcastDigestToGroup() {
  try {
    console.log("🔔 Starting collection + broadcast run...");
    // refresh DB in case groupId stored
    await db.read();
    db.data = db.data || { users: {}, adminId: null, groupId: null, lastRun: null };

    // determine group id to send to
    const groupId = db.data.groupId || (GROUP_CHAT_ID_ENV ? Number(GROUP_CHAT_ID_ENV) : null);
    if (!groupId) {
      console.warn("⚠ No GROUP_CHAT_ID configured and no groupId found in DB. Skipping broadcast.");
      return;
    }

    // collect
    const all = await collectMoviesFromFeeds(6); // limit per feed to reduce cost
    const picked = pickTop12(all);

    // attach score fields to picks by re-using internal scores (safe)
    const merged = {
      regional: picked.regional,
      english: picked.english,
      korean: picked.korean
    };

    // format
    const msg = await formatDigest(merged);

    // send to group
    try {
      await bot.telegram.sendMessage(groupId, msg, { parse_mode: "Markdown", disable_web_page_preview: true });
      console.log("✓ Broadcast sent to group:", groupId);
    } catch (e) {
      console.error("✗ Failed to send broadcast to group:", e?.message || e);
    }

    // update db.lastRun
    db.data.lastRun = new Date().toISOString();
    await db.write();
  } catch (e) {
    console.error("✗ broadcastDigestToGroup failed:", e?.message || e);
  }
}

// --- Bot handlers (minimal; no AI interaction from users) ---
// /setadmin - store adminId who can run broadcast command
bot.command("setadmin", safeRun(async (ctx) => {
  const userId = ctx.from && ctx.from.id;
  if (!userId) return;
  await db.read();
  db.data = db.data || {};
  db.data.adminId = userId;
  await db.write();
  await ctx.reply("✓ Admin set to your Telegram ID.");
}, "setadmin"));

// /broadcast <message> - only admin can use to send a custom message to group
bot.command("broadcast", safeRun(async (ctx) => {
  const sender = ctx.from && ctx.from.id;
  await db.read();
  const adminId = db.data.adminId || (ADMIN_ID_ENV ? Number(ADMIN_ID_ENV) : null);
  if (!adminId) {
    await ctx.reply("❗ Admin not set. Please run /setadmin first from the account you want to use as admin or set ADMIN_ID env var.");
    return;
  }
  if (sender !== adminId) {
    await ctx.reply("❌ You are not authorized to use this command.");
    return;
  }
  const text = ctx.message && ctx.message.text ? ctx.message.text.replace(/^\/broadcast\s*/i, "").trim() : "";
  if (!text) {
    await ctx.reply("Usage: /broadcast Your message here");
    return;
  }
  const targetGroup = db.data.groupId || (GROUP_CHAT_ID_ENV ? Number(GROUP_CHAT_ID_ENV) : null);
  if (!targetGroup) {
    await ctx.reply("❗ No group configured to send to. Add the bot to the group, then send a test message in the group to register it.");
    return;
  }
  try {
    await bot.telegram.sendMessage(targetGroup, `📢 Admin Broadcast:\n\n${text}`);
    await ctx.reply("✓ Broadcast sent to the group.");
  } catch (e) {
    await ctx.reply("✗ Failed to send broadcast: " + (e?.message || e));
  }
}, "broadcast"));

// welcome message for when bot detects group join or new_chat_members events
bot.on("new_chat_members", safeRun(async (ctx) => {
  try {
    // store group id if not present
    const groupId = ctx.chat && ctx.chat.id;
    if (groupId) {
      await db.read();
      db.data = db.data || {};
      if (!db.data.groupId) {
        db.data.groupId = groupId;
        console.log("✓ Stored groupId:", groupId);
      }
      await db.write();
    }

    // send configured welcome message once per join event to the group (not DM)
    const groupWelcome = (WELCOME_MESSAGE || "").slice(0, 3000);
    await ctx.reply(groupWelcome, { parse_mode: "Markdown" });
  } catch (e) {
    console.warn("⚠ welcome handler failed:", e?.message || e);
  }
}, "new_chat_members"));

// webhook endpoint for Render if using WEBHOOK_URL
app.post("/bot", (req, res) => {
  try {
    bot.handleUpdate(req.body, res).then(() => res.sendStatus(200)).catch(err => {
      console.warn("⚠ bot.handleUpdate error:", err?.message || err);
      res.sendStatus(500);
    });
  } catch (e) {
    console.warn("⚠ bot webhook error:", e?.message || e);
    res.sendStatus(500);
  }
});

// simple health endpoints
app.get("/", (req, res) => res.json({ status: "alive", time: new Date().toISOString() }));
app.get("/status", async (req, res) => {
  await db.read();
  res.json({
    status: "running",
    groupId: db.data.groupId || GROUP_CHAT_ID_ENV || null,
    lastRun: db.data.lastRun || null
  });
});

// initialize everything and start server + cron + bot
(async () => {
  try {
    await initDB();

    // start express server
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, async () => {
      console.log("==> SERVER STARTED on port", PORT);

      // webhook vs polling
      if (WEBHOOK_URL) {
        try {
          await bot.telegram.setWebhook(WEBHOOK_URL + "/bot");
          console.log("✓ Webhook set to:", WEBHOOK_URL + "/bot");
        } catch (e) {
          console.warn("⚠ Failed to set webhook (falling back to polling):", e?.message || e);
          await bot.launch();
        }
      } else {
        // polling mode
        await bot.launch();
        console.log("✓ Bot launched in polling mode");
      }

      // if GROUP_CHAT_ID env provided, store it in DB
      await db.read();
      db.data = db.data || {};
      if (GROUP_CHAT_ID_ENV) {
        const gid = Number(GROUP_CHAT_ID_ENV);
        if (!isNaN(gid)) {
          db.data.groupId = gid;
          await db.write();
          console.log("✓ Stored GROUP_CHAT_ID from env:", gid);
        } else {
          console.warn("⚠ GROUP_CHAT_ID env provided but not numeric:", GROUP_CHAT_ID_ENV);
        }
      }

      // schedule cron job: every 2 minutes (testing). timezone Asia/Kolkata
      cron.schedule("*/2 * * * *", safeRun(async () => {
        console.log("⏰ Cron triggered:", new Date().toLocaleString());
        await broadcastDigestToGroup();
      }, "cron-job"), { timezone: "Asia/Kolkata" });

      console.log("=> Ready. Cron schedule: every 2 minutes (testing).");
    });

    // graceful shutdown
    process.once("SIGINT", async () => {
      console.log("SIGINT received — shutting down...");
      try { await bot.stop(); } catch(e) {}
      process.exit(0);
    });
    process.once("SIGTERM", async () => {
      console.log("SIGTERM received — shutting down...");
      try { await bot.stop(); } catch(e) {}
      process.exit(0);
    });

  } catch (e) {
    console.error("Fatal startup error:", e?.message || e);
    process.exit(1);
  }
})();
