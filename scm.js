/* ═══════════════════════════════════════════════════════════════════
   IMF ProTrack — Supply Chain Management (scm.js)
   Indometa Forging -> CNC suppliers -> Indometa Gear unit WIP tracking.
   Reads the existing `inward` collection (written by store.js) to
   compute Supplier WIP — never writes to it, so existing Gear-unit
   receiving is untouched.
   ═══════════════════════════════════════════════════════════════════ */

'use strict';

/* ══════════════════════════════════════════════════════════════════════
   STATE
   ══════════════════════════════════════════════════════════════════════ */
let activeTab = null;
let searchQ   = '';
let _dispExpanded = {};   /* dispatchId -> bool, lot-allocation breakdown toggle */
let _bnExpanded    = {};   /* fpn -> bool, internal-bottleneck lot breakdown toggle */
let _planFilter = 'active'; /* 'active', 'today_plus', 'all' */
let _selectedCalDate = null;

/* Edit/Delete on every SCM entry: edit is admin-only, delete is restricted
   to one named person by explicit request — mirrors the existing
   Tanmay-only delete already in place for forging plans. */
const isScmAdmin = () => S.sess?.role === 'admin';
const isScmTanmay = () => S.sess?.name === 'Tanmay Indani';

/* Forging runs 2 shifts, not the 3-shift pattern (S.shifts in core.js) used
   by soft/hard machining — kept local to this module so it never affects
   any other stage's shift list. */
const FORGING_SHIFTS = {
  s1: { label: 'Shift 1' },
  s2: { label: 'Shift 2' },
};

const AGE_WARN_DAYS = 3;
const AGE_CRIT_DAYS = 5;
const FORECAST_DAYS = 5;
const DEFAULT_LEAD_TIME_DAYS = 5;   /* fallback when a supplier+CPN has no receipt history yet */
const SCRAP_AUTO_APPROVE_PCT = 0.02;     /* 2% of the referenced dispatch qty */
const SCRAP_AUTO_APPROVE_MIN_QTY = 5;    /* always auto-approve up to this many pcs */

const SCRAP_DEFECT_CODES = [
  { v: 'cracked',           l: 'Cracked / Fractured' },
  { v: 'porosity',          l: 'Porosity / Internal Void' },
  { v: 'dimensional',       l: 'Dimensional Out of Tolerance' },
  { v: 'surface_finish',    l: 'Surface Finish Defect' },
  { v: 'hardness',          l: 'Hardness / Material Property' },
  { v: 'machining_damage',  l: 'Machining Damage' },
  { v: 'other',             l: 'Other' },
];
const defectLabel = (v) => (SCRAP_DEFECT_CODES.find(d => d.v === v) || {}).l || v || '—';

const TABS = [
  { key: 'plan',        label: 'Forging Plan',       icon: 'ti-calendar-event', perm: 'scm_production' },
  { key: 'calendar',    label: 'Calendar View',      icon: 'ti-calendar',       perm: 'scm_production' },
  { key: 'production',  label: 'Forging Production', icon: 'ti-stack-2',        perm: 'scm_production' },
  { key: 'dispatch',    label: 'Supplier Dispatch',  icon: 'ti-truck-delivery', perm: 'scm_dispatch' },
  { key: 'tower',       label: "Control Tower",      icon: 'ti-radar-2',       perm: 'scm_admin' },
];

const visibleTabs = () => TABS.filter(t => canView(t.perm));

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

  if (!visibleTabs().length) {
    window.location.replace('home.html');
    return;
  }
  activeTab = visibleTabs()[0].key;

  try {
    await loadScmData();
    render();
  } catch (e) {
    console.error('SCM data load failed:', e);
    toast('Error loading SCM data: ' + friendlyError(e), 5000);
    render();
  }

  document.getElementById('loading-screen').style.display = 'none';
  document.getElementById('app').style.display = '';
}

async function loadScmData() {
  const [prodSnap, dispSnap, scrapSnap, inwSnap, planSnap, configDoc] = await Promise.all([
    db.collection('forgingProduction').get(),
    db.collection('supplierDispatches').get(),
    db.collection('scmScrapLedger').get(),
    db.collection('inward').get(),
    db.collection('forgingPlans').get(),
    db.collection('config').doc('scm').get(),
  ]);
  S.forgingProduction  = prodSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  S.supplierDispatches = dispSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  S.scmScrapLedger     = scrapSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  S.inward             = inwSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  S.forgingPlans       = planSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  S.scmConfig          = configDoc.exists ? configDoc.data() : null;
}

async function refreshScm(collection) {
  const snap = await db.collection(collection).get();
  const key = {
    forgingProduction: 'forgingProduction', supplierDispatches: 'supplierDispatches',
    scmScrapLedger: 'scmScrapLedger', forgingPlans: 'forgingPlans',
  }[collection];
  S[key] = snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

/* ══════════════════════════════════════════════════════════════════════
   LAYOUT — TABS + SECTION ROUTER
   ══════════════════════════════════════════════════════════════════════ */
function render() {
  const tabs = visibleTabs();
  const page = document.getElementById('page-content');
  page.innerHTML = `
    <div class="tabs" role="tablist" aria-label="Supply chain sections">
      ${tabs.map(t => `
        <button class="tab ${t.key === activeTab ? 'active' : ''}"
                role="tab" aria-selected="${t.key === activeTab}"
                onclick="switchTab('${t.key}')">
          <i class="ti ${t.icon}" aria-hidden="true"></i> ${t.label}
        </button>`).join('')}
    </div>
    <div id="section-content"></div>
  `;

  // Inject/manage Working Month toggle in topbar actions
  const actionsEl = document.querySelector('.topbar-actions');
  if (actionsEl && !document.getElementById('topbar-wm-toggle')) {
    actionsEl.insertAdjacentHTML('afterbegin', `
      <button id="topbar-wm-toggle" class="btn btn-ghost btn-sm" onclick="openWorkingMonthModal()" style="display:none;align-items:center;gap:6px;font-weight:600">
        <i class="ti ti-calendar-event" aria-hidden="true"></i> Working Month
      </button>
    `);
  }
  const wmToggle = document.getElementById('topbar-wm-toggle');
  if (wmToggle) {
    wmToggle.style.display = (activeTab === 'tower') ? 'inline-flex' : 'none';
  }

  renderSection();
}

function switchTab(key) {
  activeTab = key;
  searchQ = '';
  render();
}

function renderSection() {
  const map = { 
    plan: renderPlan, 
    calendar: renderCalendar,
    production: renderProduction, 
    dispatch: renderDispatch, 
    tower: renderControlTower 
  };
  (map[activeTab] || renderPlan)();
}

function onSearchInput(val) {
  searchQ = val;
  renderSection();
  const el = document.getElementById('scm-search');
  if (el) { el.focus(); el.setSelectionRange(val.length, val.length); }
}

/* ══════════════════════════════════════════════════════════════════════
   SHARED UI HELPERS (module-local — each module owns its own copies,
   per the rest of the codebase; see masters.js/store.js)
   ══════════════════════════════════════════════════════════════════════ */
function emptyState(icon, title, msg) {
  return `
    <div class="imf-empty">
      <div class="ic"><i class="ti ${icon}" aria-hidden="true"></i></div>
      <h3>${title}</h3>
      <p>${msg}</p>
    </div>`;
}

function showModalError(msg) {
  const box = document.getElementById('modal-err');
  if (box) box.innerHTML = `<div class="ebox"><i class="ti ti-alert-triangle" aria-hidden="true"></i><span>${msg}</span></div>`;
}

function modalActions(saveLabel, saveOnclick) {
  return `
    <div class="flex gap-8 mt-16">
      <button class="btn btn-p flex-1" onclick="${saveOnclick}">
        <i class="ti ti-check" aria-hidden="true"></i> ${saveLabel}
      </button>
      <button class="btn btn-s" onclick="closeModal()">Cancel</button>
    </div>`;
}

const AGE_META = {
  ok:   { cls: 'rag-g', icon: 'ti-circle-check',   label: 'Fresh' },
  warn: { cls: 'rag-a', icon: 'ti-alert-triangle', label: 'Aging' },
  crit: { cls: 'rag-r', icon: 'ti-alert-octagon',  label: 'Critical' },
};
const SCRAP_META = {
  pending:  { cls: 'rag-b', icon: 'ti-clock',        label: 'Pending Approval' },
  approved: { cls: 'rag-g', icon: 'ti-circle-check', label: 'Approved' },
  rejected: { cls: 'rag-r', icon: 'ti-circle-x',     label: 'Rejected' },
};
function imfBadge(status, meta) {
  const m = meta[status];
  if (!m) return `<span class="imf-badge rag-b"><i class="ti ti-help-circle" aria-hidden="true"></i>${status || '—'}</span>`;
  return `<span class="imf-badge ${m.cls}"><i class="ti ${m.icon}" aria-hidden="true"></i>${m.label}</span>`;
}

/** Supplier quality-yield badge: green >=98%, amber 95-98%, red <95% */
function yieldBadge(pct) {
  if (pct == null) return '<span class="dim">—</span>';
  const cls = pct >= 98 ? 'rag-g' : pct >= 95 ? 'rag-a' : 'rag-r';
  return `<span class="imf-badge ${cls}">${pct}%</span>`;
}

/** Distinct active FPNs from the master cross-reference, for entry forms.
    Returns {fpn, fpnName} — fpnName is the same across every CPN mapped
    to that FPN (kept in sync on save in masters.js). */
function distinctFpns() {
  const seen = new Map();
  S.fpnCpnMap.filter(m => m.active !== false).forEach(m => {
    if (!seen.has(m.fpn)) seen.set(m.fpn, m.fpnName || '');
  });
  return Array.from(seen, ([fpn, fpnName]) => ({ fpn, fpnName }));
}

/** "FPN — Name" label, or just the FPN if no name is on file yet. */
function fpnLabel(fpn) {
  const name = fpnName(fpn);
  return name ? `${fpn} — ${name}` : fpn;
}

/** Look up the Forging Name for a bare FPN string, for display in tables. */
function fpnName(fpn) {
  return S.fpnCpnMap.find(m => m.fpn === fpn && m.fpnName)?.fpnName || '';
}

/* ══════════════════════════════════════════════════════════════════════
   ENGINE 1 — INTERNAL BOTTLENECK TRACKER (LOT-LEVEL LEDGER)
   Each forgingProduction doc IS a lot, with its own qtyRemaining —
   decremented for real (in a transaction) as dispatches consume it in
   saveDispatch(). This reads the real remaining balance per lot instead
   of re-simulating FIFO consumption against an aggregate dispatched
   total, so the aging shown here matches an auditable per-lot trail.
   ══════════════════════════════════════════════════════════════════════ */
function getBottleneckData() {
  const byFpn = {};
  S.forgingProduction.forEach(p => {
    const remaining = p.qtyRemaining ?? p.qtyForged ?? 0;
    if (remaining <= 0) return;
    if (!byFpn[p.fpn]) byFpn[p.fpn] = { fpn: p.fpn, lots: [] };
    byFpn[p.fpn].lots.push({ id: p.id, lotNo: p.lotNo || p.id, date: p.date, remaining });
  });

  const today = new Date(dateStr() + 'T00:00:00');

  return Object.values(byFpn).map(group => {
    group.lots.sort((a, b) => a.date.localeCompare(b.date));
    const internalWip = group.lots.reduce((s, l) => s + l.remaining, 0);
    const oldestAgeDays = Math.floor((today - new Date(group.lots[0].date + 'T00:00:00')) / 86400000);
    const ageLevel = oldestAgeDays >= AGE_CRIT_DAYS ? 'crit' : oldestAgeDays >= AGE_WARN_DAYS ? 'warn' : 'ok';
    return { fpn: group.fpn, internalWip, oldestAgeDays, ageLevel, lots: group.lots };
  }).filter(r => r.internalWip > 0).sort((a, b) => b.oldestAgeDays - a.oldestAgeDays);
}

/* ══════════════════════════════════════════════════════════════════════
   ENGINE 2 — SUPPLIER BOOK WIP CALCULATOR
   Current Supplier WIP = Opening + Dispatched - Received(via existing
   `inward`, matched through fpnCpnMap.blankPartId — the raw-material/blank
   part linked off the CPN's own Parts & Routing record) - Approved Scrap.
   Clamped at zero; negative raw balance is flagged as an anomaly.
   ══════════════════════════════════════════════════════════════════════ */
function getSupplierWipData() {
  const pairs = {};
  const ensure = (supplierId, cpn) => {
    const key = `${supplierId}|${cpn}`;
    if (!pairs[key]) {
      const sup = S.suppliers.find(s => s.id === supplierId);
      const map = S.fpnCpnMap.find(m => m.cpn === cpn);
      pairs[key] = {
        supplierId, cpn,
        supplierName: sup?.name || '—',
        fpn: map?.fpn || '—', blankPartId: map?.blankPartId || null,
        opening: 0, dispatched: 0, received: 0, approvedScrap: 0,
      };
    }
    return pairs[key];
  };

  S.supplierWipOpening.forEach(o => { ensure(o.supplierId, o.cpn).opening += (+o.openingQty || 0); });
  S.supplierDispatches.forEach(d => { ensure(d.supplierId, d.cpn).dispatched += (+d.qtyDispatched || 0); });
  S.scmScrapLedger.filter(x => x.status === 'approved').forEach(x => { ensure(x.supplierId, x.cpn).approvedScrap += (+x.qtyScrap || 0); });

  Object.values(pairs).forEach(row => {
    if (!row.blankPartId) return;
    row.received = S.inward.reduce((sum, iw) => {
      if (iw.supplierId !== row.supplierId) return sum;
      const part = (iw.parts || []).find(p => p.partId === row.blankPartId);
      return sum + (part ? (+part.qty || 0) : 0);
    }, 0);
  });

  return Object.values(pairs).map(row => {
    const raw = row.opening + row.dispatched - row.received - row.approvedScrap;
    const yieldPct = row.dispatched > 0 ? round(((row.dispatched - row.approvedScrap) / row.dispatched) * 100, 1) : null;
    return { ...row, wip: clamp(raw, 0, Infinity), anomaly: raw < 0, yieldPct };
  }).sort((a, b) => a.supplierName.localeCompare(b.supplierName) || a.cpn.localeCompare(b.cpn));
}

/* ══════════════════════════════════════════════════════════════════════
   ENGINE 3 — 5-DAY ARRIVAL FORECASTING (lead-time based)
   Rather than smoothing a generic daily dispatch rate, this measures
   each supplier+CPN's actual historical lead time (days between a
   dispatch event and the receipt that consumes it, FIFO-matched from
   `supplierDispatches` and the existing `inward` collection — read-only,
   same as the WIP calculator) and uses it to project an exact expected
   arrival date for every still-outstanding (undelivered) dispatch lot.
   Lots whose expected arrival has already passed are reported as
   "overdue" instead of being silently folded into day 1.
   ══════════════════════════════════════════════════════════════════════ */

/**
 * FIFO-matches receipt events against dispatch lots to (a) measure the
 * weighted-average lead time in days and (b) return whichever dispatched
 * quantity has not yet been matched to a receipt ("outstanding lots").
 */
function matchLeadTimeAndOutstanding(dispatchEvents, receiptEvents) {
  const lots = dispatchEvents.map(d => ({ ...d, remaining: d.qty }));
  const receipts = receiptEvents.slice().sort((a, b) => a.date.localeCompare(b.date));

  let li = 0, totalWeightedDays = 0, totalMatched = 0;
  for (const r of receipts) {
    let need = r.qty;
    while (need > 0 && li < lots.length) {
      const lot = lots[li];
      if (lot.remaining <= 0) { li++; continue; }
      const take = Math.min(lot.remaining, need);
      const days = Math.max(0, Math.round((new Date(r.date + 'T00:00:00') - new Date(lot.date + 'T00:00:00')) / 86400000));
      totalWeightedDays += days * take;
      totalMatched += take;
      lot.remaining -= take;
      need -= take;
      if (lot.remaining <= 0) li++;
    }
    // If `need` is still > 0, receipts exceed known dispatches for this pair —
    // that's the WIP calculator's "anomaly" case; nothing more to match here.
  }

  return {
    avgLeadTimeDays: totalMatched > 0 ? totalWeightedDays / totalMatched : null,
    outstanding: lots.filter(l => l.remaining > 0).map(l => ({ id: l.id, date: l.date, qty: l.remaining })),
  };
}

function getForecastData(wipRows) {
  const perRow = wipRows.map(row => {
    const dispatchEvents = S.supplierDispatches
      .filter(d => d.supplierId === row.supplierId && d.cpn === row.cpn)
      .map(d => {
        const scrapAgainst = S.scmScrapLedger
          .filter(x => x.status === 'approved' && x.dispatchRef === d.id)
          .reduce((s, x) => s + (+x.qtyScrap || 0), 0);
        return { id: d.id, date: d.date, qty: Math.max(0, (+d.qtyDispatched || 0) - scrapAgainst) };
      })
      .sort((a, b) => a.date.localeCompare(b.date));

    const receiptEvents = row.blankPartId
      ? S.inward.filter(iw => iw.supplierId === row.supplierId)
          .map(iw => {
            const part = (iw.parts || []).find(p => p.partId === row.blankPartId);
            return part ? { date: iw.date, qty: +part.qty || 0 } : null;
          })
          .filter(Boolean)
      : [];

    return { row, ...matchLeadTimeAndOutstanding(dispatchEvents, receiptEvents) };
  });

  const knownLeadTimes = perRow.map(r => r.avgLeadTimeDays).filter(x => x != null);
  const fallbackLeadTime = knownLeadTimes.length
    ? knownLeadTimes.reduce((s, x) => s + x, 0) / knownLeadTimes.length
    : DEFAULT_LEAD_TIME_DAYS;

  const today = new Date(dateStr() + 'T00:00:00');
  const horizonEnd = new Date(today.getTime() + FORECAST_DAYS * 86400000);

  return perRow.map(({ row, avgLeadTimeDays, outstanding }) => {
    const leadTimeDays = avgLeadTimeDays ?? fallbackLeadTime;
    const estimated = avgLeadTimeDays == null;
    const days = Array.from({ length: FORECAST_DAYS }, (_, i) => {
      const d = new Date(today.getTime() + (i + 1) * 86400000);
      return { date: d.toISOString().slice(0, 10), qty: 0 };
    });

    let overdueQty = 0;
    outstanding.forEach(lot => {
      const arrival = new Date(new Date(lot.date + 'T00:00:00').getTime() + Math.round(leadTimeDays) * 86400000);
      if (arrival <= today) { overdueQty += lot.qty; return; }
      if (arrival > horizonEnd) return; // expected beyond the 5-day window — not shown here
      const idx = Math.round((arrival - today) / 86400000) - 1;
      if (idx >= 0 && idx < FORECAST_DAYS) days[idx].qty += lot.qty;
    });

    const total = days.reduce((s, x) => s + x.qty, 0);
    return {
      supplierId: row.supplierId, supplierName: row.supplierName, cpn: row.cpn, fpn: row.fpn,
      days, total, overdueQty, leadTimeDays: round(leadTimeDays, 1), estimated,
    };
  }).filter(f => f.total > 0 || f.overdueQty > 0).sort((a, b) => (b.overdueQty - a.overdueQty) || (b.total - a.total));
}

/* ══════════════════════════════════════════════════════════════════════
   TAB 0 — FORGING PLAN
   Collection: forgingPlans
   A plan is a LOT (FPN + Hammer + total qty) broken into explicit
   date+shift rows — an 8000pc/4-shift lot is one plan doc with 4
   shiftPlan rows, not 4 separate docs, so lot-level progress can be
   rolled up against all its rows at once. forgingProduction entries
   link back via planId (see saveProduction) once matched.
   ══════════════════════════════════════════════════════════════════════ */
let _planRows = [];   /* draft shift rows while the Add Plan modal is open: [{date, shift, qtyPlanned}] */

const PLAN_STATUS_META = {
  not_started: { cls: 'rag-b', icon: 'ti-clock',          label: 'Not Started' },
  in_progress: { cls: 'rag-a', icon: 'ti-progress',       label: 'In Progress' },
  completed:   { cls: 'rag-g', icon: 'ti-circle-check',   label: 'Completed' },
  behind:      { cls: 'rag-r', icon: 'ti-alert-octagon',  label: 'Behind Schedule' },
};

/* Pure calendar-date arithmetic via Date.UTC — never touches local time,
   so it can't roll the date back a day in timezones ahead of UTC (IST is
   UTC+5:30; the previous version built a *local* midnight Date and then
   read it back through .toISOString(), which is always UTC — local
   midnight on the 24th is still "the 23rd, 18:30" in UTC, so the date
   came out one day early). */
function addDaysStr(d, n) {
  const [y, m, day] = d.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, day + n)).toISOString().slice(0, 10);
}

