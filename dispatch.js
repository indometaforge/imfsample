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
  { key: 'pos',        icon: 'ti-file-text',         label: 'POs'        },
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
let _dispHeader       = { customerId:'', customerName:'', poId:'', poNo:'', partId:'', partNo:'', partName:'', lineNo:0, stream:'oem', date:'', pieceRateINR:0 };
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

async function loadDispatchData() {
  try {
    const [poSnap, dispSnap, clearedSnap] = await Promise.all([
      db.collection('pos').orderBy('createdAt', 'desc').limit(200).get(),
      db.collection('dispatches').orderBy('createdAt', 'desc').limit(200).get(),
      db.collection('routeCards').where('status', '==', 'qc_cleared').get(),
    ]);
    S_DSP.pos          = poSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    S_DSP.dispatches   = dispSnap.docs.map(d => ({ id: d.id, ...d.data() }));
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
          <div style="font-weight:800;font-size:14px">${overdue} Overdue PO Line${overdue !== 1 ? 's' : ''}</div>
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
    <div class="imf-card">
      <div class="imf-card-top">
        <span class="imf-mono" style="font-size:12px;color:var(--txt-muted)">${d.poNo || '—'}</span>
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

  const canEdit = canDo('dispatch') || S.sess?.role === 'admin';
  const openPOs = S_DSP.pos.filter(p => p.status === 'open');
  const closedPOs = S_DSP.pos.filter(p => p.status !== 'open');

  el.innerHTML = `
    <div style="display:flex;gap:12px;margin-bottom:16px;align-items:center">
      ${canEdit ? `<button class="btn btn-p" onclick="openPoModal(null)"><i class="ti ti-plus"></i> Create New PO</button>` : ''}
      <button class="btn btn-s btn-sm" style="margin-left:auto;padding:8px 12px" onclick="refreshDSP()"><i class="ti ti-refresh"></i> Refresh</button>
    </div>

    ${openPOs.length
      ? `<div style="font-size:11px;font-weight:700;color:var(--txt-muted);letter-spacing:.06em;margin-bottom:10px;text-transform:uppercase">Open Purchase Orders (${openPOs.length})</div>
         <div style="display:flex;flex-direction:column;gap:12px">${openPOs.map(p => poCard(p, canEdit)).join('')}</div>`
      : `<div class="imf-empty" style="padding:40px 20px"><div class="empty-ic" style="font-size:32px;color:var(--txt-dim);margin-bottom:8px"><i class="ti ti-file-text"></i></div><h3 style="font-size:15px;font-weight:700;margin-bottom:4px">No open POs</h3><p style="font-size:12px;color:var(--txt-muted)">Create a purchase order to track customer delivery compliance.</p></div>`}

    ${closedPOs.length ? `
      <div style="border-top:1px solid var(--line);margin:24px 0 12px;padding-top:16px">
        <div style="font-size:11px;font-weight:700;color:var(--txt-muted);letter-spacing:.06em;margin-bottom:10px;text-transform:uppercase">Closed Purchase Orders (${closedPOs.length})</div>
        <div style="display:flex;flex-direction:column;gap:12px">${closedPOs.slice(0, 10).map(p => poCard(p, false)).join('')}</div>
      </div>` : ''}`;
}

function poCard(p, canEdit) {
  const lines = p.lines || [];
  return `
    <div class="imf-card" style="opacity:${p.status==='open'?1:0.75}">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:12px">
        <div>
          <div class="imf-mono" style="font-weight:800;font-size:15px;color:var(--imf-navy)">${p.poNo || '—'}</div>
          <div style="font-size:12px;color:var(--txt-muted);margin-top:2px">
            Customer: <strong>${p.customerName || '—'}</strong> · Date: <strong>${fmtDate(p.poDate)}</strong>
          </div>
          ${p.deliveryMonth ? `<div style="font-size:11px;color:var(--txt-dim);margin-top:2px"><i class="ti ti-calendar"></i> Delivery Month: <span class="imf-mono">${fmtMonth(p.deliveryMonth)}</span></div>` : ''}
        </div>
        <div style="display:flex;gap:8px;align-items:center;flex-shrink:0">
          ${p.status === 'open'
            ? `<span class="imf-badge st-store_issued" style="padding:4px 10px"><i class="ti ti-circle-check"></i> Open</span>`
            : `<span class="imf-badge st-dispatched" style="padding:4px 10px"><i class="ti ti-lock"></i> Closed</span>`
          }
          ${canEdit ? `<button class="btn btn-s btn-sm" style="padding:4px 8px" onclick="openPoModal('${p.id}')"><i class="ti ti-edit"></i></button>` : ''}
        </div>
      </div>
      <div style="display:flex;flex-direction:column;gap:8px">
        ${lines.map(l => {
          const pct    = l.scheduledQty > 0 ? Math.round(((l.dispatchedQty || 0) / l.scheduledQty) * 100) : 0;
          const isOverdue = l.dueDate && l.dueDate < dateStr() && (l.dispatchedQty || 0) < l.scheduledQty;
          const statusCls = pct >= 100 ? 'rag-g' : isOverdue ? 'rag-r' : 'rag-b';
          const indicatorColor = pct >= 100 ? 'var(--ok)' : isOverdue ? 'var(--err)' : 'var(--acc)';
          return `
            <div style="background:var(--fill);border-radius:var(--rs);padding:10px 12px">
              <div style="display:flex;align-items:center;justify-content:space-between;gap:8px">
                <div>
                  <div style="font-weight:700;font-size:13px">${l.partName || '—'}</div>
                  <div style="font-size:11px;color:var(--txt-muted);margin-top:2px">
                    Due: <strong>${fmtDate(l.dueDate)}</strong> · Rate: <strong class="imf-mono">${fmtINR(l.pieceRateINR || 0)}</strong>
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

/* ── PO modal (create / edit) ────────────────────────────────────────── */
function openPoModal(id) {
  _poEditId = id;
  const p = id ? S_DSP.pos.find(x => x.id === id) : null;
  _poLines = p ? JSON.parse(JSON.stringify(p.lines || [])) : [];
  _poLines = _poLines.map(l => ({
    ...l,
    totalScheduleQty: l.totalScheduleQty || l.scheduledQty || 0
  }));

  const custOpts = (S.customers || []).map(c => `<option value="${c.id}" ${p?.customerId===c.id?'selected':''}>${c.name}</option>`).join('');

  openModal(`
    <div class="modal-handle"></div>
    <div class="modal-title">${id ? 'Edit Purchase Order' : 'New Purchase Order'}</div>

    <div class="f" style="margin-bottom:12px">
      <label>Customer <span style="color:var(--err)">*</span></label>
      <select id="po-cust" style="font-size:13.5px;font-weight:600">
        <option value="">— Select customer —</option>
        ${custOpts}
      </select>
    </div>
    <div class="row-2" style="margin-bottom:12px">
      <div class="f">
        <label>PO Number <span style="color:var(--err)">*</span></label>
        <input type="text" id="po-no" value="${p?.poNo||''}" placeholder="e.g. PO-2024-001" style="font-size:13.5px;font-weight:700;font-family:var(--mono-v2)">
      </div>
      <div class="f">
        <label>PO Date</label>
        <input type="date" id="po-date" value="${p?.poDate||dateStr()}" style="font-size:13.5px;font-weight:600">
      </div>
    </div>
    <div class="f" style="margin-bottom:12px">
      <label>Delivery Month</label>
      <select id="po-month" style="font-size:13.5px;font-weight:600">
        ${getMonthDropdownOptions(p?.deliveryMonth || '')}
      </select>
    </div>
    <div class="f" style="margin-bottom:16px">
      <label>Remarks</label>
      <input type="text" id="po-remarks" value="${p?.remarks||''}" placeholder="Optional remarks" style="font-size:13.5px">
    </div>

    <div style="border-top:1px solid var(--line);margin:16px 0 12px;padding-top:16px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
        <div style="font-size:13px;font-weight:800;color:var(--imf-navy)">PO Lines / Parts</div>
        <button class="btn btn-s btn-sm" onclick="poAddLine()"><i class="ti ti-plus"></i> Add Line</button>
      </div>
      <div id="po-lines-list" style="display:flex;flex-direction:column;gap:10px;max-height:260px;overflow-y:auto;padding-right:4px;margin-bottom:16px"></div>
    </div>

    <div id="po-modal-err" style="display:none;color:var(--err);font-size:12px;font-weight:700;margin-bottom:12px"></div>
    <div style="display:flex;gap:10px">
      <button class="btn btn-s" style="flex:1" onclick="closeModal()">Cancel</button>
      <button class="btn btn-p" style="flex:1" onclick="savePo()">
        <i class="ti ti-check"></i> ${id ? 'Save Changes' : 'Create PO'}
      </button>
    </div>`);

  renderPoLines();
}

function poAddLine() {
  poReadLines();
  _poLines.push({ lineNo: _poLines.length + 1, partId: '', partNo: '', partName: '', totalScheduleQty: 0, scheduledQty: 0, dueDate: tomStr(), pieceRateINR: 0, dispatchedQty: 0 });
  renderPoLines();
}

function poRemoveLine(idx) {
  poReadLines();
  _poLines.splice(idx, 1);
  _poLines = _poLines.map((l, i) => ({ ...l, lineNo: i + 1 }));
  renderPoLines();
}

function poReadLines() {
  _poLines = _poLines.map((l, i) => {
    const partId = document.getElementById(`po-part-id-${i}`)?.value || l.partId;
    const part   = S.parts.find(p => p.id === partId);
    return {
      ...l,
      partId,
      partNo:   part?.no   || part?.partNo   || l.partNo,
      partName: part?.name || document.getElementById(`po-part-name-${i}`)?.value || l.partName,
      totalScheduleQty: parseFloat(document.getElementById(`po-total-qty-${i}`)?.value || '0') || 0,
      scheduledQty:  parseFloat(document.getElementById(`po-qty-${i}`)?.value  || '0') || 0,
      dueDate:       document.getElementById(`po-due-${i}`)?.value  || l.dueDate,
      pieceRateINR:  parseFloat(document.getElementById(`po-rate-${i}`)?.value || '0') || 0,
    };
  });
}

function renderPoLines() {
  const el = document.getElementById('po-lines-list');
  if (!el) return;
  if (!_poLines.length) {
    el.innerHTML = `<div style="font-size:12px;color:var(--txt-muted);padding:8px 0;text-align:center;background:var(--fill);border-radius:var(--rs)">No lines added yet. Click 'Add Line' to add a part.</div>`;
    return;
  }
  el.innerHTML = _poLines.map((l, i) => `
    <div style="background:var(--fill);border-radius:var(--rs);padding:12px 14px;border:1px solid var(--line)">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
        <div style="font-size:11px;font-weight:800;color:var(--txt-muted);letter-spacing:0.04em">LINE ${i + 1}</div>
        <button onclick="poReadLines();poRemoveLine(${i})" style="border:none;background:none;color:var(--err);cursor:pointer;font-size:14px;padding:2px">
          <i class="ti ti-trash"></i>
        </button>
      </div>
      <div style="display:grid;grid-template-columns: 2fr 1fr;gap:12px;margin-bottom:8px">
        <div class="f">
          <label>Part Name / Number</label>
          <input id="po-part-name-${i}" type="text" value="${l.partName||''}"
            placeholder="Type part name or number to search..." autocomplete="off"
            oninput="poPartSearch(this,${i})" onblur="setTimeout(hidePartDrop,150)" style="font-size:12.5px;font-weight:600">
          <input type="hidden" id="po-part-id-${i}" value="${l.partId||''}">
        </div>
        <div class="f">
          <label>Total Schedule Qty</label>
          <input type="number" id="po-total-qty-${i}" value="${l.totalScheduleQty || 0}" min="0" onchange="balancePoLines(${i}, 'totalScheduleQty')" style="font-size:12.5px;font-weight:700;font-family:var(--mono-v2);text-align:center">
        </div>
      </div>
      <div class="row-3">
        <div class="f">
          <label>Quantity</label>
          <input type="number" id="po-qty-${i}" value="${l.scheduledQty}" min="0" onchange="balancePoLines(${i}, 'scheduledQty')" style="font-size:12.5px;font-weight:700;font-family:var(--mono-v2);text-align:center">
        </div>
        <div class="f">
          <label>Due Date</label>
          <input type="date" id="po-due-${i}" value="${l.dueDate||''}" style="font-size:12.5px;font-weight:600">
        </div>
        <div class="f">
          <label>Rate (₹/pc)</label>
          <input type="number" id="po-rate-${i}" value="${l.pieceRateINR||0}" min="0" style="font-size:12.5px;font-weight:700;font-family:var(--mono-v2);text-align:center">
        </div>
      </div>
    </div>`).join('');
}

function poPartSearch(inputEl, idx) {
  if (!inputEl.value.trim()) { hidePartDrop(); document.getElementById(`po-part-id-${idx}`).value = ''; return; }
  showPartDrop(inputEl, (p) => {
    document.getElementById(`po-part-id-${idx}`).value = p.id;
    inputEl.value = p.name;
    poReadLines();
    
    const existing = _poLines.find((l, i) => l.partId === p.id && i !== idx);
    if (existing) {
      _poLines[idx].totalScheduleQty = existing.totalScheduleQty;
      _poLines[idx].pieceRateINR = existing.pieceRateINR;
    } else {
      _poLines[idx].pieceRateINR = p.rate || p.pieceRateINR || 0;
      if (!_poLines[idx].totalScheduleQty && _poLines[idx].scheduledQty) {
        _poLines[idx].totalScheduleQty = _poLines[idx].scheduledQty;
      }
    }
    
    balancePoLines();
  });
}

function balancePoLines(editedIdx, editedField) {
  poReadLines();
  if (!_poLines.length) return;

  if (editedIdx !== undefined && editedIdx >= 0 && editedIdx < _poLines.length) {
    const editedLine = _poLines[editedIdx];
    const partId = editedLine.partId;
    if (partId) {
      if (editedField === 'totalScheduleQty') {
        _poLines.forEach(l => {
          if (l.partId === partId) {
            l.totalScheduleQty = editedLine.totalScheduleQty;
          }
        });
        const groupLines = _poLines.filter(l => l.partId === partId);
        if (groupLines.length === 1 && groupLines[0].scheduledQty === 0) {
          groupLines[0].scheduledQty = editedLine.totalScheduleQty;
        }
      }
    }
  }

  const partIds = [...new Set(_poLines.map(l => l.partId).filter(Boolean))];

  partIds.forEach(partId => {
    const indices = [];
    _poLines.forEach((l, idx) => {
      if (l.partId === partId) indices.push(idx);
    });

    if (!indices.length) return;

    const T = _poLines[indices[0]].totalScheduleQty || 0;
    let runningSum = 0;
    let cutoffIdx = -1;

    for (let i = 0; i < indices.length; i++) {
      const idx = indices[i];
      runningSum += _poLines[idx].scheduledQty;
      if (runningSum >= T) {
        cutoffIdx = idx;
        break;
      }
    }

    if (cutoffIdx !== -1) {
      _poLines = _poLines.filter((l, idx) => {
        if (l.partId === partId && idx > cutoffIdx) {
          return false;
        }
        return true;
      });
    } else {
      const lastIdx = indices[indices.length - 1];
      const lastLine = _poLines[lastIdx];
      
      const newLine = {
        lineNo: 0,
        partId: lastLine.partId,
        partNo: lastLine.partNo,
        partName: lastLine.partName,
        totalScheduleQty: T,
        scheduledQty: T - runningSum,
        dueDate: lastLine.dueDate || tomStr(),
        pieceRateINR: lastLine.pieceRateINR || 0,
        dispatchedQty: 0
      };
      
      _poLines.splice(lastIdx + 1, 0, newLine);
    }
  });

  _poLines = _poLines.map((l, i) => ({ ...l, lineNo: i + 1 }));

  renderPoLines();
}

async function savePo() {
  poReadLines();
  const custId  = document.getElementById('po-cust')?.value;
  const poNo    = (document.getElementById('po-no')?.value || '').trim();
  const poDate  = document.getElementById('po-date')?.value || dateStr();
  const month   = document.getElementById('po-month')?.value || '';
  const remarks = (document.getElementById('po-remarks')?.value || '').trim();
  const errEl   = document.getElementById('po-modal-err');

  if (!custId) { if (errEl) { errEl.textContent = 'Select a customer'; errEl.style.display = ''; } return; }
  if (!poNo)   { if (errEl) { errEl.textContent = 'Enter PO number';   errEl.style.display = ''; } return; }
  if (!_poLines.length) { if (errEl) { errEl.textContent = 'Add at least one line'; errEl.style.display = ''; } return; }
  if (_poLines.some(l => !l.partId || !l.scheduledQty)) {
    if (errEl) { errEl.textContent = 'All lines need a part and quantity'; errEl.style.display = ''; } return;
  }

  const cust = S.customers.find(c => c.id === custId);
  try {
    const now  = serverTS();
    const data = {
      customerId:    custId,
      customerName:  cust?.name || '',
      poNo, poDate,
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
      toast('PO updated ✓');
    } else {
      await db.collection('pos').add({ ...data, createdBy: S.sess.userId, createdByName: S.sess.name, createdAt: now });
      toast('PO created ✓');
    }
    closeModal();
    await refreshDSP();
  } catch (e) { toast(friendlyError(e)); }
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
  const poOpts = filteredPOs.map(p => `<option value="${p.id}" ${_dispHeader.poId===p.id?'selected':''}>${p.poNo}</option>`).join('');

  const selPO    = S_DSP.pos.find(p => p.id === _dispHeader.poId);
  const partOpts = selPO
    ? (selPO.lines || []).map(l => `<option value="${l.partId}" data-line="${l.lineNo}" data-rate="${l.pieceRateINR||0}" ${_dispHeader.partId===l.partId && _dispHeader.lineNo===l.lineNo?'selected':''}>${l.partName} (Due: ${fmtDate(l.dueDate)}, Qty: ${l.scheduledQty})</option>`).join('')
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
  const line = (po?.lines || []).find(l => l.partId === _dispHeader.partId && l.lineNo === _dispHeader.lineNo);
  _dispHeader.partName = line?.partName || '';
  _dispHeader.partNo   = line?.partNo   || '';
  _dispHeader.pieceRateINR = line?.pieceRateINR || 0;

  const errEl = document.getElementById('dh-err');
  if (!_dispHeader.customerId) { if (errEl) { errEl.textContent = 'Select a customer'; errEl.style.display = ''; } return; }
  if (!_dispHeader.poId)       { if (errEl) { errEl.textContent = 'Select a PO';       errEl.style.display = ''; } return; }
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
  _dispHeader = { customerId:'', customerName:'', poId:'', poNo:'', partId:'', partNo:'', partName:'', lineNo:0, stream:'oem', date:'', pieceRateINR:0 };
  renderDispatch();
}

function renderDispatchHeaderLocked() {
  const streamLbl = STREAMS.find(s => s.key === _dispHeader.stream)?.label || _dispHeader.stream;
  return `
    <div class="kv-list">
      <div class="kv-row"><span class="kv-key">Customer</span><span class="kv-val" style="font-weight:700">${_dispHeader.customerName}</span></div>
      <div class="kv-row"><span class="kv-key">PO</span><span class="kv-val imf-mono" style="font-family:var(--mono-v2);font-weight:700;color:var(--imf-navy)">${_dispHeader.poNo}</span></div>
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
    _dispHeader = { customerId:'', customerName:'', poId:'', poNo:'', partId:'', partNo:'', partName:'', lineNo:0, stream:'oem', date:'', pieceRateINR:0 };
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
        <h3>No open POs</h3>
        <p>Create POs in the POs tab to track delivery compliance.</p>
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
      <div style="font-size:12px;font-weight:700;color:var(--txt-muted);text-transform:uppercase;letter-spacing:.04em">${allRows.length} active PO line${allRows.length !== 1 ? 's' : ''}</div>
      <button class="btn btn-s btn-sm" onclick="refreshDSP()"><i class="ti ti-refresh"></i> Refresh</button>
    </div>
    
    <div class="imf-tablewrap">
      <div class="imf-table-scroll">
        <table class="imf-table">
          <thead>
            <tr>
              <th class="pin" style="min-width:200px">Customer / PO</th>
              <th style="min-width:180px">Part</th>
              <th class="num" style="min-width:120px">Dispatched / Sched.</th>
              <th style="min-width:140px">Progress</th>
              <th style="min-width:110px">Due Date</th>
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
                    <div class="cell-sub" style="font-family:var(--mono-v2);font-size:10.5px">${po.poNo}</div>
                  </td>
                  <td>
                    <div style="font-weight:600">${l.partName || '—'}</div>
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
                  <td style="font-family:var(--mono-v2);color:var(--txt-muted);white-space:nowrap">${fmtDate(l.dueDate)}</td>
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
                <span class="imf-mono" style="font-family:var(--mono-v2)">${po.poNo}</span>
                <div class="grow"></div>
                <span class="imf-badge ${statusCls}"><i class="ti ${ragIcon}"></i> ${rag.label}</span>
              </div>
              <div class="imf-card-lead">
                <span class="nm">${l.partName || '—'}</span>
                <span class="qty" style="font-family:var(--mono-v2)">${l.dispatchedQty||0} <small>/ ${l.scheduledQty} pcs</small></span>
              </div>
              <div class="imf-card-meta">
                Customer: <strong>${po.customerName}</strong>
              </div>
              <div style="background:var(--line);border-radius:99px;height:4px;margin-top:6px;margin-bottom:8px;overflow:hidden">
                <div style="height:100%;border-radius:99px;background:${ragCol};width:${Math.min(pct,100)}%"></div>
              </div>
              <div class="imf-card-foot" style="margin-top:8px">
                <span>Due: <strong style="font-family:var(--mono-v2)">${fmtDate(l.dueDate)}</strong></span>
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

/* ── Boot ────────────────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', init);
