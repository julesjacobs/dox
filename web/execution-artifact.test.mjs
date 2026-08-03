import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCompilerContractCapture,
  buildExecutionSnapshot,
  compilerContractCaptureToJson,
  executionChecksum,
  renderCompilerContractCapture,
  sealExecutionEnvelope,
  snapshotActivation,
  snapshotActivationIdsForConstruct,
  snapshotChildActivationIds,
  snapshotCallAttemptsForActivation,
  snapshotConstruct,
  snapshotExecutedConstructIds,
  snapshotOccurrence,
  snapshotOccurrenceIdsForActivationConstruct,
  snapshotOccurrenceIdsForConstruct,
} from "./execution-artifact.js";

test("artifact transport checksum has a stable cross-language encoding", () => {
  assert.equal(executionChecksum("abc"), "1a47e90b");
});

function payload() {
  return {
    path: "fib.ml.md",
    projectVersion: "p1",
    evaluation: {
      evaluationId: "e1",
      status: "ready",
      compilerManifests: [
        {
          unitName: "Dox__Fib",
          topLevelScopeId: "scope-top",
          executionScopes: [
            {
              id: "scope-top",
              kind: "top-level",
              functionConstructId: null,
            },
          ],
          constructs: [
            {
              id: "unit-expression-1",
              category: "expression",
              semanticKind: "literal",
              generatedPath: "fib.ml.md",
              startLine: 2,
              startColumn: 8,
              endLine: 2,
              endColumn: 13,
              ghost: false,
              parentId: null,
              ownerScopeId: "scope-top",
            },
            {
              id: "unit-pattern-0",
              category: "pattern",
              semanticKind: "binder",
              generatedPath: "fib.ml.md",
              startLine: 2,
              startColumn: 4,
              endLine: 2,
              endColumn: 7,
              ghost: false,
              parentId: null,
              ownerScopeId: "scope-top",
            },
          ],
        },
      ],
      traces: [
        {
          sequence: 0,
          occurrenceId: "o1",
          siteId: "unit-expression-1",
        },
      ],
    },
  };
}

test("compiler contract capture is immutable and deterministically ordered", () => {
  const capture = buildCompilerContractCapture(payload());
  assert.equal(capture.valid, true);
  assert.deepEqual(
    capture.constructs.map((construct) => construct.id),
    ["unit-pattern-0", "unit-expression-1"],
  );
  assert.equal(capture.constructs[0].alias, "0");
  assert.equal(capture.constructs[1].alias, "1");
  assert.deepEqual(capture.reachedConstructIds, ["unit-expression-1"]);
  assert.equal(Object.isFrozen(capture), true);
  assert.equal(Object.isFrozen(capture.constructs), true);
  assert.equal(Object.isFrozen(capture.constructs[0]), true);
  assert.match(renderCompilerContractCapture(capture), /invariants ok/);
  assert.deepEqual(
    compilerContractCaptureToJson(capture).constructs.map(
      (construct) => construct.alias,
    ),
    ["0", "1"],
  );
});

test("unknown runtime sites fail the compiler/runtime seam", () => {
  const input = payload();
  input.evaluation.traces[0].siteId = "coordinate-derived-fallback";
  const capture = buildCompilerContractCapture(input);
  assert.equal(capture.valid, false);
  assert.deepEqual(
    capture.problems.map((item) => item.code),
    ["trace-site-unknown"],
  );
});

test("duplicate IDs and invalid construct records have stable problems", () => {
  const input = payload();
  input.evaluation.compilerManifests[0].constructs.push({
    ...input.evaluation.compilerManifests[0].constructs[0],
    category: "token",
    endColumn: 2,
  });
  const capture = buildCompilerContractCapture(input);
  assert.deepEqual(
    capture.problems.map((item) => item.code),
    [
      "construct-category-invalid",
      "construct-id-duplicate",
      "construct-range-invalid",
    ],
  );
});

