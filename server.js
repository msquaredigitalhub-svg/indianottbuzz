/**************************************************************
 OTT PULSE INDIA — Weekly OTT Digest Bot (single file)
 Author: ChatGPT for MsquareDigitalhub
 Features:
  - Filmibeat RSS sources (only)
  - AI enrichment via OpenAI (gpt-4o-mini)
  - Cron: every 2 minutes (testing)
  - Posts ONLY to group (no DM)
  - Crash-proof guards & helpful logs
**************************************************************/

process.env.TZ = 'Asia/Kolkata';

// ---------- imports with graceful fallback ----------
let Telegraf, cron, Parser, express, lowdb, JSONFile, cheerio;
try {
  Telegraf = require('telegraf').Telegraf;
  cron = require('node-cron');
  Parser = require('rss-parser');
  express = require('express');
  const lowdb_pkg = require('lowdb');
  // lowdb v7 uses JSONFile and Low
  JSONFile = require('lowdb/node').JSONFile;
  lowdb = require('lowdb');
} catch (e) {
  console.error('Missing required packages. Please install dependencies:');
  console.error('npm install telegraf node-cron rss-parser express lowdb cheerio');
  console.error('If you already installed, restart the service.');
  console.error('Error details:', e.message);
  process.exit(1);
}

// cheerio optional import
try {
  cheerio = require('cheerio');
} catch (e) {
  console.warn('Optional dependency "cheerio" not installed. Article HTML parsing will be basic.');
  cheerio = null;
}

// ---------- environment & config ----------
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const GROUP_CHAT_ID = process.env.GROUP_CHAT_ID || '-1003478811764'; // fallback sample, override in Render env
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const WEBHOOK_URL = process.env.WEBHOOK_URL || ''; // optional

if (!BOT_TOKEN) {
  console.error('FATAL: BOT_TOKEN not set in env. Add it to Render environment variables.');
  process.exit(1);
}
if (!OPENAI_API_KEY) {
  console.error('FATAL: OPENAI_API_KEY not set in env. Add it to Render environment variables.');
  process.exit(1);
}
if (!GROUP_CHAT_ID) {
  console.error('FATAL: GROUP_CHAT_ID not set. Add your group numeric id to env (example -1001234567890).');
  process.exit(1);
}

const PORT = process.env.PORT || 3000;
const CRON_SCHEDULE = '*/2 * * * *'; // every 2 minutes for testing
const OPENAI_MODEL = 'gpt-4o-mini'; // cheapest model chosen

// ---------- feeds (Filmibeat only as requested) ----------
const FEEDS = [
  { url: 'https://www.filmibeat.com/rss/feeds/filmibeat-fb.xml', lang: 'Hindi' }, // general - includes many languages
  { url: 'https://www.filmibeat.com/rss/feeds/bollywood-fb.xml', lang: 'Hindi' },
  { url: 'https://www.filmibeat.com/rss/feeds/television-fb.xml', lang: 'Hindi' },
  { url: 'https://www.filmibeat.com/rss/feeds/english-hollywood-fb.xml', lang: 'English' },
  { url: 'https://www.filmibeat.com/rss/feeds/entertainment-music-fb.xml', lang: 'English' },
  { url: 'https://www.filmibeat.com/rss/feeds/telugu-fb.xml', lang: 'Telugu' },
  { url: 'https://www.filmibeat.com/rss/feeds/kannada-fb.xml', lang: 'Kannada' },
  { url: 'https://www.filmibeat.com/rss/feeds/tamil-fb.xml', lang: 'Tamil' },
  { url: 'https://www.filmibeat.com/rss/feeds/tamil-reviews-fb.xml', lang: 'Tamil' },
  { url: 'https://www.filmibeat.com/rss/feeds/malayalam-fb.xml', lang: 'Malayalam' },
  { url: 'https://www.filmibeat.com/rss/feeds/interviews-fb.xml', lang: 'Hindi' },
  { url: 'https://www.filmibeat.com/rss/feeds/english-latest-web-series-fb.xml', lang: 'English' },
  { url: 'https://www.filmibeat.com/rss/feeds/english-promotions-fb.xml', lang: 'English' },
  { url: 'https://www.filmibeat.com/rss/feeds/ott-fb.xml', lang: 'Hindi' },
  { url: 'https://www.filmibeat.com/rss/feeds/korean-fb.xml', lang: 'Korean' }
];

