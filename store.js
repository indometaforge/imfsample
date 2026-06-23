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

let _inwFilt  = 'all';  /* supplier / IQC filter for Inward list */
let _inwExpanded = {};  /* receiptId → bool (part/DC/invoice breakdown expanded) */
let _rcFilt   = 'all';  /* status filter for Route Cards list */

let _stockSearch   = '';    /* Stock Balance search query */
let _stockCustFilt = 'all'; /* Stock Balance customer filter */
let _stockExpanded = {};    /* partId → bool (lot rows expanded) */
let _stockPeriod   = 'all'; /* Unified period for Received + Issued stats */

/* Lot selection at issuance */
let _issLot = null;    /* masterLotCode chosen by storeperson for this session */

let _inwParts = [];     /* [{partId,partNo,partName,qty,rate}] — Inward modal */
let _reqLines = [];     /* [{lineNo,partId,partNo,partName,customerId,customerName,masterLotCode,qtyRequested,qtyApproved,qtyIssued}] */

/* Issue-to-WIP session state */
let _issReq      = null;
let _issLine     = null;
let _issTags     = [];  /* [{tagId, qty, issueDate}] */
let _issBatchCode = '';

const ISS_BATCH_MIN = 25;   /* minimum pcs per issue session */
const ISS_BATCH_MAX = 100;  /* maximum pcs per issue session (max 10 bins × 10 pcs) */

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
    toast('Error loading store data: ' + friendlyError(e), 5000);
    render();
  }

  document.getElementById('loading-screen').style.display = 'none';
  document.getElementById('app').style.display = '';
}

/* Load all transactional Store collections into S */
async function loadStoreData() {
  S.inward      = S.inward      || [];
  S.requisitions= S.requisitions|| [];
  S.routeCards  = S.routeCards  || [];
  S.tagConfig   = S.tagConfig   || { totalPrinted: 0, lastTagNum: 0 };

  const [inwSnap, reqSnap, rcSnap, tagDoc] = await Promise.all([
    db.collection('inward').get(),
    db.collection('requisitions').get(),
    db.collection('routeCards').get(),
    db.collection('config').doc('tags').get(),
  ]);

  S.inward       = inwSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  S.requisitions = reqSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  S.routeCards   = rcSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  S.tagConfig    = tagDoc.exists ? tagDoc.data() : { totalPrinted: 0, lastTagNum: 0 };
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

/** IQC badge helper */
const IQC_LABEL = { pending: 'IQC Pending', accepted: 'Accepted', conditional: 'Conditional', rejected: 'Rejected' };
const IQC_BADGE = { pending: 'bdg-a', accepted: 'bdg-g', conditional: 'bdg-b', rejected: 'bdg-r' };

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
  _inwExpanded = {};
  _stockSearch = ''; _stockCustFilt = 'all'; _stockExpanded = {}; _stockPeriod = 'all';
  _issReq = null; _issLine = null; _issTags = []; _issBatchCode = ''; _issLot = null;
  render();
}

