const { Telegraf } = require('telegraf');
const express = require('express');
const cron = require('node-cron');
const RssParser = require('rss-parser');
const { Low } = require('lowdb');
const { JSONFile } = require('lowdb/node'); // FIX: Use /node subpath for JSONFile adapter
const { OpenAI } = require('openai');
const cheerio = require('cheerio');
const crypto = require('crypto');
const path = require('path');

// --- 🔐 Environment & Constants ---

const BOT_TOKEN = process.env.BOT_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const PORT = process.env.PORT || 3000;
const GROUP_CHAT_ID = '-1003478811764'; // Target Telegram Group ID
const TIMEZONE = 'Asia/Kolkata';

// --- 🔧 Core Libraries Setup ---

// LowDB Setup
const file = path.join(__dirname, 'db.json');
const adapter = new JSONFile(file);
// FIX: Provide default data ({ processedLinks: [] }) to prevent "lowdb: missing default data" error
const db = new Low(adapter, { processedLinks: [] }); 

// OpenAI Setup
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// Telegraf Bot Setup
const bot = new Telegraf(BOT_TOKEN);

// RSS Parser Setup
const parser = new RssParser({
    customFields: {
        item: ['title', 'link', 'pubDate', 'content:encoded'],
    },
    // FIX: Use a stronger set of headers to bypass 403 blocks
    customHeaders: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Connection': 'keep-alive'
    },
});

// Express App Setup
const app = express();
app.use(express.json());

// --- 🎬 Data Sources ---

const RSS_FEEDS = {
    movies: [
        'https://www.filmibeat.com/rss/feeds/bollywood-fb.xml',
        'https://www.filmibeat.com/rss/feeds/tamil-fb.xml',
        'https://www.filmibeat.com/rss/feeds/tamil-reviews-fb.xml',
        'https://www.filmibeat.com/rss/feeds/telugu-fb.xml',
        'https://www.filmibeat.com/rss/feeds/kannada-fb.xml',
        'https://www.filmibeat.com/rss/feeds/malayalam-fb.xml',
        'https://www.filmibeat.com/rss/feeds/english-hollywood-fb.xml',
        'https://www.filmibeat.com/rss/feeds/korean-fb.xml',
    ],
    webSeries: [
        'https://www.filmibeat.com/rss/feeds/english-latest-web-series-fb.xml',
    ],
    ott: [
        'https://www.filmibeat.com/rss/feeds/ott-fb.xml',
    ],
    headlines: [
        'https://www.filmibeat.com/rss/feeds/interviews-fb.xml',
        'https://www.filmibeat.com/rss/feeds/english-promotions-fb.xml',
        'https://www.filmibeat.com/rss/feeds/english-flashback-fb.xml',
        'https://www.filmibeat.com/rss/feeds/english-viral-fb.xml',
        'https://www.filmibeat.com/rss/feeds/television-fb.xml',
        'https://www.filmibeat.com/rss/feeds/entertainment-music-fb.xml',
    ],
};

// --- 🛡 Crash-Proof Utilities ---

/**
 * Loads DB and initializes default structure if necessary.
 */
async function setupDb() {
    try {
        await db.read();
        // Ensure data integrity before writing (though default is set in Low constructor)
        if (!db.data.processedLinks) {
             db.data.processedLinks = [];
        }
        await db.write();
        console.log('✓ Database initialized/loaded successfully.');
    } catch (error) {
        console.error('⚠ FATAL: Could not setup LowDB.', error);
        // Do NOT crash the server
    }
}

/**
 * Saves a link URL to the database of processed links.
 * @param {string} link
 */
async function saveProcessedLink(link) {
    try {
        await db.read();
        if (!db.data.processedLinks.includes(link)) {
            db.data.processedLinks.push(link);
            // Keep the array length manageable
            if (db.data.processedLinks.length > 500) {
                db.data.processedLinks.splice(0, db.data.processedLinks.length - 500);
            }
            await db.write();
        }
    } catch (error) {
        console.error('⚠ Error saving processed link to DB:', error);
    }
}

/**
 * Checks if a link has already been processed.
 * @param {string} link
 * @returns {boolean}
 */
