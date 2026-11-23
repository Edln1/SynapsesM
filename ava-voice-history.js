(function (root, create) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = { create: create };
  else root.AvaVoiceHistory = create(root.document, function () { return root.localStorage; });
})(typeof window === 'undefined' ? globalThis : window, function (document, getStorage) {
  'use strict';
  var storageKey = 'synapses_companion_transcript';
  var dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  var dialog = null;
  var returnFocus = null;

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

  function timestamp(value) {
    if (!Number.isFinite(value)) return null;
    var time = node('time', 'avh-time', dateFormat.format(value));
    time.dateTime = new Date(value).toISOString();
    return time;
  }

  function readSessions() {
    var saved = JSON.parse(getStorage().getItem(storageKey) || '[]');
    var groups = new Map();
    if (!Array.isArray(saved)) return [];
    saved.forEach(function (entry) {
      if (!entry || typeof entry !== 'object') return;
      var user = typeof entry.user === 'string' ? entry.user.trim() : '';
      var ava = typeof entry.ava === 'string' ? entry.ava.trim() : '';
      if (!user && !ava) return;
      var date = typeof entry.date === 'string' ? entry.date : '';
      var instant = Date.parse(date);
      var key = typeof entry.session === 'string' && entry.session ? entry.session : date.slice(0, 10);
      var session = groups.get(key);
      if (!session) {
        session = { latest: -Infinity, title: '', preview: '', turns: [] };
        groups.set(key, session);
      }
      if (Number.isFinite(instant)) session.latest = Math.max(session.latest, instant);
      session.turns.push({ user: user, ava: ava });
      if (!session.title && user) session.title = user.replace(/\s+/g, ' ');
      if (ava) session.preview = ava.replace(/\s+/g, ' ');
    });
    return Array.from(groups.values()).reverse().sort(function (a, b) {
      return a.latest === b.latest ? 0 : a.latest > b.latest ? -1 : 1;
    });
  }

  function close() {
    if (!dialog) return false;
    var previous = dialog;
    dialog = null;
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
    var back = button('avh-back avh-icon', '‹', function () {
      renderList();
      if (lastRow) lastRow.focus({ preventScroll: true });
    });
    back.setAttribute('aria-label', 'Back to voice history');
    var dismiss = button('avh-icon', '×', close);
    dismiss.setAttribute('aria-label', 'Close voice history');
    var content = node('div', 'avh-content');
    var footer = node('footer', 'avh-footer');
    var notice = node('p', 'avh-notice');
    notice.setAttribute('role', 'status');
    var sessions = [];
    var loadFailed = false;
    var listScroll = 0;
    var lastRow = null;
    try { sessions = readSessions(); } catch (_) { loadFailed = true; }
    header.append(back, title, dismiss);
    panel.append(header, content, footer);
    dialog.appendChild(panel);
    dialog.addEventListener('cancel', function (event) { event.preventDefault(); close(); });
    dialog.addEventListener('click', function (event) { if (event.target === dialog) close(); });

    function showClearConfirmation() {
      var confirmation = node('p', 'avh-confirm-copy', 'Clear all voice history on this device?');
      var actions = node('div', 'avh-confirm-actions');
      var cancel = button('avh-secondary', 'Cancel', function () { renderList(); clear.focus(); });
      var confirm = button('avh-danger', 'Clear history', function () {
        try {
          getStorage().removeItem(storageKey);
          sessions = [];
          lastRow = null;
          renderList();
          dismiss.focus();
        } catch (_) { notice.textContent = 'Could not clear voice history. Try again.'; }
      });
      notice.textContent = '';
      actions.append(cancel, confirm);
      footer.replaceChildren(confirmation, notice, actions);
      cancel.focus();
    }

    var clear = button('avh-clear', 'Clear history', showClearConfirmation);
    function renderList() {
      var lastIndex = lastRow ? Number(lastRow.dataset.index) : -1;
      title.textContent = 'Voice history';
      back.hidden = true;
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
        var label = node('span', 'avh-session-copy');
        label.appendChild(node('strong', 'avh-session-title', session.title || 'Voice conversation'));
        if (session.preview) label.appendChild(node('span', 'avh-preview', session.preview));
        row.appendChild(label);
        var time = timestamp(session.latest);
        if (time) row.appendChild(time);
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
      back.focus();
    }

    renderList();
    document.body.appendChild(dialog);
    dialog.showModal();
    dismiss.focus();
  }

  return { toggle: toggle, close: close };
});
