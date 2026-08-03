import assert from "node:assert/strict";
import test from "node:test";

await import("./oxcaml/runtime_shims.js");

function metadata(schema, kind = "expression") {
  return ["site", kind, kind, "test.ml.md", "1", "0", "1", "1", "value", schema]
    .join("\x1f");
}

function decodedTrace() {
  return globalThis.doxReadTrace()
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => Buffer.from(line.split("\t")[2], "hex").toString("latin1"));
}

function observedDisplay(schema, value) {
  globalThis.doxResetTrace();
  globalThis.caml_doclang_observe_write(metadata(schema), value);
  const [record] = decodedTrace();
  return record.split("\x1f").at(-1);
}

test("cached schemas render the runtime shapes used by Dox", () => {
  assert.equal(observedDisplay("LI", [0, 1, [0, 2, 0]]), "[1; 2]");
  assert.equal(observedDisplay("T2:IB", [0, 7, 0]), "(7, false)");
  assert.equal(observedDisplay("Q2:1:xI1:yB", [0, 5, 1]), "{x = 5; y = true}");
  assert.equal(observedDisplay("V1:4:None1:0,4:Some1:I", [0, 42]), "Some (42)");
  assert.equal(
    observedDisplay("V1:4:Leaf1:0,4:Node2:XX", [0, 0, [0, 0, 0]]),
    "Node (Leaf, Node (Leaf, Leaf))",
  );
});

test("call protocol records share one rendered return without changing output", () => {
  globalThis.doxResetTrace();
  const callMetadata = metadata("I", "call");
  const occurrence = globalThis.caml_doclang_observe_enter(callMetadata);
  globalThis.caml_doclang_observe_return(callMetadata, occurrence, 42);
  const records = decodedTrace();
  assert.equal(records.length, 4);
  assert.match(records[2], /^return\x1f/);
  assert.match(records[3], /^call-attempt-return\x1f/);
  assert.equal(records[2].split("\x1f").at(-1), "42");
  assert.equal(records[3].split("\x1f").at(-1), "42");
});

test("leaf observations preserve the enter and return trace protocol", () => {
  const leafMetadata = metadata("I");

  globalThis.doxResetTrace();
  const occurrence = globalThis.caml_doclang_observe_enter(leafMetadata);
  globalThis.caml_doclang_observe_return(leafMetadata, occurrence, 42);
  const separateRecords = decodedTrace();

  globalThis.doxResetTrace();
  globalThis.caml_doclang_observe_leaf(leafMetadata, 42);
  const leafRecords = decodedTrace();

  assert.deepEqual(leafRecords, separateRecords);
});
