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
let _viewingFinalized = false;  // true when the loaded shift is a finalized report (read-only)
let _finalizedRecId   = null;   // the actuals doc id of the finalized report being viewed
let _editingReportId  = null;   // set when editing an existing report from the Reports tab

// Plan Entry state
let _planStage          = '';
let _planDate           = '';
let _planData           = {};  // machineId → { partId, partName, partNo, plannedQty }
let _planAutoSaveTimers = {};  // machineId → setTimeout handle
let _planSaveStatus     = {};  // machineId → 'saved' | 'saving' | 'error' | ''

// Setup state
let _setupCard             = null;
let _setupTagId            = '';
let _setupStage            = '';
let _setupDeviationCleared = false; // set to true after plant-head deviation request confirmed
let _seqResolveState       = null;  // in-flight "verify prior op done this shift" flow state

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

  // Auto-pick current shift using the CONFIGURED shift keys (e.g. s1/s2/s3),
  // not hardcoded A/B/C — otherwise this never matches setupApprovals.shift.
  if (!_actShift) _actShift = getActiveShift().key;
  if (!_actDate) _actDate = dateStr();

  loadActualsView();
}

/* Load the data for the current stage/date/shift into the matrix.
   - Finalized shift → fetch the saved report so it is actually VISIBLE
     (drafts are deleted on finalize, so without this the view is blank).
   - Not finalized → restore this user's drafts. */
