/* ═══════════════════════════════════════════════════════════════════
   IMF ProTrack — Approvals
   Central hub for pending approvals across all modules.

   Collections:
     requisitions    — store material requests   (status: pending|approved|rejected|partial|fulfilled)
     setupApprovals  — production machine setups (status: pending|approved|rejected)
     setupDeviations — sequence deviations       (status: pending|approved|rejected)
     sparesRequests  — maintenance spares        (status: pending|approved|rejected)
     scmScrapLedger  — SCM supplier scrap (Forging->CNC supplier)
                        (status: pending|approved|rejected)
   ═══════════════════════════════════════════════════════════════════ */

'use strict';

/* ── State ─────────────────────────────────────────────────────────── */
let _tab     = 'all';   // 'all' | 'requisitions' | 'setup' | 'deviations' | 'spares' | 'scrap'
let _histTab = false;   // showing history section?

const S_APR = {
  requisitions:    [],
  setupApprovals:  [],
  setupDeviations: [],
  sparesRequests:  [],
  scmScrapLedger:  [],
};

/* ── Shared two-step confirm for approve/reject actions ─────────────── */
let _pendingAction = null;
function confirmApprovalAction(opts) {
  _pendingAction = opts.onConfirm;
  openModal(`
    <div class="modal-handle"></div>
    <div style="text-align:center;margin-bottom:12px">
      <div style="width:56px;height:56px;border-radius:28px;background:${opts.bg};border:2px solid ${opts.color};display:inline-flex;align-items:center;justify-content:center;font-size:26px;color:${opts.color}"><i class="ti ${opts.icon}"></i></div>
    </div>
    <div class="mtit" style="justify-content:center">${opts.title}</div>
    <p style="font-size:13px;color:var(--txt-muted);text-align:center;margin-bottom:14px">${opts.message}</p>
    <div style="display:flex;gap:10px">
      <button class="btn btn-s" style="flex:1" onclick="closeModal();_pendingAction=null">Cancel — Go Back</button>
      <button class="btn ${opts.confirmClass || 'btn-p'}" style="flex:1" onclick="closeModal();_runPendingAction()">${opts.confirmLabel}</button>
    </div>
  `);
}
function _runPendingAction() {
  if (_pendingAction) _pendingAction();
  _pendingAction = null;
}

/* ── Boot ──────────────────────────────────────────────────────────── */
async function init() {
  try { await initShell(); } catch (e) {
    clearSess(); window.location.replace('index.html'); return;
  }
  if (!canView('production') && !canView('inward') && !canView('scrap_approve')) {
    document.getElementById('page-content').innerHTML =
      `<div class="empty"><div class="empty-ic"><i class="ti ti-lock"></i></div><h3>Access Denied</h3><p>You do not have permission to view approvals.</p></div>`;
    document.getElementById('loading-screen').style.display = 'none';
    document.getElementById('app').style.display = '';
    return;
  }
  await loadApprovals();
  render();
  document.getElementById('loading-screen').style.display = 'none';
  document.getElementById('app').style.display = '';
}

