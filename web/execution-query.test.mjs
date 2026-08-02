import assert from "node:assert/strict";
import test from "node:test";
import {
  buildExecutionSnapshot,
  sealExecutionEnvelope,
} from "./execution-artifact.js";
import {
  emptyExecutionSelection,
  executionChoicesAt,
  focusedOccurrenceValue,
  navigateActivation,
  occurrenceRowsForConstruct,
  projectActivation,
  resolveCursor,
  selectActivation,
  selectCursor,
  selectOccurrence,
  selectionHasExpressionValue,
  valuesAt,
} from "./execution-query.js";
import { compareExecutionViewSelectorPreference } from "./execution-view.js";
import { buildExecutionViewModel } from "./execution-view-model.js";

test("selector specificity is range-first and priority breaks only equal ranges", () => {
  const selector = (id, start, end, priority) => ({
    id,
    priority,
    tieBreakRank: 0,
    range: { start, end },
  });
  const constructor = selector("constructor", 0, 20, 11);
  const binder = selector("binder", 8, 14, 10);
  assert.equal(
    [constructor, binder].sort(compareExecutionViewSelectorPreference)[0],
    binder,
  );
  const wrapper = selector("wrapper", 0, 20, 10);
  assert.equal(
    [wrapper, constructor].sort(compareExecutionViewSelectorPreference)[0],
    constructor,
  );
});
import { createExecutionState, transition } from "./execution-reducer.js";
import {
  buildExecutionSelfCheck,
  buildExecutionUxLine,
  buildExecutionUxMatrix,
  renderExecutionAtlas,
  renderExecutionSelfCheck,
  renderExecutionVisualReport,
  renderExecutionUxMatrix,
  renderUnavailableExecutionAtlas,
} from "./execution-self-check.js";
import {
  buildExecutionView,
  buildExecutionViewFromArtifact,
  executionViewOffset,
  executionViewSelectionRange,
  executionViewSelectorAt,
  executionViewSourceText,
} from "./execution-view.js";

const value = (display) => ({
  kind: "return",
  value: { type: "int", display, fingerprint: display, complete: true },
  source: "runtime",
});

