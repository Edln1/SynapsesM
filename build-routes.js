// build-routes.js
// User-facing "AI build" feature — the Bolt/v0/Lovable-style loop, phase 1.
//
// Design choice on purpose: this route does NOT touch the filesystem or run
// shell commands. It only calls the model and returns generated code as JSON
// text. Your frontend renders that code in a sandboxed <iframe srcdoc="...">
// (see the snippet below). That's what makes it safe to expose to every
// visitor — there's nothing here for an attacker to hijack because there's
// no server-side execution at all.
//
// This is phase 1. Phase 2 (real multi-file npm projects, live terminals,
// per-user containers) is a separate, much bigger infra project — see notes
// at the bottom of this file when you're ready for that.
//
// POST /api/build/generate  { prompt, sessionId, userId }
//   -> { files: { "index.html": "...", ... }, summary: "..." }
// POST /api/build/reset     { sessionId }
//   -> { ok: true }

const axios = require('axios');

const BUILD_API_BASE_URL = (process.env.BUILD_API_BASE_URL || process.env.AGENT_API_BASE_URL || 'http://localhost:20128/v1').replace(/\/$/, '');
const BUILD_API_KEY = process.env.BUILD_API_KEY || process.env.AGENT_API_KEY || '';
const BUILD_MODEL = process.env.BUILD_MODEL || process.env.AGENT_MODEL || 'cc/claude-opus-4-6';
const MAX_HISTORY_MESSAGES = 20;
const MAX_PROMPT_LENGTH = 4000;

const SYSTEM_PROMPT = `You are a build agent that generates small web apps.

Respond with ONLY a single JSON object, no markdown fences, no commentary outside the JSON:
{
  "files": { "index.html": "<!doctype html>...full file contents..." },
  "summary": "one sentence describing what you built or changed"
}

Rules:
- Prefer a single self-contained index.html (inline <style> and <script>) unless the user's request genuinely needs multiple files.
- Any JS libraries must be loaded from a public CDN via <script src="https://...">.
- The app must run entirely client-side — no server, no filesystem, no network calls to localhost.
- When the user asks for a change, return the FULL updated file contents, not a diff.
- Keep responses focused — don't add features the user didn't ask for.`;

const sessions = {}; // sessionId -> { messages: [...], files: {...} }

function safeParseModelJson(text) {
  const cleaned = String(text || '').trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/, '');
  const parsed = JSON.parse(cleaned);
  if (!parsed || typeof parsed !== 'object' || typeof parsed.files !== 'object') {
    throw new Error('Model response did not match the expected { files, summary } shape.');
  }
  return parsed;
}

function mount(app, opts) {
  opts = opts || {};
  const rateLimit = opts.checkGuestLimit || function (req, res, next) { next(); };

  app.post('/api/build/generate', rateLimit, async function (req, res) {
    try {
      const sessionId = req.body.sessionId || 'anon-' + Date.now();
      const prompt = req.body.prompt;
      if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
        return res.status(400).json({ error: 'prompt is required' });
      }
      if (prompt.length > MAX_PROMPT_LENGTH) {
        return res.status(400).json({ error: 'prompt too long (max ' + MAX_PROMPT_LENGTH + ' chars)' });
      }

      if (!sessions[sessionId]) {
        sessions[sessionId] = { messages: [{ role: 'system', content: SYSTEM_PROMPT }], files: {} };
      }
      const session = sessions[sessionId];

      let userContent = prompt;
      if (Object.keys(session.files).length) {
        userContent = 'Current files:\n' + JSON.stringify(session.files) + '\n\nRequested change: ' + prompt;
      }
      session.messages.push({ role: 'user', content: userContent });

      const apiRes = await axios.post(
        BUILD_API_BASE_URL + '/chat/completions',
        { model: BUILD_MODEL, messages: session.messages, response_format: { type: 'json_object' } },
        { headers: { Authorization: 'Bearer ' + BUILD_API_KEY }, timeout: 60000 }
      );

      const raw = apiRes.data.choices[0].message.content;
      const parsed = safeParseModelJson(raw);

      session.messages.push({ role: 'assistant', content: raw });
      session.files = parsed.files;

      if (session.messages.length > MAX_HISTORY_MESSAGES) {
        session.messages = [session.messages[0]].concat(session.messages.slice(-(MAX_HISTORY_MESSAGES - 1)));
      }

      res.json({ files: parsed.files, summary: parsed.summary || '', sessionId: sessionId });
    } catch (e) {
      const detail = (e.response && e.response.data) || e.message;
      console.error('[BUILD] error:', detail);
      res.status(500).json({ error: typeof detail === 'string' ? detail : e.message });
    }
  });

  app.post('/api/build/reset', function (req, res) {
    const sessionId = req.body.sessionId;
    if (sessionId) delete sessions[sessionId];
    res.json({ ok: true });
  });

  console.log('[BUILD] /api/build/generate mounted (client-side sandboxed preview, no server execution)');
}

module.exports = { mount: mount };

// ─────────────────────────────────────────────────────────────────────────
// PHASE 2 NOTES (real multi-file / npm / terminal, when you're ready):
// This is the part that actually competes with Bolt/Claude Code long-term,
// and it's a real infra build, not a code snippet:
//   - Per-user ephemeral sandbox: either in-browser (StackBlitz WebContainers
//     — runs Node in the browser tab itself, zero server cost, but Node-only
//     and same-origin restrictions) or server-side (Firecracker/gVisor/Docker
//     containers per session — real npm installs, real terminals, but you
//     now own container lifecycle, resource caps, and abuse prevention).
//   - Session teardown on idle/timeout so containers don't pile up and burn
//     your Render bill.
//   - A file-tree + terminal UI on the frontend instead of a single iframe.
//   - Auth required before ANY server-side execution path — never anonymous.
// Happy to scope either path out in detail once phase 1 is live and you've
// seen what your users actually try to build.
// ─────────────────────────────────────────────────────────────────────────
