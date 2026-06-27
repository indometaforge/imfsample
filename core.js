/* ═══════════════════════════════════════════════════════════════════
   IMF ProTrack — Shared Core JavaScript
   Load this file in every module page via:
   <script src="../core.js"></script>
   Firebase SDK scripts must be loaded BEFORE this file.
   ═══════════════════════════════════════════════════════════════════ */

'use strict';

/* ══════════════════════════════════════════════════════════════════════
   FIREBASE INIT
   ══════════════════════════════════════════════════════════════════════ */
firebase.initializeApp({
  apiKey:            "AIzaSyA3-RPrX4ysIwTHAn_nnbMGJSghv3RRcLs",
  authDomain:        "imf-pro-track.firebaseapp.com",
  projectId:         "imf-pro-track",
  storageBucket:     "imf-pro-track.firebasestorage.app",
  messagingSenderId: "288808983033",
  appId:             "1:288808983033:web:0c02884447ba6f25734528"
});

const db   = firebase.firestore();
const auth = firebase.auth();

/* Enable Firestore offline persistence (best-effort) */
db.enablePersistence({ synchronizeTabs: true }).catch(() => {});

/* ══════════════════════════════════════════════════════════════════════
   ENVIRONMENT
   ══════════════════════════════════════════════════════════════════════ */

/**
 * Set to false for production.
 * When true, all transactional writes go to TEST_ prefixed collections.
 * Master data (users, machines, parts, etc.) always reads from live collections.
 */
const TEST_MODE = false;

const TRANSACTIONAL_COLLECTIONS = new Set([
  'inward', 'iqcResults', 'requisitions', 'routeCards',
  'setupApprovals', 'setupDeviations', 'actuals', 'plans', 'prodDrafts', 'planDrafts',
  'htCharges', 'qcInspections', 'scrapLedger',
  'breakdowns', 'machineStatus', 'sparesRequests', 'pmLogs',
  'dispatches', 'pos', 'auditLogs', 'shotBlastSessions',
  'forgingProduction', 'supplierDispatches', 'scmScrapLedger', 'forgingPlans'
]);

/* Proxy db.collection so TEST_ prefix is applied transparently */
const _origCol = db.collection.bind(db);
db.collection = function (name) {
  if (TEST_MODE && TRANSACTIONAL_COLLECTIONS.has(name)) {
    return _origCol('TEST_' + name);
  }
  return _origCol(name);
};

/* ══════════════════════════════════════════════════════════════════════
   GLOBAL STATE — S
   Masters loaded once on login and shared across the session.
   Transactional data is loaded per-module, not stored globally.
   ══════════════════════════════════════════════════════════════════════ */
const S = {
  /* Auth */
  sess: null,          /* { userId, name, role, stage, email } */

  /* Masters (loaded once on login) */
  users:      [],
  machines:   [],
  parts:      [],
  operations: [],
  partOps:    [],      /* { partId, opId, seqNo, cycleTimeSecs, isMandatory, finalOperation, workCenterType } */
  customers:  [],
  suppliers:  [],
  fpnCpnMap:         [],   /* { fpn, fpnDescription, cpn, customerId, partId, active } */
  supplierWipOpening: [],  /* { supplierId, cpn, openingQty, setBy, setAt } */
  shifts:     {
    s1: { label: 'Shift 1', start: '06:30', end: '15:00' },
    s2: { label: 'Shift 2', start: '15:00', end: '23:30' },
    s3: { label: 'Shift 3', start: '23:30', end: '06:30' }
  },

  /* Active listeners (unsubscribe on logout) */
  listeners: [],
};

/* ══════════════════════════════════════════════════════════════════════
   UTILITIES
   ══════════════════════════════════════════════════════════════════════ */

/** Generate a short random client-side UID (for non-critical IDs only) */
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

/**
 * Server timestamp — use for ALL critical event timestamps.
 * Never use client Date for breakdown times, approval times, etc.
 */
const serverTS = () => firebase.firestore.FieldValue.serverTimestamp();

/* Renders a Date's LOCAL calendar date as yyyy-mm-dd. Never use
   .toISOString() for this — it always renders UTC, so building a local
   Date (e.g. "today", or "today" + setDate(+1)) and then reading it back
   through .toISOString() silently shifts the date in any timezone ahead
   of UTC. IST is UTC+5:30, so dateStr()/tomStr() were returning
   yesterday's/today's date for the whole 12:00-5:30am IST window. */
const _localDateStr = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** Current date string yyyy-mm-dd (local) */
const dateStr = () => _localDateStr(new Date());

/** Tomorrow date string yyyy-mm-dd */
const tomStr = () => {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return _localDateStr(d);
};

/** Format date string for display: "Mon, 14 Jun 2025" */
const fmtDate = (s) => {
  if (!s) return '—';
  try {
    return new Date(s + 'T00:00:00').toLocaleDateString('en-IN', {
      weekday: 'short', day: 'numeric', month: 'short', year: 'numeric'
    });
  } catch { return s; }
};

/** Format timestamp for display: "14 Jun · 15:42" */
const fmtTS = (ts) => {
  if (!ts) return '—';
  try {
    const d = ts.toDate ? ts.toDate() : new Date(ts);
    return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
      + ' · '
      + d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
  } catch { return '—'; }
};

/** Format INR currency */
const fmtINR = (n) => {
  if (n === null || n === undefined) return '—';
  return '₹' + Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 });
};

/** Greeting based on time */
const greet = () => {
  const h = new Date().getHours();
  return h < 12 ? 'morning' : h < 17 ? 'afternoon' : 'evening';
};

/** Stage display label */
const slbl = (s) => ({ soft: 'Soft', ht: 'HT', hard: 'Hard', general: 'General' }[s] || s || '—');

/** Stage badge class */
const sbdg = (s) => ({ soft: 'bdg-soft', ht: 'bdg-ht', hard: 'bdg-hard' }[s] || 'bdg-gr');

/** Role display label */
const rlbl = (r) => ({
  admin: 'Admin', supervisor: 'Supervisor', operator: 'Operator', hod: 'HOD'
}[r] || r || '—');

/** Initials from name */
const initials = (name) => (name || '').split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();

/** Clamp number between min and max */
const clamp = (n, min, max) => Math.min(Math.max(Number(n) || 0, min), max);

/** Round to N decimal places */
const round = (n, dp = 0) => Number(Math.round(n + 'e' + dp) + 'e-' + dp);

/* ══════════════════════════════════════════════════════════════════════
   SESSION MANAGEMENT
   ══════════════════════════════════════════════════════════════════════ */
const SESS_KEY = 'imf_sess';

const getSess = () => {
  try { return JSON.parse(sessionStorage.getItem(SESS_KEY)); }
  catch { return null; }
};

const setSess = (data) => {
  if (data) sessionStorage.setItem(SESS_KEY, JSON.stringify(data));
  else sessionStorage.removeItem(SESS_KEY);
};

const clearSess = () => sessionStorage.removeItem(SESS_KEY);

const isAdmin = () => S.sess?.role === 'admin';
const isTanmay = () => S.sess?.name === 'Tanmay Indani' || S.sess?.email === 'tanmay@indometaforge.in';

/* ══════════════════════════════════════════════════════════════════════
   PERMISSIONS
   ══════════════════════════════════════════════════════════════════════ */

/**
 * Permission model — roles are: operator, supervisor, hod, admin.
 * A user's department/stage (DEPT_STAGES in masters.js) determines which
 * module is their "home area"; their role determines how much access they
 * get to it (and to cross-cutting actions like reports/approvals).
 * Values: 'full' | 'view' | 'hidden'
 */
