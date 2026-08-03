The canonical CLI validates a real compiler artifact before rendering it.
Dynamic IDs are hidden here; entity counts and invariant results are stable.

  $ cp -L ../test/trace.fixture trace.ml.md
  $ DOX_BIN=dox node ../scripts/audit-execution.mjs trace.ml.md --check | sed -E 's/[0-9a-f]{24,}/<id>/g'
  evaluation <id>  code <id>
  constructs 61  selectors 96  occurrences 213  activations 18  closures 2  calls 58  writes 1
  terminal complete
  invariants ok
  self-check ok
  checked boundaries=302 selector-states=81 activation-choices=359 occurrence-navigation=197 activation-navigation=17 projections=18 sweeps=604 edit-recovery=3

The matrix command runs every UTF-16 cursor boundary through the same reducer
and fails if selection, activation projection, or global coverage disagree.

  $ DOX_BIN=dox node ../scripts/audit-execution.mjs trace.ml.md --matrix | sed -n '1,3p' | sed -E 's/[0-9a-f]{24,}/<id>/g'
  matrix <id> code <id>
  baseline selection -  recency empty
  self-check ok

Every shipped document is part of the execution contract.

  $ DOX_BIN=dox node ../scripts/check-execution-corpus.mjs
  demos.ml.md: ok
  demos/inference.ml.md: ok
  demos/tracing.ml.md: ok
  demos/visualization.ml.md: ok
  fib.ml.md: ok
  guide.ml.md: ok
  learn.ml.md: ok
  learn/ocaml.ml.md: ok
  project.ml.md: ok
  project/analysis.ml.md: ok
  project/dataset.ml.md: ok
  welcome.ml.md: ok

Representative semantic anchors are golden-tested in addition to the internal
consistency checks. Branch keywords select executions of their own branch, a
line-end boundary selects the completed branch expression, and leading
indentation has no invented selection.

  $ cp -L ../fib.ml.md fib.ml.md
  $ cp -L ../demos/inference.ml.md inference.ml.md
  $ cp -L ../demos/tracing.ml.md tracing.ml.md
  $ cp -L ../welcome.ml.md welcome.ml.md
  $ mkdir -p learn
  $ cp -L ../learn/ocaml.ml.md learn/ocaml.ml.md
  $ mkdir -p project
  $ cp -L ../project.ml.md project.ml.md
  $ cp -L ../project/analysis.ml.md project/analysis.ml.md
  $ cp -L ../project/dataset.ml.md project/dataset.ml.md
  $ for position in 7:6 8:6 8:32; do DOX_BIN=dox node ../scripts/audit-execution.mjs fib.ml.md --at "$position" | sed -E 's/[0-9a-f]{24,}/<id>/g' | sed -n '2p;4p;5p;6p'; done
  7:6  selector q then -> construct h  reached
  selected a0  <id>-expression-00000001  occurrence 43
  values 0  -
  active 7  inactive 11  global-unreached 4
  8:6  selector s else -> construct k  reached
  selected a0  <id>-expression-00000001  occurrence 10
  values 0  -
  active 17  inactive 1  global-unreached 4
  8:32  selector w construct -> construct k  reached
  selected a0  <id>-expression-00000001  occurrence 10
  values 1  8 : int
  active 17  inactive 1  global-unreached 4

The UX matrix contains exactly one visible-state ID per UTF-16 cursor boundary.
Its dictionaries expose only the annotation column, source bands, and right
pane. At the final position of a match arm, the right pane owns the completed
arm expression rather than the enclosing function.

  $ DOX_BIN=dox node ../scripts/audit-execution.mjs inference.ml.md --ux-matrix --lines 31 --json | jq -r '.uxMatrix.lines[0] | "source=\(.source | length) boundaries=\(.boundaries | length)"'
  source=29 boundaries=30
  $ DOX_BIN=dox node ../scripts/audit-execution.mjs inference.ml.md --ux-matrix --lines 31 --json | jq -r '.uxMatrix as $matrix | $matrix.lines[0].boundaries[-1].rightPaneId as $id | $matrix.tables.rightPanes[] | select(.id == $id) | "expression=\(.state.expression) rows=\(.state.count)"'
  expression=name rows=11
  $ DOX_BIN=dox node ../scripts/audit-execution.mjs inference.ml.md --ux-matrix --lines 31 --json | jq -r '.uxMatrix.tables | keys | join(",")'
  columns,highlights,rightPanes

