const defaultBudget = 120;

function oneLine(value) {
  return String(value ?? "…").replace(/\s*\n\s*/g, " ");
}

function boundedText(value, budget) {
  const text = oneLine(value);
  const characters = Array.from(text);
  if (characters.length <= budget) return { text, truncated: false };
  const suffixLength = Math.min(24, Math.floor(budget / 4));
  const prefixLength = Math.max(1, budget - suffixLength - 3);
  return {
    text: `${characters.slice(0, prefixLength).join("")} … ${characters
      .slice(-suffixLength)
      .join("")}`,
    truncated: true,
  };
}

/** A deterministic, single-line value used by both source and inspector UI. */
export function renderExecutionValue(
  outcome,
  { budget = defaultBudget, role = null } = {},
) {
  const display = outcome?.value?.display ?? outcome?.display ?? "…";
  const bounded = boundedText(display, Math.max(12, budget));
  return Object.freeze({
    text: bounded.text,
    fullText: oneLine(display),
    type: outcome?.value?.type ?? outcome?.type ?? null,
    kind: outcome?.kind || "incomplete",
    truncated: bounded.truncated || outcome?.value?.complete === false,
    segments: Object.freeze([
      Object.freeze({
        from: 0,
        to: bounded.text.length,
        role: role || "neutral",
      }),
    ]),
  });
}

export function renderExecutionValues(outcomes, options) {
  return Object.freeze(outcomes.map((outcome) => renderExecutionValue(outcome, options)));
}
