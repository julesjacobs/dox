import assert from "node:assert/strict";
import test from "node:test";

import {
  createExecutionRecency,
  executionChoiceSignature,
  executionChoiceStamp,
  noteExecutionChoice,
  preferredExecutionChoice,
} from "./execution-preference.js";

function choice(id, input, output, eventIndex) {
  return {
    eventIndex,
    event: { occurrenceId: id, path: "fib.ml.md", label: "fib" },
    call: {
      id,
      path: "fib.ml.md",
      label: "fib",
      parameters: [{ name: "n", value: input, type: "int" }],
      outcome: "return",
      value: output,
    },
  };
}

test("prefers the most recently viewed activation", () => {
  const recency = createExecutionRecency();
  const choices = [choice("first", "2", "1", 3), choice("second", "3", "2", 8)];
  noteExecutionChoice(recency, choices[1]);
  assert.equal(preferredExecutionChoice(choices, recency), choices[1]);
});

test("input and output values retain preference across a rebuilt trace", () => {
  const recency = createExecutionRecency();
  noteExecutionChoice(recency, choice("old-occurrence", "3", "2", 8));
  const rebuilt = [
    choice("new-first", "2", "1", 4),
    choice("new-second", "3", "2", 11),
  ];
  assert.equal(preferredExecutionChoice(rebuilt, recency), rebuilt[1]);
});

test("records the owner activation rather than an invoked child call", () => {
  const recency = createExecutionRecency();
  const viewed = choice("child", "1", "1", 8);
  viewed.ownerCall = {
    id: "owner-old",
    path: "fib.ml.md",
    label: "fib",
    parameters: [{ name: "n", value: "2", type: "int" }],
    outcome: "return",
    value: "1",
  };
  noteExecutionChoice(recency, viewed);
  const matchingOwner = choice("other-child", "1", "1", 11);
  matchingOwner.ownerCall = { ...viewed.ownerCall, id: "owner-new" };
  const differentOwner = choice("third-child", "1", "1", 13);
  differentOwner.ownerCall = {
    ...viewed.ownerCall,
    id: "owner-other",
    parameters: [{ name: "n", value: "4", type: "int" }],
    value: "3",
  };
  assert.equal(
    preferredExecutionChoice([differentOwner, matchingOwner], recency),
    matchingOwner,
  );
});

test("keeps the current execution when no viewed preference exists", () => {
  const recency = createExecutionRecency();
  const choices = [choice("first", "2", "1", 3), choice("second", "3", "2", 8)];
  assert.equal(
    preferredExecutionChoice(choices, recency, { currentEventIndex: 8 }),
    choices[1],
  );
});

test("does not conflate whitespace-distinct values", () => {
  const spaced = choice("spaced", "0", '"a  b"', 1);
  const compact = choice("compact", "0", '"a b"', 2);
  assert.notEqual(
    executionChoiceSignature(spaced),
    executionChoiceSignature(compact),
  );
});

test("does not reuse raw occurrence ids across evaluations", () => {
  const recency = createExecutionRecency();
  noteExecutionChoice(recency, choice("1", "2", "1", 3), {
    namespace: "evaluation-a",
  });
  const unrelated = choice("1", "99", "100", 4);
  assert.equal(
    executionChoiceStamp(recency, unrelated, { namespace: "evaluation-b" }),
    0,
  );
});

test("retains an input and output preference across evaluation namespaces", () => {
  const recency = createExecutionRecency();
  noteExecutionChoice(recency, choice("old", "3", "2", 8), {
    namespace: "evaluation-a",
  });
  const rebuilt = choice("new", "3", "2", 11);
  assert.ok(
    executionChoiceStamp(recency, rebuilt, { namespace: "evaluation-b" }) > 0,
  );
});
