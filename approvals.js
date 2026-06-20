/* ═══════════════════════════════════════════════════════════════════
   IMF ProTrack — Approvals
   Central hub for pending approvals across all modules.

   Collections:
     requisitions    — store material requests   (status: pending|approved|rejected|partial|fulfilled)
     setupApprovals  — production machine setups (status: pending|approved|rejected)
     setupDeviations — sequence deviations       (status: pending|approved|rejected)
     sparesRequests  — maintenance spares        (status: pending|approved|rejected)
   ═══════════════════════════════════════════════════════════════════ */

'use strict';

/* ── State ─────────────────────────────────────────────────────────── */
let _tab     = 'all';   // 'all' | 'requisitions' | 'setup' | 'deviations' | 'spares'
let _histTab = false;   // showing history section?

const S_APR = {
  requisitions:    [],
  setupApprovals:  [],
  setupDeviations: [],
  sparesRequests:  [],
};

/* ── Boot ──────────────────────────────────────────────────────────── */
async function init() {
  try { await initShell(); } catch (e) {
    clearSess(); window.location.replace('index.html'); return;
  }
  if (!canView('production') && !canView('inward')) {
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
    const [reqSnap, saSnap, sdSnap, spSnap] = await Promise.all([
      db.collection('requisitions').orderBy('createdAt', 'desc').limit(100).get(),
      db.collection('setupApprovals').orderBy('createdAt', 'desc').limit(200).get(),
      db.collection('setupDeviations').orderBy('createdAt', 'desc').limit(100).get(),
      db.collection('sparesRequests').orderBy('createdAt', 'desc').limit(100).get(),
    ]);
    S_APR.requisitions    = reqSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    S_APR.setupApprovals  = saSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    S_APR.setupDeviations = sdSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    S_APR.sparesRequests  = spSnap.docs.map(d => ({ id: d.id, ...d.data() }));
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
  const totalPending = pendingReq.length + pendingSA.length + pendingSD.length + pendingSP.length;

  const tabs = [
    { key: 'all',          label: 'All',         count: totalPending },
    { key: 'requisitions', label: 'Requisitions', count: pendingReq.length },
    { key: 'setup',        label: 'Setup',        count: pendingSA.length },
    { key: 'deviations',   label: 'Deviations',   count: pendingSD.length },
    { key: 'spares',       label: 'Spares',        count: pendingSP.length },
  ];

  const tabHtml = tabs.map(t => `
    <button onclick="switchTab('${t.key}')"
      style="flex:1;padding:8px 4px;border:none;background:${_tab===t.key?'var(--acc)':'var(--sur)'};
             color:${_tab===t.key?'#fff':'var(--txt)'};border-radius:6px;font-size:12px;font-weight:700;cursor:pointer;
             display:flex;align-items:center;justify-content:center;gap:5px;transition:background .15s">
      ${t.label}
      ${t.count > 0 ? `<span style="background:${_tab===t.key?'rgba(255,255,255,.25)':'var(--acc)'};color:#fff;border-radius:99px;padding:1px 6px;font-size:10px">${t.count}</span>` : ''}
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
  pendingItems.sort((a, b) => (b.ts?.toMillis?.() || 0) - (a.ts?.toMillis?.() || 0));

  const pendingHtml = pendingItems.length
    ? pendingItems.map(item => {
        if (item.type === 'requisition') return reqCard(item.data, true);
        if (item.type === 'setup')       return setupCard(item.data, true);
        if (item.type === 'deviation')   return deviationCard(item.data, true);
        if (item.type === 'spares')      return sparesCard(item.data, true);
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
      <div style="display:flex;gap:4px;background:var(--sur);border-radius:8px;padding:4px;margin-bottom:14px;flex-wrap:wrap">
        ${tabHtml}
      </div>

      <!-- Pending section -->
      ${pendingItems.length ? `<div style="font-size:11px;font-weight:700;color:var(--txt-muted);letter-spacing:.06em;margin-bottom:8px">AWAITING ACTION</div>` : ''}
      ${pendingHtml}

      <!-- History section -->
      ${histItems.length ? `
        <div style="margin-top:20px">
          <div onclick="_histTab=!_histTab;render()"
            style="display:flex;align-items:center;justify-content:space-between;cursor:pointer;padding:8px 0;border-top:1px solid var(--bdr)">
            <div style="font-size:11px;font-weight:700;color:var(--txt-muted);letter-spacing:.06em">
              RECENTLY PROCESSED (${histItems.length})
            </div>
            <i class="ti ${_histTab?'ti-chevron-up':'ti-chevron-down'}" style="color:var(--txt-muted);font-size:14px"></i>
          </div>
          ${_histTab ? histItems.map(item => {
            if (item.type === 'requisition') return reqCard(item.data, false);
            if (item.type === 'setup')       return setupCard(item.data, false);
            if (item.type === 'deviation')   return deviationCard(item.data, false);
            if (item.type === 'spares')      return sparesCard(item.data, false);
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
  pending:   { bg: '#fef9c3', border: '#fde68a', color: '#92400e', label: 'Pending' },
  approved:  { bg: '#f0fdf4', border: '#86efac', color: '#166534', label: 'Approved' },
  rejected:  { bg: '#fef2f2', border: '#fca5a5', color: '#991b1b', label: 'Rejected' },
  partial:   { bg: '#eff6ff', border: '#93c5fd', color: '#1e40af', label: 'Part Approved' },
  fulfilled: { bg: '#f0fdf4', border: '#86efac', color: '#166534', label: 'Fulfilled' },
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
    <div class="card" style="margin-bottom:10px;border-left:3px solid ${isPending?'#f59e0b':'var(--bdr)'}">
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
    <div class="card" style="margin-bottom:10px;border-left:3px solid ${isPending?'var(--acc)':'var(--bdr)'}">
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
    <div style="background:#fef2f2;border:1px solid #fca5a5;border-radius:var(--rs);
                padding:10px 14px;font-size:12px;font-weight:700;color:var(--err);margin-bottom:14px">
      <i class="ti ti-alert-triangle"></i> This permanently removes the setup record from both Production and QC views.
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
    toast('Error deleting setup: ' + e.message);
  }
}

/* ── Card: Sequence Deviation ──────────────────────────────────────── */
function deviationCard(s, isPending) {
  const canAct = isPending && (S.sess?.role === 'admin' || S.sess?.role === 'hod');
  return `
    <div class="card" style="margin-bottom:10px;border-left:3px solid ${isPending?'#dc2626':'var(--bdr)'}">
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

      <div style="background:#fef2f2;border:1px solid #fca5a5;border-radius:6px;padding:10px 12px;margin-bottom:10px">
        <div style="font-size:11px;font-weight:700;color:#991b1b;margin-bottom:4px">SKIPPED OPERATION</div>
        <div style="font-size:13px;font-weight:700">${s.missingOpName || '—'}</div>
        ${s.missingSeqNo ? `<div style="font-size:11px;color:#991b1b;margin-top:2px">Step #${s.missingSeqNo} was not completed before proceeding</div>` : ''}
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
async function approveReq(id) {
  const r = S_APR.requisitions.find(x => x.id === id);
  if (!r) return;
  const updatedLines = (r.lines || []).map(l => {
    const el = document.getElementById(`aq-${id}-${l.lineNo}`);
    return { ...l, qtyApproved: el ? Math.min(parseInt(el.value) || 0, l.qtyRequested) : l.qtyRequested };
  });
  const rmk = (document.getElementById(`ar-${id}`)?.value || '').trim();
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
  } catch (e) { toast('Error: ' + e.message); }
}

async function rejectReq(id) {
  const rmk = (document.getElementById(`ar-${id}`)?.value || '').trim();
  if (!rmk) { toast('Enter a reason for rejection'); return; }
  const r = S_APR.requisitions.find(x => x.id === id);
  try {
    await db.collection('requisitions').doc(id).update({
      status: 'rejected', rejectionReason: rmk,
      approvedBy: S.sess.userId, approvedByName: S.sess.name,
      approvedAt: serverTS(), updatedAt: serverTS(),
    });
    await logAudit('REJECT_REQUISITION', 'APPROVALS', id, r, { status: 'rejected', rejectionReason: rmk });
    toast('Requisition rejected');
    await refreshAll();
  } catch (e) { toast('Error: ' + e.message); }
}

/* ── Actions: Setup Approval ───────────────────────────────────────── */
async function approveSetup(id) {
  const s = S_APR.setupApprovals.find(x => x.id === id);
  if (!s) return;
  const rmk = (document.getElementById(`sa-rmk-${id}`)?.value || '').trim();
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
  } catch (e) { toast('Error: ' + e.message); }
}

async function rejectSetup(id) {
  const s = S_APR.setupApprovals.find(x => x.id === id);
  if (!s) return;
  const rmk = (document.getElementById(`sa-rmk-${id}`)?.value || '').trim();
  if (!rmk) { toast('Enter a reason for rejection'); return; }
  try {
    await db.collection('setupApprovals').doc(id).update({
      status: 'rejected', rejectionReason: rmk,
      approvedBy: S.sess.userId, approvedByName: S.sess.name,
      approvedAt: serverTS(), updatedAt: serverTS(),
    });
    await logAudit('REJECT_SETUP', 'APPROVALS', id, s, { status: 'rejected', rejectionReason: rmk });
    toast('Setup rejected');
    await refreshAll();
  } catch (e) { toast('Error: ' + e.message); }
}

/* ── Actions: Sequence Deviation ───────────────────────────────────── */
async function approveDeviation(id) {
  const s = S_APR.setupDeviations.find(x => x.id === id);
  if (!s) return;
  const rmk = (document.getElementById(`dev-rmk-${id}`)?.value || '').trim();
  if (!rmk) { toast('Enter Plant Head remarks before approving'); return; }
  try {
    await db.collection('setupDeviations').doc(id).update({
      status: 'approved', approverRemarks: rmk,
      approvedBy: S.sess.userId, approvedByName: S.sess.name,
      approvedAt: serverTS(), updatedAt: serverTS(),
    });
    await logAudit('APPROVE_DEVIATION', 'APPROVALS', id, s, { status: 'approved' });
    toast('Deviation approved ✓');
    await refreshAll();
  } catch (e) { toast('Error: ' + e.message); }
}

async function rejectDeviation(id) {
  const s = S_APR.setupDeviations.find(x => x.id === id);
  if (!s) return;
  const rmk = (document.getElementById(`dev-rmk-${id}`)?.value || '').trim();
  if (!rmk) { toast('Enter Plant Head remarks before rejecting'); return; }
  try {
    await db.collection('setupDeviations').doc(id).update({
      status: 'rejected', rejectionReason: rmk,
      approvedBy: S.sess.userId, approvedByName: S.sess.name,
      approvedAt: serverTS(), updatedAt: serverTS(),
    });
    await logAudit('REJECT_DEVIATION', 'APPROVALS', id, s, { status: 'rejected', rejectionReason: rmk });
    toast('Deviation rejected');
    await refreshAll();
  } catch (e) { toast('Error: ' + e.message); }
}

/* ── Card: Maintenance Spares Request ──────────────────────────────── */
function sparesCard(s, isPending) {
  const canAct = isPending && (S.sess?.role === 'admin' || S.sess?.role === 'hod');
  const total  = fmtINR(s.totalCost || 0);
  const spares = s.spares || [];
  return `
    <div class="card" style="margin-bottom:10px;border-left:3px solid ${isPending?'#d97706':'var(--bdr)'}">
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
          🖨️ Print Approved Spares
        </button>` : ''}
    </div>`;
}

/* ── Actions: Spares Request ───────────────────────────────────────── */
async function approveSpares(id) {
  const s = S_APR.sparesRequests.find(x => x.id === id);
  if (!s) return;
  const rmk = (document.getElementById(`sp-rmk-${id}`)?.value || '').trim();
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
  } catch (e) { toast('Error: ' + e.message); }
}

async function rejectSpares(id) {
  const s = S_APR.sparesRequests.find(x => x.id === id);
  if (!s) return;
  const rmk = (document.getElementById(`sp-rmk-${id}`)?.value || '').trim();
  if (!rmk) { toast('Enter a reason for rejection'); return; }
  try {
    await db.collection('sparesRequests').doc(id).update({
      status: 'rejected', rejectionReason: rmk,
      approvedBy: S.sess.userId, approvedByName: S.sess.name,
      approvedAt: serverTS(), updatedAt: serverTS(),
    });
    await logAudit('REJECT_SPARES', 'APPROVALS', id, s, { status: 'rejected', rejectionReason: rmk });
    toast('Spares request rejected');
    await refreshAll();
  } catch (e) { toast('Error: ' + e.message); }
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
