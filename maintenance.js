/* ═══════════════════════════════════════════════════════════════════
   IMF ProTrack — Maintenance
   4-step breakdown handshake, free-entry spares, PM log, health metrics.

   Collections read:
     breakdowns    — breakdown lifecycle docs
     sparesRequests — spares requests (linked to breakdowns)
     pmLogs        — PM completion records
   Collections written:
     breakdowns    — step updates
     sparesRequests — created at diagnose step
     machineStatus  — updated on report/release
   ═══════════════════════════════════════════════════════════════════ */

'use strict';

/* ── Tabs ────────────────────────────────────────────────────────────── */
const TABS = [
  { key: 'hub',        icon: 'ti-layout-dashboard', label: 'Hub'        },
  { key: 'breakdowns', icon: 'ti-alert-triangle',   label: 'Breakdowns' },
  { key: 'pm',         icon: 'ti-calendar-check',   label: 'PM Log'     },
  { key: 'health',     icon: 'ti-heart-rate-monitor', label: 'Health'   },
];

const FAULT_CATS = ['Mechanical', 'Electrical', 'Hydraulic', 'Pneumatic', 'Tooling', 'Software', 'Other'];
const PM_INTERVALS = [
  { key: 'daily',     label: 'Daily',     days: 1   },
  { key: 'weekly',    label: 'Weekly',    days: 7   },
  { key: 'monthly',   label: 'Monthly',   days: 30  },
  { key: 'quarterly', label: 'Quarterly', days: 90  },
  { key: 'yearly',    label: 'Yearly',    days: 365 },
];

/* ── State ───────────────────────────────────────────────────────────── */
let _tab       = 'hub';
let _bdFilter        = 'active'; // 'active' | 'all'
let _diagSpares      = [];       // spares being entered in diagnose modal
let _diagNeedsSpares = false;    // toggle in diagnose modal
let _savingBreakdown = false;    // guard against double-submit on Report

const S_MNT = {
  breakdowns:     [],
  pmLogs:         [],
  sparesRequests: [],
};

/* ── Boot ────────────────────────────────────────────────────────────── */
async function init() {
  try { await initShell(); } catch (e) {
    clearSess(); window.location.replace('index.html'); return;
  }
  await loadMaintData();
  render();
  document.getElementById('loading-screen').style.display = 'none';
  document.getElementById('app').style.display = '';
}