// ---------- initialize services ----------
const app = express();
app.use(express.json({ limit: '200kb' }));

const parser = new Parser({
  headers: { 'User-Agent': 'Mozilla/5.0 (compatible; OTT-bot/1.0)' },
  timeout: 15000,
  maxRedirects: 5
});

const bot = new Telegraf(BOT_TOKEN);

// lowdb setup (simple JSON file)
const DBFILE = process.env.DB_FILE || 'db.json';
let db;
(async () => {
  try {
    const adapter = new JSONFile(DBFILE);
    db = new lowdb.Low(adapter);
    await db.read();
    db.data = db.data || { seenTitles: {}, adminId: 0, groupId: GROUP_CHAT_ID };
    // persist initial groupId if env provided
    db.data.groupId = db.data.groupId || GROUP_CHAT_ID;
    await db.write();
    console.log('✓ DB initialized');
  } catch (e) {
    console.error('✗ DB initialization error:', e.message);
    process.exit(1);
  }
})();

// ---------- helper utilities ----------
function safeLog(...args) { console.log(new Date().toISOString(), ...args); }

async function safeFetch(url, opts = {}) {
  // Node 18+ global fetch used; include timeout via AbortController
  const controller = new AbortController();
  const timeout = opts.timeout || 15000;
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, { signal: controller.signal, ...opts });
    clearTimeout(id);
    return res;
  } catch (e) {
    clearTimeout(id);
    throw e;
  }
}

function normalizeTitle(s) {
  if (!s) return '';
  return s.replace(/\s+–.*$/,'').replace(/\s+—.*$/,'').replace(/\|.*$/,'').trim();
}

function uniqBy(a, keyFn) {
  const seen = new Set();
  const out = [];
  for (const item of a) {
    const k = keyFn(item);
    if (!seen.has(k)) { seen.add(k); out.push(item); }
  }
  return out;
}

// ---------- OpenAI helper using REST (no SDK required) ----------
async function callOpenAIChat(messages = [], maxTokens = 300, temperature = 0.3) {
  const url = 'https://api.openai.com/v1/chat/completions';
  try {
    const res = await safeFetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        messages,
        max_tokens: maxTokens,
        temperature
      }),
      timeout: 30000
    });
    if (!res.ok) {
      const txt = await res.text().catch(()=>'{no-body}');
      throw new Error(`OpenAI ${res.status} ${res.statusText}: ${txt}`);
    }
    const json = await res.json();
    return json;
  } catch (e) {
    console.error('✗ OpenAI call failed:', e.message);
    return null;
  }
}

// ---------- article extraction ----------
async function fetchArticleText(url) {
  if (!url) return '';
  try {
    const r = await safeFetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 15000 });
    if (!r.ok) throw new Error('fetch failed ' + r.status);
    const html = await r.text();
    if (cheerio) {
      const $ = cheerio.load(html);
      // try a few selectors that Filmibeat likely uses
      const selectors = ['article', '.article-content', '.content', '#article-body', '.story', '.post-content'];
      for (const sel of selectors) {
        const el = $(sel);
        if (el && el.text() && el.text().trim().length > 120) {
          return el.text().replace(/\s+/g, ' ').trim().slice(0, 30000);
        }
      }
      // fallback to body text
      return $('body').text().replace(/\s+/g, ' ').trim().slice(0, 30000);
    } else {
      // no cheerio — return first chunk of HTML stripped simply
      return html.replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim().slice(0, 20000);
    }
  } catch (e) {
    console.warn('  ⚠ fetchArticleText error for', url, e.message);
    return '';
  }
}

