import {
  snapshotActivation,
  snapshotActivationIdsForConstruct,
  snapshotChildActivationIds,
  snapshotConstruct,
  snapshotConstructIdsForScope,
  snapshotExecutedConstructIds,
  snapshotOccurrence,
  snapshotOccurrenceIdsForActivationConstruct,
  snapshotOccurrenceIdsForConstruct,
  snapshotTerminal,
  snapshotWritesForConstruct,
} from "./execution-artifact.js";
import {
  executionViewSelectorAt,
  executionViewProjectedSelector,
  executionViewSelectorsForConstruct,
  executionViewSnapshot,
  executionViewPositionAtOffset,
} from "./execution-view.js";

const empty = Object.freeze([]);
const projectionCache = new WeakMap();
const occurrenceRowsCache = new WeakMap();
const selectorAnchorCache = new WeakMap();

const structuralSelectorRoles = new Set([
  "alternative",
  "arrow",
  "do",
  "done",
  "else",
  "equals",
  "for",
  "fun",
  "function",
  "function-context",
  "if",
  "in",
  "let",
  "match",
  "rec",
  "then",
  "when",
  "while",
  "with",
]);

/** Structural syntax selects executions, but is not itself a value-producing expression. */
export function selectionHasExpressionValue(view, selection) {
  const selector = selection?.selectorId
    ? executionViewProjectedSelector(view, selection.selectorId)
    : null;
  const construct = selection?.constructId
    ? snapshotConstruct(executionViewSnapshot(view), selection.constructId)
    : null;
  return Boolean(
    selector &&
      !structuralSelectorRoles.has(selector.role) &&
      construct,
  );
}

function freezeSelection(selection) {
  return Object.freeze(selection);
}

export function emptyExecutionSelection() {
  return freezeSelection({
    selectorId: null,
    constructId: null,
    activationId: null,
    focusedOccurrenceId: null,
  });
}

export function resolveCursor(view, position) {
  const selector = executionViewSelectorAt(view, position);
  const snapshot = executionViewSnapshot(view);
  let status;
  let activationIds = empty;
  if (!snapshot) status = "unavailable";
  else if (!selector) status = view.hasDraft ? "unmapped-draft" : "unavailable";
  else if (view.runtimeAuthority === "stale") status = "stale";
  else {
    activationIds = snapshotActivationIdsForConstruct(
      snapshot,
      selector.subjectId,
    );
    const construct = snapshotConstruct(snapshot, selector.subjectId);
    if (construct?.semanticKind === "function") {
      activationIds = Object.freeze(
        activationIds.filter(
          (activationId) =>
            snapshotOccurrenceIdsForActivationConstruct(
              snapshot,
              activationId,
              selector.subjectId,
            ).length > 0,
        ),
      );
    }
    status = activationIds.length
      ? "reached"
      : snapshotTerminal(snapshot).kind === "truncated"
        ? "unknown"
        : "unreached";
  }
  return Object.freeze({
    position: Object.freeze({ ...position }),
    selectorId: selector?.id || null,
    constructId: selector?.subjectId || null,
    activationIds,
    status,
  });
}

function mostRecentActivation(activationIds, recency) {
  let winner = null;
  let winnerClock = -Infinity;
  for (const activationId of activationIds) {
    const clock = recency?.viewedAtByActivationId?.get?.(activationId) ?? -Infinity;
    if (clock > winnerClock) {
      winner = activationId;
      winnerClock = clock;
    }
  }
  return winner;
}

export function selectCursor(
  view,
  query,
  previousSelection = emptyExecutionSelection(),
  recency = null,
) {
  if (
    query.status !== "reached" ||
    !query.constructId ||
    !query.activationIds.length
  ) {
    return freezeSelection({
      selectorId: query.selectorId,
      constructId: query.constructId,
      activationId: null,
      focusedOccurrenceId: null,
    });
  }
  const snapshot = executionViewSnapshot(view);
  const activationsWithOccurrences = query.activationIds.filter(
    (activationId) =>
      snapshotOccurrenceIdsForActivationConstruct(
        snapshot,
        activationId,
        query.constructId,
      ).length > 0,
  );
  const preferredActivationIds = activationsWithOccurrences.length
    ? activationsWithOccurrences
    : query.activationIds;
  const activationId = preferredActivationIds.includes(
    previousSelection.activationId,
  )
    ? previousSelection.activationId
    : mostRecentActivation(preferredActivationIds, recency) ||
      preferredActivationIds[0];
  const occurrenceIds = semanticOccurrenceIds(
    snapshot,
    snapshotOccurrenceIdsForActivationConstruct(
      snapshot,
      activationId,
      query.constructId,
    ),
  );
  const selector = executionViewProjectedSelector(view, query.selectorId);
  const focusedOccurrenceId = selector?.role === "function-context"
    ? null
    : occurrenceIds.includes(previousSelection.focusedOccurrenceId)
      ? previousSelection.focusedOccurrenceId
      : occurrenceIds[0] || null;
  return freezeSelection({
    selectorId: query.selectorId,
    constructId: query.constructId,
    activationId,
    focusedOccurrenceId,
  });
}

