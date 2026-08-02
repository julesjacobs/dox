import { buildExecutionSnapshot } from "./execution-artifact.js";
import { executionDigest } from "./execution-digest.js";
import {
  emptyExecutionSelection,
  navigateActivation,
  resolveCursor,
  selectActivation,
  selectCursor,
  selectOccurrence,
} from "./execution-query.js";
import { activationReconciliationKey, reconcileSelection } from "./execution-reconcile.js";
import {
  buildExecutionView,
  buildExecutionViewFromArtifact,
  executionViewDraft,
  executionViewProjectedSelectors,
  executionViewSnapshot,
  executionViewSources,
} from "./execution-view.js";

const stateStores = new WeakMap();
const emptyEffects = Object.freeze([]);

const sameToken = (left, right) =>
  Boolean(
    left &&
      right &&
      left.generation === right.generation &&
      left.requestCodeDigest === right.requestCodeDigest &&
      left.documentRevisionId === right.documentRevisionId &&
      left.projectDigest === right.projectDigest &&
      left.compilerInputsDigest === right.compilerInputsDigest,
  );

export { executionDigest };

function sourceEntries(sources) {
  const encoder = new TextEncoder();
  const compareBytes = (left, right) => {
    const length = Math.min(left.length, right.length);
    for (let index = 0; index < length; index += 1) {
      if (left[index] !== right[index]) return left[index] - right[index];
    }
    return left.length - right.length;
  };
  return [...sources]
    .map((entry) => ({ entry, pathBytes: encoder.encode(entry[0]) }))
    .sort((left, right) => compareBytes(left.pathBytes, right.pathBytes))
    .map(({ entry }) => entry);
}

function executableFenceInfo(line) {
  const trimmed = line.trim();
  return trimmed.startsWith("```") ? trimmed.slice(3).trim() : null;
}

function genericFenceMarker(line) {
  const match = String(line).match(/^ {0,3}(`{3,}|~{3,})/);
  if (!match) return null;
  return {
    marker: match[1][0],
    length: match[1].length,
    rest: line.slice(match[0].length),
  };
}

function genericFencedLines(lines) {
  const fenced = new Set();
  let opening = null;
  for (let index = 0; index < lines.length; index += 1) {
    const candidate = genericFenceMarker(lines[index]);
    if (!opening) {
      if (candidate) {
        opening = candidate;
        fenced.add(index);
      }
      continue;
    }
    fenced.add(index);
    if (
      candidate?.marker === opening.marker &&
      candidate.length >= opening.length &&
      candidate.rest.trim() === ""
    ) {
      opening = null;
    }
  }
  return fenced;
}

function singleBacktickExpressions(line) {
  const delimiters = [];
  for (let index = 0; index < line.length; ) {
    if (line[index] !== "`") {
      index += 1;
      continue;
    }
    let after = index + 1;
    while (line[after] === "`") after += 1;
    let escapes = 0;
    for (let cursor = index - 1; cursor >= 0 && line[cursor] === "\\"; cursor -= 1) {
      escapes += 1;
    }
    if (after - index === 1 && escapes % 2 === 0) delimiters.push(index);
    index = after;
  }
  const expressions = [];
  for (let index = 0; index + 1 < delimiters.length; index += 2) {
    const opening = delimiters[index];
    const content = line.slice(opening + 1, delimiters[index + 1]).trim();
    if (content.length <= 1 || !content.endsWith("=")) continue;
    const expression = content.slice(0, -1).trim();
    if (expression) expressions.push({ expression, column: opening + 1 });
  }
  return expressions;
}

