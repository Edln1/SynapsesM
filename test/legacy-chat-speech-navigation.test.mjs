import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
function section(start, end) {
  const first = html.indexOf(start);
  const last = html.indexOf(end, first + start.length);
  assert.ok(first >= 0 && last > first);
  return html.slice(first, last);
}

function fixture() {
  const window = {};
  const document = new EventTarget();
  const elements = new Map(), intervals = new Set(), opened = [];
  let stops = 0, aborts = 0;
  document.createElement = () => Object.assign(new EventTarget(), { dataset: {}, style: {} });
  document.head = { appendChild() {} };
  document.body = { appendChild: element => elements.set(element.id, element) };
  document.getElementById = id => elements.get(id);
  const context = vm.createContext({
    window, document, _vmGenId: 3, _vmSpeaking: true, _actx: null, _playbackTime: 0,
    _currentViewId: 'sec-chat', activeSession: 'source', recentChats: [{ key: 'other' }, { key: 'source' }], savedChats: [],
    isSending: true, _sendGen: 10, _chatAbortCtrl: { abort() { aborts++; } },
    _ttsStopAll() { stops++; },
    setInterval(callback) { intervals.add(callback); return callback; }, clearInterval(callback) { intervals.delete(callback); },
    openRecentChat(index) { opened.push(['recent', index]); }, openSavedChat(index) { opened.push(['saved', index]); },
  });
  vm.runInContext(section('function _hardStopChatVoice(){', 'function _restoreEmptyChatHome('), context);
  const control = section('// Floating return control for an active typed-chat reply.', '\n})();');
  vm.runInContext(control + '\n})();', context);
  vm.runInContext(section('function _ttsChatPlaybackSession() {', '</script>'), context);
  document.dispatchEvent(new Event('DOMContentLoaded'));
  window._ttsChatTurn = { sessionKey: 'source', generation: context._vmGenId };
  return {
    window, context, opened, button: elements.get('ttsFloatMic'), intervals,
    get stops() { return stops; }, get aborts() { return aborts; },
    update() { context._ttsUpdateFloatingPill(); },
  };
}

test('Home preserves an ongoing read and the speaker returns to the originating chat', () => {
  const f = fixture();
  f.update();
  assert.equal(f.button.style.display, 'none');
  f.context._hardStopChatVoice();
  assert.equal(f.stops, 0);
  assert.equal(f.aborts, 0);
  f.context.activeSession = null; // Empty Home and saved chats share the sec-chat view ID.
  f.update();
  assert.equal(f.button.style.display, 'flex');
  assert.equal(f.button.dataset.targetSession, 'source');
  f.context.activeSession = 'other';
  f.button.dispatchEvent(new Event('click'));
  assert.deepEqual(f.opened, [['recent', 1]]);
  f.context.activeSession = 'source';
  f.update();
  assert.equal(f.button.style.display, 'none');
  assert.equal(f.context._vmSpeaking, true);
});

test('a manual read can return from another page to its saved chat and clears when playback ends', () => {
  const f = fixture();
  f.context._vmSpeaking = false;
  f.context._currentViewId = 'sec-notes';
  f.context.recentChats.pop();
  f.context.savedChats.push({ key: 'source' });
  f.window._ttsManualPlayback = { sessionKey: 'source' };
  f.update();
  f.button.dispatchEvent(new Event('click'));
  assert.deepEqual(f.opened, [['saved', 0]]);
  f.window._ttsManualPlayback = null;
  [...f.intervals].forEach(callback => callback());
  assert.equal(f.button.style.display, 'none');
  assert.equal(f.intervals.size, 0);
});

test('the return speaker never opens a different chat or appears during speech-to-speech', () => {
  const f = fixture();
  f.context.activeSession = 'other';
  f.update();
  f.context.recentChats.pop(); // Source disappeared since the last paint.
  f.button.dispatchEvent(new Event('click'));
  assert.deepEqual(f.opened, []);
  f.window._topNavVoiceActive = true;
  f.update();
  assert.equal(f.button.style.display, 'none');
  f.context._hardStopChatVoice();
  assert.equal(f.stops, 0);
  assert.equal(f.aborts, 0);
  f.window._topNavVoiceActive = false;
  f.context._vmGenId++;
  f.context._hardStopChatVoice();
  assert.equal(f.stops, 1);
  assert.equal(f.aborts, 1);
});
