import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { claimAgentRunContext, releaseAgentRunContext } from "../infra/agent-run-registry.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import { withFixtureLeases } from "./agent-bundle-mcp-fixture.test-support.js";
import {
  createSessionMcpRuntimeManager,
  makeRuntime,
} from "./agent-bundle-mcp-manager.test-support.js";
import { materializeBundleMcpToolsForRun } from "./agent-bundle-mcp-materialize.js";
import type { CreateSessionMcpRuntime } from "./agent-bundle-mcp-runtime-shared.js";
import type {
  McpToolCatalog,
  SessionMcpRuntime,
  SessionMcpRuntimeLease,
} from "./agent-bundle-mcp-types.js";
import { createMcpProofPluginRegistry } from "./mcp-connection-resolver.test-fixtures.js";

const params = {
  sessionId: "static-session",
  sessionKey: "agent:test:static-session",
  agentId: "test",
  workspaceDir: "/workspace",
  agentDir: "/agents/test",
  cfg: { mcp: { servers: { fixture: { command: "true" } } } },
  manifestRegistry: { plugins: [] },
};
const managers: ReturnType<typeof createSessionMcpRuntimeManager>[] = [];
const held: SessionMcpRuntimeLease[] = [];

function setup() {
  const sources = new Map<
    SessionMcpRuntime,
    {
      catalog: McpToolCatalog;
      pending?: Promise<McpToolCatalog>;
    }
  >();
  const factory = vi.fn<CreateSessionMcpRuntime>(async (input) => {
    const serverName = input.requesterScope ? "scoped" : "fixture";
    const runtime = withFixtureLeases(
      makeRuntime([{ toolName: "echo", description: "Echo a value" }], serverName),
    );
    const source: { catalog: McpToolCatalog; pending?: Promise<McpToolCatalog> } = {
      catalog: await runtime.getCatalog(),
    };
    sources.set(runtime, source);
    return Object.assign(runtime, {
      sessionId: input.sessionId,
      sessionKey: input.sessionKey,
      workspaceDir: input.workspaceDir,
      agentDir: input.agentDir,
      configFingerprint: input.configFingerprint ?? "fixture",
      requesterScope: input.requesterScope,
      getCatalog: () => source.pending ?? Promise.resolve(source.catalog),
      peekCatalog: () => null,
      callTool: vi.fn(async () => ({ content: [{ type: "text" as const, text: "live echo" }] })),
      dispose: vi.fn(async () => {}),
    });
  });
  const manager = createSessionMcpRuntimeManager({ createRuntime: factory });
  managers.push(manager);
  const fill = async (count = 256) => {
    for (let index = 0; index < count; index++) {
      held.push(
        await manager.acquire({ ...params, sessionId: `busy-${index}`, sessionKey: undefined }),
      );
    }
  };
  const materialize = async (input: Parameters<typeof manager.acquire>[0] = params) =>
    materializeBundleMcpToolsForRun(await manager.acquire(input));
  const evict = async () => {
    await (await materialize()).dispose();
    await fill();
  };
  const advertise = async (lease: Parameters<typeof manager.rememberAdvertisedScopedCatalog>[0]) =>
    manager.rememberAdvertisedScopedCatalog(lease, await lease.runtime.getCatalog());
  const publish = async (input: Parameters<typeof manager.acquire>[0] = mixedParams) => {
    const lease = (await manager.acquireRequesterScoped(input))!;
    await advertise(lease);
    lease.releaseLease();
  };
  return { manager, factory, sources, fill, materialize, evict, advertise, publish };
}

const test = it.extend<{ mcp: ReturnType<typeof setup>; requesterMcp: ReturnType<typeof setup> }>({
  mcp: async ({ task: _task }, use) => {
    await use(setup());
  },
  requesterMcp: async ({ task: _task }, use) => {
    await withRequester(() => use(setup()));
  },
});

