import {
  snapshotActivation,
  snapshotActivations,
  snapshotActivationIdsForConstruct,
  snapshotConstruct,
  snapshotConstructIdsForScope,
  snapshotExecutedConstructIds,
  snapshotOccurrence,
  snapshotOccurrenceIdsForActivationConstruct,
  snapshotOccurrences,
  sealExecutionEnvelope,
  snapshotTerminal,
} from "./execution-artifact.js";
import {
  navigateActivation,
  occurrenceRowsForConstruct,
  projectActivation,
  resolveCursor,
  selectOccurrence,
  valuesAt,
} from "./execution-query.js";
import { transition } from "./execution-reducer.js";
import {
  executionViewOffset,
  executionViewPositionAtOffset,
  executionViewProjectedSelector,
  executionViewProjectedSelectors,
  executionViewSelectionRange,
  executionViewSelectorContainsOffset,
  executionViewSelectorContainsPosition,
  executionViewSelectorSurface,
  executionViewSelectorAt,
  executionViewSelectorsForConstruct,
  executionViewSnapshot,
  executionViewSourceText,
} from "./execution-view.js";
import { buildExecutionViewModel } from "./execution-view-model.js";

const aliasAlphabet =
  "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
const executionUxGeometryCache = new WeakMap();
const executionUxVisibleCache = new WeakMap();

function compareText(left, right) {
  const leftText = String(left ?? "");
  const rightText = String(right ?? "");
  return leftText < rightText ? -1 : leftText > rightText ? 1 : 0;
}

function aliasWidth(count) {
  let width = 1;
  let capacity = aliasAlphabet.length;
  while (count > capacity) {
    width += 1;
    capacity *= aliasAlphabet.length;
  }
  return width;
}

function aliasAt(index, width) {
  let value = index;
  let alias = "";
  for (let place = 0; place < width; place += 1) {
    alias = aliasAlphabet[value % aliasAlphabet.length] + alias;
    value = Math.floor(value / aliasAlphabet.length);
  }
  return alias;
}

function aliasesFor(keys, { sort = true } = {}) {
  const ordered = [...new Set(keys.filter(Boolean))];
  if (sort) ordered.sort(compareText);
  const width = aliasWidth(ordered.length);
  return Object.freeze({
    width,
    ordered: Object.freeze(ordered),
    byKey: new Map(ordered.map((key, index) => [key, aliasAt(index, width)])),
  });
}

function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function outcomeText(outcome) {
  return outcome?.value?.display ?? outcome?.kind ?? "-";
}

function selectionKey(point) {
  if (!point.query.selectorId) return "";
  return JSON.stringify([
    point.query.status,
    point.query.selectorId,
    point.selection.activationId,
    point.selection.focusedOccurrenceId,
    point.values.map((value) => [
      value.occurrenceId,
      value.outcome?.kind,
      value.outcome?.value?.type,
      value.outcome?.value?.display,
      value.outcome?.value?.complete,
    ]),
    point.model.coverage.map((item) => [
      item.state,
      item.constructId,
      item.range.path,
      item.range.start,
      item.range.end,
    ]),
  ]);
}

function coverageAt(coverage, path, offset) {
  return coverage.filter(
    (item) =>
      item.range.path === path &&
      item.range.start <= offset &&
      offset < item.range.end,
  );
}

function selectorSurfaceCovers(surface, item) {
  let cursor = item.range.start;
  for (const segment of surface) {
    if (
      segment.subjectId !== item.constructId ||
      segment.range.path !== item.range.path ||
      segment.range.end <= cursor
    ) {
      continue;
    }
    if (segment.range.start > cursor) return false;
    cursor = Math.max(cursor, segment.range.end);
    if (cursor >= item.range.end) return true;
  }
  return false;
}

function summarizeModel(model) {
  return {
    selection: model.selection,
    cursorInspection: model.cursorInspection,
    occurrenceCount: model.occurrenceList.count,
    coverage: model.coverage,
    annotationPlan: model.projection?.annotationPlan || [],
  };
}

function sourceWitness(lines, position) {
  if (!position) return null;
  const source = lines[position.line - 1] ?? "";
  return Object.freeze({
    line: position.line,
    column: position.column,
    source,
  });
}

/**
 * Exhaustively exercise every UTF-16 cursor boundary and every dynamic
 * navigation target through the same query, reducer, and view-model code used
 * by the IDE. Problems carry small source witnesses for CLI rendering.
 */
