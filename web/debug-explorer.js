function caretFromPoint(document_, clientX, clientY) {
  const position = document_.caretPositionFromPoint?.(clientX, clientY);
  if (position?.offsetNode) {
    return { node: position.offsetNode, offset: position.offset };
  }
  const range = document_.caretRangeFromPoint?.(clientX, clientY);
  if (range?.startContainer) {
    return { node: range.startContainer, offset: range.startOffset };
  }
  return null;
}

export function pointerColumn({ document_, code, source, clientX, clientY }) {
  const caret = caretFromPoint(document_, clientX, clientY);
  if (caret?.node && code.contains(caret.node)) {
    const parent =
      caret.node.nodeType === 3 ? caret.node.parentElement : caret.node;
    const run = parent?.closest?.("[data-debug-from]");
    if (run) {
      return Math.min(
        Math.max(Number(run.dataset.debugFrom) + caret.offset, 0),
        source.length,
      );
    }
  }
  const rect = code.getBoundingClientRect();
  return clientX >= rect.right ? source.length : 0;
}
