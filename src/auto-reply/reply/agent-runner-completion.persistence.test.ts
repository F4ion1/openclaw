import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import { prepareAgentCommandExecutionIdentity } from "../../agents/agent-command-execution-identity.js";
import { withAgentDeletion } from "../../agents/agent-lifecycle-registry.js";
import { renderStorageFailureSummary } from "../../agents/failover/assistant-request-failure-copy.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import type { SessionActivitySummary } from "../../config/sessions/activity-summary.js";
import {
  applySessionEntryOperation,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.sqlite-entry.js";
import { persistSessionTranscriptTurn } from "../../config/sessions/session-accessor.transcript-turn.js";
import { drainSessionStoreWriterQueuesForTest } from "../../config/sessions/store-writer-state.test-support.js";
import { createSessionActivitySummaries } from "../../gateway/session-activity-summaries.js";
import {
  beginActivitySummaryCompletion,
  type PendingSessionActivitySummaryCompletion,
} from "../../gateway/session-activity-summary-completion.js";
import { createSessionLifecyclePersistenceOwner } from "../../gateway/session-lifecycle-persistence-owner.js";
import type { defaultCompleteModel } from "../../gateway/session-observer-model.js";
import * as observerModel from "../../gateway/session-observer-model.js";
import {
  clearAgentRunContext,
  getAgentRunLifecycleGeneration,
  registerAgentRunContext,
} from "../../infra/agent-run-registry.js";
import {
  bindAgentRunTerminalWriteSettlement,
  captureAgentRunTerminalPersistence,
  drainAgentRunTerminalWrites,
} from "../../infra/agent-run-terminal-writes.js";
import { classifyGatewayStorageFailure } from "../../infra/sqlite-error-diagnostics.js";
import { publishAgentDeletionWorkAdmission } from "../../sessions/session-agent-work-admission.js";
import type { ReplyOperation } from "../../sessions/session-controller.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { AsyncWorkScope, trackAsyncWork } from "../../shared/async-work-scope.js";
import { runOutsideStoreWriterContext } from "../../shared/store-writer-queue.js";
import { disposeOpenClawAgentDatabaseByPath } from "../../state/openclaw-agent-db-disposal.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import {
  agentAccountingPersistenceDiagnostic as diagnostic,
  createAgentAccountingPersistenceFixture,
  observeCompletionCommands,
} from "./agent-runner-result-accounting.persistence.test-support.js";
import { finalizeReplyAgentRun } from "./agent-runner-result.js";
import { touchQueuedReplySessionActivity } from "./agent-runner-session-activity.js";

let root: string;
let storePath: string;
let sequence = 0;
const operations: ReplyOperation[] = [];
beforeAll(() => {
  // openclaw-temp-dir: allow suite database root drains before removal
  root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "openclaw-completion-"));
  storePath = path.join(root, "openclaw-agent.sqlite");
  openOpenClawAgentDatabase({ agentId: "main", path: storePath });
});
afterEach(() => {
  for (const operation of operations.splice(0)) {
    operation.complete();
  }
});
afterAll(async () => {
  await drainSessionStoreWriterQueuesForTest();
  await disposeOpenClawAgentDatabaseByPath(storePath);
  await closeOpenClawAgentDatabasesAsync(root);
  fs.rmSync(root, { recursive: true, force: true });
});
function createFixture() {
  return createAgentAccountingPersistenceFixture({
    storePath,
    root,
    fixtureId: ++sequence,
    registerOperation: (operation) => operations.push(operation),
  });
}

