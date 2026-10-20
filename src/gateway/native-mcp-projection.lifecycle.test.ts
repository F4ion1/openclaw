import fs from "node:fs/promises";
import { expect, it } from "vitest";
import { withinTest } from "../../test/helpers/promise.js";
import { revokeMcpLoopbackClientGrant } from "./mcp-grant-store.js";
import { closeNativeMcpProjections } from "./native-mcp-projection.js";
import { createProjectionHarness } from "./native-mcp-projection.test-harness.js";
import { toolPayload } from "./native-mcp-projection.test-support.js";

const harness = createProjectionHarness();
const { fixture, connect } = harness;

it("retires malformed legacy initialization without leaving cleanup pending", async ({
  signal,
}) => {
  const server = await fixture("legacy");
  const route = server.register();
  const grant = await server.grant();
  const response = await fetch(route.url, {
    method: "POST",
    signal,
    headers: {
      authorization: `Bearer ${grant.token}`,
      "x-openclaw-cli-capture-key": grant.captureKey,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 901,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: 9, version: "1" },
      },
    }),
  });
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({
    jsonrpc: "2.0",
    id: null,
    error: { code: -32000, message: "Bad Request: Server not initialized" },
  });
  await withinTest(closeNativeMcpProjections(), signal);
  await expect(fs.stat(server.file + ".log")).rejects.toMatchObject({ code: "ENOENT" });
  const consumer = await connect({
    url: server.register().url,
    grant,
    mode: "legacy",
    forbidPreInitializationGet: true,
  });
  expect(
    toolPayload(await consumer.client.callTool({ name: "inspect.raw", arguments: {} })).pid,
  ).toBeGreaterThan(0);
});

it("releases a legacy DELETE session's upstream and subscriptions before reconnect", async ({
  signal,
}) => {
  const server = await fixture("legacy");
  const route = server.register();
  const grant = await server.grant();
  const first = await connect({ url: route.url, grant, mode: "legacy" });
  const firstPid = toolPayload(
    await first.client.callTool({ name: "inspect.raw", arguments: {} }),
  ).pid;
  await first.client.subscribeResource({ uri: "fixture://note" });
  await first.transport.terminateSession();
  await withinTest(harness.receipts.waitForExit(server.file + ":" + firstPid), signal);
  await withinTest(closeNativeMcpProjections(), signal);
  expect(() => process.kill(firstPid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
  const next = await connect({ url: server.register().url, grant, mode: "legacy" });
  expect(
    toolPayload(await next.client.callTool({ name: "inspect.raw", arguments: {} })).pid,
  ).not.toBe(firstPid);
  expect((await server.log()).filter((line) => line.startsWith("started "))).toHaveLength(2);
});

it("closes an explicitly removed modern grant's stream and upstream process", async ({
  signal,
}) => {
  const server = await fixture("modern");
  const route = server.register();
  const grant = await server.grant();
  const consumer = await connect({ url: route.url, grant, mode: "auto" });
  const pid = toolPayload(
    await consumer.client.callTool({ name: "inspect.raw", arguments: {} }),
  ).pid;
  const subscription = await consumer.client.listen({ resourceSubscriptions: ["fixture://note"] });
  try {
    revokeMcpLoopbackClientGrant(grant.token);
    expect(await withinTest(subscription.closed, signal)).not.toBe("local");
    await withinTest(harness.receipts.waitForExit(server.file + ":" + pid), signal);
    // The child's exit notification precedes OS reclamation; join the retiring owner.
    await withinTest(closeNativeMcpProjections(), signal);
    expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
    await expect(
      consumer.client.callTool({ name: "inspect.raw", arguments: {} }),
    ).rejects.toThrow();
    const next = await connect({
      url: server.register().url,
      grant: await server.grant(),
      mode: "auto",
    });
    expect(
      toolPayload(await next.client.callTool({ name: "inspect.raw", arguments: {} })).pid,
    ).not.toBe(pid);
  } finally {
    await subscription.close();
  }
});
