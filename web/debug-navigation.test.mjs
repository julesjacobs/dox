import assert from "node:assert/strict";
import test from "node:test";

import { createDebugNavigationGate } from "./debug-navigation.js";

const pointerdown = (button = 0, isPrimary = true) => ({
  button,
  isPrimary,
});

const click = (button = 0, detail = 1, shiftKey = false) => ({
  button,
  detail,
  shiftKey,
});

test("one pointer click navigates once after its link is replaced", () => {
  const gate = createDebugNavigationGate();
  let navigations = 0;
  const navigate = () => {
    navigations += 1;
  };

  assert.equal(gate.canNavigatePointerdown(pointerdown()), true);
  navigate("parent-call");
  gate.suppressClickAfterPointerdown();
  if (gate.shouldNavigateClick(click())) navigate("replacement-child-call");
  assert.equal(navigations, 1);
  assert.equal(gate.shouldNavigateClick(click()), true);
});

test("replacement suppression is global across parent and child links", () => {
  for (const [pointerTarget, replacementTarget] of [
    ["parent", "child"],
    ["child", "parent"],
  ]) {
    const gate = createDebugNavigationGate();
    const navigations = [pointerTarget];
    gate.suppressClickAfterPointerdown();
    if (gate.shouldNavigateClick(click())) navigations.push(replacementTarget);
    assert.deepEqual(navigations, [pointerTarget]);
  }
});

test("a keyboard-generated click still navigates during suppression", () => {
  const gate = createDebugNavigationGate();
  gate.suppressClickAfterPointerdown();
  assert.equal(gate.shouldNavigateClick(click(0, 0)), true);
  assert.equal(gate.shouldNavigateClick(click()), false);
});

test("right, middle, and non-primary pointers never navigate", () => {
  const gate = createDebugNavigationGate();
  assert.equal(gate.canNavigatePointerdown(pointerdown(1)), false);
  assert.equal(gate.canNavigatePointerdown(pointerdown(2)), false);
  assert.equal(gate.canNavigatePointerdown(pointerdown(0, false)), false);
  assert.equal(gate.shouldNavigateClick(click(1)), false);
  assert.equal(gate.shouldNavigateClick(click(2)), false);
});

test("an old timeout cannot clear a newer interaction", () => {
  const gate = createDebugNavigationGate();
  const first = gate.suppressClickAfterPointerdown();
  const second = gate.suppressClickAfterPointerdown();
  gate.clearSuppressedClick(first);
  assert.equal(gate.shouldNavigateClick(click()), false);
  gate.clearSuppressedClick(second);
});
