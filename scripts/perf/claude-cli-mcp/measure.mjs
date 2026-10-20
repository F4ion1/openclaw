// Run with Node or the repository-pinned Bun, once per runtime:
// node scripts/perf/claude-cli-mcp/measure.mjs --baseline /built/base --candidate /built/head --output /new/results
// Both built roots must already be independently qualified; builds are outside the timing window.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { inspectBuild, identifyRuntimes, run, sha256 } from "./run.mjs";

const { values } = parseArgs({
  options: {
    baseline: { type: "string" },
    candidate: { type: "string" },
    output: { type: "string" },
  },
});
for (const name of ["baseline", "candidate", "output"]) {
  assert(values[name], `--${name} is required`);
}
const roots = {
  baseline: path.resolve(values.baseline),
  candidate: path.resolve(values.candidate),
};
const directory = path.resolve(values.output);
await fs.mkdir(directory);
const workloadDirectory = path.dirname(fileURLToPath(import.meta.url));
const workloadHashes = async () =>
  Object.fromEntries(
    await Promise.all(
      ["measure.mjs", "run.mjs", "fixture.mjs"].map(async (file) => [
        file,
        sha256(await fs.readFile(path.join(workloadDirectory, file))),
      ]),
    ),
  );
const cancellation = new AbortController();
const onInterrupt = () => cancellation.abort(new Error("Benchmark interrupted by SIGINT"));
const onTerminate = () => cancellation.abort(new Error("Benchmark interrupted by SIGTERM"));
process.on("SIGINT", onInterrupt);
process.on("SIGTERM", onTerminate);
const { signal } = cancellation;
let workload;
let identity;
const builds = {};
const rows = [];
let failure;
const statistics = (samples) => {
  const sorted = samples.toSorted((a, b) => a - b);
  return {
    count: sorted.length,
    values: samples,
    median: sorted[Math.floor(sorted.length / 2)] ?? null,
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1] ?? null,
    min: sorted[0] ?? null,
    max: sorted.at(-1) ?? null,
  };
};
try {
  signal.throwIfAborted();
  workload = await workloadHashes();
  signal.throwIfAborted();
  identity = await identifyRuntimes();
  for (const role of ["baseline", "candidate"]) {
    signal.throwIfAborted();
    builds[role] = await inspectBuild(roots[role]);
  }
  signal.throwIfAborted();
  assert.deepEqual(
    builds.baseline.sdk,
    builds.candidate.sdk,
    "AB pairs require identical SDK bytes",
  );
  assert.deepEqual(
    builds.baseline.dependencyInputs,
    builds.candidate.dependencyInputs,
    "AB pairs require identical dependency inputs",
  );
  for (let sample = 1; sample <= 5; sample++) {
    for (const role of ["baseline", "candidate"]) {
      signal.throwIfAborted();
      const inspected = await inspectBuild(roots[role]);
      signal.throwIfAborted();
      assert.deepEqual(inspected, builds[role], "qualified build identity changed");
      assert.deepEqual(
        inspected.dependencyInputs,
        builds[role === "baseline" ? "candidate" : "baseline"].dependencyInputs,
        "sample dependency inputs differ across AB roots",
      );
      assert.deepEqual(await workloadHashes(), workload, "benchmark workload changed");
      signal.throwIfAborted();
      assert.deepEqual(await identifyRuntimes(), identity, "runtime executables changed");
      signal.throwIfAborted();
      const result = await run({
        root: roots[role],
        directory: path.join(directory, `${sample}-${role}`),
        role,
        signal,
      });
      rows.push({ sample, role, ...result });
      console.log(JSON.stringify(rows.at(-1)));
      signal.throwIfAborted();
      assert.deepEqual(
        await inspectBuild(roots[role]),
        builds[role],
        "qualified build identity changed during sample",
      );
      signal.throwIfAborted();
      assert.deepEqual(
        await workloadHashes(),
        workload,
        "benchmark workload changed during sample",
      );
      signal.throwIfAborted();
      assert.deepEqual(
        await identifyRuntimes(),
        identity,
        "runtime executables changed during sample",
      );
      signal.throwIfAborted();
      assert(result.pass, `sample ${sample} ${role} failed: ${result.error}`);
      assert.equal(result.measurement.fixtureCount, role === "baseline" ? 6 : 3);
      assert.deepEqual(result.effect, { effects: 1, permissions: 1 });
      assert.deepEqual(result.remainingPids, []);
    }
  }
} catch (error) {
  failure = error;
}
const metrics = {};
for (const metric of [
  "fixtureCount",
  "fixtureRssKiB",
  "totalOwnedRssKiB",
  "totalOwnedProcessCount",
  "invocationToCatalogMs",
]) {
  const entry = Object.fromEntries(
    ["baseline", "candidate"].map((role) => [
      role,
      statistics(
        rows
          .filter((row) => row.role === role && row.measurement)
          .map((row) => row.measurement[metric]),
      ),
    ]),
  );
  for (const statistic of ["median", "p95", "min", "max"]) {
    const before = entry.baseline[statistic];
    const after = entry.candidate[statistic];
    entry[`${statistic}ChangePercent`] =
      before > 0 && after !== null ? (100 * (after - before)) / before : null;
  }
  metrics[metric] = entry;
}
if (rows.length === 10 && !failure) {
  if (metrics.fixtureRssKiB.medianChangePercent >= 0) {
    failure = new Error("Duplicate-server population RSS did not fall");
  }
  for (const [metric, entry] of Object.entries(metrics)) {
    for (const statistic of ["median", "p95", "min", "max"]) {
      if (entry[`${statistic}ChangePercent`] >= 20) {
        failure ??= new Error(
          `${metric} ${statistic} worsened by at least 20%; owner decision required`,
        );
      }
    }
  }
}
const summary = {
  directory,
  roots,
  identity,
  builds,
  workload,
  rows,
  metrics,
  rule: "Five serial AB pairs; cold first turn in fresh isolated state, no cache flush. Hold the first provider response for census/RSS; invocation-to-catalog ends at the first real Claude provider request containing all three fixture tools. Last fixture catalog timing is diagnostic only. Six baseline versus three projected servers; one effect and native permission callback; zero survivors. Full dependency inputs and SDK distribution bytes must match. Any >=20% worsening stops. Remaining per-server supervisor wrappers are not measured as savings.",
  complete: rows.length === 10 && !failure,
  error: failure?.stack,
};
try {
  await fs.writeFile(path.join(directory, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
  console.log(JSON.stringify(summary, null, 2));
  if (failure) {
    process.exitCode = 1;
  }
} finally {
  process.off("SIGINT", onInterrupt);
  process.off("SIGTERM", onTerminate);
}
