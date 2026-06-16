/* ═══════════════════════════════════════════════════════════════════
   IMF ProTrack — Home Dashboard
   Role-aware landing page after login.
   ═══════════════════════════════════════════════════════════════════ */

'use strict';

/* ══════════════════════════════════════════════════════════════════════
   MODULE NAVIGATION
   ══════════════════════════════════════════════════════════════════════ */
const MODULES = [
  { page: 'store',       icon: 'ti-building-warehouse', name: 'Store / Inward',  sub: 'Material inward & issue',     perm: 'inward' },
  { page: 'production',  icon: 'ti-settings',           name: 'Production',      sub: 'Soft & hard machining',       perm: 'production' },
  { page: 'ht',          icon: 'ti-flame',              name: 'Heat Treatment',  sub: 'Hardening & tempering',       perm: 'production' },
  { page: 'qc',          icon: 'ti-clipboard-check',    name: 'Quality Control', sub: 'Inspections & deviations',    perm: 'qc' },
  { page: 'maintenance', icon: 'ti-tool',               name: 'Maintenance',     sub: 'Breakdowns & PM logs',        perm: 'maintenance' },
  { page: 'dispatch',    icon: 'ti-truck',              name: 'Dispatch',        sub: 'Finished goods & outward',    perm: 'dispatch' },
  { page: 'reports',     icon: 'ti-chart-bar',          name: 'Reports',         sub: 'Analytics & summaries',       perm: 'reports' },
  { page: 'masters',     icon: 'ti-database',           name: 'Master Data',     sub: 'System configuration',        perm: 'masters' },
];

/** Pages that exist and are wired up. Everything else shows a "Soon" badge. */
const BUILT = new Set(['masters', 'store', 'production']);

/* ══════════════════════════════════════════════════════════════════════
   INIT
   ══════════════════════════════════════════════════════════════════════ */
async function init() {
  try {
    await initShell();
  } catch (e) {
    console.error('initShell failed:', e);
    clearSess();
    window.location.replace('index.html');
    return;
  }
  render();
  document.getElementById('loading-screen').style.display = 'none';
  document.getElementById('app').style.display = '';
}

/* ══════════════════════════════════════════════════════════════════════
   RENDER
   ══════════════════════════════════════════════════════════════════════ */
function render() {
  const showMgmtWidgets = S.sess?.role === 'admin' || S.sess?.role === 'hod';

  const html = `
    ${renderWelcome()}
    ${showMgmtWidgets ? '<div id="quick-stats"></div>' : ''}
    ${showMgmtWidgets ? '<div id="pending-approvals"></div>' : ''}
    <div class="card-hd" style="margin-top:4px"><i class="ti ti-layout-grid" aria-hidden="true"></i> Modules</div>
    ${renderModuleGrid()}
    <button class="btn btn-s" style="width:100%;margin-top:8px" onclick="logout()">
      <i class="ti ti-logout" aria-hidden="true"></i> Sign Out
    </button>
  `;

  document.getElementById('page-content').innerHTML = html;

  if (showMgmtWidgets) {
    renderQuickStats();
    renderPendingApprovals();
  }
}

/** Welcome / greeting section */
function renderWelcome() {
  const name = S.sess?.name || 'there';
  const role = rlbl(S.sess?.role);
  const today = new Date().toLocaleDateString('en-IN', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
  });

  return `
    <div class="card" style="margin-bottom:14px">
      <div style="font-size:18px;font-weight:800;color:var(--txt)">Good ${greet()}, ${name.split(' ')[0]}</div>
      <div style="font-size:12.5px;color:var(--txt-muted);margin-top:4px">${role} · ${today}</div>
    </div>`;
}

/** Responsive module navigation grid */
function renderModuleGrid() {
  const visible = MODULES.filter(m => canView(m.perm));

  if (!visible.length) {
    return `<div class="empty"><div class="empty-ic"><i class="ti ti-grid-dots"></i></div><h3>No modules available</h3><p>Contact your administrator if you believe this is incorrect.</p></div>`;
  }

  return `<div class="mod-grid">${visible.map(moduleTile).join('')}</div>`;
}

function moduleTile(m) {
  if (BUILT.has(m.page)) {
    return `
      <a href="${m.page}.html" class="mod-tile" style="flex-direction:row;align-items:center;gap:12px">
        <div class="mod-tile-ic"><i class="ti ${m.icon}" aria-hidden="true"></i></div>
        <div style="flex:1;min-width:0">
          <div class="mod-tile-nm">${m.name}</div>
          <div class="mod-tile-sub">${m.sub}</div>
        </div>
        <i class="ti ti-chevron-right" style="color:var(--txt-dim);font-size:18px;margin-left:auto" aria-hidden="true"></i>
      </a>`;
  }

  return `
    <div class="mod-tile" style="flex-direction:row;align-items:center;gap:12px;cursor:default;opacity:0.6">
      <div class="mod-tile-ic"><i class="ti ${m.icon}" aria-hidden="true"></i></div>
      <div style="flex:1;min-width:0">
        <div class="mod-tile-nm">${m.name}</div>
        <div class="mod-tile-sub">${m.sub}</div>
      </div>
      <span class="bdg-gr" style="margin-left:auto;font-size:10.5px;font-weight:700;padding:3px 8px;border-radius:999px;text-transform:uppercase;letter-spacing:0.06em">Soon</span>
    </div>`;
}

