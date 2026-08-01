export function executionRecordOccurrences(events = []) {
  const occurrences = new Map();
  for (const event of events) {
    const occurrence = occurrences.get(event.occurrenceId) || {
      id: event.occurrenceId,
      children: [],
      parameters: [],
    };
    if (event.phase === "enter") {
      Object.assign(occurrence, event, { enterSequence: event.sequence });
    } else if (event.phase === "parameter") {
      occurrence.parameters.push({
        name: event.label,
        type: event.type,
        value: event.detail,
        sequence: event.sequence,
        path: event.path,
        line: event.line,
        column: event.column,
        endLine: event.endLine,
        endColumn: event.endColumn,
      });
    } else {
      occurrence.outcome = event.phase;
      occurrence.value = event.detail;
      occurrence.returnType = event.type;
      occurrence.endSequence = event.sequence;
    }
    occurrences.set(event.occurrenceId, occurrence);
  }
  for (const occurrence of occurrences.values()) {
    occurrence.rawParent = occurrence.parentId
      ? occurrences.get(occurrence.parentId) || null
      : null;
    occurrence.rawParent?.children.push(occurrence);
    occurrence.parameters.sort((left, right) => left.sequence - right.sequence);
  }
  return occurrences;
}

function nearestFunction(occurrence, calls) {
  let parent = occurrence?.rawParent;
  while (parent) {
    if (parent.kind === "function") return calls.get(parent.id) || null;
    parent = parent.rawParent;
  }
  return null;
}

export function executionCallBindings(call) {
  const bindings = [
    ...(call?.parameters || []),
    ...(call?.values || []).filter((value) => value.kind === "binding"),
  ];
  const seen = new Set();
  return bindings.filter((binding) => {
    const key = [
      binding.name,
      binding.path || call?.path,
      binding.line || call?.line,
      binding.column,
      binding.endLine || binding.line || call?.line,
      binding.endColumn,
    ].join(":");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function buildExecutionRecord(
  events = [],
  { rootLabel = (path) => path, rangeFor = null } = {},
) {
  const occurrences = executionRecordOccurrences(events);
  const calls = new Map();
  const roots = new Map();
  const rootFor = (path) => {
    const id = `root:${path}`;
    if (!roots.has(id)) {
      roots.set(id, {
        id,
        kind: "root",
        label: rootLabel(path),
        path,
        children: [],
        parameters: [],
        values: [],
        ownOccurrences: [],
      });
    }
    return roots.get(id);
  };

  const ordered = [...occurrences.values()]
    .filter(
      (occurrence) =>
        occurrence.phase === "enter" && occurrence.kind === "function",
    )
    .sort((left, right) => left.enterSequence - right.enterSequence)
    .map((occurrence) => {
      const call = {
        ...occurrence,
        children: [],
        values: [],
        ownOccurrences: [],
        range: rangeFor?.(occurrence) || {
          start: occurrence.line,
          end: occurrence.endLine || occurrence.line,
        },
      };
      calls.set(call.id, call);
      return call;
    });

  for (const call of ordered) {
    const parent = nearestFunction(call, calls) || rootFor(call.path);
    call.parent = parent;
    parent.children.push(call);
    let callsite = call.rawParent;
    while (callsite && callsite.kind !== "function") {
      if (callsite.kind === "call") break;
      callsite = callsite.rawParent;
    }
    if (callsite?.kind === "call") {
      call.callsite = callsite;
      call.callsitePath = callsite.path;
      call.callsiteLine = callsite.line;
      call.callsiteColumn = callsite.column;
      call.callsiteEndLine = callsite.endLine;
      call.callsiteEndColumn = callsite.endColumn;
      call.callsiteKey = callsite.siteId;
    }
  }

  for (const occurrence of occurrences.values()) {
    if (occurrence.phase !== "enter" || occurrence.kind === "function") {
      continue;
    }
    const owner = nearestFunction(occurrence, calls) || rootFor(occurrence.path);
    owner.ownOccurrences.push(occurrence);
    const usefulValue =
      occurrence.kind === "binding" ||
      (occurrence.kind === "value" &&
        /^[a-z_][A-Za-z0-9_']*$/.test(occurrence.label || ""));
    if (usefulValue && occurrence.value !== undefined) {
      owner.values.push({
        name: occurrence.label,
        kind: occurrence.kind,
        value: occurrence.value,
        type: occurrence.returnType || occurrence.type,
        path: occurrence.path,
        line: occurrence.line,
        column: occurrence.column,
        endLine: occurrence.endLine,
        endColumn: occurrence.endColumn,
        sequence: occurrence.enterSequence,
      });
    }
  }

  for (const call of ordered) {
    call.executedLines = new Set(
      call.ownOccurrences
        .filter((occurrence) => occurrence.path === call.path)
        .map((occurrence) => occurrence.line),
    );
    call.executedLines.add(call.line);
  }
  for (const root of roots.values()) {
    root.children.sort((left, right) => left.enterSequence - right.enterSequence);
  }
  return { calls, roots, occurrences };
}
