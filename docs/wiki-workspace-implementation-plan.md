# Wiki workspace implementation plan

## 1. Outcome

Doclang should behave as a Git-backed wiki whose pages are also OCaml
compilation units.

- The main page is a live Markdown document. The sidebar is a derived,
  text-editable CodeMirror outline of qualified OCaml modules.
- Pages autosave to ordinary `.live.md` files in the Git working tree.
- Typing `[[` completes an OCaml module path. A missing module can be created
  as a page without leaving the editor.
- Markdown page links and OCaml module references navigate to the same page.
- Each page compiles as a named OCaml compilation unit. Definitions do not
  leak into another page's unqualified scope.
- Changing a page's module path is a compiler-resolved project refactor, not a
  string replacement.
- Normal successful operation has no save, dirty, evaluation, or Git status
  indicator. Persistent UI appears only when something needs attention.

This plan replaces the explicit-save document list and `.doclang` change
history. Git becomes the history model. `.doclang` remains only for disposable
caches and transaction recovery.

## 2. One identity

A page has one user-facing identity: its qualified OCaml module path.

```text
Models.Statistics
```

The same path appears everywhere:

- OCaml: `Models.Statistics.mean`
- page link: `[[Models.Statistics]]`
- application URL: `/page/Models.Statistics`
- completion, backlinks, diagnostics, traces, and refactor previews:
  `Models.Statistics`

The source path is a deterministic storage encoding, not another name:

```text
Models.Statistics  <->  models/statistics.live.md
```

Each module component must use a restricted conventional OCaml form,
`[A-Z][a-z0-9_']*`. Encoding uncapitalizes the first ASCII character of every
component; decoding capitalizes it. The mapping is therefore reversible and
does not need a manifest, UUID, title registry, or alias database.

An H1 is ordinary Markdown content. It may match the module path, contain more
descriptive prose, or be absent. It has no effect on linking, search,
compilation, URLs, or page identity.

Internal page links have no custom display label. They always render the exact
module path. Renaming `Models.Statistics` to `Analysis.Statistics` is an
identity change that rewrites OCaml references, page links, the URL, and the
derived file path in one compiler-resolved transaction. Old names are not
retained as a second identity; Git history records the rename. An explicit
OCaml compatibility module can be created separately when an API genuinely
needs one.

A namespace prefix is not itself a page. `Models.Statistics` may exist beneath
the namespace `Models`, but a separate page/module `Models` may not coexist
with that namespace. Use `Models.Index` when a namespace needs an overview
page. This matches qualified OCaml directory semantics and avoids synthesizing
a module from both a page body and child pages.

## 3. Durable link representation

Internal page references use one small Markdown extension:

```md
See [[Models.Statistics]].
```

The durable text, rendered text, lookup key, and OCaml module path are the
same string. This removes relative-link rewriting, duplicate-name resolution,
display-target drift, and path exposure from the normal interaction.

The server parses wiki links into source-located page references:

```ocaml
type page_reference = {
  source_path : string;
  module_path : string;
  fragment : string option;
  resolved : bool;
  range : source_range;
}
```

Resolution rules:

1. Require a fully qualified, valid Doclang module path.
2. Resolve it exactly against the project page index.
3. Optionally retain and validate a heading fragment:
   `[[Models.Statistics#Assumptions]]`.
4. Report missing, invalid, and case-mismatched modules with exact source
   ranges.
5. Leave ordinary Markdown links for HTTP, `mailto`, assets, and non-page
   documents unchanged.

Backlinks and page-link dependencies are derived from these references on each
project snapshot. No backlink database is canonical.

Use a CommonMark parser that returns source spans. Do not locate links,
headings, wiki links, or fragments with regular expressions. Extend both the
server parser and CodeMirror grammar with the same wiki-link conformance
fixtures. Ordinary inline and reference-style Markdown links remain ordinary
links; they are not alternate page identities.

## 4. Link editing and navigation

Use one CodeMirror extension in the main document.

### 4.1 Reading state

- Keep the module path as ordinary editable source text.
- Hide the `[[` and `]]` delimiters with `visibility: hidden` while reserving
  their exact width. Reveal them subtly when the caret is in the link.
- Do not change line wrapping or horizontal geometry when focus changes.
- Hover shows the resolved module signature summary and an open action in a
  non-layout tooltip.
- Broken links use a subtle warning underline. They do not become large cards
  or permanent badges.

### 4.2 Editing state

- A plain click places the caret; it never moves the user to another page while
  they are trying to edit.
- `Cmd/Ctrl-click` and `Cmd/Ctrl-Enter` open the target.
- The hover tooltip provides a single-click open action for mouse navigation.
- `Cmd/Ctrl-K` replaces the module path through the same picker used
  by `[[`.
