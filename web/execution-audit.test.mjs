import assert from "node:assert/strict";
import test from "node:test";

import {
  buildExecutionSnapshot,
  sealExecutionEnvelope,
} from "./execution-artifact.js";
import { buildExecutionAudit, renderExecutionAudit } from "./execution-audit.js";

const returned = (display, type = "int") => ({
  kind: "return",
  value: { type, display, fingerprint: display, complete: true },
  source: "runtime",
});

function envelope() {
  return sealExecutionEnvelope({
    schemaVersion: 1,
    evaluationId: "e1",
    requestCodeDigest: "r1",
    projectDigest: "p1",
    codeRevisionId: "c1",
    compilerInputsDigest: "i1",
    staticProgram: {
      codeRevisionId: "c1",
      compilerInputsDigest: "i1",
      compilationUnits: [
        {
          id: "u1",
          modulePath: "Demo",
          generatedPath: "demo.ml",
          byteLength: 1,
          sourceDigest: "s1",
          topLevelScopeId: "s1",
        },
      ],
      executionScopes: [{ id: "s1", kind: "top-level", unitId: "u1" }],
      constructs: [
        {
          id: "c1",
          category: "expression",
          semanticKind: "literal",
          compilerRange: { generatedPath: "demo.ml", startByte: 0, endByte: 1 },
          parentId: null,
          ownerScopeId: "s1",
          lexicalScopeId: "s1",
          syntaxFingerprint: "x",
          lexicalAncestryFingerprint: "x",
          ghost: false,
        },
      ],
      selectors: [
        {
          id: "selector-1",
          compilerRange: { generatedPath: "demo.ml", startByte: 0, endByte: 1 },
          subjectId: "c1",
          role: "construct",
          priority: 0,
          tieBreakRank: 0,
          syntaxFingerprint: "x",
        },
      ],
    },
    sourceMaps: {
      documentRevisionId: "d1",
      codeRevisionId: "c1",
      sourcesDigest: "d1",
      extractedCodeDigest: "c1",
      entries: [
        {
          selectorId: "selector-1",
          generatedPath: "demo.ml",
          startByte: 0,
          endByte: 1,
          documentPath: "demo.ml.md",
          startUtf16: 0,
          endUtf16: 1,
        },
      ],
    },
    execution: {
      occurrences: [
        {
          id: "o1",
          constructId: "c1",
          activationId: "a1",
          parentOccurrenceId: null,
          kind: "expression",
          enteredAt: 1,
          outcomeAt: 2,
          outcome: returned("1"),
        },
      ],
      activations: [
        {
          id: "a1",
          scopeId: "s1",
          functionOccurrenceId: null,
          functionConstructId: null,
          closureId: null,
          dynamicParentId: null,
          callsiteOccurrenceId: null,
          consumedCallAttemptId: null,
          occurrenceIds: ["o1"],
          parameterOccurrenceIds: [],
          enteredAt: 0,
          outcomeAt: 3,
          outcome: returned("()", "unit"),
          signature: {
            functionKey: "Demo::<top>",
            callsiteKey: null,
            parameterFingerprints: [],
            outcomeFingerprint: "()",
          },
        },
      ],
      closures: [],
      closureProvenance: [],
      callAttempts: [],
      writes: [
        {
          id: "write-1",
          activationId: "a1",
          constructId: "c1",
          sequence: 2,
          operation: "assign",
          targetId: null,
          oldValue: null,
          newValue: { type: "int", display: "2", fingerprint: "2", complete: true },
        },
      ],
    },
    terminal: { kind: "complete", finalSequence: 3, checksum: "t1" },
    artifactChecksum: "a1",
  });
}

test("canonical audit exposes every normalized table deterministically", () => {
  const built = buildExecutionSnapshot(envelope());
  assert.equal(built.ok, true);
  const first = buildExecutionAudit({ snapshot: built.snapshot });
  const second = buildExecutionAudit({ snapshot: built.snapshot });
  assert.deepEqual(second, first);
  assert.equal(first.requestCodeDigest, "r1");
  assert.equal(first.projectDigest, "p1");
  assert.equal(first.compilerInputsDigest, "i1");
  assert.equal(first.sourceMaps.entries[0].selectorId, "selector-1");
  assert.deepEqual(Object.keys(first.execution), [
    "activations",
    "callAttempts",
    "closureProvenance",
    "closures",
    "occurrences",
    "writes",
  ]);
  assert.match(renderExecutionAudit(first), /occurrences\no1  activation=a1/);
  assert.match(renderExecutionAudit(first), /write-1 .*value=2/);
  assert.match(renderExecutionAudit(first), /invariants ok$/);

  const remapped = structuredClone(envelope());
  remapped.sourceMaps.entries[0].endUtf16 = 2;
  const remappedBuilt = buildExecutionSnapshot(sealExecutionEnvelope(remapped));
  assert.equal(remappedBuilt.ok, true);
  assert.notDeepEqual(
    buildExecutionAudit({ snapshot: remappedBuilt.snapshot }).sourceMaps,
    first.sourceMaps,
  );
});
