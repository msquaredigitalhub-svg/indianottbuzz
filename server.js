require('dotenv').config();
process.env.TZ = 'Asia/Kolkata'; // IST timezone

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

// ==================== INITIALIZATION ====================
(async () => {
  try {
    db = await JSONFilePreset('db.json', { users: {}, adminId: 0, lastBroadcast: null });
    console.log('✅ Database initialized');
    
    setupHandlers();
    setupCron();
    startServer();
  } catch (error) {
    console.error('❌ Initialization error:', error);
    process.exit(1);
  }
})();

// ==================== WEBHOOK SETUP ====================
function setupHandlers() {
  app.post('/bot', (req, res) => {
    bot.handleUpdate(req.body);
    res.sendStatus(200);
  });

  // Welcome message
  bot.on('my_chat_member', async (ctx) => {
    try {
      if (ctx.update.my_chat_member.new_chat_member.status === 'member') {
        const userId = ctx.from.id;
        
        await ctx.reply('🎬 Welcome to Weekly Movie Updates!\nChoose your language:', {
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
        
        db.data.users[userId] = { 
          lang: 'en', 
          groupId: ctx.chat.id, 
          joined: new Date().toISOString() 
        };
        await db.write();
        console.log(`✅ User ${userId} added`);
      }
    } catch (error) {
      console.error('❌ Error in my_chat_member:', error);
    }
  });

  // Language selection
  bot.action(/^lang_(.+)/, async (ctx) => {
    try {
      const lang = ctx.match[1];
      const userId = ctx.from.id;
      
      if (!db.data.users[userId]) {
        db.data.users[userId] = { lang: 'en', joined: new Date().toISOString() };
      }
      
      db.data.users[userId].lang = lang;
      await db.write();
      
      const langNames = {
        en: 'English', hi: 'Hindi', ta: 'Tamil', ml: 'Malayalam', kn: 'Kannada', te: 'Telugu'
      };
      
      await ctx.answerCbQuery(`Language set to ${langNames[lang]}!`);
      await ctx.reply(`✅ Language set to ${langNames[lang]}!\n\n📅 Testing: Every 2 minutes\n🎥 Regional + Bollywood`);
      console.log(`✅ User ${userId}: ${lang}`);
    } catch (error) {
      console.error('❌ Language handler error:', error);
    }
  });

  // Admin setup
  bot.command('setadmin', async (ctx) => {
    try {
      db.data.adminId = ctx.from.id;
      await db.write();
      await ctx.reply(`✅ Admin: ${ctx.from.id}`);
    } catch (error) {
      console.error('❌ Setadmin error:', error);
    }
  });

  // Broadcast command
  bot.command('broadcast', async (ctx) => {
    try {
      if (ctx.from.id !== db.data.adminId) {
        return ctx.reply('❌ Admin only!');
      }
      
      const message = ctx.message.text.slice(11).trim();
      if (!message) return ctx.reply('Usage: /broadcast your message');
      
      let sent = 0;
      for (let userId in db.data.users) {
        try {
          await bot.telegram.sendMessage(userId, `📢 Admin:\n\n${message}`);
          sent++;
        } catch(e) {
          console.warn(`⚠️ Failed to send to ${userId}`);
        }
      }
      await ctx.reply(`✅ Sent to ${sent} users!`);
    } catch (error) {
      console.error('❌ Broadcast error:', error);
    }
  });

  // Manual trigger
  bot.command('weeklylist', async (ctx) => {
    try {
      await ctx.reply('🔄 Generating weekly movie list...');
      await collectMoviesForWeek();
      await broadcastWeeklyMovies();
      await ctx.reply('✅ Weekly list sent!');
    } catch(error) {
      await ctx.reply(`❌ Error: ${error.message}`);
    }
  });

  // Health check
  app.get('/', (req, res) => {
    res.json({ status: 'Bot alive!', timestamp: new Date().toISOString() });
  });

  // Status
  app.get('/status', (req, res) => {
    res.json({ 
      status: 'running', 
      users: Object.keys(db.data.users).length,
      movies_collected: Object.keys(weeklyMovies).length,
      timestamp: new Date().toISOString()
    });
  });

  console.log('✅ Bot handlers setup');
}

// ==================== VERIFIED WORKING RSS FEEDS ====================
async function collectMoviesForWeek() {
  const feeds = [
    // ========== BOLLYWOOD & HINDI ==========
    { url: 'https://www.bollywoodhungama.com/feed/', label: 'Bollywood Hungama', lang: 'Hindi' },
    { url: 'https://www.filmibeat.com/rss/feeds/bollywood-fb.xml', label: 'FilmiBeat Bollywood', lang: 'Hindi' },
    { url: 'https://timesofindia.indiatimes.com/rssfeedstopstories.cms', label: 'TOI Entertainment', lang: 'Hindi' },
    
    // ========== TAMIL ==========
    { url: 'https://www.filmibeat.com/rss/feeds/tamil-fb.xml', label: 'FilmiBeat Tamil', lang: 'Tamil' },
    { url: 'https://www.filmibeat.com/rss/feeds/tamil-reviews-fb.xml', label: 'FilmiBeat Tamil Reviews', lang: 'Tamil' },
    
    // ========== TELUGU ==========
    { url: 'https://www.filmibeat.com/rss/feeds/telugu-fb.xml', label: 'FilmiBeat Telugu', lang: 'Telugu' },
    { url: 'https://chitrambhalare.in/feed', label: 'Chitram Bhalare', lang: 'Telugu' },
    
    // ========== KANNADA ==========
    { url: 'https://www.filmibeat.com/rss/feeds/kannada-fb.xml', label: 'FilmiBeat Kannada', lang: 'Kannada' },
    
    // ========== MALAYALAM ==========
    { url: 'https://www.filmibeat.com/rss/feeds/malayalam-fb.xml', label: 'FilmiBeat Malayalam', lang: 'Malayalam' },
    
    // ========== ENGLISH ==========
    { url: 'https://www.filmibeat.com/rss/feeds/english-hollywood-fb.xml', label: 'FilmiBeat Hollywood', lang: 'English' },
    { url: 'https://collider.com/feed/', label: 'Collider', lang: 'English' },
    
    // ========== ALL CONTENT ==========
    { url: 'https://www.filmibeat.com/rss/feeds/filmibeat-fb.xml', label: 'FilmiBeat All', lang: 'Mixed' },
  ];
  
  console.log('\n📡 [COLLECTION] Collecting from RSS feeds...\n');
  let feedsSuccess = 0;
  
  for (let feedSource of feeds) {
    try {
      const rss = await parser.parseURL(feedSource.url);
      
      if (rss.items && rss.items.length > 0) {
        let addedCount = 0;
        
        for (let item of rss.items.slice(0, 6)) {
          const title = (item.title || '').trim();
          
          if (title && !weeklyMovies[title]) {
            const detectedLang = feedSource.lang === 'Mixed' ? detectLanguage(title) : feedSource.lang;
            
            weeklyMovies[title] = {
              title,
              link: item.link || '#',
              language: detectedLang,
              platforms: getStreamingPlatforms(detectedLang),
              date: new Date().toISOString(),
              source: feedSource.label
            };
            addedCount++;
          }
        }
        
        if (addedCount > 0) {
          console.log(`   ✅ ${feedSource.label}: +${addedCount}`);
          feedsSuccess++;
        }
      }
    } catch(e) {
      console.log(`   ⚠️ ${feedSource.label}: ${e.message}`);
    }
    
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  
  console.log(`\n📊 Loaded: ${feedsSuccess}/${feeds.length} feeds | Total movies: ${Object.keys(weeklyMovies).length}\n`);
  return weeklyMovies;
}

// Detect language from script
function detectLanguage(title) {
  if (/[\u0B80-\u0BFF]/.test(title)) return 'Tamil';
  if (/[\u0C00-\u0C7F]/.test(title)) return 'Telugu';
  if (/[\u0C80-\u0CFF]/.test(title)) return 'Kannada';
  if (/[\u0D00-\u0D7F]/.test(title)) return 'Malayalam';
  if (/[\u0900-\u097F]/.test(title)) return 'Hindi';
  return 'English';
}

// Get streaming platforms by language
function getStreamingPlatforms(language) {
  const platformsByLanguage = {
    'Tamil': ['ZEE5', 'Sony LIV', 'Sun NXT'],
    'Telugu': ['ZEE5', 'Aha', 'Disney+'],
    'Kannada': ['ZEE5', 'Kannada One'],
    'Malayalam': ['ManoramaMax', 'ZEE5'],
    'Hindi': ['Netflix', 'Amazon Prime', 'Hotstar', 'ZEE5'],
    'English': ['Netflix', 'Amazon Prime', 'Disney+']
  };
  
  return platformsByLanguage[language] || ['Check Locally'];
}

// ==================== FORMAT WEEKLY MOVIE LIST ====================
function formatWeeklyMovieList(userLang) {
  const moviesByLanguage = {};
  
  for (let title in weeklyMovies) {
    const movie = weeklyMovies[title];
    if (!moviesByLanguage[movie.language]) {
      moviesByLanguage[movie.language] = [];
    }
    moviesByLanguage[movie.language].push(movie);
  }
  
  let message = `🎬 <b>Weekly Movie Updates</b>\n`;
  message += `📅 ${new Date().toLocaleDateString('en-IN')}\n`;
  message += `⏰ ${new Date().toLocaleTimeString('en-IN')}\n`;
  message += `📊 Total: ${Object.keys(weeklyMovies).length} movies\n\n`;
  
  const langLabels = {
    'English': '🇺🇸 English / Hollywood',
    'Hindi': '🇮🇳 हिंदी / Bollywood',
    'Tamil': '🇮🇳 தமிழ் / Tamil',
    'Malayalam': '🇮🇳 മലയാളം / Malayalam',
    'Kannada': '🇮🇳 ಕನ್ನಡ / Kannada',
    'Telugu': '🇮🇳 తెలుగు / Telugu'
  };
  
  const sortedLanguages = ['Hindi', 'Tamil', 'Telugu', 'Kannada', 'Malayalam', 'English'].filter(
    lang => moviesByLanguage[lang] && moviesByLanguage[lang].length > 0
  );
  
  for (let language of sortedLanguages) {
    const count = moviesByLanguage[language].length;
    message += `\n<b>${langLabels[language]}</b> (${count})\n`;
    message += `${'─'.repeat(38)}\n`;
    
    moviesByLanguage[language].slice(0, 8).forEach((movie, idx) => {
      const platforms = movie.platforms.join(' • ');
      const title = movie.title.substring(0, 45);
      
      message += `${idx + 1}. <b>${title}</b>\n`;
      message += `   📺 ${platforms}\n\n`;
    });
  }
  
  message += `\n✅ Updated: ${new Date().toLocaleTimeString('en-IN')}`;
  return message;
}

// ==================== CRON SCHEDULING ====================
function setupCron() {
  console.log('\n⏰ CRON SETUP (TESTING MODE):');
  console.log('   📢 Broadcasts every 2 minutes\n');
  
  // ✅ TESTING: Every 2 minutes
  cron.schedule('*/2 * * * *', broadcastWeeklyMovies);
  
  // For production - change to:
  // cron.schedule('0 10 * * 0', broadcastWeeklyMovies); // Sunday 10 AM
}

async function broadcastWeeklyMovies() {
  try {
    console.log(`\n📢 ${new Date().toISOString()} - Broadcasting movies...`);
