/* ═══════════════════════════════════════════════════════════════════
   IMF ProTrack — Reports (reports.js)
   Admin-only cross-module reporting. Read-only — never writes to any
   transactional collection. Two tabs:
     throughput        — Operations Completed (existing OEE/operator
                          metric, untouched) vs Net Pieces Processed
                          (new — counts each TAG once per stage
                          boundary crossing, not once per operation)
     scheduleVsInward   — Supplier Schedule commitments vs actual
                          inward receipts linked against them

   Collections used (loaded per-module, read-only):
     actuals            — Production module's shift reports (owner: production.js)
     supplierSchedules  — Store module's supplier delivery schedules (owner: store.js)
     inward             — Store module's inward receipts (owner: store.js)
   ═══════════════════════════════════════════════════════════════════ */

'use strict';

let activeTab = 'throughput';

/* ── Throughput tab state ── */
let _thStage    = 'soft';   /* 'soft' | 'hard' */
let _thDateFrom = daysAgoStr(7);
let _thDateTo   = dateStr();

/* ── Schedule vs Inward tab state ── */
let _svFilt = 'open';  /* 'open' | 'closed' | 'all' */

const TABS = [
  { key: 'throughput',      label: 'Throughput',         icon: 'ti-chart-bar' },
  { key: 'scheduleVsInward', label: 'Schedule vs Inward', icon: 'ti-truck-loading' },
];

/* ══════════════════════════════════════════════════════════════════════
   INIT
   ══════════════════════════════════════════════════════════════════════ */
async function init() {
  try {
    await initShell();
  } catch (e) {
    clearSess();
    window.location.replace('index.html');
    return;
  }

  if (!canView('reports')) {
    window.location.replace('home.html');
    return;
  }

  try {
    await loadReportsData();
  } catch (e) {
    console.error('Reports data load failed:', e);
    toast('Error loading reports: ' + friendlyError(e), 5000);
  }

  render();
  document.getElementById('loading-screen').style.display = 'none';
  document.getElementById('app').style.display = '';
}

async function loadReportsData() {
  const [actSnap, schedSnap, inwSnap] = await Promise.all([
    db.collection('actuals').get(),
    db.collection('supplierSchedules').get(),
    db.collection('inward').get(),
  ]);
  S.actuals           = actSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  S.supplierSchedules = schedSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  S.inward             = inwSnap.docs.map(d => ({ id: d.id, ...d.data() }));
}

/* ══════════════════════════════════════════════════════════════════════
   LAYOUT — TABS + SECTION ROUTER
   ══════════════════════════════════════════════════════════════════════ */
