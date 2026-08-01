import assert from "node:assert/strict";
import test from "node:test";

import {
  executionActivationInactiveRanges,
  executionCallLinkAt,
  executionActiveRanges,
  executionCallerFrame,
  executionCursorCoverageIsConsistent,
  executionFocusRangeAtPosition,
  executionFunctionSourceRange,
  executionHighlightIsConsistent,
  executionIdentifierRange,
  executionNeverRunRanges,
  executionRangeContainsPosition,
  executionRangesWithFocus,
  executionSnapshotKey,
  executionSnapshotMatches,
  executionStructuralLines,
  executionTraceIdentifierRange,
} from "./execution-lens.js";
import { executionSiteAt } from "./execution-cursor.js";
import { executionTimelineCursorTarget } from "./execution-timeline.js";

test("keys execution data by project, page, and exact source", () => {
  const snapshot = {
    projectVersion: "project-a",
    path: "demo.ml.md",
    source: "let answer = 42",
  };
  assert.equal(
    executionSnapshotKey(snapshot),
    '["project-a","demo.ml.md","let answer = 42"]',
  );
  assert.equal(
    executionSnapshotMatches({ ...snapshot, stale: false }, snapshot),
    true,
  );
  assert.equal(
    executionSnapshotMatches(
      { ...snapshot, source: "let answer = 43", stale: false },
      snapshot,
    ),
    false,
  );
  assert.equal(
    executionSnapshotMatches({ ...snapshot, stale: true }, snapshot),
    false,
  );
});

test("resolves only the call identifier under the pointer", () => {
  const links = [
    { line: 8, column: 12, endColumn: 18, callId: "parent" },
    { line: 12, column: 24, endColumn: 30, callId: "child" },
  ];
  assert.equal(executionCallLinkAt(links, 12, 24), "child");
  assert.equal(executionCallLinkAt(links, 12, 27), "child");
  assert.equal(executionCallLinkAt(links, 12, 30), "child");
  assert.equal(executionCallLinkAt(links, 12, 23), null);
  assert.equal(executionCallLinkAt(links, 11, 27), null);
});

test("maps post-call positions to the preceding repeated identifier", () => {
  const line = "      else fib (n-1) + fib (n-2)";
  assert.deepEqual(executionIdentifierRange(line, "fib", 21), {
    column: 11,
    endColumn: 14,
  });
  assert.deepEqual(executionIdentifierRange(line, "fib", 32), {
    column: 23,
    endColumn: 26,
  });
});

test("keeps trace-provided ranges for repeated pattern binders", () => {
  const line = "      | Pair (left, right) | Product (left, right) ->";
  const secondLeft = line.lastIndexOf("left");
  assert.deepEqual(
    executionTraceIdentifierRange(
      line,
      "left",
      secondLeft,
      secondLeft + "left".length,
    ),
    { column: secondLeft, endColumn: secondLeft + "left".length },
  );
});

test("uses the exact lambda span instead of its enclosing let block", () => {
  const source = [
    "    let tree =",
    "      List.fold_left",
    "        (fun tree value -> insert value tree)",
    "        Empty",
    "        values",
    "",
    "    let result = tree",
  ].join("\n");
  assert.deepEqual(
    executionFunctionSourceRange(source, {
      label: "fun",
      line: 3,
      column: 9,
      endLine: 3,
      endColumn: 45,
    }),
    {
      start: 3,
      end: 3,
      startColumn: 9,
      endColumn: 45,
    },
  );
  assert.deepEqual(
    executionFunctionSourceRange(source, { label: "tree", line: 1 }),
    { start: 1, end: 5 },
  );
});

test("keeps repeated calls on one line attached to their caller frames", () => {
  const parent = {
    path: "fib.ml.md",
    range: { start: 5, end: 8 },
  };
  const rightCall = executionCallerFrame(
    [
      { path: "fib.ml.md", line: 8, column: 12 },
      { path: "fib.ml.md", line: 8, column: 32 },
      { path: "fib.ml.md", line: 12, column: 17 },
    ],
    parent,
  );
  const leftCall = executionCallerFrame(
    [
      { path: "fib.ml.md", line: 8, column: 12 },
      { path: "fib.ml.md", line: 8, column: 21 },
      { path: "fib.ml.md", line: 12, column: 17 },
    ],
    parent,
  );
  assert.equal(rightCall.column, 32);
  assert.equal(leftCall.column, 21);
});