it.for(["ready", "late-idle", "shutdown", "abandoned", "replaced"] as const)(
  "persists a %s activity recap without a second reply",
  async (timing, { signal }) => {
    const fixture = await createFixture();
    const sessionKey = fixture.context.sessionKey!;
    const cfg = {
      ...fixture.context.cfg,
      agents: { defaults: { utilityModel: "test/utility" } },
    };
    await persistSessionTranscriptTurn(
      { storePath, sessionKey, sessionId: fixture.sessionId, agentId: "main" },
      {
        messages: [
          { eventId: "request", message: { role: "user", content: "Verify the change." } },
        ],
        touchSessionEntry: false,
      },
    );
    const started = createDeferred();
    const cleanup = createDeferred();
    const result = createDeferred<Awaited<ReturnType<typeof defaultCompleteModel>>>();
    const work = new AsyncWorkScope();
    const scheduler = createTestGatewayScheduler();
    const prepare = vi.spyOn(observerModel, "defaultPrepareModel").mockResolvedValue({
      config: cfg,
      authProfileId: undefined,
      provider: "test",
      model: "utility",
      agentId: "main",
      agentDir: root,
      outputTextPolicy: "strict-visible",
      thinkLevel: "off",
    });
    const complete = vi
      .spyOn(observerModel, "defaultCompleteModel")
      .mockImplementation(async () => {
        void trackAsyncWork(() => cleanup.promise);
        started.resolve();
        return result.promise;
      });
    const service = createSessionActivitySummaries({
      scheduler,
      getConfig: () => cfg,
      onChanged() {},
    });
    const finishModel = () =>
      result.resolve({
        text: "Verified the change.",
        provider: "test",
        model: "utility",
        owner: { kind: "harness", id: "test" },
      });
    const completion = service.beginCompletion(
      { key: sessionKey, agentId: "main", storePath },
      fixture.read(),
    )!;
    fixture.context.activitySummaryCompletion = completion;
    fixture.context.execution.result.meta.agentMeta = {
      sessionId: fixture.sessionId,
      provider: diagnostic.provider,
      model: diagnostic.model,
      usage: { input: 120, output: 8 },
    };
    const observer = observeCompletionCommands();
    try {
      work.run(() =>
        service.handleEvent({
          sessionKey,
          agentId: "main",
          runId: fixture.context.runId,
          seq: 1,
          ts: Date.now(),
          stream: "lifecycle",
          data: { phase: "end" },
        }),
      );
      await withinTest(started.promise, signal);
      if (timing !== "late-idle") {
        finishModel();
        // Let the model's promise continuations offer their result before accounting starts.
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        expect(fixture.read()?.activitySummary).toBeUndefined();
      }
      if (timing === "ready" || timing === "late-idle") {
        await expect(finalizeReplyAgentRun(fixture.context)).resolves.toMatchObject({
          text: "done",
        });
        expect(fixture.read()).toMatchObject({ inputTokens: 120, outputTokens: 8 });
        expect(
          observer.commands.filter((command) => command === "session.actor.completeTurn"),
        ).toHaveLength(1);
      }
      finishModel();
      if (timing === "replaced") {
        await replaceSessionEntry(
          { storePath, sessionKey },
          {
            ...fixture.read()!,
            sessionId: "replacement-session",
            lifecycleRevision: "replacement",
          },
        );
      }
      if (timing !== "ready") {
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        await drainSessionStoreWriterQueuesForTest();
        if (timing !== "replaced") {
          expect(observer.commands).not.toContain("session.entry.patch.commit");
        }
        expect(fixture.read()?.activitySummary).toBeUndefined();
        cleanup.resolve();
        if (timing === "shutdown") {
          await service.dispose();
        } else if (timing === "abandoned") {
          await completion.settle();
        }
        // A late result is saved by the recap job's existing idle-settlement tail.
      }
      cleanup.resolve();
      await withinTest(work.drain(), signal);
      if (timing === "replaced") {
        await service.dispose();
        expect(fixture.read()?.activitySummary).toBeUndefined();
        return;
      }
      expect(fixture.read()?.activitySummary).toMatchObject({
        text: "Verified the change.",
        coveredMessages: 1,
      });
      expect(
        observer.commands.filter((command) => command === "session.entry.patch.commit"),
      ).toHaveLength(timing === "ready" ? 0 : 1);
    } finally {
      cleanup.resolve();
      finishModel();
      await service.dispose();
      await scheduler.stop();
      observer.restore();
      prepare.mockRestore();
      complete.mockRestore();
    }
  },
);

