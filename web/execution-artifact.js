const idAlphabet =
  "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

const constructSemanticKinds = new Set([
  "expression",
  "function",
  "application",
  "identifier",
  "literal",
  "binding",
  "match",
  "condition",
  "mutation",
  "sequence",
  "loop",
  "binder",
  "alias",
  "wildcard",
  "alternative",
  "constructor",
  "pattern",
]);

const selectorRoles = new Set([
  "construct",
  "binder",
  "callee",
  "operator",
  "if",
  "then",
  "else",
  "match",
  "with",
  "alternative",
  "arrow",
  "when",
  "let",
  "rec",
  "equals",
  "in",
  "fun",
  "function",
  "function-context",
  "while",
  "for",
  "do",
  "done",
]);

const occurrenceKinds = new Set([
  "function",
  "expression",
  "call",
  "pattern",
  "binder",
  "parameter",
  "boundary",
]);
const outcomeKinds = new Set(["return", "raise", "incomplete"]);
const outcomeSources = new Set(["runtime", "call-attempt", "truncated"]);
const executionEventKinds = new Set([
  "html",
  "link",
  "status",
  "stderr",
  "stdout",
  "text",
  "trace",
  "value",
]);

export function executionChecksum(input) {
  let hash = 2166136261;
  for (const byte of new TextEncoder().encode(input)) {
    hash ^= byte;
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function canonicalExecutionValue(value) {
  if (value === null) return "n";
  if (value === false) return "b0";
  if (value === true) return "b1";
  if (typeof value === "number") {
    const encoded = String(value);
    return `${Number.isInteger(value) ? "i" : "d"}${encoded.length}:${encoded}`;
  }
  if (typeof value === "string") {
    return `s${new TextEncoder().encode(value).length}:${value}`;
  }
  if (Array.isArray(value)) {
    return `l${value.length}:${value.map(canonicalExecutionValue).join("")}`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    );
    return `o${entries.length}:${entries
      .map(([key, item]) => `${canonicalExecutionValue(key)}${canonicalExecutionValue(item)}`)
      .join("")}`;
  }
  throw new TypeError(`Unsupported execution checksum value: ${typeof value}`);
}

export function executionTerminalChecksum(terminal) {
  const { checksum: _checksum, ...fields } = terminal || {};
  return executionChecksum(canonicalExecutionValue(fields));
}

export function executionArtifactChecksum(envelope) {
  const { artifactChecksum: _checksum, ...fields } = envelope || {};
  return executionChecksum(canonicalExecutionValue(fields));
}

export function sealExecutionEnvelope(envelope) {
  const terminal = {
    ...envelope.terminal,
    checksum: executionTerminalChecksum(envelope.terminal),
  };
  const fields = { ...envelope, terminal };
  delete fields.artifactChecksum;
  return {
    ...fields,
    artifactChecksum: executionArtifactChecksum(fields),
  };
}

function compareText(left, right) {
  const leftText = String(left);
  const rightText = String(right);
  return leftText < rightText ? -1 : leftText > rightText ? 1 : 0;
}

function compareConstruct(left, right) {
  return (
    compareText(left.sourcePath, right.sourcePath) ||
    left.startLine - right.startLine ||
    left.startColumn - right.startColumn ||
    left.endLine - right.endLine ||
    left.endColumn - right.endColumn ||
    compareText(left.category, right.category) ||
    compareText(left.id, right.id)
  );
}

function compareSelector(left, right) {
  return (
    compareText(left.sourcePath, right.sourcePath) ||
    left.startLine - right.startLine ||
    left.startColumn - right.startColumn ||
    left.endLine - right.endLine ||
    left.endColumn - right.endColumn ||
    right.priority - left.priority ||
    left.tieBreakRank - right.tieBreakRank ||
    compareText(left.id, right.id)
  );
}

function aliasFor(index) {
  const base = idAlphabet.length;
  let value = index;
  let alias = "";
  do {
    alias = idAlphabet[value % base] + alias;
    value = Math.floor(value / base) - 1;
  } while (value >= 0);
  return alias;
}

function problem(code, entityType, entityId, detail) {
  return Object.freeze({ code, entityType, entityId, detail });
}

function validRange(construct) {
  return (
    Number.isInteger(construct.startLine) &&
    construct.startLine >= 1 &&
    Number.isInteger(construct.startColumn) &&
    construct.startColumn >= 0 &&
    Number.isInteger(construct.endLine) &&
    construct.endLine >= construct.startLine &&
    Number.isInteger(construct.endColumn) &&
    construct.endColumn >= 0 &&
    (construct.endLine !== construct.startLine ||
      construct.endColumn >= construct.startColumn)
  );
}

function freezeRecord(record) {
  return Object.freeze({ ...record });
}

/**
 * Validate the first compiler/runtime seam of the new execution artifact.
 * This accepts the evaluator JSON while the remaining normalized envelope is
 * implemented. Consumers receive immutable, deterministically ordered data.
 */
export function buildCompilerContractCapture(payload) {
  const problems = [];
  const manifests = payload?.evaluation?.compilerManifests || [];
  const traces = payload?.evaluation?.traces || [];
  const units = [];
  const constructs = [];
  const selectors = [];
  const constructById = new Map();
  const scopeById = new Map();
  const selectorById = new Map();

  for (const manifest of manifests) {
    const unitName = String(manifest?.unitName || "");
    const unitGeneratedPath = String(manifest?.generatedPath || "");
    const unitByteLength = manifest?.byteLength;
    const unitSourceDigest = String(manifest?.sourceDigest || "");
    if (!unitName) {
      problems.push(
        problem("manifest-unit-missing", "manifest", "-", "unitName is empty"),
      );
    }
    const executionScopes = [];
    for (const input of manifest?.executionScopes || []) {
      const scope = freezeRecord({
        id: String(input?.id || ""),
        kind: String(input?.kind || ""),
        functionConstructId: input?.functionConstructId || null,
        unitName,
      });
      if (!scope.id) {
        problems.push(
          problem("scope-id-missing", "scope", "-", `${unitName} has an empty scope ID`),
        );
      } else if (scopeById.has(scope.id)) {
        problems.push(
          problem("scope-id-duplicate", "scope", scope.id, unitName),
        );
      } else {
        scopeById.set(scope.id, scope);
      }
      if (scope.kind !== "top-level" && scope.kind !== "function") {
        problems.push(
          problem("scope-kind-invalid", "scope", scope.id || "-", scope.kind),
        );
      }
      executionScopes.push(scope);
    }
    const topLevelScopeId = String(manifest?.topLevelScopeId || "");
    const unitConstructs = [];
    const unitSelectors = [];
    for (const input of manifest?.constructs || []) {
      const construct = freezeRecord({
        id: String(input?.id || ""),
        category: String(input?.category || ""),
        semanticKind: String(input?.semanticKind || ""),
        generatedPath: unitGeneratedPath,
        sourcePath: String(input?.sourcePath || input?.generatedPath || ""),
        startByte: input?.startByte,
        endByte: input?.endByte,
        startLine: input?.startLine,
        startColumn: input?.startColumn,
        endLine: input?.endLine,
        endColumn: input?.endColumn,
        ghost: Boolean(input?.ghost),
        parentId: input?.parentId || null,
        ownerScopeId: String(input?.ownerScopeId || ""),
        lexicalScopeId: String(input?.lexicalScopeId || input?.ownerScopeId || ""),
        syntaxFingerprint: String(input?.syntaxFingerprint || ""),
        lexicalAncestryFingerprint: String(
          input?.lexicalAncestryFingerprint || "",
        ),
        unitName,
      });
      if (!construct.id) {
        problems.push(
          problem(
            "construct-id-missing",
            "construct",
            "-",
            `${unitName} contains an empty construct ID`,
          ),
        );
      } else if (constructById.has(construct.id)) {
        problems.push(
          problem(
            "construct-id-duplicate",
            "construct",
            construct.id,
            `also present in ${constructById.get(construct.id).unitName}`,
          ),
        );
      } else {
        constructById.set(construct.id, construct);
      }
      if (!validRange(construct)) {
        problems.push(
          problem(
            "construct-range-invalid",
            "construct",
            construct.id || "-",
            `${construct.sourcePath}:${construct.startLine}:${construct.startColumn}-${construct.endLine}:${construct.endColumn}`,
          ),
        );
      }
      if (
        construct.category !== "expression" &&
        construct.category !== "pattern"
      ) {
        problems.push(
          problem(
            "construct-category-invalid",
            "construct",
            construct.id || "-",
            construct.category,
          ),
        );
      }
      if (!constructSemanticKinds.has(construct.semanticKind)) {
        problems.push(
          problem(
            "construct-semantic-kind-invalid",
            "construct",
            construct.id || "-",
            construct.semanticKind || "missing",
          ),
        );
      }
      unitConstructs.push(construct);
      constructs.push(construct);
    }
    for (const input of manifest?.selectors || []) {
      const selector = freezeRecord({
        id: String(input?.id || ""),
        role: String(input?.role || ""),
        subjectId: String(input?.subjectId || ""),
        generatedPath: unitGeneratedPath,
        sourcePath: String(input?.sourcePath || input?.generatedPath || ""),
        startByte: input?.startByte,
        endByte: input?.endByte,
        startLine: input?.startLine,
        startColumn: input?.startColumn,
        endLine: input?.endLine,
        endColumn: input?.endColumn,
        priority: input?.priority,
        tieBreakRank: input?.tieBreakRank,
        syntaxFingerprint: String(input?.syntaxFingerprint || ""),
        unitName,
      });
      if (!selector.id) {
        problems.push(problem("selector-id-missing", "selector", "-", unitName));
      } else if (selectorById.has(selector.id)) {
        problems.push(
          problem("selector-id-duplicate", "selector", selector.id, unitName),
        );
      } else selectorById.set(selector.id, selector);
      if (!validRange(selector)) {
        problems.push(
          problem("selector-range-invalid", "selector", selector.id || "-", selector.sourcePath),
        );
      }
      if (!selectorRoles.has(selector.role)) {
        problems.push(
          problem(
            "selector-role-invalid",
            "selector",
            selector.id || "-",
            selector.role || "missing",
          ),
        );
      }
      unitSelectors.push(selector);
      selectors.push(selector);
    }
    units.push(
      Object.freeze({
        unitName,
        generatedPath: unitGeneratedPath,
        byteLength: unitByteLength,
        sourceDigest: unitSourceDigest,
        topLevelScopeId,
        executionScopes: Object.freeze(executionScopes),
        constructs: Object.freeze(unitConstructs.sort(compareConstruct)),
        selectors: Object.freeze(unitSelectors.sort(compareSelector)),
      }),
    );
  }

  for (const unit of units) {
    const topLevelScope = scopeById.get(unit.topLevelScopeId);
    if (!topLevelScope || topLevelScope.kind !== "top-level") {
      problems.push(
        problem(
          "unit-top-level-scope-invalid",
          "unit",
          unit.unitName || "-",
          unit.topLevelScopeId || "missing",
        ),
      );
    }
  }

  for (const construct of constructs) {
    if (construct.parentId && !constructById.has(construct.parentId)) {
      problems.push(
        problem(
          "construct-parent-unknown",
          "construct",
          construct.id || "-",
          construct.parentId,
        ),
      );
    }
    if (!scopeById.has(construct.ownerScopeId)) {
      problems.push(
        problem(
          "construct-scope-unknown",
          "construct",
          construct.id || "-",
          construct.ownerScopeId || "missing",
        ),
      );
    }
    if (!scopeById.has(construct.lexicalScopeId)) {
      problems.push(
        problem(
          "construct-lexical-scope-unknown",
          "construct",
          construct.id || "-",
          construct.lexicalScopeId || "missing",
        ),
      );
    }
    const ownerScope = scopeById.get(construct.ownerScopeId);
    const lexicalScope = scopeById.get(construct.lexicalScopeId);
    if (ownerScope && ownerScope.unitName !== construct.unitName) {
      problems.push(
        problem(
          "construct-owner-scope-cross-unit",
          "construct",
          construct.id || "-",
          `${construct.unitName}:${ownerScope.unitName}`,
        ),
      );
    }
    if (lexicalScope && lexicalScope.unitName !== construct.unitName) {
      problems.push(
        problem(
          "construct-lexical-scope-cross-unit",
          "construct",
          construct.id || "-",
          `${construct.unitName}:${lexicalScope.unitName}`,
        ),
      );
    }
    const parent = construct.parentId
      ? constructById.get(construct.parentId)
      : null;
    if (parent && parent.unitName !== construct.unitName) {
      problems.push(
        problem(
          "construct-parent-cross-unit",
          "construct",
          construct.id || "-",
          parent.id,
        ),
      );
    }
    const seen = new Set([construct.id]);
    let parentId = construct.parentId;
    while (parentId && constructById.has(parentId)) {
      if (seen.has(parentId)) {
        problems.push(
          problem(
            "construct-parent-cycle",
            "construct",
            construct.id || "-",
            parentId,
          ),
        );
        break;
      }
      seen.add(parentId);
      parentId = constructById.get(parentId).parentId;
    }
  }

  const selectorTies = new Map();
  for (const selector of selectors) {
    const subject = constructById.get(selector.subjectId);
    if (!subject) {
      problems.push(
        problem(
          "selector-subject-unknown",
          "selector",
          selector.id || "-",
          selector.subjectId || "missing",
        ),
      );
    }
    if (subject && subject.unitName !== selector.unitName) {
      problems.push(
        problem(
          "selector-subject-cross-unit",
          "selector",
          selector.id || "-",
          selector.subjectId,
        ),
      );
    }
    if (!Number.isFinite(selector.priority) || !Number.isFinite(selector.tieBreakRank)) {
      problems.push(
        problem("selector-rank-invalid", "selector", selector.id || "-", "non-numeric"),
      );
    }
    const tieKey = [
      selector.sourcePath,
      selector.startLine,
      selector.startColumn,
      selector.endLine,
      selector.endColumn,
      selector.priority,
      selector.tieBreakRank,
    ].join("\u001f");
    const previous = selectorTies.get(tieKey);
    if (previous && previous.subjectId !== selector.subjectId) {
      problems.push(
        problem("selector-tie-ambiguous", "selector", selector.id, previous.id),
      );
    } else selectorTies.set(tieKey, selector);
  }

  for (const scope of scopeById.values()) {
    if (scope.kind === "function") {
      const construct = constructById.get(scope.functionConstructId);
      if (
        !construct ||
        construct.category !== "expression" ||
        construct.unitName !== scope.unitName
      ) {
        problems.push(
          problem(
            "function-scope-construct-invalid",
            "scope",
            scope.id || "-",
            scope.functionConstructId || "missing",
          ),
        );
      }
    } else if (scope.functionConstructId) {
      problems.push(
        problem(
          "top-level-scope-function",
          "scope",
          scope.id || "-",
          scope.functionConstructId,
        ),
      );
    }
  }

  const traceSiteIds = new Set();
  for (const trace of traces) {
    const siteId = String(trace?.siteId || "");
    if (!siteId) {
      problems.push(
        problem(
          "trace-site-missing",
          "trace",
          String(trace?.occurrenceId || "-"),
          `sequence ${trace?.sequence ?? "-"}`,
        ),
      );
      continue;
    }
    traceSiteIds.add(siteId);
    if (!constructById.has(siteId)) {
      problems.push(
        problem(
          "trace-site-unknown",
          "trace",
          String(trace?.occurrenceId || "-"),
          `sequence ${trace?.sequence ?? "-"} refers to ${siteId}`,
        ),
      );
    }
  }

  const orderedConstructs = Object.freeze(
    constructs
      .sort(compareConstruct)
      .map((construct, index) =>
        Object.freeze({ ...construct, alias: aliasFor(index) }),
      ),
  );
  const aliasedConstructById = new Map(
    orderedConstructs.map((construct) => [construct.id, construct]),
  );
  const orderedSelectors = Object.freeze(
    selectors
      .sort(compareSelector)
      .map((selector, index) =>
        Object.freeze({ ...selector, alias: aliasFor(index) }),
      ),
  );
  const aliasedSelectorById = new Map(
    orderedSelectors.map((selector) => [selector.id, selector]),
  );
  const orderedUnits = Object.freeze(
    units.map((unit) =>
      Object.freeze({
        unitName: unit.unitName,
        generatedPath: unit.generatedPath,
        byteLength: unit.byteLength,
        sourceDigest: unit.sourceDigest,
        topLevelScopeId: unit.topLevelScopeId,
        executionScopes: unit.executionScopes,
        constructs: Object.freeze(
          unit.constructs.map((construct) =>
            aliasedConstructById.get(construct.id),
          ),
        ),
        selectors: Object.freeze(
          unit.selectors.map((selector) => aliasedSelectorById.get(selector.id)),
        ),
      }),
    ),
  );
  const orderedProblems = Object.freeze(
    problems.sort(
      (left, right) =>
        compareText(left.code, right.code) ||
        compareText(left.entityType, right.entityType) ||
        compareText(left.entityId, right.entityId) ||
        compareText(left.detail, right.detail),
    ),
  );

  return Object.freeze({
    schemaVersion: 1,
    path: String(payload?.path || ""),
    projectVersion: String(payload?.projectVersion || ""),
    evaluationId: String(payload?.evaluation?.evaluationId || ""),
    status: String(payload?.evaluation?.status || ""),
    units: orderedUnits,
    constructs: orderedConstructs,
    selectors: orderedSelectors,
    traceCount: traces.length,
    traceSiteIds: Object.freeze([...traceSiteIds].sort(compareText)),
    reachedConstructIds: Object.freeze(
      orderedConstructs
        .filter((construct) => traceSiteIds.has(construct.id))
        .map((construct) => construct.id),
    ),
    problems: orderedProblems,
    valid: orderedProblems.length === 0,
  });
}

export function compilerContractCaptureToJson(capture) {
  return {
    schemaVersion: capture.schemaVersion,
    path: capture.path,
    projectVersion: capture.projectVersion,
    evaluationId: capture.evaluationId,
    status: capture.status,
    units: capture.units.map((unit) => ({
      unitName: unit.unitName,
      generatedPath: unit.generatedPath,
      byteLength: unit.byteLength,
      sourceDigest: unit.sourceDigest,
      topLevelScopeId: unit.topLevelScopeId,
      executionScopes: unit.executionScopes,
      constructIds: unit.constructs.map((construct) => construct.id),
      selectorIds: unit.selectors.map((selector) => selector.id),
    })),
    constructs: capture.constructs.map((construct) => ({
      ...construct,
      reached: capture.traceSiteIds.includes(construct.id),
    })),
    selectors: capture.selectors,
    traceCount: capture.traceCount,
    traceSiteIds: capture.traceSiteIds,
    problems: capture.problems,
  };
}

export function renderCompilerContractCapture(capture) {
  const lines = [
    `artifact ${capture.evaluationId || "-"}  status ${capture.status || "-"}`,
    `units ${capture.units.length}  constructs ${capture.constructs.length}  selectors ${capture.selectors.length}  trace-events ${capture.traceCount}  reached ${capture.reachedConstructIds.length}`,
    capture.valid ? "invariants ok" : `invariants ${capture.problems.length} failed`,
  ];
  for (const unit of capture.units) {
    lines.push(`\n${unit.unitName}  ${unit.constructs.length} constructs`);
    for (const construct of unit.constructs) {
      const reached = capture.traceSiteIds.includes(construct.id) ? "●" : "·";
      const ghost = construct.ghost ? " ghost" : "";
      lines.push(
        `${construct.alias.padStart(3)} ${reached} ${construct.category.padEnd(10)} ${construct.sourcePath}:${construct.startLine}:${construct.startColumn}-${construct.endLine}:${construct.endColumn}${ghost}  ${construct.id}`,
      );
    }
  }
  const semanticSelectors = capture.selectors.filter(
    (selector) => selector.role !== "construct",
  );
  if (semanticSelectors.length) {
    lines.push("\nselectors");
    const constructAlias = new Map(
      capture.constructs.map((construct) => [construct.id, construct.alias]),
    );
    for (const selector of semanticSelectors) {
      lines.push(
        `${selector.alias.padStart(3)} ${selector.role.padEnd(9)} -> ${constructAlias.get(selector.subjectId) || "?"}  ${selector.sourcePath}:${selector.startLine}:${selector.startColumn}-${selector.endLine}:${selector.endColumn}`,
      );
    }
  }
  if (capture.problems.length) {
    lines.push("\nproblems");
    for (const item of capture.problems) {
      lines.push(
        `${item.code} ${item.entityType}:${item.entityId} ${item.detail}`,
      );
    }
  }
  return lines.join("\n");
}

const snapshotStores = new WeakMap();

function copyFreeze(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(copyFreeze));
  if (!value || typeof value !== "object") return value;
  const copy = {};
  for (const key of Object.keys(value)) copy[key] = copyFreeze(value[key]);
  return Object.freeze(copy);
}

