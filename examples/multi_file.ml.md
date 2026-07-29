# A multi-file live view

This document uses the sibling module `Library` (externally
`Examples.Library`). The compiler dependency graph determines the evaluation
and artifact closure.

    let @average =
      Library.mean Library.observations
    
    let () =
      Doc.value ~id:"shared-result" ~type_:"float"
        (Printf.sprintf "%.2f" average)
    
    let main () = Printf.printf "Average: %.2f\n" average
