import {
  snapshotConstruct,
  snapshotConstructs,
  snapshotExecutionScopes,
  snapshotSelector,
  snapshotSelectors,
} from "./execution-artifact.js";

const viewStores = new WeakMap();

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function compareExecutionViewSelectorPreference(left, right) {
  return (
    left.range.end - left.range.start - (right.range.end - right.range.start) ||
    right.priority - left.priority ||
    left.tieBreakRank - right.tieBreakRank ||
    compareText(left.id, right.id)
  );
}

function lineStarts(source) {
  const starts = [0];
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === "\n") starts.push(index + 1);
  }
  return Object.freeze(starts);
}

function normalizeSources(sources) {
  const entries = sources instanceof Map ? [...sources] : Object.entries(sources || {});
  return new Map(
    entries.map(([path, source]) => [
      String(path),
      String(source).replace(/\r\n?/g, "\n"),
    ]),
  );
}

function compareProjectedSelector(left, right) {
  return (
    left.range.start - right.range.start ||
    left.range.end - right.range.end ||
    compareText(left.id, right.id)
  );
}

const structuralCompletionKinds = new Set([
  "binding",
  "condition",
  "function",
  "loop",
  "match",
  "sequence",
]);

function compareCompletionSelector(left, right) {
  return (
    Number(right.role === "construct") - Number(left.role === "construct") ||
    right.range.end - right.range.start - (left.range.end - left.range.start) ||
    right.priority - left.priority ||
    left.tieBreakRank - right.tieBreakRank ||
    compareText(left.id, right.id)
  );
}

function compareBoundaryCompletionSelector(left, right) {
  return (
    right.priority - left.priority ||
    right.range.end - right.range.start - (left.range.end - left.range.start) ||
    left.tieBreakRank - right.tieBreakRank ||
    compareText(left.id, right.id)
  );
}

function compareFunctionCompletionSelector(left, right) {
  return (
    left.range.end - left.range.start - (right.range.end - right.range.start) ||
    right.priority - left.priority ||
    left.tieBreakRank - right.tieBreakRank ||
    compareText(left.id, right.id)
  );
}

function buildSelectorSurface(selectorsByPath) {
  const result = [];
  for (const [path, selectors] of selectorsByPath) {
    const events = new Map();
    for (const selector of selectors) {
      if (!selector.valid || selector.range.end <= selector.range.start) continue;
      if (!events.has(selector.range.start)) {
        events.set(selector.range.start, { starts: [], ends: [] });
      }
      if (!events.has(selector.range.end)) {
        events.set(selector.range.end, { starts: [], ends: [] });
      }
      events.get(selector.range.start).starts.push(selector);
      events.get(selector.range.end).ends.push(selector);
    }
    const boundaries = [...events.keys()].sort((left, right) => left - right);
    const active = new Set();
    const heap = [];
    const push = (selector) => {
      let index = heap.push(selector) - 1;
      while (index > 0) {
        const parent = Math.floor((index - 1) / 2);
        if (
          compareExecutionViewSelectorPreference(heap[parent], heap[index]) <= 0
        ) {
          break;
        }
        [heap[parent], heap[index]] = [heap[index], heap[parent]];
        index = parent;
      }
    };
    const pop = () => {
      const last = heap.pop();
      if (!heap.length || !last) return;
      heap[0] = last;
      let index = 0;
      while (true) {
        const left = index * 2 + 1;
        const right = left + 1;
        let winner = index;
        if (
          left < heap.length &&
          compareExecutionViewSelectorPreference(heap[left], heap[winner]) < 0
        ) {
          winner = left;
        }
        if (
          right < heap.length &&
          compareExecutionViewSelectorPreference(heap[right], heap[winner]) < 0
        ) {
          winner = right;
        }
        if (winner === index) break;
        [heap[index], heap[winner]] = [heap[winner], heap[index]];
        index = winner;
      }
    };
    for (let index = 0; index + 1 < boundaries.length; index += 1) {
      const start = boundaries[index];
      const end = boundaries[index + 1];
      const event = events.get(start);
      for (const selector of event.ends) active.delete(selector.id);
      for (const selector of event.starts) {
        active.add(selector.id);
        push(selector);
      }
      while (heap.length && !active.has(heap[0].id)) pop();
      const selector = heap[0];
      if (!selector) continue;
      const previous = result[result.length - 1];
      if (
        previous?.selectorId === selector.id &&
        previous.range.path === path &&
        previous.range.end === start
      ) {
        previous.range.end = end;
      } else {
        result.push({
          selectorId: selector.id,
          subjectId: selector.subjectId,
          role: selector.role,
          range: { path, start, end },
        });
      }
    }
  }
  return Object.freeze(
    result.map((item) =>
      Object.freeze({ ...item, range: Object.freeze({ ...item.range }) }),
    ),
  );
}

