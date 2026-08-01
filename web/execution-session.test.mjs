import assert from "node:assert/strict";
import test from "node:test";

import {
  executionSessionCall,
  executionSessionCallForEvent,
  executionSessionChooseFocusedExecution,
  executionSessionFocusExecutions,
  executionSessionFocusExecutionsForCall,
  executionSessionFocusValue,
  executionSessionFocusedEvents,
  executionSessionFocusRange,
  executionSessionEvent,
  executionSessionMarkStale,
  executionSessionReconcileFocus,
  executionSessionSelectEvent,
  executionSessionSelectCall,
  executionSessionSelectSite,
  pendingExecutionSession,
  readyExecutionSession,
} from "./execution-session.js";

function fixture() {
  const root = {
    id: "root:fib.ml.md",
    kind: "root",
    path: "fib.ml.md",
  };
  const fib6 = {
    id: "fib-6",
    kind: "function",
    path: "fib.ml.md",
    label: "fib",
    enterSequence: 1,
    parent: root,
  };
  const fib4 = {
    ...fib6,
    id: "fib-4",
    enterSequence: 2,
    parent: fib6,
  };
  const fib5 = {
    ...fib6,
    id: "fib-5",
    enterSequence: 3,
    parent: fib6,
  };
  const calls = new Map([
    [fib6.id, fib6],
    [fib4.id, fib4],
    [fib5.id, fib5],
  ]);
  const model = {
    calls,
    roots: new Map([[root.id, root]]),
    occurrences: new Map(),
  };
  const events = [
    {
      occurrenceId: "top-level",
      path: "fib.ml.md",
      line: 12,
      column: 8,
      sequence: 0,
      phase: "enter",
    },
    {
      occurrenceId: fib6.id,
      path: "fib.ml.md",
      line: 5,
      column: 8,
      sequence: 1,
      phase: "enter",
    },
    {
      occurrenceId: fib4.id,
      path: "fib.ml.md",
      line: 8,
      column: 23,
      sequence: 2,
      phase: "enter",
    },
    {
      occurrenceId: fib5.id,
      path: "fib.ml.md",
      line: 8,
      column: 11,
      sequence: 3,
      phase: "enter",
    },
  ];
  const pending = pendingExecutionSession(
    {
      path: "fib.ml.md",
      source: "let rec fib n = fib (n - 1) + fib (n - 2)",
      projectVersion: "one",
    },
  );
  return readyExecutionSession(pending, {
    payload: { timeline: [], callEvents: [] },
    model,
    events,
  });
}

test("the event index is the only execution selection", () => {
  const session = executionSessionSelectEvent(fixture(), 1);
  assert.equal(executionSessionEvent(session).occurrenceId, "fib-6");
  assert.equal(executionSessionCall(session).id, "fib-6");
  assert.equal(session.focus.eventIndex, 1);
  assert.equal(session.focus.site.path, "fib.ml.md");
});

test("call navigation selects that call's entry event", () => {
  const session = executionSessionSelectCall(fixture(), "fib-5");
  assert.equal(session.focus.eventIndex, 3);
  assert.equal(executionSessionCall(session).id, "fib-5");
});

test("a call-site event reports its invocation without leaving its owner", () => {
  const session = fixture();
  const invoked = session.model.calls.get("fib-6");
  Object.assign(invoked, {
    value: "8",
    outcome: "return",
    returnType: "int -> int",
  });
  session.model.occurrences.set("call-fib-6", {
    id: "call-fib-6",
    kind: "call",
    value: "8",
    outcome: "return",
    returnType: "int",
    children: [invoked],
    rawParent: null,
  });
  session.events[0] = {
    ...session.events[0],
    occurrenceId: "call-fib-6",
    callId: "root:fib.ml.md",
  };
  const focused = executionSessionSelectEvent(session, 0);
  assert.equal(executionSessionCall(focused).id, "root:fib.ml.md");
  assert.equal(
    executionSessionCallForEvent(focused, executionSessionEvent(focused)).id,
    "fib-6",
  );
  focused.focus.matches = [0];
  const [choice] = executionSessionFocusExecutions(focused);
  assert.equal(choice.call.id, "fib-6");
  assert.equal(choice.ownerCall.id, "root:fib.ml.md");
  assert.deepEqual(
    executionSessionFocusExecutionsForCall(focused, "root:fib.ml.md").map(
      ({ call }) => call.id,
    ),
    ["fib-6"],
  );
  assert.deepEqual(
    executionSessionFocusExecutionsForCall(focused, "fib-6"),
    [],
  );
});

