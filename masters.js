/* ═══════════════════════════════════════════════════════════════════
   IMF ProTrack — Master Data Administration (masters.js)
   Reads/writes the existing live master collections directly.
   No TEST_ prefix — these are master collections (see core.js
   TRANSACTIONAL_COLLECTIONS, which does not include them).
   ═══════════════════════════════════════════════════════════════════ */

'use strict';

/* ══════════════════════════════════════════════════════════════════════
   STATE
   ══════════════════════════════════════════════════════════════════════ */
let activeTab    = 'machines';
let searchQ      = '';
let filterStage  = 'all';   /* 'all' or a stage/department value */
let expandedPart = null;   /* partId whose routing panel is open */

const TABS = [
  { key: 'machines',   label: 'Machines',      icon: 'ti-settings' },
  { key: 'parts',      label: 'Parts & Routing', icon: 'ti-gear' },
  { key: 'operations', label: 'Operations',    icon: 'ti-adjustments' },
  { key: 'customers',  label: 'Customers',     icon: 'ti-building' },
  { key: 'suppliers',  label: 'Suppliers',     icon: 'ti-truck-delivery' },
  { key: 'personnel',  label: 'Personnel',     icon: 'ti-users' },
  { key: 'userAccess', label: 'User Access',   icon: 'ti-user-shield' },
  { key: 'shifts',     label: 'Shifts',        icon: 'ti-clock' },
];

/* Map a Firestore collection name to its S.* state array key */
const COLL_TO_STATE = {
  machines: 'machines', parts: 'parts', operations: 'operations',
  partOps: 'partOps', customers: 'customers', suppliers: 'suppliers',
  users: 'users'
};

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

  if (!canView('masters')) {
    window.location.replace('home.html');
    return;
  }

  const pill = document.getElementById('role-pill');
  if (pill) pill.textContent = rlbl(S.sess.role);

  render();

  document.getElementById('loading-screen').style.display = 'none';
  document.getElementById('app').style.display = '';
}

/* ══════════════════════════════════════════════════════════════════════
   LAYOUT — TABS + SECTION ROUTER
   ══════════════════════════════════════════════════════════════════════ */
function render() {
  const page = document.getElementById('page-content');
  page.innerHTML = `
    <div class="tabs" role="tablist" aria-label="Master data sections">
      ${TABS.map(t => `
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
  activeTab    = key;
  searchQ      = '';
  filterStage  = 'all';
  expandedPart = null;
  render();
}

function renderSection() {
  const map = {
    machines:    renderMachines,
    parts:       renderParts,
    operations:  renderOperations,
    customers:   renderCustomers,
    suppliers:   renderSuppliers,
    personnel:   renderPersonnel,
    userAccess:  renderUserAccess,
    shifts:      renderShifts,
  };
  (map[activeTab] || renderMachines)();
}

/* ══════════════════════════════════════════════════════════════════════
   SHARED UI HELPERS
   ══════════════════════════════════════════════════════════════════════ */

/** Header row: title (left) + "+ Add X" button (right) */
function sectionHeader(title, addLabel, addOnclick) {
  return `
    <div class="flex justify-between items-center mb-12">
      <div style="font-size:16px;font-weight:700">${title}</div>
      <button class="btn btn-p btn-sm" onclick="${addOnclick}">
        <i class="ti ti-plus" aria-hidden="true"></i> ${addLabel}
      </button>
    </div>`;
}

/** Full-width live search input, wired to onSearchInput() */
function searchBox(placeholder) {
  return `
    <div class="f">
      <label for="masters-search" style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap">Search</label>
      <input type="search" id="masters-search" placeholder="${placeholder}"
             value="${(searchQ || '').replace(/"/g, '&quot;')}"
             oninput="onSearchInput(this.value)">
    </div>`;
}

function onSearchInput(val) {
  searchQ = val;
  renderSection();
  /* Restore focus + cursor position after re-render */
  const el = document.getElementById('masters-search');
  if (el) { el.focus(); el.setSelectionRange(val.length, val.length); }
}

/** Search box + a "Filter by stage" dropdown, side by side */
function searchAndStageRow(placeholder, stages) {
  return `
    <div class="row-2">
      ${searchBox(placeholder)}
      <div class="f">
        <label for="masters-stage-filter" style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap">Filter by stage</label>
        <select id="masters-stage-filter" onchange="onStageFilterChange(this.value)">
          <option value="all" ${filterStage === 'all' ? 'selected' : ''}>All Stages</option>
          ${buildOpts(stages, 'v', x => x.l, filterStage)}
        </select>
      </div>
    </div>`;
}

function onStageFilterChange(val) {
  filterStage = val;
  renderSection();
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

/** Reload a single master collection into S */
async function refreshCollection(collection) {
  const snap = await db.collection(collection).get();
  S[COLL_TO_STATE[collection]] = snap.docs.map(d => ({ id: d.id, ...d.data() }));
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
   STAGE OPTION SETS
   - PROD_STAGES  → shop-floor production stages (Machines, Operations)
   - DEPT_STAGES  → personnel/user departments (Personnel, User Access)
   ══════════════════════════════════════════════════════════════════════ */
const STAGE_BADGE = {
  soft:    ['bdg-soft', 'Soft'],
  hard:    ['bdg-hard', 'Hard'],
  ht:      ['bdg-ht',   'HT'],
  general: ['bdg-gr',   'General'],
};

const PROD_STAGES = [
  { v: 'soft', l: 'Soft' }, { v: 'hard', l: 'Hard' },
  { v: 'ht', l: 'Heat Treatment' }, { v: 'general', l: 'General' },
];

const DEPT_STAGES = [
  { v: 'general', l: 'General' }, { v: 'soft', l: 'Soft Machining' },
  { v: 'ht', l: 'Heat Treatment' }, { v: 'hard', l: 'Hard Machining' },
  { v: 'store', l: 'Store' }, { v: 'qc', l: 'Quality Control' },
  { v: 'dispatch', l: 'Dispatch' }, { v: 'maintenance', l: 'Maintenance' },
];

const deptStageLabel = (v) => (DEPT_STAGES.find(s => s.v === v) || {}).l || slbl(v);

/* ══════════════════════════════════════════════════════════════════════
   SECTION 1 — MACHINES
   Collection: machines (doc ID = system UID, auto-generated, immutable)
   id_code is the human-facing "Asset Code" (e.g. IMF/SFT/01, IMF/HRD/02) —
   the same field i-v3.html already stores this data under — shown
   everywhere in the UI instead of the raw doc ID.
   sortOrder controls list position within a stage: lower number = higher
   up the list, so raising/lowering it moves the machine up/down.
   "Active" toggle lives ONLY inside the edit modal — never on the list.
   ══════════════════════════════════════════════════════════════════════ */
function renderMachines() {
  const q = searchQ.trim().toLowerCase();
  let list = S.machines.filter(m =>
    !q || (m.name || '').toLowerCase().includes(q) || (m.id_code || '').toLowerCase().includes(q));
  if (filterStage !== 'all') list = list.filter(m => (m.stage || 'general') === filterStage);
  list = list.slice().sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0) || (a.name || '').localeCompare(b.name || ''));

  document.getElementById('section-content').innerHTML = `
    ${sectionHeader('Machines', 'Add Machine', 'openMachineModal()')}
    ${searchAndStageRow('Search machines...', PROD_STAGES)}
    ${recordCount(list.length)}
    ${list.length
      ? list.map(machineRow).join('')
      : emptyState('ti-settings', 'No machines found', 'Add a machine to get started, or adjust your search.')}
  `;
}

