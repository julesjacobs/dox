# Execution architecture

Status: revision 10, reviewed. The immutable artifact, indexed queries, reducer,
compiler/runtime tracing contract, and occurrence-centric IDE boundary are
implemented. Section 12.2 lists optional future extensions; the browser must
not guess semantics that are absent from the artifact.

## 1. Goal and boundary

The execution UI is a query over one immutable execution artifact. One pure
state reducer owns cursor selection, activation selection, occurrence
selection, edit drafts, asynchronous evaluation, recovery, and recency. The
CLI and IDE use the same artifact builder, queries, reducer, and
view-model builder.

The redesign keeps the document editor, module workspace, compiler toolchain,
evaluator, and visual components. It replaces execution identity, trace
normalization, selection, inspection, draft editing, coverage, and frontend
state transitions.

There is no compatibility requirement for old trace payloads or old serialized
frontend execution state.

## 2. Terms

- A **code revision** is one exact set of compiled OCaml sources and compiler
  inputs.
- A **document revision** is one exact set of `.ml.md` source documents.
- A **construct** is one compiler-assigned typed OCaml expression or pattern.
- A **selector** is a document range that maps cursor positions to a construct.
  The selector and construct can differ: the `fib` token in `fib 5` selects the
  application construct, and `else` selects the else-branch construct.
- An **occurrence** is one runtime evaluation of a construct.
- An **activation** is one invocation of a traced user function, or one
  top-level activation.
- A **selection** is one construct in one activation, optionally at one exact
  occurrence.
- A **draft** is a document revision whose changed OCaml code has no
  authoritative execution artifact yet.

These terms name different concepts and are not interchangeable.

## 3. Coordinates, ranges, and source maps

Compiler identity and editor coordinates are separate.

```ts
type Path = string;
type CodeRevisionId = string;
type DocumentRevisionId = string;

type EditorPosition = {
  path: Path;
  line: number;       // one-based
  column: number;     // zero-based UTF-16 code units
};

type EditorRange = {
  path: Path;
  start: number;      // absolute UTF-16 offset, inclusive
  end: number;        // absolute UTF-16 offset, exclusive
};

type CompilerRange = {
  generatedPath: Path;
  startByte: number;  // inclusive
  endByte: number;    // exclusive
};
```

Editor ranges are half-open. Tabs occupy one UTF-16 code unit. Line breaks are
normalized to LF before absolute editor offsets are counted, matching
CodeMirror's document model even when a saved source uses CRLF. A line exposes
cursor boundaries `0..line.length`, including the end-of-line boundary. Empty
lines expose boundary `0`. Editor coordinates use the JavaScript UTF-16 source;
compiler maps use extracted-source byte offsets.

`DocumentSourceMap` maps compiler byte ranges in extracted OCaml to editor
ranges in `.ml.md`. The compiler never uses editor positions as identity. The
IDE never uses compiler byte offsets directly.

OCaml and JavaScript implement the same `DocumentRevisionId` protocol: SHA-256
over domain-separated, UTF-8 byte-length-prefixed path and source fields. The
paths are ordered by UTF-8 bytes on both sides. The reducer passes that identity
through request tokens and installed views. The browser validates the sealed
source-map document revision against the exact supplied document before it
installs an artifact; it never substitutes a locally recomputed identity into
the envelope. It retains the sealed raw request digest on initial install while
normalizing only the editor's coordinate source to LF. The first edit creates a
new LF document revision. Rewriting CRLF as LF is therefore a real document
revision change, not an exact A→B→A return. Backend document-version tokens are
transport metadata and must not replace document identity.

```ts
type DocumentSourceMap = {
  documentRevisionId: DocumentRevisionId;
  codeRevisionId: CodeRevisionId;
  compilerToEditor(range: CompilerRange): EditorRange | null;
};
```

Changing prose or moving an unchanged code block changes the document revision
and source map, but not the code revision or execution artifact. Changing OCaml
code changes the code revision.

The executable-source identity uses the same Markdown subset in OCaml and
JavaScript: four-space code blocks, legacy triple-backtick `ocaml` fences, and
inline result expressions. Tilde fences are prose. Cross-language goldens pin
this grammar, including inline backticks inside tilde fences, so one side cannot
silently classify different executable text.

## 4. One authoritative compiler artifact

### 4.1 Construct IDs

Range-derived IDs are not allowed. Distinct typed-tree nodes may have identical
locations.

Before translation, one compiler pass walks the exact typed tree that will be
instrumented. It assigns every traceable expression and pattern a unique
`ConstructId`, attaches that ID as internal typed-tree metadata, and emits the
static manifest from the same annotated tree. Translation reads the attached
ID when it inserts runtime observations.

The initial ID representation is an opaque compilation-unit digest, node
category, and deterministic walk ordinal. Its printed representation is not a
frontend contract.

```ts
type ConstructId = string;
type SelectorId = string;
type LexicalScopeId = string;
type ExecutionScopeId = string;
type CompilationUnitId = string;

type Construct = {
  id: ConstructId;
  category: "expression" | "pattern";
  semanticKind:
    | "expression" | "function" | "application" | "identifier"
    | "literal" | "binding" | "match" | "condition" | "mutation"
    | "sequence" | "loop" | "binder" | "alias" | "wildcard"
    | "alternative" | "constructor" | "pattern";
  compilerRange: CompilerRange;
  parentId: ConstructId | null;              // typed-tree containment
  ownerScopeId: ExecutionScopeId;            // activation coverage ownership
  lexicalScopeId: LexicalScopeId;
  syntaxFingerprint: string;                 // excludes absolute position
  lexicalAncestryFingerprint: string;
  ghost: boolean;
};
```

An execution scope is either one function body or one compilation-unit
initializer. `ownerScopeId` is distinct from `parentId`. A nested function body
is not an inactive part of the outer activation, and top-level constructs from
different modules are not in one shared bucket.

### 4.2 Selectors

The same compiler artifact contains selectors. Syntax selectors are built from
the token stream and the annotated typed tree before the artifact is committed.

```ts
type SelectorRole =
  | "construct" | "callee" | "operator" | "binder"
  | "if" | "then" | "else"
  | "match" | "with" | "alternative" | "arrow"
  | "let" | "rec" | "equals" | "in" | "fun" | "function" | "when"
  | "function-context"
  | "while" | "for" | "do" | "done";

type CompilerSelector = {
  id: SelectorId;
  compilerRange: CompilerRange;
  subjectId: ConstructId;
  role: SelectorRole;
  priority: number; // larger wins
  tieBreakRank: number;
  syntaxFingerprint: string;
};
```

Every non-ghost construct has a `construct` selector over its own range.
Compiler syntax adds selectors whose subject is the construct denoted by that
syntax.

| Cursor surface | Selector subject |
| --- | --- |
| `fib` in `fib 5` | the `fib 5` application |
| `+` or `|>` | the full operator application |
| `x` in `(x, _)` | the `x` pattern construct |
| `Some` in `Some replacement` | the whole constructor pattern |
| `else` | the else-branch expression |
| `|` or `->` | that compiler-selected case pattern or right-hand side |
| `=` in a value binding | the binding right-hand side |
| the line-end boundary after a completed expression | the outermost non-structural expression ending there |
| a function line end with no completed expression | the function activation, with no focused subexpression |
| leading indentation inside a function | the innermost enclosing function activation, with no focused subexpression |
| punctuation | the smallest containing compiler construct |

