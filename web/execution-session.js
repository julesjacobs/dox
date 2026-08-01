import {
  executionTimelineCursorTarget,
  executionTimelineEventSite,
  executionTimelineEventKey,
  nearestExecutionTimelineMatch,
  nearestExecutionTimelineIndex,
} from "./execution-timeline.js";

const clampIndex = (index, length) =>
  length ? Math.min(Math.max(Number(index) || 0, 0), length - 1) : 0;

const emptyFocus = () => ({
  site: null,
  range: null,
  eventIndex: null,
  matches: [],
});

function focusForEvent(events, index) {
  if (!events?.length || !Number.isFinite(Number(index))) return emptyFocus();
  const eventIndex = clampIndex(index, events.length);
  const site = executionTimelineEventSite(events[eventIndex]);
  if (!site) return { ...emptyFocus(), eventIndex };
  const target = executionTimelineCursorTarget(
    events,
    {
      path: site.path,
      line: site.startLine,
      column: site.startColumn,
    },
    site,
  );
  return {
    site,
    range: target.focus,
    eventIndex,
    matches: target.indices,
  };
}

function eventSelectionKey(event) {
  return event
    ? [
        event.path,
        event.line,
        event.column ?? 0,
        event.endLine ?? event.line,
        event.endColumn ?? event.column ?? 0,
        event.phase,
        event.kind || "",
        event.label || "",
      ].join("\x1f")
    : null;
}

function selectionAnchor(session, { includeOccurrenceId = true } = {}) {
  const eventIndex = session?.focus?.eventIndex;
  const event = Number.isFinite(eventIndex)
    ? session.events?.[eventIndex]
    : null;
  const key = eventSelectionKey(event);
  if (!event || !key) return null;
  const matches = (session.events || []).filter(
    (candidate) => eventSelectionKey(candidate) === key,
  );
  return {
    key,
    path: event.path,
    line: event.line,
    column: event.column ?? 0,
    endLine: event.endLine ?? event.line,
    endColumn: event.endColumn ?? event.column ?? 0,
    occurrenceId: includeOccurrenceId ? event.occurrenceId : null,
    phase: event.phase,
    kind: event.kind || "",
    label: event.label || "",
    sequence: event.sequence,
    ordinal: Math.max(0, matches.indexOf(event)),
    count: matches.length,
  };
}

function mapSelectionAnchor(anchor, mapAnchor) {
  if (!anchor || !mapAnchor || !Number.isFinite(anchor.line)) return anchor;
  const mapped = mapAnchor(anchor);
  if (!mapped) return anchor;
  const next = {
    ...anchor,
    path: mapped.path ?? anchor.path,
    line: mapped.line ?? anchor.line,
    column: mapped.column ?? anchor.column,
    endLine: mapped.endLine ?? mapped.line ?? anchor.endLine,
    endColumn: mapped.endColumn ?? mapped.column ?? anchor.endColumn,
  };
  return { ...next, key: eventSelectionKey(next) };
}

function reconciledEventIndex(events, anchor) {
  if (!anchor) return -1;
  if (anchor.occurrenceId) {
    const sameOccurrence = events
      .map((event, index) => ({ event, index }))
      .filter(({ event }) => event.occurrenceId === anchor.occurrenceId);
    const sameEvent = sameOccurrence.find(
      ({ event }) =>
        event.phase === anchor.phase &&
        (event.kind || "") === anchor.kind &&
        (event.label || "") === anchor.label,
    );
    if (sameEvent) return sameEvent.index;
    const entry = sameOccurrence.find(({ event }) => event.phase === "enter");
    if (entry) return entry.index;
    if (sameOccurrence.length) return sameOccurrence[0].index;
  }
  const candidates = events
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => eventSelectionKey(event) === anchor.key);
  if (!candidates.length) return -1;
  const ordinal =
    anchor.count > 1 && candidates.length > 1
      ? Math.round(
          (anchor.ordinal * (candidates.length - 1)) / (anchor.count - 1),
        )
      : Math.min(anchor.ordinal, candidates.length - 1);
  return candidates[Math.min(Math.max(ordinal, 0), candidates.length - 1)].index;
}

