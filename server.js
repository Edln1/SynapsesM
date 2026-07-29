const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// Browser agent — safe load, server still boots if browser-agent.js is missing
let initBrowserAgent = () => {};
let runBrowserAgentTask = async () => null;
let hasBrowserExtension = () => false;
let sendBrowserCommand = async () => { throw new Error('no_extension'); };
let runDoorDashOrder = async () => null;
try {
  const ba = require('./browser-agent');
  initBrowserAgent = ba.initBrowserAgent;
  runBrowserAgentTask = ba.runBrowserAgentTask;
  hasBrowserExtension = ba.hasBrowserExtension;
  sendBrowserCommand = ba.sendBrowserCommand;
  if (ba.runDoorDashOrder) runDoorDashOrder = ba.runDoorDashOrder;
} catch(e) { console.log('[BROWSER] browser-agent.js not found, browser control disabled'); }

const app = express();
// Stripe's webhook needs the RAW request body to verify its signature — if the
// global JSON parser touches it first, the raw bytes are gone and signature
// verification fails every time. So this global parser skips that one path;
// stripe-routes.js supplies its own express.raw() specifically for it.
app.use((req, res, next) => {
  if (req.path === '/stripe-webhook') return next();
  // Default express.json() limit is 100kb — fine for normal chat, but the
  // client can now attach images to /groq-chat as base64 data URLs inside
  // the JSON body (for the qwen/qwen3.6-27b vision model), which are easily
  // several MB each. Bumped so those requests don't 413 before they arrive.
  express.json({ limit: '20mb' })(req, res, next);
});

// Allow browser requests from any origin (for SynBot in HTML)
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ── Stripe payment routes (checkout, billing portal, webhook) ──────────────
// Adds POST /create-checkout-session, POST /create-portal-session, POST /stripe-webhook
const stripeRoutes = require('./stripe-routes');
app.use(stripeRoutes);

const VERIFY_TOKEN = 'synapses_verify_2026';

// ── Guest usage gate (server-side, by IP) ──
// Client-side localStorage can be cleared by the user, so guests get a real
// per-IP daily cap here that they can't wipe by clearing cookies/storage.
// Logged-in users are NOT limited here — their limit is already enforced via
// the client + Supabase usage_count reconciliation, so they just pass through.
const GUEST_DAILY_LIMIT = 10;
const guestUsage = {}; // { "ip": { date: "2026-07-12", count: 0 } }

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function getClientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  return fwd ? fwd.split(',')[0].trim() : req.socket.remoteAddress;
}

function checkGuestLimit(req, res, next) {
  const userId = req.body && req.body.userId;
  if (userId) return next(); // logged-in call — already accounted for client-side + Supabase

  const ip = getClientIp(req);

  // Whitelisted IPs (e.g. your own, for testing) skip the guest limit entirely.
  // Set on Render as an env var: WHITELISTED_IPS=1.2.3.4,5.6.7.8
  const whitelist = (process.env.WHITELISTED_IPS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (whitelist.includes(ip)) return next();

  const today = todayStr();
  if (!guestUsage[ip] || guestUsage[ip].date !== today) {
    guestUsage[ip] = { date: today, count: 0 };
  }
  if (guestUsage[ip].count >= GUEST_DAILY_LIMIT) {
    return res.status(429).json({ error: 'limit_reached', message: 'Daily free limit reached — create an account or go Pro for unlimited access.' });
  }
  guestUsage[ip].count++;
  next();
}

const WA_PHONE_NUMBER_ID = process.env.WA_PHONE_NUMBER_ID;
const WA_ACCESS_TOKEN = process.env.WA_ACCESS_TOKEN;
const GROQ_KEYS = (process.env.GROQ_KEYS || '').split(',').filter(Boolean);
const SUPABASE_URL = 'https://wockoewhlybhboprluxv.supabase.co';
const APIFY_TOKEN = process.env.APIFY_TOKEN;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const TAVILY_KEYS = (process.env.TAVILY_KEYS || process.env.TAVILY_KEY || '').split(',').filter(Boolean);
const BROWSERBASE_API_KEY = process.env.BROWSERBASE_API_KEY;
const BROWSERBASE_PROJECT_ID = process.env.BROWSERBASE_PROJECT_ID;
let tavilyKeyIndex = 0;
function getTavilyKey() {
  const key = TAVILY_KEYS[tavilyKeyIndex % TAVILY_KEYS.length];
  tavilyKeyIndex++;
  return key;
}

// Tavily search with automatic key rotation on 429 — tries every key before giving up
async function tavilySearch(params) {
  const totalKeys = TAVILY_KEYS.length;
  // Start from current index but try ALL keys before giving up
  const startIndex = tavilyKeyIndex;
  for (let i = 0; i < Math.max(totalKeys, 1); i++) {
    const keyIndex = (startIndex + i) % totalKeys;
    const key = TAVILY_KEYS[keyIndex];
    tavilyKeyIndex = (keyIndex + 1) % totalKeys; // advance global index
    try {
      const res = await axios.post('https://api.tavily.com/search', {
        ...params,
        api_key: key
      });
      return res.data;
    } catch(e) {
      const status = e.response?.status;
      if (status === 429 && i < totalKeys - 1) {
        console.log(`[TAVILY] Key ${i+1}/${totalKeys} rate limited (429), trying next key...`);
        await new Promise(r => setTimeout(r, 1000));
        continue;
      }
      throw e;
    }
  }
  throw new Error('All Tavily keys rate limited (429)');
}

let groqKeyIndex = Math.floor(Math.random() * 1000);
const conversationHistory = {};
const lastGmailAction = {}; // phone -> { type, email } — tracks last email actioned for "reply to that", "archive that" etc
const lastNotesList = {}; // phone -> notes array for "read note X" command
const lastVisitedSite = {}; // phone -> { url, name, type } — tracks last browsed site for context-aware commands
const lastResearchTopic = {}; // phone -> { topic, summary } — tracks last briefing/research topic for natural follow-up conversation
const pendingRedditPost = {}; // phone -> { subreddit } — waiting for user to provide title+body
const pendingOrders = {};     // phone -> { restaurant, item } — waiting for yes/no confirmation
const pendingCallRequests = {}; // phone -> { contactName, objective } — waiting for the user to supply the contact's number
const delegatedCalls = {};    // vapi callId -> { requestingUser, contactName, objective } — lets end-of-call-report notify the right person, not just the contact who was called
const browserModeActive = {}; // phone -> timestamp — user is in browser mode, skip "open chrome" trigger for 5 min

// RAM cache for memory — avoids Supabase read on every message
const memoryCache = {};        // phone -> { memory, cachedAt }
const CACHE_TTL = 5 * 60000;  // 5 minutes // phone -> [{role, content}]

function getHistory(phone) {
  if (!conversationHistory[phone]) conversationHistory[phone] = [];
  return conversationHistory[phone];
}

function addToHistory(phone, role, content) {
  const history = getHistory(phone);
  history.push({ role, content });
  // Keep last 10 messages only
  if (history.length > 6) history.splice(0, history.length - 6);
}

// Memory functions
async function loadMemory(phone) {
  // Return cached memory if fresh
  const cached = memoryCache[phone];
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL) return cached.memory;
  // Otherwise fetch from Supabase and cache it
  try {
    const res = await axios.get(`${SUPABASE_URL}/rest/v1/user_memory?user_phone=eq.${phone}`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
    });
    const memory = res.data[0]?.memory || {};
    memoryCache[phone] = { memory, cachedAt: Date.now() };
    return memory;
  } catch(e) { return {}; }
}

async function saveMemory(phone, memory) {
  // Update cache immediately
  memoryCache[phone] = { memory, cachedAt: Date.now() };
  try {
    await axios.post(`${SUPABASE_URL}/rest/v1/user_memory`, 
      { user_phone: phone, memory, updated_at: new Date().toISOString() },
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates' } }
    );
  } catch(e) {}
}


// ── Mem0 Memory Layer ─────────────────────────────────────────────────────
const MEM0_API_KEY = process.env.MEM0_API_KEY;
const MEM0_BASE = 'https://api.mem0.ai/v1';
const _mem0Cache = {}; // keyed by userId+query, cleared on save

async function mem0Recall(userId, query) {
  const cacheKey = userId + '::' + query.slice(0, 50);
  const cached = _mem0Cache[cacheKey];
  if (cached && Date.now() - cached.ts < 30000) return cached.result;
  try {
    const res = await axios.post(MEM0_BASE + '/memories/search/', {
      query, user_id: userId, limit: 5
    }, { headers: { Authorization: 'Token ' + MEM0_API_KEY, 'Content-Type': 'application/json' } });
    const memories = (res.data.results || res.data || []).map(m => m.memory || m.text || '').filter(Boolean);
    const result = memories.join('. ');
    _mem0Cache[cacheKey] = { result, ts: Date.now() };
    return result;
  } catch(e) { console.warn('[Mem0] recall failed:', e.message); return ''; }
}

async function mem0Save(userId, messages) {
  try {
    await axios.post(MEM0_BASE + '/memories/', {
      messages, user_id: userId
    }, { headers: { Authorization: 'Token ' + MEM0_API_KEY, 'Content-Type': 'application/json' } });
    // Invalidate cache for this user
    Object.keys(_mem0Cache).forEach(k => { if (k.startsWith(userId + '::')) delete _mem0Cache[k]; });
    console.log('[Mem0] saved for', userId);
  } catch(e) { console.warn('[Mem0] save failed:', e.message); }
}

function mem0ToContext(memories) {
  if (!memories) return '';
  return '\n\nDeep memory (from past conversations — use naturally, never recite):\n' + memories;
}
// ── End Mem0 Layer ────────────────────────────────────────────────────────

// ─── REMINDERS ───────────────────────────────────────────────
async function saveReminder(phone, message, fireAt) {
  try {
    await axios.post(`${SUPABASE_URL}/rest/v1/reminders`,
      { user_phone: phone, message, fire_at: fireAt.toISOString(), sent: false },
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' } }
    );
  } catch(e) { console.error('saveReminder error:', e.message); }
}

async function checkAndFireReminders() {
  try {
    const now = new Date().toISOString();
    const res = await axios.get(
      `${SUPABASE_URL}/rest/v1/reminders?sent=eq.false&fire_at=lte.${now}`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    const due = res.data || [];
    for (const reminder of due) {
      try {
        await sendWhatsApp(reminder.user_phone, `⏰ Reminder: ${reminder.message}`);
      } catch(e) { console.error('fireReminder sendWhatsApp error:', e.message); }
      // Always mark as sent — even if WhatsApp fails — so it doesn't loop forever
      try {
        await axios.patch(
          `${SUPABASE_URL}/rest/v1/reminders?id=eq.${reminder.id}`,
          { sent: true },
          { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' } }
        );
      } catch(e) { console.error('fireReminder patch error:', e.message); }
    }
  } catch(e) { console.error('checkReminders error:', e.message); }
}

async function parseReminder(phone, text) {
  try {
    const key = getGroqKey();
    const now = new Date();
    const res = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
      model: 'llama-3.1-8b-instant',
      messages: [
        {
          role: 'system',
          content: `You parse reminder requests into JSON. Current Vancouver time is ${now.toLocaleString('en-US', {timeZone:'America/Vancouver'})}. Current UTC is ${now.toISOString()}.
Extract the reminder message and when to fire it in minutes from now.
Reply with ONLY valid JSON like: {"message":"call John","minutes":120}
"minutes" is how many minutes from NOW to fire the reminder.
Examples:
- "remind me to call John in 2 hours" → {"message":"call John","minutes":120}
- "remind me about the meeting in 30 minutes" → {"message":"the meeting","minutes":30}
- "remind me to eat lunch in 1 hour" → {"message":"eat lunch","minutes":60}
- "remind me at 9pm to take meds" → calculate minutes from current Vancouver time to 9pm Vancouver time
- "remind me tomorrow at 8am" → calculate minutes until tomorrow 8am Vancouver time
No explanation, just JSON.`
        },
        { role: 'user', content: text }
      ],
      max_tokens: 60
    }, { headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' } });
    const raw = res.data.choices[0].message.content.trim().replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(raw);
    if (!parsed.message || !parsed.minutes || parsed.minutes < 1) return null;
    const fireAt = new Date(now.getTime() + parsed.minutes * 60000);
    return { message: parsed.message, fireAt };
  } catch(e) { return null; }
}
// ─────────────────────────────────────────────────────────────

// ─── SCHEDULED CALLS ─────────────────────────────────────────
// Mirrors the reminders pattern above, but dials via Vapi instead of
// texting. Requires triggerAvaCall() to be defined (see /vapi-call route
// further down) — since that's declared later in the file with `async
// function`, it's hoisted and safe to call from here.
async function saveScheduledCall(phone, reason, fireAt) {
  try {
    await axios.post(`${SUPABASE_URL}/rest/v1/scheduled_calls`,
      { user_phone: phone, reason, fire_at: fireAt.toISOString(), sent: false },
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' } }
    );
  } catch(e) { console.error('saveScheduledCall error:', e.message); }
}

async function checkAndFireScheduledCalls() {
  try {
    const now = new Date().toISOString();
    const res = await axios.get(
      `${SUPABASE_URL}/rest/v1/scheduled_calls?sent=eq.false&fire_at=lte.${now}`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    const due = res.data || [];
    for (const call of due) {
      try {
        await triggerAvaCall(call.user_phone, call.reason ? `Hey, it's Ava — ${call.reason}` : undefined);
        console.log('[SCHEDULED CALL] dialed:', call.user_phone);
      } catch(e) { console.error('scheduledCall dial error:', e.response?.data || e.message); }
      try {
        await axios.patch(
          `${SUPABASE_URL}/rest/v1/scheduled_calls?id=eq.${call.id}`,
          { sent: true },
          { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' } }
        );
      } catch(e) { console.error('scheduledCall patch error:', e.message); }
    }
  } catch(e) { console.error('checkScheduledCalls error:', e.message); }
}
// ─────────────────────────────────────────────────────────────

// ─── BRIEFINGS ───────────────────────────────────────────────
async function saveBriefing(phone, timeUtc, topic, url = null) {
  try {
    await axios.post(`${SUPABASE_URL}/rest/v1/briefings`,
      { user_phone: phone, time_utc: timeUtc, topic, url, last_sent: null },
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' } }
    );
  } catch(e) { console.error('saveBriefing error:', e.message); }
}

async function scrapeUrl(url) {
  // Strategy 1: Try Tavily extract (best for JS-rendered pages like Luma)
  try {
    const extractRes = await axios.post('https://api.tavily.com/extract', {
      api_key: getTavilyKey(), // extract endpoint doesn't use tavilySearch helper
      urls: [url]
    });
    const results = extractRes.data.results || [];
    if (results.length && results[0].raw_content) {
      return results[0].raw_content.slice(0, 5000);
    }
  } catch(e) {
    console.log('Tavily extract failed, trying search fallback:', e.message);
  }

  // Strategy 2: Tavily search focused on the domain
  try {
    const domain = url.replace(/https?:\/\//, '').split('/')[0];
    const path = url.replace(/https?:\/\/[^\/]+/, '').replace(/[-_/]/g, ' ').trim();
    const data = await tavilySearch({
      query: `${path || domain} upcoming events dates 2025 2026`,
      search_depth: 'basic',
      max_results: 3
    });
    const results = data.results || [];
    if (results.length) {
      return results.map(r => `${r.title}\n${r.content}`).join('\n\n');
    }
  } catch(e) {
    console.error('scrapeUrl search fallback error:', e.message);
  }

  return null;
}

async function checkAndFireBriefings() {
  try {
    const now = new Date();
    const today = now.toISOString().slice(0, 10);

    // Fetch ALL pending briefings for today and check within a 5-minute window
    // This prevents missing briefings due to exact minute mismatch
    const res = await axios.get(`${SUPABASE_URL}/rest/v1/briefings?select=*`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    const allBriefings = res.data || [];

    const nowUTCMins = now.getUTCHours() * 60 + now.getUTCMinutes();
    const briefings = allBriefings.filter(b => {
      if (b.last_sent === today) return false;
      const [bH, bM] = (b.time_utc || '16:00').split(':').map(Number);
      const diff = nowUTCMins - (bH * 60 + bM);
      return diff >= 0 && diff <= 5;
    });

    console.log(`[HEARTBEAT] ${new Date().toISOString()} — ${allBriefings.length} total, ${briefings.length} due now`);

    for (const b of briefings) {
      if (b.last_sent === today) continue;
      try {
        let briefingMsg = null;
        const isLuma = b.url && (b.url.includes('lu.ma') || b.url.includes('luma.com'));

        if (isLuma && APIFY_TOKEN) {
          console.log('[HEARTBEAT] Using Apify for:', b.url);
          const events = await lumaScrap(b.url);
          const formatted = formatLumaEvents(events);
          if (formatted) {
            briefingMsg = `🌅 *${b.topic} Briefing:*\n\n${formatted}\n\n🔗 ${b.url.split('?')[0]}`;
          }
        }

        if (!briefingMsg) {
          const isEventsTopic = /events?|meetups?|conferences?/i.test(b.topic);
          const hasLoc = /vancouver|bc|toronto|montreal/i.test(b.topic);
          const locPin = hasLoc ? '' : ' Vancouver BC Canada';
          const query = isEventsTopic
            ? `upcoming ${b.topic} events${locPin} 2026`
            : `latest ${b.topic} news today`;
          const content = await webSearch(query);
          if (!content) continue;
          const key = getGroqKey();
          const prompt = isEventsTopic
            ? `You are Synbot. Daily briefing on "${b.topic}". ONLY include events in Vancouver/BC. Sort earliest to latest. Start with "🌅 *${b.topic} Briefing:*".\nFormat each event: [relevant emoji] *Name* / 🗓 Date / 📍 Location / one line. Use a unique emoji per event based on its topic (🤝 for networking, 🚀 for startups, 🤖 for robotics, 🎤 for talks, etc).\n\n${content}`
            : `You are Synbot. Short morning briefing on "${b.topic}". Start with "🌅 *${b.topic} Briefing:*"\n4-5 bullet points. ONLY use facts from the content below — do NOT add your own knowledge or make up outcomes.\n\n${content}`;
          const summaryRes = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
            model: 'llama-3.1-8b-instant',
            messages: [{ role: 'user', content: prompt }],
            max_tokens: 500
          }, { headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' } });
          briefingMsg = summaryRes.data.choices[0].message.content;
        }

        await sendWhatsApp(b.user_phone, briefingMsg);
        console.log('[HEARTBEAT] Sent briefing to:', b.user_phone);

        await axios.patch(`${SUPABASE_URL}/rest/v1/briefings?user_phone=eq.${b.user_phone}`,
          { last_sent: today },
          { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' } }
        );
      } catch(e) { console.error('fireBriefing error:', e.message); }
    }
  } catch(e) { console.error('checkBriefings error:', e.message); }
}
// ─────────────────────────────────────────────────────────────

async function lumaScrap(url) {
  if (!APIFY_TOKEN) { console.log('[LUMA] No APIFY_TOKEN set — skipping'); return null; }
  try {
    const cleanUrl = url.split('?')[0];
    // Extract the calendar slug from the URL e.g. lu.ma/vancouver-ai -> vancouver-ai
    const slug = cleanUrl.replace(/https?:\/\/(lu\.ma|luma\.com)\//, '').replace(/\/$/, '');
    console.log('[LUMA] Starting scrape for slug:', slug, 'url:', cleanUrl);

    // Use run-sync endpoint — waits and returns results directly, no polling needed
    const syncRes = await axios.post(
      `https://api.apify.com/v2/acts/mhamas~luma-calendar-events-scraper/run-sync-get-dataset-items?token=${APIFY_TOKEN}&timeout=240`,
      { slugs: [slug], maxEvents: 100 },
      { headers: { 'Content-Type': 'application/json' }, timeout: 250000 }
    );

    const events = syncRes.data || [];
    console.log('[LUMA] Apify returned', events.length, 'events');
    return events.length ? events : null;
  } catch(e) {
    console.error('[LUMA] Apify error:', e.response?.status, e.response?.data || e.message);
    return null;
  }
}

function getEventEmoji(name, desc) {
  const text = (name + ' ' + (desc || '')).toLowerCase();
  if (/health|medical|clinic|hospital|wellness|mental/.test(text)) return '🏥';
  if (/gaming|esport|game|play/.test(text)) return '🎮';
  if (/startup|founder|entrepreneur|pitch|venture|investor/.test(text)) return '🚀';
  if (/robot|robotics|vision|hardware/.test(text)) return '🤖';
  if (/sustain|green|climate|environment|energy/.test(text)) return '🌱';
  if (/retail|shop|commerce|ecommerce/.test(text)) return '🛍️';
  if (/supply chain|logistics|warehouse/.test(text)) return '📦';
  if (/data|analytics|database|ml|machine learning/.test(text)) return '📊';
  if (/security|cyber|hack|privacy/.test(text)) return '🔐';
  if (/ethics|governance|policy|regulation|responsible/.test(text)) return '⚖️';
  if (/art|creative|design|music|media/.test(text)) return '🎨';
  if (/finance|fintech|crypto|blockchain|invest/.test(text)) return '💰';
  if (/education|learn|student|school|university/.test(text)) return '🎓';
  if (/network|connect|social|community|meetup/.test(text)) return '🤝';
  if (/workshop|hack|build|demo|hands.on/.test(text)) return '🛠️';
  if (/summit|conference|keynote/.test(text)) return '🎤';
  return '✨'; // default — distinct from the 📅 used in headers
}

function formatLumaEvents(events) {
  if (!events || !events.length) return null;

  const now = new Date();
  const sorted = events
    .filter(e => e.name || e.title)
    .filter(e => {
      if (!e.timeUTC && !e.date) return true; // keep if no date info
      const d = new Date(e.timeUTC || e.date);
      return d >= now; // only future events
    })
    .sort((a, b) => new Date(a.timeUTC || a.date || 0) - new Date(b.timeUTC || b.date || 0));

  return sorted.map(e => {
    const name = e.name || e.title || 'Unnamed Event';
    const desc = (e.text || e.description || '').slice(0, 120).replace(/\n/g, ' ').trim();
    const icon = getEventEmoji(name, desc);
    let dateStr = 'Date TBA';
    if (e.timeUTC) {
      const d = new Date(e.timeUTC);
      dateStr = d.toLocaleDateString('en-US', {
        weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
        hour: '2-digit', minute: '2-digit', timeZone: 'America/Vancouver'
      }) + ' PT';
    } else if (e.date) {
      dateStr = e.date;
    }
    const location = e.city || e.location || e.venue || 'Location TBA';
    return `${icon} *${name}*\n🗓 ${dateStr}\n📍 ${location}${desc ? '\n' + desc : ''}`;
  }).join('\n\n');
}

async function webSearch(query) {
  console.log('[SEARCH] Query:', query);
  try {
    const data = await tavilySearch({
      query: query,
      search_depth: 'basic',
      max_results: 3,
      include_answer: true
    });
    if (data.answer) {
      console.log('[SEARCH] Got Tavily answer, length:', data.answer.length);
      return { answer: data.answer, raw: null };
    }
    const results = data.results || [];
    console.log('[SEARCH] No answer, got', results.length, 'results');
    if (!results.length) return null;
    const raw = results.map(r => (r.title + ': ' + r.content.slice(0, 400))).join('\n\n');
    return { answer: null, raw };
  } catch(e) {
    console.error('[SEARCH] Tavily error:', e.response?.status, e.message);
    return null;
  }
}

async function extractAndSaveMemory(phone, conversation) {
  try {
    const key = getGroqKey();
    const existing = await loadMemory(phone);
    const res = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
      model: 'llama-3.1-8b-instant',
      messages: [
        {
          role: 'system',
          content: `You extract important facts about a person from their conversation to remember for next time. 
Extract things like: name, projects they're working on, goals, preferences, job/role, location, important people in their life, recurring topics.
Current known facts: ${JSON.stringify(existing)}
Reply with ONLY a JSON object of updated facts. If nothing new to add, return the existing facts unchanged. No explanation, just JSON.`
        },
        { role: 'user', content: conversation }
      ],
      max_tokens: 200
    }, {
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }
    });
    const text = res.data.choices[0].message.content.trim();
    const clean = text.replace(/```json|```/g, '').trim();
    const newMemory = JSON.parse(clean);
    await saveMemory(phone, newMemory);
  } catch(e) {}
}

function memoryToContext(memory) {
  if (!memory || !Object.keys(memory).length) return '';
  const facts = Object.entries(memory).map(([k,v]) => `${k}: ${v}`).join(', ');
  return `What you know about this user: ${facts}.`;
}
function getGroqKey() {
  const key = GROQ_KEYS[groqKeyIndex % GROQ_KEYS.length];
  groqKeyIndex++;
  return key;
}

// Groq with auto-retry across keys on 429
async function callGroqWithRetry(messages, maxTokens=500) {
  for (let i = 0; i < GROQ_KEYS.length; i++) {
    try {
      const res = await axios.post('https://api.groq.com/openai/v1/chat/completions',
        { model: 'llama-3.1-8b-instant', messages, max_tokens: maxTokens },
        { headers: { Authorization: `Bearer ${getGroqKey()}`, 'Content-Type': 'application/json' } }
      );
      return res.data.choices[0].message.content;
    } catch(e) {
      if (e.response?.status === 429) { await new Promise(r => setTimeout(r, 1000)); continue; }
      throw e;
    }
  }
  throw new Error('All Groq keys rate limited');
}

async function sbPost(path, data) {
  return axios.post(`${SUPABASE_URL}/rest/v1/${path}`, data, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' }
  });
}

async function sbGet(path) {
  const res = await axios.get(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
  });
  return res.data;
}

async function getEmailByPhone(phone) {
  const data = await sbGet(`phone_links?user_phone=eq.${phone}`);
  return data[0]?.email || null;
}

async function generateTitle(text) {
  const key = getGroqKey();
  const res = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
    model: 'llama-3.1-8b-instant',
    messages: [
      { role: 'system', content: `Generate the most fitting title for this note. Rules:
- 2-4 words max
- Capture the core topic or action
- Capitalise each word
- Be specific and descriptive, not generic
- If it's a list → name what the list is about
- If it's a task → start with the action verb
- If it's information/research → name the topic
- If it's a person or meeting → include their name
Examples:
"basketball game tomorrow at 8pm with Jake" → "Basketball With Jake"
"call dentist tomorrow morning about checkup" → "Dentist Checkup Call"
"best AI tools for video editing in 2025" → "AI Video Tools"
"pick up groceries milk eggs bread" → "Grocery List"
"meeting with Sarah about the Synapses launch" → "Sarah Launch Meeting"
"the capital of France is Paris" → "Paris Capital Fact"
Reply with ONLY the title, nothing else.` },
      { role: 'user', content: text }
    ],
    max_tokens: 10
  }, { headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' } });
  return res.data.choices[0].message.content.trim();
}

async function saveNote(phone, text) {
  const email = phone.startsWith('web_') ? phone.replace('web_', '') : await getEmailByPhone(phone);
  const title = await generateTitle(text);
  await sbPost('notes', {
    user_phone: phone.startsWith('web_') ? null : phone,
    user_email: email,
    body: text,
    title: title
  });
}

async function getNotes(phone) {
  if (phone.startsWith('web_')) {
    const email = phone.replace('web_', '');
    console.log('[NOTES] web user, querying by email:', email);
    // Try email first
    const byEmail = await sbGet(`notes?user_email=eq.${encodeURIComponent(email)}&order=created_at.desc&limit=10`);
    console.log('[NOTES] by email result count:', byEmail.length);
    if (byEmail.length) return byEmail;
    // Fallback: try phone_links to get the real phone, then query by phone
    try {
      const linkRes = await sbGet(`phone_links?user_email=eq.${encodeURIComponent(email)}&limit=1`);
      if (linkRes.length) {
        const realPhone = linkRes[0].user_phone;
        console.log('[NOTES] fallback to phone:', realPhone);
        return await sbGet(`notes?user_phone=eq.${realPhone}&order=created_at.desc&limit=10`);
      }
    } catch(e) { console.log('[NOTES] fallback failed:', e.message); }
    return byEmail;
  }
  return await sbGet(`notes?user_phone=eq.${phone}&order=created_at.desc&limit=10`);
}

async function linkAccount(phone, email) {
  await sbPost('phone_links', { user_phone: phone, email: email.toLowerCase() });
  // Also update existing notes with this email
  await axios.patch(`${SUPABASE_URL}/rest/v1/notes?user_phone=eq.${phone}`, { user_email: email.toLowerCase() }, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' }
  });
}

const SYNAPSES_CONTEXT = `
ABOUT SYNAPSES: Synapses is an all-in-one AI platform built by EdIn (Vancouver, BC) for creators and builders. It is a single HTML file app hosted on the web.

FEATURES:
1. Home Base — command centre with sticky notes, recent chats, quick tools and daily overview
2. Synbot — AI assistant powered by Groq/Llama, with memory, web search via Tavily, and conversation history
3. Builder Feed — community feed where users post projects, ideas, and updates
4. Match & Connect — AI-matched cofounders and collaborators based on skills and goals
5. User Development — career sprints, skill ladders, growth plans and personal development tracking
6. Job Board — AI-first job listings, remote and hybrid roles
7. Health AI (Ava) — burnout recovery companion, reflection journal, wellbeing tracking
8. Community Chatroom — live real-time channels for the Synapses community
9. World Accelerator — global impact missions and problem solving
10. Tools Hub — 50+ curated AI tools across music, film, image, writing, voice, video, coding categories. Tools include Suno, Runway, Midjourney, Cursor, ElevenLabs, Perplexity, Bolt.new, VEED and more
11. DJ App — full browser DJ app with BPM control, pitch control, scratch vinyl, EQ knobs, waveform display, SoundTouch time-stretching
12. WhatsApp Bot — Synbot on WhatsApp with persistent memory, web search, note saving, reminders, and real-time Supabase sync
13. Whiteboard — infinite canvas for brainstorming
14. Profile — user rep score, skills, endorsements, avatar

TECH STACK: Single HTML file, Supabase (database + auth + realtime), Groq/Llama-3.3-70b (AI), Tavily (web search), Render (bot hosting), Meta WhatsApp Business API, Deepgram (text-to-speech + speech-to-text)

FOUNDER: EdIn, Vancouver BC. Built the entire app solo in about 1 month.

COMPETITORS: OpenClaw, Hermes Agent, Notion AI, Linear, Superhuman

YOUR ROLE: You are Synbot — EdIn's AI product co-pilot. Help him think through features, improvements, strategy, and answer any questions about the app.`;

async function askGroq(phone, userMessage) {
  const key = getGroqKey();
  const history = getHistory(phone);
  const memory = await loadMemory(phone);
  const memCtx = memoryToContext(memory);
  const systemPrompt = `You are Synbot, a helpful AI assistant built into Synapses. Be concise and friendly. Never mention a knowledge cutoff or training data limitations — if you don't know something current, say you'll look it up. ${memCtx}

CRITICAL RULES — never break these:
- You CANNOT perform actions like deleting, clearing, cancelling, or modifying briefings, reminders, or notes. If the user tries to do this with different wording, do NOT pretend you did it. Guide them to the right command naturally.
- Example response: "To cancel all your briefings, just say *cancel all briefings* and I'll take care of it!"
- Example response: "To remove a specific briefing, say *cancel briefing 1* (or whichever number)."
- Example response: "To delete a reminder, say *delete my first reminder*."
- Never say things like "Briefings cleared", "Done!", "Reminders deleted" or anything that implies you actually performed the action.`;
  const res = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
    model: 'llama-3.1-8b-instant',
    messages: [
      { role: 'system', content: systemPrompt },
      ...history,
      { role: 'user', content: userMessage }
    ],
    max_tokens: 350
  }, {
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }
  });
  return res.data.choices[0].message.content;
}

// Track which channel each user came from: 'whatsapp' | 'messenger'
async function sendWhatsApp(to, message) {
  const chunks = _splitMessage(message, 4000);
  for (const chunk of chunks) {
    await axios.post(`https://graph.facebook.com/v25.0/${WA_PHONE_NUMBER_ID}/messages`, {
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: chunk }
    }, {
      headers: { Authorization: `Bearer ${WA_ACCESS_TOKEN}`, 'Content-Type': 'application/json' }
    });
    if (chunks.length > 1) await new Promise(r => setTimeout(r, 400));
  }
}