test("a higher-order library call does not focus one of its callbacks", () => {
  const session = fixture();
  const root = session.model.roots.get("root:fib.ml.md");
  const callback = {
    ...session.model.calls.get("fib-6"),
    id: "callback",
    value: "0",
    returnType: "int",
    outcome: "return",
  };
  session.model.calls.set(callback.id, callback);
  session.model.occurrences.set("map-call", {
    id: "map-call",
    kind: "call",
    value: "[0; 1]",
    returnType: "int list",
    outcome: "return",
    children: [callback],
    rawParent: null,
  });
  session.events[0] = {
    ...session.events[0],
    occurrenceId: "map-call",
    callId: root.id,
  };
  const focused = executionSessionSelectEvent(session, 0);
  assert.equal(executionSessionCall(focused).id, root.id);
});

test("collects only the selected occurrence subtree for root highlighting", () => {
  const session = fixture();
  const rootOccurrence = { id: "pipeline", rawParent: null };
  const childOccurrence = { id: "callback", rawParent: rootOccurrence };
  const unrelatedOccurrence = { id: "later", rawParent: null };
  session.model.occurrences = new Map([
    [rootOccurrence.id, rootOccurrence],
    [childOccurrence.id, childOccurrence],
    [unrelatedOccurrence.id, unrelatedOccurrence],
  ]);
  session.events = [
    { ...session.events[0], occurrenceId: "pipeline" },
    { ...session.events[1], occurrenceId: "callback" },
    { ...session.events[2], occurrenceId: "later" },
  ];
  const focused = executionSessionSelectEvent(session, 0);
  assert.deepEqual(
    executionSessionFocusedEvents(focused).map((event) => event.occurrenceId),
    ["pipeline", "callback"],
  );
});

test("keeps distinct root expression occurrences as distinct choices", () => {
  const session = fixture();
  const root = session.model.roots.get("root:fib.ml.md");
  const first = { id: "first", kind: "call", children: [], rawParent: null };
  const second = { id: "second", kind: "call", children: [], rawParent: null };
  session.model.occurrences = new Map([
    [first.id, first],
    [second.id, second],
  ]);
  session.events = [
    { ...session.events[0], occurrenceId: first.id, callId: root.id },
    { ...session.events[0], occurrenceId: second.id, callId: root.id },
  ];
  session.focus = { ...session.focus, eventIndex: 0, matches: [0, 1] };
  assert.deepEqual(
    executionSessionFocusExecutions(session).map(({ event }) =>
      event.occurrenceId
    ),
    [first.id, second.id],
  );
});

test("the focused value is the application result, not its callee value", () => {
  const session = fixture();
  const invoked = session.model.calls.get("fib-5");
  Object.assign(invoked, {
    value: "8",
    returnType: "int",
    outcome: "return",
  });
  session.model.occurrences.set("fib-call", {
    id: "fib-call",
    kind: "call",
    label: "fib",
    value: "8",
    returnType: "int",
    outcome: "return",
    children: [invoked],
    rawParent: null,
  });
  session.events[0] = {
    ...session.events[0],
    occurrenceId: "fib-call",
    callId: "root:fib.ml.md",
    kind: "call",
    label: "fib",
    detail: "<function>",
  };
  session.focus = {
    site: {
      path: "fib.ml.md",
      startLine: 12,
      startColumn: 8,
      endLine: 12,
      endColumn: 13,
    },
    range: { path: "fib.ml.md", line: 12, column: 8, endColumn: 13 },
    eventIndex: 0,
    matches: [0],
  };
  assert.deepEqual(executionSessionFocusValue(session), {
    label: "fib",
    value: "8",
    type: "int",
    outcome: "return",
    kind: "call",
  });
});

test("a focused lambda parameter shows its value for the selected call", () => {
  const session = executionSessionSelectCall(fixture(), "fib-5");
  const call = session.model.calls.get("fib-5");
  call.parameters = [
    {
      name: "n",
      value: "5",
      type: "int",
      path: "fib.ml.md",
      line: 5,
      column: 12,
      endLine: 5,
      endColumn: 13,
    },
  ];
  session.focus.range = {
    path: "fib.ml.md",
    line: 5,
    column: 12,
    endColumn: 13,
  };
  assert.deepEqual(executionSessionFocusValue(session), {
    label: "n",
    value: "5",
    type: "int",
    outcome: "value",
    kind: "parameter",
  });
});