Selector choice is deterministic: smaller range, then higher priority, then
the compiler-supplied tie-break rank and `SelectorId` byte order. Range-first
selection keeps nested binders and subpatterns reachable. Compiler-only
`Tpat_value` wrappers are omitted from this user-visible manifest, so the inner
source pattern is the canonical owner of their shared range. An equal-priority,
equal-range tie with different subjects is a validation error unless the
compiler explicitly supplies a distinct tie-break rank.

Cursor boundaries use deterministic syntax affinity. A compiler selector whose
visible token begins at the boundary owns that boundary. A `callee` selector
presents the complete call range and an `operator` selector presents the hull
of the operator and its operands. At a horizontal-whitespace run, the boundary
nearest the left syntax uses the largest construct completed on the left and
the boundary nearest the right syntax uses the selector beginning on the right.
Whitespace never invents a third semantic view. This also keeps spaces inside a
literal under the literal selector because they have no compiler-owned syntax
on both sides.

The parsed parameter pattern owns the bridge from the end of a function
parameter through its closing delimiters, type constraint, horizontal space,
and `->`. The function body takes over at its first selector. This makes every
parameter surface show the matched parameter value; it cannot accidentally
show the function's return before the cursor enters the body.

The final cursor boundary has completion affinity. It selects the outermost
non-structural expression ending at the last code character, stopping before an
enclosing binding, condition, match, function, loop, or sequence. This keeps a
match-arm completion on the expression returned by that arm instead of climbing
to the whole match or function. A `callee` or `operator` that ends the line
retains its promoted application view even when the rest of that application
continues on later lines. Completion is also confined to the innermost
lexical function scope, so the closing boundary of a callback cannot jump to a
surrounding higher-order call in its caller. A function construct that itself
completes there, such as a parenthesized callback argument, retains its callback
view. A `function-context` selector is only the fallback when no value or
function expression completes there. Leading indentation uses the innermost
enclosing `function-context` selector instead. Thus typing leaves the cursor on
the value just completed, while indentation provides a stable activation-only
surface. The rule depends only on the document revision and cursor boundary,
never on pointer geometry, movement direction, or interaction history.

### 4.3 Static manifest

```ts
type StaticProgram = {
  codeRevisionId: CodeRevisionId;
  compilerInputsDigest: string;
  compilationUnits: readonly CompilationUnit[];
  executionScopes: readonly ExecutionScope[];
  constructs: readonly Construct[];
  selectors: readonly CompilerSelector[];
};

type CompilationUnit = {
  id: CompilationUnitId;
  modulePath: string;
  generatedPath: Path;
  byteLength: number;
  sourceDigest: string;
  topLevelScopeId: ExecutionScopeId;
};

type ExecutionScope =
  | { id: ExecutionScopeId; kind: "top-level"; unitId: CompilationUnitId }
  | { id: ExecutionScopeId; kind: "function";
      unitId: CompilationUnitId; functionConstructId: ConstructId;
      functionFingerprint: string };
```

The source manifest is not produced by a separate Merlin reconstruction. Merlin
may still provide ordinary editor features, but it is not an execution identity
authority.

## 5. Runtime protocol

The low-level tracer records one globally monotonic sequence number and a domain
ID. The initial release may reject multiple domains, but it may not silently
merge events without domain identity.

```ts
type EvaluationId = string;
type OccurrenceId = string;
type ActivationId = string;
type ClosureId = string;
type CallAttemptId = string;
type DomainId = string;

type CapturedValue = {
  type: string;
  display: string;
  fingerprint: string | null; // null when incomplete or unsafe to fingerprint
  complete: boolean;
};

type EventBase = {
  sequence: number;
  domainId: DomainId;
};

type RawTraceEvent =
  | (EventBase & {
      kind: "closure-created";
      closureId: ClosureId;
      functionConstructId: ConstructId;
      originActivationId: ActivationId | null;
      sourceClosureId: ClosureId | null;
    })
  | (EventBase & {
      kind: "activation-enter";
      activationId: ActivationId;
      functionOccurrenceId: OccurrenceId | null;
      scopeId: ExecutionScopeId;
      closureId: ClosureId | null;
      functionConstructId: ConstructId | null;
      dynamicParentId: ActivationId | null;
      callsiteOccurrenceId: OccurrenceId | null;
      consumedCallAttemptId: CallAttemptId | null;
    })
  | (EventBase & {
      kind: "activation-outcome";
      activationId: ActivationId;
      outcome: "return" | "raise";
      value: CapturedValue;
    })
  | (EventBase & {
      kind: "occurrence-enter";
      occurrenceId: OccurrenceId;
      activationId: ActivationId;
      parentOccurrenceId: OccurrenceId | null;
      constructId: ConstructId;
      occurrenceKind: "expression" | "call";
    })
  | (EventBase & {
      kind: "occurrence-outcome";
      occurrenceId: OccurrenceId;
      outcome: "return" | "raise";
      value: CapturedValue;
    })
  | (EventBase & {
      kind: "pattern-success";
      occurrenceId: OccurrenceId;
      activationId: ActivationId;
      parentOccurrenceId: OccurrenceId | null;
      constructId: ConstructId;
      role: "pattern" | "binder" | "parameter";
      value: CapturedValue;
    })
  | (EventBase & {
      kind: "call-attempt-open";
      callAttemptId: CallAttemptId;
      ownerActivationId: ActivationId;
      callOccurrenceId: OccurrenceId;
      tail: boolean;
    })
  | (EventBase & {
      kind: "call-attempt-consumed";
      callAttemptId: CallAttemptId;
      producerActivationId: ActivationId;
    })
  | (EventBase & {
      kind: "call-attempt-outcome";
      callAttemptId: CallAttemptId;
      outcome: "return" | "raise";
      value: CapturedValue;
    })
  | (EventBase & {
      kind: "write";
      writeId: string;
      activationId: ActivationId;
      constructId: ConstructId;
      operation: "ref" | "field" | "array" | "bytes" | "custom";
      targetId: string | null;
      oldValue: CapturedValue | null;
      newValue: CapturedValue;
    });
```

Pattern events mean successful matches, not attempts. Every successful typed
pattern node emits its exact matched subvalue before guard evaluation. A
successful pattern followed by a false guard still has pattern events. A failed
structural match emits none. Distinct `or` alternatives have distinct construct
IDs.

The matcher owns destructured function-parameter observations. Explicit
synthetic parameter emission is suppressed when the same compiler construct is
already observed as a matched pattern. Queries therefore receive one semantic
occurrence per `(activation, construct)` with the exact matched subvalue.

`activation-enter` also enters `functionOccurrenceId` for the function
construct; `activation-outcome` completes both the activation and that function
occurrence. This gives function navigation the same reach and value semantics as
every other construct.

The assignment expression remains an ordinary expression occurrence returning
`unit`. A write is a separate record with the new value and target identity when
available. This does not promise heap replay.

`dynamicParentId` means active call relationship. Closure origin is stored on
the closure, while derived-closure provenance links a partial closure to its
source closure. Neither substitutes for dynamic parentage. A synchronous
callback from untraced library code retains the active user activation and
library callsite when available. A genuinely delayed or external callback may
have no dynamic parent and still retain closure origin.

