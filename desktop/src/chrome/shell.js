'use strict';
document.getElementById('navigation').addEventListener('click', () => window.synapsesWindow.toggleNavigation());
document.getElementById('minimize').addEventListener('click', () => window.synapsesWindow.minimize());
document.getElementById('maximize').addEventListener('click', () => window.synapsesWindow.toggleMaximize());
document.getElementById('close').addEventListener('click', () => window.synapsesWindow.close());
window.synapsesWindow.onState(state => {
  document.body.classList.toggle('maximized', state.maximized);
  const control = document.getElementById('maximize');
  control.setAttribute('aria-label', state.maximized ? 'Restore' : 'Maximize');
  control.title = state.maximized ? 'Restore' : 'Maximize';
});