function collectUnique(records, entityType, problems) {
  const store = new Map();
  if (!Array.isArray(records)) {
    problems.push(
      problem(`${entityType}-table-invalid`, entityType, "-", "expected array"),
    );
    return store;
  }
  for (const record of records) {
    const id = String(record?.id || "");
    if (!id) {
      problems.push(
        problem(`${entityType}-id-missing`, entityType, "-", "ID is empty"),
      );
    } else if (store.has(id)) {
      problems.push(
        problem(`${entityType}-id-duplicate`, entityType, id, "duplicate ID"),
      );
    } else {
      store.set(id, copyFreeze(record));
    }
  }
  return store;
}

function collection(value, entityType, problems) {
  if (Array.isArray(value)) return value;
  problems.push(
    problem(`${entityType}-table-invalid`, entityType, "-", "expected array"),
  );
  return [];
}

function recordArray(value, entityType, entityId, field, problems) {
  if (Array.isArray(value)) return value;
  problems.push(
    problem(
      `${entityType}-${field}-invalid`,
      entityType,
      String(entityId || "-"),
      "expected array",
    ),
  );
  return [];
}

function validCapturedValue(value) {
  return Boolean(
    value &&
      typeof value.type === "string" &&
      typeof value.display === "string" &&
      typeof value.complete === "boolean" &&
      (value.complete || value.fingerprint === null) &&
      (value.fingerprint === null || typeof value.fingerprint === "string"),
  );
}

