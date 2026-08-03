export const preferredExecutionAnnotationColumn = 72;
export const minimumExecutionAnnotationColumn = 24;
// CodeMirror's line inset consumes a little over one monospace column. Seven
// source columns leave roughly five visibly empty columns in the editor.
export const minimumExecutionAnnotationGap = 7;

/** One document coordinate shared by top-level and function activations. */
export function executionAnnotationRail(
  preferredColumn = preferredExecutionAnnotationColumn,
) {
  return Number.isFinite(preferredColumn)
    ? Math.max(0, preferredColumn)
    : preferredExecutionAnnotationColumn;
}

/**
 * Keep the common rail aligned, but never place an annotation over source.
 * Once source approaches the common rail, preserve enough empty space that
 * code and runtime values remain visually separate.
 */
export function executionAnnotationColumn(
  sourceLength,
  preferredColumn = preferredExecutionAnnotationColumn,
  minimumGap = minimumExecutionAnnotationGap,
) {
  const length = Number.isFinite(sourceLength) ? Math.max(0, sourceLength) : 0;
  const gap = Number.isFinite(minimumGap) ? Math.max(0, minimumGap) : 0;
  return Math.max(preferredColumn, length + gap);
}