export function buildExecutionSelfCheck({
  view,
  initialState,
  path,
  source,
  envelope = null,
}) {
  const snapshot = executionViewSnapshot(view);
  if (!snapshot) throw new TypeError("Execution self-check requires a snapshot");
  const lines = String(source).split("\n");
  const problems = [];
  const seenProblem = new Set();
  const addProblem = (code, { position = null, entityId = null, detail = "" } = {}) => {
    const key = JSON.stringify([code, position?.line, position?.column, entityId, detail]);
    if (seenProblem.has(key)) return;
    seenProblem.add(key);
    problems.push(
      Object.freeze({
        code,
        position: position ? Object.freeze({ ...position }) : null,
        entityId,
        detail,
        witness: sourceWitness(lines, position),
      }),
    );
  };

  const points = lines.map((line, lineIndex) =>
    Array.from({ length: line.length + 1 }, (_, column) => {
      const position = { path, line: lineIndex + 1, column };
      const query = resolveCursor(view, position);
      const result = transition(initialState, { kind: "cursor-moved", position });
      const model = buildExecutionViewModel(result.state);
      const selection = model.selection;
      const values = valuesAt(view, selection, { offset: 0, limit: 100_000 });
      const offset = executionViewOffset(view, position);
      const coverage = coverageAt(model.coverage, path, offset);
      return Object.freeze({
        position: Object.freeze(position),
        offset,
        query,
        selection,
        values: values.values,
        valueTotal: values.total,
        model,
        coverage,
        state: result.state,
      });
    }),
  );
  const flatPoints = points.flat();
  const rangeKey = (range) =>
    range ? `${range.path}\u001f${range.start}\u001f${range.end}` : "";
  const armArrowRanges = new Set(
    executionViewProjectedSelectors(view)
      .filter((selector) => selector.role === "arrow" && selector.valid !== false)
      .map((selector) => rangeKey(selector.range)),
  );

  for (const point of flatPoints) {
    const { position, query, selection, model, offset } = point;
    const selector = selection.selectorId
      ? executionViewProjectedSelector(view, selection.selectorId)
      : null;
    const functionContext = selector?.role === "function-context";
    const completionAffinity = Boolean(
      selector &&
      !executionViewSelectorContainsOffset(selector, offset) &&
      executionViewSelectorContainsPosition(view, selector, position),
    );
    const selectionCoverage = completionAffinity
      ? coverageAt(model.coverage, path, Math.max(selector.range.start, selector.range.end - 1))
      : point.coverage;
    const sourceLine = lines[position.line - 1] || "";
    const codeEndColumn = sourceLine.trimEnd().length;
    if (position.column === codeEndColumn && codeEndColumn > 0) {
      const leftPoint = points[position.line - 1][codeEndColumn - 1];
      const leftSelector = leftPoint?.query.selectorId
        ? executionViewProjectedSelector(view, leftPoint.query.selectorId)
        : null;
      const continuesPastLine = Boolean(
        leftSelector && leftSelector.range.end > offset,
      );
      const completesArmBoundary = Boolean(
        leftSelector?.role === "arrow" || leftSelector?.role === "alternative",
      );
      if (
        (continuesPastLine || completesArmBoundary) &&
        query.selectorId !== leftPoint.query.selectorId
      ) {
        addProblem("line-end-drops-active-structure", {
          position,
          entityId: query.selectorId,
          detail: `${leftPoint.query.selectorId || "-"} -> ${query.selectorId || "-"}`,
        });
      }
    }
    if (query.selectorId !== selection.selectorId) {
      addProblem("query-selection-selector-disagree", { position });
    }
    if (query.constructId !== selection.constructId) {
      addProblem("query-selection-construct-disagree", { position });
    }
    if (
      selector &&
      !(selector.range.path === path &&
        executionViewSelectorContainsPosition(view, selector, position))
    ) {
      addProblem("selected-range-misses-cursor", {
        position,
        entityId: selector.id,
        detail: `${selector.range.start}-${selector.range.end}`,
      });
    }
    if (query.status === "reached") {
      if (!selection.activationId) {
        addProblem("reached-without-activation", { position });
      } else if (!query.activationIds.includes(selection.activationId)) {
        addProblem("selected-activation-not-reachable", {
          position,
          entityId: selection.activationId,
        });
      }
      if (
        !functionContext &&
        !selectionCoverage.some((item) => item.state === "active")
      ) {
        addProblem("selected-activation-misses-cursor", { position });
      }
      if (
        !functionContext &&
        selectionCoverage.some((item) => item.state === "globally-unreached")
      ) {
        addProblem("reached-but-globally-unreached", { position });
      }
    } else if (selection.activationId || selection.focusedOccurrenceId) {
      addProblem("non-reached-retains-dynamic-selection", { position });
    }
    if (
      !functionContext &&
      query.status === "unreached" &&
      !selectionCoverage.some((item) => item.state === "globally-unreached")
    ) {
      addProblem("unreached-without-global-fade", { position });
    }
    if (query.status === "unknown" && point.coverage.length) {
      addProblem("unknown-execution-has-definitive-coverage", { position });
    }
    if (selection.focusedOccurrenceId) {
      const occurrence = snapshotOccurrence(snapshot, selection.focusedOccurrenceId);
      if (!occurrence) {
        addProblem("focused-occurrence-missing", {
          position,
          entityId: selection.focusedOccurrenceId,
        });
      } else if (
        occurrence.activationId !== selection.activationId ||
        occurrence.constructId !== selection.constructId
      ) {
        addProblem("focused-occurrence-selection-disagree", {
          position,
          entityId: occurrence.id,
        });
      }
    }
    const expectedValueIds = selection.activationId && selection.constructId
      ? valuesAt(view, selection, { limit: Number.MAX_SAFE_INTEGER }).values.map(
          (value) => value.occurrenceId,
        )
      : [];
    if (
      point.valueTotal !== expectedValueIds.length ||
      !same(point.values.map((value) => value.occurrenceId), expectedValueIds)
    ) {
      addProblem("value-index-disagrees-with-selection", { position });
    }
    const expectedRows = selection.constructId
      ? occurrenceRowsForConstruct(view, selection.constructId)
      : [];
    if (model.occurrenceList.count !== expectedRows.length) {
      addProblem("occurrence-list-count-disagrees", { position });
    }
    if (
      selection.constructId &&
      !same(
        model.occurrenceList.rows.map((row) => row.occurrenceId),
        expectedRows.map((row) => row.occurrence.id),
      )
    ) {
      addProblem("occurrence-list-order-disagrees", { position });
    }
    if (
      selection.focusedOccurrenceId &&
      !model.occurrenceList.rows.some(
        (row) => row.occurrenceId === selection.focusedOccurrenceId,
      )
    ) {
      addProblem("occurrence-list-misses-focus", { position });
    }
    if (
      selector &&
      !same(
        model.cursorInspection?.range,
        executionViewSelectionRange(view, selector),
      )
    ) {
      addProblem("cursor-inspection-range-disagrees", { position });
    }
    const orderedCoverage = [...model.coverage].sort(
      (left, right) =>
        compareText(left.range.path, right.range.path) ||
        left.range.start - right.range.start ||
        left.range.end - right.range.end,
    );
    if (!same(orderedCoverage, model.coverage)) {
      addProblem("coverage-not-canonical", { position });
    }
    for (let index = 1; index < orderedCoverage.length; index += 1) {
      const previous = orderedCoverage[index - 1];
      const current = orderedCoverage[index];
      if (
        previous.range.path === current.range.path &&
        previous.range.end > current.range.start
      ) {
        addProblem("coverage-overlap", { position });
        break;
      }
    }
    const lane = model.projection?.annotationPlan || [];
    if (new Set(lane.map((slot) => slot.line)).size !== lane.length) {
      addProblem("annotation-lane-duplicates-line", { position });
    }
    for (const slot of lane) {
      if (
        (slot.persistent?.kind === "match" ||
          slot.persistent?.kind === "match-and-exit") &&
        !armArrowRanges.has(rangeKey(slot.persistent.range))
      ) {
        addProblem("match-annotation-not-on-arm-arrow", {
          position,
          entityId: slot.persistent.constructId,
          detail: `${slot.persistent.range?.start ?? "-"}-${slot.persistent.range?.end ?? "-"}`,
        });
      }
    }
    const cursorSlot = lane.find((slot) => slot.cursor);
    if (
      cursorSlot &&
      cursorSlot.cursor.occurrenceId !== selection.focusedOccurrenceId
    ) {
      addProblem("annotation-cursor-disagrees-with-focus", { position });
    }
    const projection = projectActivation(view, selection);
    const selectorSurface = executionViewSelectorSurface(view);
    for (const item of model.coverage) {
      if (
        item.state === "globally-unreached" &&
        snapshotActivationIdsForConstruct(snapshot, item.constructId).length
      ) {
        addProblem("coverage-global-owner-is-reached", {
          position,
          entityId: item.constructId,
        });
      }
      if (
        item.state === "globally-unreached" &&
        !selectorSurfaceCovers(selectorSurface, item)
      ) {
        addProblem("coverage-global-owner-not-visible", {
          position,
          entityId: item.constructId,
        });
      }
      if (
        item.state === "active" &&
        !projection?.activeConstructIds?.includes(item.constructId)
      ) {
        addProblem("coverage-active-owner-not-in-projection", {
          position,
          entityId: item.constructId,
        });
      }
      if (
        item.state === "inactive" &&
        !projection?.inactiveConstructIds?.includes(item.constructId)
      ) {
        addProblem("coverage-inactive-owner-not-in-projection", {
          position,
          entityId: item.constructId,
        });
      }
    }
  }

  const representativeBySelector = new Map();
  for (const point of flatPoints) {
    const key = point.query.selectorId || "<none>";
    if (!representativeBySelector.has(key)) representativeBySelector.set(key, point);
  }
  let reducerIdempotenceChecks = 0;
  let activationChoiceChecks = 0;
  for (const point of representativeBySelector.values()) {
    const repeated = transition(point.state, {
      kind: "cursor-moved",
      position: point.position,
    });
    reducerIdempotenceChecks += 1;
    if (!same(summarizeModel(buildExecutionViewModel(repeated.state)), summarizeModel(point.model))) {
      addProblem("cursor-transition-not-idempotent", { position: point.position });
    }
    for (const activationId of point.query.activationIds) {
      if (
        !snapshotOccurrenceIdsForActivationConstruct(
          snapshot,
          activationId,
          point.query.constructId,
        ).length
      ) {
        continue;
      }
      const chosen = transition(point.state, {
        kind: "activation-chosen",
        activationId,
      });
      activationChoiceChecks += 1;
      if (
        chosen.decision !== "activation-selected" ||
        chosen.state.selection.activationId !== activationId ||
        chosen.state.selection.constructId !== point.query.constructId
      ) {
        addProblem("activation-choice-roundtrip-failed", {
          position: point.position,
          entityId: activationId,
          detail: chosen.decision,
        });
        continue;
      }
      const chosenModel = buildExecutionViewModel(chosen.state);
      const pointSelector = executionViewProjectedSelector(
        view,
        point.query.selectorId,
      );
      const activeAtCursor = coverageAt(
        chosenModel.coverage,
        path,
        pointSelector &&
          !executionViewSelectorContainsOffset(pointSelector, point.offset)
          ? Math.max(pointSelector.range.start, pointSelector.range.end - 1)
          : point.offset,
      );
      if (
        pointSelector?.role !== "function-context" &&
        !activeAtCursor.some((item) => item.state === "active")
      ) {
        addProblem("chosen-activation-misses-cursor", {
          position: point.position,
          entityId: activationId,
        });
      }
    }
  }

  let occurrenceNavigationChecks = 0;
  const selectableConstructIds = new Set(
    flatPoints.map((point) => point.query.constructId).filter(Boolean),
  );
  for (const occurrence of snapshotOccurrences(snapshot)) {
    if (!selectableConstructIds.has(occurrence.constructId)) continue;
    const selected = selectOccurrence(view, occurrence.id);
    if (!selected.moveCursorTo) continue;
    occurrenceNavigationChecks += 1;
    if (
      !selected.accepted ||
      selected.selection.occurrenceId ||
      selected.selection.focusedOccurrenceId !== occurrence.id ||
      selected.selection.activationId !== occurrence.activationId ||
      selected.selection.constructId !== occurrence.constructId
    ) {
      addProblem("occurrence-navigation-selection-disagrees", {
        entityId: occurrence.id,
      });
      continue;
    }
    const position = selected.cursorAnchor;
    const resolved = position && executionViewSelectorAt(view, position);
    if (!resolved || resolved.subjectId !== occurrence.constructId) {
      addProblem("occurrence-navigation-cursor-disagrees", {
        position,
        entityId: occurrence.id,
        detail: resolved?.subjectId || "no selector",
      });
    }
  }

  let activationNavigationChecks = 0;
  for (const activation of snapshotActivations(snapshot)) {
    const navigated = navigateActivation(view, activation.id);
    if (!navigated.moveCursorTo) continue;
    activationNavigationChecks += 1;
    if (!navigated.accepted || navigated.selection.activationId !== activation.id) {
      addProblem("activation-navigation-selection-disagrees", {
        entityId: activation.id,
        detail: navigated.decision,
      });
    }
  }

  let projectionChecks = 0;
  for (const activation of snapshotActivations(snapshot)) {
    const projection = projectActivation(view, {
      selectorId: null,
      constructId: activation.functionConstructId,
      activationId: activation.id,
      focusedOccurrenceId: activation.functionOccurrenceId,
    });
    if (!projection) {
      addProblem("activation-projection-missing", { entityId: activation.id });
      continue;
    }
    projectionChecks += 1;
    const owned = new Set(snapshotConstructIdsForScope(snapshot, activation.scopeId));
    const active = new Set(projection.activeConstructIds);
    const inactive = new Set(projection.inactiveConstructIds);
    const global = new Set(projection.globallyUnreachedConstructIds);
    const union = new Set([...active, ...inactive, ...global]);
    const expected = new Set(owned);
    if (activation.functionConstructId) expected.add(activation.functionConstructId);
    if (
      [...active].some((id) => inactive.has(id) || global.has(id)) ||
      [...inactive].some((id) => global.has(id))
    ) {
      addProblem("projection-sets-overlap", { entityId: activation.id });
    }
    const missing = [...expected].filter((id) => !union.has(id));
    const extra = [...union].filter((id) => !expected.has(id));
    if (
      extra.length ||
      (snapshotTerminal(snapshot).kind === "complete" && missing.length)
    ) {
      addProblem("projection-does-not-partition-scope", {
        entityId: activation.id,
        detail: `missing=${missing.join(",") || "-"} extra=${extra.join(",") || "-"}`,
      });
    }
    for (const constructId of global) {
      if (snapshotActivationIdsForConstruct(snapshot, constructId).length) {
        addProblem("projection-global-set-contains-reached", {
          entityId: activation.id,
          detail: constructId,
        });
      }
    }
    const executed = new Set(snapshotExecutedConstructIds(snapshot, activation.id));
    for (const constructId of executed) {
      if (owned.has(constructId) && !active.has(constructId)) {
        addProblem("projection-active-set-misses-executed", {
          entityId: activation.id,
          detail: constructId,
        });
      }
    }
  }

  let sequentialCursorChecks = 0;
  const sweep = (name, orderedPoints) => {
    let state = initialState;
    for (const point of orderedPoints) {
      const moved = transition(state, {
        kind: "cursor-moved",
        position: point.position,
      });
      state = moved.state;
      sequentialCursorChecks += 1;
      const selection = state.selection;
      if (
        point.query.status === "reached" &&
        !point.query.activationIds.includes(selection.activationId)
      ) {
        addProblem(`${name}-sweep-selects-unreachable-activation`, {
          position: point.position,
          entityId: selection.activationId,
        });
      }
      if (
        point.query.status !== "reached" &&
        (selection.activationId || selection.focusedOccurrenceId)
      ) {
        addProblem(`${name}-sweep-retains-dynamic-selection`, {
          position: point.position,
        });
      }
      if (point.query.status === "reached") {
        const model = buildExecutionViewModel(state);
        const pointSelector = executionViewProjectedSelector(
          view,
          point.query.selectorId,
        );
        const focusOffset =
          pointSelector &&
          !executionViewSelectorContainsOffset(pointSelector, point.offset)
            ? Math.max(pointSelector.range.start, pointSelector.range.end - 1)
            : point.offset;
        if (
          pointSelector?.role !== "function-context" &&
          !coverageAt(model.coverage, path, focusOffset).some(
            (item) => item.state === "active",
          )
        ) {
          addProblem(`${name}-sweep-focus-misses-cursor`, {
            position: point.position,
          });
        }
      }
    }
  };
  sweep("forward", flatPoints);
  sweep("reverse", [...flatPoints].reverse());

  let editRecoveryChecks = 0;
  const basePoint = flatPoints.find(
    (point) => point.query.status === "reached" && point.selection.activationId,
  );
  const baseSelector = basePoint
    ? executionViewProjectedSelector(view, basePoint.query.selectorId)
    : null;
  if (envelope && basePoint && baseSelector) {
    // Edit an exact compiler-owned selector surface.  This exercises the same
    // stale/reinstall path for indented blocks, fenced blocks, and inline
    // expressions without maintaining a third executable Markdown parser.
    const editOffset = baseSelector.range.start;
    const probeText = "x";
    const editedSource =
      source.slice(0, editOffset) + probeText + source.slice(editOffset);
    const edited = transition(basePoint.state, {
        kind: "document-edited",
        path,
        source: editedSource,
        change: { from: editOffset, to: editOffset, insert: probeText },
    });
    editRecoveryChecks += 1;
    if (
        edited.decision !== "document-code-updated" ||
        edited.state.view.runtimeAuthority !== "stale" ||
        edited.state.evaluation.kind !== "pending"
    ) {
      addProblem("edit-does-not-enter-stale-pending-state", {
          position: basePoint.position,
          detail: edited.decision,
      });
    } else {
      const restoredDraft = transition(edited.state, {
          kind: "document-edited",
          path,
          source,
          change: {
            from: editOffset,
            to: editOffset + probeText.length,
            insert: "",
          },
      });
      editRecoveryChecks += 1;
      const token = restoredDraft.state.evaluation.token;
      const echoedEnvelope = sealExecutionEnvelope({
          ...envelope,
          requestCodeDigest: token?.requestCodeDigest,
          projectDigest: token?.projectDigest,
          compilerInputsDigest: token?.compilerInputsDigest,
          sourceMaps: {
            ...envelope.sourceMaps,
            // Editor sources are LF-normalized after their first change.  The
            // compiler ranges and projected editor offsets are unchanged, but
            // the response must carry the pending request's document identity.
            documentRevisionId: token?.documentRevisionId,
          },
      });
      const restored = token
        ? transition(restoredDraft.state, {
              kind: "artifact-available",
              token,
              artifact: echoedEnvelope,
          })
        : null;
      editRecoveryChecks += 1;
      if (
          restoredDraft.decision !== "document-code-updated" ||
          !restored ||
          restored.problems.length ||
          restored.state.view.runtimeAuthority !== "exact" ||
          restored.state.evaluation.kind !== "idle"
      ) {
        addProblem("edit-recovery-does-not-restore-exact-artifact", {
            position: basePoint.position,
            detail: `${restoredDraft.decision}/${restored?.decision || "no token"}${restored?.problems?.length ? `:${restored.problems.map((problem) => problem.code).join(",")}` : ""}`,
        });
      } else if (
          restored.state.selection.constructId !==
            basePoint.selection.constructId ||
          restored.state.selection.activationId !==
            basePoint.selection.activationId
      ) {
        addProblem("edit-recovery-loses-selection", {
            position: basePoint.position,
        });
      }
    }
  }

  const focusAliases = aliasesFor(flatPoints.map(selectionKey));
  const focusExampleByKey = new Map();
  for (const point of flatPoints) {
    const key = selectionKey(point);
    if (key && !focusExampleByKey.has(key)) focusExampleByKey.set(key, point);
  }
  const activationAliases = aliasesFor(
    snapshotActivations(snapshot).map((activation) => activation.id),
  );
  const counts = Object.freeze({
    boundaries: flatPoints.length,
    selectorStates: representativeBySelector.size,
    reducerIdempotence: reducerIdempotenceChecks,
    activationChoices: activationChoiceChecks,
    occurrenceNavigation: occurrenceNavigationChecks,
    activationNavigation: activationNavigationChecks,
    projections: projectionChecks,
    sequentialCursor: sequentialCursorChecks,
    editRecovery: editRecoveryChecks,
  });
  return Object.freeze({
    schemaVersion: 1,
    ok: problems.length === 0,
    path,
    lines: Object.freeze([...lines]),
    points: Object.freeze(points.map((linePoints) => Object.freeze(linePoints))),
    problems: Object.freeze(problems),
    counts,
    focusAliases,
    focusExampleByKey,
    activationAliases,
  });
}