/** Total planned vs total actual (across ALL its shift rows, any date) for one plan lot */
function planLotProgress(p) {
  const totalPlanned = (p.shiftPlan || []).reduce((s, r) => s + (+r.qtyPlanned || 0), 0);
  const totalActual = S.forgingProduction
    .filter(prod => prod.planId === p.id)
    .reduce((s, prod) => s + (+prod.qtyForged || 0), 0);
  const lastShiftDate = (p.shiftPlan || []).reduce((max, r) => (r.date > max ? r.date : max), '');
  const windowElapsed = !!lastShiftDate && lastShiftDate < dateStr();

  let status;
  if (totalPlanned > 0 && totalActual >= totalPlanned) status = 'completed';
  else if (totalActual <= 0) status = windowElapsed ? 'behind' : 'not_started';
  else status = windowElapsed ? 'behind' : 'in_progress';

  return { totalPlanned, totalActual, status, lastShiftDate };
}

function getFilteredPlans() {
  const q = searchQ.trim().toLowerCase();
  const wm = getActiveWorkingMonth();
  const today = dateStr();
  
  return S.forgingPlans.filter(p => {
    if (q && !(p.fpn || '').toLowerCase().includes(q) && !(p.hammerName || '').toLowerCase().includes(q) && !fpnName(p.fpn).toLowerCase().includes(q)) {
      return false;
    }
    
    const rows = p.shiftPlan || [];
    if (_planFilter === 'active') {
      return rows.some(r => r.date >= wm.start && r.date <= wm.end);
    } else if (_planFilter === 'today_plus') {
      return rows.some(r => r.date >= today);
    }
    return true; // 'all'
  });
}

function renderPlan() {
  const wm = getActiveWorkingMonth();
  const today = dateStr();
  const isTanmay = isScmTanmay();
  const plans = getFilteredPlans();

  // 1. Flatten into shift plan rows
  const rows = [];
  plans.forEach(p => {
    let shifts = (p.shiftPlan || []).slice();
    if (_planFilter === 'active') {
      shifts = shifts.filter(r => r.date >= wm.start && r.date <= wm.end);
    } else if (_planFilter === 'today_plus') {
      shifts = shifts.filter(r => r.date >= today);
    }

    shifts.forEach(r => {
      const actual = S.forgingProduction
        .filter(prod => prod.planId === p.id && 
          (prod.targetPlanDate ? (prod.targetPlanDate === r.date && prod.targetPlanShift === r.shift) : (prod.date === r.date && prod.shift === r.shift))
        )
        .reduce((s, prod) => s + (+prod.qtyForged || 0), 0);
      const status = planShiftRowStatus(r.date, actual, +r.qtyPlanned || 0);

      rows.push({
        planId: p.id,
        fpn: p.fpn,
        hammerName: p.hammerName || '—',
        date: r.date,
        shift: r.shift,
        qtyPlanned: +r.qtyPlanned || 0,
        qtyActual: actual,
        status: status
      });
    });
  });

  // 2. Sort chronologically: Date earliest first, then Shift A, B, C
  rows.sort((a, b) => a.date.localeCompare(b.date) || a.shift.localeCompare(b.shift));

  const styleTag = `
    <style>
      .btn-delete-plan { opacity: 0.6; transition: opacity 0.2s; color: var(--err) !important; background: none; border: none; cursor: pointer; padding: 4px; font-size: 14px; display: inline-flex; align-items: center; justify-content: center; }
      .btn-delete-plan:hover { opacity: 1; }
      .today-highlight { background-color: rgba(30, 43, 107, 0.05) !important; border-left: 3px solid var(--p) !important; }
      .today-badge { background: var(--p); color: #fff; font-size: 10px; font-weight: bold; padding: 2px 6px; border-radius: 4px; margin-left: 6px; text-transform: uppercase; display: inline-block; vertical-align: middle; }
    </style>
  `;

  document.getElementById('section-content').innerHTML = `
    ${styleTag}
    <div class="imf-tablewrap">
      <div class="imf-table-toolbar">
        <div class="grow">
          <div style="font-size:16px;font-weight:700">Forging Plan</div>
          <div class="text-sm text-muted">${rows.length} shift plan${rows.length !== 1 ? 's' : ''} visible</div>
        </div>
        <div class="imf-search">
          <i class="ti ti-search" aria-hidden="true"></i>
          <input type="search" id="scm-search" placeholder="Search FPN or hammer..." value="${(searchQ || '').replace(/"/g, '&quot;')}" oninput="onSearchInput(this.value)">
        </div>
        <select class="imf-ghost-select" onchange="_planFilter=this.value;renderSection()">
          <option value="active" ${_planFilter === 'active' ? 'selected' : ''}>Active Cycle (${fmtDate(wm.start)} – ${fmtDate(wm.end)})</option>
          <option value="today_plus" ${_planFilter === 'today_plus' ? 'selected' : ''}>Today Onwards</option>
          <option value="all" ${_planFilter === 'all' ? 'selected' : ''}>All Plans</option>
        </select>
        <button class="btn btn-ghost btn-sm" onclick="exportPlan('excel')"><i class="ti ti-file-spreadsheet" aria-hidden="true"></i> Excel</button>
        <button class="btn btn-ghost btn-sm" onclick="exportPlan('pdf')"><i class="ti ti-file-text" aria-hidden="true"></i> PDF</button>
        ${canDo('scm_production') ? `<button class="btn btn-p btn-sm" onclick="openPlanModal()"><i class="ti ti-plus" aria-hidden="true"></i> Add Plan</button>` : ''}
      </div>
      ${rows.length === 0 ? emptyState('ti-calendar-event', 'No forging plans found', 'No active plans match the current cycle or search filters.') : `
      <div class="imf-table-scroll">
        <table class="imf-table">
          <thead><tr>
            <th class="pin">Date</th>
            <th>Shift</th>
            <th>FPN</th>
            <th>Hammer</th>
            <th class="num">Planned</th>
            <th class="num">Actual</th>
            <th>Status</th>
            <th></th>
          </tr></thead>
          <tbody>${rows.map(r => {
            const isToday = r.date === today;
            return `
              <tr class="${isToday ? 'today-highlight' : ''}">
                <td class="pin num mono">${fmtDate(r.date)}${isToday ? '<span class="today-badge">Today</span>' : ''}</td>
                <td>${FORGING_SHIFTS[r.shift]?.label || r.shift}</td>
                <td><span class="mono" style="font-weight:600">${r.fpn}</span>${fpnName(r.fpn) ? `<div class="text-xs text-muted">${fpnName(r.fpn)}</div>` : ''}</td>
                <td>${r.hammerName}</td>
                <td class="num mono">${r.qtyPlanned.toLocaleString('en-IN')}</td>
                <td class="num mono">${r.qtyActual.toLocaleString('en-IN')}</td>
                <td>${imfBadge(r.status, PLAN_STATUS_META)}</td>
                <td style="white-space:nowrap">
                  ${isScmAdmin() ? `<button class="imf-rowact" onclick="openPlanModal('${r.planId}')" title="Edit forging plan" aria-label="Edit"><i class="ti ti-edit" aria-hidden="true"></i></button>` : ''}
                  ${isTanmay ? `<button class="btn-delete-plan" onclick="deleteForgingPlanRow('${r.planId}', '${r.date}', '${r.shift}')" title="Delete plan row" aria-label="Delete"><i class="ti ti-trash" aria-hidden="true"></i></button>` : ''}
                </td>
              </tr>
            `;
          }).join('')}</tbody>
        </table>
      </div>`}
    </div>
    ${rows.length > 0 ? `<div class="imf-cards">${rows.map(planShiftCard).join('')}</div>` : ''}
  `;
}

/** Per-shift-row status, reused by both the flattened table and the Control Tower tracker. */
function planShiftRowStatus(date, qtyActual, qtyPlanned) {
  if (qtyActual >= qtyPlanned) return 'completed';
  if (date < dateStr()) return 'behind';
  return qtyActual > 0 ? 'in_progress' : 'not_started';
}

function planShiftCard(r) {
  const today = dateStr();
  const isToday = r.date === today;
  return `
    <div class="imf-card ${isToday ? 'today-highlight' : ''}">
      <div class="imf-card-top">
        <div>
          <span style="font-weight:700">${fmtDate(r.date)}</span>
          ${isToday ? '<span class="today-badge">Today</span>' : ''}
          <div class="text-xs text-muted">${FORGING_SHIFTS[r.shift]?.label || r.shift}</div>
        </div>
        <div class="grow"></div>
        ${imfBadge(r.status, PLAN_STATUS_META)}
      </div>
      <div class="imf-card-lead">
        <span class="nm" style="font-weight:600">${r.fpn}</span>
        <span class="qty">${r.qtyActual.toLocaleString('en-IN')}<small> / ${r.qtyPlanned.toLocaleString('en-IN')} pcs</small></span>
      </div>
      <div style="font-size:12px;color:var(--txt-mut);margin:4px 0 8px">
        ${fpnName(r.fpn) ? `<div>Name: ${fpnName(r.fpn)}</div>` : ''}
        <div>Hammer: ${r.hammerName}</div>
      </div>
      <div class="imf-card-actions" style="display:flex;gap:8px;border-top:1px solid var(--bdr-mid);padding-top:8px">
        ${isScmAdmin() ? `
          <button class="btn btn-ghost btn-xs" onclick="openPlanModal('${r.planId}')" title="Edit forging plan" aria-label="Edit">
            <i class="ti ti-edit" aria-hidden="true"></i> Edit
          </button>` : ''}
        ${isScmTanmay() ? `
          <button class="btn-delete-plan" onclick="deleteForgingPlanRow('${r.planId}', '${r.date}', '${r.shift}')" title="Delete plan row" style="margin-left:auto">
            <i class="ti ti-trash" aria-hidden="true"></i> Delete
          </button>` : ''}
      </div>
    </div>`;
}

