import test from "node:test";
import assert from "node:assert/strict";

import { distributeDebugAnnotationRails } from "./debug-annotation-layout.mjs";

const item = (name) => ({ name });
const namesAt = (rails, line) =>
  (rails.get(line)?.items || []).map(({ name }) => name);

test("flows extra annotations through unused source lines", () => {
  const rails = new Map([
    [4, { items: [item("first"), item("second"), item("third")] }],
  ]);

  const distributed = distributeDebugAnnotationRails(
    rails,
    8,
    (line) => line <= 6,
  );

  assert.deepEqual(namesAt(distributed, 4), ["first"]);
  assert.deepEqual(namesAt(distributed, 5), ["second"]);
  assert.deepEqual(namesAt(distributed, 6), ["third"]);
});

test("keeps extra annotations horizontal when the next line is occupied", () => {
  const rails = new Map([
    [4, { items: [item("first"), item("second")] }],
    [5, { items: [item("own")] }],
  ]);

  const distributed = distributeDebugAnnotationRails(rails, 8);

  assert.deepEqual(namesAt(distributed, 4), ["first", "second"]);
  assert.deepEqual(namesAt(distributed, 5), ["own"]);
});

test("does not flow annotations outside eligible code lines", () => {
  const rails = new Map([
    [4, { items: [item("first"), item("second")] }],
  ]);

  const distributed = distributeDebugAnnotationRails(
    rails,
    8,
    () => false,
  );

  assert.deepEqual(namesAt(distributed, 4), ["first", "second"]);
  assert.equal(distributed.has(5), false);
});
