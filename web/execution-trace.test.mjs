import assert from "node:assert/strict";
import test from "node:test";
import {
  buildExecutionTraceStructure,
  executionTraceNavigationTarget,
} from "./execution-trace.js";

const activation = (id, parent, enteredAt, outcomeAt, functionConstructId = id) => ({
  id,
  dynamicParentId: parent,
  enteredAt,
  outcomeAt,
  functionConstructId,
});

test("activation IDs retain their namespace while occurrence targets unwrap", () => {
  assert.deepEqual(executionTraceNavigationTarget("activation:905"), {
    kind: "activation",
    id: "activation:905",
  });
  assert.deepEqual(executionTraceNavigationTarget("occurrence:1090"), {
    kind: "occurrence",
    id: "1090",
  });
});

test("the whole-program trace nests calls and assigns output to its active callsite", () => {
  const activations = [
    activation("top", null, 0, 20, null),
    activation("outer", "top", 1, 18),
    activation("inner", "outer", 4, 10),
  ];
  const occurrences = [
    { id: "outer-call", activationId: "outer", kind: "call", enteredAt: 3, outcomeAt: 11 },
    { id: "inner-expression", activationId: "inner", kind: "expression", enteredAt: 5, outcomeAt: 9 },
  ];
  const events = [
    { sequence: 6, kind: "text", id: "message", content: "hello" },
    { sequence: 15, kind: "stdout", id: "stdout", content: "done\n" },
  ];
  const rows = buildExecutionTraceStructure({
    activations,
    occurrences,
    events,
    finalSequence: 20,
  });
  assert.deepEqual(
    rows.map((row) => [
      row.kind,
      row.activation?.id || row.event?.id,
      row.depth,
      row.activationId || null,
      row.occurrenceId || null,
    ]),
    [
      ["activation", "outer", 0, null, null],
      ["activation", "inner", 1, null, null],
      ["output", "message", 2, "inner", "inner-expression"],
      ["output", "stdout", 1, "outer", null],
    ],
  );
});

test("top-level output remains a navigable root row when no function is active", () => {
  const rows = buildExecutionTraceStructure({
    activations: [activation("top", null, 0, 4, null)],
    occurrences: [
      { id: "doc-call", activationId: "top", kind: "call", enteredAt: 1, outcomeAt: 3 },
    ],
    events: [{ sequence: 2, kind: "value", id: "answer", content: "int\u001f42" }],
    finalSequence: 4,
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].depth, 0);
  assert.equal(rows[0].occurrenceId, "doc-call");
});

test("an output marker owns the event even when sequence intervals overlap", () => {
  const rows = buildExecutionTraceStructure({
    activations: [
      activation("top", null, 0, 20, null),
      activation("first", "top", 1, 18),
      activation("second", "top", 2, 17),
    ],
    occurrences: [
      { id: "first-body", activationId: "first", kind: "expression", enteredAt: 3, outcomeAt: 16 },
      { id: "second-body", activationId: "second", kind: "expression", enteredAt: 4, outcomeAt: 15 },
    ],
    events: [
      {
        sequence: 10,
        kind: "stdout",
        id: "stdout",
        content: "marked\n",
        parentOccurrenceId: "first-body",
      },
    ],
    finalSequence: 20,
  });
  const output = rows.find((row) => row.kind === "output");
  assert.equal(output.activationId, "first");
  assert.equal(output.occurrenceId, "first-body");
});
