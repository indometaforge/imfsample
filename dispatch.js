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
let _dispHeader       = { customerId:'', customerName:'', poId:'', poNo:'', partId:'', partNo:'', partName:'', stream:'oem', date:'', pieceRateINR:0 };
let _dispRows         = [];  // [{tagId, qty, invoiceNo, vehicle, batchCode, heatCode, verified, tagData}]
let _poEditId         = null;
let _poLines          = [];  // temp PO lines being edited

const S_DSP = {
  pos:         [],
  dispatches:  [],
  clearedCards: [],
};

/* ── Boot ────────────────────────────────────────────────────────────── */
async function init() {
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
      <button onclick="switchTab('${t.key}')"
        style="flex:1;padding:8px 4px;border:none;
               background:${active ? 'var(--acc)' : 'var(--sur)'};
               color:${active ? '#fff' : 'var(--txt)'};
               border-radius:6px;font-size:12px;font-weight:700;cursor:pointer;
               display:flex;align-items:center;justify-content:center;gap:4px;transition:background .15s">
        <i class="ti ${t.icon}" style="font-size:13px"></i> ${t.label}
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
  const openPOs  = S_DSP.pos.filter(p => p.status === 'open').length;
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
      <div style="background:var(--err);color:#fff;border-radius:var(--rs);padding:12px 16px;margin-bottom:14px;display:flex;align-items:center;gap:10px">
        <i class="ti ti-alert-circle" style="font-size:22px;flex-shrink:0"></i>
        <div>
          <div style="font-weight:800">${overdue} Overdue PO Line${overdue !== 1 ? 's' : ''}</div>
          <div style="font-size:12px;opacity:.85">Delivery dates have passed — check Tracksheet</div>
        </div>
        <button onclick="switchTab('tracksheet')"
          style="margin-left:auto;border:none;background:rgba(255,255,255,.2);color:#fff;border-radius:6px;padding:7px 12px;cursor:pointer;font-size:12px;font-weight:700">
          Tracksheet
        </button>
      </div>` : ''}

    <div class="stats-3" style="margin-bottom:14px">
      <div class="stat-card ${cleared > 0 ? 'ok' : ''}">
        <div class="stat-lbl">Cleared TAGs</div>
        <div class="stat-val">${cleared}</div>
        <div class="stat-sub">Ready to dispatch</div>
      </div>
      <div class="stat-card ${todayDsp > 0 ? 'ok' : ''}">
        <div class="stat-lbl">Dispatched Today</div>
        <div class="stat-val">${todayDsp}</div>
        <div class="stat-sub">${fmtDate(today)}</div>
      </div>
      <div class="stat-card ${overdue > 0 ? 'err' : dueSoon > 0 ? 'warn' : 'ok'}">
        <div class="stat-lbl">Due This Week</div>
        <div class="stat-val">${dueSoon + overdue}</div>
        <div class="stat-sub">${overdue > 0 ? `${overdue} overdue!` : 'On track'}</div>
      </div>
    </div>

    <div style="display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap">
      <button class="btn btn-p" style="flex:1" onclick="switchTab('dispatch')">
        <i class="ti ti-truck"></i> New Dispatch
      </button>
      <button class="btn btn-s" style="flex:1" onclick="switchTab('tracksheet')">
        <i class="ti ti-table"></i> Tracksheet
      </button>
    </div>

    ${S_DSP.dispatches.slice(0, 5).length > 0 ? `
      <div style="font-size:11px;font-weight:700;color:var(--txt-muted);letter-spacing:.06em;margin-bottom:8px">RECENT DISPATCHES</div>
      ${S_DSP.dispatches.slice(0, 5).map(dspRowCompact).join('')}` : ''}

    <div style="display:flex;justify-content:flex-end;margin-top:6px">
      <button class="btn btn-s btn-sm" onclick="refreshDSP()"><i class="ti ti-refresh"></i> Refresh</button>
    </div>`;
}

