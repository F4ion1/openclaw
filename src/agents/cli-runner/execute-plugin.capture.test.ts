import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  activateMcpLoopbackClientGrantCapture,
  deactivateMcpLoopbackClientGrantCapture,
  mintMcpLoopbackClientGrant,
  registerMcpLoopbackClientGrantRevocationListener,
  resolveMcpLoopbackClientGrant,
  revokeMcpLoopbackClientGrant,
  transferMcpLoopbackClientGrant,
} from "../../gateway/mcp-grant-store.js";
import {
  markMcpLoopbackToolCallFinished,
  markMcpLoopbackToolCallStarted,
  recordMcpLoopbackToolCallResult,
  updateMcpLoopbackToolCallCapture,
} from "../../gateway/mcp-http.loopback-runtime.js";
import type { CliBackendLiveSessionHandle } from "../../plugins/cli-backend.types.js";
import { createReplyOperation } from "../../sessions/session-controller.operation.js";
import { getAdmittedRunDelegatedAuthority } from "../admitted-run-context.js";
import {
  closePluginTestAdmissions,
  createExecution,
  runPlugin,
  SUCCESS_RESULT,
  waitUntilAborted,
} from "./execute-plugin.test-support.js";
import { createCliToolTracking } from "./execute-tool-tracking.js";
import type { PreparedCliRunContext } from "./types.js";

const activeSessions = new Set<CliBackendLiveSessionHandle>();

