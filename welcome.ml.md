# Welcome to Dox

Dox is a live document where Markdown and OCaml share one source file. Read it
like a page, edit it like Markdown, and move into any indented region to work
with real OCaml.

The page is already running. Inline expressions can answer small questions
without turning the prose into a notebook cell: `6 * 7 =`.

## One document, one program

Definitions stay in scope across the whole page. This block defines a small
function:

    let describe name count =
      Printf.sprintf "%s has %d live example%s" name count
        (if count = 1 then "" else "s")

Prose can continue between code regions. A later block uses the earlier
definition and places its output directly below the code:

    let message = describe "Dox" 3
    let () = Doc.text ~id:"welcome-message" message
    let main () = print_endline message

Put the cursor on `message` to see its inferred type in the context pane.
Change the number above and the result updates immediately.

## Take the tour

- [[Learn.Ocaml]] introduces the OCaml ideas used throughout the workspace.
- [[Demos.Inference]] implements type inference and exposes its execution.
- [[Demos.Tracing]] makes recursive calls and observed values easy to explore.
- [[Demos.Visualization]] turns an OCaml computation into a live SVG.
- [[Project.Analysis]] uses typed data defined on another page.
- [[Guide]] is the compact interaction and keybinding reference.

Everything here is an ordinary `.ml.md` file in Git. The module names in the
left pane are also the names OCaml code uses.
