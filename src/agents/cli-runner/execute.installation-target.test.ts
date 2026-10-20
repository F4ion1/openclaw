import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  getInstallationTarget,
  withInstallationTarget,
} from "../../infra/installation-target-context.js";
import type { CliBackendResolveExecutionArgsContext } from "../../plugins/cli-backend.types.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { buildPreparedCliRunContext } from "../cli-runner.test-helpers.js";
import { executePreparedCliRun as executePreparedCliRunImpl } from "./execute.js";
import {
  createManagedRun,
  createSuccessfulProcessExit,
  supervisorSpawnMock,
  wrapPreparedCliRunWithTestAdmission,
} from "./execute.test-support.js";

const executePreparedCliRun = wrapPreparedCliRunWithTestAdmission(executePreparedCliRunImpl);
const scratchEnv = {
  OPENCLAW_STATE_DIR: "/fixture/scratch",
  OPENCLAW_CONFIG_PATH: undefined,
  OPENCLAW_WORKSPACE_DIR: "/fixture/execution-cwd",
};
const childWithEnv = (env: Record<string, unknown>) =>
  expect.objectContaining({ env: expect.objectContaining(env) });

beforeEach(() => {
  supervisorSpawnMock.mockResolvedValue(
    createManagedRun({ ...createSuccessfulProcessExit(), durationMs: 1, stdout: "done" }),
  );
});

afterEach(() => {
  supervisorSpawnMock.mockReset();
  vi.useRealTimers();
});

it.each(["process", "node"] as const)(
  "projects local child environment and fences %s placement",
  async (kind) => {
    const target = {
      stateDir: "/fixture/diagnosed",
      configPath: "/fixture/custom.json",
      defaultWorkspaceDir: "/fixture/default-workspace",
    };
    const context = buildPreparedCliRunContext({
      model: "fixture-model",
      backend: {
        command: "/bin/sh",
        args: [],
        output: "text",
        systemPromptFileArg: undefined,
        input: "stdin",
      },
    });
    if (kind === "node") {
      context.executionTarget = { kind, placement: { nodeId: "fixture-node" } };
    }
    await withEnvAsync(scratchEnv, async () => {
      const run = withInstallationTarget(target, () => executePreparedCliRun(context));
      expect(getInstallationTarget()).toBeUndefined();
      if (kind === "node") {
        await expect(run).rejects.toThrow("saved prompt");
        expect(supervisorSpawnMock).not.toHaveBeenCalled();
        return;
      }
      await expect(run).resolves.toMatchObject({ text: "done" });
      const expectedEnv = {
        OPENCLAW_STATE_DIR: target.stateDir,
        OPENCLAW_CONFIG_PATH: target.configPath,
        OPENCLAW_WORKSPACE_DIR: target.defaultWorkspaceDir,
      };
      expect(supervisorSpawnMock).toHaveBeenLastCalledWith(childWithEnv(expectedEnv));
      expect({
        OPENCLAW_STATE_DIR: process.env.OPENCLAW_STATE_DIR,
        OPENCLAW_CONFIG_PATH: process.env.OPENCLAW_CONFIG_PATH,
        OPENCLAW_WORKSPACE_DIR: process.env.OPENCLAW_WORKSPACE_DIR,
      }).toEqual(scratchEnv);
      await executePreparedCliRun(context);
      expect(supervisorSpawnMock).toHaveBeenLastCalledWith(
        childWithEnv({
          OPENCLAW_STATE_DIR: "/fixture/scratch",
          OPENCLAW_WORKSPACE_DIR: "/fixture/execution-cwd",
        }),
      );
      expect(supervisorSpawnMock).not.toHaveBeenLastCalledWith(
        childWithEnv({ OPENCLAW_CONFIG_PATH: expect.anything() }),
      );
    });
  },
);

it("counts awaited backend setup against the automatic cutoff", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(1000);
  const resolveExecutionArgs = vi.fn((context: CliBackendResolveExecutionArgsContext) => [
    ...context.baseArgs,
  ]);
  const context = buildPreparedCliRunContext({
    provider: "codex-cli",
    model: "fixture-model",
    fastMode: "auto",
    resolveExecutionArgs,
    backend: { command: "/bin/sh", args: ["exec"], output: "text", input: "stdin" },
  });
  context.params.fastModeAutoOnSeconds = 1;
  context.preparedBackend.beforeExecution = async () => {
    vi.setSystemTime(2001);
  };
  await expect(executePreparedCliRun(context)).resolves.toMatchObject({ text: "done" });
  expect(resolveExecutionArgs.mock.calls[0]?.[0].fastMode).toBe(false);
});
