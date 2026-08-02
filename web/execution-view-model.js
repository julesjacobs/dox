import {
  snapshotActivation,
  snapshotActivationIdsForConstruct,
  snapshotCallAttemptsForActivation,
  snapshotClosures,
  snapshotConstruct,
  snapshotOccurrence,
  snapshotOccurrenceIdsForActivationConstruct,
  snapshotTerminal,
  snapshotWritesForActivation,
  snapshotWritesForConstruct,
} from "./execution-artifact.js";
import {
  focusedOccurrenceValue,
  occurrenceHasUserValue,
  occurrenceRowsForConstruct,
  projectActivation,
  selectionHasExpressionValue,
} from "./execution-query.js";
import { renderExecutionValue } from "./execution-value.js";
import {
  executionViewPositionAtOffset,
  executionViewProjectedSelector,
  executionViewSelectionRange,
  executionViewSelectorSurface,
  executionViewSelectorsForConstruct,
  executionViewSnapshot,
  executionViewSourceText,
} from "./execution-view.js";

function freeze(value) {
  if (Object.isFrozen(value)) return value;
  if (Array.isArray(value)) return Object.freeze(value.map(freeze));
  if (!value || typeof value !== "object") return value;
  const result = {};
  for (const [key, item] of Object.entries(value)) result[key] = freeze(item);
  return Object.freeze(result);
}

function compareText(left, right) {
  const leftText = String(left ?? "");
  const rightText = String(right ?? "");
  return leftText < rightText ? -1 : leftText > rightText ? 1 : 0;
}

const displayOutcome = (outcome) => renderExecutionValue(outcome);
const coveragePlanCache = new WeakMap();
const viewModelCache = new WeakMap();
const persistentAnnotationCache = new WeakMap();
const activationLinksCache = new WeakMap();
const globalCoverageCache = new WeakMap();
const globalComposedCoverageCache = new WeakMap();
const occurrencePresentationCache = new WeakMap();
const cacheStats = {
  coverageCompositions: 0,
  persistentAnnotationBuilds: 0,
  activationLinkBuilds: 0,
  occurrencePresentationBuilds: 0,
};

function displayOutcomeForConstruct(snapshot, constructId, outcome) {
  const semanticKind = snapshotConstruct(snapshot, constructId)?.semanticKind;
  const role =
    semanticKind === "binder" || semanticKind === "alias"
      ? "variable"
      : semanticKind === "wildcard"
        ? "shape"
        : null;
  return renderExecutionValue(outcome, role ? { role } : undefined);
}

function shiftedDisplaySegments(value, shift = 0) {
  const segments = value.segments?.length
    ? value.segments
    : [{ from: 0, to: value.text.length, role: "neutral" }];
  return segments.map((segment) => ({
    ...segment,
    from: segment.from + shift,
    to: segment.to + shift,
  }));
}

function prefixDisplayedValue(prefix, value) {
  const shift = prefix.length;
  return {
    ...value,
    text: `${prefix}${value.text}`,
    fullText: `${prefix}${value.fullText}`,
    segments: [
      { from: 0, to: shift, role: "neutral" },
      ...shiftedDisplaySegments(value, shift),
    ],
  };
}

function joinDisplayedValues(left, separator, right) {
  const rightShift = left.text.length + separator.length;
  return {
    text: `${left.text}${separator}${right.text}`,
    fullText: `${left.fullText}${separator}${right.fullText}`,
    type: null,
    kind: right.kind,
    truncated: left.truncated || right.truncated,
    segments: [
      ...shiftedDisplaySegments(left),
      { from: left.text.length, to: rightShift, role: "neutral" },
      ...shiftedDisplaySegments(right, rightShift),
    ],
  };
}

function writeOutcome(write) {
  return write
    ? { kind: "return", value: write.newValue, source: "runtime" }
    : null;
}

function writeForSelection(snapshot, selection) {
  if (!selection.activationId || !selection.constructId) return null;
  const writes = snapshotWritesForActivation(snapshot, selection.activationId)
    .filter((write) => write.constructId === selection.constructId);
  if (!writes.length) return null;
  const occurrenceIds = snapshotOccurrenceIdsForActivationConstruct(
    snapshot,
    selection.activationId,
    selection.constructId,
  );
  const index = selection.focusedOccurrenceId
    ? occurrenceIds.indexOf(selection.focusedOccurrenceId)
    : 0;
  return writes[Math.max(0, index)] || writes[0];
}

