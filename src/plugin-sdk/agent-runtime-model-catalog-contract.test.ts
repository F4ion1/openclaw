import { beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";

const mocks = vi.hoisted(() => ({
  getSnapshot: vi.fn(),
  loadCatalog: vi.fn(),
}));
const entries = [{ provider: "test", id: "selected", name: "Selected" }];

vi.mock("../agents/prepared-model-catalog.js", () => ({
  loadProviderScopedThinkingCatalog: vi.fn(async () => []),
  refreshExpiredPreparedModelCatalog: (...args: unknown[]) => mocks.getSnapshot(...args),
  readPreparedModelCatalog: (...args: unknown[]) => mocks.loadCatalog(...args),
}));

import {
  getPreparedModelCatalogSnapshot,
  loadModelCatalog,
  loadPreparedModelCatalog,
  resolveThinkingDefaultWithRuntimeCatalog,
} from "openclaw/plugin-sdk/agent-runtime";

describe("agent-runtime model catalog compatibility", () => {
  beforeEach(() => {
    mocks.getSnapshot.mockReset();
    mocks.loadCatalog.mockReset();
  });

  it("uses the shipped thinking catalog callback", async () => {
    const readCatalog = vi.fn(async () => []);

    await expect(
      resolveThinkingDefaultWithRuntimeCatalog({
        cfg: { agents: { defaults: { thinkingDefault: "low" } } },
        provider: "example",
        model: "example-model",
        loadModelCatalog: readCatalog,
      }),
    ).resolves.toBe("low");
    expect(readCatalog).toHaveBeenCalledOnce();
  });

  it("preserves explicit readOnly:true in the SDK loader", async () => {
    const readOnly = true;
    const config = {};
    mocks.loadCatalog.mockResolvedValue(entries);

    await expect(loadPreparedModelCatalog({ config, readOnly })).resolves.toBe(entries);
    expect(mocks.loadCatalog).toHaveBeenCalledExactlyOnceWith({ config, readOnly });
  });

  it.each([
    [
      "legacy cache-only",
      () => loadModelCatalog({ cacheOnly: true, useCache: true, refreshFullCatalog: true }),
    ],
    ["snapshot", () => getPreparedModelCatalogSnapshot()?.entries ?? []],
  ] as const)("keeps %s reads nonblocking", async (_name, read) => {
    mocks.getSnapshot.mockReturnValue({
      entries,
      routeVariants: [],
    });

    expect(await read()).toEqual(entries);
    expect(mocks.loadCatalog).not.toHaveBeenCalled();
  });

  it("preserves explicit refresh intent through the legacy loader", async () => {
    mocks.loadCatalog.mockResolvedValue(entries);

    await expect(loadModelCatalog({ refreshFullCatalog: true })).resolves.toBe(entries);
    expect(mocks.loadCatalog).toHaveBeenCalledExactlyOnceWith({
      readOnly: false,
      refreshFullCatalog: true,
    });
    expect(mocks.getSnapshot).not.toHaveBeenCalled();
  });

  it("accepts legacy options without overriding lifecycle metadata", async () => {
    type LegacyMetadataSnapshot = Omit<
      PluginMetadataSnapshot,
      "owners" | "declaredProviderOwners"
    > & {
      owners: Omit<
        PluginMetadataSnapshot["owners"],
        "modelIdNormalizationPolicies" | "providerAuthContributions"
      >;
    };
    type AcceptedMetadataSnapshot = NonNullable<
      NonNullable<Parameters<typeof loadModelCatalog>[0]>["metadataSnapshot"]
    >;
    expectTypeOf<LegacyMetadataSnapshot>().toMatchTypeOf<AcceptedMetadataSnapshot>();
    expectTypeOf<PluginMetadataSnapshot>().toMatchTypeOf<AcceptedMetadataSnapshot>();
    mocks.loadCatalog.mockResolvedValue([]);
    const options = {
      agentDir: "/tmp/plugin-agent",
      config: {},
      env: { OPENCLAW_STATE_DIR: "/tmp/plugin-state" },
      readOnly: true,
      workspaceDir: "/tmp/plugin-workspace",
    };
    await loadModelCatalog({ ...options, metadataSnapshot: {} as never, useCache: false });
    expect(mocks.loadCatalog).toHaveBeenCalledWith(options);
  });
});