The readable audit is written to a file. Its overview has one combined view ID
for every cursor boundary, and its frames intersperse source, highlight, and
cursor rows without inserting the cursor into source text.

  $ DOX_BIN=dox node ../scripts/audit-execution.mjs fib.ml.md --visual --lines 8 -o fib.audit.txt
  wrote fib.audit.txt
  $ sed -n '1,6p' fib.audit.txt
  visual audit fib.ml.md
  lines 8:8

  overview
  8 |       else fib (n-1) + fib (n-2)·
  V | 0000001111122223456327788889abc97
  $ grep '^view 8:' fib.audit.txt | head -1
  view 8:0  cursor 8:0–5
  $ grep 'cursor 0' fib.audit.txt | head -1
    | ▲▲▲▲▲▲                            cursor 0–5
  $ grep '^view 8:' fib.audit.txt | sed 's/  cursor 8:/ /'
  view 8:0 0–5
  view 8:1 6–10
  view 8:2 11–14, 20
  view 8:3 15, 19
  view 8:4 16
  view 8:5 17
  view 8:6 18
  view 8:7 21–22, 32
  view 8:8 23–26
  view 8:9 27, 31
  view 8:a 28
  view 8:b 29
  view 8:c 30

Function headers retain activation context at the end of the line. Completed
parenthesized callbacks retain their value instead of collapsing to the
zero-width activation context.

  $ for location in fib.ml.md:5:20 demos/visualization.ml.md:9:21 demos/tracing.ml.md:23:45 project/analysis.ml.md:23:36; do file=${location%:*:*}; position=${location#*:}; DOX_BIN=dox node ../scripts/audit-execution.mjs "$file" --at "$position" | sed -n '2p;5p' | awk 'NR == 1 { print $2, $4, $8 } NR == 2 { print }'; done
  selector function-context reached
  values 0  -
  selector function-context reached
  values 0  -
  selector construct reached
  values 1  Node (Empty, 8, Empty) : tree
  selector construct reached
  values 1  4.8 : float

A multiline call keeps its promoted call view at the end of the callee line;
it never demotes to the bare function value.

  $ for location in demos/tracing.ml.md:22:20 project/analysis.ml.md:21:20; do file=${location%:*:*}; position=${location#*:}; DOX_BIN=dox node ../scripts/audit-execution.mjs "$file" --at "$position" | sed -n '2p;5p' | awk 'NR == 1 { print $2, $4, $8 } NR == 2 { print $1, $2 }'; done
  selector callee reached
  values 1
  selector callee reached
  values 1

The surface between a callback parameter and its arrow remains owned by the
parsed parameter pattern. Type constraints and delimiters cannot accidentally
expose the callback's return value.

  $ for position in 19:28 19:29 19:30 19:31; do DOX_BIN=dox node ../scripts/audit-execution.mjs demos/visualization.ml.md --at "$position" | sed -n '2p;5p' | awk 'NR == 1 { print $2, $4, $8 } NR == 2 { print }'; done
  selector construct reached
  values 1  (210., 138.927311661) : float * float

The bridge never overrides a concrete later binder or a compiler-emitted case
arrow. The boundary after a visible pattern token retains that exact token's
selector, including overloaded function-name binder ranges.

  $ for location in demos/tracing.ml.md:23:18 demos/tracing.ml.md:23:22 learn/ocaml.ml.md:39:21 demos/inference.ml.md:30:31; do file=${location%:*:*}; position=${location#*:}; DOX_BIN=dox node ../scripts/audit-execution.mjs "$file" --at "$position" | sed -n '2p;5p' | awk 'NR == 1 { print $2, $4, $8 } NR == 2 { print }'; done
  selector binder reached
  values 1  8 : int
  selector binder reached
  values 1  8 : int
  selector binder reached
  values 1  2. : float
  selector binder reached
  values 1  "let id = fun value -> value in (id (7), id (true))" : string
  $ for position in 39:22 39:23; do DOX_BIN=dox node ../scripts/audit-execution.mjs learn/ocaml.ml.md --at "$position" | sed -n '2p;5p' | awk 'NR == 1 { print $2, $4, $8 } NR == 2 { print }'; done
  selector arrow reached
  values 0  -
  selector arrow reached
  values 0  -
  selector construct reached
  values 1  (210., 138.927311661) : float * float
  selector construct reached
  values 1  (210., 138.927311661) : float * float
  selector construct reached
  values 1  (210., 138.927311661) : float * float

Function returns use the executed branch result as their annotation anchor.
Single-line and multiline arms therefore place the return on the line where
that arm completes.

  $ DOX_BIN=dox node ../scripts/audit-execution.mjs inference.ml.md --at 31:6 | grep '^L '
  L 30 P function-entry Variable ("id")
  L 31 P function-exit ↩ "id"
  $ DOX_BIN=dox node ../scripts/audit-execution.mjs inference.ml.md --at 34:6 | grep '^L '
  L 30 P function-entry Apply (Variable ("id"), Boolean (true))
  L 36 P function-exit ↩ "id (true)"

Selecting a multiline function result does not duplicate the same runtime
occurrence on its start and end lines. The function-exit annotation is the
single presentation of that occurrence.

  $ DOX_BIN=dox node ../scripts/audit-execution.mjs inference.ml.md --at 36:53 --json | jq -r '.position.viewModel.projection.annotationPlan[] | "\(.line) \(.effective.kind) \(.effective.value.fullText)"'
  30 function-entry Apply (Variable ("id"), Boolean (true))
  36 function-exit ↩ "id (true)"

Anonymous functions retain their complete input even when the parameter is a
destructuring pattern. Their entry is anchored to `fun`, not to the zero-width
function context at the end of the body.

  $ DOX_BIN=dox node ../scripts/audit-execution.mjs demos/visualization.ml.md --at 20:20 | grep '^L \|^A 1' | head -3
  L 19 P function-entry (210., 138.927311661)
  L 20 P function-exit ↩ "210.00,138.93"
  A 1 fun((210., 138.927311661)) → "210.00,138.93"

  $ for position in 242:0 242:12; do DOX_BIN=dox node ../scripts/audit-execution.mjs inference.ml.md --at "$position" | sed -E 's/[0-9a-f]{24,}/<id>/g' | sed -n '2p;4p;5p;6p'; done
  242:0  selector - - -> construct -  unavailable
  selected -  -  occurrence -
  values 0  -
  projection -
  242:12  selector gh binder -> construct aC  reached
  selected a0  <id>-expression-000002c8  occurrence 2074
  values 1  [(1, Int); (2, Int); (3, Bool); (4, Bool)] : (Int_set.elt * typ) list
  active 18  inactive 0  global-unreached 1

A composite let pattern has one persistent structural annotation. Its
decomposed binders remain independently selectable without creating competing
persistent annotations.

  $ DOX_BIN=dox node ../scripts/audit-execution.mjs inference.ml.md --at 242:6 | sed -E 's/[0-9a-f]{24,}/<id>/g' | grep '^L 242'
  L 242 P binding ([(1, Int); (2, Int); (3, Bool); (4, Bool)], Product (Int, Bool))

Top-level bindings use the same persistent annotation rule. Moving to another
line does not remove the value that crossed the structure binding boundary.

  $ DOX_BIN=dox node ../scripts/audit-execution.mjs project/dataset.ml.md --at 12:12 | grep '^L 11' | cut -d' ' -f1-4
  L 11 P binding

Both structure and local recursive bindings expose `rec` as a structural
activation surface without inventing a value for the keyword.

  $ for location in fib.ml.md:5:8 inference.ml.md:264:10; do file=${location%:*:*}; position=${location#*:}; DOX_BIN=dox node ../scripts/audit-execution.mjs "$file" --at "$position" | sed -n '2p' | awk '{ print $2, $4, $8 }'; done
  selector rec reached
  selector rec reached

Recursive `function` syntax is an activation surface even when explicit
parameters precede it. Branch keywords select structural boundaries, so a
tail-call `else` chooses the right activations without claiming the call's
return value as the keyword's value.

  $ DOX_BIN=dox node ../scripts/audit-execution.mjs tracing.ml.md --at 30:28 | sed -E 's/[0-9a-f]{24,}/<id>/g' | sed -n '2p'
  30:28  selector 0y function -> construct 05  reached
  $ DOX_BIN=dox node ../scripts/audit-execution.mjs tracing.ml.md --at 36:10 | sed -E 's/[0-9a-f]{24,}/<id>/g' | sed -n '2p;5p'
  36:10  selector 1g else -> construct 0y  reached
  values 0  -

A destructured function parameter is one user-visible occurrence per
activation, not separate synthetic-parameter and pattern instrumentation rows.

  $ DOX_BIN=dox node ../scripts/audit-execution.mjs inference.ml.md --at 101:25 --json | jq -r '"activations=\(.position.query.activationIds | length) occurrences=\(.position.viewModel.occurrenceList.count)"'
  activations=4 occurrences=4

Polymorphic function inputs retain bounded raw structure when their static
element schema is a type variable; they do not collapse every value to
`<opaque>`.

  $ value=$(DOX_BIN=dox node ../scripts/audit-execution.mjs project/analysis.ml.md --at 8:10 --json | jq -r '.position.viewModel.projection.annotationPlan[] | select(.line == 8) | .effective.value.fullText'); case "$value" in *'#0("Mon", 16.2, 4.8)'*) echo structured;; *) echo "$value";; esac; case "$value" in *'<opaque>'*) echo opaque;; *) echo no-opaque;; esac
  structured
  no-opaque