function dspRowCompact(d) {
  return `
    <div class="card" style="margin-bottom:8px">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px">
        <div>
          <div style="font-weight:700;font-size:13px">${d.partName || '—'}</div>
          <div style="font-size:11px;color:var(--txt-muted)">${d.customerName || '—'} · ${fmtDate(d.date)} · ${(d.rows||[]).length} TAG${(d.rows||[]).length!==1?'s':''}</div>
        </div>
        <div style="text-align:right;flex-shrink:0">
          <div style="font-weight:800;font-size:16px;color:var(--txt)">${d.totalQty || 0} pcs</div>
          <div style="font-size:10px;color:var(--txt-muted)">${(d.stream||'').toUpperCase()}</div>
        </div>
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
    <div style="display:flex;gap:8px;margin-bottom:12px;align-items:center">
      ${canEdit ? `<button class="btn btn-p" onclick="openPoModal(null)"><i class="ti ti-plus"></i> New PO</button>` : ''}
      <button class="btn btn-s btn-sm" style="margin-left:auto" onclick="refreshDSP()"><i class="ti ti-refresh"></i></button>
    </div>

    ${openPOs.length
      ? `<div style="font-size:11px;font-weight:700;color:var(--txt-muted);letter-spacing:.06em;margin-bottom:8px">OPEN POs (${openPOs.length})</div>
         ${openPOs.map(p => poCard(p, canEdit)).join('')}`
      : `<div class="empty" style="padding:20px 0"><div class="empty-ic"><i class="ti ti-file-text"></i></div><h3>No open POs</h3><p>Create a purchase order to track deliveries.</p></div>`}

    ${closedPOs.length ? `
      <div style="border-top:1px solid var(--bdr);margin:16px 0 10px;padding-top:12px">
        <div style="font-size:11px;font-weight:700;color:var(--txt-muted);letter-spacing:.06em;margin-bottom:8px">CLOSED POs (${closedPOs.length})</div>
        ${closedPOs.slice(0, 10).map(p => poCard(p, false)).join('')}
      </div>` : ''}`;
}

function poCard(p, canEdit) {
  const lines = p.lines || [];
  return `
    <div class="card" style="margin-bottom:10px;opacity:${p.status==='open'?1:0.7}">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px;margin-bottom:10px">
        <div>
          <div style="font-weight:800;font-size:14px">${p.poNo || '—'}</div>
          <div style="font-size:11px;color:var(--txt-muted)">${p.customerName || '—'} · ${fmtDate(p.poDate)}</div>
          ${p.deliveryMonth ? `<div style="font-size:11px;color:var(--txt-muted)">Delivery: ${p.deliveryMonth}</div>` : ''}
        </div>
        <div style="display:flex;gap:6px;align-items:flex-start;flex-shrink:0">
          <span style="font-size:10px;font-weight:700;padding:2px 8px;border-radius:4px;
                       background:${p.status==='open'?'var(--ok-bg)':'var(--bg)'};
                       border:1px solid ${p.status==='open'?'var(--ok-bdr)':'var(--bdr)'};
                       color:${p.status==='open'?'var(--ok)':'var(--txt-muted)'}">
            ${p.status === 'open' ? 'Open' : 'Closed'}
          </span>
          ${canEdit ? `<button class="btn btn-s btn-sm" onclick="openPoModal('${p.id}')"><i class="ti ti-edit"></i></button>` : ''}
        </div>
      </div>
      ${lines.map(l => {
        const pct    = l.scheduledQty > 0 ? Math.round(((l.dispatchedQty || 0) / l.scheduledQty) * 100) : 0;
        const pctCol = pct >= 100 ? 'var(--ok)' : l.dueDate < dateStr() ? 'var(--err)' : 'var(--acc)';
        return `
          <div style="background:var(--bg);border-radius:6px;padding:8px 10px;margin-bottom:6px">
            <div style="display:flex;align-items:center;justify-content:space-between;gap:8px">
              <div>
                <div style="font-weight:700;font-size:13px">${l.partName || '—'}</div>
                <div style="font-size:11px;color:var(--txt-muted)">Due: ${fmtDate(l.dueDate)} · ${fmtINR(l.pieceRateINR || 0)}/pc</div>
              </div>
              <div style="text-align:right;flex-shrink:0">
                <div style="font-weight:800;font-size:13px;color:${pctCol}">${l.dispatchedQty||0} / ${l.scheduledQty}</div>
                <div style="font-size:10px;color:${pctCol}">${pct}%</div>
              </div>
            </div>
            <div style="background:var(--bdr);border-radius:99px;height:4px;margin-top:6px;overflow:hidden">
              <div style="height:100%;border-radius:99px;background:${pctCol};width:100%;
                          transform:scaleX(${(Math.min(pct,100) / 100).toFixed(4)});transform-origin:left;
                          transition:transform .3s"></div>
            </div>
          </div>`;
      }).join('')}
    </div>`;
}