export function executionExecutableParts(source) {
  source = String(source);
  const lines = source.split("\n");
  if (source.endsWith("\n")) lines.pop();
  const parts = [];
  const codeLines = new Set();
  const inlineFenceLines = genericFencedLines(lines);
  let index = 0;
  let listContext = false;
  while (index < lines.length) {
    const info = executableFenceInfo(lines[index]);
    const executable = info !== null && /^ocaml(?:\s|$)/.test(info);
    const example = info !== null && /^ocaml-example(?:\s|$)/.test(info);
    if (executable || example) {
      const body = [];
      const start = index;
      index += 1;
      while (index < lines.length) {
        if (executableFenceInfo(lines[index]) === "") break;
        if (executable) body.push(lines[index]);
        index += 1;
      }
      const end = Math.min(index, lines.length - 1);
      for (let line = start; line <= end; line += 1) codeLines.add(line);
      if (executable) parts.push({ line: start + 1, column: 0, kind: "block", source: body.join("\n") });
      if (index < lines.length) index += 1;
      listContext = false;
      continue;
    }
    // Unsupported CommonMark fences are prose as a whole.  In particular,
    // code-looking indentation and nested backtick fences inside a tilde fence
    // must not leak into the executable document grammar.
    if (inlineFenceLines.has(index)) {
      do index += 1;
      while (index < lines.length && inlineFenceLines.has(index));
      listContext = false;
      continue;
    }
    if (lines[index].startsWith("    ") && !listContext) {
      const start = index;
      const body = [];
      while (index < lines.length) {
        const line = lines[index];
        if (line.startsWith("    ")) body.push(line.slice(4));
        else if (line.trim() === "") body.push(line);
        else break;
        codeLines.add(index);
        index += 1;
      }
      parts.push({ line: start + 1, column: 0, kind: "block", source: body.join("\n") });
      listContext = false;
      continue;
    }
    const line = lines[index];
    if (line.trim() === "") listContext = false;
    else if (/^ {0,3}(?:[-+*]|\d+[.)])\s+/.test(line)) listContext = true;
    else if (!(listContext && (/^ {4}/.test(line) || /^\t/.test(line)))) {
      listContext = false;
    }
    index += 1;
  }
  lines.forEach((line, lineIndex) => {
    if (codeLines.has(lineIndex) || inlineFenceLines.has(lineIndex)) return;
    for (const { expression, column } of singleBacktickExpressions(line)) {
      parts.push({
        line: lineIndex + 1,
        column,
        kind: "inline",
        source: expression,
      });
    }
  });
  return parts
    .sort((left, right) => left.line - right.line || left.column - right.column)
    .map(({ kind, source: value }) => [kind, value]);
}

function compilerText(source) {
  return JSON.stringify(executionExecutableParts(source));
}

const byteLength = (value) => new TextEncoder().encode(value).length;
const identityField = (value) => `${byteLength(String(value))}:${String(value)}`;

function sourceIdentity(domain, entries) {
  let framed = identityField(domain);
  for (const [path, parts] of entries) {
    framed += identityField(path);
    framed += identityField(String(parts.length));
    for (const [kind, value] of parts) {
      framed += identityField(kind);
      framed += identityField(value);
    }
  }
  return executionDigest(framed);
}

function digestSources(sources, project) {
  return sourceIdentity(
    project ? "dox-executable-source-v1" : "dox-document-source-v1",
    sourceEntries(sources).map(([path, source]) => [
      path,
      project ? executionExecutableParts(source) : [["source", source]],
    ]),
  );
}

export function executionRequestCodeDigest(sources) {
  return digestSources(
    sources instanceof Map ? sources : new Map(Object.entries(sources || {})),
    true,
  );
}

/** The reducer owns document identity; backend version tokens are transport metadata. */
export function executionDocumentRevisionId(sources) {
  return digestSources(
    sources instanceof Map ? sources : new Map(Object.entries(sources || {})),
    false,
  );
}

function readonlyLookup(map) {
  const copy = new Map(map);
  return Object.freeze({
    get: (key) => copy.get(key),
    has: (key) => copy.has(key),
    entries: () => Object.freeze([...copy]),
  });
}

function emptyRecency() {
  return Object.freeze({
    clock: 0,
    viewedAtByActivationId: readonlyLookup([]),
    viewedAtByReconciliationKey: readonlyLookup([]),
  });
}

function recencyMaps(recency) {
  return {
    activations: new Map(recency.viewedAtByActivationId.entries()),
    reconciliation: new Map(recency.viewedAtByReconciliationKey.entries()),
  };
}

function selectionChanged(left, right) {
  return (
    left.selectorId !== right.selectorId ||
    left.constructId !== right.constructId ||
    left.activationId !== right.activationId ||
    left.focusedOccurrenceId !== right.focusedOccurrenceId
  );
}