const STAGE_PERM_AREA = {
  soft: 'production', hard: 'production', general: 'production', ht: 'ht',
  store: 'inward', qc: 'qc', dispatch: 'dispatch', maintenance: 'maintenance',
  forging: 'scm',
};

const PERMS = {
  admin: {
    masters: 'full', inward: 'full', requisition_approve: 'full',
    production: 'full', ht: 'full', qc: 'full',
    maintenance: 'full', spares_approve: 'full',
    deviation_approve: 'full', dispatch: 'full', reports: 'full',
    breakdown_report: 'full',
    scm: 'full', scm_production: 'full', scm_dispatch: 'full', scm_admin: 'full', scrap_approve: 'full'
  }
};

/**
 * For stage:'forging' users, S.sess.scmFunction ('production' | 'dispatch' | 'both')
 * narrows which of scm_production / scm_dispatch they get — set on the user master doc.
 * Missing/'both' = unrestricted within the area, matching how other stages behave by default.
 */
const _scmFnMatches = (action) => {
  const fn = S.sess?.scmFunction;
  if (!fn || fn === 'both') return true;
  return action === `scm_${fn}`;
};

const getPerm = (action) => {
  const role  = S.sess?.role  || '';
  const stage = S.sess?.stage || 'general';

  if (role === 'admin') return PERMS.admin[action] || 'hidden';

  const area = STAGE_PERM_AREA[stage] || 'production';

  if (role === 'hod') {
    if (action === area) return 'full';
    if (area === 'scm' && (action === 'scm_production' || action === 'scm_dispatch')) return 'full';
    if (action === 'reports') return 'full';
    if (action === 'breakdown_report') return 'full';
    if (action === 'requisition_approve' && area === 'inward') return 'full';
    if (action === 'spares_approve' && area === 'maintenance') return 'full';
    if (action === 'deviation_approve' && area === 'qc') return 'full';
    if (action === 'scrap_approve' && area === 'scm') return 'full';
    if ((action === 'production' || action === 'ht') && (area === 'production' || area === 'ht')) return 'view';
    return 'hidden';
  }

  if (role === 'supervisor') {
    if (action === area) return 'full';
    if (area === 'scm' && (action === 'scm_production' || action === 'scm_dispatch')) {
      return _scmFnMatches(action) ? 'full' : 'hidden';
    }
    if (action === 'reports') return 'view';
    if (action === 'breakdown_report') return 'full';
    if ((action === 'production' || action === 'ht') && (area === 'production' || area === 'ht')) return 'view';
    return 'hidden';
  }

  if (role === 'operator') {
    if (action === area) return 'view';
    if (area === 'scm' && (action === 'scm_production' || action === 'scm_dispatch')) {
      return _scmFnMatches(action) ? 'view' : 'hidden';
    }
    return 'hidden';
  }

  return 'hidden';
};

const canDo = (action) => getPerm(action) === 'full';
const canView = (action) => getPerm(action) !== 'hidden';

/* ══════════════════════════════════════════════════════════════════════
   MASTER DATA LOADING
   Loads only true static master collections. Called once on login.
   ══════════════════════════════════════════════════════════════════════ */
async function loadMasters() {
  const [
    usersSnap, machinesSnap, partsSnap, opsSnap, partOpsSnap,
    custsSnap, suppsSnap, shiftDoc, fpnCpnSnap, wipOpenSnap
  ] = await Promise.all([
    db.collection('users').get(),
    db.collection('machines').get(),
    db.collection('parts').get(),
    db.collection('operations').get(),
    db.collection('partOps').get(),
    db.collection('customers').get(),
    db.collection('suppliers').get(),
    db.collection('config').doc('shifts').get(),
    db.collection('fpnCpnMap').get(),
    db.collection('supplierWipOpening').get()
  ]);

  S.users       = usersSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  S.machines    = machinesSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  S.parts       = partsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  S.operations  = opsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  S.partOps     = partOpsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  S.customers   = custsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  S.suppliers   = suppsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  S.fpnCpnMap         = fpnCpnSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  S.supplierWipOpening = wipOpenSnap.docs.map(d => ({ id: d.id, ...d.data() }));

  if (shiftDoc.exists) S.shifts = shiftDoc.data();
}

/** Reload only masters that change rarely but may be updated by admin */
async function reloadMasters() {
  return loadMasters();
}

/* ══════════════════════════════════════════════════════════════════════
   REAL-TIME LISTENERS
   Each module calls setupModuleListeners(). Core only sets up
   cross-cutting listeners needed by all modules.
   ══════════════════════════════════════════════════════════════════════ */

/** Add a listener's unsubscribe function to S.listeners for cleanup */
function addListener(unsub) {
  S.listeners.push(unsub);
}

/** Tear down all active listeners (called on logout) */
function clearListeners() {
  S.listeners.forEach(u => u());
  S.listeners = [];
}

/* ══════════════════════════════════════════════════════════════════════
   AUDIT LOG
   Every significant action must call logAudit().
   ══════════════════════════════════════════════════════════════════════ */
async function logAudit(actionType, module, recordId, beforeVal = null, afterVal = null) {
  try {
    await db.collection('auditLogs').add({
      userId:      S.sess?.userId || 'unknown',
      userName:    S.sess?.name   || 'unknown',
      userRole:    S.sess?.role   || 'unknown',
      actionType,
      module,
      recordId:    String(recordId),
      beforeValue: beforeVal,
      afterValue:  afterVal,
      createdAt:   serverTS()
    });
  } catch (e) {
    console.warn('Audit log failed:', e.message);
    /* Non-fatal — don't block the main action */
  }
}

/* ══════════════════════════════════════════════════════════════════════
   TEST DATA — wipes every TEST_-prefixed collection (TEST_MODE only).
   Iterates TRANSACTIONAL_COLLECTIONS directly (the same set that drives
   the TEST_ prefix routing above) instead of a separately maintained
   list, so a newly added transactional collection is covered automatically.
   ══════════════════════════════════════════════════════════════════════ */
async function clearTestData() {
  if (!TEST_MODE) { toast('Not in test mode'); return; }
  if (!confirm('Delete ALL test data?\n\nTEST_ collections will be wiped. Masters are NOT affected.')) return;

  const btn = document.getElementById('clear-test-data-btn');
  if (btn) { btn.disabled = true; btn.innerHTML = 'Clearing...'; }

  // Offline persistence (enablePersistence in this file) can otherwise serve
  // a stale cached snapshot right after a batch delete, so the `while
  // (!snap.empty)` loop below never converges. { source: 'server' } forces
  // a real read every time. MAX_ROUNDS is a hard backstop so a future bug
  // here can never freeze the button forever again instead of erroring out.
  const MAX_ROUNDS = 100; // up to 20,000 docs per collection
  let total = 0;
  const failures = [];

  for (const col of TRANSACTIONAL_COLLECTIONS) {
    try {
      let rounds = 0;
      let snap = await db.collection(col).limit(200).get({ source: 'server' });
      while (!snap.empty) {
        const batch = db.batch();
        snap.docs.forEach(d => batch.delete(db.collection(col).doc(d.id)));
        await batch.commit();
        total += snap.docs.length;
        rounds++;
        if (rounds >= MAX_ROUNDS) {
          failures.push(`${col} (stopped after ${MAX_ROUNDS * 200} docs — run again)`);
          break;
        }
        snap = await db.collection(col).limit(200).get({ source: 'server' });
      }
    } catch (e) {
      console.warn(`clearTestData: failed on ${col}:`, e.message);
      failures.push(`${col} (${friendlyError(e)})`);
    }
  }

  try {
    await logAudit('CLEAR_TEST_DATA', 'SYSTEM', 'all', null, { collectionsCleared: TRANSACTIONAL_COLLECTIONS.size, recordsDeleted: total, failures });
  } catch (e) { console.warn('clearTestData: audit log failed:', e.message); }

  if (failures.length) {
    toast(`Cleared ${total} record(s), but ${failures.length} collection(s) failed: ${failures.join(', ')}`, 8000);
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="ti ti-trash" aria-hidden="true"></i> Clear All Test Data'; }
  } else {
    toast(`Cleared ${total} test record${total === 1 ? '' : 's'}`);
    setTimeout(() => location.reload(), 800);
  }
}