afterEach(() => {
  for (const session of activeSessions) {
    session.close("restart");
  }
  activeSessions.clear();
  closePluginTestAdmissions();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function prepareCapture(context: PreparedCliRunContext, abortSignal?: AbortSignal) {
  const runtimeOwnerToken = `runtime-${context.params.runId}`;
  const grant = mintMcpLoopbackClientGrant({
    context: { sessionKey: context.params.sessionKey!, senderIsOwner: false },
    runtimeOwnerToken,
    admittedRunContext: context.params.admittedRunContext,
    abortSignal,
  });
  const owner = { token: grant.token, runtimeOwnerToken };
  context.preparedBackend.mcpClientGrantCapture = {
    transportToken: grant.token,
    adoptProcessToken: (targetToken) =>
      void transferMcpLoopbackClientGrant({
        sourceToken: grant.token,
        targetToken,
        runtimeOwnerToken,
      }),
    revokeProcessToken: () => {
      revokeMcpLoopbackClientGrant(grant.token);
    },
    activate: (captureKey, assertCurrent) =>
      void activateMcpLoopbackClientGrantCapture({ ...owner, captureKey, assertCurrent }),
    deactivate: (captureKey) =>
      void deactivateMcpLoopbackClientGrantCapture({ ...owner, captureKey }),
  };
  const tracking = createCliToolTracking(context);
  const captureKey = `capture-${context.params.runId}`;
  const capture = { ...owner, captureKey };
  return {
    tracking,
    capture,
    mcpCapture: {
      captureKey,
      beginCapture: tracking.beginGatewayCapture,
      cancelCapture: tracking.cancelCapture,
    },
    close() {
      tracking.finalizeCapture(() => {});
      revokeMcpLoopbackClientGrant(grant.token);
    },
  };
}

describe("CLI MCP capture authority", () => {
  it.each([
    { name: "one-shot timeout", liveSession: false, sourceStop: false, iteratorFailure: false },
    {
      name: "live backend cancellation",
      liveSession: true,
      sourceStop: false,
      iteratorFailure: false,
    },
    {
      name: "external Stop without partial output",
      liveSession: false,
      sourceStop: true,
      iteratorFailure: false,
    },
    { name: "throwing iterator", liveSession: false, sourceStop: false, iteratorFailure: true },
  ])(
    "publishes capture cancellation before iterator cleanup after $name",
    async ({ liveSession, sourceStop, iteratorFailure }) => {
      vi.useFakeTimers();
      const source = new AbortController();
      const { context } = await createExecution({ abortSignal: source.signal, timeoutMs: 100 });
      const operation = createReplyOperation({
        sessionKey: context.params.sessionKey!,
        sessionId: context.params.sessionId,
        resetTriggered: false,
      });
      context.params.replyOperation = operation;
      const fixture = prepareCapture(context, source.signal);
      const streamStarted = createDeferred();
      const streamClosing = createDeferred();
      const releaseCleanup = createDeferred();
      const failStream = createDeferred();
      const iteratorError = new Error("Synthetic iterator failure");
      const run = runPlugin(
        context,
        function (execution): AsyncIterableIterator<Record<string, unknown>> {
          if (liveSession) {
            const capability = execution.liveSession;
            if (!capability) {
              throw new Error("expected live CLI session capability");
            }
            const handle: CliBackendLiveSessionHandle = {
              generation: context.params.runId,
              fingerprint: capability.fingerprint,
              isIdle: () => true,
              close: () => capability.remove(handle),
              waitForExit: async () => {},
            };
            capability.register(handle);
            activeSessions.add(handle);
            capability.activate(handle);
          }
          return {
            [Symbol.asyncIterator]() {
              return this;
            },
            async next() {
              const next = iteratorFailure
                ? failStream.promise.then(() => {
                    throw iteratorError;
                  })
                : waitUntilAborted(execution);
              streamStarted.resolve();
              await next;
              return { done: true, value: undefined };
            },
            async return() {
              streamClosing.resolve();
              await releaseCleanup.promise;
              return { done: true, value: undefined };
            },
          };
        },
        { liveSession, mcpCapture: fixture.mcpCapture },
      );
      const observedRun = run.catch((error: unknown) => error);
      let unsubscribe: (() => void) | undefined;
      try {
        await streamStarted.promise;
        const retained = resolveMcpLoopbackClientGrant(fixture.capture);
        expect(retained?.isCurrent()).toBe(true);
        let invalidations = 0;
        unsubscribe = registerMcpLoopbackClientGrantRevocationListener((event) => {
          if (event.token === fixture.capture.token) {
            invalidations += 1;
          }
        });

        if (iteratorFailure) {
          failStream.resolve();
        } else if (sourceStop) {
          source.abort(new Error("Synthetic external Stop"));
        } else if (liveSession) {
          expect(operation.abortByUser()).toBe(true);
        } else {
          await vi.advanceTimersByTimeAsync(100);
        }
        await streamClosing.promise;

        expect(source.signal.aborted).toBe(sourceStop);
        expect(getAdmittedRunDelegatedAuthority(context.params.admittedRunContext)).toBeDefined();
        expect(retained?.isCurrent()).toBe(false);
        expect(resolveMcpLoopbackClientGrant(fixture.capture)).toBeUndefined();
        // Pending input has no active HTTP stream; projections retire it from this owner event.
        expect(invalidations).toBe(1);
      } finally {
        unsubscribe?.();
        releaseCleanup.resolve();
        await observedRun;
        fixture.close();
        operation.complete();
      }
      if (iteratorFailure) {
        expect(await observedRun).toBe(iteratorError);
      } else {
        expect(await observedRun).toMatchObject(
          liveSession || sourceStop
            ? { name: "AbortError" }
            : { reason: "overall-timeout", timedOut: true },
        );
      }
    },
  );

  it("keeps normal-exit authority and capture observers until an admitted call drains", async () => {
    const { context } = await createExecution();
    const fixture = prepareCapture(context);
    const toolName = "inspect.raw";
    const args = { value: "synthetic" };
    const toolCallId = "native-call";
    let captured: ReturnType<typeof markMcpLoopbackToolCallStarted>;
    try {
      await runPlugin(
        context,
        async function* () {
          fixture.tracking.handleCliToolUseStart({
            toolCallId,
            name: toolName,
            kind: "mcp_tool_use",
            args,
          });
          captured = markMcpLoopbackToolCallStarted({
            captureKey: fixture.capture.captureKey,
            toolName,
            args,
          });
          expect(captured).toBeDefined();
          updateMcpLoopbackToolCallCapture(captured, { toolName, args });
          yield SUCCESS_RESULT;
        },
        { mcpCapture: fixture.mcpCapture },
      );
      expect(resolveMcpLoopbackClientGrant(fixture.capture)?.isCurrent()).toBe(true);
      let drained = false;
      const errors: unknown[] = [];
      const draining = fixture.tracking
        .finishDeliveryTracking({
          useManagedClaudeLiveSession: false,
          recordRunError: (error) => errors.push(error),
        })
        .then(() => {
          drained = true;
        });
      await Promise.resolve();
      expect(drained).toBe(false);
      if (!captured) {
        throw new Error("expected an admitted native call");
      }
      recordMcpLoopbackToolCallResult({
        captureHandle: captured,
        toolName,
        args,
        outcome: "completed",
        result: { content: [{ type: "text", text: "late result" }] },
      });
      markMcpLoopbackToolCallFinished(captured);
      await draining;
      expect(errors).toEqual([]);
      expect(fixture.tracking.resolveCliLoopbackTerminalOutcome(toolCallId)).toEqual({
        outcome: "completed",
      });
    } finally {
      markMcpLoopbackToolCallFinished(captured);
      fixture.close();
    }
  });
});