async function loadApprovals() {
  try {
    const [reqSnap, saSnap, sdSnap, spSnap, scSnap] = await Promise.all([
      db.collection('requisitions').orderBy('createdAt', 'desc').limit(100).get(),
      db.collection('setupApprovals').orderBy('createdAt', 'desc').limit(200).get(),
      db.collection('setupDeviations').orderBy('createdAt', 'desc').limit(100).get(),
      db.collection('sparesRequests').orderBy('createdAt', 'desc').limit(100).get(),
      db.collection('scmScrapLedger').orderBy('createdAt', 'desc').limit(100).get(),
    ]);
    S_APR.requisitions    = reqSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    S_APR.setupApprovals  = saSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    S_APR.setupDeviations = sdSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    S_APR.sparesRequests  = spSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    S_APR.scmScrapLedger  = scSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch (e) { console.warn('loadApprovals error:', e.message); }
}

async function refreshAll() {
  await loadApprovals();
  render();
}

/* ── Render ────────────────────────────────────────────────────────── */
function render() {
  const pendingReq = S_APR.requisitions.filter(r => r.status === 'pending');
  const pendingSA  = S_APR.setupApprovals.filter(s => s.status === 'pending');
  const pendingSD  = S_APR.setupDeviations.filter(s => s.status === 'pending');
  const pendingSP  = S_APR.sparesRequests.filter(s => s.status === 'pending');
  const pendingSC  = S_APR.scmScrapLedger.filter(s => s.status === 'pending');
  const totalPending = pendingReq.length + pendingSA.length + pendingSD.length + pendingSP.length + pendingSC.length;

  const tabs = [
    { key: 'all',          label: 'All',         count: totalPending },
    { key: 'requisitions', label: 'Requisitions', count: pendingReq.length },
    { key: 'setup',        label: 'Setup',        count: pendingSA.length },
    { key: 'deviations',   label: 'Deviations',   count: pendingSD.length },
    { key: 'spares',       label: 'Spares',        count: pendingSP.length },
    { key: 'scrap',        label: 'SCM Scrap',     count: pendingSC.length },
  ];

  const tabHtml = tabs.map(t => `
    <button class="tab ${_tab===t.key?'active':''}" role="tab" aria-selected="${_tab===t.key}" onclick="switchTab('${t.key}')">
      ${t.label}
      ${t.count > 0 ? `<span class="bdg bdg-n" style="margin-left:4px;padding:1px 6px;font-size:10px">${t.count}</span>` : ''}
    </button>`).join('');

  let pendingItems = [];
  if (_tab === 'all' || _tab === 'requisitions') {
    pendingReq.forEach(r => pendingItems.push({ type: 'requisition', data: r, ts: r.createdAt }));
  }
  if (_tab === 'all' || _tab === 'setup') {
    pendingSA.forEach(s => pendingItems.push({ type: 'setup', data: s, ts: s.createdAt }));
  }
  if (_tab === 'all' || _tab === 'deviations') {
    pendingSD.forEach(s => pendingItems.push({ type: 'deviation', data: s, ts: s.createdAt }));
  }
  if (_tab === 'all' || _tab === 'spares') {
    pendingSP.forEach(s => pendingItems.push({ type: 'spares', data: s, ts: s.createdAt }));
  }
  if (_tab === 'all' || _tab === 'scrap') {
    pendingSC.forEach(s => pendingItems.push({ type: 'scrap', data: s, ts: s.createdAt }));
  }
  pendingItems.sort((a, b) => (b.ts?.toMillis?.() || 0) - (a.ts?.toMillis?.() || 0));

  const pendingHtml = pendingItems.length
    ? pendingItems.map(item => {
        if (item.type === 'requisition') return reqCard(item.data, true);
        if (item.type === 'setup')       return setupCard(item.data, true);
        if (item.type === 'deviation')   return deviationCard(item.data, true);
        if (item.type === 'spares')      return sparesCard(item.data, true);
        if (item.type === 'scrap')       return scrapCard(item.data, true);
        return '';
      }).join('')
    : `<div class="empty" style="padding:32px 0">
         <div class="empty-ic"><i class="ti ti-circle-check"></i></div>
         <h3>All clear</h3>
         <p>No pending approvals${_tab !== 'all' ? ' in this category' : ''}.</p>
       </div>`;

  // History items (processed in last 14 days)
  const cutoff = Date.now() - 14 * 24 * 60 * 60 * 1000;
  let histItems = [];
  if (_tab === 'all' || _tab === 'requisitions') {
    S_APR.requisitions.filter(r => ['approved','rejected','partial','fulfilled'].includes(r.status) && (r.approvedAt?.toMillis?.() || 0) > cutoff)
      .forEach(r => histItems.push({ type: 'requisition', data: r, ts: r.approvedAt }));
  }
  if (_tab === 'all' || _tab === 'setup') {
    S_APR.setupApprovals.filter(s => ['approved','rejected'].includes(s.status) && (s.approvedAt?.toMillis?.() || 0) > cutoff)
      .forEach(s => histItems.push({ type: 'setup', data: s, ts: s.approvedAt }));
  }
  if (_tab === 'all' || _tab === 'deviations') {
    S_APR.setupDeviations.filter(s => ['approved','rejected'].includes(s.status) && (s.approvedAt?.toMillis?.() || 0) > cutoff)
      .forEach(s => histItems.push({ type: 'deviation', data: s, ts: s.approvedAt }));
  }
  if (_tab === 'all' || _tab === 'spares') {
    S_APR.sparesRequests.filter(s => ['approved','rejected'].includes(s.status) && (s.approvedAt?.toMillis?.() || 0) > cutoff)
      .forEach(s => histItems.push({ type: 'spares', data: s, ts: s.approvedAt }));
  }
  if (_tab === 'all' || _tab === 'scrap') {
    S_APR.scmScrapLedger.filter(s => ['approved','rejected'].includes(s.status) && (s.approvedAt?.toMillis?.() || 0) > cutoff)
      .forEach(s => histItems.push({ type: 'scrap', data: s, ts: s.approvedAt }));
  }
  histItems.sort((a, b) => (b.ts?.toMillis?.() || 0) - (a.ts?.toMillis?.() || 0));
  histItems = histItems.slice(0, 20);

  document.getElementById('page-content').innerHTML = `
    <div style="padding-bottom:80px">

      <!-- Summary stat -->
      ${totalPending > 0
        ? `<div style="background:var(--acc);border-radius:var(--rs);padding:14px 16px;margin-bottom:14px;display:flex;align-items:center;gap:12px">
             <div style="font-size:28px;font-weight:900;color:#fff">${totalPending}</div>
             <div>
               <div style="font-size:13px;font-weight:700;color:#fff">Pending Approval${totalPending!==1?'s':''}</div>
               <div style="font-size:11px;color:rgba(255,255,255,.75)">${[
                 pendingReq.length  ? `${pendingReq.length} requisition${pendingReq.length!==1?'s':''}` : '',
                 pendingSA.length   ? `${pendingSA.length} setup${pendingSA.length!==1?'s':''}` : '',
                 pendingSD.length   ? `${pendingSD.length} deviation${pendingSD.length!==1?'s':''}` : '',
                 pendingSP.length   ? `${pendingSP.length} spares request${pendingSP.length!==1?'s':''}` : '',
                 pendingSC.length   ? `${pendingSC.length} scrap request${pendingSC.length!==1?'s':''}` : '',
               ].filter(Boolean).join(' · ')}</div>
             </div>
             <button onclick="refreshAll()" style="margin-left:auto;border:none;background:rgba(255,255,255,.2);color:#fff;border-radius:6px;padding:6px 10px;cursor:pointer;font-size:12px">
               <i class="ti ti-refresh"></i>
             </button>
           </div>`
        : `<div style="display:flex;align-items:center;gap:8px;justify-content:flex-end;margin-bottom:10px">
             <button onclick="refreshAll()" class="btn btn-s btn-sm"><i class="ti ti-refresh"></i> Refresh</button>
           </div>`}

      <!-- Tabs -->
      <div class="tabs" role="tablist">
        ${tabHtml}
      </div>

      <!-- Pending section -->
      ${pendingItems.length ? `<div style="font-size:11px;font-weight:700;color:var(--txt-muted);letter-spacing:.06em;margin-bottom:8px">AWAITING ACTION</div>` : ''}
      ${pendingHtml}

      <!-- History section -->
      ${histItems.length ? `
        <div style="margin-top:20px">
          <button type="button" onclick="_histTab=!_histTab;render()" aria-expanded="${_histTab?'true':'false'}"
            style="appearance:none;-webkit-appearance:none;font:inherit;color:inherit;background:none;border:none;width:100%;
                   display:flex;align-items:center;justify-content:space-between;cursor:pointer;padding:8px 0;border-top:1px solid var(--bdr)">
            <div style="font-size:11px;font-weight:700;color:var(--txt-muted);letter-spacing:.06em">
              RECENTLY PROCESSED (${histItems.length})
            </div>
            <i class="ti ${_histTab?'ti-chevron-up':'ti-chevron-down'}" style="color:var(--txt-muted);font-size:14px"></i>
          </button>
          ${_histTab ? histItems.map(item => {
            if (item.type === 'requisition') return reqCard(item.data, false);
            if (item.type === 'setup')       return setupCard(item.data, false);
            if (item.type === 'deviation')   return deviationCard(item.data, false);
            if (item.type === 'spares')      return sparesCard(item.data, false);
            if (item.type === 'scrap')       return scrapCard(item.data, false);
            return '';
          }).join('') : ''}
        </div>` : ''}
    </div>`;
}

function switchTab(tab) {
  _tab = tab;
  render();
}

/* ── Status badges ─────────────────────────────────────────────────── */
const BADGE = {
  pending:            { bg: 'var(--warn-bg)', border: 'var(--warn-bdr)', color: '#78350F', label: 'Pending' },
  approved:           { bg: 'var(--ok-bg)',   border: 'var(--ok-bdr)',   color: '#14532D', label: 'Approved' },
  rejected:           { bg: 'var(--err-bg)',  border: 'var(--err-bdr)',  color: '#7F1D1D', label: 'Rejected' },
  partial:            { bg: 'var(--info-bg)', border: 'var(--info-bdr)', color: '#1E40AF', label: 'Part Approved' },
  fulfilled:          { bg: 'var(--ok-bg)',   border: 'var(--ok-bdr)',   color: '#14532D', label: 'Fulfilled' },
  awaiting_deviation: { bg: 'var(--info-bg)', border: 'var(--info-bdr)', color: '#1E40AF', label: 'Awaiting Deviation' },
};

function statusBadge(status) {
  const b = BADGE[status] || { bg: 'var(--sur)', border: 'var(--bdr)', color: 'var(--txt)', label: status };
  return `<span style="font-size:10px;font-weight:700;background:${b.bg};border:1px solid ${b.border};color:${b.color};border-radius:4px;padding:2px 7px">${b.label}</span>`;
}

function moduleTag(label, icon) {
  return `<span style="font-size:10px;font-weight:700;color:var(--txt-muted);background:var(--sur);border:1px solid var(--bdr);border-radius:4px;padding:2px 7px"><i class="ti ${icon}" style="font-size:10px"></i> ${label}</span>`;
}

/* ── Card: Store Requisition ───────────────────────────────────────── */
function reqCard(r, isPending) {
  const canAct = isPending && (canDo('inward') || S.sess?.role === 'admin' || S.sess?.role === 'hod');
  return `
    <div class="card" style="margin-bottom:10px;border:1.5px solid ${isPending?'var(--warn)':'var(--bdr)'}">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px;margin-bottom:10px">
        <div>
          <div style="font-weight:800;font-size:14px">${r.reqNo || '—'}</div>
          <div style="font-size:11px;color:var(--txt-muted);margin-top:2px">
            By ${r.requestedByName || '—'} · ${fmtDate(r.date)}
            ${r.neededBy ? ` · Needed by ${fmtDate(r.neededBy)}` : ''}
          </div>
        </div>
        <div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px;flex-shrink:0">
          ${statusBadge(r.status)}
          ${moduleTag('Store', 'ti-building-warehouse')}
        </div>
      </div>

      ${(r.lines || []).map(l => `
        <div style="background:var(--bg);border-radius:6px;padding:8px 10px;margin-bottom:6px">
          <div style="font-weight:700;font-size:13px">${l.partName} <span style="font-family:monospace;font-size:11px;color:var(--txt-muted)">${l.partNo || ''}</span></div>
          <div style="font-size:11px;color:var(--txt-muted)">${l.customerName || '—'}${l.masterLotCode ? ' · Lot: ' + l.masterLotCode : ''}</div>
          <div style="display:flex;align-items:center;gap:12px;margin-top:6px;font-size:12px">
            <span>Requested: <strong>${l.qtyRequested} pcs</strong></span>
            ${canAct
              ? `<input id="aq-${r.id}-${l.lineNo}" type="number" min="0" max="${l.qtyRequested}" value="${l.qtyRequested}"
                   style="width:80px;margin-left:auto;padding:4px 8px;border:1px solid var(--bdr);border-radius:4px;font-size:12px">`
              : (l.qtyApproved != null ? `<span style="margin-left:auto;color:var(--ok);font-weight:700">Approved: ${l.qtyApproved} pcs</span>` : '')}
          </div>
        </div>`).join('')}

      ${r.notes ? `<div style="font-size:12px;color:var(--txt-muted);margin-bottom:8px;font-style:italic">${r.notes}</div>` : ''}

      ${canAct ? `
        <div class="f" style="margin-bottom:8px;margin-top:4px">
          <label style="font-size:11px">Remarks (optional)</label>
          <input type="text" id="ar-${r.id}" placeholder="Notes for requester..." style="font-size:13px">
        </div>
        <div style="display:flex;gap:8px">
          <button class="btn btn-ok" style="flex:1" onclick="approveReq('${r.id}')">
            <i class="ti ti-check"></i> Approve
          </button>
          <button class="btn btn-d" style="flex:1" onclick="rejectReq('${r.id}')">
            <i class="ti ti-x"></i> Reject
          </button>
        </div>` : ''}

      ${!isPending && r.approvedByName ? `
        <div style="font-size:11px;color:var(--txt-muted);margin-top:4px;padding-top:8px;border-top:1px solid var(--bdr)">
          ${r.status === 'rejected' ? 'Rejected' : 'Approved'} by ${r.approvedByName}
          ${r.rejectionReason ? ` · "${r.rejectionReason}"` : ''}
          ${r.approvedAt ? ` · ${fmtTS(r.approvedAt)}` : ''}
        </div>` : ''}
    </div>`;
}

/* ── Card: Setup Approval ──────────────────────────────────────────── */
function setupCard(s, isPending) {
  const canAct = isPending && (S.sess?.role === 'admin' || S.sess?.role === 'hod' || S.sess?.role === 'supervisor');
  const stageLabel = s.stage === 'soft' ? 'Soft Stage' : s.stage === 'hard' ? 'Hard Stage' : (s.stage || '—');
  return `
    <div class="card" style="margin-bottom:10px;border:1.5px solid ${isPending?'var(--acc)':'var(--bdr)'}">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px;margin-bottom:10px">
        <div>
          <div style="font-weight:800;font-size:14px">${s.partName || '—'} <span style="font-family:monospace;font-size:11px;font-weight:400;color:var(--txt-muted)">${s.partNo || ''}</span></div>
          <div style="font-size:11px;color:var(--txt-muted);margin-top:2px">
            TAG: <strong>${s.tagId || '—'}</strong> · ${s.machineName || s.machineId || '—'} · ${stageLabel}
          </div>
          <div style="font-size:11px;color:var(--txt-muted)">
            By ${s.requestedByName || '—'} · ${fmtDate(s.date)}${s.shift ? ' · Shift ' + s.shift : ''}
          </div>
        </div>
        <div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px;flex-shrink:0">
          ${statusBadge(s.status)}
          ${moduleTag('Production', 'ti-settings')}
        </div>
      </div>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px">
        <div style="background:var(--bg);border-radius:6px;padding:8px 10px;text-align:center">
          <div style="font-size:18px;font-weight:800">${s.setupMins || 0}</div>
          <div style="font-size:10px;color:var(--txt-muted)">Setup Mins</div>
        </div>
        <div style="background:var(--bg);border-radius:6px;padding:8px 10px">
          <div style="font-size:12px;font-weight:700">${s.opName || '—'}</div>
          <div style="font-size:10px;color:var(--txt-muted)">Operation</div>
          <div style="font-size:11px;color:var(--txt-muted);margin-top:2px">${s.operatorName || '—'}</div>
        </div>
      </div>

      ${s.remarks ? `<div style="font-size:12px;color:var(--txt-muted);margin-bottom:10px;font-style:italic">"${s.remarks}"</div>` : ''}

      ${canAct ? `
        <div class="f" style="margin-bottom:8px">
          <label style="font-size:11px">Remarks (optional)</label>
          <input type="text" id="sa-rmk-${s.id}" placeholder="e.g. Setup time seems high, please verify..." style="font-size:13px">
        </div>
        <div style="display:flex;gap:8px">
          <button class="btn btn-ok" style="flex:1" onclick="approveSetup('${s.id}')">
            <i class="ti ti-check"></i> Approve
          </button>
          <button class="btn btn-d" style="flex:1" onclick="rejectSetup('${s.id}')">
            <i class="ti ti-x"></i> Reject
          </button>
        </div>` : ''}

      ${!isPending && s.approvedByName ? `
        <div style="font-size:11px;color:var(--txt-muted);margin-top:4px;padding-top:8px;border-top:1px solid var(--bdr)">
          ${s.status === 'rejected' ? 'Rejected' : 'Approved'} by ${s.approvedByName}
          ${s.rejectionReason ? ` · "${s.rejectionReason}"` : ''}
          ${s.approvedAt ? ` · ${fmtTS(s.approvedAt)}` : ''}
        </div>` : ''}
      ${(S.sess?.role === 'admin' || S.sess?.role === 'hod') ? `
        <button class="btn btn-s" style="width:100%;margin-top:8px;color:var(--err);border-color:var(--err)"
          onclick="confirmDeleteSetupAPR('${s.id}')">
          <i class="ti ti-trash"></i> Delete Setup Log
        </button>` : ''}
    </div>`;
}

/* ── Delete setup (Approvals module) ───────────────────────────────── */
function confirmDeleteSetupAPR(id) {
  const s = S_APR.setupApprovals.find(x => x.id === id);
  if (!s) { toast('Setup not found'); return; }
  openModal(`
    <div class="modal-handle"></div>
    <div class="modal-title">Delete Setup Log?</div>
    <div style="background:var(--bg);border-radius:var(--rs);padding:12px;margin-bottom:14px;font-size:13px">
      <div style="font-weight:700;font-family:monospace">${s.tagId || '—'}</div>
      <div style="color:var(--txt-muted);font-size:12px;margin-top:4px">
        ${s.machineName || '—'} · ${s.opName || '—'}<br>
        ${s.date || ''} · Shift ${s.shift || '—'} · ${s.setupMins || 0} min · <strong>${s.status}</strong>
      </div>
    </div>
    <div class="ebox" style="font-weight:700;margin-bottom:14px">
      <i class="ti ti-alert-triangle"></i> <div>This permanently removes the setup record from both Production and QC views.</div>
    </div>
    <div style="display:flex;gap:8px">
      <button class="btn btn-s" style="flex:1" onclick="closeModal()">Cancel</button>
      <button class="btn btn-s" style="flex:1;background:var(--err);border-color:var(--err);color:#fff"
        onclick="closeModal();deleteSetupAPR('${id}')">
        <i class="ti ti-trash"></i> Delete
      </button>
    </div>`);
}

async function deleteSetupAPR(id) {
  try {
    await db.collection('setupApprovals').doc(id).delete();
    S_APR.setupApprovals = S_APR.setupApprovals.filter(x => x.id !== id);
    await logAudit('delete_setup', 'approvals', id, null, {});
    toast('Setup log deleted ✓');
    await refreshAll();
  } catch (e) {
    toast('Error deleting setup: ' + friendlyError(e));
  }
}

/* ── Card: Sequence Deviation ──────────────────────────────────────── */
function deviationCard(s, isPending) {
  const canAct = isPending && (S.sess?.role === 'admin' || S.sess?.role === 'hod');
  return `
    <div class="card" style="margin-bottom:10px;border:1.5px solid ${isPending?'var(--err)':'var(--bdr)'}">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px;margin-bottom:10px">
        <div>
          <div style="font-weight:800;font-size:14px">Sequence Deviation</div>
          <div style="font-size:11px;color:var(--txt-muted);margin-top:2px">
            TAG: <strong>${s.tagId || '—'}</strong> · ${s.stage === 'soft' ? 'Soft Stage' : 'Hard Stage'}
          </div>
          <div style="font-size:11px;color:var(--txt-muted)">
            By ${s.requestedByName || '—'} · ${fmtDate(s.date)}
          </div>
        </div>
        <div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px;flex-shrink:0">
          ${statusBadge(s.status)}
          ${moduleTag('Production', 'ti-settings')}
        </div>
      </div>

      <div style="background:var(--err-bg);border:1px solid var(--err-bdr);border-radius:6px;padding:10px 12px;margin-bottom:10px">
        <div style="font-size:11px;font-weight:700;color:#7F1D1D;margin-bottom:4px">SKIPPED OPERATION</div>
        <div style="font-size:13px;font-weight:700">${s.missingOpName || '—'}</div>
        ${s.missingSeqNo ? `<div style="font-size:11px;color:#7F1D1D;margin-top:2px">Step #${s.missingSeqNo} was not completed before proceeding</div>` : ''}
      </div>

      ${canAct ? `
        <div class="f" style="margin-bottom:8px">
          <label style="font-size:11px">Plant Head Remarks *</label>
          <input type="text" id="dev-rmk-${s.id}" placeholder="Reason for approval or rejection..." style="font-size:13px">
        </div>
        <div style="display:flex;gap:8px">
          <button class="btn btn-ok" style="flex:1" onclick="approveDeviation('${s.id}')">
            <i class="ti ti-check"></i> Approve
          </button>
          <button class="btn btn-d" style="flex:1" onclick="rejectDeviation('${s.id}')">
            <i class="ti ti-x"></i> Reject
          </button>
        </div>` : ''}

      ${!isPending && s.approvedByName ? `
        <div style="font-size:11px;color:var(--txt-muted);margin-top:4px;padding-top:8px;border-top:1px solid var(--bdr)">
          ${s.status === 'rejected' ? 'Rejected' : 'Approved'} by ${s.approvedByName}
          ${s.rejectionReason ? ` · "${s.rejectionReason}"` : ''}
          ${s.approvedAt ? ` · ${fmtTS(s.approvedAt)}` : ''}
        </div>` : ''}
    </div>`;
}

/* ── Actions: Requisition ──────────────────────────────────────────── */
function approveReq(id) {
  const r = S_APR.requisitions.find(x => x.id === id);
  if (!r) return;
  const updatedLines = (r.lines || []).map(l => {
    const el = document.getElementById(`aq-${id}-${l.lineNo}`);
    return { ...l, qtyApproved: el ? Math.min(parseInt(el.value) || 0, l.qtyRequested) : l.qtyRequested };
  });
  const rmk = (document.getElementById(`ar-${id}`)?.value || '').trim();
  confirmApprovalAction({
    title: 'Approve Requisition?',
    icon: 'ti-check', color: 'var(--ok)', bg: 'var(--ok-bg)',
    message: `Approves ${updatedLines.length} line item(s) for "${r.partName || r.lines?.[0]?.partName || 'this requisition'}" and notifies the requester.`,
    confirmLabel: 'Yes, Approve', confirmClass: 'btn-ok',
    onConfirm: () => _commitApproveReq(id, r, updatedLines, rmk),
  });
}

async function _commitApproveReq(id, r, updatedLines, rmk) {
  try {
    await db.collection('requisitions').doc(id).update({
      status: 'approved', lines: updatedLines,
      approvedBy: S.sess.userId, approvedByName: S.sess.name,
      approvedAt: serverTS(),
      ...(rmk ? { notes: rmk } : {}),
      updatedAt: serverTS(),
    });
    await logAudit('APPROVE_REQUISITION', 'APPROVALS', id, r, { status: 'approved', lines: updatedLines });
    toast('Requisition approved ✓');
    await refreshAll();
  } catch (e) { toast(friendlyError(e)); }
}

function rejectReq(id) {
  const rmk = (document.getElementById(`ar-${id}`)?.value || '').trim();
  if (!rmk) { toast('Enter a reason for rejection'); return; }
  const r = S_APR.requisitions.find(x => x.id === id);
  confirmApprovalAction({
    title: 'Reject Requisition?',
    icon: 'ti-x', color: 'var(--err)', bg: 'var(--err-bg)',
    message: `Rejects this requisition with reason: "${rmk}". The requester will be notified.`,
    confirmLabel: 'Yes, Reject', confirmClass: 'btn-d',
    onConfirm: () => _commitRejectReq(id, r, rmk),
  });
}

async function _commitRejectReq(id, r, rmk) {
  try {
    await db.collection('requisitions').doc(id).update({
      status: 'rejected', rejectionReason: rmk,
      approvedBy: S.sess.userId, approvedByName: S.sess.name,
      approvedAt: serverTS(), updatedAt: serverTS(),
    });
    await logAudit('REJECT_REQUISITION', 'APPROVALS', id, r, { status: 'rejected', rejectionReason: rmk });
    toast('Requisition rejected');
    await refreshAll();
  } catch (e) { toast(friendlyError(e)); }
}

/* ── Actions: Setup Approval ───────────────────────────────────────── */
function approveSetup(id) {
  const s = S_APR.setupApprovals.find(x => x.id === id);
  if (!s) return;
  const rmk = (document.getElementById(`sa-rmk-${id}`)?.value || '').trim();
  confirmApprovalAction({
    title: 'Approve Setup?',
    icon: 'ti-check', color: 'var(--ok)', bg: 'var(--ok-bg)',
    message: `Approves setup for TAG ${s.tagId || '—'} on ${s.machineName || s.machineId || '—'} (${s.setupMins || 0} min).`,
    confirmLabel: 'Yes, Approve', confirmClass: 'btn-ok',
    onConfirm: () => _commitApproveSetup(id, s, rmk),
  });
}

async function _commitApproveSetup(id, s, rmk) {
  try {
    await db.collection('setupApprovals').doc(id).update({
      status: 'approved',
      approvedBy: S.sess.userId, approvedByName: S.sess.name,
      approvedAt: serverTS(),
      ...(rmk ? { approverRemarks: rmk } : {}),
      updatedAt: serverTS(),
    });
    await logAudit('APPROVE_SETUP', 'APPROVALS', id, s, { status: 'approved' });
    toast('Setup approved ✓');
    await refreshAll();
  } catch (e) { toast(friendlyError(e)); }
}

function rejectSetup(id) {
  const s = S_APR.setupApprovals.find(x => x.id === id);
  if (!s) return;
  const rmk = (document.getElementById(`sa-rmk-${id}`)?.value || '').trim();
  if (!rmk) { toast('Enter a reason for rejection'); return; }
  confirmApprovalAction({
    title: 'Reject Setup?',
    icon: 'ti-x', color: 'var(--err)', bg: 'var(--err-bg)',
    message: `Rejects setup for TAG ${s.tagId || '—'} with reason: "${rmk}".`,
    confirmLabel: 'Yes, Reject', confirmClass: 'btn-d',
    onConfirm: () => _commitRejectSetup(id, s, rmk),
  });
}

async function _commitRejectSetup(id, s, rmk) {
  try {
    await db.collection('setupApprovals').doc(id).update({
      status: 'rejected', rejectionReason: rmk,
      approvedBy: S.sess.userId, approvedByName: S.sess.name,
      approvedAt: serverTS(), updatedAt: serverTS(),
    });
    await logAudit('REJECT_SETUP', 'APPROVALS', id, s, { status: 'rejected', rejectionReason: rmk });
    toast('Setup rejected');
    await refreshAll();
  } catch (e) { toast(friendlyError(e)); }
}

/* ── Actions: Sequence Deviation ───────────────────────────────────── */
function approveDeviation(id) {
  const s = S_APR.setupDeviations.find(x => x.id === id);
  if (!s) return;
  const rmk = (document.getElementById(`dev-rmk-${id}`)?.value || '').trim();
  if (!rmk) { toast('Enter Plant Head remarks before approving'); return; }
  confirmApprovalAction({
    title: 'Approve Deviation?',
    icon: 'ti-check', color: 'var(--ok)', bg: 'var(--ok-bg)',
    message: `Approves the sequence deviation for TAG ${s.tagId || '—'} and releases the linked setup to QC.`,
    confirmLabel: 'Yes, Approve', confirmClass: 'btn-ok',
    onConfirm: () => _commitApproveDeviation(id, s, rmk),
  });
}

async function _commitApproveDeviation(id, s, rmk) {
  try {
    await db.collection('setupDeviations').doc(id).update({
      status: 'approved', approverRemarks: rmk,
      approvedBy: S.sess.userId, approvedByName: S.sess.name,
      approvedAt: serverTS(), updatedAt: serverTS(),
    });
    await logAudit('APPROVE_DEVIATION', 'APPROVALS', id, s, { status: 'approved' });

    // Release the linked setup to QC now that the Plant Head has approved
    // the deviation — it was held at 'awaiting_deviation' precisely so QC
    // could never approve a setup whose deviation was still undecided.
    if (s.setupApprovalId) {
      const setupBefore = S_APR.setupApprovals.find(x => x.id === s.setupApprovalId);
      await db.collection('setupApprovals').doc(s.setupApprovalId).update({
        status: 'pending', updatedAt: serverTS(),
      });
      await logAudit('RELEASE_SETUP_TO_QC', 'APPROVALS', s.setupApprovalId, setupBefore, { status: 'pending' });
    }

    toast('Deviation approved ✓ — setup released to QC');
    await refreshAll();
  } catch (e) { toast(friendlyError(e)); }
}

function rejectDeviation(id) {
  const s = S_APR.setupDeviations.find(x => x.id === id);
  if (!s) return;
  const rmk = (document.getElementById(`dev-rmk-${id}`)?.value || '').trim();
  if (!rmk) { toast('Enter Plant Head remarks before rejecting'); return; }
  confirmApprovalAction({
    title: 'Reject Deviation?',
    icon: 'ti-x', color: 'var(--err)', bg: 'var(--err-bg)',
    message: `Rejects the sequence deviation for TAG ${s.tagId || '—'} — the linked setup will also be rejected and will not reach QC.`,
    confirmLabel: 'Yes, Reject', confirmClass: 'btn-d',
    onConfirm: () => _commitRejectDeviation(id, s, rmk),
  });
}

async function _commitRejectDeviation(id, s, rmk) {
  try {
    await db.collection('setupDeviations').doc(id).update({
      status: 'rejected', rejectionReason: rmk,
      approvedBy: S.sess.userId, approvedByName: S.sess.name,
      approvedAt: serverTS(), updatedAt: serverTS(),
    });
    await logAudit('REJECT_DEVIATION', 'APPROVALS', id, s, { status: 'rejected', rejectionReason: rmk });

    // The linked setup never reaches QC — it's rejected outright along with
    // the deviation it depended on.
    if (s.setupApprovalId) {
      const setupBefore = S_APR.setupApprovals.find(x => x.id === s.setupApprovalId);
      await db.collection('setupApprovals').doc(s.setupApprovalId).update({
        status: 'rejected',
        rejectionReason: `Sequence deviation rejected by Plant Head: ${rmk}`,
        approvedBy: S.sess.userId, approvedByName: S.sess.name,
        approvedAt: serverTS(), updatedAt: serverTS(),
      });
      await logAudit('REJECT_SETUP', 'APPROVALS', s.setupApprovalId, setupBefore, { status: 'rejected' });
    }

    toast('Deviation rejected — linked setup rejected, will not reach QC');
    await refreshAll();
  } catch (e) { toast(friendlyError(e)); }
}

/* ── Card: Maintenance Spares Request ──────────────────────────────── */
function sparesCard(s, isPending) {
  const canAct = isPending && (S.sess?.role === 'admin' || S.sess?.role === 'hod');
  const total  = fmtINR(s.totalCost || 0);
  const spares = s.spares || [];
  return `
    <div class="card" style="margin-bottom:10px;border:1.5px solid ${isPending?'var(--warn)':'var(--bdr)'}">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px;margin-bottom:10px">
        <div>
          <div style="font-weight:800;font-size:14px">Spares Request</div>
          <div style="font-size:11px;color:var(--txt-muted);margin-top:2px">
            Machine: <strong>${s.machineName || s.machineId || '—'}</strong>
          </div>
          <div style="font-size:11px;color:var(--txt-muted)">
            By ${s.requestedByName || '—'} · ${fmtTS(s.createdAt)}
          </div>
        </div>
        <div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px;flex-shrink:0">
          ${statusBadge(s.status)}
          ${moduleTag('Maintenance', 'ti-tool')}
        </div>
      </div>

      ${spares.length ? `
        <div style="margin-bottom:10px">
          <div style="font-size:10px;font-weight:700;color:var(--txt-muted);letter-spacing:.06em;margin-bottom:6px">SPARES NEEDED</div>
          ${spares.map(sp => `
            <div style="display:flex;align-items:center;justify-content:space-between;padding:7px 10px;background:var(--bg);border-radius:6px;margin-bottom:4px;font-size:12px">
              <div>
                <div style="font-weight:700">${sp.name || '—'}</div>
                <div style="color:var(--txt-muted);font-size:11px">${sp.supplierName || 'Supplier TBD'} · Qty ${sp.qty || 0}</div>
              </div>
              <div style="font-weight:700;color:var(--txt)">${fmtINR((sp.qty || 0) * (sp.unitRate || 0))}</div>
            </div>`).join('')}
          <div style="text-align:right;font-size:13px;font-weight:800;margin-top:6px;color:var(--txt)">
            Total: ${total}
          </div>
        </div>` : ''}

      ${s.breakdownId ? `<div style="font-size:11px;color:var(--txt-muted);margin-bottom:8px">Breakdown ref: <code>${s.breakdownId}</code></div>` : ''}

      ${canAct ? `
        <div class="f" style="margin-bottom:8px">
          <label style="font-size:11px">Remarks (optional)</label>
          <input type="text" id="sp-rmk-${s.id}" placeholder="e.g. Approved — use supplier X, negotiate rate..." style="font-size:13px">
        </div>
        <div style="display:flex;gap:8px">
          <button class="btn btn-ok" style="flex:1" onclick="approveSpares('${s.id}')">
            <i class="ti ti-check"></i> Approve
          </button>
          <button class="btn btn-d" style="flex:1" onclick="rejectSpares('${s.id}')">
            <i class="ti ti-x"></i> Reject
          </button>
        </div>` : ''}

      ${!isPending && s.approvedByName ? `
        <div style="font-size:11px;color:var(--txt-muted);margin-top:4px;padding-top:8px;border-top:1px solid var(--bdr)">
          ${s.status === 'rejected' ? 'Rejected' : 'Approved'} by ${s.approvedByName}
          ${s.rejectionReason ? ` · "${s.rejectionReason}"` : ''}
          ${s.approverRemarks ? ` · "${s.approverRemarks}"` : ''}
          ${s.approvedAt ? ` · ${fmtTS(s.approvedAt)}` : ''}
        </div>` : ''}
      ${s.status === 'approved' ? `
        <button class="btn btn-s" style="margin-top:8px;width:100%" onclick="printSparesMRO('${s.id}')">
          <i class="ti ti-printer" aria-hidden="true"></i> Print Approved Spares
        </button>` : ''}
      ${isTanmay() ? `
        <button class="btn btn-d btn-sm w-full" style="margin-top:8px" onclick="deleteSparesRequest('${s.id}')">
          <i class="ti ti-trash"></i> Delete Spares Request
        </button>` : ''}
    </div>`;
}

/* ── Actions: Spares Request ───────────────────────────────────────── */
function approveSpares(id) {
  const s = S_APR.sparesRequests.find(x => x.id === id);
  if (!s) return;
  const rmk = (document.getElementById(`sp-rmk-${id}`)?.value || '').trim();
  confirmApprovalAction({
    title: 'Approve Spares Request?',
    icon: 'ti-check', color: 'var(--ok)', bg: 'var(--ok-bg)',
    message: `Approves the spares request for ${s.machineName || s.machineId || 'this machine'} (${fmtINR(s.totalCost || 0)}).`,
    confirmLabel: 'Yes, Approve', confirmClass: 'btn-ok',
    onConfirm: () => _commitApproveSpares(id, s, rmk),
  });
}

async function _commitApproveSpares(id, s, rmk) {
  try {
    await db.collection('sparesRequests').doc(id).update({
      status: 'approved',
      approvedBy: S.sess.userId, approvedByName: S.sess.name,
      approvedAt: serverTS(),
      ...(rmk ? { approverRemarks: rmk } : {}),
      updatedAt: serverTS(),
    });
    await logAudit('APPROVE_SPARES', 'APPROVALS', id, s, { status: 'approved' });
    toast('Spares request approved ✓');
    await refreshAll();
  } catch (e) { toast(friendlyError(e)); }
}

function rejectSpares(id) {
  const s = S_APR.sparesRequests.find(x => x.id === id);
  if (!s) return;
  const rmk = (document.getElementById(`sp-rmk-${id}`)?.value || '').trim();
  if (!rmk) { toast('Enter a reason for rejection'); return; }
  confirmApprovalAction({
    title: 'Reject Spares Request?',
    icon: 'ti-x', color: 'var(--err)', bg: 'var(--err-bg)',
    message: `Rejects the spares request for ${s.machineName || s.machineId || 'this machine'} with reason: "${rmk}".`,
    confirmLabel: 'Yes, Reject', confirmClass: 'btn-d',
    onConfirm: () => _commitRejectSpares(id, s, rmk),
  });
}

async function _commitRejectSpares(id, s, rmk) {
  try {
    await db.collection('sparesRequests').doc(id).update({
      status: 'rejected', rejectionReason: rmk,
      approvedBy: S.sess.userId, approvedByName: S.sess.name,
      approvedAt: serverTS(), updatedAt: serverTS(),
    });
    await logAudit('REJECT_SPARES', 'APPROVALS', id, s, { status: 'rejected', rejectionReason: rmk });
    toast('Spares request rejected');
    await refreshAll();
  } catch (e) { toast(friendlyError(e)); }
}

async function deleteSparesRequest(id) {
  if (!isTanmay()) { toast('Access denied'); return; }
  const s = S_APR.sparesRequests.find(x => x.id === id);
  if (!s) return;

  if (!confirm(`Delete spares request for machine ${s.machineName || s.machineId}?`)) return;

  try {
    const batch = db.batch();
    batch.delete(db.collection('sparesRequests').doc(id));

    if (s.breakdownId) {
      batch.update(db.collection('breakdowns').doc(s.breakdownId), {
        sparesRequestId: firebase.firestore.FieldValue.delete()
      });
    }

    await batch.commit();
    await logAudit('DELETE_SPARES_REQUEST', 'APPROVALS', id, s, null);
    await refreshAll();
    toast('Spares request deleted ✓');
  } catch (e) {
    toast('Error: ' + friendlyError(e));
  }
}

/* ── Card: SCM Supplier Scrap ──────────────────────────────────────── */
const SCRAP_DEFECT_LABELS = {
  cracked: 'Cracked / Fractured', porosity: 'Porosity / Internal Void',
  dimensional: 'Dimensional Out of Tolerance', surface_finish: 'Surface Finish Defect',
  hardness: 'Hardness / Material Property', machining_damage: 'Machining Damage', other: 'Other',
};

function scrapCard(s, isPending) {
  const canAct = isPending && canDo('scrap_approve');
  const isAuto = s.approvedBy === 'system';
  return `
    <div class="card" style="margin-bottom:10px;border:1.5px solid ${isPending?'var(--warn)':'var(--bdr)'}">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px;margin-bottom:10px">
        <div>
          <div style="font-weight:800;font-size:14px">${s.supplierName || '—'} <span style="font-family:monospace;font-size:11px;font-weight:400;color:var(--txt-muted)">${s.fpn || ''}${s.cpn ? ' / ' + s.cpn : ''}</span></div>
          <div style="font-size:11px;color:var(--txt-muted);margin-top:2px">
            By ${s.requestedByName || '—'} · ${fmtDate(s.date)}
          </div>
        </div>
        <div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px;flex-shrink:0">
          ${statusBadge(s.status)}
          ${moduleTag('SCM', 'ti-truck-delivery')}
          ${isAuto ? moduleTag('Auto-approved', 'ti-robot') : ''}
        </div>
      </div>

      <div style="background:var(--bg);border-radius:6px;padding:8px 10px;margin-bottom:10px">
        <div style="display:flex;align-items:baseline;gap:8px">
          <div style="font-size:18px;font-weight:800">${s.qtyScrap || 0} pcs</div>
          <span style="font-size:10px;font-weight:700;color:var(--txt-muted);background:var(--sur);border:1px solid var(--bdr);border-radius:4px;padding:2px 7px">${SCRAP_DEFECT_LABELS[s.defectCode] || s.defectCode || '—'}</span>
        </div>
        <div style="font-size:11px;color:var(--txt-muted);font-style:italic">"${s.reason || '—'}"</div>
      </div>

      ${canAct ? `
        <div class="f" style="margin-bottom:8px">
          <label style="font-size:11px">Approver Remarks *</label>
          <input type="text" id="scrap-rmk-${s.id}" placeholder="Reason for approval or rejection..." style="font-size:13px">
        </div>
        <div style="display:flex;gap:8px">
          <button class="btn btn-ok" style="flex:1" onclick="approveScrap('${s.id}')">
            <i class="ti ti-check"></i> Approve
          </button>
          <button class="btn btn-d" style="flex:1" onclick="rejectScrap('${s.id}')">
            <i class="ti ti-x"></i> Reject
          </button>
        </div>` : ''}

      ${!isPending && s.approvedByName ? `
        <div style="font-size:11px;color:var(--txt-muted);margin-top:4px;padding-top:8px;border-top:1px solid var(--bdr)">
          ${s.status === 'rejected' ? 'Rejected' : 'Approved'} by ${s.approvedByName}
          ${s.rejectionReason ? ` · "${s.rejectionReason}"` : ''}
          ${s.approverRemarks ? ` · "${s.approverRemarks}"` : ''}
          ${s.approvedAt ? ` · ${fmtTS(s.approvedAt)}` : ''}
        </div>` : ''}
    </div>`;
}

function approveScrap(id) {
  const s = S_APR.scmScrapLedger.find(x => x.id === id);
  if (!s) return;
  const rmk = (document.getElementById(`scrap-rmk-${id}`)?.value || '').trim();
  if (!rmk) { toast('Enter approver remarks before approving'); return; }
  confirmApprovalAction({
    title: 'Approve Scrap Request?',
    icon: 'ti-check', color: 'var(--ok)', bg: 'var(--ok-bg)',
    message: `Approves ${s.qtyScrap || 0} pcs scrap for ${s.supplierName || 'this supplier'} (${s.fpn || ''}/${s.cpn || ''}) — this will deduct from their live Supplier WIP.`,
    confirmLabel: 'Yes, Approve', confirmClass: 'btn-ok',
    onConfirm: () => _commitApproveScrap(id, s, rmk),
  });
}

async function _commitApproveScrap(id, s, rmk) {
  try {
    await db.collection('scmScrapLedger').doc(id).update({
      status: 'approved', approverRemarks: rmk,
      approvedBy: S.sess.userId, approvedByName: S.sess.name,
      approvedAt: serverTS(), updatedAt: serverTS(),
    });
    await logAudit('APPROVE_SCM_SCRAP', 'APPROVALS', id, s, { status: 'approved' });
    toast('Scrap request approved ✓ — Supplier WIP updated');
    await refreshAll();
  } catch (e) { toast(friendlyError(e)); }
}

function rejectScrap(id) {
  const s = S_APR.scmScrapLedger.find(x => x.id === id);
  if (!s) return;
  const rmk = (document.getElementById(`scrap-rmk-${id}`)?.value || '').trim();
  if (!rmk) { toast('Enter a reason for rejection'); return; }
  confirmApprovalAction({
    title: 'Reject Scrap Request?',
    icon: 'ti-x', color: 'var(--err)', bg: 'var(--err-bg)',
    message: `Rejects the scrap request for ${s.supplierName || 'this supplier'} with reason: "${rmk}" — Supplier WIP is unaffected.`,
    confirmLabel: 'Yes, Reject', confirmClass: 'btn-d',
    onConfirm: () => _commitRejectScrap(id, s, rmk),
  });
}

async function _commitRejectScrap(id, s, rmk) {
  try {
    await db.collection('scmScrapLedger').doc(id).update({
      status: 'rejected', rejectionReason: rmk,
      approvedBy: S.sess.userId, approvedByName: S.sess.name,
      approvedAt: serverTS(), updatedAt: serverTS(),
    });
    await logAudit('REJECT_SCM_SCRAP', 'APPROVALS', id, s, { status: 'rejected', rejectionReason: rmk });
    toast('Scrap request rejected');
    await refreshAll();
  } catch (e) { toast(friendlyError(e)); }
}

/* ── Print: Approved MRO Spares ────────────────────────────────────── */
function printSparesMRO(sparesId) {
  const s = S_APR.sparesRequests.find(x => x.id === sparesId);
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

/* ── Boot ──────────────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', init);
