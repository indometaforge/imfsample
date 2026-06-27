/* ═══════════════════════════════════════════════════════════════════
   IMF ProTrack — Heat Treatment & Shot Blasting
   Furnace charge loading, FM/HT/01 process log, heat-code marriage,
   Shot Blasting queue, blank tag scanning for splits, yield audits.

   Collections read:
     htCharges          — furnace charge documents
     shotBlastSessions  — shot blast runs
     routeCards         — TAG status validation and updates
   Collections written:
     htCharges, shotBlastSessions, routeCards, scrapLedger, auditLogs
   ═══════════════════════════════════════════════════════════════════ */

'use strict';

/* ── Constants ── */
const TABS = [
  { key: 'hub',           icon: 'ti-layout-dashboard', label: 'Hub' },
  { key: 'ht_charges',    icon: 'ti-flame',            label: 'HT Charges' },
  { key: 'shot_blasting', icon: 'ti-circles',          label: 'Shot Blasting' },
  { key: 'history',       icon: 'ti-history',          label: 'History' },
];

const HT_FURNACES_CAR = ['CF-1', 'CF-2']; // Carburizing Furnaces
const HT_FURNACES_TMP = ['TF-1', 'TF-2']; // Tempering Furnaces
const MONTH_CODES = 'ABCDEFGHIJKL'; // A=Jan … L=Dec

/* ── State ── */
let _tab = 'hub';
let _chargeMode = 'list';     // 'list' | 'new' | 'detail'
let _selChargeId = '';        // Active HT Charge ID being detailed
let _sbMode = 'list';         // 'list' | 'new' | 'detail'
let _selSbSessionId = '';     // Active Shot Blast Session ID being detailed

let _htComps = [];            // Local array of components for new HT charge
let _sbComps = [];            // Local array of components for new SB session

const S_HT = {
  charges: [],
  sbSessions: [],
  routeCards: [],             // Local cache of routeCards loaded for queues
};

/* ── Boot ── */
async function init() {
  try {
    await initShell();
  } catch (e) {
    clearSess();
    window.location.replace('index.html');
    return;
  }
  await loadHTData();
  render();
  document.getElementById('loading-screen').style.display = 'none';
  document.getElementById('app').style.display = '';
}