function validateOutcome(record, entityType, problems) {
  const outcome = record?.outcome;
  if (
    !outcome ||
    !outcomeKinds.has(outcome.kind) ||
    !outcomeSources.has(outcome.source) ||
    (outcome.kind === "incomplete" && outcome.value != null) ||
    (outcome.kind !== "incomplete" && !validCapturedValue(outcome.value))
  ) {
    problems.push(
      problem(
        `${entityType}-outcome-invalid`,
        entityType,
        String(record?.id || "-"),
        String(outcome?.kind || "missing"),
      ),
    );
  }
  if (
    outcome &&
    ((record.outcomeAt === null && outcome.kind !== "incomplete") ||
      (record.outcomeAt !== null && outcome.kind === "incomplete"))
  ) {
    problems.push(
      problem(
        `${entityType}-outcome-time-mismatch`,
        entityType,
        String(record?.id || "-"),
        `${String(record.outcomeAt)}:${outcome.kind}`,
      ),
    );
  }
}

function validSequence(value, finalSequence, { nullable = false } = {}) {
  return (
    (nullable && value === null) ||
    (Number.isInteger(value) &&
      value >= 0 &&
      (!Number.isInteger(finalSequence) || value <= finalSequence))
  );
}

function validateParentCycles(store, parentKey, entityType, problems) {
  for (const record of store.values()) {
    const seen = new Set([record.id]);
    let parentId = record[parentKey];
    while (parentId && store.has(parentId)) {
      if (seen.has(parentId)) {
        problems.push(
          problem(
            `${entityType}-parent-cycle`,
            entityType,
            record.id,
            parentId,
          ),
        );
        break;
      }
      seen.add(parentId);
      parentId = store.get(parentId)[parentKey];
    }
  }
}

function addIndex(index, key, value) {
  if (!index.has(key)) index.set(key, []);
  index.get(key).push(value);
}

function freezeOrderedIndex(index, compare) {
  for (const [key, values] of index) {
    index.set(key, Object.freeze(values.sort(compare)));
  }
  return index;
}

function snapshotResult(problems, snapshot = null) {
  const ordered = Object.freeze(
    problems.sort(
      (left, right) =>
        compareText(left.code, right.code) ||
        compareText(left.entityType, right.entityType) ||
        compareText(left.entityId, right.entityId) ||
        compareText(left.detail, right.detail),
    ),
  );
  return Object.freeze({
    ok: ordered.length === 0,
    snapshot: ordered.length === 0 ? snapshot : null,
    problems: ordered,
  });
}

