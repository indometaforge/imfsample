/* ═══════════════════════════════════════════════════════════════════
   IMF ProTrack — Home Dashboard (home.js)
   Role-split:
     admin / hod / supervisor → full plant intelligence dashboard
     operator                 → shift snapshot + alerts
   Layout:
     Mobile (<768px)  — compact metric tiles / shift card
     Desktop (≥768px) — 3-col grid: Pipeline · Today · Alerts
   ═══════════════════════════════════════════════════════════════════ */

'use strict';

/* ── Roles that see the full management dashboard ── */
const MGMT_ROLES = new Set(['admin', 'hod', 'supervisor']);

/* ── Pipeline stage definitions (order = flow order) ── */
const PIPELINE = [
  { key: 'store_issued', label: 'Store Issued',   href: 'store.html',      color: 'info' },
  { key: 'soft_wip',     label: 'Soft Machining', href: 'production.html', color: 'warn' },
  { key: 'soft_done',    label: 'Soft Done',      href: 'production.html', color: 'warn' },
  { key: 'ht_queue',     label: 'HT Queue',       href: 'ht.html',         color: 'warn' },
  { key: 'ht_done',      label: 'HT Done',        href: 'ht.html',         color: 'ok'   },
  { key: 'hard_wip',     label: 'Hard Machining', href: 'production.html', color: 'warn' },
  { key: 'qc_pending',   label: 'QC Pending',     href: 'qc.html',         color: 'info' },
  { key: 'qc_cleared',   label: 'QC Cleared',     href: 'dispatch.html',   color: 'ok'   },
];

/* ── Stage → relevant route-card statuses (operator view) ── */
const STAGE_RC_MAP = {
  store:    ['store_issued'],
  soft:     ['soft_wip', 'soft_done'],
  ht:       ['ht_queue', 'ht_done'],
  hard:     ['hard_wip'],
  qc:       ['qc_pending', 'qc_cleared'],
  dispatch: ['qc_cleared'],
};

/* ── Route-card status → label + badge class (operator queue) ── */
const RC_STATUS = {
  store_issued: { l: 'Store Issued', b: 'bdg-b' },
  soft_wip:     { l: 'Soft WIP',     b: 'bdg-soft' },
  soft_done:    { l: 'Soft Done',    b: 'bdg-soft' },
  ht_queue:     { l: 'HT Queue',     b: 'bdg-a' },
  ht_done:      { l: 'HT Done',      b: 'bdg-a' },
  hard_wip:     { l: 'Hard WIP',     b: 'bdg-hard' },
  qc_pending:   { l: 'QC Pending',   b: 'bdg-a' },
  qc_cleared:   { l: 'QC Cleared',   b: 'bdg-g' },
};

/* ── Status → owning module (built from PIPELINE) ── */
const PIPE_HREF = Object.fromEntries(PIPELINE.map(p => [p.key, p.href]));

/* ── Module-local state ── */
let _data = null;

/* ══ INIT ════════════════════════════════════════════════════════════ */
async function init() {
  try {
    await initShell();
  } catch (e) {
    clearSess();
    window.location.replace('index.html');
    return;
  }
  render();   /* skeleton immediately */
  document.getElementById('loading-screen').style.display = 'none';
  document.getElementById('app').style.display = '';
  await loadData();
}

/* ══ DATA LOADING ════════════════════════════════════════════════════ */
async function loadData() {
  try {
    if (MGMT_ROLES.has(S.sess?.role)) {
      await loadManagerData();
    } else {
      await loadOperatorData();
    }
    renderData();
  } catch (e) {
    console.warn('[home] data load failed:', e.message);
  }
}

