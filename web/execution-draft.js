function lineStarts(source) {
  const starts = [0];
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === "\n") starts.push(index + 1);
  }
  return starts;
}

function sourceOffset(starts, sourceLength, line, column) {
  const lineIndex = Math.min(
    Math.max((Number(line) || 1) - 1, 0),
    starts.length - 1,
  );
  const lineStart = starts[lineIndex];
  const lineEnd =
    lineIndex + 1 < starts.length ? starts[lineIndex + 1] - 1 : sourceLength;
  return Math.min(lineStart + Math.max(Number(column) || 0, 0), lineEnd);
}

function sourcePosition(starts, sourceLength, offset) {
  const clamped = Math.min(Math.max(Number(offset) || 0, 0), sourceLength);
  let low = 0;
  let high = starts.length;
  while (low + 1 < high) {
    const middle = (low + high) >> 1;
    if (starts[middle] <= clamped) low = middle;
    else high = middle;
  }
  return { line: low + 1, column: clamped - starts[low] };
}

function draftMapper(draft, instrumentation = null) {
  const { previousSource, source, changes } = draft;
  if (instrumentation) {
    instrumentation.lineTableBuilds =
      (instrumentation.lineTableBuilds || 0) + 2;
  }
  const previousStarts = lineStarts(previousSource);
  const starts = lineStarts(source);
  const mapPosition = (line, column, association) => {
    const previousOffset = sourceOffset(
      previousStarts,
      previousSource.length,
      line,
      column,
    );
    return sourcePosition(
      starts,
      source.length,
      changes.mapPos(previousOffset, association),
    );
  };
  return { mapPosition, previousStarts, starts };
}

export function createExecutionDraftMapping(
  draft,
  { instrumentation = null } = {},
) {
  return draftMapper(draft, instrumentation);
}

function mapRange(range, mapper, fields) {
  if (!range) return range;
  const start = mapper.mapPosition(
    range[fields.startLine],
    range[fields.startColumn],
    1,
  );
  const end = mapper.mapPosition(
    range[fields.endLine] ?? range[fields.startLine],
    range[fields.endColumn] ?? range[fields.startColumn],
    -1,
  );
  const orderedEnd =
    end.line < start.line ||
    (end.line === start.line && end.column < start.column)
      ? start
      : end;
  return {
    ...range,
    [fields.startLine]: start.line,
    [fields.startColumn]: start.column,
    [fields.endLine]: orderedEnd.line,
    [fields.endColumn]: orderedEnd.column,
  };
}

function rangeText(source, starts, range, fields) {
  const from = sourceOffset(
    starts,
    source.length,
    range[fields.startLine],
    range[fields.startColumn],
  );
  const to = sourceOffset(
    starts,
    source.length,
    range[fields.endLine] ?? range[fields.startLine],
    range[fields.endColumn] ?? range[fields.startColumn],
  );
  return source.slice(from, Math.max(from, to));
}

function markTouched(original, mapped, draft, mapper, fields) {
  if (!original || !mapped) return mapped;
  return rangeText(
    draft.previousSource,
    mapper.previousStarts,
    original,
    fields,
  ) === rangeText(draft.source, mapper.starts, mapped, fields)
    ? mapped
    : { ...mapped, draftTouched: true };
}

const eventFields = {
  startLine: "line",
  startColumn: "column",
  endLine: "endLine",
  endColumn: "endColumn",
};

const siteFields = {
  startLine: "startLine",
  startColumn: "startColumn",
  endLine: "endLine",
  endColumn: "endColumn",
};

function mapExecutionDraftEventWithMapper(event, draft, mapper) {
  if (!event || event.path !== draft.path) return event;
  const mapped = markTouched(
    event,
    mapRange(event, mapper, eventFields),
    draft,
    mapper,
    eventFields,
  );
  const lineage = event.draftInvalidationLineage?.map((ancestor) =>
    ancestor.path === draft.path
      ? mapRange(ancestor, mapper, eventFields)
      : ancestor,
  );
  return lineage ? { ...mapped, draftInvalidationLineage: lineage } : mapped;
}

export function mapExecutionDraftEvent(
  event,
  draft,
  { instrumentation = null, mapping = null } = {},
) {
  return mapExecutionDraftEventWithMapper(
    event,
    draft,
    mapping || draftMapper(draft, instrumentation),
  );
}

function mapExecutionDraftSiteWithMapper(site, draft, mapper) {
  if (!site) return site;
  const mapped = markTouched(
    site,
    mapRange(site, mapper, siteFields),
    draft,
    mapper,
    siteFields,
  );
  return {
    ...mapped,
    target: mapRange(site.target, mapper, siteFields),
    selection: mapRange(site.selection, mapper, siteFields),
    focus: mapRange(site.focus, mapper, siteFields),
    executionFallback: site.executionFallback
      ? {
          ...site.executionFallback,
          range: mapRange(site.executionFallback.range, mapper, siteFields),
        }
      : site.executionFallback,
  };
}

export function mapExecutionDraftSite(
  site,
  draft,
  { instrumentation = null, mapping = null } = {},
) {
  return mapExecutionDraftSiteWithMapper(
    site,
    draft,
    mapping || draftMapper(draft, instrumentation),
  );
}

export function mapExecutionDraftEvents(
  events,
  draft,
  { instrumentation = null, mapping = null } = {},
) {
  const mapper = mapping || draftMapper(draft, instrumentation);
  return (events || []).map((event) =>
    event?.path === draft.path
      ? mapExecutionDraftEventWithMapper(event, draft, mapper)
      : event,
  );
}

