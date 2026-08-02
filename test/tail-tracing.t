Tail tracing preserves the native stack even at depth for functions that mix
ordinary calls with a final tail call.

  $ cp -L ../test/tail-stack.fixture tail-stack.ml.md
  $ env -u OCAMLC -u OCAMLRUN dox check tail-stack.ml.md | jq -r '.ok, .status, (.blockOutputs[0].stdout | @json)'
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
