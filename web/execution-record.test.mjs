import assert from "node:assert/strict";
import test from "node:test";

import {
  buildExecutionRecord,
  executionCallBindings,
} from "./execution-record.js";

const event = (
  sequence,
  phase,
  occurrenceId,
  parentId,
  kind,
  line,
  column,
  extra = {},
) => ({
  sequence,
  phase,
  occurrenceId,
  parentId,
  siteId: `${line}:${column}:${kind}`,
  kind,
  label: kind === "function" ? "fib" : kind,
  path: "fib.ml.md",
  line,
  column,
  endLine: line,
  endColumn: column + 4,
  type: "int",
  detail: "",
  ...extra,
});

test("keeps repeated recursive callsites and taken paths authoritative", () => {
  const events = [
    event(0, "enter", "top-call", null, "call", 8, 12),
    event(1, "enter", "fib-5", "top-call", "function", 1, 8),
    event(2, "parameter", "fib-5", "top-call", "parameter", 1, 12, {
      label: "n",
      detail: "5",
    }),
    event(3, "enter", "condition", "fib-5", "step", 2, 6),
    event(4, "return", "condition", "fib-5", "step", 2, 6, {
      detail: "false",
      type: "bool",
    }),
    event(5, "enter", "left-call", "fib-5", "call", 4, 11, {
      siteId: "fib.ml.md:4:11:call",
      endColumn: 20,
    }),
    event(6, "enter", "fib-4", "left-call", "function", 1, 8),
    event(7, "return", "fib-4", "left-call", "function", 1, 8, {
      detail: "3",
    }),
    event(8, "return", "left-call", "fib-5", "call", 4, 11, {
      detail: "3",
    }),
    event(9, "enter", "right-call", "fib-5", "call", 4, 24, {
      siteId: "fib.ml.md:4:24:call",
      endColumn: 33,
    }),
    event(10, "enter", "fib-3", "right-call", "function", 1, 8),
    event(11, "return", "fib-3", "right-call", "function", 1, 8, {
      detail: "2",
    }),
    event(12, "return", "right-call", "fib-5", "call", 4, 24, {
      detail: "2",
    }),
    event(13, "return", "fib-5", "top-call", "function", 1, 8, {
      detail: "5",
    }),
    event(14, "return", "top-call", null, "call", 8, 12, {
      detail: "5",
    }),
  ];

  const record = buildExecutionRecord(events);
  const call = record.calls.get("fib-5");
  assert.deepEqual(
    call.children.map((child) => child.id),
    ["fib-4", "fib-3"],
  );
  assert.deepEqual(
    call.children.map((child) => child.callsiteColumn),
    [11, 24],
  );
  assert.deepEqual(
    call.children.map((child) => child.callsiteKey),
    ["fib.ml.md:4:11:call", "fib.ml.md:4:24:call"],
  );
  assert.equal(call.executedLines.has(2), true);
  assert.equal(call.executedLines.has(3), false);
  assert.equal(call.executedLines.has(4), true);
});

test("attributes library callbacks to their enclosing user invocation", () => {
  const events = [
    event(0, "enter", "outer", null, "function", 1, 4, {
      label: "map_values",
    }),
    event(1, "enter", "map-call", "outer", "call", 2, 6, {
      siteId: "map.ml.md:2:6:call",
      path: "map.ml.md",
    }),
    event(2, "enter", "callback-1", "map-call", "function", 2, 16, {
      label: "fun",
      path: "map.ml.md",
    }),
    event(3, "return", "callback-1", "map-call", "function", 2, 16, {
      label: "fun",
      detail: "2",
      path: "map.ml.md",
    }),
    event(4, "enter", "callback-2", "map-call", "function", 2, 16, {
      label: "fun",
      path: "map.ml.md",
    }),
    event(5, "return", "callback-2", "map-call", "function", 2, 16, {
      label: "fun",
      detail: "3",
      path: "map.ml.md",
    }),
    event(6, "return", "map-call", "outer", "call", 2, 6, {
      path: "map.ml.md",
    }),
    event(7, "return", "outer", null, "function", 1, 4, {
      label: "map_values",
    }),
  ];
  const record = buildExecutionRecord(events);
  const outer = record.calls.get("outer");
  assert.deepEqual(
    outer.children.map((child) => child.id),
    ["callback-1", "callback-2"],
  );
  assert.equal(outer.children[0].callsiteKey, "map.ml.md:2:6:call");
  assert.equal(outer.children[1].callsiteKey, "map.ml.md:2:6:call");
});

test("preserves parameter source ranges for cursor value lookup", () => {
  const events = [
    event(0, "enter", "callback", null, "function", 3, 10, {
      label: "fun",
      endColumn: 52,
    }),
    event(1, "parameter", "callback", null, "parameter", 3, 15, {
      label: "total",
      detail: "0.",
      type: "float",
      endColumn: 20,
    }),
    event(2, "return", "callback", null, "function", 3, 10, {
      label: "fun",
      detail: "16.2",
      type: "float",
      endColumn: 52,
    }),
  ];
  const parameter = buildExecutionRecord(events).calls.get("callback")
    .parameters[0];
  assert.deepEqual(parameter, {
    name: "total",
    value: "0.",
    type: "float",
    sequence: 1,
    path: "fib.ml.md",
    line: 3,
    column: 15,
    endLine: 3,
    endColumn: 20,
  });
});

test("binder annotations exclude reads and keep distinct pattern binders", () => {
  const call = {
    path: "tree.ml.md",
    line: 4,
    parameters: [
      { name: "needle", line: 4, column: 15, endColumn: 21, value: "13" },
    ],
    values: [
      {
        kind: "binding",
        name: "left",
        line: 6,
        column: 14,
        endColumn: 18,
        value: "left-tree",
      },
      {
        kind: "binding",
        name: "value",
        line: 6,
        column: 20,
        endColumn: 25,
        value: "8",
      },
      {
        kind: "binding",
        name: "right",
        line: 6,
        column: 27,
        endColumn: 32,
        value: "right-tree",
      },
      {
        kind: "value",
        name: "value",
        line: 7,
        column: 30,
        endColumn: 35,
        value: "8",
      },
    ],
  };
  assert.deepEqual(
    executionCallBindings(call).map(({ name, value }) => [name, value]),
    [
      ["needle", "13"],
      ["left", "left-tree"],
      ["value", "8"],
      ["right", "right-tree"],
    ],
  );
});
