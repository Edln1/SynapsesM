// ── StemSplit stem-separation routes ──────────────────────────────────
// Drop into your existing Express app (same one running synbot-whatsapp-2
// on Render). Requires: npm install multer (if not already installed for
// other upload routes) and node's built-in fetch (Node 18+).
//
// ENV VARS needed on Render:
//   STEMSPLIT_API_KEY = sk_live_xxxxxxxxxxxxxxxxxxxxx
//
// Wire-up (in your main server file):
//   const stemsplitRoutes = require('./stemsplit-routes');
//   app.use('/api/stems', stemsplitRoutes);

const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const router = express.Router();

const TICKETS = new Map();

// ── Plain YouTube → mp3 (no stem split, no StemSplit credits) ──────────
// This now shells out to the REAL yt-dlp standalone binary (downloaded to
// ./bin/yt-dlp at build time by scripts/fetch-ytdlp.js — see that file and
// the "postinstall" line it needs in package.json). That binary is a
// PyInstaller build that embeds its own Python — no system Python/apt
// install needed, so this still runs on Render's native Node buildpack,
// no Dockerfile migration required.
//
// This replaces @distube/ytdl-core on purpose. The JS fork can only ever
// speak to YouTube as the plain "web" client — that's the exact client
// YouTube's bot-check ("Sign in to confirm you're not a bot") hits
// hardest. Real yt-dlp supports impersonating other YouTube clients via
// --extractor-args "youtube:player_client=...", and the android/ios app
// clients frequently clear that check with NO cookie at all, because the
// check is applied per-client, not purely per-IP. This was never actually
// tried before — the JS library has no equivalent option.
//
// ffmpeg still comes from the ffmpeg-static npm package (unchanged) —
// yt-dlp is pointed at it via --ffmpeg-location, no system ffmpeg needed.
let ffmpegStaticPath;
try {
  ffmpegStaticPath = require('ffmpeg-static');
} catch (e) {
  console.warn('[STEMS] ffmpeg-static not installed — add it to package.json and redeploy');
}

const YTDLP_BIN = path.join(__dirname, 'bin', 'yt-dlp');

const YT_MP3_DIR = path.join(os.tmpdir(), 'yt-mp3-cache');
try { fs.mkdirSync(YT_MP3_DIR, { recursive: true }); } catch (e) {}

function isYoutubeUrl(u) {
  return /^https?:\/\/(www\.|m\.)?(youtube\.com|youtu\.be)\//i.test(String(u || ''));
}

// ── Reliability: client-attempt fallback chain ─────────────────────────
// Order: android client (free, no cookie) -> ios client (free, no cookie)
// -> default web client + cookie (only if YOUTUBE_COOKIE is set on Render).
// First attempt that produces a file wins; a 429 on any one client gets a
// couple of retries with backoff before moving to the next client.
//
// Proxy support (optional): set YTDLP_PROXIES on Render to a comma-separated
// list of proxy URLs, e.g. from Webshare's free tier (10 proxies, 1GB/mo,
// no card needed — stemsplit.io/... no wait, webshare.io/free-proxy):
//   YTDLP_PROXIES=http://user:pass@p.webshare.io:80,http://user:pass@p.webshare.io:81,...
// If set, each client attempt below is tried once with NO proxy first (in
// case Render's own IP happens to work for that request), then once more
// through a proxy picked round-robin from the list. Free tier is datacenter
// IPs, not residential — YouTube treats datacenter ranges harshly too, so
// this is a real but unguaranteed extra shot, not a fix.
const CLIENT_ATTEMPTS = [
  { client: 'android', useCookie: false },
  { client: 'ios', useCookie: false },
  { client: 'web', useCookie: true }, // no-op if YOUTUBE_COOKIE isn't set
];

let proxyRotationIndex = 0;
function getProxyList() {
  return String(process.env.YTDLP_PROXIES || '')
    .split(',')
    .map(function (s) { return s.trim(); })
    .filter(Boolean);
}
function nextProxy() {
  const list = getProxyList();
  if (!list.length) return null;
  const p = list[proxyRotationIndex % list.length];
  proxyRotationIndex++;
  return p;
}

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

function is429Error(err) {
  return /429|too many requests|rate.?limit/i.test((err && err.message) || '');
}