function constructRange(view, constructId, preferredRole = "construct") {
  const selectors = executionViewSelectorsForConstruct(view, constructId).filter(
    (selector) => selector.valid !== false,
  );
  return (
    selectors.find((selector) => selector.role === preferredRole)?.range ||
    selectors[0]?.range ||
    null
  );
}

function functionEntryRange(view, constructId) {
  const selectors = executionViewSelectorsForConstruct(view, constructId).filter(
    (selector) => selector.valid !== false,
  );
  for (const role of ["binder", "fun", "function", "construct", "function-context"]) {
    const selector = selectors.find((candidate) => candidate.role === role);
    if (selector) return selector.range;
  }
  return null;
}

function activationName(view, activation) {
  if (!activation?.functionConstructId) {
    return "Program";
  }
  const range = executionViewSelectorsForConstruct(
    view,
    activation.functionConstructId,
  ).find((selector) => selector.role === "binder")?.range;
  const source = range && executionViewSourceText(view, range)?.trim();
  return source || "fun";
}

function parameterOutcomes(snapshot, activation) {
  return (activation?.parameterOccurrenceIds || []).flatMap((occurrenceId) => {
    const occurrence = snapshotOccurrence(snapshot, occurrenceId);
    return occurrence ? [occurrence.outcome] : [];
  });
}

function joinedValue(outcomes, separator, budget = 120) {
  const rendered = outcomes.map((outcome) => renderExecutionValue(outcome, { budget }));
  const fullText = rendered.map((value) => value.fullText).join(separator);
  return renderExecutionValue(
    {
      kind: outcomes.some((outcome) => outcome?.kind === "raise")
        ? "raise"
        : "return",
      value: { display: fullText, complete: rendered.every((value) => !value.truncated) },
    },
    { budget },
  );
}

function constructDepth(snapshot, constructId) {
  let depth = 0;
  let construct = snapshotConstruct(snapshot, constructId);
  const seen = new Set();
  while (construct?.parentId && !seen.has(construct.parentId)) {
    seen.add(construct.parentId);
    depth += 1;
    construct = snapshotConstruct(snapshot, construct.parentId);
  }
  return depth;
}

const returnBoundaryRoles = new Set(["arrow", "else", "then"]);
const returnFallbackExcludedKinds = new Set([
  "binding",
  "condition",
  "function",
  "loop",
  "match",
  "sequence",
]);

function sameOutcome(left, right) {
  if (!left || !right || left.kind !== right.kind) return false;
  if (
    left.kind === "incomplete" ||
    left.value?.complete === false ||
    right.value?.complete === false
  ) return false;
  const sameValue =
    left.value?.fingerprint != null && right.value?.fingerprint != null
      ? left.value.fingerprint === right.value.fingerprint
      : left.value?.display === right.value?.display;
  return (
    sameValue &&
    left.value?.type === right.value?.type
  );
}

function activationReturnOccurrence(view, snapshot, activation) {
  const matching = (activation.occurrenceIds || []).flatMap((occurrenceId) => {
    const occurrence = snapshotOccurrence(snapshot, occurrenceId);
    if (
      !occurrenceHasUserValue(occurrence) ||
      occurrence.kind === "parameter" ||
      !sameOutcome(occurrence.outcome, activation.outcome)
    ) return [];
    const construct = snapshotConstruct(snapshot, occurrence.constructId);
    if (!construct || construct.category !== "expression") return [];
    const isReturnBoundary = executionViewSelectorsForConstruct(
      view,
      construct.id,
    ).some((selector) => returnBoundaryRoles.has(selector.role));
    return [{ occurrence, construct, isReturnBoundary }];
  });
  const boundary = matching.filter((item) => item.isReturnBoundary);
  if (boundary.length) {
    return boundary.sort(
      (left, right) =>
        constructDepth(snapshot, right.construct.id) -
          constructDepth(snapshot, left.construct.id) ||
        (right.occurrence.outcomeAt ?? -1) -
          (left.occurrence.outcomeAt ?? -1) ||
        compareText(left.occurrence.id, right.occurrence.id),
    )[0].occurrence;
  }
  return matching
    .filter(
      (item) => !returnFallbackExcludedKinds.has(item.construct.semanticKind),
    )
    .sort(
      (left, right) =>
        (right.occurrence.outcomeAt ?? -1) -
          (left.occurrence.outcomeAt ?? -1) ||
        constructDepth(snapshot, right.construct.id) -
          constructDepth(snapshot, left.construct.id) ||
        compareText(left.occurrence.id, right.occurrence.id),
    )[0]?.occurrence || null;
}