- The module path's source range remains directly editable. Each hidden
  delimiter pair is atomic: the caret can never stop between its brackets.
- Arrow-left at the start of the module path moves before the whole link;
  Arrow-right at the end moves after it.
- Backspace at the start or Delete at the end selects the whole link first; a
  second deletion removes it.
- Copying a complete link serializes `[[Module.Path]]`; copying within the
  module path copies only the selected characters.
- Typing the second `]` over the auto-inserted close delimiter advances the
  caret instead of inserting another character.
- IME composition cannot cross an atomic delimiter boundary.
- Undo treats completion, creation, replacement, and delimiter insertion as
  single editor transactions.

The interaction must not depend on whether the editor happened to have focus
before the click. That was the source of several earlier cursor and layout
problems.

### 4.3 Page picker

The project endpoint returns a compact page index:

```json
{
  "module": "Models.Statistics"
}
```

The browser caches the index by project version and filters it locally on every
keystroke. Searching does not make a network request. Rank exact module-path
matches first, then component prefix, token prefix, substring, and fuzzy
matches. Show only module paths.

If there is no suitable match, the final row creates a page. Creation derives
the source path directly from the entered module path and previews that path
only in the creation confirmation. The new page is written immediately, linked
from the current document, and opened only if the user requests it.

## 5. URL and navigation model

Use the qualified module path in application URLs:

```text
/page/Models.Statistics
```

The client uses `history.pushState` and handles `popstate`. Browser Back and
Forward restore:

- the open main page;
- selection and scroll position per page;
- the sidebar outline's cursor, folds, pending structural edit, and scroll
  position;
- the relevant inspector context when it is still valid.

A module-path refactor replaces the route and rewrites current browser-history
entries in the live session. After restart, the old URL is invalid because the
old module no longer exists.

An open editor also has a random, process-local `sessionPageId`. It is not
written into source and is not a durable page identity. Editor instances,
pending requests, undo state, and selections are keyed by this ID so a module
path refactor can rekey the page's identity without destroying its live
session.

Opening an OCaml module definition, Markdown page link, backlink, diagnostic,
trace event, or completion result calls one navigation service with a module
path and optional source range.

## 6. Qualified OCaml page modules

This is the first implementation phase because page identity is otherwise not
real.

### 6.1 Generated sources

For every page:

1. Parse the literate source.
2. Concatenate its executable regions in document order.
3. Preserve `#line` directives pointing to the `.live.md` file.
4. Apply observation and inline-expression instrumentation.
5. Write a generated lowercase `.ml` file at the path derived from the
   qualified module path.

For example, `Models.Statistics` is generated as `models/statistics.ml` inside
the build root. Its definitions are used as `Models.Statistics.mean`, not
injected into another page's unqualified scope.

Use Dune's qualified-subdirectory model (`include_subdirs qualified`) for the
first implementation instead of reimplementing its internal alias-module
scheme. A single serialized build service owns the project build directory and
keeps it warm for incremental requests. Never start concurrent Dune commands
against that directory. Cancellation marks an older result obsolete and
terminates its process when safe before starting the newest request.

Generated files live in a content-addressed cache under `.doclang/cache/` and
are never source files or Git history.

Compile two related forms:

- The uninstrumented form defines the canonical inferred `.cmi` page
  interface.
- The instrumented form contains observation, trace, and inline-result helpers
  and produces the runtime object while being checked against that canonical
  interface.

Use parallel generated build roots with the same relative unit paths so both
forms have the same qualified OCaml name. The uninstrumented build emits the
canonical inferred interface; the runtime build checks instrumented code
against that interface. Instrumentation-only bindings remain hidden, cannot
pollute module completion, and cannot cause dependent recompilation. Cache the
interface artifacts and instrumented runtime artifacts separately.

### 6.2 Dependency graph

- Resolve qualified compilation-unit references against the module-path page
  index and Dune's dependency graph.
- Reject page/namespace collisions before invoking the compiler.
- Detect and report module cycles with the participating pages and source
  references.
- Store both forward dependencies and reverse dependents in the immutable
  project snapshot.
- Read compiler `.cmt` typed trees into a semantic index containing stable
  compiler entity identities, definition locations, and occurrence locations.
  Use that index, not `ocamldep` or the current lexical definition scan, for
  go-to-definition, rename, and cross-page impact. The build dependency graph
  supplies ordering only.

OCaml references are the only dependency declarations. Dune compiles the
requested page and its dependency closure; Doclang does not maintain a second
path-based import system.

