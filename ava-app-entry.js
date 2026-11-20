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
    settledAt: Date.now() + 180, timer: null, startupTimer: null, startupRetries: 0, started: false, lastReason: 'initial', draft: null, homeRequested: true };
  var observer = null, menu = null, returnBar = null, statusNode = null, loadingSurface = null, voiceDock = null, dockedVoice = null, idleVoice = null, authCopy = null, authBrand = null;
  var startupRetryLimit = 80;
  // The original SVGs are absolutely centered inside this button.
  var voiceDockStyles = { position: 'relative', left: 'auto', top: 'auto', right: 'auto', bottom: 'auto', transform: 'none', margin: '0px', display: 'flex', visibility: 'visible', opacity: '1', 'pointer-events': 'auto', 'z-index': 'auto' };
  var listeners = [], observed = new Set(), patched = new Map(), voiceNotice = '', voiceNoticeNode = null;
  var voiceMenuHome = null, voiceHold = null, suppressVoiceTap = false;
  var backgroundVoiceToggle = null, backgroundVoiceNotice = '';
  var backgroundVoiceStream = null, backgroundVoiceTracks = [], lastBackgroundVoice = null;

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
  function syncLoading(next) {
    var opening = next === 'waiting' && !state.ready && !state.failed &&
      (state.initial || state.opening) && state.startupRetries < startupRetryLimit;
    if (opening && !loadingSurface && typeof document.querySelector === 'function') {
      var mascot = document.querySelector('#avaCompanionChat .ac-title .ac-mascot');
      if (mascot) {
        loadingSurface = document.createElement('div'); loadingSurface.id = 'avaAppLoading';
        loadingSurface.setAttribute('role', 'status');
        var label = document.createElement('span'); label.textContent = 'Opening Ava…';
        loadingSurface.append(mascot.cloneNode(true), label);
        document.body.appendChild(loadingSurface);
      }
    }
    if (loadingSurface && loadingSurface.hidden === opening) loadingSurface.hidden = !opening;
    return opening && !!loadingSurface;
  }
  function setStage(next, reason) {
    var changed = state.stage !== next;
    if (next !== 'chat' && changed) restoreVoiceMenu();
    state.stage = next; state.lastReason = reason || next;
    html.setAttribute('data-ava-app-stage', next);
    if (next === 'auth' && changed) syncBackgroundVoiceCapture();
    syncVoiceControl();
    var loading = syncLoading(next);
    if (returnBar) returnBar.hidden = loading || next === 'chat' || next === 'auth' || next === 'welcome' || Boolean(menu && menu.open);
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
  function clearVoiceHold() {
    if (!voiceHold) return;
    clearTimeout(voiceHold.timer);
    voiceHold = null;
  }
  function closeVoiceMenu() {
    if (!voiceMenuHome || voiceMenuHome.node.style.display === 'none') return false;
    voiceMenuHome.node.style.display = 'none';
    return true;
  }
  function restoreVoiceMenu() {
    clearVoiceHold();
    suppressVoiceTap = false;
    if (!voiceMenuHome) return;
    closeVoiceMenu();
    var saved = voiceMenuHome;
    voiceMenuHome = null;
    saved.parent.insertBefore(saved.node, saved.next && saved.next.parentNode === saved.parent ? saved.next : null);
    saved.node.inert = saved.inert && chatVisible();
  }
  function backgroundVoiceState() {
    try {
      var api = window.avaBackgroundVoice;
      if (!api || typeof api.getState !== 'function' || typeof api.setEnabled !== 'function' ||
          typeof api.setVoiceLive !== 'function') return null;
      var status = api.getState();
      return status && status.available === true ? { api: api, status: status } : null;
    } catch (_) { return null; }
  }
  function syncBackgroundVoiceCapture() {
    var native = !state.destroyed && backgroundVoiceState();
    var stream = native && state.stage !== 'auth' && window._topNavVoiceActive === true ? window._stream || null : null;
    if (stream !== backgroundVoiceStream) {
      backgroundVoiceTracks.forEach(function (track) { track.removeEventListener('ended', syncBackgroundVoiceCapture); });
      backgroundVoiceStream = stream;
      backgroundVoiceTracks = stream && typeof stream.getAudioTracks === 'function' ? stream.getAudioTracks() : [];
      backgroundVoiceTracks.forEach(function (track) { track.addEventListener('ended', syncBackgroundVoiceCapture); });
    }
    var live = backgroundVoiceTracks.some(function (track) { return track.enabled && track.readyState === 'live'; });
    var api = native ? native.api : lastBackgroundVoice && lastBackgroundVoice.api;
    if (!api || (!lastBackgroundVoice && !live) ||
        (lastBackgroundVoice && lastBackgroundVoice.api === api && lastBackgroundVoice.live === live)) return;
    // Record the transition first. A bridge can acknowledge it synchronously.
    lastBackgroundVoice = { api: api, live: live };
    try { api.setVoiceLive(live); } catch (_) { lastBackgroundVoice = null; }
  }
  function syncBackgroundVoice() {
    var native = backgroundVoiceState();
    if (backgroundVoiceToggle) {
      backgroundVoiceToggle.hidden = !native;
      backgroundVoiceToggle.setAttribute('aria-checked', String(Boolean(native && native.status.enabled)));
    }
    var message = native && typeof native.status.message === 'string' ? native.status.message.slice(0, 240) : '';
    if (message !== backgroundVoiceNotice) {
      backgroundVoiceNotice = message;
      syncVoiceControl();
    }
    syncBackgroundVoiceCapture();
  }
  function addBackgroundVoiceToggle(voiceMenu) {
    if (!backgroundVoiceState()) return;
    if (!backgroundVoiceToggle) {
      backgroundVoiceToggle = button('', function (event) {
        event.stopPropagation();
        var native = backgroundVoiceState();
        if (!native) return;
        syncBackgroundVoiceCapture();
        try { native.api.setEnabled(!native.status.enabled); } catch (_) {}
      }, 'ava-cx-background-voice');
      backgroundVoiceToggle.id = 'avaBackgroundVoiceToggle';
      backgroundVoiceToggle.setAttribute('role', 'switch');
      var label = document.createElement('span');
      label.textContent = 'Keep voice on in background';
      var indicator = document.createElement('span');
      indicator.className = 'ava-cx-background-switch';
      indicator.setAttribute('aria-hidden', 'true');
      backgroundVoiceToggle.append(label, indicator);
      var captions = document.getElementById('avaCxToastToggle');
      voiceMenu.insertBefore(backgroundVoiceToggle, captions && captions.parentNode === voiceMenu ? captions.nextSibling : null);
    }
    syncBackgroundVoice();
  }
  function openVoiceMenu(x, y) {
    var chat = document.getElementById('avaCompanionChat'), voiceMenu = document.getElementById('avaStsCtxMenu');
    if (state.stage !== 'chat' || !visible(chat) || !voiceMenu || !voiceMenu.parentNode ||
        typeof window._tnvOpenVoiceMenu !== 'function') return false;
    if (!voiceMenuHome) {
      voiceMenuHome = { node: voiceMenu, parent: voiceMenu.parentNode, next: voiceMenu.nextSibling, inert: voiceMenu.inert };
      chat.appendChild(voiceMenu);
      voiceMenu.inert = false;
    }
    addBackgroundVoiceToggle(voiceMenu);
    window._tnvOpenVoiceMenu(x, y);
    return true;
  }
  function inVoiceDock(target) { return state.stage === 'chat' && voiceDock && target && voiceDock.contains(target); }
  function armVoiceHold(event) {
    if (!inVoiceDock(event.target) || event.isPrimary === false || event.button !== 0) return;
    clearVoiceHold();
    suppressVoiceTap = false;
    if (event.pointerType !== 'touch' && event.pointerType !== 'pen') return;
    var hold = { id: event.pointerId, x: event.clientX, y: event.clientY };
    hold.timer = setTimeout(function () {
      if (voiceHold !== hold) return;
      voiceHold = null;
      suppressVoiceTap = openVoiceMenu(hold.x, hold.y);
    }, 500);
    voiceHold = hold;
  }
  function endVoiceHold(event) {
    if (!voiceHold || voiceHold.id !== event.pointerId) return;
    if (event.type === 'pointermove' && Math.hypot(event.clientX - voiceHold.x, event.clientY - voiceHold.y) <= 10) return;
    clearVoiceHold();
  }
  function captureVoiceContext(event) {
    if (!inVoiceDock(event.target)) return;
    clearVoiceHold();
    if (!openVoiceMenu(event.clientX, event.clientY)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    suppressVoiceTap = true;
  }
  function stopVoice() {
    if (typeof window.stopTopNavVoice === 'function') window.stopTopNavVoice({ skipAway: true });
    schedule('voice-stopped', 0);
  }
  function showVoiceIssue(event) {
    var message = event.detail && event.detail.message;
    if (typeof message !== 'string') return;
    voiceNotice = message.slice(0, 240);
    syncVoiceControl();
  }
  function syncVoiceNotice(connecting) {
    var message = voiceNotice || backgroundVoiceNotice || (connecting ? 'Connecting microphone…' : '');
    if (!voiceNoticeNode && message) {
      var notice = document.getElementById('acNotice');
      if (!notice || !notice.parentNode) return;
      voiceNoticeNode = document.createElement('div');
      voiceNoticeNode.id = 'avaAppVoiceNotice';
      voiceNoticeNode.className = 'ac-notice';
      voiceNoticeNode.setAttribute('role', 'status');
      notice.parentNode.insertBefore(voiceNoticeNode, notice);
    }
    if (voiceNoticeNode && voiceNoticeNode.textContent !== message) voiceNoticeNode.textContent = message;
  }
  function restoreVoiceControl() {
    if (!dockedVoice) return;
    var saved = dockedVoice, mic = saved.node; dockedVoice = null;
    if (mic.parentNode === voiceDock && saved.parent) saved.parent.insertBefore(mic, saved.next && saved.next.parentNode === saved.parent ? saved.next : null);
    Object.keys(voiceDockStyles).forEach(function (name) {
      if (mic.style.getPropertyValue(name) !== voiceDockStyles[name]) return;
      var before = saved.styles[name];
      if (before.value) mic.style.setProperty(name, before.value, before.priority); else mic.style.removeProperty(name);
    });
    mic.inert = saved.inert && chatVisible();
    if (saved.label === null) mic.removeAttribute('aria-label'); else mic.setAttribute('aria-label', saved.label);
    if (saved.title === null) mic.removeAttribute('title'); else mic.setAttribute('title', saved.title);
  }
  function syncVoiceControl() {
    var chat = document.getElementById('avaCompanionChat'), anchor = document.getElementById('acHistory'), mic = document.getElementById('topNavVoiceBtn'), talk = document.getElementById('acVoice');
    if (!voiceDock && chat && anchor && chat.contains(anchor)) {
      voiceDock = document.createElement('span'); voiceDock.id = 'avaAppVoiceDock';
      voiceDock.addEventListener('click', function (event) { if (event.target !== voiceDock) return; if (voiceActive()) stopVoice(); else if (talk) talk.click(); });
      anchor.parentNode.insertBefore(voiceDock, anchor);
    }
    if (voiceDock && talk && !idleVoice) {
      idleVoice = { node: talk, parent: talk.parentNode, next: talk.nextSibling, hidden: talk.hidden, label: talk.getAttribute('aria-label'), title: talk.getAttribute('title') };
      voiceDock.appendChild(talk); talk.setAttribute('aria-label', 'Talk to Ava'); talk.setAttribute('title', 'Talk to Ava');
    }
    var active = state.stage === 'chat' && voiceActive() && voiceDock && mic;
    if (!active) restoreVoiceControl();
    else {
      if (!dockedVoice) {
        dockedVoice = { node: mic, parent: mic.parentNode, next: mic.nextSibling, inert: mic.inert, label: mic.getAttribute('aria-label'), title: mic.getAttribute('title'), styles: {} };
        Object.keys(voiceDockStyles).forEach(function (name) { dockedVoice.styles[name] = { value: mic.style.getPropertyValue(name), priority: mic.style.getPropertyPriority(name) }; });
      }
      // Move the original animated control into chat's existing top margin,
      // retaining its waveform/analyser and escaping the inert body siblings.
      if (mic.parentNode !== voiceDock) voiceDock.appendChild(mic);
      if (mic.inert) mic.inert = false;
      mic.setAttribute('aria-label', 'Stop voice conversation'); mic.setAttribute('title', 'Stop voice');
      Object.keys(voiceDockStyles).forEach(function (name) { if (mic.style.getPropertyValue(name) !== voiceDockStyles[name] || mic.style.getPropertyPriority(name) !== 'important') mic.style.setProperty(name, voiceDockStyles[name], 'important'); });
    }
    if (talk && talk.hidden !== !!active) talk.hidden = !!active;
    var show = state.stage === 'chat' && Boolean(talk || active);
    if (voiceDock && voiceDock.hidden !== !show) voiceDock.hidden = !show;
    syncVoiceNotice(Boolean(active && window._topNavVoiceActive &&
      !mic.classList.contains('tnv-on') && !mic.classList.contains('tnv-speak')));
  }
  function closeChat() {
    restoreVoiceMenu();
    // Undock before chat releases its saved sibling-inert state. Restoring the
    // post-isolation value afterward would make the legacy mic untappable again.
    restoreVoiceControl();
    if (typeof window.avaCompanionChatClose === 'function') window.avaCompanionChatClose(false);
  }
  function suspend(kind) {
    state.initial = false; state.force = false; state.suspension = kind; state.failed = false;
    setStage(kind, 'user-opened-' + kind);
  }
  function action(name) {
    closeOwnMenu();
    suspend(name === 'logout' ? 'auth' : 'tools');
    closeChat();
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
    closeVoiceMenu();
    state.initial = false;
    state.force = false; state.suspension = 'tools'; state.failed = false;
    setStage(chatVisible() ? 'chat' : 'tools', 'ava-menu');
    if (!menu) {
      menu = document.createElement('dialog');
      menu.id = 'avaAppMenu'; menu.className = 'ava-app-menu';
      menu.setAttribute('aria-labelledby', 'avaAppMenuTitle');
      var top = document.createElement('div'); top.className = 'ava-app-menu-heading';
      var title = document.createElement('h2'); title.id = 'avaAppMenuTitle'; title.textContent = 'Ava';
      var close = button('×', function () { closeOwnMenu(); showChat(); }, 'ava-app-menu-close');
      close.setAttribute('aria-label', 'Back to Ava'); top.append(title, close); menu.appendChild(top);
      var account = document.createElement('p'); account.id = 'avaAppMenuAccount'; menu.appendChild(account);
      menu.append(button('Your chats', showHome), button('Calls', function () { action('call-records'); }),
        button('Notes', function () { action('notes'); }), button('Introduction & setup', showIntroduction), button('Settings', function () { action('settings'); }),
        button('Your account', function () { action('account'); }), button('Sign out', function () { action('logout'); }));
      document.body.appendChild(menu);
      listen(menu, 'cancel', function (event) { event.preventDefault(); closeOwnMenu(); showChat(); });
      listen(menu, 'click', function (event) { if (event.target === menu) { closeOwnMenu(); showChat(); } });
    }
    var current = user();
    document.getElementById('avaAppMenuAccount').textContent = current && !current.isGuest ? current.email : '';
    if (!menu.open) menu.showModal();
    if (returnBar) returnBar.hidden = true;
    return true;
  }
  function showIntroduction() {
    if (state.destroyed || authVisible() || !user() || typeof window.openAvaWelcome !== 'function') return false;
    closeOwnMenu();
    closeChat();
    state.initial = true; state.force = false; state.suspension = null; state.failed = false;
    window.openAvaWelcome({ replay: true });
    setStage('welcome', 'user-opened-introduction');
    return true;
  }
  function stagePrompt(text) {
    if (typeof text !== 'string' || !text.trim()) return false;
    state.draft = text.slice(0, 12000);
    return showChat();
  }
  function closeKnownSettings() {
    if (document.body && document.body.classList.contains('chp-mobile-settings-open')) {
      var close = document.getElementById('chpUserMobileClose');
      if (close) close.click();
    }
  }
  function closeKnownTools() {
    var workspace = document.getElementById('avaCallsWorkspace'), close = document.getElementById('acwClose');
    if (visible(workspace) && close) close.click();
    var call = document.getElementById('callSuccessOverlay');
    if (call && call.classList.contains('show')) {
      if (typeof window._csMinimizeForPulse === 'function') window._csMinimizeForPulse();
      else { var minimize = document.getElementById('csMinBtn'); if (minimize) minimize.click(); }
    }
    var credits = document.getElementById('avaCreditsDialog');
    if (credits && credits.open && typeof credits.close === 'function') credits.close();
  }
  function showHome() { state.homeRequested = true; return showChat(); }
  function showChat() {
    if (state.destroyed) return false;
    closeOwnMenu(); closeKnownSettings(); closeKnownTools();
    state.initial = false; state.force = true; state.failed = false; state.suspension = null;
    // Set the underlying view deliberately, so returning from Account never flashes a dashboard.
    if (!authVisible() && !welcomeVisible() && typeof window.setView === 'function') window.setView('sec-chat');
    return refresh('user-returned-to-ava');
  }
  function patchControls() {
    patchAuthSurface();
    if (html.classList.contains('ava-app-handheld')) patchHistoryButton();
    ['acClose', 'acMainChat', 'acNewTop'].forEach(function (id) {
      var control = document.getElementById(id);
      if (!control || patched.has(control)) return;
      patched.set(control, { label: control.getAttribute('aria-label'), title: control.getAttribute('title'), html: control.innerHTML });
      control.setAttribute('aria-label', id === 'acNewTop' ? 'Open Calls' : 'Open Ava menu'); control.setAttribute('title', id === 'acNewTop' ? 'Calls' : 'Ava menu');
      if (id === 'acNewTop') control.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M7.2 3.8 4.5 5.2c-1.7 1.1.2 5.6 3.7 9.1s8 5.4 9.1 3.7l1.4-2.7-4-2-1.5 1.4c-1.8-.8-3.1-2.1-3.9-3.9l1.4-1.5-2-4Z" stroke-linecap="round" stroke-linejoin="round"/></svg>';
      else if (id === 'acClose') control.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.4" fill="currentColor" stroke="none"/></svg>';
      else control.textContent = 'Menu';
    });
  }
  function patchHistoryButton() {
    var chat = document.getElementById('avaCompanionChat'), button = document.getElementById('acHistory');
    if (!chat || !button) return;
    if (!patched.has(button)) {
      patched.set(button, { label: button.getAttribute('aria-label'), title: button.getAttribute('title'),
        expanded: button.getAttribute('aria-expanded'), html: button.innerHTML });
    }
    var onHome = chat.dataset.home === 'true';
    var label = onHome ? 'New conversation' : 'Back to conversations';
    button.removeAttribute('aria-expanded');
    if (button.getAttribute('aria-label') === label) return;
    button.setAttribute('aria-label', label);
    button.setAttribute('title', label);
    button.innerHTML = onHome
      ? '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 5v14M5 12h14" stroke-linecap="round"/></svg>'
      : patched.get(button).html;
  }
  function patchAuthSurface() {
    var form = document.getElementById('loginForm');
    if (!form || typeof form.querySelector !== 'function' || authCopy) return;
    var title = form.querySelector('.auth-step-title'), copy = form.querySelector('.auth-step-sub'), submit = form.querySelector('.modal-btn');
    if (!title || !copy) return;
    authCopy = [[title, title.textContent], [copy, copy.textContent]];
    title.textContent = 'Sign in to Ava'; copy.textContent = 'Use your Synapses account to continue.';
    if (submit) { authCopy.push([submit, submit.textContent]); submit.textContent = 'Sign in'; }
    var mascot = typeof document.querySelector === 'function' && document.querySelector('#avaCompanionChat .ac-title .ac-mascot');
    if (mascot && typeof mascot.cloneNode === 'function') {
      authBrand = document.createElement('div'); authBrand.id = 'avaAppAuthBrand'; authBrand.setAttribute('aria-hidden', 'true');
      authBrand.appendChild(mascot.cloneNode(true)); form.insertBefore(authBrand, form.firstChild);
    }
  }
  function watch() {
    if (!observer || !document.body) return;
    [document.body, document.getElementById('authModal'), document.getElementById('avaWelcome'), document.getElementById('avaCompanionChat'), voiceDock, document.getElementById('topNavVoiceBtn')].forEach(function (node) {
      if (node && !observed.has(node)) { observed.add(node); observer.observe(node, { attributes: true, childList: node === document.body || node === voiceDock, attributeFilter: ['class', 'style', 'hidden', 'inert', 'data-home'] }); }
    });
  }
  function refresh(reason) {
    if (state.destroyed) return false;
    patchControls(); watch();
    if (authVisible()) {
      // Existing mobile chat inerts its siblings. Release that before an auth gate
      // takes over, otherwise a visible sign-in modal could remain untouchable.
      if (chatVisible()) closeChat();
      state.initial = true; state.suspension = null;
      setStage('auth', reason || 'signin-visible'); return false;
    }
    if (welcomeVisible()) {
      if (chatVisible()) closeChat();
      state.initial = true; state.suspension = null;
      setStage(visible(document.getElementById('avaWelcome')) ? 'welcome' : 'waiting', reason || 'welcome-pending'); return false;
    }
    var current = user(), key = current ? String(current.id || current.email) : '';
    if (key !== state.userKey) {
      state.userKey = key; state.settledAt = Date.now() + 180;
      if (current) { state.initial = true; state.suspension = null; state.homeRequested = true; }
    }
    // Prepare the real setup before opening chat, including an account that
    // becomes ready after the legacy onboarding bootstrap's first attempt.
    if (current && state.initial && typeof window.avaWelcomeShouldStart === 'function' && window.avaWelcomeShouldStart()) {
      if (chatVisible()) closeChat();
      if (typeof window.avaWelcomeMaybeStart === 'function') window.avaWelcomeMaybeStart();
      setStage(visible(document.getElementById('avaWelcome')) ? 'welcome' : 'waiting', 'preparing-introduction');
      return false;
    }
    if (chatVisible() && state.draft === null && !state.homeRequested) { state.initial = false; state.force = false; setStage('chat', reason || 'chat-visible'); return true; }
    if ((voiceActive() || state.suspension === 'voice') && !state.force) { setStage('voice', reason || 'voice-handoff'); return false; }
    if (state.suspension === 'tools' || menu && menu.open) { setStage('tools', reason || 'tools-handoff'); return false; }
    if (!current || typeof window.avaCompanionChatOpen !== 'function') { setStage('waiting', reason || 'waiting-for-account'); return false; }
    if (!(state.initial || state.force) || state.opening || state.failed) { setStage('waiting', reason || 'awaiting-user-return'); return false; }
    if (Date.now() < state.settledAt) { schedule('startup-settled', state.settledAt - Date.now() + 10); return false; }
    state.opening = true; state.force = false;
    var draft = state.draft, home = state.homeRequested && draft === null;
    Promise.resolve().then(function () { return window.avaCompanionChatOpen(draft === null ? { home: home, focus: false } : { message: draft, send: false, focus: false }); }).then(function () {
      if (state.destroyed) return;
      state.initial = false;
      if (chatVisible()) { if (state.draft === draft) state.draft = null; state.homeRequested = false; setStage('chat', 'ava-opened'); }
      else { state.failed = true; setStage('waiting', 'chat-did-not-open'); }
    }, function () { if (!state.destroyed) { state.failed = true; setStage('waiting', 'chat-open-failed'); } }).finally(function () { state.opening = false; });
    return true;
  }
  function captureClick(event) {
    if (suppressVoiceTap && event.detail !== 0 && inVoiceDock(event.target)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      suppressVoiceTap = false;
      return;
    }
    var target = event.target && event.target.closest ? event.target.closest('button') : null;
    if (!target) return;
    if (target.id === 'topNavVoiceBtn' && dockedVoice && voiceActive()) { event.preventDefault(); event.stopImmediatePropagation(); stopVoice(); }
    else if (target.id === 'acHistory' && html.classList.contains('ava-app-handheld') && document.getElementById('avaCompanionChat')?.dataset.home === 'true') {
      var input = document.getElementById('acInput');
      if (!input) return;
      event.preventDefault(); event.stopImmediatePropagation();
      input.focus();
    }
    else if (target.id === 'acNewTop') { event.preventDefault(); event.stopImmediatePropagation(); action('call-records'); }
    else if (target.id === 'acClose' || target.id === 'acMainChat') { event.preventDefault(); event.stopImmediatePropagation(); openMenu(); }
    else if (target.id === 'acVoice') { state.suspension = null; schedule('voice-requested', 0); }
    else if (target.id === 'acwClose' || target.id === 'csMinBtn') setTimeout(showHome, 0);
    else if (target.id === 'acAccount' || target.id === 'acSettings') suspend('tools');
    else if (target.id === 'acLogout') { state.initial = true; state.suspension = null; }
  }
  function captureKey(event) {
    if (event.key !== 'Escape' || !chatVisible()) return;
    if (closeVoiceMenu()) { event.preventDefault(); event.stopImmediatePropagation(); return; }
    var root = document.getElementById('avaCompanionChat');
    // Preserve the existing dismiss-history/delete behavior inside Ava.
    if (root.dataset.history === 'true' || visible(document.getElementById('acConfirm')) ||
        root.querySelector?.('.ac-home-chat-actions:not([hidden])')) return;
    event.preventDefault(); event.stopImmediatePropagation(); openMenu();
  }
  function start() {
    if (state.started || state.destroyed || !document.body) return;
    state.started = true;
    returnBar = document.createElement('div'); returnBar.id = 'avaAppReturn';
    returnBar.setAttribute('aria-label', 'Ava navigation');
    statusNode = document.createElement('span'); statusNode.id = 'avaAppStatus'; statusNode.setAttribute('role', 'status');
    returnBar.append(statusNode, button('Back to Ava', showHome)); document.body.appendChild(returnBar);
    returnBar.hidden = syncLoading(state.stage);
    observer = new window.MutationObserver(function () {
      if (dockedVoice && state.stage === 'chat' && chatVisible()) syncVoiceControl();
      schedule('surface-changed');
    }); watch();
    listen(document, 'click', captureClick, true); listen(document, 'keydown', captureKey, true);
    listen(document, 'contextmenu', captureVoiceContext, true);
    listen(document, 'pointerdown', armVoiceHold, true);
    ['pointermove', 'pointerup', 'pointercancel'].forEach(function (name) { listen(document, name, endVoiceHold, true); });
    listen(window, 'ava:voice-error', showVoiceIssue);
    listen(window, 'ava:background-voice', syncBackgroundVoice);
    listen(window, 'ava:voice-capture', syncBackgroundVoiceCapture);
    syncBackgroundVoice();
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
      if (state.destroyed || state.ready || !state.initial || state.startupRetries++ >= startupRetryLimit) return;
      refresh('startup-readiness');
      state.startupTimer = setTimeout(startupReadiness, 250);
    }
    state.startupTimer = setTimeout(startupReadiness, 250);
  }
  function destroy() {
    if (state.destroyed) return;
    state.destroyed = true; clearTimeout(state.timer); clearTimeout(state.startupTimer);
    if (observer) observer.disconnect(); listeners.forEach(function (remove) { remove(); });
    syncBackgroundVoiceCapture();
    if (backgroundVoiceToggle) backgroundVoiceToggle.remove();
    restoreVoiceMenu();
    restoreVoiceControl();
    if (idleVoice) {
      var savedTalk = idleVoice, talk = savedTalk.node;
      if (savedTalk.parent) savedTalk.parent.insertBefore(talk, savedTalk.next && savedTalk.next.parentNode === savedTalk.parent ? savedTalk.next : null);
      talk.hidden = savedTalk.hidden;
      if (savedTalk.label === null) talk.removeAttribute('aria-label'); else talk.setAttribute('aria-label', savedTalk.label);
      if (savedTalk.title === null) talk.removeAttribute('title'); else talk.setAttribute('title', savedTalk.title);
    }
    closeOwnMenu(); if (menu) menu.remove(); if (returnBar) returnBar.remove(); if (voiceDock) voiceDock.remove();
    if (loadingSurface) loadingSurface.remove();
    if (voiceNoticeNode) voiceNoticeNode.remove();
    if (authBrand) authBrand.remove(); if (authCopy) authCopy.forEach(function (entry) { entry[0].textContent = entry[1]; });
    patched.forEach(function (before, node) {
      if (before.label == null) node.removeAttribute('aria-label'); else node.setAttribute('aria-label', before.label);
      if (before.title == null) node.removeAttribute('title'); else node.setAttribute('title', before.title);
      if (Object.prototype.hasOwnProperty.call(before, 'expanded')) {
        if (before.expanded == null) node.removeAttribute('aria-expanded'); else node.setAttribute('aria-expanded', before.expanded);
      }
      node.innerHTML = before.html;
    });
    if (typeof window.avaCompanionChatClose === 'function') window.avaCompanionChatClose(false);
    html.classList.remove('ava-app-mode'); html.removeAttribute('data-ava-app-stage');
    if (!beforeIntro.className) html.classList.remove('synapses-intro-skipped');
    if (beforeIntro.skipped === undefined) delete window._synSkipDailyIntro; else window._synSkipDailyIntro = beforeIntro.skipped;
    delete window.avaAppEntry; delete window.avaMobileEntry; delete window.__avaMobileEntryReady;
  }
  var api = { version: 1, refresh: refresh, showChat: showChat, open: showHome, home: showHome, openMenu: openMenu, closeVoiceMenu: closeVoiceMenu, showIntroduction: showIntroduction, stagePrompt: stagePrompt, destroy: destroy,
    action: function (name) { return ['settings', 'account', 'logout', 'notes', 'calls', 'call-records'].indexOf(name) === -1 ? 'unavailable' : action(name); },
    get stage() { return state.stage; } };
  window.avaAppEntry = window.avaMobileEntry = api;
  window.__avaMobileEntryReady = true;
  setStage('waiting', 'entry-initialized');
  if (document.readyState === 'loading') listen(document, 'DOMContentLoaded', start, { once: true }); else start();
})(window, document);