async function loadActualsView() {
  _machineData      = {};
  _viewingFinalized = false;
  _finalizedRecId   = null;
  _editingReportId  = null; // changing date/shift/stage abandons any in-progress edit

  const rec = (S.actuals || []).find(
    a => a.date === _actDate && a.shift === _actShift && a.stage === _actStage
  );

  if (rec) {
    _viewingFinalized = true;
    _finalizedRecId   = rec.id;
    renderActualEntry(); // paint immediately, then hydrate from the saved doc
    try {
      const snap = await db.collection('actuals').doc(rec.id).get();
      if (snap.exists) {
        (snap.data().machines || []).forEach(me => {
          _machineData[me.machineId] = {
            used:           me.used,
            idleReason:     me.idleReason || '',
            idleReasonOther: me.idleReasonOther || '',
            operatorId:     me.operatorId || '',
            operatorName:   me.operatorName || '',
            runs:           me.runs || [],
            downtime:       me.downtime || [],
          };
        });
      }
    } catch (e) { /* tiles fall back to empty */ }
    renderActualEntry();
    return;
  }

  // Not finalized — restore drafts for this stage/date/shift.
  const draftKey = `${_actDate}_${_actShift}_${_actStage}`;
  (S.prodDrafts || [])
    .filter(d => d.draftKey === draftKey && d.userId === S.sess.userId)
    .forEach(d => { _machineData[d.machineId] = { ...d.machineData, _draftId: d.id }; });
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
  const submittedRec = (S.actuals || []).find(
    a => a.date === _actDate && a.shift === _actShift && a.stage === _actStage
  );
  const alreadySubmitted = !!submittedRec;
  const canEditReport = canManageReports();
  const isEditingThis = !!(_editingReportId && submittedRec && submittedRec.id === _editingReportId);
  const lockedView = alreadySubmitted && !isEditingThis; // finalized & not actively editing

  const matrixHtml = machines.map(m => {
    const md = _machineData[m.id];
    const ms = (S.machineStatus || []).find(s => s.id === m.id);
    const isBreakdown = ms && (ms.status === 'pending_breakdown' || ms.status === 'under_maintenance');
    const totalProcessed = (md?.runs || []).reduce((s, r) => s + (+r.processed || 0), 0);
    const totalDtMins    = (md?.downtime || []).reduce((s, d) => s + (+d.mins || 0), 0);
    const runsCount      = (md?.runs || []).length;

    let statusColor = 'var(--bdr-mid)';
    let statusLabel = 'Tap to log';
    let statusIcon  = '';
    if (isBreakdown) { statusColor = 'var(--warn)'; statusLabel = 'Breakdown'; statusIcon = '<i class="ti ti-alert-triangle"></i> '; }
    else if (md?.used === true)  { statusColor = 'var(--ok)'; statusLabel = `${runsCount} run${runsCount!==1?'s':''} · ${totalProcessed} pcs`; }
    else if (md?.used === false && md?.idleReason) { statusColor = 'var(--bdr-mid)'; statusLabel = `Idle: ${md.idleReason.split(' ')[0]}...`; }

    const saveStatus = _autoSaveStatus[m.id];
    const saveLbl = saveStatus === 'saving' ? '<i class="ti ti-loader-2"></i> Saving...'
                  : saveStatus === 'saved'   ? '<i class="ti ti-check"></i> Saved'
                  : saveStatus === 'error'   ? '<i class="ti ti-alert-circle"></i> Save error'
                  : '';
    const statusTxtColor = isBreakdown ? 'var(--warn)' : md?.used ? 'var(--ok)' : 'var(--txt-muted)';

    return `
      <button type="button" class="matrix-tile" onclick="openMachineDetail('${m.id}')" style="border-color:${statusColor}">
        <span style="flex:1;min-width:0">
          <span class="matrix-tile-name">${m.name}</span>
          <span class="matrix-tile-code">${m.id_code || m.id}</span>
          <span class="matrix-tile-status" style="color:${statusTxtColor}">${statusIcon}${statusLabel}</span>
          ${saveLbl ? `<span class="matrix-tile-save">${saveLbl}</span>` : ''}
        </span>
        <i class="ti ti-chevron-right" style="color:var(--txt-dim);font-size:20px;flex-shrink:0"></i>
      </button>`;
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
            <input type="date" id="act-date" value="${_actDate}" onchange="_actDate=this.value;loadActualsView()">
          </div>
          <div class="f">
            <label>Shift</label>
            <select id="act-shift" onchange="_actShift=this.value;loadActualsView()">
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

      ${lockedView ? `<div class="wbox" style="margin-bottom:10px">
          <i class="ti ti-info-circle"></i>
          <div>
            <div style="font-weight:700;margin-bottom:2px">Finalized report — view only</div>
            <div style="font-size:12px">${submittedRec.totalProcessed || 0} pcs · ${submittedRec.machinesUsed || 0} machine(s) used${submittedRec.submittedByName ? ' · by ' + submittedRec.submittedByName : ''}. The machines below show the saved data.</div>
          </div>
        </div>
        ${canEditReport ? `
        <button class="btn btn-s btn-full" style="margin-bottom:10px" onclick="goToReportsForShift()">
          <i class="ti ti-chart-bar"></i> View / Edit / Delete in Reports
        </button>` : ''}` : ''}

      ${isEditingThis ? `<div class="ibox" style="margin-bottom:10px">
          <i class="ti ti-edit"></i>
          <div>Editing an existing report. Change anything below, then tap <strong>Save Changes</strong>.</div>
        </div>` : ''}

      <div style="font-size:12px;font-weight:700;color:var(--txt-muted);margin-bottom:8px">MACHINES (${machines.length})</div>
      ${machines.length ? matrixHtml : emptyState('ti-tool','No Machines',`No active machines for ${stageLabel}.`)}

      ${!lockedView && machines.length ? `
      <div class="action-bar-sticky">
        ${isEditingThis ? `<button class="btn btn-s btn-full" onclick="cancelEditReport()">
          <i class="ti ti-x"></i> Cancel — Discard Changes
        </button>` : `<button class="btn btn-s btn-full" style="border-color:var(--warn);color:var(--warn)" onclick="sampleFillActuals()">
          <i class="ti ti-wand"></i> Sample Fill (Testing)
        </button>`}
        <button class="btn btn-p btn-full" onclick="finalizeShift()">
          <i class="ti ti-check"></i> ${isEditingThis ? 'Save Changes' : 'Finalize Shift'}
        </button>
      </div>` : ''}
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
  const readOnly = _viewingFinalized; // viewing a finalized report → no editing here

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
        <div style="display:flex;justify-content:space-between;gap:8px;font-size:12px;padding:5px 0;border-bottom:1px solid var(--bdr)">
          <span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${sa.opName || '—'} <span style="color:var(--txt-muted);font-family:monospace">${sa.tagId || ''}</span></span>
          <span style="font-weight:700;flex-shrink:0">${sa.setupMins} min</span>
        </div>`).join('') +
      `<div style="display:flex;justify-content:space-between;font-size:12px;font-weight:700;padding:7px 0 0;color:var(--acc)">
        <span>Total Setup</span><span>${totalSetupMins} min</span>
      </div>`
    : `<div style="font-size:12px;color:var(--txt-muted)">No approved setup logged for this shift</div>`;

  const totalProcessed = (md.runs || []).reduce((s, r) => s + (+r.processed || 0), 0);
  const totalRejected  = (md.runs || []).reduce((s, r) => s + (+r.rejected  || 0), 0);
  const totalDtMins    = (md.downtime || []).reduce((s, d) => s + (+d.mins || 0), 0);
  const totalTarget    = (md.runs || []).reduce((s, r) => s + (+r.targetQty || 0), 0);
  const shiftEff       = totalTarget ? Math.round(totalProcessed / totalTarget * 100) : 0;

  const saveStatus = _autoSaveStatus[machId];
  const saveLbl = saveStatus === 'saving' ? '⟳ Auto-saving...'
                : saveStatus === 'saved'   ? '✓ All changes saved'
                : saveStatus === 'error'   ? '⚠ Save failed — check connection'
                : 'Changes save automatically';

  const runsHtml = (md.runs || []).length === 0
    ? `<div class="det-item-empty">No runs logged yet</div>`
    : (md.runs || []).map((r, i) => {
        const eff = (+r.targetQty) ? Math.round((+r.processed || 0) / (+r.targetQty) * 100) : 0;
        const effColor = eff >= 90 ? 'ok' : eff >= 70 ? 'warn' : 'err';
        return `
        <div class="det-item">
          <div class="det-item-body">
            <div class="det-item-title">${r.tagId}</div>
            <div class="det-item-tag" style="font-family:monospace">${r.opName || ''}</div>
            <div class="det-item-sub">${r.partName || ''}</div>
            <div style="margin-top:5px;font-size:13px">
              <span style="color:var(--ok);font-weight:700">${r.processed}</span> pcs${(+r.targetQty) ? `<span style="color:var(--txt-muted)"> / ${r.targetQty} target · <span style="color:var(--${effColor});font-weight:700">${eff}%</span></span>` : ' produced'}
              <span style="color:var(--err);font-weight:700;margin-left:6px">${r.rejected || 0}</span> rej
            </div>
          </div>
          ${readOnly ? '' : `<div class="det-item-actions" style="flex-direction:column">
            <button class="btn btn-s btn-sm" style="min-height:36px" onclick="openEditRunModal('${machId}',${i})"><i class="ti ti-edit"></i> Edit</button>
            <button class="btn btn-d btn-sm" style="min-height:36px" onclick="removeRunDetail(${i})"><i class="ti ti-trash"></i> Remove</button>
          </div>`}
        </div>`;
      }).join('');

  const downtimeHtml = (md.downtime || []).length === 0
    ? `<div class="det-item-empty">No downtime logged</div>`
    : (md.downtime || []).map((d, i) => `
        <div class="det-item downtime">
          <div class="det-item-body">
            <div class="det-item-title">${d.startTime} → ${d.endTime} <span style="font-weight:400;color:var(--txt-muted)">(${d.mins} min)</span></div>
            <div class="det-item-sub">${d.type || 'Other'}${d.description ? ' · ' + d.description : ''}</div>
          </div>
          ${readOnly ? '' : `<button class="btn btn-ic btn-d" onclick="removeDowntimeDetail(${i})" aria-label="Remove downtime"><i class="ti ti-trash"></i></button>`}
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
        <div id="autosave-lbl" style="font-size:10px;color:${readOnly?'var(--txt-muted)':saveStatus==='error'?'var(--err)':saveStatus==='saving'?'var(--warn)':'var(--ok)'};text-align:right;flex-shrink:0;max-width:100px">${readOnly ? 'Finalized · view only' : saveLbl}</div>
      </div>

      ${readOnly ? `<div class="wbox" style="margin-bottom:12px"><i class="ti ti-lock"></i> <div>Finalized report — view only. Re-open it from the matrix screen (admin) to edit.</div></div>` : ''}
      ${isBreakdown ? `<div class="ebox" style="margin-bottom:12px"><i class="ti ti-alert-triangle"></i> <div>This machine has an open breakdown. Logging actuals may be inaccurate.</div></div>` : ''}

      <!-- Used / Not Used toggle -->
      <div class="card" style="margin-bottom:12px">
        <div style="display:flex;align-items:center;justify-content:space-between">
          <div>
            <div style="font-weight:700">Machine Status</div>
            <div style="font-size:12px;color:var(--txt-muted)">Was this machine used this shift?</div>
          </div>
          <div style="display:flex;align-items:center;gap:10px">
            <span style="font-size:13px;font-weight:600;color:${md.used?'var(--ok)':'var(--txt-muted)'}">${md.used?'Used':'Not Used'}</span>
            <label class="tsw" style="${readOnly?'opacity:.7':''}" aria-label="Machine used this shift">
              <input type="checkbox" ${md.used ? 'checked' : ''} ${readOnly ? 'disabled' : ''}
                onchange="toggleMachineUsedDetail(this.checked)">
              <span class="tsl"></span>
            </label>
          </div>
        </div>
      </div>

      ${md.used ? `
        <!-- Operator -->
        <div class="card" style="margin-bottom:12px">
          <div class="f" style="margin:0">
            <label>Operator *</label>
            <select ${readOnly ? 'disabled' : ''} onchange="setDetailField('operatorId',this.value);setDetailField('operatorName',this.options[this.selectedIndex].text);triggerAutoSave()">
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
            ${readOnly ? '' : `<button class="btn btn-s btn-sm" onclick="openAddRunModal('${machId}')">
              <i class="ti ti-scan"></i> Add Run
            </button>`}
          </div>
          ${runsHtml}
        </div>

        <!-- Downtime -->
        <div class="card" style="margin-bottom:12px">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
            <div style="font-size:12px;font-weight:700;color:var(--txt-muted)">DOWNTIME SESSIONS</div>
            ${readOnly ? '' : `<button class="btn btn-s btn-sm" onclick="openAddDowntimeModal('${machId}')">
              <i class="ti ti-plus"></i> Add
            </button>`}
          </div>
          ${downtimeHtml}
        </div>

        <!-- Summary -->
        <div class="card" style="margin-bottom:12px;background:var(--bg)">
          <div style="font-size:12px;font-weight:700;color:var(--txt-muted);margin-bottom:10px">SHIFT SUMMARY</div>
          <div style="display:flex;justify-content:space-between;align-items:center;background:var(--sur);border-radius:8px;padding:10px 12px;margin-bottom:8px">
            <div>
              <div style="font-size:10px;color:var(--txt-muted)">TARGET (after setup)</div>
              <div style="font-size:18px;font-weight:800">${totalTarget} pcs</div>
            </div>
            <div style="text-align:right">
              <div style="font-size:10px;color:var(--txt-muted)">EFFICIENCY</div>
              <div style="font-size:18px;font-weight:800;color:var(--${shiftEff>=90?'ok':shiftEff>=70?'warn':'err'})">${totalTarget ? shiftEff + '%' : '—'}</div>
            </div>
          </div>
          <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;text-align:center">
            <div style="background:var(--sur);border-radius:8px;padding:10px 4px">
              <div style="font-size:20px;font-weight:800;color:var(--ok)">${totalProcessed}</div>
              <div style="font-size:10px;color:var(--txt-muted)">Produced</div>
            </div>
            <div style="background:var(--sur);border-radius:8px;padding:10px 4px">
              <div style="font-size:20px;font-weight:800;color:var(--err)">${totalRejected}</div>
              <div style="font-size:10px;color:var(--txt-muted)">Rejected</div>
            </div>
            <div style="background:var(--sur);border-radius:8px;padding:10px 4px">
              <div style="font-size:20px;font-weight:800;color:var(--warn)">${totalDtMins + totalSetupMins}</div>
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
            <select id="idle-reason-sel" ${readOnly ? 'disabled' : ''} onchange="onIdleReasonChange(this.value)">
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

/** Total approved setup minutes for a machine in the active date/shift. */
function machineSetupMins(machId) {
  return (S.setupApprovals || [])
    .filter(sa => sa.machineId === machId && sa.date === _actDate && sa.shift === _actShift && sa.status === 'approved')
    .reduce((s, sa) => s + (sa.setupMins || 0), 0);
}

/* — Inline run editing: correct a logged run's qty without re-entering it — */
function openEditRunModal(machId, idx) {
  const r = _machineData[machId]?.runs?.[idx];
  if (!r) { toast('Run not found'); return; }
  openModal(`
    <div class="mtit"><i class="ti ti-edit"></i> Edit Production Run</div>
    <div style="background:var(--bg);border-radius:var(--rs);padding:10px 12px;margin-bottom:12px;font-size:12px">
      <div><strong>${r.tagId}</strong> · <span style="font-family:monospace;color:var(--acc)">${r.opName || ''}</span></div>
      <div style="color:var(--txt-muted)">${r.partName || ''}</div>
      ${(+r.targetQty) ? `<div style="margin-top:4px;color:var(--txt-muted)">Target (after setup): <strong>${r.targetQty}</strong> pcs</div>` : ''}
    </div>
    <div class="row-2">
      <div class="f"><label>Processed (pcs) *</label><input type="number" id="edit-run-processed" min="1" value="${r.processed || 0}"></div>
      <div class="f"><label>Rejected (pcs)</label><input type="number" id="edit-run-rejected" min="0" value="${r.rejected || 0}"></div>
    </div>
    <div style="display:flex;gap:8px;margin-top:12px">
      <button class="btn btn-s" style="flex:1" onclick="closeModal()">Cancel</button>
      <button class="btn btn-p" style="flex:1" onclick="saveEditRun('${machId}',${idx})">Save ✓</button>
    </div>`);
}

function saveEditRun(machId, idx) {
  const r = _machineData[machId]?.runs?.[idx];
  if (!r) { toast('Run not found'); return; }
  const processed = parseInt(document.getElementById('edit-run-processed')?.value) || 0;
  const rejected  = parseInt(document.getElementById('edit-run-rejected')?.value) || 0;
  if (processed < 1) { toast('Processed must be at least 1'); return; }
  r.processed = processed;
  r.rejected  = rejected;
  // (Re)compute the target from the op's cycle time + this shift's setup, so
  // older runs without a stored target also get one on edit.
  if (+r.cycleTimeSecs) r.targetQty = calcOEE(+r.cycleTimeSecs, machineSetupMins(machId), 0, processed).targetQty;
  _detailMachId = machId;
  closeModal();
  triggerAutoSave();
  renderMachineDetail();
  toast('Run updated ✓');
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
  el.style.color = status === 'error' ? 'var(--err)' : status === 'saving' ? 'var(--warn)' : 'var(--ok)';
}

async function doAutoSave(machId) {
  const md = _machineData[machId];
  if (!md) return;
  // While editing an existing report we keep changes in memory only (finalize
  // reads _machineData directly) — avoid leaving stray drafts beside the report.
  if (_editingReportId) { _autoSaveStatus[machId] = 'saved'; updateAutoSaveLabel(); return; }
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
      <button class="btn btn-s btn-ic" style="width:44px;height:44px" title="Scan QR" onclick="openQrScanner(v=>{document.getElementById('run-tag-input').value=v.toUpperCase();runFetchTag();},'Scan TAG')">
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
      if (infoDiv) infoDiv.innerHTML = `<div class="ebox">TAG ${tagId} not found</div>`;
      return;
    }

    // Hard stage: heatCode required
    if (_actStage === 'hard' && !card.heatCode) {
      if (infoDiv) infoDiv.innerHTML = `<div class="ebox">Hard stage requires a heat code on this TAG. Check Heat Treatment.</div>`;
      return;
    }

    // Sequence check
    const partOpsForStage = (S.partOps || [])
      .filter(po => po.partId === card.partId && po.workCenterType === _actStage)
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
            <div class="wbox" style="flex-direction:column;align-items:stretch">
              <div style="font-weight:700;font-size:12px"><i class="ti ti-alert-triangle"></i> Sequence Deviation Detected</div>
              <div style="font-size:11px;margin-top:2px">
                Previous operation "<strong>${prevOpName}</strong>" (seq ${prevRequired.seqNo}) has no completion on this TAG.
              </div>
              <button class="btn btn-warn btn-sm btn-full" style="margin-top:8px"
                onclick="showDeviationConfirmModal('${tagId}','${prevOpName}',${prevRequired.seqNo})">
                Request Sequence Deviation Approval
              </button>
            </div>`;
        }
      }
    }

    const opName = nextOp ? ((S.operations || []).find(o => o.id === nextOp?.opId)?.name || '—') : 'No next op';
    const cycleTimeSecs = nextOp ? ((S.partOps || []).find(po => po.partId === card.partId && po.opId === nextOp.opId)?.cycleTimeSecs || 0) : 0;

    // Target = pieces achievable in the shift at this op's cycle time, after
    // deducting approved setup for this machine/shift (reuses core calcOEE).
    const setupMins = machineSetupMins(_runMachId);
    const targetQty = cycleTimeSecs ? calcOEE(cycleTimeSecs, setupMins, 0, 0).targetQty : 0;
    _runCard = { ...card, nextOp, cycleTimeSecs, targetQty };

    if (infoDiv) infoDiv.innerHTML = `
      ${deviationHtml}
      <div class="sbox" style="flex-direction:column;align-items:stretch;font-size:12px">
        <div style="font-weight:700;margin-bottom:6px"><i class="ti ti-circle-check"></i> TAG Valid</div>
        <div class="kv-row" style="padding:3px 0"><span class="text-muted">TAG</span><strong style="font-family:monospace;margin-left:auto">${tagId}</strong></div>
        <div class="kv-row" style="padding:3px 0"><span class="text-muted">Part</span><strong style="margin-left:auto;text-align:right">${card.partName}</strong></div>
        <div class="kv-row" style="padding:3px 0"><span class="text-muted">Next Op</span><strong style="margin-left:auto;text-align:right">${opName}</strong></div>
        <div class="kv-row" style="padding:3px 0;border-bottom:none"><span class="text-muted">Qty on TAG</span><strong style="margin-left:auto">${card.currentQty} pcs</strong></div>
        ${targetQty ? `<div class="kv-row" style="padding:3px 0;border-bottom:none"><span class="text-muted">Target (after setup)</span><strong style="color:var(--acc);margin-left:auto">${targetQty} pcs</strong></div>` : ''}
        ${card.heatCode ? `<div class="kv-row" style="padding:3px 0;border-bottom:none"><span class="text-muted">Heat Code</span><strong style="color:var(--ok);margin-left:auto"><i class="ti ti-flame"></i> ${card.heatCode}</strong></div>` : ''}
      </div>`;

    const runForm = document.getElementById('run-form');
    if (runForm) runForm.style.display = 'block';

  } catch (e) {
    if (infoDiv) infoDiv.innerHTML = `<div class="ebox">Error: ${e.message}</div>`;
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
    tagQty:        _runCard.currentQty   || 0,
    targetQty:     _runCard.targetQty    || 0,
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

/* — Sample Fill (testing helper) — */
function sampleFillActuals() {
  const machines = (S.machines || [])
    .filter(m => m.stage === _actStage && m.active !== false);
  machines.forEach(m => {
    if (!_machineData[m.id] || (_machineData[m.id].used === false && !_machineData[m.id].idleReason)) {
      _machineData[m.id] = {
        used: false, idleReason: 'Other', idleReasonOther: 'Testing purposes',
        operatorId: '', operatorName: '', runs: [], downtime: [],
      };
    }
  });
  renderActualEntry();
  toast(`${machines.length} machines auto-filled as "Not Used — Testing purposes"`);
}

/* — Finalize Shift — */
async function finalizeShift() {
  if (!_actShift) { toast('Select a shift'); return; }
  if (!_actSupervisor) {
    _actSupervisor = document.getElementById('act-sup')?.value || '';
  }
  if (!_actSupervisor) { toast('Select a supervisor'); return; }

  // If saving an edit of an existing report, reverse the OLD report first
  // (strip its route-card effects + delete it) so the corrected one replaces it
  // cleanly with no double-posting. Done before writing the new report.
  if (_editingReportId) {
    try {
      const oldSnap = await db.collection('actuals').doc(_editingReportId).get();
      if (oldSnap.exists) {
        const oldRec = { id: oldSnap.id, ...oldSnap.data() };
        const res = await _reverseReportCards(oldRec);
        if (!res.ok) { toast(`Can't save: ${res.error}`, 5500); return; }
        await logAudit('edit_report', 'production', _editingReportId, oldRec, null);
      }
    } catch (e) { toast('Error saving edit: ' + e.message); return; }
  }

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
          reportId:    ref.id,   // ties this entry to its production report (for admin re-open)
          loggedBy:    S.sess.userId,
          loggedAt:    new Date().toISOString(),
        });
      });
    });

    // Per-TAG processed/rejected totals for this shift — drives both the
    // live currentQty carried forward and the split-card remainder below.
    // Rejected pcs are removed from the flow entirely, not treated as
    // "still needs processing" (that was the bug: the old remainder calc
    // only subtracted processed, so rejected pcs spawned a phantom WIP
    // split-card instead of just reducing the live quantity).
    const tagActualQty   = {};
    const tagRejectedQty = {};
    const tagTagQty      = {};
    machineEntries.forEach(me => {
      (me.runs || []).forEach(r => {
        if (!r.tagId || !r.tagQty) return;
        tagActualQty[r.tagId]   = (tagActualQty[r.tagId]   || 0) + (r.processed || 0);
        tagRejectedQty[r.tagId] = (tagRejectedQty[r.tagId] || 0) + (r.rejected  || 0);
        if (!tagTagQty[r.tagId]) tagTagQty[r.tagId] = r.tagQty;
      });
    });

    Object.entries(tagFinalStatus).forEach(([tagId, newStatus]) => {
      const rcRef = db.collection('routeCards').doc(tagId);
      (tagHistEntries[tagId] || []).forEach(h => {
        batch.update(rcRef, { opHistory: firebase.firestore.FieldValue.arrayUnion(h) });
      });
      const update = { status: newStatus, updatedAt: serverTS() };
      if (tagActualQty[tagId] !== undefined) update.currentQty = tagActualQty[tagId];
      batch.update(rcRef, update);
    });

    // Scrap ledger — production-stage rejects must be traceable the same
    // way QC and Heat Treatment rejects are (see qc.js / ht.js scrapLedger
    // writes). Previously these pieces just vanished from currentQty with
    // no record of which part/batch/op/machine they were lost at.
    const rejectTagIds = Object.keys(tagRejectedQty).filter(id => tagRejectedQty[id] > 0);
    if (rejectTagIds.length) {
      const rejectCardSnaps = await Promise.all(
        rejectTagIds.map(id => db.collection('routeCards').doc(id).get())
      );
      const rejectCardById = {};
      rejectTagIds.forEach((id, i) => {
        if (rejectCardSnaps[i].exists) rejectCardById[id] = rejectCardSnaps[i].data();
      });
      machineEntries.forEach(me => {
        (me.runs || []).forEach(r => {
          if (!r.tagId || !r.rejected) return;
          const card = rejectCardById[r.tagId] || {};
          batch.set(db.collection('scrapLedger').doc(), {
            tagId:        r.tagId,
            batchCode:    card.batchCode    || '',
            heatCode:     card.heatCode     || '',
            partId:       r.partId          || card.partId || '',
            partNo:       r.partNo          || card.partNo || '',
            partName:     r.partName        || card.partName || '',
            customerId:   card.customerId   || '',
            customerName: card.customerName || '',
            qtyRejected:  r.rejected,
            defectDescription: `Production reject — ${r.opName || r.opId} (${me.machineName || me.machineId})`,
            stage:        _actStage,
            opId:         r.opId,
            opName:       r.opName,
            machineId:    me.machineId,
            machineName:  me.machineName,
            inspectedBy:     S.sess.userId,
            inspectedByName: S.sess.name,
            date: _actDate,
            createdAt: serverTS(),
          });
        });
      });
    }

    // Child-card splitting: if there's genuine unprocessed remainder (not
    // yet run through this op at all — distinct from rejected pcs, which
    // are already excluded above), birth a sibling card carrying it.
    const splitTagIds = Object.keys(tagActualQty).filter(id =>
      (tagActualQty[id] + (tagRejectedQty[id] || 0)) < (tagTagQty[id] || 0)
    );
    const splitAuditEntries = [];
    if (splitTagIds.length) {
      const [parentSnaps, s1Snaps] = await Promise.all([
        Promise.all(splitTagIds.map(id => db.collection('routeCards').doc(id).get())),
        Promise.all(splitTagIds.map(id => db.collection('routeCards').doc(id + '-S1').get())),
      ]);
      splitTagIds.forEach((tagId, i) => {
        if (!parentSnaps[i].exists) return;
        const parent     = parentSnaps[i].data();
        const childTagId = s1Snaps[i].exists ? tagId + '-S2' : tagId + '-S1';
        const remQty     = (tagTagQty[tagId] || 0) - (tagActualQty[tagId] || 0) - (tagRejectedQty[tagId] || 0);
        batch.set(db.collection('routeCards').doc(childTagId), {
          ...parent,
          tagId:         childTagId,
          parentCardUid: tagId,
          cardType:      'SPLIT',
          initialQty:    remQty,
          currentQty:    remQty,
          status:        parent.status,   // carries pre-shift status unchanged
          opHistory:     parent.opHistory || [],
          createdAt:     serverTS(),
          createdBy:     S.sess.userId,
          updatedAt:     serverTS(),
        });
        splitAuditEntries.push({ childTagId, tagId, remQty });
      });
    }

    await batch.commit();
    for (const e of splitAuditEntries) {
      await logAudit('split_card', 'production', e.childTagId, null, { parentTagId: e.tagId, remQty: e.remQty });
    }

    S.actuals.unshift({ id: ref.id, stage: _actStage, date: _actDate, shift: _actShift, totalProcessed, machinesUsed, avgOEE });
    S.prodDrafts = S.prodDrafts.filter(d => !(d.draftKey === draftKey && d.userId === S.sess.userId));

    await logAudit(_editingReportId ? 'resave_report' : 'finalize_shift', 'production', ref.id, null, { stage: _actStage, date: _actDate, shift: _actShift });
    toast(_editingReportId
      ? `Report saved ✓ — ${totalProcessed} pcs across ${machinesUsed} machines`
      : `Shift finalized ✓ — ${totalProcessed} pcs across ${machinesUsed} machines`);
    _editingReportId = null;
    _machineData = {};
    _activeView = 'tabs';
    _activeTab  = 'reports';
    render();
  } catch (e) { toast('Error finalizing: ' + e.message); }
}

