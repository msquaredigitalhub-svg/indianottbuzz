```javascript
require('dotenv').config();
process.env.TZ = 'Asia/Kolkata';

const { Telegraf } = require('telegraf');
const cron = require('node-cron');
const Parser = require('rss-parser');
const { JSONFilePreset } = require('lowdb/node');
const express = require('express');

const app = express();
app.use(express.json());

const bot = new Telegraf(process.env.BOT_TOKEN);
const parser = new Parser({
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
  },
  timeout: 10000
});

let db;
let weeklyMovies = {};

// INITIALIZATION
(async () => {
  try {
    db = await JSONFilePreset('db.json', { users: {}, adminId: 0 });
    console.log('✅ DB initialized');
    setupHandlers();
    setupCron();
    startServer();
  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  }
})();

// BOT HANDLERS
function setupHandlers() {
  app.post('/bot', (req, res) => {
    bot.handleUpdate(req.body);
    res.sendStatus(200);
  });

  bot.on('my_chat_member', async (ctx) => {
    try {
      if (ctx.update.my_chat_member.new_chat_member.status === 'member') {
        const userId = ctx.from.id;
        await ctx.reply('🎬 Welcome! Choose language:', {
          reply_markup: {
            inline_keyboard: [
              [{text: '🇺🇸 English', callback_data: 'lang_en'}],
              [{text: '🇮🇳 हिंदी', callback_data: 'lang_hi'}],
              [{text: '🇮🇳 தமிழ்', callback_data: 'lang_ta'}],
              [{text: '🇮🇳 തെലുഗു', callback_data: 'lang_te'}],
            ]
          }
        });
        db.data.users[userId] = { lang: 'en', joined: new Date().toISOString() };
        await db.write();
      }
    } catch (e) {
      console.error('Error:', e);
    }
  });

  bot.action(/^lang_(.+)$/, async (ctx) => {
    try {
      const lang = ctx.match[1];
      const userId = ctx.from.id;
      db.data.users[userId].lang = lang;
      await db.write();
      await ctx.answerCbQuery('✅ Language set!');
      await ctx.reply('🎬 Updates every 2 minutes (testing)');
    } catch (e) {
      console.error('Error:', e);
    }
  });

  bot.command('setadmin', async (ctx) => {
    db.data.adminId = ctx.from.id;
    await db.write();
    await ctx.reply(`✅ Admin: ${ctx.from.id}`);
  });

  app.get('/', (req, res) => res.json({ status: 'alive' }));
  app.get('/status', (req, res) => res.json({ users: Object.keys(db.data.users).length, movies: Object.keys(weeklyMovies).length }));

  console.log('✅ Handlers setup');
}

// RSS FEEDS
async function collectMoviesForWeek() {
  const feeds = [
    { url: 'https://www.bollywoodhungama.com/feed/', label: 'Bollywood Hungama', lang: 'Hindi' },
    { url: 'https://www.filmibeat.com/rss/feeds/bollywood-fb.xml', label: 'FilmiBeat Bollywood', lang: 'Hindi' },
    { url: 'https://timesofindia.indiatimes.com/rssfeedstopstories.cms', label: 'TOI', lang: 'Hindi' },
    { url: 'https://www.filmibeat.com/rss/feeds/tamil-fb.xml', label: 'FilmiBeat Tamil', lang: 'Tamil' },
    { url: 'https://www.filmibeat.com/rss/feeds/telugu-fb.xml', label: 'FilmiBeat Telugu', lang: 'Telugu' },
    { url: 'https://www.filmibeat.com/rss/feeds/kannada-fb.xml', label: 'FilmiBeat Kannada', lang: 'Kannada' },
    { url: 'https://www.filmibeat.com/rss/feeds/malayalam-fb.xml', label: 'FilmiBeat Malayalam', lang: 'Malayalam' },
    { url: 'https://www.filmibeat.com/rss/feeds/english-hollywood-fb.xml', label: 'FilmiBeat Hollywood', lang: 'English' },
  ];

  console.log('\n📡 Collecting movies...');
  let success = 0;

  for (let feed of feeds) {
    try {
      const rss = await parser.parseURL(feed.url);
      if (rss.items && rss.items.length > 0) {
        for (let item of rss.items.slice(0, 5)) {
          const title = (item.title || '').trim();
          if (title && !weeklyMovies[title]) {
            weeklyMovies[title] = {
              title,
              link: item.link || '#',
              lang: feed.lang,
              platforms: getPlatforms(feed.lang)
            };
          }
        }
        console.log(`✅ ${feed.label}: OK`);
        success++;
      }
    } catch (e) {
      console.log(`⚠️ ${feed.label}: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 300));
  }

  console.log(`✅ Loaded: ${success}/${feeds.length} | Movies: ${Object.keys(weeklyMovies).length}\n`);
}

