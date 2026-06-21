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
const TEST_MODE = true;

const TRANSACTIONAL_COLLECTIONS = new Set([
  'inward', 'iqcResults', 'requisitions', 'routeCards',
  'setupApprovals', 'setupDeviations', 'actuals', 'plans', 'prodDrafts', 'planDrafts',
  'htCharges', 'qcInspections', 'scrapLedger',
  'breakdowns', 'machineStatus', 'sparesRequests', 'pmLogs',
  'dispatches', 'pos', 'auditLogs'
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

/** Current date string yyyy-mm-dd (local) */
const dateStr = () => new Date().toISOString().slice(0, 10);

/** Tomorrow date string yyyy-mm-dd */
const tomStr = () => {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
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
};

const PERMS = {
  admin: {
    masters: 'full', inward: 'full', requisition_approve: 'full',
    production: 'full', ht: 'full', qc: 'full',
    maintenance: 'full', spares_approve: 'full',
    deviation_approve: 'full', dispatch: 'full', reports: 'full',
    breakdown_report: 'full'
  }
};

const getPerm = (action) => {
  const role  = S.sess?.role  || '';
  const stage = S.sess?.stage || 'general';

  if (role === 'admin') return PERMS.admin[action] || 'hidden';

  const area = STAGE_PERM_AREA[stage] || 'production';

  if (role === 'hod') {
    if (action === area) return 'full';
    if (action === 'reports') return 'full';
    if (action === 'breakdown_report') return 'full';
    if (action === 'requisition_approve' && area === 'inward') return 'full';
    if (action === 'spares_approve' && area === 'maintenance') return 'full';
    if (action === 'deviation_approve' && area === 'qc') return 'full';
    if ((action === 'production' || action === 'ht') && (area === 'production' || area === 'ht')) return 'view';
    return 'hidden';
  }

  if (role === 'supervisor') {
    if (action === area) return 'full';
    if (action === 'reports') return 'view';
    if (action === 'breakdown_report') return 'full';
    if ((action === 'production' || action === 'ht') && (area === 'production' || area === 'ht')) return 'view';
    return 'hidden';
  }

  if (role === 'operator') {
    if (action === area) return 'view';
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
    custsSnap, suppsSnap, shiftDoc
  ] = await Promise.all([
    db.collection('users').get(),
    db.collection('machines').get(),
    db.collection('parts').get(),
    db.collection('operations').get(),
    db.collection('partOps').get(),
    db.collection('customers').get(),
    db.collection('suppliers').get(),
    db.collection('config').doc('shifts').get()
  ]);

  S.users       = usersSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  S.machines    = machinesSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  S.parts       = partsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  S.operations  = opsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  S.partOps     = partOpsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  S.customers   = custsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  S.suppliers   = suppsSnap.docs.map(d => ({ id: d.id, ...d.data() }));

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
function openModal(html) {
  const cont = document.getElementById('modal-content');
  const mov  = document.getElementById('modal-overlay');
  if (!cont || !mov) return;
  cont.innerHTML = '<div class="modal-handle"></div>' + html;
  mov.classList.add('open');
  document.body.style.overflow = 'hidden';
}

function closeModal() {
  const mov = document.getElementById('modal-overlay');
  if (!mov) return;
  mov.classList.remove('open');
  document.body.style.overflow = '';
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
   SIDEBAR NAVIGATION
   ══════════════════════════════════════════════════════════════════════ */
function initSidebar() {
  const sidebar  = document.getElementById('sidebar');
  const overlay  = document.getElementById('sb-overlay');
  const menuBtn  = document.getElementById('topbar-menu-btn');

  if (menuBtn && sidebar && overlay) {
    menuBtn.addEventListener('click', () => {
      sidebar.classList.toggle('open');
      overlay.classList.toggle('on');
    });
    overlay.addEventListener('click', () => {
      sidebar.classList.remove('open');
      overlay.classList.remove('on');
    });
  }

  /* Highlight active nav item based on current page filename */
  const page = location.pathname.split('/').pop().replace('.html', '');
  document.querySelectorAll('.sbi[data-page]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.page === page);
  });
  document.querySelectorAll('.bni[data-page]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.page === page);
  });
}

/* ══════════════════════════════════════════════════════════════════════
   SIDEBAR HTML BUILDER
   Generates the consistent sidebar markup for every page.
   ══════════════════════════════════════════════════════════════════════ */
function buildSidebar() {
  const role = S.sess?.role || '';

  /* Define nav items — show/hide based on permissions */
  const navItems = [
    { page: 'home',        icon: 'ti-home',               label: 'Home' },
    { page: 'store',       icon: 'ti-building-warehouse',  label: 'Store / Inward',   perm: 'inward' },
    { page: 'production',  icon: 'ti-settings',            label: 'Production',       perm: 'production' },
    { page: 'ht',          icon: 'ti-flame',               label: 'Heat Treatment',   perm: 'production' },
    { page: 'qc',          icon: 'ti-clipboard-check',     label: 'Quality Control',  perm: 'qc' },
    { page: 'maintenance', icon: 'ti-tool',                label: 'Maintenance',      perm: 'maintenance' },
    { page: 'dispatch',    icon: 'ti-truck',               label: 'Dispatch',         perm: 'dispatch' },
  ];

  const mgmtItems = [
    { page: 'approvals',   icon: 'ti-checks',              label: 'Approvals',        perm: 'production' },
    { page: 'reports',     icon: 'ti-chart-bar',           label: 'Reports',          perm: 'reports' },
    { page: 'masters',     icon: 'ti-database',            label: 'Masters',          perm: 'masters' },
  ];

  const curPage = location.pathname.split('/').pop().replace('.html', '');

  const buildItem = (item) => {
    if (item.perm && !canView(item.perm)) return '';
    const active = item.page === curPage ? 'active' : '';
    return `
      <a href="${item.page}.html" class="sbi ${active}" data-page="${item.page}">
        <div class="sbi-ic"><i class="ti ${item.icon}" aria-hidden="true"></i></div>
        <span class="sbi-label">${item.label}</span>
        ${active ? '<span class="sbi-active-dot"></span>' : ''}
      </a>`;
  };

  const name = S.sess?.name || 'User';
  const initls = initials(name);
  const roleLabel = rlbl(role);

  return `
    <div class="sb-logo">
      <img src="IMF_logo_jpg_2.jpg" alt="Indo Meta Forge Pvt. Ltd." class="sb-logo-img">
      <div class="sb-brand-name">IMF ProTrack</div>
      <div class="sb-product-tag">Manufacturing Execution System</div>
    </div>
    <nav class="sb-nav" aria-label="Main navigation">
      <div class="sb-section-label">Modules</div>
      ${navItems.map(buildItem).join('')}
      <div class="sb-section-label">Management</div>
      ${mgmtItems.map(buildItem).join('')}
    </nav>
    <div class="sb-foot">
      <button class="sb-user" onclick="logout()">
        <div class="sb-av" aria-hidden="true">${initls}</div>
        <div>
          <div class="sb-uname">${name}</div>
          <div class="sb-urole">${roleLabel} · Sign out</div>
        </div>
        <i class="ti ti-logout" style="font-size:16px;color:rgba(255,255,255,0.35);margin-left:auto" aria-hidden="true"></i>
      </button>
    </div>`;
}

/* ══════════════════════════════════════════════════════════════════════
   BOTTOM NAV HTML BUILDER
   ══════════════════════════════════════════════════════════════════════ */
function buildBottomNav() {
  const items = [
    { page: 'home',        icon: 'ti-home',              label: 'Home' },
    { page: 'production',  icon: 'ti-settings',           label: 'Prod',  perm: 'production' },
    { page: 'qc',          icon: 'ti-clipboard-check',    label: 'QC',    perm: 'qc' },
    { page: 'maintenance', icon: 'ti-tool',               label: 'Maint', perm: 'maintenance' },
    { page: 'dispatch',    icon: 'ti-truck',              label: 'Dispt', perm: 'dispatch' },
  ];

  const curPage = location.pathname.split('/').pop().replace('.html', '');

  return items.map(item => {
    if (item.perm && !canView(item.perm)) return '';
    const active = item.page === curPage ? 'active' : '';
    return `
      <a href="${item.page}.html" class="bni ${active}" data-page="${item.page}">
        <i class="bni-icon ti ${item.icon}" aria-hidden="true"></i>
        <span class="bni-label">${item.label}</span>
      </a>`;
  }).join('');
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

  /* Render sidebar and bottom nav */
  const sbEl = document.getElementById('sidebar');
  const bnEl = document.getElementById('bottom-nav');
  if (sbEl) sbEl.innerHTML = buildSidebar();
  if (bnEl) bnEl.innerHTML = buildBottomNav();

  /* TEST MODE banner — visual reminder that transactional writes are
     redirected to TEST_ collections, not live data (mirrors i-v3.html) */
  if (TEST_MODE) {
    const mainEl = document.querySelector('#app .main');
    if (mainEl && !document.getElementById('test-mode-bar')) {
      mainEl.insertAdjacentHTML('afterbegin',
        `<div id="test-mode-bar" style="background:var(--warn);color:#fff;text-align:center;font-size:12px;font-weight:700;padding:6px 10px;letter-spacing:.04em">
          <i class="ti ti-flask" aria-hidden="true"></i> TEST MODE — writes go to TEST_ collections, not live data
        </div>`);
    }
  }

  /* Wire sidebar toggle (mobile) */
  initSidebar();

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
    _qrInstance.stop().catch(() => {}).finally(() => {
      _qrInstance.clear();
      _qrInstance = null;
    });
  }
  closeModal();
}

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