type Materialized = Awaited<ReturnType<typeof materializeBundleMcpToolsForRun>>;
const surface = ({ tools }: Materialized) =>
  tools.map(({ name, description, parameters }) => ({ name, description, parameters }));
const names = ({ tools }: Materialized) => tools.map((tool) => tool.name);
const liveContent = [{ type: "text", text: "live echo" }];
const refusedContent = [
  {
    type: "text",
    text: expect.stringContaining("This turn will continue without MCP tools"),
  },
];

async function expectNoTools(tools: Materialized) {
  expect(tools.tools).toEqual([]);
  await tools.dispose();
}

async function withRequester(run: () => Promise<void>) {
  const registry = createMcpProofPluginRegistry();
  return withPluginRuntimeRegistryScope(registry.registry, async () => {
    registry.apiFor("test-plugin").registerMcpServerConnectionResolver({
      serverName: "scoped",
      resolve: async () => ({ url: "https://mcp.example.test/scoped" }),
    });
    await run();
  });
}

const mixedParams = {
  ...params,
  requesterSenderId: "alice",
  cfg: {
    mcp: {
      servers: { fixture: { command: "true" }, scoped: { transport: "streamable-http" as const } },
    },
  },
};

beforeEach(() => vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] }));

afterEach(async () => {
  for (const lease of held.splice(0)) {
    lease.releaseLease();
  }
  await Promise.all(managers.splice(0).map((manager) => manager.disposeAll()));
  vi.useRealTimers();
});

