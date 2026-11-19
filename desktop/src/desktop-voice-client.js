/* Windows-only renderer glue. Native IPC owns consent, session leases and URLs. */
(function (scope) {
  'use strict';
  function createDesktopVoiceClient(window, document) {
    var native = window.synapsesDesktopVoice;
    if (!native || !['getState', 'start', 'stop', 'setListening', 'runCommand', 'onRequest', 'onState'].every(function (key) { return typeof native[key] === 'function'; })) return null;
    if (window.synapsesDesktopVoiceClient && window.synapsesDesktopVoiceClient.version === 1) return window.synapsesDesktopVoiceClient;
    var state = { available: false, enabled: false, listening: false, sessionId: null }, destroyed = false;
    var attempt = 0, starting = null, stopping = null, updating = false, ownsVoice = false, owner = '', sawCapture = false;
    var startedAt = 0, timer = null, button = null, status = null, style = null, notice = '', subscriptions = [], pendingOwner = '';
    var clock = function () { return (window.Date || Date).now(); };
    function account() {
      var user = window.currentUser;
      return user && !user.isGuest && user.email ? String(user.id || user.email) + '|' + String(user.email).toLowerCase() : '';
    }
    function captureActive() {
      try { return !!(window._topNavVoiceActive && window._stream && window._stream.getAudioTracks().some(function (track) { return track.enabled && track.readyState === 'live'; })); }
      catch (_) { return false; }
    }
    async function verifiedAccount(expected) {
      var bridge = window.avaCompanionChatBridge;
      if (!bridge || typeof bridge.verify !== 'function' || typeof bridge.current !== 'function' || typeof bridge.isCurrent !== 'function') return false;
      await bridge.verify();
      var user = bridge.current();
      return !!(user && user.email && bridge.isCurrent(user) && String(user.id || user.email) + '|' + String(user.email).toLowerCase() === expected && account() === expected);
    }
    function active() { return !destroyed && state.available && state.enabled && ownsVoice && !!state.sessionId; }
    function enabled() { return active() && state.listening; }
    function releaseVoice() {
      if (!ownsVoice) return;
      ownsVoice = false;
      try {
        if (typeof window.stopTopNavVoice === 'function') window.stopTopNavVoice({ skipAway: true });
        else if (typeof window.avaFloatingStopVoice === 'function') window.avaFloatingStopVoice();
      } catch (_) {}
    }
    function render() {
      if (!state.available || destroyed) return;
      var popover = document.getElementById('avaFloatPopover');
      if (!button && popover) {
        style = document.createElement('style'); style.id = 'synapsesDesktopVoiceStyle';
        style.textContent = '#avaDesktopVoiceToggle{display:block;width:100%;min-height:34px;margin:8px 0;padding:7px 9px;border:1px solid #ffffff12;border-radius:8px;background:#ffffff04;color:#aaaab3;text-align:left;font:12px/1.4 "DM Sans",sans-serif;cursor:pointer}#avaDesktopVoiceToggle:hover{background:#ffffff08;color:#eee}#avaDesktopVoiceToggle:disabled{opacity:.5;cursor:default}#avaDesktopVoiceStatus{margin:4px 1px 10px;color:#85858f;font:11px/1.5 "DM Sans",sans-serif}';
        document.head.appendChild(style);
        button = document.createElement('button'); button.id = 'avaDesktopVoiceToggle'; button.type = 'button';
        button.title = 'Say "Ava, open YouTube" or "Ava, search for ...".';
        button.onclick = function () { if (state.enabled || starting) stop('PC voice control is stopped.'); else start(); };
        status = document.createElement('p'); status.id = 'avaDesktopVoiceStatus'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
        var anchor = popover.querySelector('.af-account-actions') || document.getElementById('avaFloatStatus');
        popover.insertBefore(button, anchor); popover.insertBefore(status, anchor);
      }
      if (!button) return;
      var supported = window.__synapsesDesktopVoiceHookVersion === 1;
      var label = state.enabled ? state.listening ? 'Stop PC voice control' : 'Starting PC voice control...' : 'Start PC voice control';
      if (button.textContent !== label) button.textContent = label;
      button.disabled = !supported; button.setAttribute('aria-pressed', String(state.enabled));
      var message = supported ? notice : 'Reload Synapses to use PC voice control.';
      if (status.textContent !== message) status.textContent = message;
      status.hidden = !message;
    }
    function schedule() {
      if (timer !== null) window.clearTimeout(timer);
      timer = !destroyed && (state.enabled || pendingOwner) ? window.setTimeout(check, 250) : null;
    }
    function apply(next) {
      if (destroyed || !next || next.available !== true) return;
      var wasEnabled = state.enabled, previousId = state.sessionId;
      state = { available: true, enabled: next.enabled === true && typeof next.sessionId === 'string', listening: next.listening === true, sessionId: next.enabled ? next.sessionId : null };
      if (!state.enabled || previousId && previousId !== state.sessionId) {
        if (wasEnabled || ownsVoice) { attempt++; releaseVoice(); }
        sawCapture = false; owner = '';
      }
      if (state.enabled && !startedAt) startedAt = clock();
      if (!state.enabled) { startedAt = 0; pendingOwner = ''; }
      render(); schedule();
    }
    async function stop(message) {
      if (stopping) return stopping;
      var hadLease = state.enabled || ownsVoice || !!starting;
      attempt++; releaseVoice(); sawCapture = false; owner = ''; pendingOwner = ''; startedAt = 0;
      state = { available: state.available, enabled: false, listening: false, sessionId: null };
      notice = message || ''; render(); schedule();
      if (!hadLease) return state;
      stopping = Promise.resolve().then(function () { return native.stop(); }).then(function (next) { apply(next); return state; }, function () { return state; }).finally(function () { stopping = null; });
      return stopping;
    }
    async function check() {
      timer = null;
      if (destroyed) return;
      if (pendingOwner && account() !== pendingOwner) { await stop('PC voice control stopped because your account changed.'); return; }
      if (!state.enabled) { schedule(); return; }
      var sessionId = state.sessionId;
      try {
        if (!ownsVoice) return;
        if (!owner || account() !== owner) { await stop('PC voice control stopped because your account changed.'); return; }
        if (captureActive()) {
          sawCapture = true;
          if (!state.listening && !updating) {
            updating = true;
            try { var next = await native.setListening({ sessionId: sessionId, active: true }); if (state.sessionId === sessionId) apply(next); }
            catch (_) { await stop('PC voice control could not confirm microphone access.'); }
            finally { updating = false; }
          }
        } else if (sawCapture) await stop('PC voice control stopped with the microphone.');
        else if (clock() - startedAt > 30000 || clock() - startedAt > 1500 && !window._topNavVoiceActive && !window._fpBusy && !window._fpNativePendingAttempt) await stop('The microphone did not start. Start PC voice control again to retry.');
      } finally { schedule(); }
    }
    async function begin() {
      await ready;
      if (destroyed || !state.available) return false;
      if (window.__synapsesDesktopVoiceHookVersion !== 1) { notice = 'Reload Synapses to use PC voice control.'; render(); return false; }
      if (state.enabled && ownsVoice) return true;
      var ticket = ++attempt;
      var startingOwner = account();
      if (!startingOwner) {
        if (typeof window.avaFloatingStartVoice === 'function') window.avaFloatingStartVoice();
        notice = 'Sign in to start PC voice control.'; render(); return false;
      }
      pendingOwner = startingOwner; schedule();
      notice = ''; render();
      try {
        var next = await native.start();
        if (destroyed || ticket !== attempt) return false;
        if (account() !== startingOwner) { await stop('PC voice control stopped because your account changed.'); return false; }
        apply(next);
        if (!state.enabled || !state.sessionId) { pendingOwner = ''; notice = next && next.message || 'PC voice control was not started.'; render(); schedule(); return false; }
        if (!(await verifiedAccount(startingOwner))) { await stop('Sign in to your current account before starting PC voice control.'); return false; }
        if (destroyed || ticket !== attempt) return false;
        ownsVoice = true; owner = startingOwner; pendingOwner = ''; sawCapture = false; startedAt = clock();
        if (typeof window.toggleTopNavVoice !== 'function') { await stop('Voice is not ready. Reload Synapses and try again.'); return false; }
        // Native opt-in and the real account bridge are verified above. Reuse
        // the same live voice engine as the header, without a cosmetic hold UI.
        if (!window._topNavVoiceActive) window.toggleTopNavVoice();
        await check(); return state.enabled;
      } catch (_) { if (ticket === attempt) await stop('PC voice control could not start. Please try again.'); return false; }
    }
    function start() {
      if (starting) return starting;
      starting = begin().finally(function () { starting = null; render(); });
      return starting;
    }
    async function consume(text) {
      if (!enabled()) return { handled: false, ok: false, message: '' };
      var sessionId = state.sessionId;
      if (!captureActive() || account() !== owner) { await stop('PC voice control stopped with the microphone or account.'); return { handled: true, ok: false, message: 'PC voice control is stopped.' }; }
      try {
        var result = await native.runCommand({ sessionId: sessionId, text: String(text).slice(0,1000) });
        if (state.sessionId !== sessionId || !state.enabled) return { handled: true, ok: false, message: 'PC voice control is stopped.' };
        if (!result || typeof result.handled !== 'boolean') throw Error('Invalid command response');
        if (!result.handled && result.message) { await stop(result.message); return { handled: true, ok: false, message: result.message }; }
        return { handled: result.handled, ok: result.ok === true, message: String(result.message || '').slice(0,500) };
      } catch (_) { await stop('PC voice control lost its connection. Start it again to retry.'); return { handled: true, ok: false, message: 'PC voice control could not confirm that command.' }; }
    }
    async function destroy() {
      destroyed = true; await stop('');
      if (timer !== null) window.clearTimeout(timer);
      subscriptions.forEach(function (unsubscribe) { if (typeof unsubscribe === 'function') unsubscribe(); });
      window.removeEventListener('pagehide', onPageHide);
      if (button) button.remove(); if (status) status.remove(); if (style) style.remove();
      if (window.synapsesDesktopVoiceClient === controller) delete window.synapsesDesktopVoiceClient;
    }
    function onPageHide() { stop(''); }
    var ready = Promise.resolve().then(function () { return native.getState(); }).then(function (next) {
      if (next && next.available === true && !destroyed) { apply(next); window.synapsesDesktopVoiceClient = controller; }
      return state.available;
    }, function () { return false; });
    var controller = Object.freeze({ version: 1, ready: ready, start: start, stop: stop, consume: consume, enabled: enabled, active: active, destroy: destroy });
    subscriptions.push(native.onState(apply));
    subscriptions.push(native.onRequest(function (request) { if (request && request.action === 'start') start(); else if (request && request.action === 'stop') stop('PC voice control is stopped.'); }));
    window.addEventListener('pagehide', onPageHide);
    return controller;
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { createDesktopVoiceClient: createDesktopVoiceClient };
  if (scope && scope.document) createDesktopVoiceClient(scope, scope.document);
})(typeof window !== 'undefined' ? window : null);
