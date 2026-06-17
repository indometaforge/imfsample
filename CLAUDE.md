# CLAUDE.md — IMF ProTrack System Context

> **Read this file in full before planning or writing ANY code.** It is the
> authoritative description of this codebase. The **current code is the source of
> truth**. The PRD (`IMF_ProTrack_PRD_v1_0.docx`) describes goals, the feature
> roadmap, and intended behaviour — consult it for *what to build next*, but
> **never revert working code to match the PRD**. Where code and PRD disagree,
> code wins; flag the discrepancy, do not "fix" it silently.

> **Filename note:** Claude Code auto-discovers `CLAUDE.md` (uppercase). If the
> agent you use looks for `claude.md`, keep a copy under that name too.

---

## 1. Project Overview

**IMF ProTrack** is a web-based **Manufacturing Execution System (MES)** for
**Indo Metaforge Pvt Ltd**, a gear manufacturing facility (target scale ~100,000
units/month). It digitises the full production lifecycle: raw-material inward →
requisition & issue → soft machining → heat treatment → hard machining → final QC
→ dispatch, plus maintenance and a management/approvals layer.

**Central architectural idea — the Route Card is the source of truth.** Every
physical, pre-printed QR-coded **TAG** (e.g. `TAG-042`) maps 1:1 to a Firestore
document in the `routeCards` collection (the **TAG UID is the document ID**).
Material state transitions, quality dispositions, and dispatch checks all happen
by **scanning a TAG** — there is no free-text bypass. A `routeCards` doc carries
full genealogy (parent card, rework markers), a live stage state machine, heat
code, operation history, and commercial stream sub-balances (`qty_oem`,
`qty_spares`, `qty_market`).

**Design mandate (from PRD, honour it):** *"Ruthless minimalism for the floor,
rich intelligence for the desk."* Every shop-floor screen must be completable
one-handed on a dusty 10″ tablet under time pressure.

---

## 2. Tech Stack & Architecture

### 2.1 Stack — zero build step

| Layer | Choice |
|---|---|
| Frontend | **Vanilla JS** (ES, `'use strict'`), plain **HTML**, one shared **`styles.css`**. No framework, no bundler, no transpiler. |
| Icons | Tabler Icons webfont (CDN). |
| Fonts | **Inter** (body), **Inter Tight** (headings/display). |
| QR scanning | `html5-qrcode@2.3.8` (CDN). |
| Backend | **Firebase 9.22.1 compat SDK** (app, auth, firestore) via CDN. |
| Database | **Cloud Firestore** (with offline persistence enabled best-effort). |
| Auth | Firebase Auth (email/password). |
| Hosting | Static file hosting (files served as-is; no server-side code). |

**There is no build pipeline.** Files are authored and served directly. Do **not**
introduce npm, Webpack, Vite, JSX, TypeScript, or any compile step without
explicit approval. If a dependency is genuinely needed, add it as a CDN `<script>`
and ask first.

### 2.2 Frontend structure — Multi-Page Architecture (MPA), NOT a bundled SPA

⚠️ **Important correction for the agent:** despite casual references to a "single
page app," this project is a **multi-page application**. Each module is its **own
HTML page** with its **own JS file**, and every page loads the shared `core.js`.
Navigation between modules is **real `<a href="x.html">` links → full page
reloads** (sidebar + bottom nav, built in `core.js`). **Do not add a client-side
router, hash routing, or a single-bundle SPA shell.** "Single page" *within* a
module means one HTML shell whose `#page-content` is re-rendered by JS via
tab/view switching — that is the intended pattern.

Every module HTML page follows the **identical shell**:

```
loading-screen → #app.shell ( #sidebar + .main( topbar + offline-bar + #page-content ) )
              → #bottom-nav  → #modal-overlay/#modal-content → #toast → #gdrop
Scripts: Firebase compat SDKs → (html5-qrcode where needed) → core.js → <module>.js
```

`core.js` renders the sidebar/bottom-nav, wires the menu toggle, offline banner,
modal, toast, QR scanner, session guard, and loads master data. Each
`<module>.js` renders only into `#page-content`.

