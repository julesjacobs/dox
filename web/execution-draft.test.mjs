import assert from "node:assert/strict";
import test from "node:test";
import { ChangeSet, Text } from "@codemirror/state";

import {
  createExecutionDraftMapping,
  executionDraftEventIsInvalidated,
  mapExecutionDraftEvents,
  mapExecutionDraftSites,
  projectExecutionDraftEvents,
} from "./execution-draft.js";

test("maps execution events and compiler sites through a draft edit", () => {
  const previousSource = "let f x =\n  x + 1\n";
  const insertion = "  let y = x in\n";
  const changes = ChangeSet.of(
    { from: previousSource.indexOf("  x + 1"), insert: insertion },
    previousSource.length,
  );
  const source = changes.apply(Text.of(previousSource.split("\n"))).toString();
  const draft = { path: "demo.ml.md", previousSource, source, changes };
  const event = {
    path: draft.path,
    line: 2,
    column: 2,
    endLine: 2,
    endColumn: 7,
  };
  const site = {
    id: "expression:2:2:2:7",
    startLine: 2,
    startColumn: 2,
    endLine: 2,
    endColumn: 7,
    selection: {
      startLine: 2,
      startColumn: 2,
      endLine: 2,
      endColumn: 7,
    },
  };
  assert.deepEqual(mapExecutionDraftEvents([event], draft)[0], {
    ...event,
    line: 3,
    column: 2,
    endLine: 3,
    endColumn: 7,
  });
  assert.deepEqual(mapExecutionDraftSites([site], draft)[0].selection, {
    startLine: 3,
    startColumn: 2,
    endLine: 3,
    endColumn: 7,
  });
});

test("collapses a deleted execution range without producing an invalid span", () => {
  const previousSource = "let answer = 40 + 2";
  const from = previousSource.indexOf("40 + 2");
  const changes = ChangeSet.of(
    { from, to: previousSource.length, insert: "" },
    previousSource.length,
  );
  const source = changes.apply(Text.of(previousSource.split("\n"))).toString();
  const [event] = mapExecutionDraftEvents(
    [
      {
        path: "demo.ml.md",
        line: 1,
        column: from,
        endLine: 1,
        endColumn: previousSource.length,
      },
    ],
    { path: "demo.ml.md", previousSource, source, changes },
  );
  assert.deepEqual(
    [event.line, event.column, event.endLine, event.endColumn],
    [1, from, 1, from],
  );
  assert.equal(event.draftTouched, true);
});

test("marks replaced execution values so a draft cannot show stale data", () => {
  const previousSource = "let answer = 40 + 2";
  const from = previousSource.indexOf("40 + 2");
  const changes = ChangeSet.of(
    { from, to: previousSource.length, insert: "unrelated ()" },
    previousSource.length,
  );
  const source = changes.apply(Text.of(previousSource.split("\n"))).toString();
  const [event] = mapExecutionDraftEvents(
    [
      {
        path: "demo.ml.md",
        kind: "value",
        line: 1,
        column: from,
        endLine: 1,
        endColumn: previousSource.length,
      },
    ],
    { path: "demo.ml.md", previousSource, source, changes },
  );
  assert.equal(event.draftTouched, true);
});

test("invalidates the changed program block, later blocks, and inline results", () => {
  const plan = {
    blocks: [
      { lineStart: 2, lineEnd: 4 },
      { lineStart: 8, lineEnd: 10 },
    ],
    inline: [{ line: 12 }, { line: 14 }],
  };
  const path = "demo.ml.md";
  const invalidation = { blockFrom: 1, inlineFrom: 0 };
  assert.equal(
    executionDraftEventIsInvalidated(
      { path, line: 3 },
      invalidation,
      plan,
      path,
    ),
    false,
  );
  assert.equal(
    executionDraftEventIsInvalidated(
      { path, line: 9 },
      invalidation,
      plan,
      path,
    ),
    true,
  );
  assert.equal(
    executionDraftEventIsInvalidated(
      { path, line: 12 },
      invalidation,
      plan,
      path,
    ),
    true,
  );
});

test("uses original positions when a draft shifts later invalidated blocks", () => {
  const previousSource = [
    "let first = 1",
    "",
    "let later = first + 1",
  ].join("\n");
  const changes = ChangeSet.of(
    { from: previousSource.indexOf("\n"), insert: "\n\n" },
    previousSource.length,
  );
  const source = changes.apply(Text.of(previousSource.split("\n"))).toString();
  const draft = {
    path: "demo.ml.md",
    previousSource,
    source,
    changes,
  };
  const projected = projectExecutionDraftEvents(
    [
      {
        path: draft.path,
        kind: "value",
        phase: "return",
        line: 3,
        column: 4,
        endLine: 3,
        endColumn: 9,
      },
    ],
    draft,
    {
      invalidation: { blockFrom: 0, inlineFrom: 0 },
      plan: {
        blocks: [
          { lineStart: 1, lineEnd: 1 },
          { lineStart: 3, lineEnd: 3 },
        ],
        inline: [],
      },
    },
  );
  assert.deepEqual(projected, []);
});

