 

const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const { body, query, param, validationResult } = require('express-validator');
const morgan = require('morgan');
const cors = require('cors');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const { fetch } = require('undici');
const Parser = require('rss-parser');
require('dotenv').config({ path: path.resolve(__dirname, '.env') });

const app = express();

// Security middleware
app.use(helmet({
  contentSecurityPolicy: false,  // Allow inline scripts for admin panel
  crossOriginEmbedderPolicy: false
}));
app.use(compression());
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

// CORS - restrict to your domain in production
const corsOptions = {
  origin: process.env.NODE_ENV === 'production'
    ? ['https://sportrays-backend.onrender.com', /\.sportrays\./]
    : '*',
  credentials: true,
  maxAge: 86400
};
app.use(cors(corsOptions));

// Body parsing with size limits
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: true, limit: '10kb' }));

// Static files
app.use(express.static(path.join(__dirname, 'public')));

// Trust proxy (required for rate limiting behind Render/Heroku)
app.set('trust proxy', 1);

// Rate limiting
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: { error: 'Too many requests, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const strictLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20, // stricter limit for write operations
  message: { error: 'Too many requests, please try again later.' }
});

app.use('/api/', generalLimiter); // Apply to all API routes
app.use('/polls/:id/vote', strictLimiter); // Stricter limit for voting

const PORT = process.env.PORT || 3001;
const YT_KEY = process.env.YOUTUBE_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const API_FOOTBALL_KEY = process.env.API_FOOTBALL_KEY;
const ALL_SPORTS_API_KEY = process.env.ALL_SPORTS_API_KEY;
const ADMIN_SECRET = process.env.ADMIN_SECRET;

if (!YT_KEY) console.warn('Warning: YOUTUBE_API_KEY is not set');
if (!SUPABASE_URL) console.warn('Warning: SUPABASE_URL is not set');
if (!SUPABASE_ANON_KEY) console.warn('Warning: SUPABASE_ANON_KEY is not set');
if (!SUPABASE_SERVICE_ROLE_KEY) console.warn('Warning: SUPABASE_SERVICE_ROLE_KEY is not set');
if (!API_FOOTBALL_KEY) console.warn('Warning: API_FOOTBALL_KEY is not set');
if (!ALL_SPORTS_API_KEY) console.warn('Warning: ALL_SPORTS_API_KEY is not set');

const supabaseAdmin = SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
  : null;

// Async error wrapper
const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

// Validation error handler
const handleValidation = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: 'Invalid input', details: errors.array() });
  }
  next();
};

// Admin authentication with rate limiting protection
function requireAdmin(req, res, next) {
  const token = req.headers['x-admin-secret'] || req.query.secret;
  if (!ADMIN_SECRET) {
    return res.status(503).json({ error: 'Admin功能 temporarily unavailable' });
  }
  // Use constant-time comparison to prevent timing attacks
  const tokenBuffer = Buffer.from(token || '', 'utf8');
  const secretBuffer = Buffer.from(ADMIN_SECRET, 'utf8');
  const match = tokenBuffer.length === secretBuffer.length &&
    crypto.timingSafeEqual(tokenBuffer, secretBuffer);
  if (!match) {
    // Add small delay to slow down brute force
    return setTimeout(() => res.status(401).json({ error: 'Unauthorized' }), 1000);
  }
  next();
}

// Channels list
const CHANNEL_HANDLES = [
  '@ACMilan',
  '@fifa',
  '@premierleague',
  '@supersport',
  '@realmadrid',
  '@FCBarcelona',
  '@mancity',
  '@Juventus',
  '@chelseafc',
  '@LiverpoolFC',
  '@arsenal',
  '@seriea',
  '@bundesliga',
  '@LaLiga',
  '@Ligue1',
];

// In-memory caches
const cache = {
  channelIdByHandle: new Map(), // handle -> { id, expires }
  videosAll: { data: null, expires: 0 },
  videosByHandle: new Map(), // handle -> { data, expires }
  channelsList: { data: null, expires: 0 },
  newsAll: { data: null, expires: 0 },
  scores: {
    live: { data: null, expires: 0 },
    today: { data: null, expires: 0 },
    upcoming: { data: null, expires: 0 },
  },
};

