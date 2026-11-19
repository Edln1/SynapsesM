'use strict';
const net = require('node:net');
const sites = Object.freeze({youtube:'https://www.youtube.com/',facebook:'https://www.facebook.com/',nvidia:'https://www.nvidia.com/',linkedin:'https://www.linkedin.com/',google:'https://www.google.com/',gmail:'https://mail.google.com/',github:'https://github.com/',reddit:'https://www.reddit.com/',instagram:'https://www.instagram.com/',twitter:'https://x.com/',x:'https://x.com/',synapses:'https://synapses.cloud/'});
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
function parseVoiceCommand(text) {
  if(typeof text!=='string')return {handled:true,ok:false,message:'Say a short website or web-search command.'};
  const wake=/^\s*(?:hey\s+)?ava(?=\s|[,：:])\s*[,：:]?\s*(.+)$/i.exec(text);
  if(!wake)return {handled:false,ok:false,message:''};
  const command=wake[1].trim();
  if(/^(?:stop(?:\s+(?:pc|computer|desktop))?(?:\s+voice(?:\s+control)?)?|stop\s+listening)[.!?]*$/i.test(command))return {handled:true,ok:true,type:'stop',message:'PC voice is stopped.'};
  const open=/^(?:open|visit|go\s+to)\s+(.+)$/i.exec(command);
  const search=/^search\s+for\s+(.+)$/i.exec(command);
  if(!open&&!search){if(/^(?:open|visit|go\s+to|search)(?:\s|$)/i.test(command))return {handled:true,ok:false,message:'Say “Ava, open youtube.com” or “Ava, search for …”.'};return {handled:false,ok:false,message:''};}
  if(text.length>500||/[\u0000-\u001f\u007f]/.test(text))return {handled:true,ok:false,message:'Say a shorter website or web-search command.'};
  if(search){const query=search[1].trim();if(!query)return {handled:true,ok:false,message:'Say what you want to search for.'};return {handled:true,ok:true,type:'open',url:'https://www.google.com/search?'+new URLSearchParams({q:query}),message:'Searching the web.'};}
  let target=open[1].trim().replace(/[.!?]+$/,'');
  const named=sites[target.toLowerCase().replace(/^the\s+/,'').replace(/\s+website$/,'')];
  const url=named||publicWebUrl(/^[a-z][a-z0-9+.-]*:/i.test(target)?target:'https://'+target);
  if(!url||(!named&&/\s/.test(target)))return {handled:true,ok:false,message:'I can open public HTTPS websites. Local addresses, files and computer commands are not supported.'};
  return {handled:true,ok:true,type:'open',url,message:'Opening '+new URL(url).hostname+'.'};
}
function captureAllowed({freshInput,visible,minimized,lease,startedAt,now}) {
  if(lease?.enabled&&lease?.listening)return true;
  return !!visible&&!minimized&&(!!freshInput||!!lease?.enabled&&now>=startedAt&&now-startedAt<30000);
}
module.exports={parseVoiceCommand,publicWebUrl,publicAddress,captureAllowed};
