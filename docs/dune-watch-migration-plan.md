# Dune watch migration plan

## Goal

Doclang pages are ordinary qualified OCaml modules. OCaml references are the
only dependency declaration. Dune owns incremental workspace compilation and
dependency discovery. Doclang continues to own literate source mapping,
interactive evaluation, tracing, and editor request cancellation.

## Source and module model

- Remove `doclang: imports` from the document model, JSON API, evaluator,
  refactorer, UI, examples, and tests.
- Map `models/statistics.live.md` to the generated source
  `pages/models/statistics.ml`, and compile `pages` with Dune
  `include_subdirs qualified`. The source therefore has the ordinary OCaml
  identity `Models.Statistics`; no textual path rewriting or generated
  `open` is needed.
- Generate `Doclang_prelude` beside the page sources.
- Preserve `#line` directives so Dune diagnostics point to the `.live.md`
  source.

## Persistent build workspace

Each project gets a generated workspace under
`.doclang/dune-workspace/`. It contains:

- `dune-project`;
- `pages/dune` and generated page `.ml` files;
- an immutable manifest containing the exact generated-source digest, compiler
  identity, Dune version, and compilation-unit-to-page mapping;
- Dune's persistent `_build` directory;
- a watcher log and PID file.

Source synchronization is content-addressed. The server coordinator serializes
it with builds; CLI commands use the existing workspace build lock. It
atomically writes only changed generated files and removes only stale generated
page files. A validated manifest records the generated files, so cleanup never
scans or deletes outside this workspace.

The server starts one build coordinator before it starts forking request
workers. The coordinator is the only process allowed to synchronize generated
source, own Dune, request builds, collect diagnostics, and extract dependency
data. Request workers communicate with it over a root-digest-named Unix socket
in the system temporary directory (macOS limits Unix socket path length). They
never mutate the generated workspace or start Dune.

The coordinator starts Dune with `build --passive-watch-mode` and issues
serialized `dune rpc build --wait` requests. This uses Dune's supported RPC
completion result instead of parsing watcher output or polling a readiness
file. The coordinator owns the Dune child PID. It also records the watcher's
process start identity so a replacement coordinator can terminate a leaked
watcher without signaling a reused PID. The HTTP parent tracks request-worker
PIDs explicitly, so it never reaps the coordinator as a request worker.

For CLI commands and tests, the same synchronization/build function uses a
one-shot build only when no passive Dune process owns that generated
workspace. It still reuses Dune's `_build` cache.

## Request and cancellation protocol

For a snapshot or unsaved draft:

1. Build the page index and derive a manifest digest from every executable page
   source. Prose-only edits do not change this digest.
2. Send the generated sources and requested page module to the coordinator.
3. The coordinator serializes requests, atomically synchronizes the complete
   manifest, then asks Dune RPC to build the requested page object. Dune builds
   only that page's compiler-derived closure, so an unrelated broken page does
   not block it.
4. Stop the HTTP worker's wait immediately when its client disconnects. The
   coordinator detects a closed peer, cancels its obsolete RPC client, and
   discards its response. Queued closed peers are skipped before they can
   build, so the coordinator reaches the newest source set without building
   every intermediate draft. Independent live requests remain serialized
   instead of canceling one another.
5. Return the graph and diagnostics produced from that request's synchronized
   source manifest.

Doclang currently has one active editable page and autosaves inactive sessions.
The coordinator therefore serializes one global draft overlay at a time. It
does not attempt to maintain several simultaneous generated overlays.

## Compiler-derived dependency graph

Before passive watch starts, run
`dune describe workspace --with-deps --format sexp --lang 0.1`. The coordinator
parses the versioned description and maps its explicit source and CMT paths
through the generated manifest. It repeats this step after the page-module set
changes, restarting passive watch around the description. After a successful
target build, `ocamlobjinfo` reads the exact described CMT artifacts and their
imported compilation units. Those imports form forward and reverse edges.

The graph includes every successfully built requested module and its built
dependency closure when another page fails. A never-built or currently failed
module has unknown dependencies. Evaluation may conservatively compile all
pages only to surface diagnostics for an unknown target.

`Project.resolve_documents`, dependency UI, artifact closure, and refactor
validation all use this one graph.

## Evaluation boundary

Dune performs canonical incremental compilation and determines the exact
dependency closure. The existing evaluator keeps its separate instrumented
runtime compilation because `@` tracing and block-output markers transform
source, but it now receives only the compiler-derived target closure. Moving
instrumented compilation and Merlin onto Dune-produced CMIs is a follow-up
optimization and consistency improvement.

## Dune module and editor model

- `pages/dune` uses `(include_subdirs qualified)`.
- The page library uses `(wrapped false)` and `(modes byte)`, making
  `models/statistics.ml` exactly `Models.Statistics`.
- `Doclang_prelude` is a separate support library. Generated page sources
  explicitly `open Doclang_prelude`.
- The page index forbids a page module from being a strict prefix of another
  page module; Dune cannot represent both `Models` and `Models.Statistics` as
  pages.
- Every Dune command receives `--root` with the absolute generated workspace.
  Its environment puts the selected OxCaml tool directory first in `PATH`.
  Compiler identity and Dune version are part of workspace invalidation.
- Merlin continues to receive an unsaved target overlay and the same
  compiler-derived document closure. `#line` directives and the manifest map
  diagnostics and type locations back to `.live.md`.

## Watcher lifecycle and recovery

- Starting the server starts one coordinator and one passive Dune process.
- Dune stdout/stderr append to a log truncated at the start of a watcher
  process when it exceeds 2 MB.
- A Dune exit is detected before the next request and the coordinator restarts
  it after ownership clears. It never runs a one-shot build concurrently
  against the same `_build`.
- Coordinator startup completes only after Dune RPC is ready. A second server
  for the same root is rejected, and the owning server restarts a coordinator
  that exits unexpectedly.
- The coordinator monitors an ownership pipe held only by the HTTP parent.
  Request workers close their inherited copy. If the parent exits without
  orderly cleanup, the pipe closes and the coordinator stops its Dune child,
  removes its socket, and exits so a replacement server can start.
- The server closes coordinator descriptors in request children, tracks worker
  PIDs explicitly, and terminates the coordinator on orderly shutdown.
- Generated source is disposable. Canonical `.live.md` files, save intents,
  and refactor intents remain outside the generated workspace.
- `.doclang/dune-workspace` stays ignored by Git.

## Validation

- Unit tests for source-path generation, reserved identities, safe stale-file
  cleanup, deep Dune artifact mapping, and direct/reverse graphs.
- Workspace tests proving qualified dependencies work without import metadata,
  local module shadowing remains correct, unrelated broken pages retain valid
  graph entries, and module refactors still compile.
- A passive-watch/RPC integration test builds a deep qualified module and
  verifies watcher recovery after a forced exit.
- Existing evaluator, autosave, transaction, refactor, and browser tests remain
  green.
- Browser smoke testing verifies the import comment is absent and the right
  dependency pane still reports `Examples.Multi_file -> Examples.Library`.

## Import removal rollout

The repository scan contains no user page that still requires ordered legacy
imports: the only remaining directives are test fixtures and old
documentation. Convert those fixtures to qualified module references, verify
the Dune graph and runtime output, then remove the import parser and
compatibility opens in one change. If a project opened in the future still
contains the directive, it remains an ordinary HTML comment and the unresolved
unqualified OCaml name receives a normal compiler diagnostic.
