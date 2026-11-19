(function (root, factory) {
  'use strict';
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AvaReadAloud = api;
})(typeof window !== 'undefined' ? window : globalThis, function (host) {
  'use strict';

  // Twenty milliseconds of silent PCM. Only played, muted, during an explicit
  // enable/retry gesture to unlock the SAME owned audio element on mobile.
  var SILENCE = 'data:audio/wav;base64,UklGRsQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YaAAAACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICA';

  function create(options) {
    options = options || {};
    if (typeof options.getContext !== 'function' || typeof options.synthesize !== 'function') {
      throw new TypeError('Read aloud requires getContext and synthesize.');
    }
    var makeAudio = options.createAudio || function () { return new host.Audio(); };
    var makeURL = options.createObjectURL || function (blob) { return host.URL.createObjectURL(blob); };
    var revokeURL = options.revokeObjectURL || function (url) { host.URL.revokeObjectURL(url); };
    var Abort = options.AbortController || host.AbortController;
    var storage = options.storage || null;
    var prefix = typeof options.storagePrefix === 'string' ? options.storagePrefix : 'synapses_ava_read_aloud_v1_';
    var context = readContext(), enabled = readPreference(context.ownerKey);
    var status = 'idle', error = null, destroyed = false, generation = 0, audioOperation = 0;
    var audio = null, audioDefaults = null, url = null, controller = null, response = null;
    var completed = new Set();

    function key(value) { return typeof value === 'string' ? value.slice(0, 512) : ''; }
    function readContext() {
      try {
        var value = options.getContext() || {};
        return { ownerKey: key(value.ownerKey), threadId: key(value.threadId), voiceActive: !!value.voiceActive };
      } catch (_) { return { ownerKey: '', threadId: '', voiceActive: false }; }
    }
    function preferenceKey(owner) { return prefix + encodeURIComponent(owner); }
    function readPreference(owner) {
      if (!owner || !storage) return false;
      try { return storage.getItem(preferenceKey(owner)) === '1'; } catch (_) { return false; }
    }
    function savePreference() {
      if (!context.ownerKey || !storage) return;
      try { storage.setItem(preferenceKey(context.ownerKey), enabled ? '1' : '0'); } catch (_) {}
    }
    function state() { return { enabled: enabled, status: status, error: error }; }
    function publish(next, message) {
      status = next; error = message || null;
      if (typeof options.onState === 'function') {
        try { options.onState(state()); } catch (_) {}
      }
    }
    function getAudio() {
      if (!audio) {
        var candidate = makeAudio();
        if (!candidate || typeof candidate.play !== 'function' || typeof candidate.pause !== 'function') throw new Error('Audio unavailable');
        audio = candidate;
        audioDefaults = { muted: !!audio.muted, volume: typeof audio.volume === 'number' ? audio.volume : 1 };
      }
      return audio;
    }
    function restoreVolume(a) {
      try { a.muted = audioDefaults.muted; a.volume = audioDefaults.volume; } catch (_) {}
    }
    function releaseURL() {
      var old = url; url = null;
      if (old) { try { revokeURL(old); } catch (_) {} }
    }
    function pauseOwned() {
      audioOperation++;
      if (audio) {
        audio.onended = null; audio.onerror = null;
        try { audio.pause(); } catch (_) {}
        try { audio.currentTime = 0; } catch (_) {}
        try { if (audio.removeAttribute) audio.removeAttribute('src'); else audio.src = ''; } catch (_) {}
        try { if (audio.load) audio.load(); } catch (_) {}
        restoreVolume(audio);
      }
      releaseURL();
    }
    function cancel(clearResponse) {
      generation++;
      if (controller) { var old = controller; controller = null; try { old.abort(); } catch (_) {} }
      pauseOwned();
      if (clearResponse) response = null;
    }
    function contextChanged() {
      if (destroyed) return state();
      var next = readContext();
      var ownerChanged = next.ownerKey !== context.ownerKey;
      var changed = ownerChanged || next.threadId !== context.threadId;
      if (changed || next.voiceActive) {
        cancel(true);
        if (ownerChanged) { completed.clear(); enabled = readPreference(next.ownerKey); }
        context = next;
        publish('idle');
      } else context = next;
      return state();
    }
    function current(item, token) {
      contextChanged();
      return !destroyed && enabled && generation === token && response === item &&
        !!context.ownerKey && !!context.threadId && !context.voiceActive &&
        context.ownerKey === item.ownerKey && context.threadId === item.threadId;
    }
    function prime() {
      if (destroyed || !enabled || !context.ownerKey || context.voiceActive) return;
      try {
        var a = getAudio(), operation = ++audioOperation;
        a.onended = null; a.onerror = null;
        a.muted = true; a.volume = 0; a.src = SILENCE;
        var result = a.play(); // Must be called synchronously inside the user's gesture.
        var finish = function () {
          if (destroyed || operation !== audioOperation) return;
          try { a.pause(); a.currentTime = 0; } catch (_) {}
          restoreVolume(a);
        };
        Promise.resolve(result).then(finish, finish);
      } catch (_) { /* Real reply playback reports any permission/device error. */ }
    }
    function setEnabled(value) {
      if (destroyed) return state();
      contextChanged();
      var next = !!value && !!context.ownerKey;
      if (next === enabled) return state();
      enabled = next; savePreference();
      if (!enabled) cancel(true);
      publish('idle');
      if (enabled) prime();
      return state();
    }
    function ignore(reason) { return Promise.resolve({ status: 'ignored', reason: reason }); }
    function playOwned(item, token) {
      if (!current(item, token) || !url) return ignore('stale');
      var a, result, operation = ++audioOperation;
      function fail(cause) {
        if (!current(item, token) || operation !== audioOperation) return { status: 'ignored', reason: 'stale' };
        audioOperation++;
        a.onended = null; a.onerror = null;
        try { a.pause(); } catch (_) {}
        var blocked = cause && cause.name === 'NotAllowedError';
        publish(blocked ? 'blocked' : 'error', blocked ? 'Tap the speaker to play this reply.' : 'Could not play this reply. Try again.');
        return { status: status };
      }
      try {
        a = getAudio(); restoreVolume(a);
        a.onended = function () {
          if (!current(item, token) || operation !== audioOperation) return;
          pauseOwned(); response = null; publish('idle');
        };
        a.onerror = function () { fail(new Error('Playback failed')); };
        a.src = url;
        publish('loading');
        if (!current(item, token) || operation !== audioOperation) return ignore('stale');
        result = a.play();
      } catch (cause) {
        if (!a) {
          if (current(item, token)) { releaseURL(); publish('error', 'Audio is unavailable. Try again.'); }
          return Promise.resolve({ status: 'error' });
        }
        return Promise.resolve(fail(cause));
      }
      return Promise.resolve(result).then(function () {
        if (!current(item, token) || operation !== audioOperation) return { status: 'ignored', reason: 'stale' };
        publish('speaking');
        return { status: 'speaking' };
      }, fail);
    }
    function synthesize(item) {
      cancel(false); response = item;
      var token = generation, pending;
      try {
        controller = new Abort();
        publish('loading');
        if (!current(item, token)) return ignore('stale');
        pending = options.synthesize(item.text, controller);
      } catch (_) {
        controller = null;
        if (current(item, token)) publish('error', 'Could not load speech. Try again.');
        return Promise.resolve({ status: 'error' });
      }
      return Promise.resolve(pending).then(function (blob) {
        if (!current(item, token)) return { status: 'ignored', reason: 'stale' };
        controller = null;
        try { url = makeURL(blob); if (!url) throw new Error('Audio unavailable'); }
        catch (_) { publish('error', 'Could not load speech. Try again.'); return { status: 'error' }; }
        return playOwned(item, token);
      }, function () {
        if (!current(item, token)) return { status: 'ignored', reason: 'stale' };
        controller = null; publish('error', 'Could not load speech. Try again.');
        return { status: 'error' };
      });
    }
    function complete(value) {
      contextChanged();
      if (destroyed || !enabled) return ignore('disabled');
      if (!context.ownerKey || !context.threadId || context.voiceActive) return ignore('context');
      value = value || {};
      if (key(value.ownerKey) !== context.ownerKey || key(value.threadId) !== context.threadId || !key(value.responseId)) return ignore('context');
      var id = JSON.stringify([context.threadId, key(value.responseId)]);
      if (completed.has(id)) return ignore('duplicate');
      var clean;
      try { clean = typeof options.cleanText === 'function' ? options.cleanText(value.text) : value.text; clean = typeof clean === 'string' ? clean.trim() : ''; }
      catch (_) { publish('error', 'Could not read this reply.'); return Promise.resolve({ status: 'error' }); }
      if (!clean) return ignore('empty');
      completed.add(id);
      if (completed.size > 200) completed.delete(completed.values().next().value);
      return synthesize({ text: clean, ownerKey: context.ownerKey, threadId: context.threadId, responseId: key(value.responseId) });
    }
    function play() {
      contextChanged();
      if (destroyed || !enabled || !response || context.voiceActive) return ignore('unavailable');
      if (status === 'loading' || status === 'speaking') return ignore('busy');
      if (url) return playOwned(response, generation); // Synchronous audio.play() preserves user activation.
      prime();
      return synthesize(response);
    }
    function stop() {
      if (destroyed) return state();
      cancel(true); publish('idle'); return state();
    }
    function destroy() {
      if (destroyed) return;
      cancel(true); destroyed = true; enabled = false; publish('idle'); audio = null;
    }
    var api = { setEnabled: setEnabled, toggle: function () { contextChanged(); return setEnabled(!enabled); }, complete: complete,
      contextChanged: contextChanged, stop: stop, play: play, retry: play, destroy: destroy };
    Object.defineProperty(api, 'state', { enumerable: true, get: state });
    publish('idle');
    return api;
  }

  return { create: create };
});
