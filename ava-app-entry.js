/* Ava-only entry for the existing Synapses web app and a dedicated Android shell.
 * Load this with defer, or inject it after the trusted page has finished loading.
 * It does not authenticate anyone or start microphone/model/provider requests.
 */
(function avaAppEntryBootstrap(window, document) {
  'use strict';
  var enabled = false;
  try { enabled = new URLSearchParams(window.location.search).get('ava-app') === '1'; } catch (_) {}
  if (!enabled) return;
  if (window.avaAppEntry && window.avaAppEntry.version === 1) {
    window.avaAppEntry.refresh('reinjected');
    return;
  }

  var html = document.documentElement;
  var beforeIntro = { skipped: window._synSkipDailyIntro, className: html.classList.contains('synapses-intro-skipped') };
  html.classList.add('ava-app-mode');
  // This skips only the decorative Synapses entrance, never sign-in or welcome.
  // A page integration should set this before the original splash script runs.
  window._synSkipDailyIntro = true;
  html.classList.add('synapses-intro-skipped');
  var state = { stage: 'waiting', destroyed: false, opening: false, initial: true,
    suspension: null, force: false, failed: false, ready: false, userKey: null,
    settledAt: Date.now() + 180, timer: null, startupTimer: null, startupRetries: 0, started: false, lastReason: 'initial' };
  var observer = null, menu = null, returnBar = null, statusNode = null;
  var listeners = [], observed = new Set(), patched = new Map();

  function emit(name, detail) {
    try { window.dispatchEvent(new window.CustomEvent(name, { detail: detail })); } catch (_) {}
  }
  function visible(node) {
    if (!node || node.hidden) return false;
    var style = window.getComputedStyle(node);
    return style.display !== 'none' && style.visibility !== 'hidden' && node.getClientRects().length > 0;
  }
  function user() {
    var value = window.currentUser;
    if (!value || !value.email) return null;
    var bridge = window.avaCompanionChatBridge;
    // A signed-out bridge must never restore a stale real-account UI object.
    if (!value.isGuest && bridge && typeof bridge.uiKey === 'function' && bridge.uiKey() === 'guest') return null;
    return value;
  }
  function voiceActive() {
    return Boolean(window._topNavVoiceActive || window._fpBusy || window._fpNativePendingAttempt);
  }
  function chatVisible() { return visible(document.getElementById('avaCompanionChat')); }
  function authVisible() { return visible(document.getElementById('authModal')); }
  function welcomeVisible() {
    return Boolean(window.__avaWelcomePending || window.__avaWelcomeActive || visible(document.getElementById('avaWelcome')));
  }
  function setStage(next, reason) {
    var changed = state.stage !== next;
    state.stage = next; state.lastReason = reason || next;
    html.setAttribute('data-ava-app-stage', next);
    if (returnBar) returnBar.hidden = next === 'chat' || next === 'auth' || next === 'welcome' || Boolean(menu && menu.open);
    if (statusNode) statusNode.textContent = state.failed ? 'Ava could not open. Try again.' : next === 'waiting' ? 'Opening Ava…' : '';
    if (changed) emit('ava:app-stage-change', { stage: next, reason: state.lastReason });
    if (['auth', 'welcome', 'chat'].indexOf(next) !== -1 && !state.ready) {
      state.ready = true;
      emit('ava:app-ready', { stage: next });
    }
  }
  function listen(target, name, handler, options) {
    target.addEventListener(name, handler, options);
    listeners.push(function () { target.removeEventListener(name, handler, options); });
  }
  function schedule(reason, delay) {
    if (state.destroyed) return;
    clearTimeout(state.timer);
    state.timer = setTimeout(function () { state.timer = null; refresh(reason); }, delay == null ? 60 : delay);
  }
  function button(label, action, className) {
    var node = document.createElement('button');
    node.type = 'button'; node.textContent = label;
    if (className) node.className = className;
    node.addEventListener('click', action);
    return node;
  }
  function closeOwnMenu() {
    if (menu && menu.open) menu.close();
  }
  function suspend(kind) {
    state.initial = false; state.force = false; state.suspension = kind; state.failed = false;
    setStage(kind, 'user-opened-' + kind);
  }
  function action(name) {
    closeOwnMenu();
    suspend(name === 'logout' ? 'auth' : 'tools');
    if (typeof window.avaCompanionChatClose === 'function') window.avaCompanionChatClose(false);
    var result = typeof window.avaFloatingOpenAction === 'function' ? window.avaFloatingOpenAction(name) : 'unavailable';
    if (result === 'unavailable') {
      setStage('tools', 'tool-unavailable');
      if (statusNode) statusNode.textContent = 'That option is not available yet. Return to Ava to continue.';
    }
    schedule('account-action', 100);
    return result;
  }
  function openMenu() {
    if (state.destroyed) return false;
    if (authVisible() || welcomeVisible()) return false;
    state.initial = false;
    if (typeof window.avaCompanionChatClose === 'function') window.avaCompanionChatClose(false);
    suspend('tools');
    if (!menu) {
      menu = document.createElement('dialog');
      menu.id = 'avaAppMenu'; menu.className = 'ava-app-menu';
      menu.setAttribute('aria-labelledby', 'avaAppMenuTitle');
      var top = document.createElement('div'); top.className = 'ava-app-menu-heading';
      var title = document.createElement('h2'); title.id = 'avaAppMenuTitle'; title.textContent = 'Ava';
      var close = button('×', function () { closeOwnMenu(); showChat(); }, 'ava-app-menu-close');
      close.setAttribute('aria-label', 'Back to Ava'); top.append(title, close); menu.appendChild(top);
      var account = document.createElement('p'); account.id = 'avaAppMenuAccount'; menu.appendChild(account);
      menu.append(button('Back to chat', showChat), button('Settings', function () { action('settings'); }),
        button('Your account', function () { action('account'); }), button('Sign out', function () { action('logout'); }));
      document.body.appendChild(menu);
      listen(menu, 'cancel', function (event) { event.preventDefault(); closeOwnMenu(); showChat(); });
    }
    var current = user();
    document.getElementById('avaAppMenuAccount').textContent = current && !current.isGuest ? current.email : 'Your Ava conversation';
    if (!menu.open) menu.showModal();
    if (returnBar) returnBar.hidden = true;
    return true;
  }
  function closeKnownSettings() {
    if (document.body && document.body.classList.contains('chp-mobile-settings-open')) {
      var close = document.getElementById('chpUserMobileClose');
      if (close) close.click();
    }
  }
  function showChat() {
    if (state.destroyed) return false;
    closeOwnMenu(); closeKnownSettings();
    state.initial = false; state.force = true; state.failed = false; state.suspension = null;
    // Set the underlying view deliberately, so returning from Account never flashes a dashboard.
    if (!authVisible() && !welcomeVisible() && typeof window.setView === 'function') window.setView('sec-chat');
    return refresh('user-returned-to-ava');
  }
  function patchControls() {
    ['acClose', 'acMainChat'].forEach(function (id) {
      var control = document.getElementById(id);
      if (!control || patched.has(control)) return;
      patched.set(control, { label: control.getAttribute('aria-label'), title: control.getAttribute('title'), html: control.innerHTML });
      control.setAttribute('aria-label', 'Open Ava menu'); control.setAttribute('title', 'Ava menu');
      if (id === 'acClose') control.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.4" fill="currentColor" stroke="none"/></svg>';
      else control.textContent = 'Menu';
    });
  }
  function watch() {
    if (!observer || !document.body) return;
    [document.body, document.getElementById('authModal'), document.getElementById('avaWelcome'), document.getElementById('avaCompanionChat')].forEach(function (node) {
      if (node && !observed.has(node)) { observed.add(node); observer.observe(node, { attributes: true, attributeFilter: ['class', 'style', 'hidden'] }); }
    });
  }
  function refresh(reason) {
    if (state.destroyed) return false;
    patchControls(); watch();
    if (authVisible()) {
      // Existing mobile chat inerts its siblings. Release that before an auth gate
      // takes over, otherwise a visible sign-in modal could remain untouchable.
      if (chatVisible() && typeof window.avaCompanionChatClose === 'function') window.avaCompanionChatClose(false);
      state.initial = true; state.suspension = null;
      setStage('auth', reason || 'signin-visible'); return false;
    }
    if (welcomeVisible()) {
      if (chatVisible() && typeof window.avaCompanionChatClose === 'function') window.avaCompanionChatClose(false);
      state.initial = true; state.suspension = null;
      setStage(visible(document.getElementById('avaWelcome')) ? 'welcome' : 'waiting', reason || 'welcome-pending'); return false;
    }
    var current = user(), key = current ? String(current.id || current.email) : '';
    if (key !== state.userKey) {
      state.userKey = key; state.settledAt = Date.now() + 180;
      if (current) { state.initial = true; state.suspension = null; }
    }
    if (chatVisible()) { state.initial = false; state.force = false; setStage('chat', reason || 'chat-visible'); return true; }
    if ((voiceActive() || state.suspension === 'voice') && !state.force) { setStage('voice', reason || 'voice-handoff'); return false; }
    if (state.suspension === 'tools' || menu && menu.open) { setStage('tools', reason || 'tools-handoff'); return false; }
    if (!current || typeof window.avaCompanionChatOpen !== 'function') { setStage('waiting', reason || 'waiting-for-account'); return false; }
    if (!(state.initial || state.force) || state.opening || state.failed) { setStage('waiting', reason || 'awaiting-user-return'); return false; }
    if (Date.now() < state.settledAt) { schedule('startup-settled', state.settledAt - Date.now() + 10); return false; }
    state.opening = true; state.force = false;
    Promise.resolve().then(function () { return window.avaCompanionChatOpen(); }).then(function () {
      if (state.destroyed) return;
      state.initial = false;
      if (chatVisible()) setStage('chat', 'ava-opened');
      else { state.failed = true; setStage('waiting', 'chat-did-not-open'); }
    }, function () { if (!state.destroyed) { state.failed = true; setStage('waiting', 'chat-open-failed'); } }).finally(function () { state.opening = false; });
    return true;
  }
  function captureClick(event) {
    var target = event.target && event.target.closest ? event.target.closest('button') : null;
    if (!target) return;
    if (target.id === 'acClose' || target.id === 'acMainChat') { event.preventDefault(); event.stopImmediatePropagation(); openMenu(); }
    else if (target.id === 'acVoice') suspend('voice');
    else if (target.id === 'acAccount' || target.id === 'acSettings') suspend('tools');
    else if (target.id === 'acLogout') { state.initial = true; state.suspension = null; }
  }
  function captureKey(event) {
    if (event.key !== 'Escape' || !chatVisible()) return;
    var root = document.getElementById('avaCompanionChat');
    // Preserve the existing dismiss-history/delete behavior inside Ava.
    if (root.dataset.history === 'true' || visible(document.getElementById('acConfirm'))) return;
    event.preventDefault(); event.stopImmediatePropagation(); openMenu();
  }
  function start() {
    if (state.started || state.destroyed || !document.body) return;
    state.started = true;
    returnBar = document.createElement('div'); returnBar.id = 'avaAppReturn';
    returnBar.setAttribute('aria-label', 'Ava navigation');
    statusNode = document.createElement('span'); statusNode.id = 'avaAppStatus'; statusNode.setAttribute('role', 'status');
    returnBar.append(statusNode, button('Back to Ava', showChat)); document.body.appendChild(returnBar);
    observer = new window.MutationObserver(function () { schedule('surface-changed'); }); watch();
    listen(document, 'click', captureClick, true); listen(document, 'keydown', captureKey, true);
    ['ava:chat-ready', 'ava:welcome-closed', 'synapses:intro-complete', 'focus', 'pageshow'].forEach(function (name) { listen(window, name, function () { schedule(name, 100); }); });
    listen(document, 'visibilitychange', function () { if (!document.hidden) schedule('visible', 100); });
    refresh('entry-started');
    if (document.getElementById('appSplash') && !window._splashDone) {
      // Late native injection can occur after the old intro initialized. Its
      // app-only class hides that decorative overlay; deliver its normal handoff.
      window._splashDone = true;
      emit('synapses:intro-complete', { source: 'ava-app-entry' });
    }
    // A native/WebView auth bridge may warm without a DOM mutation. Only retry
    // startup readiness for twenty seconds; never poll-reopen a user handoff.
    function startupReadiness() {
      if (state.destroyed || state.ready || !state.initial || state.startupRetries++ >= 80) return;
      refresh('startup-readiness');
      state.startupTimer = setTimeout(startupReadiness, 250);
    }
    state.startupTimer = setTimeout(startupReadiness, 250);
  }
  function destroy() {
    if (state.destroyed) return;
    state.destroyed = true; clearTimeout(state.timer); clearTimeout(state.startupTimer);
    if (observer) observer.disconnect(); listeners.forEach(function (remove) { remove(); });
    closeOwnMenu(); if (menu) menu.remove(); if (returnBar) returnBar.remove();
    patched.forEach(function (before, node) {
      if (before.label == null) node.removeAttribute('aria-label'); else node.setAttribute('aria-label', before.label);
      if (before.title == null) node.removeAttribute('title'); else node.setAttribute('title', before.title);
      node.innerHTML = before.html;
    });
    if (typeof window.avaCompanionChatClose === 'function') window.avaCompanionChatClose(false);
    html.classList.remove('ava-app-mode'); html.removeAttribute('data-ava-app-stage');
    if (!beforeIntro.className) html.classList.remove('synapses-intro-skipped');
    if (beforeIntro.skipped === undefined) delete window._synSkipDailyIntro; else window._synSkipDailyIntro = beforeIntro.skipped;
    delete window.avaAppEntry; delete window.avaMobileEntry; delete window.__avaMobileEntryReady;
  }
  var api = { version: 1, refresh: refresh, showChat: showChat, open: showChat, openMenu: openMenu, destroy: destroy,
    action: function (name) { return ['settings', 'account', 'logout', 'notes', 'calls', 'call-records'].indexOf(name) === -1 ? 'unavailable' : action(name); },
    get stage() { return state.stage; } };
  window.avaAppEntry = window.avaMobileEntry = api;
  window.__avaMobileEntryReady = true;
  setStage('waiting', 'entry-initialized');
  if (document.readyState === 'loading') listen(document, 'DOMContentLoaded', start, { once: true }); else start();
})(window, document);
