import assert from "node:assert/strict";
import test from "node:test";

import {
  executionCursorProbe,
  executionSiteAt,
  executionSourceTextForSite,
} from "./execution-cursor.js";

test("the frontend preserves the exact editor position", () => {
  assert.deepEqual(executionCursorProbe("      fib (n - 1)", 14), {
    column: 14,
    purpose: "execution",
  });
  assert.deepEqual(executionCursorProbe("let x = 1", 100), {
    column: 9,
    purpose: "execution",
  });
});

test("extracts the exact source for same-line and multiline sites", () => {
  assert.equal(
    executionSourceTextForSite("    fib (n-1) + fib (n-2)", {
      startLine: 1,
      startColumn: 4,
      endLine: 1,
      endColumn: 13,
    }),
    "fib (n-1)",
  );
  assert.equal(
    executionSourceTextForSite("    mean\n      select\n      values", {
      startLine: 1,
      startColumn: 4,
      endLine: 3,
      endColumn: 12,
    }),
    "mean select values",
  );
});

test("compiler selection spans make construct syntax selectable", () => {
  const pattern = {
    id: "binding",
    kind: "pattern",
    startLine: 2,
    startColumn: 8,
    endLine: 2,
    endColumn: 11,
    selection: {
      startLine: 2,
      startColumn: 4,
      endLine: 4,
      endColumn: 12,
    },
  };
  assert.equal(
    executionSiteAt([pattern], {
      path: "demo.ml.md",
      line: 2,
      column: 4,
    }),
    pattern,
  );
});

test("a function parameter selects its invocation", () => {
  const definition = {
    id: "fib",
    parentId: null,
    kind: "pattern",
    startLine: 2,
    startColumn: 12,
    endLine: 2,
    endColumn: 15,
    selection: {
      startLine: 2,
      startColumn: 4,
      endLine: 5,
      endColumn: 20,
    },
  };
  const functionBody = {
    id: "function-body",
    parentId: null,
    kind: "expression",
    ghost: true,
    startLine: 2,
    startColumn: 16,
    endLine: 5,
    endColumn: 20,
  };
  const parameter = {
    id: "n",
    parentId: "function-body",
    kind: "pattern",
    startLine: 2,
    startColumn: 16,
    endLine: 2,
    endColumn: 17,
  };
  assert.equal(
    executionSiteAt(
      [definition, functionBody, parameter],
      { path: "fib.ml.md", line: 2, column: 16 },
    ),
    definition,
  );
});

test("an anonymous-function parameter selects the lambda invocation", () => {
  const lambda = {
    id: "lambda",
    parentId: "fold",
    kind: "expression",
    ghost: false,
    startLine: 3,
    startColumn: 10,
    endLine: 3,
    endColumn: 52,
  };
  const parameter = {
    id: "total",
    parentId: "lambda",
    kind: "pattern",
    startLine: 3,
    startColumn: 15,
    endLine: 3,
    endColumn: 20,
    role: "lambda-parameter",
    target: {
      startLine: 3,
      startColumn: 10,
      endLine: 3,
      endColumn: 52,
    },
  };
  assert.deepEqual(
    executionSiteAt(
      [lambda, parameter],
      { path: "analysis.ml.md", line: 3, column: 17 },
      { line: "          (fun total value -> total +. select value)" },
    ),
    {
      ...parameter.target,
      role: "lambda-parameter",
      focus: {
        startLine: 3,
        startColumn: 15,
        endLine: 3,
        endColumn: 20,
      },
    },
  );
});

test("resolves a cursor locally to the smallest static site", () => {
  const sites = [
    { kind: "expression", startLine: 2, startColumn: 2, endLine: 4, endColumn: 8 },
    { kind: "expression", startLine: 3, startColumn: 7, endLine: 3, endColumn: 8 },
  ];
  assert.deepEqual(
    executionSiteAt(sites, { path: "demo.ml.md", line: 3, column: 7 }),
    sites[1],
  );
});

test("an unexecuted static site remains selected without runtime events", () => {
  const site = {
    kind: "expression",
    startLine: 7,
    startColumn: 12,
    endLine: 7,
    endColumn: 19,
  };
  assert.equal(
    executionSiteAt([site], { path: "demo.ml.md", line: 7, column: 15 }),
    site,
  );
});

test("function identifiers in calls resolve to the enclosing call", () => {
  const identifier = {
    id: "identifier",
    parentId: "call",
    kind: "expression",
    startLine: 8,
    startColumn: 11,
    endLine: 8,
    endColumn: 14,
    role: "callee",
    target: {
      startLine: 8,
      startColumn: 11,
      endLine: 8,
      endColumn: 20,
    },
  };
  const call = {
    id: "call",
    parentId: null,
    kind: "expression",
    startLine: 8,
    startColumn: 11,
    endLine: 8,
    endColumn: 20,
  };
  const selected = executionSiteAt(
    [call, identifier],
    { path: "fib.ml.md", line: 8, column: 12 },
    { line: "           fib (n - 1)" },
  );
  assert.deepEqual(selected, {
    ...identifier.target,
    role: "callee",
    executionFallback: {
      kind: "application",
      range: {
        startLine: 8,
        startColumn: 11,
        endLine: 8,
        endColumn: 14,
      },
    },
  });
});

