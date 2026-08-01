export function executionSnapshotKey(snapshot) {
  return snapshot
    ? JSON.stringify([
        snapshot.projectVersion,
        snapshot.path,
        snapshot.source,
      ])
    : null;
}

export function executionSnapshotMatches(debuggerState, snapshot) {
  return Boolean(
    debuggerState &&
      !debuggerState.stale &&
      snapshot &&
      debuggerState.path === snapshot.path &&
      debuggerState.source === snapshot.source &&
      debuggerState.projectVersion === snapshot.projectVersion,
  );
}

export function executionCallLinkAt(links, line, column) {
  return (
    links?.find(
      (link) =>
        link.line === line &&
        column >= link.column &&
        column <= link.endColumn,
    )?.callId || null
  );
}

export function executionIdentifierRange(
  line,
  name,
  preferredColumn = 0,
) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matches = [
    ...line.matchAll(new RegExp(`\\b${escaped}\\b`, "g")),
  ];
  if (!matches.length) return null;
  const preceding = matches.filter(
    (candidate) => (candidate.index || 0) <= preferredColumn,
  );
  const match = preceding.at(-1) || matches[0];
  return {
    column: match.index,
    endColumn: match.index + name.length,
  };
}

export function executionTraceIdentifierRange(
  line,
  name,
  column,
  endColumn,
) {
  if (
    Number.isFinite(column) &&
    Number.isFinite(endColumn) &&
    endColumn > column &&
    line.slice(column, endColumn) === name
  ) {
    return { column, endColumn };
  }
  return executionIdentifierRange(line, name, column || 0);
}

