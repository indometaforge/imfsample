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
let _rcSort   = { key: 'ts', dir: 'desc' };  /* imf-table sort state for Route Cards */
let _rcPage   = 1;
const RC_PAGE_SIZE = 25;
let _rcDateFrom = daysAgoStr(30);  /* WIP / Route Cards date-range filter — defaults to last 30 days */
let _rcDateTo    = dateStr();

let _stockSearch   = '';    /* Stock Balance search query */
let _stockCustFilt = 'all'; /* Stock Balance customer filter */
let _stockSupFilt  = 'all'; /* Stock Balance supplier filter */
let _stockExpanded = {};    /* partId → bool (lot rows expanded) */
let _stockPeriod   = 'all'; /* Unified period for Received + Issued stats — 'custom' when a date range is set */
let _stockDateFrom = '';    /* Custom date-range filter, used when _stockPeriod === 'custom' */
let _stockDateTo   = '';

/* Lot selection at issuance */
let _issLot = null;    /* masterLotCode chosen by storeperson for this session */

let _inwParts = [];     /* [{partId,partNo,partName,qty,rate}] — Inward modal */
let _inwLinkedDispatchIds = [];  /* supplierDispatches ids picked as the source of this receipt — Inward modal */
let _reqLines = [];     /* [{lineNo,partId,partNo,partName,customerId,customerName,masterLotCode,qtyRequested,qtyApproved,qtyIssued}] */

/* Issue-to-WIP session state */
let _issReq      = null;
let _issLine     = null;
let _issTags     = [];  /* [{tagId, qty, issueDate}] */
let _issBatchCode = '';
let _issPendingTag = null;  /* tagId just captured (scan or manual modal), awaiting qty before it's added to _issTags */

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
  // Read-only here — store.js never writes to supplierDispatches. Loaded
  // so Inward Receipt can optionally link a receipt back to the SCM
  // dispatch(es) it physically arrived against (see openInwardModal),
  // carrying the forging lotNo through to the route card for traceability.
  S.supplierDispatches = S.supplierDispatches || [];

  const [inwSnap, reqSnap, rcSnap, tagDoc, dispSnap] = await Promise.all([
    db.collection('inward').get(),
    db.collection('requisitions').get(),
    db.collection('routeCards').get(),
    db.collection('config').doc('tags').get(),
    db.collection('supplierDispatches').get(),
  ]);

  S.inward       = inwSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  S.requisitions = reqSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  S.routeCards   = rcSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  S.tagConfig    = tagDoc.exists ? tagDoc.data() : { totalPrinted: 0, lastTagNum: 0 };
  S.supplierDispatches = dispSnap.docs.map(d => ({ id: d.id, ...d.data() }));
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
  _inwExpanded = {};
  _stockSearch = ''; _stockCustFilt = 'all'; _stockSupFilt = 'all'; _stockExpanded = {};
  _stockPeriod = 'all'; _stockDateFrom = ''; _stockDateTo = '';
  _issReq = null; _issLine = null; _issTags = []; _issBatchCode = ''; _issLot = null; _issPendingTag = null;
  _rcPage = 1;
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


function onSearchInput(val) {
  searchQ = val;
  renderSection();
  const el = document.getElementById('store-search');
  if (el) { el.focus(); el.setSelectionRange(val.length, val.length); }
}


