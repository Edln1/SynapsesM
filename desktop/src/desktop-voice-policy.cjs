'use strict';
const net = require('node:net');
const sites = Object.freeze({browser:'https://www.google.com/',youtube:'https://www.youtube.com/','you tube':'https://www.youtube.com/',doordash:'https://www.doordash.com/','door dash':'https://www.doordash.com/',facebook:'https://www.facebook.com/',nvidia:'https://www.nvidia.com/',linkedin:'https://www.linkedin.com/',google:'https://www.google.com/',gmail:'https://mail.google.com/',github:'https://github.com/',reddit:'https://www.reddit.com/',instagram:'https://www.instagram.com/',twitter:'https://x.com/',x:'https://x.com/',synapses:'https://synapses.cloud/'});
function publicWebUrl(value) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if(url.protocol!=='https:'||url.username||url.password||(url.port&&url.port!=='443')||net.isIP(host)||host.includes(':')||host.length>253)return null;
    if(/(?:^|\.)(?:localhost|local|internal|lan|home|test|invalid|onion|example)$/.test(host))return null;
    const labels=host.split('.');
    if(labels.length<2||!labels.every(x=>/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(x))||!(/^[a-z]{2,63}$/.test(labels.at(-1))||/^xn--[a-z0-9-]+$/.test(labels.at(-1))))return null;
    return url.href;
  } catch {return null;}
}
function publicAddress(value) {
  const family=net.isIP(value);
  if(family===6)return /^[23]/i.test(value)&&!/^2001:db8(?::|$)/i.test(value);
  if(family!==4)return false;
  const [a,b,c]=value.split('.').map(Number);
  return !(a===0||a===10||a===127||a>=224||(a===100&&b>=64&&b<=127)||(a===169&&b===254)||(a===172&&b>=16&&b<=31)||(a===192&&(b===168||b===0||(b===0&&c===2)))||(a===198&&(b===18||b===19||(b===51&&c===100)))||(a===203&&b===0&&c===113));
}
function normalizeVoiceCommand(text) {
  return text.trim().replace(/^(?:hey\s+)?ava(?=\s|[,：:])\s*[,：:]?\s*/i,'').replace(/^(?:please\s+)?(?:(?:are\s+you|would\s+you\s+be)\s+able\s+to\s+|(?:can|could|would|will)\s+you\s+(?:please\s+)?)/i,'').replace(/^please\s+/i,'');
}