/* ══════════════════════════════════════════════════════════════════════
   ADMIN REPORT MANAGEMENT (view/edit/delete from the Reports tab)
   ══════════════════════════════════════════════════════════════════════
   Edit  = reverse the report's route-card effects, load it into the matrix
           editor, then re-save (Finalize) as a corrected report.
   Delete= reverse the report's route-card effects and remove it.
   Both REFUSE if any affected card was split or has moved downstream
   (HT/QC/Dispatch) — auto-reversal isn't safe then. */
const canManageReports = () =>
  S.sess?.email === 'tanmay@indometaforge.in' || S.sess?.role === 'admin';

/* Reverse a report's effect on every route card it touched, then delete the
   report doc. Returns { ok:true } or { ok:false, error }. */
async function _reverseReportCards(rec) {
  const stage = rec.stage;
  const stageStatuses = stage === 'soft' ? ['soft_wip', 'soft_done'] : ['hard_wip', 'hard_done'];
  const entryStatus   = stage === 'soft' ? 'store_issued' : 'ht_done';

  const tagIds = [...new Set((rec.machines || [])
    .flatMap(me => (me.runs || []).map(r => r.tagId).filter(Boolean)))];

  const [cardSnaps, childSnaps] = await Promise.all([
    Promise.all(tagIds.map(id => db.collection('routeCards').doc(id).get())),
    Promise.all(tagIds.map(id => db.collection('routeCards').doc(id + '-S1').get())),
  ]);

  // Safety guard.
  for (let i = 0; i < tagIds.length; i++) {
    if (!cardSnaps[i].exists) continue;
    const card = cardSnaps[i].data();
    if (childSnaps[i].exists) return { ok: false, error: `${tagIds[i]} was split into a child card — reverse not safe.` };
    if (card.status && !stageStatuses.includes(card.status)) return { ok: false, error: `${tagIds[i]} has moved to "${card.status}" — reverse not safe.` };
  }

  const batch = db.batch();
  tagIds.forEach((id, i) => {
    if (!cardSnaps[i].exists) return;
    const card = cardSnaps[i].data();
    const kept = (card.opHistory || []).filter(h =>
      h.source === 'setup_seq_clear' ? true                       // keep sequence markers
      : h.reportId ? h.reportId !== rec.id                        // precise match (new entries)
      : !(h.date === rec.date && h.shift === rec.shift && h.stage === stage) // legacy fallback
    );
    const stageReal = kept.filter(h => h.stage === stage && h.source !== 'setup_seq_clear');
    const anyFinal = stageReal.some(h => {
      const po = (S.partOps || []).find(p => p.partId === card.partId && p.opId === h.opId);
      return po?.finalOperation === true;
    });
    const newStatus = stageReal.length
      ? (anyFinal ? (stage === 'soft' ? 'soft_done' : 'hard_done')
                  : (stage === 'soft' ? 'soft_wip'  : 'hard_wip'))
      : entryStatus;
    batch.update(db.collection('routeCards').doc(id), { opHistory: kept, status: newStatus, updatedAt: serverTS() });
  });
  batch.delete(db.collection('actuals').doc(rec.id));
  await batch.commit();
  S.actuals = (S.actuals || []).filter(a => a.id !== rec.id);
  return { ok: true };
}