async function loadManagerData() {
  const today          = dateStr();
  const activeStatuses = PIPELINE.map(p => p.key);

  const [rcSnap, bdSnap, dispSnap, reqSnap, spareSnap] = await Promise.all([
    db.collection('routeCards').where('status', 'in', activeStatuses).get(),
    db.collection('breakdowns').where('status', '==', 'open').get(),
    db.collection('dispatches').where('date', '==', today).get(),
    db.collection('requisitions').where('status', '==', 'pending').get(),
    db.collection('sparesRequests').where('status', '==', 'pending').get(),
  ]);

  const pipeline = {};
  activeStatuses.forEach(s => { pipeline[s] = []; });
  rcSnap.docs.forEach(d => {
    const st = d.data().status;
    if (pipeline[st]) pipeline[st].push({ id: d.id, ...d.data() });
  });

  _data = {
    type:         'manager',
    pipeline,
    totalActive:  rcSnap.size,
    breakdowns:   bdSnap.docs.map(d => ({ id: d.id, ...d.data() })),
    dispatches:   dispSnap.docs.map(d => ({ id: d.id, ...d.data() })),
    requisitions: reqSnap.docs.map(d => ({ id: d.id, ...d.data() })),
    spares:       spareSnap.docs.map(d => ({ id: d.id, ...d.data() })),
  };
}

async function loadOperatorData() {
  const stage      = S.sess?.stage || 'general';
  const rcStatuses = STAGE_RC_MAP[stage] || [];

  const queries = [db.collection('breakdowns').where('status', '==', 'open').get()];
  if (rcStatuses.length) {
    queries.push(db.collection('routeCards').where('status', 'in', rcStatuses).get());
  }

  const [bdSnap, rcSnap] = await Promise.all(queries);

  _data = {
    type:        'operator',
    breakdowns:  bdSnap.docs.map(d => ({ id: d.id, ...d.data() })),
    stageCards:  rcSnap ? rcSnap.docs.map(d => ({ id: d.id, ...d.data() })) : [],
    stage,
  };
}

/* ══ RENDER — SKELETON ═══════════════════════════════════════════════ */
function render() {
  const page = document.getElementById('page-content');
  if (!page) return;
  const isMgmt = MGMT_ROLES.has(S.sess?.role);
  page.innerHTML = renderGreeting() + (isMgmt ? managerSkeleton() : operatorSkeleton());
}

function managerSkeleton() {
  const skRow = () => `<div class="skel skel-sm" style="margin-bottom:9px"></div>`;
  return `
    <div class="mob-metrics">
      ${[1,2,3,4].map(() => `<div class="skel" style="height:76px;border-radius:var(--r)"></div>`).join('')}
    </div>
    <div class="home-grid">
      <div class="home-panel" style="padding:16px">${[1,2,3,4,5].map(skRow).join('')}</div>
      <div class="home-panel" style="padding:16px">${[1,2,3].map(skRow).join('')}</div>
      <div class="home-panel" style="padding:16px">${[1,2,3].map(skRow).join('')}</div>
    </div>`;
}

function operatorSkeleton() {
  return `
    <div class="home-op">
      <div class="skel" style="height:84px;border-radius:var(--r)"></div>
      <div class="skel" style="height:52px;border-radius:var(--rs)"></div>
      <div class="skel skel-sm" style="width:55%"></div>
    </div>`;
}

/* ══ RENDER — DATA ═══════════════════════════════════════════════════ */
function renderData() {
  if (!_data) return;
  const page = document.getElementById('page-content');
  if (!page) return;

  if (_data.type === 'manager') {
    page.innerHTML = renderGreeting() + renderManagerDashboard();
  } else {
    page.innerHTML = renderGreeting() + renderOperatorDashboard();
  }
}

/* ── Greeting header (shared by both roles) ── */
function renderGreeting() {
  const name  = S.sess?.name ? S.sess.name.split(' ')[0] : 'there';
  const role  = rlbl(S.sess?.role);
  const stage = S.sess?.stage && S.sess.stage !== 'general' ? slbl(S.sess.stage) : '';
  const today = new Date().toLocaleDateString('en-IN', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
  });
  const shift     = getActiveShift();
  const shiftPart = shift ? ` &middot; ${shift.label} (${shift.start}–${shift.end})` : '';

  return `
    <div class="home-hdr">
      <div class="home-hdr-name">Good ${greet()}, ${name}</div>
      <div class="home-hdr-meta">${role}${stage ? ' &middot; ' + stage : ''} &middot; ${today}${shiftPart}</div>
    </div>`;
}