/* ══════════════════════════════════════════════════════════════════════
   FRIENDLY ERRORS — map raw Firestore/network errors to plain language
   so a flaky shop-floor connection never surfaces a raw error code.
   ══════════════════════════════════════════════════════════════════════ */
function friendlyError(e) {
  const code = e?.code || '';
  if (!navigator.onLine || code === 'unavailable' || /network/i.test(e?.message || '')) {
    return 'No connection — check your network and try again.';
  }
  if (code === 'permission-denied') {
    return "You don't have permission to do that. Contact your administrator.";
  }
  if (code === 'not-found') {
    return 'That record no longer exists — refresh and try again.';
  }
  if (code === 'deadline-exceeded' || code === 'cancelled') {
    return 'That took too long — check your connection and try again.';
  }
  return 'Something went wrong saving this. Try again, and contact your administrator if it keeps happening.';
}

/* ══════════════════════════════════════════════════════════════════════
   TOAST
   ══════════════════════════════════════════════════════════════════════ */
let _toastTimer = null;
function toast(msg, duration = 2800) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('on');
  if (_toastTimer) clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.classList.remove('on'), duration);
}

/* ══════════════════════════════════════════════════════════════════════
   MODAL
   ══════════════════════════════════════════════════════════════════════ */
let _modalLastFocus = null;
function openModal(html) {
  const cont = document.getElementById('modal-content');
  const mov  = document.getElementById('modal-overlay');
  if (!cont || !mov) return;
  cont.innerHTML = '<div class="modal-handle"></div>' + html;
  cont.setAttribute('role', 'dialog');
  cont.setAttribute('aria-modal', 'true');
  cont.setAttribute('tabindex', '-1');
  mov.classList.add('open');
  document.body.style.overflow = 'hidden';
  _modalLastFocus = document.activeElement;
  const focusable = cont.querySelector('input, select, textarea, button, [href], [tabindex]:not([tabindex="-1"])');
  (focusable || cont).focus({ preventScroll: true });
}

function closeModal() {
  const mov = document.getElementById('modal-overlay');
  const cont = document.getElementById('modal-content');
  if (cont) cont.classList.remove('modal-wide');
  if (!mov) return;
  mov.classList.remove('open');
  document.body.style.overflow = '';
  if (_modalLastFocus && typeof _modalLastFocus.focus === 'function') _modalLastFocus.focus();
  _modalLastFocus = null;
}

/* Keyboard activation for role="button" custom interactive rows (Enter/Space) */
function onRowKey(e, fn) {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fn(); }
}

/* ══════════════════════════════════════════════════════════════════════
   OFFLINE DETECTION
   ══════════════════════════════════════════════════════════════════════ */
function initOfflineDetection() {
  const bar = document.getElementById('offline-bar');
  if (!bar) return;
  const update = () => {
    bar.classList.toggle('on', !navigator.onLine);
  };
  window.addEventListener('online',  update);
  window.addEventListener('offline', update);
  update();
  // navigator.onLine + the online/offline events are unreliable on mobile —
  // a WiFi↔cellular handoff often never fires the event, which can leave this
  // banner stuck. Poll as a safety net so it always reflects the real state.
  setInterval(update, 4000);
}

/* ══════════════════════════════════════════════════════════════════════
   TOPBAR USER MENU
   The old fixed sidebar was replaced with a compact user pill in the
   topbar that only exposes sign-out; module navigation moved to the
   hamburger dropdown (see TOPBAR MODULE MENU below NAV_ITEMS).
   ══════════════════════════════════════════════════════════════════════ */
function buildTopbarUserMenu() {
  const name      = S.sess?.name || 'User';
  const roleLabel = rlbl(S.sess?.role || '');
  return `
    <div class="topbar-user" id="topbar-user">
      <button class="topbar-user-btn" id="topbar-user-btn" onclick="toggleUserMenu(event)" aria-haspopup="true" aria-expanded="false">
        <span class="topbar-user-av">${initials(name)}</span>
        <span class="topbar-user-name">${name}</span>
        <i class="ti ti-chevron-down" aria-hidden="true"></i>
      </button>
      <div class="topbar-user-menu" id="topbar-user-menu">
        <div class="topbar-user-menu-role">${roleLabel}</div>
        <button class="topbar-user-menu-item" onclick="logout()">
          <i class="ti ti-logout" aria-hidden="true"></i> Sign Out
        </button>
      </div>
    </div>`;
}

function toggleUserMenu(e) {
  e?.stopPropagation();
  const menu = document.getElementById('topbar-user-menu');
  const btn  = document.getElementById('topbar-user-btn');
  if (!menu || !btn) return;
  const isOpen = menu.classList.toggle('on');
  btn.setAttribute('aria-expanded', String(isOpen));
}

/* Close the user/module menus on any outside click — wired once per page load */
document.addEventListener('click', (e) => {
  const userWrap = document.getElementById('topbar-user');
  if (userWrap && !userWrap.contains(e.target)) {
    document.getElementById('topbar-user-menu')?.classList.remove('on');
    document.getElementById('topbar-user-btn')?.setAttribute('aria-expanded', 'false');
  }
  const brandWrap = document.getElementById('topbar-brand');
  if (brandWrap && !brandWrap.contains(e.target)) {
    document.getElementById('topbar-module-menu')?.classList.remove('on');
    document.getElementById('topbar-menu-btn')?.setAttribute('aria-expanded', 'false');
  }
});

/* ══════════════════════════════════════════════════════════════════════
   NAV ITEMS — single source of truth for the topbar module menu order AND
   the landingPage() fallback chain below.
   ══════════════════════════════════════════════════════════════════════ */
const NAV_ITEMS = [
  { page: 'home',        icon: 'ti-home',               label: 'Home' },
  { page: 'store',       icon: 'ti-building-warehouse',  label: 'Store / Inward',   perm: 'inward' },
  { page: 'production',  icon: 'ti-settings',            label: 'Production',       perm: 'production' },
  { page: 'ht',          icon: 'ti-flame',               label: 'Heat Treatment',   perm: 'production' },
  { page: 'qc',          icon: 'ti-clipboard-check',     label: 'Quality Control',  perm: 'qc' },
  { page: 'maintenance', icon: 'ti-tool',                label: 'Maintenance',      perm: 'maintenance' },
  { page: 'dispatch',    icon: 'ti-truck',               label: 'Dispatch',         perm: 'dispatch' },
  { page: 'scm',         icon: 'ti-truck-delivery',      label: 'Supply Chain',     perm: 'scm' },
];

