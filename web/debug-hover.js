export const debugValueTooltipGap = Object.freeze({ x: 16, y: 18 });

export function debugBindingKeysMatch(sourceKey, targetKey) {
  return Boolean(sourceKey && targetKey && sourceKey === targetKey);
}

export function debugBindingHasVisibleTarget(sourceKey, targetKeys = []) {
  return targetKeys.some((targetKey) =>
    debugBindingKeysMatch(sourceKey, targetKey),
  );
}

export function debugHoverTooltipPosition({
  pointerX,
  pointerY,
  width,
  height,
  viewportWidth,
  viewportHeight,
  gapX = debugValueTooltipGap.x,
  gapY = debugValueTooltipGap.y,
  margin = 8,
}) {
  let x = pointerX + gapX;
  let y = pointerY + gapY;

  if (x + width > viewportWidth - margin) {
    x = pointerX - width - gapX;
  }
  if (y + height > viewportHeight - margin) {
    y = pointerY - height - gapY;
  }

  return {
    x: Math.max(margin, Math.min(x, viewportWidth - width - margin)),
    y: Math.max(margin, Math.min(y, viewportHeight - height - margin)),
  };
}
