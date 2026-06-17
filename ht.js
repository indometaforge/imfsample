/* ═══════════════════════════════════════════════════════════════════
   IMF ProTrack — Heat Treatment
   Furnace charge loading, FM/HT/01 process log, heat-code marriage,
   per-card yield audit.

   Collections read:
     htCharges  — furnace charge documents
     routeCards — TAG status validation on scan-in
   Collections written (writeBatch):
     htCharges  — charge create, process log update, complete
     routeCards — status update (soft_done→ht_queue→ht_done/scrapped),
                  heatCode write-once, currentQty yield adjustment
     scrapLedger — entry when HT yields 0 on a card
   ═══════════════════════════════════════════════════════════════════ */

'use strict';

/* ── Tabs ────────────────────────────────────────────────────────────── */
const TABS = [
  { key: 'hub',      icon: 'ti-layout-dashboard', label: 'Hub'      },
  { key: 'charges',  icon: 'ti-flame',            label: 'Charges'  },
  { key: 'process',  icon: 'ti-clipboard-list',   label: 'Process'  },
  { key: 'history',  icon: 'ti-history',           label: 'History'  },
];

const CHECKPOINTS = [
  { step: 1, label: 'Preheat'      },
  { step: 2, label: 'Austenitize'  },
  { step: 3, label: 'Quench Entry' },
  { step: 4, label: 'Quench Hold'  },
  { step: 5, label: 'Temper'       },
];

/* ── State ───────────────────────────────────────────────────────────── */
let _tab         = 'hub';
let _chargeMode  = 'list';  // 'list' | 'new'
let _selProcId   = '';      // charge selected in Process tab
let _procLogDirty = false;  // unsaved process log changes

let _newCharge = _emptyNewCharge();
function _emptyNewCharge() {
  return {
    furnaceId: '', furnaceName: '',
    heatCode: '',
    date: dateStr(),
    shift: 'A',
    tags: [],  // [{tagId, partId, partNo, partName, batchCode, qty, customerName}]
  };
}

const S_HT = {
  charges: [],
};

/* ── Boot ────────────────────────────────────────────────────────────── */
async function init() {
  try { await initShell(); } catch (e) {
    clearSess(); window.location.replace('index.html'); return;
  }
  await loadHTData();
  render();
  document.getElementById('loading-screen').style.display = 'none';
  document.getElementById('app').style.display = '';
}