function openPlanModal(id) {
  if (id && !isScmAdmin()) { toast('Access denied'); return; }
  const p = id ? S.forgingPlans.find(x => x.id === id) : null;
  const fpns = distinctFpns();
  const hammers = S.machines.filter(m => m.stage === 'forging' && m.isActive !== false);
  _planRows = p ? (p.shiftPlan || []).map(r => ({ ...r })) : [];

  openModal(`
    <div class="modal-title">${p ? 'Edit Forging Plan' : 'Add Forging Plan'}</div>
    <div id="modal-err"></div>

    ${p && planLotProgress(p).totalActual > 0 ? `<div class="ibox"><i class="ti ti-info-circle" aria-hidden="true"></i><span>Production has already been logged against this plan. Changing or removing a shift row here won't undo that production — only the plan side changes.</span></div>` : ''}
    ${fpns.length === 0 ? `<div class="ebox"><i class="ti ti-alert-triangle" aria-hidden="true"></i><span>No FPN ↔ CPN mappings exist yet. Ask an admin to add one in Masters first.</span></div>` : ''}
    ${hammers.length === 0 ? `<div class="ebox"><i class="ti ti-alert-triangle" aria-hidden="true"></i><span>No hammers found. Add one in Masters → Machines (stage: Forging) first.</span></div>` : ''}

    <div class="row-2">
      <div class="f">
        <label for="pl-fpn" class="f-req">Forging Part No. (FPN)</label>
        <select id="pl-fpn">
          <option value="">Select FPN...</option>
          ${fpns.map(f => `<option value="${f.fpn}" ${p?.fpn === f.fpn ? 'selected' : ''}>${fpnLabel(f.fpn)}</option>`).join('')}
        </select>
      </div>
      <div class="f">
        <label for="pl-hammer" class="f-req">Hammer</label>
        <select id="pl-hammer">
          <option value="">Select hammer...</option>
          ${buildOpts(hammers, 'id', x => `${x.name}${x.id_code ? ' (' + x.id_code + ')' : ''}`, p?.hammerId || '')}
        </select>
      </div>
    </div>

    <div class="card" style="margin:14px 0;padding:12px;background:var(--sur2)">
      <div style="font-size:11px;font-weight:800;color:var(--txt-muted);letter-spacing:.06em;margin-bottom:10px">QUICK SPREAD (optional)</div>
      <div class="text-xs text-muted mb-8">Spread a total quantity evenly across consecutive shifts, then fine-tune the rows below.</div>
      <div class="row-2">
        <div class="f" style="margin-bottom:8px"><label for="pl-qs-qty" style="font-size:11px">Total Qty</label><input type="number" id="pl-qs-qty" min="1" placeholder="e.g. 8000"></div>
        <div class="f" style="margin-bottom:8px"><label for="pl-qs-shifts" style="font-size:11px">No. of Shifts</label><input type="number" id="pl-qs-shifts" min="1" placeholder="e.g. 4"></div>
      </div>
      <div class="row-2">
        <div class="f" style="margin-bottom:8px"><label for="pl-qs-date" style="font-size:11px">Start Date</label><input type="date" id="pl-qs-date" value="${dateStr()}"></div>
        <div class="f" style="margin-bottom:8px">
          <label for="pl-qs-shift" style="font-size:11px">Start Shift</label>
          <select id="pl-qs-shift">${Object.entries(FORGING_SHIFTS).map(([k, s]) => `<option value="${k}">${s.label}</option>`).join('')}</select>
        </div>
      </div>
      <button type="button" class="btn btn-s btn-sm w-full" onclick="generatePlanRows()"><i class="ti ti-wand" aria-hidden="true"></i> Generate Shift Rows</button>
    </div>

    <div id="pl-rows-wrap"></div>
    <button type="button" class="btn btn-ghost btn-sm mt-8" onclick="addPlanRow()"><i class="ti ti-plus" aria-hidden="true"></i> Add Shift Row</button>

    ${modalActions('Save Plan', `savePlan(${p ? `'${p.id}'` : 'null'})`)}
  `);
  renderPlanRows();
}

function renderPlanRows() {
  const wrap = document.getElementById('pl-rows-wrap');
  if (!wrap) return;
  const total = _planRows.reduce((s, r) => s + (+r.qtyPlanned || 0), 0);
  wrap.innerHTML = `
    ${_planRows.length === 0 ? `<div class="text-xs text-muted">No shift rows yet — use Quick Spread or "Add Shift Row".</div>` : `
    <div style="display:flex;flex-direction:column;gap:8px">
      ${_planRows.map((r, i) => `
        <div style="display:grid;grid-template-columns:1.3fr 1fr 1fr auto;gap:8px;align-items:end">
          <div class="f" style="margin-bottom:0">
            <label style="font-size:10px">Date</label>
            <input type="date" value="${r.date}" oninput="updatePlanRow(${i},'date',this.value)">
          </div>
          <div class="f" style="margin-bottom:0">
            <label style="font-size:10px">Shift</label>
            <select onchange="updatePlanRow(${i},'shift',this.value)">
              ${Object.entries(FORGING_SHIFTS).map(([k, s]) => `<option value="${k}" ${r.shift === k ? 'selected' : ''}>${s.label}</option>`).join('')}
            </select>
          </div>
          <div class="f" style="margin-bottom:0">
            <label style="font-size:10px">Qty Planned</label>
            <input type="number" min="1" value="${r.qtyPlanned}" oninput="updatePlanRow(${i},'qtyPlanned',this.value)">
          </div>
          <button type="button" class="btn btn-d btn-sm" onclick="removePlanRow(${i})" aria-label="Remove row"><i class="ti ti-trash" aria-hidden="true"></i></button>
        </div>`).join('')}
    </div>`}
    <div class="text-sm mt-8" style="font-weight:700">Total Planned: <span id="pl-rows-total">${total.toLocaleString('en-IN')}</span> pcs</div>
  `;
}

function addPlanRow() {
  const last = _planRows[_planRows.length - 1];
  _planRows.push({ date: last?.date || dateStr(), shift: last?.shift || Object.keys(FORGING_SHIFTS)[0], qtyPlanned: '' });
  renderPlanRows();
}

function removePlanRow(i) {
  _planRows.splice(i, 1);
  renderPlanRows();
}

function updatePlanRow(i, field, value) {
  if (!_planRows[i]) return;
  _planRows[i][field] = field === 'qtyPlanned' ? (Number(value) || 0) : value;
  const totalEl = document.getElementById('pl-rows-total');
  if (totalEl) totalEl.textContent = _planRows.reduce((s, r) => s + (+r.qtyPlanned || 0), 0).toLocaleString('en-IN');
}

function generatePlanRows() {
  const totalQty = Number(document.getElementById('pl-qs-qty').value);
  const numShifts = Number(document.getElementById('pl-qs-shifts').value);
  const startDate = document.getElementById('pl-qs-date').value;
  const startShift = document.getElementById('pl-qs-shift').value;

  if (!Number.isFinite(totalQty) || totalQty < 1 || !Number.isFinite(numShifts) || numShifts < 1 || !startDate) {
    showModalError('Enter a valid Total Qty, No. of Shifts and Start Date to generate rows.');
    return;
  }

  const shiftKeys = Object.keys(FORGING_SHIFTS);
  let shiftIdx = Math.max(0, shiftKeys.indexOf(startShift));
  let date = startDate;
  const base = Math.floor(totalQty / numShifts);
  const remainder = totalQty - base * numShifts;

  const rows = [];
  for (let i = 0; i < numShifts; i++) {
    rows.push({ date, shift: shiftKeys[shiftIdx], qtyPlanned: base + (i === numShifts - 1 ? remainder : 0) });
    shiftIdx++;
    if (shiftIdx >= shiftKeys.length) { shiftIdx = 0; date = addDaysStr(date, 1); }
  }
  _planRows = rows;
  renderPlanRows();
}

async function savePlan(id) {
  if (id && !isScmAdmin()) { toast('Access denied'); return; }
  const fpn = document.getElementById('pl-fpn').value;
  const hammerId = document.getElementById('pl-hammer').value;
  const hammer = S.machines.find(m => m.id === hammerId);

  if (!fpn || !hammerId) { showModalError('FPN and Hammer are required.'); return; }
  if (!_planRows.length) { showModalError('Add at least one shift row (or use Quick Spread).'); return; }
  if (_planRows.some(r => !r.date || !r.shift || !r.qtyPlanned || r.qtyPlanned < 1)) {
    showModalError('Every shift row needs a valid Date, Shift and Qty Planned.');
    return;
  }

  const shiftPlan = _planRows.map(r => ({ date: r.date, shift: r.shift, qtyPlanned: r.qtyPlanned }));
  const totalQtyPlanned = shiftPlan.reduce((s, r) => s + r.qtyPlanned, 0);
  const data = {
    fpn, hammerId, hammerName: hammer?.name || '—', hammerCode: hammer?.id_code || '',
    shiftPlan, totalQtyPlanned,
  };
  try {
    if (id) {
      const before = S.forgingPlans.find(x => x.id === id);
      await db.collection('forgingPlans').doc(id).update({ ...data, updatedBy: S.sess.userId, updatedByName: S.sess.name, updatedAt: serverTS() });
      await logAudit('UPDATE_FORGING_PLAN', 'SCM', id, before, data);
    } else {
      const ref = await db.collection('forgingPlans').add({ ...data, createdBy: S.sess.userId, createdByName: S.sess.name, createdAt: serverTS() });
      await logAudit('CREATE_FORGING_PLAN', 'SCM', ref.id, null, data);
    }
    closeModal();
    await refreshScm('forgingPlans');
    renderSection();
    toast('Forging plan saved');
  } catch (e) {
    showModalError(friendlyError(e));
  }
}

/* ══════════════════════════════════════════════════════════════════════
   TAB 1 — FORGING PRODUCTION ENTRY
   Collection: forgingProduction
   ══════════════════════════════════════════════════════════════════════ */
function renderProduction() {
  const q = searchQ.trim().toLowerCase();
  let list = S.forgingProduction.filter(p => !q || (p.fpn || '').toLowerCase().includes(q) || fpnName(p.fpn).toLowerCase().includes(q));
  list = list.slice().sort((a, b) => (b.date || '').localeCompare(a.date || ''));

  document.getElementById('section-content').innerHTML = `
    <div class="imf-tablewrap">
      <div class="imf-table-toolbar">
        <div class="grow">
          <div style="font-size:16px;font-weight:700">Forging Production Log</div>
          <div class="text-sm text-muted">${list.length} entr${list.length !== 1 ? 'ies' : 'y'}</div>
        </div>
        <div class="imf-search">
          <i class="ti ti-search" aria-hidden="true"></i>
          <input type="search" id="scm-search" placeholder="Search FPN..." value="${(searchQ || '').replace(/"/g, '&quot;')}" oninput="onSearchInput(this.value)">
        </div>
        <button class="btn btn-ghost btn-sm" onclick="exportProduction('excel')"><i class="ti ti-file-spreadsheet" aria-hidden="true"></i> Excel</button>
        <button class="btn btn-ghost btn-sm" onclick="exportProduction('pdf')"><i class="ti ti-file-text" aria-hidden="true"></i> PDF</button>
        ${canDo('scm_production') ? `<button class="btn btn-p btn-sm" onclick="openProductionModal()"><i class="ti ti-plus" aria-hidden="true"></i> Log Production</button>` : ''}
      </div>
      ${list.length === 0 ? emptyState('ti-stack-2', 'No production logged yet', 'Log daily forged quantity to start tracking Internal WIP.') : `
      <div class="imf-table-scroll">
        <table class="imf-table">
          <thead><tr>
            <th class="pin">Lot No.</th><th>FPN</th><th>Hammer</th><th class="num">Date</th><th class="num">Qty Forged</th><th class="num">Remaining</th><th>Shift</th><th>Plan</th><th>Logged By</th><th></th>
          </tr></thead>
          <tbody>${list.map(productionTableRow).join('')}</tbody>
        </table>
      </div>`}
    </div>
    ${list.length > 0 ? `<div class="imf-cards">${list.map(productionCard).join('')}</div>` : ''}
  `;
}

function productionRemainingCellHtml(remaining, forged) {
  const dispatched = forged - remaining;
  if (remaining === 0) {
    return `
      <td class="num mono">
        <span style="color:var(--txt-muted)">0</span>
        <div class="text-xs text-success" style="font-weight:600;font-size:10px">Fully Dispatched</div>
      </td>`;
  }
  if (dispatched === 0) {
    return `
      <td class="num mono">
        <span>${remaining.toLocaleString('en-IN')}</span>
        <div class="text-xs text-muted" style="font-size:10px">0% dispatched (Untouched)</div>
      </td>`;
  }
  const pct = Math.round((dispatched / forged) * 100);
  return `
    <td class="num mono">
      <span style="font-weight:600">${remaining.toLocaleString('en-IN')}</span>
      <div class="text-xs text-muted" style="font-size:10px">${pct}% dispatched (${dispatched.toLocaleString('en-IN')} pcs)</div>
    </td>`;
}

function productionTableRow(p) {
  const remaining = p.qtyRemaining ?? p.qtyForged ?? 0;
  return `
    <tr>
      <td class="pin mono">${p.lotNo || p.id}</td>
      <td><span class="mono">${p.fpn || '—'}</span>${fpnName(p.fpn) ? `<div class="text-xs text-muted">${fpnName(p.fpn)}</div>` : ''}</td>
      <td>${p.hammerName || '—'}</td>
      <td class="num">${fmtDate(p.date)}</td>
      <td class="num mono">${(+p.qtyForged || 0).toLocaleString('en-IN')}</td>
      ${productionRemainingCellHtml(remaining, +p.qtyForged || 0)}
      <td>${p.shift || '—'}</td>
      <td>${p.planId ? '<span class="imf-badge rag-g"><i class="ti ti-link" aria-hidden="true"></i>Planned</span>' : '<span class="imf-badge rag-b">Unplanned</span>'}</td>
      <td>${p.loggedByName || '—'}</td>
      <td style="white-space:nowrap">
        ${isScmAdmin() ? `<button class="imf-rowact" onclick="openProductionModal('${p.id}')" title="Edit" aria-label="Edit"><i class="ti ti-edit" aria-hidden="true"></i></button>` : ''}
        ${isScmTanmay() ? `<button class="imf-rowact" onclick="deleteProduction('${p.id}')" title="Delete" aria-label="Delete"><i class="ti ti-trash" aria-hidden="true"></i></button>` : ''}
      </td>
    </tr>`;
}

function productionCard(p) {
  const remaining = p.qtyRemaining ?? p.qtyForged ?? 0;
  const forged = +p.qtyForged || 0;
  const dispatched = forged - remaining;
  
  let dispatchSubtextHtml = '';
  if (remaining === 0) {
    dispatchSubtextHtml = `<div class="text-xs text-success" style="font-weight:600;margin-top:2px">Fully Dispatched</div>`;
  } else if (dispatched === 0) {
    dispatchSubtextHtml = `<div class="text-xs text-muted" style="margin-top:2px">0% dispatched (Untouched)</div>`;
  } else {
    const pct = Math.round((dispatched / forged) * 100);
    dispatchSubtextHtml = `<div class="text-xs text-muted" style="margin-top:2px">${pct}% dispatched (${dispatched.toLocaleString('en-IN')} pcs)</div>`;
  }

  return `
    <div class="imf-card">
      <div class="imf-card-top">
        <span class="imf-mono">${p.lotNo || p.id}</span>
        <div class="grow"></div>
        ${p.planId ? '<span class="imf-badge rag-g"><i class="ti ti-link" aria-hidden="true"></i>Planned</span>' : '<span class="imf-badge rag-b">Unplanned</span>'}
      </div>
      <div class="imf-card-lead" style="align-items: flex-start; flex-direction: column;">
        <div style="display:flex;justify-content:space-between;width:100%">
          <span class="nm imf-mono">${p.fpn || '—'}${fpnName(p.fpn) ? ` <small class="text-muted">${fpnName(p.fpn)}</small>` : ''}</span>
          <span class="qty">${remaining.toLocaleString('en-IN')}<small> / ${forged.toLocaleString('en-IN')} pcs</small></span>
        </div>
        ${dispatchSubtextHtml}
      </div>
      <div class="imf-card-meta"><span class="mono">${fmtDate(p.date)}</span><span>·</span><span>${p.shift || '—'}</span><span>·</span><span>${p.hammerName || '—'}</span></div>
      ${(isScmAdmin() || isScmTanmay()) ? `
      <div class="flex gap-8 mt-8">
        ${isScmAdmin() ? `<button class="btn btn-s btn-sm flex-1" onclick="openProductionModal('${p.id}')"><i class="ti ti-edit" aria-hidden="true"></i> Edit</button>` : ''}
        ${isScmTanmay() ? `<button class="btn btn-s btn-sm flex-1" onclick="deleteProduction('${p.id}')"><i class="ti ti-trash" aria-hidden="true"></i> Delete</button>` : ''}
      </div>` : ''}
    </div>`;
}

function openProductionModal(id, prefill) {
  if (id && !isScmAdmin()) { toast('Access denied'); return; }
  const p = id ? S.forgingProduction.find(x => x.id === id) : null;
  const consumed = p ? (+p.qtyForged || 0) - (p.qtyRemaining ?? p.qtyForged ?? 0) : 0;
  const locked = consumed > 0;
  const fpns = distinctFpns();
  const hammers = S.machines.filter(m => m.stage === 'forging' && m.isActive !== false);

  const initFpn = prefill?.fpn || p?.fpn || '';
  const initHammerId = prefill?.hammerId || p?.hammerId || '';
  const initDate = prefill?.date || p?.date || dateStr();
  const initShift = prefill?.shift || p?.shift || '';
  const initQty = p?.qtyForged ?? '';

  openModal(`
    <div class="modal-title">${p ? 'Edit Forging Production' : 'Log Forging Production'}</div>
    <div id="modal-err"></div>

    ${locked ? `<div class="ibox"><i class="ti ti-info-circle" aria-hidden="true"></i><span>${consumed.toLocaleString('en-IN')} pcs from this lot have already been dispatched, so FPN and Date are locked — only Hammer, Shift and Qty Forged can change, and Qty Forged can't drop below ${consumed.toLocaleString('en-IN')}.</span></div>` : ''}
    ${fpns.length === 0 ? `<div class="ebox"><i class="ti ti-alert-triangle" aria-hidden="true"></i><span>No FPN ↔ CPN mappings exist yet. Ask an admin to add one in Masters first.</span></div>` : ''}
    ${hammers.length === 0 ? `<div class="ebox"><i class="ti ti-alert-triangle" aria-hidden="true"></i><span>No hammers found. Add one in Masters → Machines (stage: Forging) first.</span></div>` : ''}

    <div class="row-2">
      <div class="f">
        <label for="pf-fpn" class="f-req">Forging Part No. (FPN)</label>
        <select id="pf-fpn" ${locked ? 'disabled' : ''} onchange="updateProductionModalPlanDropdown(undefined, ${p ? `'${p.id}'` : 'null'})">
          <option value="">Select FPN...</option>
          ${fpns.map(f => `<option value="${f.fpn}" ${initFpn === f.fpn ? 'selected' : ''}>${fpnLabel(f.fpn)}</option>`).join('')}
        </select>
      </div>
      <div class="f">
        <label for="pf-hammer" class="f-req">Hammer</label>
        <select id="pf-hammer" onchange="updateProductionModalPlanDropdown(undefined, ${p ? `'${p.id}'` : 'null'})">
          <option value="">Select hammer...</option>
          ${buildOpts(hammers, 'id', x => `${x.name}${x.id_code ? ' (' + x.id_code + ')' : ''}`, initHammerId)}
        </select>
      </div>
    </div>
    <div class="row-2">
      <div class="f">
        <label for="pf-date" class="f-req">Date</label>
        <input type="date" id="pf-date" value="${initDate}" max="${dateStr()}" ${locked ? 'disabled' : ''}>
      </div>
      <div class="f">
        <label for="pf-qty" class="f-req">Qty Forged (pcs)</label>
        <input type="number" id="pf-qty" min="${locked ? consumed : 1}" value="${initQty}" placeholder="e.g. 500">
      </div>
    </div>
    <div class="row-2">
      <div class="f">
        <label for="pf-shift">Shift</label>
        <select id="pf-shift">
          ${Object.entries(FORGING_SHIFTS).map(([k, s]) => `<option value="${k}" ${initShift === k ? 'selected' : ''}>${s.label}</option>`).join('')}
        </select>
      </div>
      <div class="f">
        <label for="pf-plan-row">Link to Plan (Optional)</label>
        <select id="pf-plan-row">
          <!-- Populated dynamically -->
        </select>
      </div>
    </div>

    ${modalActions('Save Production', `saveProduction(${p ? `'${p.id}'` : 'null'})`)}
  `);

  // Initialize plan row selection dropdown
  let initialLinkVal = 'none';
  if (prefill?.planRowVal) {
    initialLinkVal = prefill.planRowVal;
  } else if (p) {
    if (p.planId) {
      if (p.targetPlanDate) {
        initialLinkVal = `${p.planId}|${p.targetPlanDate}|${p.targetPlanShift}`;
      } else {
        initialLinkVal = 'auto';
      }
    }
  }
  updateProductionModalPlanDropdown(initialLinkVal, p?.id);
}

window.updateProductionModalPlanDropdown = function(initialVal, excludeProdId) {
  const fpnSelect = document.getElementById('pf-fpn');
  const hammerSelect = document.getElementById('pf-hammer');
  const planRowSelect = document.getElementById('pf-plan-row');
  if (!planRowSelect) return;

  const currentVal = initialVal !== undefined ? initialVal : planRowSelect.value;
  const fpn = fpnSelect ? fpnSelect.value : '';
  const hammerId = hammerSelect ? hammerSelect.value : '';

  if (!fpn || !hammerId) {
    planRowSelect.innerHTML = '<option value="none">No plans available (select FPN & Hammer)</option>';
    planRowSelect.value = 'none';
    return;
  }

  const plans = S.forgingPlans.filter(x => x.fpn === fpn && x.hammerId === hammerId);
  
  let html = `
    <option value="auto">Auto-link (Match by date and shift)</option>
    <option value="none">Unplanned (No link)</option>
  `;

  plans.forEach(plan => {
    const shiftRows = plan.shiftPlan || [];
    const sortedRows = shiftRows.slice().sort((a, b) => a.date.localeCompare(b.date) || a.shift.localeCompare(b.shift));
    
    sortedRows.forEach(r => {
      const actual = S.forgingProduction
        .filter(prod => prod.id !== excludeProdId && prod.planId === plan.id && 
          (prod.targetPlanDate ? (prod.targetPlanDate === r.date && prod.targetPlanShift === r.shift) : (prod.date === r.date && prod.shift === r.shift))
        )
        .reduce((s, prod) => s + (+prod.qtyForged || 0), 0);
      const remaining = Math.max(0, (+r.qtyPlanned || 0) - actual);
      const val = `${plan.id}|${r.date}|${r.shift}`;
      html += `<option value="${val}">${fmtDate(r.date)} - Shift ${FORGING_SHIFTS[r.shift]?.label || r.shift} (Planned: ${r.qtyPlanned.toLocaleString('en-IN')}, Rem: ${remaining.toLocaleString('en-IN')} pcs)</option>`;
    });
  });

  planRowSelect.innerHTML = html;
  
  if (currentVal && Array.from(planRowSelect.options).some(o => o.value === currentVal)) {
    planRowSelect.value = currentVal;
  } else {
    planRowSelect.value = 'none';
  }
};

async function saveProduction(id) {
  if (id && !isScmAdmin()) { toast('Access denied'); return; }
  const existing = id ? S.forgingProduction.find(x => x.id === id) : null;
  const consumed = existing ? (+existing.qtyForged || 0) - (existing.qtyRemaining ?? existing.qtyForged ?? 0) : 0;
  const locked = consumed > 0;

  const fpn = locked ? existing.fpn : document.getElementById('pf-fpn').value;
  const hammerId = document.getElementById('pf-hammer').value;
  const hammer = S.machines.find(m => m.id === hammerId);
  const date = locked ? existing.date : getField('pf-date');
  const qtyForged = Number(getField('pf-qty'));
  const shift = document.getElementById('pf-shift').value;
  
  const planRowVal = document.getElementById('pf-plan-row').value;

  if (!fpn || !hammerId || !date || !Number.isFinite(qtyForged) || qtyForged < 1) {
    showModalError('FPN, Hammer, Date and a valid Qty Forged are required.');
    return;
  }
  if (locked && qtyForged < consumed) {
    showModalError(`Qty Forged can't drop below ${consumed.toLocaleString('en-IN')} pcs — that much has already been dispatched from this lot.`);
    return;
  }

  let planId = null;
  let targetPlanDate = null;
  let targetPlanShift = null;

  if (planRowVal === 'auto') {
    const matchedPlan = S.forgingPlans.find(p =>
      p.fpn === fpn && p.hammerId === hammerId &&
      (p.shiftPlan || []).some(r => r.date === date && r.shift === shift));
    planId = matchedPlan ? matchedPlan.id : null;
  } else if (planRowVal !== 'none') {
    const parts = planRowVal.split('|');
    planId = parts[0];
    targetPlanDate = parts[1];
    targetPlanShift = parts[2];
  }

  try {
    if (id) {
      const data = {
        fpn, hammerId, hammerName: hammer?.name || '—', hammerCode: hammer?.id_code || '',
        date, qtyForged, qtyRemaining: qtyForged - consumed, shift, planId,
        targetPlanDate, targetPlanShift
      };
      await db.collection('forgingProduction').doc(id).update({ ...data, updatedBy: S.sess.userId, updatedByName: S.sess.name, updatedAt: serverTS() });
      await logAudit('UPDATE_FORGING_PRODUCTION', 'SCM', id, existing, data);
      closeModal();
      await refreshScm('forgingProduction');
      renderSection();
      toast('Production updated');
    } else {
      const sameDay = S.forgingProduction.filter(p => p.fpn === fpn && p.date === date).length;
      const lotNo = `${fpn}-${date.replace(/-/g, '')}-${String(sameDay + 1).padStart(2, '0')}`;
      const data = {
        date, fpn, qtyForged, qtyRemaining: qtyForged, lotNo, shift,
        hammerId, hammerName: hammer?.name || '—', hammerCode: hammer?.id_code || '',
        planId, targetPlanDate, targetPlanShift, loggedBy: S.sess.userId, loggedByName: S.sess.name,
      };
      const ref = await db.collection('forgingProduction').add({ ...data, createdAt: serverTS() });
      await logAudit('CREATE_FORGING_PRODUCTION', 'SCM', ref.id, null, data);
      closeModal();
      await refreshScm('forgingProduction');
      renderSection();
      toast('Production logged');
    }
  } catch (e) {
    showModalError(friendlyError(e));
  }
}