Abstract but scannable module values also retain an honest raw runtime shape.

  $ value=$(DOX_BIN=dox node ../scripts/audit-execution.mjs inference.ml.md --at 62:12 --json | jq -r '.position.values.values[0].outcome.value.display'); case "$value" in \#*) echo raw;; *) echo "$value";; esac; case "$value" in *'<opaque>'*) echo opaque;; *) echo no-opaque;; esac
  raw
  no-opaque

Every cursor surface on a function whose body was never called has the same
defined-but-not-called state; closure creation does not borrow the top-level
activation.

  $ for position in 24:8 24:39; do DOX_BIN=dox node ../scripts/audit-execution.mjs welcome.ml.md --at "$position" | sed -E 's/[0-9a-f]{24,}/<id>/g' | sed -n '2p;4p;5p;6p'; done
  24:8  selector T binder -> construct C  unreached
  selected -  -  occurrence -
  values 0  -
  projection -
  24:39  selector 01 function-context -> construct C  unreached
  selected -  -  occurrence -
  values 0  -
  projection -

Value-bearing keywords follow the cursor contract: `let` exposes its RHS,
`if` exposes its condition, and branch-only keywords remain structural.

  $ for position in 33:10 34:10; do DOX_BIN=dox node ../scripts/audit-execution.mjs tracing.ml.md --at "$position" | sed -n '2p;5p'; done
  33:10  selector 0J let -> construct 0f  reached
  values 1  1 : int
  34:10  selector 0T if -> construct 0k  reached
  values 1  false : bool
  $ DOX_BIN=dox node ../scripts/audit-execution.mjs inference.ml.md --at 78:11 | sed -n '2p;5p'
  78:11  selector 47 match -> construct 2l  reached
  values 1  None : typ option