async function isLinkProcessed(link) {
    try {
        await db.read();
        return db.data.processedLinks.includes(link);
    } catch (error) {
        console.error('⚠ Error checking processed link from DB:', error);
        return false; // Safest fallback: assume not processed to avoid missing a post
    }
}

// --- 🧠 AI Prompts & Functions ---

const AI_SYSTEM_PROMPT = `You are an expert AI assistant specialized in analyzing film and web series data for the Indian OTT market. Your goal is to process a list of titles and extract key details, provide a relevance score, and generate critical reviews and summaries. All output MUST be in plain text unless a specific JSON structure is requested.`;

/**
 * Fetches, cleans, and structures data from RSS feeds.
 * @param {string[]} urls Array of RSS feed URLs.
 * @returns {Promise<Array<object>>} An array of structured items.
 */
async function fetchAndCleanFeeds(urls) {
    const allItems = [];
    for (const url of urls) {
        try {
            const feed = await parser.parseURL(url);
            for (const item of feed.items) {
                const linkHash = crypto.createHash('sha256').update(item.link).digest('hex');
                if (await isLinkProcessed(linkHash)) {
                    // console.log(`➡ Skipping already processed link: ${item.title}`);
                    continue;
                }

                // Clean the content:encoded field (often contains HTML)
                let cleanedContent = '';
                if (item['content:encoded']) {
                    const $ = cheerio.load(item['content:encoded']);
                    cleanedContent = $.text().trim();
                }

                allItems.push({
                    title: item.title,
                    link: item.link,
                    pubDate: item.pubDate,
                    content: cleanedContent,
                    linkHash: linkHash,
                    category: feed.title,
                });
            }
            console.log(`✓ Successfully fetched and cleaned ${feed.items.length} items from ${url}.`);
        } catch (error) {
            console.error(`⚠ Error processing feed ${url}:`, error.message);
            // Log error but continue to the next feed (crash-proof requirement)
        }
    }
    return allItems;
}

/**
 * Uses GPT-4o-mini to extract details and rank titles.
 * @param {object[]} titles
 * @returns {Promise<object>} Object containing ranked titles, summary, review, and headlines.
 */