function lineForRange(view, range) {
  return range
    ? executionViewPositionAtOffset(view, range.path, range.start)?.line || null
    : null;
}

function endLineForRange(view, range) {
  if (!range) return null;
  const offset = range.end > range.start ? range.end - 1 : range.end;
  return executionViewPositionAtOffset(view, range.path, offset)?.line || null;
}

function candidate(view, snapshot, fields) {
  const line = fields.line || lineForRange(view, fields.range);
  return line ? { ...fields, line } : null;
}

function matchExecution(view, snapshot, activation, matchOccurrence) {
  const nextMatchEnteredAt = snapshotOccurrenceIdsForActivationConstruct(
    snapshot,
    activation.id,
    matchOccurrence.constructId,
  )
    .map((occurrenceId) => snapshotOccurrence(snapshot, occurrenceId))
    .reduce(
      (next, occurrence) =>
        occurrence.enteredAt > matchOccurrence.enteredAt
          ? Math.min(next, occurrence.enteredAt)
          : next,
      Number.POSITIVE_INFINITY,
    );
  let scrutineeOccurrence = null;
  let armArrow = null;
  for (const occurrenceId of activation.occurrenceIds || []) {
    const occurrence = snapshotOccurrence(snapshot, occurrenceId);
    if (
      !occurrence ||
      occurrence.enteredAt <= matchOccurrence.enteredAt ||
      occurrence.enteredAt >= nextMatchEnteredAt
    ) continue;
    const construct = snapshotConstruct(snapshot, occurrence.constructId);
    if (construct?.parentId !== matchOccurrence.constructId) continue;
    const selectors = executionViewSelectorsForConstruct(view, construct.id).filter(
      (selector) => selector.valid !== false,
    );
    const roles = new Set(selectors.map((selector) => selector.role));
    if (
      !scrutineeOccurrence &&
      occurrenceHasUserValue(occurrence) &&
      roles.has("match") &&
      roles.has("with")
    ) {
      scrutineeOccurrence = occurrence;
    }
    if (!armArrow && construct.category === "expression") {
      armArrow =
        selectors.find((selector) => selector.role === "arrow")?.range || null;
    }
    if (scrutineeOccurrence && armArrow) break;
  }
  return { scrutineeOccurrence, armArrow };
}