async function fetchChannelDetails(channelId) {
  if (!canMakeApiCall('channels')) {
    throw new Error('YouTube API quota limit reached for channel details');
  }
  
  try {
    const url = `https://www.googleapis.com/youtube/v3/channels?part=snippet&id=${channelId}&key=${YT_KEY}`;
    const json = await fetchJson(url);
    recordQuotaUsage('channels');
    
    const item = json.items?.[0];
    const title = item?.snippet?.title;
    const avatar = item?.snippet?.thumbnails?.default?.url || null;
    return { title, avatar };
  } catch (e) {
    console.error('Failed to fetch channel details:', e.message);
    throw e;
  }
}

async function getChannelsList() {
  if (cache.channelsList.data && cache.channelsList.expires > now()) return cache.channelsList.data;

  const list = [];
  for (const handle of CHANNEL_HANDLES) {
    try {
      const channelId = await resolveChannelIdFromHandle(handle);
      const details = await fetchChannelDetails(channelId);
      list.push({ handle, channelId, title: details.title, avatar: details.avatar });
    } catch (e) {
      console.warn('Channel details failed', handle, e.message);
      list.push({ handle, channelId: null, title: handle.replace('@', ''), avatar: null });
    }
  }
  const data = { items: list };
  cache.channelsList = { data, expires: now() + TTL_CHANNELS };
  return data;
}

// Smart cache TTLs with quota-aware management
const ONE_HOUR = 60 * 60 * 1000;
const TEN_MIN = 10 * 60 * 1000;
const TTL_VIDEOS = 48 * 60 * 60 * 1000; // 48 hours (increased from 24)
const TTL_CHANNELS = 12 * 60 * 60 * 1000; // 12 hours (increased from 6)
const TTL_CHANNEL_ID = 7 * 24 * 60 * 60 * 1000; // 1 week for channel ID resolution
const TTL_NEWS = 15 * 60 * 1000; // 15 minutes
const TTL_LIVE = 45 * 1000;
const TTL_TODAY = 60 * 1000;
const TTL_UPCOMING = 5 * 60 * 1000;

function now() { return Date.now(); }

async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeout || 10000);
  try {
    const res = await fetch(url, {
      ...options,
      signal: controller.signal
    });
    clearTimeout(timeout);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') throw new Error('Request timeout');
    throw err;
  }
}

async function resolveChannelIdFromHandle(handle) {
  const key = handle.toLowerCase();
  const entry = cache.channelIdByHandle.get(key);
  if (entry && entry.expires > now()) return entry.id;

  if (!canMakeApiCall('search')) {
    console.warn(`Cannot resolve channel ${handle} - quota limit reached`);
    if (entry && entry.id) return entry.id; // Use stale data
    throw new Error(`Cannot resolve channel ${handle} - quota limit reached`);
  }

  try {
    // Try YouTube search to find the channel ID by handle
    const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=channel&maxResults=1&q=${encodeURIComponent(handle)}&key=${YT_KEY}`;
    const json = await fetchJson(url);
    recordQuotaUsage('search');
    
    const item = json.items?.[0];
    const channelId = item?.id?.channelId;
    if (!channelId) throw new Error(`Cannot resolve channel for handle ${handle}`);
    cache.channelIdByHandle.set(key, { id: channelId, expires: now() + TTL_CHANNEL_ID });
    return channelId;
  } catch (e) {
    console.error(`Failed to resolve channel ${handle}:`, e.message);
    // Return stale data if available
    if (entry && entry.id) {
      console.warn(`Using stale channel ID for ${handle}`);
      return entry.id;
    }
    throw e;
  }
}

function isoDurationToSeconds(iso) {
  // Simple ISO8601 duration parser for PT#H#M#S
  const m = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(iso || '') || [];
  const h = parseInt(m[1] || '0', 10);
  const min = parseInt(m[2] || '0', 10);
  const s = parseInt(m[3] || '0', 10);
  return h * 3600 + min * 60 + s;
}

async function fetchRecentVideosForChannel(channelId, maxResults = 10) {
  if (!canMakeApiCall('search') || !canMakeApiCall('videos')) {
    throw new Error('YouTube API quota limit reached');
  }

  try {
    const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=${channelId}&maxResults=${maxResults}&order=date&type=video&key=${YT_KEY}`;
    const json = await fetchJson(url);
    recordQuotaUsage('search');
    
    const items = json.items || [];
    const ids = items.map((it) => it.id?.videoId).filter(Boolean);
    if (!ids.length) return [];

    // Fetch details for durations and better thumbnails
    const detailsUrl = `https://www.googleapis.com/youtube/v3/videos?part=contentDetails,snippet&id=${ids.join(',')}&key=${YT_KEY}`;
    const detailsJson = await fetchJson(detailsUrl);
    recordQuotaUsage('videos');
    
    const byId = new Map(detailsJson.items.map((it) => [it.id, it]));

    return ids
      .map((id) => {
        const d = byId.get(id);
        if (!d) return null;
        return {
          id,
          url: `https://www.youtube.com/watch?v=${id}`,
          title: d.snippet?.title,
          channel: {
            id: d.snippet?.channelId,
            name: d.snippet?.channelTitle,
            avatar: null,
          },
          thumbnails: {
            sm: d.snippet?.thumbnails?.medium?.url || d.snippet?.thumbnails?.default?.url,
            md: d.snippet?.thumbnails?.high?.url || d.snippet?.thumbnails?.medium?.url,
          },
          durationSec: isoDurationToSeconds(d.contentDetails?.duration),
          publishedAt: d.snippet?.publishedAt,
        };
      })
      .filter(Boolean);
  } catch (e) {
    console.error('Failed to fetch videos for channel', channelId, e.message);
    throw e;
  }
}

