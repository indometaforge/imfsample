/* ═══════════════════════════════════════════════════════════════════
   IMF ProTrack — Quality Control
   TAG scan → final-op gate → 3-bucket disposition → stream lock-in.

   Collections read:
     routeCards      — card status + opHistory
     setupApprovals  — pending setups (QC HOD workspace)
     qcInspections   — past inspection records
   Collections written:
     routeCards      — status/qty update, opHistory append
     qcInspections   — new inspection record
     scrapLedger     — one entry per scrap event
   ═══════════════════════════════════════════════════════════════════ */

'use strict';

/* ── Tabs ────────────────────────────────────────────────────────────── */
const TABS = [
  { key: 'inspect', icon: 'ti-scan',          label: 'Inspect'  },
  { key: 'iqc',     icon: 'ti-microscope',    label: 'IQC'      },
  { key: 'setup',   icon: 'ti-settings-cog',  label: 'Setups'   },
  { key: 'history', icon: 'ti-history',        label: 'History'  },
  { key: 'cleared', icon: 'ti-circle-check',  label: 'Cleared'  },
];

/* ── State ───────────────────────────────────────────────────────────── */
let _tab      = 'inspect';
let _inspCard = null;   // route card currently loaded for inspection
let _iqcFilt  = 'pending'; // 'pending' | 'history'

const IQC_LABEL = { pending: 'IQC Pending', accepted: 'Accepted', conditional: 'Conditional', rejected: 'Rejected' };
const IQC_BADGE = { pending: 'bdg-a', accepted: 'bdg-g', conditional: 'bdg-b', rejected: 'bdg-r' };

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

const S_QC = {
  setupApprovals: [],
  inspections:    [],
  clearedCards:   [],
  inward:         [],
  iqcResults:     [],
};

/* ── Boot ────────────────────────────────────────────────────────────── */
async function init() {
  window.onGlobalScan = qcFetchTag;
  try { await initShell(); } catch (e) {
    clearSess(); window.location.replace('index.html'); return;
  }
  await loadQCData();
  render();
  document.getElementById('loading-screen').style.display = 'none';
  document.getElementById('app').style.display = '';
}

async function loadQCData() {
  try {
    const [saSnap, insnSnap, clearedSnap, inwSnap, iqcSnap] = await Promise.all([
      db.collection('setupApprovals').orderBy('createdAt', 'desc').limit(200).get(),
      db.collection('qcInspections').orderBy('createdAt', 'desc').limit(100).get(),
      db.collection('routeCards').where('status', '==', 'qc_cleared').get(),
      db.collection('inward').get(),
      db.collection('iqcResults').get(),
    ]);
    S_QC.setupApprovals = saSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    S_QC.inspections    = insnSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    S_QC.clearedCards   = clearedSnap.docs.map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0));
    S_QC.inward         = inwSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    S_QC.iqcResults     = iqcSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch (e) { console.warn('loadQCData:', e.message); }
}

async function refreshQC() {
  await loadQCData();
  render();
}

