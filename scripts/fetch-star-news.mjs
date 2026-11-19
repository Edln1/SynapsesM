import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, rename, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SOURCES = Object.freeze([
  { id: 'nvidia', name: 'NVIDIA', feed: 'https://blogs.nvidia.com/feed/', hosts: ['blogs.nvidia.com'] },
  { id: 'meta', name: 'Meta', feed: 'https://about.fb.com/news/feed/', hosts: ['about.fb.com'] },
  { id: 'youtube', name: 'YouTube', feed: 'https://blog.youtube/rss/', hosts: ['blog.youtube'] },
]);
const MAX_BYTES = 1024 * 1024;
const DAY = 86400000;
function allowedUrl(value, source) {
  let u;
  try { u = new URL(value); } catch { return null; }
  return u.protocol === 'https:' && source.hosts.includes(u.hostname) && !u.username && !u.password && !u.port ? u.href : null;
}
export function plainText(value) {
  return String(value || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]*>/g, '')
    .replace(/&#(x[0-9a-f]+|[0-9]+);/gi, (_, n) => {
      const cp = n[0].toLowerCase() === 'x' ? parseInt(n.slice(1), 16) : Number(n);
      return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : '';
    }).replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_, n) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' })[n])
    .replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
}
function field(item, tag) {
  return new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}\\s*>`, 'i').exec(item)?.[1] || '';
}
export function parseRSS(xml, source, now = new Date()) {
  if (typeof xml !== 'string' || Buffer.byteLength(xml) > MAX_BYTES || /<!DOCTYPE|<!ENTITY/i.test(xml) || !/<rss\b/i.test(xml)) throw new Error('The official feed was not usable RSS.');
  const at = new Date(now).getTime();
  if (!Number.isFinite(at)) throw new Error('Invalid snapshot time.');
  const blocks = [...xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item\s*>/gi)].slice(0, 60);
  if (!blocks.length) throw new Error('The official feed contained no items.');
  const seen = new Set(), items = [];
  for (const [, item] of blocks) {
    const title = plainText(field(item, 'title'));
    const url = allowedUrl(plainText(field(item, 'link')), source);
    const published = Date.parse(plainText(field(item, 'pubDate') || field(item, 'dc:date')));
    if (!title || title.length > 240 || !url || !Number.isFinite(published) || published > at + 12 * 3600000 || published < at - 45 * DAY || seen.has(url)) continue;
    seen.add(url);
    items.push({ id: createHash('sha256').update(url).digest('hex').slice(0, 20), topic: source.id, source: source.name, title, url, publishedAt: new Date(published).toISOString() });
    if (items.length >= 8) break;
  }
  if (!items.length) throw new Error('No recent dated official updates were available.');
  return items.sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
}
async function boundedText(response) {
  const declared = Number(response.headers.get('content-length'));
  if (declared > MAX_BYTES) { await response.body?.cancel(); throw new Error('The feed exceeded its size limit.'); }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('The feed response had no body.');
  const chunks = []; let count = 0;
  try { while (true) { const { value, done } = await reader.read(); if (done) break; count += value.byteLength; if (count > MAX_BYTES) { await reader.cancel(); throw new Error('The feed exceeded its size limit.'); } chunks.push(value); } }
  finally { reader.releaseLock(); }
  return Buffer.concat(chunks).toString('utf8');
}
export async function fetchSource(source, { fetchImpl = fetch, now = new Date(), timeoutMs = 12000 } = {}) {
  const signal = AbortSignal.timeout(timeoutMs); let url = source.feed;
  for (let redirects = 0; redirects <= 3; redirects++) {
    if (!allowedUrl(url, source)) throw new Error('The feed URL was not an approved official host.');
    const response = await fetchImpl(url, { redirect: 'manual', signal, headers: { Accept: 'application/rss+xml, application/xml, text/xml', 'User-Agent': 'Synapses-Star-News/1.0 (official-headline snapshot)' } });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const next = response.headers.get('location'); await response.body?.cancel();
      if (!next || redirects === 3) throw new Error('The feed redirect limit was reached.');
      url = new URL(next, url).href; continue;
    }
    if (!response.ok) { await response.body?.cancel(); throw new Error('The official feed was unavailable.'); }
    const type = response.headers.get('content-type') || '';
    if (!/(?:rss\+xml|application\/xml|text\/xml|atom\+xml)/i.test(type)) { await response.body?.cancel(); throw new Error('The feed returned an unexpected format.'); }
    return parseRSS(await boundedText(response), source, now);
  }
  throw new Error('The official feed could not be read.');
}
export async function buildSnapshot({ fetchImpl = fetch, now = new Date(), previous = null } = {}) {
  const at = new Date(now).toISOString();
  const outcomes = await Promise.all(SOURCES.map(async source => {
    try { return { source, items: await fetchSource(source, { fetchImpl, now }), checkedAt: at, status: 'ok' }; }
    catch {
      const old = previous?.sources?.find(s => s.id === source.id);
      const checked = Date.parse(old?.checkedAt || '');
      const items = Number.isFinite(checked) && Date.parse(at) - checked <= 7 * DAY ? (previous?.items || []).filter(i => i.topic === source.id && allowedUrl(i.url, source) && typeof i.title === 'string' && i.title.length <= 240 && Date.parse(i.publishedAt) > Date.parse(at) - 45 * DAY).slice(0, 8) : [];
      return { source, items, checkedAt: old?.checkedAt || null, status: items.length ? 'cached' : 'unavailable' };
    }
  }));
  const items = [];
  // Interleave sources so adjacent discoveries do not all come from one company.
  for (let i = 0; i < 8; i++) for (const result of outcomes) if (result.items[i]) items.push(result.items[i]);
  return { version: 1, generatedAt: at, sources: outcomes.map(({ source, checkedAt, status }) => ({ id: source.id, name: source.name, homepage: new URL(source.feed).origin + '/', checkedAt, status })), items };
}
export async function writeSnapshot(destination, options = {}) {
  const output = resolve(destination); let previous = null;
  try { previous = JSON.parse(await readFile(output, 'utf8')); } catch {}
  const snapshot = await buildSnapshot({ ...options, previous });
  // Never replace a useful snapshot with an uninformative all-source outage.
  if (!snapshot.items.length && previous?.items?.length) throw new Error('All official feeds were unavailable; the prior snapshot was kept.');
  await mkdir(dirname(output), { recursive: true });
  const temporary = `${output}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, JSON.stringify(snapshot, null, 2) + '\n', { flag: 'wx' }); await rename(temporary, output); }
  finally { await unlink(temporary).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
  return snapshot;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await writeSnapshot(process.argv[2] || fileURLToPath(new URL('./star-news.json', import.meta.url)));
  console.log(`Saved ${result.items.length} official headlines; ${result.sources.map(s => `${s.name}: ${s.status}`).join(', ')}.`);
}