function noteSelection(state, selection) {
  if (!selection.activationId || !selectionChanged(state.selection, selection)) {
    return state.recency;
  }
  const maps = recencyMaps(state.recency);
  const clock = state.recency.clock + 1;
  maps.activations.set(selection.activationId, clock);
  const snapshot = executionViewSnapshot(state.view);
  if (snapshot) {
    maps.reconciliation.set(
      activationReconciliationKey(snapshot, selection.activationId),
      clock,
    );
  }
  return Object.freeze({
    clock,
    viewedAtByActivationId: readonlyLookup(maps.activations),
    viewedAtByReconciliationKey: readonlyLookup(maps.reconciliation),
  });
}

function publicState(fields, sources) {
  const state = Object.freeze(fields);
  stateStores.set(state, { sources: new Map(sources) });
  return state;
}

function sourcesFor(state) {
  const store = stateStores.get(state);
  if (!store) throw new TypeError("Not an execution state");
  return new Map(store.sources);
}

function withState(state, patch, sources = sourcesFor(state)) {
  return publicState({ ...state, ...patch }, sources);
}

function transitionResult(state, effects, decision, problems = []) {
  return Object.freeze({
    state,
    effects: Object.freeze(effects),
    decision,
    problems: Object.freeze(problems),
  });
}

export function createExecutionState({
  view,
  projectDigest,
  compilerInputsDigest,
  sources = executionViewSources(view),
  requestCodeDigest = executionRequestCodeDigest(sources),
}) {
  return publicState(
    {
      view,
      projectDigest: String(projectDigest),
      compilerInputsDigest: String(compilerInputsDigest),
      requestCodeDigest,
      selection: emptyExecutionSelection(),
      recency: emptyRecency(),
      evaluation: Object.freeze({ kind: "idle" }),
      nextGeneration: 1,
    },
    new Map(sources),
  );
}

export function executionStateSources(state) {
  return sourcesFor(state);
}

function transformedSelectors(view, path, changes) {
  return executionViewProjectedSelectors(view).map((selector) => {
    if (selector.range.path !== path) return selector;
    let delta = 0;
    for (const change of changes) {
      const changeDelta = change.insert.length - (change.to - change.from);
      if (change.to <= selector.range.start) {
        delta += changeDelta;
        continue;
      }
      if (change.from >= selector.range.end) break;
      if (
        (change.from === change.to &&
          change.from > selector.range.start &&
          change.from < selector.range.end) ||
        (change.from < selector.range.end && change.to > selector.range.start)
      ) {
        return { ...selector, valid: false };
      }
    }
    if (!delta) return selector;
    return {
      ...selector,
      range: {
        ...selector.range,
        start: selector.range.start + delta,
        end: selector.range.end + delta,
      },
    };
  });
}

function editedView(state, sources, path, changes, codeChanged) {
  const oldDraft = executionViewDraft(state.view);
  const draftFiles = new Map(oldDraft?.files || []);
  draftFiles.set(path, {
    source: sources.get(path),
    changesFromBase: Object.freeze([
      ...(oldDraft?.files?.get?.(path)?.changesFromBase || []),
      ...changes.map((change) => Object.freeze({ ...change })),
    ]),
    codeChanged,
  });
  const draft = Object.freeze({
    baseDocumentRevisionId: state.view.documentRevisionId,
    baseCodeRevisionId: executionViewSnapshot(state.view)?.codeRevisionId || null,
    requestedCodeDigest: codeChanged ? digestSources(sources, true) : null,
    files: draftFiles,
    invalidConstructIds: Object.freeze([]),
  });
  const projectedSelectors = transformedSelectors(state.view, path, changes);
  return buildExecutionView({
    snapshot: executionViewSnapshot(state.view),
    documentRevisionId: executionDocumentRevisionId(sources),
    sources,
    projectedSelectors,
    runtimeAuthority: codeChanged ? "stale" : state.view.runtimeAuthority,
    draft,
  });
}

function beginRequest(state, sources, requestCodeDigest, projectDigest, compilerInputsDigest) {
  const token = Object.freeze({
    generation: state.nextGeneration,
    requestCodeDigest,
    documentRevisionId: state.view.documentRevisionId,
    projectDigest,
    compilerInputsDigest,
  });
  const effects = [];
  if (state.evaluation.kind === "pending") {
    effects.push(Object.freeze({ kind: "cancel-evaluation", token: state.evaluation.token }));
  }
  effects.push(Object.freeze({ kind: "lookup-artifact", token }));
  return {
    token,
    effects,
    state: withState(
      state,
      {
        requestCodeDigest,
        projectDigest,
        compilerInputsDigest,
        evaluation: Object.freeze({ kind: "pending", token }),
        nextGeneration: state.nextGeneration + 1,
      },
      sources,
    ),
  };
}