function persistentAnnotationCandidates(view, snapshot, activation, projection) {
  let byActivation = persistentAnnotationCache.get(view);
  if (!byActivation) {
    byActivation = new Map();
    persistentAnnotationCache.set(view, byActivation);
  }
  const cached = byActivation.get(activation.id);
  if (cached) return cached;
  cacheStats.persistentAnnotationBuilds += 1;
  const candidates = [];
  const functionRange = activation.functionConstructId
    ? functionEntryRange(view, activation.functionConstructId)
    : null;
  const parameters = parameterOutcomes(snapshot, activation);
  if (functionRange && parameters.length) {
    candidates.push(
      candidate(view, snapshot, {
        kind: "function-entry",
        boundaryId: activation.id,
        constructId: activation.functionConstructId,
        occurrenceId: activation.functionOccurrenceId,
        range: functionRange,
        depth: 0,
        value: joinedValue(parameters, " · "),
      }),
    );
  }

  for (const constructId of projection.activeConstructIds) {
    const construct = snapshotConstruct(snapshot, constructId);
    if (construct?.semanticKind !== "match") continue;
    const occurrenceId = snapshotOccurrenceIdsForActivationConstruct(
      snapshot,
      activation.id,
      constructId,
    )[0];
    const matchOccurrence = snapshotOccurrence(snapshot, occurrenceId);
    const execution = matchOccurrence
      ? matchExecution(view, snapshot, activation, matchOccurrence)
      : null;
    const occurrence = execution?.scrutineeOccurrence || null;
    const range = execution?.armArrow || null;
    if (!occurrence || !range || !occurrenceHasUserValue(occurrence)) continue;
    candidates.push(
      candidate(view, snapshot, {
        kind: "match",
        boundaryId: matchOccurrence.id,
        constructId,
        occurrenceId: occurrence.id,
        range,
        depth: constructDepth(snapshot, constructId),
        value: prefixDisplayedValue(
          "≈ ",
          displayOutcomeForConstruct(
            snapshot,
            occurrence.constructId,
            occurrence.outcome,
          ),
        ),
      }),
    );
  }

  for (const item of projection.bindingValues) {
    const occurrence = snapshotOccurrence(snapshot, item.occurrenceId);
    if (!occurrence || occurrence.kind === "parameter") continue;
    const range = constructRange(view, occurrence.constructId, "binder");
    if (!range) continue;
    candidates.push(
      candidate(view, snapshot, {
        kind: "binding",
        boundaryId: occurrence.id,
        constructId: occurrence.constructId,
        occurrenceId: occurrence.id,
        range,
        depth: constructDepth(snapshot, occurrence.constructId),
        value: displayOutcomeForConstruct(
          snapshot,
          occurrence.constructId,
          occurrence.outcome,
        ),
      }),
    );
  }

  for (const write of snapshotWritesForActivation(snapshot, activation.id)) {
    const range = constructRange(view, write.constructId);
    if (!range) continue;
    candidates.push(
      candidate(view, snapshot, {
        kind: "write",
        boundaryId: write.id,
        constructId: write.constructId,
        occurrenceId: null,
        range,
        depth: constructDepth(snapshot, write.constructId),
        value: renderExecutionValue({ kind: "return", value: write.newValue }),
      }),
    );
  }

  if (activation.functionConstructId && activation.outcome?.kind !== "incomplete") {
    const returnOccurrence = activationReturnOccurrence(
      view,
      snapshot,
      activation,
    );
    const range = returnOccurrence
      ? constructRange(view, returnOccurrence.constructId)
      : constructRange(view, activation.functionConstructId, "function-context");
    if (range) {
    const exitValue = displayOutcome(activation.outcome);
    const exitPrefix = activation.outcome?.kind === "raise" ? "⇑ " : "↩ ";
    const exit = candidate(view, snapshot, {
      kind: activation.outcome?.kind === "raise" ? "function-raise" : "function-exit",
      boundaryId: activation.id,
      constructId: activation.functionConstructId,
      occurrenceId: returnOccurrence?.id || activation.functionOccurrenceId,
      range,
      line: endLineForRange(view, range),
      depth: 0,
      value: renderExecutionValue({
        kind: activation.outcome?.kind || "return",
        value: {
          display: `${exitPrefix}${exitValue.fullText}`,
          type: exitValue.type,
          complete: !exitValue.truncated,
        },
      }),
    });
    if (exit) {
      const entryLine = lineForRange(view, functionRange);
      if (entryLine === exit.line && parameters.length) {
        const inputs = parameters
          .map((outcome) => renderExecutionValue(outcome).fullText)
          .join(" · ");
        const result = renderExecutionValue(activation.outcome).fullText;
        const arrow = activation.outcome?.kind === "raise" ? "⇑" : "→";
        candidates.push({
          ...exit,
          kind: "one-line-function",
          range: functionRange,
          depth: -1,
          value: renderExecutionValue({
            kind: activation.outcome?.kind || "return",
            value: { display: `${inputs} ${arrow} ${result}`, complete: true },
          }),
        });
      } else candidates.push(exit);
    }
    }
  }
  const result = freeze(candidates.filter(Boolean));
  byActivation.set(activation.id, result);
  return result;
}

const annotationKindRank = new Map([
  ["one-line-function", 0],
  ["function-entry", 1],
  ["binding", 2],
  ["match", 2],
  ["write", 3],
  ["function-exit", 4],
  ["function-raise", 4],
]);