async function loadMaintData() {
  try {
    const [bdSnap, pmSnap, spSnap] = await Promise.all([
      db.collection('breakdowns').orderBy('createdAt', 'desc').limit(200).get(),
      db.collection('pmLogs').orderBy('createdAt', 'desc').limit(500).get(),
      db.collection('sparesRequests').orderBy('createdAt', 'desc').limit(200).get(),
    ]);
    S_MNT.breakdowns     = bdSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    S_MNT.pmLogs         = pmSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    S_MNT.sparesRequests = spSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch (e) { console.warn('loadMaintData:', e.message); }
}

async function refreshMaint() {
  await loadMaintData();
  render();
}

/* ── Shell render ────────────────────────────────────────────────────── */
function render() {
  const activeBDs = S_MNT.breakdowns.filter(b => b.status !== 'released').length;

  const tabHtml = TABS.map(t => {
    const active = _tab === t.key;
    const badge  = t.key === 'hub' && activeBDs > 0 ? activeBDs : 0;
    return `
      <button onclick="switchTab('${t.key}')"
        style="flex:1;padding:8px 4px;border:none;
               background:${active ? 'var(--acc)' : 'var(--sur)'};
               color:${active ? '#fff' : 'var(--txt)'};
               border-radius:6px;font-size:12px;font-weight:700;cursor:pointer;
               display:flex;align-items:center;justify-content:center;gap:5px;transition:background .15s">
        <i class="ti ${t.icon}" style="font-size:13px"></i> ${t.label}
        ${badge > 0
          ? `<span style="background:var(--err);color:#fff;border-radius:99px;padding:1px 6px;font-size:10px">${badge}</span>`
          : ''}
      </button>`;
  }).join('');

  document.getElementById('page-content').innerHTML = `
    <div style="padding-bottom:80px">
      <div style="display:flex;gap:4px;background:var(--sur);border-radius:8px;padding:4px;margin-bottom:14px;flex-wrap:wrap">
        ${tabHtml}
      </div>
      <div id="tab-body"></div>
    </div>`;

  renderTab();
}

function switchTab(key) {
  _tab = key;
  render();
}

function renderTab() {
  const el = document.getElementById('tab-body');
  if (!el) return;
  if      (_tab === 'hub')        renderHub();
  else if (_tab === 'breakdowns') renderBreakdowns();
  else if (_tab === 'pm')         renderPM();
  else if (_tab === 'health')     renderHealth();
}

/* ═══════════════════════════════════════════════════════════════════
   TAB: HUB
   ═══════════════════════════════════════════════════════════════════ */
function renderHub() {
  const el = document.getElementById('tab-body');
  if (!el) return;

  const activeBDs = S_MNT.breakdowns.filter(b => b.status !== 'released');
  const machines  = S.machines || [];

  // Derive machine status from active breakdowns
  const bdByMachine = {};
  activeBDs.forEach(b => {
    if (!bdByMachine[b.machineId]) bdByMachine[b.machineId] = [];
    bdByMachine[b.machineId].push(b);
  });

  const canReport = canDo('maintenance') || S.sess?.role === 'admin' || S.sess?.role === 'supervisor';

  el.innerHTML = `
    ${activeBDs.length > 0 ? `
      <div style="background:var(--err);border-radius:var(--rs);padding:12px 16px;margin-bottom:14px;
                  display:flex;align-items:center;gap:12px;color:#fff">
        <i class="ti ti-alert-triangle" style="font-size:22px;flex-shrink:0"></i>
        <div>
          <div style="font-weight:800">${activeBDs.length} Active Breakdown${activeBDs.length !== 1 ? 's' : ''}</div>
          <div style="font-size:12px;opacity:.85">${activeBDs.filter(b=>b.status==='reported').length} reported · ${activeBDs.filter(b=>b.status==='acknowledged').length} acknowledged · ${activeBDs.filter(b=>b.status==='diagnosed').length} diagnosed</div>
        </div>
        <button onclick="switchTab('breakdowns')"
          style="margin-left:auto;border:none;background:rgba(255,255,255,.2);color:#fff;
                 border-radius:6px;padding:7px 12px;cursor:pointer;font-size:12px;font-weight:700;white-space:nowrap">
          View All
        </button>
      </div>` : ''}

    ${canReport ? `
      <button class="btn btn-p" style="width:100%;margin-bottom:14px" onclick="openReportModal()">
        <i class="ti ti-alert-triangle"></i> Report Breakdown
      </button>` : ''}

    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
      <div style="font-size:11px;font-weight:700;color:var(--txt-muted);letter-spacing:.06em">MACHINE STATUS</div>
      <button class="btn btn-s btn-sm" onclick="refreshMaint()"><i class="ti ti-refresh"></i> Refresh</button>
    </div>

    ${machines.length
      ? `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:10px;margin-bottom:16px">
           ${machines.map(m => machineStatusCard(m, bdByMachine[m.id] || [])).join('')}
         </div>`
      : `<div class="empty"><div class="empty-ic"><i class="ti ti-tool"></i></div><h3>No machines</h3><p>Add machines in Master Data.</p></div>`}

    ${activeBDs.length > 0 ? `
      <div style="font-size:11px;font-weight:700;color:var(--txt-muted);letter-spacing:.06em;margin-bottom:8px">ACTIVE BREAKDOWNS</div>
      ${activeBDs.slice(0, 5).map(b => bdCardCompact(b)).join('')}` : ''}`;
}

function machineStatusCard(m, bds) {
  const isDown = bds.length > 0;
  const bd     = bds[0];
  const stepLbl = { reported: 'Reported', acknowledged: 'Acknowledged', diagnosed: 'Diagnosed' };
  const bg      = isDown ? '#fef2f2' : '#f0fdf4';
  const bdr     = isDown ? '#fca5a5' : '#86efac';
  const col     = isDown ? 'var(--err)' : 'var(--ok)';
  const ico     = isDown ? 'ti-alert-circle' : 'ti-circle-check';

  return `
    <div style="background:${bg};border:1.5px solid ${bdr};border-radius:var(--rs);padding:12px;cursor:default">
      <div style="display:flex;align-items:center;gap:6px;margin-bottom:6px">
        <i class="ti ${ico}" style="color:${col};font-size:16px"></i>
        <div style="font-weight:800;font-size:13px;color:var(--txt)">${m.code || m.id}</div>
      </div>
      <div style="font-size:11px;color:var(--txt-muted);margin-bottom:4px">${m.name || '—'}</div>
      <div style="font-size:11px;font-weight:700;color:${col}">
        ${isDown ? (stepLbl[bd.status] || bd.status) : 'Operational'}
      </div>
      ${isDown ? `<div style="font-size:10px;color:var(--txt-muted);margin-top:2px">${fmtTS(bd.createdAt)}</div>` : ''}
    </div>`;
}

function bdCardCompact(b) {
  const mach = S.machines.find(m => m.id === b.machineId);
  const STEP_COL = { reported: 'var(--err)', acknowledged: 'var(--warn)', diagnosed: 'var(--acc)', released: 'var(--ok)' };
  return `
    <div class="card" style="margin-bottom:8px;border-left:3px solid ${STEP_COL[b.status] || 'var(--bdr)'};cursor:pointer"
      onclick="switchTab('breakdowns')">
      <div style="display:flex;align-items:center;justify-content:space-between">
        <div>
          <div style="font-weight:700;font-size:13px">${mach?.code || b.machineId || '—'} — ${mach?.name || '—'}</div>
          <div style="font-size:11px;color:var(--txt-muted)">${b.description || '—'}</div>
        </div>
        <span style="font-size:10px;font-weight:700;background:${STEP_COL[b.status] || 'var(--bdr)'};color:#fff;
                     border-radius:4px;padding:2px 7px;text-transform:uppercase;flex-shrink:0;margin-left:8px">
          ${b.status}
        </span>
      </div>
    </div>`;
}

/* ═══════════════════════════════════════════════════════════════════
   TAB: BREAKDOWNS
   ═══════════════════════════════════════════════════════════════════ */
function renderBreakdowns() {
  const el = document.getElementById('tab-body');
  if (!el) return;

  const canReport = canDo('maintenance') || S.sess?.role === 'admin' || S.sess?.role === 'supervisor';

  const filtered = _bdFilter === 'active'
    ? S_MNT.breakdowns.filter(b => b.status !== 'released')
    : S_MNT.breakdowns;

  el.innerHTML = `
    <div style="display:flex;gap:8px;margin-bottom:12px;align-items:center;flex-wrap:wrap">
      ${canReport ? `<button class="btn btn-p" onclick="openReportModal()"><i class="ti ti-alert-triangle"></i> Report Breakdown</button>` : ''}
      <div style="display:flex;gap:4px;background:var(--sur);border-radius:8px;padding:3px;flex:1;min-width:140px">
        <button onclick="bdSetFilter('active')"
          style="flex:1;padding:6px;border:none;border-radius:6px;font-size:11px;font-weight:700;cursor:pointer;
                 background:${_bdFilter==='active'?'var(--acc)':'transparent'};
                 color:${_bdFilter==='active'?'#fff':'var(--txt)'}">Active</button>
        <button onclick="bdSetFilter('all')"
          style="flex:1;padding:6px;border:none;border-radius:6px;font-size:11px;font-weight:700;cursor:pointer;
                 background:${_bdFilter==='all'?'var(--acc)':'transparent'};
                 color:${_bdFilter==='all'?'#fff':'var(--txt)'}">All</button>
      </div>
      <button class="btn btn-s btn-sm" onclick="refreshMaint()"><i class="ti ti-refresh"></i></button>
    </div>

    ${filtered.length
      ? filtered.map(bdCard).join('')
      : `<div class="empty"><div class="empty-ic"><i class="ti ti-circle-check"></i></div>
           <h3>${_bdFilter === 'active' ? 'No active breakdowns' : 'No breakdown records'}</h3>
           <p>${_bdFilter === 'active' ? 'All machines are running.' : 'No breakdowns have been reported yet.'}</p>
         </div>`}`;
}

function bdSetFilter(f) {
  _bdFilter = f;
  renderBreakdowns();
}

function bdCard(b) {
  const mach = S.machines.find(m => m.id === b.machineId);
  const STEP_COL  = { reported: 'var(--err)', acknowledged: 'var(--warn)', diagnosed: 'var(--acc)', released: 'var(--ok)' };
  const STEP_ICON = { reported: 'ti-alert-triangle', acknowledged: 'ti-eye', diagnosed: 'ti-stethoscope', released: 'ti-circle-check' };
  const steps     = ['reported', 'acknowledged', 'diagnosed', 'released'];
  const stepIdx   = steps.indexOf(b.status);
  const stepCol   = STEP_COL[b.status] || 'var(--bdr)';

  const canAck     = b.status === 'reported'     && (canDo('maintenance') || S.sess?.role === 'admin');
  const canDiag    = b.status === 'acknowledged' && (canDo('maintenance') || S.sess?.role === 'admin');
  const canRelease = b.status === 'diagnosed'    && (canDo('maintenance') || S.sess?.role === 'admin');

  return `
    <div class="card" style="margin-bottom:12px;border-left:3px solid ${stepCol}">
      <!-- Header -->
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px;margin-bottom:10px">
        <div>
          <div style="font-weight:800;font-size:14px">${mach?.name || b.machineId || '—'} <span style="font-family:monospace;font-size:11px;font-weight:400;color:var(--txt-muted)">${mach?.code || ''}</span></div>
          <div style="font-size:11px;color:var(--txt-muted)">Reported by ${b.reportedByName || '—'} · ${fmtTS(b.createdAt)}</div>
        </div>
        <span style="font-size:10px;font-weight:700;background:${stepCol};color:#fff;
                     border-radius:4px;padding:3px 8px;text-transform:uppercase;flex-shrink:0">
          <i class="ti ${STEP_ICON[b.status] || 'ti-circle'}" style="font-size:10px"></i> ${b.status}
        </span>
      </div>

      <!-- Step progress bar -->
      <div style="display:flex;gap:3px;margin-bottom:10px">
        ${steps.map((s, i) => `
          <div style="flex:1;height:4px;border-radius:2px;
                      background:${i <= stepIdx ? stepCol : 'var(--bdr)'}"></div>`).join('')}
      </div>

      <!-- Description -->
      <div style="background:var(--bg);border-radius:6px;padding:8px 10px;margin-bottom:10px;font-size:13px">
        ${b.description || '—'}
      </div>

      ${b.faultDescription ? `
        <div style="margin-bottom:8px">
          <div style="font-size:10px;font-weight:700;color:var(--txt-muted);letter-spacing:.06em">FAULT</div>
          <div style="font-size:12px">${b.faultCategory ? `<strong>${b.faultCategory}</strong> — ` : ''}${b.faultDescription}</div>
        </div>` : ''}

      ${b.spares && b.spares.length > 0 ? (() => {
          const spReq = b.sparesRequestId
            ? S_MNT.sparesRequests.find(x => x.id === b.sparesRequestId)
            : null;
          return `
        <div style="margin-bottom:10px">
          <div style="font-size:10px;font-weight:700;color:var(--txt-muted);letter-spacing:.06em;margin-bottom:4px">SPARES REQUESTED</div>
          ${b.spares.map(sp => `
            <div style="display:flex;align-items:center;justify-content:space-between;font-size:12px;padding:4px 0;border-bottom:1px solid var(--bdr)">
              <span>${sp.name} <span style="color:var(--txt-muted)">×${sp.qty}</span></span>
              <span style="font-weight:700">${fmtINR((sp.qty||0)*(sp.unitRate||0))}</span>
            </div>`).join('')}
          <div style="text-align:right;font-size:12px;font-weight:800;margin-top:4px">Total: ${fmtINR(b.sparesTotal || 0)}</div>
          ${spReq && spReq.status === 'approved' ? `
          <button class="btn btn-s" style="margin-top:8px;width:100%" onclick="printSparesMRO_bd('${spReq.id}')">
            🖨️ Print Approved Spares
          </button>` : ''}
        </div>`;
        })() : ''}

      ${b.fixDescription ? `
        <div style="margin-bottom:8px">
          <div style="font-size:10px;font-weight:700;color:var(--txt-muted);letter-spacing:.06em">FIX APPLIED</div>
          <div style="font-size:12px">${b.fixDescription}</div>
        </div>` : ''}

      ${b.status === 'released' ? `
        <div style="font-size:11px;color:var(--txt-muted);border-top:1px solid var(--bdr);padding-top:8px">
          Released by ${b.releasedByName || '—'} · ${fmtTS(b.releasedAt)}
          · Downtime: <strong>${b.totalDowntimeMins || 0} min</strong>
        </div>` : ''}

      <!-- Action buttons -->
      ${canAck     ? `<button class="btn btn-ok" style="width:100%;margin-top:8px" onclick="openAcknowledgeModal('${b.id}')"><i class="ti ti-eye"></i> Acknowledge</button>` : ''}
      ${canDiag    ? `<button class="btn btn-p"  style="width:100%;margin-top:8px" onclick="openDiagnoseModal('${b.id}')"><i class="ti ti-stethoscope"></i> Diagnose</button>` : ''}
      ${canRelease ? `<button class="btn btn-ok" style="width:100%;margin-top:8px" onclick="openReleaseModal('${b.id}')"><i class="ti ti-circle-check"></i> Release Machine</button>` : ''}
    </div>`;
}

/* ── REPORT new breakdown ────────────────────────────────────────────── */
function openReportModal() {
  const machOpts = S.machines.map(m => `<option value="${m.id}">${m.code} — ${m.name}</option>`).join('');
  openModal(`
    <div class="modal-handle"></div>
    <div class="modal-title">Report Breakdown</div>

    <div class="f">
      <label>Machine <span style="color:var(--err)">*</span></label>
      <select id="bd-machine" style="font-size:13px">
        <option value="">— Select machine —</option>
        ${machOpts}
      </select>
    </div>
    <div class="f">
      <label>Description <span style="color:var(--err)">*</span></label>
      <textarea id="bd-desc" rows="3" placeholder="Describe what happened…" style="resize:vertical;font-size:13px"></textarea>
    </div>
    <div class="row-2">
      <div class="f">
        <label>Date</label>
        <input type="date" id="bd-date" value="${dateStr()}" style="font-size:13px">
      </div>
      <div class="f">
        <label>Shift</label>
        <select id="bd-shift" style="font-size:13px">
          <option value="A">A</option>
          <option value="B">B</option>
          <option value="C">C</option>
        </select>
      </div>
    </div>

    <div id="bd-modal-err" style="display:none;color:var(--err);font-size:12px;font-weight:700;margin-bottom:8px"></div>
    <div style="display:flex;gap:8px;margin-top:4px">
      <button class="btn btn-s" style="flex:1" onclick="closeModal()">Cancel</button>
      <button class="btn btn-d" style="flex:1" onclick="saveBreakdown()">
        <i class="ti ti-alert-triangle"></i> Submit Report
      </button>
    </div>`);
}

async function saveBreakdown() {
  if (_savingBreakdown) return;   // prevent double-tap / rapid click creating duplicates

  const machineId = document.getElementById('bd-machine')?.value;
  const desc      = (document.getElementById('bd-desc')?.value || '').trim();
  const date      = document.getElementById('bd-date')?.value || dateStr();
  const shift     = document.getElementById('bd-shift')?.value || 'A';
  const errEl     = document.getElementById('bd-modal-err');

  if (!machineId) { if (errEl) { errEl.textContent = 'Select a machine'; errEl.style.display = ''; } return; }
  if (!desc)      { if (errEl) { errEl.textContent = 'Enter description'; errEl.style.display = ''; } return; }

  _savingBreakdown = true;
  const submitBtn = document.querySelector('[onclick="saveBreakdown()"]');
  if (submitBtn) { submitBtn.disabled = true; submitBtn.innerHTML = '<i class="ti ti-loader"></i> Saving…'; }

  const mach = S.machines.find(m => m.id === machineId);
  try {
    const batch = db.batch();
    const now   = serverTS();

    const bdRef = db.collection('breakdowns').doc();
    batch.set(bdRef, {
      machineId,
      machineCode: mach?.code || '',
      machineName: mach?.name || '',
      date, shift,
      description: desc,
      status: 'reported',
      reportedBy:     S.sess.userId,
      reportedByName: S.sess.name,
      reportedAt:  now,
      acknowledgedBy: '', acknowledgedByName: '', acknowledgedAt: null,
      faultCategory: '', faultDescription: '',
      spares: [], sparesTotal: 0, sparesRequestId: '',
      fixDescription: '',
      releasedBy: '', releasedByName: '', releasedAt: null,
      totalDowntimeMins: 0,
      createdAt: now,
    });

    batch.set(db.collection('machineStatus').doc(machineId), {
      machineId, machineCode: mach?.code || '', machineName: mach?.name || '',
      status: 'breakdown',
      activeBreakdownId: bdRef.id,
      updatedAt: now,
    }, { merge: true });

    await batch.commit();
    await logAudit('REPORT_BREAKDOWN', 'MAINTENANCE', bdRef.id, null, { machineId, status: 'reported' });
    toast('Breakdown reported');
    _savingBreakdown = false;
    closeModal();
    await refreshMaint();
  } catch (e) {
    _savingBreakdown = false;
    if (submitBtn) { submitBtn.disabled = false; submitBtn.innerHTML = '<i class="ti ti-alert-triangle"></i> Submit Report'; }
    toast('Error: ' + e.message);
  }
}

/* ── ACKNOWLEDGE ─────────────────────────────────────────────────────── */
function openAcknowledgeModal(id) {
  const b    = S_MNT.breakdowns.find(x => x.id === id);
  if (!b) return;
  const mach = S.machines.find(m => m.id === b.machineId);
  openModal(`
    <div class="modal-handle"></div>
    <div class="modal-title">Acknowledge Breakdown</div>
    <div style="background:var(--bg);border-radius:var(--rs);padding:12px;margin-bottom:14px;font-size:13px">
      <strong>${mach?.name || b.machineId}</strong> — ${b.description}
    </div>
    <div class="f">
      <label>Initial remarks (optional)</label>
      <input type="text" id="ack-rmk" placeholder="e.g. On my way to inspect…" style="font-size:13px">
    </div>
    <div style="display:flex;gap:8px;margin-top:4px">
      <button class="btn btn-s" style="flex:1" onclick="closeModal()">Cancel</button>
      <button class="btn btn-ok" style="flex:1" onclick="saveAcknowledge('${id}')">
        <i class="ti ti-eye"></i> Acknowledge
      </button>
    </div>`);
}

async function saveAcknowledge(id) {
  const b   = S_MNT.breakdowns.find(x => x.id === id);
  if (!b) return;
  const rmk = (document.getElementById('ack-rmk')?.value || '').trim();
  try {
    await db.collection('breakdowns').doc(id).update({
      status: 'acknowledged',
      acknowledgedBy:     S.sess.userId,
      acknowledgedByName: S.sess.name,
      acknowledgedAt:     serverTS(),
      ...(rmk ? { acknowledgeRemarks: rmk } : {}),
      updatedAt: serverTS(),
    });
    await logAudit('ACKNOWLEDGE_BREAKDOWN', 'MAINTENANCE', id, b, { status: 'acknowledged' });
    toast('Breakdown acknowledged ✓');
    closeModal();
    await refreshMaint();
  } catch (e) { toast('Error: ' + e.message); }
}

/* ── DIAGNOSE ────────────────────────────────────────────────────────── */
function openDiagnoseModal(id) {
  const b    = S_MNT.breakdowns.find(x => x.id === id);
  if (!b) return;
  const mach = S.machines.find(m => m.id === b.machineId);
  _diagSpares      = [];
  _diagNeedsSpares = false;

  const faultOpts = FAULT_CATS.map(c => `<option>${c}</option>`).join('');
  openModal(`
    <div class="modal-handle"></div>
    <div class="modal-title">Diagnose Breakdown</div>
    <div style="background:var(--bg);border-radius:var(--rs);padding:10px 12px;margin-bottom:14px;font-size:12px;color:var(--txt-mid)">
      <strong>${mach?.name || b.machineId}</strong> — ${b.description}
    </div>

    <div class="f">
      <label>Fault Category <span style="color:var(--err)">*</span></label>
      <select id="diag-cat" style="font-size:13px">
        <option value="">— Select —</option>
        ${faultOpts}
      </select>
    </div>
    <div class="f">
      <label>Fault Description <span style="color:var(--err)">*</span></label>
      <textarea id="diag-desc" rows="3" placeholder="Describe the root cause, what failed and why…" style="resize:vertical;font-size:13px"></textarea>
    </div>

    <!-- Spares toggle -->
    <div style="border-top:1px solid var(--bdr);margin:14px 0 12px;padding-top:14px">
      <div style="font-size:12px;font-weight:800;color:var(--txt);margin-bottom:10px">
        <i class="ti ti-package" style="color:var(--acc)"></i> Spare Parts Required?
      </div>
      <div style="display:flex;gap:8px;margin-bottom:12px">
        <button id="spares-no-btn" onclick="diagToggleSpares(false)"
          style="flex:1;padding:10px;border-radius:var(--rs);border:2px solid var(--ok);
                 background:var(--ok);color:#fff;font-weight:700;font-size:13px;cursor:pointer">
          <i class="ti ti-x"></i> No Spares Needed
        </button>
        <button id="spares-yes-btn" onclick="diagToggleSpares(true)"
          style="flex:1;padding:10px;border-radius:var(--rs);border:2px solid var(--bdr);
                 background:var(--sur);color:var(--txt-mid);font-weight:700;font-size:13px;cursor:pointer">
          <i class="ti ti-plus"></i> Yes, Add Spares
        </button>
      </div>

      <div id="diag-spares-form" style="display:none">
        <div style="font-size:11px;color:var(--txt-muted);margin-bottom:10px;padding:8px 10px;background:#fef9c3;border-radius:var(--rxs);border:1px solid #fde68a">
          <i class="ti ti-info-circle" style="color:#92400e"></i> Machine release is <strong>not blocked</strong> by procurement — spares request runs in parallel.
        </div>
        <div id="diag-spares-list"></div>
        <button class="btn btn-s" style="width:100%;margin-bottom:8px" onclick="diagAddSpare()">
          <i class="ti ti-plus"></i> Add Another Spare
        </button>
        <div id="diag-spares-total" style="text-align:right;font-size:13px;font-weight:800;color:var(--txt);display:none"></div>
      </div>
    </div>

    <div id="diag-modal-err" style="display:none;color:var(--err);font-size:12px;font-weight:700;margin-bottom:8px"></div>
    <div style="display:flex;gap:8px">
      <button class="btn btn-s" style="flex:1" onclick="closeModal()">Cancel</button>
      <button class="btn btn-p" style="flex:1" onclick="saveDiagnose('${id}')">
        <i class="ti ti-stethoscope"></i> Save Diagnosis
      </button>
    </div>`);
}

function diagToggleSpares(needs) {
  _diagNeedsSpares = needs;
  const noBtn   = document.getElementById('spares-no-btn');
  const yesBtn  = document.getElementById('spares-yes-btn');
  const formDiv = document.getElementById('diag-spares-form');
  const activeStyle   = 'flex:1;padding:10px;border-radius:var(--rs);border:2px solid;font-weight:700;font-size:13px;cursor:pointer;';
  if (noBtn) {
    noBtn.style.cssText  = activeStyle + (needs ? 'border-color:var(--bdr);background:var(--sur);color:var(--txt-mid)' : 'border-color:var(--ok);background:var(--ok);color:#fff');
  }
  if (yesBtn) {
    yesBtn.style.cssText = activeStyle + (needs ? 'border-color:var(--acc);background:var(--acc);color:#fff' : 'border-color:var(--bdr);background:var(--sur);color:var(--txt-mid)');
  }
  if (formDiv) {
    formDiv.style.display = needs ? '' : 'none';
    if (needs && _diagSpares.length === 0) {
      _diagSpares.push({ name: '', qty: 1, unitRate: 0, supplierName: '' });
      renderDiagSpares();
    }
  }
}

function diagAddSpare() {
  _diagSpares.push({ name: '', qty: 1, unitRate: 0, supplierName: '' });
  renderDiagSpares();
}

function diagRemoveSpare(idx) {
  _diagSpares.splice(idx, 1);
  renderDiagSpares();
}

function diagReadSpares() {
  _diagSpares = _diagSpares.map((sp, i) => ({
    name:         (document.getElementById(`sp-name-${i}`)?.value || '').trim(),
    qty:          parseFloat(document.getElementById(`sp-qty-${i}`)?.value  || '1') || 1,
    unitRate:     parseFloat(document.getElementById(`sp-rate-${i}`)?.value || '0') || 0,
    supplierName: (document.getElementById(`sp-supp-${i}`)?.value || '').trim(),
  }));
}

function renderDiagSpares() {
  const el = document.getElementById('diag-spares-list');
  if (!el) return;

  if (!_diagSpares.length) {
    el.innerHTML = '';
    const totEl = document.getElementById('diag-spares-total');
    if (totEl) totEl.style.display = 'none';
    return;
  }

  el.innerHTML = _diagSpares.map((sp, i) => `
    <div style="background:var(--bg);border-radius:6px;padding:8px 10px;margin-bottom:6px">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:6px;margin-bottom:6px">
        <div style="font-size:11px;font-weight:700;color:var(--txt-muted)">SPARE ${i + 1}</div>
        <button onclick="diagReadSpares();diagRemoveSpare(${i})" style="border:none;background:none;color:var(--err);cursor:pointer;font-size:13px;padding:0">
          <i class="ti ti-trash"></i>
        </button>
      </div>
      <div class="row-2" style="margin-bottom:6px">
        <div class="f">
          <label>Item Name *</label>
          <input type="text" id="sp-name-${i}" value="${sp.name}" placeholder="e.g. Bearing 6305" style="font-size:12px" oninput="diagReadSpares()">
        </div>
        <div class="f">
          <label>Qty</label>
          <input type="number" id="sp-qty-${i}" value="${sp.qty}" min="1" style="font-size:12px" oninput="diagReadSpares();diagUpdateTotal()">
        </div>
      </div>
      <div class="row-2">
        <div class="f">
          <label>Unit Rate (₹)</label>
          <input type="number" id="sp-rate-${i}" value="${sp.unitRate}" min="0" placeholder="0" style="font-size:12px" oninput="diagReadSpares();diagUpdateTotal()">
        </div>
        <div class="f">
          <label>Supplier</label>
          <input type="text" id="sp-supp-${i}" value="${sp.supplierName}" placeholder="Supplier name" style="font-size:12px" oninput="diagReadSpares()">
        </div>
      </div>
    </div>`).join('');

  diagUpdateTotal();
}

function diagUpdateTotal() {
  diagReadSpares();
  const total  = _diagSpares.reduce((s, sp) => s + (sp.qty || 0) * (sp.unitRate || 0), 0);
  const totEl  = document.getElementById('diag-spares-total');
  if (totEl) {
    totEl.textContent = 'Estimated Total: ' + fmtINR(total);
    totEl.style.display = _diagSpares.length > 0 ? '' : 'none';
  }
}

async function saveDiagnose(id) {
  diagReadSpares();
  const b      = S_MNT.breakdowns.find(x => x.id === id);
  if (!b) return;
  const cat    = document.getElementById('diag-cat')?.value || '';
  const desc   = (document.getElementById('diag-desc')?.value || '').trim();
  const errEl  = document.getElementById('diag-modal-err');

  if (!cat)  { if (errEl) { errEl.textContent = 'Select fault category'; errEl.style.display = ''; } return; }
  if (!desc) { if (errEl) { errEl.textContent = 'Enter fault description'; errEl.style.display = ''; } return; }

  const validSpares = _diagNeedsSpares ? _diagSpares.filter(sp => sp.name) : [];
  if (_diagNeedsSpares && validSpares.length === 0) {
    if (errEl) { errEl.textContent = 'Add at least one spare item (or select "No Spares Needed")'; errEl.style.display = ''; } return;
  }
  const sparesTotal = validSpares.reduce((s, sp) => s + (sp.qty || 0) * (sp.unitRate || 0), 0);

  try {
    const batch = db.batch();
    const now   = serverTS();
    let sparesRequestId = '';

    // Create sparesRequest if any spares listed
    if (validSpares.length > 0) {
      const mach = S.machines.find(m => m.id === b.machineId);
      const spRef = db.collection('sparesRequests').doc();
      sparesRequestId = spRef.id;
      batch.set(spRef, {
        breakdownId:      id,
        machineId:        b.machineId,
        machineCode:      mach?.code || '',
        machineName:      mach?.name || '',
        requestedBy:      S.sess.userId,
        requestedByName:  S.sess.name,
        spares:           validSpares,
        totalCost:        sparesTotal,
        status:           'pending',
        approvedBy: '', approvedByName: '', approvedAt: null,
        approverRemarks: '', rejectionReason: '',
        createdAt: now,
      });
    }

    batch.update(db.collection('breakdowns').doc(id), {
      status: 'diagnosed',
      faultCategory:    cat,
      faultDescription: desc,
      spares:           validSpares,
      sparesTotal,
      sparesRequestId,
      diagnosedBy:      S.sess.userId,
      diagnosedByName:  S.sess.name,
      diagnosedAt:      now,
      updatedAt: now,
    });

    await batch.commit();
    await logAudit('DIAGNOSE_BREAKDOWN', 'MAINTENANCE', id, b, { status: 'diagnosed', faultCategory: cat });
    toast('Diagnosis saved ✓' + (validSpares.length > 0 ? ' · Spares request sent for approval' : ''));
    closeModal();
    await refreshMaint();
  } catch (e) { toast('Error: ' + e.message); }
}

/* ── RELEASE ─────────────────────────────────────────────────────────── */
function openReleaseModal(id) {
  const b    = S_MNT.breakdowns.find(x => x.id === id);
  if (!b) return;
  const mach = S.machines.find(m => m.id === b.machineId);
  openModal(`
    <div class="modal-handle"></div>
    <div class="modal-title">Release Machine</div>
    <div style="background:var(--bg);border-radius:var(--rs);padding:12px;margin-bottom:14px;font-size:13px">
      <strong>${mach?.name || b.machineId}</strong><br>
      <span style="font-size:11px;color:var(--txt-muted)">Fault: ${b.faultCategory} — ${b.faultDescription}</span>
    </div>
    <div class="f">
      <label>Fix Description <span style="color:var(--err)">*</span></label>
      <textarea id="rel-fix" rows="3" placeholder="Describe what was fixed and how…" style="resize:vertical;font-size:13px"></textarea>
    </div>
    ${b.spares && b.spares.length > 0 ? `
      <div style="background:#fef9c3;border:1px solid #fde68a;border-radius:var(--rs);padding:10px 12px;font-size:12px;margin-bottom:10px">
        <i class="ti ti-info-circle" style="color:#92400e"></i>
        <strong style="color:#92400e"> Note:</strong> Spares request is independent — machine release does not require procurement to be complete.
      </div>` : ''}
    <div style="background:#fef2f2;border:1px solid #fca5a5;border-radius:var(--rs);padding:10px 14px;font-size:12px;font-weight:700;color:var(--err);margin-bottom:14px">
      <i class="ti ti-alert-triangle"></i> Releasing the machine marks this breakdown as resolved. Downtime will be locked.
    </div>
    <div id="rel-modal-err" style="display:none;color:var(--err);font-size:12px;font-weight:700;margin-bottom:8px"></div>
    <div style="display:flex;gap:8px">
      <button class="btn btn-s" style="flex:1" onclick="closeModal()">Cancel</button>
      <button class="btn btn-ok" style="flex:1" onclick="saveRelease('${id}')">
        <i class="ti ti-circle-check"></i> Release Machine
      </button>
    </div>`);
}

async function saveRelease(id) {
  const b      = S_MNT.breakdowns.find(x => x.id === id);
  if (!b) return;
  const fix    = (document.getElementById('rel-fix')?.value || '').trim();
  const errEl  = document.getElementById('rel-modal-err');
  if (!fix) { if (errEl) { errEl.textContent = 'Enter fix description'; errEl.style.display = ''; } return; }

  try {
    const now         = serverTS();
    const reportedMs  = b.reportedAt?.toMillis?.() || b.createdAt?.toMillis?.() || Date.now();
    const nowMs       = Date.now();
    const totalDowntimeMins = Math.round((nowMs - reportedMs) / 60000);

    const batch = db.batch();
    batch.update(db.collection('breakdowns').doc(id), {
      status: 'released',
      fixDescription: fix,
      releasedBy:     S.sess.userId,
      releasedByName: S.sess.name,
      releasedAt:     now,
      totalDowntimeMins,
      updatedAt: now,
    });
    batch.set(db.collection('machineStatus').doc(b.machineId), {
      status: 'operational',
      activeBreakdownId: '',
      updatedAt: now,
    }, { merge: true });

    await batch.commit();
    await logAudit('RELEASE_BREAKDOWN', 'MAINTENANCE', id, b, { status: 'released', totalDowntimeMins });
    toast(`Machine released ✓ · Downtime: ${totalDowntimeMins} min`);
    closeModal();
    await refreshMaint();
  } catch (e) { toast('Error: ' + e.message); }
}

/* ═══════════════════════════════════════════════════════════════════
   TAB: PM LOG
   ═══════════════════════════════════════════════════════════════════ */
function renderPM() {
  const el = document.getElementById('tab-body');
  if (!el) return;

  const machines = S.machines || [];
  const canLog   = canDo('maintenance') || S.sess?.role === 'admin';

  el.innerHTML = `
    <div style="display:flex;justify-content:flex-end;margin-bottom:10px">
      <button class="btn btn-s btn-sm" onclick="refreshMaint()"><i class="ti ti-refresh"></i> Refresh</button>
    </div>
    ${machines.length
      ? machines.map(m => pmMachineBlock(m, canLog)).join('')
      : `<div class="empty"><div class="empty-ic"><i class="ti ti-tool"></i></div><h3>No machines</h3><p>Add machines in Master Data.</p></div>`}`;
}

function pmMachineBlock(m, canLog) {
  const mLogs = S_MNT.pmLogs.filter(l => l.machineId === m.id);

  const intervals = PM_INTERVALS.map(iv => {
    const ivLogs = mLogs.filter(l => l.interval === iv.key).sort((a, b) => {
      const aD = a.date || ''; const bD = b.date || '';
      return bD < aD ? -1 : bD > aD ? 1 : 0;
    });
    const lastLog   = ivLogs[0];
    const lastDate  = lastLog?.date || null;
    const dueDate   = lastDate ? (() => {
      const d = new Date(lastDate);
      d.setDate(d.getDate() + iv.days);
      return d.toISOString().slice(0, 10);
    })() : null;
    const today     = dateStr();
    const overdue   = dueDate && dueDate < today;
    const dueSoon   = dueDate && !overdue && dueDate <= (() => {
      const d = new Date(today); d.setDate(d.getDate() + 3); return d.toISOString().slice(0, 10);
    })();

    const ragCol = overdue ? 'var(--err)' : dueSoon ? 'var(--warn)' : 'var(--ok)';

    return `
      <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--bdr);gap:8px">
        <div style="flex:1">
          <div style="font-size:12px;font-weight:700">${iv.label}</div>
          <div style="font-size:11px;color:var(--txt-muted)">
            Last: ${lastDate ? fmtDate(lastDate) : 'Never'}
            ${dueDate ? ` · Due: <span style="color:${ragCol};font-weight:700">${fmtDate(dueDate)}</span>` : ''}
          </div>
        </div>
        ${canLog ? `
          <button class="btn btn-s btn-sm" onclick="openLogPMModal('${m.id}','${iv.key}')">
            <i class="ti ti-check"></i> Log Done
          </button>` : ''}
      </div>`;
  }).join('');

  return `
    <div class="card" style="margin-bottom:12px">
      <div style="font-weight:800;font-size:14px;margin-bottom:10px">
        ${m.name || '—'} <span style="font-family:monospace;font-size:11px;font-weight:400;color:var(--txt-muted)">${m.code || ''}</span>
      </div>
      ${intervals}
    </div>`;
}

function openLogPMModal(machId, interval) {
  const mach  = S.machines.find(m => m.id === machId);
  const ivDef = PM_INTERVALS.find(iv => iv.key === interval);
  openModal(`
    <div class="modal-handle"></div>
    <div class="modal-title">Log PM Done</div>
    <div style="background:var(--bg);border-radius:var(--rs);padding:12px;margin-bottom:14px;font-size:13px">
      <strong>${mach?.name || machId}</strong> — ${ivDef?.label || interval} PM
    </div>
    <div class="f">
      <label>Date Done</label>
      <input type="date" id="pm-date" value="${dateStr()}" style="font-size:13px">
    </div>
    <div class="f">
      <label>Notes (optional)</label>
      <input type="text" id="pm-notes" placeholder="e.g. Lubricated, filter replaced…" style="font-size:13px">
    </div>
    <div style="display:flex;gap:8px;margin-top:4px">
      <button class="btn btn-s" style="flex:1" onclick="closeModal()">Cancel</button>
      <button class="btn btn-ok" style="flex:1" onclick="saveLogPM('${machId}','${interval}')">
        <i class="ti ti-check"></i> Save
      </button>
    </div>`);
}

async function saveLogPM(machId, interval) {
  const date  = document.getElementById('pm-date')?.value || dateStr();
  const notes = (document.getElementById('pm-notes')?.value || '').trim();
  const mach  = S.machines.find(m => m.id === machId);
  try {
    const now = serverTS();
    await db.collection('pmLogs').add({
      machineId:    machId,
      machineCode:  mach?.code || '',
      machineName:  mach?.name || '',
      interval,
      date,
      notes,
      doneBy:     S.sess.userId,
      doneByName: S.sess.name,
      createdAt:  now,
    });
    await logAudit('LOG_PM', 'MAINTENANCE', machId, null, { interval, date });
    toast('PM logged ✓');
    closeModal();
    await refreshMaint();
  } catch (e) { toast('Error: ' + e.message); }
}

/* ═══════════════════════════════════════════════════════════════════
   TAB: HEALTH (MTBF / MTTR)
   ═══════════════════════════════════════════════════════════════════ */
function renderHealth() {
  const el = document.getElementById('tab-body');
  if (!el) return;

  const cutoffDate = (() => {
    const d = new Date(); d.setDate(d.getDate() - 90);
    return d.toISOString().slice(0, 10);
  })();

  const machines = S.machines || [];
  if (!machines.length) {
    el.innerHTML = `<div class="empty"><div class="empty-ic"><i class="ti ti-heart-rate-monitor"></i></div><h3>No machines</h3><p>Add machines in Master Data.</p></div>`;
    return;
  }

  const metrics = machines.map(m => {
    const mBDs     = S_MNT.breakdowns.filter(b => b.machineId === m.id && (b.date || '') >= cutoffDate);
    const resolved = mBDs.filter(b => b.status === 'released');
    const totalDown = resolved.reduce((s, b) => s + (b.totalDowntimeMins || 0), 0);
    const failures  = mBDs.length;
    const totalMins = 90 * 3 * 450; // 90 days × 3 shifts × 450 min
    const opMins    = Math.max(0, totalMins - totalDown);
    const mtbf      = failures > 0 ? round(opMins / 60 / failures, 1) : null;
    const mttr      = resolved.length > 0 ? round(totalDown / resolved.length, 1) : null;
    const avail     = round((opMins / totalMins) * 100, 1);
    return { m, failures, totalDown, mtbf, mttr, avail };
  });

  el.innerHTML = `
    <div style="font-size:11px;color:var(--txt-muted);margin-bottom:10px">Metrics based on last 90 days of breakdown records.</div>
    <div class="data-tbl" style="overflow-x:auto">
      <table style="width:100%;border-collapse:collapse;font-size:12px">
        <thead>
          <tr style="background:var(--imf-navy);color:#fff">
            <th style="padding:8px 10px;text-align:left;font-weight:700">Machine</th>
            <th style="padding:8px 6px;text-align:center;font-weight:700">Failures</th>
            <th style="padding:8px 6px;text-align:center;font-weight:700">MTBF (hrs)</th>
            <th style="padding:8px 6px;text-align:center;font-weight:700">MTTR (min)</th>
            <th style="padding:8px 6px;text-align:center;font-weight:700">Availability</th>
          </tr>
        </thead>
        <tbody>
          ${metrics.map((r, i) => {
            const availCol = r.avail >= 95 ? 'var(--ok)' : r.avail >= 80 ? 'var(--warn)' : 'var(--err)';
            return `
              <tr style="background:${i % 2 === 0 ? 'var(--sur)' : 'var(--bg)'}">
                <td style="padding:8px 10px;font-weight:700">${r.m.name || r.m.id}<div style="font-size:10px;font-weight:400;color:var(--txt-muted)">${r.m.code || ''}</div></td>
                <td style="padding:8px 6px;text-align:center;${r.failures > 0 ? 'color:var(--err);font-weight:700' : ''}">${r.failures}</td>
                <td style="padding:8px 6px;text-align:center">${r.mtbf !== null ? r.mtbf : '—'}</td>
                <td style="padding:8px 6px;text-align:center">${r.mttr !== null ? r.mttr : '—'}</td>
                <td style="padding:8px 6px;text-align:center;font-weight:700;color:${availCol}">${r.avail}%</td>
              </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>
    <div style="font-size:11px;color:var(--txt-muted);margin-top:8px">
      MTBF = Mean Time Between Failures (hours). MTTR = Mean Time To Repair (minutes).
      Availability based on 3-shift operation (1350 min/day).
    </div>`;
}

/* ── Print: Approved MRO Spares ──────────────────────────────────────── */
function printSparesMRO_bd(sparesId) {
  const s = S_MNT.sparesRequests.find(x => x.id === sparesId);
  if (!s) return;
  const spares    = s.spares || [];
  const totalCost = spares.reduce((sum, sp) => sum + (sp.qty || 0) * (sp.unitRate || 0), 0);
  const approvedDate = s.approvedAt
    ? new Date(s.approvedAt.toMillis ? s.approvedAt.toMillis() : s.approvedAt).toLocaleDateString('en-IN')
    : '—';
  const rows = spares.map(sp => `<tr>
    <td>${sp.name || '—'}</td>
    <td>${sp.qty || 0}</td>
    <td>₹${(sp.unitRate || 0).toLocaleString('en-IN')}</td>
    <td>${sp.supplierName || 'TBD'}</td>
    <td>₹${((sp.qty || 0) * (sp.unitRate || 0)).toLocaleString('en-IN')}</td>
  </tr>`).join('');
  const win = window.open('', '_blank', 'width=800,height=600');
  win.document.write(`<!DOCTYPE html><html><head><title>MRO Spares — ${s.breakdownId || s.id}</title>
  <style>body{font-family:Arial,sans-serif;padding:24px;font-size:13px}
  h2{margin:0 0 6px;font-size:18px}p{margin:0 0 3px}
  table{width:100%;border-collapse:collapse;margin-top:16px}
  th,td{border:1px solid #ccc;padding:7px 10px;text-align:left}
  th{background:#f0f0f0;font-weight:700}
  tfoot td{font-weight:700;background:#f9f9f9}
  .footer{margin-top:20px;font-size:11px;color:#888}</style></head><body>
  <h2>Approved MRO Spares Request</h2>
  <p><strong>Breakdown Ref:</strong> ${s.breakdownId || '—'}</p>
  <p><strong>Machine:</strong> ${s.machineName || s.machineId || '—'}</p>
  <p><strong>Requested by:</strong> ${s.requestedByName || '—'}</p>
  <p><strong>Approved by:</strong> ${s.approvedByName || '—'} &middot; ${approvedDate}</p>
  ${s.approverRemarks ? `<p><strong>Remarks:</strong> ${s.approverRemarks}</p>` : ''}
  <table>
    <thead><tr><th>Item</th><th>Qty</th><th>Unit Rate</th><th>Supplier</th><th>Line Total</th></tr></thead>
    <tbody>${rows}</tbody>
    <tfoot><tr><td colspan="4" style="text-align:right">Total Cost</td><td>₹${totalCost.toLocaleString('en-IN')}</td></tr></tfoot>
  </table>
  <div class="footer">Printed ${new Date().toLocaleString('en-IN')} &middot; IMF ProTrack MES</div>
  </body></html>`);
  win.document.close();
  win.print();
}

/* ── Boot ────────────────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', init);
