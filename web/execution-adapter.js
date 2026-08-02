import {
  buildExecutionSnapshot,
} from "./execution-artifact.js";
import {
  createExecutionState,
  executionDigest,
  executionDocumentRevisionId,
  executionExecutableParts,
  executionRequestCodeDigest,
  executionStateSources,
  transition,
} from "./execution-reducer.js";
import { buildExecutionViewFromArtifact } from "./execution-view.js";
import { buildExecutionViewModel } from "./execution-view-model.js";
import { buildExecutionUxLine } from "./execution-self-check.js";

export { executionDocumentRevisionId };
export { executionDigest };
export { executionExecutableParts };
export { executionRequestCodeDigest };

function result(state, effects, decision, problems = [], artifact = null) {
  return Object.freeze({
    state,
    model: state ? buildExecutionViewModel(state) : null,
    effects: Object.freeze([...effects]),
    decision,
    problems: Object.freeze([...problems]),
    artifact,
  });
}

/**
 * Build the sole execution state installed by the browser. Validation and
 * source-map projection finish before the state becomes observable.
 */
export function installExecutionArtifact({ envelope, sources, cursor = null }) {
  const verified = buildExecutionSnapshot(envelope);
  if (!verified.ok) {
    return result(null, [], "artifact-validation-failed", verified.problems);
  }
  const requestCodeDigest = executionRequestCodeDigest(sources);
  if (envelope.requestCodeDigest !== requestCodeDigest) {
    return result(null, [], "artifact-source-identity-mismatch", [
      Object.freeze({
        code: "request-code-digest-mismatch",
        entityType: "artifact",
        entityId: envelope.evaluationId || "-",
        detail: "The artifact was produced for different executable source.",
      }),
    ]);
  }
  const documentRevisionId = executionDocumentRevisionId(sources);
  if (envelope.sourceMaps?.documentRevisionId !== documentRevisionId) {
    return result(null, [], "artifact-source-identity-mismatch", [
      Object.freeze({
        code: "document-revision-id-mismatch",
        entityType: "artifact",
        entityId: envelope.evaluationId || "-",
        detail: "The artifact source map was produced for a different document revision.",
      }),
    ]);
  }
  try {
    const view = buildExecutionViewFromArtifact({
      snapshot: verified.snapshot,
      envelope,
      sources,
    });
    let state = createExecutionState({
      view,
      projectDigest: envelope.projectDigest,
      compilerInputsDigest: envelope.compilerInputsDigest,
      // The view normalizes line endings for editor geometry. Preserve the
      // sealed request identity until an edit creates a new document revision.
      requestCodeDigest: envelope.requestCodeDigest,
    });
    if (cursor) {
      state = transition(state, {
        kind: "cursor-moved",
        position: cursor,
      }).state;
    }
    return result(state, [], "artifact-installed", [], envelope);
  } catch (error) {
    return result(null, [], "artifact-source-map-invalid", [
      Object.freeze({
        code: "source-map-install-failed",
        entityType: "source-map",
        entityId: "-",
        detail: error instanceof Error ? error.message : String(error),
      }),
    ]);
  }
}

/** Translate one UI or async event into exactly one reducer transition. */
export function dispatchExecutionIntent(state, intent) {
  const transitioned = transition(state, intent);
  return result(
    transitioned.state,
    transitioned.effects,
    transitioned.decision,
    transitioned.problems,
  );
}

export function presentExecution(state) {
  return state ? buildExecutionViewModel(state) : null;
}

/** A deterministic empty-selection baseline shared by CLI-style UI audits. */
export function createExecutionAuditBaseline(state) {
  if (!state) return null;
  return createExecutionState({
    view: state.view,
    projectDigest: state.projectDigest,
    compilerInputsDigest: state.compilerInputsDigest,
    requestCodeDigest: state.requestCodeDigest,
  });
}

/** The browser-visible C/H/R audit projection, exposed through one boundary. */
export function buildExecutionAuditLine(state, options) {
  return state ? buildExecutionUxLine(state, options) : null;
}

export function executionPendingToken(state) {
  const evaluation = presentExecution(state)?.evaluation;
  return evaluation?.kind === "pending" ? evaluation.token : null;
}

export function executionSource(state, path) {
  return state ? executionStateSources(state).get(path) ?? null : null;
}

export function executionSources(state) {
  if (!state) return Object.freeze([]);
  return Object.freeze(
    [...executionStateSources(state).entries()].sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    ),
  );
}