// ---------- AI extract metadata (compact prompt) ----------
async function aiExtractMovieMeta(title, url, snippet) {
  // Keep the prompt short and deterministic
  const system = `You are a concise extractor. Return ONLY JSON object with these fields:
"title","cast" (array of top 5 names), "director" (string), "genre" (array), "short_synopsis" (1-2 sentences), "confidence" (0-1 numeric). If unknown, use empty string/array.`;
  const user = `Article title: "${title}"
URL: ${url}
Text excerpt: ${snippet.slice(0,2000)}

Return ONLY JSON.`;
  const resp = await callOpenAIChat(
    [{role:'system', content:system}, {role:'user', content:user}],
    250,
    0.0
  );
  if (!resp) return null;
  const content = resp.choices?.[0]?.message?.content || '';
  // try parse JSON portion
  const i = content.indexOf('{');
  try {
    const parsed = JSON.parse(i>=0?content.slice(i):content);
    parsed.title = parsed.title || title;
    parsed.confidence = typeof parsed.confidence === 'number' ? parsed.confidence : 0;
    return parsed;
  } catch (e) {
    // fallback minimal object
    return { title, cast: [], director:'', genre:[], short_synopsis: snippet.slice(0,280), confidence:0 };
  }
}

// ---------- collect & enrich (Filmibeat-only) ----------
async function collectAndEnrich() {
  safeLog('🔎 Collecting Filmibeat feeds...');
  const items = [];
  for (const feed of FEEDS) {
    try {
      const rss = await parser.parseURL(feed.url);
      if (!rss || !rss.items) continue;
      // limit items to recent to avoid high OpenAI cost
      for (const item of rss.items.slice(0,8)) {
        const rawTitle = normalizeTitle(item.title || '');
        if (!rawTitle) continue;
        items.push({
          rawTitle,
          link: item.link || '',
          snippet: item.contentSnippet || '',
          pubDate: item.pubDate || item.isoDate || new Date().toISOString(),
          feedLang: feed.lang
        });
      }
    } catch (e) {
      console.warn('  ⚠ Feed error', feed.url, e.message);
    }
    // small delay to be polite
    await new Promise(r=>setTimeout(r,200));
  }

  // dedupe by normalized title
  const unique = uniqBy(items, it => it.rawTitle.toLowerCase());

  safeLog(`✓ Found ${unique.length} unique Filmibeat items (capped) — enriching with AI (limited).`);

  const enriched = [];
  // limit enrichment to first 40 items to control cost
  for (const it of unique.slice(0,40)) {
    try {
      const articleText = await fetchArticleText(it.link);
      const snippetToUse = articleText || (it.snippet || '');
      const meta = await aiExtractMovieMeta(it.rawTitle, it.link, snippetToUse);
      enriched.push({
        title: meta?.title || it.rawTitle,
        link: it.link,
        lang: mapFeedLangToCategory(it.feedLang, it),
        pubDate: it.pubDate,
        cast: meta?.cast || [],
        director: meta?.director || '',
        genre: meta?.genre || [],
        short_synopsis: meta?.short_synopsis || snippetToUse.slice(0,300),
        confidence: meta?.confidence || 0
      });
    } catch (e) {
      console.warn('  ⚠ Enrich error for', it.rawTitle, e.message);
    }
    // small delay between calls (helps avoid bursts)
    await new Promise(r=>setTimeout(r, 350));
  }

  return enriched;
}

function mapFeedLangToCategory(feedLang, item) {
  // some feeds are general; try heuristics with title/snippet for language detection
  if (!feedLang) feedLang = 'Hindi';
  const lower = (item.rawTitle + ' ' + (item.snippet||'')).toLowerCase();
  // simple rules: if title contains Tamil script or known keywords, choose Tamil etc.
  if (feedLang === 'Korean') return 'Korean';
  if (lower.match(/\b(tamil|kollywood|tamilan)\b/)) return 'Tamil';
  if (lower.match(/\b(telugu|tollywood)\b/)) return 'Telugu';
  if (lower.match(/\b(malayalam|mollywood)\b/)) return 'Malayalam';
  if (lower.match(/\b(kannada|sandalwood)\b/)) return 'Kannada';
  if (lower.match(/\b(bollywood|hindi)\b/)) return 'Hindi';
  if (feedLang === 'English' || lower.match(/\b(english|web series|netflix|prime|netflix)\b/)) return 'English';
  // fallback to feedLang
  return feedLang;
}