### 6.3 Incremental compilation and evaluation

Cache generated source, `.cmi`, and runtime objects by:

```text
compiler identity
+ qualified module path
+ generated source digest
+ dependency interface digests
+ instrumentation mode
```

The `.cmi` key uses the uninstrumented source and dependency interface digests.
The runtime object key additionally uses the instrumented source and
instrumentation mode.

On a code edit:

- invalidate the edited module;
- invalidate dependents only when its inferred interface changes;
- invalidate runtime results for every evaluation closure containing the
  changed implementation, even when the interface is unchanged;
- keep unaffected modules and earlier results;
- cancel any older draft job;
- compile immediately on the next animation frame, matching the current
  zero-debounce interaction;
- retain invalidated results at reduced opacity until replacements arrive.

Prose-only edits update rendering and autosave but do not compile or execute.
Changing only a link updates the page graph but does not rerun OCaml unless it
changes an executable inline expression.

Evaluation links the target page's dependency closure in topological order.
Runtime events carry module path, derived source path, source range, evaluation
ID, and project version.

Evaluation reads the current in-memory draft immediately; it does not wait for
autosave. A request contains draft overlays for any open page whose current
revision is newer than its acknowledged disk revision. The server applies
those overlays to an immutable disk snapshot before generating units.

Compilation reuse is keyed by dependency interface digests. Runtime result
coherence uses a stricter semantic input digest containing every linked unit's
generated-source or object digest, the target draft, compiler identity,
link order, and instrumentation mode. An implementation change may therefore
reuse dependent `.cmo` files but must rerun results that execute the changed
unit. A successful autosave of exactly the source already evaluated changes the
disk snapshot but not this digest, so it does not cause another run or hide a
valid result.

### 6.4 Merlin

Type and completion requests use the same generated source and compiled
interfaces:

- the target draft is generated in memory or in a request-specific cache;
- dependency `.cmi` directories are passed to Merlin;
- module completions include every project page;
- go-to-definition on `Models.Statistics.mean` resolves to the literate source
  range;
- a module reference itself resolves to the corresponding page;
- stale replies are rejected by module, draft digest, request generation, and
  project version.

Merlin remains the low-latency service for draft types and completions. Saved
and successfully compiled units also populate the typed-tree semantic index.
The definition and occurrences APIs combine the draft query with that index so
module-path refactoring never depends on textual matching.

### 6.5 Dependency and architecture index

Keep two related indexes:

- The module graph contains direct static edges used for build ordering. Dune
  and `ocamldep` provide these edges.
- The typed semantic index attaches referenced entities and source locations
  to each edge. It explains why the dependency exists.

Do not call a module “public” or “internal” based only on current edges. Record
these observed graph properties:

- `unused`: no incoming project edge and not an entry module;
- `namespace-local N`: every incoming project edge originates beneath `N`;
- `cross-namespace`: at least one incoming edge originates outside the
  module's namespace;
- `entry`: selected as an evaluation, artifact, executable, or library root;
- `package-exported`: explicitly exported to consumers outside the workspace.

Reserve an `Internal` path component for declared visibility:

```text
Models.Internal.Optimizer
```

A module below `N.Internal` may be referenced only by modules below `N`.
Doclang validates that rule against typed edges and reports violations as
compiler diagnostics. A boundary-visible module that is observed to be
namespace-local may receive a non-blocking “move under `N.Internal`”
suggestion. Observed use never silently changes visibility or module paths.

Compute placement suggestions separately:

- The deepest common namespace of a module's direct dependents is a candidate
  owner namespace.
- If dependents span unrelated namespaces, prefer a shallower shared domain
  such as `Data` or `Support`.
- Namespace vocabulary and conceptual ownership remain primary; graph
  placement is only a suggestion.

For reachability analysis, connect a synthetic root to entry and
package-exported modules and orient edges from users to dependencies. After
condensing any invalid cyclic component for reporting, compute immediate
dominators. If `A` dominates `B`, the UI may say “reachable only through A.”
This is useful facade/implementation evidence, but it does not declare `B`
private and does not automatically move it.

When the sidebar caret selects a page leaf, the context pane shows:

```text
Models.Regression

Uses
  Data.Frame
  Models.Statistics

Used by
  Reports.Forecast
  Training.Run

Observed boundary
  Used outside Models by Reports.Forecast
```

Selecting a namespace aggregates incoming and outgoing boundary edges by
namespace. Hovering a stable module line subtly distinguishes direct
dependencies and direct dependents in the outline; unrelated lines recede.
Expanding an edge shows the referenced entities and locations from the typed
index. Cycles and `Internal` violations remain diagnostics rather than ordinary
architecture badges.

