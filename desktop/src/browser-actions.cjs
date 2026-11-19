'use strict';
const crypto = require('node:crypto');
const dns = require('node:dns').promises;
const { publicWebUrl, publicAddress } = require('./desktop-voice-policy.cjs');

const WORLD = 1041;
const TOOLS = Object.freeze({
  open_url: ['url'], read_page: ['foregroundOnly'], click: ['ref'], type: ['ref', 'text'],
  press: ['ref', 'key'], scroll: ['direction', 'amount'], back: [], media_play: ['ref']
});
const KEYS = new Set(['Enter', 'Escape', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'Backspace']);

// This trusted function runs in an isolated world. Model arguments are only JSON
// data; the model cannot supply code, selectors, or a DOM node identifier.
async function pageOperation(args) {
  const key = '__synapsesControlledBrowserState';
  const state = globalThis[key];
  const clip = (value, limit) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
  const label = el => clip(el.getAttribute('aria-label') || el.getAttribute('title') || el.innerText || el.getAttribute('placeholder') || el.getAttribute('name') || el.tagName, 160);
  const dialogSelector = 'dialog[open],[role="dialog"],[aria-modal="true"]';
  const headingSelector = 'h1,h2,h3,h4,h5,h6,[role="heading"]';
  const kind = el => /^(VIDEO|AUDIO)$/.test(el.tagName) ? 'media' : el.tagName === 'A' ? 'link' : /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable ? 'input' : 'button';
  const playing = el => el.paused === false && el.ended === false && el.readyState >= 2;
  const visible = el => {
    const r = el.getBoundingClientRect();
    const css = getComputedStyle(el);
    return r.width > 1 && r.height > 1 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth && css.visibility !== 'hidden' && css.display !== 'none' && Number(css.opacity) !== 0;
  };
  const dialog = el => {
    const ancestor = el.closest(dialogSelector);
    return ancestor?.matches?.(dialogSelector) && visible(ancestor) ? ancestor : null;
  };
  const dialogTitle = el => {
    if (!el) return '';
    const name = el.getAttribute('aria-label');
    if (name) return clip(name, 160);
    const titleIds = (el.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean);
    const namedTitle = titleIds.map(id => document.getElementById(id)?.textContent).filter(Boolean).join(' ');
    const heading = el.querySelector(headingSelector);
    return clip(namedTitle || heading?.innerText, 160);
  };
  function describe(el) {
    const type = clip(el.type || '', 30).toLowerCase(), name = label(el);
    const form = el.form || el.closest('form');
    const search = type === 'search' || /search/i.test(form && (form.getAttribute('role') || '') || '') || /^(search|find|look up)(\b|$)/i.test(name);
    const submits = !!form && (el.tagName === 'BUTTON' && (!type || type === 'submit') || type === 'submit' || type === 'image');
    const risky = type === 'password' || /\b(send|post|publish|purchase|pay|buy|order|checkout|book|reserve|delete|remove|confirm|subscribe|submit|transfer|upload|share|apply|sign out|log out)\b/i.test(name) || submits && !search;
    const controlKind = kind(el);
    const heading = (controlKind === 'button' || controlKind === 'link') && el.querySelector?.(headingSelector);
    return { kind: controlKind, label: name, inputType: type, href: el.tagName === 'A' ? String(el.href || '').slice(0, 2048) : '', disabled: !!(el.disabled || el.getAttribute('aria-disabled') === 'true'), risky, search, dialogTitle: dialogTitle(dialog(el)), menuTitle: clip(heading?.innerText, 160) };
  }
  function fingerprint(info) { return JSON.stringify([info.kind, info.label, info.inputType, info.href, info.disabled, info.risky, info.search, info.dialogTitle, info.menuTitle]); }
  if (args.mode === 'snapshot') {
    const nodes = Array.from(document.querySelectorAll('a[href],button,input:not([type="hidden"]),textarea,select,[role="button"],[contenteditable="true"],video,audio')).filter(visible).slice(0, 90);
    const refs = new Map(), controls = [], media = [];
    const panels = Array.from(document.querySelectorAll(dialogSelector)).filter(el => el.matches?.(dialogSelector) && visible(el)).slice(0, 12);
    const dialogs = panels.map((el, index) => ({ id: `dialog-${index}`, title: dialogTitle(el) }));
    nodes.forEach((el, index) => {
      const ref = args.token + '-' + index, info = describe(el);
      const panel = dialogs[panels.indexOf(dialog(el))];
      refs.set(ref, el);
      controls.push({ ref, kind: info.kind, label: info.label, inputType: info.inputType, href: info.href, disabled: info.disabled, needsConfirmation: info.risky, dialog: panel?.id || null, menuTitle: info.menuTitle });
      if (info.kind === 'media') media.push({ ref, label: info.label, playing: playing(el), paused: el.paused === true, ended: el.ended === true });
    });
    globalThis[key] = { token: args.token, refs };
    return { url: String(location.href).slice(0, 2048), title: clip(document.title, 240), text: String(document.body && document.body.innerText || '').slice(0, 14000), controls, media, dialogs, scroll: { x: Math.round(scrollX), y: Math.round(scrollY) } };
  }
  if (!state || state.token !== args.token) return { ok: false, error: 'stale_ref' };
  if (args.mode === 'scroll') { scrollBy(args.x, args.y); return { ok: true }; }
  const el = state.refs.get(args.ref);
  if (!el || !el.isConnected || !visible(el)) return { ok: false, error: 'stale_ref' };
  const info = describe(el);
  if (info.disabled) return { ok: false, error: 'disabled_control' };
  if (args.mode === 'inspect') return { ok: true, ...info, fingerprint: fingerprint(info), needsConfirmation: info.risky || args.key === 'Enter' && !info.search };
  if (args.fingerprint !== fingerprint(info)) return { ok: false, error: 'changed_control' };
  if (args.mode === 'click') { el.click(); return { ok: true }; }
  if (args.mode === 'focus') { el.focus(); return { ok: document.activeElement === el }; }
  if (args.mode === 'type' || args.mode === 'verify_type') {
    if (info.kind !== 'input' || el.readOnly || /^(file|checkbox|radio|submit|button|image|reset|hidden)$/.test(info.inputType)) return { ok: false, error: 'not_text_input' };
    if (args.mode === 'verify_type') return { ok: true, valueMatches: (el.isContentEditable ? el.textContent : el.value) === args.text };
    if (el.isContentEditable) el.textContent = args.text;
    else {
      const prototype = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, 'value').set;
      setter.call(el, args.text);
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, valueMatches: (el.isContentEditable ? el.textContent : el.value) === args.text };
  }
  if (args.mode === 'verify_media') return { ok: info.kind === 'media', mediaPlaying: info.kind === 'media' && playing(el) };
  if (args.mode === 'media_play') {
    if (info.kind !== 'media') return { ok: false, error: 'not_media' };
    try { await el.play(); return { ok: true, mediaPlaying: playing(el) }; }
    catch (_) { return { ok: false, error: 'media_play_blocked' }; }
  }
  return { ok: false, error: 'unsupported_action' };
}

