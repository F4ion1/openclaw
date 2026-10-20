import { createRequesterMcpConnect } from "./agent-bundle-mcp-requester-connect.js";
import type { SessionMcpRuntime } from "./agent-bundle-mcp-types.js";

type Requester = { sessionId: string; requesterSenderId: string };

export function makeRuntime(params: Requester): SessionMcpRuntime {
  const serverName = "user-mail";
  const catalog = {
    version: 1,
    generatedAt: 0,
    servers: { [serverName]: { serverName, launchSummary: serverName, toolCount: 1 } },
    tools: [
      {
        serverName,
        safeServerName: serverName,
        toolName: "inbox",
        description: "read inbox",
        inputSchema: { type: "object", properties: {} },
        fallbackDescription: "read inbox",
      },
    ],
  };
  let lastUsedAt = Date.now();
  const leases = new Set<symbol>();
  return {
    sessionId: params.sessionId,
    workspaceDir: "/workspace",
    configFingerprint: "fp",
    requesterScope: { requesterSenderId: params.requesterSenderId },
    createdAt: Date.now(),
    get lastUsedAt() {
      return lastUsedAt;
    },
    get activeLeases() {
      return leases.size;
    },
    acquireLease: () => {
      const lease = Symbol("mcp-test-lease");
      leases.add(lease);
      return () => {
        leases.delete(lease);
      };
    },
    markUsed: () => {
      lastUsedAt = Date.now();
    },
    peekCatalog: () => catalog,
    getCatalog: async () => catalog,
    callTool: async (_server, toolName) => ({
      content: [{ type: "text", text: `live:${toolName}:${params.requesterSenderId}` }],
      isError: false,
    }),
    dispose: async () => {},
  };
}

export async function makeConnectRuntime(
  params: Requester & { publicOrigin?: string },
): Promise<SessionMcpRuntime> {
  const runtime = makeRuntime(params);
  const catalog = { version: 1, generatedAt: 0, servers: {}, tools: [] };
  runtime.peekCatalog = () => catalog;
  runtime.getCatalog = async () => catalog;
  runtime.requesterConnect = await createRequesterMcpConnect({
    serverNames: new Set(["calendar"]),
    mcpServers: {
      calendar: {
        url: "https://mcp.example/rpc",
        auth: "oauth",
        oauth: { identity: "per-requester" },
      },
    },
    safeServerNamesByServer: new Map([["calendar", "calendar"]]),
    requesterScope: {
      requesterSenderId: params.requesterSenderId,
      messageChannel: "telegram",
      agentAccountId: "bot",
    },
    cfg: params.publicOrigin ? { gateway: { publicOrigin: params.publicOrigin } } : undefined,
    configFingerprint: "connect-fingerprint",
  });
  return runtime;
}