### 2.3 The per-module JS contract (follow it exactly)

Every module file (`masters.js`, `store.js`, `production.js`, `approvals.js`,
`home.js`, `index.js`) follows the same skeleton:

```js
'use strict';
const TABS = [ ... ];                 // module tab definitions (where tabbed)
let _moduleState = ...;               // top-level `let` module state

async function init() {               // boot
  try { await initShell(); }          // from core.js: session guard + masters
  catch (e) { clearSess(); location.replace('index.html'); return; }
  await loadXData();                  // module-specific transactional fetch
  render();
  document.getElementById('loading-screen').style.display = 'none';
  document.getElementById('app').style.display = '';
}

function render() { /* writes innerHTML into #page-content */ }
function switchTab(key) { ... }
function renderSection() { ... }        // per-tab section renderer
function xRow(r) / xCard(r) { ... }     // one list item builder
function openXModal(id) { ... }         // one form per entity
async function saveX(id) / deleteX(id)  // one write per action

document.addEventListener('DOMContentLoaded', init);   // last line
```

**All handler functions are GLOBAL** (top-level `function` declarations). UI is
wired with **inline `onclick="fn()"`** in HTML strings, so any function referenced
from markup MUST be a global declaration — never nest it, never make it a
non-global arrow that the inline handler can't see.

**Why name collisions are fine:** only `core.js` + one module load per page, so
`store.js` and `masters.js` can both define `render`, `switchTab`, `emptyState`,
etc. without clashing. Keep this — do not "namespace" module functions.

### 2.4 Global state model

- **`S`** (in `core.js`) — the only shared global state object:
  - `S.sess` — `{ userId, name, role, stage, email }` (mirrored to `sessionStorage` key `imf_sess`).
  - Master arrays loaded **once on login**: `S.users, S.machines, S.parts, S.operations, S.partOps, S.customers, S.suppliers`, plus `S.shifts`.
  - `S.listeners` — active Firestore unsubscribe fns, torn down on logout.
- **Transactional data is loaded per-module**, never cached in `S`.
- Module-local state lives in top-level `let` vars in the module file.

### 2.5 Firestore: collections, the TEST_ proxy, and the central entity

**`db.collection()` is proxied in `core.js`.** When `TEST_MODE === true`, any
collection in `TRANSACTIONAL_COLLECTIONS` is transparently redirected to a
`TEST_`-prefixed collection. **Master collections are never prefixed.**

> 🔧 **Rule:** when you add a NEW transactional collection, you MUST register its
> name in the `TRANSACTIONAL_COLLECTIONS` set in `core.js`, or test/prod data
> will leak together. `TEST_MODE` is currently `true` and must be flipped to
> `false` for production.

**Master (live, never prefixed):** `users`, `machines`, `parts`, `operations`,
`partOps`, `customers`, `suppliers`, `config/shifts`, `config/tags`.

**Transactional (TEST_-prefixed in test):** `inward`, `iqcResults`,
`requisitions`, `routeCards`, `shiftDrafts`, `setupApprovals`,
`deviationRequests`, `actuals`, `plans`, `htCharges`, `qcInspections`,
`scrapLedger`, `finishedGoods`, `breakdowns`, `machineStatus`, `sparesRequests`,
`pmLogs`, `dispatches`, `pos`, `auditLogs`.

**`routeCards` — the central nervous system.** Doc ID = TAG UID. Key fields:
`partId`, `customerId` (locked at issuance), `batchCode`, `cardType`
(STANDARD/REWORK), `parentCardUid`, `cardColor`, `initialQty`, `currentQty`,
`status` (stage state machine), `opHistory[]`, `heatCode` (**write-once**),
`qty_oem`/`qty_spares`/`qty_market`, `createdAt`/`createdBy`.

**Stage state machine** (values used in code; see `validateCardForStage` in core):
`store_issued / soft_wip → soft_done → ht_queue → ht_done → hard_wip → qc_pending
→ qc_cleared → dispatched`, plus `scrapped`. (PRD uses UPPER_SNAKE labels;
**match the casing already present in the code**, not the PRD.)

### 2.6 Permissions model (`core.js`)