export function selectActivation(view, selection, activationId) {
  const snapshot = executionViewSnapshot(view);
  const occurrenceIds = semanticOccurrenceIds(
    snapshot,
    snapshot && selection.constructId
      ? snapshotOccurrenceIdsForActivationConstruct(
          snapshot,
          activationId,
          selection.constructId,
        )
      : empty,
  );
  if (!occurrenceIds.length) {
    return Object.freeze({
      selection,
      accepted: false,
      decision: "activation-does-not-reach-construct",
    });
  }
  return Object.freeze({
    selection: freezeSelection({
      ...selection,
      activationId,
      focusedOccurrenceId: occurrenceIds.includes(selection.focusedOccurrenceId)
        ? selection.focusedOccurrenceId
        : occurrenceIds[0],
    }),
    accepted: true,
    decision: "activation-selected",
  });
}

function occurrenceSelection(view, occurrenceId, preferredRole = null) {
  const snapshot = executionViewSnapshot(view);
  const occurrence = snapshot && snapshotOccurrence(snapshot, occurrenceId);
  if (!occurrence) {
    return Object.freeze({
      selection: emptyExecutionSelection(),
      moveCursorTo: null,
      cursorAnchor: null,
      accepted: false,
      decision: "occurrence-missing",
    });
  }
  const selectors = executionViewSelectorsForConstruct(
    view,
    occurrence.constructId,
  );
  const preferred = preferredRole
    ? selectors.find((candidate) => candidate.role === preferredRole)
    : null;
  const candidates = preferred
    ? [preferred, ...selectors.filter((candidate) => candidate !== preferred)]
    : selectors;
  let selector = candidates[0] || null;
  let cursorAnchor = null;
  for (const candidate of candidates) {
    // Zero-width function-context selectors are useful as a reducer fallback,
    // but they are not a visible navigation target when a concrete selector
    // for the same construct exists.
    if (candidate.range.end <= candidate.range.start) continue;
    let anchors = selectorAnchorCache.get(view);
    if (!anchors) {
      anchors = new Map();
      selectorAnchorCache.set(view, anchors);
    }
    if (anchors.has(candidate.id)) cursorAnchor = anchors.get(candidate.id);
    else {
      for (
        let offset = candidate.range.start;
        // A construct may deliberately own only its completion boundary (for
        // example a match arm or lambda at end of line).  Cursor positions are
        // boundaries, so include range.end when finding a navigation anchor.
        offset <= candidate.range.end;
        offset += 1
      ) {
        const position = executionViewPositionAtOffset(
          view,
          candidate.range.path,
          offset,
        );
        if (
          position &&
          executionViewSelectorAt(view, position)?.subjectId ===
            occurrence.constructId
        ) {
          cursorAnchor = Object.freeze(position);
          break;
        }
      }
      anchors.set(candidate.id, cursorAnchor);
    }
    if (cursorAnchor) {
      selector = candidate;
      break;
    }
  }
  return Object.freeze({
    selection: freezeSelection({
      selectorId: selector?.id || null,
      constructId: occurrence.constructId,
      activationId: occurrence.activationId,
      focusedOccurrenceId: occurrence.id,
    }),
    moveCursorTo: selector?.range || null,
    cursorAnchor,
    accepted: true,
    decision: "occurrence-selected",
  });
}

export function selectOccurrence(view, occurrenceId) {
  return occurrenceSelection(view, occurrenceId);
}

export function navigateActivation(view, activationId) {
  const snapshot = executionViewSnapshot(view);
  const activation = snapshot && snapshotActivation(snapshot, activationId);
  if (!activation) {
    return Object.freeze({
      selection: emptyExecutionSelection(),
      moveCursorTo: null,
      cursorAnchor: null,
      accepted: false,
      decision: "activation-missing",
    });
  }
  if (activation.functionOccurrenceId) {
    return occurrenceSelection(view, activation.functionOccurrenceId, "binder");
  }
  if (activation.callsiteOccurrenceId) {
    const selected = occurrenceSelection(view, activation.callsiteOccurrenceId);
    return Object.freeze({ ...selected, decision: "activation-callsite-selected" });
  }
  return Object.freeze({
    selection: emptyExecutionSelection(),
    moveCursorTo: null,
    cursorAnchor: null,
    accepted: false,
    decision: "activation-has-no-source-occurrence",
  });
}

