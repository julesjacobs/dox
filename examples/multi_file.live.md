<!-- doclang: imports=examples/library.live.md -->

# A multi-file live view

This document imports the OCaml program from `examples/library.live.md`.
Evaluation and artifacts use the ordered dependency closure from one project
snapshot.

    let @average = mean observations
    
    let () =
      Doc.value ~id:"shared-result" ~type_:"float"
        (Printf.sprintf "%.2f" average)
    
    let main () = Printf.printf "Average: %.2f\n" average
