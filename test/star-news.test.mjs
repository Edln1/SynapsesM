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

function desktopFixture({width=1280,fine=true,hover=true,search='',avaMode=false}={}){
  const state={width,fine,hover,avaMode,fetches:0,created:0},timers=new Map(),frames=new Map(),observers=[];let timerId=0,frameId=0;
  function emitter(target){const listeners=new Map();return Object.assign(target,{listeners,addEventListener(type,fn){if(!listeners.has(type))listeners.set(type,new Set());listeners.get(type).add(fn);},removeEventListener(type,fn){listeners.get(type)?.delete(fn);},emit(type,event={}){for(const fn of [...(listeners.get(type)||[])])fn(event);}});}
  let doc;
  function element(tag){state.created++;const n=emitter({tagName:tag.toUpperCase(),children:[],style:{},attributes:new Map(),hidden:false,isConnected:true,parentElement:null,textContent:'',setAttribute(key,value){this.attributes.set(key,String(value));},append(...children){for(const c of children){c.parentElement=this;this.children.push(c);}},replaceChildren(...children){this.children=[];this.append(...children);},contains(target){return this===target||this.children.some(c=>c.contains(target));},closest(){return null;},getBoundingClientRect(){return{width:310,height:220,left:0,top:0};},querySelector(selector){for(const child of this.children){if(selector==='button'&&child.tagName==='BUTTON')return child;const found=child.querySelector(selector);if(found)return found;}return null;},focus(){doc.activeElement=this;},click(){this.emit('click',{target:this});},remove(){this.isConnected=false;if(this.parentElement)this.parentElement.children=this.parentElement.children.filter(c=>c!==this);}});return n;}
  const html={classList:{contains:name=>name==='ava-app-mode'&&state.avaMode}};
  doc=emitter({documentElement:html,hidden:false,createElement:element,elementFromPoint(){return this.body;}});doc.body=element('body');doc.activeElement=doc.body;state.created=0;
  const media=emitter({get matches(){return state.fine&&state.hover;}});
  const win=emitter({document:doc,location:{search},get innerWidth(){return state.width;},innerHeight:720,matchMedia:()=>media,setTimeout(fn){const id=++timerId;timers.set(id,fn);return id;},clearTimeout(id){timers.delete(id);},requestAnimationFrame(fn){const id=++frameId;frames.set(id,fn);return id;},cancelAnimationFrame(id){frames.delete(id);},fetch(){state.fetches++;throw Error('Tests must not fetch a provider.');},MutationObserver:class{constructor(callback){this.callback=callback;this.active=false;observers.push(this);}observe(){this.active=true;}disconnect(){this.active=false;}}});
  return{win,doc,media,state,timers,frames,observers,flushTimers(){const pending=[...timers.values()];timers.clear();for(const fn of pending)fn();},stepFrame(time){const pending=[...frames.values()];frames.clear();for(const fn of pending)fn(time);},observerChange(){for(const observer of observers)if(observer.active)observer.callback();}};
}
const desktopSnapshot={version:1,generatedAt:now.toISOString(),sources:[{id:'nvidia',checkedAt:now.toISOString(),status:'ok'}],items:parseRSS(rss([{}]),source,now)};
const starPoints=()=>[{id:'test-star',x:100,y:100}];

test('star news initializes only for a wide desktop with real hover and a fine primary pointer',()=>{
  for(const options of [{width:390},{width:899},{width:1280,fine:false},{width:1280,hover:false}]){
    const f=desktopFixture(options);assert.equal(ui.desktopAllowed(f.win),false);assert.equal(ui.init({window:f.win}),null);
    assert.equal(f.state.created,0);assert.equal(f.doc.body.children.length,0);assert.equal(f.win.listeners.size,0);assert.equal(f.state.fetches,0);assert.equal(f.observers.length,0);assert.equal(f.frames.size,0);
  }
  const desktop=desktopFixture();assert.equal(ui.desktopAllowed(desktop.win),true);
  const missingCapability=desktopFixture();delete missingCapability.win.matchMedia;assert.equal(ui.desktopAllowed(missingCapability.win),false);
});

test('Ava launch query and Ava app mode exclude even desktop-sized shells before DOM, listeners or data requests',()=>{
  for(const options of [{search:'?ava-app=1'},{search:'?welcome=1&ava-app=1'},{avaMode:true}]){
    const f=desktopFixture(options);assert.equal(ui.desktopAllowed(f.win),false);assert.equal(ui.init({window:f.win}),null);
    assert.equal(f.state.created,0);assert.equal(f.doc.body.children.length,0);assert.equal(f.win.listeners.size,0);assert.equal(f.state.fetches,0);
  }
});

test('desktop hover, mouse click and keyboard discovery work, while touch and pen taps cannot open news',()=>{
  const f=desktopFixture(),api=ui.init({window:f.win,snapshot:desktopSnapshot,getPoints:starPoints}),access=f.doc.body.children[0],card=f.doc.body.children[1];
  assert.ok(api);assert.equal(card.hidden,true);assert.equal(f.win.listeners.has('pointerdown'),false);assert.equal(f.win.listeners.has('touchend'),false);assert.equal(f.win.listeners.has('touchstart'),false);
  for(const pointerType of ['touch','pen']){f.win.emit('pointermove',{pointerType,clientX:100,clientY:100,buttons:0,target:f.doc.body});f.win.emit('pointerup',{pointerType,clientX:100,clientY:100,target:f.doc.body});f.flushTimers();assert.equal(card.hidden,true);}
  f.win.emit('pointermove',{pointerType:'mouse',clientX:100,clientY:100,buttons:0,target:f.doc.body});f.flushTimers();assert.equal(card.hidden,false);
  f.win.emit('mousedown',{target:f.doc.body});assert.equal(card.hidden,true);
  f.win.emit('pointerup',{pointerType:'mouse',button:0,clientX:100,clientY:100,target:f.doc.body});assert.equal(card.hidden,false);api.close();
  access.focus();api.open();assert.equal(card.hidden,false);assert.equal(access.attributes.get('aria-expanded'),'true');assert.equal(f.doc.activeElement.tagName,'BUTTON');
  f.win.emit('keydown',{key:'Escape'});assert.equal(card.hidden,true);assert.equal(f.doc.activeElement,access);api.destroy();assert.equal(f.state.fetches,0);
});