// Track API quota usage
let apiQuotaUsed = 0;
let quotaResetTime = now() + 24 * 60 * 60 * 1000; // Reset daily
const MAX_DAILY_QUOTA = 10000; // YouTube API default quota
const QUOTA_SAFETY_MARGIN = 1000; // Reserve some quota

function estimateQuotaCost(operation) {
  const costs = {
    search: 100,
    videos: 1,
    channels: 1
  };
  return costs[operation] || 1;
}

function canMakeApiCall(operation) {
  if (now() > quotaResetTime) {
    apiQuotaUsed = 0;
    quotaResetTime = now() + 24 * 60 * 60 * 1000;
  }
  const cost = estimateQuotaCost(operation);
  return (apiQuotaUsed + cost) < (MAX_DAILY_QUOTA - QUOTA_SAFETY_MARGIN);
}

function recordQuotaUsage(operation) {
  apiQuotaUsed += estimateQuotaCost(operation);
  console.log(`YouTube API quota used: ${apiQuotaUsed}/${MAX_DAILY_QUOTA}`);
}

async function getAggregatedVideos({ handle }) {
  // Use per-handle cache if handle provided
  if (handle) {
    const key = handle.toLowerCase();
    const entry = cache.videosByHandle.get(key);
    if (entry && entry.expires > now()) return entry.data;
    
    // Check quota before making API calls
    if (!canMakeApiCall('search') || !canMakeApiCall('videos')) {
      console.warn('YouTube API quota limit reached, serving stale data if available');
      if (entry && entry.data) {
        // Extend cache and serve stale data
        cache.videosByHandle.set(key, { data: entry.data, expires: now() + TTL_VIDEOS });
        return entry.data;
      }
      return { items: [], nextCursor: null };
    }
    
    try {
      const channelId = await resolveChannelIdFromHandle(handle);
      const vids = await fetchRecentVideosForChannel(channelId, 12);
      const sorted = vids.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));
      const data = { items: sorted, nextCursor: null };
      cache.videosByHandle.set(key, { data, expires: now() + TTL_VIDEOS });
      return data;
    } catch (e) {
      console.warn('Failed to fetch videos for handle', handle, e.message);
      // Return stale data if available
      if (entry && entry.data) return entry.data;
      return { items: [], nextCursor: null };
    }
  }

  if (cache.videosAll.data && cache.videosAll.expires > now()) return cache.videosAll.data;

  // Check quota for bulk operation
  const estimatedCost = CHANNEL_HANDLES.length * (estimateQuotaCost('search') + estimateQuotaCost('videos'));
  if (apiQuotaUsed + estimatedCost > (MAX_DAILY_QUOTA - QUOTA_SAFETY_MARGIN)) {
    console.warn('YouTube API quota limit reached, serving stale data if available');
    if (cache.videosAll.data) {
      // Extend cache and serve stale data
      cache.videosAll = { data: cache.videosAll.data, expires: now() + TTL_VIDEOS };
      return cache.videosAll.data;
    }
    return { items: [], nextCursor: null };
  }

  // Fetch top N per channel and merge with error handling
  const perChannel = await Promise.all(
    CHANNEL_HANDLES.map(async (h) => {
      try {
        const id = await resolveChannelIdFromHandle(h);
        const videos = await fetchRecentVideosForChannel(id, 6);
        return videos;
      } catch (e) {
        console.warn('Channel fetch failed', h, e.message);
        return [];
      }
    })
  );

  const merged = perChannel.flat();
  merged.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));
  const limited = merged.slice(0, 60);
  const data = { items: limited, nextCursor: null };
  cache.videosAll = { data, expires: now() + TTL_VIDEOS };
  return data;
}