export function buildExecutionView({
  snapshot = null,
  documentRevisionId,
  sources,
  projectedSelectors = [],
  runtimeAuthority = snapshot ? "exact" : "unavailable",
  draft = null,
}) {
  if (!new Set(["exact", "stale", "unavailable"]).has(runtimeAuthority)) {
    throw new TypeError(`Invalid runtime authority: ${runtimeAuthority}`);
  }
  if (runtimeAuthority === "exact" && !snapshot) {
    throw new TypeError("Exact runtime authority requires a snapshot");
  }
  const sourceByPath = normalizeSources(sources);
  const lineStartsByPath = new Map(
    [...sourceByPath].map(([path, source]) => [path, lineStarts(source)]),
  );
  const selectorsByPath = new Map();
  const selectorById = new Map();
  const selectorsByConstruct = new Map();
  for (const input of projectedSelectors) {
    const selector = Object.freeze({
      id: String(input.id),
      subjectId: String(input.subjectId),
      role: String(input.role),
      priority: Number(input.priority),
      tieBreakRank: Number(input.tieBreakRank || 0),
      range: Object.freeze({
        path: String(input.range.path),
        start: Number(input.range.start),
        end: Number(input.range.end),
      }),
      valid: input.valid !== false,
    });
    if (
      selector.range.start < 0 ||
      selector.range.end < selector.range.start ||
      selector.range.end > (sourceByPath.get(selector.range.path)?.length ?? -1)
    ) {
      throw new RangeError(`Invalid projected selector range: ${selector.id}`);
    }
    if (snapshot && !snapshotSelector(snapshot, selector.id)) {
      throw new TypeError(`Projected selector is absent from snapshot: ${selector.id}`);
    }
    selectorById.set(selector.id, selector);
    if (!selectorsByPath.has(selector.range.path)) {
      selectorsByPath.set(selector.range.path, []);
    }
    selectorsByPath.get(selector.range.path).push(selector);
    if (!selectorsByConstruct.has(selector.subjectId)) {
      selectorsByConstruct.set(selector.subjectId, []);
    }
    selectorsByConstruct.get(selector.subjectId).push(selector);
  }
  const prefixMaxEndByPath = new Map();
  const selectorsByStartByPath = new Map();
  const selectorsByEndByPath = new Map();
  for (const [path, selectors] of selectorsByPath) {
    selectors.sort(compareProjectedSelector);
    const prefix = [];
    let maximum = -1;
    for (const selector of selectors) {
      maximum = Math.max(maximum, selector.range.end);
      prefix.push(maximum);
    }
    selectorsByPath.set(path, Object.freeze(selectors));
    prefixMaxEndByPath.set(path, Object.freeze(prefix));
    const byStart = new Map();
    const byEnd = new Map();
    for (const selector of selectors) {
      if (
        selector.range.end < selector.range.start ||
        (selector.range.end === selector.range.start &&
          selector.role !== "function-context")
      ) continue;
      if (!byEnd.has(selector.range.end)) byEnd.set(selector.range.end, []);
      byEnd.get(selector.range.end).push(selector);
      if (!byStart.has(selector.range.start)) byStart.set(selector.range.start, []);
      byStart.get(selector.range.start).push(selector);
    }
    for (const [offset, starting] of byStart) {
      byStart.set(
        offset,
        Object.freeze(starting.sort(compareExecutionViewSelectorPreference)),
      );
    }
    for (const [offset, ending] of byEnd) {
      byEnd.set(offset, Object.freeze(ending.sort(compareCompletionSelector)));
    }
    selectorsByStartByPath.set(path, byStart);
    selectorsByEndByPath.set(path, byEnd);
  }
  for (const [constructId, selectors] of selectorsByConstruct) {
    selectorsByConstruct.set(
      constructId,
      Object.freeze(
        selectors.sort(compareExecutionViewSelectorPreference),
      ),
    );
  }
  const selectorSurface = buildSelectorSurface(selectorsByPath);
  const functionScopeIdByConstruct = new Map(
    (snapshot ? snapshotExecutionScopes(snapshot) : [])
      .filter((scope) => scope.functionConstructId)
      .map((scope) => [scope.functionConstructId, scope.id]),
  );
  const functionContextEnvelopesByPath = new Map();
  for (const selector of selectorById.values()) {
    if (selector.role !== "function-context") continue;
    const construct = snapshot
      ? snapshotConstruct(snapshot, selector.subjectId)
      : null;
    if (construct?.semanticKind !== "function") continue;
    const owned = selectorsByConstruct.get(selector.subjectId) || [];
    const starts = owned
      .filter((candidate) => candidate.range.path === selector.range.path)
      .map((candidate) => candidate.range.start);
    if (!starts.length) continue;
    const start = Math.min(...starts);
    const source = sourceByPath.get(selector.range.path) || "";
    const startsForPath = lineStartsByPath.get(selector.range.path) || [0];
    let lineIndex = 0;
    while (
      lineIndex + 1 < startsForPath.length &&
      startsForPath[lineIndex + 1] <= start
    ) {
      lineIndex += 1;
    }
    const lineStart = startsForPath[lineIndex];
    const envelopeStart = source.slice(lineStart, start).trim()
      ? start
      : lineStart;
    if (!functionContextEnvelopesByPath.has(selector.range.path)) {
      functionContextEnvelopesByPath.set(selector.range.path, []);
    }
    functionContextEnvelopesByPath.get(selector.range.path).push(
      Object.freeze({
        selector,
        start: envelopeStart,
        end: selector.range.end,
      }),
    );
  }
  for (const [path, envelopes] of functionContextEnvelopesByPath) {
    functionContextEnvelopesByPath.set(
      path,
      Object.freeze(
        envelopes.sort(
          (left, right) =>
            left.end - left.start - (right.end - right.start) ||
            compareFunctionCompletionSelector(left.selector, right.selector),
        ),
      ),
    );
  }
  const childConstructIdsByParent = new Map();
  for (const construct of snapshot ? snapshotConstructs(snapshot) : []) {
    if (!construct.parentId) continue;
    if (!childConstructIdsByParent.has(construct.parentId)) {
      childConstructIdsByParent.set(construct.parentId, []);
    }
    childConstructIdsByParent.get(construct.parentId).push(construct.id);
  }
  const view = Object.freeze({
    documentRevisionId: String(documentRevisionId),
    runtimeAuthority,
    hasSnapshot: Boolean(snapshot),
    hasDraft: Boolean(draft),
  });
  viewStores.set(view, {
    snapshot,
    sourceByPath,
    lineStartsByPath,
    selectorsByPath,
    selectorsByStartByPath,
    selectorsByEndByPath,
    prefixMaxEndByPath,
    selectorById,
    selectorsByConstruct,
    childConstructIdsByParent,
    functionContextEnvelopesByPath,
    functionScopeIdByConstruct,
    selectorSurface,
    draft,
  });
  return view;
}

