function cleanValue(value) {
  return String(value ?? "");
}

const recencyLimit = 2048;

function remember(map, key, stamp) {
  map.delete(key);
  map.set(key, stamp);
  while (map.size > recencyLimit) {
    map.delete(map.keys().next().value);
  }
}

export function executionChoiceSignature(choice) {
  if (!choice) return "";
  const { call, ownerCall, event, outcomeEvent } = choice;
  const activation = ownerCall || call;
  if (activation?.kind !== "root") {
    return JSON.stringify([
      activation?.path || event?.path || "",
      activation?.label || event?.label || "",
      (activation?.parameters || []).map((parameter) => [
        parameter.name || "",
        cleanValue(parameter.value),
        parameter.type || "",
      ]),
      activation?.outcome || "",
      cleanValue(activation?.value),
    ]);
  }
  if (call?.kind === "root") {
    return JSON.stringify([
      call.path || event?.path || "",
      event?.kind || "",
      event?.label || "",
      cleanValue(outcomeEvent?.detail ?? event?.detail),
      outcomeEvent?.phase || event?.phase || "",
    ]);
  }
  return "";
}

function activationKeys(choice, namespace = "") {
  if (!choice) return [];
  const activation = choice.ownerCall || choice.call;
  const keys = [
    activation?.kind === "root" ? null : activation?.id,
    choice.event?.occurrenceId,
  ].filter(Boolean);
  return namespace ? keys.map((key) => `${namespace}\x1f${key}`) : keys;
}

export function createExecutionRecency() {
  return {
    clock: 0,
    activations: new Map(),
    signatures: new Map(),
  };
}

export function noteExecutionChoice(recency, choice, { namespace = "" } = {}) {
  if (!recency || !choice) return;
  const stamp = ++recency.clock;
  for (const key of activationKeys(choice, namespace)) {
    remember(recency.activations, key, stamp);
  }
  const signature = executionChoiceSignature(choice);
  if (signature) remember(recency.signatures, signature, stamp);
}

export function executionChoiceStamp(
  recency,
  choice,
  { namespace = "" } = {},
) {
  if (!recency || !choice) return 0;
  const activationStamp = activationKeys(choice, namespace).reduce(
    (stamp, key) => Math.max(stamp, recency.activations.get(key) || 0),
    0,
  );
  const signature = executionChoiceSignature(choice);
  return Math.max(
    activationStamp,
    signature ? recency.signatures.get(signature) || 0 : 0,
  );
}

export function preferredExecutionChoice(
  choices,
  recency,
  { currentEventIndex = null, namespace = "" } = {},
) {
  if (!choices?.length) return null;
  return choices.reduce((preferred, choice) => {
    const choiceStamp = executionChoiceStamp(recency, choice, { namespace });
    const preferredStamp = executionChoiceStamp(recency, preferred, {
      namespace,
    });
    if (choiceStamp !== preferredStamp) {
      return choiceStamp > preferredStamp ? choice : preferred;
    }
    if (choice.eventIndex === currentEventIndex) return choice;
    if (preferred.eventIndex === currentEventIndex) return preferred;
    const origin = Number.isFinite(currentEventIndex) ? currentEventIndex : 0;
    return Math.abs(choice.eventIndex - origin) <
      Math.abs(preferred.eventIndex - origin)
      ? choice
      : preferred;
  }, choices[0]);
}