// ---------- selection & ranking ----------
function pickTopTitles(enriched) {
  // filter low confidence and recent only
  const byLang = {};
  for (const it of enriched) {
    const lang = it.lang || 'Hindi';
    byLang[lang] = byLang[lang] || [];
    byLang[lang].push(it);
  }
  // sort each lang by confidence desc then newest
  for (const k of Object.keys(byLang)) {
    byLang[k].sort((a,b) => (b.confidence - a.confidence) || (new Date(b.pubDate) - new Date(a.pubDate)));
  }

  // pick 6 regional (mixed languages) — prioritize Tamil, Telugu, Malayalam, Kannada, Hindi
  const regionalLangs = ['Tamil','Telugu','Malayalam','Kannada','Hindi'];
  const regionalPicks = [];
  for (const rl of regionalLangs) {
    if (regionalPicks.length >= 6) break;
    const arr = byLang[rl] || [];
    if (arr.length > 0) {
      regionalPicks.push(arr[0]);
      // remove chosen from byLang
      byLang[rl].shift();
    }
  }
  // if still fewer than 6, fill from other regional entries
  const otherCandidates = Object.values(byLang).flat();
  for (const c of otherCandidates) {
    if (regionalPicks.length >= 6) break;
    if (!regionalPicks.find(x=>x.title===c.title)) regionalPicks.push(c);
  }

  // English picks (4)
  const eng = (byLang['English'] || []).slice(0,6);
  const engPicks = eng.slice(0,4);

  // Korean picks (2)
  const kor = (byLang['Korean'] || []).slice(0,4);
  const korPicks = kor.slice(0,2);

  // overall validated (no duplicates)
  const allPicks = uniqBy([...regionalPicks, ...engPicks, ...korPicks], p => p.title.toLowerCase());

  // If not enough items in categories, note that later
  return {
    regional: regionalPicks,
    english: engPicks,
    korean: korPicks,
    all: allPicks
  };
}

// ---------- choose "Title of the Week" via AI and get 50-word critic review ----------
async function chooseTitleOfWeekAndReview(picks) {
  // build a short prompt containing the selected picks
  const candidates = picks.all.map(p => ({ title: p.title, lang: p.lang, link: p.link }));
  if (!candidates.length) return null;

  const sys = `You are an international film critic. From the provided candidate list, pick one title that is most noteworthy (consider critical depth, originality, performances, and audience buzz). Return JSON: { "pick": "<title>", "review": "<50-word review (no spoilers)>" } only.`;
  const usr = `Candidates: ${JSON.stringify(candidates.slice(0,12), null, 2)}\nReturn JSON only.`;

  const resp = await callOpenAIChat([{role:'system', content:sys}, {role:'user', content:usr}], 250, 0.5);
  if (!resp) return null;
  const content = resp.choices?.[0]?.message?.content || '';
  const i = content.indexOf('{');
  try {
    const json = JSON.parse(i>=0?content.slice(i):content);
    return json;
  } catch (e) {
    // fallback: pick highest confidence or newest
    const fallback = picks.all[0];
    return { pick: fallback?.title || '', review: `Critic pick: ${fallback?.title || ''} — a notable release this week.` };
  }
}

