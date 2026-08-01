# Dox guide

Dox combines a Markdown document, an OCaml compilation unit, and live compiler
context. Pages autosave as `.ml.md` files and their module paths are the names
shown in the left pane.

## Writing

- Write Markdown directly in the document.
- Press `Tab` on a line to make it executable OCaml.
- Press `Shift–Tab` to return a code line to prose.
- Definitions remain live across every code block on the page.
- Use an inline expression ending in `=` to show its value, as in `1 + 2 =`.
- Use `Source` in the upper-right to edit the raw Markdown without changing
  cursor, selection, undo history, or scroll position.

At the end of a code block, `Down` creates prose below it when no following line
exists. `Shift–Enter` exits a code block anywhere.

## Pages and links

The left pane is an editable module outline.

- `Enter` commits an edited module name and opens it.
- `Enter` on an unchanged module creates a sibling.
- `Tab` or `Option–Right` moves a page into the preceding sibling.
- `Shift–Tab` or `Option–Left` moves it back out after its parent.
- `Option–Up` and `Option–Down` (`Alt` elsewhere) move a page and its
  descendants among siblings.
- `Escape` cancels an edit.

Move the pointer to the far-left edge of a page row to reveal its drag grip.
Drop above or below a row to reorder siblings. Drop on the middle of a row to
make the page its first child. The insertion line previews the exact result.

Module components begin with a capital letter because they are OCaml module
names. Moving or renaming a module updates code references and wiki links.
Write a page link as `[[Project.Analysis]]`; use `Command–Enter` or
`Control–Enter` while the cursor is inside it to navigate.

The visible order is stored in `.dox-order`, a plain list of module paths that
can be reviewed and merged with the rest of the Git-backed workspace.

## Compiler context

Place the cursor on OCaml code to see its inferred type.

- `F12` goes to the definition under the cursor.
- `Option–F12` peeks at the definition in the context pane.
- `Command-click` on macOS or `Control-click` elsewhere goes to a definition.
- Completion appears as you type. Use `Up` and `Down` to select, `Tab` or
  `Enter` to insert, and `Escape` to close it.

Errors appear below their code block and as red underlines. Hover an underline
to read the compiler message.

## Evaluation

OCaml evaluates from front to back. When code changes, its previous result and
all later results fade immediately while the new run replaces them.

The same evaluation also records the execution trace. There is no second
debugger run.

## Observed execution

The execution record is always present. Evaluation, the timeline, inline
values, and the execution list all show the same immutable record; inspecting
it never runs the program again.

- Parameters, pattern variables, and local bindings reveal their runtime values
  directly after their names.
- Program highlights the top-level OCaml that ran.
- A selected invocation softly highlights the exact expressions it executed.
  Code that no execution reached is subdued; code reached by another invocation
  keeps its normal contrast.
- Calls made by the invocation show their arguments and result. Click one to
  move down the call tree.
- The function name shows the caller's result when a caller exists.
  Click it to move back up the call tree.
- Move the timeline to another event, or click a linked caller or callee to
  focus that invocation.
- Moving the text cursor focuses an execution that reached that construct and
  marks every matching occurrence on the timeline.

The trace is tied to the exact evaluated program. Editing executable OCaml
marks it as stale until the replacement evaluation arrives. Prose-only edits do
not rerun the program.

## Workspace

Git provides history and collaboration; Dox does not add a second history
model. Drag the vertical dividers to resize panes. Their positions survive a
refresh. Double-click a divider to reset it, or focus it and use `Left` and
`Right` to resize from the keyboard.
