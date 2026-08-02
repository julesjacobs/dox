export function createDebugNavigationGate() {
  let suppressedClick = null;
  let generation = 0;
  return {
    canNavigatePointerdown(event, requiresShift = false) {
      return (
        event?.button === 0 &&
        event?.isPrimary !== false &&
        (!requiresShift || event?.shiftKey)
      );
    },
    suppressClickAfterPointerdown() {
      const token = ++generation;
      suppressedClick = token;
      return token;
    },
    shouldNavigateClick(event, requiresShift = false) {
      if (
        event?.button !== 0 ||
        (requiresShift && !event?.shiftKey)
      ) return false;
      if (event.detail !== 0 && suppressedClick !== null) {
        suppressedClick = null;
        return false;
      }
      return true;
    },
    clearSuppressedClick(token) {
      if (suppressedClick === token) suppressedClick = null;
    },
  };
}