function fixture() {
  const constructs = [
    ["call", 0, 5],
    ["one", 8, 9],
    ["never", 6, 7],
  ].map(([name, startByte, endByte]) => ({
    id: `construct-${name}`,
    category: "expression",
    semanticKind: name === "call" ? "application" : "literal",
    compilerRange: { generatedPath: "sample.ml", startByte, endByte },
    parentId: null,
    ownerScopeId: "scope-top",
    lexicalScopeId: "scope-top",
    syntaxFingerprint: name,
    lexicalAncestryFingerprint: name,
    ghost: false,
  }));
  const selectors = [
    ["callee", "call", 0, 3, 20],
    ["call", "call", 0, 5, 0],
    ["one", "one", 8, 9, 0],
    ["never", "never", 6, 7, 0],
    ["context", "call", 9, 9, 35],
  ].map(([name, subject, startByte, endByte, priority]) => ({
    id: `selector-${name}`,
    compilerRange: { generatedPath: "sample.ml", startByte, endByte },
    subjectId: `construct-${subject}`,
    role: name === "callee"
      ? "callee"
      : name === "context"
        ? "function-context"
        : "construct",
    priority,
    tieBreakRank: 0,
    syntaxFingerprint: name,
  }));
  const occurrence = (id, constructId, activationId, enteredAt, display) => ({
    id,
    constructId,
    activationId,
    parentOccurrenceId: null,
    kind: "expression",
    enteredAt,
    outcomeAt: enteredAt + 1,
    outcome: value(display),
  });
  const occurrences = [
    occurrence("occurrence-call-a", "construct-call", "activation-a", 1, "5"),
    occurrence("occurrence-one-a", "construct-one", "activation-a", 3, "1"),
    occurrence("occurrence-call-a2", "construct-call", "activation-a", 4, "6"),
    occurrence("occurrence-call-b", "construct-call", "activation-b", 5, "8"),
  ];
  const activation = (id, occurrenceIds, enteredAt, display) => ({
    id,
    scopeId: "scope-top",
    functionOccurrenceId: null,
    functionConstructId: null,
    closureId: null,
    dynamicParentId: null,
    callsiteOccurrenceId: null,
    consumedCallAttemptId: null,
    occurrenceIds,
    parameterOccurrenceIds: [],
    enteredAt,
    outcomeAt: enteredAt + 10,
    outcome: value(display),
    signature: {
      functionKey: id,
      callsiteKey: null,
      parameterFingerprints: [],
      outcomeFingerprint: display,
    },
  });
  const envelope = sealExecutionEnvelope({
    schemaVersion: 1,
    evaluationId: "evaluation-query",
    requestCodeDigest: "code",
    projectDigest: "project",
    codeRevisionId: "code",
    compilerInputsDigest: "compiler",
    staticProgram: {
      codeRevisionId: "code",
      compilerInputsDigest: "compiler",
      compilationUnits: [
        {
          id: "unit",
          modulePath: "Sample",
          generatedPath: "sample.ml",
          byteLength: 9,
          sourceDigest: "source",
          topLevelScopeId: "scope-top",
        },
      ],
      executionScopes: [
        { id: "scope-top", kind: "top-level", unitId: "unit" },
      ],
      constructs,
      selectors,
    },
    sourceMaps: {
      documentRevisionId: "document",
      codeRevisionId: "code",
      sourcesDigest: "sources",
      extractedCodeDigest: "code",
      entries: selectors
        .map((selector) => ({
          selectorId: selector.id,
          generatedPath: selector.compilerRange.generatedPath,
          startByte: selector.compilerRange.startByte,
          endByte: selector.compilerRange.endByte,
          documentPath: "sample.ml.md",
          startUtf16: selector.compilerRange.startByte,
          endUtf16: selector.compilerRange.endByte,
        }))
        .sort(
          (left, right) =>
            left.startByte - right.startByte || left.endByte - right.endByte,
        ),
    },
    execution: {
      occurrences,
      activations: [
        activation(
          "activation-a",
          ["occurrence-call-a", "occurrence-one-a", "occurrence-call-a2"],
          0,
          "()",
        ),
        activation("activation-b", ["occurrence-call-b"], 4, "()"),
      ],
      closures: [],
      closureProvenance: [],
      callAttempts: [],
      writes: [],
    },
    terminal: { kind: "complete", finalSequence: 20, checksum: "terminal" },
    artifactChecksum: "artifact",
  });
  const built = buildExecutionSnapshot(envelope);
  assert.equal(built.ok, true);
  const projectedSelectors = selectors.map((selector) => ({
    ...selector,
    range: {
      path: "sample.ml.md",
      start: selector.compilerRange.startByte,
      end: selector.compilerRange.endByte,
    },
  }));
  const view = buildExecutionView({
    snapshot: built.snapshot,
    documentRevisionId: "document",
    sources: { "sample.ml.md": "fib 5 + 1" },
    projectedSelectors,
  });
  return { envelope, snapshot: built.snapshot, view, projectedSelectors };
}

test("artifact source maps are the only compiler-to-editor projection", () => {
  const { envelope, snapshot } = fixture();
  const view = buildExecutionViewFromArtifact({
    snapshot,
    envelope,
    sources: { "sample.ml.md": "fib 5 + 1" },
  });
  assert.equal(
    resolveCursor(view, { path: "sample.ml.md", line: 1, column: 1 })
      .selectorId,
    "selector-callee",
  );
});

test("callee boundaries present the complete call and whitespace only transitions", () => {
  const { view } = fixture();
  for (const column of [0, 1, 2, 3]) {
    const query = resolveCursor(view, {
      path: "sample.ml.md",
      line: 1,
      column,
    });
    assert.equal(query.constructId, "construct-call");
    const selector = executionViewSelectorAt(view, query.position);
    assert.deepEqual(executionViewSelectionRange(view, selector), {
      path: "sample.ml.md",
      start: 0,
      end: 5,
    });
    const state = createExecutionState({ view });
    const moved = transition(state, { kind: "cursor-moved", position: query.position });
    const model = buildExecutionViewModel(moved.state);
    assert.equal(model.occurrenceList.expression, "fib 5");
  }
  assert.equal(
    resolveCursor(view, { path: "sample.ml.md", line: 1, column: 5 })
      .constructId,
    "construct-call",
  );
  assert.equal(
    resolveCursor(view, { path: "sample.ml.md", line: 1, column: 6 })
      .constructId,
    "construct-never",
  );
});

