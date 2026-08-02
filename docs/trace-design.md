# Execution record

## Model

Dox records one execution while it evaluates the document. It does not launch
or control a debugger. The source text describes every possible execution; the
record contains the expressions that ran in this particular execution.

The compiler instruments boxed expressions whose source location belongs to a
`.ml.md` page. Compiler-generated module glue and installed libraries are not
instrumented. If an uninstrumented library invokes a closure defined in a Dox
page, that closure re-enters the active record beneath the user call that
entered the library.

## Events

Every event contains:

- a monotonically increasing sequence number;
- an occurrence ID and optional dynamic parent occurrence ID;
- an exact source path and span;
- an inferred type;
- a kind such as function, parameter, call, binding, value, step, or write;
- enter and return phases, or enter and raise phases;
- an event-time value preview or exception preview.

Application events are the exact dynamic parents of user function invocations.
Two calls on the same line therefore remain distinct without stack sampling or
source-text guessing. Executed paths are the expression events owned by an
invocation. An untaken branch has no owned events.

## Values and mutation

The compiler attaches a compact value schema to each trace site. The runtime
uses it to render values when their event occurs; it never retains a live
reference and prints it later. Primitive values, strings, tuples, lists,
options, arrays, records, and boxed variants have bounded OCaml-shaped
previews. Recursive variants keep constructor names. Closures and unsupported
non-scannable runtime blocks are explicitly opaque. Scannable values whose
abstract type hides field names use bounded raw block notation such as
`#0(...)`. Dox does not guess an abstract type's runtime representation from
its module name.

Destructuring a value records each identifier after the pattern has matched,
so `let left, right = pair` produces separate `left` and `right` bindings
rather than treating the pair as the value of `left`.

This gives useful mutation semantics without claiming heap time travel. A ref
can be recorded as `{contents = 1}`, followed by a write event, followed by a
later read of `2`. Dox does not assign durable identities to every heap object,
reconstruct alias graphs, or expose writes performed inside library and C code.

## Projections

The CLI and IDE consume the same normalized execution artifact.

- `dox check` includes the completed execution events in `traces`.
- `dox check` also reports raw tail-handoff, linked-enter, and unexpected
  handoff-outcome counts before tail events are projected away.
- `scripts/audit-execution.mjs --at LINE:COLUMN` runs the same selector,
  occurrence, activation, coverage, and view-model queries as the IDE.
- The always-present execution view focuses an invocation, softly highlights
  its executed path, annotates binders and returns, and links exact callsites.

Moving the source cursor focuses an execution through the selected construct.
Choosing an occurrence or Shift-clicking a call changes that same focus; none
of these interactions rerun or replay the program.

## Current semantic boundary

Instrumentation is inserted after typing. It records exceptions with re-raise
semantics and evaluates each expression once. A tail-position user call emits
a handoff event before the jump instead of installing a return continuation.
The entered function inherits the logical caller, so aliases and higher-order
tail calls keep both OCaml tail-call behavior and the execution tree. Dox
derives the omitted caller outcomes from the completed tail chain.

Observed closures register the number of supplied application arguments that
enter their body. This compiler-known value is used for both native and
bytecode closures; runtime closure metadata is not used. Underapplication uses
an ordinary observation. Overapplication hands off to each entered body in
turn and carries the remaining argument count until the final result.
When the bytecode interpreter creates a `RESTART` partial closure, it records
provenance only if the original closure was registered by Dox. The remaining
compiler-known consumption is then derived from the captured argument count,
so external and unobserved partial closures cannot arm a handoff.

If the evaluated callee is not a registered Dox function, the compiler keeps
an ordinary return/raise observation instead. This prevents callbacks from an
uninstrumented library from being mistaken for the immediate tail callee, but
that individual external or directly invoked anonymous call is not compiled
as a tail call.

Trace ownership currently follows system threads, but not captured algebraic
effect continuations. Resuming or cloning a continuation can therefore produce
an incomplete dynamic parent chain. Values and source coverage remain useful,
but call-tree navigation across that continuation boundary is best effort until
trace context is stored with the runtime continuation.