/** Resolve the fixed annotation lane independently of DOM layout. */
export function chooseAnnotationSlot(line, annotations) {
  const orderedPersistent = annotations
    .filter((item) => item.kind !== "cursor")
    .sort(
      (left, right) =>
        left.depth - right.depth ||
        (annotationKindRank.get(left.kind) ?? 99) -
          (annotationKindRank.get(right.kind) ?? 99) ||
        compareText(left.boundaryId, right.boundaryId),
    );
  const match = orderedPersistent.find((item) => item.kind === "match") || null;
  const exit = orderedPersistent.find(
    (item) => item.kind === "function-exit" || item.kind === "function-raise",
  ) || null;
  const persistent = match && exit
    ? {
        ...match,
        kind: "match-and-exit",
        boundaryId: `${match.boundaryId}|${exit.boundaryId}`,
        value: joinDisplayedValues(match.value, "   ", exit.value),
      }
    : orderedPersistent[0] || null;
  const cursor = annotations.find((item) => item.kind === "cursor") || null;
  const cursorMatchesPersistent = Boolean(
    cursor &&
      persistent &&
      ((cursor.occurrenceId && cursor.occurrenceId === persistent.occurrenceId) ||
        (!cursor.value.truncated &&
          !persistent.value.truncated &&
          cursor.value.kind === persistent.value.kind &&
          cursor.value.type === persistent.value.type &&
          (cursor.value.fullText ?? cursor.value.text) ===
            (persistent.value.fullText ?? persistent.value.text))),
  );
  return {
    line,
    persistent,
    cursor,
    effective:
      cursor && !cursorMatchesPersistent ? cursor : persistent,
  };
}

function annotationPlan(view, snapshot, state, projection) {
  if (!projection) return [];
  const activation = snapshotActivation(snapshot, projection.activationId);
  if (!activation) return [];
  const byLine = new Map();
  for (const annotation of persistentAnnotationCandidates(
    view,
    snapshot,
    activation,
    projection,
  )) {
    if (!byLine.has(annotation.line)) byLine.set(annotation.line, []);
    byLine.get(annotation.line).push(annotation);
  }
  const selectedSelector = state.selection.selectorId
    ? executionViewProjectedSelector(view, state.selection.selectorId)
    : null;
  const selectedRange = executionViewSelectionRange(view, selectedSelector);
  const showExpressionValue = selectionHasExpressionValue(view, state.selection);
  const selectedValue = !showExpressionValue
    ? null
    : focusedOccurrenceValue(view, state.selection);
  const selectedWrite = showExpressionValue
    ? writeForSelection(snapshot, state.selection)
    : null;
  const selectedOutcome = writeOutcome(selectedWrite) || selectedValue?.outcome;
  const cursorLine = lineForRange(view, selectedRange);
  const preserveFunctionEntry =
    selectedSelector?.role === "binder" &&
    state.selection.constructId === activation.functionConstructId;
  const duplicatesFunctionOutcome = Boolean(
    selectedValue?.occurrenceId &&
      [...byLine.values()].some((annotations) =>
        annotations.some(
          (annotation) =>
            (annotation.kind === "function-exit" ||
              annotation.kind === "function-raise") &&
            annotation.occurrenceId === selectedValue.occurrenceId,
        ),
      ),
  );
  if (
    cursorLine &&
    selectedOutcome &&
    !preserveFunctionEntry &&
    !duplicatesFunctionOutcome
  ) {
    if (!byLine.has(cursorLine)) byLine.set(cursorLine, []);
    byLine.get(cursorLine).push({
      kind: "cursor",
      boundaryId: selectedWrite?.id || selectedValue.occurrenceId,
      constructId: state.selection.constructId,
      occurrenceId: selectedValue?.occurrenceId || null,
      range: selectedRange,
      line: cursorLine,
      depth: -2,
      value: displayOutcomeForConstruct(
        snapshot,
        state.selection.constructId,
        selectedOutcome,
      ),
    });
  }
  return [...byLine]
    .sort(([left], [right]) => left - right)
    .map(([line, annotations]) => chooseAnnotationSlot(line, annotations));
}

function coverageRanges(view, constructIds, state) {
  return constructIds.flatMap((constructId) => {
    const selectors = executionViewSelectorsForConstruct(view, constructId).filter(
      (selector) => selector.valid !== false,
    );
    const ranges = selectors.length
      ? selectors.map((selector) => selector.range)
      : [constructRange(view, constructId)].filter(Boolean);
    const seen = new Set();
    return ranges.flatMap((range) => {
      const key = `${range.path}\u001f${range.start}\u001f${range.end}`;
      if (seen.has(key)) return [];
      seen.add(key);
      return [{ constructId, state, range }];
    });
  });
}