/* ── PO modal (create / edit) ────────────────────────────────────────── */
function openPoModal(id) {
  _poEditId = id;
  const p = id ? S_DSP.pos.find(x => x.id === id) : null;
  _poLines = p ? JSON.parse(JSON.stringify(p.lines || [])) : [];

  const custOpts = (S.customers || []).map(c => `<option value="${c.id}" ${p?.customerId===c.id?'selected':''}>${c.name}</option>`).join('');

  openModal(`
    <div class="modal-handle"></div>
    <div class="modal-title">${id ? 'Edit PO' : 'New Purchase Order'}</div>

    <div class="f">
      <label>Customer <span style="color:var(--err)">*</span></label>
      <select id="po-cust" style="font-size:13px">
        <option value="">— Select customer —</option>
        ${custOpts}
      </select>
    </div>
    <div class="row-2">
      <div class="f">
        <label>PO Number <span style="color:var(--err)">*</span></label>
        <input type="text" id="po-no" value="${p?.poNo||''}" placeholder="e.g. PO-2024-001" style="font-size:13px">
      </div>
      <div class="f">
        <label>PO Date</label>
        <input type="date" id="po-date" value="${p?.poDate||dateStr()}" style="font-size:13px">
      </div>
    </div>
    <div class="f">
      <label>Delivery Month</label>
      <input type="month" id="po-month" value="${p?.deliveryMonth||''}" style="font-size:13px">
    </div>
    <div class="f">
      <label>Remarks</label>
      <input type="text" id="po-remarks" value="${p?.remarks||''}" placeholder="Optional remarks" style="font-size:13px">
    </div>

    <div style="border-top:1px solid var(--bdr);margin:12px 0 10px;padding-top:12px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
        <div style="font-size:12px;font-weight:700">PO Lines</div>
        <button class="btn btn-s btn-sm" onclick="poAddLine()"><i class="ti ti-plus"></i> Add Part</button>
      </div>
      <div id="po-lines-list"></div>
    </div>

    <div id="po-modal-err" style="display:none;color:var(--err);font-size:12px;font-weight:700;margin-bottom:8px"></div>
    <div style="display:flex;gap:8px">
      <button class="btn btn-s" style="flex:1" onclick="closeModal()">Cancel</button>
      <button class="btn btn-p" style="flex:1" onclick="savePo()">
        <i class="ti ti-check"></i> ${id ? 'Save Changes' : 'Create PO'}
      </button>
    </div>`);

  renderPoLines();
}

