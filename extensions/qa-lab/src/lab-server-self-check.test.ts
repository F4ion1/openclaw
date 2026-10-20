import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { startQaLabServer } from "./lab-server.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
  vi.unstubAllEnvs();
});

it("records failed self-check outcomes when report writing fails and admits the next run", async () => {
  vi.stubEnv("OPENCLAW_DEBUG_PROXY_URL", "");
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "qa-lab-self-check-failure-"));
  cleanups.push(() => rm(repoRoot, { recursive: true, force: true }));
  const outputPath = path.join(repoRoot, "report.md");
  await mkdir(outputPath);
  const lab = await startQaLabServer({
    embeddedGateway: "disabled",
    repoRoot,
    outputPath,
    selfCheckWaitTimeoutMs: 1,
  });
  cleanups.push(() => lab.stop());
  const runSelfCheck = () =>
    fetch(`${lab.baseUrl}/api/scenario/self-check`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });

  const response = await runSelfCheck();
  expect(response.status).toBe(500);
  expect(await response.json()).toMatchObject({ error: expect.stringContaining(outputPath) });
  const outcomes = await fetch(`${lab.baseUrl}/api/outcomes`);
  expect(outcomes.status).toBe(200);
  expect(await outcomes.json()).toMatchObject({
    run: {
      kind: "self-check",
      status: "completed",
      finishedAt: expect.any(String),
      counts: { pending: 0, running: 0, failed: 1 },
      scenarios: [
        {
          id: "qa-self-check",
          status: "fail",
          details: expect.stringContaining(outputPath),
          finishedAt: expect.any(String),
        },
      ],
    },
  });

  await rm(outputPath, { recursive: true });
  const next = await runSelfCheck();
  expect(next.status).toBe(200);
  await next.json();
});