function visibleAnnotationColumn(point, lineFrom, lineTo) {
  return (point.model.projection?.annotationPlan || []).flatMap((slot) => {
    const annotation = slot.effective;
    if (!annotation || slot.line < lineFrom || slot.line > lineTo) return [];
    return [{
      line: slot.line,
      kind: annotation.kind,
      value: annotation.value.text,
    }];
  });
}

function visibleHighlightBands(check, point, lineFrom, lineTo) {
  const cursorRange = point.model.cursorInspection?.range || null;
  const bands = [];
  for (let line = lineFrom; line <= lineTo; line += 1) {
    const linePoints = check.points[line - 1] || [];
    const source = check.lines[line - 1] || "";
    let band = "";
    for (let column = 0; column < source.length; column += 1) {
      const offset = linePoints[column]?.offset;
      if (
        cursorRange &&
        cursorRange.path === check.path &&
        cursorRange.start <= offset &&
        offset < cursorRange.end
      ) {
        band += "E";
        continue;
      }
      const coverage = coverageAt(point.model.coverage, check.path, offset);
      if (coverage.some((item) => item.state === "active")) band += "S";
      else if (
        coverage.some(
          (item) =>
            item.state === "inactive" || item.state === "globally-unreached",
        )
      ) band += "G";
      else band += ".";
    }
    bands.push({ line, band });
  }
  return bands;
}

