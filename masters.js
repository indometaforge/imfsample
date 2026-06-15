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
let expandedPart = null;   /* partId whose routing panel is open */

const TABS = [
  { key: 'machines',    label: 'Machines',      icon: 'ti-settings' },
  { key: 'parts',       label: 'Parts & Routing', icon: 'ti-gear' },
  { key: 'operations',  label: 'Operations',    icon: 'ti-adjustments' },
  { key: 'customers',   label: 'Customers',     icon: 'ti-building' },
  { key: 'suppliers',   label: 'Suppliers',     icon: 'ti-truck-delivery' },
  { key: 'users',       label: 'Users',         icon: 'ti-user' },
  { key: 'defectCodes', label: 'Defect Codes',  icon: 'ti-alert-triangle' },
  { key: 'spareParts',  label: 'Spare Parts',   icon: 'ti-tool' },
  { key: 'shifts',      label: 'Shifts',        icon: 'ti-clock' },
];

/* Map a Firestore collection name to its S.* state array key */
const COLL_TO_STATE = {
  machines: 'machines', parts: 'parts', operations: 'operations',
  partOps: 'partOps', customers: 'customers', suppliers: 'suppliers',
  users: 'users', defectCodes: 'defectCodes', spareParts: 'spareParts'
};

/* ══════════════════════════════════════════════════════════════════════
   INIT
   ══════════════════════════════════════════════════════════════════════ */
async function init() {
  await initShell();

  if (!canView('masters')) {
    window.location.replace('home.html');
    return;
  }

  const pill = document.getElementById('role-pill');
  if (pill) pill.textContent = rlbl(S.sess.role);

  render();

  document.getElementById('loading-screen').style.display = 'none';
  document.getElementById('app').style.display = '';

  /* Debug helpers — uncomment to confirm field names against live data:
  await sniffFields('parts');
  await sniffFields('machines');
  await sniffFields('customers');
  */
}

/* ══════════════════════════════════════════════════════════════════════
   FIELD-NAME SNIFFER (debug utility — see prompt instructions)
   ══════════════════════════════════════════════════════════════════════ */
async function sniffFields(collection) {
  const snap = await db.collection(collection).limit(1).get();
  if (!snap.empty) {
    console.log(collection, 'fields:', Object.keys(snap.docs[0].data()), snap.docs[0].data());
  } else {
    console.log(collection, 'is empty');
  }
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
    users:       renderUsers,
    defectCodes: renderDefectCodes,
    spareParts:  renderSpareParts,
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

/** isActive toggle switch — generic, works against any master collection */
function activeToggle(collection, id, isActive) {
  return `
    <label class="tsw" onclick="event.stopPropagation()" title="${isActive ? 'Active' : 'Inactive'}">
      <input type="checkbox" ${isActive ? 'checked' : ''}
             onchange="toggleActive('${collection}','${id}',this.checked)">
      <span class="tsl"></span>
    </label>`;
}

async function toggleActive(collection, id, val) {
  try {
    const before = (S[COLL_TO_STATE[collection]] || []).find(x => x.id === id);
    await db.collection(collection).doc(id).update({ isActive: val });
    await logAudit(val ? 'ACTIVATE' : 'DEACTIVATE', 'MASTERS', id,
      { isActive: before ? before.isActive !== false : true }, { isActive: val });
    await refreshCollection(collection);
    renderSection();
    toast(val ? 'Activated' : (collection === 'users' ? 'User deactivated. They can no longer log in.' : 'Deactivated'));
  } catch (e) {
    toast('Error: ' + e.message);
  }
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

/* ══════════════════════════════════════════════════════════════════════
   SECTION 1 — MACHINES
   Collection: machines (doc ID = machineId, immutable)
   ══════════════════════════════════════════════════════════════════════ */
const STAGE_BADGE = {
  soft:    ['bdg-soft', 'Soft'],
  hard:    ['bdg-hard', 'Hard'],
  ht:      ['bdg-ht',   'HT'],
  general: ['bdg-gr',   'General'],
};

function renderMachines() {
  const q = searchQ.trim().toLowerCase();
  let list = S.machines.filter(m =>
    !q || (m.name || '').toLowerCase().includes(q) || (m.id || '').toLowerCase().includes(q));
  list = list.slice().sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0) || (a.name || '').localeCompare(b.name || ''));

  document.getElementById('section-content').innerHTML = `
    ${sectionHeader('Machines', 'Add Machine', 'openMachineModal()')}
    ${searchBox('Search machines...')}
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
        <div class="li-sub">${m.id}</div>
      </div>
      <div class="li-right flex items-center gap-12">
        <span class="bdg ${cls}"><span class="bdg-dot"></span>${label}</span>
        ${activeToggle('machines', m.id, m.isActive !== false)}
      </div>
    </div>`;
}

