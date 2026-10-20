import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import {
  openFixtureReceiptChannel,
  type FixtureReceiptChannel,
} from "../../test/helpers/fixture-receipts.js";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { withGuardedFetchRequestAuthority } from "../infra/net/fetch-request-authority.js";
import { createSessionMcpRuntime } from "./agent-bundle-mcp-runtime.js";
import type { SessionMcpRuntime } from "./agent-bundle-mcp-types.js";
import { acquireNativeMcpServer, type NativeMcpServerEvent } from "./native-mcp-runtime.js";
import {
  context,
  options,
  payload,
  processId,
  writeNativeMcpFixture,
} from "./native-mcp-runtime.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const runtimes: SessionMcpRuntime[] = [];
let receipts: FixtureReceiptChannel;
beforeAll(async () => {
  receipts = await openFixtureReceiptChannel();
});
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
});
afterAll(async () => {
  await receipts.close();
});

async function fixture(era: "legacy" | "modern") {
  const directory = tempDirs.make("native-mcp-resource-leases-");
  const file = path.join(directory, "server.mjs");
  await writeNativeMcpFixture(file, receipts.endpoint, era);
  let source = await fs.readFile(file, "utf8");
  if (era === "modern") {
    source = source.replace("resources: {},", "resources: { subscribe: true },");
    source = source.replace(
      'server.setRequestHandler("tools/call", (request, ctx) => {',
      'server.setRequestHandler("tools/call", async (request, ctx) => { if (request.params.name === "notify") { await server.sendResourceUpdated({ uri: "fixture://note", _meta: metadata }); return result({ pid: process.pid }); }',
    );
    source = source.replace('const era = "modern";', 'const era = "modern"; let resourceListenId;');
    source = source
      .replace("const { serveStdio } =", "const { serveStdio, StdioServerTransport } =")
      .replace(
        "serveStdio(() => {",
        `const transport = new StdioServerTransport();
        const start = transport.start.bind(transport);
        transport.start = async () => {
          const receive = transport.onmessage;
          transport.onmessage = (message, extra) => {
            if (message.method) record("wire " + message.method);
            if (message.method === "subscriptions/listen" && message.params.notifications.resourceSubscriptions?.length) resourceListenId = message.id;
            receive?.(message, extra);
          };
          await start();
        };
        serveStdio(() => {`,
      )
      .replace('{ legacy: "reject" }', '{ legacy: "reject", transport }');
    source = source.replace(
      'if (request.params.name === "notify") {',
      'if (request.params.name === "endResourceSubscription") { if (resourceListenId === undefined) throw new Error("No resource listen"); await transport.send({ jsonrpc: "2.0", id: resourceListenId, result: { resultType: "complete", _meta: { "io.modelcontextprotocol/subscriptionId": resourceListenId } } }); return result({ pid: process.pid }); } if (request.params.name === "notify") {',
    );
  } else {
    source = source.replace(
      "resources: { listChanged: true }",
      "resources: { listChanged: true, subscribe: true }",
    );
    source = source.replace(
      "let urlElicitationId;",
      "let urlElicitationId; let resourceSubscribed = false;",
    );
    source = source.replace(
      '} else if (message.method === "resources/read") {',
      '} else if (message.method === "resources/subscribe") { resourceSubscribed = true; value = {}; } else if (message.method === "resources/unsubscribe") { resourceSubscribed = false; value = {}; } else if (message.method === "resources/read") {',
    );
    source = source.replace(
      'if (params.name === "crash")',
      'if (params.name === "notify" && resourceSubscribed) send({ method: "notifications/resources/updated", params: { uri: "fixture://note", _meta: metadata } }); if (params.name === "crash")',
    );
  }
  await fs.writeFile(file, source);
  const runtime = createSessionMcpRuntime({
    sessionId: `resources-${era}`,
    workspaceDir: directory,
    cfg: {
      plugins: { enabled: false },
      mcp: { servers: { fixture: { command: process.execPath, args: [file] } } },
    },
  });
  runtimes.push(runtime);
  return {
    runtime,
    file,
    log: async () => (await fs.readFile(file + ".log", "utf8")).trim().split("\n"),
  };
}

