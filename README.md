# Dox

Dox (document OxCaml) is a working vertical slice of a live literate
programming workspace.
Markdown is the document language and OCaml is the inner language.

It requires OCaml 5.1 or newer, Dune 3.15 or newer, Yojson 3, and Merlin 5.

```sh
opam install . --deps-only
```

## Start the workspace

```sh
dune exec dox -- serve
```

Then open <http://127.0.0.1:8080>.

The small switch at the bottom of the module outline chooses where OxCaml code
runs. **Browser** compiles, links, and executes the project in a Web Worker;
the server only supplies the project snapshot and normalizes the resulting Dox
trace. **Server** keeps the existing local compiler path. The choice is saved
for the browser.

The server uses the current directory as the project root and finds every file
ending in `.ml.md`. Use another project directory or port with:

```sh
dune exec dox -- serve --root /path/to/project --port 9000
```

This checkout uses the project-local OxCaml compiler in
`_toolchain/oxcaml/bin/ocamlc` for evaluation and artifacts. Its source is in
`vendor/oxcaml`; the browser integration is maintained on the
`jujacobs/dox-browser-integration` branch. `OCAMLC` can override it.
`ocamlmerlin` provides types at the cursor and can be overridden with
`OCAMLMERLIN`.

## Literate source

Executable OCaml can use ordinary four-space Markdown code blocks. In the
rendered editor, press Tab on a line to create one and Shift-Tab to return it to
prose. Enter always continues the OCaml block, including on blank lines.
At the end of the document, Down moves out of the final code block and creates
a prose line when there is no lower line. Shift-Enter performs the same
structural exit anywhere in a code block. No language or block name is required.
All executable blocks in one document join one OCaml compilation unit in
document order.

```markdown
# A live document

    let answer = 6 * 7
    let () = Doc.value ~id:"answer" ~type_:"int" (string_of_int answer)
```

Legacy named fences remain supported so existing documents continue to open:

````markdown
```ocaml name=model
let answer = 6 * 7
```

```ocaml name=answer
let () = Doc.value ~id:"answer" ~type_:"int" (string_of_int answer)
```
````

The optional `name=` attribute is preserved as runtime identity metadata, but
new documents do not need it.

`ocaml-example` blocks are shown in the document but are not executed:

````markdown
```ocaml-example
let this_is_only_an_example = true
```
````

Every page is an OCaml module derived from its path. Cross-page dependencies use
ordinary qualified OCaml references:

```ocaml
let average =
  Examples.Library.mean Examples.Library.observations
```

Dune and the compiler-derived dependency graph determine build order,
incremental rebuilds, cycles, and the transitive evaluation closure.

The module outline is manually ordered. `Option–Up` and `Option–Down`
(`Alt–Up` and `Alt–Down` elsewhere) move the current page and its descendants
among siblings; ordinary outline text edits can reorder several pages at once.
`Tab`/`Shift–Tab` and `Option–Right`/`Option–Left` move a subtree into or out
of a sibling. A drag grip appears only near the outline’s left edge; dropping
above, below, or on a row previews and applies the corresponding tree move.
The order is stored as module paths in the Git-tracked `.dox-order` file and
does not affect OCaml module identity.

## Observed execution

Ordinary evaluation records every Dox function invocation and boxed expression,
including its exact source span, type, result or exception, and dynamic parent.
Library implementations remain opaque. A callback from a library into Dox code
re-enters the record beneath the user call that triggered it.

The record is always present; there is no separate debugger mode and inspecting
it never runs the program again. The cursor selects one expression occurrence
inside one coherent function activation. Reached expressions receive a soft
highlight, the exact selected expression receives a stronger highlight, and
code no execution reached is subdued.

Each source line has at most one compact value annotation in a fixed lane.
Structural values such as bindings, function inputs, returns, and writes remain
visible; the value of the expression under the cursor temporarily replaces the
annotation on that line. The right pane lists every dynamic occurrence of the
selected expression. Each occurrence has one activation line and one exact
value line, so repeated evaluation inside a single activation remains visible.
Call links enter the actual callee activation and the function definition links
back to its dynamic caller.

Values are rendered immediately at each event. Mutable refs and arrays therefore
show the contents they had when observed, but Dox does not reconstruct a complete
historical heap or library-internal mutations.

The full syntax and execution model are in
[`docs/trace-design.md`](docs/trace-design.md).

The inner language receives this small view API:

```ocaml
Doc.html ~id html
Doc.text ~id text
Doc.value ~id ~type_ rendered_value
Doc.status ~id text
Doc.link ~id ~label url
Doc.trace ~id event
```

`Doc.html` is rendered in a sandboxed frame. It may use HTML and CSS, but it
cannot read or mutate the workspace.

## Commands

Type-check and evaluate one document:

```sh
dune exec dox -- check welcome.ml.md
```

Query the canonical normalized execution artifact and run the exhaustive
interaction self-check:

```sh
npm run audit:execution -- demos/inference.ml.md --check
```