it.for(["refused", "superseded"] as const)(
  "retains the pending recap after a %s commit",
  async (scenario) => {
    const fixture = await createFixture();
    const sessionKey = fixture.context.sessionKey!;
    const owner: { completion?: PendingSessionActivitySummaryCompletion } = {};
    const failed = vi.fn();
    const completion = beginActivitySummaryCompletion(owner, () => {}, failed);
    const summary: SessionActivitySummary = {
      version: 1,
      text: "First recap",
      updatedAt: 1,
      sessionId: fixture.sessionId,
      lifecycleRevision: "generation-1",
      generation: null,
      maxSeq: null,
      leafEntryId: null,
      coveredMessages: 0,
      totalMessages: 0,
      omittedContent: false,
    };
    const offer = (value: SessionActivitySummary) =>
      owner.completion!.offer(value, (onCommitted) =>
        applySessionEntryOperation(
          { storePath, sessionKey },
          { kind: "activity-summary", sessionKey, summary: value },
          { preserveActivity: true, result: "none", onCommitted },
        ),
      );
    const newer = { ...summary, text: "Newer recap", updatedAt: 2 };
    if (scenario === "refused") {
      const refused = { ...summary, sessionId: "different-session" };
      offer(refused);
      await completion.settle();
      expect(owner.completion!.pending()).toEqual(refused);
      expect(fixture.read()?.activitySummary).toBeUndefined();
      offer(newer);
      await owner.completion!.flush();
    } else {
      offer(summary);
      fixture.context.activitySummaryCompletion = completion;
      fixture.setMeta({ usage: { input: 1, output: 1 } });
      const observer = observeCompletionCommands({
        beforeCommit() {
          offer(newer);
        },
      });
      try {
        await finalizeReplyAgentRun(fixture.context);
      } finally {
        observer.restore();
      }
    }
    expect(failed).not.toHaveBeenCalled();
    expect(fixture.read()?.activitySummary?.text).toBe("Newer recap");
    expect(owner.completion!.pending()).toBeUndefined();
  },
);

it.each([
  { stage: "initial", count: 1 },
  { stage: "refresh", count: 1 },
  { stage: "initial", count: 2 },
] as const)(
  "preserves the completed reply after $count cache-only invalidations during the $stage read",
  async ({ stage, count }) => {
    const fixture = await createFixture();
    const invalidate = () =>
      sessionChanges.invalidate({
        sessionKey: fixture.context.sessionKey!,
        storePath,
        factsInvalidated: true,
      });
    let armed = stage === "initial";
    let invalidations = 0;
    const normalize = vi.fn<typeof fixture.context.replyMediaContext.normalizePayload>(
      async (payload) => {
        if (stage === "refresh") {
          invalidate();
          armed = true;
        }
        return payload;
      },
    );
    fixture.context.execution.result.payloads = [
      { text: "done", mediaUrl: "https://example.invalid/final.png" },
    ];
    fixture.context.replyMediaContext.normalizePayload = normalize;
    fixture.context.execution.result.meta.agentMeta = {
      sessionId: fixture.sessionId,
      provider: diagnostic.provider,
      model: diagnostic.model,
      usage: { input: 120, output: 8 },
    };
    const observer = observeCompletionCommands({
      afterRead() {
        if (armed) {
          armed = false;
          // Cache-only invalidation does not revoke the unchanged scoped write token.
          for (let index = 0; index < count; index += 1) {
            invalidations += 1;
            invalidate();
          }
        }
      },
    });
    try {
      await expect(finalizeReplyAgentRun(fixture.context)).resolves.toMatchObject({ text: "done" });
      expect(invalidations).toBe(count);
      expect(normalize).toHaveBeenCalledOnce();
      expect(observer.commands.filter((command) => command === "session.actor.read")).toHaveLength(
        stage === "initial" ? 1 : 2,
      );
      expect(
        observer.commands.filter((command) => command === "session.actor.completeTurn"),
      ).toHaveLength(1);
      const stored = fixture.read();
      expect(stored).toMatchObject({
        inputTokens: 120,
        outputTokens: 8,
        pendingFinalDelivery: {
          text: "done\nMEDIA:https://example.invalid/final.png",
          deliveries: [{ state: "prepared" }],
        },
      });
    } finally {
      observer.restore();
    }
  },
);

