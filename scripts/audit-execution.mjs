#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import process from "node:process";
import {
  snapshotActivation,
  snapshotActivations,
  snapshotOccurrence,
  buildCompilerContractCapture,
  buildExecutionSnapshot,
  compilerContractCaptureToJson,
  renderCompilerContractCapture,
} from "../web/execution-artifact.js";
import {
  dispatchExecutionIntent,
  installExecutionArtifact,
} from "../web/execution-adapter.js";
import {
  buildExecutionAudit,
  renderExecutionAudit,
} from "../web/execution-audit.js";
import {
  buildExecutionSelfCheck,
  buildExecutionUxMatrix,
  executionSelfCheckToJson,
  renderExecutionAtlas,
  renderExecutionSelfCheck,
  renderExecutionVisualReport,
  renderExecutionUxMatrix,
  renderUnavailableExecutionAtlas,
} from "../web/execution-self-check.js";
import {
  projectActivation,
  resolveCursor,
  selectCursor,
  valuesAt,
} from "../web/execution-query.js";
import {
  buildExecutionViewFromArtifact,
  executionViewOffset,
  executionViewSelectorContainsOffset,
  executionViewSelectorContainsPosition,
} from "../web/execution-view.js";
import { buildExecutionUxOracle } from "../web/execution-view-model.js";

function usage() {
  console.error(
    "Usage: npm run audit:execution -- FILE [--check] [--at LINE:COLUMN] [--activation ID] [--matrix] [--ux-matrix] [--visual] [-o FILE] [--atlas] [--lines FROM:TO] [--json]",
  );
  process.exit(2);
}

function parsePosition(value) {
  const match = /^(\d+):(\d+)$/.exec(value || "");
  if (!match) usage();
  return { line: Number(match[1]), column: Number(match[2]) };
}

function compareText(left, right) {
  const leftText = String(left ?? "");
  const rightText = String(right ?? "");
  return leftText < rightText ? -1 : leftText > rightText ? 1 : 0;
}

const arguments_ = process.argv.slice(2);
const path = arguments_.shift();
if (!path) usage();
let json = false;
let position = null;
let matrix = false;
let uxMatrix = false;
let visual = false;
let outputPath = null;
let atlas = false;
let lineRange = null;
let checkOnly = false;
let requestedActivationId = null;
while (arguments_.length) {
  const option = arguments_.shift();
  if (option === "--json") json = true;
  else if (option === "--at") position = parsePosition(arguments_.shift());
  else if (option === "--matrix") matrix = true;
  else if (option === "--ux-matrix") uxMatrix = true;
  else if (option === "--visual") visual = true;
  else if (option === "-o" || option === "--output") {
    outputPath = arguments_.shift() || null;
    if (!outputPath) usage();
  }
  else if (option === "--atlas") atlas = true;
  else if (option === "--lines") {
    const match = /^(\d+)(?::(\d+))?$/.exec(arguments_.shift() || "");
    if (!match) usage();
    lineRange = {
      lineFrom: Number(match[1]),
      lineTo: Number(match[2] || match[1]),
    };
  }
  else if (option === "--activation") requestedActivationId = arguments_.shift();
  else if (option === "--check") checkOnly = true;
  else usage();
}
if (requestedActivationId && !position) usage();
if (lineRange && !atlas && !uxMatrix && !visual) usage();
if (outputPath && !visual) usage();
if (
  visual &&
  (json || position || matrix || uxMatrix || atlas || checkOnly || requestedActivationId)
) usage();

const command = process.env.DOX_BIN || "dune";
const commandArguments = process.env.DOX_BIN
  ? ["audit-data", path]
  : ["exec", "dox", "--", "audit-data", path];
const result = spawnSync(command, commandArguments, {
  cwd: process.cwd(),
  encoding: "utf8",
  maxBuffer: 128 * 1024 * 1024,
});
if (!result.stdout.trim()) {
  process.stderr.write(result.stderr || "Could not collect execution data.\n");
  process.exit(result.status || 1);
}

let payload;
try {
  payload = JSON.parse(result.stdout);
} catch (error) {
  process.stderr.write(result.stderr || "");
  console.error(`Could not parse execution data: ${error.message}`);
  process.exit(1);
}