export function mapExecutionDraftSites(
  sites,
  draft,
  { instrumentation = null, mapping = null } = {},
) {
  const mapper = mapping || draftMapper(draft, instrumentation);
  return (sites || []).map((site) =>
    mapExecutionDraftSiteWithMapper(site, draft, mapper),
  );
}

export function executionDraftEventIsInvalidated(
  event,
  invalidation,
  plan,
  path,
) {
  if (!invalidation || event?.path !== path || !plan) return false;
  const blockIndex = plan.blocks.findIndex(
    (block) => event.line >= block.lineStart && event.line <= block.lineEnd,
  );
  if (invalidation.blockFrom !== null) {
    if (blockIndex >= invalidation.blockFrom) return true;
    if (blockIndex < 0) {
      return plan.inline.some((item) => item.line === event.line);
    }
  }
  if (invalidation.inlineFrom !== null && blockIndex < 0) {
    const inlineIndex = plan.inline.findIndex((item) => item.line === event.line);
    return inlineIndex >= invalidation.inlineFrom;
  }
  return false;
}

export function projectExecutionDraftEvents(
  events,
  draft,
  {
    invalidation = null,
    plan = null,
    instrumentation = null,
    mapping = null,
  } = {},
) {
  const previous = events || [];
  const eventIsDirectlyInvalidated = (event) =>
    executionDraftEventIsInvalidated(
      event,
      invalidation,
      plan,
      draft.path,
    );
  const directlyInvalidated = previous.map(eventIsDirectlyInvalidated);
  const invalidatedThroughLineage = previous.map((event) =>
    (event?.draftInvalidationLineage || []).some(eventIsDirectlyInvalidated),
  );
  const invalidatedOccurrences = new Set(
    previous
      .filter(
        (event, index) =>
          directlyInvalidated[index] || invalidatedThroughLineage[index],
      )
      .map((event) => event?.occurrenceId)
      .filter(Boolean),
  );
  const childOccurrences = new Map();
  const parentOccurrences = new Map();
  const directlyInvalidatedOccurrenceIndexes = new Map();
  for (const [index, event] of previous.entries()) {
    if (!event?.occurrenceId) continue;
    if (
      directlyInvalidated[index] &&
      !directlyInvalidatedOccurrenceIndexes.has(event.occurrenceId)
    ) {
      directlyInvalidatedOccurrenceIndexes.set(event.occurrenceId, index);
    }
    if (!event.parentId) continue;
    const children = childOccurrences.get(event.parentId) || new Set();
    children.add(event.occurrenceId);
    childOccurrences.set(event.parentId, children);
    if (!parentOccurrences.has(event.occurrenceId)) {
      parentOccurrences.set(event.occurrenceId, event.parentId);
    }
  }
  const pendingOccurrences = [...invalidatedOccurrences];
  for (let index = 0; index < pendingOccurrences.length; index += 1) {
    for (const child of childOccurrences.get(pendingOccurrences[index]) || []) {
      if (invalidatedOccurrences.has(child)) continue;
      invalidatedOccurrences.add(child);
      pendingOccurrences.push(child);
    }
  }
  const mapped = mapExecutionDraftEvents(previous, draft, {
    instrumentation,
    mapping,
  });
  const nearestDirectAncestorIndexes = new Map();
  const nearestDirectAncestorIndex = (start) => {
    if (nearestDirectAncestorIndexes.has(start)) {
      return nearestDirectAncestorIndexes.get(start);
    }
    const path = [];
    const visited = new Set();
    let occurrenceId = start;
    let result;
    while (occurrenceId && !visited.has(occurrenceId)) {
      if (nearestDirectAncestorIndexes.has(occurrenceId)) {
        result = nearestDirectAncestorIndexes.get(occurrenceId);
        break;
      }
      visited.add(occurrenceId);
      path.push(occurrenceId);
      if (directlyInvalidatedOccurrenceIndexes.has(occurrenceId)) {
        result = directlyInvalidatedOccurrenceIndexes.get(occurrenceId);
        break;
      }
      occurrenceId = parentOccurrences.get(occurrenceId);
    }
    for (const id of path) nearestDirectAncestorIndexes.set(id, result);
    return result;
  };
  const lineageFor = (event, index) => {
    const lineage = [...(mapped[index]?.draftInvalidationLineage || [])];
    const seen = new Set(lineage.map((ancestor) => ancestor.occurrenceId));
    const ancestorIndex = nearestDirectAncestorIndex(event?.occurrenceId);
    const ancestor = mapped[ancestorIndex];
    if (ancestor && !seen.has(ancestor.occurrenceId)) {
      lineage.push({
        path: ancestor.path,
        line: ancestor.line,
        column: ancestor.column,
        endLine: ancestor.endLine,
        endColumn: ancestor.endColumn,
        occurrenceId: ancestor.occurrenceId,
        parentId: ancestor.parentId,
        phase: ancestor.phase,
        kind: ancestor.kind,
        label: ancestor.label,
      });
    }
    return lineage;
  };
  return mapped.flatMap((event, index) => {
    const invalidated =
      directlyInvalidated[index] ||
      invalidatedThroughLineage[index] ||
      invalidatedOccurrences.has(previous[index]?.occurrenceId);
    if (invalidated) {
      if (
        invalidatedThroughLineage[index] ||
        event.kind !== "function" ||
        event.phase !== "enter"
      ) {
        return [];
      }
      return [{
        ...event,
        draftInvalidationLineage: lineageFor(previous[index], index),
      }];
    }
    return !event.draftTouched || event.kind === "function" ? [event] : [];
  });
}