// Root endpoint
app.get('/', (_req, res) => {
  res.json({
    name: 'Sport Rays API',
    version: '1.0.0',
    status: 'running',
    endpoints: {
      health: '/health',
      videos: '/videos?handle=@premierleague (optional)',
      channels: '/channels',
      news: '/news',
      scores: '/scores?scope=live|today|upcoming',
      polls: {
        active: '/polls/active',
        vote: 'POST /polls/:id/vote',
        results: '/polls/:id/results'
      },
      admin: '/admin (requires secret)'
    }
  });
});

app.get('/health', (_req, res) => res.json({ ok: true }));

// Debug endpoint (remove in production)
app.get('/debug/youtube', asyncHandler(async (req, res) => {
  if (!YT_KEY) return res.status(500).json({ error: 'No YouTube API key configured' });
  
  try {
    // Check quota status first
    const quotaStatus = {
      used: apiQuotaUsed,
      max: MAX_DAILY_QUOTA,
      remaining: MAX_DAILY_QUOTA - apiQuotaUsed,
      resetTime: new Date(quotaResetTime).toISOString(),
      canMakeCall: canMakeApiCall('search')
    };

    if (!canMakeApiCall('search')) {
      return res.json({
        success: false,
        error: 'YouTube API quota limit reached',
        quota: quotaStatus,
        suggestion: 'Wait for quota reset or increase daily quota limit'
      });
    }

    // Test basic YouTube API call
    const testUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=channel&maxResults=1&q=@premierleague&key=${YT_KEY}`;
    const result = await fetchJson(testUrl);
    recordQuotaUsage('search');
    
    res.json({ 
      success: true, 
      quota: quotaStatus,
      channelFound: result.items?.length > 0,
      cacheStatus: {
        videosAll: cache.videosAll.data ? 'cached' : 'empty',
        channelsList: cache.channelsList.data ? 'cached' : 'empty',
        channelIds: cache.channelIdByHandle.size
      },
      testResult: result
    });
  } catch (err) {
    res.status(500).json({ 
      error: err.message,
      quota: {
        used: apiQuotaUsed,
        max: MAX_DAILY_QUOTA,
        remaining: MAX_DAILY_QUOTA - apiQuotaUsed
      },
      suggestion: 'Check YouTube API key and quota at https://console.cloud.google.com/apis/api/youtube.googleapis.com'
    });
  }
}));

// Quota status endpoint
app.get('/debug/quota', (req, res) => {
  res.json({
    youtube: {
      used: apiQuotaUsed,
      max: MAX_DAILY_QUOTA,
      remaining: MAX_DAILY_QUOTA - apiQuotaUsed,
      resetTime: new Date(quotaResetTime).toISOString(),
      canMakeCall: canMakeApiCall('search')
    },
    cache: {
      videosAll: {
        hasData: !!cache.videosAll.data,
        expires: cache.videosAll.expires ? new Date(cache.videosAll.expires).toISOString() : null,
        itemCount: cache.videosAll.data?.items?.length || 0
      },
      channelsList: {
        hasData: !!cache.channelsList.data,
        expires: cache.channelsList.expires ? new Date(cache.channelsList.expires).toISOString() : null,
        itemCount: cache.channelsList.data?.items?.length || 0
      },
      channelIds: cache.channelIdByHandle.size,
      videosByHandle: cache.videosByHandle.size
    }
  });
});

app.get('/videos', [
  query('handle').optional().isString().trim().isLength({ max: 100 }),
  handleValidation
], asyncHandler(async (req, res) => {
  try {
    if (!YT_KEY) return res.status(500).json({ error: 'Server missing YOUTUBE_API_KEY' });
    const handle = req.query.handle;
    const data = await getAggregatedVideos({ handle });
    res.json(data);
  } catch (e) {
    console.error('Videos error:', e.message);
    res.status(500).json({ error: 'Failed to fetch videos' });
  }
}));

app.get('/channels', async (_req, res) => {
  try {
    if (!YT_KEY) return res.status(500).json({ error: 'Server missing YOUTUBE_API_KEY' });
    const data = await getChannelsList();
    res.json(data);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to fetch channels' });
  }
});

// RSS aggregation
const RSS_FEEDS = [
  { url: 'https://www.fifa.com/rss-feeds/news', source: 'FIFA' },
  { url: 'https://www.goal.com/feeds/en/news', source: 'Goal' },
  { url: 'https://www.skysports.com/rss/12040', source: 'Sky Sports Football' },
  { url: 'https://www.espn.com/espn/rss/soccer/news', source: 'ESPN FC' },
  { url: 'https://www.si.com/rss/section/soccer', source: 'Sports Illustrated' },
  { url: 'https://www.bbc.com/sport/football/rss.xml', source: 'BBC Football' },
  { url: 'https://www.theguardian.com/football/rss', source: 'The Guardian Football' },
  { url: 'https://feeds.reuters.com/reuters/soccerNews', source: 'Reuters Soccer' },
  { url: 'https://www.independent.co.uk/sport/football/rss', source: 'The Independent Football' },
  { url: 'https://rss.nytimes.com/services/xml/rss/nyt/Soccer.xml', source: 'NYTimes Soccer' },
  { url: 'https://www.premierleague.com/news.rss', source: 'Premier League' },
  { url: 'https://feeds.bbci.co.uk/sport/football/rss.xml', source: 'BBC Football' },
  { url: 'https://www.liverpoolfc.com/news/rss.xml', source: 'Liverpool FC' },
  { url: 'https://www.manutd.com/rss/news', source: 'Man Utd' },
  { url: 'https://www.arsenal.com/rss-news-feed', source: 'Arsenal' },
  { url: 'https://www.chelseafc.com/en/rss/news', source: 'Chelsea' },
  { url: 'https://www.tottenhamhotspur.com/feeds/rss/news.xml', source: 'Tottenham' },
  { url: 'https://www.evertonfc.com/rss.xml', source: 'Everton' },
  { url: 'https://www.westhamunited.com/rss.xml', source: 'West Ham' },
  { url: 'https://www.mancity.com/news.rss', source: 'Man City' },
  { url: 'https://www.realmadrid.com/en/rss/rss.xml', source: 'Real Madrid' },
  { url: 'https://www.fcbarcelona.com/feeds/rss/news', source: 'FC Barcelona' },
  { url: 'https://www.acmilan.com/en/news/rss.xml', source: 'AC Milan' },
  { url: 'https://www.inter.it/en/rss.xml', source: 'Inter' },
  { url: 'https://www.juventus.com/en/news/rss.xml', source: 'Juventus' },
  { url: 'https://fcbayern.com/en/news/rss.xml', source: 'Bayern' },
  { url: 'https://www.bundesliga.com/en/news/rssfeed', source: 'Bundesliga' },
  { url: 'https://www.laliga.com/en-GB/rss/news', source: 'LaLiga' },
  { url: 'https://www.psg.fr/news/feed', source: 'PSG' },
  { url: 'https://www.ligue1.com/rss.xml', source: 'Ligue 1' },
];

const parser = new Parser({ timeout: 10000 });

function getImageFromItem(item) {
  if (item?.enclosure?.url) return item.enclosure.url;
  const media = item?.['media:content'] || item?.media || item?.image;
  if (media?.url) return media.url;
  const html = item?.content || item?.['content:encoded'] || '';
  const m = /<img[^>]+src=["']([^"']+)["']/i.exec(html);
  if (m && m[1]) return m[1];
  return null;
}

async function aggregateNews() {
  if (cache.newsAll.data && cache.newsAll.expires > now()) return cache.newsAll.data;
  const results = [];
  await Promise.all(
    RSS_FEEDS.map(async (f) => {
      try {
        const feed = await parser.parseURL(f.url);
        for (const it of feed.items || []) {
          results.push({
            id: it.link || `${f.source}:${it.guid || it.title}`,
            url: it.link,
            title: it.title,
            image: getImageFromItem(it),
            source: f.source,
            publishedAt: it.isoDate || it.pubDate || null,
            summary: it.contentSnippet || it.summary || null,
          });
        }
      } catch (e) {
        console.warn('RSS failed', f.url, e.message);
      }
    })
  );
  // Deduplicate by URL
  const seen = new Set();
  const unique = [];
  for (const r of results) {
    const key = r.url || r.id;
    if (key && !seen.has(key)) {
      seen.add(key);
      unique.push(r);
    }
  }
  unique.sort((a, b) => new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0));
  const limited = unique.slice(0, 150);
  const data = { items: limited, nextCursor: null };
  cache.newsAll = { data, expires: now() + TTL_NEWS };
  return data;
}

app.get('/news', async (_req, res) => {
  try {
    const data = await aggregateNews();
    res.json(data);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to fetch news' });
  }
});

// Live scores providers
function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

async function fetchScoresApiFootball(scope) {
  if (!API_FOOTBALL_KEY) throw new Error('API_FOOTBALL_KEY missing');
  const base = 'https://v3.football.api-sports.io';
  const headers = { 'x-apisports-key': API_FOOTBALL_KEY };
  let url = '';
  const today = isoDate(new Date());
  if (scope === 'live') url = `${base}/fixtures?live=all`;
  else if (scope === 'today') url = `${base}/fixtures?date=${today}`;
  else if (scope === 'upcoming') {
    const from = today;
    const to = isoDate(new Date(Date.now() + 3 * 24 * 60 * 60 * 1000));
    url = `${base}/fixtures?from=${from}&to=${to}`;
  } else throw new Error('bad scope');
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`api-football ${res.status}`);
  const j = await res.json();
  const arr = j.response || [];
  return arr.map((m) => ({
    id: `${m.fixture?.id}`,
    league: m.league?.name || 'League',
    country: m.league?.country || '',
    datetime: m.fixture?.date || null,
    status: m.fixture?.status?.short || m.fixture?.status?.long || '',
    minute: m.fixture?.status?.elapsed || null,
    home: {
      id: `${m.teams?.home?.id || ''}`,
      name: m.teams?.home?.name || 'Home',
      logo: m.teams?.home?.logo || null,
      goals: m.goals?.home ?? null,
    },
    away: {
      id: `${m.teams?.away?.id || ''}`,
      name: m.teams?.away?.name || 'Away',
      logo: m.teams?.away?.logo || null,
      goals: m.goals?.away ?? null,
    },
  }));
}

async function fetchScoresAllSports(scope) {
  if (!ALL_SPORTS_API_KEY) throw new Error('ALL_SPORTS_API_KEY missing');
  const base = 'https://apiv2.allsportsapi.com/football';
  const today = isoDate(new Date());
  let url = '';
  if (scope === 'live') url = `${base}/?met=Livescore&APIkey=${ALL_SPORTS_API_KEY}`;
  else if (scope === 'today') url = `${base}/?met=Fixtures&from=${today}&to=${today}&APIkey=${ALL_SPORTS_API_KEY}`;
  else if (scope === 'upcoming') {
    const to = isoDate(new Date(Date.now() + 3 * 24 * 60 * 60 * 1000));
    url = `${base}/?met=Fixtures&from=${today}&to=${to}&APIkey=${ALL_SPORTS_API_KEY}`;
  } else throw new Error('bad scope');
  const res = await fetch(url);
  if (!res.ok) throw new Error(`allsports ${res.status}`);
  const j = await res.json();
  const arr = j.result || j.events || [];
  return arr.map((m) => ({
    id: `${m.event_key || m.match_id || m.event_id || m.fixture_id || m.id}`,
    league: m.league_name || m.league?.name || 'League',
    country: m.country_name || m.country || '',
    datetime: m.event_date_start || m.event_date || m.match_time || m.date || null,
    status: m.event_status || m.status || '',
    minute: m.event_live_minute || m.live_minute || null,
    home: {
      id: `${m.home_team_key || ''}`,
      name: m.event_home_team || m.home_team || 'Home',
      logo: m.home_team_logo || null,
      goals: m.event_final_result ? parseInt((m.event_final_result+'').split('-')[0]) : (m.home_team_goals ?? null),
    },
    away: {
      id: `${m.away_team_key || ''}`,
      name: m.event_away_team || m.away_team || 'Away',
      logo: m.away_team_logo || null,
      goals: m.event_final_result ? parseInt((m.event_final_result+'').split('-')[1]) : (m.away_team_goals ?? null),
    },
  }));
}

async function getScores(scope) {
  const nowMs = now();
  const bucket = cache.scores[scope] || { data: null, expires: 0 };
  if (bucket.data && bucket.expires > nowMs) return bucket.data;
  const ttl = scope === 'live' ? TTL_LIVE : scope === 'today' ? TTL_TODAY : TTL_UPCOMING;
  // Try primary provider first
  let items = [];
  try {
    items = await fetchScoresApiFootball(scope);
  } catch (e) {
    console.warn('API-Football failed', scope, e.message);
    try {
      items = await fetchScoresAllSports(scope);
    } catch (e2) {
      console.warn('AllSports failed', scope, e2.message);
      items = [];
    }
  }
  const data = { items };
  cache.scores[scope] = { data, expires: nowMs + ttl };
  return data;
}

app.get('/scores', [
  query('scope').optional().isIn(['live', 'today', 'upcoming']),
  handleValidation
], asyncHandler(async (req, res) => {
  try {
    const scope = (req.query.scope || 'live').toString();
    if (!['live', 'today', 'upcoming'].includes(scope)) return res.status(400).json({ error: 'bad scope' });
    const data = await getScores(scope);
    res.json(data);
  } catch (e) {
    console.error('Scores error:', e.message);
    res.status(500).json({ error: 'Failed to fetch scores' });
  }
}));

// Minimal admin endpoints for polls (secured by ADMIN_SECRET)
app.get('/admin', requireAdmin, (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/admin/polls', requireAdmin, async (_req, res) => {
  try {
    if (!supabaseAdmin) return res.status(500).json({ error: 'Supabase not configured' });
    const { data, error } = await supabaseAdmin.from('polls').select('*').order('created_at', { ascending: false });
    if (error) throw error;
    res.json({ items: data });
  } catch (e) {
    console.error(e); res.status(500).json({ error: 'Failed to list polls' });
  }
});

app.post('/admin/polls', requireAdmin, async (req, res) => {
  try {
    if (!supabaseAdmin) return res.status(500).json({ error: 'Supabase not configured' });
    const { question, options, startsAt, endsAt, isActive } = req.body || {};
    const { data: poll, error: insErr } = await supabaseAdmin
      .from('polls')
      .insert({ question, starts_at: startsAt, ends_at: endsAt, is_active: !!isActive })
      .select('*')
      .single();
    if (insErr) throw insErr;
    if (Array.isArray(options)) {
      const rows = options.map((t, i) => ({ poll_id: poll.id, text: t, order: i + 1 }));
      const { error: optErr } = await supabaseAdmin.from('poll_options').insert(rows);
      if (optErr) throw optErr;
    }
    res.json({ ok: true, pollId: poll.id });
  } catch (e) {
    console.error(e); res.status(500).json({ error: 'Failed to create poll' });
  }
});

app.post('/admin/polls/:id/activate', requireAdmin, async (req, res) => {
  try {
    const id = req.params.id;
    const { error } = await supabaseAdmin.from('polls').update({ is_active: true }).eq('id', id);
    if (error) throw error; res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Failed' }); }
});

app.post('/admin/polls/:id/deactivate', requireAdmin, async (req, res) => {
  try {
    const id = req.params.id;
    const { error } = await supabaseAdmin.from('polls').update({ is_active: false }).eq('id', id);
    if (error) throw error; res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Failed' }); }
});

app.get('/polls/active', async (req, res) => {
  try {
    if (!supabaseAdmin) return res.json(null);
    const device = (req.query.device || '').toString();
    const nowIso = new Date().toISOString();

    const { data: poll, error: pollErr } = await supabaseAdmin
      .from('polls')
      .select('id, question, starts_at, ends_at, is_active')
      .eq('is_active', true)
      .lte('starts_at', nowIso)
      .gte('ends_at', nowIso)
      .order('starts_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (pollErr) throw pollErr;
    if (!poll) return res.json(null);

    const { data: options, error: optErr } = await supabaseAdmin
      .from('poll_options')
      .select('id, text, order')
      .eq('poll_id', poll.id)
      .order('order', { ascending: true });
    if (optErr) throw optErr;

    const { data: votes, error: voteErr } = await supabaseAdmin
      .from('poll_votes')
      .select('option_id, device_hash')
      .eq('poll_id', poll.id);
    if (voteErr) throw voteErr;

    const counts = new Map();
    let hasVoted = false;
    let selectedOptionId = null;
    for (const v of votes) {
      counts.set(v.option_id, (counts.get(v.option_id) || 0) + 1);
      if (device && v.device_hash === device) {
        hasVoted = true;
        selectedOptionId = v.option_id;
      }
    }

    res.json({
      id: poll.id,
      question: poll.question,
      endsAt: poll.ends_at,
      hasVoted,
      selectedOptionId,
      options: options.map((o) => ({ id: o.id, text: o.text, votes: counts.get(o.id) || 0 })),
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to fetch poll' });
  }
});

app.post('/polls/:id/vote', [
  param('id').isUUID(),
  body('optionId').isUUID(),
  body('deviceIdHash').isString().isLength({ min: 32, max: 128 }),
  handleValidation
], asyncHandler(async (req, res) => {
  try {
    if (!supabaseAdmin) return res.status(500).json({ error: 'Polls not configured' });
    const pollId = req.params.id;
    const { optionId, deviceIdHash } = req.body || {};
    if (!optionId || !deviceIdHash) return res.status(400).json({ error: 'Missing optionId/deviceIdHash' });

    // Insert vote with unique constraint on (poll_id, device_hash)
    const { error: insErr } = await supabaseAdmin.from('poll_votes').insert({
      poll_id: pollId,
      option_id: optionId,
      device_hash: deviceIdHash,
    });
    if (insErr && !(`${insErr.message}`.includes('duplicate') || `${insErr.details}`.includes('already exists'))) {
      throw insErr;
    }

    // Return updated totals
    const { data: options, error: optErr } = await supabaseAdmin
      .from('poll_options')
      .select('id, text')
      .eq('poll_id', pollId);
    if (optErr) throw optErr;

    const { data: votes, error: voteErr } = await supabaseAdmin
      .from('poll_votes')
      .select('option_id')
      .eq('poll_id', pollId);
    if (voteErr) throw voteErr;

    const totals = Object.fromEntries(options.map((o) => [o.id, 0]));
    for (const v of votes) totals[v.option_id] = (totals[v.option_id] || 0) + 1;

    res.json({ ok: true, totals });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to vote' });
  }
}));

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  const status = err.status || err.statusCode || 500;
  const message = process.env.NODE_ENV === 'production'
    ? 'Internal server error'
    : err.message;
  res.status(status).json({ error: message });
});

// Start server
const server = app.listen(PORT, () => {
  console.log(`Sport Rays backend listening on http://localhost:${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM signal received: closing HTTP server');
  server.close(() => {
    console.log('HTTP server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('\nSIGINT signal received: closing HTTP server');
  server.close(() => {
    console.log('HTTP server closed');
    process.exit(0);
  });
});