function createBrowserActions({ BrowserWindow, assertActive, lookupHost = host => dns.lookup(host, { all: true, verbatim: true }), partition = 'persist:synapses-agent-browser', pause = ms => new Promise(resolve => setTimeout(resolve, ms)), makeToken = () => crypto.randomBytes(12).toString('hex'), navigationTimeoutMs = 12000, dnsTimeoutMs = 4000 } = {}) {
  if (typeof BrowserWindow !== 'function' || typeof assertActive !== 'function') throw Error('BrowserWindow and assertActive are required.');
  if (!/^persist:synapses-agent-[a-z0-9-]+$/.test(partition)) throw Error('A separate agent browser partition is required.');
  let win = null, contents = null, lifetime = 0, generation = 0, snapshot = null, token = '', performingTicket = null, pendingPopup = null, disposed = false, detached = false;
  const cancelWaiters = new Set();
  const active = ticket => {
    if (disposed || ticket !== lifetime) throw Object.assign(Error('Browser task is no longer active.'), { code: 'canceled' });
    const verdict = assertActive();
    // Navigation event gates require an immediate lease verdict. Never treat an
    // unresolved async false/rejection as authority to drive a browser.
    if (verdict && typeof verdict.then === 'function') { Promise.resolve(verdict).catch(() => {}); throw Object.assign(Error('A synchronous browser lease check is required.'), { code: 'canceled' }); }
    if (verdict === false) throw Object.assign(Error('Browser task is no longer active.'), { code: 'canceled' });
  };
  const guarded = async (promise, ticket, check = active) => {
    check(ticket);
    let rejectCancellation;
    const canceled = new Promise((_, reject) => { rejectCancellation = reject; });
    cancelWaiters.add(rejectCancellation);
    try { const value = await Promise.race([promise, canceled]); check(ticket); return value; }
    catch (error) { check(ticket); throw error; }
    finally { cancelWaiters.delete(rejectCancellation); }
  };
  const abortPending = () => { for (const reject of cancelWaiters) reject(Object.assign(Error('Browser task canceled.'), { code: 'canceled' })); cancelWaiters.clear(); };
  const invalidate = () => { generation++; snapshot = null; token = ''; };
  const requestCurrent = ticket => {
    if (disposed || ticket !== lifetime) throw Object.assign(Error('Browser request canceled.'), { code: 'canceled' });
    if (!detached) active(ticket);
  };
  async function publicTarget(value, ticket, passiveRequest = false) {
    const check = passiveRequest ? requestCurrent : active;
    check(ticket);
    const url = typeof value === 'string' && value.length <= 2048 ? publicWebUrl(value) : null;
    if (!url) throw Object.assign(Error('Only public HTTPS websites are supported.'), { code: 'blocked_url' });
    let timer;
    const addresses = await guarded(Promise.race([
      lookupHost(new URL(url).hostname),
      new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(Error('Website validation timed out.'), { code: 'dns_timeout' })), dnsTimeoutMs); })
    ]).finally(() => clearTimeout(timer)), ticket, check);
    if (!Array.isArray(addresses) || !addresses.length || !addresses.every(item => publicAddress(typeof item === 'string' ? item : item.address))) throw Object.assign(Error('The website did not resolve exclusively to public addresses.'), { code: 'blocked_address' });
    return url;
  }
  function ensureWindow(ticket) {
    active(ticket);
    if (win && !win.isDestroyed()) return;
    win = new BrowserWindow({ width: 1200, height: 820, minWidth: 640, minHeight: 480, show: true, title: 'Ava browser', autoHideMenuBar: true,
      webPreferences: { partition, nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, allowRunningInsecureContent: false, devTools: false, navigateOnDragDrop: false } });
    contents = win.webContents;
    contents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    contents.session.setPermissionCheckHandler(() => false);
    contents.session.setDevicePermissionHandler(() => false);
    contents.session.on('will-download', event => event.preventDefault());
    contents.on('will-attach-webview', event => event.preventDefault());
    const gate = (event, value) => { const url = event.url || value; try { requestCurrent(lifetime); if (!publicWebUrl(url)) event.preventDefault(); } catch (_) { event.preventDefault(); } };
    contents.on('will-navigate', gate);
    contents.on('will-redirect', gate);
    contents.on('will-frame-navigate', gate);
    contents.on('did-start-navigation', (_event, _url, inPlace, isMainFrame) => { if (isMainFrame && !inPlace) invalidate(); });
    contents.on('did-navigate-in-page', (_event, _url, isMainFrame) => { if (isMainFrame) invalidate(); });
    contents.setWindowOpenHandler(details => {
      const current = lifetime;
      try {
        active(current);
        const popup = publicTarget(details.url, current).then(url => { active(current); return contents.loadURL(url); }).then(() => { active(current); return true; }).catch(() => false);
        pendingPopup = popup;
        popup.finally(() => { if (pendingPopup === popup) pendingPopup = null; });
      } catch (_) {}
      return { action: 'deny' };
    });
    // Chromium pauses each request while the public-address check completes.
    // Blob/data media remains local to the already validated document.
    contents.session.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
      const current = lifetime;
      const localMedia = /^(blob:|data:)/.test(details.url) && !['mainFrame', 'subFrame'].includes(details.resourceType) && !!publicWebUrl(contents.getURL());
      try { requestCurrent(current); } catch (_) { callback({ cancel: true }); return; }
      if (localMedia) { callback({ cancel: false }); return; }
      publicTarget(details.url, current, true).then(() => callback({ cancel: false }), () => callback({ cancel: true }));
    });
    const ownedWindow = win;
    win.on('closed', () => {
      if (win !== ownedWindow) return;
      lifetime++; abortPending(); invalidate(); contents = null; win = null; pendingPopup = null; detached = false;
    });
  }
  async function execute(args, ticket, userGesture = false) {
    active(ticket);
    const code = '(' + pageOperation.toString() + ')(' + JSON.stringify(args) + ')';
    return guarded(contents.executeJavaScriptInIsolatedWorld(WORLD, [{ code }], userGesture), ticket);
  }
  async function waitForPage(ticket) {
    await guarded(pause(80), ticket);
    if (pendingPopup) { const pending = pendingPopup; await guarded(pending, ticket); if (pendingPopup === pending) pendingPopup = null; }
    if (!contents.isLoadingMainFrame()) return;
    const loadingContents = contents;
    let cleanup;
    try {
      await guarded(new Promise((resolve, reject) => {
        const done = () => resolve();
        const failed = (_event, code) => { if (code !== -3) done(); };
        const timer = setTimeout(() => reject(Object.assign(Error('The page is still loading.'), { code: 'navigation_timeout' })), navigationTimeoutMs);
        cleanup = () => {
          clearTimeout(timer);
          loadingContents.removeListener('did-finish-load', done);
          loadingContents.removeListener('did-fail-load', failed);
          loadingContents.removeListener('destroyed', done);
        };
        loadingContents.once('did-finish-load', done);
        loadingContents.on('did-fail-load', failed);
        loadingContents.once('destroyed', done);
        if (!loadingContents.isLoadingMainFrame()) done();
      }), ticket);
    } finally { cleanup?.(); }
  }
  async function observe(ticket) {
    active(ticket);
    const url = contents.getURL();
    if (!publicWebUrl(url)) throw Object.assign(Error('Open a public HTTPS website first.'), { code: 'no_public_page' });
    const nextToken = makeToken(), page = await execute({ mode: 'snapshot', token: nextToken }, ticket);
    if (!page || page.url !== contents.getURL() || !Array.isArray(page.controls)) throw Object.assign(Error('The page changed while it was being read.'), { code: 'page_changed' });
    token = nextToken; generation++;
    snapshot = { generation, url: page.url, title: String(page.title || '').slice(0, 240), text: String(page.text || '').slice(0, 14000),
      controls: page.controls.slice(0, 90), media: Array.isArray(page.media) ? page.media.slice(0, 90) : [], dialogs: Array.isArray(page.dialogs) ? page.dialogs.slice(0, 12) : [], scroll: page.scroll };
    return snapshot;
  }
  const visibleSignature = page => JSON.stringify(page && [page.url, page.title, page.text, page.controls.map(item => [item.kind, item.label, item.inputType, item.href, item.disabled, item.dialog, item.menuTitle]), page.media.map(item => item.playing), page.dialogs, page.scroll]);
  function requireRef(ref) {
    if (!snapshot || typeof ref !== 'string' || !snapshot.controls.some(control => control.ref === ref)) throw Object.assign(Error('Read the page again and use an observed control reference.'), { code: 'stale_ref' });
  }
  async function perform(tool, args = {}, trusted = {}) {
    if (!Object.hasOwn(TOOLS, tool) || !args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(name => !TOOLS[tool].includes(name))) return { ok: false, error: 'invalid_arguments', message: 'Use a supported tool and its observed references; code and selectors are not accepted.' };
    const ticket = lifetime;
    if (performingTicket === ticket) return { ok: false, error: 'browser_busy', message: 'Wait for the current browser action.' };
    performingTicket = ticket;
    try {
      active(ticket);
      detached = false;
      if (tool === 'read_page' && (!win || win.isDestroyed())) return {ok:false,error:'no_public_page',message:'No page is open in the Ava browser.'};
      if (tool === 'read_page' && args.foregroundOnly === true && !win.isFocused()) return {ok:false,error:'no_public_page',message:'The Ava browser is not the foreground window.'};
      let target;
      if (tool === 'open_url') target = await publicTarget(args.url, ticket);
      ensureWindow(ticket);
      if (tool === 'open_url') {
        invalidate(); await guarded(contents.loadURL(target), ticket); await waitForPage(ticket);
        return { ok: true, verified: true, page: await observe(ticket), message: 'Opened the observed public website.' };
      }
      if (tool === 'read_page') { await waitForPage(ticket); return { ok: true, verified: false, page: await observe(ticket) }; }
      if (!snapshot || snapshot.url !== contents.getURL()) return { ok: false, error: 'read_required', message: 'Read the current page before acting.' };
      const before = snapshot, signature = visibleSignature(before);
      let outcome = { ok: true }, ref = args.ref, observedFingerprint;
      if (tool === 'back') {
        if (!contents.navigationHistory.canGoBack()) return { ok: false, error: 'no_history', message: 'There is no previous browser page.' };
        active(ticket); contents.navigationHistory.goBack();
      } else if (tool === 'scroll') {
        if (!['up', 'down', 'left', 'right'].includes(args.direction) || args.amount !== undefined && (!Number.isFinite(args.amount) || args.amount <= 0)) return { ok: false, error: 'invalid_arguments' };
        const amount = Math.min(1200, Math.max(40, args.amount || 600));
        outcome = await execute({ mode: 'scroll', token, x: args.direction === 'left' ? -amount : args.direction === 'right' ? amount : 0, y: args.direction === 'up' ? -amount : args.direction === 'down' ? amount : 0 }, ticket, true);
      } else {
        if (tool === 'media_play' && !ref && before.media.length === 1) ref = before.media[0].ref;
        requireRef(ref);
        if (tool === 'press' && !KEYS.has(args.key)) return { ok: false, error: 'unsupported_key' };
        if (tool === 'type' && (typeof args.text !== 'string' || args.text.length > 4000 || /\u0000/.test(args.text))) return { ok: false, error: 'invalid_text' };
        const inspected = await execute({ mode: 'inspect', token, ref, key: tool === 'press' ? args.key : '' }, ticket);
        if (!inspected.ok) return inspected;
        const expected = tool === 'click' ? trusted.expectedControl : null;
        if (expected && (inspected.label !== expected.label || inspected.dialogTitle !== expected.dialogTitle || expected.href !== undefined && inspected.href !== expected.href || expected.menuTitle !== undefined && inspected.menuTitle !== expected.menuTitle)) {
          return { ok: false, error: 'changed_control', message: 'The page changed before Ava could use that control.' };
        }
        if ((inspected.needsConfirmation || expected?.confirm === true) && trusted.confirmed !== true) {
          const message = expected?.confirm === true && inspected.dialogTitle
            ? 'Confirm “' + inspected.label.slice(0, 120) + '” for ' + inspected.dialogTitle + '.'
            : 'Confirm ' + tool + ' on “' + inspected.label.slice(0, 120) + '”.';
          return { ok: false, needsConfirmation: true, confirmationRequired: true, message, page: snapshot };
        }
        if (tool === 'click' && inspected.href) await publicTarget(inspected.href, ticket);
        observedFingerprint = inspected.fingerprint;
        const mode = tool === 'press' ? 'focus' : tool;
        outcome = await execute({ mode, token, ref, text: args.text, fingerprint: inspected.fingerprint }, ticket, true);
        if (!outcome.ok) return outcome;
        if (tool === 'press') {
          active(ticket); const keyCode = args.key === 'Space' ? 'Space' : args.key;
          if (typeof win.focus === 'function') win.focus();
          contents.sendInputEvent({ type: 'keyDown', keyCode });
          active(ticket); contents.sendInputEvent({ type: 'keyUp', keyCode });
        }
      }
      if (!outcome.ok) return outcome;
      await waitForPage(ticket);
      if (tool === 'type' || tool === 'media_play') outcome = await execute({ mode: tool === 'type' ? 'verify_type' : 'verify_media', token, ref, text: args.text, fingerprint: observedFingerprint }, ticket);
      const page = await observe(ticket);
      const verified = tool === 'type' ? outcome.valueMatches === true : tool === 'media_play' ? outcome.mediaPlaying === true && page.media.some(item => item.playing) : visibleSignature(page) !== signature;
      return { ok: true, verified, page, message: tool === 'media_play' ? verified ? 'Media is playing.' : 'Media playback was not observed.' : verified ? 'Observed the updated browser state.' : 'The action ran; no visible change was detected.' };
    } catch (error) { return { ok: false, verified: false, error: ['canceled', 'blocked_url', 'blocked_address', 'dns_timeout', 'no_public_page', 'stale_ref', 'page_changed', 'navigation_timeout'].includes(error.code) ? error.code : 'browser_error', message: error.code === 'canceled' ? 'Browser task canceled.' : 'The browser action could not be verified.' }; }
    finally { if (performingTicket === ticket) performingTicket = null; }
  }
  function retireWindow(permanent) {
    if (permanent) disposed = true;
    lifetime++; abortPending(); invalidate(); pendingPopup = null; detached = false;
    const previous = win; win = null; contents = null;
    if (previous && !previous.isDestroyed()) previous.destroy();
  }
  function close() { retireWindow(true); }
  function cancel({ keepIdleWindow = false } = {}) {
    if (!keepIdleWindow) { retireWindow(false); return; }
    lifetime++; abortPending(); invalidate(); pendingPopup = null; detached = true;
    if (contents && !contents.isDestroyed?.() && typeof contents.stop === 'function') contents.stop();
  }
  return Object.freeze({ perform, close, cancel, dialogParent: () => win && !win.isDestroyed() ? win : null });
}

module.exports = { createBrowserActions, pageOperation };
