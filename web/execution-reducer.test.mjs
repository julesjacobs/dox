import assert from "node:assert/strict";
import test from "node:test";
import {
  buildExecutionSnapshot,
  sealExecutionEnvelope,
} from "./execution-artifact.js";
import { resolveCursor } from "./execution-query.js";
import {
  createExecutionState,
  executionDocumentRevisionId,
  executionStateSources,
  transition,
} from "./execution-reducer.js";
import { reconcileSelection } from "./execution-reconcile.js";
import { buildExecutionViewFromArtifact } from "./execution-view.js";
import {
  buildExecutionViewModel,
  chooseAnnotationSlot,
  composeCoverageIntervals,
  executionViewModelCacheStats,
} from "./execution-view-model.js";

const source = "Intro\n\n    let x = 1\n";

const outcome = (display) => ({
  kind: "return",
  value: { type: "int", display, fingerprint: display, complete: true },
  source: "runtime",
});

test("coverage composition gives each source interval one semantic state", () => {
  assert.deepEqual(
    composeCoverageIntervals([
      { constructId: "parent", state: "active", range: { path: "x", start: 0, end: 10 } },
      { constructId: "branch", state: "inactive", range: { path: "x", start: 4, end: 8 } },
      { constructId: "alias", state: "globally-unreached", range: { path: "x", start: 0, end: 10 } },
    ]),
    [
      { constructId: "parent", state: "active", range: { path: "x", start: 0, end: 4 } },
      { constructId: "branch", state: "inactive", range: { path: "x", start: 4, end: 8 } },
      { constructId: "parent", state: "active", range: { path: "x", start: 8, end: 10 } },
    ],
  );
});

test("coverage composition is disjoint and invariant under input order", () => {
  const input = [
    { constructId: "outer", state: "active", range: { path: "x", start: 0, end: 20 } },
    { constructId: "left", state: "inactive", range: { path: "x", start: 2, end: 8 } },
    { constructId: "right", state: "globally-unreached", range: { path: "x", start: 8, end: 18 } },
    { constructId: "same", state: "active", range: { path: "x", start: 8, end: 18 } },
  ];
  const expected = composeCoverageIntervals(input);
  assert.deepEqual(composeCoverageIntervals([...input].reverse()), expected);
  expected.slice(1).forEach((item, index) => {
    assert.ok(expected[index].range.end <= item.range.start);
  });
  assert.equal(expected[0].range.start, 0);
  assert.equal(expected.at(-1).range.end, 20);
});

test("annotation precedence is stable and cursor override restores persistent state", () => {
  const value = (text) => ({
    text,
    fullText: text,
    kind: "return",
    truncated: false,
    segments: [{ from: 0, to: text.length, role: "neutral" }],
  });
  const outer = { kind: "binding", boundaryId: "outer", depth: 1, value: value("outer") };
  const inner = { kind: "match", boundaryId: "inner", depth: 2, value: value("inner") };
  const oneLine = { kind: "one-line-function", boundaryId: "fn", depth: -1, value: value("fn") };
  assert.equal(chooseAnnotationSlot(4, [inner, outer]).persistent, outer);
  assert.equal(chooseAnnotationSlot(4, [outer, oneLine]).persistent, oneLine);
  const cursorAnnotation = {
    kind: "cursor",
    boundaryId: "cursor",
    depth: -2,
    value: value("cursor"),
  };
  assert.equal(
    chooseAnnotationSlot(4, [inner, outer, cursorAnnotation]).effective,
    cursorAnnotation,
  );
  assert.equal(chooseAnnotationSlot(4, [inner, outer]).effective, outer);
});

test("a matched arm keeps both its input and function result", () => {
  const value = (text) => ({
    text,
    fullText: text,
    kind: "return",
    truncated: false,
    segments: [{ from: 0, to: text.length, role: "neutral" }],
  });
  const match = {
    kind: "match",
    boundaryId: "match",
    occurrenceId: "scrutinee",
    depth: 2,
    value: value("≈ Some 3"),
  };
  const exit = {
    kind: "function-exit",
    boundaryId: "activation",
    occurrenceId: "result",
    depth: 0,
    value: value("↩ 4"),
  };
  const slot = chooseAnnotationSlot(4, [match, exit]);
  assert.equal(slot.persistent.kind, "match-and-exit");
  assert.equal(slot.persistent.occurrenceId, "scrutinee");
  assert.equal(slot.persistent.value.fullText, "≈ Some 3   ↩ 4");
});