function machineRow(m) {
  const [cls, label] = STAGE_BADGE[m.stage] || STAGE_BADGE.general;
  return `
    <div class="li" onclick="openMachineModal('${m.id}')">
      <div class="li-ic"><i class="ti ti-settings" aria-hidden="true"></i></div>
      <div class="li-body">
        <div class="li-name">${m.name || '—'}</div>
        <div class="li-sub">${m.id_code || '—'}</div>
      </div>
      <div class="li-right flex items-center gap-12">
        <span class="bdg ${cls}"><span class="bdg-dot"></span>${label}</span>
      </div>
    </div>`;
}

function openMachineModal(id) {
  const m = id ? S.machines.find(x => x.id === id) : null;

  openModal(`
    <div class="modal-title">${m ? 'Edit Machine' : 'Add Machine'}</div>
    <div id="modal-err"></div>

    <div class="f">
      <label for="mf-asset" class="f-req">Asset Code</label>
      <input type="text" id="mf-asset" value="${m?.id_code || ''}" style="text-transform:uppercase"
             oninput="this.value=this.value.toUpperCase()" placeholder="e.g. IMF/SFT/01">
    </div>
    <div class="f">
      <label for="mf-name" class="f-req">Machine Name</label>
      <input type="text" id="mf-name" value="${m?.name || ''}" placeholder="e.g. CNC Turning Center 1">
    </div>
    <div class="f">
      <label for="mf-stage" class="f-req">Stage</label>
      <select id="mf-stage">
        ${buildOpts([
          { v: 'soft', l: 'Soft' }, { v: 'hard', l: 'Hard' },
          { v: 'ht', l: 'Heat Treatment' }, { v: 'general', l: 'General' },
        ], 'v', x => x.l, m?.stage || 'soft')}
      </select>
    </div>
    <div class="f">
      <label for="mf-sort">Display Order</label>
      <input type="number" id="mf-sort" value="${m?.sortOrder ?? 0}">
      <div class="text-xs text-muted mt-8">Lower number = higher up the list. Raising or lowering this moves the machine up or down within its stage.</div>
    </div>
    <div class="utog">
      <span class="utog-label">Active</span>
      <label class="tsw">
        <input type="checkbox" id="mf-active" ${m?.isActive !== false ? 'checked' : ''}>
        <span class="tsl"></span>
      </label>
    </div>

    ${modalActions('Save Machine', `saveMachine(${m ? `'${m.id}'` : 'null'})`)}
    ${m ? modalDeleteButton(`deleteMachine('${m.id}')`, 'Delete Machine') : ''}
  `);
}

async function deleteMachine(id) {
  if (!confirm('Delete this machine? This cannot be undone.')) return;
  try {
    const before = S.machines.find(x => x.id === id);
    await db.collection('machines').doc(id).delete();
    await logAudit('DELETE_MACHINE', 'MASTERS', id, before, null);
    closeModal();
    await refreshCollection('machines');
    renderSection();
    toast('Machine deleted');
  } catch (e) {
    showModalError(e.message);
  }
}

async function saveMachine(id) {
  const id_code   = getField('mf-asset');
  const name      = getField('mf-name');
  const stage     = document.getElementById('mf-stage').value;
  const sortOrder = Number(getField('mf-sort')) || 0;
  const isActive  = document.getElementById('mf-active').checked;

  if (!id_code || !name || !stage) {
    showModalError('Asset Code, Name and Stage are required.');
    return;
  }

  const data = { id_code, name, stage, sortOrder, isActive };

  try {
    if (id) {
      const before = S.machines.find(x => x.id === id);
      await db.collection('machines').doc(id).update(data);
      await logAudit('UPDATE_MACHINE', 'MASTERS', id, before, data);
    } else {
      const ref = await db.collection('machines').add({
        ...data, createdAt: serverTS(), createdBy: S.sess.userId
      });
      await logAudit('CREATE_MACHINE', 'MASTERS', ref.id, null, data);
    }
    closeModal();
    await refreshCollection('machines');
    renderSection();
    toast('Saved successfully');
  } catch (e) {
    showModalError(e.message);
  }
}

/* ══════════════════════════════════════════════════════════════════════
   SECTION 2 — PARTS & ROUTING
   Collection: parts    (no, name, custId, matGrade)
   Collection: partOps  (partId, opId, seqNo, cycleTimeSecs,
                          isMandatory, finalOperation, workCenterType)

   Legacy note: older docs may store the customer reference as a plain
   "cust" string (code or name) rather than "custId". partCustomer()
   resolves either form for display; new saves always write custId.
   ══════════════════════════════════════════════════════════════════════ */
function partCustomer(p) {
  const ref = p.custId || p.cust;
  if (!ref) return null;
  return S.customers.find(c => c.id === ref || c.code === ref || c.name === ref) || null;
}

function renderParts() {
  const q = searchQ.trim().toLowerCase();
  let list = S.parts.filter(p => {
    if (!q) return true;
    const cust = partCustomer(p);
    return (p.no   || '').toLowerCase().includes(q)
        || (p.name || '').toLowerCase().includes(q)
        || (cust?.name || '').toLowerCase().includes(q);
  });
  list = list.slice().sort((a, b) => (a.name || '').localeCompare(b.name || ''));

  document.getElementById('section-content').innerHTML = `
    ${sectionHeader('Parts & Routing', 'Add Part', 'openPartModal()')}
    ${searchBox('Search parts...')}
    ${recordCount(list.length)}
    ${list.length
      ? list.map(partRow).join('')
      : emptyState('ti-gear', 'No parts found', 'Add a part to get started, or adjust your search.')}
  `;
}

function partRow(p) {
  const cust = partCustomer(p);
  const isExpanded = expandedPart === p.id;
  return `
    <div class="li" style="cursor:default">
      <div class="li-ic"><i class="ti ti-gear" aria-hidden="true"></i></div>
      <div class="li-body">
        <div class="li-name">${p.name || '—'}</div>
        <div class="li-sub">${p.no || '—'} · ${cust?.name || '—'}</div>
      </div>
      <div class="li-right flex items-center gap-12">
        <button class="btn btn-s btn-sm ${isExpanded ? 'tab active' : ''}" onclick="toggleRouting('${p.id}')" title="Operations Routing">
          <i class="ti ti-list-details" aria-hidden="true"></i> Routing
        </button>
        <button class="btn btn-s btn-sm" onclick="openPartModal('${p.id}')" title="Edit Part">
          <i class="ti ti-edit" aria-hidden="true"></i>
        </button>
      </div>
    </div>
    ${isExpanded ? routingPanel(p) : ''}
  `;
}

