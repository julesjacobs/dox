import assert from "node:assert/strict";
import test from "node:test";
import {
  deriveOutlineOperation,
  duplicateOutlineModule,
  outlineDraftPreviewTitle,
  remapModule,
  selectedWorkspaceInvariant,
} from "./outline-operation.mjs";

const row = (originTarget, targetModule = originTarget) => ({
  originTarget,
  pageModule: targetModule,
  targetModule,
});

test("a duplicate draft identifies only the two conflicting rows", () => {
  assert.deepEqual(
    duplicateOutlineModule([
      { targetModule: "Welcome", sourceLine: 1 },
      { targetModule: "Test", sourceLine: 2 },
      { targetModule: "Guide", sourceLine: 3 },
      { targetModule: "Test", sourceLine: 8 },
    ]),
    { modulePath: "Test", lines: [2, 8] },
  );
});

test("an invalid page preview follows typed text instead of stale identity", () => {
  assert.equal(
    outlineDraftPreviewTitle("Test", {
      invalid: true,
      proposedPath: "Tes",
    }),
    "Test",
  );
  assert.equal(
    outlineDraftPreviewTitle("  Child", {
      proposedPath: "Parent.Child",
    }),
    "Parent.Child",
  );
});

test("derives one create-and-order operation", () => {
  const operation = deriveOutlineOperation({
    committedRows: [row("Alpha"), row("Fib")],
    draftRows: [row("Alpha"), row(null, "Scratch"), row("Fib")],
    openModule: "Scratch",
  });
  assert.deepEqual(operation, {
    kind: "create",
    previous: ["Alpha", "Fib"],
    order: ["Alpha", "Scratch", "Fib"],
    created: ["Scratch"],
    openModule: "Scratch",
  });
});

test("derives a nesting refactor with its final order", () => {
  const operation = deriveOutlineOperation({
    committedRows: [row("Alpha"), row("Child")],
    draftRows: [row("Alpha"), row("Child", "Alpha.Child")],
    openModule: "Child",
  });
  assert.equal(operation.kind, "refactor");
  assert.deepEqual(operation.renames, [
    { before: "Child", after: "Alpha.Child" },
  ]);
  assert.deepEqual(operation.order, ["Alpha", "Alpha.Child"]);
  assert.equal(operation.openModule, "Alpha.Child");
});

test("rejects compound page identity changes without dropping any of them", () => {
  const operation = deriveOutlineOperation({
    committedRows: [row("Alpha"), row("Beta")],
    draftRows: [row("Alpha", "Renamed"), row(null, "Created")],
  });
  assert.equal(operation.kind, "ambiguous");
  assert.deepEqual(operation.renames, [
    { before: "Alpha", after: "Renamed" },
  ]);
  assert.deepEqual(operation.created, ["Created"]);

  const deletion = deriveOutlineOperation({
    committedRows: [row("Alpha"), row("Beta")],
    draftRows: [row("Alpha", "Renamed")],
  });
  assert.equal(deletion.kind, "ambiguous");
  assert.deepEqual(deletion.renames, [
    { before: "Alpha", after: "Renamed" },
  ]);
  assert.deepEqual(deletion.deleted, ["Beta"]);

  const reusedName = deriveOutlineOperation({
    committedRows: [row("Alpha"), row("Beta")],
    draftRows: [row("Alpha", "Beta")],
  });
  assert.equal(reusedName.kind, "ambiguous");
  assert.deepEqual(reusedName.renames, [
    { before: "Alpha", after: "Beta" },
  ]);
  assert.deepEqual(reusedName.deleted, ["Beta"]);
});

test("remaps descendants together with a renamed parent", () => {
  assert.equal(
    remapModule("Old.Child.Leaf", [{ before: "Old", after: "New" }]),
    "New.Child.Leaf",
  );
});

test("selected workspace consumers cannot drift", () => {
  assert.equal(
    selectedWorkspaceInvariant({
      selectedPage: "Scratch",
      routePage: "Scratch",
      outlinePage: "Scratch",
      sessionPage: "Scratch",
    }),
    true,
  );
  assert.equal(
    selectedWorkspaceInvariant({
      selectedPage: "Scratch",
      routePage: "Fib",
      outlinePage: "Scratch",
      sessionPage: "Scratch",
    }),
    false,
  );
});