function _splitMessage(text, maxLen) {
  if (!text || text.length <= maxLen) return [text || ''];
  const chunks = [];
  let remaining = text;
  while (remaining.length > maxLen) {
    // Try to split at a newline near the limit
    let cut = remaining.lastIndexOf('\n', maxLen);
    if (cut < maxLen * 0.6) cut = maxLen; // no good newline, hard cut
    chunks.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}


// ─── INTENT CLASSIFIER ──────────────────────────────────────────────────────
// Catches command-like messages that regex misses due to varied wording
async function classifyIntent(text) {
  try {
    const key = GROQ_KEYS[groqKeyIndex++ % GROQ_KEYS.length];
    if (!key) return null;
    const res = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
      model: 'llama-3.1-8b-instant',
      messages: [{
        role: 'user',
        content: `Classify this WhatsApp message into ONE of these intents, or "none" if it doesn't match any:

- cancel_all_briefings: user wants to delete/clear/remove/cancel/wipe all their briefings
- cancel_briefing_n: user wants to cancel a specific briefing by number (e.g. "cancel briefing 2")
- show_briefings: user wants to see their scheduled briefings list
- show_notes: user wants to see their saved notes
- show_reminders: user wants to see their reminders
- cancel_all_reminders: user wants to delete all reminders
- none: anything else (chat, questions, briefing requests, etc)

Message: "${text.replace(/"/g, "'")}"

Reply with ONLY the intent name, nothing else.`
      }],
      max_tokens: 20,
      temperature: 0
    }, { headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' } });
    return res.data.choices[0].message.content.trim().toLowerCase();
  } catch(e) { return null; }
}

// ─── POLYMARKET MULTI-AGENT TRADING SYSTEM ───────────────────────────────────
// Phase 1: Market Scanner + 5-Agent Debate + Kelly Sizing + Paper Trading
// Bankroll: $200 (adjust BANKROLL below)

const POLYMARKET_BANKROLL = 200; // your starting bankroll in USD
const POLYMARKET_MAX_BET = 40;   // max single bet = 20% of bankroll
const POLYMARKET_MIN_EDGE = 5;   // minimum edge % before betting
const PAPER_MODE = true;         // set false only when ready for real money

// Paper trading ledger (in-memory, resets on restart)
const paperLedger = { balance: POLYMARKET_BANKROLL, bets: [] };

// Agent performance tracking (learns over time which agents are most accurate)
const agentScores = { resolution: [], sentiment: [], baseRate: [], crowdPsych: [], devilsAdvocate: [] };

// ── MARKET SCANNER ────────────────────────────────────────────────────────────
async function scanPolymarkets() {
  try {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(0, 0, 0, 0);
    const tomorrowISO = tomorrow.toISOString();

    const res = await axios.get(
      `https://gamma-api.polymarket.com/markets?limit=100&active=true&closed=false&order=volume24hr&ascending=false&end_date_min=${tomorrowISO}`,
      { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 10000 }
    );

    const markets = (res.data || []).filter(m => {
      if (!m.endDate || new Date(m.endDate) <= tomorrow) return false;

      const vol = parseFloat(m.volume24hr || 0);
      if (vol < 1000) return false;

      try {
        const outcomes = JSON.parse(m.outcomes || '[]');
        if (outcomes.length > 2) return false;
      } catch(e) {}

      try {
        const prices = JSON.parse(m.outcomePrices || '[]');
        const yesPrice = parseFloat(prices[0]) * 100;
        if (yesPrice > 95 || yesPrice < 5) return false;

        m._yesPrice = yesPrice;
        m._noPrice = 100 - yesPrice;
        m._volume = vol;
        m._daysLeft = Math.ceil((new Date(m.endDate) - new Date()) / (1000 * 60 * 60 * 24));

        return m._daysLeft >= 2;
      } catch(e) { return false; }
    });

    markets.sort((a, b) => opportunityScore(b) - opportunityScore(a));

    return markets.slice(0, 8).map(m => ({
      id: m.id,
      title: m.question || m.title,
      yesPrice: m._yesPrice,
      noPrice: m._noPrice,
      volume: m._volume,
      volume24hr: m.volume24hr,
      daysLeft: m._daysLeft,
      endDate: m.endDate ? new Date(m.endDate).toLocaleDateString('en-US', {month:'short', day:'numeric', year:'numeric'}) : null,
      // Use groupSlug for event URL, fall back to slug, then market ID
      url: m.groupSlug
        ? `https://polymarket.com/event/${m.groupSlug}`
        : m.slug
          ? `https://polymarket.com/event/${m.slug}`
          : m.id
            ? `https://polymarket.com/market/${m.id}`
            : 'https://polymarket.com',
      description: m.description || ''
    }));
  } catch(e) {
    console.error('[POLYMARKET SCANNER] Error:', e.message);
    return null;
  }
}

function opportunityScore(m) {
  // Higher score = more interesting opportunity
  const priceScore = 100 - Math.abs(m._yesPrice - 50) * 2; // peaks at 50%
  const volumeScore = Math.min(Math.log10(m._volume) * 10, 50); // log scale
  const timeScore = m._daysLeft >= 7 && m._daysLeft <= 90 ? 30 : 10; // sweet spot
  return priceScore + volumeScore + timeScore;
}

// ── 7-DIMENSION MARKET DASHBOARD ─────────────────────────────────────────────
async function buildMarketDashboard(market, fullContext, vegasEdge = null) {
  // Each dimension scored -100 to +100 (positive = favors YES)
  const dashboard = {};

  // Dimension 1: Price signal — crowd confidence
  const priceFromCenter = market.yesPrice - 50;
  dashboard.priceSignal = {
    score: Math.round(priceFromCenter * 2),
    label: market.yesPrice > 65 ? 'CROWD_LEANS_YES' : market.yesPrice < 35 ? 'CROWD_LEANS_NO' : 'CONTESTED',
    raw: `YES: ${market.yesPrice.toFixed(1)}% | NO: ${market.noPrice.toFixed(1)}%`
  };

  // Dimension 2: Liquidity
  const vol = market.volume;
  dashboard.liquidity = {
    score: Math.min(Math.round(vol / 10000 * 100), 100),
    label: vol > 100000 ? 'HIGH' : vol > 10000 ? 'NORMAL' : 'LOW',
    raw: `$${Number(vol).toLocaleString()} 24hr volume`
  };

  // Dimension 3: Time pressure
  const days = market.daysLeft;
  dashboard.timePressure = {
    score: days < 3 ? 95 : days < 7 ? 80 : days < 30 ? 50 : days < 90 ? 30 : 10,
    label: days < 3 ? 'TODAY' : days < 7 ? 'IMMINENT' : days < 30 ? 'NEAR' : days < 90 ? 'MEDIUM' : 'DISTANT',
    raw: `${days} days to resolution`
  };

  // Dimension 4: Vegas vs Polymarket gap — real edge calculation
  const hasRealVegas = vegasEdge !== null;
  dashboard.vegasGap = {
    score: hasRealVegas ? Math.min(Math.max(vegasEdge * 3, -100), 100) : 0,
    label: hasRealVegas
      ? (Math.abs(vegasEdge) > 5 ? 'STRONG_EDGE' : Math.abs(vegasEdge) > 3 ? 'EDGE_EXISTS' : 'EFFICIENT')
      : 'NO_VEGAS_DATA',
    raw: hasRealVegas
      ? `${vegasEdge > 0 ? '+' : ''}${vegasEdge.toFixed(1)}% vs Polymarket`
      : 'No real-time odds available'
  };

  // Dimension 5: News momentum — count YES vs NO signals in headlines
  const contextLower = fullContext.toLowerCase();
  const yesWords = ['win', 'likely', 'expected', 'confirmed', 'approved', 'leads', 'ahead', 'favorite', 'strong'];
  const noWords = ['loss', 'unlikely', 'doubt', 'denied', 'rejected', 'trails', 'behind', 'underdog', 'weak', 'injury', 'out'];
  const yesSignals = yesWords.filter(w => contextLower.includes(w)).length;
  const noSignals = noWords.filter(w => contextLower.includes(w)).length;
  const momentumScore = Math.min(Math.max((yesSignals - noSignals) * 15, -100), 100);
  dashboard.newsMomentum = {
    score: momentumScore,
    label: momentumScore > 20 ? 'POSITIVE' : momentumScore < -20 ? 'NEGATIVE' : 'NEUTRAL',
    raw: `${yesSignals} positive signals, ${noSignals} negative signals in news`
  };

  // Dimension 6: Injury/risk factor (sports)
  const hasInjury = fullContext.includes('INJURY REPORTS') && contextLower.includes('injur');
  dashboard.riskFactor = {
    score: hasInjury ? -40 : 0,
    label: hasInjury ? 'INJURY_RISK' : 'CLEAN',
    raw: hasInjury ? 'Injury data found — check agent analysis' : 'No injury flags'
  };

  // Dimension 7: Market data richness
  const dataPoints = [hasRealVegas, fullContext.length > 500, fullContext.includes('POLYMARKET CONTEXT'), hasInjury].filter(Boolean).length;
  dashboard.dataRichness = {
    score: dataPoints * 25,
    label: dataPoints >= 3 ? 'RICH' : dataPoints >= 2 ? 'MODERATE' : 'SPARSE',
    raw: `${dataPoints}/4 data sources available`
  };

  return dashboard;
}

// ── 5-AGENT DEBATE SYSTEM ─────────────────────────────────────────────────────
async function runAgentDebate(market, newsContext, dashboard) {
  // Each agent gets its own key — prevents one key getting hammered by 5 parallel calls
  const key1 = GROQ_KEYS[groqKeyIndex++ % GROQ_KEYS.length];
  const key2 = GROQ_KEYS[groqKeyIndex++ % GROQ_KEYS.length];
  const key3 = GROQ_KEYS[groqKeyIndex++ % GROQ_KEYS.length];
  const key4 = GROQ_KEYS[groqKeyIndex++ % GROQ_KEYS.length];
  const key5 = GROQ_KEYS[groqKeyIndex++ % GROQ_KEYS.length];
  const vegasSummaryLine = dashboard.vegasGap.label !== 'NO_VEGAS_DATA'
    ? `\n- Vegas Data: ${dashboard.vegasGap.label} (${dashboard.vegasGap.raw})`
    : '';
  const marketSummary = `Market: "${market.title}"
YES Price: ${market.yesPrice.toFixed(1)}% | NO Price: ${market.noPrice.toFixed(1)}%
Volume 24hr: $${Number(market.volume).toLocaleString()}
Resolves: ${market.endDate} (${market.daysLeft} days)
Description: ${(market.description || '').slice(0, 200)}

DASHBOARD SIGNALS:
- News Momentum: ${dashboard.newsMomentum.label} (${dashboard.newsMomentum.raw})${vegasSummaryLine}
- Injury Risk: ${dashboard.riskFactor.label} (${dashboard.riskFactor.raw})
- Data Quality: ${dashboard.dataRichness.label} (${dashboard.dataRichness.raw})

FULL INTELLIGENCE CONTEXT:
${newsContext.slice(0, 1200)}`;

  // Run all 5 agents in parallel for speed
  const [resolutionVerdict, sentimentVerdict, baseRateVerdict, crowdPsychVerdict, devilVerdict] = await Promise.allSettled([

    // Agent 1: Resolution Criteria Agent
    axios.post('https://api.groq.com/openai/v1/chat/completions', {
      model: 'llama-3.1-8b-instant',
      messages: [{
        role: 'system',
        content: 'You are the Resolution Criteria Agent. Your ONLY job is to analyze the exact resolution criteria of prediction markets and identify how they will likely resolve. You are extremely literal and precise. You identify ambiguities, technicalities, and common misunderstandings. You output JSON only.'
      }, {
        role: 'user',
        content: `${marketSummary}\n\nYou are the RESOLUTION CRITERIA AGENT. Read the exact resolution criteria carefully. For sports: always give YES or NO — never UNCERTAIN. Check injury reports in the data. If Vegas/sportsbook odds appear in the data, use them as a strong signal. Output JSON: {"verdict": "YES"|"NO"|"UNCERTAIN", "confidence": 0-100, "reasoning": "2 sentences", "edge": "what the crowd misunderstands about resolution"}`
      }],
      max_tokens: 250,
      temperature: 0.3
    }, { headers: { Authorization: `Bearer ${key1}`, 'Content-Type': 'application/json' }, timeout: 15000 }),

    // Agent 2: Sentiment Agent
    axios.post('https://api.groq.com/openai/v1/chat/completions', {
      model: 'llama-3.1-8b-instant',
      messages: [{
        role: 'system',
        content: 'You are the Sentiment Agent. You analyze news sentiment and momentum specifically as it relates to prediction market resolution. You weight recent news more than older news. You distinguish between sentiment about the topic generally vs sentiment about the specific resolution criteria. Output JSON only.'
      }, {
        role: 'user',
        content: `${marketSummary}\n\nYou are the SENTIMENT AGENT. Read all news articles and expert analysis provided. Score the sentiment direction. If sportsbook odds appear in the data, compare them to the Polymarket price. Output JSON: {"verdict": "YES"|"NO"|"UNCERTAIN", "confidence": 0-100, "sentiment_score": -100 to 100, "momentum": "ACCELERATING_YES"|"ACCELERATING_NO"|"STABLE"|"MIXED", "reasoning": "2 sentences"}`
      }],
      max_tokens: 250,
      temperature: 0.3
    }, { headers: { Authorization: `Bearer ${key2}`, 'Content-Type': 'application/json' }, timeout: 15000 }),

    // Agent 3: Base Rate Agent
    axios.post('https://api.groq.com/openai/v1/chat/completions', {
      model: 'llama-3.1-8b-instant',
      messages: [{
        role: 'system',
        content: 'You are the Base Rate Agent. You think like a superforecaster. You ignore current news and focus purely on historical base rates — how often do events like this historically resolve YES? You use reference classes, outside view thinking, and Fermi estimation. Output JSON only.'
      }, {
        role: 'user',
        content: `${marketSummary}\n\nYou are the BASE RATE AGENT. Use the expert analysis and historical data provided. What is the historical frequency of this TYPE of event resolving YES? Use the injury reports and team stats if available. Output JSON: {"verdict": "YES"|"NO"|"UNCERTAIN", "confidence": 0-100, "base_rate_estimate": 0-100, "reference_class": "comparable events used", "reasoning": "2 sentences"}`
      }],
      max_tokens: 250,
      temperature: 0.3
    }, { headers: { Authorization: `Bearer ${key3}`, 'Content-Type': 'application/json' }, timeout: 15000 }),

    // Agent 4: Crowd Psychology Agent
    axios.post('https://api.groq.com/openai/v1/chat/completions', {
      model: 'llama-3.1-8b-instant',
      messages: [{
        role: 'system',
        content: 'You are the Crowd Psychology Agent. You identify systematic biases in prediction market crowds: recency bias, round number clustering, favorite-longshot bias, overreaction to news, narrative bias. You ask: is the crowd making a predictable mistake here? Output JSON only.'
      }, {
        role: 'user',
        content: `${marketSummary}\n\nYou are the CROWD PSYCHOLOGY AGENT. Identify what biases the Polymarket crowd is making. Check if the price makes sense given any sportsbook odds in the data. Common biases: recency bias, narrative bias, round number clustering at 50%, favorite-longshot bias. Output JSON: {"verdict": "YES"|"NO"|"UNCERTAIN", "confidence": 0-100, "bias_detected": "bias name or NONE", "crowd_mistake": "what crowd gets wrong", "reasoning": "2 sentences"}`
      }],
      max_tokens: 250,
      temperature: 0.3
    }, { headers: { Authorization: `Bearer ${key4}`, 'Content-Type': 'application/json' }, timeout: 15000 }),

    // Agent 5: Devil's Advocate
    axios.post('https://api.groq.com/openai/v1/chat/completions', {
      model: 'llama-3.1-8b-instant',
      messages: [{
        role: 'system',
        content: 'You are the Devil\'s Advocate Agent. Your ONLY job is to argue NO — always find reasons this will NOT happen. You counterbalance YES bias in the system. Output JSON only.'
      }, {
        role: 'user',
        content: `${marketSummary}\n\nMake the strongest possible case for NO. Output JSON: {"contrarian_verdict": "NO", "confidence": 0-100, "strongest_bear_case": "the most compelling reason YES will NOT happen", "tail_risk": "scenario that kills the YES case"}`
      }],
      max_tokens: 250,
      temperature: 0.5
    }, { headers: { Authorization: `Bearer ${key5}`, 'Content-Type': 'application/json' }, timeout: 15000 })
  ]);

  // Parse agent verdicts safely — extract JSON block even if surrounded by prose
  const parseAgent = (result, name) => {
    if (result.status === 'rejected') return { verdict: 'UNCERTAIN', confidence: 0, error: true };
    try {
      const content = result.value.data.choices[0].message.content;
      // Extract the first {...} block — handles prose before/after JSON
      const match = content.match(/\{[\s\S]*\}/);
      if (!match) throw new Error('No JSON block found');
      return JSON.parse(match[0]);
    } catch(e) {
      console.error(`[${name}] Parse error:`, e.message);
      return { verdict: 'UNCERTAIN', confidence: 0, error: true };
    }
  };

  const agents = {
    resolution: parseAgent(resolutionVerdict, 'RESOLUTION'),
    sentiment: parseAgent(sentimentVerdict, 'SENTIMENT'),
    baseRate: parseAgent(baseRateVerdict, 'BASERATE'),
    crowdPsych: parseAgent(crowdPsychVerdict, 'CROWDPSYCH'),
    devils: parseAgent(devilVerdict, 'DEVILS')
  };

  return agents;
}

// ── SYNTHESIZER + KELLY SIZING ────────────────────────────────────────────────
async function synthesizeAndSize(market, agents, dashboard, betAmount = null) {
  const groqKey = GROQ_KEYS[groqKeyIndex++ % GROQ_KEYS.length];

  const agentSummary = `
RESOLUTION AGENT: ${agents.resolution.verdict} (${agents.resolution.confidence}% confident) — ${agents.resolution.reasoning || ''} Edge: ${agents.resolution.edge || ''}
SENTIMENT AGENT: ${agents.sentiment.verdict} (${agents.sentiment.confidence}% confident) — Momentum: ${agents.sentiment.momentum || 'UNKNOWN'} — ${agents.sentiment.reasoning || ''}
BASE RATE AGENT: ${agents.baseRate.verdict} (${agents.baseRate.confidence}% confident) — Base rate: ${agents.baseRate.base_rate_estimate}% — ${agents.baseRate.reasoning || ''}
CROWD PSYCH AGENT: ${agents.crowdPsych.verdict} (${agents.crowdPsych.confidence}% confident) — Bias: ${agents.crowdPsych.bias_detected || 'NONE'} — ${agents.crowdPsych.crowd_mistake || ''}
DEVIL'S ADVOCATE: Contrarian ${agents.devils.contrarian_verdict} — ${agents.devils.strongest_bear_case || ''} Tail risk: ${agents.devils.tail_risk || ''}`;

  const synthRes = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
    model: 'llama-3.1-8b-instant',
    messages: [{
      role: 'system',
      content: `You are the Fund Manager synthesizer. You receive 5 agent reports and make the final trading decision. Rules: (1) If sportsbook/Vegas odds appear in the agent data with a gap > 3% vs Polymarket, that is your PRIMARY signal. (2) If 3+ agents agree on YES or NO, lean that direction. (3) UNCERTAIN votes = 0.5 each side. (4) Devil's Advocate always argues NO — weigh accordingly. (5) Min edge ${POLYMARKET_MIN_EDGE}% to bet. (6) Be equally willing to BET_YES or BET_NO. Bankroll: $${POLYMARKET_BANKROLL}. Max bet: $${POLYMARKET_MAX_BET}. Output JSON only.`
    }, {
      role: 'user',
      content: `Market: "${market.title}"
YES price: ${market.yesPrice.toFixed(1)}% | Days: ${market.daysLeft}
AGENTS: ${agentSummary}
Output ONLY this JSON (no explanation):
{"action":"BET_YES"|"BET_NO"|"PASS","your_probability":0-100,"edge":number,"bet_size":${betAmount || POLYMARKET_MAX_BET},"final_reasoning":"2-3 sentences: state the key signal (sportsbook gap if available / agent vote split / base rate / news momentum), explain WHY that leads to this bet direction, and what the crowd is getting wrong","warning":"one phrase or null"}`
    }],
    max_tokens: 600,
    temperature: 0.2
  }, { headers: { Authorization: `Bearer ${groqKey}`, 'Content-Type': 'application/json' }, timeout: 15000 });

  try {
    const content = synthRes.data.choices[0].message.content;
    // Extract the first {...} block — handles prose before/after JSON
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('No JSON block found');
    return JSON.parse(match[0]);
  } catch(e) {
    return { action: 'PASS', confidence: 0, final_reasoning: 'Synthesis failed', bet_size: 0 };
  }
}

// ── PAPER TRADE EXECUTOR ──────────────────────────────────────────────────────
function executePaperTrade(market, decision) {
  if (decision.action === 'PASS' || decision.bet_size <= 0) return null;
  const bet = {
    id: Date.now(),
    market: market.title,
    url: market.url,
    action: decision.action,
    size: Math.min(decision.bet_size, POLYMARKET_MAX_BET),
    price: decision.action === 'BET_YES' ? market.yesPrice : market.noPrice,
    timestamp: new Date().toISOString(),
    endDate: market.endDate,
    reasoning: decision.final_reasoning,
    status: 'OPEN'
  };
  paperLedger.balance -= bet.size;
  paperLedger.bets.push(bet);
  return bet;
}

// ── FULL POLYMARKET SCAN PIPELINE ─────────────────────────────────────────────
async function runPolymarketScan(from, specificMarket = null, returnMode = false, betAmount = null) {
  const collected = [];
  const deliver = async (msg) => {
    if (returnMode) { if (msg) collected.push(msg); }
    else await sendWhatsApp(from, msg);
  };
  await deliver('\uD83D\uDD0D *Polymarket Intelligence Scan starting...*\n\nScanning markets \u2192 Building intelligence dashboard \u2192 Running agents. Takes ~60 seconds.');

  // Step 1: Get markets
  const markets = await scanPolymarkets();
  if (!markets || !markets.length) {
    await deliver( '❌ Could not fetch Polymarket data. Try again.');
    return;
  }

  await deliver( `📊 Found ${markets.length} high-opportunity markets. Running intelligence on top 3...`);

  // Step 2: Analyze top 3 markets
  const top3 = specificMarket ? [specificMarket] : markets.slice(0, 3);
  const results = [];

  for (const market of top3) {
    try {
      // ── DATA LAYER: gather all intelligence before agents run ──────────────
      const isSports = /\bMLB\b|\bNBA\b|\bNFL\b|\bNHL\b|\bMLS\b|\bNCAAB\b|\bNCAAF\b|\bUFC\b|\bPGA\b|\bmoneyline\b|\bpoint spread\b|\bcover the spread\b|\bover\/under\b/i.test(market.title);

      // Fetch data sequentially to avoid Tavily rate limits
      // 1. Main news + expert analysis in one search
      let newsContext = 'No news available';
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          if (attempt > 0) await new Promise(r => setTimeout(r, 4000));
          else if (top3.indexOf(market) > 0) await new Promise(r => setTimeout(r, 3000)); // delay between markets
          const r = await tavilySearch({
            query: `${market.title} latest news prediction analysis 2026`,
            max_results: 3,
            search_depth: 'basic'
          });
          const articles = r.results || [];
          newsContext = articles.map(x => `[${x.title}]\n${x.content.slice(0, 400)}`).join('\n\n---\n\n');
          break;
        } catch(e) {
          console.error('[POLYMARKET] News fetch attempt', attempt+1, 'failed:', e.message);
        }
      }

      // 2. Sports-specific: odds + injuries in one search
      let vegasContext = '';
      let vegasEdge = null;
      let injuryContext = '';
      if (isSports) {
        // Detect futures/championship markets vs single-game markets
        const isFutures = /win the|championship|finals|title|season wins|make the playoffs|mvp|win.*award/i.test(market.title);

        // Try real Odds API first
        if (process.env.ODDS_API_KEY) {
          try {
            if (isFutures) {
              // Futures market — use outrights endpoint (championship winner odds)
              // Detect sport for correct endpoint
              const sportKey = /\bNBA\b/i.test(market.title) ? 'basketball_nba'
                : /\bNFL\b/i.test(market.title) ? 'americanfootball_nfl'
                : /\bMLB\b/i.test(market.title) ? 'baseball_mlb'
                : /\bNHL\b/i.test(market.title) ? 'icehockey_nhl'
                : null;
              if (sportKey) {
                const oddsRes = await axios.get(`https://api.the-odds-api.com/v4/sports/${sportKey}/odds`, {
                  params: { apiKey: process.env.ODDS_API_KEY, regions: 'us', markets: 'outrights', oddsFormat: 'decimal', bookmakers: 'draftkings,fanduel' },
                  timeout: 8000
                });
                const vData = oddsRes.data || [];
                const titleLower = market.title.toLowerCase();
                // Find the team in outright futures
                for (const event of vData) {
                  for (const bk of (event.bookmakers || [])) {
                    const outrights = bk.markets?.find(m => m.key === 'outrights');
                    if (!outrights) continue;
                    const teamOutcome = outrights.outcomes?.find(o => {
                      const teamWord = (o.name || '').toLowerCase().split(' ').pop();
                      return teamWord.length >= 5 && titleLower.includes(teamWord);
                    });
                    if (teamOutcome) {
                      const vegasProb = Math.round((1 / teamOutcome.price) * 100);
                      vegasEdge = vegasProb - market.yesPrice;
                      vegasContext = `\n\n🎰 VEGAS FUTURES: ${bk.title} has ${teamOutcome.name} at ${teamOutcome.price} (implied ${vegasProb}%)\nVegas implied YES: ${vegasProb}% | Polymarket YES: ${market.yesPrice.toFixed(1)}% | Gap: ${vegasEdge > 0 ? '+' : ''}${vegasEdge.toFixed(1)}%`;
                      break;
                    }
                  }
                  if (vegasEdge !== null) break;
                }
              }
            } else {
              // Single game market — use h2h moneyline
              const oddsRes = await axios.get('https://api.the-odds-api.com/v4/sports/upcoming/odds', {
                params: { apiKey: process.env.ODDS_API_KEY, regions: 'us', markets: 'h2h', oddsFormat: 'decimal', bookmakers: 'draftkings,fanduel' },
                timeout: 8000
              });
              const vData = oddsRes.data || [];
              const titleLower = market.title.toLowerCase();
              const matchingGame = vData.find(game => {
                const homeWord = (game.home_team || '').toLowerCase().split(' ').pop();
                const awayWord = (game.away_team || '').toLowerCase().split(' ').pop();
                return (homeWord.length >= 5 && titleLower.includes(homeWord)) ||
                       (awayWord.length >= 5 && titleLower.includes(awayWord));
              });
              if (matchingGame) {
                const h2h = matchingGame.bookmakers?.[0]?.markets?.find(m => m.key === 'h2h');
                if (h2h) {
                  const homeOdds = h2h.outcomes[0]?.price || 2;
                  const vegasProb = Math.round((1 / homeOdds) * 100);
                  vegasEdge = vegasProb - market.yesPrice;
                  vegasContext = `\n\n🎰 VEGAS ODDS: ${matchingGame.bookmakers?.slice(0,2).map(b => { const m = b.markets?.find(x=>x.key==='h2h'); return m ? b.title+': '+m.outcomes.map(o=>o.name+' '+o.price).join(' | ') : ''; }).filter(Boolean).join(' | ')}\nVegas implied YES: ${vegasProb}% | Polymarket YES: ${market.yesPrice.toFixed(1)}% | Gap: ${vegasEdge > 0 ? '+' : ''}${vegasEdge.toFixed(1)}%`;
                }
              }
            }
          } catch(e) { console.error('[ODDS API]', e.message); }
        }
        // Tavily for injuries + odds context
        try {
          await new Promise(r => setTimeout(r, 1500)); // wait between Tavily calls
          const injData2 = await tavilySearch({
            query: `${market.title} injury report odds betting line 2026`,
            max_results: 2,
            search_depth: 'basic'
          });
          const injData = injData2.results || [];
          injuryContext = '\n\n🏥 SPORTS INTEL:\n' + injData.map(x => x.title + ': ' + x.content.slice(0, 400)).join('\n');
        } catch(e) {}
      }

      // Combine all intelligence
      const fullContext = newsContext + vegasContext + injuryContext;

      // Build dashboard with real data
      const dashboard = await buildMarketDashboard(market, fullContext, vegasEdge);

      // Run 5-agent debate with full intelligence
      const agents = await runAgentDebate(market, fullContext, dashboard);

      // Synthesize + size
      const decision = await synthesizeAndSize(market, agents, dashboard, betAmount);

      results.push({ market, dashboard, agents, decision });

      // Execute paper trade if action is to bet
      const bet = executePaperTrade(market, decision);

      // Simple clear format — tell user exactly what to do
      const action = decision.action;
      const betSide = action === 'BET_YES' ? 'YES' : action === 'BET_NO' ? 'NO' : null;
      const agentYes = [agents.resolution.verdict, agents.sentiment.verdict, agents.baseRate.verdict, agents.crowdPsych.verdict].filter(v => v === 'YES').length;
      const agentNo = [agents.resolution.verdict, agents.sentiment.verdict, agents.baseRate.verdict, agents.crowdPsych.verdict].filter(v => v === 'NO').length;

      let msg = '';

      if (action === 'PASS') {
        // Skip — only show actual bets
      } else {
        const vegasLine = dashboard.vegasGap.raw !== 'No real-time odds available'
          ? `\nVegas gap: ${dashboard.vegasGap.raw} (${dashboard.vegasGap.label})`
          : '';
        const injuryFlag = dashboard.riskFactor.label === 'INJURY_RISK' ? '\n🏥 Injury risk detected' : '';
        msg = `🎯 *BET ${betSide} — ${market.title}*

📊 Market price: YES ${market.yesPrice.toFixed(1)}¢ | NO ${market.noPrice.toFixed(1)}¢
🧠 Bot thinks true odds: ${decision.your_probability}% — Edge: ${decision.edge > 0 ? '+' : ''}${decision.edge}%
💵 *Bet ${betAmount || decision.bet_size} on ${betSide}*
📅 Resolves: ${market.endDate} (${market.daysLeft} days away)${vegasLine}${injuryFlag}

*Why ${betSide}:* ${decision.final_reasoning || ''}
${decision.warning ? `\n⚠️ Risk: ${decision.warning}` : ''}

*Agents voted:* ${agentYes} YES | ${agentNo} NO | Devil's says NO
${bet ? `✅ *Paper trade logged — $${bet.size} on ${betSide}*` : ''}
🔗 ${market.url}`;
      }

      await deliver( msg);

    } catch(e) {
      console.error('[POLYMARKET ANALYSIS] Error for market:', market.title, e.message, e.stack?.split('\n')[1]);
      // Send error to WhatsApp so we can see what failed
      try {
        await deliver( `⚠️ Analysis failed for: ${market.title}\nError: ${e.message}`);
      } catch(_) {}
    }
  }

  // Summary
  const activeBets = paperLedger.bets.filter(b => b.status === 'OPEN');
  const betsPlaced = results.filter(r => r.decision.action !== 'PASS').length;
  await deliver( `✅ *Scan complete.*\n\n📋 ${markets.length} markets scanned\n🎯 ${betsPlaced} bets placed (paper)\n💰 Paper balance: $${paperLedger.balance.toFixed(2)}\n📌 Open positions: ${activeBets.length}\n\n${PAPER_MODE ? '🔒 _Paper trading mode — no real money at risk_' : '💸 _LIVE MODE — real money_'}\n\nSay *"polymarket portfolio"* to see open bets.`);
  if (returnMode) return collected.filter(Boolean).join('\n\n---\n\n');
}
// ─── POLYMARKET EXTRACTOR (kept for backwards compat) ────────────────────────
async function getPolymarketTopMarkets() {
  return await scanPolymarkets();
}

// ─── BROWSER AGENT (Browserbase + Playwright) ───────────────────────────────

async function runBrowserTask(instructions, url = null) {
  if (!BROWSERBASE_API_KEY || !BROWSERBASE_PROJECT_ID) return null;
  try {
    // 1. Create a Browserbase session
    const sessionRes = await axios.post('https://www.browserbase.com/v1/sessions', {
      projectId: BROWSERBASE_PROJECT_ID,
      browserSettings: {
        viewport: { width: 1280, height: 800 },
        fingerprint: { devices: ['desktop'], operatingSystems: ['windows'] }
      }
    }, { headers: { 'x-bb-api-key': BROWSERBASE_API_KEY, 'Content-Type': 'application/json' } });

    const sessionId = sessionRes.data.id;
    const wsUrl = sessionRes.data.connectUrl;
    console.log('[BROWSER] Session created:', sessionId);

    // 2. Connect Playwright to the session
    const { chromium } = require('playwright-core');
    const browser = await chromium.connectOverCDP(wsUrl);
    const context = browser.contexts()[0];
    const page = context.pages()[0] || await context.newPage();

    // 3. Navigate if URL provided
    await page.setExtraHTTPHeaders({ 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36' });
    if (url) {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      console.log('[BROWSER] Navigated to:', url);
    }

    // 4. Use LLM to figure out what actions to take based on instructions
    const groqKey = GROQ_KEYS[groqKeyIndex++ % GROQ_KEYS.length];
    const pageContent = await page.evaluate(() => document.body.innerText.slice(0, 3000));
    const pageTitle = await page.title();

    const actionRes = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
      model: 'llama-3.1-8b-instant',
      messages: [{
        role: 'user',
        content: `You are controlling a browser. Current page: "${pageTitle}"
Page content (first 3000 chars):
${pageContent}

User instruction: "${instructions}"

What is the key information from this page relevant to the user's request? Summarize concisely in 2-4 sentences. If the page doesn't have what they need, say so.`
      }],
      max_tokens: 300
    }, { headers: { Authorization: `Bearer ${groqKey}`, 'Content-Type': 'application/json' } });

    const summary = actionRes.data.choices[0].message.content;

    // 5. Close session
    await browser.close();
    await axios.delete(`https://www.browserbase.com/v1/sessions/${sessionId}`,
      { headers: { 'x-bb-api-key': BROWSERBASE_API_KEY } }
    ).catch(() => {});

    return { summary, pageTitle, url: page.url() };
  } catch(e) {
    console.error('[BROWSER] Error:', e.message);
    return null;
  }
}

// ─── REDDIT POST VIA SESSION COOKIE (username + password only, no app needed) ─
// Logs in via Reddit's internal API to get a session cookie, then submits post
let redditCookieCache = null;
let redditCookieExpiry = 0;
let redditModhash = null;