function getPlatforms(lang) {
  const p = {
    'Tamil': ['ZEE5', 'Sony LIV'],
    'Telugu': ['ZEE5', 'Aha'],
    'Kannada': ['ZEE5'],
    'Malayalam': ['ManoramaMax'],
    'Hindi': ['Netflix', 'Prime', 'Hotstar'],
    'English': ['Netflix', 'Prime']
  };
  return (p[lang] || ['Check']).join(' • ');
}

function formatMovies() {
  let msg = `🎬 <b>Movie Updates</b>\n`;
  msg += `⏰ ${new Date().toLocaleTimeString('en-IN')}\n`;
  msg += `📊 Total: ${Object.keys(weeklyMovies).length} movies\n\n`;

  const langs = ['Hindi', 'Tamil', 'Telugu', 'Kannada', 'Malayalam', 'English'];
  for (let lang of langs) {
    const movies = Object.values(weeklyMovies).filter(m => m.lang === lang);
    if (movies.length === 0) continue;
    
    msg += `<b>${lang} (${movies.length})</b>\n`;
    movies.slice(0, 5).forEach((m, i) => {
      msg += `${i+1}. ${m.title.substring(0, 40)}\n   📺 ${m.platforms}\n`;
    });
    msg += '\n';
  }
  return msg;
}

// BROADCAST
async function broadcastWeeklyMovies() {
  try {
    console.log(`\n📢 ${new Date().toLocaleTimeString()} - Broadcasting...`);
    
    if (Object.keys(weeklyMovies).length === 0) {
      await collectMoviesForWeek();
    }

    let sent = 0;
    const msg = formatMovies();

    for (let userId in db.data.users) {
      try {
        await bot.telegram.sendMessage(userId, msg, { parse_mode: 'HTML' });
        sent++;
      } catch (e) {
        console.warn(`⚠️ Failed: ${userId}`);
      }
    }

    console.log(`✅ Sent to ${sent} users\n`);
  } catch (e) {
    console.error('❌ Broadcast error:', e);
  }
}

// CRON
function setupCron() {
  console.log('⏰ CRON: Every 2 minutes (testing)\n');
  cron.schedule('*/2 * * * *', broadcastWeeklyMovies);
  // For production: cron.schedule('0 10 * * 0', broadcastWeeklyMovies);
}

// SERVER
function startServer() {
  const PORT = process.env.PORT || 3000;
  bot.launch();
  app.listen(PORT, () => {
    console.log(`✅ Server on port ${PORT}`);
    console.log(`🤖 Movie Bot ready!`);
  });
}

process.on('SIGINT', async () => {
  console.log('\nShutting down...');
  await bot.stop();
  process.exit(0);
});
```

**Key changes:**
- ✅ Complete & fully closed code (no missing braces)
- ✅ Simplified structure
- ✅ Tests every 2 minutes with `*/2 * * * *`
- ✅ All functions properly closed
- ✅ Ready to deploy

