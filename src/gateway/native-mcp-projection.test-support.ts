import fs from "node:fs/promises";
import {
  Client,
  type ListRootsResult,
  type ClientCapabilities,
} from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { fixtureReceiptClientSource } from "../../test/helpers/fixture-receipts.js";
import { writeNativeMcpFixture } from "../agents/native-mcp-runtime.test-support.js";

export type ProjectionFixtureOptions = {
  inventory?: "collision" | "resources" | "prompts";
  output?: "scalar" | "reference";
};

export async function writeProjectionFixture(
  file: string,
  endpoint: string,
  era: "legacy" | "modern" | "dual",
  options: ProjectionFixtureOptions = {},
) {
  if (options.output) {
    await writeOutputFixture(file, endpoint, options.output);
    return;
  }
  await writeNativeMcpFixture(file, endpoint, era === "dual" ? "modern" : era);
  // This server deliberately uses a raw name distinct from its OpenClaw policy identity.
  const source = await fs.readFile(file, "utf8");
  await fs.writeFile(
    file,
    source
      .replace('name: "probe", title:', 'name: "inspect.raw", title:')
      .replace(
        'inputSchema: { type: "object", properties: {} },',
        'inputSchema: { type: "object", properties: {} }, outputSchema: { type: "object", properties: { count: { type: "number" } }, required: ["count"] },',
      )
      .replace(
        'return { content: [{ type: "text", text: JSON.stringify(value) }], _meta: metadata };',
        'return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: { count: 7 }, _meta: metadata };',
      )
      .replace("const { serveStdio } =", "const { serveStdio, StdioServerTransport } =")
      .replace(
        "serveStdio(() => {",
        `const subscriptionStreams = new Map();
        const transport = new StdioServerTransport();
        const start = transport.start.bind(transport);
        transport.start = async () => {
          const receive = transport.onmessage;
          transport.onmessage = (message, extra) => {
            if (message.method === "subscriptions/listen") {
              record("wire listen " + JSON.stringify({ id: message.id, notifications: message.params.notifications }));
              subscriptionStreams.set(message.id, message.params.notifications);
            }
            if (message.method === "notifications/cancelled") record("wire cancel " + message.params.requestId);
            receive?.(message, extra);
          };
          await start();
        };
        serveStdio(({ era: servingEra }) => {`,
      )
      .replace(
        "resources: {}, prompts: {}, completions: {}",
        "resources: { subscribe: true }, prompts: {}, completions: {}",
      )
      .replace(
        "if (!ctx.mcpReq.inputResponses)",
        `if (["end-resource", "end-catalog"].includes(request.params.arguments?.operation)) return (async () => {
          const operation = request.params.arguments.operation;
          const uri = request.params.arguments.uri ?? "fixture://note";
          for (const [id, filter] of subscriptionStreams) {
            const matches = operation === "end-resource"
              ? filter.resourceSubscriptions?.includes(uri)
              : filter.toolsListChanged || filter.resourcesListChanged || filter.promptsListChanged;
            if (!matches) continue;
            await transport.send({ jsonrpc: "2.0", id, result: { resultType: "complete" } });
            subscriptionStreams.delete(id);
          }
          record(operation === "end-resource" ? "resource stream ended" : "catalog stream ended");
          return result({ pid: process.pid });
        })(); if (["elicit", "url"].includes(request.params.arguments?.operation)) {
          const operation = request.params.arguments.operation;
          if (ctx.mcpReq.inputResponses) return result({ pid: process.pid, responses: ctx.mcpReq.inputResponses });
          return { resultType: "input_required", requestState: "elicitation-state", _meta: metadata, inputRequests: { answer: { method: "elicitation/create", params: operation === "url" ? { mode: "url", url: "https://example.invalid/authorize", elicitationId: "fixture-url", message: "Authorize the fixture" } : { mode: "form", message: "Choose", requestedSchema: { type: "object", properties: { choice: { type: "string" } } } } } } };
        } if (["publish-resource", "publish-tools"].includes(request.params.arguments?.operation)) return (async () => {
          const operation = request.params.arguments.operation;
          record("publication ready " + operation);
          await awaitRelease(source, operation);
          await server.notification(operation === "publish-resource"
            ? { method: "notifications/resources/updated", params: { uri: request.params.arguments.uri ?? "fixture://note" } }
            : { method: "notifications/tools/list_changed", params: { _meta: metadata } });
          record("publication sent " + operation);
          await awaitRelease(source, operation + "-observed");
          return result({ pid: process.pid });
        })(); if (request.params.arguments?.operation === "notify") return server.sendToolListChanged().then(() => result({ pid: process.pid })); if (servingEra === "legacy") return result({ pid: process.pid }); if (!ctx.mcpReq.inputResponses)`,
      )
      .replace(
        '{ legacy: "reject" }',
        `{ legacy: "${era === "dual" ? "serve" : "reject"}", transport }`,
      )
      .replace(
        '} else if (message.method === "tools/call") {',
        '} else if (message.method === "tools/call") { record("call " + params.name);',
      )
      .replace('if (params.name === "hold")', 'if (params.arguments?.operation === "hold")')
      .replace('params.name === "crash"', 'params.arguments?.operation === "crash"')
      .replace('params.name === "elicit"', 'params.arguments?.operation === "elicit"')
      .replace('params.name === "url"', 'params.arguments?.operation === "url"')
      .replace('params.name === "completeUrl"', 'params.arguments?.operation === "completeUrl"')
      .replace('params.name === "elicitCustom"', 'params.arguments?.operation === "elicitCustom"')
      .replace("let value;", "let value; let finalProgress;")
      .replace(
        'record("finished " + releaseToken);',
        'record("finished " + releaseToken); finalProgress = { jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: params._meta.progressToken, progress: 2, total: 2, message: "finished" } };',
      )
      .replace(
        "send({ id: message.id, result: value });",
        'if (finalProgress) process.stdout.write(JSON.stringify(finalProgress) + "\\n" + JSON.stringify({ jsonrpc: "2.0", id: message.id, result: value }) + "\\n"); else send({ id: message.id, result: value });',
      )
      .replace(
        'text: "Catalog request" } }], maxTokens: 1',
        'text: "Catalog request" } }], tools: [{ name: "catalog-tool", inputSchema: { type: "object" } }], maxTokens: 1',
      )
      .replace(
        'record("listed sample " + sample.content.text);',
        'record("listed sample " + JSON.stringify(sample));',
      )
      .replace(
        "let urlElicitationId;",
        "let urlElicitationId; let resourceSubscribed = false; let loggingEnabled = false;",
      )
      .replace(
        "resources: { listChanged: true }, prompts:",
        "resources: { listChanged: true, subscribe: true }, prompts:",
      )
      .replace(
        '} else if (message.method === "resources/read") {',
        '} else if (message.method === "resources/subscribe") { resourceSubscribed = true; value = {}; } else if (message.method === "resources/unsubscribe") { resourceSubscribed = false; value = {}; } else if (message.method === "logging/setLevel") { loggingEnabled = true; value = {}; } else if (message.method === "resources/read") {',
      )
      .replace(
        'if (params.name === "notify") {',
        'if (params.arguments?.operation === "notify") { if (params.arguments?.releaseToken) { record("notification waiting"); await awaitRelease(source, params.arguments.releaseToken); } if (resourceSubscribed) send({ method: "notifications/resources/updated", params: { uri: "fixture://note", _meta: metadata } }); if (loggingEnabled) send({ method: "notifications/message", params: { level: "info", data: { message: "resource refreshed" }, _meta: metadata } });',
      )
      .replace(
        'send({ method: "notifications/message", params: { level: "info", data: "request-local" } });',
        "",
      ),
  );
  if (options.inventory) {
    let altered = await fs.readFile(file, "utf8");
    if (options.inventory === "collision") {
      altered = altered.replace(
        "[{ ...tool, description: JSON.stringify({ roots, capabilities }) }]",
        '[{ ...tool, description: "First raw name" }, { ...tool, name: "inspect/raw", description: "Second raw name" }]',
      );
    } else {
      altered = altered.replaceAll("tools: { listChanged: true }, ", "");
      altered =
        options.inventory === "resources"
          ? altered.replaceAll("prompts: { listChanged: true }, ", "")
          : altered.replaceAll("resources: { listChanged: true, subscribe: true }, ", "");
      altered = altered.replace(
        'record("recv " + message.method);',
        'record("recv " + message.method); if (message.method === "tools/list") { send({ id: message.id, error: { code: -32601, message: "Method not found" } }); return; }',
      );
    }
    await fs.writeFile(file, altered);
  }
}