function toggleRouting(partId) {
  expandedPart = expandedPart === partId ? null : partId;
  renderParts();
}

function routingPanel(p) {
  const rows = S.partOps
    .filter(po => po.partId === p.id)
    .slice()
    .sort((a, b) => (a.seqNo || 0) - (b.seqNo || 0));

  return `
    <div class="card" style="margin-top:-4px">
      <div class="card-hd">Operations Routing — ${p.name || p.id}</div>
      ${rows.length
        ? rows.map(routingRow).join('')
        : '<div class="text-muted text-sm mb-12">No routing defined for this part yet.</div>'}
      <button class="btn btn-add w-full mt-12" onclick="openRoutingModal('${p.id}')">
        <i class="ti ti-plus" aria-hidden="true"></i> Add Operation to Routing
      </button>
    </div>`;
}

function routingRow(po) {
  const op   = S.operations.find(o => o.id === po.opId);
  const mins = ((po.cycleTimeSecs || 0) / 60).toFixed(2);
  return `
    <div class="rrow">
      <div class="flex-1">
        <div style="font-weight:600;font-size:13px">
          <span class="bdg bdg-n">#${po.seqNo ?? '—'}</span> ${op?.name || po.opId}
        </div>
        <div class="li-sub mt-8">
          ${po.cycleTimeSecs ?? 0} sec/pc · ${mins} min/pc
          ${po.isMandatory !== false ? ' · <span class="bdg bdg-b">Mandatory</span>' : ''}
          ${po.finalOperation ? ' <span class="bdg bdg-g">Final Op</span>' : ''}
        </div>
      </div>
      <div class="flex gap-8">
        <button class="btn btn-s btn-sm" onclick="openRoutingModal('${po.partId}','${po.id}')" title="Edit">
          <i class="ti ti-edit" aria-hidden="true"></i>
        </button>
        <button class="btn btn-d btn-sm" onclick="deleteRouting('${po.id}','${po.partId}')" title="Remove">
          <i class="ti ti-trash" aria-hidden="true"></i>
        </button>
      </div>
    </div>`;
}

function openPartModal(id) {
  const p    = id ? S.parts.find(x => x.id === id) : null;
  const cust = p ? partCustomer(p) : null;
  const custOpts = S.customers.slice().sort((a, b) => (a.name || '').localeCompare(b.name || ''));

  openModal(`
    <div class="modal-title">${p ? 'Edit Part' : 'Add Part'}</div>
    <div id="modal-err"></div>

    <div class="f">
      <label for="pf-no" class="f-req">Part Number</label>
      <input type="text" id="pf-no" value="${p?.no || ''}" placeholder="e.g. GR-1234">
    </div>
    <div class="f">
      <label for="pf-name" class="f-req">Part Name</label>
      <input type="text" id="pf-name" value="${p?.name || ''}" placeholder="e.g. Input Shaft Gear">
    </div>
    <div class="f">
      <label for="pf-cust" class="f-req">Customer</label>
      <select id="pf-cust">
        <option value="">Select customer...</option>
        ${buildOpts(custOpts, 'id', x => x.name, cust?.id || '')}
      </select>
    </div>
    <div class="f">
      <label for="pf-mat">Material Grade</label>
      <input type="text" id="pf-mat" value="${p?.matGrade || ''}" placeholder="e.g. 20MnCr5">
    </div>

    ${modalActions('Save Part', `savePart(${p ? `'${p.id}'` : 'null'})`)}
    ${p ? modalDeleteButton(`deletePart('${p.id}')`, 'Delete Part') : ''}
  `);
}

async function deletePart(id) {
  if (!confirm('Delete this part? Its operations routing will also be removed. This cannot be undone.')) return;
  try {
    const before = S.parts.find(x => x.id === id);
    const relatedOps = S.partOps.filter(po => po.partId === id);
    const batch = db.batch();
    batch.delete(db.collection('parts').doc(id));
    relatedOps.forEach(po => batch.delete(db.collection('partOps').doc(po.id)));
    await batch.commit();
    await logAudit('DELETE_PART', 'MASTERS', id, before, null);
    closeModal();
    await refreshCollection('parts');
    await refreshCollection('partOps');
    renderSection();
    toast('Part deleted');
  } catch (e) {
    showModalError(e.message);
  }
}

async function savePart(id) {
  const no       = getField('pf-no');
  const name     = getField('pf-name');
  const custId   = document.getElementById('pf-cust').value;
  const matGrade = getField('pf-mat');

  if (!no || !name || !custId) {
    showModalError('Part Number, Part Name and Customer are required.');
    return;
  }

  const data = { no, name, custId, matGrade };
  try {
    if (id) {
      const before = S.parts.find(x => x.id === id);
      await db.collection('parts').doc(id).update(data);
      await logAudit('UPDATE_PART', 'MASTERS', id, before, data);
    } else {
      const ref = await db.collection('parts').add({
        ...data, createdAt: serverTS(), createdBy: S.sess.userId
      });
      await logAudit('CREATE_PART', 'MASTERS', ref.id, null, data);
    }
    closeModal();
    await refreshCollection('parts');
    renderSection();
    toast('Saved successfully');
  } catch (e) {
    showModalError(e.message);
  }
}

function openRoutingModal(partId, poId) {
  const po = poId ? S.partOps.find(x => x.id === poId) : null;
  const siblingSeqs = S.partOps
    .filter(x => x.partId === partId && x.id !== poId)
    .map(x => x.seqNo || 0);
  const suggestedSeq = siblingSeqs.length ? Math.max(...siblingSeqs) + 10 : 10;
  const opOpts = S.operations.slice().sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  const cycleVal = po?.cycleTimeSecs ?? '';

  openModal(`
    <div class="modal-title">${po ? 'Edit Routing Step' : 'Add Operation to Routing'}</div>
    <div id="modal-err"></div>

    <div class="f">
      <label for="rf-op" class="f-req">Operation</label>
      <select id="rf-op">
        <option value="">Select operation...</option>
        ${buildOpts(opOpts, 'id', x => x.name, po?.opId || '')}
      </select>
    </div>
    <div class="row-2">
      <div class="f">
        <label for="rf-seq" class="f-req">Sequence No.</label>
        <input type="number" id="rf-seq" value="${po?.seqNo ?? suggestedSeq}">
      </div>
      <div class="f">
        <label for="rf-wc" class="f-req">Work Center</label>
        <select id="rf-wc">
          ${buildOpts([
            { v: 'soft', l: 'Soft' }, { v: 'hard', l: 'Hard' }, { v: 'ht', l: 'Heat Treatment' },
          ], 'v', x => x.l, po?.workCenterType || 'soft')}
        </select>
      </div>
    </div>
    <div class="f">
      <label for="rf-cycle" class="f-req">Cycle Time (seconds per piece)</label>
      <input type="number" id="rf-cycle" value="${cycleVal}" oninput="updateCycleHelper(this.value)">
      <div class="text-xs text-muted mt-8" id="rf-cycle-helper">${cycleVal ? (cycleVal / 60).toFixed(2) + ' min/pc' : '—'}</div>
    </div>
    <div class="utog">
      <span class="utog-label">Mandatory</span>
      <label class="tsw">
        <input type="checkbox" id="rf-mand" ${po?.isMandatory !== false ? 'checked' : ''}>
        <span class="tsl"></span>
      </label>
    </div>
    <div class="utog">
      <span class="utog-label">Final Operation</span>
      <label class="tsw">
        <input type="checkbox" id="rf-final" ${po?.finalOperation ? 'checked' : ''}
               onchange="checkFinalOpWarning('${partId}','${poId || ''}',this.checked)">
        <span class="tsl"></span>
      </label>
    </div>
    <div id="rf-final-warn"></div>

    ${modalActions('Save Routing', `saveRouting('${partId}'${poId ? `,'${poId}'` : ''})`)}
  `);

  if (po?.finalOperation) checkFinalOpWarning(partId, poId || '', true);
}

