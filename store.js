/* ═══════════════════════════════════════════════════════════════════
   IMF ProTrack — Store / Inward (store.js)
   Material inward receipts, requisitions, approvals, issue-to-WIP
   (Route Card / TAG creation), stock balance and TAG registry.

   Collections used (loaded per-module, not in core's loadMasters):
     inward        — raw material receipts from suppliers
     requisitions  — material requests from production, approved by
                      Store HOD / Admin, then issued against TAGs
     routeCards    — one doc per physical TAG, created on issue
     config/tags   — TAG registry counters (totalPrinted, lastTagNum)
   ═══════════════════════════════════════════════════════════════════ */

'use strict';

/* ══════════════════════════════════════════════════════════════════════
   STATE
   ══════════════════════════════════════════════════════════════════════ */
let activeTab = 'inward';
let searchQ   = '';

let _inwFilt = 'all';   /* supplier filter for Inward list */
let _reqFilt = 'all';   /* status filter for Requisitions list */
let _rcFilt  = 'all';   /* status filter for Route Cards list */

let _stockSearch   = '';    /* Stock Balance search query */
let _stockCustFilt = 'all'; /* Stock Balance customer filter */
let _stockExpanded = {};    /* partId → bool (lot rows expanded) */
let _rcvdPeriod    = 'all'; /* Received stat period: all|today|month|year */
let _issdPeriod    = 'today'; /* Issued stat period: today|month|year|all */

let _inwParts = [];     /* [{partId,partNo,partName,qty,rate}] — Inward modal */
let _reqLines = [];     /* [{lineNo,partId,partNo,partName,customerId,customerName,masterLotCode,qtyRequested,qtyApproved,qtyIssued}] */

/* Issue-to-WIP session state */
let _issReq      = null;
let _issLine     = null;
let _issTags     = [];  /* [{tagId, qty, issueDate}] */
let _issBatchCode = '';

const TABS = [
  { key: 'inward',     label: 'Inward',        icon: 'ti-package-import' },
  { key: 'issue',      label: 'Issue to WIP',  icon: 'ti-scan',   show: () => canDo('inward') },
  { key: 'stock',      label: 'Stock Balance', icon: 'ti-chart-pie' },
  { key: 'routeCards', label: 'Route Cards',   icon: 'ti-tags' },
  { key: 'tags',       label: 'TAG Registry',  icon: 'ti-qrcode', show: () => S.sess?.role === 'admin' },
];
/* NOTE: Requisitions tab moved → Production module (production guys initiate requests).
         Approvals tab moved → centralized Approvals page (approvals.html, built separately). */

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

  if (!canView('inward')) {
    window.location.replace('home.html');
    return;
  }

  const pill = document.getElementById('role-pill');
  if (pill) pill.textContent = rlbl(S.sess.role);

  try {
    await loadStoreData();
    render();
  } catch (e) {
    console.error('Store data load failed:', e);
    toast('Error loading store data: ' + e.message, 5000);
    render();
  }

  document.getElementById('loading-screen').style.display = 'none';
  document.getElementById('app').style.display = '';
}

/* Load all transactional Store collections into S */
async function loadStoreData() {
  S.inward = S.inward || [];
  S.requisitions = S.requisitions || [];
  S.routeCards = S.routeCards || [];
  S.tagConfig = S.tagConfig || { totalPrinted: 0, lastTagNum: 0 };

  const [inwSnap, reqSnap, rcSnap, tagDoc] = await Promise.all([
    db.collection('inward').get(),
    db.collection('requisitions').get(),
    db.collection('routeCards').get(),
    db.collection('config').doc('tags').get()
  ]);

  S.inward       = inwSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  S.requisitions = reqSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  S.routeCards   = rcSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  S.tagConfig     = tagDoc.exists ? tagDoc.data() : { totalPrinted: 0, lastTagNum: 0 };
}