Every traced application has a call attempt. An activation explicitly consumes
the attempt that invoked it. The bytecode VM records exactly one final attempt
outcome after partial application, exact application, or overapplication has
produced its final value. For a tail application this bookkeeping lives in the
tracer's VM-side continuation table, not on the OCaml stack, so the compiler adds
no post-call work and constant-stack execution is preserved. The attempt may be
consumed by zero, one, or several activations, but it has exactly one final
outcome. A tail caller and its call occurrence derive their outcome from that
attempt. An unresolved attempt is allowed only in a truncated trace.

## 6. Atomic transport and normalized artifact

The runtime first produces an evaluator-private raw envelope. The evaluator
validates and normalizes it, then publishes one checksummed normalized envelope.
Raw events may be retained as a CLI audit sidecar, but they are never a second
installable input.

```ts
type TraceTerminal =
  | { kind: "complete"; finalSequence: number; checksum: string }
  | { kind: "truncated"; finalSequence: number; reason: string;
      checksum: string };

type RawEvaluationEnvelope = {
  schemaVersion: number;
  evaluationId: EvaluationId;
  codeRevisionId: CodeRevisionId;
  compilerInputsDigest: string;
  staticProgram: StaticProgram;
  events: readonly RawTraceEvent[];
  terminal: TraceTerminal;
};
```

`complete` is emitted out of band by the runtime renderer. It is never inferred
from display text. Buffer clipping, bounded collection rendering, opaque
values, and registry exhaustion all make the artifact explicitly incomplete;
only complete values receive fingerprints.

When a static value schema is polymorphic, the runtime may render a bounded raw
block shape such as `#0(...)`. It does not invent record-field semantics from a
type variable, and it does not replace inspectable structure with `<opaque>`.

A truncated terminal is authoritative only for events that were recorded.
Absence after truncation is unknown, not proof of non-execution. Cursor queries
therefore return `unknown` for selectors with no recorded activation, and
coverage leaves unrecorded constructs uncovered. Activation-inactive and
globally-unreached sets may partition a scope only for a complete terminal.

Runtime function-code and closure registries use indexed lookup on the apply
path. Closure creation is an append-only event and does not scan prior
closures. The identity index is rebuilt once when a guarded miss detects that
GC moved registered closures; same-site closures therefore do not cause one
linear scan per invocation. Hitting a fixed registry bound emits a truncated
terminal artifact rather than losing provenance silently.

The runtime producer writes a framed stream with a commit record or a temporary
file renamed after the terminal record. Transport failure is an evaluation
failure and never produces an installable artifact.

```ts
type Outcome = {
  kind: "return" | "raise" | "incomplete";
  value: CapturedValue | null;
  source: "runtime" | "call-attempt" | "truncated";
};

type Occurrence = {
  id: OccurrenceId;
  constructId: ConstructId;
  activationId: ActivationId;
  parentOccurrenceId: OccurrenceId | null;
  kind: "function" | "expression" | "call" | "pattern" | "binder"
    | "parameter" | "boundary";
  enteredAt: number;
  outcomeAt: number | null;
  outcome: Outcome;
};

type ActivationSignature = {
  functionKey: string;
  callsiteKey: string | null;
  parameterFingerprints: readonly (string | null)[];
  outcomeFingerprint: string | null;
};

type Activation = {
  id: ActivationId;
  scopeId: ExecutionScopeId;
  functionOccurrenceId: OccurrenceId | null;
  functionConstructId: ConstructId | null;
  closureId: ClosureId | null;
  dynamicParentId: ActivationId | null;
  callsiteOccurrenceId: OccurrenceId | null;
  consumedCallAttemptId: CallAttemptId | null;
  occurrenceIds: readonly OccurrenceId[];
  parameterOccurrenceIds: readonly OccurrenceId[];
  enteredAt: number;
  outcomeAt: number | null;
  outcome: Outcome;
  signature: ActivationSignature;
};

type Closure = {
  id: ClosureId;
  functionConstructId: ConstructId;
  createdAt: number;
  originActivationId: ActivationId | null;
};

type ClosureProvenance = {
  closureId: ClosureId;
  kind: "derived";
  activationId: null;
  callsiteOccurrenceId: null;
  sourceClosureId: ClosureId;
  sequence: number;
};

type CallAttempt = {
  id: CallAttemptId;
  ownerActivationId: ActivationId;
  callOccurrenceId: OccurrenceId;
  tail: boolean;
  openedAt: number;
  producerActivationIds: readonly ActivationId[];
  outcomeAt: number | null;
  outcome: Outcome;
};

type Write = {
  id: string;
  activationId: ActivationId;
  constructId: ConstructId;
  sequence: number;
  operation: string;
  targetId: string | null;
  oldValue: CapturedValue | null;
  newValue: CapturedValue;
};

type NormalizedExecution = {
  occurrences: readonly Occurrence[];
  activations: readonly Activation[];
  closures: readonly Closure[];
  closureProvenance: readonly ClosureProvenance[];
  callAttempts: readonly CallAttempt[];
  writes: readonly Write[];
};

type SourceMapEntry = {
  selectorId: SelectorId;
  generatedPath: Path;
  startByte: number;
  endByte: number;
  documentPath: Path;
  startUtf16: number;
  endUtf16: number;
};

type SourceMapManifest = {
  documentRevisionId: DocumentRevisionId;
  codeRevisionId: CodeRevisionId;
  sourcesDigest: string;
  extractedCodeDigest: string;
  entries: readonly SourceMapEntry[];
};

type ExecutionArtifactEnvelope = {
  schemaVersion: number;
  evaluationId: EvaluationId;
  requestCodeDigest: string;
  projectDigest: string;
  codeRevisionId: CodeRevisionId;
  compilerInputsDigest: string;
  staticProgram: StaticProgram;
  sourceMaps: SourceMapManifest;
  execution: NormalizedExecution;
  terminal: TraceTerminal;
  artifactChecksum: string;
};
```

`requestCodeDigest` identifies the editable target's extracted code.
`projectDigest` identifies all compiler inputs outside that target, ordered by
path, and deliberately excludes the target. `projectVersion` is a separate
server concurrency token and is not part of artifact identity. This separation
makes an A → B → A edit reuse A after autosave while still rejecting reuse when
a dependency changed.

`codeRevisionId`, `compilerInputsDigest`, and `extractedCodeDigest` are
domain-separated, byte-length-framed SHA-256 identities. Compiler executable
content is hashed with SHA-256 before it enters the compiler identity. The
random `evaluationId` is only a request/run correlation nonce and is labeled as
an evaluation in audit output; it is not an artifact identity.

OCaml and JavaScript also implement the same request digest protocol. It hashes
the ordered executable OCaml blocks and inline expressions with the same
domain-separated, UTF-8 byte-length framing. Shared golden vectors cover Unicode,
indented blocks, fenced examples, prose, and inline expressions. The server
rejects a supplied digest that does not match its parsed draft, and the browser
adapter rejects an artifact whose digest does not match its installed source.
Initial and edited artifacts therefore use one cache identity without resealing
or masking transport corruption.

Derived-closure provenance is not a call-tree edge. Dynamic parentage remains
the only call-tree edge. Correlating a delayed callback with a specific library
registration requires a future explicit library/runtime registration event;
the current artifact does not guess that relation.

