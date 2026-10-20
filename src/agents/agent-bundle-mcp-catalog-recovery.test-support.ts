import { once } from "node:events";
import http, { type ServerResponse } from "node:http";
import {
  closeHttpServer,
  readRequestText,
  respondJson,
} from "../../test/helpers/gateway-integration-fixtures.js";
import { createDeferred } from "../../test/helpers/promise.js";
import { acquireTestPortBlock } from "../test-utils/port-claims.js";

function reply(res: ServerResponse, id: string | number, session: string, result: unknown) {
  res.setHeader("mcp-session-id", session);
  respondJson(res, { jsonrpc: "2.0", id, result });
}

const tools = (sessionId: string) => ({
  tools: [
    {
      name: "probe",
      inputSchema: { type: "object" },
      outputSchema: {
        type: "object",
        properties: { revision: { const: sessionId } },
        required: ["revision"],
      },
    },
  ],
});

export async function startCatalogRecoveryMcpServer(
  label: string,
  options: { holdTermination?: Promise<void> } = {},
) {
  const terminationStarted = createDeferred();
  let terminationCount = 0;
  let sessionGeneration = 0;
  let listCount = 0;
  let maxActiveLists = 0;
  let hangCalls = true;
  let callReceived = createDeferred();
  const recoveryListStarted = createDeferred();
  const pendingLists: Array<{
    id: string | number;
    response: ServerResponse;
    sessionId: string;
  }> = [];
  const server = http.createServer(async (request, response) => {
    if (request.method === "DELETE") {
      terminationCount += 1;
      terminationStarted.resolve();
      if (options.holdTermination) {
        void options.holdTermination.then(
          () => response.writeHead(204).end(),
          () => response.writeHead(500).end(),
        );
      } else {
        response.writeHead(204).end();
      }
      return;
    }
    if (request.method !== "POST") {
      response.writeHead(405).end();
      return;
    }
    const message = JSON.parse(await readRequestText(request)) as {
      id: string | number;
      method: string;
      params?: { protocolVersion?: string };
    };
    if (message.method === "initialize") {
      sessionGeneration += 1;
      const sessionId = `${label}-${sessionGeneration}`;
      reply(response, message.id, sessionId, {
        protocolVersion: message.params?.protocolVersion ?? "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: label, version: "1.0.0" },
      });
      return;
    }
    if (message.method === "notifications/initialized") {
      response.writeHead(202).end();
      return;
    }
    const rawSessionId = request.headers["mcp-session-id"];
    const sessionId = typeof rawSessionId === "string" ? rawSessionId : "missing";
    if (message.method === "tools/call") {
      callReceived.resolve();
      callReceived = createDeferred();
      if (hangCalls) {
        return;
      }
      reply(response, message.id, sessionId, {
        content: [],
        structuredContent: { revision: sessionId },
      });
      return;
    }
    if (message.method === "tools/list") {
      listCount += 1;
      if (listCount === 1) {
        reply(response, message.id, sessionId, tools(sessionId));
        return;
      }
      pendingLists.push({ id: message.id, response, sessionId });
      maxActiveLists = Math.max(maxActiveLists, pendingLists.length);
      recoveryListStarted.resolve();
    }
  });
  const portClaim = await acquireTestPortBlock({ offsets: [0] });
  try {
    await once(server.listen(portClaim.port, "127.0.0.1"), "listening");
  } catch (error) {
    await portClaim.release();
    throw error;
  }
  return {
    url: `http://127.0.0.1:${portClaim.port}/mcp`,
    terminationStarted: terminationStarted.promise,
    terminationCount: () => terminationCount,
    nextCall: () => callReceived.promise,
    recoveryListStarted: recoveryListStarted.promise,
    maxActiveLists: () => maxActiveLists,
    allowCalls: () => {
      hangCalls = false;
    },
    releaseLists: () => {
      for (const pending of pendingLists.splice(0)) {
        reply(pending.response, pending.id, pending.sessionId, tools(pending.sessionId));
      }
    },
    close: async () => {
      try {
        await closeHttpServer(server);
      } finally {
        await portClaim.release();
      }
    },
  };
}