/* Read-only guard check (no writes) — used before opening the editor. */
async function _checkReportReversible(rec) {
  const stage = rec.stage;
  const stageStatuses = stage === 'soft' ? ['soft_wip', 'soft_done'] : ['hard_wip', 'hard_done'];
  const tagIds = [...new Set((rec.machines || [])
    .flatMap(me => (me.runs || []).map(r => r.tagId).filter(Boolean)))];
  const [cardSnaps, childSnaps] = await Promise.all([
    Promise.all(tagIds.map(id => db.collection('routeCards').doc(id).get())),
    Promise.all(tagIds.map(id => db.collection('routeCards').doc(id + '-S1').get())),
  ]);
  for (let i = 0; i < tagIds.length; i++) {
    if (!cardSnaps[i].exists) continue;
    const card = cardSnaps[i].data();
    if (childSnaps[i].exists) return { ok: false, error: `${tagIds[i]} was split into a child card — edit not safe.` };
    if (card.status && !stageStatuses.includes(card.status)) return { ok: false, error: `${tagIds[i]} has moved to "${card.status}" — edit not safe.` };
  }
  return { ok: true };
}

/* Edit a report → load it into the matrix editor. The original report stays
   intact until you Save (so Cancel is non-destructive); on Save the old report
   is reversed and a corrected one written. */
async function editReportFromList(recId) {
  if (!canManageReports()) { toast('Not permitted'); return; }
  toast('Opening report for editing…');
  try {
    const snap = await db.collection('actuals').doc(recId).get();
    if (!snap.exists) { toast('Report not found'); return; }
    const rec = { id: snap.id, ...snap.data() };

    const check = await _checkReportReversible(rec);
    if (!check.ok) { toast(`Can't edit: ${check.error}`, 5500); return; }

    _actStage = rec.stage; _actDate = rec.date; _actShift = rec.shift;
    _actSupervisor = rec.supervisorId || '';
    _viewingFinalized = false; _finalizedRecId = null;
    _editingReportId = recId;
    _machineData = {};
    (rec.machines || []).forEach(me => {
      _machineData[me.machineId] = {
        used:           me.used,
        idleReason:     me.idleReason || '',
        idleReasonOther: me.idleReasonOther || '',
        operatorId:     me.operatorId || '',
        operatorName:   me.operatorName || '',
        runs:           me.runs || [],
        downtime:       me.downtime || [],
      };
    });

    const runCount = (rec.machines || []).reduce((s, me) => s + (me.runs || []).length, 0);
    _activeView = 'actual';
    render();
    toast(`Editing report — ${runCount} run(s) loaded. Change anything, then Save Changes.`, 4500);
  } catch (e) { toast('Error: ' + e.message); }
}

/* Cancel an in-progress edit — original report is untouched. */
function cancelEditReport() {
  _editingReportId = null;
  _machineData = {};
  switchTab('reports');
}

