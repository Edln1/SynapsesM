'use strict';

const { randomUUID } = require('node:crypto');

const CANCELED = Symbol('canceled');
const canceled = () => ({ ok: false, message: 'The PC command was stopped.' });
const voiceBusyResult = () => ({ ok: false, message: 'Stop PC Voice before sending a typed command.' });
const accountRequired = () => ({ ok: false, message: 'Sign in to Synapses before sending a PC command.' });

function createPcTextSession({
  verifyAccount, isDocumentCurrent, voiceInUse, runTask, cancelTask = () => {}, makeId = randomUUID
}) {
  let pending = null;
  let session = null;

  function voiceBusy() {
    try { return Boolean(voiceInUse()); }
    catch { return true; }
  }

  function documentCurrent(account) {
    try { return isDocumentCurrent(account) === true; }
    catch { return false; }
  }

  function currentLease() {
    return pending?.lease && documentCurrent(pending.account) && !voiceBusy() ? pending.lease : null;
  }

  function active() { return currentLease() !== null; }

  function clearSession() {
    const hadTaskContext = Boolean(session);
    session = null;
    if (hadTaskContext && !voiceBusy()) {
      try { cancelTask(); } catch {}
    }
    return hadTaskContext;
  }

  function cancel() {
    const turn = pending;
    pending = null;
    if (turn) {
      turn.controller.abort();
      turn.finishCancellation(CANCELED);
    }
    // Account verification does not own the runner. Avoid aborting a voice
    // command if it took ownership while the verification was pending.
    const hadTaskContext = clearSession();
    return Boolean(turn || hadTaskContext);
  }

  async function run(text) {
    if (typeof text !== 'string' || !text.trim() || text.length > 1000 || /[\u0000-\u001f\u007f]/.test(text)) {
      return { ok: false, message: 'Enter a PC command of up to 1,000 characters on one line.' };
    }
    if (pending) return { ok: false, message: 'A PC command is already running.' };
    if (voiceBusy()) return voiceBusyResult();

    const turn = { controller: new AbortController(), account: null, lease: null, finishCancellation: null };
    const cancellation = new Promise(resolve => { turn.finishCancellation = resolve; });
    pending = turn;
    try {
      const account = await Promise.race([verifyAccount(), cancellation]);
      if (pending !== turn || account === CANCELED) return canceled();
      if (voiceBusy()) return voiceBusyResult();
      if (!account || typeof account.userId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(account.userId) || !account.frame) {
        clearSession();
        return accountRequired();
      }
      if (!documentCurrent(account)) {
        clearSession();
        return { ok: false, message: 'The Synapses page changed. Try your PC command again.' };
      }
      if (!session || session.userId !== account.userId || session.frame !== account.frame) {
        clearSession();
        session = { userId: account.userId, frame: account.frame, id: makeId() };
      }
      turn.account = account;
      turn.lease = Object.freeze({ userId: session.userId, frame: session.frame, voiceSessionId: session.id });
      const result = await Promise.race([
        runTask(text.trim(), { userId: session.userId, voiceSessionId: session.id, signal: turn.controller.signal }),
        cancellation
      ]);
      if (result === CANCELED || currentLease() !== turn.lease) {
        if (pending === turn) cancel();
        return canceled();
      }
      const message = typeof result?.message === 'string' && result.message.trim() ? result.message.slice(0, 500) : '';
      if (result?.handled !== true) return { ok: false, message: message || 'Tell Ava what to do on your PC, such as opening an app or website.' };
      return { ok: result.ok === true, message: message || (result.ok === true ? 'PC command complete.' : 'Ava could not complete the PC command.') };
    } catch {
      if (pending !== turn) return canceled();
      if (turn.lease && currentLease() !== turn.lease) {
        cancel();
        return canceled();
      }
      return { ok: false, message: turn.lease ? 'Ava could not complete the PC command. Try again.' : 'Ava could not verify your Synapses account. Open Synapses and try again.' };
    } finally {
      if (pending === turn) pending = null;
    }
  }

  return { run, cancel, active, currentLease, state: () => ({ busy: pending !== null, active: active() }) };
}

module.exports = { createPcTextSession };