export function buildExecutionViewFromArtifact({
  snapshot,
  envelope,
  sources,
  documentRevisionId = envelope.sourceMaps.documentRevisionId,
  runtimeAuthority = "exact",
  draft = null,
}) {
  const availablePaths = new Set(
    sources instanceof Map ? sources.keys() : Object.keys(sources || {}),
  );
  const entryBySelectorId = new Map();
  for (const entry of envelope.sourceMaps?.entries || []) {
    entryBySelectorId.set(entry.selectorId, entry);
  }
  const projectedSelectors = [];
  for (const selector of snapshotSelectors(snapshot)) {
    const entry = entryBySelectorId.get(selector.id);
    if (!entry || !availablePaths.has(entry.documentPath)) continue;
    projectedSelectors.push({
      id: selector.id,
      subjectId: selector.subjectId,
      role: selector.role,
      priority: selector.priority,
      tieBreakRank: selector.tieBreakRank,
      range: {
        path: entry.documentPath,
        start: entry.startUtf16,
        end: entry.endUtf16,
      },
      valid: true,
    });
  }
  return buildExecutionView({
    snapshot,
    documentRevisionId,
    sources,
    projectedSelectors,
    runtimeAuthority,
    draft,
  });
}

function storeFor(view) {
  const store = viewStores.get(view);
  if (!store) throw new TypeError("Not an execution view");
  return store;
}

export function executionViewSnapshot(view) {
  return storeFor(view).snapshot;
}

export function executionViewDraft(view) {
  return storeFor(view).draft;
}

export function executionViewSources(view) {
  return new Map(storeFor(view).sourceByPath);
}

export function executionViewProjectedSelectors(view) {
  return Object.freeze(
    [...storeFor(view).selectorById.values()].sort(compareProjectedSelector),
  );
}