/** Build and atomically publish the immutable normalized execution snapshot. */
export function buildExecutionSnapshot(envelope) {
  const problems = [];
  if (envelope?.schemaVersion !== 1) {
    problems.push(
      problem(
        "envelope-schema-unsupported",
        "envelope",
        String(envelope?.evaluationId || "-"),
        String(envelope?.schemaVersion ?? "missing"),
      ),
    );
  }
  for (const [field, value] of [
    ["evaluationId", envelope?.evaluationId],
    ["requestCodeDigest", envelope?.requestCodeDigest],
    ["projectDigest", envelope?.projectDigest],
    ["codeRevisionId", envelope?.codeRevisionId],
    ["compilerInputsDigest", envelope?.compilerInputsDigest],
    ["artifactChecksum", envelope?.artifactChecksum],
  ]) {
    if (typeof value !== "string" || value.length === 0) {
      problems.push(
        problem("envelope-field-missing", "envelope", field, "required"),
      );
    }
  }
  for (const [field, value] of [
    ["documentRevisionId", envelope?.sourceMaps?.documentRevisionId],
    ["codeRevisionId", envelope?.sourceMaps?.codeRevisionId],
    ["sourcesDigest", envelope?.sourceMaps?.sourcesDigest],
    ["extractedCodeDigest", envelope?.sourceMaps?.extractedCodeDigest],
  ]) {
    if (typeof value !== "string" || value.length === 0) {
      problems.push(
        problem("source-map-field-missing", "source-map", field, "required"),
      );
    }
  }
  if (
    envelope?.staticProgram?.codeRevisionId !== envelope?.codeRevisionId ||
    envelope?.sourceMaps?.codeRevisionId !== envelope?.codeRevisionId
  ) {
    problems.push(
      problem(
        "code-revision-mismatch",
        "envelope",
        String(envelope?.evaluationId || "-"),
        "static program, source map, and envelope must match",
      ),
    );
  }
  if (
    envelope?.terminal?.checksum !==
    executionTerminalChecksum(envelope?.terminal)
  ) {
    problems.push(
      problem(
        "terminal-checksum-invalid",
        "terminal",
        String(envelope?.evaluationId || "-"),
        "terminal fields do not match checksum",
      ),
    );
  }
  if (envelope?.artifactChecksum !== executionArtifactChecksum(envelope)) {
    problems.push(
      problem(
        "artifact-checksum-invalid",
        "envelope",
        String(envelope?.evaluationId || "-"),
        "artifact fields do not match checksum",
      ),
    );
  }
  if (
    envelope?.staticProgram?.compilerInputsDigest !==
    envelope?.compilerInputsDigest
  ) {
    problems.push(
      problem(
        "compiler-inputs-mismatch",
        "envelope",
        String(envelope?.evaluationId || "-"),
        "static program and envelope must match",
      ),
    );
  }

  const staticProgram = envelope?.staticProgram || {};
  const execution = envelope?.execution || {};
  const unitById = collectUnique(
    staticProgram.compilationUnits,
    "unit",
    problems,
  );
  const scopeById = collectUnique(
    staticProgram.executionScopes,
    "scope",
    problems,
  );
  const constructById = collectUnique(
    staticProgram.constructs,
    "construct",
    problems,
  );
  const selectorById = collectUnique(
    staticProgram.selectors,
    "selector",
    problems,
  );
  const occurrenceById = collectUnique(
    execution.occurrences,
    "occurrence",
    problems,
  );
  const activationById = collectUnique(
    execution.activations,
    "activation",
    problems,
  );
  const closureById = collectUnique(execution.closures, "closure", problems);
  const callAttemptById = collectUnique(
    execution.callAttempts,
    "call-attempt",
    problems,
  );
  const writeById = collectUnique(execution.writes, "write", problems);
  const events = Array.isArray(execution.events)
    ? execution.events.map((event) => freezeRecord(event))
    : [];
  const finalSequence = envelope?.terminal?.finalSequence;
  if (!Number.isInteger(finalSequence) || finalSequence < 0) {
    problems.push(
      problem(
        "terminal-sequence-invalid",
        "terminal",
        String(envelope?.evaluationId || "-"),
        String(finalSequence ?? "missing"),
      ),
    );
  }

  for (const [index, event] of events.entries()) {
    if (
      !validSequence(event.sequence, finalSequence) ||
      !executionEventKinds.has(event.kind) ||
      typeof event.id !== "string" ||
      typeof event.content !== "string" ||
      !(
        event.parentOccurrenceId == null ||
        typeof event.parentOccurrenceId === "string"
      ) ||
      (event.parentOccurrenceId != null &&
        !occurrenceById.has(event.parentOccurrenceId))
    ) {
      problems.push(
        problem(
          "execution-event-invalid",
          "event",
          String(index),
          `${event.sequence ?? "-"}:${event.kind ?? "-"}`,
        ),
      );
    }
  }

  const unitByGeneratedPath = new Map();
  for (const unit of unitById.values()) {
    if (
      !unit.generatedPath ||
      typeof unit.sourceDigest !== "string" ||
      unit.sourceDigest.length === 0 ||
      !Number.isInteger(unit.byteLength) ||
      unit.byteLength < 0
    ) {
      problems.push(
        problem("unit-source-invalid", "unit", unit.id, String(unit.generatedPath)),
      );
    } else if (unitByGeneratedPath.has(unit.generatedPath)) {
      problems.push(
        problem(
          "unit-generated-path-duplicate",
          "unit",
          unit.id,
          unit.generatedPath,
        ),
      );
    } else unitByGeneratedPath.set(unit.generatedPath, unit);
    const topLevelScope = scopeById.get(unit.topLevelScopeId);
    if (
      !topLevelScope ||
      topLevelScope.kind !== "top-level" ||
      topLevelScope.unitId !== unit.id
    ) {
      problems.push(
        problem(
          "unit-top-level-scope-invalid",
          "unit",
          unit.id,
          String(unit.topLevelScopeId),
        ),
      );
    }
  }

  for (const construct of constructById.values()) {
    if (construct.category !== "expression" && construct.category !== "pattern") {
      problems.push(
        problem(
          "construct-category-invalid",
          "construct",
          construct.id,
          String(construct.category || "missing"),
        ),
      );
    }
    if (!constructSemanticKinds.has(construct.semanticKind)) {
      problems.push(
        problem(
          "construct-semantic-kind-invalid",
          "construct",
          construct.id,
          String(construct.semanticKind || "missing"),
        ),
      );
    }
    if (construct.parentId && !constructById.has(construct.parentId)) {
      problems.push(
        problem(
          "construct-parent-unknown",
          "construct",
          construct.id,
          construct.parentId,
        ),
      );
    }
    if (!scopeById.has(construct.ownerScopeId)) {
      problems.push(
        problem(
          "construct-scope-unknown",
          "construct",
          construct.id,
          String(construct.ownerScopeId || "missing"),
        ),
      );
    }
    if (!scopeById.has(construct.lexicalScopeId)) {
      problems.push(
        problem(
          "construct-lexical-scope-unknown",
          "construct",
          construct.id,
          String(construct.lexicalScopeId || "missing"),
        ),
      );
    }
    const range = construct.compilerRange || {};
    const unit = unitByGeneratedPath.get(range.generatedPath);
    if (
      !unit ||
      !Number.isInteger(range.startByte) ||
      !Number.isInteger(range.endByte) ||
      range.startByte < 0 ||
      range.endByte < range.startByte ||
      range.endByte > unit.byteLength
    ) {
      problems.push(
        problem(
          "construct-compiler-range-invalid",
          "construct",
          construct.id,
          `${range.generatedPath}:${range.startByte}-${range.endByte}`,
        ),
      );
    }
    const ownerScope = scopeById.get(construct.ownerScopeId);
    const lexicalScope = scopeById.get(construct.lexicalScopeId);
    if (unit && ownerScope && ownerScope.unitId !== unit.id) {
      problems.push(
        problem(
          "construct-owner-scope-cross-unit",
          "construct",
          construct.id,
          `${unit.id}:${ownerScope.unitId}`,
        ),
      );
    }
    if (unit && lexicalScope && lexicalScope.unitId !== unit.id) {
      problems.push(
        problem(
          "construct-lexical-scope-cross-unit",
          "construct",
          construct.id,
          `${unit.id}:${lexicalScope.unitId}`,
        ),
      );
    }
    const parent = construct.parentId
      ? constructById.get(construct.parentId)
      : null;
    const parentUnit = parent
      ? unitByGeneratedPath.get(parent.compilerRange?.generatedPath)
      : null;
    if (unit && parentUnit && parentUnit.id !== unit.id) {
      problems.push(
        problem(
          "construct-parent-cross-unit",
          "construct",
          construct.id,
          parent.id,
        ),
      );
    }
  }
  validateParentCycles(constructById, "parentId", "construct", problems);

  for (const scope of scopeById.values()) {
    if (!unitById.has(scope.unitId)) {
      problems.push(
        problem("scope-unit-unknown", "scope", scope.id, String(scope.unitId)),
      );
    }
    if (
      scope.kind === "function" &&
      !constructById.has(scope.functionConstructId)
    ) {
      problems.push(
        problem(
          "scope-function-unknown",
          "scope",
          scope.id,
          String(scope.functionConstructId || "missing"),
        ),
      );
    }
    const functionConstruct = scope.functionConstructId
      ? constructById.get(scope.functionConstructId)
      : null;
    const functionUnit = functionConstruct
      ? unitByGeneratedPath.get(functionConstruct.compilerRange?.generatedPath)
      : null;
    if (
      scope.kind === "function" &&
      functionUnit &&
      functionUnit.id !== scope.unitId
    ) {
      problems.push(
        problem(
          "scope-function-cross-unit",
          "scope",
          scope.id,
          `${scope.unitId}:${functionUnit.id}`,
        ),
      );
    }
    if (scope.kind === "top-level" && scope.functionConstructId) {
      problems.push(
        problem(
          "top-level-scope-function",
          "scope",
          scope.id,
          scope.functionConstructId,
        ),
      );
    }
  }

  const selectorTie = new Map();
  for (const selector of selectorById.values()) {
    if (!constructById.has(selector.subjectId)) {
      problems.push(
        problem(
          "selector-subject-unknown",
          "selector",
          selector.id,
          String(selector.subjectId),
        ),
      );
    }
    if (!Number.isInteger(selector.priority)) {
      problems.push(
        problem("selector-priority-invalid", "selector", selector.id, "NaN"),
      );
    }
    if (!Number.isInteger(selector.tieBreakRank)) {
      problems.push(
        problem("selector-tie-break-rank-invalid", "selector", selector.id, "NaN"),
      );
    }
    if (!selectorRoles.has(selector.role)) {
      problems.push(
        problem(
          "selector-role-invalid",
          "selector",
          selector.id,
          String(selector.role || "missing"),
        ),
      );
    }
    const range = selector.compilerRange || {};
    const unit = unitByGeneratedPath.get(range.generatedPath);
    if (
      !unit ||
      !Number.isInteger(range.startByte) ||
      !Number.isInteger(range.endByte) ||
      range.startByte < 0 ||
      range.endByte < range.startByte ||
      range.endByte > unit.byteLength
    ) {
      problems.push(
        problem(
          "selector-compiler-range-invalid",
          "selector",
          selector.id,
          `${range.generatedPath}:${range.startByte}-${range.endByte}`,
        ),
      );
    }
    const subject = constructById.get(selector.subjectId);
    const subjectUnit = subject
      ? unitByGeneratedPath.get(subject.compilerRange?.generatedPath)
      : null;
    if (unit && subjectUnit && subjectUnit.id !== unit.id) {
      problems.push(
        problem(
          "selector-subject-cross-unit",
          "selector",
          selector.id,
          selector.subjectId,
        ),
      );
    }
    const key = [
      range.generatedPath,
      range.startByte,
      range.endByte,
      selector.priority,
      selector.tieBreakRank,
    ].join("\u001f");
    const prior = selectorTie.get(key);
    if (prior && prior.subjectId !== selector.subjectId) {
      problems.push(
        problem(
          "selector-tie-ambiguous",
          "selector",
          selector.id,
          prior.id,
        ),
      );
    } else selectorTie.set(key, selector);
  }

  const membershipCount = new Map();
  for (const occurrence of occurrenceById.values()) {
    if (!occurrenceKinds.has(occurrence.kind)) {
      problems.push(
        problem(
          "occurrence-kind-invalid",
          "occurrence",
          occurrence.id,
          String(occurrence.kind || "missing"),
        ),
      );
    }
    validateOutcome(occurrence, "occurrence", problems);
    if (!constructById.has(occurrence.constructId)) {
      problems.push(
        problem(
          "occurrence-construct-unknown",
          "occurrence",
          occurrence.id,
          String(occurrence.constructId),
        ),
      );
    }
    const activation = activationById.get(occurrence.activationId);
    if (!activation) {
      problems.push(
        problem(
          "occurrence-activation-unknown",
          "occurrence",
          occurrence.id,
          String(occurrence.activationId),
        ),
      );
    } else {
      const construct = constructById.get(occurrence.constructId);
      const isFunctionBoundary =
        occurrence.kind === "function" &&
        occurrence.id === activation.functionOccurrenceId &&
        occurrence.constructId === activation.functionConstructId;
      const isSyntheticFunctionParameter =
        occurrence.kind === "parameter" &&
        occurrence.constructId === activation.functionConstructId &&
        occurrence.parentOccurrenceId === activation.functionOccurrenceId &&
        Array.isArray(activation.parameterOccurrenceIds) &&
        activation.parameterOccurrenceIds.includes(occurrence.id);
      if (
        construct &&
        !isFunctionBoundary &&
        !isSyntheticFunctionParameter &&
        construct.ownerScopeId !== activation.scopeId
      ) {
        problems.push(
          problem(
            "occurrence-execution-scope-mismatch",
            "occurrence",
            occurrence.id,
            `${construct.ownerScopeId}:${activation.scopeId}`,
          ),
        );
      }
    }
    if (occurrence.parentOccurrenceId) {
      const parent = occurrenceById.get(occurrence.parentOccurrenceId);
      if (!parent) {
        problems.push(
          problem(
            "occurrence-parent-unknown",
            "occurrence",
            occurrence.id,
            occurrence.parentOccurrenceId,
          ),
        );
      } else if (parent.activationId !== occurrence.activationId) {
        problems.push(
          problem(
            "occurrence-parent-cross-activation",
            "occurrence",
            occurrence.id,
            parent.id,
          ),
        );
      }
    }
    if (
      !validSequence(occurrence.enteredAt, finalSequence) ||
      !validSequence(occurrence.outcomeAt, finalSequence, { nullable: true }) ||
      (occurrence.outcomeAt !== null && occurrence.outcomeAt < occurrence.enteredAt)
    ) {
      problems.push(
        problem(
          "occurrence-time-invalid",
          "occurrence",
          occurrence.id,
          `${occurrence.enteredAt}:${occurrence.outcomeAt}`,
        ),
      );
    }
  }
  validateParentCycles(
    occurrenceById,
    "parentOccurrenceId",
    "occurrence",
    problems,
  );

  for (const activation of activationById.values()) {
    const activationOccurrenceIds = recordArray(
      activation.occurrenceIds,
      "activation",
      activation.id,
      "occurrence-ids",
      problems,
    );
    const parameterOccurrenceIds = recordArray(
      activation.parameterOccurrenceIds,
      "activation",
      activation.id,
      "parameter-occurrence-ids",
      problems,
    );
    validateOutcome(activation, "activation", problems);
    if (
      !validSequence(activation.enteredAt, finalSequence) ||
      !validSequence(activation.outcomeAt, finalSequence, { nullable: true }) ||
      (activation.outcomeAt !== null && activation.outcomeAt < activation.enteredAt)
    ) {
      problems.push(
        problem(
          "activation-time-invalid",
          "activation",
          activation.id,
          `${activation.enteredAt}:${activation.outcomeAt}`,
        ),
      );
    }
    if (
      !activation.signature ||
      typeof activation.signature.functionKey !== "string" ||
      !Array.isArray(activation.signature.parameterFingerprints)
    ) {
      problems.push(
        problem(
          "activation-signature-invalid",
          "activation",
          activation.id,
          "malformed signature",
        ),
      );
    }
    if (!scopeById.has(activation.scopeId)) {
      problems.push(
        problem(
          "activation-scope-unknown",
          "activation",
          activation.id,
          String(activation.scopeId),
        ),
      );
    }
    const scope = scopeById.get(activation.scopeId);
    if (
      scope?.kind === "top-level" &&
      (activation.functionConstructId !== null || activation.functionOccurrenceId !== null)
    ) {
      problems.push(
        problem(
          "activation-top-level-function-invalid",
          "activation",
          activation.id,
          String(activation.functionConstructId || activation.functionOccurrenceId || "missing"),
        ),
      );
    }
    if (scope?.kind === "function" && !activation.functionOccurrenceId) {
      problems.push(
        problem(
          "activation-function-occurrence-invalid",
          "activation",
          activation.id,
          "missing",
        ),
      );
    }
    if (
      scope?.kind === "function" &&
      (scope.functionConstructId !== activation.functionConstructId ||
        !constructById.has(activation.functionConstructId))
    ) {
      problems.push(
        problem(
          "activation-function-construct-invalid",
          "activation",
          activation.id,
          String(activation.functionConstructId || "missing"),
        ),
      );
    }
    if (activation.closureId) {
      const closure = closureById.get(activation.closureId);
      if (!closure) {
        problems.push(
          problem(
            "activation-closure-unknown",
            "activation",
            activation.id,
            activation.closureId,
          ),
        );
      } else if (closure.functionConstructId !== activation.functionConstructId) {
        problems.push(
          problem(
            "activation-closure-function-mismatch",
            "activation",
            activation.id,
            activation.closureId,
          ),
        );
      }
    }
    if (activation.callsiteOccurrenceId) {
      const callsite = occurrenceById.get(activation.callsiteOccurrenceId);
      if (!callsite || callsite.kind !== "call") {
        problems.push(
          problem(
            "activation-callsite-invalid",
            "activation",
            activation.id,
            activation.callsiteOccurrenceId,
          ),
        );
      } else if (activation.dynamicParentId !== callsite.activationId) {
        problems.push(
          problem(
            "activation-callsite-parent-mismatch",
            "activation",
            activation.id,
            `${activation.dynamicParentId || "missing"}:${callsite.activationId}`,
          ),
        );
      }
    }
    if (
      activation.consumedCallAttemptId &&
      !callAttemptById.has(activation.consumedCallAttemptId)
    ) {
      problems.push(
        problem(
          "activation-call-attempt-unknown",
          "activation",
          activation.id,
          activation.consumedCallAttemptId,
        ),
      );
    }
    if (activation.dynamicParentId) {
      const parent = activationById.get(activation.dynamicParentId);
      if (!parent) {
        problems.push(
          problem(
            "activation-parent-unknown",
            "activation",
            activation.id,
            activation.dynamicParentId,
          ),
        );
      } else if (
        parent.enteredAt > activation.enteredAt ||
        (parent.outcomeAt !== null && parent.outcomeAt < activation.enteredAt)
      ) {
        problems.push(
          problem(
            "activation-parent-not-active",
            "activation",
            activation.id,
            parent.id,
          ),
        );
      }
    }
    for (const occurrenceId of activationOccurrenceIds) {
      membershipCount.set(
        occurrenceId,
        (membershipCount.get(occurrenceId) || 0) + 1,
      );
      const occurrence = occurrenceById.get(occurrenceId);
      if (!occurrence || occurrence.activationId !== activation.id) {
        problems.push(
          problem(
            "activation-occurrence-invalid",
            "activation",
            activation.id,
            occurrenceId,
          ),
        );
      }
    }
    if (activation.functionOccurrenceId) {
      const occurrence = occurrenceById.get(activation.functionOccurrenceId);
      if (
        !occurrence ||
        occurrence.activationId !== activation.id ||
        occurrence.kind !== "function" ||
        occurrence.constructId !== activation.functionConstructId
      ) {
        problems.push(
          problem(
            "activation-function-occurrence-invalid",
            "activation",
            activation.id,
            activation.functionOccurrenceId,
          ),
        );
      }
    }
    for (const occurrenceId of parameterOccurrenceIds) {
      const occurrence = occurrenceById.get(occurrenceId);
      if (
        !occurrence ||
        occurrence.activationId !== activation.id ||
        occurrence.kind !== "parameter" ||
        occurrence.parentOccurrenceId !== activation.functionOccurrenceId
      ) {
        problems.push(
          problem(
            "activation-parameter-invalid",
            "activation",
            activation.id,
            occurrenceId,
          ),
        );
      }
    }
  }
  for (const occurrence of occurrenceById.values()) {
    if (occurrence.kind !== "parameter") continue;
    const activation = activationById.get(occurrence.activationId);
    if (
      activation &&
      (!Array.isArray(activation.parameterOccurrenceIds) ||
        !activation.parameterOccurrenceIds.includes(occurrence.id))
    ) {
      problems.push(
        problem(
          "occurrence-parameter-unlisted",
          "occurrence",
          occurrence.id,
          activation.id,
        ),
      );
    }
  }
  validateParentCycles(
    activationById,
    "dynamicParentId",
    "activation",
    problems,
  );
  for (const occurrence of occurrenceById.values()) {
    if (membershipCount.get(occurrence.id) !== 1) {
      problems.push(
        problem(
          "occurrence-membership-invalid",
          "occurrence",
          occurrence.id,
          String(membershipCount.get(occurrence.id) || 0),
        ),
      );
    }
  }

  for (const closure of closureById.values()) {
    if (!validSequence(closure.createdAt, finalSequence)) {
      problems.push(
        problem(
          "closure-time-invalid",
          "closure",
          closure.id,
          String(closure.createdAt),
        ),
      );
    }
    if (!constructById.has(closure.functionConstructId)) {
      problems.push(
        problem(
          "closure-function-unknown",
          "closure",
          closure.id,
          String(closure.functionConstructId),
        ),
      );
    }
    if (
      closure.originActivationId &&
      !activationById.has(closure.originActivationId)
    ) {
      problems.push(
        problem(
          "closure-origin-unknown",
          "closure",
          closure.id,
          closure.originActivationId,
        ),
      );
    }
  }
  const closureProvenance = collection(
    execution.closureProvenance,
    "closure-provenance",
    problems,
  ).map(copyFreeze);
  for (const [index, provenance] of closureProvenance.entries()) {
    if (!provenance || typeof provenance !== "object") {
      problems.push(
        problem(
          "closure-provenance-record-invalid",
          "closure-provenance",
          String(index),
          "expected object",
        ),
      );
      continue;
    }
    const provenanceId = `${provenance.closureId || "-"}:${provenance.sequence ?? index}`;
    if (provenance.kind !== "derived") {
      problems.push(
        problem(
          "closure-provenance-kind-invalid",
          "closure-provenance",
          provenanceId,
          String(provenance.kind || "missing"),
        ),
      );
    }
    if (!closureById.has(provenance.closureId)) {
      problems.push(
        problem(
          "closure-provenance-closure-unknown",
          "closure-provenance",
          provenanceId,
          String(provenance.closureId),
        ),
      );
    }
    if (provenance.activationId && !activationById.has(provenance.activationId)) {
      problems.push(
        problem(
          "closure-provenance-activation-unknown",
          "closure-provenance",
          provenanceId,
          provenance.activationId,
        ),
      );
    }
    if (
      provenance.callsiteOccurrenceId &&
      !occurrenceById.has(provenance.callsiteOccurrenceId)
    ) {
      problems.push(
        problem(
          "closure-provenance-callsite-unknown",
          "closure-provenance",
          provenanceId,
          provenance.callsiteOccurrenceId,
        ),
      );
    }
    if (!validSequence(provenance.sequence, finalSequence)) {
      problems.push(
        problem(
          "closure-provenance-time-invalid",
          "closure-provenance",
          provenanceId,
          String(provenance.sequence),
        ),
      );
    }
    if (provenance.kind === "derived") {
      if (
        !provenance.sourceClosureId ||
        !closureById.has(provenance.sourceClosureId) ||
        provenance.sourceClosureId === provenance.closureId
      ) {
        problems.push(
          problem(
            "closure-provenance-source-invalid",
            "closure-provenance",
            provenanceId,
            String(provenance.sourceClosureId || "missing"),
          ),
        );
      }
    }
  }
  for (const attempt of callAttemptById.values()) {
    const producerActivationIds = recordArray(
      attempt.producerActivationIds,
      "call-attempt",
      attempt.id,
      "producer-activation-ids",
      problems,
    );
    validateOutcome(attempt, "call-attempt", problems);
    if (
      typeof attempt.tail !== "boolean" ||
      !validSequence(attempt.openedAt, finalSequence) ||
      !validSequence(attempt.outcomeAt, finalSequence, { nullable: true }) ||
      (attempt.outcomeAt !== null && attempt.outcomeAt < attempt.openedAt)
    ) {
      problems.push(
        problem(
          "call-attempt-time-invalid",
          "call-attempt",
          attempt.id,
          `${attempt.openedAt}:${attempt.outcomeAt}`,
        ),
      );
    }
    const owner = activationById.get(attempt.ownerActivationId);
    const call = occurrenceById.get(attempt.callOccurrenceId);
    if (!owner || !call || call.kind !== "call" || call.activationId !== owner.id) {
      problems.push(
        problem(
          "call-attempt-owner-invalid",
          "call-attempt",
          attempt.id,
          `${attempt.ownerActivationId}:${attempt.callOccurrenceId}`,
        ),
      );
    }
    for (const producerId of producerActivationIds) {
      const producer = activationById.get(producerId);
      if (!producer || producer.consumedCallAttemptId !== attempt.id) {
        problems.push(
          problem(
            "call-attempt-producer-unknown",
            "call-attempt",
            attempt.id,
            producerId,
          ),
        );
      }
    }
  }
  for (const activation of activationById.values()) {
    if (activation.consumedCallAttemptId) {
      const attempt = callAttemptById.get(activation.consumedCallAttemptId);
      if (
        !Array.isArray(attempt?.producerActivationIds) ||
        !attempt.producerActivationIds.includes(activation.id)
      ) {
        problems.push(
          problem(
            "activation-call-attempt-unlisted",
            "activation",
            activation.id,
            activation.consumedCallAttemptId,
          ),
        );
      }
    }
  }
  for (const write of writeById.values()) {
    if (
      typeof write.operation !== "string" ||
      write.operation.length === 0 ||
      (write.targetId !== null &&
        (typeof write.targetId !== "string" || write.targetId.length === 0))
    ) {
      problems.push(
        problem(
          "write-metadata-invalid",
          "write",
          write.id,
          `${String(write.operation || "missing")}:${String(write.targetId)}`,
        ),
      );
    }
    if (!validSequence(write.sequence, finalSequence)) {
      problems.push(
        problem(
          "write-sequence-invalid",
          "write",
          write.id,
          String(write.sequence),
        ),
      );
    }
    if (!validCapturedValue(write.newValue)) {
      problems.push(
        problem(
          "write-value-invalid",
          "write",
          write.id,
          "newValue is not a captured value",
        ),
      );
    }
    if (write.oldValue !== null && !validCapturedValue(write.oldValue)) {
      problems.push(
        problem(
          "write-old-value-invalid",
          "write",
          write.id,
          "oldValue must be null or a captured value",
        ),
      );
    }
    const activation = activationById.get(write.activationId);
    const construct = constructById.get(write.constructId);
    if (!activation || !construct || construct.ownerScopeId !== activation.scopeId) {
      problems.push(
        problem(
          "write-owner-invalid",
          "write",
          write.id,
          `${write.activationId}:${write.constructId}`,
        ),
      );
    }
  }

  const terminal = envelope?.terminal || {};
  if (terminal.kind !== "complete" && terminal.kind !== "truncated") {
    problems.push(
      problem(
        "terminal-kind-invalid",
        "terminal",
        String(envelope?.evaluationId || "-"),
        String(terminal.kind || "missing"),
      ),
    );
  }
  const sourceMapEntries = collection(
    envelope?.sourceMaps?.entries,
    "source-map",
    problems,
  );
  let previousSourceMapKey = null;
  const sourceMapSelectorIds = new Set();
  for (const [index, entry] of sourceMapEntries.entries()) {
    if (!entry || typeof entry !== "object") {
      problems.push(
        problem(
          "source-map-entry-invalid",
          "source-map",
          String(index),
          "expected object",
        ),
      );
      continue;
    }
    const unit = unitByGeneratedPath.get(entry.generatedPath);
    const selector = selectorById.get(entry.selectorId);
    if (
      !unit ||
      typeof entry.selectorId !== "string" ||
      entry.selectorId.length === 0 ||
      typeof entry.generatedPath !== "string" ||
      typeof entry.documentPath !== "string" ||
      entry.documentPath.length === 0 ||
      !Number.isSafeInteger(entry.startByte) ||
      !Number.isSafeInteger(entry.endByte) ||
      entry.startByte < 0 ||
      entry.endByte < entry.startByte ||
      entry.endByte > unit.byteLength ||
      !Number.isSafeInteger(entry.startUtf16) ||
      !Number.isSafeInteger(entry.endUtf16) ||
      entry.startUtf16 < 0 ||
      entry.endUtf16 < entry.startUtf16
    ) {
      problems.push(
        problem(
          "source-map-entry-invalid",
          "source-map",
          String(index),
          `${entry.generatedPath}:${entry.startByte}-${entry.endByte}`,
        ),
      );
    }
    if (!selector) {
      problems.push(
        problem(
          "source-map-selector-unknown",
          "source-map",
          String(index),
          String(entry.selectorId || "missing"),
        ),
      );
    } else {
      const range = selector.compilerRange || {};
      if (
        range.generatedPath !== entry.generatedPath ||
        range.startByte !== entry.startByte ||
        range.endByte !== entry.endByte
      ) {
        problems.push(
          problem(
            "source-map-selector-range-mismatch",
            "source-map",
            String(index),
            entry.selectorId,
          ),
        );
      }
    }
    if (sourceMapSelectorIds.has(entry.selectorId)) {
      problems.push(
        problem(
          "source-map-selector-duplicate",
          "source-map",
          String(index),
          String(entry.selectorId),
        ),
      );
    }
    sourceMapSelectorIds.add(entry.selectorId);
    const key = `${entry.generatedPath}\u001f${String(entry.startByte).padStart(16, "0")}\u001f${String(entry.endByte).padStart(16, "0")}\u001f${entry.documentPath}\u001f${entry.selectorId}`;
    if (previousSourceMapKey && compareText(key, previousSourceMapKey) < 0) {
      problems.push(
        problem(
          "source-map-order-invalid",
          "source-map",
          String(index),
          entry.generatedPath,
        ),
      );
    }
    previousSourceMapKey = key;
  }
  for (const selector of selectorById.values()) {
    if (!sourceMapSelectorIds.has(selector.id)) {
      const range = selector.compilerRange || {};
      problems.push(
        problem(
          "selector-source-map-missing",
          "selector",
          selector.id,
          `${range.generatedPath}:${range.startByte}-${range.endByte}`,
        ),
      );
    }
  }
  if (terminal.kind === "complete") {
    for (const record of [
      ...occurrenceById.values(),
      ...activationById.values(),
      ...callAttemptById.values(),
    ]) {
      if (record.outcome?.kind === "incomplete" || record.outcomeAt === null) {
        problems.push(
          problem(
            "complete-artifact-unresolved",
            "runtime",
            record.id,
            "terminal is complete",
          ),
        );
      }
    }
  }

  if (problems.length) return snapshotResult(problems);

  const byEnteredAt = (leftId, rightId) => {
    const left = occurrenceById.get(leftId) || activationById.get(leftId);
    const right = occurrenceById.get(rightId) || activationById.get(rightId);
    return left.enteredAt - right.enteredAt || compareText(leftId, rightId);
  };
  const occurrenceIdsByConstruct = new Map();
  const occurrenceIdsByActivationAndConstruct = new Map();
  const activationIdsByConstruct = new Map();
  const executedConstructIdsByActivation = new Map();
  const constructIdsByExecutionScope = new Map();
  for (const construct of constructById.values()) {
    addIndex(
      constructIdsByExecutionScope,
      construct.ownerScopeId,
      construct.id,
    );
  }
  for (const [scopeId, constructIds] of constructIdsByExecutionScope) {
    constructIdsByExecutionScope.set(
      scopeId,
      Object.freeze(constructIds.sort(compareText)),
    );
  }
  for (const occurrence of occurrenceById.values()) {
    const activation = activationById.get(occurrence.activationId);
    const syntheticFunctionParameter =
      occurrence.kind === "parameter" &&
      activation?.functionConstructId === occurrence.constructId;
    if (!syntheticFunctionParameter) {
      addIndex(occurrenceIdsByConstruct, occurrence.constructId, occurrence.id);
      addIndex(
        occurrenceIdsByActivationAndConstruct,
        `${occurrence.activationId}\u001f${occurrence.constructId}`,
        occurrence.id,
      );
      addIndex(
        activationIdsByConstruct,
        occurrence.constructId,
        occurrence.activationId,
      );
    }
    if (!executedConstructIdsByActivation.has(occurrence.activationId)) {
      executedConstructIdsByActivation.set(occurrence.activationId, new Set());
    }
    if (!syntheticFunctionParameter) {
      executedConstructIdsByActivation
        .get(occurrence.activationId)
        .add(occurrence.constructId);
    }
  }
  // Closure creation is provenance, not an execution of the function body.
  // Function constructs enter these indexes only through real function
  // occurrences, so every cursor surface on an uncalled function has the same
  // empty activation set and globally-unreached coverage.
  freezeOrderedIndex(occurrenceIdsByConstruct, byEnteredAt);
  freezeOrderedIndex(occurrenceIdsByActivationAndConstruct, byEnteredAt);
  for (const [constructId, activationIds] of activationIdsByConstruct) {
    activationIdsByConstruct.set(
      constructId,
      Object.freeze(
        [...new Set(activationIds)].sort(
          (left, right) =>
            activationById.get(left).enteredAt - activationById.get(right).enteredAt ||
            compareText(left, right),
        ),
      ),
    );
  }
  for (const [activationId, constructIds] of executedConstructIdsByActivation) {
    executedConstructIdsByActivation.set(
      activationId,
      Object.freeze([...constructIds].sort(compareText)),
    );
  }
  const childActivationIdsByActivation = new Map();
  for (const activation of activationById.values()) {
    if (activation.dynamicParentId) {
      addIndex(
        childActivationIdsByActivation,
        activation.dynamicParentId,
        activation.id,
      );
    }
  }
  freezeOrderedIndex(childActivationIdsByActivation, (left, right) =>
    activationById.get(left).enteredAt - activationById.get(right).enteredAt ||
    compareText(left, right),
  );
  const callAttemptIdsByOwnerActivation = new Map();
  for (const attempt of callAttemptById.values()) {
    addIndex(
      callAttemptIdsByOwnerActivation,
      attempt.ownerActivationId,
      attempt.id,
    );
  }
  freezeOrderedIndex(callAttemptIdsByOwnerActivation, (left, right) =>
    callAttemptById.get(left).openedAt - callAttemptById.get(right).openedAt ||
    compareText(left, right),
  );
  const closureProvenanceByClosure = new Map();
  const closureProvenanceByActivation = new Map();
  for (const provenance of closureProvenance) {
    addIndex(closureProvenanceByClosure, provenance.closureId, provenance);
    if (provenance.activationId) {
      addIndex(
        closureProvenanceByActivation,
        provenance.activationId,
        provenance,
      );
    }
  }
  const bySequence = (left, right) =>
    left.sequence - right.sequence ||
    compareText(left.closureId || left.id, right.closureId || right.id);
  freezeOrderedIndex(closureProvenanceByClosure, bySequence);
  freezeOrderedIndex(closureProvenanceByActivation, bySequence);
  const writeIdsByActivation = new Map();
  const writeIdsByConstruct = new Map();
  const writeIdsByTarget = new Map();
  for (const write of writeById.values()) {
    addIndex(writeIdsByActivation, write.activationId, write.id);
    addIndex(writeIdsByConstruct, write.constructId, write.id);
    if (write.targetId) addIndex(writeIdsByTarget, write.targetId, write.id);
  }
  const compareWriteId = (left, right) =>
    writeById.get(left).sequence - writeById.get(right).sequence ||
    compareText(left, right);
  freezeOrderedIndex(writeIdsByActivation, compareWriteId);
  freezeOrderedIndex(writeIdsByConstruct, compareWriteId);
  freezeOrderedIndex(writeIdsByTarget, compareWriteId);

  const snapshot = Object.freeze({
    evaluationId: envelope.evaluationId,
    requestCodeDigest: envelope.requestCodeDigest,
    projectDigest: envelope.projectDigest,
    codeRevisionId: envelope.codeRevisionId,
    compilerInputsDigest: envelope.compilerInputsDigest,
    sourceMaps: copyFreeze(envelope.sourceMaps),
    terminal: copyFreeze(terminal),
    counts: Object.freeze({
      constructs: constructById.size,
      selectors: selectorById.size,
      occurrences: occurrenceById.size,
      activations: activationById.size,
      closures: closureById.size,
      callAttempts: callAttemptById.size,
      writes: writeById.size,
      events: events.length,
    }),
  });
  snapshotStores.set(snapshot, {
    unitById,
    scopeById,
    constructById,
    selectorById,
    occurrenceById,
    activationById,
    closureById,
    callAttemptById,
    writeById,
    occurrenceIdsByConstruct,
    occurrenceIdsByActivationAndConstruct,
    activationIdsByConstruct,
    executedConstructIdsByActivation,
    childActivationIdsByActivation,
    callAttemptIdsByOwnerActivation,
    constructIdsByExecutionScope,
    closureProvenance,
    closureProvenanceByClosure,
    closureProvenanceByActivation,
    writeIdsByActivation,
    writeIdsByConstruct,
    writeIdsByTarget,
    events: Object.freeze(
      events.sort(
        (left, right) =>
          left.sequence - right.sequence ||
          compareText(left.kind, right.kind) ||
          compareText(left.id, right.id),
      ),
    ),
  });
  return snapshotResult([], snapshot);
}

