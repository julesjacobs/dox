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

One `@` on a function records each call and its parameters. One `@` on a
binding records its value inside the active call.

    let rec @search needle = function
      | Empty -> false
      | Node (left, value, right) ->
          let @comparison = Int.compare needle value in
          if comparison = 0 then true
          else if comparison < 0 then search needle left
          else search needle right
    let @found = search 13 tree
    let @missing = search 16 tree
    let () =
      Doc.value ~id:"found-result" ~type_:"bool"
        (string_of_bool found)
    let () =
      Doc.value ~id:"missing-result" ~type_:"bool"
        (string_of_bool missing)

The context pane now contains two roots. Expand the call to `search 13` and
select successive calls to follow the path `8 → 12 → 14 → 13`. Each selected
call shows its `needle` parameter and its local `comparison`.

Hover a call to highlight all of its descendants. Hover an `@` in the source to
highlight every trace element produced by that observation site.
