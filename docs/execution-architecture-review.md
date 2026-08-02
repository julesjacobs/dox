# Execution architecture review record

This record closes the design gate for
[`execution-architecture.md`](execution-architecture.md). The design was
reviewed independently from three directions: compiler/runtime correctness,
state architecture, and CLI/test observability. Each review was repeated after
the findings were incorporated.

## Review 3: implementation closeout

The closeout review found and corrected four boundary defects:

- the reducer and backend used different document-revision namespaces, so an
  initial A→B→A edit missed the cached A artifact;
- coverage composition filtered and sorted every range at every boundary;
- a nested anonymous function could consume the enclosing value binding's name
  selector;
- function outcomes retained their function type instead of their return type.

Document revision identity now belongs to the reducer, coverage uses a
deterministic sweep, direct function bindings alone receive name selectors, and
the compiler records return types on function outcomes. Artifact validation
also rejects ordinary occurrences whose compiler execution scope differs from
their activation, while explicitly allowing the function-entry and synthetic
`function`-argument boundary records.

The final architecture pass additionally replaced separator-based revision
framing with a collision-free structured encoding, moved captured-value
completeness into the runtime renderer, indexed runtime function and closure
lookups, counted closure creation as reach in its owner activation, and made
registry exhaustion truncate the artifact. Validation now closes semantic-kind,
selector-role, cross-unit, activation/closure, parameter-parent, and write-scope
relations before an artifact can be installed.

The remaining structured-value, saturation, structural-boundary, and complete
mutation fields are contract extensions, not browser heuristics. They remain
listed in section 12.2 of the architecture and in `todo.md`.

## Review 1: compiler and runtime

The first draft incorrectly left room for source coordinates to become runtime
identity. It also underspecified partial application, overapplication, tail
calls, callbacks, mutation, and transport completion.

The reviewed design now requires:

- one typed-tree traversal to assign construct IDs and emit the static manifest;
- runtime observations to carry those IDs directly;
- explicit activation, occurrence, closure, call-attempt, and write records;
- dynamic call parentage to remain distinct from closure provenance;
- VM-side completion for tail-call attempts;
- one terminal, checksummed artifact rather than independently installable
  static and dynamic payloads.

Final result: no remaining priority 0 or priority 1 finding.

## Review 2: state architecture

The first draft did not fully define authority while editing, cache recovery,
or which interaction owned focus. That would have allowed the same split-brain
state that caused the current implementation to become unstable.

The reviewed design now requires:

- one immutable execution snapshot;
- one selection tuple and one pure reducer;
- cursor position to be the only source-position input to execution state;
- code-changing drafts to have no authoritative stale values or coverage;
- exact request tokens and install/discard rules for every asynchronous result;
- deterministic reconciliation and A→B→A cache recovery;
- the browser to import only the adapter and view-model boundary.

Final result: no remaining priority 0 or priority 1 finding.

## Review 3: CLI and tests

The first draft had useful cursor planes but did not define a canonical oracle,
scan-order independence, reducer scripts, or enough tables to diagnose
ambiguous output.

The reviewed design now requires:

- versioned canonical audit JSON as the test oracle;
- compact selector, construct, reach-set, activation, and value planes;
- deterministic aliases and complete entity tables;
- independent evaluation of every UTF-16 cursor boundary against a frozen
  baseline;
- a JSON Lines reducer/edit DSL with expanded intents and decisions;
- compiler/runtime, snapshot, query, reducer, reconciliation, CLI golden,
  property, performance, and browser-boundary test layers.

Final result: no remaining priority 0 or priority 1 finding.

## Implementation gate

The implementation order is fixed:

1. compiler identity, static manifest, runtime protocol, and atomic envelope;
2. immutable snapshot and queries;
3. canonical CLI audits and golden corpus;
4. pure reducer, reconciliation, and reducer audits;
5. thin IDE adapter and view model;
6. deletion of the old execution state paths;
7. final compiler, architecture, test, performance, and interaction review.

No IDE execution interaction should be added directly before its operation is
available through the shared core and CLI.