const NAV_MGMT_ITEMS = [
  { page: 'approvals',   icon: 'ti-checks',              label: 'Approvals',        perm: ['production', 'scrap_approve'] },
  { page: 'reports',     icon: 'ti-chart-bar',           label: 'Reports',          perm: 'reports' },
  { page: 'masters',     icon: 'ti-database',            label: 'Masters',          perm: 'masters' },
];

/* Stage → home-area module, used by landingPage() to send a logged-in
   non-admin straight to their own department instead of the dashboard. */
const STAGE_LANDING_MODULE = {
  store:       { page: 'store.html',       perm: 'inward' },
  soft:        { page: 'production.html',  perm: 'production' },
  hard:        { page: 'production.html',  perm: 'production' },
  ht:          { page: 'ht.html',          perm: 'production' },
  qc:          { page: 'qc.html',          perm: 'qc' },
  dispatch:    { page: 'dispatch.html',    perm: 'dispatch' },
  maintenance: { page: 'maintenance.html', perm: 'maintenance' },
  forging:     { page: 'scm.html',         perm: 'scm' },
};

/**
 * Resolve the page a given session should land on post-login.
 * admin            → home.html (the only role allowed to view it)
 * stage mapped      → that stage's module, if permitted
 * stage unmapped/   → first module in nav order the user can view
 *   not permitted
 * nothing permitted → home.html (last resort; never dead-ends or loops —
 *                      home.js only redirects a non-admin away from home.html
 *                      when landingPage() resolves to something other than it)
 */
function landingPage(sess) {
  if (!sess) return 'index.html';
  if (sess.role === 'admin') return 'home.html';

  const staged = STAGE_LANDING_MODULE[sess.stage];
  if (staged && canView(staged.perm)) return staged.page;

  const fallback = [...NAV_ITEMS, ...NAV_MGMT_ITEMS].find(item => {
    const perms = Array.isArray(item.perm) ? item.perm : (item.perm ? [item.perm] : []);
    return perms.some(canView);
  });
  return fallback ? fallback.page + '.html' : 'home.html';
}

/* ══════════════════════════════════════════════════════════════════════
   TOPBAR MODULE MENU
   Hamburger dropdown next to the logo — replaces the old fixed sidebar
   for cross-module navigation while keeping the page full-width.
   ══════════════════════════════════════════════════════════════════════ */
function buildModuleMenu() {
  const curPage = location.pathname.split('/').pop().replace('.html', '');

  const buildItem = (item) => {
    if (item.page === 'home' && S.sess?.role !== 'admin') return '';
    const perms = Array.isArray(item.perm) ? item.perm : (item.perm ? [item.perm] : []);
    if (perms.length && !perms.some(canView)) return '';
    const active = item.page === curPage ? 'active' : '';
    return `
      <a href="${item.page}.html" class="tmm-item ${active}">
        <i class="ti ${item.icon}" aria-hidden="true"></i><span>${item.label}</span>
      </a>`;
  };

  const modules = NAV_ITEMS.map(buildItem).join('');
  const mgmt    = NAV_MGMT_ITEMS.map(buildItem).join('');

  return `
    <div class="tmm-section-label">Modules</div>
    ${modules}
    ${mgmt ? `<div class="tmm-section-label">Management</div>${mgmt}` : ''}`;
}

function toggleModuleMenu(e) {
  e?.stopPropagation();
  const menu = document.getElementById('topbar-module-menu');
  const btn  = document.getElementById('topbar-menu-btn');
  if (!menu || !btn) return;
  const isOpen = menu.classList.toggle('on');
  btn.setAttribute('aria-expanded', String(isOpen));
  /* Close the user menu so only one dropdown is open at a time */
  document.getElementById('topbar-user-menu')?.classList.remove('on');
  document.getElementById('topbar-user-btn')?.setAttribute('aria-expanded', 'false');
}

/* ══════════════════════════════════════════════════════════════════════
   APP SHELL RENDERER
   Call initShell() in every page's DOMContentLoaded.
   ══════════════════════════════════════════════════════════════════════ */
async function initShell() {
  /* Guard: redirect to login if no session */
  S.sess = getSess();
  if (!S.sess) {
    window.location.replace('index.html');
    return;
  }

  /* Render topbar user pill (sign-out) */
  const actionsEl = document.querySelector('.topbar-actions');
  if (actionsEl && !document.getElementById('topbar-user')) {
    actionsEl.insertAdjacentHTML('beforeend', buildTopbarUserMenu());
  }

  /* Render topbar module menu (hamburger dropdown) */
  const moduleMenuEl = document.getElementById('topbar-module-menu');
  if (moduleMenuEl) moduleMenuEl.innerHTML = buildModuleMenu();

  /* TEST MODE banner — visual reminder that transactional writes are
     redirected to TEST_ collections, not live data (mirrors i-v3.html).
     The clear-data button is driven by TRANSACTIONAL_COLLECTIONS itself
     (not a separate hardcoded list, unlike i-v3.html's clearTestData())
     so it can never drift out of sync when a new collection is added. */
  if (TEST_MODE) {
    const mainEl = document.querySelector('#app .main');
    if (mainEl && !document.getElementById('test-mode-bar')) {
      mainEl.insertAdjacentHTML('afterbegin',
        `<div id="test-mode-bar" style="background:var(--warn);color:#fff;text-align:center;font-size:12px;font-weight:700;padding:6px 10px;letter-spacing:.04em">
          <i class="ti ti-flask" aria-hidden="true"></i> TEST MODE — writes go to TEST_ collections, not live data
          <button id="clear-test-data-btn" onclick="clearTestData()" style="margin-left:10px;background:rgba(0,0,0,.25);border:none;color:#fff;padding:3px 10px;border-radius:4px;font-size:11px;font-weight:700;cursor:pointer">
            <i class="ti ti-trash" aria-hidden="true"></i> Clear All Test Data
          </button>
        </div>`);
    }
  }

  /* Offline banner */
  initOfflineDetection();

  /* Load masters */
  await loadMasters();
}

/* ══════════════════════════════════════════════════════════════════════
   AUTH
   ══════════════════════════════════════════════════════════════════════ */
async function login(email, password) {
  const cred = await auth.signInWithEmailAndPassword(email, password);
  const uid  = cred.user.uid;

  /* Fetch user profile from Firestore */
  const userDoc = await db.collection('users').doc(uid).get();
  if (!userDoc.exists) {
    await auth.signOut();
    throw new Error('User account not found. Contact your administrator.');
  }

  const userData = userDoc.data();
  if (userData.isActive === false) {
    await auth.signOut();
    throw new Error('Your account has been deactivated. Contact your administrator.');
  }

  const sess = {
    userId: uid,
    name:   userData.name || cred.user.displayName || email,
    role:   userData.role || 'operator',
    stage:  userData.stage || 'general',
    scmFunction: userData.scmFunction || null,
    email:  cred.user.email
  };

  setSess(sess);
  S.sess = sess;

  await logAudit('LOGIN', 'AUTH', uid);

  return sess;
}

async function logout() {
  if (S.sess) await logAudit('LOGOUT', 'AUTH', S.sess.userId).catch(() => {});
  clearListeners();
  clearSess();
  S.sess = null;
  await auth.signOut().catch(() => {});
  window.location.replace('index.html');
}

/* ══════════════════════════════════════════════════════════════════════
   QR CODE SCANNER
   Shared scanner using html5-qrcode library.
   ══════════════════════════════════════════════════════════════════════ */