The self-check walks every UTF-16 cursor boundary in isolation and in forward
and reverse sweeps. It also tries every valid activation choice, occurrence and
activation navigation target, projection partition, coverage owner, annotation
lane, and an edit/recovery round trip. Failures are grouped by invariant and
include a source line and caret. The command exits nonzero on any failure.

Render the compact cursor and highlight atlas for a source range:

```sh
npm run audit:execution -- demos/inference.ml.md --atlas --lines 80:105
```

`Q` assigns one short identity to the complete cursor focus. `H` shows active,
inactive, never-run, or uncovered source. Add `--at LINE:COLUMN` to hold one
activation fixed and see its exact highlight stencil over the requested lines.

Audit only what the IDE visibly renders at every cursor boundary:

```sh
npm run audit:execution -- demos/inference.ml.md --ux-matrix --lines 30:44
```

`C`, `H`, and `R` assign short IDs to the value column, source highlighting,
and right pane. Their dictionaries show the exact visible values, `S/G/E`
source bands, calls, and selected expression values. Every mapping row has
source-length + 1 IDs, including the final cursor position. The lower-level
seven-plane diagnostic remains available as `--matrix`.

Write the readable visual audit to a file:

```sh
npm run audit:execution -- demos/inference.ml.md --visual -o inference.audit.txt
```

Without `-o`, `foo.ml.md` produces `foo.audit.txt`. The report first places one
`V` view ID at each of the line's `n+1` cursor boundaries. It then renders each
view as the actual source with value annotations, followed immediately by its
aligned selection/greying band and a separate cursor-boundary row. The source
therefore never shifts. `--lines FROM:TO` limits which cursor lines receive
overviews and view frames; each frame still includes every source line whose
visible state changes.

The upper-right view control cycles through Document, Source, and Debug. The raw
C/H/R matrix remains available for exact machine comparisons while the visual
report is the readable file representation.

Inspect the exact selection, values, and activation projection at a one-based
line and zero-based UTF-16 column:

```sh
npm run audit:execution -- demos/tracing.ml.md --at 15:20
```

Add `--activation ID` to choose a reaching activation, or `--json` for the
complete machine-readable artifact, view model, and self-check witnesses.
Reducer scripts can be
replayed from a JSON array or JSON Lines file with
`npm run audit:execution:reducer -- FILE --script INTENTS.jsonl`.

Compile a `unit -> unit` entry value:

```sh
dune exec dox -- artifact welcome.ml.md main _artifacts/welcome
```

The command records a manifest with the source document and exact project
version.

Format and test the implementation with:

```sh
dune fmt
dune build
dune runtest
npm run check:web
```

The browser uses one locally bundled CodeMirror 6 editor for the complete
Markdown and OCaml document. The generated bundle is included. After changing
`web/editor-source.js`, run `npm install` once and `npm run build:web`.

The generated browser OxCaml compiler is also included. After changing the
browser compiler bridge or its vendor branch, install `vendor/oxcaml` and run:

```sh
scripts/build-browser-oxcaml.sh
```

## Implemented model

- One immutable project snapshot stamps every document, evaluation, change set,
  and artifact operation.
- Code regions share ordinary OCaml compilation semantics.
- Draft evaluation is explicit, bounded to five seconds, and does not happen as
  a side effect of reading a document.
- A 16-worker request ceiling, socket deadlines, and evaluation time limits
  keep a stuck program from freezing ordinary workspace requests.
- Active API requests require a same-origin local session credential. Starting
  the server is the workspace-trust decision.
- Source edits compare both the document and project versions.
- Saves use a project lock, atomic source replacement, content-addressed source
  objects, and recoverable transaction intents.
- Every saved edit creates an exact reconstructable change set in
  `.dox/changes.jsonl`.
- Directly edited definitions and transitively affected definitions are stored
  separately.
- Change sets contain exact line diffs, changed document regions, validation
  results, and before/after source objects.
- OCaml diagnostics retain structured literate document locations.
- Merlin provides compiler-resolved types for the OCaml token under the cursor.
- Runtime views appear beneath the document with their source identity retained
  as accessible metadata.
- Runtime events use a dedicated channel, so ordinary stdout is preserved.
- Artifact bundles are immutable and connect generated executables to exact
  document and project versions.

With the Server engine, OCaml code is trusted and runs with the permissions of
the local user. The evaluation supervisor provides time and output bounds; it
is not an OS security sandbox. Code that deliberately creates a detached
process can outlive an evaluation. The Browser engine runs in a disposable Web
Worker and is cancelled by terminating that worker, but it is not presented as
a security boundary for untrusted source.

Managed long-running services, replay debugging, multi-user permissions, and
an external agent protocol remain future work.

The complete design is saved in
[`docs/high-level-design.md`](docs/high-level-design.md).
The concrete implementation model is in
[`docs/implementation-design.md`](docs/implementation-design.md).
The staged Git-backed wiki and named-module work is in
[`docs/wiki-workspace-implementation-plan.md`](docs/wiki-workspace-implementation-plan.md).
