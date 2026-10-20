import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { warnMock, resolvePlanMock } = vi.hoisted(() => ({
  warnMock: vi.fn(),
  resolvePlanMock: vi.fn(),
}));

vi.mock("../../plugins/memory-state.js", () => ({
  resolveMemoryFlushPlan: resolvePlanMock,
}));
vi.mock("../../logging/subsystem.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../logging/subsystem.js")>();
  return {
    ...actual,
    createSubsystemLogger: () => ({
      ...actual.createSubsystemLogger("auto-reply/memory-flush"),
      warn: warnMock,
    }),
  };
});

import {
  memoryFlushResultIsSilent,
  resolveMemoryFlushPlanForRun as resolvePlan,
} from "./memory-flush-plan.js";

const providerPlan = {
  prompt: "Save durable knowledge",
  systemPrompt: "Use the Knowledge persistence tool",
  persistenceToolNames: ["knowledge_save_page"],
};
beforeEach(() => {
  resolvePlanMock.mockReturnValue({
    pluginId: "knowledge",
    selectedSlotOwner: true,
    plan: providerPlan,
  });
});
afterEach(() => {
  resolvePlanMock.mockReset();
  warnMock.mockReset();
});

it("uses the recorded memory-flush outcome rather than prepared text", () => {
  expect(
    memoryFlushResultIsSilent({
      payloads: [{ text: "NO_REPLY" }],
      meta: { terminalReply: { disposition: "visible", text: "NO_REPLY" } },
    }),
  ).toBe(false);
  expect(
    memoryFlushResultIsSilent({
      payloads: [],
      meta: { terminalReply: { disposition: "silent" } },
    }),
  ).toBe(true);
});

describe("resolveMemoryFlushPlanForRun", () => {
  it("keeps the session model for a file plan that names none", () => {
    resolvePlanMock.mockReturnValue({
      pluginId: "legacy-memory",
      selectedSlotOwner: true,
      plan: {
        prompt: "Append notes",
        systemPrompt: "Legacy flush",
        relativePath: "memory/notes.md",
        softThresholdTokens: 4_000,
        forceFlushTranscriptBytes: 1_024,
        reserveTokensFloor: 20_000,
      },
    });

    expect(
      resolvePlan({
        cfg: {
          agents: { defaults: { compaction: { memoryFlush: { model: "ollama/qwen3:8b" } } } },
        },
      })?.plan.model,
    ).toBeUndefined();
  });

  it("caps reserve and maintenance headroom for an 8000-token context window", () => {
    expect(resolvePlan({ contextWindowTokens: 8_000 })?.plan).toMatchObject({
      reserveTokensFloor: 2_000,
      softThresholdTokens: 3_000,
    });
  });

  it("returns null when memory flush is disabled", () => {
    expect(
      resolvePlan({
        cfg: {
          agents: { defaults: { compaction: { memoryFlush: { enabled: false } } } },
        },
      }),
    ).toBeNull();
    expect(resolvePlanMock).not.toHaveBeenCalled();
  });
  it("rejects overlapping lookup and persistence tools with plugin attribution", () => {
    resolvePlanMock.mockReturnValue({
      pluginId: "knowledge",
      selectedSlotOwner: true,
      plan: {
        ...providerPlan,
        systemPrompt: "Use Knowledge tools",
        lookupToolNames: ["knowledge_grep", "knowledge_save_page"],
      },
    });

    expect(resolvePlan({})).toBeNull();
    expect(warnMock).toHaveBeenCalledOnce();
    expect(warnMock).toHaveBeenCalledWith(expect.stringContaining('plugin "knowledge"'));
  });
});
