/* ═══════════════════════════════════════════════════════════════════
   IMF ProTrack — Production Module
   Soft & Hard Machining: Actuals, Plans, Setup, Breakdowns, Requisitions
   ═══════════════════════════════════════════════════════════════════ */
'use strict';

/* ══════════════════════════════════════════════════════════════════════
   TABS
   ══════════════════════════════════════════════════════════════════════ */
const TABS = [
  { key: 'hub',       label: 'Hub',          icon: 'ti-layout-grid' },
  { key: 'setup',     label: 'Setup',        icon: 'ti-settings-cog' },
  { key: 'breakdown', label: 'Breakdowns',   icon: 'ti-alert-triangle' },
  { key: 'reqs',      label: 'Requisitions', icon: 'ti-file-text',
    show: () => ['supervisor','hod','admin'].includes(S.sess?.role) || canDo('production') },
  { key: 'reports',   label: 'Reports',      icon: 'ti-chart-bar' },
  { key: 'plans',     label: 'View Plans',   icon: 'ti-calendar' },
];

/* ══════════════════════════════════════════════════════════════════════
   STATE
   ══════════════════════════════════════════════════════════════════════ */
let _activeTab  = 'hub';
let _activeView = 'tabs'; // 'tabs' | 'actual' | 'actual_detail' | 'plan'

// Actual Entry state
let _actStage      = '';
let _actDate       = '';
let _actShift      = '';
let _actSupervisor = '';
let _machineData   = {}; // machineId → { used, idleReason, idleReasonOther, operatorId, runs:[], downtime:[] }
let _detailMachId  = '';        // machine currently open in detail view
let _autoSaveTimers = {};       // machineId → setTimeout handle
let _autoSaveStatus = {};       // machineId → 'saved' | 'saving' | 'error'

// Plan Entry state
let _planStage = '';
let _planDate  = '';
let _planData  = {}; // machineId → { partId, partName, partNo, plannedQty }

// Setup state
let _setupCard  = null;
let _setupTagId = '';
let _setupStage = '';

// Requisition state
let _reqLines = [];

// Report filter state
let _repStage = 'soft';
let _repDate  = '';
let _repShift = '';

// Plan view filter state
let _pvStage = 'soft';
let _pvDate  = '';

/* ══════════════════════════════════════════════════════════════════════
   INIT
   ══════════════════════════════════════════════════════════════════════ */
async function init() {
  try { await initShell(); } catch (e) { clearSess(); window.location.replace('index.html'); return; }
  if (!canView('production')) { window.location.replace('home.html'); return; }
  const pill = document.getElementById('role-pill');
  if (pill) pill.textContent = rlbl(S.sess.role);
  _actDate  = dateStr();
  _repDate  = dateStr();
  _pvDate   = dateStr();
  _planDate = dateStr();
  try {
    await loadProdData();
    render();
  } catch (e) {
    console.error('Production data load failed:', e);
    toast('Error loading data: ' + e.message, 5000);
    render();
  }
  document.getElementById('loading-screen').style.display = 'none';
  document.getElementById('app').style.display = '';
}

async function loadProdData() {
  S.actuals        = S.actuals        || [];
  S.plans          = S.plans          || [];
  S.breakdowns     = S.breakdowns     || [];
  S.requisitions   = S.requisitions   || [];
  S.machineStatus  = S.machineStatus  || [];
  S.setupApprovals = S.setupApprovals || [];
  S.prodDrafts     = S.prodDrafts     || [];
  S.planDrafts     = S.planDrafts     || [];

  const [actSnap, planSnap, bdSnap, reqSnap, msSnap, saSnap, pdSnap, pldSnap] = await Promise.all([
    db.collection('actuals').orderBy('createdAt','desc').limit(300).get(),
    db.collection('plans').orderBy('createdAt','desc').limit(300).get(),
    db.collection('breakdowns').orderBy('createdAt','desc').limit(150).get(),
    db.collection('requisitions').get(),
    db.collection('machineStatus').get(),
    db.collection('setupApprovals').orderBy('createdAt','desc').limit(200).get(),
    db.collection('prodDrafts').get(),
    db.collection('planDrafts').get(),
  ]);
  S.actuals        = actSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  S.plans          = planSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  S.breakdowns     = bdSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  S.requisitions   = reqSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  S.machineStatus  = msSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  S.setupApprovals = saSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  S.prodDrafts     = pdSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  S.planDrafts     = pldSnap.docs.map(d => ({ id: d.id, ...d.data() }));
}

/* ══════════════════════════════════════════════════════════════════════
   RENDER — tabs + view routing
   ══════════════════════════════════════════════════════════════════════ */
function render() {
  if (_activeView === 'actual')        { renderActualEntry();  return; }
  if (_activeView === 'actual_detail') { renderMachineDetail(); return; }
  if (_activeView === 'plan')          { renderPlanEntry();    return; }

  const visibleTabs = TABS.filter(t => !t.show || t.show());
  const tabsHtml = `
    <div class="tabs" role="tablist">
      ${visibleTabs.map(t => `
        <button class="tab${_activeTab === t.key ? ' active' : ''}"
          role="tab" aria-selected="${_activeTab === t.key}"
          onclick="switchTab('${t.key}')">
          <i class="ti ${t.icon}" aria-hidden="true"></i> ${t.label}
        </button>`).join('')}
    </div>`;

  let contentHtml = '';
  switch (_activeTab) {
    case 'hub':       contentHtml = buildHubHtml();       break;
    case 'setup':     contentHtml = buildSetupHtml();     break;
    case 'breakdown': contentHtml = buildBreakdownHtml(); break;
    case 'reqs':      contentHtml = buildReqsHtml();      break;
    case 'reports':   contentHtml = buildReportsHtml();   break;
    case 'plans':     contentHtml = buildPlansViewHtml(); break;
    default:          contentHtml = buildHubHtml();
  }

  document.getElementById('page-content').innerHTML = tabsHtml + contentHtml;
  if (_activeTab === 'reports') loadAndRenderReports();
  if (_activeTab === 'plans')   loadAndRenderPlans();
}

function switchTab(key) {
  _activeTab = key;
  _activeView = 'tabs';
  render();
}

/* ══════════════════════════════════════════════════════════════════════
   LOCAL UI HELPERS
   ══════════════════════════════════════════════════════════════════════ */
function sectionHeader(title, sub) {
  return `<div class="card-hd" style="margin-top:8px"><i class="ti ti-point-filled" style="color:var(--acc)"></i> ${title}${sub ? `<span style="font-size:11px;font-weight:400;color:var(--txt-muted);margin-left:8px">${sub}</span>` : ''}</div>`;
}

function emptyState(icon, title, msg) {
  return `<div class="empty"><div class="empty-ic"><i class="ti ${icon}"></i></div><h3>${title}</h3><p>${msg}</p></div>`;
}

function stBadge(status) {
  const map = {
    pending:   'bdg-a', approved: 'bdg-g', rejected: 'bdg-r',
    partial:   'bdg-b', fulfilled:'bdg-g', open: 'bdg-r',
    acknowledged: 'bdg-a', resolved: 'bdg-g',
    soft_wip: 'bdg-soft', hard_wip: 'bdg-hard', soft_done: 'bdg-g', hard_done: 'bdg-g',
  };
  const lbl = {
    pending:'Pending', approved:'Approved', rejected:'Rejected',
    partial:'Partial', fulfilled:'Fulfilled', open:'Open',
    acknowledged:'In Progress', resolved:'Resolved',
    soft_wip:'Soft WIP', hard_wip:'Hard WIP', soft_done:'Soft Done', hard_done:'Hard Done',
  };
  return `<span class="bdg ${map[status] || 'bdg-gr'}">${lbl[status] || status}</span>`;
}

/* ══════════════════════════════════════════════════════════════════════
   HUB TAB
   ══════════════════════════════════════════════════════════════════════ */
function buildHubHtml() {
  const today = dateStr();
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  const softMachines = (S.machines || []).filter(m => m.stage === 'soft' && m.active !== false);
  const hardMachines = (S.machines || []).filter(m => m.stage === 'hard' && m.active !== false);

  // Most recent shift entry (within last 24 h) per stage
  const softLatest = (S.actuals || [])
    .filter(a => a.stage === 'soft' && a.date >= yesterday)
    .sort((a, b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0))[0];
  const hardLatest = (S.actuals || [])
    .filter(a => a.stage === 'hard' && a.date >= yesterday)
    .sort((a, b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0))[0];
  const softActive = softLatest ? softLatest.machinesUsed || 0 : 0;
  const hardActive = hardLatest ? hardLatest.machinesUsed || 0 : 0;
  const softActiveLabel = softLatest ? `Shift ${softLatest.shift} · ${softLatest.date}` : 'No data yet';
  const hardActiveLabel = hardLatest ? `Shift ${hardLatest.shift} · ${hardLatest.date}` : 'No data yet';

  const openBd = (S.breakdowns || []).filter(b => b.status === 'open' || b.status === 'acknowledged').length;
  const pendingReqs = (S.requisitions || []).filter(r => r.status === 'pending').length;
  const pendingSA  = (S.setupApprovals || []).filter(s => s.status === 'pending').length;

  return `
    <div style="padding:2px 0 16px">

      ${sectionHeader('Stage Selection', 'Select a stage to log production')}

      <div class="row-2" style="margin-bottom:16px">
        <div class="card" style="cursor:pointer;border-top:4px solid var(--acc);padding:16px 14px" onclick="enterActualStage('soft')">
          <div style="margin-bottom:10px">
            <div style="font-weight:800;font-size:15px;margin-bottom:2px">Soft Stage</div>
            <div style="font-size:11px;color:var(--txt-muted)">Turning, Milling, Drilling</div>
          </div>
          <div class="row-2" style="gap:8px;margin-bottom:10px">
            <div style="text-align:center;background:var(--bg);border-radius:8px;padding:8px 4px">
              <div style="font-size:18px;font-weight:800;color:var(--txt)">${softMachines.length}</div>
              <div style="font-size:10px;color:var(--txt-muted)">Total Machines</div>
            </div>
            <div style="text-align:center;background:var(--bg);border-radius:8px;padding:8px 4px">
              <div style="font-size:18px;font-weight:800;color:var(--ok)">${softActive}</div>
              <div style="font-size:10px;color:var(--txt-muted)">Active Machines</div>
              <div style="font-size:9px;color:var(--txt-muted)">${softActiveLabel}</div>
            </div>
          </div>
          <div style="display:flex;gap:8px">
            <button class="btn btn-p" style="flex:1;font-size:12px" onclick="event.stopPropagation();enterActualStage('soft')">
              <i class="ti ti-writing"></i> Log Actuals
            </button>
            <button class="btn btn-s" style="flex:1;font-size:12px" onclick="event.stopPropagation();enterPlanStage('soft')">
              <i class="ti ti-calendar-event"></i> Plan Entry
            </button>
          </div>
        </div>

        <div class="card" style="cursor:pointer;border-top:4px solid var(--acc);padding:16px 14px" onclick="enterActualStage('hard')">
          <div style="margin-bottom:10px">
            <div style="font-weight:800;font-size:15px;margin-bottom:2px">Hard Stage</div>
            <div style="font-size:11px;color:var(--txt-muted)">Post-HT machining</div>
          </div>
          <div class="row-2" style="gap:8px;margin-bottom:10px">
            <div style="text-align:center;background:var(--bg);border-radius:8px;padding:8px 4px">
              <div style="font-size:18px;font-weight:800;color:var(--txt)">${hardMachines.length}</div>
              <div style="font-size:10px;color:var(--txt-muted)">Total Machines</div>
            </div>
            <div style="text-align:center;background:var(--bg);border-radius:8px;padding:8px 4px">
              <div style="font-size:18px;font-weight:800;color:var(--ok)">${hardActive}</div>
              <div style="font-size:10px;color:var(--txt-muted)">Active Machines</div>
              <div style="font-size:9px;color:var(--txt-muted)">${hardActiveLabel}</div>
            </div>
          </div>
          <div style="display:flex;gap:8px">
            <button class="btn btn-p" style="flex:1;font-size:12px" onclick="event.stopPropagation();enterActualStage('hard')">
              <i class="ti ti-writing"></i> Log Actuals
            </button>
            <button class="btn btn-s" style="flex:1;font-size:12px" onclick="event.stopPropagation();enterPlanStage('hard')">
              <i class="ti ti-calendar-event"></i> Plan Entry
            </button>
          </div>
        </div>
      </div>

      ${sectionHeader('Quick Status')}
      <div class="stats-3" style="margin-bottom:8px">
        <div class="stat-card ${openBd > 0 ? 'err' : 'ok'}">
          <div class="stat-lbl">Open Breakdowns</div>
          <div class="stat-val">${openBd}</div>
          <div class="stat-sub">${openBd > 0 ? 'Needs attention' : 'All clear'}</div>
        </div>
        <div class="stat-card ${pendingReqs > 0 ? 'warn' : 'ok'}">
          <div class="stat-lbl">Pending Reqs</div>
          <div class="stat-val">${pendingReqs}</div>
          <div class="stat-sub">Awaiting approval</div>
        </div>
        <div class="stat-card ${pendingSA > 0 ? 'warn' : 'ok'}">
          <div class="stat-lbl">Setup Approvals</div>
          <div class="stat-val">${pendingSA}</div>
          <div class="stat-sub">Awaiting QC</div>
        </div>
      </div>
    </div>`;
}