/* ══ MANAGER DASHBOARD ═══════════════════════════════════════════════ */
function renderManagerDashboard() {
  const { pipeline, totalActive, breakdowns, dispatches, requisitions, spares } = _data;
  const pendingTotal = requisitions.length + spares.length;
  const qcCleared   = (pipeline.qc_cleared || []).length;
  const htDone      = (pipeline.ht_done    || []).length;
  const softDone    = (pipeline.soft_done  || []).length;

  /* Mobile: 2×2 compact metric tiles — hidden on desktop via CSS */
  const mobileMetrics = `
    <div class="mob-metrics">
      <a href="store.html" class="mob-metric info">
        <i class="ti ti-route mob-metric-icon" aria-hidden="true"></i>
        <span class="mob-val">${totalActive}</span>
        <span class="mob-lbl">Active TAGs</span>
      </a>
      <a href="maintenance.html" class="mob-metric ${breakdowns.length > 0 ? 'err' : 'ok'}">
        <i class="ti ${breakdowns.length > 0 ? 'ti-alert-triangle' : 'ti-check'} mob-metric-icon" aria-hidden="true"></i>
        <span class="mob-val">${breakdowns.length}</span>
        <span class="mob-lbl">Breakdowns</span>
      </a>
      <a href="dispatch.html" class="mob-metric ok">
        <i class="ti ti-truck mob-metric-icon" aria-hidden="true"></i>
        <span class="mob-val">${dispatches.length}</span>
        <span class="mob-lbl">Dispatched Today</span>
      </a>
      <a href="approvals.html" class="mob-metric ${pendingTotal > 0 ? 'warn' : 'ok'}">
        <i class="ti ${pendingTotal > 0 ? 'ti-clock-exclamation' : 'ti-checks'} mob-metric-icon" aria-hidden="true"></i>
        <span class="mob-val">${pendingTotal}</span>
        <span class="mob-lbl">Pending Approvals</span>
      </a>
    </div>`;

  /* Desktop: 3-col intelligence grid — hidden on mobile via CSS */
  const desktopGrid = `
    <div class="home-grid">
      ${renderPipelinePanel(pipeline, totalActive)}
      ${renderTodayPanel(dispatches, qcCleared, htDone, softDone)}
      ${renderAlertsPanel(breakdowns, requisitions, spares)}
    </div>`;

  /* Mobile: condensed pipeline keeps the pipeline alive <768px — hidden on desktop */
  return mobileMetrics + renderPipelineMobile(pipeline, totalActive) + desktopGrid;
}

/* ── Condensed pipeline (mobile only) — static rows, no expand ── */
function renderPipelineMobile(pipeline, totalActive) {
  const counts   = PIPELINE.map(p => (pipeline[p.key] || []).length);
  const maxCount = Math.max(1, ...counts);

  const rows = PIPELINE.map(p => {
    const count = (pipeline[p.key] || []).length;
    const pct   = Math.round((count / maxCount) * 100);
    return `
      <div class="ps-row static">
        <span class="ps-label">${p.label}</span>
        <div class="ps-bar-wrap"><div class="ps-bar ps-bar-${p.color}" style="transform:scaleX(${(pct/100).toFixed(4)})"></div></div>
        <span class="ps-count${count === 0 ? ' zero' : ''}">${count}</span>
      </div>`;
  }).join('');

  return `
    <section class="home-panel home-pipe-mob">
      <div class="home-panel-hd">
        <a href="production.html" class="home-panel-title">Production Pipeline</a>
        <span class="bdg-n">${totalActive} active</span>
      </div>
      <div class="pipeline-stages">${rows}</div>
    </section>`;
}

