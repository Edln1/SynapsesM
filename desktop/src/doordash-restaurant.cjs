'use strict';

const HOSTS=new Set(['doordash.com','www.doordash.com']);
function snapshot(page){return page?.page&&typeof page.page==='object'?page.page:page||{};}
function doorDashUrl(value,base){
  try{const url=new URL(value,base);return url.protocol==='https:'&&HOSTS.has(url.hostname)&&!url.username&&!url.password&&(!url.port||url.port==='443')?url:null;}catch{return null;}
}
function words(value){return String(value||'').normalize('NFKD').replace(/\p{M}/gu,'').toLowerCase().replace(/['\u2018\u2019\u02bc`]/g,'').replace(/[^\p{L}\p{N}]+/gu,' ').trim().split(/\s+/).filter(Boolean);}
function queryValue(value){return typeof value==='string'&&value.trim()&&value.trim().length<=160&&!/[\u0000-\u001f\u007f]/.test(value)?value.trim().replace(/\s+/g,' '):null;}
function restaurant(value,base){
  const url=doorDashUrl(value,base);if(!url)return null;
  let pathname;try{pathname=decodeURIComponent(url.pathname);}catch{return null;}
  const route=/^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?(store|business)\/([^/]+)\/?$/i.exec(pathname);
  if(!route)return null;
  const numeric=/^\d{1,20}$/.test(route[2]),slug=/^(.+)-(\d{1,20})$/.exec(route[2]);if(!numeric&&!slug)return null;
  const name=numeric?'':slug[1];
  return {url:url.href,kind:route[1].toLowerCase(),name:words(name).join(''),nameWords:words(name),id:numeric?route[2]:slug[2]};
}
function startsWithName(value,query){
  const target=words(query).join('');if(!target)return false;
  let prefix='';for(const word of words(value)){prefix+=word;if(prefix.length>=target.length)return prefix===target;}return false;
}
function doorDashSearchUrl(query){
  const value=queryValue(query);if(!value)return null;
  const encoded=encodeURIComponent(value).replace(/[!'()*]/g,char=>'%'+char.charCodeAt(0).toString(16).toUpperCase());
  return 'https://www.doordash.com/search/store/'+encoded+'/';
}
function doorDashBlocked(value){
  const page=snapshot(value),title=String(page.title||'').trim(),text=String(page.text||'').slice(0,5000);
  if(/^(?:just a moment[.!\u2026]*|access denied|request blocked|attention required!?(?:\s*[|\-]\s*cloudflare)?)$/i.test(title))return true;
  if(/\b(?:verify (?:that )?you are human|confirm you are human|human verification|robot or human|security verification|captcha challenge)\b/i.test(title))return true;
  if(/\bchecking if (?:the )?site connection is secure(?:d)?\b/i.test(title+' '+text))return true;
  if(/\b(?:verify (?:that )?you are (?:a )?human|confirm you are human|complete (?:the )?(?:security check|captcha)|checking your browser|enable javascript and cookies to continue)\b/i.test(text))return true;
  try{return /\/(?:cdn-cgi\/challenge|captcha)(?:[-/]|$)/i.test(new URL(page.url).pathname);}catch{return false;}
}
function selectDoorDashRestaurant(value,query){
  const page=snapshot(value),name=queryValue(query),base=doorDashUrl(page.url);if(!name||!base||doorDashBlocked(page))return null;
  const candidates=new Map();
  for(const link of [...(Array.isArray(page.controls)?page.controls:[]),...(Array.isArray(page.links)?page.links:[])]){
    if(!link||typeof link!=='object'||link.visible===false||link.hidden===true||link.disabled===true)continue;
    const href=typeof link.href==='string'?link.href:typeof link.url==='string'?link.url:null;
    if(!href)continue;const item=restaurant(href,base.href);if(!item)continue;
    const label=link.label||link.name||link.text||link.title||'';
    if(!startsWithName(label,name)&&!startsWithName(item.nameWords.join(' '),name))continue;
    const key=item.kind+':'+item.id;if(!candidates.has(key))candidates.set(key,item);
  }
  const matches=[...candidates.values()],store=matches.find(item=>item.kind==='store');
  if(store)return store.url;
  const brand=matches.find(item=>item.kind==='business'&&(!item.name||item.name===words(name).join('')));
  return brand?brand.url:null;
}
function verifyDoorDashRestaurant(value,expectedUrl){
  const page=snapshot(value);if(doorDashBlocked(page))return false;
  const actual=restaurant(page.url),expected=restaurant(expectedUrl);
  return !!(actual&&expected&&actual.kind===expected.kind&&(!actual.name||!expected.name||actual.name===expected.name)&&actual.id===expected.id);
}

module.exports={doorDashSearchUrl,selectDoorDashRestaurant,verifyDoorDashRestaurant,doorDashBlocked};
