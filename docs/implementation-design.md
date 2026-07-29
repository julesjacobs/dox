# Dox implementation design

This document fixes the concrete model used by the current implementation. The
high-level design remains the product specification. These choices are intended
to keep the implementation coherent while larger features are added.

## 1. Durable source

A live document is a UTF-8 file ending in `.ml.md`.

- Markdown is durable prose.
- Fenced `ocaml` regions are executable.
- Fenced `ocaml-example` regions are display-only.
- Executable regions in one document are concatenated into one ordinary OCaml
  compilation unit.
- `#line` directives map compiler locations back to the literate source.
- A `name=` attribute is the stable identity of a source-backed code region.
  Names must be unique inside a document.
- A page path determines its qualified OCaml module path. Ordinary module
  references determine dependencies; no document-level import syntax is
  required.

The exact text file remains canonical. Rendered HTML and runtime output are
projections, never replacement source formats.

## 2. Project snapshots

Every request that observes several files first creates one immutable project
snapshot. A snapshot contains:

- the path, source, parsed structure, and content version of every live
  document;
- a project version derived from ordered `(path, document version)` pairs;
- the capture time.

An evaluation records both its draft document version and the project version
against which it ran. A save compares both the original document version and
the original project version. The client applies an asynchronous result only
when its path, draft source, edit generation, and project version still match.

This prevents a result from one file or project version from appearing under
another.

## 3. Evaluation lifecycle

Reading a document does not execute it. Draft evaluation is an explicit active
request.

Each compiler or runtime process:

- runs in its own process group;
- has a wall-clock deadline;
- has a combined output limit;
- has its process group killed and reaped on timeout or excessive output;
- writes structured `Doc` events to a dedicated file;
- leaves ordinary stdout and stderr unchanged.

The local HTTP server uses at most 16 separate request workers, applies socket
deadlines, and returns an overload response when the ceiling is reached. A slow
evaluation therefore does not block health checks or ordinary source reads.

An evaluation contains a unique ID, status, document version, project version,
compiler identity, start time, duration, structured diagnostics, inferred
bindings, runtime views, stdout, and stderr.

The supervisor is an availability aid, not an OS containment boundary. Code can
create a detached process that escapes the evaluation process group. Opening
the workspace means trusting its OCaml source.

## 4. Runtime views

The inner `Doc` module emits typed presentation events:

- `html`
- `text`
- `value`
- `status`
- `link`
- `trace`

Each event has a sequence number and a source-facing identity. The workspace
matches that identity to a named block. HTML output is placed in a sandboxed
frame without workspace origin privileges.

Long-running services are not represented as ordinary evaluation events.
Future service support must have explicit runtime instance IDs, ownership,
health, update, and stop operations tied to a project version.

## 5. Save transactions and change sets

Project mutations are serialized with a project lock.

A save performs these steps:

1. recover any incomplete prior transaction;
2. capture and compare the current project snapshot;
3. validate the draft;
4. store immutable before and after source objects;
5. write a transaction intent;
6. atomically replace the source through a sibling temporary file;
7. atomically append the change journal;
8. remove the transaction intent.

If the journal commit fails, the source is rolled back. If the process stops
after source replacement, the intent allows the journal commit to be recovered.

A change set stores:

- parent and resulting project versions;
- before and after document versions and source objects;
- the authenticated local principal;
- changed source-backed regions;
- directly edited definitions;
- transitively affected definitions;
- exact line changes;
- validation status and diagnostics.

Direct edits and inferred impact are different fields. Current semantic
dependency analysis is lexical and conservative. Compiler-resolved entity
graphs should replace it before cross-document impact is claimed.

## 6. Artifact production

An artifact entry must resolve to a value with type `unit -> unit`.

Artifact production compares the expected project and document versions,
validates the document, builds in a staging directory, and publishes an
immutable bundle. Its manifest records:

- artifact ID and content digest;
- entry value;
- source document;
- document and project versions;
- compiler identity;
- principal and creation time;
- generated source, executable, and build log.

Top-level OCaml effects currently remain part of artifact startup. A future
effect model should make that boundary explicit.

## 7. Local API boundary

The server binds only to loopback. Starting it is the explicit trust decision
for the selected project.

- Read-only routes never execute code.
- Active routes require `application/json`.
- Active routes require an unguessable session credential.
- Host and Origin must identify the same loopback workspace.
- Request lines, headers, and bodies have size limits.
- Document routes accept only registered `.ml.md` regular files.
- Canonical paths must remain inside the project or asset root.
- Directory scans do not follow symbolic links.

The session credential prevents drive-by browser requests. It does not attempt
to isolate other local processes running as the same operating-system user.

## 8. Workspace projections

The web workspace presents four coordinated levels:

- Document: rendered prose, code, and live views.
- Source: exact durable text.
- Changes: changed regions, direct edits, inferred impact, validation, and
  exact line evidence.
- Project: documents, entities, artifacts, and version.

The contextual pane uses the same canonical document projection returned by
the server. The browser does not implement a second language parser.

Unsaved navigation requires confirmation. Evaluation requests are cancelled
and version-checked on navigation. Rendered editing has explicit Apply and
Cancel actions and is keyboard accessible.

## 9. Next architectural steps

The next large steps should be done in this order:

1. Use OCaml compiler structures for entity IDs, definitions, resolved
   references, signatures, and diagnostics.
2. Extend the Dune-backed page module graph with compiler entity identities,
   definitions, and resolved occurrences.
3. Add retained last-good evaluations and cancellable draft jobs.
4. Add rendered before/after document projections to stored change sets.
5. Add managed services with explicit lifecycle and capability policies.
6. Add causal traces, replay, and debugger controls.
7. Expose selection, entity, snapshot, change, and operation APIs to agents.
8. Add OS-level worker isolation for untrusted projects.