/* ── Production Pipeline panel (left column) ── */
function renderPipelinePanel(pipeline, totalActive) {
  const counts   = PIPELINE.map(p => (pipeline[p.key] || []).length);
  const maxCount = Math.max(1, ...counts);

  const rows = PIPELINE.map(p => {
    const cards = pipeline[p.key] || [];
    const count = cards.length;
    const pct   = Math.round((count / maxCount) * 100);
    const detId = 'ps-dt-' + p.key;
    const chevId = 'ps-cv-' + p.key;

    const cardRows = cards.slice(0, 8).map(c => `
      <div class="ps-card-row">
        <span class="tag-uid"><i class="ti ti-qrcode" aria-hidden="true"></i> ${c.id}</span>
        <span class="ps-card-part">${c.partName || c.partId || '—'}</span>
        <span class="ps-card-qty">${c.currentQty ?? c.initialQty ?? '—'} pcs</span>
      </div>`).join('');

    const moreLink = cards.length > 8
      ? `<div class="ps-more"><a href="${p.href}">+${cards.length - 8} more →</a></div>`
      : '';

    return `
      <div class="ps-row" role="button" tabindex="0" aria-expanded="false" aria-controls="${detId}"
        onclick="toggleExpand('${detId}','${chevId}')" onkeydown="onRowKey(event,()=>toggleExpand('${detId}','${chevId}'))">
        <span class="ps-label">${p.label}</span>
        <div class="ps-bar-wrap"><div class="ps-bar ps-bar-${p.color}" style="transform:scaleX(${(pct/100).toFixed(4)})"></div></div>
        <span class="ps-count${count === 0 ? ' zero' : ''}">${count}</span>
        <i class="ti ti-chevron-down ps-chev" id="${chevId}" aria-hidden="true"></i>
      </div>
      ${count > 0 ? `<div class="ps-detail" id="${detId}" hidden>${cardRows}${moreLink}</div>` : ''}`;
  }).join('');

  return `
    <section class="home-panel">
      <div class="home-panel-hd">
        <a href="production.html" class="home-panel-title">Production Pipeline</a>
        <span class="bdg-n">${totalActive} active</span>
      </div>
      <div class="pipeline-stages">${rows}</div>
    </section>`;
}

/* ── Today's activity panel (center column) ── */
function renderTodayPanel(dispatches, qcCleared, htDone, softDone) {
  const today = new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });

  const dispRows = dispatches.slice(0, 6).map(d => `
    <div class="act-expand-row">
      <span class="act-expand-label">${d.sessionId || d.id}</span>
      <span class="act-expand-meta">${d.customerName || d.customerId || '—'}</span>
      <span class="act-expand-ts">${fmtTS(d.createdAt)}</span>
    </div>`).join('');

  const dispMore = dispatches.length > 6
    ? `<a href="dispatch.html" class="act-expand-more">View all ${dispatches.length} dispatches →</a>`
    : '';

  return `
    <section class="home-panel">
      <div class="home-panel-hd">
        <span class="home-panel-title">Today &middot; ${today}</span>
      </div>

      <div class="act-row" role="button" tabindex="0" aria-expanded="false" aria-controls="td-disp"
        onclick="toggleExpand('td-disp','td-disp-c')" onkeydown="onRowKey(event,()=>toggleExpand('td-disp','td-disp-c'))">
        <div class="act-icon ok"><i class="ti ti-truck" aria-hidden="true"></i></div>
        <div class="act-body">
          <a href="dispatch.html" class="act-label" onclick="event.stopPropagation()">Dispatches</a>
          <span class="act-sub">Shipments confirmed today</span>
        </div>
        <span class="act-val">${dispatches.length}</span>
        <i class="ti ti-chevron-down act-chev" id="td-disp-c" aria-hidden="true"></i>
      </div>
      <div class="act-expand" id="td-disp" hidden>
        ${dispatches.length
          ? dispRows + dispMore
          : '<div style="font-size:12px;color:var(--txt-muted);padding:4px 0">No dispatches today</div>'}
      </div>

      <a href="qc.html" class="act-row">
        <div class="act-icon ok"><i class="ti ti-clipboard-check" aria-hidden="true"></i></div>
        <div class="act-body">
          <span class="act-label">QC Cleared</span>
          <span class="act-sub">Ready for dispatch</span>
        </div>
        <span class="act-val">${qcCleared}</span>
        <i class="ti ti-arrow-right act-chev" aria-hidden="true"></i>
      </a>

      <a href="ht.html" class="act-row">
        <div class="act-icon warn"><i class="ti ti-flame" aria-hidden="true"></i></div>
        <div class="act-body">
          <span class="act-label">HT Completed</span>
          <span class="act-sub">Awaiting hard machining</span>
        </div>
        <span class="act-val">${htDone}</span>
        <i class="ti ti-arrow-right act-chev" aria-hidden="true"></i>
      </a>

      <a href="production.html" class="act-row">
        <div class="act-icon info"><i class="ti ti-settings" aria-hidden="true"></i></div>
        <div class="act-body">
          <span class="act-label">Soft Done</span>
          <span class="act-sub">Awaiting heat treatment</span>
        </div>
        <span class="act-val">${softDone}</span>
        <i class="ti ti-arrow-right act-chev" aria-hidden="true"></i>
      </a>
    </section>`;
}