export function occurrenceHasUserValue(occurrence) {
  return Boolean(
    occurrence &&
      occurrence.kind !== "boundary" &&
      occurrence.outcome?.kind !== "incomplete",
  );
}

function occurrenceValue(snapshot, occurrenceId) {
  const occurrence = snapshotOccurrence(snapshot, occurrenceId);
  const occurrenceIds = snapshotOccurrenceIdsForActivationConstruct(
    snapshot,
    occurrence.activationId,
    occurrence.constructId,
  );
  const index = occurrenceIds.indexOf(occurrenceId);
  const write = snapshotWritesForConstruct(snapshot, occurrence.constructId)
    .filter((candidate) => candidate.activationId === occurrence.activationId)
    [Math.max(0, index)];
  if (!occurrenceHasUserValue(occurrence)) return null;
  return Object.freeze({
    occurrenceId,
    sequence: write?.sequence || occurrence.enteredAt,
    outcome: write
      ? Object.freeze({
          kind: "return",
          value: write.newValue,
          source: "runtime",
        })
      : occurrence.outcome,
  });
}

function semanticOccurrenceIds(snapshot, occurrenceIds) {
  const runtimeKeys = new Set(
    occurrenceIds.flatMap((occurrenceId) => {
      const occurrence = snapshotOccurrence(snapshot, occurrenceId);
      return occurrence && occurrence.kind !== "parameter"
        ? [`${occurrence.activationId}\u001f${occurrence.constructId}`]
        : [];
    }),
  );
  return occurrenceIds.filter((occurrenceId) => {
    const occurrence = snapshotOccurrence(snapshot, occurrenceId);
    return (
      occurrence?.kind !== "parameter" ||
      !runtimeKeys.has(`${occurrence.activationId}\u001f${occurrence.constructId}`)
    );
  });
}

export function valuesAt(view, selection, { offset = 0, limit = 50 } = {}) {
  const snapshot = executionViewSnapshot(view);
  if (
    !snapshot ||
    view.runtimeAuthority !== "exact" ||
    !selection.activationId ||
    !selection.constructId ||
    !selectionHasExpressionValue(view, selection)
  ) {
    return Object.freeze({ values: empty, total: 0 });
  }
  const occurrenceIds = semanticOccurrenceIds(
    snapshot,
    snapshotOccurrenceIdsForActivationConstruct(
      snapshot,
      selection.activationId,
      selection.constructId,
    ),
  );
  const values = occurrenceIds
    .map((occurrenceId) => occurrenceValue(snapshot, occurrenceId))
    .filter(Boolean);
  return Object.freeze({
    values: Object.freeze(
      values
        .slice(Math.max(0, offset), Math.max(0, offset) + Math.max(0, limit))
    ),
    total: values.length,
  });
}

export function focusedOccurrenceValue(view, selection) {
  const snapshot = executionViewSnapshot(view);
  if (
    !snapshot ||
    view.runtimeAuthority !== "exact" ||
    !selectionHasExpressionValue(view, selection)
  ) return null;
  const occurrence = selection.focusedOccurrenceId
    ? snapshotOccurrence(snapshot, selection.focusedOccurrenceId)
    : null;
  if (
    occurrence &&
    occurrence.activationId === selection.activationId &&
    occurrence.constructId === selection.constructId
  ) {
    return occurrenceValue(snapshot, occurrence.id);
  }
  return valuesAt(view, selection, { offset: 0, limit: 1 }).values[0] || null;
}

/** Every dynamic occurrence stays distinct, including repeats in one activation. */
export function occurrenceRowsForConstruct(view, constructId) {
  const snapshot = executionViewSnapshot(view);
  if (!snapshot || view.runtimeAuthority !== "exact" || !constructId) return empty;
  let byConstruct = occurrenceRowsCache.get(view);
  if (!byConstruct) {
    byConstruct = new Map();
    occurrenceRowsCache.set(view, byConstruct);
  }
  const cached = byConstruct.get(constructId);
  if (cached) return cached;
  const occurrenceIds = semanticOccurrenceIds(
    snapshot,
    snapshotOccurrenceIdsForConstruct(snapshot, constructId),
  );
  const counts = new Map();
  for (const occurrenceId of occurrenceIds) {
    const occurrence = snapshotOccurrence(snapshot, occurrenceId);
    counts.set(
      occurrence.activationId,
      (counts.get(occurrence.activationId) || 0) + 1,
    );
  }
  const ordinals = new Map();
  const rows = Object.freeze(
    occurrenceIds.map((occurrenceId) => {
      const occurrence = snapshotOccurrence(snapshot, occurrenceId);
      const ordinal = (ordinals.get(occurrence.activationId) || 0) + 1;
      ordinals.set(occurrence.activationId, ordinal);
      return Object.freeze({
        occurrence,
        activation: snapshotActivation(snapshot, occurrence.activationId),
        ordinal,
        totalInActivation: counts.get(occurrence.activationId),
      });
    }),
  );
  byConstruct.set(constructId, rows);
  return rows;
}

