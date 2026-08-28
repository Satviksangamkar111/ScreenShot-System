# UI Documentation Engine

Explores an enterprise web application (SAP Fiori/UI5), interacts with every
relevant control, captures screenshot evidence, and assembles a Word document
matching the format of the hand-made comparison documents.

## How it works

Two stages with a durable artifact between them:

```
config/apps/<app>.yaml
        │
        ▼
   CAPTURE  ──►  output/runs/<runId>/{trace.json, screenshots/}
   (drives the browser, one run per version)
        │
        ▼
   ASSEMBLE ──►  output/<Title>.docx
   (pure function of the trace; never opens a browser)
```

Because assembly reads a trace from disk, document formatting can be corrected
and the document regenerated without repeating a slow capture run.

### What becomes a documentation point

A control earns a label + screenshot when it is a **dropdown**, a **calendar**, a
**value help / lookup**, a **multi-select**, a **checkbox or radio**, a **file
upload**, or a **button that reveals new UI** (dialog, popup, page).

Deliberately excluded:

- **Plain text inputs and textareas** — still located, filled and committed, so
  dependent fields react and the form reaches a realistic state, but they earn
  no screenshot of their own. A text field carrying a value adds nothing the
  page's closing "Full Page" capture does not already show, and one point per
  text field buried the interactions that actually matter.
- **Read-only / display-only fields** — not interactive, so not evidence.
- **Pure action buttons** (Save, Search, Execute) — they change nothing visible,
  so there is nothing to photograph.
- **Dialog dismissal buttons** (OK, Cancel, Close) — they tear down the state
  being documented.

For controls that open an overlay, the **opened state is the evidence**: the
screenshot is taken with the dropdown expanded or the lookup dialog visible,
before a value is chosen — which is what a tester would actually see.

### Slow-loading applications

Enterprise Fiori applications commonly need **20–100 seconds** before their
content exists: the launchpad shell paints almost immediately, then the
component loads, the route resolves and data is fetched. Capturing on a fixed
delay photographs an empty shell.

The engine therefore waits on what has actually rendered — interactive controls
or a dialog present, nothing busy, and the count no longer changing — up to
`budgets.appReadyTimeoutMs` (default 3 minutes).

### Dialogs

Two kinds are treated differently:

- A **message** dialog (`Error: Both Account Group and Sales Org is mandatory`,
  with only an OK) is incidental. The engine clicks **OK** and carries on; it is
  never documented. These are also cleared between fields, since a validation
  message raised by one field would block every control beneath it.
- A **chooser** dialog (`Customer Category: Organization / Person`) is a branch
  point — see below.

### Full-page capture

A whole-page capture is taken as **consecutive viewport-sized screenfuls**, not
one tall image. The reference documents do exactly this — one of their "Full
Page" points is twelve consecutive screenshots — and it is not merely
stylistic: every image is embedded at a fixed width, so a single tall capture
of a long form shrinks into an illegible strip.

All segments of a capture appear under that point's single label, matching the
reference layout. Fiori usually scrolls an inner container rather than the
window, so the engine locates whatever actually scrolls instead of calling
`window.scrollTo`, which would otherwise photograph the same screenful
repeatedly.

### UI5 id churn

UI5 gives a view without an explicit id an auto-generated prefix taken from a
global counter — `__xmlview2--DueDateId`, `__xmlview2--BPGrpId`. The number is
assigned when the view instance is created, so re-instantiating the view
renumbers it to `__xmlview3--…` and **every id-based selector captured
beforehand silently matches nothing**. On a real run this surfaced as a long
list of "element not present" skips for fields that were plainly on screen.

Each control therefore carries a second, view-independent selector built from
the application-authored part of its id (`[id$="--DueDateId-inner"]`). That
form is **preferred** whenever it identifies exactly one element: Playwright
resolves a locator at action time, so a selector free of the volatile view
number stays correct even if the view renumbers between resolution and the
click or fill that follows — a race that otherwise fails a field which was on
screen throughout. The exact id is used when the suffix matches several
elements (two view instances briefly mounted together). Ids with no `--`
prefix (`SalesAreaDialog-cancel`) are application-authored already and need no
fallback.

### Loading overlays

A value-help dialog opens before its rows arrive, showing a busy indicator and
a placeholder row. The engine waits for the overlay's contents to settle before
photographing or selecting, so the evidence shows real data and the value
chosen is a real one — never the `Loading......` placeholder or a growing-list
`More` trigger.

### Editability checking