/* Delete a whole report (two-step). */
function confirmDeleteReport(recId) {
  if (!canManageReports()) { toast('Not permitted'); return; }
  const rec = (S.actuals || []).find(a => a.id === recId);
  const when = rec ? `${fmtDate(rec.date)} · ${(S.shifts || {})[rec.shift]?.label || rec.shift}` : 'this shift';
  openModal(`
    <div class="modal-handle"></div>
    <div style="text-align:center;margin-bottom:12px">
      <div style="width:52px;height:52px;border-radius:26px;background:var(--err-bg);border:2px solid var(--err);color:var(--err);
                  display:inline-flex;align-items:center;justify-content:center;font-size:22px"><i class="ti ti-trash"></i></div>
      <div style="font-size:16px;font-weight:800;color:var(--err);margin-top:8px">Delete this report?</div>
    </div>
    <p style="font-size:13px;color:var(--txt);text-align:center;margin-bottom:12px">
      Permanently delete the production report for <strong>${when}</strong> and undo its effect on the route cards.
    </p>
    <p style="font-size:12px;color:var(--txt-muted);text-align:center;margin-bottom:16px">
      Refuses if any card was split or moved downstream. This cannot be undone.
    </p>
    <div style="display:flex;gap:8px">
      <button class="btn btn-s" style="flex:1" onclick="closeModal()">Cancel</button>
      <button class="btn btn-p" style="flex:1;background:var(--err);border-color:var(--err)"
        onclick="closeModal();deleteReportFromList('${recId}')">Yes, Delete</button>
    </div>`);
}

async function deleteReportFromList(recId) {
  if (!canManageReports()) { toast('Not permitted'); return; }
  toast('Deleting report…');
  try {
    const snap = await db.collection('actuals').doc(recId).get();
    if (!snap.exists) {
      S.actuals = (S.actuals || []).filter(a => a.id !== recId);
      toast('Report already gone'); loadAndRenderReports(); return;
    }
    const rec = { id: snap.id, ...snap.data() };
    const res = await _reverseReportCards(rec);
    if (!res.ok) { toast(`Can't delete: ${res.error}`, 5500); return; }
    await logAudit('delete_report', 'production', recId, rec, null);
    toast('Report deleted ✓');
    loadAndRenderReports();
  } catch (e) { toast('Error: ' + e.message); }
}

/* Jump from Log Actuals' "already finalized" notice to the Reports tab. */
function goToReportsForShift() {
  _repStage = _actStage; _repDate = _actDate; _repShift = _actShift;
  switchTab('reports');
}

function backToHub() {
  _activeView = 'tabs';
  _activeTab  = 'hub';
  _machineData = {};
  _planData   = {};
  _editingReportId = null;
  _viewingFinalized = false;
  render();
}

/* ══════════════════════════════════════════════════════════════════════
   PLAN ENTRY
   ══════════════════════════════════════════════════════════════════════ */
function enterPlanStage(stage) {
  _planStage          = stage;
  _activeView         = 'plan';
  _planData           = {};
  _planAutoSaveTimers = {};
  _planSaveStatus     = {};

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
    const pd     = _planData[m.id] || { partId: '', partName: '', plannedQty: '', notes: '' };
    const status = _planSaveStatus[m.id] || '';
    const saveLbl = status === 'saving' ? '⟳ Saving…' : status === 'saved' ? '✓ Saved' : status === 'error' ? '✗ Error' : '';
    const saveCol = status === 'error' ? 'var(--err)' : status === 'saving' ? 'var(--warn)' : 'var(--ok)';
    return `
      <div class="card" style="margin-bottom:10px">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
          <div>
            <div style="font-weight:800;font-size:14px">${m.name}</div>
            <div style="font-size:11px;color:var(--txt-muted)">${m.code || ''}</div>
          </div>
          <div id="plan-save-lbl-${m.id}"
            style="font-size:10px;font-weight:700;color:${saveCol};min-width:56px;text-align:right">${saveLbl}</div>
        </div>

        <!-- Part search -->
        <div class="f" style="margin-bottom:8px">
          <label>Part to Run</label>
          <div style="position:relative">
            <i class="ti ti-search" style="position:absolute;left:10px;top:50%;transform:translateY(-50%);
               color:var(--txt-muted);font-size:14px;pointer-events:none"></i>
            <input type="text" id="plan-part-${m.id}" placeholder="Type part name or number…"
              value="${pd.partName || ''}"
              class="part-search-input"
              style="padding-left:32px"
              oninput="planPartSearch(this,'${m.id}')"
              onfocus="planPartSearch(this,'${m.id}')"
              onblur="setTimeout(hidePartDrop,220)"
              autocomplete="off">
          </div>
          <input type="hidden" id="plan-pid-${m.id}" value="${pd.partId || ''}">
          ${pd.partName ? `<div style="font-size:11px;color:var(--ok);margin-top:3px"><i class="ti ti-circle-check"></i> ${pd.partName} (${pd.partNo || ''})</div>` : ''}
        </div>

        <div class="row-2">
          <div class="f">
            <label>Planned Qty (pcs)</label>
            <input type="number" id="plan-qty-${m.id}" min="1" placeholder="0" value="${pd.plannedQty || ''}"
              oninput="planOnChange('${m.id}')"
              style="font-size:18px;font-weight:700;text-align:center">
          </div>
          <div class="f">
            <label>Notes</label>
            <input type="text" id="plan-notes-${m.id}" placeholder="Optional notes" value="${pd.notes || ''}"
              oninput="planOnChange('${m.id}')">
          </div>
        </div>
      </div>`;
  }).join('');

  document.getElementById('page-content').innerHTML = `
    <div style="padding-bottom:80px">
      <div style="display:flex;align-items:center;gap:10px;padding:12px 0 10px;border-bottom:1px solid var(--bdr);margin-bottom:14px">
        <button class="btn btn-s btn-sm" onclick="backToHub()" style="flex-shrink:0">
          <i class="ti ti-arrow-left"></i> Back
        </button>
        <div style="flex:1">
          <div style="font-weight:800;font-size:15px;color:${stageColor}">${stageLabel} — Plan Entry</div>
          <div style="font-size:11px;color:var(--txt-muted)">Autosaves as you type · Submit when all machines are filled</div>
        </div>
      </div>

      <div class="card" style="margin-bottom:14px">
        <div class="f" style="margin-bottom:0">
          <label>Plan Date</label>
          <input type="date" id="plan-date" value="${_planDate}"
            onchange="_planDate=this.value" style="font-size:14px;font-weight:700">
        </div>
      </div>

      <div style="font-size:11px;font-weight:700;color:var(--txt-muted);letter-spacing:.06em;margin-bottom:8px">
        MACHINES (${machines.length})
      </div>
      ${machines.length ? machCardsHtml : emptyState('ti-tool', 'No Machines', `No active machines for ${stageLabel}.`)}

      ${machines.length ? `
        <button class="btn btn-p" style="width:100%;margin-top:14px;font-size:15px;padding:14px" onclick="submitPlanEntry()">
          <i class="ti ti-check"></i> Submit Day Plan
        </button>` : ''}
    </div>`;
}

function planPartSearch(inp, machId) {
  showPartDrop(inp, p => {
    const hidEl = document.getElementById(`plan-pid-${machId}`);
    if (hidEl) hidEl.value = p.id;
    inp.value = p.name;
    if (!_planData[machId]) _planData[machId] = {};
    _planData[machId].partId   = p.id;
    _planData[machId].partName = p.name;
    _planData[machId].partNo   = p.no;
    // Show confirmation line under the search input
    const confEl = inp.closest('.f')?.querySelector('div[id]');
    if (!confEl) {
      const note = document.createElement('div');
      note.style.cssText = 'font-size:11px;color:var(--ok);margin-top:3px';
      note.innerHTML = `<i class="ti ti-circle-check"></i> ${p.name} (${p.no || ''})`;
      inp.closest('.f')?.appendChild(note);
    }
    planAutoSave(machId);
  });
}

function planOnChange(machId) {
  planAutoSave(machId);
}

function planAutoSave(machId) {
  _planSaveStatus[machId] = 'saving';
  const lblEl = document.getElementById(`plan-save-lbl-${machId}`);
  if (lblEl) { lblEl.textContent = '⟳ Saving…'; lblEl.style.color = 'var(--warn)'; }

  clearTimeout(_planAutoSaveTimers[machId]);
  _planAutoSaveTimers[machId] = setTimeout(() => doPlanAutoSave(machId), 1400);
}

async function doPlanAutoSave(machId) {
  const partId   = document.getElementById(`plan-pid-${machId}`)?.value   || (_planData[machId]?.partId   || '');
  const partName = document.getElementById(`plan-part-${machId}`)?.value.trim() || (_planData[machId]?.partName || '');
  const qty      = parseInt(document.getElementById(`plan-qty-${machId}`)?.value) || 0;
  const notes    = document.getElementById(`plan-notes-${machId}`)?.value.trim()  || '';
  const planDate = document.getElementById('plan-date')?.value || _planDate;

  const planData = { partId, partName, plannedQty: qty, notes };
  _planData[machId] = planData;

  const docId = `${S.sess.userId}_${planDate}_${_planStage}_${machId}`;
  const lblEl = document.getElementById(`plan-save-lbl-${machId}`);
  try {
    await db.collection('planDrafts').doc(docId).set({
      userId: S.sess.userId, machineId: machId, stage: _planStage, date: planDate,
      planData, updatedAt: serverTS(),
    }, { merge: true });
    _planSaveStatus[machId] = 'saved';
    if (lblEl) { lblEl.textContent = '✓ Saved'; lblEl.style.color = 'var(--ok)'; }
    // Fade the "Saved" label out after 3s
    setTimeout(() => {
      if (_planSaveStatus[machId] === 'saved') {
        if (lblEl) { lblEl.textContent = ''; }
      }
    }, 3000);
  } catch (e) {
    _planSaveStatus[machId] = 'error';
    if (lblEl) { lblEl.textContent = '✗ Error'; lblEl.style.color = 'var(--err)'; }
  }
}