function storesFor(snapshot) {
  const stores = snapshotStores.get(snapshot);
  if (!stores) throw new TypeError("Not an execution snapshot");
  return stores;
}

export function snapshotConstruct(snapshot, constructId) {
  return storesFor(snapshot).constructById.get(constructId) || null;
}

export function snapshotConstructs(snapshot) {
  return Object.freeze([...storesFor(snapshot).constructById.values()]);
}

export function snapshotOccurrence(snapshot, occurrenceId) {
  return storesFor(snapshot).occurrenceById.get(occurrenceId) || null;
}

export function snapshotOccurrences(snapshot) {
  return Object.freeze(
    [...storesFor(snapshot).occurrenceById.values()].sort(
      (left, right) =>
        left.enteredAt - right.enteredAt || compareText(left.id, right.id),
    ),
  );
}

export function snapshotActivation(snapshot, activationId) {
  return storesFor(snapshot).activationById.get(activationId) || null;
}

export function snapshotActivations(snapshot) {
  return Object.freeze(
    [...storesFor(snapshot).activationById.values()].sort(
      (left, right) =>
        left.enteredAt - right.enteredAt || compareText(left.id, right.id),
    ),
  );
}

export function snapshotSelector(snapshot, selectorId) {
  return storesFor(snapshot).selectorById.get(selectorId) || null;
}

