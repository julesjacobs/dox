# Execution interaction acceptance checklist

An item is checked only after implementation, automated coverage, and live browser verification.

`ux.md` and the occurrence-centric section here are authoritative. Superseded
tooltip, connector, timeline, and pointer-preview checklists have been removed.

## Occurrence-centric UX replacement

- [x] Keep execution state behind the immutable artifact/query/reducer/view-model boundary.
- [x] Expose exact focused-occurrence values and preserve repeated occurrences within one activation.
- [x] Build a pure occurrence list with separate activation and occurrence targets.
- [x] Build one deterministic annotation slot per physical source line.
- [x] Make cursor annotations override and restore persistent annotations without mutating them.
- [x] Remove the bottom timeline, cursor tooltip, variable boxes, dynamic variable colors, and connector runtime from the active editor path.
- [x] Expose the UX oracle through the position and reducer CLI audits.
- [x] Audit all n+1 UTF-16 cursor boundaries as visible C/H/R state IDs with exact E/S/G source bands.
- [x] Expose the same audit projection in the Document → Source → Debug browser view.
- [x] Write a readable visual audit file with n+1 view overviews and interspersed source, highlight, and cursor rows.
- [x] Include the document revision in request ownership and restart a pending request after prose edits.
- [x] Verify recursive navigation and edit recovery in the browser, plus higher-order, pattern, mutation, and exception paths through the production CLI/IDE core.

## Optional richer compiler data

These are not required by the occurrence-centric UX. If a later UX uses them,
they must be compiler-owned rather than inferred in the browser.

- [ ] Emit exact return-expression anchors instead of the current compiler-owned function-context anchor.
- [ ] Emit application saturation stages and direct callees.
- [ ] Emit structured values and compiler-owned pattern render plans.

## Ground-up execution replacement

This replaces the execution paths covered by the older acceptance checklist
below. The architecture and review record live in `docs/`.

- [x] Complete compiler/runtime, state-architecture, and CLI/testability design reviews.
- [x] Assign opaque construct IDs in the exact typed tree used by translation.
- [x] Carry construct IDs directly into runtime observations.
- [x] Emit compiler-owned containment and execution-scope ownership.
- [x] Emit generic, binder, callee, and operator selectors from the annotated typed tree.
- [x] Validate the real compiler/runtime seam with a compact deterministic CLI report.
- [x] Complete the atomic immutable snapshot and validate it before publication.
- [x] Complete indexed cursor, selection, value, inspection, navigation, and projection queries.
- [x] Normalize raw execution into explicit activations, occurrences, call attempts, closures, writes, and a terminal envelope.
- [x] Emit compiler token selectors and source maps for control-flow keywords, nested patterns, calls, operators, and inline expressions.
- [x] Add canonical snapshot/query/reducer JSON and compact matrix/table CLI audits.
- [x] Add exhaustive cursor sweeps, navigation round trips, edit recovery,
      grouped source witnesses, and a compact two-plane cursor/highlight atlas.
- [x] Replace heuristic tail-outcome matching with explicit runtime handoff/link relations.
- [x] Separate dependency artifact identity from the server project-version concurrency token and verify live A → B → A reuse.
- [x] Use a language-neutral canonical checksum that survives JSON transport and multi-file artifacts.
- [x] Implement the one-owner pure reducer, edit authority, request tokens, and reconciliation.
- [x] Build the IDE only through the new adapter and view model.
- [x] Delete the old coordinate matching and execution state owners.
- [x] Complete final compiler, architecture, interaction, performance, and browser review.