// Legacy manual save — kept for backward-compat if called anywhere else
async function savePlanDraft(machId) { planAutoSave(machId); }

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

  // Default the shift to the CURRENT configured shift (e.g. s1/s2/s3) — same
  // key Production uses when filing actuals. Without this the dropdown silently
  // sat on the first shift, so setups never matched the Production view.
  const _curShift = getActiveShift().key;
  const shiftOpts = Object.entries(S.shifts || {})
    .map(([k, v]) => `<option value="${k}" ${k === _curShift ? 'selected' : ''}>${v.label || k}</option>`).join('');

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
          <div class="f"><label>Date</label><input id="setup-date" type="date" value="${dateStr()}" max="${dateStr()}"></div>
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
          <button class="btn btn-s btn-ic" style="width:44px;height:44px" title="Scan QR"
            onclick="openQrScanner(v=>{document.getElementById('setup-tag-input').value=v.toUpperCase();setupFetchTag();},'Scan TAG')">
            <i class="ti ti-camera"></i>
          </button>
        </div>
        <button class="btn btn-s" style="width:100%" onclick="setupFetchTag()">Load TAG →</button>
      </div>

      <div id="setup-tag-info"></div>
      <div id="setup-form" style="display:none"></div>

      ${buildSetupLogHtml()}
    </div>`;
}

function buildSetupLogHtml() {
  const list = (S.setupApprovals || [])
    .slice()
    .sort((a, b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0))
    .slice(0, 60);
  if (!list.length) return '';

  const canDelete = S.sess?.role === 'admin' || S.sess?.role === 'hod' || S.sess?.role === 'supervisor';

  return `
    <div class="card" style="margin-top:12px">
      <div class="card-hd"><i class="ti ti-clipboard-list"></i> Logged Setups
        <span style="font-size:11px;font-weight:400;color:var(--txt-muted);margin-left:8px">${list.length} recent</span>
      </div>
      ${list.map(sa => setupLogRow(sa, canDelete)).join('')}
    </div>`;
}

function setupLogRow(sa, canDelete) {
  const statusColor = sa.status === 'approved' ? 'var(--ok)' : sa.status === 'rejected' ? 'var(--err)' : 'var(--warn)';
  return `
    <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px;
                padding:10px 0;border-bottom:1px solid var(--bdr)">
      <div style="flex:1;min-width:0">
        <div style="font-weight:700;font-size:13px;font-family:monospace">${sa.tagId || '—'}
          <span style="font-weight:400;font-size:11px;font-family:inherit;color:var(--txt-muted);margin-left:6px">${sa.opName || ''}</span>
        </div>
        <div style="font-size:11px;color:var(--txt-muted);margin-top:2px">
          ${sa.machineName || sa.machineId || '—'} · ${sa.date || ''} Shift ${sa.shift || '—'}
          · ${sa.setupMins || 0} min
        </div>
        <div style="font-size:11px;color:var(--txt-muted)">${sa.operatorName || sa.requestedByName || '—'}</div>
      </div>
      <div style="display:flex;align-items:center;gap:6px;flex-shrink:0">
        <span style="font-size:10px;font-weight:700;background:${statusColor};color:#fff;
                     border-radius:4px;padding:3px 8px;text-transform:uppercase">${sa.status}</span>
        ${canDelete ? `
        <button class="btn btn-ic" style="background:var(--err);border-color:var(--err);color:#fff;width:36px;height:36px"
          onclick="confirmDeleteSetup('${sa.id}')" aria-label="Delete setup log">
          <i class="ti ti-trash"></i>
        </button>` : ''}
      </div>
    </div>`;
}

function confirmDeleteSetup(id) {
  const sa = (S.setupApprovals || []).find(x => x.id === id);
  if (!sa) { toast('Setup not found'); return; }
  openModal(`
    <div class="modal-handle"></div>
    <div class="modal-title">Delete Setup Log?</div>
    <div style="background:var(--bg);border-radius:var(--rs);padding:12px;margin-bottom:14px;font-size:13px">
      <div style="font-weight:700;font-family:monospace">${sa.tagId || '—'}</div>
      <div style="color:var(--txt-muted);font-size:12px;margin-top:4px">
        ${sa.machineName || '—'} · ${sa.opName || '—'}<br>
        ${sa.date || ''} · Shift ${sa.shift || '—'} · ${sa.setupMins || 0} min
      </div>
    </div>
    <div class="ebox" style="font-weight:700;margin-bottom:14px">
      <i class="ti ti-alert-triangle"></i> <div>This will permanently remove the setup record. The duplicate-check guard for this TAG+machine will also be cleared.</div>
    </div>
    <div style="display:flex;gap:8px">
      <button class="btn btn-s" style="flex:1" onclick="closeModal()">Cancel</button>
      <button class="btn btn-d" style="flex:1"
        onclick="closeModal();deleteSetup('${id}')">
        <i class="ti ti-trash"></i> Delete
      </button>
    </div>`);
}

async function deleteSetup(id) {
  try {
    await db.collection('setupApprovals').doc(id).delete();
    S.setupApprovals = (S.setupApprovals || []).filter(x => x.id !== id);
    await logAudit('delete_setup', 'production', id, null, {});
    toast('Setup log deleted ✓');
    switchTab('setup');
  } catch (e) {
    toast('Error deleting setup: ' + e.message);
  }
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
      if (infoDiv) infoDiv.innerHTML = `<div class="ebox">TAG ${tagId} not found</div>`;
      return;
    }

    const validStatuses = ['store_issued','soft_wip','soft_done','ht_done','hard_wip'];
    if (!validStatuses.includes(card.status)) {
      if (infoDiv) infoDiv.innerHTML = `<div class="ebox">TAG status is "${card.status}" — expected: store_issued / soft_done / ht_done</div>`;
      return;
    }

    _setupCard  = card;
    _setupTagId = tagId;

    if (!_setupStage) {
      _setupStage = (card.status === 'ht_done' || card.status === 'hard_wip') ? 'hard' : 'soft';
    }

    // Hard stage: heatCode required
    if (_setupStage === 'hard' && !card.heatCode) {
      if (infoDiv) infoDiv.innerHTML = `<div class="ebox">Hard stage setup requires a heat code. This TAG has not cleared Heat Treatment.</div>`;
      return;
    }

    const partOpsForStage = (S.partOps || [])
      .filter(po => po.partId === card.partId && po.workCenterType === _setupStage)
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
            <div class="wbox" style="flex-direction:column;align-items:stretch">
              <div style="font-weight:700;font-size:13px"><i class="ti ti-alert-triangle"></i> Sequence Deviation Detected</div>
              <div style="font-size:12px;margin-top:2px">
                Previous operation "<strong>${prevOpName}</strong>" (seq ${prevRequired.seqNo}) has no completion on this TAG.
              </div>
              <div style="font-size:11px;margin-top:4px">
                If it <strong>was</strong> produced this shift (report not filed yet), you can verify it on submit.
              </div>
              <button class="btn btn-warn btn-sm btn-full" style="margin-top:8px"
                onclick="seqResolveFromUi()">
                Verify / Resolve Prior Op
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
      <div class="sbox" style="flex-direction:column;align-items:stretch;font-size:13px">
        <div style="font-weight:700;margin-bottom:6px"><i class="ti ti-circle-check"></i> TAG Valid</div>
        <div class="kv-row" style="padding:3px 0"><span class="text-muted">TAG</span><strong style="font-family:monospace;color:var(--acc);margin-left:auto">${tagId}</strong></div>
        <div class="kv-row" style="padding:3px 0"><span class="text-muted">Part</span><strong style="margin-left:auto;text-align:right">${card.partName}</strong></div>
        <div class="kv-row" style="padding:3px 0"><span class="text-muted">Part No.</span><span style="font-family:monospace;margin-left:auto">${card.partNo}</span></div>
        <div class="kv-row" style="padding:3px 0"><span class="text-muted">Customer</span><span style="margin-left:auto;text-align:right">${card.customerName || '—'}</span></div>
        <div class="kv-row" style="padding:3px 0"><span class="text-muted">Batch</span><span style="font-family:monospace;margin-left:auto">${card.batchCode || '—'}</span></div>
        ${card.heatCode ? `<div class="kv-row" style="padding:3px 0"><span class="text-muted">Heat Code</span><strong style="color:var(--ok);margin-left:auto"><i class="ti ti-flame"></i> ${card.heatCode}</strong></div>` : ''}
        <div class="kv-row" style="padding:3px 0"><span class="text-muted">Qty on TAG</span><strong style="color:var(--acc);margin-left:auto">${card.currentQty} pcs</strong></div>
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
    if (infoDiv) infoDiv.innerHTML = `<div class="ebox">Error: ${e.message}</div>`;
  }
}

/* — Sequence Deviation Confirm Modal — */
function showDeviationConfirmModal(tagId, missingOpName, missingSeqNo) {
  openModal(`
    <div class="modal-handle"></div>
    <div style="text-align:center;margin-bottom:12px">
      <div style="width:56px;height:56px;border-radius:28px;background:var(--warn-bg);border:2px solid var(--warn);display:inline-flex;align-items:center;justify-content:center;font-size:26px;color:var(--warn)"><i class="ti ti-alert-triangle"></i></div>
    </div>
    <div class="mtit" style="color:var(--warn);justify-content:center">Log Sequence Deviation?</div>
    <p style="font-size:13px;color:var(--txt-muted);text-align:center;margin-bottom:12px">
      You are about to request a <strong>sequence deviation</strong> for:
    </p>
    <div class="wbox" style="flex-direction:column;align-items:stretch;font-size:13px">
      <div><strong>TAG:</strong> ${tagId}</div>
      <div style="margin-top:4px"><strong>Missing Operation:</strong> ${missingOpName} (seq ${missingSeqNo})</div>
    </div>
    <p style="font-size:12px;color:var(--txt-muted);text-align:center;margin:14px 0 16px">
      This sends a request to the <strong>Plant Head</strong> for approval. Only proceed if this deviation is <strong>intentional and required</strong>.
    </p>
    <div style="display:flex;gap:10px">
      <button class="btn btn-s" style="flex:1" onclick="closeModal()">Cancel — Go Back</button>
      <button class="btn btn-warn" style="flex:1" onclick="closeModal();confirmRequestDeviation('${tagId}','${missingOpName.replace(/'/g,"\\'")}',${missingSeqNo})">
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
    await logAudit('seq_deviation_request', 'production', tagId, null, { missingOpName, missingSeqNo });
    toast('Deviation request sent to Plant Head ✓ — submitting setup…');
    // Allow the setup to proceed now that the deviation has been formally requested
    _setupDeviationCleared = true;
    await submitSetupLog();
  } catch (e) { toast('Error: ' + e.message); }
}