function visibleRightPane(point) {
  const list = point.model.occurrenceList;
  return {
    expression: list.expression,
    count: list.count,
    emptyReason: list.rows.length ? null : list.emptyReason,
    rows: list.rows.map((row) => ({
      selectedActivation: row.activationId === list.selectedActivationId,
      selectedExpressionValue: row.occurrenceId === list.selectedOccurrenceId,
      name: row.name,
      inputs: row.inputs.map((input) => input.text),
      arrow: row.outcome.kind === "raise" ? "⇑" : "→",
      outcome: row.outcome.text,
      repeat:
        row.totalInActivation > 1
          ? `${row.ordinal}/${row.totalInActivation}`
          : null,
      expressionValue: row.value?.text || null,
      valueStatus: row.valueStatus || null,
    })),
  };
}

/**
 * Project one reducer state into exactly the three user-visible execution
 * channels audited by the CLI and rendered by Debug view.
 */
function executionUxGeometry(state, path, source) {
  const sourceText = String(source);
  const cacheKey = `${path}\u001f${sourceText}`;
  let bySource = executionUxGeometryCache.get(state.view);
  if (!bySource) {
    bySource = new Map();
    executionUxGeometryCache.set(state.view, bySource);
  }
  const cached = bySource.get(cacheKey);
  if (cached) return cached;
  const lines = sourceText.split("\n");
  const geometry = Object.freeze({
    cacheKey,
    path,
    lines: Object.freeze(lines),
    points: Object.freeze(
      lines.map((line, lineIndex) =>
        Object.freeze(
          Array.from({ length: line.length + 1 }, (_, column) =>
            Object.freeze({
              offset: executionViewOffset(state.view, {
                path,
                line: lineIndex + 1,
                column,
              }),
            }),
          ),
        ),
      ),
    ),
  });
  bySource.set(cacheKey, geometry);
  return geometry;
}

