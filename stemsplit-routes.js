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
const multer = require('multer');
const router = express.Router();
const local = require('./stems-local');

const STEMSPLIT_KEY = process.env.STEMSPLIT_API_KEY;
const STEMSPLIT_BASE = 'https://stemsplit.io/api/v1';

function engineMode() {
  return String(process.env.STEMS_ENGINE || 'stemsplit').toLowerCase();
}
async function useLocal() {
  return engineMode() === 'local';
}
function noEnginePayload() {
  return {
    error: 'STEMSPLIT_API_KEY is not set on the server. Add it in Render → Environment, then redeploy.',
    engine: 'none',
  };
}

// In-memory upload (audio files are small enough; swap to disk storage
// if you expect very large files or want to survive a server restart)
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });

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
  });
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

// ── POST /api/stems/create-from-upload ──
// multipart/form-data, field name: "audio"
// Official StemSplit flow: POST /upload → PUT file to presigned URL → POST /jobs with uploadKey
router.post('/create-from-upload', upload.single('audio'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'audio file is required (field name: audio)' });
    if (await useLocal()) {
      const job = await local.createFromBuffer(req.file.buffer, req.file.originalname, req.body.outputType || 'FOUR_STEMS');
      return res.json(local.jobPublic(req, job));
    }
    if (!STEMSPLIT_KEY) return res.status(501).json(noEnginePayload());

    const outputType = req.body.outputType || 'FOUR_STEMS';
    const quality = req.body.quality || 'BEST';
    const filename = req.file.originalname || 'upload.mp3';
    const contentType = req.file.mimetype || 'audio/mpeg';

    const up = await fetch(`${STEMSPLIT_BASE}/upload`, {
      method: 'POST',
      headers: stemsplitHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ filename, contentType }),
    });
    const upData = await up.json();
    if (!up.ok) return res.status(up.status).json(upData);
    if (!upData.uploadUrl || !upData.uploadKey) {
      return res.status(502).json({ error: 'stemsplit upload URL missing', detail: upData });
    }

    const put = await fetch(upData.uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': upData.contentType || contentType },
      body: req.file.buffer,
    });
    if (!put.ok) {
      const putText = await put.text().catch(() => '');
      return res.status(put.status).json({ error: 'stemsplit file PUT failed', detail: putText.slice(0, 400) });
    }

    const r = await fetch(`${STEMSPLIT_BASE}/jobs`, {
      method: 'POST',
      headers: stemsplitHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ uploadKey: upData.uploadKey, outputType, quality }),
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json(data);
    res.json(data);
  } catch (err) {
    console.error('[stems/create-from-upload]', err);
    res.status(500).json({ error: 'stemsplit upload failed' });
  }
});

// ── POST /api/stems/create-from-youtube ──
// Body: { youtubeUrl }
router.post('/create-from-youtube', express.json(), async (req, res) => {
  try {
    const { youtubeUrl } = req.body || {};
    if (!youtubeUrl) return res.status(400).json({ error: 'youtubeUrl is required' });
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
    res.status(500).json({ error: 'stemsplit youtube request failed' });
  }
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
    if (!STEMSPLIT_KEY) return res.status(501).json(noEnginePayload());
    let r = await fetch(`${STEMSPLIT_BASE}/jobs/${req.params.jobId}`, {
      headers: stemsplitHeaders(),
    });
    let data = await r.json().catch(() => ({}));
    if (!r.ok) {
      const yt = await fetch(`${STEMSPLIT_BASE}/youtube-jobs/${req.params.jobId}`, {
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
router.post('/webhook', express.json(), async (req, res) => {
  const { id, status } = req.body || {};
  console.log(`[stemsplit webhook] job ${id} -> ${status}`);
  // TODO: look up which Synapses user/session this jobId belongs to
  // (store that mapping when the job is created) and notify them —
  // e.g. via your existing Supabase realtime channel or a socket emit.
  res.sendStatus(200);
});

module.exports = router;