Compiler-only typed-tree wrappers are absent from the user-visible selector
manifest, so the concrete constructor is the single owner of that surface.

  $ DOX_BIN=dox node ../scripts/audit-execution.mjs inference.ml.md --at 163:12 | sed -n '2p' | awk '{ print $2, $4, $8 }'; DOX_BIN=dox node ../scripts/audit-execution.mjs inference.ml.md --at 163:12 | sed -n '5p'
  selector construct reached
  values 1  Integer (7) : expression

Every successful nested pattern node owns the exact subvalue projected by the
compiler matcher. Wildcards and composite nodes are reached rather than
globally faded, and the removed wrapper no longer hides the tuple pattern.

  $ for position in 92:26 115:12 115:32 163:18 164:18; do DOX_BIN=dox node ../scripts/audit-execution.mjs inference.ml.md --at "$position" | sed -n '2p' | awk '{ print $1, $2, $4, $8 }'; DOX_BIN=dox node ../scripts/audit-execution.mjs inference.ml.md --at "$position" | sed -n '5p'; done
  92:26 selector construct reached
  values 1  Int : typ
  115:12 selector construct reached
  values 1  Type_variable (1) : typ
  115:32 selector construct reached
  values 1  (Type_variable (1), Int) : typ * typ
  163:18 selector construct reached
  values 1  7 : int
  164:18 selector construct reached
  values 1  true : bool