test('resizing to a phone removes the desktop card, discovery button and every interaction listener',async()=>{
  const f=desktopFixture(),api=ui.init({window:f.win,snapshot:desktopSnapshot,getPoints:starPoints});api.open();
  assert.equal(f.doc.body.children[1].hidden,false);f.state.width=390;f.win.emit('resize');
  assert.equal(f.doc.body.children.length,0);assert.equal(f.win.__synapsesStarNews,undefined);assert.equal([...f.win.listeners.values()].every(set=>set.size===0),true);assert.equal([...f.media.listeners.values()].every(set=>set.size===0),true);assert.equal(f.observers.every(o=>!o.active),true);assert.equal(f.frames.size,0);
  api.open();await api.refresh();assert.equal(f.doc.body.children.length,0);assert.equal(f.state.fetches,0);
});

test('loss of desktop pointer capability and later Ava mode activation safely tear down initialized news',()=>{
  const pointer=desktopFixture();ui.init({window:pointer.win,snapshot:desktopSnapshot,getPoints:starPoints});pointer.state.fine=false;pointer.media.emit('change');assert.equal(pointer.doc.body.children.length,0);assert.equal(pointer.win.__synapsesStarNews,undefined);
  const ava=desktopFixture();ui.init({window:ava.win,snapshot:desktopSnapshot,getPoints:starPoints});ava.state.avaMode=true;ava.observerChange();assert.equal(ava.doc.body.children.length,0);assert.equal(ava.win.__synapsesStarNews,undefined);
  const query=desktopFixture();ui.init({window:query.win,snapshot:desktopSnapshot,getPoints:starPoints});query.win.location.search='?ava-app=1';query.win.emit('popstate');assert.equal(query.doc.body.children.length,0);assert.equal(query.win.__synapsesStarNews,undefined);
});

test('marked stars are sparse, spatially separated, stable by actual ID and never synthetic points',()=>{
  const all=Array.from({length:50},(_,i)=>({id:'star-'+i,x:50+(i%10)*125,y:60+Math.floor(i/10)*125}));
  const chosen=ui.markedPoints(all,[],1280,720,99);assert.equal(chosen.length,7);assert.equal(chosen.every(p=>all.includes(p)),true);
  for(const a of chosen)for(const b of chosen)if(a!==b)assert.ok(Math.hypot(a.x-b.x,a.y-b.y)>=120);
  const moved=all.map(p=>({...p,x:p.x+1}));assert.deepEqual(ui.markedPoints(moved,chosen.map(p=>p.id),1280,720,99).map(p=>p.id),chosen.map(p=>p.id));
  assert.equal(ui.markedPoints([{id:'bad',x:NaN,y:100},{id:'edge',x:5,y:5}],[],1280,720).length,0);
});

test('silver ring markers track actual star coordinates at a capped rate and pause while hidden',()=>{
  const f=desktopFixture(),moving=[{id:'moving',x:100,y:100}],api=ui.init({window:f.win,snapshot:desktopSnapshot,getPoints:()=>moving}),marks=f.doc.body.children[2],ring=marks.children[0];
  assert.equal(marks.attributes.get('aria-hidden'),'true');assert.equal(ring.attributes.get('data-star-id'),'moving');assert.equal(ring.style.transform,'translate3d(100.00px,100.00px,0)');assert.equal(f.frames.size,1);
  f.stepFrame(0);moving[0].x=140;f.stepFrame(20);assert.equal(ring.style.transform,'translate3d(100.00px,100.00px,0)');f.stepFrame(80);assert.equal(ring.style.transform,'translate3d(140.00px,100.00px,0)');
  f.win.emit('pointermove',{pointerType:'mouse',clientX:140,clientY:100,buttons:0,target:f.doc.body});assert.match(ring.className,/is-hovered/);
  f.doc.hidden=true;f.doc.emit('visibilitychange');assert.equal(f.frames.size,0);assert.equal(marks.hidden,true);f.doc.hidden=false;f.doc.emit('visibilitychange');assert.equal(f.frames.size,1);assert.equal(marks.hidden,false);
  api.destroy();assert.equal(f.frames.size,0);assert.equal(f.doc.body.children.length,0);
});

test('stars covered by app controls are neither marked nor clickable',()=>{
  const f=desktopFixture(),control={closest:()=>true};f.doc.elementFromPoint=()=>control;
  const api=ui.init({window:f.win,snapshot:desktopSnapshot,getPoints:starPoints}),card=f.doc.body.children[1],marks=f.doc.body.children[2];assert.equal(marks.children.length,0);assert.equal(marks.hidden,true);
  f.win.emit('pointerup',{pointerType:'mouse',button:0,clientX:100,clientY:100,target:control});assert.equal(card.hidden,true);api.open();assert.equal(card.hidden,true);api.destroy();
});
