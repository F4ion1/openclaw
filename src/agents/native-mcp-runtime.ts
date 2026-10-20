import type {
  CallToolRequestParams,
  CallToolResult,
  ClientCapabilities,
  CompleteRequestParams,
  CompleteResult,
  CreateMessageRequestParams,
  CreateMessageResult,
  CreateMessageResultWithTools,
  ElicitRequestParams,
  ElicitResult,
  EmptyResult,
  GetPromptRequestParams,
  GetPromptResult,
  InputRequiredResult,
  ListPromptsResult,
  ListResourceTemplatesResult,
  ListResourcesResult,
  ListRootsResult,
  ListToolsResult,
  PaginatedRequestParams,
  ReadResourceRequestParams,
  ReadResourceResult,
  RequestOptions,
  ServerNotification,
  SetLevelRequestParams,
  SubscribeRequestParams,
  UnsubscribeRequestParams,
} from "@modelcontextprotocol/client";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { McpToolCatalog, SessionMcpRuntime } from "./agent-bundle-mcp-types.js";
import type { McpElicitationHandler } from "./mcp-client-elicitation.js";

type NativeMcpCallbackOptions = { signal: AbortSignal };
export type NativeMcpClientContext = {
  /** Identity of the native client's capability lifecycle, shared by identical snapshots. */
  readonly capabilityContext: object;
  readonly capabilities: ClientCapabilities;
  /** Immutable owner snapshot; changed roots require acquiring a new view. */
  readonly roots: ListRootsResult;
  assertCurrent: () => void;
  elicit?: (
    params: ElicitRequestParams,
    options: NativeMcpCallbackOptions,
  ) => Promise<ElicitResult>;
  elicitCustom?: (
    params: Record<string, unknown>,
    options: NativeMcpCallbackOptions,
  ) => ReturnType<McpElicitationHandler>;
  createMessage?: (
    params: CreateMessageRequestParams,
    options: NativeMcpCallbackOptions,
  ) => Promise<CreateMessageResult | CreateMessageResultWithTools>;
};

export type NativeMcpPreparationContext = Omit<NativeMcpClientContext, "roots">;
/** Modern roots travel in request continuations; legacy roots are an immutable snapshot. */
export type NativeMcpRuntimeContext = NativeMcpPreparationContext & {
  readonly roots?: ListRootsResult;
};

export type NativeMcpServerPreparation =
  | {
      readonly era: "legacy";
      bind: (roots: ListRootsResult) => Promise<NativeMcpServerView>;
      release: () => Promise<void>;
    }
  | {
      readonly era: "modern";
      bind: () => Promise<NativeMcpServerView>;
      release: () => Promise<void>;
    };

export type NativeMcpRequestOptions = NativeMcpCallbackOptions & {
  assertCurrent: () => void;
  onprogress?: RequestOptions["onprogress"];
};

/** The continuation closes over the originating view and request, never a client-supplied id. */
export type NativeMcpResponse<T> =
  | { kind: "complete"; result: T }
  | {
      kind: "input-required";
      result: InputRequiredResult;
      resume: (
        responses: Record<string, unknown>,
        options: NativeMcpRequestOptions,
      ) => Promise<NativeMcpResponse<T>>;
    };

export type NativeMcpServerEvent =
  | { kind: "notification"; notification: ServerNotification }
  | { kind: "resource-subscription-ended"; uri: string }
  | { kind: "catalog-subscription-ended" }
  | { kind: "closed" };

type Page<P, R> = (params: P, options: NativeMcpRequestOptions) => Promise<R>;
type Flow<P, R> = Page<P, NativeMcpResponse<R>>;