test("keeps the in of an active let on the executed path", () => {
  const lines = [
    "let second =",
    "  unify left right",
    "in",
    "compose second first",
    "",
    "in",
    "inactive continuation",
  ];
  const structural = executionStructuralLines(
    lines,
    new Set([1, 2, 4]),
  );
  assert.deepEqual([...structural], [3]);
});

test("looks through blank lines before an active let continuation", () => {
  const structural = executionStructuralLines(
    ["let value = work ()", "in", "", "use value"],
    new Set([1, 4]),
  );
  assert.deepEqual([...structural], [2]);
});

test("projects executed syntax precisely and fades only the untaken branch", () => {
  const source = "if n < 2 then n else fib (n - 1)";
  const conditionStart = source.indexOf("n < 2");
  const conditionEnd = conditionStart + "n < 2".length;
  const thenStart = source.indexOf(
    "n",
    source.indexOf("then", conditionEnd) + "then".length,
  );
  const elseStart = source.indexOf("fib");
  const range = (startColumn, endColumn) => ({
    startLine: 1,
    startColumn,
    endLine: 1,
    endColumn,
  });
  const sites = [
    { id: "if", kind: "expression", ghost: false, ...range(0, source.length) },
    {
      id: "condition",
      parentId: "if",
      kind: "expression",
      ghost: false,
      ...range(conditionStart, conditionEnd),
    },
    {
      id: "then",
      parentId: "if",
      kind: "expression",
      ghost: false,
      ...range(thenStart, thenStart + 1),
    },
    {
      id: "else",
      parentId: "if",
      kind: "expression",
      ghost: false,
      ...range(elseStart, source.length),
    },
    {
      id: "operator",
      parentId: "condition",
      kind: "expression",
      ghost: false,
      ...range(source.indexOf("<"), source.indexOf("<") + 1),
    },
  ];
  const occurrence = (site) => ({
    path: "demo.ml.md",
    line: site.startLine,
    column: site.startColumn,
    endLine: site.endLine,
    endColumn: site.endColumn,
  });
  const call = {
    kind: "function",
    path: "demo.ml.md",
    line: 1,
    column: 0,
    endLine: 1,
    endColumn: 0,
    range: { start: 1, end: 1 },
    ownOccurrences: [
      occurrence(sites[0]),
      occurrence(sites[1]),
      occurrence(sites[3]),
    ],
  };
  const activeRanges = executionActiveRanges({ source, call, sites });
  const events = call.ownOccurrences.flatMap((occurrence, index) => [
    { ...occurrence, phase: "enter", sequence: index * 2 },
    { ...occurrence, phase: "return", sequence: index * 2 + 1 },
  ]);
  const inactiveRanges = executionNeverRunRanges({
    source,
    path: call.path,
    events,
    sites,
  });
  const at = (column) => ({ line: 1, column });

  assert.equal(
    activeRanges.some((active) =>
      executionRangeContainsPosition(active, at(source.indexOf("if"))),
    ),
    true,
  );
  assert.equal(
    activeRanges.some((active) =>
      executionRangeContainsPosition(active, at(source.indexOf("<"))),
    ),
    true,
  );
  assert.equal(
    activeRanges.some((active) =>
      executionRangeContainsPosition(active, at(thenStart)),
    ),
    false,
  );
  assert.equal(
    inactiveRanges.some((inactive) =>
      executionRangeContainsPosition(inactive, at(thenStart)),
    ),
    true,
  );
  assert.equal(
    inactiveRanges.some((inactive) =>
      executionRangeContainsPosition(inactive, at(elseStart)),
    ),
    false,
  );
  assert.equal(
    inactiveRanges.some((inactive) =>
      executionRangeContainsPosition(inactive, at(source.indexOf("<"))),
    ),
    false,
  );
});