## 7. Git-backed storage and autosave

The current workspace directory is not itself a Git repository. The product
must detect this and offer one explicit initialization action. It must not run
`git init` silently.

Once Git-backed:

- the working tree is the current editable state;
- `HEAD` is the comparison baseline;
- commits and branches are history;
- Doclang does not maintain a competing `.doclang/changes.jsonl` history;
- `.doclang/cache`, transaction intents, and session recovery are ignored by
  Git.

### 7.1 Autosave protocol

Each open document has an independent session:

```text
qualified module path
derived source path
saved content digest
current edit revision
latest acknowledged revision
pending write
last error
```

Editor transactions update memory synchronously. Writes are serialized per
file and coalesced during a short idle window, with an immediate flush on blur,
navigation, page creation, and refactor. A newer edit is never overwritten by
completion of an older write. Browser shutdown cannot guarantee a network
flush, so every unacknowledged revision is also stored in IndexedDB and offered
for recovery on the next session. `pagehide` performs only a best-effort flush.

Every write:

1. compares the on-disk digest captured by the session;
2. writes through an atomic sibling temporary file;
3. rechecks file metadata and content immediately before replacement;
4. writes a transaction intent;
5. atomically exchanges the temporary and destination files where the platform
   provides `RENAME_SWAP`/`RENAME_EXCHANGE`;
6. hashes the displaced destination now held at the temporary path; if it no
   longer matches the expected digest, exchanges it back and reports a
   conflict instead of acknowledging the write;
7. stores the verified displaced file in content-addressed recovery storage;
   on platforms without exchange, stores a best-effort pre-replacement
   recovery object before atomic rename and explicitly does not claim the same
   race-free guarantee;
8. records the new digest and clears the intent after recovery is durable;
9. refreshes the project snapshot and page index;
10. acknowledges the written edit revision without replacing a newer draft;
11. clears its IndexedDB recovery copy and leaves no visible status on success.

An external process can still write between the final comparison and rename;
plain POSIX rename does not provide a digest-based compare-and-swap. The strong
path therefore requires exchange support. On a fallback platform, recovery
reduces damage but cannot prove that a racing external write was preserved; the
workspace reports this reduced capability when autosave is enabled. A project
filesystem watcher publishes version changes over an event stream. Clients
recheck clean sessions immediately and dirty sessions before their next write.

External changes are incorporated automatically when the local buffer is
unchanged. If both disk and buffer changed, keep the buffer, stop autosaving
that file, and show a persistent three-way conflict action backed by endpoints
that retrieve base, disk, and draft sources and apply a chosen resolution.
Never prompt merely because the user navigated.

The explicit Save button, dirty label, successful-save toast, and normal
“Ready” status are removed. Errors, conflicts, invalid module paths, compiler
failures, and disconnected-server state remain visible until resolved.

### 7.2 Git projection

Git status is computed when the user opens a changes view or invokes an agent
workflow, not rendered continuously in the document chrome.

- Show working-tree changes against `HEAD`.
- For a repository with an unborn `HEAD`, compare tracked content against
  Git's empty tree.
- Include untracked file contents; ordinary `git diff HEAD` does not.
- Present staged and unstaged changes accurately but do not modify the index.
- Use ordinary Git diffs as the exact source view.
- Derive rendered and semantic diffs on demand from the before and after
  sources.
- Do not auto-commit.
- Do not treat an untracked page as an error.
- Surface merge conflicts because they prevent parsing or compilation.

### 7.3 Workspace mutation coordinator

Autosave, create, move, rename, delete, and multi-file link rewrites share one
mutation coordinator.

Before applying a project refactor, the client:

1. pauses autosave for every affected `sessionPageId`;
2. drains in-flight writes;
3. includes each affected session's newest draft in the refactor request;
4. records its current edit revision.

The server then acquires the project mutation lock, validates one snapshot and
all expected file digests, incorporates the draft overlays, and publishes the
entire transaction. Its response contains the new snapshot, rewritten sources,
acknowledged revisions, source-path changes, and module-path mapping. The client
applies and rekeys all sessions before resuming autosave. A stale per-file
queue can therefore neither recreate an old derived path nor overwrite a
refactor result.

## 8. Text-editable sidebar outline

Derive the sidebar text from the module-path trie in `Page_index` and host it
in a lightweight CodeMirror editor:

```text
Home
Models
  Regression
  Statistics
Runtime
  Trace
  Worker
```

The sidebar is an editable projection, not a saved document. It has an editor
state and undo stack, but no `.live.md` source, evaluation, autosave queue, or
independent Git content. Valid structural edits are translated into page
operations against the real modules and files.

