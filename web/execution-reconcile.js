import {
  snapshotActivation,
  snapshotActivationIdsForConstruct,
  snapshotActivations,
  snapshotConstruct,
  snapshotConstructs,
  snapshotOccurrence,
  snapshotOccurrenceIdsForActivationConstruct,
  snapshotSelector,
  snapshotSelectors,
} from "./execution-artifact.js";
import { emptyExecutionSelection } from "./execution-query.js";
import { executionViewSnapshot } from "./execution-view.js";

const compareText = (left, right) =>
  left < right ? -1 : left > right ? 1 : 0;

function staticConstructKey(construct) {
  return construct
    ? [
        construct.category,
        construct.syntaxFingerprint,
        construct.lexicalAncestryFingerprint,
      ].join("\u001f")
    : "-";
}

function activationKey(snapshot, activation, cache = new Map(), stack = new Set()) {
  if (!activation) return "-";
  if (cache.has(activation.id)) return cache.get(activation.id);
  if (stack.has(activation.id)) return `cycle:${activation.id}`;
  stack.add(activation.id);
  const functionConstruct = activation.functionConstructId
    ? snapshotConstruct(snapshot, activation.functionConstructId)
    : null;
  const callsiteOccurrence = activation.callsiteOccurrenceId
    ? snapshotOccurrence(snapshot, activation.callsiteOccurrenceId)
    : null;
  const callsiteConstruct = callsiteOccurrence
    ? snapshotConstruct(snapshot, callsiteOccurrence.constructId)
    : null;
  const parent = activation.dynamicParentId
    ? snapshotActivation(snapshot, activation.dynamicParentId)
    : null;
  const key = JSON.stringify({
    function: functionConstruct
      ? staticConstructKey(functionConstruct)
      : activation.signature?.functionKey || "-",
    callsite: staticConstructKey(callsiteConstruct),
    parameters: activation.signature?.parameterFingerprints || [],
    outcome: activation.signature?.outcomeFingerprint || null,
    parent: parent ? activationKey(snapshot, parent, cache, stack) : null,
  });
  stack.delete(activation.id);
  cache.set(activation.id, key);
  return key;
}

function preferredCandidate(candidates, recency, reconciliationKey) {
  let winner = null;
  let winnerClock = -Infinity;
  for (const candidate of candidates) {
    const activationClock =
      recency?.viewedAtByActivationId?.get?.(candidate.id) ?? -Infinity;
    const keyClock =
      recency?.viewedAtByReconciliationKey?.get?.(reconciliationKey) ??
      -Infinity;
    const clock = Math.max(activationClock, keyClock);
    if (clock > winnerClock) {
      winner = candidate;
      winnerClock = clock;
    }
  }
  return winner || candidates[0] || null;
}

function constructCandidates(oldConstruct, newSnapshot) {
  const exact = snapshotConstructs(newSnapshot).filter(
    (candidate) => staticConstructKey(candidate) === staticConstructKey(oldConstruct),
  );
  if (exact.length) return exact;
  return snapshotConstructs(newSnapshot).filter(
    (candidate) =>
      candidate.category === oldConstruct.category &&
      candidate.syntaxFingerprint === oldConstruct.syntaxFingerprint,
  );
}

function selectorForCandidate(oldSelector, constructId, newSnapshot) {
  return snapshotSelectors(newSnapshot)
    .filter(
      (selector) =>
        selector.subjectId === constructId && selector.role === oldSelector.role,
    )
    .sort(
      (left, right) =>
        right.priority - left.priority ||
        left.tieBreakRank - right.tieBreakRank ||
        compareText(left.id, right.id),
    )[0];
}

function compareConstructSource(left, right) {
  return (
    compareText(left.compilerRange.generatedPath, right.compilerRange.generatedPath) ||
    left.compilerRange.startByte - right.compilerRange.startByte ||
    left.compilerRange.endByte - right.compilerRange.endByte ||
    compareText(left.id, right.id)
  );
}

function constructExecutionPreference(
  snapshot,
  candidate,
  oldActivation,
  oldActivationKey,
  recency,
) {
  const reaching = snapshotActivationIdsForConstruct(snapshot, candidate.construct.id)
    .map((id) => snapshotActivation(snapshot, id));
  const exact = oldActivation
    ? reaching.filter(
        (activation) => activationKey(snapshot, activation) === oldActivationKey,
      )
    : [];
  const signature = oldActivation && !exact.length
    ? reaching.filter(
        (activation) =>
          JSON.stringify(activation.signature?.parameterFingerprints || []) ===
            JSON.stringify(oldActivation.signature?.parameterFingerprints || []) &&
          activation.signature?.outcomeFingerprint ===
            oldActivation.signature?.outcomeFingerprint,
      )
    : [];
  const preferred = exact.length ? exact : signature.length ? signature : reaching;
  const rank = exact.length ? 0 : signature.length ? 1 : reaching.length ? 2 : 3;
  const keyClock = recency?.viewedAtByReconciliationKey?.get?.(oldActivationKey)
    ?? -Infinity;
  const clock = preferred.reduce(
    (latest, activation) =>
      Math.max(
        latest,
        recency?.viewedAtByActivationId?.get?.(activation.id) ?? -Infinity,
        keyClock,
      ),
    -Infinity,
  );
  const enteredAt = preferred.reduce(
    (earliest, activation) => Math.min(earliest, activation.enteredAt),
    Infinity,
  );
  return { rank, clock, enteredAt };
}

export function activationReconciliationKey(snapshot, activationId) {
  return activationKey(snapshot, snapshotActivation(snapshot, activationId));
}

