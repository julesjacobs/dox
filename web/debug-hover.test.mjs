import assert from "node:assert/strict";
import test from "node:test";

import {
  debugBindingHasVisibleTarget,
  debugBindingKeysMatch,
  debugHoverTooltipPosition,
  debugValueTooltipGap,
} from "./debug-hover.js";

test("matches a binder only to its exact value bubble", () => {
  const left = "demos/tracing.ml.md:15:14:18:left";
  const right = "demos/tracing.ml.md:15:29:34:right";
  assert.equal(debugBindingKeysMatch(left, left), true);
  assert.equal(debugBindingKeysMatch(left, right), false);
  assert.equal(debugBindingKeysMatch(left, ""), false);
});

test("suppresses a binder tooltip only when its own value bubble is visible", () => {
  const left = "demos/tracing.ml.md:15:14:18:left";
  const current = "demos/tracing.ml.md:15:20:27:current";
  assert.equal(debugBindingHasVisibleTarget(left, [current, left]), true);
  assert.equal(debugBindingHasVisibleTarget(left, [current]), false);
});

test("shares one cursor and pointer tooltip gap", () => {
  assert.deepEqual(debugValueTooltipGap, { x: 16, y: 18 });
});

test("keeps the value tooltip at a comfortable distance from the pointer", () => {
  assert.deepEqual(
    debugHoverTooltipPosition({
      pointerX: 100,
      pointerY: 80,
      width: 180,
      height: 32,
      viewportWidth: 800,
      viewportHeight: 600,
    }),
    { x: 116, y: 98 },
  );
});

test("moves the value tooltip to the other side near viewport edges", () => {
  assert.deepEqual(
    debugHoverTooltipPosition({
      pointerX: 790,
      pointerY: 590,
      width: 180,
      height: 32,
      viewportWidth: 800,
      viewportHeight: 600,
    }),
    { x: 594, y: 540 },
  );
});

test("keeps an oversized value tooltip inside the visible viewport", () => {
  assert.deepEqual(
    debugHoverTooltipPosition({
      pointerX: 4,
      pointerY: 4,
      width: 780,
      height: 580,
      viewportWidth: 800,
      viewportHeight: 600,
    }),
    { x: 8, y: 8 },
  );
});