export function snapshotSelectors(snapshot) {
  return Object.freeze([...storesFor(snapshot).selectorById.values()]);
}

export function snapshotCompilationUnits(snapshot) {
  return Object.freeze([...storesFor(snapshot).unitById.values()]);
}

export function snapshotExecutionScopes(snapshot) {
  return Object.freeze([...storesFor(snapshot).scopeById.values()]);
}

export function snapshotClosures(snapshot) {
  return Object.freeze([...storesFor(snapshot).closureById.values()]);
}

export function snapshotClosureProvenance(snapshot) {
  return Object.freeze([...storesFor(snapshot).closureProvenance]);
}

export function snapshotCallAttempts(snapshot) {
  return Object.freeze([...storesFor(snapshot).callAttemptById.values()]);
}

export function snapshotCallAttemptsForActivation(snapshot, activationId) {
  const stores = storesFor(snapshot);
  return Object.freeze(
    (stores.callAttemptIdsByOwnerActivation.get(activationId) || []).map(
      (attemptId) => stores.callAttemptById.get(attemptId),
    ),
  );
}

export function snapshotWrites(snapshot) {
  return Object.freeze([...storesFor(snapshot).writeById.values()]);
}

export function snapshotEvents(snapshot) {
  return storesFor(snapshot).events;
}

