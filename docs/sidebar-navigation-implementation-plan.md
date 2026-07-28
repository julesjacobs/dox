# Sidebar navigation implementation plan

## Goal

Keep the left pane as an editable textual module tree, while making ordinary
navigation immediate, visually stable, and distinct from structural
refactoring.

This change addresses four problems:

1. Active-page font weight changes alter glyph widths.
2. A first visit waits on a project-wide snapshot with no immediate feedback.
3. Namespace rows are inert and cannot have landing pages.
4. Cursor navigation can implicitly commit structural edits.

Collapsing, filtering, and recent-page UI are intentionally deferred. They add
controls before the basic cursor and namespace model is stable.

## Interaction states

The outline has four distinct states:

- **Open page**: a fixed-width green inset marker and dark text.
- **Cursor row**: a quiet background, visible only while the outline is
  focused.
- **Pending page**: a separate neutral row treatment. The green open-page
  marker remains on the page whose document is visible. A small activity mark
  appears only if the request lasts longer than 120 ms.
- **Invalid draft row**: a red squiggle and inline hover diagnostic.

All rows use the same font weight. State changes must not change text metrics.
Namespace rows use color, not weight, to distinguish them.

The header and document continue to identify the last successfully opened
page until the pending page is available. This prevents a URL or title from
claiming that content has loaded when it has not.

## Navigation protocol

An explicit pointer selection or vertical cursor command that changes the
logical row:

1. Updates `pendingTarget` synchronously.
2. Uses a cached document session synchronously when available.
3. Otherwise starts a cancellable page-source request.
4. Cancels an older pending page request when the cursor moves again.
5. Swaps the document after its source is available.
6. Starts evaluation and dependency inspection independently in the
   background.

Only `Page(module)` enters this loading protocol. `Namespace(path)` is
selection and create-command context; it never sets a page-loading indicator
or calls `/api/page`.

Horizontal cursor movement within the same row does not navigate again.
Programmatic selection restoration, document reconfiguration, typing,
undo/redo transactions that change the document, and IME composition do not
navigate. The outline does not line-wrap, so one vertical cursor step always
means one structural row.

An unchanged outline navigates directly. A changed outline never navigates by
stale line number. Rows retain hidden origin metadata through CodeMirror change
mapping:

```text
{ rowId, originPath, originModule, proposedPath }
```

An unchanged path can reclaim its unique origin after cut/paste or reorder.
New or ambiguous rows have no navigation target until commit.

While a structural draft is dirty or invalid, a row with one unambiguous
committed page can still navigate immediately with `Page(originModule)`.
Namespace-only rows, new rows, and ambiguous rows only move the cursor. Cursor
movement never requests a structural commit, so one invalid row cannot trap
navigation elsewhere.

## Fast page reads

`GET /api/page` must not create a project-wide snapshot.

Module identity already maps deterministically to a source path. Add a direct
read operation that:

1. Validates the module path.
2. Derives its canonical `.live.md` path.
3. Takes the existing project lock for validation, open, and read using a
   cancel-aware nonblocking retry loop. It checks the HTTP disconnect callback
   before each retry and immediately after acquisition.
4. Checks for abandoned save/refactor intents and completes
   `Project.recover_transactions` before deciding that a page is missing or
   reading published state. Once recovery begins it runs to completion even if
   the HTTP client disconnects. Recovery failure is returned as a workspace
   recovery error, never as a false page-not-found result. Snapshot readers use
   the same recovery-before-read rule.
5. Uses a small native `openat` helper to walk from an opened canonical
   project-root descriptor. Every directory and the leaf are opened
   descriptor-relative with no-follow flags and verified with `fstat`.
6. Verifies the opened leaf is a regular file and reads from that same
   descriptor.
7. Reads and parses only that document.
8. Returns the canonical module, canonical path, document, and document digest.

Cancellation is checked again before parsing and responding. Every native and
OCaml descriptor is closed on cancellation or error, so aborted navigation
workers cannot queue behind a long save/refactor and exhaust the server worker
limit.

The request accepts `ifDigest`. An unchanged file returns
`{module, path, digest, notModified: true}`. A changed file returns
`{module, path, digest, notModified: false, document}`.

