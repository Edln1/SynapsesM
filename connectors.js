/**
 * Per-user app connectors (Google, GitHub, Notion).
 * Tokens stay on the server. Chat + speech-to-speech call /connectors/act.
 *
 * Env:
 *   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET   (already used by host WhatsApp bot)
 *   GOOGLE_MAPS_API_KEY                      (Places + Directions + Geocoding)
 *   GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET   (optional)
 *   NOTION_CLIENT_ID, NOTION_CLIENT_SECRET   (optional)
 *   CONNECTOR_PUBLIC_URL                     (default https://synbot-whatsapp-2.onrender.com)
 *   CONNECTOR_STATE_SECRET                   (defaults to SUPABASE_KEY)
 *   SERPAPI_KEY                              (Google Flights via SerpAPI — /connectors/flights/search)
 *
 * Google Cloud: add redirect
 *   {CONNECTOR_PUBLIC_URL}/connectors/callback/google
 * Enable Gmail, Calendar, Drive APIs on that project.
 */

const crypto = require('crypto');

const PUBLIC_URL = (process.env.CONNECTOR_PUBLIC_URL || 'https://synbot-whatsapp-2.onrender.com').replace(/\/$/, '');
const STATE_SECRET = process.env.CONNECTOR_STATE_SECRET || process.env.SUPABASE_KEY || 'synapses-connectors';

const GOOGLE_SCOPES = [
  'openid', 'email', 'profile',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/drive.readonly'
].join(' ');

const GITHUB_SCOPES = 'read:user repo';

function signState(obj) {
  const payload = Buffer.from(JSON.stringify(obj)).toString('base64url');
  const sig = crypto.createHmac('sha256', STATE_SECRET).update(payload).digest('hex');
  return payload + '.' + sig;
}
function readState(raw) {
  const s = String(raw || '');
  const i = s.lastIndexOf('.');
  if (i < 8) return null;
  const payload = s.slice(0, i);
  const sig = s.slice(i + 1);
  const expect = crypto.createHmac('sha256', STATE_SECRET).update(payload).digest('hex');
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
  try { return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); }
  catch (e) { return null; }
}

function closeHtml(ok, provider, message) {
  const safe = String(message || (ok ? 'Connected.' : 'Could not connect.')).replace(/</g, '');
  return `<!doctype html><meta charset="utf-8"><title>Synapses</title>
<body style="margin:0;background:#0a0a0a;color:#eee;font-family:DM Sans,system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;">
<div style="text-align:center;max-width:360px;padding:28px;">
  <div style="font-size:13px;letter-spacing:.12em;text-transform:uppercase;opacity:.45;margin-bottom:10px;">Synapses</div>
  <div style="font-size:18px;font-weight:700;">${safe}</div>
  <div style="font-size:12px;opacity:.5;margin-top:10px;">You can close this window.</div>
</div>
<script>
try{
  if(window.opener){
    window.opener.postMessage({type:'syn-connector',ok:${ok ? 'true' : 'false'},provider:${JSON.stringify(provider || '')}},'*');
    setTimeout(function(){ window.close(); }, 400);
  }
}catch(e){}
</script></body>`;
}

function catalog() {
  return [
    {
      id: 'google',
      name: 'Google',
      apps: ['Gmail', 'Calendar', 'Drive'],
      blurb: 'Read mail, check the calendar, search Drive. Send mail or add events when you confirm.',
      ready: !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
      actions: ['gmail.unread', 'gmail.search', 'gmail.send', 'gmail.reply', 'gmail.markRead', 'gmail.trash', 'gmail.triage', 'gmail.triageConfirm', 'calendar.upcoming', 'calendar.create', 'calendar.delete', 'drive.recent', 'drive.search']
    },
    {
      id: 'maps',
      name: 'Google Maps',
      apps: ['Places', 'Directions'],
      blurb: 'Search places, get addresses, and turn-by-turn directions.',
      ready: !!process.env.GOOGLE_MAPS_API_KEY,
      actions: ['maps.search', 'maps.geocode', 'maps.directions']
    },
    {
      id: 'github',
      name: 'GitHub',
      apps: ['Repos'],
      blurb: 'List your repositories. Push/PR actions come next.',
      ready: !!(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET),
      actions: ['github.repos']
    },
    {
      id: 'notion',
      name: 'Notion',
      apps: ['Workspace'],
      blurb: 'Search pages in your Notion workspace.',
      ready: !!(process.env.NOTION_CLIENT_ID && process.env.NOTION_CLIENT_SECRET),
      actions: ['notion.search']
    }
  ];
}