/* ── Alerts panel (right column) ── */
function renderAlertsPanel(breakdowns, requisitions, spares) {
  const pendingAll = [
    ...requisitions.map(r => ({
      nm:   r.partName || r.partNo || r.partId || r.id,
      meta: `Req · ${r.requestedByName || r.requestedBy || '?'} · Qty ${r.qty ?? '—'}`,
      ts:   r.createdAt,
    })),
    ...spares.map(s => ({
      nm:   s.itemName || s.itemId || s.id,
      meta: `Spares · ${s.requestedByName || s.requestedBy || '?'} · Qty ${s.qty ?? '—'}`,
      ts:   s.createdAt,
    })),
  ].sort((a, b) => (b.ts?.toMillis?.() || 0) - (a.ts?.toMillis?.() || 0));

  const urgentCount = breakdowns.length + pendingAll.length;

  const bdDetail = breakdowns.slice(0, 6).map(b => `
    <div class="alert-detail-row">
      <span class="alert-detail-nm">${b.machineName || b.machineId || '—'}</span>
      <span class="alert-detail-meta">${b.issueDesc || b.category || b.description || '—'}</span>
      <span class="alert-detail-ts">${fmtTS(b.reportedAt || b.createdAt)}</span>
    </div>`).join('') + (breakdowns.length > 6
      ? `<a href="maintenance.html" class="act-expand-more">See all ${breakdowns.length} →</a>`
      : '');

  const apprDetail = pendingAll.slice(0, 6).map(a => `
    <div class="alert-detail-row">
      <span class="alert-detail-nm">${a.nm}</span>
      <span class="alert-detail-meta">${a.meta}</span>
      <span class="alert-detail-ts">${fmtTS(a.ts)}</span>
    </div>`).join('') + (pendingAll.length > 6
      ? `<a href="approvals.html" class="act-expand-more">See all ${pendingAll.length} →</a>`
      : '');

  const bdBlock = breakdowns.length > 0 ? `
    <div class="alert-block err" role="button" tabindex="0" aria-expanded="false" aria-controls="al-bd"
      onclick="toggleExpand('al-bd','al-bd-c')" onkeydown="onRowKey(event,()=>toggleExpand('al-bd','al-bd-c'))">
      <div class="alert-hd">
        <i class="ti ti-alert-triangle" aria-hidden="true"></i>
        <a href="maintenance.html" class="alert-title" onclick="event.stopPropagation()">Open Breakdowns</a>
        <span class="alert-cnt">${breakdowns.length}</span>
        <i class="ti ti-chevron-down" id="al-bd-c" aria-hidden="true"></i>
      </div>
      <div class="alert-detail" id="al-bd" hidden>${bdDetail}</div>
    </div>` : `
    <div class="alert-block ok-state">
      <div class="alert-block-all-ok">
        <i class="ti ti-check" aria-hidden="true"></i> All machines running
      </div>
    </div>`;

  const apprBlock = pendingAll.length > 0 ? `
    <div class="alert-block warn" role="button" tabindex="0" aria-expanded="false" aria-controls="al-ap"
      onclick="toggleExpand('al-ap','al-ap-c')" onkeydown="onRowKey(event,()=>toggleExpand('al-ap','al-ap-c'))">
      <div class="alert-hd">
        <i class="ti ti-clock-exclamation" aria-hidden="true"></i>
        <a href="approvals.html" class="alert-title" onclick="event.stopPropagation()">Pending Approvals</a>
        <span class="alert-cnt">${pendingAll.length}</span>
        <i class="ti ti-chevron-down" id="al-ap-c" aria-hidden="true"></i>
      </div>
      <div class="alert-detail" id="al-ap" hidden>${apprDetail}</div>
    </div>` : `
    <div class="alert-block ok-state">
      <div class="alert-block-all-ok">
        <i class="ti ti-checks" aria-hidden="true"></i> No pending approvals
      </div>
    </div>`;

  return `
    <section class="home-panel">
      <div class="home-panel-hd">
        <span class="home-panel-title">Alerts</span>
        ${urgentCount > 0
          ? `<span class="bdg-r">${urgentCount} open</span>`
          : `<span class="bdg-g">All clear</span>`}
      </div>
      ${bdBlock}
      ${apprBlock}
    </section>`;
}