function poAddLine() {
  poReadLines();
  _poLines.push({ lineNo: _poLines.length + 1, partId: '', partNo: '', partName: '', scheduledQty: 0, dueDate: tomStr(), pieceRateINR: 0, dispatchedQty: 0 });
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
    const partEl = document.getElementById(`po-part-${i}`);
    const partId = partEl?.value || l.partId;
    const part   = S.parts.find(p => p.id === partId);
    return {
      ...l,
      partId,
      partNo:   part?.no   || part?.partNo   || l.partNo,
      partName: part?.name || part?.partName || l.partName,
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
    el.innerHTML = `<div style="font-size:12px;color:var(--txt-muted);padding:6px 0">No lines added yet.</div>`;
    return;
  }
  const partOpts = (S.parts || []).map(p => `<option value="${p.id}">${p.no || ''} — ${p.name}</option>`).join('');
  el.innerHTML = _poLines.map((l, i) => `
    <div style="background:var(--bg);border-radius:6px;padding:8px 10px;margin-bottom:8px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
        <div style="font-size:11px;font-weight:700;color:var(--txt-muted)">LINE ${i + 1}</div>
        <button onclick="poReadLines();poRemoveLine(${i})" style="border:none;background:none;color:var(--err);cursor:pointer;font-size:13px">
          <i class="ti ti-trash"></i>
        </button>
      </div>
      <div class="f" style="margin-bottom:6px">
        <label>Part</label>
        <select id="po-part-${i}" style="font-size:12px" onchange="poReadLines()">
          <option value="">— Select part —</option>
          ${partOpts.replace(`value="${l.partId}"`, `value="${l.partId}" selected`)}
        </select>
      </div>
      <div class="row-3">
        <div class="f">
          <label>Qty</label>
          <input type="number" id="po-qty-${i}" value="${l.scheduledQty}" min="0" style="font-size:12px">
        </div>
        <div class="f">
          <label>Due Date</label>
          <input type="date" id="po-due-${i}" value="${l.dueDate||''}" style="font-size:12px">
        </div>
        <div class="f">
          <label>Rate (₹/pc)</label>
          <input type="number" id="po-rate-${i}" value="${l.pieceRateINR||0}" min="0" style="font-size:12px">
        </div>
      </div>
    </div>`).join('');
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
        data.lines = _poLines.map(l => {
          const origLine = (orig.lines || []).find(ol => ol.partId === l.partId);
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
  } catch (e) { toast('Error: ' + e.message); }
}

/* ═══════════════════════════════════════════════════════════════════
   TAB: DISPATCH (session)
   ═══════════════════════════════════════════════════════════════════ */
function renderDispatch() {
  const el = document.getElementById('tab-body');
  if (!el) return;

  const canDispatch = canDo('dispatch') || S.sess?.role === 'admin';
  if (!canDispatch) {
    el.innerHTML = `<div class="empty"><div class="empty-ic"><i class="ti ti-lock"></i></div><h3>Access Restricted</h3><p>Dispatch role required.</p></div>`;
    return;
  }

  el.innerHTML = `
    <!-- Header card -->
    <div class="card" style="margin-bottom:12px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
        <div style="font-size:13px;font-weight:700">Dispatch Header</div>
        ${_dispHeaderLocked
          ? `<button class="btn btn-s btn-sm" onclick="clearDispatchHeader()"><i class="ti ti-lock-open"></i> Unlock</button>`
          : ''}
      </div>

      ${_dispHeaderLocked ? renderDispatchHeaderLocked() : renderDispatchHeaderForm()}
    </div>

    ${_dispHeaderLocked ? renderDispatchRows() : ''}`;
}

function renderDispatchHeaderForm() {
  const openPOs   = S_DSP.pos.filter(p => p.status === 'open');
  const custOpts  = [...new Set(openPOs.map(p => p.customerId))].map(cid => {
    const po = openPOs.find(p => p.customerId === cid);
    return `<option value="${cid}" ${_dispHeader.customerId===cid?'selected':''}>${po?.customerName||cid}</option>`;
  }).join('');

  const filteredPOs = _dispHeader.customerId
    ? openPOs.filter(p => p.customerId === _dispHeader.customerId)
    : openPOs;
  const poOpts = filteredPOs.map(p => `<option value="${p.id}" ${_dispHeader.poId===p.id?'selected':''}>${p.poNo}</option>`).join('');

  const selPO    = S_DSP.pos.find(p => p.id === _dispHeader.poId);
  const partOpts = selPO
    ? (selPO.lines || []).map(l => `<option value="${l.partId}" data-rate="${l.pieceRateINR||0}" ${_dispHeader.partId===l.partId?'selected':''}>${l.partName}</option>`).join('')
    : '';
  const streamOpts = STREAMS.map(s => `<option value="${s.key}" ${_dispHeader.stream===s.key?'selected':''}>${s.label}</option>`).join('');

  return `
    <div class="f">
      <label>Customer <span style="color:var(--err)">*</span></label>
      <select id="dh-cust" onchange="dspOnCustChange()" style="font-size:13px">
        <option value="">— Select customer —</option>
        ${custOpts}
      </select>
    </div>
    <div class="row-2">
      <div class="f">
        <label>PO <span style="color:var(--err)">*</span></label>
        <select id="dh-po" onchange="dspOnPoChange()" style="font-size:13px">
          <option value="">— Select PO —</option>
          ${poOpts}
        </select>
      </div>
      <div class="f">
        <label>Part <span style="color:var(--err)">*</span></label>
        <select id="dh-part" onchange="dspOnPartChange()" style="font-size:13px">
          <option value="">— Select part —</option>
          ${partOpts}
        </select>
      </div>
    </div>
    <div class="row-2">
      <div class="f">
        <label>Stream <span style="color:var(--err)">*</span></label>
        <select id="dh-stream" style="font-size:13px">${streamOpts}</select>
      </div>
      <div class="f">
        <label>Date <span style="color:var(--err)">*</span></label>
        <input type="date" id="dh-date" value="${_dispHeader.date || dateStr()}" style="font-size:13px">
      </div>
    </div>
    <div id="dh-err" style="display:none;color:var(--err);font-size:12px;font-weight:700;margin-bottom:8px"></div>
    <button class="btn btn-p" style="width:100%" onclick="lockDispatchHeader()">
      <i class="ti ti-lock"></i> Lock Header &amp; Start Scanning
    </button>`;
}

function dspOnCustChange() {
  _dispHeader.customerId = document.getElementById('dh-cust')?.value || '';
  _dispHeader.customerName = S.customers.find(c => c.id === _dispHeader.customerId)?.name || '';
  _dispHeader.poId = '';
  _dispHeader.partId = '';
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
  const po      = S_DSP.pos.find(p => p.id === _dispHeader.poId);
  const line    = (po?.lines || []).find(l => l.partId === _dispHeader.partId);
  _dispHeader.partName      = line?.partName || S.parts.find(p => p.id === _dispHeader.partId)?.name || '';
  _dispHeader.partNo        = line?.partNo   || S.parts.find(p => p.id === _dispHeader.partId)?.no   || '';
  _dispHeader.pieceRateINR  = parseFloat(selOpt?.dataset.rate || '0') || 0;
}

function lockDispatchHeader() {
  // Read current form values
  _dispHeader.customerId    = document.getElementById('dh-cust')?.value   || _dispHeader.customerId;
  _dispHeader.poId          = document.getElementById('dh-po')?.value     || _dispHeader.poId;
  _dispHeader.partId        = document.getElementById('dh-part')?.value   || _dispHeader.partId;
  _dispHeader.stream        = document.getElementById('dh-stream')?.value || _dispHeader.stream;
  _dispHeader.date          = document.getElementById('dh-date')?.value   || dateStr();

  const cust = S.customers.find(c => c.id === _dispHeader.customerId);
  _dispHeader.customerName  = cust?.name || '';
  const po = S_DSP.pos.find(p => p.id === _dispHeader.poId);
  _dispHeader.poNo = po?.poNo || '';
  const line = (po?.lines || []).find(l => l.partId === _dispHeader.partId);
  _dispHeader.partName = line?.partName || '';
  _dispHeader.partNo   = line?.partNo   || '';
  _dispHeader.pieceRateINR = line?.pieceRateINR || 0;

  const errEl = document.getElementById('dh-err');
  if (!_dispHeader.customerId) { if (errEl) { errEl.textContent = 'Select a customer'; errEl.style.display = ''; } return; }
  if (!_dispHeader.poId)       { if (errEl) { errEl.textContent = 'Select a PO';       errEl.style.display = ''; } return; }
  if (!_dispHeader.partId)     { if (errEl) { errEl.textContent = 'Select a part';     errEl.style.display = ''; } return; }

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
  _dispHeader = { customerId:'', customerName:'', poId:'', poNo:'', partId:'', partNo:'', partName:'', stream:'oem', date:'', pieceRateINR:0 };
  renderDispatch();
}

function renderDispatchHeaderLocked() {
  const streamLbl = STREAMS.find(s => s.key === _dispHeader.stream)?.label || _dispHeader.stream;
  return `
    <div class="kv-list">
      <div class="kv-row"><span class="kv-key">Customer</span><span class="kv-val">${_dispHeader.customerName}</span></div>
      <div class="kv-row"><span class="kv-key">PO</span><span class="kv-val">${_dispHeader.poNo}</span></div>
      <div class="kv-row"><span class="kv-key">Part</span><span class="kv-val">${_dispHeader.partName}</span></div>
      <div class="kv-row"><span class="kv-key">Stream</span><span class="kv-val">${streamLbl}</span></div>
      <div class="kv-row"><span class="kv-key">Date</span><span class="kv-val">${fmtDate(_dispHeader.date)}</span></div>
      <div class="kv-row"><span class="kv-key">Rate</span><span class="kv-val">${fmtINR(_dispHeader.pieceRateINR)}/pc</span></div>
    </div>`;
}

function renderDispatchRows() {
  const totalQty = _dispRows.reduce((s, r) => s + (r.qty || 0), 0);
  const totalVal = totalQty * (_dispHeader.pieceRateINR || 0);

  return `
    <!-- Scan area -->
    <div class="card" style="margin-bottom:12px">
      <div style="font-size:13px;font-weight:700;margin-bottom:10px;display:flex;align-items:center;gap:6px">
        <i class="ti ti-scan" style="color:var(--acc)"></i> Scan TAG to Add Row
      </div>
      <div style="display:flex;gap:8px">
        <input type="text" id="dsp-scan-input" placeholder="Enter TAG UID…"
          style="flex:1;font-family:monospace;font-size:15px;text-transform:uppercase;letter-spacing:.05em"
          onkeydown="if(event.key==='Enter')dspScanTag()">
        <button class="btn btn-s" onclick="openQrScanner(dspOnScan,'Scan TAG')" style="padding:10px 14px">
          <i class="ti ti-qrcode"></i>
        </button>
      </div>
      <button class="btn btn-s" style="width:100%;margin-top:8px" onclick="dspScanTag()">
        <i class="ti ti-search"></i> Verify TAG
      </button>
      <div id="dsp-scan-err" style="display:none;margin-top:8px;background:var(--err-bg);border:1px solid var(--err-bdr);
                                    border-radius:var(--rxs);padding:8px 12px;font-size:12px;font-weight:700;color:var(--err)"></div>
    </div>

    <!-- Rows list -->
    ${_dispRows.length ? `
      <div style="font-size:11px;font-weight:700;color:var(--txt-muted);letter-spacing:.06em;margin-bottom:8px">
        ROWS (${_dispRows.length}) · ${totalQty} pcs · ${fmtINR(totalVal)}
      </div>
      ${_dispRows.map((row, i) => dspRow(row, i)).join('')}

      <button class="btn btn-p" style="width:100%;margin-top:8px;font-size:15px;padding:14px" onclick="dspConfirmFinalize()">
        <i class="ti ti-truck"></i> Finalise Dispatch (${totalQty} pcs)
      </button>` : `
      <div class="empty" style="padding:20px 0">
        <div class="empty-ic"><i class="ti ti-scan"></i></div>
        <h3>No rows yet</h3><p>Scan a QC-cleared TAG to add it.</p>
      </div>`}`;
}

function dspOnScan(tagId) {
  const el = document.getElementById('dsp-scan-input');
  if (el) el.value = tagId.toUpperCase();
  dspScanTag();
}

async function dspScanTag() {
  const el    = document.getElementById('dsp-scan-input');
  const tagId = (el?.value || '').trim().toUpperCase();
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
    if (errEl) { errEl.textContent = 'Error: ' + e.message; errEl.style.display = ''; }
  }
}