function matchingPending(state, token) {
  return state.evaluation.kind === "pending" && sameToken(state.evaluation.token, token);
}

function installArtifact(state, token, envelope) {
  if (!matchingPending(state, token)) {
    return transitionResult(state, emptyEffects, "artifact-discarded-stale-token");
  }
  if (
    envelope.requestCodeDigest !== token.requestCodeDigest ||
    state.view.documentRevisionId !== token.documentRevisionId ||
    envelope.sourceMaps?.documentRevisionId !== token.documentRevisionId ||
    executionDocumentRevisionId(sourcesFor(state)) !== token.documentRevisionId ||
    envelope.projectDigest !== token.projectDigest ||
    envelope.compilerInputsDigest !== token.compilerInputsDigest
  ) {
    return transitionResult(
      state,
      [
        Object.freeze({
          kind: "evaluate",
          token,
          sources: sourceEntries(sourcesFor(state)),
          compilerInputsDigest: state.compilerInputsDigest,
        }),
      ],
      "artifact-discarded-revision-mismatch-retry",
    );
  }
  const built = buildExecutionSnapshot(envelope);
  if (!built.ok) {
    return transitionResult(
      withState(state, {
        evaluation: Object.freeze({
          kind: "failed",
          token,
          diagnostics: Object.freeze(
            built.problems.map((problem) => `${problem.code}: ${problem.detail}`),
          ),
        }),
      }),
      emptyEffects,
      "artifact-validation-failed",
      built.problems,
    );
  }
  let view;
  try {
    view = buildExecutionViewFromArtifact({
      snapshot: built.snapshot,
      envelope,
      sources: sourcesFor(state),
      documentRevisionId: token.documentRevisionId,
    });
  } catch (error) {
    return transitionResult(
      withState(state, {
        evaluation: Object.freeze({
          kind: "failed",
          token,
          diagnostics: Object.freeze([error.message]),
        }),
      }),
      emptyEffects,
      "artifact-source-map-invalid",
      [Object.freeze({ code: "source-map-install-failed", detail: error.message })],
    );
  }
  const reconciled = reconcileSelection(
    state.view,
    view,
    state.selection,
    state.recency,
  );
  return transitionResult(
    withState(state, {
      view,
      selection: reconciled.selection,
      evaluation: Object.freeze({ kind: "idle" }),
    }),
    emptyEffects,
    `artifact-installed:${reconciled.decision}`,
  );
}