The page response no longer repeats the complete project snapshot. The client
keeps the project index and project version it already has; a direct read never
synthesizes a project version. Project-changing operations—create, save, and
refactor—continue returning a new authoritative project snapshot.

Request workers remain stateless. No authoritative navigation cache lives in a
forked worker. Disk under `project.lock` is authoritative, and navigation
caching is client-side.

Every visit to a clean cached session renders immediately and always starts one
coalesced background direct read keyed by `(canonical module, cached digest)`.
An unchanged digest ends without replacing the DOM. A dirty cached session also
checks, but keeps its local draft; a changed disk digest becomes a persistent
conflict instead of overwriting the draft.

A clean cached swap is provisional until revalidation completes. Retain its
navigation generation, previous validated target, and previous history state.
If index refresh confirms that the provisional target was deleted or renamed
and it is still open, atomically discard its clean session, restore the previous
validated document/header/open marker, replace the dead URL with the previous
URL, and show a concise persistent error. If the user has already navigated
elsewhere, only discard the obsolete cached session. A changed-but-existing
page applies under the edit-revision rules below and finalizes the provisional
history entry.

Before applying a changed response, re-check the session edit revision and
source. If it is still clean, replace the document while preserving editor
selection and scroll. If it became dirty during the request, retain the draft
and record a conflict. A missing or renamed page triggers one `/api/project`
refresh: remove a clean obsolete session, but retain a dirty session as a
conflict. Retry only the unchanged navigation or background semantic request
that discovered the mismatch, once.

If a digest differs from the current project index, a snapshot-backed request
reports a project-version conflict, or any successful snapshot-backed response
returns `projectVersion != state.projectVersion`, refresh `/api/project` and
reconcile sessions by canonical module/path before applying that response.
Never install a project version without installing its exact matching index.
Retry the unchanged background request once against the same target and client
generation.

This refresh rule applies to non-mutating semantic responses. Create, save, and
refactor responses already carry the exact authoritative project snapshot that
their new version describes; install their project, version, acknowledgement,
and mapping atomically.

Evaluation and dependency requests still capture a full stable snapshot,
because those operations need a coherent multi-file compiler input. Opening a
page does not.

## Browser history

The URL changes only after a page swap succeeds. Sidebar cursor navigation
starts a history point with `pushState`; subsequent vertical navigation while
the outline retains focus uses `replaceState`. An explicit wiki link or other
page command starts a new history point.

History state records the open module and outline selection. `popstate` cancels
pending page work, clears the pending treatment, and loads with history
disabled. A stale or failed completion cannot update content or history.
Refactors replace a route whose module was renamed.

Popstate restores and clamps the outline selection without emitting a
navigation transaction, even when the requested module is already open.
Per-page editor selection and scroll continue to come from document sessions.
Serializing an uncommitted outline draft, outline scroll, and inspector
selection into browser history is explicitly deferred; they remain intact in
the live workspace session.

## Parent pages

A module path may be both a page and the parent of child modules:

```text
Models                 opens Models
  Regression           opens Models.Regression
  Statistics           opens Models.Statistics
```

The canonical files are `models.live.md`, `models/regression.live.md`, and
`models/statistics.live.md`. The page, URL, link target, and OCaml module use
the same identity. `Index` has no special meaning.

The page-index outline entry gains:

- `path`: the structural namespace or leaf path represented by the row.
- `pageModule`: the page represented by the row, if one exists.
- `namespace`: whether the row has a structural namespace.
- `hasChildren`: whether it has visible child rows.

Navigation uses a discriminated target:

```text
Page(module) | Namespace(path)
```

Selecting a row with `pageModule` targets that page whether or not the row has
children. Selecting a namespace-only row only moves the outline cursor. A new
typed row creates its direct module path even when child rows are indented
beneath it.

Committed rows carry hidden `originPath` and `originModule` metadata. Editing a
surviving parent row renames or moves its page, while descendant rows carry
their own explicit mappings. Adding or removing the last child changes only
the structural `namespace` flag; the parent page identity is unchanged.

## Outline editing boundary

Track these separately:

- `outlineCursorLine`
- `openTarget`
- `pendingTarget`
- `outlineDraft`
- `outlineCommittedText`
- `outlineDraftDirty`

