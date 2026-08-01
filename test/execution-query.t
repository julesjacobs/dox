The expression query returns every dynamic occurrence with its call context
and local environment. Columns are zero-based, matching the editor protocol.

  $ cp -L ../test/query.fixture fixture.ml.md
  $ dox inspect fixture.ml.md 4 26 --summary
  input * 2 : int
  1 of 2 · = 4
    transform
    input = 2 : int
    doubled = 4 : int
  2 of 2 · = 8
    transform
    input = 4 : int
    doubled = 8 : int

Putting the cursor on a callee inspects the completed application rather than
the function value.

  $ dox inspect fixture.ml.md 6 18 --summary
  transform 2 : int
  1 of 1 · = 5

An expression that was not reached is represented explicitly.

  $ dox inspect fixture.ml.md 9 25 --summary
  transform 100 : int
  not executed

Positions outside OCaml expressions fail instead of returning misleading data.

  $ dox inspect fixture.ml.md 1 0 --summary
  No OCaml expression was found at this source position.
  [1]

Function invocation queries expose inline binder positions and the logical
call tree independently of the IDE, including tail-recursive calls.

  $ dox inspect-call fixture.ml.md 12 10 --occurrence 2 --summary
  sum 2 of 3
  sum 1 → 3 : int
    10:16  acc ↦ 1 : int
    12:8  value ↦ 2 : int
    12:17  rest ↦ [] : int list
    13:14  next ↦ 3 : int
  parent  sum → 3
  calls
    sum → 3

The complete call graph is not truncated when the locals replay reaches its
event cap. Later functions remain immediately navigable.

  $ cp -L ../test/late-call.fixture late.ml.md
  $ dox inspect-call late.ml.md 10 8 --summary
  late 1 of 1
  late 20 → 41 : int
    9:13  value ↦ 20 : int
    10:10  doubled ↦ 40 : int

Generated observation markers keep Markdown code blocks as distinct OCaml
phrases, including when a later block begins with a bare expression.

  $ cp -L ../test/block-boundaries.fixture boundaries.ml.md
  $ dox check boundaries.ml.md | jq -r '.ok, .status'
  true
  ready

The debugger then sees ordinary, unannotated calls from that expression.

  $ dox inspect-call boundaries.ml.md 5 11 --summary | sed -n '1,2p'
  fib 1 of 15
  fib 5 → 5 : int
