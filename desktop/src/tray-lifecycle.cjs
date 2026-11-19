'use strict';

function createTrayLifecycle({ stopVoice, stopBeforeQuit = stopVoice, hideWindow, restoreWindow, closeContents, quitCleanupTimeoutMs = 400 }) {
  let quitting = false, generation = 0, hiding = null, closing = null;
  function restore() { generation++; restoreWindow(); }
  function cancelQuit() { quitting = false; restore(); }
  function hide() {
    if (quitting) return Promise.resolve(false);
    if (hiding) return hiding;
    const ticket = ++generation;
    hiding = Promise.resolve().then(stopVoice).then(stopped => {
      if (stopped === false || quitting || ticket !== generation) return false;
      hideWindow(); return true;
    }).catch(() => false).finally(() => { hiding = null; });
    return hiding;
  }
  function quit() {
    if (quitting) return closing || Promise.resolve(false);
    quitting = true; restore();
    let cleanupTimer;
    const cleanup = Promise.race([
      Promise.resolve().then(stopBeforeQuit).catch(() => false),
      new Promise(resolve => { cleanupTimer = setTimeout(() => resolve(false), quitCleanupTimeoutMs); })
    ]).finally(() => clearTimeout(cleanupTimer));
    closing = cleanup.then(() => {
      if (!quitting) return false;
      closeContents(); return true;
    }).catch(() => { cancelQuit(); return false; }).finally(() => { closing = null; });
    return closing;
  }
  return { hide, restore, quit, cancelQuit, isQuitting: () => quitting };
}
module.exports = { createTrayLifecycle };