const coverageStateRank = new Map([
  ["active", 0],
  ["inactive", 1],
  ["globally-unreached", 2],
]);

/**
 * AST ranges nest and occasionally coincide. Convert them into disjoint source
 * intervals so CSS never has to decide which semantic state wins. The smallest
 * construct owns a character; identical ranges prefer evidence of execution.
 */
export function composeCoverageIntervals(coverage) {
  const byPath = new Map();
  for (const item of coverage) {
    if (!item.range || item.range.end <= item.range.start) continue;
    if (!byPath.has(item.range.path)) byPath.set(item.range.path, []);
    byPath.get(item.range.path).push(item);
  }
  const result = [];
  for (const [path, items] of byPath) {
    const compareOwner = (left, right) =>
      left.range.end - left.range.start - (right.range.end - right.range.start) ||
      (coverageStateRank.get(left.state) ?? 99) -
        (coverageStateRank.get(right.state) ?? 99) ||
      compareText(left.constructId, right.constructId) ||
      left.index - right.index;
    const events = new Map();
    items.forEach((item, index) => {
      const indexed = { ...item, index };
      if (!events.has(item.range.start)) events.set(item.range.start, { starts: [], ends: [] });
      if (!events.has(item.range.end)) events.set(item.range.end, { starts: [], ends: [] });
      events.get(item.range.start).starts.push(indexed);
      events.get(item.range.end).ends.push(indexed);
    });
    const boundaries = [...events.keys()].sort((left, right) => left - right);
    const active = new Set();
    const heap = [];
    const push = (item) => {
      let index = heap.push(item) - 1;
      while (index > 0) {
        const parent = Math.floor((index - 1) / 2);
        if (compareOwner(heap[parent], heap[index]) <= 0) break;
        [heap[parent], heap[index]] = [heap[index], heap[parent]];
        index = parent;
      }
    };
    const pop = () => {
      const last = heap.pop();
      if (!heap.length || !last) return;
      heap[0] = last;
      let index = 0;
      while (true) {
        const left = index * 2 + 1;
        const right = left + 1;
        let smallest = index;
        if (left < heap.length && compareOwner(heap[left], heap[smallest]) < 0) {
          smallest = left;
        }
        if (right < heap.length && compareOwner(heap[right], heap[smallest]) < 0) {
          smallest = right;
        }
        if (smallest === index) break;
        [heap[index], heap[smallest]] = [heap[smallest], heap[index]];
        index = smallest;
      }
    };
    for (let index = 0; index + 1 < boundaries.length; index += 1) {
      const start = boundaries[index];
      const end = boundaries[index + 1];
      const event = events.get(start);
      for (const item of event.ends) active.delete(item.index);
      for (const item of event.starts) {
        active.add(item.index);
        push(item);
      }
      while (heap.length && !active.has(heap[0].index)) pop();
      const owner = heap[0];
      if (!owner) continue;
      const previous = result[result.length - 1];
      if (
        previous?.state === owner.state &&
        previous.constructId === owner.constructId &&
        previous.range.path === path &&
        previous.range.end === start
      ) {
        previous.range.end = end;
      } else {
        result.push({
          constructId: owner.constructId,
          state: owner.state,
          range: { path, start, end },
        });
      }
    }
  }
  return result;
}

function globalCoverageRanges(view, snapshot) {
  const cached = globalCoverageCache.get(view);
  if (cached) return cached;
  if (snapshotTerminal(snapshot).kind === "truncated") {
    const result = Object.freeze([]);
    globalCoverageCache.set(view, result);
    return result;
  }
  const result = [];
  for (const item of executionViewSelectorSurface(view)) {
    if (snapshotActivationIdsForConstruct(snapshot, item.subjectId).length) continue;
    const previous = result[result.length - 1];
    if (
      previous?.constructId === item.subjectId &&
      previous.range.path === item.range.path &&
      previous.range.end === item.range.start
    ) {
      previous.range.end = item.range.end;
    } else {
      result.push({
        constructId: item.subjectId,
        state: "globally-unreached",
        range: { ...item.range },
      });
    }
  }
  const frozen = Object.freeze(
    result.map((item) =>
      Object.freeze({ ...item, range: Object.freeze({ ...item.range }) }),
    ),
  );
  globalCoverageCache.set(view, frozen);
  return frozen;
}