function renderSection() {
  const map = {
    inward:     renderInward,
    issue:      renderIssue,
    stock:      renderStock,
    routeCards: renderRouteCards,
    tags:       renderTagRegistry,
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
  store_issued: 'bdg-b', soft_wip: 'bdg-soft', soft_done: 'bdg-soft',
  ht_queue: 'bdg-a', ht_done: 'bdg-a',
  hard_wip: 'bdg-hard', qc_pending: 'bdg-a', qc_cleared: 'bdg-g', dispatched: 'bdg-gr',
  scrapped: 'bdg-r'
};
const RC_LABEL = {
  store_issued: 'Store Issued', soft_wip: 'Soft WIP', soft_done: 'Soft Done',
  ht_queue: 'HT Queue', ht_done: 'HT Done',
  hard_wip: 'Hard WIP', qc_pending: 'QC Pending', qc_cleared: 'QC Cleared', dispatched: 'Dispatched',
  scrapped: 'Scrapped'
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
  const iqcPendingCount = S.inward.filter(r => r.iqcStatus === 'pending').length;

  let list = S.inward.filter(r => {
    if (_inwFilt === '__inv_pending__') return r.dcNo && !r.invoiceNo;
    if (_inwFilt === '__iqc_pending__') return r.iqcStatus === 'pending';
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
          ${iqcPendingCount ? `<option value="__iqc_pending__" ${_inwFilt === '__iqc_pending__' ? 'selected' : ''}>IQC Pending (${iqcPendingCount})</option>` : ''}
          ${invPendingCount ? `<option value="__inv_pending__" ${_inwFilt === '__inv_pending__' ? 'selected' : ''}>Invoice Pending (${invPendingCount})</option>` : ''}
          ${activeSups.map(s => `<option value="${s.id}" ${s.id === _inwFilt ? 'selected' : ''}>${s.name}</option>`).join('')}
        </select>
      </div>
    </div>
    ${iqcPendingCount ? `
      <a href="qc.html" class="wbox" style="cursor:pointer;text-decoration:none;width:100%;box-sizing:border-box">
        <i class="ti ti-microscope"></i>
        <span style="flex:1"><strong>${iqcPendingCount}</strong> lot${iqcPendingCount!==1?'s':''} awaiting IQC — go to QC module to clear</span>
        <i class="ti ti-chevron-right"></i>
      </a>` : ''}
    ${invPendingCount && _inwFilt !== '__inv_pending__' ? `
      <button type="button" onclick="_inwFilt='__inv_pending__';renderSection()" class="wbox" style="cursor:pointer;width:100%;text-align:left;border:1px solid var(--warn-bdr);font:inherit">
        <i class="ti ti-alert-triangle"></i>
        <span><strong>${invPendingCount}</strong> receipt${invPendingCount!==1?'s':''} awaiting invoice — tap to view</span>
      </button>` : ''}

    ${list.length ? `
      <div style="font-size:11px;color:var(--txt-muted);margin-bottom:4px">${list.length} receipt${list.length!==1?'s':''} · tap a row for the part-by-part breakdown</div>
      ${list.map(inwardRow).join('')}
    ` : emptyState('ti-package-import', 'No inward receipts found',
        _inwFilt === '__inv_pending__' ? 'No receipts with pending invoices.'
        : _inwFilt === '__iqc_pending__' ? 'No lots awaiting IQC.'
        : 'Add a receipt to record material coming in from a supplier.')}
  `;
}

function inwardRow(r) {
  const parts = r.parts || [];
  const totalPcs = parts.reduce((s, p) => s + (+p.qty || 0), 0);
  const totalVal = parts.reduce((s, p) => s + ((+p.qty || 0) * (+p.rate || 0)), 0);
  const invPending = r.dcNo && !r.invoiceNo && !isInterCompany(r.supplierName);
  const iqcStatus = r.iqcStatus || null; /* legacy records without iqcStatus are grandfathered */
  const iqcClass = iqcStatus === 'rejected' ? ' iqc-rejected' : iqcStatus === 'pending' ? ' iqc-pending' : '';
  const expanded = !!_inwExpanded[r.id];
  const partLabel = parts.length === 1 ? (parts[0].partName || '1 part') : `${parts.length} parts`;

  return `
    <div class="inw-row${iqcClass}">
      <button type="button" class="inw-row-btn" onclick="_inwExpanded['${r.id}']=!_inwExpanded['${r.id}'];renderSection()" aria-expanded="${expanded}">
        <div class="inw-row-main">
          <div class="inw-row-name">${r.supplierName || '—'}</div>
          <div class="inw-row-meta">
            <span>${fmtDate(r.date)}</span>
            ${r.masterLotCode ? `<span class="mono">· ${r.masterLotCode}</span>` : ''}
            <span>· ${partLabel}</span>
          </div>
          <div class="inw-row-badges">
            ${invPending ? `<span class="bdg bdg-a">Invoice Pending</span>` : ''}
            ${iqcStatus ? `<span class="bdg ${IQC_BADGE[iqcStatus] || 'bdg-gr'}"><span class="bdg-dot"></span>${IQC_LABEL[iqcStatus]||iqcStatus}</span>` : ''}
          </div>
        </div>
        <div class="inw-row-qty">
          <div class="inw-row-qty-num">${totalPcs}</div>
          <div class="inw-row-qty-lbl">pcs</div>
        </div>
        <i class="ti ti-chevron-${expanded ? 'up' : 'down'}" aria-hidden="true" style="color:var(--txt-dim);flex-shrink:0"></i>
      </button>
      ${expanded ? `
        <div class="inw-row-detail">
          ${parts.map(p => `
            <div class="inw-part-line">
              <div class="inw-part-line-name">${p.partName || '—'}${p.partNo ? `<span class="mono"> · ${p.partNo}</span>` : ''}</div>
              <div class="inw-part-line-qty">${p.qty || 0} pcs${p.rate ? ` × ${fmtINR(p.rate)}` : ''}</div>
            </div>`).join('')}
          <div class="inw-detail-meta">
            ${r.dcNo ? `<span><strong>DC:</strong> ${r.dcNo}</span>` : ''}
            ${r.invoiceNo ? `<span><strong>Invoice:</strong> ${r.invoiceNo}</span>` : ''}
            ${totalVal > 0 ? `<span><strong>Total:</strong> ${fmtINR(totalVal)}</span>` : ''}
          </div>
          ${canDo('inward') ? `
            <button class="btn btn-s btn-sm" style="width:100%;margin-top:8px" onclick="openInwardModal('${r.id}')">
              <i class="ti ti-edit" aria-hidden="true"></i> Edit Receipt
            </button>` : ''}
        </div>` : ''}
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
    <div id="iw-inv-hint" class="wbox" style="display:${r?.dcNo && !r?.invoiceNo && !isInterCompany(r?.supplierName) ? 'flex' : 'none'};margin-bottom:12px">
      <i class="ti ti-alert-triangle"></i>
      <div>DC entered without invoice — invoice can be added later when received.</div>
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
      const ref = await db.collection('inward').add({
        ...data,
        iqcStatus: 'pending',   /* new receipts always go through IQC gate */
        createdBy: S.sess.userId,
        createdAt: serverTS()
      });
      await logAudit('CREATE_INWARD', 'STORE', ref.id, null, data);
    }
    closeModal();
    await refreshStore('inward');
    renderSection();
    toast(editId ? 'Receipt updated' : 'Inward receipt saved — send to IQC for inspection');
  } catch (e) {
    showModalError(friendlyError(e));
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
    showModalError(friendlyError(e));
  }
}

/* ══════════════════════════════════════════════════════════════════════
   SECTION 2 — STOCK CALCULATION
   IQC inspection is handled in qc.js (QC module, IQC tab).
   Stock calc excludes rejected/pending lots; grandfathers legacy records.
   ══════════════════════════════════════════════════════════════════════ */

/** Stock calc — only counts accepted/conditional lots, never rejected or pending */
function reqCalcStock(partId) {
  const totalIn = S.inward
    .filter(iw => !iw.iqcStatus || iw.iqcStatus === 'accepted' || iw.iqcStatus === 'conditional')
    .reduce((s, iw) => s + (iw.parts || []).filter(p => p.partId === partId).reduce((a, p) => a + (+p.qty || 0), 0), 0);
  const totalIssued = S.routeCards.filter(rc => rc.partId === partId).reduce((s, rc) => s + (+rc.issuedQty || 0), 0);
  return Math.max(0, totalIn - totalIssued);
}

/* IQC inspection functions moved to qc.js (QC module, IQC tab) */

/* ══════════════════════════════════════════════════════════════════════
   (Requisition creation and Store-HOD approvals have moved:
    → Requisitions are created in production.js
    → Approvals are handled in approvals.js
   ══════════════════════════════════════════════════════════════════════ */

/* genReqNo, renderRequisitions, openRequisitionModal, saveRequisition,
   renderApprovals, approveRequisition, rejectRequisition — removed.
   These functions now live in production.js and approvals.js respectively. */

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
        <div id="iss-lot-picker"></div>
        <div id="iss-tag-section"></div>
      `}
  `;

  if (_issReq) issRenderLineSelect();
  if (_issLine) { issRenderLotPicker(); issRenderTagSection(); }
}