/** Empty state block (v2 .imf-empty styling — store.js only) */
function emptyState(icon, title, msg, ctaHtml = '') {
  return `
    <div class="imf-empty">
      <div class="ic"><i class="ti ${icon}" aria-hidden="true"></i></div>
      <h3>${title}</h3>
      <p>${msg}</p>
      ${ctaHtml}
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
/* v2 "iOS + Notion" badge system (design_byclaudedesign) — store.js pilot only.
   Each entry: { cls: '.st-*'/'.rag-*' from styles.css, icon: tabler glyph, label, rank? } */
const RC_META = {
  store_issued: { cls: 'st-store_issued', icon: 'ti-package-import',         label: 'Store Issued', rank: 0 },
  soft_wip:     { cls: 'st-soft_wip',     icon: 'ti-progress',               label: 'Soft WIP',     rank: 1 },
  soft_done:    { cls: 'st-soft_done',    icon: 'ti-circle-check',           label: 'Soft Done',    rank: 2 },
  ht_queue:     { cls: 'st-ht_queue',     icon: 'ti-flame',                  label: 'HT Queue',     rank: 3 },
  sb_pending:   { cls: 'st-sb_pending',   icon: 'ti-temperature',            label: 'SB Pending',   rank: 4 },
  sb_wip:       { cls: 'st-sb_wip',       icon: 'ti-circles',                label: 'Shot Blast WIP', rank: 5 },
  ht_done:      { cls: 'st-ht_done',      icon: 'ti-circle-check',           label: 'HT Done',      rank: 6 },
  hard_wip:     { cls: 'st-hard_wip',     icon: 'ti-tool',                   label: 'Hard WIP',     rank: 7 },
  qc_pending:   { cls: 'st-qc_pending',   icon: 'ti-microscope',             label: 'QC Pending',   rank: 8 },
  qc_cleared:   { cls: 'st-qc_cleared',   icon: 'ti-rosette-discount-check', label: 'QC Cleared',   rank: 9 },
  dispatched:   { cls: 'st-dispatched',   icon: 'ti-truck-delivery',         label: 'Dispatched',   rank: 10 },
  scrapped:     { cls: 'st-scrapped',     icon: 'ti-trash-x',                label: 'Scrapped',     rank: 11 },
};
const REQ_META = {
  pending:   { cls: 'rag-b', icon: 'ti-clock',          label: 'Pending Approval' },
  approved:  { cls: 'rag-g', icon: 'ti-circle-check',   label: 'Approved' },
  partial:   { cls: 'rag-a', icon: 'ti-alert-triangle', label: 'Partially Issued' },
  fulfilled: { cls: 'rag-g', icon: 'ti-circle-check',   label: 'Fulfilled' },
  rejected:  { cls: 'rag-r', icon: 'ti-alert-octagon',  label: 'Rejected' },
};
const IQC_META = {
  pending:     { cls: 'rag-b', icon: 'ti-clock',          label: 'IQC Pending' },
  accepted:    { cls: 'rag-g', icon: 'ti-circle-check',   label: 'Accepted' },
  conditional: { cls: 'rag-a', icon: 'ti-alert-triangle', label: 'Conditional' },
  rejected:    { cls: 'rag-r', icon: 'ti-alert-octagon',  label: 'Rejected' },
};

/** Render a colour+icon .imf-badge for the given status against a *_META map */
function imfBadge(status, meta) {
  const m = meta[status];
  if (!m) return `<span class="imf-badge rag-b"><i class="ti ti-help-circle" aria-hidden="true"></i>${status || '—'}</span>`;
  return `<span class="imf-badge ${m.cls}"><i class="ti ${m.icon}" aria-hidden="true"></i>${m.label}</span>`;
}

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
/** Filtered + date-sorted Inward receipts — shared by render and export. */
function getFilteredInward(q) {
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
  return list.slice().sort((a, b) => (b.date || '').localeCompare(a.date || ''));
}

function renderInward() {
  const q = searchQ.trim().toLowerCase();
  const activeSups = S.suppliers.filter(s => s.active !== false);
  const invPendingCount = S.inward.filter(r => r.dcNo && !r.invoiceNo && !isInterCompany(r.supplierName)).length;
  const iqcPendingCount = S.inward.filter(r => r.iqcStatus === 'pending').length;

  const list = getFilteredInward(q);

  document.getElementById('section-content').innerHTML = `
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

    <div class="imf-tablewrap">
      <div class="imf-table-toolbar">
        <div class="grow">
          <div style="font-size:16px;font-weight:700">Inward Receipts</div>
          <div class="text-sm text-muted">${list.length} receipt${list.length!==1?'s':''} · tap a row to expand the part breakdown</div>
        </div>
        <div class="imf-search">
          <i class="ti ti-search" aria-hidden="true"></i>
          <input type="search" id="store-search" placeholder="Search supplier, lot, DC or invoice..." value="${(searchQ || '').replace(/"/g, '&quot;')}" oninput="onSearchInput(this.value)">
        </div>
        <select class="imf-ghost-select" onchange="_inwFilt=this.value;renderSection()">
          <option value="all" ${_inwFilt === 'all' ? 'selected' : ''}>All Receipts</option>
          ${iqcPendingCount ? `<option value="__iqc_pending__" ${_inwFilt === '__iqc_pending__' ? 'selected' : ''}>IQC Pending (${iqcPendingCount})</option>` : ''}
          ${invPendingCount ? `<option value="__inv_pending__" ${_inwFilt === '__inv_pending__' ? 'selected' : ''}>Invoice Pending (${invPendingCount})</option>` : ''}
          ${activeSups.map(s => `<option value="${s.id}" ${s.id === _inwFilt ? 'selected' : ''}>${s.name}</option>`).join('')}
        </select>
        <button class="btn btn-ghost btn-sm" onclick="exportInwardExcel()"><i class="ti ti-file-spreadsheet" aria-hidden="true"></i> Export</button>
        ${canDo('inward') ? `<button class="btn btn-p btn-sm" onclick="openInwardModal()"><i class="ti ti-plus" aria-hidden="true"></i> Add Receipt</button>` : ''}
      </div>
      ${list.length === 0 ? emptyState('ti-package-import', 'No inward receipts found',
          _inwFilt === '__inv_pending__' ? 'No receipts with pending invoices.'
          : _inwFilt === '__iqc_pending__' ? 'No lots awaiting IQC.'
          : 'Add a receipt to record material coming in from a supplier.') : `
      <div class="imf-table-scroll">
        <table class="imf-table">
          <thead><tr>
            <th class="pin">Lot Code</th>
            <th>Supplier</th>
            <th class="num">Date</th>
            <th>Parts</th>
            <th class="num">Qty</th>
            <th>Invoice</th>
            <th>IQC</th>
            <th></th>
          </tr></thead>
          <tbody>${list.map(inwardTableRows).join('')}</tbody>
        </table>
      </div>`}
    </div>
    ${list.length > 0 ? `<div class="imf-cards">${list.map(inwardCard).join('')}</div>` : ''}
  `;
}

function inwardTableRows(r) {
  const parts = r.parts || [];
  const totalPcs = parts.reduce((s, p) => s + (+p.qty || 0), 0);
  const invPending = r.dcNo && !r.invoiceNo && !isInterCompany(r.supplierName);
  const iqcStatus = r.iqcStatus || null; /* legacy records without iqcStatus are grandfathered */
  const expanded = !!_inwExpanded[r.id];
  const partLabel = parts.length === 1 ? (parts[0].partName || '1 part') : `${parts.length} parts`;

  const mainRow = `
    <tr>
      <td class="pin mono">${r.masterLotCode || '—'}</td>
      <td>${r.supplierName || '—'}</td>
      <td class="num">${fmtDate(r.date)}</td>
      <td>${partLabel}</td>
      <td class="num">${totalPcs.toLocaleString('en-IN')}</td>
      <td>${invPending ? '<span class="imf-badge rag-a"><i class="ti ti-alert-triangle" aria-hidden="true"></i>Invoice Pending</span>' : '<span class="dim">—</span>'}</td>
      <td>${iqcStatus ? imfBadge(iqcStatus, IQC_META) : '<span class="dim">—</span>'}</td>
      <td style="white-space:nowrap">
        ${canDo('inward') ? `<button class="imf-rowact" onclick="openInwardModal('${r.id}')" aria-label="Edit receipt"><i class="ti ti-edit" aria-hidden="true"></i></button>` : ''}
        <button class="imf-rowact" onclick="_inwExpanded['${r.id}']=!_inwExpanded['${r.id}'];renderSection()" aria-expanded="${expanded}" aria-label="Toggle part breakdown"><i class="ti ti-chevron-${expanded ? 'up' : 'down'}" aria-hidden="true"></i></button>
      </td>
    </tr>`;

  if (!expanded) return mainRow;
  return mainRow + `<tr><td colspan="8" style="background:var(--sur2);padding:0 16px 16px">${inwardPartBreakdown(r)}</td></tr>`;
}

function inwardPartBreakdown(r) {
  const parts = r.parts || [];
  const totalVal = parts.reduce((s, p) => s + ((+p.qty || 0) * (+p.rate || 0)), 0);
  const lotNos = getLinkedLotNos(r); // live — never read a cached field for this
  return `
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
    ${lotNos.length ? `<div class="inw-detail-meta"><span><strong>Forging Lot(s):</strong> <span class="mono">${lotNos.join(', ')}</span></span></div>` : ''}`;
}

/** Export the currently filtered Inward receipts as a branded Excel report — one row per part-line. */
async function exportInwardExcel() {
  const q = searchQ.trim().toLowerCase();
  const list = getFilteredInward(q);
  if (!list.length) { toast('Nothing to export — no inward receipts match the current filters.'); return; }

  const rows = [];
  list.forEach(r => {
    const invPending = r.dcNo && !r.invoiceNo && !isInterCompany(r.supplierName);
    (r.parts || []).forEach(p => {
      rows.push({
        lotCode:   r.masterLotCode || '—',
        supplier:  r.supplierName || '—',
        date:      fmtDate(r.date),
        partNo:    p.partNo || '',
        partName:  p.partName || '—',
        qty:       +p.qty || 0,
        rate:      +p.rate || 0,
        value:     (+p.qty || 0) * (+p.rate || 0),
        dcNo:      r.dcNo || '—',
        invoiceNo: invPending ? 'Pending' : (r.invoiceNo || '—'),
        iqcStatus: r.iqcStatus ? (IQC_META[r.iqcStatus]?.label || r.iqcStatus) : '—',
      });
    });
  });

  const totals = rows.reduce((t, r) => { t.qty += r.qty; t.value += r.value; return t; }, { qty: 0, value: 0 });
  const supplierLabel = _inwFilt === 'all' ? 'All Suppliers'
    : _inwFilt === '__inv_pending__' ? 'Invoice Pending'
    : _inwFilt === '__iqc_pending__' ? 'IQC Pending'
    : (S.suppliers.find(s => s.id === _inwFilt)?.name || 'All Suppliers');

  await exportToExcel({
    filename: `IMF_Inward_Report_${dateStr()}.xlsx`,
    reportTitle: 'Inward Receipts Report',
    filterSummary: `Filter: ${supplierLabel} · ${list.length} receipt${list.length !== 1 ? 's' : ''}, ${rows.length} line item${rows.length !== 1 ? 's' : ''}`,
    columns: [
      { header: 'Lot Code',   key: 'lotCode',   width: 18 },
      { header: 'Supplier',   key: 'supplier',  width: 22 },
      { header: 'Date',       key: 'date',       width: 12 },
      { header: 'Part No.',   key: 'partNo',     width: 14 },
      { header: 'Part Name',  key: 'partName',   width: 24 },
      { header: 'Qty',        key: 'qty',        width: 10, align: 'right', numFmt: '#,##0' },
      { header: 'Rate',       key: 'rate',       width: 12, align: 'right', numFmt: '₹#,##0.00' },
      { header: 'Value',      key: 'value',      width: 14, align: 'right', numFmt: '₹#,##0.00' },
      { header: 'DC No.',     key: 'dcNo',       width: 14 },
      { header: 'Invoice No.',key: 'invoiceNo',  width: 14 },
      { header: 'IQC Status', key: 'iqcStatus',  width: 14 },
    ],
    rows,
    totals,
  });
}

function inwardCard(r) {
  const parts = r.parts || [];
  const totalPcs = parts.reduce((s, p) => s + (+p.qty || 0), 0);
  const invPending = r.dcNo && !r.invoiceNo && !isInterCompany(r.supplierName);
  const iqcStatus = r.iqcStatus || null;
  const expanded = !!_inwExpanded[r.id];
  const partLabel = parts.length === 1 ? (parts[0].partName || '1 part') : `${parts.length} parts`;

  return `
    <div class="imf-card">
      <div class="imf-card-top" onclick="_inwExpanded['${r.id}']=!_inwExpanded['${r.id}'];renderSection()" style="cursor:pointer">
        <span class="imf-mono">${r.masterLotCode || '—'}</span>
        <div class="grow"></div>
        ${invPending ? '<span class="imf-badge rag-a"><i class="ti ti-alert-triangle" aria-hidden="true"></i>Invoice Pending</span>' : ''}
        ${iqcStatus ? imfBadge(iqcStatus, IQC_META) : ''}
        <i class="ti ti-chevron-${expanded ? 'up' : 'down'}" aria-hidden="true" style="color:var(--txt-dim)"></i>
      </div>
      <div class="imf-card-lead">
        <span class="nm">${r.supplierName || '—'}</span>
        <span class="qty">${totalPcs.toLocaleString('en-IN')}<small> pcs</small></span>
      </div>
      <div class="imf-card-meta"><span class="mono">${fmtDate(r.date)}</span><span>·</span><span>${partLabel}</span></div>
      ${expanded ? inwardPartBreakdown(r) : ''}
      ${canDo('inward') ? `
        <button class="btn btn-s btn-sm w-full mt-8" onclick="openInwardModal('${r.id}')">
          <i class="ti ti-edit" aria-hidden="true"></i> Edit Receipt
        </button>` : ''}
    </div>`;
}

function openInwardModal(id) {
  const r = id ? S.inward.find(x => x.id === id) : null;
  const activeSups = S.suppliers.filter(s => s.active !== false);
  _inwParts = r && r.parts ? r.parts.map(p => ({ ...p })) : [];
  _inwLinkedDispatchIds = r && r.linkedDispatchIds ? [...r.linkedDispatchIds] : [];

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
        <select id="iw-supplier" onchange="previewLotCode();inwRenderDispatchPicker()">
          <option value="">— Select Supplier —</option>
          ${activeSups.map(s => `<option value="${s.id}" ${r && r.supplierId === s.id ? 'selected' : ''}>${s.name} [${s.code}]</option>`).join('')}
        </select>
      </div>
    </div>
    <div id="iw-lot-preview" class="lot-badge" style="display:${r && r.masterLotCode ? 'block' : 'none'}">
      <i class="ti ti-tag" aria-hidden="true"></i> <span id="iw-lot-val">${r?.masterLotCode || ''}</span>
    </div>

    <div class="f" style="margin-top:14px">
      <label style="font-size:12px;font-weight:600;color:var(--txt-muted)">Link to Forging Dispatch(es) <span class="text-xs text-muted" style="font-weight:400">(optional — for RM lot traceability onto the TAG)</span></label>
      <div id="iw-dispatch-picker"></div>
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
  setTimeout(() => inwRenderDispatchPicker(), 50);
}

/** Optional: pick which SCM supplierDispatches this receipt physically
    arrived against, so the forging lotNo can ride through to the TAG
    (see rmLotCodes in issSubmitSession). Purely additive — never required,
    and most non-SCM suppliers (raw steel, packaging, etc.) won't have any
    dispatches to pick from at all. */
function inwRenderDispatchPicker() {
  const wrap = document.getElementById('iw-dispatch-picker');
  if (!wrap) return;
  const supplierId = document.getElementById('iw-supplier')?.value || '';
  const candidates = S.supplierDispatches
    .filter(d => d.supplierId === supplierId && !_inwLinkedDispatchIds.includes(d.id))
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
    .slice(0, 50);

  const linked = _inwLinkedDispatchIds
    .map(id => S.supplierDispatches.find(d => d.id === id))
    .filter(Boolean);

  wrap.innerHTML = `
    ${!supplierId ? `<div class="text-xs text-muted">Select a supplier above to see their dispatches.</div>`
      : !candidates.length && !linked.length ? `<div class="text-xs text-muted">No SCM dispatches found for this supplier — fine to leave unlinked.</div>` : ''}
    ${supplierId && candidates.length ? `
      <div class="flex gap-8" style="margin-bottom:8px">
        <select id="iw-dispatch-select" style="flex:1">
          <option value="">Select a dispatch...</option>
          ${candidates.map(d => `<option value="${d.id}">${fmtDate(d.date)} · ${d.fpn}/${d.cpn} · ${d.qtyDispatched} pcs · ${d.docNo || 'no DC#'}</option>`).join('')}
        </select>
        <button type="button" class="btn btn-s btn-sm" onclick="inwAddDispatchLink()">Add</button>
      </div>` : ''}
    ${linked.length ? `
      <div style="display:flex;flex-wrap:wrap;gap:6px">
        ${linked.map(d => `
          <span class="bdg bdg-n" style="display:inline-flex;align-items:center;gap:6px;padding:6px 10px">
            ${fmtDate(d.date)} · ${d.fpn}/${d.cpn} · ${d.qtyDispatched} pcs
            <i class="ti ti-x" style="cursor:pointer" onclick="inwRemoveDispatchLink('${d.id}')" aria-label="Remove"></i>
          </span>`).join('')}
      </div>` : ''}
  `;
}

function inwAddDispatchLink() {
  const sel = document.getElementById('iw-dispatch-select');
  if (!sel || !sel.value) return;
  _inwLinkedDispatchIds.push(sel.value);
  inwRenderDispatchPicker();
}

function inwRemoveDispatchLink(id) {
  _inwLinkedDispatchIds = _inwLinkedDispatchIds.filter(x => x !== id);
  inwRenderDispatchPicker();
}

/* Inter-company suppliers (own group) transact on DC only — no invoice required. */
function isInterCompany(supplierName) {
  return /indo.?meta.?forge/i.test(supplierName || '');
}

/** Live RM lot-code trace for an inward receipt: walks
    inward.linkedDispatchIds -> the CURRENT supplierDispatches doc (read
    fresh from S, never a cached copy) -> its CURRENT lotAllocations.
    Never store this result — re-derive it every time it's needed, so an
    edited or deleted dispatch is always reflected correctly instead of
    leaving a stale lot code behind on the receipt or any TAG already
    issued from a later read of this same chain. */
function getLinkedLotNos(inwardRec) {
  const ids = inwardRec?.linkedDispatchIds || [];
  const dispatches = ids.map(id => S.supplierDispatches.find(d => d.id === id)).filter(Boolean);
  return [...new Set(dispatches.flatMap(d => (d.lotAllocations || []).map(a => a.lotNo || a.lotId)))];
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
        <button onclick="_inwParts.splice(${i},1);inwRenderParts()" class="btn btn-d btn-sm btn-tap" aria-label="Remove part">
          <i class="ti ti-x" aria-hidden="true"></i>
        </button>
      </div>
      <div class="row-2 mt-8">
        <div class="f" style="margin:0">
          <label style="font-size:11.5px;font-weight:700;color:var(--txt-muted);text-transform:uppercase">Qty (pcs)</label>
          <input type="number" min="1" value="${p.qty || ''}" onchange="_inwParts[${i}].qty=Math.max(1,+this.value||1);inwRenderParts()">
        </div>
        <div class="f" style="margin:0">
          <label style="font-size:11.5px;font-weight:700;color:var(--txt-muted);text-transform:uppercase">Rate (₹/pc)</label>
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
    masterLotCode, deliveryNum,
    // Store ONLY the reference, never a derived copy of the forging lot
    // codes — those live on the dispatch's lotAllocations and can change
    // if a dispatch is later corrected/deleted. Anything that needs the
    // actual RM lot codes (issSubmitSession, the detail view) re-derives
    // them live via getLinkedLotNos() at the moment it needs them.
    linkedDispatchIds: [..._inwLinkedDispatchIds],
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

/* Two-step styled confirmation (no native confirm — CLAUDE.md §6.2) */
function deleteInward(id) {
  const r = S.inward.find(x => x.id === id);
  if (!r) return;
  const parts    = r.parts || [];
  const totalPcs = parts.reduce((s, p) => s + (+p.qty || 0), 0);
  const matLabel = parts.length === 1 ? (parts[0].partName || '1 part') : `${parts.length} parts`;
  openModal(`
    <div class="modal-title" style="color:var(--err)"><i class="ti ti-alert-triangle"></i> Delete Inward Receipt</div>
    <div class="ebox mb-12">
      <i class="ti ti-alert-triangle" aria-hidden="true"></i>
      <span>This permanently deletes this receipt and removes its <strong>${totalPcs} pcs</strong> from stock. This cannot be undone.</span>
    </div>
    <div style="background:var(--sur2);border-radius:var(--rs);padding:10px 12px;margin-bottom:14px">
      <div class="text-sm"><strong>Supplier:</strong> ${r.supplierName || '—'}</div>
      <div class="text-sm"><strong>Date:</strong> ${fmtDate(r.date)}</div>
      ${r.masterLotCode ? `<div class="text-sm"><strong>Lot:</strong> <span class="mono">${r.masterLotCode}</span></div>` : ''}
      <div class="text-sm"><strong>Material:</strong> ${matLabel} · ${totalPcs} pcs</div>
    </div>
    <div id="modal-err"></div>
    <div class="flex gap-8 mt-16">
      <button class="btn btn-d flex-1" onclick="deleteInwardDo('${id}')">
        <i class="ti ti-trash" aria-hidden="true"></i> Confirm Delete
      </button>
      <button class="btn btn-s flex-1" onclick="closeModal()">Cancel</button>
    </div>
  `);
}

async function deleteInwardDo(id) {
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
  // Stock is tracked at the raw-material level: a finished part may be machined
  // from a different raw blank, so resolve to the raw part before summing.
  const R = rawMaterialOf(partId);
  const totalIn = S.inward
    .filter(iw => !iw.iqcStatus || iw.iqcStatus === 'accepted' || iw.iqcStatus === 'conditional')
    .reduce((s, iw) => s + (iw.parts || []).filter(p => p.partId === R).reduce((a, p) => a + (+p.qty || 0), 0), 0);
  const totalIssued = S.routeCards
    .filter(rc => rawMaterialOf(rc.partId) === R)
    .reduce((s, rc) => s + (+rc.issuedQty || 0), 0);
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

/** Export the full Issue-to-WIP history (every TAG ever issued) as a branded Excel report. */
async function exportIssueExcel() {
  const list = S.routeCards.slice().sort((a, b) => (b.issueDate || '').localeCompare(a.issueDate || ''));
  if (!list.length) { toast('Nothing to export — no material has been issued to WIP yet.'); return; }

  const rows = list.map(rc => ({
    tagId:      rc.tagId || '',
    batchCode:  rc.batchCode || '—',
    reqNo:      rc.reqNo || '—',
    partNo:     rc.partNo || '',
    partName:   rc.partName || '—',
    custName:   rc.customerName || '—',
    qty:        +rc.issuedQty || 0,
    masterLot:  rc.masterLotCode || '—',
    issueDate:  fmtDate(rc.issueDate),
    issuedBy:   rc.issuedByName || '—',
  }));

  const totals = rows.reduce((t, r) => { t.qty += r.qty; return t; }, { qty: 0 });

  await exportToExcel({
    filename: `IMF_Issue_Report_${dateStr()}.xlsx`,
    reportTitle: 'Issue to WIP — Full History',
    filterSummary: `${rows.length} TAG${rows.length !== 1 ? 's' : ''} issued, all time`,
    columns: [
      { header: 'TAG ID',         key: 'tagId',     width: 14 },
      { header: 'Batch Code',     key: 'batchCode', width: 18 },
      { header: 'Requisition No.',key: 'reqNo',      width: 16 },
      { header: 'Part No.',       key: 'partNo',     width: 14 },
      { header: 'Part Name',      key: 'partName',   width: 24 },
      { header: 'Customer',       key: 'custName',   width: 20 },
      { header: 'Qty Issued',     key: 'qty',        width: 12, align: 'right', numFmt: '#,##0' },
      { header: 'Master Lot Code',key: 'masterLot',  width: 20 },
      { header: 'Issue Date',     key: 'issueDate',  width: 14 },
      { header: 'Issued By',      key: 'issuedBy',   width: 18 },
    ],
    rows,
    totals,
  });
}

function renderIssue() {
  const approved = S.requisitions.filter(r => r.status === 'approved' || r.status === 'partial');
  const issuedCount = S.routeCards.length;

  document.getElementById('section-content').innerHTML = `
    <div class="flex justify-between items-center mb-12" style="flex-wrap:wrap;gap:8px">
      <div style="font-size:16px;font-weight:700">Issue to WIP</div>
      ${issuedCount ? `<button class="btn btn-ghost btn-sm" onclick="exportIssueExcel()"><i class="ti ti-file-spreadsheet" aria-hidden="true"></i> Export Issue History</button>` : ''}
    </div>
    ${!approved.length
      ? emptyState('ti-clipboard-check', 'No approved requisitions', 'Requisitions must be approved before material can be issued.')
      : `
        <div class="iss-layout">
          <div class="iss-left">
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
                  ${imfBadge(r.status, REQ_META)}
                </div>
                <div class="mt-8">
                  ${remLines.map(l => `<div class="text-sm" style="padding:2px 0"><strong>${l.partName}</strong> · <span style="color:var(--imf-navy);font-weight:700">${l.qtyApproved - issLineIssued(r.id, l.lineNo)} pcs remaining</span></div>`).join('')}
                </div>
              </div>`;
            }).join('')}
            <div id="iss-line-select"></div>
            <div id="iss-lot-picker"></div>
          </div>
          <div class="iss-right" id="iss-tag-section"></div>
        </div>
      `}
  `;

  if (_issReq) issRenderLineSelect();
  issRenderTagSection();
  if (_issLine) issRenderLotPicker();
}