let _qrInstance = null;

/**
 * Open QR scanner modal.
 * @param {Function} onResult - called with decoded string on success
 * @param {string} title - modal title
 */
function openQrScanner(onResult, title = 'Scan Route Card') {
  openModal(`
    <div class="modal-title">
      <i class="ti ti-qrcode" aria-hidden="true"></i> ${title}
    </div>
    <div id="qr-reader" style="width:100%;border-radius:var(--rs);overflow:hidden;margin-bottom:12px"></div>
    <div style="text-align:center;font-size:13px;color:var(--txt-muted);margin-bottom:12px">
      Point camera at the QR code on the Route Card
    </div>
    <div class="f">
      <label class="f-lbl">Or type TAG number manually</label>
      <input type="text" id="qr-manual-input" placeholder="e.g. TAG-042"
        style="text-transform:uppercase;font-size:16px;letter-spacing:0.05em"
        oninput="this.value=this.value.toUpperCase()"
        onkeydown="if(event.key==='Enter'){event.preventDefault();_qrManualSubmit()}">
    </div>
    <div style="display:flex;gap:8px;margin-top:4px">
      <button class="btn btn-p" style="flex:1" onclick="_qrManualSubmit()">
        <i class="ti ti-check" aria-hidden="true"></i> Use this TAG
      </button>
      <button class="btn btn-s" onclick="closeQrScanner()">Cancel</button>
    </div>
  `);

  /* Store callback */
  window._qrCallback = onResult;

  /* Start camera */
  setTimeout(() => {
    const manualInput = document.getElementById('qr-manual-input');
    if (manualInput) manualInput.focus();

    try {
      _qrInstance = new Html5Qrcode('qr-reader');
      _qrInstance.start(
        { facingMode: 'environment' },
        { fps: 10, qrbox: { width: 260, height: 130 }, aspectRatio: 2 },
        (decoded) => {
          closeQrScanner();
          if (window._qrCallback) window._qrCallback(decoded.trim().toUpperCase());
        },
        () => {} /* ignore scan errors */
      ).catch(() => {}); /* ignore start errors (e.g. no camera) */
    } catch (e) {
      console.warn('QR scanner init failed:', e.message);
    }
  }, 250);
}

function _qrManualSubmit() {
  const val = (document.getElementById('qr-manual-input')?.value || '').trim().toUpperCase();
  if (!val) { toast('Type a TAG number first'); return; }
  closeQrScanner();
  if (window._qrCallback) window._qrCallback(val);
}

function closeQrScanner() {
  if (_qrInstance) {
    const instance = _qrInstance;
    _qrInstance = null;
    try {
      /* Html5Qrcode.stop() can throw SYNCHRONOUSLY (e.g. "Cannot stop, scanner is
         not running or paused") instead of rejecting, when the camera never
         actually started (no camera, permission denied, etc). Without this
         try/catch that throw aborts the function before closeModal() below ever
         runs, leaving the modal stuck open with seemingly-dead buttons. */
      Promise.resolve(instance.stop())
        .catch(() => {})
        .finally(() => { try { instance.clear(); } catch (e) {} });
    } catch (e) { /* scanner was never running — nothing to stop/clear */ }
  }
  closeModal();
}

/* ── KEYBOARD WEDGE SCANNER LISTENER (e.g. iball BST300BT) ── */
let _globalBarcodeBuffer = '';
let _globalBarcodeLastKeyTime = 0;

window.addEventListener('keydown', (e) => {
  const activeEl = document.activeElement;
  const isInput = activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA' || activeEl.tagName === 'SELECT');
  
  const now = Date.now();
  const timeDiff = now - _globalBarcodeLastKeyTime;
  _globalBarcodeLastKeyTime = now;
  
  const isFast = timeDiff < 50;
  
  if (e.key === 'Enter') {
    const code = _globalBarcodeBuffer.trim().toUpperCase();
    if (code.startsWith('TAG') && code.length > 3) {
      e.preventDefault();
      _globalBarcodeBuffer = '';
      
      if (typeof window.onGlobalScan === 'function') {
        window.onGlobalScan(code);
      } else {
        const modalInput = document.getElementById('qr-manual-input');
        if (modalInput) {
          modalInput.value = code;
          _qrManualSubmit();
        } else {
          toast(`Scanned: ${code} (No active scan destination on this screen)`);
        }
      }
    } else {
      _globalBarcodeBuffer = '';
    }
  } else if (e.key.length === 1) {
    if (!isInput || isFast) {
      if (!isFast && _globalBarcodeBuffer.length > 0) {
        _globalBarcodeBuffer = '';
      }
      _globalBarcodeBuffer += e.key;
    } else {
      _globalBarcodeBuffer = '';
    }
  } else {
    _globalBarcodeBuffer = '';
  }
});


/* ══════════════════════════════════════════════════════════════════════
   OEE CALCULATION ENGINE
   ══════════════════════════════════════════════════════════════════════ */

/**
 * Calculate production metrics for a machine run.
 * @param {number} cycleTimeSecs - seconds per piece
 * @param {number} setupMins     - total setup minutes this shift
 * @param {number} downtimeMins  - total downtime minutes this shift
 * @param {number} actualQty     - actual pieces produced
 * @param {number} shiftMins     - shift duration in minutes (default 450)
 * @returns {{ targetQty, availableTimeOEE, maxCapacity, availableMins }}
 */
function calcOEE(cycleTimeSecs, setupMins, downtimeMins, actualQty, shiftMins = 450) {
  const cycleTimeMins = (cycleTimeSecs || 0) / 60;
  const availableMins = Math.max(0, shiftMins - (setupMins || 0) - (downtimeMins || 0));

  const targetQty = cycleTimeMins > 0
    ? Math.floor(availableMins / cycleTimeMins)
    : 0;

  const availableTimeOEE = (cycleTimeMins > 0 && availableMins > 0)
    ? round((actualQty * cycleTimeMins / availableMins) * 100, 1)
    : 0;

  /* This is Theoretical Max Output — NOT OEE. Do NOT call it OEE. */
  const maxCapacity = cycleTimeMins > 0
    ? Math.floor(shiftMins / cycleTimeMins)
    : 0;

  return { targetQty, availableTimeOEE, maxCapacity, availableMins };
}

/* ══════════════════════════════════════════════════════════════════════
   ROUTE CARD HELPERS
   ══════════════════════════════════════════════════════════════════════ */

/**
 * Fetch a Route Card by UID from Firestore.
 * Returns null if not found.
 */
async function fetchRouteCard(tagId) {
  const doc = await db.collection('routeCards').doc(tagId).get();
  if (!doc.exists) return null;
  return { id: doc.id, ...doc.data() };
}

/**
 * Validate a Route Card for a given stage.
 * Returns { ok: true } or { ok: false, error: string }
 */
function validateCardForStage(card, stage) {
  if (!card) return { ok: false, error: 'Route Card not found. Issue it from Store first.' };

  const validStages = {
    soft: ['store_issued', 'soft_wip'],
    hard: ['ht_done', 'hard_wip'],
    ht:   ['soft_done', 'ht_queue']
  };

  if (!(validStages[stage] || []).includes(card.status)) {
    return {
      ok: false,
      error: `${card.id} status is "${card.status}" — not valid for ${slbl(stage)} stage.`
    };
  }

  if (stage === 'hard' && !card.heatCode) {
    return { ok: false, error: `${card.id} has no Heat Code — must go through Heat Treatment first.` };
  }

  return { ok: true };
}