### 8.1 Text model

- One nonblank line represents one namespace component or page leaf.
- Two spaces represent one namespace level.
- Indentation supplies qualification, so descendants do not repeat their
  namespace.
- Namespace lines are derived from their descendants and are not pages.
- Sibling order is canonical alphabetical order. Moving a line without
  changing its indentation has no project meaning and normalizes back to that
  order.
- Blank lines exist only as temporary insertion rows.
- Prose, headings, code, and arbitrary list markers are invalid in this
  projection. Put overview content in `Index` or `Models.Index`.
- The structural parser maps every stable line to a full module path and a
  stable `sessionPageId`. The `Statistics` line above maps to
  `Models.Statistics`.

### 8.2 Cursor navigation

- When a collapsed caret enters a stable page-leaf line, open that page
  immediately while leaving focus and the caret in the sidebar.
- Do not navigate for a nonempty selection, IME composition, temporary blank
  row, invalid structural edit, or namespace line.
- Moving through pages with Arrow-Up and Arrow-Down replaces the current
  transient browser-history entry; it does not add one history entry per row.
- Following an explicit document link or focusing the main editor commits the
  currently open page as an ordinary navigation point.
- Navigation from the main document moves the sidebar caret to the
  corresponding leaf and unfolds its ancestors without stealing focus.
- Page switching uses cached `DocumentSession` instances, cancels obsolete
  language/evaluation requests, and never remounts the sidebar editor.

### 8.3 Structural editing

Normal text operations create a pending structural edit:

- Typing on an existing component proposes a leaf or namespace rename.
- Enter on a stable line inserts a temporary sibling row.
- Typing in that row proposes a new module.
- Tab and Shift-Tab change indentation and therefore propose reparenting.
- Pasting several valid lines proposes a batch create or subtree move.
- Editing a namespace component proposes renaming every descendant path.

The browser parses and previews the proposed module paths synchronously from
its cached indexes. It also starts a cancellable compiler-backed refactor
preview. The always-open context pane shows the full operation while text
remains in place:

```text
Models.Statistics → Analysis.Statistics

1 file move
4 OCaml references
3 page links
2 dependent modules
```

Continuous typing changes only the sidebar draft; it does not rename a module
after every keystroke. A valid structural edit commits when the user presses
Enter, moves the caret to another structural line, or moves focus out of the
sidebar. Commit waits for the latest compiler-backed preview and applies it
through the workspace mutation coordinator. Escape restores the last committed
projection.

After commit, regenerate the canonical outline, retain the cursor on the
renamed or created module, and record the transaction as one transient sidebar
undo step. `Cmd/Ctrl-Z` may apply the inverse only while every affected file
still has the digest produced by that transaction; otherwise it opens the Git
diff instead of overwriting later work.

Deleting an existing module is the one deliberate exception to automatic text
commit. Removing its complete line creates a visible pending deletion, and
`Cmd/Ctrl-Enter` confirms the delete preview. This prevents an ordinary
Backspace from destroying a page.

### 8.4 Decorations and accessibility

- Namespace folds use CodeMirror folding and place the disclosure marker in
  the margin, outside the editable text.
- The active page has one quiet line highlight.
- Invalid indentation, names, collisions, and incomplete refactors have
  source-like diagnostics and hover explanations.
- Every leaf line's accessible name and tooltip contain its full module path.
- Search uses CodeMirror search over the visible outline and unfolds the
  ancestors of matches.

## 9. Page operations

All multi-file changes go through the workspace mutation coordinator and
project refactor service. The service builds a change set in memory, validates
expected digests, writes transaction intent, applies atomic replacements, and
rolls back on failure.

### Create

- Validate the proposed qualified module path.
- Reject invalid components, page/namespace collisions, and unsafe derived
  paths.
- Create the derived `.live.md` file. Seed it with `# Module.Path` as a
  convenience, while treating that heading as ordinary editable content.
- Optionally insert a link at the initiating cursor.
- Add no status UI on success.

### Batch outline edit

- Diff the committed structural line map against the valid outline draft.
- Match existing leaves by `sessionPageId`, not only by line text, so a cut,
  paste, or reparent is recognized as a move rather than delete-plus-create.
- Normalize the diff into creates and module-path renames and preview them as
  one transaction.
- Reject ambiguous mappings and page/namespace collisions before writing.
- Exclude removed existing leaves from automatic application; they enter the
  separately confirmed deletion state.

### Rename module path

Example:

```text
Models.Statistics -> Analysis.Statistics
models/statistics.live.md -> analysis/statistics.live.md
```