// ---------- format message ----------
function formatDigestMessage(picks, titleOfWeekObj, weeklySummary, topHeadlines) {
  let msg = `🎬 *WEEKLY OTT DIGEST*\n`;
  msg += `📅 ${new Date().toLocaleString('en-IN')}\n\n`;

  // Regional
  msg += `🇮🇳 *Regional Picks (6)*\n`;
  if (!picks.regional || picks.regional.length < 6) {
    msg += `⚠️ Not enough regional titles this week worth recommending.\n\n`;
  } else {
    picks.regional.slice(0,6).forEach((m,i) => {
      msg += `${i+1}. *${m.title}* — ${m.genre?.slice(0,2).join(', ') || 'Genre N/A'} | ${m.link}\n`;
      msg += `   👥 ${m.cast?.slice(0,4).join(', ') || 'Cast N/A'}\n`;
      msg += `   📝 ${m.short_synopsis?.slice(0,160)}\n\n`;
    });
  }

  // English
  msg += `🌍 *English Picks (4)*\n`;
  if (!picks.english || picks.english.length < 4) {
    msg += `⚠️ Not enough English titles this week worth recommending.\n\n`;
  } else {
    picks.english.slice(0,4).forEach((m,i) => {
      msg += `${i+1}. *${m.title}* — ${m.genre?.slice(0,2).join(', ') || 'Genre N/A'} | ${m.link}\n`;
      msg += `   👥 ${m.cast?.slice(0,4).join(', ') || 'Cast N/A'}\n`;
      msg += `   📝 ${m.short_synopsis?.slice(0,160)}\n\n`;
    });
  }

  // Korean
  msg += `🇰🇷 *Korean Picks (2)*\n`;
  if (!picks.korean || picks.korean.length < 2) {
    msg += `⚠️ Not enough Korean titles this week worth recommending.\n\n`;
  } else {
    picks.korean.slice(0,2).forEach((m,i) => {
      msg += `${i+1}. *${m.title}* — ${m.genre?.slice(0,2).join(', ') || 'Genre N/A'} | ${m.link}\n`;
      msg += `   👥 ${m.cast?.slice(0,4).join(', ') || 'Cast N/A'}\n`;
      msg += `   📝 ${m.short_synopsis?.slice(0,160)}\n\n`;
    });
  }

  // Title of the week
  if (titleOfWeekObj && titleOfWeekObj.pick) {
    msg += `🎖 *Title of the Week*: *${titleOfWeekObj.pick}*\n`;
    msg += `   ✒️ _Critic review:_ ${titleOfWeekObj.review}\n\n`;
  }

  // Weekly summary
  if (weeklySummary) {
    msg += `🧠 *AI Summary of the Week*\n${weeklySummary}\n\n`;
  }

  // Top 5 headlines
  if (topHeadlines && topHeadlines.length) {
    msg += `📰 *Top 5 Headlines*\n`;
    topHeadlines.slice(0,5).forEach((h,i) => {
      msg += `${i+1}. ${h.headline || h.title || 'Headline'}\n   ${h.source || ''}\n`;
    });
    msg += `\n`;
  }

  msg += `Powered by MsquareDigitalhub.com`;
  return msg;
}

// ---------- headlines extractor (simple pick from interviews/viral feeds) ----------
async function extractTopHeadlines(enriched) {
  // pick top 8 recent high-confidence items as headlines
  const sorted = enriched.slice().sort((a,b) => (b.confidence||0) - (a.confidence||0));
  const headlines = sorted.slice(0,8).map(x => ({ headline: x.title, source: x.link }));
  return headlines;
}

// ---------- weekly summary via AI (short) ----------
async function generateWeeklySummary(enriched) {
  const top = enriched.slice(0,12).map(e => `${e.title} [${e.lang}]`).join('\n');
  const sys = `You are a concise editorial writer for an Indian OTT digest. Write a 2-4 line weekly summary highlighting trends, platforms and languages. Tone: editorial, insightful.`;
  const usr = `Recent top items:\n${top}\n\nWrite 3-4 short sentences summary for the weekly digest.`;
  const resp = await callOpenAIChat([{role:'system', content:sys},{role:'user', content:usr}], 200, 0.45);
  if (!resp) return '';
  const out = resp.choices?.[0]?.message?.content || '';
  return out.trim();
}

// ---------- entire flow: collect -> pick -> ai pick -> format -> send ----------
async function runDigestFlow() {
  safeLog('=== Digest job started ===');
  try {
    const enriched = await collectAndEnrich();
    if (!enriched || enriched.length === 0) {
      safeLog('No enriched items found this run.');
    }

    const picks = pickTopTitles(enriched);
    const topHeadlines = await extractTopHeadlines(enriched);
    const weeklySummary = await generateWeeklySummary(enriched);
    const titleOfWeekObj = await chooseTitleOfWeekAndReview({ all: picks.all });

    const msg = formatDigestMessage(picks, titleOfWeekObj, weeklySummary, topHeadlines);

    // send ONLY to group
    const groupId = db?.data?.groupId || GROUP_CHAT_ID;
    try {
      await bot.telegram.sendMessage(groupId, msg, { parse_mode: 'Markdown', disable_web_page_preview: true });
      safeLog('✓ Broadcast posted to group', groupId);
    } catch (e) {
      console.error('✗ Failed to send broadcast to group:', e.message);
    }
  } catch (e) {
    console.error('✗ runDigestFlow error:', e.message);
  }
  safeLog('=== Digest job finished ===');
}

