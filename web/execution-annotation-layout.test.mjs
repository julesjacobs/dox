import assert from "node:assert/strict";
import test from "node:test";

import {
  executionAnnotationColumn,
  executionAnnotationRail,
  minimumExecutionAnnotationGap,
} from "./execution-annotation-layout.js";

test("annotation rail aligns short lines and gives long source a clear gap", () => {
  assert.equal(executionAnnotationColumn(12), 72);
  assert.equal(executionAnnotationColumn(65), 72);
  assert.equal(executionAnnotationColumn(66), 73);
  assert.equal(executionAnnotationColumn(70), 77);
  assert.equal(executionAnnotationColumn(98), 105);
});

test("annotation rail preserves its minimum gap for every long line", () => {
  for (let length = 66; length <= 240; length += 1) {
    assert.ok(
      executionAnnotationColumn(length) - length >=
        minimumExecutionAnnotationGap,
    );
  }
});

test("one annotation rail is shared by top level and function activations", () => {
  const documentRail = executionAnnotationRail();
  const topLevelColumn = executionAnnotationColumn(32, documentRail);
  const activationColumn = executionAnnotationColumn(32, documentRail);
  assert.equal(documentRail, 72);
  assert.equal(topLevelColumn, activationColumn);
  assert.equal(topLevelColumn, 72);
  assert.equal(executionAnnotationRail(48), 48);
});