/* ══════════════════════════════════════════════════════════════════════
   ACTUAL ENTRY
   ══════════════════════════════════════════════════════════════════════ */
function enterActualStage(stage) {
  _actStage  = stage;
  _activeView = 'actual';
  _machineData = {};

  // Auto-pick current shift
  const hr = new Date().getHours();
  if (!_actShift) {
    if (hr >= 6 && hr < 14)      _actShift = 'A';
    else if (hr >= 14 && hr < 22) _actShift = 'B';
    else                           _actShift = 'C';
  }
  if (!_actDate) _actDate = dateStr();

  // Load existing drafts for this stage/date/shift
  const draftKey = `${_actDate}_${_actShift}_${_actStage}`;
  const myDrafts = (S.prodDrafts || []).filter(d => d.draftKey === draftKey && d.userId === S.sess.userId);
  myDrafts.forEach(d => { _machineData[d.machineId] = { ...d.machineData, _draftId: d.id }; });

  // Check if already submitted
  const alreadySubmitted = (S.actuals || []).some(
    a => a.date === _actDate && a.shift === _actShift && a.stage === _actStage
  );
  if (alreadySubmitted) {
    toast('A shift entry for this stage/date/shift already exists. Showing view only.', 4000);
  }

  renderActualEntry();
}

/* ── ACTUAL ENTRY: COMPACT MACHINE MATRIX ────────────────────────── */
function renderActualEntry() {
  const machines = (S.machines || [])
    .filter(m => m.stage === _actStage && m.active !== false)
    .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));

  const stageLabel = _actStage === 'soft' ? 'Soft Stage' : 'Hard Stage';
  const shiftOpts = Object.entries(S.shifts || { A:{label:'Shift A'}, B:{label:'Shift B'}, C:{label:'Shift C'} })
    .map(([k, v]) => `<option value="${k}" ${_actShift === k ? 'selected' : ''}>${v.label || k}</option>`).join('');
  const supervisorOpts = (S.users || [])
    .filter(u => ['supervisor','hod','admin'].includes(u.role))
    .map(u => `<option value="${u.id}" ${_actSupervisor === u.id ? 'selected' : ''}>${u.name}</option>`).join('');
  const alreadySubmitted = (S.actuals || []).some(
    a => a.date === _actDate && a.shift === _actShift && a.stage === _actStage
  );

  const matrixHtml = machines.map(m => {
    const md = _machineData[m.id];
    const ms = (S.machineStatus || []).find(s => s.id === m.id);
    const isBreakdown = ms && (ms.status === 'pending_breakdown' || ms.status === 'under_maintenance');
    const totalProcessed = (md?.runs || []).reduce((s, r) => s + (+r.processed || 0), 0);
    const totalDtMins    = (md?.downtime || []).reduce((s, d) => s + (+d.mins || 0), 0);
    const runsCount      = (md?.runs || []).length;

    let statusColor = 'var(--bdr)';
    let statusLabel = 'Tap to log';
    if (isBreakdown) { statusColor = '#f59e0b'; statusLabel = '⚠ Breakdown'; }
    else if (md?.used === true)  { statusColor = 'var(--ok)'; statusLabel = `${runsCount} run${runsCount!==1?'s':''} · ${totalProcessed} pcs`; }
    else if (md?.used === false && md?.idleReason) { statusColor = 'var(--bdr)'; statusLabel = `Idle: ${md.idleReason.split(' ')[0]}...`; }

    const saveStatus = _autoSaveStatus[m.id];
    const saveLbl = saveStatus === 'saving' ? '⟳ Saving...'
                  : saveStatus === 'saved'   ? '✓ Saved'
                  : saveStatus === 'error'   ? '⚠ Save error'
                  : '';

    return `
      <div onclick="openMachineDetail('${m.id}')"
        style="background:var(--sur);border:2px solid ${statusColor};border-radius:var(--rs);padding:12px 14px;
               margin-bottom:10px;cursor:pointer;display:flex;align-items:center;gap:12px">
        <div style="flex:1;min-width:0">
          <div style="font-weight:700;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${m.name}</div>
          <div style="font-size:11px;color:var(--txt-muted)">${m.id_code || m.id}</div>
          <div style="font-size:12px;color:${md?.used ? 'var(--ok)' : 'var(--txt-muted)'};margin-top:3px">${statusLabel}</div>
          ${saveLbl ? `<div style="font-size:10px;color:var(--txt-muted)">${saveLbl}</div>` : ''}
        </div>
        <i class="ti ti-chevron-right" style="color:var(--txt-dim);font-size:20px;flex-shrink:0"></i>
      </div>`;
  }).join('');

  document.getElementById('page-content').innerHTML = `
    <div style="padding-bottom:80px">
      <div style="display:flex;align-items:center;gap:12px;padding:12px 0 8px;border-bottom:1px solid var(--bdr);margin-bottom:12px">
        <button class="btn btn-s btn-sm" onclick="backToHub()" style="flex-shrink:0">
          <i class="ti ti-arrow-left"></i> Back
        </button>
        <div style="flex:1">
          <div style="font-weight:800;font-size:15px">${stageLabel} — Log Actuals</div>
          <div style="font-size:11px;color:var(--txt-muted)">Tap a machine to log its data</div>
        </div>
      </div>

      <div class="card" style="margin-bottom:12px">
        <div class="row-3">
          <div class="f">
            <label>Date</label>
            <input type="date" id="act-date" value="${_actDate}" onchange="_actDate=this.value;_machineData={};renderActualEntry()">
          </div>
          <div class="f">
            <label>Shift</label>
            <select id="act-shift" onchange="_actShift=this.value;_machineData={};renderActualEntry()">
              ${shiftOpts}
            </select>
          </div>
          <div class="f">
            <label>Supervisor *</label>
            <select id="act-sup" onchange="_actSupervisor=this.value">
              <option value="">— Select —</option>
              ${supervisorOpts}
            </select>
          </div>
        </div>
      </div>

      ${alreadySubmitted ? `<div class="ibox" style="background:#fefce8;border-color:#facc15;color:#92400e;margin-bottom:10px"><i class="ti ti-info-circle"></i> A finalized entry already exists for this shift.</div>` : ''}

      <div style="font-size:12px;font-weight:700;color:var(--txt-muted);margin-bottom:8px">MACHINES (${machines.length})</div>
      ${machines.length ? matrixHtml : emptyState('ti-tool','No Machines',`No active machines for ${stageLabel}.`)}

      ${!alreadySubmitted && machines.length ? `
        <button class="btn btn-p" style="width:100%;margin-top:8px" onclick="finalizeShift()">
          <i class="ti ti-check"></i> Finalize Shift
        </button>` : ''}
    </div>`;
}

/* ── ACTUAL ENTRY: MACHINE DETAIL (full-page drill-down) ─────────── */
function openMachineDetail(machId) {
  _detailMachId  = machId;
  _activeView    = 'actual_detail';
  if (!_machineData[machId]) {
    _machineData[machId] = { used: false, idleReason: '', idleReasonOther: '', operatorId: '', operatorName: '', runs: [], downtime: [] };
  }
  render();
}

function renderMachineDetail() {
  const machId = _detailMachId;
  const m  = (S.machines || []).find(x => x.id === machId) || { id: machId, name: machId, id_code: '' };
  const md = _machineData[machId] || { used: false, idleReason: '', idleReasonOther: '', operatorId: '', operatorName: '', runs: [], downtime: [] };
  const ms = (S.machineStatus || []).find(s => s.id === machId);
  const isBreakdown = ms && (ms.status === 'pending_breakdown' || ms.status === 'under_maintenance');

  const IDLE_OPTIONS = ['No Material','Under Maintenance','No Operator','Power Cut / Electricity','Other'];

  const operatorOpts = (S.users || [])
    .filter(u => (u.role === 'operator' || !u.appUser) && (!u.stage || u.stage === _actStage || u.stage === 'general'))
    .map(u => `<option value="${u.id}" ${md.operatorId === u.id ? 'selected' : ''}>${u.name}</option>`).join('');

  // Setup sessions for this machine + date + shift
  const setupSessions = (S.setupApprovals || []).filter(sa =>
    sa.machineId === machId && sa.date === _actDate && sa.shift === _actShift && sa.status === 'approved'
  );
  const totalSetupMins = setupSessions.reduce((s, sa) => s + (sa.setupMins || 0), 0);

  const setupHtml = setupSessions.length
    ? setupSessions.map(sa => `
        <div style="display:flex;justify-content:space-between;font-size:12px;padding:4px 0;border-bottom:1px solid var(--bdr)">
          <span>${sa.opName || '—'} <span style="color:var(--txt-muted);font-family:monospace">${sa.tagId || ''}</span></span>
          <span style="font-weight:700">${sa.setupMins} min</span>
        </div>`).join('') +
      `<div style="display:flex;justify-content:space-between;font-size:12px;font-weight:700;padding:6px 0 0;color:var(--acc)">
        <span>Total Setup</span><span>${totalSetupMins} min</span>
      </div>`
    : `<div style="font-size:12px;color:var(--txt-muted)">No approved setup logged for this shift</div>`;

  const totalProcessed = (md.runs || []).reduce((s, r) => s + (+r.processed || 0), 0);
  const totalRejected  = (md.runs || []).reduce((s, r) => s + (+r.rejected  || 0), 0);
  const totalDtMins    = (md.downtime || []).reduce((s, d) => s + (+d.mins || 0), 0);

  const saveStatus = _autoSaveStatus[machId];
  const saveLbl = saveStatus === 'saving' ? '⟳ Auto-saving...'
                : saveStatus === 'saved'   ? '✓ All changes saved'
                : saveStatus === 'error'   ? '⚠ Save failed — check connection'
                : 'Changes save automatically';

  const runsHtml = (md.runs || []).length === 0
    ? `<div style="font-size:12px;color:var(--txt-muted);padding:10px;text-align:center;border:1px dashed var(--bdr);border-radius:6px">No runs logged yet</div>`
    : (md.runs || []).map((r, i) => `
        <div style="background:var(--bg);border-radius:6px;padding:10px 12px;margin-bottom:8px">
          <div style="display:flex;justify-content:space-between;align-items:flex-start">
            <div style="flex:1">
              <div style="font-weight:700;font-size:13px">${r.tagId}</div>
              <div style="font-size:11px;color:var(--acc);font-family:monospace">${r.opName || ''}</div>
              <div style="font-size:11px;color:var(--txt-muted)">${r.partName || ''}</div>
              <div style="margin-top:4px;font-size:13px">
                <span style="color:var(--ok);font-weight:700">${r.processed}</span> pcs produced &nbsp;
                <span style="color:var(--err,#dc2626);font-weight:700">${r.rejected || 0}</span> rejected
              </div>
            </div>
            <button onclick="removeRunDetail(${i})" style="border:none;background:#fef2f2;color:#dc2626;border-radius:6px;padding:4px 8px;cursor:pointer;font-size:12px;flex-shrink:0">Remove</button>
          </div>
        </div>`).join('');

  const downtimeHtml = (md.downtime || []).length === 0
    ? `<div style="font-size:12px;color:var(--txt-muted);padding:10px;text-align:center;border:1px dashed var(--bdr);border-radius:6px">No downtime logged</div>`
    : (md.downtime || []).map((d, i) => `
        <div style="background:#fef2f2;border-radius:6px;padding:10px 12px;margin-bottom:8px">
          <div style="display:flex;justify-content:space-between;align-items:flex-start">
            <div>
              <div style="font-weight:700;font-size:13px">${d.startTime} → ${d.endTime} <span style="font-weight:400;color:var(--txt-muted)">(${d.mins} min)</span></div>
              <div style="font-size:12px;color:var(--txt-muted)">${d.type || 'Other'}${d.description ? ' · ' + d.description : ''}</div>
            </div>
            <button onclick="removeDowntimeDetail(${i})" style="border:none;background:transparent;color:#dc2626;cursor:pointer;font-size:13px;flex-shrink:0">✕</button>
          </div>
        </div>`).join('');

  document.getElementById('page-content').innerHTML = `
    <div style="padding-bottom:80px">
      <!-- Header -->
      <div style="display:flex;align-items:center;gap:10px;padding:12px 0 10px;border-bottom:1px solid var(--bdr);margin-bottom:14px">
        <button class="btn btn-s btn-sm" onclick="backToMatrix()" style="flex-shrink:0">
          <i class="ti ti-arrow-left"></i> Matrix
        </button>
        <div style="flex:1;min-width:0">
          <div style="font-weight:800;font-size:15px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${m.name}</div>
          <div style="font-size:11px;color:var(--acc);font-family:monospace">${m.id_code || m.id}</div>
        </div>
        <div id="autosave-lbl" style="font-size:10px;color:${saveStatus==='error'?'#dc2626':saveStatus==='saving'?'#f59e0b':'var(--ok)'};text-align:right;flex-shrink:0;max-width:90px">${saveLbl}</div>
      </div>

      ${isBreakdown ? `<div class="ibox" style="background:#fef2f2;border-color:#fca5a5;color:#991b1b;margin-bottom:12px">⚠ This machine has an open breakdown. Logging actuals may be inaccurate.</div>` : ''}

      <!-- Used / Not Used toggle -->
      <div class="card" style="margin-bottom:12px">
        <div style="display:flex;align-items:center;justify-content:space-between">
          <div>
            <div style="font-weight:700">Machine Status</div>
            <div style="font-size:12px;color:var(--txt-muted)">Was this machine used this shift?</div>
          </div>
          <div style="display:flex;align-items:center;gap:10px">
            <span style="font-size:13px;font-weight:600;color:${md.used?'var(--ok)':'var(--txt-muted)'}">${md.used?'Used':'Not Used'}</span>
            <div onclick="toggleMachineUsedDetail(${!md.used})"
              style="width:48px;height:26px;border-radius:13px;background:${md.used?'var(--ok)':'var(--bdr)'};cursor:pointer;position:relative;transition:background .2s;flex-shrink:0">
              <div style="position:absolute;top:3px;left:${md.used?'25px':'3px'};width:20px;height:20px;border-radius:10px;background:#fff;transition:left .2s;box-shadow:0 1px 3px rgba(0,0,0,.25)"></div>
            </div>
          </div>
        </div>
      </div>

      ${md.used ? `
        <!-- Operator -->
        <div class="card" style="margin-bottom:12px">
          <div class="f" style="margin:0">
            <label>Operator *</label>
            <select onchange="setDetailField('operatorId',this.value);setDetailField('operatorName',this.options[this.selectedIndex].text);triggerAutoSave()">
              <option value="">— Select Operator —</option>
              ${operatorOpts}
            </select>
          </div>
        </div>

        <!-- Setup sessions (read-only) -->
        <div class="card" style="margin-bottom:12px;background:var(--bg)">
          <div style="font-size:12px;font-weight:700;color:var(--txt-muted);margin-bottom:8px">SETUP SESSIONS (this shift)</div>
          ${setupHtml}
        </div>

        <!-- Production Runs -->
        <div class="card" style="margin-bottom:12px">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
            <div style="font-size:12px;font-weight:700;color:var(--txt-muted)">PRODUCTION RUNS</div>
            <button class="btn btn-s btn-sm" onclick="openAddRunModal('${machId}')">
              <i class="ti ti-scan"></i> Add Run
            </button>
          </div>
          ${runsHtml}
        </div>

        <!-- Downtime -->
        <div class="card" style="margin-bottom:12px">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
            <div style="font-size:12px;font-weight:700;color:var(--txt-muted)">DOWNTIME SESSIONS</div>
            <button class="btn btn-s btn-sm" onclick="openAddDowntimeModal('${machId}')">
              <i class="ti ti-plus"></i> Add
            </button>
          </div>
          ${downtimeHtml}
        </div>

        <!-- Summary -->
        <div class="card" style="margin-bottom:12px;background:var(--bg)">
          <div style="font-size:12px;font-weight:700;color:var(--txt-muted);margin-bottom:10px">SHIFT SUMMARY</div>
          <div class="row-3" style="gap:8px;text-align:center">
            <div style="background:var(--sur);border-radius:8px;padding:10px 4px">
              <div style="font-size:20px;font-weight:800;color:var(--ok)">${totalProcessed}</div>
              <div style="font-size:10px;color:var(--txt-muted)">Produced</div>
            </div>
            <div style="background:var(--sur);border-radius:8px;padding:10px 4px">
              <div style="font-size:20px;font-weight:800;color:#dc2626">${totalRejected}</div>
              <div style="font-size:10px;color:var(--txt-muted)">Rejected</div>
            </div>
            <div style="background:var(--sur);border-radius:8px;padding:10px 4px">
              <div style="font-size:20px;font-weight:800;color:#f59e0b">${totalDtMins + totalSetupMins}</div>
              <div style="font-size:10px;color:var(--txt-muted)">Lost Mins</div>
            </div>
          </div>
          <div style="margin-top:8px;font-size:11px;color:var(--txt-muted);text-align:center">
            Lost mins = ${totalDtMins} downtime + ${totalSetupMins} setup
          </div>
        </div>

      ` : `
        <!-- Idle reason (required dropdown) -->
        <div class="card" style="margin-bottom:12px">
          <div class="f">
            <label>Idle Reason *</label>
            <select id="idle-reason-sel" onchange="onIdleReasonChange(this.value)">
              <option value="">— Select reason —</option>
              ${IDLE_OPTIONS.map(o => `<option value="${o}" ${md.idleReason===o?'selected':''}>${o}</option>`).join('')}
            </select>
          </div>
          <div id="idle-other-wrap" style="display:${md.idleReason==='Other'?'block':'none'};margin-top:8px">
            <div class="f" style="margin:0">
              <label>Please specify *</label>
              <input type="text" id="idle-other-txt" value="${md.idleReasonOther||''}"
                placeholder="Describe the reason..."
                oninput="setDetailField('idleReasonOther',this.value);triggerAutoSave()">
            </div>
          </div>
        </div>
      `}
    </div>`;
}