The artifact checksum covers every field except itself. It uses 32-bit FNV-1a
over a shared canonical value encoding: object keys are byte-sorted, containers
carry counts, scalars carry type tags, and strings carry UTF-8 byte lengths. It
detects accidental transport corruption; it is not an authentication or trust
boundary. Code and document identities use SHA-256. The checksum never hashes a
language-specific JSON serialization. The shared snapshot builder accepts only
`ExecutionArtifactEnvelope`; it never accepts raw and normalized dynamic data
as separate arguments.

## 7. Immutable execution snapshot

The shared JavaScript core validates and indexes the normalized artifact.

```ts
type ExecutionSnapshot = {
  evaluationId: EvaluationId;
  requestCodeDigest: string;
  projectDigest: string;
  codeRevisionId: CodeRevisionId;
  compilerInputsDigest: string;
  sourceMaps: SourceMapManifest;
  staticProgram: StaticProgram;
  terminal: TraceTerminal;

  // Encapsulated immutable stores, exposed only through query functions.
  occurrenceById: OpaqueStore<OccurrenceId, Occurrence>;
  activationById: OpaqueStore<ActivationId, Activation>;
  closureById: OpaqueStore<ClosureId, Closure>;
  closureProvenanceByClosure:
    OpaqueStore<ClosureId, readonly ClosureProvenance[]>;
  closureProvenanceByActivation:
    OpaqueStore<ActivationId, readonly ClosureProvenance[]>;
  callAttemptById: OpaqueStore<CallAttemptId, CallAttempt>;
  writeById: OpaqueStore<string, Write>;
  constructById: OpaqueStore<ConstructId, Construct>;
  selectorById: OpaqueStore<SelectorId, CompilerSelector>;

  occurrenceIdsByConstruct: OpaqueStore<ConstructId, readonly OccurrenceId[]>;
  occurrenceIdsByActivationAndConstruct:
    OpaqueStore<string, readonly OccurrenceId[]>;
  activationIdsByConstruct: OpaqueStore<ConstructId, readonly ActivationId[]>;
  executedConstructIdsByActivation:
    OpaqueStore<ActivationId, ReadonlySet<ConstructId>>;
  childActivationIdsByActivation:
    OpaqueStore<ActivationId, readonly ActivationId[]>;
  constructIdsByExecutionScope:
    OpaqueStore<ExecutionScopeId, readonly ConstructId[]>;
  writeIdsByActivation: OpaqueStore<ActivationId, readonly string[]>;
  writeIdsByConstruct: OpaqueStore<ConstructId, readonly string[]>;
  writeIdsByTarget: OpaqueStore<string, readonly string[]>;
};
```

The stores and backing records are closed over by the module and cannot be
mutated by consumers. Query functions return production-frozen value objects or
defensive copies, never backing references.

`buildExecutionSnapshot(envelope)` is pure and publishes no partial result.
Validation errors have stable codes and entity IDs:

```ts
type ValidationProblem = {
  code: string;
  entityType: string;
  entityId: string;
  detail: string;
};
```

Validation covers:

- envelope schema, revision, compiler-input, terminal, sequence, and checksum;
- compilation units, source digests/byte lengths, source maps, and ordered
  in-bounds compiler/editor ranges; normalized selectors and source-map
  entries form a strict `selectorId` bijection, while compiler-only selectors
  remain available in the raw compiler manifest;
- unique construct/selector/occurrence/activation IDs;
- construct parent existence and cycles;
- execution-scope existence and lexical ownership;
- selector subjects, priorities, and ambiguous ties;
- normalized timestamp bounds and phase ordering; raw event sequence uniqueness
  and raw phase ordering are validated by the evaluator-private normalizer;
- occurrence parent existence, same-activation ownership, and cycles;
- activation dynamic-parent cycles, parent-active-at-child-entry timing, and
  separate non-causal provenance validity;
- function occurrence, callsite, closure/provenance, call-attempt, parameter,
  execution-scope, and activation kind coherence;
- exact occurrence membership: every occurrence is owned once;
- call-attempt consumption, unique terminal outcome, and derived outcome
  propagation;
- write activation/construct/target validity, nullable captured old values,
  required captured new values, and ordered write indexes;
- complete traces have no incomplete occurrences or activations;
- truncated traces mark every unresolved item incomplete;
- every derived index is exhaustive, unique, deterministic, and sequence ordered.

## 8. Display view and selector interval index

An execution snapshot has compiler ranges. An `ExecutionView` adds the current
document source maps and optional draft.

```ts
type ProjectedSelector = {
  id: SelectorId;
  subjectId: ConstructId;
  role: SelectorRole;
  priority: number;
  range: EditorRange;
  valid: boolean;
};

type DraftFile = {
  source: string;
  changesFromBase: readonly TextChange[];
  codeChanged: boolean;
};

type TextChange = {
  from: number; // offsets in the current draft before this action
  to: number;
  insert: string;
};

type DraftView = {
  baseDocumentRevisionId: DocumentRevisionId;
  baseCodeRevisionId: CodeRevisionId | null;
  requestedCodeDigest: string | null;
  files: ReadonlyMap<Path, DraftFile>;
  invalidConstructIds: ReadonlySet<ConstructId>;
};

type ExecutionView = {
  snapshot: ExecutionSnapshot | null;
  documentRevisionId: DocumentRevisionId;
  sources: ReadonlyMap<Path, string>;
  sourceMaps: ReadonlyMap<Path, DocumentSourceMap>;
  selectors: AbsoluteIntervalIndex<ProjectedSelector>;
  runtimeAuthority: "exact" | "stale" | "unavailable";
  draft: DraftView | null;
};
```

The interval index uses absolute UTF-16 offsets and supports multiline ranges
without duplicating them per line. Lookup is `O(log selectors + matches)`.

Prose-only edits rebuild source maps and projected selector ranges without
changing the execution snapshot. Code edits create or extend a draft. Any edit
intersecting a construct invalidates that construct and every containing
construct. Inserted text never inherits an old selector. A projected selector is
queryable for navigation only when its subject construct's exact base code
survived unchanged.

Any code-changing draft makes runtime authority `stale` for the entire old
artifact. Old selector geometry may remain visible for continuity, but cursor
queries return no authoritative activation IDs, values and activation coverage
are suppressed, and no annotation claims an old value describes the changed
program. The old selection is retained only as a recovery anchor. Prose-only
drafts retain `exact` runtime authority.

All coordinate operations accept `ExecutionView`, never a bare snapshot, so the
IDE adapter does not decide whether draft coordinates are authoritative.

## 9. Core query types and operations

```ts
type CursorQuery = {
  position: EditorPosition;
  selectorId: SelectorId | null;
  constructId: ConstructId | null;
  activationIds: readonly ActivationId[]; // unique, execution ordered
  status: "reached" | "unreached" | "unknown" | "stale"
    | "unmapped-draft" | "unavailable";
};

type Selection = {
  selectorId: SelectorId | null;
  constructId: ConstructId | null;
  activationId: ActivationId | null;
  focusedOccurrenceId: OccurrenceId | null;
};

type OccurrenceValue = {
  occurrenceId: OccurrenceId;
  sequence: number;
  outcome: Outcome;
};

type Inspection = {
  position: EditorPosition;
  selectorId: SelectorId | null;
  constructId: ConstructId | null;
  activationId: ActivationId | null;
  values: readonly OccurrenceValue[];
  status: "value" | "unreached" | "unknown" | "stale"
    | "unmapped-draft" | "unavailable";
};

type ActivationProjection = {
  activationId: ActivationId;
  activeConstructIds: ReadonlySet<ConstructId>;
  inactiveConstructIds: ReadonlySet<ConstructId>;
  globallyUnreachedConstructIds: ReadonlySet<ConstructId>;
  bindingValues: readonly OccurrenceValue[];
  returnValue: Outcome;
  parentActivationId: ActivationId | null;
  childActivationIds: readonly ActivationId[];
};

type Recency = {
  clock: number;
  viewedAtByActivationId: ReadonlyMap<ActivationId, number>;
  viewedAtByReconciliationKey: ReadonlyMap<string, number>;
};
```

