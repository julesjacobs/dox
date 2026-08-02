import {
  snapshotActivations,
  snapshotCallAttempts,
  snapshotClosureProvenance,
  snapshotClosures,
  snapshotCompilationUnits,
  snapshotConstructs,
  snapshotExecutionScopes,
  snapshotOccurrences,
  snapshotSelectors,
  snapshotWrites,
} from "./execution-artifact.js";

const text = (value) => String(value ?? "");

function sortById(records) {
  return [...records].sort((left, right) => compareText(left.id, right.id));
}

function compareText(left, right) {
  const leftText = text(left);
  const rightText = text(right);
  return leftText < rightText ? -1 : leftText > rightText ? 1 : 0;
}

function sortBySequence(records, field = "enteredAt") {
  return [...records].sort(
    (left, right) =>
      Number(left[field] ?? -1) - Number(right[field] ?? -1) ||
      compareText(left.id, right.id),
  );
}

function plain(value) {
  if (Array.isArray(value)) return value.map(plain);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => compareText(left, right))
      .map(([key, item]) => [key, plain(item)]),
  );
}

/** Canonical, deterministic JSON used by the CLI and golden tests. */
export function buildExecutionAudit({ snapshot, viewModel = null, problems = [] }) {
  return Object.freeze(
    plain({
      schemaVersion: 1,
      evaluationId: snapshot?.evaluationId || null,
      requestCodeDigest: snapshot?.requestCodeDigest || null,
      projectDigest: snapshot?.projectDigest || null,
      codeRevisionId: snapshot?.codeRevisionId || null,
      compilerInputsDigest: snapshot?.compilerInputsDigest || null,
      sourceMaps: snapshot?.sourceMaps
        ? {
            ...snapshot.sourceMaps,
            entries: [...snapshot.sourceMaps.entries].sort(
              (left, right) =>
                compareText(left.generatedPath, right.generatedPath) ||
                left.startByte - right.startByte ||
                left.endByte - right.endByte ||
                compareText(left.documentPath, right.documentPath) ||
                compareText(left.selectorId, right.selectorId),
            ),
          }
        : null,
      terminal: snapshot?.terminal || null,
      counts: snapshot?.counts || null,
      problems: [...problems],
      staticProgram: snapshot
        ? {
            compilationUnits: sortById(snapshotCompilationUnits(snapshot)),
            executionScopes: sortById(snapshotExecutionScopes(snapshot)),
            constructs: sortById(snapshotConstructs(snapshot)),
            selectors: sortById(snapshotSelectors(snapshot)),
          }
        : null,
      execution: snapshot
        ? {
            occurrences: sortBySequence(snapshotOccurrences(snapshot)),
            activations: sortBySequence(snapshotActivations(snapshot)),
            closures: sortBySequence(snapshotClosures(snapshot), "createdAt"),
            closureProvenance: sortBySequence(
              snapshotClosureProvenance(snapshot),
              "sequence",
            ),
            callAttempts: sortBySequence(snapshotCallAttempts(snapshot), "openedAt"),
            writes: sortBySequence(snapshotWrites(snapshot), "sequence"),
          }
        : null,
      viewModel,
    }),
  );
}

const display = (outcome) => outcome?.value?.display ?? outcome?.kind ?? "-";
const row = (...columns) => columns.map((column) => text(column)).join("  ");

export function renderExecutionAudit(audit) {
  if (!audit.execution) {
    return [
      "artifact invalid",
      ...audit.problems.map((problem) =>
        row(problem.code, `${problem.entityType || "artifact"}:${problem.entityId || "-"}`, problem.detail),
      ),
    ].join("\n");
  }
  const output = [
    row(
      "artifact",
      audit.evaluationId,
      "code",
      audit.codeRevisionId,
      "terminal",
      audit.terminal?.kind,
    ),
    row(
      "counts",
      `constructs=${audit.counts.constructs}`,
      `selectors=${audit.counts.selectors}`,
      `occurrences=${audit.counts.occurrences}`,
      `activations=${audit.counts.activations}`,
      `closures=${audit.counts.closures}`,
      `calls=${audit.counts.callAttempts}`,
      `writes=${audit.counts.writes}`,
    ),
    "",
    "activations",
    ...audit.execution.activations.map((activation) =>
      row(
        activation.id,
        `parent=${activation.dynamicParentId || "-"}`,
        activation.signature?.functionKey || "-",
        `-> ${display(activation.outcome)}`,
      ),
    ),
    "",
    "occurrences",
    ...audit.execution.occurrences.map((occurrence) =>
      row(
        occurrence.id,
        `activation=${occurrence.activationId}`,
        `construct=${occurrence.constructId}`,
        occurrence.kind,
        `-> ${display(occurrence.outcome)}`,
      ),
    ),
    "",
    "call attempts",
    ...audit.execution.callAttempts.map((attempt) =>
      row(
        attempt.id,
        `owner=${attempt.ownerActivationId}`,
        `producers=${attempt.producerActivationIds?.join(",") || "-"}`,
        `tail=${Boolean(attempt.tail)}`,
        `-> ${display(attempt.outcome)}`,
      ),
    ),
    "",
    "closures",
    ...audit.execution.closures.map((closure) =>
      row(
        closure.id,
        `construct=${closure.functionConstructId}`,
        `origin=${closure.originActivationId || "-"}`,
      ),
    ),
    ...audit.execution.closureProvenance.map((provenance) =>
      row(
        `provenance@${provenance.sequence}`,
        `closure=${provenance.closureId}`,
        `activation=${provenance.activationId || "-"}`,
        provenance.kind,
      ),
    ),
    "",
    "writes",
    ...audit.execution.writes.map((write) =>
      row(
        write.id,
        `activation=${write.activationId}`,
        `construct=${write.constructId}`,
        `target=${write.targetId || "-"}`,
        `value=${display({ kind: "return", value: write.newValue })}`,
      ),
    ),
    "",
    audit.problems.length ? "invariants failed" : "invariants ok",
  ];
  return output.join("\n");
}