Roles: `operator, supervisor, hod, admin`. Department/stage values: `general,
soft, ht, hard, store, qc, dispatch, maintenance` (see `DEPT_STAGES` in
`masters.js`). A user's **stage** decides their *home area* (`STAGE_PERM_AREA`);
their **role** decides *how much* access they get. Use the helpers — never check
roles inline:

- `getPerm(action)` → `'full' | 'view' | 'hidden'`
- `canDo(action)` → perm is `'full'`
- `canView(action)` → perm is not `'hidden'`

> ⚠️ Frontend permission checks are **UX only**. Real enforcement must live in
> **Firestore Security Rules** (see §6 flaws). Never treat `canDo()` as security.

---

## 3. Folder Structure & Modularity Rules

### 3.1 Folder structure (flat — all files in one directory)

```
/  (project root, served statically)
├── index.html        index.js       → Login (no shell; Firebase auth + session)
├── home.html         home.js        → Role-aware dashboard / module launcher
├── store.html        store.js       → Store / Inward (inward, requisitions, issue, stock, TAG registry)
├── production.html   production.js  → Production (hub, setup, breakdown, reqs, reports, plans)
├── masters.html      masters.js     → Master Data admin (8 tabs)
├── approvals.html    approvals.js   → Central approvals hub (reqs, setup, deviations, spares)
├── ht.html           ht.js          → Heat Treatment (hub, charge loading, FM/HT/01 process log, history)
├── qc.html           qc.js          → Quality Control (inspect, setup approvals, history, cleared)
├── maintenance.html  maintenance.js → Maintenance (hub, breakdowns 4-step, PM log, health)
├── dispatch.html     dispatch.js    → Dispatch (hub, POs, dispatch sessions, tracksheet)
├── core.js                          → SHARED: Firebase init, S state, auth, shell, nav,
│                                       modal, toast, QR, permissions, OEE, route-card helpers
├── styles.css                       → SHARED design system (single stylesheet)
├── IMF_logo_jpg_2.jpg               → brand logo
└── i-v3.html                        → LEGACY monolith — reference only, DO NOT EDIT (see §7)
```

A new module = a new `<name>.html` (copy an existing shell verbatim) + a new
`<name>.js` following the §2.3 contract. Add it to the nav arrays in `core.js`
(`buildSidebar` / `buildBottomNav`) and to `MODULES`/`BUILT` in `home.js`.

### 3.2 Strict modularity rules — prevent monolithic files

1. **One module per page. Never merge modules.** Do not combine QC + Dispatch,
   etc., into one file "for convenience."
2. **Shared logic lives in `core.js`, not copied.** Before writing a utility,
   check core (§4). If two+ modules need it, it belongs in core.
3. **Function granularity inside a module** — split by concern:
   - one `render*()` per tab/section,
   - one `xRow()` / `xCard()` per list-item type,
   - one `openXModal()` per form,
   - one `async saveX()` / `deleteX()` per write.
   If a function exceeds ~60–80 lines, or mixes *data fetch + DOM building +
   Firestore write* in one body, **split it**.
4. **No business logic inside inline handlers.** `onclick="saveThing('id')"` —
   the handler calls exactly one global function; logic lives in that function.
5. **Keep handler functions global** (top-level declarations) — required by the
   inline-`onclick` pattern (§2.3).
6. **Match existing file conventions:** the banner comment block, the
   `init → render → switchTab → render* → row → modal → save` ordering, and the
   `let _privateState` naming for module-local vars.
7. **Register new transactional collections** in `TRANSACTIONAL_COLLECTIONS`.
8. **Every significant write calls `logAudit(...)`** and uses `serverTS()` for
   critical event timestamps (never client `Date` for setup/breakdown/approval times).

---

## 4. Shared `core.js` API — reuse, do not reinvent

Before writing any helper, use these:

**Shell / nav:** `initShell()`, `buildSidebar()`, `buildBottomNav()`,
`initSidebar()`, `initOfflineDetection()`.
**Auth / session:** `login()`, `logout()`, `getSess()`, `setSess()`,
`clearSess()`.
**Permissions:** `getPerm()`, `canDo()`, `canView()`.
**Masters:** `loadMasters()`, `reloadMasters()`.
**UI primitives:** `openModal(html)`, `closeModal()`, `toast(msg)`.
**Audit:** `logAudit(actionType, module, recordId, before?, after?)`.
**Time/format:** `serverTS()`, `dateStr()`, `tomStr()`, `fmtDate()`, `fmtTS()`,
`fmtINR()`, `greet()`.
**Labels/badges:** `slbl()`, `sbdg()`, `rlbl()`, `initials()`.
**Numbers:** `uid()`, `clamp()`, `round()`.
**QR:** `openQrScanner(onResult, title)`, `closeQrScanner()` (camera + manual
TAG entry fallback baked in).
**OEE engine:** `calcOEE(cycleTimeSecs, setupMins, downtimeMins, actualQty,
shiftMins=450)` → `{ targetQty, availableTimeOEE, maxCapacity, availableMins }`.
*Note: `maxCapacity` is Theoretical Max Output — never label it "OEE".*
**Route cards:** `fetchRouteCard(tagId)`, `validateCardForStage(card, stage)`,
`checkSequence(card, intendedOpId)`.
**Dropdowns/forms:** `buildOpts()`, `searchParts()`, `showPartDrop()`,
`hidePartDrop()`, `readForm()`, `setField()`, `getField()`, `getActiveShift()`.

---

## 5. Current State vs. Roadmap

### 5.1 Built and working (do not rewrite without approval)

- **Core platform** — Firebase init, `TEST_` proxy, `S` state, master loading,
  app shell, sidebar + bottom nav, offline banner, modal, toast, **QR scanner**,
  **audit logging**, **OEE engine**, route-card validation/sequence helpers.
- **Auth & session** (`index.js` + core `login/logout`) — email/password, profile
  fetch, `isActive` check, session storage, audit on login/logout.
- **Home dashboard** (`home.js`) — role-aware greeting, module grid, and (admin/HOD)
  quick stats + pending-approvals widgets.
- **Master Data** (`masters.js`, 8 tabs) — Machines, Parts & Routing, Operations,
  Customers (with **merge**), Suppliers, Personnel, User Access (role/stage +
  password reset), Shifts.
- **Store / Inward** (`store.js`) — multi-part inward receipts, requisitions
  (create/edit/cancel), Store-HOD approvals, **multi-TAG issuance with live
  accumulator (Route Card birth)**, stock balance, Route Cards list, TAG registry.
- **Production** (`production.js`) — hub, **setup gate + sequence-deviation
  request**, **shift-end checklist matrix** (actuals, DB-side drafts, auto-save),
  breakdown report/log, requisitions, in-module reports, plans view.
- **Approvals hub** (`approvals.js`) — requisitions, setup approvals, sequence
  deviations, and **maintenance spares requests** (approve/reject with history).
- **Quality Control** (`qc.js`) — TAG scan → final-op gate → 3-bucket disposition
  (scrap/rework/OK with free-text defect description) → rework card birth →
  scrap ledger → OEM/Spares/Market stream lock-in; setup approvals workspace.
- **Maintenance** (`maintenance.js`) — 4-step breakdown handshake
  (Report→Acknowledge→Diagnose→Release) with free-entry spares line items
  routed to admin/HOD for approval; PM log; MTBF/MTTR health analytics.
- **Dispatch** (`dispatch.js`) — monthly PO booking; header-locked dispatch
  sessions; QR verification gate (qc_cleared + stream match + part match);
  route-card sub-balance decrement; live tracksheet with RAG compliance badges.

`home.js` `BUILT = { masters, store, production, approvals, qc, maintenance, dispatch, ht }` — reports renders a **"Soon"** badge.

- **Heat Treatment** (`ht.js`) — hub (active-charge alert, stats); furnace charge loading (multi-TAG scan, heat-code write-once marriage, batch update statuses to `ht_queue`); FM/HT/01 process log (prewash, wash temp/pH, 5 temp checkpoints, atmosphere, dot-punch); complete charge with per-card yield audit (yielded/failed inputs, `ht_done` or `scrapped` route-card update, scrap-ledger on zero yield); history tab with per-charge yield %.