test("compiler semantic kinds and selector roles are closed contracts", () => {
  const input = payload();
  delete input.evaluation.compilerManifests[0].constructs[0].semanticKind;
  input.evaluation.compilerManifests[0].selectors = [
    {
      id: "selector-invalid",
      role: "browser-guess",
      subjectId: "unit-expression-1",
      generatedPath: "fib.ml.md",
      startLine: 2,
      startColumn: 8,
      endLine: 2,
      endColumn: 9,
      priority: 0,
      tieBreakRank: 0,
    },
  ];
  const capture = buildCompilerContractCapture(input);
  assert.deepEqual(
    capture.problems.map((item) => item.code),
    ["construct-semantic-kind-invalid", "selector-role-invalid"],
  );
});

test("containment and execution-scope references are compiler-owned", () => {
  const input = payload();
  const [expression, pattern] =
    input.evaluation.compilerManifests[0].constructs;
  expression.parentId = pattern.id;
  pattern.parentId = expression.id;
  expression.ownerScopeId = "missing-scope";
  const capture = buildCompilerContractCapture(input);
  assert.deepEqual(
    capture.problems.map((item) => item.code),
    [
      "construct-lexical-scope-unknown",
      "construct-parent-cycle",
      "construct-parent-cycle",
      "construct-scope-unknown",
    ],
  );
});

