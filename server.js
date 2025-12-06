require('dotenv').config();
process.env.TZ = 'Asia/Kolkata'; // IST timezone

const { Telegraf } = require('telegraf');
const cron = require('node-cron');
const Parser = require('rss-parser');
const { JSONFilePreset } = require('lowdb/node');
const path = require('path');
const express = require('express');

const app = express();
app.use(express.json());
const bot = new Telegraf(process.env.BOT_TOKEN);
const parser = new Parser();

// Database setup
let db;
(async () => {
  db = await JSONFilePreset('db.json', { users: {}, adminId: 0 });
})();

// Webhook endpoint for Render
app.post('/bot', (req, res) => {
  bot.handleUpdate(req.body);
  res.sendStatus(200);
});

// Welcome + language on group join
bot.on('my_chat_member', async (ctx) => {
  if (ctx.update.my_chat_member.new_chat_member.status === 'member') {
    const userId = ctx.from.id;
    await ctx.reply('🎬 Welcome to Movie Updates!\nChoose your language:', {
      reply_markup: {
        inline_keyboard: [
          [{text: '🇺🇸 English', callback_data: 'lang_en'}],
          [{text: '🇮🇳 हिंदी', callback_data: 'lang_hi'}],
          [{text: '🇮🇳 தமிழ்', callback_data: 'lang_ta'}],
          [{text: '🇮🇳 മലയാളം', callback_data: 'lang_ml'}],
          [{text: '🇮🇳 ಕನ್ನಡ', callback_data: 'lang_kn'}],
          [{text: '🇮🇳 తెలుగు', callback_data: 'lang_te'}]
        ]
      }
    });
    db.data.users[userId] = { lang: 'en', groupId: ctx.chat.id, joined: new Date().toISOString() };
    await db.write();
  }
});

// Language selection handler
bot.action(/^lang_(.+)/, async (ctx) => {
  const lang = ctx.match[1];
  const userId = ctx.from.id;
  db.data.users[userId].lang = lang;
  await db.write();
  
  const langNames = {
    en: 'English', hi: 'Hindi', ta: 'Tamil', ml: 'Malayalam', kn: 'Kannada', te: 'Telugu'
  };
  await ctx.answerCbQuery(`Language set to ${langNames[lang]}!`);
  await ctx.reply(`✅ Language set to ${langNames[lang]}!\n\n📅 Updates: Tue/Fri 10AM IST\n🎥 All languages: English, Korean, Hindi, Tamil, Malayalam, Kannada, Telugu`);
});

// Admin broadcast command
bot.command('broadcast', async (ctx) => {
  if (ctx.from.id != db.data.adminId) {
    return ctx.reply('❌ Admin only!');
  }
  const message = ctx.message.text.slice(11).trim();
  if (!message) return ctx.reply('Usage: /broadcast your message');
  
  let sent = 0;
  for (let userId in db.data.users) {
    try {
      await bot.telegram.sendMessage(userId, `📢 Admin Message:\n\n${message}`);
      sent++;
    } catch(e) {
      console.log(`Failed to send to ${userId}`);
    }
  }
  ctx.reply(`✅ Sent to ${sent} users!`);
});

// Set admin (run once: /setadmin YOUR_TELEGRAM_ID)
bot.command('setadmin', async (ctx) => {
  db.data.adminId = ctx.from.id;
  await db.write();
  ctx.reply(`✅ Admin set to ${ctx.from.id}`);
});

// Movie news fetch (Google News RSS + NDTV)
async function fetchMovieNews() {
  const feeds = [
    'https://news.google.com/rss/topics/CAAqKggKIiRDQkFTRlFvSUwyMHZNRFZxYUdjU0JXVnVMVWRDR2dKVGlnQVZ5Z0FQAQ?hl=en-IN&gl=IN&ceid=IN:en', // India Movies
    'https://news.google.com/rss/search?q=korean+movies+OR+k-drama+when:7d&hl=en-IN&gl=IN&ceid=IN:en-IN', // Korean
    'https://movies.ndtv.com/rss', // English/Indian [web:17]
    'https://timesofindia.indiatimes.com/rssfeedstopstories.cms' // Hindi/Regional
  ];
  
  let allNews = [];
  for (let feed of feeds) {
    try {
      const rss = await parser.parseURL(feed);
      allNews.push(...rss.items.slice(0, 3).map(i => `🎥 ${i.title}\n🔗 ${i.link}`));
    } catch(e) {
      console.log(`RSS error: ${feed}`);
    }
  }
  return allNews.slice(0, 8).join('\n\n'); // Top 8 stories
}

// Language-specific formatting
function formatNews(news, lang) {
  const prefixes = {
    en: '🎬 Movie Updates (Tue/Fri)',
    hi: '🎬 मूवी अपडेट्स (मंगल/शुक्र)',
    ta: '🎬 திரைப்பட செய்திகள் (செ/வெ)',
    ml: '🎬 സിനിമാ വാർത്തകൾ (ചൊ/വെ)',
    kn: '🎬 ಸಿನಿಮಾ ಸುದ್ದಿ (ಬ/ಶು)',
    te: '🎬 సినిమా అప్‌డేట్స్ (మం/శుక్ర)'
  };
  return `${prefixes[lang] || prefixes.en}\n\n${news}`;
}

// Scheduled broadcasts: Tue/Fri 10AM IST
cron.schedule('* * * * *', async () => {
  console.log('Sending movie updates...');
  const news = await fetchMovieNews();
  
  for (let userId in db.data.users) {
    const user = db.data.users[userId];
    const langMsg = formatNews(news, user.lang);
    try {
      await bot.telegram.sendMessage(userId, langMsg, { parse_mode: 'HTML' });
    } catch(e) {
      console.log(`Failed broadcast to ${userId}: ${e.message}`);
    }
  }
  console.log('Broadcast complete');
});

// Health check endpoint
app.get('/', (req, res) => res.send('Bot alive!'));

// Start bot + server
bot.launch();
app.listen(3000, () => console.log('Bot running on Render'));
console.log('Movie News Bot started!');
