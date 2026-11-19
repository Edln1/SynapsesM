import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { SOURCES, parseRSS, plainText, fetchSource, buildSnapshot } from '../scripts/fetch-star-news.mjs';
const require = createRequire(import.meta.url);
const ui = require('../star-news.js');
const now = new Date('2026-11-18T20:00:00Z');
const source = SOURCES[0];
const rss = entries => `<?xml version="1.0"?><rss><channel>${entries.map(e=>`<item><title><![CDATA[${e.title||'A real official update'}]]></title><link>${e.url||'https://blogs.nvidia.com/blog/example-update/'}</link><pubDate>${e.date||'Wed, 18 Nov 2026 10:00:00 GMT'}</pubDate></item>`).join('')}</channel></rss>`;
const response = (text, status=200, headers={}) => new Response(text,{status,headers:{'content-type':'application/rss+xml',...headers}});
test('RSS stores only dated recent official headlines, decodes plain text and deduplicates links',()=>{
  const items=parseRSS(rss([{title:'New chips &amp; tools <b>announced</b>'},{title:'Duplicate'},{url:'https://blogs.nvidia.com/blog/other/',date:'Wed, 18 Nov 2026 11:00:00 GMT'}]),source,now);
  assert.equal(items.length,2);assert.equal(items[1].title,'New chips & tools announced');assert.equal(items[0].source,'NVIDIA');assert.equal(items[0].publishedAt,'2026-11-18T11:00:00.000Z');assert.match(items[0].id,/^[a-f0-9]{20}$/);
});
test('malformed, DTD/entity and oversized feed bodies cannot be interpreted',()=>{
  for(const xml of ['<html>not RSS</html>','<rss><channel/></rss>','<!DOCTYPE rss [<!ENTITY x SYSTEM "file:///etc/passwd">]><rss/>','<rss>'+ 'a'.repeat(1024*1024)+'</rss>'])assert.throws(()=>parseRSS(xml,source,now));
});
test('links with scripts, credentials, foreign hosts, HTTP or nonstandard ports are refused',()=>{
  for(const url of ['javascript:alert(1)','https://evil.test/nvidia','https://blogs.nvidia.com@evil.test/','https://user:pass@blogs.nvidia.com/blog/','http://blogs.nvidia.com/blog/','https://blogs.nvidia.com:9443/blog/'])assert.throws(()=>parseRSS(rss([{url}]),source,now));
  assert.equal(plainText('Hello &#x1f30e; &quot;world&quot;'),'Hello 🌎 "world"');
});
test('unusable dates, distant-future claims and old headlines are omitted',()=>{
  for(const date of ['not-a-date','Wed, 18 Nov 2020 10:00:00 GMT','Wed, 18 Nov 2030 10:00:00 GMT'])assert.throws(()=>parseRSS(rss([{date}]),source,now));
});
test('redirects are bounded and cannot leave an official host',async()=>{
  let attempts=0;await assert.rejects(fetchSource(source,{now,fetchImpl:async()=>{attempts++;return response('',302,{location:'https://evil.test/feed'});}}));assert.equal(attempts,1);
  attempts=0;await assert.rejects(fetchSource(source,{now,fetchImpl:async()=>{attempts++;return response('',302,{location:'/feed/again'});}}));assert.equal(attempts,4);
});
test('response size and content type are checked before parsing',async()=>{
  await assert.rejects(fetchSource(source,{now,fetchImpl:async()=>response(rss([{}]),200,{'content-type':'text/html'})}));
  await assert.rejects(fetchSource(source,{now,fetchImpl:async()=>response(rss([{}]),200,{'content-length':String(1024*1024+1)})}));
  await assert.rejects(fetchSource(source,{now,fetchImpl:async()=>response('<rss>'+ 'a'.repeat(1024*1024)+'</rss>')}));
});
test('snapshot interleaves all three verified primary sources without summaries or fabricated prices',async()=>{
  const snapshot=await buildSnapshot({now,fetchImpl:async url=>{const s=SOURCES.find(s=>s.feed===url);return response(rss([{url:'https://'+s.hosts[0]+'/example',title:s.name+' update'}]));}});
  assert.deepEqual(snapshot.items.map(i=>i.topic),['nvidia','meta','youtube']);assert.equal(snapshot.sources.every(s=>s.status==='ok'),true);assert.equal(snapshot.generatedAt,now.toISOString());assert.equal(Object.hasOwn(snapshot.items[0],'summary'),false);
});
test('feed failures retain only recently checked prior headlines and label them cached',async()=>{
  const previous={items:parseRSS(rss([{}]),source,now),sources:[{id:'nvidia',checkedAt:'2026-11-18T10:00:00Z'}]};
  const snapshot=await buildSnapshot({now,previous,fetchImpl:async()=>{throw Error('offline');}});
  assert.equal(snapshot.items.length,1);assert.equal(snapshot.sources[0].status,'cached');assert.equal(snapshot.sources[0].checkedAt,'2026-11-18T10:00:00Z');assert.equal(snapshot.sources[1].status,'unavailable');
  previous.sources[0].checkedAt='2026-10-01T10:00:00Z';assert.equal((await buildSnapshot({now,previous,fetchImpl:async()=>{throw Error('offline');}})).items.length,0);
});
test('UI uses viewport CSS coordinates, refuses malformed points and does not multiply by device pixel ratio',()=>{
  const points=[{id:'a',x:100,y:100},{id:'b',x:200,y:200},{id:'bad',x:NaN,y:100},{id:'outside',x:1200,y:100}];
  assert.equal(ui.nearestPoint(points,103,105,12,800,600).id,'a');assert.equal(ui.nearestPoint(points,150,150,12,800,600),null);assert.equal(ui.nearestPoint(points,220,200,24,800,600).id,'b');
});
test('UI cards stay inside viewport at each edge and unsafe cached links are not displayed',()=>{
  for(const point of [{x:10,y:10},{x:390,y:840},{x:700,y:400}]){const p=ui.cardPosition(point,390,844,310,220);assert.ok(p.left>=12&&p.left+310<=378);assert.ok(p.top>=12&&p.top+220<=832);}
  const items=parseRSS(rss([{}]),source,now);const value={version:1,generatedAt:now.toISOString(),items:[...items,{...items[0],url:'javascript:alert(1)'},{...items[0],title:'x'.repeat(241)}]};
  assert.equal(ui.validSnapshot(value).items.length,1);assert.equal(ui.validSnapshot({version:1,generatedAt:'invalid',items}),null);
});
test('ordinary home/chat particles map from real canvas coordinates including offsets and CSS scaling',()=>{
  const style={display:'block',visibility:'visible',opacity:'1'},container={classList:{contains:()=>true},parentElement:null};
  const win={innerWidth:800,innerHeight:600,getComputedStyle:()=>style};
  const doc={hidden:false,defaultView:win,body:{classList:{contains:()=>false}}};
  const canvas={id:'flowCanvas',ownerDocument:doc,parentElement:container,getBoundingClientRect:()=>({left:50,top:20,width:400,height:300})};
  const points=ui.particlePoints(canvas,container,[{x:100,y:80,alpha:.25},{x:80,y:90,alpha:.05},{x:200,y:300,alpha:.4,fadeA:0}],800,600);
  assert.deepEqual(points,[{id:'flowCanvas-0',x:100,y:60,brightness:.25}]);
  style.opacity='0';assert.equal(ui.particlePoints(canvas,container,[{x:100,y:80,alpha:.25}],800,600).length,0);
  style.opacity='1';doc.hidden=true;assert.equal(ui.particlePoints(canvas,container,[{x:100,y:80,alpha:.25}],800,600).length,0);
});