const capture = buildCompilerContractCapture(payload);
const snapshotBuild = payload.evaluation?.executionArtifact
  ? buildExecutionSnapshot(payload.evaluation.executionArtifact)
  : { ok: false, snapshot: null, problems: [{ code: "artifact-missing" }] };
const snapshotSummary = snapshotBuild.ok
  ? {
      evaluationId: snapshotBuild.snapshot.evaluationId,
      codeRevisionId: snapshotBuild.snapshot.codeRevisionId,
      terminal: snapshotBuild.snapshot.terminal,
      counts: snapshotBuild.snapshot.counts,
      problems: [],
    }
  : { problems: snapshotBuild.problems };

const rawSource = String(payload.source || "");
const source = rawSource.replace(/\r\n?/g, "\n");
const lines = source.split("\n");
const sourceMapBySelectorId = new Map(
  (payload.evaluation?.executionArtifact?.sourceMaps?.entries || []).map(
    (entry) => [entry.selectorId, entry],
  ),
);
const projectedSelectors = snapshotBuild.ok
  ? capture.selectors.flatMap((selector) => {
      const entry = sourceMapBySelectorId.get(selector.id);
      if (!entry) return [];
      return [
        {
          id: selector.id,
          subjectId: selector.subjectId,
          role: selector.role,
          priority: selector.priority,
          tieBreakRank: selector.tieBreakRank,
          range: {
            path: entry.documentPath,
            start: entry.startUtf16,
            end: entry.endUtf16,
          },
        },
      ];
    })
  : [];
const view = snapshotBuild.ok
  ? buildExecutionViewFromArtifact({
      snapshot: snapshotBuild.snapshot,
      envelope: payload.evaluation.executionArtifact,
      sources: { [payload.path]: rawSource },
    })
  : null;
const installed = snapshotBuild.ok
  ? installExecutionArtifact({
      envelope: payload.evaluation.executionArtifact,
      sources: { [payload.path]: rawSource },
    })
  : null;
const selfCheck =
  installed && (checkOnly || matrix || uxMatrix || visual || atlas)
    ? buildExecutionSelfCheck({
        view,
        initialState: installed.state,
        path: payload.path,
        source,
        envelope: payload.evaluation.executionArtifact,
      })
    : null;
let positionAudit = null;
let uxAudit = installed ? buildExecutionUxOracle(installed.state) : null;
if (position && snapshotBuild.ok) {
  const query = resolveCursor(view, { path: payload.path, ...position });
  let adapterResult = dispatchExecutionIntent(installed.state, {
    kind: "cursor-moved",
    position: { path: payload.path, ...position },
  });
  let activationDecision = null;
  if (requestedActivationId) {
    const alias = /^a(\d+)$/.exec(requestedActivationId);
    const resolvedActivationId = alias
      ? query.activationIds[Number(alias[1])] || null
      : requestedActivationId;
    if (resolvedActivationId) {
      adapterResult = dispatchExecutionIntent(adapterResult.state, {
        kind: "activation-chosen",
        activationId: resolvedActivationId,
      });
      activationDecision = adapterResult.decision;
    } else activationDecision = "activation-alias-unknown";
  }
  const selection = adapterResult.model.selection;
  const values = valuesAt(view, selection, { offset: 0, limit: 20 });
  const projection = projectActivation(view, selection);
  const activation = selection.activationId
    ? snapshotActivation(snapshotBuild.snapshot, selection.activationId)
    : null;
  positionAudit = {
    query,
    selection,
    activation,
    values,
    projection,
    viewModel: adapterResult.model,
    activationDecision,
  };
  uxAudit = buildExecutionUxOracle(adapterResult.state);
}

const canonicalAudit = buildExecutionAudit({
  snapshot: snapshotBuild.snapshot,
  viewModel: positionAudit?.viewModel || null,
  problems: snapshotBuild.problems,
});

const aliasAlphabet =
  "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