export function executionViewSelectorSurface(view) {
  return storeFor(view).selectorSurface;
}

export function executionViewOffset(view, position) {
  const store = storeFor(view);
  const source = store.sourceByPath.get(position.path);
  const starts = store.lineStartsByPath.get(position.path);
  if (source === undefined || !starts || position.line < 1 || position.line > starts.length) {
    return null;
  }
  const start = starts[position.line - 1];
  const end = position.line < starts.length ? starts[position.line] - 1 : source.length;
  if (position.column < 0 || start + position.column > end) return null;
  return start + position.column;
}

export function executionViewSelectorContainsOffset(selector, offset) {
  if (!selector || selector.valid === false || selector.range.start > offset) {
    return false;
  }
  if (offset < selector.range.end) return true;
  return (
    selector.role === "function-context" &&
    selector.range.start === selector.range.end &&
    selector.range.start === offset
  );
}

function selectorAtOffset(store, path, offset) {
  const selectors = store.selectorsByPath.get(path) || [];
  const prefix = store.prefixMaxEndByPath.get(path) || [];
  let low = 0;
  let high = selectors.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (selectors[middle].range.start <= offset) low = middle + 1;
    else high = middle;
  }
  const matches = [];
  for (let index = low - 1; index >= 0; index -= 1) {
    if (prefix[index] < offset) break;
    const selector = selectors[index];
    if (executionViewSelectorContainsOffset(selector, offset)) {
      matches.push(selector);
    }
  }
  matches.sort(compareExecutionViewSelectorPreference);
  return matches[0] || null;
}

function completedSelectorAt(store, path, offset) {
  const ending = store.selectorsByEndByPath.get(path)?.get(offset) || [];
  const promotedApplications = ending
    .filter(
      (selector) => selector.role === "callee" || selector.role === "operator",
    )
    .sort(compareBoundaryCompletionSelector);
  // In a multiline application the callee or operator can complete at this
  // line end while the application itself finishes later.  Preserve the
  // compiler's promoted application selector instead of demoting the boundary
  // to the identifier's `<function>` value.
  if (promotedApplications.length) return promotedApplications[0];
  let concrete = ending.filter((selector) => {
    const construct = store.snapshot
      ? snapshotConstruct(store.snapshot, selector.subjectId)
      : null;
    return (
      selector.role === "construct" &&
      construct?.category === "expression" &&
      !structuralCompletionKinds.has(construct.semanticKind)
    );
  });
  const lexicalFunction = (store.functionContextEnvelopesByPath.get(path) || [])
    .find((context) => context.start <= offset && offset <= context.end);
  const lexicalScopeId = lexicalFunction
    ? store.functionScopeIdByConstruct.get(lexicalFunction.selector.subjectId)
    : null;
  if (lexicalScopeId) {
    concrete = concrete.filter(
      (selector) =>
        snapshotConstruct(store.snapshot, selector.subjectId)?.ownerScopeId ===
        lexicalScopeId,
    );
  }
  if (concrete.length) return [...concrete].sort(compareCompletionSelector)[0];
  const completedFunctions = ending
    .filter((selector) => {
      const construct = store.snapshot
        ? snapshotConstruct(store.snapshot, selector.subjectId)
        : null;
      return (
        selector.role === "construct" &&
        construct?.category === "expression" &&
        construct.semanticKind === "function"
      );
    })
    .sort(compareCompletionSelector);
  // A parenthesized callback may be the completed value on its line.  Its
  // construct owns that boundary; the zero-width function context is only an
  // activation fallback and would discard the callback's value.
  if (completedFunctions.length) return completedFunctions[0];
  const functionContexts = ending
    .filter((selector) => selector.role === "function-context")
    .sort(compareFunctionCompletionSelector);
  return functionContexts[0] || null;
}

