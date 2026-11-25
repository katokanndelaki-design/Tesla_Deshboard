const express = require('express');
const cors = require('cors');
const path = require('path');
const YouTube = require('youtube-sr').default;
const ytdl = require('@distube/ytdl-core');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// In-memory pairing sessions (Code -> { command, updatedAt })
const sessions = new Map();

// Clean up old pairing sessions every 30 mins
setInterval(() => {
  const now = Date.now();
  for (const [code, data] of sessions.entries()) {
    if (now - data.updatedAt > 1000 * 60 * 60 * 4) {
      sessions.delete(code);
    }
  }
}, 1000 * 60 * 30);

// 1. Dynamic Search & Feed Endpoint
app.get('/api/search', async (req, res) => {
  try {
    const query = (req.query.q || '').trim();
    const topics = [
      'Deep House Mix 2026',
      'Tesla Cybertruck Review',
      '4K Nature Relaxing Video',
      'Ambient Chillout Music Mix',
      'Tech News Highlights'
    ];
    const searchQuery = query || topics[Math.floor(Math.random() * topics.length)];

    const videos = await YouTube.search(searchQuery, {
      limit: 12,
      type: 'video',
      safeSearch: false
    });

    const formatted = videos.map((v) => ({
      id: v.id,
      title: v.title || 'Untitled Video',
      channel: v.channel?.name || 'YouTube',
      duration: v.durationFormatted || 'LIVE',
      views: v.views ? `${Math.round(v.views / 1000)}K views` : '',
      thumbnail: v.thumbnail?.url || `https://i.ytimg.com/vi/${v.id}/hqdefault.jpg`
    }));

    res.json({ query: searchQuery, items: formatted });
  } catch (err) {
    console.error('Search error:', err.message);
    res.status(500).json({ error: 'Search failed', details: err.message });
  }
});

// 2. Direct MP4 Stream Proxy for Tesla HTML5 <video> Player
app.get('/api/stream', async (req, res) => {
  const videoId = req.query.v;
  if (!videoId || !ytdl.validateID(videoId)) {
    return res.status(400).send('Invalid video ID');
  }

  try {
    const url = `https://www.youtube.com/watch?v=${videoId}`;
    const info = await ytdl.getInfo(url);

    // Choose combined audio+video format (MP4) compatible with Chromium/Tesla
    const format = ytdl.chooseFormat(info.formats, {
      quality: 'highest',
      filter: (f) => f.container === 'mp4' && f.hasVideo && f.hasAudio
    });

    if (!format || !format.url) {
      return res.status(404).send('No compatible MP4 stream found');
    }

    // Forward Range headers for seeking/scrubbing support
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    };
    if (req.headers.range) {
      headers.Range = req.headers.range;
    }

    const upstream = await fetch(format.url, { headers });

    res.status(upstream.status);
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'video/mp4');
    res.setHeader('Accept-Ranges', 'bytes');

    const contentLength = upstream.headers.get('content-length');
    const contentRange = upstream.headers.get('content-range');
    if (contentLength) res.setHeader('Content-Length', contentLength);
    if (contentRange) res.setHeader('Content-Range', contentRange);

    if (!upstream.body) {
      return res.end();
    }

    const reader = upstream.body.getReader();
    req.on('close', () => {
      reader.cancel().catch(() => {});
    });

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
    res.end();
  } catch (err) {
    console.error('Stream error:', err.message);
    if (!res.headersSent) {
      res.status(500).send('Stream extraction failed: ' + err.message);
    }
  }
});

// 3. Pairing API: Car registers code or polls for commands
app.get('/api/pair/:code', (req, res) => {
  const code = req.params.code.toUpperCase();
  if (!sessions.has(code)) {
    sessions.set(code, { command: null, updatedAt: Date.now() });
  }
  const session = sessions.get(code);
  const cmd = session.command;
  // Clear command once read by car
  if (cmd) {
    session.command = null;
  }
  res.json({ connected: true, command: cmd });
});

// 4. Pairing API: Phone sends video/search/url to Car
app.post('/api/pair/:code', (req, res) => {
  const code = req.params.code.toUpperCase();
  const { action, payload } = req.body;
  sessions.set(code, {
    command: { action, payload, ts: Date.now() },
    updatedAt: Date.now()
  });
  res.json({ ok: true });
});

// Fallback to index.html
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`TeslaMedia Server running on port ${PORT}`);
});
