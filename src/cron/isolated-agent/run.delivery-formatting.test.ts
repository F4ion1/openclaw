import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resetPluginRuntimeStateForTest } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { makeIsolatedAgentJobFixture, makeIsolatedAgentParamsFixture } from "./job-fixtures.js";
import { setupRunCronIsolatedAgentTurnSuite } from "./run.suite-helpers.js";
import {
  loadRunCronIsolatedAgentTurn,
  mockRunCronFallbackPassthrough,
  resolveCronDeliveryPlanMock,
  resolveDeliveryTargetMock,
  runEmbeddedAgentMock,
} from "./run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();

const cfg: OpenClawConfig = {
  channels: {
    telegram: { accounts: { rich: { richMessages: true }, plain: { richMessages: false } } },
  },
};

// The Telegram plugin is not active: the first announcement after startup bootstraps it
// into a caller-owned registry, like a cold Gateway.
const { bootstrapOutboundChannelPluginMock } = vi.hoisted(() => ({
  bootstrapOutboundChannelPluginMock: vi.fn(),
}));
vi.mock("../../infra/outbound/channel-bootstrap.runtime.js", () => ({
  bootstrapOutboundChannelPlugin: bootstrapOutboundChannelPluginMock,
  bootstrapOutboundChannelPluginAsync: bootstrapOutboundChannelPluginMock,
}));

function bootstrapTelegramWithFormattingHints() {
  bootstrapOutboundChannelPluginMock.mockReturnValue(
    createTestRegistry([
      {
        pluginId: "telegram",
        source: "test",
        plugin: {
          ...createChannelTestPluginBase({
            id: "telegram",
            label: "Telegram",
            config: {
              listAccountIds: (config: OpenClawConfig) =>
                Object.keys(config.channels?.telegram?.accounts ?? {}),
            },
          }),
          outbound: { deliveryMode: "direct", sendText: async () => ({ messageId: "1" }) },
          agentPrompt: {
            inboundFormattingHints: (params: { cfg: OpenClawConfig; accountId?: string | null }) =>
              params.cfg.channels?.telegram?.accounts?.[params.accountId ?? ""]?.richMessages
                ? { text_markup: "markdown_telegram_rich", rules: ["Telegram rich ON."] }
                : { text_markup: "markdown", rules: ["Telegram rich OFF."] },
          },
        },
      },
    ]),
  );
}

describe("runCronIsolatedAgentTurn delivery formatting hints", () => {
  setupRunCronIsolatedAgentTurnSuite();
  beforeEach(() => {
    resetPluginRuntimeStateForTest();
    bootstrapTelegramWithFormattingHints();
  });

  afterEach(resetPluginRuntimeStateForTest);

  it("gives an announce run the rich account's formatting contract", async () => {
    mockRunCronFallbackPassthrough();
    const delivery = { mode: "announce", channel: "telegram", to: "-100123", accountId: "rich" };
    resolveCronDeliveryPlanMock.mockReturnValue({ requested: true, ...delivery });
    resolveDeliveryTargetMock.mockResolvedValue({
      ...delivery,
      ok: true,
      threadId: 7,
      mode: "explicit",
    });
    await runCronIsolatedAgentTurn(
      makeIsolatedAgentParamsFixture({
        cfg,
        job: makeIsolatedAgentJobFixture({
          id: "daily-digest",
          name: "Daily digest",
          schedule: { kind: "every", everyMs: 60_000 },
          payload: { kind: "agentTurn", message: "post the digest" },
          delivery,
        }),
        message: "post the digest",
        sessionKey: "cron:daily-digest",
      }),
    );
    const prompt = runEmbeddedAgentMock.mock.calls[0]?.[0].extraSystemPrompt;
    expect(prompt?.split("### Delivery Format")).toHaveLength(2);
    expect(prompt).toContain('"schema": "openclaw.delivery_format.v1"');
    expect(prompt).toContain('"text_markup": "markdown_telegram_rich"');
    expect(prompt).toContain("Telegram rich ON.");
  });
});