function patternBeforeFunctionArrowAt(store, path, source, offset) {
  if (!store.snapshot) return null;
  const containers = (store.selectorsByPath.get(path) || [])
    .filter((selector) => {
      if (
        selector.role !== "construct" ||
        selector.range.start > offset ||
        offset >= selector.range.end
      ) {
        return false;
      }
      const construct = snapshotConstruct(store.snapshot, selector.subjectId);
      return (
        construct?.category === "expression" &&
        construct.semanticKind === "function"
      );
    })
    .sort(compareExecutionViewSelectorPreference);
  for (const container of containers) {
    const children = (store.childConstructIdsByParent.get(container.subjectId) || [])
      .map((constructId) => ({
        construct: snapshotConstruct(store.snapshot, constructId),
        selector: (store.selectorsByConstruct.get(constructId) || [])
          .find((candidate) => candidate.role === "construct") ||
          (store.selectorsByConstruct.get(constructId) || [])[0],
      }))
      .filter(({ selector }) => selector?.range.path === path);
    const bodyStarts = children
      .filter(({ construct }) => construct?.category === "expression")
      .map(({ selector }) => selector.range.start)
      .sort((left, right) => left - right);
    const patterns = children
      .filter(({ construct }) => construct?.category === "pattern")
      .map(({ selector }) => selector)
      .sort(
        (left, right) =>
          right.range.end - left.range.end ||
          compareExecutionViewSelectorPreference(left, right),
      );
    for (const pattern of patterns) {
      const bodyStart = bodyStarts.find((start) => start > pattern.range.end);
      if (bodyStart === undefined) continue;
      const arrowStart = source.lastIndexOf("->", bodyStart);
      if (
        arrowStart < pattern.range.end ||
        arrowStart >= bodyStart ||
        offset < pattern.range.end ||
        offset >= arrowStart + 2
      ) {
        continue;
      }
      // The compiler owns the function, parameter pattern, and body ranges.
      // The only source-level bridge is the punctuation between those parsed
      // constructs.  Keeping that bridge on the pattern prevents a type
      // constraint, closing delimiter, or arrow from exposing the callback's
      // return value before the cursor has entered its body.
      return pattern;
    }
  }
  return null;
}

function boundaryCompletionSelectorAt(store, path, offset) {
  const ending = store.selectorsByEndByPath.get(path)?.get(offset) || [];
  const leftVisible = offset > 0 ? selectorAtOffset(store, path, offset - 1) : null;
  const patterns = ending.filter((selector) => {
    const construct = store.snapshot
      ? snapshotConstruct(store.snapshot, selector.subjectId)
      : null;
    return construct?.category === "pattern";
  });
  const leftConstruct = leftVisible && store.snapshot
    ? snapshotConstruct(store.snapshot, leftVisible.subjectId)
    : null;
  if (
    leftVisible?.range.end === offset &&
    (leftConstruct?.category === "pattern" ||
      patterns.some(
        (pattern) =>
          pattern.range.start === leftVisible.range.start &&
          pattern.range.end === leftVisible.range.end,
      ))
  ) {
    return leftVisible;
  }
  // At a boundary before `->`, the exact subpattern that just completed owns
  // the cursor.  Choosing a larger or-pattern would admit activations that
  // matched a sibling alternative and would make its path evidence false.
  if (patterns.length) {
    return [...patterns].sort(compareExecutionViewSelectorPreference)[0];
  }
  return [...ending].sort(compareBoundaryCompletionSelector)[0] || null;
}

function whitespaceTransitionSelectorAt(
  store,
  path,
  source,
  lineStart,
  lineEnd,
  offset,
) {
  if (offset < lineStart || offset >= lineEnd || !/[\t ]/.test(source[offset])) {
    return null;
  }
  let runStart = offset;
  let runEnd = offset + 1;
  while (runStart > lineStart && /[\t ]/.test(source[runStart - 1])) runStart -= 1;
  while (runEnd < lineEnd && /[\t ]/.test(source[runEnd])) runEnd += 1;
  const left = store.selectorsByEndByPath.get(path)?.get(runStart) || [];
  const right = store.selectorsByStartByPath.get(path)?.get(runEnd) || [];
  // Whitespace inside a literal or comment has no compiler-owned syntax on
  // both sides.  Leave it to the ordinary containing-selector lookup.
  if (!left.length || !right.length) return null;
  const distanceFromLeft = offset - runStart;
  const distanceFromRight = runEnd - offset;
  return distanceFromLeft <= distanceFromRight
    ? boundaryCompletionSelectorAt(store, path, runStart)
    : right[0] || null;
}

function functionContextAt(store, path, offset) {
  return (
    (store.functionContextEnvelopesByPath.get(path) || []).find(
      (context) => context.start <= offset && offset <= context.end,
    )?.selector || null
  );
}