/* — detail helpers — */
function setDetailField(key, val) {
  if (!_machineData[_detailMachId]) _machineData[_detailMachId] = { used: false, idleReason:'', idleReasonOther:'', operatorId:'', operatorName:'', runs:[], downtime:[] };
  _machineData[_detailMachId][key] = val;
}

function toggleMachineUsedDetail(used) {
  setDetailField('used', used);
  triggerAutoSave();
  renderMachineDetail();
}

function onIdleReasonChange(val) {
  setDetailField('idleReason', val);
  const wrap = document.getElementById('idle-other-wrap');
  if (wrap) wrap.style.display = val === 'Other' ? 'block' : 'none';
  triggerAutoSave();
}

function removeRunDetail(idx) {
  const md = _machineData[_detailMachId];
  if (md && md.runs) { md.runs.splice(idx, 1); triggerAutoSave(); renderMachineDetail(); }
}

function removeDowntimeDetail(idx) {
  const md = _machineData[_detailMachId];
  if (md && md.downtime) { md.downtime.splice(idx, 1); triggerAutoSave(); renderMachineDetail(); }
}

/* — legacy wrappers kept for modal callbacks — */
function toggleMachineUsed(machId, used) {
  _detailMachId = machId;
  setDetailField('used', used);
  triggerAutoSave();
  renderMachineDetail();
}
function removeRun(machId, idx) {
  _detailMachId = machId;
  removeRunDetail(idx);
}
function removeDowntime(machId, idx) {
  _detailMachId = machId;
  removeDowntimeDetail(idx);
}

/* — Auto-save (debounced) — */
function triggerAutoSave() {
  const machId = _detailMachId;
  if (!machId) return;
  _autoSaveStatus[machId] = 'saving';
  updateAutoSaveLabel();
  clearTimeout(_autoSaveTimers[machId]);
  _autoSaveTimers[machId] = setTimeout(() => doAutoSave(machId), 1500);
}

function updateAutoSaveLabel() {
  const machId = _detailMachId;
  const status = _autoSaveStatus[machId] || '';
  const el = document.getElementById('autosave-lbl');
  if (!el) return;
  el.textContent = status === 'saving' ? '⟳ Auto-saving...'
                 : status === 'saved'   ? '✓ All changes saved'
                 : status === 'error'   ? '⚠ Save failed'
                 : 'Auto-saves';
  el.style.color = status === 'error' ? '#dc2626' : status === 'saving' ? '#f59e0b' : 'var(--ok)';
}

async function doAutoSave(machId) {
  const md = _machineData[machId];
  if (!md) return;
  const draftKey = `${_actDate}_${_actShift}_${_actStage}`;
  const docId    = `${S.sess.userId}_${draftKey}_${machId}`;
  try {
    await db.collection('prodDrafts').doc(docId).set({
      draftKey, machineId: machId, stage: _actStage, date: _actDate, shift: _actShift,
      userId: S.sess.userId, machineData: md, updatedAt: serverTS(),
    }, { merge: true });
    _autoSaveStatus[machId] = 'saved';
    const idx = S.prodDrafts.findIndex(d => d.id === docId);
    if (idx >= 0) S.prodDrafts[idx].machineData = md;
    else S.prodDrafts.push({ id: docId, draftKey, machineId: machId, machineData: md });
  } catch (e) {
    _autoSaveStatus[machId] = 'error';
    console.warn('Auto-save failed:', e.message);
  }
  updateAutoSaveLabel();
}

function backToMatrix() {
  _activeView   = 'actual';
  _detailMachId = '';
  render();
}

/* — Add Run Modal — */
let _runMachId = '';
let _runCard   = null;

function openAddRunModal(machId) {
  _runMachId    = machId;
  _detailMachId = machId;
  _runCard      = null;
  const mach = (S.machines || []).find(m => m.id === machId);
  openModal(`
    <div class="mtit"><i class="ti ti-scan"></i> Add Production Run</div>
    <div style="font-size:12px;color:var(--txt-muted);margin-bottom:14px">Machine: <strong>${mach ? mach.name : machId}</strong></div>

    <div class="card-hd">Scan / Enter Route Card TAG</div>
    <div style="display:flex;gap:8px;margin-bottom:12px">
      <input id="run-tag-input" type="text" placeholder="e.g. TAG042"
        oninput="this.value=this.value.toUpperCase()"
        autocomplete="off" spellcheck="false" style="flex:1"
        onkeydown="if(event.key==='Enter')runFetchTag()">
      <button class="btn btn-s qr-scan-btn" onclick="openQrScanner(v=>{document.getElementById('run-tag-input').value=v.toUpperCase();runFetchTag();},'Scan TAG')" title="Scan QR">
        <i class="ti ti-camera"></i>
      </button>
    </div>
    <button class="btn btn-s" style="width:100%;margin-bottom:12px" onclick="runFetchTag()">Load TAG →</button>

    <div id="run-tag-info"></div>
    <div id="run-form" style="display:none">
      <div class="row-2">
        <div class="f">
          <label>Processed (pcs) *</label>
          <input type="number" id="run-processed" min="1" placeholder="0">
        </div>
        <div class="f">
          <label>Rejected (pcs)</label>
          <input type="number" id="run-rejected" min="0" placeholder="0">
        </div>
      </div>
      <button class="btn btn-p mt8" style="width:100%" onclick="confirmAddRun()">Add Run ✓</button>
    </div>
    <button class="btn btn-s mt8" style="width:100%" onclick="closeModal()">Cancel</button>
  `);
}

