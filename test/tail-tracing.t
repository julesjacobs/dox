Tail tracing preserves the native stack for functions that mix ordinary calls
with a final tail call.

  $ cp -L ../test/tail-stack.fixture tail-stack.ml.md
  $ dox check tail-stack.ml.md | jq -r '.ok, .status, (.blockOutputs[0].stdout | @json)'
  true
  ready
  "100000\n100000\n0\n"

The deployed bytecode evaluator emits real handoffs for exact, tupled, and
overapplied calls. A handed-off occurrence has no ordinary raw outcome, and the
next recursive body enters under the call occurrence.

  $ for kind in exact tupled over; do cp -L ../test/tail-bytecode-$kind.fixture bytecode-$kind.ml.md; dox check bytecode-$kind.ml.md | jq -r '(.tailHandoffs > 0), (.tailLinkedEnters > 0), .tailHandoffOutcomes, (.blockOutputs[0].stdout | @json)'; done
  true
  true
  0
  "0\n"
  true
  true
  0
  "20\n"
  true
  true
  0
  "0\n"

A bytecode `RESTART` partial closure keeps its Dox provenance and remaining
consumption. The large recursive chain hands off instead of accumulating
observation wrappers.

  $ cp -L ../test/tail-bytecode-partial.fixture bytecode-partial.ml.md
  $ dox check bytecode-partial.ml.md | jq -r '(.tailHandoffs > 0), (.tailLinkedEnters > 0), .tailHandoffOutcomes, (.blockOutputs[0].stdout | @json)'
  true
  true
  0
  "100000\n"

Higher-order tail calls retain both the call-site and caller outcomes.

  $ cp -L ../test/tail-events.fixture tail-events.ml.md
  $ dox inspect tail-events.ml.md 2 34 --summary
  function_ value : 'a
  1 of 1 · = 5
    apply
    function_ = <function> : 'a -> 'b
    value = 4 : 'a

  $ dox inspect-call tail-events.ml.md 2 42 --summary | sed -n '1,3p'
  apply 1 of 1
  apply <function> 4 → 5 : 'b
    2:14  function_ ↦ <function> : 'a -> 'b

An uninstrumented tail callee is completed from its real result, not from the
first traced callback that it invokes.

  $ dox inspect tail-events.ml.md 6 36 --summary
  List.map function_ values : 'a list
  1 of 1 · = [2; 3; 4]
    map
    function_ = <function> : 'a -> 'b
    values = [1; 2; 3] : 'a list

A registered function called with too few arguments returns a partial closure;
it does not hand off to a function body that has not entered.

  $ dox inspect tail-events.ml.md 11 22 --summary | sed -n '1,2p'
  add value : int -> int
  1 of 3 · = <function>

Repeated callbacks through that partial application leave later execution at
the top level.

  $ dox inspect tail-events.ml.md 14 33 --summary
  List.length applied : int
  1 of 1 · = 3

Overapplication also takes the observed fallback and preserves its final
result.

  $ dox inspect tail-events.ml.md 18 26 --summary
  over first : int
  1 of 1 · = 5

An exception raised while evaluating the prefix before a tail call closes all
tail callers, so later execution is no longer parented by `explode`.

  $ dox inspect tail-events.ml.md 27 36 --summary
  recovered + 1 : int
  1 of 1 · = 43