function envelope() {
  const returned = (display, type = "int") => ({
    kind: "return",
    value: { type, display, fingerprint: display, complete: true },
    source: "runtime",
  });
  return sealExecutionEnvelope({
    schemaVersion: 1,
    evaluationId: "evaluation-1",
    requestCodeDigest: "request-code-1",
    projectDigest: "project-1",
    codeRevisionId: "code-1",
    compilerInputsDigest: "compiler-1",
    staticProgram: {
      codeRevisionId: "code-1",
      compilerInputsDigest: "compiler-1",
      compilationUnits: [
        {
          id: "unit-1",
          modulePath: "Fib",
          generatedPath: "fib.ml",
          byteLength: 32,
          sourceDigest: "source-1",
          topLevelScopeId: "scope-top",
        },
      ],
      executionScopes: [
        { id: "scope-top", kind: "top-level", unitId: "unit-1" },
        {
          id: "scope-fib",
          kind: "function",
          unitId: "unit-1",
          functionConstructId: "construct-fib",
          functionFingerprint: "fib-fingerprint",
        },
      ],
      constructs: [
        {
          id: "construct-fib",
          category: "expression",
          semanticKind: "function",
          compilerRange: {
            generatedPath: "fib.ml",
            startByte: 0,
            endByte: 20,
          },
          parentId: null,
          ownerScopeId: "scope-top",
          lexicalScopeId: "scope-top",
          syntaxFingerprint: "function",
          lexicalAncestryFingerprint: "function",
          ghost: false,
        },
        {
          id: "construct-call",
          category: "expression",
          semanticKind: "application",
          compilerRange: {
            generatedPath: "fib.ml",
            startByte: 21,
            endByte: 26,
          },
          parentId: null,
          ownerScopeId: "scope-top",
          lexicalScopeId: "scope-top",
          syntaxFingerprint: "call",
          lexicalAncestryFingerprint: "call",
          ghost: false,
        },
        {
          id: "construct-value",
          category: "expression",
          semanticKind: "identifier",
          compilerRange: {
            generatedPath: "fib.ml",
            startByte: 12,
            endByte: 13,
          },
          parentId: "construct-fib",
          ownerScopeId: "scope-fib",
          lexicalScopeId: "scope-fib",
          syntaxFingerprint: "value",
          lexicalAncestryFingerprint: "function/value",
          ghost: false,
        },
      ],
      selectors: [
        {
          id: "selector-call",
          compilerRange: {
            generatedPath: "fib.ml",
            startByte: 21,
            endByte: 24,
          },
          subjectId: "construct-call",
          role: "callee",
          priority: 10,
          tieBreakRank: 0,
          syntaxFingerprint: "fib",
        },
      ],
    },
    sourceMaps: {
      documentRevisionId: "document-1",
      codeRevisionId: "code-1",
      sourcesDigest: "sources-1",
      extractedCodeDigest: "code-1",
      entries: [
        {
          selectorId: "selector-call",
          generatedPath: "fib.ml",
          startByte: 21,
          endByte: 24,
          documentPath: "fib.ml.md",
          startUtf16: 4,
          endUtf16: 7,
        },
      ],
    },
    execution: {
      occurrences: [
        {
          id: "occurrence-call",
          constructId: "construct-call",
          activationId: "activation-top",
          parentOccurrenceId: null,
          kind: "call",
          enteredAt: 1,
          outcomeAt: 8,
          outcome: returned("5"),
        },
        {
          id: "occurrence-fib",
          constructId: "construct-fib",
          activationId: "activation-fib",
          parentOccurrenceId: null,
          kind: "function",
          enteredAt: 3,
          outcomeAt: 7,
          outcome: returned("5"),
        },
        {
          id: "occurrence-value",
          constructId: "construct-value",
          activationId: "activation-fib",
          parentOccurrenceId: "occurrence-fib",
          kind: "expression",
          enteredAt: 4,
          outcomeAt: 5,
          outcome: returned("3"),
        },
      ],
      activations: [
        {
          id: "activation-top",
          scopeId: "scope-top",
          functionOccurrenceId: null,
          functionConstructId: null,
          closureId: null,
          dynamicParentId: null,
          callsiteOccurrenceId: null,
          consumedCallAttemptId: null,
          occurrenceIds: ["occurrence-call"],
          parameterOccurrenceIds: [],
          enteredAt: 0,
          outcomeAt: 9,
          outcome: returned("()", "unit"),
          signature: {
            functionKey: "Fib::<top>",
            callsiteKey: null,
            parameterFingerprints: [],
            outcomeFingerprint: "()",
          },
        },
        {
          id: "activation-fib",
          scopeId: "scope-fib",
          functionOccurrenceId: "occurrence-fib",
          functionConstructId: "construct-fib",
          closureId: "closure-fib",
          dynamicParentId: "activation-top",
          callsiteOccurrenceId: "occurrence-call",
          consumedCallAttemptId: "attempt-call",
          occurrenceIds: ["occurrence-fib", "occurrence-value"],
          parameterOccurrenceIds: [],
          enteredAt: 3,
          outcomeAt: 7,
          outcome: returned("5"),
          signature: {
            functionKey: "Fib.fib",
            callsiteKey: "call",
            parameterFingerprints: ["5"],
            outcomeFingerprint: "5",
          },
        },
      ],
      closures: [
        {
          id: "closure-fib",
          functionConstructId: "construct-fib",
          createdAt: 0,
          originActivationId: "activation-top",
        },
      ],
      closureProvenance: [],
      callAttempts: [
        {
          id: "attempt-call",
          ownerActivationId: "activation-top",
          callOccurrenceId: "occurrence-call",
          tail: false,
          openedAt: 1,
          producerActivationIds: ["activation-fib"],
          outcomeAt: 8,
          outcome: returned("5"),
        },
      ],
      writes: [],
    },
    terminal: { kind: "complete", finalSequence: 9, checksum: "terminal-1" },
    artifactChecksum: "artifact-1",
  });
}