function visibleUxState(model, geometry, lineFrom, lineTo) {
  const first = Math.max(1, lineFrom);
  const last = Math.min(geometry.lines.length, lineTo);
  const point = { model };
  return Object.freeze({
    column: Object.freeze(visibleAnnotationColumn(point, first, last)),
    highlights: Object.freeze(
      visibleHighlightBands(geometry, point, first, last),
    ),
    rightPane: Object.freeze(visibleRightPane(point)),
  });
}

export function buildExecutionVisibleUxState(
  state,
  {
    path,
    source,
    lineFrom = 1,
    lineTo = String(source).split("\n").length,
  },
) {
  return visibleUxState(
    buildExecutionViewModel(state),
    executionUxGeometry(state, path, source),
    lineFrom,
    lineTo,
  );
}

/** Build the Source/Document/Debug explorer's n+1-boundary line matrix. */
export function buildExecutionUxLine(
  initialState,
  { path, source, line, displayFrom = 1, displayTo = String(source).split("\n").length },
) {
  const lines = String(source).split("\n");
  const sourceLine = lines[line - 1];
  if (sourceLine === undefined) return null;
  const geometry = executionUxGeometry(initialState, path, source);
  let visibleBySelection = executionUxVisibleCache.get(initialState);
  if (!visibleBySelection) {
    visibleBySelection = new Map();
    executionUxVisibleCache.set(initialState, visibleBySelection);
  }
  const visibleStates = Array.from(
    { length: sourceLine.length + 1 },
    (_, column) => {
      const moved = transition(initialState, {
        kind: "cursor-moved",
        position: { path, line, column },
      });
      const selectionKey = `${geometry.cacheKey}\u001f${displayFrom}:${displayTo}\u001f${JSON.stringify(moved.state.selection)}`;
      let visible = visibleBySelection.get(selectionKey);
      if (!visible) {
        visible = visibleUxState(
          buildExecutionViewModel(moved.state),
          geometry,
          displayFrom,
          displayTo,
        );
        visibleBySelection.set(selectionKey, visible);
      }
      return Object.freeze({
        reducerState: moved.state,
        visible,
      });
    },
  );
  const columnTable = tableForPointStates(
    visibleStates.map((state) => state.visible.column),
  );
  const highlightTable = tableForPointStates(
    visibleStates.map((state) => state.visible.highlights),
  );
  const rightPaneTable = tableForPointStates(
    visibleStates.map((state) => state.visible.rightPane),
  );
  const entries = (table) =>
    table.aliases.ordered.map((key) => ({
      id: table.aliases.byKey.get(key),
      state: table.stateByKey.get(key),
    }));
  return Object.freeze({
    schemaVersion: 1,
    path,
    lineFrom: line,
    lineTo: line,
    lines: Object.freeze([{
      line,
      source: sourceLine,
      boundaries: Object.freeze(
        visibleStates.map((_, column) => ({
          column,
          columnId: columnTable.aliases.byKey.get(columnTable.keys[column]),
          highlightId: highlightTable.aliases.byKey.get(
            highlightTable.keys[column],
          ),
          rightPaneId: rightPaneTable.aliases.byKey.get(
            rightPaneTable.keys[column],
          ),
        })),
      ),
    }]),
    tables: Object.freeze({
      columns: Object.freeze(entries(columnTable)),
      highlights: Object.freeze(entries(highlightTable)),
      rightPanes: Object.freeze(entries(rightPaneTable)),
    }),
    states: Object.freeze(visibleStates.map((state) => state.visible)),
    reducerStates: Object.freeze(
      visibleStates.map((state) => state.reducerState),
    ),
  });
}

