# A small introduction to OCaml

OCaml is an expression-oriented functional language. Its compiler infers most
types, so programs stay concise without giving up static checking.

## Values and functions

`let` gives a value a name. Values are immutable unless a program explicitly
asks for mutation.

    let language = "OCaml"
    let square number = number * number
    let greeting name = "Hello, " ^ name ^ "!"
    let foo = greeting "hi"


The compiler infers that `square` accepts and returns integers. Put the cursor
on its name or body to inspect that type. The same definitions are available to
inline evaluation: `square 9 =`.

Functions compose naturally with the pipeline operator:

    let first_squares =
      List.init 7 Fun.id
      |> List.map square
    let sum = List.fold_left ( + ) 0 first_squares
    let () =
      Doc.value ~id:"square-sum" ~type_:"int" (string_of_int sum)

## Data describes the cases

Variants make the possible forms of a value explicit. Pattern matching then
handles each form.

    type shape =
      | Circle of float
      | Rectangle of float * float
    let area = function
      | Circle radius -> Float.pi *. radius *. radius
      | Rectangle (width, height) -> width *. height

Because every case carries its own data, the compiler knows what is available
inside each branch. The area of a `Rectangle (3., 4.)` is
`area (Rectangle (3., 4.)) =`.
`area (Circle 2.) =`
## Recursion follows the data

Lists are either empty or a head followed by a tail. A recursive function can
mirror that shape directly:

    let rec product = function
      | [] -> 1
      | value :: rest -> value * product rest
    let sample_product = product [ 2; 3; 5 ]
    let () =
      Doc.value ~id:"list-product" ~type_:"int"
        (string_of_int sample_product)

This combination—precise data types, pattern matching, inference, and small
composable functions—is the core vocabulary used by the larger demos.

    let rec fib n =
        if n < 2
        then n
        else fib (n-1) + fib (n-2)
    let f = fib 5

Next: [[Demos.Inference]] uses these same tools to implement a type
inference engine.