### 9.1 Cursor resolution

```ts
resolveCursor(view, position) -> CursorQuery
```

The winning valid selector determines the construct. The query returns the
activation index for that construct. If the selector exists but no occurrence
reached it, activation IDs are empty; it never falls back to a surrounding
executed construct.

### 9.2 Cursor selection

```ts
selectCursor(view, query, previousSelection, recency) -> Selection
```

Activation choice order is:

1. previous activation if it reached the construct;
2. most recently viewed reaching activation;
3. first reaching activation in execution order;
4. `null` when unreached.

The focused occurrence is preserved only if it belongs to the chosen activation
and construct; otherwise the earliest occurrence for that pair is selected.

### 9.3 Activation and occurrence navigation

```ts
selectActivation(view, selection, activationId)
  -> { selection: Selection; accepted: boolean }

selectOccurrence(view, occurrenceId)
  -> { selection: Selection; moveCursorTo: EditorRange | null }

navigateActivation(view, activationId)
  -> { selection: Selection; moveCursorTo: EditorRange | null }
```

`selectActivation` accepts only an activation that reached the selected
construct. These are exactly the activation choices shown in the right pane.

`selectOccurrence` selects that occurrence's construct and activation. The
right-pane occurrence list uses this operation.

`navigateActivation` is for parent/child call navigation. It selects the target
activation's function occurrence and requests a cursor move. If the activation
has no function occurrence, it delegates to
`selectOccurrence(callsiteOccurrenceId)`, which selects the callsite's owner
activation rather than pairing the callsite with the target activation. If
neither exists, navigation is rejected. The result includes `accepted` and a
stable decision code and never creates a construct/activation pair that did not
occur.

### 9.4 Values at the cursor

```ts
valuesAt(view, selection, { offset, limit })
  -> { values: readonly OccurrenceValue[]; total: number }
```

Values use the `(activationId, constructId)` index and are paginated for hot
loops.

- Application values are application outcomes.
- Callee and operator selectors already target the application construct.
- Binder values are exact successful binder-pattern subvalues.
- Constructor patterns return the value matched by the constructor pattern.
- Repeated evaluation returns multiple ordered values.
- A function construct is reached by the activation's explicit function
  occurrence, whose outcome is the activation outcome.

Structural selector roles (`if`, `then`, `else`, `match`, `with`, case bars and
arrows, binding and loop keywords, and function keywords) choose the executions
that reached their compiler-selected subject, but have no expression value of
their own. In particular, `then` and `else` remain branch-specific without
claiming the selected branch expression's result as the keyword's value.

The cursor is the only source-position input to execution presentation. Pointer
movement has no execution state and cannot change focus, coverage, annotations,
or the occurrence list.

### 9.5 Activation projection

```ts
projectActivation(view, selection) -> ActivationProjection | null
```

Projection uses `ownerScopeId`, not general typed-tree descendants. Results
are memoized per artifact and activation. Source ranges are looked up only after
construct sets are complete.

A function expression belongs to the enclosing execution scope where its
closure is created. Its body belongs to the distinct function execution scope
named by `ExecutionScope.functionConstructId`. A function activation uses that
function execution scope. A top-level activation treats every globally reached
construct owned by its top-level scope as active when the terminal is complete.
With a truncated terminal, only recorded constructs are active; missing
constructs remain unknown and uncovered.

Projected AST ranges can nest or coincide. The view model composes them into
disjoint UTF-16 intervals before rendering. The smallest construct owns an
interval; identical ranges prefer active, then activation-inactive, then
globally-unreached evidence. CSS therefore never resolves semantic precedence.

```ts
writesForActivation(view, activationId, page) -> readonly Write[]
writesForConstruct(view, constructId, page) -> readonly Write[]
writesForTarget(view, targetId, page) -> readonly Write[]
```

Write queries are sequence ordered and paginated. The artifact retains the
ordinary unit outcome of an assignment. Inspection of the assignment selector
presents the corresponding written value, because that is the semantic value
of the mutation boundary.

A `boundary` occurrence records that an activation reached structural syntax,
such as a branch arrow, before a tail call transfers control. Its unit outcome
is an internal tracing payload, not a source expression value. Presentation
uses the occurrence to select and list the activation, but omits that payload
from annotations and value controls.

An `incomplete` occurrence similarly proves reach but not a returned value. It
has no annotation or value control. The occurrence row says that the trace
ended before the value returned, which distinguishes missing runtime evidence
from a deliberately summarized large value.

## 10. Cross-revision reconciliation

Construct and activation IDs do not survive a code revision. Reconciliation is
explicitly best effort and returns a decision code.

```ts
type ReconciliationKey = {
  selectorRole: SelectorRole;
  mappedEditorRange: EditorRange | null;
  constructCategory: "expression" | "pattern";
  lexicalAncestryFingerprint: string;
  functionFingerprint: string | null;
  callsiteFingerprint: string | null;
};

type OccurrenceReconciliationKey = {
  constructKey: ReconciliationKey;
  activationAncestryFingerprint: string;
  parentOccurrenceAncestryFingerprint: string;
  ordinalWithinActivationAndConstruct: number;
  outcomeFingerprint: string | null;
};
```

The compiler manifest includes syntax and lexical fingerprints that exclude
absolute positions. Activation candidates additionally compare complete
parameter fingerprints, complete outcome fingerprint, dynamic call ancestry,
and execution ordinal. Truncated display strings are never reconciliation keys.

If multiple candidates remain equal, recency breaks the tie; otherwise the
first execution-ordered candidate is chosen and the reducer records
`reconcile-ambiguous`. Missing or changed constructs produce a null selection.
Focused occurrences use `OccurrenceReconciliationKey`; when its exact candidate
is gone, focus falls back to the nearest ordinal in the reconciled activation
and records `reconcile-occurrence-nearest`, rather than silently choosing the
earliest occurrence.

## 11. Pure execution reducer

The reducer is the only state owner used by the CLI and IDE.

`ExecutionState`, `ExecutionView`, and `ExecutionSnapshot` are opaque immutable
handles backed by encapsulated indexes. “Pure” means that `transition` is
deterministic and performs no I/O; it does not mean that these indexed handles
are JSON-serializable. Replay rebuilds a view from the sealed artifact and exact
source set, then reapplies intents. Canonical audit output serializes the
observable projection, not process-local indexes.