- Obtain compiler-resolved references to the old qualified module.
- Rewrite OCaml module paths, `[[...]]` page links, routes, and cached project
  metadata.
- Reject any page/namespace collision at the new module path.
- Use a filesystem rename and let Git detect it. Do not use `git mv`, because
  that would modify the user's staging index.
- Show a compact preview grouped by page.
- Apply the file move and edits atomically.
- Rebuild the renamed unit and its dependents before declaring success.
- Return an explicit old-path-to-new-path mapping. The client uses it to
  update routes, draft overlays, pending autosaves, completion caches, and
  browser-history state while preserving the editor's `sessionPageId`, undo
  stack, selection, and scroll position.
- Never use unrestricted textual replacement.

Editing, adding, or removing an H1 is an ordinary source edit and never invokes
a page refactor.

### Delete

- Show inbound Markdown references and OCaml dependents.
- Refuse accidental deletion when referenced.
- On confirmation, move to the operating-system trash when practical. The
  sidebar updates automatically from the new page index.

## 10. Server and client changes

### 10.1 OCaml modules

Add:

- `Module_path`: parsing, reversible source-path encoding, validation, and
  page/namespace collision checks.
- `Page_index`: qualified module paths, links, and backlinks.
- `Module_graph`: compiler dependencies and reverse dependents.
- `Semantic_index`: typed definitions, occurrences, and source locations from
  compiler artifacts.
- `Architecture_index`: direct/reverse edges, namespace-boundary observations,
  `Internal` validation, placement suggestions, roots, and dominators.
- `Build_service`: serialized qualified Dune builds and interface/runtime
  caches.
- `Git_workspace`: repository discovery, status, diff, and tracked moves.
- `Mutation_coordinator`: autosave/refactor exclusion, draft draining, and
  session-rekey protocol.
- `Refactor`: transactional create, batch outline edit, module-path rename,
  namespace rename, and delete plans.
- `Autosave`: digest-checked file writes and external-change reconciliation.

Refactor:

- `Document.t` gains `module_path` and source-located page references, removes
  the semantic `title` field, and derives its source path. H1 nodes remain
  ordinary parsed Markdown blocks.
- `Project.snapshot` contains the page index and module graph.
- `Evaluator` consumes named units instead of concatenated documents.
- `Diff` reads Git before/after sources rather than defining history.
- `.doclang` object and change-journal code is removed after migration.

### 10.2 API

Replace path-centric mutation calls with:

```text
GET  /api/project
GET  /api/page?module=Models.Statistics
PUT  /api/page/source
POST /api/page
GET  /api/events
GET  /api/conflict
POST /api/conflict/resolve
POST /api/definition
POST /api/occurrences
GET  /api/dependencies?module=Models.Statistics
GET  /api/architecture?namespace=Models
POST /api/refactor/preview
POST /api/refactor/apply
GET  /api/git/diff
POST /api/evaluate
POST /api/type-at
POST /api/complete
```

Every active request carries the relevant qualified module path, content
digest, edit revision, project version, and semantic input digest. The server
derives the source path. Evaluation and language-service requests may also
carry newer open-document overlays.
Refactor apply carries the preview ID and expected digest of every affected
file.

### 10.3 Browser state

Replace the single global document save fields with:

- a `Map<sessionPageId, DocumentSession>` plus a module-path-to-session lookup;
- one project page-index cache;
- one compact module adjacency cache keyed by semantic input digest;
- one `ModuleOutlineSession`: generated text, structural line map, cursor,
  folds, pending edit, preview generation, and transient undo transaction;
- one navigation service;
- per-session evaluation, type, and completion request generations;
- one refactor preview/apply controller.

Keep both the main editor and sidebar outline DOM nodes stable. Inspector and
page-index updates must patch their own regions and never remount either
CodeMirror instance.

## 11. Delivery stages

### Stage 0: Characterization fixtures

- Add fixtures for invalid file stems, nested paths, page/namespace collisions,
  links, traces, inline results, and external edits.
- Report how every existing `.live.md` path and internal Markdown link maps to
  a qualified module path and `[[Module.Path]]` reference.
- Record current evaluation and source-location behavior.
- Add the reversible module-path/source-path library without changing runtime
  behavior.
- Build the core qualified-module page index; Stage 1 dependency resolution
  uses this index.
- Produce a migration report for the example workspace.

Exit condition: every existing page has either a valid non-colliding qualified
module path or a precise actionable diagnostic.

### Stage 1: Qualified page modules

- Generate and compile one qualified module per page through the serialized
  build service.
- Build the compiler dependency graph.
- Populate direct/reverse adjacency and validate `Internal` namespace
  boundaries.