async function runFetchTag() {
  const tagId = (document.getElementById('run-tag-input')?.value || '').trim().toUpperCase();
  if (!tagId) { toast('Enter or scan a TAG'); return; }
  if (!tagId.match(/^TAG\d+$/)) { toast('Invalid TAG format'); return; }

  const infoDiv = document.getElementById('run-tag-info');
  if (infoDiv) infoDiv.innerHTML = `<div style="font-size:12px;color:var(--txt-muted);text-align:center;padding:10px">Loading...</div>`;

  try {
    const card = await fetchRouteCard(tagId);
    if (!card) {
      if (infoDiv) infoDiv.innerHTML = `<div class="ibox" style="background:#fef2f2;border-color:var(--err,#dc2626);color:var(--err,#dc2626)">TAG ${tagId} not found</div>`;
      return;
    }

    // Hard stage: heatCode required
    if (_actStage === 'hard' && !card.heatCode) {
      if (infoDiv) infoDiv.innerHTML = `<div class="ibox" style="background:#fef2f2;border-color:var(--err,#dc2626);color:var(--err,#dc2626)">Hard stage requires a heat code on this TAG. Check Heat Treatment.</div>`;
      return;
    }

    // Sequence check
    const partOpsForStage = (S.partOps || [])
      .filter(po => po.partId === card.partId && po.stage === _actStage)
      .sort((a, b) => (a.seqNo || 0) - (b.seqNo || 0));
    const completedOpIds = (card.opHistory || []).filter(h => h.stage === _actStage).map(h => h.opId);
    const nextOp = partOpsForStage.find(po => !completedOpIds.includes(po.opId));

    let deviationHtml = '';
    if (nextOp && partOpsForStage.length > 1) {
      const nextIdx = partOpsForStage.findIndex(po => po.opId === nextOp.opId);
      if (nextIdx > 0) {
        const prevRequired = partOpsForStage[nextIdx - 1];
        if (!completedOpIds.includes(prevRequired.opId)) {
          const prevOpName = (S.operations || []).find(o => o.id === prevRequired.opId)?.name || 'Previous Op';
          deviationHtml = `
            <div style="background:#fff7ed;border:1.5px solid #f97316;border-radius:var(--rs);padding:10px 12px;margin-bottom:10px">
              <div style="font-weight:700;color:#ea580c;font-size:12px">⚠ Sequence Deviation Detected</div>
              <div style="font-size:11px;color:#9a3412;margin-top:4px">
                Previous operation "<strong>${prevOpName}</strong>" (seq ${prevRequired.seqNo}) has no completion on this TAG.
              </div>
              <button class="btn btn-sm" style="margin-top:8px;width:100%;border-color:#f97316;color:#ea580c;font-size:11px"
                onclick="showDeviationConfirmModal('${tagId}','${prevOpName}',${prevRequired.seqNo})">
                Request Sequence Deviation Approval
              </button>
            </div>`;
        }
      }
    }

    const opName = nextOp ? ((S.operations || []).find(o => o.id === nextOp?.opId)?.name || '—') : 'No next op';
    const cycleTimeSecs = nextOp ? ((S.partOps || []).find(po => po.partId === card.partId && po.opId === nextOp.opId)?.cycleTimeSecs || 0) : 0;

    _runCard = { ...card, nextOp, cycleTimeSecs };

    if (infoDiv) infoDiv.innerHTML = `
      ${deviationHtml}
      <div style="background:#f0fdf4;border:1px solid #86efac;border-radius:var(--rs);padding:10px 12px;margin-bottom:10px;font-size:12px">
        <div style="font-weight:700;color:var(--ok);margin-bottom:6px">✓ TAG Valid</div>
        <div style="display:flex;justify-content:space-between"><span style="color:var(--txt-muted)">TAG</span><strong style="font-family:monospace">${tagId}</strong></div>
        <div style="display:flex;justify-content:space-between"><span style="color:var(--txt-muted)">Part</span><strong>${card.partName}</strong></div>
        <div style="display:flex;justify-content:space-between"><span style="color:var(--txt-muted)">Next Op</span><strong>${opName}</strong></div>
        <div style="display:flex;justify-content:space-between"><span style="color:var(--txt-muted)">Qty on TAG</span><strong>${card.currentQty} pcs</strong></div>
        ${card.heatCode ? `<div style="display:flex;justify-content:space-between"><span style="color:var(--txt-muted)">Heat Code</span><strong style="color:var(--ok)">🔥 ${card.heatCode}</strong></div>` : ''}
      </div>`;

    const runForm = document.getElementById('run-form');
    if (runForm) runForm.style.display = 'block';

  } catch (e) {
    if (infoDiv) infoDiv.innerHTML = `<div class="ibox" style="background:#fef2f2;border-color:var(--err,#dc2626);color:var(--err,#dc2626)">Error: ${e.message}</div>`;
  }
}

function confirmAddRun() {
  if (!_runCard) { toast('Load a TAG first'); return; }
  const processed = parseInt(document.getElementById('run-processed')?.value) || 0;
  const rejected  = parseInt(document.getElementById('run-rejected')?.value) || 0;
  if (!processed || processed < 1) { toast('Enter processed quantity'); return; }

  const machId = _runMachId;
  if (!_machineData[machId]) _machineData[machId] = { used: true, idleReason: '', operatorId: '', operatorName: '', runs: [], downtime: [] };
  _machineData[machId].used = true;

  const tagId = (document.getElementById('run-tag-input')?.value || '').trim().toUpperCase();
  _machineData[machId].runs.push({
    tagId,
    partId:        _runCard.partId,
    partName:      _runCard.partName,
    partNo:        _runCard.partNo,
    opId:          _runCard.nextOp?.opId || '',
    opName:        (S.operations || []).find(o => o.id === _runCard.nextOp?.opId)?.name || '',
    cycleTimeSecs: _runCard.cycleTimeSecs || 0,
    processed,
    rejected,
  });

  closeModal();
  triggerAutoSave();
  renderMachineDetail();
  toast(`Run added: ${processed} pcs ✓`);
}

/* — Add Downtime Modal — */
function openAddDowntimeModal(machId) {
  openModal(`
    <div class="mtit"><i class="ti ti-clock-pause"></i> Log Downtime</div>
    <div class="row-2">
      <div class="f"><label>Start Time *</label><input type="time" id="dt-start"></div>
      <div class="f"><label>End Time *</label><input type="time" id="dt-end"></div>
    </div>
    <div class="f">
      <label>Type</label>
      <select id="dt-type">
        <option value="Mechanical">Mechanical</option>
        <option value="Electrical">Electrical</option>
        <option value="Setup">Setup / Changeover</option>
        <option value="Material">Material Shortage</option>
        <option value="Quality">Quality Hold</option>
        <option value="Other">Other</option>
      </select>
    </div>
    <div class="f"><label>Description</label><input type="text" id="dt-desc" placeholder="Brief description of issue"></div>
    <div style="display:flex;gap:8px;margin-top:12px">
      <button class="btn btn-p" style="flex:1" onclick="confirmAddDowntime('${machId}')">Add ✓</button>
      <button class="btn btn-s" style="flex:1" onclick="closeModal()">Cancel</button>
    </div>
  `);
}

function confirmAddDowntime(machId) {
  const start = document.getElementById('dt-start')?.value;
  const end   = document.getElementById('dt-end')?.value;
  const type  = document.getElementById('dt-type')?.value || 'Other';
  const desc  = document.getElementById('dt-desc')?.value.trim() || '';

  if (!start || !end) { toast('Enter start and end time'); return; }

  const [sh, sm] = start.split(':').map(Number);
  const [eh, em] = end.split(':').map(Number);
  let mins = (eh * 60 + em) - (sh * 60 + sm);
  if (mins < 0) mins += 24 * 60;
  if (mins <= 0) { toast('End time must be after start time'); return; }

  if (!_machineData[machId]) _machineData[machId] = { used: true, idleReason: '', idleReasonOther: '', operatorId: '', operatorName: '', runs: [], downtime: [] };
  _machineData[machId].downtime.push({ startTime: start, endTime: end, mins, type, description: desc });

  closeModal();
  triggerAutoSave();
  renderMachineDetail();
}

/* — Finalize Shift — */
async function finalizeShift() {
  if (!_actShift) { toast('Select a shift'); return; }
  if (!_actSupervisor) {
    _actSupervisor = document.getElementById('act-sup')?.value || '';
  }
  if (!_actSupervisor) { toast('Select a supervisor'); return; }

  const machines = (S.machines || []).filter(m => m.stage === _actStage && m.active !== false);
  const machineEntries = machines.map(m => {
    const md = _machineData[m.id] || { used: false, idleReason: '', operatorId: '', operatorName: '', runs: [], downtime: [] };
    const totalProcessed = (md.runs || []).reduce((s, r) => s + (+r.processed || 0), 0);
    const totalRejected  = (md.runs || []).reduce((s, r) => s + (+r.rejected  || 0), 0);
    const totalDtMins    = (md.downtime || []).reduce((s, d) => s + (+d.mins || 0), 0);

    // Look up setup minutes for this machine in this shift
    const setupDoc = (S.setupApprovals || []).find(
      sa => sa.machineId === m.id && sa.date === _actDate && sa.shift === _actShift && sa.status === 'approved'
    );
    const setupMins = setupDoc?.setupMins || 0;

    // OEE per machine (weighted by run cycle times)
    let oee = 0;
    if (md.used && totalProcessed > 0) {
      const totalValueTime = (md.runs || []).reduce((s, r) => s + (+r.processed || 0) * (+r.cycleTimeSecs || 0), 0);
      const availSecs = Math.max(1, (450 - setupMins - totalDtMins) * 60);
      oee = Math.min(100, Math.round((totalValueTime / availSecs) * 100));
    }

    return {
      machineId: m.id, machineName: m.name,
      used: md.used,
      idleReason: md.idleReason || '',
      operatorId: md.operatorId || '',
      operatorName: md.operatorName || (S.users || []).find(u => u.id === md.operatorId)?.name || '',
      runs:     md.runs     || [],
      downtime: md.downtime || [],
      totalProcessed, totalRejected, totalDtMins, setupMins, oee,
    };
  });

  const totalProcessed   = machineEntries.reduce((s, me) => s + me.totalProcessed, 0);
  const machinesUsed     = machineEntries.filter(me => me.used).length;
  const usedEntries      = machineEntries.filter(me => me.used && me.oee > 0);
  const avgOEE           = usedEntries.length ? Math.round(usedEntries.reduce((s, me) => s + me.oee, 0) / usedEntries.length) : 0;

  const supUser = (S.users || []).find(u => u.id === _actSupervisor);

  try {
    const batch = db.batch();
    const ref   = db.collection('actuals').doc();
    batch.set(ref, {
      stage:           _actStage,
      date:            _actDate,
      shift:           _actShift,
      supervisorId:    _actSupervisor,
      supervisorName:  supUser?.name || '',
      machines:        machineEntries,
      totalProcessed,
      machinesUsed,
      avgOEE,
      submittedBy:     S.sess.userId,
      submittedByName: S.sess.name,
      createdAt:       serverTS(),
    });

    // Delete drafts for this stage/date/shift
    const draftKey = `${_actDate}_${_actShift}_${_actStage}`;
    S.prodDrafts
      .filter(d => d.draftKey === draftKey && d.userId === S.sess.userId)
      .forEach(d => batch.delete(db.collection('prodDrafts').doc(d.id)));

    // Determine per-TAG final status based on whether finalOperation was completed.
    // If any run on a TAG has finalOperation:true → soft_done / hard_done.
    // Otherwise → soft_wip / hard_wip (still in-progress).
    const tagFinalStatus  = {}; // tagId → newStatus string
    const tagHistEntries  = {}; // tagId → array of histEntry objects

    machineEntries.forEach(me => {
      (me.runs || []).forEach(r => {
        if (!r.tagId) return;
        const partOp = (S.partOps || []).find(po => po.partId === r.partId && po.opId === r.opId);
        const isFinal = partOp?.finalOperation === true;
        const proposed = isFinal
          ? (_actStage === 'soft' ? 'soft_done' : 'hard_done')
          : (_actStage === 'soft' ? 'soft_wip'  : 'hard_wip');
        // Upgrade status to 'done' if any op for this TAG is the final op
        if (!tagFinalStatus[r.tagId] || isFinal) tagFinalStatus[r.tagId] = proposed;

        if (!tagHistEntries[r.tagId]) tagHistEntries[r.tagId] = [];
        tagHistEntries[r.tagId].push({
          stage:       _actStage,
          opId:        r.opId,
          opName:      r.opName,
          machineId:   me.machineId,
          machineName: me.machineName,
          processed:   r.processed,
          rejected:    r.rejected,
          date:        _actDate,
          shift:       _actShift,
          loggedBy:    S.sess.userId,
          loggedAt:    new Date().toISOString(),
        });
      });
    });

    Object.entries(tagFinalStatus).forEach(([tagId, newStatus]) => {
      const rcRef = db.collection('routeCards').doc(tagId);
      (tagHistEntries[tagId] || []).forEach(h => {
        batch.update(rcRef, { opHistory: firebase.firestore.FieldValue.arrayUnion(h) });
      });
      batch.update(rcRef, { status: newStatus, updatedAt: serverTS() });
    });

    await batch.commit();

    S.actuals.unshift({ id: ref.id, stage: _actStage, date: _actDate, shift: _actShift, totalProcessed, machinesUsed, avgOEE });
    S.prodDrafts = S.prodDrafts.filter(d => !(d.draftKey === draftKey && d.userId === S.sess.userId));

    await logAudit('finalize_shift', 'production', ref.id, null, { stage: _actStage, date: _actDate, shift: _actShift });
    toast(`Shift finalized ✓ — ${totalProcessed} pcs across ${machinesUsed} machines`);
    _machineData = {};
    _activeView = 'tabs';
    _activeTab  = 'reports';
    render();
  } catch (e) { toast('Error finalizing: ' + e.message); }
}

function backToHub() {
  _activeView = 'tabs';
  _activeTab  = 'hub';
  _machineData = {};
  _planData   = {};
  render();
}

/* ══════════════════════════════════════════════════════════════════════
   PLAN ENTRY
   ══════════════════════════════════════════════════════════════════════ */
function enterPlanStage(stage) {
  _planStage  = stage;
  _activeView = 'plan';
  _planData   = {};

  // Load existing plan drafts
  const today = dateStr();
  (S.planDrafts || [])
    .filter(d => d.stage === _planStage && d.date === _planDate && d.userId === S.sess.userId)
    .forEach(d => { _planData[d.machineId] = d.planData; });

  renderPlanEntry();
}