it.for(["legacy", "modern"] as const)(
  "shares one %s wire subscription until the last resource lease releases",
  async (era, { signal }) => {
    const { runtime, log } = await fixture(era);
    const shared = context();
    let revoked = false;
    const first = await acquireNativeMcpServer(runtime, "fixture", {
      ...shared,
      assertCurrent() {
        if (revoked) {
          throw new Error("first view revoked");
        }
      },
    });
    const survivor = await acquireNativeMcpServer(runtime, "fixture", shared);
    const resource = { uri: "fixture://note" };
    const cancellation = new AbortController();
    const firstEvents: unknown[] = [];
    const survivorEvents: unknown[] = [];
    const watch = (events: unknown[]) => (event: NativeMcpServerEvent) => {
      if (
        event.kind === "notification" &&
        event.notification.method === "notifications/resources/updated"
      ) {
        events.push(event.notification.params);
      }
    };
    first.subscribe(watch(firstEvents));
    survivor.subscribe(watch(survivorEvents));
    try {
      const firstLease = await first.acquireResourceSubscription(
        resource,
        options(cancellation.signal),
      );
      const overlappingLease = await first.acquireResourceSubscription(
        resource,
        options(cancellation.signal),
      );
      await first.subscribeResource(resource, options(signal));
      await first.subscribeResource(resource, options(signal));
      const survivingLease = await survivor.acquireResourceSubscription(resource, options(signal));
      const notify = () => survivor.callTool({ name: "notify" }, options(signal));
      await notify();
      expect(firstEvents).toHaveLength(1);
      expect(survivorEvents).toHaveLength(1);
      expect(survivorEvents[0]).toMatchObject({
        uri: resource.uri,
        _meta: { fixture: "kept", nested: { value: 7 } },
      });
      await firstLease.release();
      await notify();
      expect(firstEvents).toHaveLength(2);
      expect(survivorEvents).toHaveLength(2);

      revoked = true;
      cancellation.abort(new Error("original request aborted"));
      await overlappingLease.release();
      await first.release();
      await notify();
      expect(firstEvents).toHaveLength(2);
      expect(survivorEvents).toHaveLength(3);
      let cleanupRevoked = false;
      await withGuardedFetchRequestAuthority(
        () => {
          if (cleanupRevoked) {
            throw new Error("cleanup grant revoked");
          }
        },
        async () => {
          cleanupRevoked = true;
          await survivingLease.release();
        },
      );
      await survivingLease.release();
      await notify();
      expect(survivorEvents).toHaveLength(3);
      const lines = await log();
      if (era === "legacy") {
        expect(lines.filter((line) => line === "recv resources/subscribe")).toHaveLength(1);
        expect(lines.filter((line) => line === "recv resources/unsubscribe")).toHaveLength(1);
      } else {
        // One owner catalog subscription and one shared resource subscription.
        expect(lines.filter((line) => line === "wire subscriptions/listen")).toHaveLength(2);
      }
    } finally {
      await Promise.all([first.release(), survivor.release()]);
    }
  },
);

it("reports the ended resource only to its holders while preserving their upstream", async ({
  signal,
}) => {
  const { runtime } = await fixture("modern");
  const caller = context();
  const subscribed = await acquireNativeMcpServer(runtime, "fixture", caller);
  const uninvolved = await acquireNativeMcpServer(runtime, "fixture", caller);
  const ended = createDeferred<string>();
  let uninvolvedEndings = 0;
  subscribed.subscribe((event) => {
    if (event.kind === "resource-subscription-ended") {
      ended.resolve(event.uri);
    }
  });
  uninvolved.subscribe((event) => {
    if (event.kind === "resource-subscription-ended") {
      uninvolvedEndings += 1;
    }
  });
  try {
    const lease = await subscribed.acquireResourceSubscription(
      { uri: "fixture://note" },
      options(signal),
    );
    const result = await uninvolved.callTool({ name: "endResourceSubscription" }, options(signal));
    const pid = processId(payload(result));
    expect(await withinTest(ended.promise, signal)).toBe("fixture://note");
    expect(uninvolvedEndings).toBe(0);
    // A terminal subscription result does not close the native transport or other views.
    expect((await uninvolved.listTools(undefined, options(signal))).tools[0]?.name).toBe("probe");
    expect(processId(payload(await subscribed.callTool({ name: "notify" }, options(signal))))).toBe(
      pid,
    );
    await lease.release();
    await lease.release();
  } finally {
    await Promise.all([subscribed.release(), uninvolved.release()]);
  }
});