export async function connectDirect(
  file: string,
  clients: Client[],
  mode: "auto" | "legacy" = "auto",
  capabilities: ClientCapabilities = {},
  supportedProtocolVersions?: string[],
) {
  const client = new Client(
    { name: "direct-notification-control", version: "1" },
    {
      capabilities,
      versionNegotiation: { mode },
      supportedProtocolVersions,
    },
  );
  clients.push(client);
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [file] }));
  return client;
}

export function toolPayload(value: Awaited<ReturnType<Client["callTool"]>>) {
  const content = value.content[0];
  if (content?.type !== "text") {
    throw new Error("Expected fixture text result");
  }
  return JSON.parse(content.text) as {
    pid: number;
    roots?: ListRootsResult;
    responses?: { roots: ListRootsResult };
  };
}

function recordedSubscriptions(log: string[]) {
  return log
    .filter((line) => line.startsWith("wire listen "))
    .map(
      (line) =>
        JSON.parse(line.slice("wire listen ".length)) as {
          id: number;
          notifications: {
            resourceSubscriptions?: string[];
            toolsListChanged?: boolean;
            resourcesListChanged?: boolean;
            promptsListChanged?: boolean;
          };
        },
    );
}

export function resourceSubscriptionIds(log: string[], uri: string): number[] {
  return recordedSubscriptions(log)
    .filter((listen) => listen.notifications.resourceSubscriptions?.includes(uri))
    .map((listen) => listen.id);
}