function envelope({
  prefix = "old",
  requestCodeDigest = "request-old",
  projectDigest = "project",
  codeRevisionId = "code-old",
  documentRevisionId = executionDocumentRevisionId({ "sample.ml.md": source }),
  display = "1",
  startUtf16 = 11,
} = {}) {
  const constructId = `${prefix}-construct`;
  const selectorId = `${prefix}-selector`;
  const activationId = `${prefix}-activation`;
  const occurrenceId = `${prefix}-occurrence`;
  return sealExecutionEnvelope({
    schemaVersion: 1,
    evaluationId: `${prefix}-evaluation`,
    requestCodeDigest,
    projectDigest,
    codeRevisionId,
    compilerInputsDigest: "compiler",
    staticProgram: {
      codeRevisionId,
      compilerInputsDigest: "compiler",
      compilationUnits: [
        {
          id: `${prefix}-unit`,
          modulePath: "Sample",
          generatedPath: "sample.ml",
          byteLength: 9,
          sourceDigest: "source",
          topLevelScopeId: `${prefix}-scope`,
        },
      ],
      executionScopes: [
        {
          id: `${prefix}-scope`,
          kind: "top-level",
          unitId: `${prefix}-unit`,
        },
      ],
      constructs: [
        {
          id: constructId,
          category: "expression",
          semanticKind: "binding",
          compilerRange: {
            generatedPath: "sample.ml",
            startByte: 0,
            endByte: 9,
          },
          parentId: null,
          ownerScopeId: `${prefix}-scope`,
          lexicalScopeId: `${prefix}-scope`,
          syntaxFingerprint: "let-x",
          lexicalAncestryFingerprint: "top/let-x",
          ghost: false,
        },
      ],
      selectors: [
        {
          id: selectorId,
          compilerRange: {
            generatedPath: "sample.ml",
            startByte: 0,
            endByte: 9,
          },
          subjectId: constructId,
          role: "construct",
          priority: 0,
          tieBreakRank: 0,
          syntaxFingerprint: "let-x-selector",
        },
      ],
    },
    sourceMaps: {
      documentRevisionId,
      codeRevisionId,
      sourcesDigest: documentRevisionId,
      extractedCodeDigest: codeRevisionId,
      entries: [
        {
          selectorId,
          generatedPath: "sample.ml",
          startByte: 0,
          endByte: 9,
          documentPath: "sample.ml.md",
          startUtf16,
          endUtf16: startUtf16 + 9,
        },
      ],
    },
    execution: {
      occurrences: [
        {
          id: occurrenceId,
          constructId,
          activationId,
          parentOccurrenceId: null,
          kind: "expression",
          enteredAt: 1,
          outcomeAt: 2,
          outcome: outcome(display),
        },
      ],
      activations: [
        {
          id: activationId,
          scopeId: `${prefix}-scope`,
          functionOccurrenceId: null,
          functionConstructId: null,
          closureId: null,
          dynamicParentId: null,
          callsiteOccurrenceId: null,
          consumedCallAttemptId: null,
          occurrenceIds: [occurrenceId],
          parameterOccurrenceIds: [],
          enteredAt: 0,
          outcomeAt: 3,
          outcome: outcome("()"),
          signature: {
            functionKey: "Sample",
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
    terminal: { kind: "complete", finalSequence: 3, checksum: "terminal" },
    artifactChecksum: "artifact",
  });
}

function callEnvelope() {
  const artifact = structuredClone(envelope());
  const prefix = "old";
  const parentConstructId = `${prefix}-construct`;
  const parentActivationId = `${prefix}-activation`;
  const callOccurrenceId = `${prefix}-occurrence`;
  const functionConstructId = `${prefix}-function-construct`;
  const functionScopeId = `${prefix}-function-scope`;
  const functionOccurrenceId = `${prefix}-function-occurrence`;
  const childActivationId = `${prefix}-child-activation`;
  const attemptId = `${prefix}-call-attempt`;
  artifact.staticProgram.executionScopes.push({
    id: functionScopeId,
    kind: "function",
    unitId: `${prefix}-unit`,
    functionConstructId,
    functionFingerprint: "function-fingerprint",
  });
  artifact.staticProgram.constructs.push({
    id: functionConstructId,
    category: "expression",
    semanticKind: "function",
    compilerRange: {
      generatedPath: "sample.ml",
      startByte: 0,
      endByte: 3,
    },
    parentId: null,
    ownerScopeId: `${prefix}-scope`,
    lexicalScopeId: `${prefix}-scope`,
    syntaxFingerprint: "function",
    lexicalAncestryFingerprint: "top/function",
    ghost: false,
  });
  artifact.staticProgram.selectors.push(
    {
      id: `${prefix}-callee-selector`,
      compilerRange: {
        generatedPath: "sample.ml",
        startByte: 0,
        endByte: 3,
      },
      subjectId: parentConstructId,
      role: "callee",
      priority: 10,
      tieBreakRank: 1,
      syntaxFingerprint: "callee-selector",
    },
    {
      id: `${prefix}-function-selector`,
      compilerRange: {
        generatedPath: "sample.ml",
        startByte: 0,
        endByte: 3,
      },
      subjectId: functionConstructId,
      role: "binder",
      priority: 20,
      tieBreakRank: 2,
      syntaxFingerprint: "function-selector",
    },
  );
  for (const addedSelectorId of [
    `${prefix}-callee-selector`,
    `${prefix}-function-selector`,
  ]) {
    artifact.sourceMaps.entries.push({
      selectorId: addedSelectorId,
      generatedPath: "sample.ml",
      startByte: 0,
      endByte: 3,
      documentPath: "sample.ml.md",
      startUtf16: 11,
      endUtf16: 14,
    });
  }
  artifact.sourceMaps.entries.sort(
    (left, right) =>
      left.generatedPath.localeCompare(right.generatedPath) ||
      left.startByte - right.startByte ||
      left.endByte - right.endByte,
  );
  artifact.execution.occurrences[0] = {
    ...artifact.execution.occurrences[0],
    kind: "call",
    outcomeAt: 5,
    outcome: outcome("2"),
  };
  artifact.execution.occurrences.push({
    id: functionOccurrenceId,
    constructId: functionConstructId,
    activationId: childActivationId,
    parentOccurrenceId: null,
    kind: "function",
    enteredAt: 2,
    outcomeAt: 4,
    outcome: outcome("2"),
  });
  artifact.execution.activations[0] = {
    ...artifact.execution.activations[0],
    outcomeAt: 6,
  };
  artifact.execution.activations.push({
    id: childActivationId,
    scopeId: functionScopeId,
    functionOccurrenceId,
    functionConstructId,
    closureId: null,
    dynamicParentId: parentActivationId,
    callsiteOccurrenceId: callOccurrenceId,
    consumedCallAttemptId: attemptId,
    occurrenceIds: [functionOccurrenceId],
    parameterOccurrenceIds: [],
    enteredAt: 2,
    outcomeAt: 4,
    outcome: outcome("2"),
    signature: {
      functionKey: "function-fingerprint",
      callsiteKey: "let-x",
      parameterFingerprints: [],
      outcomeFingerprint: "2",
    },
  });
  artifact.execution.callAttempts.push({
    id: attemptId,
    ownerActivationId: parentActivationId,
    callOccurrenceId,
    tail: false,
    openedAt: 1,
    producerActivationIds: [childActivationId],
    outcomeAt: 5,
    outcome: outcome("2"),
  });
  artifact.terminal.finalSequence = 6;
  return sealExecutionEnvelope(artifact);
}

function initialState(artifact = envelope()) {
  const built = buildExecutionSnapshot(artifact);
  assert.equal(built.ok, true, JSON.stringify(built.problems));
  const view = buildExecutionViewFromArtifact({
    snapshot: built.snapshot,
    envelope: artifact,
    sources: { "sample.ml.md": source },
  });
  return createExecutionState({
    view,
    projectDigest: "project",
    compilerInputsDigest: "compiler",
  });
}

function viewFor(artifact, text = source) {
  const built = buildExecutionSnapshot(artifact);
  assert.equal(built.ok, true, JSON.stringify(built.problems));
  return buildExecutionViewFromArtifact({
    snapshot: built.snapshot,
    envelope: artifact,
    sources: { "sample.ml.md": text },
  });
}

function withRepeatedOccurrences(artifact, displays) {
  const next = structuredClone(artifact);
  const activation = next.execution.activations[0];
  const constructId = next.staticProgram.constructs[0].id;
  const occurrences = displays.map((display, index) => ({
    id: `${activation.id}-occurrence-${index}`,
    constructId,
    activationId: activation.id,
    parentOccurrenceId: null,
    kind: "expression",
    enteredAt: index * 2 + 1,
    outcomeAt: index * 2 + 2,
    outcome: outcome(display),
  }));
  next.execution.occurrences = occurrences;
  activation.occurrenceIds = occurrences.map((occurrence) => occurrence.id);
  activation.outcomeAt = displays.length * 2 + 3;
  next.terminal.finalSequence = activation.outcomeAt;
  return sealExecutionEnvelope(next);
}

function withUnreachedConstruct(artifact) {
  const next = structuredClone(artifact);
  const prefix = next.staticProgram.constructs[0].id.split("-construct")[0];
  next.staticProgram.constructs.push({
    id: `${prefix}-unreached`,
    category: "expression",
    semanticKind: "literal",
    compilerRange: { generatedPath: "sample.ml", startByte: 1, endByte: 2 },
    parentId: null,
    ownerScopeId: `${prefix}-scope`,
    lexicalScopeId: `${prefix}-scope`,
    syntaxFingerprint: "unreached",
    lexicalAncestryFingerprint: "top/unreached",
    ghost: false,
  });
  next.staticProgram.selectors.push({
    id: `${prefix}-unreached-selector`,
    compilerRange: { generatedPath: "sample.ml", startByte: 1, endByte: 2 },
    subjectId: `${prefix}-unreached`,
    role: "construct",
    priority: 0,
    tieBreakRank: 0,
    syntaxFingerprint: "unreached-selector",
  });
  next.sourceMaps.entries.push({
    selectorId: `${prefix}-unreached-selector`,
    generatedPath: "sample.ml",
    startByte: 1,
    endByte: 2,
    documentPath: "sample.ml.md",
    startUtf16: 1,
    endUtf16: 2,
  });
  next.sourceMaps.entries.sort(
    (left, right) =>
      left.generatedPath.localeCompare(right.generatedPath) ||
      left.startByte - right.startByte ||
      left.endByte - right.endByte,
  );
  return sealExecutionEnvelope(next);
}

function withReachedAndUnreachedReconciliationCandidates(artifact) {
  const next = structuredClone(artifact);
  const reached = next.staticProgram.constructs[0];
  const reachedSelector = next.staticProgram.selectors[0];
  const reachedOccurrence = next.execution.occurrences[0];
  reached.id = "new-z-construct";
  reachedSelector.id = "new-z-selector";
  reachedSelector.subjectId = reached.id;
  reachedOccurrence.constructId = reached.id;
  next.sourceMaps.entries[0].selectorId = reachedSelector.id;
  const unreached = {
    ...structuredClone(reached),
    id: "new-a-construct",
    compilerRange: {
      ...reached.compilerRange,
      startByte: reached.compilerRange.startByte + 1,
      endByte: reached.compilerRange.endByte - 1,
    },
  };
  next.staticProgram.constructs.push(unreached);
  next.staticProgram.selectors.push({
    ...structuredClone(reachedSelector),
    id: "new-a-selector",
    subjectId: unreached.id,
    compilerRange: { ...unreached.compilerRange },
  });
  next.sourceMaps.entries.push({
    ...structuredClone(next.sourceMaps.entries[0]),
    selectorId: "new-a-selector",
    startByte: unreached.compilerRange.startByte,
    endByte: unreached.compilerRange.endByte,
    startUtf16: next.sourceMaps.entries[0].startUtf16 + 1,
    endUtf16: next.sourceMaps.entries[0].endUtf16 - 1,
  });
  return sealExecutionEnvelope(next);
}

function withHiddenUnreachedConstruct(artifact) {
  const next = structuredClone(artifact);
  const visible = next.staticProgram.constructs[0];
  const prefix = visible.id.split("-construct")[0];
  const constructId = `${prefix}-hidden-pattern`;
  next.staticProgram.constructs.push({
    ...visible,
    id: constructId,
    category: "pattern",
    semanticKind: "binder",
    syntaxFingerprint: "hidden-pattern",
  });
  next.staticProgram.selectors.push({
    ...next.staticProgram.selectors[0],
    id: `${prefix}-hidden-pattern-selector`,
    subjectId: constructId,
    role: "binder",
    tieBreakRank: 1,
    syntaxFingerprint: "hidden-pattern-selector",
  });
  next.sourceMaps.entries.push({
    ...structuredClone(next.sourceMaps.entries[0]),
    selectorId: `${prefix}-hidden-pattern-selector`,
  });
  next.sourceMaps.entries.sort((left, right) =>
    left.generatedPath.localeCompare(right.generatedPath) ||
    left.startByte - right.startByte ||
    left.endByte - right.endByte ||
    left.documentPath.localeCompare(right.documentPath) ||
    left.selectorId.localeCompare(right.selectorId));
  return sealExecutionEnvelope(next);
}

function withTruncatedTrace(artifact) {
  const next = structuredClone(artifact);
  next.terminal = {
    kind: "truncated",
    finalSequence: next.terminal.finalSequence,
    reason: "size-limit",
  };
  return sealExecutionEnvelope(next);
}

function withWrite(artifact) {
  const next = structuredClone(artifact);
  const construct = next.staticProgram.constructs[0];
  const activation = next.execution.activations[0];
  construct.semanticKind = "mutation";
  next.execution.writes.push({
    id: "write-2",
    constructId: construct.id,
    activationId: activation.id,
    sequence: 2,
    operation: "ref",
    targetId: null,
    oldValue: null,
    newValue: {
      type: "int",
      display: "2",
      fingerprint: "2",
      complete: true,
    },
  });
  return sealExecutionEnvelope(next);
}

function withBoundaryOccurrence(artifact) {
  const next = structuredClone(artifact);
  next.execution.occurrences[0].kind = "boundary";
  return sealExecutionEnvelope(next);
}

function withIncompleteOccurrence(artifact) {
  const next = structuredClone(artifact);
  next.execution.occurrences[0].outcomeAt = null;
  next.execution.occurrences[0].outcome = {
    kind: "incomplete",
    source: "runtime",
  };
  next.terminal = {
    kind: "truncated",
    finalSequence: next.terminal.finalSequence,
    reason: "size-limit",
  };
  return sealExecutionEnvelope(next);
}

function readonlyRecency(entries = []) {
  const activations = new Map(entries);
  return {
    clock: Math.max(0, ...entries.map(([, clock]) => clock)),
    viewedAtByActivationId: activations,
    viewedAtByReconciliationKey: new Map(),
  };
}

const cursor = { path: "sample.ml.md", line: 3, column: 5 };

test("cursor movement is the sole owner of execution selection", () => {
  let state = initialState();
  state = transition(state, { kind: "cursor-moved", position: cursor }).state;
  assert.equal(state.selection.activationId, "old-activation");
  assert.equal(state.recency.clock, 1);
});

test("global non-execution remains visible when the activation set is empty", () => {
  let state = initialState(withUnreachedConstruct(envelope()));
  state = transition(state, {
    kind: "cursor-moved",
    position: { path: "sample.ml.md", line: 1, column: 1 },
  }).state;
  const model = buildExecutionViewModel(state);
  assert.equal(model.selection.activationId, null);
  assert.equal(model.projection, null);
  assert.deepEqual(
    model.coverage.map((item) => item.state),
    ["globally-unreached"],
  );
});

test("hidden unreachable AST nodes cannot fade a reached visible surface", () => {
  let state = initialState(withHiddenUnreachedConstruct(envelope()));
  state = transition(state, { kind: "cursor-moved", position: cursor }).state;
  const model = buildExecutionViewModel(state);
  assert.equal(model.selection.activationId, "old-activation");
  assert.equal(
    model.coverage.some((item) => item.state === "globally-unreached"),
    false,
  );
});

test("a truncated trace leaves missing execution unknown and unfaded", () => {
  const artifact = withTruncatedTrace(withUnreachedConstruct(envelope()));
  let state = initialState(artifact);
  const position = { path: "sample.ml.md", line: 1, column: 1 };
  assert.equal(resolveCursor(state.view, position).status, "unknown");
  state = transition(state, { kind: "cursor-moved", position }).state;
  const model = buildExecutionViewModel(state);
  assert.equal(model.selection.activationId, null);
  assert.equal(model.occurrenceList.emptyReason, "trace-incomplete");
  assert.deepEqual(model.coverage, []);
});

test("mutation inspection presents the written value instead of unit", () => {
  let state = initialState(withWrite(envelope()));
  state = transition(state, { kind: "cursor-moved", position: cursor }).state;
  const model = buildExecutionViewModel(state);
  assert.equal(model.cursorInspection.value.outcome.text, "2");
  assert.equal(model.occurrenceList.rows[0].value.text, "2");
  assert.equal(model.projection.annotationPlan[0].effective.value.text, "2");
});

test("structural boundaries select activations without presenting internal unit values", () => {
  let state = initialState(withBoundaryOccurrence(envelope()));
  state = transition(state, { kind: "cursor-moved", position: cursor }).state;
  const model = buildExecutionViewModel(state);
  assert.equal(model.selection.activationId, "old-activation");
  assert.equal(model.cursorInspection.value, null);
  assert.equal(model.occurrenceList.rows.length, 1);
  assert.equal(model.occurrenceList.rows[0].value, null);
  assert.equal(model.occurrenceList.rows[0].outcome.text, "()");
  assert.equal(
    model.projection.annotationPlan.some((slot) => slot.cursor),
    false,
  );
});

test("incomplete occurrences show reach without presenting ellipsis as a value", () => {
  let state = initialState(withIncompleteOccurrence(envelope()));
  state = transition(state, { kind: "cursor-moved", position: cursor }).state;
  const model = buildExecutionViewModel(state);
  assert.equal(model.selection.activationId, "old-activation");
  assert.equal(model.cursorInspection.value, null);
  assert.equal(model.occurrenceList.rows[0].value, null);
  assert.equal(model.occurrenceList.rows[0].valueStatus, "trace-incomplete");
  assert.equal(
    model.projection.annotationPlan.some((slot) => slot.cursor),
    false,
  );
});

test("the pure view model contains all execution presentation data", () => {
  let state = initialState();
  state = transition(state, { kind: "cursor-moved", position: cursor }).state;
  const model = buildExecutionViewModel(state);
  assert.equal(model.authority, "exact");
  assert.equal(model.occurrenceList.rows.length, 1);
  assert.equal(model.occurrenceList.rows[0].value.text, "1");
  assert.equal(model.cursorInspection.value.outcome.text, "1");
  assert.equal(model.projection.coverage[0].state, "active");
  assert.equal(model.occurrenceList.selectedOccurrenceId, "old-occurrence");
  assert.ok(model.projection.annotationPlan.length <= source.split("\n").length);
  assert.equal(Object.isFrozen(model), true);
});

test("warm cursor presentation does not rescan the full trace", () => {
  let state = initialState(callEnvelope());
  state = transition(state, { kind: "cursor-moved", position: cursor }).state;
  const first = buildExecutionViewModel(state);
  assert.equal(buildExecutionViewModel(state), first);
  const warmed = executionViewModelCacheStats(state);
  assert.ok(warmed.coverageCompositions > 0);
  assert.ok(warmed.persistentAnnotationBuilds > 0);
  assert.ok(warmed.activationLinkBuilds > 0);
  assert.ok(warmed.occurrencePresentationBuilds > 0);
  buildExecutionViewModel(state);
  state = transition(state, {
    kind: "cursor-moved",
    position: cursor,
  }).state;
  buildExecutionViewModel(state);
  assert.deepEqual(executionViewModelCacheStats(state), warmed);
});

test("call and caller links navigate through the reducer's activation path", () => {
  let state = initialState(callEnvelope());
  state = transition(state, {
    kind: "cursor-moved",
    position: { ...cursor, column: 8 },
  }).state;
  let model = buildExecutionViewModel(state);
  const childLink = model.projection.links.find((link) => link.kind === "child");
  assert.equal(childLink.activationId, "old-child-activation");
  let navigated = transition(state, {
    kind: "activation-navigated",
    activationId: childLink.activationId,
  });
  assert.equal(navigated.decision, "occurrence-selected");
  assert.equal(navigated.effects[0].kind, "move-editor-cursor");
  assert.equal(navigated.state.selection.selectorId, "old-function-selector");
  assert.deepEqual(navigated.effects[0].range, {
    path: "sample.ml.md",
    start: 11,
    end: 14,
  });
  assert.deepEqual(navigated.effects[0].position, {
    path: "sample.ml.md",
    line: 3,
    column: 4,
  });
  state = navigated.state;
  model = buildExecutionViewModel(state);
  const parentLink = model.projection.links.find((link) => link.kind === "parent");
  assert.equal(parentLink.activationId, "old-activation");
  navigated = transition(state, {
    kind: "occurrence-chosen",
    occurrenceId: parentLink.occurrenceId,
  });
  assert.equal(navigated.state.selection.activationId, "old-activation");
});

test("prose edits remap exact selectors without scheduling evaluation", () => {
  let state = initialState();
  const nextSource = `A${source}`;
  const result = transition(state, {
    kind: "document-edited",
    path: "sample.ml.md",
    source: nextSource,
    change: { from: 0, to: 0, insert: "A" },
  });
  state = result.state;
  assert.equal(result.decision, "document-prose-updated");
  assert.deepEqual(result.effects, []);
  assert.equal(state.view.runtimeAuthority, "exact");
  assert.equal(
    resolveCursor(state.view, cursor).constructId,
    "old-construct",
  );
});

test("disjoint prose edits preserve intervening executable selectors", () => {
  const state = initialState();
  const result = transition(state, {
    kind: "document-edited",
    path: "sample.ml.md",
    source: `A${source}B`,
    changes: [
      { from: 0, to: 0, insert: "A" },
      { from: source.length, to: source.length, insert: "B" },
    ],
  });
  assert.equal(result.decision, "document-prose-updated");
  assert.deepEqual(result.effects, []);
  assert.equal(result.state.view.runtimeAuthority, "exact");
  assert.equal(resolveCursor(result.state.view, cursor).constructId, "old-construct");
});

test("an executable-equivalent move requests a fresh source map", () => {
  let state = initialState();
  state = transition(state, { kind: "cursor-moved", position: cursor }).state;
  const movedSource = "    let x = 1\nIntro\n\n";
  const result = transition(state, {
    kind: "document-edited",
    path: "sample.ml.md",
    source: movedSource,
    change: { from: 0, to: source.length, insert: movedSource },
  });
  assert.equal(result.decision, "document-source-map-refresh-requested");
  assert.equal(result.state.view.runtimeAuthority, "exact");
  assert.equal(result.state.evaluation.kind, "pending");
  assert.deepEqual(result.effects.map((effect) => effect.kind), ["lookup-artifact"]);
  assert.deepEqual(buildExecutionViewModel(result.state).coverage, []);
});

test("prose edits during evaluation restart the request at the new document revision", () => {
  let state = initialState();
  const one = source.indexOf("1");
  let result = transition(state, {
    kind: "document-edited",
    path: "sample.ml.md",
    source: `${source.slice(0, one)}2${source.slice(one + 1)}`,
    change: { from: one, to: one + 1, insert: "2" },
  });
  state = result.state;
  const oldToken = state.evaluation.token;
  const pendingSource = executionStateSources(state).get("sample.ml.md");
  result = transition(state, {
    kind: "document-edited",
    path: "sample.ml.md",
    source: `A${pendingSource}`,
    change: { from: 0, to: 0, insert: "A" },
  });
  assert.equal(result.decision, "document-prose-updated-pending-restarted");
  assert.deepEqual(result.effects.map((effect) => effect.kind), [
    "cancel-evaluation",
    "lookup-artifact",
  ]);
  assert.notEqual(result.state.evaluation.token.documentRevisionId, oldToken.documentRevisionId);
  assert.equal(
    transition(result.state, {
      kind: "evaluation-succeeded",
      token: oldToken,
      artifact: envelope(),
    }).decision,
    "artifact-discarded-stale-token",
  );
});

test("code edits cancel obsolete work and stale completions cannot install", () => {
  let state = initialState();
  const one = source.indexOf("1");
  let result = transition(state, {
    kind: "document-edited",
    path: "sample.ml.md",
    source: `${source.slice(0, one)}2${source.slice(one + 1)}`,
    change: { from: one, to: one + 1, insert: "2" },
  });
  state = result.state;
  const firstToken = state.evaluation.token;
  assert.equal(state.view.runtimeAuthority, "stale");
  assert.deepEqual(result.effects.map((effect) => effect.kind), ["lookup-artifact"]);

  const current = executionStateSources(state).get("sample.ml.md");
  const two = current.indexOf("2");
  result = transition(state, {
    kind: "document-edited",
    path: "sample.ml.md",
    source: `${current.slice(0, two)}3${current.slice(two + 1)}`,
    change: { from: two, to: two + 1, insert: "3" },
  });
  state = result.state;
  assert.deepEqual(result.effects.map((effect) => effect.kind), [
    "cancel-evaluation",
    "lookup-artifact",
  ]);
  const discarded = transition(state, {
    kind: "evaluation-succeeded",
    token: firstToken,
    artifact: envelope(),
  });
  assert.equal(discarded.state, state);
  assert.equal(discarded.decision, "artifact-discarded-stale-token");
});

test("a complete matching artifact installs atomically and reconciles selection", () => {
  let state = initialState();
  state = transition(state, { kind: "cursor-moved", position: cursor }).state;
  const insertAt = source.indexOf("\n", source.indexOf("let x"));
  let result = transition(state, {
    kind: "document-edited",
    path: "sample.ml.md",
    source: `${source.slice(0, insertAt)} ${source.slice(insertAt)}`,
    change: { from: insertAt, to: insertAt, insert: " " },
  });
  state = result.state;
  const token = state.evaluation.token;
  const nextArtifact = envelope({
    prefix: "new",
    requestCodeDigest: token.requestCodeDigest,
    projectDigest: token.projectDigest,
    codeRevisionId: "code-new",
    documentRevisionId: token.documentRevisionId,
  });
  result = transition(state, {
    kind: "evaluation-succeeded",
    token,
    artifact: nextArtifact,
  });
  assert.match(result.decision, /^artifact-installed:reconcile-/);
  assert.equal(result.state.view.runtimeAuthority, "exact");
  assert.equal(result.state.selection.constructId, "new-construct");
  assert.equal(result.state.selection.activationId, "new-activation");
  assert.equal(result.state.evaluation.kind, "idle");
});

test("reconciliation preserves the focused outcome ordinal across a range shift", () => {
  const oldArtifact = withRepeatedOccurrences(
    envelope({ prefix: "old" }),
    ["1", "2", "1", "1"],
  );
  const newArtifact = withRepeatedOccurrences(
    envelope({
      prefix: "new",
      codeRevisionId: "code-new",
      documentRevisionId: "document-new",
      startUtf16: 13,
    }),
    ["1", "1", "1"],
  );
  const oldView = viewFor(oldArtifact);
  const newView = viewFor(newArtifact, `X\n${source}`);
  const result = reconcileSelection(
    oldView,
    newView,
    {
      selectorId: "old-selector",
      constructId: "old-construct",
      activationId: "old-activation",
      focusedOccurrenceId: "old-activation-occurrence-2",
    },
  );
  assert.equal(result.decision, "reconcile-exact");
  assert.equal(result.selection.activationId, "new-activation");
  assert.equal(
    result.selection.focusedOccurrenceId,
    "new-activation-occurrence-1",
  );
});

test("reconciliation clears selections whose construct or selector disappeared", () => {
  const oldArtifact = envelope({ prefix: "old" });
  const cases = [
    {
      name: "construct",
      mutate(artifact) {
        artifact.staticProgram.constructs[0].syntaxFingerprint = "replacement";
        artifact.staticProgram.constructs[0].lexicalAncestryFingerprint =
          "top/replacement";
      },
    },
    {
      name: "selector",
      mutate(artifact) {
        artifact.staticProgram.selectors = [];
        artifact.sourceMaps.entries = [];
      },
    },
  ];
  for (const scenario of cases) {
    const next = structuredClone(envelope({ prefix: `new-${scenario.name}` }));
    scenario.mutate(next);
    const result = reconcileSelection(
      viewFor(oldArtifact),
      viewFor(sealExecutionEnvelope(next)),
      {
        selectorId: "old-selector",
        constructId: "old-construct",
        activationId: "old-activation",
        focusedOccurrenceId: "old-occurrence",
      },
    );
    assert.equal(result.decision, "reconcile-construct-missing", scenario.name);
    assert.equal(result.selection.activationId, null, scenario.name);
    assert.equal(result.selection.constructId, null, scenario.name);
  }
});

test("ambiguous activation signatures use activation recency deterministically", () => {
  const oldArtifact = envelope({ prefix: "old" });
  const next = structuredClone(envelope({ prefix: "new" }));
  const first = next.execution.activations[0];
  const firstOccurrence = next.execution.occurrences[0];
  const secondActivation = {
    ...structuredClone(first),
    id: "new-activation-second",
    occurrenceIds: ["new-occurrence-second"],
    enteredAt: 4,
    outcomeAt: 7,
  };
  const secondOccurrence = {
    ...structuredClone(firstOccurrence),
    id: "new-occurrence-second",
    activationId: secondActivation.id,
    enteredAt: 5,
    outcomeAt: 6,
  };
  next.execution.activations.push(secondActivation);
  next.execution.occurrences.push(secondOccurrence);
  next.terminal.finalSequence = 7;
  const result = reconcileSelection(
    viewFor(oldArtifact),
    viewFor(sealExecutionEnvelope(next)),
    {
      selectorId: "old-selector",
      constructId: "old-construct",
      activationId: "old-activation",
      focusedOccurrenceId: "old-occurrence",
    },
    readonlyRecency([[secondActivation.id, 9]]),
  );
  assert.equal(result.decision, "reconcile-ambiguous");
  assert.equal(result.ambiguous, true);
  assert.equal(result.selection.activationId, secondActivation.id);
  assert.equal(result.selection.focusedOccurrenceId, secondOccurrence.id);
});

test("ambiguous construct reconciliation prefers matching execution over ID order", () => {
  const oldArtifact = envelope({ prefix: "old" });
  const newArtifact = withReachedAndUnreachedReconciliationCandidates(
    envelope({ prefix: "new", codeRevisionId: "code-new" }),
  );
  const result = reconcileSelection(
    viewFor(oldArtifact),
    viewFor(newArtifact),
    {
      selectorId: "old-selector",
      constructId: "old-construct",
      activationId: "old-activation",
      focusedOccurrenceId: "old-occurrence",
    },
  );
  assert.equal(result.ambiguous, true);
  assert.equal(result.selection.constructId, "new-z-construct");
  assert.equal(result.selection.activationId, "new-activation");
});

test("a cache miss requests exactly one evaluation for the current token", () => {
  let state = initialState();
  const one = source.indexOf("1");
  let result = transition(state, {
    kind: "document-edited",
    path: "sample.ml.md",
    source: `${source.slice(0, one)}2${source.slice(one + 1)}`,
    change: { from: one, to: one + 1, insert: "2" },
  });
  state = result.state;
  const token = state.evaluation.token;
  result = transition(state, {
    kind: "artifact-available",
    token,
    artifact: null,
  });
  assert.equal(result.decision, "artifact-cache-miss");
  assert.deepEqual(result.effects.map((effect) => effect.kind), ["evaluate"]);
  assert.equal(result.effects[0].token, token);
});

test("an A to B to A edit installs the cached A artifact without evaluation", () => {
  let state = initialState();
  const originalRequestCodeDigest = state.requestCodeDigest;
  const one = source.indexOf("1");
  let result = transition(state, {
    kind: "document-edited",
    path: "sample.ml.md",
    source: `${source.slice(0, one)}2${source.slice(one + 1)}`,
    change: { from: one, to: one + 1, insert: "2" },
  });
  state = result.state;
  assert.notEqual(state.evaluation.token.requestCodeDigest, originalRequestCodeDigest);

  const changedSource = executionStateSources(state).get("sample.ml.md");
  const two = changedSource.indexOf("2");
  result = transition(state, {
    kind: "document-edited",
    path: "sample.ml.md",
    source: `${changedSource.slice(0, two)}1${changedSource.slice(two + 1)}`,
    change: { from: two, to: two + 1, insert: "1" },
  });
  state = result.state;
  const token = state.evaluation.token;
  assert.equal(token.requestCodeDigest, originalRequestCodeDigest);

  result = transition(state, {
    kind: "artifact-available",
    token,
    artifact: envelope({ requestCodeDigest: originalRequestCodeDigest }),
  });
  assert.match(result.decision, /^artifact-installed:/);
  assert.deepEqual(result.effects, []);
  assert.equal(result.state.view.runtimeAuthority, "exact");
  assert.equal(result.state.evaluation.kind, "idle");
});

test("a cache entry with the wrong revision cannot replace the pending view", () => {
  let state = initialState();
  const one = source.indexOf("1");
  let result = transition(state, {
    kind: "document-edited",
    path: "sample.ml.md",
    source: `${source.slice(0, one)}2${source.slice(one + 1)}`,
    change: { from: one, to: one + 1, insert: "2" },
  });
  state = result.state;
  const token = state.evaluation.token;
  result = transition(state, {
    kind: "artifact-available",
    token,
    artifact: envelope({ requestCodeDigest: "different-code" }),
  });
  assert.equal(result.decision, "artifact-discarded-revision-mismatch-retry");
  assert.equal(result.state, state);
  assert.equal(result.state.view.runtimeAuthority, "stale");
  assert.equal(result.effects.length, 1);
  assert.equal(result.effects[0].kind, "evaluate");
  assert.deepEqual(result.effects[0].token, token);
});

test("a failed current evaluation stays stale and an older failure is ignored", () => {
  let state = initialState();
  const one = source.indexOf("1");
  let result = transition(state, {
    kind: "document-edited",
    path: "sample.ml.md",
    source: `${source.slice(0, one)}2${source.slice(one + 1)}`,
    change: { from: one, to: one + 1, insert: "2" },
  });
  state = result.state;
  const oldToken = state.evaluation.token;
  const changedSource = executionStateSources(state).get("sample.ml.md");
  const two = changedSource.indexOf("2");
  result = transition(state, {
    kind: "document-edited",
    path: "sample.ml.md",
    source: `${changedSource.slice(0, two)}3${changedSource.slice(two + 1)}`,
    change: { from: two, to: two + 1, insert: "3" },
  });
  state = result.state;
  const currentToken = state.evaluation.token;

  result = transition(state, {
    kind: "evaluation-failed",
    token: oldToken,
    diagnostics: ["old failure"],
  });
  assert.equal(result.decision, "evaluation-failure-discarded-stale-token");
  assert.equal(result.state, state);

  result = transition(state, {
    kind: "evaluation-failed",
    token: currentToken,
    diagnostics: ["current failure"],
  });
  assert.equal(result.decision, "evaluation-failed");
  assert.equal(result.state.view.runtimeAuthority, "stale");
  assert.equal(result.state.evaluation.kind, "failed");
  assert.deepEqual(result.state.evaluation.diagnostics, ["current failure"]);
});