export function executionSessionReconcileFocus(
  session,
  previous,
  { mapAuthoritativeSelection = null } = {},
) {
  if (!session) return session;
  const anchor = mapSelectionAnchor(
    previous?.authoritativeSelectionAnchor ?? selectionAnchor(previous),
    mapAuthoritativeSelection,
  );
  if (!session.events?.length) {
    return { ...session, authoritativeSelectionAnchor: anchor };
  }
  let eventIndex = reconciledEventIndex(session.events, anchor);
  if (eventIndex < 0 && Number.isFinite(anchor?.sequence)) {
    eventIndex = nearestExecutionTimelineIndex(
      session.events,
      anchor.sequence,
    );
  }
  const reconciled = eventIndex >= 0
    ? executionSessionSelectEvent(session, eventIndex)
    : session;
  return { ...reconciled, authoritativeSelectionAnchor: anchor };
}

export function executionSessionMatches(session, snapshot) {
  return Boolean(
    session &&
      snapshot &&
      session.path === snapshot.path &&
      session.source === snapshot.source &&
      session.projectVersion === snapshot.projectVersion,
  );
}

export function pendingExecutionSession(
  snapshot,
  { previous = null } = {},
) {
  return {
    path: snapshot.path,
    source: snapshot.source,
    projectVersion: snapshot.projectVersion,
    status: "loading",
    stale: false,
    error: null,
    events: [],
    eventKey: null,
    selectionAnchor: previous?.authoritativeSelectionAnchor
      ? { ...previous.authoritativeSelectionAnchor, occurrenceId: null }
      : selectionAnchor(previous, { includeOccurrenceId: false }),
    focus: emptyFocus(),
    model: null,
    sources: { [snapshot.path]: snapshot.source },
    siteIndexes: {},
  };
}

export function readyExecutionSession(
  pending,
  { payload, model, events },
) {
  let eventIndex = pending.eventKey
    ? events.findIndex(
        (event) => executionTimelineEventKey(event) === pending.eventKey,
      )
    : -1;
  if (eventIndex < 0) {
    eventIndex = reconciledEventIndex(events, pending.selectionAnchor);
  }
  if (eventIndex < 0) {
    eventIndex = events.findIndex((event) => event.path === pending.path);
  }
  if (eventIndex < 0) eventIndex = 0;
  const session = {
    ...payload,
    path: pending.path,
    source: pending.source,
    projectVersion: pending.projectVersion,
    status: "ready",
    stale: false,
    error: null,
    model,
    events,
    eventKey: executionTimelineEventKey(events[eventIndex] || null),
    focus: focusForEvent(events, eventIndex),
    sources: pending.sources || { [pending.path]: pending.source },
    siteIndexes: pending.siteIndexes || {},
  };
  return session;
}

export function failedExecutionSession(session, error) {
  return {
    ...session,
    status: "error",
    error,
    events: [],
    model: null,
    focus: emptyFocus(),
  };
}

export function executionSessionMarkStale(session) {
  return session
    ? {
        ...session,
        status: "stale",
        stale: true,
      }
    : session;
}

export function executionSessionEvent(session) {
  if (!session?.events?.length) return null;
  const index = session.focus?.eventIndex;
  return Number.isFinite(index) ? session.events[index] || null : null;
}

export function executionSessionOwnerCallForEvent(session, event) {
  const model = session?.model;
  if (!model || !event) return null;
  const occurrence = model.occurrences.get(event.occurrenceId);
  const owner =
    model.calls.get(event.callId) || model.roots.get(event.callId);
  if (owner) return owner;
  const direct = model.calls.get(event.occurrenceId);
  if (direct) return direct;
  let ancestor = occurrence;
  while (ancestor) {
    const call = model.calls.get(ancestor.id);
    if (call) return call;
    ancestor = ancestor.rawParent;
  }
  return model.roots.get(`root:${event.path}`) || null;
}