test("normalized artifacts publish complete immutable indexes atomically", () => {
  const built = buildExecutionSnapshot(envelope());
  assert.equal(built.ok, true);
  const snapshot = built.snapshot;
  assert.deepEqual(snapshot.counts, {
    constructs: 3,
    selectors: 1,
    occurrences: 3,
    activations: 2,
    closures: 1,
    callAttempts: 1,
    writes: 0,
    events: 0,
  });
  assert.equal(snapshotConstruct(snapshot, "construct-value").parentId, "construct-fib");
  assert.equal(snapshotOccurrence(snapshot, "occurrence-value").outcome.value.display, "3");
  assert.equal(snapshotActivation(snapshot, "activation-fib").scopeId, "scope-fib");
  assert.deepEqual(snapshotOccurrenceIdsForConstruct(snapshot, "construct-fib"), ["occurrence-fib"]);
  assert.deepEqual(
    snapshotOccurrenceIdsForActivationConstruct(
      snapshot,
      "activation-fib",
      "construct-value",
    ),
    ["occurrence-value"],
  );
  assert.deepEqual(snapshotActivationIdsForConstruct(snapshot, "construct-call"), ["activation-top"]);
  assert.deepEqual(snapshotActivationIdsForConstruct(snapshot, "construct-fib"), [
    "activation-fib",
  ]);
  assert.deepEqual(snapshotExecutedConstructIds(snapshot, "activation-top"), [
    "construct-call",
  ]);
  assert.deepEqual(snapshotExecutedConstructIds(snapshot, "activation-fib"), ["construct-fib", "construct-value"]);
  assert.deepEqual(snapshotChildActivationIds(snapshot, "activation-top"), ["activation-fib"]);
  assert.deepEqual(
    snapshotCallAttemptsForActivation(snapshot, "activation-top").map(
      (attempt) => attempt.id,
    ),
    ["attempt-call"],
  );
  assert.deepEqual(snapshotCallAttemptsForActivation(snapshot, "activation-fib"), []);
  assert.equal(Object.isFrozen(snapshotOccurrence(snapshot, "occurrence-value")), true);
});

test("invalid normalized artifacts never publish a partial snapshot", () => {
  const input = envelope();
  input.execution.activations[1].occurrenceIds = [];
  input.execution.occurrences[2].parentOccurrenceId = "occurrence-call";
  const built = buildExecutionSnapshot(input);
  assert.equal(built.ok, false);
  assert.equal(built.snapshot, null);
  assert.deepEqual(
    built.problems.map((item) => item.code),
    [
      "artifact-checksum-invalid",
      "occurrence-membership-invalid",
      "occurrence-membership-invalid",
      "occurrence-parent-cross-activation",
    ],
  );
});

test("malformed normalized table shapes return problems instead of throwing", () => {
  for (const mutate of [
    (input) => { input.execution.occurrences = {}; },
    (input) => { input.sourceMaps.entries = {}; },
    (input) => { input.sourceMaps.entries = [null]; },
    (input) => { input.sourceMaps.entries[0].documentPath = null; },
    (input) => { input.sourceMaps.entries = []; },
    (input) => { input.execution.closureProvenance = [null]; },
    (input) => { input.execution.activations[0].occurrenceIds = {}; },
    (input) => { input.execution.callAttempts[0].producerActivationIds = {}; },
  ]) {
    const input = structuredClone(envelope());
    mutate(input);
    const built = buildExecutionSnapshot(sealExecutionEnvelope(input));
    assert.equal(built.ok, false);
    assert.ok(built.problems.length > 0);
  }
});

test("normalized selectors and source maps form a strict ID bijection", () => {
  const cases = [
    {
      code: "selector-source-map-missing",
      mutate(input) { input.sourceMaps.entries = []; },
    },
    {
      code: "source-map-selector-unknown",
      mutate(input) { input.sourceMaps.entries[0].selectorId = "unknown"; },
    },
    {
      code: "source-map-selector-duplicate",
      mutate(input) {
        input.sourceMaps.entries.push(structuredClone(input.sourceMaps.entries[0]));
      },
    },
    {
      code: "source-map-selector-range-mismatch",
      mutate(input) { input.sourceMaps.entries[0].startByte -= 1; },
    },
  ];
  for (const { code, mutate } of cases) {
    const input = structuredClone(envelope());
    mutate(input);
    const built = buildExecutionSnapshot(sealExecutionEnvelope(input));
    assert.equal(built.ok, false, code);
    assert.equal(built.snapshot, null, code);
    assert.ok(built.problems.some((problem) => problem.code === code), code);
  }
});

test("a selector-less normalized program may have an empty source map", () => {
  const input = structuredClone(envelope());
  input.staticProgram.selectors = [];
  input.sourceMaps.entries = [];
  const built = buildExecutionSnapshot(sealExecutionEnvelope(input));
  assert.equal(built.ok, true, JSON.stringify(built.problems));
});

