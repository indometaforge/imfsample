/* ═══════════════════════════════════════════════════════════════════
   IMF ProTrack — Dispatch
   PO management, QR-verified dispatch sessions, tracksheet.

   Collections read:
     routeCards  — qc_cleared TAGs for stream verification
     pos         — purchase orders
     dispatches  — past dispatch records
   Collections written (atomic runTransaction):
     routeCards  — stream qty decrement + status update
     pos         — dispatchedQty update on matching PO line
     dispatches  — new dispatch record
   ═══════════════════════════════════════════════════════════════════ */

'use strict';

/* ── Tabs ────────────────────────────────────────────────────────────── */
const TABS = [
  { key: 'hub',        icon: 'ti-layout-dashboard', label: 'Hub'        },
  { key: 'pos',        icon: 'ti-file-text',         label: 'Sales Orders (SO)' },
  { key: 'dispatch',   icon: 'ti-truck',             label: 'Dispatch'   },
  { key: 'tracksheet', icon: 'ti-table',             label: 'Tracksheet' },
];

const STREAMS = [
  { key: 'oem',    label: 'OEM'    },
  { key: 'spares', label: 'Spares' },
  { key: 'market', label: 'Market' },
];

/* ── State ───────────────────────────────────────────────────────────── */
let _tab              = 'hub';
let _dispHeaderLocked = false;
let _dispHeader       = { customerId:'', customerName:'', poId:'', poNo:'', custPoNo:'', partId:'', partNo:'', partName:'', lineNo:0, stream:'oem', date:'', pieceRateINR:0 };
let _dispRows         = [];  // [{tagId, qty, invoiceNo, vehicle, batchCode, heatCode, verified, tagData}]
let _poEditId         = null;
let _poLines          = [];  // temp PO lines being edited

const S_DSP = {
  pos:         [],
  dispatches:  [],
  clearedCards: [],
};

function fmtMonth(val) {
  if (!val) return '';
  const parts = val.split('-');
  if (parts.length !== 2) return val;
  const y = parseInt(parts[0]);
  const m = parseInt(parts[1]) - 1;
  const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  if (m >= 0 && m < 12) {
    return `${monthNames[m]} ${y}`;
  }
  return val;
}

function getMonthDropdownOptions(selectedValue) {
  const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const current = new Date();
  let options = '<option value="">— Select Month —</option>';
  
  const generatedValues = new Set();
  const makeOpt = (val, label) => {
    generatedValues.add(val);
    const isSelected = selectedValue === val ? 'selected' : '';
    return `<option value="${val}" ${isSelected}>${label}</option>`;
  };

  if (selectedValue) {
    const parts = selectedValue.split('-');
    if (parts.length === 2) {
      const y = parseInt(parts[0]);
      const m = parseInt(parts[1]) - 1;
      if (m >= 0 && m < 12) {
        const diffMonths = (y - current.getFullYear()) * 12 + (m - current.getMonth());
        if (diffMonths < -6 || diffMonths > 24) {
          options += makeOpt(selectedValue, `${monthNames[m]} ${y}`);
        }
      }
    }
  }

  for (let i = -6; i <= 24; i++) {
    const d = new Date(current.getFullYear(), current.getMonth() + i, 1);
    const val = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const label = `${monthNames[d.getMonth()]} ${d.getFullYear()}`;
    if (!generatedValues.has(val)) {
      options += makeOpt(val, label);
    }
  }
  return options;
}


/* ── Boot ────────────────────────────────────────────────────────────── */
async function init() {
  window.onGlobalScan = dspScanTag;
  try { await initShell(); } catch (e) {
    clearSess(); window.location.replace('index.html'); return;
  }
  await loadDispatchData();
  render();
  document.getElementById('loading-screen').style.display = 'none';
  document.getElementById('app').style.display = '';
}

function normalizeDispatch(d) {
  const norm = { ...d };
  if (!norm.customerName && norm.customer) {
    norm.customerName = norm.customer;
  }
  if (!norm.rows && norm.items) {
    norm.rows = norm.items.map(it => ({
      tagId: it.tagId || 'Legacy Tag',
      qty: it.qty || 0,
      partId: it.partId || '',
      partNo: it.partNo || '',
      partName: it.partName || '',
      invoiceNo: norm.invoiceNo || '',
      vehicle: norm.vehicleNo || ''
    }));
  }
  if (!norm.partName && norm.items && norm.items[0]) {
    norm.partName = norm.items[0].partName;
    norm.partNo = norm.items[0].partNo;
  }
  if (!norm.partId && norm.items && norm.items[0]) {
    norm.partId = norm.items[0].partId;
  }
  if (!norm.totalQty) {
    if (norm.rows) {
      norm.totalQty = norm.rows.reduce((sum, r) => sum + (r.qty || 0), 0);
    } else if (norm.items) {
      norm.totalQty = norm.items.reduce((sum, it) => sum + (it.qty || 0), 0);
    } else {
      norm.totalQty = 0;
    }
  }
  return norm;
}