it.each(["unrelated-error", "writer-replaced"] as const)(
  "does not retry or publish a completed reply past %s",
  async (failure) => {
    const fixture = await createFixture();
    let reads = 0;
    let replacement: Promise<unknown> | undefined;
    const observer = observeCompletionCommands({
      afterRead() {
        reads += 1;
        if (failure === "unrelated-error") {
          // Identical text must not turn an unrelated failure into a retry signal.
          throw new Error("Session actor changed before its read could publish");
        }
        if (failure === "writer-replaced" && reads === 1) {
          replacement = runOutsideStoreWriterContext(() =>
            fixture.replace({
              ...fixture.context.activeSessionEntry!,
              activeWriterRunId: "replacement-writer",
            }),
          );
        }
        if (reads === 1) {
          sessionChanges.invalidate({
            sessionKey: fixture.context.sessionKey!,
            storePath,
            factsInvalidated: true,
          });
        }
      },
    });
    try {
      await expect(finalizeReplyAgentRun(fixture.context)).rejects.toThrow(
        failure === "writer-replaced"
          ? "Terminal accounting session changed"
          : "Session actor changed before its read could publish",
      );
      await replacement;
      // Replacement is rejected at admission before another worker read can execute.
      expect(reads).toBe(1);
      expect(observer.commands).not.toContain("session.actor.completeTurn");
      expect(fixture.read()?.pendingFinalDelivery).toBeUndefined();
      expect(fixture.read()?.inputTokens).toBeUndefined();
      if (failure === "writer-replaced") {
        expect(fixture.read()?.activeWriterRunId).toBe("replacement-writer");
      }
    } finally {
      observer.restore();
    }
  },
);

it.each(["publication-failure", "unknown-commit", "unknown-storage-commit"] as const)(
  "does not disclose or replay a durable final after %s",
  async (failure) => {
    const fixture = await createFixture();
    fixture.context.execution.result.meta.agentMeta = {
      sessionId: fixture.sessionId,
      provider: diagnostic.provider,
      model: diagnostic.model,
      usage: { input: 120, output: 8 },
    };
    if (failure === "publication-failure") {
      fixture.context.activeSessionStore = Object.freeze({ ...fixture.context.activeSessionStore });
    }
    const observer = observeCompletionCommands({
      hideCommittedReceipt: failure !== "publication-failure",
      lostReplyError:
        failure === "unknown-storage-commit"
          ? new Error("Worker response lost", {
              cause: Object.assign(new Error("database or disk is full"), { code: "SQLITE_FULL" }),
            })
          : undefined,
    });
    try {
      const error = await finalizeReplyAgentRun(fixture.context).catch(
        (caughtError: unknown) => caughtError,
      );
      expect(error).toEqual(expect.any(Error));
      expect(error).toHaveProperty(
        "message",
        failure === "unknown-storage-commit"
          ? "Worker response lost"
          : failure === "unknown-commit"
            ? "Unconfirmed actor settlement"
            : expect.stringMatching(/read only|readonly|extensible/i),
      );
      if (failure === "unknown-storage-commit") {
        expect(error).toHaveProperty("code", "outcome-unknown");
        expect(renderStorageFailureSummary(classifyGatewayStorageFailure(error))).toBe(
          "OpenClaw couldn't save your conversation because the disk is full. Free up space on the computer running OpenClaw before continuing.",
        );
      }
      expect(
        observer.commands.filter((command) => command === "session.actor.completeTurn"),
      ).toHaveLength(1);
      expect(fixture.read()).toMatchObject({
        inputTokens: 120,
        outputTokens: 8,
        pendingFinalDelivery: {
          text: "done",
          deliveries: [{ state: "prepared" }],
        },
      });
    } finally {
      observer.restore();
    }
  },
);