async function processDataWithAI(titles, headlines) {
    const FALLBACK_TITLE = {
        title: 'Unknown Title',
        details: 'Details unavailable.',
        score: 0,
        category: 'Regional' // Default category for array structuring
    };
    const FALLBACK_OUTPUT = {
        rankedTitles: [
            ...new Array(6).fill({...FALLBACK_TITLE, category: 'Regional'}),
            ...new Array(4).fill({...FALLBACK_TITLE, category: 'English'}),
            ...new Array(2).fill({...FALLBACK_TITLE, category: 'Korean'})
        ],
        titleOfTheWeek: {
            title: 'Top Pick Unavailable',
            review: 'A comprehensive review for this week’s best title is currently unavailable.'
        },
        weeklySummary: 'This week saw minimal notable releases, with no major standout trends in the Indian OTT space.',
        topHeadlines: ['No breaking headlines available this cycle.', 'More news coming soon.', 'Stay tuned for updates.', 'Check the blog for details.', 'MsquareDigitalhub update.'],
        fallbackUsed: true
    };

    if (titles.length === 0) {
        console.log('➡ No new titles found for AI processing. Using full fallback.');
        return FALLBACK_OUTPUT;
    }

    // Filter out potential duplicates based on title before sending to AI
    const uniqueTitles = Array.from(new Set(titles.map(t => t.title)))
        .map(title => titles.find(t => t.title === title));

    const titleListString = uniqueTitles.map((t, i) => `${i + 1}. Title: ${t.title}\n   Content Snippet: ${t.content.substring(0, 200)}...`).join('\n---\n');
    const headlineListString = headlines.map(h => `- ${h.title}`).join('\n');

    const prompt = `
        You are an expert critic for the Indian OTT market. Your task is to process the following data.

        ### A. Title Ranking and Selection
        Process the following list of ${uniqueTitles.length} unique titles (movies and web-series).
        For each, estimate its **Indian Audience Relevance Score** (out of 10) based on cast, genre, and hype.
        Extract the following details: **Title**, **Cast**, **Director**, **Genre**, **Synopsis** (max 2 sentences), **Language/Origin**.

        Select titles based on the highest scores to fulfill these quotas:
        - **6 Regional Titles** (mix of Tamil, Telugu, Malayalam, Kannada, Hindi) -> Must have "Regional" in the category field.
        - **4 English Titles** (Hollywood/International) -> Must have "English" in the category field.
        - **2 Korean Titles** -> Must have "Korean" in the category field.

        Format the output as a SINGLE, complete, valid JSON array called 'titles_output' like this:
        [
            {
                "title": "Title Name",
                "details": "Cast: [Names]. Director: [Name]. Genre: [Genre]. Synopsis: [Synopsis]. Language: [Language]",
                "score": 8.5,
                "category": "Regional|English|Korean"
            },
            ... 12 selected entries total ...
        ]
        If you cannot find 12 good titles, only include the ones that have a score > 6. Do NOT invent titles.

        ### B. Critic Review
        From the final selected titles, choose the one with the **absolute highest score** to be the "Title of the Week".
        Write a **50-word international critic-style review** for it. It MUST be spoiler-free.
        Format the output as a SINGLE string called 'review_output'.

        ### C. Weekly Summary
        Write an editorial summary on recent OTT trends, hype, standout releases, and platform momentum in India. Max 4 lines.
        Format the output as a SINGLE string called 'summary_output'.

        ### D. Top Headlines
        From the following raw headlines, select the **top 5 most interesting and relevant** for an OTT-focused group.
        Raw Headlines:
        ${headlineListString}
        Format the output as a JSON array of strings called 'headlines_output'.

        ### COMBINED FINAL OUTPUT SCHEMA
        Provide ONLY the following JSON object in your response. No other text, formatting, or explanation.

        {
          "titles_output": [ ... JSON array of 12 selected titles ... ],
          "review_output": "...",
          "summary_output": "...",
          "headlines_output": [ ... JSON array of 5 headlines ... ]
        }

        TITLE DATA TO PROCESS:
        ---
        ${titleListString}
        ---
    `;

    try {
        console.log(`➡ Sending ${uniqueTitles.length} unique titles and ${headlines.length} headlines to GPT-4o-mini...`);
        const completion = await openai.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: [
                { role: 'system', content: AI_SYSTEM_PROMPT },
                { role: 'user', content: prompt }
            ],
            temperature: 0.3,
            response_format: { type: 'json_object' }
        });

        const rawJson = completion.choices[0].message.content;
        const aiResult = JSON.parse(rawJson);
        const rankedTitles = aiResult.titles_output || [];
        
        // Find the title of the week from the list, or use a fallback
        const highestScoringTitle = rankedTitles.reduce((max, t) => {
            const score = parseFloat(t.score);
            return score > parseFloat(max.score || 0) ? t : max;
        }, { score: -1, title: 'Top Pick Unavailable' });

        console.log('✓ AI processing complete.');
        return {
            rankedTitles: rankedTitles,
            titleOfTheWeek: {
                title: highestScoringTitle,
                review: aiResult.review_output
            },
            weeklySummary: aiResult.summary_output,
            topHeadlines: aiResult.headlines_output || FALLBACK_OUTPUT.topHeadlines,
            fallbackUsed: false
        };

    } catch (error) {
        console.error('⚠ AI API call failed or JSON parsing error:', error.message);
        // Fallback required (crash-proof requirement)
        return FALLBACK_OUTPUT;
    }
}

/**
 * Assembles the final message format for Telegram broadcast.
 * @param {object} aiData The processed data from the AI.
 * @returns {string} The final Telegram message text.
 */