function updateCycleHelper(val) {
  const helper = document.getElementById('rf-cycle-helper');
  const secs = Number(val) || 0;
  if (helper) helper.textContent = secs ? (secs / 60).toFixed(2) + ' min/pc' : '—';
}

function checkFinalOpWarning(partId, poId, checked) {
  const warnEl = document.getElementById('rf-final-warn');
  if (!warnEl) return;
  if (!checked) { warnEl.innerHTML = ''; return; }

  const existing = S.partOps.find(x => x.partId === partId && x.finalOperation && x.id !== poId);
  if (existing) {
    const op = S.operations.find(o => o.id === existing.opId);
    warnEl.innerHTML = `
      <div class="wbox">
        <i class="ti ti-alert-triangle" aria-hidden="true"></i>
        <span>Warning: "${op?.name || existing.opId}" is already set as the Final Operation
        for this part. Only one operation should be the final step before QC.</span>
      </div>`;
  } else {
    warnEl.innerHTML = '';
  }
}

async function saveRouting(partId, poId) {
  const opId            = document.getElementById('rf-op').value;
  const seqNo           = Number(getField('rf-seq'));
  const workCenterType  = document.getElementById('rf-wc').value;
  const cycleTimeSecs   = Number(getField('rf-cycle'));
  const isMandatory     = document.getElementById('rf-mand').checked;
  const finalOperation  = document.getElementById('rf-final').checked;

  if (!opId || !seqNo || !workCenterType || !cycleTimeSecs) {
    showModalError('Operation, Sequence No., Work Center and Cycle Time are required.');
    return;
  }

  const data = { partId, opId, seqNo, workCenterType, cycleTimeSecs, isMandatory, finalOperation };
  try {
    if (poId) {
      const before = S.partOps.find(x => x.id === poId);
      await db.collection('partOps').doc(poId).update(data);
      await logAudit('UPDATE_PART_OP', 'MASTERS', poId, before, data);
    } else {
      const ref = await db.collection('partOps').add({
        ...data, createdAt: serverTS(), createdBy: S.sess.userId
      });
      await logAudit('CREATE_PART_OP', 'MASTERS', ref.id, null, data);
    }
    closeModal();
    await refreshCollection('partOps');
    renderSection();
    toast('Saved successfully');
  } catch (e) {
    showModalError(e.message);
  }
}

async function deleteRouting(poId, partId) {
  if (!confirm('Remove this operation from the routing for this part?')) return;
  try {
    const before = S.partOps.find(x => x.id === poId);
    await db.collection('partOps').doc(poId).delete();
    await logAudit('DELETE_PART_OP', 'MASTERS', poId, before, null);
    await refreshCollection('partOps');
    renderSection();
    toast('Removed from routing');
  } catch (e) {
    toast('Error: ' + e.message);
  }
}

/* ══════════════════════════════════════════════════════════════════════
   SECTION 3 — OPERATIONS
   Collection: operations (name, code, stage)
   ══════════════════════════════════════════════════════════════════════ */
function renderOperations() {
  const q = searchQ.trim().toLowerCase();
  let list = S.operations.filter(o =>
    !q || (o.name || '').toLowerCase().includes(q) || (o.code || '').toLowerCase().includes(q));
  if (filterStage !== 'all') list = list.filter(o => (o.stage || 'general') === filterStage);
  list = list.slice().sort((a, b) => (a.name || '').localeCompare(b.name || ''));

  document.getElementById('section-content').innerHTML = `
    ${sectionHeader('Operations', 'Add Operation', 'openOperationModal()')}
    ${searchAndStageRow('Search operations...', PROD_STAGES)}
    ${recordCount(list.length)}
    ${list.length
      ? list.map(operationRow).join('')
      : emptyState('ti-adjustments', 'No operations found', 'Add an operation to get started, or adjust your search.')}
  `;
}

function operationRow(o) {
  const [cls, label] = STAGE_BADGE[o.stage] || STAGE_BADGE.general;
  return `
    <div class="li" onclick="openOperationModal('${o.id}')">
      <div class="li-ic"><i class="ti ti-adjustments" aria-hidden="true"></i></div>
      <div class="li-body">
        <div class="li-name">${o.name || '—'}</div>
        <div class="li-sub">${o.code || '—'}</div>
      </div>
      <div class="li-right flex items-center gap-12">
        <span class="bdg ${cls}"><span class="bdg-dot"></span>${label}</span>
      </div>
    </div>`;
}

function openOperationModal(id) {
  const o = id ? S.operations.find(x => x.id === id) : null;

  openModal(`
    <div class="modal-title">${o ? 'Edit Operation' : 'Add Operation'}</div>
    <div id="modal-err"></div>

    <div class="f">
      <label for="of-name" class="f-req">Operation Name</label>
      <input type="text" id="of-name" value="${o?.name || ''}" placeholder="e.g. Hobbing">
    </div>
    <div class="f">
      <label for="of-code" class="f-req">Short Code (e.g. HOB, TURN, GRIND)</label>
      <input type="text" id="of-code" value="${o?.code || ''}" style="text-transform:uppercase"
             oninput="this.value=this.value.toUpperCase()" placeholder="e.g. HOB">
    </div>
    <div class="f">
      <label for="of-stage" class="f-req">Stage</label>
      <select id="of-stage">
        ${buildOpts([
          { v: 'soft', l: 'Soft' }, { v: 'hard', l: 'Hard' }, { v: 'ht', l: 'Heat Treatment' },
        ], 'v', x => x.l, o?.stage || 'soft')}
      </select>
    </div>

    ${modalActions('Save Operation', `saveOperation(${o ? `'${o.id}'` : 'null'})`)}
    ${o ? modalDeleteButton(`deleteOperation('${o.id}')`, 'Delete Operation') : ''}
  `);
}