async function deleteProduction(id) {
  if (!isScmTanmay()) { toast('Access denied'); return; }
  const p = S.forgingProduction.find(x => x.id === id);
  if (!p) return;
  const consumed = (+p.qtyForged || 0) - (p.qtyRemaining ?? p.qtyForged ?? 0);
  if (consumed > 0) {
    toast(`Can't delete — ${consumed.toLocaleString('en-IN')} pcs from this lot have already been dispatched. Delete or adjust that dispatch first.`, 5000);
    return;
  }
  if (!confirm(`Delete production lot ${p.lotNo || p.id}? This cannot be undone.`)) return;
  try {
    await db.collection('forgingProduction').doc(id).delete();
    await logAudit('DELETE_FORGING_PRODUCTION', 'SCM', id, p, null);
    await refreshScm('forgingProduction');
    renderSection();
    toast('Production lot deleted');
  } catch (e) {
    toast('Error: ' + friendlyError(e));
  }
}

/* ══════════════════════════════════════════════════════════════════════
   CALENDAR VIEW & RESCHEDULING/LINKING FUNCTIONALITIES
   ══════════════════════════════════════════════════════════════════════ */
function getCalendarGridDates(startStr, endStr) {
  const dates = [];
  const startDt = new Date(startStr + 'T00:00:00');
  const endDt = new Date(endStr + 'T00:00:00');
  
  const startDay = startDt.getDay();
  const calendarStart = new Date(startDt.getTime() - startDay * 86400000);
  
  const endDay = endDt.getDay();
  const calendarEnd = new Date(endDt.getTime() + (6 - endDay) * 86400000);
  
  let curr = new Date(calendarStart);
  while (curr <= calendarEnd) {
    dates.push(curr.toISOString().slice(0, 10));
    curr.setDate(curr.getDate() + 1);
  }
  return dates;
}

window.selectCalendarDate = function(date) {
  _selectedCalDate = date;
  renderCalendar();
};

window.openPrefilledProductionModal = function(fpn, hammerId, date, shift, planId) {
  openProductionModal(null, {
    fpn,
    hammerId,
    date,
    shift,
    planRowVal: `${planId}|${date}|${shift}`
  });
};

window.openReschedulePlanModal = function(planId, date, shift) {
  const p = S.forgingPlans.find(x => x.id === planId);
  if (!p) return;
  const r = (p.shiftPlan || []).find(row => row.date === date && row.shift === shift);
  
  openModal(`
    <div class="modal-title">Reschedule Job Card</div>
    <div id="modal-err"></div>
    <div style="font-size:12px;color:var(--txt-muted);margin-bottom:12px">
      Rescheduling plan row for part <b>${p.fpn}</b> on hammer <b>${p.hammerName}</b>.
    </div>
    
    <div class="f">
      <label class="f-req">New Date</label>
      <input type="date" id="resched-date" value="${date}">
    </div>
    <div class="row-2">
      <div class="f">
        <label class="f-req">New Shift</label>
        <select id="resched-shift">
          ${Object.entries(FORGING_SHIFTS).map(([k, s]) => `<option value="${k}" ${shift === k ? 'selected' : ''}>${s.label}</option>`).join('')}
        </select>
      </div>
      <div class="f">
        <label class="f-req">Qty Planned (pcs)</label>
        <input type="number" id="resched-qty" value="${r?.qtyPlanned || ''}" min="1">
      </div>
    </div>
    
    ${modalActions('Save Changes', `saveRescheduledPlanRow('${planId}', '${date}', '${shift}')`)}
  `);
};

window.saveRescheduledPlanRow = async function(planId, oldDate, oldShift) {
  const newDate = document.getElementById('resched-date').value;
  const newShift = document.getElementById('resched-shift').value;
  const newQty = Number(document.getElementById('resched-qty').value);

  if (!newDate || !newShift || !Number.isFinite(newQty) || newQty < 1) {
    showModalError('Please enter a valid Date, Shift and Qty.');
    return;
  }

  try {
    const plan = S.forgingPlans.find(x => x.id === planId);
    if (!plan) throw new Error('Plan not found.');

    const before = JSON.parse(JSON.stringify(plan));
    const shiftPlan = (plan.shiftPlan || []).map(r => {
      if (r.date === oldDate && r.shift === oldShift) {
        return { date: newDate, shift: newShift, qtyPlanned: newQty };
      }
      return r;
    });

    const totalQtyPlanned = shiftPlan.reduce((s, r) => s + r.qtyPlanned, 0);
    const data = { shiftPlan, totalQtyPlanned };

    await db.collection('forgingPlans').doc(planId).update({ ...data, updatedBy: S.sess.userId, updatedByName: S.sess.name, updatedAt: serverTS() });
    await logAudit('UPDATE_FORGING_PLAN', 'SCM', planId, before, { ...plan, ...data });

    const linkedProds = S.forgingProduction.filter(prod => prod.planId === planId && prod.targetPlanDate === oldDate && prod.targetPlanShift === oldShift);
    
    for (const prod of linkedProds) {
      await db.collection('forgingProduction').doc(prod.id).update({
        targetPlanDate: newDate,
        targetPlanShift: newShift,
        updatedBy: S.sess.userId,
        updatedByName: S.sess.name,
        updatedAt: serverTS()
      });
    }

    closeModal();
    await refreshScm('forgingPlans');
    await refreshScm('forgingProduction');
    _selectedCalDate = newDate;
    renderSection();
    toast('Plan row rescheduled successfully');
  } catch (e) {
    showModalError(friendlyError(e));
  }
};

window.openLinkProductionModal = function(prodId) {
  const prod = S.forgingProduction.find(x => x.id === prodId);
  if (!prod) return;

  const plans = S.forgingPlans.filter(x => x.fpn === prod.fpn && x.hammerId === prod.hammerId);
  
  let htmlOptions = `
    <option value="auto">Auto-link (Match by date and shift)</option>
    <option value="none">Unplanned (No link)</option>
  `;

  plans.forEach(plan => {
    const sortedRows = (plan.shiftPlan || []).slice().sort((a, b) => a.date.localeCompare(b.date) || a.shift.localeCompare(b.shift));
    sortedRows.forEach(r => {
      const actual = S.forgingProduction
        .filter(p => p.id !== prodId && p.planId === plan.id && 
          (p.targetPlanDate ? (p.targetPlanDate === r.date && p.targetPlanShift === r.shift) : (p.date === r.date && p.shift === r.shift))
        )
        .reduce((s, p) => s + (+p.qtyForged || 0), 0);
      const remaining = Math.max(0, (+r.qtyPlanned || 0) - actual);
      const val = `${plan.id}|${r.date}|${r.shift}`;
      
      htmlOptions += `<option value="${val}">${fmtDate(r.date)} - Shift ${FORGING_SHIFTS[r.shift]?.label || r.shift} (Planned: ${r.qtyPlanned.toLocaleString('en-IN')}, Rem: ${remaining.toLocaleString('en-IN')} pcs)</option>`;
    });
  });

  openModal(`
    <div class="modal-title">Link Production Lot to Job Card</div>
    <div id="modal-err"></div>
    <div style="font-size:12px;color:var(--txt-muted);margin-bottom:12px">
      Linking Lot <b>${prod.lotNo || prod.id}</b> (${prod.fpn}, ${prod.qtyForged} pcs) to a forging plan.
    </div>
    
    <div class="f">
      <label class="f-req">Select Plan Row</label>
      <select id="link-plan-select">
        ${htmlOptions}
      </select>
    </div>

    ${modalActions('Save Link', `saveProductionLink('${prodId}')`)}
  `);
  
  const selectEl = document.getElementById('link-plan-select');
  if (selectEl) {
    if (prod.planId) {
      if (prod.targetPlanDate) {
        selectEl.value = `${prod.planId}|${prod.targetPlanDate}|${prod.targetPlanShift}`;
      } else {
        selectEl.value = 'auto';
      }
    } else {
      selectEl.value = 'none';
    }
  }
};

window.saveProductionLink = async function(prodId) {
  const selectVal = document.getElementById('link-plan-select').value;
  const prod = S.forgingProduction.find(x => x.id === prodId);
  if (!prod) return;

  let planId = null;
  let targetPlanDate = null;
  let targetPlanShift = null;

  if (selectVal === 'auto') {
    const matchedPlan = S.forgingPlans.find(p =>
      p.fpn === prod.fpn && p.hammerId === prod.hammerId &&
      (p.shiftPlan || []).some(r => r.date === prod.date && r.shift === prod.shift));
    planId = matchedPlan ? matchedPlan.id : null;
  } else if (selectVal !== 'none') {
    const parts = selectVal.split('|');
    planId = parts[0];
    targetPlanDate = parts[1];
    targetPlanShift = parts[2];
  }

  try {
    const before = JSON.parse(JSON.stringify(prod));
    const data = { planId, targetPlanDate, targetPlanShift };
    
    await db.collection('forgingProduction').doc(prodId).update({
      ...data,
      updatedBy: S.sess.userId,
      updatedByName: S.sess.name,
      updatedAt: serverTS()
    });
    
    await logAudit('UPDATE_FORGING_PRODUCTION', 'SCM', prodId, before, { ...prod, ...data });
    
    closeModal();
    await refreshScm('forgingProduction');
    renderSection();
    toast('Production lot link updated successfully');
  } catch (e) {
    showModalError(friendlyError(e));
  }
};

window.renderCalendar = function() {
  const wm = getActiveWorkingMonth();
  const today = dateStr();
  
  if (!_selectedCalDate) {
    if (today >= wm.start && today <= wm.end) {
      _selectedCalDate = today;
    } else {
      _selectedCalDate = wm.start;
    }
  }

  const gridDates = getCalendarGridDates(wm.start, wm.end);

  const styleTag = `
    <style>
      .imf-calendar-grid {
        display: grid;
        grid-template-columns: repeat(7, 1fr);
        gap: 8px;
        background: var(--bg);
        padding: 10px;
        border-radius: var(--rs);
        margin-top: 10px;
      }
      .imf-calendar-weekday {
        text-align: center;
        font-weight: 700;
        font-size: 11px;
        color: var(--txt-muted);
        padding: 6px 0;
        text-transform: uppercase;
        letter-spacing: 0.05em;
      }
      .imf-calendar-cell {
        background: var(--sur);
        border: 1px solid var(--bdr-mid);
        border-radius: var(--rs);
        padding: 8px;
        min-height: 80px;
        cursor: pointer;
        display: flex;
        flex-direction: column;
        justify-content: space-between;
        transition: transform 0.2s, box-shadow 0.2s, border-color 0.2s;
      }
      .imf-calendar-cell:hover {
        transform: translateY(-2px);
        box-shadow: var(--shadow-md);
        border-color: var(--imf-navy);
      }
      .imf-calendar-cell.today {
        border: 2px solid var(--imf-navy) !important;
      }
      .imf-calendar-cell.selected {
        background: var(--imf-navy-hover) !important;
        border-color: var(--imf-navy) !important;
      }
      .imf-calendar-cell.dimmed {
        opacity: 0.45;
        background: var(--sur2);
      }
      .imf-calendar-date-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        width: 100%;
      }
      .imf-calendar-date-label {
        font-size: 11px;
        font-weight: 700;
        color: var(--txt-muted);
      }
      .imf-calendar-cell.today .imf-calendar-date-label {
        color: var(--imf-navy);
      }
      .imf-calendar-qtys {
        display: flex;
        flex-direction: column;
        gap: 2px;
        margin-top: 8px;
      }
      .imf-cal-qty-line {
        font-size: 10px;
        font-family: var(--mono-v2);
        display: flex;
        justify-content: space-between;
      }
      .imf-cal-qty-planned {
        color: var(--txt-muted);
      }
      .imf-cal-qty-actual {
        font-weight: 700;
      }
      /* Border accent colors for calendar status */
      .status-achieved { border-left: 4px solid var(--ok) !important; }
      .status-pending { border-left: 4px solid var(--warn) !important; }
      .status-behind { border-left: 4px solid var(--err) !important; }
      .status-unplanned { border-left: 4px solid var(--acc) !important; }

      /* Details view */
      .imf-cal-details-container {
        margin-top: 20px;
        background: var(--sur);
        border: 1px solid var(--bdr-mid);
        border-radius: var(--r);
        padding: 16px;
      }
      .imf-cal-details-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        border-bottom: 1px solid var(--bdr);
        padding-bottom: 12px;
        margin-bottom: 16px;
      }
      .imf-cal-details-grid {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 16px;
      }
      @media (max-width: 768px) {
        .imf-cal-details-grid {
          grid-template-columns: 1fr;
        }
      }
      .imf-cal-details-section-title {
        font-size: 14px;
        font-weight: 700;
        color: var(--imf-navy);
        margin-bottom: 12px;
        display: flex;
        align-items: center;
        gap: 6px;
      }
      .imf-cal-detail-card {
        background: var(--sur2);
        border: 1px solid var(--bdr-mid);
        border-radius: var(--rs);
        padding: 12px;
        margin-bottom: 8px;
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .imf-cal-detail-card-top {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
      }
      .imf-cal-detail-card-title {
        font-weight: 700;
        font-size: 13px;
        font-family: var(--mono-v2);
      }
      .imf-cal-detail-card-meta {
        font-size: 11px;
        color: var(--txt-muted);
      }
      .imf-cal-detail-card-qty {
        font-size: 12px;
        font-family: var(--mono-v2);
        margin: 4px 0;
      }
      .imf-cal-legend {
        display: flex;
        gap: 12px;
        flex-wrap: wrap;
        font-size: 11px;
        margin-top: 8px;
        padding: 0 4px;
      }
      .imf-cal-legend-item {
        display: flex;
        align-items: center;
        gap: 4px;
        color: var(--txt-muted);
      }
      .imf-cal-legend-dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
      }
    </style>
  `;

  const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const weekdayHtml = weekdays.map(w => `<div class="imf-calendar-weekday">${w}</div>`).join('');

  const daysHtml = gridDates.map(date => {
    const isToday = date === today;
    const isDimmed = date < wm.start || date > wm.end;
    const isSelected = date === _selectedCalDate;

    let planned = 0;
    S.forgingPlans.forEach(p => {
      (p.shiftPlan || []).forEach(r => {
        if (r.date === date) planned += (+r.qtyPlanned || 0);
      });
    });

    let actual = 0;
    S.forgingProduction.forEach(prod => {
      const targetDate = prod.targetPlanDate || prod.date;
      if (targetDate === date) actual += (+prod.qtyForged || 0);
    });

    let statusClass = '';
    if (planned > 0) {
      if (actual >= planned) statusClass = 'status-achieved';
      else if (date < today) statusClass = 'status-behind';
      else statusClass = 'status-pending';
    } else if (actual > 0) {
      statusClass = 'status-unplanned';
    }

    const [, mNum, dNum] = date.split('-');
    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const monthLabel = monthNames[parseInt(mNum, 10) - 1];
    const dateLabel = `${dNum} ${monthLabel}`;

    const plannedDisplay = planned > 0 ? planned.toLocaleString('en-IN') : '—';
    const actualDisplay = actual > 0 ? actual.toLocaleString('en-IN') : '—';

    return `
      <div class="imf-calendar-cell ${statusClass} ${isToday ? 'today' : ''} ${isSelected ? 'selected' : ''} ${isDimmed ? 'dimmed' : ''}" 
           onclick="selectCalendarDate('${date}')">
        <div class="imf-calendar-date-header">
          <span class="imf-calendar-date-label">${dateLabel}</span>
          ${isToday ? '<span class="today-badge" style="margin:0;font-size:8px;padding:1px 4px;">Today</span>' : ''}
        </div>
        <div class="imf-calendar-qtys">
          <div class="imf-cal-qty-line imf-cal-qty-planned">
            <span>Plan:</span>
            <span>${plannedDisplay}</span>
          </div>
          <div class="imf-cal-qty-line imf-cal-qty-actual" style="${actual >= planned && planned > 0 ? 'color:var(--ok)' : (actual < planned && date < today ? 'color:var(--err)' : '')}">
            <span>Act:</span>
            <span>${actualDisplay}</span>
          </div>
        </div>
      </div>
    `;
  }).join('');

  document.getElementById('section-content').innerHTML = `
    ${styleTag}
    <div class="imf-tablewrap">
      <div class="imf-table-toolbar">
        <div class="grow">
          <div style="font-size:16px;font-weight:700">Forging Calendar Dashboard</div>
          <div class="text-sm text-muted">Active Working Cycle: ${fmtDate(wm.start)} – ${fmtDate(wm.end)}</div>
        </div>
        <div class="imf-cal-legend">
          <div class="imf-cal-legend-item"><div class="imf-cal-legend-dot" style="background:var(--ok)"></div> Achieved</div>
          <div class="imf-cal-legend-item"><div class="imf-cal-legend-dot" style="background:var(--warn)"></div> Pending</div>
          <div class="imf-cal-legend-item"><div class="imf-cal-legend-dot" style="background:var(--err)"></div> Behind</div>
          <div class="imf-cal-legend-item"><div class="imf-cal-legend-dot" style="background:var(--acc)"></div> Unplanned Act</div>
        </div>
      </div>
      
      <div class="imf-calendar-grid">
        ${weekdayHtml}
        ${daysHtml}
      </div>
    </div>

    <div id="imf-cal-details-wrap"></div>
  `;

  renderCalendarDayDetails(_selectedCalDate);
};