/**
 * Check operation sequence for a Route Card.
 * Returns { ok: true, nextOp } or { ok: false, missingOp, error }
 */
function checkSequence(card, intendedOpId) {
  const partOps = S.partOps
    .filter(po => po.partId === card.partId)
    .sort((a, b) => (a.seqNo || 0) - (b.seqNo || 0));

  if (!partOps.length) return { ok: true }; /* no routing defined — allow */

  const intendedPO = partOps.find(po => po.opId === intendedOpId);
  if (!intendedPO) return { ok: true }; /* op not in routing — allow */

  const history = (card.opHistory || []).map(h => h.opId);

  /* Find all mandatory ops that should have been done before this one */
  const preceding = partOps.filter(po =>
    po.isMandatory &&
    (po.seqNo || 0) < (intendedPO.seqNo || 0) &&
    !history.includes(po.opId)
  );

  if (preceding.length > 0) {
    const missingOp = S.operations.find(o => o.id === preceding[0].opId);
    return {
      ok: false,
      missingOp: missingOp?.name || preceding[0].opId,
      error: `Sequence violation: "${missingOp?.name || 'Previous operation'}" was not logged for this batch.`
    };
  }

  return { ok: true };
}

/* ══════════════════════════════════════════════════════════════════════
   DROPDOWN HELPERS
   ══════════════════════════════════════════════════════════════════════ */

/** Build <option> elements from an array */
const buildOpts = (arr, valKey, labelFn, selectedVal = '') =>
  arr.map(item =>
    `<option value="${item[valKey]}" ${item[valKey] === selectedVal ? 'selected' : ''}>
       ${labelFn(item)}
     </option>`
  ).join('');

/** Resolve a part's raw-material part id. Falls back to the part itself when
   the field is absent (grandfathers legacy parts) or the part isn't found. */
const rawMaterialOf = (partId) => {
  const p = (S.parts || []).find(x => x.id === partId);
  return (p && p.rawMaterialPartId) || partId;
};

/** Part search — returns filtered parts matching query */
const searchParts = (query) => {
  const q = query.toLowerCase().trim();
  if (!q) return [];
  return S.parts.filter(p =>
    (p.no || '').toLowerCase().includes(q) ||
    (p.name || '').toLowerCase().includes(q) ||
    (p.cust || '').toLowerCase().includes(q)
  ).slice(0, 15);
};

/* ══════════════════════════════════════════════════════════════════════
   GLOBAL DROPDOWN (searchable part picker)
   ══════════════════════════════════════════════════════════════════════ */
let _gdropTarget = null;
let _gdropCb = null;

function showPartDrop(inputEl, onSelect) {
  _gdropTarget = inputEl;
  _gdropCb = onSelect;
  const q = inputEl.value;
  const results = searchParts(q);
  const drop = document.getElementById('gdrop');
  if (!drop) return;
  if (!results.length) { drop.style.display = 'none'; return; }

  const rect = inputEl.getBoundingClientRect();
  drop.style.display = 'block';
  drop.style.top    = (rect.bottom + window.scrollY + 4) + 'px';
  drop.style.left   = (rect.left + window.scrollX) + 'px';
  drop.style.width  = rect.width + 'px';
  drop.innerHTML = results.map((p, i) => `
    <div class="gdrop-item" onclick="_gdropSelect('${p.id}')" style="${i===0?'background:var(--imf-navy-hover)':''}">
      <div style="font-size:13px;font-weight:700;color:var(--txt)">${p.name}</div>
      <div style="font-size:11px;color:var(--txt-muted);margin-top:1px">
        <span style="font-family:monospace">${p.no}</span>${p.cust ? ' · ' + p.cust : ''}
      </div>
    </div>`).join('');
}

function _gdropSelect(partId) {
  const p = S.parts.find(x => x.id === partId);
  const cb = _gdropCb;
  if (p && _gdropTarget) _gdropTarget.value = p.name;
  hidePartDrop();
  if (cb && p) cb(p);
}

function hidePartDrop() {
  const drop = document.getElementById('gdrop');
  if (drop) drop.style.display = 'none';
  _gdropTarget = null;
  _gdropCb = null;
}

/* ══════════════════════════════════════════════════════════════════════
   FORM HELPERS
   ══════════════════════════════════════════════════════════════════════ */

/** Read all form field values into an object */
function readForm(formId) {
  const form = document.getElementById(formId);
  if (!form) return {};
  const data = {};
  form.querySelectorAll('[name]').forEach(el => {
    if (el.type === 'checkbox') data[el.name] = el.checked;
    else data[el.name] = el.value;
  });
  return data;
}

/** Set field value */
const setField = (id, val) => {
  const el = document.getElementById(id);
  if (el) el.value = val ?? '';
};

/** Get field value */
const getField = (id) => document.getElementById(id)?.value?.trim() || '';

/* ══════════════════════════════════════════════════════════════════════
   ACTIVE SHIFT HELPER
   ══════════════════════════════════════════════════════════════════════ */
function getActiveShift() {
  const now  = new Date();
  const toM  = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
  const cur  = now.getHours() * 60 + now.getMinutes();

  for (const [key, sh] of Object.entries(S.shifts)) {
    const s = toM(sh.start), e = toM(sh.end);
    const inShift = s < e ? (cur >= s && cur < e) : (cur >= s || cur < e);
    if (inShift) return { key, ...sh };
  }
  return { key: 's1', ...Object.values(S.shifts)[0] };
}

/* ══════════════════════════════════════════════════════════════════════
   EXCEL EXPORT
   Shared branded report builder used by every module's "Export" button
   (Store: WIP/Route Cards, Inward, Issue, Stock — see store.js).
   Requires ExcelJS to be loaded on the page (CDN script tag).
   ══════════════════════════════════════════════════════════════════════ */
/* logo_light_transparent.png, base64-embedded — fetch('logo_light_transparent.png')
   silently fails under the file:// protocol this app runs on (no dev server),
   so every export was shipping with zero logo and no error. Embedding the
   bytes directly removes that failure mode entirely. Native size 1038x459
   (~2.26:1) — keep that ratio wherever it's placed or it comes out squashed. */
const IMF_LOGO_BASE64 = "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";