export function transition(state, intent) {
  switch (intent.kind) {
    case "cursor-moved": {
      const query = resolveCursor(state.view, intent.position);
      const selection = selectCursor(
        state.view,
        query,
        state.selection,
        state.recency,
      );
      return transitionResult(
        withState(state, {
          selection,
          recency: noteSelection(state, selection),
        }),
        emptyEffects,
        `cursor-${query.status}`,
      );
    }
    case "activation-chosen": {
      if (state.view.runtimeAuthority !== "exact") {
        return transitionResult(state, emptyEffects, "activation-rejected-stale");
      }
      const selected = selectActivation(state.view, state.selection, intent.activationId);
      if (!selected.accepted) {
        return transitionResult(state, emptyEffects, selected.decision);
      }
      return transitionResult(
        withState(state, {
          selection: selected.selection,
          recency: noteSelection(state, selected.selection),
        }),
        emptyEffects,
        selected.decision,
      );
    }
    case "occurrence-chosen":
    case "activation-navigated": {
      if (state.view.runtimeAuthority !== "exact") {
        return transitionResult(state, emptyEffects, "navigation-rejected-stale");
      }
      const selected =
        intent.kind === "occurrence-chosen"
          ? selectOccurrence(state.view, intent.occurrenceId)
          : navigateActivation(state.view, intent.activationId);
      if (!selected.accepted) {
        return transitionResult(state, emptyEffects, selected.decision);
      }
      const effects = selected.moveCursorTo
        ? [
            Object.freeze({
              kind: "move-editor-cursor",
              range: selected.moveCursorTo,
              position: selected.cursorAnchor,
            }),
          ]
        : emptyEffects;
      return transitionResult(
        withState(state, {
          selection: selected.selection,
          recency: noteSelection(state, selected.selection),
        }),
        effects,
        selected.decision,
      );
    }
    case "document-edited": {
      const sources = sourcesFor(state);
      const oldSource = sources.get(intent.path) || "";
      const changes = (intent.changes || [intent.change]).filter(Boolean);
      let previousTo = -1;
      if (!changes.length || changes.some((change) => {
        const invalid =
          !Number.isInteger(change.from) ||
          !Number.isInteger(change.to) ||
          typeof change.insert !== "string" ||
          change.from < 0 ||
          change.to < change.from ||
          change.to > oldSource.length ||
          change.from < previousTo;
        previousTo = change.to;
        return invalid;
      })) {
        return transitionResult(state, emptyEffects, "edit-rejected-range");
      }
      let source = "";
      let cursor = 0;
      for (const change of changes) {
        source += oldSource.slice(cursor, change.from) + change.insert;
        cursor = change.to;
      }
      source += oldSource.slice(cursor);
      if (source !== intent.source) {
        return transitionResult(state, emptyEffects, "edit-rejected-source-mismatch");
      }
      sources.set(intent.path, source);
      const codeChanged = compilerText(oldSource) !== compilerText(source);
      const view = editedView(state, sources, intent.path, changes, codeChanged);
      const projectDigest = intent.projectDigest || state.projectDigest;
      const edited = withState(state, { view, projectDigest }, sources);
      if (!codeChanged) {
        if (state.evaluation.kind === "pending") {
          const request = beginRequest(
            edited,
            sources,
            state.requestCodeDigest,
            projectDigest,
            state.compilerInputsDigest,
          );
          return transitionResult(
            request.state,
            request.effects,
            "document-prose-updated-pending-restarted",
          );
        }
        const needsSourceMapRefresh = executionViewProjectedSelectors(view).some(
          (selector) => selector.valid === false,
        );
        if (needsSourceMapRefresh) {
          const request = beginRequest(
            edited,
            sources,
            state.requestCodeDigest,
            projectDigest,
            state.compilerInputsDigest,
          );
          return transitionResult(
            request.state,
            request.effects,
            "document-source-map-refresh-requested",
          );
        }
        return transitionResult(edited, emptyEffects, "document-prose-updated");
      }
      const requestCodeDigest = digestSources(sources, true);
      const request = beginRequest(
        edited,
        sources,
        requestCodeDigest,
        projectDigest,
        state.compilerInputsDigest,
      );
      return transitionResult(request.state, request.effects, "document-code-updated");
    }
    case "project-replaced": {
      const sources = new Map(intent.sources);
      const view = buildExecutionView({
        snapshot: executionViewSnapshot(state.view),
        documentRevisionId: executionDocumentRevisionId(sources),
        sources,
        projectedSelectors: [],
        runtimeAuthority: executionViewSnapshot(state.view) ? "stale" : "unavailable",
        draft: Object.freeze({ codeChanged: true, files: new Map() }),
      });
      const replaced = withState(state, { view }, sources);
      const request = beginRequest(
        replaced,
        sources,
        digestSources(sources, true),
        intent.projectDigest,
        intent.compilerInputsDigest,
      );
      return transitionResult(request.state, request.effects, "project-replaced");
    }
    case "artifact-available":
      if (!matchingPending(state, intent.token)) {
        return transitionResult(state, emptyEffects, "artifact-cache-discarded-stale-token");
      }
      return intent.artifact
        ? installArtifact(state, intent.token, intent.artifact)
        : transitionResult(
            state,
            [
              Object.freeze({
                kind: "evaluate",
                token: intent.token,
                sources: sourceEntries(sourcesFor(state)),
                compilerInputsDigest: state.compilerInputsDigest,
              }),
            ],
            "artifact-cache-miss",
          );
    case "evaluation-succeeded":
      return installArtifact(state, intent.token, intent.artifact);
    case "evaluation-failed":
      if (!matchingPending(state, intent.token)) {
        return transitionResult(state, emptyEffects, "evaluation-failure-discarded-stale-token");
      }
      return transitionResult(
        withState(state, {
          evaluation: Object.freeze({
            kind: "failed",
            token: intent.token,
            diagnostics: Object.freeze([...intent.diagnostics]),
          }),
        }),
        emptyEffects,
        "evaluation-failed",
      );
    default:
      return transitionResult(state, emptyEffects, "intent-unknown");
  }
}
