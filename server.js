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
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/rss+xml, application/xml, text/xml',
    'Accept-Language': 'en-US,en;q=0.9'
  },
  timeout: 15000,
  maxRedirects: 5
});

let db;
let weeklyMovies = {};

(async () => {
  try {
    db = await JSONFilePreset('db.json', { users: {}, adminId: 0 });
    console.log('✓ DB initialized');
    setupHandlers();
    setupCron();
    startServer();
  } catch (error) {
    console.error('✗ Initialization Error:', error.message);
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
      console.error('✗ my_chat_member error:', e.message);
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
      await ctx.reply('✓ Updates every 2 minutes');
    } catch (e) {
      console.error('✗ lang_action error:', e.message);
    }
  });

  bot.command('setadmin', async (ctx) => {
    try {
      db.data.adminId = ctx.from.id;
      await db.write();
      await ctx.reply('✓ Admin set');
    } catch (e) {
      console.error('✗ setadmin error:', e.message);
    }
  });

  bot.command('weeklylist', async (ctx) => {
    try {
      await ctx.reply('⏳ Generating list...');
      await collectMoviesForWeek();
      await broadcastWeeklyMovies();
    } catch (e) {
      await ctx.reply('✗ Error: ' + e.message);
    }
  });

  app.get('/', (req, res) => {
    res.json({ status: 'alive', timestamp: new Date().toISOString() });
  });

  app.get('/status', (req, res) => {
    res.json({
      status: 'running',
      users: Object.keys(db.data.users).length,
      movies: Object.keys(weeklyMovies).length,
      timestamp: new Date().toISOString()
    });
  });

  console.log('✓ Handlers setup complete');
}

async function parseURLWithRetry(url, label, maxRetries = 3) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      console.log(`  → Fetching ${label} (attempt ${attempt + 1}/${maxRetries + 1})...`);
      const rss = await parser.parseURL(url);
      
      if (!rss) throw new Error('Empty response');

      console.log(`  ✓ ${label}: Successfully parsed (${rss.items?.length || 0} items)`);
      return rss;
      
    } catch (e) {
      const errorCode = e.code || e.message || 'Unknown error';
      
      if (attempt < maxRetries) {
        const waitTime = 500 * Math.pow(2, attempt);
        console.log(`  ⚠ ${label}: Error on attempt ${attempt + 1} - ${errorCode}`);
        console.log(`    Retrying in ${waitTime}ms...`);
        await new Promise(r => setTimeout(r, waitTime));
      } else {
        console.log(`  ✗ ${label}: Failed after ${maxRetries + 1} attempts - ${errorCode}`);
      }
    }
  }
  
  return null;
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
    { url: 'https://www.filmibeat.com/rss/feeds/english-hollywood-fb.xml', label: 'FilmiBeat Hollywood', lang: 'English' },
    { url: 'https://collider.com/feed/', label: 'Collider', lang: 'English' }
  ];

  console.log('\n' + '='.repeat(50));
  console.log('🎬 COLLECTING MOVIES FOR WEEK');
  console.log('='.repeat(50));
  
  let success = 0;
  let failed = 0;
  const startTime = Date.now();

  for (let feed of feeds) {
    try {
      const rss = await parseURLWithRetry(feed.url, feed.label, 3);
      
      if (rss && rss.items && rss.items.length > 0) {
        for (let item of rss.items.slice(0, 5)) {
          const title = (item.title || '').trim();
          
          if (title && !weeklyMovies[title]) {
            weeklyMovies[title] = {
              title: title,
              link: item.link || '#',
              lang: feed.lang,
              platforms: getPlatforms(feed.lang),
              pubDate: item.pubDate || new Date().toISOString()
            };
          }
        }
        success++;
      } else {
        console.log(`  ⚠ ${feed.label}: No items returned`);
        failed++;
      }
      
    } catch (e) {
      console.log(`  ✗ ${feed.label}: Exception - ${e.message}`);
      failed++;
    }
    
    await new Promise(r => setTimeout(r, 1000));
  }

  const duration = ((Date.now() - startTime) / 1000).toFixed(2);
  console.log('\n' + '='.repeat(50));
  console.log(`✓ Collection Complete in ${duration}s`);
  console.log(`  Feeds loaded: ${success}/${feeds.length}`);
  console.log(`  Total movies: ${Object.keys(weeklyMovies).length}`);
  console.log(`  Failed feeds: ${failed}`);
  console.log('='.repeat(50) + '\n');
}

function getPlatforms(lang) {
  const platforms = {
    'Tamil': 'ZEE5, Sony LIV, Amazon Prime',
    'Telugu': 'ZEE5, Aha, Amazon Prime',
    'Kannada': 'ZEE5, Kannada Play',
    'Malayalam': 'ManoramaMax, Amazon Prime',
    'Hindi': 'Netflix, Prime Video, Disney+ Hotstar',
    'English': 'Netflix, Prime Video'
  };
  return platforms[lang] || 'Check available platforms';
}