/* ── Sequence verification ("was the prior op done THIS shift?") ──────────
   opHistory is written at shift-end, but setup happens mid-shift, so a prior
   op may be missing from opHistory even though it was already produced (its
   run is sitting in this shift's prodDraft). This flow auto-checks the draft,
   then falls back to operator attestation (qty + TAG re-scan). On success a
   ZERO-QTY completion marker is written to the card so the sequence is
   satisfied immediately — the real qty still flows from the shift report, so
   nothing is double-counted. A genuine "No" routes to the deviation request. */

const _opName = (id) => (S.operations || []).find(o => o.id === id)?.name || id;

/** Build the sequence context for the currently-selected setup op. */
function _setupSeqContext() {
  if (!_setupCard) return null;
  const machVal   = document.getElementById('setup-mach')?.value || '';
  const machStage = machVal.split('|')[2] || '';
  const stage     = machStage || _setupStage;
  const opId      = document.getElementById('setup-op-sel')?.value || '';
  const date      = document.getElementById('setup-date')?.value || dateStr();
  const shift     = document.getElementById('setup-shift')?.value || '';
  if (!opId) return null;

  const allOps = (S.partOps || [])
    .filter(po => po.partId === _setupCard.partId && po.workCenterType === stage)
    .sort((a, b) => (a.seqNo || 0) - (b.seqNo || 0));
  const completed = (_setupCard.opHistory || [])
    .filter(h => h.stage === stage).map(h => h.opId);
  const selIdx = allOps.findIndex(po => po.opId === opId);
  const missing = (selIdx < 0 ? [] : allOps.slice(0, selIdx))
    .filter(po => !completed.includes(po.opId));
  return { missing, allOps, selOpId: opId, stage, date, shift };
}

/** Banner entry point — verify/resolve prior op for the displayed selection. */
function seqResolveFromUi() {
  const ctx = _setupSeqContext();
  if (!ctx || !ctx.missing.length) { toast('No sequence issue on the selected operation'); return; }
  startSeqResolve(ctx);
}

/** Look in THIS shift's production drafts for processed runs of this TAG.
    Returns { opId: totalProcessed }. Fresh query (drafts can be cross-user). */
async function _findRunsInDraft(tagId, stage, date, shift) {
  const draftKey = `${date}_${shift}_${stage}`;
  const totals   = {};
  try {
    const snap = await db.collection('prodDrafts').where('draftKey', '==', draftKey).get();
    snap.forEach(doc => {
      const md = doc.data().machineData || {};
      (md.runs || []).forEach(r => {
        if (r.tagId === tagId && r.opId && (+r.processed || 0) > 0) {
          totals[r.opId] = (totals[r.opId] || 0) + (+r.processed || 0);
        }
      });
    });
  } catch (e) { /* fall back to manual attestation */ }
  return totals;
}

/** Entry: auto-verify from draft, else open the attestation modal. */
async function startSeqResolve(ctx) {
  if (!ctx || !ctx.missing.length) return;
  toast('Checking this shift’s production…');
  const found      = await _findRunsInDraft(_setupTagId, ctx.stage, ctx.date, ctx.shift);
  const verified   = [];
  const unverified = [];
  ctx.missing.forEach(po => {
    const qty = found[po.opId] || 0;
    if (qty > 0) verified.push({ po, qty }); else unverified.push(po);
  });

  if (unverified.length === 0) {
    // Everything confirmed from this shift's draft → record + proceed silently.
    await _recordSeqClears(ctx, verified.map(v => ({ opId: v.po.opId, opName: _opName(v.po.opId), qty: v.qty, from: 'draft' })));
    toast('Prior operation(s) verified from this shift ✓');
    _setupDeviationCleared = true;
    await submitSetupLog();
    return;
  }

  _seqResolveState = { ctx, verified, unverified, attested: [], _attesting: false, _rescanOk: false, _qty: '' };
  _renderSeqResolveModal();
}

function _renderSeqResolveModal() {
  const st = _seqResolveState;
  if (!st) return;
  const cur     = st.unverified[0];
  const curName = _opName(cur.opId);
  const verifiedNote = st.verified.length
    ? `<div class="sbox" style="font-size:12px">
         <i class="ti ti-circle-check"></i>
         <div>Verified from this shift: ${st.verified.map(v => `${_opName(v.po.opId)} (${v.qty} pcs)`).join(', ')}</div>
       </div>`
    : '';

  const body = st._attesting
    ? `<p style="font-size:12px;color:var(--txt-muted);text-align:center;margin-bottom:12px">
         Confirm production of <strong>${curName}</strong> on <strong>${_setupTagId}</strong>.
       </p>
       <div class="f">
         <label>Quantity produced for ${curName} *</label>
         <input id="seq-qty" type="number" min="1" max="${_setupCard.currentQty || 99999}" placeholder="pcs"
           value="${st._qty || ''}" style="font-size:20px;font-weight:700;text-align:center;letter-spacing:1px">
       </div>
       <button class="btn btn-s" style="width:100%;margin-bottom:10px;${st._rescanOk ? 'border-color:var(--ok);color:var(--ok)' : ''}"
         onclick="seqRescanTag()">
         <i class="ti ti-qrcode"></i> ${st._rescanOk ? '✓ TAG confirmed in hand' : 'Scan TAG to confirm'}
       </button>
       <div style="display:flex;flex-direction:column;gap:8px">
         <button class="btn btn-p btn-full" onclick="seqAttestConfirm()">
           <i class="ti ti-check"></i> Confirm &amp; Continue
         </button>
         <button class="btn btn-s btn-full" onclick="_seqResolveState._attesting=false;_renderSeqResolveModal()">
           <i class="ti ti-arrow-left"></i> Back
         </button>
       </div>`
    : `<p style="font-size:13px;color:var(--txt);text-align:center;margin-bottom:14px">
         Was <strong>${curName}</strong> (seq ${cur.seqNo}) produced on <strong>${_setupTagId}</strong> in this shift?
       </p>
       <div style="display:flex;flex-direction:column;gap:8px">
         <button class="btn btn-p btn-full"
           onclick="_seqResolveState._attesting=true;_seqResolveState._rescanOk=false;_renderSeqResolveModal()">
           Yes — I produced it
         </button>
         <button class="btn btn-s btn-full" style="border-color:var(--warn);color:var(--warn)" onclick="seqAttestNo()">
           No — wasn’t done
         </button>
       </div>`;

  openModal(`
    <div class="modal-handle"></div>
    <div style="text-align:center;margin-bottom:12px">
      <div style="width:52px;height:52px;border-radius:26px;background:var(--info-bg);border:2px solid var(--imf-steel);
                  display:inline-flex;align-items:center;justify-content:center;font-size:22px;color:var(--imf-steel)"><i class="ti ti-search"></i></div>
      <div style="font-size:16px;font-weight:800;margin-top:8px">Verify Prior Operation</div>
    </div>
    ${verifiedNote}
    ${body}`);
}

/** Re-scan the TAG to prove the physical card is in hand. Preserves typed qty. */
function seqRescanTag() {
  if (!_seqResolveState) return;
  _seqResolveState._qty = document.getElementById('seq-qty')?.value || '';
  openQrScanner(v => {
    const scanned = (v || '').trim().toUpperCase();
    _seqResolveState._rescanOk = (scanned === _setupTagId);
    if (!_seqResolveState._rescanOk) toast(`Scanned TAG does not match ${_setupTagId}`);
    _renderSeqResolveModal();
  }, 'Scan TAG to confirm');
}