// ---------- cron setup (testing every 2 minutes) ----------
try {
  cron.schedule(CRON_SCHEDULE, () => {
    // fire-and-forget with safety
    runDigestFlow().catch(err => console.error('Cron job error:', err?.message || err));
  }, { timezone: 'Asia/Kolkata' });
  safeLog(`✓ Cron scheduled: ${CRON_SCHEDULE} (Asia/Kolkata)`);
} catch (e) {
  console.error('✗ Failed to schedule cron:', e.message);
}

// ---------- webhook or polling setup & express endpoints ----------
app.get('/', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

// webhook route for Telegram
app.post('/bot', async (req, res) => {
  try {
    await bot.handleUpdate(req.body);
  } catch (e) {
    console.warn('Webhook handleUpdate error:', e.message);
  }
  res.sendStatus(200);
});

(async () => {
  // decide webhook vs polling
  try {
    if (WEBHOOK_URL) {
      await bot.telegram.setWebhook(WEBHOOK_URL + '/bot');
      await bot.launch({ webhook: { domain: WEBHOOK_URL, port: +PORT } });
      safeLog('✓ Bot launched in WEBHOOK mode, webhook set to', WEBHOOK_URL + '/bot');
    } else {
      // polling mode
      await bot.launch();
      safeLog('✓ Bot launched in POLLING mode');
    }
  } catch (e) {
    console.error('✗ Bot launch error:', e.message);
  }

  // simple handlers (welcome message & basic protection)
  bot.on('new_chat_members', async (ctx) => {
    const newUsers = ctx.message?.new_chat_members || [];
    try {
      for (const user of newUsers) {
        // store groupId if not set
        db.data.groupId = db.data.groupId || ctx.chat.id;
        await db.write();
        // welcome message (editable below)
        const welcome = `🎉 *Welcome to OTT Pulse India!*\n\nYour weekly destination for India’s best OTT updates across Tamil, Telugu, Malayalam, Kannada, Hindi, English & Korean.\n\nFeatures:\n• Weekly AI-curated digest (Regional + English + Korean)\n• Top 12 picks, Title of the Week, AI summary & Top 5 headlines\n\nPowered by MsquareDigitalhub.com`;
        await ctx.reply(welcome, { parse_mode: 'Markdown' });
      }
    } catch (e) {
      console.warn('Welcome handler error:', e.message);
    }
  });

  // restrict user messages: option to auto-delete messages from non-admins (if bot has admin rights)
  bot.on('message', async (ctx) => {
    try {
      // if admin wants a quiet group: delete messages from everyone except admins and the bot
      // NOTE: To enable auto-moderation, uncomment the following block.
      /*
      const senderId = ctx.from?.id;
      const botId = (await bot.telegram.getMe()).id;
      // allow messages from bot itself or adminId stored in DB
      if (senderId !== botId && senderId !== db.data.adminId) {
        // try delete message (bot must be admin with delete permissions)
        try { await ctx.deleteMessage(ctx.message.message_id); } catch(e){ }
      }
      */
    } catch (e) {
      // swallow errors so the bot doesn't crash
    }
  });

  // start express server for webhook endpoint and health checks
  app.listen(PORT, () => {
    safeLog('🚀 SERVER STARTED');
    safeLog(`Listening on port ${PORT}`);
    safeLog(`Primary group id: ${db?.data?.groupId || GROUP_CHAT_ID}`);
    safeLog('Visit / for status');
  });
})();

// ---------- global error handlers to avoid crashes ----------
process.on('unhandledRejection', (reason, p) => {
  console.error('Unhandled Rejection at Promise', p, 'reason:', reason);
});
process.on('uncaughtException', err => {
  console.error('Uncaught Exception:', err);
  // do NOT exit; attempt to continue running
});