test("a focused internal pattern binder shows only its matched value", () => {
  const session = executionSessionSelectCall(fixture(), "fib-5");
  const call = session.model.calls.get("fib-5");
  call.values = [
    {
      name: "left",
      kind: "binding",
      value: "Leaf 1",
      type: "tree",
      path: "fib.ml.md",
      line: 9,
      column: 12,
      endLine: 9,
      endColumn: 16,
    },
  ];
  session.focus.range = {
    path: "fib.ml.md",
    line: 9,
    column: 12,
    endLine: 9,
    endColumn: 16,
  };
  assert.deepEqual(executionSessionFocusValue(session), {
    label: "left",
    value: "Leaf 1",
    type: "tree",
    outcome: "value",
    kind: "binding",
  });
});

test("chooses a preferred execution without losing the cursor site", () => {
  const selected = executionSessionSelectSite(
    fixture(),
    { path: "fib.ml.md", line: 8, column: 11 },
    { startLine: 8, startColumn: 11, endLine: 8, endColumn: 11 },
  );
  const originalSite = selected.focus.site;
  const choice = executionSessionChooseFocusedExecution(selected, 3);
  assert.equal(choice.focus.eventIndex, 3);
  assert.equal(choice.focus.site, originalSite);
});

test("moving the source cursor focuses an execution through that point", () => {
  const selected = executionSessionSelectCall(fixture(), "fib-4");
  const moved = executionSessionSelectSite(
    selected,
    { path: "fib.ml.md", line: 8, column: 11 },
    { startLine: 8, startColumn: 11, endLine: 8, endColumn: 11 },
  );
  assert.equal(moved.focus.eventIndex, 3);
  assert.deepEqual(moved.focus.matches, [3]);
  assert.deepEqual(executionSessionFocusRange(moved), {
    path: "fib.ml.md",
    line: 8,
    column: 11,
    endColumn: 11,
  });
  assert.deepEqual(
    executionSessionFocusExecutions(moved).map(({ call, eventIndex }) => [
      call.id,
      eventIndex,
    ]),
    [["fib-5", 3]],
  );
});

test("cursor focus stays put when the selected execution still matches", () => {
  const selected = executionSessionSelectCall(fixture(), "fib-4");
  const moved = executionSessionSelectSite(
    selected,
    { path: "fib.ml.md", line: 8, column: 23 },
    { startLine: 8, startColumn: 23, endLine: 8, endColumn: 23 },
  );
  assert.equal(moved.focus.eventIndex, selected.focus.eventIndex);
  assert.deepEqual(moved.focus.matches, [2]);
});

test("invalidating code preserves visible focus while making it stale", () => {
  const selected = executionSessionSelectSite(
    executionSessionSelectCall(fixture(), "fib-4"),
    { path: "fib.ml.md", line: 8, column: 23 },
    { startLine: 8, startColumn: 23, endLine: 8, endColumn: 23 },
  );
  const stale = executionSessionMarkStale(selected);
  assert.deepEqual(stale.focus, selected.focus);
  assert.equal(stale.status, "stale");
});

test("a recomputed trace reconciles the selected execution at the same site", () => {
  const previous = fixture();
  const repeated = Array.from({ length: 3 }, (_, index) => ({
    occurrenceId: `old-${index}`,
    path: "fib.ml.md",
    line: 8,
    column: 11,
    endLine: 8,
    endColumn: 20,
    sequence: index,
    phase: "enter",
    kind: "call",
    label: "fib",
  }));
  previous.events = repeated;
  const selected = executionSessionSelectEvent(previous, 1);
  const pending = pendingExecutionSession(
    {
      path: "fib.ml.md",
      source: "let rec fib n = fib (n - 2)",
      projectVersion: "one",
    },
    { previous: selected },
  );
  const recomputed = Array.from({ length: 5 }, (_, index) => ({
    ...repeated[0],
    occurrenceId: `new-${index}`,
    sequence: 20 + index,
  }));
  const ready = readyExecutionSession(pending, {
    payload: { timeline: [], callEvents: [] },
    model: previous.model,
    events: recomputed,
  });
  assert.equal(ready.focus.eventIndex, 2);
  assert.equal(executionSessionEvent(ready).occurrenceId, "new-2");
});