function runYtdlpOnce(args) {
  return new Promise(function (resolve, reject) {
    if (!fs.existsSync(YTDLP_BIN)) {
      return reject(new Error(
        'yt-dlp binary missing at ' + YTDLP_BIN +
        ' — scripts/fetch-ytdlp.js (package.json "postinstall") has not run yet on this deploy. Redeploy to trigger it.'
      ));
    }
    const proc = spawn(YTDLP_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', function (d) { stderr += d.toString(); });
    proc.on('error', reject);
    proc.on('close', function (code) {
      if (code === 0) return resolve();
      reject(new Error(stderr.trim().slice(-800) || ('yt-dlp exited with code ' + code)));
    });
  });
}

// yt-dlp wants cookies in Netscape cookies.txt format, not a raw header
// string — YOUTUBE_COOKIE env var stays exactly the same, just reformatted
// here right before use, then the temp file is deleted.
function cookieHeaderToNetscapeFile(rawCookieHeader) {
  const lines = ['# Netscape HTTP Cookie File'];
  String(rawCookieHeader).split(';').forEach(function (pair) {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    const name = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    if (!name) return;
    lines.push(['.youtube.com', 'TRUE', '/', 'TRUE', '2147483647', name, value].join('\t'));
  });
  const filePath = path.join(os.tmpdir(), 'yt-cookie-' + crypto.randomBytes(6).toString('hex') + '.txt');
  fs.writeFileSync(filePath, lines.join('\n') + '\n');
  return filePath;
}

async function downloadWithFallback(baseArgs) {
  const cookie = process.env.YOUTUBE_COOKIE;
  const hasProxies = getProxyList().length > 0;
  let lastErr;

  for (const attempt of CLIENT_ATTEMPTS) {
    if (attempt.useCookie && !cookie) continue; // nothing to fall back to without one

    // Each client is tried without a proxy first, then (if any are
    // configured) once more through a proxy — two real shots per client.
    const proxyPasses = hasProxies ? [false, true] : [false];

    for (const useProxy of proxyPasses) {
      const args = baseArgs.slice();
      args.push('--extractor-args', `youtube:player_client=${attempt.client}`);

      let cookieFile = null;
      // Don't pair cookies with a non-web client — mixing player_client=android
      // or ios with a real browser session cookie can invalidate that cookie.
      if (attempt.useCookie) {
        cookieFile = cookieHeaderToNetscapeFile(cookie);
        args.push('--cookies', cookieFile);
      }
      if (useProxy) {
        const proxy = nextProxy();
        if (proxy) args.push('--proxy', proxy);
      }

      const delays = [2000, 5000]; // retry the SAME client/proxy on 429 before moving on
      let succeeded = false;
      for (let i = 0; i <= delays.length; i++) {
        try {
          await runYtdlpOnce(args);
          succeeded = true;
          break;
        } catch (err) {
          lastErr = err;
          if (is429Error(err) && i < delays.length) { await sleep(delays[i]); continue; }
          break; // not a 429, or out of retries on this pass — try next
        }
      }
      if (cookieFile) fs.unlink(cookieFile, function () {});
      if (succeeded) return;
    }
  }
  throw lastErr || new Error('all yt-dlp client/proxy attempts failed');
}

// 3) Cache by video ID — if the same video gets requested again (by you
//    while testing, or by any two users), skip hitting YouTube a second
//    time entirely and just hand back the file already on disk.
const YT_CACHE = new Map(); // videoId+format -> { outputs, ts }
const YT_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6h — matches the temp-file cleanup window

function extractVideoId(url) {
  const m = String(url || '').match(/(?:v=|youtu\.be\/|shorts\/)([a-zA-Z0-9_-]{11})/);
  return m ? m[1] : null;
}
function cacheGet(videoId, format) {
  const hit = YT_CACHE.get(videoId + ':' + format);
  if (!hit) return null;
  if (Date.now() - hit.ts > YT_CACHE_TTL_MS) { YT_CACHE.delete(videoId + ':' + format); return null; }
  // Confirm the file is actually still on disk (survives until cleanup timer fires)
  const localPath = path.join(YT_MP3_DIR, hit.fileId + (format === 'mp4' ? '.mp4' : '.mp3'));
  if (!fs.existsSync(localPath)) { YT_CACHE.delete(videoId + ':' + format); return null; }
  return hit;
}
function cacheSet(videoId, format, fileId) {
  YT_CACHE.set(videoId + ':' + format, { fileId, ts: Date.now() });
}

function runYtdlToMp3(youtubeUrl, outPath) {
  const args = [
    youtubeUrl,
    '-x', '--audio-format', 'mp3', '--audio-quality', '192K',
    '-o', outPath,
    '--no-playlist', '--quiet', '--no-warnings',
  ];
  if (ffmpegStaticPath) args.push('--ffmpeg-location', ffmpegStaticPath);
  return downloadWithFallback(args).then(function () { return outPath; });
}

// Video+audio → mp4. yt-dlp handles the "separate video/audio streams above
// 720p" merge itself via --merge-output-format — no manual muxing needed.
// NOTE: video files are much bigger than audio-only (tens to 100+ MB vs a
// few MB) — slower downloads, more disk/bandwidth on Render than the mp3 path.
function runYtdlToMp4(youtubeUrl, outPath) {
  const args = [
    youtubeUrl,
    '-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
    '--merge-output-format', 'mp4',
    '-o', outPath,
    '--no-playlist', '--quiet', '--no-warnings',
  ];
  if (ffmpegStaticPath) args.push('--ffmpeg-location', ffmpegStaticPath);
  return downloadWithFallback(args).then(function () { return outPath; });
}

function scheduleTicketFileCleanup(filePath, ms) {
  setTimeout(function () {
    fs.unlink(filePath, function () {});
  }, ms || 30 * 60 * 1000).unref();
}

let local = {
  probe: async () => ({ python: false, demucs: false, ytdlp: false }),
  getJob: () => null,
  stemFile: () => null,
  createFromUrl: async () => { throw new Error('local engine not on this server'); },
  createFromBuffer: async () => { throw new Error('local engine not on this server'); },
  jobPublic: (_req, job) => job,
};
try {
  local = require('./stems-local');
} catch (e) {
  console.warn('[STEMS] stems-local.js not present — StemSplit only');
}

const MAX_UPLOAD_BYTES = 80 * 1024 * 1024;

function collectRawBody(req) {
  return new Promise(function (resolve, reject) {
    const chunks = [];
    let total = 0;
    req.on('data', function (c) {
      total += c.length;
      if (total > MAX_UPLOAD_BYTES) {
        reject(new Error('File is over 80MB'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', function () { resolve(Buffer.concat(chunks)); });
    req.on('error', reject);
  });
}

const STEMSPLIT_KEY = process.env.STEMSPLIT_API_KEY;
const STEMSPLIT_BASE = 'https://stemsplit.io/api/v1';

function engineMode() {
  return String(process.env.STEMS_ENGINE || 'stemsplit').toLowerCase();
}
async function useLocal() {
  return engineMode() === 'local' && typeof local.createFromBuffer === 'function';
}
function noEnginePayload() {
  return {
    error: 'STEMSPLIT_API_KEY is not set on the server. Add it in Render → Environment, then redeploy.',
    engine: 'none',
  };
}

function stemsplitHeaders(extra = {}) {
  return {
    Authorization: `Bearer ${STEMSPLIT_KEY}`,
    ...extra,
  };
}

router.get('/engine', async (_req, res) => {
  const p = await local.probe();
  const mode = engineMode();
  const loc = await useLocal();
  res.json({
    ok: true,
    engine: loc ? 'local' : (STEMSPLIT_KEY ? 'stemsplit' : 'none'),
    mode,
    python: p.python,
    pythonVersion: p.pythonVersion || null,
    demucs: p.demucs,
    ytdlp: p.ytdlp,
    stemsplit: !!STEMSPLIT_KEY,
    // Free youtube→mp3 path: true once scripts/fetch-ytdlp.js has downloaded
    // the yt-dlp binary (postinstall) AND ffmpeg-static is installed.
    youtubeToMp3: !!(fs.existsSync(YTDLP_BIN) && ffmpegStaticPath),
  });
});

// Browser uploads the file straight to StemSplit storage (avoids Render's request timeout).
router.post('/upload-slot', express.json(), async (req, res) => {
  try {
    if (!STEMSPLIT_KEY) return res.status(501).json(noEnginePayload());
    const filename = (req.body && req.body.filename) || 'upload.mp3';
    const contentType = (req.body && req.body.contentType) || 'audio/mpeg';
    const up = await fetch(`${STEMSPLIT_BASE}/upload`, {
      method: 'POST',
      headers: stemsplitHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ filename, contentType }),
    });
    const upData = await up.json();
    if (!up.ok) return res.status(up.status).json(upData);
    res.json(upData);
  } catch (err) {
    console.error('[stems/upload-slot]', err);
    res.status(500).json({ error: 'stemsplit upload slot failed' });
  }
});

router.post('/create-from-key', express.json(), async (req, res) => {
  try {
    if (!STEMSPLIT_KEY) return res.status(501).json(noEnginePayload());
    const uploadKey = req.body && req.body.uploadKey;
    const outputType = (req.body && req.body.outputType) || 'FOUR_STEMS';
    const quality = (req.body && req.body.quality) || 'BEST';
    if (!uploadKey) return res.status(400).json({ error: 'uploadKey is required' });
    const r = await fetch(`${STEMSPLIT_BASE}/jobs`, {
      method: 'POST',
      headers: stemsplitHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ uploadKey, outputType, quality }),
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json(data);
    res.json(data);
  } catch (err) {
    console.error('[stems/create-from-key]', err);
    res.status(500).json({ error: 'stemsplit job create failed' });
  }
});

router.get('/audio', async (req, res) => {
  const url = String((req.query && req.query.url) || '');
  if (!/^https:\/\//i.test(url)) return res.status(400).json({ error: 'bad url' });
  try {
    const r = await fetch(url);
    if (!r.ok) return res.status(r.status).end();
    res.setHeader('Content-Type', r.headers.get('content-type') || 'audio/mpeg');
    res.setHeader('Cache-Control', 'private, max-age=300');
    const buf = Buffer.from(await r.arrayBuffer());
    res.end(buf);
  } catch (err) {
    console.error('[stems/audio]', err);
    res.status(502).json({ error: 'audio proxy failed' });
  }
});

router.get('/file/:jobId/:stem', (req, res) => {
  const file = local.stemFile(req.params.jobId, req.params.stem);
  if (!file) return res.status(404).json({ error: 'stem file not found' });
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.sendFile(file);
});

// ── POST /api/stems/create-from-url ──
// Body: { sourceUrl, outputType, quality }
// outputType: "FOUR_STEMS" | "BOTH" (vocals+instrumental) | "TWO_STEMS" etc — see StemSplit docs
router.post('/create-from-url', express.json(), async (req, res) => {
  try {
    const { sourceUrl, outputType = 'FOUR_STEMS', quality = 'BEST' } = req.body || {};
    if (!sourceUrl) return res.status(400).json({ error: 'sourceUrl is required' });

    if (String(outputType || '').toUpperCase() === 'NONE') {
      // This "URL" tab is assumed to be a direct link to an audio file
      // already (not an arbitrary webpage) — nothing to convert, just hand
      // the link straight back so the frontend can drop it on the timeline.
      // If you need this to also accept arbitrary webpage/video URLs and
      // extract audio from them, that needs its own yt-dlp-style extractor
      // per site — ask and I'll wire it in the same way as the YouTube path.
      return res.json({ id: 'url_' + crypto.randomBytes(6).toString('hex'), status: 'COMPLETED', progress: 100, outputs: { original: sourceUrl } });
    }

    if (await useLocal()) {
      const job = await local.createFromUrl(sourceUrl, outputType);
      return res.json(local.jobPublic(req, job));
    }
    if (!STEMSPLIT_KEY) return res.status(501).json(noEnginePayload());
    const r = await fetch(`${STEMSPLIT_BASE}/jobs`, {
      method: 'POST',
      headers: stemsplitHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ sourceUrl, outputType, quality }),
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json(data);
    res.json(data);
  } catch (err) {
    console.error('[stems/create-from-url]', err);
    res.status(500).json({ error: 'stemsplit request failed' });
  }
});

async function shipFileToStemSplit(file, outputType, quality) {
  const filename = file.originalname || 'upload.mp3';
  const contentType = file.mimetype || 'audio/mpeg';
  const up = await fetch(`${STEMSPLIT_BASE}/upload`, {
    method: 'POST',
    headers: stemsplitHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ filename, contentType }),
  });
  const upData = await up.json();
  if (!up.ok) throw new Error(upData.error || upData.message || 'stemsplit upload slot failed');
  if (!upData.uploadUrl || !upData.uploadKey) throw new Error('stemsplit upload URL missing');

  const put = await fetch(upData.uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': upData.contentType || contentType },
    body: file.buffer,
  });
  if (!put.ok) {
    const putText = await put.text().catch(() => '');
    throw new Error('stemsplit file PUT failed: ' + putText.slice(0, 200));
  }

  const r = await fetch(`${STEMSPLIT_BASE}/jobs`, {
    method: 'POST',
    headers: stemsplitHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ uploadKey: upData.uploadKey, outputType, quality }),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || data.message || 'stemsplit job create failed');
  return data;
}

// ── POST /api/stems/create-from-upload ──
// Receive the file, return a ticket immediately, then ship to StemSplit in
// the background. That is how other apps handle full-length songs: upload
// is one request, processing is async. Holding the HTTP request open while
// Render PUTs to StemSplit is what timed out.
router.post('/create-from-upload', async (req, res) => {
  try {
    const filename = decodeURIComponent(String((req.query && req.query.filename) || req.headers['x-filename'] || 'upload.mp3'));
    const outputType = String((req.query && req.query.outputType) || 'FOUR_STEMS');
    const quality = String((req.query && req.query.quality) || 'BEST');
    const buffer = await collectRawBody(req);
    if (!buffer.length) return res.status(400).json({ error: 'audio file is required' });
    const file = { buffer, originalname: filename, mimetype: req.headers['content-type'] || 'audio/mpeg' };
    if (await useLocal()) {
      const job = await local.createFromBuffer(file.buffer, file.originalname, outputType);
      return res.json(local.jobPublic(req, job));
    }
    if (!STEMSPLIT_KEY) return res.status(501).json(noEnginePayload());

    const id = 'up_' + crypto.randomBytes(8).toString('hex');
    const ticket = { id, status: 'UPLOADING', progress: 8, remoteId: null, error: null, outputs: null };
    TICKETS.set(id, ticket);
    res.json({ id, status: 'UPLOADING', progress: 8 });

    setImmediate(async () => {
      try {
        ticket.status = 'UPLOADING';
        ticket.progress = 20;
        const data = await shipFileToStemSplit(file, outputType, quality);
        ticket.remoteId = data.id || data.jobId || null;
        ticket.status = String(data.status || 'PENDING').toUpperCase();
        ticket.progress = typeof data.progress === 'number' ? data.progress : 30;
        if (!ticket.remoteId) {
          ticket.status = 'FAILED';
          ticket.error = 'StemSplit did not return a job id';
        }
      } catch (err) {
        console.error('[stems/create-from-upload background]', err);
        ticket.status = 'FAILED';
        ticket.error = err.message || 'stemsplit upload failed';
      }
    });
  } catch (err) {
    console.error('[stems/create-from-upload]', err);
    if (!res.headersSent) res.status(500).json({ error: 'stemsplit upload failed' });
  }
});

// ── POST /api/stems/create-from-youtube ──
// Body: { youtubeUrl, outputType, format }
// outputType: "NONE" -> just download+convert (skip StemSplit, no credits).
//   format: "mp3" (default) or "mp4" — pick which one to produce.
// Anything else for outputType -> existing StemSplit split-job flow, unchanged.
router.post('/create-from-youtube', express.json(), async (req, res) => {
  try {
    const { youtubeUrl, outputType, format } = req.body || {};
    if (!youtubeUrl) return res.status(400).json({ error: 'youtubeUrl is required' });

    if (String(outputType || '').toUpperCase() === 'NONE') {
      if (!isYoutubeUrl(youtubeUrl)) return res.status(400).json({ error: 'not a youtube URL' });
      const wantMp4 = String(format || 'mp3').toLowerCase() === 'mp4';
      const fmtKey = wantMp4 ? 'mp4' : 'mp3';

      // Cache hit — same video already converted recently, skip YouTube entirely.
      const videoId = extractVideoId(youtubeUrl);
      if (videoId) {
        const cached = cacheGet(videoId, fmtKey);
        if (cached) {
          return res.json({ id: cached.fileId, status: 'COMPLETED', progress: 100, outputs: { original: `/api/stems/yt-file/${cached.fileId}` } });
        }
      }

      const id = (wantMp4 ? 'ytmp4_' : 'ytmp3_') + crypto.randomBytes(8).toString('hex');
      const ext = wantMp4 ? '.mp4' : '.mp3';
      const outPath = path.join(YT_MP3_DIR, id + ext);
      const ticket = { id, status: 'DOWNLOADING', progress: 8, error: null, outputs: null, remoteId: null };
      TICKETS.set(id, ticket);
      res.json({ id, status: 'DOWNLOADING', progress: 8 });

      const job = wantMp4 ? runYtdlToMp4(youtubeUrl, outPath) : runYtdlToMp3(youtubeUrl, outPath);
      job
        .then(function (outPath) {
          ticket.status = 'COMPLETED';
          ticket.progress = 100;
          ticket.outputs = { original: `/api/stems/yt-file/${id}` };
          if (videoId) cacheSet(videoId, fmtKey, id);
          scheduleTicketFileCleanup(outPath, YT_CACHE_TTL_MS); // matches cache TTL so cache hits don't point at deleted files
        })
        .catch(function (err) {
          console.error('[stems/create-from-youtube NONE]', err);
          ticket.status = 'FAILED';
          ticket.error = (err && err.message) ? err.message.slice(-400) : 'youtube conversion failed';
        });
      return;
    }

    if (await useLocal()) {
      const job = await local.createFromUrl(youtubeUrl, 'BOTH');
      return res.json(local.jobPublic(req, job));
    }
    if (!STEMSPLIT_KEY) return res.status(501).json(noEnginePayload());

    const r = await fetch(`${STEMSPLIT_BASE}/youtube-jobs`, {
      method: 'POST',
      headers: stemsplitHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ youtubeUrl }),
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json(data);
    res.json(data);
  } catch (err) {
    console.error('[stems/create-from-youtube]', err);
    if (!res.headersSent) res.status(500).json({ error: 'stemsplit youtube request failed' });
  }
});

// ── GET /api/stems/yt-file/:id ──
// Serves the temp mp3/mp4 produced by the NONE-outputType youtube path above.
router.get('/yt-file/:id', (req, res) => {
  const id = String(req.params.id || '').replace(/[^a-zA-Z0-9_]/g, '');
  const mp3Path = path.join(YT_MP3_DIR, id + '.mp3');
  const mp4Path = path.join(YT_MP3_DIR, id + '.mp4');
  const file = fs.existsSync(mp3Path) ? mp3Path : (fs.existsSync(mp4Path) ? mp4Path : null);
  if (!file) return res.status(404).json({ error: 'file not found (may have expired — cache is temporary)' });
  res.setHeader('Content-Type', file.endsWith('.mp4') ? 'video/mp4' : 'audio/mpeg');
  res.setHeader('Cache-Control', 'private, max-age=1800');
  res.sendFile(file);
});

// ── GET /api/stems/status/:jobId ──
// Frontend polls this every ~3s until status is COMPLETED or FAILED
function flattenStemOutputs(outputs) {
  if (!outputs || typeof outputs !== 'object') return outputs;
  const flat = {};
  for (const [name, val] of Object.entries(outputs)) {
    if (!val) continue;
    if (typeof val === 'string') flat[name] = val;
    else if (typeof val === 'object' && val.url) flat[name] = val.url;
  }
  return flat;
}

router.get('/status/:jobId', async (req, res) => {
  try {
    const localJob = local.getJob(req.params.jobId);
    if (localJob) return res.json(local.jobPublic(req, localJob));
    const ticket = TICKETS.get(req.params.jobId);
    if (ticket && !ticket.remoteId) {
      return res.json({
        id: ticket.id,
        status: ticket.status,
        progress: ticket.progress || 0,
        error: ticket.error || undefined,
        outputs: ticket.outputs || undefined,
      });
    }
    if (!STEMSPLIT_KEY) return res.status(501).json(noEnginePayload());
    const remoteId = (ticket && ticket.remoteId) || req.params.jobId;
    let r = await fetch(`${STEMSPLIT_BASE}/jobs/${remoteId}`, {
      headers: stemsplitHeaders(),
    });
    let data = await r.json().catch(() => ({}));
    if (!r.ok) {
      const yt = await fetch(`${STEMSPLIT_BASE}/youtube-jobs/${remoteId}`, {
        headers: stemsplitHeaders(),
      });
      const ytData = await yt.json().catch(() => ({}));
      if (yt.ok) { r = yt; data = ytData; }
      else return res.status(r.status).json(data.error ? data : ytData);
    }
    if (data && data.outputs) data.outputs = flattenStemOutputs(data.outputs);
    if (data && data.errorMessage && !data.error) data.error = data.errorMessage;
    res.json(data);
    // NOTE: data.outputs / presigned URLs are valid for 1 hour only —
    // if a user comes back later, re-hit this endpoint to refresh links
    // rather than caching the URLs client-side long-term.
  } catch (err) {
    console.error('[stems/status]', err);
    res.status(500).json({ error: 'stemsplit status check failed' });
  }
});

// ── (Optional) POST /api/stems/webhook ──
// If you'd rather not poll: configure this URL in your StemSplit dashboard
// as the webhook target, and push a Supabase update / socket event here
// instead of relying on client-side polling.
const STEM_PACKS = {
  starter: { minutes: 15, cents: 249, name: 'Stem Studio Starter — 15 minutes' },
  plus: { minutes: 45, cents: 599, name: 'Stem Studio Plus — 45 minutes' },
  pro: { minutes: 150, cents: 1699, name: 'Stem Studio Pro — 150 minutes' },
};

router.post('/buy-credits', express.json(), async (req, res) => {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    return res.status(501).json({ error: 'Stripe is not configured on the server (STRIPE_SECRET_KEY).' });
  }
  const pack = STEM_PACKS[(req.body && req.body.packId) || ''];
  if (!pack) return res.status(400).json({ error: 'Unknown pack' });
  try {
    const stripe = require('stripe')(key);
    const successUrl = (req.body && req.body.successUrl) || 'http://localhost/?stems_sid={CHECKOUT_SESSION_ID}';
    const cancelUrl = (req.body && req.body.cancelUrl) || 'http://localhost/?stems_cancel=1';
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      customer_email: (req.body && req.body.email) || undefined,
      line_items: [{
        price_data: {
          currency: 'usd',
          unit_amount: pack.cents,
          product_data: { name: pack.name, description: pack.minutes + ' minutes of stem splits' },
        },
        quantity: 1,
      }],
      metadata: {
        type: 'stem_minutes',
        minutes: String(pack.minutes),
        packId: (req.body && req.body.packId) || '',
        userId: (req.body && req.body.userId) || '',
      },
      success_url: successUrl,
      cancel_url: cancelUrl,
    });
    res.json({ url: session.url, id: session.id });
  } catch (err) {
    console.error('[stems/buy-credits]', err);
    res.status(500).json({ error: err.message || 'checkout failed' });
  }
});