function assembleTelegramMessage(aiData) {
    const { rankedTitles, titleOfTheWeek, weeklySummary, topHeadlines, fallbackUsed } = aiData;

    let regionalPicks = [];
    let englishPicks = [];
    let koreanPicks = [];

    // Filter and slice based on category and quotas
    if (Array.isArray(rankedTitles)) {
        regionalPicks = rankedTitles.filter(t => t.category && t.category.toLowerCase().includes('regional')).slice(0, 6);
        englishPicks = rankedTitles.filter(t => t.category && t.category.toLowerCase().includes('english')).slice(0, 4);
        koreanPicks = rankedTitles.filter(t => t.category && t.category.toLowerCase().includes('korean')).slice(0, 2);
    }

    const formatPicks = (picks, targetCount) => {
        let output = '';

        if (picks.length > 0) {
            output = picks.map(t =>
                `\n• **${t.title}** (Score: ${typeof t.score === 'number' ? t.score.toFixed(1) : 'N/A'})` +
                `\n  ${t.details}`
            ).join('\n');
        }

        const remainingSlots = targetCount - picks.length;
        if (remainingSlots > 0 && !fallbackUsed) {
             output += `\n\n(Not enough high-scoring titles this week.)`;
        } else if (picks.length === 0 && !fallbackUsed) {
             output = '   \n(Not enough titles this week worth recommending.)';
        }

        return output;
    };

    const messageParts = [];

    messageParts.push('📅 **WEEKLY OTT DIGEST** (Auto-Generated)\n');

    messageParts.push('🔥 **Top Picks** (12 Titles)');
    messageParts.push(`🇮🇳 **Regional Picks** (${regionalPicks.length}/${6})`);
    messageParts.push(formatPicks(regionalPicks, 6));

    messageParts.push('\n🌍 **English Picks** (4)');
    messageParts.push(formatPicks(englishPicks, 4));

    messageParts.push('\n🇰🇷 **Korean Picks** (2)');
    messageParts.push(formatPicks(koreanPicks, 2));

    messageParts.push('\n---\n');

    messageParts.push(`⭐ **Title of the Week**: ${titleOfTheWeek.title.title || 'Top Pick Unavailable'}`);
    messageParts.push(`> ${titleOfTheWeek.review}`);

    messageParts.push('\n---\n');

    messageParts.push('🧠 **Weekly Summary**');
    messageParts.push(`> ${weeklySummary}`);

    messageParts.push('\n---\n');

    messageParts.push('📰 **Top 5 Headlines**');
    messageParts.push(topHeadlines.map(h => `• ${h}`).join('\n'));

    messageParts.push('\n---\n');

    messageParts.push('Footer:');
    messageParts.push('“Powered by MsquareDigitalhub.com”');

    return messageParts.join('\n');
}

/**
 * Main function to run the digest and broadcast.
 */
async function runDigestAndBroadcast() {
    console.log('--- ➡ Starting OTT Digest Run ---');
    let finalMessage = '⚠ **DIGEST FAILURE**: The broadcast failed to compile a valid message.';

    try {
        // 1. Fetch Data
        const allMovieItems = await fetchAndCleanFeeds([...RSS_FEEDS.movies, ...RSS_FEEDS.webSeries, ...RSS_FEEDS.ott]);
        const allHeadlineItems = await fetchAndCleanFeeds(RSS_FEEDS.headlines);
        
        // 2. Process with AI
        const aiData = await processDataWithAI(allMovieItems, allHeadlineItems);

        // 3. Assemble Message (Crash-proof: message must still send)
        finalMessage = assembleTelegramMessage(aiData);

        // 4. Save Processed Links
        const allItems = [...allMovieItems, ...allHeadlineItems];
        // Only save links that were sent to the AI (or if fallback was used, save nothing new)
        if (!aiData.fallbackUsed) {
            for (const item of allItems) {
                await saveProcessedLink(item.linkHash);
            }
        }
        

        // 5. Broadcast
        if (BOT_TOKEN) {
            try {
                await bot.telegram.sendMessage(GROUP_CHAT_ID, finalMessage, { parse_mode: 'Markdown' });
                console.log('✓ Digest message successfully broadcast to group.');
            } catch (error) {
                console.error(`⚠ Error sending message to group ${GROUP_CHAT_ID}:`, error.message);
                // Log but do NOT crash server (crash-proof requirement)
            }
        } else {
            console.error('⚠ BOT_TOKEN is missing. Cannot broadcast.');
        }

    } catch (error) {
        console.error('⚠ FATAL: Unhandled error during digest process:', error);
        // Fallback: Attempt to send a crash message with minimum text
        try {
            if (BOT_TOKEN) {
                await bot.telegram.sendMessage(GROUP_CHAT_ID, '🚨 **CRASH ALERT**: The scheduled digest failed due to a critical error. Check logs immediately.\nPowered by MsquareDigitalhub.com');
            }
        } catch (e) {
            console.error('⚠ Secondary failure: Could not send crash alert.', e.message);
        }
    } finally {
        console.log('--- ✓ OTT Digest Run Finished ---');
    }
}

