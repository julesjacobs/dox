const visiblePhases = new Set(["enter", "return", "raise"]);

export function executionTimelineEventKey(event) {
  return event
    ? [
        event.sequence,
        event.occurrenceId,
        event.phase,
        event.path,
        event.line,
      ].join("\x1f")
    : null;
}

export function executionTimelineEvents(
  callEvents = [],
  navigablePaths = null,
) {
  const paths = navigablePaths
    ? new Set(navigablePaths)
    : null;
  return callEvents
    .filter(
      (event) =>
        visiblePhases.has(event.phase) &&
        Number.isFinite(event.sequence) &&
        event.path &&
        (!paths || paths.has(event.path)) &&
        Number.isFinite(event.line) &&
        event.line > 0,
    )
    .sort((left, right) => left.sequence - right.sequence);
}

export function executionTimelineStops(
  stops = [],
  model = null,
  navigablePaths = null,
) {
  const paths = navigablePaths ? new Set(navigablePaths) : null;
  const calls = model
    ? [...model.calls.values()]
        .filter(
          (call) =>
            Number.isFinite(call.startIndex) &&
            Number.isFinite(call.endIndex),
        )
        .sort(
          (left, right) =>
            right.startIndex - left.startIndex ||
            (right.stackDepth || 0) - (left.stackDepth || 0),
        )
    : [];
  const events = stops
    .map((stop, sourceIndex) => {
      const call = calls.find(
        (candidate) =>
          sourceIndex >= candidate.startIndex &&
          sourceIndex <= candidate.endIndex &&
          stop.path === candidate.path,
      );
      const root = model?.roots.get(`root:${stop.path}`) || null;
      const owner = call || root;
      return {
        ...stop,
        sourceIndex,
        sequence: Number.isFinite(stop.time) ? stop.time : sourceIndex,
        occurrenceId: owner?.id || `stop:${sourceIndex}`,
        callId: owner?.id || null,
        phase: "stop",
        kind: owner?.kind === "function" ? "function" : "program",
        label: owner?.kind === "function" ? owner.label : "Program",
        endLine: stop.line,
        endColumn: stop.column,
      };
    })
    .filter(
      (event) =>
        event.path &&
        (!paths || paths.has(event.path)) &&
        Number.isFinite(event.line) &&
        event.line > 0,
    );
  const first = events[0];
  const root = first && model?.roots.get(`root:${first.path}`);
  if (!first || !root) return events;
  const caller = first.frames?.at(-1) || first;
  return [
    {
      path: caller.path || first.path,
      line: caller.line || first.line,
      column: caller.column || 0,
      endLine: caller.line || first.line,
      endColumn: caller.column || 0,
      sourceIndex: -1,
      sequence: first.sequence - 1,
      occurrenceId: root.id,
      callId: root.id,
      phase: "start",
      kind: "program",
      label: "Program",
      frames: [],
      locals: [],
    },
    ...events,
  ];
}

export function executionTimelinePosition(index, count) {
  if (count <= 1) return 0;
  return (Math.min(Math.max(index, 0), count - 1) / (count - 1)) * 100;
}

export function nearestExecutionTimelineIndex(events, sequence) {
  if (!events.length) return -1;
  let low = 0;
  let high = events.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = events[middle].sequence;
    if (candidate === sequence) return middle;
    if (candidate < sequence) low = middle + 1;
    else high = middle - 1;
  }
  if (low >= events.length) return events.length - 1;
  if (high < 0) return 0;
  return Math.abs(events[low].sequence - sequence) <
    Math.abs(events[high].sequence - sequence)
    ? low
    : high;
}

export function executionTimelineSpan(call, events) {
  if (!call || !events.length) {
    return null;
  }
  if (
    Number.isFinite(call.startIndex) &&
    Number.isFinite(call.endIndex) &&
    events.some((event) => Number.isFinite(event.sourceIndex))
  ) {
    const within = events
      .map((event, index) => ({ event, index }))
      .filter(
        ({ event }) =>
          event.sourceIndex >= call.startIndex &&
          event.sourceIndex <= call.endIndex,
      );
    if (!within.length) return null;
    return {
      start: within[0].index,
      end: within.at(-1).index,
    };
  }
  if (!Number.isFinite(call.enterSequence)) return null;
  const start = nearestExecutionTimelineIndex(events, call.enterSequence);
  const end = nearestExecutionTimelineIndex(
    events,
    Number.isFinite(call.endSequence)
      ? call.endSequence
      : call.enterSequence,
  );
  return {
    start: Math.min(start, end),
    end: Math.max(start, end),
  };
}