function activationCoverage(view, snapshot, projection) {
  if (!projection) {
    const cached = globalComposedCoverageCache.get(view);
    if (cached) return cached;
    cacheStats.coverageCompositions += 1;
    const result = Object.freeze(
      composeCoverageIntervals(globalCoverageRanges(view, snapshot)).map((item) =>
        Object.freeze({ ...item, range: Object.freeze({ ...item.range }) }),
      ),
    );
    globalComposedCoverageCache.set(view, result);
    return result;
  }
  let byActivation = coveragePlanCache.get(view);
  if (!byActivation) {
    byActivation = new Map();
    coveragePlanCache.set(view, byActivation);
  }
  const cached = byActivation.get(projection.activationId);
  if (cached) return cached;
  cacheStats.coverageCompositions += 1;
  const coverage = Object.freeze(
    composeCoverageIntervals([
      ...coverageRanges(view, projection.activeConstructIds, "active"),
      ...coverageRanges(view, projection.inactiveConstructIds, "inactive"),
      ...globalCoverageRanges(view, snapshot),
    ]).map((item) =>
      Object.freeze({ ...item, range: Object.freeze({ ...item.range }) }),
    ),
  );
  byActivation.set(projection.activationId, coverage);
  return coverage;
}

function occurrenceRow(view, snapshot, row, showValue) {
  const activation = row.activation;
  const writes = snapshotWritesForConstruct(
    snapshot,
    row.occurrence.constructId,
  ).filter(
    (write) => write.activationId === activation.id,
  );
  const write = writes[row.ordinal - 1];
  const valueOutcome =
    writeOutcome(write) ||
    (occurrenceHasUserValue(row.occurrence) ? row.occurrence.outcome : null);
  return {
    occurrenceId: row.occurrence.id,
    activationId: activation.id,
    name: activationName(view, activation),
    inputs: parameterOutcomes(snapshot, activation).map(displayOutcome),
    outcome: displayOutcome(activation.outcome),
    value: showValue && valueOutcome
      ? displayOutcomeForConstruct(
          snapshot,
          row.occurrence.constructId,
          valueOutcome,
        )
      : null,
    valueStatus:
      row.occurrence.outcome?.kind === "incomplete"
        ? "trace-incomplete"
        : null,
    ordinal: row.ordinal,
    totalInActivation: row.totalInActivation,
  };
}

function occurrencePresentationRows(view, snapshot, constructId, showValue) {
  if (!constructId) return [];
  let byConstruct = occurrencePresentationCache.get(view);
  if (!byConstruct) {
    byConstruct = new Map();
    occurrencePresentationCache.set(view, byConstruct);
  }
  const cacheKey = `${constructId}\u001f${showValue ? "value" : "structural"}`;
  const cached = byConstruct.get(cacheKey);
  if (cached) return cached;
  cacheStats.occurrencePresentationBuilds += 1;
  const rows = freeze(
    occurrenceRowsForConstruct(view, constructId).map((row) =>
      occurrenceRow(view, snapshot, row, showValue),
    ),
  );
  byConstruct.set(cacheKey, rows);
  return rows;
}

function activationLinks(view, snapshot, projection) {
  let byActivation = activationLinksCache.get(view);
  if (!byActivation) {
    byActivation = new Map();
    activationLinksCache.set(view, byActivation);
  }
  const cached = byActivation.get(projection.activationId);
  if (cached) return cached;
  cacheStats.activationLinkBuilds += 1;
  const links = [];
  const activation = snapshotActivation(snapshot, projection.activationId);
  if (!activation) return Object.freeze(links);
  if (projection.parentActivationId && activation.functionConstructId) {
    const range = constructRange(view, activation.functionConstructId, "binder");
    if (range) {
      links.push({
        kind: "parent",
        activationId: projection.parentActivationId,
        occurrenceId: activation.callsiteOccurrenceId,
        label: "caller",
        range,
      });
    }
  }
  for (const attempt of snapshotCallAttemptsForActivation(
    snapshot,
    projection.activationId,
  )) {
    const occurrence = snapshotOccurrence(snapshot, attempt.callOccurrenceId);
    const range = occurrence && constructRange(view, occurrence.constructId, "callee");
    for (const activationId of attempt.producerActivationIds || []) {
      const child = snapshotActivation(snapshot, activationId);
      if (range && child) {
        links.push({
          kind: "child",
          activationId,
          label: activationName(view, child),
          occurrenceId: occurrence.id,
          range,
        });
      }
    }
  }
  const result = freeze(links);
  byActivation.set(projection.activationId, result);
  return result;
}