function renderPlanEntry() {
  const machines = (S.machines || [])
    .filter(m => m.stage === _planStage && m.active !== false)
    .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));

  const stageLabel = _planStage === 'soft' ? 'Soft Stage' : 'Hard Stage';
  const stageColor = _planStage === 'soft' ? 'var(--acc)' : '#7c3aed';

  const machCardsHtml = machines.map(m => {
    const pd = _planData[m.id] || { partId: '', partName: '', plannedQty: '', notes: '' };
    return `
      <div class="card" style="margin-bottom:10px">
        <div style="font-weight:700;margin-bottom:10px">${m.name} <span style="font-size:11px;font-weight:400;color:var(--txt-muted)">${m.code || ''}</span></div>
        <div class="f">
          <label>Part to Run</label>
          <input type="text" id="plan-part-${m.id}" placeholder="Type to search part..."
            value="${pd.partName || ''}"
            oninput="planPartSearch(this,'${m.id}')"
            onblur="setTimeout(hidePartDrop,150)"
            autocomplete="off">
          <input type="hidden" id="plan-pid-${m.id}" value="${pd.partId || ''}">
        </div>
        <div class="row-2">
          <div class="f">
            <label>Planned Qty (pcs)</label>
            <input type="number" id="plan-qty-${m.id}" min="1" placeholder="0" value="${pd.plannedQty || ''}">
          </div>
          <div class="f">
            <label>Notes</label>
            <input type="text" id="plan-notes-${m.id}" placeholder="Optional" value="${pd.notes || ''}">
          </div>
        </div>
        <button class="btn btn-s btn-sm mt8" onclick="savePlanDraft('${m.id}')">
          <i class="ti ti-device-floppy"></i> Save Draft
        </button>
      </div>`;
  }).join('');

  document.getElementById('page-content').innerHTML = `
    <div style="padding-bottom:80px">
      <div style="display:flex;align-items:center;gap:12px;padding:12px 0 8px;border-bottom:1px solid var(--bdr);margin-bottom:12px">
        <button class="btn btn-s btn-sm" onclick="backToHub()" style="flex-shrink:0">
          <i class="ti ti-arrow-left"></i> Back
        </button>
        <div style="flex:1">
          <div style="font-weight:800;font-size:15px;color:${stageColor}">${stageLabel} — Plan Entry</div>
          <div style="font-size:11px;color:var(--txt-muted)">Day plan for each machine</div>
        </div>
      </div>

      <div class="card" style="margin-bottom:12px">
        <div class="row-2">
          <div class="f">
            <label>Plan Date</label>
            <input type="date" id="plan-date" value="${_planDate}" onchange="_planDate=this.value">
          </div>
        </div>
      </div>

      <div class="card-hd">Machine Plan (${machines.length} machines)</div>
      ${machines.length ? machCardsHtml : emptyState('ti-tool', 'No Machines', `No active machines for ${stageLabel}.`)}

      ${machines.length ? `<button class="btn btn-p" style="width:100%;margin-top:12px" onclick="submitPlanEntry()"><i class="ti ti-check"></i> Submit Plan</button>` : ''}
    </div>`;
}

function planPartSearch(inp, machId) {
  showPartDrop(inp, p => {
    document.getElementById(`plan-pid-${machId}`).value = p.id;
    inp.value = p.name;
    if (!_planData[machId]) _planData[machId] = {};
    _planData[machId].partId   = p.id;
    _planData[machId].partName = p.name;
    _planData[machId].partNo   = p.no;
  });
}

async function savePlanDraft(machId) {
  const partId   = document.getElementById(`plan-pid-${machId}`)?.value || '';
  const partName = document.getElementById(`plan-part-${machId}`)?.value.trim() || '';
  const qty      = parseInt(document.getElementById(`plan-qty-${machId}`)?.value) || 0;
  const notes    = document.getElementById(`plan-notes-${machId}`)?.value.trim() || '';

  const planDate = document.getElementById('plan-date')?.value || _planDate;

  const docId = `${S.sess.userId}_${planDate}_${_planStage}_${machId}`;
  const planData = { partId, partName, plannedQty: qty, notes };
  _planData[machId] = planData;

  try {
    await db.collection('planDrafts').doc(docId).set({
      userId: S.sess.userId, machineId: machId, stage: _planStage, date: planDate,
      planData, updatedAt: serverTS(),
    }, { merge: true });
    toast('Draft saved ✓');
  } catch (e) { toast('Draft save failed: ' + e.message); }
}

async function submitPlanEntry() {
  const planDate = document.getElementById('plan-date')?.value || _planDate;
  const machines = (S.machines || []).filter(m => m.stage === _planStage && m.active !== false);

  // Collect all plan data from inputs
  const entries = machines.map(m => {
    const partId   = document.getElementById(`plan-pid-${m.id}`)?.value || (_planData[m.id]?.partId || '');
    const partName = document.getElementById(`plan-part-${m.id}`)?.value.trim() || (_planData[m.id]?.partName || '');
    const qty      = parseInt(document.getElementById(`plan-qty-${m.id}`)?.value) || (_planData[m.id]?.plannedQty || 0);
    const notes    = document.getElementById(`plan-notes-${m.id}`)?.value.trim() || (_planData[m.id]?.notes || '');
    const mach     = (S.machines || []).find(x => x.id === m.id);
    return { machineId: m.id, machineName: mach?.name || m.id, partId, partName, plannedQty: qty, notes };
  }).filter(e => e.partId && e.plannedQty > 0);

  if (!entries.length) { toast('Add at least one machine plan before submitting'); return; }

  try {
    const batch = db.batch();
    const ref   = db.collection('plans').doc();
    batch.set(ref, {
      stage: _planStage, date: planDate,
      entries, totalPlanned: entries.reduce((s, e) => s + e.plannedQty, 0),
      submittedBy: S.sess.userId, submittedByName: S.sess.name,
      createdAt: serverTS(),
    });

    // Delete draft docs for this plan
    const docIdsToDelete = machines.map(m => `${S.sess.userId}_${planDate}_${_planStage}_${m.id}`);
    docIdsToDelete.forEach(id => batch.delete(db.collection('planDrafts').doc(id)));

    await batch.commit();
    toast(`Plan submitted for ${entries.length} machines ✓`);
    _planData   = {};
    _activeView = 'tabs';
    _activeTab  = 'plans';
    render();
  } catch (e) { toast('Error submitting plan: ' + e.message); }
}

/* ══════════════════════════════════════════════════════════════════════
   SETUP TAB
   ══════════════════════════════════════════════════════════════════════ */
function buildSetupHtml() {
  const softCount = (S.machines || []).filter(m => m.stage === 'soft' && m.active !== false).length;
  const hardCount = (S.machines || []).filter(m => m.stage === 'hard' && m.active !== false).length;

  const shiftOpts = Object.entries(S.shifts || { A: { label: 'Shift A' }, B: { label: 'Shift B' }, C: { label: 'Shift C' } })
    .map(([k, v]) => `<option value="${k}">${v.label || k}</option>`).join('');

  return `
    <div style="padding-bottom:20px">
      <div class="card" style="margin-top:8px">
        <div class="card-hd">Machine &amp; Shift</div>
        <div class="f">
          <label>Machine *</label>
          <select id="setup-mach" onchange="onSetupMachChange(this.value)">
            <option value="">— Select Stage —</option>
            <option value="_STAGE_soft">▸ Soft Stage (${softCount} machines)</option>
            <option value="_STAGE_hard">▸ Hard Stage (${hardCount} machines)</option>
          </select>
        </div>
        <div class="row-2">
          <div class="f"><label>Date</label><input id="setup-date" type="date" value="${dateStr()}"></div>
          <div class="f"><label>Shift</label><select id="setup-shift">${shiftOpts}</select></div>
        </div>
        <div class="f">
          <label>Operator</label>
          <select id="setup-operator" disabled>
            <option value="">— Select machine first —</option>
          </select>
        </div>
      </div>

      <div class="card">
        <div class="card-hd"><i class="ti ti-qrcode"></i> Scan Route Card TAG</div>
        <div style="display:flex;gap:8px;margin-bottom:10px">
          <input id="setup-tag-input" type="text" placeholder="e.g. TAG042"
            oninput="this.value=this.value.toUpperCase()"
            autocomplete="off" spellcheck="false" style="flex:1"
            onkeydown="if(event.key==='Enter')setupFetchTag()">
          <button class="btn btn-s qr-scan-btn" title="Scan QR"
            onclick="openQrScanner(v=>{document.getElementById('setup-tag-input').value=v.toUpperCase();setupFetchTag();},'Scan TAG')">
            <i class="ti ti-camera"></i>
          </button>
        </div>
        <button class="btn btn-s" style="width:100%" onclick="setupFetchTag()">Load TAG →</button>
      </div>

      <div id="setup-tag-info"></div>
      <div id="setup-form" style="display:none"></div>
    </div>`;
}

function onSetupMachChange(val) {
  const sel = document.getElementById('setup-mach');
  if (!sel) return;

  if (val === '_STAGE_soft' || val === '_STAGE_hard') {
    const stage = val === '_STAGE_soft' ? 'soft' : 'hard';
    _setupStage = stage;
    const machines = (S.machines || [])
      .filter(m => m.stage === stage && m.active !== false)
      .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
    sel.innerHTML =
      `<option value="_BACK">← Back to stage select</option>` +
      `<option value="">— Select Machine —</option>` +
      machines.map(m => `<option value="${m.id}|${m.name}|${m.stage}">${m.name}</option>`).join('');
    sel.value = '';
    updateSetupOperatorDropdown(stage);
    return;
  }

  if (val === '_BACK') {
    const softCount = (S.machines || []).filter(m => m.stage === 'soft' && m.active !== false).length;
    const hardCount = (S.machines || []).filter(m => m.stage === 'hard' && m.active !== false).length;
    sel.innerHTML =
      `<option value="">— Select Stage —</option>` +
      `<option value="_STAGE_soft">▸ Soft Stage (${softCount} machines)</option>` +
      `<option value="_STAGE_hard">▸ Hard Stage (${hardCount} machines)</option>`;
    sel.value = '';
    _setupStage = '';
    const opSel = document.getElementById('setup-operator');
    if (opSel) { opSel.innerHTML = '<option value="">— Select machine first —</option>'; opSel.disabled = true; }
    return;
  }

  if (val && val.includes('|')) {
    const parts = val.split('|');
    _setupStage = parts[2] || _setupStage;
    updateSetupOperatorDropdown(_setupStage);
  }
}

function updateSetupOperatorDropdown(stage) {
  const sel = document.getElementById('setup-operator');
  if (!sel) return;
  const operators = (S.users || [])
    .filter(u => (u.role === 'operator' || !u.appUser) &&
      (!u.stage || u.stage === stage || u.stage === 'general'));
  sel.disabled = false;
  sel.innerHTML = `<option value="">— Select Operator —</option>` +
    operators.map(u => `<option value="${u.id}">${u.name}</option>`).join('');
}