function mount(app, deps) {
  const { axios, SUPABASE_URL, SUPABASE_KEY } = deps;
  // In-memory: userId -> { deleteIds } — pending inbox-triage delete batch
  // awaiting confirmation. Same pattern server.js uses for WhatsApp
  // (lastGmailAction), scoped per-user, cleared on confirm.
  const pendingTriage = new Map();
  // In-memory: userId -> { kind:'send'|'reply', to, subject, body, messageId, threadId }
  // — a compose-in-progress draft awaiting missing info or a final yes/no.
  // Mirrors WhatsApp's pending_send state in server.js so "send an email to
  // X saying Y" behaves identically on web: Groq extracts {to,subject,body},
  // ask for whatever's missing, show a draft preview, only send on explicit
  // confirm.
  const pendingCompose = new Map();
  const sbHeaders = {
    apikey: SUPABASE_KEY,
    Authorization: 'Bearer ' + SUPABASE_KEY,
    'Content-Type': 'application/json',
    Prefer: 'return=representation'
  };

  async function sbGet(userId, provider) {
    const q = provider
      ? `user_connectors?user_id=eq.${encodeURIComponent(userId)}&provider=eq.${encodeURIComponent(provider)}`
      : `user_connectors?user_id=eq.${encodeURIComponent(userId)}`;
    const res = await axios.get(`${SUPABASE_URL}/rest/v1/${q}`, { headers: sbHeaders });
    return res.data || [];
  }
  async function sbUpsert(row) {
    await axios.post(
      `${SUPABASE_URL}/rest/v1/user_connectors?on_conflict=user_id,provider`,
      row,
      { headers: { ...sbHeaders, Prefer: 'resolution=merge-duplicates,return=minimal' } }
    );
  }
  async function sbDelete(userId, provider) {
    await axios.delete(
      `${SUPABASE_URL}/rest/v1/user_connectors?user_id=eq.${encodeURIComponent(userId)}&provider=eq.${encodeURIComponent(provider)}`,
      { headers: sbHeaders }
    );
  }

  // In-memory cache for the shared/fallback token, so we don't hit Google's
  // token endpoint on every single action when using the static env-var token.
  let sharedGoogleToken = { access_token: null, expires_at: 0 };

  async function refreshWithToken(refreshToken) {
    const res = await axios.post('https://oauth2.googleapis.com/token', {
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: 'refresh_token'
    });
    return {
      access_token: res.data.access_token,
      expires_in: res.data.expires_in || 3500
    };
  }

  async function googleAccess(userId) {
    const rows = await sbGet(userId, 'google');
    const row = rows[0];

    // Per-user token saved via the OAuth connector flow — preferred when present.
    if (row && row.refresh_token) {
      if (row.access_token && row.access_expires_at && Date.parse(row.access_expires_at) > Date.now() + 30000) {
        return row.access_token;
      }
      const { access_token, expires_in } = await refreshWithToken(row.refresh_token);
      const exp = new Date(Date.now() + expires_in * 1000).toISOString();
      await sbUpsert({
        user_id: userId,
        provider: 'google',
        refresh_token: row.refresh_token,
        access_token,
        access_expires_at: exp,
        account_label: row.account_label || null,
        scopes: row.scopes || GOOGLE_SCOPES,
        updated_at: new Date().toISOString()
      });
      return access_token;
    }

    // Fallback: no per-user row yet — reuse the shared GOOGLE_REFRESH_TOKEN
    // (same one server.js already uses for WhatsApp) so connector actions
    // work immediately without requiring every user to redo the OAuth flow.
    if (process.env.GOOGLE_REFRESH_TOKEN) {
      if (sharedGoogleToken.access_token && sharedGoogleToken.expires_at > Date.now() + 30000) {
        return sharedGoogleToken.access_token;
      }
      try {
        const { access_token, expires_in } = await refreshWithToken(process.env.GOOGLE_REFRESH_TOKEN);
        sharedGoogleToken = { access_token, expires_at: Date.now() + expires_in * 1000 };
        return access_token;
      } catch (e) {
        console.error('[CONNECTORS] shared GOOGLE_REFRESH_TOKEN refresh failed:', e.response && e.response.data || e.message);
        return null;
      }
    }

    return null;
  }

  async function githubAccess(userId) {
    const rows = await sbGet(userId, 'github');
    return (rows[0] && rows[0].access_token) || null;
  }
  async function notionAccess(userId) {
    const rows = await sbGet(userId, 'notion');
    return (rows[0] && rows[0].access_token) || null;
  }

  function gmailHeader(headers, name) {
    const h = (headers || []).find(x => String(x.name).toLowerCase() === name.toLowerCase());
    return h ? h.value : '';
  }

  async function runAction(userId, action, args, confirm) {
    const a = String(action || '');
    args = args || {};

    // Draft parse/cancel never need a Gmail token — only the actual send
    // does. Keeping them outside the token gate means a leftover name-only
    // draft ("send email to ken") can be cancelled and replaced even if
    // Google is mid-reconnect, and the web popup can submit a real address
    // without the name winning a stale merge.
    const FAKE_DOMAIN_RE = /@(example|test|sample|placeholder|domain|yourdomain|company|acme|foo|email)\.(com|org|net)$/i;
    const looksLikeEmail = (s) => {
      const v = String(s || '').trim();
      if (!v || v.indexOf('@') < 0) return false;
      const at = v.indexOf('@');
      if (v.indexOf('.', at) < 0) return false;
      if (FAKE_DOMAIN_RE.test(v)) return false;
      return true;
    };
    const firstNonEmpty = (...vals) => {
      for (const v of vals) {
        const s = String(v == null ? '' : v).trim();
        if (s) return s;
      }
      return '';
    };
    const pickBestTo = (...vals) => {
      const cleaned = vals.map((v) => String(v == null ? '' : v).trim()).filter(Boolean);
      return cleaned.find(looksLikeEmail) || '';
    };

    if (a === 'gmail.composeCancel') {
      pendingCompose.delete(userId);
      return { ok: true, spoken: 'Okay, cancelled.' };
    }

    if (a === 'gmail.composeParse') {
      const isReply = !!args.isReply;
      const prior = args.fresh ? {} : (pendingCompose.get(userId) || {});
      const hasDirect = args.directTo != null || args.directSubject != null || args.directBody != null;
      const rawText = String(args.text || '').trim();
      if (!rawText && !hasDirect) return { ok: false, error: 'Nothing to parse.' };

      let parsed = {};
      if (hasDirect) {
        parsed = {
          to: String(args.directTo || '').trim(),
          subject: String(args.directSubject || '').trim(),
          body: String(args.directBody || '').trim()
        };
      } else {
        const GROQ_KEYS = (process.env.GROQ_KEYS || '').split(',').filter(Boolean);
        if (!GROQ_KEYS.length) return { ok: false, error: 'Compose needs GROQ_KEYS configured on the server.' };
        const groqKey = GROQ_KEYS[Math.floor(Math.random() * GROQ_KEYS.length)];
        const sys = isReply
          ? 'Extract an email reply from the user\'s message. Respond ONLY with JSON: {"subject":"...","body":"..."}. Use "" for a field that isn\'t present. Never invent content that wasn\'t said.'
          : 'Extract an email the person wants to send. Respond ONLY with JSON: {"to":"...","subject":"...","body":"..."}. "to" must be a COMPLETE, LITERAL email address the user actually typed or said (e.g. "alex@gmail.com"), copied exactly. If the user only gave a name, nickname, or contact ("alex", "my boss", "the landlord") with no actual address attached, "to" MUST be "" — do NOT guess, complete, or invent a domain like @example.com/@gmail.com/@email.com for them. Use "" for subject/body if not present. Never invent content that wasn\'t said.';
        try {
          const r = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
            model: 'qwen/qwen3.6-27b',
            messages: [{ role: 'system', content: sys }, { role: 'user', content: rawText }],
            max_tokens: 400,
            reasoning_effort: 'none',
            reasoning_format: 'hidden'
          }, { headers: { Authorization: `Bearer ${groqKey}`, 'Content-Type': 'application/json' } });
          const out = r.data.choices[0].message.content.replace(/```json|```/g, '').trim();
          const jm = out.match(/\{[\s\S]*\}/);
          parsed = JSON.parse(jm ? jm[0] : out);
        } catch (e) {
          return { ok: false, error: "Couldn't read that email request. Try again." };
        }
      }

      const merged = {
        kind: isReply ? 'reply' : 'send',
        // A real address always beats a leftover name ("ken") from the
        // first turn. Never keep a to-value that isn't an actual email.
        to: isReply
          ? firstNonEmpty(args.to, prior.to)
          : pickBestTo(parsed.to, prior.to, args.directTo),
        subject: firstNonEmpty(parsed.subject, prior.subject, args.subject),
        body: firstNonEmpty(parsed.body, prior.body),
        messageId: args.messageId || prior.messageId || null,
        threadId: args.threadId || prior.threadId || null
      };
      if (!isReply && merged.to && !looksLikeEmail(merged.to)) merged.to = '';
      if (!hasDirect && merged.to && FAKE_DOMAIN_RE.test(merged.to)) merged.to = '';

      if (!isReply && !looksLikeEmail(merged.to)) {
        pendingCompose.set(userId, merged);
        return { ok: true, needInfo: 'address', spoken: "What's their email address?", draft: merged };
      }
      if (!merged.body) {
        pendingCompose.set(userId, merged);
        const who = merged.to || 'them';
        return { ok: true, needInfo: 'content', spoken: 'Got it \u2014 emailing ' + who + '. What\u2019s the subject and message?' };
      }
      if (!merged.subject) merged.subject = isReply ? '' : 'Message';
      pendingCompose.set(userId, merged);
      const displaySubject = isReply ? (/^re:/i.test(merged.subject) ? merged.subject : 'Re: ' + merged.subject) : merged.subject;
      const preview = (isReply ? '\ud83d\udcdd Reply draft \u2014 send it?' : '\ud83d\udcdd Draft ready \u2014 send it?') +
        '\n\nTo: ' + merged.to + '\nSubject: ' + displaySubject + '\n\n' + merged.body +
        '\n\nReply yes to send or say something else to cancel.';
      return { ok: true, draftReady: true, draft: merged, spoken: preview };
    }

    if (a.startsWith('gmail.') || a.startsWith('calendar.') || a.startsWith('drive.')) {
      const token = await googleAccess(userId);
      if (!token) return { ok: false, needConnect: 'google', error: 'Google is not connected.' };
      const auth = { Authorization: 'Bearer ' + token };

      if (a === 'gmail.unread') {
        const list = await axios.get('https://gmail.googleapis.com/gmail/v1/users/me/messages', {
          headers: auth, params: { q: 'is:unread', maxResults: Math.min(args.limit || 8, 15) }
        });
        const ids = list.data.messages || [];
        const items = [];
        for (const m of ids) {
          const msg = await axios.get(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}`, {
            headers: auth, params: { format: 'metadata', metadataHeaders: ['From','Subject','Date'] }
          });
          items.push({
            id: m.id,
            from: gmailHeader(msg.data.payload && msg.data.payload.headers, 'From'),
            subject: gmailHeader(msg.data.payload && msg.data.payload.headers, 'Subject') || '(no subject)',
            snippet: (msg.data.snippet || '').slice(0, 160)
          });
        }
        if (!items.length) return { ok: true, spoken: 'Your inbox is clear. No unread mail.', items };
        const spoken = 'You have ' + items.length + ' unread. ' +
          items.slice(0, 5).map((it, i) => (i + 1) + '. ' + it.subject + ' from ' + it.from.split('<')[0].trim()).join('. ');
        return { ok: true, spoken, items };
      }

      if (a === 'gmail.search') {
        const q = String(args.q || args.query || '').trim();
        if (!q) return { ok: false, error: 'Need a search query.' };
        const list = await axios.get('https://gmail.googleapis.com/gmail/v1/users/me/messages', {
          headers: auth, params: { q, maxResults: Math.min(args.limit || 6, 12) }
        });
        const ids = list.data.messages || [];
        const items = [];
        for (const m of ids) {
          const msg = await axios.get(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}`, {
            headers: auth, params: { format: 'metadata', metadataHeaders: ['From','Subject','Date'] }
          });
          items.push({
            id: m.id,
            from: gmailHeader(msg.data.payload && msg.data.payload.headers, 'From'),
            subject: gmailHeader(msg.data.payload && msg.data.payload.headers, 'Subject') || '(no subject)',
            snippet: (msg.data.snippet || '').slice(0, 160)
          });
        }
        if (!items.length) return { ok: true, spoken: 'No mail matched that search.', items };
        const spoken = 'Found ' + items.length + '. ' + items.slice(0, 4).map(it => it.subject).join('. ');
        return { ok: true, spoken, items };
      }

      // Shared senders — used by both the direct gmail.send/gmail.reply
      // actions and gmail.composeConfirm (the draft-preview flow below).
      async function doSendGmail(to, subject, body) {
        const raw = Buffer.from(
          `To: ${to}\r\nSubject: ${subject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}`
        ).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        await axios.post('https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
          { raw }, { headers: { ...auth, 'Content-Type': 'application/json' } });
        return { ok: true, spoken: 'Sent that email to ' + to + '.' };
      }
      async function doReplyGmail(messageId, to, subject, body, threadId) {
        const replySubject = /^re:/i.test(subject) ? subject : 'Re: ' + subject;
        const rawParts = [`To: ${to}`, `Subject: ${replySubject}`];
        if (messageId) rawParts.push(`In-Reply-To: ${messageId}`, `References: ${messageId}`);
        rawParts.push('Content-Type: text/plain; charset=utf-8', '', body);
        const raw = Buffer.from(rawParts.join('\r\n'))
          .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        const payload = { raw };
        if (threadId) payload.threadId = threadId;
        await axios.post('https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
          payload, { headers: { ...auth, 'Content-Type': 'application/json' } });
        return { ok: true, spoken: 'Sent your reply to ' + to + '.' };
      }

      if (a === 'gmail.send') {
        if (!confirm) return { ok: false, needsConfirm: true, error: 'Sending mail needs an explicit confirm.' };
        const to = String(args.to || '').trim();
        const subject = String(args.subject || 'Message from Synapses').trim();
        const body = String(args.body || args.text || '').trim();
        if (!to || !body) return { ok: false, error: 'Need a to address and a body.' };
        return await doSendGmail(to, subject, body);
      }

      if (a === 'gmail.reply') {
        if (!confirm) return { ok: false, needsConfirm: true, error: 'Replying needs an explicit confirm.' };
        const messageId = String(args.messageId || args.id || '').trim();
        const to = String(args.to || '').trim();
        const subject = String(args.subject || '').trim();
        const body = String(args.body || args.text || '').trim();
        const threadId = args.threadId || null;
        if (!messageId || !to || !body) return { ok: false, error: 'Need the original message, a to address, and a body.' };
        return await doReplyGmail(messageId, to, subject, body, threadId);
      }

      if (a === 'gmail.composeConfirm') {
        const pending = pendingCompose.get(userId);
        if (!pending || !pending.body || !pending.to) return { ok: false, error: 'No pending email to send.' };
        pendingCompose.delete(userId);
        if (pending.kind === 'reply') {
          return await doReplyGmail(pending.messageId, pending.to, pending.subject, pending.body, pending.threadId);
        }
        return await doSendGmail(pending.to, pending.subject || 'Message', pending.body);
      }

      if (a === 'gmail.markRead') {
        const messageId = String(args.messageId || args.id || '').trim();
        if (!messageId) return { ok: false, error: 'Need a message to mark as read.' };
        await axios.post(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}/modify`,
          { removeLabelIds: ['UNREAD'] }, { headers: { ...auth, 'Content-Type': 'application/json' } });
        return { ok: true, spoken: 'Marked that as read.' };
      }

      if (a === 'gmail.trash') {
        if (!confirm) return { ok: false, needsConfirm: true, error: 'Deleting mail needs an explicit confirm.' };
        const messageId = String(args.messageId || args.id || '').trim();
        if (!messageId) return { ok: false, error: 'Need a message to delete.' };
        await axios.post(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}/trash`,
          {}, { headers: auth });
        return { ok: true, spoken: 'Deleted that email.' };
      }

      if (a === 'gmail.triage') {
        const GROQ_KEYS = (process.env.GROQ_KEYS || '').split(',').filter(Boolean);
        if (!GROQ_KEYS.length) return { ok: false, error: 'Triage needs GROQ_KEYS configured on the server.' };

        const list = await axios.get('https://gmail.googleapis.com/gmail/v1/users/me/messages', {
          headers: auth, params: { q: 'in:inbox', maxResults: 50 }
        });
        const ids = list.data.messages || [];
        if (!ids.length) return { ok: true, spoken: 'Your inbox is empty!' };

        const emails = (await Promise.all(ids.map(async m => {
          try {
            const msg = await axios.get(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}`, {
              headers: auth, params: { format: 'metadata', metadataHeaders: ['From', 'Subject', 'Date'] }
            });
            const from = gmailHeader(msg.data.payload && msg.data.payload.headers, 'From');
            return {
              id: m.id,
              from: from.replace(/<.*>/, '').trim() || from,
              subject: gmailHeader(msg.data.payload && msg.data.payload.headers, 'Subject') || '(no subject)',
              snippet: (msg.data.snippet || '').slice(0, 80)
            };
          } catch (e) { return null; }
        }))).filter(Boolean);

        const groqKey = GROQ_KEYS[Math.floor(Math.random() * GROQ_KEYS.length)];
        const emailList = emails.map((e, i) => `${i + 1}. From: ${e.from} | Subject: ${e.subject} | Preview: ${e.snippet}`).join('\n');
        let classifications = [];
        try {
          // Groq killed llama-3.1-8b-instant (shutdown 08/16/26). indexfixing.html
          // already reroutes every Groq call to qwen/qwen3.6-27b via groqModel() /
          // GROQ_QWEN27 once that date hits, but this backend talks to Groq
          // directly and never got that fallback — this was quietly erroring
          // and reporting as "couldn't classify". Matching the same fallback
          // model here. Qwen reasons by default, so reasoning_effort/format are
          // needed or a <think> block lands in message.content and breaks the
          // JSON.parse below.
          const classifyRes = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
            model: 'qwen/qwen3.6-27b',
            messages: [{
              role: 'system',
              content: `You are an email triage assistant. Classify each email as DELETE or KEEP.
KEEP if: real person emailing, bank/financial statement, receipt/order confirmation, legal/medical, calendar invite, job/work related, personal message, anything that might need a reply.
DELETE if: newsletter, promotional, marketing, sale/deal, social media notification, automated noreply, digest, subscription, "you have a new follower", shipping promo, app notification.
Respond ONLY with JSON array: [{"index":1,"action":"DELETE","reason":"newsletter"},{"index":2,"action":"KEEP","reason":"personal email from John"},...]`
            }, { role: 'user', content: emailList }],
            max_tokens: 2000,
            reasoning_effort: 'none',
            reasoning_format: 'hidden'
          }, { headers: { Authorization: `Bearer ${groqKey}`, 'Content-Type': 'application/json' } });
          const raw = classifyRes.data.choices[0].message.content.replace(/```json|```/g, '').trim();
          const jsonMatch = raw.match(/\[[\s\S]*\]/);
          classifications = JSON.parse(jsonMatch ? jsonMatch[0] : raw);
        } catch (e) {
          return { ok: false, error: "Couldn't classify your emails right now. Try again in a moment." };
        }

        const toDelete = classifications.filter(c => c.action === 'DELETE').map(c => emails[c.index - 1]).filter(Boolean);
        const toKeep = classifications.filter(c => c.action === 'KEEP').map(c => emails[c.index - 1]).filter(Boolean);

        if (!toDelete.length) {
          return { ok: true, spoken: `Scanned ${emails.length} emails \u2014 nothing safe to delete was found. All your emails look important!` };
        }

        pendingTriage.set(userId, { deleteIds: toDelete.map(e => e.id) });

        const deleteLines = toDelete.map((e, i) => `${i + 1}. ${e.from} \u2014 ${e.subject}`).join('. ');
        const spoken = `Inbox Triage \u2014 ${emails.length} scanned. Safe to delete (${toDelete.length}): ${deleteLines}. Keeping ${toKeep.length}. Say "yes" or "delete them" to remove the ${toDelete.length} junk emails, or anything else to cancel.`;
        return { ok: true, spoken, items: { toDelete, toKeep } };
      }

      if (a === 'gmail.triageConfirm') {
        const pending = pendingTriage.get(userId);
        if (!pending || !pending.deleteIds || !pending.deleteIds.length) {
          return { ok: false, error: 'No pending triage to confirm.' };
        }
        pendingTriage.delete(userId);
        let deleted = 0;
        for (let i = 0; i < pending.deleteIds.length; i += 10) {
          const batch = pending.deleteIds.slice(i, i + 10);
          await Promise.all(batch.map(id =>
            axios.post(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}/trash`, {}, { headers: auth }).catch(() => null)
          ));
          deleted += batch.length;
        }
        return { ok: true, spoken: `Deleted ${deleted} emails. Your inbox is cleaner now!` };
      }

      if (a === 'calendar.upcoming') {
        const days = Math.min(Math.max(parseInt(args.days, 10) || 1, 1), 14);
        const now = new Date();
        const end = new Date(now);
        end.setDate(end.getDate() + days);
        const res = await axios.get('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
          headers: auth,
          params: {
            timeMin: now.toISOString(),
            timeMax: end.toISOString(),
            singleEvents: true,
            orderBy: 'startTime',
            maxResults: 12
          }
        });
        const items = (res.data.items || []).map(e => ({
          id: e.id || null,
          title: e.summary || '(no title)',
          start: e.start && (e.start.dateTime || e.start.date),
          end: e.end && (e.end.dateTime || e.end.date),
          location: e.location || null
        }));
        if (!items.length) return { ok: true, spoken: days === 1 ? 'Nothing on the calendar today.' : 'Nothing coming up in the next ' + days + ' days.', items };
        const spoken = items.slice(0, 6).map(function (e) {
          const when = e.start ? new Date(e.start).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : '';
          return (when ? when + ' — ' : '') + e.title;
        }).join('. ');
        return { ok: true, spoken: 'Upcoming: ' + spoken, items };
      }

      if (a === 'calendar.create') {
        if (!confirm) return { ok: false, needsConfirm: true, error: 'Creating an event needs an explicit confirm.' };
        let title = String(args.title || args.summary || '').trim();
        let startISO = args.start || args.startISO;
        let endISO = args.end || args.endISO;
        let description = args.description || 'Added from Synapses';

        // Callers (chat/voice) usually only have the raw sentence
        // ("add dentist appointment tomorrow at 2pm to my calendar") with
        // no structured start time — that used to fall straight through to
        // the "Need a title and a start time" check below and fail every
        // time, even though the confirm step made it look like it worked.
        // Extract real title/start/end from the raw text via Groq, same
        // approach the WhatsApp bot uses in server.js.
        const rawText = String(args.text || '').trim();
        if (!startISO && rawText) {
          const GROQ_KEYS = (process.env.GROQ_KEYS || '').split(',').filter(Boolean);
          if (!GROQ_KEYS.length) return { ok: false, error: 'Adding events needs GROQ_KEYS configured on the server.' };
          const groqKey = GROQ_KEYS[Math.floor(Math.random() * GROQ_KEYS.length)];
          const nowStr = new Date().toLocaleString('en-US', { timeZone: 'America/Vancouver', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' });
          try {
            const r = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
              model: 'qwen/qwen3.6-27b',
              messages: [{
                role: 'system',
                content: `Current date/time: ${nowStr} (America/Vancouver). Extract a single calendar event from the user's message. Respond ONLY with JSON, no markdown: {"title":"...","startISO":"2026-05-16T09:00:00","endISO":"2026-05-16T10:00:00","description":"..."}. If no explicit time is given, default to 9:00 AM. If no explicit end time is given, default to 1 hour after start. startISO/endISO must be local Vancouver time with no timezone suffix.`
              }, { role: 'user', content: rawText }],
              max_tokens: 300,
              reasoning_effort: 'none',
              reasoning_format: 'hidden'
            }, { headers: { Authorization: `Bearer ${groqKey}`, 'Content-Type': 'application/json' } });
            const out = r.data.choices[0].message.content.replace(/```json|```/g, '').trim();
            const jm = out.match(/\{[\s\S]*\}/);
            const parsed = JSON.parse(jm ? jm[0] : out);
            title = String(parsed.title || title || rawText).trim();
            startISO = parsed.startISO;
            endISO = parsed.endISO || endISO;
            if (parsed.description) description = parsed.description;
          } catch (e) {
            return { ok: false, error: "Couldn't read that event's date/time. Try being more specific, e.g. \"tomorrow at 2pm\"." };
          }
        }

        endISO = endISO || (startISO ? new Date(Date.parse(startISO) + 60 * 60 * 1000).toISOString() : null);
        if (!title || !startISO) return { ok: false, error: 'Need a title and a start time.' };
        const location = args.location ? String(args.location).trim() : undefined;
        const createRes = await axios.post('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
          summary: title,
          start: { dateTime: new Date(startISO).toISOString() },
          end: { dateTime: new Date(endISO).toISOString() },
          description,
          ...(location ? { location } : {})
        }, { headers: { ...auth, 'Content-Type': 'application/json' } });
        const startFmt = new Date(startISO).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/Vancouver' });
        // Include Google's real event id so the client can tell two events
        // with the same title/time apart instead of collapsing them.
        const items = [{ id: (createRes.data && createRes.data.id) || null, title, start: startISO, end: endISO, location: location || null }];
        return { ok: true, spoken: 'Added "' + title + '" to your calendar for ' + startFmt + '.', items };
      }

      if (a === 'calendar.delete') {
        if (!confirm) return { ok: false, needsConfirm: true, error: 'Deleting an event needs an explicit confirm.' };
        const eventId = String(args.eventId || args.id || '').trim();
        if (!eventId) return { ok: false, error: 'Need an eventId to delete.' };
        try {
          await axios.delete(
            'https://www.googleapis.com/calendar/v3/calendars/primary/events/' + encodeURIComponent(eventId),
            { headers: auth }
          );
        } catch (e) {
          const status = e.response && e.response.status;
          // Google returns 410 Gone (or sometimes 404) if the event was
          // already deleted/never existed — treat that as a successful
          // delete rather than an error, since the end state the caller
          // wanted (event gone) is already true.
          if (status !== 410 && status !== 404) {
            return { ok: false, error: 'Delete failed: ' + (e.response && e.response.data && e.response.data.error && e.response.data.error.message || e.message) };
          }
        }
        return { ok: true, spoken: 'Deleted that event from your calendar.' };
      }

      if (a === 'drive.recent' || a === 'drive.search') {
        const q = a === 'drive.search'
          ? ("name contains '" + String(args.q || args.query || '').replace(/'/g, "\\'") + "' and trashed = false")
          : 'trashed = false';
        const res = await axios.get('https://www.googleapis.com/drive/v3/files', {
          headers: auth,
          params: {
            q,
            pageSize: Math.min(args.limit || 8, 15),
            orderBy: 'modifiedTime desc',
            fields: 'files(id,name,mimeType,modifiedTime,webViewLink)'
          }
        });
        const items = res.data.files || [];
        if (!items.length) return { ok: true, spoken: a === 'drive.search' ? 'No Drive files matched that.' : 'No recent Drive files.', items };
        const spoken = items.slice(0, 6).map(f => f.name).join('. ');
        return { ok: true, spoken: 'Drive: ' + spoken, items };
      }
    }

    if (a === 'github.repos') {
      const token = await githubAccess(userId);
      if (!token) return { ok: false, needConnect: 'github', error: 'GitHub is not connected.' };
      const res = await axios.get('https://api.github.com/user/repos', {
        headers: { Authorization: 'Bearer ' + token, 'User-Agent': 'synapses-connectors', Accept: 'application/vnd.github+json' },
        params: { sort: 'updated', per_page: 10 }
      });
      const items = (res.data || []).map(r => ({ name: r.full_name, url: r.html_url, private: !!r.private }));
      if (!items.length) return { ok: true, spoken: 'No repositories on this GitHub account.', items };
      return { ok: true, spoken: 'Your repos: ' + items.slice(0, 8).map(r => r.name).join(', '), items };
    }

    if (a.startsWith('maps.')) {
      const key = process.env.GOOGLE_MAPS_API_KEY;
      if (!key) return { ok: false, needConnect: 'maps', error: 'Google Maps API key is not set on the server.' };
      if (a === 'maps.search') {
        const q = String(args.q || args.query || args.near || '').trim();
        if (!q) return { ok: false, error: 'Need a place to search for.' };
        const params = { query: q, key };
        if (args.lat != null && args.lng != null) {
          params.location = Number(args.lat) + ',' + Number(args.lng);
          params.radius = 4000;
        }
        let res = await axios.get('https://maps.googleapis.com/maps/api/place/textsearch/json', { params });
        if (res.data.status && res.data.status !== 'OK' && res.data.status !== 'ZERO_RESULTS') {
          return { ok: false, error: 'Maps search failed: ' + (res.data.error_message || res.data.status) };
        }
        let raw = res.data.results || [];
        // "Maldives" with a 4km Vancouver bias returns nothing. Retry
        // unscoped so countries / far places still resolve. This ONLY
        // fires when the local-biased search found nothing — it must
        // never discard results that were already found nearby (that
        // was silently sending queries like "gold repair" or "jewelry
        // repair" to a same-named shop across the country instead of
        // the real local match, since those terms weren't on a fixed
        // whitelist of "obviously local" categories).
        if (params.location && !raw.length) {
          res = await axios.get('https://maps.googleapis.com/maps/api/place/textsearch/json', { params: { query: q, key } });
          raw = res.data.results || [];
        }
        const items = raw.slice(0, 6).map(function (p) {
          const loc = p.geometry && p.geometry.location;
          return {
            name: p.name,
            address: p.formatted_address || p.vicinity || '',
            rating: p.rating || null,
            place_id: p.place_id || '',
            lat: loc && loc.lat,
            lng: loc && loc.lng,
            mapsUrl: p.place_id ? ('https://www.google.com/maps/place/?q=place_id:' + p.place_id) : ('https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(p.name || q))
          };
        });
        if (!items.length) return { ok: true, spoken: 'No places matched that.', items, mapsKey: key };
        const spoken = items.slice(0, 4).map(function (p, i) {
          return (i + 1) + '. ' + p.name + (p.address ? ' — ' + p.address : '');
        }).join('. ');
        return { ok: true, spoken: 'Places: ' + spoken, items, mapsKey: key };
      }
      if (a === 'maps.geocode') {
        const q = String(args.q || args.address || args.query || '').trim();
        if (!q) return { ok: false, error: 'Need an address or place name.' };
        const res = await axios.get('https://maps.googleapis.com/maps/api/geocode/json', {
          params: { address: q, key }
        });
        if (res.data.status && res.data.status !== 'OK' && res.data.status !== 'ZERO_RESULTS') {
          return { ok: false, error: 'Geocode failed: ' + (res.data.error_message || res.data.status) };
        }
        const items = (res.data.results || []).slice(0, 3).map(function (p) {
          const loc = p.geometry && p.geometry.location;
          const vp = p.geometry && p.geometry.viewport;
          return {
            address: p.formatted_address,
            lat: loc && loc.lat,
            lng: loc && loc.lng,
            types: p.types || [],
            viewport: vp ? {
              south: vp.southwest && vp.southwest.lat,
              west: vp.southwest && vp.southwest.lng,
              north: vp.northeast && vp.northeast.lat,
              east: vp.northeast && vp.northeast.lng
            } : null,
            mapsUrl: 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(p.formatted_address || q)
          };
        });
        if (!items.length) return { ok: true, spoken: 'I could not find that address.', items, mapsKey: key };
        return { ok: true, spoken: items[0].address, items, mapsKey: key };
      }
      if (a === 'maps.directions') {
        const origin = String(args.origin || args.from || '').trim();
        const dest = String(args.destination || args.to || args.q || '').trim();
        if (!dest) return { ok: false, error: 'Need a destination.' };
        if (!origin) {
          return {
            ok: true,
            spoken: 'Open this for directions to ' + dest + '.',
            items: [{
              to: dest,
              mapsUrl: 'https://www.google.com/maps/dir/?api=1&destination=' + encodeURIComponent(dest)
            }],
            mapsKey: key
          };
        }
        const dirMode = String(args.mode || 'driving').toLowerCase();
        const dirParams = {
          origin: origin,
          destination: dest,
          mode: dirMode,
          key
        };
        if (dirMode === 'driving' || dirMode === 'transit') {
          dirParams.departure_time = Math.floor(Date.now() / 1000);
        }
        const res = await axios.get('https://maps.googleapis.com/maps/api/directions/json', {
          params: dirParams
        });
        if (res.data.status && res.data.status !== 'OK') {
          return { ok: false, error: 'Directions failed: ' + (res.data.error_message || res.data.status) };
        }
        const route = (res.data.routes || [])[0];
        const leg = route && route.legs && route.legs[0];
        if (!leg) return { ok: true, spoken: 'No route found.', items: [] };
        const steps = (leg.steps || []).slice(0, 8).map(function (s) {
          return String(s.html_instructions || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        }).filter(Boolean);
        const durText = (leg.duration_in_traffic && leg.duration_in_traffic.text) || (leg.duration && leg.duration.text);
        const spoken = (durText ? durText + '. ' : '') +
          (leg.distance && leg.distance.text ? leg.distance.text + '. ' : '') +
          steps.slice(0, 5).join('. ');
        return {
          ok: true,
          spoken: spoken || 'Got directions.',
          items: [{
            from: leg.start_address,
            to: leg.end_address,
            duration: durText,
            distance: leg.distance && leg.distance.text,
            steps: steps,
            lat: leg.end_location && leg.end_location.lat,
            lng: leg.end_location && leg.end_location.lng,
            fromLat: leg.start_location && leg.start_location.lat,
            fromLng: leg.start_location && leg.start_location.lng,
            poly: route.overview_polyline && route.overview_polyline.points,
            mapsUrl: 'https://www.google.com/maps/dir/?api=1&origin=' + encodeURIComponent(origin || '') + '&destination=' + encodeURIComponent(dest)
          }],
          mapsKey: key
        };
      }
    }

    if (a === 'notion.search') {
      const token = await notionAccess(userId);
      if (!token) return { ok: false, needConnect: 'notion', error: 'Notion is not connected.' };
      const res = await axios.post('https://api.notion.com/v1/search', {
        query: String(args.q || args.query || ''),
        page_size: 8
      }, {
        headers: {
          Authorization: 'Bearer ' + token,
          'Notion-Version': '2022-06-28',
          'Content-Type': 'application/json'
        }
      });
      const items = (res.data.results || []).map(function (p) {
        const title = (((p.properties || {}).title || {}).title || [])
          .map(function (t) { return t.plain_text; }).join('') || p.id;
        return { id: p.id, title: title || 'Untitled', url: p.url };
      });
      if (!items.length) return { ok: true, spoken: 'Nothing in Notion matched that.', items };
      return { ok: true, spoken: 'Notion: ' + items.map(i => i.title).join('. '), items };
    }

    return { ok: false, error: 'Unknown action: ' + a };
  }

  app.get('/connectors/catalog', function (req, res) {
    res.json({ ok: true, providers: catalog() });
  });

  app.get('/connectors/maps/client', function (req, res) {
    const key = process.env.GOOGLE_MAPS_API_KEY;
    if (!key) return res.status(501).json({ ok: false, error: 'Google Maps API key is not set on the server.' });
    res.json({ ok: true, key: key });
  });

  app.get('/connectors/maps/etas', async function (req, res) {
    const key = process.env.GOOGLE_MAPS_API_KEY;
    if (!key) return res.status(501).json({ ok: false, error: 'no key' });
    const origin = String(req.query.origin || '').trim();
    const dest = String(req.query.destination || req.query.dest || '').trim();
    if (!origin || !dest) return res.status(400).json({ ok: false, error: 'need origin and destination' });
    const modes = ['driving', 'walking', 'bicycling', 'transit'];
    const now = Math.floor(Date.now() / 1000);
    try {
      const rows = await Promise.all(modes.map(async function (mode) {
        try {
          const params = { origin: origin, destination: dest, mode: mode, key: key };
          if (mode === 'driving' || mode === 'transit') params.departure_time = now;
          const r = await axios.get('https://maps.googleapis.com/maps/api/directions/json', { params: params });
          if (r.data.status && r.data.status !== 'OK') {
            return { mode: mode, ok: false, error: r.data.status };
          }
          const leg = r.data.routes && r.data.routes[0] && r.data.routes[0].legs && r.data.routes[0].legs[0];
          if (!leg) return { mode: mode, ok: false, error: 'no_route' };
          return {
            mode: mode,
            ok: true,
            duration: (leg.duration_in_traffic && leg.duration_in_traffic.text) || (leg.duration && leg.duration.text) || null,
            distance: (leg.distance && leg.distance.text) || null
          };
        } catch (e) {
          return { mode: mode, ok: false, error: (e && e.message) || 'failed' };
        }
      }));
      res.json({ ok: true, etas: rows, mapsKey: key });
    } catch (e) {
      res.status(502).json({ ok: false, error: e.message || 'etas failed' });
    }
  });

  app.get('/connectors/maps/route', async function (req, res) {
    const key = process.env.GOOGLE_MAPS_API_KEY;
    if (!key) return res.status(501).json({ ok: false, error: 'no key' });
    const origin = String(req.query.origin || '').trim();
    const dest = String(req.query.destination || req.query.dest || '').trim();
    const mode = String(req.query.mode || 'driving').toLowerCase();
    if (!origin || !dest) return res.status(400).json({ ok: false, error: 'need origin and destination' });
    try {
      const r = await axios.get('https://maps.googleapis.com/maps/api/directions/json', {
        params: { origin: origin, destination: dest, mode: mode, key: key }
      });
      if (r.data.status && r.data.status !== 'OK') {
        return res.json({ ok: false, error: r.data.status });
      }
      const route = (r.data.routes || [])[0];
      const leg = route && route.legs && route.legs[0];
      function decodePoly(enc) {
        const out = [];
        if (!enc) return out;
        let index = 0, lat = 0, lng = 0;
        while (index < enc.length) {
          let b, shift = 0, result = 0;
          do { b = enc.charCodeAt(index++) - 63; result |= (b & 31) << shift; shift += 5; } while (b >= 32);
          lat += (result & 1) ? ~(result >> 1) : (result >> 1);
          shift = 0; result = 0;
          do { b = enc.charCodeAt(index++) - 63; result |= (b & 31) << shift; shift += 5; } while (b >= 32);
          lng += (result & 1) ? ~(result >> 1) : (result >> 1);
          out.push([lat / 1e5, lng / 1e5]);
        }
        return out;
      }
      let pts = [];
      (leg && leg.steps || []).forEach(function (step) {
        const p = step.polyline && step.polyline.points;
        if (p) pts = pts.concat(decodePoly(p));
      });
      const enc = route && route.overview_polyline && route.overview_polyline.points;
      if (pts.length < 4) pts = decodePoly(enc);
      if (!pts.length) return res.json({ ok: false, error: 'no poly' });
      res.json({
        ok: true,
        pts: pts,
        poly: enc,
        duration: leg && leg.duration && leg.duration.text,
        distance: leg && leg.distance && leg.distance.text
      });
    } catch (e) {
      res.status(502).json({ ok: false, error: e.message || 'route failed' });
    }
  });

  function placeHas(hay, needle) {
    const n = String(needle || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp('(?:^|[^a-z0-9])' + n + '(?:[^a-z0-9]|$)', 'i').test(String(hay || ''));
  }

  function matchPlace(key, places) {
    for (let i = 0; i < places.length; i++) {
      if (placeHas(key, places[i][0])) return places[i][1];
    }
    return '';
  }

  function flightIata(s) {
    const raw = String(s || '').trim();
    if (!raw) return '';
    if (/^\/[mg]\//i.test(raw)) return raw === '/m/0d060g' ? 'YVR' : raw;
    if (raw.indexOf(',') !== -1) {
      return raw.split(',').map(function (p) { return flightIata(p.trim()); }).filter(Boolean).join(',');
    }
    const up = raw.toUpperCase();
    const expand = {
      TYO: 'NRT,HND', NYC: 'JFK,EWR,LGA', LON: 'LHR,LGW,STN', PAR: 'CDG,ORY',
      ROM: 'FCO,CIA', MIL: 'MXP,LIN', SEL: 'ICN,GMP', BJS: 'PEK,PKX',
      SHA: 'PVG,SHA', WAS: 'IAD,DCA,BWI', CHI: 'ORD,MDW', YTO: 'YYZ,YTZ',
      OSA: 'KIX,ITM', MOW: 'SVO,DME,VKO', STO: 'ARN,BMA', BER: 'BER',
      USA: '/m/09c7w0', UNI: '/m/09c7w0'
    };
    if (/^[A-Z]{3}$/.test(up)) return expand[up] || up;
    const key = raw.toLowerCase();
    const cities = [
      ['new york', 'JFK,EWR,LGA'], ['los angeles', 'LAX'], ['hong kong', 'HKG'],
      ['vancouver', 'YVR'], ['north vancouver', 'YVR'], ['west vancouver', 'YVR'],
      ['burnaby', 'YVR'], ['surrey', 'YVR'], ['richmond', 'YVR'], ['coquitlam', 'YVR'],
      ['langley', 'YVR'], ['delta', 'YVR'], ['abbotsford', 'YXX'],
      ['new westminster', 'YVR'], ['toronto', 'YYZ,YTZ'], ['calgary', 'YYC'],
      ['montreal', 'YUL'], ['ottawa', 'YOW'], ['edmonton', 'YEG'],
      ['tokyo', 'NRT,HND'], ['osaka', 'KIX,ITM'], ['kyoto', 'KIX,ITM'],
      ['maldives', 'MLE'], ['malé', 'MLE'],
      ['london', 'LHR,LGW,STN'], ['paris', 'CDG,ORY'], ['dubai', 'DXB'],
      ['singapore', 'SIN'], ['seattle', 'SEA'], ['cairo', 'CAI'],
      ['beijing', 'PEK,PKX'], ['shanghai', 'PVG'], ['seoul', 'ICN,GMP'],
      ['bangkok', 'BKK'], ['rome', 'FCO,CIA'], ['sydney', 'SYD'], ['melbourne', 'MEL']
    ];
    const dests = [
      ['united states', '/m/09c7w0'], ['u.s.a', '/m/09c7w0'], ['united kingdom', '/m/07ssc'],
      ['great britain', '/m/07ssc'], ['south korea', '/m/06qd3'], ['new zealand', '/m/0ctw_b'],
      ['south africa', 'JNB'], ['japan', '/m/03_3d'], ['egypt', '/m/02k54'],
      ['china', '/m/0d05w3'], ['korea', '/m/06qd3'], ['france', '/m/0f8l9c'],
      ['germany', '/m/0345h'], ['italy', '/m/03rjj'], ['spain', '/m/06mkj'],
      ['australia', '/m/0chghy'], ['india', '/m/03rk0'], ['brazil', '/m/015fr'],
      ['mexico', '/m/0b90_r'], ['thailand', '/m/07f1x'], ['vietnam', '/m/01crd5'],
      ['indonesia', '/m/03ryn'], ['philippines', '/m/05v8c'], ['england', 'LHR,LGW,STN'],
      ['britain', '/m/07ssc'], ['canada', '/m/0d060g']
    ];
    return matchPlace(key, cities) || matchPlace(key, dests) || '';
  }

  function flightOrigin(s) {
    const raw = String(s || '').trim();
    if (!raw) return 'YVR';
    if (raw === '/m/0d060g') return 'YVR';
    if (/^\/[mg]\//i.test(raw) && raw !== '/m/0d060g') return raw;
    if (/^[A-Z]{3}$/i.test(raw)) {
      const up = raw.toUpperCase();
      if (up === 'USA' || up === 'UNI' || up === 'EIL' || up === 'ETH' || up === 'VDA') return 'YVR';
      return up;
    }
    const id = flightIata(raw);
    if (id && !/^\/[mg]\//i.test(id) && id.indexOf(',') === -1) return id;
    if (id && id.indexOf(',') !== -1) return id.split(',')[0];
    const key = raw.toLowerCase();
    if (placeHas(key, 'eilat') || placeHas(key, 'israel') || placeHas(key, 'eth') || placeHas(key, 'eil')) return 'YVR';
    if (placeHas(key, 'canada') || placeHas(key, 'british columbia') || placeHas(key, 'bc')) return 'YVR';
    return 'YVR';
  }

  function flightMins(n) {
    n = Math.max(0, parseInt(n, 10) || 0);
    const h = Math.floor(n / 60);
    const m = n % 60;
    return h + 'h ' + (m < 10 ? '0' : '') + m + 'm';
  }

  function mapSerpOffer(f, bookUrl, currency) {
    const segs = f && f.flights || [];
    const first = segs[0] || {};
    const last = segs[segs.length - 1] || first;
    const layovers = f && f.layovers || [];
    const dep = first.departure_airport || {};
    const arr = last.arrival_airport || {};
    return {
      airline: first.flight_number || first.airline || '',
      airlineName: first.airline || '',
      from: dep.id || '',
      to: arr.id || '',
      depart: dep.time || '',
      arrive: arr.time || '',
      duration: f && f.total_duration ? flightMins(f.total_duration) : '',
      stops: Math.max(0, segs.length - 1),
      via: layovers.map(function (l) { return l.id || l.name; }).filter(Boolean).join(', '),
      price: f && f.price != null ? Number(f.price) : null,
      currency: currency || 'CAD',
      type: (f && f.type) || '',
      bookingToken: (f && (f.booking_token || f.bookingToken)) || null,
      departureToken: (f && (f.departure_token || f.departureToken)) || null,
      booking_token: (f && (f.booking_token || f.bookingToken)) || null,
      departure_token: (f && (f.departure_token || f.departureToken)) || null,
      segments: (segs || []).map(function (seg) {
        const d = seg.departure_airport || {};
        const a = seg.arrival_airport || {};
        return {
          flight_number: String(seg.flight_number || '').replace(/\s+/g, ''),
          departure_id: d.id || '',
          arrival_id: a.id || '',
          date: String(d.time || '').slice(0, 10)
        };
      }).filter(function (s) {
        return s.flight_number && s.departure_id && s.arrival_id && s.date;
      }),
      bookUrl: bookUrl
    };
  }

  function serpApiKey() {
    return process.env.SERPAPI_KEY || process.env.SERPAPI_API_KEY || process.env.SERP_API_KEY || '';
  }

  async function serpFlights(extra) {
    const params = Object.assign({
      engine: 'google_flights',
      api_key: serpApiKey(),
      currency: 'CAD',
      hl: 'en',
      gl: 'ca'
    }, extra);
    Object.keys(params).forEach(function (k) {
      if (params[k] == null || params[k] === '') delete params[k];
    });
    if (String(params.type) !== '1') delete params.return_date;
    const serp = await axios.get('https://serpapi.com/search.json', {
      params: params,
      timeout: extra && extra.deep_search ? 55000 : (extra && extra.booking_token || extra && extra.selected_flights_json ? 28000 : 22000)
    });
    return (serp && serp.data) || {};
  }

  function mapBookingAgents(data) {
    const list = [];
    function pushAgent(block, suffix) {
      if (!block) return;
      const req = block.booking_request || {};
      const name = block.book_with || 'Seller';
      list.push({
        bookWith: suffix ? (name + ' · ' + suffix) : name,
        title: block.option_title || (block.airline ? 'Airline' : 'Travel site'),
        price: block.price != null ? Number(block.price) : null,
        currency: 'CAD',
        marketedAs: (block.marketed_as || []).join(', '),
        phone: block.booking_phone || null,
        url: req.url || null,
        postData: req.post_data || null
      });
    }
    (data && data.booking_options || []).forEach(function (opt) {
      const together = opt && opt.together;
      if (together && together.booking_request) {
        pushAgent(together);
        return;
      }
      if (opt && opt.separate_tickets) {
        pushAgent(opt.departing, 'outbound');
        pushAgent(opt.returning, 'return');
        return;
      }
      if (together) pushAgent(together);
    });
    return list;
  }

  function pickReturnOffer(offers, price) {
    if (!offers || !offers.length) return null;
    const withTok = offers.filter(function (o) { return o.bookingToken; });
    const pool = withTok.length ? withTok : offers;
    if (price != null && isFinite(Number(price))) {
      const target = Number(price);
      let best = pool[0];
      let bestD = Infinity;
      for (let i = 0; i < pool.length; i++) {
        if (pool[i].price == null) continue;
        if (pool[i].price === target) return pool[i];
        const d = Math.abs(pool[i].price - target);
        if (d < bestD) { bestD = d; best = pool[i]; }
      }
      return best;
    }
    const priced = pool.filter(function (o) { return o.price != null; });
    priced.sort(function (a, b) { return a.price - b.price; });
    return priced[0] || pool[0];
  }

  function flightRoute(src, selected) {
    const segs = (selected && selected.outbound) || (src && Array.isArray(src.segments) ? src.segments : []) || [];
    const first = segs[0] || {};
    const last = segs[segs.length - 1] || first;
    return {
      departure_id: flightOrigin(src && src.from) || 'YVR',
      arrival_id: flightIata(src && src.to) || last.arrival_id || '',
      outbound_date: String((src && src.date) || first.date || '').trim(),
      return_date: String((src && src.return) || '').trim()
    };
  }

  function agentsFromSerp(data) {
    return {
      agents: mapBookingAgents(data),
      selected: null,
      data: data
    };
  }

  function googleAirport(s) {
    const id = flightIata(s);
    if (!id) return '';
    if (id.indexOf(',') !== -1) return id.split(',')[0].trim();
    if (/^\/[mg]\//i.test(id)) {
      const kg = {
        '/m/03_3d': 'TYO', '/m/07dfk': 'TYO', '/m/09c7w0': 'NYC', '/m/07ssc': 'LON',
        '/m/0f8l9c': 'PAR', '/m/0345h': 'BER', '/m/03rjj': 'ROM', '/m/06mkj': 'MAD',
        '/m/0d060g': 'YVR', '/m/0chghy': 'SYD', '/m/03rk0': 'DEL', '/m/015fr': 'GRU',
        '/m/0b90_r': 'MEX', '/m/07f1x': 'BKK', '/m/01crd5': 'SGN', '/m/03ryn': 'CGK',
        '/m/05v8c': 'MNL', '/m/02k54': 'CAI', '/m/06qd3': 'ICN', '/m/0d05w3': 'PEK'
      };
      return kg[id.toLowerCase()] || '';
    }
    return id;
  }

  function googleFlightsDesk(from, to, date, ret) {
    const a = googleAirport(from) || 'YVR';
    const b = googleAirport(to) || 'MLE';
    let flt = a + '.' + b + '.' + date;
    if (ret) flt += '*' + b + '.' + a + '.' + ret;
    return 'https://www.google.com/travel/flights?hl=en&gl=ca&curr=CAD#flt=' + flt;
  }

  app.get('/connectors/flights/search', async function (req, res) {
    const from = flightOrigin(req.query.from);
    const to = flightIata(req.query.to);
    const date = String(req.query.date || '').trim();
    const ret = String(req.query.return || '').trim();
    const adults = Math.max(1, Math.min(9, parseInt(req.query.adults, 10) || 1));
    const cabinRaw = String(req.query.cabin || 'economy').toLowerCase();
    const cabinMap = { economy: 1, 'premium economy': 2, premium: 2, business: 3, first: 4 };
    const travelClass = cabinMap[cabinRaw] || 1;
    if (!from || !to || !date) {
      return res.status(400).json({
        ok: false,
        error: !from || !to
          ? 'Could not match that place to an airport. Try a city (Tokyo, New York) instead of a huge region.'
          : 'need from, to, date'
      });
    }
    const bookUrl = googleFlightsDesk(from, to, date, ret, adults);
    const serpKey = process.env.SERPAPI_KEY || process.env.SERPAPI_API_KEY || process.env.SERP_API_KEY;

    if (serpKey) {
      try {
        const params = {
          engine: 'google_flights',
          api_key: serpKey,
          departure_id: from,
          arrival_id: to,
          outbound_date: date,
          currency: 'CAD',
          hl: 'en',
          gl: 'ca',
          adults: adults,
          travel_class: travelClass,
          type: ret ? 1 : 2,
          sort_by: 1,
          deep_search: true
        };
        if (ret) params.return_date = ret;
        const serp = await axios.get('https://serpapi.com/search.json', { params: params, timeout: 55000 });
        const data = (serp && serp.data) || {};
        if (data.error) {
          return res.json({
            ok: false,
            offers: [],
            bookUrl: (data.search_metadata && data.search_metadata.google_flights_url) || bookUrl,
            provider: 'serpapi',
            error: String(data.error)
          });
        }
        const filled = (data.search_metadata && data.search_metadata.google_flights_url) || bookUrl;
        const raw = [].concat(data.best_flights || [], data.other_flights || []).slice(0, 10);
        const offers = raw.map(function (f) { return mapSerpOffer(f, filled, 'CAD'); });
        return res.json({
          ok: true,
          offers: offers,
          bookUrl: filled,
          provider: 'serpapi',
          lowest: data.price_insights && data.price_insights.lowest_price
        });
      } catch (e) {
        const status = e.response && e.response.status;
        const body = e.response && e.response.data;
        const msg = (body && (body.error || body.message)) || e.message || 'SerpAPI failed';
        console.error('[CONNECTORS] flights serpapi', status || '', msg);
        return res.status(status === 401 || status === 429 ? status : 502).json({
          ok: false,
          offers: [],
          bookUrl: bookUrl,
          provider: 'serpapi',
          error: status === 429 ? 'Flight search quota is used up for this month.' : String(msg)
        });
      }
    }

    try {
      const id = process.env.AMADEUS_CLIENT_ID;
      const secret = process.env.AMADEUS_CLIENT_SECRET;
      if (id && secret) {
        const host = process.env.AMADEUS_HOST || 'https://test.api.amadeus.com';
        const tok = await axios.post(host + '/v1/security/oauth2/token',
          'grant_type=client_credentials&client_id=' + encodeURIComponent(id) +
          '&client_secret=' + encodeURIComponent(secret),
          { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
        const token = tok.data && tok.data.access_token;
        if (token) {
          const params = {
            originLocationCode: from,
            destinationLocationCode: to,
            departureDate: date,
            adults: adults,
            currencyCode: 'CAD',
            max: 8
          };
          if (ret) params.returnDate = ret;
          const off = await axios.get(host + '/v2/shopping/flight-offers', {
            params: params,
            headers: { Authorization: 'Bearer ' + token }
          });
          const offers = (off.data && off.data.data || []).slice(0, 8).map(function (o) {
            const it = (o.itineraries || [])[0] || {};
            const segs = it.segments || [];
            const first = segs[0] || {};
            const last = segs[segs.length - 1] || first;
            const price = o.price && (o.price.grandTotal || o.price.total);
            return {
              airline: (first.carrierCode || '') + (first.number || ''),
              from: first.departure && first.departure.iataCode,
              to: last.arrival && last.arrival.iataCode,
              depart: first.departure && first.departure.at,
              arrive: last.arrival && last.arrival.at,
              duration: it.duration || '',
              stops: Math.max(0, segs.length - 1),
              price: price ? Number(price) : null,
              currency: (o.price && o.price.currency) || 'CAD',
              bookUrl: bookUrl
            };
          });
          if (offers.length) return res.json({ ok: true, offers: offers, bookUrl: bookUrl, provider: 'amadeus' });
        }
      }
    } catch (e) {
      console.error('[CONNECTORS] flights amadeus', e.message);
    }
    res.json({
      ok: false,
      offers: [],
      bookUrl: bookUrl,
      provider: 'none',
      error: 'Set SERPAPI_KEY on Render, then redeploy.'
    });
  });

  async function handleFlightAgents(req, res) {
    const src = Object.assign({}, req.query || {}, req.body || {});
    const bookingToken = String(src.booking_token || src.bookingToken || '').trim();
    const departureToken = String(src.departure_token || src.departureToken || '').trim();
    let selected = src.selected_flights;
    if (typeof selected === 'string') {
      try { selected = JSON.parse(selected); } catch (e) { selected = null; }
    }
    if (!selected && Array.isArray(src.segments) && src.segments.length) {
      selected = { outbound: src.segments };
    }
    if (!bookingToken && !departureToken && !(selected && selected.outbound && selected.outbound.length)) {
      return res.status(400).json({ ok: false, agents: [], error: 'need this flight\'s booking token' });
    }
    if (!serpApiKey()) {
      return res.status(501).json({ ok: false, agents: [], error: 'Set SERPAPI_KEY on Render, then redeploy.' });
    }
    try {
      let data;
      const cabinRaw = String(src.cabin || 'economy').toLowerCase();
      const cabinMap = { economy: 1, 'premium economy': 2, premium: 2, business: 3, first: 4 };
      const ret = String(src.return || '').trim();
      const adults = Math.max(1, Math.min(9, parseInt(src.adults, 10) || 1));
      const travelClass = cabinMap[cabinRaw] || 1;
      const route = flightRoute(src, selected);
      if (!route.departure_id) {
        return res.status(400).json({ ok: false, agents: [], error: 'missing departure_id' });
      }
      const pinReturn = !!(selected && selected.return && selected.return.length);
      const tripType = (bookingToken || pinReturn) && ret ? 1 : 2;
      const base = {
        departure_id: route.departure_id,
        arrival_id: route.arrival_id || undefined,
        outbound_date: route.outbound_date || undefined,
        adults: adults,
        travel_class: travelClass,
        type: tripType
      };
      if (tripType === 1 && route.return_date) base.return_date = route.return_date;
      if (bookingToken) {
        data = await serpFlights({
          departure_id: route.departure_id,
          arrival_id: route.arrival_id || undefined,
          booking_token: bookingToken,
          adults: adults,
          travel_class: travelClass
        });
      } else if (selected && selected.outbound && selected.outbound.length) {
        data = await serpFlights(Object.assign({}, base, {
          selected_flights_json: JSON.stringify(selected)
        }));
      } else if (departureToken) {
        data = await serpFlights(Object.assign({}, base, { departure_token: departureToken }));
      }
      if (data.error) {
        return res.json({ ok: false, agents: [], provider: 'serpapi', error: String(data.error) });
      }
      const out = agentsFromSerp(data);
      const filled = out.data && out.data.search_metadata && out.data.search_metadata.google_flights_url;
      return res.json({
        ok: !!(out.agents && out.agents.length),
        agents: out.agents || [],
        selected: out.selected || null,
        provider: 'serpapi',
        bookUrl: filled || null,
        error: (out.agents && out.agents.length) ? null : (out.error || 'No booking agents for this flight.')
      });
    } catch (e) {
      const status = e.response && e.response.status;
      const body = e.response && e.response.data;
      const msg = (body && (body.error || body.message)) || e.message || 'SerpAPI failed';
      console.error('[CONNECTORS] flights agents', status || '', msg);
      return res.status(status === 401 || status === 429 ? status : 502).json({
        ok: false,
        agents: [],
        provider: 'serpapi',
        error: status === 429
          ? 'Flight search quota is used up for this month.'
          : (/timeout/i.test(String(msg)) ? 'Sellers took too long. Use Google Flights (top right) for this trip.' : String(msg))
      });
    }
  }

  app.post('/connectors/flights/agents', handleFlightAgents);
  app.get('/connectors/flights/agents', handleFlightAgents);

  app.get('/connectors/maps/js', function (req, res) {
    const key = process.env.GOOGLE_MAPS_API_KEY;
    const cb = String(req.query.callback || '_synGmapsReady').replace(/[^\w.]/g, '') || '_synGmapsReady';
    if (!key) return res.status(501).type('application/javascript').send('window.' + cb + '&&window.' + cb + '();');
    res.redirect('https://maps.googleapis.com/maps/api/js?key=' + encodeURIComponent(key) + '&libraries=places,geometry&callback=' + encodeURIComponent(cb));
  });

  app.get('/connectors/list', async function (req, res) {
    try {
      const userId = String(req.query.user_id || '').trim();
      if (!userId) return res.status(400).json({ ok: false, error: 'user_id required' });
      const rows = await sbGet(userId);
      const connected = {};
      rows.forEach(function (r) {
        connected[r.provider] = {
          provider: r.provider,
          account: r.account_label || null,
          connectedAt: r.connected_at
        };
      });
      res.json({ ok: true, providers: catalog(), connected });
    } catch (e) {
      console.error('[CONNECTORS] list', e.response && e.response.data || e.message);
      res.json({ ok: true, providers: catalog(), connected: {}, error: 'Could not read saved connectors.' });
    }
  });

  app.get('/connectors/auth/:provider', function (req, res) {
    const provider = String(req.params.provider || '').toLowerCase();
    const userId = String(req.query.user_id || '').trim();
    if (!userId) return res.status(400).send('Sign in first.');
    const state = signState({ u: userId, p: provider, t: Date.now() });

    if (provider === 'maps') {
      if (!process.env.GOOGLE_MAPS_API_KEY) return res.status(501).send('Google Maps is not configured. Set GOOGLE_MAPS_API_KEY on the server.');
      sbUpsert({
        user_id: userId,
        provider: 'maps',
        refresh_token: 'server-key',
        access_token: null,
        account_label: 'Maps API',
        scopes: 'places,directions,geocode'
      }).then(function () {
        res.send(closeHtml(true, 'maps', 'Google Maps is ready.'));
      }).catch(function (e) {
        console.error('[CONNECTORS] maps enable', e.response && e.response.data || e.message);
        // Key is live — directions still work even if the save table is missing.
        res.send(closeHtml(true, 'maps', 'Google Maps is ready. (Run connectors-schema.sql in Supabase so this stays saved.)'));
      });
      return;
    }
    if (provider === 'google') {
      if (!process.env.GOOGLE_CLIENT_ID) return res.status(501).send('Google OAuth is not configured on the server.');
      const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      url.searchParams.set('client_id', process.env.GOOGLE_CLIENT_ID);
      url.searchParams.set('redirect_uri', PUBLIC_URL + '/connectors/callback/google');
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('scope', GOOGLE_SCOPES);
      url.searchParams.set('access_type', 'offline');
      url.searchParams.set('prompt', 'consent');
      url.searchParams.set('include_granted_scopes', 'true');
      url.searchParams.set('state', state);
      return res.redirect(url.toString());
    }
    if (provider === 'github') {
      if (!process.env.GITHUB_CLIENT_ID) return res.status(501).send('GitHub OAuth is not configured.');
      const url = new URL('https://github.com/login/oauth/authorize');
      url.searchParams.set('client_id', process.env.GITHUB_CLIENT_ID);
      url.searchParams.set('redirect_uri', PUBLIC_URL + '/connectors/callback/github');
      url.searchParams.set('scope', GITHUB_SCOPES);
      url.searchParams.set('state', state);
      return res.redirect(url.toString());
    }
    if (provider === 'notion') {
      if (!process.env.NOTION_CLIENT_ID) return res.status(501).send('Notion OAuth is not configured.');
      const url = new URL('https://api.notion.com/v1/oauth/authorize');
      url.searchParams.set('client_id', process.env.NOTION_CLIENT_ID);
      url.searchParams.set('redirect_uri', PUBLIC_URL + '/connectors/callback/notion');
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('owner', 'user');
      url.searchParams.set('state', state);
      return res.redirect(url.toString());
    }
    res.status(404).send('Unknown provider');
  });

  app.get('/connectors/callback/:provider', async function (req, res) {
    const provider = String(req.params.provider || '').toLowerCase();
    const st = readState(req.query.state);
    if (!st || st.p !== provider || !st.u) return res.status(400).send(closeHtml(false, provider, 'Invalid or expired sign-in.'));
    if (Date.now() - st.t > 15 * 60 * 1000) return res.status(400).send(closeHtml(false, provider, 'That sign-in timed out. Try again.'));
    const code = req.query.code;
    if (!code) return res.status(400).send(closeHtml(false, provider, 'No authorization code.'));

    try {
      if (provider === 'google') {
        const tok = await axios.post('https://oauth2.googleapis.com/token', {
          code,
          client_id: process.env.GOOGLE_CLIENT_ID,
          client_secret: process.env.GOOGLE_CLIENT_SECRET,
          redirect_uri: PUBLIC_URL + '/connectors/callback/google',
          grant_type: 'authorization_code'
        });
        const refresh = tok.data.refresh_token;
        if (!refresh) return res.status(400).send(closeHtml(false, 'google', 'Google did not return a refresh token. Disconnect the app in your Google account and try again.'));
        let label = '';
        try {
          const me = await axios.get('https://www.googleapis.com/oauth2/v2/userinfo', {
            headers: { Authorization: 'Bearer ' + tok.data.access_token }
          });
          label = me.data.email || '';
        } catch (e) {}
        await sbUpsert({
          user_id: st.u,
          provider: 'google',
          refresh_token: refresh,
          access_token: tok.data.access_token || null,
          access_expires_at: new Date(Date.now() + (tok.data.expires_in || 3500) * 1000).toISOString(),
          account_label: label,
          scopes: GOOGLE_SCOPES,
          updated_at: new Date().toISOString()
        });
        return res.send(closeHtml(true, 'google', label ? 'Connected ' + label : 'Google connected.'));
      }

      if (provider === 'github') {
        const tok = await axios.post('https://github.com/login/oauth/access_token', {
          client_id: process.env.GITHUB_CLIENT_ID,
          client_secret: process.env.GITHUB_CLIENT_SECRET,
          code,
          redirect_uri: PUBLIC_URL + '/connectors/callback/github'
        }, { headers: { Accept: 'application/json' } });
        const access = tok.data.access_token;
        if (!access) return res.status(400).send(closeHtml(false, 'github', 'GitHub did not return a token.'));
        let label = '';
        try {
          const me = await axios.get('https://api.github.com/user', {
            headers: { Authorization: 'Bearer ' + access, 'User-Agent': 'synapses-connectors' }
          });
          label = me.data.login || '';
        } catch (e) {}
        await sbUpsert({
          user_id: st.u,
          provider: 'github',
          refresh_token: access,
          access_token: access,
          account_label: label,
          scopes: GITHUB_SCOPES,
          updated_at: new Date().toISOString()
        });
        return res.send(closeHtml(true, 'github', label ? 'Connected @' + label : 'GitHub connected.'));
      }

      if (provider === 'notion') {
        const basic = Buffer.from(process.env.NOTION_CLIENT_ID + ':' + process.env.NOTION_CLIENT_SECRET).toString('base64');
        const tok = await axios.post('https://api.notion.com/v1/oauth/token', {
          grant_type: 'authorization_code',
          code,
          redirect_uri: PUBLIC_URL + '/connectors/callback/notion'
        }, { headers: { Authorization: 'Basic ' + basic, 'Content-Type': 'application/json' } });
        const access = tok.data.access_token;
        if (!access) return res.status(400).send(closeHtml(false, 'notion', 'Notion did not return a token.'));
        const label = (tok.data.workspace_name || tok.data.owner && tok.data.owner.user && tok.data.owner.user.name) || 'Notion';
        await sbUpsert({
          user_id: st.u,
          provider: 'notion',
          refresh_token: access,
          access_token: access,
          account_label: label,
          scopes: 'notion',
          updated_at: new Date().toISOString()
        });
        return res.send(closeHtml(true, 'notion', 'Connected ' + label + '.'));
      }
    } catch (e) {
      console.error('[CONNECTORS] callback', provider, e.response && e.response.data || e.message);
      return res.status(500).send(closeHtml(false, provider, 'Could not finish connecting. Check server logs.'));
    }
    res.status(404).send(closeHtml(false, provider, 'Unknown provider'));
  });

  app.post('/connectors/disconnect', async function (req, res) {
    try {
      const userId = String((req.body && req.body.user_id) || '').trim();
      const provider = String((req.body && req.body.provider) || '').trim().toLowerCase();
      if (!userId || !provider) return res.status(400).json({ ok: false, error: 'user_id and provider required' });
      await sbDelete(userId, provider);
      res.json({ ok: true });
    } catch (e) {
      console.error('[CONNECTORS] disconnect', e.message);
      res.status(500).json({ ok: false, error: 'Disconnect failed' });
    }
  });

  // Regex (cxDetect on the client) misses a lot of natural phrasing —
  // "shoot ken an email about the invoice", "what's happening this
  // weekend", "gas station close by". Rather than growing the regex list
  // forever, the client falls back to this single Groq tool-calling call
  // ONLY when its own regex found nothing. One call, small model, tight
  // system prompt, fails closed to {hit:null} on any error/timeout/no-tool-
  // picked so a miss here just falls through to plain chat same as before —
  // it never blocks or breaks the existing fast regex path.
  async function classifyConnectorIntent(text) {
    const t = String(text || '').trim();
    if (!t) return null;
    const GROQ_KEYS = (process.env.GROQ_KEYS || '').split(',').filter(Boolean);
    if (!GROQ_KEYS.length) return null;
    const groqKey = GROQ_KEYS[Math.floor(Math.random() * GROQ_KEYS.length)];
    const tools = [
      { type: 'function', function: { name: 'gmail_search', description: 'Search the user\'s Gmail for messages matching a query (sender, subject, topic).', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } } },
      { type: 'function', function: { name: 'gmail_unread', description: 'Check/read the user\'s inbox — unread or recent mail, no specific search term.', parameters: { type: 'object', properties: {} } } },
      { type: 'function', function: { name: 'gmail_triage', description: 'Scan the whole inbox and flag which emails are safe to delete (newsletters/promos) vs keep.', parameters: { type: 'object', properties: {} } } },
      { type: 'function', function: { name: 'gmail_compose', description: 'Draft or send a new email, or reply to the last-viewed email.', parameters: { type: 'object', properties: { is_reply: { type: 'boolean' } } } } },
      { type: 'function', function: { name: 'calendar_create', description: 'Add a new event, reminder, or appointment to the user\'s Google Calendar.', parameters: { type: 'object', properties: {} } } },
      { type: 'function', function: { name: 'calendar_upcoming', description: 'Show what\'s on the user\'s calendar/schedule, or whether they\'re free.', parameters: { type: 'object', properties: { days: { type: 'integer' } } } } },
      { type: 'function', function: { name: 'maps_directions', description: 'Directions/navigation/route to a specific named destination.', parameters: { type: 'object', properties: { destination: { type: 'string' }, origin: { type: 'string' } }, required: ['destination'] } } },
      { type: 'function', function: { name: 'maps_search', description: 'Find nearby places of a type — restaurants, gas, coffee, pharmacy, etc.', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } } },
      { type: 'function', function: { name: 'maps_geocode', description: 'Look up the address/location of one specific named place.', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } } }
    ];
    try {
      const r = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
        model: 'llama-3.3-70b-versatile',
        messages: [
          { role: 'system', content: 'Route the user\'s message to a connected-app tool (Gmail, Calendar, Google Maps) ONLY if it is clearly asking to do one of those things. Plain conversation, general questions, or anything ambiguous — call no tool at all.' },
          { role: 'user', content: t }
        ],
        tools,
        tool_choice: 'auto',
        max_tokens: 200,
        reasoning_effort: 'none',
        reasoning_format: 'hidden'
      }, { headers: { Authorization: `Bearer ${groqKey}`, 'Content-Type': 'application/json' }, timeout: 6000 });
      const msg = r.data && r.data.choices && r.data.choices[0] && r.data.choices[0].message;
      const call = msg && msg.tool_calls && msg.tool_calls[0];
      if (!call) return null;
      let args = {};
      try { args = JSON.parse(call.function.arguments || '{}'); } catch (e) { args = {}; }
      switch (call.function.name) {
        case 'gmail_search': return { kind: 'act', action: 'gmail.search', args: { q: args.query || t } };
        case 'gmail_unread': return { kind: 'act', action: 'gmail.unread', args: {} };
        case 'gmail_triage': return { kind: 'act', action: 'gmail.triage', args: {} };
        case 'gmail_compose': return { kind: 'act', action: 'gmail.composeParse', args: { text: t, fresh: true, isReply: !!args.is_reply } };
        case 'calendar_create': return { kind: 'act', action: 'calendar.create', args: { title: t, text: t }, needsConfirm: true };
        case 'calendar_upcoming': return { kind: 'act', action: 'calendar.upcoming', args: { days: args.days || 7 } };
        case 'maps_directions': return { kind: 'act', action: 'maps.directions', args: { destination: args.destination || '', origin: args.origin || '' } };
        case 'maps_search': return { kind: 'act', action: 'maps.search', args: { q: args.query || t } };
        case 'maps_geocode': return { kind: 'act', action: 'maps.geocode', args: { q: args.query || t } };
        default: return null;
      }
    } catch (e) {
      console.error('[CONNECTORS] intent classify', e.response && e.response.data || e.message);
      return null; // fail closed — client falls through to plain chat
    }
  }

  app.post('/connectors/intent', async function (req, res) {
    try {
      const text = String((req.body && req.body.text) || '').trim();
      if (!text) return res.json({ hit: null });
      const hit = await classifyConnectorIntent(text);
      res.json({ hit });
    } catch (e) {
      console.error('[CONNECTORS] intent route', e.message);
      res.json({ hit: null }); // fail closed
    }
  });

  app.post('/connectors/act', async function (req, res) {
    try {
      const userId = String((req.body && req.body.user_id) || '').trim();
      const action = String((req.body && req.body.action) || '').trim();
      if (!userId || !action) return res.status(400).json({ ok: false, error: 'user_id and action required' });
      const out = await runAction(userId, action, (req.body && req.body.args) || {}, !!(req.body && req.body.confirm));
      res.json(out);
    } catch (e) {
      console.error('[CONNECTORS] act', e.response && e.response.data || e.message);
      const status = e.response && e.response.status;
      if (status === 401 || status === 403) {
        return res.json({ ok: false, needConnect: 'google', error: 'Access expired. Reconnect the app in Profile.' });
      }
      res.status(500).json({ ok: false, error: 'Connector action failed.' });
    }
  });

  console.log('[CONNECTORS] mounted  /connectors/auth /list /act /intent');
}

module.exports = { mount, catalog };
