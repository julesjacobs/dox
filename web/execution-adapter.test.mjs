import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  createExecutionAuditBaseline,
  dispatchExecutionIntent,
  executionDocumentRevisionId,
  executionDigest,
  executionExecutableParts,
  executionPendingToken,
  executionRequestCodeDigest,
  executionSource,
  installExecutionArtifact,
  presentExecution,
} from "./execution-adapter.js";
import { sealExecutionEnvelope } from "./execution-artifact.js";

const directory = path.dirname(fileURLToPath(import.meta.url));

test("execution identities use standard SHA-256", () => {
  assert.equal(
    executionDigest("abc"),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});

test("document identity frames paths and contents without separator collisions", () => {
  const oneFile = new Map([["a", "b\u0001c\u0000d"]]);
  const twoFiles = new Map([
    ["a", "b"],
    ["c", "d"],
  ]);
  assert.notEqual(
    executionDocumentRevisionId(oneFile),
    executionDocumentRevisionId(twoFiles),
  );
});

test("source identity orders paths by UTF-8 bytes like OCaml", () => {
  const sources = new Map([
    ["😀.ml.md", "astral"],
    ["\uE000.ml.md", "private"],
  ]);
  assert.equal(
    executionDocumentRevisionId(sources),
    "1405eee1a0c19705603709c5da77774121e8b05984f48dd7a3689b6e3e2e56df",
  );
});

test("source identities match the cross-language golden protocol", () => {
  const source =
    '# Intro\n\n```ocaml\nlet greeting = "hé"\n```\n\nInline `String.length greeting =`\n';
  const sources = { "unicode/δ.ml.md": source };
  assert.equal(
    executionRequestCodeDigest(sources),
    "7fe572af53a6283b32cdb447ea8b7aaa382a561126c6df408ce4e703432b565c",
  );
  assert.equal(
    executionDocumentRevisionId(sources),
    "f58268539f90638cb50ea5e219e5b233f161fea20db1292950b9b8bbcb5b32c6",
  );
  const edgeSource =
    "- prose item\n    continued prose\n\n    let x = 1\n\n    let y = x + 1\n\n```ocaml-example\nlet ignored = 0\n```\n\nInline `x + y =`\n";
  assert.equal(
    executionRequestCodeDigest({ "edge.ml.md": edgeSource }),
    "3a4df67294554aac0794c19665b6fabcb613eb7ff692af0986c32d6acdde9b84",
  );
  const crlfSource =
    "Mention a first.\r\n\r\n```ocaml\r\nlet x = 1\r\n```\r\n\r\nInline `z =` then `a =`\r\n";
  assert.equal(
    executionRequestCodeDigest({ "crlf.ml.md": crlfSource }),
    "32f8c8124288ab64b0b5b79a48c1273682645c0204e057d779891265b3184770",
  );
  assert.deepEqual(executionExecutableParts(crlfSource), [
    ["block", "let x = 1\r"],
    ["inline", "z"],
    ["inline", "a"],
  ]);
  assert.equal(
    executionDocumentRevisionId({ "crlf.ml.md": crlfSource }),
    "55286e906c801ecca634668708ada253735e0aa0033386b2b49a0de092e114a2",
  );
  assert.deepEqual(
    executionExecutableParts("~~~ocaml\nInline `1 + 2 =`\n~~~\n"),
    [],
  );
  assert.deepEqual(
    executionExecutableParts("~~~text\n    let hidden = 41\n~~~\n"),
    [],
  );
  assert.deepEqual(
    executionExecutableParts("~~~text\n```ocaml\nlet hidden = 42\n```\n~~~\n"),
    [],
  );
  assert.deepEqual(
    executionExecutableParts("    ```ocaml\nlet x = 1\n    ```\n"),
    [["block", "let x = 1"]],
  );
});

test("tab-separated OCaml fence metadata is executable", () => {
  assert.deepEqual(
    executionExecutableParts(
      "```ocaml\tname=tabbed\nlet answer = 42\n```\n",
    ),
    [["block", "let answer = 42"]],
  );
});

function envelope() {
  return sealExecutionEnvelope({
    schemaVersion: 1,
    evaluationId: "evaluation-1",
    requestCodeDigest: executionRequestCodeDigest({ "fib.ml.md": "    fib 5\n" }),
    projectDigest: "project-1",
    compilerInputsDigest: "compiler-1",
    codeRevisionId: "code-1",
    staticProgram: {
      codeRevisionId: "code-1",
      compilerInputsDigest: "compiler-1",
      compilationUnits: [
        {
          id: "unit-1",
          modulePath: "Fib",
          generatedPath: "fib.ml",
          byteLength: 5,
          sourceDigest: "source-1",
          topLevelScopeId: "scope-top",
        },
      ],
      executionScopes: [
        {
          id: "scope-top",
          kind: "top-level",
          unitId: "unit-1",
        },
      ],
      constructs: [
        {
          id: "construct-1",
          category: "expression",
          semanticKind: "literal",
          parentId: null,
          ownerScopeId: "scope-top",
          lexicalScopeId: "scope-top",
          syntaxFingerprint: "fingerprint",
          lexicalAncestryFingerprint: "ancestry",
          ghost: false,
          compilerRange: {
            generatedPath: "fib.ml",
            startByte: 0,
            endByte: 5,
          },
        },
      ],
      selectors: [
        {
          id: "selector-1",
          role: "construct",
          subjectId: "construct-1",
          priority: 0,
          tieBreakRank: 0,
          syntaxFingerprint: "fingerprint",
          compilerRange: {
            generatedPath: "fib.ml",
            startByte: 0,
            endByte: 5,
          },
        },
      ],
    },
    execution: {
      occurrences: [
        {
          id: "occurrence-1",
          constructId: "construct-1",
          activationId: "activation-1",
          kind: "expression",
          enteredAt: 1,
          outcomeAt: 2,
          outcome: {
            kind: "return",
            value: {
              type: "int",
              display: "5",
              fingerprint: "5",
              complete: true,
            },
            source: "runtime",
          },
          parentOccurrenceId: null,
        },
      ],
      activations: [
        {
          id: "activation-1",
          scopeId: "scope-top",
          functionConstructId: null,
          functionOccurrenceId: null,
          callsiteOccurrenceId: null,
          closureId: null,
          consumedCallAttemptId: null,
          dynamicParentId: null,
          enteredAt: 0,
          outcomeAt: 3,
          occurrenceIds: ["occurrence-1"],
          parameterOccurrenceIds: [],
          outcome: {
            kind: "return",
            value: {
              type: "unit",
              display: "()",
              fingerprint: "()",
              complete: true,
            },
            source: "runtime",
          },
          signature: {
            functionKey: "Program",
            callsiteKey: null,
            parameterFingerprints: [],
            outcomeFingerprint: "()",
          },
        },
      ],
      closures: [],
      closureProvenance: [],
      callAttempts: [],
      writes: [],
    },
    sourceMaps: {
      documentRevisionId: executionDocumentRevisionId({
        "fib.ml.md": "    fib 5\n",
      }),
      codeRevisionId: "code-1",
      sourcesDigest: "sources-1",
      extractedCodeDigest: "code-1",
      entries: [
        {
          selectorId: "selector-1",
          generatedPath: "fib.ml",
          startByte: 0,
          endByte: 5,
          documentPath: "fib.ml.md",
          startUtf16: 4,
          endUtf16: 9,
        },
      ],
    },
    terminal: { kind: "complete", finalSequence: 3, checksum: "terminal-1" },
    artifactChecksum: "artifact-1",
  });
}

test("the adapter installs one validated state and presents it", () => {
  const installed = installExecutionArtifact({
    envelope: envelope(),
    sources: { "fib.ml.md": "    fib 5\n" },
    cursor: { path: "fib.ml.md", line: 1, column: 5 },
  });
  assert.equal(
    installed.decision,
    "artifact-installed",
    JSON.stringify(installed.problems),
  );
  assert.equal(installed.problems.length, 0);
  assert.equal(installed.model.selection.constructId, "construct-1");
  assert.equal(installed.model.selection.activationId, "activation-1");
  assert.deepEqual(presentExecution(installed.state), installed.model);
  assert.equal(
    installed.artifact.requestCodeDigest,
    executionRequestCodeDigest({ "fib.ml.md": "    fib 5\n" }),
  );
});

test("the audit baseline clears selection and recency without changing its view", () => {
  const installed = installExecutionArtifact({
    envelope: envelope(),
    sources: { "fib.ml.md": "    fib 5\n" },
    cursor: { path: "fib.ml.md", line: 1, column: 5 },
  });
  const baseline = createExecutionAuditBaseline(installed.state);
  assert.equal(baseline.view, installed.state.view);
  assert.deepEqual(baseline.selection, {
    selectorId: null,
    constructId: null,
    activationId: null,
    focusedOccurrenceId: null,
  });
  assert.equal(presentExecution(baseline).occurrenceList.count, 0);
});

test("a CRLF artifact installs into normalized editor coordinates", () => {
  const source = "    fib 5\r\n";
  const base = envelope();
  const crlfEnvelope = sealExecutionEnvelope({
    ...base,
    requestCodeDigest: executionRequestCodeDigest({ "fib.ml.md": source }),
    staticProgram: {
      ...base.staticProgram,
      compilationUnits: base.staticProgram.compilationUnits.map((unit) => ({
        ...unit,
        byteLength: 6,
      })),
    },
    sourceMaps: {
      ...base.sourceMaps,
      documentRevisionId: executionDocumentRevisionId({ "fib.ml.md": source }),
    },
  });
  const installed = installExecutionArtifact({
    envelope: crlfEnvelope,
    sources: { "fib.ml.md": source },
    cursor: { path: "fib.ml.md", line: 1, column: 5 },
  });
  assert.equal(installed.decision, "artifact-installed");
  assert.equal(installed.model.selection.constructId, "construct-1");
  assert.equal(installed.state.requestCodeDigest, crlfEnvelope.requestCodeDigest);
  assert.equal(executionSource(installed.state, "fib.ml.md"), "    fib 5\n");
});

test("a loaded source rejects out-of-bounds editor mappings atomically", () => {
  const base = envelope();
  const invalid = sealExecutionEnvelope({
    ...base,
    sourceMaps: {
      ...base.sourceMaps,
      entries: base.sourceMaps.entries.map((entry) => ({
        ...entry,
        endUtf16: 999,
      })),
    },
  });
  const installed = installExecutionArtifact({
    envelope: invalid,
    sources: { "fib.ml.md": "    fib 5\n" },
  });
  assert.equal(installed.decision, "artifact-source-map-invalid");
  assert.equal(installed.state, null);
  assert.ok(
    installed.problems.some((problem) => problem.code === "source-map-install-failed"),
  );
});

test("a corrupted request identity cannot be blessed", () => {
  const corrupted = { ...envelope(), requestCodeDigest: "corrupted" };
  const installed = installExecutionArtifact({
    envelope: corrupted,
    sources: { "fib.ml.md": "    fib 5\n" },
  });
  assert.equal(installed.decision, "artifact-validation-failed");
  assert.equal(installed.state, null);
  assert.ok(
    installed.problems.some((problem) => problem.code === "artifact-checksum-invalid"),
  );
});

test("a valid artifact for different executable source is rejected", () => {
  const installed = installExecutionArtifact({
    envelope: envelope(),
    sources: { "fib.ml.md": "    fib 6\n" },
  });
  assert.equal(installed.decision, "artifact-source-identity-mismatch");
  assert.equal(installed.state, null);
  assert.deepEqual(
    installed.problems.map((problem) => problem.code),
    ["request-code-digest-mismatch"],
  );
});

test("a sealed artifact for a different document revision is rejected", () => {
  const original = envelope();
  const mismatched = sealExecutionEnvelope({
    ...original,
    sourceMaps: {
      ...original.sourceMaps,
      documentRevisionId: "different-document",
    },
  });
  const installed = installExecutionArtifact({
    envelope: mismatched,
    sources: { "fib.ml.md": "    fib 5\n" },
  });
  assert.equal(installed.decision, "artifact-source-identity-mismatch");
  assert.deepEqual(
    installed.problems.map((problem) => problem.code),
    ["document-revision-id-mismatch"],
  );
});

test("a matching artifact can satisfy an A to B to A cache lookup", () => {
  const original = "    fib 5\n";
  const installed = installExecutionArtifact({
    envelope: envelope(),
    sources: { "fib.ml.md": original },
  });
  const changed = dispatchExecutionIntent(installed.state, {
    kind: "document-edited",
    path: "fib.ml.md",
    source: "    fib 6\n",
    change: { from: 8, to: 9, insert: "6" },
  });
  const restored = dispatchExecutionIntent(changed.state, {
    kind: "document-edited",
    path: "fib.ml.md",
    source: original,
    change: { from: 8, to: 9, insert: "5" },
  });
  const token = executionPendingToken(restored.state);
  assert.equal(token.requestCodeDigest, installed.artifact.requestCodeDigest);
  const reused = dispatchExecutionIntent(restored.state, {
    kind: "artifact-available",
    token,
    artifact: installed.artifact,
  });
  assert.match(reused.decision, /^artifact-installed:/);
  assert.equal(reused.model.authority, "exact");
});

test("one adapter dispatch produces one model and preserves reducer effects", () => {
  const installed = installExecutionArtifact({
    envelope: envelope(),
    sources: { "fib.ml.md": "    fib 5\n" },
  });
  const moved = dispatchExecutionIntent(installed.state, {
    kind: "activation-navigated",
    activationId: "activation-1",
  });
  assert.equal(moved.decision, "activation-has-no-source-occurrence");
  assert.deepEqual(moved.effects, []);
  assert.equal(moved.model.authority, "exact");
});

test("code edits expose their exact request token through the adapter", () => {
  const installed = installExecutionArtifact({
    envelope: envelope(),
    sources: { "fib.ml.md": "    fib 5\n" },
  });
  const edited = dispatchExecutionIntent(installed.state, {
    kind: "document-edited",
    path: "fib.ml.md",
    source: "    fib 6\n",
    change: { from: 8, to: 9, insert: "6" },
    projectDigest: "project-2",
  });
  assert.equal(edited.decision, "document-code-updated");
  assert.equal(edited.model.authority, "stale");
  assert.equal(executionPendingToken(edited.state).projectDigest, "project-2");
});

test("document revision identity is stable across an A to B to A edit", () => {
  const original = "    fib 5\n";
  const installed = installExecutionArtifact({
    envelope: envelope(),
    sources: { "fib.ml.md": original },
  });
  const changed = dispatchExecutionIntent(installed.state, {
    kind: "document-edited",
    path: "fib.ml.md",
    source: "    fib 6\n",
    change: { from: 8, to: 9, insert: "6" },
  });
  const restored = dispatchExecutionIntent(changed.state, {
    kind: "document-edited",
    path: "fib.ml.md",
    source: original,
    change: { from: 8, to: 9, insert: "5" },
  });
  assert.equal(
    executionPendingToken(restored.state).documentRevisionId,
    executionDocumentRevisionId({ "fib.ml.md": original }),
  );
});

test("editing a non-executed OCaml example does not stale execution", () => {
  const original = "```ocaml-example\nlet example = 1\n```\n    fib 5\n";
  const changedSource = original.replace("example = 1", "example = 2");
  const baseEnvelope = envelope();
  const matchingEnvelope = sealExecutionEnvelope({
    ...baseEnvelope,
    sourceMaps: {
      ...baseEnvelope.sourceMaps,
      documentRevisionId: executionDocumentRevisionId({
        "fib.ml.md": original,
      }),
    },
  });
  const installed = installExecutionArtifact({
    envelope: matchingEnvelope,
    sources: { "fib.ml.md": original },
  });
  const from = original.indexOf("1");
  const edited = dispatchExecutionIntent(installed.state, {
    kind: "document-edited",
    path: "fib.ml.md",
    source: changedSource,
    change: { from, to: from + 1, insert: "2" },
  });
  assert.equal(edited.decision, "document-prose-updated");
  assert.equal(edited.model.authority, "exact");
  assert.deepEqual(edited.effects, []);
});

test("browser modules cannot import execution internals", () => {
  const browserEntry = fs.readFileSync(path.join(directory, "app.js"), "utf8");
  const forbidden = [
    "./execution-artifact.js",
    "./execution-query.js",
    "./execution-reconcile.js",
    "./execution-reducer.js",
    "./execution-view.js",
    "./execution-lens.js",
    "./execution-session.js",
    "./execution-preference.js",
    "./execution-draft.js",
    "./execution-timeline.js",
    "./execution-record.js",
    "./execution-cursor.js",
  ];
  assert.deepEqual(
    forbidden.filter((specifier) => browserEntry.includes(specifier)),
    [],
  );
  assert.deepEqual(
    ["executionLayoutChanged", "remapExecutionEvents"].filter((helper) =>
      browserEntry.includes(helper),
    ),
    [],
  );
});
