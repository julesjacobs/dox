import assert from "node:assert/strict";
import test from "node:test";
import {
  diagnosticSourceLocations,
  formatDiagnosticMessage,
  inspectorDiagnostics,
  staleExecutionLabel,
} from "./evaluation-presentation.js";

const diagnostics = [
  { path: "page.ml.md", line: 3, message: "first" },
  { path: "page.ml.md", line: 8, message: "second" },
  { path: "other.ml.md", line: 3, message: "other page" },
];

test("a failed evaluation exposes every diagnostic for the current page", () => {
  assert.deepEqual(
    inspectorDiagnostics(
      { ok: false, diagnostics },
      { path: "page.ml.md", cursorLine: 3 },
    ).map((diagnostic) => diagnostic.message),
    ["first", "second"],
  );
});

test("successful evaluation diagnostics remain cursor-local", () => {
  assert.deepEqual(
    inspectorDiagnostics(
      { ok: true, diagnostics },
      { path: "page.ml.md", cursorLine: 3 },
    ).map((diagnostic) => diagnostic.message),
    ["first"],
  );
});

test("stale execution is named according to whether evaluation finished", () => {
  assert.equal(staleExecutionLabel({ ok: false }), "Last successful execution");
  assert.equal(staleExecutionLabel({ ok: true }), "Execution is updating");
});

test("compiler locations become a concise message and related source ranges", () => {
  const message =
    'File "page.ml.md", line 8, characters 0-3:\n' +
    'Error: Syntax error: ) expected\n' +
    'File "page.ml.md", line 6, characters 11-12:\n' +
    '  This ( might be unmatched\n';
  assert.equal(
    formatDiagnosticMessage(message),
    "Syntax error: ) expected\nLine 6 · This ( might be unmatched",
  );
  assert.deepEqual(
    diagnosticSourceLocations({
      path: "page.ml.md",
      line: 8,
      columnStart: 0,
      columnEnd: 3,
      message,
    }),
    [
      {
        path: "page.ml.md",
        line: 8,
        columnStart: 0,
        columnEnd: 3,
        primary: true,
      },
      {
        path: "page.ml.md",
        line: 6,
        columnStart: 11,
        columnEnd: 12,
        primary: false,
      },
    ],
  );
});

test("a hint keeps its own line while wrapped text is rejoined", () => {
  assert.equal(
    formatDiagnosticMessage(
      // Exactly as the compiler wraps it: the hint's continuation is not
      // indented, so only the label marks a real break.
      'File "page.ml.md", line 14, characters 4-10:\n' +
        "Error: Unbound value adjust\n" +
        "Hint: If this is a recursive definition,\n" +
        "you should add the rec keyword on line 10\n",
    ),
    "Unbound value adjust\n" +
      "Hint: If this is a recursive definition, you should add the rec keyword on line 10",
  );
});

test("wrapped compiler prose reads as one compact message", () => {
  assert.equal(
    formatDiagnosticMessage(
      'File "page.ml.md", line 3, characters 8-11:\n' +
        'Error: This constant has type string but an expression was expected of type\n' +
        '         int\n',
    ),
    "This constant has type string but an expression was expected of type int",
  );
});