test("draft filtering keeps a selected recursive activation through recovery", () => {
  const previous = fixture();
  const recursiveEvents = Array.from({ length: 3 }, (_, index) => [
    {
      occurrenceId: `old-${index}`,
      path: "fib.ml.md",
      line: 8,
      column: 11,
      endLine: 8,
      endColumn: 20,
      sequence: index * 2,
      phase: "enter",
      kind: "function",
      label: "fib",
    },
    {
      occurrenceId: `old-${index}`,
      path: "fib.ml.md",
      line: 8,
      column: 11,
      endLine: 8,
      endColumn: 20,
      sequence: index * 2 + 1,
      phase: "return",
      kind: "function",
      label: "fib",
    },
  ]).flat();
  previous.events = recursiveEvents;
  const selected = executionSessionSelectEvent(previous, 2);
  const projected = executionSessionReconcileFocus(
    {
      ...selected,
      events: recursiveEvents.filter((event) => event.phase === "enter"),
    },
    selected,
  );
  assert.equal(projected.focus.eventIndex, 1);
  assert.equal(executionSessionEvent(projected).occurrenceId, "old-1");

  const pending = pendingExecutionSession(
    {
      path: "fib.ml.md",
      source: "let rec fib n = fib (n - 1)",
      projectVersion: "two",
    },
    { previous: projected },
  );
  const recomputed = recursiveEvents
    .filter((event) => event.phase === "enter")
    .map((event, index) => ({
      ...event,
      occurrenceId: `new-${index}`,
      sequence: 20 + index,
    }));
  const recovered = readyExecutionSession(pending, {
    payload: { timeline: [], callEvents: [] },
    model: previous.model,
    events: recomputed,
  });
  assert.equal(recovered.focus.eventIndex, 1);
  assert.equal(executionSessionEvent(recovered).occurrenceId, "new-1");
});

test("authoritative recovery restores an event removed from the draft trace", () => {
  const previous = fixture();
  const unrelated = {
    occurrenceId: "old-unrelated",
    path: "fib.ml.md",
    line: 4,
    column: 2,
    endLine: 4,
    endColumn: 8,
    sequence: 0,
    phase: "enter",
    kind: "binding",
    label: "unrelated",
  };
  const selectedCall = {
    occurrenceId: "old-call",
    path: "fib.ml.md",
    line: 10,
    column: 4,
    endLine: 10,
    endColumn: 12,
    sequence: 10,
    phase: "enter",
    kind: "call",
    label: "fib",
  };
  previous.events = [unrelated, selectedCall];
  const selected = executionSessionSelectEvent(previous, 1);
  const projected = executionSessionReconcileFocus(
    { ...selected, events: [unrelated] },
    selected,
    {
      mapAuthoritativeSelection: (anchor) => ({
        ...anchor,
        line: anchor.line + 2,
        endLine: anchor.endLine + 2,
      }),
    },
  );
  assert.equal(executionSessionEvent(projected).occurrenceId, "old-unrelated");

  const pending = pendingExecutionSession(
    {
      path: "fib.ml.md",
      source: "let answer = fib 10",
      projectVersion: "two",
    },
    { previous: projected },
  );
  const recovered = readyExecutionSession(pending, {
    payload: { timeline: [], callEvents: [] },
    model: previous.model,
    events: [
      { ...unrelated, occurrenceId: "new-unrelated", sequence: 20 },
      {
        ...selectedCall,
        occurrenceId: "new-call",
        line: 12,
        endLine: 12,
        sequence: 30,
      },
    ],
  });
  assert.equal(executionSessionEvent(recovered).occurrenceId, "new-call");
});

test("authoritative recovery follows a selected event through line shifts", () => {
  const previous = fixture();
  const first = {
    occurrenceId: "old-first",
    path: "fib.ml.md",
    line: 1,
    column: 0,
    endLine: 1,
    endColumn: 3,
    sequence: 0,
    phase: "enter",
    kind: "binding",
    label: "first",
  };
  const selectedCall = {
    occurrenceId: "old-call",
    path: "fib.ml.md",
    line: 10,
    column: 4,
    endLine: 10,
    endColumn: 12,
    sequence: 10,
    phase: "enter",
    kind: "call",
    label: "fib",
  };
  previous.events = [first, selectedCall];
  const selected = executionSessionSelectEvent(previous, 1);
  const onceShiftedCall = { ...selectedCall, line: 11, endLine: 11 };
  const onceProjected = executionSessionReconcileFocus(
    { ...selected, events: [first, onceShiftedCall] },
    selected,
    {
      mapAuthoritativeSelection: (anchor) => ({
        ...anchor,
        line: anchor.line + 1,
        endLine: anchor.endLine + 1,
      }),
    },
  );
  const shiftedCall = { ...selectedCall, line: 12, endLine: 12 };
  const projected = executionSessionReconcileFocus(
    { ...onceProjected, events: [first, shiftedCall] },
    onceProjected,
    {
      mapAuthoritativeSelection: (anchor) => ({
        ...anchor,
        line: anchor.line + 1,
        endLine: anchor.endLine + 1,
      }),
    },
  );
  assert.equal(executionSessionEvent(projected).occurrenceId, "old-call");

  const pending = pendingExecutionSession(
    {
      path: "fib.ml.md",
      source: "\n\nlet answer = fib 10",
      projectVersion: "two",
    },
    { previous: projected },
  );
  const recovered = readyExecutionSession(pending, {
    payload: { timeline: [], callEvents: [] },
    model: previous.model,
    events: [
      { ...first, occurrenceId: "new-first", sequence: 20 },
      { ...shiftedCall, occurrenceId: "new-call", sequence: 30 },
    ],
  });
  assert.equal(executionSessionEvent(recovered).occurrenceId, "new-call");
});

