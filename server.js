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

(async () => {
  try {
    db = await JSONFilePreset('db.json', { users: {}, adminId: 0 });
    console.log('DB initialized');
    setupHandlers();
    setupCron();
    startServer();
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
})();

function setupHandlers() {
  app.post('/bot', (req, res) => {
    bot.handleUpdate(req.body);
    res.sendStatus(200);
  });

  bot.on('my_chat_member', async (ctx) => {
    try {
      if (ctx.update.my_chat_member.new_chat_member.status === 'member') {
        const userId = ctx.from.id;
        await ctx.reply('Choose language:', {
          reply_markup: {
            inline_keyboard: [
              [{text: 'English', callback_data: 'lang_en'}],
              [{text: 'Hindi', callback_data: 'lang_hi'}],
              [{text: 'Tamil', callback_data: 'lang_ta'}],
            ]
          }
        });
        db.data.users[userId] = { lang: 'en', joined: new Date().toISOString() };
        await db.write();
      }
    } catch (e) {
      console.error(e);
    }
  });

  bot.action(/^lang_(.+)$/, async (ctx) => {
    try {
      const lang = ctx.match[1];
      const userId = ctx.from.id;
      if (!db.data.users[userId]) {
        db.data.users[userId] = { lang: 'en' };
      }
      db.data.users[userId].lang = lang;
      await db.write();
      await ctx.answerCbQuery('Language set');
      await ctx.reply('Updates every 2 minutes');
    } catch (e) {
      console.error(e);
    }
  });

  bot.command('setadmin', async (ctx) => {
    try {
      db.data.adminId = ctx.from.id;
      await db.write();
      await ctx.reply('Admin set');
    } catch (e) {
      console.error(e);
    }
  });

  bot.command('weeklylist', async (ctx) => {
    try {
      await ctx.reply('Generating list...');
      await collectMoviesForWeek();
      await broadcastWeeklyMovies();
    } catch (e) {
      await ctx.reply('Error: ' + e.message);
    }
  });

  app.get('/', (req, res) => {
    res.json({ status: 'alive' });
  });

  app.get('/status', (req, res) => {
    res.json({
      status: 'running',
      users: Object.keys(db.data.users).length,
      movies: Object.keys(weeklyMovies).length
    });
  });

  console.log('Handlers setup');
}

async function collectMoviesForWeek() {
  const feeds = [
    { url: 'https://www.bollywoodhungama.com/feed/', label: 'Bollywood Hungama', lang: 'Hindi' },
    { url: 'https://www.filmibeat.com/rss/feeds/bollywood-fb.xml', label: 'FilmiBeat Bollywood', lang: 'Hindi' },
    { url: 'https://timesofindia.indiatimes.com/rssfeedstopstories.cms', label: 'TOI', lang: 'Hindi' },
    { url: 'https://www.filmibeat.com/rss/feeds/tamil-fb.xml', label: 'FilmiBeat Tamil', lang: 'Tamil' },
    { url: 'https://www.filmibeat.com/rss/feeds/telugu-fb.xml', label: 'FilmiBeat Telugu', lang: 'Telugu' },
    { url: 'https://www.filmibeat.com/rss/feeds/kannada-fb.xml', label: 'FilmiBeat Kannada', lang: 'Kannada' },
    { url: 'https://www.filmibeat.com/rss/feeds/malayalam-fb.xml', label: 'FilmiBeat Malayalam', lang: 'Malayalam' },
    { url: 'https://www.filmibeat.com/rss/feeds/english-hollywood-fb.xml', label: 'Hollywood', lang: 'English' },
    { url: 'https://collider.com/feed/', label: 'Collider', lang: 'English' }
  ];

  console.log('Collecting movies...');
  let success = 0;

  for (let feed of feeds) {
    try {
      const rss = await parser.parseURL(feed.url);
      if (rss.items && rss.items.length > 0) {
        for (let item of rss.items.slice(0, 5)) {
          const title = (item.title || '').trim();
          if (title && !weeklyMovies[title]) {
            weeklyMovies[title] = {
              title: title,
              link: item.link || '#',
              lang: feed.lang,
              platforms: getPlatforms(feed.lang)
            };
          }
        }
        console.log('OK: ' + feed.label);
        success++;
      }
    } catch (e) {
      console.log('Error: ' + feed.label);
    }
    await new Promise(r => setTimeout(r, 300));
  }

  console.log('Loaded: ' + success + ' feeds, ' + Object.keys(weeklyMovies).length + ' movies');
}

function getPlatforms(lang) {
  const p = {
    'Tamil': 'ZEE5, Sony LIV',
    'Telugu': 'ZEE5, Aha',
    'Kannada': 'ZEE5',
    'Malayalam': 'ManoramaMax',
    'Hindi': 'Netflix, Prime, Hotstar',
    'English': 'Netflix, Prime'
  };
  return p[lang] || 'Check locally';
}

function formatMovies() {
  let msg = 'Movie Updates\n\n';
  msg += 'Time: ' + new Date().toLocaleTimeString('en-IN') + '\n';
  msg += 'Total: ' + Object.keys(weeklyMovies).length + ' movies\n\n';

  const langs = ['Hindi', 'Tamil', 'Telugu', 'Kannada', 'Malayalam', 'English'];
  for (let lang of langs) {
    const movies = Object.values(weeklyMovies).filter(m => m.lang === lang);
    if (movies.length === 0) continue;

    msg += lang + ' (' + movies.length + ')\n';
    for (let i = 0; i < Math.min(movies.length, 5); i++) {
      const m = movies[i];
      msg += (i + 1) + '. ' + m.title.substring(0, 40) + '\n';
      msg += '   ' + m.platforms + '\n';
    }
    msg += '\n';
  }
  return msg;
}

async function broadcastWeeklyMovies() {
  try {
    console.log('Broadcasting at ' + new Date().toLocaleTimeString());

    if (Object.keys(weeklyMovies).length === 0) {
      await collectMoviesForWeek();
    }

    let sent = 0;
    const msg = formatMovies();

    for (let userId in db.data.users) {
      try {
        await bot.telegram.sendMessage(userId, msg);
        sent++;
      } catch (e) {
        console.log('Failed: ' + userId);
      }
    }

    console.log('Sent to ' + sent + ' users');
  } catch (e) {
    console.error('Broadcast error: ' + e.message);
  }
}

function setupCron() {
  console.log('Cron: Every 2 minutes');
  cron.schedule('*/2 * * * *', broadcastWeeklyMovies);
}

function startServer() {
  const PORT = process.env.PORT || 3000;
  bot.launch();
  app.listen(PORT, () => {
    console.log('Server on port ' + PORT);
    console.log('Bot ready');
  });
}

process.on('SIGINT', async () => {
  console.log('Shutting down');
  await bot.stop();
  process.exit(0);
});