function tableForPointStates(states) {
  const keys = states.map((state) => JSON.stringify(state));
  const aliases = aliasesFor(keys);
  const stateByKey = new Map();
  for (let index = 0; index < states.length; index += 1) {
    if (!stateByKey.has(keys[index])) stateByKey.set(keys[index], states[index]);
  }
  return { keys, aliases, stateByKey };
}

/**
 * The user-visible execution surface for every UTF-16 cursor boundary.
 * It deliberately contains only the three things the IDE renders: the value
 * column, source highlighting, and right-pane execution rows.
 */
export function buildExecutionUxMatrix(
  check,
  { lineFrom = 1, lineTo = check.lines.length } = {},
) {
  const first = Math.max(1, lineFrom);
  const last = Math.min(check.lines.length, lineTo);
  const points = [];
  const columnStates = [];
  const highlightStates = [];
  const rightPaneStates = [];
  const displayFirst = 1;
  const displayLast = check.lines.length;
  for (let line = first; line <= last; line += 1) {
    for (const point of check.points[line - 1]) {
      points.push(point);
      columnStates.push(
        visibleAnnotationColumn(point, displayFirst, displayLast),
      );
      highlightStates.push(
        visibleHighlightBands(check, point, displayFirst, displayLast),
      );
      rightPaneStates.push(visibleRightPane(point));
    }
  }
  const columnTable = tableForPointStates(columnStates);
  const highlightTable = tableForPointStates(highlightStates);
  const rightPaneTable = tableForPointStates(rightPaneStates);
  let pointIndex = 0;
  const lines = [];
  for (let line = first; line <= last; line += 1) {
    const boundaries = check.points[line - 1].map((point) => {
      const index = pointIndex++;
      return {
        column: point.position.column,
        columnId: columnTable.aliases.byKey.get(columnTable.keys[index]),
        highlightId: highlightTable.aliases.byKey.get(
          highlightTable.keys[index],
        ),
        rightPaneId: rightPaneTable.aliases.byKey.get(
          rightPaneTable.keys[index],
        ),
      };
    });
    lines.push({ line, source: check.lines[line - 1], boundaries });
  }
  const entries = (table) =>
    table.aliases.ordered.map((key) => ({
      id: table.aliases.byKey.get(key),
      state: table.stateByKey.get(key),
    }));
  return {
    schemaVersion: 1,
    path: check.path,
    lineFrom: first,
    lineTo: last,
    lines,
    tables: {
      columns: entries(columnTable),
      highlights: entries(highlightTable),
      rightPanes: entries(rightPaneTable),
    },
  };
}

