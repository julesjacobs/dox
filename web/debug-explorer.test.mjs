import assert from "node:assert/strict";
import test from "node:test";
import { pointerColumn } from "./debug-explorer.js";

test("the Debug pointer resolver supports caretRangeFromPoint", () => {
  const run = { dataset: { debugFrom: "4" } };
  const parent = { closest: () => run };
  const text = { nodeType: 3, parentElement: parent };
  const code = {
    contains: (node) => node === text,
    getBoundingClientRect: () => ({ right: 100 }),
  };
  const document_ = {
    caretRangeFromPoint: () => ({ startContainer: text, startOffset: 3 }),
  };
  assert.equal(
    pointerColumn({ document_, code, source: "abcdefghij", clientX: 50, clientY: 1 }),
    7,
  );
});

test("the Debug pointer resolver keeps deterministic edge fallbacks", () => {
  const code = {
    contains: () => false,
    getBoundingClientRect: () => ({ right: 100 }),
  };
  const document_ = {};
  assert.equal(
    pointerColumn({ document_, code, source: "abc", clientX: 50, clientY: 1 }),
    0,
  );
  assert.equal(
    pointerColumn({ document_, code, source: "abc", clientX: 101, clientY: 1 }),
    3,
  );
});
