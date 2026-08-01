# Execution interaction acceptance checklist

An item is checked only after implementation, automated coverage, and live browser verification.

## Tooltip behavior

- [x] Keep the cursor tooltip DOM stable while the cursor moves so it does not disappear and re-enter.
- [x] Hide the cursor tooltip after mouse activity and show it again only after keyboard cursor navigation.
- [x] Keep pointer hover smooth, highlight the exact compiler expression, and avoid pointer/cursor tooltip overlap.
- [x] Add a subtle visual connector from each cursor or pointer tooltip to its source expression.
- [x] Use available horizontal space before summarizing values in tooltips.
- [x] Show the value bound by a pattern variable, not the enclosing pattern or branch value.

## Activation behavior

- [x] Preview the activation that a pointer click would select without mutating the committed activation.
- [x] Restore the exact committed activation when pointer preview ends.
- [x] Record activation recency by dynamic identity and by input/output signature.
- [x] Prefer the most recently viewed matching activation for cursor, pointer, and recomputed traces.
- [x] Preserve activation preference across valid edits when input/output values still match.
- [x] Keep activations usable while source is invalid and replace them with authoritative data after recovery.

## Compiler-owned selection

- [x] Make `if` select the conditional and `then`/`else` select their branch executions.
- [x] Make `match`/`with` select the match and `|`/`->` select their specific case execution.
- [x] Make function, let, guard, and loop keywords select their compiler construct or body.
- [x] Let commas, parentheses, and other expression punctuation inherit the smallest containing compiler expression.
- [x] Verify nested call punctuation such as `Node (insert value left, current, right)` selects an activation.

## Activation values

- [x] Replace repeated binder names with compact value bubbles connected to their source binders.
- [x] Place multiple binder values without overlap and reuse free code lines when useful.
- [x] Keep return values visually distinct from binder values.
- [x] Remove redundant activation-variable content from the right pane.

## Recovery and sizing

- [x] Retry compiler execution-site indexing automatically after temporary invalid source.
- [x] Never leave valid recovered source at “Could not read code · retry”.
- [x] Use the available width in execution choices before abbreviating inputs, outputs, or expressions.
- [x] Summarize only genuinely large values, while retaining the complete value for accessibility.

## Final verification

- [x] All frontend tests pass.
- [x] All OCaml tests pass.
- [x] Live pointer, cursor, edit/recovery, pattern, branch, and punctuation scenarios pass.
- [x] Code and interaction review finds no remaining state-owner conflicts in these paths.

## Annotation layout and routing plan

The annotation layer must not reflow the document. It may use any free horizontal
space and nearby visual rows, but labels and connectors must not cover source text.

### Measured geometry

- [ ] Measure each binder, each code line's actual text edge, each value label, and
      the usable annotation field between the document and context pane.
- [ ] Remove the fixed annotation-rail start and derive each row's usable interval
      from its text edge plus a consistent gap.
- [ ] Recompute geometry once per animation frame after activation, viewport,
      editor scroll, font, or pane-width changes.
- [ ] Cache layouts by activation and viewport geometry so unchanged labels do not
      jump when the cursor or pointer moves.

### Label placement

- [ ] Place a label on its source row first when its measured width fits.
- [ ] Pack several labels on one row when they fit, preserving binder order.
- [ ] Otherwise use the nearest free visual row inside the activation without
      inserting document lines or covering that row's text.
- [ ] Prefer a little vertical displacement over horizontal overflow, and use
      horizontal overflow only when the measured content genuinely needs it.
- [ ] Keep return values in a distinct placement class so they cannot displace or
      be mistaken for binder values.
- [ ] Summarize semantically large values, but never clip an ordinary value merely
      because the old fixed rail was narrow.

### Connector routing

- [ ] Route connectors through whitespace corridors between code lines, then
      through reserved vertical lanes beyond the furthest text edge.
- [ ] Use rounded orthogonal paths instead of direct curves that can cross source
      text.
- [ ] Allocate lanes in binder and label order, with minimum separation, so paths
      do not cross, merge, or become visually ambiguous.
- [ ] Keep connectors quiet by default and strengthen only the exact binder,
      label, and path as one hover target.

### Automated and visual verification

- [ ] Extract placement and routing into a pure geometry module.
- [ ] Assert that labels never overlap labels or source text.
- [ ] Assert that connectors never intersect source-text exclusion rectangles and
      ordered connectors never cross.
- [ ] Assert deterministic output and stable placement under a one-pixel resize.
- [ ] Cover multi-binder patterns, several values on one line, long inference
      values, returns, narrow panes, font scaling, and horizontal scrolling.
- [ ] Verify normal, narrow, and wide pane layouts live while resizing the panes.