async function loadDispatchData() {
  try {
    const [poSnap, dispSnap, clearedSnap] = await Promise.all([
      db.collection('pos').orderBy('createdAt', 'desc').limit(200).get(),
      db.collection('dispatches').orderBy('createdAt', 'desc').limit(200).get(),
      db.collection('routeCards').where('status', '==', 'qc_cleared').get(),
    ]);
    S_DSP.pos          = poSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    S_DSP.dispatches   = dispSnap.docs.map(d => normalizeDispatch({ id: d.id, ...d.data() }));
    S_DSP.clearedCards = clearedSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch (e) { console.warn('loadDispatchData:', e.message); }
}

async function refreshDSP() {
  await loadDispatchData();
  render();
}

/* ── Shell render ────────────────────────────────────────────────────── */
function render() {
  const tabHtml = TABS.map(t => {
    const active = _tab === t.key;
    return `
      <button class="tab${active ? ' active' : ''}" role="tab" aria-selected="${active}"
        onclick="switchTab('${t.key}')">
        <i class="ti ${t.icon}" aria-hidden="true"></i> ${t.label}
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
  render();
}

function renderTab() {
  const el = document.getElementById('tab-body');
  if (!el) return;
  if      (_tab === 'hub')        renderHub();
  else if (_tab === 'pos')        renderPOs();
  else if (_tab === 'dispatch')   renderDispatch();
  else if (_tab === 'tracksheet') renderTracksheet();
}

/* ═══════════════════════════════════════════════════════════════════
   TAB: HUB
   ═══════════════════════════════════════════════════════════════════ */
function renderHub() {
  const el = document.getElementById('tab-body');
  if (!el) return;

  const today    = dateStr();
  const cleared  = S_DSP.clearedCards.length;
  const todayDsp = S_DSP.dispatches.filter(d => d.date === today).length;

  // Due-date compliance from PO lines
  const allLines = [];
  S_DSP.pos.filter(p => p.status === 'open').forEach(p => {
    (p.lines || []).forEach(l => { allLines.push({ po: p, line: l }); });
  });
  const overdue  = allLines.filter(({ line: l }) => l.dueDate && l.dueDate < today && (l.dispatchedQty || 0) < l.scheduledQty).length;
  const dueSoon  = allLines.filter(({ line: l }) => {
    if (!l.dueDate || l.dueDate < today || (l.dispatchedQty || 0) >= l.scheduledQty) return false;
    const d = new Date(today); d.setDate(d.getDate() + 7);
    return l.dueDate <= d.toISOString().slice(0, 10);
  }).length;

  el.innerHTML = `
    ${overdue > 0 ? `
      <div style="background:var(--err);color:#fff;border-radius:var(--rs);padding:14px 18px;margin-bottom:16px;display:flex;align-items:center;gap:12px;box-shadow:var(--sh-sm)">
        <i class="ti ti-alert-circle" style="font-size:24px;flex-shrink:0"></i>
        <div>
          <div style="font-weight:800;font-size:14px">${overdue} Overdue SO Line${overdue !== 1 ? 's' : ''}</div>
          <div style="font-size:12px;opacity:.9">Delivery dates have passed — check Tracksheet</div>
        </div>
        <button class="btn btn-sm" onclick="switchTab('tracksheet')"
          style="margin-left:auto;border:none;background:rgba(255,255,255,.25);color:#fff;border-radius:var(--rxs);padding:7px 12px;cursor:pointer;font-size:12px;font-weight:700">
          Tracksheet
        </button>
      </div>` : ''}

    <div class="stats-3" style="margin-bottom:16px">
      <div class="stat-card ${cleared > 0 ? 'ok' : ''}">
        <i class="ti ti-rosette-discount-check stat-icon" aria-hidden="true"></i>
        <div class="stat-lbl">Cleared TAGs</div>
        <div class="stat-val imf-mono">${cleared}</div>
        <div class="stat-sub">Ready to dispatch</div>
      </div>
      <div class="stat-card ${todayDsp > 0 ? 'ok' : ''}">
        <i class="ti ti-truck-delivery stat-icon" aria-hidden="true"></i>
        <div class="stat-lbl">Dispatched Today</div>
        <div class="stat-val imf-mono">${todayDsp}</div>
        <div class="stat-sub">${fmtDate(today)}</div>
      </div>
      <div class="stat-card ${overdue > 0 ? 'err' : dueSoon > 0 ? 'warn' : 'ok'}">
        <i class="ti ti-calendar-time stat-icon" aria-hidden="true"></i>
        <div class="stat-lbl">Due This Week</div>
        <div class="stat-val imf-mono">${dueSoon + overdue}</div>
        <div class="stat-sub">${overdue > 0 ? `${overdue} overdue!` : 'On track'}</div>
      </div>
    </div>

    <div style="display:flex;gap:12px;margin-bottom:20px;flex-wrap:wrap">
      <button class="btn btn-p" style="flex:1;padding:12px;font-size:14px" onclick="switchTab('dispatch')">
        <i class="ti ti-truck"></i> New Dispatch Session
      </button>
      <button class="btn btn-s" style="flex:1;padding:12px;font-size:14px" onclick="switchTab('tracksheet')">
        <i class="ti ti-table"></i> View Tracksheet
      </button>
    </div>

    ${S_DSP.dispatches.slice(0, 5).length > 0 ? `
      <div style="font-size:11px;font-weight:700;color:var(--txt-muted);letter-spacing:.06em;margin-bottom:10px;text-transform:uppercase">Recent Dispatches</div>
      <div class="imf-cards-list" style="display:flex;flex-direction:column;gap:8px">
        ${S_DSP.dispatches.slice(0, 5).map(dspRowCompact).join('')}
      </div>` : ''}

    <div style="display:flex;justify-content:flex-end;margin-top:12px">
      <button class="btn btn-s btn-sm" onclick="refreshDSP()"><i class="ti ti-refresh"></i> Refresh Data</button>
    </div>`;
}

function dspRowCompact(d) {
  const streamLbl = (d.stream || '').toUpperCase();
  return `
    <div class="imf-card" onclick="openDispatchDetailModal('${d.id}')" style="cursor:pointer">
      <div class="imf-card-top">
        <span class="imf-mono" style="font-size:12px;color:var(--txt-muted)">${d.poNo || '—'}${d.custPoNo ? ` · PO: ${d.custPoNo}` : ''}</span>
        <span class="imf-badge st-dispatched" style="margin-left:auto"><i class="ti ti-truck-delivery"></i> Dispatched</span>
      </div>
      <div class="imf-card-lead">
        <span class="nm" style="font-weight:700">${d.partName || '—'}</span>
        <span class="qty imf-mono">${d.totalQty || 0} <small>pcs</small></span>
      </div>
      <div class="imf-card-meta">
        Customer: <strong>${d.customerName || '—'}</strong> · Date: <strong>${fmtDate(d.date)}</strong> · Stream: <strong>${streamLbl}</strong>
      </div>
      <div class="imf-card-foot" style="margin-top:8px;font-size:11px;color:var(--txt-muted)">
        <span>${(d.rows||[]).length} TAG${(d.rows||[]).length!==1?'s':''} verified</span>
      </div>
    </div>`;
}

/* ═══════════════════════════════════════════════════════════════════
   TAB: POs
   ═══════════════════════════════════════════════════════════════════ */
function renderPOs() {
  const el = document.getElementById('tab-body');
  if (!el) return;

  const canEdit = isAdmin();
  const openPOs = S_DSP.pos.filter(p => p.status === 'open');
  const closedPOs = S_DSP.pos.filter(p => p.status !== 'open');

  el.innerHTML = `
    <div style="display:flex;gap:12px;margin-bottom:16px;align-items:center;flex-wrap:wrap">
      ${canEdit ? `<button class="btn btn-p" onclick="openPoModal(null)"><i class="ti ti-plus"></i> Create New SO</button>` : ''}
      <button class="btn btn-s btn-sm" onclick="exportAllSos('pdf')"><i class="ti ti-file-text"></i> Export PDF</button>
      <button class="btn btn-s btn-sm" onclick="exportAllSos('excel')"><i class="ti ti-table"></i> Export Excel</button>
      <button class="btn btn-s btn-sm" style="margin-left:auto;padding:8px 12px" onclick="refreshDSP()"><i class="ti ti-refresh"></i> Refresh</button>
    </div>

    ${openPOs.length
      ? `<div style="font-size:11px;font-weight:700;color:var(--txt-muted);letter-spacing:.06em;margin-bottom:10px;text-transform:uppercase">Open Sales Orders (${openPOs.length})</div>
         <div style="display:flex;flex-direction:column;gap:12px">${openPOs.map(p => poCard(p, canEdit)).join('')}</div>`
      : `<div class="imf-empty" style="padding:40px 20px"><div class="empty-ic" style="font-size:32px;color:var(--txt-dim);margin-bottom:8px"><i class="ti ti-file-text"></i></div><h3 style="font-size:15px;font-weight:700;margin-bottom:4px">No open SOs</h3><p style="font-size:12px;color:var(--txt-muted)">Create a sales order to track customer delivery compliance.</p></div>`}

    ${closedPOs.length ? `
      <div style="border-top:1px solid var(--line);margin:24px 0 12px;padding-top:16px">
        <div style="font-size:11px;font-weight:700;color:var(--txt-muted);letter-spacing:.06em;margin-bottom:10px;text-transform:uppercase">Closed Sales Orders (${closedPOs.length})</div>
        <div style="display:flex;flex-direction:column;gap:12px">${closedPOs.slice(0, 10).map(p => poCard(p, false)).join('')}</div>
      </div>` : ''}`;
}

function poCard(p, canEdit) {
  const lines = p.lines || [];
  return `
    <div class="imf-card" style="opacity:${p.status==='open'?1:0.75}">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:12px">
        <div>
          <div class="imf-mono" style="font-weight:800;font-size:15px;color:var(--imf-navy)">${p.poNo || '—'} ${p.custPoNo ? `<span style="font-size:12px;color:var(--txt-muted);font-weight:400"> (PO: ${p.custPoNo})</span>` : ''}</div>
          <div style="font-size:12px;color:var(--txt-muted);margin-top:2px">
            Customer: <strong>${p.customerName || '—'}</strong> · Date: <strong>${fmtDate(p.poDate)}</strong>
          </div>
          ${p.deliveryMonth ? `<div style="font-size:11px;color:var(--txt-dim);margin-top:2px"><i class="ti ti-calendar"></i> Delivery Month: <span class="imf-mono">${fmtMonth(p.deliveryMonth)}</span></div>` : ''}
        </div>
          ${p.status === 'open'
            ? `<span class="imf-badge st-store_issued" style="padding:4px 10px"><i class="ti ti-circle-check"></i> Open</span>`
            : `<span class="imf-badge st-dispatched" style="padding:4px 10px"><i class="ti ti-lock"></i> Closed</span>`
          }
          <button class="btn btn-s btn-sm" style="padding:4px 8px;background:var(--acc);color:#fff;border:none" onclick="exportSoToPDF('${p.id}')" title="Export / Share SO"><i class="ti ti-download"></i> Share</button>
          ${canEdit ? `<button class="btn btn-s btn-sm" style="padding:4px 8px" onclick="openPoModal('${p.id}')"><i class="ti ti-edit"></i></button>` : ''}
        </div>
      </div>
      
      <!-- Financial & Quantity Summary -->
      ${(() => {
        const uniqueParts = new Set(lines.map(l => l.partId)).size;
        const totalQty = lines.reduce((acc, l) => acc + (l.scheduledQty || 0), 0);
        const totalVal = lines.reduce((acc, l) => acc + ((l.scheduledQty || 0) * (l.pieceRateINR || 0)), 0);
        return `
        <div style="display:flex;gap:16px;background:var(--sur2);padding:8px 12px;border-radius:var(--rxs);margin-bottom:12px;font-size:12px">
          <div>Parts: <strong>${uniqueParts}</strong></div>
          <div>Total Qty: <strong>${totalQty} pcs</strong></div>
          <div>Total Value: <strong style="color:var(--imf-navy)">${fmtINR(totalVal)}</strong></div>
        </div>`;
      })()}

      <div style="display:flex;flex-direction:column;gap:8px">
        ${lines.map(l => {
          const pct    = l.scheduledQty > 0 ? Math.round(((l.dispatchedQty || 0) / l.scheduledQty) * 100) : 0;
          const isOverdue = l.dueDate && l.dueDate < dateStr() && (l.dispatchedQty || 0) < l.scheduledQty;
          const statusCls = pct >= 100 ? 'rag-g' : isOverdue ? 'rag-r' : 'rag-b';
          const indicatorColor = pct >= 100 ? 'var(--ok)' : isOverdue ? 'var(--err)' : 'var(--acc)';
          return `
            <div style="background:var(--fill);border-radius:var(--rs);padding:10px 12px">
               <div style="display:flex;align-items:center;justify-content:space-between;gap:8px">
                <div style="flex:1;min-width:0">
                  <div style="font-weight:700;font-size:13px">${l.partName || '—'}</div>
                  <div style="font-size:11px;color:var(--txt-muted);margin-top:2px">
                    Due: <strong>${fmtLineDue(l, p.deliveryMonth)}</strong> · Rate: <strong class="imf-mono">${fmtINR(l.pieceRateINR || 0)}</strong>
                  </div>
                  <div style="font-size:10.5px;color:var(--txt-dim);margin-top:3px;font-family:var(--mono-v2)">
                    PO Qty: <strong>${l.customerPoQty||0}</strong>&nbsp;·&nbsp;Accepted: <strong>${l.totalScheduleQty||l.scheduledQty||0}</strong>&nbsp;·&nbsp;This Sched: <strong>${l.scheduledQty||0}</strong>
                  </div>
                </div>
                <div style="text-align:right;flex-shrink:0">
                  <div class="imf-mono" style="font-weight:800;font-size:13.5px;color:${indicatorColor}">
                    ${l.dispatchedQty||0} / ${l.scheduledQty}
                  </div>
                  <span class="imf-badge ${statusCls}" style="font-size:9.5px;padding:2px 6px;margin-top:3px">${pct}%</span>
                </div>
              </div>
              <div style="background:var(--line);border-radius:99px;height:4px;margin-top:8px;overflow:hidden">
                <div style="height:100%;border-radius:99px;background:${indicatorColor};width:100%;
                            transform:scaleX(${(Math.min(pct,100) / 100).toFixed(4)});transform-origin:left;
                            transition:transform .3s"></div>
              </div>
            </div>`;
        }).join('')}
      </div>
    </div>`;
}

/* ── Auto-save Draft State ───────────────────────────────────────────── */
function getDraftStorageKey(id) {
  return `imf_so_draft_${id || 'new'}`;
}

function saveSoDraft() {
  const custId   = document.getElementById('po-cust')?.value || '';
  const poNo     = document.getElementById('po-no')?.value || '';
  const poDate   = document.getElementById('po-date')?.value || '';
  const custPoNo = document.getElementById('po-cust-no')?.value || '';
  const month    = document.getElementById('po-month')?.value || '';
  const remarks  = document.getElementById('po-remarks')?.value || '';
  
  poReadLines();
  
  const draft = {
    customerId: custId,
    poNo,
    poDate,
    custPoNo,
    deliveryMonth: month,
    remarks,
    lines: _poLines
  };
  localStorage.setItem(getDraftStorageKey(_poEditId), JSON.stringify(draft));
}

function loadSoDraft(id) {
  const saved = localStorage.getItem(getDraftStorageKey(id));
  if (saved) {
    try {
      return JSON.parse(saved);
    } catch(e) {
      return null;
    }
  }
  return null;
}

function clearSoDraft(id) {
  localStorage.removeItem(getDraftStorageKey(id));
}

/* ── SO modal (create / edit) ────────────────────────────────────────── */
function openPoModal(id) {
  _poEditId = id;
  const p = id ? S_DSP.pos.find(x => x.id === id) : null;
  
  // Try loading auto-saved draft first
  const draft = loadSoDraft(id);
  
  if (draft) {
    _poLines = draft.lines || [];
  } else {
    _poLines = p ? JSON.parse(JSON.stringify(p.lines || [])) : [];
  }
  
  _poLines = _poLines.map(l => ({
    ...l,
    customerPoQty: l.customerPoQty || l.totalScheduleQty || l.scheduledQty || 0,
    totalScheduleQty: l.totalScheduleQty || l.scheduledQty || 0,
    dueType: l.dueType || 'date',
    dueWeek: l.dueWeek || 'Week 1'
  }));

  const cont = document.getElementById('modal-content');
  if (cont) cont.classList.add('modal-wide');

  const custOpts = (S.customers || []).map(c => `<option value="${c.id}" ${(draft?.customerId || p?.customerId)===c.id?'selected':''}>${c.name} (${c.code || '—'})</option>`).join('');

  const poNoVal = draft?.poNo || p?.poNo || '';
  const poDateVal = draft?.poDate || p?.poDate || dateStr();
  const custPoNoVal = draft?.custPoNo || p?.custPoNo || '';
  const monthVal = draft?.deliveryMonth || p?.deliveryMonth || '';
  const remarksVal = draft?.remarks || p?.remarks || '';

  openModal(`
    <div class="modal-handle"></div>
    <div class="modal-title">${id ? 'Edit Sales Order (SO)' : 'New Sales Order (SO)'}</div>

    <div class="row-3" style="margin-bottom:12px">
      <div class="f">
        <label>Customer <span style="color:var(--err)">*</span></label>
        <select id="po-cust" onchange="onPoCustChange();saveSoDraft()" ${id ? 'disabled' : ''} style="font-size:13.5px;font-weight:600">
          <option value="">— Select customer —</option>
          ${custOpts}
        </select>
      </div>
      <div class="f">
        <label>SO Number <span style="color:var(--err)">*</span></label>
        <input type="text" id="po-no" value="${poNoVal}" readonly style="font-size:13.5px;font-weight:700;font-family:var(--mono-v2);background:var(--fill)">
      </div>
      <div class="f">
        <label>SO Date</label>
        <input type="date" id="po-date" onchange="saveSoDraft()" value="${poDateVal}" style="font-size:13.5px;font-weight:600">
      </div>
    </div>
    <div class="row-3" style="margin-bottom:12px">
      <div class="f">
        <label>Customer PO Number <span style="color:var(--err)">*</span></label>
        <input type="text" id="po-cust-no" oninput="saveSoDraft()" value="${custPoNoVal}" placeholder="e.g. PO-2024-001" style="font-size:13.5px;font-weight:600">
      </div>
      <div class="f">
        <label>Delivery Month</label>
        <select id="po-month" onchange="onPoMonthChange();saveSoDraft()" style="font-size:13.5px;font-weight:600">
          ${getMonthDropdownOptions(monthVal)}
        </select>
      </div>
      <div class="f">
        <label>Remarks</label>
        <input type="text" id="po-remarks" oninput="saveSoDraft()" value="${remarksVal}" placeholder="Optional remarks" style="font-size:13.5px">
      </div>
    </div>

    <!-- Live Draft Status & Live Totals -->
    <div style="display:flex;justify-content:space-between;align-items:center;background:var(--fill);padding:10px 14px;border-radius:var(--rs);margin-bottom:14px;font-size:12.5px;border:1px dashed var(--line)">
      <div style="color:var(--txt-muted)">
        <span style="display:inline-block;width:8px;height:8px;background:var(--ok);border-radius:50%;margin-right:6px"></span>
        Auto-saved draft active
      </div>
      <div style="display:flex;gap:16px" id="po-live-totals-summary">
        <!-- Will be dynamically updated by renderPoLines -->
      </div>
    </div>

    <div style="border-top:1px solid var(--line);margin:16px 0 12px;padding-top:16px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
        <div style="font-size:13px;font-weight:800;color:var(--imf-navy)">SO Lines / Parts</div>
        <button class="btn btn-p btn-sm" onclick="poAddLine()"><i class="ti ti-plus"></i> Add New Part</button>
      </div>
      <div id="po-lines-list"></div>
    </div>

    <div id="po-modal-err" style="display:none;color:var(--err);font-size:12px;font-weight:700;margin-bottom:12px"></div>
    <div style="display:flex;gap:10px">
      <button class="btn btn-s" style="flex:1" onclick="closeModal()">Cancel</button>
      <button class="btn btn-p" style="flex:1" onclick="savePo()">
        <i class="ti ti-check"></i> ${id ? 'Save Changes' : 'Create SO'}
      </button>
    </div>
    ${p && isTanmay() ? `
    <button class="btn btn-d w-full mt-8" onclick="deletePO('${p.id}')">
      <i class="ti ti-trash"></i> Delete Sales Order
    </button>` : ''}
  `);

  renderPoLines();
}

function poAddLine() {
  poReadLines();
  _poLines.push({
    lineNo: _poLines.length + 1,
    partId: '',
    partNo: '',
    partName: '',
    customerPoQty: 0,
    totalScheduleQty: 0,
    scheduledQty: 0,
    dueType: 'date',
    dueWeek: 'Week 1',
    dueDate: tomStr(),
    pieceRateINR: 0,
    dispatchedQty: 0
  });
  saveSoDraft();
  renderPoLines();
}

function poRemoveLine(idx) {
  poReadLines();
  _poLines.splice(idx, 1);
  _poLines = _poLines.map((l, i) => ({ ...l, lineNo: i + 1 }));
  saveSoDraft();
  renderPoLines();
}

function poSplitLine(idx) {
  poReadLines();
  const src = _poLines[idx];
  if (!src.partId) { toast('Select a part first before splitting'); return; }
  // Insert new batch right after the last existing batch for this part
  let lastIdx = idx;
  for (let i = idx + 1; i < _poLines.length; i++) {
    if (_poLines[i].partId === src.partId) lastIdx = i;
    else break;
  }
  _poLines.splice(lastIdx + 1, 0, {
    lineNo: 0,
    partId:          src.partId,
    partNo:          src.partNo,
    partName:        src.partName,
    customerPoQty:   src.customerPoQty,
    totalScheduleQty: src.totalScheduleQty,
    scheduledQty:    0,
    dueType:         'week',
    dueWeek:         'Week 1',
    dueDate:         tomStr(),
    pieceRateINR:    src.pieceRateINR,
    dispatchedQty:   0
  });
  _poLines = _poLines.map((l, i) => ({ ...l, lineNo: i + 1 }));
  saveSoDraft();
  renderPoLines();
}

function poReadLines() {
  _poLines = _poLines.map((l, i) => {
    const partId = document.getElementById(`po-part-id-${i}`)?.value || l.partId;
    const part   = S.parts.find(p => p.id === partId);
    const dueType = document.getElementById(`po-due-type-${i}`)?.value || l.dueType || 'date';
    const dueWeek = document.getElementById(`po-week-${i}`)?.value || l.dueWeek || 'Week 1';

    let dueDate = l.dueDate;
    if (dueType === 'week') {
      const deliveryMonth = document.getElementById('po-month')?.value || '';
      dueDate = getDueDateForWeek(deliveryMonth, dueWeek);
    } else {
      dueDate = document.getElementById(`po-due-${i}`)?.value || l.dueDate || '';
    }

    return {
      ...l,
      partId,
      partNo:           part?.no   || part?.partNo   || l.partNo,
      partName:         part?.name || document.getElementById(`po-part-name-${i}`)?.value || l.partName,
      customerPoQty:    parseFloat(document.getElementById(`po-cust-qty-${i}`)?.value  || '0') || 0,
      totalScheduleQty: parseFloat(document.getElementById(`po-total-qty-${i}`)?.value || '0') || 0,
      scheduledQty:     parseFloat(document.getElementById(`po-qty-${i}`)?.value       || '0') || 0,
      dueType,
      dueWeek,
      dueDate,
      pieceRateINR:     parseFloat(document.getElementById(`po-rate-${i}`)?.value      || '0') || 0,
    };
  });
}

function renderPoLines() {
  const el = document.getElementById('po-lines-list');
  if (!el) return;

  // Calculate live summary stats
  const uniquePartsLive = new Set(_poLines.filter(l => l.partId).map(l => l.partId)).size;
  const totalQtyLive = _poLines.reduce((s, l) => s + (l.scheduledQty || 0), 0);
  const totalValLive = _poLines.reduce((s, l) => s + ((l.scheduledQty || 0) * (l.pieceRateINR || 0)), 0);

  const statsEl = document.getElementById('po-live-totals-summary');
  if (statsEl) {
    statsEl.innerHTML = `
      <div>Parts: <strong>${uniquePartsLive}</strong></div>
      <div>Qty: <strong>${totalQtyLive} pcs</strong></div>
      <div>Est. Value: <strong style="color:var(--imf-navy)">${fmtINR(totalValLive)}</strong></div>
    `;
  }

  if (!_poLines.length) {
    el.innerHTML = `<div style="font-size:12px;color:var(--txt-muted);padding:14px;text-align:center;background:var(--fill);border-radius:var(--rs)">No parts added yet. Click 'Add New Part' to begin.</div>`;
    return;
  }

  // Build ordered groups (consecutive lines with the same partId are grouped)
  const groups = [];
  let currentGroup = null;
  _poLines.forEach((l, i) => {
    if (!currentGroup || currentGroup.partId !== l.partId || !l.partId) {
      currentGroup = { partId: l.partId || null, lines: [] };
      groups.push(currentGroup);
    }
    currentGroup.lines.push({ line: l, idx: i });
  });

  // Build discrepancy warnings at group level
  const discrepancies = [];
  groups.forEach(g => {
    if (!g.partId) return;
    const sum      = g.lines.reduce((s, { line }) => s + (line.scheduledQty || 0), 0);
    const accepted = g.lines[0].line.totalScheduleQty || 0;
    if (accepted > 0 && sum !== accepted) {
      const part = S.parts.find(p => p.id === g.partId);
      discrepancies.push(`Delivery batch total (${sum}) ≠ Accepted Qty (${accepted}) for <strong>${part?.name || 'Unknown'}</strong>`);
    }
  });

  const warningHtml = discrepancies.length
    ? `<div style="background:#fffbeb;border:1px solid #fef3c7;color:#b45309;border-radius:var(--rs);padding:10px 14px;margin-bottom:12px;font-size:12.5px;font-weight:600">
        ${discrepancies.map(d => `⚠️ ${d}`).join('<br>')}
       </div>`
    : '';

  const isDesktop = window.innerWidth >= 768;

  // ── DESKTOP GROUPED TABLE ──────────────────────────────────────────
  let listHtml = '';
  if (isDesktop) {
    const dueWeekOpts = (sel) => ['Week 1','Week 2','Week 3','Week 4','Week 5']
      .map(w => `<option value="${w}" ${sel===w?'selected':''}>${w}</option>`).join('');

    const batchRow = (l, i, batchNum, totalBatches) => {
      const dueType = l.dueType || 'date';
      return `
      <tr style="background:var(--fill)">
        <td style="text-align:center;color:var(--acc);font-size:11px;font-weight:700">↳ ${batchNum}</td>
        <td style="padding-left:28px">
          <span style="font-size:11.5px;color:var(--txt-muted);font-style:italic">Batch ${batchNum} of ${totalBatches}</span>
          <input type="hidden" id="po-part-id-${i}" value="${l.partId||''}">
          <input type="hidden" id="po-part-name-${i}" value="${l.partName||''}">
          <input type="hidden" id="po-cust-qty-${i}" value="${l.customerPoQty||0}">
          <input type="hidden" id="po-total-qty-${i}" value="${l.totalScheduleQty||0}">
        </td>
        <td style="text-align:center;color:var(--txt-dim);font-size:11px">&ndash;</td>
        <td style="text-align:center;color:var(--txt-dim);font-size:11px">&ndash;</td>
        <td>
          <input type="number" id="po-qty-${i}" value="${l.scheduledQty}" min="0" onchange="balancePoLines(${i}, 'scheduledQty')" style="font-weight:700">
        </td>
        <td>
          <select id="po-due-type-${i}" onchange="onPoDueTypeChange(${i})">
            <option value="date" ${dueType==='date'?'selected':''}>Specific Date</option>
            <option value="week" ${dueType==='week'?'selected':''}>Due Week</option>
          </select>
        </td>
        <td>
          <div style="display:${dueType==='week'?'none':'block'}" id="po-due-date-wrap-${i}">
            <input type="date" id="po-due-${i}" value="${l.dueDate||''}" style="min-width:120px">
          </div>
          <div style="display:${dueType==='week'?'block':'none'}" id="po-due-week-wrap-${i}">
            <select id="po-week-${i}" onchange="onPoDueWeekChange(${i})">${dueWeekOpts(l.dueWeek)}</select>
          </div>
        </td>
        <td><input type="number" id="po-rate-${i}" value="${l.pieceRateINR||0}" min="0"></td>
        <td style="text-align:center">
          <button onclick="poReadLines();poRemoveLine(${i})" title="Remove batch" style="border:none;background:none;color:var(--err);cursor:pointer;font-size:13px;padding:2px">
            <i class="ti ti-trash"></i>
          </button>
        </td>
      </tr>`;
    };

    const rows = groups.map((g, gi) => {
      const firstIdx  = g.lines[0].idx;
      const firstLine = g.lines[0].line;
      const batchCount = g.lines.length;
      const batchSum  = g.lines.reduce((s, { line }) => s + (line.scheduledQty || 0), 0);
      const accepted  = firstLine.totalScheduleQty || 0;
      const dueType   = firstLine.dueType || 'date';
      const dueWeekOpts2 = (sel) => ['Week 1','Week 2','Week 3','Week 4','Week 5']
        .map(w => `<option value="${w}" ${sel===w?'selected':''}>${w}</option>`).join('');
      const sumOk = accepted > 0 && batchSum === accepted;
      const sumColor = accepted > 0 ? (sumOk ? 'var(--ok)' : 'var(--err)') : 'var(--txt-muted)';

      // Part header row
      const headerRow = `
      <tr style="border-top:${gi>0?'2px solid var(--imf-navy)':'none'};background:var(--sur2)">
        <td style="text-align:center;font-weight:800;color:var(--imf-navy)">${gi + 1}</td>
        <td>
          <input id="po-part-name-${firstIdx}" type="text" value="${firstLine.partName||''}"
            placeholder="Search part..." autocomplete="off"
            oninput="poPartSearch(this,${firstIdx})" onblur="setTimeout(hidePartDrop,150)"
            style="font-size:12.5px;font-weight:700">
          <input type="hidden" id="po-part-id-${firstIdx}" value="${firstLine.partId||''}">
        </td>
        <td>
          <input type="number" id="po-cust-qty-${firstIdx}" value="${firstLine.customerPoQty||0}" min="0"
            onchange="balancePoLines(${firstIdx}, 'customerPoQty')" style="font-weight:700">
        </td>
        <td>
          <div style="position:relative">
            <input type="number" id="po-total-qty-${firstIdx}" value="${accepted}" min="0"
              onchange="balancePoLines(${firstIdx}, 'totalScheduleQty')" style="font-weight:700">
            ${accepted>0?`<div style="font-size:9.5px;text-align:center;margin-top:2px;color:${sumColor};font-weight:700">${batchSum}/${accepted} alloc.</div>`:''}
          </div>
        </td>
        <td>
          <input type="number" id="po-qty-${firstIdx}" value="${firstLine.scheduledQty}" min="0"
            onchange="balancePoLines(${firstIdx}, 'scheduledQty')" style="font-weight:700">
        </td>
        <td>
          <select id="po-due-type-${firstIdx}" onchange="onPoDueTypeChange(${firstIdx})">
            <option value="date" ${dueType==='date'?'selected':''}>Specific Date</option>
            <option value="week" ${dueType==='week'?'selected':''}>Due Week</option>
          </select>
        </td>
        <td>
          <div style="display:${dueType==='week'?'none':'block'}" id="po-due-date-wrap-${firstIdx}">
            <input type="date" id="po-due-${firstIdx}" value="${firstLine.dueDate||''}">
          </div>
          <div style="display:${dueType==='week'?'block':'none'}" id="po-due-week-wrap-${firstIdx}">
            <select id="po-week-${firstIdx}" onchange="onPoDueWeekChange(${firstIdx})">${dueWeekOpts2(firstLine.dueWeek)}</select>
          </div>
        </td>
        <td><input type="number" id="po-rate-${firstIdx}" value="${firstLine.pieceRateINR||0}" min="0"></td>
        <td style="text-align:center;white-space:nowrap">
          <button onclick="poReadLines();poSplitLine(${firstIdx})" title="Add delivery batch for this part"
            style="border:none;background:none;color:var(--acc);cursor:pointer;font-size:13px;padding:2px;margin-right:3px">
            <i class="ti ti-git-fork"></i>
          </button>
          <button onclick="poReadLines();poRemoveLine(${firstIdx})" title="Remove part"
            style="border:none;background:none;color:var(--err);cursor:pointer;font-size:13px;padding:2px">
            <i class="ti ti-trash"></i>
          </button>
        </td>
      </tr>`;

      // Sub-batch rows (all lines after the first in this group)
      const subRows = g.lines.slice(1).map(({ line, idx }) => batchRow(line, idx, g.lines.indexOf(g.lines.find(x=>x.idx===idx)) + 1, batchCount)).join('');
      return headerRow + subRows;
    }).join('');

    listHtml = `
      <div class="so-table-container">
        <table class="so-table">
          <thead>
            <tr>
              <th style="width:44px;text-align:center">#</th>
              <th>Part Name / Number</th>
              <th style="width:110px;text-align:center">PO Qty</th>
              <th style="width:125px;text-align:center">Accepted Qty</th>
              <th style="width:95px;text-align:center">Qty</th>
              <th style="width:120px">Due Type</th>
              <th style="width:150px">Due Date / Week</th>
              <th style="width:95px;text-align:center">Rate (₹/pc)</th>
              <th style="width:60px;text-align:center"><i class="ti ti-git-fork" title="Split"></i></th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <div style="font-size:11px;color:var(--txt-muted);margin-top:6px;padding:0 4px">
        <i class="ti ti-info-circle"></i> Click <i class="ti ti-git-fork"></i> on any part row to add a delivery batch (split qty across weeks/dates).
      </div>`;

  // ── MOBILE GROUPED CARDS ──────────────────────────────────────────
  } else {
    const dueWeekOptsMob = (sel) => ['Week 1','Week 2','Week 3','Week 4','Week 5']
      .map(w => `<option value="${w}" ${sel===w?'selected':''}>${w}</option>`).join('');

    listHtml = groups.map((g, gi) => {
      const firstIdx  = g.lines[0].idx;
      const firstLine = g.lines[0].line;
      const accepted  = firstLine.totalScheduleQty || 0;
      const batchSum  = g.lines.reduce((s, { line }) => s + (line.scheduledQty || 0), 0);
      const sumOk     = accepted > 0 && batchSum === accepted;
      const sumColor  = accepted > 0 ? (sumOk ? 'var(--ok)' : 'var(--err)') : 'var(--txt-muted)';

      const batchCards = g.lines.map(({ line: l, idx: i }, bi) => {
        const dueType = l.dueType || 'date';
        const isFirst = bi === 0;
        return `
        <div style="background:${isFirst?'var(--sur2)':'var(--fill)'};border-radius:var(--rs);padding:12px 14px;border:1px solid var(--line);margin-bottom:8px">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
            <div style="font-size:11px;font-weight:800;color:${isFirst?'var(--imf-navy)':'var(--txt-muted)'};letter-spacing:0.04em">
              ${isFirst ? `PART ${gi+1}` : `↳ BATCH ${bi+1} of ${g.lines.length}`}
            </div>
            <div style="display:flex;gap:6px">
              ${isFirst ? `<button onclick="poReadLines();poSplitLine(${i})" style="border:none;background:var(--acc);color:#fff;border-radius:var(--rxs);padding:4px 8px;font-size:11px;cursor:pointer;font-weight:700">
                <i class="ti ti-git-fork"></i> Split
              </button>` : ''}
              <button onclick="poReadLines();poRemoveLine(${i})" style="border:none;background:none;color:var(--err);cursor:pointer;font-size:14px;padding:2px">
                <i class="ti ti-trash"></i>
              </button>
            </div>
          </div>
          ${isFirst ? `
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:8px">
            <div class="f">
              <label>Part Name</label>
              <input id="po-part-name-${i}" type="text" value="${l.partName||''}"
                placeholder="Search part..." autocomplete="off"
                oninput="poPartSearch(this,${i})" onblur="setTimeout(hidePartDrop,150)" style="font-size:12.5px;font-weight:600">
              <input type="hidden" id="po-part-id-${i}" value="${l.partId||''}">
            </div>
            <div class="f">
              <label>PO Qty</label>
              <input type="number" id="po-cust-qty-${i}" value="${l.customerPoQty||0}" min="0"
                onchange="balancePoLines(${i},'customerPoQty')" style="font-size:12.5px;font-weight:700;text-align:center">
            </div>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:8px">
            <div class="f">
              <label>Accepted Qty <span style="color:${sumColor};font-size:10px">(${batchSum}/${accepted} alloc.)</span></label>
              <input type="number" id="po-total-qty-${i}" value="${accepted}" min="0"
                onchange="balancePoLines(${i},'totalScheduleQty')" style="font-size:12.5px;font-weight:700;text-align:center">
            </div>
            <div class="f">
              <label>Rate (₹/pc)</label>
              <input type="number" id="po-rate-${i}" value="${l.pieceRateINR||0}" min="0"
                style="font-size:12.5px;font-weight:700;text-align:center">
            </div>
          </div>` : `
          <input type="hidden" id="po-part-id-${i}" value="${l.partId||''}">
          <input type="hidden" id="po-part-name-${i}" value="${l.partName||''}">
          <input type="hidden" id="po-cust-qty-${i}" value="${l.customerPoQty||0}">
          <input type="hidden" id="po-total-qty-${i}" value="${l.totalScheduleQty||0}">`}
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:8px">
            <div class="f">
              <label>Qty (This Batch)</label>
              <input type="number" id="po-qty-${i}" value="${l.scheduledQty}" min="0"
                onchange="balancePoLines(${i},'scheduledQty')" style="font-size:12.5px;font-weight:700;text-align:center">
            </div>
            <div class="f">
              <label>Due Type</label>
              <select id="po-due-type-${i}" onchange="onPoDueTypeChange(${i})" style="font-size:12.5px;font-weight:600">
                <option value="date" ${dueType==='date'?'selected':''}>Specific Date</option>
                <option value="week" ${dueType==='week'?'selected':''}>Due Week</option>
              </select>
            </div>
          </div>
          <div class="f" id="po-due-date-wrap-${i}" style="display:${dueType==='week'?'none':'block'}">
            <label>Due Date</label>
            <input type="date" id="po-due-${i}" value="${l.dueDate||''}" style="font-size:12.5px;width:100%">
          </div>
          <div class="f" id="po-due-week-wrap-${i}" style="display:${dueType==='week'?'block':'none'}">
            <label>Due Week</label>
            <select id="po-week-${i}" onchange="onPoDueWeekChange(${i})" style="font-size:12.5px;width:100%">
              ${dueWeekOptsMob(l.dueWeek)}
            </select>
          </div>
          ${isFirst?'':`<div class="f" style="margin-top:4px"><label>Rate (₹/pc)</label>
            <input type="number" id="po-rate-${i}" value="${l.pieceRateINR||0}" min="0" style="font-size:12.5px;font-weight:700;text-align:center">
          </div>`}
        </div>`;
      }).join('');

      return batchCards;
    }).join('<div style="height:4px"></div>');
  }

  el.innerHTML = warningHtml + listHtml;
}

function poPartSearch(inputEl, idx) {
  if (!inputEl.value.trim()) { hidePartDrop(); document.getElementById(`po-part-id-${idx}`).value = ''; return; }
  showPartDrop(inputEl, (p) => {
    document.getElementById(`po-part-id-${idx}`).value = p.id;
    inputEl.value = p.name;
    poReadLines();
    
    _poLines[idx].pieceRateINR = p.rate || p.pieceRateINR || 0;
    
    const existing = _poLines.find((l, i) => l.partId === p.id && i !== idx);
    if (existing) {
      _poLines[idx].customerPoQty = existing.customerPoQty;
      _poLines[idx].totalScheduleQty = existing.totalScheduleQty;
    } else {
      if (!_poLines[idx].totalScheduleQty && _poLines[idx].scheduledQty) {
        _poLines[idx].totalScheduleQty = _poLines[idx].scheduledQty;
      } else if (_poLines[idx].totalScheduleQty && !_poLines[idx].scheduledQty) {
        _poLines[idx].scheduledQty = _poLines[idx].totalScheduleQty;
      }
    }
    
    balancePoLines();
    saveSoDraft();
  });
}

function balancePoLines(editedIdx, editedField) {
  poReadLines();
  
  if (editedIdx !== undefined && editedIdx >= 0 && editedIdx < _poLines.length) {
    const editedLine = _poLines[editedIdx];
    const partId = editedLine.partId;
    if (partId) {
      if (editedField === 'customerPoQty') {
        _poLines.forEach(l => {
          if (l.partId === partId) {
            l.customerPoQty = editedLine.customerPoQty;
          }
        });
      } else if (editedField === 'totalScheduleQty') {
        _poLines.forEach(l => {
          if (l.partId === partId) {
            l.totalScheduleQty = editedLine.totalScheduleQty;
          }
        });
        const group = _poLines.filter(l => l.partId === partId);
        if (group.length === 1 && !group[0].scheduledQty) {
          group[0].scheduledQty = editedLine.totalScheduleQty;
        }
      }
    }
  }

  renderPoLines();
  saveSoDraft();
}

function onPoCustChange() {
  const custId = document.getElementById('po-cust')?.value;
  const inputEl = document.getElementById('po-no');
  if (!inputEl) return;
  if (!custId) {
    inputEl.value = '';
    return;
  }
  
  if (_poEditId) return; // Do not edit if editing existing

  const cust = S.customers.find(c => c.id === custId);
  if (!cust) {
    inputEl.value = '';
    return;
  }

  const count = (S_DSP.pos || []).filter(p => p.customerId === custId).length;
  const seq = String(count + 1).padStart(2, '0');
  const code = (cust.code || 'CUST').toUpperCase();
  inputEl.value = `IMF-${code}-SO${seq}`;
}

function onPoDueTypeChange(i) {
  const type = document.getElementById(`po-due-type-${i}`).value;
  const dtWrap = document.getElementById(`po-due-date-wrap-${i}`);
  const wkWrap = document.getElementById(`po-due-week-wrap-${i}`);
  if (dtWrap) dtWrap.style.display = type === 'week' ? 'none' : 'block';
  if (wkWrap) wkWrap.style.display = type === 'week' ? 'block' : 'none';
  poReadLines();
  saveSoDraft();
}

function onPoDueWeekChange(i) {
  poReadLines();
  saveSoDraft();
}

function onPoMonthChange() {
  poReadLines();
  saveSoDraft();
  renderPoLines();
}

function getDueDateForWeek(deliveryMonth, dueWeek) {
  if (!deliveryMonth || !dueWeek) return '';
  const parts = deliveryMonth.split('-');
  if (parts.length !== 2) return '';
  const year = parseInt(parts[0]);
  const month = parseInt(parts[1]);
  
  if (dueWeek === 'Week 1') return `${deliveryMonth}-07`;
  if (dueWeek === 'Week 2') return `${deliveryMonth}-14`;
  if (dueWeek === 'Week 3') return `${deliveryMonth}-21`;
  if (dueWeek === 'Week 4') return `${deliveryMonth}-28`;
  if (dueWeek === 'Week 5') {
    const lastDay = new Date(year, month, 0).getDate();
    return `${deliveryMonth}-${String(lastDay).padStart(2, '0')}`;
  }
  return '';
}

function fmtLineDue(l, deliveryMonth) {
  if (l.dueType === 'week') {
    return `${l.dueWeek} (${fmtMonth(deliveryMonth)})`;
  }
  return fmtDate(l.dueDate);
}


async function savePo() {
  poReadLines();
  const custId  = document.getElementById('po-cust')?.value;
  const poNo    = (document.getElementById('po-no')?.value || '').trim();
  const custPoNo = (document.getElementById('po-cust-no')?.value || '').trim();
  const poDate  = document.getElementById('po-date')?.value || dateStr();
  const month   = document.getElementById('po-month')?.value || '';
  const remarks = (document.getElementById('po-remarks')?.value || '').trim();
  const errEl   = document.getElementById('po-modal-err');

  if (!custId) { if (errEl) { errEl.textContent = 'Select a customer'; errEl.style.display = ''; } return; }
  if (!poNo)   { if (errEl) { errEl.textContent = 'Enter SO number';   errEl.style.display = ''; } return; }
  if (!custPoNo) { if (errEl) { errEl.textContent = 'Enter Customer PO Number'; errEl.style.display = ''; } return; }
  if (!_poLines.length) { if (errEl) { errEl.textContent = 'Add at least one line'; errEl.style.display = ''; } return; }
  if (_poLines.some(l => !l.partId || !l.scheduledQty)) {
    if (errEl) { errEl.textContent = 'All lines need a part and quantity'; errEl.style.display = ''; } return;
  }

  // Validate that sum of breakup line quantities equals Accepted Qty for each part
  const partSumMap = {};
  const partAcceptedMap = {};
  _poLines.forEach(l => {
    if (l.partId) {
      partSumMap[l.partId] = (partSumMap[l.partId] || 0) + (l.scheduledQty || 0);
      partAcceptedMap[l.partId] = l.totalScheduleQty || 0;
    }
  });

  let discrepancyFound = false;
  Object.entries(partSumMap).forEach(([partId, sum]) => {
    const accepted = partAcceptedMap[partId];
    if (sum !== accepted) {
      const part = S.parts.find(p => p.id === partId);
      if (errEl) {
        errEl.textContent = `Sum of quantities (${sum}) must equal Accepted Qty (${accepted}) for part "${part?.name || 'Unknown'}"`;
        errEl.style.display = '';
      }
      discrepancyFound = true;
    }
  });
  if (discrepancyFound) return;

  const cust = S.customers.find(c => c.id === custId);
  try {
    const now  = serverTS();
    const data = {
      customerId:    custId,
      customerName:  cust?.name || '',
      poNo,
      custPoNo,
      poDate,
      deliveryMonth: month,
      remarks,
      lines: _poLines,
      status: 'open',
      updatedAt: now,
    };
    if (_poEditId) {
      // Preserve dispatchedQty when editing
      const orig = S_DSP.pos.find(p => p.id === _poEditId);
      if (orig) {
        data.lines = _poLines.map((l, i) => {
          const newIndexInPart = _poLines.slice(0, i + 1).filter(nl => nl.partId === l.partId).length - 1;
          const origLinesForPart = (orig.lines || []).filter(ol => ol.partId === l.partId);
          const origLine = origLinesForPart[newIndexInPart];
          return { ...l, dispatchedQty: origLine?.dispatchedQty || 0 };
        });
      }
      await db.collection('pos').doc(_poEditId).update(data);
      await logAudit('EDIT_PO', 'DISPATCH', _poEditId, orig, data);
      toast('SO updated ✓');
    } else {
      await db.collection('pos').add({ ...data, createdBy: S.sess.userId, createdByName: S.sess.name, createdAt: now });
      toast('SO created ✓');
    }
    clearSoDraft(_poEditId);
    closeModal();
    await refreshDSP();
  } catch (e) { toast(friendlyError(e)); }
}

/* ── Export SO function (Voucher Style Print Layout) ── */
function exportSoToPDF(soId) {
  const p = S_DSP.pos.find(x => x.id === soId);
  if (!p) { toast('Sales Order not found'); return; }

  const lines = p.lines || [];
  const uniqueParts = new Set(lines.map(l => l.partId)).size;
  const totalQty = lines.reduce((acc, l) => acc + (l.scheduledQty || 0), 0);
  const totalVal = lines.reduce((acc, l) => acc + ((l.scheduledQty || 0) * (l.pieceRateINR || 0)), 0);

  // Create or reuse temporary container for printing
  let printDiv = document.getElementById('imf-print-section');
  if (!printDiv) {
    printDiv = document.createElement('div');
    printDiv.id = 'imf-print-section';
    document.body.appendChild(printDiv);
  } else {
    printDiv.innerHTML = '';
  }

  // Create style element
  const styleEl = document.createElement('style');
  styleEl.innerHTML = `
    #imf-print-section { display: none !important; }
    @media print {
      body > *:not(#imf-print-section) { display: none !important; }
      #imf-print-section, #imf-print-section * { display: block !important; }
      #imf-print-section { 
        display: block !important; 
        position: absolute; 
        left: 0; 
        top: 0; 
        width: 100%; 
        padding: 20px; 
        background: #ffffff !important; 
        color: #1e293b !important;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        line-height: 1.5;
      }
      .print-header { display: flex; justify-content: space-between; align-items: center; border-bottom: 2px solid #1e2b6b; padding-bottom: 20px; margin-bottom: 20px; }
      .print-title { font-size: 22px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.05em; color: #1e2b6b; margin-top: 5px; }
      .print-meta-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 15px; margin-bottom: 24px; }
      .print-meta-box { background: #f8fafc; padding: 12px; border-radius: 6px; border: 1px solid #e2e8f0; }
      .print-meta-title { font-size: 11px; text-transform: uppercase; color: #64748b; font-weight: 700; margin-bottom: 4px; }
      .print-meta-val { font-size: 14px; font-weight: 700; color: #0f172a; }
      .print-table { width: 100%; border-collapse: collapse; margin-bottom: 24px; }
      .print-table th { background: #1e2b6b !important; color: #ffffff !important; text-align: left; padding: 10px 12px; font-size: 12px; text-transform: uppercase; letter-spacing: 0.03em; border: none; }
      .print-table td { padding: 10px 12px; border-bottom: 1px solid #e2e8f0; font-size: 13px; color: #334155; }
      .print-num { text-align: right; }
      .print-summary-box { display: flex; justify-content: flex-end; gap: 40px; background: #f1f5f9 !important; padding: 15px 20px; border-radius: 6px; font-size: 14px; margin-bottom: 24px; border: 1px solid #cbd5e1; }
      .print-notes { background: #fffbeb !important; border: 1px solid #fef3c7; color: #713f12 !important; padding: 15px; border-radius: 6px; font-size: 12.5px; }
      .print-footer { text-align: center; margin-top: 40px; font-size: 11px; color: #94a3b8; border-top: 1px solid #e2e8f0; padding-top: 20px; }
    }
  `;
  printDiv.appendChild(styleEl);

  // Print Header
  const headerDiv = document.createElement('div');
  headerDiv.className = 'print-header';
  
  const logoWrapper = document.createElement('div');
  if (typeof IMF_LOGO_BASE64 !== 'undefined') {
    const logoImg = document.createElement('img');
    logoImg.style.maxHeight = '48px';
    logoImg.style.width = 'auto';
    logoImg.alt = 'Logo';
    // Programmatically setting src avoids parsing delay of 1.5MB HTML string
    logoImg.src = 'data:image/png;base64,' + IMF_LOGO_BASE64;
    logoWrapper.appendChild(logoImg);
  } else {
    const logoText = document.createElement('div');
    logoText.style.fontWeight = '800';
    logoText.style.fontSize = '20px';
    logoText.style.color = '#1e2b6b';
    logoText.textContent = 'INDO META FORGE';
    logoWrapper.appendChild(logoText);
  }

  const titleDiv = document.createElement('div');
  titleDiv.className = 'print-title';
  titleDiv.textContent = 'Sales Order Voucher';
  logoWrapper.appendChild(titleDiv);
  headerDiv.appendChild(logoWrapper);

  const metaRight = document.createElement('div');
  metaRight.style.textAlign = 'right';
  metaRight.innerHTML = `
    <div style="font-size: 18px; font-weight: 800; color: #1e2b6b; font-family: monospace;">${p.poNo}</div>
    <div style="font-size: 12px; color: #64748b; margin-top: 2px;">Date: ${fmtDate(p.poDate)}</div>
  `;
  headerDiv.appendChild(metaRight);
  printDiv.appendChild(headerDiv);

  // Voucher Info Content (Meta, Table, Notes)
  const contentDiv = document.createElement('div');
  contentDiv.innerHTML = `
    <div class="print-meta-grid">
      <div class="print-meta-box">
        <div class="print-meta-title">Customer Details</div>
        <div class="print-meta-val">${p.customerName || '—'}</div>
        ${p.custPoNo ? `<div style="font-size: 12px; color: #475569; margin-top: 4px;">Customer PO Ref: <strong style="color:#1e2b6b">${p.custPoNo}</strong></div>` : ''}
      </div>
      <div class="print-meta-box">
        <div class="print-meta-title">Delivery Schedule</div>
        <div class="print-meta-val">Month: ${fmtMonth(p.deliveryMonth) || '—'}</div>
        ${p.remarks ? `<div style="font-size: 12px; color: #475569; margin-top: 4px;">Remarks: ${p.remarks}</div>` : ''}
      </div>
    </div>

    <table class="print-table">
      <thead>
        <tr>
          <th style="width: 40px">#</th>
          <th>Part Name / Number</th>
          <th class="print-num">PO Qty</th>
          <th class="print-num">Accepted Qty</th>
          <th class="print-num">This Schedule Qty</th>
          <th class="print-num">Rate (₹)</th>
          <th class="print-num">Subtotal (₹)</th>
        </tr>
      </thead>
      <tbody>
        ${lines.map((l, idx) => `
          <tr>
            <td>${idx + 1}</td>
            <td><strong>${l.partName || '—'}</strong><br><span style="font-size:11px; color:#64748b">Due: ${fmtLineDue(l, p.deliveryMonth)}</span></td>
            <td class="print-num">${l.customerPoQty || 0}</td>
            <td class="print-num">${l.totalScheduleQty || 0}</td>
            <td class="print-num">${l.scheduledQty || 0}</td>
            <td class="print-num">${(l.pieceRateINR || 0).toFixed(2)}</td>
            <td class="print-num"><strong>${((l.scheduledQty || 0) * (l.pieceRateINR || 0)).toFixed(2)}</strong></td>
          </tr>
        `).join('')}
      </tbody>
    </table>

    <div class="print-summary-box">
      <div>Unique Parts: <strong>${uniqueParts}</strong></div>
      <div>Total Quantity: <strong>${totalQty} pcs</strong></div>
      <div>Total Estimated Value: <strong style="color: #1e2b6b; font-size: 16px">${fmtINR(totalVal)}</strong></div>
    </div>

    <div class="print-notes">
      <strong>Standard Notes & Terms:</strong>
      <ul style="margin: 8px 0 0 16px; padding: 0;">
        <li>All taxes, custom duties, and GST will be applicable additionally as per standard rates at the time of invoicing/dispatch.</li>
        <li>Quantities scheduled above represent the accepted manufacturing plan for delivery within the month of ${fmtMonth(p.deliveryMonth) || 'specified delivery month'}.</li>
        <li>Any deviation in dispatch schedules must be reported and aligned with production heads at least 3 business days in advance.</li>
      </ul>
    </div>

    <div class="print-footer">
      Generated automatically via IMF PROTRACK System &middot; Confirmed and locked document.
    </div>
  `;
  printDiv.appendChild(contentDiv);

  // Set document title temporarily to ensure correct downloaded file naming
  const originalTitle = document.title;
  document.title = `Sales Order - ${p.poNo}`;

  // Trigger print with 50ms delay to let Safari finish layout calculation instantly
  setTimeout(() => {
    window.print();
    document.title = originalTitle;
  }, 50);
}

/* ── Export All Sales Orders (SCM layout matching) ── */
async function exportAllSos(format) {
  if (!S_DSP.pos.length) { toast('No Sales Orders available to export.'); return; }

  // Flatten SOs and their lines
  const rows = [];
  S_DSP.pos.forEach(p => {
    (p.lines || []).forEach(l => {
      rows.push({
        soNo:          p.poNo || '—',
        custPoNo:      p.custPoNo || '—',
        customer:      p.customerName || '—',
        deliveryMonth: fmtMonth(p.deliveryMonth) || '—',
        part:          l.partName || '—',
        customerPoQty: l.customerPoQty || 0,
        totalScheduleQty: l.totalScheduleQty || 0,
        scheduledQty:  l.scheduledQty || 0,
        dispatchedQty: l.dispatchedQty || 0,
        due:           fmtLineDue(l, p.deliveryMonth),
        rate:          l.pieceRateINR || 0,
        value:         (l.scheduledQty || 0) * (l.pieceRateINR || 0),
        status:        (p.status || '').toUpperCase()
      });
    });
  });

  const totals = {
    soNo:             `Total: ${S_DSP.pos.length} SOs`,
    customerPoQty:    rows.reduce((s, r) => s + r.customerPoQty, 0),
    totalScheduleQty: rows.reduce((s, r) => s + r.totalScheduleQty, 0),
    scheduledQty:     rows.reduce((s, r) => s + r.scheduledQty, 0),
    dispatchedQty:    rows.reduce((s, r) => s + r.dispatchedQty, 0),
    value:            rows.reduce((s, r) => s + r.value, 0)
  };

  const opts = {
    filename: `IMF_Sales_Orders_Report_${dateStr()}.${format === 'pdf' ? 'pdf' : 'xlsx'}`,
    reportTitle: 'Sales Orders Master Report',
    filterSummary: `Generated: ${fmtDate(dateStr())} · Active Rows: ${rows.length}`,
    columns: [
      { header: 'SO Number', key: 'soNo', width: 16 },
      { header: 'Cust PO Ref', key: 'custPoNo', width: 16 },
      { header: 'Customer', key: 'customer', width: 25 },
      { header: 'Deliv. Month', key: 'deliveryMonth', width: 14 },
      { header: 'Part Name', key: 'part', width: 22 },
      { header: 'PO Qty', key: 'customerPoQty', width: 12, align: 'right', numFmt: '#,##0' },
      { header: 'Accepted Qty', key: 'totalScheduleQty', width: 14, align: 'right', numFmt: '#,##0' },
      { header: 'Sched Qty', key: 'scheduledQty', width: 12, align: 'right', numFmt: '#,##0' },
      { header: 'Disp Qty', key: 'dispatchedQty', width: 12, align: 'right', numFmt: '#,##0' },
      { header: 'Due Date/Week', key: 'due', width: 18 },
      { header: 'Rate (₹)', key: 'rate', width: 12, align: 'right', numFmt: '#,##0.00' },
      { header: 'Value (₹)', key: 'value', width: 15, align: 'right', numFmt: '#,##0.00' },
      { header: 'Status', key: 'status', width: 12 }
    ],
    rows,
    totals
  };

  if (format === 'pdf') {
    await exportToPdf(opts);
  } else {
    await exportToExcel(opts);
  }
}

/* ═══════════════════════════════════════════════════════════════════
   TAB: DISPATCH (session)
   ═══════════════════════════════════════════════════════════════════ */
function renderDispatch() {
  const el = document.getElementById('tab-body');
  if (!el) return;

  const canDispatch = canDo('dispatch') || S.sess?.role === 'admin';
  if (!canDispatch) {
    el.innerHTML = `
      <div class="imf-empty" style="padding:40px 24px">
        <div class="ic"><i class="ti ti-lock"></i></div>
        <h3>Access Restricted</h3>
        <p>Dispatch role required.</p>
      </div>`;
    return;
  }

  el.innerHTML = `
    <!-- Header card -->
    <div class="imf-card" style="margin-bottom:16px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">
        <div style="font-size:14px;font-weight:800;color:var(--imf-navy)">Dispatch Session Header</div>
        ${_dispHeaderLocked
          ? `<button class="btn btn-s btn-sm" style="padding:4px 8px;font-size:12px" onclick="clearDispatchHeader()"><i class="ti ti-lock-open"></i> Unlock</button>`
          : ''}
      </div>

      ${_dispHeaderLocked ? renderDispatchHeaderLocked() : renderDispatchHeaderForm()}
    </div>

    ${_dispHeaderLocked ? renderDispatchRows() : ''}`;
}

function renderDispatchHeaderForm() {
  const openPOs   = S_DSP.pos.filter(p => p.status === 'open');
  const custOpts  = [...new Set(openPOs.map(p => p.customerId))].map(cid => {
    // Always resolve the canonical long name from the customer master —
    // never trust the customerName snapshot on the PO, which can drift.
    const custName = S.customers.find(c => c.id === cid)?.name || cid;
    return `<option value="${cid}" ${_dispHeader.customerId===cid?'selected':''}>${custName}</option>`;
  }).join('');

  const filteredPOs = _dispHeader.customerId
    ? openPOs.filter(p => p.customerId === _dispHeader.customerId)
    : openPOs;
  const poOpts = filteredPOs.map(p => `<option value="${p.id}" ${_dispHeader.poId===p.id?'selected':''}>${p.poNo} ${p.custPoNo ? `(PO: ${p.custPoNo})` : ''}</option>`).join('');

  const partOpts = selPO
    ? (selPO.lines || []).map(l => `<option value="${l.partId}" data-line="${l.lineNo}" data-rate="${l.pieceRateINR||0}" ${_dispHeader.partId===l.partId && _dispHeader.lineNo===l.lineNo?'selected':''}>${l.partName} (Due: ${fmtLineDue(l, selPO.deliveryMonth)}, Qty: ${l.scheduledQty})</option>`).join('')
    : '';

  // Stream is never freely chosen — it's auto-detected from the customer's
  // allowed streams in Masters. Most customers have exactly one allowed
  // stream, so it's locked text. If a customer is genuinely set up for more
  // than one, the picker is restricted to only those (never the full list).
  const selCust    = S.customers.find(c => c.id === _dispHeader.customerId);
  const allowed    = (selCust?.allowedStreams || []).map(s => s.toLowerCase());
  const allowedStreamDefs = STREAMS.filter(s => allowed.includes(s.key));
  let streamField;
  if (!selCust) {
    streamField = `
      <div class="f">
        <label>Stream</label>
        <div style="padding:10px 13px;background:var(--fill);border:1.5px solid var(--bdr-mid);border-radius:var(--rs);font-size:13.5px;color:var(--txt-muted)">
          Select a customer first
        </div>
      </div>`;
  } else if (allowedStreamDefs.length <= 1) {
    const lbl = allowedStreamDefs[0]?.label || '—';
    streamField = `
      <div class="f">
        <label>Stream <span style="color:var(--err)">*</span></label>
        <div style="padding:10px 13px;background:var(--fill);border:1.5px solid var(--bdr-mid);border-radius:var(--rs);font-size:13.5px;font-weight:700">
          ${lbl} <span style="font-weight:400;color:var(--txt-muted);font-size:11px">— auto-set from customer</span>
        </div>
        <input type="hidden" id="dh-stream" value="${allowedStreamDefs[0]?.key || ''}">
      </div>`;
  } else {
    const streamOpts = allowedStreamDefs.map(s => `<option value="${s.key}" ${_dispHeader.stream===s.key?'selected':''}>${s.label}</option>`).join('');
    streamField = `
      <div class="f">
        <label>Stream <span style="color:var(--err)">*</span></label>
        <select id="dh-stream" style="font-size:13.5px">${streamOpts}</select>
        <div style="font-size:11px;color:var(--txt-muted);margin-top:4px">This customer is set up for more than one stream — restricted to its allowed streams only.</div>
      </div>`;
  }

  return `
    <div class="f">
      <label>Customer <span style="color:var(--err)">*</span></label>
      <select id="dh-cust" onchange="dspOnCustChange()" style="font-size:13.5px;font-weight:600">
        <option value="">— Select customer —</option>
        ${custOpts}
      </select>
    </div>
    <div class="row-2">
      <div class="f">
        <label>PO <span style="color:var(--err)">*</span></label>
        <select id="dh-po" onchange="dspOnPoChange()" style="font-size:13.5px;font-weight:600">
          <option value="">— Select PO —</option>
          ${poOpts}
        </select>
      </div>
      <div class="f">
        <label>Part <span style="color:var(--err)">*</span></label>
        <select id="dh-part" onchange="dspOnPartChange()" style="font-size:13.5px;font-weight:600">
          <option value="">— Select part —</option>
          ${partOpts}
        </select>
      </div>
    </div>
    <div class="row-2">
      ${streamField}
      <div class="f">
        <label>Date <span style="color:var(--err)">*</span></label>
        <input type="date" id="dh-date" value="${_dispHeader.date || dateStr()}" style="font-size:13.5px;font-weight:600">
      </div>
    </div>
    <div id="dh-err" style="display:none;color:var(--err);font-size:12px;font-weight:700;margin-bottom:8px"></div>
    <button class="btn btn-p" style="width:100%;padding:12px;font-size:14.5px" onclick="lockDispatchHeader()">
      <i class="ti ti-lock"></i> Lock Header &amp; Start Scanning
    </button>`;
}

function dspOnCustChange() {
  _dispHeader.customerId = document.getElementById('dh-cust')?.value || '';
  const cust = S.customers.find(c => c.id === _dispHeader.customerId);
  _dispHeader.customerName = cust?.name || '';
  _dispHeader.poId = '';
  _dispHeader.partId = '';
  // Auto-detect stream from the customer's allowed streams (never user-chosen).
  const allowed = (cust?.allowedStreams || []).map(s => s.toLowerCase());
  const allowedStreamDefs = STREAMS.filter(s => allowed.includes(s.key));
  _dispHeader.stream = allowedStreamDefs.length === 1 ? allowedStreamDefs[0].key : (allowedStreamDefs[0]?.key || '');
  renderDispatch();
}

function dspOnPoChange() {
  _dispHeader.poId = document.getElementById('dh-po')?.value || '';
  const po = S_DSP.pos.find(p => p.id === _dispHeader.poId);
  _dispHeader.poNo = po?.poNo || '';
  _dispHeader.custPoNo = po?.custPoNo || '';
  _dispHeader.partId = '';
  renderDispatch();
}

function dspOnPartChange() {
  const partEl  = document.getElementById('dh-part');
  _dispHeader.partId = partEl?.value || '';
  const selOpt  = partEl?.options[partEl.selectedIndex];
  const lineNo  = parseInt(selOpt?.dataset.line || '0') || 0;
  _dispHeader.lineNo = lineNo;
  const po      = S_DSP.pos.find(p => p.id === _dispHeader.poId);
  const line    = (po?.lines || []).find(l => l.partId === _dispHeader.partId && l.lineNo === lineNo);
  _dispHeader.partName      = line?.partName || S.parts.find(p => p.id === _dispHeader.partId)?.name || '';
  _dispHeader.partNo        = line?.partNo   || S.parts.find(p => p.id === _dispHeader.partId)?.no   || '';
  _dispHeader.pieceRateINR  = parseFloat(selOpt?.dataset.rate || '0') || 0;
}

function lockDispatchHeader() {
  // Read current form values
  _dispHeader.customerId    = document.getElementById('dh-cust')?.value   || _dispHeader.customerId;
  _dispHeader.poId          = document.getElementById('dh-po')?.value     || _dispHeader.poId;
  const partEl              = document.getElementById('dh-part');
  _dispHeader.partId        = partEl?.value   || _dispHeader.partId;
  const selOpt              = partEl?.options[partEl?.selectedIndex || 0];
  _dispHeader.lineNo        = parseInt(selOpt?.dataset.line || '0') || 0;
  _dispHeader.stream        = document.getElementById('dh-stream')?.value || _dispHeader.stream;
  _dispHeader.date          = document.getElementById('dh-date')?.value   || dateStr();

  const cust = S.customers.find(c => c.id === _dispHeader.customerId);
  _dispHeader.customerName  = cust?.name || '';
  const po = S_DSP.pos.find(p => p.id === _dispHeader.poId);
  _dispHeader.poNo = po?.poNo || '';
  _dispHeader.custPoNo = po?.custPoNo || '';
  const line = (po?.lines || []).find(l => l.partId === _dispHeader.partId && l.lineNo === _dispHeader.lineNo);
  _dispHeader.partName = line?.partName || '';
  _dispHeader.partNo   = line?.partNo   || '';
  _dispHeader.pieceRateINR = line?.pieceRateINR || 0;

  const errEl = document.getElementById('dh-err');
  if (!_dispHeader.customerId) { if (errEl) { errEl.textContent = 'Select a customer'; errEl.style.display = ''; } return; }
  if (!_dispHeader.poId)       { if (errEl) { errEl.textContent = 'Select an SO';       errEl.style.display = ''; } return; }
  if (!_dispHeader.partId)     { if (errEl) { errEl.textContent = 'Select a part';     errEl.style.display = ''; } return; }
  if (!_dispHeader.stream)     { if (errEl) { errEl.textContent = `${cust?.name || 'This customer'} has no allowed stream set in Masters — add one before dispatching.`; errEl.style.display = ''; } return; }

  _dispHeaderLocked = true;
  _dispRows = [];
  renderDispatch();
}

function clearDispatchHeader() {
  openModal(`
    <div class="modal-handle"></div>
    <div class="modal-title">Unlock Dispatch Header?</div>
    <div style="font-size:13px;margin-bottom:16px;color:var(--txt-muted)">
      All scanned rows in this session will be lost. The header can then be changed.
    </div>
    <div style="display:flex;gap:8px">
      <button class="btn btn-s" style="flex:1" onclick="closeModal()">Cancel</button>
      <button class="btn btn-d" style="flex:1" onclick="closeModal();doClearDispatchHeader()">Unlock &amp; Clear</button>
    </div>`);
}

function doClearDispatchHeader() {
  _dispHeaderLocked = false;
  _dispRows = [];
  _dispHeader = { customerId:'', customerName:'', poId:'', poNo:'', custPoNo:'', partId:'', partNo:'', partName:'', lineNo:0, stream:'oem', date:'', pieceRateINR:0 };
  renderDispatch();
}

function renderDispatchHeaderLocked() {
  const streamLbl = STREAMS.find(s => s.key === _dispHeader.stream)?.label || _dispHeader.stream;
  return `
    <div class="kv-list">
      <div class="kv-row"><span class="kv-key">Customer</span><span class="kv-val" style="font-weight:700">${_dispHeader.customerName}</span></div>
      <div class="kv-row"><span class="kv-key">SO Number</span><span class="kv-val imf-mono" style="font-family:var(--mono-v2);font-weight:700;color:var(--imf-navy)">${_dispHeader.poNo}</span></div>
      ${_dispHeader.custPoNo ? `<div class="kv-row"><span class="kv-key">Customer PO</span><span class="kv-val" style="font-weight:700">${_dispHeader.custPoNo}</span></div>` : ''}
      <div class="kv-row"><span class="kv-key">Part</span><span class="kv-val" style="font-weight:700">${_dispHeader.partName}</span></div>
      <div class="kv-row"><span class="kv-key">Stream</span><span class="kv-val" style="font-weight:700">${streamLbl}</span></div>
      <div class="kv-row"><span class="kv-key">Date</span><span class="kv-val imf-mono" style="font-family:var(--mono-v2);font-weight:700">${fmtDate(_dispHeader.date)}</span></div>
      <div class="kv-row"><span class="kv-key">Rate</span><span class="kv-val imf-mono" style="font-family:var(--mono-v2);font-weight:700;color:var(--ok)">${fmtINR(_dispHeader.pieceRateINR)}/pc</span></div>
    </div>`;
}

function renderDispatchRows() {
  const totalQty = _dispRows.reduce((s, r) => s + (r.qty || 0), 0);
  const totalVal = totalQty * (_dispHeader.pieceRateINR || 0);

  return `
    <!-- Scan area -->
    <div class="imf-card" style="margin-bottom:12px">
      <div style="font-size:13.5px;font-weight:800;margin-bottom:12px;display:flex;align-items:center;gap:8px;color:var(--imf-navy)">
        <i class="ti ti-scan" style="color:var(--acc);font-size:16px"></i> Scan TAG to Add Row
      </div>
      <button class="qr-scan-btn" onclick="openQrScanner(dspOnScan, 'Scan TAG')" style="width:100%;padding:14px;font-size:14.5px;font-weight:700;border-radius:var(--rs);display:flex;align-items:center;justify-content:center;gap:8px"><i class="ti ti-qrcode"></i> Scan TAG</button>
      <div id="dsp-scan-err" style="display:none;margin-top:10px;background:var(--err-bg);border:1px solid var(--err-bdr);
                                    border-radius:var(--rxs);padding:10px 14px;font-size:12px;font-weight:700;color:var(--err)"></div>
    </div>

    <!-- Rows list -->
    ${_dispRows.length ? `
      <div style="font-size:11px;font-weight:700;color:var(--txt-muted);letter-spacing:.06em;margin-bottom:8px;text-transform:uppercase">
        ROWS (${_dispRows.length}) · <span style="font-family:var(--mono-v2)">${totalQty}</span> pcs · <span style="font-family:var(--mono-v2)">${fmtINR(totalVal)}</span>
      </div>
      <div style="display:flex;flex-direction:column;gap:8px;margin-bottom:12px">
        ${_dispRows.map((row, i) => dspRow(row, i)).join('')}
      </div>

      <button class="btn btn-p" style="width:100%;margin-top:8px;font-size:15px;padding:14px;font-weight:700" onclick="dspConfirmFinalize()">
        <i class="ti ti-truck"></i> Finalise Dispatch (${totalQty} pcs)
      </button>` : `
      <div class="imf-empty" style="padding:32px 24px">
        <div class="ic"><i class="ti ti-scan"></i></div>
        <h3>No rows scanned yet</h3>
        <p>Scan a QC-cleared TAG to add it to this dispatch session.</p>
      </div>`}`;
}

function dspOnScan(tagId) {
  dspScanTag(tagId);
}

async function dspScanTag(tagId) {
  const el    = document.getElementById('dsp-scan-input');
  tagId = (tagId || el?.value || '').trim().toUpperCase();
  if (!tagId) { toast('Enter or scan a TAG UID'); return; }

  const errEl = document.getElementById('dsp-scan-err');
  if (errEl) errEl.style.display = 'none';

  // Prevent duplicates
  if (_dispRows.find(r => r.tagId === tagId)) {
    if (errEl) { errEl.textContent = `TAG ${tagId} already added to this session`; errEl.style.display = ''; } return;
  }

  try {
    const card = await fetchRouteCard(tagId);
    if (!card) {
      if (errEl) { errEl.textContent = `TAG ${tagId} not found`; errEl.style.display = ''; } return;
    }

    const streamKey = `qty_${_dispHeader.stream}`;
    const streamQty = card[streamKey] || 0;

    if (card.status !== 'qc_cleared') {
      if (errEl) { errEl.textContent = `TAG ${tagId} status is "${card.status}" — must be qc_cleared`; errEl.style.display = ''; } return;
    }
    if (card.partId !== _dispHeader.partId) {
      if (errEl) { errEl.textContent = `Part mismatch — TAG belongs to "${card.partName}", expected "${_dispHeader.partName}"`; errEl.style.display = ''; } return;
    }
    if (streamQty <= 0) {
      const lbl = STREAMS.find(s => s.key === _dispHeader.stream)?.label || _dispHeader.stream;
      if (errEl) { errEl.textContent = `TAG has no ${lbl} qty available (${streamKey} = 0)`; errEl.style.display = ''; } return;
    }

    _dispRows.push({
      tagId,
      qty:       streamQty,
      invoiceNo: '',
      vehicle:   '',
      batchCode: card.batchCode  || '',
      heatCode:  card.heatCode   || '',
      verified:  true,
      tagData:   card,
    });

    if (el) el.value = '';
    renderDispatch();
  } catch (e) {
    if (errEl) { errEl.textContent = 'Error: ' + friendlyError(e); errEl.style.display = ''; }
  }
}

function dspRow(row, idx) {
  const maxQty = row.tagData ? (row.tagData[`qty_${_dispHeader.stream}`] || 0) : row.qty;
  return `
    <div class="imf-card" style="border: 1px solid var(--ok-bdr); background: var(--ok-bg)">
      <div class="imf-card-top" style="margin-bottom:8px">
        <span class="imf-mono" style="font-family:var(--mono-v2);font-weight:800;font-size:14.5px;color:var(--imf-navy)">${row.tagId}</span>
        <span class="imf-badge st-qc_cleared" style="margin-left:8px"><i class="ti ti-circle-check"></i> Scanned</span>
        <div class="grow"></div>
        <button onclick="dspRemoveRow(${idx})" class="btn btn-s btn-sm" style="border:none;background:none;color:var(--err);cursor:pointer;padding:4px">
          <i class="ti ti-trash"></i>
        </button>
      </div>
      <div class="imf-card-meta" style="margin-bottom:12px">
        Batch: <strong class="imf-mono" style="font-family:var(--mono-v2);color:var(--txt)">${row.batchCode || '—'}</strong> · Heat: <strong class="imf-mono" style="font-family:var(--mono-v2);color:var(--txt)">${row.heatCode || '—'}</strong> · Available: <strong class="imf-mono" style="font-family:var(--mono-v2);color:var(--txt)">${maxQty}</strong>
      </div>
      <div class="row-3">
        <div class="f" style="margin-bottom:0">
          <label style="font-size:11px;color:var(--txt-muted)">Qty <span style="color:var(--err)">*</span></label>
          <input type="number" id="dr-qty-${idx}" value="${row.qty}" min="1" max="${maxQty}"
            oninput="dspReadRow(${idx})" style="font-family:var(--mono-v2);font-weight:700;text-align:center">
        </div>
        <div class="f" style="margin-bottom:0">
          <label style="font-size:11px;color:var(--txt-muted)">Invoice No</label>
          <input type="text" id="dr-inv-${idx}" value="${row.invoiceNo}"
            oninput="dspReadRow(${idx})" placeholder="INV-001" style="font-family:var(--mono-v2);font-weight:600">
        </div>
        <div class="f" style="margin-bottom:0">
          <label style="font-size:11px;color:var(--txt-muted)">Vehicle No</label>
          <input type="text" id="dr-veh-${idx}" value="${row.vehicle}"
            oninput="dspReadRow(${idx})" placeholder="MH-12-AB-1234" style="font-family:var(--mono-v2);font-weight:600">
        </div>
      </div>
    </div>`;
}

function dspReadRow(idx) {
  if (!_dispRows[idx]) return;
  _dispRows[idx].qty       = parseFloat(document.getElementById(`dr-qty-${idx}`)?.value || '0') || 0;
  _dispRows[idx].invoiceNo = (document.getElementById(`dr-inv-${idx}`)?.value || '').trim();
  _dispRows[idx].vehicle   = (document.getElementById(`dr-veh-${idx}`)?.value || '').trim();
}

function dspRemoveRow(idx) {
  _dispRows.splice(idx, 1);
  renderDispatch();
}

/* ── Finalize dispatch (runTransaction) ──────────────────────────────── */
function dspConfirmFinalize() {
  // Sync all row values before confirming
  _dispRows.forEach((r, i) => dspReadRow(i));

  const totalQty = _dispRows.reduce((s, r) => s + (r.qty || 0), 0);
  const totalVal = totalQty * (_dispHeader.pieceRateINR || 0);
  const streamLbl = STREAMS.find(s => s.key === _dispHeader.stream)?.label || _dispHeader.stream;

  // Validate
  for (const r of _dispRows) {
    if (!r.invoiceNo) {
      toast('Invoice Number is mandatory for all dispatch rows'); return;
    }
    const max = r.tagData ? (r.tagData[`qty_${_dispHeader.stream}`] || 0) : r.qty;
    if (!r.qty || r.qty <= 0 || r.qty > max) {
      toast(`Invalid qty for TAG ${r.tagId} — must be 1–${max}`); return;
    }
  }

  openModal(`
    <div class="modal-handle"></div>
    <div class="modal-title">Confirm Dispatch</div>
    <div class="kv-list" style="margin-bottom:14px">
      <div class="kv-row"><span class="kv-key">Customer</span><span class="kv-val">${_dispHeader.customerName}</span></div>
      <div class="kv-row"><span class="kv-key">PO</span><span class="kv-val">${_dispHeader.poNo}</span></div>
      <div class="kv-row"><span class="kv-key">Part</span><span class="kv-val">${_dispHeader.partName}</span></div>
      <div class="kv-row"><span class="kv-key">Stream</span><span class="kv-val">${streamLbl}</span></div>
      <div class="kv-row"><span class="kv-key">TAGs</span><span class="kv-val">${_dispRows.length}</span></div>
      <div class="kv-row"><span class="kv-key">Total Qty</span><span class="kv-val" style="font-size:18px;font-weight:900">${totalQty} pcs</span></div>
      <div class="kv-row"><span class="kv-key">Est. Value</span><span class="kv-val">${fmtINR(totalVal)}</span></div>
    </div>
    <div class="ebox" style="font-weight:700;margin-bottom:14px">
      <i class="ti ti-alert-triangle"></i> <div>Route card sub-balances will be permanently decremented. This cannot be undone.</div>
    </div>
    <div style="display:flex;gap:8px">
      <button class="btn btn-s" style="flex:1" onclick="closeModal()">Cancel</button>
      <button class="btn btn-ok" style="flex:1" onclick="closeModal();finalizeDispatch()">
        <i class="ti ti-truck"></i> Dispatch
      </button>
    </div>`);
}

async function finalizeDispatch() {
  if (!navigator.onLine) { toast('Offline — dispatch requires a live connection'); return; }

  _dispRows.forEach((r, i) => dspReadRow(i));
  const streamKey = `qty_${_dispHeader.stream}`;

  try {
    const dispRef = db.collection('dispatches').doc();
    await db.runTransaction(async (t) => {
      // Phase 1: Read all route cards + PO
      const cardRefs = _dispRows.map(r => db.collection('routeCards').doc(r.tagId));
      const poRef    = db.collection('pos').doc(_dispHeader.poId);
      const cardDocs = await Promise.all(cardRefs.map(ref => t.get(ref)));
      const poDoc    = await t.get(poRef);

      // Phase 2: Validate
      for (let i = 0; i < _dispRows.length; i++) {
        const row  = _dispRows[i];
        const card = cardDocs[i].data();
        if (!cardDocs[i].exists) throw new Error(`TAG ${row.tagId} not found`);
        if (card.status !== 'qc_cleared') throw new Error(`TAG ${row.tagId} is no longer QC cleared (status: ${card.status})`);
        if (card.partId !== _dispHeader.partId) throw new Error(`TAG ${row.tagId} part mismatch`);
        if ((card[streamKey] || 0) < row.qty) throw new Error(`TAG ${row.tagId}: insufficient ${_dispHeader.stream} qty`);
      }

      // Phase 3: Write route card updates
      let totalQty = 0;
      let totalVal = 0;
      const rows   = [];

      for (let i = 0; i < _dispRows.length; i++) {
        const row      = _dispRows[i];
        const card     = cardDocs[i].data();
        const newSQty  = (card[streamKey] || 0) - row.qty;
        const allZero  = (['qty_oem','qty_spares','qty_market']
          .map(k => k === streamKey ? newSQty : (card[k] || 0))
          .reduce((s, v) => s + v, 0)) === 0;

        t.update(cardRefs[i], {
          [streamKey]: firebase.firestore.FieldValue.increment(-row.qty),
          ...(allZero ? { status: 'dispatched' } : {}),
          updatedAt: serverTS(),
        });

        const lineVal = row.qty * (_dispHeader.pieceRateINR || 0);
        totalQty += row.qty;
        totalVal += lineVal;
        rows.push({ tagId: row.tagId, batchCode: row.batchCode, heatCode: row.heatCode, invoiceNo: row.invoiceNo, vehicle: row.vehicle, qty: row.qty, lineValue: lineVal });
      }

      // Create dispatch doc
      t.set(dispRef, {
        customerId:    _dispHeader.customerId,
        customerName:  _dispHeader.customerName,
        poId:          _dispHeader.poId,
        poNo:          _dispHeader.poNo,
        custPoNo:      _dispHeader.custPoNo || '',
        partId:        _dispHeader.partId,
        partNo:        _dispHeader.partNo,
        partName:      _dispHeader.partName,
        stream:        _dispHeader.stream,
        date:          _dispHeader.date,
        rows,
        totalQty,
        totalValue:    totalVal,
        dispatchedBy:     S.sess.userId,
        dispatchedByName: S.sess.name,
        createdAt: serverTS(),
      });

      // Update PO dispatchedQty
      if (poDoc.exists) {
        const po = poDoc.data();
        const updLines = (po.lines || []).map(l => {
          if (l.partId === _dispHeader.partId && l.lineNo === _dispHeader.lineNo) {
            return { ...l, dispatchedQty: (l.dispatchedQty || 0) + totalQty };
          }
          return l;
        });
        const allFulfilled = updLines.every(l => (l.dispatchedQty || 0) >= l.scheduledQty);
        t.update(poRef, {
          lines: updLines,
          ...(allFulfilled ? { status: 'closed' } : {}),
          updatedAt: serverTS(),
        });
      }
    });

    await logAudit('DISPATCH', 'DISPATCH', dispRef.id, null, {
      partId: _dispHeader.partId, stream: _dispHeader.stream,
      totalQty: _dispRows.reduce((s, r) => s + (r.qty || 0), 0),
    });

    toast('Dispatch finalised ✓');
    _dispHeaderLocked = false;
    _dispRows = [];
    _dispHeader = { customerId:'', customerName:'', poId:'', poNo:'', custPoNo:'', partId:'', partNo:'', partName:'', lineNo:0, stream:'oem', date:'', pieceRateINR:0 };
    await refreshDSP();
  } catch (e) {
    console.error('finalizeDispatch:', e);
    toast('Dispatch failed: ' + friendlyError(e));
  }
}

/* ═══════════════════════════════════════════════════════════════════
   TAB: TRACKSHEET
   ═══════════════════════════════════════════════════════════════════ */
function renderTracksheet() {
  const el = document.getElementById('tab-body');
  if (!el) return;

  const today    = dateStr();
  const openPOs  = S_DSP.pos.filter(p => p.status === 'open');

  if (!openPOs.length) {
    el.innerHTML = `
      <div class="imf-empty" style="padding:40px 24px">
        <div class="ic"><i class="ti ti-table"></i></div>
        <h3>No open SOs</h3>
        <p>Create SOs in the Sales Orders tab to track delivery compliance.</p>
      </div>`;
    return;
  }

  const allRows = [];
  openPOs.forEach(po => {
    (po.lines || []).forEach(l => {
      allRows.push({ po, line: l, rag: calcRAG(l, today) });
    });
  });
  allRows.sort((a, b) => {
    const o = { r: 0, a: 1, g: 2 };
    return (o[a.rag.code] ?? 3) - (o[b.rag.code] ?? 3);
  });

  el.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;flex-wrap:wrap;gap:8px">
      <div style="font-size:12px;font-weight:700;color:var(--txt-muted);text-transform:uppercase;letter-spacing:.04em">${allRows.length} active SO line${allRows.length !== 1 ? 's' : ''}</div>
      <button class="btn btn-s btn-sm" onclick="refreshDSP()"><i class="ti ti-refresh"></i> Refresh</button>
    </div>
    
    <div class="imf-tablewrap">
      <div class="imf-table-scroll">
        <table class="imf-table">
          <thead>
            <tr>
              <th class="pin" style="min-width:200px">Customer / SO</th>
              <th style="min-width:180px">Part</th>
              <th class="num" style="min-width:100px">Accepted Qty</th>
              <th class="num" style="min-width:120px">Dispatched / Sched.</th>
              <th style="min-width:140px">Progress</th>
              <th style="min-width:110px">Due</th>
              <th style="min-width:120px;text-align:center">Status</th>
            </tr>
          </thead>
          <tbody>
            ${allRows.map(({ po, line: l, rag }, i) => {
              const pct    = l.scheduledQty > 0 ? Math.round(((l.dispatchedQty || 0) / l.scheduledQty) * 100) : 0;
              const statusCls = pct >= 100 ? 'rag-g' : rag.code === 'r' ? 'rag-r' : rag.code === 'a' ? 'rag-a' : 'rag-b';
              const ragCol = pct >= 100 ? 'var(--ok)' : rag.code === 'r' ? 'var(--err)' : rag.code === 'a' ? 'var(--warn)' : 'var(--acc)';
              const ragIcon = pct >= 100 ? 'ti-circle-check' : rag.code === 'r' ? 'ti-alert-circle' : rag.code === 'a' ? 'ti-clock' : 'ti-circle-dot';
              return `
                <tr>
                  <td class="pin">
                    <div style="font-family:var(--sans);font-weight:700;color:var(--txt)">${po.customerName}</div>
                    <div class="cell-sub" style="font-family:var(--mono-v2);font-size:10.5px">${po.poNo}${po.custPoNo ? ` · PO: ${po.custPoNo}` : ''}</div>
                  </td>
                  <td>
                    <div style="font-weight:600">${l.partName || '—'}</div>
                  </td>
                  <td class="num" style="font-family:var(--mono-v2);font-feature-settings:'tnum';color:var(--txt-muted)">
                    ${l.totalScheduleQty || l.scheduledQty || 0}
                  </td>
                  <td class="num" style="font-family:var(--mono-v2);font-feature-settings:'tnum'">
                    <strong>${l.dispatchedQty||0}</strong> / ${l.scheduledQty}
                  </td>
                  <td>
                    <div style="display:flex;align-items:center;gap:8px">
                      <span class="imf-mono" style="font-family:var(--mono-v2);font-size:11px;min-width:32px;text-align:right">${pct}%</span>
                      <div style="background:var(--line);border-radius:99px;height:5px;width:70px;overflow:hidden;flex-shrink:0">
                        <div style="height:100%;border-radius:99px;background:${ragCol};width:${Math.min(pct,100)}%"></div>
                      </div>
                    </div>
                  </td>
                  <td style="font-family:var(--mono-v2);color:var(--txt-muted);white-space:nowrap">${fmtLineDue(l, po.deliveryMonth)}</td>
                  <td style="text-align:center">
                    <span class="imf-badge ${statusCls}">
                      <i class="ti ${ragIcon}" aria-hidden="true"></i> ${rag.label}
                    </span>
                  </td>
                </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
      
      <!-- Mobile Fallback card list -->
      <div class="imf-cards">
        ${allRows.map(({ po, line: l, rag }) => {
          const pct    = l.scheduledQty > 0 ? Math.round(((l.dispatchedQty || 0) / l.scheduledQty) * 100) : 0;
          const statusCls = pct >= 100 ? 'rag-g' : rag.code === 'r' ? 'rag-r' : rag.code === 'a' ? 'rag-a' : 'rag-b';
          const ragCol = pct >= 100 ? 'var(--ok)' : rag.code === 'r' ? 'var(--err)' : rag.code === 'a' ? 'var(--warn)' : 'var(--acc)';
          const ragIcon = pct >= 100 ? 'ti-circle-check' : rag.code === 'r' ? 'ti-alert-circle' : rag.code === 'a' ? 'ti-clock' : 'ti-circle-dot';
          return `
            <div class="imf-card">
              <div class="imf-card-top">
                <span class="imf-mono" style="font-family:var(--mono-v2)">${po.poNo}${po.custPoNo ? ` · PO: ${po.custPoNo}` : ''}</span>
                <div class="grow"></div>
                <span class="imf-badge ${statusCls}"><i class="ti ${ragIcon}"></i> ${rag.label}</span>
              </div>
              <div class="imf-card-lead">
                <span class="nm">${l.partName || '—'}</span>
                <span class="qty" style="font-family:var(--mono-v2)">${l.dispatchedQty||0} <small>/ ${l.scheduledQty} pcs</small></span>
              </div>
              <div class="imf-card-meta">
                Customer: <strong>${po.customerName}</strong> · Accepted: <strong>${l.totalScheduleQty || l.scheduledQty || 0}</strong>
              </div>
              <div style="background:var(--line);border-radius:99px;height:4px;margin-top:6px;margin-bottom:8px;overflow:hidden">
                <div style="height:100%;border-radius:99px;background:${ragCol};width:${Math.min(pct,100)}%"></div>
              </div>
              <div class="imf-card-foot" style="margin-top:8px">
                <span>Due: <strong style="font-family:var(--mono-v2)">${fmtLineDue(l, po.deliveryMonth)}</strong></span>
              </div>
            </div>`;
        }).join('')}
    </div>`;
}

function calcRAG(line, today) {
  const sched = line.scheduledQty || 0;
  const done  = line.dispatchedQty || 0;
  if (done >= sched) return { code: 'g', label: 'Fulfilled ✓' };
  if (!line.dueDate) return { code: 'g', label: `${done}/${sched}` };

  const pct = sched > 0 ? Math.round((done / sched) * 100) : 0;
  if (line.dueDate < today) return { code: 'r', label: `Overdue (${pct}%)` };

  const d7 = new Date(today); d7.setDate(d7.getDate() + 7);
  const soon = line.dueDate <= d7.toISOString().slice(0, 10);
  if (soon && pct < 80) return { code: 'a', label: `Due Soon (${pct}%)` };
  return { code: 'g', label: `On Track (${pct}%)` };
}

/* ── PO & Dispatch Edit/Delete Functions ── */
async function deletePO(id) {
  if (!isTanmay()) { toast('Access denied'); return; }
  const p = S_DSP.pos.find(x => x.id === id);
  if (!p) return;

  const hasDispatches = (p.lines || []).some(l => (l.dispatchedQty || 0) > 0);
  if (hasDispatches) {
    toast("Can't delete SO — some items have already been dispatched. Revert/delete those dispatches first.", 5000);
    return;
  }

  if (!confirm(`Delete Sales Order ${p.poNo || p.id}? This cannot be undone.`)) return;

  try {
    await db.collection('pos').doc(id).delete();
    await logAudit('DELETE_SO', 'DISPATCH', id, p, null);
    closeModal();
    await refreshDSP();
    toast('Sales Order deleted ✓');
  } catch (e) {
    toast('Error: ' + friendlyError(e));
  }
}

function openDispatchDetailModal(id) {
  const d = S_DSP.dispatches.find(x => x.id === id);
  if (!d) return;

  const rowsHtml = (d.rows || []).map(r => `
    <div style="background:var(--bg);border-radius:var(--rs);padding:10px 12px;margin-bottom:8px;font-size:12.5px">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <span class="imf-mono" style="font-weight:700;color:var(--imf-navy)">${r.tagId}</span>
        <span class="imf-mono" style="font-weight:700">${r.qty} pcs</span>
      </div>
      <div style="font-size:11px;color:var(--txt-muted);margin-top:4px">
        Batch: <strong>${r.batchCode || '—'}</strong> · Heat: <strong>${r.heatCode || '—'}</strong> · Invoice/DC: <strong>${r.invoiceNo || '—'}</strong>
      </div>
    </div>`).join('');

  openModal(`
    <div class="modal-handle"></div>
    <div class="modal-title">Dispatch Details</div>
    <div style="background:var(--sur2);border-radius:var(--rs);padding:12px;margin-bottom:14px;font-size:13px">
      <div class="row-2">
        <div><strong>SO No:</strong> <span class="imf-mono">${d.poNo || '—'}</span></div>
        <div><strong>Date:</strong> ${fmtDate(d.date)}</div>
      </div>
      ${d.custPoNo ? `<div style="margin-top:6px"><strong>Customer PO:</strong> <span class="imf-mono" style="color:var(--imf-navy)">${d.custPoNo}</span></div>` : ''}
      <div class="row-2" style="margin-top:6px">
        <div><strong>Customer:</strong> ${d.customerName || '—'}</div>
        <div><strong>Stream:</strong> ${(d.stream || '').toUpperCase()}</div>
      </div>
      <div class="row-2" style="margin-top:6px">
        <div><strong>Part:</strong> ${d.partName} (${d.partNo})</div>
        <div><strong>Total Qty:</strong> <span class="imf-mono">${d.totalQty || 0} pcs</span></div>
      </div>
    </div>

    <div style="font-size:11px;font-weight:700;color:var(--txt-muted);letter-spacing:.06em;margin-bottom:8px;text-transform:uppercase">DISPATCHED TAGS</div>
    <div style="max-height:220px;overflow-y:auto;margin-bottom:16px">${rowsHtml}</div>

    <div style="display:flex;gap:10px">
      <button class="btn btn-s" style="flex:1" onclick="closeModal()">Close</button>
      ${isAdmin() ? `<button class="btn btn-p" style="flex:1" onclick="openEditDispatchModal('${d.id}')"><i class="ti ti-edit"></i> Edit</button>` : ''}
    </div>
    ${isTanmay() ? `
    <button class="btn btn-d w-full mt-8" onclick="deleteDispatch('${d.id}')">
      <i class="ti ti-trash"></i> Delete Dispatch
    </button>` : ''}
  `);
}

function openEditDispatchModal(id) {
  if (!isAdmin()) { toast('Access denied'); return; }
  const d = S_DSP.dispatches.find(x => x.id === id);
  if (!d) return;

  const rowsHtml = (d.rows || []).map((r, i) => `
    <div style="background:var(--bg);border-radius:var(--rs);padding:10px;margin-bottom:8px">
      <div style="font-weight:700;font-size:12px;color:var(--imf-navy);margin-bottom:6px">${r.tagId} (${r.qty} pcs)</div>
      <div class="row-2">
        <div class="f" style="margin:0">
          <label style="font-size:10px">Invoice/DC No.</label>
          <input type="text" id="edit-disp-inv-${i}" value="${r.invoiceNo || ''}" style="font-size:12px;padding:4px 8px">
        </div>
        <div class="f" style="margin:0">
          <label style="font-size:10px">Vehicle No.</label>
          <input type="text" id="edit-disp-veh-${i}" value="${r.vehicle || ''}" style="font-size:12px;padding:4px 8px">
        </div>
      </div>
    </div>`).join('');

  openModal(`
    <div class="modal-handle"></div>
    <div class="modal-title">Edit Dispatch Details</div>
    <div class="f" style="margin-bottom:12px">
      <label>Dispatch Date</label>
      <input type="date" id="edit-disp-date" value="${d.date || ''}" style="font-size:13.5px">
    </div>
    <div style="font-size:11px;font-weight:700;color:var(--txt-muted);letter-spacing:.06em;margin-bottom:8px;text-transform:uppercase">EDIT TAG DETAILS</div>
    <div style="max-height:220px;overflow-y:auto;margin-bottom:16px">${rowsHtml}</div>
    <div id="edit-disp-err" style="display:none;color:var(--err);font-size:12px;margin-bottom:8px"></div>
    <div style="display:flex;gap:10px">
      <button class="btn btn-s" style="flex:1" onclick="openDispatchDetailModal('${d.id}')">Back</button>
      <button class="btn btn-p" style="flex:1" onclick="saveEditDispatch('${d.id}')">Save Changes</button>
    </div>
  `);
}

async function saveEditDispatch(id) {
  if (!isAdmin()) { toast('Access denied'); return; }
  const d = S_DSP.dispatches.find(x => x.id === id);
  if (!d) return;

  const date = document.getElementById('edit-disp-date')?.value;
  if (!date) { toast('Date is required'); return; }

  const updatedRows = (d.rows || []).map((r, i) => {
    const invoiceNo = document.getElementById(`edit-disp-inv-${i}`)?.value || '';
    const vehicle   = document.getElementById(`edit-disp-veh-${i}`)?.value || '';
    return { ...r, invoiceNo, vehicle };
  });

  try {
    const ref = db.collection('dispatches').doc(id);
    await ref.update({ date, rows: updatedRows, updatedAt: serverTS() });
    await logAudit('EDIT_DISPATCH', 'DISPATCH', id, d, { date, rows: updatedRows });
    closeModal();
    await refreshDSP();
    toast('Dispatch updated ✓');
  } catch (e) {
    toast('Error: ' + friendlyError(e));
  }
}

async function deleteDispatch(id) {
  if (!isTanmay()) { toast('Access denied'); return; }
  const d = S_DSP.dispatches.find(x => x.id === id);
  if (!d) return;

  if (!confirm(`Delete dispatch session ${d.poNo || d.id} (${d.totalQty} pcs)? This will restore quantities to QC Cleared and cannot be undone.`)) return;

  try {
    const streamKey = d.stream ? `qty_${d.stream}` : 'qty_oem';
    const validRows = (d.rows || []).filter(r => r.tagId && r.tagId !== 'Legacy Tag');

    await db.runTransaction(async (t) => {
      const dispRef = db.collection('dispatches').doc(id);
      const poRef    = d.poId ? db.collection('pos').doc(d.poId) : null;
      const cardRefs = validRows.map(r => db.collection('routeCards').doc(r.tagId));

      const [poDoc, ...cardDocs] = await Promise.all([
        poRef ? t.get(poRef) : Promise.resolve({ exists: false }),
        ...cardRefs.map(ref => t.get(ref))
      ]);

      // Update PO
      if (poDoc && poDoc.exists) {
        const po = poDoc.data();
        const updLines = (po.lines || []).map(l => {
          if (l.partId === d.partId) {
            return { ...l, dispatchedQty: Math.max(0, (l.dispatchedQty || 0) - (d.totalQty || 0)) };
          }
          return l;
        });
        t.update(poRef, {
          lines: updLines,
          status: 'open',
          updatedAt: serverTS(),
        });
      }

      // Update Route Cards
      for (let i = 0; i < validRows.length; i++) {
        const row = validRows[i];
        if (cardDocs[i].exists) {
          t.update(cardRefs[i], {
            [streamKey]: firebase.firestore.FieldValue.increment(row.qty),
            status: 'qc_cleared',
            updatedAt: serverTS(),
          });
        }
      }

      // Delete dispatch document
      t.delete(dispRef);
    });

    await logAudit('DELETE_DISPATCH', 'DISPATCH', id, d, null);
    closeModal();
    await refreshDSP();
    toast('Dispatch deleted ✓');
  } catch (e) {
    console.error('deleteDispatch error:', e);
    toast('Delete failed: ' + friendlyError(e));
  }
}

/* ── Boot ────────────────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', init);