/* ── Shell render ────────────────────────────────────────────────────── */
function render() {
  const pendingSA      = S_QC.setupApprovals.filter(s => s.status === 'pending').length;
  const pendingCleared = S_QC.clearedCards.length;
  const pendingIQC     = S_QC.inward.filter(r => r.iqcStatus === 'pending').length;

  const tabHtml = TABS.map(t => {
    const active  = _tab === t.key;
    const badge   = t.key === 'setup' ? pendingSA : t.key === 'cleared' ? pendingCleared : t.key === 'iqc' ? pendingIQC : 0;
    return `
      <button class="tab${active ? ' active' : ''}" role="tab" aria-selected="${active}"
        onclick="switchTab('${t.key}')">
        <i class="ti ${t.icon}" aria-hidden="true"></i>
        <span>${t.label}</span>
        ${badge > 0
          ? `<span class="bdg bdg-a" style="padding:1px 6px;font-size:9px;margin-left:4px">${badge}</span>`
          : ''}
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
  if      (_tab === 'inspect') renderInspect();
  else if (_tab === 'iqc')     renderIQC();
  else if (_tab === 'setup')   renderSetupApprovals();
  else if (_tab === 'history') renderHistory();
  else if (_tab === 'cleared') renderCleared();
}

/* ═══════════════════════════════════════════════════════════════════
   TAB: INSPECT
   ═══════════════════════════════════════════════════════════════════ */
function renderInspect() {
  const el = document.getElementById('tab-body');
  if (!el) return;

  el.innerHTML = `
    <div>
      <div class="imf-card" style="margin-bottom:14px;border-top:3px solid var(--imf-navy)">
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px">
          <div style="background:var(--imf-navy);border-radius:var(--rs);width:40px;height:40px;display:flex;align-items:center;justify-content:center;flex-shrink:0">
            <i class="ti ti-scan" style="color:#fff;font-size:20px"></i>
          </div>
          <div>
            <div style="font-size:15px;font-weight:800;color:var(--txt)">Final Inspection</div>
            <div style="font-size:12px;color:var(--txt-muted)">Scan or enter a QC-ready TAG</div>
          </div>
        </div>
        <button class="btn btn-p" onclick="openQrScanner(qcOnScan, 'Scan TAG for QC')" style="width:100%"><i class="ti ti-qrcode"></i> Scan TAG</button>
      </div>
      <div id="qc-result"></div>
    </div>`;

  if (_inspCard) renderInspectResult();
}

function qcOnScan(tagId) {
  qcFetchTag(tagId);
}

async function qcFetchTag(tagId) {
  let parsedTagId = tagId;
  if (!parsedTagId) {
    const input = document.getElementById('qc-tag-input');
    parsedTagId = input?.value;
  }
  const finalTagId = (parsedTagId || '').trim().toUpperCase();
  if (!finalTagId) { toast('Enter or scan a TAG UID'); return; }

  const resultEl = document.getElementById('qc-result');
  if (resultEl) resultEl.innerHTML = `<div class="empty"><div class="empty-ic"><i class="ti ti-loader" style="animation:spin 1s linear infinite"></i></div><p>Loading TAG…</p></div>`;

  try {
    const card = await fetchRouteCard(finalTagId);
    if (!card) {
      showInspectError(`TAG <strong>${finalTagId}</strong> not found. Verify the UID and try again.`); return;
    }
    const err = qcValidateCard(card);
    if (err) { showInspectError(err); return; }
    _inspCard = card;
    renderInspectResult();
  } catch (e) {
    showInspectError('Failed to load TAG: ' + friendlyError(e));
  }
}

function qcValidateCard(card) {
  const VALID = ['hard_wip', 'hard_done', 'qc_pending'];
  if (!VALID.includes(card.status)) {
    const LBLS = {
      store_issued: 'Store Issued', soft_wip: 'Soft Machining In Progress',
      soft_done: 'Soft Done (not yet heat treated)', ht_queue: 'HT Queue',
      sb_pending: 'HT Done (pending Shot Blasting)', sb_wip: 'In Shot Blasting',
      ht_done: 'HT & Blasting Done (not yet hard machined)',
      qc_cleared: 'Already QC Cleared', dispatched: 'Already Dispatched', scrapped: 'Scrapped',
    };
    return `TAG status is <strong>${LBLS[card.status] || card.status}</strong> — this TAG cannot be inspected at QC right now.`;
  }
  // Check final hard op is logged
  const finalOp = S.partOps.find(po =>
    po.partId === card.partId &&
    po.workCenterType === 'hard' &&
    po.finalOperation === true
  );
  if (finalOp) {
    const done = (card.opHistory || []).some(h => h.opId === finalOp.opId);
    if (!done) {
      const opName = S.operations.find(o => o.id === finalOp.opId)?.name || finalOp.opId;
      return `Final hard machining operation <strong>"${opName}"</strong> is not yet complete. QC cannot proceed until all operations are logged in Production.`;
    }
  }
  return null;
}

function showInspectError(msg) {
  const el = document.getElementById('qc-result');
  if (el) el.innerHTML = `
    <div style="background:var(--err-bg);border:1px solid var(--err-bdr);border-radius:var(--rs);padding:14px 16px">
      <div style="display:flex;align-items:flex-start;gap:10px">
        <i class="ti ti-alert-circle" style="font-size:20px;color:var(--err);flex-shrink:0;margin-top:1px"></i>
        <div style="font-size:13px;line-height:1.55;color:var(--err)">${msg}</div>
      </div>
    </div>`;
}

function renderInspectResult() {
  const card = _inspCard;
  if (!card) return;
  const el = document.getElementById('qc-result');
  if (!el) return;

  const partName = card.partName || S.parts.find(p => p.id === card.partId)?.name || '—';
  const custName  = card.customerName || S.customers.find(c => c.id === card.customerId)?.name || '—';
  const total     = card.currentQty || 0;

  // Hard ops for rework op selection
  const hardOps = S.partOps
    .filter(po => po.partId === card.partId && po.workCenterType === 'hard')
    .sort((a, b) => (a.seqNo || 0) - (b.seqNo || 0));
  const rwkOpts = hardOps.map(po => {
    const opName = S.operations.find(o => o.id === po.opId)?.name || po.opId;
    return `<option value="${po.id}">${opName} (Step ${po.seqNo || '?'})</option>`;
  }).join('');

  el.innerHTML = `
    <div class="imf-card" style="margin-bottom:12px;border-top:3px solid var(--accent-violet)">
      <div class="imf-card-top">
        <span class="imf-mono">${card.id}</span>
        ${card.cardColor === 'YELLOW' ? `<span class="imf-badge rag-a" style="margin-left:6px;font-size:10px">REWORK</span>` : ''}
        <div class="grow"></div>
        <button class="btn btn-ghost btn-sm" onclick="_inspCard=null;renderInspect()">
          <i class="ti ti-x"></i> Clear
        </button>
      </div>
      
      <div class="imf-card-lead" style="margin-top:12px">
        <span class="nm">${partName}</span>
        <span class="qty">${total} <small>pcs</small></span>
      </div>
      
      <div class="imf-card-meta">
        <i class="ti ti-building-factory-2"></i> ${custName}
      </div>
      <div class="imf-card-meta" style="margin-top:4px">
        ${card.batchCode ? `<span>Batch: <strong>${card.batchCode}</strong></span>` : ''}
        ${card.heatCode  ? `<span style="margin-left:8px">Heat: <strong class="imf-mono">${card.heatCode}</strong></span>` : ''}
      </div>

      <!-- Disposition inputs -->
      <div style="font-size:11px;font-weight:700;color:var(--txt-muted);letter-spacing:.06em;margin-bottom:10px;margin-top:16px;border-top:1px solid var(--bdr);padding-top:16px;">DISPOSITION</div>
      <div class="row-3" style="margin-bottom:10px">
        <div class="f">
          <label style="color:var(--err)"><i class="ti ti-alert-triangle" aria-hidden="true"></i> Scrap</label>
          <input type="number" id="qc-scrap" min="0" max="${total}" value="0"
            oninput="qcUpdateBalance()"
            style="font-size:20px;font-weight:900;text-align:center;color:var(--err);padding:10px 6px">
        </div>
        <div class="f">
          <label style="color:var(--warn)"><i class="ti ti-refresh" aria-hidden="true"></i> Rework</label>
          <input type="number" id="qc-rework" min="0" max="${total}" value="0"
            oninput="qcUpdateBalance()"
            style="font-size:20px;font-weight:900;text-align:center;color:var(--warn);padding:10px 6px">
        </div>
        <div class="f">
          <label style="color:var(--ok)"><i class="ti ti-check" aria-hidden="true"></i> OK</label>
          <div id="qc-ok-display"
            style="padding:10px 6px;background:var(--ok-bg);border:1.5px solid var(--ok-bdr);border-radius:var(--rxs);
                   font-size:20px;font-weight:900;text-align:center;color:var(--ok);line-height:1.2">
            ${total}
          </div>
        </div>
      </div>

      <div id="qc-balance-err"
        style="display:none;background:var(--err-bg);border:1px solid var(--err-bdr);border-radius:var(--rxs);
               padding:8px 12px;font-size:12px;font-weight:700;color:var(--err);margin-bottom:8px"></div>

      <div class="f" style="margin-bottom:10px;display:none" id="qc-defect-row">
        <label>Defect / Rework Description <span style="color:var(--err)">*</span></label>
        <textarea id="qc-defect" rows="3"
          placeholder="Describe the defects or rework needed in detail…"
          style="resize:vertical;font-size:13px;line-height:1.5"></textarea>
      </div>

      <div class="f" style="margin-bottom:10px;display:none" id="qc-rework-op-row">
        <label>Rework Re-entry Point (hard machining) <span style="color:var(--err)">*</span></label>
        <select id="qc-rework-op" style="font-size:13px">
          <option value="">— Select operation —</option>
          ${rwkOpts}
        </select>
      </div>

      <div id="qc-stream-section" style="border-top:1px solid var(--bdr);padding-top:12px;margin-top:4px">
        <div style="font-size:11px;font-weight:700;color:var(--txt-muted);letter-spacing:.06em;margin-bottom:8px">
          OK QTY — STREAM ALLOCATION
        </div>
        <div class="row-3">
          <div class="f">
            <label>OEM</label>
            <input type="number" id="qc-oem" min="0" value="${total}"
              oninput="qcCheckStream()" style="font-size:15px;font-weight:700;text-align:center">
          </div>
          <div class="f">
            <label>Spares</label>
            <input type="number" id="qc-spares" min="0" value="0"
              oninput="qcCheckStream()" style="font-size:15px;font-weight:700;text-align:center">
          </div>
          <div class="f">
            <label>Market</label>
            <input type="number" id="qc-market" min="0" value="0"
              oninput="qcCheckStream()" style="font-size:15px;font-weight:700;text-align:center">
          </div>
        </div>
        <div id="qc-stream-err"
          style="display:none;background:var(--err-bg);border:1px solid var(--err-bdr);border-radius:var(--rxs);
                 padding:8px 12px;font-size:12px;font-weight:700;color:var(--err);margin-top:6px"></div>
      </div>

      <button class="btn btn-p" style="width:100%;margin-top:16px;font-size:15px;padding:14px"
        onclick="qcConfirmDisposition()">
        <i class="ti ti-clipboard-check"></i> Submit Disposition
      </button>
    </div>`;

  qcUpdateBalance();
}

function qcUpdateBalance() {
  const card = _inspCard;
  if (!card) return;
  const total  = card.currentQty || 0;
  const scrap  = parseInt(document.getElementById('qc-scrap')?.value  || '0') || 0;
  const rework = parseInt(document.getElementById('qc-rework')?.value || '0') || 0;
  const ok     = total - scrap - rework;

  const okEl     = document.getElementById('qc-ok-display');
  const balErr   = document.getElementById('qc-balance-err');
  const streamSc = document.getElementById('qc-stream-section');
  const rwkOpRow = document.getElementById('qc-rework-op-row');
  const defRow   = document.getElementById('qc-defect-row');

  if (okEl) {
    okEl.textContent  = ok < 0 ? '!' : String(ok);
    okEl.style.background   = ok < 0 ? 'var(--err-bg)' : 'var(--ok-bg)';
    okEl.style.borderColor  = ok < 0 ? 'var(--err-bdr)' : 'var(--ok-bdr)';
    okEl.style.color        = ok < 0 ? 'var(--err)' : 'var(--ok)';
  }
  if (balErr) {
    if (ok < 0) {
      balErr.textContent = `Over-allocated by ${Math.abs(ok)} pcs — reduce scrap or rework`;
      balErr.style.display = '';
    } else { balErr.style.display = 'none'; }
  }
  if (streamSc) streamSc.style.display = ok > 0  ? '' : 'none';
  if (rwkOpRow) rwkOpRow.style.display  = rework > 0 ? '' : 'none';
  if (defRow)   defRow.style.display    = (scrap > 0 || rework > 0) ? '' : 'none';

  // Auto-fill stream: put all OK into OEM by default
  if (ok >= 0) {
    const oemEl = document.getElementById('qc-oem');
    const spEl  = document.getElementById('qc-spares');
    const mkEl  = document.getElementById('qc-market');
    if (oemEl) oemEl.value = ok;
    if (spEl)  spEl.value  = '0';
    if (mkEl)  mkEl.value  = '0';
  }
  qcCheckStream();
}

function qcCheckStream() {
  const card = _inspCard;
  if (!card) return;
  const total  = card.currentQty || 0;
  const scrap  = parseInt(document.getElementById('qc-scrap')?.value  || '0') || 0;
  const rework = parseInt(document.getElementById('qc-rework')?.value || '0') || 0;
  const ok     = total - scrap - rework;
  if (ok <= 0) return;

  const oem    = parseInt(document.getElementById('qc-oem')?.value    || '0') || 0;
  const spares = parseInt(document.getElementById('qc-spares')?.value || '0') || 0;
  const market = parseInt(document.getElementById('qc-market')?.value || '0') || 0;
  const diff   = oem + spares + market - ok;
  const errEl  = document.getElementById('qc-stream-err');
  if (!errEl) return;

  if (diff !== 0) {
    errEl.textContent = diff > 0
      ? `Stream total is ${diff} pcs over OK qty — reduce a stream`
      : `Stream total is ${Math.abs(diff)} pcs short of OK qty (${ok}) — add to a stream`;
    errEl.style.display = '';
  } else { errEl.style.display = 'none'; }
}

/* ── Confirm modal → submission ──────────────────────────────────────── */
function qcConfirmDisposition() {
  const card = _inspCard;
  if (!card) return;
  const total  = card.currentQty || 0;
  const scrap  = parseInt(document.getElementById('qc-scrap')?.value  || '0') || 0;
  const rework = parseInt(document.getElementById('qc-rework')?.value || '0') || 0;
  const ok     = total - scrap - rework;

  if (ok < 0) { toast('Fix quantity errors before submitting'); return; }
  if (scrap + rework + ok !== total) { toast('Quantities must sum to ' + total); return; }
  if ((scrap > 0 || rework > 0) && !(document.getElementById('qc-defect')?.value || '').trim()) {
    toast('Enter defect/rework description'); return;
  }
  if (rework > 0 && !document.getElementById('qc-rework-op')?.value) {
    toast('Select rework operation'); return;
  }
  if (ok > 0) {
    const oem    = parseInt(document.getElementById('qc-oem')?.value    || '0') || 0;
    const spares = parseInt(document.getElementById('qc-spares')?.value || '0') || 0;
    const market = parseInt(document.getElementById('qc-market')?.value || '0') || 0;
    if (oem + spares + market !== ok) { toast('Stream allocation must sum to OK qty (' + ok + ')'); return; }
  }

  const partName = card.partName || '—';
  openModal(`
    <div class="modal-handle"></div>
    <div class="modal-title">Confirm Disposition</div>
    <div style="margin-bottom:14px">
      <div style="font-weight:700;font-size:14px">${partName}</div>
      <div class="tag-uid" style="margin-top:3px">${card.id}</div>
      <div style="font-size:12px;color:var(--txt-muted);margin-top:4px">Inspect qty: ${total} pcs</div>
    </div>
    <div class="stats-3" style="margin-bottom:14px">
      <div class="stat-card ${scrap > 0 ? 'err' : ''}">
        <div class="stat-lbl">Scrap</div><div class="stat-val">${scrap}</div>
      </div>
      <div class="stat-card ${rework > 0 ? 'warn' : ''}">
        <div class="stat-lbl">Rework</div><div class="stat-val">${rework}</div>
      </div>
      <div class="stat-card ${ok > 0 ? 'ok' : 'err'}">
        <div class="stat-lbl">OK</div><div class="stat-val">${ok}</div>
      </div>
    </div>
    <div style="background:var(--err-bg);border:1px solid var(--err-bdr);border-radius:var(--rs);
                padding:10px 14px;font-size:12px;font-weight:700;color:var(--err);margin-bottom:14px">
      <i class="ti ti-alert-triangle"></i> This action is irreversible and permanently updates the route card.
    </div>
    <div style="display:flex;gap:8px">
      <button class="btn btn-s" style="flex:1" onclick="closeModal()">Cancel</button>
      <button class="btn btn-ok" style="flex:1" onclick="closeModal();qcSubmitDisposition()">
        <i class="ti ti-check"></i> Confirm &amp; Save
      </button>
    </div>`);
}

async function qcSubmitDisposition() {
  if (!navigator.onLine) { toast('Offline — QC writes require a live connection'); return; }

  const card   = _inspCard;
  if (!card) return;
  const tagId  = card.id;
  const total  = card.currentQty || 0;
  const scrap  = parseInt(document.getElementById('qc-scrap')?.value  || '0') || 0;
  const rework = parseInt(document.getElementById('qc-rework')?.value || '0') || 0;
  const ok     = total - scrap - rework;
  const defect = (document.getElementById('qc-defect')?.value || '').trim();
  const rwkOpId = document.getElementById('qc-rework-op')?.value || '';

  const oem    = ok > 0 ? (parseInt(document.getElementById('qc-oem')?.value    || '0') || 0) : 0;
  const spares = ok > 0 ? (parseInt(document.getElementById('qc-spares')?.value || '0') || 0) : 0;
  const market = ok > 0 ? (parseInt(document.getElementById('qc-market')?.value || '0') || 0) : 0;

  const rwkOpDef  = S.partOps.find(po => po.id === rwkOpId);
  const rwkOpName = rwkOpDef ? (S.operations.find(o => o.id === rwkOpDef.opId)?.name || rwkOpId) : '';

  try {
    const batch = db.batch();
    const now   = serverTS();

    // 1. Update original route card
    const newStatus = (ok > 0 || rework > 0) ? 'qc_cleared' : 'scrapped';
    batch.update(db.collection('routeCards').doc(tagId), {
      currentQty: ok,
      qty_oem: oem,
      qty_spares: spares,
      qty_market: market,
      status: newStatus,
      qcInspectedBy: S.sess.userId,
      qcInspectedByName: S.sess.name,
      qcInspectedAt: now,
      opHistory: firebase.firestore.FieldValue.arrayUnion({
        type: 'QC_INSPECTION',
        stage: 'qc',
        scrapQty: scrap, reworkQty: rework, okQty: ok,
        oem, spares, market,
        by: S.sess.userId, byName: S.sess.name,
        ts: new Date().toISOString(),
      }),
      updatedAt: now,
    });

    // 2. Scrap ledger
    if (scrap > 0) {
      batch.set(db.collection('scrapLedger').doc(), {
        tagId,
        batchCode:    card.batchCode    || '',
        heatCode:     card.heatCode     || '',
        partId:       card.partId,
        partNo:       card.partNo       || '',
        partName:     card.partName     || '',
        customerId:   card.customerId   || '',
        customerName: card.customerName || '',
        qtyRejected:  scrap,
        defectDescription: defect,
        inspectedBy:     S.sess.userId,
        inspectedByName: S.sess.name,
        date: dateStr(),
        createdAt: now,
      });
    }

    // 3. Rework card birth (YELLOW, -RWK suffix, inherited genealogy)
    if (rework > 0) {
      batch.set(db.collection('routeCards').doc(tagId + '-RWK'), {
        partId:       card.partId,
        partNo:       card.partNo       || '',
        partName:     card.partName     || '',
        customerId:   card.customerId   || '',
        customerName: card.customerName || '',
        batchCode:    card.batchCode    || '',
        masterLotCode: card.masterLotCode || '',
        heatCode:     card.heatCode     || '',
        cardType:     'REWORK',
        cardColor:    'YELLOW',
        parentCardUid: tagId,
        initialQty:   rework,
        currentQty:   rework,
        status:       'hard_wip',
        reworkOpId:   rwkOpId,
        reworkOpName: rwkOpName,
        defectDescription: defect,
        opHistory:    [],
        qty_oem:      0,
        qty_spares:   0,
        qty_market:   0,
        createdAt:    now,
        createdBy:    S.sess.userId,
        createdByName: S.sess.name,
      });
    }

    // 4. QC inspection record
    batch.set(db.collection('qcInspections').doc(), {
      tagId,
      batchCode:    card.batchCode    || '',
      heatCode:     card.heatCode     || '',
      partId:       card.partId,
      partNo:       card.partNo       || '',
      partName:     card.partName     || '',
      customerId:   card.customerId   || '',
      customerName: card.customerName || '',
      totalQty: total, scrapQty: scrap, reworkQty: rework, okQty: ok,
      okOEM: oem, okSpares: spares, okMarket: market,
      defectDescription: defect,
      reworkOpId:  rwkOpId,
      reworkOpName: rwkOpName,
      reworkTagId: rework > 0 ? tagId + '-RWK' : '',
      inspectedBy:     S.sess.userId,
      inspectedByName: S.sess.name,
      date: dateStr(),
      createdAt: now,
    });

    await batch.commit();
    await logAudit('QC_DISPOSITION', 'QC', tagId,
      { status: card.status, currentQty: total },
      { status: newStatus, ok, scrap, rework });

    toast(`Disposition saved ✓  OK: ${ok}  Scrap: ${scrap}  Rework: ${rework}`);
    _inspCard = null;
    const input = document.getElementById('qc-tag-input');
    if (input) input.value = '';
    await refreshQC();
  } catch (e) {
    console.error('qcSubmitDisposition:', e);
    toast(friendlyError(e));
  }
}

/* ═══════════════════════════════════════════════════════════════════
   TAB: IQC — Incoming Quality Control
   Inward receipts start as 'pending'; QC team Accept/Conditional/Reject.
   Rejected lots are quarantined from stock until re-inspected or disposed.
   ═══════════════════════════════════════════════════════════════════ */
function renderIQC() {
  const el = document.getElementById('tab-body');
  if (!el) return;
  const pending = S_QC.inward.filter(r => r.iqcStatus === 'pending')
    .sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  const history = S_QC.inward.filter(r => r.iqcStatus && r.iqcStatus !== 'pending')
    .sort((a, b) => (b.date || '').localeCompare(a.date || '')).slice(0, 50);

  const filterTabs = `
    <div class="imf-seg" style="margin-bottom:16px;width:fit-content;">
      <button class="seg-btn ${_iqcFilt==='pending'?'active':''}" onclick="_iqcFilt='pending';renderIQC()">
        Pending${pending.length ? ` (${pending.length})` : ''}
      </button>
      <button class="seg-btn ${_iqcFilt==='history'?'active':''}" onclick="_iqcFilt='history';renderIQC()">
        History
      </button>
    </div>`;

  let content = '';
  if (_iqcFilt === 'pending') {
    if (pending.length) {
      content = `<div class="imf-cards">${pending.map(iqcPendingCard).join('')}</div>`;
    } else {
      content = `<div class="imf-empty"><div class="ic"><i class="ti ti-circle-check"></i></div>
                 <h3>All lots cleared</h3><p>No inward receipts awaiting inspection.</p></div>`;
    }
  } else {
    if (history.length) {
      content = `
        <div class="imf-tablewrap">
          <div class="imf-table-scroll">
            <table class="imf-table">
              <thead><tr>
                <th class="pin">Supplier</th>
                <th class="num">Date</th>
                <th>Lot Code</th>
                <th class="num">Total Pcs</th>
                <th>Inspected By</th>
                <th>Result</th>
              </tr></thead>
              <tbody>${history.map(iqcHistTableRow).join('')}</tbody>
            </table>
          </div>
        </div>
        <div class="imf-cards mt-12">${history.map(iqcHistCard).join('')}</div>`;
    } else {
      content = `<div class="imf-empty"><div class="ic"><i class="ti ti-history"></i></div>
                 <h3>No IQC history</h3><p>Completed inspections will appear here.</p></div>`;
    }
  }

  el.innerHTML = filterTabs + content;
}

function iqcPendingCard(r) {
  const parts = r.parts || [];
  const totalPcs = parts.reduce((s, p) => s + (+p.qty || 0), 0);
  return `
    <div class="imf-card" style="border:1.5px solid var(--warn)">
      <div class="imf-card-top">
        <span class="nm">${r.supplierName || '—'}</span>
        <div class="grow"></div>
        <span class="imf-badge rag-a"><i class="ti ti-clock"></i> IQC Pending</span>
      </div>
      <div class="imf-card-meta">
        <i class="ti ti-calendar"></i> ${fmtDate(r.date)} · <span class="imf-mono" style="color:var(--txt)">${r.masterLotCode || '—'}</span>
        ${r.dcNo ? ` · DC: ${r.dcNo}` : ''}
      </div>
      <div style="background:var(--sur2);border-radius:var(--rs);padding:8px 12px;margin-bottom:12px;border:1px solid var(--bdr)">
        ${parts.map(p => `
          <div style="display:flex;justify-content:space-between;padding:4px 0;font-size:13px">
            <span>${p.partName} <span class="imf-mono" style="font-size:11px;color:var(--txt-muted)">${p.partNo||''}</span></span>
            <strong class="mono">${p.qty} pcs</strong>
          </div>`).join('')}
        <div style="border-top:1px solid var(--bdr);margin-top:6px;padding-top:6px;font-size:12px;color:var(--txt-muted);display:flex;justify-content:space-between;">
          <span>Total:</span><strong class="mono" style="color:var(--txt)">${totalPcs} pcs</strong>
        </div>
      </div>
      <div style="display:flex;gap:8px">
        <button class="btn btn-p" style="flex:1" onclick="openIQCModal('${r.id}','accepted')">
          <i class="ti ti-circle-check"></i> Accept
        </button>
        <button class="btn" style="flex:1;background:var(--ok-bg);color:var(--ok);border:1.5px solid var(--ok-bdr)" onclick="openIQCModal('${r.id}','conditional')">
          <i class="ti ti-alert-circle"></i> Cond
        </button>
        <button class="btn" style="flex:1;background:var(--err-bg);color:var(--err);border:1.5px solid var(--err-bdr)" onclick="openIQCModal('${r.id}','rejected')">
          <i class="ti ti-ban"></i> Reject
        </button>
      </div>
    </div>`;
}

function iqcHistTableRow(r) {
  const parts = r.parts || [];
  const totalPcs = parts.reduce((s, p) => s + (+p.qty || 0), 0);
  const result = S_QC.iqcResults.find(q => q.inwId === r.id);
  
  let bcls = 'rag-gr';
  if (r.iqcStatus === 'accepted') bcls = 'st-qc_cleared';
  if (r.iqcStatus === 'conditional') bcls = 'rag-a';
  if (r.iqcStatus === 'rejected') bcls = 'rag-r';

  return `
    <tr>
      <td class="pin">${r.supplierName || '—'}</td>
      <td class="num">${fmtDate(r.date)}</td>
      <td class="mono">${r.masterLotCode||'—'}</td>
      <td class="num" style="font-weight:700">${totalPcs}</td>
      <td>${result?.checkedByName || '—'}</td>
      <td><span class="imf-badge ${bcls}">${IQC_LABEL[r.iqcStatus]||r.iqcStatus}</span></td>
    </tr>`;
}

function iqcHistCard(r) {
  const parts = r.parts || [];
  const totalPcs = parts.reduce((s, p) => s + (+p.qty || 0), 0);
  const result = S_QC.iqcResults.find(q => q.inwId === r.id);
  
  let bcls = 'rag-gr';
  if (r.iqcStatus === 'accepted') bcls = 'st-qc_cleared';
  if (r.iqcStatus === 'conditional') bcls = 'rag-a';
  if (r.iqcStatus === 'rejected') bcls = 'rag-r';

  return `
    <div class="imf-card">
      <div class="imf-card-top">
        <span class="nm">${r.supplierName || '—'}</span>
        <div class="grow"></div>
        <span class="imf-badge ${bcls}">${IQC_LABEL[r.iqcStatus]||r.iqcStatus}</span>
      </div>
      <div class="imf-card-lead">
        <span class="imf-mono" style="font-size:12px">${r.masterLotCode||'—'}</span>
        <span class="qty">${totalPcs} <small>pcs</small></span>
      </div>
      <div class="imf-card-meta">
        <i class="ti ti-user"></i> ${result?.checkedByName || '—'} · ${fmtDate(r.date)}
      </div>
      ${result?.notes ? `<div class="imf-card-foot"><em>Notes:</em> ${result.notes}</div>` : ''}
    </div>`;
}

function openIQCModal(inwId, preselect) {
  const r = S_QC.inward.find(x => x.id === inwId);
  if (!r) return;
  const parts = r.parts || [];
  const totalPcs = parts.reduce((s, p) => s + (+p.qty || 0), 0);
  openModal(`
    <div class="modal-handle"></div>
    <div class="modal-title">IQC Inspection</div>
    <div id="modal-err"></div>
    <div style="background:var(--sur2);border-radius:var(--rs);padding:10px 12px;margin-bottom:14px">
      <div style="font-weight:700">${r.supplierName}</div>
      <div style="font-size:12px;color:var(--txt-muted);margin-top:2px">
        <span style="font-family:monospace">${r.masterLotCode}</span> · ${fmtDate(r.date)}
      </div>
      ${parts.map(p => `<div style="font-size:13px;margin-top:4px">${p.partName} — <strong>${p.qty} pcs</strong></div>`).join('')}
      <div style="font-size:12px;font-weight:700;color:var(--txt-muted);margin-top:6px">Total: ${totalPcs} pcs</div>
    </div>
    <div class="f">
      <label class="f-req">IQC Decision</label>
      <div style="display:flex;flex-direction:column;gap:8px">
        ${[['accepted','Accept — material meets spec, release to store','ti-circle-check','var(--ok)'],
           ['conditional','Conditional — accept with usage restrictions','ti-alert-circle','var(--warn)'],
           ['rejected','Reject — material does not meet spec, quarantine','ti-ban','var(--err)']
          ].map(([val, lbl, icon, col]) => `
          <label style="display:flex;align-items:flex-start;gap:10px;padding:10px 12px;
                        border:1.5px solid ${preselect===val?col:'var(--bdr)'};border-radius:var(--rs);
                        cursor:pointer;background:${preselect===val?col+'1a':'var(--sur)'}">
            <input type="radio" name="iqc-decision" value="${val}" ${preselect===val?'checked':''} style="margin-top:2px;flex-shrink:0">
            <div>
              <div style="font-weight:600;display:flex;align-items:center;gap:6px">
                <i class="ti ${icon}" style="color:${col}"></i> ${val.charAt(0).toUpperCase()+val.slice(1)}
              </div>
              <div style="font-size:11px;color:var(--txt-muted)">${lbl}</div>
            </div>
          </label>`).join('')}
      </div>
    </div>
    <div class="f" style="margin-top:12px">
      <label for="iqc-notes">Inspection Notes / Conditions</label>
      <textarea id="iqc-notes" rows="2"
        placeholder="Dimension check results, material cert ref, conditions for conditional acceptance..."></textarea>
    </div>
    ${modalActions('Record IQC Decision', "saveIQC('" + inwId + "')")}
  `);
}

async function saveIQC(inwId) {
  if (!navigator.onLine) { toast('Offline — QC writes require a live connection'); return; }
  const decision = document.querySelector('input[name="iqc-decision"]:checked')?.value;
  if (!decision) { showModalError('Select a decision — Accept, Conditional, or Reject'); return; }
  const notes = getField('iqc-notes');
  try {
    const batch = db.batch();
    const iqcRef = db.collection('iqcResults').doc();
    batch.set(iqcRef, {
      inwId, decision, notes,
      checkedBy: S.sess.userId, checkedByName: S.sess.name,
      checkedAt: serverTS(),
    });
    batch.update(db.collection('inward').doc(inwId), {
      iqcStatus: decision, updatedAt: serverTS(),
    });
    await batch.commit();
    await logAudit('IQC_DECISION', 'QC', inwId, { iqcStatus: 'pending' }, { iqcStatus: decision, notes });
    closeModal();
    await refreshQC();
    const msg = decision === 'accepted'    ? 'Lot accepted — material now available in stock'
              : decision === 'conditional' ? 'Conditional acceptance recorded — material available with restrictions'
              :                              'Lot rejected — material quarantined from stock';
    toast(msg);
  } catch (e) {
    showModalError(friendlyError(e));
  }
}

/* ═══════════════════════════════════════════════════════════════════
   TAB: PRODUCTION SETUPS (pending approval + history)
   ═══════════════════════════════════════════════════════════════════ */
function renderSetupApprovals() {
  const el = document.getElementById('tab-body');
  if (!el) return;

  const pending = S_QC.setupApprovals.filter(s => s.status === 'pending');
  // 'awaiting_deviation' setups are neither pending QC review nor decided yet
  // — they're held behind a Plant Head deviation decision (see approvals.js)
  // and must not show up here at all, let alone be mislabeled as rejected.
  const history = S_QC.setupApprovals.filter(s => s.status === 'approved' || s.status === 'rejected');

  el.innerHTML = `
    <!-- Header -->
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">
      <div>
        <div style="font-size:14px;font-weight:800">Production Setups</div>
        <div style="font-size:11px;color:var(--txt-muted)">${pending.length} pending · ${history.length} in history</div>
      </div>
      <button class="btn btn-s btn-sm" onclick="refreshQC()"><i class="ti ti-refresh"></i> Refresh</button>
    </div>

    <!-- Pending section -->
    <div style="font-size:11px;font-weight:700;color:var(--txt-muted);letter-spacing:.06em;margin-bottom:8px;display:flex;align-items:center;gap:6px">
      PENDING APPROVAL
      ${pending.length > 0 ? `<span style="background:var(--warn);color:#fff;border-radius:99px;padding:1px 7px;font-size:10px">${pending.length}</span>` : ''}
    </div>
    ${pending.length === 0 ? `
      <div style="background:var(--bg);border-radius:var(--rs);padding:16px;text-align:center;margin-bottom:20px;border:1.5px dashed var(--bdr-mid)">
        <i class="ti ti-circle-check" style="font-size:22px;color:var(--ok);display:block;margin-bottom:6px"></i>
        <div style="font-size:13px;font-weight:700;color:var(--ok)">All Clear</div>
        <div style="font-size:11px;color:var(--txt-muted);margin-top:2px">No setups waiting for QC approval</div>
      </div>` : pending.map(qcSetupCard).join('')}

    <!-- Info note about production link -->
    <div style="background:var(--info-bg,#eff6ff);border:1px solid var(--acc);border-radius:var(--rs);padding:10px 14px;margin-bottom:20px;
                display:flex;align-items:flex-start;gap:10px;font-size:12px">
      <i class="ti ti-info-circle" style="color:var(--acc);font-size:16px;flex-shrink:0;margin-top:1px"></i>
      <div style="color:var(--txt-mid);line-height:1.5">
        Approved setups automatically appear in the <strong>Production Shift Log</strong> for the matching machine, date, and shift.
        If you cannot see an approved setup there, check that the shift date and machine match the Production view.
      </div>
    </div>

    <!-- History section -->
    <div style="font-size:11px;font-weight:700;color:var(--txt-muted);letter-spacing:.06em;margin-bottom:8px">
      SETUP HISTORY ${history.length > 0 ? `<span style="font-weight:400;font-size:11px;color:var(--txt-muted)">(${history.length})</span>` : ''}
    </div>
    ${history.length === 0 ? `
      <div style="font-size:12px;color:var(--txt-muted);text-align:center;padding:16px 0">No approved or rejected setups yet.</div>
    ` : history.map(qcSetupHistCard).join('')}`;
}

function qcSetupCard(s) {
  const canAct   = S.sess?.role === 'admin' || S.sess?.role === 'hod' || S.sess?.role === 'supervisor';
  const stageLbl = s.stage === 'soft' ? 'Soft Machining' : s.stage === 'hard' ? 'Hard Machining' : (s.stage || '—');

  return `
    <div class="card" style="margin-bottom:10px;border:1.5px solid var(--warn)">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px;margin-bottom:10px">
        <div style="flex:1;min-width:0">
          <div style="font-weight:800;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">
            ${s.partName || '—'}
            ${s.partNo ? `<span style="font-family:monospace;font-size:11px;font-weight:400;color:var(--txt-muted)"> ${s.partNo}</span>` : ''}
          </div>
          <div style="font-size:11px;color:var(--txt-muted);margin-top:2px">
            <span class="tag-uid" style="font-size:10px">${s.tagId || '—'}</span>
            <span style="margin-left:6px">${s.machineName || '—'}</span>
          </div>
          <div style="font-size:11px;color:var(--txt-muted);margin-top:2px">
            ${stageLbl} · By ${s.requestedByName || '—'} · ${fmtDate(s.date)}${s.shift ? ' · Shift ' + s.shift : ''}
          </div>
        </div>
        <div style="text-align:center;flex-shrink:0;background:var(--warn-bg,#fef9c3);border-radius:var(--rs);padding:8px 14px">
          <div style="font-size:24px;font-weight:900;line-height:1;color:var(--warn)">${s.setupMins || 0}</div>
          <div style="font-size:9px;font-weight:700;color:var(--warn);text-transform:uppercase;letter-spacing:.04em">setup min</div>
        </div>
      </div>

      <div style="background:var(--bg);border-radius:var(--rxs);padding:8px 12px;margin-bottom:10px">
        <div style="font-size:12px;font-weight:700">${s.opName || '—'}</div>
        <div style="font-size:11px;color:var(--txt-muted);margin-top:2px">Operator: ${s.operatorName || '—'}</div>
        ${s.remarks ? `<div style="font-size:11px;color:var(--txt-mid);margin-top:4px;font-style:italic">"${s.remarks}"</div>` : ''}
      </div>

      ${canAct ? `
        <div class="f" style="margin-bottom:8px">
          <label style="font-size:11px">QC Remarks</label>
          <input type="text" id="qcsa-rmk-${s.id}" placeholder="Optional for approval, required for rejection…" style="font-size:13px">
        </div>
        <div style="display:flex;gap:8px">
          <button class="btn btn-ok" style="flex:1" onclick="qcApproveSetup('${s.id}')">
            <i class="ti ti-check"></i> Approve
          </button>
          <button class="btn btn-d" style="flex:1" onclick="qcRejectSetup('${s.id}')">
            <i class="ti ti-x"></i> Reject
          </button>
        </div>`
      : `<div style="font-size:12px;color:var(--txt-muted);padding:4px 0">Approval requires supervisor, HOD, or admin role.</div>`}
      ${(S.sess?.role === 'admin' || S.sess?.role === 'hod') ? `
        <button class="btn btn-s" style="width:100%;margin-top:8px;color:var(--err);border-color:var(--err)"
          onclick="confirmDeleteSetupQC('${s.id}')">
          <i class="ti ti-trash"></i> Delete Setup Log
        </button>` : ''}
    </div>`;
}

function qcSetupHistCard(s) {
  const isApproved = s.status === 'approved';
  const stageLbl   = s.stage === 'soft' ? 'Soft' : s.stage === 'hard' ? 'Hard' : (s.stage || '—');
  const statusCol  = isApproved ? 'var(--ok)' : 'var(--err)';
  const statusBg   = isApproved ? 'var(--ok-bg)' : 'var(--err-bg)';
  const statusLbl  = isApproved ? 'Approved' : 'Rejected';

  return `
    <div class="card" style="margin-bottom:8px;border:1.5px solid ${statusCol}">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px">
        <div style="flex:1;min-width:0">
          <div style="font-size:13px;font-weight:800">${s.partName || '—'}
            ${s.partNo ? `<span style="font-family:monospace;font-size:10px;font-weight:400;color:var(--txt-muted)"> ${s.partNo}</span>` : ''}
          </div>
          <div style="font-size:11px;color:var(--txt-muted);margin-top:2px">
            <span class="tag-uid" style="font-size:10px">${s.tagId || '—'}</span>
            <span style="margin-left:6px">${s.machineName || '—'} · ${stageLbl} · Shift ${s.shift || '—'} · ${fmtDate(s.date)}</span>
          </div>
          <div style="font-size:11px;color:var(--txt-muted);margin-top:1px">
            Op: <strong>${s.opName || '—'}</strong> · ${s.setupMins || 0} min · By ${s.requestedByName || '—'}
          </div>
        </div>
        <div style="text-align:center;flex-shrink:0;background:${statusBg};border-radius:var(--rxs);padding:4px 10px">
          <div style="font-size:11px;font-weight:800;color:${statusCol}">${statusLbl}</div>
          <div style="font-size:10px;color:var(--txt-muted)">by ${s.approvedByName || '—'}</div>
        </div>
      </div>
      ${(s.approverRemarks || s.rejectionReason) ? `
        <div style="margin-top:8px;font-size:11px;color:var(--txt-mid);font-style:italic;border-top:1px solid var(--bdr);padding-top:6px">
          "${s.approverRemarks || s.rejectionReason}"
        </div>` : ''}
      ${(S.sess?.role === 'admin' || S.sess?.role === 'hod') ? `
        <button class="btn btn-s" style="width:100%;margin-top:8px;color:var(--err);border-color:var(--err)"
          onclick="confirmDeleteSetupQC('${s.id}')">
          <i class="ti ti-trash"></i> Delete Setup Log
        </button>` : ''}
    </div>`;
}

function confirmDeleteSetupQC(id) {
  const s = S_QC.setupApprovals.find(x => x.id === id);
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
    <div style="background:var(--err-bg);border:1px solid var(--err-bdr);border-radius:var(--rs);
                padding:10px 14px;font-size:12px;font-weight:700;color:var(--err);margin-bottom:14px">
      <i class="ti ti-alert-triangle"></i> This permanently removes the setup record from both Production and QC views.
    </div>
    <div style="display:flex;gap:8px">
      <button class="btn btn-s" style="flex:1" onclick="closeModal()">Cancel</button>
      <button class="btn btn-s" style="flex:1;background:var(--err);border-color:var(--err);color:#fff"
        onclick="closeModal();deleteSetupQC('${id}')">
        <i class="ti ti-trash"></i> Delete
      </button>
    </div>`);
}

async function deleteSetupQC(id) {
  try {
    await db.collection('setupApprovals').doc(id).delete();
    S_QC.setupApprovals = S_QC.setupApprovals.filter(x => x.id !== id);
    await logAudit('delete_setup', 'QC', id, null, {});
    toast('Setup log deleted ✓');
    renderSetupApprovals();
  } catch (e) {
    toast('Error deleting setup: ' + friendlyError(e));
  }
}

async function qcApproveSetup(id) {
  if (!navigator.onLine) { toast('Offline — QC writes require a live connection'); return; }
  const s   = S_QC.setupApprovals.find(x => x.id === id);
  if (!s) return;
  const rmk = (document.getElementById(`qcsa-rmk-${id}`)?.value || '').trim();
  try {
    await db.collection('setupApprovals').doc(id).update({
      status: 'approved',
      approvedBy: S.sess.userId, approvedByName: S.sess.name,
      approvedAt: serverTS(),
      ...(rmk ? { approverRemarks: rmk } : {}),
      updatedAt: serverTS(),
    });
    await logAudit('APPROVE_SETUP', 'QC', id, s, { status: 'approved' });
    toast('Setup approved ✓');
    await refreshQC();
  } catch (e) { toast(friendlyError(e)); }
}

async function qcRejectSetup(id) {
  if (!navigator.onLine) { toast('Offline — QC writes require a live connection'); return; }
  const s   = S_QC.setupApprovals.find(x => x.id === id);
  if (!s) return;
  const rmk = (document.getElementById(`qcsa-rmk-${id}`)?.value || '').trim();
  if (!rmk) { toast('Enter reason for rejection'); return; }
  try {
    await db.collection('setupApprovals').doc(id).update({
      status: 'rejected', rejectionReason: rmk,
      approvedBy: S.sess.userId, approvedByName: S.sess.name,
      approvedAt: serverTS(), updatedAt: serverTS(),
    });
    await logAudit('REJECT_SETUP', 'QC', id, s, { status: 'rejected', rejectionReason: rmk });
    toast('Setup rejected');
    await refreshQC();
  } catch (e) { toast(friendlyError(e)); }
}

/* ═══════════════════════════════════════════════════════════════════
   TAB: HISTORY
   ═══════════════════════════════════════════════════════════════════ */
function renderHistory() {
  const el = document.getElementById('tab-body');
  if (!el) return;

  const totalInsp = S_QC.inspections.reduce((s, r) => s + (r.totalQty || 0), 0);
  const totalOk   = S_QC.inspections.reduce((s, r) => s + (r.okQty    || 0), 0);
  const totalScr  = S_QC.inspections.reduce((s, r) => s + (r.scrapQty || 0), 0);

  const hasInsp = S_QC.inspections.length > 0;

  el.innerHTML = `
    <div class="imf-tablewrap">
      <div class="imf-table-toolbar">
        <div class="grow">
          <div style="font-size:16px;font-weight:700">QC History</div>
          <div class="text-sm text-muted">${S_QC.inspections.length} inspection${S_QC.inspections.length!==1?'s':''} · last 100</div>
        </div>
        <div style="display:flex; gap:16px; align-items:center;">
          <div style="text-align:right">
            <div style="font-size:11px;color:var(--txt-muted);text-transform:uppercase;font-weight:700">Inspected</div>
            <div class="mono" style="font-size:14px;font-weight:600">${totalInsp}</div>
          </div>
          <div style="text-align:right">
            <div style="font-size:11px;color:var(--ok);text-transform:uppercase;font-weight:700">OK</div>
            <div class="mono" style="font-size:14px;font-weight:600">${totalOk}</div>
          </div>
          <div style="text-align:right">
            <div style="font-size:11px;color:var(--err);text-transform:uppercase;font-weight:700">Scrap</div>
            <div class="mono" style="font-size:14px;font-weight:600">${totalScr}</div>
          </div>
          <button class="btn btn-ghost btn-sm" onclick="refreshQC()"><i class="ti ti-refresh"></i></button>
        </div>
      </div>
      ${!hasInsp ? `
      <div class="imf-empty">
        <div class="ic"><i class="ti ti-history"></i></div>
        <h3>No inspections yet</h3>
        <p>Completed QC inspections will appear here.</p>
      </div>` : `
      <div class="imf-table-scroll">
        <table class="imf-table">
          <thead><tr>
            <th class="pin">TAG ID</th>
            <th>Part</th>
            <th>Customer</th>
            <th class="num">Date</th>
            <th>By</th>
            <th class="num grp grp-l">Total</th>
            <th class="num grp">OK</th>
            <th class="num grp">Rework</th>
            <th class="num grp grp-r">Scrap</th>
            <th class="num">Yield</th>
          </tr></thead>
          <tbody>${S_QC.inspections.map(inspTableRow).join('')}</tbody>
        </table>
      </div>`}
    </div>
    ${hasInsp ? `<div class="imf-cards mt-12">${S_QC.inspections.map(inspCard).join('')}</div>` : ''}`;
}

function inspTableRow(r) {
  const total = r.totalQty || 0;
  const ok    = r.okQty    || 0;
  const scr   = r.scrapQty || 0;
  const rwk   = r.reworkQty || 0;
  const pct   = total > 0 ? Math.round((ok / total) * 100) : 100;
  
  let row = `
    <tr>
      <td class="pin mono">${r.tagId}</td>
      <td>${r.partName || '—'}</td>
      <td>${r.customerName || '—'}</td>
      <td class="num">${fmtDate(r.date)}</td>
      <td>${r.inspectedByName || '—'}</td>
      <td class="num grp grp-l">${total}</td>
      <td class="num grp" style="color:var(--ok)">${ok}</td>
      <td class="num grp" style="color:var(--warn)">${rwk}</td>
      <td class="num grp grp-r" style="color:var(--err)">${scr}</td>
      <td class="num" style="font-weight:700">${pct}%</td>
    </tr>`;

  if (r.defectDescription || r.reworkTagId) {
    row += `<tr><td colspan="10" style="padding:8px 16px;background:var(--sur2);font-size:12px;color:var(--txt-mid)">
      ${r.defectDescription ? `<em>Defect:</em> ${r.defectDescription} ` : ''}
      ${r.reworkTagId ? ` · <em>Rework TAG:</em> <span class="mono">${r.reworkTagId}</span>` : ''}
    </td></tr>`;
  }
  return row;
}

function inspCard(r) {
  const total = r.totalQty || 0;
  const ok    = r.okQty    || 0;
  const scr   = r.scrapQty || 0;
  const rwk   = r.reworkQty || 0;
  const pct   = total > 0 ? Math.round((ok / total) * 100) : 100;

  return `
    <div class="imf-card">
      <div class="imf-card-top">
        <span class="imf-mono">${r.tagId}</span>
        <div class="grow"></div>
        <span class="imf-badge ${pct >= 95 ? 'st-qc_cleared' : 'rag-a'}"><i class="ti ti-activity"></i> ${pct}% Yield</span>
      </div>
      <div class="imf-card-lead">
        <span class="nm">${r.partName || '—'}</span>
        <span class="qty">${total} <small>pcs</small></span>
      </div>
      <div class="imf-card-meta">
        <i class="ti ti-user"></i> ${r.inspectedByName || '—'} · ${fmtDate(r.date)}
      </div>
      <div class="imf-split">
        <div style="background:var(--ok-bg)">
          <div class="k" style="color:var(--ok)">OK</div>
          <div class="v" style="color:var(--ok)">${ok}</div>
        </div>
        <div style="background:var(--warn-bg)">
          <div class="k" style="color:var(--warn)">RWK</div>
          <div class="v" style="color:var(--warn)">${rwk}</div>
        </div>
        <div style="background:var(--err-bg)">
          <div class="k" style="color:var(--err)">SCRAP</div>
          <div class="v" style="color:var(--err)">${scr}</div>
        </div>
      </div>
      ${r.defectDescription ? `<div class="imf-card-foot"><em>Defect:</em> ${r.defectDescription}</div>` : ''}
    </div>`;
}

/* ═══════════════════════════════════════════════════════════════════
   TAB: CLEARED
   ═══════════════════════════════════════════════════════════════════ */
function renderCleared() {
  const el = document.getElementById('tab-body');
  if (!el) return;

  const totalPcs = S_QC.clearedCards.reduce((s, c) => s + (c.currentQty || 0), 0);

  const hasCleared = S_QC.clearedCards.length > 0;

  el.innerHTML = `
    <div class="imf-tablewrap">
      <div class="imf-table-toolbar">
        <div class="grow">
          <div style="font-size:16px;font-weight:700">QC Cleared TAGs</div>
          <div class="text-sm text-muted">${S_QC.clearedCards.length} TAG${S_QC.clearedCards.length !== 1 ? 's' : ''} ready for dispatch</div>
        </div>
        <div style="display:flex; gap:16px; align-items:center;">
          <div style="text-align:right">
            <div style="font-size:11px;color:var(--ok);text-transform:uppercase;font-weight:700">Total Cleared</div>
            <div class="mono" style="font-size:14px;font-weight:600">${totalPcs} pcs</div>
          </div>
          <button class="btn btn-ghost btn-sm" onclick="refreshQC()"><i class="ti ti-refresh"></i></button>
        </div>
      </div>
      ${!hasCleared ? `
      <div class="imf-empty">
        <div class="ic"><i class="ti ti-circle-check"></i></div>
        <h3>No cleared TAGs</h3>
        <p>QC-cleared route cards awaiting dispatch will appear here.</p>
      </div>` : `
      <div class="imf-table-scroll">
        <table class="imf-table">
          <thead><tr>
            <th class="pin">TAG ID</th>
            <th>Part</th>
            <th>Customer</th>
            <th>Batch Code</th>
            <th>Heat Code</th>
            <th class="num">Cleared Qty</th>
            <th class="num grp grp-l">OEM</th>
            <th class="num grp">Spares</th>
            <th class="num grp grp-r">Market</th>
          </tr></thead>
          <tbody>${S_QC.clearedCards.map(clearedTableRow).join('')}</tbody>
        </table>
      </div>`}
    </div>
    ${hasCleared ? `<div class="imf-cards mt-12">${S_QC.clearedCards.map(clearedCard).join('')}</div>` : ''}`;
}

function clearedTableRow(c) {
  const oem    = c.qty_oem    || 0;
  const spares = c.qty_spares || 0;
  const market = c.qty_market || 0;

  return `
    <tr>
      <td class="pin mono">${c.id}</td>
      <td>${c.partName || '—'}</td>
      <td>${c.customerName || '—'}</td>
      <td class="mono">${c.batchCode || '—'}</td>
      <td class="mono">${c.heatCode || '—'}</td>
      <td class="num" style="color:var(--ok);font-weight:700">${c.currentQty || 0}</td>
      <td class="num grp grp-l">${oem}</td>
      <td class="num grp">${spares}</td>
      <td class="num grp grp-r">${market}</td>
    </tr>`;
}

function clearedCard(c) {
  const oem    = c.qty_oem    || 0;
  const spares = c.qty_spares || 0;
  const market = c.qty_market || 0;

  return `
    <div class="imf-card">
      <div class="imf-card-top">
        <span class="imf-mono">${c.id}</span>
        <div class="grow"></div>
        <span class="imf-badge st-qc_cleared"><i class="ti ti-rosette-discount-check"></i> Cleared</span>
      </div>
      <div class="imf-card-lead">
        <span class="nm">${c.partName || '—'}</span>
        <span class="qty">${c.currentQty || 0} <small>pcs</small></span>
      </div>
      <div class="imf-card-meta">
        <i class="ti ti-building-factory-2"></i> ${c.customerName || '—'}
      </div>
      <div class="imf-split">
        <div style="background:var(--commercial-tint)">
          <div class="k">OEM</div>
          <div class="v">${oem}</div>
        </div>
        <div style="background:var(--commercial-tint)">
          <div class="k">SPARES</div>
          <div class="v">${spares}</div>
        </div>
        <div style="background:var(--commercial-tint)">
          <div class="k">MARKET</div>
          <div class="v">${market}</div>
        </div>
      </div>
      <div class="imf-card-foot" style="justify-content:space-between">
        <span>Batch: <strong class="mono">${c.batchCode || '—'}</strong></span>
        <span>Heat: <strong class="mono">${c.heatCode || '—'}</strong></span>
      </div>
    </div>`;
}

/* ── Boot ────────────────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', init);