test("fades the branch not taken by the selected activation", () => {
  const source = "if n < 2 then n else fib (n - 1)";
  const range = (startColumn, endColumn) => ({
    startLine: 1,
    startColumn,
    endLine: 1,
    endColumn,
  });
  const conditionStart = source.indexOf("n < 2");
  const thenStart = source.indexOf(
    "n",
    source.indexOf("then", conditionStart + 5) + "then".length,
  );
  const elseStart = source.indexOf("fib");
  const sites = [
    { id: "if", kind: "expression", ghost: false, ...range(0, source.length) },
    { id: "condition", parentId: "if", kind: "expression", ghost: false, ...range(conditionStart, conditionStart + 5) },
    { id: "then", parentId: "if", kind: "expression", ghost: false, ...range(thenStart, thenStart + 1) },
    { id: "else", parentId: "if", kind: "expression", ghost: false, ...range(elseStart, source.length) },
  ];
  const occurrence = (site) => ({
    path: "fib.ml.md",
    line: site.startLine,
    column: site.startColumn,
    endLine: site.endLine,
    endColumn: site.endColumn,
  });
  const activation = (taken) => ({
    kind: "function",
    path: "fib.ml.md",
    range: { start: 1, end: 1 },
    ownOccurrences: [
      occurrence(sites[0]),
      occurrence(sites[1]),
      occurrence(taken),
    ],
  });
  const contains = (ranges, column) =>
    ranges.some((candidate) =>
      executionRangeContainsPosition(candidate, { line: 1, column })
    );

  const recursiveActivation = executionActivationInactiveRanges({
    source,
    call: activation(sites[3]),
    sites,
  });
  assert.equal(contains(recursiveActivation, source.indexOf("then")), true);
  assert.equal(contains(recursiveActivation, thenStart), true);
  assert.equal(contains(recursiveActivation, elseStart), false);
  assert.equal(
    executionCursorCoverageIsConsistent({
      activeRanges: [range(elseStart, source.length)],
      activationInactiveRanges: recursiveActivation,
      position: { line: 1, column: elseStart },
      executionCount: 1,
    }),
    true,
  );
  assert.equal(
    executionCursorCoverageIsConsistent({
      activeRanges: [range(thenStart, thenStart + 1)],
      activationInactiveRanges: recursiveActivation,
      position: { line: 1, column: thenStart },
      executionCount: 1,
    }),
    false,
  );

  const baseActivation = executionActivationInactiveRanges({
    source,
    call: activation(sites[2]),
    sites,
  });
  assert.equal(contains(baseActivation, thenStart), false);
  assert.equal(contains(baseActivation, source.indexOf("else")), true);
  assert.equal(contains(baseActivation, elseStart), true);
});

test("keeps executed float operators and optimized primitive callees live", () => {
  const source = "total /. float_of_int (List.length values)";
  const range = (startColumn, endColumn) => ({
    startLine: 1,
    startColumn,
    endLine: 1,
    endColumn,
  });
  const operatorStart = source.indexOf("/.");
  const calleeStart = source.indexOf("float_of_int");
  const argumentStart = source.indexOf("List.length");
  const sites = [
    { id: "division", kind: "expression", ghost: false, ...range(0, source.length) },
    { id: "total", parentId: "division", kind: "expression", ghost: false, ...range(0, 5) },
    { id: "operator", parentId: "division", kind: "expression", ghost: false, ...range(operatorStart, operatorStart + 2) },
    { id: "conversion", parentId: "division", kind: "expression", ghost: false, ...range(calleeStart, source.length) },
    { id: "callee", parentId: "conversion", kind: "expression", ghost: false, ...range(calleeStart, calleeStart + "float_of_int".length) },
    { id: "length", parentId: "conversion", kind: "expression", ghost: false, ...range(argumentStart, source.length - 1) },
  ];
  const event = (site, sequence) => ({
    path: "floats.ml.md",
    line: site.startLine,
    column: site.startColumn,
    endLine: site.endLine,
    endColumn: site.endColumn,
    phase: "enter",
    sequence,
  });
  // The bytecode compiler emits calls for the applications, but primitives
  // need not emit separate events for their operator or callee value.
  const events = [event(sites[0], 0), event(sites[3], 1), event(sites[5], 2)];
  const activeRanges = executionActiveRanges({
    source,
    call: {
      kind: "root",
      path: "floats.ml.md",
      ownOccurrences: events,
    },
    sites,
  });
  const inactiveRanges = executionNeverRunRanges({
    source,
    path: "floats.ml.md",
    events,
    sites,
  });
  const covered = (ranges, column) =>
    ranges.some((candidate) =>
      executionRangeContainsPosition(candidate, { line: 1, column }),
    );

  assert.equal(covered(activeRanges, operatorStart), true);
  assert.equal(covered(activeRanges, calleeStart), true);
  assert.equal(covered(inactiveRanges, operatorStart), false);
  assert.equal(covered(inactiveRanges, calleeStart), false);
});