window.renderCalendarDayDetails = function(date) {
  const wrap = document.getElementById('imf-cal-details-wrap');
  if (!wrap) return;

  const plansForDate = [];
  S.forgingPlans.forEach(p => {
    (p.shiftPlan || []).forEach(r => {
      if (r.date === date) {
        const actual = S.forgingProduction
          .filter(prod => prod.planId === p.id && 
            (prod.targetPlanDate ? (prod.targetPlanDate === r.date && prod.targetPlanShift === r.shift) : (prod.date === r.date && prod.shift === r.shift))
          )
          .reduce((s, prod) => s + (+prod.qtyForged || 0), 0);
        
        plansForDate.push({
          planId: p.id,
          fpn: p.fpn,
          hammerId: p.hammerId,
          hammerName: p.hammerName || '—',
          date: r.date,
          shift: r.shift,
          qtyPlanned: +r.qtyPlanned || 0,
          qtyActual: actual,
          status: planShiftRowStatus(r.date, actual, +r.qtyPlanned || 0)
        });
      }
    });
  });

  const productionForDate = S.forgingProduction.filter(prod => {
    const targetDate = prod.targetPlanDate || prod.date;
    return targetDate === date;
  });

  plansForDate.sort((a, b) => a.shift.localeCompare(b.shift));
  productionForDate.sort((a, b) => (a.shift || '').localeCompare(b.shift || '') || (a.lotNo || '').localeCompare(b.lotNo || ''));

  const plansHtml = plansForDate.length === 0 
    ? `<div class="text-xs text-muted" style="padding:12px;background:var(--sur2);border-radius:var(--rs);border:1px dashed var(--bdr-mid)">No jobs planned for this date.</div>`
    : plansForDate.map(p => {
        const isScm = canDo('scm_production');
        return `
          <div class="imf-cal-detail-card" style="border-left:4px solid ${p.status === 'completed' ? 'var(--ok)' : (p.status === 'behind' ? 'var(--err)' : 'var(--warn)')}">
            <div class="imf-cal-detail-card-top">
              <div>
                <span class="imf-cal-detail-card-title">${p.fpn}</span>
                <span class="text-xs text-muted" style="margin-left:4px">${fpnName(p.fpn) ? `(${fpnName(p.fpn)})` : ''}</span>
              </div>
              ${imfBadge(p.status, PLAN_STATUS_META)}
            </div>
            <div class="imf-cal-detail-card-meta">
              <span>Hammer: ${p.hammerName}</span> · <span>Shift: ${FORGING_SHIFTS[p.shift]?.label || p.shift}</span>
            </div>
            <div class="imf-cal-detail-card-qty" style="display:flex;justify-content:space-between;align-items:center">
              <span>Planned: <b>${p.qtyPlanned.toLocaleString('en-IN')}</b> | Actual: <b>${p.qtyActual.toLocaleString('en-IN')}</b></span>
            </div>
            ${isScm ? `
              <div style="display:flex;gap:8px;margin-top:6px;border-top:1px solid var(--bdr);padding-top:6px">
                <button class="btn btn-ghost btn-xs" onclick="openPrefilledProductionModal('${p.fpn}', '${p.hammerId}', '${p.date}', '${p.shift}', '${p.planId}')">
                  <i class="ti ti-plus"></i> Log Production
                </button>
                <button class="btn btn-ghost btn-xs" onclick="openReschedulePlanModal('${p.planId}', '${p.date}', '${p.shift}')">
                  <i class="ti ti-calendar-event"></i> Reschedule
                </button>
                <button class="btn btn-ghost btn-xs" onclick="openPlanModal('${p.planId}')">
                  <i class="ti ti-edit"></i> Edit Full Plan
                </button>
              </div>
            ` : ''}
          </div>
        `;
      }).join('');

  const productionHtml = productionForDate.length === 0
    ? `<div class="text-xs text-muted" style="padding:12px;background:var(--sur2);border-radius:var(--rs);border:1px dashed var(--bdr-mid)">No production logs found.</div>`
    : productionForDate.map(p => {
        const isScm = canDo('scm_production');
        const isLinked = !!p.planId;
        const linkInfo = isLinked 
          ? `Linked to plan of ${fmtDate(p.targetPlanDate || p.date)} Shift ${FORGING_SHIFTS[p.targetPlanShift || p.shift]?.label || p.targetPlanShift || p.shift}`
          : `Unplanned Production`;

        return `
          <div class="imf-cal-detail-card" style="border-left:4px solid ${isLinked ? 'var(--ok)' : 'var(--acc)'}">
            <div class="imf-cal-detail-card-top">
              <div>
                <span class="imf-cal-detail-card-title">${p.lotNo || p.id}</span>
                <span class="text-xs text-muted" style="margin-left:4px">${p.fpn}</span>
              </div>
              <span class="imf-badge ${isLinked ? 'rag-g' : 'rag-b'}">${isLinked ? 'Planned' : 'Unplanned'}</span>
            </div>
            <div class="imf-cal-detail-card-meta">
              <span>Hammer: ${p.hammerName || '—'}</span> · <span>Shift: ${p.shift || '—'}</span> · <span>Logged by: ${p.loggedByName || '—'}</span>
            </div>
            <div class="imf-cal-detail-card-qty" style="display:flex;justify-content:space-between;align-items:center">
              <span>Forged: <b>${(+p.qtyForged || 0).toLocaleString('en-IN')} pcs</b> (Rem: ${(+p.qtyRemaining ?? p.qtyForged ?? 0).toLocaleString('en-IN')} pcs)</span>
            </div>
            <div class="text-xs ${isLinked ? 'text-success' : 'text-muted'}" style="font-weight:600;margin-top:2px">
              <i class="ti ${isLinked ? 'ti-link' : 'ti-link-off'}"></i> ${linkInfo}
            </div>
            ${isScm ? `
              <div style="display:flex;gap:8px;margin-top:6px;border-top:1px solid var(--bdr);padding-top:6px">
                <button class="btn btn-ghost btn-xs" onclick="openProductionModal('${p.id}')">
                  <i class="ti ti-edit"></i> Edit Log
                </button>
                <button class="btn btn-ghost btn-xs" onclick="openLinkProductionModal('${p.id}')">
                  <i class="ti ti-link"></i> Re-link Plan
                </button>
              </div>
            ` : ''}
          </div>
        `;
      }).join('');

  wrap.innerHTML = `
    <div class="imf-cal-details-container">
      <div class="imf-cal-details-header">
        <div>
          <span style="font-size:14px;font-weight:700;color:var(--txt)">Details for ${fmtDate(date)}</span>
        </div>
      </div>
      <div class="imf-cal-details-grid">
        <div>
          <div class="imf-cal-details-section-title">
            <i class="ti ti-calendar-event"></i> Scheduled Jobs (Plans)
          </div>
          ${plansHtml}
        </div>
        <div>
          <div class="imf-cal-details-section-title">
            <i class="ti ti-stack-2"></i> Logged Completion Reports (Actuals)
          </div>
          ${productionHtml}
        </div>
      </div>
    </div>
  `;
};

/* ══════════════════════════════════════════════════════════════════════
   TAB 2 — SUPPLIER DISPATCH ENTRY + SCRAP REQUEST
   Collections: supplierDispatches, scmScrapLedger
   ══════════════════════════════════════════════════════════════════════ */
function renderDispatch() {
  const q = searchQ.trim().toLowerCase();
  let list = S.supplierDispatches.filter(d =>
    !q || (d.fpn || '').toLowerCase().includes(q) || (d.cpn || '').toLowerCase().includes(q) || (d.supplierName || '').toLowerCase().includes(q) || fpnName(d.fpn).toLowerCase().includes(q));
  list = list.slice().sort((a, b) => (b.date || '').localeCompare(a.date || ''));

  document.getElementById('section-content').innerHTML = `
    <div class="imf-tablewrap">
      <div class="imf-table-toolbar">
        <div class="grow">
          <div style="font-size:16px;font-weight:700">Supplier Dispatch Log</div>
          <div class="text-sm text-muted">${list.length} dispatch${list.length !== 1 ? 'es' : ''}</div>
        </div>
        <div class="imf-search">
          <i class="ti ti-search" aria-hidden="true"></i>
          <input type="search" id="scm-search" placeholder="Search supplier, FPN, CPN..." value="${(searchQ || '').replace(/"/g, '&quot;')}" oninput="onSearchInput(this.value)">
        </div>
        <button class="btn btn-ghost btn-sm" onclick="exportDispatch('excel')"><i class="ti ti-file-spreadsheet" aria-hidden="true"></i> Excel</button>
        <button class="btn btn-ghost btn-sm" onclick="exportDispatch('pdf')"><i class="ti ti-file-text" aria-hidden="true"></i> PDF</button>
        ${canDo('scm_dispatch') ? `
          <button class="btn btn-ghost btn-sm" onclick="openScrapModal()"><i class="ti ti-trash-x" aria-hidden="true"></i> Log Scrap</button>
          <button class="btn btn-p btn-sm" onclick="openDispatchModal()"><i class="ti ti-plus" aria-hidden="true"></i> Log Dispatch</button>` : ''}
      </div>
      ${list.length === 0 ? emptyState('ti-truck-delivery', 'No dispatches logged yet', 'Log material dispatched to a CNC supplier to start tracking Supplier WIP.') : `
      <div class="imf-table-scroll">
        <table class="imf-table">
          <thead><tr>
            <th class="pin">Supplier</th><th>FPN</th><th>CPN</th><th class="num">Date</th><th class="num">Qty Dispatched</th><th>Invoice/DC No.</th><th>Lots</th><th></th><th></th>
          </tr></thead>
          <tbody>${list.map(dispatchTableRow).join('')}</tbody>
        </table>
      </div>`}
    </div>
    ${list.length > 0 ? `<div class="imf-cards">${list.map(dispatchCard).join('')}</div>` : ''}
    ${scrapRequestsSection()}
  `;
}

/** Scrap requests have no list anywhere else inside the SCM module (only
    approvals.js shows them, and only the pending queue) — without this,
    Edit/Delete would have nothing to attach to. Pending entries are
    editable/deletable; approved/rejected ones are audit-locked like every
    other approval workflow in this app. */
function scrapDefectLabel(code) {
  return (SCRAP_DEFECT_CODES.find(d => d.v === code) || {}).l || code || '—';
}

function scrapRequestRow(s) {
  const editable = s.status === 'pending';
  return `
    <tr>
      <td class="pin">${s.supplierName || '—'}</td>
      <td class="mono">${s.fpn || '—'} / ${s.cpn || '—'}</td>
      <td class="num">${fmtDate(s.date)}</td>
      <td class="num mono">${(+s.qtyScrap || 0).toLocaleString('en-IN')}</td>
      <td>${scrapDefectLabel(s.defectCode)}</td>
      <td>${imfBadge(s.status, SCRAP_META)}</td>
      <td style="white-space:nowrap">
        ${editable && isScmAdmin() ? `<button class="imf-rowact" onclick="openScrapModal('${s.id}')" title="Edit" aria-label="Edit"><i class="ti ti-edit" aria-hidden="true"></i></button>` : ''}
        ${editable && isScmTanmay() ? `<button class="imf-rowact" onclick="deleteScrapRequest('${s.id}')" title="Delete" aria-label="Delete"><i class="ti ti-trash" aria-hidden="true"></i></button>` : ''}
      </td>
    </tr>`;
}

function scrapRequestsSection() {
  const list = S.scmScrapLedger.slice().sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  if (!list.length) return '';

  return `
    <div class="imf-tablewrap mt-12">
      <div class="imf-table-toolbar">
        <div class="grow">
          <div style="font-size:16px;font-weight:700">Supplier Scrap Requests</div>
          <div class="text-sm text-muted">${list.length} request${list.length !== 1 ? 's' : ''}</div>
        </div>
      </div>
      <div class="imf-table-scroll">
        <table class="imf-table">
          <thead><tr>
            <th class="pin">Supplier</th><th>FPN / CPN</th><th class="num">Date</th><th class="num">Qty Scrap</th><th>Defect</th><th>Status</th><th></th>
          </tr></thead>
          <tbody>${list.map(scrapRequestRow).join('')}</tbody>
        </table>
      </div>
    </div>`;
}

/** Lot-allocation breakdown shared by the table's expanded row and the mobile card */
function dispatchLotBreakdown(d) {
  const allocs = d.lotAllocations || [];
  if (!allocs.length) return `<div class="text-xs text-muted">No lot allocation recorded.</div>`;
  return `
    <div style="display:flex;flex-direction:column;gap:4px">
      ${allocs.map(a => `
        <div style="display:flex;justify-content:space-between;gap:12px;font-size:12px">
          <span class="mono">${a.lotNo || a.lotId}</span>
          <span class="mono">${(+a.qty || 0).toLocaleString('en-IN')} pcs</span>
        </div>`).join('')}
    </div>`;
}

function dispatchTableRow(d) {
  const lotCount = (d.lotAllocations || []).length;
  const expanded = !!_dispExpanded[d.id];
  const mainRow = `
    <tr>
      <td class="pin">${d.supplierName || '—'}</td>
      <td><span class="mono">${d.fpn || '—'}</span>${fpnName(d.fpn) ? `<div class="text-xs text-muted">${fpnName(d.fpn)}</div>` : ''}</td>
      <td class="mono">${d.cpn || '—'}</td>
      <td class="num">${fmtDate(d.date)}</td>
      <td class="num mono">${(+d.qtyDispatched || 0).toLocaleString('en-IN')}</td>
      <td class="mono">${d.docNo || '—'}</td>
      <td>${lotCount} lot${lotCount !== 1 ? 's' : ''}</td>
      <td>
        <button class="imf-rowact" onclick="_dispExpanded['${d.id}']=!_dispExpanded['${d.id}'];renderSection()" aria-expanded="${expanded}" aria-label="Toggle lot breakdown">
          <i class="ti ti-chevron-${expanded ? 'up' : 'down'}" aria-hidden="true"></i>
        </button>
      </td>
      <td style="white-space:nowrap">
        ${isScmAdmin() ? `<button class="imf-rowact" onclick="openDispatchModal('${d.id}')" title="Edit" aria-label="Edit"><i class="ti ti-edit" aria-hidden="true"></i></button>` : ''}
        ${isScmTanmay() ? `<button class="imf-rowact" onclick="deleteDispatch('${d.id}')" title="Delete" aria-label="Delete"><i class="ti ti-trash" aria-hidden="true"></i></button>` : ''}
      </td>
    </tr>`;
  if (!expanded) return mainRow;
  return mainRow + `<tr><td colspan="9" style="background:var(--sur2);padding:0 16px 16px">${dispatchLotBreakdown(d)}</td></tr>`;
}

