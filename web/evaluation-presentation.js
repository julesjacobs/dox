export function inspectorDiagnostics(evaluation, { path = null, cursorLine = null } = {}) {
  const diagnostics = (evaluation?.diagnostics || []).filter(
    (diagnostic) => !diagnostic.path || !path || diagnostic.path === path,
  );
  if (evaluation?.ok === false) return diagnostics;
  return diagnostics.filter(
    (diagnostic) =>
      !diagnostic.line || !cursorLine || diagnostic.line === cursorLine,
  );
}

export function staleExecutionLabel(evaluation) {
  return evaluation?.ok === false
    ? "Last successful execution"
    : "Execution is updating";
}

const compilerLocation = /File "([^"]+)", line (\d+), characters (\d+)-(\d+):\n/g;

/* A compiler message is a sequence of labelled parts - the error, then any hint
   or warning - and OCaml rewraps each part at its own margin, indenting the
   continuation in some messages and not in others. So indentation says nothing
   about structure: a break matters only where a new label begins, and every
   other break is rewrapping to be undone. */
const compilerLabel = /^(?:Error|Warning(?: \d+)?|Hint|Alert(?: \w+)?)\s*:/;

function reflowCompilerDetail(detail) {
  const lines = [];
  for (const line of detail.split("\n")) {
    const text = line.trim();
    if (!text) continue;
    if (lines.length && !compilerLabel.test(text)) {
      lines[lines.length - 1] = `${lines[lines.length - 1]} ${text}`;
    } else {
      lines.push(text);
    }
  }
  return lines.join("\n");
}

export function formatDiagnosticMessage(message) {
  const source = String(message || "").trim();
  const matches = [...source.matchAll(compilerLocation)];
  if (!matches.length) return source;
  const parts = [];
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const from = match.index + match[0].length;
    const to = matches[index + 1]?.index ?? source.length;
    let detail = source.slice(from, to).trim();
    if (index === 0) {
      detail = reflowCompilerDetail(detail.replace(/^Error:[ \t]*/, ""));
      if (detail) parts.push(detail);
    } else if (detail) {
      parts.push(`Line ${match[2]} · ${reflowCompilerDetail(detail)}`);
    }
  }
  return parts.join("\n") || source;
}

export function diagnosticSourceLocations(diagnostic) {
  const locations = [];
  if (diagnostic?.line) {
    locations.push({
      path: diagnostic.path || null,
      line: diagnostic.line,
      columnStart: diagnostic.columnStart ?? 0,
      columnEnd: diagnostic.columnEnd ?? diagnostic.columnStart ?? 0,
      primary: true,
    });
  }
  for (const match of String(diagnostic?.message || "").matchAll(compilerLocation)) {
    const candidate = {
      path: match[1],
      line: Number(match[2]),
      columnStart: Number(match[3]),
      columnEnd: Number(match[4]),
      primary: false,
    };
    if (
      locations.some(
        (location) =>
          location.path === candidate.path &&
          location.line === candidate.line &&
          location.columnStart === candidate.columnStart &&
          location.columnEnd === candidate.columnEnd,
      )
    ) {
      continue;
    }
    locations.push(candidate);
  }
  return locations;
}