async function deleteOperation(id) {
  if (!confirm('Delete this operation? This cannot be undone.')) return;
  try {
    const before = S.operations.find(x => x.id === id);
    await db.collection('operations').doc(id).delete();
    await logAudit('DELETE_OPERATION', 'MASTERS', id, before, null);
    closeModal();
    await refreshCollection('operations');
    renderSection();
    toast('Operation deleted');
  } catch (e) {
    showModalError(e.message);
  }
}

async function saveOperation(id) {
  const name  = getField('of-name');
  const code  = getField('of-code');
  const stage = document.getElementById('of-stage').value;

  if (!name || !code || !stage) {
    showModalError('Operation Name, Short Code and Stage are required.');
    return;
  }

  const data = { name, code, stage };
  try {
    if (id) {
      const before = S.operations.find(x => x.id === id);
      await db.collection('operations').doc(id).update(data);
      await logAudit('UPDATE_OPERATION', 'MASTERS', id, before, data);
    } else {
      const ref = await db.collection('operations').add({
        ...data, createdAt: serverTS(), createdBy: S.sess.userId
      });
      await logAudit('CREATE_OPERATION', 'MASTERS', ref.id, null, data);
    }
    closeModal();
    await refreshCollection('operations');
    renderSection();
    toast('Saved successfully');
  } catch (e) {
    showModalError(e.message);
  }
}

/* ══════════════════════════════════════════════════════════════════════
   SECTION 4 — CUSTOMERS
   Collection: customers (name, code, allowedStreams[], dotPunchingRequired)
   ══════════════════════════════════════════════════════════════════════ */
const STREAM_BADGE = {
  OEM:    ['bdg-n', 'OEM'],
  SPARES: ['bdg-b', 'Spares'],
  MARKET: ['bdg-g', 'Market'],
};

function renderCustomers() {
  const q = searchQ.trim().toLowerCase();
  let list = S.customers.filter(c =>
    !q || (c.name || '').toLowerCase().includes(q) || (c.code || '').toLowerCase().includes(q));
  list = list.slice().sort((a, b) => (a.name || '').localeCompare(b.name || ''));

  document.getElementById('section-content').innerHTML = `
    ${sectionHeader('Customers', 'Add Customer', 'openCustomerModal()')}
    ${searchBox('Search customers...')}
    ${recordCount(list.length)}
    ${list.length
      ? list.map(customerRow).join('')
      : emptyState('ti-building', 'No customers found', 'Add a customer to get started, or adjust your search.')}
  `;
}

function customerRow(c) {
  const streams = (c.allowedStreams || []).map(s => {
    const [cls, label] = STREAM_BADGE[s] || ['bdg-gr', s];
    return `<span class="bdg ${cls}">${label}</span>`;
  }).join(' ');

  return `
    <div class="li" onclick="openCustomerModal('${c.id}')">
      <div class="li-ic"><i class="ti ti-building" aria-hidden="true"></i></div>
      <div class="li-body">
        <div class="li-name">${c.name || '—'}</div>
        <div class="li-sub">${c.code || '—'}</div>
      </div>
      <div class="li-right flex items-center gap-12">
        <div class="flex gap-8">${streams}</div>
      </div>
    </div>`;
}

function openCustomerModal(id) {
  const c = id ? S.customers.find(x => x.id === id) : null;
  const streams = c?.allowedStreams || [];

  const streamCheck = (val, label) => `
    <label style="display:flex;align-items:center;gap:6px;font-size:13px;font-weight:600;color:var(--txt);cursor:pointer">
      <input type="checkbox" name="cf-stream" value="${val}" ${streams.includes(val) ? 'checked' : ''}
             style="width:auto;accent-color:var(--imf-navy)">
      ${label}
    </label>`;

  openModal(`
    <div class="modal-title">${c ? 'Edit Customer' : 'Add Customer'}</div>
    <div id="modal-err"></div>

    <div class="f">
      <label for="cf-name" class="f-req">Customer Name</label>
      <input type="text" id="cf-name" value="${c?.name || ''}" placeholder="e.g. Mahindra & Mahindra">
    </div>
    <div class="f">
      <label for="cf-code" class="f-req">Customer Code</label>
      <input type="text" id="cf-code" value="${c?.code || ''}" style="text-transform:uppercase"
             oninput="this.value=this.value.toUpperCase()" placeholder="e.g. M&M">
    </div>
    <div class="f">
      <label class="f-req">Allowed Streams</label>
      <div class="flex gap-12" style="padding:10px 13px;background:var(--sur2);border:1.5px solid var(--bdr-mid);border-radius:var(--rs)">
        ${streamCheck('OEM', 'OEM')}
        ${streamCheck('SPARES', 'Spares')}
        ${streamCheck('MARKET', 'Market')}
      </div>
    </div>
    <div class="utog">
      <div>
        <div class="utog-label">Dot Punching Required before HT?</div>
        <div class="text-xs text-muted mt-8">Turn OFF for Mahindra (M&M) parts</div>
      </div>
      <label class="tsw">
        <input type="checkbox" id="cf-dot" ${c ? (c.dotPunchingRequired !== false ? 'checked' : '') : 'checked'}>
        <span class="tsl"></span>
      </label>
    </div>

    ${modalActions('Save Customer', `saveCustomer(${c ? `'${c.id}'` : 'null'})`)}
    ${c ? modalDeleteButton(`deleteCustomer('${c.id}')`, 'Delete Customer') : ''}
  `);
}

async function deleteCustomer(id) {
  if (!confirm('Delete this customer? This cannot be undone.')) return;
  try {
    const before = S.customers.find(x => x.id === id);
    await db.collection('customers').doc(id).delete();
    await logAudit('DELETE_CUSTOMER', 'MASTERS', id, before, null);
    closeModal();
    await refreshCollection('customers');
    renderSection();
    toast('Customer deleted');
  } catch (e) {
    showModalError(e.message);
  }
}

async function saveCustomer(id) {
  const name = getField('cf-name');
  const code = getField('cf-code');
  const allowedStreams = Array.from(document.querySelectorAll('input[name="cf-stream"]:checked')).map(el => el.value);
  const dotPunchingRequired = document.getElementById('cf-dot').checked;

  if (!name || !code) {
    showModalError('Customer Name and Customer Code are required.');
    return;
  }
  if (!allowedStreams.length) {
    showModalError('Select at least one allowed stream (OEM, Spares, or Market).');
    return;
  }

  const data = { name, code, allowedStreams, dotPunchingRequired };
  try {
    if (id) {
      const before = S.customers.find(x => x.id === id);
      await db.collection('customers').doc(id).update(data);
      await logAudit('UPDATE_CUSTOMER', 'MASTERS', id, before, data);
    } else {
      const ref = await db.collection('customers').add({
        ...data, createdAt: serverTS(), createdBy: S.sess.userId
      });
      await logAudit('CREATE_CUSTOMER', 'MASTERS', ref.id, null, data);
    }
    closeModal();
    await refreshCollection('customers');
    renderSection();
    toast('Saved successfully');
  } catch (e) {
    showModalError(e.message);
  }
}