/* ══ OPERATOR DASHBOARD ══════════════════════════════════════════════ */
function renderOperatorDashboard() {
  const { breakdowns, stageCards, stage } = _data;
  const shift      = getActiveShift();
  const stageLabel = stage && stage !== 'general' ? slbl(stage) : '';

  const wipCount  = stageCards.filter(c => c.status && !c.status.endsWith('_done') && c.status !== 'qc_cleared').length;
  const doneCount = stageCards.filter(c => c.status && (c.status.endsWith('_done') || c.status === 'qc_cleared')).length;

  const alertBanner = breakdowns.length > 0 ? `
    <a href="maintenance.html" class="op-alert-banner">
      <i class="ti ti-alert-triangle" aria-hidden="true"></i>
      ${breakdowns.length} open breakdown${breakdowns.length > 1 ? 's' : ''} on the floor
    </a>` : '';

  const shiftCard = `
    <div class="op-shift-card">
      <div class="op-shift-row">
        <span class="op-shift-name">${shift ? shift.label : 'Active Shift'}</span>
        ${shift ? `<span class="op-shift-time">${shift.start} – ${shift.end}</span>` : ''}
      </div>
      ${stageLabel ? `<span class="op-shift-stage-tag"><i class="ti ti-map-pin" aria-hidden="true"></i> ${stageLabel}</span>` : ''}
    </div>`;

  const stageMetrics = stageCards.length > 0 ? `
    <div class="op-stage-metrics">
      <div class="op-stage-metric">
        <div class="op-stage-metric-val">${wipCount}</div>
        <div class="op-stage-metric-lbl">In Progress</div>
      </div>
      <div class="op-stage-metric">
        <div class="op-stage-metric-val">${doneCount}</div>
        <div class="op-stage-metric-lbl">Completed</div>
      </div>
    </div>` : '';

  /* Tappable list of the cards on this operator's bench */
  const queueRows = stageCards.slice(0, 40).map(c => {
    const m    = RC_STATUS[c.status] || { l: c.status || '—', b: 'bdg-gr' };
    const href = PIPE_HREF[c.status] || 'production.html';
    const qty  = c.currentQty ?? c.initialQty ?? '—';
    return `
      <a href="${href}" class="op-queue-row">
        <div class="op-queue-main">
          <span class="tag-uid"><i class="ti ti-qrcode" aria-hidden="true"></i> ${c.id}</span>
          <span class="op-queue-part">${c.partName || c.partId || '—'}</span>
        </div>
        <span class="op-queue-qty">${qty} pcs</span>
        <span class="bdg ${m.b}"><span class="bdg-dot"></span>${m.l}</span>
      </a>`;
  }).join('');

  const queueList = stageCards.length > 0 ? `
    <div class="op-queue">
      <div class="op-queue-hd">On Your Bench (${stageCards.length})</div>
      ${queueRows}
    </div>` : '';

  return `
    <div class="home-op">
      ${alertBanner}
      ${shiftCard}
      ${stageMetrics}
      ${queueList}
      <a href="maintenance.html" class="btn-breakdown">
        <i class="ti ti-tool" aria-hidden="true"></i> Report Breakdown
      </a>
    </div>`;
}

/* ══ TOGGLE EXPAND ════════════════════════════════════════════════════
   Pure DOM toggle — no full re-render. Preserves scroll position.
   ═══════════════════════════════════════════════════════════════════ */
function toggleExpand(detailId, chevId) {
  const detail = document.getElementById(detailId);
  const chev   = document.getElementById(chevId);
  const trigger = document.querySelector(`[aria-controls="${detailId}"]`);
  if (!detail) return;
  const opening = detail.hasAttribute('hidden');
  if (opening) {
    detail.removeAttribute('hidden');
    if (chev) { chev.classList.remove('ti-chevron-down'); chev.classList.add('ti-chevron-up'); }
  } else {
    detail.setAttribute('hidden', '');
    if (chev) { chev.classList.remove('ti-chevron-up'); chev.classList.add('ti-chevron-down'); }
  }
  if (trigger) trigger.setAttribute('aria-expanded', String(opening));
}

/* ══ BOOT ════════════════════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', init);