test("explicit provisional focus replaces the authoritative recovery anchor", () => {
  const previous = fixture();
  const first = {
    occurrenceId: "old-first",
    path: "fib.ml.md",
    line: 4,
    column: 2,
    endLine: 4,
    endColumn: 7,
    sequence: 0,
    phase: "enter",
    kind: "binding",
    label: "first",
  };
  const second = {
    occurrenceId: "old-second",
    path: "fib.ml.md",
    line: 6,
    column: 2,
    endLine: 6,
    endColumn: 8,
    sequence: 20,
    phase: "enter",
    kind: "binding",
    label: "second",
  };
  const removedCall = {
    occurrenceId: "old-call",
    path: "fib.ml.md",
    line: 10,
    column: 4,
    endLine: 10,
    endColumn: 12,
    sequence: 10,
    phase: "enter",
    kind: "call",
    label: "fib",
  };
  previous.events = [first, removedCall, second];
  const selected = executionSessionSelectEvent(previous, 1);
  const projected = executionSessionReconcileFocus(
    { ...selected, events: [first, second] },
    selected,
  );
  const explicitlyFocused = executionSessionSelectEvent(projected, 1);

  const pending = pendingExecutionSession(
    {
      path: "fib.ml.md",
      source: "let second = 2",
      projectVersion: "two",
    },
    { previous: explicitlyFocused },
  );
  const recovered = readyExecutionSession(pending, {
    payload: { timeline: [], callEvents: [] },
    model: previous.model,
    events: [
      { ...first, occurrenceId: "new-first", sequence: 30 },
      { ...removedCall, occurrenceId: "new-call", sequence: 40 },
      { ...second, occurrenceId: "new-second", sequence: 50 },
    ],
  });
  assert.equal(executionSessionEvent(recovered).occurrenceId, "new-second");
});

test("an empty cursor selection does not keep the previous call focused", () => {
  const selected = executionSessionSelectCall(fixture(), "fib-4");
  const empty = executionSessionSelectSite(
    selected,
    { path: "fib.ml.md", line: 7, column: 9 },
    { startLine: 7, startColumn: 9, endLine: 7, endColumn: 10 },
  );
  assert.deepEqual(empty.focus.matches, []);
  assert.equal(executionSessionCall(empty), null);
  assert.equal(empty.focus.eventIndex, null);
});

test("timeline navigation replaces source focus through the same state", () => {
  const filtered = executionSessionSelectSite(
    fixture(),
    { path: "fib.ml.md", line: 8, column: 11 },
    { startLine: 8, startColumn: 11, endLine: 8, endColumn: 11 },
  );
  const timelineFocused = executionSessionSelectEvent(filtered, 2);
  assert.equal(timelineFocused.focus.eventIndex, 2);
  assert.deepEqual(timelineFocused.focus.matches, [2]);
  assert.equal(executionSessionCall(timelineFocused).id, "fib-4");
});

test("timeline, call, and source inputs produce the same focus", () => {
  const fromTimeline = executionSessionSelectEvent(fixture(), 3);
  const fromCall = executionSessionSelectCall(fixture(), "fib-5");
  const fromSource = executionSessionSelectSite(
    fixture(),
    { path: "fib.ml.md", line: 8, column: 11 },
    { startLine: 8, startColumn: 11, endLine: 8, endColumn: 11 },
  );
  assert.deepEqual(fromTimeline.focus, fromCall.focus);
  assert.deepEqual(fromTimeline.focus, fromSource.focus);
});