test("occurrence navigation chooses an anchor owned by its construct", () => {
  const { snapshot, projectedSelectors } = fixture();
  const view = buildExecutionView({
    snapshot,
    documentRevisionId: "document",
    sources: { "sample.ml.md": "fib 5 + 1" },
    projectedSelectors: projectedSelectors
      .filter((selector) => selector.id !== "selector-callee")
      .map((selector) =>
        selector.id === "selector-one"
          ? {
              ...selector,
              subjectId: "construct-one",
              priority: 20,
              range: { path: "sample.ml.md", start: 0, end: 3 },
            }
          : selector,
      ),
  });
  const selected = selectOccurrence(view, "occurrence-call-a");
  assert.equal(selected.accepted, true);
  assert.deepEqual(selected.moveCursorTo, {
    path: "sample.ml.md",
    start: 0,
    end: 5,
  });
  assert.deepEqual(selected.cursorAnchor, {
    path: "sample.ml.md",
    line: 1,
    column: 3,
  });
  assert.equal(resolveCursor(view, selected.cursorAnchor).constructId, "construct-call");
});

test("the exhaustive self-check and compact atlas use the production state path", () => {
  const { envelope, snapshot, projectedSelectors } = fixture();
  const source = "fib 5 + 1\nsecond line";
  const view = buildExecutionView({
    snapshot,
    documentRevisionId: "document-two-lines",
    sources: { "sample.ml.md": source },
    projectedSelectors,
  });
  const state = createExecutionState({
    view,
    projectDigest: envelope.projectDigest,
    compilerInputsDigest: envelope.compilerInputsDigest,
    requestCodeDigest: envelope.requestCodeDigest,
  });
  const check = buildExecutionSelfCheck({
    view,
    initialState: state,
    path: "sample.ml.md",
    source,
  });
  assert.equal(check.ok, true, renderExecutionSelfCheck(check));
  assert.equal(check.counts.boundaries, 22);
  assert.match(renderExecutionSelfCheck(check), /^self-check ok/m);
  assert.match(renderExecutionAtlas(check), /^atlas sample\.ml\.md/m);
  assert.match(renderExecutionAtlas(check), /^Q \| /m);
  assert.match(renderExecutionAtlas(check), /^H \| /m);

  const uxMatrix = buildExecutionUxMatrix(check, { lineFrom: 1, lineTo: 1 });
  const uxLine = buildExecutionUxLine(state, {
    path: "sample.ml.md",
    source,
    line: 1,
  });
  assert.deepEqual(uxLine.lines, uxMatrix.lines);
  assert.deepEqual(uxLine.tables, uxMatrix.tables);
  assert.equal(uxMatrix.lines[0].boundaries.length, "fib 5 + 1".length + 1);
  assert.ok(
    uxMatrix.lines[0].boundaries.every(
      (boundary) =>
        boundary.columnId && boundary.highlightId && boundary.rightPaneId,
    ),
  );
  assert.deepEqual(
    Object.keys(uxMatrix.tables.rightPanes[0].state).sort(),
    ["count", "emptyReason", "expression", "rows"],
  );
  assert.ok(
    uxMatrix.tables.highlights.every((entry) =>
      entry.state.some(
        (line) => line.line === 1 && line.band.length === "fib 5 + 1".length,
      ),
    ),
  );
  const renderedUx = renderExecutionUxMatrix(uxMatrix);
  assert.match(renderedUx, /^ux-matrix sample\.ml\.md lines 1:1/m);
  assert.match(renderedUx, /^C \| /m);
  assert.match(renderedUx, /^H \| /m);
  assert.match(renderedUx, /^R \| /m);
  assert.match(renderedUx, /source-length\+1 IDs/);

  const visualReport = renderExecutionVisualReport(check, {
    lineFrom: 1,
    lineTo: 1,
  });
  assert.match(visualReport, /^visual audit sample\.ml\.md/m);
  assert.match(visualReport, /^1 \| fib 5 \+ 1·$/m);
  const overview = visualReport.match(/^V \| (.+)$/m)?.[1] || "";
  assert.equal(overview.length, "fib 5 + 1".length + 1);
  assert.match(visualReport, /^view 1:[0-9A-Za-z]+  cursor 1:/m);
  assert.match(visualReport, /^  \| [ ▲]+ cursor /m);
  assert.match(visualReport, /^right pane /m);
  assert.doesNotMatch(visualReport, /^C \| |^H \| |^R \| /m);
});