test("every cursor position with executions belongs to a visible highlight", () => {
  const activeRanges = [
    { startLine: 2, startColumn: 4, endLine: 2, endColumn: 7 },
    { startLine: 2, startColumn: 10, endLine: 2, endColumn: 18 },
  ];
  const cases = [
    { position: { line: 2, column: 5 }, executionCount: 3 },
    { position: { line: 2, column: 12 }, executionCount: 1 },
    { position: { line: 2, column: 8 }, executionCount: 0 },
  ];
  for (const check of cases) {
    assert.equal(
      executionHighlightIsConsistent({ activeRanges, ...check }),
      true,
    );
  }

  const selectedConstruct = {
    path: "demo.ml.md",
    line: 2,
    column: 0,
    endColumn: 4,
  };
  const cursorOnIntroducer = { path: "demo.ml.md", line: 2, column: 2 };
  const focusRange = executionFocusRangeAtPosition(
    selectedConstruct,
    cursorOnIntroducer,
    1,
  );
  const focusedRanges = executionRangesWithFocus(
    activeRanges,
    focusRange,
    cursorOnIntroducer,
    1,
  );
  assert.equal(
    executionHighlightIsConsistent({
      activeRanges: focusedRanges,
      position: cursorOnIntroducer,
      executionCount: 1,
    }),
    true,
  );
  assert.equal(
    executionFocusRangeAtPosition(
      selectedConstruct,
      { ...cursorOnIntroducer, column: 8 },
      1,
    ),
    null,
  );
  assert.deepEqual(
    executionRangesWithFocus(
      activeRanges,
      selectedConstruct,
      cursorOnIntroducer,
      0,
    ),
    activeRanges,
  );
  assert.equal(
    executionHighlightIsConsistent({
      activeRanges: [],
      position: { line: 9, column: 3 },
      executionCount: 1,
    }),
    false,
  );
});