const aliasWidth = (count) => {
  let width = 1;
  let capacity = aliasAlphabet.length;
  while (count > capacity) {
    width += 1;
    capacity *= aliasAlphabet.length;
  }
  return width;
};
const aliasAt = (index, width) => {
  let value = index;
  let alias = "";
  for (let place = 0; place < width; place += 1) {
    alias = aliasAlphabet[value % aliasAlphabet.length] + alias;
    value = Math.floor(value / aliasAlphabet.length);
  }
  return alias;
};
const aliasMap = (keys) => {
  const ordered = [...new Set(keys.filter(Boolean))];
  const width = aliasWidth(ordered.length);
  return {
    width,
    aliases: new Map(ordered.map((key, index) => [key, aliasAt(index, width)])),
  };
};
const valueKey = (values) =>
  values
    .map((value) =>
      JSON.stringify([
        value.occurrenceId,
        value.outcome?.kind,
        value.outcome?.value?.type,
        value.outcome?.value?.display,
      ]),
    )
    .join("\u001f");

function buildMatrixAudit() {
  if (!snapshotBuild.ok) return null;
  const projectedSelectorById = new Map(
    projectedSelectors.map((selector) => [selector.id, selector]),
  );
  const points = lines.map((line, lineIndex) =>
    Array.from({ length: line.length + 1 }, (_, column) => {
      const query = resolveCursor(view, {
        path: payload.path,
        line: lineIndex + 1,
        column,
      });
      const presented = dispatchExecutionIntent(installed.state, {
        kind: "cursor-moved",
        position: { path: payload.path, line: lineIndex + 1, column },
      });
      const selection = presented.model.selection;
      const values = valuesAt(view, selection, { offset: 0, limit: 10_000 });
      const projection = projectActivation(view, selection);
      const coverage = presented.model.coverage || [];
      return {
        query,
        selection,
        values: values.values,
        projection,
        coverage,
        reachKey: query.activationIds.join("\u001f"),
        valueKey: valueKey(values.values),
        projectionKey: projection
          ? JSON.stringify([
              projection.activationId,
              projection.activeConstructIds,
              projection.inactiveConstructIds,
              projection.globallyUnreachedConstructIds,
            ])
          : "",
        coverageKey: coverage.length
          ? JSON.stringify(
              coverage.map((item) => [
                item.state,
                item.range.path,
                item.range.start,
                item.range.end,
              ]),
            )
          : "",
      };
    }),
  );
  const flatPoints = points.flat();
  const consistencyProblems = [];
  for (const [lineIndex, linePoints] of points.entries()) {
    for (const [column, point] of linePoints.entries()) {
      const label = `${lineIndex + 1}:${column}`;
      const offset = executionViewOffset(view, {
        path: payload.path,
        line: lineIndex + 1,
        column,
      });
      const selector = projectedSelectorById.get(point.selection.selectorId);
      if (
        selector &&
        !executionViewSelectorContainsPosition(
          view,
          selector,
          { path: payload.path, line: lineIndex + 1, column },
        )
      ) {
        consistencyProblems.push(`${label} selected-range-misses-cursor`);
      }
      if (point.query.status === "reached" && !point.selection.activationId) {
        consistencyProblems.push(`${label} reached-without-activation`);
      }
      const coverageOffset =
        selector && !executionViewSelectorContainsOffset(selector, offset)
          ? Math.max(selector.range.start, selector.range.end - 1)
          : offset;
      const coverageAtCursor = point.coverage.filter(
        (item) =>
          item.range.path === payload.path &&
          item.range.start <= coverageOffset &&
          coverageOffset < item.range.end,
      );
      if (
        point.query.status === "reached" &&
        selector?.role !== "function-context" &&
        coverageAtCursor.some((item) => item.state === "globally-unreached")
      ) {
        consistencyProblems.push(`${label} reached-but-globally-unreached`);
      }
      if (
        point.query.status === "reached" &&
        selector?.role !== "function-context" &&
        !coverageAtCursor.some((item) => item.state === "active")
      ) {
        consistencyProblems.push(`${label} selected-activation-misses-cursor`);
      }
      if (
        point.query.status === "unreached" &&
        selector?.role !== "function-context" &&
        !coverageAtCursor.some((item) => item.state === "globally-unreached")
      ) {
        consistencyProblems.push(`${label} unreached-without-global-fade`);
      }
      const orderedCoverage = [...point.coverage].sort(
        (left, right) =>
          compareText(left.range.path, right.range.path) ||
          left.range.start - right.range.start ||
          left.range.end - right.range.end,
      );
      for (let index = 1; index < orderedCoverage.length; index += 1) {
        const previous = orderedCoverage[index - 1];
        const current = orderedCoverage[index];
        if (
          previous.range.path === current.range.path &&
          previous.range.end > current.range.start
        ) {
          consistencyProblems.push(`${label} overlapping-coverage`);
          break;
        }
      }
    }
  }
  const orderedSelectors = [...projectedSelectors].sort(
    (left, right) =>
      left.range.start - right.range.start ||
      left.range.end - right.range.end ||
      compareText(left.id, right.id),
  );
  const selectorAliases = aliasMap(orderedSelectors.map((item) => item.id));
  const constructAliases = aliasMap(
    [...capture.constructs]
      .sort(
        (left, right) =>
          left.startLine - right.startLine ||
          left.startColumn - right.startColumn ||
          left.endLine - right.endLine ||
          left.endColumn - right.endColumn ||
          compareText(left.id, right.id),
      )
      .map((item) => item.id),
  );
  const activations = snapshotActivations(snapshotBuild.snapshot);
  const activationAliases = aliasMap(activations.map((item) => item.id));
  const reachKeys = [
    ...new Set(flatPoints.map((point) => point.reachKey).filter(Boolean)),
  ].sort(compareText);
  const valueKeys = [
    ...new Set(flatPoints.map((point) => point.valueKey).filter(Boolean)),
  ].sort(compareText);
  const projectionKeys = [
    ...new Set(
      flatPoints.map((point) => point.projectionKey).filter(Boolean),
    ),
  ].sort(compareText);
  const coverageKeys = [
    ...new Set(flatPoints.map((point) => point.coverageKey).filter(Boolean)),
  ].sort(compareText);
  const reachAliases = aliasMap(reachKeys);
  const valueAliases = aliasMap(valueKeys);
  const projectionAliases = aliasMap(projectionKeys);
  const coverageAliases = aliasMap(coverageKeys);
  const valueExampleByKey = new Map(
    flatPoints.filter((point) => point.valueKey).map((point) => [point.valueKey, point]),
  );
  const projectionExampleByKey = new Map(
    flatPoints
      .filter((point) => point.projectionKey)
      .map((point) => [point.projectionKey, point]),
  );
  const coverageExampleByKey = new Map(
    flatPoints
      .filter((point) => point.coverageKey)
      .map((point) => [point.coverageKey, point]),
  );
  return {
    points,
    orderedSelectors,
    activations,
    selectorAliases,
    constructAliases,
    activationAliases,
    reachAliases,
    valueAliases,
    projectionAliases,
    coverageAliases,
    valueExampleByKey,
    projectionExampleByKey,
    coverageExampleByKey,
    consistencyProblems,
  };
}