```ts
type RequestToken = {
  generation: number;
  requestCodeDigest: string;
  documentRevisionId: string;
  projectDigest: string;
  compilerInputsDigest: string;
};

type EvaluationStatus =
  | { kind: "idle" }
  | { kind: "pending"; token: RequestToken }
  | { kind: "failed"; token: RequestToken; diagnostics: readonly string[] };

type ExecutionState = {
  view: ExecutionView;
  projectDigest: string;
  compilerInputsDigest: string;
  selection: Selection;
  recency: Recency;
  evaluation: EvaluationStatus;
  nextGeneration: number;
};

type Intent =
  | { kind: "cursor-moved"; position: EditorPosition }
  | { kind: "activation-chosen"; activationId: ActivationId }
  | { kind: "occurrence-chosen"; occurrenceId: OccurrenceId }
  | { kind: "activation-navigated"; activationId: ActivationId }
  | { kind: "document-edited"; path: Path; source: string;
      change: TextChange }
  | { kind: "project-replaced"; projectDigest: string;
      compilerInputsDigest: string; sources: ReadonlyMap<Path, string> }
  | { kind: "artifact-available"; token: RequestToken;
      artifact: ExecutionArtifactEnvelope | null }
  | { kind: "evaluation-succeeded"; token: RequestToken;
      artifact: ExecutionArtifactEnvelope }
  | { kind: "evaluation-failed"; token: RequestToken;
      diagnostics: readonly string[] };

type Effect =
  | { kind: "lookup-artifact"; token: RequestToken }
  | { kind: "evaluate"; token: RequestToken; sources: ReadonlyMap<Path, string>;
      compilerInputsDigest: string }
  | { kind: "cancel-evaluation"; token: RequestToken }
  | { kind: "move-editor-cursor"; range: EditorRange };

type Transition = {
  state: ExecutionState;
  effects: readonly Effect[];
  decision: string;
};

transition(state, intent) -> Transition
```

```ts
buildDocumentRevision(view, { path, source, change }) -> {
  documentRevisionId: DocumentRevisionId;
  requestCodeDigest: string;
  codeChanged: boolean;
  draft: DraftView | null;
  sourceMaps: ReadonlyMap<Path, DocumentSourceMap>;
};
```

Rules:

- Cursor movement resolves and commits one selection.
- Right-pane activation choices call `selectActivation`.
- Right-pane occurrence choices call `selectOccurrence`.
- Parent/child navigation calls `navigateActivation` and emits one cursor effect.
- Activation choices, occurrence choices, and activation navigation reject
  `stale` or `unavailable` runtime authority with stable decision codes and do
  not change selection or recency. This makes delayed DOM clicks harmless.
- `buildDocumentRevision` is a shared pure core operation. It parses the edited
  documents, classifies prose-only versus code-changing edits, builds the
  request source digest, and builds prose-only source maps. The browser adapter
  does none of this classification.
- The browser must classify an edit before a backend round trip, so it mirrors
  the backend's deliberately small executable-Markdown subset. Cross-language
  goldens cover every supported block form, inline expression ordering, CRLF,
  Unicode, tilde-fence exclusion, and UTF-8 path ordering. Neither parser
  accepts general Markdown fences as executable code.
- A code-changing document edit atomically replaces any pending token with a
  new token, marks runtime authority stale, and returns cancellation and artifact
  lookup effects. Replacing the token is the cancellation tombstone; the old
  result can no longer match current state.
- `artifact-available` accepts only the current token. A validated matching
  artifact installs immediately; a cache miss returns the evaluate effect. This
  makes A→B→A cache recovery part of the reducer and its CLI audit.
- A prose-only edit updates document revision, source maps, and selectors without
  creating a request or changing runtime authority.
- `project-replaced` is the atomic add/remove/replace operation for the source
  set and compiler inputs. It updates project ownership in state and creates or
  invalidates requests through the same token rules as code edits.
- Success or failure is accepted only when its token exactly equals the current
  pending token. There is no separate `evaluation-started` transition.
- Success additionally requires artifact request-code digest and project
  digest to match current state. The compiler supplies the authoritative code
  revision ID.
- A stale or cancelled result is discarded even if the request returns.
- Snapshot construction and validation complete before one atomic state install.
- Successful install atomically replaces snapshot, source maps, selector index,
  document/code revision association, and runtime authority; it reconciles
  selection and focused occurrence, and clears matching failure/draft state.
- If prose changes while a code request is pending, the reducer cancels that
  request and starts one for the new document revision. A result is installable
  only when its request token still names the current document revision. This
  keeps source-map projection atomic without rebasing ranges in the browser.
- A failed evaluation keeps the previous artifact plus draft and records
  diagnostics for the matching token only.
- Returning to a cached exact code revision may install its validated artifact
  immediately with the current document source map.
- Recency increments exactly once for an accepted committed cursor selection,
  activation choice, occurrence choice, or activation navigation that changes
  selection. Rejected choices, CLI matrix queries, and idempotent editor
  echoes never update recency.

CodeMirror mirrors reducer selection. A reducer-requested cursor transaction is
annotated so the resulting editor event is either suppressed or idempotently
resolved to the same selection.

## 12. View model and IDE boundary

```ts
buildExecutionViewModel(state) -> ExecutionViewModel
```

The view model contains all editor decorations, the selected compiler range,
the single annotation slot for each physical line, the occurrence list,
coverage classes, and navigation targets. Rendering modules may not import
artifact folding, selector resolution, activation matching, reconciliation, or
coverage construction.

### 12.1 Occurrence-centric presentation

The right pane lists one row for every semantic dynamic occurrence of the
selected construct. Repeated evaluations in one activation are separate rows.
An expression row has an activation control and an exact occurrence-value
control. A structural selector retains the activation control but omits the
value control. The controls dispatch `activation-chosen` and
`occurrence-chosen`, respectively.

`annotationPlanForSelection` is a pure projection. It produces at most one
effective annotation for `(path, physical line)`. Persistent candidates are
structural boundaries. A `let` binding value belongs to the executed root
pattern construct. A local binding root has a compiler parent with semantic
kind `binding`; a structure binding root is the parentless pattern owned by the
top-level scope. Decomposed child binders and match-clause patterns are not
competing persistent candidates. A
cursor candidate may replace the persistent candidate
on its line, but it does not mutate the persistent candidate. Moving the cursor
away therefore restores the same persistent value byte-for-byte. Non-exact
runtime authority produces no annotation, occurrence, or navigation data.

A function return is anchored to the deepest executed `arrow`, `then`, or
`else` target whose captured outcome equals the activation outcome. Its value
appears on the final physical line of that target. If a function has no such
control-flow target, the latest completed value-producing expression with the
same outcome is the fallback. The whole function-context boundary is used only
when neither source occurrence exists.

The bottom timeline, floating cursor tooltip, pointer-owned activation preview,
variable-name colors, value boxes, and connector geometry are not part of this
model.

### 12.2 Optional richer compiler data

The occurrence-centric UX does not require the data below. If a later UX uses
these semantics, the data must come from the compiler/runtime artifact rather
than browser rules:

- ordered application stages with direct callee identity, consumed arguments,
  intermediate outcomes, and source-level saturation metadata;
- reach/outcome records for tail-position wrapper expressions plus the exact
  expression that completes an activation;
- static structural-boundary records for binding RHSs, match scrutinees,
  function entry and exit, writes, attachment selectors, and precedence depth;
- structured captured values with bounded children, collection sizes, explicit
  elision, and stable mutable/cyclic identity;