it("preserves storage guidance when queued activity loses its commit reply", async () => {
  const fixture = await createFixture();
  const original = fixture.context.activeSessionEntry!;
  const publish = vi.fn();
  const observer = observeCompletionCommands({
    hideCommittedReceipt: true,
    lostReplyError: new Error("Worker response lost", {
      cause: Object.assign(new Error("database or disk is full"), { code: "SQLITE_FULL" }),
    }),
  });
  try {
    const error = await touchQueuedReplySessionActivity(
      {
        followupRun: fixture.context.followupRun,
        sessionKey: fixture.context.sessionKey,
        sessionStore: fixture.context.activeSessionStore,
        storePath,
      },
      original,
      publish,
    ).catch((caughtError: unknown) => caughtError);
    expect(error).toHaveProperty("code", "outcome-unknown");
    expect(renderStorageFailureSummary(classifyGatewayStorageFailure(error))).toBe(
      "OpenClaw couldn't save your conversation because the disk is full. Free up space on the computer running OpenClaw before continuing.",
    );
    expect(observer.commands.filter((command) => command === "session.actor.patch")).toHaveLength(
      1,
    );
    expect(fixture.read()?.updatedAt).toBeGreaterThan(original.updatedAt);
    expect(publish).not.toHaveBeenCalled();
    expect(fixture.context.activeSessionStore?.[fixture.context.sessionKey!]).toBe(original);
  } finally {
    observer.restore();
  }
});

it.each(["usage-only", "with-final-custody"] as const)(
  "preserves %s failure semantics after a proven worker rollback",
  async (kind) => {
    const fixture = await createFixture();
    const meta = {
      sessionId: fixture.sessionId,
      provider: diagnostic.provider,
      model: diagnostic.model,
      usage: { input: 120, output: 8 },
    };
    fixture.context.execution.result.meta.agentMeta = meta;
    const before = fixture.read();
    const beforeCommit = vi.fn(() => {
      throw new Error("synthetic completion refusal");
    });
    const observer = observeCompletionCommands({ beforeCommit });
    try {
      if (kind === "usage-only") {
        await expect(fixture.account("ordinary", meta)).resolves.toBeUndefined();
      } else {
        await expect(finalizeReplyAgentRun(fixture.context)).rejects.toThrow(
          "synthetic completion refusal",
        );
      }
      expect(
        observer.commands.filter((command) => command === "session.actor.completeTurn"),
      ).toHaveLength(1);
      expect(beforeCommit).toHaveBeenCalledOnce();
      expect(fixture.read()).toEqual(before);
    } finally {
      observer.restore();
    }
  },
);

it("rechecks the live reply operation at the final commit boundary", async () => {
  const fixture = await createFixture();
  const before = fixture.read();
  const beforeCommit = vi.fn(() => {
    fixture.context.replyOperation.complete();
  });
  const observer = observeCompletionCommands({ beforeCommit });
  try {
    await expect(finalizeReplyAgentRun(fixture.context)).rejects.toThrow(
      "Terminal accounting lost its reply operation",
    );
    expect(
      observer.commands.filter((command) => command === "session.actor.completeTurn"),
    ).toHaveLength(1);
    expect(beforeCommit).toHaveBeenCalledOnce();
    expect(fixture.read()).toEqual(before);
  } finally {
    observer.restore();
  }
});

