# Task: Apply design-critique fixes to Home & Store screens

Read `CLAUDE.md` in full first, then the PRD for intent. Follow every guardrail:
surgical minimal edits, do NOT rewrite working modules, preserve the zero-build
vanilla stack, keep handler functions global, reuse `core.js` helpers, keep the
locked design system, call `logAudit` + `serverTS` on significant writes, and run
`node --check` on every JS file you touch before finishing. Where a change is more
than cosmetic, show me the plan before implementing.

Scope: **Home (`home.html` / `home.js`) and Store (`store.html` / `store.js`)
only.** Make changes additive — don't restyle working screens wholesale. Files to
touch: `home.js`, `store.js`, `styles.css` (and only those unless you flag a reason).

---

## A. CRITICAL fixes

### A1. Mobile manager loses the entire pipeline
Currently `.home-grid` is `display:none` below 768px, so a supervisor/HOD on a
tablet in portrait sees only the four metric tiles — the production pipeline,
"Today", and "Alerts" panels vanish. This violates "rich intelligence for the desk".

- Add a **condensed pipeline** for the manager view on screens <768px: each stage
  as a single row (stage label + count + the existing `ps-bar` progress bar), NOT
  expandable, so the most valuable view survives on tablets. Reuse the existing
  `PIPELINE` array and `ps-*` classes/markup from `renderPipelinePanel` — do not
  invent new styling.
- Keep the 2×2 metric tiles above it. Keep the full 3-column `home-grid` for ≥768px
  unchanged.
- Drive visibility with the existing media-query pattern in `styles.css` (mirror how
  `.mob-metrics` / `.home-grid` already toggle at 768px).

### A2. Replace native `confirm()` in `deleteInward`
`deleteInward` (in `store.js`) uses the browser-native `confirm()`. CLAUDE.md §6.2
bans native/one-tap confirms for destructive actions. Replace it with the same
two-step styled modal pattern already used by `confirmDeleteRouteCard` /
`deleteRouteCard` in this same file — a confirmation modal with a short summary of
what's being deleted and a Confirm/Cancel pair. Keep the existing `logAudit` call.

### A3. Store design-system drift (inline styles, forked stat card, raw color)
- **Stat cards:** Stock Balance builds a bespoke inline `statCard()` while TAG
  Registry (adjacent tab) uses the CSS `.stat-card` class — two looks for the same
  concept. Consolidate onto `.stat-card`. If the period accent / extra line is
  needed, extend `.stat-card` in `styles.css` with a modifier class rather than
  forking it inline.
- **Raw color:** `renderStock` hardcodes `#7c3aed` for "Issued to WIP".
  **Add a new named token** in `styles.css` `:root` (e.g. `--accent-violet`) plus
  any `-bg`/`-bdr` companion you need, matching the existing token-naming
  convention, and reference the token instead of the hex. Also replace the loose
  `var(--acc)` usage with a defined token if `--acc` isn't already in `:root`.
- **Inline-style consolidation:** promote the recurring inline-styled patterns in
  `store.js` — the period pill-bar (`periodSelector`), the stat card, and the lot
  row in the issue/stock views — into reusable classes in `styles.css`. Keep the
  exact current appearance; this is a refactor for consistency, not a redesign.
  Use existing tokens only.

---

## B. Usability / interaction fixes (Home)

### B1. Operator dashboard — list the actual queue, not just counts
`loadOperatorData` already loads `stageCards`, but `renderOperatorDashboard` only
shows `wipCount` / `doneCount`. Add a tappable list of the operator's stage cards
(TAG id + part name + qty + status badge) so they see what's on their bench. Reuse
existing list/card/badge classes and the route-card badge maps; keep it compact and
one-handed. Keep the existing shift card, stage metrics, and Report Breakdown button.

### B2. "Today" panel — consistent row interaction
In `renderTodayPanel`, the Dispatches row expands (chevron) while the other three
rows navigate (`onclick="window.location=..."` on a plain `<div>`). This is both
unpredictable and not keyboard-accessible.
- Make the three navigation rows real anchors (`<a href>` wrapping the whole row)
  so they're focusable and announced — matching the keyboard support the expandable
  row already has (`role="button"`, `tabindex`, `onkeydown`).
- Keep the visual distinction clear: expandable rows keep the caret; navigation
  rows keep the arrow-right. Don't mix the two affordances on look-alike rows.

---

## C. Accessibility fixes (both screens)

### C1. Tap targets ≥44px
Inline destructive/icon buttons fall below the 44–48px standard the rest of the app
honors (e.g. the TAG-remove `btn-d btn-sm` at `padding:3px 7px` in the Issue
session, and other inline `btn-sm` controls on the floor flows). Bump these to a
minimum 44px hit area (padding or min-width/height) without changing the visual
weight elsewhere. The floor uses these with gloves on.

### C2. Small label legibility
Floor body/label text currently dips to 10px in spots (issue progress bar MIN/MAX
labels, "pcs in session", some stat labels). Raise functional labels to ~12px;
reserve 10px only for truly secondary metadata. Tablet-at-arm's-length readability.

### C3. Contrast + color-only signaling
- Audit any real text using `--txt-dim` (#94A3B8, ~2.9:1 — fails AA). Decorative
  chevrons are fine; switch any actual text/meta to `--txt-muted` or darker.
- Progress bars (`pg`/`pa`/`pr`) convey state by color alone. Add a non-color cue
  where a bar carries meaning (a short label or icon), since status badges already
  carry text but the bars don't.

---

## Constraints recap
- No frameworks/bundlers/routers/new fonts. No new raw colors except the single
  approved `--accent-violet` token in A3.
- Keep all handler functions global (inline `onclick` pattern).
- Don't touch `i-v3.html`.
- Run `node --check home.js` and `node --check store.js` before delivering.
- Summarize what changed per file and flag anything you intentionally left alone.

## Suggested order
A2 → A3 (tokens/classes first so later edits use them) → A1 → B1 → B2 → C1 → C2 → C3.