test("malformed normalized scalar contracts never publish", () => {
  const mutations = [
    (input) => { input.execution.occurrences[0].kind = "bogus"; },
    (input) => { input.execution.occurrences[0].outcome = { kind: "bogus" }; },
    (input) => { input.staticProgram.selectors[0].tieBreakRank = "bad"; },
    (input) => { input.execution.activations[0].enteredAt = "bad"; },
    (input) => { input.execution.callAttempts[0].openedAt = "bad"; },
  ];
  for (const mutate of mutations) {
    const input = structuredClone(envelope());
    mutate(input);
    const built = buildExecutionSnapshot(sealExecutionEnvelope(input));
    assert.equal(built.ok, false);
    assert.ok(built.problems.length > 0);
  }
  for (const sequence of ["bad", envelope().terminal.finalSequence + 100]) {
    const input = structuredClone(envelope());
    input.execution.writes.push({
      id: "write-1",
      activationId: "activation-top",
      constructId: "construct-call",
      sequence,
      operation: "set",
      targetId: null,
      oldValue: null,
      newValue: { type: "int", display: "1", fingerprint: "1", complete: true },
    });
    const built = buildExecutionSnapshot(sealExecutionEnvelope(input));
    assert.equal(built.ok, false);
    assert.ok(built.problems.some((problem) => problem.code === "write-sequence-invalid"));
  }
  const missingWriteValue = structuredClone(envelope());
  missingWriteValue.execution.writes.push({
    id: "write-without-value",
    activationId: "activation-top",
    constructId: "construct-call",
    sequence: 1,
    operation: "set",
    targetId: null,
    oldValue: null,
    newValue: null,
  });
  assert.ok(
    buildExecutionSnapshot(sealExecutionEnvelope(missingWriteValue)).problems.some(
      (problem) => problem.code === "write-value-invalid",
    ),
  );
  for (const oldValue of [undefined, 7, {}, []]) {
    const malformedOldWriteValue = structuredClone(envelope());
    malformedOldWriteValue.execution.writes.push({
      id: "write-with-malformed-old-value",
      activationId: "activation-top",
      constructId: "construct-call",
      sequence: 1,
      operation: "set",
      targetId: null,
      ...(oldValue === undefined ? {} : { oldValue }),
      newValue: { type: "int", display: "1", fingerprint: "1", complete: true },
    });
    assert.ok(
      buildExecutionSnapshot(sealExecutionEnvelope(malformedOldWriteValue)).problems.some(
        (problem) => problem.code === "write-old-value-invalid",
      ),
    );
  }

  const fingerprintedIncompleteValue = structuredClone(envelope());
  fingerprintedIncompleteValue.execution.occurrences[0].outcome = {
    kind: "incomplete",
    value: {
      type: "int",
      display: "1",
      fingerprint: "must-be-null-when-incomplete",
      complete: false,
    },
    source: "runtime",
  };
  fingerprintedIncompleteValue.execution.occurrences[0].outcomeAt = null;
  fingerprintedIncompleteValue.terminal.kind = "truncated";
  assert.ok(
    buildExecutionSnapshot(sealExecutionEnvelope(fingerprintedIncompleteValue)).problems.some(
      (problem) => problem.code === "occurrence-outcome-invalid",
    ),
  );

  const completedOutcomeWithoutTime = structuredClone(envelope());
  completedOutcomeWithoutTime.execution.occurrences[0].outcomeAt = null;
  completedOutcomeWithoutTime.terminal.kind = "truncated";
  assert.ok(
    buildExecutionSnapshot(sealExecutionEnvelope(completedOutcomeWithoutTime)).problems.some(
      (problem) => problem.code === "occurrence-outcome-time-mismatch",
    ),
  );
});

test("non-function occurrences cannot cross compiler execution scopes", () => {
  const input = structuredClone(envelope());
  input.staticProgram.constructs.find(
    (construct) => construct.id === "construct-value",
  ).ownerScopeId = "scope-top";
  const built = buildExecutionSnapshot(sealExecutionEnvelope(input));
  assert.equal(built.ok, false);
  assert.deepEqual(
    built.problems.map((item) => item.code),
    ["occurrence-execution-scope-mismatch"],
  );
});