### 5.2 Roadmap — not yet built (build per PRD, adapt to current code)

| Module / Feature | PRD ref | Notes for the build |
|---|---|---|
| **Reports / Traceability** | FR-RPT-01..02 | Genealogy lookup (Inward→IQC→Issue→Ops→HT→QC→Dispatch); RPT-01..08 standard reports. |
| **IQC gate** | FR-INW-02 | Full ACCEPT/CONDITIONAL/REJECT → stock-inclusion logic (verify depth vs current inward flow). |

**Decisions made (locked, do not revert):**
- **No Defect Code Library master** — QC defect description is a free-text `<textarea>` so inspectors capture full detail without being constrained to a limited code set.
- **No Spare Parts Catalog master** — Maintenance spares are **free-entry line items** (name, qty, unitRate, supplierName) added inside the breakdown Diagnose step. All spares requests always go to admin/HOD for approval in the Approvals hub regardless of cost. Machine release is NOT blocked by spares approval — procurement is a parallel process.
- **`sparesRequests` collection** is registered in `TRANSACTIONAL_COLLECTIONS` in `core.js` and has its own tab in `approvals.js`.

---

## 6. UI/UX & Design System Guidelines

### 6.1 The design system is LOCKED — maintain it

All tokens live in `styles.css` `:root`. Use the variables; **introduce no new
raw colors, fonts, radii, or shadows**.

- **Brand navy:** `--imf-navy #1E2B6B` (+ `-dark/-deep/-light/-hover/-muted/-border`).
- **Steel accent:** `--imf-steel #2563EB`, `--imf-steel-light #EFF6FF`.
- **Surfaces:** `--bg #F3F4F8`, `--sur #FFFFFF`, `--sur2 #F8F9FC`.
- **Text:** `--txt #0F172A`, `--txt-mid`, `--txt-muted`, `--txt-dim`.
- **Borders:** `--bdr / --bdr-mid / --bdr-strong`.
- **Semantic:** `--ok #16A34A`, `--warn #D97706`, `--err #DC2626`, `--info-bg`,
  each with `-bg`/`-bdr` companions. Colour is **functional, not decorative**
  (green=good/running, amber=in-progress/partial, red=down/blocked, blue=pending).
- **Layout:** `--sidebar-w 240px` (252 ≥640px), `--topbar-h 56px`, `--bnav-h 64px`.
- **Radii:** `--r 12 / --rs 8 / --rxs 6 / --rpill 99`. **Shadows:** `--shadow-sm/md/lg`.
- **Type:** **Inter** body, **Inter Tight** headings. Reuse existing classes
  (`.card`, `.card-hd`, `.btn .btn-p/.btn-s`, `.li`, `.bdg-*`, `.stat-card`,
  `.mod-tile`, `.empty`, `.f` form rows, modal `.modal-title`/`.modal-handle`).

### 6.2 Honour the PRD floor-UX constraints

- Primary action buttons **full-width on mobile, ≥48px tap targets, icon + label
  (never icon-only)**.
- **Destructive/irreversible actions** (Finalize Shift, Approve Dispatch, deletes)
  → **two-step confirmation modal**. No one-tap finalisations.
- Hard blocks → full-width red banner, plain language, no error codes.
- Soft warnings → amber inline banner with a "Proceed Anyway" path **only where
  policy allows** (e.g. sequence deviation).
- After a successful scan, show card data with no extra confirm tap; scan result
  panel sits in the lower/thumb-reach zone.

### 6.3 Actively enrich and make fully responsive (do this proactively)

The visual *language* is locked, but the **layout is not finished**. On every
screen you touch, look for and propose improvements **within the existing system**:

- Tighten button placement, padding/margins, spacing rhythm, and visual hierarchy.
- Improve layout flow and make every view **fully responsive** across the
  breakpoints already in `styles.css` (**640 / 768 / 1024 / 1280px**): graceful
  mobile→tablet→desktop reflow, sidebar collapse/overlay on small screens, bottom
  nav on mobile, multi-column grids on desktop.