function render() {
  const page = document.getElementById('page-content');
  page.innerHTML = `
    <div class="tabs" role="tablist" aria-label="Reports sections">
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
  activeTab = key;
  render();
}

function renderSection() {
  const map = {
    throughput:       renderThroughput,
    scheduleVsInward: renderScheduleVsInward,
  };
  (map[activeTab] || renderThroughput)();
}

/* ══════════════════════════════════════════════════════════════════════
   TAB 1 — THROUGHPUT
   Operations Completed: unchanged from production.js's existing
   totalProcessed sum (drives OEE / operator scorecards — do not alter
   the meaning of this number, only present it next to its counterpart).
   Net Pieces Processed: sums run.processed only for runs whose
   operation is partOps.finalOperation===true for that stage, so a
   batch that crosses 3-4 operations in a day is counted once per stage
   completion, not once per operation.
   ══════════════════════════════════════════════════════════════════════ */
function isFinalOpRun(run) {
  const po = (S.partOps || []).find(p => p.partId === run.partId && p.opId === run.opId);
  return po?.finalOperation === true;
}

function computeThroughput() {
  const reports = (S.actuals || []).filter(a => {
    if (a.stage !== _thStage) return false;
    if (_thDateFrom && a.date < _thDateFrom) return false;
    if (_thDateTo && a.date > _thDateTo) return false;
    return true;
  });

  /* Per-day rollup, keyed by date */
  const byDate = {};
  reports.forEach(r => {
    const d = byDate[r.date] || (byDate[r.date] = { date: r.date, opsCompleted: 0, netPieces: 0, rejected: 0 });
    (r.machines || []).forEach(me => {
      (me.runs || []).forEach(run => {
        d.opsCompleted += (+run.processed || 0);
        d.rejected     += (+run.rejected  || 0);
        if (run.tagId && isFinalOpRun(run)) d.netPieces += (+run.processed || 0);
      });
    });
  });

  const days = Object.values(byDate).sort((a, b) => a.date.localeCompare(b.date));
  const totalOps  = days.reduce((s, d) => s + d.opsCompleted, 0);
  const totalNet  = days.reduce((s, d) => s + d.netPieces, 0);
  const totalRej  = days.reduce((s, d) => s + d.rejected, 0);
  const inflation = totalNet > 0 ? (totalOps / totalNet) : 0;

  return { days, totalOps, totalNet, totalRej, inflation };
}

function renderThroughput() {
  const { days, totalOps, totalNet, totalRej, inflation } = computeThroughput();

  document.getElementById('section-content').innerHTML = `
    <div class="card" style="margin-top:8px">
      <div class="row-3">
        <div class="f">
          <label>Stage</label>
          <select onchange="_thStage=this.value;renderSection()">
            <option value="soft" ${_thStage === 'soft' ? 'selected' : ''}>Soft Stage</option>
            <option value="hard" ${_thStage === 'hard' ? 'selected' : ''}>Hard Stage</option>
          </select>
        </div>
        <div class="f">
          <label>From</label>
          <input type="date" value="${_thDateFrom}" onchange="_thDateFrom=this.value;renderSection()">
        </div>
        <div class="f">
          <label>To</label>
          <input type="date" value="${_thDateTo}" onchange="_thDateTo=this.value;renderSection()">
        </div>
      </div>
    </div>

    <div class="row-3" style="margin-top:14px;gap:14px">
      <div class="card" style="text-align:center">
        <div class="text-xs text-muted" style="text-transform:uppercase;letter-spacing:.04em">Operations Completed</div>
        <div class="mono" style="font-size:28px;font-weight:800;margin-top:4px">${totalOps.toLocaleString('en-IN')}</div>
        <div class="text-xs text-muted" style="margin-top:4px">Sum of every machine-run log — drives OEE &amp; operator scorecards. Unchanged.</div>
      </div>
      <div class="card" style="text-align:center">
        <div class="text-xs text-muted" style="text-transform:uppercase;letter-spacing:.04em">Net Pieces Processed</div>
        <div class="mono" style="font-size:28px;font-weight:800;margin-top:4px;color:var(--ok)">${totalNet.toLocaleString('en-IN')}</div>
        <div class="text-xs text-muted" style="margin-top:4px">Counted once per stage-completion (final operation only) — the true piece-flow number.</div>
      </div>
      <div class="card" style="text-align:center">
        <div class="text-xs text-muted" style="text-transform:uppercase;letter-spacing:.04em">Counting Inflation</div>
        <div class="mono" style="font-size:28px;font-weight:800;margin-top:4px;color:${inflation > 1.5 ? 'var(--err)' : 'var(--warn)'}">${inflation ? inflation.toFixed(2) + '×' : '—'}</div>
        <div class="text-xs text-muted" style="margin-top:4px">${totalRej.toLocaleString('en-IN')} rejected pcs in range (already excluded from both totals' WIP, tracked in scrapLedger).</div>
      </div>
    </div>

    <div class="imf-tablewrap" style="margin-top:14px">
      <div class="imf-table-toolbar">
        <div class="grow">
          <div style="font-size:16px;font-weight:700">Daily Breakdown</div>
          <div class="text-sm text-muted">${days.length} day${days.length !== 1 ? 's' : ''} in range</div>
        </div>
      </div>
      ${days.length === 0 ? `<div class="imf-empty"><div class="ic"><i class="ti ti-chart-bar" aria-hidden="true"></i></div><h3>No production reports in this range</h3><p>Try widening the date range or switching stage.</p></div>` : `
      <div class="imf-table-scroll">
        <table class="imf-table">
          <thead><tr>
            <th class="pin">Date</th>
            <th class="num">Operations Completed</th>
            <th class="num">Net Pieces Processed</th>
            <th class="num">Rejected</th>
            <th class="num">Inflation</th>
          </tr></thead>
          <tbody>
            ${days.map(d => `
              <tr>
                <td class="pin mono">${fmtDate(d.date)}</td>
                <td class="num mono">${d.opsCompleted.toLocaleString('en-IN')}</td>
                <td class="num mono" style="color:var(--ok)">${d.netPieces.toLocaleString('en-IN')}</td>
                <td class="num mono" style="color:${d.rejected > 0 ? 'var(--err)' : 'inherit'}">${d.rejected.toLocaleString('en-IN')}</td>
                <td class="num mono">${d.netPieces > 0 ? (d.opsCompleted / d.netPieces).toFixed(2) + '×' : '—'}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>`}
    </div>
  `;
}

/* ══════════════════════════════════════════════════════════════════════
   TAB 2 — SCHEDULE VS INWARD
   For each supplierSchedules line, sum inward receipts linked to that
   schedule (inward.linkedScheduleIds includes schedule.id), restricted
   to the matching partId within each receipt's parts[]. Delta = planned
   minus received. Overdue = due date passed with qty still outstanding.
   ══════════════════════════════════════════════════════════════════════ */
function computeReceivedForLine(schedule, line) {
  return (S.inward || [])
    .filter(r => (r.linkedScheduleIds || []).includes(schedule.id))
    .reduce((sum, r) => {
      const part = (r.parts || []).find(p => p.partId === schedule.partId);
      return sum + (part ? (+part.qty || 0) : 0);
    }, 0);
}

function renderScheduleVsInward() {
  const schedules = (S.supplierSchedules || []).filter(s => {
    if (_svFilt === 'all') return true;
    return (s.status || 'open') === _svFilt;
  });

  const today = dateStr();
  const rows = [];
  schedules.forEach(s => {
    (s.scheduleLines || []).forEach((line, idx) => {
      const received = computeReceivedForLine(s, line);
      const planned  = +line.qtyPlanned || 0;
      const delta    = planned - received;
      const overdue  = line.dueDate && line.dueDate < today && delta > 0;
      rows.push({ schedule: s, line, idx, planned, received, delta, overdue });
    });
  });
  rows.sort((a, b) => (a.line.dueDate || '').localeCompare(b.line.dueDate || ''));

  const totalPlanned  = rows.reduce((s, r) => s + r.planned, 0);
  const totalReceived = rows.reduce((s, r) => s + r.received, 0);
  const overdueCount  = rows.filter(r => r.overdue).length;

  document.getElementById('section-content').innerHTML = `
    <div class="card" style="margin-top:8px">
      <div class="f" style="max-width:260px">
        <label>Schedule Status</label>
        <select onchange="_svFilt=this.value;renderSection()">
          <option value="open" ${_svFilt === 'open' ? 'selected' : ''}>Open</option>
          <option value="closed" ${_svFilt === 'closed' ? 'selected' : ''}>Closed</option>
          <option value="all" ${_svFilt === 'all' ? 'selected' : ''}>All</option>
        </select>
      </div>
    </div>

    <div class="row-3" style="margin-top:14px;gap:14px">
      <div class="card" style="text-align:center">
        <div class="text-xs text-muted" style="text-transform:uppercase;letter-spacing:.04em">Scheduled (pcs)</div>
        <div class="mono" style="font-size:28px;font-weight:800;margin-top:4px">${totalPlanned.toLocaleString('en-IN')}</div>
      </div>
      <div class="card" style="text-align:center">
        <div class="text-xs text-muted" style="text-transform:uppercase;letter-spacing:.04em">Received (pcs)</div>
        <div class="mono" style="font-size:28px;font-weight:800;margin-top:4px;color:var(--ok)">${totalReceived.toLocaleString('en-IN')}</div>
      </div>
      <div class="card" style="text-align:center">
        <div class="text-xs text-muted" style="text-transform:uppercase;letter-spacing:.04em">Overdue Lines</div>
        <div class="mono" style="font-size:28px;font-weight:800;margin-top:4px;color:${overdueCount > 0 ? 'var(--err)' : 'var(--ok)'}">${overdueCount}</div>
      </div>
    </div>

    <div class="imf-tablewrap" style="margin-top:14px">
      <div class="imf-table-toolbar">
        <div class="grow">
          <div style="font-size:16px;font-weight:700">Schedule Lines</div>
          <div class="text-sm text-muted">${rows.length} line${rows.length !== 1 ? 's' : ''}</div>
        </div>
        <a href="store.html" class="btn btn-ghost btn-sm"><i class="ti ti-external-link" aria-hidden="true"></i> Manage in Store</a>
      </div>
      ${rows.length === 0 ? `<div class="imf-empty"><div class="ic"><i class="ti ti-truck-loading" aria-hidden="true"></i></div><h3>No supplier schedules yet</h3><p>Create one in Store → Supplier Schedule.</p></div>` : `
      <div class="imf-table-scroll">
        <table class="imf-table">
          <thead><tr>
            <th class="pin">Supplier / Part</th>
            <th>Due</th>
            <th class="num">Planned</th>
            <th class="num">Received</th>
            <th class="num">Delta</th>
            <th>Status</th>
          </tr></thead>
          <tbody>
            ${rows.map(r => `
              <tr>
                <td class="pin">
                  <div style="font-weight:700">${r.schedule.supplierName || '—'}</div>
                  <div class="text-xs text-muted mono">${r.schedule.partNo || r.schedule.cpn || r.schedule.fpn || '—'}</div>
                </td>
                <td class="mono">${r.line.dueDate ? fmtDate(r.line.dueDate) : (r.line.dueWeek || '—')}</td>
                <td class="num mono">${r.planned.toLocaleString('en-IN')}</td>
                <td class="num mono">${r.received.toLocaleString('en-IN')}</td>
                <td class="num mono" style="color:${r.delta > 0 ? 'var(--err)' : 'var(--ok)'}">${r.delta > 0 ? '−' : ''}${Math.abs(r.delta).toLocaleString('en-IN')}</td>
                <td>${r.overdue
                    ? '<span class="imf-badge rag-r"><i class="ti ti-alert-octagon" aria-hidden="true"></i>Overdue</span>'
                    : r.delta <= 0
                      ? '<span class="imf-badge rag-g"><i class="ti ti-circle-check" aria-hidden="true"></i>Fulfilled</span>'
                      : '<span class="imf-badge rag-b"><i class="ti ti-clock" aria-hidden="true"></i>On Track</span>'}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>`}
    </div>
  `;
}

document.addEventListener('DOMContentLoaded', init);