The range-first selector rule still gives narrower payload binders precedence.

  $ DOX_BIN=dox node ../scripts/audit-execution.mjs learn/ocaml.ml.md --at 39:16 | sed -n '2p' | awk '{ print $2, $4, $8 }'; DOX_BIN=dox node ../scripts/audit-execution.mjs learn/ocaml.ml.md --at 39:16 | sed -n '5p'
  selector binder reached
  values 1  2. : float
  $ DOX_BIN=dox node ../scripts/audit-execution.mjs inference.ml.md --at 115:24 | sed -n '2p' | awk '{ print $2, $4, $8 }'; DOX_BIN=dox node ../scripts/audit-execution.mjs inference.ml.md --at 115:24 | sed -n '5p'
  selector binder reached
  values 1  1 : int

A `let` whose RHS is a function remains an activation surface, but it does not
mislabel one invocation's return as the value of the function definition.

  $ DOX_BIN=dox node ../scripts/audit-execution.mjs fib.ml.md --at 5:4 | sed -n '2p;5p'
  5:4  selector d let -> construct b  reached
  values 0  -

The selected activation keeps its match scrutinee annotation while the cursor
moves deeper into that activation. The annotation sits on the matched arm,
not on the `match` line.

  $ DOX_BIN=dox node ../scripts/audit-execution.mjs inference.ml.md --at 176:50 --json | jq -r '.position.viewModel.projection.annotationPlan[] | select(.effective.kind == "match") | "\(.line) \(.effective.value.fullText)"'
  169 ≈ Function ("value", Variable ("value"))

The match annotation presents the scrutinee, not the result returned by the
selected arm.

  $ DOX_BIN=dox node ../scripts/audit-execution.mjs inference.ml.md --at 166:20 --json | jq -r '.position.viewModel.projection.annotationPlan[] | select(.line == 165) | "\(.effective.kind) \(.effective.occurrenceId != .effective.boundaryId) \(.effective.value.fullText)"'
  match true ≈ Variable ("value")