export function buildExecutionViewModel(state) {
  const cached = viewModelCache.get(state);
  if (cached) return cached;
  const view = state.view;
  const snapshot = executionViewSnapshot(view);
  const selectedSelector = state.selection.selectorId
    ? executionViewProjectedSelector(view, state.selection.selectorId)
    : null;
  const selectedRange = executionViewSelectionRange(view, selectedSelector);
  const showExpressionValue = selectionHasExpressionValue(view, state.selection);
  const focusedValue = !showExpressionValue
    ? null
    : focusedOccurrenceValue(view, state.selection);
  const selectedWrite = snapshot
    && showExpressionValue
    ? writeForSelection(snapshot, state.selection)
    : null;
  const inspectionOutcome = writeOutcome(selectedWrite) || focusedValue?.outcome;
  const cursorInspection = selectedSelector
    ? {
        range: selectedRange,
        value: inspectionOutcome
          ? {
              occurrenceId: focusedValue?.occurrenceId || null,
              writeId: selectedWrite?.id || null,
              sequence: selectedWrite?.sequence || focusedValue?.sequence,
              outcome: displayOutcomeForConstruct(
                snapshot,
                state.selection.constructId,
                inspectionOutcome,
              ),
            }
          : null,
      }
    : null;
  const projection = projectActivation(view, state.selection);
  const coverage =
    snapshot && view.runtimeAuthority === "exact"
      ? activationCoverage(view, snapshot, projection)
      : [];
  const rows = snapshot
    ? occurrencePresentationRows(
        view,
        snapshot,
        state.selection.constructId,
        showExpressionValue,
      )
    : [];
  const selectedConstruct = state.selection.constructId
    ? snapshotConstruct(snapshot, state.selection.constructId)
    : null;
  const definedFunction =
    selectedConstruct?.semanticKind === "function" &&
    snapshotClosures(snapshot).some(
      (closure) => closure.functionConstructId === selectedConstruct.id,
    );
  const emptyReason = rows.length
    ? null
    : snapshot &&
        snapshotTerminal(snapshot).kind === "truncated" &&
        state.selection.constructId
      ? "trace-incomplete"
      : definedFunction
        ? "defined-not-called"
        : state.selection.constructId
          ? "unreached"
          : "no-selection";
  const model = freeze({
    authority: view.runtimeAuthority,
    evaluation: state.evaluation,
    selection: state.selection,
    cursorInspection,
    occurrenceList: {
      expression: selectedSelector
        ? executionViewSourceText(view, selectedRange)?.trim() || ""
        : "",
      count: rows.length,
      selectedActivationId: state.selection.activationId,
      selectedOccurrenceId: state.selection.focusedOccurrenceId,
      rows,
      emptyReason,
    },
    coverage,
    projection: projection
      ? {
          activationId: projection.activationId,
          coverage,
          annotationPlan: annotationPlan(
            view,
            snapshot,
            state,
            projection,
          ),
          links: activationLinks(view, snapshot, projection),
          returnValue: displayOutcome(projection.returnValue),
          parentActivationId: projection.parentActivationId,
          childActivationIds: projection.childActivationIds,
        }
      : null,
  });
  viewModelCache.set(state, model);
  return model;
}

export function buildExecutionUxOracle(state) {
  const model = buildExecutionViewModel(state);
  return freeze({
    authority: model.authority,
    focus: model.selection,
    lane: (model.projection?.annotationPlan || []).map((slot) => ({
      line: slot.line,
      persistent: slot.persistent,
      cursorCandidate: slot.cursor,
      effective: slot.effective,
    })),
    occurrenceList: model.occurrenceList,
    coverage: model.coverage,
    navigation: model.projection?.links || [],
  });
}

export function executionViewModelCacheStats() {
  return Object.freeze({ ...cacheStats });
}
