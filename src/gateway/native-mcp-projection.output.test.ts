import { expect, it } from "vitest";
import { withinTest } from "../../test/helpers/promise.js";
import { createProjectionHarness } from "./native-mcp-projection.test-harness.js";
import {
  catalogSubscriptionIds,
  resourceSubscriptionIds,
  toolPayload,
} from "./native-mcp-projection.test-support.js";

const harness = createProjectionHarness();
const { fixture, connect, connectDirect } = harness;

it.for([
  { era: "legacy", shape: "scalar" },
  { era: "legacy", shape: "reference" },
  { era: "modern", shape: "scalar" },
  { era: "modern", shape: "reference" },
] as const)(
  "preserves $era output-schema and result parity for a $shape root",
  async ({ era, shape }) => {
    const server = await fixture(era, { output: shape });
    const mode = era === "legacy" ? "legacy" : "auto";
    const direct = await connectDirect(server.file, mode);
    const projected = (
      await connect({ url: server.register().url, grant: await server.grant(), mode })
    ).client;
    const schemas = await Promise.all(
      [direct, projected].map(async (client) => {
        const page = await client.request({ method: "tools/list" });
        return page.tools[0]?.outputSchema;
      }),
    );
    expect(schemas[1]).toEqual(schemas[0]);
    if (era === "legacy") {
      expect(schemas[0]).toMatchObject({ type: "object", required: ["result"] });
      if (shape === "reference") {
        expect(schemas[0]).toMatchObject({
          properties: { result: { $ref: "#/properties/result/$defs/payload" } },
        });
      }
    } else if (shape === "scalar") {
      expect(schemas[0]).toEqual({ type: "number" });
    } else {
      expect(schemas[0]).toMatchObject({ $ref: "#/$defs/payload" });
    }
    const results = await Promise.all(
      [direct, projected].map((client) => client.callTool({ name: "inspect.raw", arguments: {} })),
    );
    const natural = shape === "scalar" ? 7 : { count: 7 };
    const expected = era === "legacy" ? { result: natural } : natural;
    for (const result of results) {
      expect(result.structuredContent).toEqual(expected);
      expect(result.content).toEqual(shape === "scalar" ? [{ type: "text", text: "7" }] : []);
      expect(result._meta).toMatchObject({ fixture: "output" });
    }
  },
);

it("ends only the affected subscription stream while retaining calls and unrelated streams", async ({
  signal,
}) => {
  const server = await fixture("modern");
  const client = (
    await connect({ url: server.register().url, grant: await server.grant(), mode: "auto" })
  ).client;
  const pid = toolPayload(
    await client.callTool({ name: "inspect.raw", arguments: { operation: "notify" } }),
  ).pid;
  const subscription = await client.listen({ resourceSubscriptions: ["fixture://note"] });
  const otherResource = await client.listen({ resourceSubscriptions: ["fixture://other"] });
  let catalog = await client.listen({ toolsListChanged: true });
  expect(resourceSubscriptionIds(await server.log(), "fixture://note")).toHaveLength(1);
  try {
    const ended = await client.callTool({
      name: "inspect.raw",
      arguments: { operation: "end-resource" },
    });
    expect(ended.isError).not.toBe(true);
    expect(toolPayload(ended).pid).toBe(pid);
    const reason = await withinTest(subscription.closed, signal);
    expect(reason).not.toBe("local");
    expect(await server.log()).toContain("resource stream ended");

    const changed = Promise.withResolvers<void>();
    client.setNotificationHandler("notifications/tools/list_changed", () => changed.resolve());
    expect(
      toolPayload(
        await client.callTool({ name: "inspect.raw", arguments: { operation: "notify" } }),
      ).pid,
    ).toBe(pid);
    await withinTest(changed.promise, signal);

    const catalogStarts = catalogSubscriptionIds(await server.log()).length;
    const endedCatalog = await client.callTool({
      name: "inspect.raw",
      arguments: { operation: "end-catalog" },
    });
    expect(endedCatalog.isError).not.toBe(true);
    expect(toolPayload(endedCatalog).pid).toBe(pid);
    expect(await withinTest(catalog.closed, signal)).not.toBe("local");
    catalog = await client.listen({ toolsListChanged: true });
    expect(catalogSubscriptionIds(await server.log())).toHaveLength(catalogStarts + 1);

    const resumedChange = Promise.withResolvers<void>();
    client.setNotificationHandler("notifications/tools/list_changed", () =>
      resumedChange.resolve(),
    );
    expect(
      toolPayload(
        await client.callTool({ name: "inspect.raw", arguments: { operation: "notify" } }),
      ).pid,
    ).toBe(pid);
    await withinTest(resumedChange.promise, signal);

    const updated = Promise.withResolvers<string>();
    client.setNotificationHandler("notifications/resources/updated", (notification) => {
      updated.resolve(notification.params.uri);
    });
    const publication = client.callTool({
      name: "inspect.raw",
      arguments: { operation: "publish-resource", uri: "fixture://other" },
    });
    void publication.catch(() => {});
    try {
      await withinTest(
        harness.receipts.waitFor(server.file, "publication ready publish-resource"),
        signal,
      );
      harness.receipts.release(server.file, "publish-resource");
      expect(await withinTest(updated.promise, signal)).toBe("fixture://other");
      harness.receipts.release(server.file, "publish-resource-observed");
      expect(toolPayload(await publication).pid).toBe(pid);
    } finally {
      harness.receipts.release(server.file, "publish-resource");
      harness.receipts.release(server.file, "publish-resource-observed");
      await publication.catch(() => {});
    }
  } finally {
    await Promise.all([subscription.close(), otherResource.close(), catalog.close()]);
  }
});