router.get('/credit-session', async (req, res) => {
  const key = process.env.STRIPE_SECRET_KEY;
  const sid = req.query.session_id;
  if (!key) return res.status(501).json({ error: 'Stripe is not configured' });
  if (!sid) return res.status(400).json({ error: 'missing session_id' });
  try {
    const stripe = require('stripe')(key);
    const session = await stripe.checkout.sessions.retrieve(String(sid));
    if (!session || session.payment_status !== 'paid') {
      return res.status(402).json({ error: 'not paid' });
    }
    const minutes = parseInt((session.metadata && session.metadata.minutes) || '0', 10);
    if (!minutes) return res.status(400).json({ error: 'no minutes on session' });
    res.json({ minutes: minutes, packId: session.metadata.packId || '' });
  } catch (err) {
    console.error('[stems/credit-session]', err);
    res.status(500).json({ error: err.message || 'session lookup failed' });
  }
});

router.post('/webhook', express.json(), async (req, res) => {
  const { id, status } = req.body || {};
  console.log(`[stemsplit webhook] job ${id} -> ${status}`);
  // TODO: look up which Synapses user/session this jobId belongs to
  // (store that mapping when the job is created) and notify them —
  // e.g. via your existing Supabase realtime channel or a socket emit.
  res.sendStatus(200);
});

module.exports = router;