test("invalidates activations called from an edited later block", () => {
  const previousSource = [
    "let add x y = x + y",
    "",
    "let result = add 1 2",
  ].join("\n");
  const from = previousSource.indexOf("1 2");
  const callStart = previousSource.indexOf("let result");
  const changes = ChangeSet.of(
    [
      { from: callStart, insert: "\n" },
      { from, to: from + 3, insert: "10 20" },
    ],
    previousSource.length,
  );
  const source = changes.apply(Text.of(previousSource.split("\n"))).toString();
  const path = "demo.ml.md";
  const events = [
    {
      path,
      occurrenceId: "call",
      parentId: "binding",
      kind: "call",
      phase: "enter",
      line: 3,
      column: 13,
      endLine: 3,
      endColumn: 20,
    },
    {
      path,
      occurrenceId: "function",
      parentId: "call",
      kind: "function",
      phase: "enter",
      line: 1,
      column: 4,
      endLine: 1,
      endColumn: 7,
    },
    {
      path,
      occurrenceId: "function",
      parentId: "call",
      kind: "parameter",
      phase: "parameter",
      line: 1,
      column: 4,
      endLine: 1,
      endColumn: 7,
      label: "x",
      detail: "1",
    },
    {
      path,
      occurrenceId: "body-value",
      parentId: "function",
      kind: "value",
      phase: "return",
      line: 1,
      column: 14,
      endLine: 1,
      endColumn: 19,
      detail: "3",
    },
    {
      path,
      occurrenceId: "function",
      parentId: "call",
      kind: "function",
      phase: "return",
      line: 1,
      column: 4,
      endLine: 1,
      endColumn: 7,
      detail: "3",
    },
    {
      path,
      occurrenceId: "call",
      parentId: "binding",
      kind: "call",
      phase: "return",
      line: 3,
      column: 13,
      endLine: 3,
      endColumn: 20,
      detail: "3",
    },
  ];
  const projected = projectExecutionDraftEvents(
    events,
    { path, previousSource, source, changes },
    {
      invalidation: { blockFrom: 1, inlineFrom: 0 },
      plan: {
        blocks: [
          { lineStart: 1, lineEnd: 1 },
          { lineStart: 3, lineEnd: 3 },
        ],
        inline: [],
      },
    },
  );
  assert.deepEqual(
    projected.map((event) => [event.occurrenceId, event.kind, event.phase]),
    [["function", "function", "enter"]],
  );

  const deletionFrom = source.indexOf("\n\nlet result");
  const deletion = ChangeSet.of(
    { from: deletionFrom, to: source.length, insert: "" },
    source.length,
  );
  const sourceWithoutCall = deletion
    .apply(Text.of(source.split("\n")))
    .toString();
  const afterDeletion = projectExecutionDraftEvents(
    projected,
    {
      path,
      previousSource: source,
      source: sourceWithoutCall,
      changes: deletion,
    },
    {
      invalidation: { blockFrom: 1, inlineFrom: 0 },
      plan: {
        blocks: [
          { lineStart: 1, lineEnd: 1 },
          { lineStart: 4, lineEnd: 4 },
        ],
        inline: [],
      },
    },
  );
  assert.deepEqual(afterDeletion, []);
});

test("builds source line tables once for each bulk draft projection", () => {
  const previousSource = Array.from(
    { length: 200 },
    (_, index) => `let value_${index} = ${index}`,
  ).join("\n");
  const changes = ChangeSet.of(
    { from: 0, insert: "\n" },
    previousSource.length,
  );
  const source = changes
    .apply(Text.of(previousSource.split("\n")))
    .toString();
  const draft = { path: "demo.ml.md", previousSource, source, changes };
  const events = Array.from({ length: 500 }, (_, index) => ({
    path: draft.path,
    occurrenceId: `event-${index}`,
    kind: "value",
    phase: "return",
    line: (index % 200) + 1,
    column: 0,
    endLine: (index % 200) + 1,
    endColumn: 3,
  }));
  const eventInstrumentation = {};
  const mapping = createExecutionDraftMapping(draft, {
    instrumentation: eventInstrumentation,
  });
  projectExecutionDraftEvents(events, draft, {
    mapping,
  });
  assert.equal(eventInstrumentation.lineTableBuilds, 2);

  const sites = events.map((event, index) => ({
    id: `site-${index}`,
    startLine: event.line,
    startColumn: event.column,
    endLine: event.endLine,
    endColumn: event.endColumn,
  }));
  mapExecutionDraftSites(sites, draft, {
    mapping,
  });
  assert.equal(eventInstrumentation.lineTableBuilds, 2);
});