export function executionSessionCallForEvent(session, event) {
  const model = session?.model;
  if (!model || !event) return null;
  const occurrence = model.occurrences.get(event.occurrenceId);
  if (occurrence?.kind === "call") {
    const invoked = (occurrence.children || []).filter(
      (child) =>
        child.kind === "function" &&
        model.calls.has(child.id) &&
        (occurrence.value === undefined ||
          child.value === undefined ||
          (occurrence.outcome === child.outcome &&
            occurrence.value === child.value)),
    );
    if (invoked.length === 1) return model.calls.get(invoked[0].id);
  }
  return executionSessionOwnerCallForEvent(session, event);
}

export function executionSessionFocusedEvents(session) {
  const selected = executionSessionEvent(session);
  const occurrences = session?.model?.occurrences;
  const root = selected && occurrences?.get(selected.occurrenceId);
  if (!root) return [];
  const descendsFromRoot = (event) => {
    let occurrence = occurrences.get(event.occurrenceId);
    while (occurrence) {
      if (occurrence.id === root.id) return true;
      occurrence = occurrence.rawParent;
    }
    return false;
  };
  return session.events.filter(descendsFromRoot);
}

export function executionSessionCall(session) {
  return executionSessionOwnerCallForEvent(
    session,
    executionSessionEvent(session),
  );
}

export function executionSessionSelectEvent(session, index) {
  if (!session?.events?.length) return session;
  const focus = focusForEvent(session.events, Number(index));
  const event = Number.isFinite(focus.eventIndex)
    ? session.events[focus.eventIndex]
    : null;
  return {
    ...session,
    focus,
    eventKey: executionTimelineEventKey(event),
    authoritativeSelectionAnchor: null,
  };
}

export function executionSessionSelectCall(session, callId) {
  if (!session?.model || !session.events.length) return session;
  const call =
    session.model.calls.get(callId) || session.model.roots.get(callId);
  if (!call) return session;
  let eventIndex;
  if (call.kind === "root") {
    eventIndex = session.events.findIndex(
      (event) =>
        event.path === call.path &&
        executionSessionCallForEvent(session, event)?.id === call.id,
    );
  } else {
    if (Number.isFinite(call.startIndex)) {
      eventIndex = session.events.findIndex(
        (event) =>
          event.sourceIndex === call.startIndex &&
          event.callId === call.id,
      );
      if (eventIndex < 0) {
        eventIndex = session.events.findIndex(
          (event) => event.callId === call.id,
        );
      }
    }
    if (eventIndex === undefined || eventIndex < 0) {
      eventIndex = session.events.findIndex(
        (event) =>
          event.occurrenceId === call.id && event.phase === "enter",
      );
    }
    if (eventIndex < 0 && Number.isFinite(call.enterSequence)) {
      eventIndex = nearestExecutionTimelineIndex(
        session.events,
        call.enterSequence,
      );
    }
  }
  return eventIndex >= 0
    ? executionSessionSelectEvent(session, eventIndex)
    : session;
}

export function executionSessionSelectSite(session, position, staticRange = null) {
  if (!session) return session;
  const target =
    position && staticRange && session.status === "ready" && !session.stale
      ? executionTimelineCursorTarget(session.events, position, staticRange)
      : { indices: [], site: null };
  const currentIndex = session.focus?.eventIndex;
  const eventIndex = target.indices.includes(currentIndex)
    ? currentIndex
    : nearestExecutionTimelineMatch(
        target.indices,
        Number.isFinite(currentIndex) ? currentIndex : 0,
      );
  const focusedIndex = eventIndex >= 0 ? eventIndex : null;
  return {
    ...session,
    focus: {
      site: target.site || null,
      range: target.focus || null,
      eventIndex: focusedIndex,
      matches: target.indices,
    },
    eventKey: Number.isFinite(focusedIndex)
      ? executionTimelineEventKey(session.events[focusedIndex])
      : null,
    authoritativeSelectionAnchor: null,
  };
}

export function executionSessionChooseFocusedExecution(
  session,
  eventIndex,
  { preserveAuthoritativeSelection = false } = {},
) {
  if (
    !session?.focus?.matches?.includes(eventIndex) ||
    !session.events?.[eventIndex]
  ) {
    return session;
  }
  return {
    ...session,
    focus: {
      ...session.focus,
      eventIndex,
    },
    eventKey: executionTimelineEventKey(session.events[eventIndex]),
    authoritativeSelectionAnchor: preserveAuthoritativeSelection
      ? session.authoritativeSelectionAnchor
      : null,
  };
}