/* ══════════════════════════════════════════════════════════════════════
   SECTION 5 — SUPPLIERS
   Collection: suppliers (name, code, contactPerson, contactPhone)
   ══════════════════════════════════════════════════════════════════════ */
function renderSuppliers() {
  const q = searchQ.trim().toLowerCase();
  let list = S.suppliers.filter(s =>
    !q || (s.name || '').toLowerCase().includes(q) || (s.code || '').toLowerCase().includes(q));
  list = list.slice().sort((a, b) => (a.name || '').localeCompare(b.name || ''));

  document.getElementById('section-content').innerHTML = `
    ${sectionHeader('Suppliers', 'Add Supplier', 'openSupplierModal()')}
    ${searchBox('Search suppliers...')}
    ${recordCount(list.length)}
    ${list.length
      ? list.map(supplierRow).join('')
      : emptyState('ti-truck-delivery', 'No suppliers found', 'Add a supplier to get started, or adjust your search.')}
  `;
}

function supplierRow(s) {
  return `
    <div class="li" onclick="openSupplierModal('${s.id}')">
      <div class="li-ic"><i class="ti ti-truck-delivery" aria-hidden="true"></i></div>
      <div class="li-body">
        <div class="li-name">${s.name || '—'}</div>
        <div class="li-sub">${s.code || '—'}${s.contactPerson ? ' · ' + s.contactPerson : ''}${s.contactPhone ? ' · ' + s.contactPhone : ''}</div>
      </div>
    </div>`;
}

function openSupplierModal(id) {
  const s = id ? S.suppliers.find(x => x.id === id) : null;

  openModal(`
    <div class="modal-title">${s ? 'Edit Supplier' : 'Add Supplier'}</div>
    <div id="modal-err"></div>

    <div class="f">
      <label for="sf-name" class="f-req">Supplier Name</label>
      <input type="text" id="sf-name" value="${s?.name || ''}" placeholder="e.g. Shree Ram Industries">
    </div>
    <div class="f">
      <label for="sf-code" class="f-req">Supplier Code</label>
      <input type="text" id="sf-code" value="${s?.code || ''}" style="text-transform:uppercase"
             oninput="this.value=this.value.toUpperCase()" placeholder="e.g. SRI">
    </div>
    <div class="row-2">
      <div class="f">
        <label for="sf-contact-name">Contact Person</label>
        <input type="text" id="sf-contact-name" value="${s?.contactPerson || ''}" placeholder="e.g. Ramesh Patil">
      </div>
      <div class="f">
        <label for="sf-contact-phone">Contact Phone Number</label>
        <input type="tel" id="sf-contact-phone" value="${s?.contactPhone || ''}" placeholder="e.g. 9876543210">
      </div>
    </div>

    ${modalActions('Save Supplier', `saveSupplier(${s ? `'${s.id}'` : 'null'})`)}
    ${s ? modalDeleteButton(`deleteSupplier('${s.id}')`, 'Delete Supplier') : ''}
  `);
}

async function deleteSupplier(id) {
  if (!confirm('Delete this supplier? This cannot be undone.')) return;
  try {
    const before = S.suppliers.find(x => x.id === id);
    await db.collection('suppliers').doc(id).delete();
    await logAudit('DELETE_SUPPLIER', 'MASTERS', id, before, null);
    closeModal();
    await refreshCollection('suppliers');
    renderSection();
    toast('Supplier deleted');
  } catch (e) {
    showModalError(e.message);
  }
}

async function saveSupplier(id) {
  const name = getField('sf-name');
  const code = getField('sf-code');
  const contactPerson = getField('sf-contact-name');
  const contactPhone = getField('sf-contact-phone');

  if (!name || !code) {
    showModalError('Supplier Name and Supplier Code are required.');
    return;
  }

  const data = { name, code, contactPerson, contactPhone };
  try {
    if (id) {
      const before = S.suppliers.find(x => x.id === id);
      await db.collection('suppliers').doc(id).update(data);
      await logAudit('UPDATE_SUPPLIER', 'MASTERS', id, before, data);
    } else {
      const ref = await db.collection('suppliers').add({
        ...data, createdAt: serverTS(), createdBy: S.sess.userId
      });
      await logAudit('CREATE_SUPPLIER', 'MASTERS', ref.id, null, data);
    }
    closeModal();
    await refreshCollection('suppliers');
    renderSection();
    toast('Saved successfully');
  } catch (e) {
    showModalError(e.message);
  }
}

/* ══════════════════════════════════════════════════════════════════════
   SECTION 6 — PERSONNEL
   Collection: users — docs where appUser === false
   Shop-floor operators tracked for production logs. No app login,
   minimal fields (name, role:'operator', stage, appUser:false).
   ══════════════════════════════════════════════════════════════════════ */
function renderPersonnel() {
  const q = searchQ.trim().toLowerCase();
  let list = S.users.filter(u => u.appUser === false);
  if (filterStage !== 'all') list = list.filter(u => (u.stage || 'general') === filterStage);
  if (q) list = list.filter(u => (u.name || '').toLowerCase().includes(q));
  list = list.slice().sort((a, b) => (a.name || '').localeCompare(b.name || ''));

  document.getElementById('section-content').innerHTML = `
    ${sectionHeader('Personnel', 'Add Personnel', 'openPersonnelModal()')}
    <div class="text-xs text-muted mb-12">Shop-floor operators tracked for production logs — these people do not log into the app.</div>
    ${searchAndStageRow('Search personnel...', DEPT_STAGES)}
    ${recordCount(list.length)}
    ${list.length
      ? list.map(personnelRow).join('')
      : emptyState('ti-users', 'No personnel found', 'Add a person to get started, or adjust your search.')}
  `;
}

function personnelRow(u) {
  return `
    <div class="li" onclick="openPersonnelModal('${u.id}')">
      <div class="li-ic" style="font-size:12px;font-weight:700">${initials(u.name || '?')}</div>
      <div class="li-body">
        <div class="li-name">${u.name || '—'}</div>
        <div class="li-sub">${deptStageLabel(u.stage || 'general')}</div>
      </div>
      <div class="li-right flex items-center gap-12">
        <span class="bdg ${sbdg(u.stage)}">${deptStageLabel(u.stage || 'general')}</span>
      </div>
    </div>`;
}

function openPersonnelModal(id) {
  const u = id ? S.users.find(x => x.id === id) : null;

  openModal(`
    <div class="modal-title">${u ? 'Edit Personnel' : 'Add Personnel'}</div>
    <div id="modal-err"></div>

    <div class="f">
      <label for="pf-name" class="f-req">Full Name</label>
      <input type="text" id="pf-name" value="${u?.name || ''}" placeholder="e.g. Suresh Kumar">
    </div>
    <div class="f">
      <label for="pf-stage" class="f-req">Department / Stage</label>
      <select id="pf-stage">
        ${buildOpts(DEPT_STAGES, 'v', x => x.l, u?.stage || 'general')}
      </select>
    </div>

    ${modalActions('Save Personnel', `savePersonnel(${u ? `'${u.id}'` : 'null'})`)}
    ${u ? modalDeleteButton(`deletePersonnel('${u.id}')`, 'Delete Personnel') : ''}
  `);
}

