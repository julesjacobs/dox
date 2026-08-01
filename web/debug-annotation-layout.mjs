export function distributeDebugAnnotationRails(
  rails,
  lineCount,
  canBorrowLine = () => true,
) {
  const sourceLines = [...rails.keys()]
    .filter((line) => line >= 1 && line <= lineCount)
    .sort((left, right) => left - right);
  const reservedLines = new Set(sourceLines);
  const distributed = new Map();
  const railFor = (line) => {
    if (!distributed.has(line)) {
      distributed.set(line, { items: [], activity: null });
    }
    return distributed.get(line);
  };

  for (const sourceLine of sourceLines) {
    const sourceRail = rails.get(sourceLine);
    let targetLine = sourceLine;
    for (const [index, item] of (sourceRail.items || []).entries()) {
      if (index > 0) {
        const nextLine = targetLine + 1;
        if (
          nextLine <= lineCount &&
          canBorrowLine(nextLine) &&
          !reservedLines.has(nextLine) &&
          !distributed.has(nextLine)
        ) {
          targetLine = nextLine;
        }
      }
      railFor(targetLine).items.push(item);
    }
    if (sourceRail.activity) {
      railFor(sourceLine).activity = sourceRail.activity;
    }
  }

  return distributed;
}