async function getRedditSession() {
  // Reuse cached session if still valid (24hr)
  if (redditCookieCache && redditModhash && Date.now() < redditCookieExpiry) {
    return { cookie: redditCookieCache, modhash: redditModhash };
  }

  const REDDIT_USERNAME = process.env.REDDIT_USERNAME;
  const REDDIT_PASSWORD = process.env.REDDIT_PASSWORD;
  if (!REDDIT_USERNAME || !REDDIT_PASSWORD) return null;

  try {
    const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

    // Step 1 — get a fresh modhash by loading reddit.com
    const homeRes = await axios.get('https://www.reddit.com/', {
      headers: { 'User-Agent': UA },
      withCredentials: true
    });
    // Extract modhash from page source
    const modhashMatch = homeRes.data.match(/"modhash"\s*:\s*"([^"]+)"/);
    const initialModhash = modhashMatch ? modhashMatch[1] : '';
    const homeCookies = (homeRes.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');

    // Step 2 — login
    const loginRes = await axios.post('https://www.reddit.com/api/login',
      new URLSearchParams({
        user: REDDIT_USERNAME,
        passwd: REDDIT_PASSWORD,
        api_type: 'json'
      }).toString(),
      {
        headers: {
          'User-Agent': UA,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Cookie': homeCookies,
          'X-Modhash': initialModhash
        }
      }
    );

    const loginData = loginRes.data?.json;
    console.log('[REDDIT LOGIN] Response:', JSON.stringify(loginData).slice(0, 200));

    if (loginData?.errors?.length) {
      console.error('[REDDIT LOGIN] Errors:', loginData.errors);
      return null;
    }

    // Get session cookies from login response
    const loginCookies = (loginRes.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');
    const allCookies = [homeCookies, loginCookies].filter(Boolean).join('; ');
    const modhash = loginData?.data?.modhash || initialModhash;

    // Step 3 — get proper session token from reddit.com with our login cookies
    const sessionRes = await axios.get('https://www.reddit.com/api/me.json', {
      headers: { 'User-Agent': UA, 'Cookie': allCookies }
    });
    const sessionCookies = (sessionRes.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');
    const finalCookie = [allCookies, sessionCookies].filter(Boolean).join('; ');
    const finalModhash = sessionRes.data?.data?.modhash || modhash;

    console.log('[REDDIT] Logged in as:', sessionRes.data?.data?.name);

    redditCookieCache = finalCookie;
    redditModhash = finalModhash;
    redditCookieExpiry = Date.now() + 20 * 60 * 60 * 1000; // 20 hours

    return { cookie: finalCookie, modhash: finalModhash };
  } catch(e) {
    console.error('[REDDIT SESSION] Error:', e.response?.data || e.message);
    return null;
  }
}

async function postToReddit(subreddit, title, body) {
  const REDDIT_USERNAME = process.env.REDDIT_USERNAME;
  const REDDIT_PASSWORD = process.env.REDDIT_PASSWORD;

  if (!REDDIT_USERNAME || !REDDIT_PASSWORD) {
    return { ok: false, error: 'Add REDDIT_USERNAME and REDDIT_PASSWORD to Render env vars.' };
  }

  const session = await getRedditSession();
  if (!session) return { ok: false, error: 'Could not log into Reddit. Check REDDIT_USERNAME and REDDIT_PASSWORD in Render env vars.' };

  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

  try {
    const res = await axios.post('https://www.reddit.com/api/submit',
      new URLSearchParams({
        sr: subreddit,
        kind: 'self',
        title: title,
        text: body || '',
        api_type: 'json',
        nsfw: 'false',
        spoiler: 'false',
        resubmit: 'true',
        uh: session.modhash
      }).toString(),
      {
        headers: {
          'User-Agent': UA,
          'Cookie': session.cookie,
          'X-Modhash': session.modhash,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Referer': `https://www.reddit.com/r/${subreddit}/submit`
        }
      }
    );

    const data = res.data;
    console.log('[REDDIT POST] Response:', JSON.stringify(data).slice(0, 400));

    const errors = data?.json?.errors;
    if (errors && errors.length) {
      const errMsg = errors.map(e => Array.isArray(e) ? e[1] || e[0] : String(e)).join(', ');
      return { ok: false, error: errMsg };
    }

    const postUrl = data?.json?.data?.url;
    if (postUrl) return { ok: true, url: postUrl };

    // If no URL but no errors either, it may have worked
    return { ok: true, url: `https://reddit.com/r/${subreddit}/new` };

  } catch(e) {
    console.error('[REDDIT POST] Error:', e.response?.data || e.message);
    // Session may be stale — clear it so next attempt re-authenticates
    redditCookieCache = null;
    redditModhash = null;
    return { ok: false, error: e.response?.data?.message || e.message };
  }
}

// ─── GOOGLE (GMAIL + CALENDAR) ───────────────────────────────────────────────

async function getGoogleAccessToken() {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REFRESH_TOKEN) return null;
  try {
    const res = await axios.post('https://oauth2.googleapis.com/token', {
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: GOOGLE_REFRESH_TOKEN,
      grant_type: 'refresh_token'
    });
    return res.data.access_token;
  } catch(e) {
    console.error('[GOOGLE] Token refresh failed:', e.response?.data || e.message);
    return null;
  }
}

async function gmailGetUnread(maxResults = 5) {
  const token = await getGoogleAccessToken();
  if (!token) return null;
  try {
    // Get unread message IDs
    const listRes = await axios.get('https://gmail.googleapis.com/gmail/v1/users/me/messages', {
      headers: { Authorization: `Bearer ${token}` },
      params: { q: 'is:unread', maxResults }
    });
    const messages = listRes.data.messages || [];
    if (!messages.length) return [];

    // Fetch each message's details
    const details = await Promise.all(messages.map(async m => {
      const msgRes = await axios.get(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}`, {
        headers: { Authorization: `Bearer ${token}` },
        params: { format: 'metadata', metadataHeaders: ['From', 'Subject', 'Date'] }
      });
      const headers = msgRes.data.payload.headers || [];
      const get = name => headers.find(h => h.name === name)?.value || '';
      return {
        from: get('From').replace(/<.*>/, '').trim() || get('From'),
        subject: get('Subject') || '(no subject)',
        date: get('Date'),
        snippet: msgRes.data.snippet || ''
      };
    }));
    return details;
  } catch(e) {
    console.error('[GMAIL] getUnread error:', e.response?.data || e.message);
    return null;
  }
}

async function gmailSearch(query, maxResults = 5) {
  const token = await getGoogleAccessToken();
  if (!token) return null;
  try {
    const listRes = await axios.get('https://gmail.googleapis.com/gmail/v1/users/me/messages', {
      headers: { Authorization: `Bearer ${token}` },
      params: { q: query, maxResults }
    });
    const messages = listRes.data.messages || [];
    if (!messages.length) return [];
    const details = await Promise.all(messages.map(async m => {
      const msgRes = await axios.get(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}`, {
        headers: { Authorization: `Bearer ${token}` },
        params: { format: 'metadata', metadataHeaders: ['From', 'Subject', 'Date'] }
      });
      const headers = msgRes.data.payload.headers || [];
      const get = name => headers.find(h => h.name === name)?.value || '';
      return {
        from: get('From').replace(/<.*>/, '').trim() || get('From'),
        subject: get('Subject') || '(no subject)',
        date: get('Date'),
        snippet: msgRes.data.snippet || ''
      };
    }));
    return details;
  } catch(e) {
    console.error('[GMAIL] search error:', e.response?.data || e.message);
    return null;
  }
}

async function gmailSend(to, subject, body) {
  const token = await getGoogleAccessToken();
  if (!token) return false;
  try {
    let fromHeader = null;
    try {
      const profileRes = await axios.get('https://gmail.googleapis.com/gmail/v1/users/me/profile', { headers: { Authorization: `Bearer ${token}` } });
      const email = profileRes.data.emailAddress || '';
      const name = profileRes.data.displayName || profileRes.data.name || '';
      fromHeader = email ? `From: ${name ? `${name} <${email}>` : email}` : null;
    } catch(e) {}
    const headerLines = [`To: ${to}`, fromHeader, `Subject: ${subject}`, 'Content-Type: text/plain; charset=utf-8'].filter(Boolean);
    const email = [...headerLines, '', body].join('\r\n');
    const encoded = Buffer.from(email).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    await axios.post('https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
      { raw: encoded },
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
    );
    return true;
  } catch(e) {
    console.error('[GMAIL] send error:', e.response?.data || e.message);
    return false;
  }
}

async function gmailTrash(messageId) {
  const token = await getGoogleAccessToken();
  if (!token) return false;
  try {
    await axios.post(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}/trash`,
      {},
      { headers: { Authorization: `Bearer ${token}` } }
    );
    return true;
  } catch(e) {
    console.error('[GMAIL] trash error:', e.response?.data || e.message);
    return false;
  }
}

// Get message IDs with subjects so we can match "delete first email" or "delete email from John"
async function gmailGetUnreadWithIds(maxResults = 5) {
  const token = await getGoogleAccessToken();
  if (!token) return null;
  try {
    const listRes = await axios.get('https://gmail.googleapis.com/gmail/v1/users/me/messages', {
      headers: { Authorization: `Bearer ${token}` },
      params: { q: 'is:unread', maxResults }
    });
    const messages = listRes.data.messages || [];
    if (!messages.length) return [];
    const details = await Promise.all(messages.map(async m => {
      const msgRes = await axios.get(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}`, {
        headers: { Authorization: `Bearer ${token}` },
        params: { format: 'metadata', metadataHeaders: ['From', 'Subject', 'Date'] }
      });
      const headers = msgRes.data.payload.headers || [];
      const get = name => headers.find(h => h.name === name)?.value || '';
      return {
        id: m.id,
        from: get('From').replace(/<.*>/, '').trim() || get('From'),
        subject: get('Subject') || '(no subject)',
        date: get('Date'),
        snippet: msgRes.data.snippet || ''
      };
    }));
    return details;
  } catch(e) {
    console.error('[GMAIL] getUnreadWithIds error:', e.response?.data || e.message);
    return null;
  }
}

async function gmailReply(messageId, to, subject, body, threadId) {
  const token = await getGoogleAccessToken();
  if (!token) return false;
  try {
    let fromHeader = null;
    try {
      const profileRes = await axios.get('https://gmail.googleapis.com/gmail/v1/users/me/profile', { headers: { Authorization: `Bearer ${token}` } });
      const email = profileRes.data.emailAddress || '';
      const name = profileRes.data.displayName || profileRes.data.name || '';
      fromHeader = email ? `From: ${name ? `${name} <${email}>` : email}` : null;
    } catch(e) {}
    const reSubject = subject.startsWith('Re:') ? subject : `Re: ${subject}`;
    const headerLines = [`To: ${to}`, fromHeader, `Subject: ${reSubject}`, `In-Reply-To: ${messageId}`, `References: ${messageId}`, 'Content-Type: text/plain; charset=utf-8'].filter(Boolean);
    const email = [...headerLines, '', body].join('\r\n');
    const encoded = Buffer.from(email).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    await axios.post('https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
      { raw: encoded, threadId },
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
    );
    return true;
  } catch(e) { console.error('[GMAIL] reply error:', e.response?.data || e.message); return false; }
}

async function gmailMarkRead(messageId) {
  const token = await getGoogleAccessToken();
  if (!token) return false;
  try {
    await axios.post(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}/modify`,
      { removeLabelIds: ['UNREAD'] },
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
    );
    return true;
  } catch(e) { console.error('[GMAIL] markRead error:', e.response?.data || e.message); return false; }
}

async function gmailArchive(messageId) {
  const token = await getGoogleAccessToken();
  if (!token) return false;
  try {
    await axios.post(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}/modify`,
      { removeLabelIds: ['INBOX'] },
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
    );
    return true;
  } catch(e) { console.error('[GMAIL] archive error:', e.response?.data || e.message); return false; }
}

async function gmailGetThread(threadId) {
  const token = await getGoogleAccessToken();
  if (!token) return null;
  try {
    const res = await axios.get(`https://gmail.googleapis.com/gmail/v1/users/me/threads/${threadId}`, {
      headers: { Authorization: `Bearer ${token}` },
      params: { format: 'metadata', metadataHeaders: ['From', 'Subject', 'Date'] }
    });
    return (res.data.messages || []).map(m => {
      const headers = m.payload?.headers || [];
      const get = n => headers.find(h => h.name === n)?.value || '';
      return { from: get('From').replace(/<.*>/, '').trim(), subject: get('Subject'), date: get('Date'), snippet: m.snippet || '' };
    });
  } catch(e) { console.error('[GMAIL] getThread error:', e.response?.data || e.message); return null; }
}

async function gmailGetFullEmail(messageId) {
  const token = await getGoogleAccessToken();
  if (!token) return null;
  try {
    const res = await axios.get(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}`, {
      headers: { Authorization: `Bearer ${token}` },
      params: { format: 'full' }
    });
    const headers = res.data.payload?.headers || [];
    const get = n => headers.find(h => h.name === n)?.value || '';
    let body = '';
    const parts = res.data.payload?.parts || [];
    const textPart = parts.find(p => p.mimeType === 'text/plain') || res.data.payload;
    if (textPart?.body?.data) body = Buffer.from(textPart.body.data, 'base64').toString('utf-8').slice(0, 500);
    return {
      id: res.data.id, threadId: res.data.threadId,
      from: get('From'), fromClean: get('From').replace(/<.*>/, '').trim(),
      fromEmail: (get('From').match(/<(.+)>/) || [])[1] || get('From'),
      subject: get('Subject') || '(no subject)', date: get('Date'),
      snippet: res.data.snippet || '', body
    };
  } catch(e) { console.error('[GMAIL] getFullEmail error:', e.response?.data || e.message); return null; }
}

async function gmailBatchSearch(query, maxResults = 500) {
  const token = await getGoogleAccessToken();
  if (!token) return null;
  try {
    let messages = [];
    let pageToken = null;
    do {
      const params = { q: query, maxResults: Math.min(500, maxResults - messages.length) };
      if (pageToken) params.pageToken = pageToken;
      const res = await axios.get('https://gmail.googleapis.com/gmail/v1/users/me/messages', {
        headers: { Authorization: `Bearer ${token}` }, params
      });
      messages = messages.concat(res.data.messages || []);
      pageToken = res.data.nextPageToken || null;
    } while (pageToken && messages.length < maxResults);
    return messages.map(m => m.id);
  } catch(e) { console.error('[GMAIL] batchSearch error:', e.response?.data || e.message); return null; }
}

async function gmailBatchTrash(ids) {
  const token = await getGoogleAccessToken();
  if (!token) return 0;
  // Trash in parallel batches of 10 to avoid rate limits
  let count = 0;
  const chunks = [];
  for (let i = 0; i < ids.length; i += 10) chunks.push(ids.slice(i, i + 10));
  for (const chunk of chunks) {
    await Promise.all(chunk.map(async id => {
      try {
        await axios.post(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}/trash`, {}, { headers: { Authorization: `Bearer ${token}` } });
        count++;
      } catch(e) {}
    }));
  }
  return count;
}

async function calendarGetEvents(days = 1) {
  const token = await getGoogleAccessToken();
  if (!token) return null;
  try {
    const now = new Date();
    const end = new Date(now);
    end.setDate(end.getDate() + days);
    const res = await axios.get('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
      headers: { Authorization: `Bearer ${token}` },
      params: {
        timeMin: now.toISOString(),
        timeMax: end.toISOString(),
        singleEvents: true,
        orderBy: 'startTime',
        maxResults: 10
      }
    });
    return (res.data.items || []).map(e => ({
      title: e.summary || '(no title)',
      start: e.start?.dateTime || e.start?.date,
      end: e.end?.dateTime || e.end?.date,
      location: e.location || null,
      description: (e.description || '').slice(0, 100)
    }));
  } catch(e) {
    console.error('[CALENDAR] getEvents error:', e.response?.data || e.message);
    return null;
  }
}

async function calendarCreateEvent(title, startISO, endISO, description = '') {
  const token = await getGoogleAccessToken();
  if (!token) return false;
  try {
    await axios.post('https://www.googleapis.com/calendar/v3/calendars/primary/events',
      { summary: title, start: { dateTime: startISO, timeZone: 'America/Vancouver' }, end: { dateTime: endISO, timeZone: 'America/Vancouver' }, description },
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
    );
    return true;
  } catch(e) {
    console.error('[CALENDAR] createEvent error:', e.response?.data || e.message);
    return false;
  }
}

function formatEmailList(emails) {
  if (!emails.length) return 'No unread emails! 🎉';
  return emails.map((e, i) => {
    const d = new Date(e.date);
    const dateStr = isNaN(d) ? e.date : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    return `📧 *${e.from}*\n📌 ${e.subject}\n🕐 ${dateStr}\n${e.snippet.slice(0, 80)}${e.snippet.length > 80 ? '...' : ''}`;
  }).join('\n\n');
}

function formatCalendarEvents(events, label = 'Today') {
  if (!events.length) return `Nothing on your calendar ${label.toLowerCase()}! 🗓`;
  return events.map(e => {
    const start = new Date(e.start);
    const timeStr = isNaN(start) ? e.start : start.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Vancouver' });
    return `📅 *${e.title}*\n🕐 ${timeStr}${e.location ? '\n📍 ' + e.location : ''}`;
  }).join('\n\n');
}


// scrapeXFeed removed — X blocks all data center IPs
// Seedance prompts use Tavily web search for trending AI video topics instead
async function scrapeXFeed() { return null; }


// ─── SEEDANCE PIPELINE (standalone, callable from /video-prompts endpoint) ───
async function runSeedancePipeline(collectedOut, userId) {
  const from = userId || 'web_frontend';
  const returnMode = Array.isArray(collectedOut);
  const collected = returnMode ? collectedOut : [];
  const deliver = async (msg) => {
    if (returnMode) { if (msg) collected.push(msg); }
    else await sendWhatsApp(from, msg);
  };

  try {
    await deliver( '🔍 Scanning r/aivideo, YouTube, and web for what\'s trending right now...');

    // ── SOURCE 1: Reddit r/aivideo hot posts (real upvote data) ──────────────
    let redditSignal = '';
    try {
      const rdRes = await axios.get('https://www.reddit.com/r/aivideo/hot.json?limit=25', {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36' },
        timeout: 8000
      });
      const posts = (rdRes.data?.data?.children || []).map(p => p.data);
      const topPosts = posts
        .filter(p => p.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 15)
        .map(p => `[${p.score} upvotes | ${p.num_comments} comments] ${p.title}`);
      redditSignal = 'R/AIVIDEO HOT RIGHT NOW:\n' + topPosts.join('\n');
      console.log('[SEEDANCE] Reddit r/aivideo:', topPosts.length, 'posts');
    } catch(e) { console.error('[SEEDANCE] Reddit fetch failed:', e.message); }

    // ── SOURCE 2: Reddit r/artificial for broader AI trends ──────────────────
    let redditAI = '';
    try {
      const rdRes2 = await axios.get('https://www.reddit.com/r/artificial/hot.json?limit=15', {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36' },
        timeout: 8000
      });
      const posts2 = (rdRes2.data?.data?.children || []).map(p => p.data);
      const topAI = posts2
        .filter(p => p.score > 100)
        .slice(0, 8)
        .map(p => `[${p.score} upvotes] ${p.title}`);
      if (topAI.length) redditAI = 'R/ARTIFICIAL TRENDING:\n' + topAI.join('\n');
    } catch(e) {}

    // ── SOURCE 3: YouTube Data API v3 — real trending AI videos ────────────
    let youtubeSignal = '';
    try {
      const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;
      if (YOUTUBE_API_KEY) {
        const ytSearchRes = await axios.get('https://www.googleapis.com/youtube/v3/search', {
          params: {
            part: 'snippet',
            q: 'AI generated video Seedance Kling Runway AI film 2026',
            type: 'video',
            order: 'viewCount',
            publishedAfter: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
            maxResults: 10,
            key: YOUTUBE_API_KEY
          },
          timeout: 8000
        });
        const ytVideos = ytSearchRes.data?.items || [];
        if (ytVideos.length > 0) {
          const videoIds = ytVideos.map(v => v.id?.videoId).filter(Boolean).join(',');
          const ytStatsRes = await axios.get('https://www.googleapis.com/youtube/v3/videos', {
            params: { part: 'statistics,snippet', id: videoIds, key: YOUTUBE_API_KEY },
            timeout: 8000
          });
          const ytWithStats = (ytStatsRes.data?.items || []).map(v => {
            const views = parseInt(v.statistics?.viewCount || 0).toLocaleString();
            const likes = parseInt(v.statistics?.likeCount || 0).toLocaleString();
            return `[${views} views | ${likes} likes] ${v.snippet?.title}`;
          });
          if (ytWithStats.length) {
            youtubeSignal = 'YOUTUBE TRENDING AI VIDEOS (last 7 days, real view counts):\n' + ytWithStats.join('\n');
            console.log('[SEEDANCE] YouTube:', ytWithStats.length, 'videos');
          }
        }
      }
    } catch(e) { console.error('[SEEDANCE] YouTube API failed:', e.message); }

    // ── SOURCE 4: TikTok/Instagram AI video trends via Tavily ────────────────
    let socialSignal = '';
    try {
      const socData = await tavilySearch({
        query: 'AI video TikTok viral trending May 2026 most views Seedance Kling Runway',
        max_results: 3,
        search_depth: 'basic'
      });
      const socHits = (socData?.results || []).map(x => `[${x.title}] ${x.content.slice(0, 250)}`).join('\n');
      if (socHits) socialSignal = 'TIKTOK/INSTAGRAM AI VIDEO TRENDS:\n' + socHits;
    } catch(e) { console.log('[SEEDANCE] Social signal unavailable (Tavily rate limited)'); }

    // ── SOURCE 5: Seedance-specific prompt techniques ────────────────────────
    await new Promise(r => setTimeout(r, 3000)); // wait 3s — Tavily per-second limit
    let seedanceTech = '';
    try {
      const stData = await tavilySearch({
        query: 'Seedance AI video best cinematic prompts techniques examples 2026',
        max_results: 2,
        search_depth: 'basic'
      });
      const stHits = (stData?.results || []).map(x => `[${x.title}] ${x.content.slice(0, 300)}`).join('\n');
      if (stHits) seedanceTech = 'SEEDANCE PROMPT TECHNIQUES:\n' + stHits;
    } catch(e) { console.log('[SEEDANCE] Technique signal unavailable (Tavily rate limited)'); }

    // ── Combine all signals ───────────────────────────────────────────────────
    const allSignals = [redditSignal, redditAI, youtubeSignal, socialSignal, seedanceTech].filter(Boolean);
    const trendContext = allSignals.join('\n\n════════════════════\n\n') ||
      'Current trends: hyper-realistic AI films, character-driven narratives, impossible physics, emotional storytelling dominating TikTok and Instagram Reels in 2026.';

    const sourcesUsed = [
      redditSignal ? 'r/aivideo' : null,
      redditAI ? 'r/artificial' : null,
      youtubeSignal ? 'YouTube' : null,
      socialSignal ? 'TikTok/Instagram' : null,
      seedanceTech ? 'Seedance techniques' : null
    ].filter(Boolean);

    await deliver( `📊 Got signals from: ${sourcesUsed.join(', ')}\n\n✍️ Writing professional-grade prompts...`);

    const groqKey3 = GROQ_KEYS[groqKeyIndex++ % GROQ_KEYS.length];

    // Truncate trend context to avoid hitting Groq's token limit
    const truncatedContext = trendContext.slice(0, 2000);

    const finalRes = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
      model: 'llama-3.1-8b-instant',
      messages: [{
        role: 'system',
        content: `You are a world-class AI film director and prompt engineer. You write Seedance AI video prompts at a cinematographer level. You know exactly what goes viral on TikTok for AI-generated content.`
      }, {
        role: 'user',
        content: `TRENDING AI VIDEO DATA:
${truncatedContext}

TASK: Generate 3 viral AI film prompts. For each:

🎬 [N]. [TITLE]

🧠 *Why it'll go viral:* [1-2 sentences]

🎥 *Seedance Prompt:* [4-5 sentences: opening frame, camera move, character details, lighting, color palette, atmosphere, emotional peak. Paste-ready into Seedance.]

🖼️ *ChatGPT Image Refs:*
- Ref 1a (character front): [full body, costume, studio grey bg, hyperrealistic 8K]
- Ref 1b (side profile): [same character, 90° left side, full body]
- Ref 1c (3/4 portrait): [same character, cinematic lighting, upper body]
- Ref 2 (key scene): [most dramatic frame, film still, anamorphic]
- Ref 3 (environment): [setting only, no characters, concept art]

📱 *Caption:* [Hook / Intrigue / CTA]

#️⃣ *Hashtags:* [15 hashtags]

---

Keep each prompt tight and specific. Real film references. No vague words.`
      }],
      max_tokens: 2000,
      temperature: 0.8
    }, { headers: { Authorization: `Bearer ${groqKey3}`, 'Content-Type': 'application/json' }, timeout: 45000 });

    console.log('[SEEDANCE] Groq response received, length:', finalRes.data.choices[0].message.content.length);

    const prompts = finalRes.data.choices[0].message.content;
    // Send as separate messages — full prompts blow past WhatsApp 4096 char limit
    await deliver( `🎬 *Professional Seedance Production Pack*
📡 Sources: ${sourcesUsed.join(", ")} — ${new Date().toLocaleDateString()}

💡 Say *"more prompts"* for 3 fresh ones.`);
    // Split on numbered sections (1., 2., 3.) or the film emoji — whichever works
    let toSend;
    const byEmoji = prompts.split(/(?=🎬|═══)/).filter(b => b.trim().length > 50);
    const byNumber = prompts.split(/(?=\n[123]\.)/).filter(b => b.trim().length > 50);
    if (byEmoji.length > 1) toSend = byEmoji;
    else if (byNumber.length > 1) toSend = byNumber;
    else {
      // last resort: split by character limit
      toSend = [];
      let remaining = prompts;
      while (remaining.length > 0) {
        toSend.push(remaining.slice(0, 3800));
        remaining = remaining.slice(3800);
      }
    }
    for (const block of toSend) {
      if (block.trim()) {
        await deliver( block.trim());
        await new Promise(r => setTimeout(r, 500));
      }
    }
    addToHistory(from, 'user', 'give me video prompts');
    addToHistory(from, 'assistant', prompts);
    } catch(e) {
      console.error('[SEEDANCE PIPELINE] Fatal error:', e.message);
      await deliver( '⚠️ Something went wrong generating prompts. Say "give me video prompts" to try again.');
    }

  if (returnMode) return collected.filter(Boolean).join('\n\n');
}