/** Internal projection preparation only; intentionally absent from plugin SDK barrels. */
export type NativeMcpServerView = {
  runtime: SessionMcpRuntime;
  getServerInfo: import("@modelcontextprotocol/client").Client["getServerVersion"];
  getCapabilities: import("@modelcontextprotocol/client").Client["getServerCapabilities"];
  getInstructions: import("@modelcontextprotocol/client").Client["getInstructions"];
  getProtocolEra: import("@modelcontextprotocol/client").Client["getProtocolEra"];
  getProtocolVersion: import("@modelcontextprotocol/client").Client["getNegotiatedProtocolVersion"];
  listTools: Page<PaginatedRequestParams | undefined, ListToolsResult>;
  listResources: Page<PaginatedRequestParams | undefined, ListResourcesResult>;
  listResourceTemplates: Page<PaginatedRequestParams | undefined, ListResourceTemplatesResult>;
  listPrompts: Page<PaginatedRequestParams | undefined, ListPromptsResult>;
  callTool: Flow<CallToolRequestParams, CallToolResult>;
  readResource: Flow<ReadResourceRequestParams, ReadResourceResult>;
  getPrompt: Flow<GetPromptRequestParams, GetPromptResult>;
  complete: Page<CompleteRequestParams, CompleteResult>;
  acquireResourceSubscription: Page<SubscribeRequestParams, { release: () => Promise<void> }>;
  subscribeResource: Page<SubscribeRequestParams, EmptyResult>;
  unsubscribeResource: Page<UnsubscribeRequestParams, EmptyResult>;
  setLoggingLevel: Page<SetLevelRequestParams, EmptyResult>;
  /** Announces this snapshot; a different roots snapshot belongs to a new acquisition. */
  rootsChanged: (options: NativeMcpRequestOptions) => Promise<void>;
  subscribe: (listener: (event: NativeMcpServerEvent) => void) => () => void;
  release: () => Promise<void>;
};

export type NativeMcpRuntimeBinding = {
  hasServer: (serverName: string) => boolean;
  getCatalog: (serverName: string) => Promise<McpToolCatalog>;
  prepare: (
    serverName: string,
    context: NativeMcpPreparationContext,
    options?: { negotiation: "auto" | "legacy" },
  ) => Promise<NativeMcpServerPreparation>;
};

// A binding exposes operations; the session runtime remains the only transport/lifecycle owner.
export const nativeMcpRuntimeBindings = resolveGlobalSingleton(
  Symbol.for("openclaw.nativeMcpRuntimeBindings"),
  () => new WeakMap<SessionMcpRuntime, NativeMcpRuntimeBinding>(),
);

export async function getNativeMcpServerCatalog(
  runtime: SessionMcpRuntime,
  serverName: string,
): Promise<McpToolCatalog> {
  const binding = nativeMcpRuntimeBindings.get(runtime);
  if (!binding) {
    throw new Error("MCP runtime has no projection binding");
  }
  return binding.getCatalog(serverName);
}

export async function prepareNativeMcpServer(
  runtime: SessionMcpRuntime,
  serverName: string,
  context: NativeMcpPreparationContext,
  options?: { negotiation: "auto" | "legacy" },
): Promise<NativeMcpServerPreparation> {
  context.assertCurrent();
  const binding = nativeMcpRuntimeBindings.get(runtime);
  if (!binding) {
    throw new Error("MCP runtime has no projection binding");
  }
  // Project only preparation fields: structurally compatible callers may still carry roots.
  const preparation = await binding.prepare(
    serverName,
    {
      capabilityContext: context.capabilityContext,
      capabilities: context.capabilities,
      assertCurrent: () => context.assertCurrent(),
      ...(context.elicit ? { elicit: context.elicit } : {}),
      ...(context.elicitCustom ? { elicitCustom: context.elicitCustom } : {}),
      ...(context.createMessage ? { createMessage: context.createMessage } : {}),
    },
    options,
  );
  try {
    context.assertCurrent();
    return preparation;
  } catch (error) {
    await preparation.release();
    throw error;
  }
}

export async function acquireNativeMcpServer(
  runtime: SessionMcpRuntime,
  serverName: string,
  context: NativeMcpClientContext,
): Promise<NativeMcpServerView> {
  const preparation = await prepareNativeMcpServer(runtime, serverName, context);
  try {
    return await (preparation.era === "legacy"
      ? preparation.bind(context.roots)
      : preparation.bind());
  } finally {
    await preparation.release();
  }
}
