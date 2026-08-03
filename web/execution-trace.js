function compareText(left, right) {
  const leftText = String(left ?? "");
  const rightText = String(right ?? "");
  return leftText < rightText ? -1 : leftText > rightText ? 1 : 0;
}

export function executionTraceNavigationTarget(targetId) {
  const id = String(targetId || "");
  const occurrencePrefix = "occurrence:";
  return Object.freeze(
    id.startsWith(occurrencePrefix)
      ? { kind: "occurrence", id: id.slice(occurrencePrefix.length) }
      : { kind: "activation", id },
  );
}

function completedAt(item, finalSequence) {
  return Number.isInteger(item.outcomeAt) ? item.outcomeAt : finalSequence;
}

function containsSequence(item, sequence, finalSequence) {
  return (
    item.enteredAt <= sequence && sequence <= completedAt(item, finalSequence)
  );
}

function eventOwner(activations, event, finalSequence) {
  let owner = null;
  for (const activation of activations) {
    if (!containsSequence(activation, event.sequence, finalSequence)) continue;
    if (
      !owner ||
      activation.enteredAt > owner.enteredAt ||
      (activation.enteredAt === owner.enteredAt &&
        completedAt(activation, finalSequence) <
          completedAt(owner, finalSequence))
    ) {
      owner = activation;
    }
  }
  return owner;
}

function eventOccurrence(occurrences, owner, event, finalSequence) {
  let winner = null;
  for (const occurrence of occurrences) {
    if (
      (owner && occurrence.activationId !== owner.id) ||
      !containsSequence(occurrence, event.sequence, finalSequence)
    ) {
      continue;
    }
    const callPreference = Number(occurrence.kind === "call");
    const winnerCallPreference = Number(winner?.kind === "call");
    if (
      !winner ||
      callPreference > winnerCallPreference ||
      (callPreference === winnerCallPreference &&
        (occurrence.enteredAt > winner.enteredAt ||
          (occurrence.enteredAt === winner.enteredAt &&
            completedAt(occurrence, finalSequence) <
              completedAt(winner, finalSequence))))
    ) {
      winner = occurrence;
    }
  }
  return winner;
}

/**
 * Build one deterministic dynamic tree. Function activations are nodes; output
 * events are assigned to the deepest active activation and source occurrence.
 */
export function buildExecutionTraceStructure({
  activations,
  occurrences,
  events,
  finalSequence,
}) {
  const orderedActivations = [...activations].sort(
    (left, right) =>
      left.enteredAt - right.enteredAt || compareText(left.id, right.id),
  );
  const functionActivations = orderedActivations.filter(
    (activation) => activation.functionConstructId,
  );
  const activationById = new Map(
    orderedActivations.map((activation) => [activation.id, activation]),
  );
  const occurrenceById = new Map(
    occurrences.map((occurrence) => [occurrence.id, occurrence]),
  );
  const children = new Map();
  const addChild = (parentId, item) => {
    if (!children.has(parentId)) children.set(parentId, []);
    children.get(parentId).push(item);
  };

  for (const activation of functionActivations) {
    const parent = activationById.get(activation.dynamicParentId);
    addChild(parent?.id || null, {
      kind: "activation",
      sequence: activation.enteredAt,
      activation,
    });
  }

  for (const event of [...events].sort(
    (left, right) =>
      left.sequence - right.sequence ||
      compareText(left.kind, right.kind) ||
      compareText(left.id, right.id),
  )) {
    const markedOccurrence = event.parentOccurrenceId
      ? occurrenceById.get(event.parentOccurrenceId) || null
      : null;
    const markedActivation = markedOccurrence
      ? activationById.get(markedOccurrence.activationId) || null
      : null;
    const activeFunction = markedActivation || eventOwner(
      functionActivations,
      event,
      finalSequence,
    );
    const occurrence = markedOccurrence || (activeFunction
      ? eventOccurrence(occurrences, activeFunction, event, finalSequence)
      : eventOccurrence(occurrences, null, event, finalSequence));
    const owner = activeFunction ||
      (occurrence
        ? activationById.get(occurrence.activationId) || null
        : eventOwner(orderedActivations, event, finalSequence));
    addChild(owner?.id || null, {
      kind: "output",
      sequence: event.sequence,
      activationId: owner?.id || null,
      occurrenceId: occurrence?.id || null,
      event,
    });
  }

  for (const items of children.values()) {
    items.sort(
      (left, right) =>
        left.sequence - right.sequence ||
        Number(left.kind === "output") - Number(right.kind === "output") ||
        compareText(
          left.activation?.id || left.event?.id,
          right.activation?.id || right.event?.id,
        ),
    );
  }

  const rows = [];
  const appendChildren = (parentId, depth, ancestors) => {
    for (const item of children.get(parentId) || []) {
      if (item.kind === "activation") {
        if (ancestors.has(item.activation.id)) continue;
        rows.push(Object.freeze({ ...item, depth }));
        appendChildren(
          item.activation.id,
          depth + 1,
          new Set([...ancestors, item.activation.id]),
        );
      } else {
        rows.push(Object.freeze({ ...item, depth }));
      }
    }
  };

  const rootActivations = orderedActivations.filter(
    (activation) => !activation.functionConstructId,
  );
  if (rootActivations.length) {
    for (const root of rootActivations) appendChildren(root.id, 0, new Set());
  } else {
    appendChildren(null, 0, new Set());
  }
  return Object.freeze(rows);
}