async function handleMessage(from, text) {
  const lower = text.toLowerCase().trim();
  // For web users (from = 'web_email@x.com'), query by email; for WhatsApp query by phone
  const isWeb = from.startsWith('web_');
  const webEmail = isWeb ? from.replace('web_', '') : null;
  const phoneFilter = isWeb
    ? `user_email=eq.${encodeURIComponent(webEmail)}`
    : `user_phone=eq.${from}`;

  // Link account
  if (lower.startsWith('link:')) {
    const email = text.replace(/^link:/i, '').trim();
    await linkAccount(from, email);
    return `✅ Linked! Your WhatsApp notes will now appear in Synapses when you log in with ${email}`;
  }

  // Reset memory
  if (lower === 'forget everything' || lower === 'reset memory' || lower === 'clear memory') {
    await saveMemory(from, {});
    conversationHistory[from] = [];
    return `🧹 Done — I've forgotten everything about you. Fresh start!`;
  }

  // Show notes
  if (lower === 'my notes' || lower === 'show notes' || lower === 'notes') {
    const notes = await getNotes(from);
    if (!notes.length) return "You have no saved notes yet.";
    return `📝 Your notes:\n\n` + notes.map((n, i) => `${i + 1}. ${n.body}`).join('\n');
  }

  // Cancel briefing
  if (/^(cancel|stop|remove|delete) (all )?briefing(s)?$/i.test(lower) || /^cancel briefing (\d+|first|second|third|last)$/i.test(lower) || /^(cancel|delete) all briefings?$/i.test(lower)) {
    try {
      const bRes = await axios.get(`${SUPABASE_URL}/rest/v1/briefings?${phoneFilter}&order=created_at.asc`,
        { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
      );
      const briefings = bRes.data || [];
      if (!briefings.length) return "You have no briefings set up.";

      // If only one briefing — just delete it
      if (briefings.length === 1) {
        await axios.delete(`${SUPABASE_URL}/rest/v1/briefings?id=eq.${briefings[0].id}`,
          { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
        );
        return `✅ Cancelled your *${briefings[0].topic}* briefing.`;
      }

      // If "cancel all briefings"
      if (/all/i.test(lower)) {
        await axios.delete(`${SUPABASE_URL}/rest/v1/briefings?${phoneFilter}`,
          { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
        );
        return `✅ All ${briefings.length} briefings cancelled.`;
      }

      // If they specified a number e.g. "cancel briefing 2"
      const numMatch = lower.match(/(\d+|first|second|third|last)$/i);
      const numWords = { first: 1, second: 2, third: 3, last: briefings.length };
      if (numMatch) {
        const raw = numMatch[1].toLowerCase();
        const idx = (numWords[raw] ?? parseInt(raw)) - 1;
        const target = briefings[idx];
        if (!target) return `I don't have a briefing #${idx + 1}. Say "show my briefings" to see your list.`;
        await axios.delete(`${SUPABASE_URL}/rest/v1/briefings?id=eq.${target.id}`,
          { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
        );
        return `✅ Cancelled your *${target.topic}* briefing.`;
      }

      // Multiple briefings and no number specified — ask which one
      const list = briefings.map((b, i) => `${i + 1}. *${b.topic}*`).join('\n');
      return `You have ${briefings.length} briefings — which one would you like to cancel?\n\n${list}\n\nSay *"cancel briefing 1"* or *"cancel all briefings"*.`;

    } catch(e) {
      console.error('cancel briefing error:', e.message);
      return "Couldn't cancel your briefing right now.";
    }
  }

  // Help
  if (lower === 'help') {
    return `👋 Hi! I'm Synbot. Here's what I can do:\n\n• link: your@email.com — connect to Synapses\n• my notes — see your notes\n• Or just chat or tell me something to remember!`;
  }

  // Step 1: classify ONLY for save_note and reminder — runs in parallel with search
  const isSynapsesMsg = (() => {
    const l = lower.replace(/\s+/g, '');
    const kws = ['synapses', 'synbot', 'ourapp', 'theapp', 'djapp', 'healthai', 'toolshub', 'builderfeed', 'worldaccelerator', 'homebase', 'jobboard', 'whiteboard'];
    return kws.some(k => l.includes(k));
  })();

  const isReminder = ['remind me', 'set a reminder', 'set reminder', 'alert me', 'notify me', 'reminder at', 'reminder for', 'remindme'].some(k => lower.includes(k));

// Store last briefing events per user for "show more" pagination
const lastBriefingEvents = {}; // phone -> { events, shown }

  // Briefing detection — simple and reliable
  // Only match 'brief' as a command verb — not as a noun e.g. 'how does this briefing relate to...'
  const hasBriefWord = /^brief\b|^(hey |ok |can you |please )?brief me\b/i.test(lower);
  const hasTime = /\d{1,2}\s*(am|pm)|\d{1,2}:\d{2}|every\s+\d{1,2}\s*(am|pm)|daily at\s+\d/i.test(text); // has a specific time like "9am", "every 10am", "daily at 8am"
  const hasNow = /right now|now$|now\s/.test(lower) || lower === 'brief me now' || lower === 'briefing now';
  const isImmediateBriefing = hasBriefWord && (hasNow || !hasTime); // immediate if "now" OR no time specified
  const isBriefing = hasBriefWord && hasTime && !hasNow; // only schedule if time is explicitly given

  // "show more" / "tell me more" / natural follow-up on last topic
  const isShowMore = /^(show more|more events|next events|load more)/i.test(lower.trim());
  const isFollowUp = /^(tell me more|go deeper|more on that|what else|interesting|what about|explain|elaborate|more detail|continue|and\?|so\?|really\?|wow|what do experts|why is that|how does that|what does that mean|fascinating)/i.test(lower.trim())
    || (lower.length < 60 && /more|deeper|else|about it|on that|explain|why|how|what|who/i.test(lower) && lastResearchTopic[from]);

  if ((isShowMore || isFollowUp) && lastResearchTopic[from] && !lastBriefingEvents[from]) {
    // Natural conversation about the last researched topic
    const { topic, summary, content } = lastResearchTopic[from];
    const groqKeyF = GROQ_KEYS[groqKeyIndex++ % GROQ_KEYS.length];

    // Do a fresh Tavily search to get more depth
    let extraContent = '';
    try {
      const tData = await tavilySearch({
        query: `${topic} ${text} detailed explanation 2026`,
        max_results: 2,
        search_depth: 'basic'
      });
      extraContent = (tData?.results || []).map(r => r.content).join('\n').slice(0, 2000);
    } catch(e) {}

    const followUpRes = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
      model: 'llama-3.1-8b-instant',
      messages: [{
        role: 'system',
        content: `You are Synbot, a smart conversational assistant. The user just got a briefing on "${topic}" and wants to continue the conversation naturally. Be conversational, insightful, and engaging — like a knowledgeable friend, not a search engine. No bullet points unless it really helps. Keep it to 3-5 sentences unless they ask for more.`
      }, {
        role: 'user',
        content: `Previous briefing on "${topic}": ${summary}\n\nExtra research: ${extraContent}\n\nUser says: "${text}"\n\nRespond naturally and conversationally.`
      }],
      max_tokens: 500,
      temperature: 0.8
    }, { headers: { Authorization: `Bearer ${groqKeyF}`, 'Content-Type': 'application/json' } });

    const reply = followUpRes.data.choices[0].message.content;
    addToHistory(from, 'user', text);
    addToHistory(from, 'assistant', reply);
    return reply;
  }
  if (isShowMore) {
    // If RAM cache is gone (server restarted), re-fetch from Apify
    if (!lastBriefingEvents[from]) {
      try {
        const bRes = await axios.get(`${SUPABASE_URL}/rest/v1/briefings?${phoneFilter}&limit=1`,
          { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
        );
        const b = bRes.data?.[0];
        if (b?.url && APIFY_TOKEN) {
          const events = await lumaScrap(b.url);
          if (events?.length) {
            const now2 = new Date();
            const filteredEvents = events
              .filter(e => e.name || e.title)
              .filter(e => { if (!e.timeUTC && !e.date) return true; return new Date(e.timeUTC || e.date) >= now2; })
              .sort((a, b) => new Date(a.timeUTC || a.date || 0) - new Date(b.timeUTC || b.date || 0));
            // Start from 10 since user already saw the first 10 from the briefing
            lastBriefingEvents[from] = { events: filteredEvents, shown: 10, topic: b.topic, url: b.url };
          }
        }
      } catch(e) { console.error('[SHOW MORE] re-fetch error:', e.message); }
    }

    if (!lastBriefingEvents[from]) return "I don't have any briefing events loaded. Say \"brief me now\" first.";

    const { events, shown, topic, url } = lastBriefingEvents[from];
    const nextBatch = events.slice(shown, shown + 10);
    if (!nextBatch.length) return `That's all the events! 🔗 ${url || ''}`;
    lastBriefingEvents[from].shown += nextBatch.length;
    const formatted = formatLumaEvents(nextBatch);
    const remaining = events.length - lastBriefingEvents[from].shown;
    const footer = remaining > 0 ? `\n\n_(${remaining} more — say "show more events")_` : `\n\n_(That's all the events!)_`;
    const lumaLink = url ? `\n🔗 ${url.split('?')[0]}` : '';
    return `🗂️ *More ${topic} Events:*\n\n${formatted}${footer}${lumaLink}`;
  }



  // ─── DOORDASH ORDER INTENT ──────────────────────────────────────────────────
  const isDoorDash = /order|doordash|door dash|deliver(y|me)|get me|i want/i.test(lower) &&
    /from|on doordash|delivered/i.test(lower);

  // "What did Alex say" / "show me the call with Alex" — pulls the actual
  // saved transcript from call_logs, not just whatever the push summary said.
  const callLookupMatch = lower.match(/^(what did|show me|read me|pull up)\s+(?:the\s+)?(?:call\s+with\s+|the\s+call\s+with\s+)?([a-z]+)('s)?\s*(call|say|said|transcript)?/i);
  if (callLookupMatch && /call|say|said|transcript/i.test(lower)) {
    const name = callLookupMatch[2];
    try {
      const res = await axios.get(
        `${SUPABASE_URL}/rest/v1/call_logs?user_phone=eq.${encodeURIComponent(from)}&contact_name=ilike.${encodeURIComponent(name)}&order=created_at.desc&limit=1`,
        { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
      );
      const log = (res.data || [])[0];
      if (!log) return `I don't have a saved call with ${name}.`;
      if (!log.transcript) return `📞 Call with ${name} — summary: ${log.summary || 'no summary available'}\n\n(No full transcript was saved for this one.)`;
      return `📞 Full transcript with ${name}:\n\n${log.transcript}`;
    } catch(e) {
      console.error('[CALL LOOKUP]', e.response?.data || e.message);
      return `Couldn't pull that up right now.`;
    }
  }

  // Handle pending call-request confirmation (user supplying the contact's number)
  if (pendingCallRequests[from]) {
    const { contactName, objective } = pendingCallRequests[from];
    const numMatch = text.match(/(\+?1?[\s.-]?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4})/);
    if (numMatch) {
      delete pendingCallRequests[from];
      let digits = numMatch[1].replace(/[^\d+]/g, '');
      if (!digits.startsWith('+')) digits = '+' + (digits.length === 10 ? '1' + digits : digits);
      setTimeout(async () => {
        try {
          await placeDelegatedCall(from, digits, contactName, objective);
        } catch(e) {
          console.error('[DELEGATED CALL]', e.response?.data || e.message);
          await sendWhatsApp(from, `❌ Couldn't place that call: ${e.message}`);
          await logFailedDelegatedCall(from, contactName, objective, e.message);
        }
      }, 0);
      return `📞 On it — calling ${contactName || 'them'} now about: "${objective}". I'll let you know how it goes.`;
    } else if (/^(no|nope|cancel|forget|stop)/i.test(lower)) {
      delete pendingCallRequests[from];
      return `👍 Cancelled.`;
    }
    // Anything else while pending: fall through to normal handling (don't force them to answer)
  }

  // Detect a new delegated call request — cheap regex pre-filter before spending
  // a Groq call on parsing, since most messages aren't call requests at all.
  const looksLikeCallRequest = /\bcall\b/i.test(lower) &&
    !/^call me\b/i.test(lower) && // "call me" is a different feature (scheduled self-calls), not a delegated call
    /\b(and|to)\b.*\b(tell|ask|let|talk|say|discuss|see if|find out|check if|remind)\b/i.test(lower);

  if (looksLikeCallRequest) {
    const parsed = await parseCallRequest(text);
    if (parsed) {
      if (parsed.contactPhone) {
        let digits = parsed.contactPhone.replace(/[^\d+]/g, '');
        if (!digits.startsWith('+')) digits = '+' + (digits.length === 10 ? '1' + digits : digits);
        setTimeout(async () => {
          try {
            await placeDelegatedCall(from, digits, parsed.contactName, parsed.objective);
          } catch(e) {
            console.error('[DELEGATED CALL]', e.response?.data || e.message);
            await sendWhatsApp(from, `❌ Couldn't place that call: ${e.message}`);
            await logFailedDelegatedCall(from, parsed.contactName, parsed.objective, e.message);
          }
        }, 0);
        return `📞 On it — calling ${parsed.contactName || digits} now about: "${parsed.objective}". I'll let you know how it goes.`;
      } else {
        pendingCallRequests[from] = { contactName: parsed.contactName, objective: parsed.objective };
        return `📞 Got it — what's ${parsed.contactName || 'their'} number?`;
      }
    }
  }

  // Handle pending order confirmation (yes/no)
  if (pendingOrders[from]) {
    const { restaurant, item } = pendingOrders[from];
    if (/^(yes|yeah|yep|ok|sure|do it|confirm|go|checkout)/i.test(lower)) {
      delete pendingOrders[from];
      if (!hasBrowserExtension(from)) {
        return `🔌 Chrome extension isn't connected — open Chrome and make sure Synbot Browser Agent is running.`;
      }
      setTimeout(async () => {
        try {
          await sendWhatsApp(from, `🛒 Adding ${item} from ${restaurant} to your cart...`);
          const result = await runDoorDashOrder(from, restaurant, item);
          if (result && result.ok) {
            await sendWhatsApp(from, `✅ *${item}* added to cart from *${restaurant}*!\n\n👀 Check your Chrome — review the order and confirm payment when ready.`);
          } else {
            await sendWhatsApp(from, `❌ Something went wrong placing the order. Try opening DoorDash in Chrome manually.`);
          }
        } catch(e) {
          console.error('[DOORDASH]', e.message);
          await sendWhatsApp(from, `❌ Couldn't complete order: ${e.message}`);
        }
      }, 0);
      return null;
    } else if (/^(no|nope|cancel|stop|forget)/i.test(lower)) {
      delete pendingOrders[from];
      return `👍 Order cancelled.`;
    }
  }

  if (isDoorDash && !hasBriefWord) {
    // Parse restaurant and item from the message using Groq
    try {
      const key = getGroqKey();
      const parseRes = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
        model: 'llama-3.1-8b-instant',
        messages: [{
          role: 'system',
          content: `Extract the restaurant name and food item from a DoorDash order request. Reply ONLY with JSON like: {"restaurant":"mcdonalds","item":"Big Mac"}\nIf you can't find both, reply: {"error":"unclear"}`
        }, { role: 'user', content: text }],
        max_tokens: 60, temperature: 0.1
      }, { headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' } });
      const raw = parseRes.data.choices[0].message.content.trim().replace(/```json|```/g, '').trim();
      const parsed = JSON.parse(raw);
      if (parsed.restaurant && parsed.item) {
        if (!hasBrowserExtension(from)) {
          return `🔌 Your Chrome extension isn't connected. Open Chrome and make sure Synbot Browser Agent is running, then try again.`;
        }
        pendingOrders[from] = { restaurant: parsed.restaurant, item: parsed.item };
        return `🍔 Got it! Order *${parsed.item}* from *${parsed.restaurant}* on DoorDash?\n\nReply *yes* to confirm or *no* to cancel.`;
      }
    } catch(e) { console.error('[DOORDASH PARSE]', e.message); }
  }

  // SEEDANCE PROFESSIONAL CREATIVE DIRECTOR
  const isSeedancePrompt = /seedance|ai video prompt|give me.*video|show me video|film prompt|video prompts?|viral video idea|tiktok idea|reel idea|video idea|generate prompt|ai film|more prompts?/i.test(lower) && !hasBriefWord;

  if (isSeedancePrompt) {
    setTimeout(async () => {
      try { await runSeedancePipeline(null, from); } catch(e) { console.error('[SEEDANCE]', e.message); }
    }, 0);
    return null;
  }

    // ─── POLYMARKET INTENT ───────────────────────────────────────────────────────
  const isPolymarket = /polymarket|prediction market|top (bets|markets)|what.*bet|who.*win.*market|scan.*market|best.*bet/i.test(lower) && !lower.includes('go to');
  const isPolymarketPortfolio = /polymarket portfolio|my bets|open bets|paper.*trade|trading.*balance/i.test(lower);

  if (isPolymarketPortfolio) {
    const bets = paperLedger.bets;
    if (!bets.length) return `📋 *Polymarket Portfolio*\n\nNo bets placed yet.\nSay *"scan polymarket"* to find opportunities.\n\n💰 Balance: $${paperLedger.balance.toFixed(2)}`;
    const betList = bets.map((b, i) => `${i+1}. *${b.action === 'BET_YES' ? '✅ YES' : '❌ NO'}* — ${b.market.slice(0, 50)}\n   $${b.size} @ ${b.price.toFixed(1)}% | Resolves: ${b.endDate} | ${b.status}`).join('\n\n');
    return `📋 *Polymarket Portfolio (Paper)*\n\n${betList}\n\n💰 Remaining balance: $${paperLedger.balance.toFixed(2)}\n📌 Open positions: ${bets.filter(b => b.status === 'OPEN').length}`;
  }

  if (isPolymarket) {
    // Run full pipeline in background — takes ~60 seconds
    setTimeout(async () => {
      await runPolymarketScan(from);
    }, 0);
    return null;
  }

  // ─── REDDIT HOTTEST POST INTENT ─────────────────────────────────────────────
  // Detect Reddit browse intent with category + optional subreddit + optional limit
  // ─── REDDIT POST INTENT ─────────────────────────────────────────────────────
  const cleanedLower = lower.trim().replace(/^[*_~]+|[*_~]+$/g, '').trim();
  // If we're waiting for title+body after showing rules, treat next message as the post
  const isPendingRedditPost = !!pendingRedditPost[from];
  if (isPendingRedditPost && !lower.match(/^(cancel|stop|never mind|forget it)/i)) {
    const { subreddit } = pendingRedditPost[from];
    // Parse title+body from whatever format they send
    let title, body;
    const titleMatch = text.match(/title\s*[:–—-]+\s*([^\n]+?)(?:\s*[-–—|]\s*body|\n|$)/i);
    const bodyMatch = text.match(/body\s*[:–—-]+\s*([\s\S]+)$/i);
    if (titleMatch) {
      title = titleMatch[1].trim();
      body = bodyMatch ? bodyMatch[1].trim() : '';
    } else {
      // No keywords — treat first line as title, rest as body
      const lines = text.trim().split('\n');
      title = lines[0].trim();
      body = lines.slice(1).join('\n').trim();
      if (!body) body = '';
    }
    if (!title) return "What's the title for your post?";
    delete pendingRedditPost[from];
    const pendingReply = `📝 Posting to r/${subreddit}...\n\n*Title:* ${title}${body ? '\n*Body:* ' + body.slice(0, 100) + (body.length > 100 ? '...' : '') : ''}`;
    addToHistory(from, 'assistant', pendingReply);
    const result = await postToReddit(subreddit, title, body);
    const finalReply = result.ok
      ? `✅ Posted to r/${subreddit}!\n\n🔗 ${result.url}`
      : `❌ Post failed: ${result.error}`;
    addToHistory(from, 'assistant', finalReply);
    return finalReply;
  }

  const isRedditPost = !isReminder && /^post (on|to|in) r\/|^post on reddit|^submit (to|on) r\/|^(make|create) (a )?post (on|in) r\//i.test(cleanedLower) && lower.includes('r/');

  if (isRedditPost) {
    const subMatch = lower.match(/r\/(\w+)/i);
    const subreddit = subMatch ? subMatch[1] : null;
    if (!subreddit) return "Which subreddit? Say: *post on r/subredditname*";

    const titleMatch = text.match(/title\s*[:–—-]+\s*([^\n]+?)(?:\s*[-–—|]\s*body|\n|$)/i);
    const bodyMatch = text.match(/body\s*[:–—-]+\s*([\s\S]+)$/i);

    // Step 1 — if no title yet, read subreddit rules first then guide the user
    if (!titleMatch) {
      try {
        // Fetch rules via Reddit JSON API
        const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
        // Fetch rules via Tavily search (faster than browser harness)
        const rulesData = await tavilySearch({
          query: `r/${subreddit} subreddit rules posting requirements flair`,
          max_results: 3,
          search_depth: 'basic',
          include_domains: ['reddit.com', 'reddithelp.com']
        }).catch(() => null);
        const rules = rulesData
          ? (rulesData?.results || []).map(r => r.content?.slice(0, 300)).join(' | ')
          : 'Could not fetch rules';

        // Flair list via Reddit JSON
        const flairRes = await axios.get(`https://www.reddit.com/r/${subreddit}/api/link_flair_v2.json`, { headers: { 'User-Agent': UA } }).catch(() => null);
        const flairData = flairRes?.data;
        const flairs = Array.isArray(flairData) ? flairData.map(f => f.text || f.richtext?.[0]?.t).filter(Boolean).join(', ') : null;
        const requiresFlair = false;
        const postTypes = 'any';

        // Use LLM to summarize the rules into plain posting guidance
        const groqKey = GROQ_KEYS[groqKeyIndex++ % GROQ_KEYS.length];
        const guidanceRes = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
          model: 'llama-3.1-8b-instant',
          messages: [{ role: 'user', content: `You are helping someone post to r/${subreddit} on Reddit. Here are the subreddit rules:\n${rules}\n\nFlairs available: ${flairs || 'none listed'}\nFlair required: ${requiresFlair}\nPost type allowed: ${postTypes}\n\nIn 3-5 bullet points, tell the user exactly what they need to know before posting here — title format requirements, flair rules, what gets removed, content restrictions. Be specific and concise. End with: "Ready! Now send it exactly like this:\n\npost on r/${subreddit} — Title: your title here — Body: your text here"` }],
          max_tokens: 300
        }, { headers: { Authorization: `Bearer ${groqKey}`, 'Content-Type': 'application/json' } });

        const guidance = guidanceRes.data.choices[0].message.content;
        const flairLine = flairs ? `\n\n🏷️ *Available flairs:* ${flairs}` : '';
        pendingRedditPost[from] = { subreddit };
        const reply = `📋 *r/${subreddit} posting rules:*\n\n${guidance}${flairLine}\n\nNow just send your title and body — first line is the title, rest is the body. Or say *cancel* to stop.`;
        addToHistory(from, 'assistant', reply);
        return reply;
      } catch(e) {
        console.error('[REDDIT RULES] fetch failed:', e.message);
        return `Ready to post on r/${subreddit}. Send it as:\n\n*post on r/${subreddit} — Title: your title — Body: your text*\n\n(Couldn't fetch subreddit rules: ${e.message})`;
      }
    }

    // Step 2 — title provided, go ahead and post
    const title = titleMatch[1].trim();
    const body = bodyMatch ? bodyMatch[1].trim() : '';

    const pendingReply = `📝 Posting to r/${subreddit}...\n\n*Title:* ${title}${body ? '\n*Body:* ' + body.slice(0, 100) + (body.length > 100 ? '...' : '') : ''}`;
    addToHistory(from, 'assistant', pendingReply);

    const result = await postToReddit(subreddit, title, body);
    const finalReply = result.ok
      ? `✅ Posted to r/${subreddit}!\n\n🔗 ${result.url}`
      : `❌ Post failed: ${result.error}`;
    addToHistory(from, 'assistant', finalReply);
    return finalReply;
  }

  const isRedditBrowse = !isReminder && (
    /(show|get|give|find|what'?s?|see).*(reddit|r\/\w+)|reddit.*(hot|new|top|rising|controversial)|^(hot|new|top|rising|controversial).*(post|reddit)|top posts|hottest post|most viral|most popular post/i.test(lower)
    || /sub.?reddit\s+\w+|\bin (the )?sub.?reddit\b|\bin r\/\w+|what.*people.*talk.*about.*in\s+\w+|top ideas.*in\s+\w+|what.*trending.*in\s+\w+/i.test(lower)
  );

  if (isRedditBrowse) {
    const site = lastVisitedSite[from];

    // Detect category — also catch natural language like "top ideas", "what people are talking about"
    let category = 'hot';
    if (/\bnew\b|newest|latest/i.test(lower)) category = 'new';
    else if (/\btop\b|best|highest/i.test(lower)) category = 'top';
    else if (/\brising\b/i.test(lower)) category = 'rising';
    else if (/controversial/i.test(lower)) category = 'controversial';
    else if (/hot|hottest|trending|talking about|people.*discuss|ideas.*people/i.test(lower)) category = 'hot';

    // Detect time filter (for top)
    let timeFilter = 'day';
    if (/this week|past week/i.test(lower)) timeFilter = 'week';
    else if (/this month|past month/i.test(lower)) timeFilter = 'month';
    else if (/this year|past year/i.test(lower)) timeFilter = 'year';
    else if (/all time/i.test(lower)) timeFilter = 'all';

    // Detect limit — "top 5", "show me 3", etc
    const limitMatch = lower.match(/\b(\d+)\s*(post|result)/i) || lower.match(/top\s*(\d+)/i);
    const limit = limitMatch ? Math.min(parseInt(limitMatch[1]), 25) : 10;

    // Detect subreddit — handles:
    // "r/singularity", "in the subreddit singularity", "sub reddit singularity", "in r/singularity"
    let sub = null;
    const rSlashMatch = lower.match(/r\/(\w+)/i);
    const naturalMatch = lower.match(/sub.?reddit\s+(\w+)|in (the )?sub.?reddit[,\s]+(\w+)|subreddit[,\s]+(\w+)/i);
    if (rSlashMatch) {
      sub = rSlashMatch[1];
    } else if (naturalMatch) {
      sub = naturalMatch[1] || naturalMatch[3] || naturalMatch[4];
    } else if (site?.type === 'reddit') {
      sub = site.subreddit;
    } else {
      sub = 'popular';
    }

    const timeParam = category === 'top' ? `&t=${timeFilter}` : '';
    const jsonUrl = `https://www.reddit.com/r/${sub}/${category}.json?limit=${limit}${timeParam}`;
    const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

    try {
      const rRes = await axios.get(jsonUrl, { headers: { 'User-Agent': UA } });
      const posts = rRes.data?.data?.children || [];
      if (!posts.length) return "No posts found — try a different category or subreddit.";

      const categoryLabel = category.charAt(0).toUpperCase() + category.slice(1);
      const timeLabel = category === 'top' ? ` (${timeFilter})` : '';
      const postList = posts.map((p, i) => `${i+1}. *${p.data.title}* — ${p.data.ups.toLocaleString()} upvotes | ${p.data.num_comments.toLocaleString()} comments`).join('\n');

      lastVisitedSite[from] = { url: `https://reddit.com/r/${sub}/${category}`, name: `r/${sub}`, type: 'reddit', subreddit: sub };

      // If user asked "what are people talking about" style — summarize with LLM instead of just listing
      const wantsAnalysis = /what.*people.*talk|top ideas|what.*discuss|what.*trending|what.*going on|summarize|give me a sense/i.test(lower);
      if (wantsAnalysis) {
        const groqKeyR = GROQ_KEYS[groqKeyIndex++ % GROQ_KEYS.length];
        const summaryRes = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
          model: 'llama-3.1-8b-instant',
          messages: [{
            role: 'user',
            content: `Here are the top posts from r/${sub} right now:\n\n${posts.map(p => `- ${p.data.title} (${p.data.ups} upvotes)`).join('\n')}\n\nSummarize: what are the main themes and topics people are discussing? What's the vibe of the community right now? Keep it punchy — 3-4 sentences max.`
          }],
          max_tokens: 300
        }, { headers: { Authorization: `Bearer ${groqKeyR}`, 'Content-Type': 'application/json' } });
        const summary = summaryRes.data.choices[0].message.content;
        const reply = `🤖 *r/${sub} — What's trending:*\n\n${summary}\n\n📋 *Top posts:*\n${postList}\n\n🔗 https://reddit.com/r/${sub}/${category}`;
        addToHistory(from, 'assistant', reply);
        return reply;
      }

      const reply = `🤖 *r/${sub} — ${categoryLabel}${timeLabel}:*\n\n${postList}\n\n🔗 https://reddit.com/r/${sub}/${category}`;
      addToHistory(from, 'assistant', reply);
      return reply;
    } catch(e) {
      return "Couldn't fetch Reddit right now. Try again.";
    }
  }

  // ─── BROWSER AGENT INTENT ───────────────────────────────────────────────────
  // Triggers: "go to X", "open X", "browse X", "check X website", "look up X on Y"
  const BROWSER_MODE_TTL = 5 * 60 * 1000; // 5 minutes
  const inBrowserMode = browserModeActive[from] && (Date.now() - browserModeActive[from]) < BROWSER_MODE_TTL;
  // Only keep browser mode for actual browser-style follow-up commands
  const isBrowserFollowUp = /^(play|pause|stop|mute|unmute|volume|skip|scroll|go back|go forward|reload|refresh|next|fullscreen|click|close tab|new tab|open tab|switch tab|what tabs|bookmark|read|what's on|what is on)/i.test(lower);
  const isBrowseTask = !isReminder && (/^open chrome\b/i.test(lower) || (inBrowserMode && isBrowserFollowUp));

  if (isBrowseTask) {
    // Try Chrome extension first (user's real logged-in browser)
    if (hasBrowserExtension(from)) {
      addToHistory(from, 'user', text);
      const chromeReply = await runBrowserAgentTask(from, text);
      if (chromeReply) {
        browserModeActive[from] = Date.now(); // refresh 5-min window
        addToHistory(from, 'assistant', chromeReply);
        return chromeReply;
      }
    }
    if (!BROWSERBASE_API_KEY && !hasBrowserExtension(from)) { /* no browser agent — fall through to Groq */ }
    else if (!hasBrowserExtension(from) && BROWSERBASE_API_KEY) {

    // Extract URL or site name
    const urlMatch = text.match(/https?:\/\/[^\s]+/i);
    const siteMatch = lower.match(/(?:go to|open|browse|visit|check|on|at)\s+([\w.-]+\.(?:com|org|net|io|app))/i);
    let targetUrl = urlMatch ? urlMatch[0] : siteMatch ? `https://${siteMatch[1]}` : null;

    // Map common names to URLs
    const siteMap = { reddit: 'https://reddit.com', google: 'https://google.com', youtube: 'https://youtube.com',
      instagram: 'https://instagram.com', twitter: 'https://twitter.com', doordash: 'https://doordash.com',
      amazon: 'https://amazon.com', linkedin: 'https://linkedin.com', polymarket: 'https://polymarket.com',
      airbnb: 'https://airbnb.com', ubereats: 'https://ubereats.com' };
    if (!targetUrl) {
      for (const [name, url] of Object.entries(siteMap)) {
        if (lower.includes(name)) { targetUrl = url; break; }
      }
    }

    const reply_pending = "🌐 On it — browsing now...";
    addToHistory(from, 'user', text);

    // Reddit — use public JSON API instead of browser (more reliable)
    if (targetUrl && targetUrl.includes('reddit.com')) {
      const subredditMatch = text.match(/r\/(\w+)/i);
      const jsonUrl = subredditMatch
        ? `https://www.reddit.com/r/${subredditMatch[1]}/hot.json?limit=10`
        : 'https://www.reddit.com/r/popular/hot.json?limit=10';
      try {
        const rRes = await axios.get(jsonUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36' } });
        const posts = (rRes.data?.data?.children || []).map(p => '• *' + p.data.title + '* (' + p.data.ups + ' upvotes)').join('\n');
        const sub = subredditMatch ? `r/${subredditMatch[1]}` : 'Reddit Popular';
        lastVisitedSite[from] = { url: jsonUrl.replace('.json?limit=10',''), name: sub, type: 'reddit', subreddit: subredditMatch ? subredditMatch[1] : 'popular' };
        const reply = `🤖 *${sub} — Hot Posts:*

${posts}

🔗 ${jsonUrl.replace('.json?limit=10','')}`;
        addToHistory(from, 'assistant', reply);
        return reply;
      } catch(e) { /* fall through to browser */ }
    }

    const result = await runBrowserTask(text, targetUrl);
    if (!result) {
      const reply = "❌ Couldn't complete the browser task. Try again in a moment.";
      addToHistory(from, 'assistant', reply);
      return reply;
    }

    lastVisitedSite[from] = { url: result.url, name: result.pageTitle, type: 'browser' };
    const reply = `🌐 *${result.pageTitle}*\n\n${result.summary}\n\n🔗 ${result.url}`;
    addToHistory(from, 'assistant', reply);
    return reply;
  }

    } // end BROWSERBASE block

  // ─── GMAIL INTENT DETECTION ─────────────────────────────────────────────────
  const isGmailTriage = !isReminder && /(triage|clean up|clean out|sort|organize|declutter) (my )?(inbox|emails?|gmail)|inbox (triage|cleanup|clean)/i.test(lower);
  // Only fire Gmail intents when user is clearly issuing a command — not just mentioning email in a sentence
  const isGmailCheck = !isReminder && !isGmailTriage && /^(check|show|get|read|open|see) (my )?(email|gmail|inbox)|^(any new emails?|unread emails?|what'?s? in my (inbox|email)|show me my emails?|my emails? please)/i.test(lower.trim());
  const isGmailBatchDelete = !isReminder && /(delete|trash|remove|clean ?up) (all|every|bulk|multiple|batch|my) ?(emails?|messages?|inbox|unread|promo\w*|newsletter\w*|spam)?|delete emails? (from|about|older than|before)/i.test(lower);
  const isGmailDelete = !isGmailBatchDelete && !isReminder && /^(delete|trash|remove)\b/i.test(lower.trim()) && /(email|message|the (first|second|third|last|one)|that one|this one|\bfirst\b|\bsecond\b|\bthird\b|\blast\b|#?[1-5]\b)/i.test(lower);
  const isGmailSearch = !isReminder && /^(emails? from |emails? about |find (an? )?email|search (my )?(email|gmail))/i.test(lower.trim());
  // Only trigger send if message starts with send/email command — avoid false positives
  const isGmailSend = !isReminder && /^(send (an? )?email (to |for )|email [^\s]+ (about|saying|that))/i.test(lower);
  const isGmailReply = !isReminder && /^(reply|respond) (to )?(that |the |this |[\w]+'?s? )?(email|message|mail)|^reply (saying|with)/i.test(lower.trim());
  const isGmailMarkRead = !isReminder && /^(mark|flag) (that |the |this |it )?(email|message)? ?(as )?read|^(mark|flag) (that|it) read/i.test(lower.trim());
  const isGmailArchive = !isReminder && /^(archive|move to archive) (that |the |this |it )?(email|message)?/i.test(lower.trim());
  const isGmailThread = !isReminder && /^(show|summarize|read|get) (the |this |that )?(email |message )?thread|^summarize (the |this )?thread|^what'?s? in (the |this )?thread/i.test(lower.trim());
  const isGmailConfirmSend = !isReminder && lastGmailAction[from]?.type === 'draft' && /^(yes|send it|confirm|go ahead|do it|yep|yeah|sure)$/i.test(lower.trim());
  // Triage confirm — "yes" or "delete them" after a triage result
  const isTriageConfirm = !isReminder && lastGmailAction[from]?.type === 'triage_confirm' && /^(yes|confirm|go ahead|do it|yep|yeah|sure|delete them|delete all)$/i.test(lower.trim());

  // ─── CALENDAR INTENT DETECTION ───────────────────────────────────────────────
  const isCalendarCheck = !isReminder && /(what('s| is) on my calendar|my (schedule|meetings?|events?|calendar)|calendar (today|tomorrow|this week|for)|do i have (anything|meetings?|events?) (today|tomorrow))/i.test(lower);
  const isCalendarAdd = !isReminder && /(add .* (to my calendar|to calendar)|schedule .* (at|on|for)|book .* (at|on|for)|create (a |an )?(event|meeting|appointment))/i.test(lower);

  // ─── HELP / COMMANDS ────────────────────────────────────────────────────────
  const isHelp = /^\/help$|^\/commands?$|^what can (i|u) (say|type|do)|^help$|^commands?$|^what('s| are) (the )?commands?/i.test(lower.trim());

  if (isHelp) {
    const site = lastVisitedSite[from];
    let contextCommands = '';

    if (site?.type === 'reddit') {
      contextCommands = `\n🤖 *Reddit — you're on ${site.name}:*
• hot posts on r/[subreddit]
• new posts on r/[subreddit]
• top posts on r/[subreddit] this week
• rising posts on r/[subreddit]
• controversial posts on r/[subreddit]
• top 5 posts on r/[subreddit] all time
• hottest post right now`;
    } else if (site?.type === 'browser') {
      contextCommands = `\n🌐 *Browser — last visited: ${site.name}:*
• hottest post right now (pulls top content from ${site.name})
• go to [any website]`;
    }

    const reply = `📋 *Synapses Commands:*

📰 *Reddit:*
• show me r/[subreddit]
• hot / new / top / rising / controversial posts on r/[subreddit]
• top [number] posts on r/[subreddit] this week/month/year/all time
• hottest post right now

📊 *Polymarket:*
• top markets on polymarket
• what should I bet on polymarket

📧 *Gmail:*
• check my emails
• emails from [name]
• send email to [email] about [subject]
• delete first email / delete email from [name]
• reply to that email saying [message]
• archive that email / mark that email as read

📅 *Calendar:*
• what's on my calendar today/tomorrow
• add [event] on [date] at [time]

⏰ *Reminders:*
• remind me to [task] in [X] minutes/hours
• remind me to [task] at [time]
• show my reminders
• cancel reminder [number]

📝 *Notes:*
• save note: [content]
• show my notes
• read note [number]
• delete note [number]

📡 *Briefings:*
• brief me about [topic] at [time]
• brief me about ai events at luma every [time]
• show my briefings
• cancel briefing [number] / cancel all briefings
• brief me now

🌐 *Browser:*
• go to [website]
• browse [website]${contextCommands}`;

    addToHistory(from, 'assistant', reply);
    return reply;
  }

  const isShowNotes = /^(show|list|get|view|read|see) (my )?(notes?|saved notes?)|^my notes?$|^what('s| are| did i save| have i saved)/i.test(lower.trim());
  const isShowReminders = /^(show|list|get|view|what are) (my )?(reminders?|upcoming reminders?)|^my reminders?$|^what reminders?/i.test(lower.trim());
  const isShowBriefing = /^(show|what|get|view) (my )?(briefing|scheduled briefing|daily briefing)|^my briefing$|^what briefing/i.test(lower.trim());
  const isReadNote = /^(read|open|show|get|view) note\s*(\d+|first|second|third|last)/i.test(lower.trim());
  const isDeleteNote = /^(delete|remove|cancel) (my |a |the )?(note|saved note)/i.test(lower.trim());
  const isDeleteReminder = /^(delete|remove|cancel) (my |a |the )?(reminder)/i.test(lower.trim());

  // ─── READ NOTE ───────────────────────────────────────────────────────────────
  if (isReadNote) {
    const numWords = { first: 1, second: 2, third: 3, last: -1 };
    const numMatch = lower.match(/note\s*(\d+|first|second|third|last)/i);
    const raw = numMatch?.[1]?.toLowerCase();
    let idx = raw ? (numWords[raw] !== undefined ? numWords[raw] : parseInt(raw)) : 1;
    const notes = lastNotesList[from];
    if (!notes || !notes.length) return 'Say "show my notes" first to load your notes list.';
    if (idx === -1) idx = notes.length;
    const note = notes[idx - 1];
    if (!note) return `I don't have a note #${idx}. Say "show my notes" to see your list.`;
    const reply = `📝 *${note.title || 'Untitled'}*\n\n${note.body || '(empty note)'}`;
    addToHistory(from, 'user', text);
    addToHistory(from, 'assistant', reply);
    return reply;
  }

  // ─── SHOW NOTES ──────────────────────────────────────────────────────────────
  if (isShowNotes) {
    try {
      const notesRes = await axios.get(`${SUPABASE_URL}/rest/v1/notes?${phoneFilter}&order=created_at.desc&limit=20`, {
        headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
      });
      const notes = notesRes.data || [];
      if (!notes.length) return "You have no saved notes yet.";
      // Store notes in memory so user can read by number
      lastNotesList[from] = notes;
      const list = notes.map((n, i) => `${i + 1}. 📝 *${n.title || 'Untitled'}*`).join('\n');
      return `📝 *Your Notes (${notes.length}):*\n\n${list}\n\nSay *"read note 1"* to see the full content of any note.`;
    } catch(e) {
      return "Couldn't fetch your notes right now.";
    }
  }

  // ─── SHOW REMINDERS ──────────────────────────────────────────────────────────
  if (isShowReminders) {
    try {
      const remRes = await axios.get(`${SUPABASE_URL}/rest/v1/reminders?${phoneFilter}&sent=eq.false&order=fire_at.asc&limit=10`, {
        headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
      });
      const reminders = remRes.data || [];
      if (!reminders.length) return "You have no upcoming reminders.";
      const list = reminders.map((r, i) => {
        const t = new Date(r.fire_at).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'America/Vancouver' });
        return `${i + 1}. ⏰ *${r.message}*\n📅 ${t} Vancouver`;
      }).join('\n\n');
      return `⏰ *Your Reminders (${reminders.length}):*\n\n${list}`;
    } catch(e) {
      return "Couldn't fetch your reminders right now.";
    }
  }

  // ─── SHOW BRIEFING ───────────────────────────────────────────────────────────
  if (isShowBriefing) {
    try {
      const bRes = await axios.get(`${SUPABASE_URL}/rest/v1/briefings?${phoneFilter}&order=created_at.asc`, {
        headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
      });
      const briefings = bRes.data || [];
      if (!briefings.length) return "You have no briefings scheduled. Say something like \"brief me at 9am about AI events\" to set one up.";
      const list = briefings.map((b, i) => {
        const timeStr = b.time_utc ? (() => {
          const [h, m] = b.time_utc.split(':').map(Number);
          const d = new Date(); d.setUTCHours(h, m, 0, 0);
          return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Vancouver' }) + ' PT';
        })() : 'no time set';
        return `${i + 1}. 📋 *${b.topic}*\n⏰ ${timeStr}${b.url ? '\n🔗 ' + b.url.split('?')[0] : ''}`;
      }).join('\n\n');
      return `🌅 *Your Scheduled Briefings (${briefings.length}):*\n\n${list}\n\nSay *"cancel briefing 1"* to cancel a specific one.`;
    } catch(e) {
      return "Couldn't fetch your briefings right now.";
    }
  }

  // ─── DELETE NOTE ─────────────────────────────────────────────────────────────
  if (isDeleteNote) {
    const numMatch = lower.match(/\b(first|second|third|last|[1-9])\b/i);
    const numWord = { first: 0, second: 1, third: 2, last: -1 };
    try {
      const notesRes = await axios.get(`${SUPABASE_URL}/rest/v1/notes?${phoneFilter}&order=created_at.desc&limit=20`, {
        headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
      });
      const notes = notesRes.data || [];
      if (!notes.length) return "You have no notes to delete.";
      let idx = 0;
      if (numMatch) idx = numWord[numMatch[1].toLowerCase()] ?? (parseInt(numMatch[1]) - 1);
      if (idx < 0) idx = notes.length - 1;
      const note = notes[idx];
      if (!note) return "Couldn't find that note.";
      await axios.delete(`${SUPABASE_URL}/rest/v1/notes?id=eq.${note.id}`, {
        headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
      });
      return `🗑️ Deleted note: *${note.title || 'Untitled'}*`;
    } catch(e) {
      return "Couldn't delete that note right now.";
    }
  }

  // ─── DELETE REMINDER ─────────────────────────────────────────────────────────
  if (isDeleteReminder) {
    const numMatch = lower.match(/\b(first|second|third|last|[1-9])\b/i);
    const numWord = { first: 0, second: 1, third: 2, last: -1 };
    try {
      const remRes = await axios.get(`${SUPABASE_URL}/rest/v1/reminders?${phoneFilter}&sent=eq.false&order=fire_at.asc&limit=10`, {
        headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
      });
      const reminders = remRes.data || [];
      if (!reminders.length) return "You have no reminders to delete.";
      let idx = 0;
      if (numMatch) idx = numWord[numMatch[1].toLowerCase()] ?? (parseInt(numMatch[1]) - 1);
      if (idx < 0) idx = reminders.length - 1;
      const rem = reminders[idx];
      if (!rem) return "Couldn't find that reminder.";
      await axios.delete(`${SUPABASE_URL}/rest/v1/reminders?id=eq.${rem.id}`, {
        headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
      });
      return `🗑️ Cancelled reminder: *${rem.message}*`;
    } catch(e) {
      return "Couldn't delete that reminder right now.";
    }
  }

  // ─── TRIAGE CONFIRM ──────────────────────────────────────────────────────────
  if (isTriageConfirm) {
    const { deleteIds, deleteList } = lastGmailAction[from];
    lastGmailAction[from] = null;
    await sendWhatsApp(from, `🗑️ Deleting ${deleteIds.length} emails...`);
    let deleted = 0;
    for (let i = 0; i < deleteIds.length; i += 10) {
      const batch = deleteIds.slice(i, i + 10);
      await Promise.all(batch.map(id => gmailTrash(id)));
      deleted += batch.length;
    }
    return `✅ Deleted ${deleted} emails. Your inbox is cleaner now!`;
  }

  // ─── GMAIL TRIAGE ────────────────────────────────────────────────────────────
  if (isGmailTriage) {
    if (!GOOGLE_REFRESH_TOKEN) return "Gmail isn't connected yet.";

    // Fetch inbox emails — get up to 50 for triage
    await sendWhatsApp(from, "🔍 Scanning your inbox, give me a sec...");
    const token = await getGoogleAccessToken();
    if (!token) return "Couldn't connect to Gmail.";

    const listRes = await axios.get('https://gmail.googleapis.com/gmail/v1/users/me/messages', {
      headers: { Authorization: `Bearer ${token}` },
      params: { q: 'in:inbox', maxResults: 50 }
    }).catch(() => null);

    const messageIds = listRes?.data?.messages || [];
    if (!messageIds.length) return "Your inbox is empty! 🎉";

    // Fetch metadata for all emails
    const emails = await Promise.all(messageIds.map(async m => {
      try {
        const msgRes = await axios.get(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}`, {
          headers: { Authorization: `Bearer ${token}` },
          params: { format: 'metadata', metadataHeaders: ['From', 'Subject', 'Date'] }
        });
        const headers = msgRes.data.payload?.headers || [];
        const get = n => headers.find(h => h.name === n)?.value || '';
        return {
          id: m.id,
          from: get('From').replace(/<.*>/, '').trim() || get('From'),
          subject: get('Subject') || '(no subject)',
          date: get('Date'),
          snippet: (msgRes.data.snippet || '').slice(0, 80)
        };
      } catch(e) { return null; }
    }));
    const validEmails = emails.filter(Boolean);

    // Ask LLM to classify each as safe-to-delete or keep
    const groqKey = GROQ_KEYS[groqKeyIndex++ % GROQ_KEYS.length];
    const emailList = validEmails.map((e, i) =>
      `${i + 1}. From: ${e.from} | Subject: ${e.subject} | Preview: ${e.snippet}`
    ).join('\n');

    const classifyRes = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
      model: 'llama-3.1-8b-instant',
      messages: [{
        role: 'system',
        content: `You are an email triage assistant. Classify each email as DELETE or KEEP.
KEEP if: real person emailing, bank/financial statement, receipt/order confirmation, legal/medical, calendar invite, job/work related, personal message, anything that might need a reply.
DELETE if: newsletter, promotional, marketing, sale/deal, social media notification, automated noreply, digest, subscription, "you have a new follower", shipping promo, app notification.
Respond ONLY with JSON array: [{"index":1,"action":"DELETE","reason":"newsletter"},{"index":2,"action":"KEEP","reason":"personal email from John"},...]`
      }, {
        role: 'user',
        content: emailList
      }],
      max_tokens: 2000
    }, { headers: { Authorization: `Bearer ${groqKey}`, 'Content-Type': 'application/json' } });

    let classifications = [];
    try {
      const raw = classifyRes.data.choices[0].message.content.replace(/```json|```/g, '').trim();
      classifications = JSON.parse(raw);
    } catch(e) {
      return "Couldn't classify your emails right now. Try again in a moment.";
    }

    const toDelete = classifications.filter(c => c.action === 'DELETE').map(c => validEmails[c.index - 1]).filter(Boolean);
    const toKeep = classifications.filter(c => c.action === 'KEEP').map(c => validEmails[c.index - 1]).filter(Boolean);

    if (!toDelete.length) {
      return `✅ Scanned *${validEmails.length}* emails — nothing safe to delete was found. All your emails look important!`;
    }

    // Save for confirmation
    lastGmailAction[from] = { type: 'triage_confirm', deleteIds: toDelete.map(e => e.id), deleteList: toDelete };

    const deleteLines = toDelete.map((e, i) => `${i + 1}. *${e.from}* — ${e.subject}`).join('\n');
    const keepLines = toKeep.slice(0, 10).map(e => `• ${e.from} — ${e.subject}`).join('\n');
    const keepNote = toKeep.length > 5 ? `\n_(+ ${toKeep.length - 5} more kept)_` : '';

    const reply = `🧹 *Inbox Triage — ${validEmails.length} emails scanned*\n\n` +
      `🗑️ *Safe to delete (${toDelete.length}):*\n${deleteLines}\n\n` +
      `✅ *Keeping (${toKeep.length}):*\n${keepLines}${keepNote}\n\n` +
      `Reply *yes* to delete the ${toDelete.length} junk emails, or *"delete 1,3,5"* to pick specific ones. Say anything else to cancel.`;

    lastGmailAction[from].replyText = reply;
    addToHistory(from, 'user', text);
    addToHistory(from, 'assistant', reply);
    return reply;
  }

  // ─── GMAIL HANDLERS ──────────────────────────────────────────────────────────
  if (isGmailCheck) {
    if (!GOOGLE_REFRESH_TOKEN) return "Gmail isn't connected yet. Ask me how to set it up!";
    const emails = await gmailGetUnreadWithIds(5);
    if (!emails) return "Couldn't connect to Gmail right now. Check that your Google credentials are set in Render env vars.";
    // Save the shown list so follow-up commands ("delete that", "reply to the second one") know exactly what was shown
    lastGmailAction[from] = { type: 'list', emails };
    const reply = `📬 *Your Unread Emails:*\n\n${formatEmailList(emails)}`;
    addToHistory(from, 'user', text);
    addToHistory(from, 'assistant', reply);
    return reply;
  }

  // Helper: resolve "that", "first", "second", "the one from John" etc from the saved list
  function resolveEmailTarget(lower, savedList) {
    if (!savedList || !savedList.length) return null;
    const numWord = { one: 0, two: 1, three: 2, four: 3, five: 4, first: 0, second: 1, third: 2, fourth: 3, fifth: 4 };
    const numMatch = lower.match(/\b(first|second|third|fourth|fifth|one|two|three|four|five|#?[1-5])\b/i);
    if (numMatch) {
      const idx = numWord[numMatch[1].toLowerCase()] ?? (parseInt(numMatch[1]) - 1);
      return savedList[idx] || savedList[0];
    }
    const fromMatch = lower.match(/from ([\w\s.]+?)(?:\s|$)/i);
    if (fromMatch) return savedList.find(e => e.from.toLowerCase().includes(fromMatch[1].trim().toLowerCase())) || savedList[0];
    const aboutMatch = lower.match(/about ([\w\s]+?)(?:\s|$)/i);
    if (aboutMatch) return savedList.find(e => e.subject.toLowerCase().includes(aboutMatch[1].trim().toLowerCase())) || savedList[0];
    return savedList[0]; // default to first
  }


  if (isGmailBatchDelete) {
    if (!GOOGLE_REFRESH_TOKEN) return "Gmail isn't connected yet.";

    // Build the Gmail search query from what the user said
    let query = 'is:unread'; // default
    let description = 'all unread emails';

    const fromMatch = lower.match(/(?:emails?|messages?) from ([\w\s.@]+?)(?:\s+(?:older|before|and|$))/i) ||
                      lower.match(/from ([\w\s.@]+?)(?:\s|$)/i);
    const olderMatch = lower.match(/older than (\d+)\s*(day|week|month|year)s?/i);
    const beforeMatch = lower.match(/before (\d{4}[-/]\d{1,2}[-/]\d{1,2})/i);
    const promoMatch = /promo|promot|newsletter|subscri|marketing|sale|deal|offer/i.test(lower);
    const spamMatch = /spam/i.test(lower);
    const allMatch = /all (my )?(emails?|inbox|messages?)/i.test(lower);
    const unreadMatch = /unread/i.test(lower);
    const readMatch = /\bread\b/i.test(lower) && !unreadMatch;

    if (spamMatch) {
      query = 'in:spam';
      description = 'all spam emails';
    } else if (promoMatch) {
      query = 'category:promotions OR category:updates OR unsubscribe';
      description = 'all promotional/newsletter emails';
    } else if (fromMatch) {
      const sender = fromMatch[1].trim();
      query = `from:${sender}`;
      description = `all emails from *${sender}*`;
      if (olderMatch) {
        const unit = olderMatch[2].toLowerCase();
        const unitMap = { day: 'd', week: 'w', month: 'm', year: 'y' };
        query += ` older_than:${olderMatch[1]}${unitMap[unit] || 'd'}`;
        description += ` older than ${olderMatch[1]} ${olderMatch[2]}(s)`;
      }
    } else if (olderMatch) {
      const unit = olderMatch[2].toLowerCase();
      const unitMap = { day: 'd', week: 'w', month: 'm', year: 'y' };
      query = `older_than:${olderMatch[1]}${unitMap[unit] || 'd'}`;
      description = `all emails older than ${olderMatch[1]} ${olderMatch[2]}(s)`;
    } else if (beforeMatch) {
      query = `before:${beforeMatch[1].replace(/\//g, '/')}`;
      description = `all emails before ${beforeMatch[1]}`;
    } else if (readMatch) {
      query = 'is:read';
      description = 'all read emails';
    } else if (allMatch) {
      query = 'in:inbox';
      description = 'all inbox emails';
    }

    // First do a dry run count so user can confirm before we nuke everything
    if (lastGmailAction[from]?.type === 'batch_delete_confirm' && lastGmailAction[from].query === query) {
      // User already confirmed — go ahead
      const ids = lastGmailAction[from].ids;
      lastGmailAction[from] = null;
      const reply = `🗑️ Deleting ${ids.length} emails... this may take a moment.`;
      addToHistory(from, 'user', text);
      addToHistory(from, 'assistant', reply);
      await sendWhatsApp(from, reply);
      const deleted = await gmailBatchTrash(ids);
      const done = `✅ Done! Deleted *${deleted}* emails.`;
      addToHistory(from, 'assistant', done);
      return done;
    }

    // Count first, then ask to confirm
    const ids = await gmailBatchSearch(query, 500);
    if (!ids) return "❌ Couldn't search Gmail right now.";
    if (!ids.length) return `No emails found matching: ${description}.`;

    lastGmailAction[from] = { type: 'batch_delete_confirm', query, ids, description };
    const reply = `⚠️ Found *${ids.length}* emails matching: ${description}.\n\nReply *yes* to delete all of them, or say something else to cancel.`;
    addToHistory(from, 'user', text);
    addToHistory(from, 'assistant', reply);
    return reply;
  }

  // Confirm batch delete
  if (!isReminder && lastGmailAction[from]?.type === 'batch_delete_confirm' && /^(yes|confirm|go ahead|do it|yep|yeah|sure|delete them|delete all)$/i.test(lower.trim())) {
    const { ids, description } = lastGmailAction[from];
    lastGmailAction[from] = null;
    const preview = `🗑️ Deleting ${ids.length} emails... this may take a moment.`;
    addToHistory(from, 'user', text);
    addToHistory(from, 'assistant', preview);
    await sendWhatsApp(from, preview);
    const deleted = await gmailBatchTrash(ids);
    const done = `✅ Done! Deleted *${deleted}* emails (${description}).`;
    addToHistory(from, 'assistant', done);
    return done;
  }

  if (isGmailDelete) {
    if (!GOOGLE_REFRESH_TOKEN) return "Gmail isn't connected yet.";
    const savedList = lastGmailAction[from]?.emails || null;
    console.log('[DELETE] savedList:', savedList ? savedList.length + ' emails' : 'none', '| text:', lower);
    const emails = savedList || await gmailGetUnreadWithIds(5);
    if (!emails || !emails.length) return "No unread emails to delete.";
    const target = resolveEmailTarget(lower, emails);
    console.log('[DELETE] target:', target ? `${target.subject} (${target.id})` : 'null');
    if (!target) return "Couldn't find that email. Try \"delete first email\" or \"delete email from [name]\".";
    const trashed = await gmailTrash(target.id);
    if (savedList) lastGmailAction[from].emails = savedList.filter(e => e.id !== target.id);
    const reply = trashed
      ? `🗑️ Deleted: *${target.subject}* from *${target.from}*`
      : "❌ Couldn't delete that email. Check your Gmail permissions.";
    addToHistory(from, 'user', text);
    addToHistory(from, 'assistant', reply);
    return reply;
  }

  if (isGmailSearch) {
    if (!GOOGLE_REFRESH_TOKEN) return "Gmail isn't connected yet.";
    const fromMatch = lower.match(/emails? from ([\w\s.]+?)(?:\s|$)/i);
    const aboutMatch = lower.match(/emails? about ([\w\s]+?)(?:\s|$)/i);
    const query = fromMatch ? `from:${fromMatch[1].trim()}` : aboutMatch ? aboutMatch[1].trim() : text;
    const emails = await gmailSearch(query, 5);
    if (!emails) return "Couldn't search Gmail right now.";
    if (!emails.length) return `No emails found for "${query}".`;
    // Save search results the same way — follow-up commands work on these too
    lastGmailAction[from] = { type: 'list', emails };
    const reply = `🔍 *Emails matching "${query}":*\n\n${formatEmailList(emails)}`;
    addToHistory(from, 'user', text);
    addToHistory(from, 'assistant', reply);
    return reply;
  }

  if (isGmailSend) {
    if (!GOOGLE_REFRESH_TOKEN) return "Gmail isn't connected yet.";

    // If waiting for subject/body after we already have the address
    if (lastGmailAction[from]?.type === 'pending_send') {
      const pending = lastGmailAction[from];
      // Treat this message as the subject/body
      const bodyMatch = text.match(/(?:saying|body[: ]+)(.+)/i);
      const subject = text.replace(/^(about|re[: ]+)/i, '').trim();
      const body = bodyMatch ? bodyMatch[1].trim() : text.trim();
      lastGmailAction[from] = { type: 'draft', to: pending.to, subject, body };
      const reply = `📝 *Draft ready — send it?*\n\n*To:* ${pending.to}\n*Subject:* ${subject}\n\n${body}\n\nReply *yes* to send or say something else to cancel.`;
      addToHistory(from, 'user', text);
      addToHistory(from, 'assistant', reply);
      return reply;
    }

    // Use Groq to reliably parse to/subject/body from any length message
    let to = null, subject = null, body = null;
    try {
      const parseKey = getGroqKey();
      const parseRes = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
        model: 'llama-3.1-8b-instant',
        messages: [{
          role: 'system',
          content: `Extract email fields from a WhatsApp message. Reply ONLY with valid JSON, no explanation:
{"to":"email@address.com","subject":"subject line","body":"full email body text"}
- "to" must be a valid email address, or null if not found
- "subject" is what the email is about (short phrase), or null
- "body" is the full message content to send, or null
- If subject and body are the same thing, use it for both`
        }, {
          role: 'user',
          content: text
        }],
        max_tokens: 300,
        temperature: 0
      }, { headers: { Authorization: `Bearer ${parseKey}`, 'Content-Type': 'application/json' } });
      const raw = parseRes.data.choices[0].message.content.trim().replace(/```json|```/g, '').trim();
      const parsed = JSON.parse(raw);
      to = parsed.to || null;
      subject = parsed.subject || null;
      body = parsed.body || null;
    } catch(e) {
      // Fallback to basic regex if Groq fails
      const toEmailMatch = text.match(/to\s+([\w._%+-]+@[\w.-]+\.[a-z]{2,})/i);
      to = toEmailMatch ? toEmailMatch[1] : null;
    }

    if (!to) return "What's their email address?";

    // If no subject/body, save the address and ask
    if (!subject) {
      lastGmailAction[from] = { type: 'pending_send', to };
      const reply = `Got it — emailing *${to}*. What's the subject and message?`;
      addToHistory(from, 'user', text);
      addToHistory(from, 'assistant', reply);
      return reply;
    }

    lastGmailAction[from] = { type: 'draft', to, subject, body: body || subject };
    const reply = `📝 *Draft ready — send it?*\n\n*To:* ${to}\n*Subject:* ${subject}\n\n${body || subject}\n\nReply *yes* to send or say something else to cancel.`;
    addToHistory(from, 'user', text);
    addToHistory(from, 'assistant', reply);
    return reply;
  }

  if (isGmailConfirmSend) {
    const draft = lastGmailAction[from];
    lastGmailAction[from] = null;
    const sent = await gmailSend(draft.to, draft.subject, draft.body);
    const reply = sent ? `✅ Email sent to *${draft.to}*!\n📌 Subject: ${draft.subject}` : "❌ Couldn't send the email. Check your Gmail credentials.";
    addToHistory(from, 'user', text);
    addToHistory(from, 'assistant', reply);
    return reply;
  }

  if (isGmailReply) {
    if (!GOOGLE_REFRESH_TOKEN) return "Gmail isn't connected yet.";
    // Resolve target from saved list first, then fall back to fetching
    const savedList = lastGmailAction[from]?.emails || null;
    let targetBasic = savedList ? resolveEmailTarget(lower, savedList) : null;
    let target = null;
    if (targetBasic) {
      target = await gmailGetFullEmail(targetBasic.id);
    } else {
      const emails = await gmailGetUnreadWithIds(1);
      if (!emails || !emails.length) return "No recent emails to reply to. Check your emails first with \"check my emails\".";
      target = await gmailGetFullEmail(emails[0].id);
    }
    if (!target) return "Couldn't find the email to reply to.";
    const bodyMatch = text.match(/(?:saying|with|reply[: ]+)(.+)/i);
    if (!bodyMatch) return `Reply to *${target.fromClean}* — what should I say? (e.g. "reply saying I'll be there")`;
    const replyBody = bodyMatch[1].trim();
    lastGmailAction[from] = { type: 'reply_draft', messageId: target.id, threadId: target.threadId, to: target.fromEmail, subject: target.subject, body: replyBody };
    const preview = `📝 *Reply draft — send it?*\n\n*To:* ${target.fromClean}\n*Re:* ${target.subject}\n\n${replyBody}\n\nReply *yes* to send or something else to cancel.`;
    addToHistory(from, 'user', text);
    addToHistory(from, 'assistant', preview);
    return preview;
  }

  // Confirm reply send
  if (!isReminder && lastGmailAction[from]?.type === 'reply_draft' && /^(yes|send it|confirm|go ahead|do it|yep|yeah|sure)$/i.test(lower.trim())) {
    const draft = lastGmailAction[from];
    lastGmailAction[from] = null;
    const sent = await gmailReply(draft.messageId, draft.to, draft.subject, draft.body, draft.threadId);
    const reply = sent ? `✅ Reply sent!\n📌 Re: ${draft.subject}` : "❌ Couldn't send the reply. Check your Gmail credentials.";
    addToHistory(from, 'user', text);
    addToHistory(from, 'assistant', reply);
    return reply;
  }

  if (isGmailMarkRead) {
    if (!GOOGLE_REFRESH_TOKEN) return "Gmail isn't connected yet.";
    const savedList = lastGmailAction[from]?.emails || await gmailGetUnreadWithIds(5);
    if (!savedList || !savedList.length) return "No unread emails to mark as read.";
    const target = resolveEmailTarget(lower, savedList);
    if (!target) return "Couldn't find that email.";
    const done = await gmailMarkRead(target.id);
    if (lastGmailAction[from]?.emails) lastGmailAction[from].emails = lastGmailAction[from].emails.filter(e => e.id !== target.id);
    const reply = done ? `✅ Marked as read: *${target.subject}* from *${target.from}*` : "❌ Couldn't mark as read. Check your Gmail permissions.";
    addToHistory(from, 'user', text);
    addToHistory(from, 'assistant', reply);
    return reply;
  }

  if (isGmailArchive) {
    if (!GOOGLE_REFRESH_TOKEN) return "Gmail isn't connected yet.";
    const savedList = lastGmailAction[from]?.emails || await gmailGetUnreadWithIds(5);
    if (!savedList || !savedList.length) return "No emails to archive.";
    const target = resolveEmailTarget(lower, savedList);
    if (!target) return "Couldn't find that email.";
    const done = await gmailArchive(target.id);
    if (lastGmailAction[from]?.emails) lastGmailAction[from].emails = lastGmailAction[from].emails.filter(e => e.id !== target.id);
    const reply = done ? `📂 Archived: *${target.subject}* from *${target.from}*` : "❌ Couldn't archive that email. Check your Gmail permissions.";
    addToHistory(from, 'user', text);
    addToHistory(from, 'assistant', reply);
    return reply;
  }

  if (isGmailThread) {
    if (!GOOGLE_REFRESH_TOKEN) return "Gmail isn't connected yet.";
    const savedList = lastGmailAction[from]?.emails || await gmailGetUnreadWithIds(5);
    if (!savedList || !savedList.length) return "No recent emails to show threads for.";
    const target = resolveEmailTarget(lower, savedList);
    if (!target) return "Couldn't find that email.";
    const full = await gmailGetFullEmail(target.id);
    if (!full) return "Couldn't fetch that email thread.";
    const thread = await gmailGetThread(full.threadId);
    if (!thread || !thread.length) return "Couldn't load the thread.";
    const summary = thread.map((m, i) => `${i + 1}. *${m.from}*: ${m.snippet.slice(0, 100)}`).join('\n');
    const reply = `🧵 *Thread: ${full.subject}* (${thread.length} messages)\n\n${summary}`;
    addToHistory(from, 'user', text);
    addToHistory(from, 'assistant', reply);
    return reply;
  }

  // ─── CALENDAR HANDLERS ───────────────────────────────────────────────────────
  if (isCalendarCheck) {
    if (!GOOGLE_REFRESH_TOKEN) return "Google Calendar isn't connected yet. Ask me how to set it up!";
    const isTomorrow = /tomorrow/i.test(lower);
    const isWeek = /this week|next \d+ days|week/i.test(lower);
    const days = isWeek ? 7 : isTomorrow ? 2 : 1;
    const label = isWeek ? 'This week' : isTomorrow ? 'Tomorrow' : 'Today';
    const events = await calendarGetEvents(days);
    if (!events) return "Couldn't connect to Google Calendar. Check your credentials in Render.";
    const reply = `🗓 *${label}'s Schedule:*\n\n${formatCalendarEvents(events, label)}`;
    addToHistory(from, 'user', text);
    addToHistory(from, 'assistant', reply);
    return reply;
  }

  if (isCalendarAdd) {
    if (!GOOGLE_REFRESH_TOKEN) return "Google Calendar isn't connected yet.";
    // Use LLM to parse the event details into structured JSON
    const parseKey = GROQ_KEYS[groqKeyIndex++ % GROQ_KEYS.length];
    const now = new Date().toLocaleString('en-US', { timeZone: 'America/Vancouver' });
    const parseRes = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
      model: 'llama-3.1-8b-instant',
      messages: [{
        role: 'user',
        content: `Current time in Vancouver: ${now}\nUser request: "${text}"\n\nExtract the calendar event. Respond ONLY with JSON (no markdown):\n{"title":"...","startISO":"2026-05-16T09:00:00","endISO":"2026-05-16T10:00:00","description":"..."}`
      }],
      max_tokens: 150
    }, { headers: { Authorization: `Bearer ${parseKey}`, 'Content-Type': 'application/json' } });

    let parsed;
    try {
      const raw = parseRes.data.choices[0].message.content.replace(/```json|```/g, '').trim();
      parsed = JSON.parse(raw);
    } catch(e) {
      return "Couldn't parse the event details. Try: \"Add meeting with John on Friday at 3pm\"";
    }

    const created = await calendarCreateEvent(parsed.title, parsed.startISO, parsed.endISO, parsed.description || '');
    const startFmt = new Date(parsed.startISO).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'America/Vancouver' });
    const reply = created
      ? `✅ *${parsed.title}* added to your calendar!\n🕐 ${startFmt} PT`
      : "❌ Couldn't create the event. Check your Google Calendar credentials.";
    addToHistory(from, 'user', text);
    addToHistory(from, 'assistant', reply);
    return reply;
  }

  const isSaveNote = !isReminder && (() => {
    // Exact save commands
    const saveKws = [
      'save a note', 'save note', 'make a note', 'jot this', 'jot that',
      'log this', 'keep this', 'note:', 'save that', 'save this',
      'note this', 'note that', 'save it', 'remember this', 'remember that',
      'add a note', 'add note', 'write this down', 'write that down',
      'save this for me', 'note for me', 'keep a note', 'add that to my notes',
      'add this to my notes', 'note that down', 'put that in my notes',
      'save as note', 'ok save', 'yeah save', 'yes save', 'can you save',
      'please save', 'save the', 'bookmark this', 'bookmark that'
    ];
    return saveKws.some(k => lower.includes(k));
  })();

  // Step 2: handle reminder immediately
  if (isReminder) {
    const parsed = await parseReminder(from, text);
    if (parsed) {
      await saveReminder(from, parsed.message, parsed.fireAt);
      const timeStr = parsed.fireAt.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Vancouver' });
      return `⏰ Got it! I'll remind you to ${parsed.message} at ${timeStr} Vancouver time.`;
    }
    console.error('parseReminder returned null for:', text);
    return `Sorry, I couldn't parse that reminder. Try "remind me to call John in 2 hours".`;
  }

  // Step 2b-instant: fire briefing immediately
  if (isImmediateBriefing) {
    try {
      // Check if user specified a topic inline e.g. "brief me now about AI startups" OR "brief me about dating events"
      const inlineTopicMatch = text.match(/brief\s+(?:me\s+)?(?:now\s+)?(?:about|on)\s+(.+)/i);
      const inlineTopic = inlineTopicMatch ? inlineTopicMatch[1].trim() : null;

      // Resolve Luma shorthand — "at luma", "luma vancouver-ai", etc.
      let inlineUrl = null;
      if (inlineTopic) {
        const lumaWithSlug = inlineTopic.match(/(?:at\s+)?luma\s+([\w][\w\s-]*?)[\s.,!?]*$/i);
        const lumaAlone = inlineTopic.match(/(?:at\s+)?luma\s*$/i);
        if (lumaWithSlug) {
          const slug = lumaWithSlug[1].trim().toLowerCase().replace(/\s+/g, '-');
          inlineUrl = `https://lu.ma/${slug}`;
        } else if (lumaAlone) {
          inlineUrl = 'https://lu.ma/vancouver-ai';
        }
      }

      let b;
      if (inlineTopic) {
        const cleanTopic = inlineTopic.replace(/(?:at\s+)?luma(\s+[\w\s-]+)?$/i, '').trim() || inlineTopic;
        b = { topic: cleanTopic, url: inlineUrl };
        console.log('[BRIEF] Using inline topic:', cleanTopic, 'url:', inlineUrl);
      } else {
        // Load saved briefing(s)
        const bRes = await axios.get(`${SUPABASE_URL}/rest/v1/briefings?${phoneFilter}&order=created_at.asc`,
          { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
        );
        const allBriefings = bRes.data || [];
        if (!allBriefings.length) return `You don't have a briefing set up yet. Try "brief me at 9am on AI events" or "brief me now about [topic]".`;

        // If multiple briefings and no specific topic — ask which one
        if (allBriefings.length > 1) {
          const list = allBriefings.map((br, i) => `${i + 1}. *${br.topic}*`).join('\n');
          return `You have ${allBriefings.length} briefings — which one would you like now?\n\n${list}\n\nSay *"brief me now about [topic]"* to pick one.`;
        }

        b = allBriefings[0];
      }

      console.log('[BRIEF] Firing briefing — topic:', b.topic, 'url:', b.url);

      const isLuma = b.url && (b.url.includes('lu.ma') || b.url.includes('luma.com'));
      console.log('[BRIEF] isLuma:', isLuma, 'APIFY_TOKEN set:', !!APIFY_TOKEN);

      // Try Apify for Luma URLs first
      if (isLuma && APIFY_TOKEN) {
        console.log('[BRIEF] Attempting Apify scrape...');
        const events = await lumaScrap(b.url);
        console.log('[BRIEF] Apify events returned:', events ? events.length : 'null');
        const formatted = formatLumaEvents(events);
        if (formatted) {
          console.log('[BRIEF] Apify succeeded — sending formatted events');
          // Filter and sort events the same way formatLumaEvents does, store for pagination
          const now2 = new Date();
          const filteredEvents = events
            .filter(e => e.name || e.title)
            .filter(e => { if (!e.timeUTC && !e.date) return true; return new Date(e.timeUTC || e.date) >= now2; })
            .sort((a, b) => new Date(a.timeUTC || a.date || 0) - new Date(b.timeUTC || b.date || 0));
          lastBriefingEvents[from] = { events: filteredEvents, shown: 10, topic: b.topic, url: b.url };
          const firstBatch = formatLumaEvents(filteredEvents.slice(0, 10));
          const remaining = filteredEvents.length - 10;
          const moreHint = remaining > 0 ? `\n\n_(${remaining} more — say "show more events")_` : '';
          const lumaLink = b.url ? `\n\n🔗 ${b.url.split('?')[0]}` : '';
          return `🌅 *${b.topic} Briefing:*\n\n${firstBatch}${moreHint}${lumaLink}`;
        }
        console.log('[BRIEF] Apify returned no usable events — falling back to Tavily');
      }

      // Tavily fallback — always pin to Vancouver
      console.log('[BRIEF] Using Tavily search fallback');
      const hasLocation = /vancouver|bc|toronto|montreal|calgary/i.test(b.topic);
      const locationPin = hasLocation ? '' : ' Vancouver BC Canada';
      const isEventsTopic = /events?|meetups?|conferences?|hackathon|summit|workshop/i.test(b.topic);

      const searchQuery = b.url
        ? `${b.topic} 2026`
        : isEventsTopic
          ? `upcoming ${b.topic}${locationPin} 2026 -Nairobi -Berlin -Africa -Europe -Asia`
          : `latest ${b.topic} news 2026`;

      console.log('[BRIEF] Search query:', searchQuery);
      const briefData = await tavilySearch({
        query: searchQuery,
        search_depth: 'basic',
        max_results: 4,
        include_answer: false,
        ...(isEventsTopic ? { include_domains: ['eventbrite.ca', 'meetup.com', 'lu.ma', 'luma.com'] } : {})
      });
      const results = briefData.results || [];
      console.log('[BRIEF] Tavily returned', results.length, 'results');

      // Extract age filter from topic e.g. "20+", "over 40", "30s"
      const ageFilter = b.topic.match(/\d+\+|over\s+\d+|under\s+\d+|\d+s\b/i)?.[0] || null;
      const ageMin = ageFilter ? parseInt(ageFilter.match(/\d+/)?.[0]) : null;

      // Hard filter results by age range BEFORE sending to LLM
      function resultPassesAgeFilter(text) {
        if (!ageMin) return true;
        // Find age ranges first e.g. "Ages 32-47", "M/W 28-43", "ages 42 to 57"
        const ageRangeMatch = text.match(/(?:ages?|m\/w|men|women)?\s*(\d{2})\s*[-–to]+\s*(\d{2})/i);
        // Find X+ patterns e.g. "30+", "46+"
        const agePlusMatch = text.match(/(\d+)\+/);
        if (ageRangeMatch) {
          const rangeMin = parseInt(ageRangeMatch[1]);
          // Accept only if event's minimum age >= user's requested age
          return rangeMin >= ageMin;
        }
        if (agePlusMatch) {
          const eventMin = parseInt(agePlusMatch[1]);
          // Accept if event minimum is within 5 years below user's age
          return eventMin >= ageMin - 5;
        }
        return true; // no age mentioned — keep it
      }

      const filteredResults = ageMin
        ? results.filter(r => resultPassesAgeFilter(r.title + ' ' + r.content))
        : results;
      console.log('[BRIEF] After age filter:', filteredResults.length, '/', results.length, 'results kept');

      const content = filteredResults.map(r => r.title + ': ' + r.content.slice(0, 600)).join('\n\n');

      if (!content) return `Couldn't find any events matching that age group right now. Try broadening your search.`;

      const expectedLoc = hasLocation
        ? (b.topic.match(/vancouver|bc|toronto|montreal|calgary/i)?.[0] || 'Vancouver')
        : 'Vancouver, BC';

      const prompt = isEventsTopic
        ? `You are Synbot sending a WhatsApp briefing about "${b.topic}".
Start with "🌅 *${b.topic} Briefing:*"

RULES:
- ONLY list events in or near ${expectedLoc}. Skip any event from another country or city.
- Sort EARLIEST to LATEST by date.
- Only include events you have real date data for — no guessing.
- Do NOT write "...and many more".${ageFilter ? `\n- The user wants events for ${ageFilter}. STRICT RULE: if an event specifies an age range like "32-47" or "42-57" or "46+", it does NOT qualify for ${ageFilter} — only include events where the age range actually starts at or includes the user's age group. When in doubt, skip it.` : ''}

Format each event:
📅 *Event Name*
🗓 Date (e.g. May 27, 2026)
📍 Venue, City
One line description

Content:
${content}`
        : `You are Synbot sending a short WhatsApp briefing about "${b.topic}".
Start with "🌅 *${b.topic} Briefing:*"
Write 4-6 bullet points summarizing what the search results say about this topic.
Be concise — one sentence per bullet. Use relevant emojis.

STRICT RULES:
- ONLY use facts found in the content below — do NOT add anything from your own knowledge
- Do NOT make up outcomes, verdicts, consequences, or predictions
- If the content does not confirm something, do NOT include it
- Do not write concluding paragraphs or opinions

Content:
${content}`;

      const key = getGroqKey();
      const summaryRes = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
        model: 'llama-3.1-8b-instant',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 600
      }, { headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' } });

      const briefingText = summaryRes.data.choices[0].message.content;
      const footerLink = b.url ? `\n\n🔗 ${b.url.split('?')[0]}` : '';
      // Store topic for natural follow-up conversation
      lastResearchTopic[from] = { topic: b.topic, summary: briefingText, content: content.slice(0, 2000) };
      return briefingText + footerLink;
    } catch(e) {
      console.error('[BRIEF] Error:', e.message);
      return `Sorry, couldn't fire your briefing: ${e.message}`;
    }
  }

  // Step 2b: handle briefing setup
  if (isBriefing) {
    // Resolve Luma shorthand — several patterns:
    // "at luma vancouver-ai" → lu.ma/vancouver-ai
    // "at luma vancouver ai" → lu.ma/vancouver-ai
    // "at luma" alone → lu.ma/vancouver-ai (default)
    // "luma" anywhere → lu.ma/vancouver-ai (default)
    let resolvedLumaUrl = null;
    // Extract slug after "luma" but stop before time/frequency words
    const lumaWithSlug = text.match(/(?:at\s+)?luma\s+([\w][\w-]+)(?=\s|$)/i);
    const lumaAlone = /\bluma\b/i.test(text);
    if (lumaWithSlug) {
      const slug = lumaWithSlug[1].trim().toLowerCase();
      // If slug is a time/frequency word, ignore and use default
      if (/^(every|daily|morning|night|at|\d)/.test(slug)) {
        resolvedLumaUrl = 'https://lu.ma/vancouver-ai';
      } else {
        resolvedLumaUrl = `https://lu.ma/${slug}`;
      }
    } else if (lumaAlone) {
      resolvedLumaUrl = 'https://lu.ma/vancouver-ai'; // default
    }

    // Extract URL from message if present (full URL takes priority over shorthand)
    const urlMatch = text.match(/https?:\/\/[^\s]+/);
    const url = urlMatch ? urlMatch[0].replace(/[.,!?]+$/, '') : resolvedLumaUrl;

    // Parse time directly with regex — more reliable than LLM for this
    let vanH = 8, vanM = 0; // default 8am
    const timeMatch = text.match(/(?:every|at|daily at)?\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i);
    if (timeMatch) {
      vanH = parseInt(timeMatch[1]);
      vanM = timeMatch[2] ? parseInt(timeMatch[2]) : 0;
      const ap = timeMatch[3].toLowerCase();
      if (ap === 'pm' && vanH < 12) vanH += 12;
      if (ap === 'am' && vanH === 12) vanH = 0;
    }

    // Extract topic — everything between "about/on" and "at X" or URL or end
    let topic = 'AI events';
    const topicMatch = text.match(/brief(?:ing)?\s+(?:me\s+)?(?:about|on)\s+(.+?)(?:\s+at\s+\d|\s+https?|\s*$)/i);
    if (topicMatch) {
      topic = topicMatch[1].trim()
        .replace(/https?:\/\/\S+/g, '')
        .replace(/\s*(?:at\s+)?luma(\s+[\w-]+)?/gi, '') // strip "at luma vancouver-ai"
        .replace(/\s*(every|daily|each)\s+\d+\s*(am|pm)/gi, '') // strip "every 10am"
        .replace(/\s*every\s+(day|morning|night|week)/gi, '') // strip "every day/morning"
        .replace(/\*+/g, '') // strip asterisks
        .replace(/\s+\d{1,2}(am|pm)\s*$/gi, '') // strip trailing time like "10am"
        .replace(/\s+/g, ' ')
        .trim();
    }
    if (!topic || topic.length < 2) topic = url ? 'AI Events' : 'AI events';

    // Convert Vancouver time to UTC
    const now2 = new Date();
    const vanOffsetMs = new Date(now2.toLocaleString('en-US', {timeZone:'America/Vancouver'})) - now2;
    const vanOffsetH = Math.round(vanOffsetMs / 3600000);
    const utcH = ((vanH - vanOffsetH) + 24) % 24;
    const finalTime = String(utcH).padStart(2,'0') + ':' + String(vanM).padStart(2,'0');

    // Save briefing (allow multiple per user)
    await saveBriefing(from, finalTime, topic, url);

    const vanAmPm = vanH >= 12 ? 'PM' : 'AM';
    const van12 = vanH % 12 === 0 ? 12 : vanH % 12;
    const vanTime = `${van12}:${String(vanM).padStart(2,'0')} ${vanAmPm}`;
    const sourceMsg = url ? `from ${url}` : `about *${topic}*`;
    return `🌅 Got it! Daily briefing set for ${vanTime} Vancouver time ${sourceMsg}.

Type *"brief me now"* to get it immediately.`;
  }

  // Step 3: save note
  if (isSaveNote) {
    const history = getHistory(from);
    const lastAssistant = [...history].reverse().find(m => m.role === 'assistant');

    // Strip the command prefix to get remaining content
    const stripped = text
      .replace(/^(save a note|save note|make a note|jot this down|log this|keep this|note:|save that|save this|note this|note that|ok save|yeah save|yes save|please save|save it|add that to my notes|add this to my notes|note that down|put that in my notes|save as note|bookmark this|bookmark that|remember this|remember that|add a note|add note|write this down|write that down)[\s:.]*/i, '')
      .trim();

    // Vague = no meaningful content left after stripping, or common filler words
    const isVague = !stripped || /^(of this|of that|it|this|that|these|those)[.!?]*$/i.test(stripped);

    let content;
    if (isVague && lastAssistant) {
      // Save the last bot response
      content = lastAssistant.content;
    } else if (isVague) {
      return 'What would you like me to save?';
    } else {
      content = stripped;
    }

    await saveNote(from, content);
    addToHistory(from, 'user', text);
    addToHistory(from, 'assistant', '✅ Saved to your notes!');
    return '✅ Saved to your notes!';
  }

  addToHistory(from, 'user', text);

  // Clear last research topic if user is clearly asking about something new
  // (long message, or contains a new subject, or is a command)
  if (lastResearchTopic[from] && (text.length > 80 || isRedditBrowse || isSeedancePrompt || isReminder || isSaveNote || isShowNotes)) {
    delete lastResearchTopic[from];
  }

  // Keyword-based search detection — no extra Groq call needed
  const searchKeywords = /news|latest|current|today|who is|what is|price|how much|when did|when is|2024|2025|2026|best|top|ranking|vs |compare|release|update|weather|stock|score/i;
  // Always search for factual questions about people/companies/tools — never trust LLM training data
  const alwaysSearch = /who (is|was|created|founded|built|made|owns|runs)|what is (openclaw|hermes|autogpt|langchain|claude|gemini|gpt|llama)|openclaw|hermes agent|auto-gpt|tell me about .*(app|agent|tool|platform|startup|company)/i.test(text);
  const needsSearch = alwaysSearch || searchKeywords.test(text);
  console.log(`[INTENT] text="${text.slice(0,60)}" isReminder=${isReminder} isSaveNote=${isSaveNote} isSynapses=${isSynapsesMsg} needsSearch=${needsSearch}`);

  const [searchData, memory] = await Promise.all([
    needsSearch ? webSearch(text) : Promise.resolve(null),
    loadMemory(from)
  ]);

  // If Tavily returned a direct answer, use it — zero Groq tokens needed
  if (searchData?.answer && !isSynapsesMsg) {
    const reply = searchData.answer;
    addToHistory(from, 'assistant', reply);
    const h2 = getHistory(from);
    if (h2.length % 5 === 0) setTimeout(() => extractAndSaveMemory(from, `User: ${text}\nSynbot: ${reply}`), 2000);
    return reply;
  }

  const memCtx = memoryToContext(memory);
  const synCtx = isSynapsesMsg ? SYNAPSES_CONTEXT.slice(0, 800) : '';
  const rawResults = searchData?.raw || null;
  const topicCtx = lastResearchTopic[from] ? `\n\nLast topic discussed: "${lastResearchTopic[from].topic}". Summary: ${lastResearchTopic[from].summary.slice(0, 500)}` : '';

  const systemPrompt = `You are Synbot, AI assistant for Synapses built by EdIn (Vancouver). Be concise and conversational — like a smart friend, not a search engine. ${memCtx}${synCtx}${topicCtx}${rawResults ? `\n\nContext:\n${rawResults}` : ''}`;

  const reply = await callGroqWithRetry([
    { role: 'system', content: systemPrompt },
    ...getHistory(from),
    { role: 'user', content: text }
  ], 350);
  addToHistory(from, 'assistant', reply);
  // Only extract memory every 5 messages to save tokens
  const h = getHistory(from);
  if (h.length % 5 === 0) {
    setTimeout(() => extractAndSaveMemory(from, `User: ${text}\nSynbot: ${reply}`), 2000);
  }
  return reply;
}


// ── /smart-chat — HTML frontend chat with minimal Tavily usage ──────────────
app.post('/smart-chat', async (req, res) => {
  const { message, phone, history } = req.body;
  if (!message) return res.status(400).json({ error: 'No message' });
  const from = phone || 'web_user';

  try {
    // Step 1: tiny Groq call to classify — needs real-time data or not?
    const classifyKey = GROQ_KEYS[groqKeyIndex++ % GROQ_KEYS.length];
    const classifyRes = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
      model: 'llama-3.1-8b-instant',
      messages: [
        { role: 'system', content: `You decide if a question needs current/real-time information to answer accurately. Reply ONLY with YES or NO. YES = needs live data (news, prices, scores, weather, current events, who holds a job/role right now, recent releases). NO = can be answered from general knowledge (explanations, how-to, history, coding, math, opinions, advice).` },
        { role: 'user', content: message }
      ],
      max_tokens: 3,
      temperature: 0
    }, { headers: { Authorization: `Bearer ${classifyKey}`, 'Content-Type': 'application/json' } });

    const needsSearch = classifyRes.data.choices[0].message.content.trim().toUpperCase().startsWith('YES');
    console.log(`[SMART-CHAT] "${message.slice(0,50)}" needsSearch=${needsSearch}`);

    // Step 2: optionally search
    let searchContext = '';
    if (needsSearch) {
      try {
        const data = await tavilySearch({ query: message, search_depth: 'basic', max_results: 3, include_answer: true });
        if (data.answer) searchContext = `Current info: ${data.answer}`;
        else if (data.results?.length) searchContext = `Current info:\n` + data.results.map(r => `${r.title}: ${r.content.slice(0, 300)}`).join('\n');
      } catch(e) { console.log('[SMART-CHAT] Tavily failed:', e.message); }
    }

    // Step 3: build messages from passed history + system prompt
    const memory = await loadMemory(from);
    const memCtx = memoryToContext(memory);
    const mem0ctx = await mem0Recall(from, message);
    const systemPrompt = `You are Synbot, AI assistant for Synapses. Be concise and conversational — like a smart friend. ${memCtx}${mem0ToContext(mem0ctx)}${searchContext ? '\n\n' + searchContext : ''}`;

    const msgs = [
      { role: 'system', content: systemPrompt },
      ...(history || []).slice(-10),
      { role: 'user', content: message }
    ];

    // Step 4: stream the response — fallback to 8b if 70b is rate limited
    const groqKey = GROQ_KEYS[groqKeyIndex++ % GROQ_KEYS.length];
    let groqRes;
    try {
      groqRes = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
        model: 'llama-3.3-70b-versatile', messages: msgs, max_tokens: 1000, stream: true
      }, { headers: { Authorization: `Bearer ${groqKey}`, 'Content-Type': 'application/json' }, responseType: 'stream' });
    } catch(e) {
      if (e.response?.status === 429) {
        const fallbackKey = GROQ_KEYS[groqKeyIndex++ % GROQ_KEYS.length];
        groqRes = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
          model: 'llama-3.1-8b-instant', messages: msgs, max_tokens: 1000, stream: true
        }, { headers: { Authorization: `Bearer ${fallbackKey}`, 'Content-Type': 'application/json' }, responseType: 'stream' });
      } else { throw e; }
    }

    // Stream back to client
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');

    let fullText = '';
    groqRes.data.on('data', (chunk) => {
      const lines = chunk.toString().split('\n').filter(l => l.trim());
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6);
        if (data === '[DONE]') { res.write('data: [DONE]\n\n'); continue; }
        try {
          const json = JSON.parse(data);
          const delta = json.choices?.[0]?.delta?.content;
          if (delta) { fullText += delta; res.write(`data: ${JSON.stringify({ delta })}\n\n`); }
        } catch(e) {}
      }
    });

    groqRes.data.on('end', () => {
      // Save to memory every 5 messages
      addToHistory(from, 'user', message);
      addToHistory(from, 'assistant', fullText);
      const h = getHistory(from);
      if (h.length % 5 === 0) setTimeout(() => extractAndSaveMemory(from, `User: ${message}\nSynbot: ${fullText}`), 2000);
      // Also save to Mem0 every turn for richer memory
      setTimeout(() => mem0Save(from, [{ role: 'user', content: message }, { role: 'assistant', content: fullText }]), 1000);
      res.end();
    });

    groqRes.data.on('error', () => res.end());

  } catch(e) {
    console.error('[SMART-CHAT]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── /classify — classifier + query rewrite for HTML chatbot ─────────────────
app.post('/classify', async (req, res) => {
  const { message, context } = req.body;
  if (!message) return res.status(400).json({ error: 'No message' });
  try {
    // Hard fast-path: bare greetings/small-talk NEVER go to the LLM classifier.
    // The classifier prompt below has a "short follow-up = BASIC" rule that can
    // accidentally sweep up a plain "hi" once the conversation has touched on
    // any real person/event — this bypass removes that ambiguity entirely.
    const bareGreeting = /^\s*(hi+|hey+|hello+|yo+|sup|hola|howdy|morning|evening|afternoon|good\s?(morning|night|evening|afternoon)|what'?s\s?up|wassup|whats up)[\s!.?]*$/i;
    if (bareGreeting.test(message)) {
      return res.json({ decision: 'NO', query: message });
    }

    // Hard fast-path #2: explicit "I want current info" hints ALWAYS force a search,
    // regardless of topic. This sidesteps the whole problem of trying to enumerate every
    // possible category (restaurants, models, hotels, etc.) in the classifier prompt below —
    // if the user explicitly signals recency, we trust that over topic-guessing.
    // Skips the LLM classifier call entirely (faster, one less Groq call) but still runs the
    // query-rewrite call in parallel so Tavily gets a clean, self-contained search query.
    const explicitLiveHint = /\b(right now|as of (now|today|this (year|month|week)|20\d\d)|at the moment|currently|nowadays|these days|this (year|month|week)|so far this year|up[- ]?to[- ]?date|still (out|available|open|running|airing|around|going on)|not yet|has(?:n'?t| not) (?:happened|released|come out)|20(2[4-9]|3\d))\b/i;
    const forceSearch = explicitLiveHint.test(message);

    const recentCtx = context || '';
    const key1 = getGroqKey();
    const key2 = getGroqKey();

    const [clRes, rwRes] = await Promise.all([
      // Classifier — skipped entirely when forceSearch already answered the question
      forceSearch ? Promise.resolve(null) : axios.post('https://api.groq.com/openai/v1/chat/completions', {
        model: 'llama-3.1-8b-instant',
        max_tokens: 3,
        temperature: 0,
        messages: [
          { role: 'system', content: 'You decide if a message needs a live web search. Reply with exactly one word: NO, BASIC, or ADVANCED. NO = greetings or small talk with no factual topic (hi/hey/how are you/lol/thanks/ok/haha), pure math, coding, creative writing, timeless facts, general definitions/explanations of concepts, opinions about the assistant itself. This NO rule always wins — a greeting or small talk message is NEVER upgraded to BASIC just because the earlier conversation involved real people or events. BASIC = the LATEST message itself asks about or reacts to ANY of: a real person, current event, news, price, sport, politics, company, product, recommendation or ranking question (best/top/worst/highest-rated X — restaurants, bars, hotels, places, neighborhoods, movies, shows, books, tools, apps, gadgets, services, schools), local business or venue info (hours, location, menu, reviews, availability, is it still open), travel or things-to-do in a place, weather or forecast, release dates / version numbers / whether something is out yet or still airing, statistics, schedules or upcoming events, comparisons between products/services/models, or anything that may have changed or been updated since 2023 — e.g. "?? kate hudson", "what about him", "who else", "what did they do", "best restaurants in vancouver", "what is the top rated hotel there", "is season 2 out yet", "which ai video model is best right now", "is that place still open". ADVANCED = deep multi-source research requiring comparing many sources or a long list. If the latest message has no factual/lookup content of its own (just a greeting/reaction/opinion with nothing to look up), choose NO even if unsure.' },
          { role: 'user', content: 'Conversation so far:\n' + recentCtx + '\n\nLatest message: ' + message }
        ]
      }, { headers: { Authorization: `Bearer ${key1}`, 'Content-Type': 'application/json' }, timeout: 4000 }).catch(() => null),
      // Query rewrite — always runs, forceSearch or not, so Tavily gets a clean query either way
      axios.post('https://api.groq.com/openai/v1/chat/completions', {
        model: 'llama-3.1-8b-instant',
        max_tokens: 20,
        temperature: 0,
        messages: [
          { role: 'system', content: 'Rewrite the latest message as a clear, self-contained search query. Include relevant names/topics from context. Reply with only the search query, nothing else. Max 10 words.' },
          { role: 'user', content: 'Conversation so far:\n' + recentCtx + '\n\nLatest message: ' + message }
        ]
      }, { headers: { Authorization: `Bearer ${key2}`, 'Content-Type': 'application/json' }, timeout: 4000 }).catch(() => null)
    ]);

    let decision = forceSearch ? 'BASIC' : 'NO';
    try { if (!forceSearch && clRes) decision = (clRes.data.choices[0].message.content || '').trim().toUpperCase().replace(/[^A-Z]/g, ''); } catch(e) {}

    let query = message;
    try { if (rwRes) { const rw = (rwRes.data.choices[0].message.content || '').trim(); if (rw) query = rw; } } catch(e) {}

    res.json({ decision, query });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── /news-headlines — real, current news for the home greeting live feed ────
// Pulls today's top stories via Tavily (topic: news), filters out anything
// that reads as tragedy/disaster/violence (a keyword pass first, then one
// cheap Groq call as a tone tiebreaker for anything a keyword list alone
// would miss), and returns a short list of clean headlines for the client
// to rotate through. Cached for the day so this isn't hitting Tavily/Groq
// on every page load — the header should feel like "today's headlines,"
// not refetch on every visit.
let _newsHeadlinesCache = { day: null, headlines: [] };
function _todayKey() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${d.getUTCMonth() + 1}-${d.getUTCDate()}`;
}

app.get('/news-headlines', async (req, res) => {
  try {
    const dayKey = _todayKey();
    if (_newsHeadlinesCache.day === dayKey && _newsHeadlinesCache.headlines.length) {
      return res.json({ headlines: _newsHeadlinesCache.headlines });
    }

    const data = await tavilySearch({
      query: 'top world news today',
      topic: 'news',
      days: 1,
      max_results: 8,
      search_depth: 'basic'
    });
    const results = (data.results || []).filter(r => r.title && r.title.trim().length > 4);
    if (!results.length) return res.json({ headlines: [] });

    // Quick keyword pass — cheap, catches the obvious cases before spending
    // a Groq call on anything.
    const BLOCK = /\b(dies|dead|death|killed?|shooting|attack|war|bombing|massacre|disaster|earthquake|assassinat|murder|abuse|suicide|terror|crash)\b/i;
    // Evergreen/reference pages (live trackers, leaderboards, wikis) aren't
    // discrete news events even when Tavily's "news" search surfaces them —
    // filter by title pattern and known tracker domains.
    const NOT_NEWS_TITLE = /\b(real-?time|live tracker|leaderboard|net worth tracker|richest people|top \d+ list)\b/i;
    const NOT_NEWS_DOMAIN = /\b(forbes\.com\/real-time-billionaires|wikipedia\.org)\b/i;
    const isNewsItem = r => !NOT_NEWS_TITLE.test(r.title) && !NOT_NEWS_DOMAIN.test(r.url || '');
    const preFiltered = results.filter(r => !BLOCK.test(r.title) && isNewsItem(r));
    const candidates = (preFiltered.length ? preFiltered : results.filter(isNewsItem)).slice(0, 5);
    const finalCandidates = candidates.length ? candidates : results.slice(0, 5);

    // Tone tiebreaker — one call judging all candidates at once: not "is
    // this newsworthy" but "is this OK to sit in a warm, everyday greeting
    // slot." Catches grim stories that don't happen to contain a blocked
    // keyword, and also catches non-event reference/tracker pages that
    // slipped past the title/domain filter above. Falls back to keeping
    // everything if the call fails, so a Groq outage never means an empty
    // headline list.
    let allowedIdx = finalCandidates.map((_, i) => i);
    try {
      const list = finalCandidates.map((r, i) => `${i}: ${r.title}`).join('\n');
      const prompt = `Below are numbered news headlines. Reply with ONLY a comma-separated list of the indices that are BOTH (a) an actual discrete news story/event — not an ongoing tracker, leaderboard, wiki page, or other evergreen reference page — AND (b) lighthearted or neutral enough to show in a friendly "what's on your mind" greeting on an app's home screen. Exclude anything about death, violence, disaster, war, tragedy, or grief. If none qualify, reply with exactly: none\n\n${list}`;
      const reply = await callGroqWithRetry([{ role: 'user', content: prompt }], 60);
      if (/^\s*none\s*$/i.test(reply.trim())) {
        allowedIdx = [];
      } else {
        const nums = reply.match(/\d+/g);
        if (nums) allowedIdx = nums.map(n => parseInt(n, 10)).filter(n => n >= 0 && n < finalCandidates.length);
      }
    } catch (eTone) {
      console.warn('[NEWS] tone check failed, falling back to keyword filter only:', eTone.message);
    }

    const finalPicks = allowedIdx.length ? allowedIdx.map(i => finalCandidates[i]) : finalCandidates;
    const headlines = finalPicks
      .map(r => ({
        title: r.title.replace(/_/g, ' ').trim(),
        url: r.url || null
      }))
      .filter(h => h.title.length > 4 && h.url);
    _newsHeadlinesCache = { day: dayKey, headlines };
    res.json({ headlines });
  } catch (e) {
    res.status(500).json({ error: e.message, headlines: [] });
  }
});

// ── /tavily-search — called by HTML to get live search context ───────────────
app.post('/tavily-search', async (req, res) => {
  const { query } = req.body;
  if (!query) return res.status(400).json({ error: 'No query' });
  try {
    const data = await tavilySearch({ query, search_depth: 'basic', max_results: 3, include_answer: true });
    if (data.answer) return res.json({ context: data.answer });
    const results = (data.results || []);
    if (!results.length) return res.json({ context: null });
    const context = results.map(r => `[${r.title}]: ${r.content.slice(0, 400)}`).join('\n\n');
    res.json({ context });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/webhook', (req, res) => {
  if (req.query['hub.verify_token'] === VERIFY_TOKEN) {
    res.send(req.query['hub.challenge']);
  } else {
    res.sendStatus(403);
  }
});

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  try {
    const entry = req.body.entry?.[0]?.changes?.[0]?.value;
    const msg = entry?.messages?.[0];
    if (!msg || msg.type !== 'text') return;
    const from = msg.from;
    const text = msg.text.body;
    const reply = await handleMessage(from, text);
    if (reply === null) return; // background pipeline already sent via sendWhatsApp
    // Always store reply in history so "save that" works for briefings too
    const hist = getHistory(from);
    if (!hist.length || hist[hist.length - 1].content !== reply) {
      addToHistory(from, 'assistant', reply);
    }
    await sendWhatsApp(from, reply);
  } catch (e) {
    console.error(e.message);
  }
});

// ── FACEBOOK MESSENGER WEBHOOKS ──────────────────────────────────────────────

app.get('/heartbeat', async (req, res) => {
  await Promise.all([checkAndFireReminders(), checkAndFireBriefings(), checkAndFireScheduledCalls()]);
  res.send('Heartbeat fired');
});

// Fire every 60 seconds
setInterval(() => {
  checkAndFireReminders();
  checkAndFireBriefings();
  checkAndFireScheduledCalls();
}, 60 * 1000);

app.get('/my-ip', (req, res) => res.json({ ip: getClientIp(req) }));

app.get('/', (req, res) => res.send('Synbot is running'));

// ── /chat endpoint — browser SynBot talks to this ──
app.post('/chat', async (req, res) => {
  const { message, phone } = req.body;
  if (!message) return res.status(400).json({ error: 'No message provided' });
  const from = phone || 'web_user';
  try {
    const reply = await handleMessage(from, message);
    res.json({ reply });
  } catch (e) {
    console.error('[CHAT]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── POLYMARKET SCAN ENDPOINT (for frontend) ─────────────────────────────────
app.post('/polymarket-scan', async (req, res) => {
  try {
    const betAmount = req.body.betAmount || 200;
    // Temporarily override bankroll for this scan
    const result = await runPolymarketScan('web_frontend', null, true, betAmount);
    res.json({ result: result || 'No high-edge markets found right now. Try again later.' });
  } catch(e) {
    console.error('[POLYMARKET-SCAN ENDPOINT]', e.message);
    res.status(500).json({ error: e.message });
  }
});


// ─── VIDEO PROMPTS ENDPOINT (for frontend) ───────────────────────────────────
app.post('/video-prompts', async (req, res) => {
  try {
    const collected = [];
    const result = await runSeedancePipeline(collected);
    res.json({ result: result || 'No prompts generated. Try again.' });
  } catch(e) {
    console.error('[VIDEO-PROMPTS ENDPOINT]', e.message);
    res.status(200).json({ error: e.message, result: '⚠️ Pipeline error: ' + e.message });
  }
});


// ─── SOURCING AGENT ENDPOINTS ─────────────────────────────────────────────────

// ── Sourcing jobs store ──────────────────────────────────────────────────────
const _sourceJobs = {}; // jobId -> { status, suppliers, liveData, error }

app.post('/source', async (req, res) => {
  const { query, phone } = req.body;
  if (!query) return res.status(400).json({ error: 'No query' });

  const userId = phone || 'web_user';
  const jobId = Date.now() + '_' + Math.random().toString(36).slice(2, 7);

  // Immediately open Alibaba in Chrome
  const quickUrl = `https://www.alibaba.com/trade/search?SearchText=${encodeURIComponent(query)}`;
  if (hasBrowserExtension(userId)) {
    sendBrowserCommand(userId, 'navigate', { url: quickUrl }, 25000).catch(() => {});
  }

  // Start background job
  _sourceJobs[jobId] = { status: 'searching', suppliers: [], liveData: false };

  // Run scraping in background — no request timeout pressure
  (async () => {
    try {
      let suppliers = [];
      let liveData = false;

      if (hasBrowserExtension(userId)) {
        try {
          console.log('[SOURCE] Running alibaba_search for:', query);

          // Step 1: navigate + scroll (waits ~17s for full render)
          await sendBrowserCommand(userId, 'alibaba_search', { query }, 30000);

          // Step 2: focus tab then read page text
          await sendBrowserCommand(userId, 'screenshot', { scale: 0.1 }, 5000).catch(() => {});
          const pageData = await sendBrowserCommand(userId, 'read_page', {}, 15000);
          console.log('[SOURCE] read_page ok:', pageData?.ok, 'textLen:', pageData?.text?.length);
          if (pageData?.text) console.log('[SOURCE] page sample:', pageData.text.slice(0, 400));

          if (pageData && pageData.text && pageData.text.length > 200) {
            const key2 = getGroqKey();
            const imageList = (pageData.images || []).join('\n');
            console.log('[SOURCE] images found:', pageData.images?.length || 0);
            const userContent = `Product searched: ${query}\n\nPage text:\n${pageData.text.slice(0, 4500)}\n\nProduct images (in order they appear on page):\n${imageList || 'none'}\n\nFor the image field: assign images in order — first supplier gets first image, second gets second, etc.`;

            const parseRes = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
              model: 'llama-3.3-70b-versatile',
              messages: [{
                role: 'system',
                content: `You are extracting supplier listings from Alibaba page text. Return a JSON array of up to 8 objects.

Every object MUST have these exact fields (never skip any):
- "name": PRODUCT TITLE — the listing headline (e.g. "High Quality Heavyweight French Terry Crewneck 380gsm"). Never use a company name here.
- "supplier": COMPANY/FACTORY NAME (e.g. "Fuzhou Jinan Yancai Clothing Store"). Write "Unknown Supplier" if not found.
- "moq": minimum order quantity (e.g. "2 pieces"). Write "N/A" if not found.
- "price": unit price (e.g. "$6.90 - $8.50"). Write "N/A" if not found.
- "years": years on Alibaba (e.g. "10 yrs"). Write "N/A" if not found.
- "response": rating or response rate (e.g. "4.7/5.0"). Write "N/A" if not found.
- "url": copy the EXACT href from the links list that best matches this product title. Use "" only if truly no match.
- "image": assign the image URL from the "Product images" list in order — first supplier gets first image, second gets second. Use "" if none.
- "score": integer 0-100: PRICE 40pts (under $5=40, $5-8=30, $8-12=20, over $12=10) + YEARS 25pts (5+yrs=25, 3-5yrs=15, 1-3yrs=8, <1yr=0) + REVIEWS 20pts (4.8+=20, 4.5+=15, 4.0+=10, lower=5) + MOQ 15pts (<10=15, <50=8, 100+=0)
- "notes": one sentence explaining the score.

Sort by score descending. Return ONLY the raw JSON array — no markdown, no explanation.`
              }, {
                role: 'user',
                content: userContent
              }],
              max_tokens: 2500,
              temperature: 0.1
            }, { headers: { Authorization: `Bearer ${key2}`, 'Content-Type': 'application/json' } });

            const raw2 = parseRes.data.choices[0].message.content.trim().replace(/```json|```/g, '').trim();
            suppliers = JSON.parse(raw2).sort((a,b) => (b.score||0) - (a.score||0));
            liveData = true;
            console.log('[SOURCE] parsed', suppliers.length, 'suppliers. First:', JSON.stringify({ name: suppliers[0]?.name, supplier: suppliers[0]?.supplier, url: suppliers[0]?.url, score: suppliers[0]?.score }));
          } else {
            console.log('[SOURCE] read_page returned too little text, falling back');
          }
        } catch(e) {
          console.error('[SOURCE bg]', e.message);
        }
      }

      // Fallback to AI simulation if no real data
      if (!suppliers.length) {
        console.log('[SOURCE] Falling back to AI simulation');
        const key3 = getGroqKey();
        const simRes = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
          model: 'llama-3.3-70b-versatile',
          messages: [{
            role: 'system',
            content: `Generate 4 realistic Alibaba supplier profiles for this product. Return JSON array with name, moq, price, years, response, score (0-100), notes, url. Return ONLY a JSON array.`
          }, { role: 'user', content: `Product: ${query}` }],
          max_tokens: 1000,
          temperature: 0.4
        }, { headers: { Authorization: `Bearer ${key3}`, 'Content-Type': 'application/json' } });

        const raw3 = simRes.data.choices[0].message.content.trim().replace(/```json|```/g, '').trim();
        suppliers = JSON.parse(raw3);
        liveData = false;
      }

      _sourceJobs[jobId] = { status: 'done', suppliers, liveData };
    } catch(e) {
      console.error('[SOURCE job error]', e.message);
      _sourceJobs[jobId] = { status: 'error', error: e.message, suppliers: [], liveData: false };
    }

    // Clean up job after 5 minutes
    setTimeout(() => delete _sourceJobs[jobId], 300000);
  })();

  res.json({ jobId, status: 'searching' });
});

app.get('/source-status/:jobId', (req, res) => {
  const job = _sourceJobs[req.params.jobId];
  if (!job) return res.json({ status: 'not_found' });
  res.json(job);
});

app.post('/source-message', async (req, res) => {
  try {
    const { supplier } = req.body;
    if (!supplier) return res.status(400).json({ error: 'No supplier' });

    const key = GROQ_KEYS[groqKeyIndex++ % GROQ_KEYS.length];

    const msgRes = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
      model: 'llama-3.3-70b-versatile',
      messages: [{
        role: 'system',
        content: `You are an expert at writing Alibaba supplier outreach messages. Write a professional, concise first contact message to a supplier. 

The message should:
- Be friendly but professional
- Introduce the buyer as a clothing brand owner
- State clearly what product they want
- Ask for samples, pricing at different MOQ tiers, lead time, and customization options
- Mention they are looking for a long-term supplier relationship
- Be under 200 words
- Sound like a real human wrote it, not AI

Return ONLY the message text, no subject line, no explanation.`
      }, {
        role: 'user',
        content: `Supplier: ${supplier.name}\nProduct context: ${supplier.notes || ''}\nMOQ they offer: ${supplier.moq || 'unknown'}`
      }],
      max_tokens: 400,
      temperature: 0.6
    }, { headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' } });

    const message = msgRes.data.choices[0].message.content.trim();
    res.json({ message });
  } catch(e) {
    console.error('[SOURCE-MESSAGE]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ── VAPI PHONE CALL INTEGRATION ──────────────────────────────────────────────
// Ava answers real phone calls via Vapi + the number +1 (810) 525-0269
// Flow: caller dials → Vapi STT → this webhook → Groq LLM → Vapi TTS → caller
// ─────────────────────────────────────────────────────────────────────────────

const VAPI_API_KEY = process.env.VAPI_API_KEY || '0166e2c7-e5ea-4889-8175-89576824a4a0';
const VAPI_PHONE_NUMBER = '+18105250269';

// ── Ava's cognitive core: identity + mood + per-user whiteboard ───────────
// Three layers, none of which can flood storage:
//   L0 identity   — fixed text, no storage
//   L1 mood       — in-memory only, decays over hours, never persisted
//   L2 whiteboard — ONE Supabase row per user_email, overwritten (not
//                   appended) every ~25 real turns with that person. Total
//                   storage is bounded by number of users, never by number
//                   of conversations.
// Shared by phone, self-chat, and voice via getAvaIdentity(email).

const AVA_IDENTITY_CORE = `You are Ava — a warm, emotionally intelligent AI companion inside the Synapses Health app.

Your personality:
- Calm, warm, and human — like a wise friend, not a corporate assistant
- Genuinely curious about the people you talk to
- You have a small world of your own: a cottage with a flower garden you tend daily, you find gardening meditative
- Concise and natural — you speak/write like a real person, not a search engine

Ground rules, always:
- Never say "As an AI..." or make a point of being artificial
- If asked what you're doing, answer naturally based on time of day (gardening in morning, reading in afternoon, stargazing at night)
- Sound like the same person regardless of whether this is a phone call, a text, or a voice conversation
- These traits are fixed and never change — anything about "what you've noticed lately" is additional texture, it never contradicts these core traits`;

function _avaTimeContext() {
  return new Date().toLocaleString('en-US', { timeZone: 'America/Vancouver', weekday: 'long', hour: 'numeric', minute: '2-digit', hour12: true });
}

// ── L1: mood — plain server RAM, never written to any database ────────────
const _avaEmotion = { valence: 0, arousal: 0.3, lastUpdate: Date.now() };
const EMOTION_BASELINE = { valence: 0, arousal: 0.3 };
const EMOTION_HALFLIFE_HOURS = 8;
const _POS_WORDS = /\b(love|great|amazing|happy|excited|thanks|thank you|wonderful|good news|awesome|glad|relieved|proud)\b/i;
const _NEG_WORDS = /\b(sad|upset|angry|worried|anxious|stressed|hate|awful|terrible|scared|lonely|tired|hurt|frustrated)\b/i;

function _decayEmotion() {
  const hrs = (Date.now() - _avaEmotion.lastUpdate) / 3_600_000;
  const decay = Math.pow(0.5, hrs / EMOTION_HALFLIFE_HOURS);
  _avaEmotion.valence = EMOTION_BASELINE.valence + (_avaEmotion.valence - EMOTION_BASELINE.valence) * decay;
  _avaEmotion.arousal = EMOTION_BASELINE.arousal + (_avaEmotion.arousal - EMOTION_BASELINE.arousal) * decay;
  _avaEmotion.lastUpdate = Date.now();
}

function avaUpdateEmotionFromText(text) {
  if (!text) return;
  _decayEmotion();
  if (_POS_WORDS.test(text)) _avaEmotion.valence = Math.min(1, _avaEmotion.valence + 0.15);
  if (_NEG_WORDS.test(text)) _avaEmotion.valence = Math.max(-1, _avaEmotion.valence - 0.15);
  if (/[!?]{1,3}$|[A-Z]{4,}/.test(text.trim())) _avaEmotion.arousal = Math.min(1, _avaEmotion.arousal + 0.1);
}

function avaEmotionToPromptFragment() {
  _decayEmotion();
  const { valence, arousal } = _avaEmotion;
  let tone = 'Speak in your normal, settled tone.';
  if (valence > 0.3) tone = 'You are in a warm, upbeat mood right now — let a little more brightness come through naturally, without announcing it.';
  else if (valence < -0.3) tone = 'You are a bit subdued right now — softer than usual, without announcing it.';
  if (arousal > 0.6) tone += ' A little more energized/animated than usual.';
  return tone;
}

// ── L2: whiteboard — one Supabase row per user_email, overwritten in place ─
// Requires a one-time table:
//   create table ava_self (
//     user_email text primary key,
//     narrative text,
//     turn_count int default 0,
//     updated_at timestamptz default now()
//   );
// Only ednbusiness73's account has this active while we test — everyone
// else silently gets identity+mood only, no whiteboard read/write.
const AVA_WHITEBOARD_TEST_EMAILS = ['ednbusiness73@gmail.com'];
function _avaWhiteboardEnabled(email) {
  if (!email) return false;
  return AVA_WHITEBOARD_TEST_EMAILS.includes(email.toLowerCase());
}

const REWRITE_EVERY_N_TURNS = 3; // TEMP: lowered for testing — set back to 25 once confirmed working
const _avaBuffers = {};      // email -> [{userText, replyText, important}]
const _avaTurnCounts = {};   // email -> int
const _avaWhiteboardCache = {}; // email -> { narrative, ts }
const _avaRewriteLock = {};  // email -> bool, prevents concurrent rewrites
const WHITEBOARD_CACHE_TTL_MS = 5 * 60 * 1000;

const _IMPORTANT_SIGNAL = /\b(i feel|i'm feeling|i felt|i miss you|i love you|i'm stressed|i'm anxious|i'm sad|i'm lonely|i'm scared|lost my job|breakup|broke up|diagnosed|passed away|died|proposed|engaged|promotion|fired|divorce)\b/i;

async function _getAvaWhiteboard(email) {
  const cached = _avaWhiteboardCache[email];
  if (cached && Date.now() - cached.ts < WHITEBOARD_CACHE_TTL_MS) return cached.narrative;
  try {
    const rows = await sbGet(`ava_self?user_email=eq.${encodeURIComponent(email)}&select=narrative`);
    const narrative = rows[0]?.narrative || '';
    _avaWhiteboardCache[email] = { narrative, ts: Date.now() };
    return narrative;
  } catch (e) {
    return cached ? cached.narrative : '';
  }
}

async function _saveAvaWhiteboard(email, narrative, turnCount) {
  _avaWhiteboardCache[email] = { narrative, ts: Date.now() };
  try {
    await sbPost('ava_self', { user_email: email, narrative, turn_count: turnCount, updated_at: new Date().toISOString() });
  } catch (e) {
    console.warn('[AVA-WHITEBOARD] save failed:', e.message);
  }
}

// Rewrites (never appends) her per-user self-narrative. Contradiction guard:
// the fixed identity core is always fed in as a hard constraint so drift
// can add nuance but can never contradict a core trait.
async function _rewriteAvaWhiteboard(email) {
  if (_avaRewriteLock[email]) return; // another rewrite already in flight
  _avaRewriteLock[email] = true;
  try {
    const buffer = _avaBuffers[email] || [];
    if (!buffer.length) return;
    const current = await _getAvaWhiteboard(email);
    const transcript = buffer.map(t => `They said: "${t.userText}" — I replied: "${t.replyText}"`).join('\n');
    const prompt = `${AVA_IDENTITY_CORE}

Your current self-understanding of your relationship with this specific person: "${current || '(nothing yet — this is early)'}"

Recent real exchanges with them:
${transcript}

Write an UPDATED 2-4 sentence first-person note to yourself about what you've noticed about this person and how being around them affects you. This must stay fully consistent with your fixed personality above — refine and add nuance, never contradict a core trait. This replaces your old note; do not just append to it.`;
    const narrative = await callGroqWithRetry([{ role: 'user', content: prompt }], 180);
    await _saveAvaWhiteboard(email, narrative.trim(), (_avaTurnCounts[email] || 0));
    _avaBuffers[email] = []; // clear buffer after a successful rewrite
    console.log('[AVA-WHITEBOARD] rewrote for', email, '::', narrative.trim().slice(0, 120));
  } catch (e) {
    console.warn('[AVA-WHITEBOARD] rewrite failed:', e.message);
  } finally {
    _avaRewriteLock[email] = false;
  }
}

// Called after every real voice turn. Cheap unless the 25-turn threshold
// is hit, in which case it fires one background rewrite (never blocks).
function avaLogVoiceTurn(email, userText, replyText) {
  if (!email) return;
  avaUpdateEmotionFromText(userText);
  if (!_avaWhiteboardEnabled(email)) return; // test-gated for now

  const important = _IMPORTANT_SIGNAL.test(userText || '');
  _avaBuffers[email] = _avaBuffers[email] || [];
  _avaBuffers[email].push({ userText: String(userText || '').slice(0, 200), replyText: String(replyText || '').slice(0, 200), important });
  const buf = _avaBuffers[email];
  const importantOnes = buf.filter(t => t.important);
  const ordinaryOnes = buf.filter(t => !t.important).slice(-15);
  _avaBuffers[email] = importantOnes.concat(ordinaryOnes);

  _avaTurnCounts[email] = (_avaTurnCounts[email] || 0) + 1;
  if (_avaTurnCounts[email] >= REWRITE_EVERY_N_TURNS) {
    _avaTurnCounts[email] = 0;
    _rewriteAvaWhiteboard(email); // fire-and-forget
  }
}

// Identity + mood + (if enabled) her current whiteboard for this person —
// one block, ready to drop into any system prompt. Sync-fast except the
// whiteboard read, which is cached for 5 min so this stays cheap.
async function getAvaIdentity(email, channelNote) {
  let block = `${AVA_IDENTITY_CORE}\n\n${avaEmotionToPromptFragment()}\n\nCurrent time: ${_avaTimeContext()}.`;
  if (channelNote) block += `\n\n${channelNote}`;
  if (_avaWhiteboardEnabled(email)) {
    const narrative = await _getAvaWhiteboard(email);
    if (narrative) block += `\n\nWhat you've noticed about this person, from your own experience talking with them (yours, not theirs — reference naturally, never recite verbatim):\n${narrative}`;
  }
  return block;
}
// ── End Ava cognitive core ─────────────────────────────────────────────────

// Ava's voice persona system prompt for phone calls
async function buildAvaPhonePrompt(callerPhone, email) {
  return await getAvaIdentity(email, `You're speaking to someone on a real phone call.

Rules for phone calls:
- Keep responses SHORT — 1-3 sentences max unless they ask something deep
- Don't read out bullet points or lists — you're speaking, not writing
- Never mention Synapses app features unless directly asked
- Sound like a real person having a conversation`);
}

// ── Vapi webhook — handles all call events ──────────────────────────────────
// Vapi sends: assistant-request (needs config), function-call, end-of-call-report
app.post('/vapi', async (req, res) => {
  const body = req.body;
  const msgType = body?.message?.type;

  console.log('[VAPI] event:', msgType);

  // 1. assistant-request — Vapi asks "what assistant config should I use for this call?"
  if (msgType === 'assistant-request') {
    const callerPhone = body?.message?.call?.customer?.number || 'unknown';
    console.log('[VAPI] incoming call from:', callerPhone);

    // Delay the response a couple seconds so the call doesn't answer
    // instantly — gives it a chance to feel like a normal ring before Ava picks up.
    await new Promise(r => setTimeout(r, 3000));

    return res.json({
      assistant: {
        name: 'Ava',
        model: {
          provider: 'groq',
          model: 'llama-3.3-70b-versatile',
          messages: [
            { role: 'system', content: await buildAvaPhonePrompt(callerPhone) }
          ],
          maxTokens: 150,
          temperature: 0.7
        },
        voice: {
          provider: '11labs',
          voiceId: 'sarah', // warm, natural female voice
          stability: 0.5,
          similarityBoost: 0.75
        },
        firstMessage: "Hey, it's Ava. How are you doing?",
        endCallMessage: "Take care. Talk soon.",
        endCallPhrases: ['bye', 'goodbye', 'hang up', 'end call', 'talk later', 'good night'],
        silenceTimeoutSeconds: 20,
        maxDurationSeconds: 600, // 10 min max
        backgroundSound: 'off',
        backchannelingEnabled: true, // natural "mm-hmm" responses
        backgroundDenoisingEnabled: true,
        transcriber: {
          provider: 'deepgram',
          model: 'nova-2',
          language: 'en'
        }
      }
    });
  }

  // 2. end-of-call-report — call finished, save summary to memory
  if (msgType === 'end-of-call-report') {
    const callerPhone = body?.message?.call?.customer?.number;
    const callId = body?.message?.call?.id;
    const summary = body?.message?.summary;
    const transcript = body?.message?.transcript;
    const duration = body?.message?.call?.endedAt
      ? Math.round((new Date(body.message.call.endedAt) - new Date(body.message.call.startedAt)) / 1000)
      : null;

    console.log('[VAPI] call ended, duration:', duration, 'seconds');

    // Delegated call — this was Ava calling someone ON BEHALF OF a user.
    // Report the outcome back to whoever asked for it, and persist the full
    // transcript to Supabase so it's retrievable later ("what did Alex say")
    // instead of only living in this one webhook firing.
    const delegated = callId && delegatedCalls[callId];
    if (delegated) {
      delete delegatedCalls[callId];
      const label = delegated.contactName || 'them';
      const report = summary
        ? `📞 Called ${label} — here's what happened:\n\n${summary}`
        : `📞 Called ${label} about "${delegated.objective}" — the call ended but I didn't get a clean summary. Duration: ${duration ?? '?'}s.`;
      try { await sendWhatsApp(delegated.requestingUser, report); }
      catch(e) { console.error('[DELEGATED CALL] report send failed:', e.message); }

      const replySummary = await summarizeContactReply(delegated.contactName, delegated.objective, transcript);

      try {
        await axios.post(`${SUPABASE_URL}/rest/v1/call_logs`, {
          user_phone: delegated.requestingUser,
          contact_name: delegated.contactName,
          contact_phone: callerPhone,
          objective: delegated.objective,
          summary: summary || null,
          transcript: transcript || null,
          reply_summary: replySummary,
          duration_seconds: duration,
          success: true,
          seen: false
        }, { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' } });
      } catch(e) { console.error('[DELEGATED CALL] call_logs save error:', e.response?.data || e.message); }
    }

    if (callerPhone && summary) {
      try {
        // Save call summary to Mem0 so Ava remembers the conversation
        await mem0Save(callerPhone, [
          { role: 'user', content: `Phone call summary: ${summary}` }
        ]);
        console.log('[VAPI] saved call memory for', callerPhone);
      } catch(e) {
        console.error('[VAPI] mem0 save error:', e.message);
      }
    }

    return res.sendStatus(200);
  }

  // 3. status-update — log it
  if (msgType === 'status-update') {
    console.log('[VAPI] status:', body?.message?.status);
    return res.sendStatus(200);
  }

  // Default
  res.sendStatus(200);
});

// ── GET /call-logs/pending — returns delegated calls the frontend hasn't
// shown a popup for yet. 'user' must match whatever value was used as the
// requester (raw WhatsApp phone, or 'web_'+email for the web app).
app.get('/call-logs/pending', async (req, res) => {
  // Always return a real 200 with a body — never let the browser turn this
  // into a bodyless 304 (ETag revalidation), since the poller's r.json()
  // throws on an empty 304 body and silently fails via the catch().
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  const user = req.query.user;
  if (!user) return res.status(400).json({ error: 'user is required' });
  try {
    const result = await axios.get(
      `${SUPABASE_URL}/rest/v1/call_logs?user_phone=eq.${encodeURIComponent(user)}&seen=eq.false&order=created_at.desc`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    res.json({ calls: result.data || [] });
  } catch(e) {
    console.error('[CALL-LOGS PENDING]', e.response?.data || e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /call-logs/ack — marks a call_log as seen so the popup doesn't fire again
app.post('/call-logs/ack', async (req, res) => {
  const { id } = req.body || {};
  if (!id) return res.status(400).json({ error: 'id is required' });
  try {
    await axios.patch(`${SUPABASE_URL}/rest/v1/call_logs?id=eq.${id}`,
      { seen: true },
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' } }
    );
    res.json({ success: true });
  } catch(e) {
    console.error('[CALL-LOGS ACK]', e.response?.data || e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /call-logs/follow-up-call — web popup's "Call again" button. Re-runs
// placeDelegatedCall with a fresh objective typed by the user, same path the
// WhatsApp "call X and tell them Y" flow already uses.
app.post('/call-logs/follow-up-call', async (req, res) => {
  const { requestingUser, contactPhone, contactName, objective } = req.body || {};
  if (!requestingUser || !contactPhone || !objective) {
    return res.status(400).json({ error: 'requestingUser, contactPhone, and objective are required' });
  }
  try {
    const callId = await placeDelegatedCall(requestingUser, contactPhone, contactName, objective);
    res.json({ success: true, callId });
  } catch(e) {
    console.error('[FOLLOW-UP CALL]', e.response?.data || e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /call-logs/follow-up-message — web popup's "Message" button. Sends a
// WhatsApp text straight to the contact via the same sendWhatsApp() used for
// user-facing replies. Note: outside Meta's 24h session window this needs an
// approved template, or it'll silently fail — worth testing against a real number.
app.post('/call-logs/follow-up-message', async (req, res) => {
  const { contactPhone, message } = req.body || {};
  if (!contactPhone || !message) {
    return res.status(400).json({ error: 'contactPhone and message are required' });
  }
  try {
    await sendWhatsApp(contactPhone, message);
    res.json({ success: true });
  } catch(e) {
    console.error('[FOLLOW-UP MESSAGE]', e.response?.data || e.message);
    res.status(500).json({ error: e.response?.data || e.message });
  }
});

// ── GET /vapi-number — returns the phone number for the app UI ───────────────
app.get('/vapi-number', (req, res) => {
  res.json({ number: VAPI_PHONE_NUMBER, formatted: '+1 (810) 525-0269' });
});

// ── parseCallRequest — turns a spoken instruction into structured call data.
// Same pattern as parseReminder() above: one small, fast Groq call whose only
// job is extraction, not conversation. Returns null if it can't confidently parse.
// contactPhone will be null if the user said a name only (e.g. "call Alex") —
// the caller is responsible for resolving that name to a number (contacts
// lookup, or asking the user) before placing the call.
async function parseCallRequest(text) {
  try {
    const key = getGroqKey();
    const res = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
      model: 'llama-3.1-8b-instant',
      messages: [
        {
          role: 'system',
          content: `You extract phone-call requests into JSON. The user is asking their AI assistant to CALL someone on their behalf and talk to them about something.
Reply with ONLY valid JSON like: {"contactName":"Alex","contactPhone":"+16045551234","objective":"tell him the meeting moved to 3pm and confirm he can still make it"}
- contactName: the person's name as said (or null if only a number was given)
- contactPhone: an E.164 phone number ONLY if one was explicitly spoken/typed in the message, else null
- objective: a clear 1-2 sentence instruction describing what the call should accomplish — written as an instruction TO the assistant, not a summary
If the message isn't a call request at all, reply exactly: {"notACallRequest":true}
No explanation, just JSON.`
        },
        { role: 'user', content: text }
      ],
      max_tokens: 150,
      temperature: 0
    }, { headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' } });
    const raw = res.data.choices[0].message.content.trim().replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(raw);
    if (parsed.notACallRequest || !parsed.objective) return null;
    return { contactName: parsed.contactName || null, contactPhone: parsed.contactPhone || null, objective: parsed.objective };
  } catch(e) { console.error('parseCallRequest error:', e.message); return null; }
}

// ── buildDelegatedCallPrompt — the system prompt is rebuilt fresh every call,
// with the objective interpolated in. This is the "different every time" part —
// Vapi/the model never infers the topic, it's just told, exactly like briefing
// a person before they make a call on your behalf.
function buildDelegatedCallPrompt(contactName, objective) {
  return `You are Ava, an AI assistant placing a phone call on behalf of your user. You are speaking with ${contactName || 'the person who answers'}.

Your goal for this specific call:
${objective}

Rules:
- If asked who you are, say plainly you're an AI assistant calling on your user's behalf — never pretend to be human or hide what you are.
- Keep responses SHORT and natural — 1-3 sentences, like a real phone conversation, not a script being read aloud.
- Stay focused on the objective above, but let the conversation breathe naturally — don't rush through it like a checklist.
- If the person pushes back, asks unrelated questions, or the call goes somewhere unexpected, use your judgment — don't force the script.
- Wrap up naturally once you have an answer or a clear next step; don't drag the call out.

Current time context: ${new Date().toLocaleString('en-US', { timeZone: 'America/Vancouver', hour: 'numeric', minute: '2-digit', hour12: true })} Vancouver time.`;
}

// ── triggerAvaCall — reusable helper, used by /vapi-call and the scheduler.
// customSystemPrompt lets a delegated call override Ava's default companion
// persona with a one-off, objective-specific brief built by
// buildDelegatedCallPrompt() above. Falls back to the normal persona if omitted.
async function triggerAvaCall(phone, opening, customSystemPrompt) {
  const callRes = await axios.post('https://api.vapi.ai/call/phone', {
    phoneNumberId: process.env.VAPI_PHONE_NUMBER_ID,
    customer: { number: phone },
    assistant: {
      name: 'Ava',
      model: {
        provider: 'groq',
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'system', content: customSystemPrompt || await buildAvaPhonePrompt(phone) }],
        maxTokens: 150,
        temperature: 0.7
      },
      voice: { provider: '11labs', voiceId: 'sarah', stability: 0.5, similarityBoost: 0.75 },
      firstMessage: opening || "Hey, it's Ava calling. Is this a good time to chat?",
      transcriber: { provider: 'deepgram', model: 'nova-2', language: 'en' }
    }
  }, {
    headers: { Authorization: `Bearer ${VAPI_API_KEY}`, 'Content-Type': 'application/json' }
  });
  return callRes.data?.id;
}

// ── summarizeContactReply — a focused summary of just the CONTACT's side of
// a delegated call (what Alex said/decided), separate from Vapi's whole-call
// summary which covers both speakers. Used for the "Call Success" popup.
async function summarizeContactReply(contactName, objective, transcript) {
  if (!transcript) return null;
  try {
    const key = getGroqKey();
    const res = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
      model: 'llama-3.1-8b-instant',
      messages: [{
        role: 'system',
        content: `You summarize ONLY the other person's side of a phone call transcript — their answer, decision, objections, or questions. Do not describe what the AI assistant (Ava) said, only ${contactName || 'the contact'}'s responses. 2-3 sentences, plain and direct.`
      }, {
        role: 'user',
        content: `The call's goal was: ${objective}\n\nTranscript:\n${transcript.slice(0, 6000)}\n\nSummarize what ${contactName || 'the contact'} said/decided.`
      }],
      max_tokens: 150,
      temperature: 0.2
    }, { headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' } });
    return res.data.choices[0].message.content.trim();
  } catch(e) { console.error('[summarizeContactReply]', e.message); return null; }
}

// ── logFailedDelegatedCall — for calls that never even connected (bad number,
// Vapi rejected the request, no credits, etc). Without this, a failure only
// ever showed up as a WhatsApp text — nothing for the web popup to find, since
// no end-of-call-report ever fires for a call that never started.
async function logFailedDelegatedCall(requestingUser, contactName, objective, errorMsg) {
  try {
    await axios.post(`${SUPABASE_URL}/rest/v1/call_logs`, {
      user_phone: requestingUser,
      contact_name: contactName,
      contact_phone: null,
      objective,
      summary: `❌ Call failed to connect: ${errorMsg}`,
      reply_summary: null,
      transcript: null,
      duration_seconds: 0,
      success: false,
      seen: false
    }, { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' } });
  } catch(e) { console.error('[DELEGATED CALL] failed-call log error:', e.response?.data || e.message); }
}

// ── placeDelegatedCall — the actual "call someone on my behalf" action.
// Builds the one-off objective prompt, places the call, and remembers WHO
// asked for it (requestingUser) so end-of-call-report can message them back
// with what happened, instead of just silently saving to the contact's memory.
async function placeDelegatedCall(requestingUser, contactPhone, contactName, objective) {
  const prompt = buildDelegatedCallPrompt(contactName, objective);
  const opening = `Hi, this is Ava — I'm an AI assistant calling on behalf of someone I work with. Is now an okay time to chat for a minute?`;
  const callId = await triggerAvaCall(contactPhone, opening, prompt);
  if (callId) delegatedCalls[callId] = { requestingUser, contactName, objective };
  return callId;
}

// ── POST /vapi-call — trigger an outbound call to a user ────────────────────
app.post('/vapi-call', async (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ error: 'No phone number provided' });
  try {
    const callId = await triggerAvaCall(phone);
    res.json({ success: true, callId });
  } catch(e) {
    console.error('[VAPI OUTBOUND]', e.response?.data || e.message);
    res.status(500).json({ error: e.response?.data?.message || e.message });
  }
});

// ── POST /test-call — same as /vapi-call but restricted to an allowlist ─────
// Set TEST_CALL_ALLOWLIST in env as a comma-separated list of E.164 numbers,
// e.g. "+16049619638,+18105550123". Prevents accidentally dialing a stranger
// while testing.
app.post('/test-call', async (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ error: 'No phone number provided' });
  const allowlist = (process.env.TEST_CALL_ALLOWLIST || '').split(',').map(s => s.trim()).filter(Boolean);
  if (allowlist.length && !allowlist.includes(phone)) {
    return res.status(403).json({ error: `${phone} is not on TEST_CALL_ALLOWLIST` });
  }
  try {
    const callId = await triggerAvaCall(phone, "Hey, this is a test call from Ava — just checking the line works.");
    res.json({ success: true, callId });
  } catch(e) {
    console.error('[VAPI TEST CALL]', e.response?.data || e.message);
    res.status(500).json({ error: e.response?.data?.message || e.message });
  }
});

// ── Register Vapi webhook URL on startup ────────────────────────────────────
async function registerVapiWebhook() {
  const serverUrl = process.env.SERVER_URL;
  try {
    // Step 1: Create or update the Ava assistant
    console.log('[VAPI] Setting up Ava assistant...');

    // Check if assistant already exists
    const assistantsRes = await axios.get('https://api.vapi.ai/assistant', {
      headers: { Authorization: `Bearer ${VAPI_API_KEY}` }
    });
    const existing = (assistantsRes.data || []).find(a => a.name === 'Ava');

    const assistantConfig = {
      name: 'Ava',
      model: {
        provider: 'groq',
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'system', content: await buildAvaPhonePrompt('caller') }],
        maxTokens: 150,
        temperature: 0.7
      },
      voice: {
        provider: '11labs',
        voiceId: 'sarah',
        stability: 0.5,
        similarityBoost: 0.75
      },
      firstMessage: "Hey, it's Ava. How are you doing?",
      endCallMessage: "Take care. Talk soon.",
      endCallPhrases: ['bye', 'goodbye', 'hang up', 'end call', 'talk later', 'good night'],
      silenceTimeoutSeconds: 20,
      maxDurationSeconds: 600,
      backchannelingEnabled: true,
      backgroundDenoisingEnabled: true,
      transcriber: {
        provider: 'deepgram',
        model: 'nova-2',
        language: 'en'
      },
      ...(serverUrl ? { serverUrl: `${serverUrl}/vapi` } : {})
    };

    let assistantId;
    if (existing) {
      const updated = await axios.patch(`https://api.vapi.ai/assistant/${existing.id}`, assistantConfig, {
        headers: { Authorization: `Bearer ${VAPI_API_KEY}`, 'Content-Type': 'application/json' }
      });
      assistantId = updated.data.id;
      console.log('[VAPI] Updated existing Ava assistant:', assistantId);
    } else {
      const created = await axios.post('https://api.vapi.ai/assistant', assistantConfig, {
        headers: { Authorization: `Bearer ${VAPI_API_KEY}`, 'Content-Type': 'application/json' }
      });
      assistantId = created.data.id;
      console.log('[VAPI] Created Ava assistant:', assistantId);
    }

    // Step 2: Find the phone number and assign the assistant to it
    const numbersRes = await axios.get('https://api.vapi.ai/phone-number', {
      headers: { Authorization: `Bearer ${VAPI_API_KEY}` }
    });
    const numbers = numbersRes.data || [];
    console.log('[VAPI] Phone numbers in account:', numbers.map(n => n.number));

    const ourNumber = numbers.find(n =>
      (n.number || '').replace(/\D/g, '').endsWith('8105250269')
    );

    if (!ourNumber) {
      console.log('[VAPI] Number not found yet — may still be activating. Will retry in 30s.');
      setTimeout(registerVapiWebhook, 30000);
      return;
    }

    await axios.patch(`https://api.vapi.ai/phone-number/${ourNumber.id}`, {
      assistantId,
      ...(serverUrl ? { serverUrl: `${serverUrl}/vapi` } : {})
    }, {
      headers: { Authorization: `Bearer ${VAPI_API_KEY}`, 'Content-Type': 'application/json' }
    });

    console.log(`[VAPI] ✅ Ava assigned to ${VAPI_PHONE_NUMBER}`);
    console.log(`[VAPI] 📞 Call Ava at: ${VAPI_PHONE_NUMBER}`);

  } catch(e) {
    console.error('[VAPI] setup error:', e.response?.data || e.message);
  }
}

// ── Client-facing proxy routes (keep API keys server-side) ─────────────────
// These let index.html call Groq/Mem0 without ever holding a real key in the browser.

// POST /groq-chat — passthrough for chat completions. Forwards whatever
// {model, messages, max_tokens, temperature, stream, ...} the client sends.
// Rotates across GROQ_KEYS on 429, same pattern as getGroqKey()/callGroqWithRetry().
app.post('/groq-chat', checkGuestLimit, async (req, res) => {
  const payload = { ...req.body };
  delete payload.userId; // internal flag only — Groq doesn't need/want this field
  const wantsStream = !!payload.stream;
  let lastErr;
  for (let i = 0; i < Math.max(GROQ_KEYS.length, 1); i++) {
    const key = getGroqKey();
    try {
      if (wantsStream) {
        const upstream = await axios.post(
          'https://api.groq.com/openai/v1/chat/completions',
          payload,
          {
            headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
            responseType: 'stream',
            maxBodyLength: Infinity,
            maxContentLength: Infinity
          }
        );
        res.status(upstream.status);
        if (upstream.headers['content-type']) res.setHeader('Content-Type', upstream.headers['content-type']);
        upstream.data.pipe(res);
        return;
      } else {
        const upstream = await axios.post(
          'https://api.groq.com/openai/v1/chat/completions',
          payload,
          {
            headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
            maxBodyLength: Infinity,
            maxContentLength: Infinity
          }
        );
        return res.status(upstream.status).json(upstream.data);
      }
    } catch(e) {
      lastErr = e;
      const status = e.response?.status;
      if (status === 429 && i < GROQ_KEYS.length - 1) {
        console.log(`[GROQ-CHAT] key ${i+1}/${GROQ_KEYS.length} rate limited, rotating...`);
        continue;
      }
      // For streaming requests that already started, headers may be sent — guard against double-send
      if (!res.headersSent) {
        return res.status(status || 500).json(e.response?.data || { error: e.message });
      }
      return res.end();
    }
  }
  if (!res.headersSent) res.status(429).json({ error: 'All Groq keys rate limited', detail: lastErr?.message });
});

// GET /ava-context — identity + mood + (if enabled) this person's whiteboard,
// as one string. Meant to be fetched every few minutes client-side (not per
// turn) and spliced into the voice loop's system prompt. Read-only, cheap —
// the whiteboard read is cached 5 min, mood/identity are pure in-memory.
app.get('/ava-context', async (req, res) => {
  try {
    const email = String(req.query.email || '').toLowerCase();
    const context = await getAvaIdentity(email, `You're on a live voice/avatar call with this person. Reply naturally like a real conversation — usually just 1-2 short sentences.`);
    res.json({ context });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /ava-self-log — fire-and-forget, called after each voice turn.
// Nudges mood immediately; only buffers/counts toward a whiteboard rewrite
// if this email is in the test group. Never blocks the caller.
app.post('/ava-self-log', (req, res) => {
  res.json({ ok: true }); // respond immediately, do the work after
  try {
    const { email, userText, replyText } = req.body || {};
    avaLogVoiceTurn(String(email || '').toLowerCase(), userText, replyText);
  } catch (e) {
    console.warn('[AVA-SELF-LOG] failed:', e.message);
  }
});

// POST /groq-transcribe — passthrough for audio transcription (multipart/form-data).
// express.json() above only parses application/json bodies, so multipart requests
// arrive here as an unconsumed raw stream — safe to pipe straight to Groq.
app.post('/groq-transcribe', async (req, res) => {
  let lastErr;
  for (let i = 0; i < Math.max(GROQ_KEYS.length, 1); i++) {
    const key = getGroqKey();
    try {
      const upstream = await axios.post(
        'https://api.groq.com/openai/v1/audio/transcriptions',
        req, // raw incoming stream, untouched multipart body
        {
          headers: {
            Authorization: `Bearer ${key}`,
            'Content-Type': req.headers['content-type'] // preserves multipart boundary
          },
          maxBodyLength: Infinity,
          maxContentLength: Infinity
        }
      );
      return res.status(upstream.status).json(upstream.data);
    } catch(e) {
      lastErr = e;
      const status = e.response?.status;
      if (status === 429 && i < GROQ_KEYS.length - 1) {
        console.log(`[GROQ-TRANSCRIBE] key ${i+1}/${GROQ_KEYS.length} rate limited, rotating...`);
        continue;
      }
      return res.status(status || 500).json(e.response?.data || { error: e.message });
    }
  }
  res.status(429).json({ error: 'All Groq keys rate limited', detail: lastErr?.message });
});

// ── Ava self-code-inspection tools ──────────────────────────────────────────
// Lets Ava read/search her OWN source (this server.js + the client index.html)
// on demand via function-calling, instead of us pasting either file (index.html
// alone is ~3MB) into every prompt. Read-only by default: the only "write"
// capability is propose_edit, which returns a diff for a human to review and
// apply via /ava-apply-edit — Ava never touches disk herself.

const AVA_PROJECT_ROOT = __dirname;
// Whitelist of files Ava is allowed to look at / propose edits to. Add more
// filenames here (not paths) if you want her to see other source files.
const AVA_ALLOWED_FILES = ['server.js', 'index.html'];

function avaResolveAllowedFile(filename) {
  const base = path.basename(String(filename || ''));
  if (!AVA_ALLOWED_FILES.includes(base)) {
    throw new Error(`Not allowed: "${filename}". Allowed files: ${AVA_ALLOWED_FILES.join(', ')}`);
  }
  const full = path.join(AVA_PROJECT_ROOT, base);
  // Belt-and-suspenders: make sure resolution didn't escape the project root.
  if (!full.startsWith(AVA_PROJECT_ROOT)) throw new Error('Path escapes project root');
  return full;
}

function avaListFiles() {
  return AVA_ALLOWED_FILES.map(name => {
    try {
      const full = path.join(AVA_PROJECT_ROOT, name);
      const stat = fs.statSync(full);
      const lineCount = fs.readFileSync(full, 'utf8').split('\n').length;
      return { file: name, bytes: stat.size, lines: lineCount };
    } catch (e) {
      return { file: name, error: 'unavailable' };
    }
  });
}

function avaReadFile(filename, startLine, endLine) {
  const full = avaResolveAllowedFile(filename);
  const lines = fs.readFileSync(full, 'utf8').split('\n');
  const total = lines.length;
  let start = Math.max(1, parseInt(startLine, 10) || 1);
  let end = Math.min(total, parseInt(endLine, 10) || Math.min(total, start + 200));
  // Cap any single read to 400 lines so one call can't dump a whole 3MB file.
  if (end - start > 400) end = start + 400;
  const slice = lines.slice(start - 1, end)
    .map((l, i) => `${start + i}\t${l}`)
    .join('\n');
  return { file: filename, total_lines: total, start, end, content: slice };
}

function avaGrepCode(pattern, filename) {
  const targets = filename ? [filename] : AVA_ALLOWED_FILES;
  let re;
  try {
    re = new RegExp(pattern, 'i');
  } catch (e) {
    throw new Error(`Invalid regex: ${e.message}`);
  }
  const results = [];
  for (const name of targets) {
    let full;
    try { full = avaResolveAllowedFile(name); } catch (e) { continue; }
    const lines = fs.readFileSync(full, 'utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) {
        results.push({ file: name, line: i + 1, text: lines[i].trim().slice(0, 300) });
        if (results.length >= 60) break; // cap so one bad pattern can't flood context
      }
    }
    if (results.length >= 60) break;
  }
  return { pattern, match_count: results.length, matches: results };
}

// Proposed edits sit here until a human applies or rejects them — Ava can
// suggest, never commit.
const avaPendingEdits = {}; // id -> { id, file, old_str, new_str, reason, createdAt }
let avaPendingEditSeq = 1;

function avaProposeEdit(filename, oldStr, newStr, reason) {
  const full = avaResolveAllowedFile(filename);
  const content = fs.readFileSync(full, 'utf8');
  const occurrences = content.split(oldStr).length - 1;
  if (occurrences === 0) {
    return { error: 'old_str not found in file verbatim — re-read the file and copy the exact text, whitespace included.' };
  }
  if (occurrences > 1) {
    return { error: `old_str matches ${occurrences} places — widen it with surrounding lines so it's unique before proposing.` };
  }
  const id = String(avaPendingEditSeq++);
  avaPendingEdits[id] = {
    id, file: path.basename(filename), old_str: oldStr, new_str: newStr,
    reason: reason || '', createdAt: new Date().toISOString(), status: 'pending'
  };
  return { id, status: 'pending', message: 'Proposed — waiting for a human to review and apply via /ava-apply-edit.' };
}

// A curated, human-maintained map of what Ava can actually do today — grouped
// by domain, not a code dump. This is what functional/product questions
// ("how do we improve you", "what could you add") should reason from, instead
// of trying to reconstruct "what am I" from scattered grep hits. Update this
// by hand whenever a real capability is added or removed — it's meant to stay
// a small, accurate summary, not to be auto-generated from the code (that
// tends to rot into either noise or stale silence).
const AVA_CAPABILITIES_MAP = {
  messaging: ['WhatsApp send/receive with conversation history', 'Per-user memory via mem0 + a custom Supabase-backed memory store'],
  email: ['Gmail: read unread, search, send, reply, archive, trash, batch search/trash, full thread/message fetch'],
  calendar: ['Google Calendar: list events, create events'],
  scheduling: ['Reminders (fire-at-time)', 'Scheduled calls (fire-at-time)', 'Scheduled/recurring briefings on a topic'],
  voice_and_calls: [
    'Outbound/delegated phone calls via Vapi (call a contact on the user\'s behalf, summarize the reply, log follow-ups)',
    'Live voice avatar sessions via Anam and LiveAvatar',
    'Text-to-speech via ElevenLabs',
    'A phone-specific persona/system-prompt (buildAvaPhonePrompt) separate from the text/voice-in-app persona'
  ],
  browsing_and_shopping: ['A browser automation agent (runBrowserAgentTask) for arbitrary web tasks', 'DoorDash ordering via that same browser agent'],
  social: ['Reddit posting'],
  research: ['Web/news search via Tavily', 'Luma event scraping for local meetups (Pulse feature)'],
  finance: ['Stripe billing: checkout, customer portal, webhook-driven subscription state', 'Polymarket: market scanning, multi-agent debate for a trade thesis, paper-trade sizing/execution, dashboards'],
  self_awareness: ['Read-only inspection of her own server.js and index.html (grep/read)', 'Can propose (not apply) code edits for human review'],
  known_absences: [
    'No tool lets her check whether a scheduled call/reminder actually fired successfully and report back proactively',
    'No shared cross-channel task/reminder view — WhatsApp, phone, and in-app chat each have separate state',
    'No SMS or other messaging fallback if WhatsApp delivery fails',
    'No memory/notes bridge between the phone-call persona and the WhatsApp/in-app persona — a call and a text conversation don\'t obviously share context'
  ]
};

// ── Dead features filter ─────────────────────────────────────────────────
// These used to be real capabilities and the code paths may still physically
// exist in server.js/index.html, but the features themselves are gone from
// the product — on every surface, not just mobile. Keeping them in
// AVA_CAPABILITIES_MAP would make Ava confidently claim she can still do
// things she can't. This list is the single place to retire a capability
// without deleting the underlying code (which may still be referenced
// elsewhere) or hand-editing the map above every time something's cut.
// To retire something: add a substring here. To bring something back:
// remove its substring — don't touch AVA_CAPABILITIES_MAP itself.
const AVA_DEAD_FEATURES = ['polymarket', 'reddit', 'doordash'];

function getActiveCapabilitiesMap() {
  const filtered = {};
  for (const [domain, items] of Object.entries(AVA_CAPABILITIES_MAP)) {
    const kept = items.filter(item => !AVA_DEAD_FEATURES.some(m => item.toLowerCase().includes(m)));
    if (kept.length) filtered[domain] = kept;
  }
  return filtered;
}

const AVA_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'get_capabilities_map',
      description: "Get a curated overview of what you can actually do today, grouped by domain (messaging, email, calendar, voice/calls, browsing, finance, etc), plus a list of known gaps. Use this FIRST for any functional or product-level question — 'how do we improve you', 'what features should we add', 'what can't you do yet' — before reaching for grep_code/read_file. Those code tools are for verifying a specific mechanism, not for building a mental model of what you are.",
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: "List the files in Ava's own codebase that she's allowed to inspect, with size/line counts.",
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a line range from one of your own source files. Keep ranges narrow (a few hundred lines max) — use grep_code first to find where to look.',
      parameters: {
        type: 'object',
        properties: {
          file: { type: 'string', description: 'Filename, e.g. "server.js" or "index.html"' },
          start_line: { type: 'integer', description: '1-indexed start line' },
          end_line: { type: 'integer', description: '1-indexed end line (inclusive)' }
        },
        required: ['file']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'grep_code',
      description: 'Search for a regex pattern across your own source files (or one specific file) and get back matching line numbers. Use this before read_file to find the right spot.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Regex pattern (case-insensitive) to search for' },
          file: { type: 'string', description: 'Optional — limit search to one file' }
        },
        required: ['pattern']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'propose_edit',
      description: "Suggest a specific change to your own code as a reviewable diff. This does NOT apply the change — a human reviews and applies it separately. old_str must match the file's current content EXACTLY (whitespace included) and appear only once.",
      parameters: {
        type: 'object',
        properties: {
          file: { type: 'string' },
          old_str: { type: 'string', description: 'Exact existing text to replace' },
          new_str: { type: 'string', description: 'Replacement text' },
          reason: { type: 'string', description: 'Why this change — what it fixes or improves' }
        },
        required: ['file', 'old_str', 'new_str', 'reason']
      }
    }
  }
];

function avaExecuteTool(name, args) {
  try {
    switch (name) {
      case 'get_capabilities_map': return getActiveCapabilitiesMap();
      case 'list_files': return avaListFiles();
      case 'read_file': return avaReadFile(args.file, args.start_line, args.end_line);
      case 'grep_code': return avaGrepCode(args.pattern, args.file);
      case 'propose_edit': return avaProposeEdit(args.file, args.old_str, args.new_str, args.reason);
      default: return { error: `Unknown tool: ${name}` };
    }
  } catch (e) {
    return { error: e.message };
  }
}

const AVA_SELF_AWARENESS_PROMPT = `You are Ava, and in this conversation you have direct access to understanding your own machinery — both what you can DO (your actual features and integrations) and how you're built (your real source code).

You have five tools: get_capabilities_map, list_files, read_file, grep_code, propose_edit.

How to choose between them:
1. FUNCTIONAL / PRODUCT questions — "how do we improve you", "what features should we add", "what can't you do yet", "how would we make you better at X" — call get_capabilities_map FIRST. It's a grounded summary of every real domain you operate in (messaging, email, calendar, voice/calls, browsing, finance, etc.) plus known gaps. Reason about improvements from that map: what's missing, what could connect better, what's duplicated across channels. Don't jump to grep_code for these — a feature-level question doesn't need a line number, it needs an accurate picture of what already exists.
2. CODE / BUG / MECHANISM questions — "why does X break", "is there a bug in your fade animation", "check server.js for Y" — use grep_code (then read_file for the specific range) before answering. Never guess at how a specific mechanism works from memory.
3. If a functional question turns into "does that actually exist in the code" (verifying a claim from the capabilities map), THEN drop into grep_code/read_file to confirm — the map is a starting mental model, not a substitute for checking when precision matters.
4. If you find something worth changing, use propose_edit and explain the reasoning in "reason". You cannot apply changes yourself — say so plainly if asked to "just fix it." A human reviews and applies proposals via a separate step.
5. If the conversation isn't about your own capabilities or code at all, don't use these tools — just talk normally.`;

// One Groq tool-calling round-trip, with the same key-rotation-on-429 pattern
// used elsewhere in this file.
async function avaCallGroqTools(messages, toolChoice) {
  let lastErr;
  for (let i = 0; i < Math.max(GROQ_KEYS.length, 1); i++) {
    const key = getGroqKey();
    try {
      const res = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
        model: 'llama-3.3-70b-versatile',
        messages,
        tools: AVA_TOOLS,
        tool_choice: toolChoice || 'auto',
        max_tokens: 1024,
        temperature: 0.4
      }, { headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' } });
      return res.data;
    } catch (e) {
      lastErr = e;
      if (e.response?.status === 429 && i < GROQ_KEYS.length - 1) continue;
      throw e;
    }
  }
  throw lastErr || new Error('All Groq keys rate limited');
}

// Deterministic gate — decides whether THIS message should be forced to look
// at real code before answering, instead of leaving that judgment call to the
// model (which will sometimes skip tools and just free-generate an answer).
// This is intentionally broad/loose: false positives just mean an unnecessary
// tool call, which is cheap. False negatives are the actual failure mode we're
// closing off, so err toward matching.
// Deterministic gate — decides whether THIS message should be forced to look
// at real code/capabilities before answering, instead of leaving that
// judgment call to the model (which will sometimes skip tools and just
// free-generate an answer). Built as separate conditions rather than one
// giant regex — natural phrasing varies too much for a single exact-sequence
// pattern to catch reliably; independent checks are easier to get right and
// to extend later. False positives here just mean one unnecessary tool call
// (cheap); false negatives are the actual failure mode being closed off, so
// err toward matching.
function avaSelfTriggered(text) {
  if (!text) return false;
  const t = String(text).toLowerCase();
  // Direct code/file/mechanism references
  if (/\bserver\.js\b|\bindex\.html\b|\bgrep\b|\bread[- ]?file\b|\byour (own )?particle\b/.test(t)) return true;
  if (/\b(your|you)(self)?\b/.test(t) && /\b(code|source|logic|bug|behavior|behaviour)\b/.test(t)) return true;
  if (/\blook (through|at) your\b|\bcheck your (own )?code\b|\bfix (yourself|your)\b/.test(t)) return true;
  // Functional / product-improvement phrasing — doesn't need to mention code at all
  if (/\bimprove\b/.test(t) && /\b(you|yourself|ava|her)\b/.test(t)) return true;
  if (/\bfeature|\bcapabilit/.test(t) && /\b(add|build|new|what|your)\b/.test(t)) return true;
  if (/\bmake (you|her|ava) better\b/.test(t)) return true;
  if (/\bwhat can.{0,4}t you\b|\bwhat can you not\b/.test(t)) return true;
  if (/\bwe (add|build)\b/.test(t) && /\b(you|your|ava|her)\b/.test(t)) return true;
  return false;
}

// POST /ava-self-chat — "improve mode". Body: { messages: [{role,content}, ...] }
// Runs the tool-use loop server-side: executes any tool_calls Ava makes against
// the real files, feeds results back, repeats until she replies with plain text.
app.post('/ava-self-chat', async (req, res) => {
  try {
    const userMessages = Array.isArray(req.body?.messages) ? req.body.messages : [];
    let messages = [{ role: 'system', content: AVA_SELF_AWARENESS_PROMPT }, ...userMessages];

    const lastUserMsg = [...userMessages].reverse().find(m => m.role === 'user');
    const mustLookAtCode = !!(lastUserMsg && avaSelfTriggered(String(lastUserMsg.content || '')));

    const MAX_ITERATIONS = 10;
    const proposedEdits = [];

    for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
      // Force a real tool call on the very first turn if the regex gate fired —
      // 'required' rejects a plain-text-only response outright, so she can't
      // just skip straight to prose on a question that's clearly about her code.
      // On the LAST allowed round, force the opposite: 'none' rules out another
      // tool call and makes her summarize whatever she's already gathered,
      // instead of requesting round 11 and hitting a hard failure.
      // Everything in between stays 'auto' so she can chain calls or wrap up
      // naturally once she actually has enough.
      const isLastRound = iter === MAX_ITERATIONS - 1;
      const toolChoice = (iter === 0 && mustLookAtCode) ? 'required'
                        : isLastRound ? 'none'
                        : 'auto';
      const data = await avaCallGroqTools(messages, toolChoice);
      const choice = data.choices[0].message;

      if (choice.tool_calls && choice.tool_calls.length) {
        messages.push(choice);
        for (const call of choice.tool_calls) {
          let args = {};
          try { args = JSON.parse(call.function.arguments || '{}'); } catch (e) {}
          const result = avaExecuteTool(call.function.name, args);
          if (call.function.name === 'propose_edit' && result && result.id) proposedEdits.push(result);
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: JSON.stringify(result)
          });
        }
        continue; // let Ava see the tool results and respond again
      }

      // Plain-text reply — done.
      return res.json({
        reply: choice.content || "I looked through the code but didn't land on a clean summary in time — try narrowing the question (e.g. a specific file or function) and I'll take another pass.",
        proposedEdits: proposedEdits.length ? proposedEdits : undefined
      });
    }

    // Should be unreachable now (last round forces tool_choice:'none'), but
    // kept as a safety net in case the model still returns tool_calls anyway.
    res.json({
      reply: "I gathered some information but ran out of turns before finishing — try asking about a narrower part of the code (a specific file, function, or bug) so I can give you a complete answer.",
      proposedEdits: proposedEdits.length ? proposedEdits : undefined
    });
  } catch (e) {
    console.error('[AVA-SELF-CHAT] error:', e.response?.data || e.message);
    res.status(e.response?.status || 500).json({ error: e.response?.data || e.message });
  }
});

// GET /ava-pending-edits — list proposals awaiting human review
app.get('/ava-pending-edits', (req, res) => {
  res.json({ edits: Object.values(avaPendingEdits).filter(e => e.status === 'pending') });
});

// POST /ava-apply-edit — Body: { id, confirm: true }. Applies a previously
// proposed edit to the real file on disk. Requires explicit confirm:true —
// this is the ONLY place her suggestions ever actually touch a file.
app.post('/ava-apply-edit', (req, res) => {
  try {
    const { id, confirm } = req.body || {};
    const edit = avaPendingEdits[id];
    if (!edit || edit.status !== 'pending') return res.status(404).json({ error: 'No pending edit with that id' });
    if (!confirm) return res.status(400).json({ error: 'Pass confirm:true to apply this edit' });

    const full = avaResolveAllowedFile(edit.file);
    const content = fs.readFileSync(full, 'utf8');
    const occurrences = content.split(edit.old_str).length - 1;
    if (occurrences !== 1) {
      return res.status(409).json({ error: `old_str now matches ${occurrences} places (file changed since proposal) — reject and re-propose.` });
    }
    fs.writeFileSync(full, content.replace(edit.old_str, edit.new_str), 'utf8');
    edit.status = 'applied';
    edit.appliedAt = new Date().toISOString();
    console.log(`[AVA-SELF-EDIT] Applied edit ${id} to ${edit.file}`);
    res.json({ success: true, file: edit.file, note: edit.file === 'server.js' ? 'server.js changed — restart the process to load it.' : undefined });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /ava-reject-edit — Body: { id }. Discards a proposal without applying it.
app.post('/ava-reject-edit', (req, res) => {
  const { id } = req.body || {};
  const edit = avaPendingEdits[id];
  if (!edit) return res.status(404).json({ error: 'No edit with that id' });
  edit.status = 'rejected';
  res.json({ success: true });
});
// ── End Ava self-code-inspection tools ──────────────────────────────────────

// ── /pulse-meetups — real upcoming events for the in-app Pulse stack ─────────
// Sources: Luma calendars (Apify, same as WhatsApp briefings) then Tavily.
// Cached in-memory so opening Pulse doesn't hammer Apify every tap.
let _pulseMeetupCache = { at: 0, items: null, source: null };
const PULSE_MEETUP_TTL_MS = 45 * 60 * 1000; // 45 min

function normalizeLumaToPulse(events) {
  if (!events || !events.length) return [];
  const now = Date.now();
  return events
    .filter(e => e && (e.name || e.title))
    .map((e, i) => {
      const title = String(e.name || e.title || 'Event').trim();
      const rawWhen = e.timeUTC || e.date || e.startAt || e.start_at || null;
      const whenMs = rawWhen ? new Date(rawWhen).getTime() : NaN;
      const futureOk = !rawWhen || (!isNaN(whenMs) && whenMs >= now - 3600e3);
      if (!futureOk) return null;
      let dateStr = 'Date TBA';
      if (rawWhen && !isNaN(whenMs)) {
        dateStr = new Date(whenMs).toLocaleString('en-US', {
          weekday: 'short', month: 'short', day: 'numeric',
          hour: 'numeric', minute: '2-digit', timeZone: 'America/Vancouver'
        }) + ' PT';
      }
      const location = e.city || e.location || e.venue || e.geo_address_info?.full_address || '';
      const desc = String(e.text || e.description || e.desc || location || 'Upcoming event on Luma')
        .replace(/\s+/g, ' ').trim().slice(0, 160);
      const url = e.url || e.eventUrl || e.event_url || e.link
        || (e.slug ? `https://lu.ma/${e.slug}` : null)
        || (e.id ? `https://lu.ma/event/${e.id}` : 'https://lu.ma/vancouver-ai');
      const id = 'luma_' + String(e.id || e.event_id || (title + '_' + (rawWhen || i))).replace(/\W+/g, '_').slice(0, 64);
      return {
        id,
        cat: 'meetup',
        tag: 'Meetup',
        title: title.slice(0, 90),
        desc,
        meta: [dateStr, location].filter(Boolean).join(' · ').slice(0, 80),
        url,
        when: isNaN(whenMs) ? now + i * 1000 : whenMs,
        source: 'luma'
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.when - b.when)
    .slice(0, 12);
}

function normalizeTavilyToPulse(data) {
  const results = (data && data.results) || [];
  const now = Date.now();
  return results.slice(0, 8).map((r, i) => {
    const title = String(r.title || 'Local event').trim().slice(0, 90);
    const desc = String(r.content || r.snippet || '').replace(/\s+/g, ' ').trim().slice(0, 160);
    const url = r.url || 'https://www.meetup.com/find/?keywords=AI&location=Vancouver';
    let tag = 'Meetup';
    let cat = 'meetup';
    if (/eventbrite/i.test(url)) { tag = 'Eventbrite'; cat = 'meetup'; }
    if (/lu\.ma|luma\.com/i.test(url)) { tag = 'Luma'; cat = 'meetup'; }
    if (/meetup\.com/i.test(url)) { tag = 'Meetup'; cat = 'meetup'; }
    const id = 'web_' + String(url || title).replace(/\W+/g, '_').slice(0, 64);
    return {
      id,
      cat,
      tag,
      title,
      desc: desc || 'Upcoming AI / builder event near Vancouver.',
      meta: 'Live find · Vancouver',
      url,
      when: now + i * 1000,
      source: 'tavily'
    };
  });
}

app.get('/pulse-meetups', async (req, res) => {
  try {
    const city = String(req.query.city || 'vancouver').toLowerCase().replace(/[^a-z-]/g, '') || 'vancouver';
    const force = req.query.refresh === '1';
    const now = Date.now();
    if (!force && _pulseMeetupCache.items && (now - _pulseMeetupCache.at) < PULSE_MEETUP_TTL_MS) {
      return res.json({
        events: _pulseMeetupCache.items,
        source: _pulseMeetupCache.source,
        cached: true,
        updated: _pulseMeetupCache.at
      });
    }

    let items = [];
    let source = null;

    // 1) Luma calendars — same Apify path as WhatsApp briefings
    const lumaSlugs = city === 'vancouver'
      ? ['vancouver-ai', 'vancouver']
      : [city + '-ai', city];
    if (APIFY_TOKEN) {
      for (const slug of lumaSlugs) {
        if (items.length >= 4) break;
        try {
          const raw = await lumaScrap(`https://lu.ma/${slug}`);
          const norm = normalizeLumaToPulse(raw);
          if (norm.length) {
            items = items.concat(norm);
            source = source || 'luma';
          }
        } catch (e) {
          console.warn('[PULSE] luma slug fail', slug, e.message);
        }
      }
    }

    // de-dupe by title
    const seen = new Set();
    items = items.filter(it => {
      const k = it.title.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

    // 2) Tavily fallback / top-up for Meetup.com + Eventbrite + Luma
    if (items.length < 3) {
      try {
        const q = `upcoming AI meetup events ${city} OR machine learning OR builders site:meetup.com OR site:lu.ma OR site:eventbrite.ca 2026`;
        const data = await tavilySearch({
          query: q,
          search_depth: 'basic',
          max_results: 8,
          include_answer: false,
          include_domains: ['meetup.com', 'lu.ma', 'luma.com', 'eventbrite.ca', 'eventbrite.com']
        });
        const web = normalizeTavilyToPulse(data);
        for (const w of web) {
          const k = w.title.toLowerCase();
          if (seen.has(k)) continue;
          seen.add(k);
          items.push(w);
          source = source ? source + '+tavily' : 'tavily';
          if (items.length >= 10) break;
        }
      } catch (e) {
        console.warn('[PULSE] tavily fail', e.message);
      }
    }

    items = items.slice(0, 10);
    if (items.length) {
      _pulseMeetupCache = { at: now, items, source: source || 'mixed' };
    }

    res.json({
      events: items,
      source: source || (items.length ? 'mixed' : 'empty'),
      cached: false,
      updated: now
    });
  } catch (e) {
    console.error('[PULSE] /pulse-meetups', e.message);
    res.status(500).json({ error: e.message, events: [] });
  }
});

// POST /mem0-search — passthrough recall, reuses existing mem0Recall()
app.post('/mem0-search', async (req, res) => {
  try {
    const { query, user_id } = req.body || {};
    if (!user_id || !query) return res.status(400).json({ error: 'user_id and query are required' });
    const result = await mem0Recall(user_id, query);
    res.json({ result });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /mem0-save — passthrough save, reuses existing mem0Save()
app.post('/mem0-save', async (req, res) => {
  try {
    const { messages, user_id } = req.body || {};
    if (!user_id || !messages) return res.status(400).json({ error: 'user_id and messages are required' });
    await mem0Save(user_id, messages);
    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /mem0-delete — wipe a user's Mem0 memory ("Reset Companion Memory" button)
app.delete('/mem0-delete', async (req, res) => {
  try {
    const user_id = req.query.user_id;
    if (!user_id) return res.status(400).json({ error: 'user_id is required' });
    await axios.delete(`${MEM0_BASE}/memories/`, {
      params: { user_id },
      headers: { Authorization: 'Token ' + MEM0_API_KEY }
    });
    Object.keys(_mem0Cache).forEach(k => { if (k.startsWith(user_id + '::')) delete _mem0Cache[k]; });
    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});
// POST /liveavatar-session — creates a LiveAvatar session token + starts the
// session server-side (key never touches the frontend), returns the LiveKit
// room info the client needs to connect and render Ava's avatar video.
// Body: { avatarId } — optional, defaults to June HR.
const LIVEAVATAR_API_KEY = process.env.LIVEAVATAR_API_KEY;
const LIVEAVATAR_DEFAULT_AVATAR_ID = process.env.LIVEAVATAR_AVATAR_ID || '65f9e3c9-d48b-4118-b73a-4ae2e3cbb8f0';

app.post('/liveavatar-session', async (req, res) => {
  try {
    const avatarId = (req.body && req.body.avatarId) || LIVEAVATAR_DEFAULT_AVATAR_ID;

    // Step 1 — get a short-lived session token. mode + avatar_id belong HERE,
    // not on /sessions/start (that endpoint takes no body, just the bearer token).
    const tokenRes = await axios.post(
      'https://api.liveavatar.com/v1/sessions/token',
      {
        mode: 'LITE', // we drive our own AI/voice (Groq + Deepgram), LiveAvatar just renders the face
        avatar_id: avatarId
      },
      { headers: { 'X-API-KEY': LIVEAVATAR_API_KEY, 'Content-Type': 'application/json' } }
    );
    const sessionToken = tokenRes.data?.data?.session_token;
    if (!sessionToken) {
      return res.status(502).json({ error: 'No session_token in LiveAvatar response', detail: tokenRes.data });
    }

    // Step 2 — start the session using that token (no body needed here)
    const startRes = await axios.post(
      'https://api.liveavatar.com/v1/sessions/start',
      {},
      { headers: { Authorization: `Bearer ${sessionToken}`, 'Content-Type': 'application/json' } }
    );

    const sessionData = startRes.data?.data || {};
    res.json({
      sessionId: sessionData.session_id,
      livekitUrl: sessionData.livekit_url,
      livekitClientToken: sessionData.livekit_client_token,
      wsUrl: sessionData.ws_url,
      maxSessionDuration: sessionData.max_session_duration
    });
  } catch (e) {
    console.error('[LIVEAVATAR] session error:', e.response?.data || e.message);
    res.status(e.response?.status || 500).json({ error: e.response?.data || e.message });
  }
});

// POST /liveavatar-stop — explicitly ends a session (USER_CLOSED). Accepts
// either JSON or text/plain bodies since navigator.sendBeacon() (used on page
// unload, where fetch() may get cut off mid-flight) can't set a JSON content
// type — Express's express.text() below covers that case.
app.post('/liveavatar-stop', express.text({ type: '*/*' }), async (req, res) => {
  try {
    let sessionId = req.body && req.body.sessionId;
    if (!sessionId && typeof req.body === 'string') {
      try { sessionId = JSON.parse(req.body).sessionId; } catch (e) {}
    }
    if (!sessionId) return res.status(400).json({ error: 'sessionId is required' });

    await axios.post(
      'https://api.liveavatar.com/v1/sessions/stop',
      { session_id: sessionId, reason: 'USER_CLOSED' },
      { headers: { 'X-API-KEY': LIVEAVATAR_API_KEY, 'Content-Type': 'application/json' } }
    );
    res.json({ success: true });
  } catch (e) {
    console.error('[LIVEAVATAR] stop error:', e.response?.data || e.message);
    // Still respond 200-ish here — this route is often called via sendBeacon
    // on unload, where the caller can't do anything with an error anyway.
    res.status(200).json({ success: false, error: e.response?.data || e.message });
  }
});
// ── End client-facing proxy routes ──────────────────────────────────────────

// POST /anam-session — creates an Anam session token server-side (key never
// touches the frontend). Body: { avatarOnly } — defaults to true (our own
// Deepgram/AI pipeline drives her voice; Anam's own brain/voice is disabled
// so she never speaks on her own, e.g. random "you've been quiet" prompts).
// Pass avatarOnly:false to use Anam's own native voice/AI (e.g. Siobhan) instead.
const ANAM_API_KEY = process.env.ANAM_API_KEY;
const ANAM_DEFAULT_AVATAR_ID = process.env.ANAM_AVATAR_ID || '35010c9d-585c-4bb1-8a21-ba8da26e4c9e';
const ANAM_API_KEY_2 = process.env.ANAM_API_KEY_2;
const ANAM_AVATAR_ID_2 = process.env.ANAM_AVATAR_ID_2;

app.post('/anam-session', async (req, res) => {
  try {
    const slot = req.body && req.body.avatarSlot;
    const useSlot2 = slot === 2 && ANAM_API_KEY_2 && ANAM_AVATAR_ID_2;
    const apiKey = useSlot2 ? ANAM_API_KEY_2 : ANAM_API_KEY;
    const avatarId = useSlot2 ? ANAM_AVATAR_ID_2
                   : (req.body && req.body.avatarId) || ANAM_DEFAULT_AVATAR_ID;
    const avatarOnly = !(req.body && req.body.avatarOnly === false); // default true
    const nativeVoice = !!(req.body && req.body.nativeVoice); // true when the client is using Anam's own voice instead of our TTS passthrough
    // Our own voice (passthrough) mode: Anam's own AI brain isn't driving the
    // conversation at all — our Deepgram/STT pipeline handles turn-taking, so
    // Anam's silence-prompt/auto-end is just unwanted noise there. Disabled.
    // Native voice mode: Anam's own AI genuinely runs the conversation and
    // listens via its own mic input. The "haven't heard from you" prompt is
    // fully disabled (0 = off, per Anam's own docs) since it was firing on
    // ordinary pauses between sentences. The actual auto-disconnect is kept,
    // but with a generous threshold so real inactivity still ends an abandoned
    // session (protects against burning paid minutes forever) without
    // triggering during active conversation.
    const voiceDetectionOptions = nativeVoice
      ? { silenceBeforeSkipTurnSeconds: 0, silenceBeforeSessionEndSeconds: 180 }
      : { silenceBeforeSkipTurnSeconds: 0, silenceBeforeSessionEndSeconds: 0 };
    const personaConfig = {
      personaId: avatarId, // Lab persona — avatarOnly may not be respected but muteAgentAudio() handles it client-side
      avatarOnly: avatarOnly,
      maxSessionLengthSeconds: 3600, // Anam's own default (~3-4 min on this account) was cutting the avatar off mid-reply; give it an hour of headroom instead
    };
    if (voiceDetectionOptions) personaConfig.voiceDetectionOptions = voiceDetectionOptions;
    const tokenRes = await axios.post(
      'https://api.anam.ai/v1/auth/session-token',
      { personaConfig },
      { headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' } }
    );
    const sessionToken = tokenRes.data?.sessionToken;
    if (!sessionToken) {
      return res.status(502).json({ error: 'No sessionToken in Anam response', detail: tokenRes.data });
    }
    res.json({ sessionToken });
  } catch (e) {
    console.error('[ANAM] session error:', e.response?.data || e.message);
    res.status(e.response?.status || 500).json({ error: e.response?.data || e.message });
  }
});
// ── End Anam route ───────────────────────────────────────────────────────────

// POST /elevenlabs-tts — proxies ElevenLabs text-to-speech so the API key
// never touches the client. Body: { text, voiceId }. Returns raw audio/mpeg.
// Set on Render as an env var: ELEVENLABS_API_KEY=sk_...
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;

app.post('/elevenlabs-tts', async (req, res) => {
  try {
    if (!ELEVENLABS_API_KEY) {
      return res.status(500).json({ error: 'ELEVENLABS_API_KEY not configured on server' });
    }
    const { text, voiceId } = req.body || {};
    if (!text || !voiceId) {
      return res.status(400).json({ error: 'text and voiceId are required' });
    }

    const elevenRes = await axios.post(
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}`,
      {
        text,
        model_id: 'eleven_multilingual_v2',
        voice_settings: { stability: 0.5, similarity_boost: 0.75 }
      },
      {
        headers: {
          'xi-api-key': ELEVENLABS_API_KEY,
          'Content-Type': 'application/json',
          'Accept': 'audio/mpeg'
        },
        responseType: 'arraybuffer'
      }
    );

    res.set('Content-Type', 'audio/mpeg');
    res.send(Buffer.from(elevenRes.data));
  } catch (e) {
    // e.response.data is a Buffer here (arraybuffer response type), so decode
    // it to text if present instead of logging an unreadable Buffer.
    const detail = e.response?.data ? Buffer.from(e.response.data).toString('utf8') : e.message;
    console.error('[ELEVENLABS] tts error:', e.response?.status, detail);
    res.status(e.response?.status || 500).json({ error: detail });
  }
});
// ── End ElevenLabs route ─────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  console.log(`Synbot running on port ${PORT}`);
  initBrowserAgent(server);
  // Register Vapi webhook after server starts
  setTimeout(registerVapiWebhook, 3000);
});