async function loadHTData() {
  try {
    const snap = await db.collection('htCharges').orderBy('createdAt', 'desc').limit(200).get();
    S_HT.charges = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch (e) { console.warn('loadHTData:', e.message); }
}

async function refreshHT() {
  await loadHTData();
  render();
}

/* ── Shell render ────────────────────────────────────────────────────── */
function render() {
  const processing = S_HT.charges.filter(c => c.status === 'processing').length;

  const tabHtml = TABS.map(t => {
    const active = _tab === t.key;
    const badge  = t.key === 'hub' && processing > 0 ? processing : 0;
    return `
      <button onclick="switchTab('${t.key}')"
        style="flex:1;padding:8px 4px;border:none;
               background:${active ? 'var(--acc)' : 'var(--sur)'};
               color:${active ? '#fff' : 'var(--txt)'};
               border-radius:6px;font-size:12px;font-weight:700;cursor:pointer;
               display:flex;align-items:center;justify-content:center;gap:4px;transition:background .15s">
        <i class="ti ${t.icon}" style="font-size:13px"></i> ${t.label}
        ${badge > 0
          ? `<span style="background:var(--warn);color:#fff;border-radius:99px;padding:1px 6px;font-size:10px">${badge}</span>`
          : ''}
      </button>`;
  }).join('');

  document.getElementById('page-content').innerHTML = `
    <div style="padding-bottom:80px">
      <div style="display:flex;gap:4px;background:var(--sur);border-radius:8px;padding:4px;margin-bottom:14px">
        ${tabHtml}
      </div>
      <div id="tab-body"></div>
    </div>`;

  renderTab();
}

function switchTab(key) {
  _tab = key;
  if (key !== 'charges') _chargeMode = 'list';
  render();
}

function renderTab() {
  const el = document.getElementById('tab-body');
  if (!el) return;
  if      (_tab === 'hub')     renderHub();
  else if (_tab === 'charges') renderCharges();
  else if (_tab === 'process') renderProcess();
  else if (_tab === 'history') renderHistory();
}

/* ═══════════════════════════════════════════════════════════════════
   TAB: HUB
   ═══════════════════════════════════════════════════════════════════ */
function renderHub() {
  const el = document.getElementById('tab-body');
  if (!el) return;

  const processing = S_HT.charges.filter(c => c.status === 'processing');
  const today      = dateStr();
  const todayDone  = S_HT.charges.filter(c => c.status === 'completed' && c.completedAt &&
    (c.completedAt.toDate ? c.completedAt.toDate().toISOString().slice(0,10) : '') === today).length;

  el.innerHTML = `
    ${processing.length > 0 ? `
      <div style="background:var(--warn);color:#fff;border-radius:var(--rs);padding:12px 16px;margin-bottom:14px;
                  display:flex;align-items:center;gap:12px">
        <i class="ti ti-flame" style="font-size:22px;flex-shrink:0"></i>
        <div>
          <div style="font-weight:800">${processing.length} Charge${processing.length!==1?'s':''} In Furnace</div>
          <div style="font-size:12px;opacity:.85">Process logs pending · click to fill</div>
        </div>
        <button onclick="switchTab('process')"
          style="margin-left:auto;border:none;background:rgba(255,255,255,.2);color:#fff;
                 border-radius:6px;padding:7px 12px;cursor:pointer;font-size:12px;font-weight:700;white-space:nowrap">
          Process Log
        </button>
      </div>` : ''}

    <div class="stats-3" style="margin-bottom:14px">
      <div class="stat-card ${processing.length > 0 ? 'warn' : 'ok'}">
        <div class="stat-lbl">In Furnace</div>
        <div class="stat-val">${processing.length}</div>
        <div class="stat-sub">Active charges</div>
      </div>
      <div class="stat-card ok">
        <div class="stat-lbl">Done Today</div>
        <div class="stat-val">${todayDone}</div>
        <div class="stat-sub">${fmtDate(today)}</div>
      </div>
      <div class="stat-card">
        <div class="stat-lbl">Total Charges</div>
        <div class="stat-val">${S_HT.charges.length}</div>
        <div class="stat-sub">All time</div>
      </div>
    </div>

    <div style="display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap">
      <button class="btn btn-p" style="flex:1" onclick="switchTab('charges');htStartNew()">
        <i class="ti ti-plus"></i> New Charge
      </button>
      <button class="btn btn-s" style="flex:1" onclick="switchTab('process')">
        <i class="ti ti-clipboard-list"></i> Process Log
      </button>
    </div>

    ${processing.length > 0 ? `
      <div style="font-size:11px;font-weight:700;color:var(--txt-muted);letter-spacing:.06em;margin-bottom:8px">ACTIVE CHARGES</div>
      ${processing.map(chargeCardCompact).join('')}` : ''}

    <div style="display:flex;justify-content:flex-end;margin-top:6px">
      <button class="btn btn-s btn-sm" onclick="refreshHT()"><i class="ti ti-refresh"></i> Refresh</button>
    </div>`;
}

function chargeCardCompact(c) {
  const tagCount = (c.tags || []).length;
  const totalQty = (c.tags || []).reduce((s, t) => s + (t.qty || 0), 0);
  return `
    <div class="card" style="margin-bottom:8px;border-left:3px solid var(--warn);cursor:pointer"
      onclick="switchTab('process');_selProcId='${c.id}';render()">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px">
        <div>
          <div style="font-weight:800;font-family:monospace;font-size:13px">${c.heatCode || '—'}</div>
          <div style="font-size:11px;color:var(--txt-muted)">${tagCount} TAG${tagCount!==1?'s':''} · ${totalQty} pcs · ${fmtDate(c.date)}</div>
        </div>
        <span style="font-size:10px;font-weight:700;background:var(--warn);color:#fff;border-radius:4px;padding:2px 8px">IN FURNACE</span>
      </div>
    </div>`;
}

/* ═══════════════════════════════════════════════════════════════════
   TAB: CHARGES (list + new charge form)
   ═══════════════════════════════════════════════════════════════════ */
function renderCharges() {
  const el = document.getElementById('tab-body');
  if (!el) return;

  if (_chargeMode === 'new') { renderNewCharge(); return; }

  const canCreate = canDo('production') || S.sess?.role === 'admin' || S.sess?.stage === 'ht';
  const active    = S_HT.charges.filter(c => c.status !== 'completed');
  const done      = S_HT.charges.filter(c => c.status === 'completed');

  el.innerHTML = `
    <div style="display:flex;gap:8px;margin-bottom:12px;align-items:center">
      ${canCreate ? `<button class="btn btn-p" onclick="htStartNew()"><i class="ti ti-plus"></i> New Charge</button>` : ''}
      <button class="btn btn-s btn-sm" style="margin-left:auto" onclick="refreshHT()"><i class="ti ti-refresh"></i></button>
    </div>

    ${active.length ? `
      <div style="font-size:11px;font-weight:700;color:var(--txt-muted);letter-spacing:.06em;margin-bottom:8px">ACTIVE (${active.length})</div>
      ${active.map(chargeCard).join('')}` : ''}

    ${done.length ? `
      <div style="font-size:11px;font-weight:700;color:var(--txt-muted);letter-spacing:.06em;margin-bottom:8px;${active.length?'margin-top:16px':''}">RECENTLY COMPLETED (${Math.min(done.length,10)})</div>
      ${done.slice(0,10).map(chargeCard).join('')}` : ''}

    ${!active.length && !done.length ? `
      <div class="empty">
        <div class="empty-ic"><i class="ti ti-flame"></i></div>
        <h3>No charges yet</h3>
        <p>Create a furnace charge to get started.</p>
      </div>` : ''}`;
}

function chargeCard(c) {
  const tagCount  = (c.tags || []).length;
  const totalQty  = (c.tags || []).reduce((s, t) => s + (t.qty || 0), 0);
  const STATUS_COL = { processing: 'var(--warn)', completed: 'var(--ok)' };
  const STATUS_LBL = { processing: 'In Furnace', completed: 'Completed' };
  const colBdr     = STATUS_COL[c.status] || 'var(--bdr)';
  const canComplete = c.status === 'processing' && (canDo('production') || S.sess?.role === 'admin' || S.sess?.stage === 'ht');

  return `
    <div class="card" style="margin-bottom:10px;border-left:3px solid ${colBdr}">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px;margin-bottom:10px">
        <div>
          <div style="font-weight:800;font-size:15px;font-family:monospace">${c.heatCode || '—'}</div>
          <div style="font-size:11px;color:var(--txt-muted)">${c.furnaceName || c.furnaceId || '—'} · ${fmtDate(c.date)} · Shift ${c.shift || '—'}</div>
          <div style="font-size:11px;color:var(--txt-muted)">By ${c.createdByName || '—'}</div>
        </div>
        <span style="font-size:10px;font-weight:700;background:${colBdr};color:#fff;border-radius:4px;padding:3px 8px;text-transform:uppercase;flex-shrink:0">
          ${STATUS_LBL[c.status] || c.status}
        </span>
      </div>

      <!-- TAG summary -->
      <div style="background:var(--bg);border-radius:6px;padding:8px 10px;margin-bottom:10px">
        <div style="font-size:10px;font-weight:700;color:var(--txt-muted);letter-spacing:.06em;margin-bottom:6px">
          ${tagCount} TAG${tagCount!==1?'s':''} · ${totalQty} pcs total
        </div>
        ${(c.tags || []).slice(0,4).map(t => `
          <div style="display:flex;align-items:center;justify-content:space-between;font-size:12px;padding:3px 0">
            <span class="tag-uid" style="font-size:11px">${t.tagId}</span>
            <span style="color:var(--txt-muted)">${t.partName || '—'} · ${t.qty} pcs</span>
          </div>`).join('')}
        ${tagCount > 4 ? `<div style="font-size:11px;color:var(--txt-muted);margin-top:2px">+${tagCount-4} more TAGs</div>` : ''}
      </div>

      <!-- Process log summary -->
      ${c.processLog ? `
        <div style="font-size:11px;color:var(--ok);margin-bottom:10px">
          <i class="ti ti-circle-check"></i> Process log recorded · ${fmtTS(c.processLogAt)}
        </div>` : c.status === 'processing' ? `
        <div style="font-size:11px;color:var(--warn);margin-bottom:10px">
          <i class="ti ti-alert-circle"></i> Process log not yet filled
        </div>` : ''}

      ${c.status === 'completed' && c.completedByName ? `
        <div style="font-size:11px;color:var(--txt-muted);border-top:1px solid var(--bdr);padding-top:8px">
          Completed by ${c.completedByName} · ${fmtTS(c.completedAt)}
        </div>` : ''}

      <!-- Actions -->
      ${c.status === 'processing' ? `
        <div style="display:flex;gap:8px;margin-top:4px">
          <button class="btn btn-s" style="flex:1" onclick="_selProcId='${c.id}';switchTab('process')">
            <i class="ti ti-clipboard-list"></i> Process Log
          </button>
          ${canComplete ? `
            <button class="btn btn-ok" style="flex:1" onclick="openCompleteModal('${c.id}')">
              <i class="ti ti-circle-check"></i> Complete
            </button>` : ''}
        </div>` : ''}
    </div>`;
}

/* ── New Charge form ─────────────────────────────────────────────────── */
function htStartNew() {
  _newCharge = _emptyNewCharge();
  _chargeMode = 'new';
  _tab = 'charges';
  render();
}

function renderNewCharge() {
  const el = document.getElementById('tab-body');
  if (!el) return;

  const furnOpts  = (S.machines || [])
    .filter(m => (m.stage || '').toLowerCase() === 'ht' || (m.type || '').toLowerCase().includes('furnace'))
    .map(m => `<option value="${m.id}" ${_newCharge.furnaceId===m.id?'selected':''}>${m.code} — ${m.name}</option>`).join('');
  const allFurnOpts = furnOpts || (S.machines || []).map(m => `<option value="${m.id}">${m.code} — ${m.name}</option>`).join('');
  const totalQty  = _newCharge.tags.reduce((s, t) => s + (t.qty || 0), 0);

  el.innerHTML = `
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px">
      <button class="btn btn-s btn-sm" onclick="_chargeMode='list';render()"><i class="ti ti-arrow-left"></i> Back</button>
      <div style="font-size:14px;font-weight:800">New Furnace Charge</div>
    </div>

    <!-- Charge header -->
    <div class="card" style="margin-bottom:12px">
      <div style="font-size:11px;font-weight:700;color:var(--txt-muted);letter-spacing:.06em;margin-bottom:10px">CHARGE DETAILS</div>
      <div class="f">
        <label>Furnace / Machine <span style="color:var(--err)">*</span></label>
        <select id="ht-furnace" onchange="htReadHeader()" style="font-size:13px">
          <option value="">— Select furnace —</option>
          ${allFurnOpts}
        </select>
      </div>
      <div class="row-2">
        <div class="f">
          <label>Heat Code <span style="color:var(--err)">*</span></label>
          <input type="text" id="ht-heatcode" value="${_newCharge.heatCode}"
            placeholder="e.g. HC-240617-001"
            oninput="htReadHeader()"
            style="font-family:monospace;font-size:14px;font-weight:700;letter-spacing:.05em;text-transform:uppercase">
        </div>
        <div class="f">
          <label>Shift</label>
          <select id="ht-shift" onchange="htReadHeader()" style="font-size:13px">
            <option value="A" ${_newCharge.shift==='A'?'selected':''}>Shift A</option>
            <option value="B" ${_newCharge.shift==='B'?'selected':''}>Shift B</option>
            <option value="C" ${_newCharge.shift==='C'?'selected':''}>Shift C</option>
          </select>
        </div>
      </div>
      <div class="f">
        <label>Date</label>
        <input type="date" id="ht-date" value="${_newCharge.date}" oninput="htReadHeader()" style="font-size:13px">
      </div>
    </div>

    <!-- TAG scan -->
    <div class="card" style="margin-bottom:12px">
      <div style="font-size:11px;font-weight:700;color:var(--txt-muted);letter-spacing:.06em;margin-bottom:10px">
        SCAN TAGs INTO CHARGE
      </div>
      <div style="display:flex;gap:8px">
        <input type="text" id="ht-tag-input" placeholder="TAG UID…"
          style="flex:1;font-family:monospace;font-size:15px;text-transform:uppercase;letter-spacing:.05em"
          onkeydown="if(event.key==='Enter')htScanTag()">
        <button class="btn btn-s" onclick="openQrScanner(htOnScan,'Scan TAG for HT')" style="padding:10px 14px">
          <i class="ti ti-qrcode"></i>
        </button>
      </div>
      <button class="btn btn-s" style="width:100%;margin-top:8px" onclick="htScanTag()">
        <i class="ti ti-search"></i> Add TAG
      </button>
      <div id="ht-scan-err" style="display:none;margin-top:8px;background:#fef2f2;border:1px solid #fca5a5;
                                    border-radius:var(--rxs);padding:8px 12px;font-size:12px;font-weight:700;color:var(--err)"></div>
    </div>

    <!-- TAG list -->
    ${_newCharge.tags.length > 0 ? `
      <div class="card" style="margin-bottom:12px">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
          <div style="font-size:11px;font-weight:700;color:var(--txt-muted);letter-spacing:.06em">
            ${_newCharge.tags.length} TAG${_newCharge.tags.length!==1?'s':''} · ${totalQty} pcs
          </div>
          <button class="btn btn-s btn-sm" onclick="htClearTags()">
            <i class="ti ti-trash"></i> Clear All
          </button>
        </div>
        ${_newCharge.tags.map((t, i) => `
          <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 0;
                      border-bottom:1px solid var(--bdr);gap:8px">
            <div style="flex:1;min-width:0">
              <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
                <span class="tag-uid" style="font-size:11px">${t.tagId}</span>
                <span style="font-size:12px;font-weight:700">${t.partName || '—'}</span>
              </div>
              <div style="font-size:11px;color:var(--txt-muted)">${t.customerName || '—'} · Batch: ${t.batchCode || '—'} · ${t.qty} pcs</div>
            </div>
            <button onclick="htRemoveTag(${i})"
              style="border:none;background:none;color:var(--err);cursor:pointer;font-size:16px;flex-shrink:0;padding:2px 4px">
              <i class="ti ti-x"></i>
            </button>
          </div>`).join('')}
      </div>` : ''}

    <!-- Submit -->
    <div id="ht-submit-err" style="display:none;color:var(--err);font-size:12px;font-weight:700;margin-bottom:8px"></div>
    ${_newCharge.tags.length > 0 ? `
      <button class="btn btn-p" style="width:100%;font-size:15px;padding:14px" onclick="htSubmitCharge()">
        <i class="ti ti-flame"></i> Submit Charge (${_newCharge.tags.length} TAGs · ${totalQty} pcs)
      </button>` : ''}`;
}

function htReadHeader() {
  const furnEl = document.getElementById('ht-furnace');
  _newCharge.furnaceId = furnEl?.value || '';
  _newCharge.furnaceName = S.machines.find(m => m.id === _newCharge.furnaceId)?.name || '';
  _newCharge.heatCode = (document.getElementById('ht-heatcode')?.value || '').trim().toUpperCase();
  _newCharge.shift    = document.getElementById('ht-shift')?.value || 'A';
  _newCharge.date     = document.getElementById('ht-date')?.value  || dateStr();
}

function htOnScan(tagId) {
  const el = document.getElementById('ht-tag-input');
  if (el) el.value = tagId.toUpperCase();
  htScanTag();
}

async function htScanTag() {
  htReadHeader();
  const el    = document.getElementById('ht-tag-input');
  const tagId = (el?.value || '').trim().toUpperCase();
  if (!tagId) { toast('Enter or scan a TAG UID'); return; }

  const errEl = document.getElementById('ht-scan-err');
  if (errEl) errEl.style.display = 'none';

  if (_newCharge.tags.find(t => t.tagId === tagId)) {
    if (errEl) { errEl.textContent = `TAG ${tagId} already added to this charge`; errEl.style.display = ''; } return;
  }

  try {
    const card = await fetchRouteCard(tagId);
    if (!card) {
      if (errEl) { errEl.textContent = `TAG ${tagId} not found`; errEl.style.display = ''; } return;
    }
    if (card.status !== 'soft_done') {
      const LBLS = { store_issued:'Store Issued', soft_wip:'Soft WIP', ht_queue:'Already in HT Queue',
                     ht_done:'Already HT Done', hard_wip:'Hard Machining', qc_pending:'QC Pending',
                     qc_cleared:'QC Cleared', dispatched:'Dispatched', scrapped:'Scrapped' };
      if (errEl) { errEl.textContent = `TAG ${tagId} status is "${LBLS[card.status]||card.status}" — must be soft_done to load into HT`; errEl.style.display = ''; } return;
    }
    if (card.heatCode) {
      if (errEl) { errEl.textContent = `TAG ${tagId} already has heat code "${card.heatCode}" — cannot be re-charged`; errEl.style.display = ''; } return;
    }

    _newCharge.tags.push({
      tagId,
      partId:       card.partId,
      partNo:       card.partNo       || '',
      partName:     card.partName     || '',
      batchCode:    card.batchCode    || '',
      customerName: card.customerName || '',
      qty:          card.currentQty   || 0,
    });

    if (el) el.value = '';
    renderNewCharge();
  } catch (e) {
    if (errEl) { errEl.textContent = 'Error: ' + e.message; errEl.style.display = ''; }
  }
}

function htRemoveTag(idx) {
  _newCharge.tags.splice(idx, 1);
  renderNewCharge();
}

function htClearTags() {
  _newCharge.tags = [];
  renderNewCharge();
}

async function htSubmitCharge() {
  htReadHeader();
  const errEl = document.getElementById('ht-submit-err');
  if (!_newCharge.furnaceId) { if (errEl) { errEl.textContent = 'Select a furnace'; errEl.style.display = ''; } return; }
  if (!_newCharge.heatCode)  { if (errEl) { errEl.textContent = 'Enter the heat code'; errEl.style.display = ''; } return; }
  if (!_newCharge.tags.length) { if (errEl) { errEl.textContent = 'Scan at least one TAG'; errEl.style.display = ''; } return; }

  // Confirm
  const totalQty = _newCharge.tags.reduce((s, t) => s + (t.qty || 0), 0);
  openModal(`
    <div class="modal-handle"></div>
    <div class="modal-title">Confirm Furnace Charge</div>
    <div class="kv-list" style="margin-bottom:14px">
      <div class="kv-row"><span class="kv-key">Heat Code</span><span class="kv-val" style="font-family:monospace;font-weight:800">${_newCharge.heatCode}</span></div>
      <div class="kv-row"><span class="kv-key">Furnace</span><span class="kv-val">${_newCharge.furnaceName || _newCharge.furnaceId}</span></div>
      <div class="kv-row"><span class="kv-key">Date / Shift</span><span class="kv-val">${fmtDate(_newCharge.date)} · Shift ${_newCharge.shift}</span></div>
      <div class="kv-row"><span class="kv-key">TAGs</span><span class="kv-val">${_newCharge.tags.length}</span></div>
      <div class="kv-row"><span class="kv-key">Total Qty</span><span class="kv-val" style="font-size:18px;font-weight:900">${totalQty} pcs</span></div>
    </div>
    <div style="background:#fef9c3;border:1px solid #fde68a;border-radius:var(--rs);padding:10px 14px;font-size:12px;font-weight:700;color:#78350f;margin-bottom:14px">
      <i class="ti ti-info-circle"></i> Heat code <strong>${_newCharge.heatCode}</strong> will be permanently written to all ${_newCharge.tags.length} TAGs. This cannot be changed.
    </div>
    <div style="display:flex;gap:8px">
      <button class="btn btn-s" style="flex:1" onclick="closeModal()">Cancel</button>
      <button class="btn btn-p" style="flex:1" onclick="closeModal();saveCharge()">
        <i class="ti ti-flame"></i> Load &amp; Start
      </button>
    </div>`);
}

async function saveCharge() {
  const now = serverTS();
  try {
    const batch   = db.batch();
    const chargeRef = db.collection('htCharges').doc();

    // Create charge doc
    batch.set(chargeRef, {
      heatCode:    _newCharge.heatCode,
      furnaceId:   _newCharge.furnaceId,
      furnaceName: _newCharge.furnaceName,
      date:        _newCharge.date,
      shift:       _newCharge.shift,
      status:      'processing',
      tags:        _newCharge.tags,
      processLog:  null,
      processLogBy: '', processLogByName: '', processLogAt: null,
      dotPunch:    false,
      completedBy: '', completedByName: '', completedAt: null,
      createdBy:    S.sess.userId,
      createdByName: S.sess.name,
      createdAt:   now,
    });

    // Update each TAG: status → ht_queue, heatCode written (write-once)
    for (const t of _newCharge.tags) {
      batch.update(db.collection('routeCards').doc(t.tagId), {
        status:    'ht_queue',
        heatCode:  _newCharge.heatCode,
        htChargeId: chargeRef.id,
        updatedAt: now,
      });
    }

    await batch.commit();
    await logAudit('HT_CHARGE_CREATED', 'HT', chargeRef.id, null, {
      heatCode: _newCharge.heatCode, tagCount: _newCharge.tags.length,
    });

    toast(`Charge loaded ✓ · ${_newCharge.tags.length} TAGs · Heat code: ${_newCharge.heatCode}`);
    _newCharge    = _emptyNewCharge();
    _chargeMode   = 'list';
    _selProcId    = chargeRef.id;
    await refreshHT();
    switchTab('process');
  } catch (e) {
    console.error('saveCharge:', e);
    toast('Error creating charge: ' + e.message);
  }
}

/* ═══════════════════════════════════════════════════════════════════
   TAB: PROCESS LOG (FM/HT/01)
   ═══════════════════════════════════════════════════════════════════ */
function renderProcess() {
  const el = document.getElementById('tab-body');
  if (!el) return;

  const active = S_HT.charges.filter(c => c.status === 'processing');
  if (!active.length) {
    el.innerHTML = `
      <div class="empty">
        <div class="empty-ic"><i class="ti ti-clipboard-list"></i></div>
        <h3>No active charges</h3>
        <p>Load a furnace charge first, then fill the process log here.</p>
      </div>
      <button class="btn btn-p" style="width:100%;margin-top:12px" onclick="htStartNew()">
        <i class="ti ti-plus"></i> New Charge
      </button>`;
    return;
  }

  if (!_selProcId || !active.find(c => c.id === _selProcId)) {
    _selProcId = active[0].id;
  }
  const charge = active.find(c => c.id === _selProcId);
  const pl     = charge.processLog || {};

  const chargeOpts = active.map(c =>
    `<option value="${c.id}" ${c.id===_selProcId?'selected':''}>${c.heatCode} · ${c.tags.length} TAGs · ${fmtDate(c.date)}</option>`
  ).join('');

  el.innerHTML = `
    <div class="f" style="margin-bottom:12px">
      <label style="font-size:11px;font-weight:700;color:var(--txt-muted)">SELECT CHARGE</label>
      <select onchange="_selProcId=this.value;render()" style="font-size:14px;font-weight:700">
        ${chargeOpts}
      </select>
    </div>

    <!-- Charge info -->
    <div style="background:var(--bg);border-radius:var(--rs);padding:10px 14px;margin-bottom:14px;
                display:flex;align-items:center;gap:12px">
      <i class="ti ti-flame" style="font-size:22px;color:var(--warn)"></i>
      <div>
        <div style="font-weight:800;font-family:monospace;font-size:15px">${charge.heatCode}</div>
        <div style="font-size:11px;color:var(--txt-muted)">${charge.furnaceName||charge.furnaceId} · ${charge.tags.length} TAG${charge.tags.length!==1?'s':''} · ${charge.tags.reduce((s,t)=>s+t.qty,0)} pcs</div>
      </div>
      ${charge.processLog ? `<span style="margin-left:auto;font-size:11px;font-weight:700;color:var(--ok)"><i class="ti ti-circle-check"></i> Logged</span>` : ''}
    </div>

    <!-- FM/HT/01 Form -->
    <div class="card" style="margin-bottom:12px">
      <div style="font-size:12px;font-weight:800;color:var(--imf-navy);letter-spacing:.04em;margin-bottom:14px;
                  border-bottom:2px solid var(--imf-navy);padding-bottom:8px">
        FM/HT/01 — PROCESS LOG
      </div>

      <!-- Prewash -->
      <div style="margin-bottom:14px">
        <div style="font-size:11px;font-weight:700;color:var(--txt-muted);letter-spacing:.06em;margin-bottom:8px">PREWASH</div>
        <div class="row-2">
          <div class="f">
            <label>Prewash Done?</label>
            <select id="pl-prewash-done" style="font-size:13px">
              <option value="yes" ${pl.prewashDone?'selected':''}>Yes</option>
              <option value="no" ${pl.prewashDone===false?'selected':''}>No / Skipped</option>
            </select>
          </div>
          <div class="f">
            <label>Prewash Temp (°C)</label>
            <input type="number" id="pl-prewash-temp" value="${pl.prewashTemp||''}" placeholder="e.g. 75" style="font-size:13px">
          </div>
        </div>
        <div class="f">
          <label>Notes</label>
          <input type="text" id="pl-prewash-notes" value="${pl.prewashNotes||''}" placeholder="Prewash observations…" style="font-size:13px">
        </div>
      </div>

      <!-- Wash -->
      <div style="border-top:1px solid var(--bdr);padding-top:12px;margin-bottom:14px">
        <div style="font-size:11px;font-weight:700;color:var(--txt-muted);letter-spacing:.06em;margin-bottom:8px">WASH</div>
        <div class="row-3">
          <div class="f">
            <label>Temp (°C)</label>
            <input type="number" id="pl-wash-temp" value="${pl.washTemp||''}" placeholder="e.g. 80" style="font-size:13px">
          </div>
          <div class="f">
            <label>pH</label>
            <input type="number" id="pl-wash-ph" step="0.1" value="${pl.washPH||''}" placeholder="e.g. 7.5" style="font-size:13px">
          </div>
          <div class="f">
            <label>Duration (min)</label>
            <input type="number" id="pl-wash-dur" value="${pl.washDuration||''}" placeholder="e.g. 15" style="font-size:13px">
          </div>
        </div>
        <div class="f">
          <label>Wash Notes</label>
          <input type="text" id="pl-wash-notes" value="${pl.washNotes||''}" placeholder="Solution type, observations…" style="font-size:13px">
        </div>
      </div>

      <!-- Temperature checkpoints -->
      <div style="border-top:1px solid var(--bdr);padding-top:12px;margin-bottom:14px">
        <div style="font-size:11px;font-weight:700;color:var(--txt-muted);letter-spacing:.06em;margin-bottom:8px">TEMPERATURE CHECKPOINTS</div>
        ${CHECKPOINTS.map(cp => {
          const saved = (pl.checkpoints || [])[cp.step - 1] || {};
          return `
            <div style="background:var(--bg);border-radius:6px;padding:8px 10px;margin-bottom:6px">
              <div style="font-size:11px;font-weight:700;color:var(--txt-mid);margin-bottom:6px">
                Step ${cp.step}: ${cp.label}
              </div>
              <div class="row-3">
                <div class="f">
                  <label>Set Temp (°C)</label>
                  <input type="number" id="pl-cp${cp.step}-set" value="${saved.setTemp||''}" placeholder="—" style="font-size:12px">
                </div>
                <div class="f">
                  <label>Actual (°C)</label>
                  <input type="number" id="pl-cp${cp.step}-act" value="${saved.actualTemp||''}" placeholder="—" style="font-size:12px">
                </div>
                <div class="f">
                  <label>Time</label>
                  <input type="time" id="pl-cp${cp.step}-time" value="${saved.time||''}" style="font-size:12px">
                </div>
              </div>
              <div class="f" style="margin-top:4px">
                <label>Within tolerance?</label>
                <select id="pl-cp${cp.step}-ok" style="font-size:12px">
                  <option value="yes" ${saved.ok!==false?'selected':''}>✓ Yes</option>
                  <option value="no"  ${saved.ok===false?'selected':''}>✗ No — note below</option>
                </select>
              </div>
            </div>`;
        }).join('')}
      </div>

      <!-- Furnace parameters -->
      <div style="border-top:1px solid var(--bdr);padding-top:12px;margin-bottom:14px">
        <div style="font-size:11px;font-weight:700;color:var(--txt-muted);letter-spacing:.06em;margin-bottom:8px">FURNACE PARAMETERS</div>
        <div class="row-2">
          <div class="f">
            <label>Atmosphere</label>
            <input type="text" id="pl-atm" value="${pl.atmosphere||''}" placeholder="e.g. Endothermic, N₂+CH₄" style="font-size:13px">
          </div>
          <div class="f">
            <label>Hardness Target (HRC)</label>
            <input type="number" id="pl-hard" value="${pl.hardnessTarget||''}" placeholder="e.g. 58–62" style="font-size:13px">
          </div>
        </div>
        <div class="row-2">
          <div class="f">
            <label>Case Depth Target (mm)</label>
            <input type="number" id="pl-case" step="0.01" value="${pl.caseDepthTarget||''}" placeholder="e.g. 0.8" style="font-size:13px">
          </div>
          <div class="f">
            <label>Dot Punch Done?</label>
            <select id="pl-dotpunch" style="font-size:13px">
              <option value="yes" ${charge.dotPunch?'selected':''}>Yes</option>
              <option value="no"  ${!charge.dotPunch?'selected':''}>No / Not Required</option>
            </select>
          </div>
        </div>
      </div>

      <!-- General notes -->
      <div class="f" style="margin-bottom:12px">
        <label>General Observations / Notes</label>
        <textarea id="pl-notes" rows="2" placeholder="Any additional observations…" style="resize:vertical;font-size:13px">${pl.notes||''}</textarea>
      </div>

      <div style="display:flex;gap:8px">
        <button class="btn btn-s" style="flex:1" onclick="saveProcessLog('${charge.id}')">
          <i class="ti ti-device-floppy"></i> Save Log
        </button>
        <button class="btn btn-ok" style="flex:1" onclick="openCompleteModal('${charge.id}')">
          <i class="ti ti-circle-check"></i> Complete Charge
        </button>
      </div>
    </div>`;
}

function readProcessLog() {
  return {
    prewashDone:   document.getElementById('pl-prewash-done')?.value === 'yes',
    prewashTemp:   document.getElementById('pl-prewash-temp')?.value || '',
    prewashNotes:  document.getElementById('pl-prewash-notes')?.value || '',
    washTemp:      document.getElementById('pl-wash-temp')?.value || '',
    washPH:        document.getElementById('pl-wash-ph')?.value || '',
    washDuration:  document.getElementById('pl-wash-dur')?.value || '',
    washNotes:     document.getElementById('pl-wash-notes')?.value || '',
    checkpoints:   CHECKPOINTS.map(cp => ({
      step:        cp.step,
      label:       cp.label,
      setTemp:     document.getElementById(`pl-cp${cp.step}-set`)?.value  || '',
      actualTemp:  document.getElementById(`pl-cp${cp.step}-act`)?.value  || '',
      time:        document.getElementById(`pl-cp${cp.step}-time`)?.value || '',
      ok:          document.getElementById(`pl-cp${cp.step}-ok`)?.value !== 'no',
    })),
    atmosphere:      document.getElementById('pl-atm')?.value   || '',
    hardnessTarget:  document.getElementById('pl-hard')?.value  || '',
    caseDepthTarget: document.getElementById('pl-case')?.value  || '',
    notes:           document.getElementById('pl-notes')?.value || '',
  };
}

async function saveProcessLog(chargeId) {
  const pl  = readProcessLog();
  const dot = document.getElementById('pl-dotpunch')?.value === 'yes';
  try {
    await db.collection('htCharges').doc(chargeId).update({
      processLog:       pl,
      dotPunch:         dot,
      processLogBy:     S.sess.userId,
      processLogByName: S.sess.name,
      processLogAt:     serverTS(),
      updatedAt:        serverTS(),
    });
    await logAudit('HT_PROCESS_LOG', 'HT', chargeId, null, { heatCode: S_HT.charges.find(c=>c.id===chargeId)?.heatCode });
    toast('Process log saved ✓');
    await refreshHT();
  } catch (e) { toast('Error: ' + e.message); }
}

/* ═══════════════════════════════════════════════════════════════════
   COMPLETE CHARGE — per-card yield audit
   ═══════════════════════════════════════════════════════════════════ */
function openCompleteModal(chargeId) {
  // Save process log first if we're in the process tab
  if (_tab === 'process') {
    const logEl = document.getElementById('pl-prewash-done');
    if (logEl) saveProcessLog(chargeId);  // auto-save before completing
  }

  const charge = S_HT.charges.find(c => c.id === chargeId);
  if (!charge) return;

  const tagRows = (charge.tags || []).map((t, i) => `
    <div style="background:var(--bg);border-radius:6px;padding:8px 10px;margin-bottom:6px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
        <div>
          <span class="tag-uid" style="font-size:11px">${t.tagId}</span>
          <span style="font-size:12px;color:var(--txt-muted);margin-left:6px">${t.partName||'—'} · Loaded: ${t.qty} pcs</span>
        </div>
      </div>
      <div class="row-2">
        <div class="f">
          <label>Yielded (passed)</label>
          <input type="number" id="yld-ok-${i}" min="0" max="${t.qty}" value="${t.qty}"
            oninput="htUpdateYield(${i},${t.qty})"
            style="font-size:14px;font-weight:700;text-align:center;color:var(--ok)">
        </div>
        <div class="f">
          <label>Failed / Scrapped</label>
          <div id="yld-fail-${i}"
            style="padding:10px;background:#fef2f2;border:1.5px solid #fca5a5;border-radius:var(--rxs);
                   font-size:16px;font-weight:900;text-align:center;color:var(--err)">0</div>
        </div>
      </div>
    </div>`).join('');

  openModal(`
    <div class="modal-handle"></div>
    <div class="modal-title">Complete Charge — Yield Audit</div>
    <div style="background:var(--bg);border-radius:var(--rs);padding:10px 14px;margin-bottom:12px">
      <div style="font-weight:800;font-family:monospace">${charge.heatCode}</div>
      <div style="font-size:11px;color:var(--txt-muted)">${charge.furnaceName||charge.furnaceId} · ${fmtDate(charge.date)}</div>
    </div>
    <div style="font-size:11px;font-weight:700;color:var(--txt-muted);letter-spacing:.06em;margin-bottom:8px">PER-TAG YIELD</div>
    <div style="max-height:50vh;overflow-y:auto;margin-bottom:12px">${tagRows}</div>
    <div style="background:#fef2f2;border:1px solid #fca5a5;border-radius:var(--rs);padding:10px 14px;
                font-size:12px;font-weight:700;color:var(--err);margin-bottom:14px">
      <i class="ti ti-alert-triangle"></i> Route card statuses and quantities will be permanently updated.
    </div>
    <div id="complete-modal-err" style="display:none;color:var(--err);font-size:12px;font-weight:700;margin-bottom:8px"></div>
    <div style="display:flex;gap:8px">
      <button class="btn btn-s" style="flex:1" onclick="closeModal()">Cancel</button>
      <button class="btn btn-ok" style="flex:1" onclick="finalizeCharge('${chargeId}')">
        <i class="ti ti-circle-check"></i> Finalise
      </button>
    </div>`);
}

function htUpdateYield(idx, total) {
  const ok  = Math.min(parseInt(document.getElementById(`yld-ok-${idx}`)?.value || '0') || 0, total);
  const fail = Math.max(0, total - ok);
  const failEl = document.getElementById(`yld-fail-${idx}`);
  if (failEl) {
    failEl.textContent = fail;
    failEl.style.background = fail > 0 ? '#fef2f2' : '#f0fdf4';
    failEl.style.borderColor = fail > 0 ? '#fca5a5' : '#86efac';
    failEl.style.color = fail > 0 ? 'var(--err)' : 'var(--ok)';
  }
}

async function finalizeCharge(chargeId) {
  const charge = S_HT.charges.find(c => c.id === chargeId);
  if (!charge) return;

  // Read yield inputs
  const yields = (charge.tags || []).map((t, i) => {
    const yielded = Math.min(parseInt(document.getElementById(`yld-ok-${i}`)?.value || '0') || 0, t.qty);
    return { ...t, yielded, failed: t.qty - yielded };
  });

  const errEl = document.getElementById('complete-modal-err');
  if (yields.some(y => y.yielded < 0 || y.yielded > y.qty)) {
    if (errEl) { errEl.textContent = 'Invalid yield values'; errEl.style.display = ''; } return;
  }

  try {
    const batch = db.batch();
    const now   = serverTS();

    for (const y of yields) {
      const cardRef = db.collection('routeCards').doc(y.tagId);
      if (y.yielded === 0) {
        // Fully failed — scrapped
        batch.update(cardRef, {
          status:    'scrapped',
          currentQty: 0,
          htFailed:  y.failed,
          htYielded: 0,
          updatedAt: now,
        });
        // Scrap ledger entry
        batch.set(db.collection('scrapLedger').doc(), {
          tagId:       y.tagId,
          batchCode:   y.batchCode || '',
          heatCode:    charge.heatCode,
          partId:      y.partId,
          partNo:      y.partNo    || '',
          partName:    y.partName  || '',
          customerName: y.customerName || '',
          qtyRejected: y.failed,
          defectDescription: 'Heat treatment failure',
          stage:  'ht',
          inspectedBy:     S.sess.userId,
          inspectedByName: S.sess.name,
          date:      charge.date,
          createdAt: now,
        });
      } else {
        batch.update(cardRef, {
          status:     'ht_done',
          currentQty: y.yielded,
          htFailed:   y.failed,
          htYielded:  y.yielded,
          updatedAt:  now,
        });
      }
    }

    // Update htCharges doc
    batch.update(db.collection('htCharges').doc(chargeId), {
      status:         'completed',
      tags:           yields,
      completedBy:    S.sess.userId,
      completedByName: S.sess.name,
      completedAt:    now,
      updatedAt:      now,
    });

    await batch.commit();
    await logAudit('HT_CHARGE_COMPLETED', 'HT', chargeId, { status: 'processing' }, {
      status: 'completed', heatCode: charge.heatCode,
      totalYielded: yields.reduce((s, y) => s + y.yielded, 0),
    });

    const totalYielded = yields.reduce((s, y) => s + y.yielded, 0);
    const totalFailed  = yields.reduce((s, y) => s + y.failed,  0);
    toast(`Charge completed ✓ · Yielded: ${totalYielded} · Failed: ${totalFailed}`);
    closeModal();
    await refreshHT();
    switchTab('history');
  } catch (e) {
    console.error('finalizeCharge:', e);
    toast('Error: ' + e.message);
  }
}

/* ═══════════════════════════════════════════════════════════════════
   TAB: HISTORY
   ═══════════════════════════════════════════════════════════════════ */
function renderHistory() {
  const el = document.getElementById('tab-body');
  if (!el) return;

  const done = S_HT.charges.filter(c => c.status === 'completed');
  if (!done.length) {
    el.innerHTML = `
      <div class="empty">
        <div class="empty-ic"><i class="ti ti-history"></i></div>
        <h3>No completed charges</h3>
        <p>Completed furnace charges will appear here.</p>
      </div>`;
    return;
  }

  el.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
      <div style="font-size:12px;color:var(--txt-muted)">${done.length} completed charge${done.length!==1?'s':''}</div>
      <button class="btn btn-s btn-sm" onclick="refreshHT()"><i class="ti ti-refresh"></i></button>
    </div>
    ${done.map(historyChargeCard).join('')}`;
}

function historyChargeCard(c) {
  const yields    = (c.tags || []);
  const totalIn   = yields.reduce((s, t) => s + (t.qty || 0), 0);
  const totalOut  = yields.reduce((s, t) => s + (t.yielded ?? t.qty ?? 0), 0);
  const totalFail = totalIn - totalOut;
  const yieldPct  = totalIn > 0 ? Math.round((totalOut / totalIn) * 100) : 100;
  const yldCol    = yieldPct >= 95 ? 'var(--ok)' : yieldPct >= 80 ? 'var(--warn)' : 'var(--err)';

  return `
    <div class="card" style="margin-bottom:10px;border-left:3px solid var(--ok)">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px;margin-bottom:10px">
        <div>
          <div style="font-weight:900;font-size:16px;font-family:monospace">${c.heatCode || '—'}</div>
          <div style="font-size:11px;color:var(--txt-muted)">${c.furnaceName || c.furnaceId || '—'} · ${fmtDate(c.date)} · Shift ${c.shift||'—'}</div>
          <div style="font-size:11px;color:var(--txt-muted)">Completed by ${c.completedByName||'—'} · ${fmtTS(c.completedAt)}</div>
        </div>
        <div style="text-align:right;flex-shrink:0">
          <div style="font-size:22px;font-weight:900;color:${yldCol};line-height:1">${yieldPct}%</div>
          <div style="font-size:10px;color:var(--txt-muted)">yield</div>
        </div>
      </div>

      <div class="stats-3" style="margin-bottom:10px">
        <div class="stat-card">
          <div class="stat-lbl">Loaded</div><div class="stat-val">${totalIn}</div>
        </div>
        <div class="stat-card ok">
          <div class="stat-lbl">Yielded</div><div class="stat-val">${totalOut}</div>
        </div>
        <div class="stat-card ${totalFail > 0 ? 'err' : ''}">
          <div class="stat-lbl">Failed</div><div class="stat-val">${totalFail}</div>
        </div>
      </div>

      <!-- TAGs -->
      <div style="font-size:10px;font-weight:700;color:var(--txt-muted);letter-spacing:.06em;margin-bottom:4px">TAGs</div>
      ${yields.map(t => {
        const yld  = t.yielded ?? t.qty ?? 0;
        const fail = (t.qty || 0) - yld;
        return `
          <div style="display:flex;align-items:center;justify-content:space-between;font-size:11px;padding:4px 0;border-bottom:1px solid var(--bdr)">
            <span class="tag-uid" style="font-size:10px">${t.tagId}</span>
            <span style="color:var(--txt-muted)">${t.partName||'—'}</span>
            <span style="font-weight:700;color:${fail>0?'var(--err)':'var(--ok)'}">✓${yld} ${fail>0?`/ ✗${fail}`:''}</span>
          </div>`;
      }).join('')}

      ${c.dotPunch ? `<div style="margin-top:8px;font-size:11px;font-weight:700;color:var(--acc)"><i class="ti ti-circle-dot"></i> Dot punch completed</div>` : ''}
      ${c.processLog ? `<div style="margin-top:4px;font-size:11px;color:var(--ok)"><i class="ti ti-clipboard-check"></i> FM/HT/01 process log recorded</div>` : ''}
    </div>`;
}

/* ── Boot ────────────────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', init);
