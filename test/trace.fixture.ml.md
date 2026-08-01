    let rec fib n =
      if n < 2 then
        n
      else
        fib (n - 1) + fib (n - 2)
    let answer = fib 5
    let incremented = List.map (fun value -> value + 1) [1; 2]
    let cell = ref 1
    let before = !cell
    let () = cell := 2
    let after = !cell
    let values = [| 1; 2; 3 |]
