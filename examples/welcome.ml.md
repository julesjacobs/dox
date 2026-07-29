# A small live OCaml notebook

This page is one source file and several coordinated views. The prose is
Markdown. Four-space-indented lines are executable OCaml. The entire page is
one continuous editor.

## A model split across the document

This first region defines data. Move the cursor across it to inspect
compiler-resolved OCaml types.

    let samples = [ 2; 3; 5; 7; 11 ]

The next definition uses the earlier one through normal OCaml scope. There is
no notebook cell order or hidden per-cell environment.

    let doubled = List.map (fun value -> value * 2) samples

## A program-constructed view

The view below is emitted by OCaml. Its identity gives the workspace a stable
source/runtime link.

    let bars =
      doubled
      |> List.map (fun value ->
             Printf.sprintf
               "<span style='display:inline-grid;place-items:end center;width:52px;height:%dpx;background:#dcece3;border-bottom:3px solid #135f4b;border-radius:5px 5px 0 0;color:#135f4b;font:600 11px system-ui;padding-bottom:4px'>%d</span>"
               (38 + (value * 3)) value)
      |> String.concat " "
    
    let () =
      Doc.html ~id:"live-demo"
        ("<div style='display:flex;align-items:end;gap:7px;min-height:120px'>" ^ bars
       ^ "</div>")

## Values and ordinary output

View output travels through the structured `Doc` interface. Ordinary OCaml
standard output remains ordinary output and is captured separately from
structured views.

    let sum = List.fold_left ( + ) 0 doubled
    let () = Doc.value ~id:"summary" ~type_:"int" (string_of_int sum)
    let () = Printf.printf "Evaluated %d transformed samples.\n" (List.length doubled)

The workspace can also compile a designated entry into a standalone artifact.
Choose `main` in the Build section of the contextual pane.

    let main () =
      Printf.printf "The generated program computed %d.\n" sum

Inline code such as `let deployment_target = "documentation"` stays prose and
does not join the program.