export function executionTimelineEventSite(event) {
  if (!event?.path || !Number.isFinite(event.line)) return null;
  const startColumn = Number.isFinite(event.column) ? event.column : 0;
  const endLine = Number.isFinite(event.endLine) ? event.endLine : event.line;
  const endColumn = Number.isFinite(event.endColumn)
    ? event.endColumn
    : startColumn;
  return {
    id:
      event.siteId ||
      [event.path, event.line, startColumn, endLine, endColumn].join(":"),
    path: event.path,
    startLine: event.line,
    startColumn,
    endLine,
    endColumn,
  };
}

function eventRangeKey(event) {
  const range = executionTimelineEventSite(event);
  if (!range) return "";
  return [
    range.startLine,
    range.startColumn,
    range.endLine,
    range.endColumn,
  ].join(":");
}

function cursorFocusForRange(range, position) {
  return {
    path: position.path,
    line: position.line,
    column: position.line === range.startLine ? range.startColumn : 0,
    endColumn:
      position.line === range.endLine
        ? range.endColumn
        : Number.MAX_SAFE_INTEGER,
  };
}

function containsRange(outer, inner) {
  return (
    (outer.startLine < inner.startLine ||
      (outer.startLine === inner.startLine &&
        outer.startColumn <= inner.startColumn)) &&
    (outer.endLine > inner.endLine ||
      (outer.endLine === inner.endLine &&
        outer.endColumn >= inner.endColumn))
  );
}

function rangeSize(range) {
  return (
    (range.endLine - range.startLine) * 1_000_000 +
    Math.max(0, range.endColumn - range.startColumn)
  );
}

function structuralApplicationMatches(events, position, selectedRange, fallback) {
  if (fallback?.kind !== "application") return [];
  const containingCalls = events
    .map((event, index) => ({ event, index, range: executionTimelineEventSite(event) }))
    .filter(
      ({ event, range }) =>
        event.path === position.path &&
        event.kind === "call" &&
        range &&
        containsRange(range, selectedRange),
    );
  if (containingCalls.length) {
    const smallestSize = Math.min(
      ...containingCalls.map(({ range }) => rangeSize(range)),
    );
    const smallest = containingCalls.find(
      ({ range }) => rangeSize(range) === smallestSize,
    )?.range;
    const key = smallest && [
      smallest.startLine,
      smallest.startColumn,
      smallest.endLine,
      smallest.endColumn,
    ].join(":");
    return containingCalls
      .filter(({ range }) =>
        [range.startLine, range.startColumn, range.endLine, range.endColumn].join(":") === key,
      )
      .map(({ index }) => index);
  }
  const fallbackKey = fallback.range && [
    fallback.range.startLine,
    fallback.range.startColumn,
    fallback.range.endLine,
    fallback.range.endColumn,
  ].join(":");
  return events
    .map((event, index) => ({ event, index }))
    .filter(
      ({ event }) =>
        event.path === position.path && eventRangeKey(event) === fallbackKey,
    )
    .map(({ index }) => index);
}

export function executionTimelineCursorTarget(events, position, staticRange) {
  if (
    !position?.path ||
    !Number.isFinite(position.line) ||
    !Number.isFinite(position.column)
  ) {
    return { indices: [], focus: null };
  }
  if (!staticRange) return { indices: [], focus: null };
  const selectedRange = {
    id:
      staticRange.id ||
      [
        position.path,
        staticRange.startLine,
        staticRange.startColumn,
        staticRange.endLine,
        staticRange.endColumn,
      ].join(":"),
    path: position.path,
    startLine: staticRange.startLine,
    startColumn: staticRange.startColumn,
    endLine: staticRange.endLine,
    endColumn: staticRange.endColumn,
  };
  const key = [
    selectedRange.startLine,
    selectedRange.startColumn,
    selectedRange.endLine,
    selectedRange.endColumn,
  ].join(":");
  const focusRange =
    staticRange.focus || staticRange.selection || selectedRange;
  let indices = events
    .map((event, index) => ({ event, index }))
    .filter(
      ({ event }) =>
        event.path === position.path && eventRangeKey(event) === key,
    )
    .map(({ index }) => index);
  if (!indices.length) {
    indices = structuralApplicationMatches(
      events,
      position,
      selectedRange,
      staticRange.executionFallback,
    );
  }
  return {
    indices,
    focus: cursorFocusForRange(focusRange, position),
    site: selectedRange,
  };
}

export function executionTimelineMatchIndices(events, position, staticRange) {
  return executionTimelineCursorTarget(events, position, staticRange).indices;
}

export function nearestExecutionTimelineMatch(matches, index) {
  if (!matches.length) return -1;
  return matches.reduce((nearest, candidate) => {
    const nearestDistance = Math.abs(nearest - index);
    const candidateDistance = Math.abs(candidate - index);
    return candidateDistance < nearestDistance ? candidate : nearest;
  });
}