test("a synthetic function-case parameter may use the enclosing function construct", () => {
  const input = structuredClone(envelope());
  const activation = input.execution.activations.find(
    (item) => item.id === "activation-fib",
  );
  input.execution.occurrences.push({
    id: "occurrence-implicit-parameter",
    constructId: "construct-fib",
    activationId: activation.id,
    parentOccurrenceId: activation.functionOccurrenceId,
    kind: "parameter",
    enteredAt: 4,
    outcomeAt: 4,
    outcome: {
      kind: "return",
      value: { type: "int", display: "3", fingerprint: "3", complete: true },
      source: "runtime",
    },
  });
  activation.occurrenceIds.push("occurrence-implicit-parameter");
  activation.parameterOccurrenceIds.push("occurrence-implicit-parameter");
  const built = buildExecutionSnapshot(sealExecutionEnvelope(input));
  assert.equal(built.ok, true, JSON.stringify(built.problems));
  assert.equal(
    snapshotOccurrenceIdsForActivationConstruct(
      built.snapshot,
      activation.id,
      "construct-fib",
    ).includes("occurrence-implicit-parameter"),
    false,
  );
  assert.equal(
    snapshotActivation(built.snapshot, activation.id).parameterOccurrenceIds.includes(
      "occurrence-implicit-parameter",
    ),
    true,
  );
});

test("the synthetic function-case parameter scope exception is relational", () => {
  const input = structuredClone(envelope());
  const activation = input.execution.activations.find(
    (item) => item.id === "activation-fib",
  );
  input.execution.occurrences.push({
    id: "occurrence-invalid-parameter",
    constructId: "construct-fib",
    activationId: activation.id,
    parentOccurrenceId: null,
    kind: "parameter",
    enteredAt: 4,
    outcomeAt: 4,
    outcome: {
      kind: "return",
      value: { type: "int", display: "3", fingerprint: "3", complete: true },
      source: "runtime",
    },
  });
  activation.occurrenceIds.push("occurrence-invalid-parameter");
  activation.parameterOccurrenceIds.push("occurrence-invalid-parameter");
  const built = buildExecutionSnapshot(sealExecutionEnvelope(input));
  assert.deepEqual(
    built.problems.map((item) => item.code),
    ["activation-parameter-invalid", "occurrence-execution-scope-mismatch"],
  );
});

test("a designated function occurrence must reference its activation function", () => {
  const input = structuredClone(envelope());
  input.execution.occurrences.find(
    (occurrence) => occurrence.id === "occurrence-fib",
  ).constructId = "construct-value";
  const built = buildExecutionSnapshot(sealExecutionEnvelope(input));
  assert.deepEqual(
    built.problems.map((item) => item.code),
    ["activation-function-occurrence-invalid"],
  );
});

test("normalized semantic kinds, selector roles, and parameter membership are validated", () => {
  const input = structuredClone(envelope());
  input.staticProgram.constructs[0].semanticKind = "browser-guess";
  input.staticProgram.selectors[0].role = "browser-guess";
  const activation = input.execution.activations[1];
  input.execution.occurrences.push({
    id: "occurrence-unlisted-parameter",
    constructId: "construct-fib",
    activationId: activation.id,
    parentOccurrenceId: activation.functionOccurrenceId,
    kind: "parameter",
    enteredAt: 4,
    outcomeAt: 4,
    outcome: {
      kind: "return",
      value: { type: "int", display: "3", fingerprint: "3", complete: true },
      source: "runtime",
    },
  });
  activation.occurrenceIds.push("occurrence-unlisted-parameter");
  const built = buildExecutionSnapshot(sealExecutionEnvelope(input));
  assert.deepEqual(
    built.problems.map((item) => item.code),
    [
      "construct-semantic-kind-invalid",
      "occurrence-execution-scope-mismatch",
      "occurrence-parameter-unlisted",
      "selector-role-invalid",
    ],
  );
});