let _imfLogoBuf = null;
function _getLogoBuffer() {
  if (_imfLogoBuf) return _imfLogoBuf;
  try {
    const bin = atob(IMF_LOGO_BASE64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    _imfLogoBuf = bytes.buffer;
  } catch (e) {
    console.warn('Logo decode failed, exporting without it:', e);
    _imfLogoBuf = null;
  }
  return _imfLogoBuf;
}

/**
 * Build and download a branded .xlsx report.
 * @param {Object} opts
 * @param {string}   opts.filename     e.g. "IMF_Inward_Report_2026-06-24.xlsx"
 * @param {string}   opts.reportTitle  e.g. "Inward Receipts Report"
 * @param {string}   [opts.filterSummary] e.g. "Supplier: All · Date: 01 Jun – 24 Jun 2026"
 * @param {Array}    opts.columns      [{ header, key, width, numFmt, align }]
 * @param {Array}    opts.rows         plain objects keyed by column.key
 * @param {Object}   [opts.totals]     map of column.key -> number, rendered as a bold totals row
 */
async function exportToExcel(opts) {
  const { filename, reportTitle, filterSummary = '', columns, rows, totals = null } = opts;

  if (typeof ExcelJS === 'undefined') {
    toast('Export library failed to load. Check your connection and retry.', 4000);
    return;
  }

  const NAVY  = 'FF1E2B6B';
  const VIOLET = 'FF7C3AED';
  const LIGHT_VIOLET = 'FFF5F3FF';
  const HAIRLINE = 'FFEDEFF4';
  const ZEBRA = 'FFFAFAFD';
  const lastCol = columns.length;

  const wb = new ExcelJS.Workbook();
  wb.creator = 'IMF ProTrack';
  wb.created = new Date();
  const ws = wb.addWorksheet('Report', { properties: { defaultRowHeight: 18 } });

  /* ── Header band (row 1): logo only — it already carries the company
     name, so no text duplicates it. Single navy row, just a system
     subtitle on the right to identify which app generated the file. ── */
  for (let c = 1; c <= lastCol; c++) ws.getCell(1, c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } };
  ws.getRow(1).height = 38;

  const textStartCol = Math.min(3, lastCol) + 1;
  if (textStartCol <= lastCol) {
    ws.mergeCells(1, textStartCol, 1, lastCol);
    const subCell = ws.getCell(1, textStartCol);
    subCell.value = 'IMF ProTrack — Manufacturing Execution System';
    subCell.font = { name: 'Calibri', size: 10, italic: true, color: { argb: 'FFC9CFE8' } };
    subCell.alignment = { vertical: 'middle', horizontal: 'right' };
  }

  const logoBuf = _getLogoBuffer();
  if (logoBuf) {
    const imageId = wb.addImage({ buffer: logoBuf, extension: 'png' });
    /* Native logo is 1038x459 (~2.26:1) — width/height below keep that
       ratio so it never looks squashed, vertically centred in row 1. */
    ws.addImage(imageId, { tl: { col: 0.15, row: 0.12 }, ext: { width: 108, height: 48 } });
  }

  /* ── Title card (rows 3-4): report title + generated-at, with a light
     violet background so it reads as a distinct info block rather than
     floating text — addresses the "lacks clarity" feedback directly. ── */
  for (let c = 1; c <= lastCol; c++) {
    ws.getCell(3, c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: LIGHT_VIOLET } };
    ws.getCell(4, c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: LIGHT_VIOLET } };
  }
  ws.getRow(3).height = 24; ws.getRow(4).height = 18;

  const titleCell = ws.getCell(3, 1);
  titleCell.value = reportTitle;
  titleCell.font = { name: 'Calibri', size: 14, bold: true, color: { argb: NAVY } };
  titleCell.alignment = { vertical: 'middle' };
  const genCell = ws.getCell(3, lastCol);
  genCell.value = `Generated: ${fmtDate(dateStr())} ${new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}`;
  genCell.font = { name: 'Calibri', size: 9, color: { argb: 'FF64748B' } };
  genCell.alignment = { vertical: 'middle', horizontal: 'right' };

  if (filterSummary) {
    ws.mergeCells(4, 1, 4, lastCol);
    const filtCell = ws.getCell(4, 1);
    filtCell.value = filterSummary;
    filtCell.font = { name: 'Calibri', size: 9, italic: true, color: { argb: 'FF5B6478' } };
    filtCell.alignment = { vertical: 'middle' };
  }

  /* ── Column header row ─────────────────────────────────────────────── */
  const HEADER_ROW = 6;
  columns.forEach((col, i) => {
    const cell = ws.getCell(HEADER_ROW, i + 1);
    cell.value = col.header;
    cell.font = { name: 'Calibri', size: 10, bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: VIOLET } };
    cell.alignment = { vertical: 'middle', horizontal: col.align === 'right' ? 'right' : 'left' };
    cell.border = {
      bottom: { style: 'thin', color: { argb: HAIRLINE } },
      right:  { style: 'thin', color: { argb: 'FF9968E8' } },
    };
    ws.getColumn(i + 1).width = col.width || 16;
  });
  ws.getRow(HEADER_ROW).height = 22;
  ws.views = [{ state: 'frozen', ySplit: HEADER_ROW }];
  ws.autoFilter = { from: { row: HEADER_ROW, column: 1 }, to: { row: HEADER_ROW, column: lastCol } };

  /* ── Data rows — zebra-striped for readability on wide tables, with
     the first (pinned/key) column bolded in navy like the live UI's
     .pin column treatment, so the key field still stands out at a glance. ── */
  rows.forEach((row, ri) => {
    const r = HEADER_ROW + 1 + ri;
    const stripe = ri % 2 === 1 ? ZEBRA : 'FFFFFFFF';
    columns.forEach((col, ci) => {
      const cell = ws.getCell(r, ci + 1);
      cell.value = row[col.key] ?? '';
      cell.font = ci === 0
        ? { name: 'Calibri', size: 10, bold: true, color: { argb: NAVY } }
        : { name: 'Calibri', size: 10 };
      cell.alignment = { horizontal: col.align === 'right' ? 'right' : 'left' };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: stripe } };
      cell.border = {
        bottom: { style: 'hair', color: { argb: HAIRLINE } },
        right:  { style: 'hair', color: { argb: HAIRLINE } },
      };
      if (col.numFmt) cell.numFmt = col.numFmt;
    });
  });

  /* ── Totals row ────────────────────────────────────────────────────── */
  let lastDataRow = HEADER_ROW + rows.length;
  if (totals) {
    lastDataRow += 1;
    const tRow = ws.getRow(lastDataRow);
    columns.forEach((col, ci) => {
      const cell = tRow.getCell(ci + 1);
      cell.font = { name: 'Calibri', size: 10, bold: true, color: { argb: NAVY } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: LIGHT_VIOLET } };
      cell.border = {
        top: { style: 'thin', color: { argb: VIOLET } },
        bottom: { style: 'thin', color: { argb: VIOLET } },
      };
      if (ci === 0) cell.value = 'TOTAL';
      if (totals[col.key] !== undefined) {
        cell.value = totals[col.key];
        cell.alignment = { horizontal: 'right' };
        if (col.numFmt) cell.numFmt = col.numFmt;
      }
    });
  }

  /* ── Footer note ───────────────────────────────────────────────────── */
  const footRow = lastDataRow + 2;
  ws.getCell(footRow, 1).value = `Generated by IMF ProTrack on ${fmtDate(dateStr())} · Confidential — for internal & authorised supplier/customer use only`;
  ws.getCell(footRow, 1).font = { name: 'Calibri', size: 8, italic: true, color: { argb: 'FF94A3B8' } };
  ws.mergeCells(footRow, 1, footRow, lastCol);

  /* ── Trigger download ──────────────────────────────────────────────── */
  const buf = await wb.xlsx.writeBuffer();
  const blob = new Blob([buf], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

async function exportToPdf(opts) {
  const { filename, reportTitle, filterSummary = '', columns, rows, totals = null } = opts;

  if (typeof window.jspdf === 'undefined') {
    toast('PDF export library failed to load. Check your connection and retry.', 4000);
    return;
  }

  const { jsPDF } = window.jspdf;
  const isLandscape = columns.length > 7;
  const doc = new jsPDF({
    orientation: isLandscape ? 'landscape' : 'portrait',
    unit: 'mm',
    format: 'a4'
  });

  const pageWidth = isLandscape ? 297 : 210;
  const pageHeight = isLandscape ? 210 : 297;
  const margin = 14;
  const rightMargin = pageWidth - margin;

  // 1. Draw Navy top bar
  doc.setFillColor(30, 43, 107); // Navy #1E2B6B
  doc.rect(0, 0, pageWidth, 24, 'F');

  // 2. Embed Logo in top bar
  if (typeof IMF_LOGO_BASE64 !== 'undefined') {
    try {
      const logoW = 34;
      const logoH = logoW / 2.26;
      doc.addImage('data:image/png;base64,' + IMF_LOGO_BASE64, 'PNG', margin, 4, logoW, logoH);
    } catch (e) {
      console.warn('PDF logo render failed:', e);
    }
  }

  // 3. Top bar system title (right aligned)
  doc.setFont('helvetica', 'oblique');
  doc.setFontSize(9);
  doc.setTextColor(201, 207, 232); // #C9CFE8 light gray-blue
  doc.text('IMF ProTrack — Supply Chain Management', rightMargin, 14, { align: 'right' });

  // 4. Report Title & Gen timestamp
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(15);
  doc.setTextColor(30, 43, 107); // Navy
  doc.text(reportTitle, margin, 36);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(100, 116, 139); // Gray #64748B
  const genText = `Generated: ${fmtDate(dateStr())} ${new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}`;
  doc.text(genText, rightMargin, 36, { align: 'right' });

  // 5. Filter summary
  if (filterSummary) {
    doc.setFont('helvetica', 'italic');
    doc.setFontSize(9);
    doc.setTextColor(90, 100, 120);
    doc.text(filterSummary, margin, 42);
  }

  // 6. Build Headers & Body
  const headers = columns.map(c => c.header);
  const bodyRows = rows.map(r => columns.map(c => {
    const val = r[c.key];
    if (val === null || val === undefined) return '—';
    if (typeof val === 'number' && c.numFmt === '#,##0') {
      return val.toLocaleString('en-IN');
    }
    return String(val);
  }));

  const footRows = [];
  if (totals) {
    const footRow = columns.map(c => {
      const val = totals[c.key];
      if (val === null || val === undefined) return '';
      if (typeof val === 'number') return val.toLocaleString('en-IN');
      return String(val);
    });
    footRows.push(footRow);
  }

  const columnStyles = {};
  columns.forEach((col, idx) => {
    if (col.align === 'right') {
      columnStyles[idx] = { halign: 'right' };
    } else if (col.align === 'center') {
      columnStyles[idx] = { halign: 'center' };
    }
  });

  const pageSums = {};
  let isLastRowDrawn = rows.length === 0;

  // 7. AutoTable call
  doc.autoTable({
    head: [headers],
    body: bodyRows,
    foot: footRows.length ? footRows : undefined,
    startY: filterSummary ? 46 : 40,
    margin: { left: margin, right: margin },
    theme: 'grid',
    styles: {
      font: 'helvetica',
      fontSize: 9,
      cellPadding: 2.5,
      lineColor: [237, 239, 244], // #EDEFF4 hairline
      lineWidth: 0.1,
    },
    headStyles: {
      fillColor: [30, 43, 107], // Navy #1E2B6B
      textColor: [255, 255, 255],
      fontStyle: 'bold',
    },
    footStyles: {
      fillColor: [245, 243, 255], // Light Violet #F5F3FF
      textColor: [30, 43, 107],
      fontStyle: 'bold',
      lineColor: [30, 43, 107],
    },
    columnStyles,
    willDrawCell: function (data) {
      if (data.row.section === 'body') {
        const colKey = columns[data.column.index].key;
        const val = rows[data.row.index][colKey];
        if (typeof val === 'number') {
          if (!pageSums[data.pageNumber]) pageSums[data.pageNumber] = {};
          pageSums[data.pageNumber][colKey] = (pageSums[data.pageNumber][colKey] || 0) + val;
        }
        if (data.column.index === 0) {
          if (!pageSums[data.pageNumber]) pageSums[data.pageNumber] = {};
          pageSums[data.pageNumber]._count = (pageSums[data.pageNumber]._count || 0) + 1;
        }
        if (data.row.index === rows.length - 1) {
          isLastRowDrawn = true;
        }
      }

      if (data.row.section === 'foot') {
        const colKey = columns[data.column.index].key;
        if (isLastRowDrawn) {
          // Last page: Render grand totals
          const val = totals ? totals[colKey] : null;
          if (val !== null && val !== undefined) {
            data.cell.text = [typeof val === 'number' ? val.toLocaleString('en-IN') : String(val)];
          } else if (data.column.index === 0) {
            data.cell.text = ['Grand Total'];
          } else {
            data.cell.text = [''];
          }
        } else {
          // Earlier pages: Render page-wise totals
          const pageRowsCount = pageSums[data.pageNumber] ? pageSums[data.pageNumber]._count : 0;
          const pageVal = pageSums[data.pageNumber] ? pageSums[data.pageNumber][colKey] : null;
          
          if (pageVal !== null && pageVal !== undefined) {
            data.cell.text = [pageVal.toLocaleString('en-IN')];
          } else if (colKey === 'shift') {
            data.cell.text = [`${pageRowsCount} shift${pageRowsCount !== 1 ? 's' : ''}`];
          } else if (colKey === 'name') {
            data.cell.text = [`${pageRowsCount} Part${pageRowsCount !== 1 ? 's' : ''}`];
          } else if (data.column.index === 0) {
            data.cell.text = ['Page Total'];
          } else {
            data.cell.text = [''];
          }
        }
      }
    },
    didDrawPage: function (data) {
      const pageNumStr = `Page ${doc.internal.getNumberOfPages()}`;
      const footerNote = `Generated by IMF ProTrack · Confidential — for internal & authorised supplier/customer use only`;
      doc.setFont('helvetica', 'italic');
      doc.setFontSize(7.5);
      doc.setTextColor(148, 163, 184); // slate-400
      
      // Draw confidentiality footnote on the left
      doc.text(footerNote, margin, pageHeight - 10);
      
      // Draw page number on the right
      doc.text(pageNumStr, rightMargin, pageHeight - 10, { align: 'right' });
    }
  });

  doc.save(filename);
}

/* ══════════════════════════════════════════════════════════════════════
   GLOBAL EVENT DELEGATION (close dropdowns on outside click)
   ══════════════════════════════════════════════════════════════════════ */
document.addEventListener('click', (e) => {
  if (!e.target.closest('#gdrop') && !e.target.classList.contains('part-search-input')) {
    hidePartDrop();
  }
  /* Close modal on overlay click */
  if (e.target.id === 'modal-overlay') closeModal();
});

/* Keyboard shortcuts: Escape closes modal, Enter submits it */
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { closeModal(); return; }

  if (e.key === 'Tab') {
    const overlay = document.getElementById('modal-overlay');
    const cont = document.getElementById('modal-content');
    if (!overlay || !overlay.classList.contains('open') || !cont) return;
    const focusables = cont.querySelectorAll('input, select, textarea, button, [href], [tabindex]:not([tabindex="-1"])');
    if (!focusables.length) return;
    const first = focusables[0], last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    return;
  }

  if (e.key === 'Enter') {
    /* Only fire when a modal is open and focus is NOT on textarea/select/button */
    const overlay = document.getElementById('modal-overlay');
    if (!overlay || overlay.style.display === 'none') return;
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'textarea' || tag === 'select' || tag === 'button') return;
    /* Find the primary action button (last btn-p, which is typically Save/Submit/Confirm) */
    const btns = overlay.querySelectorAll('button.btn-p:not([disabled])');
    if (!btns.length) return;
    const primary = btns[btns.length - 1];
    e.preventDefault();
    primary.click();
  }
});