// --- ⏱ Cron Schedule ---

// For testing: run digest every 2 minutes
cron.schedule('*/2 * * * *', () => {
    console.log(`\n\n--- ⏱ CRON Triggered at ${new Date().toISOString()} (${TIMEZONE}) ---`);
    runDigestAndBroadcast();
}, {
    scheduled: true,
    timezone: TIMEZONE
});

// --- 👨‍👩‍👧 Telegraf Bot Handlers ---

// Bot only POSTS messages. It never replies to user text.

// Handle new member joining
bot.on('new_chat_members', async (ctx) => {
    try {
        if (ctx.chat.id.toString() === GROUP_CHAT_ID) {
            const welcomeMessage = `
🎉 **Welcome to OTT Pulse India!**
You will receive curated OTT updates, top picks, weekly summaries, and trending news.
Powered by MsquareDigitalhub.com
            `;
            await ctx.reply(welcomeMessage, { parse_mode: 'Markdown' });
            console.log(`✓ Sent welcome message to new member in group ${GROUP_CHAT_ID}.`);
        }
    } catch (error) {
        console.error('⚠ Error handling new member join:', error.message);
    }
});

// Group must remain read-only: delete messages from non-admin users
bot.on('message', async (ctx) => {
    try {
        if (ctx.chat.id.toString() === GROUP_CHAT_ID && ctx.message.from.is_bot === false) {
            // A simpler, safer check for a read-only group is just to delete non-bot messages.
            await ctx.deleteMessage(ctx.message.message_id);
            console.log(`➡ Deleted message from user ${ctx.message.from.username || ctx.message.from.id}. Group is read-only.`);
        }
    } catch (error) {
        // Often throws error if bot lacks delete permission, but server shouldn't crash
        if (!error.message.includes('message can\'t be deleted') && !error.message.includes('not enough rights')) {
             console.error('⚠ Error deleting user message:', error.message);
        }
    }
});

// --- 🌐 Express Webhook and Server Setup ---

// Set the webhook for Render hosting
async function setWebhook() {
    // Only set webhook if URL is provided
    if (!WEBHOOK_URL) {
        console.error('⚠ FATAL: WEBHOOK_URL environment variable is missing. Cannot set webhook.');
        return;
    }

    try {
        const webhookInfo = await bot.telegram.setWebhook(`${WEBHOOK_URL}/secret-path-for-telegraf`);
        console.log(`✓ Webhook set to: ${WEBHOOK_URL}/secret-path-for-telegraf`);
        console.log('➡ Webhook Info:', webhookInfo);
    } catch (error) {
        console.error('⚠ FATAL: Could not set webhook:', error.message);
        // Do NOT crash the server
    }
}

// Webhook route for Telegraf
app.post(`/secret-path-for-telegraf`, (req, res) => {
    try {
        bot.handleUpdate(req.body);
        res.sendStatus(200); // Always respond on webhook route with 200 (crash-proof requirement)
    } catch (error) {
        console.error('⚠ Error handling webhook update:', error.message);
        res.sendStatus(200); // Still send 200 to Telegram
    }
});

// Root route for Render health check
app.get('/', (req, res) => {
    res.status(200).send('OTT Pulse Bot is running and waiting for cron/webhook events.');
});

// Start sequence
async function startServer() {
    await setupDb();
    await setWebhook();

    app.listen(PORT, () => {
        console.log(`✓ Server running on port ${PORT}`);
    });
}

startServer();

// --- Additional error handling to prevent unhandled rejections from crashing the process ---
process.on('unhandledRejection', (reason, promise) => {
  console.error('⚠ Unhandled Rejection at:', promise, 'reason:', reason);
  // Application specific logging
});

process.on('uncaughtException', (err) => {
  console.error('⚠ Uncaught Exception thrown:', err);
  // Log first, then exit process (Render will automatically restart it)
  process.exit(1);
});
