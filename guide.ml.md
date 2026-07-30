# Dox guide

Dox (document OxCaml) is a live Markdown workspace with OCaml embedded directly in each page. Pages are also OCaml modules: the page path shown in the module outline is the module path used by other pages.

## Writing

Write Markdown directly in the document. Headings, lists, links, and inline code keep their familiar Markdown source while the document view presents them lightly.

Indent a line to start an OCaml block. Definitions remain available to later blocks and to pages that depend on this module. Results and errors appear below the code that produced them.

Write an inline OCaml expression followed by an equals sign to see its value, for example `1 + 2 =`. The result is displayed by the editor and is not inserted into the file.

Use `Source` in the upper-right corner to switch the same editor to raw Markdown. The cursor, selection, undo history, and scroll position are preserved when switching modes.

## Pages and modules

The left pane is the module outline. Typing changes only the stable draft; it never renames files between keystrokes. A valid draft is committed when you finish the interaction.

- Press `Enter` after editing a module to commit the change and open its page.
- Press `Enter` on an unchanged module to create a sibling.
- Move to another module with the arrow keys or click it to commit the current draft and open that page.
- Leaving the module outline commits a valid draft without changing pages.
- Press `Tab` or `Shift–Tab` while editing to change nesting.
- Press `Escape` to cancel an edit.

Module components begin with a capital letter because they are OCaml module names. Moving or renaming a module updates references across the workspace.

## Code intelligence

Place the cursor on an OCaml expression to see its inferred type in the context pane.

- Press `F12` to go to the definition under the cursor.
- Press `Option–F12` to peek at the definition without leaving the page.
- `Command-click` on macOS or `Control-click` elsewhere to go to a definition.
- Use `Up` and `Down` to select a completion, `Tab` or `Enter` to insert it, and `Escape` to close completion.

The definition preview shows the source page, source line, and a compact excerpt. Click the preview to open the definition.

## Evaluation and tracing

OCaml runs from front to back across code blocks. When a block changes, its old result and all later results fade immediately while the new evaluation runs.

Prefix a variable or function with `@` to observe its value. Use `@(expression)` to observe a whole expression. Function observations form a compact call trace in the context pane. Click a trace entry to jump to the source and inspect that call.

Errors appear beneath their code block and as red underlines in the editor. Hover an underline to read the compiler message.

## Workspace

Pages autosave to Markdown files. The workspace is Git-backed, so normal Git tools provide history, comparison, and collaboration.

Drag either vertical divider to resize a pane. The sizes are restored after a refresh. Double-click a divider to reset it; when it has keyboard focus, use `Left` and `Right` to resize in small steps or hold `Shift` for larger steps.
