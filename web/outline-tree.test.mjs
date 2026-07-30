import assert from "node:assert/strict";
import test from "node:test";
import {
  indentOutlineSubtree,
  moveOutlineSibling,
  moveOutlineSubtree,
  outdentOutlineSubtree,
} from "./outline-tree.mjs";

const outline = [
  "Alpha",
  "  One",
  "  Two",
  "Beta",
  "  Child",
  "Gamma",
].join("\n");

test("moves a subtree up and keeps its children attached", () => {
  const moved = moveOutlineSibling(outline, 3, -1);
  assert.equal(
    moved.source,
    ["Beta", "  Child", "Alpha", "  One", "  Two", "Gamma"].join("\n"),
  );
  assert.equal(moved.movedLine, 0);
  assert.deepEqual(moved.originLines, [4, 5, 1, 2, 3, 6]);
});

test("moves a nested sibling down", () => {
  const moved = moveOutlineSibling(outline, 1, 1);
  assert.equal(
    moved.source,
    ["Alpha", "  Two", "  One", "Beta", "  Child", "Gamma"].join("\n"),
  );
});

test("indents below the preceding sibling as its last child", () => {
  const moved = indentOutlineSubtree(outline, 5);
  assert.equal(
    moved.source,
    ["Alpha", "  One", "  Two", "Beta", "  Child", "  Gamma"].join("\n"),
  );
});

test("outdents after the parent without adopting later siblings", () => {
  const moved = outdentOutlineSubtree(outline, 1);
  assert.equal(
    moved.source,
    ["Alpha", "  Two", "One", "Beta", "  Child", "Gamma"].join("\n"),
  );
});

test("drops into a sibling as its first child", () => {
  const moved = moveOutlineSubtree(outline, 5, 0, "inside-first");
  assert.equal(
    moved.source,
    ["Alpha", "  Gamma", "  One", "  Two", "Beta", "  Child"].join("\n"),
  );
});

test("does not allow dropping a parent into its own subtree", () => {
  assert.equal(moveOutlineSubtree(outline, 0, 1, "inside-first"), null);
});