function issSelectRequisition(id) {
  _issReq = S.requisitions.find(r => r.id === id) || null;
  _issLine = null; _issTags = []; _issBatchCode = ''; _issLot = null; _issPendingTag = null;
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
  _issPendingTag = null;

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
  _issPendingTag = null;
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
  if (!w) return;

  if (!_issLine) {
    w.innerHTML = `
      <div class="iss-session-placeholder">
        <i class="ti ti-tags" aria-hidden="true"></i>
        <div>Select a requisition and part line on the left to begin issuing TAGs.</div>
      </div>`;
    return;
  }

  /* Require a lot to be chosen before allowing TAG scan */
  if (!_issLot) {
    const lots = issGetAvailableLots();
    if (lots.length === 0) {
      w.innerHTML = `<div class="ebox mt-8"><i class="ti ti-package-off"></i><span>No accepted stock found for this part. Check IQC or inward records.</span></div>`;
    } else {
      w.innerHTML = `
        <div class="iss-session-placeholder">
          <i class="ti ti-stack-2" aria-hidden="true"></i>
          <div>Select a material lot on the left to begin scanning TAGs.</div>
        </div>`;
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
        <div style="display:flex;justify-content:space-between;font-size:12px;font-weight:700;
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

      <!-- Add TAG -->
      <div style="padding:14px 16px">
        ${canAddMore ? `
          ${_issPendingTag ? `
            <div class="iss-pending-tag">
              <div class="iss-pending-tag-id"><i class="ti ti-tag" aria-hidden="true"></i> ${_issPendingTag}</div>
              <div class="f" style="margin:0;flex:1">
                <label>Qty for this TAG</label>
                <input id="iss-pending-qty" type="number" min="1" max="${maxQtyForInput}" placeholder="pcs" autofocus
                  onkeydown="if(event.key==='Enter'){event.preventDefault();issConfirmPendingTag()}">
              </div>
              <button class="btn btn-p btn-sm" onclick="issConfirmPendingTag()"><i class="ti ti-check" aria-hidden="true"></i> Add</button>
              <button class="imf-rowact" onclick="issCancelPendingTag()" aria-label="Cancel"><i class="ti ti-x" aria-hidden="true"></i></button>
            </div>
          ` : `
            <button class="qr-scan-btn mb-12" onclick="issScanTag()" style="width:100%">
              <i class="ti ti-qrcode"></i> Scan TAG
            </button>
          `}
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
                <button class="btn btn-d btn-sm btn-tap" onclick="issRemoveTag(${i})" aria-label="Remove">
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

/** Single entry point for capturing a TAG — camera scan or the scanner modal's own
 * manual fallback. No separate persistent manual-entry field exists outside this. */
function issScanTag() {
  openQrScanner((tagId) => {
    if (!/^TAG\d+$/.test(tagId)) { toast('Invalid TAG format. Expected TAG001, TAG042, etc.'); return; }
    if (_issTags.find(t => t.tagId === tagId)) { toast(tagId + ' already added in this session'); return; }
    _issPendingTag = tagId;
    issRenderTagSection();
    setTimeout(() => document.getElementById('iss-pending-qty')?.focus(), 50);
  }, 'Scan Route Card TAG');
}

function issCancelPendingTag() {
  _issPendingTag = null;
  issRenderTagSection();
}

async function issConfirmPendingTag() {
  const tagId = _issPendingTag;
  if (!tagId) return;
  const qty = parseInt(getField('iss-pending-qty')) || 0;
  const issued = issLineIssued(_issReq.id, _issLine.lineNo);
  const remaining = _issLine.qtyApproved - issued;
  const sessionTotal = _issTags.reduce((s, t) => s + (+t.qty || 0), 0);

  if (!qty || qty < 1) { toast('Enter a quantity for this TAG'); return; }
  if (sessionTotal + qty > remaining) { toast(`Only ${remaining - sessionTotal} pcs remaining on this requisition line`); return; }
  if (sessionTotal + qty > ISS_BATCH_MAX) { toast(`Batch limit: max ${ISS_BATCH_MAX} pcs per session. Only ${ISS_BATCH_MAX - sessionTotal} pcs left in this batch.`); return; }

  try {
    const existing = await db.collection('routeCards').doc(tagId).get();
    if (existing.exists) { toast(tagId + ' is already in use (status: ' + existing.data().status + ')'); return; }
  } catch (e) {
    toast('Error checking TAG: ' + friendlyError(e));
    return;
  }

  _issTags.push({ tagId, qty, issueDate: dateStr() });
  _issPendingTag = null;
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
    // Snapshot, not a live reference — once a TAG is issued it's a fixed
    // historical record of which physical batch it came from, same as
    // masterLotCode/inwardId below. getLinkedLotNos() walks the live
    // dispatch chain at THIS moment; it's the chain itself (on inward)
    // that must never be cached, not this terminal copy.
    const rmLotCodes = getLinkedLotNos(inwardRec);

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
        rmLotCodes,
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

    _issReq = null; _issLine = null; _issTags = []; _issBatchCode = ''; _issLot = null; _issPendingTag = null;
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
function stockPeriodLabel() { return STOCK_PERIODS.find(p => p.key === _stockPeriod)?.label || 'All Time'; }

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
  if (period === 'custom') {
    if (_stockDateFrom && dateStr_ < _stockDateFrom) return false;
    if (_stockDateTo && dateStr_ > _stockDateTo) return false;
    return true;
  }
  return true;
}

function stockSetDateFrom(v) { _stockDateFrom = v; _stockPeriod = 'custom'; renderStock(); }
function stockSetDateTo(v)   { _stockDateTo = v; _stockPeriod = 'custom'; renderStock(); }
function stockClearDates()   { _stockDateFrom = ''; _stockDateTo = ''; _stockPeriod = 'all'; renderStock(); }

function tsToDateStr(ts) {
  if (!ts) return '';
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return _localDateStr(d);
}

/** YYYY-MM-DD string for N days before today — used to default date-range filters. */
function daysAgoStr(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return _localDateStr(d);
}

/** Aggregate + filter the Stock Balance part list — shared by renderStock and exportStockExcel. */
function computeStockData() {
  /* Supplier filter applies to every figure below (received, available, issued —
     issued is traced back to its source lot's supplier via masterLotCode). */
  const lotSupplier = {};
  S.inward.forEach(r => { if (r.masterLotCode) lotSupplier[r.masterLotCode] = r.supplierId || ''; });
  const supplierMatch = (supplierId) => _stockSupFilt === 'all' || supplierId === _stockSupFilt;

  /* ── 1. Aggregate per part ─────────────────────────────────────── */
  const byPart = {};

  S.inward.forEach(r => {
    if (!supplierMatch(r.supplierId)) return;
    (r.parts || []).forEach(p => {
      // Aggregate at the raw-material level (inward is already recorded under
      // the raw part's number, so this is a no-op for normal parts).
      const key = rawMaterialOf(p.partId) || p.partName;
      if (!key) return;
      if (!byPart[key]) {
        const masterPart = (S.parts || []).find(mp => mp.id === key);
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
    if (!supplierMatch(lotSupplier[rc.masterLotCode])) return;
    const key = rawMaterialOf(rc.partId) || rc.partName;
    if (!key) return;
    issuedByPart[key] = (issuedByPart[key] || 0) + (+rc.issuedQty || 0);
  });

  /* ── 2b. Period-filtered received + issued per part (table cols) ─ */
  const rcvdByPartPeriod = {};
  S.inward.forEach(r => {
    if (!supplierMatch(r.supplierId)) return;
    if (!inPeriod(r.date, _stockPeriod)) return;
    (r.parts || []).forEach(p => {
      const key = p.partId || p.partName;
      if (!key) return;
      rcvdByPartPeriod[key] = (rcvdByPartPeriod[key] || 0) + (+p.qty || 0);
    });
  });

  const issdByPartPeriod = {};
  S.routeCards.forEach(rc => {
    if (!supplierMatch(lotSupplier[rc.masterLotCode])) return;
    if (!inPeriod(tsToDateStr(rc.issuedAt), _stockPeriod)) return;
    const key = rawMaterialOf(rc.partId) || rc.partName;
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
    if (!supplierMatch(r.supplierId)) return s;
    if (!inPeriod(r.date, _stockPeriod)) return s;
    return s + (r.parts || []).reduce((a, p) => a + (+p.qty || 0), 0);
  }, 0);

  const issdFiltered = S.routeCards.reduce((s, rc) => {
    if (!supplierMatch(lotSupplier[rc.masterLotCode])) return s;
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

  /* ── 7. Customer + supplier filter dropdowns ───────────────────── */
  const custMap = {};
  Object.values(byPart).forEach(p => { if (p.custId) custMap[p.custId] = p.custName; });
  const custOpts = Object.entries(custMap).map(([id, name]) =>
    `<option value="${id}" ${_stockCustFilt===id?'selected':''}>${name}</option>`).join('');

  const supOpts = (S.suppliers || []).filter(s => s.active !== false).map(s =>
    `<option value="${s.id}" ${_stockSupFilt===s.id?'selected':''}>${s.name}</option>`).join('');

  return { partList, custOpts, supOpts, totalAvailable, totalValue, overIssuedCount,
           iqcPending, iqcRejected, pendingPcs, rejectedPcs, rcvdFiltered, issdFiltered };
}

/** Export the currently filtered Stock Balance (Received − Issued = Available) as a branded Excel report.
 * Available is always lifetime (current true stock); Received/Issued columns are scoped to the active
 * date range (or preset period) and supplier filter, matching what's shown on screen. */
async function exportStockExcel() {
  const { partList } = computeStockData();
  if (!partList.length) { toast('Nothing to export — no stock matches the current filters.'); return; }

  const rangeLabel = _stockPeriod === 'custom'
    ? `${_stockDateFrom ? fmtDate(_stockDateFrom) : 'Start'} – ${_stockDateTo ? fmtDate(_stockDateTo) : 'Today'}`
    : (STOCK_PERIODS.find(p => p.key === _stockPeriod)?.label || 'All Time');

  const rows = partList.map(p => ({
    partNo:    p.partNo || '',
    partName:  p.partName || '—',
    custName:  p.custName || '—',
    received:  p.rcvdPeriod,
    issued:    p.issdPeriod,
    available: p.available,
    value:     p.value,
  }));

  const totals = rows.reduce((t, r) => {
    t.received += r.received; t.issued += r.issued; t.available += r.available; t.value += r.value;
    return t;
  }, { received: 0, issued: 0, available: 0, value: 0 });

  const custLabel = _stockCustFilt === 'all' ? 'All Customers' : (S.customers.find(c => c.id === _stockCustFilt)?.name || 'All Customers');
  const supLabel  = _stockSupFilt  === 'all' ? 'All Suppliers' : (S.suppliers.find(s => s.id === _stockSupFilt)?.name || 'All Suppliers');

  await exportToExcel({
    filename: `IMF_Stock_Report_${_stockDateFrom || 'all'}_to_${_stockDateTo || dateStr()}.xlsx`,
    reportTitle: 'Stock Balance Report (Received − Issued = Available)',
    filterSummary: `Customer: ${custLabel} · Supplier: ${supLabel} · Period: ${rangeLabel} · ${rows.length} component${rows.length !== 1 ? 's' : ''}`,
    columns: [
      { header: 'Part No.',      key: 'partNo',    width: 14 },
      { header: 'Part Name',     key: 'partName',  width: 26 },
      { header: 'Customer',     key: 'custName',  width: 20 },
      { header: `Received (${rangeLabel})`, key: 'received',  width: 18, align: 'right', numFmt: '#,##0' },
      { header: `Issued (${rangeLabel})`,   key: 'issued',    width: 18, align: 'right', numFmt: '#,##0' },
      { header: 'Available (lifetime)', key: 'available', width: 16, align: 'right', numFmt: '#,##0' },
      { header: 'Stock Value (₹)', key: 'value',   width: 16, align: 'right', numFmt: '₹#,##0.00' },
    ],
    rows,
    totals,
  });
}

function renderStock() {
  const { partList, custOpts, supOpts, totalAvailable, totalValue, overIssuedCount,
          iqcPending, iqcRejected, pendingPcs, rejectedPcs, rcvdFiltered, issdFiltered } = computeStockData();
  const q = _stockSearch.trim().toLowerCase();

  /* ── Stat cards + unified period filter ────────────────────── */
  /* Shared stat-card component (matches TAG Registry — see styles.css .stat-card) */
  const statCard = (opts) => `
    <div class="stat-card ${opts.cls}">
      ${opts.icon ? `<i class="ti ${opts.icon} stat-icon" aria-hidden="true"></i>` : ''}
      <div class="stat-lbl">${opts.label}</div>
      <div class="stat-val">${opts.value}</div>
      <div class="stat-sub">${opts.sub}</div>
      ${opts.extra ? `<div class="stat-extra">${opts.extra}</div>` : ''}
    </div>`;

  const periodLabel = _stockPeriod === 'custom'
    ? `${_stockDateFrom ? fmtDate(_stockDateFrom) : 'Start'} – ${_stockDateTo ? fmtDate(_stockDateTo) : 'Today'}`
    : (STOCK_PERIODS.find(p => p.key === _stockPeriod)?.label || 'All Time');
  const periodSelector = `
    <div class="flex items-center gap-12" style="flex-wrap:wrap;margin-bottom:12px">
      <div class="seg-bar" style="margin-bottom:0;flex:1;min-width:240px">
        ${STOCK_PERIODS.map(p => `
          <button class="seg-btn${_stockPeriod === p.key ? ' active' : ''}" onclick="setStockPeriod('${p.key}')">${p.label}</button>`).join('')}
      </div>
      <div class="imf-daterange">
        <i class="ti ti-calendar imf-daterange-ic" aria-hidden="true"></i>
        <input type="date" aria-label="From date" value="${_stockDateFrom}" max="${_stockDateTo || dateStr()}" onchange="stockSetDateFrom(this.value)">
        <span class="imf-daterange-sep">–</span>
        <input type="date" aria-label="To date" value="${_stockDateTo}" min="${_stockDateFrom}" max="${dateStr()}" onchange="stockSetDateTo(this.value)">
        ${(_stockDateFrom || _stockDateTo) ? `<button class="imf-rowact" onclick="stockClearDates()" aria-label="Clear date range" title="Clear date range"><i class="ti ti-x" aria-hidden="true"></i></button>` : ''}
      </div>
    </div>`;

  const statsHtml = `
    ${periodSelector}
    <div class="stats-3">
      ${statCard({
        label: 'AVAILABLE',
        value: totalAvailable.toLocaleString('en-IN'),
        sub:   'pcs · always current',
        icon:  'ti-package',
        cls:   'ok',
        extra: totalValue > 0 ? `${fmtINR(totalValue)} total stock value` : '',
      })}
      ${statCard({
        label: 'RECEIVED',
        value: rcvdFiltered.toLocaleString('en-IN'),
        sub:   `pcs · ${periodLabel.toLowerCase()}`,
        icon:  'ti-package-import',
        cls:   'info',
      })}
      ${statCard({
        label: 'ISSUED TO WIP',
        value: issdFiltered.toLocaleString('en-IN'),
        sub:   `pcs · ${periodLabel.toLowerCase()}`,
        icon:  'ti-arrow-bar-right',
        cls:   'violet',
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

    <div class="imf-tablewrap">
      <div class="imf-table-toolbar">
        <div class="grow">
          <div style="font-size:16px;font-weight:700">Stock by Part</div>
          <div class="text-sm text-muted">${partList.length} component${partList.length!==1?'s':''} · tap a row for the received/issued breakdown</div>
        </div>
        <div class="imf-search">
          <i class="ti ti-search" aria-hidden="true"></i>
          <input type="text" placeholder="Search part name, no. or customer..." value="${_stockSearch}" oninput="_stockSearch=this.value;renderStock()">
        </div>
        <select class="imf-ghost-select" onchange="_stockCustFilt=this.value;renderStock()">
          <option value="all" ${_stockCustFilt==='all'?'selected':''}>All Customers</option>
          ${custOpts}
        </select>
        <select class="imf-ghost-select" onchange="_stockSupFilt=this.value;renderStock()">
          <option value="all" ${_stockSupFilt==='all'?'selected':''}>All Suppliers</option>
          ${supOpts}
        </select>
        <button class="btn btn-ghost btn-sm" onclick="exportStockExcel()"><i class="ti ti-file-spreadsheet" aria-hidden="true"></i> Export</button>
      </div>
      ${partList.length === 0
        ? emptyState('ti-chart-pie', 'No stock found', q || _stockCustFilt!=='all' ? 'Try clearing the filter.' : 'Add inward receipts to start tracking stock.')
        : `
      <div class="imf-table-scroll">
        <table class="imf-table">
          <thead><tr>
            <th class="pin">Part</th>
            <th>Customer</th>
            <th>Status</th>
            <th class="num">Available</th>
            <th class="num">Received · ${periodLabel}</th>
            <th class="num">Issued · ${periodLabel}</th>
            <th></th>
          </tr></thead>
          <tbody>${partList.map(stockTableRows).join('')}</tbody>
        </table>
      </div>`}
    </div>
    ${partList.length > 0 ? `<div class="imf-cards">${partList.map(stockCard).join('')}</div>` : ''}
  `;
}

/** Builds the main <tr> + (if expanded) a sibling detail <tr> with the lot breakdown. */
function stockTableRows(p) {
  const isOver = p.overIssued;
  const pct    = p.received > 0 ? Math.round((p.available / p.received) * 100) : 0;
  const isOut  = p.available === 0 && !isOver;
  const isLow  = !isOut && !isOver && pct < 20;
  const availColor = isOver || isOut ? 'var(--err)' : isLow ? 'var(--warn)' : 'var(--ok)';
  const expanded = !!_stockExpanded[p.key];

  const statusBdg = isOver ? `<span class="imf-badge rag-r"><i class="ti ti-alert-triangle" aria-hidden="true"></i>Over-issued by ${p.issued - p.received}</span>`
                   : isOut ? `<span class="imf-badge rag-r">Out of stock</span>`
                   : isLow ? `<span class="imf-badge rag-a">Low stock</span>` : '';

  const mainRow = `
    <tr ${isOver ? 'style="background:var(--err-bg)"' : ''}>
      <td class="pin"><div style="font-weight:600">${p.partName}</div><div class="cell-sub">${p.partNo || ''}</div></td>
      <td>${p.custName || '—'}</td>
      <td>${statusBdg}</td>
      <td class="num" style="color:${availColor}">${p.available.toLocaleString('en-IN')}</td>
      <td class="num">${p.rcvdPeriod.toLocaleString('en-IN')}</td>
      <td class="num">${p.issdPeriod.toLocaleString('en-IN')}</td>
      <td><button class="imf-rowact" onclick="_stockExpanded['${p.key}']=!_stockExpanded['${p.key}'];renderStock()" aria-expanded="${expanded}" aria-label="Toggle lot breakdown"><i class="ti ti-chevron-${expanded ? 'up' : 'down'}" aria-hidden="true"></i></button></td>
    </tr>`;

  if (!expanded) return mainRow;

  return mainRow + `
    <tr><td colspan="7" style="background:var(--sur2);padding:0 16px 16px">
      <div class="stk-detail-stats">
        <div><span class="stk-detail-lbl">Received · ${stockPeriodLabel()}</span><span class="stk-detail-val">${p.rcvdPeriod}</span></div>
        <div><span class="stk-detail-lbl">Issued · ${stockPeriodLabel()}</span><span class="stk-detail-val">${p.issdPeriod}</span></div>
        <div><span class="stk-detail-lbl">Total Received (all time)</span><span class="stk-detail-val">${p.received}</span></div>
      </div>
      <div class="prog" style="margin-bottom:10px">
        <div class="pf ${isOver||isOut?'pr':isLow?'pa':'pg'}" style="transform:scaleX(${(Math.min(100,isOver?100:pct)/100).toFixed(4)})"></div>
      </div>
      ${stockLotRows(p)}
    </td></tr>`;
}

function stockLotRows(p) {
  return p.lots.map(l => {
    const lotIssued = S.routeCards.filter(rc =>
      (rawMaterialOf(rc.partId) || rc.partName) === p.key && rc.masterLotCode === l.lotCode
    ).reduce((s, rc) => s + (+rc.issuedQty || 0), 0);
    const lotAvail = Math.max(0, l.qty - lotIssued);
    const lotPct   = l.qty > 0 ? Math.round((lotAvail / l.qty) * 100) : 0;
    return `
      <div class="lot-row">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px">
          <div>
            <div class="lot-badge" style="font-size:11px;margin-bottom:4px">
              <i class="ti ti-tag" aria-hidden="true"></i> ${l.lotCode}
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
}

function stockCard(p) {
  const isOver = p.overIssued;
  const pct    = p.received > 0 ? Math.round((p.available / p.received) * 100) : 0;
  const isOut  = p.available === 0 && !isOver;
  const isLow  = !isOut && !isOver && pct < 20;
  const availColor = isOver || isOut ? 'var(--err)' : isLow ? 'var(--warn)' : 'var(--ok)';
  const expanded = !!_stockExpanded[p.key];
  const statusBdg = isOver ? `<span class="imf-badge rag-r"><i class="ti ti-alert-triangle" aria-hidden="true"></i>Over-issued</span>`
                   : isOut ? `<span class="imf-badge rag-r">Out of stock</span>`
                   : isLow ? `<span class="imf-badge rag-a">Low stock</span>` : '';
  return `
    <div class="imf-card">
      <div class="imf-card-top" onclick="_stockExpanded['${p.key}']=!_stockExpanded['${p.key}'];renderStock()" style="cursor:pointer">
        <span class="imf-mono">${p.partNo || p.partName}</span>
        <div class="grow"></div>
        ${statusBdg}
        <i class="ti ti-chevron-${expanded ? 'up' : 'down'}" aria-hidden="true" style="color:var(--txt-dim)"></i>
      </div>
      <div class="imf-card-lead">
        <span class="nm">${p.partName}</span>
        <span class="qty" style="color:${availColor}">${p.available.toLocaleString('en-IN')}<small> avail</small></span>
      </div>
      <div class="imf-card-meta">${p.custName || '—'}</div>
      ${expanded ? `
        <div class="stk-detail-stats">
          <div><span class="stk-detail-lbl">Received · ${stockPeriodLabel()}</span><span class="stk-detail-val">${p.rcvdPeriod}</span></div>
          <div><span class="stk-detail-lbl">Issued · ${stockPeriodLabel()}</span><span class="stk-detail-val">${p.issdPeriod}</span></div>
          <div><span class="stk-detail-lbl">Total Received</span><span class="stk-detail-val">${p.received}</span></div>
        </div>
        ${stockLotRows(p)}
      ` : ''}
    </div>`;
}

/* ══════════════════════════════════════════════════════════════════════
   SECTION 6 — ROUTE CARDS / BATCH TRACKER
   ══════════════════════════════════════════════════════════════════════ */
const RC_FILTER_OPTS = [
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

/** Click-to-sort on an imf-table header. Toggles direction if the same key is clicked twice. */
function rcSort(key) {
  if (_rcSort.key === key) { _rcSort.dir = _rcSort.dir === 'asc' ? 'desc' : 'asc'; }
  else { _rcSort = { key, dir: (key === 'tagId' || key === 'partName') ? 'asc' : 'desc' }; }
  _rcPage = 1;
  renderSection();
}
function rcSortIcon(key) {
  if (_rcSort.key !== key) return 'ti-arrows-sort';
  return _rcSort.dir === 'asc' ? 'ti-arrow-up' : 'ti-arrow-down';
}
function rcPrevPage() { _rcPage = Math.max(1, _rcPage - 1); renderSection(); }
function rcNextPage(pages) { _rcPage = Math.min(pages, _rcPage + 1); renderSection(); }

/** Filtered + sorted Route Cards (status, search, issue-date range) — shared by render and export. */
function getFilteredRouteCards() {
  const q = searchQ.trim().toLowerCase();
  let list = S.routeCards.filter(rc => {
    if (_rcFilt !== 'all' && rc.status !== _rcFilt) return false;
    if (_rcDateFrom && (rc.issueDate || '') < _rcDateFrom) return false;
    if (_rcDateTo && (rc.issueDate || '') > _rcDateTo) return false;
    if (!q) return true;
    return (rc.tagId || '').toLowerCase().includes(q)
      || (rc.partName || '').toLowerCase().includes(q)
      || (rc.partNo || '').toLowerCase().includes(q)
      || (rc.batchCode || '').toLowerCase().includes(q);
  });

  return list.slice().sort((a, b) => {
    const { key, dir } = _rcSort;
    let av, bv;
    if (key === 'tagId') { av = a.tagId || ''; bv = b.tagId || ''; }
    else if (key === 'partName') { av = a.partName || ''; bv = b.partName || ''; }
    else if (key === 'statusRank') { av = RC_META[a.status]?.rank ?? 99; bv = RC_META[b.status]?.rank ?? 99; }
    else if (key === 'qty') { av = +a.currentQty || 0; bv = +b.currentQty || 0; }
    else { av = a.issuedAt?.toMillis?.() || 0; bv = b.issuedAt?.toMillis?.() || 0; }
    const c = typeof av === 'number' ? av - bv : String(av).localeCompare(String(bv));
    return dir === 'asc' ? c : -c;
  });
}

function rcSetDateFrom(v) { _rcDateFrom = v; _rcPage = 1; renderSection(); }
function rcSetDateTo(v)   { _rcDateTo = v; _rcPage = 1; renderSection(); }
function rcClearDates()   { _rcDateFrom = ''; _rcDateTo = ''; _rcPage = 1; renderSection(); }

function renderRouteCards() {
  const list = getFilteredRouteCards();
  const total = list.length;
  const pages = Math.max(1, Math.ceil(total / RC_PAGE_SIZE));
  const page = Math.min(_rcPage, pages);
  const start = (page - 1) * RC_PAGE_SIZE;
  const pageRows = list.slice(start, start + RC_PAGE_SIZE);

  document.getElementById('section-content').innerHTML = `
    <div class="imf-tablewrap">
      <div class="imf-table-toolbar">
        <div class="grow">
          <div style="font-size:16px;font-weight:700">Route Cards</div>
          <div class="text-sm text-muted">${S.routeCards.length} total TAG${S.routeCards.length !== 1 ? 's' : ''} · <span style="color:var(--accent-violet);font-weight:600">commercial split</span> locks at QC</div>
        </div>
        <div class="imf-search">
          <i class="ti ti-search" aria-hidden="true"></i>
          <input type="search" id="store-search" placeholder="Search TAG, part or batch..." value="${(searchQ || '').replace(/"/g, '&quot;')}" oninput="onSearchInput(this.value)">
        </div>
        <select class="imf-ghost-select" onchange="_rcFilt=this.value;_rcPage=1;renderSection()">
          ${RC_FILTER_OPTS.map(o => `<option value="${o.v}" ${o.v === _rcFilt ? 'selected' : ''}>${o.l}</option>`).join('')}
        </select>
        <div class="imf-daterange">
          <i class="ti ti-calendar imf-daterange-ic" aria-hidden="true"></i>
          <input type="date" aria-label="From date" value="${_rcDateFrom}" max="${_rcDateTo || dateStr()}" onchange="rcSetDateFrom(this.value)">
          <span class="imf-daterange-sep">–</span>
          <input type="date" aria-label="To date" value="${_rcDateTo}" min="${_rcDateFrom}" max="${dateStr()}" onchange="rcSetDateTo(this.value)">
          ${(_rcDateFrom || _rcDateTo) ? `<button class="imf-rowact" onclick="rcClearDates()" aria-label="Clear date range" title="Clear date range"><i class="ti ti-x" aria-hidden="true"></i></button>` : ''}
        </div>
        <button class="btn btn-ghost btn-sm" onclick="exportRouteCardsExcel()"><i class="ti ti-file-spreadsheet" aria-hidden="true"></i> Export</button>
      </div>
      ${total === 0 ? emptyState('ti-tags', 'No route cards found', 'Issue material to WIP to create route cards.') : `
      <div class="imf-table-scroll">
        <table class="imf-table">
          <thead><tr>
            <th class="pin sortable" onclick="rcSort('tagId')">TAG ID <i class="ti ${rcSortIcon('tagId')}" aria-hidden="true"></i></th>
            <th class="sortable" onclick="rcSort('partName')">Part <i class="ti ${rcSortIcon('partName')}" aria-hidden="true"></i></th>
            <th>Customer</th>
            <th>Batch</th>
            <th class="sortable" onclick="rcSort('statusRank')">Stage <i class="ti ${rcSortIcon('statusRank')}" aria-hidden="true"></i></th>
            <th class="num sortable" onclick="rcSort('qty')">Qty <i class="ti ${rcSortIcon('qty')}" aria-hidden="true"></i></th>
            <th class="num grp grp-l">OEM</th>
            <th class="num grp">Spares</th>
            <th class="num grp grp-r">Market</th>
            <th class="num sortable" onclick="rcSort('ts')">Issued <i class="ti ${rcSortIcon('ts')}" aria-hidden="true"></i></th>
            <th></th>
          </tr></thead>
          <tbody>${pageRows.map(routeCardTableRow).join('')}</tbody>
        </table>
      </div>
      <div class="imf-table-foot">
        <div>Showing <strong class="mono">${start + 1}–${Math.min(start + RC_PAGE_SIZE, total)}</strong> of <strong class="mono">${total}</strong></div>
        <div class="grow"></div>
        <button class="imf-pager" onclick="rcPrevPage(${pages})" ${page <= 1 ? 'disabled' : ''}><i class="ti ti-chevron-left" aria-hidden="true"></i>Prev</button>
        <span>Page <strong class="mono">${page}</strong> / ${pages}</span>
        <button class="imf-pager" onclick="rcNextPage(${pages})" ${page >= pages ? 'disabled' : ''}>Next<i class="ti ti-chevron-right" aria-hidden="true"></i></button>
      </div>`}
    </div>
    ${total > 0 ? `<div class="imf-cards">${pageRows.map(routeCardCard).join('')}</div>` : ''}
  `;
}

/** Export the currently filtered Route Cards (WIP) list as a branded Excel report. */
async function exportRouteCardsExcel() {
  const list = getFilteredRouteCards();
  if (!list.length) { toast('Nothing to export — no route cards match the current filters.'); return; }

  const rows = list.map(rc => {
    const locked = (+rc.qty_oem || 0) + (+rc.qty_spares || 0) + (+rc.qty_market || 0) > 0;
    return {
      tagId:     rc.tagId || '',
      partNo:    rc.partNo || '',
      partName:  rc.partName || '—',
      custName:  rc.customerName || '—',
      batchCode: rc.batchCode || '—',
      heatCode:  rc.heatCode || '—',
      stage:     RC_META[rc.status]?.label || rc.status || '—',
      qty:       +rc.currentQty || 0,
      oem:       locked ? (+rc.qty_oem || 0) : 0,
      spares:    locked ? (+rc.qty_spares || 0) : 0,
      market:    locked ? (+rc.qty_market || 0) : 0,
      issueDate: fmtDate(rc.issueDate),
    };
  });

  const totals = rows.reduce((t, r) => {
    t.qty += r.qty; t.oem += r.oem; t.spares += r.spares; t.market += r.market;
    return t;
  }, { qty: 0, oem: 0, spares: 0, market: 0 });

  const rangeLabel = (_rcDateFrom || _rcDateTo)
    ? `Issued: ${_rcDateFrom ? fmtDate(_rcDateFrom) : 'Start'} – ${_rcDateTo ? fmtDate(_rcDateTo) : 'Today'}`
    : 'Issued: All Time';
  const statusLabel = RC_FILTER_OPTS.find(o => o.v === _rcFilt)?.l || 'All Status';

  await exportToExcel({
    filename: `IMF_WIP_Report_${_rcDateFrom || 'all'}_to_${_rcDateTo || dateStr()}.xlsx`,
    reportTitle: 'Work-In-Progress (Route Cards) Report',
    filterSummary: `${rangeLabel} · Status: ${statusLabel} · ${rows.length} TAG${rows.length !== 1 ? 's' : ''}`,
    columns: [
      { header: 'TAG ID',    key: 'tagId',     width: 14 },
      { header: 'Part No.',  key: 'partNo',    width: 14 },
      { header: 'Part Name', key: 'partName',  width: 24 },
      { header: 'Customer',  key: 'custName',  width: 20 },
      { header: 'Batch Code',key: 'batchCode', width: 18 },
      { header: 'Heat Code', key: 'heatCode',  width: 14 },
      { header: 'Stage',     key: 'stage',     width: 16 },
      { header: 'Qty',       key: 'qty',       width: 10, align: 'right', numFmt: '#,##0' },
      { header: 'OEM',       key: 'oem',       width: 10, align: 'right', numFmt: '#,##0' },
      { header: 'Spares',    key: 'spares',    width: 10, align: 'right', numFmt: '#,##0' },
      { header: 'Market',    key: 'market',    width: 10, align: 'right', numFmt: '#,##0' },
      { header: 'Issued Date', key: 'issueDate', width: 14 },
    ],
    rows,
    totals,
  });
}

function routeCardTableRow(rc) {
  const locked = (+rc.qty_oem || 0) + (+rc.qty_spares || 0) + (+rc.qty_market || 0) > 0;
  const canDelete = S.sess?.email === 'tanmay@indometaforge.in';
  return `
    <tr>
      <td class="pin mono">${rc.tagId}</td>
      <td><div>${rc.partName || '—'}</div><div class="cell-sub">${rc.partNo || ''}</div></td>
      <td>${rc.customerName || '—'}</td>
      <td><span class="mono" style="font-size:12px;color:var(--txt-muted)">${rc.batchCode || '—'}</span>${rc.heatCode ? `<div class="cell-sub" style="color:var(--ok)"><i class="ti ti-flame" aria-hidden="true"></i> ${rc.heatCode}</div>` : ''}${(rc.rmLotCodes || []).length ? `<div class="cell-sub" title="Forging RM lot(s)"><i class="ti ti-anvil" aria-hidden="true"></i> ${rc.rmLotCodes.join(', ')}</div>` : ''}</td>
      <td>${imfBadge(rc.status, RC_META)}</td>
      <td class="num">${(+rc.currentQty || 0).toLocaleString('en-IN')}</td>
      <td class="num grp grp-l ${locked ? '' : 'dim'}">${locked ? (+rc.qty_oem || 0).toLocaleString('en-IN') : '—'}</td>
      <td class="num grp ${locked ? '' : 'dim'}">${locked ? (+rc.qty_spares || 0).toLocaleString('en-IN') : '—'}</td>
      <td class="num grp grp-r ${locked ? '' : 'dim'}">${locked ? (+rc.qty_market || 0).toLocaleString('en-IN') : '—'}</td>
      <td class="num">${fmtDate(rc.issueDate)}</td>
      <td>${canDelete ? `<button class="imf-rowact" onclick="confirmDeleteRouteCard('${rc.tagId}')" aria-label="Delete route card"><i class="ti ti-dots" aria-hidden="true"></i></button>` : ''}</td>
    </tr>`;
}

function routeCardCard(rc) {
  const locked = (+rc.qty_oem || 0) + (+rc.qty_spares || 0) + (+rc.qty_market || 0) > 0;
  const canDelete = S.sess?.email === 'tanmay@indometaforge.in';
  return `
    <div class="imf-card">
      <div class="imf-card-top">
        <span class="imf-mono">${rc.tagId}</span>
        <div class="grow"></div>
        ${imfBadge(rc.status, RC_META)}
      </div>
      <div class="imf-card-lead">
        <span class="nm">${rc.partName || '—'}</span>
        <span class="qty">${(+rc.currentQty || 0).toLocaleString('en-IN')}<small> pcs</small></span>
      </div>
      <div class="imf-card-meta">
        <span class="mono">${rc.partNo || ''}</span><span>·</span><span>${rc.customerName || '—'}</span>
      </div>
      <div class="imf-split">
        <div><div class="k">OEM</div><div class="v">${locked ? (+rc.qty_oem || 0).toLocaleString('en-IN') : '—'}</div></div>
        <div><div class="k">Spares</div><div class="v">${locked ? (+rc.qty_spares || 0).toLocaleString('en-IN') : '—'}</div></div>
        <div><div class="k">Market</div><div class="v">${locked ? (+rc.qty_market || 0).toLocaleString('en-IN') : '—'}</div></div>
      </div>
      <div class="imf-card-foot">
        <span class="mono">${rc.batchCode || '—'}</span><span>·</span>
        <i class="ti ti-calendar-event" aria-hidden="true"></i><span>${fmtDate(rc.issueDate)}</span>
        ${rc.heatCode ? `<span>·</span><i class="ti ti-flame" aria-hidden="true"></i><span>${rc.heatCode}</span>` : ''}
      </div>
      ${(rc.rmLotCodes || []).length ? `<div class="imf-card-meta"><i class="ti ti-anvil" aria-hidden="true"></i><span class="mono">${rc.rmLotCodes.join(', ')}</span></div>` : ''}
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
      <div class="text-sm"><strong>Status:</strong> ${RC_META[rc.status]?.label || rc.status}</div>
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
window.onGlobalScan = function(tagId) {
  if (_activeTab === 'issue') {
    if (_issReq && _issLine) {
      if (!/^TAG\d+$/.test(tagId)) { toast('Invalid TAG format. Expected TAG001, TAG042, etc.'); return; }
      if (_issTags.find(t => t.tagId === tagId)) { toast(tagId + ' already added in this session'); return; }
      _issPendingTag = tagId;
      issRenderTagSection();
      setTimeout(() => document.getElementById('iss-pending-qty')?.focus(), 50);
    } else {
      toast('Select a material lot first on the left');
    }
  }
};

document.addEventListener('DOMContentLoaded', init);

