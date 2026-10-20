import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { QaLabScenarioRun } from "./lab-server.types.js";

export function withQaLabRunCounts(run: Omit<QaLabScenarioRun, "counts">): QaLabScenarioRun {
  return {
    ...run,
    counts: {
      total: run.scenarios.length,
      pending: run.scenarios.filter((scenario) => scenario.status === "pending").length,
      running: run.scenarios.filter((scenario) => scenario.status === "running").length,
      passed: run.scenarios.filter((scenario) => scenario.status === "pass").length,
      failed: run.scenarios.filter((scenario) => scenario.status === "fail").length,
      skipped: run.scenarios.filter((scenario) => scenario.status === "skip").length,
    },
  };
}

export function createFailedQaLabSelfCheckRun(startedAt: string, error: unknown): QaLabScenarioRun {
  const finishedAt = new Date().toISOString();
  return withQaLabRunCounts({
    kind: "self-check",
    status: "completed",
    startedAt,
    finishedAt,
    scenarios: [
      {
        id: "qa-self-check",
        name: "Synthetic Slack-class roundtrip",
        status: "fail",
        details: formatErrorMessage(error),
        finishedAt,
      },
    ],
  });
}