async function deletePersonnel(id) {
  if (!confirm('Delete this person? This cannot be undone.')) return;
  try {
    const before = S.users.find(x => x.id === id);
    await db.collection('users').doc(id).delete();
    await logAudit('DELETE_PERSONNEL', 'MASTERS', id, before, null);
    closeModal();
    await refreshCollection('users');
    renderSection();
    toast('Personnel deleted');
  } catch (e) {
    showModalError(e.message);
  }
}

async function savePersonnel(id) {
  const name  = getField('pf-name');
  const stage = document.getElementById('pf-stage').value;

  if (!name) {
    showModalError('Full Name is required.');
    return;
  }

  const data = { name, role: 'operator', stage, appUser: false };
  try {
    if (id) {
      const before = S.users.find(x => x.id === id);
      await db.collection('users').doc(id).update(data);
      await logAudit('UPDATE_PERSONNEL', 'MASTERS', id, before, data);
    } else {
      const ref = await db.collection('users').add({
        ...data, createdAt: serverTS(), createdBy: S.sess.userId
      });
      await logAudit('CREATE_PERSONNEL', 'MASTERS', ref.id, null, data);
    }
    closeModal();
    await refreshCollection('users');
    renderSection();
    toast('Saved successfully');
  } catch (e) {
    showModalError(e.message);
  }
}

/* ══════════════════════════════════════════════════════════════════════
   SECTION 7 — USER ACCESS
   Collection: users — docs where appUser !== false
   App logins for operators, supervisors, HODs and admins.
   Full fields: name, role, stage, email, permissions{plan,actual,reports}.
   Role is one of: operator, supervisor, hod, admin — combined with the
   department/stage (DEPT_STAGES) this fully describes the user (e.g.
   role=hod + stage=qc = "Quality HOD"). No separate HOD toggle needed.
   ══════════════════════════════════════════════════════════════════════ */
const USER_ROLES = ['operator', 'supervisor', 'hod', 'admin'];

const PERM_LEVELS = [
  { v: 'full', l: 'Full' }, { v: 'view', l: 'View' }, { v: 'hidden', l: 'Hidden' },
];

function renderUserAccess() {
  const q = searchQ.trim().toLowerCase();
  let list = S.users.filter(u => u.appUser !== false);
  if (filterStage !== 'all') list = list.filter(u => (u.stage || 'general') === filterStage);
  if (q) list = list.filter(u =>
    (u.name || '').toLowerCase().includes(q) || (u.email || '').toLowerCase().includes(q));
  list = list.slice().sort((a, b) => (a.name || '').localeCompare(b.name || ''));

  document.getElementById('section-content').innerHTML = `
    ${sectionHeader('User Access', 'Add User', 'openUserAccessModal()')}
    <div class="text-xs text-muted mb-12">App logins, roles and permissions for office &amp; supervisory staff.</div>
    ${searchAndStageRow('Search users...', DEPT_STAGES)}
    ${recordCount(list.length)}
    ${list.length
      ? list.map(userAccessRow).join('')
      : emptyState('ti-user-shield', 'No users found', 'Add a user to get started, or adjust your search.')}
  `;
}

function userAccessRow(u) {
  return `
    <div class="li" onclick="openUserAccessModal('${u.id}')">
      <div class="li-ic" style="font-size:12px;font-weight:700">${initials(u.name || u.email || '?')}</div>
      <div class="li-body">
        <div class="li-name">${u.name || '—'}</div>
        <div class="li-sub">${u.email || '—'}</div>
      </div>
      <div class="li-right flex items-center gap-12">
        <span class="bdg bdg-n">${rlbl(u.role)}</span>
        <span class="bdg ${sbdg(u.stage)}">${deptStageLabel(u.stage || 'general')}</span>
      </div>
    </div>`;
}

function openUserAccessModal(id) {
  const u = id ? S.users.find(x => x.id === id) : null;
  const perms = u?.permissions || { plan: 'full', actual: 'full', reports: 'full' };

  const passwordField = u ? '' : `
    <div class="f">
      <label for="uf-pass" class="f-req">Temporary Password</label>
      <input type="password" id="uf-pass" placeholder="Minimum 8 characters" autocomplete="new-password">
      <div class="text-xs text-muted mt-8">User can change this after first login</div>
    </div>`;

  const emailField = `<input type="email" id="uf-email" value="${u?.email || ''}" placeholder="user@indometaforge.com" autocomplete="off">`;

  const passNote = u
    ? `<div class="ibox"><i class="ti ti-info-circle" aria-hidden="true"></i>
        <span>The email above is this user's login email. Changing it here updates their Firestore
        record but NOT their Firebase Authentication login — they will still sign in with
        <strong>${u.email}</strong> until that is changed in the Firebase Console.</span></div>
       <button class="btn btn-s w-full mt-8" onclick="sendUserPasswordReset('${u.email}')">
         <i class="ti ti-mail" aria-hidden="true"></i> Send Password Reset Email
       </button>`
    : '';

  /* If an existing user has a role outside USER_ROLES, keep it selectable
     so editing other fields doesn't silently overwrite their role. */
  const roleOpts = USER_ROLES.slice();
  if (u?.role && !roleOpts.includes(u.role)) roleOpts.unshift(u.role);

  openModal(`
    <div class="modal-title">${u ? 'Edit User' : 'Add User'}</div>
    <div id="modal-err"></div>

    <div class="f">
      <label for="uf-name" class="f-req">Full Name</label>
      <input type="text" id="uf-name" value="${u?.name || ''}" placeholder="e.g. Rajesh Kumar">
    </div>
    <div class="f">
      <label for="uf-email" class="f-req">Email</label>
      ${emailField}
    </div>
    ${passwordField}
    <div class="row-2">
      <div class="f">
        <label for="uf-role" class="f-req">Role</label>
        <select id="uf-role">
          ${u ? '' : '<option value="">Select role...</option>'}
          ${buildOpts(roleOpts.map(r => ({ v: r, l: rlbl(r) })), 'v', x => x.l, u?.role || '')}
        </select>
      </div>
      <div class="f">
        <label for="uf-stage">Department / Stage</label>
        <select id="uf-stage">
          ${buildOpts(DEPT_STAGES, 'v', x => x.l, u?.stage || 'general')}
        </select>
      </div>
    </div>
    <div class="f">
      <label>Permissions</label>
      <div class="row-2">
        <div class="f">
          <label for="uf-perm-plan" style="font-size:11px">Plans</label>
          <select id="uf-perm-plan">${buildOpts(PERM_LEVELS, 'v', x => x.l, perms.plan || 'full')}</select>
        </div>
        <div class="f">
          <label for="uf-perm-actual" style="font-size:11px">Actuals</label>
          <select id="uf-perm-actual">${buildOpts(PERM_LEVELS, 'v', x => x.l, perms.actual || 'full')}</select>
        </div>
      </div>
      <div class="f">
        <label for="uf-perm-reports" style="font-size:11px">Reports</label>
        <select id="uf-perm-reports">${buildOpts(PERM_LEVELS, 'v', x => x.l, perms.reports || 'full')}</select>
      </div>
    </div>
    ${passNote}

    ${modalActions('Save User', `saveUserAccess(${u ? `'${u.id}'` : 'null'})`)}
    ${u ? modalDeleteButton(`deleteUserAccess('${u.id}')`, 'Delete User') : ''}
  `);
}