export function renderExecutionUxMatrix(matrix) {
  const output = [
    `ux-matrix ${matrix.path} lines ${matrix.lineFrom}:${matrix.lineTo}`,
  ];
  for (const line of matrix.lines) {
    const width = String(line.line).length;
    output.push(`${String(line.line).padStart(width)} | ${line.source}·`);
    output.push(
      `C${" ".repeat(Math.max(0, width - 1))} | ${line.boundaries.map((item) => item.columnId).join("")}`,
    );
    output.push(
      `H${" ".repeat(Math.max(0, width - 1))} | ${line.boundaries.map((item) => item.highlightId).join("")}`,
    );
    output.push(
      `R${" ".repeat(Math.max(0, width - 1))} | ${line.boundaries.map((item) => item.rightPaneId).join("")}`,
    );
  }
  output.push("", "annotation columns");
  for (const entry of matrix.tables.columns) {
    output.push(`C ${entry.id}${entry.state.length ? "" : " -"}`);
    for (const item of entry.state) {
      output.push(`  ${item.line} ${item.kind} ${item.value}`);
    }
  }
  output.push("", "highlights");
  for (const entry of matrix.tables.highlights) {
    output.push(`H ${entry.id}`);
    for (const item of entry.state) {
      const source = matrix.lines.find((line) => line.line === item.line)?.source || "";
      output.push(`  ${item.line} | ${source}`);
      output.push(`    | ${item.band}`);
    }
  }
  output.push("", "right panes");
  for (const entry of matrix.tables.rightPanes) {
    const state = entry.state;
    output.push(
      `R ${entry.id} ${state.expression ? `\`${state.expression}\`` : "-"} ${state.count} occurrence${state.count === 1 ? "" : "s"}`,
    );
    if (!state.rows.length) output.push(`  ${state.emptyReason || "empty"}`);
    for (const row of state.rows) {
      const selected = [
        row.selectedActivation ? "call" : "",
        row.selectedExpressionValue ? "value" : "",
      ].filter(Boolean).join("+");
      output.push(
        `  ${selected ? `[${selected}] ` : ""}${row.name}(${row.inputs.join(", ")}) ${row.arrow} ${row.outcome}${row.repeat ? ` ${row.repeat}` : ""}`,
      );
      if (row.expressionValue) output.push(`    value ${row.expressionValue}`);
      else if (row.valueStatus) output.push(`    ${row.valueStatus}`);
    }
  }
  output.push(
    "",
    "legend C value column  H source display  R right pane",
    "highlight bands E=selected expression S=selected invocation G=greyed .=unchanged",
    "each mapping row has source-length+1 IDs; · marks the final cursor boundary",
  );
  return output.join("\n");
}

function compactNumberRanges(numbers) {
  const ordered = [...new Set(numbers)].sort((left, right) => left - right);
  const ranges = [];
  for (const value of ordered) {
    const previous = ranges[ranges.length - 1];
    if (previous && previous[1] + 1 === value) previous[1] = value;
    else ranges.push([value, value]);
  }
  return ranges
    .map(([first, last]) => (first === last ? `${first}` : `${first}–${last}`))
    .join(", ");
}

function visualFrameLines(check, state, cursorLine, cursorColumns, numberWidth) {
  const annotations = new Map(state.column.map((item) => [item.line, item]));
  const highlights = new Map(state.highlights.map((item) => [item.line, item.band]));
  const visibleLines = new Set([cursorLine]);
  for (const item of state.column) visibleLines.add(item.line);
  for (const item of state.highlights) {
    if (/[ESG]/.test(item.band)) visibleLines.add(item.line);
  }
  const orderedLines = [...visibleLines]
    .filter((line) => line >= 1 && line <= check.lines.length)
    .sort((left, right) => left - right);
  const output = [];
  let previousLine = null;
  for (const line of orderedLines) {
    if (previousLine !== null && line > previousLine + 1) {
      output.push(`${" ".repeat(numberWidth)} | …`);
    }
    const source = check.lines[line - 1] || "";
    const annotation = annotations.get(line);
    const suffix = annotation
      ? `    │ ${annotation.value}`
      : "";
    output.push(`${String(line).padStart(numberWidth)} | ${source}${suffix}`);
    const band = highlights.get(line) || ".".repeat(source.length);
    if (/[ESG]/.test(band)) {
      output.push(`${" ".repeat(numberWidth)} | ${band}`);
    }
    if (line === cursorLine) {
      const selectedColumns = new Set(cursorColumns);
      const cursors = Array.from(
        { length: source.length + 1 },
        (_, column) => (selectedColumns.has(column) ? "▲" : " "),
      ).join("");
      output.push(`${" ".repeat(numberWidth)} | ${cursors} cursor ${compactNumberRanges(cursorColumns)}`);
    }
    previousLine = line;
  }
  const rightPane = state.rightPane;
  output.push(
    "",
    `right pane ${rightPane.expression ? `\`${rightPane.expression}\`` : "-"} ${rightPane.count} occurrence${rightPane.count === 1 ? "" : "s"}`,
  );
  if (!rightPane.rows.length) {
    output.push(`  ${rightPane.emptyReason || "empty"}`);
  }
  for (const row of rightPane.rows) {
    const selected = row.selectedActivation || row.selectedExpressionValue;
    output.push(
      `  ${selected ? "●" : " "} ${row.name}(${row.inputs.join(", ")}) ${row.arrow} ${row.outcome}${row.repeat ? ` ${row.repeat}` : ""}`,
    );
    if (row.expressionValue) output.push(`    value ${row.expressionValue}`);
    else if (row.valueStatus) output.push(`    ${row.valueStatus}`);
  }
  return output;
}

/**
 * Render the auditor as source-shaped editor frames. Each overview row has
 * exactly source-length+1 view IDs; the final ID sits under the synthetic `·`
 * end boundary. Frames keep cursor boundaries on a separate row so source
 * text never moves.
 */
export function renderExecutionVisualReport(
  check,
  { lineFrom = 1, lineTo = check.lines.length } = {},
) {
  const matrix = buildExecutionUxMatrix(check, { lineFrom, lineTo });
  const columnById = new Map(
    matrix.tables.columns.map((entry) => [entry.id, entry.state]),
  );
  const highlightById = new Map(
    matrix.tables.highlights.map((entry) => [entry.id, entry.state]),
  );
  const rightPaneById = new Map(
    matrix.tables.rightPanes.map((entry) => [entry.id, entry.state]),
  );
  const numberWidth = String(matrix.lineTo).length;
  const lineViews = matrix.lines.map((line) => {
    const keys = line.boundaries.map((boundary) =>
      JSON.stringify([
        boundary.columnId,
        boundary.highlightId,
        boundary.rightPaneId,
      ]),
    );
    const aliases = aliasesFor(keys, { sort: false });
    const representativeByKey = new Map();
    const columnsByKey = new Map();
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];
      if (!representativeByKey.has(key)) {
        representativeByKey.set(key, line.boundaries[index]);
        columnsByKey.set(key, []);
      }
      columnsByKey.get(key).push(line.boundaries[index].column);
    }
    return { line, keys, aliases, representativeByKey, columnsByKey };
  });
  const output = [
    `visual audit ${matrix.path}`,
    `lines ${matrix.lineFrom}:${matrix.lineTo}`,
    "",
    "overview",
  ];
  for (const item of lineViews) {
    const number = String(item.line.line).padStart(numberWidth);
    output.push(`${number} | ${item.line.source}·`);
    output.push(
      `V${" ".repeat(Math.max(0, numberWidth - 1))} | ${item.keys
        .map((key) => item.aliases.byKey.get(key))
        .join("")}`,
    );
  }
  output.push("", "views");
  for (const item of lineViews) {
    for (const key of item.aliases.ordered) {
      const id = item.aliases.byKey.get(key);
      const boundary = item.representativeByKey.get(key);
      const cursorColumns = item.columnsByKey.get(key);
      const state = {
        column: columnById.get(boundary.columnId) || [],
        highlights: highlightById.get(boundary.highlightId) || [],
        rightPane: rightPaneById.get(boundary.rightPaneId) || {
          expression: "",
          count: 0,
          emptyReason: "no-selection",
          rows: [],
        },
      };
      output.push(
        "",
        `view ${item.line.line}:${id}  cursor ${item.line.line}:${compactNumberRanges(cursorColumns)}`,
        ...visualFrameLines(
          check,
          state,
          item.line.line,
          cursorColumns,
          numberWidth,
        ),
      );
    }
  }
  output.push(
    "",
    "legend V visible editor view at each cursor boundary; · is the final boundary",
    "highlight E=selected expression S=selected activation G=greyed .=unchanged",
  );
  return output.join("\n");
}

function renderProblemGroups(check, maximumWitnesses) {
  const groups = new Map();
  for (const problem of check.problems) {
    if (!groups.has(problem.code)) groups.set(problem.code, []);
    groups.get(problem.code).push(problem);
  }
  const output = [];
  for (const [code, problems] of [...groups].sort(([left], [right]) => compareText(left, right))) {
    output.push(`${code} ×${problems.length}`);
    for (const problem of problems.slice(0, maximumWitnesses)) {
      const location = problem.position
        ? `${problem.position.line}:${problem.position.column}`
        : problem.entityId || "-";
      output.push(`  ${location}${problem.detail ? `  ${problem.detail}` : ""}`);
      if (problem.witness) {
        output.push(`    ${problem.witness.source}`);
        output.push(`    ${" ".repeat(problem.witness.column)}^`);
      }
    }
    if (problems.length > maximumWitnesses) {
      output.push(`  … ${problems.length - maximumWitnesses} more`);
    }
  }
  return output;
}

export function renderExecutionSelfCheck(check, { maximumWitnesses = 3 } = {}) {
  const counts = check.counts;
  const output = [
    check.ok
      ? "self-check ok"
      : `self-check ${check.problems.length} problems in ${new Set(check.problems.map((problem) => problem.code)).size} classes`,
    `checked boundaries=${counts.boundaries} selector-states=${counts.selectorStates} activation-choices=${counts.activationChoices} occurrence-navigation=${counts.occurrenceNavigation} activation-navigation=${counts.activationNavigation} projections=${counts.projections} sweeps=${counts.sequentialCursor} edit-recovery=${counts.editRecovery}`,
  ];
  if (!check.ok) output.push(...renderProblemGroups(check, maximumWitnesses));
  return output.join("\n");
}

function pointCoverageSymbol(point) {
  if (point.coverage.some((item) => item.state === "active")) return "A";
  if (point.coverage.some((item) => item.state === "inactive")) return "i";
  if (point.coverage.some((item) => item.state === "globally-unreached")) return "×";
  return "·";
}

function coverageSymbolAt(coverage, path, offset) {
  const items = coverageAt(coverage, path, offset);
  if (items.some((item) => item.state === "active")) return "A";
  if (items.some((item) => item.state === "inactive")) return "i";
  if (items.some((item) => item.state === "globally-unreached")) return "×";
  return "·";
}

function focusDescription(check, key) {
  const point = check.focusExampleByKey.get(key);
  if (!point) return "-";
  const snapshot = executionViewSnapshot(point.state.view);
  const selector = executionViewProjectedSelector(point.state.view, point.query.selectorId);
  const construct = snapshotConstruct(snapshot, point.query.constructId);
  const activation = snapshotActivation(snapshot, point.selection.activationId);
  const activationAlias = check.activationAliases.byKey.get(point.selection.activationId) || "-";
  const values = point.values.map((value) => outcomeText(value.outcome)).join(" · ") || "-";
  const functionSelector = activation?.functionConstructId
    ? executionViewSelectorsForConstruct(
        point.state.view,
        activation.functionConstructId,
      ).find((candidate) => candidate.role === "binder")
    : null;
  const functionName = functionSelector
    ? executionViewSourceText(point.state.view, functionSelector.range)?.trim()
    : null;
  const inputs = (activation?.parameterOccurrenceIds || []).flatMap(
    (occurrenceId) => {
      const occurrence = snapshotOccurrence(snapshot, occurrenceId);
      return occurrence ? [outcomeText(occurrence.outcome)] : [];
    },
  );
  const call = activation
    ? `${functionName || (activation.functionConstructId ? "fun" : "Program")}(${inputs.join(", ")})→${outcomeText(activation.outcome)}`
    : "-";
  return `${selector?.role || "-"}/${construct?.semanticKind || construct?.category || "-"} ${point.query.status} activation=${activationAlias}:${call} value=${values}`;
}

/** A two-band source atlas: Q is the complete cursor focus, H is rendered coverage. */
export function renderExecutionAtlas(
  check,
  {
    lineFrom = 1,
    lineTo = check.lines.length,
    maximumWitnesses = 3,
    focusPosition = null,
  } = {},
) {
  const numberWidth = String(Math.min(check.lines.length, lineTo)).length;
  const output = [
    `atlas ${check.path}`,
    renderExecutionSelfCheck(check, { maximumWitnesses }),
  ];
  const focusPoint = focusPosition
    ? check.points[focusPosition.line - 1]?.[focusPosition.column] || null
    : null;
  const first = Math.max(1, lineFrom);
  const last = Math.min(check.lines.length, lineTo);
  const lineAliases = new Map(
    Array.from({ length: Math.max(0, last - first + 1) }, (_, index) => {
      const line = first + index;
      return [
        line,
        aliasesFor(check.points[line - 1].map(selectionKey), { sort: false }),
      ];
    }),
  );
  if (focusPoint) {
    const aliases = lineAliases.get(focusPosition.line);
    output.push(
      `focus ${focusPosition.line}:${focusPosition.column} ${aliases?.byKey.get(selectionKey(focusPoint)) ? `${focusPosition.line}:${aliases.byKey.get(selectionKey(focusPoint))}` : "outside displayed lines"}`,
    );
  } else if (focusPosition) output.push(`focus ${focusPosition.line}:${focusPosition.column} invalid`);
  for (let line = first; line <= last; line += 1) {
    const number = String(line).padStart(numberWidth);
    const points = check.points[line - 1];
    const aliases = lineAliases.get(line);
    const blank = "-".repeat(aliases.width);
    output.push(`${number} | ${check.lines[line - 1]}·`);
    output.push(
      `Q${" ".repeat(numberWidth - 1)} | ${points
        .map((point) => aliases.byKey.get(selectionKey(point)) || blank)
        .join("")}`,
    );
    output.push(
      `H${" ".repeat(numberWidth - 1)} | ${points
        .map((point) =>
          focusPoint
            ? coverageSymbolAt(
                focusPoint.model.coverage,
                point.position.path,
                point.offset,
              )
            : pointCoverageSymbol(point),
        )
        .map((symbol) => symbol.repeat(aliases.width))
        .join("")}`,
    );
  }
  output.push("", "focus states");
  for (let line = first; line <= last; line += 1) {
    const aliases = lineAliases.get(line);
    for (const key of aliases.ordered) {
      output.push(`${line}:${aliases.byKey.get(key)} ${focusDescription(check, key)}`);
    }
  }
  output.push(
    "",
    `legend Q cursor focus identity  H ${focusPoint ? "coverage for fixed focus" : "coverage for each cursor focus"} A=active i=inactive ×=never-run ·=uncovered`,
  );
  return output.join("\n");
}

export function renderUnavailableExecutionAtlas({ path, problems = [] }) {
  return [
    `atlas ${path}`,
    "artifact unavailable",
    `problems ${problems.length}`,
    ...problems.slice(0, 12).map((problem) =>
      `! ${problem.code || "invalid"}${
        problem.detail ? ` ${problem.detail}` : ""
      }`,
    ),
    "self-check unavailable",
  ].join("\n");
}

export function executionSelfCheckToJson(check) {
  return {
    schemaVersion: check.schemaVersion,
    ok: check.ok,
    path: check.path,
    counts: check.counts,
    problems: check.problems,
    lines: check.points.map((points, index) => ({
      line: index + 1,
      source: check.lines[index],
      boundaries: points.map((point) => ({
        column: point.position.column,
        status: point.query.status,
        selectorId: point.query.selectorId,
        constructId: point.query.constructId,
        activationIds: point.query.activationIds,
        selectedActivationId: point.selection.activationId,
        focusedOccurrenceId: point.selection.focusedOccurrenceId,
        valueOccurrenceIds: point.values.map((value) => value.occurrenceId),
        coverage: point.coverage.map((item) => item.state),
      })),
    })),
  };
}