function dispatchCard(d) {
  const expanded = !!_dispExpanded[d.id];
  return `
    <div class="imf-card">
      <div class="imf-card-top" onclick="_dispExpanded['${d.id}']=!_dispExpanded['${d.id}'];renderSection()" style="cursor:pointer">
        <span class="imf-mono">${d.docNo || '—'}</span>
        <div class="grow"></div>
        <i class="ti ti-chevron-${expanded ? 'up' : 'down'}" aria-hidden="true" style="color:var(--txt-dim)"></i>
      </div>
      <div class="imf-card-lead">
        <span class="nm">${d.supplierName || '—'}</span>
        <span class="qty">${(+d.qtyDispatched || 0).toLocaleString('en-IN')}<small> pcs</small></span>
      </div>
      <div class="imf-card-meta"><span class="mono">${d.fpn || '—'}${fpnName(d.fpn) ? ' (' + fpnName(d.fpn) + ')' : ''} → ${d.cpn || '—'}</span></div>
      <div class="imf-card-meta"><span class="mono">${fmtDate(d.date)}</span></div>
      ${expanded ? `<div class="mt-8">${dispatchLotBreakdown(d)}</div>` : ''}
      ${(isScmAdmin() || isScmTanmay()) ? `
      <div class="flex gap-8 mt-8">
        ${isScmAdmin() ? `<button class="btn btn-s btn-sm flex-1" onclick="openDispatchModal('${d.id}')"><i class="ti ti-edit" aria-hidden="true"></i> Edit</button>` : ''}
        ${isScmTanmay() ? `<button class="btn btn-s btn-sm flex-1" onclick="deleteDispatch('${d.id}')"><i class="ti ti-trash" aria-hidden="true"></i> Delete</button>` : ''}
      </div>` : ''}
    </div>`;
}

function openDispatchModal(id) {
  if (id && !isScmAdmin()) { toast('Access denied'); return; }
  const d = id ? S.supplierDispatches.find(x => x.id === id) : null;
  const fpns = distinctFpns();
  const supOpts = buildOpts(S.suppliers.slice().sort((a, b) => (a.name || '').localeCompare(b.name || '')), 'id', x => x.name, d?.supplierId || '');

  openModal(`
    <div class="modal-title">${d ? 'Edit Supplier Dispatch' : 'Log Supplier Dispatch'}</div>
    <div id="modal-err"></div>

    ${d ? `<div class="ibox"><i class="ti ti-info-circle" aria-hidden="true"></i><span>Supplier, FPN and Qty Dispatched are locked — they drive the internal lot allocation. Delete and re-log if those need to change. Only Date and Invoice/DC No. can be edited here.</span></div>` : ''}

    <div class="f">
      <label for="df-supplier" class="f-req">Supplier</label>
      <select id="df-supplier" ${d ? 'disabled' : ''}>
        <option value="">Select supplier...</option>
        ${supOpts}
      </select>
    </div>
    <div class="f">
      <label for="df-fpn" class="f-req">FPN</label>
      <select id="df-fpn" ${d ? 'disabled' : ''}>
        <option value="">Select FPN...</option>
        ${fpns.map(f => `<option value="${f.fpn}" ${d?.fpn === f.fpn ? 'selected' : ''}>${fpnLabel(f.fpn)}</option>`).join('')}
      </select>
      <div class="text-xs text-muted mt-8">CPN is fetched automatically from the FPN ↔ CPN Map.</div>
    </div>
    <div class="row-2">
      <div class="f">
        <label for="df-date" class="f-req">Date</label>
        <input type="date" id="df-date" value="${d?.date || dateStr()}" max="${dateStr()}">
      </div>
      <div class="f">
        <label for="df-qty" class="f-req">Qty Dispatched (pcs)</label>
        <input type="number" id="df-qty" min="1" value="${d?.qtyDispatched ?? ''}" placeholder="e.g. 500" ${d ? 'disabled' : ''}>
      </div>
    </div>
    <div class="f">
      <label for="df-dno">Invoice No. / DC No.</label>
      <input type="text" id="df-dno" value="${d?.docNo || ''}" placeholder="e.g. DC-2031">
    </div>

    ${modalActions('Save Dispatch', `saveDispatch(${d ? `'${d.id}'` : 'null'})`)}
  `);
}

/**
 * Allocates a dispatch against specific forgingProduction lots, oldest
 * first, inside a transaction — so qtyRemaining is a real, race-safe
 * ledger rather than a number simulated at read time. Throws (and the
 * transaction is aborted, nothing is written) if the FPN doesn't have
 * enough remaining internal WIP — this is the hard version of the old
 * "anomaly flag" idea: a dispatch can never outrun its own production.
 */
async function _allocateAndCreateDispatch(data, qtyDispatched, fpn) {
  return db.runTransaction(async (tx) => {
    const lotsSnap = await tx.get(
      db.collection('forgingProduction').where('fpn', '==', fpn).orderBy('date', 'asc')
    );
    const lots = lotsSnap.docs.map(d => ({ ref: d.ref, id: d.id, ...d.data() }));

    let need = qtyDispatched;
    const allocations = [];
    for (const lot of lots) {
      if (need <= 0) break;
      const avail = lot.qtyRemaining ?? lot.qtyForged ?? 0;
      if (avail <= 0) continue;
      const take = Math.min(avail, need);
      allocations.push({ lotId: lot.id, lotNo: lot.lotNo || lot.id, date: lot.date, qty: take });
      need -= take;
      tx.update(lot.ref, { qtyRemaining: avail - take });
    }

    if (need > 0) {
      const totalAvail = lots.reduce((s, l) => s + (l.qtyRemaining ?? l.qtyForged ?? 0), 0);
      throw new Error(
        `Not enough internal WIP for ${fpn} — only ${totalAvail} pcs available, tried to dispatch ${qtyDispatched} pcs. Log more production first or reduce the quantity.`
      );
    }

    const ref = db.collection('supplierDispatches').doc();
    tx.set(ref, { ...data, lotAllocations: allocations, createdAt: serverTS() });
    return { id: ref.id, lotAllocations: allocations };
  });
}

async function saveDispatch(id) {
  if (id && !isScmAdmin()) { toast('Access denied'); return; }

  // Edit path — only Date and Invoice/DC No. are editable; quantity/FPN/
  // supplier are locked because changing them would require re-running
  // the FIFO lot allocation (use Delete + re-log for that instead).
  if (id) {
    const existing = S.supplierDispatches.find(x => x.id === id);
    const date = getField('df-date');
    const docNo = (getField('df-dno') || '').trim();
    if (!date) { showModalError('Date is required.'); return; }
    const data = { date, docNo };
    try {
      await db.collection('supplierDispatches').doc(id).update({ ...data, updatedBy: S.sess.userId, updatedByName: S.sess.name, updatedAt: serverTS() });
      await logAudit('UPDATE_SUPPLIER_DISPATCH', 'SCM', id, existing, data);
      closeModal();
      await refreshScm('supplierDispatches');
      renderSection();
      toast('Dispatch updated');
    } catch (e) {
      showModalError(friendlyError(e));
    }
    return;
  }

  const supplierId = document.getElementById('df-supplier').value;
  const fpn = document.getElementById('df-fpn').value;
  const date = getField('df-date');
  const qtyDispatched = Number(getField('df-qty'));
  const docNo = (getField('df-dno') || '').trim();

  if (!supplierId || !fpn || !date || !Number.isFinite(qtyDispatched) || qtyDispatched < 1) {
    showModalError('Supplier, FPN, Date and a valid Qty Dispatched are required.');
    return;
  }

  const map = S.fpnCpnMap.find(m => m.fpn === fpn && m.active !== false);
  if (!map) {
    showModalError('This FPN has no CPN mapping yet. Add one in Masters → FPN ↔ CPN Map first.');
    return;
  }
  const cpn = map.cpn;

  const sup = S.suppliers.find(s => s.id === supplierId);
  const data = { date, supplierId, supplierName: sup?.name || '', fpn, cpn, qtyDispatched, docNo, loggedBy: S.sess.userId, loggedByName: S.sess.name };
  try {
    const { id: newId, lotAllocations } = await _allocateAndCreateDispatch(data, qtyDispatched, fpn);
    await logAudit('CREATE_SUPPLIER_DISPATCH', 'SCM', newId, null, { ...data, lotAllocations });
    closeModal();
    await Promise.all([refreshScm('supplierDispatches'), refreshScm('forgingProduction')]);
    renderSection();
    toast('Dispatch logged');
  } catch (e) {
    showModalError(friendlyError(e));
  }
}

/** Reverses a dispatch's lot allocation (restores qtyRemaining to every
    lot it consumed from) and deletes the dispatch doc, all in one
    transaction. Blocked if any scrap references this dispatch — that
    has to be resolved first since it's a downstream WIP deduction. */
async function deleteDispatch(id) {
  if (!isScmTanmay()) { toast('Access denied'); return; }
  const d = S.supplierDispatches.find(x => x.id === id);
  if (!d) return;

  const linkedScrap = S.scmScrapLedger.filter(x => x.dispatchRef === id);
  if (linkedScrap.length) {
    toast(`Can't delete — ${linkedScrap.length} scrap request(s) reference this dispatch. Resolve those first.`, 5000);
    return;
  }
  if (!confirm(`Delete this dispatch (${d.qtyDispatched} pcs to ${d.supplierName})? This restores the qty to Internal WIP and cannot be undone.`)) return;

  try {
    await db.runTransaction(async (tx) => {
      const lotRefs = (d.lotAllocations || []).map(a => db.collection('forgingProduction').doc(a.lotId));
      const lotSnaps = await Promise.all(lotRefs.map(ref => tx.get(ref)));
      lotSnaps.forEach((snap, i) => {
        if (!snap.exists) return; // lot itself was deleted separately — nothing to restore
        const alloc = d.lotAllocations[i];
        const current = snap.data().qtyRemaining ?? snap.data().qtyForged ?? 0;
        tx.update(snap.ref, { qtyRemaining: current + (+alloc.qty || 0) });
      });
      tx.delete(db.collection('supplierDispatches').doc(id));
    });
    await logAudit('DELETE_SUPPLIER_DISPATCH', 'SCM', id, d, null);
    await Promise.all([refreshScm('supplierDispatches'), refreshScm('forgingProduction')]);
    renderSection();
    toast('Dispatch deleted, qty restored to Internal WIP');
  } catch (e) {
    toast('Error: ' + friendlyError(e));
  }
}

function openScrapModal(id) {
  const s = id ? S.scmScrapLedger.find(x => x.id === id) : null;
  if (s && (!isScmAdmin() || s.status !== 'pending')) { toast('Access denied'); return; }
  const recent = S.supplierDispatches.slice().sort((a, b) => (b.date || '').localeCompare(a.date || '')).slice(0, 50);

  openModal(`
    <div class="modal-title">${s ? 'Edit Supplier Scrap Request' : 'Log Supplier Scrap'}</div>
    <div id="modal-err"></div>
    <div class="ibox"><i class="ti ti-info-circle" aria-hidden="true"></i>
      <span>Requests up to ${SCRAP_AUTO_APPROVE_MIN_QTY} pcs (or ${Math.round(SCRAP_AUTO_APPROVE_PCT * 100)}% of the dispatch, whichever is larger) are auto-approved. Larger requests need SCM Admin approval before they affect Supplier WIP.</span></div>

    <div class="f">
      <label for="sc-dispatch" class="f-req">Against Dispatch</label>
      <select id="sc-dispatch" onchange="onScrapDispatchChange(this.value)">
        <option value="">Select dispatch...</option>
        ${recent.map(d => `<option value="${d.id}" ${s?.dispatchRef === d.id ? 'selected' : ''}>${fmtDate(d.date)} · ${d.supplierName} · ${d.fpn}/${d.cpn} · ${d.qtyDispatched} pcs</option>`).join('')}
      </select>
    </div>
    <input type="hidden" id="sc-supplier" value="${s?.supplierId || ''}">
    <input type="hidden" id="sc-fpn" value="${s?.fpn || ''}">
    <input type="hidden" id="sc-cpn" value="${s?.cpn || ''}">
    <div class="row-2">
      <div class="f">
        <label for="sc-date" class="f-req">Date</label>
        <input type="date" id="sc-date" value="${s?.date || dateStr()}" max="${dateStr()}">
      </div>
      <div class="f">
        <label for="sc-qty" class="f-req">Qty Scrap (pcs)</label>
        <input type="number" id="sc-qty" min="1" value="${s?.qtyScrap ?? ''}" placeholder="e.g. 12">
      </div>
    </div>
    <div class="f">
      <label for="sc-defect" class="f-req">Defect Type</label>
      <select id="sc-defect">
        <option value="">Select defect type...</option>
        ${buildOpts(SCRAP_DEFECT_CODES, 'v', x => x.l, s?.defectCode || '')}
      </select>
    </div>
    <div class="f">
      <label for="sc-reason" class="f-req">Reason</label>
      <textarea id="sc-reason" rows="2" placeholder="e.g. Cracked during CNC machining">${s?.reason || ''}</textarea>
    </div>

    ${modalActions(s ? 'Save Changes' : 'Submit', `saveScrapRequest(${s ? `'${s.id}'` : 'null'})`)}
  `);
}

function onScrapDispatchChange(id) {
  const d = S.supplierDispatches.find(x => x.id === id);
  document.getElementById('sc-supplier').value = d?.supplierId || '';
  document.getElementById('sc-fpn').value = d?.fpn || '';
  document.getElementById('sc-cpn').value = d?.cpn || '';
}

async function saveScrapRequest(id) {
  if (id && !isScmAdmin()) { toast('Access denied'); return; }
  const dispatchRef = document.getElementById('sc-dispatch').value;
  const supplierId = document.getElementById('sc-supplier').value;
  const fpn = document.getElementById('sc-fpn').value;
  const cpn = document.getElementById('sc-cpn').value;
  const date = getField('sc-date');
  const qtyScrap = Number(getField('sc-qty'));
  const defectCode = document.getElementById('sc-defect').value;
  const reason = (getField('sc-reason') || '').trim();

  if (!dispatchRef || !date || !defectCode || !Number.isFinite(qtyScrap) || qtyScrap < 1 || !reason) {
    showModalError('Dispatch reference, Date, Defect Type, a valid Qty Scrap and a Reason are required.');
    return;
  }

  const dispatch = S.supplierDispatches.find(d => d.id === dispatchRef);
  const threshold = Math.max(SCRAP_AUTO_APPROVE_MIN_QTY, Math.round((dispatch?.qtyDispatched || 0) * SCRAP_AUTO_APPROVE_PCT));
  const autoApprove = qtyScrap <= threshold;

  const sup = S.suppliers.find(s => s.id === supplierId);
  const data = {
    date, supplierId, supplierName: sup?.name || '', fpn, cpn, dispatchRef, qtyScrap, defectCode, reason,
    status: autoApprove ? 'approved' : 'pending',
    ...(autoApprove ? {
      approvedBy: 'system', approvedByName: 'System (auto-approved)',
      approverRemarks: `Auto-approved — within tolerance (≤ ${threshold} pcs)`,
      approvedAt: serverTS(),
    } : {}),
  };
  try {
    if (id) {
      const before = S.scmScrapLedger.find(x => x.id === id);
      if (before.status !== 'pending') { showModalError('Only pending requests can be edited.'); return; }
      await db.collection('scmScrapLedger').doc(id).update({ ...data, updatedBy: S.sess.userId, updatedByName: S.sess.name, updatedAt: serverTS() });
      await logAudit('UPDATE_SCM_SCRAP_REQUEST', 'SCM', id, before, data);
      closeModal();
      await refreshScm('scmScrapLedger');
      renderSection();
      toast(autoApprove ? `Saved — auto-approved (within ${threshold} pcs tolerance)` : 'Scrap request updated');
    } else {
      const ref = await db.collection('scmScrapLedger').add({ ...data, requestedBy: S.sess.userId, requestedByName: S.sess.name, createdAt: serverTS() });
      await logAudit(autoApprove ? 'AUTO_APPROVE_SCM_SCRAP' : 'CREATE_SCM_SCRAP_REQUEST', 'SCM', ref.id, null, data);
      closeModal();
      await refreshScm('scmScrapLedger');
      renderSection();
      toast(autoApprove ? `Scrap logged — auto-approved (within ${threshold} pcs tolerance)` : 'Scrap request submitted for approval');
    }
  } catch (e) {
    showModalError(friendlyError(e));
  }
}

async function deleteScrapRequest(id) {
  if (!isScmTanmay()) { toast('Access denied'); return; }
  const s = S.scmScrapLedger.find(x => x.id === id);
  if (!s) return;
  if (s.status !== 'pending') {
    toast('Only pending requests can be deleted — approved/rejected ones are part of the audit trail.', 5000);
    return;
  }
  if (!confirm('Delete this scrap request? This cannot be undone.')) return;
  try {
    await db.collection('scmScrapLedger').doc(id).delete();
    await logAudit('DELETE_SCM_SCRAP_REQUEST', 'SCM', id, s, null);
    await refreshScm('scmScrapLedger');
    renderSection();
    toast('Scrap request deleted');
  } catch (e) {
    toast('Error: ' + friendlyError(e));
  }
}

