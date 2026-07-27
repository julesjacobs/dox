# Observed execution

One `@` opts a value, function, or expression into the execution trace. Select
an occurrence in the context pane to return to the source that produced it.

    let rec @factorial n =
      if n = 0 then 1 else n * @(factorial (n - 1))
    
    let @answer2 = factorial 6

    let () =
      Doc.value ~id:"answer" ~type_:"int" (string_of_int answer2)
