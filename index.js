/* ═══════════════════════════════════════════════════════════════════
   IMF ProTrack — Login Page (index.js)
   Depends on core.js for: getSess(), login(), toast()
   Login flow, session storage, audit logging all live in core.js login().
   This file only wires the form UI, handles the loading state, and maps
   Firebase auth errors to human-readable messages.
   ═══════════════════════════════════════════════════════════════════ */

'use strict';

/* ── Map Firebase auth error codes → friendly inline messages ── */
function authErrorMessage(err) {
  const code = (err && err.code) || '';
  switch (code) {
    case 'auth/invalid-email':
      return 'That email address is not valid.';
    case 'auth/user-disabled':
      return 'This account has been disabled. Contact your administrator.';
    case 'auth/user-not-found':
    case 'auth/wrong-password':
    case 'auth/invalid-credential':
    case 'auth/invalid-login-credentials':
      return 'Incorrect email or password. Please try again.';
    case 'auth/too-many-requests':
      return 'Too many failed attempts. Please wait a moment and try again.';
    case 'auth/network-request-failed':
      return 'Network error. Check your connection and try again.';
    default:
      /* login() in core.js throws plain Error() for profile/active checks */
      return (err && err.message) || 'Unable to sign in. Please try again.';
  }
}

/* ── Show / hide the inline error banner ── */
function showLoginError(msg) {
  const box = document.getElementById('login-error');
  const txt = document.getElementById('login-error-msg');
  if (txt) txt.textContent = msg;
  if (box) box.style.display = 'flex';
}

function clearLoginError() {
  const box = document.getElementById('login-error');
  if (box) box.style.display = 'none';
}

/* ── Toggle password visibility ── */
function togglePasswordVisibility() {
  const input = document.getElementById('login-password');
  const icon  = document.getElementById('pw-toggle-icon');
  const btn   = document.getElementById('pw-toggle-btn');
  if (!input) return;
  const isHidden = input.type === 'password';
  input.type = isHidden ? 'text' : 'password';
  if (icon) {
    icon.className = isHidden ? 'ti ti-eye-off' : 'ti ti-eye';
  }
  if (btn) btn.setAttribute('aria-label', isHidden ? 'Hide password' : 'Show password');
}

/* ── Toggle the Sign In button loading state ── */
function setLoading(isLoading) {
  const btn     = document.getElementById('login-btn');
  const label   = document.getElementById('login-btn-label');
  const spinner = document.getElementById('login-btn-spinner');
  if (!btn) return;
  btn.disabled = isLoading;
  if (label)   label.style.display   = isLoading ? 'none' : '';
  if (spinner) spinner.style.display = isLoading ? '' : 'none';
}

/* ── Handle form submit ── */
async function handleLogin(e) {
  e.preventDefault();
  clearLoginError();

  const email = document.getElementById('login-email').value.trim();
  const pass  = document.getElementById('login-password').value;

  if (!email || !pass) {
    showLoginError('Please enter both your email and password.');
    return;
  }

  setLoading(true);
  try {
    /* core.js login() authenticates, loads the user profile, checks
       isActive, stores the session via setSess(), and writes the audit log. */
    await login(email, pass);
    /* Replace so the login page is not left in browser history */
    window.location.replace('home.html');
  } catch (err) {
    showLoginError(authErrorMessage(err));
    setLoading(false);
    document.getElementById('login-password').focus();
  }
}

/* ── Online / offline indicator ──
   navigator.onLine + the online/offline events are unreliable on mobile —
   browsers frequently miss firing the event across a WiFi↔cellular handoff,
   which left this banner stuck on screen even once the device reconnected.
   A periodic re-check is the safety net so it never gets stuck either way. */
function updateConnStatus() {
  const bar = document.getElementById('login-status-bar');
  if (!bar) return;
  bar.hidden = navigator.onLine;
}

/* ── Boot ── */
document.addEventListener('DOMContentLoaded', () => {
  /* Already signed in this session? Skip straight to the dashboard. */
  if (getSess()) {
    window.location.replace('home.html');
    return;
  }

  /* Reveal the login UI */
  const loading = document.getElementById('loading-screen');
  const wrap    = document.getElementById('login-wrap');
  if (loading) loading.style.display = 'none';
  if (wrap)    wrap.style.display = 'flex';

  /* Wire connectivity listeners */
  window.addEventListener('online',  updateConnStatus);
  window.addEventListener('offline', updateConnStatus);
  updateConnStatus();   /* set correct state immediately on load */
  setInterval(updateConnStatus, 4000); /* safety net — see comment above */

  document.getElementById('login-form').addEventListener('submit', handleLogin);
  document.getElementById('login-email').focus();
});