function dspRow(row, idx) {
  const maxQty = row.tagData ? (row.tagData[`qty_${_dispHeader.stream}`] || 0) : row.qty;
  return `
    <div class="card" style="margin-bottom:8px;border:1.5px solid var(--ok)">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
        <span class="tag-uid">${row.tagId}</span>
        <button onclick="dspRemoveRow(${idx})" style="border:none;background:none;color:var(--err);cursor:pointer;font-size:14px;padding:2px 4px">
          <i class="ti ti-trash"></i>
        </button>
      </div>
      <div style="font-size:11px;color:var(--txt-muted);margin-bottom:8px">
        Batch: ${row.batchCode || '—'} · Heat: ${row.heatCode || '—'} · Available: ${maxQty}
      </div>
      <div class="row-3">
        <div class="f">
          <label>Qty <span style="color:var(--err)">*</span></label>
          <input type="number" id="dr-qty-${idx}" value="${row.qty}" min="1" max="${maxQty}"
            oninput="dspReadRow(${idx})" style="font-size:14px;font-weight:700;text-align:center">
        </div>
        <div class="f">
          <label>Invoice No</label>
          <input type="text" id="dr-inv-${idx}" value="${row.invoiceNo}"
            oninput="dspReadRow(${idx})" placeholder="INV-001" style="font-size:13px">
        </div>
        <div class="f">
          <label>Vehicle No</label>
          <input type="text" id="dr-veh-${idx}" value="${row.vehicle}"
            oninput="dspReadRow(${idx})" placeholder="MH-12-AB-1234" style="font-size:12px">
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
          if (l.partId === _dispHeader.partId) {
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
    _dispHeader = { customerId:'', customerName:'', poId:'', poNo:'', partId:'', partNo:'', partName:'', stream:'oem', date:'', pieceRateINR:0 };
    await refreshDSP();
  } catch (e) {
    console.error('finalizeDispatch:', e);
    toast('Dispatch failed: ' + e.message);
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
    el.innerHTML = `<div class="empty"><div class="empty-ic"><i class="ti ti-table"></i></div><h3>No open POs</h3><p>Create POs in the POs tab to track delivery compliance.</p></div>`;
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
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
      <div style="font-size:11px;color:var(--txt-muted)">${allRows.length} active PO line${allRows.length !== 1 ? 's' : ''}</div>
      <button class="btn btn-s btn-sm" onclick="refreshDSP()"><i class="ti ti-refresh"></i></button>
    </div>
    <div class="tracksheet-table" style="overflow-x:auto">
      <table style="width:100%;border-collapse:collapse;font-size:12px">
        <thead>
          <tr style="background:var(--imf-navy);color:#fff">
            <th style="padding:8px 10px;text-align:left;font-weight:700;white-space:nowrap">Customer / PO</th>
            <th style="padding:8px 6px;text-align:left;font-weight:700">Part</th>
            <th style="padding:8px 6px;text-align:center;font-weight:700;white-space:nowrap">Dispatched / Sched.</th>
            <th style="padding:8px 6px;text-align:center;font-weight:700">Due</th>
            <th style="padding:8px 6px;text-align:center;font-weight:700">Status</th>
          </tr>
        </thead>
        <tbody>
          ${allRows.map(({ po, line: l, rag }, i) => {
            const pct    = l.scheduledQty > 0 ? Math.round(((l.dispatchedQty || 0) / l.scheduledQty) * 100) : 0;
            const ragBg  = rag.code === 'r' ? 'var(--err-bg)' : rag.code === 'a' ? 'var(--warn-bg)' : 'var(--ok-bg)';
            const ragBdr = rag.code === 'r' ? 'var(--err-bdr)' : rag.code === 'a' ? 'var(--warn-bdr)' : 'var(--ok-bdr)';
            const ragCol = rag.code === 'r' ? 'var(--err)' : rag.code === 'a' ? 'var(--warn)' : 'var(--ok)';
            const ragIcon = rag.code === 'r' ? 'ti-alert-circle' : rag.code === 'a' ? 'ti-clock' : 'ti-check';
            return `
              <tr style="background:${i % 2 === 0 ? 'var(--sur)' : 'var(--bg)'}">
                <td style="padding:8px 10px">
                  <div style="font-weight:700">${po.customerName}</div>
                  <div style="font-size:10px;color:var(--txt-muted)">${po.poNo}</div>
                </td>
                <td style="padding:8px 6px">
                  <div style="font-weight:600">${l.partName || '—'}</div>
                </td>
                <td style="padding:8px 6px;text-align:center">
                  <div style="font-weight:800">${l.dispatchedQty||0} / ${l.scheduledQty}</div>
                  <div style="background:var(--bdr);border-radius:99px;height:4px;margin-top:4px;overflow:hidden">
                    <div style="height:100%;border-radius:99px;background:${ragCol};width:${Math.min(pct,100)}%"></div>
                  </div>
                </td>
                <td style="padding:8px 6px;text-align:center;font-size:11px;color:var(--txt-muted);white-space:nowrap">${fmtDate(l.dueDate)}</td>
                <td style="padding:8px 6px;text-align:center">
                  <span style="font-size:11px;font-weight:700;background:${ragBg};border:1px solid ${ragBdr};color:${ragCol};border-radius:4px;padding:2px 8px;white-space:nowrap">
                    <i class="ti ${ragIcon}" aria-hidden="true"></i> ${rag.label}
                  </span>
                </td>
              </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>
    <div class="tracksheet-cards">
      ${allRows.map(({ po, line: l, rag }) => {
        const pct    = l.scheduledQty > 0 ? Math.round(((l.dispatchedQty || 0) / l.scheduledQty) * 100) : 0;
        const ragBg  = rag.code === 'r' ? 'var(--err-bg)' : rag.code === 'a' ? 'var(--warn-bg)' : 'var(--ok-bg)';
        const ragBdr = rag.code === 'r' ? 'var(--err-bdr)' : rag.code === 'a' ? 'var(--warn-bdr)' : 'var(--ok-bdr)';
        const ragCol = rag.code === 'r' ? 'var(--err)' : rag.code === 'a' ? 'var(--warn)' : 'var(--ok)';
        const ragIcon = rag.code === 'r' ? 'ti-alert-circle' : rag.code === 'a' ? 'ti-clock' : 'ti-check';
        return `
          <div class="card" style="margin-bottom:8px">
            <div style="display:flex;justify-content:space-between;gap:8px;align-items:flex-start">
              <div style="min-width:0">
                <div style="font-weight:700;font-size:13px">${po.customerName}</div>
                <div style="font-size:10px;color:var(--txt-muted)">${po.poNo}</div>
              </div>
              <span style="flex-shrink:0;font-size:11px;font-weight:700;background:${ragBg};border:1px solid ${ragBdr};color:${ragCol};border-radius:4px;padding:2px 8px;white-space:nowrap">
                <i class="ti ${ragIcon}" aria-hidden="true"></i> ${rag.label}
              </span>
            </div>
            <div style="font-size:12px;font-weight:600;margin-top:8px">${l.partName || '—'}</div>
            <div style="display:flex;justify-content:space-between;align-items:center;margin-top:6px;font-size:11px;color:var(--txt-muted)">
              <span><strong style="color:var(--txt)">${l.dispatchedQty||0} / ${l.scheduledQty}</strong> dispatched</span>
              <span>Due ${fmtDate(l.dueDate)}</span>
            </div>
            <div style="background:var(--bdr);border-radius:99px;height:4px;margin-top:6px;overflow:hidden">
              <div style="height:100%;border-radius:99px;background:${ragCol};width:${Math.min(pct,100)}%"></div>
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