function issSelectRequisition(id) {
  _issReq = S.requisitions.find(r => r.id === id) || null;
  _issLine = null; _issTags = []; _issBatchCode = ''; _issLot = null;
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

/** Returns master lot code — either the storeperson's explicit pick or 'LOT-UNKNOWN' */
function issMasterLot() {
  return _issLot || 'LOT-UNKNOWN';
}

/** Build list of accepted/conditional lots that have stock for _issLine.partId, FIFO order */
function issGetAvailableLots() {
  if (!_issLine) return [];
  return S.inward
    .filter(iw => !iw.iqcStatus || iw.iqcStatus === 'accepted' || iw.iqcStatus === 'conditional')
    .filter(iw => (iw.parts || []).some(p => p.partId === _issLine.partId))
    .map(iw => {
      const part = (iw.parts || []).find(p => p.partId === _issLine.partId);
      const issued = S.routeCards
        .filter(rc => rc.masterLotCode === iw.masterLotCode && rc.partId === _issLine.partId)
        .reduce((s, rc) => s + (+rc.issuedQty || 0), 0);
      return {
        masterLotCode: iw.masterLotCode,
        date:          iw.date || '',
        supplierName:  iw.supplierName || '',
        iqcStatus:     iw.iqcStatus || null,
        available:     Math.max(0, (part?.qty || 0) - issued),
        dcNo:          iw.dcNo || '',
      };
    })
    .filter(l => l.available > 0)
    .sort((a, b) => a.date.localeCompare(b.date)); /* oldest first = FIFO */
}

function issSelectLine(lineNo) {
  if (!_issReq) return;
  _issLine = _issReq.lines.find(l => l.lineNo === lineNo) || null;
  if (!_issLine) return;
  _issTags = [];
  _issLot  = null; /* reset lot pick whenever line changes */

  /* Auto-select lot if there is exactly one with stock (skip the picker) */
  const lots = issGetAvailableLots();
  if (lots.length === 1) {
    _issLot = lots[0].masterLotCode;
    issFinaliseBatchCode();
  }

  issRenderLineSelect();
  issRenderLotPicker();
  issRenderTagSection();
}

function issFinaliseBatchCode() {
  const ymd = dateStr().replace(/-/g, '');
  const issCount = S.routeCards.filter(rc => rc.requisitionId === _issReq.id && rc.lineNo === _issLine.lineNo).length;
  _issBatchCode = `${issMasterLot()}-${ymd}-${issCount + 1}`;
}

function issSelectLot(lotCode) {
  _issLot = lotCode;
  _issTags = [];
  issFinaliseBatchCode();
  issRenderLotPicker();
  issRenderTagSection();
}

function issRenderLotPicker() {
  const w = document.getElementById('iss-lot-picker');
  if (!w || !_issLine) return;
  const lots = issGetAvailableLots();

  /* Single lot auto-selected — no picker needed */
  if (lots.length <= 1) { w.innerHTML = ''; return; }

  w.innerHTML = `
    <div style="margin-top:12px">
      <div class="slbl mb-8">Select Material Lot <span style="font-size:10px;font-weight:400;color:var(--txt-muted)">(FIFO order — oldest first)</span></div>
      ${lots.map((l, i) => {
        const sel = _issLot === l.masterLotCode;
        return `
          <div onclick="issSelectLot('${l.masterLotCode}')"
            style="display:flex;align-items:center;gap:12px;padding:10px 12px;margin-bottom:6px;
                   border:1.5px solid ${sel ? 'var(--imf-navy)' : 'var(--bdr)'};border-radius:var(--rs);
                   cursor:pointer;background:${sel ? 'var(--imf-steel-light)' : 'var(--sur)'}">
            <div style="flex:1;min-width:0">
              <div style="font-weight:700;font-size:13px;display:flex;align-items:center;gap:8px">
                <span class="mono">${l.masterLotCode}</span>
                ${i === 0 ? `<span style="font-size:10px;background:var(--imf-navy);color:#fff;border-radius:4px;padding:1px 6px">FIFO</span>` : ''}
              </div>
              <div style="font-size:11px;color:var(--txt-muted);margin-top:2px">
                ${l.supplierName} · ${fmtDate(l.date)}${l.dcNo ? ' · DC: '+l.dcNo : ''}
                ${l.iqcStatus === 'conditional' ? ' · <span style="color:var(--warn)">Conditional acceptance</span>' : ''}
              </div>
            </div>
            <div style="text-align:right;flex-shrink:0">
              <div style="font-weight:700;color:var(--ok);font-size:14px">${l.available}</div>
              <div style="font-size:10px;color:var(--txt-muted)">avail</div>
            </div>
            ${sel ? `<i class="ti ti-circle-check" style="color:var(--imf-navy);font-size:20px;flex-shrink:0"></i>` : `<div style="width:20px"></div>`}
          </div>`;
      }).join('')}
    </div>`;
}

function issRenderTagSection() {
  const w = document.getElementById('iss-tag-section');
  if (!w || !_issLine) return;

  /* Require a lot to be chosen before allowing TAG scan */
  if (!_issLot) {
    const lots = issGetAvailableLots();
    if (lots.length === 0) {
      w.innerHTML = `<div class="ebox mt-8"><i class="ti ti-package-off"></i><span>No accepted stock found for this part. Check IQC or inward records.</span></div>`;
    } else {
      w.innerHTML = ''; /* lot picker shown in iss-lot-picker div */
    }
    return;
  }

  const issued       = issLineIssued(_issReq.id, _issLine.lineNo);
  const remaining    = _issLine.qtyApproved - issued;
  const sessionTotal = _issTags.reduce((s, t) => s + (+t.qty || 0), 0);
  const batchCap     = Math.min(remaining, ISS_BATCH_MAX);
  const canAddMore   = sessionTotal < batchCap;
  const pct          = Math.round((sessionTotal / ISS_BATCH_MAX) * 100);
  const minMet       = sessionTotal >= ISS_BATCH_MIN;
  const barColor     = sessionTotal === 0 ? 'var(--bdr-mid)'
                     : !minMet           ? 'var(--warn)'
                     : sessionTotal < ISS_BATCH_MAX ? 'var(--ok)'
                     : 'var(--imf-navy)';
  const maxQtyForInput = Math.min(remaining - sessionTotal, ISS_BATCH_MAX - sessionTotal);

  w.innerHTML = `
    <div class="card mt-8" style="padding:0;overflow:hidden">

      <!-- Header -->
      <div style="padding:12px 16px;background:var(--imf-navy);color:#fff;display:flex;align-items:center;gap:10px">
        <i class="ti ti-tags" style="font-size:18px;opacity:.85"></i>
        <div style="flex:1;min-width:0">
          <div style="font-weight:700;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${_issLine.partName}</div>
          <div style="font-size:11px;opacity:.7;margin-top:1px">${_issLine.partNo || ''}</div>
        </div>
        <div style="text-align:right;flex-shrink:0">
          <div style="font-size:22px;font-weight:900;line-height:1">${sessionTotal}</div>
          <div style="font-size:10px;opacity:.7">of ${ISS_BATCH_MAX} max</div>
        </div>
      </div>

      <!-- Range progress bar -->
      <div style="padding:10px 16px 0;background:var(--sur2);border-bottom:1px solid var(--bdr)">
        <div style="display:flex;justify-content:space-between;font-size:10px;font-weight:700;
                    color:var(--txt-muted);margin-bottom:4px;letter-spacing:.04em">
          <span style="color:${!minMet && sessionTotal > 0 ? 'var(--warn)' : 'var(--txt-muted)'}">MIN ${ISS_BATCH_MIN}</span>
          <span>${sessionTotal} pcs in session</span>
          <span>MAX ${ISS_BATCH_MAX}</span>
        </div>
        <div style="height:6px;background:var(--bdr);border-radius:3px;overflow:visible;position:relative;margin-bottom:10px">
          <!-- Min marker -->
          <div style="position:absolute;left:${ISS_BATCH_MIN}%;top:-2px;width:2px;height:10px;
                      background:var(--warn);border-radius:1px;z-index:1"></div>
          <!-- Fill -->
          <div style="height:100%;width:100%;background:${barColor};border-radius:3px;
                      transform:scaleX(${(Math.min(100, pct) / 100).toFixed(4)});transform-origin:left;
                      transition:transform .2s,background .2s"></div>
        </div>
        <!-- Stats row -->
        <div style="display:flex;gap:16px;padding-bottom:10px;font-size:12px">
          <span style="color:var(--txt-muted)">Approved: <strong style="color:var(--txt)">${_issLine.qtyApproved}</strong></span>
          <span style="color:var(--txt-muted)">Issued before: <strong style="color:var(--txt)">${issued}</strong></span>
          <span style="color:var(--txt-muted)">Remaining: <strong style="color:${remaining > 0 ? 'var(--ok)' : 'var(--err)'}">${remaining}</strong></span>
        </div>
      </div>

      <!-- Add TAG input -->
      <div style="padding:14px 16px">
        ${canAddMore ? `
          <button class="qr-scan-btn mb-12" onclick="issScanTag()" style="width:100%">
            <i class="ti ti-qrcode"></i> Scan TAG
          </button>
          <div style="display:grid;grid-template-columns:1fr 120px;gap:8px;margin-bottom:10px">
            <div class="f" style="margin:0">
              <label>TAG Number</label>
              <input id="iss-tag-input" type="text" placeholder="e.g. TAG042"
                oninput="this.value=this.value.toUpperCase()" autocomplete="off"
                onkeydown="if(event.key==='Enter'){event.preventDefault();document.getElementById('iss-tag-qty').focus()}">
            </div>
            <div class="f" style="margin:0">
              <label>Qty / TAG</label>
              <input id="iss-tag-qty" type="number" min="1" max="${maxQtyForInput}" placeholder="pcs"
                onkeydown="if(event.key==='Enter'){event.preventDefault();issAddTag()}">
            </div>
          </div>
          <button class="btn btn-s w-full" style="border:1.5px dashed var(--imf-navy);color:var(--imf-navy);background:var(--imf-steel-light)" onclick="issAddTag()">
            <i class="ti ti-plus"></i> Add TAG to Session
          </button>
          ${!minMet && sessionTotal > 0 ? `
            <div class="wbox" style="margin-top:8px">
              <i class="ti ti-info-circle" style="flex-shrink:0"></i>
              <div>Minimum batch is ${ISS_BATCH_MIN} pcs — add ${ISS_BATCH_MIN - sessionTotal} more to submit.</div>
            </div>` : ''}
        ` : `
          <div class="sbox">
            <i class="ti ti-circle-check" style="font-size:16px;flex-shrink:0"></i>
            <span>Batch full — ${sessionTotal} pcs assigned (max ${ISS_BATCH_MAX}).</span>
          </div>`}
      </div>

      <!-- TAG list -->
      ${_issTags.length ? `
        <div style="border-top:1px solid var(--bdr);padding:12px 16px 0">
          <div style="font-size:11px;font-weight:700;color:var(--txt-muted);letter-spacing:.05em;margin-bottom:8px">
            TAGS IN SESSION (${_issTags.length})
          </div>
          <div style="display:flex;flex-direction:column;gap:4px;margin-bottom:12px">
            ${_issTags.map((t, i) => `
              <div style="display:flex;align-items:center;gap:10px;padding:8px 10px;
                          background:var(--sur2);border-radius:var(--rxs);border:1px solid var(--bdr)">
                <i class="ti ti-tag" style="color:var(--imf-navy);opacity:.7;font-size:15px;flex-shrink:0"></i>
                <span style="font-family:monospace;font-weight:700;font-size:13px;flex:1">${t.tagId}</span>
                <span style="font-size:12px;color:var(--txt-muted)">${t.qty} pcs</span>
                <button class="btn btn-d btn-sm" onclick="issRemoveTag(${i})" aria-label="Remove" style="padding:3px 7px">
                  <i class="ti ti-x"></i>
                </button>
              </div>`).join('')}
          </div>
          <div style="font-size:11px;color:var(--txt-muted);margin-bottom:12px;display:flex;align-items:center;gap:6px">
            <i class="ti ti-barcode"></i> Batch: <strong>${_issBatchCode}</strong>
          </div>
        </div>
        <div style="padding:0 16px 16px">
          ${minMet ? `
            <button class="btn btn-p w-full" onclick="issSubmitSession()" style="font-size:15px;padding:14px">
              <i class="ti ti-send"></i> Issue ${_issTags.length} TAG${_issTags.length > 1 ? 's' : ''} · ${sessionTotal} pcs to WIP
            </button>` : `
            <button class="btn w-full" disabled style="font-size:13px;background:var(--bdr);color:var(--txt-muted);cursor:not-allowed;padding:13px">
              <i class="ti ti-lock"></i> Need ${ISS_BATCH_MIN - sessionTotal} more pcs to reach minimum
            </button>`}
        </div>
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
  if (sessionTotal + qty > remaining) { toast(`Only ${remaining - sessionTotal} pcs remaining on this requisition line`); return; }
  if (sessionTotal + qty > ISS_BATCH_MAX) { toast(`Batch limit: max ${ISS_BATCH_MAX} pcs per session. Only ${ISS_BATCH_MAX - sessionTotal} pcs left in this batch.`); return; }
  if (_issTags.find(t => t.tagId === tagId)) { toast(tagId + ' already added in this session'); return; }

  try {
    const existing = await db.collection('routeCards').doc(tagId).get();
    if (existing.exists) { toast(tagId + ' is already in use (status: ' + existing.data().status + ')'); return; }
  } catch (e) {
    toast('Error checking TAG: ' + friendlyError(e));
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
  const sessionTotal = _issTags.reduce((s, t) => s + (+t.qty || 0), 0);
  if (sessionTotal < ISS_BATCH_MIN) { toast(`Minimum batch is ${ISS_BATCH_MIN} pcs. Current session total: ${sessionTotal} pcs.`); return; }
  if (sessionTotal > ISS_BATCH_MAX) { toast(`Batch exceeds maximum ${ISS_BATCH_MAX} pcs. Current: ${sessionTotal} pcs.`); return; }

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

    // Stock guard — prevent issuing more than physically available
    const stockAvail = reqCalcStock(_issLine.partId);
    if (sessionTotal > stockAvail) {
      toast(`Cannot issue: only ${stockAvail} pcs in stock for ${_issLine.partName}, requested ${sessionTotal} pcs.`);
      return;
    }

    const updatedLines = _issReq.lines.map(l => {
      if (l.lineNo !== _issLine.lineNo) return l;
      const alreadyIssued = issLineIssued(_issReq.id, l.lineNo);
      return { ...l, qtyIssued: alreadyIssued + sessionTotal };
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
    toast(friendlyError(e));
  }
}

/* ══════════════════════════════════════════════════════════════════════
   SECTION 5 — STOCK BALANCE
   Aggregates per individual part (not per delivery lot).
   Available = max(0, total received − total issued to WIP).
   ══════════════════════════════════════════════════════════════════════ */

const STOCK_PERIODS = [
  { key: 'all',   label: 'All Time'   },
  { key: 'year',  label: 'This Year'  },
  { key: 'month', label: 'This Month' },
  { key: 'week',  label: 'This Week'  },
  { key: 'today', label: 'Today'      },
];

function setStockPeriod(p) { _stockPeriod = p; renderStock(); }

function inPeriod(dateStr_, period) {
  if (!dateStr_ || period === 'all') return true;
  const today = dateStr();
  const [y, m] = today.split('-');
  if (period === 'today') return dateStr_ === today;
  if (period === 'month') return dateStr_.startsWith(`${y}-${m}`);
  if (period === 'year')  return dateStr_.startsWith(y);
  if (period === 'week') {
    const d = new Date(today); d.setDate(d.getDate() - d.getDay()); /* Sunday start */
    const weekStart = d.toISOString().slice(0, 10);
    return dateStr_ >= weekStart && dateStr_ <= today;
  }
  return true;
}

function tsToDateStr(ts) {
  if (!ts) return '';
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toISOString().slice(0, 10);
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

  /* ── 2. Issued per part (all time, for available balance) ───── */
  const issuedByPart = {};
  S.routeCards.forEach(rc => {
    const key = rc.partId || rc.partName;
    if (!key) return;
    issuedByPart[key] = (issuedByPart[key] || 0) + (+rc.issuedQty || 0);
  });

  /* ── 2b. Period-filtered received + issued per part (table cols) ─ */
  const rcvdByPartPeriod = {};
  S.inward.forEach(r => {
    if (!inPeriod(r.date, _stockPeriod)) return;
    (r.parts || []).forEach(p => {
      const key = p.partId || p.partName;
      if (!key) return;
      rcvdByPartPeriod[key] = (rcvdByPartPeriod[key] || 0) + (+p.qty || 0);
    });
  });

  const issdByPartPeriod = {};
  S.routeCards.forEach(rc => {
    if (!inPeriod(tsToDateStr(rc.issuedAt), _stockPeriod)) return;
    const key = rc.partId || rc.partName;
    if (!key) return;
    issdByPartPeriod[key] = (issdByPartPeriod[key] || 0) + (+rc.issuedQty || 0);
  });

  /* ── 3. Build part list ───────────────────────────────────────── */
  let partList = Object.entries(byPart).map(([key, p]) => {
    const issued     = issuedByPart[key] || 0;
    const overIssued = issued > p.received;
    const available  = Math.max(0, p.received - issued);
    const value      = p.lots.reduce((s, l) => s + l.qty * l.rate, 0);
    return { ...p, key, issued, available, value, overIssued,
             rcvdPeriod: rcvdByPartPeriod[key] || 0,
             issdPeriod: issdByPartPeriod[key] || 0 };
  });

  /* ── 4. Period-filtered stat card values ─────────────────────── */
  const rcvdFiltered = S.inward.reduce((s, r) => {
    if (!inPeriod(r.date, _stockPeriod)) return s;
    return s + (r.parts || []).reduce((a, p) => a + (+p.qty || 0), 0);
  }, 0);

  const issdFiltered = S.routeCards.reduce((s, rc) => {
    if (!inPeriod(tsToDateStr(rc.issuedAt), _stockPeriod)) return s;
    return s + (+rc.issuedQty || 0);
  }, 0);

  /* ── 5. Overall stats ─────────────────────────────────────────── */
  const totalAvailable  = partList.reduce((s, p) => s + p.available, 0);
  const totalValue      = partList.reduce((s, p) => s + p.value,     0);
  const overIssuedCount = partList.filter(p => p.overIssued).length;

  /* IQC quarantine stats — material awaiting/rejected inspection is excluded from available */
  const iqcPending  = S.inward.filter(r => r.iqcStatus === 'pending');
  const iqcRejected = S.inward.filter(r => r.iqcStatus === 'rejected');
  const pendingPcs  = iqcPending.reduce((s, r) => s + (r.parts||[]).reduce((a,p)=>a+(+p.qty||0),0), 0);
  const rejectedPcs = iqcRejected.reduce((s, r) => s + (r.parts||[]).reduce((a,p)=>a+(+p.qty||0),0), 0);

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

  /* ── 8. Stat cards + unified period filter ────────────────────── */
  const statCard = (opts) => `
    <div style="background:var(--sur);border:1px solid var(--bdr);border-radius:var(--rs);
                padding:14px 16px;border-top:3px solid ${opts.accent};
                display:flex;flex-direction:column;min-height:100px;box-sizing:border-box">
      <div style="font-size:10px;font-weight:800;letter-spacing:.07em;color:${opts.accent};margin-bottom:8px">${opts.label}</div>
      <div style="display:flex;align-items:flex-end;justify-content:space-between;flex:1">
        <div>
          <div style="font-size:26px;font-weight:900;line-height:1;color:var(--txt)">${opts.value}</div>
          <div style="font-size:11px;color:var(--txt-muted);margin-top:4px">${opts.sub}</div>
        </div>
        <i class="ti ${opts.icon}" style="font-size:28px;color:${opts.accent};opacity:.15;flex-shrink:0;margin-left:8px"></i>
      </div>
      ${opts.extra ? `<div style="font-size:11px;color:var(--txt-muted);border-top:1px solid var(--bdr);padding-top:6px;margin-top:8px">${opts.extra}</div>` : ''}
    </div>`;

  const periodLabel = STOCK_PERIODS.find(p => p.key === _stockPeriod)?.label || 'All Time';
  const periodSelector = `
    <div style="display:flex;gap:4px;background:var(--sur2);border:1px solid var(--bdr);
                border-radius:var(--rpill);padding:3px;margin-bottom:12px;overflow-x:auto;flex-wrap:nowrap">
      ${STOCK_PERIODS.map(p => `
        <button onclick="setStockPeriod('${p.key}')"
          style="flex:1;min-width:60px;padding:6px 10px;border-radius:var(--rpill);border:none;cursor:pointer;
                 font-size:12px;font-weight:${_stockPeriod===p.key?'700':'500'};white-space:nowrap;
                 background:${_stockPeriod===p.key?'var(--imf-navy)':'transparent'};
                 color:${_stockPeriod===p.key?'#fff':'var(--txt-muted)'};transition:all .15s">
          ${p.label}
        </button>`).join('')}
    </div>`;

  const statsHtml = `
    ${periodSelector}
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:14px">
      ${statCard({
        label: 'AVAILABLE',
        value: totalAvailable.toLocaleString('en-IN'),
        sub:   'pcs · always current',
        icon:  'ti-package',
        accent:'var(--ok)',
        extra: totalValue > 0 ? `${fmtINR(totalValue)} total stock value` : '',
      })}
      ${statCard({
        label: 'RECEIVED',
        value: rcvdFiltered.toLocaleString('en-IN'),
        sub:   `pcs · ${periodLabel.toLowerCase()}`,
        icon:  'ti-package-import',
        accent:'var(--acc)',
      })}
      ${statCard({
        label: 'ISSUED TO WIP',
        value: issdFiltered.toLocaleString('en-IN'),
        sub:   `pcs · ${periodLabel.toLowerCase()}`,
        icon:  'ti-arrow-bar-right',
        accent:'#7c3aed',
      })}
    </div>`;

  document.getElementById('section-content').innerHTML = `
    <div style="font-size:16px;font-weight:700;margin-bottom:12px">Stock Balance</div>

    ${statsHtml}

    ${pendingPcs > 0 ? `
      <button type="button" onclick="switchTab('iqc')" class="wbox" style="cursor:pointer;width:100%;text-align:left;border:1px solid var(--warn-bdr);font:inherit">
        <i class="ti ti-microscope" style="flex-shrink:0"></i>
        <span><strong>${pendingPcs} pcs</strong> across ${iqcPending.length} lot${iqcPending.length>1?'s':''} are quarantined, pending IQC — not counted in available stock</span>
        <i class="ti ti-chevron-right" style="margin-left:auto"></i>
      </button>` : ''}
    ${rejectedPcs > 0 ? `
      <div class="ebox">
        <i class="ti ti-ban" style="flex-shrink:0"></i>
        <span><strong>${rejectedPcs} pcs</strong> across ${iqcRejected.length} lot${iqcRejected.length>1?'s':''} rejected by IQC — quarantined, excluded from stock</span>
      </div>` : ''}
    ${overIssuedCount ? `
      <div class="ebox" style="margin-bottom:10px">
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
      : `<div style="font-size:11px;color:var(--txt-muted);margin-bottom:4px">${partList.length} component${partList.length!==1?'s':''} · tap a row for the received/issued breakdown</div>
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
    const availColor = isOver || isOut ? 'var(--err)' : isLow ? 'var(--warn)' : 'var(--ok)';
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
                ${l.invoiceNo ? ` · INV: ${l.invoiceNo}` : (!l.dcNo || isInterCompany(l.supplierName) ? '' : ` · <span style="color:var(--warn)">Invoice pending</span>`)}
              </div>
            </div>
            <div style="text-align:right;flex-shrink:0;font-size:12px">
              <div style="font-weight:700;color:${lotAvail>0?'var(--ok)':'var(--err)'}">
                ${lotAvail} <span style="font-weight:400;color:var(--txt-muted)">avail</span>
              </div>
              <div style="color:var(--txt-muted)">${lotIssued} issued of ${l.qty}</div>
            </div>
          </div>
          <div class="prog" style="margin-top:6px">
            <div class="pf ${lotPct>50?'pg':lotPct>20?'pa':'pr'}" style="transform:scaleX(${(Math.min(100,lotPct)/100).toFixed(4)})"></div>
          </div>
        </div>`;
    }).join('');

    const statusBdg = isOver ? `<span class="bdg bdg-r"><i class="ti ti-alert-triangle"></i> Over-issued by ${p.issued - p.received}</span>`
                     : isOut ? `<span class="bdg bdg-r">Out of stock</span>`
                     : isLow ? `<span class="bdg bdg-a">Low stock</span>` : '';

    return `
      <div style="border-bottom:1px solid var(--bdr);${isOver?'background:var(--err-bg);':''}">
        <button type="button" onclick="_stockExpanded['${p.key}']=!_stockExpanded['${p.key}'];renderStock()"
          class="stk-row-btn" aria-expanded="${!!expanded}">
          <div class="stk-row-main">
            <div class="stk-row-name">${p.partName}</div>
            <div class="stk-row-meta">
              ${p.partNo ? `<span class="mono">${p.partNo}</span>` : ''}
              ${p.custName ? `<span>${p.partNo ? '· ' : ''}${p.custName}</span>` : ''}
            </div>
            ${statusBdg}
          </div>
          <div class="stk-row-avail">
            <div class="stk-row-avail-num" style="color:${availColor}">${p.available}</div>
            <div class="stk-row-avail-lbl">available</div>
          </div>
          <i class="ti ti-chevron-${expanded ? 'up' : 'down'}" aria-hidden="true" style="color:var(--txt-dim);flex-shrink:0"></i>
        </button>
        ${expanded ? `
          <div style="padding:0 12px 12px">
            <div class="stk-detail-stats">
              <div>
                <span class="stk-detail-lbl">Received · ${periodLabel}</span>
                <span class="stk-detail-val">${p.rcvdPeriod}</span>
              </div>
              <div>
                <span class="stk-detail-lbl">Issued · ${periodLabel}</span>
                <span class="stk-detail-val">${p.issdPeriod}</span>
              </div>
              <div>
                <span class="stk-detail-lbl">Total Received (all time)</span>
                <span class="stk-detail-val">${p.received}</span>
              </div>
            </div>
            <div class="prog" style="margin-bottom:10px">
              <div class="pf ${isOver||isOut?'pr':isLow?'pa':'pg'}" style="transform:scaleX(${(Math.min(100,isOver?100:pct)/100).toFixed(4)})"></div>
            </div>
            ${lotRows}
          </div>` : ''}
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
    { v: 'soft_done', l: 'Soft Done' },
    { v: 'ht_queue', l: 'HT Queue' },
    { v: 'ht_done', l: 'HT Done' },
    { v: 'hard_wip', l: 'Hard WIP' },
    { v: 'qc_pending', l: 'QC Pending' },
    { v: 'qc_cleared', l: 'QC Cleared' },
    { v: 'dispatched', l: 'Dispatched' },
    { v: 'scrapped', l: 'Scrapped' },
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
    showModalError(friendlyError(e));
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
    showModalError(friendlyError(e));
  }
}

/* ══════════════════════════════════════════════════════════════════════
   BOOT
   ══════════════════════════════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', init);