export function reconcileSelection(
  oldView,
  newView,
  selection,
  recency = null,
) {
  const oldSnapshot = executionViewSnapshot(oldView);
  const newSnapshot = executionViewSnapshot(newView);
  if (!oldSnapshot || !newSnapshot || !selection?.constructId) {
    return Object.freeze({
      selection: emptyExecutionSelection(),
      decision: "reconcile-no-anchor",
      ambiguous: false,
    });
  }
  const oldConstruct = snapshotConstruct(oldSnapshot, selection.constructId);
  const oldSelector = selection.selectorId
    ? snapshotSelector(oldSnapshot, selection.selectorId)
    : null;
  if (!oldConstruct || !oldSelector) {
    return Object.freeze({
      selection: emptyExecutionSelection(),
      decision: "reconcile-anchor-missing",
      ambiguous: false,
    });
  }
  const oldActivation = selection.activationId
    ? snapshotActivation(oldSnapshot, selection.activationId)
    : null;
  const oldActivationKey = activationKey(oldSnapshot, oldActivation);
  const candidates = constructCandidates(oldConstruct, newSnapshot)
    .map((construct) => ({
      construct,
      selector: selectorForCandidate(oldSelector, construct.id, newSnapshot),
    }))
    .filter((candidate) => candidate.selector)
    .map((candidate) => ({
      ...candidate,
      preference: constructExecutionPreference(
        newSnapshot,
        candidate,
        oldActivation,
        oldActivationKey,
        recency,
      ),
    }))
    .sort(
      (left, right) =>
        left.preference.rank - right.preference.rank ||
        right.preference.clock - left.preference.clock ||
        left.preference.enteredAt - right.preference.enteredAt ||
        compareConstructSource(left.construct, right.construct),
    );
  if (!candidates.length) {
    return Object.freeze({
      selection: emptyExecutionSelection(),
      decision: "reconcile-construct-missing",
      ambiguous: false,
    });
  }
  const chosenConstruct = candidates[0];
  const reachingIds = snapshotActivationIdsForConstruct(
    newSnapshot,
    chosenConstruct.construct.id,
  );
  if (!selection.activationId || !reachingIds.length) {
    return Object.freeze({
      selection: Object.freeze({
        selectorId: chosenConstruct.selector.id,
        constructId: chosenConstruct.construct.id,
        activationId: null,
        focusedOccurrenceId: null,
      }),
      decision: reachingIds.length
        ? "reconcile-construct"
        : "reconcile-construct-unreached",
      ambiguous: candidates.length > 1,
    });
  }
  const reaching = reachingIds.map((id) => snapshotActivation(newSnapshot, id));
  let activationCandidates = reaching.filter(
    (activation) => activationKey(newSnapshot, activation) === oldActivationKey,
  );
  if (!activationCandidates.length && oldActivation) {
    activationCandidates = reaching.filter(
      (activation) =>
        JSON.stringify(activation.signature?.parameterFingerprints || []) ===
          JSON.stringify(oldActivation.signature?.parameterFingerprints || []) &&
        activation.signature?.outcomeFingerprint ===
          oldActivation.signature?.outcomeFingerprint,
    );
  }
  if (!activationCandidates.length) activationCandidates = reaching;
  const chosenActivation = preferredCandidate(
    activationCandidates,
    recency,
    oldActivationKey,
  );
  const oldOccurrenceIds = oldActivation
    ? snapshotOccurrenceIdsForActivationConstruct(
        oldSnapshot,
        oldActivation.id,
        oldConstruct.id,
      )
    : [];
  const oldOrdinal = Math.max(
    0,
    oldOccurrenceIds.indexOf(selection.focusedOccurrenceId),
  );
  const oldOccurrence = selection.focusedOccurrenceId
    ? snapshotOccurrence(oldSnapshot, selection.focusedOccurrenceId)
    : null;
  const newOccurrenceIds = snapshotOccurrenceIdsForActivationConstruct(
    newSnapshot,
    chosenActivation.id,
    chosenConstruct.construct.id,
  );
  const sameOutcome = oldOccurrence
    ? newOccurrenceIds.filter((id) => {
        const occurrence = snapshotOccurrence(newSnapshot, id);
        return (
          occurrence?.outcome?.value?.fingerprint ===
          oldOccurrence.outcome?.value?.fingerprint
        );
      })
    : [];
  const oldOutcomeOrdinal = oldOccurrence
    ? oldOccurrenceIds
        .slice(0, oldOrdinal + 1)
        .filter((id) => {
          const occurrence = snapshotOccurrence(oldSnapshot, id);
          return (
            occurrence?.outcome?.value?.fingerprint ===
            oldOccurrence.outcome?.value?.fingerprint
          );
        }).length - 1
    : 0;
  const focusedOccurrenceId =
    sameOutcome[Math.min(oldOutcomeOrdinal, sameOutcome.length - 1)] ||
    newOccurrenceIds[Math.min(oldOrdinal, newOccurrenceIds.length - 1)] ||
    null;
  const ambiguous =
    candidates.length > 1 || activationCandidates.length > 1;
  return Object.freeze({
    selection: Object.freeze({
      selectorId: chosenConstruct.selector.id,
      constructId: chosenConstruct.construct.id,
      activationId: chosenActivation.id,
      focusedOccurrenceId,
    }),
    decision: ambiguous
      ? "reconcile-ambiguous"
      : sameOutcome.length
        ? "reconcile-exact"
        : "reconcile-occurrence-nearest",
    ambiguous,
  });
}
