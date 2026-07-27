# Observed execution

## Goal

Observed execution is an opt-in execution record for ordinary OCaml. A single
`@` marks the bindings, function calls, and expressions that should appear in a
hierarchical trace.

```ocaml
let rec @fib n =
  if n < 2 then n else @(fib (n - 1)) + fib (n - 2)

let @answer = fib 5
```

The marked expression has normal OCaml semantics: it is evaluated once, its
result or exception is recorded, and the same result is returned or the same
exception is re-raised with its backtrace.

## Syntax

- `let @x = expression` observes evaluation of the binding.
- `let @f arguments = body` observes each call after its arguments match.
- `let rec @f` and `and @g` have the same call semantics.
- `@(expression)` observes one expression.

`@` remains the ordinary list-append operator in infix position. The expression
form has no space between `@` and `(`. When it is a function argument, it is
parenthesized: `consume (@(produce ()))`.

## Compiler boundary

Doclang uses a project-local OxCaml compiler pinned in `vendor/oxcaml`. The
parser represents each marker as a private internal attribute on the unchanged
OCaml expression or binding. Type checking therefore sees the original program:
the marker does not introduce a helper call, thunk, dependency, or additional
value restriction.

After type checking, `Translcore` wraps the typed Lambda expression with three
non-allocating runtime primitives. The wrapper records entry, evaluates the
expression exactly once, and records either its result or exception. Exception
handling uses re-raise semantics so the original backtrace is retained. Doclang
does not replace the user's system compiler.

The compiler keeps the marked source span on the generated expression. Runtime
events carry a stable source site, inferred type, and per-evaluation occurrence
ID. The first implementation supports boxed values. Recording a function
return necessarily prevents that marked call from being compiled as a tail
call; unmarked calls retain ordinary optimization.

Each domain has an independent observation stack. Event writes are serialized
after leaving the OCaml runtime lock, so filesystem I/O does not block runtime
coordination. Observation stacks are not yet attached to algebraic-effect
continuations: a marked computation must not perform an effect that escapes the
marked span. Continuation-aware stack capture is required before that case can
produce a reliable hierarchy.

## Runtime model

Each evaluation has a dynamic observation stack. An occurrence contains:

- occurrence ID and parent occurrence ID;
- stable source site, source path, and exact span;
- binding, function, or expression kind;
- enter and return sequence numbers, or enter and raise sequence numbers;
- a bounded value preview or exception;
- the evaluation and project versions supplied by the evaluation response.

The semantic sequence is distinct from an `ocamldebug` time. A semantic sequence
orders trace events. A debugger time identifies an event in one retained
debugger session.

## User interaction

The context pane shows the trace tree when an evaluation contains observations.
Selecting an occurrence:

1. moves the editor selection to its source span;
2. keeps the occurrence selected in the tree;
3. shows its kind, result or exception, and source location;
4. queries the compiler type at that span.

Source navigation is available without an active debugger session.

## Debugger layer

The first implementation records the semantic trace. A later debugger layer
retains the exact `-g` bytecode and an `ocamldebug` process for the evaluation.
Generated observation boundaries provide correlation points between semantic
occurrences and debugger times. The APIs then support `goto`, `step`,
`backstep`, `next`, `previous`, and `finish`.

Debugger navigation is valid only for the exact retained bytecode and process
session. Reverse execution may repeat external effects, so the interface must
label replay boundaries and expire debugger sessions independently from the
durable semantic trace.

## Delivery stages

1. Pin and build the project-local OxCaml compiler.
2. Add parser markers, post-typing instrumentation, and focused tests.
3. Use the local compiler in evaluation, artifacts, and compiler queries.
4. Emit hierarchical enter, return, and raise events.
5. Render the source-linked trace tree and occurrence details.
6. Retain evaluation artifacts and add `ocamldebug` session control.