function seqAttestConfirm() {
  const st = _seqResolveState;
  if (!st) return;
  const qty = parseInt(document.getElementById('seq-qty')?.value) || 0;
  if (!qty || qty < 1) { toast('Enter the quantity produced'); return; }
  if (!st._rescanOk)   { toast('Re-scan the TAG to confirm it’s in hand'); return; }
  const cur = st.unverified.shift();
  st.attested.push({ opId: cur.opId, opName: _opName(cur.opId), qty, from: 'attested' });
  st._attesting = false; st._rescanOk = false; st._qty = '';
  if (st.unverified.length === 0) _finishSeqResolve();
  else _renderSeqResolveModal();
}

/** Operator confirms the prior op was genuinely NOT done → real deviation. */
function seqAttestNo() {
  const st = _seqResolveState;
  if (!st) return;
  const cur = st.unverified[0];
  _seqResolveState = null;
  closeModal();
  showDeviationConfirmModal(_setupTagId, _opName(cur.opId), cur.seqNo);
}

/** All prior ops resolved → record markers and resume the setup submit. */
async function _finishSeqResolve() {
  const st = _seqResolveState;
  if (!st) return;
  const clears = [...st.verified.map(v => ({ opId: v.po.opId, opName: _opName(v.po.opId), qty: v.qty, from: 'draft' })),
                  ...st.attested];
  try {
    await _recordSeqClears(st.ctx, clears);
  } catch (e) { toast('Error recording: ' + e.message); return; }
  closeModal();
  _seqResolveState = null;
  toast('Prior operation(s) recorded ✓');
  _setupDeviationCleared = true;
  await submitSetupLog();
}

/** Write zero-qty completion markers to the route card (qty stays single-sourced
    from the shift report → no double-count). Batched + audited. */
async function _recordSeqClears(ctx, clears) {
  if (!clears || !clears.length) return;
  const machVal           = document.getElementById('setup-mach')?.value || '';
  const [machId, machName] = machVal.split('|');
  const batch = db.batch();
  const rcRef = db.collection('routeCards').doc(_setupTagId);

  clears.forEach(c => {
    const entry = {
      stage:       ctx.stage,
      opId:        c.opId,
      opName:      c.opName,
      machineId:   machId   || '',
      machineName: machName || '',
      processed:   0,            // marker only — real qty comes from the shift report
      rejected:    0,
      claimedQty:  c.qty || 0,   // evidence of what the operator/draft reported
      date:        ctx.date,
      shift:       ctx.shift,
      source:      'setup_seq_clear',
      verifiedFrom: c.from,      // 'draft' | 'attested'
      loggedBy:    S.sess.userId,
      loggedAt:    new Date().toISOString(), // serverTS() not allowed inside array elements
    };
    batch.update(rcRef, { opHistory: firebase.firestore.FieldValue.arrayUnion(entry) });
  });
  batch.update(rcRef, { updatedAt: serverTS() });
  await batch.commit();
  await logAudit('setup_seq_clear', 'production', _setupTagId, null, { stage: ctx.stage, clears });

  // Reflect locally so a re-entrant submit/UI sees these ops as satisfied.
  _setupCard.opHistory = [...(_setupCard.opHistory || []),
    ...clears.map(c => ({ stage: ctx.stage, opId: c.opId, source: 'setup_seq_clear', processed: 0 }))];
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

  // ── Sequence gate on the SELECTED operation ─────────────────────────
  // A "missing" prior op may simply not be in opHistory yet because the
  // shift production report (which posts opHistory) is filed at shift-end,
  // while setup is logged mid-shift. So before treating it as a deviation we
  // try to verify the prior op was actually produced THIS shift.
  if (!_setupDeviationCleared) {
    const ctx = _setupSeqContext();
    if (ctx && ctx.missing.length > 0) {
      await startSeqResolve(ctx); // handles its own modals; re-invokes submitSetupLog when cleared
      return;
    }
  }
  _setupDeviationCleared = false; // reset for next setup

  const date     = document.getElementById('setup-date')?.value || dateStr();
  const shift    = document.getElementById('setup-shift')?.value;
  const opId_val = opId;
  const opName   = (S.operations || []).find(o => o.id === opId_val)?.name || '';
  const operId   = document.getElementById('setup-operator')?.value || '';
  const operName = (S.users || []).find(u => u.id === operId)?.name || '';
  const remarks  = document.getElementById('setup-remarks')?.value.trim() || '';
  const resolvedStage = machStage || _setupStage;

  // Duplicate-setup guard. A setup is a re-entry ONLY when the SAME
  // machine + component (part) + process (op) + operator + shift + day already
  // has a pending/approved setup. A DIFFERENT process on the same machine/
  // shift/day (e.g. Shaping Step 2 after Step 1) is a legitimate new setup and
  // must be allowed through — it is not a duplicate.
  const existing = (S.setupApprovals || []).find(sa =>
    sa.machineId  === machId &&
    sa.partId     === _setupCard.partId &&
    sa.opId       === opId_val &&
    sa.operatorId === operId &&
    sa.shift      === shift &&
    sa.date       === date &&
    (sa.status === 'pending' || sa.status === 'approved')
  );
  if (existing) {
    toast(existing.status === 'approved'
      ? 'This exact setup (same machine, part, operation, operator & shift) is already approved ✓'
      : 'A pending setup for this exact machine, part, operation & shift already exists');
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

    S.setupApprovals.unshift({ id: ref.id, tagId: _setupTagId, machineId: machId, stage: resolvedStage, date, status: 'pending' });
    toast('Setup logged ✓ — sent to QC for approval');
    await logAudit('setup_log', 'production', _setupTagId, null, { machineId: machId, opId: opId_val, mins });
    _setupCard = null; _setupTagId = ''; _setupStage = ''; _setupDeviationCleared = false;
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
    : `<div class="sbox" style="justify-content:center"><i class="ti ti-circle-check"></i> No active breakdowns</div>`;

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
  const statusColor = b.status === 'open' ? 'var(--err)' : b.status === 'acknowledged' ? 'var(--warn)' : 'var(--ok)';
  return `
    <div class="card" style="margin-bottom:10px;border-left:4px solid ${statusColor}">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:6px">
        <div>
          <div style="font-weight:700">${b.machineName || mach?.name || '—'}</div>
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

  const now = new Date();
  const timeStr = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
  const defaultShift = getActiveShift().key;

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
        <button class="btn btn-ic" onclick="_reqLines.splice(${i},1);reqRenderLines()" style="background:var(--err-bg);color:var(--err);width:36px;height:36px" aria-label="Remove line"><i class="ti ti-trash"></i></button>
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
  if (r.rejectionReason) h += `<div class="ebox">Rejected: ${r.rejectionReason}</div>`;
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
        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:8px">
          <div style="text-align:center;background:var(--bg);border-radius:6px;padding:6px">
            <div style="font-size:15px;font-weight:800;color:var(--ok)">${r.totalProcessed || 0}</div>
            <div style="font-size:10px;color:var(--txt-muted)">Processed</div>
          </div>
          <div style="text-align:center;background:var(--bg);border-radius:6px;padding:6px">
            <div style="font-size:15px;font-weight:800;color:var(--err)">${(r.machines || []).reduce((s,m)=>s+(m.totalRejected||0),0)}</div>
            <div style="font-size:10px;color:var(--txt-muted)">Rejected</div>
          </div>
          <div style="text-align:center;background:var(--bg);border-radius:6px;padding:6px">
            <div style="font-size:15px;font-weight:800;color:${r.avgOEE>=75?'var(--ok)':r.avgOEE>=50?'var(--warn)':'var(--err)'}">${r.avgOEE || 0}%</div>
            <div style="font-size:10px;color:var(--txt-muted)">Avg OEE</div>
          </div>
        </div>
        ${machUsed.length ? `
          <div style="font-size:11px;font-weight:700;color:var(--txt-muted);margin-bottom:4px">PER MACHINE</div>
          ${machUsed.map(m => `
            <div style="display:flex;flex-wrap:wrap;justify-content:space-between;align-items:baseline;gap:4px 10px;font-size:12px;padding:6px 0;border-bottom:1px solid var(--bdr)">
              <span style="font-weight:600;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1 1 auto">${m.machineName}</span>
              <span style="color:var(--txt-muted);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:0 1 auto">${m.operatorName || '—'}</span>
              <span style="flex-shrink:0"><strong>${m.totalProcessed}</strong> pcs</span>
              <span style="flex-shrink:0;font-weight:600;color:${m.oee>=75?'var(--ok)':m.oee>=50?'var(--warn)':'var(--err)'}">${m.oee || 0}% OEE</span>
            </div>`).join('')}
        ` : ''}
        ${canManageReports() ? `
          <div style="display:flex;gap:8px;margin-top:12px">
            <button class="btn btn-s" style="flex:1" onclick="editReportFromList('${r.id}')">
              <i class="ti ti-edit"></i> Edit
            </button>
            <button class="btn btn-s" style="flex:1;border-color:var(--err);color:var(--err)" onclick="confirmDeleteReport('${r.id}')">
              <i class="ti ti-trash"></i> Delete
            </button>
          </div>` : ''}
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