async function setupFetchTag() {
  const tagId = (document.getElementById('setup-tag-input')?.value || '').trim().toUpperCase();
  if (!tagId) { toast('Enter or scan a TAG'); return; }
  if (!tagId.match(/^TAG\d+$/)) { toast('Invalid TAG format (e.g. TAG042)'); return; }

  const infoDiv = document.getElementById('setup-tag-info');
  const formDiv = document.getElementById('setup-form');
  if (infoDiv) infoDiv.innerHTML = `<div style="text-align:center;padding:12px;font-size:13px;color:var(--txt-muted)">Loading...</div>`;
  if (formDiv) formDiv.style.display = 'none';

  try {
    const card = await fetchRouteCard(tagId);
    if (!card) {
      if (infoDiv) infoDiv.innerHTML = `<div class="ibox" style="background:#fef2f2;border-color:var(--err,#dc2626);color:var(--err,#dc2626)">TAG ${tagId} not found</div>`;
      return;
    }

    const validStatuses = ['store_issued','soft_wip','soft_done','ht_done','hard_wip'];
    if (!validStatuses.includes(card.status)) {
      if (infoDiv) infoDiv.innerHTML = `<div class="ibox" style="background:#fef2f2;border-color:var(--err,#dc2626);color:var(--err,#dc2626)">TAG status is "${card.status}" — expected: store_issued / soft_done / ht_done</div>`;
      return;
    }

    _setupCard  = card;
    _setupTagId = tagId;

    if (!_setupStage) {
      _setupStage = (card.status === 'ht_done' || card.status === 'hard_wip') ? 'hard' : 'soft';
    }

    // Hard stage: heatCode required
    if (_setupStage === 'hard' && !card.heatCode) {
      if (infoDiv) infoDiv.innerHTML = `<div class="ibox" style="background:#fef2f2;border-color:var(--err,#dc2626);color:var(--err,#dc2626)">Hard stage setup requires a heat code. This TAG has not cleared Heat Treatment.</div>`;
      return;
    }

    const partOpsForStage = (S.partOps || [])
      .filter(po => po.partId === card.partId && po.stage === _setupStage)
      .sort((a, b) => (a.seqNo || 0) - (b.seqNo || 0));
    const completedOpIds = (card.opHistory || []).filter(h => h.stage === _setupStage).map(h => h.opId);
    const nextOp = partOpsForStage.find(po => !completedOpIds.includes(po.opId));

    // Sequence deviation check
    let seqWarningHtml = '';
    if (nextOp && partOpsForStage.length > 1) {
      const nextIdx = partOpsForStage.findIndex(po => po.opId === nextOp.opId);
      if (nextIdx > 0) {
        const prevRequired = partOpsForStage[nextIdx - 1];
        if (!completedOpIds.includes(prevRequired.opId)) {
          const prevOpName = (S.operations || []).find(o => o.id === prevRequired.opId)?.name || 'Previous Op';
          seqWarningHtml = `
            <div style="background:#fff7ed;border:1.5px solid #f97316;border-radius:var(--rs);padding:10px 12px;margin-bottom:10px">
              <div style="font-weight:700;color:#ea580c;font-size:13px">⚠ Sequence Deviation Detected</div>
              <div style="font-size:12px;color:#9a3412;margin-top:4px">
                Previous operation "<strong>${prevOpName}</strong>" (seq ${prevRequired.seqNo}) has no completion on this TAG.
              </div>
              <button class="btn btn-sm" style="margin-top:8px;width:100%;border-color:#f97316;color:#ea580c"
                onclick="showDeviationConfirmModal('${tagId}','${prevOpName.replace(/'/g,"\\'")}',${prevRequired.seqNo})">
                Request Sequence Deviation Approval
              </button>
            </div>`;
        }
      }
    }

    const opOpts = partOpsForStage.map(po => {
      const o = (S.operations || []).find(x => x.id === po.opId);
      return `<option value="${po.opId}" ${nextOp && nextOp.opId === po.opId ? 'selected' : ''}>${o ? o.name : '?'} (seq ${po.seqNo})</option>`;
    }).join('');

    if (infoDiv) infoDiv.innerHTML = `
      ${seqWarningHtml}
      <div style="background:#f0fdf4;border:1.5px solid #86efac;border-radius:var(--rs);padding:10px 12px;margin-bottom:4px;font-size:13px">
        <div style="font-weight:700;color:var(--ok);margin-bottom:6px">✓ TAG Valid</div>
        <div style="display:flex;justify-content:space-between;margin-bottom:2px"><span style="color:var(--txt-muted)">TAG</span><strong style="font-family:monospace;color:var(--acc)">${tagId}</strong></div>
        <div style="display:flex;justify-content:space-between;margin-bottom:2px"><span style="color:var(--txt-muted)">Part</span><strong>${card.partName}</strong></div>
        <div style="display:flex;justify-content:space-between;margin-bottom:2px"><span style="color:var(--txt-muted)">Part No.</span><span style="font-family:monospace">${card.partNo}</span></div>
        <div style="display:flex;justify-content:space-between;margin-bottom:2px"><span style="color:var(--txt-muted)">Customer</span><span>${card.customerName || '—'}</span></div>
        <div style="display:flex;justify-content:space-between;margin-bottom:2px"><span style="color:var(--txt-muted)">Batch</span><span style="font-family:monospace">${card.batchCode || '—'}</span></div>
        ${card.heatCode ? `<div style="display:flex;justify-content:space-between"><span style="color:var(--txt-muted)">Heat Code</span><strong style="color:var(--ok)">🔥 ${card.heatCode}</strong></div>` : ''}
        <div style="display:flex;justify-content:space-between"><span style="color:var(--txt-muted)">Qty on TAG</span><strong style="color:var(--acc)">${card.currentQty} pcs</strong></div>
      </div>`;

    if (formDiv) {
      formDiv.style.display = 'block';
      formDiv.innerHTML = `
        <div class="card">
          <div class="card-hd">Setup Details</div>
          <div class="f">
            <label>Operation *</label>
            <select id="setup-op-sel">${opOpts || `<option value="">No operations defined for this part/${_setupStage}</option>`}</select>
          </div>
          <div class="f">
            <label>Setup Time (minutes) *</label>
            <input id="setup-mins" type="number" min="1" max="999" placeholder="e.g. 45"
              style="font-size:20px;font-weight:700;text-align:center;letter-spacing:2px">
            <div style="font-size:11px;color:var(--txt-muted);margin-top:4px">Total changeover time in minutes</div>
          </div>
          <div class="f">
            <label>Remarks</label>
            <input id="setup-remarks" type="text" placeholder="Optional — tooling, issues...">
          </div>
          <button class="btn btn-p mt8" style="width:100%" onclick="submitSetupLog()">
            Submit Setup → QC Approval
          </button>
        </div>`;
    }
  } catch (e) {
    if (infoDiv) infoDiv.innerHTML = `<div class="ibox" style="background:#fef2f2;border-color:var(--err,#dc2626);color:var(--err,#dc2626)">Error: ${e.message}</div>`;
  }
}

/* — Sequence Deviation Confirm Modal — */
function showDeviationConfirmModal(tagId, missingOpName, missingSeqNo) {
  openModal(`
    <div style="text-align:center;margin-bottom:12px">
      <div style="width:56px;height:56px;border-radius:28px;background:#fff7ed;border:2px solid #f97316;display:inline-flex;align-items:center;justify-content:center;font-size:28px">⚠</div>
    </div>
    <div class="mtit" style="color:#ea580c">Log Sequence Deviation?</div>
    <p style="font-size:13px;color:var(--txt-muted);text-align:center;margin-bottom:12px">
      You are about to request a <strong>sequence deviation</strong> for:
    </p>
    <div style="background:#fff7ed;border:1px solid #f97316;border-radius:var(--rs);padding:10px 14px;margin-bottom:14px;font-size:13px">
      <div><strong>TAG:</strong> ${tagId}</div>
      <div style="margin-top:4px"><strong>Missing Operation:</strong> ${missingOpName} (seq ${missingSeqNo})</div>
    </div>
    <p style="font-size:12px;color:var(--txt-muted);text-align:center;margin-bottom:16px">
      This sends a request to the <strong>Plant Head</strong> for approval. Only proceed if this deviation is <strong>intentional and required</strong>.
    </p>
    <div style="display:flex;gap:10px">
      <button class="btn btn-s" style="flex:1" onclick="closeModal()">Cancel — Go Back</button>
      <button class="btn btn-p" style="flex:1;background:#ea580c;border-color:#ea580c" onclick="closeModal();confirmRequestDeviation('${tagId}','${missingOpName.replace(/'/g,"\\'")}',${missingSeqNo})">
        Yes, Log Deviation
      </button>
    </div>
  `);
}

async function confirmRequestDeviation(tagId, missingOpName, missingSeqNo) {
  try {
    await db.collection('setupDeviations').add({
      tagId, missingOpName, missingSeqNo,
      requestedBy:     S.sess.userId,
      requestedByName: S.sess.name,
      stage:           _setupStage,
      status:          'pending',
      date:            dateStr(),
      createdAt:       serverTS(),
    });
    toast('Deviation request sent to Plant Head ✓');
    await logAudit('seq_deviation_request', 'production', tagId, null, { missingOpName, missingSeqNo });
  } catch (e) { toast('Error sending request: ' + e.message); }
}

async function submitSetupLog() {
  if (!_setupCard || !_setupTagId) { toast('Load a TAG first'); return; }

  const machVal = document.getElementById('setup-mach')?.value || '';
  if (!machVal) { toast('Select a machine'); return; }
  const [machId, machName, machStage] = machVal.split('|');

  const opId = document.getElementById('setup-op-sel')?.value;
  if (!opId) { toast('Select an operation'); return; }
  const mins = parseInt(document.getElementById('setup-mins')?.value) || 0;
  if (!mins || mins < 1) { toast('Enter setup time in minutes'); return; }

  const date     = document.getElementById('setup-date')?.value || dateStr();
  const shift    = document.getElementById('setup-shift')?.value;
  const opId_val = opId;
  const opName   = (S.operations || []).find(o => o.id === opId_val)?.name || '';
  const operId   = document.getElementById('setup-operator')?.value || '';
  const operName = (S.users || []).find(u => u.id === operId)?.name || '';
  const remarks  = document.getElementById('setup-remarks')?.value.trim() || '';
  const resolvedStage = machStage || _setupStage;

  // Check for existing pending/approved setup
  const existing = (S.setupApprovals || []).find(sa =>
    sa.tagId === _setupTagId && sa.machineId === machId &&
    sa.stage === resolvedStage && (sa.status === 'pending' || sa.status === 'approved')
  );
  if (existing) {
    toast(existing.status === 'approved'
      ? 'Setup already approved for this TAG on this machine ✓'
      : 'A pending setup approval already exists for this TAG');
    _setupCard = null; _setupTagId = ''; _setupStage = '';
    switchTab('setup');
    return;
  }

  const btn = document.querySelector('#setup-form .btn-p');
  if (btn) { btn.disabled = true; btn.textContent = 'Submitting...'; }

  try {
    const ref = await db.collection('setupApprovals').add({
      tagId:           _setupTagId,
      partId:          _setupCard.partId,
      partNo:          _setupCard.partNo,
      partName:        _setupCard.partName,
      customerName:    _setupCard.customerName || '',
      batchCode:       _setupCard.batchCode || '',
      heatCode:        _setupCard.heatCode || '',
      opId:            opId_val, opName,
      machineId:       machId,
      machineName:     machName || '',
      stage:           resolvedStage,
      setupMins:       mins,
      operatorId:      operId, operatorName: operName,
      shift, date, remarks,
      status:          'pending',
      requestedBy:     S.sess.userId,
      requestedByName: S.sess.name,
      createdAt:       serverTS(),
    });

    S.setupApprovals.unshift({ id: ref.id, tagId: _setupTagId, machineId: machId, stage: resolvedStage, status: 'pending' });
    toast('Setup logged ✓ — sent to QC for approval');
    await logAudit('setup_log', 'production', _setupTagId, null, { machineId: machId, opId: opId_val, mins });
    _setupCard = null; _setupTagId = ''; _setupStage = '';
    switchTab('hub');
  } catch (e) {
    toast('Error: ' + e.message);
    if (btn) { btn.disabled = false; btn.textContent = 'Submit Setup → QC Approval'; }
  }
}

/* ══════════════════════════════════════════════════════════════════════
   BREAKDOWNS TAB
   ══════════════════════════════════════════════════════════════════════ */
function buildBreakdownHtml() {
  const active = (S.breakdowns || []).filter(b => b.status === 'open' || b.status === 'acknowledged')
    .sort((a, b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0));
  const recent = (S.breakdowns || []).filter(b => b.status === 'resolved')
    .sort((a, b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0))
    .slice(0, 10);

  const activeHtml = active.length
    ? active.map(b => breakdownCard(b)).join('')
    : `<div class="ibox" style="background:#f0fdf4;border-color:#86efac;color:#15803d;text-align:center">✓ No active breakdowns</div>`;

  const recentHtml = recent.length
    ? recent.map(b => breakdownCard(b)).join('')
    : '';

  return `
    <div style="padding-bottom:20px">
      <button class="btn btn-p" style="width:100%;margin:10px 0" onclick="openLogBreakdownModal()">
        <i class="ti ti-alert-triangle"></i> Log New Breakdown
      </button>

      ${sectionHeader('Active Breakdowns', `${active.length} open`)}
      ${activeHtml}

      ${recentHtml ? sectionHeader('Recently Resolved') + recentHtml : ''}
    </div>`;
}

function breakdownCard(b) {
  const mach = (S.machines || []).find(m => m.id === b.machineId);
  const statusColor = b.status === 'open' ? 'var(--err,#dc2626)' : b.status === 'acknowledged' ? '#f59e0b' : 'var(--ok)';
  return `
    <div class="card" style="margin-bottom:10px;border-left:4px solid ${statusColor}">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:6px">
        <div>
          <div style="font-weight:700">${b.machineName || (mach?.name || b.machineId)}</div>
          <div style="font-size:11px;color:var(--txt-muted)">${b.date || ''} · ${b.shift ? 'Shift ' + b.shift : ''} · ${b.breakdownTime || ''}</div>
        </div>
        ${stBadge(b.status)}
      </div>
      <div style="font-size:12px;margin-bottom:4px">${b.description || ''}</div>
      ${b.faultCategory ? `<div style="font-size:11px;color:var(--txt-muted)">Fault: ${b.faultCategory}</div>` : ''}
      <div style="font-size:11px;color:var(--txt-muted);margin-top:4px">Reported by ${b.reportedByName || '—'} · ${fmtTS(b.createdAt)}</div>
    </div>`;
}