export function catalogSubscriptionIds(log: string[]): number[] {
  return recordedSubscriptions(log)
    .filter(
      ({ notifications }) =>
        notifications.toolsListChanged ||
        notifications.resourcesListChanged ||
        notifications.promptsListChanged,
    )
    .map((listen) => listen.id);
}

async function writeOutputFixture(file: string, endpoint: string, shape: "scalar" | "reference") {
  const schema =
    shape === "scalar"
      ? { type: "number" }
      : {
          $ref: "#/$defs/payload",
          $defs: {
            payload: {
              type: "object",
              properties: { count: { type: "number" } },
              required: ["count"],
            },
          },
        };
  const value = shape === "scalar" ? 7 : { count: 7 };
  await fs.writeFile(
    file,
    `import { appendFileSync } from "node:fs";
${fixtureReceiptClientSource(endpoint)}
import { Server } from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/server"))};
import { serveStdio } from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/server/stdio"))};
const source = ${JSON.stringify(file)};
announce(source + ":" + process.pid);
appendFileSync(source + ".log", "started " + process.pid + "\\n");
const schema = ${JSON.stringify(schema)};
serveStdio(() => {
  const server = new Server({ name: "output-fixture", version: "1" }, { capabilities: { tools: {} } });
  server.setRequestHandler("tools/list", () => ({ tools: [{ name: "inspect.raw", inputSchema: { type: "object" }, outputSchema: schema }] }));
  server.setRequestHandler("tools/call", () => server.projectCallToolResult({ content: [], structuredContent: ${JSON.stringify(value)}, _meta: { fixture: "output" } }, schema));
  return server;
});
`,
  );
}
