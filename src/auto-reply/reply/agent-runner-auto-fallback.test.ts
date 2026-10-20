import { beforeEach, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../config/sessions.js";
import type { FollowupRun } from "./queue.js";

const state = vi.hoisted(() => ({
  updateSessionEntryMock: vi.fn(),
}));

vi.mock("../../config/sessions/session-accessor.js", () => ({
  updateSessionEntry: (...args: unknown[]) => state.updateSessionEntryMock(...args),
}));

import { clearRecoveredAutoFallbackPrimaryProbeSelection } from "./agent-runner-auto-fallback.js";

const probe = {
  provider: "anthropic",
  model: "claude-sonnet-4-6",
  fallbackProvider: "openai",
  fallbackModel: "gpt-5.4",
};

function createAutoEntry(overrides: Partial<SessionEntry> = {}): SessionEntry {
  return {
    sessionId: "session",
    updatedAt: 1,
    providerOverride: probe.fallbackProvider,
    modelOverride: probe.fallbackModel,
    modelOverrideSource: "auto",
    modelOverrideFallbackOriginProvider: probe.provider,
    modelOverrideFallbackOriginModel: probe.model,
    ...overrides,
  };
}

async function clearProbe(entry: SessionEntry) {
  const activeSessionStore = { main: entry };
  await clearRecoveredAutoFallbackPrimaryProbeSelection({
    run: {
      provider: probe.provider,
      model: probe.model,
      autoFallbackPrimaryProbe: probe,
    } as FollowupRun["run"],
    provider: probe.provider,
    model: probe.model,
    sessionKey: "main",
    activeSessionStore,
    getActiveSessionEntry: () => entry,
    storePath: "/tmp/sessions.sqlite",
  });
  return activeSessionStore.main;
}

beforeEach(() => {
  state.updateSessionEntryMock.mockReset();
});

it("refreshes the local selection when the persisted comparison rejects the probe", async () => {
  const staleAutoEntry = createAutoEntry();
  const newerUserEntry: SessionEntry = {
    sessionId: "newer-session",
    updatedAt: 2,
    providerOverride: "openai",
    modelOverride: "gpt-5.5",
    modelOverrideSource: "user",
  };
  const expected = { ...newerUserEntry };
  state.updateSessionEntryMock.mockImplementationOnce(
    async (_scope: unknown, update: (entry: SessionEntry) => unknown) => {
      expect(await update(newerUserEntry)).toBeNull();
      return null;
    },
  );

  expect(await clearProbe(staleAutoEntry)).toBe(newerUserEntry);
  expect(newerUserEntry).toEqual(expected);
});

it.each(["auto", "user"] as const)(
  "clears recovered model selection while respecting an %s auth pin",
  async (authSource) => {
    const entry = createAutoEntry({
      authProfileOverride: "openai:fallback",
      authProfileOverrideSource: authSource,
    });
    state.updateSessionEntryMock.mockImplementationOnce(
      async (_scope: unknown, update: (entry: SessionEntry) => Partial<SessionEntry>) => {
        const persisted = { ...entry };
        return { ...persisted, ...update(persisted) };
      },
    );

    expect(await clearProbe(entry)).toMatchObject({
      modelOverride: undefined,
      providerOverride: undefined,
      authProfileOverride: authSource === "user" ? "openai:fallback" : undefined,
      authProfileOverrideSource: authSource === "user" ? "user" : undefined,
    });
  },
);
