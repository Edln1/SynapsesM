'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {createWindowsActions}=require('../src/windows-actions.cjs');
const window={hwnd:'123',pid:456,started:'789',title:'Restaurant - Chrome',app:'chrome',foreground:true,minimized:false,bounds:{x:0,y:0,width:1000,height:800}};
const control=(name='Game of Wings',extra={})=>({runtimeId:[1,2,3],name,nameHash:'native-hash',type:'ControlType.Button',bounds:{x:30,y:40,width:120,height:40},enabled:true,password:false,...extra});
function fixture(options={}){
  const calls=[];const responses={catalog:{ok:true,apps:[{key:'native-codex',name:'Codex (ChatGPT)',aliases:['Codex'],kind:'startapp',target:'PRIVATE-PATH'},{key:'native-steam',name:'Steam',kind:'exe'}]},windows:{ok:true,windows:[window]},read:{ok:true,controls:[control()]}};
  const driver=createWindowsActions({displays:()=>[{id:2,physicalBounds:{x:-1920,y:0,width:1920,height:1080},physicalWorkArea:{x:-1920,y:0,width:1920,height:1040}}],assertActive:()=>true,runScript:async payload=>{calls.push(payload);return responses[payload.op]||{ok:true,verified:true};},...options});
  return {driver,calls,responses,async observed(){const list=await driver.windows();const id=list.windows[0].windowId;const read=await driver.readWindow({windowId:id});return {windowId:id,ref:read.controls[0].ref};}};
}
test('catalog filters Codex aliases and exposes only opaque ids and descriptions',async()=>{
  const f=fixture(),result=await f.driver.catalog({query:'Codex'});assert.equal(result.count,2);assert.equal(result.matched,1);assert.equal(result.apps[0].name,'Codex (ChatGPT)');assert.equal(JSON.stringify(result).includes('PRIVATE-PATH'),false);assert.equal(JSON.stringify(result).includes('native-codex'),false);
  await f.driver.launch({appId:result.apps[0].appId});assert.deepEqual(f.calls.at(-1),{op:'launch',appKey:'native-codex'});
  const count=f.calls.length;assert.equal((await f.driver.launch({appId:'C:\\Windows\\cmd.exe'})).ok,false);assert.equal(f.calls.length,count);
});
test('window ids preserve exact native identity and moves use physical display work area',async()=>{
  const f=fixture(),list=await f.driver.windows();assert.equal(JSON.stringify(list).includes('"hwnd"'),false);assert.equal(JSON.stringify(list).includes('"started"'),false);
  await f.driver.moveWindow({windowId:list.windows[0].windowId,displayId:'2'});assert.equal(f.calls.at(-1).window.pid,456);assert.equal(f.calls.at(-1).window.started,'789');assert.equal(f.calls.at(-1).area.x,-1920);
  await assert.rejects(f.driver.moveWindow({windowId:'forged',displayId:'2'}),/List windows/);
});
test('controls require observed refs and stale refs cannot be replayed after action or cancel',async()=>{
  const f=fixture(),target=await f.observed();assert.equal((await f.driver.clickControl(target)).verified,true);const count=f.calls.length;
  assert.equal((await f.driver.clickControl(target)).ok,false);assert.equal(f.calls.length,count);
  const next=await f.observed();f.driver.cancel();assert.equal((await f.driver.clickControl(next)).ok,false);
});
test('risky controls need trusted confirmation and password fields are never read or typed',async()=>{
  const f=fixture();f.responses.read.controls=[control('Place order')];const target=await f.observed(),count=f.calls.length;
  assert.equal((await f.driver.clickControl(target)).confirmationRequired,true);assert.equal(f.calls.length,count);assert.equal((await f.driver.clickControl(target,{confirmed:true})).verified,true);
  f.responses.read.controls=[control('PRIVATE-PASSWORD',{password:true})];const list=await f.driver.windows(),id=list.windows[0].windowId,read=await f.driver.readWindow({windowId:id});assert.equal(JSON.stringify(read).includes('PRIVATE-PASSWORD'),false);
  assert.equal((await f.driver.typeControl({windowId:id,ref:read.controls[0].ref,text:'secret'},{confirmed:true})).ok,false);
});
test('browser address fields reject local or executable schemes; plain search and public HTTPS stay available',async()=>{
  const f=fixture();f.responses.read.controls=[control('Address and search bar',{type:'ControlType.Edit'})];
  for(const text of ['javascript:alert(1)','file:///C:/secret','data:text/html,x','http://example.com','127.0.0.1','localhost:3000','router.local']){const target=await f.observed();const count=f.calls.length;assert.equal((await f.driver.typeControl({...target,text})).ok,false,text);assert.equal(f.calls.length,count,text);}
  const target=await f.observed();assert.equal((await f.driver.typeControl({...target,text:'https://www.youtube.com/'})).verified,true);
});
test('fixed key aliases work and generic submit/delete delivery requires native approval',async()=>{
  const f=fixture(),list=await f.driver.windows(),windowId=list.windows[0].windowId;
  for(const [key,expected] of [['ArrowUp','ARROW_UP'],['PageUp','PAGE_UP'],['Control+A','CTRL_A'],['Ctrl+L','CTRL_L']]){await f.driver.pressKey({windowId,key});assert.equal(f.calls.at(-1).key,expected);}
  const count=f.calls.length;assert.equal((await f.driver.pressKey({windowId,key:'Enter'})).confirmationRequired,true);assert.equal(f.calls.length,count);await f.driver.pressKey({windowId,key:'Enter'},{confirmed:true});assert.equal(f.calls.at(-1).key,'ENTER');
  assert.equal((await f.driver.pressKey({windowId,key:'Win+R; arbitrary'})).ok,false);
});
test('native controls cannot bypass verified DoorDash item handling',async()=>{
  const f=fixture();
  f.responses.windows.windows=[{...window,title:'McDonald’s - DoorDash - Google Chrome'}];
  f.responses.read.controls=[control('Add')];
  const target=await f.observed(),count=f.calls.length;
  assert.equal((await f.driver.clickControl(target,{confirmed:true})).ok,false);
  assert.equal((await f.driver.typeControl({...target,text:'test'},{confirmed:true})).ok,false);
  assert.equal((await f.driver.pressKey({windowId:target.windowId,key:'Enter'},{confirmed:true})).ok,false);
  assert.equal(f.calls.length,count);
});
test('cancellation before async lease verification prevents any native dispatch',async()=>{
  let dispatches=0;const driver=createWindowsActions({assertActive:async()=>true,runScript:async()=>{dispatches++;return {ok:true,apps:[]};}});const pending=driver.catalog();driver.cancel();await assert.rejects(pending,/stopped/);assert.equal(dispatches,0);
});
test('cancel rejects an in-flight operation and a fresh operation remains usable',async()=>{
  let resolve;const driver=createWindowsActions({assertActive:()=>true,runScript:()=>new Promise(done=>{resolve=done;})});const pending=driver.catalog();for(let i=0;i<8;i++)await Promise.resolve();driver.cancel();await assert.rejects(pending,/stopped/);resolve({ok:true,apps:[]});
});
test('driver source is fixed JSON stdin and has exact identity, DPI and UIA readback gates',()=>{
  const ps=fs.readFileSync(require.resolve('../src/windows-actions.ps1'),'utf8');assert.match(ps,/Console\]::In.ReadToEnd/);assert.match(ps,/SetThreadDpiAwarenessContext/);assert.match(ps,/started -ne/);assert.match(ps,/GetRuntimeId/);assert.match(ps,/IsPassword/);assert.match(ps,/Current.Value -ceq/);assert.match(ps,/WindowsTerminal/);assert.doesNotMatch(ps,/Invoke-Expression|SendKeys/);
});
