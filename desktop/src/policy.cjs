'use strict';

const TRUSTED_HOSTS = new Set(['synapses.cloud', 'www.synapses.cloud']);
function trustedSite(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && TRUSTED_HOSTS.has(url.hostname) && !url.username && !url.password && (!url.port || url.port === '443');
  } catch { return false; }
}
function externalLink(value) {
  try {
    const url = new URL(value);
    if (url.username || url.password) return false;
    if (url.protocol === 'https:') return !!url.hostname;
    return ['mailto:', 'tel:'].includes(url.protocol) && !!url.pathname && !/[\r\n]/.test(decodeURIComponent(value));
  } catch { return false; }
}
function audioRequest(topUrl, details = {}) {
  return trustedSite(topUrl) && trustedSite(details.requestingUrl) && details.isMainFrame === true &&
    (!details.securityOrigin || trustedSite(details.securityOrigin)) &&
    Array.isArray(details.mediaTypes) && details.mediaTypes.length === 1 && details.mediaTypes[0] === 'audio';
}
function downloadLink(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'blob:' ? trustedSite(url.origin) : url.protocol === 'https:' && externalLink(value);
  } catch { return false; }
}
function chromeSender(event, contents, expectedUrl) {
  return !!event && event.sender === contents && event.senderFrame === contents.mainFrame && event.senderFrame.url === expectedUrl;
}
module.exports = { trustedSite, externalLink, audioRequest, chromeSender, downloadLink };