export function executionFunctionSourceRange(source, call) {
  const lines = source.split("\n");
  const start = Math.min(Math.max(call.line || 1, 1), lines.length);
  if (
    (call.label === "fun" || call.label === "function") &&
    Number.isFinite(call.column) &&
    Number.isFinite(call.endLine) &&
    Number.isFinite(call.endColumn) &&
    call.endLine >= start
  ) {
    return {
      start,
      end: Math.min(Math.max(call.endLine, start), lines.length),
      startColumn: call.column,
      endColumn: call.endColumn,
    };
  }

  const definition = lines[start - 1] || "";
  const definitionIndent = definition.match(/^ */)?.[0].length || 0;
  let blockEnd = lines.length;
  for (let number = start + 1; number <= lines.length; number += 1) {
    const text = lines[number - 1];
    if (
      definition.startsWith("    ") &&
      text.trim() &&
      !text.startsWith("    ")
    ) {
      blockEnd = number - 1;
      break;
    }
    if (/^```/.test(text.trim())) {
      blockEnd = number - 1;
      break;
    }
  }
  let end = blockEnd;
  for (let number = start + 1; number <= blockEnd; number += 1) {
    const text = lines[number - 1];
    if (!text.trim()) continue;
    const indent = text.match(/^ */)?.[0].length || 0;
    const content = text.trimStart();
    if (
      indent <= definitionIndent &&
      /^(?:let|and|type|module|exception|class|external)\b/.test(content)
    ) {
      end = number - 1;
      break;
    }
  }
  while (end > start && !(lines[end - 1] || "").trim()) end -= 1;
  return { start, end };
}

export function executionCallerFrame(frames, parent) {
  if (!parent) return null;
  return (
    frames?.find(
      (frame, index) =>
        index > 0 &&
        frame.path === parent.path &&
        (!parent.range ||
          (frame.line >= parent.range.start &&
            frame.line <= parent.range.end)),
    ) || null
  );
}

export function executionStructuralLines(
  lines,
  executedLines,
  { start = 1, end = lines.length } = {},
) {
  const structural = new Set();
  for (
    let line = Math.max(1, start);
    line <= Math.min(end, lines.length);
    line += 1
  ) {
    if (!/^in(?:\s|$)/.test((lines[line - 1] || "").trim())) continue;
    let continuation = line + 1;
    while (
      continuation <= end &&
      !(lines[continuation - 1] || "").trim()
    ) {
      continuation += 1;
    }
    if (executedLines.has(continuation)) structural.add(line);
  }
  return structural;
}

function lineStarts(source) {
  const starts = [0];
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === "\n") starts.push(index + 1);
  }
  return starts;
}

function positionOffset(starts, sourceLength, line, column) {
  const lineIndex = Math.min(
    Math.max((Number(line) || 1) - 1, 0),
    starts.length - 1,
  );
  const lineStart = starts[lineIndex];
  const lineEnd =
    lineIndex + 1 < starts.length
      ? starts[lineIndex + 1] - 1
      : sourceLength;
  return Math.min(lineStart + Math.max(Number(column) || 0, 0), lineEnd);
}

function sourceInterval(starts, sourceLength, range) {
  if (!range || !Number.isFinite(range.startLine)) return null;
  const start = positionOffset(
    starts,
    sourceLength,
    range.startLine,
    range.startColumn,
  );
  const end = positionOffset(
    starts,
    sourceLength,
    range.endLine ?? range.startLine,
    range.endColumn ?? range.startColumn,
  );
  return end > start ? { start, end } : null;
}

function eventRange(event) {
  if (!event || !Number.isFinite(event.line)) return null;
  return {
    startLine: event.line,
    startColumn: event.column || 0,
    endLine: event.endLine || event.line,
    endColumn: event.endColumn ?? event.column ?? 0,
  };
}

function callOccurrences(call) {
  return [
    ...(call?.kind === "function" ? [call] : []),
    ...(call?.ownOccurrences || []),
  ].filter((occurrence) => occurrence.path === call.path);
}

function rangeKey(range) {
  return range
    ? [
        range.startLine,
        range.startColumn,
        range.endLine,
        range.endColumn,
      ].join(":")
    : "";
}

function isOperatorRange(source, starts, range) {
  const interval = sourceInterval(starts, source.length, range);
  if (!interval || range.startLine !== range.endLine) return false;
  const text = source.slice(interval.start, interval.end).trim();
  return /^(?:[+\-*/=<>:@^|&!?~.]+|\b(?:mod|land|lor|lxor|lsl|lsr|asr)\b)$/u.test(
    text,
  );
}

function isApplicationHeadRange(source, starts, parent, child) {
  if (
    !parent ||
    !child ||
    parent.startLine !== child.startLine ||
    parent.startColumn !== child.startColumn ||
    child.startLine !== child.endLine ||
    (parent.startLine === parent.endLine &&
      parent.endColumn <= child.endColumn)
  ) {
    return false;
  }
  const interval = sourceInterval(starts, source.length, child);
  if (!interval) return false;
  const text = source.slice(interval.start, interval.end).trim();
  return /^(?:(?:[A-Z][\p{L}\p{N}_']*)\.)*(?:[a-z_][\p{L}\p{N}_']*|\([+\-*/=<>:@^|&!?~.]+\))$/u.test(
    text,
  );
}

function subtractIntervals(interval, subtractions) {
  let fragments = [interval];
  for (const subtraction of subtractions) {
    const next = [];
    for (const fragment of fragments) {
      if (
        subtraction.end <= fragment.start ||
        subtraction.start >= fragment.end
      ) {
        next.push(fragment);
        continue;
      }
      if (subtraction.start > fragment.start) {
        next.push({ start: fragment.start, end: subtraction.start });
      }
      if (subtraction.end < fragment.end) {
        next.push({ start: subtraction.end, end: fragment.end });
      }
    }
    fragments = next;
  }
  return fragments;
}

function mergeIntervals(intervals) {
  const sorted = intervals
    .filter((interval) => interval.end > interval.start)
    .sort(
      (left, right) => left.start - right.start || left.end - right.end,
    );
  const merged = [];
  for (const interval of sorted) {
    const previous = merged.at(-1);
    if (previous && interval.start < previous.end) {
      previous.end = Math.max(previous.end, interval.end);
    } else {
      merged.push({ ...interval });
    }
  }
  return merged;
}

function visibleLineIntervals(source, starts, interval) {
  const visible = [];
  for (let lineIndex = 0; lineIndex < starts.length; lineIndex += 1) {
    const lineStart = starts[lineIndex];
    const lineEnd =
      lineIndex + 1 < starts.length
        ? starts[lineIndex + 1] - 1
        : source.length;
    if (lineEnd <= interval.start || lineStart >= interval.end) continue;
    let start = Math.max(interval.start, lineStart);
    let end = Math.min(interval.end, lineEnd);
    while (start < end && /\s/u.test(source[start])) start += 1;
    while (end > start && /\s/u.test(source[end - 1])) end -= 1;
    if (end > start) visible.push({ start, end, lineIndex });
  }
  return visible;
}

function inactiveExpressionInterval(source, starts, sourceLength, site) {
  const interval = sourceInterval(starts, sourceLength, site);
  if (!interval) return null;
  const lineIndex = Math.max(0, site.startLine - 1);
  const lineStart = starts[lineIndex] || 0;
  const prefix = source.slice(lineStart, interval.start);
  const introducer = [...prefix.matchAll(/\b(?:then|else)\s*$/gu)].at(-1);
  if (introducer) {
    return { start: lineStart + introducer.index, end: interval.end };
  }
  if (lineIndex > 0) {
    const previousStart = starts[lineIndex - 1];
    const previousEnd = lineStart - 1;
    const previous = source.slice(previousStart, previousEnd);
    const standalone = previous.match(/^(\s*)(?:then|else)\s*$/u);
    if (standalone) {
      return {
        start: previousStart + standalone[1].length,
        end: interval.end,
      };
    }
  }
  return interval;
}

function inactivePatternInterval(
  source,
  starts,
  sourceLength,
  site,
  isCovered,
) {
  const interval = sourceInterval(starts, sourceLength, site);
  if (!interval || !site.target || isCovered(site.target)) return interval;
  const target = sourceInterval(starts, sourceLength, site.target);
  if (!target) return interval;
  const lineStart = starts[Math.max(0, site.startLine - 1)] || 0;
  const prefix = source.slice(lineStart, interval.start);
  const branchStart = prefix.lastIndexOf("|");
  return {
    start: branchStart >= 0 ? lineStart + branchStart : interval.start,
    end: Math.max(interval.end, target.end),
  };
}

/**
 * Returns non-overlapping, single-line source spans for syntax that executed
 * in one invocation. A parent expression contributes only its own syntax;
 * child spans are subtracted whether or not those children ran, and executed
 * children contribute their spans independently.
 */
export function executionActiveRanges({
  source,
  call,
  sites = [],
  additionalRanges = [],
}) {
  if (!call || typeof source !== "string") return [];
  const starts = lineStarts(source);
  const sourceLength = source.length;
  const sitesByRange = new Map();
  const childrenByParent = new Map();
  for (const site of sites) {
    const key = rangeKey(site);
    if (!sitesByRange.has(key)) sitesByRange.set(key, []);
    sitesByRange.get(key).push(site);
    if (site.parentId) {
      if (!childrenByParent.has(site.parentId)) {
        childrenByParent.set(site.parentId, []);
      }
      childrenByParent.get(site.parentId).push(site);
    }
  }

  const occurrences = callOccurrences(call);
  const intervals = [];
  for (const occurrence of occurrences) {
    const range = eventRange(occurrence);
    const interval = sourceInterval(starts, sourceLength, range);
    if (!interval) continue;
    const matchingSites = sitesByRange.get(rangeKey(range)) || [];
    if (!matchingSites.length) {
      // Multi-line fallbacks can include an untaken branch. Exact single-line
      // event spans are safe even while the compiler site index is loading.
      if (range.startLine === range.endLine) intervals.push(interval);
      continue;
    }
    for (const site of matchingSites) {
      const children = (childrenByParent.get(site.id) || [])
        .filter(
          (child) =>
            !isOperatorRange(source, starts, child) &&
            !isApplicationHeadRange(source, starts, site, child),
        )
        .map((child) => sourceInterval(starts, sourceLength, child))
        .filter(Boolean);
      intervals.push(...subtractIntervals(interval, children));
    }
  }
  for (const range of additionalRanges) {
    const interval = sourceInterval(starts, sourceLength, range);
    if (interval) intervals.push(interval);
  }

  return mergeIntervals(intervals)
    .flatMap((interval) => visibleLineIntervals(source, starts, interval))
    .map(({ start, end, lineIndex }) => ({
      startLine: lineIndex + 1,
      startColumn: start - starts[lineIndex],
      endLine: lineIndex + 1,
      endColumn: end - starts[lineIndex],
    }));
}

function executionInactiveSiteRanges({
  source,
  sites = [],
  activeKeys,
  activeRanges,
  scope = null,
  excludeRanges = [],
}) {
  const starts = lineStarts(source);
  const sourceLength = source.length;
  const activeIntervals = activeRanges
    .map((range) => sourceInterval(starts, sourceLength, range))
    .filter(Boolean);
  const isCovered = (range) =>
    activeKeys.has(rangeKey(range)) ||
    (() => {
      const interval = sourceInterval(starts, sourceLength, range);
      return Boolean(
        interval &&
          activeIntervals.some(
            (active) =>
              active.start < interval.end && active.end > interval.start,
          ),
      );
    })();
  const sitesById = new Map(sites.map((site) => [site.id, site]));
  const scopedSites = scope
    ? sites.filter(
        (site) =>
          site.startLine >= scope.start && site.endLine <= scope.end,
      )
    : sites;
  const scopedIds = new Set(scopedSites.map((site) => site.id));
  const inactiveRoots = scopedSites.filter((site) => {
    if (
      site.kind !== "expression" ||
      site.ghost ||
      isCovered(site)
    ) {
      return false;
    }
    let ancestor = site.parentId ? sitesById.get(site.parentId) : null;
    while (ancestor && scopedIds.has(ancestor.id)) {
      if (isCovered(ancestor)) {
        break;
      }
      if (ancestor.kind === "expression" && !ancestor.ghost) {
        return false;
      }
      ancestor = ancestor.parentId
        ? sitesById.get(ancestor.parentId)
        : null;
    }
    return true;
  });
  const unexecutedPatterns = scopedSites.filter(
    (site) =>
      site.kind === "pattern" &&
      (site.direct
        ? !activeKeys.has(rangeKey(site))
        : site.target && !isCovered(site.target)),
  );
  const intervals = [
    ...inactiveRoots.map((site) =>
      inactiveExpressionInterval(source, starts, sourceLength, site)
    ),
    ...unexecutedPatterns.map((site) =>
      inactivePatternInterval(
        source,
        starts,
        sourceLength,
        site,
        isCovered,
      )
    ),
  ].filter(Boolean);
  const excludedIntervals = excludeRanges
    .map((range) => sourceInterval(starts, sourceLength, range))
    .filter(Boolean);
  return mergeIntervals(
    mergeIntervals(intervals).flatMap((interval) =>
      subtractIntervals(interval, excludedIntervals)
    ),
  )
    .flatMap((interval) => visibleLineIntervals(source, starts, interval))
    .map(({ start, end, lineIndex }) => ({
      startLine: lineIndex + 1,
      startColumn: start - starts[lineIndex],
      endLine: lineIndex + 1,
      endColumn: end - starts[lineIndex],
    }));
}

/** Returns maximal source spans that no event reached in the entire run. */
export function executionNeverRunRanges({
  source,
  path,
  events = [],
  sites = [],
}) {
  if (typeof source !== "string") return [];
  const activeEvents = events.filter(
    (event) =>
      event.path === path &&
      (event.phase === "enter" || event.phase === "parameter"),
  );
  const activeKeys = new Set(
    activeEvents.map((event) => rangeKey(eventRange(event))),
  );
  const activeRanges = executionActiveRanges({
    source,
    call: {
      kind: "root",
      path,
      ownOccurrences: activeEvents,
    },
    sites,
  });
  return executionInactiveSiteRanges({
    source,
    sites,
    activeKeys,
    activeRanges,
  });
}

/** Returns source spans not reached by one selected function invocation. */
export function executionActivationInactiveRanges({
  source,
  call,
  sites = [],
  excludeRanges = [],
}) {
  if (
    typeof source !== "string" ||
    call?.kind !== "function" ||
    !Number.isFinite(call.range?.start) ||
    !Number.isFinite(call.range?.end)
  ) {
    return [];
  }
  const occurrences = callOccurrences(call);
  const activeKeys = new Set(
    occurrences.map((occurrence) => rangeKey(eventRange(occurrence))),
  );
  const activeRanges = executionActiveRanges({ source, call, sites });
  return executionInactiveSiteRanges({
    source,
    sites,
    activeKeys,
    activeRanges,
    scope: call.range,
    excludeRanges,
  });
}

export function executionRangeContainsPosition(range, position) {
  if (!range || !position) return false;
  const startLine = range.startLine ?? range.line;
  const endLine = range.endLine ?? range.line;
  const startColumn = range.startColumn ?? range.column;
  const endColumn = range.endColumn;
  if (startLine !== position.line || endLine !== position.line) return false;
  return (
    position.column >= startColumn && position.column < endColumn
  );
}

export function executionFocusRangeAtPosition(
  focusRange,
  position,
  executionCount,
) {
  if (!focusRange || !position || executionCount === 0) return null;
  return executionRangeContainsPosition(focusRange, position)
    ? focusRange
    : null;
}

function normalizedVisibleRange(range) {
  if (!range) return null;
  return {
    startLine: range.startLine ?? range.line,
    startColumn: range.startColumn ?? range.column,
    endLine: range.endLine ?? range.line,
    endColumn: range.endColumn,
  };
}

export function executionRangesWithFocus(
  activeRanges,
  focusRange,
  position,
  executionCount,
) {
  const ranges = [...(activeRanges || [])];
  if (executionCount === 0 || !position) return ranges;
  const normalizedFocus = normalizedVisibleRange(focusRange);
  if (normalizedFocus) ranges.push(normalizedFocus);
  return ranges;
}

export function executionHighlightIsConsistent({
  activeRanges = [],
  focusRange = null,
  position,
  executionCount = 0,
}) {
  if (executionCount === 0) return true;
  return [...activeRanges, focusRange]
    .filter(Boolean)
    .some((range) => executionRangeContainsPosition(range, position));
}

/**
 * Checks the complete cursor contract for an executable static position:
 * reached positions are selected precisely, and unreached positions are part
 * of the global never-run projection.
 */
export function executionCursorCoverageIsConsistent({
  activeRanges = [],
  inactiveRanges = [],
  activationInactiveRanges = [],
  position,
  executionCount = 0,
}) {
  if (!position) return true;
  const active = activeRanges.some((range) =>
    executionRangeContainsPosition(range, position),
  );
  const inactive = inactiveRanges.some((range) =>
    executionRangeContainsPosition(range, position),
  );
  const activationInactive = activationInactiveRanges.some((range) =>
    executionRangeContainsPosition(range, position),
  );
  return executionCount > 0
    ? active && !inactive && !activationInactive
    : inactive && !active;
}