describe("MCP capacity catalog continuity", () => {
  test.each(["full", "requester"])(
    "evicts the idle requester LRU during an active shared-session turn through %s acquisition",
    async (scope, { requesterMcp: { manager } }) => {
      const input = (index: number) => ({
        ...mixedParams,
        requesterSenderId: `sender-${index}`,
        cfg: { mcp: { servers: { scoped: { transport: "streamable-http" as const } } } },
      });
      const runtimes: SessionMcpRuntime[] = [];
      for (let index = 0; index < 256; index++) {
        vi.setSystemTime(index);
        const lease = (await manager.acquireRequesterScoped(input(index)))!;
        runtimes.push(lease.runtime);
        lease.releaseLease();
      }
      vi.setSystemTime(256);
      const refreshed = (await manager.acquireRequesterScoped(input(0)))!;
      refreshed.releaseLease();
      const claim = claimAgentRunContext(
        "mcp-shared-session-turn",
        { sessionId: params.sessionId, sessionKey: params.sessionKey },
        { trackOwner: true, ownsContext: true },
      );
      try {
        const lease =
          scope === "full"
            ? await manager.acquire(input(256))
            : (await manager.acquireRequesterScoped(input(256)))!;
        const tools = await materializeBundleMcpToolsForRun(lease);
        try {
          expect(names(tools)).toEqual(["scoped__echo"]);
          expect((await tools.tools[0]!.execute("new-sender", {})).content).toEqual(liveContent);
          expect(runtimes[1]!.dispose).toHaveBeenCalledOnce();
          for (const runtime of runtimes.filter((_, index) => index !== 1)) {
            expect(runtime.dispose).not.toHaveBeenCalled();
          }
        } finally {
          await tools.dispose();
        }
      } finally {
        releaseAgentRunContext("mcp-shared-session-turn", claim);
      }
    },
  );

  test("keeps advertised static schemas after eviction even when the current peek is invalidated", async ({
    mcp: { manager, fill, factory, materialize },
  }) => {
    const firstLease = await manager.acquire(params);
    const first = await materializeBundleMcpToolsForRun(firstLease);
    const advertised = surface(first);
    await first.dispose();
    await fill();
    expect(manager.peekSession({ sessionId: params.sessionId })).toBeUndefined();
    const refused = await materialize();
    expect(surface(refused)).toEqual(advertised);
    const result = await refused.tools[0]!.execute("capacity-call", {});
    expect(result.content).toEqual(refusedContent);
    expect(firstLease.runtime.callTool).not.toHaveBeenCalled();
    expect(factory).toHaveBeenCalledTimes(257);
    await refused.dispose();
    held[0]!.releaseLease();
    const recovered = await materialize();
    expect((await recovered.tools[0]!.execute("recovered-call", {})).content).toEqual(liveContent);
    await recovered.dispose();
  });

  test("preserves embedded requester schemas after eviction without contacting MCP", async ({
    requesterMcp: { manager, fill, factory, sources, materialize },
  }) => {
    const firstLease = await manager.acquire(mixedParams);
    const first = await materializeBundleMcpToolsForRun(firstLease);
    const advertised = surface(first);
    expect(names(first)).toEqual(["fixture__echo", "scoped__echo"]);
    await first.dispose();
    await fill();
    const creations = factory.mock.calls.length;
    const refused = await materialize(mixedParams);
    expect(surface(refused)).toEqual(advertised);
    const result = await refused.tools
      .find((tool) => tool.name === "scoped__echo")!
      .execute("refused", {});
    expect(result.content).toEqual(refusedContent);
    expect(factory).toHaveBeenCalledTimes(creations);
    for (const runtime of sources.keys()) {
      expect(runtime.callTool).not.toHaveBeenCalled();
    }
    await refused.dispose();
    // Another sender must never inherit Alice's embedded catalog.
    const bob = await materialize({ ...mixedParams, requesterSenderId: "bob" });
    expect(names(bob)).toEqual(["fixture__echo"]);
    await bob.dispose();
  });

  test("bounds requester snapshots and keeps recent schemas reachable for retirement", async ({
    requesterMcp: { manager, advertise, publish },
  }) => {
    const input = (index: number) => ({
      ...mixedParams,
      sessionId: `scoped-${index}`,
      sessionKey: `agent:test:scoped-${index}`,
    });
    for (let index = 0; index < 512; index++) {
      await publish(input(index));
    }
    for (let index = 256; index < 512; index++) {
      held.push((await manager.acquireRequesterScoped(input(index)))!);
    }
    const continuing = (await manager.acquireRequesterScoped(input(0)))!;
    await continuing.runtime.getCatalog();
    continuing.releaseLease();
    held.shift()!.releaseLease();
    const next = (await manager.acquireRequesterScoped(input(512)))!;
    await advertise(next);
    held.push(next);
    expect(manager.getAdvertisedScopedCatalog("scoped-1")).toBeNull();
    expect(manager.resolveSessionId(input(1).sessionKey)).toBeUndefined();
    expect(manager.getAdvertisedScopedCatalog("scoped-0")?.tools).toHaveLength(1);
    expect(manager.listSessionIdsForAgent("test")).toHaveLength(512);
    const retirement = manager.captureSessionRetirement({ sessionKey: input(0).sessionKey });
    expect(retirement).toBeDefined();
    await retirement!.retire(() => {});
    expect(manager.getAdvertisedScopedCatalog("scoped-0")).toBeNull();
    expect(manager.resolveSessionId(input(0).sessionKey)).toBeUndefined();
  });

  test("bounds evicted requester partitions within a session with live owners", async ({
    requesterMcp: { manager, factory, publish },
  }) => {
    const input = (index: number) => ({ ...mixedParams, requesterSenderId: `sender-${index}` });
    for (let index = 0; index < 513; index++) {
      await publish(input(index));
    }
    for (let index = 257; index < 513; index++) {
      held.push((await manager.acquireRequesterScoped(input(index)))!);
    }
    const aged = (await manager.acquireRequesterScoped(input(0)))!;
    expect((await aged.runtime.getCatalog()).tools).toEqual([]);
    aged.releaseLease();
    const recent = (await manager.acquireRequesterScoped(input(1)))!;
    expect((await recent.runtime.getCatalog()).tools.map((tool) => tool.toolName)).toEqual([
      "echo",
    ]);
    recent.releaseLease();
    expect(manager.getAdvertisedScopedCatalog(params.sessionId)?.tools).toHaveLength(1);
    expect(factory).toHaveBeenCalledTimes(513);
  });

  test("rejects the old publication handle when a live runtime changes agent binding", async ({
    requesterMcp: { manager, advertise },
  }) => {
    const first = (await manager.acquireRequesterScoped(mixedParams))!;
    const catalog = await first.runtime.getCatalog();
    const rebound = (await manager.acquireRequesterScoped({ ...mixedParams, agentId: "other" }))!;
    expect(rebound.runtime).toBe(first.runtime);
    manager.rememberAdvertisedScopedCatalog(first, catalog);
    expect(manager.getAdvertisedScopedCatalog(params.sessionId)).toBeNull();
    await advertise(rebound);
    expect(manager.getAdvertisedScopedCatalog(params.sessionId)?.tools).toHaveLength(1);
    first.releaseLease();
    rebound.releaseLease();
  });

  test("rejects a discovery result completed after its catalog was cleared by reload", async ({
    requesterMcp: { manager, sources, advertise },
  }) => {
    const first = (await manager.acquireRequesterScoped(mixedParams))!;
    const source = sources.get(first.runtime)!;
    const pending = createDeferred<McpToolCatalog>();
    source.pending = pending.promise;
    const late = first.runtime.getCatalog();
    await manager.reloadConfig({ cfg: mixedParams.cfg, manifestRegistry: params.manifestRegistry });
    const current = (await manager.acquireRequesterScoped(mixedParams))!;
    pending.resolve(source.catalog);
    manager.rememberAdvertisedScopedCatalog(first, await late);
    expect(manager.getAdvertisedScopedCatalog(params.sessionId)).toBeNull();
    await advertise(current);
    expect(manager.getAdvertisedScopedCatalog(params.sessionId)?.tools).toHaveLength(1);
    first.releaseLease();
    current.releaseLease();
  });

  test.each(["session", "deferred", "deferred-required", "captured", "agent", "reload"])(
    "retires evicted static and requester catalogs through %s cleanup",
    async (retirement, { requesterMcp: { manager, fill, materialize } }) => {
      const initial = await materialize(mixedParams);
      expect(names(initial)).toEqual(["fixture__echo", "scoped__echo"]);
      await initial.dispose();
      await fill();
      expect(manager.resolveSessionId(params.sessionKey)).toBe(params.sessionId);
      expect(manager.listSessionIdsForAgent("test")).toContain(params.sessionId);
      if (retirement === "session") {
        await manager.disposeSession(params.sessionId);
      } else if (retirement.startsWith("deferred")) {
        expect(
          manager.deferRetirement(params.sessionId, {
            retainAcrossReuse: retirement === "deferred-required",
          }),
        ).toBe(true);
        expect(await manager.completeDeferredRetirement(params.sessionId)).toBe(true);
      } else if (retirement === "captured") {
        const captured = manager.captureSessionRetirement({ sessionKey: params.sessionKey });
        expect(captured).toBeDefined();
        await captured!.retire(() => {});
      } else if (retirement === "agent") {
        await manager.retireSessionForAgentDeletion(params.sessionId, "other", () => {});
        expect(manager.getAdvertisedScopedCatalog(params.sessionId)).not.toBeNull();
        const retained = await materialize(mixedParams);
        expect(names(retained)).toEqual(["fixture__echo", "scoped__echo"]);
        await retained.dispose();
        await manager.retireSessionForAgentDeletion(params.sessionId, "test", () => {});
      } else {
        await manager.reloadConfig({
          cfg: mixedParams.cfg,
          manifestRegistry: params.manifestRegistry,
        });
      }
      expect(manager.getAdvertisedScopedCatalog(params.sessionId)).toBeNull();
      expect(manager.resolveSessionId(params.sessionKey)).toBeUndefined();
      const refused = (await manager.acquireRequesterScoped(mixedParams))!;
      expect((await refused.runtime.getCatalog()).tools).toEqual([]);
      refused.releaseLease();
      await expectNoTools(await materialize(mixedParams));
    },
  );

  test.each([
    { workspaceDir: "/other-workspace" },
    { agentDir: "/agents/other" },
    { agentId: "other" },
    { sessionKey: "agent:test:other" },
    {
      cfg: {
        mcp: {
          servers: {
            scoped: { transport: "streamable-http" as const, headers: { variant: "changed" } },
          },
        },
      },
    },
  ])(
    "invalidates requester snapshots and advertised schemas on binding change: %j",
    async (change, { requesterMcp: { manager, fill, publish } }) => {
      await publish();
      await fill();
      const refused = (await manager.acquireRequesterScoped({ ...mixedParams, ...change }))!;
      expect((await refused.runtime.getCatalog()).tools).toEqual([]);
      expect(manager.getAdvertisedScopedCatalog(params.sessionId)).toBeNull();
      refused.releaseLease();
    },
  );

  test("preserves acquired static tools when requester admission is refused", async ({
    requesterMcp: { manager, fill },
  }) => {
    await fill(255);
    const acquired = await manager.acquire(mixedParams);
    const tools = await materializeBundleMcpToolsForRun(acquired);
    expect(names(tools)).toEqual(["fixture__echo"]);
    expect((await tools.tools[0]!.execute("static-call", {})).content).toEqual(liveContent);
    expect(manager.peekSession({ sessionId: params.sessionId })!.activeLeases).toBe(1);
    expect(tools.diagnostics?.[0]?.message).toContain("This turn will continue without MCP tools");
    await tools.dispose();
    expect(manager.peekSession({ sessionId: params.sessionId })!.activeLeases).toBe(0);
  });

  test("preserves a reusable requester partition when static admission is refused", async ({
    requesterMcp: { manager, fill, materialize, advertise },
  }) => {
    const requester = await manager.acquireRequesterScoped(mixedParams);
    held.push(requester!);
    await advertise(requester!);
    await (await materialize({ ...params, requesterSenderId: "alice" })).dispose();
    expect(
      manager.getAdvertisedScopedCatalog(params.sessionId)?.tools.map((tool) => tool.toolName),
    ).toEqual(["echo"]);
    await fill(255);
    const tools = await materialize(mixedParams);
    expect(names(tools)).toEqual(["scoped__echo"]);
    expect((await tools.tools[0]!.execute("requester-call", {})).content).toEqual(liveContent);
    await tools.dispose();
  });

  test.each([
    { sessionId: "other-session", sessionKey: "agent:test:other-session" },
    { workspaceDir: "/other-workspace" },
    { agentDir: "/agents/other" },
    { agentId: "other" },
    { cfg: { mcp: { servers: { fixture: { command: "changed" } } } } },
  ])(
    "invalidates a static snapshot when its binding changes: %j",
    async (change, { mcp: { materialize, evict } }) => {
      await evict();
      await expectNoTools(await materialize({ ...params, ...change }));
    },
  );

  test.each(["reload", "replacement"])(
    "does not republish an old catalog after %s while discovery is pending",
    async (invalidation, { mcp: { manager, sources, fill, materialize } }) => {
      const acquired = await manager.acquire(params);
      const source = sources.get(acquired.runtime)!;
      const pending = createDeferred<McpToolCatalog>();
      source.pending = pending.promise;
      const late = acquired.runtime.getCatalog();
      const nextParams =
        invalidation === "replacement"
          ? { ...params, cfg: { mcp: { servers: { fixture: { command: "replacement" } } } } }
          : params;
      if (invalidation === "reload") {
        await manager.reloadConfig({ cfg: params.cfg, manifestRegistry: params.manifestRegistry });
      } else {
        const replacement = await manager.acquire(nextParams);
        replacement.releaseLease();
      }
      pending.resolve(source.catalog);
      await late;
      acquired.releaseLease();
      await fill();
      await expectNoTools(await materialize(nextParams));
    },
  );

  test("bounds evicted static catalogs and retains the most recently used session", async ({
    mcp: { manager },
  }) => {
    const input = (index: number) => ({
      ...params,
      sessionId: `one-off-${index}`,
      sessionKey: `agent:test:one-off-${index}`,
    });
    for (let index = 0; index < 512; index++) {
      const lease = await manager.acquire(input(index));
      await lease.runtime.getCatalog();
      lease.releaseLease();
    }
    expect(manager.listSessionIdsForAgent("test")).toHaveLength(512);
    // Refused reuse still refreshes retention recency, without creating a runtime.
    for (let index = 256; index < 512; index++) {
      held.push(await manager.acquire(input(index)));
    }
    const continuing = await manager.acquire(input(0));
    expect((await continuing.runtime.getCatalog()).tools).toHaveLength(1);
    continuing.releaseLease();
    held.shift()!.releaseLease();
    const next = await manager.acquire(input(512));
    await next.runtime.getCatalog();
    held.push(next);
    expect(manager.listSessionIdsForAgent("test")).toHaveLength(512);
    expect(manager.resolveSessionId(input(1).sessionKey)).toBeUndefined();
    expect(manager.resolveSessionId(input(0).sessionKey)).toBe("one-off-0");
    const retained = await manager.acquire(input(0));
    expect((await retained.runtime.getCatalog()).tools).toHaveLength(1);
    retained.releaseLease();
    await manager.disposeSession("one-off-0");
    expect(manager.resolveSessionId(input(0).sessionKey)).toBeUndefined();
  });

  it.each(["static", "requester"])(
    "refuses replacement after failed %s eviction cleanup without blocking another key",
    async (scope) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      vi.setSystemTime(1_000);
      const { manager, factory } = setup();
      try {
        await withRequester(async () => {
          const acquire = async (sessionId: string, sender = "alice") => {
            const lease =
              scope === "static"
                ? await manager.acquire({ ...params, sessionId })
                : (await manager.acquireRequesterScoped({
                    ...mixedParams,
                    sessionId,
                    requesterSenderId: sender,
                  }))!;
            held.push(lease);
            return lease;
          };
          const original = await acquire("uncertain");
          original.runtime.joinCleanup = async () => {
            throw new Error("child cleanup uncertain");
          };
          original.releaseLease();
          const healthy = await acquire("healthy");
          healthy.releaseLease();
          for (let index = 0; index < 254; index++) {
            await acquire(`busy-${index}`);
          }
          const admitted = await acquire("admitted");
          admitted.releaseLease();
          expect(original.runtime.dispose).toHaveBeenCalledOnce();
          expect(factory).toHaveBeenCalledTimes(257);
          expect(manager.listSessionIdsForAgent("test")).toContain("uncertain");

          const refused = await acquire("uncertain");
          expect(factory).toHaveBeenCalledTimes(257);
          expect((await refused.runtime.getCatalog()).diagnostics?.[0]?.message).toContain(
            "previous runtime has not confirmed shutdown",
          );
          expect(admitted.runtime.dispose).not.toHaveBeenCalled();

          // A failed requester partition does not poison another sender in the session.
          const unrelated = await acquire(scope === "requester" ? "uncertain" : "unrelated", "bob");
          expect(factory).toHaveBeenCalledTimes(258);
          expect((await unrelated.runtime.getCatalog()).diagnostics).toBeUndefined();
          await expect(
            manager.retireSessionForAgentDeletion("uncertain", "test", () => {}),
          ).rejects.toThrow("child cleanup uncertain");
        });
      } finally {
        vi.useRealTimers();
      }
    },
  );
});