it.each(["commit", "rollback", "publication-failure", "deletion"] as const)(
  "settles lifecycle and final delivery in one actor request after %s",
  async (mode) => {
    const fixture = await createFixture();
    const { context, sessionId } = fixture;
    const sessionKey = context.sessionKey!;
    const runId = context.runId;
    context.followupRun.run.agentId = "main";
    setRuntimeConfigSnapshot(context.cfg);
    const initial = { ...context.activeSessionEntry!, lifecycleRunId: runId, startedAt: 1_000 };
    await fixture.replace(initial);
    const before = fixture.read();
    context.activeSessionEntry = initial;
    const lifecycleGeneration = getAgentRunLifecycleGeneration();
    const admission = prepareAgentCommandExecutionIdentity({
      opts: { message: "Complete the request." },
      prepared: {
        cfg: context.cfg,
        runId,
        sessionAgentId: "main",
        sessionId,
        sessionKey,
        sessionEntry: initial,
        storePath,
      },
      ingress: { kind: "system", boundary: "completion-test", state: "present" },
      lifecycleGeneration,
    });
    registerAgentRunContext(runId, { sessionKey, sessionId, agentId: "main", lifecycleGeneration });
    bindAgentRunTerminalWriteSettlement(admission.operationalRunInstance, true);
    context.completionInstance = admission.operationalRunInstance;
    const owner = createSessionLifecyclePersistenceOwner();
    const captured = captureAgentRunTerminalPersistence(runId);
    const deletionOperationId = `completion-deletion-${runId}`;
    const observer = observeCompletionCommands({
      beforeCommit() {
        if (mode === "rollback") {
          throw new Error("refuse fused completion");
        }
        if (mode === "deletion") {
          publishAgentDeletionWorkAdmission({ agentId: "main" }, deletionOperationId, true);
        }
      },
    });
    const persistence = owner.observe({
      sessionKey,
      agentId: "main",
      writeContext: captured.writeContext,
      event: {
        runId,
        sessionId,
        lifecycleGeneration,
        seq: 2,
        stream: "lifecycle",
        ts: 2_000,
        data: { phase: "end", startedAt: 1_000, endedAt: 2_000 },
      },
    });
    captured.track?.(persistence);
    void persistence.catch(() => {});
    if (mode === "publication-failure") {
      context.activeSessionStore = Object.freeze({ ...context.activeSessionStore });
    }
    try {
      if (mode === "commit") {
        await expect(finalizeReplyAgentRun(context)).resolves.toMatchObject({ text: "done" });
      } else {
        await expect(finalizeReplyAgentRun(context)).rejects.toThrow(
          mode === "rollback"
            ? "refuse fused completion"
            : mode === "deletion"
              ? "deletion cleanup is still pending"
              : /read only|readonly|extensible/i,
        );
      }
      await drainAgentRunTerminalWrites(admission.operationalRunInstance);
      if (mode === "rollback") {
        await expect(persistence).rejects.toThrow("refuse fused completion");
        expect(fixture.read()).toEqual(before);
      } else if (mode === "deletion") {
        await expect(persistence).resolves.toBeUndefined();
        expect(fixture.read()).toEqual(before);
        expect(observer.commands).not.toContain("session.entry.patch.commit");
        await closeOpenClawAgentDatabaseByPathAsync(storePath, "main");
        // Rollback replays retained outcomes under deletion's live cleanup authority.
        await withAgentDeletion("main", async (begin) => {
          const deletion = await begin({
            agentId: "main",
            agentDir: root,
            workspaceDir: root,
            sessionsDir: path.join(root, "sessions"),
          });
          await deletion.rollback();
        });
        expect(fixture.read()).toMatchObject({ status: "done", endedAt: 2_000 });
        expect(fixture.read()?.lifecycleRunId).toBeUndefined();
        expect(fixture.read()?.pendingFinalDelivery).toBeUndefined();
        expect(
          observer.commands.filter((command) => command === "session.entry.patch.commit"),
        ).toHaveLength(1);
      } else {
        await persistence;
        expect(fixture.read()).toMatchObject({
          status: "done",
          endedAt: 2_000,
          pendingFinalDelivery: { text: "done" },
        });
        expect(fixture.read()?.lifecycleRunId).toBeUndefined();
      }
      expect(
        observer.commands.filter((command) => command === "session.actor.completeTurn"),
      ).toHaveLength(1);
      if (mode !== "deletion") {
        expect(observer.commands).not.toContain("session.entry.patch.commit");
      }
    } finally {
      await drainAgentRunTerminalWrites(admission.operationalRunInstance);
      await owner.drain();
      observer.restore();
      if (mode === "deletion") {
        publishAgentDeletionWorkAdmission({ agentId: "main" }, deletionOperationId, false);
      }
      admission.close();
      clearAgentRunContext(runId, lifecycleGeneration);
      clearRuntimeConfigSnapshot();
    }
  },
);