When a matched arm also returns from the current activation, the lane presents
the matched input and function result together instead of dropping either.

  $ DOX_BIN=dox node ../scripts/audit-execution.mjs inference.ml.md --at 166:20 --json | jq -r '.position.viewModel.projection.annotationPlan[] | select(.line == 167) | "\(.effective.kind) \(.effective.value.fullText)"'
  match-and-exit ≈ Some (Forall (#immediate(0), Type_variable (0)))   ↩ ([], Type_variable (0))

Tuple scrutinees and multiline or-patterns use the same rule even when the
runtime represents the match itself as a boundary occurrence. The annotation
is anchored to the final arm arrow line.

  $ DOX_BIN=dox node ../scripts/audit-execution.mjs inference.ml.md --at 122:20 --json | jq -r '.position.viewModel.projection.annotationPlan[] | select(.effective.kind == "match" or .effective.kind == "match-and-exit") | "\(.line) \(.effective.value.fullText)"'
  121 ≈ (Arrow (Type_variable (1), Type_variable (1)), Arrow (Int, Type_variable (2)))

Line-end cursor positions keep the active arm or multiline expression instead
of falling back to the function's entire activation set. All four positions
below select an execution of the Arrow arm.

  $ for position in 81:29 81:30 82:14 82:15; do DOX_BIN=dox node ../scripts/audit-execution.mjs inference.ml.md --at "$position" | sed -n '2p;4p' | awk 'NR == 1 { printf "%s %s ", $2, $4 } NR == 2 { print $2 }'; done
  selector arrow a0
  selector arrow a0
  selector construct a0
  selector construct a0

The reducer audit drives cursor selection, a prose-only edit, a code edit, and
an evaluation failure through the same state machine used by the IDE.

  $ DOX_BIN=dox node ../scripts/audit-execution-reducer.mjs fib.ml.md --script ../test/execution-reducer.fixture.json | sed -E 's/[0-9a-f]{24,}/<id>/g'
   0 install                artifact-installed                         authority=exact evaluation=idle
     selection -/-/-/-
     effects -
     lane -
     occurrences 0
   1 cursor-moved           cursor-reached                             authority=exact evaluation=idle
     selection <id>-selector-00000005/<id>-expression-00000004/activation:5/10
     effects -
     lane 5:function-entry=6 | 8:cursor=8
     occurrences 19
   2 document-edited        document-prose-updated                     authority=exact evaluation=idle
     selection <id>-selector-00000005/<id>-expression-00000004/activation:5/10
     effects -
     lane 5:function-entry=6 | 8:cursor=8
     occurrences 19
   3 document-edited        document-code-updated                      authority=stale evaluation=pending
     selection <id>-selector-00000005/<id>-expression-00000004/activation:5/10
     effects lookup-artifact
     lane -
     occurrences 0
   4 evaluation-failed      evaluation-failed                          authority=stale evaluation=failed
     selection <id>-selector-00000005/<id>-expression-00000004/activation:5/10
     effects -
     lane -
     occurrences 0

The reducer audit accepts the documented JSON Lines form as the same intent
sequence.

  $ DOX_BIN=dox node ../scripts/audit-execution-reducer.mjs fib.ml.md --script ../test/execution-reducer-jsonl.fixture.jsonl | sed -n '/^ 0 /p;/^ 4 /p'
   0 install                artifact-installed                         authority=exact evaluation=idle
   4 evaluation-failed      evaluation-failed                          authority=stale evaluation=failed
  $ DOX_BIN=dox node ../scripts/audit-execution-reducer.mjs fib.ml.md --script ../test/execution-reducer-jsonl.fixture.jsonl --json | jq -r '.steps[3] | "\(.intent.kind) \(.identities.requestCodeDigest | length > 0) \(.sources | length) \(.recency.clock) \(.effects[0].kind)"'
  document-edited true 1 1 lookup-artifact

Activation aliases printed by the detailed audit can be passed back directly.

  $ DOX_BIN=dox node ../scripts/audit-execution.mjs fib.ml.md --at 8:12 --activation a1 | sed -n '3p'; DOX_BIN=dox node ../scripts/audit-execution.mjs fib.ml.md --at 8:12 --activation a1 | sed -n '4p' | awk '{ print $1, $2 }'
  reaches a0 a1 a2 a3 a4 a5 a6 a7 a8 a9 a10 a11 a12 a13 a14 a15 a16 a17 a18
  selected a1

The CLI uses normalized-LF editor coordinates after validating the raw CRLF
artifact identity.

  $ cp fib.ml.md fib.ml.md.lf; chmod u+w fib.ml.md; awk '{ printf "%s\r\n", $0 }' fib.ml.md.lf > fib.ml.md; DOX_BIN=dox node ../scripts/audit-execution.mjs fib.ml.md --check | tail -n 2; cp fib.ml.md.lf fib.ml.md
  self-check ok
  checked boundaries=172 selector-states=37 activation-choices=775 occurrence-navigation=437 activation-navigation=40 projections=41 sweeps=344 edit-recovery=3
