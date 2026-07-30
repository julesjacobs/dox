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
- `Tab` and `Shift–Tab` change nesting.
- `Option–Up` and `Option–Down` (`Alt` elsewhere) move a page and its
  descendants among siblings.
- `Escape` cancels an edit.

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

## Evaluation and tracing

OCaml evaluates from front to back. When code changes, its previous result and
all later results fade immediately while the new run replaces them.

- `let @value = expression` records a binding.
- `let @function arguments = expression` records every function call.
- `@(expression)` records one expression.

The context pane groups calls into a compact execution tree. Select an
occurrence to see its parameters and observed values, or click it to return to
the exact source span. [[Demos.Tracing]] is the smallest complete example.

## Workspace

Git provides history and collaboration; Dox does not add a second history
model. Drag the vertical dividers to resize panes. Their positions survive a
refresh. Double-click a divider to reset it, or focus it and use `Left` and
`Right` to resize from the keyboard.
