# Sport Rays Backend

Production-hardened API backend for Sport Rays mobile app.

## Security Features

✅ **Helmet.js** - Security headers (XSS, clickjacking protection)  
✅ **Rate limiting** - 100 req/15min general, 20 req/15min for voting  
✅ **Input validation** - express-validator on all user inputs  
✅ **Compression** - gzip responses  
✅ **Request timeouts** - 10s timeout on external API calls  
✅ **Constant-time auth** - Timing-safe admin secret comparison  
✅ **CORS restrictions** - Configurable origin whitelist  
✅ **Body size limits** - 10KB max to prevent DoS  
✅ **Error handling** - Global error handler, no stack traces in production  
✅ **Graceful shutdown** - SIGTERM/SIGINT handlers  

## Environment Variables

Required in production:
```
NODE_ENV=production
YOUTUBE_API_KEY=your_key
API_FOOTBALL_KEY=your_key
ALL_SPORTS_API_KEY=your_key
SUPABASE_URL=your_url
SUPABASE_SERVICE_ROLE_KEY=your_key
ADMIN_SECRET=strong_random_secret
```

## Installation

```bash
npm install
```

## Development

```bash
npm run dev
```

## Production

```bash
NODE_ENV=production npm start
```

## API Endpoints

### Public
- `GET /` - API info
- `GET /health` - Health check
- `GET /videos?handle=@channel` - YouTube videos
- `GET /channels` - Channel list
- `GET /news` - Aggregated news
- `GET /scores?scope=live|today|upcoming` - Live scores
- `GET /polls/active?device=hash` - Active poll
- `POST /polls/:id/vote` - Vote on poll

### Admin (requires x-admin-secret header)
- `GET /admin` - Admin panel UI
- `GET /admin/polls` - List polls
- `POST /admin/polls` - Create poll
- `POST /admin/polls/:id/activate` - Activate
- `POST /admin/polls/:id/deactivate` - Deactivate

## Rate Limits

- General: 100 requests per 15 minutes per IP
- Voting: 20 requests per 15 minutes per IP

## Caching

- Videos: 10 minutes
- Channels: 10 minutes
- News: 10 minutes
- Live scores: 45 seconds
- Today scores: 60 seconds
- Upcoming scores: 5 minutes

## Deployment (Render)

1. Push to GitHub
2. Render auto-deploys from main branch
3. Set environment variables in Render dashboard
4. Health check: `/health`

## Security Notes

- Never commit `.env` file
- Rotate API keys periodically
- Use strong ADMIN_SECRET (32+ chars)
- Monitor rate limit logs for abuse
- Review error logs regularly