function openMachineModal(id) {
  const m = id ? S.machines.find(x => x.id === id) : null;

  const idField = m
    ? `<div class="mono" style="padding:10px 13px;background:var(--sur2);border:1.5px solid var(--bdr-mid);border-radius:var(--rs)">${m.id}</div>
       <div class="text-xs text-muted mt-8">ID cannot be changed</div>`
    : `<input type="text" id="mf-id" placeholder="e.g. CNC-01" style="text-transform:uppercase" oninput="this.value=this.value.toUpperCase()">`;

  openModal(`
    <div class="modal-title">${m ? 'Edit Machine' : 'Add Machine'}</div>
    <div id="modal-err"></div>

    <div class="f">
      <label for="mf-id" class="f-req">Machine ID</label>
      ${idField}
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
    </div>
    <div class="utog">
      <span class="utog-label">Active</span>
      <label class="tsw">
        <input type="checkbox" id="mf-active" ${m?.isActive !== false ? 'checked' : ''}>
        <span class="tsl"></span>
      </label>
    </div>

    ${modalActions('Save Machine', `saveMachine(${m ? `'${m.id}'` : 'null'})`)}
  `);
}

async function saveMachine(id) {
  const name      = getField('mf-name');
  const stage     = document.getElementById('mf-stage').value;
  const sortOrder = Number(getField('mf-sort')) || 0;
  const isActive  = document.getElementById('mf-active').checked;
  const machineId = id || getField('mf-id');

  if (!machineId || !name || !stage) {
    showModalError('Machine ID, Name and Stage are required.');
    return;
  }

  const data = { name, stage, sortOrder, isActive };

  try {
    if (id) {
      const before = S.machines.find(x => x.id === id);
      await db.collection('machines').doc(id).update(data);
      await logAudit('UPDATE_MACHINE', 'MASTERS', id, before, data);
    } else {
      const existing = await db.collection('machines').doc(machineId).get();
      if (existing.exists) {
        showModalError(`Machine ID "${machineId}" already exists. Choose a different ID.`);
        return;
      }
      await db.collection('machines').doc(machineId).set({
        ...data, createdAt: serverTS(), createdBy: S.sess.userId
      });
      await logAudit('CREATE_MACHINE', 'MASTERS', machineId, null, data);
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
   Collection: parts    (no, name, custId, matGrade, isActive)
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
        ${activeToggle('parts', p.id, p.isActive !== false)}
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
    <div class="utog">
      <span class="utog-label">Active</span>
      <label class="tsw">
        <input type="checkbox" id="pf-active" ${p?.isActive !== false ? 'checked' : ''}>
        <span class="tsl"></span>
      </label>
    </div>

    ${modalActions('Save Part', `savePart(${p ? `'${p.id}'` : 'null'})`)}
  `);
}

async function savePart(id) {
  const no       = getField('pf-no');
  const name     = getField('pf-name');
  const custId   = document.getElementById('pf-cust').value;
  const matGrade = getField('pf-mat');
  const isActive = document.getElementById('pf-active').checked;

  if (!no || !name || !custId) {
    showModalError('Part Number, Part Name and Customer are required.');
    return;
  }

  const data = { no, name, custId, matGrade, isActive };
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
   Collection: operations (name, code, stage, isActive)
   ══════════════════════════════════════════════════════════════════════ */
function renderOperations() {
  const q = searchQ.trim().toLowerCase();
  let list = S.operations.filter(o =>
    !q || (o.name || '').toLowerCase().includes(q) || (o.code || '').toLowerCase().includes(q));
  list = list.slice().sort((a, b) => (a.name || '').localeCompare(b.name || ''));

  document.getElementById('section-content').innerHTML = `
    ${sectionHeader('Operations', 'Add Operation', 'openOperationModal()')}
    ${searchBox('Search operations...')}
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
        ${activeToggle('operations', o.id, o.isActive !== false)}
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
    <div class="utog">
      <span class="utog-label">Active</span>
      <label class="tsw">
        <input type="checkbox" id="of-active" ${o?.isActive !== false ? 'checked' : ''}>
        <span class="tsl"></span>
      </label>
    </div>

    ${modalActions('Save Operation', `saveOperation(${o ? `'${o.id}'` : 'null'})`)}
  `);
}

async function saveOperation(id) {
  const name  = getField('of-name');
  const code  = getField('of-code');
  const stage = document.getElementById('of-stage').value;
  const isActive = document.getElementById('of-active').checked;

  if (!name || !code || !stage) {
    showModalError('Operation Name, Short Code and Stage are required.');
    return;
  }

  const data = { name, code, stage, isActive };
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
   Collection: customers (name, code, allowedStreams[], dotPunchingRequired, isActive)
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
        ${activeToggle('customers', c.id, c.isActive !== false)}
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
    <div class="utog">
      <span class="utog-label">Active</span>
      <label class="tsw">
        <input type="checkbox" id="cf-active" ${c?.isActive !== false ? 'checked' : ''}>
        <span class="tsl"></span>
      </label>
    </div>

    ${modalActions('Save Customer', `saveCustomer(${c ? `'${c.id}'` : 'null'})`)}
  `);
}

async function saveCustomer(id) {
  const name = getField('cf-name');
  const code = getField('cf-code');
  const allowedStreams = Array.from(document.querySelectorAll('input[name="cf-stream"]:checked')).map(el => el.value);
  const dotPunchingRequired = document.getElementById('cf-dot').checked;
  const isActive = document.getElementById('cf-active').checked;

  if (!name || !code) {
    showModalError('Customer Name and Customer Code are required.');
    return;
  }
  if (!allowedStreams.length) {
    showModalError('Select at least one allowed stream (OEM, Spares, or Market).');
    return;
  }

  const data = { name, code, allowedStreams, dotPunchingRequired, isActive };
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
   Collection: suppliers (name, code, defaultMatGrade, contactInfo, isActive)
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
        <div class="li-sub">${s.code || '—'}${s.defaultMatGrade ? ' · ' + s.defaultMatGrade : ''}</div>
      </div>
      <div class="li-right flex items-center gap-12">
        ${activeToggle('suppliers', s.id, s.isActive !== false)}
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
    <div class="f">
      <label for="sf-mat">Default Material Grade (e.g. 20MnCr5)</label>
      <input type="text" id="sf-mat" value="${s?.defaultMatGrade || ''}" placeholder="e.g. 20MnCr5">
    </div>
    <div class="f">
      <label for="sf-contact">Contact Info</label>
      <textarea id="sf-contact" placeholder="Phone, email, address...">${s?.contactInfo || ''}</textarea>
    </div>
    <div class="utog">
      <span class="utog-label">Active</span>
      <label class="tsw">
        <input type="checkbox" id="sf-active" ${s?.isActive !== false ? 'checked' : ''}>
        <span class="tsl"></span>
      </label>
    </div>

    ${modalActions('Save Supplier', `saveSupplier(${s ? `'${s.id}'` : 'null'})`)}
  `);
}

async function saveSupplier(id) {
  const name = getField('sf-name');
  const code = getField('sf-code');
  const defaultMatGrade = getField('sf-mat');
  const contactInfo = document.getElementById('sf-contact').value.trim();
  const isActive = document.getElementById('sf-active').checked;

  if (!name || !code) {
    showModalError('Supplier Name and Supplier Code are required.');
    return;
  }

  const data = { name, code, defaultMatGrade, contactInfo, isActive };
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
   SECTION 6 — USERS
   Collection: users (doc ID = Firebase Auth UID)
   ══════════════════════════════════════════════════════════════════════ */
const USER_ROLES = [
  'admin', 'plant_head', 'supervisor', 'store',
  'qc', 'quality_hod', 'maintenance', 'dispatch',
];
const USER_STAGES = [
  { v: 'general', l: 'General' }, { v: 'soft', l: 'Soft' },
  { v: 'hard', l: 'Hard' }, { v: 'ht', l: 'Heat Treatment' },
];

function renderUsers() {
  const q = searchQ.trim().toLowerCase();
  let list = S.users.filter(u =>
    !q || (u.name || '').toLowerCase().includes(q) || (u.email || '').toLowerCase().includes(q));
  list = list.slice().sort((a, b) => (a.name || '').localeCompare(b.name || ''));

  document.getElementById('section-content').innerHTML = `
    ${sectionHeader('Users', 'Add User', 'openUserModal()')}
    ${searchBox('Search users...')}
    ${recordCount(list.length)}
    ${list.length
      ? list.map(userRow).join('')
      : emptyState('ti-user', 'No users found', 'Add a user to get started, or adjust your search.')}
  `;
}

function userRow(u) {
  return `
    <div class="li" onclick="openUserModal('${u.id}')">
      <div class="li-ic" style="font-size:12px;font-weight:700">${initials(u.name || u.email || '?')}</div>
      <div class="li-body">
        <div class="li-name">${u.name || '—'}</div>
        <div class="li-sub">${u.email || '—'}</div>
      </div>
      <div class="li-right flex items-center gap-12">
        <span class="bdg bdg-n">${rlbl(u.role)}</span>
        <span class="bdg ${sbdg(u.stage)}">${slbl(u.stage)}</span>
        ${activeToggle('users', u.id, u.isActive !== false)}
      </div>
    </div>`;
}

function openUserModal(id) {
  const u = id ? S.users.find(x => x.id === id) : null;

  const passwordField = u ? '' : `
    <div class="f">
      <label for="uf-pass" class="f-req">Temporary Password</label>
      <input type="password" id="uf-pass" placeholder="Minimum 8 characters" autocomplete="new-password">
      <div class="text-xs text-muted mt-8">User can change this after first login</div>
    </div>`;

  const emailField = u
    ? `<div class="mono" style="padding:10px 13px;background:var(--sur2);border:1.5px solid var(--bdr-mid);border-radius:var(--rs)">${u.email}</div>
       <div class="text-xs text-muted mt-8">Email cannot be changed here</div>`
    : `<input type="email" id="uf-email" placeholder="user@indometaforge.com" autocomplete="off">`;

  const passNote = u
    ? `<div class="ibox"><i class="ti ti-info-circle" aria-hidden="true"></i>
        <span>To reset this user's password, use the Firebase Console (or add a reset-password feature).</span></div>`
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
        <label for="uf-stage">Stage</label>
        <select id="uf-stage">
          ${buildOpts(USER_STAGES, 'v', x => x.l, u?.stage || 'general')}
        </select>
      </div>
    </div>
    ${passNote}
    <div class="utog">
      <span class="utog-label">Active</span>
      <label class="tsw">
        <input type="checkbox" id="uf-active" ${u?.isActive !== false ? 'checked' : ''}>
        <span class="tsl"></span>
      </label>
    </div>

    ${modalActions('Save User', `saveUser(${u ? `'${u.id}'` : 'null'})`)}
  `);
}

async function saveUser(id) {
  const name  = getField('uf-name');
  const role  = document.getElementById('uf-role').value;
  const stage = document.getElementById('uf-stage').value;
  const isActive = document.getElementById('uf-active').checked;

  if (!name || !role) {
    showModalError('Full Name and Role are required.');
    return;
  }

  try {
    if (id) {
      /* Edit: name, role, stage, isActive only — never touch email/password/Auth */
      const before = S.users.find(x => x.id === id);
      const data = { name, role, stage, isActive };
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
      let uid;
      try {
        const cred = await secondaryAuth.createUserWithEmailAndPassword(email, pass);
        uid = cred.user.uid;
        await secondaryAuth.signOut();
      } finally {
        await secondaryApp.delete();
      }

      const data = { name, email, role, stage, isActive: true };
      await db.collection('users').doc(uid).set({
        ...data, createdAt: serverTS(), createdBy: S.sess.userId
      });
      await logAudit('CREATE_USER', 'MASTERS', uid, null, data);
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
   SECTION 7 — DEFECT CODES
   Collection: defectCodes (code, description, category, stage, isActive)
   May not exist yet — empty state allowed, never pre-populated.
   ══════════════════════════════════════════════════════════════════════ */
const DEFECT_CATEGORY_BADGE = {
  DIMENSIONAL:   'bdg-b',
  METALLURGICAL: 'bdg-r',
  VISUAL:        'bdg-a',
  PROCESS:       'bdg-n',
};
const DEFECT_STAGE_LABEL = { soft: 'Soft', hard: 'Hard', ht: 'Heat Treatment', any: 'Any Stage' };

function renderDefectCodes() {
  const q = searchQ.trim().toLowerCase();
  let list = S.defectCodes.filter(d =>
    !q || (d.description || '').toLowerCase().includes(q)
       || (d.code || '').toLowerCase().includes(q)
       || (d.category || '').toLowerCase().includes(q));
  list = list.slice().sort((a, b) =>
    (a.category || '').localeCompare(b.category || '') || (a.code || '').localeCompare(b.code || ''));

  document.getElementById('section-content').innerHTML = `
    ${sectionHeader('Defect Codes', 'Add Defect Code', 'openDefectModal()')}
    ${searchBox('Search defect codes...')}
    ${recordCount(list.length)}
    ${list.length
      ? list.map(defectRow).join('')
      : emptyState('ti-alert-triangle', 'No defect codes yet', 'Add a defect code to build the QC library.')}
  `;
}

function defectRow(d) {
  const cls = DEFECT_CATEGORY_BADGE[d.category] || 'bdg-gr';
  return `
    <div class="li" onclick="openDefectModal('${d.id}')">
      <div class="li-ic"><i class="ti ti-alert-triangle" aria-hidden="true"></i></div>
      <div class="li-body">
        <div class="li-name">${d.description || '—'}</div>
        <div class="li-sub">${d.code || '—'} · ${d.category || '—'}</div>
      </div>
      <div class="li-right flex items-center gap-12">
        <span class="bdg ${cls}">${d.category || '—'}</span>
        ${activeToggle('defectCodes', d.id, d.isActive !== false)}
      </div>
    </div>`;
}

function openDefectModal(id) {
  const d = id ? S.defectCodes.find(x => x.id === id) : null;

  openModal(`
    <div class="modal-title">${d ? 'Edit Defect Code' : 'Add Defect Code'}</div>
    <div id="modal-err"></div>

    <div class="f">
      <label for="df-code" class="f-req">Defect Code</label>
      <input type="text" id="df-code" value="${d?.code || ''}" style="text-transform:uppercase"
             oninput="this.value=this.value.toUpperCase()" placeholder="e.g. HC-01">
    </div>
    <div class="f">
      <label for="df-desc" class="f-req">Description</label>
      <input type="text" id="df-desc" value="${d?.description || ''}" placeholder="e.g. Surface Hardness Low">
    </div>
    <div class="row-2">
      <div class="f">
        <label for="df-cat" class="f-req">Category</label>
        <select id="df-cat">
          ${buildOpts([
            { v: 'DIMENSIONAL', l: 'Dimensional' }, { v: 'METALLURGICAL', l: 'Metallurgical' },
            { v: 'VISUAL', l: 'Visual' }, { v: 'PROCESS', l: 'Process' },
          ], 'v', x => x.l, d?.category || 'DIMENSIONAL')}
        </select>
      </div>
      <div class="f">
        <label for="df-stage" class="f-req">Applicable Stage</label>
        <select id="df-stage">
          ${buildOpts([
            { v: 'soft', l: 'Soft' }, { v: 'hard', l: 'Hard' },
            { v: 'ht', l: 'Heat Treatment' }, { v: 'any', l: 'Any Stage' },
          ], 'v', x => x.l, d?.stage || 'any')}
        </select>
      </div>
    </div>
    <div class="utog">
      <span class="utog-label">Active</span>
      <label class="tsw">
        <input type="checkbox" id="df-active" ${d?.isActive !== false ? 'checked' : ''}>
        <span class="tsl"></span>
      </label>
    </div>

    ${modalActions('Save Defect Code', `saveDefect(${d ? `'${d.id}'` : 'null'})`)}
  `);
}

async function saveDefect(id) {
  const code        = getField('df-code');
  const description = getField('df-desc');
  const category    = document.getElementById('df-cat').value;
  const stage       = document.getElementById('df-stage').value;
  const isActive    = document.getElementById('df-active').checked;

  if (!code || !description || !category || !stage) {
    showModalError('Defect Code, Description, Category and Applicable Stage are required.');
    return;
  }

  const data = { code, description, category, stage, isActive };
  try {
    if (id) {
      const before = S.defectCodes.find(x => x.id === id);
      await db.collection('defectCodes').doc(id).update(data);
      await logAudit('UPDATE_DEFECT_CODE', 'MASTERS', id, before, data);
    } else {
      const ref = await db.collection('defectCodes').add({
        ...data, createdAt: serverTS(), createdBy: S.sess.userId
      });
      await logAudit('CREATE_DEFECT_CODE', 'MASTERS', ref.id, null, data);
    }
    closeModal();
    await refreshCollection('defectCodes');
    renderSection();
    toast('Saved successfully');
  } catch (e) {
    showModalError(e.message);
  }
}

/* ══════════════════════════════════════════════════════════════════════
   SECTION 8 — SPARE PARTS
   Collection: spareParts (itemCode, name, unit, standardUnitCost, isActive)
   May not exist yet — empty state allowed, never pre-populated.
   ══════════════════════════════════════════════════════════════════════ */
function renderSpareParts() {
  const q = searchQ.trim().toLowerCase();
  let list = S.spareParts.filter(sp =>
    !q || (sp.name || '').toLowerCase().includes(q) || (sp.itemCode || '').toLowerCase().includes(q));
  list = list.slice().sort((a, b) => (a.name || '').localeCompare(b.name || ''));

  document.getElementById('section-content').innerHTML = `
    ${sectionHeader('Spare Parts', 'Add Spare Part', 'openSpareModal()')}
    ${searchBox('Search spare parts...')}
    ${recordCount(list.length)}
    ${list.length
      ? list.map(spareRow).join('')
      : emptyState('ti-tool', 'No spare parts yet', 'Add a spare part to build the maintenance catalog.')}
  `;
}

function spareRow(sp) {
  return `
    <div class="li" onclick="openSpareModal('${sp.id}')">
      <div class="li-ic"><i class="ti ti-tool" aria-hidden="true"></i></div>
      <div class="li-body">
        <div class="li-name">${sp.name || '—'}</div>
        <div class="li-sub">${sp.itemCode || '—'} · ${sp.unit || '—'} · ${fmtINR(sp.standardUnitCost)}</div>
      </div>
      <div class="li-right flex items-center gap-12">
        ${activeToggle('spareParts', sp.id, sp.isActive !== false)}
      </div>
    </div>`;
}

function openSpareModal(id) {
  const sp = id ? S.spareParts.find(x => x.id === id) : null;

  openModal(`
    <div class="modal-title">${sp ? 'Edit Spare Part' : 'Add Spare Part'}</div>
    <div id="modal-err"></div>

    <div class="f">
      <label for="spf-code" class="f-req">Item Code</label>
      <input type="text" id="spf-code" value="${sp?.itemCode || ''}" style="text-transform:uppercase"
             oninput="this.value=this.value.toUpperCase()" placeholder="e.g. BRG-6204">
    </div>
    <div class="f">
      <label for="spf-name" class="f-req">Spare Part Name</label>
      <input type="text" id="spf-name" value="${sp?.name || ''}" placeholder="e.g. Ball Bearing 6204">
    </div>
    <div class="row-2">
      <div class="f">
        <label for="spf-unit" class="f-req">Unit</label>
        <input type="text" id="spf-unit" value="${sp?.unit || ''}" placeholder="e.g. Nos, Metres, Kg">
      </div>
      <div class="f">
        <label for="spf-cost" class="f-req">Standard Cost (₹)</label>
        <input type="number" id="spf-cost" value="${sp?.standardUnitCost ?? ''}" min="0" step="0.01">
      </div>
    </div>
    <div class="utog">
      <span class="utog-label">Active</span>
      <label class="tsw">
        <input type="checkbox" id="spf-active" ${sp?.isActive !== false ? 'checked' : ''}>
        <span class="tsl"></span>
      </label>
    </div>

    ${modalActions('Save Spare Part', `saveSpare(${sp ? `'${sp.id}'` : 'null'})`)}
  `);
}

async function saveSpare(id) {
  const itemCode = getField('spf-code');
  const name = getField('spf-name');
  const unit = getField('spf-unit');
  const standardUnitCost = Number(getField('spf-cost'));
  const isActive = document.getElementById('spf-active').checked;

  if (!itemCode || !name || !unit || !getField('spf-cost')) {
    showModalError('Item Code, Spare Part Name, Unit and Standard Cost are required.');
    return;
  }

  const data = { itemCode, name, unit, standardUnitCost, isActive };
  try {
    if (id) {
      const before = S.spareParts.find(x => x.id === id);
      await db.collection('spareParts').doc(id).update(data);
      await logAudit('UPDATE_SPARE_PART', 'MASTERS', id, before, data);
    } else {
      const ref = await db.collection('spareParts').add({
        ...data, createdAt: serverTS(), createdBy: S.sess.userId
      });
      await logAudit('CREATE_SPARE_PART', 'MASTERS', ref.id, null, data);
    }
    closeModal();
    await refreshCollection('spareParts');
    renderSection();
    toast('Saved successfully');
  } catch (e) {
    showModalError(e.message);
  }
}

/* ══════════════════════════════════════════════════════════════════════
   SECTION 9 — SHIFTS
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