const matrixAudit = matrix ? buildMatrixAudit() : null;
const uxMatrixAudit =
  uxMatrix && selfCheck
    ? buildExecutionUxMatrix(selfCheck, lineRange || undefined)
    : null;
const visualAudit =
  visual && selfCheck
    ? renderExecutionVisualReport(selfCheck, lineRange || undefined)
    : null;

const matrixAuditToJson = () =>
  matrixAudit && {
    schemaVersion: 2,
    baseline: { selection: null, recency: [] },
    tables: {
      activationSets: [...matrixAudit.reachAliases.aliases.entries()].map(
        ([key, alias]) => ({
          key: alias,
          activationIds: key.split("\u001f"),
        }),
      ),
      values: [...matrixAudit.valueAliases.aliases.entries()].map(([key, alias]) => ({
        key: alias,
        values: matrixAudit.valueExampleByKey.get(key)?.values || [],
      })),
      projections: [...matrixAudit.projectionAliases.aliases.entries()].map(
        ([key, alias]) => ({
          key: alias,
          projection: matrixAudit.projectionExampleByKey.get(key)?.projection || null,
        }),
      ),
      coverage: [...matrixAudit.coverageAliases.aliases.entries()].map(
        ([key, alias]) => ({
          key: alias,
          coverage: matrixAudit.coverageExampleByKey.get(key)?.coverage || [],
        }),
      ),
    },
    lines: matrixAudit.points.map((linePoints, index) => ({
      line: index + 1,
      source: lines[index],
      boundaries: linePoints.map((point, column) => ({
        column,
        selectorId: point.query.selectorId,
        constructId: point.query.constructId,
        status: point.query.status,
        activationSetKey:
          matrixAudit.reachAliases.aliases.get(point.reachKey) || null,
        selectedActivationId: point.selection.activationId,
        focusedOccurrenceId: point.selection.focusedOccurrenceId,
        valueKey: matrixAudit.valueAliases.aliases.get(point.valueKey) || null,
        projectionKey:
          matrixAudit.projectionAliases.aliases.get(point.projectionKey) || null,
        coverageKey:
          matrixAudit.coverageAliases.aliases.get(point.coverageKey) || null,
      })),
    })),
    consistencyProblems: matrixAudit.consistencyProblems,
  };

