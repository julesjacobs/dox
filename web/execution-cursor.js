// The compiler index owns source-construct selection. The frontend only clamps
// the editor position; it never reparses OCaml or consults runtime values.
export function executionCursorProbe(line, column) {
  const cursor = Math.min(Math.max(Number(column) || 0, 0), line.length);
  return { column: cursor, purpose: "execution" };
}

export function executionSourceTextForSite(source, site) {
  if (!site || !Number.isFinite(site.startLine)) return "";
  const lines = source.split("\n");
  const startLine = Math.max(1, site.startLine);
  const endLine = Math.min(lines.length, site.endLine || startLine);
  const selected = lines.slice(startLine - 1, endLine);
  if (!selected.length) return "";
  if (selected.length === 1) {
    return selected[0]
      .slice(site.startColumn || 0, site.endColumn ?? selected[0].length)
      .trim();
  }
  selected[0] = selected[0].slice(site.startColumn || 0);
  selected[selected.length - 1] = selected[selected.length - 1].slice(
    0,
    site.endColumn ?? selected[selected.length - 1].length,
  );
  return selected.join(" ").replace(/\s+/g, " ").trim();
}

function containsPosition(site, position) {
  const range = site.selection || site;
  if (position.line < range.startLine || position.line > range.endLine) {
    return false;
  }
  if (position.line === range.startLine && position.column < range.startColumn) {
    return false;
  }
  if (
    position.line === range.endLine &&
    position.column >= range.endColumn &&
    !(
      range.startLine === range.endLine &&
      range.startColumn === range.endColumn
    )
  ) {
    return false;
  }
  return true;
}

function containsRawPosition(site, position) {
  return containsPosition({ ...site, selection: null }, position);
}

function siteSize(site) {
  return (
    (site.endLine - site.startLine) * 1_000_000 +
    Math.max(0, site.endColumn - site.startColumn)
  );
}

function patternTarget(pattern, target) {
  if (!target) return pattern;
  return {
    ...target,
    ...(pattern.role ? { role: pattern.role } : {}),
    focus: {
      startLine: pattern.startLine,
      startColumn: pattern.startColumn,
      endLine: pattern.endLine,
      endColumn: pattern.endColumn,
    },
  };
}

function executionSiteForPattern(pattern, patterns) {
  if (pattern.direct) return pattern;
  if (pattern.target) return patternTarget(pattern, pattern.target);
  const definition = patterns.find(
    (candidate) => candidate !== pattern && candidate.selection,
  );
  if (definition) return definition;
  return pattern;
}

function compilerTarget(site) {
  if (!site?.target) return site;
  const selected = {
    ...site.target,
    role: site.role,
  };
  const sourceRange = {
    startLine: site.startLine,
    startColumn: site.startColumn,
    endLine: site.endLine,
    endColumn: site.endColumn,
  };
  if (site.kind === "syntax") {
    selected.focus = sourceRange;
  }
  if (site.role === "callee") {
    selected.executionFallback = {
      kind: "application",
      range: sourceRange,
    };
  }
  return selected;
}

export function executionSiteAt(
  sites,
  position,
  { purpose = "execution" } = {},
) {
  if (!position?.path || !Number.isFinite(position.line)) return null;
  if (purpose === "execution") {
    const syntax = (sites || [])
      .filter(
        (site) =>
          site.kind === "syntax" && containsRawPosition(site, position),
      )
      .sort((left, right) => siteSize(left) - siteSize(right))[0];
    if (syntax?.target) return compilerTarget(syntax);
    const directPatterns = (sites || [])
      .filter(
        (site) =>
          site.kind === "pattern" &&
          !site.ghost &&
          containsRawPosition(site, position),
      )
      .sort((left, right) => siteSize(left) - siteSize(right));
    if (directPatterns.length) {
      return executionSiteForPattern(
        directPatterns[0],
        (sites || []).filter(
          (site) => site.kind === "pattern" && containsPosition(site, position),
        ),
      );
    }
  }
  const wantedKind = purpose === "type" ? "pattern" : "expression";
  const candidates = (sites || [])
    .filter(
      (site) =>
        site.kind === wantedKind &&
        !site.ghost &&
        containsPosition(site, position),
    )
    .sort(
      (left, right) =>
        siteSize(left) - siteSize(right) ||
        right.startLine - left.startLine ||
        right.startColumn - left.startColumn,
    );
  if (!candidates.length && purpose === "type") {
    return executionSiteAt(sites, position, {
      purpose: "execution",
    });
  }
  if (!candidates.length && purpose === "execution") {
    const patterns = (sites || [])
      .filter(
        (site) => site.kind === "pattern" && containsPosition(site, position),
      )
      .sort((left, right) => siteSize(left) - siteSize(right));
    const pattern = patterns[0];
    return pattern ? executionSiteForPattern(pattern, patterns) : null;
  }
  const selected = candidates[0] || null;
  if (!selected || purpose !== "execution") return selected;
  return compilerTarget(selected);
}
