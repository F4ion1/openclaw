import type { AsyncLocalStorage } from "node:async_hooks";
import type { ServerResponse } from "node:http";
import type {
  CallToolResult,
  ClientCapabilities,
  GetPromptResult,
  ReadResourceResult,
  SetLevelRequestParams,
  SubscribeRequestParams,
} from "@modelcontextprotocol/client";
import type { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import type { createMcpHandler, Server, ServerContext } from "@modelcontextprotocol/server";
import type { SessionMcpRuntime } from "../agents/agent-bundle-mcp-types.js";
import type { prepareNativeMcpPolicy } from "../agents/native-mcp-policy.js";
import type {
  NativeMcpPreparationContext,
  NativeMcpRequestOptions,
  NativeMcpResponse,
  NativeMcpServerPreparation,
  NativeMcpServerView,
} from "../agents/native-mcp-runtime.js";
import type { markMcpLoopbackToolCallStarted } from "./mcp-http.loopback-runtime.js";

export type Policy = Omit<Parameters<typeof prepareNativeMcpPolicy>[0], "runtime" | "catalog">;
export type Authority = {
  assertCurrent: () => void;
  isCurrent: () => boolean;
  signal: AbortSignal;
  captureKey: string;
  grantToken: string;
};
export type Exchange = {
  server: Server;
  authority: Authority;
  requestId?: ServerContext["mcpReq"]["id"];
  notify?: ServerContext["mcpReq"]["notify"];
};
export type Connection = {
  capabilities: ClientCapabilities;
  grantToken: string;
  grant: { isCurrent: () => boolean };
  authority: AsyncLocalStorage<Authority>;
  context: NativeMcpPreparationContext;
  preparing: Promise<NativeMcpServerPreparation>;
  view?: NativeMcpServerView;
  binding?: Promise<NativeMcpServerView>;
  exchanges: Set<Exchange>;
  responses: Set<ServerResponse>;
  resourceResponses: Map<ServerResponse, ReadonlySet<string>>;
  catalogResponses: Set<ServerResponse>;
  continuations: {
    tools: Map<string, Continuation<CallToolResult>>;
    resources: Map<string, Continuation<ReadResourceResult>>;
    prompts: Map<string, Continuation<GetPromptResult>>;
  };
  legacy?: {
    server: Server;
    transport: NodeStreamableHTTPServerTransport;
    operations: Promise<void>;
    rootsKey?: string;
    subscriptions: Map<string, SubscribeRequestParams>;
    logging?: SetLevelRequestParams;
  };
  modern?: ReturnType<typeof createMcpHandler>;
  unsubscribe?: () => void;
  unsubscribeGrant?: () => void;
  closed: boolean;
  close: () => Promise<void>;
};
export type Projection = {
  path: string;
  runtime: SessionMcpRuntime;
  serverName: string;
  registration?: { policy: Policy };
  connections: Set<Connection>;
  modernConnections: Map<string, Connection>;
  closed: boolean;
  close: () => Promise<void>;
};

export type ToolCapture = {
  handle: ReturnType<typeof markMcpLoopbackToolCallStarted>;
  toolName: string;
  args: Record<string, unknown>;
};
export type Continuation<T> = {
  signature: string;
  captureKey: string;
  resume: (
    responses: Record<string, unknown>,
    options: NativeMcpRequestOptions,
  ) => Promise<NativeMcpResponse<T>>;
  capture?: ToolCapture;
};