- Move evaluation, Merlin types, completion, diagnostics, and artifacts onto
  named units.
- Add incremental interface-based invalidation.

Exit condition: one page can use `Models.Statistics.mean`;
go-to-definition reaches the other literate page; editing an unrelated page
causes no recompile or result invalidation.

### Stage 2: Page index and navigation

- Introduce `DocumentSession` and `sessionPageId` state before allowing
  multi-page navigation. Initially it may still use explicit Save.
- Extend the core page index with source-located `[[Module.Path]]` references,
  backlinks, and link diagnostics.
- Add module-based URLs and browser history.
- Route Markdown and OCaml navigation through one service.

Exit condition: Markdown links, OCaml module references, browser Back/Forward,
diagnostics, and traces all reach the correct page and source range without
discarding the in-memory draft, undo state, selection, or scroll position of
another page.

### Stage 3: Unified CodeMirror links

- Add a minimal digest-checked project transaction that creates a page and
  updates the initiating document. Do not wait for the full rename/delete
  refactor service in Stage 5.
- Implement stable-layout link decorations and tooltips.
- Implement `[[`, local search, target replacement, and create-on-demand.
- Add keyboard, pointer, selection, clipboard, undo, IME, and accessibility
  behavior.
- Use the extension in an isolated CodeMirror test harness before integrating
  it.

Exit condition: the interaction passes the browser matrix in section 12
without cursor traps, layout jumps, or focus-dependent behavior.

### Stage 4: Git and autosave

- Add Git repository detection and explicit initialization.
- Add per-document autosave sessions and filesystem watching.
- Remove save controls and normal success status.
- Replace the change journal UI with Git-backed diffs.
- Evaluate current draft overlays immediately and reuse the result when
  autosave acknowledges the same semantic input.

Exit condition: users can edit, navigate, close, reopen, and modify files
externally without losing text; only conflicts or failures produce status UI.

### Stage 5: Refactors and migration cleanup

- Implement create, batch outline edit, qualified-module/namespace rename, and
  delete previews.
- Use compiler references for module-path renames.
- Migrate invalid filenames and path-based Markdown page links.
- Remove shared-scope evaluation and `.doclang` history compatibility code.

Exit condition: all page operations are atomic, Git-visible, compiler-checked,
and recover correctly from a forced failure between any two write steps.

### Stage 6: Text-editable sidebar outline

- Generate canonical indented text and a structural line map from `Page_index`.
- Mount the projection in a persistent lightweight CodeMirror editor.
- Add cursor-driven page navigation without focus transfer or history spam.
- Implement pending rename, create, indent/reparent, paste, and namespace
  edits through transaction filters.
- Connect commit boundaries to compiler-backed refactor preview and apply.
- Add the explicit confirmed-deletion state and digest-checked transient undo.
- Add namespace folding, search, diagnostics, active-page reveal, and
  accessibility metadata.

Exit condition: a user can navigate and reorganize a 1,000-page project using
ordinary cursor and text operations, while no partial edit can bypass the
compiler-resolved mutation coordinator.

### Stage 7: Polish and performance

- Add direct dependencies, dependents, boundary observations, dominator
  evidence, backlinks, and module metadata to the contextual pane only when
  relevant.
- Add outline hover highlighting for direct dependency direction.
- Expose placement suggestions without automatically moving modules.
- Tune local search ranking and large-project page-index transfer.
- Cache parsed documents and compiled interfaces.
- Ensure errors reserve space or overlay rather than shifting the editor.
- Remove obsolete project overview, status, and history controls.

Exit condition: the performance and accessibility budgets below pass on both a
small workspace and a generated 1,000-page workspace.

## 12. Verification

### 12.1 OCaml tests

- Reversible module-path/source-path encoding and namespace-collision
  properties.
- Wiki-link module resolution and invalid-path rejection.
- Qualified compilation, interfaces, dependency order, cycles, and
  diagnostics.
- Canonical interfaces exclude every instrumentation-only binding.
- Incremental invalidation after implementation-only and interface changes.
- Merlin type, completion, and definition queries across pages.
- Direct/reverse dependency edges and typed source evidence for each edge.
- `unused`, `namespace-local`, `cross-namespace`, `entry`, and
  `package-exported` classification fixtures.
- `N.Internal` visibility enforcement and suggested internal moves.
- Dominators with multiple roots, unreachable modules, and reported cycles.
- Source maps through generated modules and observation instrumentation.
- Autosave digest conflicts and transaction recovery.
- Exchange-write rollback when the displaced digest changed.
- Autosave paused across a module-path rename cannot recreate an old source
  path.