const compactOutcome = (outcome) =>
  outcome?.value?.display ?? outcome?.kind ?? "-";

function matrixActivationName(activation) {
  if (!activation.functionConstructId) return "Program";
  const binder = projectedSelectors.find(
    (selector) =>
      selector.subjectId === activation.functionConstructId &&
      selector.role === "binder",
  );
  return binder
    ? source.slice(binder.range.start, binder.range.end).trim() || "fun"
    : activation.signature?.functionKey || "fun";
}

function matrixActivationInputs(activation) {
  return (activation.parameterOccurrenceIds || []).flatMap((occurrenceId) => {
    const occurrence = snapshotOccurrence(snapshotBuild.snapshot, occurrenceId);
    return occurrence ? [compactOutcome(occurrence.outcome)] : [];
  });
}

function renderMatrixAudit() {
  const {
    points,
    orderedSelectors,
    activations,
    selectorAliases,
    constructAliases,
    activationAliases,
    reachAliases,
    valueAliases,
    projectionAliases,
    coverageAliases,
    valueExampleByKey,
    projectionExampleByKey,
    coverageExampleByKey,
    consistencyProblems,
  } = matrixAudit;
  const width = Math.max(
    selectorAliases.width,
    constructAliases.width,
    activationAliases.width,
    reachAliases.width,
    valueAliases.width,
    projectionAliases.width,
    coverageAliases.width,
  );
  const blank = "-".repeat(width);
  const cell = (aliases, key) =>
    (aliases.aliases.get(key) || blank).padStart(width, "0");
  const output = [
    `matrix ${snapshotBuild.snapshot.evaluationId} code ${snapshotBuild.snapshot.codeRevisionId}`,
    "baseline selection -  recency empty",
    consistencyProblems.length || !selfCheck?.ok
      ? `self-check ${consistencyProblems.length + (selfCheck?.problems.length || 0)} problem${consistencyProblems.length + (selfCheck?.problems.length || 0) === 1 ? "" : "s"}`
      : "self-check ok",
  ];
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const number = String(lineIndex + 1).padStart(String(lines.length).length);
    const linePoints = points[lineIndex];
    output.push(`${number} | ${lines[lineIndex]}·`);
    output.push(
      `S${" ".repeat(number.length - 1)} | ${linePoints
        .map((point) => cell(selectorAliases, point.query.selectorId))
        .join("")}`,
    );
    output.push(
      `C${" ".repeat(number.length - 1)} | ${linePoints
        .map((point) => cell(constructAliases, point.query.constructId))
        .join("")}`,
    );
    output.push(
      `R${" ".repeat(number.length - 1)} | ${linePoints
        .map((point) => cell(reachAliases, point.reachKey))
        .join("")}`,
    );
    output.push(
      `A${" ".repeat(number.length - 1)} | ${linePoints
        .map((point) => cell(activationAliases, point.selection.activationId))
        .join("")}`,
    );
    output.push(
      `V${" ".repeat(number.length - 1)} | ${linePoints
        .map((point) => cell(valueAliases, point.valueKey))
        .join("")}`,
    );
    output.push(
      `P${" ".repeat(number.length - 1)} | ${linePoints
        .map((point) => cell(projectionAliases, point.projectionKey))
        .join("")}`,
    );
    output.push(
      `F${" ".repeat(number.length - 1)} | ${linePoints
        .map((point) => cell(coverageAliases, point.coverageKey))
        .join("")}`,
    );
  }

  output.push("", "selectors");
  for (const selector of orderedSelectors) {
    output.push(
      `${cell(selectorAliases, selector.id)} ${selector.role.padEnd(11)} ${selector.range.start}-${selector.range.end} -> ${cell(constructAliases, selector.subjectId)} ${selector.id}`,
    );
  }
  output.push("", "activations");
  for (const activation of activations) {
    output.push(
      `${cell(activationAliases, activation.id)} parent ${cell(activationAliases, activation.dynamicParentId)} ${matrixActivationName(activation)}(${matrixActivationInputs(activation).join(", ")}) -> ${compactOutcome(activation.outcome)}`,
    );
  }
  output.push("", "reach sets");
  for (const [key, alias] of reachAliases.aliases) {
    output.push(
      `${alias.padStart(width, "0")} ${key
        .split("\u001f")
        .map((id) => cell(activationAliases, id))
        .join(" ")}`,
    );
  }
  output.push("", "value sets");
  for (const [key, alias] of valueAliases.aliases) {
    const point = valueExampleByKey.get(key);
    output.push(
      `${alias.padStart(width, "0")} ${(point?.values || [])
        .map((value) => `${compactOutcome(value.outcome)}:${value.outcome?.value?.type || "?"}`)
        .join("; ")}`,
    );
  }
  output.push("", "projections");
  for (const [key, alias] of projectionAliases.aliases) {
    const point = projectionExampleByKey.get(key);
    const projection = point?.projection;
    output.push(
      `${alias.padStart(width, "0")} activation ${cell(activationAliases, projection?.activationId)} active ${projection?.activeConstructIds.map((id) => cell(constructAliases, id)).join(" ") || "-"} inactive ${projection?.inactiveConstructIds.map((id) => cell(constructAliases, id)).join(" ") || "-"} global-unreached ${projection?.globallyUnreachedConstructIds.map((id) => cell(constructAliases, id)).join(" ") || "-"}`,
    );
  }
  output.push("", "composed coverage");
  for (const [key, alias] of coverageAliases.aliases) {
    const coverage = coverageExampleByKey.get(key)?.coverage || [];
    output.push(
      `${alias.padStart(width, "0")} ${coverage
        .map((item) => `${item.state}:${item.range.start}-${item.range.end}`)
        .join(" ")}`,
    );
  }
  if (consistencyProblems.length) {
    output.push("", "self-check problems", ...consistencyProblems);
  }
  if (selfCheck && !selfCheck.ok) {
    output.push("", "extended self-check", renderExecutionSelfCheck(selfCheck));
  }
  output.push("", "legend S selector  C construct  R reach set  A activation  V value set  P projection  F composed coverage/fade state");
  return output.join("\n");
}
const renderPositionAudit = () => {
  const { query, selection, activation, values, projection } = positionAudit;
  const selector = capture.selectors.find((item) => item.id === query.selectorId);
  const construct = capture.constructs.find((item) => item.id === query.constructId);
  const activationAliases = new Map(
    query.activationIds.map((activationId, index) => [activationId, `a${index}`]),
  );
  const selectedAlias = selection.activationId
    ? activationAliases.get(selection.activationId) || "a?"
    : "-";
  const valueText = values.values.length
    ? values.values
        .map((item) => `${item.outcome.value?.display ?? item.outcome.kind} : ${item.outcome.value?.type ?? "?"}`)
        .join("; ")
    : "-";
  const uxLines = (uxAudit?.lane || []).flatMap((slot) => {
    const effective = slot.effective;
    return effective
      ? [`L ${String(slot.line).padStart(2, "0")} ${effective.kind === "cursor" ? "C" : "P"} ${effective.kind} ${effective.value.text}`]
      : [];
  });
  const occurrenceLines = (uxAudit?.occurrenceList?.rows || []).flatMap(
    (row, index) => {
      const inputs = row.inputs.map((value) => value.text).join(", ");
      const arrow = row.outcome.kind === "raise" ? "⇑" : "→";
      return [
        `A ${index + 1} ${row.name}(${inputs}) ${arrow} ${row.outcome.text}`,
        ...(row.value ? [`V ${index + 1} ${row.value.text}`] : []),
        ...(row.valueStatus === "trace-incomplete"
          ? [`I ${index + 1} trace-incomplete`]
          : []),
      ];
    },
  );
  const emptyLines = uxAudit?.occurrenceList?.rows?.length
    ? []
    : uxAudit?.occurrenceList?.emptyReason
      ? [`E ${uxAudit.occurrenceList.emptyReason}`]
      : [];
  return [
    `evaluation ${snapshotBuild.snapshot.evaluationId}  code ${snapshotBuild.snapshot.codeRevisionId}  terminal ${snapshotBuild.snapshot.terminal.kind}`,
    `${query.position.line}:${query.position.column}  selector ${selector?.alias || "-"} ${selector?.role || "-"} -> construct ${construct?.alias || "-"}  ${query.status}`,
    `reaches ${query.activationIds.map((id) => activationAliases.get(id)).join(" ") || "-"}`,
    `selected ${selectedAlias}  ${activation?.signature?.functionKey || "-"}  occurrence ${selection.focusedOccurrenceId || "-"}`,
    `values ${values.total}  ${valueText}`,
    projection
      ? `active ${projection.activeConstructIds.length}  inactive ${projection.inactiveConstructIds.length}  global-unreached ${projection.globallyUnreachedConstructIds.length}`
      : "projection -",
    ...uxLines,
    ...occurrenceLines,
    ...emptyLines,
  ].join("\n");
};