- pattern render trees with constructor, binder, wildcard, alias, and access
  path roles;
- mutation target identity, old values, and complete mutable-form coverage.

Until a field exists, the core presents only semantics directly supported by
normalized occurrences. It does not recover missing semantics by parsing source
text or matching display strings.

The IDE adapter performs only:

1. translate a DOM/CodeMirror event into one `Intent`;
2. call `transition` once;
3. execute returned effects;
4. atomically render `buildExecutionViewModel(state)`.

Async callbacks are forwarded as intents with their original request token.

## 13. CLI observability

The CLI imports the same builder, queries, reducer, and view-model builder as the
IDE. JSON is the exact oracle. Text output is deterministic and compact.

### 13.1 Validation

```sh
npm run audit:execution -- fib.ml.md --check
```

```text
evaluation e7  code 9b7d…  constructs 31  selectors 46
occurrences 118  activations 26  writes 0  terminal complete
invariants ok
```

Failures print stable code, entity type, entity ID, and detail, then exit
nonzero.

### 13.2 Position query

```sh
npm run audit:execution -- fib.ml.md --at 8:12 --activation a1
```

```text
8:12  selector c callee -> construct e  fib (n - 1)
reaches 1 4 7 a d
selected b  fib(5) -> 5  occurrence k
values 1/1  3 : int
active 12  inactive 3  global-unreached 2
```

`--json` prints the exact `CursorQuery`, `Selection`, paginated values,
projection, and UX oracle. Compact output adds one `L` record per effective
annotation line and one `A`/`V` pair per dynamic occurrence.

### 13.3 Exhaustive self-check and cursor atlas

```sh
npm run audit:execution -- fib.ml.md --atlas --lines 5:12
```

The self-check is a reusable module above the artifact, query, reducer, and
view-model layers. The CLI is only a renderer. It checks:

- every UTF-16 boundary independently against an empty baseline;
- forward and reverse cursor sweeps with retained recency;
- selector containment and query/selection agreement;
- focused occurrence, value index, and occurrence-list agreement;
- every activation choice that has an occurrence at the selected construct;
- every selectable occurrence navigation anchor and every activation target;
- active, inactive, and globally-unreached projection partitions;
- disjoint, canonically ordered coverage with semantically valid owners;
- one annotation-lane slot per physical line and cursor-value agreement;
- code edit, stale presentation, A→B→A restoration, artifact installation,
  and selection reconciliation.

Problems have a stable code, optional entity, source position, source line, and
caret. Text groups repeated failures and prints only a bounded witness sample.
JSON retains every witness.

The cursor atlas uses two aligned planes:

```text
8 |       else fib (n-1) + fib (n-2)·
Q | 222222oooo26665798a7343cccbdfegd-
H | AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA·
```

`Q` identifies the complete cursor state: selector, construct, activation,
focused occurrence, values, and exact coverage stencil. Its aliases are local
to each physical line so they remain one cell in normal source, and the legend
qualifies them as `line:alias`. `H` renders `A` for
active, `i` for inactive, `×` for globally never-run, and `·` for uncovered.
With `--at LINE:COLUMN`, `H` holds that one activation fixed across the whole
source slice. Without `--at`, each boundary uses the activation it selects.
`--lines FROM:TO` limits source and legends without weakening the global check.

### 13.4 User-visible UX matrix

```sh
npm run audit:execution -- fib.ml.md --ux-matrix --lines 5:12
```

The UX matrix is the compact observable contract above the view model. For
every UTF-16 cursor boundary, including the position after the final character,
it records exactly three IDs:

- `C`: effective values visible in the annotation column;
- `H`: source decorations, rendered as `E` for the selected expression, `S`
  for the selected invocation, `G` for greyed code, and `.` for unchanged code;
- `R`: the right-pane expression heading, calls, outcomes, selected call,
  selected expression value, repeat ordinal, or empty reason.

The ID dictionaries contain only those rendered facts. They omit compiler
IDs, activation IDs, source-map records, reducer decisions, recency, and other
internal state. `--lines FROM:TO` limits the mapped cursor lines while each
state retains the whole-document facts visible in the editor. JSON exposes the
same three tables for automated review.

The readable file representation is:

```sh
npm run audit:execution -- fib.ml.md --visual -o fib.audit.txt
```

It combines the C/H/R tuple into a line-local `V` identity. A source row ends
in a synthetic `·`, making the final cursor boundary visible, and its `V` row
has exactly source-length + 1 identities. Each distinct view is then rendered
with source and effective annotation, its E/S/G band immediately below the
source, a separate cursor-boundary row, and the exact right-pane rows. A view
shared by adjacent boundaries marks every boundary that selects it. Cursor
markers never enter the source string, so they cannot change alignment.

The upper-right view control cycles through Document, Source, and Debug. Debug
builds the same three tables from a fresh empty-selection, empty-recency reducer
baseline. Source clicks, arrow keys, and the three ID rails select any of the
line's `n+1` boundaries. Its main source plane renders the chosen `H` state and
annotation column; its inspector resolves the chosen C/H/R dictionary entries.
Choosing a dynamic row hands the selected activation or occurrence back to the
editable Document view.

### 13.5 Full diagnostic matrix

```sh
npm run audit:execution -- fib.ml.md --matrix
```

Every UTF-16 cursor boundary is represented, including EOL and empty lines.
Aliases are assigned deterministically: selectors and constructs by displayed
range then ID, activations and occurrences by entry sequence then ID, and sets
by their ordered member aliases. Width expands beyond base 62. The legend is
always printed.

Every boundary is evaluated independently against one frozen baseline
selection and recency state printed in the header. The default baseline has no
selection and empty recency; `--activation` seeds a frozen activation preference
in recency rather than constructing a partial, potentially invalid selection.
Scanning the matrix never updates recency, so output does not depend on scan
order.

```text
8 |     fib (n - 1) + fib (n - 2)·
S |     cccceeeeeeeooffffhhhhhhhii   selector alias
C |     aaaabbbbbbbbbccccdddddddde   construct alias
R |     22222222222222333333333330   reach-set alias
A |     7777777777777777777777777-   chosen activation
V |     rrrrrrrrrrrrrrmmmmmmmmmmmm-   value-set alias
P |     7777777777777777777777777-   projected activation alias
F |     2222222222222222222222222-   composed coverage alias
```

The `F` plane is produced by the same disjoint coverage compositor as the IDE,
not by an audit approximation. The diagnostic matrix is retained for cases
where the two-plane atlas identifies a problem but the individual selector,
construct, reach, value, projection, and coverage identities are needed.

Deterministic tables follow:

- selector table: alias, role, range, subject;
- construct table: alias, category, owner function, source excerpt;
- activation table: alias, dynamic parent, provenance, inputs, outcome;
- closure-provenance table: derived closure, source closure, and sequence;
- call-attempt table: owner, call occurrence, tail flag, ordered producers, and
  final outcome;
- write table: sequence, activation, construct, operation, target, old value,
  and new value;
- reach-set table: alias and ordered activation aliases;
- value-set table: alias, ordered occurrence, type, outcome, full/truncated flag;
- projection table: activation, active, inactive, and globally-unreached
  construct aliases;
- problem table: invariant code and IDs.

Coverage is exact in the tables. The planes are a visual index, not the only
oracle for overlapping constructs.

