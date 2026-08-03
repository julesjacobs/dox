# Dox

Write Markdown.
Indent a line to write OCaml.
Click an expression to select an execution that reached it.
Shift-click functions to navigate in and out of calls.

Try it:

    let rec adjust price =
      if price >= 100 then
        price * 80 / 100
      else
        adjust (price + 30)

    let prices =
        List.map
            (fun p -> adjust (p + 1))
            [45; 120; 80; 200]
