#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import process from "node:process";

const documents = [
  "demos.ml.md",
  "demos/inference.ml.md",
  "demos/tracing.ml.md",
  "demos/visualization.ml.md",
  "fib.ml.md",
  "guide.ml.md",
  "learn.ml.md",
  "learn/ocaml.ml.md",
  "project.ml.md",
  "project/analysis.ml.md",
  "project/dataset.ml.md",
  "welcome.ml.md",
];

const audit = fileURLToPath(new URL("./audit-execution.mjs", import.meta.url));
const root = fileURLToPath(new URL("..", import.meta.url));

for (const document of documents) {
  const result = spawnSync(
    process.execPath,
    [audit, document, "--check", "--matrix"],
    {
    cwd: root,
    encoding: "utf8",
    env: process.env,
    maxBuffer: 128 * 1024 * 1024,
    },
  );
  if (result.status !== 0) {
    process.stderr.write(result.stdout || "");
    process.stderr.write(result.stderr || "");
    console.error(`${document}: failed`);
    process.exit(result.status || 1);
  }
  console.log(`${document}: ok`);
}