Every interaction — click, fill, toggle — is preceded by a fast check: is the
control present, visible, enabled, not read-only, and not covered by anything?
This replaced a real failure mode found in production: one field's dropdown
left an overlay open that never fully closed, and every field behind it —
correctly located, genuinely fillable once the overlay cleared — separately
ran out its full 30-second action timeout for the same underlying reason. 16
fields like that cost minutes; the same run now fails each one in about 3
seconds; see `budgets.editabilityCheckMs`.

A control found blocked gets one attempt at clearing whatever is covering it
(the common case) before the check gives up. If it still isn't interactable,
the control is skipped — quietly, not as an exception, since it never became
fillable rather than failing while being filled — and capture continues. A
dialog with no working Close/OK/Escape is detected the same way: dismissal is
verified, not assumed, so an undismissable dialog is logged once and left
alone rather than retried on every page sweep.

### Staying inside the application

Two guards keep exploration anchored to the application being documented:

- **Shell chrome is never discovered.** Anything inside the Fiori Launchpad's
  `#shell-header` (Home, search, notifications, user menu) is skipped by both
  probes. It appears on every page of every application and belongs to none of
  them.
- **Navigation is scope-checked.** The run is anchored to the semantic object
  of its entry URL (`#RequestCustomerExtended-...` → `RequestCustomerExtended`).
  A link that lands on a different one has left the application: it is still
  captured as a documentation point, but never recursed into.

Without these, a real run followed the shell's Home icon into the app
launcher, opened an unrelated application from a tile, and bounced
Home → tile → Home → tile until the browser crashed — with none of that
belonging in the document.

When every recovery strategy fails, `backtrack()` finally reloads the
application's entry link. It still reports failure (that is a different page
from the one wanted, and the caller must not carry on interacting), but it
leaves the browser somewhere known and in-scope rather than wherever a runaway
navigation ended up.

### Navigation safety

Returning to a page — after a branch, a tab, or a link that navigated away
mid-page — is **verified**, not assumed. `backtrack()` checks the destination
against the target's fingerprint, title and URL, escalating through history
back → history back again → direct URL navigation → hard reload, verifying
after each attempt. If none succeed, exploration of that page's remaining
branches stops rather than risk interacting with an unknown page — this
applies equally to a failed tab return and to a link that jumped to a full new
page mid-form.

### Complete exploration

Every interactive element is discovered, not just form fields: buttons, links
(`<a>`, `role="link"`), menu items, tabs, toggles, checkboxes/radios,
dropdowns, and expandable sections (`aria-expanded`, `<details>`). A link or
menu item that navigates to a genuinely different page is explored as a full
child page — captured, its own controls processed, its own branches
followed — then the engine verifies its way back before touching anything
else on the page that link was found on.

### Hierarchical document

The generated `.docx` uses real Word heading styles rather than a flat label
list:

```
H1  Application title
H2  Version ("Old Version" / "New Version")
H3  Page or top-level branch (a chooser option, a tab)
H4  Sub-page or dialog reached from that page
—   Interaction points (label + screenshot) as body content
```

A simple, non-branching page produces no H3/H4 at all — its points sit
directly under H2, matching the reference documents' flat layout exactly.
Nesting beyond H4 falls back to a bold paragraph rather than an invalid
heading jump. The tree is built from each evidence item's `workflowPath` and
validated (`src/document/tree.ts`) — orphaned or misattributed nodes are
logged as warnings rather than silently producing a wrong document.

### Branching

When a dialog offers two or more real alternatives, each one leads to a
different workflow and all of them are documented. For every option the engine
captures the open dialog labelled with that option, takes the branch, explores
it to completion, then reloads the application to bring the chooser back and
takes the next one.

That reproduces the reference documents exactly: a workflow opens with a point
such as `Organization` showing the category dialog, followed by that branch's
own fields and its `Full Page`.

### Safety

The engine drives a real business system with dummy data, so buttons matching
`safety.denyLabels` (Save, Submit, Post, Approve, Delete, …) are **never
clicked**. Because such buttons yield no documentation point, refusing to click
them costs the document nothing. `safety.allowLabels` (Search, Execute, Go) are
read-only queries and are permitted.

## Setup

```bash
npm install
npx playwright install chromium
```

## Web interface

```bash
npm run serve
```

Open <http://localhost:5173>, paste one or both URLs, press **Generate
Document**. Leave a column empty to document only that one version.

