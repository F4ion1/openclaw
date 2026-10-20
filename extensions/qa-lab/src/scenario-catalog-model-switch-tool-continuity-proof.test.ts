import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { describe, expect, it, vi } from "vitest";
import { createQaBusState } from "./bus-state.js";
import { hasModelSwitchContinuitySignal } from "./model-switch-eval.js";
import { runLoadedScenarioFlow } from "./scenario-flow-runner.test-support.js";

const continuity = "the model handoff preserved the QA mission after rereading the scenario pack";
const richContinuity = continuity.replace("model handoff", "**model handoff**");
const readError = "alternate-model run did not return exact owned successful read evidence";

function splitModelRef(raw: string) {
  const [provider, ...model] = raw.split("/");
  return provider && model.length
    ? { provider: provider.toLowerCase(), model: model.join("/") }
    : null;
}

function normalizeModelRef(raw: string) {
  const split = splitModelRef(raw);
  if (!split) {
    return null;
  }
  return split.provider === "openai" && split.model.toLowerCase() === "alternate-alias"
    ? { provider: "openai", model: "alternate-model" }
    : split;
}

async function runToolContinuity(
  params: {
    alternateReplyText?: string;
    alternateOutboundText?: string;
    alternateResponseModel?: string;
    alternateRerouted?: boolean;
    alternateEffective?: { provider?: string; model?: string };
    unrelatedLaterOutboundText?: string;
  } = {},
) {
  const state = createQaBusState();
  let call = 0;
  const runAgentPrompt = vi.fn(
    async (_env: unknown, prompt: { provider?: string; model?: string }) => {
      call += 1;
      const runId = `run-${call}`;
      const provider = prompt.provider ?? "openai";
      const model = prompt.model ?? "primary-model";
      const effective = {
        provider: (call === 2 ? params?.alternateEffective?.provider : undefined) ?? provider,
        model: (call === 2 ? params?.alternateEffective?.model : undefined) ?? model,
      };
      const responseModel =
        call === 2 ? (params?.alternateResponseModel ?? effective.model) : effective.model;
      const replyText =
        call === 1
          ? "the QA scenario pack verifies source and docs"
          : (params.alternateReplyText ?? continuity);
      state.addOutboundMessage({
        accountId: "qa-channel",
        to: "dm:qa-operator",
        text: call === 1 ? replyText : (params?.alternateOutboundText ?? replyText),
      });
      if (call === 2 && params?.unrelatedLaterOutboundText) {
        state.addOutboundMessage({
          accountId: "qa-channel",
          to: "dm:qa-operator",
          text: params.unrelatedLaterOutboundText,
        });
      }
      return {
        started: { runId },
        waited: {
          status: "ok",
          terminalDelivery: { status: "sent", resultCount: 1 },
          terminalReply: { disposition: "visible", text: replyText },
          terminalReceipt: {
            runId,
            sessionId: "session-tools",
            turnId: `turn-${call}`,
            requested: { provider, model },
            effective: { ...effective, responseModel },
            successfulToolNames: ["read"],
            rerouted:
              (call === 2 ? params?.alternateRerouted : undefined) ??
              (effective.provider !== provider || responseModel !== model),
            terminalDisposition: "visible",
          },
        },
      };
    },
  );
  const result = await runLoadedScenarioFlow("model-switch-tool-continuity", {
    state,
    api: {
      env: {
        providerMode: "mock-openai",
        primaryModel: "openai/primary-model",
        alternateModel: "OPENAI/alternate-alias",
        gateway: {},
      },
      splitModelRef,
      normalizeModelRef,
      normalizeLowercaseStringOrEmpty,
      resolveQaLiveTurnTimeoutMs: (_env: unknown, timeoutMs: number) => timeoutMs,
      hasModelSwitchContinuitySignal,
      runAgentPrompt,
    },
  });
  return { result, runAgentPrompt };
}

describe("model-switch tool continuity terminal evidence", () => {
  it("invokes the canonical alias target and accepts run-owned delivery", async () => {
    const { result, runAgentPrompt } = await runToolContinuity({
      alternateReplyText: richContinuity,
      alternateOutboundText: continuity,
      alternateResponseModel: "alternate-model-concrete",
      alternateRerouted: false,
    });

    expect(result.status).toBe("pass");
    expect(runAgentPrompt.mock.calls[1]?.[1]).toMatchObject({
      provider: "openai",
      model: "alternate-model",
    });
    expect(result.modelSwitchEvidence).toMatchObject({
      primary: { runId: "run-1", successfulToolNames: ["read"] },
      primaryDelivery: { status: "sent", resultCount: 1 },
      alternate: { runId: "run-2", successfulToolNames: ["read"] },
      terminalReply: { disposition: "visible", text: richContinuity },
      terminalDelivery: { status: "sent", resultCount: 1 },
    });
    expect(result.steps[0]?.details).toBe(richContinuity);
  });

  it.each([
    { changed: "model", alternateEffective: { model: "fallback-model" } },
    { changed: "provider", alternateEffective: { provider: "fallback-provider" } },
  ])(
    "requires a changed alternate effective $changed to be marked rerouted",
    async ({ alternateEffective }) => {
      const { result } = await runToolContinuity({
        alternateEffective,
        alternateRerouted: true,
      });
      expect(result.status).toBe("pass");

      await expect(
        runToolContinuity({ alternateEffective, alternateRerouted: false }),
      ).rejects.toThrow(readError);
    },
  );

  it("rejects an unchanged alternate route reported as rerouted", async () => {
    await expect(runToolContinuity({ alternateRerouted: true })).rejects.toThrow(readError);
  });

  it("rejects unrelated later continuity text when the alternate reply lacks it", async () => {
    await expect(
      runToolContinuity({
        alternateReplyText: "the alternate tool run completed",
        unrelatedLaterOutboundText: continuity,
      }),
    ).rejects.toThrow("alternate-model terminal reply missed kickoff continuity");
  });
});