export function executionViewSelectorAt(view, position) {
  const store = storeFor(view);
  const offset = executionViewOffset(view, position);
  if (offset === null) return null;
  const source = store.sourceByPath.get(position.path);
  const starts = store.lineStartsByPath.get(position.path);
  const lineStart = starts[position.line - 1];
  const lineEnd = position.line < starts.length
    ? starts[position.line] - 1
    : source.length;
  const line = source.slice(lineStart, lineEnd);
  const firstToken = line.search(/\S/);
  if (firstToken >= 0 && position.column < firstToken) {
    return functionContextAt(store, position.path, offset);
  }
  const codeEndColumn = line.trimEnd().length;
  if (
    firstToken >= 0 &&
    codeEndColumn > firstToken &&
    position.column >= codeEndColumn
  ) {
    const completed = completedSelectorAt(
      store,
      position.path,
      lineStart + codeEndColumn,
    );
    if (completed) return completed;
    const boundary = boundaryCompletionSelectorAt(
      store,
      position.path,
      lineStart + codeEndColumn,
    );
    if (boundary) return boundary;
    const spanning = selectorAtOffset(
      store,
      position.path,
      lineStart + codeEndColumn,
    );
    if (spanning) return spanning;
    return functionContextAt(store, position.path, offset);
  }
  const direct = selectorAtOffset(store, position.path, offset);
  const directConstruct = direct && store.snapshot
    ? snapshotConstruct(store.snapshot, direct.subjectId)
    : null;
  // Concrete pattern tokens and compiler-emitted case punctuation always own
  // their exact surfaces.  A source bridge may only fill syntax that the
  // compiler deliberately left between a formal parameter and its body.
  if (
    direct &&
    ((directConstruct?.category === "pattern" &&
      offset < lineEnd &&
      !/[\t ]/.test(source[offset])) ||
      direct.role === "arrow" ||
      direct.role === "alternative")
  ) {
    return direct;
  }
  const whitespace = whitespaceTransitionSelectorAt(
    store,
    position.path,
    source,
    lineStart,
    lineEnd,
    offset,
  );
  if (whitespace) return whitespace;
  const arrowPattern = patternBeforeFunctionArrowAt(
    store,
    position.path,
    source,
    offset,
  );
  return arrowPattern || direct;
}

export function executionViewSelectionRange(view, selector) {
  if (!selector) return null;
  if (selector.role !== "callee" && selector.role !== "operator") {
    return selector.range;
  }
  const store = storeFor(view);
  if (selector.role === "operator") {
    const childRanges = (store.childConstructIdsByParent.get(selector.subjectId) || [])
      .flatMap((constructId) => {
        const construct = (store.selectorsByConstruct.get(constructId) || [])
          .find((candidate) => candidate.role === "construct");
        return construct?.range.path === selector.range.path ? [construct.range] : [];
      });
    if (childRanges.length >= 2) {
      return Object.freeze({
        path: selector.range.path,
        start: Math.min(...childRanges.map((range) => range.start)),
        end: Math.max(...childRanges.map((range) => range.end)),
      });
    }
  }
  const construct = (store.selectorsByConstruct.get(selector.subjectId) || [])
    .find((candidate) => candidate.role === "construct");
  return construct?.range || selector.range;
}

export function executionViewSelectorContainsPosition(view, selector, position) {
  const offset = executionViewOffset(view, position);
  if (offset === null || !selector) return false;
  if (executionViewSelectorContainsOffset(selector, offset)) return true;
  return executionViewSelectorAt(view, position)?.id === selector.id;
}

export function executionViewSelectorForConstruct(view, constructId) {
  return storeFor(view).selectorsByConstruct.get(constructId)?.[0] || null;
}

export function executionViewSelectorsForConstruct(view, constructId) {
  return storeFor(view).selectorsByConstruct.get(constructId) || Object.freeze([]);
}

export function executionViewProjectedSelector(view, selectorId) {
  return storeFor(view).selectorById.get(selectorId) || null;
}

export function executionViewSourceText(view, range) {
  const source = storeFor(view).sourceByPath.get(range?.path);
  if (
    source === undefined ||
    !Number.isInteger(range?.start) ||
    !Number.isInteger(range?.end)
  ) {
    return null;
  }
  return source.slice(range.start, range.end);
}

export function executionViewPositionAtOffset(view, path, offset) {
  const store = storeFor(view);
  const source = store.sourceByPath.get(path);
  const starts = store.lineStartsByPath.get(path);
  if (source === undefined || !starts || offset < 0 || offset > source.length) {
    return null;
  }
  let low = 0;
  let high = starts.length;
  while (low + 1 < high) {
    const middle = (low + high) >> 1;
    if (starts[middle] <= offset) low = middle;
    else high = middle;
  }
  return Object.freeze({ path, line: low + 1, column: offset - starts[low] });
}