/* ══════════════════════════════════════════════════════════════════════
   TAB 3 — OWNER'S CONTROL TOWER
   Internal Bottleneck (aged inventory) + live Supplier WIP across all
   CNC suppliers + 5-day forecast — read-only, no writes here.
   ══════════════════════════════════════════════════════════════════════ */
/* ── Working Month Helper functions ── */
function getForgingMonthDefaultRange(dateStrRef) {
  const ref = dateStrRef ? new Date(dateStrRef + 'T00:00:00') : new Date();
  const y = ref.getFullYear();
  const m = ref.getMonth(); // 0-indexed
  const d = ref.getDate();
  
  let start, end;
  if (d >= 20) {
    start = new Date(y, m, 20);
    end = new Date(y, m + 1, 20);
  } else {
    start = new Date(y, m - 1, 20);
    end = new Date(y, m, 20);
  }
  
  const pad = (n) => String(n).padStart(2, '0');
  const fmt = (dt) => `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
  return { start: fmt(start), end: fmt(end) };
}

function getActiveWorkingMonth() {
  if (S.scmConfig && S.scmConfig.workingMonthStart && S.scmConfig.workingMonthEnd) {
    return { start: S.scmConfig.workingMonthStart, end: S.scmConfig.workingMonthEnd };
  }
  return getForgingMonthDefaultRange();
}

async function saveWorkingMonth() {
  const start = document.getElementById('admin-wm-start').value;
  const end = document.getElementById('admin-wm-end').value;
  if (!start || !end) { toast('Please select both start and end dates.'); return; }
  try {
    await db.collection('config').doc('scm').set({ workingMonthStart: start, workingMonthEnd: end }, { merge: true });
    toast('Working month configuration saved.');
    closeModal();
    await loadScmData();
    renderSection();
  } catch (e) {
    toast('Error saving configuration: ' + e.message);
  }
}

async function resetWorkingMonthToDefault() {
  const def = getForgingMonthDefaultRange();
  try {
    await db.collection('config').doc('scm').set({ workingMonthStart: def.start, workingMonthEnd: def.end }, { merge: true });
    toast('Working month reset to default (20th to 20th).');
    closeModal();
    await loadScmData();
    renderSection();
  } catch (e) {
    toast('Error resetting configuration: ' + e.message);
  }
}

function openWorkingMonthModal() {
  const wm = getActiveWorkingMonth();
  const isAdmin = isScmAdmin();
  const dateRangeLabel = `${fmtDate(wm.start)} to ${fmtDate(wm.end)}`;

  let content = `
    <div class="modal-title">Configure Working Month</div>
    <div id="modal-err"></div>
    <div class="ibox" style="margin-bottom:16px">
      <i class="ti ti-calendar-event" aria-hidden="true"></i>
      <span>Current active forging month cycle is <strong>${dateRangeLabel}</strong>. This date range scopes the plan summary and planned stats in the Control Tower.</span>
    </div>
  `;

  if (isAdmin) {
    content += `
      <div class="f">
        <label for="admin-wm-start" class="f-req">Start Date</label>
        <input type="date" id="admin-wm-start" value="${wm.start}">
      </div>
      <div class="f">
        <label for="admin-wm-end" class="f-req">End Date</label>
        <input type="date" id="admin-wm-end" value="${wm.end}">
      </div>
      <div style="display:flex;gap:8px;margin-top:16px">
        <button class="btn btn-p flex-1" onclick="saveWorkingMonth()">Save Range</button>
        <button class="btn btn-s" onclick="resetWorkingMonthToDefault()">Reset (20th-20th)</button>
      </div>
      <button class="btn btn-ghost w-full mt-8" onclick="closeModal()">Cancel</button>
    `;
  } else {
    content += `
      <button class="btn btn-p w-full mt-16" onclick="closeModal()">Close</button>
    `;
  }

  openModal(content);
}

function workingMonthConfigSection(wm) {
  const dateRangeLabel = `${fmtDate(wm.start)} to ${fmtDate(wm.end)}`;
  return `
    <div style="display:flex;justify-content:space-between;align-items:center;background:var(--sur);padding:12px 16px;border-radius:var(--rs);border:1px solid var(--bdr-mid);margin-bottom:16px;flex-wrap:wrap;gap:8px">
      <div style="display:flex;align-items:center;gap:8px">
        <span class="imf-badge rag-g" style="padding: 4px 8px; font-weight: 700"><i class="ti ti-calendar-event" aria-hidden="true"></i>Active Cycle</span>
        <span style="font-weight:700;font-size:14px;color:var(--txt)">${dateRangeLabel}</span>
      </div>
      <div style="font-size:12px;color:var(--txt-muted)">
        Monthly stats are filtered to this cycle. Click "Working Month" in topbar to edit.
      </div>
    </div>
  `;
}

function progressRingHtml(pct, isUnplanned) {
  if (isUnplanned) {
    return `
      <div style="position:relative;display:inline-flex;align-items:center;justify-content:center;width:40px;height:40px" title="Unplanned production: ${pct} pcs">
        <svg width="40" height="40" style="transform:rotate(-90deg)">
          <circle cx="20" cy="20" r="16" stroke="var(--ok)" stroke-width="3" fill="transparent" />
        </svg>
        <div style="position:absolute;font-size:9px;font-weight:700;color:var(--ok)">Unpl.</div>
      </div>
    `;
  }
  
  const clampedPct = Math.min(100, Math.max(0, pct));
  const strokeColor = clampedPct >= 100 ? 'var(--ok)' : clampedPct > 0 ? 'var(--warn)' : 'var(--bdr-mid)';
  const offset = 100.53 - (100.53 * clampedPct) / 100;
  
  return `
    <div style="position:relative;display:inline-flex;align-items:center;justify-content:center;width:40px;height:40px" title="Progress: ${clampedPct}%">
      <svg width="40" height="40" style="transform:rotate(-90deg)">
        <circle cx="20" cy="20" r="16" stroke="var(--sur2)" stroke-width="3" fill="transparent" />
        <circle cx="20" cy="20" r="16" stroke="${strokeColor}" stroke-width="3" fill="transparent"
                stroke-dasharray="100.53"
                stroke-dashoffset="${offset}"
                stroke-linecap="round" />
      </svg>
      <div style="position:absolute;font-size:10px;font-weight:700;color:var(--txt)">${clampedPct}%</div>
    </div>
  `;
}

function getMonthlyPlanRollup(wm) {
  const rollup = {};

  // 1. Process forging plans within date range
  S.forgingPlans.forEach(p => {
    (p.shiftPlan || []).forEach(sp => {
      if (sp.date >= wm.start && sp.date <= wm.end) {
        if (!rollup[p.fpn]) {
          rollup[p.fpn] = {
            fpn: p.fpn,
            name: fpnName(p.fpn) || '—',
            planned: 0,
            actual: 0
          };
        }
        rollup[p.fpn].planned += (+sp.qtyPlanned || 0);
      }
    });
  });

  // 2. Process forging production within date range
  S.forgingProduction.forEach(prod => {
    if (prod.date >= wm.start && prod.date <= wm.end) {
      if (!rollup[prod.fpn]) {
        rollup[prod.fpn] = {
          fpn: prod.fpn,
          name: fpnName(prod.fpn) || '—',
          planned: 0,
          actual: 0
        };
      }
      rollup[prod.fpn].actual += (+prod.qtyForged || 0);
    }
  });

  return Object.values(rollup).sort((a, b) => b.planned - a.planned || a.fpn.localeCompare(b.fpn));
}

function monthlyPlanRollupSection(rollup, wm) {
  const periodLabel = `${fmtDate(wm.start)} – ${fmtDate(wm.end)}`;
  return `
    <div class="imf-tablewrap" style="margin-bottom:16px">
      <div class="imf-table-toolbar">
        <div class="grow">
          <div style="font-size:16px;font-weight:700">Monthly Forging Plan Summary (Part-wise)</div>
          <div class="text-sm text-muted">Rollup of all plans and production scoped to the active cycle (${periodLabel})</div>
        </div>
        <button class="btn btn-ghost btn-sm" onclick="exportMonthlyPlanRollup('excel')"><i class="ti ti-file-spreadsheet" aria-hidden="true"></i> Excel</button>
        <button class="btn btn-ghost btn-sm" onclick="exportMonthlyPlanRollup('pdf')"><i class="ti ti-file-text" aria-hidden="true"></i> PDF</button>
      </div>
      ${rollup.length === 0 ? emptyState('ti-calendar-event', 'No forging plans or production this month', 'There are no active planned shifts or logs within this working month date range.') : `
      <div class="imf-table-scroll">
        <table class="imf-table">
          <thead><tr>
            <th class="pin">FPN</th>
            <th>Forging Name</th>
            <th class="num">Planned (pcs)</th>
            <th class="num">Actual (pcs)</th>
            <th class="num" style="text-align: center; width: 80px">Progress</th>
            <th>Status</th>
          </tr></thead>
          <tbody>${rollup.map(r => {
            const pct = r.planned > 0 ? Math.round((r.actual / r.planned) * 100) : 0;
            
            let status = 'not_started';
            if (r.planned > 0) {
              if (r.actual >= r.planned) status = 'completed';
              else if (r.actual > 0) status = 'in_progress';
            } else {
              status = 'completed';
            }

            return `
              <tr>
                <td class="pin mono">${r.fpn}</td>
                <td>${r.name}</td>
                <td class="num mono">${r.planned.toLocaleString('en-IN')}</td>
                <td class="num mono">${r.actual.toLocaleString('en-IN')}</td>
                <td style="text-align: center; padding: 6px 0; vertical-align: middle">
                  ${progressRingHtml(pct, r.planned === 0)}
                </td>
                <td>${imfBadge(status, PLAN_STATUS_META)}</td>
              </tr>`;
          }).join('')}</tbody>
        </table>
      </div>`}
    </div>`;
}

function renderControlTower() {
  const bottleneck = getBottleneckData();
  const wipRows = getSupplierWipData();
  const forecast = getForecastData(wipRows);
  const wm = getActiveWorkingMonth();
  const rollup = getMonthlyPlanRollup(wm);

  document.getElementById('section-content').innerHTML = `
    ${workingMonthConfigSection(wm)}
    ${controlTowerStats(bottleneck, wipRows, rollup)}
    ${monthlyPlanRollupSection(rollup, wm)}
    ${bottleneckSection(bottleneck)}
    ${supplierWipSection(wipRows)}
    ${forecastSection(forecast)}
  `;
}

function controlTowerStats(bottleneck, wipRows, rollup) {
  const agedCount = bottleneck.filter(b => b.ageLevel !== 'ok').length;
  const totalInternalWip = bottleneck.reduce((s, b) => s + b.internalWip, 0);
  const totalSupplierWip = wipRows.reduce((s, r) => s + r.wip, 0);
  const anomalyCount = wipRows.filter(r => r.anomaly).length;
  const totalPlannedQty = rollup.reduce((s, r) => s + r.planned, 0);

  const stat = (icon, label, value, tone = '') => `
    <div class="card" style="padding:14px">
      <div class="flex items-center gap-8 text-muted text-xs" style="font-weight:700;letter-spacing:.04em">
        <i class="ti ${icon}" aria-hidden="true"></i> ${label}
      </div>
      <div class="mono" style="font-size:24px;font-weight:700;margin-top:6px;${tone}">${value}</div>
    </div>`;

  return `
    <div class="row-4" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin-bottom:16px">
      ${stat('ti-calendar-stats', 'Total Planned Qty (pcs)', totalPlannedQty.toLocaleString('en-IN'))}
      ${stat('ti-stack-2', 'Internal WIP (pcs)', totalInternalWip.toLocaleString('en-IN'))}
      ${stat('ti-clock-exclamation', 'FPNs Aging/Critical', agedCount, agedCount ? 'color:var(--imf-red)' : '')}
      ${stat('ti-truck-delivery', 'Supplier WIP (pcs)', totalSupplierWip.toLocaleString('en-IN'))}
      ${stat('ti-alert-triangle', 'WIP Anomalies', anomalyCount, anomalyCount ? 'color:var(--imf-red)' : '')}
    </div>`;
}

function bottleneckSection(rows) {
  return `
    <div class="imf-tablewrap" style="margin-bottom:16px">
      <div class="imf-table-toolbar">
        <div class="grow">
          <div style="font-size:16px;font-weight:700">Internal Bottleneck — Normalizing &amp; Shot Blast</div>
          <div class="text-sm text-muted">FIFO-aged undispatched forging stock, by FPN</div>
        </div>
        <button class="btn btn-ghost btn-sm" onclick="exportBottleneck('excel')"><i class="ti ti-file-spreadsheet" aria-hidden="true"></i> Excel</button>
        <button class="btn btn-ghost btn-sm" onclick="exportBottleneck('pdf')"><i class="ti ti-file-text" aria-hidden="true"></i> PDF</button>
      </div>
      ${rows.length === 0 ? emptyState('ti-circle-check', 'No internal WIP outstanding', 'All forged material has been dispatched to suppliers.') : `
      <div class="imf-table-scroll">
        <table class="imf-table">
          <thead><tr><th class="pin">FPN</th><th class="num">Internal WIP (pcs)</th><th class="num">Oldest Lot Age</th><th>Status</th><th></th></tr></thead>
          <tbody>${rows.map(bottleneckTableRows).join('')}</tbody>
        </table>
      </div>`}
    </div>`;
}

function bottleneckTableRows(r) {
  const expanded = !!_bnExpanded[r.fpn];
  const mainRow = `
    <tr>
      <td class="pin"><span class="mono">${r.fpn}</span>${fpnName(r.fpn) ? `<div class="text-xs text-muted">${fpnName(r.fpn)}</div>` : ''}</td>
      <td class="num mono">${r.internalWip.toLocaleString('en-IN')}</td>
      <td class="num">${r.oldestAgeDays}d</td>
      <td>${imfBadge(r.ageLevel, AGE_META)}</td>
      <td>
        <button class="imf-rowact" onclick="_bnExpanded['${r.fpn}']=!_bnExpanded['${r.fpn}'];renderSection()" aria-expanded="${expanded}" aria-label="Toggle lot breakdown">
          <i class="ti ti-chevron-${expanded ? 'up' : 'down'}" aria-hidden="true"></i>
        </button>
      </td>
    </tr>`;
  if (!expanded) return mainRow;
  const today = new Date(dateStr() + 'T00:00:00');
  const lotRows = r.lots.map(l => {
    const age = Math.floor((today - new Date(l.date + 'T00:00:00')) / 86400000);
    return `
      <div style="display:flex;justify-content:space-between;gap:12px;font-size:12px;padding:3px 0">
        <span class="mono">${l.lotNo}</span>
        <span class="mono">${fmtDate(l.date)} · ${age}d old</span>
        <span class="mono">${l.remaining.toLocaleString('en-IN')} pcs</span>
      </div>`;
  }).join('');
  return mainRow + `<tr><td colspan="5" style="background:var(--sur2);padding:8px 16px 16px">${lotRows}</td></tr>`;
}

function supplierWipSection(rows) {
  return `
    <div class="imf-tablewrap" style="margin-bottom:16px">
      <div class="imf-table-toolbar">
        <div class="grow">
          <div style="font-size:16px;font-weight:700">Live Supplier WIP — All CNC Suppliers</div>
          <div class="text-sm text-muted">Opening + Dispatched − Received − Approved Scrap</div>
        </div>
        <button class="btn btn-ghost btn-sm" onclick="exportSupplierWip('excel')"><i class="ti ti-file-spreadsheet" aria-hidden="true"></i> Excel</button>
        <button class="btn btn-ghost btn-sm" onclick="exportSupplierWip('pdf')"><i class="ti ti-file-text" aria-hidden="true"></i> PDF</button>
      </div>
      ${rows.length === 0 ? emptyState('ti-truck-delivery', 'No supplier WIP yet', 'Log dispatches and set opening balances to populate this view.') : `
      <div class="imf-table-scroll">
        <table class="imf-table">
          <thead><tr><th class="pin">Supplier</th><th>CPN</th><th>FPN</th><th class="num">Dispatched</th><th class="num">Received</th><th class="num">Scrap (Apprvd)</th><th class="num">Yield</th><th class="num">Current WIP</th><th></th></tr></thead>
          <tbody>${rows.map(r => `
            <tr>
              <td class="pin">${r.supplierName}</td>
              <td class="mono">${r.cpn}</td>
              <td><span class="mono">${r.fpn}</span>${fpnName(r.fpn) ? `<div class="text-xs text-muted">${fpnName(r.fpn)}</div>` : ''}</td>
              <td class="num mono">${r.dispatched.toLocaleString('en-IN')}</td>
              <td class="num mono">${r.received.toLocaleString('en-IN')}</td>
              <td class="num mono">${r.approvedScrap.toLocaleString('en-IN')}</td>
              <td class="num">${yieldBadge(r.yieldPct)}</td>
              <td class="num mono" style="font-weight:700">${r.wip.toLocaleString('en-IN')}</td>
              <td>${r.anomaly ? '<span class="imf-badge rag-r"><i class="ti ti-alert-triangle" aria-hidden="true"></i>Anomaly</span>' : ''}</td>
            </tr>`).join('')}</tbody>
        </table>
      </div>`}
    </div>`;
}

function forecastSection(forecast) {
  return `
    <div class="imf-tablewrap">
      <div class="imf-table-toolbar">
        <div class="grow">
          <div style="font-size:16px;font-weight:700">5-Day Arrival Forecast — Incoming Gear Blanks</div>
          <div class="text-sm text-muted">Projected per supplier+CPN from measured lead time × outstanding dispatch lots</div>
        </div>
        <button class="btn btn-ghost btn-sm" onclick="exportArrivalForecast('excel')"><i class="ti ti-file-spreadsheet" aria-hidden="true"></i> Excel</button>
        <button class="btn btn-ghost btn-sm" onclick="exportArrivalForecast('pdf')"><i class="ti ti-file-text" aria-hidden="true"></i> PDF</button>
      </div>
      ${forecast.length === 0 ? emptyState('ti-calendar-stats', 'No forecast available', 'Forecasts appear once a supplier has at least one outstanding dispatch.') : `
      <div class="imf-table-scroll">
        <table class="imf-table">
          <thead><tr><th class="pin">Supplier</th><th>CPN</th><th class="num">Lead Time</th><th class="num">Overdue</th>
            ${forecast[0].days.map(d => `<th class="num">${fmtDate(d.date)}</th>`).join('')}
            <th class="num">5-Day Total</th></tr></thead>
          <tbody>${forecast.map(f => `
            <tr>
              <td class="pin">${f.supplierName}</td>
              <td class="mono">${f.cpn}</td>
              <td class="num mono">${f.leadTimeDays}d${f.estimated ? ' <span class="imf-badge rag-b">Est.</span>' : ''}</td>
              <td class="num mono"${f.overdueQty > 0 ? ' style="color:var(--imf-red);font-weight:700"' : ''}>${f.overdueQty.toLocaleString('en-IN')}</td>
              ${f.days.map(d => `<td class="num mono">${d.qty.toLocaleString('en-IN')}</td>`).join('')}
              <td class="num mono" style="font-weight:700">${f.total.toLocaleString('en-IN')}</td>
            </tr>`).join('')}</tbody>
        </table>
      </div>`}
    </div>`;
}

/* ── Unified SCM Exports (Excel / PDF) ────────────────────────────────── */
async function exportPlan(format) {
  const q = searchQ.trim().toLowerCase();
  const wm = getActiveWorkingMonth();
  const today = dateStr();
  const list = getFilteredPlans();

  if (!list.length) { toast('Nothing to export — no forging plans match the current filters.'); return; }

  const rows = [];
  list.forEach(p => {
    let shiftRows = (p.shiftPlan || []).slice().sort((a, b) => a.date.localeCompare(b.date) || a.shift.localeCompare(b.shift));
    if (_planFilter === 'active') {
      shiftRows = shiftRows.filter(r => r.date >= wm.start && r.date <= wm.end);
    } else if (_planFilter === 'today_plus') {
      shiftRows = shiftRows.filter(r => r.date >= today);
    }

    shiftRows.forEach(r => {
      const qtyActual = S.forgingProduction
        .filter(prod => prod.planId === p.id && 
          (prod.targetPlanDate ? (prod.targetPlanDate === r.date && prod.targetPlanShift === r.shift) : (prod.date === r.date && prod.shift === r.shift))
        )
        .reduce((s, prod) => s + (+prod.qtyForged || 0), 0);
      const qtyPlanned = +r.qtyPlanned || 0;
      const status = planShiftRowStatus(r.date, qtyActual, qtyPlanned);
      rows.push({
        date: r.date,
        shift: FORGING_SHIFTS[r.shift]?.label || r.shift,
        fpn: p.fpn,
        hammer: p.hammerName || '—',
        qtyPlanned,
        qtyActual,
        status: PLAN_STATUS_META[status]?.label || status,
      });
    });
  });

  // Sort chronologically: Date earliest first, then Shift
  rows.sort((a, b) => a.date.localeCompare(b.date) || a.shift.localeCompare(b.shift));

  const totals = {
    shift: `${rows.length} shift${rows.length !== 1 ? 's' : ''}`,
    qtyPlanned: rows.reduce((s, r) => s + r.qtyPlanned, 0),
    qtyActual: rows.reduce((s, r) => s + r.qtyActual, 0),
  };

  const cycleLabel = _planFilter === 'active' ? `Cycle: ${fmtDate(wm.start)} to ${fmtDate(wm.end)}`
                   : _planFilter === 'today_plus' ? 'Today Onwards' : 'All History';

  const opts = {
    filename: `IMF_Forging_Plan_Report_${dateStr()}.${format === 'pdf' ? 'pdf' : 'xlsx'}`,
    reportTitle: 'Forging Plan Report',
    filterSummary: `${cycleLabel}${q ? ` · Search: "${searchQ}"` : ''}`,
    columns: [
      { header: 'Date', key: 'date', width: 12 },
      { header: 'Shift', key: 'shift', width: 12 },
      { header: 'FPN', key: 'fpn', width: 15 },
      { header: 'Hammer', key: 'hammer', width: 22 },
      { header: 'Planned', key: 'qtyPlanned', width: 14, align: 'right', numFmt: '#,##0' },
      { header: 'Actual', key: 'qtyActual', width: 14, align: 'right', numFmt: '#,##0' },
      { header: 'Status', key: 'status', width: 15 }
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

async function exportProduction(format) {
  const q = searchQ.trim().toLowerCase();
  const list = S.forgingProduction.filter(p => !q || (p.fpn || '').toLowerCase().includes(q))
    .slice().sort((a, b) => (b.date || '').localeCompare(a.date || ''));

  if (!list.length) { toast('Nothing to export — no production logs match the current filters.'); return; }

  const rows = list.map(p => {
    const remaining = p.qtyRemaining ?? p.qtyForged ?? 0;
    return {
      lotNo: p.lotNo || p.id,
      fpn: p.fpn || '—',
      hammer: p.hammerName || '—',
      date: p.date,
      qtyForged: +p.qtyForged || 0,
      remaining: remaining,
      shift: p.shift || '—',
      plan: p.planId ? 'Planned' : 'Unplanned',
      loggedBy: p.loggedByName || '—'
    };
  });

  const totals = {
    qtyForged: rows.reduce((s, r) => s + r.qtyForged, 0),
    remaining: rows.reduce((s, r) => s + r.remaining, 0)
  };

  const opts = {
    filename: `IMF_Forging_Production_Log_${dateStr()}.${format === 'pdf' ? 'pdf' : 'xlsx'}`,
    reportTitle: 'Forging Production Log',
    filterSummary: q ? `Search: "${searchQ}"` : 'All Production Logs',
    columns: [
      { header: 'Lot No.', key: 'lotNo', width: 18 },
      { header: 'FPN', key: 'fpn', width: 15 },
      { header: 'Hammer', key: 'hammer', width: 22 },
      { header: 'Date', key: 'date', width: 12 },
      { header: 'Qty Forged', key: 'qtyForged', width: 16, align: 'right', numFmt: '#,##0' },
      { header: 'Remaining', key: 'remaining', width: 16, align: 'right', numFmt: '#,##0' },
      { header: 'Shift', key: 'shift', width: 10 },
      { header: 'Plan', key: 'plan', width: 12 },
      { header: 'Logged By', key: 'loggedBy', width: 20 }
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

async function exportDispatch(format) {
  const q = searchQ.trim().toLowerCase();
  const list = S.supplierDispatches.filter(d =>
    !q || (d.fpn || '').toLowerCase().includes(q) || (d.cpn || '').toLowerCase().includes(q) || (d.supplierName || '').toLowerCase().includes(q)
  ).slice().sort((a, b) => (b.date || '').localeCompare(a.date || ''));

  if (!list.length) { toast('Nothing to export — no dispatches match the current filters.'); return; }

  const rows = list.map(d => {
    const lotCount = (d.lotAllocations || []).length;
    return {
      supplier: d.supplierName || '—',
      fpn: d.fpn || '—',
      cpn: d.cpn || '—',
      date: d.date,
      qtyDispatched: +d.qtyDispatched || 0,
      docNo: d.docNo || '—',
      lots: `${lotCount} lot${lotCount !== 1 ? 's' : ''}`
    };
  });

  const totals = {
    qtyDispatched: rows.reduce((s, r) => s + r.qtyDispatched, 0)
  };

  const opts = {
    filename: `IMF_Supplier_Dispatch_Log_${dateStr()}.${format === 'pdf' ? 'pdf' : 'xlsx'}`,
    reportTitle: 'Supplier Dispatch Log',
    filterSummary: q ? `Search: "${searchQ}"` : 'All Supplier Dispatches',
    columns: [
      { header: 'Supplier', key: 'supplier', width: 25 },
      { header: 'FPN', key: 'fpn', width: 15 },
      { header: 'CPN', key: 'cpn', width: 15 },
      { header: 'Date', key: 'date', width: 12 },
      { header: 'Qty Dispatched', key: 'qtyDispatched', width: 18, align: 'right', numFmt: '#,##0' },
      { header: 'Invoice/DC No.', key: 'docNo', width: 16 },
      { header: 'Lots', key: 'lots', width: 12 }
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

async function exportMonthlyPlanRollup(format) {
  const wm = getActiveWorkingMonth();
  const rollup = getMonthlyPlanRollup(wm);
  if (!rollup.length) { toast('Nothing to export — no plan summary data for this month.'); return; }

  const rangeLabel = `${fmtDate(wm.start)} – ${fmtDate(wm.end)}`;
  const rows = rollup.map(r => {
    const pct = r.planned > 0 ? Math.round((r.actual / r.planned) * 100) : 0;
    const pctLabel = r.planned > 0 ? `${pct}%` : 'Unplanned';
    
    let status = 'not_started';
    if (r.planned > 0) {
      if (r.actual >= r.planned) status = 'Completed';
      else if (r.actual > 0) status = 'In Progress';
    } else {
      status = 'Completed';
    }

    return {
      fpn: r.fpn,
      name: r.name,
      planned: r.planned,
      actual: r.actual,
      progress: pctLabel,
      status
    };
  });

  const totals = {
    name: `${rows.length} Part${rows.length !== 1 ? 's' : ''}`,
    planned: rows.reduce((s, r) => s + r.planned, 0),
    actual: rows.reduce((s, r) => s + r.actual, 0),
  };

  const opts = {
    filename: `IMF_Monthly_Forging_Plan_Report_${wm.start}_to_${wm.end}.${format === 'pdf' ? 'pdf' : 'xlsx'}`,
    reportTitle: 'Monthly Forging Plan Summary',
    filterSummary: `Active Cycle: ${rangeLabel}`,
    columns: [
      { header: 'FPN', key: 'fpn', width: 15 },
      { header: 'Forging Name', key: 'name', width: 25 },
      { header: 'Planned (pcs)', key: 'planned', width: 16, align: 'right', numFmt: '#,##0' },
      { header: 'Actual (pcs)', key: 'actual', width: 16, align: 'right', numFmt: '#,##0' },
      { header: 'Progress', key: 'progress', width: 14, align: 'right' },
      { header: 'Status', key: 'status', width: 18 }
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

async function exportBottleneck(format) {
  const list = getBottleneckData();
  if (!list.length) { toast('Nothing to export — no internal WIP bottleneck found.'); return; }

  const rows = list.map(r => ({
    fpn: r.fpn,
    internalWip: r.internalWip,
    oldestAge: `${r.oldestAgeDays}d`,
    status: AGE_META[r.ageLevel]?.label || r.ageLevel
  }));

  const totals = {
    internalWip: rows.reduce((s, r) => s + r.internalWip, 0)
  };

  const opts = {
    filename: `IMF_Internal_Bottleneck_Aging_${dateStr()}.${format === 'pdf' ? 'pdf' : 'xlsx'}`,
    reportTitle: 'Internal Bottleneck — Aging Forged Stock',
    filterSummary: 'Shot Blast & Normalizing Inventory (Aged Stock by FPN)',
    columns: [
      { header: 'FPN', key: 'fpn', width: 15 },
      { header: 'Internal WIP (pcs)', key: 'internalWip', width: 18, align: 'right', numFmt: '#,##0' },
      { header: 'Oldest Lot Age', key: 'oldestAge', width: 16, align: 'right' },
      { header: 'Status', key: 'status', width: 15 }
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

async function exportSupplierWip(format) {
  const list = getSupplierWipData();
  if (!list.length) { toast('Nothing to export — no supplier WIP records.'); return; }

  const rows = list.map(r => ({
    supplier: r.supplierName,
    cpn: r.cpn,
    fpn: r.fpn,
    dispatched: r.dispatched,
    received: r.received,
    scrap: r.approvedScrap,
    yield: r.yieldPct != null ? `${r.yieldPct}%` : '—',
    wip: r.wip
  }));

  const totals = {
    dispatched: rows.reduce((s, r) => s + r.dispatched, 0),
    received: rows.reduce((s, r) => s + r.received, 0),
    scrap: rows.reduce((s, r) => s + r.scrap, 0),
    wip: rows.reduce((s, r) => s + r.wip, 0)
  };

  const opts = {
    filename: `IMF_Live_Supplier_WIP_${dateStr()}.${format === 'pdf' ? 'pdf' : 'xlsx'}`,
    reportTitle: 'Live Supplier WIP — All CNC Suppliers',
    filterSummary: 'Active Supplier Inventory',
    columns: [
      { header: 'Supplier', key: 'supplier', width: 25 },
      { header: 'CPN', key: 'cpn', width: 15 },
      { header: 'FPN', key: 'fpn', width: 15 },
      { header: 'Dispatched', key: 'dispatched', width: 15, align: 'right', numFmt: '#,##0' },
      { header: 'Received', key: 'received', width: 15, align: 'right', numFmt: '#,##0' },
      { header: 'Scrap (Apprvd)', key: 'scrap', width: 16, align: 'right', numFmt: '#,##0' },
      { header: 'Yield', key: 'yield', width: 12, align: 'right' },
      { header: 'Current WIP', key: 'wip', width: 15, align: 'right', numFmt: '#,##0' }
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

async function exportArrivalForecast(format) {
  const list = getForecastData(getSupplierWipData());
  if (!list.length) { toast('Nothing to export — no forecast data available.'); return; }

  const cols = [
    { header: 'Supplier', key: 'supplier', width: 25 },
    { header: 'CPN', key: 'cpn', width: 15 },
    { header: 'Lead Time', key: 'leadTime', width: 14, align: 'right' },
    { header: 'Overdue', key: 'overdue', width: 12, align: 'right', numFmt: '#,##0' }
  ];

  const sample = list[0];
  sample.days.forEach((d, idx) => {
    cols.push({ header: fmtDate(d.date), key: `day_${idx}`, width: 12, align: 'right', numFmt: '#,##0' });
  });
  cols.push({ header: '5-Day Total', key: 'total', width: 16, align: 'right', numFmt: '#,##0' });

  const rows = list.map(f => {
    const rowObj = {
      supplier: f.supplierName,
      cpn: f.cpn,
      leadTime: `${f.leadTimeDays}d${f.estimated ? ' (Est)' : ''}`,
      overdue: f.overdueQty,
      total: f.total
    };
    f.days.forEach((d, idx) => {
      rowObj[`day_${idx}`] = d.qty;
    });
    return rowObj;
  });

  const totals = {
    overdue: rows.reduce((s, r) => s + r.overdue, 0),
    total: rows.reduce((s, r) => s + r.total, 0)
  };
  sample.days.forEach((d, idx) => {
    totals[`day_${idx}`] = rows.reduce((s, r) => s + r[`day_${idx}`], 0);
  });

  const opts = {
    filename: `IMF_5-Day_Arrival_Forecast_${dateStr()}.${format === 'pdf' ? 'pdf' : 'xlsx'}`,
    reportTitle: '5-Day Arrival Forecast — Incoming Gear Blanks',
    filterSummary: 'Projected Arrival Schedule from outstanding dispatch lots',
    columns: cols,
    rows,
    totals
  };

  if (format === 'pdf') {
    await exportToPdf(opts);
  } else {
    await exportToExcel(opts);
  }
}

async function deleteForgingPlanRow(planId, date, shift) {
  if (!isScmTanmay()) {
    toast('Access denied');
    return;
  }
  const plan = S.forgingPlans.find(x => x.id === planId);
  if (!plan) return;

  if (!confirm(`Delete plan row for ${fmtDate(date)} Shift ${FORGING_SHIFTS[shift]?.label || shift}? This cannot be undone.`)) return;

  try {
    const before = JSON.parse(JSON.stringify(plan));
    const shiftPlan = (plan.shiftPlan || []).filter(r => !(r.date === date && r.shift === shift));

    if (shiftPlan.length === 0) {
      await db.collection('forgingPlans').doc(planId).delete();
      await logAudit('DELETE_FORGING_PLAN', 'SCM', planId, before, null);
      toast('Plan deleted (no shifts remaining)');
    } else {
      const totalQtyPlanned = shiftPlan.reduce((s, r) => s + r.qtyPlanned, 0);
      const data = { shiftPlan, totalQtyPlanned };
      await db.collection('forgingPlans').doc(planId).update({ ...data, updatedBy: S.sess.userId, updatedByName: S.sess.name, updatedAt: serverTS() });
      await logAudit('UPDATE_FORGING_PLAN', 'SCM', planId, before, { ...plan, ...data });
      toast('Plan shift row deleted');
    }

    const linkedProds = S.forgingProduction.filter(prod => prod.planId === planId && prod.targetPlanDate === date && prod.targetPlanShift === shift);
    for (const prod of linkedProds) {
      await db.collection('forgingProduction').doc(prod.id).update({
        planId: null,
        targetPlanDate: null,
        targetPlanShift: null,
        updatedBy: S.sess.userId,
        updatedByName: S.sess.name,
        updatedAt: serverTS()
      });
    }

    await refreshScm('forgingPlans');
    await refreshScm('forgingProduction');
    renderSection();
  } catch (e) {
    toast('Error: ' + friendlyError(e));
  }
}

document.addEventListener('DOMContentLoaded', init);