async function loadHTData() {
  try {
    const chargesSnap = await db.collection('htCharges').orderBy('createdAt', 'desc').limit(150).get();
    S_HT.charges = chargesSnap.docs.map(d => ({ id: d.id, ...d.data() }));

    const sbSnap = await db.collection('shotBlastSessions').orderBy('createdAt', 'desc').limit(150).get();
    S_HT.sbSessions = sbSnap.docs.map(d => ({ id: d.id, ...d.data() }));

    // Load route cards in sb_pending status to render the pending queue
    const cardsSnap = await db.collection('routeCards').where('status', '==', 'sb_pending').get();
    S_HT.routeCards = cardsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch (e) {
    console.warn('loadHTData:', e.message);
  }
}

async function refreshHT() {
  await loadHTData();
  render();
}

/* ── Helpers ── */
function htChargeNo() {
  const now = new Date();
  const yr = String(now.getFullYear()).slice(-2);
  const mo = MONTH_CODES[now.getMonth()];
  const next = String(S_HT.charges.length + 1).padStart(4, '0');
  return 'I' + yr + mo + next; // e.g. I26F0026
}

function sbSessionNo() {
  const now = new Date();
  const yr = String(now.getFullYear()).slice(-2);
  const mo = MONTH_CODES[now.getMonth()];
  const next = String(S_HT.sbSessions.length + 1).padStart(3, '0');
  return 'SB-' + yr + mo + next; // e.g. SB-26F001
}

function getStatusBadge(status) {
  const meta = {
    store_issued: { cls: 'st-store_issued', icon: 'ti-package-import', label: 'Store Issued' },
    soft_wip:     { cls: 'st-soft_wip',     icon: 'ti-progress',       label: 'Soft WIP' },
    soft_done:    { cls: 'st-soft_done',    icon: 'ti-circle-check',   label: 'Soft Done' },
    ht_queue:     { cls: 'st-ht_queue',     icon: 'ti-flame',          label: 'HT Queue' },
    ht_done:      { cls: 'st-ht_done',      icon: 'ti-temperature',    label: 'HT Done' },
    sb_wip:       { cls: 'st-sb_wip',       icon: 'ti-circles',        label: 'Shot Blast WIP' },
    hard_wip:     { cls: 'st-hard_wip',     icon: 'ti-tool',           label: 'Hard WIP' },
    qc_pending:   { cls: 'st-qc_pending',   icon: 'ti-microscope',     label: 'QC Pending' },
    qc_cleared:   { cls: 'st-qc_cleared',   icon: 'ti-rosette-discount-check', label: 'QC Cleared' },
    dispatched:   { cls: 'st-dispatched',   icon: 'ti-truck-delivery', label: 'Dispatched' },
    scrapped:     { cls: 'st-scrapped',     icon: 'ti-trash-x',        label: 'Scrapped' }
  }[status] || { cls: 'st-store_issued', icon: 'ti-help-circle', label: status };

  return `<span class="imf-badge ${meta.cls}"><i class="ti ${meta.icon}"></i> ${meta.label}</span>`;
}

function getShiftLabel(key) {
  return S.shifts?.[key]?.label || 'Shift ' + key.toUpperCase();
}

/* ── Shell render ── */
function render() {
  const activeHT = S_HT.charges.filter(c => c.status === 'processing').length;
  const activeSB = S_HT.sbSessions.filter(s => s.status === 'in_progress').length;
  const totalAlerts = activeHT + activeSB;

  const tabHtml = TABS.map(t => {
    const active = _tab === t.key;
    let badge = 0;
    if (t.key === 'hub') badge = totalAlerts;
    else if (t.key === 'ht_charges') badge = activeHT;
    else if (t.key === 'shot_blasting') badge = activeSB;

    return `
      <button class="tab${active ? ' active' : ''}" role="tab" aria-selected="${active}"
        onclick="switchTab('${t.key}')">
        <i class="ti ${t.icon}" aria-hidden="true"></i> ${t.label}
        ${badge > 0
          ? `<span class="bdg" style="background:var(--warn);color:#fff;padding:1px 6px;font-size:10px;margin-left:4px;border-radius:var(--rpill)">${badge}</span>`
          : ''}
      </button>`;
  }).join('');

  document.getElementById('page-content').innerHTML = `
    <div style="padding-bottom:80px">
      <div class="tabs" role="tablist">
        ${tabHtml}
      </div>
      <div id="tab-body"></div>
    </div>`;

  renderTab();
}

function switchTab(key) {
  _tab = key;
  if (key !== 'ht_charges') _chargeMode = 'list';
  if (key !== 'shot_blasting') _sbMode = 'list';
  render();
}

function renderTab() {
  const el = document.getElementById('tab-body');
  if (!el) return;
  if      (_tab === 'hub')           renderHub();
  else if (_tab === 'ht_charges')    renderCharges();
  else if (_tab === 'shot_blasting') renderShotBlasting();
  else if (_tab === 'history')       renderHistory();
}

/* ═══════════════════════════════════════════════════════════════════
   TAB: HUB
   ═══════════════════════════════════════════════════════════════════ */
function renderHub() {
  const el = document.getElementById('tab-body');
  if (!el) return;

  const activeHTCharges = S_HT.charges.filter(c => c.status === 'processing');
  const activeSBSessions = S_HT.sbSessions.filter(s => s.status === 'in_progress');
  const pendingSbCards = S_HT.routeCards;

  const todayStr = dateStr();
  const htDoneToday = S_HT.charges.filter(c => c.status === 'completed' && c.completedAt &&
    (c.completedAt.toDate ? _localDateStr(c.completedAt.toDate()) : '') === todayStr).length;
  const sbDoneToday = S_HT.sbSessions.filter(s => s.status === 'completed' && s.completedAt &&
    (s.completedAt.toDate ? _localDateStr(s.completedAt.toDate()) : '') === todayStr).length;

  el.innerHTML = `
    <!-- Running status headers -->
    ${activeHTCharges.length > 0 ? `
      <div style="background:linear-gradient(135deg, #FF9900, #FF5500);color:#fff;border-radius:var(--r);padding:14px 18px;margin-bottom:12px;
                  display:flex;align-items:center;gap:12px;box-shadow:var(--sh-sm)">
        <i class="ti ti-flame animate-pulse" style="font-size:24px;flex-shrink:0"></i>
        <div>
          <div style="font-weight:800">${activeHTCharges.length} Carburizing Run${activeHTCharges.length!==1?'s':''} Active</div>
          <div style="font-size:11px;opacity:.9">Furnaces currently loaded · Logs pending completion</div>
        </div>
        <button onclick="switchTab('ht_charges')"
          style="margin-left:auto;border:none;background:rgba(255,255,255,.25);color:#fff;
                 border-radius:var(--rxs);padding:8px 14px;cursor:pointer;font-size:12px;font-weight:700;white-space:nowrap">
          Open Charges
        </button>
      </div>` : ''}

    ${activeSBSessions.length > 0 ? `
      <div style="background:linear-gradient(135deg, #6366F1, #4F46E5);color:#fff;border-radius:var(--r);padding:14px 18px;margin-bottom:14px;
                  display:flex;align-items:center;gap:12px;box-shadow:var(--sh-sm)">
        <i class="ti ti-circles" style="font-size:24px;flex-shrink:0"></i>
        <div>
          <div style="font-weight:800">${activeSBSessions.length} Shot Blast Session${activeSBSessions.length!==1?'s':''} Active</div>
          <div style="font-size:11px;opacity:.9">Blasting cycle in progress</div>
        </div>
        <button onclick="switchTab('shot_blasting')"
          style="margin-left:auto;border:none;background:rgba(255,255,255,.25);color:#fff;
                 border-radius:var(--rxs);padding:8px 14px;cursor:pointer;font-size:12px;font-weight:700;white-space:nowrap">
          Open Sessions
        </button>
      </div>` : ''}

    <!-- Statistics -->
    <div class="stats-3" style="margin-bottom:16px">
      <div class="stat-card">
        <div class="stat-lbl">HT Runs Active</div>
        <div class="stat-val">${activeHTCharges.length}</div>
        <div class="stat-sub">In furnace</div>
      </div>
      <div class="stat-card ok">
        <div class="stat-lbl">Runs Completed Today</div>
        <div class="stat-val">${htDoneToday + sbDoneToday}</div>
        <div class="stat-sub">${htDoneToday} HT · ${sbDoneToday} Shot Blast</div>
      </div>
      <div class="stat-card info">
        <div class="stat-lbl">Pending Shot Blast</div>
        <div class="stat-val text-mono">${pendingSbCards.reduce((s,c)=>s+c.currentQty, 0)}</div>
        <div class="stat-sub">${pendingSbCards.length} TAGs in queue</div>
      </div>
    </div>

    <!-- Quick action buttons -->
    <div style="display:flex;gap:10px;margin-bottom:20px;flex-wrap:wrap">
      <button class="btn btn-p" style="flex:1;min-height:50px;font-weight:700" onclick="switchTab('ht_charges');htStartNewCharge()">
        <i class="ti ti-plus"></i> New HT Charge
      </button>
      <button class="btn btn-s" style="flex:1;min-height:50px;font-weight:700" onclick="switchTab('shot_blasting');sbStartNewSession()">
        <i class="ti ti-plus"></i> New Shot Blast Run
      </button>
    </div>

    <!-- Lists of Active Processes -->
    <div class="imf-split-layout">
      <div class="imf-split-master" style="width:100%">
        <!-- Active Carburizing Charges -->
        <div class="imf-table-toolbar" style="margin-bottom:6px">
          <div class="imf-table-title" style="font-size:12px;font-weight:800;color:var(--txt-muted);letter-spacing:.05em">ACTIVE HT CARBURIZING CHARGES</div>
        </div>
        ${activeHTCharges.length > 0 
          ? activeHTCharges.map(c => `
              <div class="card" style="margin-bottom:8px;border-left:4px solid var(--warn);cursor:pointer" onclick="viewHTChargeDetail('${c.id}')">
                <div style="display:flex;align-items:center;justify-content:space-between;gap:8px">
                  <div>
                    <div class="imf-mono" style="font-weight:800;font-size:14px;color:var(--imf-navy)">${c.chargeNo}</div>
                    <div style="font-size:11px;color:var(--txt-muted);margin-top:2px">
                      Furnace: <strong>${c.furnaceNo}</strong> · Shift: ${getShiftLabel(c.shift)} · Date: ${fmtDate(c.date)}
                    </div>
                  </div>
                  <span class="imf-badge st-ht_queue"><i class="ti ti-flame animate-pulse"></i> In Furnace</span>
                </div>
              </div>`).join('')
          : `<div class="card text-center" style="padding:16px;color:var(--txt-muted);font-size:12px;margin-bottom:12px">No active carburizing runs</div>`
        }

        <!-- Active Shot Blasting Runs -->
        <div class="imf-table-toolbar" style="margin-top:16px;margin-bottom:6px">
          <div class="imf-table-title" style="font-size:12px;font-weight:800;color:var(--txt-muted);letter-spacing:.05em">ACTIVE SHOT BLAST RUNS</div>
        </div>
        ${activeSBSessions.length > 0
          ? activeSBSessions.map(s => `
              <div class="card" style="margin-bottom:8px;border-left:4px solid var(--accent-violet);cursor:pointer" onclick="viewSbSessionDetail('${s.id}')">
                <div style="display:flex;align-items:center;justify-content:space-between;gap:8px">
                  <div>
                    <div class="imf-mono" style="font-weight:800;font-size:14px;color:var(--imf-navy)">${s.sessionNo}</div>
                    <div style="font-size:11px;color:var(--txt-muted);margin-top:2px">
                      Machine: <strong>${s.machineId}</strong> · Shift: ${getShiftLabel(s.shift)} · Operator: ${s.operator||'—'}
                    </div>
                  </div>
                  <span class="imf-badge st-sb_wip"><i class="ti ti-circles animate-pulse"></i> Blasting</span>
                </div>
              </div>`).join('')
          : `<div class="card text-center" style="padding:16px;color:var(--txt-muted);font-size:12px;margin-bottom:12px">No active shot blast runs</div>`
        }
      </div>
    </div>
    
    <div style="display:flex;justify-content:flex-end;margin-top:12px">
      <button class="btn btn-s btn-sm" onclick="refreshHT()"><i class="ti ti-refresh"></i> Refresh Hub</button>
    </div>`;
}

/* ═══════════════════════════════════════════════════════════════════
   TAB: HEAT TREATMENT CHARGES
   ═══════════════════════════════════════════════════════════════════ */
function renderCharges() {
  const el = document.getElementById('tab-body');
  if (!el) return;

  if (_chargeMode === 'new') {
    renderNewCharge();
    return;
  }
  if (_chargeMode === 'detail') {
    renderHTDetail(_selChargeId);
    return;
  }

  const active = S_HT.charges.filter(c => c.status !== 'completed');
  const completed = S_HT.charges.filter(c => c.status === 'completed');

  el.innerHTML = `
    <div style="display:flex;gap:8px;margin-bottom:14px;align-items:center">
      <button class="btn btn-p" onclick="htStartNewCharge()"><i class="ti ti-plus"></i> New Carburizing Charge</button>
      <button class="btn btn-s btn-sm" style="margin-left:auto" onclick="refreshHT()"><i class="ti ti-refresh"></i></button>
    </div>

    <div class="imf-table-toolbar" style="margin-bottom:6px">
      <div class="imf-table-title" style="font-size:12px;font-weight:800;color:var(--txt-muted);letter-spacing:.05em">ACTIVE FURNACE RUNS (${active.length})</div>
    </div>
    ${active.length > 0 ? active.map(htChargeRowCard).join('') : `<div class="card text-center" style="padding:20px;color:var(--txt-muted);font-size:12px;margin-bottom:14px">No active carburizing runs</div>`}

    <div class="imf-table-toolbar" style="margin-top:16px;margin-bottom:6px">
      <div class="imf-table-title" style="font-size:12px;font-weight:800;color:var(--txt-muted);letter-spacing:.05em">RECENT COMPLETED RUNS</div>
    </div>
    ${completed.length > 0 ? completed.slice(0, 10).map(htChargeRowCard).join('') : `<div class="card text-center" style="padding:20px;color:var(--txt-muted);font-size:12px">No completed runs recorded</div>`}
  `;
}

function htChargeRowCard(c) {
  const isClosed = c.status === 'completed';
  const tagCount = (c.components || []).length;
  const totalQty = (c.components || []).reduce((s, t) => s + (t.qty || 0), 0);
  
  return `
    <div class="card" style="margin-bottom:10px;border-left:4px solid ${isClosed ? 'var(--ok)' : 'var(--warn)'}">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px;margin-bottom:8px">
        <div>
          <div class="imf-mono" style="font-weight:800;font-size:15px;color:var(--imf-navy)">${c.chargeNo}</div>
          <div style="font-size:11px;color:var(--txt-muted);margin-top:2px">
            Furnace: <strong>${c.furnaceNo}</strong> · Shift: ${getShiftLabel(c.shift)} · Date: ${fmtDate(c.date)}
          </div>
          <div style="font-size:11px;color:var(--txt-muted)">Created by: ${c.createdByName || '—'}</div>
        </div>
        ${isClosed 
          ? `<span class="imf-badge st-qc_cleared"><i class="ti ti-circle-check"></i> Finished</span>`
          : `<span class="imf-badge st-ht_queue"><i class="ti ti-flame animate-pulse"></i> In Furnace</span>`
        }
      </div>

      <div style="background:var(--fill);border-radius:var(--rxs);padding:8px 10px;margin-bottom:10px">
        <div style="font-size:10px;font-weight:700;color:var(--txt-muted);letter-spacing:.06em;margin-bottom:4px">
          COMPONENTS (${tagCount} TAGs · ${totalQty} pcs)
        </div>
        ${(c.components || []).map(comp => `
          <div style="display:flex;justify-content:space-between;font-size:11px;padding:2px 0">
            <span class="imf-mono" style="font-weight:600;font-size:10.5px">${comp.tagId}</span>
            <span style="color:var(--txt-muted)">${comp.name} · ${comp.qty} pcs</span>
          </div>`).join('')}
      </div>

      <div style="display:flex;gap:8px">
        <button class="btn btn-s btn-sm" style="flex:1" onclick="viewHTChargeDetail('${c.id}')">
          <i class="ti ${isClosed ? 'ti-eye' : 'ti-edit'}"></i> ${isClosed ? 'View Logs' : 'Log Furnace Data'}
        </button>
        ${!isClosed ? `
          <button class="btn btn-ok btn-sm" style="flex:1" onclick="htOpenFinalizeModal('${c.id}')">
            <i class="ti ti-circle-check"></i> Complete Charge
          </button>` : ''}
      </div>
    </div>
  `;
}

function htStartNewCharge() {
  _chargeMode = 'new';
  _htComps = [];
  render();
}

function viewHTChargeDetail(id) {
  _chargeMode = 'detail';
  _selChargeId = id;
  render();
}

/* ── New HT Charge Form ── */
function renderNewCharge() {
  const el = document.getElementById('tab-body');
  if (!el) return;

  const chargeNo = htChargeNo();

  el.innerHTML = `
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:14px">
      <button class="btn btn-s btn-sm" onclick="_chargeMode='list';render()"><i class="ti ti-arrow-left"></i> Back</button>
      <div style="font-size:15px;font-weight:800">New HT Carburizing Run</div>
    </div>

    <div class="card" style="margin-bottom:12px">
      <div style="font-size:11px;font-weight:700;color:var(--txt-muted);letter-spacing:.06em;margin-bottom:10px">1. CHARGE HEADER</div>
      <div class="row-2">
        <div class="f">
          <label>Date</label>
          <input id="ht-date" type="date" value="${dateStr()}">
        </div>
        <div class="f">
          <label>Shift</label>
          <select id="ht-shift">
            ${Object.entries(S.shifts || {}).map(([k,v])=>`<option value="${k}" ${getActiveShift().key===k?'selected':''}>${v.label}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="row-2" style="margin-top:10px">
        <div class="f">
          <label>Carburizing Furnace</label>
          <select id="ht-cfno">
            ${HT_FURNACES_CAR.map(f=>`<option value="${f}">${f}</option>`).join('')}
          </select>
        </div>
        <div class="f">
          <label>Rev No.</label>
          <input id="ht-rev" type="text" value="03/01.04.2026">
        </div>
      </div>
    </div>

    <div class="card" style="margin-bottom:12px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
        <div style="font-size:11px;font-weight:700;color:var(--txt-muted);letter-spacing:.06em">2. COMPONENTS IN CHARGE</div>
        <button class="btn btn-s btn-sm" onclick="htOpenAddCompModal()">+ Add TAG</button>
      </div>
      <div id="ht-comp-list-wrapper">
        <!-- Rendered by htRenderComps() -->
      </div>
    </div>

    <div class="card" style="margin-bottom:12px">
      <div style="font-size:11px;font-weight:700;color:var(--txt-muted);letter-spacing:.06em;margin-bottom:10px">3. DOT PUNCHING</div>
      <div class="wbox" style="margin-bottom:10px;font-size:12px;font-weight:600">
        <i class="ti ti-alert-circle"></i> Required for all customers except M&M. Mark as done before washing.
      </div>
      <div class="row-2">
        <div class="f">
          <label>Done by (Person)</label>
          <input id="ht-dp-who" type="text" placeholder="e.g. Suresh Kumar" list="ht-op-list-names">
        </div>
        <div class="f">
          <label>Time of Dot Punching</label>
          <input id="ht-dp-time" type="time" value="${new Date().toTimeString().slice(0,5)}">
        </div>
      </div>
      <div style="display:flex;align-items:center;justify-content:space-between;margin-top:12px;background:var(--fill);padding:8px 12px;border-radius:var(--rs)">
        <span style="font-size:12px;font-weight:700">Dot punching confirmed ✓</span>
        <label class="tsw"><input type="checkbox" id="ht-dp-done"><span class="tsl"></span></label>
      </div>
      <label id="ht-dp-warning" style="display:none;color:var(--warn);font-size:11px;font-weight:700;margin-top:6px"></label>
      <datalist id="ht-op-list-names">
        ${S.users.filter(u=>u.role==='operator'||u.stage==='ht'||u.stage==='general').map(u=>`<option value="${u.name}">`).join('')}
      </datalist>
    </div>

    <div class="card" style="margin-bottom:14px">
      <div style="font-size:11px;font-weight:700;color:var(--txt-muted);letter-spacing:.06em;margin-bottom:10px">4. PRE-WASH</div>
      <div class="wbox" style="margin-bottom:10px;font-size:12px">
        50–70°C · pH 09-12 · 3 to 5 min cycle time
      </div>
      <div class="row-2">
        <div class="f">
          <label>Wash Start Time</label>
          <input id="ht-wash-start" type="time">
        </div>
        <div class="f">
          <label>Wash End Time</label>
          <input id="ht-wash-end" type="time">
        </div>
      </div>
      <div class="row-2" style="margin-top:10px">
        <div class="f">
          <label>Bath Temp (°C)</label>
          <input id="ht-wash-temp" type="number" placeholder="50–70" min="50" max="70">
        </div>
        <div class="f">
          <label>pH Reading</label>
          <input id="ht-wash-ph" type="number" step="0.1" placeholder="9–12">
        </div>
      </div>
    </div>

    <div id="new-charge-err" style="display:none;color:var(--err);font-weight:700;font-size:12px;margin-bottom:10px"></div>

    <button class="btn btn-p" style="width:100%;min-height:48px;font-weight:700" onclick="htSubmitNewCharge()">
      <i class="ti ti-flame"></i> Load Furnace &amp; Start Run
    </button>
    
    ${TEST_MODE ? `<button class="btn btn-s" style="width:100%;margin-top:8px;background:#FEF3C7;color:#78350F;border-color:#FEF3C7" onclick="htQuickFillNewCharge()">⚡ Quick Fill (Test defaults)</button>` : ''}
  `;

  htRenderComps();
}

function htRenderComps() {
  const el = document.getElementById('ht-comp-list-wrapper');
  if (!el) return;

  if (!_htComps.length) {
    el.innerHTML = `<div class="text-xs text-muted text-center" style="padding:12px 0">No components added to charge. Scan a TAG above.</div>`;
    return;
  }

  el.innerHTML = `
    <div class="imf-tablewrap">
      <table class="imf-table" style="width:100%">
        <thead>
          <tr>
            <th>TAG</th>
            <th>Part Name</th>
            <th class="num">Qty</th>
            <th>Fixture</th>
            <th style="width:40px"></th>
          </tr>
        </thead>
        <tbody>
          ${_htComps.map((c, i) => `
            <tr>
              <td class="imf-mono" style="font-weight:700">${c.tagId}</td>
              <td>
                <div style="font-weight:600">${c.name}</div>
                <div class="text-xs text-muted">${c.partNo} · Batch: ${c.batchCode}</div>
              </td>
              <td class="num imf-mono">${c.qty}</td>
              <td class="imf-mono">${c.fixtureNo || '—'}</td>
              <td>
                <button class="btn btn-d btn-sm" style="padding:4px 6px" onclick="htRemoveComp(${i})">
                  <i class="ti ti-trash"></i>
                </button>
              </td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>
  `;
}

function htRemoveComp(idx) {
  _htComps.splice(idx, 1);
  htRenderComps();
  htUpdateDotPunchWarning();
}

function htUpdateDotPunchWarning() {
  const warningEl = document.getElementById('ht-dp-warning');
  if (!warningEl) return;
  
  // Check if any component is NOT M&M
  const nonMM = _htComps.some(c => (c.customerName || '').trim().toUpperCase() !== 'M&M');
  if (nonMM && _htComps.length > 0) {
    warningEl.style.display = 'block';
    warningEl.textContent = '⚠️ Non-M&M parts loaded. Dot Punching is COMPULSORY for this charge.';
  } else {
    warningEl.style.display = 'none';
  }
}

/* ── Add component to charge modal ── */
function htOpenAddCompModal() {
  openModal(`
    <div class="modal-handle"></div>
    <div class="modal-title">Scan Route Card for Furnace Charge</div>
    <div id="qr-reader-ht" style="width:100%;border-radius:12px;overflow:hidden;margin-bottom:10px"></div>
    <div style="display:flex;gap:6px;margin-bottom:12px">
      <input id="htc-tag-input" type="text" placeholder="Type TAG number (e.g. TAG042)" oninput="this.value=this.value.toUpperCase()" style="font-weight:700">
      <button class="btn btn-p" onclick="htLookupTag()">Load Info</button>
    </div>
    <div id="htc-tag-info" style="display:none;background:var(--fill);border-radius:var(--r);padding:12px;margin-bottom:12px;font-size:12.5px"></div>
    <div class="f" style="margin-bottom:10px">
      <label>Qty to load into furnace</label>
      <input id="htc-qty" type="number" min="1" placeholder="—" style="font-weight:700">
    </div>
    <div class="row-2">
      <div class="f">
        <label>Fixture No.</label>
        <input id="htc-fixture" type="text" placeholder="e.g. F-12">
      </div>
      <div class="f">
        <label>Remarks</label>
        <input id="htc-remarks" type="text" placeholder="Optional">
      </div>
    </div>
    <button class="btn btn-ok" id="htc-confirm-btn" style="width:100%;margin-top:14px;display:none" onclick="htConfirmAddComp()">
      ✓ Add to Charge
    </button>
    <button class="btn btn-s" style="width:100%;margin-top:8px" onclick="htCloseAddCompModal()">Cancel</button>
  `);

  setTimeout(() => {
    try {
      window._html5Qr = new Html5Qrcode('qr-reader-ht');
      window._html5Qr.start(
        { facingMode: 'environment' },
        { fps: 10, qrbox: { width: 250, height: 120 }, aspectRatio: 1.5 },
        (decoded) => {
          const el = document.getElementById('htc-tag-input');
          if (el) {
            el.value = decoded.toUpperCase();
            htLookupTag();
          }
          htCloseScanner();
        },
        () => {}
      ).catch(() => {});
    } catch (e) {}
  }, 250);
}

function htCloseScanner() {
  if (window._html5Qr) {
    window._html5Qr.stop().catch(() => {}).finally(() => {
      window._html5Qr.clear();
      window._html5Qr = null;
    });
  }
}

function htCloseAddCompModal() {
  htCloseScanner();
  closeModal();
}

async function htLookupTag() {
  const tagId = (document.getElementById('htc-tag-input')?.value || '').trim().toUpperCase();
  if (!tagId) { toast('Enter a TAG UID'); return; }
  if (!tagId.match(/^TAG\d+(\-S\d+)?$/)) { toast('Invalid TAG format'); return; }

  if (_htComps.find(c => c.tagId === tagId)) { toast(tagId + ' already added to charge'); return; }

  try {
    const card = await fetchRouteCard(tagId);
    if (!card) { toast('Route Card not found'); return; }

    const validStatuses = ['store_issued', 'soft_wip', 'soft_done'];
    if (!validStatuses.includes(card.status)) {
      toast(`${tagId} status is "${card.status}" — expected store_issued, soft_wip, or soft_done`);
      return;
    }

    const info = document.getElementById('htc-tag-info');
    if (info) {
      info.style.display = 'block';
      info.innerHTML = `
        <div style="font-weight:700;font-family:monospace;color:var(--imf-navy)">${tagId}</div>
        <div style="font-weight:600">${card.partName || ''}</div>
        <div class="text-xs text-muted">${card.partNo || ''} · Batch: ${card.batchCode || '—'}</div>
        <div class="text-xs text-muted">Available qty: <strong>${card.currentQty}</strong></div>
      `;
    }

    const qtyEl = document.getElementById('htc-qty');
    if (qtyEl) qtyEl.value = card.currentQty;

    window._htcCardData = {
      tagId,
      partId: card.partId,
      partNo: card.partNo || '',
      partName: card.partName || '',
      batchCode: card.batchCode || '',
      masterLotCode: card.masterLotCode || '',
      customerName: card.customerName || '',
      currentQty: card.currentQty
    };

    const confirmBtn = document.getElementById('htc-confirm-btn');
    if (confirmBtn) confirmBtn.style.display = 'block';
    htCloseScanner();
  } catch (e) {
    toast('Error loading TAG: ' + friendlyError(e));
  }
}

function htConfirmAddComp() {
  const qty = parseInt(document.getElementById('htc-qty')?.value || '0') || 0;
  if (qty <= 0) { toast('Enter quantity'); return; }
  if (qty > window._htcCardData.currentQty) { toast('Cannot exceed available tag quantity'); return; }

  _htComps.push({
    tagId: window._htcCardData.tagId,
    partId: window._htcCardData.partId,
    partNo: window._htcCardData.partNo,
    name: window._htcCardData.partName,
    batchCode: window._htcCardData.batchCode,
    masterLotCode: window._htcCardData.masterLotCode,
    customerName: window._htcCardData.customerName,
    qty,
    fixtureNo: document.getElementById('htc-fixture')?.value.trim() || '',
    remarks: document.getElementById('htc-remarks')?.value.trim() || '',
  });

  window._htcCardData = null;
  closeModal();
  htRenderComps();
  htUpdateDotPunchWarning();
}

function htQuickFillNewCharge() {
  document.getElementById('ht-dp-who').value = S.sess.name;
  document.getElementById('ht-dp-done').checked = true;
  document.getElementById('ht-wash-start').value = '08:00';
  document.getElementById('ht-wash-end').value = '08:10';
  document.getElementById('ht-wash-temp').value = '65';
  document.getElementById('ht-wash-ph').value = '10.5';

  // Load first soft_done card in mock cache if no comps
  if (!_htComps.length) {
    const mockCard = S.routeCards[0] || { id: 'TAG-001', partId: 'P1', partNo: 'PN1', partName: 'Test Part', batchCode: 'B1', currentQty: 100, customerName: 'TATA' };
    _htComps.push({
      tagId: mockCard.id,
      partId: mockCard.partId,
      partNo: mockCard.partNo,
      name: mockCard.partName,
      batchCode: mockCard.batchCode,
      masterLotCode: 'L-1',
      customerName: mockCard.customerName,
      qty: mockCard.currentQty || 100,
      fixtureNo: 'F-01',
      remarks: 'Quick fill test',
    });
    htRenderComps();
  }
  toast('⚡ Header defaults and sample components filled');
}

async function htSubmitNewCharge() {
  const errEl = document.getElementById('new-charge-err');
  if (errEl) errEl.style.display = 'none';

  if (!_htComps.length) {
    if (errEl) { errEl.textContent = 'Add at least one component to the charge.'; errEl.style.display = 'block'; }
    return;
  }

  // Validate dot punching if non-M&M customer exists
  const nonMM = _htComps.some(c => (c.customerName || '').trim().toUpperCase() !== 'M&M');
  const dpDone = document.getElementById('ht-dp-done').checked;
  const dpWho = document.getElementById('ht-dp-who').value.trim();
  const dpTime = document.getElementById('ht-dp-time').value;

  if (nonMM && !dpDone) {
    if (errEl) { errEl.textContent = 'Dot punching is compulsory for non-M&M customers. Please confirm and check the box.'; errEl.style.display = 'block'; }
    return;
  }

  const furnace = document.getElementById('ht-cfno').value;
  const date = document.getElementById('ht-date').value;
  const shift = document.getElementById('ht-shift').value;
  const revNo = document.getElementById('ht-rev').value;
  const chargeNo = htChargeNo();

  const washStart = document.getElementById('ht-wash-start').value;
  const washEnd = document.getElementById('ht-wash-end').value;
  const washTemp = parseInt(document.getElementById('ht-wash-temp').value) || null;
  const washPh = parseFloat(document.getElementById('ht-wash-ph').value) || null;

  try {
    const batch = db.batch();
    const now = serverTS();

    const chargeRef = db.collection('htCharges').doc(chargeNo);
    batch.set(chargeRef, {
      chargeNo,
      status: 'processing',
      date,
      shift,
      furnaceNo: furnace,
      revNo,
      components: _htComps,
      dotPunch: { done: dpDone, who: dpWho, time: dpTime },
      prewash: { startTime: washStart, endTime: washEnd, temp: washTemp, ph: washPh },
      loading: null,
      tempReadings: [],
      quenching: null,
      tempering: null,
      inspection: null,
      downtimes: null,
      createdBy: S.sess.userId,
      createdByName: S.sess.name,
      createdAt: now,
      updatedAt: now,
    });

    // Update each TAG: status -> ht_queue
    for (const comp of _htComps) {
      batch.update(db.collection('routeCards').doc(comp.tagId), {
        status: 'ht_queue',
        htChargeId: chargeNo,
        updatedAt: now,
      });
    }

    await batch.commit();
    await logAudit('HT_CHARGE_CREATED', 'HT', chargeNo, null, { furnace, chargeNo, tagsCount: _htComps.length });
    
    toast(`Charge ${chargeNo} started successfully!`);
    _chargeMode = 'list';
    await refreshHT();
  } catch (e) {
    if (errEl) { errEl.textContent = 'Error starting run: ' + friendlyError(e); errEl.style.display = 'block'; }
  }
}

/* ── HT Charge Details & Daily Process Log ── */
function renderHTDetail(id) {
  const el = document.getElementById('tab-body');
  if (!el) return;

  const c = S_HT.charges.find(x => x.id === id);
  if (!c) {
    el.innerHTML = `<div class="card text-center" style="padding:24px">Charge record not found.</div>`;
    return;
  }

  const isClosed = c.status === 'completed';
  const readings = c.tempReadings || [];
  const q = c.quenching || {};
  const t = c.tempering || {};
  const insp = c.inspection || {};
  const dt = c.downtimes || {};

  el.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">
      <div style="display:flex;align-items:center;gap:8px">
        <button class="btn btn-s btn-sm" onclick="_chargeMode='list';render()"><i class="ti ti-arrow-left"></i> Back</button>
        <div>
          <div class="imf-mono" style="font-weight:800;font-size:16px;color:var(--imf-navy)">${c.chargeNo}</div>
          <div style="font-size:11px;color:var(--txt-muted)">Furnace ${c.furnaceNo} · Shift ${getShiftLabel(c.shift)} · ${fmtDate(c.date)}</div>
        </div>
      </div>
      ${isClosed 
        ? `<span class="imf-badge st-qc_cleared"><i class="ti ti-circle-check"></i> Completed</span>`
        : `<button class="btn btn-ok btn-sm" onclick="htOpenFinalizeModal('${c.id}')"><i class="ti ti-circle-check"></i> Complete Charge</button>`
      }
    </div>

    <!-- 1. Header Information & Wash Logs -->
    <div class="card" style="margin-bottom:12px">
      <div style="font-size:11.5px;font-weight:800;color:var(--imf-navy);letter-spacing:.04em;margin-bottom:10px">1. HEADERS & PREWASH SUMMARY</div>
      <div class="row-2" style="font-size:12.5px;margin-bottom:8px">
        <div><strong>Rev No:</strong> <span class="imf-mono">${c.revNo || '—'}</span></div>
        <div><strong>Operator (DP):</strong> ${c.dotPunch?.who || '—'} (At ${c.dotPunch?.time || '—'})</div>
      </div>
      <div style="background:var(--fill);padding:8px 12px;border-radius:var(--rs);font-size:12px;margin-bottom:10px">
        <strong>Pre-Wash Logs:</strong> ${c.prewash?.startTime || '—'} to ${c.prewash?.endTime || '—'} · Temp: ${c.prewash?.temp || '—'}°C · pH: ${c.prewash?.ph || '—'}
      </div>
      <div style="font-size:11px;font-weight:700;color:var(--txt-muted);letter-spacing:.06em;margin-bottom:4px">COMPONENTS IN CHARGE</div>
      ${(c.components || []).map(comp => `
        <div style="display:flex;justify-content:space-between;align-items:center;font-size:11.5px;padding:3px 0;border-bottom:0.5px solid var(--line-soft)">
          <span class="imf-mono" style="font-weight:700;color:var(--imf-navy)">${comp.tagId}</span>
          <span>${comp.name}</span>
          <span class="imf-mono" style="font-weight:700">${comp.qty} pcs</span>
        </div>`).join('')}
    </div>

    <!-- Section A: Furnace Loading -->
    <div class="card" style="margin-bottom:12px">
      <div style="font-size:11.5px;font-weight:800;color:var(--imf-navy);letter-spacing:.04em;margin-bottom:10px">A. FURNACE LOADING</div>
      <div class="row-2">
        <div class="f">
          <label>Loading Date</label>
          <input id="ht-load-date" type="date" value="${c.loading?.date || c.date}" ${isClosed?'disabled':''}>
        </div>
        <div class="f">
          <label>Loading Time</label>
          <input id="ht-load-time" type="time" value="${c.loading?.time || ''}" ${isClosed?'disabled':''}>
        </div>
      </div>
      <div class="f" style="margin-top:10px">
        <label>Retort Target Temperature (°C)</label>
        <input id="ht-retort-target" type="number" value="${c.loading?.retortTarget || 760}" ${isClosed?'disabled':''}>
      </div>
      ${!isClosed ? `<button class="btn btn-s btn-sm w-full" style="margin-top:12px" onclick="htSaveLoading('${c.id}')"><i class="ti ti-device-floppy"></i> Save Loading Info</button>` : ''}
    </div>

    <!-- Section B: Temperature Readings -->
    <div class="card" style="margin-bottom:12px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
        <div style="font-size:11.5px;font-weight:800;color:var(--imf-navy);letter-spacing:.04em">
          B. TEMPERATURE LOGS <span style="font-weight:400;color:var(--txt-muted)">(${readings.length}/7 logged)</span>
        </div>
        ${!isClosed && readings.length < 7 ? `<button class="btn btn-s btn-sm" onclick="htOpenTempReadingModal('${c.id}')">+ Add Reading</button>` : ''}
      </div>
      <div class="wbox" style="margin-bottom:10px;font-size:11.5px">
        💡 760°C → start Methanol (0.7 L/hr) &nbsp;|&nbsp; 890°C → start Acetone
      </div>
      <div class="imf-tablewrap" style="overflow-x:auto">
        <table class="imf-table" style="width:100%;min-width:600px;font-size:11.5px">
          <thead>
            <tr>
              <th>#</th>
              <th>Time</th>
              <th class="num">Retort°C</th>
              <th class="num">Z1°C</th>
              <th class="num">Z2°C</th>
              <th class="num">MV</th>
              <th class="num">MeOH L/hr</th>
              <th class="num">Acet L/hr</th>
              <th>Remarks</th>
              ${!isClosed ? `<th style="width:40px"></th>` : ''}
            </tr>
          </thead>
          <tbody>
            ${readings.map((r, idx) => `
              <tr style="${r.retort >= 890 ? 'background:#FFFBEB' : r.retort >= 760 ? 'background:#F0FDF4' : ''}">
                <td style="font-weight:700">${idx+1}</td>
                <td class="imf-mono">${r.time || '—'}</td>
                <td class="num imf-mono" style="font-weight:700">${r.retort || '—'}</td>
                <td class="num imf-mono">${r.z1 || '—'}</td>
                <td class="num imf-mono">${r.z2 || '—'}</td>
                <td class="num imf-mono">${r.mv || '—'}</td>
                <td class="num imf-mono">${r.methanol || '—'}</td>
                <td class="num imf-mono">${r.acetone || '—'}</td>
                <td style="max-width:120px;overflow:hidden;text-overflow:ellipsis">${r.remarks || '—'}</td>
                ${!isClosed ? `
                  <td>
                    <button class="btn btn-d btn-sm" style="padding:2px 4px" onclick="htDeleteTempReading('${c.id}', ${idx})">
                      <i class="ti ti-trash" style="font-size:12px"></i>
                    </button>
                  </td>` : ''}
              </tr>`).join('')}
            ${readings.length === 0 ? `<tr><td colspan="10" class="text-center text-muted" style="padding:16px 0">No temp readings recorded yet.</td></tr>` : ''}
          </tbody>
        </table>
      </div>
      ${!isClosed && readings.length < 7 ? `<div style="font-size:11px;color:var(--warn);margin-top:8px;font-weight:700"><i class="ti ti-alert-triangle"></i> ${7 - readings.length} more hourly readings needed.</div>` : ''}
    </div>

    <!-- Section C: Quenching -->
    <div class="card" style="margin-bottom:12px">
      <div style="font-size:11.5px;font-weight:800;color:var(--imf-navy);letter-spacing:.04em;margin-bottom:10px">C. QUENCHING PROCESS &amp; HARDNESS</div>
      <div class="row-2">
        <div class="f">
          <label>Unloading Time</label>
          <input id="ht-q-unload" type="time" value="${q.unloadTime||''}" ${isClosed?'disabled':''}>
        </div>
        <div class="f">
          <label>Quenching Start Time</label>
          <input id="ht-q-start" type="time" value="${q.startTime||''}" ${isClosed?'disabled':''}>
        </div>
      </div>
      <div class="row-2" style="margin-top:10px">
        <div class="f">
          <label>Oil Temperature Before (°C)</label>
          <input id="ht-q-oil-before" type="number" value="${q.oilTempBefore||''}" ${isClosed?'disabled':''}>
        </div>
        <div class="f">
          <label>Oil Temperature After (°C)</label>
          <input id="ht-q-oil-after" type="number" value="${q.oilTempAfter||''}" ${isClosed?'disabled':''}>
        </div>
      </div>
      <div class="row-2" style="margin-top:10px">
        <div class="f">
          <label>Wash Temp After Quench (°C)</label>
          <input id="ht-q-wash-temp" type="number" placeholder="50–70" value="${q.washTemp||''}" ${isClosed?'disabled':''}>
        </div>
        <div class="f">
          <label>pH After Quench</label>
          <input id="ht-q-wash-ph" type="number" step="0.1" placeholder="9–12" value="${q.washPh||''}" ${isClosed?'disabled':''}>
        </div>
      </div>
      <div class="f" style="margin-top:10px">
        <label>Cooling Start Time (15 mins post-quench)</label>
        <input id="ht-q-cool-start" type="time" value="${q.coolingStart||''}" ${isClosed?'disabled':''}>
      </div>

      <div class="f" style="margin-top:12px">
        <label>Surface Hardness as Quenched (7 values)</label>
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:4px">
          ${[0,1,2,3,4,5,6].map(i => `
            <input type="number" step="0.1" placeholder="HRC" style="width:65px;padding:6px;text-align:center;font-weight:700" 
              id="ht-sqhrc-${i}" value="${q.surfHRCQuenched?.[i] || ''}" ${isClosed?'disabled':''}>`).join('')}
          <span style="align-self:center;font-size:12px;font-weight:700;color:var(--txt-muted);margin-left:4px">HRC</span>
        </div>
      </div>
      ${!isClosed ? `<button class="btn btn-s btn-sm w-full" style="margin-top:12px" onclick="htSaveQuenching('${c.id}')"><i class="ti ti-device-floppy"></i> Save Quenching Logs</button>` : ''}
    </div>

    <!-- Section D: Tempering -->
    <div class="card" style="margin-bottom:12px">
      <div style="font-size:11.5px;font-weight:800;color:var(--imf-navy);letter-spacing:.04em;margin-bottom:10px">D. TEMPERING</div>
      <div class="row-2">
        <div class="f">
          <label>Tempering Furnace</label>
          <select id="ht-tfno" ${isClosed?'disabled':''}>
            ${HT_FURNACES_TMP.map(f=>`<option value="${f}" ${t.furnaceNo===f?'selected':''}>${f}</option>`).join('')}
          </select>
        </div>
        <div class="f">
          <label>Tempering Temperature (°C)</label>
          <input id="ht-tmp-temp" type="number" value="${t.temperature||''}" ${isClosed?'disabled':''}>
        </div>
      </div>
      <div class="row-3" style="margin-top:10px">
        <div class="f">
          <label>Loading Time</label>
          <input id="ht-tmp-load" type="time" value="${t.loadingTime||''}" ${isClosed?'disabled':''}>
        </div>
        <div class="f">
          <label>Temp Attended At</label>
          <input id="ht-tmp-atnd" type="time" value="${t.tempAttendedAt||''}" ${isClosed?'disabled':''}>
        </div>
        <div class="f">
          <label>Unloading Time</label>
          <input id="ht-tmp-unload" type="time" value="${t.unloadingTime||''}" ${isClosed?'disabled':''}>
        </div>
      </div>
      ${!isClosed ? `<button class="btn btn-s btn-sm w-full" style="margin-top:12px" onclick="htSaveTempering('${c.id}')"><i class="ti ti-device-floppy"></i> Save Tempering Info</button>` : ''}
    </div>

    <!-- Section E: Inspection Results -->
    <div class="card" style="margin-bottom:12px">
      <div style="font-size:11.5px;font-weight:800;color:var(--imf-navy);letter-spacing:.04em;margin-bottom:10px">E. INSPECTION RESULTS</div>
      <div class="f">
        <label>Surface Hardness After Tempering (4 values)</label>
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:4px">
          ${[0,1,2,3].map(i => `
            <input type="number" step="0.1" placeholder="HRC" style="width:65px;padding:6px;text-align:center;font-weight:700" 
              id="ht-insp-shrc-${i}" value="${insp.surfHRCTempered?.[i] || ''}" ${isClosed?'disabled':''}>`).join('')}
          <span style="align-self:center;font-size:12px;font-weight:700;color:var(--txt-muted);margin-left:4px">HRC</span>
        </div>
      </div>
      <div class="row-2" style="margin-top:10px">
        <div class="f">
          <label>Core Hardness (HRC)</label>
          <input id="ht-insp-chrc" type="number" step="0.1" value="${insp.coreHRC||''}" ${isClosed?'disabled':''}>
        </div>
        <div class="f">
          <label>Core Hardness Pcd (HRC)</label>
          <input id="ht-insp-cpcd" type="number" step="0.1" value="${insp.corePcd||''}" ${isClosed?'disabled':''}>
        </div>
      </div>
      <div class="row-2" style="margin-top:10px">
        <div class="f">
          <label>Micro Case Depth (mm)</label>
          <input id="ht-insp-mcd" type="text" placeholder="e.g. 0.85" value="${insp.microCaseDepth||''}" ${isClosed?'disabled':''}>
        </div>
        <div class="f">
          <label>Effective Case Depth (mm)</label>
          <input id="ht-insp-ecd" type="text" placeholder="e.g. 0.65 (685Hv1)" value="${insp.effectiveCaseDepth||''}" ${isClosed?'disabled':''}>
        </div>
      </div>
      <div class="row-2" style="margin-top:10px">
        <div class="f">
          <label>Microstructure</label>
          <input id="ht-insp-ms" type="text" placeholder="e.g. Martensite" value="${insp.microstructure||''}" ${isClosed?'disabled':''}>
        </div>
        <div class="f">
          <label>R/A % (550/514 HV)</label>
          <input id="ht-insp-ra" type="text" placeholder="e.g. <20%" value="${insp.ra||''}" ${isClosed?'disabled':''}>
        </div>
      </div>
      <div class="f" style="margin-top:10px">
        <label>Inspected By</label>
        <input id="ht-insp-by" type="text" value="${insp.inspectedBy || S.sess.name}" list="ht-op-list-names" ${isClosed?'disabled':''}>
      </div>
      ${!isClosed ? `<button class="btn btn-s btn-sm w-full" style="margin-top:12px" onclick="htSaveInspection('${c.id}')"><i class="ti ti-device-floppy"></i> Save Inspection Data</button>` : ''}
    </div>

    <!-- Section F: Downtimes -->
    <div class="card" style="margin-bottom:14px">
      <div style="font-size:11.5px;font-weight:800;color:var(--imf-navy);letter-spacing:.04em;margin-6px">F. SHIFT DOWNTIMES</div>
      <div style="font-size:11px;color:var(--txt-muted);margin-bottom:12px">Record hours of downtime occurred during the run cycle:</div>
      ${['noMaterial', 'noPower', 'underMaintenance', 'fcConditioning'].map((k, idx) => {
        const labels = ['No Material', 'No Power', 'Under Maintenance', 'F/C Conditioning'];
        const val = dt[k] || { from: '', to: '' };
        return `
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;gap:10px">
            <span style="font-size:12px;font-weight:700;width:120px">${labels[idx]}</span>
            <div style="display:flex;gap:6px;flex:1">
              <div class="f" style="margin:0;flex:1"><input type="time" id="ht-dt-${k}-from" value="${val.from || ''}" ${isClosed?'disabled':''}></div>
              <div style="align-self:center;font-size:11px;color:var(--txt-muted)">to</div>
              <div class="f" style="margin:0;flex:1"><input type="time" id="ht-dt-${k}-to" value="${val.to || ''}" ${isClosed?'disabled':''}></div>
            </div>
          </div>`;
      }).join('')}
      ${!isClosed ? `<button class="btn btn-s btn-sm w-full" style="margin-top:12px" onclick="htSaveDowntimes('${c.id}')"><i class="ti ti-device-floppy"></i> Save Downtime Logs</button>` : ''}
    </div>

    ${TEST_MODE && !isClosed ? `
      <div class="card text-center" style="margin-bottom:14px;border:1px dashed var(--warn);padding:14px">
        <div style="font-size:11.5px;font-weight:700;color:var(--warn);margin-bottom:8px">DEVELOPER / TEST UTILITIES</div>
        <button class="btn btn-s btn-sm w-full" style="background:#FEF3C7;color:#78350F;border-color:#FEF3C7" onclick="htQuickFillDetail('${c.id}')">
          ⚡ Quick Fill Entire Report Data
        </button>
      </div>` : ''}
    ${(isAdmin() || isTanmay()) ? `
      <div class="card" style="margin-top:14px; border:1px solid var(--line); padding:16px; display:flex; gap:10px">
        ${isAdmin() ? `<button class="btn btn-s flex-1" onclick="openEditHTChargeModal('${c.id}')"><i class="ti ti-edit"></i> Edit Charge Header</button>` : ''}
        ${isTanmay() ? `<button class="btn btn-d flex-1" onclick="deleteHTCharge('${c.id}')"><i class="ti ti-trash"></i> Delete Charge</button>` : ''}
      </div>
    ` : ''}
  `;
}

/* ── Save functions for sections ── */
async function htSaveLoading(id) {
  const date = document.getElementById('ht-load-date').value;
  const time = document.getElementById('ht-load-time').value;
  const retortTarget = parseInt(document.getElementById('ht-retort-target').value) || 760;

  try {
    await db.collection('htCharges').doc(id).update({
      loading: { date, time, retortTarget },
      updatedAt: serverTS(),
    });
    toast('Loading details saved ✓');
    await refreshHT();
  } catch (e) {
    toast('Error: ' + friendlyError(e));
  }
}

function htOpenTempReadingModal(id) {
  const c = S_HT.charges.find(x => x.id === id);
  const n = (c?.tempReadings || []).length + 1;
  const prev = c?.tempReadings?.[c.tempReadings.length - 1] || null;

  openModal(`
    <div class="modal-handle"></div>
    <div class="modal-title">Log Temperature Reading #${n}</div>
    <div class="wbox" style="font-size:11.5px;margin-bottom:12px">
      🟢 760°C reached → start Methanol (0.7 L/hr)<br>
      🟠 890°C reached → start Acetone
    </div>
    <div class="row-2">
      <div class="f">
        <label>Reading Time</label>
        <input id="htr-time" type="time" value="${new Date().toTimeString().slice(0,5)}">
      </div>
      <div class="f">
        <label>Retort Temperature (°C)</label>
        <input id="htr-retort" type="number" placeholder="e.g. 760" oninput="htrCheckHints(this.value)">
      </div>
    </div>
    <div id="htr-log-hint" style="display:none;font-size:11px;padding:6px 10px;border-radius:var(--rxs);margin-top:8px"></div>
    <div class="row-2" style="margin-top:10px">
      <div class="f">
        <label>Zone 1 Temp (°C)</label>
        <input id="htr-z1" type="number" placeholder="—">
      </div>
      <div class="f">
        <label>Zone 2 Temp (°C)</label>
        <input id="htr-z2" type="number" placeholder="—">
      </div>
    </div>
    <div class="row-3" style="margin-top:10px">
      <div class="f">
        <label>M.V. Reading</label>
        <input id="htr-mv" type="number" step="0.01" placeholder="—">
      </div>
      <div class="f">
        <label>MeOH (L/hr)</label>
        <input id="htr-meoh" type="number" step="0.1" placeholder="${prev?.methanol || '0.7'}">
      </div>
      <div class="f">
        <label>Acetone (L/hr)</label>
        <input id="htr-acet" type="number" step="0.1" placeholder="${prev?.acetone || '0.0'}">
      </div>
    </div>
    <div class="f" style="margin-top:10px">
      <label>Remarks</label>
      <input id="htr-remarks" type="text" placeholder="Observations, e.g. Diffusion MV setting">
    </div>
    <button class="btn btn-p" style="width:100%;margin-top:16px" onclick="htConfirmTempReading('${id}')">✓ Save Reading</button>
    <button class="btn btn-s" style="width:100%;margin-top:8px" onclick="closeModal()">Cancel</button>
  `);
}

function htrCheckHints(val) {
  const hintEl = document.getElementById('htr-log-hint');
  if (!hintEl) return;
  const temp = parseInt(val) || 0;

  if (temp >= 890) {
    hintEl.style.display = 'block';
    hintEl.style.background = '#FEF3C7';
    hintEl.style.color = '#78350F';
    hintEl.textContent = '🟠 890°C reached — Start Acetone flow immediately';
  } else if (temp >= 760) {
    hintEl.style.display = 'block';
    hintEl.style.background = '#F0FDF4';
    hintEl.style.color = '#14532D';
    hintEl.textContent = '🟢 760°C reached — Start Methanol flow @ 0.7 L/hr';
  } else {
    hintEl.style.display = 'none';
  }
}

async function htConfirmTempReading(id) {
  const time = document.getElementById('htr-time').value;
  const retort = parseInt(document.getElementById('htr-retort').value) || 0;

  if (!time || !retort) {
    toast('Time and Retort temperature are required');
    return;
  }

  const c = S_HT.charges.find(x => x.id === id);
  if (!c) return;

  const currentReadings = [...(c.tempReadings || [])];
  if (currentReadings.length >= 7) {
    toast('Maximum 7 temperature readings already recorded');
    closeModal();
    return;
  }

  currentReadings.push({
    time,
    retort,
    z1: parseInt(document.getElementById('htr-z1').value) || null,
    z2: parseInt(document.getElementById('htr-z2').value) || null,
    mv: parseFloat(document.getElementById('htr-mv').value) || null,
    methanol: parseFloat(document.getElementById('htr-meoh').value) || null,
    acetone: parseFloat(document.getElementById('htr-acet').value) || null,
    remarks: document.getElementById('htr-remarks').value.trim() || '',
  });

  try {
    await db.collection('htCharges').doc(id).update({
      tempReadings: currentReadings,
      updatedAt: serverTS(),
    });
    closeModal();
    toast('Hourly temperature log saved ✓');
    await refreshHT();
  } catch (e) {
    toast('Error: ' + friendlyError(e));
  }
}

async function htDeleteTempReading(id, index) {
  if (!confirm('Are you sure you want to delete this temperature reading?')) return;
  const c = S_HT.charges.find(x => x.id === id);
  if (!c) return;

  const currentReadings = [...(c.tempReadings || [])];
  currentReadings.splice(index, 1);

  try {
    await db.collection('htCharges').doc(id).update({
      tempReadings: currentReadings,
      updatedAt: serverTS(),
    });
    toast('Temperature reading removed');
    await refreshHT();
  } catch (e) {
    toast('Error: ' + friendlyError(e));
  }
}

async function htSaveQuenching(id) {
  const unloadTime = document.getElementById('ht-q-unload').value;
  const startTime = document.getElementById('ht-q-start').value;
  const oilTempBefore = parseInt(document.getElementById('ht-q-oil-before').value) || null;
  const oilTempAfter = parseInt(document.getElementById('ht-q-oil-after').value) || null;
  const washTemp = parseInt(document.getElementById('ht-q-wash-temp').value) || null;
  const washPh = parseFloat(document.getElementById('ht-q-wash-ph').value) || null;
  const coolingStart = document.getElementById('ht-q-cool-start').value;

  const surfHRC = [0,1,2,3,4,5,6].map(i => parseFloat(document.getElementById(`ht-sqhrc-${i}`)?.value) || null);

  try {
    await db.collection('htCharges').doc(id).update({
      quenching: {
        unloadTime,
        startTime,
        oilTempBefore,
        oilTempAfter,
        washTemp,
        washPh,
        coolingStart,
        surfHRCQuenched: surfHRC
      },
      updatedAt: serverTS(),
    });
    toast('Quenching logs saved ✓');
    await refreshHT();
  } catch (e) {
    toast('Error: ' + friendlyError(e));
  }
}

async function htSaveTempering(id) {
  const furnaceNo = document.getElementById('ht-tfno').value;
  const temperature = parseInt(document.getElementById('ht-tmp-temp').value) || null;
  const loadingTime = document.getElementById('ht-tmp-load').value;
  const tempAttendedAt = document.getElementById('ht-tmp-atnd').value;
  const unloadingTime = document.getElementById('ht-tmp-unload').value;

  try {
    await db.collection('htCharges').doc(id).update({
      tempering: { furnaceNo, temperature, loadingTime, tempAttendedAt, unloadingTime },
      updatedAt: serverTS(),
    });
    toast('Tempering logs saved ✓');
    await refreshHT();
  } catch (e) {
    toast('Error: ' + friendlyError(e));
  }
}

async function htSaveInspection(id) {
  const surfHRCTempered = [0,1,2,3].map(i => parseFloat(document.getElementById(`ht-insp-shrc-${i}`)?.value) || null);
  const coreHRC = parseFloat(document.getElementById('ht-insp-chrc').value) || null;
  const corePcd = parseFloat(document.getElementById('ht-insp-cpcd').value) || null;
  const microCaseDepth = document.getElementById('ht-insp-mcd').value.trim();
  const effectiveCaseDepth = document.getElementById('ht-insp-ecd').value.trim();
  const microstructure = document.getElementById('ht-insp-ms').value.trim();
  const ra = document.getElementById('ht-insp-ra').value.trim();
  const inspectedBy = document.getElementById('ht-insp-by').value.trim();

  try {
    await db.collection('htCharges').doc(id).update({
      inspection: {
        surfHRCTempered,
        coreHRC,
        corePcd,
        microCaseDepth,
        effectiveCaseDepth,
        microstructure,
        ra,
        inspectedBy
      },
      updatedAt: serverTS(),
    });
    toast('Inspection logs saved ✓');
    await refreshHT();
  } catch (e) {
    toast('Error: ' + friendlyError(e));
  }
}

async function htSaveDowntimes(id) {
  const keys = ['noMaterial', 'noPower', 'underMaintenance', 'fcConditioning'];
  const downtimes = {};
  keys.forEach(k => {
    const f = document.getElementById(`ht-dt-${k}-from`)?.value || '';
    const t = document.getElementById(`ht-dt-${k}-to`)?.value || '';
    if (f || t) downtimes[k] = { from: f, to: t };
  });

  try {
    await db.collection('htCharges').doc(id).update({
      downtimes,
      updatedAt: serverTS(),
    });
    toast('Downtime logs saved ✓');
    await refreshHT();
  } catch (e) {
    toast('Error: ' + friendlyError(e));
  }
}

/* ── Quick fill details ── */
async function htQuickFillDetail(id) {
  const tStr = (h, m = 0) => String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');

  // A. Loading
  document.getElementById('ht-load-date').value = dateStr();
  document.getElementById('ht-load-time').value = tStr(8, 0);
  document.getElementById('ht-retort-target').value = '760';
  await htSaveLoading(id);

  // B. 7 Temperature Readings
  const readings = [];
  for (let i = 0; i < 7; i++) {
    readings.push({
      time: tStr(9 + i, 0),
      retort: 760 + (i * 30),
      z1: 750 + (i * 30),
      z2: 755 + (i * 30),
      mv: 1.1 + (i * 0.05),
      methanol: 0.7,
      acetone: i >= 4 ? 0.3 : 0.0,
      remarks: 'Standard run checkpoint — test data'
    });
  }
  await db.collection('htCharges').doc(id).update({ tempReadings: readings });

  // C. Quenching
  document.getElementById('ht-q-unload').value = tStr(16, 0);
  document.getElementById('ht-q-start').value = tStr(16, 5);
  document.getElementById('ht-q-oil-before').value = '60';
  document.getElementById('ht-q-oil-after').value = '80';
  document.getElementById('ht-q-wash-temp').value = '65';
  document.getElementById('ht-q-wash-ph').value = '10.2';
  document.getElementById('ht-q-cool-start').value = tStr(16, 20);
  for (let i = 0; i < 7; i++) {
    document.getElementById(`ht-sqhrc-${i}`).value = '61';
  }
  await htSaveQuenching(id);

  // D. Tempering
  document.getElementById('ht-tfno').value = 'TF-1';
  document.getElementById('ht-tmp-temp').value = '180';
  document.getElementById('ht-tmp-load').value = tStr(17, 0);
  document.getElementById('ht-tmp-atnd').value = tStr(17, 30);
  document.getElementById('ht-tmp-unload').value = tStr(19, 0);
  await htSaveTempering(id);

  // E. Inspection
  for (let i = 0; i < 4; i++) {
    document.getElementById(`ht-insp-shrc-${i}`).value = '59';
  }
  document.getElementById('ht-insp-chrc').value = '38';
  document.getElementById('ht-insp-cpcd').value = '35';
  document.getElementById('ht-insp-mcd').value = '0.82';
  document.getElementById('ht-insp-ecd').value = '0.62 (685Hv1)';
  document.getElementById('ht-insp-ms').value = 'Fine tempered martensite';
  document.getElementById('ht-insp-ra').value = '<15%';
  document.getElementById('ht-insp-by').value = S.sess.name;
  await htSaveInspection(id);

  toast('⚡ Run logs filled successfully!');
  await refreshHT();
}

/* ── Finalize Charge & Yield Audit ── */
function htOpenFinalizeModal(id) {
  const c = S_HT.charges.find(x => x.id === id);
  if (!c) return;

  const warnings = [];
  if (!c.loading) warnings.push('Furnace loading details are missing.');
  if ((c.tempReadings || []).length < 7) warnings.push(`Only ${c.tempReadings?.length || 0}/7 temperature readings logged.`);
  if (!c.quenching) warnings.push('Quenching results are missing.');
  if (!c.tempering) warnings.push('Tempering furnace logs are missing.');
  if (!c.inspection) warnings.push('Inspection hardness and microstructure checks are missing.');

  const tagRows = (c.components || []).map((t, idx) => `
    <div style="background:var(--fill);border-radius:var(--rs);padding:10px;margin-bottom:8px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
        <div>
          <span class="imf-mono" style="font-weight:700;font-size:11.5px">${t.tagId}</span>
          <span style="font-size:11.5px;color:var(--txt-muted);margin-left:6px">${t.name} · Loaded: ${t.qty} pcs</span>
        </div>
      </div>
      <div class="row-2">
        <div class="f">
          <label style="font-size:11px">Passed (Ok Yield)</label>
          <input type="number" id="yld-ok-${idx}" min="0" max="${t.qty}" value="${t.qty}"
            oninput="htUpdateYield(${idx}, ${t.qty})" style="font-weight:700;text-align:center;color:var(--ok)">
        </div>
        <div class="f">
          <label style="font-size:11px">Failed (Scrapped)</label>
          <div id="yld-fail-${idx}" style="padding:8px;background:var(--erbg);border:1px solid var(--er);border-radius:var(--rxs);
                                          font-weight:800;text-align:center;color:var(--er)">0</div>
        </div>
      </div>
    </div>`).join('');

  openModal(`
    <div class="modal-handle"></div>
    <div class="modal-title">Finalize HT Charge — Yield Audit</div>
    ${warnings.length > 0 
      ? `<div class="ebox" style="margin-bottom:12px;font-size:12px">
           <div style="font-weight:700;margin-bottom:4px">⚠️ Warning: Incomplete Report Logs</div>
           ${warnings.map(w => `<div>• ${w}</div>`).join('')}
         </div>`
      : ''
    }
    <div style="font-size:11px;font-weight:700;color:var(--txt-muted);letter-spacing:.05em;margin-bottom:6px">SET TAG YIELD PIECES:</div>
    <div style="max-height:40vh;overflow-y:auto;margin-bottom:14px">${tagRows}</div>
    <div id="finalize-err" style="display:none;color:var(--err);font-weight:700;font-size:11.5px;margin-bottom:10px"></div>
    <div style="display:flex;gap:8px">
      <button class="btn btn-s" style="flex:1" onclick="closeModal()">Cancel</button>
      <button class="btn btn-ok" style="flex:1" onclick="htFinalizeChargeConfirm('${id}')">✓ Finalize Run</button>
    </div>
  `);
}

function htUpdateYield(idx, total) {
  const ok = Math.min(Math.max(0, parseInt(document.getElementById(`yld-ok-${idx}`)?.value || '0')), total);
  const fail = total - ok;
  const failEl = document.getElementById(`yld-fail-${idx}`);
  if (failEl) {
    failEl.textContent = fail;
    failEl.style.background = fail > 0 ? 'var(--erbg)' : 'var(--fill)';
    failEl.style.color = fail > 0 ? 'var(--er)' : 'var(--txt-muted)';
  }
}

async function htFinalizeChargeConfirm(id) {
  const c = S_HT.charges.find(x => x.id === id);
  if (!c) return;

  const yields = (c.components || []).map((t, idx) => {
    const ok = Math.min(Math.max(0, parseInt(document.getElementById(`yld-ok-${idx}`)?.value || '0')), t.qty);
    return { ...t, yielded: ok, failed: t.qty - ok };
  });

  const errEl = document.getElementById('finalize-err');
  if (yields.some(y => y.yielded < 0 || y.yielded > y.qty)) {
    if (errEl) { errEl.textContent = 'Invalid yield inputs'; errEl.style.display = 'block'; }
    return;
  }

  try {
    const batch = db.batch();
    const now = serverTS();

    for (const y of yields) {
      const cardRef = db.collection('routeCards').doc(y.tagId);
      
      if (y.yielded === 0) {
        // Scrapped
        batch.update(cardRef, {
          status: 'scrapped',
          currentQty: 0,
          htFailed: y.failed,
          htYielded: 0,
          updatedAt: now,
        });

        batch.set(db.collection('scrapLedger').doc(), {
          tagId: y.tagId,
          batchCode: y.batchCode || '',
          heatCode: c.chargeNo,
          partId: y.partId,
          partNo: y.partNo || '',
          partName: y.name || '',
          customerName: y.customerName || '',
          qtyRejected: y.failed,
          defectDescription: 'Heat treatment failure',
          stage: 'ht',
          inspectedBy: S.sess.userId,
          inspectedByName: S.sess.name,
          date: c.date,
          createdAt: now,
        });
      } else {
        // HT Completed -> Move to sb_pending (ready for Shot Blasting)
        batch.update(cardRef, {
          status: 'sb_pending',
          currentQty: y.yielded,
          htFailed: y.failed,
          htYielded: y.yielded,
          heatCode: c.chargeNo,
          updatedAt: now,
        });

        if (y.failed > 0) {
          batch.set(db.collection('scrapLedger').doc(), {
            tagId: y.tagId,
            batchCode: y.batchCode || '',
            heatCode: c.chargeNo,
            partId: y.partId,
            partNo: y.partNo || '',
            partName: y.name || '',
            customerName: y.customerName || '',
            qtyRejected: y.failed,
            defectDescription: 'Heat treatment partial failure',
            stage: 'ht',
            inspectedBy: S.sess.userId,
            inspectedByName: S.sess.name,
            date: c.date,
            createdAt: now,
          });
        }
      }
    }

    batch.update(db.collection('htCharges').doc(id), {
      status: 'completed',
      components: yields,
      completedBy: S.sess.userId,
      completedByName: S.sess.name,
      completedAt: now,
      updatedAt: now,
    });

    await batch.commit();
    await logAudit('HT_CHARGE_COMPLETED', 'HT', id, null, { chargeNo: c.chargeNo, tagsCount: yields.length });

    closeModal();
    toast(`Charge ${c.chargeNo} finalized successfully!`);
    _chargeMode = 'list';
    await refreshHT();
  } catch (e) {
    if (errEl) { errEl.textContent = 'Error: ' + friendlyError(e); errEl.style.display = 'block'; }
  }
}

/* ═══════════════════════════════════════════════════════════════════
   TAB: SHOT BLASTING MODULE (Compulsory Step)
   ═══════════════════════════════════════════════════════════════════ */
function renderShotBlasting() {
  const el = document.getElementById('tab-body');
  if (!el) return;

  if (_sbMode === 'new') {
    renderNewSbSession();
    return;
  }
  if (_sbMode === 'detail') {
    renderSbSessionDetail(_selSbSessionId);
    return;
  }

  const active = S_HT.sbSessions.filter(s => s.status === 'in_progress');
  const completed = S_HT.sbSessions.filter(s => s.status === 'completed');
  const pendingQueue = S_HT.routeCards;

  el.innerHTML = `
    <div style="display:flex;gap:8px;margin-bottom:14px;align-items:center">
      <button class="btn btn-p" onclick="sbStartNewSession()"><i class="ti ti-plus"></i> New Shot Blast Run</button>
      <button class="btn btn-s btn-sm" style="margin-left:auto" onclick="refreshHT()"><i class="ti ti-refresh"></i></button>
    </div>

    <div style="display:grid;grid-template-columns:1fr;gap:14px;align-items:start">
      <!-- 1. Pending Queue -->
      <div class="card" style="box-shadow:var(--sh-card)">
        <div style="font-size:12px;font-weight:800;color:var(--imf-navy);letter-spacing:#04em;margin-bottom:10px;display:flex;justify-content:space-between">
          <span>PENDING SHOT BLAST QUEUE</span>
          <span style="font-weight:400;color:var(--txt-muted)">${pendingQueue.length} TAGs waiting</span>
        </div>
        <div style="max-height:220px;overflow-y:auto">
          ${pendingQueue.length > 0 
            ? pendingQueue.map(c => `
                <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:0.5px solid var(--line-soft);font-size:12px">
                  <div>
                    <span class="imf-mono" style="font-weight:700;color:var(--imf-navy)">${c.id}</span>
                    <span style="color:var(--txt-muted);margin-left:6px">${c.partName} · Heat: ${c.heatCode}</span>
                  </div>
                  <span class="imf-mono" style="font-weight:700">${c.currentQty} pcs</span>
                </div>`).join('')
            : `<div class="text-xs text-muted text-center" style="padding:16px 0">All tags cleared. Queue is empty!</div>`
          }
        </div>
      </div>

      <!-- 2. Active Sessions -->
      <div class="imf-table-toolbar" style="margin-bottom:2px">
        <div class="imf-table-title" style="font-size:12px;font-weight:800;color:var(--txt-muted);letter-spacing:.05em">ACTIVE BLASTING RUNS (${active.length})</div>
      </div>
      ${active.length > 0 ? active.map(sbSessionRowCard).join('') : `<div class="card text-center" style="padding:20px;color:var(--txt-muted);font-size:12px;margin-bottom:14px">No active shot blast runs</div>`}

      <!-- 3. Completed Sessions -->
      <div class="imf-table-toolbar" style="margin-top:8px;margin-bottom:2px">
        <div class="imf-table-title" style="font-size:12px;font-weight:800;color:var(--txt-muted);letter-spacing:.05em">RECENT COMPLETED RUNS</div>
      </div>
      ${completed.length > 0 ? completed.slice(0, 10).map(sbSessionRowCard).join('') : `<div class="card text-center" style="padding:20px;color:var(--txt-muted);font-size:12px">No completed runs recorded</div>`}
    </div>
  `;
}

function sbSessionRowCard(s) {
  const isClosed = s.status === 'completed';
  const tagCount = (s.tags || []).length;
  const totalQty = (s.tags || []).reduce((sum, t) => sum + (t.qtyLoaded || 0), 0);

  return `
    <div class="card" style="margin-bottom:10px;border-left:4px solid ${isClosed ? 'var(--ok)' : 'var(--accent-violet)'}">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px;margin-bottom:8px">
        <div>
          <div class="imf-mono" style="font-weight:800;font-size:15px;color:var(--imf-navy)">${s.sessionNo}</div>
          <div style="font-size:11px;color:var(--txt-muted);margin-top:2px">
            Machine: <strong>${s.machineId}</strong> · Shift: ${getShiftLabel(s.shift)} · Date: ${fmtDate(s.date)}
          </div>
          <div style="font-size:11px;color:var(--txt-muted)">Operator: ${s.operator || '—'}</div>
        </div>
        ${isClosed
          ? `<span class="imf-badge st-qc_cleared"><i class="ti ti-circle-check"></i> Cleared</span>`
          : `<span class="imf-badge st-sb_wip"><i class="ti ti-circles animate-pulse"></i> Active</span>`
        }
      </div>

      <div style="background:var(--fill);border-radius:var(--rxs);padding:8px 10px;margin-bottom:10px">
        <div style="font-size:10px;font-weight:700;color:var(--txt-muted);letter-spacing:.06em;margin-bottom:4px">
          LOADED TAGS (${tagCount} TAGs · ${totalQty} pcs)
        </div>
        ${(s.tags || []).map(t => `
          <div style="display:flex;justify-content:space-between;font-size:11px;padding:2px 0">
            <span class="imf-mono" style="font-weight:600;font-size:10.5px">${t.tagId}</span>
            <span style="color:var(--txt-muted)">${t.partName} · ${t.qtyLoaded} pcs (Heat: ${t.heatCode})</span>
          </div>`).join('')}
      </div>

      <div style="display:flex;gap:8px">
        <button class="btn btn-s btn-sm" style="flex:1" onclick="viewSbSessionDetail('${s.id}')">
          <i class="ti ${isClosed ? 'ti-eye' : 'ti-edit'}"></i> ${isClosed ? 'View Session' : 'Complete & Log Yield'}
        </button>
      </div>
    </div>
  `;
}

function sbStartNewSession() {
  _sbMode = 'new';
  _sbComps = [];
  render();
}

function viewSbSessionDetail(id) {
  _sbMode = 'detail';
  _selSbSessionId = id;
  render();
}

/* ── New Shot Blast Session Form ── */
function renderNewSbSession() {
  const el = document.getElementById('tab-body');
  if (!el) return;

  el.innerHTML = `
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:14px">
      <button class="btn btn-s btn-sm" onclick="_sbMode='list';render()"><i class="ti ti-arrow-left"></i> Back</button>
      <div style="font-size:15px;font-weight:800">New Shot Blast Run</div>
    </div>

    <div class="card" style="margin-bottom:12px">
      <div style="font-size:11px;font-weight:700;color:var(--txt-muted);letter-spacing:.06em;margin-bottom:10px">SESSION DETAILS</div>
      <div class="row-2">
        <div class="f">
          <label>Date</label>
          <input id="sb-date" type="date" value="${dateStr()}">
        </div>
        <div class="f">
          <label>Shift</label>
          <select id="sb-shift">
            ${Object.entries(S.shifts || {}).map(([k,v])=>`<option value="${k}" ${getActiveShift().key===k?'selected':''}>${v.label}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="row-2" style="margin-top:10px">
        <div class="f">
          <label>Operator</label>
          <input id="sb-operator" type="text" placeholder="e.g. Ram Singh" list="ht-op-list-names">
        </div>
        <div class="f">
          <label>Shot Blast Machine</label>
          <select id="sb-machine">
            <option value="SB-1">SB-1</option>
            <option value="SB-2">SB-2</option>
          </select>
        </div>
      </div>
    </div>

    <div class="card" style="margin-bottom:12px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
        <div style="font-size:11px;font-weight:700;color:var(--txt-muted);letter-spacing:.06em">LOADED COMPONENTS</div>
        <button class="btn btn-s btn-sm" onclick="sbOpenAddCompModal()">+ Add TAG</button>
      </div>
      <div id="sb-comp-list-wrapper">
        <!-- Rendered by sbRenderComps() -->
      </div>
    </div>

    <div id="new-sb-err" style="display:none;color:var(--err);font-weight:700;font-size:11.5px;margin-bottom:10px"></div>

    <button class="btn btn-p" style="width:100%;min-height:48px;font-weight:700" onclick="sbSubmitNewSession()">
      <i class="ti ti-circles"></i> Start Shot Blasting Run
    </button>
  `;

  sbRenderComps();
}

function sbRenderComps() {
  const el = document.getElementById('sb-comp-list-wrapper');
  if (!el) return;

  if (!_sbComps.length) {
    el.innerHTML = `<div class="text-xs text-muted text-center" style="padding:12px 0">No components loaded. Click "+ Add TAG" to scan cards in HT Done status.</div>`;
    return;
  }

  el.innerHTML = `
    <div class="imf-tablewrap">
      <table class="imf-table" style="width:100%">
        <thead>
          <tr>
            <th>TAG</th>
            <th>Part Name</th>
            <th class="num">Qty Loaded</th>
            <th>Split Remainder Tag</th>
            <th style="width:40px"></th>
          </tr>
        </thead>
        <tbody>
          ${_sbComps.map((c, i) => `
            <tr>
              <td class="imf-mono" style="font-weight:700">${c.tagId}</td>
              <td>
                <div style="font-weight:600">${c.partName}</div>
                <div class="text-xs text-muted">Heat: ${c.heatCode} · Available: ${c.currentQty} pcs</div>
              </td>
              <td class="num imf-mono" style="font-weight:700">${c.qtyLoaded}</td>
              <td class="imf-mono">${c.isSplit ? `<span class="imf-mono font-bold" style="color:var(--warn)">${c.splitTagId}</span> (${c.remQty} pcs left)` : '—'}</td>
              <td>
                <button class="btn btn-d btn-sm" style="padding:4px 6px" onclick="sbRemoveComp(${i})">
                  <i class="ti ti-trash"></i>
                </button>
              </td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>
  `;
}

function sbRemoveComp(idx) {
  _sbComps.splice(idx, 1);
  sbRenderComps();
}

/* ── Add TAG to Blasting Modal ── */
function sbOpenAddCompModal() {
  openModal(`
    <div class="modal-handle"></div>
    <div class="modal-title">Scan TAG (HT Done) for Shot Blasting</div>
    <div id="qr-reader-sb" style="width:100%;border-radius:12px;overflow:hidden;margin-bottom:10px"></div>
    
    <div style="display:flex;gap:6px;margin-bottom:12px">
      <input id="sbc-tag-input" type="text" placeholder="Type TAG number (e.g. TAG042)" oninput="this.value=this.value.toUpperCase()" style="font-weight:700">
      <button class="btn btn-p" onclick="sbLookupTag()">Load Info</button>
    </div>
    
    <div id="sbc-tag-info" style="display:none;background:var(--fill);border-radius:var(--r);padding:12px;margin-bottom:12px;font-size:12.5px"></div>
    
    <!-- Choice Options (Full vs Split) -->
    <div id="sbc-action-options" style="display:none;gap:12px;margin-bottom:12px">
      <button class="btn btn-ok" style="flex:1;padding:12px;font-size:13px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;border-radius:12px;border:none;box-shadow:var(--shadow-sm)" onclick="sbSelectOption('full')">
        <i class="ti ti-circle-check" style="font-size:22px"></i>
        <strong>Full Quantity</strong>
        <span style="font-size:11px;opacity:0.9" id="sbc-opt-full-qty">—</span>
      </button>
      <button class="btn btn-s" style="flex:1;padding:12px;font-size:13px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;border-radius:12px;border:none;box-shadow:var(--shadow-sm)" onclick="sbSelectOption('split')">
        <i class="ti ti-arrows-split" style="font-size:22px"></i>
        <strong>Edit Quantity</strong>
        <span style="font-size:11px;opacity:0.9">Split Remainder</span>
      </button>
    </div>

    <!-- Split and Quantity details -->
    <div id="sbc-split-sec" style="display:none">
      <div class="f" style="margin-bottom:10px">
        <label>Quantity to Load (Blasting)</label>
        <input id="sbc-qty" type="number" min="1" style="font-weight:700;font-size:16px;text-align:center" oninput="sbUpdateSplitRemainder()">
      </div>

      <!-- Split tag section -->
      <div id="sbc-split-tag-sec" style="background:var(--canvas);padding:12px;border-radius:var(--rs);margin-bottom:12px">
        <div style="font-size:11px;font-weight:700;color:var(--txt-muted);margin-bottom:6px">SCAN/ENTER BLANK TAG FOR REMAINDER</div>
        <div style="display:flex;gap:6px;margin-bottom:4px">
          <input id="sbc-split-tag-input" type="text" placeholder="Scan Blank TAG (e.g. TAG105)" oninput="this.value=this.value.toUpperCase();sbCheckSplitTagBlank()" style="font-weight:700">
          <button class="btn btn-s btn-sm" onclick="sbScanSplitTag()">Scan</button>
        </div>
        <div id="sbc-split-tag-status" class="text-xs font-bold" style="display:none;margin-top:2px"></div>
        <div style="font-size:11px;color:var(--txt-muted);margin-top:6px;font-weight:600" id="sbc-split-rem-lbl">Remainder quantity: —</div>
      </div>
    </div>

    <button class="btn btn-ok" id="sbc-confirm-btn" style="width:100%;margin-top:14px;display:none" onclick="sbConfirmAddComp()">
      ✓ Load into Session
    </button>
    <button class="btn btn-s" style="width:100%;margin-top:8px" onclick="sbCloseAddCompModal()">Cancel</button>
  `);

  window._sbcCardData = null;
  window._sbScanningSplit = false;
  window._sbSelectedOption = null;

  setTimeout(() => {
    try {
      window._html5QrSb = new Html5Qrcode('qr-reader-sb');
      window._html5QrSb.start(
        { facingMode: 'environment' },
        { fps: 10, qrbox: { width: 250, height: 120 }, aspectRatio: 1.5 },
        (decoded) => {
          const splitActive = window._sbScanningSplit;
          const inputId = splitActive ? 'sbc-split-tag-input' : 'sbc-tag-input';
          const el = document.getElementById(inputId);
          if (el) {
            el.value = decoded.toUpperCase();
            if (splitActive) {
              sbCheckSplitTagBlank();
            } else {
              sbLookupTag();
            }
          }
          sbCloseScanner();
        },
        () => {}
      ).catch(() => {});
    } catch (e) {}
  }, 250);
}

function sbCloseScanner() {
  if (window._html5QrSb) {
    window._html5QrSb.stop().catch(() => {}).finally(() => {
      window._html5QrSb.clear();
      window._html5QrSb = null;
    });
  }
}

function sbCloseAddCompModal() {
  sbCloseScanner();
  closeModal();
}

function sbSelectOption(type) {
  window._sbSelectedOption = type;
  if (type === 'full') {
    // Immediately add component with full quantity
    const total = window._sbcCardData.currentQty;
    _sbComps.push({
      tagId: window._sbcCardData.tagId,
      partId: window._sbcCardData.partId,
      partNo: window._sbcCardData.partNo,
      partName: window._sbcCardData.partName,
      batchCode: window._sbcCardData.batchCode,
      customerName: window._sbcCardData.customerName,
      heatCode: window._sbcCardData.heatCode,
      cardType: window._sbcCardData.cardType,
      opHistory: window._sbcCardData.opHistory,
      qtyLoaded: total,
      currentQty: total,
      isSplit: false,
      splitTagId: '',
      remQty: 0,
      parentCardData: { ...window._sbcCardData }
    });
    window._sbcCardData = null;
    closeModal();
    sbRenderComps();
  } else {
    // Show split form
    const actionEl = document.getElementById('sbc-action-options');
    if (actionEl) actionEl.style.display = 'none';
    
    const splitSec = document.getElementById('sbc-split-sec');
    if (splitSec) splitSec.style.display = 'block';
    
    const confirmBtn = document.getElementById('sbc-confirm-btn');
    if (confirmBtn) confirmBtn.style.display = 'block';
    
    const total = window._sbcCardData.currentQty;
    const qtyInput = document.getElementById('sbc-qty');
    if (qtyInput) {
      qtyInput.value = total;
      qtyInput.max = total;
    }
    
    const splitInput = document.getElementById('sbc-split-tag-input');
    if (splitInput) splitInput.value = '';
    const statusEl = document.getElementById('sbc-split-tag-status');
    if (statusEl) statusEl.style.display = 'none';
    
    sbUpdateSplitRemainder();
  }
}

function sbUpdateSplitRemainder() {
  const qtyInput = document.getElementById('sbc-qty');
  const remLbl = document.getElementById('sbc-split-rem-lbl');
  
  if (!qtyInput || !remLbl || !window._sbcCardData) return;
  
  const total = window._sbcCardData.currentQty;
  const qty = parseInt(qtyInput.value) || 0;
  const rem = total - qty;
  
  if (qty <= 0 || qty >= total) {
    remLbl.style.color = 'var(--err)';
    remLbl.textContent = `Invalid quantity (must be 1 to ${total - 1})`;
  } else {
    remLbl.style.color = 'var(--txt-muted)';
    remLbl.innerHTML = `Remainder quantity: <strong style="color:var(--imf-navy);font-size:12.5px">${rem} pcs</strong>`;
  }
}

function sbScanSplitTag() {
  window._sbScanningSplit = true;
  sbCloseScanner(); // Restart to clear target
  
  setTimeout(() => {
    try {
      window._html5QrSb = new Html5Qrcode('qr-reader-sb');
      window._html5QrSb.start(
        { facingMode: 'environment' },
        { fps: 10, qrbox: { width: 250, height: 120 }, aspectRatio: 1.5 },
        (decoded) => {
          const el = document.getElementById('sbc-split-tag-input');
          if (el) {
            el.value = decoded.toUpperCase();
            sbCheckSplitTagBlank();
          }
          sbCloseScanner();
        },
        () => {}
      ).catch(() => {});
    } catch (e) {}
  }, 250);
}

async function sbCheckSplitTagBlank() {
  const tagId = (document.getElementById('sbc-split-tag-input')?.value || '').trim().toUpperCase();
  const statusEl = document.getElementById('sbc-split-tag-status');
  if (!statusEl) return;
  
  if (!tagId) {
    statusEl.style.display = 'none';
    return;
  }
  
  if (!tagId.match(/^TAG\d+(\-S\d+)?$/)) {
    statusEl.style.display = 'block';
    statusEl.style.color = 'var(--err)';
    statusEl.textContent = '✗ Invalid tag format';
    return;
  }
  
  if (tagId === window._sbcCardData?.tagId) {
    statusEl.style.display = 'block';
    statusEl.style.color = 'var(--err)';
    statusEl.textContent = '✗ Cannot be parent TAG';
    return;
  }
  
  try {
    const doc = await db.collection('routeCards').doc(tagId).get();
    statusEl.style.display = 'block';
    if (doc.exists && doc.data().status) {
      statusEl.style.color = 'var(--err)';
      statusEl.textContent = `✗ TAG Active (Status: ${doc.data().status})`;
    } else {
      statusEl.style.color = 'var(--ok)';
      statusEl.textContent = '✓ Blank TAG (Available)';
    }
  } catch (e) {
    statusEl.style.display = 'block';
    statusEl.style.color = 'var(--err)';
    statusEl.textContent = 'Error: ' + e.message;
  }
}

async function sbLookupTag() {
  const tagId = (document.getElementById('sbc-tag-input')?.value || '').trim().toUpperCase();
  if (!tagId) { toast('Enter a TAG UID'); return; }
  if (!tagId.match(/^TAG\d+(\-S\d+)?$/)) { toast('Invalid TAG format'); return; }

  if (_sbComps.find(c => c.tagId === tagId)) { toast(tagId + ' already loaded'); return; }

  try {
    const card = await fetchRouteCard(tagId);
    if (!card) { toast('Route Card not found'); return; }

    if (card.status !== 'sb_pending') {
      toast(`${tagId} status is "${card.status}" — expected "sb_pending" (completed HT, waiting for Shot Blasting)`);
      return;
    }

    const info = document.getElementById('sbc-tag-info');
    if (info) {
      info.style.display = 'block';
      info.innerHTML = `
        <div style="font-weight:700;font-family:monospace;color:var(--imf-navy)">${tagId}</div>
        <div style="font-weight:600">${card.partName || ''}</div>
        <div class="text-xs text-muted">${card.partNo || ''} · Heat Code: <strong>${card.heatCode || '—'}</strong></div>
        <div class="text-xs text-muted">Available qty: <strong>${card.currentQty}</strong></div>
      `;
    }

    window._sbcCardData = {
      ...card
    };

    // Show option choices (Full vs Split)
    const optFullQty = document.getElementById('sbc-opt-full-qty');
    if (optFullQty) optFullQty.textContent = `${card.currentQty} pcs`;

    const optionsSec = document.getElementById('sbc-action-options');
    if (optionsSec) optionsSec.style.display = 'flex';

    sbCloseScanner();
  } catch (e) {
    toast('Error loading TAG: ' + friendlyError(e));
  }
}

async function sbConfirmAddComp() {
  const loadType = window._sbSelectedOption || 'split';
  const qtyInput = document.getElementById('sbc-qty');
  const qty = parseInt(qtyInput ? qtyInput.value : 0) || 0;
  
  if (qty <= 0) { toast('Enter quantity'); return; }
  
  const total = window._sbcCardData.currentQty;
  
  let isSplit = false;
  let splitTagId = '';
  let remQty = 0;
  
  if (loadType === 'split') {
    splitTagId = (document.getElementById('sbc-split-tag-input')?.value || '').trim().toUpperCase();
    if (!splitTagId) { toast('Scan or enter a blank TAG for the remainder.'); return; }
    if (splitTagId === window._sbcCardData.tagId) { toast('Split TAG cannot be the same as the parent TAG.'); return; }
    if (qty >= total) { toast('Split quantity must be less than the available quantity.'); return; }
    isSplit = true;
    remQty = total - qty;
  }
  
  // Double-verify the blank tag is indeed blank (server side check before confirmation)
  if (isSplit) {
    try {
      const splitDoc = await db.collection('routeCards').doc(splitTagId).get();
      if (splitDoc.exists && splitDoc.data().status) {
        toast(`TAG ${splitTagId} is already active in the system. Use a blank TAG.`);
        return;
      }
      
      // Proceed with adding split component
      _sbComps.push({
        tagId: window._sbcCardData.tagId,
        partId: window._sbcCardData.partId,
        partNo: window._sbcCardData.partNo || '',
        partName: window._sbcCardData.partName || '',
        batchCode: window._sbcCardData.batchCode || '',
        customerName: window._sbcCardData.customerName || '',
        heatCode: window._sbcCardData.heatCode || '',
        cardType: window._sbcCardData.cardType || 'STANDARD',
        opHistory: window._sbcCardData.opHistory || [],
        qtyLoaded: qty,
        currentQty: total,
        isSplit,
        splitTagId,
        remQty,
        parentCardData: { ...window._sbcCardData }
      });
      
      window._sbcCardData = null;
      closeModal();
      sbRenderComps();
    } catch (e) {
      toast('Error validating blank tag: ' + e.message);
    }
  } else {
    // Proceed with adding full quantity
    _sbComps.push({
      tagId: window._sbcCardData.tagId,
      partId: window._sbcCardData.partId,
      partNo: window._sbcCardData.partNo || '',
      partName: window._sbcCardData.partName || '',
      batchCode: window._sbcCardData.batchCode || '',
      customerName: window._sbcCardData.customerName || '',
      heatCode: window._sbcCardData.heatCode || '',
      cardType: window._sbcCardData.cardType || 'STANDARD',
      opHistory: window._sbcCardData.opHistory || [],
      qtyLoaded: qty,
      currentQty: total,
      isSplit: false,
      splitTagId: '',
      remQty: 0,
      parentCardData: { ...window._sbcCardData }
    });
    
    window._sbcCardData = null;
    closeModal();
    sbRenderComps();
  }
}

async function sbSubmitNewSession() {
  const errEl = document.getElementById('new-sb-err');
  if (errEl) errEl.style.display = 'none';

  if (!_sbComps.length) {
    if (errEl) { errEl.textContent = 'Add at least one TAG to load into the session.'; errEl.style.display = 'block'; }
    return;
  }

  const operator = document.getElementById('sb-operator').value.trim();
  const machine = document.getElementById('sb-machine').value;
  const date = document.getElementById('sb-date').value;
  const shift = document.getElementById('sb-shift').value;
  const sessionNo = sbSessionNo();

  try {
    const batch = db.batch();
    const now = serverTS();

    const sessionRef = db.collection('shotBlastSessions').doc(sessionNo);
    batch.set(sessionRef, {
      sessionNo,
      status: 'in_progress',
      date,
      shift,
      operator,
      machineId: machine,
      tags: _sbComps.map(c => ({
        tagId: c.tagId,
        partId: c.partId,
        partNo: c.partNo,
        partName: c.partName,
        batchCode: c.batchCode,
        customerName: c.customerName,
        qtyLoaded: c.qtyLoaded,
        heatCode: c.heatCode,
      })),
      completedAt: null,
      completedBy: '',
      completedByName: '',
      createdAt: now,
      updatedAt: now,
    });

    // Process route card updates & splits
    for (const c of _sbComps) {
      const parentRef = db.collection('routeCards').doc(c.tagId);

      if (c.isSplit && c.splitTagId) {
        // Partial load: split card onto user's scanned blank tag!
        const childId = c.splitTagId;
        const remQty = c.remQty;

        // Create child card inheriting all metadata, holding remainder in ht_done
        const childData = {
          ...(c.parentCardData || {}),
          tagId: childId,
          parentCardUid: c.tagId,
          cardType: 'SPLIT',
          initialQty: remQty,
          currentQty: remQty,
          status: 'sb_pending',
          createdAt: now,
          createdBy: S.sess.userId,
          updatedAt: now,
        };
        delete childData.id;

        batch.set(db.collection('routeCards').doc(childId), childData);

        // Original tag updates to loaded quantity and goes to sb_wip status
        batch.update(parentRef, {
          status: 'sb_wip',
          currentQty: c.qtyLoaded,
          updatedAt: now,
        });
      } else {
        // Full load: no split, just status change
        batch.update(parentRef, {
          status: 'sb_wip',
          updatedAt: now,
        });
      }
    }

    await batch.commit();
    await logAudit('SB_SESSION_STARTED', 'HT', sessionNo, null, { machine, sessionNo, tagsCount: _sbComps.length });

    toast(`Shot Blast Session ${sessionNo} started!`);
    _sbMode = 'list';
    await refreshHT();
  } catch (e) {
    if (errEl) { errEl.textContent = 'Error starting run: ' + friendlyError(e); errEl.style.display = 'block'; }
  }
}

/* ── Shot Blast Session Detail ── */
function renderSbSessionDetail(id) {
  const el = document.getElementById('tab-body');
  if (!el) return;

  const s = S_HT.sbSessions.find(x => x.id === id);
  if (!s) {
    el.innerHTML = `<div class="card text-center" style="padding:24px">Session record not found.</div>`;
    return;
  }

  const isClosed = s.status === 'completed';

  el.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">
      <div style="display:flex;align-items:center;gap:8px">
        <button class="btn btn-s btn-sm" onclick="_sbMode='list';render()"><i class="ti ti-arrow-left"></i> Back</button>
        <div>
          <div class="imf-mono" style="font-weight:800;font-size:15px;color:var(--imf-navy)">${s.sessionNo}</div>
          <div style="font-size:11px;color:var(--txt-muted)">Machine: ${s.machineId} · Shift: ${getShiftLabel(s.shift)} · Date: ${fmtDate(s.date)}</div>
        </div>
      </div>
      ${isClosed
        ? `<span class="imf-badge st-qc_cleared"><i class="ti ti-circle-check"></i> Completed</span>`
        : `<button class="btn btn-ok btn-sm" onclick="sbOpenFinalizeModal('${s.id}')"><i class="ti ti-circle-check"></i> Complete Run</button>`
      }
    </div>

    <div class="card" style="margin-bottom:12px">
      <div style="font-size:11px;font-weight:700;color:var(--txt-muted);letter-spacing:.06em;margin-bottom:8px">SESSION GENERAL INFO</div>
      <div class="row-2" style="font-size:12.5px">
        <div><strong>Operator:</strong> ${s.operator || '—'}</div>
        <div><strong>Status:</strong> ${s.status.toUpperCase()}</div>
      </div>
      ${isClosed ? `<div class="text-xs text-muted" style="margin-top:6px">Completed by: ${s.completedByName || '—'} · ${fmtTS(s.completedAt)}</div>` : ''}
    </div>

    <div class="card">
      <div style="font-size:11px;font-weight:700;color:var(--txt-muted);letter-spacing:.06em;margin-bottom:10px">LOADED TAGS &amp; YIELDS</div>
      <div class="imf-tablewrap">
        <table class="imf-table" style="width:100%">
          <thead>
            <tr>
              <th>TAG</th>
              <th>Part Detail</th>
              <th class="num">Loaded</th>
              ${isClosed ? `<th class="num">Passed</th><th class="num">Failed</th>` : ''}
            </tr>
          </thead>
          <tbody>
            ${(s.tags || []).map(t => {
              const yld = s.yields?.find(y => y.tagId === t.tagId) || {};
              return `
                <tr>
                  <td class="imf-mono" style="font-weight:700">${t.tagId}</td>
                  <td>
                    <div style="font-weight:600">${t.partName}</div>
                    <div class="text-xs text-muted">Heat Code: ${t.heatCode} · Batch: ${t.batchCode}</div>
                  </td>
                  <td class="num imf-mono">${t.qtyLoaded}</td>
                  ${isClosed 
                    ? `<td class="num imf-mono text-ok" style="font-weight:700">${yld.yielded ?? t.qtyLoaded}</td>
                       <td class="num imf-mono text-err" style="font-weight:700">${yld.failed ?? 0}</td>`
                    : ''
                  }
                </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
    </div>
    ${(isAdmin() || isTanmay()) ? `
      <div class="card" style="margin-top:14px; border:1px solid var(--line); padding:16px; display:flex; gap:10px">
        ${isAdmin() ? `<button class="btn btn-s flex-1" onclick="openEditSbSessionModal('${s.id}')"><i class="ti ti-edit"></i> Edit Session Header</button>` : ''}
        ${isTanmay() ? `<button class="btn btn-d flex-1" onclick="deleteSbSession('${s.id}')"><i class="ti ti-trash"></i> Delete Session</button>` : ''}
      </div>
    ` : ''}
  `;
}

function sbOpenFinalizeModal(id) {
  const s = S_HT.sbSessions.find(x => x.id === id);
  if (!s) return;

  const tagRows = (s.tags || []).map((t, idx) => `
    <div style="background:var(--fill);border-radius:var(--rs);padding:10px;margin-bottom:8px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
        <div>
          <span class="imf-mono" style="font-weight:700;font-size:11.5px">${t.tagId}</span>
          <span style="font-size:11.5px;color:var(--txt-muted);margin-left:6px">${t.partName} · Loaded: ${t.qtyLoaded} pcs</span>
        </div>
      </div>
      <div class="row-2">
        <div class="f">
          <label style="font-size:11px">Passed Yield</label>
          <input type="number" id="sb-ok-${idx}" min="0" max="${t.qtyLoaded}" value="${t.qtyLoaded}"
            oninput="sbUpdateYield(${idx}, ${t.qtyLoaded})" style="font-weight:700;text-align:center;color:var(--ok)">
        </div>
        <div class="f">
          <label style="font-size:11px">Failed Rejects</label>
          <div id="sb-fail-${idx}" style="padding:8px;background:var(--erbg);border:1px solid var(--er);border-radius:var(--rxs);
                                          font-weight:800;text-align:center;color:var(--er)">0</div>
        </div>
      </div>
    </div>`).join('');

  openModal(`
    <div class="modal-handle"></div>
    <div class="modal-title">Finalize Shot Blast Run — Yield Audit</div>
    <div style="font-size:11px;font-weight:700;color:var(--txt-muted);letter-spacing:.05em;margin-bottom:6px">SET TAG YIELD PIECES:</div>
    <div style="max-height:45vh;overflow-y:auto;margin-bottom:14px">${tagRows}</div>
    <div id="sb-finalize-err" style="display:none;color:var(--err);font-weight:700;font-size:11.5px;margin-bottom:10px"></div>
    <div style="display:flex;gap:8px">
      <button class="btn btn-s" style="flex:1" onclick="closeModal()">Cancel</button>
      <button class="btn btn-ok" style="flex:1" onclick="sbFinalizeSessionConfirm('${id}')">✓ Finalize Run</button>
    </div>
  `);
}

function sbUpdateYield(idx, total) {
  const ok = Math.min(Math.max(0, parseInt(document.getElementById(`sb-ok-${idx}`)?.value || '0')), total);
  const fail = total - ok;
  const failEl = document.getElementById(`sb-fail-${idx}`);
  if (failEl) {
    failEl.textContent = fail;
    failEl.style.background = fail > 0 ? 'var(--erbg)' : 'var(--fill)';
    failEl.style.color = fail > 0 ? 'var(--er)' : 'var(--txt-muted)';
  }
}

async function sbFinalizeSessionConfirm(id) {
  const s = S_HT.sbSessions.find(x => x.id === id);
  if (!s) return;

  const yields = (s.tags || []).map((t, idx) => {
    const ok = Math.min(Math.max(0, parseInt(document.getElementById(`sb-ok-${idx}`)?.value || '0')), t.qtyLoaded);
    return { ...t, yielded: ok, failed: t.qtyLoaded - ok };
  });

  const errEl = document.getElementById('sb-finalize-err');
  if (yields.some(y => y.yielded < 0 || y.yielded > y.qtyLoaded)) {
    if (errEl) { errEl.textContent = 'Invalid yield inputs'; errEl.style.display = 'block'; }
    return;
  }

  try {
    const batch = db.batch();
    const now = serverTS();

    for (const y of yields) {
      const cardRef = db.collection('routeCards').doc(y.tagId);

      if (y.yielded === 0) {
        // Scrapped
        batch.update(cardRef, {
          status: 'scrapped',
          currentQty: 0,
          sbFailed: y.failed,
          sbYielded: 0,
          updatedAt: now,
        });

        batch.set(db.collection('scrapLedger').doc(), {
          tagId: y.tagId,
          batchCode: y.batchCode || '',
          heatCode: y.heatCode || '',
          partId: y.partId,
          partNo: y.partNo || '',
          partName: y.partName || '',
          customerName: y.customerName || '',
          qtyRejected: y.failed,
          defectDescription: 'Shot blasting failure',
          stage: 'shot_blast',
          inspectedBy: S.sess.userId,
          inspectedByName: S.sess.name,
          date: s.date,
          createdAt: now,
        });
      } else {
        // Shot blast completed successfully -> Move to ht_done (ready for hard machining!)
        batch.update(cardRef, {
          status: 'ht_done',
          currentQty: y.yielded,
          sbFailed: y.failed,
          sbYielded: y.yielded,
          updatedAt: now,
        });

        if (y.failed > 0) {
          batch.set(db.collection('scrapLedger').doc(), {
            tagId: y.tagId,
            batchCode: y.batchCode || '',
            heatCode: y.heatCode || '',
            partId: y.partId,
            partNo: y.partNo || '',
            partName: y.partName || '',
            customerName: y.customerName || '',
            qtyRejected: y.failed,
            defectDescription: 'Shot blasting partial failure',
            stage: 'shot_blast',
            inspectedBy: S.sess.userId,
            inspectedByName: S.sess.name,
            date: s.date,
            createdAt: now,
          });
        }
      }
    }

    batch.update(db.collection('shotBlastSessions').doc(id), {
      status: 'completed',
      yields: yields.map(y => ({ tagId: y.tagId, yielded: y.yielded, failed: y.failed })),
      completedBy: S.sess.userId,
      completedByName: S.sess.name,
      completedAt: now,
      updatedAt: now,
    });

    await batch.commit();
    await logAudit('SB_SESSION_COMPLETED', 'HT', id, null, { sessionNo: s.sessionNo, tagsCount: yields.length });

    closeModal();
    toast(`Shot Blast Session ${s.sessionNo} finalized successfully!`);
    _sbMode = 'list';
    await refreshHT();
  } catch (e) {
    if (errEl) { errEl.textContent = 'Error: ' + friendlyError(e); errEl.style.display = 'block'; }
  }
}

/* ── TAB: unified HISTORY (HT & SB logs) ── */
function renderHistory() {
  const el = document.getElementById('tab-body');
  if (!el) return;

  const doneHT = S_HT.charges.filter(c => c.status === 'completed');
  const doneSB = S_HT.sbSessions.filter(s => s.status === 'completed');

  if (!doneHT.length && !doneSB.length) {
    el.innerHTML = `
      <div class="empty">
        <div class="empty-ic"><i class="ti ti-history"></i></div>
        <h3>No history found</h3>
        <p>Completed heat treatment and shot blast runs will appear here.</p>
      </div>`;
    return;
  }

  // Combine and sort by completed date
  const history = [
    ...doneHT.map(c => ({ type: 'ht', id: c.id, no: c.chargeNo, date: c.date, shift: c.shift, name: c.furnaceNo, by: c.completedByName, at: c.completedAt, tags: c.components })),
    ...doneSB.map(s => ({ type: 'sb', id: s.id, no: s.sessionNo, date: s.date, shift: s.shift, name: s.machineId, by: s.completedByName, at: s.completedAt, tags: s.tags }))
  ].sort((a,b) => {
    const atA = a.at?.toDate ? a.at.toDate() : new Date(a.at || 0);
    const atB = b.at?.toDate ? b.at.toDate() : new Date(b.at || 0);
    return atB - atA;
  });

  el.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
      <div style="font-size:12px;color:var(--txt-muted)">${history.length} completed records logged</div>
      <button class="btn btn-s btn-sm" onclick="refreshHT()"><i class="ti ti-refresh"></i></button>
    </div>

    ${history.map(h => {
      const tagCount = h.tags?.length || 0;
      const isHT = h.type === 'ht';
      return `
        <div class="card" style="margin-bottom:10px;border-left:4px solid ${isHT ? 'var(--warn)' : 'var(--accent-violet)'}">
          <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px;margin-bottom:8px">
            <div>
              <div style="display:flex;align-items:center;gap:6px">
                <span class="imf-badge ${isHT ? 'st-ht_queue' : 'st-sb_wip'}" style="padding:2px 8px;font-size:10px">
                  <i class="ti ${isHT ? 'ti-flame' : 'ti-circles'}"></i> ${isHT ? 'Heat Treatment' : 'Shot Blast'}
                </span>
                <span class="imf-mono" style="font-weight:800;font-size:14px;color:var(--imf-navy)">${h.no}</span>
              </div>
              <div style="font-size:11px;color:var(--txt-muted);margin-top:4px">
                Machine/Furnace: <strong>${h.name}</strong> · Shift: ${getShiftLabel(h.shift)} · Date: ${fmtDate(h.date)}
              </div>
              <div style="font-size:11px;color:var(--txt-muted)">Completed by: ${h.by || '—'} · ${fmtTS(h.at)}</div>
            </div>
            <button class="btn btn-s btn-sm" style="padding:6px 10px;font-weight:700" onclick="viewHistoryItemDetail('${h.type}', '${h.id}')">
              <i class="ti ti-eye"></i> View Logs
            </button>
          </div>
        </div>`;
    }).join('')}
  `;
}

function viewHistoryItemDetail(type, id) {
  if (type === 'ht') {
    _tab = 'ht_charges';
    _chargeMode = 'detail';
    _selChargeId = id;
  } else {
    _tab = 'shot_blasting';
    _sbMode = 'detail';
    _selSbSessionId = id;
  }
  render();
}

/* ── HT & Shot Blast Edit/Delete Functions ── */
function openEditHTChargeModal(id) {
  if (!isAdmin()) { toast('Access denied'); return; }
  const c = S_HT.charges.find(x => x.id === id);
  if (!c) return;

  const shiftOpts = Object.entries(S.shifts || {})
    .map(([k,v])=>`<option value="${k}" ${c.shift===k?'selected':''}>${v.label}</option>`).join('');

  const furnaceOpts = HT_FURNACES_CAR.map(f=>`<option value="${f}" ${c.furnaceNo===f?'selected':''}>${f}</option>`).join('');

  openModal(`
    <div class="modal-handle"></div>
    <div class="modal-title">Edit HT Charge Header</div>
    <div class="row-2">
      <div class="f">
        <label>Date</label>
        <input id="edit-ht-date" type="date" value="${c.date || ''}">
      </div>
      <div class="f">
        <label>Shift</label>
        <select id="edit-ht-shift">${shiftOpts}</select>
      </div>
    </div>
    <div class="row-2" style="margin-top:10px">
      <div class="f">
        <label>Carburizing Furnace</label>
        <select id="edit-ht-cfno">${furnaceOpts}</select>
      </div>
      <div class="f">
        <label>Rev No.</label>
        <input id="edit-ht-rev" type="text" value="${c.revNo || ''}">
      </div>
    </div>

    <div style="font-size:11px;font-weight:700;color:var(--txt-muted);letter-spacing:.06em;margin:14px 0 8px;text-transform:uppercase">Pre-Wash Logs</div>
    <div class="row-2">
      <div class="f">
        <label>Start Time</label>
        <input id="edit-ht-wash-start" type="time" value="${c.prewash?.startTime || ''}">
      </div>
      <div class="f">
        <label>End Time</label>
        <input id="edit-ht-wash-end" type="time" value="${c.prewash?.endTime || ''}">
      </div>
    </div>
    <div class="row-2" style="margin-top:10px">
      <div class="f">
        <label>Pre-wash Temp (°C)</label>
        <input id="edit-ht-wash-temp" type="number" value="${c.prewash?.temp || ''}">
      </div>
      <div class="f">
        <label>Pre-wash pH</label>
        <input id="edit-ht-wash-ph" type="number" step="0.1" value="${c.prewash?.ph || ''}">
      </div>
    </div>

    <div style="font-size:11px;font-weight:700;color:var(--txt-muted);letter-spacing:.06em;margin:14px 0 8px;text-transform:uppercase">Dot Punching</div>
    <div class="f">
      <label><input type="checkbox" id="edit-ht-dp-done" ${c.dotPunch?.done ? 'checked' : ''}> Dot Punching Done</label>
    </div>
    <div class="row-2" style="margin-top:10px">
      <div class="f">
        <label>Done By</label>
        <input id="edit-ht-dp-who" type="text" value="${c.dotPunch?.who || ''}">
      </div>
      <div class="f">
        <label>Done Time</label>
        <input id="edit-ht-dp-time" type="time" value="${c.dotPunch?.time || ''}">
      </div>
    </div>

    <div id="edit-ht-err" style="display:none;color:var(--err);font-size:12px;margin-bottom:8px"></div>
    <div style="display:flex;gap:10px;margin-top:16px">
      <button class="btn btn-s" style="flex:1" onclick="closeModal()">Cancel</button>
      <button class="btn btn-p" style="flex:1" onclick="saveEditHTCharge('${c.id}')">Save Changes</button>
    </div>
  `);
}

async function saveEditHTCharge(id) {
  if (!isAdmin()) { toast('Access denied'); return; }
  const c = S_HT.charges.find(x => x.id === id);
  if (!c) return;

  const date = document.getElementById('edit-ht-date')?.value;
  const shift = document.getElementById('edit-ht-shift')?.value;
  const furnace = document.getElementById('edit-ht-cfno')?.value;
  const revNo = document.getElementById('edit-ht-rev')?.value;

  const washStart = document.getElementById('edit-ht-wash-start')?.value || '';
  const washEnd = document.getElementById('edit-ht-wash-end')?.value || '';
  const washTemp = parseInt(document.getElementById('edit-ht-wash-temp')?.value) || null;
  const washPh = parseFloat(document.getElementById('edit-ht-wash-ph')?.value) || null;

  const dpDone = document.getElementById('edit-ht-dp-done')?.checked || false;
  const dpWho = document.getElementById('edit-ht-dp-who')?.value || '';
  const dpTime = document.getElementById('edit-ht-dp-time')?.value || '';

  if (!date || !shift || !furnace) { toast('Date, Shift, and Furnace are required'); return; }

  try {
    await db.collection('htCharges').doc(id).update({
      date, shift, furnaceNo: furnace, revNo,
      prewash: { startTime: washStart, endTime: washEnd, temp: washTemp, ph: washPh },
      dotPunch: { done: dpDone, who: dpWho, time: dpTime },
      updatedAt: serverTS(),
    });
    await logAudit('EDIT_HT_CHARGE', 'HT', id, c, { date, shift, furnaceNo: furnace, revNo });
    closeModal();
    await refreshHT();
    renderHTDetail(id);
    toast('HT Charge updated ✓');
  } catch (e) {
    toast('Error: ' + friendlyError(e));
  }
}

async function deleteHTCharge(id) {
  if (!isTanmay()) { toast('Access denied'); return; }
  const c = S_HT.charges.find(x => x.id === id);
  if (!c) return;
  if (!confirm(`Delete HT Charge ${c.chargeNo || c.id}? This will revert all its route cards to Soft Done and cannot be undone.`)) return;

  try {
    const batch = db.batch();
    for (const comp of c.components || []) {
      batch.update(db.collection('routeCards').doc(comp.tagId), {
        status: 'soft_done',
        htChargeId: firebase.firestore.FieldValue.delete(),
        updatedAt: serverTS()
      });
    }
    batch.delete(db.collection('htCharges').doc(id));
    await batch.commit();
    await logAudit('DELETE_HT_CHARGE', 'HT', id, c, null);
    toast('HT Charge deleted ✓');
    _chargeMode = 'list';
    await refreshHT();
    render();
  } catch (e) {
    toast('Error: ' + friendlyError(e));
  }
}

function openEditSbSessionModal(id) {
  if (!isAdmin()) { toast('Access denied'); return; }
  const s = S_HT.sbSessions.find(x => x.id === id);
  if (!s) return;

  const shiftOpts = Object.entries(S.shifts || {})
    .map(([k,v])=>`<option value="${k}" ${s.shift===k?'selected':''}>${v.label}</option>`).join('');

  const machs = S.machines.filter(m => m.stage === 'ht' && m.active !== false);
  const machOpts = machs.map(m => `<option value="${m.name}" ${s.machineId===m.name?'selected':''}>${m.name}</option>`).join('');

  openModal(`
    <div class="modal-handle"></div>
    <div class="modal-title">Edit Shot Blast Session</div>
    <div class="row-2">
      <div class="f">
        <label>Date</label>
        <input id="edit-sb-date" type="date" value="${s.date || ''}">
      </div>
      <div class="f">
        <label>Shift</label>
        <select id="edit-sb-shift">${shiftOpts}</select>
      </div>
    </div>
    <div class="row-2" style="margin-top:10px">
      <div class="f">
        <label>Shot Blast Machine</label>
        <select id="edit-sb-mach">${machOpts}</select>
      </div>
      <div class="f">
        <label>Operator Name</label>
        <input id="edit-sb-operator" type="text" value="${s.operator || ''}">
      </div>
    </div>
    <div style="display:flex;gap:10px;margin-top:16px">
      <button class="btn btn-s" style="flex:1" onclick="closeModal()">Cancel</button>
      <button class="btn btn-p" style="flex:1" onclick="saveEditSbSession('${s.id}')">Save Changes</button>
    </div>
  `);
}

async function saveEditSbSession(id) {
  if (!isAdmin()) { toast('Access denied'); return; }
  const s = S_HT.sbSessions.find(x => x.id === id);
  if (!s) return;

  const date = document.getElementById('edit-sb-date')?.value;
  const shift = document.getElementById('edit-sb-shift')?.value;
  const machine = document.getElementById('edit-sb-mach')?.value;
  const operator = document.getElementById('edit-sb-operator')?.value;

  if (!date || !shift || !machine) { toast('Date, Shift, and Machine are required'); return; }

  try {
    await db.collection('shotBlastSessions').doc(id).update({
      date, shift, machineId: machine, operator,
      updatedAt: serverTS(),
    });
    await logAudit('EDIT_SB_SESSION', 'HT', id, s, { date, shift, machineId: machine, operator });
    closeModal();
    await refreshHT();
    renderSbSessionDetail(id);
    toast('Shot Blast session updated ✓');
  } catch (e) {
    toast('Error: ' + friendlyError(e));
  }
}

async function deleteSbSession(id) {
  if (!isTanmay()) { toast('Access denied'); return; }
  const s = S_HT.sbSessions.find(x => x.id === id);
  if (!s) return;

  if (!confirm(`Delete Shot Blast session ${s.sessionNo || s.id}? This will revert route cards, restore split quantities, and delete the session.`)) return;

  try {
    const tagIds = (s.tags || []).map(t => t.tagId);
    if (!tagIds.length) {
      await db.collection('shotBlastSessions').doc(id).delete();
      await logAudit('DELETE_SB_SESSION', 'HT', id, s, null);
      closeModal();
      await refreshHT();
      render();
      return;
    }

    const cardRefs = tagIds.map(tid => db.collection('routeCards').doc(tid));
    const [cardDocs, childSnap, scrapSnap] = await Promise.all([
      Promise.all(cardRefs.map(ref => ref.get())),
      db.collection('routeCards').where('parentCardUid', 'in', tagIds).get(),
      db.collection('scrapLedger').where('tagId', 'in', tagIds).get()
    ]);

    const childDocs = childSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    const scrapDocs = scrapSnap.docs.map(d => ({ id: d.id, ...d.data() })).filter(d => d.stage === 'shot_blast');

    for (let i = 0; i < tagIds.length; i++) {
      if (cardDocs[i].exists) {
        const card = cardDocs[i].data();
        if (card.status !== 'ht_done' && card.status !== 'scrapped' && card.status !== 'sb_wip' && card.status !== 'sb_pending') {
          toast(`Can't delete: Tag ${tagIds[i]} has moved downstream to ${card.status}`, 5500);
          return;
        }
      }
    }

    for (const child of childDocs) {
      if (child.status !== 'sb_pending' && child.status !== 'sb_wip' && child.status !== 'ht_done') {
        toast(`Can't delete: Split child card ${child.tagId} has moved downstream to ${child.status}`, 5500);
        return;
      }
    }

    const batch = db.batch();

    for (let i = 0; i < tagIds.length; i++) {
      const parentId = tagIds[i];
      if (!cardDocs[i].exists) continue;
      const parentData = cardDocs[i].data();
      const child = childDocs.find(c => c.parentCardUid === parentId);

      let newQty = parentData.currentQty;
      if (child) {
        newQty += child.currentQty;
        batch.delete(db.collection('routeCards').doc(child.tagId));
      }

      batch.update(cardRefs[i], {
        currentQty: newQty,
        status: 'sb_pending',
        sbFailed: firebase.firestore.FieldValue.delete(),
        sbYielded: firebase.firestore.FieldValue.delete(),
        updatedAt: serverTS(),
      });
    }

    for (const scrap of scrapDocs) {
      batch.delete(db.collection('scrapLedger').doc(scrap.id));
    }

    batch.delete(db.collection('shotBlastSessions').doc(id));

    await batch.commit();
    await logAudit('DELETE_SB_SESSION', 'HT', id, s, null);

    _sbMode = 'list';
    closeModal();
    await refreshHT();
    render();
    toast('Shot Blast session deleted, route cards restored ✓');
  } catch (e) {
    console.error('deleteSbSession error:', e);
    toast('Delete failed: ' + friendlyError(e));
  }
}

/* ── DOM Load ── */
document.addEventListener('DOMContentLoaded', init);