test("matched pattern alternatives highlight exactly where the cursor is", () => {
  const sourceLines = [
    "match x with",
    "| Zero | One | Two | Four -> \"small\"",
    "| Other _ -> \"large\"",
  ];
  const source = sourceLines.join("\n");
  const range = (startLine, startColumn, endLine, endColumn) => ({
    startLine,
    startColumn,
    endLine,
    endColumn,
  });
  const smallStart = sourceLines[1].indexOf('"small"');
  const largeStart = sourceLines[2].indexOf('"large"');
  const small = range(2, smallStart, 2, smallStart + 7);
  const large = range(3, largeStart, 3, largeStart + 7);
  const alternatives = ["Zero", "One", "Two", "Four"].map((name, index) => {
    const column = sourceLines[1].indexOf(name);
    return {
      id: `small-${index}`,
      kind: "pattern",
      ghost: false,
      ...range(2, column, 2, column + name.length),
      target: small,
      direct: true,
    };
  });
  const fallbackStart = sourceLines[2].indexOf("Other");
  const fallback = {
    id: "fallback",
    kind: "pattern",
    ghost: false,
    ...range(3, fallbackStart, 3, fallbackStart + "Other _".length),
    target: large,
  };
  const sites = [
    {
      id: "match",
      kind: "expression",
      ghost: false,
      ...range(1, 0, 3, 14),
    },
    {
      id: "small-body",
      parentId: "match",
      kind: "expression",
      ghost: false,
      ...small,
    },
    {
      id: "large-body",
      parentId: "match",
      kind: "expression",
      ghost: false,
      ...large,
    },
    ...alternatives,
    fallback,
  ];
  const event = (siteRange, sequence) => ({
    path: "patterns.ml.md",
    line: siteRange.startLine,
    column: siteRange.startColumn,
    endLine: siteRange.endLine,
    endColumn: siteRange.endColumn,
    phase: "enter",
    sequence,
  });
  const matchedAlternatives = alternatives.slice(0, 3).map((alternative) =>
    sites.find((site) => site.id === alternative.id),
  );
  const events = [
    event(sites[0], 0),
    event(small, 1),
    ...matchedAlternatives.map((alternative, index) =>
      event(alternative, index + 2),
    ),
  ];
  const inactiveRanges = executionNeverRunRanges({
    source,
    path: "patterns.ml.md",
    events,
    sites,
  });
  const isInactive = (position) =>
    inactiveRanges.some((range) =>
      executionRangeContainsPosition(range, position),
    );

  for (const alternative of matchedAlternatives) {
    for (
      let column = alternative.startColumn;
      column < alternative.endColumn;
      column += 1
    ) {
      const position = {
        path: "patterns.ml.md",
        line: alternative.startLine,
        column,
      };
      const selected = executionSiteAt(sites, position, {
        line: sourceLines[position.line - 1],
      });
      const target = executionTimelineCursorTarget(events, position, selected);
      assert.equal(target.indices.length, 1);
      assert.equal(isInactive(position), false);
      const focusRange = {
        path: position.path,
        line: target.focus.line,
        column: target.focus.column,
        endColumn: target.focus.endColumn,
      };
      const activeRanges = executionRangesWithFocus(
        executionActiveRanges({
          source,
          call: {
            kind: "root",
            path: position.path,
            ownOccurrences: [events[target.indices[0]]],
          },
          sites,
        }),
        focusRange,
        position,
        target.indices.length,
      );
      assert.equal(
        executionCursorCoverageIsConsistent({
          activeRanges,
          inactiveRanges,
          position,
          executionCount: target.indices.length,
        }),
        true,
      );
    }
  }

  const unmatchedAlternative = sites.find((site) => site.id === "small-3");
  const unmatchedPosition = {
    path: "patterns.ml.md",
    line: unmatchedAlternative.startLine,
    column: unmatchedAlternative.startColumn,
  };
  const unmatchedSelected = executionSiteAt(sites, unmatchedPosition, {
    line: sourceLines[unmatchedPosition.line - 1],
  });
  const unmatchedTarget = executionTimelineCursorTarget(
    events,
    unmatchedPosition,
    unmatchedSelected,
  );
  assert.equal(unmatchedSelected.direct, true);
  assert.deepEqual(unmatchedTarget.indices, []);
  assert.equal(isInactive(unmatchedPosition), true);

  const fallbackPosition = {
    path: "patterns.ml.md",
    line: fallback.startLine,
    column: fallback.startColumn,
  };
  const fallbackSelected = executionSiteAt(sites, fallbackPosition, {
    line: sourceLines[fallbackPosition.line - 1],
  });
  const fallbackTarget = executionTimelineCursorTarget(
    events,
    fallbackPosition,
    fallbackSelected,
  );
  assert.deepEqual(fallbackTarget.indices, []);
  assert.equal(isInactive(fallbackPosition), true);
  assert.equal(
    isInactive({
      path: "patterns.ml.md",
      line: fallback.startLine,
      column: sourceLines[2].indexOf("|"),
    }),
    true,
  );
  assert.equal(
    isInactive({
      path: "patterns.ml.md",
      line: fallback.startLine,
      column: sourceLines[2].indexOf("->"),
    }),
    true,
  );
  assert.equal(
    executionCursorCoverageIsConsistent({
      activeRanges: [],
      inactiveRanges,
      position: fallbackPosition,
      executionCount: 0,
    }),
    true,
  );
});
