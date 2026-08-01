# Reading an execution trace

Static types explain what a program may do. A trace explains what this
particular execution did.

This page builds a balanced search tree, then observes two searches. The tree
construction is ordinary OCaml so the trace stays focused on the interesting
operation.

    type tree =
      | Empty
      | Node of tree * int * tree
    let rec insert value = function
      | Empty -> Node (Empty, value, Empty)
      | Node (left, current, right) as tree ->
          if value = current then tree
          else if value < current then
            Node (insert value left, current, right)
          else
            Node (left, current, insert value right)
    let tree =
      List.fold_left
        (fun tree value -> insert value tree)
        Empty
        [ 8; 4; 12; 2; 6; 10; 14; 1; 3; 5; 7; 9; 11; 13; 15 ]

Normal evaluation records every call, parameter, binding, and expression in
this page.

    let rec search needle = function
      | Empty -> false
      | Node (left, value, right) ->
          let comparison = Int.compare needle value in
          if comparison = 0 then true
          else if comparison < 0 then search needle left
          else search needle right
    let found = search 13 tree
    let missing = search 16 tree
    let () =
      Doc.value ~id:"found-result" ~type_:"bool"
        (string_of_bool found)
    let () =
      Doc.value ~id:"missing-result" ~type_:"bool"
        (string_of_bool missing)

Place the cursor in `search`, then Shift-click the recursive call to follow the
path `8 → 12 → 14 → 13`; Shift-click the function name to return to
its caller. Parameters, pattern values, and `comparison` change with the
selected invocation. The exact expressions reached by that invocation receive
a soft highlight. Code absent from the complete execution is subdued; code
reached by a different invocation keeps its normal contrast.

Move the text cursor to focus an execution that reached that construct and to
highlight all matching occurrences on the timeline.