test("terminal and artifact checksums cover the normalized envelope", () => {
  const artifactTampered = envelope();
  artifactTampered.execution.occurrences[0].outcome.value.display = "999";
  assert.deepEqual(
    buildExecutionSnapshot(artifactTampered).problems.map((item) => item.code),
    ["artifact-checksum-invalid"],
  );

  const terminalTampered = envelope();
  terminalTampered.terminal.finalSequence += 1;
  assert.deepEqual(
    buildExecutionSnapshot(terminalTampered).problems.map((item) => item.code),
    ["artifact-checksum-invalid", "terminal-checksum-invalid"],
  );
});

test("artifact identity and source-map digests are required after resealing", () => {
  for (const field of [
    "requestCodeDigest",
    "projectDigest",
    "codeRevisionId",
    "compilerInputsDigest",
  ]) {
    const input = structuredClone(envelope());
    delete input[field];
    const built = buildExecutionSnapshot(sealExecutionEnvelope(input));
    assert.equal(
      built.problems.some(
        (problem) =>
          problem.code === "envelope-field-missing" && problem.entityId === field,
      ),
      true,
      field,
    );
  }
  for (const field of [
    "documentRevisionId",
    "codeRevisionId",
    "sourcesDigest",
    "extractedCodeDigest",
  ]) {
    const input = structuredClone(envelope());
    delete input.sourceMaps[field];
    const built = buildExecutionSnapshot(sealExecutionEnvelope(input));
    assert.equal(
      built.problems.some(
        (problem) =>
          problem.code === "source-map-field-missing" &&
          problem.entityId === field,
      ),
      true,
      field,
    );
  }
  const input = structuredClone(envelope());
  delete input.staticProgram.compilationUnits[0].sourceDigest;
  assert.equal(
    buildExecutionSnapshot(sealExecutionEnvelope(input)).problems.some(
      (problem) => problem.code === "unit-source-invalid",
    ),
    true,
  );
});

test("derived closure provenance names an existing source closure", () => {
  const input = structuredClone(envelope());
  input.execution.closures.push({
    id: "closure-derived",
    functionConstructId: "construct-fib",
    createdAt: 2,
    originActivationId: "activation-top",
  });
  input.execution.closureProvenance.push({
    closureId: "closure-derived",
    kind: "derived",
    activationId: null,
    callsiteOccurrenceId: null,
    sourceClosureId: "closure-fib",
    sequence: 2,
  });
  assert.equal(buildExecutionSnapshot(sealExecutionEnvelope(input)).ok, true);

  input.execution.closureProvenance[0].sourceClosureId = "missing";
  assert.equal(
    buildExecutionSnapshot(sealExecutionEnvelope(input)).problems.some(
      (problem) => problem.code === "closure-provenance-source-invalid",
    ),
    true,
  );
});

test("a produced activation is dynamically owned by its callsite activation", () => {
  const value = envelope();
  value.execution.activations[1].dynamicParentId = null;
  const built = buildExecutionSnapshot(sealExecutionEnvelope(value));
  assert.equal(built.ok, false);
  assert.equal(
    built.problems.some(
      (problem) => problem.code === "activation-callsite-parent-mismatch",
    ),
    true,
  );
});

test("activation closures and writes must match the activation function and scope", () => {
  const input = structuredClone(envelope());
  input.execution.closures[0].functionConstructId = "construct-value";
  input.execution.writes.push({
    id: "write-cross-scope",
    activationId: "activation-top",
    constructId: "construct-value",
    sequence: 5,
    operation: "set",
    targetId: null,
    oldValue: null,
    newValue: {
      type: "int",
      display: "3",
      fingerprint: "3",
      complete: true,
    },
  });
  const built = buildExecutionSnapshot(sealExecutionEnvelope(input));
  assert.deepEqual(
    built.problems.map((item) => item.code),
    ["activation-closure-function-mismatch", "write-owner-invalid"],
  );
});
