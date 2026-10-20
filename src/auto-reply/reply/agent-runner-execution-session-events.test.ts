import { describe, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import type { PreparedAgentRunAdmission } from "../../agents/admitted-run-context.js";
import type { RunEmbeddedAgentInternalParams } from "../../agents/embedded-agent-runner/run/internal-params.js";
import { useBundledProviderPolicyArtifactsForTest } from "../../plugin-sdk/test-helpers/provider-policy-artifacts.test-support.js";
import {
  createFollowupRun,
  createMinimalRunAgentTurnParams,
  getRawExecuteAgentTurnForTest,
  setupAgentRunnerExecutionTestState,
} from "./agent-runner-execution.test-support.js";
import type { SessionEventExecution } from "./session-event-contract.js";

useBundledProviderPolicyArtifactsForTest(["anthropic"]);
const state = await setupAgentRunnerExecutionTestState();
const executeAgentTurn = await getRawExecuteAgentTurnForTest();
const { registerAgentRunContext } = await import("../../infra/agent-run-registry.js");
const { captureAgentRunTerminalPersistence } =
  await import("../../infra/agent-run-terminal-writes.js");

function createEventExecution(): SessionEventExecution {
  return { onStarted: vi.fn(), onTerminal: vi.fn() };
}

describe("ordinary session event execution", () => {
  it("waits for source preparation and rejects revoked authority before runtime I/O", async ({
    signal,
  }) => {
    const entered = createDeferred();
    const release = createDeferred();
    let current = true;
    const event = createEventExecution();
    event.assertCurrent = () => {
      if (!current) {
        throw new Error("event source retired");
      }
    };
    event.beforeStart = async () => {
      entered.resolve();
      await release.promise;
    };
    const followupRun = createFollowupRun();
    followupRun.run.internalEventExecution = event;
    const pending = executeAgentTurn(createMinimalRunAgentTurnParams({ followupRun }));
    const rejected = expect(pending).rejects.toThrow("event source retired");
    try {
      await withinTest(entered.promise, signal);
      current = false;
      expect(state.resolveCurrentTurnImagesMock).not.toHaveBeenCalled();
      expect(state.runEmbeddedAgentMock).not.toHaveBeenCalled();
      expect(event.onTerminal).not.toHaveBeenCalled();
    } finally {
      release.resolve();
    }
    await rejected;
    expect(state.runEmbeddedAgentMock).not.toHaveBeenCalled();
    expect(event.onStarted).not.toHaveBeenCalled();
    expect(event.onTerminal).toHaveBeenCalledExactlyOnceWith(expect.any(String), "failed");
  });

  it("records event start and terminal once through the ordinary embedded executor", async () => {
    const event = createEventExecution();
    const followupRun = createFollowupRun();
    followupRun.run.internalEventExecution = event;
    state.runEmbeddedAgentMock.mockImplementationOnce(
      async (params: RunEmbeddedAgentInternalParams) => {
        expect(params.trigger).toBe("event");
        params.onExecutionPhase?.({ phase: "model_call_started" });
        params.onExecutionPhase?.({ phase: "assistant_output_started" });
        return { payloads: [{ text: "done" }], meta: {} };
      },
    );
    const result = await executeAgentTurn(createMinimalRunAgentTurnParams({ followupRun }));
    expect(result.outcome).toMatchObject({ kind: "settled", status: "ok" });
    expect(event.onStarted).toHaveBeenCalledExactlyOnceWith(result.runId);
    expect(event.onTerminal).toHaveBeenCalledExactlyOnceWith(result.runId, "completed");
  });

  it("does not record a second terminal when the source terminal callback fails", async () => {
    const event = createEventExecution();
    const terminal = vi.fn(async () => {
      throw new Error("event settlement retired");
    });
    event.onTerminal = terminal;
    const followupRun = createFollowupRun();
    followupRun.run.internalEventExecution = event;
    state.runEmbeddedAgentMock.mockResolvedValueOnce({ payloads: [{ text: "done" }], meta: {} });
    await expect(
      executeAgentTurn(createMinimalRunAgentTurnParams({ followupRun })),
    ).rejects.toThrow("event settlement retired");
    expect(terminal).toHaveBeenCalledExactlyOnceWith(expect.any(String), "completed");
  });

  it.for([false, true])(
    "completes before terminal drain and admission close, preserving the execution outcome (failure=%s)",
    async (fails, { signal }) => {
      const registry = await vi.importActual<typeof import("../../infra/agent-run-registry.js")>(
        "../../infra/agent-run-registry.js",
      );
      vi.mocked(registerAgentRunContext).mockImplementationOnce(registry.registerAgentRunContext);
      const terminalWrite = createDeferred();
      const completionEntered = createDeferred();
      const failure = new Error("completion failed");
      const event = createEventExecution();
      const onAgentRunTerminalOutcome = vi.fn();
      const followupRun = createFollowupRun();
      followupRun.run.internalEventExecution = event;
      let admission: PreparedAgentRunAdmission | undefined;
      let runId = "";
      state.runEmbeddedAgentMock.mockImplementationOnce(
        async (params: RunEmbeddedAgentInternalParams) => {
          runId = params.runId;
          admission = params.preparedRunAdmission;
          expect(admission).toBeDefined();
          await admission!.admit("embedded");
          const persistence = captureAgentRunTerminalPersistence(runId);
          expect(persistence.track).toBeDefined();
          persistence.track!(terminalWrite.promise);
          return { payloads: [{ text: "done" }], meta: {} };
        },
      );
      let finished = false;
      const pending = executeAgentTurn({
        ...createMinimalRunAgentTurnParams({ followupRun, opts: { onAgentRunTerminalOutcome } }),
        complete: async (execution, instance) => {
          expect(execution.outcome).toMatchObject({ kind: "settled", status: "ok" });
          expect(instance).toBe(admission!.operationalRunInstance);
          await admission!.admit("embedded");
          completionEntered.resolve();
          if (fails) {
            throw failure;
          }
        },
      });
      const observed = pending.then(
        (value) => {
          finished = true;
          return { value };
        },
        (error: unknown) => {
          finished = true;
          return { error };
        },
      );
      try {
        await withinTest(
          awaitGateBeforeSettlement(completionEntered.promise, pending, "completion was skipped"),
          signal,
        );
        expect(finished).toBe(false);
        await admission!.admit("embedded");
        terminalWrite.resolve();
        if (fails) {
          expect(await observed).toEqual({ error: failure });
        } else {
          expect(await observed).toMatchObject({ value: { outcome: { status: "ok" } } });
        }
        await expect(admission!.admit("embedded")).rejects.toThrow("already closed");
        expect(onAgentRunTerminalOutcome).toHaveBeenCalledExactlyOnceWith("completed");
        expect(event.onTerminal).toHaveBeenCalledExactlyOnceWith(runId, "completed");
      } finally {
        terminalWrite.resolve();
        await observed;
        registry.clearAgentRunContext(runId);
      }
    },
  );
});