export function snapshotTerminal(snapshot) {
  return snapshot.terminal;
}

export function snapshotOccurrenceIdsForConstruct(snapshot, constructId) {
  return storesFor(snapshot).occurrenceIdsByConstruct.get(constructId) || Object.freeze([]);
}

export function snapshotOccurrenceIdsForActivationConstruct(
  snapshot,
  activationId,
  constructId,
) {
  return (
    storesFor(snapshot).occurrenceIdsByActivationAndConstruct.get(
      `${activationId}\u001f${constructId}`,
    ) || Object.freeze([])
  );
}

export function snapshotActivationIdsForConstruct(snapshot, constructId) {
  return storesFor(snapshot).activationIdsByConstruct.get(constructId) || Object.freeze([]);
}

export function snapshotExecutedConstructIds(snapshot, activationId) {
  return storesFor(snapshot).executedConstructIdsByActivation.get(activationId) || Object.freeze([]);
}

export function snapshotChildActivationIds(snapshot, activationId) {
  return storesFor(snapshot).childActivationIdsByActivation.get(activationId) || Object.freeze([]);
}

export function snapshotConstructIdsForScope(snapshot, scopeId) {
  return storesFor(snapshot).constructIdsByExecutionScope.get(scopeId) || Object.freeze([]);
}

export function snapshotClosureProvenanceForClosure(snapshot, closureId) {
  return storesFor(snapshot).closureProvenanceByClosure.get(closureId) || Object.freeze([]);
}

export function snapshotClosureProvenanceForActivation(snapshot, activationId) {
  return storesFor(snapshot).closureProvenanceByActivation.get(activationId) || Object.freeze([]);
}

function snapshotWritesFromIndex(snapshot, indexName, key) {
  const stores = storesFor(snapshot);
  return Object.freeze(
    (stores[indexName].get(key) || []).map((writeId) => stores.writeById.get(writeId)),
  );
}

export function snapshotWritesForActivation(snapshot, activationId) {
  return snapshotWritesFromIndex(snapshot, "writeIdsByActivation", activationId);
}

export function snapshotWritesForConstruct(snapshot, constructId) {
  return snapshotWritesFromIndex(snapshot, "writeIdsByConstruct", constructId);
}

export function snapshotWritesForTarget(snapshot, targetId) {
  return snapshotWritesFromIndex(snapshot, "writeIdsByTarget", targetId);
}
