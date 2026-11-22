(function (root, factory) {
  'use strict';
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AvaMobileReadAloud = api;
})(typeof window !== 'undefined' ? window : globalThis, function (host) {
  'use strict';

  // Twenty milliseconds of silent PCM. Only played, muted, during an explicit
  // enable/retry gesture to unlock the SAME owned audio element on mobile.
  var SILENCE = 'data:audio/wav;base64,UklGRsQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YaAAAACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICA';

  var MAX_CLIP_CHARS = 380;
  var AUDIO_TIMEOUT_MS = 10000;

  function speechBoundary(text, opening) {
    var minimum = opening ? 15 : 42, maximum = opening ? 140 : MAX_CLIP_CHARS;
    var ends = /[.!?]["”’)]{0,3}(?=\s|$)|[。！？][」』”）]{0,3}/g, match;
    while ((match = ends.exec(text))) {
      var end = match.index + match[0].length;
      if (end > maximum) break;
      if (end < minimum) continue;
      var first = text.slice(0, end);
      if (/\b(?:mr|mrs|ms|dr|prof|vs|st|e\.g|i\.e)\.$/i.test(first) || /\b[A-Z0-9]\.$/.test(first)) continue;
      return end;
    }
    if (opening) {
      var phrase = /[,;:—](?=\s)/g;
      while ((match = phrase.exec(text))) {
        if (match.index >= maximum) break;
        if (match.index >= 42) return match.index + 1;
      }
    }
    if (text.length < (opening ? 105 : 320)) return 0;
    var cut = text.lastIndexOf(' ', maximum);
    return cut >= (opening ? 52 : 140) ? cut : 0;
  }

  function keepsPrefix(text, prefix) {
    if (!text.startsWith(prefix)) return false;
    return !prefix || text.length === prefix.length || /[^\p{L}\p{N}]/u.test(prefix.slice(-1) + text.charAt(prefix.length));
  }

  function unreadStart(finalText, spoken) {
    if (!spoken) return 0;
    if (keepsPrefix(finalText, spoken)) return spoken.length;
    var words = Array.from(finalText.matchAll(/[\p{L}\p{N}]+/gu));
    var heard = spoken.toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
    var plain = words.map(function (word) { return word[0].toLowerCase(); });
    var shared = 0;
    while (shared < heard.length && heard[shared] === plain[shared]) shared++;
    if (!shared) return 0;
    return words[shared] ? words[shared].index : finalText.length;
  }

  function create(options) {
    options = options || {};
    if (typeof options.getContext !== 'function' || typeof options.synthesize !== 'function') {
      throw new TypeError('Read aloud requires getContext and synthesize.');
    }
    var makeAudio = options.createAudio || function () { return new host.Audio(); };
    var makeURL = options.createObjectURL || function (blob) { return host.URL.createObjectURL(blob); };
    var revokeURL = options.revokeObjectURL || function (url) { host.URL.revokeObjectURL(url); };
    var Abort = options.AbortController || host.AbortController;
    var conversationScoped = options.conversationScoped === true;
    var storage = options.storage;
    var preferencePrefix = 'synapses_ava_read_aloud_v1_';
    var context = readContext(), enabled = readPreference(context.ownerKey);
    var status = 'idle', error = null, destroyed = false, audioOperation = 0;
    var audio = null, audioDefaults = null, url = null, response = null, stream = null;
    var completed = new Set();

    function key(value) { return typeof value === 'string' ? value.slice(0, 512) : ''; }
    function preferenceKey(owner) { return preferencePrefix + encodeURIComponent(owner); }
    function readPreference(owner) {
      if (conversationScoped || !owner || !storage) return false;
      try { return storage.getItem(preferenceKey(owner)) === '1'; } catch (_) { return false; }
    }
    function readContext() {
      try {
        var value = options.getContext() || {};
        return { ownerKey: key(value.ownerKey), threadId: key(value.threadId), voiceActive: !!value.voiceActive };
      } catch (_) { return { ownerKey: '', threadId: '', voiceActive: false }; }
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
    function dropResponse() {
      var old = response; response = null;
      if (old) old.clips.forEach(function (clip) { if (clip.controller) clip.controller.abort(); });
      pauseOwned();
    }
    function cancel() {
      stream = null;
      dropResponse();
    }
    function contextChanged() {
      if (destroyed) return state();
      var next = readContext();
      var ownerChanged = next.ownerKey !== context.ownerKey;
      var threadChanged = next.threadId !== context.threadId;
      if (ownerChanged || threadChanged || next.voiceActive) {
        cancel();
        if (ownerChanged) { completed.clear(); enabled = readPreference(next.ownerKey); }
        else if (conversationScoped && threadChanged && context.threadId) enabled = false;
        context = next;
        publish('idle');
      } else context = next;
      return state();
    }
    function sameContext(item) {
      contextChanged();
      return !destroyed && enabled &&
        !!context.ownerKey && !!context.threadId && !context.voiceActive &&
        context.ownerKey === item.ownerKey && context.threadId === item.threadId;
    }
    function current(item) { return sameContext(item) && response === item; }
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
      enabled = next;
      if (!conversationScoped && context.ownerKey && storage) {
        try { storage.setItem(preferenceKey(context.ownerKey), enabled ? '1' : '0'); } catch (_) {}
      }
      if (!enabled) cancel();
      publish('idle');
      if (enabled) prime();
      return state();
    }
    function ignore(reason) { return Promise.resolve({ status: 'ignored', reason: reason }); }
    function playOwned(item) {
      if (!current(item) || !url) return ignore('stale');
      var a, result, operation = ++audioOperation;
      var clip = item.clips[item.index];
      function fail(cause) {
        if (!current(item) || operation !== audioOperation) return { status: 'ignored', reason: 'stale' };
        audioOperation++;
        item.playing = false;
        a.onended = null; a.onerror = null;
        try { a.pause(); } catch (_) {}
        var blocked = cause && cause.name === 'NotAllowedError';
        if (!blocked) {
          releaseURL();
          item.clips[item.index].pending = null;
        }
        publish(blocked ? 'blocked' : 'error', blocked ? 'Tap the speaker to play this reply.' : 'Could not play this reply. Try again.');
        return { status: status };
      }
      try {
        a = getAudio(); restoreVolume(a);
        a.onended = function () {
          if (!current(item) || operation !== audioOperation) return;
          item.playing = false;
          audioOperation++;
          a.onended = null; a.onerror = null;
          releaseURL();
          item.clips[item.index].pending = null;
          item.index++;
          enqueueAvailable(item);
          advance(item);
        };
        a.onerror = function () { fail(new Error('Playback failed')); };
        a.src = url;
        publish('loading');
        if (!current(item) || operation !== audioOperation) return ignore('stale');
        result = a.play();
        item.playing = true;
      } catch (cause) {
        if (!a) {
          if (current(item)) { releaseURL(); publish('error', 'Audio is unavailable. Try again.'); }
          return Promise.resolve({ status: 'error' });
        }
        return Promise.resolve(fail(cause));
      }
      return Promise.resolve(result).then(function () {
        if (!current(item) || operation !== audioOperation) return { status: 'ignored', reason: 'stale' };
        if (clip.prefix) item.spoken = clip.prefix;
        publish('speaking');
        enqueueAvailable(item);
        prefetchNext(item);
        return { status: 'speaking' };
      }, fail);
    }
    function prepare(clip) {
      if (clip.pending) return clip.pending;
      var request = new Abort();
      clip.controller = request;
      clip.pending = new Promise(function (resolve) {
        var settled = false;
        // The hosted transport's timeout ends at the response headers. Also
        // bound the body download and settle even if the transport ignores abort.
        var timer = setTimeout(function () { request.abort(); }, AUDIO_TIMEOUT_MS);
        function onAbort() { finish(null); }
        function finish(blob) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          request.signal.removeEventListener('abort', onAbort);
          clip.controller = null;
          resolve(blob);
        }
        request.signal.addEventListener('abort', onAbort, { once: true });
        try {
          // Legacy installations can still have the retired Hume TTS API saved.
          if (host._ttsProvider === 'hume' && !host._elevenSelected && typeof host._setTtsProvider === 'function') {
            host._setTtsProvider('deepgram');
            if (typeof host.showToast === 'function') host.showToast('Hume voices were retired. Ava is using Deepgram.');
          }
          Promise.resolve(options.synthesize(clip.text, request)).then(finish, onAbort);
        } catch (_) { finish(null); }
      });
      return clip.pending;
    }
    function prefetchNext(item) {
      var next = item.clips[item.index + 1];
      if (current(item) && next) prepare(next);
    }
    function addClip(item, text, prefix) {
      if (text) item.clips.push({ text: text, prefix: prefix, controller: null, pending: null });
    }
    function addFinalClips(item, text) {
      while (text.length > MAX_CLIP_CHARS) {
        var sample = text.slice(0, MAX_CLIP_CHARS);
        var boundaries = [...sample.matchAll(/[.!?](?=\s)|[。！？]/g)];
        var cut = boundaries.length ? boundaries[boundaries.length - 1].index + 1 : 0;
        if (cut < 140) cut = sample.lastIndexOf(' ', MAX_CLIP_CHARS);
        if (cut < 140) {
          cut = MAX_CLIP_CHARS;
          if (/[\uD800-\uDBFF]/.test(text[cut - 1])) cut--;
        }
        addClip(item, text.slice(0, cut).trim());
        text = text.slice(cut).trimStart();
      }
      addClip(item, text);
    }
    function advance(item) {
      if (!current(item)) return ignore('stale');
      var clip = item.clips[item.index];
      if (!clip) {
        if (item.finished) { response = null; publish('idle'); }
        else publish('loading');
        return ignore('no-clip');
      }
      publish('loading');
      var prefetched = !!clip.pending;
      var pending = prepare(clip);
      prefetchNext(item);
      return pending.then(function (blob) {
        if (blob || !prefetched || !current(item) || clip !== item.clips[item.index]) return blob;
        clip.pending = null;
        return prepare(clip);
      }).then(function (blob) {
        if (!current(item) || clip !== item.clips[item.index]) return { status: 'ignored', reason: 'stale' };
        if (!blob) { publish('error', 'Could not load speech. Try again.'); return { status: 'error' }; }
        try { url = makeURL(blob); if (!url) throw new Error('Audio unavailable'); }
        catch (_) { publish('error', 'Could not load speech. Try again.'); return { status: 'error' }; }
        return playOwned(item);
      });
    }
    function cleanText(value) {
      var plain = typeof options.cleanText === 'function' ? options.cleanText(value) : value;
      return typeof plain === 'string' ? plain.replace(/\s+/g, ' ').trim() : '';
    }
    function enqueueAvailable(item) {
      var early = item.stream;
      if (!early || item.finished || early.revised) return;
      while (item.clips.length - item.index < 2) {
        var tail = early.text.slice(early.consumed).trimStart();
        var cut = speechBoundary(tail, !early.consumed);
        if (!cut) return;
        early.consumed = early.text.length - tail.length + cut;
        addClip(item, tail.slice(0, cut), early.text.slice(0, early.consumed));
      }
    }
    function discardUnread(item) {
      if (!item.playing) pauseOwned();
      var next = item.index + (item.playing ? 1 : 0);
      item.clips.splice(next).forEach(function (clip) { if (clip.controller) clip.controller.abort(); });
    }
    function matchesContext(value) {
      return value && !destroyed && enabled && context.ownerKey && context.threadId && !context.voiceActive &&
        key(value.ownerKey) === context.ownerKey && key(value.threadId) === context.threadId && key(value.responseId);
    }
    function progress(value) {
      contextChanged();
      if (!matchesContext(value)) return;
      var responseId = key(value.responseId);
      if (completed.has(JSON.stringify([context.threadId, responseId]))) return;
      var partial = typeof value.text === 'string' ? value.text : '';
      var plain;
      try {
        // Keep an unfinished link or fenced code block out of early speech.
        partial = partial.split(/```|@@AVA_SOURCES_HTML@@|\[[^\]]*\]\(https?:[^)]*$/i)[0];
        plain = cleanText(partial);
      } catch (_) { return; }
      if (!stream || stream.id !== responseId) {
        cancel();
        stream = { id: responseId, text: '', consumed: 0, revised: false };
      }
      var early = stream;
      if (early.revised) return;
      var hasResponse = response && response.stream === early;
      if (early.consumed && !keepsPrefix(plain, early.text.slice(0, early.consumed))) {
        early.revised = true;
        if (hasResponse) discardUnread(response);
        return;
      }
      early.text = plain;
      var item = hasResponse ? response : newResponse(early);
      var waiting = item.index === item.clips.length;
      enqueueAvailable(item);
      if (item.index === item.clips.length) return;
      response = item;
      if (waiting) advance(item);
      else prefetchNext(item);
    }
    function newResponse(early) {
      return { ownerKey: context.ownerKey, threadId: context.threadId, stream: early, clips: [], index: 0,
        finished: false, spoken: '', playing: false };
    }
    function complete(value) {
      contextChanged();
      if (destroyed || !enabled) return ignore('disabled');
      if (!matchesContext(value)) return ignore('context');
      var id = JSON.stringify([context.threadId, key(value.responseId)]);
      if (completed.has(id)) return ignore('duplicate');
      var clean;
      try { clean = cleanText(value.text); }
      catch (_) { publish('error', 'Could not read this reply.'); return Promise.resolve({ status: 'error' }); }
      if (!clean) {
        if (stream && stream.id === key(value.responseId)) { cancel(); publish('idle'); }
        return ignore('empty');
      }
      completed.add(id);
      if (completed.size > 200) completed.delete(completed.values().next().value);
      var early = stream;
      stream = null;
      var item = response;
      if (early && early.id === key(value.responseId) && item && item.stream === early) {
        var start = early.consumed;
        var waiting = item.index === item.clips.length;
        if (early.revised || !keepsPrefix(clean, early.text.slice(0, start))) {
          // Keep the clip in the speaker. Replace only audio that hasn't played.
          var retained = item.playing && item.clips[item.index];
          discardUnread(item);
          start = unreadStart(clean, retained && retained.prefix || item.spoken);
          waiting = !item.playing;
        }
        item.finished = true;
        addFinalClips(item, clean.slice(start).trimStart());
        if (waiting) return advance(item);
        prefetchNext(item);
        return ignore('already-started');
      }
      dropResponse();
      response = newResponse(null);
      response.finished = true;
      var cut = clean.length >= 160 ? speechBoundary(clean, true) : 0;
      if (cut) addClip(response, clean.slice(0, cut));
      addFinalClips(response, clean.slice(cut).trimStart());
      return advance(response);
    }
    function play() {
      contextChanged();
      if (destroyed || !enabled || !response || context.voiceActive) return ignore('unavailable');
      if (status === 'loading' || status === 'speaking') return ignore('busy');
      if (url) return playOwned(response); // Synchronous audio.play() preserves user activation.
      var clip = response.clips[response.index];
      if (!clip) return ignore('unavailable');
      clip.pending = null;
      prime();
      return advance(response);
    }
    function stop() {
      if (destroyed) return state();
      cancel(); publish('idle'); return state();
    }
    function destroy() {
      if (destroyed) return;
      cancel(); destroyed = true; enabled = false; publish('idle'); audio = null;
    }
    var api = { setEnabled: setEnabled, toggle: function () { contextChanged(); return setEnabled(!enabled); }, progress: progress, complete: complete,
      contextChanged: contextChanged, stop: stop, play: play, retry: play, destroy: destroy };
    Object.defineProperty(api, 'state', { enumerable: true, get: state });
    publish('idle');
    return api;
  }

  return { create: create };
});