Sign-in is handled for you: before any capture starts, the engine checks each
site headlessly, and for any that present a sign-in screen it shows a live
view in the page and waits. Once every sign-in is complete the capture runs automatically.
Sessions are saved **per origin** under `auth/.storage/`, so a host is signed in
to once and reused afterwards — and two versions on the same host only require
one sign-in.

URLs can also be prefilled for sharing:
`http://localhost:5173/?old=<encoded>&new=<encoded>`

## Command line

Create `config/apps/<app>.yaml` (copy `config/apps/example.yaml`), then:

```bash
# 1. Sign in once per version; the session is saved and reused.
npm run login -- --app <app> --version-id new

# 2. Capture each version independently.
npm run capture -- --app <app> --version-id old
npm run capture -- --app <app> --version-id new

# 3. Build the document from the most recent runs.
npm run assemble -- --app <app>
```

Or all of it in one go:

```bash
npm run run -- --app <app>
```

Useful flags: `--headed` to watch the browser, `--verbose` for per-control
logging, `--out <path>` to choose the output file.

Applications reachable without a login (for example IP-allowlisted hosts) can
set `requiresAuth: false` and skip step 1.

## Configuration

| File | Purpose |
|---|---|
| `config/apps/<app>.yaml` | URLs, safety policy, budgets, per-app overrides |
| `config/lexicon.yaml` | Canonical label names |
| `config/testdata.yaml` | Dummy values by label and by control kind |

**The lexicon is what keeps the two versions aligned.** Old and New are explored
independently, so an unchanged field only produces an identical document entry
in both if its label resolves the same way in both runs.

Value-help fields intentionally have no dummy value: the engine opens the lookup
and selects a real row, so the value is always valid in the target system.

Dates support `today` and relative offsets (`+30d`, `-1m`, `+1y`), and ranges as
`today..+30d`, so a start date is never after its end date.

## Output

```
output/
├── runs/<runId>/
│   ├── screenshots/        numbered in capture order
│   ├── trace.json          evidence records — the assembly stage's input
│   └── report.json         internal audit: pages, exceptions, budget stops
└── <Title>.docx            the deliverable
```

`report.json` holds everything internal — exception records, skipped buttons,
budget stops. None of it appears in the document, which contains only labels and
screenshots.

## Verifying against the fixture

`config/apps/fixture.yaml` points at a local page containing every control kind,
a read-only field, and a Save button that must never be clicked:

```bash
npm run run -- --app fixture
```

Expect 16 documentation points per version, 0 exceptions, and a Full Page
screenshot with all fields populated and **no** "RECORD SAVED" text.

## Troubleshooting

**The document has few or no points, and the screenshots look empty.**
The application had not finished rendering. Raise `budgets.appReadyTimeoutMs`
and re-run; the verbose log prints `ready after Ns (interactive=…, dialogs=…)`,
which shows what had actually appeared.

**The page title in the log is the launchpad's, not the application's.**
Same cause: the launchpad shell painted before the route resolved. Readiness
waiting handles this, but a very slow host may need a larger budget.

**A branch was skipped with "could not return to the branch point".**
The engine reloads the entry URL to bring an entry dialog back. If the
application does not present the chooser again on reload, that branch cannot be
reached automatically.

**Everything failed with "Element is not an `<input>`".**
A control's selector resolved to a wrapper rather than its editable element.
The engine resolves UI5 wrappers automatically; report the control type if a
custom control still fails.

**Points appear that should not, or vice versa.**
Use `excludeLabels` to drop a structurally-interactive control that is not a
meaningful point. Read-only fields, action buttons and dialog OK/Cancel buttons
are already excluded.

## Notes and limits

- **Native `<select>`** elements render their list in the operating system's own
  layer, which cannot be screenshotted; the engine sets a valid option and
  photographs the result instead. SAP Fiori dropdowns render in the DOM and take
  the normal opened-state path.
- **Loop detection** fingerprints the UI5 control tree first and the URL second,
  because Fiori commonly keeps one URL across many application states.
- **Budgets** (per-control timeout, per-page control cap, page cap, depth cap,
  wall-clock cap) bound every run; any that triggers is recorded in the report.
- Controls that cannot be automated are recorded as exceptions with a screenshot
  rather than silently skipped.
- A control with **no resolvable label** is still filled, so the closing
  full-page capture shows a complete form, but produces no point of its own —
  every point in the reference documents is identified by its label.
- Returning to a branch point **fully reloads** the application. Navigating to a
  URL that differs only by its hash is a same-document navigation and would
  leave a single-page application exactly where it is.