test("the atlas remains readable when no execution artifact can be built", () => {
  assert.equal(
    renderUnavailableExecutionAtlas({
      path: "broken.ml.md",
      problems: [{ code: "artifact-missing", detail: "compile failed" }],
    }),
    "atlas broken.ml.md\nartifact unavailable\nproblems 1\n" +
      "! artifact-missing compile failed\nself-check unavailable",
  );
});

test("CRLF sources use CodeMirror's normalized LF coordinate space", () => {
  const view = buildExecutionView({
    documentRevisionId: "crlf-document",
    sources: { "crlf.ml.md": "a\r\nb" },
    projectedSelectors: [
      {
        id: "selector-b",
        subjectId: "construct-b",
        role: "construct",
        priority: 0,
        tieBreakRank: 0,
        range: { path: "crlf.ml.md", start: 2, end: 3 },
      },
    ],
    runtimeAuthority: "unavailable",
  });
  const position = { path: "crlf.ml.md", line: 2, column: 0 };
  assert.equal(executionViewOffset(view, position), 2);
  assert.equal(executionViewSelectorAt(view, position).id, "selector-b");
  assert.equal(
    executionViewSourceText(view, { path: "crlf.ml.md", start: 2, end: 3 }),
    "b",
  );
});

test("cursor resolution and activation choice use immutable indexes", () => {
  const { view } = fixture();
  const query = resolveCursor(view, {
    path: "sample.ml.md",
    line: 1,
    column: 1,
  });
  assert.equal(query.selectorId, "selector-callee");
  assert.equal(query.constructId, "construct-call");
  assert.deepEqual(query.activationIds, ["activation-a", "activation-b"]);
  const selected = selectCursor(view, query, emptyExecutionSelection(), {
    viewedAtByActivationId: new Map([["activation-b", 4]]),
  });
  assert.equal(selected.activationId, "activation-b");
  assert.equal(selected.focusedOccurrenceId, "occurrence-call-b");
  assert.equal(valuesAt(view, selected).values[0].outcome.value.display, "8");
  assert.equal(executionChoicesAt(view, query.position).length, 2);
});

test("line end prefers the completed value expression over function context", () => {
  const { view } = fixture();
  const query = resolveCursor(view, {
    path: "sample.ml.md",
    line: 1,
    column: 9,
  });
  assert.equal(query.selectorId, "selector-one");
  assert.equal(query.status, "reached");
  const selection = selectCursor(view, query);
  assert.equal(selection.activationId, "activation-a");
  assert.equal(selection.focusedOccurrenceId, "occurrence-one-a");
  assert.equal(valuesAt(view, selection).values[0].outcome.value.display, "1");
});

test("function context remains the line-end fallback without a completed expression", () => {
  const { snapshot, projectedSelectors } = fixture();
  const view = buildExecutionView({
    snapshot,
    documentRevisionId: "document",
    sources: { "sample.ml.md": "fib 5 + 1" },
    projectedSelectors: projectedSelectors.filter(
      (selector) => selector.id !== "selector-one",
    ),
  });
  const query = resolveCursor(view, {
    path: "sample.ml.md",
    line: 1,
    column: 9,
  });
  assert.equal(query.selectorId, "selector-context");
  const selection = selectCursor(view, query);
  assert.equal(selection.activationId, "activation-a");
  assert.equal(selection.focusedOccurrenceId, null);
  assert.deepEqual(valuesAt(view, selection), { values: [], total: 0 });
});

test("occurrence rows preserve repeats and focused values exactly", () => {
  const { view } = fixture();
  const rows = occurrenceRowsForConstruct(view, "construct-call");
  assert.deepEqual(
    rows.map((row) => [row.occurrence.id, row.ordinal, row.totalInActivation]),
    [
      ["occurrence-call-a", 1, 2],
      ["occurrence-call-a2", 2, 2],
      ["occurrence-call-b", 1, 1],
    ],
  );
  const focused = focusedOccurrenceValue(view, {
    selectorId: "selector-callee",
    constructId: "construct-call",
    activationId: "activation-a",
    focusedOccurrenceId: "occurrence-call-a2",
  });
  assert.equal(focused.outcome.value.display, "6");
});