/** Reload a single Store collection (or the TAG config doc) into S */
async function refreshStore(name) {
  if (name === 'tags') {
    const doc = await db.collection('config').doc('tags').get();
    S.tagConfig = doc.exists ? doc.data() : { totalPrinted: 0, lastTagNum: 0 };
    return;
  }
  const snap = await db.collection(name).get();
  S[name] = snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

/* ══════════════════════════════════════════════════════════════════════
   LAYOUT — TABS + SECTION ROUTER
   ══════════════════════════════════════════════════════════════════════ */
function render() {
  const visible = TABS.filter(t => !t.show || t.show());
  const page = document.getElementById('page-content');
  page.innerHTML = `
    <div class="tabs" role="tablist" aria-label="Store sections">
      ${visible.map(t => `
        <button class="tab ${t.key === activeTab ? 'active' : ''}"
                role="tab" aria-selected="${t.key === activeTab}"
                onclick="switchTab('${t.key}')">
          <i class="ti ${t.icon}" aria-hidden="true"></i> ${t.label}
        </button>`).join('')}
    </div>
    <div id="section-content"></div>
  `;
  renderSection();
}

function switchTab(key) {
  activeTab = key;
  searchQ   = '';
  _issReq = null; _issLine = null; _issTags = []; _issBatchCode = '';
  _stockSearch = ''; _stockCustFilt = 'all'; _stockExpanded = {};
  _rcvdPeriod = 'all'; _issdPeriod = 'today';
  render();
}

function renderSection() {
  const map = {
    inward:       renderInward,
    requisitions: renderRequisitions,
    approvals:    renderApprovals,
    issue:        renderIssue,
    stock:        renderStock,
    routeCards:   renderRouteCards,
    tags:         renderTagRegistry,
  };
  (map[activeTab] || renderInward)();
}

/* ══════════════════════════════════════════════════════════════════════
   SHARED UI HELPERS
   ══════════════════════════════════════════════════════════════════════ */

/** Header row: title (left) + optional "+ Add X" button (right) */
function sectionHeader(title, addLabel, addOnclick) {
  return `
    <div class="flex justify-between items-center mb-12">
      <div style="font-size:16px;font-weight:700">${title}</div>
      ${addOnclick ? `
        <button class="btn btn-p btn-sm" onclick="${addOnclick}">
          <i class="ti ti-plus" aria-hidden="true"></i> ${addLabel}
        </button>` : ''}
    </div>`;
}

/** Full-width live search input, wired to onSearchInput() */
function searchBox(placeholder) {
  return `
    <div class="f">
      <label for="store-search" style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap">Search</label>
      <input type="search" id="store-search" placeholder="${placeholder}"
             value="${(searchQ || '').replace(/"/g, '&quot;')}"
             oninput="onSearchInput(this.value)">
    </div>`;
}

function onSearchInput(val) {
  searchQ = val;
  renderSection();
  const el = document.getElementById('store-search');
  if (el) { el.focus(); el.setSelectionRange(val.length, val.length); }
}

/** Search box + a generic filter dropdown, side by side */
function searchAndFilterRow(placeholder, options, current, onChange) {
  return `
    <div class="row-2">
      ${searchBox(placeholder)}
      <div class="f">
        <label for="store-filter" style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap">Filter</label>
        <select id="store-filter" onchange="${onChange}(this.value)">
          ${options.map(o => `<option value="${o.v}" ${o.v === current ? 'selected' : ''}>${o.l}</option>`).join('')}
        </select>
      </div>
    </div>`;
}

/** Small muted record-count line */
function recordCount(n) {
  return `<div class="text-muted text-sm mb-12">${n} record${n === 1 ? '' : 's'}</div>`;
}

/** Empty state block */
function emptyState(icon, title, msg) {
  return `
    <div class="empty">
      <div class="empty-ic"><i class="ti ${icon}" aria-hidden="true"></i></div>
      <h3>${title}</h3>
      <p>${msg}</p>
    </div>`;
}

/** Inline error banner inside the open modal */
function showModalError(msg) {
  const box = document.getElementById('modal-err');
  if (box) box.innerHTML = `<div class="ebox"><i class="ti ti-alert-triangle" aria-hidden="true"></i><span>${msg}</span></div>`;
}

/* Modal footer: Save + Cancel buttons */
function modalActions(saveLabel, saveOnclick) {
  return `
    <div class="flex gap-8 mt-16">
      <button class="btn btn-p flex-1" onclick="${saveOnclick}">
        <i class="ti ti-check" aria-hidden="true"></i> ${saveLabel}
      </button>
      <button class="btn btn-s" onclick="closeModal()">Cancel</button>
    </div>`;
}

/** Standalone "Delete" button shown only to admins, when editing an existing record */
function modalDeleteButton(onclick, label = 'Delete') {
  if (S.sess?.role !== 'admin') return '';
  return `
    <button class="btn btn-d w-full mt-8" onclick="${onclick}">
      <i class="ti ti-trash" aria-hidden="true"></i> ${label}
    </button>`;
}

/* ══════════════════════════════════════════════════════════════════════
   STATUS BADGE MAPS
   ══════════════════════════════════════════════════════════════════════ */
const REQ_BADGE = { pending: 'bdg-a', approved: 'bdg-g', partial: 'bdg-b', fulfilled: 'bdg-g', rejected: 'bdg-r' };
const REQ_LABEL = { pending: 'Pending Approval', approved: 'Approved', partial: 'Partially Issued', fulfilled: 'Fulfilled', rejected: 'Rejected' };

const RC_BADGE = {
  store_issued: 'bdg-b', soft_wip: 'bdg-soft', ht_pending: 'bdg-a', ht_wip: 'bdg-a',
  hard_wip: 'bdg-hard', qc_pending: 'bdg-a', qc_cleared: 'bdg-g', dispatched: 'bdg-gr'
};
const RC_LABEL = {
  store_issued: 'Store Issued', soft_wip: 'Soft WIP', ht_pending: 'HT Pending', ht_wip: 'HT In Progress',
  hard_wip: 'Hard WIP', qc_pending: 'QC Pending', qc_cleared: 'QC Cleared', dispatched: 'Dispatched'
};

/* ══════════════════════════════════════════════════════════════════════
   SECTION 1 — INWARD RECEIPTS
   Collection: inward
     date, supplierId, supplierCode, supplierName,
     parts: [{partId,partNo,partName,qty,rate}],
     qty (total pcs), unit:'pcs', materialType (summary),
     notes, masterLotCode, deliveryNum,
     createdBy, createdAt

   masterLotCode format: YYYYMMDD-<SUPPLIER_CODE>-DLV### — generated once
   when the receipt is first saved (never changes after, even on edit).
   ══════════════════════════════════════════════════════════════════════ */
function renderInward() {
  const q = searchQ.trim().toLowerCase();
  const activeSups = S.suppliers.filter(s => s.active !== false);
  const invPendingCount = S.inward.filter(r => r.dcNo && !r.invoiceNo && !isInterCompany(r.supplierName)).length;

  let list = S.inward.filter(r => {
    if (_inwFilt === '__inv_pending__') return r.dcNo && !r.invoiceNo;
    if (_inwFilt !== 'all' && r.supplierId !== _inwFilt) return false;
    if (!q) return true;
    return (r.supplierName || '').toLowerCase().includes(q)
      || (r.masterLotCode || '').toLowerCase().includes(q)
      || (r.dcNo || '').toLowerCase().includes(q)
      || (r.invoiceNo || '').toLowerCase().includes(q)
      || (r.parts || []).some(p => (p.partName || '').toLowerCase().includes(q) || (p.partNo || '').toLowerCase().includes(q));
  });
  list = list.slice().sort((a, b) => (b.date || '').localeCompare(a.date || ''));

  document.getElementById('section-content').innerHTML = `
    ${sectionHeader('Inward Receipts', 'Add Receipt', canDo('inward') ? 'openInwardModal()' : '')}
    <div class="row-2">
      ${searchBox('Search by supplier, lot code, DC or invoice...')}
      <div class="f">
        <label for="store-filter" style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap">Filter</label>
        <select id="store-filter" onchange="_inwFilt=this.value;renderSection()">
          <option value="all" ${_inwFilt === 'all' ? 'selected' : ''}>All Receipts</option>
          ${invPendingCount ? `<option value="__inv_pending__" ${_inwFilt === '__inv_pending__' ? 'selected' : ''}>Invoice Pending (${invPendingCount})</option>` : ''}
          ${activeSups.map(s => `<option value="${s.id}" ${s.id === _inwFilt ? 'selected' : ''}>${s.name}</option>`).join('')}
        </select>
      </div>
    </div>
    ${invPendingCount && _inwFilt !== '__inv_pending__' ? `
      <div onclick="_inwFilt='__inv_pending__';renderSection()" style="display:flex;align-items:center;gap:8px;background:#fef9c3;border:1px solid #fde68a;border-radius:6px;padding:8px 12px;margin-bottom:10px;cursor:pointer;font-size:12px;color:#92400e">
        <i class="ti ti-alert-triangle"></i>
        <span><strong>${invPendingCount}</strong> receipt${invPendingCount!==1?'s':''} awaiting invoice — tap to view</span>
      </div>` : ''}
    ${recordCount(list.length)}
    ${list.length
      ? list.map(inwardRow).join('')
      : emptyState('ti-package-import', 'No inward receipts found', _inwFilt === '__inv_pending__' ? 'No receipts with pending invoices.' : 'Add a receipt to record material coming in from a supplier.')}
  `;
}

function inwardRow(r) {
  const parts = r.parts || [];
  const totalPcs = parts.reduce((s, p) => s + (+p.qty || 0), 0);
  const totalVal = parts.reduce((s, p) => s + ((+p.qty || 0) * (+p.rate || 0)), 0);
  const onclick = canDo('inward') ? `onclick="openInwardModal('${r.id}')"` : '';
  const invPending = r.dcNo && !r.invoiceNo && !isInterCompany(r.supplierName);
  const docLine = [
    r.dcNo    ? `DC: ${r.dcNo}` : '',
    r.invoiceNo ? `INV: ${r.invoiceNo}` : '',
  ].filter(Boolean).join(' · ');
  return `
    <div class="li" ${onclick}>
      <div class="li-ic" style="${invPending ? 'background:#fef9c3;color:#92400e' : ''}">
        <i class="ti ${invPending ? 'ti-alert-triangle' : 'ti-package-import'}" aria-hidden="true"></i>
      </div>
      <div class="li-body">
        <div class="li-name" style="display:flex;align-items:center;gap:8px">
          ${r.supplierName || '—'}
          ${invPending ? `<span style="font-size:10px;font-weight:700;background:#fef9c3;color:#92400e;border:1px solid #fde68a;border-radius:4px;padding:1px 6px">Invoice Pending</span>` : ''}
        </div>
        <div class="li-sub">${fmtDate(r.date)} · ${parts.length} part type${parts.length !== 1 ? 's' : ''}${r.masterLotCode ? ' · ' + r.masterLotCode : ''}${docLine ? ' · ' + docLine : ''}</div>
      </div>
      <div class="li-right">
        <div class="font-num" style="font-size:15px">${totalPcs} pcs</div>
        ${totalVal > 0 ? `<div style="font-size:11px;color:var(--txt-muted)">${fmtINR(totalVal)}</div>` : ''}
      </div>
    </div>`;
}

function openInwardModal(id) {
  const r = id ? S.inward.find(x => x.id === id) : null;
  const activeSups = S.suppliers.filter(s => s.active !== false);
  _inwParts = r && r.parts ? r.parts.map(p => ({ ...p })) : [];

  openModal(`
    <div class="modal-title">${r ? 'Edit Inward Receipt' : 'Add Inward Receipt'}</div>
    <div id="modal-err"></div>

    <div class="row-2">
      <div class="f">
        <label for="iw-date" class="f-req">Date</label>
        <input type="date" id="iw-date" value="${r ? r.date : dateStr()}" onchange="previewLotCode()">
      </div>
      <div class="f">
        <label for="iw-supplier" class="f-req">Supplier</label>
        <select id="iw-supplier" onchange="previewLotCode()">
          <option value="">— Select Supplier —</option>
          ${activeSups.map(s => `<option value="${s.id}" ${r && r.supplierId === s.id ? 'selected' : ''}>${s.name} [${s.code}]</option>`).join('')}
        </select>
      </div>
    </div>
    <div id="iw-lot-preview" class="lot-badge" style="display:${r && r.masterLotCode ? 'block' : 'none'}">
      <i class="ti ti-tag" aria-hidden="true"></i> <span id="iw-lot-val">${r?.masterLotCode || ''}</span>
    </div>

    <div class="flex justify-between items-center mb-12" style="margin-top:14px">
      <label style="font-size:12px;font-weight:600;color:var(--txt-muted)">Parts Received</label>
      <button class="btn btn-s btn-sm" onclick="inwShowAddRow()"><i class="ti ti-plus" aria-hidden="true"></i> Add Part</button>
    </div>
    <div id="iw-add-row" style="display:none;background:var(--sur2);border:1px solid var(--bdr);border-radius:var(--rs);padding:10px 12px;margin-bottom:10px">
      <div class="f" style="margin-bottom:8px">
        <label style="font-size:11px;font-weight:600;color:var(--txt-muted)">Part *</label>
        <input id="iw-new-part-name" type="text" placeholder="Type part name or number to search..." oninput="inwPartSearch(this)" onblur="setTimeout(hidePartDrop,150)" autocomplete="off">
        <input type="hidden" id="iw-new-part-id">
        <input type="hidden" id="iw-new-part-no">
      </div>
      <div class="row-2" style="margin-bottom:8px">
        <div class="f" style="margin:0"><label style="font-size:11px;font-weight:600;color:var(--txt-muted)">Qty (pcs) *</label><input id="iw-new-qty" type="number" min="1" placeholder="e.g. 200"></div>
        <div class="f" style="margin:0"><label style="font-size:11px;font-weight:600;color:var(--txt-muted)">Rate (₹/pc)</label><input id="iw-new-rate" type="number" step="0.01" placeholder="Optional"></div>
      </div>
      <div class="flex gap-8">
        <button class="btn btn-p btn-sm flex-1" onclick="inwConfirmAddRow()">Add</button>
        <button class="btn btn-s btn-sm" onclick="inwHideAddRow()">Cancel</button>
      </div>
    </div>
    <div id="iw-parts-list"></div>
    <div id="iw-parts-total" class="text-sm mb-12" style="display:none"></div>

    <div class="row-2">
      <div class="f">
        <label for="iw-dc">Delivery Challan No.</label>
        <input type="text" id="iw-dc" value="${r?.dcNo || ''}" placeholder="e.g. DC/2024/001" autocomplete="off" oninput="toggleInvHint()">
      </div>
      <div class="f">
        <label for="iw-inv">Invoice No.</label>
        <input type="text" id="iw-inv" value="${r?.invoiceNo || ''}" placeholder="e.g. INV/2024/001" autocomplete="off" oninput="toggleInvHint()">
      </div>
    </div>
    <div id="iw-inv-hint" style="display:${r?.dcNo && !r?.invoiceNo && !isInterCompany(r?.supplierName) ? 'flex' : 'none'};align-items:center;gap:6px;background:#fef9c3;border:1px solid #fde68a;border-radius:6px;padding:8px 10px;margin-bottom:12px;font-size:12px;color:#92400e">
      <i class="ti ti-alert-triangle"></i>
      DC entered without invoice — invoice can be added later when received.
    </div>

    <div class="f">
      <label for="iw-notes">Notes</label>
      <input type="text" id="iw-notes" value="${r?.notes || ''}" placeholder="Optional">
    </div>

    ${modalActions(r ? 'Update Receipt' : 'Save Receipt', `saveInward(${r ? `'${r.id}'` : 'null'})`)}
    ${r ? modalDeleteButton(`deleteInward('${r.id}')`, 'Delete Receipt') : ''}
  `);

  if (r && r.supplierId) setTimeout(() => previewLotCode(r), 50);
  setTimeout(() => inwRenderParts(), 50);
}

/* Inter-company suppliers (own group) transact on DC only — no invoice required. */
function isInterCompany(supplierName) {
  return /indo.?meta.?forge/i.test(supplierName || '');
}

function toggleInvHint() {
  const dc  = (document.getElementById('iw-dc')?.value  || '').trim();
  const inv = (document.getElementById('iw-inv')?.value || '').trim();
  const hint = document.getElementById('iw-inv-hint');
  if (!hint) return;
  const sel = document.getElementById('iw-supplier');
  const supName = sel ? (sel.options[sel.selectedIndex]?.text || '') : '';
  hint.style.display = (dc && !inv && !isInterCompany(supName)) ? 'flex' : 'none';
}

function inwShowAddRow() {
  const row = document.getElementById('iw-add-row');
  if (row) row.style.display = 'block';
  setTimeout(() => document.getElementById('iw-new-part-name')?.focus(), 80);
}
function inwHideAddRow() {
  const row = document.getElementById('iw-add-row');
  if (row) row.style.display = 'none';
  ['iw-new-part-name', 'iw-new-part-id', 'iw-new-part-no', 'iw-new-qty', 'iw-new-rate'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
}
function inwPartSearch(inputEl) {
  if (!inputEl.value.trim()) { hidePartDrop(); return; }
  showPartDrop(inputEl, (p) => {
    document.getElementById('iw-new-part-id').value = p.id;
    document.getElementById('iw-new-part-no').value = p.no;
  });
}
function inwConfirmAddRow() {
  const name = getField('iw-new-part-name');
  const pid  = getField('iw-new-part-id');
  const pno  = getField('iw-new-part-no');
  const qty  = parseInt(getField('iw-new-qty')) || 0;
  const rate = parseFloat(getField('iw-new-rate')) || 0;

  if (!name || !pid) { toast('Search and select a part first'); return; }
  if (!qty || qty < 1) { toast('Enter a valid quantity'); return; }

  _inwParts.push({ partId: pid, partNo: pno, partName: name, qty, rate });
  inwHideAddRow();
  inwRenderParts();
}
function inwRenderParts() {
  const w = document.getElementById('iw-parts-list');
  if (!w) return;
  if (!_inwParts.length) {
    w.innerHTML = `<div class="text-sm text-muted" style="padding:8px 0;text-align:center">No parts added yet</div>`;
    const tot = document.getElementById('iw-parts-total');
    if (tot) tot.style.display = 'none';
    return;
  }
  w.innerHTML = _inwParts.map((p, i) => `
    <div style="background:var(--sur);border:1px solid var(--bdr);border-radius:var(--rs);padding:10px 12px;margin-bottom:8px">
      <div class="flex justify-between items-center gap-8">
        <div style="flex:1;min-width:0">
          <div style="font-weight:700;font-size:13px">${p.partName || '—'}</div>
          <div class="mono text-xs text-muted">${p.partNo || '—'}</div>
        </div>
        <button onclick="_inwParts.splice(${i},1);inwRenderParts()" class="btn btn-d btn-sm" aria-label="Remove part">
          <i class="ti ti-x" aria-hidden="true"></i>
        </button>
      </div>
      <div class="row-2 mt-8">
        <div class="f" style="margin:0">
          <label style="font-size:10px;font-weight:700;color:var(--txt-muted);text-transform:uppercase">Qty (pcs)</label>
          <input type="number" min="1" value="${p.qty || ''}" onchange="_inwParts[${i}].qty=Math.max(1,+this.value||1);inwRenderParts()">
        </div>
        <div class="f" style="margin:0">
          <label style="font-size:10px;font-weight:700;color:var(--txt-muted);text-transform:uppercase">Rate (₹/pc)</label>
          <input type="number" min="0" step="0.01" value="${p.rate || ''}" onchange="_inwParts[${i}].rate=parseFloat(this.value)||0;inwRenderParts()">
        </div>
      </div>
    </div>`).join('');
  inwRenderTotal();
}
function inwRenderTotal() {
  const tot = document.getElementById('iw-parts-total');
  if (!tot) return;
  const totalPcs = _inwParts.reduce((s, p) => s + (+p.qty || 0), 0);
  const totalVal = _inwParts.reduce((s, p) => s + (+p.qty || 0) * (+p.rate || 0), 0);
  if (_inwParts.length) {
    tot.style.display = 'block';
    tot.innerHTML = `<i class="ti ti-stack-2" aria-hidden="true"></i> ${totalPcs} pcs total across ${_inwParts.length} part type${_inwParts.length !== 1 ? 's' : ''}${totalVal > 0 ? ' · ' + fmtINR(totalVal) : ''}`;
  } else {
    tot.style.display = 'none';
  }
}

/** Live preview of the auto-generated Master Lot Code while adding a new receipt */
function previewLotCode(existingRec) {
  const sel = document.getElementById('iw-supplier');
  const preview = document.getElementById('iw-lot-preview');
  const val = document.getElementById('iw-lot-val');
  if (!sel || !preview || !val) return;

  if (existingRec && existingRec.masterLotCode) {
    preview.style.display = 'block';
    val.textContent = existingRec.masterLotCode;
    return;
  }

  const supplierId = sel.value;
  if (!supplierId) { preview.style.display = 'none'; return; }
  const sup = S.suppliers.find(s => s.id === supplierId);
  if (!sup) return;

  const date = document.getElementById('iw-date')?.value || dateStr();
  const ymd  = date.replace(/-/g, '');
  const existing = S.inward.filter(r => r.supplierId === supplierId).length;
  const dlvNum = String(existing + 1).padStart(3, '0');

  preview.style.display = 'block';
  val.textContent = `${ymd}-${sup.code}-DLV${dlvNum}`;
}

async function saveInward(editId) {
  const supplierId = document.getElementById('iw-supplier').value;
  const date = document.getElementById('iw-date').value;

  if (!supplierId) { showModalError('Supplier is required.'); return; }
  if (!date) { showModalError('Date is required.'); return; }
  if (!_inwParts.length) { showModalError('Add at least one part.'); return; }
  if (_inwParts.some(p => !p.qty || p.qty < 1)) { showModalError('All parts must have a valid quantity.'); return; }

  const sup = S.suppliers.find(s => s.id === supplierId);
  if (!sup) { showModalError('Invalid supplier.'); return; }

  const totalPcs  = _inwParts.reduce((s, p) => s + (+p.qty || 0), 0);
  const matSummary = _inwParts.map(p => p.partName).join(', ');

  let masterLotCode, deliveryNum;
  if (editId) {
    const existing = S.inward.find(r => r.id === editId);
    masterLotCode = existing?.masterLotCode || '';
    deliveryNum   = existing?.deliveryNum || 0;
  } else {
    deliveryNum = S.inward.filter(r => r.supplierId === supplierId).length + 1;
    const ymd = date.replace(/-/g, '');
    masterLotCode = `${ymd}-${sup.code}-DLV${String(deliveryNum).padStart(3, '0')}`;
  }

  const data = {
    date, supplierId, supplierCode: sup.code, supplierName: sup.name,
    parts: _inwParts.map(p => ({ ...p })),
    qty: totalPcs, unit: 'pcs', materialType: matSummary,
    notes: getField('iw-notes'),
    dcNo:      (getField('iw-dc')  || '').trim(),
    invoiceNo: (getField('iw-inv') || '').trim(),
    masterLotCode, deliveryNum
  };

  try {
    if (editId) {
      const before = S.inward.find(x => x.id === editId);
      await db.collection('inward').doc(editId).update(data);
      await logAudit('UPDATE_INWARD', 'STORE', editId, before, data);
    } else {
      const ref = await db.collection('inward').add({ ...data, createdBy: S.sess.userId, createdAt: serverTS() });
      await logAudit('CREATE_INWARD', 'STORE', ref.id, null, data);
    }
    closeModal();
    await refreshStore('inward');
    renderSection();
    toast(editId ? 'Receipt updated' : 'Inward receipt saved');
  } catch (e) {
    showModalError(e.message);
  }
}

async function deleteInward(id) {
  if (!confirm('Delete this inward receipt? This cannot be undone.')) return;
  try {
    const before = S.inward.find(x => x.id === id);
    await db.collection('inward').doc(id).delete();
    await logAudit('DELETE_INWARD', 'STORE', id, before, null);
    closeModal();
    await refreshStore('inward');
    renderSection();
    toast('Receipt deleted');
  } catch (e) {
    showModalError(e.message);
  }
}

/* ══════════════════════════════════════════════════════════════════════
   SECTION 2 — REQUISITIONS
   Collection: requisitions
     reqNo (REQ-YYMM-NNN), date, neededBy, notes,
     lines: [{lineNo,partId,partNo,partName,customerId,customerName,
              masterLotCode,qtyRequested,qtyApproved,qtyIssued}],
     status: pending | approved | partial | fulfilled | rejected,
     requestedBy, requestedByName,
     approvedBy, approvedByName, approvedAt, rejectionReason
   ══════════════════════════════════════════════════════════════════════ */
function genReqNo() {
  const now = new Date();
  const yymm = String(now.getFullYear()).slice(2) + String(now.getMonth() + 1).padStart(2, '0');
  const monthReqs = S.requisitions.filter(r => (r.reqNo || '').includes('-' + yymm + '-')).length;
  return `REQ-${yymm}-${String(monthReqs + 1).padStart(3, '0')}`;
}

function renderRequisitions() {
  const q = searchQ.trim().toLowerCase();
  let list = S.requisitions.filter(r => {
    if (_reqFilt !== 'all' && r.status !== _reqFilt) return false;
    if (!q) return true;
    return (r.reqNo || '').toLowerCase().includes(q)
      || (r.lines || []).some(l => (l.partName || '').toLowerCase().includes(q) || (l.partNo || '').toLowerCase().includes(q));
  });
  list = list.slice().sort((a, b) => (b.reqNo || '').localeCompare(a.reqNo || ''));

  const filterOpts = [
    { v: 'all', l: 'All Statuses' },
    { v: 'pending', l: 'Pending Approval' },
    { v: 'approved', l: 'Approved' },
    { v: 'partial', l: 'Partially Issued' },
    { v: 'fulfilled', l: 'Fulfilled' },
    { v: 'rejected', l: 'Rejected' },
  ];

  document.getElementById('section-content').innerHTML = `
    ${sectionHeader('Requisitions', 'New Requisition', canDo('inward') ? 'openRequisitionModal()' : '')}
    <div class="row-2">
      ${searchBox('Search by Req No. or part...')}
      <div class="f">
        <label for="store-filter" style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap">Filter by status</label>
        <select id="store-filter" onchange="_reqFilt=this.value;renderSection()">
          ${filterOpts.map(o => `<option value="${o.v}" ${o.v === _reqFilt ? 'selected' : ''}>${o.l}</option>`).join('')}
        </select>
      </div>
    </div>
    ${recordCount(list.length)}
    ${list.length
      ? list.map(requisitionRow).join('')
      : emptyState('ti-clipboard-list', 'No requisitions found', 'Create a requisition to request material from Store.')}
  `;
}

function requisitionRow(r) {
  const lines = r.lines || [];
  const totalReq = lines.reduce((s, l) => s + (+l.qtyRequested || 0), 0);
  return `
    <div class="li" onclick="viewRequisitionModal('${r.id}')">
      <div class="li-ic"><i class="ti ti-clipboard-list" aria-hidden="true"></i></div>
      <div class="li-body">
        <div class="li-name">${r.reqNo || '—'}</div>
        <div class="li-sub">${fmtDate(r.date)} · ${lines.length} line${lines.length !== 1 ? 's' : ''} · ${totalReq} pcs requested</div>
      </div>
      <div class="li-right">
        <span class="bdg ${REQ_BADGE[r.status] || 'bdg-gr'}"><span class="bdg-dot"></span>${REQ_LABEL[r.status] || r.status}</span>
      </div>
    </div>`;
}

function openRequisitionModal(editId) {
  const req = editId ? S.requisitions.find(r => r.id === editId) : null;
  _reqLines = req && req.lines ? req.lines.map(l => ({ ...l })) : [];
  const reqNo = req ? req.reqNo : genReqNo();

  openModal(`
    <div class="modal-title">${req ? 'Edit Requisition' : 'New Requisition'}</div>
    <div class="text-sm text-muted mb-12 mono">${reqNo}</div>
    <div id="modal-err"></div>

    <div class="row-2">
      <div class="f">
        <label for="rq-date" class="f-req">Date</label>
        <input type="date" id="rq-date" value="${req ? req.date : dateStr()}">
      </div>
      <div class="f">
        <label for="rq-needby">Needed By</label>
        <input type="date" id="rq-needby" value="${req?.neededBy || ''}">
      </div>
    </div>

    <div class="flex justify-between items-center mb-12">
      <label style="font-size:12px;font-weight:600;color:var(--txt-muted)">Material Lines</label>
      <button class="btn btn-s btn-sm" onclick="reqShowAddLine()"><i class="ti ti-plus" aria-hidden="true"></i> Add Part</button>
    </div>
    <div id="rq-add-row" style="display:none;background:var(--sur2);border:1px solid var(--bdr);border-radius:var(--rs);padding:10px 12px;margin-bottom:10px">
      <div class="f" style="margin-bottom:8px">
        <label style="font-size:11px;font-weight:600;color:var(--txt-muted)">Part *</label>
        <input id="rq-new-part" type="text" placeholder="Type part name or number to search..." oninput="reqPartSearch(this)" onblur="setTimeout(hidePartDrop,150)" autocomplete="off">
        <input type="hidden" id="rq-new-pid">
        <input type="hidden" id="rq-new-pno">
        <input type="hidden" id="rq-new-cid">
        <input type="hidden" id="rq-new-cname">
      </div>
      <div id="rq-stock-badge" class="text-xs mb-8" style="display:none"></div>
      <div class="row-2" style="margin-bottom:8px">
        <div class="f" style="margin:0"><label style="font-size:11px;font-weight:600;color:var(--txt-muted)">Qty Required *</label><input id="rq-new-qty" type="number" min="1" placeholder="e.g. 100"></div>
        <div class="f" style="margin:0"><label style="font-size:11px;font-weight:600;color:var(--txt-muted)">Lot Code (optional)</label><input id="rq-new-lot" type="text" placeholder="e.g. 20250610-IMF-DLV001"></div>
      </div>
      <div class="flex gap-8">
        <button class="btn btn-p btn-sm flex-1" onclick="reqConfirmLine()">Add</button>
        <button class="btn btn-s btn-sm" onclick="reqHideAddLine()">Cancel</button>
      </div>
    </div>
    <div id="rq-lines-list"></div>

    <div class="f">
      <label for="rq-notes">Notes</label>
      <input type="text" id="rq-notes" value="${req?.notes || ''}" placeholder="Optional">
    </div>

    ${modalActions(req ? 'Update Requisition' : 'Submit Requisition', `saveRequisition(${req ? `'${req.id}'` : 'null'})`)}
  `);

  setTimeout(() => reqRenderLines(), 50);
}

function reqShowAddLine() {
  const row = document.getElementById('rq-add-row');
  if (row) row.style.display = 'block';
  setTimeout(() => document.getElementById('rq-new-part')?.focus(), 80);
}
function reqHideAddLine() {
  const row = document.getElementById('rq-add-row');
  if (row) row.style.display = 'none';
  ['rq-new-part', 'rq-new-pid', 'rq-new-pno', 'rq-new-cid', 'rq-new-cname', 'rq-new-qty', 'rq-new-lot'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  const badge = document.getElementById('rq-stock-badge');
  if (badge) badge.style.display = 'none';
}
function reqPartSearch(inputEl) {
  if (!inputEl.value.trim()) { hidePartDrop(); return; }
  showPartDrop(inputEl, (p) => {
    document.getElementById('rq-new-pid').value = p.id;
    document.getElementById('rq-new-pno').value = p.no;
    const cust = S.customers.find(c => c.id === p.customerId);
    document.getElementById('rq-new-cid').value = cust ? cust.id : '';
    document.getElementById('rq-new-cname').value = cust ? cust.name : '';
    reqShowStockBadge(p.id);
  });
}
function reqCalcStock(partId) {
  const totalIn = S.inward.reduce((s, iw) => s + (iw.parts || []).filter(p => p.partId === partId).reduce((a, p) => a + (+p.qty || 0), 0), 0);
  const totalIssued = S.routeCards.filter(rc => rc.partId === partId).reduce((s, rc) => s + (+rc.issuedQty || 0), 0);
  return Math.max(0, totalIn - totalIssued);
}
function reqShowStockBadge(partId) {
  const badge = document.getElementById('rq-stock-badge');
  if (!badge) return;
  const avail = reqCalcStock(partId);
  badge.style.display = 'block';
  badge.innerHTML = `<span class="bdg ${avail > 0 ? 'bdg-g' : 'bdg-r'}"><i class="ti ti-package" aria-hidden="true"></i> Available Store Stock: ${avail} pcs</span>`;
}
function reqConfirmLine() {
  const name = getField('rq-new-part');
  const pid  = getField('rq-new-pid');
  const pno  = getField('rq-new-pno');
  const cid  = getField('rq-new-cid');
  const cname = getField('rq-new-cname');
  const qty  = parseInt(getField('rq-new-qty')) || 0;
  const lot  = getField('rq-new-lot');

  if (!name || !pid) { toast('Search and select a part first'); return; }
  if (!qty || qty < 1) { toast('Enter a valid quantity'); return; }

  _reqLines.push({
    lineNo: _reqLines.length + 1, partId: pid, partNo: pno, partName: name,
    customerId: cid, customerName: cname, masterLotCode: lot,
    qtyRequested: qty, qtyApproved: 0, qtyIssued: 0
  });
  reqHideAddLine();
  reqRenderLines();
}
function reqRenderLines() {
  const w = document.getElementById('rq-lines-list');
  if (!w) return;
  if (!_reqLines.length) {
    w.innerHTML = `<div class="text-sm text-muted" style="padding:8px 0;text-align:center">No parts added yet</div>`;
    return;
  }
  w.innerHTML = _reqLines.map((l, i) => `
    <div style="background:var(--sur);border:1px solid var(--bdr);border-radius:var(--rs);padding:10px 12px;margin-bottom:8px">
      <div class="flex justify-between items-center gap-8">
        <div style="flex:1;min-width:0">
          <div style="font-weight:700;font-size:13px">${l.partName}</div>
          <div class="mono text-xs text-muted">${l.partNo}${l.customerName ? ' · ' + l.customerName : ''}</div>
          ${l.masterLotCode ? `<div class="text-xs" style="color:var(--ok);margin-top:2px"><i class="ti ti-tag" aria-hidden="true"></i> ${l.masterLotCode}</div>` : ''}
        </div>
        <div style="text-align:right;flex-shrink:0">
          <div class="font-num" style="font-size:16px">${l.qtyRequested}</div>
          <div class="text-xs text-muted">pcs</div>
        </div>
        <button onclick="_reqLines.splice(${i},1);reqRenderLines()" class="btn btn-d btn-sm" aria-label="Remove line">
          <i class="ti ti-x" aria-hidden="true"></i>
        </button>
      </div>
    </div>`).join('');
}

async function saveRequisition(editId) {
  if (!_reqLines.length) { showModalError('Add at least one part.'); return; }
  const date = document.getElementById('rq-date').value;
  if (!date) { showModalError('Date is required.'); return; }
  const neededBy = document.getElementById('rq-needby').value;

  const reqNo = editId ? S.requisitions.find(r => r.id === editId)?.reqNo : genReqNo();
  const data = {
    reqNo, date, neededBy, notes: getField('rq-notes'),
    lines: _reqLines, status: 'pending',
    requestedBy: S.sess.userId, requestedByName: S.sess.name,
    approvedBy: '', approvedByName: '', approvedAt: '', rejectionReason: ''
  };

  try {
    if (editId) {
      const before = S.requisitions.find(x => x.id === editId);
      await db.collection('requisitions').doc(editId).update({ ...data, updatedAt: serverTS() });
      await logAudit('UPDATE_REQUISITION', 'STORE', editId, before, data);
    } else {
      const ref = await db.collection('requisitions').add({ ...data, createdAt: serverTS() });
      await logAudit('CREATE_REQUISITION', 'STORE', ref.id, null, data);
    }
    closeModal();
    await refreshStore('requisitions');
    renderSection();
    toast(editId ? 'Requisition updated' : 'Requisition submitted');
  } catch (e) {
    showModalError(e.message);
  }
}

function viewRequisitionModal(id) {
  const r = S.requisitions.find(x => x.id === id);
  if (!r) return;

  let body = `
    <div class="modal-title">${r.reqNo}</div>
    <div class="flex items-center gap-8 mb-12">
      <span class="bdg ${REQ_BADGE[r.status] || 'bdg-gr'}"><span class="bdg-dot"></span>${REQ_LABEL[r.status] || r.status}</span>
      <span class="text-sm text-muted">${fmtDate(r.date)}${r.neededBy ? ' · Needed by ' + fmtDate(r.neededBy) : ''}</span>
    </div>`;

  (r.lines || []).forEach(l => {
    const issued = S.routeCards.filter(rc => rc.requisitionId === r.id && rc.lineNo === l.lineNo).reduce((s, rc) => s + (+rc.issuedQty || 0), 0);
    body += `
      <div style="background:var(--sur2);border-radius:var(--rs);padding:10px 12px;margin-bottom:8px">
        <div style="font-weight:700">${l.partName} <span class="mono text-xs text-muted">${l.partNo}</span></div>
        <div class="text-sm text-muted">${l.customerName || '—'}</div>
        <div class="flex gap-12 mt-8 text-sm">
          <span>Requested: <strong>${l.qtyRequested}</strong></span>
          ${l.qtyApproved ? `<span style="color:var(--ok)">Approved: <strong>${l.qtyApproved}</strong></span>` : ''}
          ${issued ? `<span style="color:var(--imf-navy)">Issued: <strong>${issued}</strong></span>` : ''}
        </div>
      </div>`;
  });

  if (r.approvedByName) body += `<div class="text-sm text-muted mb-8">Approved by ${r.approvedByName}</div>`;
  if (r.rejectionReason) body += `<div class="ebox mb-8"><i class="ti ti-alert-triangle" aria-hidden="true"></i><span>Rejected: ${r.rejectionReason}</span></div>`;
  if (r.notes) body += `<div class="text-sm text-muted mt-8">${r.notes}</div>`;

  body += `<div class="flex gap-8 mt-16">`;
  if (r.status === 'pending' && r.requestedBy === S.sess.userId) {
    body += `<button class="btn btn-p flex-1" onclick="closeModal();openRequisitionModal('${r.id}')"><i class="ti ti-edit" aria-hidden="true"></i> Edit</button>`;
    body += `<button class="btn btn-d" onclick="cancelRequisition('${r.id}')"><i class="ti ti-x" aria-hidden="true"></i> Cancel</button>`;
  }
  body += `<button class="btn btn-s flex-1" onclick="closeModal()">Close</button>`;
  body += `</div>`;

  openModal(body);
}

async function cancelRequisition(id) {
  if (!confirm('Cancel this requisition?')) return;
  try {
    await db.collection('requisitions').doc(id).update({ status: 'rejected', rejectionReason: 'Cancelled by requester', updatedAt: serverTS() });
    await logAudit('CANCEL_REQUISITION', 'STORE', id, null, { status: 'rejected' });
    closeModal();
    await refreshStore('requisitions');
    renderSection();
    toast('Requisition cancelled');
  } catch (e) {
    toast('Error: ' + e.message);
  }
}

/* ══════════════════════════════════════════════════════════════════════
   SECTION 3 — APPROVALS
   Admin / Store HOD review pending requisitions, set per-line approved
   quantity (≤ requested), then approve or reject.
   ══════════════════════════════════════════════════════════════════════ */
function renderApprovals() {
  const pending = S.requisitions.filter(r => r.status === 'pending');
  const recent  = S.requisitions.filter(r => ['approved', 'rejected'].includes(r.status))
    .slice().sort((a, b) => (b.reqNo || '').localeCompare(a.reqNo || '')).slice(0, 10);

  document.getElementById('section-content').innerHTML = `
    <div style="font-size:16px;font-weight:700;margin-bottom:12px">Approvals</div>
    ${pending.length
      ? `<div class="slbl mb-8">Awaiting Approval (${pending.length})</div>${pending.map(r => approvalCard(r, true)).join('')}`
      : `<div class="empty"><div class="empty-ic"><i class="ti ti-checklist" aria-hidden="true"></i></div><h3>No pending approvals</h3><p>All requisitions have been processed.</p></div>`}
    ${recent.length ? `<div class="slbl mb-8 mt-16">Recently Processed</div>${recent.map(r => approvalCard(r, false)).join('')}` : ''}
  `;
}

function approvalCard(r, isPending) {
  return `
    <div class="card" style="margin-bottom:10px">
      <div class="flex justify-between items-center mb-8">
        <div>
          <div style="font-weight:700">${r.reqNo}</div>
          <div class="text-sm text-muted">By ${r.requestedByName || '—'} · ${fmtDate(r.date)}</div>
        </div>
        <span class="bdg ${REQ_BADGE[r.status] || 'bdg-gr'}"><span class="bdg-dot"></span>${REQ_LABEL[r.status] || r.status}</span>
      </div>
      ${(r.lines || []).map(l => `
        <div style="background:var(--sur2);border-radius:var(--rs);padding:8px 10px;margin-bottom:6px">
          <div style="font-weight:700;font-size:13px">${l.partName} <span class="mono text-xs text-muted">${l.partNo}</span></div>
          <div class="text-sm text-muted">${l.customerName || '—'}</div>
          <div class="flex gap-8 items-center mt-8">
            <span class="text-sm">Requested: <strong>${l.qtyRequested} pcs</strong></span>
            ${isPending
              ? `<input id="appr-qty-${r.id}-${l.lineNo}" type="number" min="0" max="${l.qtyRequested}" value="${l.qtyRequested}" style="width:90px;margin-left:auto" placeholder="Approve qty">`
              : (l.qtyApproved ? `<span style="color:var(--ok);font-weight:700;margin-left:auto">Approved: ${l.qtyApproved}</span>` : '')}
          </div>
        </div>`).join('')}
      ${isPending ? `
        <div class="f" style="margin-top:8px"><label style="font-size:11px">Remarks (optional)</label><input id="appr-rmk-${r.id}" type="text" placeholder="Notes for requester..."></div>
        <div class="flex gap-8 mt-8">
          <button class="btn btn-ok flex-1" onclick="approveRequisition('${r.id}')"><i class="ti ti-check" aria-hidden="true"></i> Approve</button>
          <button class="btn btn-d flex-1" onclick="rejectRequisition('${r.id}')"><i class="ti ti-x" aria-hidden="true"></i> Reject</button>
        </div>`
        : (r.approvedByName ? `<div class="text-sm text-muted mt-8">${r.status === 'approved' ? 'Approved' : 'Rejected'} by ${r.approvedByName}</div>` : '')}
    </div>`;
}

async function approveRequisition(id) {
  const r = S.requisitions.find(x => x.id === id);
  if (!r) return;
  const updatedLines = r.lines.map(l => {
    const qtyEl = document.getElementById(`appr-qty-${id}-${l.lineNo}`);
    const qty = qtyEl ? parseInt(qtyEl.value) || 0 : l.qtyRequested;
    return { ...l, qtyApproved: Math.min(qty, l.qtyRequested) };
  });
  const rmk = getField(`appr-rmk-${id}`);
  try {
    await db.collection('requisitions').doc(id).update({
      status: 'approved', lines: updatedLines,
      approvedBy: S.sess.userId, approvedByName: S.sess.name, approvedAt: serverTS(),
      notes: rmk || r.notes || '', updatedAt: serverTS()
    });
    await logAudit('APPROVE_REQUISITION', 'STORE', id, r, { status: 'approved', lines: updatedLines });
    await refreshStore('requisitions');
    renderSection();
    toast('Requisition approved');
  } catch (e) {
    toast('Error: ' + e.message);
  }
}

async function rejectRequisition(id) {
  const rmk = getField(`appr-rmk-${id}`);
  if (!rmk) { toast('Please enter a reason for rejection'); return; }
  try {
    const before = S.requisitions.find(x => x.id === id);
    await db.collection('requisitions').doc(id).update({
      status: 'rejected', rejectionReason: rmk,
      approvedBy: S.sess.userId, approvedByName: S.sess.name, approvedAt: serverTS(),
      updatedAt: serverTS()
    });
    await logAudit('REJECT_REQUISITION', 'STORE', id, before, { status: 'rejected', rejectionReason: rmk });
    await refreshStore('requisitions');
    renderSection();
    toast('Requisition rejected');
  } catch (e) {
    toast('Error: ' + e.message);
  }
}

/* ══════════════════════════════════════════════════════════════════════
   SECTION 4 — ISSUE TO WIP
   Store selects an approved/partial requisition + line, scans physical
   TAGs and assigns quantities to each, then submits the session.
   Each TAG becomes a routeCards/{tagId} doc ("child" of the master lot
   / requisition), sharing one batchCode for the session:
     batchCode = `${masterLotCode}-${ymd}-${issueCountForLine+1}`
   ══════════════════════════════════════════════════════════════════════ */
function issLineIssued(reqId, lineNo) {
  return S.routeCards.filter(rc => rc.requisitionId === reqId && rc.lineNo === lineNo)
    .reduce((s, rc) => s + (+rc.issuedQty || 0), 0);
}

function renderIssue() {
  const approved = S.requisitions.filter(r => r.status === 'approved' || r.status === 'partial');

  document.getElementById('section-content').innerHTML = `
    <div style="font-size:16px;font-weight:700;margin-bottom:12px">Issue to WIP</div>
    ${!approved.length
      ? emptyState('ti-clipboard-check', 'No approved requisitions', 'Requisitions must be approved before material can be issued.')
      : `
        <div class="slbl mb-8">Select Requisition to Fulfil</div>
        ${approved.map(r => {
          const remLines = (r.lines || []).filter(l => (l.qtyApproved - issLineIssued(r.id, l.lineNo)) > 0);
          const selected = _issReq?.id === r.id;
          return `
          <div class="card" style="margin-bottom:8px;cursor:pointer;border:1.5px solid ${selected ? 'var(--imf-navy)' : 'var(--bdr)'}" onclick="issSelectRequisition('${r.id}')">
            <div class="flex justify-between items-center">
              <div>
                <div style="font-weight:700">${r.reqNo}</div>
                <div class="text-sm text-muted">By ${r.requestedByName || '—'}${r.neededBy ? ' · Needed by ' + fmtDate(r.neededBy) : ''}</div>
              </div>
              <span class="bdg ${REQ_BADGE[r.status] || 'bdg-gr'}"><span class="bdg-dot"></span>${REQ_LABEL[r.status] || r.status}</span>
            </div>
            <div class="mt-8">
              ${remLines.map(l => `<div class="text-sm" style="padding:2px 0"><strong>${l.partName}</strong> · <span style="color:var(--imf-navy);font-weight:700">${l.qtyApproved - issLineIssued(r.id, l.lineNo)} pcs remaining</span></div>`).join('')}
            </div>
          </div>`;
        }).join('')}
        <div id="iss-line-select"></div>
        <div id="iss-tag-section"></div>
      `}
  `;

  if (_issReq) issRenderLineSelect();
  if (_issLine) issRenderTagSection();
}

function issSelectRequisition(id) {
  _issReq = S.requisitions.find(r => r.id === id) || null;
  _issLine = null; _issTags = []; _issBatchCode = '';
  renderIssue();
}

function issRenderLineSelect() {
  const w = document.getElementById('iss-line-select');
  if (!w || !_issReq) return;
  const activeLines = _issReq.lines.filter(l => (l.qtyApproved - issLineIssued(_issReq.id, l.lineNo)) > 0);

  w.innerHTML = `
    <div class="slbl mb-8 mt-16">Select Part Line to Issue</div>
    ${activeLines.map(l => {
      const issued = issLineIssued(_issReq.id, l.lineNo);
      const rem = l.qtyApproved - issued;
      const selected = _issLine?.lineNo === l.lineNo;
      return `
      <div class="card" style="margin-bottom:8px;cursor:pointer;border:1.5px solid ${selected ? 'var(--imf-navy)' : 'var(--bdr)'}" onclick="issSelectLine(${l.lineNo})">
        <div style="font-weight:700">${l.partName}</div>
        <div class="text-sm text-muted">${l.partNo}${l.customerName ? ' · ' + l.customerName : ''}</div>
        <div class="flex gap-12 mt-8 text-sm">
          <span>Approved: <strong>${l.qtyApproved}</strong></span>
          <span>Issued so far: <strong>${issued}</strong></span>
          <span style="color:var(--imf-navy);font-weight:700">Remaining: ${rem}</span>
        </div>
      </div>`;
    }).join('')}
  `;
}

/** Resolve the master lot code for the currently-selected line */
function issMasterLot() {
  if (!_issLine) return 'LOT-UNKNOWN';
  if (_issLine.masterLotCode) return _issLine.masterLotCode;
  const lot = S.inward.find(iw => (iw.parts || []).some(p => p.partId === _issLine.partId || p.partName === _issLine.partName));
  return lot ? lot.masterLotCode : 'LOT-UNKNOWN';
}

function issSelectLine(lineNo) {
  if (!_issReq) return;
  _issLine = _issReq.lines.find(l => l.lineNo === lineNo) || null;
  if (!_issLine) return;
  _issTags = [];

  const ymd = dateStr().replace(/-/g, '');
  const issCount = S.routeCards.filter(rc => rc.requisitionId === _issReq.id && rc.lineNo === _issLine.lineNo).length;
  _issBatchCode = `${issMasterLot()}-${ymd}-${issCount + 1}`;

  issRenderLineSelect();
  issRenderTagSection();
}

function issRenderTagSection() {
  const w = document.getElementById('iss-tag-section');
  if (!w || !_issLine) return;

  const issued = issLineIssued(_issReq.id, _issLine.lineNo);
  const remaining = _issLine.qtyApproved - issued;
  const sessionTotal = _issTags.reduce((s, t) => s + (+t.qty || 0), 0);
  const canAddMore = sessionTotal < remaining;

  w.innerHTML = `
    <div class="card mt-8">
      <div class="card-hd"><i class="ti ti-tags" aria-hidden="true"></i> Scan TAGs — ${_issLine.partName}</div>
      <div class="flex gap-12 mb-12 text-sm" style="background:var(--sur2);padding:8px 10px;border-radius:var(--rs)">
        <span>Approved: <strong>${_issLine.qtyApproved}</strong></span>
        <span>Session: <strong style="color:${sessionTotal > 0 ? 'var(--imf-navy)' : 'var(--txt-muted)'}">${sessionTotal}</strong></span>
        <span>Remaining: <strong style="color:${remaining - sessionTotal > 0 ? 'var(--ok)' : 'var(--err)'}">${remaining - sessionTotal}</strong></span>
      </div>

      ${canAddMore ? `
        <button class="qr-scan-btn mb-12" onclick="issScanTag()"><i class="ti ti-qrcode" aria-hidden="true"></i> Scan TAG</button>
        <div class="row-2 mb-12">
          <div class="f" style="margin:0">
            <label>TAG Number</label>
            <input id="iss-tag-input" type="text" placeholder="e.g. TAG042" oninput="this.value=this.value.toUpperCase()" autocomplete="off" onkeydown="if(event.key==='Enter'){event.preventDefault();issAddTag()}">
          </div>
          <div class="f" style="margin:0">
            <label>Qty for this TAG</label>
            <input id="iss-tag-qty" type="number" min="1" max="${remaining - sessionTotal}" placeholder="e.g. 25">
          </div>
        </div>
        <button class="btn btn-p w-full" onclick="issAddTag()">Add TAG to Session</button>
      ` : `<div class="sbox"><i class="ti ti-circle-check" aria-hidden="true"></i><span>Full approved quantity assigned across TAGs.</span></div>`}

      ${_issTags.length ? `
        <div class="slbl mt-16 mb-8">TAGs in this Session (${_issTags.length})</div>
        ${_issTags.map((t, i) => `
          <div class="li" style="cursor:default">
            <div class="li-ic"><i class="ti ti-tag" aria-hidden="true"></i></div>
            <div class="li-body">
              <div class="li-name mono">${t.tagId}</div>
              <div class="li-sub">${t.qty} pcs</div>
            </div>
            <button class="btn btn-d btn-sm" onclick="issRemoveTag(${i})" aria-label="Remove TAG"><i class="ti ti-x" aria-hidden="true"></i></button>
          </div>`).join('')}
        <div class="lot-badge mt-8"><i class="ti ti-barcode" aria-hidden="true"></i> Batch: ${_issBatchCode}</div>
        <button class="btn btn-p w-full mt-12" onclick="issSubmitSession()">
          <i class="ti ti-send" aria-hidden="true"></i> Issue ${_issTags.length} TAG${_issTags.length > 1 ? 's' : ''} (${sessionTotal} pcs) to WIP
        </button>
      ` : ''}
    </div>`;
}

function issScanTag() {
  openQrScanner((tagId) => {
    setField('iss-tag-input', tagId);
    document.getElementById('iss-tag-qty')?.focus();
  }, 'Scan Route Card TAG');
}

async function issAddTag() {
  const tagId = getField('iss-tag-input').toUpperCase();
  const qty = parseInt(getField('iss-tag-qty')) || 0;
  const issued = issLineIssued(_issReq.id, _issLine.lineNo);
  const remaining = _issLine.qtyApproved - issued;
  const sessionTotal = _issTags.reduce((s, t) => s + (+t.qty || 0), 0);

  if (!tagId) { toast('Enter or scan a TAG number'); return; }
  if (!/^TAG\d+$/.test(tagId)) { toast('Invalid TAG format. Expected TAG001, TAG042, etc.'); return; }
  if (!qty || qty < 1) { toast('Enter a quantity for this TAG'); return; }
  if (sessionTotal + qty > remaining) { toast(`Only ${remaining - sessionTotal} pcs remaining to issue`); return; }
  if (_issTags.find(t => t.tagId === tagId)) { toast(tagId + ' already added in this session'); return; }

  try {
    const existing = await db.collection('routeCards').doc(tagId).get();
    if (existing.exists) { toast(tagId + ' is already in use (status: ' + existing.data().status + ')'); return; }
  } catch (e) {
    toast('Error checking TAG: ' + e.message);
    return;
  }

  _issTags.push({ tagId, qty, issueDate: dateStr() });
  setField('iss-tag-input', '');
  setField('iss-tag-qty', '');
  issRenderTagSection();
}

function issRemoveTag(i) {
  _issTags.splice(i, 1);
  issRenderTagSection();
}

async function issSubmitSession() {
  if (!_issReq || !_issLine || !_issTags.length) { toast('Nothing to submit'); return; }

  try {
    const batch = db.batch();
    const masterLot = issMasterLot();
    const inwardRec = S.inward.find(iw => iw.masterLotCode === masterLot);

    _issTags.forEach(t => {
      const ref = db.collection('routeCards').doc(t.tagId);
      batch.set(ref, {
        tagId: t.tagId,
        batchCode: _issBatchCode,
        status: 'store_issued',
        cardType: 'normal',
        /* Lineage */
        masterLotCode: masterLot,
        inwardId: inwardRec ? inwardRec.id : '',
        parentTagId: null,
        rootBatchCode: _issBatchCode,
        /* Part info */
        partId: _issLine.partId,
        partNo: _issLine.partNo,
        partName: _issLine.partName,
        customerId: _issLine.customerId || '',
        customerName: _issLine.customerName || '',
        /* Quantities */
        issuedQty: t.qty,
        currentQty: t.qty,
        /* Stage */
        currentStage: 'soft',
        currentOpId: null,
        opHistory: [],
        /* HT */
        heatCode: null,
        htChargeId: null,
        /* QC */
        qty_oem: 0, qty_spares: 0, qty_market: 0,
        qtyRejected: 0, qtyRework: 0, reworkTagId: null,
        /* Dispatch */
        dispatchedQty: 0,
        /* Rework */
        isRework: false, reworkSeq: 0, reworkOp: null,
        /* Requisition link */
        requisitionId: _issReq.id,
        reqNo: _issReq.reqNo,
        lineNo: _issLine.lineNo,
        /* Audit */
        issuedBy: S.sess.userId,
        issuedByName: S.sess.name,
        issueDate: t.issueDate,
        issuedAt: serverTS(),
        updatedAt: serverTS()
      });
    });

    const totalNewlyIssued = _issTags.reduce((s, t) => s + (+t.qty || 0), 0);

    // Stock guard — prevent issuing more than physically available
    const stockAvail = reqCalcStock(_issLine.partId);
    if (totalNewlyIssued > stockAvail) {
      showModalError(`Insufficient stock. Available: ${stockAvail} pcs, trying to issue: ${totalNewlyIssued} pcs.`);
      return;
    }

    const updatedLines = _issReq.lines.map(l => {
      if (l.lineNo !== _issLine.lineNo) return l;
      const alreadyIssued = issLineIssued(_issReq.id, l.lineNo);
      return { ...l, qtyIssued: alreadyIssued + totalNewlyIssued };
    });
    const allFulfilled = updatedLines.every(l => l.qtyIssued >= l.qtyApproved);

    const rqRef = db.collection('requisitions').doc(_issReq.id);
    batch.update(rqRef, { lines: updatedLines, status: allFulfilled ? 'fulfilled' : 'partial', updatedAt: serverTS() });

    await batch.commit();
    await logAudit('ISSUE_TO_WIP', 'STORE', _issReq.id, null, { batchCode: _issBatchCode, tags: _issTags.map(t => t.tagId) });

    const tagList = _issTags.map(t => t.tagId).join(', ');
    toast(`Issued ${_issTags.length} TAG${_issTags.length > 1 ? 's' : ''}: ${tagList}`);

    _issReq = null; _issLine = null; _issTags = []; _issBatchCode = '';
    await Promise.all([refreshStore('routeCards'), refreshStore('requisitions')]);
    renderIssue();
  } catch (e) {
    toast('Error: ' + e.message);
  }
}

/* ══════════════════════════════════════════════════════════════════════
   SECTION 5 — STOCK BALANCE
   Aggregates per individual part (not per delivery lot).
   Available = max(0, total received − total issued to WIP).
   ══════════════════════════════════════════════════════════════════════ */

const PERIOD_RCVD_CYCLE = ['all', 'today', 'month', 'year'];
const PERIOD_ISSD_CYCLE = ['today', 'month', 'year', 'all'];
const PERIOD_LABEL = { all: 'All Time', today: 'Today', month: 'This Month', year: 'This Year' };

function cycleRcvdPeriod() {
  const i = PERIOD_RCVD_CYCLE.indexOf(_rcvdPeriod);
  _rcvdPeriod = PERIOD_RCVD_CYCLE[(i + 1) % PERIOD_RCVD_CYCLE.length];
  renderStock();
}
function cycleIssdPeriod() {
  const i = PERIOD_ISSD_CYCLE.indexOf(_issdPeriod);
  _issdPeriod = PERIOD_ISSD_CYCLE[(i + 1) % PERIOD_ISSD_CYCLE.length];
  renderStock();
}

function inPeriod(dateStr_, period) {
  if (!dateStr_ || period === 'all') return true;
  const today = dateStr();
  const [y, m] = today.split('-');
  if (period === 'today') return dateStr_ === today;
  if (period === 'month') return dateStr_.startsWith(`${y}-${m}`);
  if (period === 'year')  return dateStr_.startsWith(y);
  return true;
}

function tsToDateStr(ts) {
  if (!ts) return '';
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toISOString().slice(0, 10);
}

function periodPill(label, onclick, active) {
  return `<button onclick="${onclick}" class="period-pill${active ? ' active' : ''}">
    ${label} <i class="ti ti-refresh"></i>
  </button>`;
}

function renderStock() {
  /* ── 1. Aggregate per part ─────────────────────────────────────── */
  const byPart = {};

  S.inward.forEach(r => {
    (r.parts || []).forEach(p => {
      const key = p.partId || p.partName;
      if (!key) return;
      if (!byPart[key]) {
        const masterPart = (S.parts || []).find(mp => mp.id === p.partId);
        byPart[key] = {
          partId:   p.partId   || '',
          partName: p.partName || '—',
          partNo:   p.partNo   || '',
          custId:   masterPart?.custId   || '',
          custName: masterPart?.custName || '',
          received: 0,
          lots:     [],
        };
      }
      const qty = +p.qty || 0;
      byPart[key].received += qty;
      byPart[key].lots.push({
        lotCode:      r.masterLotCode || '',
        supplierName: r.supplierName  || '',
        date:         r.date          || '',
        qty,
        rate:         +p.rate || 0,
        dcNo:         r.dcNo      || '',
        invoiceNo:    r.invoiceNo || '',
      });
    });
  });

  /* ── 2. Issued per part (all time, for stock level) ──────────── */
  const issuedByPart = {};
  S.routeCards.forEach(rc => {
    const key = rc.partId || rc.partName;
    if (!key) return;
    issuedByPart[key] = (issuedByPart[key] || 0) + (+rc.issuedQty || 0);
  });

  /* ── 3. Build part list ───────────────────────────────────────── */
  let partList = Object.entries(byPart).map(([key, p]) => {
    const issued     = issuedByPart[key] || 0;
    const overIssued = issued > p.received;
    const available  = Math.max(0, p.received - issued);
    const value      = p.lots.reduce((s, l) => s + l.qty * l.rate, 0);
    return { ...p, key, issued, available, value, overIssued };
  });

  /* ── 4. Period-filtered stat card values ─────────────────────── */
  const rcvdFiltered = S.inward.reduce((s, r) => {
    if (!inPeriod(r.date, _rcvdPeriod)) return s;
    return s + (r.parts || []).reduce((a, p) => a + (+p.qty || 0), 0);
  }, 0);

  const issdFiltered = S.routeCards.reduce((s, rc) => {
    if (!inPeriod(tsToDateStr(rc.issuedAt), _issdPeriod)) return s;
    return s + (+rc.issuedQty || 0);
  }, 0);

  /* ── 5. Overall stats ─────────────────────────────────────────── */
  const totalAvailable = partList.reduce((s, p) => s + p.available, 0);
  const totalValue     = partList.reduce((s, p) => s + p.value,     0);
  const overIssuedCount = partList.filter(p => p.overIssued).length;

  /* ── 6. Filter + sort the table ──────────────────────────────── */
  const q = _stockSearch.trim().toLowerCase();
  if (_stockCustFilt !== 'all') partList = partList.filter(p => p.custId === _stockCustFilt);
  if (q) partList = partList.filter(p =>
    (p.partName || '').toLowerCase().includes(q) ||
    (p.partNo   || '').toLowerCase().includes(q) ||
    (p.custName || '').toLowerCase().includes(q)
  );
  // Over-issued first, then by available desc
  partList.sort((a, b) => {
    if (a.overIssued !== b.overIssued) return a.overIssued ? -1 : 1;
    return b.available - a.available;
  });

  /* ── 7. Customer filter dropdown ─────────────────────────────── */
  const custMap = {};
  Object.values(byPart).forEach(p => { if (p.custId) custMap[p.custId] = p.custName; });
  const custOpts = Object.entries(custMap).map(([id, name]) =>
    `<option value="${id}" ${_stockCustFilt===id?'selected':''}>${name}</option>`).join('');

  /* ── 8. Stat cards ────────────────────────────────────────────── */
  const statCard = (opts) => `
    <div style="background:var(--sur);border:1px solid var(--bdr);border-radius:var(--rs);
                padding:14px 16px;border-top:3px solid ${opts.accent};
                display:flex;flex-direction:column;min-height:112px;box-sizing:border-box">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
        <div style="font-size:10px;font-weight:800;letter-spacing:.07em;color:${opts.accent}">${opts.label}</div>
        ${opts.pill || '<div></div>'}
      </div>
      <div style="display:flex;align-items:flex-end;justify-content:space-between;flex:1">
        <div>
          <div style="font-size:26px;font-weight:900;line-height:1;color:var(--txt)">${opts.value}</div>
          <div style="font-size:11px;color:var(--txt-muted);margin-top:4px">${opts.sub}</div>
        </div>
        <i class="ti ${opts.icon}" style="font-size:32px;color:${opts.accent};opacity:.15;flex-shrink:0;margin-left:8px"></i>
      </div>
      ${opts.extra ? `<div style="font-size:11px;color:var(--txt-muted);border-top:1px solid var(--bdr);padding-top:6px;margin-top:8px">${opts.extra}</div>` : ''}
    </div>`;

  const rcvdPill = periodPill(PERIOD_LABEL[_rcvdPeriod], 'cycleRcvdPeriod()', _rcvdPeriod !== 'all');
  const issdPill = periodPill(PERIOD_LABEL[_issdPeriod], 'cycleIssdPeriod()', _issdPeriod !== 'today');

  const statsHtml = `
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:14px">
      ${statCard({
        label: 'AVAILABLE',
        value: totalAvailable.toLocaleString('en-IN'),
        sub:   'pcs in store right now',
        icon:  'ti-package',
        accent:'#16a34a',
        extra: totalValue > 0 ? `${fmtINR(totalValue)} total stock value` : '',
      })}
      ${statCard({
        label: 'RECEIVED',
        value: rcvdFiltered.toLocaleString('en-IN'),
        sub:   `pcs · ${PERIOD_LABEL[_rcvdPeriod].toLowerCase()}`,
        icon:  'ti-package-import',
        accent:'#2563eb',
        pill:  rcvdPill,
      })}
      ${statCard({
        label: 'ISSUED TO WIP',
        value: issdFiltered.toLocaleString('en-IN'),
        sub:   `pcs · ${PERIOD_LABEL[_issdPeriod].toLowerCase()}`,
        icon:  'ti-arrow-bar-right',
        accent:'#7c3aed',
        pill:  issdPill,
      })}
    </div>`;

  document.getElementById('section-content').innerHTML = `
    <div style="font-size:16px;font-weight:700;margin-bottom:12px">Stock Balance</div>

    ${statsHtml}

    ${overIssuedCount ? `
      <div style="display:flex;align-items:center;gap:8px;background:#fef2f2;border:1px solid #fca5a5;
                  border-radius:6px;padding:8px 12px;margin-bottom:10px;font-size:12px;color:#991b1b">
        <i class="ti ti-alert-triangle" style="flex-shrink:0"></i>
        <span><strong>${overIssuedCount} component${overIssuedCount>1?'s':''}</strong> show issued qty exceeding received qty — possible data entry error. Review highlighted rows below.</span>
      </div>` : ''}

    <div class="row-2" style="margin-bottom:10px">
      <div class="f" style="margin:0">
        <input type="text" placeholder="Search part name, no. or customer..."
          value="${_stockSearch}" oninput="_stockSearch=this.value;renderStock()" style="font-size:13px">
      </div>
      <div class="f" style="margin:0">
        <select onchange="_stockCustFilt=this.value;renderStock()">
          <option value="all" ${_stockCustFilt==='all'?'selected':''}>All Customers</option>
          ${custOpts}
        </select>
      </div>
    </div>

    ${partList.length === 0
      ? emptyState('ti-chart-pie', 'No stock found', q || _stockCustFilt!=='all' ? 'Try clearing the filter.' : 'Add inward receipts to start tracking stock.')
      : `<div style="display:grid;grid-template-columns:1fr 64px 64px 64px;gap:4px;padding:6px 10px;
                     font-size:10px;font-weight:700;color:var(--txt-muted);letter-spacing:.05em;
                     border-bottom:2px solid var(--bdr);margin-bottom:4px">
           <div>COMPONENT</div>
           <div style="text-align:right">RCVD</div>
           <div style="text-align:right">ISSUED</div>
           <div style="text-align:right">AVAIL</div>
         </div>
         <div id="stock-body"></div>`}
  `;

  if (!partList.length) return;
  const w = document.getElementById('stock-body');
  if (!w) return;

  w.innerHTML = partList.map(p => {
    const isOver = p.overIssued;
    const pct    = p.received > 0 ? Math.round((p.available / p.received) * 100) : 0;
    const isOut  = p.available === 0 && !isOver;
    const isLow  = !isOut && !isOver && pct < 20;
    const barColor  = isOver ? '#dc2626' : isOut ? '#dc2626' : isLow ? '#f59e0b' : 'var(--ok)';
    const availColor = isOver || isOut ? '#dc2626' : isLow ? '#f59e0b' : 'var(--ok)';
    const expanded  = _stockExpanded[p.key];

    const lotRows = p.lots.map(l => {
      const lotIssued = S.routeCards.filter(rc =>
        (rc.partId || rc.partName) === p.key && rc.masterLotCode === l.lotCode
      ).reduce((s, rc) => s + (+rc.issuedQty || 0), 0);
      const lotAvail = Math.max(0, l.qty - lotIssued);
      const lotPct   = l.qty > 0 ? Math.round((lotAvail / l.qty) * 100) : 0;
      return `
        <div style="padding:8px 10px 8px 14px;border-left:3px solid var(--bdr-mid);margin-left:10px;
                    margin-bottom:4px;background:var(--bg);border-radius:0 6px 6px 0">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px">
            <div>
              <div class="lot-badge" style="font-size:11px;margin-bottom:4px">
                <i class="ti ti-tag"></i> ${l.lotCode}
              </div>
              <div style="font-size:11px;color:var(--txt-muted)">
                ${l.supplierName} · ${fmtDate(l.date)}
                ${l.dcNo ? ` · DC: ${l.dcNo}` : ''}
                ${l.invoiceNo ? ` · INV: ${l.invoiceNo}` : (!l.dcNo || isInterCompany(l.supplierName) ? '' : ` · <span style="color:#92400e">Invoice pending</span>`)}
              </div>
            </div>
            <div style="text-align:right;flex-shrink:0;font-size:12px">
              <div style="font-weight:700;color:${lotAvail>0?'var(--ok)':'#dc2626'}">
                ${lotAvail} <span style="font-weight:400;color:var(--txt-muted)">avail</span>
              </div>
              <div style="color:var(--txt-muted)">${lotIssued} issued of ${l.qty}</div>
            </div>
          </div>
          <div class="prog" style="margin-top:6px">
            <div class="pf ${lotPct>50?'pg':lotPct>20?'pa':'pr'}" style="width:${Math.min(100,lotPct)}%"></div>
          </div>
        </div>`;
    }).join('');

    return `
      <div style="border-bottom:1px solid var(--bdr);${isOver?'background:#fff5f5;':''}">
        <div onclick="_stockExpanded['${p.key}']=!_stockExpanded['${p.key}'];renderStock()"
          style="display:grid;grid-template-columns:1fr 64px 64px 64px;gap:4px;align-items:center;
                 padding:11px 10px;cursor:pointer;user-select:none">
          <div style="min-width:0">
            <div style="font-weight:700;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${p.partName}</div>
            <div style="font-size:11px;color:var(--txt-muted);margin-top:2px;display:flex;align-items:center;gap:6px;flex-wrap:wrap">
              ${p.partNo ? `<span style="font-family:monospace">${p.partNo}</span>` : ''}
              ${p.custName ? `<span>· ${p.custName}</span>` : ''}
              ${isOver ? `<span style="color:#dc2626;font-weight:700">· ⚠ OVER-ISSUED by ${p.issued - p.received} pcs</span>`
                       : isOut ? `<span style="color:#dc2626;font-weight:700">· OUT OF STOCK</span>`
                       : isLow ? `<span style="color:#f59e0b;font-weight:700">· LOW STOCK</span>` : ''}
            </div>
            <div style="margin-top:5px;height:4px;background:var(--bdr);border-radius:2px;overflow:hidden">
              <div style="height:100%;width:${isOver?100:pct}%;background:${barColor};border-radius:2px"></div>
            </div>
          </div>
          <div style="text-align:right;font-size:13px;font-weight:600;color:var(--txt-muted)">${p.received}</div>
          <div style="text-align:right;font-size:13px;font-weight:600;color:${isOver?'#dc2626':'var(--txt-muted)'}">
            ${p.issued}${isOver?'<div style="font-size:9px;color:#dc2626">exceeds</div>':''}
          </div>
          <div style="text-align:right;font-size:14px;font-weight:800;color:${availColor}">${p.available}</div>
        </div>
        ${expanded ? `<div style="padding:0 0 10px">${lotRows}</div>` : ''}
      </div>`;
  }).join('');
}

/* ══════════════════════════════════════════════════════════════════════
   SECTION 6 — ROUTE CARDS / BATCH TRACKER
   ══════════════════════════════════════════════════════════════════════ */
function renderRouteCards() {
  const filterOpts = [
    { v: 'all', l: 'All Status' },
    { v: 'store_issued', l: 'Store Issued' },
    { v: 'soft_wip', l: 'Soft WIP' },
    { v: 'ht_pending', l: 'HT Pending' },
    { v: 'ht_wip', l: 'HT In Progress' },
    { v: 'hard_wip', l: 'Hard WIP' },
    { v: 'qc_pending', l: 'QC Pending' },
    { v: 'qc_cleared', l: 'QC Cleared' },
    { v: 'dispatched', l: 'Dispatched' },
  ];

  const q = searchQ.trim().toLowerCase();
  let list = S.routeCards.filter(rc => {
    if (_rcFilt !== 'all' && rc.status !== _rcFilt) return false;
    if (!q) return true;
    return (rc.tagId || '').toLowerCase().includes(q)
      || (rc.partName || '').toLowerCase().includes(q)
      || (rc.partNo || '').toLowerCase().includes(q)
      || (rc.batchCode || '').toLowerCase().includes(q);
  });
  list = list.slice().sort((a, b) => (b.issuedAt?.toMillis?.() || 0) - (a.issuedAt?.toMillis?.() || 0)).slice(0, 100);

  document.getElementById('section-content').innerHTML = `
    <div style="font-size:16px;font-weight:700;margin-bottom:12px">Route Cards</div>
    <div class="row-2">
      ${searchBox('Search by TAG, part or batch...')}
      <div class="f">
        <label for="store-filter" style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap">Filter by status</label>
        <select id="store-filter" onchange="_rcFilt=this.value;renderSection()">
          ${filterOpts.map(o => `<option value="${o.v}" ${o.v === _rcFilt ? 'selected' : ''}>${o.l}</option>`).join('')}
        </select>
      </div>
    </div>
    ${recordCount(S.routeCards.length)}
    ${list.length
      ? list.map(routeCardRow).join('')
      : emptyState('ti-tags', 'No route cards found', 'Issue material to WIP to create route cards.')}
  `;
}

function routeCardRow(rc) {
  const lastOp = rc.opHistory && rc.opHistory.length ? rc.opHistory[rc.opHistory.length - 1] : null;
  const canDelete = S.sess?.email === 'tanmay@indometaforge.in';
  return `
    <div class="card" style="margin-bottom:10px">
      <div class="flex justify-between items-center mb-8">
        <div style="flex:1;min-width:0">
          <div class="mono font-bold" style="font-size:14px;color:var(--imf-navy)">${rc.tagId}</div>
          <div style="font-weight:600;font-size:13px;margin-top:2px">${rc.partName || '—'}</div>
          <div class="text-sm text-muted">${rc.partNo || ''}${rc.customerName ? ' · ' + rc.customerName : ''}</div>
        </div>
        <div style="text-align:right;flex-shrink:0">
          <span class="bdg ${RC_BADGE[rc.status] || 'bdg-gr'}"><span class="bdg-dot"></span>${RC_LABEL[rc.status] || rc.status}</span>
          <div class="font-num mt-4" style="font-size:15px">${rc.currentQty} pcs</div>
        </div>
      </div>
      <div class="text-xs text-muted mb-4">Batch: <span class="mono">${rc.batchCode || '—'}</span></div>
      ${rc.heatCode ? `<div class="text-xs mb-4" style="color:var(--ok)"><i class="ti ti-flame" aria-hidden="true"></i> Heat: ${rc.heatCode}</div>` : ''}
      ${lastOp ? `<div class="text-sm text-muted">Last op: ${lastOp.opName} · ${fmtDate(lastOp.date)}</div>` : ''}
      <div class="text-sm text-muted mt-4">Issued: ${fmtDate(rc.issueDate)} · ${rc.issuedByName || '—'}</div>
      ${canDelete ? `
        <button class="btn btn-d btn-sm w-full mt-8" onclick="confirmDeleteRouteCard('${rc.tagId}')">
          <i class="ti ti-trash" aria-hidden="true"></i> Delete Route Card
        </button>` : ''}
    </div>`;
}

function confirmDeleteRouteCard(tagId) {
  const rc = S.routeCards.find(x => x.tagId === tagId || x.id === tagId);
  if (!rc) return;
  openModal(`
    <div class="modal-title" style="color:var(--err)"><i class="ti ti-alert-triangle"></i> Delete Route Card</div>
    <div class="ebox mb-12">
      <i class="ti ti-alert-triangle" aria-hidden="true"></i>
      <span>This will permanently delete <strong>${tagId}</strong> and reverse all its issued quantity back to store stock. All process history on this card will be lost. This cannot be undone.</span>
    </div>
    <div style="background:var(--sur2);border-radius:var(--rs);padding:10px 12px;margin-bottom:14px">
      <div class="text-sm"><strong>Part:</strong> ${rc.partName} (${rc.partNo})</div>
      <div class="text-sm"><strong>Qty:</strong> ${rc.issuedQty} pcs</div>
      <div class="text-sm"><strong>Status:</strong> ${RC_LABEL[rc.status] || rc.status}</div>
      <div class="text-sm"><strong>Batch:</strong> <span class="mono">${rc.batchCode}</span></div>
    </div>
    <div class="f">
      <label for="del-rc-reason" class="f-req">Reason for deletion</label>
      <input id="del-rc-reason" type="text" placeholder="e.g. Entered by mistake, duplicate issue...">
    </div>
    <div class="flex gap-8 mt-16">
      <button class="btn btn-d flex-1" onclick="deleteRouteCard('${tagId}')">
        <i class="ti ti-trash" aria-hidden="true"></i> Confirm Delete
      </button>
      <button class="btn btn-s flex-1" onclick="closeModal()">Cancel</button>
    </div>
  `);
}

async function deleteRouteCard(tagId) {
  const reason = getField('del-rc-reason');
  if (!reason) { showModalError('Please enter a reason for deletion.'); return; }

  const rc = S.routeCards.find(x => x.tagId === tagId || x.id === tagId);
  if (!rc) { showModalError('Route card not found.'); return; }

  try {
    const batch = db.batch();

    /* Delete the route card doc */
    batch.delete(db.collection('routeCards').doc(tagId));

    /* Reverse qtyIssued on the requisition line so stock falls back to store */
    if (rc.requisitionId && rc.lineNo != null) {
      const req = S.requisitions.find(r => r.id === rc.requisitionId);
      if (req) {
        const updatedLines = req.lines.map(l => {
          if (l.lineNo !== rc.lineNo) return l;
          return { ...l, qtyIssued: Math.max(0, (+l.qtyIssued || 0) - (+rc.issuedQty || 0)) };
        });
        const allFulfilled = updatedLines.every(l => l.qtyIssued >= l.qtyApproved);
        const anyIssued    = updatedLines.some(l => l.qtyIssued > 0);
        const newStatus    = allFulfilled ? 'fulfilled' : anyIssued ? 'partial' : 'approved';
        batch.update(db.collection('requisitions').doc(rc.requisitionId), {
          lines: updatedLines, status: newStatus, updatedAt: serverTS()
        });
      }
    }

    await batch.commit();
    await logAudit('DELETE_ROUTE_CARD', 'STORE', tagId, rc, { reason, deletedBy: S.sess.email });

    closeModal();
    await Promise.all([refreshStore('routeCards'), refreshStore('requisitions')]);
    renderSection();
    toast(`${tagId} deleted — qty returned to store stock`);
  } catch (e) {
    showModalError(e.message);
  }
}

/* ══════════════════════════════════════════════════════════════════════
   SECTION 7 — TAG REGISTRY (admin only)
   config/tags: { totalPrinted, lastTagNum }
   TAGs are physical pre-printed QR labels: TAG001, TAG002, ... (3-digit
   zero-padded). Each becomes a routeCards/{tagId} doc once issued.
   ══════════════════════════════════════════════════════════════════════ */
function renderTagRegistry() {
  const cfg = S.tagConfig || { totalPrinted: 0, lastTagNum: 0 };
  const issuedCount = S.routeCards.length;
  const available = cfg.totalPrinted - issuedCount;
  const availColor = available < 20 ? 'var(--err)' : available < 50 ? 'var(--warn)' : 'var(--ok)';

  document.getElementById('section-content').innerHTML = `
    <div style="font-size:16px;font-weight:700;margin-bottom:12px">TAG Registry</div>
    <div class="stats-2">
      <div class="stat-card info">
        <div class="stat-lbl">Total Printed</div>
        <div class="stat-val">${cfg.totalPrinted}</div>
      </div>
      <div class="stat-card ${available < 20 ? 'err' : available < 50 ? 'warn' : 'ok'}">
        <div class="stat-lbl">Available</div>
        <div class="stat-val" style="color:${availColor}">${available}</div>
        <div class="stat-sub">${issuedCount} issued so far</div>
      </div>
    </div>
    ${available < 20 ? `<div class="ebox mb-12"><i class="ti ti-alert-triangle" aria-hidden="true"></i><span>Less than 20 TAGs remaining — order the next batch from the supplier.</span></div>` : ''}
    <div class="card">
      <div class="card-hd">Update TAG Count</div>
      <div class="ibox mb-12"><i class="ti ti-info-circle" aria-hidden="true"></i><span>When a new batch of pre-printed TAGs arrives from the supplier, update the totals here.</span></div>
      <div class="f"><label for="tag-total">Total TAGs Printed (cumulative)</label><input id="tag-total" type="number" min="${cfg.totalPrinted}" value="${cfg.totalPrinted}"></div>
      <div class="f"><label for="tag-last">Last TAG Number</label><input id="tag-last" type="number" min="${cfg.lastTagNum}" value="${cfg.lastTagNum}"></div>
      <div id="modal-err"></div>
      <button class="btn btn-p" onclick="saveTagConfig()">Update TAG Count</button>
    </div>
    <div class="card mt-12">
      <div class="card-hd">Format</div>
      <div class="text-sm text-muted">TAGs are printed as <span class="mono" style="color:var(--imf-navy)">TAG001, TAG002, TAG003...</span> with zero-padding to 3 digits. The QR code on each physical card contains only this ID.</div>
    </div>
  `;
}

async function saveTagConfig() {
  const total = parseInt(getField('tag-total'));
  const last  = parseInt(getField('tag-last'));
  if (!total || total < 1) { showModalError('Enter a valid total TAG count.'); return; }
  try {
    await db.collection('config').doc('tags').set({ totalPrinted: total, lastTagNum: last, updatedAt: serverTS() }, { merge: true });
    await logAudit('UPDATE_TAG_CONFIG', 'STORE', 'tags', S.tagConfig, { totalPrinted: total, lastTagNum: last });
    await refreshStore('tags');
    renderSection();
    toast('TAG registry updated');
  } catch (e) {
    showModalError(e.message);
  }
}

/* ══════════════════════════════════════════════════════════════════════
   BOOT
   ══════════════════════════════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', init);
