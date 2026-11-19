'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createTrayLifecycle}=require('../src/tray-lifecycle.cjs');
function fixture(stopVoice=async()=>true,options={}){const events=[];const lifecycle=createTrayLifecycle({stopVoice:async()=>{events.push('stop');return stopVoice();},hideWindow:()=>events.push('hide'),restoreWindow:()=>events.push('restore'),closeContents:()=>events.push('close'),...options});return {events,lifecycle};}
test('X waits for voice cleanup and hides without closing the document',async()=>{
  let complete;const f=fixture(()=>new Promise(resolve=>{complete=resolve;}));const hiding=f.lifecycle.hide();await Promise.resolve();assert.deepEqual(f.events,['stop']);complete(true);assert.equal(await hiding,true);assert.deepEqual(f.events,['stop','hide']);assert.equal(f.lifecycle.isQuitting(),false);
});
test('cleanup failure leaves the window visible and a later hide can retry',async()=>{
  let succeeds=false;const f=fixture(async()=>succeeds);assert.equal(await f.lifecycle.hide(),false);assert.deepEqual(f.events,['stop']);succeeds=true;assert.equal(await f.lifecycle.hide(),true);assert.deepEqual(f.events,['stop','stop','hide']);
});
test('restore cancels an in-flight hide rather than hiding again afterward',async()=>{
  let complete;const f=fixture(()=>new Promise(resolve=>{complete=resolve;}));const hiding=f.lifecycle.hide();await Promise.resolve();f.lifecycle.restore();complete(true);assert.equal(await hiding,false);assert.deepEqual(f.events,['stop','restore']);
});
test('explicit Quit closes after cleanup and suppresses duplicate quit requests',async()=>{
  const f=fixture();const first=f.lifecycle.quit(),second=f.lifecycle.quit();await Promise.all([first,second]);assert.deepEqual(f.events,['restore','stop','close']);assert.equal(f.lifecycle.isQuitting(),true);assert.equal(await f.lifecycle.hide(),false);
});
test('unsaved-work cancellation resets quit state and allows hiding or quitting again',async()=>{
  const f=fixture();await f.lifecycle.quit();f.lifecycle.cancelQuit();assert.equal(f.lifecycle.isQuitting(),false);await f.lifecycle.hide();await f.lifecycle.quit();assert.deepEqual(f.events,['restore','stop','close','restore','stop','hide','restore','stop','close']);
});
test('Quit can still release the document if voice cleanup rejects',async()=>{
  const f=fixture(async()=>{throw Error('renderer stopped');});assert.equal(await f.lifecycle.quit(),true);assert.deepEqual(f.events,['restore','stop','close']);
});
test('Quit does not stall before document close when voice cleanup never responds',async()=>{
  const f=fixture(()=>new Promise(()=>{}),{quitCleanupTimeoutMs:1});assert.equal(await f.lifecycle.quit(),true);assert.deepEqual(f.events,['restore','stop','close']);
});
test('a live opt-in hide callback never replaces the mandatory Quit cleanup',async()=>{
  const events=[];const lifecycle=createTrayLifecycle({stopVoice:async()=>{events.push('keep-live');return true},stopBeforeQuit:async()=>{events.push('revoke-live');return true},hideWindow:()=>events.push('hide'),restoreWindow:()=>events.push('restore'),closeContents:()=>events.push('close')});await lifecycle.hide();await lifecycle.quit();assert.deepEqual(events,['keep-live','hide','restore','revoke-live','close']);
});
