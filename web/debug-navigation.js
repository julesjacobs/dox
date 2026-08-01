export function createDebugNavigationGate() {
  let suppressedClick = null;
  let generation = 0;
  return {
    canNavigatePointerdown(event) {
      return event?.button === 0 && event?.isPrimary !== false;
    },
    suppressClickAfterPointerdown() {
      const token = ++generation;
      suppressedClick = token;
      return token;
    },
    shouldNavigateClick(event) {
      if (event?.shiftKey || event?.button !== 0) return false;
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
