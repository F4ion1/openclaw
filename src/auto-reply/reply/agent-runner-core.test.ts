import { describe, expect, it } from "vitest";
import { resolveReplyCompletion } from "../../agents/reply-completion.js";
import { createRestartRecoveryClaimChangedError } from "../../infra/agent-lifecycle-error.js";
import { createReplyOperation } from "../../sessions/session-controller.js";
import { resolveFallbackTransition } from "../fallback-state.js";
import { getReplyPayloadMetadata } from "../reply-payload.js";
import type { TemplateContext } from "../templating.js";
import { SILENT_REPLY_TOKEN } from "../tokens.js";
import {
  buildSilentFallbackFailurePayload,
  handleReplyAgentRunError,
  resolveReplyRunDeliveryContext,
} from "./agent-runner-core.js";

async function runError(
  id: string,
  error: unknown,
  overrides: Partial<Parameters<typeof handleReplyAgentRunError>[1]> = {},
  restart = false,
) {
  const replyOperation = createReplyOperation({
    sessionKey: `agent:main:${id}`,
    sessionId: id,
    turnKind: "visible",
    resetTriggered: false,
  });
  if (restart) {
    replyOperation.abortForRestart();
  }
  try {
    return await handleReplyAgentRunError(error, {
      resolveVisibleReplyDelivery: async () => false,
      isHeartbeat: false,
      replyExpectation: "required",
      isRestartRecoveryArmed: async () => false,
      replyOperation,
      resolvedVerboseLevel: "off",
      returnWithQueuedFollowupDrain: (value) => value,
      sessionCtx: {},
      ...overrides,
    });
  } finally {
    replyOperation.complete();
  }
}

it.each([false, true])(
  "awaits restart recovery before choosing the error reply (%s)",
  async (armed) => {
    const reply = await runError(
      `restart-read-${armed}`,
      new Error("restart"),
      { isRestartRecoveryArmed: async () => armed },
      true,
    );
    expect(reply?.text).toBe(
      armed ? undefined : "⚠️ Gateway is restarting. Please wait a few seconds and try again.",
    );
  },
);

it("renders restart recovery ownership changes as session guidance", async () => {
  const reply = await runError("restart-claim-changed", createRestartRecoveryClaimChangedError());
  expect(reply?.text).toBe(
    "⚠️ This conversation changed before your message could start. Check the latest messages, then try again if needed.",
  );
  expect(reply?.text).not.toContain("restart recovery claim");
});

it.each([false, true])(
  "keeps setup failures retryable only before durable acceptance (%s)",
  async (accepted) => {
    const failure = new Error("ENOSPC: turn preparation failed");
    const reply = runError(`input-acceptance-${accepted}`, failure, { userTurnAccepted: accepted });
    if (accepted) {
      await expect(reply).resolves.toMatchObject({
        isError: true,
        text: expect.not.stringContaining(SILENT_REPLY_TOKEN),
      });
    } else {
      await expect(reply).rejects.toBe(failure);
    }
  },
);

describe("resolveReplyRunDeliveryContext", () => {
  it.each([
    { name: "string message topic", messageThreadId: "99", threadId: "99" },
    { name: "session identity fallback", threadId: "12345:99" },
  ])("preserves the $name", ({ messageThreadId, threadId }) => {
    expect(
      resolveReplyRunDeliveryContext({
        cfg: {},
        sessionCtx: {
          Provider: "telegram",
          OriginatingChannel: "telegram",
          OriginatingTo: "telegram:12345",
          AccountId: "work",
          MessageThreadId: messageThreadId,
          SessionKey: "agent:main:telegram:direct:12345:thread:12345:99",
        } as TemplateContext,
        sessionKey: "agent:main:telegram:direct:12345:thread:12345:99",
      }),
    ).toEqual({
      channel: "telegram",
      to: "telegram:12345",
      accountId: "work",
      threadId,
    });
  });
});

describe("buildSilentFallbackFailurePayload", () => {
  const selected = { provider: "openai", model: "primary-model" };
  const other = { provider: "anthropic", model: "fallback-model" };
  const transition = resolveFallbackTransition({
    selectedProvider: selected.provider,
    selectedModel: selected.model,
    activeProvider: other.provider,
    activeModel: other.model,
    attempts: [],
  });
  const base = {
    fallbackTransition: transition,
    fallbackFailureKnown: true,
    fallbackAttempts: [],
    cfg: {},
    completion: resolveReplyCompletion("required", "empty"),
  };

  it("surfaces both model identities when a required fallback reply is missing", () => {
    const payload = buildSilentFallbackFailurePayload({
      ...base,
      cfg: { agents: { defaults: { silentReply: { group: "allow" } } } },
    });

    expect(payload?.isError).toBe(true);
    expect(payload?.text).toContain(transition.selectedModelRef);
    expect(payload?.text).toContain(transition.activeModelRef);
    expect(getReplyPayloadMetadata(payload ?? {})?.deliverDespiteSourceReplySuppression).toBe(true);
  });

  it.each([{ fallbackFailureKnown: false }])(
    "requires an active failed fallback: %j",
    (fallback) => {
      expect(buildSilentFallbackFailurePayload({ ...base, ...fallback })).toBeUndefined();
    },
  );
});
