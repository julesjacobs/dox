import assert from "node:assert/strict";
import test from "node:test";

import {
  executionTimelineEventKey,
  executionTimelineCursorTarget,
  executionTimelineEvents,
  executionTimelineMatchIndices,
  executionTimelinePosition,
  executionTimelineSpan,
  executionTimelineStops,
  nearestExecutionTimelineMatch,
  nearestExecutionTimelineIndex,
} from "./execution-timeline.js";

test("builds a semantic execution timeline in event order", () => {
  const events = executionTimelineEvents([
    {
      sequence: 4,
      occurrenceId: "f",
      phase: "return",
      path: "demo.ml.md",
      line: 4,
    },
    {
      sequence: 2,
      occurrenceId: "f:x",
      phase: "parameter",
      path: "demo.ml.md",
      line: 2,
    },
    {
      sequence: 1,
      occurrenceId: "f",
      phase: "enter",
      path: "demo.ml.md",
      line: 2,
    },
  ]);
  assert.deepEqual(
    events.map((event) => event.sequence),
    [1, 4],
  );
  assert.equal(
    executionTimelineEventKey(events[0]),
    "1\u001ff\u001fenter\u001fdemo.ml.md\u001f2",
  );
});

test("excludes generated execution sources that cannot be opened", () => {
  const events = executionTimelineEvents(
    [
      {
        sequence: 1,
        occurrenceId: "page",
        phase: "enter",
        path: "demo.ml.md",
        line: 2,
      },
      {
        sequence: 2,
        occurrenceId: "inline",
        phase: "return",
        path: "<dox-inline:demo:0>",
        line: 1,
      },
    ],
    ["demo.ml.md"],
  );
  assert.deepEqual(events.map((event) => event.occurrenceId), ["page"]);
});

test("maps events and invocation spans onto the ribbon", () => {
  const events = [1, 4, 8, 13].map((sequence) => ({ sequence }));
  assert.equal(nearestExecutionTimelineIndex(events, 7), 2);
  assert.ok(
    Math.abs(executionTimelinePosition(2, 4) - 200 / 3) < 1e-10,
  );
  assert.deepEqual(
    executionTimelineSpan(
      { enterSequence: 4, endSequence: 12 },
      events,
    ),
    { start: 1, end: 3 },
  );
});

test("finds every execution point for a static source position", () => {
  const events = [
    {
      path: "demo.ml.md",
      line: 4,
      column: 8,
      endLine: 4,
      endColumn: 14,
    },
    {
      path: "demo.ml.md",
      line: 4,
      column: 8,
      endLine: 4,
      endColumn: 14,
    },
    {
      path: "other.ml.md",
      line: 4,
      column: 8,
      endLine: 4,
      endColumn: 14,
    },
  ];
  assert.deepEqual(
    executionTimelineMatchIndices(
      events,
      { path: "demo.ml.md", line: 4, column: 10 },
      { startLine: 4, startColumn: 8, endLine: 4, endColumn: 14 },
    ),
    [0, 1],
  );
  assert.equal(nearestExecutionTimelineMatch([3, 9, 17], 11), 9);
});

test("does not fall back to a nearby executed expression", () => {
  const events = [
    {
      path: "demo.ml.md",
      line: 7,
      column: 2,
      endLine: 7,
      endColumn: 5,
    },
    {
      path: "demo.ml.md",
      line: 8,
      column: 2,
      endLine: 8,
      endColumn: 5,
    },
  ];
  assert.deepEqual(
    executionTimelineMatchIndices(
      events,
      { path: "demo.ml.md", line: 7, column: 20 },
      null,
    ),
    [],
  );
});