- Refactor preview/apply consistency and rollback.
- Git tracked, untracked, renamed, conflicted, and non-repository states.

### 12.2 Browser tests

Run real-browser tests for the main editor:

- click, double-click, modifier-click, tooltip open, and keyboard open;
- arrow across both ends of a link;
- Backspace/Delete at every link boundary;
- select, copy, cut, paste, drag selection, undo, and redo;
- Unicode, IME composition, screen zoom, and wrapped links;
- `[[` completion, missing modules, qualified page creation, cancel, and undo;
- wiki links beside ordinary inline and reference-style Markdown links;
- browser Back/Forward with unsaved in-memory edits;
- navigating during evaluation, completion, type lookup, and refactor preview;
- external file edit with clean and dirty buffers;
- server loss and recovery;
- mobile/narrow layouts using drawers without destroying editor state.

Test the sidebar outline separately:

- compact rendering shows `Models` once above `Regression` and `Statistics`;
- accessible names and tooltips expose the full qualified paths;
- Arrow-Up and Arrow-Down open stable leaves without moving focus or adding
  browser-history entries;
- selections, namespace lines, invalid edits, and IME composition do not
  navigate;
- main-document navigation moves the sidebar caret without stealing focus;
- component typing previews and commits leaf and namespace renames;
- Enter creates a temporary row and a valid component creates a module;
- Tab, Shift-Tab, multiline paste, undo, and canonical sibling ordering;
- removing a complete existing line cannot delete without explicit
  confirmation;
- failed or stale refactors restore a coherent committed projection;
- folds, search, diagnostics, and active-page reveal.
- dependency/dependent hover highlighting and namespace boundary summaries.

### 12.3 End-to-end scenarios

1. Create `Models.Statistics` from `[[Models.Statistics]]`, define `mean`, use
   `Models.Statistics.mean` elsewhere, and navigate in both directions.
2. Rename it to `Analysis.Statistics`; the derived file moves and all
   compiler-resolved references and wiki links update in one transaction.
3. Confirm that the old module and URL no longer resolve after restart.
4. Move the sidebar caret between modules and confirm that pages open without
   focus transfer, editor remounts, or history spam.
5. Change prose only and confirm that no OCaml job starts.
6. Change an implementation without changing its interface and confirm that
   dependents are not recompiled but evaluations that execute it rerun.
7. Introduce a conflict externally and confirm that Doclang preserves both
   versions and stops only the affected autosave queue.

### 12.4 Budgets

- Local page-picker update: under 16 ms at 1,000 pages.
- Local dependency highlighting: under 16 ms at 1,000 pages.
- Link hover and cursor movement: no network request and no layout shift.
- Prose keystroke: no compiler process.
- Code keystroke: prior job cancelled before the next job becomes current.
- Unaffected evaluation results: zero DOM remounts.
- Page navigation from cache: visible editor switch in one animation frame.
- No successful autosave or clean Git state consumes permanent UI space.

## 13. Main risks

### Compiler-unit migration

Named units reject unqualified cross-page names. Compiler diagnostics and
completion should guide qualification with the page module path; Doclang does
not retain a second import mechanism.

### Module-path rename correctness

OCaml aliases, local modules, functors, and shadowing make textual replacement
unsafe. Do not ship module-path rename until typed reference locations are
available.

### Namespace refactor scale

A namespace rename can move many pages and rewrite many references. The module
index must route it through the same mutation coordinator and typed refactor
preview as a leaf rename; it must never perform a direct tree or filesystem
move.

### Sidebar projection coherence

The sidebar has editable text but is not durable source. Partial text must stay
in a separate outline draft until a complete structural operation commits.
Filesystem changes, refactors from another surface, and failed previews must
rebase or reject that draft without silently replacing what the user typed.
The committed page index remains authoritative.

### Autosave and external tools

Git and AI agents may edit the same files. Digest checks and a persistent
conflict path are required before removing explicit Save.

### Decorative Markdown editing

Replacement decorations can create cursor traps and layout movement. Build and
stress-test the link extension independently before using it for core
navigation.

## 14. First implementation slice

The first coding slice should be narrow but architectural:

1. Add `Module_path` and `Page_index`.
2. Return qualified modules, resolved links, and backlinks from `/api/project`.
3. Generate one qualified OCaml module per page.
4. Compile a two-page fixture using `Support.Library.value`.
5. Make type-at and go-to-definition cross that page boundary.
6. Use Dune's compiler-derived dependency closure for evaluation.

Do not begin with the sidebar UI. Build it after qualified identity and
navigation are real so its editable buffer remains a checked projection of
`Page_index`, not a second durable source of project organization.