/** Send a password-reset link to the user's email via Firebase Auth (no Admin SDK needed) */
async function sendUserPasswordReset(email) {
  try {
    await auth.sendPasswordResetEmail(email);
    toast('Password reset email sent to ' + email);
  } catch (e) {
    toast('Error: ' + e.message);
  }
}

async function deleteUserAccess(id) {
  const u = S.users.find(x => x.id === id);
  if (u && u.id === S.sess.userId) {
    showModalError('You cannot delete your own account.');
    return;
  }
  if (!confirm('Delete this user record? Their Firebase Authentication login will NOT be removed — delete it separately in the Firebase Console. This cannot be undone.')) return;
  try {
    const before = S.users.find(x => x.id === id);
    await db.collection('users').doc(id).delete();
    await logAudit('DELETE_USER', 'MASTERS', id, before, null);
    closeModal();
    await refreshCollection('users');
    renderSection();
    toast('User record deleted');
  } catch (e) {
    showModalError(e.message);
  }
}

async function saveUserAccess(id) {
  const name  = getField('uf-name');
  const email = getField('uf-email');
  const role  = document.getElementById('uf-role').value;
  const stage = document.getElementById('uf-stage').value;
  const permissions = {
    plan:    document.getElementById('uf-perm-plan').value,
    actual:  document.getElementById('uf-perm-actual').value,
    reports: document.getElementById('uf-perm-reports').value,
  };

  if (!name || !role || !email) {
    showModalError('Full Name, Email and Role are required.');
    return;
  }

  try {
    if (id) {
      /* Edit: name, email, role, stage, permissions — Firestore record only.
         Does NOT change the Firebase Auth login email/password; see passNote above. */
      const before = S.users.find(x => x.id === id);
      const data = { name, email, role, stage, permissions };
      await db.collection('users').doc(id).update(data);
      await logAudit('UPDATE_USER', 'MASTERS', id, before, data);
    } else {
      const email = getField('uf-email');
      const pass  = document.getElementById('uf-pass').value;

      if (!email) { showModalError('Email is required.'); return; }
      if (!pass || pass.length < 8) { showModalError('Temporary Password must be at least 8 characters.'); return; }

      /* Create the Auth account on a SEPARATE secondary app instance so this
         does not sign the current admin out of their own session (Firebase
         Auth's createUserWithEmailAndPassword signs in as the new user on
         whichever auth instance it's called on). */
      const secondaryApp = firebase.initializeApp(firebase.app().options, 'Secondary_' + Date.now());
      const secondaryAuth = secondaryApp.auth();
      let newUid;
      try {
        const cred = await secondaryAuth.createUserWithEmailAndPassword(email, pass);
        newUid = cred.user.uid;
        await secondaryAuth.signOut();
      } finally {
        await secondaryApp.delete();
      }

      const data = { name, email, role, stage, permissions, appUser: true };
      await db.collection('users').doc(newUid).set({
        ...data, createdAt: serverTS(), createdBy: S.sess.userId
      });
      await logAudit('CREATE_USER', 'MASTERS', newUid, null, data);
    }
    closeModal();
    await refreshCollection('users');
    renderSection();
    toast('Saved successfully');
  } catch (e) {
    showModalError(e.message);
  }
}

/* ══════════════════════════════════════════════════════════════════════
   SECTION 8 — SHIFTS
   Collection: config, doc: shifts — single document, edited as 3 cards.
   ══════════════════════════════════════════════════════════════════════ */
function renderShifts() {
  const keys = Object.keys(S.shifts || {}).sort();

  document.getElementById('section-content').innerHTML = `
    <div class="flex justify-between items-center mb-12">
      <div style="font-size:16px;font-weight:700">Shifts</div>
    </div>
    ${keys.map(shiftCard).join('')}
  `;
}

function shiftCard(key) {
  const sh = S.shifts[key] || {};
  return `
    <div class="card">
      <div class="card-hd">${(sh.label || key).toUpperCase()}</div>
      <div class="flex justify-between items-center">
        <div>
          <div style="font-size:20px;font-weight:800;font-family:'Inter Tight','Inter',sans-serif">
            ${sh.start || '—'} – ${sh.end || '—'}
          </div>
          <div class="li-sub mt-8">${sh.label || key}</div>
        </div>
        <button class="btn btn-s btn-sm" onclick="openShiftModal('${key}')">
          <i class="ti ti-edit" aria-hidden="true"></i> Edit
        </button>
      </div>
    </div>`;
}

function openShiftModal(key) {
  const sh = S.shifts[key] || {};

  openModal(`
    <div class="modal-title">Edit ${sh.label || key}</div>
    <div id="modal-err"></div>

    <div class="f">
      <label for="shf-label" class="f-req">Shift Label</label>
      <input type="text" id="shf-label" value="${sh.label || ''}" placeholder="e.g. Shift 1">
    </div>
    <div class="row-2">
      <div class="f">
        <label for="shf-start" class="f-req">Start Time</label>
        <input type="time" id="shf-start" value="${sh.start || ''}">
      </div>
      <div class="f">
        <label for="shf-end" class="f-req">End Time</label>
        <input type="time" id="shf-end" value="${sh.end || ''}">
      </div>
    </div>

    ${modalActions('Save Shift', `saveShift('${key}')`)}
  `);
}

async function saveShift(key) {
  const label = getField('shf-label');
  const start = getField('shf-start');
  const end   = getField('shf-end');

  if (!label || !start || !end) {
    showModalError('Shift Label, Start Time and End Time are required.');
    return;
  }

  const before = { ...(S.shifts[key] || {}) };
  const after  = { label, start, end };

  try {
    await db.collection('config').doc('shifts').update({
      [`${key}.label`]: label,
      [`${key}.start`]: start,
      [`${key}.end`]: end,
      updatedAt: serverTS(),
      updatedBy: S.sess.userId,
    });
    await logAudit('UPDATE_SHIFT', 'MASTERS', key, before, after);

    S.shifts[key] = { ...S.shifts[key], ...after };
    closeModal();
    renderSection();
    toast('Shift timings updated');
  } catch (e) {
    showModalError(e.message);
  }
}

/* ══════════════════════════════════════════════════════════════════════
   BOOT
   ══════════════════════════════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', init);