export function projectActivation(view, selection) {
  const snapshot = executionViewSnapshot(view);
  if (
    !snapshot ||
    view.runtimeAuthority !== "exact" ||
    !selection.activationId
  ) {
    return null;
  }
  const activation = snapshotActivation(snapshot, selection.activationId);
  if (!activation) return null;
  let byActivation = projectionCache.get(view);
  if (!byActivation) {
    byActivation = new Map();
    projectionCache.set(view, byActivation);
  }
  const cached = byActivation.get(activation.id);
  if (cached) return cached;
  const owned = snapshotConstructIdsForScope(snapshot, activation.scopeId);
  const traceComplete = snapshotTerminal(snapshot).kind === "complete";
  const activationComplete =
    traceComplete ||
    (activation.functionConstructId &&
      activation.outcomeAt !== null &&
      activation.outcome?.kind !== "incomplete");
  const ownedSet = new Set(owned);
  let active = new Set(
    snapshotExecutedConstructIds(snapshot, activation.id).filter((id) =>
      ownedSet.has(id),
    ),
  );
  // Closure creation belongs to the enclosing scope. Its function occurrence
  // still forms the explicit root boundary of this activation.
  if (activation.functionConstructId) active.add(activation.functionConstructId);
  const globallyUnreached = new Set(
    traceComplete
      ? owned.filter(
          (constructId) =>
            snapshotActivationIdsForConstruct(snapshot, constructId).length === 0,
        )
      : [],
  );
  if (!activation.functionConstructId && traceComplete) {
    active = new Set(owned.filter((constructId) => !globallyUnreached.has(constructId)));
  }
  const inactive = new Set(
    activationComplete
      ? owned.filter(
          (constructId) =>
            !active.has(constructId) && !globallyUnreached.has(constructId),
        )
      : [],
  );
  const bindingValues = (activation.occurrenceIds || [])
    .map((occurrenceId) => snapshotOccurrence(snapshot, occurrenceId))
    .filter((occurrence) => {
      if (occurrence?.kind !== "binder" && occurrence?.kind !== "pattern") {
        return false;
      }
      const pattern = snapshotConstruct(snapshot, occurrence.constructId);
      const parent = pattern?.parentId
        ? snapshotConstruct(snapshot, pattern.parentId)
        : null;
      const topLevelBindingPattern =
        pattern?.category === "pattern" &&
        pattern.parentId === null &&
        activation.functionConstructId === null &&
        pattern.ownerScopeId === activation.scopeId;
      return parent?.semanticKind === "binding" || topLevelBindingPattern;
    })
    .map((occurrence) => occurrenceValue(snapshot, occurrence.id))
    .filter(Boolean);
  const projection = Object.freeze({
    activationId: activation.id,
    activeConstructIds: Object.freeze([...active]),
    inactiveConstructIds: Object.freeze([...inactive]),
    globallyUnreachedConstructIds: Object.freeze([...globallyUnreached]),
    bindingValues: Object.freeze(bindingValues),
    returnValue: activation.outcome,
    parentActivationId: activation.dynamicParentId,
    childActivationIds: snapshotChildActivationIds(snapshot, activation.id),
  });
  byActivation.set(activation.id, projection);
  return projection;
}

export function executionChoicesAt(view, position) {
  const query = resolveCursor(view, position);
  const snapshot = executionViewSnapshot(view);
  if (!snapshot || query.status !== "reached") return empty;
  return Object.freeze(
    query.activationIds.map((activationId) => {
      const activation = snapshotActivation(snapshot, activationId);
      const values = semanticOccurrenceIds(
        snapshot,
        snapshotOccurrenceIdsForActivationConstruct(
          snapshot,
          activationId,
          query.constructId,
        ),
      )
        .map((occurrenceId) => occurrenceValue(snapshot, occurrenceId))
        .filter(Boolean);
      return Object.freeze({ activation, values: Object.freeze(values) });
    }),
  );
}
