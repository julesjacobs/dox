import assert from "node:assert/strict";
import test from "node:test";
import { renderExecutionValue } from "./execution-value.js";

const outcome = (display, complete = true) => ({
  kind: "return",
  value: { type: "value", display, complete },
});

test("execution values are deterministic bounded single-line renderings", () => {
  const rendered = renderExecutionValue(
    outcome(`Node (\n${"left, ".repeat(30)}right)`),
    { budget: 48 },
  );
  assert.equal(rendered.text.includes("\n"), false);
  assert.equal(Array.from(rendered.text).length <= 50, true);
  assert.equal(rendered.truncated, true);
  assert.equal(rendered.text.includes("…"), true);
  assert.deepEqual(renderExecutionValue(outcome("Some 3")), renderExecutionValue(outcome("Some 3")));
});

test("unstructured values remain a single neutral segment", () => {
  const rendered = renderExecutionValue(outcome("Node (Empty, 3, Empty)"));
  assert.deepEqual(rendered.segments, [
    { from: 0, to: rendered.text.length, role: "neutral" },
  ]);
});

test("a semantic pattern role can own the complete rendered subvalue", () => {
  const rendered = renderExecutionValue(outcome('Variable ("id")'), {
    role: "variable",
  });
  assert.deepEqual(rendered.segments, [
    { from: 0, to: rendered.text.length, role: "variable" },
  ]);
});
