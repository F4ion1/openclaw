import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { afterEach, expect, it } from "vitest";
import { isProcessAlive } from "../../../test/helpers/process-wait.js";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import type { CliBackendLiveSessionHandle } from "../../plugins/cli-backend.types.js";
import { prepareSystemAgentRunAdmission } from "../admitted-run-context.js";
import { buildPreparedCliRunContext } from "../cli-runner.test-helpers.js";
import {
  createCliLiveSessionCapability,
  disposeCliLiveSessionsForSession,
} from "./cli-live-session-registry.js";

const fixtures: Array<{ close: () => void; exited: Promise<void> }> = [];

async function createSession(
  agentId: string,
  sessionId: string,
  signal: AbortSignal,
  cleanup: () => Promise<void> = async () => {},
) {
  const context = buildPreparedCliRunContext({
    agentId,
    sessionId,
    sessionKey: `agent:${agentId}:${sessionId}`,
    runId: randomUUID(),
  });
  const admission = prepareSystemAgentRunAdmission(
    {},
    context.params.runId,
    agentId,
    "retirement-test",
  );
  context.params.admittedRunContext = await admission.admit("plugin-harness");
  const child = spawn(process.execPath, [
    "-e",
    "process.stdin.on('data', () => process.stdout.write('alive')); process.stdout.write('ready')",
  ]);
  const exited = once(child, "close").then(() => undefined);
  const capability = createCliLiveSessionCapability({
    context,
    argv: [process.execPath],
    env: {},
    beginCapture() {},
    abortSignal: new AbortController().signal,
    claimResources: () => cleanup,
  });
  const handle: CliBackendLiveSessionHandle = {
    generation: randomUUID(),
    fingerprint: capability.fingerprint,
    isIdle: () => true,
    close: () => {
      capability.remove(handle);
      child.kill("SIGTERM");
    },
    waitForExit: () => exited,
  };
  fixtures.push({ close: () => handle.close("abort"), exited });
  try {
    await withinTest(once(child.stdout, "data"), signal);
    capability.register(handle);
  } finally {
    admission.close();
  }
  return {
    child,
    handle,
    async ping() {
      const response = once(child.stdout, "data");
      child.stdin.write("ping");
      expect(String((await withinTest(response, signal))[0])).toBe("alive");
    },
  };
}

afterEach(async () => {
  const current = fixtures.splice(0);
  for (const fixture of current) {
    fixture.close();
  }
  await Promise.all(current.map((fixture) => fixture.exited));
});

it.for(["active", "already retiring"])(
  "retires only the selected %s CLI session and joins its resource cleanup",
  async (state, { signal }) => {
    const sessionId = randomUUID();
    const cleanupEntered = createDeferred();
    const releaseCleanup = createDeferred();
    const selected = await createSession("main", sessionId, signal, async () => {
      cleanupEntered.resolve();
      await releaseCleanup.promise;
    });
    const otherSession = await createSession("main", randomUUID(), signal);
    const otherAgent = await createSession("other", sessionId, signal);
    let disposal: Promise<void> | undefined;
    try {
      if (state === "already retiring") {
        selected.handle.close("abort");
        await withinTest(cleanupEntered.promise, signal);
      }
      let settled = false;
      disposal = disposeCliLiveSessionsForSession({ agentId: "main", sessionId });
      void disposal.then(
        () => (settled = true),
        () => (settled = true),
      );
      await withinTest(
        awaitGateBeforeSettlement(
          cleanupEntered.promise,
          disposal,
          "Selected CLI retirement returned before resource cleanup",
        ),
        signal,
      );
      expect(isProcessAlive(selected.child.pid!)).toBe(false);
      await otherSession.ping();
      await otherAgent.ping();
      expect(settled).toBe(false);
      releaseCleanup.resolve();
      await withinTest(disposal, signal);
      expect(isProcessAlive(selected.child.pid!)).toBe(false);
      expect(isProcessAlive(otherSession.child.pid!)).toBe(true);
      expect(isProcessAlive(otherAgent.child.pid!)).toBe(true);
    } finally {
      releaseCleanup.resolve();
      await disposal;
    }
  },
);