/* ══════════════════════════════════════════════════════════════════════
   QUICK STATS (admin / HOD only)
   ══════════════════════════════════════════════════════════════════════ */
async function renderQuickStats() {
  const el = document.getElementById('quick-stats');
  if (!el) return;

  el.innerHTML = `<div class="stats-3">
    <div class="stat-card"><div class="stat-lbl">Active Route Cards</div><div class="stat-val">—</div></div>
    <div class="stat-card"><div class="stat-lbl">Dispatches Today</div><div class="stat-val">—</div></div>
    <div class="stat-card"><div class="stat-lbl">Open Breakdowns</div><div class="stat-val">—</div></div>
  </div>`;

  try {
    const [rcSnap, dispSnap, bdSnap] = await Promise.all([
      db.collection('routeCards').where('status', '!=', 'dispatched').get(),
      db.collection('dispatches').where('date', '==', dateStr()).get(),
      db.collection('breakdowns').where('status', '==', 'open').get()
    ]);

    const rcCount   = rcSnap.size;
    const dispCount = dispSnap.size;
    const bdCount   = bdSnap.size;

    el.innerHTML = `<div class="stats-3">
      <div class="stat-card info">
        <div class="stat-lbl">Active Route Cards</div>
        <div class="stat-val">${rcCount}</div>
        <div class="stat-sub">In progress on shop floor</div>
      </div>
      <div class="stat-card ok">
        <div class="stat-lbl">Dispatches Today</div>
        <div class="stat-val">${dispCount}</div>
        <div class="stat-sub">${fmtDate(dateStr())}</div>
      </div>
      <div class="stat-card ${bdCount > 0 ? 'err' : 'ok'}">
        <div class="stat-lbl">Open Breakdowns</div>
        <div class="stat-val">${bdCount}</div>
        <div class="stat-sub">${bdCount > 0 ? 'Needs attention' : 'All machines running'}</div>
      </div>
    </div>`;
  } catch (e) {
    console.warn('Quick stats failed:', e.message);
    el.innerHTML = '';
  }
}

/* ══════════════════════════════════════════════════════════════════════
   PENDING APPROVALS (admin / HOD only)
   ══════════════════════════════════════════════════════════════════════ */
async function renderPendingApprovals() {
  const el = document.getElementById('pending-approvals');
  if (!el) return;

  try {
    const [reqSnap, spareSnap] = await Promise.all([
      db.collection('requisitions').where('status', '==', 'pending').get(),
      db.collection('sparesRequests').where('status', '==', 'pending').get()
    ]);

    const items = [];

    reqSnap.docs.forEach(d => {
      const r = d.data();
      items.push({
        icon: 'ti-file-text',
        name: `Requisition — ${r.partName || r.partNo || d.id}`,
        sub: `Qty ${r.qty ?? '—'} · Requested by ${r.requestedByName || r.requestedBy || 'Unknown'}`,
        ts: r.createdAt
      });
    });

    spareSnap.docs.forEach(d => {
      const r = d.data();
      items.push({
        icon: 'ti-tools',
        name: `Spares Request — ${r.itemName || r.itemId || d.id}`,
        sub: `Qty ${r.qty ?? '—'} · Requested by ${r.requestedByName || r.requestedBy || 'Unknown'}`,
        ts: r.createdAt
      });
    });

    if (!items.length) {
      el.innerHTML = '';
      return;
    }

    items.sort((a, b) => (b.ts?.toMillis?.() || 0) - (a.ts?.toMillis?.() || 0));

    el.innerHTML = `
      <div class="card-hd"><i class="ti ti-clock-exclamation" aria-hidden="true"></i> Pending Approvals (${items.length})</div>
      ${items.slice(0, 5).map(it => `
        <div class="li" style="cursor:default">
          <div class="li-ic warn"><i class="ti ${it.icon}" aria-hidden="true"></i></div>
          <div class="li-body">
            <div class="li-name">${it.name}</div>
            <div class="li-sub">${it.sub}</div>
          </div>
          <div class="li-right">
            <div class="li-sub">${fmtTS(it.ts)}</div>
          </div>
        </div>`).join('')}
    `;
  } catch (e) {
    console.warn('Pending approvals failed:', e.message);
    el.innerHTML = '';
  }
}

/* ══════════════════════════════════════════════════════════════════════
   BOOT
   ══════════════════════════════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', init);