test("structural keyword selectors never present an expression value", () => {
  const { snapshot, projectedSelectors } = fixture();
  for (const role of ["if", "match", "let", "equals"]) {
    const view = buildExecutionView({
      snapshot,
      documentRevisionId: "document",
      sources: { "sample.ml.md": "fib 5 + 1" },
      projectedSelectors: projectedSelectors.map((selector) =>
        selector.id === "selector-callee" ? { ...selector, role } : selector,
      ),
    });
    const query = resolveCursor(view, {
      path: "sample.ml.md",
      line: 1,
      column: 1,
    });
    const selection = selectCursor(view, query);
    assert.equal(selectionHasExpressionValue(view, selection), false, role);
    assert.deepEqual(valuesAt(view, selection), { values: [], total: 0 }, role);
  }
});

test("values skip incomplete later occurrences instead of exposing null", () => {
  const { envelope: original, projectedSelectors } = fixture();
  const input = structuredClone(original);
  const incomplete = input.execution.occurrences.find(
    (occurrence) => occurrence.id === "occurrence-call-a2",
  );
  incomplete.outcomeAt = null;
  incomplete.outcome = { kind: "incomplete", value: null, source: "runtime" };
  input.terminal.kind = "truncated";
  const built = buildExecutionSnapshot(sealExecutionEnvelope(input));
  assert.equal(built.ok, true);
  const view = buildExecutionView({
    snapshot: built.snapshot,
    documentRevisionId: "document",
    sources: { "sample.ml.md": "fib 5 + 1" },
    projectedSelectors,
  });
  const values = valuesAt(view, {
    selectorId: "selector-callee",
    constructId: "construct-call",
    activationId: "activation-a",
    focusedOccurrenceId: "occurrence-call-a",
  });
  assert.equal(values.total, 1);
  assert.equal(values.values[0].occurrenceId, "occurrence-call-a");
  assert.equal(values.values.includes(null), false);
});

test("unreached constructs select the empty activation set without fallback", () => {
  const { view } = fixture();
  const query = resolveCursor(view, {
    path: "sample.ml.md",
    line: 1,
    column: 6,
  });
  assert.equal(query.constructId, "construct-never");
  assert.equal(query.status, "unreached");
  assert.deepEqual(query.activationIds, []);
  assert.equal(selectCursor(view, query).activationId, null);
});

test("activation projection separates three coverage states", () => {
  const { view } = fixture();
  const callQuery = resolveCursor(view, {
    path: "sample.ml.md",
    line: 1,
    column: 1,
  });
  const selection = selectCursor(view, callQuery);
  const projection = projectActivation(view, selection);
  assert.deepEqual(projection.activeConstructIds, ["construct-call", "construct-one"]);
  assert.deepEqual(projection.inactiveConstructIds, []);
  assert.deepEqual(projection.globallyUnreachedConstructIds, ["construct-never"]);
});

test("activation projection is cached by immutable view and activation", () => {
  const { view } = fixture();
  const query = resolveCursor(view, {
    path: "sample.ml.md",
    line: 1,
    column: 1,
  });
  const selection = selectCursor(view, query);
  const first = projectActivation(view, selection);
  const second = projectActivation(view, {
    ...selection,
    selectorId: null,
    constructId: null,
    focusedOccurrenceId: null,
  });
  assert.equal(second, first);
});

test("stale views suppress runtime choices and values", () => {
  const { snapshot, projectedSelectors } = fixture();
  const view = buildExecutionView({
    snapshot,
    documentRevisionId: "draft",
    sources: { "sample.ml.md": "fib 5 + 1" },
    projectedSelectors,
    runtimeAuthority: "stale",
    draft: { codeChanged: true },
  });
  const query = resolveCursor(view, {
    path: "sample.ml.md",
    line: 1,
    column: 1,
  });
  assert.equal(query.status, "stale");
  assert.deepEqual(query.activationIds, []);
  assert.equal(projectActivation(view, { activationId: "activation-a" }), null);
  assert.deepEqual(
    buildExecutionViewModel(
      createExecutionState({
        view,
        projectDigest: "project",
        compilerInputsDigest: "compiler",
      }),
    ).coverage,
    [],
  );
});

test("invalid activation changes and source-less navigation are explicit", () => {
  const { view } = fixture();
  const query = resolveCursor(view, {
    path: "sample.ml.md",
    line: 1,
    column: 8,
  });
  const selection = selectCursor(view, query);
  const rejected = selectActivation(view, selection, "activation-b");
  assert.equal(rejected.accepted, false);
  assert.equal(rejected.selection, selection);
  assert.equal(navigateActivation(view, "activation-a").accepted, false);
});