test("selects the empty set for a static construct that did not execute", () => {
  const events = [
    {
      path: "demo.ml.md",
      line: 7,
      column: 2,
      endLine: 7,
      endColumn: 6,
    },
    {
      path: "demo.ml.md",
      line: 7,
      column: 10,
      endLine: 7,
      endColumn: 14,
    },
    {
      path: "demo.ml.md",
      line: 7,
      column: 10,
      endLine: 7,
      endColumn: 14,
    },
  ];
  assert.deepEqual(
    executionTimelineCursorTarget(
      events,
      { path: "demo.ml.md", line: 7, column: 8 },
      { startLine: 7, startColumn: 7, endLine: 7, endColumn: 9 },
    ),
    {
      indices: [],
      focus: {
        path: "demo.ml.md",
        line: 7,
        column: 7,
        endColumn: 9,
      },
      site: {
        id: "demo.ml.md:7:7:7:9",
        path: "demo.ml.md",
        startLine: 7,
        startColumn: 7,
        endLine: 7,
        endColumn: 9,
      },
    },
  );
});

test("resolves a piped partial application to its executed enclosing call", () => {
  const events = [
    {
      path: "pipeline.ml.md",
      line: 2,
      column: 6,
      endLine: 3,
      endColumn: 24,
      kind: "call",
      phase: "enter",
    },
    {
      path: "pipeline.ml.md",
      line: 3,
      column: 9,
      endLine: 3,
      endColumn: 17,
      kind: "value",
      phase: "enter",
    },
    {
      path: "pipeline.ml.md",
      line: 2,
      column: 6,
      endLine: 3,
      endColumn: 24,
      kind: "call",
      phase: "return",
    },
  ];
  const target = executionTimelineCursorTarget(
    events,
    { path: "pipeline.ml.md", line: 3, column: 12 },
    {
      id: "partial-application",
      startLine: 3,
      startColumn: 9,
      endLine: 3,
      endColumn: 24,
      executionFallback: {
        kind: "application",
        range: {
          startLine: 3,
          startColumn: 9,
          endLine: 3,
          endColumn: 17,
        },
      },
    },
  );
  assert.deepEqual(target.indices, [0, 2]);
  assert.equal(target.site.id, "partial-application");
});

test("prefers precise executed expressions over enclosing source spans", () => {
  const events = [
    {
      occurrenceId: "outer-taken",
      path: "fib.ml.md",
      line: 6,
      column: 6,
      endLine: 8,
      endColumn: 38,
    },
    {
      occurrenceId: "outer-not-taken",
      path: "fib.ml.md",
      line: 6,
      column: 6,
      endLine: 8,
      endColumn: 38,
    },
    {
      occurrenceId: "recursive-call",
      path: "fib.ml.md",
      line: 8,
      column: 11,
      endLine: 8,
      endColumn: 20,
    },
  ];

  assert.deepEqual(
    executionTimelineMatchIndices(
      events,
      { path: "fib.ml.md", line: 8, column: 14 },
      { startLine: 8, startColumn: 11, endLine: 8, endColumn: 20 },
    ),
    [2],
  );
});

test("turns debugger stops into one source timeline with call ownership", () => {
  const root = { id: "root:fib.ml.md", kind: "root", path: "fib.ml.md" };
  const outer = {
    id: "fib-6",
    kind: "function",
    label: "fib",
    path: "fib.ml.md",
    startIndex: 0,
    endIndex: 2,
    stackDepth: 1,
  };
  const inner = {
    ...outer,
    id: "fib-4",
    startIndex: 1,
    endIndex: 1,
    stackDepth: 2,
  };
  const model = {
    calls: new Map([[outer.id, outer], [inner.id, inner]]),
    roots: new Map([[root.id, root]]),
  };
  const events = executionTimelineStops(
    [
      {
        time: 10,
        path: "fib.ml.md",
        line: 8,
        column: 12,
        frames: [
          { path: "fib.ml.md", line: 8, column: 12 },
          { path: "fib.ml.md", line: 12, column: 17 },
        ],
      },
      { time: 11, path: "fib.ml.md", line: 8, column: 32 },
      { time: 12, path: "fib.ml.md", line: 8, column: 21 },
    ],
    model,
    ["fib.ml.md"],
  );
  assert.equal(events[0].callId, root.id);
  assert.equal(events[1].callId, outer.id);
  assert.equal(events[2].callId, inner.id);
  assert.deepEqual(
    executionTimelineMatchIndices(
      events,
      { path: "fib.ml.md", line: 8, column: 32 },
      { startLine: 8, startColumn: 32, endLine: 8, endColumn: 32 },
    ),
    [2],
  );
});
