'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { trustedSite, externalLink, audioRequest, chromeSender, downloadLink } = require('../src/policy.cjs');
test('trusted HTTPS site boundaries',()=>{
  for(const value of ['https://synapses.cloud/','https://www.synapses.cloud:443/index.html','https://SYNAPSES.CLOUD/a'])assert.equal(trustedSite(value),true,value);
  for(const value of ['http://synapses.cloud/','https://synapses.cloud.evil.test/','https://evil-synapses.cloud/','https://user@synapses.cloud/','https://synapses.cloud:444/','https://ava.synapses.cloud/','file:///C:/test','javascript:alert(1)','not a url'])assert.equal(trustedSite(value),false,value);
});
test('external links cannot invoke arbitrary local applications or credentials',()=>{
  for(const value of ['https://example.com/path','mailto:hello@example.com','tel:+16045550123'])assert.equal(externalLink(value),true,value);
  for(const value of ['http://example.com/','file:///C:/Windows/notepad.exe','javascript:alert(1)','ms-settings:','https://user:pass@example.com/','mailto:a@b.com%0d%0aBcc:x@y.com'])assert.equal(externalLink(value),false,value);
});
test('audio permission requires trusted top and main frame, audio only',()=>{
  const good={requestingUrl:'https://synapses.cloud/index.html',isMainFrame:true,mediaTypes:['audio'],securityOrigin:'https://synapses.cloud'};
  assert.equal(audioRequest('https://synapses.cloud/',good),true);
  for(const change of [{requestingUrl:'https://evil.test'},{isMainFrame:false},{mediaTypes:['audio','video']},{mediaTypes:['video']},{mediaTypes:[]},{securityOrigin:'https://evil.test'}])assert.equal(audioRequest('https://synapses.cloud/',{...good,...change}),false);
  assert.equal(audioRequest('https://evil.test/',good),false);
});
test('window controls accept only the packaged local main frame',()=>{
  const url='synapses-shell://app/index.html',frame={url},contents={mainFrame:frame};
  assert.equal(chromeSender({sender:contents,senderFrame:frame},contents,url),true);
  assert.equal(chromeSender({sender:{},senderFrame:frame},contents,url),false);
  assert.equal(chromeSender({sender:contents,senderFrame:{url}},contents,url),false);
  frame.url='https://synapses.cloud/';assert.equal(chromeSender({sender:contents,senderFrame:frame},contents,url),false);
});
test('user downloads permit trusted app exports, excluding foreign blobs and local schemes',()=>{
  for(const value of ['https://cdn.example.com/export.png','blob:https://synapses.cloud/123','blob:https://www.synapses.cloud/123'])assert.equal(downloadLink(value),true,value);
  for(const value of ['blob:https://evil.test/123','blob:null/123','file:///C:/test','mailto:test@example.com','http://synapses.cloud/file'])assert.equal(downloadLink(value),false,value);
});
