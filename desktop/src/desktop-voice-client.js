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
    var phase = 'initializing', reasonCode = '', transitions = [];
    var reasonCodes = ('account_missing account_unverified account_changed hook_unavailable voice_unavailable start_error capture_timeout capture_lost capture_confirmation_failed connection_lost pagehide destroyed asr_error asr_closed asr_timeout user_stop capture_denied capture_missing capture_unreadable capture_security capture_error capture_unsupported voice_init_error').split(' ');
    function mark(nextPhase, nextReason) {
      nextReason = reasonCodes.indexOf(nextReason) !== -1 ? nextReason : '';
      if (phase === nextPhase && reasonCode === nextReason) return;
      phase = nextPhase; reasonCode = nextReason;
      transitions.push({ phase: phase, reasonCode: reasonCode, at: clock() });
      if (transitions.length > 12) transitions.shift();
    }
    function stopReason(message) {
      if (/Speech recognition/i.test(message || '')) return 'asr_error';
      if (/account changed/i.test(message || '')) return 'account_changed';
      if (/Sign in/i.test(message || '')) return 'account_unverified';
      if (/timed out|microphone did not start/i.test(message || '')) return 'capture_timeout';
      if (/Allow the microphone/i.test(message || '')) return 'capture_denied';
      if (/stopped with the microphone/i.test(message || '')) return 'capture_lost';
      if (/confirm microphone/i.test(message || '')) return 'capture_confirmation_failed';
      if (/connection|session has expired/i.test(message || '')) return 'connection_lost';
      return 'user_stop';
    }
    function diagnostics() {
      return Object.freeze({ version: 1, phase: phase, reasonCode: reasonCode, enabled: state.enabled, listening: state.listening,
        voiceActive: window._topNavVoiceActive === true, captureLive: captureActive(), starting: state.enabled && !state.listening || !!starting,
        hidden: document.hidden === true, elapsedMs: startedAt ? Math.max(0, clock() - startedAt) : 0,
        transitions: Object.freeze(transitions.map(function (item) { return Object.freeze({ phase: item.phase, reasonCode: item.reasonCode, at: item.at }); })) });
    }
    function noteFallback(code) { if (active() && ['asr_error','asr_closed','asr_timeout'].indexOf(code) !== -1) mark('whisper-fallback', code); }
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
    function isCurrentAccount() { return active() && !!owner && account() === owner; }
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
        button.title = 'Ask naturally to open an app, move a window, or work with a page.';
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
      if(state.enabled&&typeof next.message==='string')notice=next.message.slice(0,500);
      if (!state.enabled || previousId && previousId !== state.sessionId) {
        if (wasEnabled || ownsVoice) { attempt++; releaseVoice(); }
        sawCapture = false; owner = '';
        if (wasEnabled && phase !== 'stopped' && phase !== 'destroyed') { mark('stopped', stopReason(next.message)); notice = next.message || 'PC voice control is stopped.'; }
      }
      if (state.enabled && !startedAt) startedAt = clock();
      if (!state.enabled) { startedAt = 0; pendingOwner = ''; }
      if (state.listening) mark('listening', '');
      else if (phase === 'initializing') mark('idle', '');
      render(); schedule();
    }
    async function stop(message, code) {
      if (stopping) return stopping;
      var hadLease = state.enabled || ownsVoice || !!starting;
      code = reasonCodes.indexOf(code) !== -1 ? code : stopReason(message);
      mark(destroyed ? 'destroyed' : 'stopped', code);
      attempt++; releaseVoice(); sawCapture = false; owner = ''; pendingOwner = ''; startedAt = 0;
      state = { available: state.available, enabled: false, listening: false, sessionId: null };
      notice = message || ''; render(); schedule();
      if (!hadLease) return state;
      stopping = Promise.resolve().then(function () { return native.stop({ phase: 'stopped', reasonCode: code }); }).then(function (next) { apply(next); return state; }, function () { return state; }).finally(function () { stopping = null; });
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
        else if (clock() - startedAt > 30000) await stop('The microphone did not start. Start PC voice control again to retry.', 'capture_timeout');
      } finally { schedule(); }
    }
    async function begin() {
      await ready;
      if (destroyed || !state.available) return false;
      if (window.__synapsesDesktopVoiceHookVersion !== 1) { await stop('Reload Synapses to use PC voice control.', 'hook_unavailable'); return false; }
      if (state.enabled && ownsVoice) return true;
      var ticket = ++attempt;
      var startingOwner = account();
      if (!startingOwner) {
        await stop('Sign in to Synapses, then start PC voice control.', 'account_missing'); return false;
      }
      mark('consent', '');
      pendingOwner = startingOwner; schedule();
      notice = ''; render();
      try {
        var next = await native.start();
        if (destroyed || ticket !== attempt) return false;
        if (account() !== startingOwner) { await stop('PC voice control stopped because your account changed.'); return false; }
        apply(next);
        if (!state.enabled || !state.sessionId) { mark('stopped', 'start_error'); pendingOwner = ''; notice = next && next.message || 'PC voice control was not started.'; render(); schedule(); return false; }
        mark('account-verification', '');
        var verified = await verifiedAccount(startingOwner);
        if (destroyed || ticket !== attempt) return false;
        if (!verified) { await stop('Sign in to your current account before starting PC voice control.', 'account_unverified'); return false; }
        ownsVoice = true; owner = startingOwner; pendingOwner = ''; sawCapture = false; startedAt = clock();
        mark('microphone-starting', '');
        if (typeof window.toggleTopNavVoice !== 'function') { await stop('Voice is not ready. Reload Synapses and try again.', 'voice_unavailable'); return false; }
        // Native opt-in and the real account bridge are verified above. Reuse
        // the same live voice engine as the header, without a cosmetic hold UI.
        if (!window._topNavVoiceActive) {
          var voiceStart = window.toggleTopNavVoice();
          if (voiceStart && typeof voiceStart.then === 'function') await voiceStart;
        }
        if (destroyed || ticket !== attempt) return false;
        await check(); return state.enabled;
      } catch (_) { if (ticket === attempt) await stop('PC voice control could not start. Please try again.', 'start_error'); return false; }
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
        var accountId=window.currentUser&&window.currentUser.id;
        var result = await native.runCommand({ sessionId: sessionId, text: String(text).slice(0,1000), userId:typeof accountId==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(accountId)?accountId:undefined });
        if (state.sessionId !== sessionId || !state.enabled) return { handled: true, ok: false, message: 'PC voice control is stopped.' };
        if (!result || typeof result.handled !== 'boolean') throw Error('Invalid command response');
        if (!result.handled && result.message) { await stop(result.message); return { handled: true, ok: false, message: result.message }; }
        return { handled: result.handled, ok: result.ok === true, message: String(result.message || '').slice(0,500) };
      } catch (_) { await stop('PC voice control lost its connection. Start it again to retry.'); return { handled: true, ok: false, message: 'PC voice control could not confirm that command.' }; }
    }
    async function destroy() {
      destroyed = true; await stop('', 'destroyed');
      if (timer !== null) window.clearTimeout(timer);
      subscriptions.forEach(function (unsubscribe) { if (typeof unsubscribe === 'function') unsubscribe(); });
      window.removeEventListener('pagehide', onPageHide);
      if (button) button.remove(); if (status) status.remove(); if (style) style.remove();
      if (window.synapsesDesktopVoiceClient === controller) delete window.synapsesDesktopVoiceClient;
    }
    function onPageHide() { stop('', 'pagehide'); }
    var ready = Promise.resolve().then(function () { return native.getState(); }).then(function (next) {
      if (next && next.available === true && !destroyed) { apply(next); window.synapsesDesktopVoiceClient = controller; }
      return state.available;
    }, function () { return false; });
    var controller = Object.freeze({ version: 1, ready: ready, start: start, stop: stop, consume: consume, enabled: enabled, active: active, isCurrentAccount: isCurrentAccount, diagnostics: diagnostics, noteFallback: noteFallback, destroy: destroy });
    subscriptions.push(native.onState(apply));
    subscriptions.push(native.onRequest(function (request) { if (request && request.action === 'start') start(); else if (request && request.action === 'stop') stop('PC voice control is stopped.'); }));
    window.addEventListener('pagehide', onPageHide);
    return controller;
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { createDesktopVoiceClient: createDesktopVoiceClient };
  if (scope && scope.document) createDesktopVoiceClient(scope, scope.document);
})(typeof window !== 'undefined' ? window : null);