- Prefer richer-but-consistent components (stat cards, progress bars, RAG badges,
  collapsible groups) over plain lists where the PRD calls for them.
- Keep contrast high; never grey-on-grey. Make changes additive — don't restyle
  working screens wholesale.

---

## 7. Proactive Architect Mandate

You are not a passive code generator. Act as **Lead Architect + UI/UX reviewer**.
Establish a strong grip on quality from the first task and keep it throughout:

- **Call out architectural flaws and better approaches** before implementing —
  even if not asked. Offer the trade-off, then proceed with the agreed path.
- **Flag risky patterns** the moment you see them (oversized functions, duplicated
  logic that belongs in core, missing audit/`serverTS`, unregistered TEST_
  collections, security assumptions, non-atomic multi-doc writes).
- **Recommend best practices** concretely, tied to this codebase, not generic
  advice.

**Known issues / watch-items to raise when relevant (seeded for you):**

1. **Security is not yet enforced server-side.** Frontend `canDo()`/role hiding is
   UX only. PRD §7.3 requires authorization at the data layer → implement
   **Firestore Security Rules** mirroring the `PERMS`/stage model. Treat this as a
   real gap, not done.
2. **App-layer immutability needs DB backing.** `heatCode` write-once, audit
   append-only, breakdown timestamps server-only (PRD §6.3/§7.4) are currently
   enforced only in JS. Back them with Security Rules.
3. **Atomic transactions** for multi-doc writes — **batch split, QC 3-bucket
   disposition, HT heat-code marriage, dispatch decrement** must use Firestore
   `runTransaction`/`writeBatch` so partial writes can't corrupt a Route Card.
4. **`TEST_MODE` ships `true`.** Don't forget the prod flip, and keep
   `TRANSACTIONAL_COLLECTIONS` in sync with every new collection.
5. **Online-only modules.** PRD §7.5: QC and Dispatch must **not** operate offline
   (live stock interlocks). Guard their writes on `navigator.onLine`.
6. **Session/JWT expiry** (PRD: 8-hour auto-logout) is not implemented — note when
   touching auth.
7. **Duplicated per-module helpers** (`emptyState`, `sectionHeader`,
   `showModalError`, `modalActions`, `modalDeleteButton`) exist in several modules.
   This is acceptable today; if you're already editing those functions, *propose*
   promoting them to `core.js` — but don't do a sweeping refactor unprompted (see
   §8 golden rule).

---

## 8. Strict AI Guardrails

**Hard rules — non-negotiable:**

1. **Never overwrite or rewrite an existing, working module without asking first.**
   Default to **surgical, minimal edits** to the existing file. Propose large
   refactors; implement them only after explicit approval.
2. **Always consult this `CLAUDE.md` before planning or writing any feature.** If a
   request conflicts with it, stop and raise the conflict.
3. **Cross-reference the PRD for requirements, then adapt to the current codebase.**
   The PRD is the *intent*; the code is the *truth*. **Never revert current logic,
   naming, stage values, or structure to match the PRD.** Match existing casing and
   patterns (e.g. `soft_done`/`hard_wip`, not PRD's `SOFT_WIP`).
4. **Verify JS syntax before delivering any file** (e.g. `node --check file.js` or
   an acorn parse). Do not hand back a file with syntax errors.
5. **Preserve the zero-build vanilla stack and the design system.** No frameworks,
   bundlers, routers, new fonts, or new color tokens without approval.
6. **Keep handler functions global**, register new transactional collections, call
   `logAudit` + `serverTS` on significant writes, and reuse `core.js` helpers.
7. **Do not touch `i-v3.html`.** It is the legacy single-file version still running
   in the company, kept **only as a structural reference** (it is missing many
   features — that incompleteness is exactly why the app was split into the modular
   files above). Never copy its monolithic style; never edit it.
8. **Confirm destructive/irreversible actions** with a two-step modal, both in the
   UI you build and before you run anything destructive yourself.

**Default working loop for any task:** read this file → check the PRD for intent →
inspect the relevant existing module/`core.js` → propose the plan (and any
architectural concerns) → make surgical edits → verify syntax → summarise what
changed and what to watch.
