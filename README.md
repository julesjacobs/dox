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

The server uses the current directory as the project root and finds every file
ending in `.ml.md`. Use another project directory or port with:

```sh
dune exec dox -- serve --root /path/to/project --port 9000
```

This checkout uses the project-local OxCaml compiler in
`_toolchain/oxcaml/bin/ocamlc` for evaluation and artifacts. Its source is
pinned in `vendor/oxcaml` at revision
`991902cc59b71ce4ad77c522f5feac89b1e31e52`. `OCAMLC` can override it.
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
The order is stored as module paths in the Git-tracked `.dox-order` file and
does not affect OCaml module identity.

## Observed execution

A single `@` opts a value, function, or expression into the execution trace:

```ocaml
let rec @fib n =
  if n < 2 then n else @(fib (n - 1)) + fib (n - 2)

let @answer = fib 5
```

`let @value` records one binding evaluation. `let @function arguments` records
every call. `@(expression)` records the expression result or exception. The
context pane shows the resulting dynamic call tree, inferred types, and bounded
value previews. Selecting an occurrence moves the editor to its exact source
span. Infix `left @ right` remains ordinary list append.

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

Compile a `unit -> unit` entry value:

```sh
dune exec dox -- artifact welcome.ml.md main _artifacts/welcome
```

The workspace Build control performs the same operation and records a manifest
with the source document and exact project version.

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

OCaml code is trusted and runs with the permissions of the local user. The
evaluation supervisor provides time and output bounds; it is not an OS security
sandbox. Code that deliberately creates a detached process can outlive an
evaluation.

Managed long-running services, replay debugging, multi-user permissions, and
an external agent protocol remain future work.

The complete design is saved in
[`docs/high-level-design.md`](docs/high-level-design.md).
The concrete implementation model is in
[`docs/implementation-design.md`](docs/implementation-design.md).
The staged Git-backed wiki and named-module work is in
[`docs/wiki-workspace-implementation-plan.md`](docs/wiki-workspace-implementation-plan.md).