function formatMovies() {
  let msg = '🎬 *MOVIE UPDATES*\n\n';
  msg += `📅 ${new Date().toLocaleString('en-IN', { 
    weekday: 'short', 
    year: 'numeric', 
    month: 'short', 
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })}\n`;
  msg += `📊 Total: ${Object.keys(weeklyMovies).length} movies\n\n`;
  msg += '─'.repeat(40) + '\n\n';

  const langs = ['Hindi', 'Tamil', 'Telugu', 'Kannada', 'Malayalam', 'English'];
  let hasContent = false;

  for (let lang of langs) {
    const movies = Object.values(weeklyMovies).filter(m => m.lang === lang);
    if (movies.length === 0) continue;

    hasContent = true;
    msg += `🎥 *${lang}* (${movies.length})\n`;
    msg += '─'.repeat(40) + '\n';
    
    for (let i = 0; i < Math.min(movies.length, 5); i++) {
      const m = movies[i];
      msg += `${i + 1}. ${m.title.substring(0, 50)}\n`;
      msg += `   📱 ${m.platforms}\n\n`;
    }
  }

  if (!hasContent) {
    msg += '⚠️ No movies found in feeds\n';
  }

  return msg;
}

async function broadcastWeeklyMovies() {
  try {
    console.log('\n' + '='.repeat(50));
    console.log('📢 BROADCASTING UPDATES');
    console.log(`⏰ ${new Date().toLocaleTimeString('en-IN')}`);
    console.log('='.repeat(50));

    if (Object.keys(weeklyMovies).length === 0) {
      await collectMoviesForWeek();
    }

    let sent = 0;
    let failed = 0;
    const msg = formatMovies();

    const userIds = Object.keys(db.data.users);
    console.log(`📤 Sending to ${userIds.length} user(s)...`);

    for (let userId of userIds) {
      try {
        await bot.telegram.sendMessage(userId, msg, { parse_mode: 'Markdown' });
        sent++;
      } catch (e) {
        console.log(`  ✗ Failed to send to ${userId}: ${e.message}`);
        failed++;
      }
      
      await new Promise(r => setTimeout(r, 100));
    }

    console.log(`✓ Broadcast Complete`);
    console.log(`  Sent: ${sent}/${userIds.length}`);
    console.log(`  Failed: ${failed}`);
    console.log('='.repeat(50) + '\n');
    
  } catch (e) {
    console.error('✗ Broadcast error:', e.message);
  }
}

function setupCron() {
  console.log('\n' + '='.repeat(50));
  console.log('⏰ CRON CONFIGURATION');
  console.log('='.repeat(50));
  console.log('Mode: TESTING - Every 2 minutes');
  console.log('Schedule: */2 * * * *');
  console.log('Timezone: Asia/Kolkata (IST)');
  console.log('='.repeat(50) + '\n');
  
  cron.schedule('*/2 * * * *', () => {
    console.log('\n🔔 Cron triggered at ' + new Date().toLocaleTimeString('en-IN'));
    broadcastWeeklyMovies();
  });
}

function startServer() {
  const PORT = process.env.PORT || 3000;
  const WEBHOOK_URL = process.env.WEBHOOK_URL;

  app.listen(PORT, async () => {
    try {
      console.log('\n' + '='.repeat(50));
      console.log('🚀 SERVER STARTUP');
      console.log('='.repeat(50));
      console.log(`Port: ${PORT}`);
      console.log(`Status: RUNNING`);
      
      if (WEBHOOK_URL) {
        await bot.telegram.setWebhook(WEBHOOK_URL + '/bot');
        console.log(`\n🌐 WEBHOOK CONFIGURATION`);
        console.log(`Mode: WEBHOOK (no polling)`);
        console.log(`Webhook URL: ${WEBHOOK_URL}/bot`);
      } else {
        console.log(`\n⚠️  WARNING: WEBHOOK_URL not configured`);
        console.log(`Add to .env: WEBHOOK_URL=https://your-app.onrender.com`);
      }
      
      console.log('\n📊 API Endpoints:');
      console.log(`  GET  /        - Server status`);
      console.log(`  GET  /status  - Detailed status`);
      console.log(`  POST /bot     - Telegram webhook`);
      
      console.log('\n🤖 Telegram Commands:');
      console.log(`  /setadmin    - Set admin user`);
      console.log(`  /weeklylist  - Generate and broadcast`);
      
      console.log('='.repeat(50) + '\n');
    } catch (e) {
      console.error('✗ Webhook error:', e.message);
    }
  });
}

/* -----------------------------
   🛑 GRACEFUL SHUTDOWN HANDLERS
------------------------------*/

process.on('SIGINT', async () => {
  console.log('\n' + '='.repeat(50));
  console.log('🛑 SHUTDOWN SIGNAL RECEIVED (SIGINT)');
  console.log('Closing bot gracefully...');

  try {
    await bot.stop('SIGINT');
    console.log('✓ Bot stopped');
  } catch (e) {
    console.error('✗ Error stopping bot:', e.message);
  }

  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\n' + '='.repeat(50));
  console.log('🛑 SHUTDOWN SIGNAL RECEIVED (SIGTERM)');
  console.log('Closing bot gracefully...');

  try {
    await bot.stop('SIGTERM');
    console.log('✓ Bot stopped');
  } catch (e) {
    console.error('✗ Error stopping bot:', e.message);
  }

  process.exit(0);
});
