#!/usr/bin/env node
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import process from "node:process";

import {
  dispatchExecutionIntent,
  executionPendingToken,
  executionSource,
  executionSources,
  installExecutionArtifact,
} from "../web/execution-adapter.js";
import { buildExecutionUxOracle } from "../web/execution-view-model.js";

function usage() {
  console.error("Usage: npm run audit:execution:reducer -- FILE --script INTENTS.json [--json]");
  process.exit(2);
}

const arguments_ = process.argv.slice(2);
const path = arguments_.shift();
let scriptPath = null;
let json = false;
while (arguments_.length) {
  const option = arguments_.shift();
  if (option === "--script") scriptPath = arguments_.shift();
  else if (option === "--json") json = true;
  else usage();
}
if (!path || !scriptPath) usage();

const command = process.env.DOX_BIN || "dune";
const commandArguments = process.env.DOX_BIN
  ? ["audit-data", path]
  : ["exec", "dox", "--", "audit-data", path];
const collected = spawnSync(command, commandArguments, {
  cwd: process.cwd(),
  encoding: "utf8",
  maxBuffer: 128 * 1024 * 1024,
});
if (collected.status !== 0 || !collected.stdout.trim()) {
  process.stderr.write(collected.stderr || "Could not collect execution data.\n");
  process.exit(collected.status || 1);
}

const payload = JSON.parse(collected.stdout);
const envelope = payload.evaluation?.executionArtifact;
const initial = installExecutionArtifact({
  envelope,
  sources: { [payload.path]: String(payload.source || "") },
});
if (!initial.state) {
  console.error(initial.decision, initial.problems);
  process.exit(1);
}

const scriptText = fs.readFileSync(scriptPath, "utf8").trim();
let scripted;
try {
  const parsed = JSON.parse(scriptText);
  scripted = Array.isArray(parsed) ? parsed : [parsed];
} catch {
  scripted = scriptText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`Invalid JSON Lines record ${index + 1}: ${error.message}`);
      }
    });
}
if (!scripted.length || scripted.some((intent) => !intent || typeof intent !== "object")) {
  usage();
}

let state = initial.state;
const steps = [];
const summarizeRecency = (recency) => ({
  clock: recency.clock,
  viewedAtByActivationId: [...recency.viewedAtByActivationId.entries()],
  viewedAtByReconciliationKey: [
    ...recency.viewedAtByReconciliationKey.entries(),
  ],
});
const summarize = (index, intent, transition) => ({
  index,
  intent: structuredClone(intent),
  decision: transition.decision,
  authority: transition.model.authority,
  evaluation: structuredClone(transition.model.evaluation),
  selection: transition.model.selection,
  token: executionPendingToken(transition.state),
  identities: {
    requestCodeDigest: transition.state.requestCodeDigest,
    projectDigest: transition.state.projectDigest,
    compilerInputsDigest: transition.state.compilerInputsDigest,
  },
  sources: executionSources(transition.state),
  recency: summarizeRecency(transition.state.recency),
  effects: structuredClone(transition.effects),
  problems: transition.problems,
  ux: buildExecutionUxOracle(transition.state),
});
steps.push(summarize(0, { kind: "install" }, initial));

for (const [index, input] of scripted.entries()) {
  const intent = structuredClone(input);
  if (intent.kind === "document-edited" && intent.source === undefined) {
    const source = executionSource(state, intent.path);
    if (source === null) throw new Error(`Unknown source path: ${intent.path}`);
    intent.source =
      source.slice(0, intent.change.from) +
      intent.change.insert +
      source.slice(intent.change.to);
  }
  if (
    (intent.kind === "evaluation-succeeded" || intent.kind === "evaluation-failed") &&
    intent.token === "pending"
  ) {
    intent.token = executionPendingToken(state);
  }
  if (intent.kind === "evaluation-succeeded" && intent.artifact === "initial") {
    intent.artifact = envelope;
  }
  const transition = dispatchExecutionIntent(state, intent);
  state = transition.state;
  steps.push(summarize(index + 1, intent, transition));
}

if (json) {
  console.log(JSON.stringify({ schemaVersion: 1, steps }, null, 2));
} else {
  for (const step of steps) {
    const selection = step.selection;
    console.log(
      `${String(step.index).padStart(2)} ${step.intent.kind.padEnd(22)} ${step.decision.padEnd(42)} authority=${step.authority} evaluation=${step.evaluation.kind}`,
    );
    console.log(
      `   selection ${selection.selectorId || "-"}/${selection.constructId || "-"}/${selection.activationId || "-"}/${selection.focusedOccurrenceId || "-"}`,
    );
    console.log(`   effects ${step.effects.map((effect) => effect.kind).join(",") || "-"}`);
    const lane = step.ux.lane
      .filter((slot) => slot.effective)
      .map((slot) => `${slot.line}:${slot.effective.kind}=${slot.effective.value.text}`)
      .join(" | ");
    console.log(`   lane ${lane || "-"}`);
    console.log(`   occurrences ${step.ux.occurrenceList.rows.length}`);
    if (step.problems.length) {
      console.log(
        `   problems ${step.problems.map((problem) => problem.code).join(",")}`,
      );
    }
  }
}
