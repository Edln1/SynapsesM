(function (root, create) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = { create: create };
  else root.AvaVoiceHistory = create(root.document, function () { return root.localStorage; });
})(typeof window === 'undefined' ? globalThis : window, function (document, getStorage) {
  'use strict';
  var storageKey = 'synapses_companion_transcript';
  var classicDataSlot = '<!-- AVA_VOICE_HISTORY_DATA -->';
  var dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  var dayFormat = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
  var yearFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });
  var clockFormat = new Intl.DateTimeFormat(undefined, { timeStyle: 'short' });
  var dialog = null;
  var returnFocus = null;
  var cancelClassic = null;

  function node(tag, cssClass, text) {
    var element = document.createElement(tag);
    if (cssClass) element.className = cssClass;
    if (text) element.textContent = text;
    return element;
  }

  function button(cssClass, label, action) {
    var element = node('button', cssClass, label);
    element.type = 'button';
    element.addEventListener('click', action);
    return element;
  }

  function timestamp(value, compact) {
    if (!Number.isFinite(value)) return null;
    var date = new Date(value);
    var now = new Date();
    var format = !compact ? dateFormat : date.toDateString() === now.toDateString() ? clockFormat :
      date.getFullYear() === now.getFullYear() ? dayFormat : yearFormat;
    var time = node('time', 'avh-time', format.format(date));
    time.dateTime = date.toISOString();
    return time;
  }

  function readRecords() {
    var saved = JSON.parse(getStorage().getItem(storageKey) || '[]');
    if (!Array.isArray(saved)) return [];
    return saved.flatMap(function (entry) {
      if (!entry || typeof entry !== 'object') return [];
      var user = typeof entry.user === 'string' ? entry.user.trim() : '';
      var ava = typeof entry.ava === 'string' ? entry.ava.trim() : '';
      if (!user && !ava) return [];
      var date = typeof entry.date === 'string' ? entry.date : '';
      return [{ user: user, ava: ava, date: date, session: typeof entry.session === 'string' ? entry.session : '' }];
    });
  }

  function readSessions(records) {
    var groups = new Map();
    records.forEach(function (entry) {
      var instant = Date.parse(entry.date);
      var key = entry.session || entry.date.slice(0, 10);
      var session = groups.get(key);
      if (!session) {
        session = { latest: -Infinity, title: '', preview: '', turns: [] };
        groups.set(key, session);
      }
      if (Number.isFinite(instant)) session.latest = Math.max(session.latest, instant);
      session.turns.push(entry);
      if (!session.title && entry.user) session.title = entry.user.replace(/\s+/g, ' ');
      if (entry.ava) session.preview = entry.ava.replace(/\s+/g, ' ');
    });
    return Array.from(groups.values()).reverse().sort(function (a, b) {
      return a.latest === b.latest ? 0 : a.latest > b.latest ? -1 : 1;
    });
  }

  function close() {
    if (!dialog) return false;
    var previous = dialog;
    dialog = null;
    if (cancelClassic) cancelClassic();
    previous.close();
    previous.remove();
    if (returnFocus && returnFocus.isConnected && returnFocus.getClientRects().length) {
      returnFocus.focus({ preventScroll: true });
    }
    returnFocus = null;
    return true;
  }

  function toggle(trigger) {
    if (close()) return;
    returnFocus = trigger || document.activeElement;
    dialog = node('dialog', 'avh-dialog');
    dialog.id = 'avaVoiceHistory';
    dialog.setAttribute('aria-labelledby', 'avaVoiceHistoryTitle');
    var panel = node('section', 'avh-panel');
    var header = node('header', 'avh-header');
    var title = node('h2', 'avh-title', 'Voice history');
    title.id = 'avaVoiceHistoryTitle';
    title.tabIndex = -1;
    var back = button('avh-back avh-icon', '‹', function () {
      renderList();
      if (lastRow) lastRow.focus({ preventScroll: true });
    });
    back.setAttribute('aria-label', 'Back to voice history');
    var classic = button('avh-classic-toggle', '', function () {
      if (dialog.dataset.view === 'classic') {
        renderList();
        classic.focus({ preventScroll: true });
      } else openClassic();
    });
    var svgNamespace = 'http://www.w3.org/2000/svg';
    var radar = document.createElementNS(svgNamespace, 'svg');
    radar.setAttribute('class', 'avh-classic-radar');
    radar.setAttribute('viewBox', '0 0 24 24');
    radar.setAttribute('aria-hidden', 'true');
    var radarSweep = document.createElementNS(svgNamespace, 'path');
    radarSweep.setAttribute('d', 'M21 12a9 9 0 1 1-9-9m5 9a5 5 0 1 1-5-5m0 5 7-7');
    var radarSignal = document.createElementNS(svgNamespace, 'circle');
    radarSignal.setAttribute('cx', '17');
    radarSignal.setAttribute('cy', '15.5');
    radarSignal.setAttribute('r', '1.15');
    radar.append(radarSweep, radarSignal);
    var fullscreen = button('avh-icon avh-fullscreen', '', function () {
      setFullscreen(dialog.dataset.fullscreen !== 'true');
    });
    fullscreen.setAttribute('aria-label', 'Fullscreen');
    fullscreen.hidden = true;
    var fullscreenIcon = document.createElementNS(svgNamespace, 'svg');
    fullscreenIcon.setAttribute('viewBox', '0 0 24 24');
    fullscreenIcon.setAttribute('aria-hidden', 'true');
    var fullscreenPath = document.createElementNS(svgNamespace, 'path');
    fullscreenIcon.appendChild(fullscreenPath);
    fullscreen.appendChild(fullscreenIcon);
    var dismiss = button('avh-icon avh-close', '×', close);
    dismiss.setAttribute('aria-label', 'Close voice history');
    var content = node('div', 'avh-content');
    var footer = node('footer', 'avh-footer');
    var notice = node('p', 'avh-notice');
    notice.setAttribute('role', 'status');
    var sessions = [];
    var loadFailed = false;
    var listScroll = 0;
    var lastRow = null;
    var classicFrame = null;
    try { sessions = readSessions(readRecords()); } catch (_) { loadFailed = true; }
    header.append(back, title, classic, fullscreen, dismiss);
    panel.append(header, content, footer);
    dialog.appendChild(panel);
    dialog.addEventListener('cancel', function (event) { event.preventDefault(); close(); });
    dialog.addEventListener('click', function (event) { if (event.target === dialog) close(); });

    function setFullscreen(enabled) {
      dialog.dataset.fullscreen = String(enabled);
      fullscreen.setAttribute('aria-pressed', String(enabled));
      fullscreen.title = enabled ? 'Exit fullscreen' : 'Enter fullscreen';
      fullscreenPath.setAttribute('d', enabled
        ? 'M3 9h6V3m12 6h-6V3M3 15h6v6m12-6h-6v6'
        : 'M9 3H3v6m12-6h6v6M3 15v6h6m12-6v6h-6');
    }

    function clearClassicHistory() {
      if (classicFrame && classicFrame.contentWindow) {
        classicFrame.contentWindow.postMessage({ type: 'SYNAPSES_HISTORY', history: [] }, '*');
      }
    }

    function openClassic() {
      var browser = document.defaultView;
      var request = new AbortController();
      var page = dialog.dataset.view === 'transcript' && lastRow ? Number(lastRow.dataset.index) : 0;
      if (dialog.dataset.view === 'list') listScroll = content.scrollTop;
      dialog.dataset.view = 'classic';
      title.textContent = 'Synapses Transmission Log';
      back.hidden = true;
      classic.textContent = 'List view';
      classic.removeAttribute('aria-label');
      classic.removeAttribute('title');
      fullscreen.hidden = false;
      footer.hidden = true;
      var status = node('p', 'avh-empty', 'Opening Classic…');
      status.setAttribute('role', 'status');
      content.replaceChildren(status);

      function receive(event) {
        if (!classicFrame || !classicFrame.contentWindow || event.source !== classicFrame.contentWindow || event.origin !== 'null') return;
        if (event.data?.type === 'COSMIC_CLEAR_TRANSCRIPT') showClearConfirmation();
      }

      cancelClassic = function () {
        request.abort();
        browser.removeEventListener('message', receive);
        classicFrame = null;
        cancelClassic = null;
      };
      browser.fetch('/ava-voice-history-classic.html?v=20261123-voice-parity1', {
        mode: 'same-origin', signal: request.signal,
      }).then(function (response) {
        if (!response.ok) throw new Error('Classic history unavailable');
        return response.text();
      }).then(function (markup) {
        if (request.signal.aborted) return;
        if (!markup.includes(classicDataSlot)) throw new Error('Classic history template unavailable');
        var data = JSON.stringify({ sessions: sessions, page: page }).replace(/</g, '\\u003c');
        var state = '<script type="application/json" id="avaClassicHistoryData">' + data + '<\/script>';
        classicFrame = node('iframe', 'avh-classic-frame');
        classicFrame.setAttribute('title', 'Classic voice history');
        classicFrame.setAttribute('sandbox', 'allow-scripts');
        browser.addEventListener('message', receive);
        classicFrame.srcdoc = markup.replace(classicDataSlot, function () { return state; });
        content.replaceChildren(classicFrame);
      }).catch(function () {
        if (!request.signal.aborted) status.textContent = 'Could not open Classic voice history.';
      });
    }

    function showClearConfirmation() {
      var inClassic = dialog.dataset.view === 'classic';
      var confirmation = node('p', 'avh-confirm-copy', 'Clear all voice history on this device?');
      var actions = node('div', 'avh-confirm-actions');
      var cancel = button('avh-secondary', 'Cancel', function () {
        if (inClassic) { footer.hidden = true; classic.focus(); }
        else { renderList(); clear.focus(); }
      });
      var confirm = button('avh-danger', 'Clear history', function () {
        try {
          getStorage().removeItem(storageKey);
          sessions = [];
          lastRow = null;
          if (inClassic) { footer.hidden = true; clearClassicHistory(); classic.focus(); }
          else { renderList(); title.focus(); }
        } catch (_) { notice.textContent = 'Could not clear voice history. Try again.'; }
      });
      notice.textContent = '';
      actions.append(cancel, confirm);
      footer.hidden = false;
      footer.replaceChildren(confirmation, notice, actions);
      cancel.focus();
    }

    var clear = button('avh-clear', 'Clear history', showClearConfirmation);
    function renderList() {
      if (cancelClassic) cancelClassic();
      var lastIndex = lastRow ? Number(lastRow.dataset.index) : -1;
      dialog.dataset.view = 'list';
      setFullscreen(false);
      fullscreen.hidden = true;
      title.textContent = 'Voice history';
      back.hidden = true;
      classic.replaceChildren(radar);
      classic.setAttribute('aria-label', 'Classic voice history');
      classic.setAttribute('title', 'Classic voice history');
      content.replaceChildren();
      footer.hidden = !sessions.length;
      footer.replaceChildren(clear);
      lastRow = null;
      if (!sessions.length) {
        content.appendChild(node('p', 'avh-empty', loadFailed
          ? 'Could not load voice history on this device.'
          : 'No voice conversations yet.'));
        return;
      }
      var list = node('div', 'avh-list');
      sessions.forEach(function (session, index) {
        var row = button('avh-session', '', function () { openSession(session, row); });
        row.dataset.index = String(index);
        row.appendChild(node('strong', 'avh-session-title', session.title || 'Voice conversation'));
        if (session.preview) row.appendChild(node('span', 'avh-preview', session.preview));
        var time = timestamp(session.latest, true);
        if (time) row.appendChild(time);
        var chevron = node('span', 'avh-chevron', '›');
        chevron.setAttribute('aria-hidden', 'true');
        row.appendChild(chevron);
        list.appendChild(row);
        if (index === lastIndex) lastRow = row;
      });
      content.appendChild(list);
      content.scrollTop = listScroll;
    }

    function addMessage(thread, name, words) {
      if (!words) return;
      var message = node('article', 'avh-message');
      message.append(node('strong', 'avh-speaker', name), node('p', 'avh-message-text', words));
      thread.appendChild(message);
    }

    function openSession(session, row) {
      lastRow = row;
      listScroll = content.scrollTop;
      dialog.dataset.view = 'transcript';
      title.textContent = session.title || 'Voice conversation';
      back.hidden = false;
      footer.hidden = true;
      var thread = node('div', 'avh-thread');
      var time = timestamp(session.latest);
      if (time) thread.appendChild(time);
      session.turns.forEach(function (turn) {
        addMessage(thread, 'You', turn.user);
        addMessage(thread, 'Ava', turn.ava);
      });
      content.replaceChildren(thread);
      content.scrollTop = 0;
      title.focus({ preventScroll: true });
    }

    renderList();
    document.body.appendChild(dialog);
    dialog.showModal();
    title.focus({ preventScroll: true });
  }

  return { toggle: toggle, close: close };
});