test("compiler operator roles select the enclosing application", () => {
  const operator = {
    id: "operator",
    kind: "expression",
    startLine: 4,
    startColumn: 4,
    endLine: 4,
    endColumn: 5,
    role: "operator",
    target: {
      startLine: 4,
      startColumn: 2,
      endLine: 4,
      endColumn: 7,
    },
  };
  assert.deepEqual(
    executionSiteAt([operator], {
      path: "demo.ml.md",
      line: 4,
      column: 4,
    }),
    {
      ...operator.target,
      role: "operator",
    },
  );
});

test("compiler control syntax selects the construct it introduces", () => {
  const conditional = {
    id: "conditional",
    kind: "expression",
    startLine: 3,
    startColumn: 4,
    endLine: 5,
    endColumn: 12,
  };
  const elseToken = {
    id: "syntax:else",
    kind: "syntax",
    role: "else",
    startLine: 4,
    startColumn: 4,
    endLine: 4,
    endColumn: 8,
    target: {
      startLine: 5,
      startColumn: 6,
      endLine: 5,
      endColumn: 12,
    },
  };
  assert.deepEqual(
    executionSiteAt([conditional, elseToken], {
      path: "demo.ml.md",
      line: 4,
      column: 5,
    }),
    {
      ...elseToken.target,
      role: "else",
      focus: {
        startLine: 4,
        startColumn: 4,
        endLine: 4,
        endColumn: 8,
      },
    },
  );
});

test("punctuation inside a call inherits its containing expression", () => {
  const call = {
    id: "call",
    kind: "expression",
    startLine: 5,
    startColumn: 8,
    endLine: 5,
    endColumn: 47,
  };
  assert.equal(
    executionSiteAt([call], {
      path: "tree.ml.md",
      line: 5,
      column: 31,
    }),
    call,
  );
});

test("a variable operand remains the variable, independent of runtime values", () => {
  const expression = {
    id: "sum",
    parentId: null,
    kind: "expression",
    startLine: 4,
    startColumn: 2,
    endLine: 4,
    endColumn: 7,
  };
  const left = {
    id: "left",
    parentId: "sum",
    kind: "expression",
    startLine: 4,
    startColumn: 2,
    endLine: 4,
    endColumn: 3,
  };
  const operator = {
    id: "operator",
    parentId: "sum",
    kind: "expression",
    startLine: 4,
    startColumn: 4,
    endLine: 4,
    endColumn: 5,
  };
  assert.equal(
    executionSiteAt(
      [expression, left, operator],
      { path: "demo.ml.md", line: 4, column: 2 },
      { line: "  x + y" },
    ),
    left,
  );
});

test("every nested or-pattern alternative resolves to the case body", () => {
  const target = {
    startLine: 12,
    startColumn: 18,
    endLine: 12,
    endColumn: 20,
  };
  const alternatives = [4, 8, 12].map((startColumn) => ({
    kind: "pattern",
    startLine: 11,
    startColumn,
    endLine: 11,
    endColumn: startColumn + 1,
    target,
  }));
  for (const alternative of alternatives) {
    const selected = executionSiteAt(alternatives, {
      path: "demo.ml.md",
      line: 11,
      column: alternative.startColumn,
    });
    assert.deepEqual(
      {
        startLine: selected.startLine,
        startColumn: selected.startColumn,
        endLine: selected.endLine,
        endColumn: selected.endColumn,
      },
      target,
    );
    assert.deepEqual(selected.focus, {
      startLine: alternative.startLine,
      startColumn: alternative.startColumn,
      endLine: alternative.endLine,
      endColumn: alternative.endColumn,
    });
  }
});

test("compiler-marked leaf or-pattern alternatives select directly", () => {
  const target = {
    startLine: 1,
    startColumn: 23,
    endLine: 1,
    endColumn: 27,
  };
  const patterns = [
    {
      id: "outer",
      kind: "pattern",
      startLine: 1,
      startColumn: 2,
      endLine: 1,
      endColumn: 19,
      target,
    },
    {
      id: "zero",
      kind: "pattern",
      startLine: 1,
      startColumn: 8,
      endLine: 1,
      endColumn: 12,
      target,
      direct: true,
    },
    {
      id: "one",
      kind: "pattern",
      startLine: 1,
      startColumn: 15,
      endLine: 1,
      endColumn: 18,
      target,
      direct: true,
    },
  ];
  for (const id of ["zero", "one"]) {
    const pattern = patterns.find((site) => site.id === id);
    assert.equal(
      executionSiteAt(patterns, {
        path: "demo.ml.md",
        line: 1,
        column: pattern.startColumn,
      }),
      pattern,
    );
  }
});
