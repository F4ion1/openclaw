import fs from "node:fs/promises";
import { SERVER_INFO_META_KEY, SUBSCRIPTION_ID_META_KEY } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";
import { withinTest } from "../../test/helpers/promise.js";
import {
  activateMcpLoopbackClientGrantCapture,
  deactivateMcpLoopbackClientGrantCapture,
  revokeMcpLoopbackClientGrant,
  transferMcpLoopbackClientGrant,
} from "./mcp-grant-store.js";
import { runtime as loopbackRuntime } from "./mcp-http-request.test-support.js";
import {
  beginMcpLoopbackToolCallCapture,
  waitForMcpLoopbackToolCallCaptureIdle,
} from "./mcp-http.loopback-runtime.js";
import { createProjectionHarness } from "./native-mcp-projection.test-harness.js";
import { toolPayload, resourceSubscriptionIds } from "./native-mcp-projection.test-support.js";

const harness = createProjectionHarness();
const { fixture, connect, connectDirect, roots, metadata, samplingResult, captureKeys } = harness;

describe("native MCP projection over the Gateway loopback listener", () => {
  it("preserves a downstream legacy revision negotiated independently of the upstream", async () => {
    const server = await fixture("dual");
    const supportedProtocolVersions = ["2025-06-18"];
    const direct = await connectDirect(server.file, "legacy", undefined, supportedProtocolVersions);
    expect(direct.getNegotiatedProtocolVersion()).toBe("2025-06-18");
    const { client } = await connect({
      url: server.register().url,
      grant: await server.grant(),
      mode: "legacy",
      supportedProtocolVersions,
    });
    expect(client.getNegotiatedProtocolVersion()).toBe("2025-06-18");
    expect((await client.request({ method: "tools/list" })).tools[0]?.name).toBe("inspect.raw");
    expect(
      toolPayload(await client.callTool({ name: "inspect.raw", arguments: {} })).pid,
    ).toBeGreaterThan(0);
  });

  it("obtains legacy roots before the upstream catalog and preserves raw names, metadata, and cursors", async () => {
    const server = await fixture("legacy");
    const route = server.register();
    const { client, rootsRequests, samplingRequests } = await connect({
      url: route.url,
      grant: await server.grant(),
      mode: "auto",
      sampleDuringCatalog: true,
      forbidPreInitializationGet: true,
    });
    expect(client.getProtocolEra()).toBe("legacy");
    expect(samplingRequests()).toEqual([
      {
        messages: [{ role: "user", content: { type: "text", text: "Catalog request" } }],
        tools: [{ name: "catalog-tool", inputSchema: { type: "object" } }],
        maxTokens: 1,
      },
    ]);
    expect(
      (await server.log())
        .filter((line) => line.startsWith("listed sample "))
        .map((line) => JSON.parse(line.slice("listed sample ".length))),
    ).toContainEqual(samplingResult);
    expect(rootsRequests()).toBe(1);
    const tools = await client.request({ method: "tools/list" });
    expect(tools).toMatchObject({
      nextCursor: "page:2",
      _meta: metadata,
      tools: [{ name: "inspect.raw", _meta: metadata }],
    });
    expect(JSON.parse(tools.tools[0]!.description!)).toMatchObject({
      roots,
      capabilities: { sampling: { tools: {} } },
    });
    expect(tools.tools[0]?.outputSchema).toEqual({
      type: "object",
      properties: { count: { type: "number" } },
      required: ["count"],
    });
    expect(
      await client.request({ method: "tools/list", params: { cursor: "page:2" } }),
    ).toMatchObject({ tools: [], _meta: metadata });
    expect(await client.request({ method: "resources/list" })).toMatchObject({
      nextCursor: "page:2",
      _meta: metadata,
      resources: [{ uri: "fixture://note", _meta: metadata }],
    });
    expect(
      await client.request({ method: "resources/list", params: { cursor: "page:2" } }),
    ).toMatchObject({ resources: [], _meta: metadata });
    expect(await client.request({ method: "resources/templates/list" })).toMatchObject({
      nextCursor: "page:2",
      resourceTemplates: [{ uriTemplate: "fixture://{name}", _meta: metadata }],
    });
    expect(await client.request({ method: "prompts/list" })).toMatchObject({
      nextCursor: "page:2",
      prompts: [{ name: "greeting", _meta: metadata }],
    });
    expect(
      await client.request({ method: "resources/templates/list", params: { cursor: "page:2" } }),
    ).toMatchObject({ resourceTemplates: [], _meta: metadata });
    expect(
      await client.request({ method: "prompts/list", params: { cursor: "page:2" } }),
    ).toMatchObject({ prompts: [], _meta: metadata });
    expect(
      await client.request({
        method: "completion/complete",
        params: {
          ref: { type: "ref/prompt", name: "greeting" },
          argument: { name: "name", value: "A" },
        },
      }),
    ).toEqual({
      completion: { values: ["Ada", "Alan"], total: 3, hasMore: true },
      _meta: metadata,
    });
    expect(await client.readResource({ uri: "fixture://note" })).toMatchObject({
      _meta: metadata,
      contents: [{ text: "full resource", _meta: metadata }],
    });
    expect(await client.getPrompt({ name: "greeting", arguments: { name: "Ada" } })).toMatchObject({
      _meta: metadata,
      messages: [{ content: { text: "Hello Ada", _meta: metadata } }],
    });
    const result = await client.callTool({
      name: "inspect.raw",
      arguments: { marker: "real-effect" },
    });
    expect(toolPayload(result)).toMatchObject({ roots });
    expect(result._meta).toEqual(metadata);
    expect(result.structuredContent).toEqual({ count: 7 });
    expect((await server.log()).filter((line) => line.startsWith("started "))).toHaveLength(1);
  });

  it("mirrors modern discovery and fulfils a roots continuation through the real client", async () => {
    const server = await fixture("modern");
    const route = server.register();
    const { client, rootsRequests } = await connect({
      url: route.url,
      grant: await server.grant(),
      mode: "auto",
    });
    expect(client.getProtocolEra()).toBe("modern");
    expect(rootsRequests()).toBe(0);
    expect((await client.request({ method: "tools/list" })).tools.map((tool) => tool.name)).toEqual(
      ["inspect.raw"],
    );
    const result = await client.callTool({ name: "inspect.raw", arguments: {} });
    expect(toolPayload(result)).toMatchObject({ responses: { roots } });
    expect(result._meta).toEqual({
      ...metadata,
      [SERVER_INFO_META_KEY]: { name: "typed-fixture", version: "1.0.0" },
    });
    expect(result.structuredContent).toEqual({ count: 7 });
    expect(rootsRequests()).toBe(1);
    const lines = await server.log();
    expect(lines.filter((line) => line.startsWith("started "))).toHaveLength(1);
    expect(lines).toContain("resumed fixture-state");
  });

  it("rechecks the current policy and grant on an already-connected legacy client across warm turns", async () => {
    const server = await fixture("legacy");
    const firstRoute = server.register();
    const firstGrant = await server.grant();
    const consumer = await connect({ url: firstRoute.url, grant: firstGrant, mode: "legacy" });
    const firstPid = toolPayload(
      await consumer.client.callTool({ name: "inspect.raw", arguments: {} }),
    ).pid;
    const secondRoute = server.register(true);
    expect(secondRoute.url).toBe(firstRoute.url);
    await firstRoute.close();
    const nextGrant = await server.grant();
    const listener = loopbackRuntime();
    expect(
      transferMcpLoopbackClientGrant({
        sourceToken: nextGrant.token,
        targetToken: firstGrant.token,
        runtimeOwnerToken: listener.ownerToken,
      }),
    ).toBe(true);
    expect(
      activateMcpLoopbackClientGrantCapture({
        token: firstGrant.token,
        runtimeOwnerToken: listener.ownerToken,
        captureKey: nextGrant.captureKey,
      }),
    ).toEqual({ captureNativeToolAuthority: expect.any(Function) });
    consumer.setGrant({ ...nextGrant, token: firstGrant.token });
    await expect(
      consumer.client.callTool({ name: "inspect.raw", arguments: { forbidden: true } }),
    ).rejects.toThrow(/unavailable|policy/i);
    const thirdRoute = server.register();
    await secondRoute.close();
    expect(
      toolPayload(await consumer.client.callTool({ name: "inspect.raw", arguments: {} })).pid,
    ).toBe(firstPid);
    expect((await server.log()).filter((line) => line.startsWith("started "))).toHaveLength(1);
    expect((await server.log()).filter((line) => line === "call inspect.raw")).toHaveLength(2);
    revokeMcpLoopbackClientGrant(firstGrant.token);
    await expect(
      consumer.client.callTool({ name: "inspect.raw", arguments: { revoked: true } }),
    ).rejects.toThrow();
    await thirdRoute.close();
  });
  it.for([
    { upstream: "modern", mode: "auto", present: true, selectedEra: "modern" },
    { upstream: "modern", mode: "legacy", present: false, selectedEra: undefined },
    { upstream: "dual", mode: "auto", present: true, selectedEra: "modern" },
    { upstream: "dual", mode: "legacy", present: true, selectedEra: "legacy" },
  ] as const)(
    "mirrors $mode negotiation against a $upstream upstream",
    async ({ upstream, mode, present, selectedEra }) => {
      const server = await fixture(upstream);
      const route = server.register();
      const connecting = connect({ url: route.url, grant: await server.grant(), mode });
      if (!present) {
        await expect(connecting).rejects.toThrow();
        expect(server.diagnostics.join("\n")).toMatch(/legacy|protocol|modern|initialize/i);
        expect((await server.log()).filter((line) => line.startsWith("call "))).toEqual([]);
        return;
      }
      const { client } = await connecting;
      expect(client.getProtocolEra()).toBe(selectedEra);
      expect(
        (await client.request({ method: "tools/list" })).tools.map((tool) => tool.name),
      ).toEqual(["inspect.raw"]);
      expect(
        toolPayload(await client.callTool({ name: "inspect.raw", arguments: {} })).pid,
      ).toBeGreaterThan(0);
      expect((await server.log()).filter((line) => line.startsWith("started "))).toHaveLength(1);
    },
  );

  it("rejects a grant belonging to another requester in the same session", async () => {
    const server = await fixture("legacy");
    const route = server.register();
    const grant = await server.grant("bob");
    const response = await fetch(route.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${grant.token}`,
        "x-openclaw-cli-capture-key": grant.captureKey,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "foreign-requester", version: "1" },
        },
      }),
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
    await expect(fs.stat(server.file + ".log")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a response whose grant was revoked during an upstream await and retires its process", async ({
    signal,
  }) => {
    const server = await fixture("legacy");
    const route = server.register();
    const grant = await server.grant();
    const { client } = await connect({ url: route.url, grant, mode: "legacy" });
    const pending = client.callTool(
      { name: "inspect.raw", arguments: { operation: "hold" } },
      { onprogress() {} },
    );
    void pending.catch(() => {});
    try {
      await withinTest(harness.receipts.waitFor(server.file, "holding"), signal);
      revokeMcpLoopbackClientGrant(grant.token);
      harness.receipts.release(server.file, "finish");
      await expect(pending).rejects.toThrow();
      expect((await server.log()).filter((line) => line === "call inspect.raw")).toHaveLength(1);
    } finally {
      harness.receipts.release(server.file, "finish");
      await pending.catch(() => {});
      const pids = (await server.log())
        .filter((line) => line.startsWith("started "))
        .map((line) => Number(line.slice(8)));
      await server.runtime.dispose();
      await server.runtime.joinCleanup?.();
      for (const pid of pids) {
        expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
      }
    }
  });

  it("refreshes silent legacy roots changes while preserving subscriptions and grant revocation", async ({
    signal,
  }) => {
    const server = await fixture("legacy");
    const route = server.register();
    const grant = await server.grant();
    let currentRoots = roots;
    const { client } = await connect({
      url: route.url,
      grant,
      mode: "legacy",
      roots: () => currentRoots,
    });
    const updated: unknown[] = [];
    const logged: unknown[] = [];
    const delivered = Promise.withResolvers<void>();
    const secondLogDelivered = Promise.withResolvers<void>();
    client.setNotificationHandler("notifications/resources/updated", (notification) => {
      updated.push(notification.params);
      if (updated.length === 1 && logged.length === 1) {
        delivered.resolve();
      }
    });
    client.setNotificationHandler("notifications/message", (notification) => {
      logged.push(notification.params);
      if (updated.length === 1 && logged.length === 1) {
        delivered.resolve();
      }
      if (logged.length === 2) {
        secondLogDelivered.resolve();
      }
    });
    await client.request({ method: "resources/subscribe", params: { uri: "fixture://note" } });
    await client.request({ method: "logging/setLevel", params: { level: "info" } });
    const original = toolPayload(await client.callTool({ name: "inspect.raw", arguments: {} }));
    currentRoots = { roots: [{ uri: "file:///fixture/changed-worktree" }], _meta: roots._meta };
    const catalog = await client.request({ method: "tools/list" });
    expect(JSON.parse(catalog.tools[0]!.description!)).toMatchObject({ roots: currentRoots });
    await client.callTool({ name: "inspect.raw", arguments: { operation: "notify" } });
    await withinTest(delivered.promise, signal);
    expect(updated).toEqual([{ uri: "fixture://note", _meta: metadata }]);
    expect(logged).toEqual([
      { level: "info", data: { message: "resource refreshed" }, _meta: metadata },
    ]);
    const changed = toolPayload(await client.callTool({ name: "inspect.raw", arguments: {} }));
    expect(changed.roots).toEqual(currentRoots);
    expect(changed.pid).not.toBe(original.pid);
    expect(() => process.kill(original.pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
    await client.request({ method: "resources/unsubscribe", params: { uri: "fixture://note" } });
    await client.callTool({ name: "inspect.raw", arguments: { operation: "notify" } });
    await withinTest(secondLogDelivered.promise, signal);
    expect(updated).toHaveLength(1);
    expect(logged).toHaveLength(2);
    expect(await server.log()).toEqual(
      expect.arrayContaining([
        "recv resources/subscribe",
        "recv resources/unsubscribe",
        "recv logging/setLevel",
      ]),
    );
    const pending = client.callTool({
      name: "inspect.raw",
      arguments: { operation: "notify", releaseToken: "revoked-notify" },
    });
    void pending.catch(() => {});
    try {
      await withinTest(harness.receipts.waitFor(server.file, "notification waiting"), signal);
      revokeMcpLoopbackClientGrant(grant.token);
      harness.receipts.release(server.file, "revoked-notify");
      await expect(pending).rejects.toThrow();
      expect(updated).toHaveLength(1);
      expect(logged).toHaveLength(2);
    } finally {
      harness.receipts.release(server.file, "revoked-notify");
      await pending.catch(() => {});
    }
  });

  it.for(["legacy", "modern"] as const)(
    "drains tool capture while the %s notification stream stays connected",
    async (era, { signal }) => {
      const server = await fixture(era);
      const route = server.register();
      const grant = await server.grant();
      captureKeys.push(grant.captureKey);
      const captured: unknown[] = [];
      beginMcpLoopbackToolCallCapture({
        captureKey: grant.captureKey,
        onToolCallResult: (call) => {
          captured.push(call);
        },
      });
      const consumer = await connect({
        url: route.url,
        grant,
        mode: era === "legacy" ? "legacy" : "auto",
      });
      const subscription =
        era === "modern" ? await consumer.client.listen({ toolsListChanged: true }) : undefined;
      try {
        const stream = await withinTest(consumer.persistentStream, signal);
        expect(stream.response.ok).toBe(true);
        expect(stream.response.headers.get("content-type")).toContain("text/event-stream");
        expect(stream.signal?.aborted).toBe(false);
        await consumer.client.callTool({
          name: "inspect.raw",
          arguments: { marker: "captured-effect" },
        });
        expect(
          await waitForMcpLoopbackToolCallCaptureIdle(grant.captureKey, { timeoutMs: 500 }),
        ).toBe(true);
        expect(stream.signal?.aborted).toBe(false);
        expect(captured).toMatchObject([
          {
            toolName: "mcp__fixture__inspect_raw",
            args: { marker: "captured-effect" },
            outcome: "completed",
          },
        ]);
        const notification = Promise.withResolvers<void>();
        consumer.client.setNotificationHandler("notifications/tools/list_changed", () => {
          notification.resolve();
        });
        await consumer.client.callTool({ name: "inspect.raw", arguments: { operation: "notify" } });
        await withinTest(notification.promise, signal);
        expect(
          await waitForMcpLoopbackToolCallCaptureIdle(grant.captureKey, { timeoutMs: 500 }),
        ).toBe(true);
        expect(captured).toMatchObject([
          {
            toolName: "mcp__fixture__inspect_raw",
            args: { marker: "captured-effect" },
            outcome: "completed",
          },
          {
            toolName: "mcp__fixture__inspect_raw",
            args: { operation: "notify" },
            outcome: "completed",
          },
        ]);
        if (subscription) {
          expect(subscription.honoredFilter).toEqual({ toolsListChanged: true });
        }
      } finally {
        await subscription?.close();
      }
    },
  );

  it("does not spawn an upstream after its grant is revoked while obtaining legacy roots", async () => {
    const server = await fixture("legacy");
    const route = server.register();
    const grant = await server.grant();
    await expect(
      connect({
        url: route.url,
        grant,
        mode: "legacy",
        beforeRootsResponse: () => {
          revokeMcpLoopbackClientGrant(grant.token);
        },
      }),
    ).rejects.toThrow();
    await expect(fs.stat(server.file + ".log")).rejects.toMatchObject({ code: "ENOENT" });
  });
  it.for(["direct", "projection"] as const)(
    "delivers a modern resource subscription through %s serving",
    async (mode, { signal }) => {
      const server = await fixture("modern");
      const client =
        mode === "projection"
          ? (
              await connect({
                url: server.register().url,
                grant: await server.grant(),
                mode: "auto",
              })
            ).client
          : await connectDirect(server.file);
      const updated = Promise.withResolvers<string>();
      client.setNotificationHandler("notifications/resources/updated", (notification) => {
        updated.resolve(notification.params.uri);
      });
      const subscription = await client.listen({ resourceSubscriptions: ["fixture://note"] });
      expect(subscription.honoredFilter).toEqual({ resourceSubscriptions: ["fixture://note"] });
      const upstream = resourceSubscriptionIds(await server.log(), "fixture://note");
      expect(upstream).toHaveLength(1);
      const publication = client.callTool({
        name: "inspect.raw",
        arguments: { operation: "publish-resource" },
      });
      void publication.catch(() => {});
      try {
        await withinTest(
          harness.receipts.waitFor(server.file, "publication ready publish-resource"),
          signal,
        );
        harness.receipts.release(server.file, "publish-resource");
        expect(await withinTest(updated.promise, signal)).toBe("fixture://note");
        harness.receipts.release(server.file, "publish-resource-observed");
        await publication;
      } finally {
        harness.receipts.release(server.file, "publish-resource");
        harness.receipts.release(server.file, "publish-resource-observed");
        await publication.catch(() => {});
        await subscription.close();
        await withinTest(
          harness.receipts.waitFor(server.file, "wire cancel " + upstream[0]),
          signal,
        );
      }
    },
  );

  it.for(["direct", "projection"] as const)(
    "preserves custom modern list-change metadata through %s serving",
    async (mode, { signal }) => {
      const server = await fixture("modern");
      const client =
        mode === "projection"
          ? (
              await connect({
                url: server.register().url,
                grant: await server.grant(),
                mode: "auto",
              })
            ).client
          : await connectDirect(server.file);
      const changed = Promise.withResolvers<Record<string, unknown>>();
      client.setNotificationHandler("notifications/tools/list_changed", (notification) => {
        changed.resolve(notification.params?._meta ?? {});
      });
      const subscription = await client.listen({ toolsListChanged: true });
      expect(subscription.honoredFilter).toEqual({ toolsListChanged: true });
      const publication = client.callTool({
        name: "inspect.raw",
        arguments: { operation: "publish-tools" },
      });
      void publication.catch(() => {});
      try {
        await withinTest(
          harness.receipts.waitFor(server.file, "publication ready publish-tools"),
          signal,
        );
        harness.receipts.release(server.file, "publish-tools");
        const { [SUBSCRIPTION_ID_META_KEY]: subscriptionId, ...custom } = await withinTest(
          changed.promise,
          signal,
        );
        expect(subscriptionId).toBeDefined();
        expect(custom).toEqual(metadata);
        harness.receipts.release(server.file, "publish-tools-observed");
        await publication;
      } finally {
        harness.receipts.release(server.file, "publish-tools");
        harness.receipts.release(server.file, "publish-tools-observed");
        await publication.catch(() => {});
        await subscription.close();
      }
    },
  );
  it.for([
    { operation: "elicit", mode: "direct" },
    { operation: "elicit", mode: "projection" },
    { operation: "url", mode: "direct" },
    { operation: "url", mode: "projection" },
  ] as const)(
    "preserves a modern $operation input-required round trip through $mode serving",
    async ({ operation, mode }) => {
      const server = await fixture("modern");
      const consumer =
        mode === "projection"
          ? await connect({
              url: server.register().url,
              grant: await server.grant(),
              mode: "auto",
              elicitation: true,
            })
          : {
              client: await connectDirect(server.file, "auto", {
                elicitation: { form: {}, url: {} },
              }),
              elicited: [] as unknown[],
            };
      if (mode === "direct") {
        consumer.client.setRequestHandler("elicitation/create", async (request) => {
          consumer.elicited.push(request.params);
          return request.params.mode === "url"
            ? { action: "accept", _meta: metadata }
            : { action: "accept", content: { choice: "fixture" }, _meta: metadata };
        });
      }
      const response = toolPayload(
        await consumer.client.callTool({ name: "inspect.raw", arguments: { operation } }),
      );
      // The modern SDK schema intentionally omits legacy elicitation metadata.
      expect(response.responses).toEqual({
        answer:
          operation === "url"
            ? { action: "accept" }
            : { action: "accept", content: { choice: "fixture" } },
      });
      expect(consumer.elicited).toEqual([
        operation === "url"
          ? {
              mode: "url",
              url: "https://example.invalid/authorize",
              message: "Authorize the fixture",
            }
          : {
              mode: "form",
              message: "Choose",
              requestedSchema: { type: "object", properties: { choice: { type: "string" } } },
            },
      ]);
      // The SDK stdio transport forks a disposable probe; the projection probes in place.
      expect((await server.log()).filter((line) => line.startsWith("started "))).toHaveLength(
        mode === "direct" ? 2 : 1,
      );
    },
  );

  it("preserves legacy custom elicitation and URL-completion ownership", async ({ signal }) => {
    const server = await fixture("legacy");
    const consumer = await connect({
      url: server.register().url,
      grant: await server.grant(),
      mode: "legacy",
      elicitation: true,
    });
    expect(
      toolPayload(
        await consumer.client.callTool({
          name: "inspect.raw",
          arguments: { operation: "elicitCustom" },
        }),
      ),
    ).toEqual({ action: "accept", content: { choice: "custom" }, _meta: metadata });
    expect(consumer.elicited).toEqual([
      {
        message: "Rich form",
        fields: [{ id: "choice", options: ["a", "b"] }],
        _meta: { fixture: "custom" },
      },
    ]);
    const completed = Promise.withResolvers<string>();
    consumer.client.setNotificationHandler("notifications/elicitation/complete", (notification) => {
      completed.resolve(notification.params.elicitationId);
    });
    await consumer.client.callTool({ name: "inspect.raw", arguments: { operation: "url" } });
    await consumer.client.callTool({
      name: "inspect.raw",
      arguments: { operation: "completeUrl" },
    });
    expect(await withinTest(completed.promise, signal)).toBe("fixture-url");
  });

  it("reconnects after an upstream crash without replaying its failed effect", async ({
    signal,
  }) => {
    const server = await fixture("legacy");
    const route = server.register();
    const grant = await server.grant();
    const first = await connect({ url: route.url, grant, mode: "legacy" });
    const firstPid = toolPayload(
      await first.client.callTool({ name: "inspect.raw", arguments: {} }),
    ).pid;
    await expect(
      first.client.callTool({ name: "inspect.raw", arguments: { operation: "crash" } }),
    ).rejects.toThrow();
    await withinTest(harness.receipts.waitForExit(server.file + ":" + firstPid), signal);
    const next = await connect({ url: route.url, grant, mode: "legacy" });
    expect(
      toolPayload(await next.client.callTool({ name: "inspect.raw", arguments: {} })).pid,
    ).not.toBe(firstPid);
    const log = await server.log();
    expect(log.filter((line) => line === "crashing")).toHaveLength(1);
    expect(log.filter((line) => line === "call inspect.raw")).toHaveLength(3);
    expect(log.filter((line) => line.startsWith("started "))).toHaveLength(2);
  });

  it("forwards progress and records one result for one upstream effect", async ({ signal }) => {
    const server = await fixture("legacy");
    const grant = await server.grant();
    const consumer = await connect({ url: server.register().url, grant, mode: "legacy" });
    const progress: unknown[] = [];
    const captured: unknown[] = [];
    captureKeys.push(grant.captureKey);
    beginMcpLoopbackToolCallCapture({
      captureKey: grant.captureKey,
      onToolCallResult: (call) => {
        captured.push(call);
      },
    });
    const pending = consumer.client.callTool(
      { name: "inspect.raw", arguments: { operation: "hold" } },
      {
        onprogress: (value) => {
          progress.push(value);
        },
      },
    );
    void pending.catch(() => {});
    try {
      await withinTest(harness.receipts.waitFor(server.file, "holding"), signal);
      harness.receipts.release(server.file, "finish");
      const result = await pending;
      expect(result.structuredContent).toEqual({ count: 7 });
      expect(progress).toMatchObject([
        { progress: 1, total: 2, message: "waiting" },
        { progress: 2, total: 2, message: "finished" },
      ]);
      expect(captured).toMatchObject([{ outcome: "completed", args: { operation: "hold" } }]);
      expect((await server.log()).filter((line) => line === "call inspect.raw")).toHaveLength(1);
    } finally {
      harness.receipts.release(server.file, "finish");
      await pending.catch(() => {});
    }
  });

  it("keeps raw names distinct when native permission identifiers collide", async () => {
    const server = await fixture("legacy", { inventory: "collision" });
    const consumer = await connect({
      url: server.register(false, ["fixture__inspect-raw"]).url,
      grant: await server.grant(),
      mode: "legacy",
    });
    expect(
      (await consumer.client.request({ method: "tools/list" })).tools.map((tool) => tool.name),
    ).toEqual(["inspect/raw"]);
    await expect(consumer.client.callTool({ name: "inspect.raw", arguments: {} })).rejects.toThrow(
      /unavailable|policy/i,
    );
    await consumer.client.callTool({ name: "inspect/raw", arguments: {} });
    expect((await server.log()).filter((line) => line.startsWith("call "))).toEqual([
      "call inspect/raw",
    ]);
  });

  it.for(["resources", "prompts"] as const)(
    "serves a %s-only upstream without requiring callable tools",
    async (inventory) => {
      const server = await fixture("legacy", { inventory });
      const consumer = await connect({
        url: server.register().url,
        grant: await server.grant(),
        mode: "legacy",
      });
      expect(consumer.client.getServerCapabilities()?.tools).toBeUndefined();
      if (inventory === "resources") {
        expect(await consumer.client.readResource({ uri: "fixture://note" })).toMatchObject({
          contents: [{ text: "full resource" }],
          _meta: metadata,
        });
      } else {
        expect(await consumer.client.getPrompt({ name: "greeting" })).toMatchObject({
          messages: [{ content: { text: "Hello Ada" } }],
          _meta: metadata,
        });
      }
      expect((await server.log()).filter((line) => line.startsWith("started "))).toHaveLength(1);
    },
  );

  it("rejects an already-connected view after its admitting run ends", async () => {
    const server = await fixture("legacy");
    const grant = await server.grant();
    const consumer = await connect({ url: server.register().url, grant, mode: "legacy" });
    await consumer.client.callTool({ name: "inspect.raw", arguments: {} });
    grant.retireAdmission();
    await expect(
      consumer.client.callTool({ name: "inspect.raw", arguments: { forbidden: true } }),
    ).rejects.toThrow();
    expect((await server.log()).filter((line) => line === "call inspect.raw")).toHaveLength(1);
  });
  it("cancels a turn waiting for modern input without resuming its effect", async ({ signal }) => {
    const server = await fixture("modern");
    const route = server.register();
    const grant = await server.grant();
    const consumer = await connect({ url: route.url, grant, mode: "auto", elicitation: true });
    const asked = Promise.withResolvers<void>();
    const answer = Promise.withResolvers<{ action: "accept" }>();
    consumer.client.setRequestHandler("elicitation/create", async (_request, context) => {
      asked.resolve();
      return withinTest(answer.promise, context.mcpReq.signal);
    });
    captureKeys.push(grant.captureKey);
    const outcomes: unknown[] = [];
    beginMcpLoopbackToolCallCapture({
      captureKey: grant.captureKey,
      onToolCallResult: (call) => {
        outcomes.push(call);
      },
    });
    const controller = new AbortController();
    const pending = consumer.client.callTool(
      { name: "inspect.raw", arguments: { operation: "elicit" } },
      { signal: controller.signal },
    );
    void pending.catch(() => {});
    try {
      await withinTest(asked.promise, signal);
      controller.abort(new Error("Synthetic turn cancelled"));
      await expect(pending).rejects.toThrow();
      expect(
        deactivateMcpLoopbackClientGrantCapture({
          token: grant.token,
          runtimeOwnerToken: loopbackRuntime().ownerToken,
          captureKey: grant.captureKey,
        }),
      ).toBe(true);
      expect(
        await waitForMcpLoopbackToolCallCaptureIdle(grant.captureKey, { timeoutMs: 500 }),
      ).toBe(true);
      expect(outcomes).toMatchObject([{ outcome: "failed" }]);
      expect((await server.log()).filter((line) => line === "call inspect.raw")).toHaveLength(1);
    } finally {
      answer.resolve({ action: "accept" });
      controller.abort();
      await pending.catch(() => {});
    }
  });
  it("does not deliver one modern grant's notifications to a revoked peer grant", async ({
    signal,
  }) => {
    const server = await fixture("modern");
    const route = server.register();
    const grantA = await server.grant();
    const grantB = await server.grant();
    const a = await connect({ url: route.url, grant: grantA, mode: "auto" });
    const b = await connect({ url: route.url, grant: grantB, mode: "auto" });
    const receivedA: unknown[] = [];
    const receivedB = Promise.withResolvers<void>();
    a.client.setNotificationHandler("notifications/tools/list_changed", (event) => {
      receivedA.push(event);
    });
    b.client.setNotificationHandler("notifications/tools/list_changed", () => {
      receivedB.resolve();
    });
    const streamA = await a.client.listen({ toolsListChanged: true });
    const streamB = await b.client.listen({ toolsListChanged: true });
    await b.client.request({ method: "tools/list" });
    revokeMcpLoopbackClientGrant(grantA.token);
    const publication = b.client.callTool({
      name: "inspect.raw",
      arguments: { operation: "publish-tools" },
    });
    void publication.catch(() => {});
    try {
      await withinTest(
        harness.receipts.waitFor(server.file, "publication ready publish-tools"),
        signal,
      );
      harness.receipts.release(server.file, "publish-tools");
      await withinTest(receivedB.promise, signal);
      harness.receipts.release(server.file, "publish-tools-observed");
      await publication;
      expect(receivedA).toEqual([]);
    } finally {
      harness.receipts.release(server.file, "publish-tools");
      harness.receipts.release(server.file, "publish-tools-observed");
      await publication.catch(() => {});
      await Promise.all([streamA.close(), streamB.close()]);
    }
  });

  it("does not allow a second grant to adopt a legacy transport session", async () => {
    const server = await fixture("legacy");
    const route = server.register();
    const first = await connect({ url: route.url, grant: await server.grant(), mode: "legacy" });
    const secondGrant = await server.grant();
    const before = await server.log();
    expect(first.transport.sessionId).toBeDefined();
    const response = await fetch(route.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${secondGrant.token}`,
        "x-openclaw-cli-capture-key": secondGrant.captureKey,
        "mcp-session-id": first.transport.sessionId!,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 90, method: "tools/list", params: {} }),
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "native_mcp_session_expired" });
    expect(await server.log()).toEqual(before);
  });
});