function openLogBreakdownModal() {
  const allMachines = (S.machines || []).filter(m => m.active !== false)
    .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));

  const machOpts = [
    ...allMachines.filter(m => m.stage === 'soft').map(m => `<option value="${m.id}|${m.name}">Soft: ${m.name}</option>`),
    ...allMachines.filter(m => m.stage === 'hard').map(m => `<option value="${m.id}|${m.name}">Hard: ${m.name}</option>`),
    ...allMachines.filter(m => m.stage !== 'soft' && m.stage !== 'hard').map(m => `<option value="${m.id}|${m.name}">${m.name}</option>`),
  ].join('');

  const shiftOpts = Object.entries(S.shifts || { A: { label: 'Shift A' }, B: { label: 'Shift B' }, C: { label: 'Shift C' } })
    .map(([k, v]) => `<option value="${k}">${v.label || k}</option>`).join('');

  const hr = new Date().getHours();
  const now = new Date();
  const timeStr = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
  const defaultShift = hr >= 6 && hr < 14 ? 'A' : hr >= 14 && hr < 22 ? 'B' : 'C';

  openModal(`
    <div class="mtit"><i class="ti ti-alert-triangle"></i> Log Breakdown</div>
    <div class="f"><label>Machine *</label>
      <select id="bd-mach">
        <option value="">— Select Machine —</option>
        ${machOpts}
      </select>
    </div>
    <div class="row-2">
      <div class="f"><label>Date</label><input type="date" id="bd-date" value="${dateStr()}"></div>
      <div class="f"><label>Shift</label><select id="bd-shift">${shiftOpts.replace(`value="${defaultShift}"`, `value="${defaultShift}" selected`)}</select></div>
    </div>
    <div class="f"><label>Breakdown Time</label><input type="time" id="bd-time" value="${timeStr}"></div>
    <div class="f"><label>Description *</label><textarea id="bd-desc" rows="3" placeholder="Describe the issue in brief..." style="resize:vertical"></textarea></div>
    <div style="display:flex;gap:8px;margin-top:12px">
      <button class="btn btn-p" style="flex:1" onclick="submitBreakdown()">Submit</button>
      <button class="btn btn-s" style="flex:1" onclick="closeModal()">Cancel</button>
    </div>
  `);
}

async function submitBreakdown() {
  const machVal = document.getElementById('bd-mach')?.value || '';
  if (!machVal) { toast('Select a machine'); return; }
  const [machId, machName] = machVal.split('|');
  const date  = document.getElementById('bd-date')?.value || dateStr();
  const shift = document.getElementById('bd-shift')?.value || '';
  const time  = document.getElementById('bd-time')?.value || '';
  const desc  = document.getElementById('bd-desc')?.value.trim() || '';
  if (!desc) { toast('Enter a description'); return; }

  const btn = document.querySelector('#modal-content .btn-p');
  if (btn) { btn.disabled = true; btn.textContent = 'Submitting...'; }

  try {
    const batch = db.batch();
    const bdRef = db.collection('breakdowns').doc();
    batch.set(bdRef, {
      machineId: machId, machineName: machName,
      date, shift, breakdownTime: time,
      breakdownTimestamp: serverTS(),
      description:        desc,
      reportedBy:         S.sess.userId,
      reportedByName:     S.sess.name,
      status:             'open',
      acknowledgedBy:     '', acknowledgedAt: null,
      faultCategory:      '', faultDescription: '',
      upTime:             null, upTimestamp: null,
      fixDescription:     '', totalDowntimeMins: 0,
      spares:             [], sparesApproved: false,
      createdAt:          serverTS(),
    });

    batch.set(db.collection('machineStatus').doc(machId), {
      status:            'pending_breakdown',
      activeBreakdownId: bdRef.id,
      updatedAt:         serverTS(),
    }, { merge: true });

    await batch.commit();

    S.breakdowns.unshift({ id: bdRef.id, machineId: machId, machineName: machName, date, shift, description: desc, status: 'open' });
    const msIdx = (S.machineStatus || []).findIndex(m => m.id === machId);
    const entry = { id: machId, status: 'pending_breakdown', activeBreakdownId: bdRef.id };
    if (msIdx >= 0) S.machineStatus[msIdx] = entry; else S.machineStatus.push(entry);

    await logAudit('breakdown_log', 'production', bdRef.id, null, { machineId, desc });
    closeModal();
    toast('Breakdown logged ✓');
    switchTab('breakdown');
  } catch (e) {
    toast('Error: ' + e.message);
    if (btn) { btn.disabled = false; btn.textContent = 'Submit'; }
  }
}

/* ══════════════════════════════════════════════════════════════════════
   REQUISITIONS TAB
   ══════════════════════════════════════════════════════════════════════ */
function buildReqsHtml() {
  const myReqs = (S.requisitions || [])
    .filter(r => r.department === 'production' || r.requestedBy === S.sess.userId)
    .sort((a, b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0));

  const statusBadgeMap = { pending:'bdg-a', approved:'bdg-g', rejected:'bdg-r', partial:'bdg-b', fulfilled:'bdg-g' };
  const statusLabelMap = { pending:'Pending', approved:'Approved', rejected:'Rejected', partial:'Partial', fulfilled:'Fulfilled' };

  const listHtml = myReqs.length
    ? myReqs.map(r => `
        <div class="card" style="margin-bottom:10px" onclick="viewReqModal('${r.id}')">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:6px">
            <div>
              <div style="font-weight:700">${r.reqNo || '—'}</div>
              <div style="font-size:11px;color:var(--txt-muted)">${r.date || ''}${r.neededBy ? ' · Needed by ' + r.neededBy : ''}</div>
            </div>
            <span class="bdg ${statusBadgeMap[r.status] || 'bdg-gr'}">${statusLabelMap[r.status] || r.status}</span>
          </div>
          <div style="font-size:12px;color:var(--txt-muted);margin-bottom:6px">By ${r.requestedByName || '—'}</div>
          ${(r.lines || []).map(l => `
            <div style="display:flex;justify-content:space-between;font-size:12px;padding:3px 0">
              <span style="font-weight:600">${l.partName}</span>
              <span style="font-weight:700;color:var(--acc)">${l.qtyRequested} pcs</span>
            </div>`).join('')}
          ${r.status === 'pending' && r.requestedBy === S.sess.userId
            ? `<button class="btn btn-d btn-sm" style="margin-top:8px" onclick="event.stopPropagation();cancelReq('${r.id}')">Cancel</button>`
            : ''}
        </div>`).join('')
    : emptyState('ti-file-text', 'No Requisitions', 'Tap + New to create a material request.');

  return `
    <div style="padding-bottom:20px">
      <button class="btn btn-p" style="width:100%;margin:10px 0" onclick="openNewReqModal()">
        <i class="ti ti-plus"></i> New Requisition
      </button>
      ${listHtml}
    </div>`;
}

function genReqNo() {
  const now = new Date();
  const yymm = String(now.getFullYear()).slice(2) + String(now.getMonth() + 1).padStart(2, '0');
  const monthReqs = (S.requisitions || []).filter(r => (r.reqNo || '').includes('-' + yymm + '-')).length;
  return `REQ-${yymm}-${String(monthReqs + 1).padStart(3, '0')}`;
}

let _reqEditId = null;

function openNewReqModal(editId) {
  _reqEditId = editId || null;
  const req = editId ? (S.requisitions || []).find(r => r.id === editId) : null;
  _reqLines = req && req.lines ? req.lines.map(l => ({ ...l })) : [];
  const reqNo = req ? req.reqNo : genReqNo();

  openModal(`
    <div class="mtit">${req ? 'Edit Requisition' : 'New Requisition'} <span style="font-size:12px;font-weight:400;color:var(--txt-muted)">${reqNo}</span></div>
    <div class="row-2">
      <div class="f"><label>Date *</label><input type="date" id="rq-date" value="${req ? req.date : dateStr()}"></div>
      <div class="f"><label>Needed By</label><input type="date" id="rq-needby" value="${req ? (req.neededBy || '') : ''}"></div>
    </div>
    <div class="f"><label>Notes</label><input type="text" id="rq-notes" placeholder="Optional" value="${req ? (req.notes || '') : ''}"></div>

    <div style="display:flex;justify-content:space-between;align-items:center;margin:10px 0 6px">
      <div style="font-weight:700;font-size:13px">Material Lines</div>
      <button class="btn btn-s btn-sm" onclick="reqShowAddLine()">+ Add Part</button>
    </div>

    <div id="req-add-row" style="display:none;background:var(--bg);border:1px solid var(--bdr);border-radius:var(--rs);padding:10px;margin-bottom:10px">
      <div class="f" style="margin-bottom:8px">
        <label style="font-size:11px">Part *</label>
        <input id="rq-new-part" type="text" placeholder="Type to search part..."
          oninput="reqPartSearch(this)" onblur="setTimeout(hidePartDrop,150)" autocomplete="off">
        <input type="hidden" id="rq-new-pid">
        <input type="hidden" id="rq-new-pno">
        <input type="hidden" id="rq-new-cname">
      </div>
      <div class="row-2" style="margin-bottom:8px">
        <div class="f" style="margin:0"><label style="font-size:11px">Qty Required *</label><input id="rq-new-qty" type="number" min="1" placeholder="0"></div>
        <div class="f" style="margin:0"><label style="font-size:11px">Lot Code (opt.)</label><input id="rq-new-lot" type="text" placeholder="Optional"></div>
      </div>
      <div style="display:flex;gap:8px">
        <button class="btn btn-p btn-sm" style="flex:1" onclick="reqConfirmLine()">Add ✓</button>
        <button class="btn btn-s btn-sm" onclick="reqHideAddLine()">Cancel</button>
      </div>
    </div>

    <div id="req-lines-list" style="margin-bottom:10px"></div>

    <div style="display:flex;gap:8px;margin-top:4px">
      <button class="btn btn-p" style="flex:1" onclick="saveReq()">
        ${req ? 'Update' : 'Submit'} Requisition
      </button>
      <button class="btn btn-s" style="flex:1" onclick="closeModal()">Cancel</button>
    </div>
  `);
  reqRenderLines();
}

function reqShowAddLine() {
  const r = document.getElementById('req-add-row');
  if (r) { r.style.display = 'block'; setTimeout(() => document.getElementById('rq-new-part')?.focus(), 80); }
}
function reqHideAddLine() {
  const r = document.getElementById('req-add-row');
  if (r) r.style.display = 'none';
  ['rq-new-part','rq-new-pid','rq-new-pno','rq-new-cname','rq-new-qty','rq-new-lot']
    .forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
}

function reqPartSearch(inp) {
  showPartDrop(inp, p => {
    inp.value = p.name;
    document.getElementById('rq-new-pid').value  = p.id;
    document.getElementById('rq-new-pno').value  = p.no;
    document.getElementById('rq-new-cname').value = p.cust || '';
  });
}

function reqConfirmLine() {
  const name  = document.getElementById('rq-new-part')?.value.trim();
  const pid   = document.getElementById('rq-new-pid')?.value || '';
  const pno   = document.getElementById('rq-new-pno')?.value || '';
  const cname = document.getElementById('rq-new-cname')?.value || '';
  const qty   = parseInt(document.getElementById('rq-new-qty')?.value) || 0;
  const lot   = document.getElementById('rq-new-lot')?.value.trim() || '';
  if (!name || !pid) { toast('Search and select a part first'); return; }
  if (!qty || qty < 1) { toast('Enter a valid quantity'); return; }
  _reqLines.push({ lineNo: _reqLines.length + 1, partId: pid, partNo: pno, partName: name, customerName: cname, masterLotCode: lot, qtyRequested: qty, qtyApproved: 0, qtyIssued: 0 });
  reqHideAddLine();
  reqRenderLines();
}

function reqRenderLines() {
  const w = document.getElementById('req-lines-list');
  if (!w) return;
  if (!_reqLines.length) {
    w.innerHTML = `<div style="font-size:12px;color:var(--txt-muted);padding:8px;text-align:center;border:1px dashed var(--bdr);border-radius:6px">No parts added yet</div>`;
    return;
  }
  w.innerHTML = _reqLines.map((l, i) => `
    <div style="background:var(--bg);border-radius:6px;padding:10px 12px;margin-bottom:8px;border:.5px solid var(--bdr)">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px">
        <div style="flex:1">
          <div style="font-weight:700;font-size:13px">${l.partName}</div>
          <div style="font-family:monospace;font-size:11px;color:var(--txt-muted)">${l.partNo}${l.customerName ? ' · ' + l.customerName : ''}</div>
          ${l.masterLotCode ? `<div style="font-size:11px;color:var(--ok);margin-top:2px">${l.masterLotCode}</div>` : ''}
        </div>
        <div style="text-align:right;flex-shrink:0">
          <div style="font-size:16px;font-weight:800;color:var(--acc)">${l.qtyRequested}</div>
          <div style="font-size:10px;color:var(--txt-muted)">pcs</div>
        </div>
        <button onclick="_reqLines.splice(${i},1);reqRenderLines()" style="width:26px;height:26px;border-radius:6px;border:none;background:#fef2f2;color:var(--err,#dc2626);font-size:14px;cursor:pointer;flex-shrink:0;display:flex;align-items:center;justify-content:center">✕</button>
      </div>
    </div>`).join('');
}

