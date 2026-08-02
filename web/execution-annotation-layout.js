export const preferredExecutionAnnotationColumn = 72;
// CodeMirror's line inset consumes a little over one monospace column. Seven
// source columns leave roughly five visibly empty columns in the editor.
export const minimumExecutionAnnotationGap = 7;

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
