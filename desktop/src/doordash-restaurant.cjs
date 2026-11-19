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
function doorDashUnavailable(value){
  const page=snapshot(value),title=String(page.title||'').trim(),text=String(page.text||'').slice(0,6000);
  const content=title+'\n'+text;
  if(/^(?:(?:404\s*[-:|]?\s*)?(?:page|store|restaurant) (?:not found|unavailable|no longer available)|404(?:\s*[-:|]\s*not found)?|not found)(?:[.!]?\s*(?:[-|]\s*DoorDash)?)?$/i.test(title))return true;
  return /\b(?:page not found|(?:we (?:couldn['\u2018\u2019]t|could not|cannot|can['\u2018\u2019]t)|unable to) find (?:this|that|the) (?:page|store|restaurant)|(?:this|that|the) (?:page|store|restaurant) (?:(?:is |was |has been )?(?:not found|(?:currently |temporarily )?(?:unavailable|not available)|no longer available|(?:has been )?removed)|(?:doesn['\u2018\u2019]t|does not) exist|isn['\u2018\u2019]t available)|(?:the )?page you(?:['\u2018\u2019]re| are) looking for (?:doesn['\u2018\u2019]t exist|(?:is |was )?(?:not found|unavailable|no longer available|removed)))\b/i.test(content);
}
function distanceMeters(label){
  const match=/(?:^|[^\p{L}\p{N}.])(\d+(?:\.\d+)?)\s*(miles?|mi|kilomet(?:er|re)s?|km|met(?:er|re)s?|m)\b/iu.exec(label);
  if(!match)return null;
  const value=Number(match[1]),unit=match[2].toLowerCase();
  const meters=value*(unit==='mi'||unit.startsWith('mile')?1609.344:unit==='km'||unit.startsWith('kilo')?1000:1);
  return Number.isFinite(meters)&&meters>=0&&meters<=1000000?Math.round(meters):null;
}
function listDoorDashRestaurants(value,query){
  const page=snapshot(value),name=queryValue(query),base=doorDashUrl(page.url);if(!name||!base||doorDashBlocked(page)||doorDashUnavailable(page))return [];
  const candidates=new Map();
  for(const link of [...(Array.isArray(page.controls)?page.controls:[]),...(Array.isArray(page.links)?page.links:[])]){
    if(!link||typeof link!=='object'||link.visible===false||link.hidden===true||link.disabled===true)continue;
    const href=typeof link.href==='string'?link.href:typeof link.url==='string'?link.url:null;
    if(!href)continue;const item=restaurant(href,base.href);if(!item)continue;
    const label=String(link.label||link.name||link.text||link.title||'').slice(0,500);
    if(!startsWithName(label,name)&&!startsWithName(item.nameWords.join(' '),name))continue;
    const key=item.kind+':'+item.id;
    if(!candidates.has(key))candidates.set(key,{url:item.url,kind:item.kind,id:item.id,label,rank:candidates.size,distanceMeters:distanceMeters(label)});
    else if(candidates.get(key).distanceMeters===null){
      const distance=distanceMeters(label);if(distance!==null)candidates.get(key).distanceMeters=distance;
    }
  }
  return [...candidates.values()];
}
function selectDoorDashRestaurant(value,query){
  const matches=listDoorDashRestaurants(value,query),store=matches.find(item=>item.kind==='store');
  if(store)return store.url;
  const brand=matches.find(item=>item.kind==='business'&&(!restaurant(item.url).name||restaurant(item.url).name===words(query).join('')));
  return brand?brand.url:null;
}
function verifyDoorDashRestaurant(value,expectedUrl){
  const page=snapshot(value);if(doorDashBlocked(page)||doorDashUnavailable(page))return false;
  const actual=restaurant(page.url),expected=restaurant(expectedUrl);
  return !!(actual&&expected&&actual.kind===expected.kind&&(!actual.name||!expected.name||actual.name===expected.name)&&actual.id===expected.id);
}

function isDoorDashRestaurant(value,query){
  const page=snapshot(value),listing=restaurant(page.url);
  return !!listing&&!doorDashBlocked(page)&&!doorDashUnavailable(page)&&(!query||[listing.nameWords.join(' '),page.title,page.text].some(label=>startsWithName(label,query)));
}
function isDoorDashPage(value){return !!doorDashUrl(snapshot(value).url);}

module.exports={doorDashSearchUrl,listDoorDashRestaurants,selectDoorDashRestaurant,verifyDoorDashRestaurant,isDoorDashRestaurant,isDoorDashPage,doorDashBlocked,doorDashUnavailable};