export function executionSessionFocusExecutions(session) {
  if (!session?.focus?.matches?.length) return [];
  const focusedIndex = Number.isFinite(session.focus.eventIndex)
    ? session.focus.eventIndex
    : 0;
  const executions = new Map();
  for (const eventIndex of session.focus.matches) {
    const event = session.events[eventIndex];
    const call = executionSessionCallForEvent(session, event);
    if (!event || !call) continue;
    const key = call.kind === "root"
      ? `${call.id}:${event.occurrenceId}`
      : call.id;
    const existing = executions.get(key);
    if (
      !existing ||
      Math.abs(eventIndex - focusedIndex) <
        Math.abs(existing.eventIndex - focusedIndex)
    ) {
      const outcomeEvent = session.events.find(
        (candidate) =>
          candidate.occurrenceId === event.occurrenceId &&
          (candidate.phase === "return" || candidate.phase === "raise"),
      );
      executions.set(key, {
        call,
        ownerCall: executionSessionOwnerCallForEvent(session, event),
        event,
        eventIndex,
        outcomeEvent,
      });
    }
  }
  return [...executions.values()].sort(
    (left, right) => left.eventIndex - right.eventIndex,
  );
}

export function executionSessionFocusExecutionsForCall(session, callId) {
  if (!callId) return [];
  return executionSessionFocusExecutions(session).filter(
    ({ ownerCall }) => ownerCall?.id === callId,
  );
}

function rangeContainsFocus(range, focus) {
  if (
    !range ||
    !focus ||
    range.path !== focus.path ||
    !Number.isFinite(range.line) ||
    !Number.isFinite(range.column)
  ) {
    return false;
  }
  const endLine = Number.isFinite(range.endLine) ? range.endLine : range.line;
  const endColumn = Number.isFinite(range.endColumn)
    ? range.endColumn
    : range.column;
  const focusLine = focus.line;
  const focusColumn = focus.column;
  return (
    (range.line < focusLine ||
      (range.line === focusLine && range.column <= focusColumn)) &&
    (endLine > focusLine ||
      (endLine === focusLine && endColumn >= focusColumn))
  );
}

export function executionSessionFocusValue(session) {
  const event = executionSessionEvent(session);
  const call = executionSessionCallForEvent(session, event);
  const focus = session?.focus?.range;
  if (!event || !call || !focus) return null;

  const binding = [
    ...(call.parameters || []),
    ...(call.values || []),
  ]
    .filter((candidate) => rangeContainsFocus(candidate, focus))
    .sort((left, right) => {
      const leftSize =
        ((left.endLine ?? left.line) - left.line) * 1_000_000 +
        ((left.endColumn ?? left.column) - left.column);
      const rightSize =
        ((right.endLine ?? right.line) - right.line) * 1_000_000 +
        ((right.endColumn ?? right.column) - right.column);
      return leftSize - rightSize;
    })[0];
  if (binding) {
    return {
      label: binding.name,
      value: binding.value,
      type: binding.type,
      outcome: "value",
      kind: binding.kind || "parameter",
    };
  }

  const occurrence = session.model?.occurrences?.get(event.occurrenceId);
  const value = occurrence?.value ??
    ((event.phase === "return" || event.phase === "raise")
      ? event.detail
      : undefined);
  if (value === undefined) return null;
  return {
    label: occurrence?.label || event.label || "expression",
    value,
    type: occurrence?.returnType || event.type || occurrence?.type || "",
    outcome: occurrence?.outcome || event.phase,
    kind: occurrence?.kind || event.kind || "expression",
  };
}

export function executionSessionFocusRange(session) {
  const range = session?.focus?.range;
  if (range) return range;
  const site = session?.focus?.site;
  if (!site) return null;
  return {
    path: site.path,
    line: site.startLine,
    column: site.startColumn,
    endColumn:
      site.endLine === site.startLine
        ? site.endColumn
        : Number.MAX_SAFE_INTEGER,
  };
}