async function saveReq() {
  if (!_reqLines.length) { toast('Add at least one part'); return; }
  const date     = document.getElementById('rq-date')?.value;
  const neededBy = document.getElementById('rq-needby')?.value || '';
  if (!date) { toast('Date required'); return; }
  const reqNo = _reqEditId ? (S.requisitions || []).find(r => r.id === _reqEditId)?.reqNo : genReqNo();
  const d = {
    reqNo, date, neededBy,
    notes:           document.getElementById('rq-notes')?.value.trim() || '',
    lines:           _reqLines,
    department:      'production',
    status:          'pending',
    requestedBy:     S.sess.userId,
    requestedByName: S.sess.name,
    approvedBy:      '', approvedByName: '', approvedAt: '', rejectionReason: '',
  };
  try {
    if (_reqEditId) {
      await db.collection('requisitions').doc(_reqEditId).update({ ...d, updatedAt: serverTS() });
      const idx = (S.requisitions || []).findIndex(r => r.id === _reqEditId);
      if (idx >= 0) S.requisitions[idx] = { id: _reqEditId, ...d };
    } else {
      const ref = await db.collection('requisitions').add({ ...d, createdAt: serverTS() });
      S.requisitions.unshift({ id: ref.id, ...d });
    }
    closeModal();
    toast(_reqEditId ? 'Requisition updated ✓' : 'Requisition submitted ✓');
    switchTab('reqs');
  } catch (e) { toast('Error: ' + e.message); }
}

function viewReqModal(id) {
  const r = (S.requisitions || []).find(x => x.id === id);
  if (!r) return;
  const statusBadgeMap = { pending:'bdg-a', approved:'bdg-g', rejected:'bdg-r', partial:'bdg-b', fulfilled:'bdg-g' };
  const statusLabelMap = { pending:'Pending Approval', approved:'Approved', rejected:'Rejected', partial:'Partially Issued', fulfilled:'Fulfilled' };
  let h = `
    <div class="mtit">${r.reqNo}</div>
    <div style="display:flex;gap:8px;align-items:center;margin-bottom:12px">
      <span class="bdg ${statusBadgeMap[r.status] || 'bdg-gr'}">${statusLabelMap[r.status] || r.status}</span>
      <span style="font-size:11px;color:var(--txt-muted)">${r.date}</span>
    </div>`;
  (r.lines || []).forEach(l => {
    h += `<div style="background:var(--bg);border-radius:var(--rs);padding:10px 12px;margin-bottom:8px">
      <div style="font-weight:700">${l.partName} <span style="font-family:monospace;font-size:11px;color:var(--txt-muted)">${l.partNo}</span></div>
      <div style="display:flex;gap:12px;margin-top:4px;font-size:12px">
        <span>Requested: <strong>${l.qtyRequested}</strong></span>
        ${l.qtyApproved ? `<span>Approved: <strong style="color:var(--ok)">${l.qtyApproved}</strong></span>` : ''}
      </div>
    </div>`;
  });
  if (r.rejectionReason) h += `<div class="ibox" style="background:#fef2f2;border-color:var(--err,#dc2626);color:var(--err,#dc2626)">Rejected: ${r.rejectionReason}</div>`;
  if (r.notes) h += `<div style="font-size:12px;color:var(--txt-muted);margin-top:8px">${r.notes}</div>`;
  h += `<button class="btn btn-s mt12" style="width:100%" onclick="closeModal()">Close</button>`;
  if (r.status === 'pending' && r.requestedBy === S.sess.userId) {
    h += `<button class="btn btn-s mt8" style="width:100%" onclick="closeModal();openNewReqModal('${r.id}')">Edit</button>`;
  }
  openModal(h);
}

async function cancelReq(id) {
  openModal(`
    <div class="mtit">Cancel Requisition?</div>
    <p style="font-size:13px;color:var(--txt-muted)">This cannot be undone.</p>
    <div style="display:flex;gap:8px;margin-top:12px">
      <button class="btn btn-s" style="flex:1" onclick="closeModal()">Keep</button>
      <button class="btn btn-d" style="flex:1" onclick="closeModal();_doCancelReq('${id}')">Cancel Req</button>
    </div>`);
}
async function _doCancelReq(id) {
  try {
    await db.collection('requisitions').doc(id).update({ status: 'rejected', rejectionReason: 'Cancelled by requester', updatedAt: serverTS() });
    const idx = (S.requisitions || []).findIndex(r => r.id === id);
    if (idx >= 0) S.requisitions[idx].status = 'rejected';
    toast('Requisition cancelled');
    switchTab('reqs');
  } catch (e) { toast('Error: ' + e.message); }
}

/* ══════════════════════════════════════════════════════════════════════
   REPORTS TAB
   ══════════════════════════════════════════════════════════════════════ */
function buildReportsHtml() {
  const shiftOpts = [
    `<option value="">All Shifts</option>`,
    ...Object.entries(S.shifts || { A:{label:'Shift A'}, B:{label:'Shift B'}, C:{label:'Shift C'} })
      .map(([k, v]) => `<option value="${k}" ${_repShift === k ? 'selected' : ''}>${v.label || k}</option>`)
  ].join('');

  return `
    <div style="padding-bottom:20px">
      <div class="card" style="margin-top:8px">
        <div class="row-3">
          <div class="f">
            <label>Stage</label>
            <select onchange="_repStage=this.value;loadAndRenderReports()">
              <option value="soft" ${_repStage==='soft'?'selected':''}>Soft Stage</option>
              <option value="hard" ${_repStage==='hard'?'selected':''}>Hard Stage</option>
            </select>
          </div>
          <div class="f">
            <label>Date</label>
            <input type="date" value="${_repDate}" onchange="_repDate=this.value;loadAndRenderReports()">
          </div>
          <div class="f">
            <label>Shift</label>
            <select onchange="_repShift=this.value;loadAndRenderReports()">${shiftOpts}</select>
          </div>
        </div>
      </div>
      <div id="reports-content">
        <div style="text-align:center;padding:32px;color:var(--txt-muted)">Loading reports...</div>
      </div>
    </div>`;
}

async function loadAndRenderReports() {
  const w = document.getElementById('reports-content');
  if (!w) return;

  let results = (S.actuals || []).filter(a => {
    if (a.stage !== _repStage) return false;
    if (_repDate && a.date !== _repDate) return false;
    if (_repShift && a.shift !== _repShift) return false;
    return true;
  }).sort((a, b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0));

  if (!results.length) {
    w.innerHTML = emptyState('ti-chart-bar', 'No Records', 'No production records match the selected filters.');
    return;
  }

  const totalProcessed = results.reduce((s, r) => s + (r.totalProcessed || 0), 0);
  const totalMachinesUsed = results.reduce((s, r) => s + (r.machinesUsed || 0), 0);
  const totalRejected = results.reduce((s, r) => s + (r.machines || []).reduce((ss, m) => ss + (m.totalRejected || 0), 0), 0);
  const oeeSamples = results.filter(r => r.avgOEE > 0);
  const avgOEE = oeeSamples.length ? Math.round(oeeSamples.reduce((s, r) => s + r.avgOEE, 0) / oeeSamples.length) : 0;

  const oeeColor = avgOEE >= 75 ? 'ok' : avgOEE >= 50 ? 'warn' : 'err';

  const reportCardsHtml = results.map(r => {
    const machUsed = (r.machines || []).filter(m => m.used);
    return `
      <div class="card" style="margin-bottom:12px">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px">
          <div>
            <div style="font-weight:700">${r.date || '—'} · Shift ${r.shift || '—'}</div>
            <div style="font-size:11px;color:var(--txt-muted)">${r.supervisorName || ''} · ${fmtTS(r.createdAt)}</div>
          </div>
          <div style="text-align:right">
            <div style="font-size:18px;font-weight:800;color:var(--acc)">${r.totalProcessed || 0} <span style="font-size:11px;font-weight:400">pcs</span></div>
            <div style="font-size:11px;color:var(--txt-muted)">${r.machinesUsed || 0} machines</div>
          </div>
        </div>
        <div class="row-3" style="gap:8px;margin-bottom:8px">
          <div style="text-align:center;background:var(--bg);border-radius:6px;padding:6px">
            <div style="font-size:15px;font-weight:800;color:var(--ok)">${r.totalProcessed || 0}</div>
            <div style="font-size:10px;color:var(--txt-muted)">Processed</div>
          </div>
          <div style="text-align:center;background:var(--bg);border-radius:6px;padding:6px">
            <div style="font-size:15px;font-weight:800;color:var(--err,#dc2626)">${(r.machines || []).reduce((s,m)=>s+(m.totalRejected||0),0)}</div>
            <div style="font-size:10px;color:var(--txt-muted)">Rejected</div>
          </div>
          <div style="text-align:center;background:var(--bg);border-radius:6px;padding:6px">
            <div style="font-size:15px;font-weight:800;color:${r.avgOEE>=75?'var(--ok)':r.avgOEE>=50?'#f59e0b':'var(--err,#dc2626)'}">${r.avgOEE || 0}%</div>
            <div style="font-size:10px;color:var(--txt-muted)">Avg OEE</div>
          </div>
        </div>
        ${machUsed.length ? `
          <div style="font-size:11px;font-weight:700;color:var(--txt-muted);margin-bottom:4px">PER MACHINE</div>
          ${machUsed.map(m => `
            <div style="display:flex;justify-content:space-between;font-size:12px;padding:4px 0;border-bottom:1px solid var(--bdr)">
              <span style="font-weight:600">${m.machineName}</span>
              <span style="color:var(--txt-muted)">${m.operatorName || '—'}</span>
              <span><strong>${m.totalProcessed}</strong> pcs</span>
              <span style="color:${m.oee>=75?'var(--ok)':m.oee>=50?'#f59e0b':'var(--err,#dc2626)'}">${m.oee || 0}% OEE</span>
            </div>`).join('')}
        ` : ''}
      </div>`;
  }).join('');

  w.innerHTML = `
    <div class="stats-3" style="margin:8px 0 12px">
      <div class="stat-card info">
        <div class="stat-lbl">Total Processed</div>
        <div class="stat-val">${totalProcessed}</div>
        <div class="stat-sub">pcs</div>
      </div>
      <div class="stat-card ${totalRejected > 0 ? 'warn' : 'ok'}">
        <div class="stat-lbl">Total Rejection</div>
        <div class="stat-val">${totalRejected}</div>
        <div class="stat-sub">pcs</div>
      </div>
      <div class="stat-card ${oeeColor}">
        <div class="stat-lbl">Avg OEE</div>
        <div class="stat-val">${avgOEE}%</div>
        <div class="stat-sub">${results.length} shifts</div>
      </div>
    </div>
    <div class="stat-card info" style="margin-bottom:12px;text-align:center">
      <div class="stat-lbl">Total Machines Used</div>
      <div class="stat-val">${totalMachinesUsed}</div>
      <div class="stat-sub">across all shifts</div>
    </div>
    ${reportCardsHtml}`;
}

/* ══════════════════════════════════════════════════════════════════════
   PLANS VIEW TAB
   ══════════════════════════════════════════════════════════════════════ */
function buildPlansViewHtml() {
  return `
    <div style="padding-bottom:20px">
      <div class="card" style="margin-top:8px">
        <div class="row-2">
          <div class="f">
            <label>Stage</label>
            <select onchange="_pvStage=this.value;loadAndRenderPlans()">
              <option value="soft" ${_pvStage==='soft'?'selected':''}>Soft Stage</option>
              <option value="hard" ${_pvStage==='hard'?'selected':''}>Hard Stage</option>
            </select>
          </div>
          <div class="f">
            <label>Date</label>
            <input type="date" value="${_pvDate}" onchange="_pvDate=this.value;loadAndRenderPlans()">
          </div>
        </div>
      </div>
      <div id="plans-view-content">
        <div style="text-align:center;padding:32px;color:var(--txt-muted)">Loading plans...</div>
      </div>
    </div>`;
}

async function loadAndRenderPlans() {
  const w = document.getElementById('plans-view-content');
  if (!w) return;

  const results = (S.plans || []).filter(p => {
    if (p.stage !== _pvStage) return false;
    if (_pvDate && p.date !== _pvDate) return false;
    return true;
  }).sort((a, b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0));

  if (!results.length) {
    w.innerHTML = emptyState('ti-calendar', 'No Plans', 'No plans found for the selected filters.');
    return;
  }

  w.innerHTML = results.map(p => `
    <div class="card" style="margin-bottom:12px">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px">
        <div>
          <div style="font-weight:700">${p.date || '—'} · ${p.stage === 'soft' ? 'Soft Stage' : 'Hard Stage'}</div>
          <div style="font-size:11px;color:var(--txt-muted)">By ${p.submittedByName || '—'} · ${fmtTS(p.createdAt)}</div>
        </div>
        <div style="font-size:18px;font-weight:800;color:var(--acc)">${p.totalPlanned || 0} <span style="font-size:11px;font-weight:400">pcs</span></div>
      </div>
      ${(p.entries || []).map(e => `
        <div style="display:flex;justify-content:space-between;font-size:12px;padding:4px 0;border-bottom:1px solid var(--bdr)">
          <span style="font-weight:600">${e.machineName}</span>
          <span style="color:var(--txt-muted)">${e.partName || '—'}</span>
          <span><strong>${e.plannedQty || 0}</strong> pcs</span>
        </div>`).join('')}
    </div>`).join('');
}

/* ══════════════════════════════════════════════════════════════════════
   BOOT
   ══════════════════════════════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', init);