const renderedOutput =
  json
    ? JSON.stringify(
        {
          compilerContract: compilerContractCaptureToJson(capture),
          snapshot: snapshotSummary,
          audit: canonicalAudit,
          position: positionAudit,
          ux: uxAudit,
          matrix: matrixAuditToJson(),
          uxMatrix: uxMatrixAudit,
          selfCheck: selfCheck ? executionSelfCheckToJson(selfCheck) : null,
        },
        null,
        2,
      )
    : atlas && selfCheck
      ? renderExecutionAtlas(selfCheck, {
          ...(lineRange || {}),
          focusPosition: position ? { path: payload.path, ...position } : null,
        })
    : atlas
      ? renderUnavailableExecutionAtlas({
          path: payload.path,
          problems: [
            ...(capture.problems || []),
            ...(snapshotBuild.problems || []),
          ],
        })
    : uxMatrixAudit
      ? renderExecutionUxMatrix(uxMatrixAudit)
    : matrixAudit
      ? renderMatrixAudit()
      : positionAudit
      ? renderPositionAudit()
      : checkOnly
      ? [
          `evaluation ${snapshotBuild.snapshot?.evaluationId || "-"}  code ${snapshotBuild.snapshot?.codeRevisionId || "-"}`,
          snapshotBuild.ok
            ? `constructs ${snapshotBuild.snapshot.counts.constructs}  selectors ${snapshotBuild.snapshot.counts.selectors}  occurrences ${snapshotBuild.snapshot.counts.occurrences}  activations ${snapshotBuild.snapshot.counts.activations}  closures ${snapshotBuild.snapshot.counts.closures}  calls ${snapshotBuild.snapshot.counts.callAttempts}  writes ${snapshotBuild.snapshot.counts.writes}`
            : `problems ${snapshotBuild.problems.length}`,
          `terminal ${snapshotBuild.snapshot?.terminal?.kind || "invalid"}`,
          capture.valid && snapshotBuild.ok ? "invariants ok" : "invariants failed",
          selfCheck ? renderExecutionSelfCheck(selfCheck) : "self-check unavailable",
        ].join("\n")
      : visualAudit
      ? visualAudit
      : [
        renderCompilerContractCapture(capture),
        "",
        renderExecutionAudit(canonicalAudit),
        ].join("\n");

if (visual && !visualAudit) {
  console.error("Could not produce a visual audit because execution data is unavailable.");
  process.exitCode = 1;
} else if (visual) {
  const destination =
    outputPath ||
    (path.endsWith(".ml.md")
      ? `${path.slice(0, -".ml.md".length)}.audit.txt`
      : `${path}.audit.txt`);
  writeFileSync(destination, `${renderedOutput}\n`, "utf8");
  console.log(`wrote ${destination}`);
} else {
  console.log(renderedOutput);
}
if (
  !payload.evaluation?.ok ||
  !capture.valid ||
  !snapshotBuild.ok ||
  (selfCheck && !selfCheck.ok) ||
  (matrixAudit?.consistencyProblems.length || 0) > 0 ||
  (requestedActivationId &&
    positionAudit?.activationDecision !== "activation-selected")
) {
  if (
    requestedActivationId &&
    positionAudit?.activationDecision !== "activation-selected"
  ) {
    console.error(
      `Activation ${requestedActivationId} was not selected: ${positionAudit?.activationDecision || "unavailable"}.`,
    );
  }
  process.exitCode = 1;
}