function explicitWebUrl(value) {
  if (typeof value !== 'string') return null;
  if (/^https:\/\//i.test(value)) return publicWebUrl(value);
  if (/^[^\s/:?#]+\.[^\s/:?#]+(?:[/?#]\S*)?$/.test(value)) return publicWebUrl('https://' + value);
  return null;
}

function knownSite(value) {
  const name = value.trim().toLowerCase().replace(/^the\s+/, '').replace(/\s+website$/, '');
  return Object.hasOwn(sites, name) ? sites[name] : null;
}

function isPageReadRequest(text) {
  if (typeof text !== 'string') return false;
  const command = normalizeVoiceCommand(text).replace(/[\s,]+(?:for me(?: please)?|please)[.!?]*$/i, '').replace(/[.!?]+$/, '').trim();
  return /^(?:(?:what(?:['’]s| is) (?:on|in)|what do you see (?:on|in)|what can you see (?:on|in)|tell me what(?:['’]s| is) (?:on|in)|can you see what(?:['’]s| is) (?:on|in)) (?:this|the(?: current)?) (?:page|screen|window)|(?:read|describe|summarize) (?:this|the(?: current)?) (?:page|screen|window)|what do you see here)$/i.test(command);
}

function doorDashPreference(text) {
  const answer=normalizeVoiceCommand(text).toLowerCase().replace(/[.,!?]+/g,' ').trim().replace(/\s+/g,' ');
  if(/^(?:(?:pick|choose|open|go to|just) )?(?:(?:any(?: one)?|whichever)(?: or (?:the )?(?:closest|nearest)(?: one)?)?|(?:the )?(?:closest|nearest)(?: (?:one|location))?(?: to me)?|whatever is (?:closest|nearest))(?: please)?$/.test(answer)) {
    return /\b(?:closest|nearest)\b/.test(answer)?'closest':'any';
  }
  return null;
}

function directWebPlan(text) {
  if (typeof text !== 'string' || text.length > 500 || /[\u0000-\u001f\u007f]/.test(text)) return null;
  const command = normalizeVoiceCommand(text).replace(/\s+(?:for me(?: please)?|please)[.!?]*$/i, '').replace(/[.!?]+$/, '').trim();
  const visit = /^(?:open(?:\s+up)?|visit|go\s+to)\s+(.+)$/i.exec(command);
  const explicit=visit&&!/\s/.test(visit[1])?explicitWebUrl(visit[1]):null;
  if(explicit)return {url:explicit,message:'Opened '+new URL(explicit).hostname+'.'};
  const sequence = /(?:\bthen\b|\band\s+(?:also\s+)?(?:open|go to|search|find|look|click|play|show|order|add|select|pick|read|type|buy|log|sign|check|see|ask|describe|summarize|tell)\b|[;,]\s*(?:open|search|find|click|play|order)\b)/i;
  const restaurantCommand = command.replace(/[\s,.;:]+(?:and(?:\s+then)?|then)\s+(?:go (?:there|to it|to (?:its|their) page)|take me there|(?:open|click(?: on)?) (?:it|the (?:restaurant|listing|store|(?:first )?result)))$/i, '');
  const scopedRestaurant = /^(?:search(?:\s+(?:for|up))?|look (?:up|for)|find|open|go to|take me to|bring up|pull up)\s+(.+?)\s+(?:on|in|using)\s+(?:the\s+)?door\s*dash(?:\s+(?:app|website))?(?:\s+please)?$/i.exec(restaurantCommand);
  const doorDashFirst = /^(?:(?:open(?: up)?|visit|go (?:to|on))\s+(?:the\s+)?door\s*dash(?:\s+(?:app|website))?[\s,.;:]+(?:(?:and(?:\s+then)?|then)\s+)?(?:search(?:\s+(?:for|up))?|find|look (?:up|for)|go to|open)|search\s+(?:on\s+)?(?:the\s+)?door\s*dash(?:\s+(?:app|website))?\s+for)\s+(.+)$/i.exec(restaurantCommand);
  const namedMcDonalds = /^(?:(?:i (?:want|need) (?:you )?to|try to|just)\s+)?(?:open|find|search|look|go|take|pull|bring)\b/i.test(restaurantCommand)&&/\bdoor\s*dash\b/i.test(restaurantCommand)&&/\bmc\s*donald['’]?\s*s\b/i.test(restaurantCommand)&&!sequence.test(restaurantCommand)&&!/\b(?:and|order|buy|add to cart|pay|checkout)\b/i.test(restaurantCommand);
  const restaurant = (scopedRestaurant || doorDashFirst)?.[1].trim() || (namedMcDonalds ? 'McDonald’s' : '');
  if (restaurant && restaurant.length <= 100 && !sequence.test(restaurant)) {
    const closest=/^(?:the\s+)?(?:closest|nearest)\s+/i.exec(restaurant);
    const query=closest?restaurant.slice(closest[0].length):restaurant;
    const openListing = !!closest || restaurantCommand !== command || /^(?:open|go to|take me to|bring up|pull up)\s+/i.test(scopedRestaurant?.[0] || '');
    return {doorDashRestaurant:{query,openListing,preference:closest?'closest':undefined}};
  }
  if (/^search\s+(?:on\s+)?google$/i.test(command)) return {url:sites.google,message:'Opened Google.'};
  const search = /^(?:search(?:\s+on)?\s+(google|you\s*tube|door\s*dash)\s+for\s+|google\s+|search(?:\s+the\s+web)?\s+for\s+|look\s+up\s+)(.+)$/i.exec(command);
  const visitThenSearch = visit && /^(.+?)\s+(?:and(?:\s+then)?|then)\s+search\s+(?:for\s+)?(.+)$/i.exec(visit[1]);
  let target = visitThenSearch ? visitThenSearch[1] : search?.[1];
  let query = visitThenSearch ? visitThenSearch[2] : search?.[2];
  if (query) {
    if (sequence.test(query)) return null;
    if (!target && /^google\s+/i.test(command)) target = 'Google';
    if (!target) {
      const scoped = /^(.*?)\s+(?:on|in|using)\s+(google|you\s*tube|door\s*dash)$/i.exec(query);
      if (scoped) [, query, target] = scoped;
      else if (/\s+(?:on|in|using)\s+(?:this\b|the\s+(?:current|open)\b|(?:chrome|edge|firefox)\b|\S+\.\S+$)/i.test(query)) return null;
    }
    const site = target ? knownSite(target) : sites.google;
    if (site === sites.google) return {url:site+'search?'+new URLSearchParams({q:query}),message:'Opened Google search results.'};
    if (site === sites.youtube) return {url:site+'results?'+new URLSearchParams({search_query:query}),message:'Opened YouTube search results.'};
    return null;
  }
  if (!visit || sequence.test(visit[1])) return null;
  const url = knownSite(visit[1]);
  return url ? {url,message:'Opened '+new URL(url).hostname+'.'} : null;
}

function parseVoiceCommand(text) {
  if(typeof text!=='string')return {handled:true,ok:false,reasonCode:'command_parse_invalid',message:'Say a short website or web-search command.'};
  const command=normalizeVoiceCommand(text);
  if(/^(?:stop(?:\s+(?:pc|computer|desktop))?(?:\s+voice(?:\s+control)?)?|stop\s+listening)[.!?]*$/i.test(command))return {handled:true,ok:true,type:'stop',message:'PC voice is stopped.'};
  const youtube=/^(?:search(?:\s+on)?\s+you\s*tube\s+for\s+([\s\S]+)|(?:go\s+to|open(?:\s+up)?|visit)\s+(?:the\s+)?you\s*tube(?:\s+website)?\s+and\s+search\s+for\s+([\s\S]+)|play\s+([\s\S]+)\s+on\s+you\s*tube)[.!?]*$/i.exec(command);
  if(youtube){const query=(youtube[1]||youtube[2]||youtube[3]||'').trim();if(!query)return {handled:true,ok:false,reasonCode:'command_missing_target',message:'Say what you want to find on YouTube.'};if(query.length>500||/[\u0000-\u001f\u007f]/.test(text))return {handled:true,ok:false,reasonCode:'command_parse_invalid',message:'Say a shorter YouTube search.'};return {handled:true,ok:true,type:'open',url:'https://www.youtube.com/results?'+new URLSearchParams({search_query:query}),message:'Showing YouTube results. Choose a video to play.'};}
  if(/^(?:search(?:\s+on)?\s+you\s*tube\s+for|(?:go\s+to|open(?:\s+up)?|visit)\s+(?:the\s+)?you\s*tube(?:\s+website)?\s+and\s+search\s+for|play\s+on\s+you\s*tube)\s*[.!?]*$/i.test(command))return {handled:true,ok:false,reasonCode:'command_missing_target',message:'Say what you want to find on YouTube.'};
  const open=/^(?:open(?:\s+up)?|visit|go\s+to)\s+(.+)$/i.exec(command);
  const search=/^search\s+for\s+(.+)$/i.exec(command);
  if(!open&&!search){if(/^(?:open|visit|go\s+to|search)(?:\s|$|[.!?])/i.test(command))return {handled:true,ok:false,reasonCode:/^(?:open(?:\s+up)?|visit|go\s+to|search(?:\s+for)?)\s*[.!?]*$/i.test(command)?'command_missing_target':'command_parse_invalid',message:'Say “open YouTube” or “search for …”.'};return {handled:false,ok:false,message:''};}
  if(text.length>500||/[\u0000-\u001f\u007f]/.test(text))return {handled:true,ok:false,reasonCode:'command_parse_invalid',message:'Say a shorter website or web-search command.'};
  if(search){const query=search[1].trim();if(!query)return {handled:true,ok:false,reasonCode:'command_missing_target',message:'Say what you want to search for.'};return {handled:true,ok:true,type:'open',url:'https://www.google.com/search?'+new URLSearchParams({q:query}),message:'Searching the web.'};}
  let target=open[1].trim().replace(/[.!?]+$/,'').replace(/\s+(?:for\s+me(?:\s+please)?|please(?:\s+for\s+me)?)$/i,'').replace(/[.!?]+$/,'');
  if(!target)return {handled:true,ok:false,reasonCode:'command_missing_target',message:'Say which public website you want to open.'};
  const named=sites[target.toLowerCase().replace(/^the\s+/,'').replace(/\s+website$/,'')];
  const url=named||publicWebUrl(/^[a-z][a-z0-9+.-]*:/i.test(target)?target:'https://'+target);
  if(!url||(!named&&/\s/.test(target)))return {handled:true,ok:false,reasonCode:'command_target_invalid',message:'I can open public HTTPS websites. Local addresses, files and computer commands are not supported.'};
  return {handled:true,ok:true,type:'open',url,message:'Opening '+new URL(url).hostname+'.'};
}
function captureAllowed({freshInput,visible,minimized,lease,startedAt,now,hiddenStart=false}) {
  if(lease?.enabled&&lease?.listening)return true;
  if(lease?.enabled&&hiddenStart&&now>=startedAt&&now-startedAt<30000)return true;
  return !!visible&&!minimized&&(!!freshInput||!!lease?.enabled&&now>=startedAt&&now-startedAt<30000);
}
function captureApprovalCurrent(before,current,allowed) {
  return !!allowed&&before.generation===current.generation&&before.sessionId===current.sessionId&&before.frame===current.frame;
}
module.exports={parseVoiceCommand,directWebPlan,doorDashPreference,isPageReadRequest,explicitWebUrl,publicWebUrl,publicAddress,captureAllowed,captureApprovalCurrent};
