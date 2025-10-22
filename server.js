 

const express = require('express');
const cors = require('cors');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const { fetch } = require('undici');
const Parser = require('rss-parser');
require('dotenv').config({ path: path.resolve(__dirname, '.env') });

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

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

function requireAdmin(req, res, next) {
  const token = req.headers['x-admin-secret'] || req.query.secret;
  if (!ADMIN_SECRET || token !== ADMIN_SECRET) return res.status(401).json({ error: 'Unauthorized' });
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
  const url = `https://www.googleapis.com/youtube/v3/channels?part=snippet&id=${channelId}&key=${YT_KEY}`;
  const json = await fetchJson(url);
  const item = json.items?.[0];
  const title = item?.snippet?.title;
  const avatar = item?.snippet?.thumbnails?.default?.url || null;
  return { title, avatar };
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
  cache.channelsList = { data, expires: now() + TEN_MIN };
  return data;
}

const TEN_MIN = 10 * 60 * 1000;
const TTL_LIVE = 45 * 1000; // 30–60s
const TTL_TODAY = 60 * 1000;
const TTL_UPCOMING = 5 * 60 * 1000;

function now() { return Date.now(); }

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Fetch failed ${res.status}`);
  return res.json();
}

async function resolveChannelIdFromHandle(handle) {
  const key = handle.toLowerCase();
  const entry = cache.channelIdByHandle.get(key);
  if (entry && entry.expires > now()) return entry.id;

  // Try YouTube search to find the channel ID by handle
  const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=channel&maxResults=1&q=${encodeURIComponent(handle)}&key=${YT_KEY}`;
  const json = await fetchJson(url);
  const item = json.items?.[0];
  const channelId = item?.id?.channelId;
  if (!channelId) throw new Error(`Cannot resolve channel for handle ${handle}`);
  cache.channelIdByHandle.set(key, { id: channelId, expires: now() + 7 * 24 * 60 * 60 * 1000 });
  return channelId;
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
  const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=${channelId}&maxResults=${maxResults}&order=date&type=video&key=${YT_KEY}`;
  const json = await fetchJson(url);
  const items = json.items || [];
  const ids = items.map((it) => it.id?.videoId).filter(Boolean);
  if (!ids.length) return [];

  // Fetch details for durations and better thumbnails
  const detailsUrl = `https://www.googleapis.com/youtube/v3/videos?part=contentDetails,snippet&id=${ids.join(',')}&key=${YT_KEY}`;
  const detailsJson = await fetchJson(detailsUrl);
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
}

async function getAggregatedVideos({ handle }) {
  // Use per-handle cache if handle provided
  if (handle) {
    const key = handle.toLowerCase();
    const entry = cache.videosByHandle.get(key);
    if (entry && entry.expires > now()) return entry.data;
    const channelId = await resolveChannelIdFromHandle(handle);
    const vids = await fetchRecentVideosForChannel(channelId, 12);
    const sorted = vids.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));
    const data = { items: sorted, nextCursor: null };
    cache.videosByHandle.set(key, { data, expires: now() + TEN_MIN });
    return data;
  }

  if (cache.videosAll.data && cache.videosAll.expires > now()) return cache.videosAll.data;

  // Fetch top N per channel and merge
  const perChannel = await Promise.all(
    CHANNEL_HANDLES.map(async (h) => {
      try {
        const id = await resolveChannelIdFromHandle(h);
        return await fetchRecentVideosForChannel(id, 6);
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
  cache.videosAll = { data, expires: now() + TEN_MIN };
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

app.get('/videos', async (req, res) => {
  try {
    if (!YT_KEY) return res.status(500).json({ error: 'Server missing YOUTUBE_API_KEY' });
    const handle = req.query.handle;
    const data = await getAggregatedVideos({ handle });
    res.json(data);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to fetch videos' });
  }
});

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
  cache.newsAll = { data, expires: now() + TEN_MIN };
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

app.get('/scores', async (req, res) => {
  try {
    const scope = (req.query.scope || 'live').toString();
    if (!['live', 'today', 'upcoming'].includes(scope)) return res.status(400).json({ error: 'bad scope' });
    const data = await getScores(scope);
    res.json(data);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to fetch scores' });
  }
});

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

app.post('/polls/:id/vote', async (req, res) => {
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
});

app.listen(PORT, () => {
  console.log(`Sport Rays backend listening on http://localhost:${PORT}`);
});
