export function outlineDepth(text) {
  const spaces = text.match(/^ */)?.[0].length || 0;
  return spaces / 2;
}

function nonblankLine(lines, start, step) {
  for (
    let index = start;
    index >= 0 && index < lines.length;
    index += step
  ) {
    if (lines[index].text.trim()) return index;
  }
  return null;
}

export function outlineSubtreeEnd(source, startLine) {
  const lines = source.split("\n");
  if (!lines[startLine]?.trim()) return startLine;
  const depth = outlineDepth(lines[startLine]);
  let index = startLine + 1;
  while (index < lines.length) {
    if (lines[index].trim() && outlineDepth(lines[index]) <= depth) break;
    index += 1;
  }
  return index;
}

function indentLine(text, delta) {
  if (!text.trim()) return text;
  const spaces = text.match(/^ */)?.[0].length || 0;
  return " ".repeat(Math.max(0, spaces + delta * 2)) + text.slice(spaces);
}

export function moveOutlineSubtree(
  source,
  startLine,
  targetLine,
  placement,
) {
  const lines = source
    .split("\n")
    .map((text, index) => ({ text, originLine: index + 1 }));
  const sourceLine = lines[startLine];
  const target = lines[targetLine];
  if (!sourceLine?.text.trim() || !target?.text.trim()) return null;

  const sourceDepth = outlineDepth(sourceLine.text);
  const targetDepth = outlineDepth(target.text);
  const sourceEnd = outlineSubtreeEnd(source, startLine);
  if (targetLine >= startLine && targetLine < sourceEnd) return null;

  let insertionLine;
  let nextDepth;
  if (placement === "before") {
    insertionLine = targetLine;
    nextDepth = targetDepth;
  } else if (placement === "inside-first") {
    insertionLine = targetLine + 1;
    nextDepth = targetDepth + 1;
  } else if (placement === "inside-last") {
    insertionLine = outlineSubtreeEnd(source, targetLine);
    nextDepth = targetDepth + 1;
  } else if (placement === "after") {
    insertionLine = outlineSubtreeEnd(source, targetLine);
    nextDepth = targetDepth;
  } else {
    return null;
  }

  const block = lines.splice(startLine, sourceEnd - startLine);
  if (insertionLine > sourceEnd) insertionLine -= block.length;
  else if (insertionLine > startLine) insertionLine = startLine;

  const delta = nextDepth - sourceDepth;
  const moved = block.map((line) => ({
    ...line,
    text: indentLine(line.text, delta),
  }));
  lines.splice(insertionLine, 0, ...moved);
  const nextSource = lines.map((line) => line.text).join("\n");
  if (nextSource === source) return null;
  return {
    source: nextSource,
    movedLine: insertionLine,
    originLines: lines.map((line) => line.originLine),
  };
}

function previousSiblingLine(source, startLine) {
  const lines = source.split("\n").map((text) => ({ text }));
  const sourceDepth = outlineDepth(lines[startLine]?.text || "");
  let index = nonblankLine(lines, startLine - 1, -1);
  while (index !== null) {
    const depth = outlineDepth(lines[index].text);
    if (depth < sourceDepth) return null;
    if (depth === sourceDepth) return index;
    index = nonblankLine(lines, index - 1, -1);
  }
  return null;
}

export function moveOutlineSibling(source, startLine, direction) {
  if (direction < 0) {
    const target = previousSiblingLine(source, startLine);
    return target === null
      ? null
      : moveOutlineSubtree(source, startLine, target, "before");
  }
  const lines = source.split("\n").map((text) => ({ text }));
  const depth = outlineDepth(lines[startLine]?.text || "");
  const end = outlineSubtreeEnd(source, startLine);
  const target = nonblankLine(lines, end, 1);
  if (target === null || outlineDepth(lines[target].text) !== depth) return null;
  return moveOutlineSubtree(source, startLine, target, "after");
}

export function indentOutlineSubtree(source, startLine) {
  const target = previousSiblingLine(source, startLine);
  return target === null
    ? null
    : moveOutlineSubtree(source, startLine, target, "inside-last");
}

export function outdentOutlineSubtree(source, startLine) {
  const lines = source.split("\n").map((text) => ({ text }));
  const depth = outlineDepth(lines[startLine]?.text || "");
  if (depth < 1) return null;
  let target = nonblankLine(lines, startLine - 1, -1);
  while (target !== null && outlineDepth(lines[target].text) >= depth) {
    target = nonblankLine(lines, target - 1, -1);
  }
  if (
    target === null ||
    outlineDepth(lines[target].text) !== depth - 1
  ) {
    return null;
  }
  return moveOutlineSubtree(source, startLine, target, "after");
}

export function changeBlankOutlineDepth(source, startLine, direction) {
  const lines = source.split("\n");
  const line = lines[startLine];
  if (line === undefined || line.trim()) return null;
  const spaces = line.match(/^ */)?.[0].length || 0;
  const nextSpaces = Math.max(0, spaces + (direction > 0 ? 2 : -2));
  if (nextSpaces === spaces) return null;
  if (direction > 0) {
    const parentDepth = nextSpaces / 2 - 1;
    const hasParent = lines
      .slice(0, startLine)
      .reverse()
      .some((candidate) =>
        candidate.trim() && outlineDepth(candidate) === parentDepth
      );
    if (!hasParent) return null;
  }
  lines[startLine] = " ".repeat(nextSpaces);
  return {
    source: lines.join("\n"),
    movedLine: startLine,
    originLines: lines.map((_, index) => index + 1),
  };
}