The structural draft is based on one atomic:

```text
outlineBase = { projectVersion, committedText, committedRowsWithOrigins }
```

The base also carries a structural fingerprint over canonical row paths,
`pageModule`, and origin identity. An authoritative project refresh installs
all fields together when the outline is clean.

When the outline is dirty and a page-content save or other authoritative
mutation returns a new full project version, derive fresh rows and compare the
structural fingerprint. If it is identical, atomically advance the base rows
and project version and remap draft origins by unique unchanged structural
identity. The draft remains committable; a content-only mutation must not create
a structural conflict.

If topology changed or an origin cannot be mapped uniquely, retain the entire
old base and draft, record a structural conflict, and reject structural commit.
Escape discards the draft and installs the refreshed authoritative base. No
implementation may combine unverified old row origins with a new project
version.

`onChange` parses and decorates locally and marks the structural draft dirty.
It never issues a refactor during composition. Structural commits occur on
`Mod-Enter`, outline focus exit, or after at least 900 ms of valid idle time
when the cursor has left every changed row. A temporarily valid component
prefix therefore does not refactor while it is still being edited.

Only one structural commit runs at a time. It captures a generation, drains
dirty page sessions through the existing refactor boundary, and preserves any
newer outline draft. On completion or failure, the newest valid generation is
rescheduled without losing cursor selection only when it is newer than the
submitted generation. A failed submitted generation remains local with its
error and is retried only after a new edit, authoritative rebase, or explicit
commit. Escape cancels only the uncommitted generation and restores the last
authoritative outline.

After a successful structural generation, rebase any newer draft through the
exact returned module/path mapping before rescheduling it. For example, if the
submitted generation applies `A -> B` while the newer draft proposes `C`, its
origin becomes `B` and the next verified operation is `B -> C`. If every origin
does not map uniquely, retain the newer draft as a structural conflict instead
of issuing another refactor.

## Failure behavior

- A page-load failure clears `pendingTarget`, keeps the prior document open,
  and leaves a persistent concise error in the status area.
- A structural commit failure keeps the draft and cursor intact.
- Dependency and evaluation failures do not revert a successful page switch.
- Normal successful navigation adds no status indicator.

## Validation

Automated:

- A direct page read does not call project snapshot traversal.
- Direct reads reject invalid paths and symlinks.
- Direct reads resist concurrent parent-directory replacement because every
  component is descriptor-anchored.
- Holding `project.lock` while aborting more page reads than the HTTP worker cap
  leaves no stale workers queued; the latest read succeeds promptly after
  release.
- An abandoned page quarantine/refactor intent is recovered before direct-read
  digest or deletion behavior is applied.
- Page-index output represents a direct parent page and its children on one
  row.
- Namespace rename/reparent maps the parent page and each descendant to their
  direct new module paths.
- Parent-page, namespace-only, nested-parent, last-child, and child-reorder
  cases round-trip without losing or inventing pages.
- Moving the outline cursor does not commit a dirty structural draft.
- Rapid navigation cancels obsolete page requests.
- Unchanged cache revalidation, external clean edits, typing during
  revalidation, dirty conflicts, and deleted/renamed cached pages, including
  rollback when the obsolete cached page is provisionally open.
- Active, cursor, and pending decorations do not change font weight.
- Typing during a structural commit reschedules the newest valid generation;
  a page autosave racing a namespace rename remains coherent.
- A content-only page autosave advances the outline base without discarding a
  pending rename; a newer structural draft rebases through an earlier
  generation's exact mapping.
- External create/rename/delete and semantic-triggered project refreshes never
  mix a dirty draft with a new outline base.
- Clean versus dirty `Mod-Enter` and Back after parent-page creation preserve
  the previous page.

Browser:

- First visits immediately mark the pending row and then switch.
- Cached visits switch synchronously.
- The current-page marker does not change text width.
- `Examples` opens `Examples`.
- Arrowing through several pages does not refactor the outline.
- Typing a valid rename does not commit while the cursor remains on its changed
  row; leaving it commits after idle. An invalid draft stays local.
- A→B→C rapid navigation followed by Back cannot apply a stale completion or
  write the wrong URL.
- Evaluation, dependency context, editor focus, and browser back navigation
  remain correct.
