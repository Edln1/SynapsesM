'use strict';

function createTrayTypingMode({ openCommand, closeCommand, openSynapses, onChange = () => {} }) {
  let enabled = false;

  function enable() {
    if (!enabled) {
      enabled = true;
      onChange();
    }
    return openCommand();
  }

  function disable() {
    if (!enabled) return;
    enabled = false;
    closeCommand();
    onChange();
  }

  function click() {
    return enabled ? openCommand() : openSynapses();
  }

  return { enable, disable, click, isEnabled: () => enabled };
}

module.exports = { createTrayTypingMode };
