import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
function extract(start, end) {
  const from = html.indexOf(start), to = html.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `Missing production auth boundary: ${start}`);
  return html.slice(from, to);
}
const source = [
  extract('  function showAuthModal(){', '  window.showAuthModal = showAuthModal;'),
  extract('function authReset(){', 'function authShowForms(mode){'),
  extract('function authShowForms(mode){', '/** Shows the waitlist gate'),
  extract('function authShowWaitlist(){', 'window.authShowWaitlist = authShowWaitlist;'),
  extract('function authBackToStart(){', 'function authRegGoStep(n){'),
  extract('function authRegGoStep(n){', 'function authRegNext(fromStep){'),
  extract('function switchAuthTab(t){', 'function doLogin(){'),
].join('\n');

class Element {
  constructor() {
    this.style = { display: 'none' }; this.value = ''; this.textContent = '';
    this.scrollTop = 0; this.focuses = 0;
    const classes = new Set();
    this.classList = { contains: value => classes.has(value),
      add: value => classes.add(value), remove: value => classes.delete(value),
      toggle(value, force) {
        const enabled = force === undefined ? !classes.has(value) : force;
        if (enabled) classes.add(value); else classes.delete(value);
        return enabled;
      } };
  }
  focus() { this.focuses++; }
}
function setup({ search = '?ava-app=1', waitlist = true, email = '', readyState = 'complete' } = {}) {
  const ids = ['authModal', 'authStepStart', 'authStepForms', 'authStepWaitlist', 'loginEmail',
    'loginPass', 'loginErr', 'registerErr', 'loginForm', 'registerForm', 'tabLogin', 'tabRegister',
    'authRightPanel', 'authProgress', 'apDot1', 'apDot2', 'apDot3', 'regStep1', 'regStep2',
    'regStep3', 'waitlistFormWrap', 'waitlistDoneWrap', 'waitlistDoneSub'];
  const nodes = new Map(ids.map(id => [id, new Element()]));
  nodes.get('authStepStart').style.display = 'flex';
  nodes.get('loginForm').style.display = 'flex';
  const storage = new Map(email ? [['synapses_last_email', email]] : []), events = new Map();
  const window = { _waitlistGateActive: false,
    addEventListener(name, handler) { events.set(name, handler); } };
  const context = vm.createContext({ window, location: { search }, URLSearchParams,
    document: { readyState, getElementById: id => nodes.get(id) || null },
    localStorage: { getItem: key => storage.get(key) ?? null },
    WAITLIST_MODE: waitlist, _loginAnimStarted: false,
    authSetLeftView() {}, authSetLeftDots() {}, authSetLeftCopy() {},
    authPreviewSync() {}, authRenderLastMethod() {},
  });
  vm.runInContext(source, context);
  return { context, window, nodes, events, storage,
    node: id => nodes.get(id), display: id => nodes.get(id).style.display };
}

test('exact Ava entry opens the real login form without the generic landing or waitlist step', () => {
  const f = setup(); f.context.showAuthModal();
  assert.equal(f.display('authModal'), 'flex');
  assert.equal(f.display('authStepForms'), 'flex'); assert.equal(f.display('loginForm'), 'flex');
  assert.equal(f.display('authStepStart'), 'none'); assert.equal(f.display('authStepWaitlist'), 'none');
  assert.equal(f.window._waitlistGateActive, true, 'The configured registration gate stays active');
});

test('Ava entry preserves email prefill and never focuses inputs or enters an authenticated session', () => {
  const f = setup({ email: 'member@example.com' }); f.context.showAuthModal();
  assert.equal(f.node('loginEmail').value, 'member@example.com');
  assert.equal(f.node('loginPass').value, '');
  assert.equal(f.node('loginEmail').focuses + f.node('loginPass').focuses, 0);
  assert.equal(f.context.currentUser, undefined);
  assert.equal(f.storage.size, 1);
});

test('ordinary and non-exact routes retain the configured Synapses waitlist front door', () => {
  for (const search of ['', '?ava-app=0', '?ava-app=true', '?view=ava']) {
    const f = setup({ search }); f.context.showAuthModal();
    assert.equal(f.display('authStepWaitlist'), 'flex', search);
    assert.equal(f.display('authStepForms'), 'none', search);
    assert.equal(f.window._waitlistGateActive, true);
  }
});

test('when waitlist is disabled, ordinary first-time and returning-user routes are unchanged', () => {
  const first = setup({ search: '', waitlist: false }); first.context.showAuthModal();
  assert.equal(first.display('authStepStart'), 'flex'); assert.equal(first.display('authStepForms'), 'none');
  const returning = setup({ search: '', waitlist: false, email: 'member@example.com' });
  returning.context.showAuthModal(); assert.equal(returning.display('loginForm'), 'flex');
  assert.equal(returning.display('authStepForms'), 'flex');
});

test('the existing authShowForms registration gate remains enforced in Ava', () => {
  const f = setup(); f.context.showAuthModal(); f.context.authShowForms('register');
  assert.equal(f.display('loginForm'), 'flex'); assert.equal(f.display('registerForm'), 'none');
  const open = setup({ waitlist: false }); open.context.showAuthModal(); open.context.authShowForms('register');
  assert.equal(open.display('registerForm'), 'block'); assert.equal(open.window._waitlistGateActive, false);
});

test('Back from Ava sign-in returns to sign-in while preserving the waitlist policy flag', () => {
  const f = setup(); f.context.showAuthModal(); f.context.authBackToStart();
  assert.equal(f.display('authStepForms'), 'flex'); assert.equal(f.display('loginForm'), 'flex');
  assert.equal(f.display('authStepWaitlist'), 'none'); assert.equal(f.display('authStepStart'), 'none');
  assert.equal(f.window._waitlistGateActive, true);
});

test('Ava registration keeps the actual later wizard Back behavior', () => {
  const f = setup({ waitlist: false }); f.context.showAuthModal(); f.context.authShowForms('register');
  f.context.authRegGoStep(3); f.context.authBackToStart();
  assert.equal(f.node('regStep2').classList.contains('active'), true);
  f.context.authBackToStart(); assert.equal(f.node('regStep1').classList.contains('active'), true);
  f.context.authBackToStart(); assert.equal(f.display('loginForm'), 'flex');
  assert.equal(f.display('authStepStart'), 'none');
});

test('desktop Back still returns gated users to waitlist and ungated users to the original start', () => {
  const gated = setup({ search: '' }); gated.context.showAuthModal();
  gated.context.authShowForms('login'); gated.context.authBackToStart();
  assert.equal(gated.display('authStepWaitlist'), 'flex');
  const open = setup({ search: '', waitlist: false }); open.context.showAuthModal();
  open.context.authShowForms('login'); open.context.authBackToStart();
  assert.equal(open.display('authStepStart'), 'flex'); assert.equal(open.display('authStepForms'), 'none');
});

test('auth opened before DOMContentLoaded still selects Ava sign-in when the DOM becomes ready', () => {
  const f = setup({ readyState: 'loading' }); f.context.showAuthModal();
  assert.equal(f.display('authModal'), 'none');
  f.events.get('DOMContentLoaded')();
  assert.equal(f.display('authStepForms'), 'flex'); assert.equal(f.display('loginForm'), 'flex');
  assert.equal(f.display('authStepWaitlist'), 'none');
});