Audit JSON uses a versioned canonical schema. Maps, sets, opaque stores, and
indexes are serialized as arrays sorted by their documented semantic order and
then ID. Aliases are explicit fields, not object keys. The schema includes the
request/project/code/compiler identities, source-map digests and entries,
selector, construct, activation, occurrence, closure-provenance, call-attempt,
write, reach-set, value-set, projection, reducer-state, effect, decision, and
problem arrays. Golden tests compare this schema, never native JavaScript
`Map`/`Set` serialization, locale collation, or object property order.

### 13.6 Reducer/edit audit

The action script accepts either a JSON array or one reducer intent per JSON
Lines record. Edit offsets refer to the current draft before that action. A
`document-edited` intent may omit `source`; the auditor applies `change` to the
current source. The token alias `pending` resolves to the current request token,
and the artifact alias `initial` resolves to the initially collected artifact.
The expanded intent is included in JSON output.

```json
{"kind":"cursor-moved","position":{"path":"fib.ml.md","line":8,"column":12}}
{"kind":"document-edited","path":"fib.ml.md","change":{"from":91,"to":92,"insert":""}}
{"kind":"evaluation-failed","token":"pending","diagnostics":["syntax error"]}
```

Each step prints:

```text
 3 document-edited        document-code-updated  authority=stale evaluation=pending
   selection selector/construct/activation/occurrence
   effects lookup-artifact
   lane -
   occurrences 0
```

`--json` includes sources/digests, composed base changes, recency, pending token,
effects, and exact install/discard reason.

Scripts cover line shifts, selector deletion, activation disappearance,
repeated edits and undo, invalid→invalid→valid, A→B→A, out-of-order completion,
cancelled completion, validation failure after compiler success, cross-file
edits, ambiguous reconciliation, and duplicate-signature recursion.

## 14. Test layers

### Compiler/runtime contract

- one annotated typed-tree pass owns construct IDs and manifest emission;
- distinct same-range nodes retain distinct IDs;
- compiler byte offsets map correctly for Unicode, tabs, CRLF input, and EOL;
- both recursive calls in `fib` have distinct constructs and outcomes;
- partial application, overapplication, optional arguments, and deep tail
  recursion preserve activation and call-attempt semantics with constant stack;
- callback dynamic parent and closure origin are distinct, including delayed
  callbacks with no dynamic parent;
- nested tuple, constructor, record, alias, or-pattern, lambda, and `function`
  patterns emit exact successful subvalues before guards;
- unmatched patterns emit nothing and false guards retain pattern successes;
- mutation emits separate expression outcomes and writes;
- cross-module user code is traced while library implementation code is not;
- terminal complete/truncated checksums are validated and transport failure
  cannot install.

### Artifact/query/reducer

- every validation code has a malformed fixture;
- every cursor boundary resolves deterministically;
- selected activation reached selected construct or is null;
- focused occurrence belongs to selected activation and construct or is null;
- selected activation projection contains a reached selected construct;
- unexecuted selectors select the empty set;
- repeated values remain ordered within one activation;
- function constructs are reached by function occurrences and expose activation
  outcomes;
- call attempts and closure provenance remain queryable after normalization;
- write indexes are exhaustive and sequence ordered;
- pointer movement has no execution-state transition;
- callee/operator values equal application outcomes;
- pattern/binder values equal exact matched subvalues;
- draft creation shares the immutable artifact stores;
- inserted or changed code cannot inherit old selectors;
- stale, cancelled, wrong-revision, and invalid artifacts cannot install;
- valid recovery atomically clears matching stale state;
- reducer output is deterministic and deeply immutable;
- hot values paginate and cursor queries do not scan the trace.

### CLI golden corpus

Golden matrices and tables cover `Fib`, inference, higher-order and delayed
callbacks, repeated loop values, duplicate-signature recursion, unexecuted
selectors, partial/overapplication, nested patterns, mutation, exceptions,
truncation, cross-module calls, ghost/generated constructs, Unicode, tabs,
empty lines, CRLF input, EOL positions, malformed artifacts, and edit races.

### IDE wiring and layout

- one editor or DOM interaction dispatches one intent;
- pointer movement cannot dispatch an execution intent;
- async callbacks retain their request token;
- one reducer result causes one atomic render;
- pointerdown/click across DOM replacement dispatches one navigation intent;
- supplied view-model fixtures render stable annotations, occurrence rows,
  coverage, panes, and source scrolling.

Browser tests do not retest occurrence folding, selection, reconciliation, or
coverage semantics.

CI checks the module import graph: browser event/rendering modules may import
only the adapter and view-model interfaces, never artifact, query,
reconciliation, or reducer internals directly.

## 15. Module boundaries and performance budgets

New modules:

- `execution-digest.js`: browser-safe SHA-256 used by source and compiler identities;
- `execution-artifact.js`: validation, normalization input, immutable indexes;
- `execution-view.js`: source maps, draft projection, selector interval index;
- `execution-query.js`: cursor, selection, values, occurrence rows, projection;
- `execution-reconcile.js`: cross-revision keys and decisions;
- `execution-reducer.js`: all state transitions and effects;
- `execution-view-model.js`: pure IDE presentation data;
- `execution-audit.js`: JSON and compact CLI output;
- `execution-self-check.js`: exhaustive interaction checks, witnesses, and the
  two-plane cursor/highlight atlas;
- `execution-adapter.js`: browser intents, effects, and atomic rendering only.

Production targets on a normal demo artifact:

- cursor resolution and selection: under 1 ms, no trace scan;
- cached occurrence rows: under 1 ms, no trace scan;
- rendered occurrence data is cached by immutable view and construct; selection
  is represented once on the list rather than copied into every row;
- cached activation projection: under 1 ms;
- uncached projection: proportional to constructs owned by that function and
  occurrences in that activation, not the whole trace;
- coverage composition: `O(r log r)` for `r` activation ranges, then cached by
  immutable view and activation;
- reducer transitions without artifact install: under 2 ms;
- artifact construction: linear in manifest plus trace and off the interaction
  path;
- full matrix: batch indexed, with progress output for large files.

## 16. Migration sequence

1. Freeze new behavior in current execution modules.
2. Complete two review loops on this design.
3. Revert experimental range-ID implementation changes made before the design
   was reviewed.
4. Implement compiler typed-tree annotation, static manifest, runtime protocol,
   atomic envelope, and contract tests.
5. Implement the artifact builder and validation corpus.
6. Implement queries, reducer, reconciliation, and deterministic unit tests.
7. Implement CLI validation, position query, matrix/tables, and reducer scripts.
8. Run the complete CLI corpus and fix model errors before IDE integration.
9. Build the thin adapter and switch cursor, right pane, annotations, and
   coverage together.
10. Delete coordinate event matching, secondary local-value searches,
    provisional mutation of authoritative state, hover focus paths, and old
    state owners.
11. Run browser wiring/layout checks and final compiler, architecture,
    performance, and code review.

The migration is complete only when the old execution paths are deleted. The
new and old models may coexist only behind a development comparison command,
never as two production state owners.

## 17. Non-goals

- arbitrary heap reconstruction at every historical point;
- tracing OCaml library implementation details;
- keeping old trace payloads or frontend execution state working;
- guessing execution from source text without compiler data;
- using hover as a navigation mode;
- promising exact activation reconciliation across changed code when structural
  evidence is ambiguous.
