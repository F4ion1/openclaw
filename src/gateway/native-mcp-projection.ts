import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  CallToolResult,
  GetPromptResult,
  ReadResourceResult,
  ClientCapabilities,
  SetLevelRequestParams,
  SubscribeRequestParams,
} from "@modelcontextprotocol/client";
import {
  ClientCapabilitiesSchema,
  SubscriptionsListenRequestParamsSchema,
} from "@modelcontextprotocol/core";
import { NodeStreamableHTTPServerTransport, toNodeHandler } from "@modelcontextprotocol/node";
import {
  CLIENT_CAPABILITIES_META_KEY,
  createMcpHandler,
  ProtocolError,
  ProtocolErrorCode,
  Server,
  type ServerContext,
} from "@modelcontextprotocol/server";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { stableStringify } from "@openclaw/normalization-core/stable-stringify";
import type { SessionMcpRuntime } from "../agents/agent-bundle-mcp-types.js";
import { redactMcpDiagnosticError } from "../agents/mcp-error.js";
import type { prepareNativeMcpPolicy } from "../agents/native-mcp-policy.js";
import {
  prepareNativeMcpServer,
  nativeMcpRuntimeBindings,
  type NativeMcpPreparationContext,
  type NativeMcpServerPreparation,
  type NativeMcpServerView,
} from "../agents/native-mcp-runtime.js";
import { resolveRequesterPrincipalKey } from "../agents/requester-origin.js";
import { sha256Hex } from "../infra/crypto-digest.js";
import { readRequestBodyWithLimit } from "../infra/http-body.js";
import { writeJsonWithoutCharset } from "../infra/http-json.js";
import { createHttpRequestAbortSignal } from "../infra/http-request-lifecycle.js";
import type { BundleMcpServerConfig } from "../plugins/bundle-mcp.types.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { registerMcpLoopbackClientGrantRevocationListener } from "./mcp-grant-store.js";
import {
  getActiveMcpLoopbackRuntime,
  markMcpLoopbackRequestStarted,
  markMcpLoopbackRequestClassified,
  markMcpLoopbackRequestFinished,
} from "./mcp-http.loopback-runtime.js";
import { validateMcpLoopbackRequest, resolveMcpHttpBodyTimeoutMs } from "./mcp-http.request.js";
import {
  attachProjectionView,
  clearContinuations,
  queueLegacyProjectionOperation,
  refreshLegacyProjectionView,
  createProjectionClientContext,
  installHandlers,
  settleProjectionExchanges,
  type Continuation,
} from "./native-mcp-projection-requests.js";
import type { GatewayConnectionWork } from "./server-connection-work.js";

type Policy = Omit<Parameters<typeof prepareNativeMcpPolicy>[0], "runtime" | "catalog">;
type Authority = {
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

const projectionOwner = resolveGlobalSingleton(
  Symbol.for("openclaw.nativeMcpProjections"),
  () => ({ entries: new Map<string, Projection>(), closing: new Set<Promise<void>>() }),
  () => closeNativeMcpProjections(),
);

export function registerNativeMcpProjection(params: {
  runtime: SessionMcpRuntime;
  serverName: string;
  definition: BundleMcpServerConfig;
  policy: Policy;
}): { url: string; close: () => Promise<void> } {
  if (!nativeMcpRuntimeBindings.get(params.runtime)?.hasServer(params.serverName)) {
    throw new Error("Native MCP server is not enabled in this runtime");
  }
  const listener = getActiveMcpLoopbackRuntime();
  if (!listener) {
    throw new Error("Native MCP projection requires the Gateway loopback listener");
  }
  const route = `/mcp/native/${sha256Hex(
    stableStringify({
      sessionId: params.runtime.sessionId,
      requesterScope: params.runtime.requesterScope,
      requesterPrincipal: resolveRequesterPrincipalKey({
        requesterOrigin: params.policy.capabilityProfile.requesterOrigin,
      }),
      serverName: params.serverName,
      definition: params.definition,
    }),
  )}`;
  let entry = projectionOwner.entries.get(route);
  if (entry && entry.runtime !== params.runtime) {
    void entry
      .close()
      .catch((error: unknown) =>
        params.policy.warn(
          `bundle MCP projection cleanup failed: ${redactMcpDiagnosticError(error)}`,
        ),
      );
    entry = undefined;
  }
  if (!entry) {
    let closing: Promise<void> | undefined;
    const created: Projection = {
      path: route,
      runtime: params.runtime,
      serverName: params.serverName,
      connections: new Set(),
      modernConnections: new Map(),
      closed: false,
      close() {
        if (closing) {
          return closing;
        }
        created.closed = true;
        if (projectionOwner.entries.get(route) === created) {
          projectionOwner.entries.delete(route);
        }
        closing = (async () => {
          const outcomes = await Promise.allSettled(
            [...created.connections].map((connection) => connection.close()),
          );
          const failures = outcomes.flatMap((result) =>
            result.status === "rejected" ? [result.reason] : [],
          );
          if (failures.length) {
            throw new AggregateError(failures, "Native MCP projection cleanup failed");
          }
        })();
        const pending = closing;
        projectionOwner.closing.add(pending);
        void pending.finally(() => projectionOwner.closing.delete(pending)).catch(() => undefined);
        return closing;
      },
    };
    entry = created;
    projectionOwner.entries.set(route, entry);
  }
  const registration = { policy: params.policy };
  entry.registration = registration;
  const selected = entry;
  return {
    url: `http://127.0.0.1:${listener.port}${route}`,
    async close() {
      // A warm native client keeps its initial URL and connection. Only the new
      // turn's registration can admit work; old cleanup cannot revoke its successor.
      if (selected.registration === registration) {
        selected.registration = undefined;
        await Promise.all(
          [...selected.connections].map(async (connection) => {
            clearContinuations(connection);
            if (!connection.view) {
              await connection.close();
            }
          }),
        );
        if (selected.connections.size === 0) {
          await selected.close();
        }
      }
    },
  };
}

export async function closeNativeMcpProjections(): Promise<void> {
  const active = [...projectionOwner.entries.values()].map((entry) => entry.close());
  const outcomes = await Promise.allSettled(new Set([...active, ...projectionOwner.closing]));
  const failures = outcomes.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (failures.length) {
    throw new AggregateError(failures, "Native MCP projections failed to close");
  }
}

function createConnection(
  entry: Projection,
  capabilities: ClientCapabilities,
  authority: Authority,
  negotiation: "auto" | "legacy" = "auto",
): Connection {
  const grant = { isCurrent: authority.isCurrent };
  const exchanges = new Set<Exchange>();
  const context = createProjectionClientContext(entry, capabilities, grant, exchanges);
  let closing: Promise<void> | undefined;
  const connection: Connection = {
    capabilities,
    grantToken: authority.grantToken,
    context,
    grant,
    authority: new AsyncLocalStorage<Authority>(),
    exchanges,
    responses: new Set(),
    resourceResponses: new Map(),
    catalogResponses: new Set(),
    continuations: { tools: new Map(), resources: new Map(), prompts: new Map() },
    closed: false,
    preparing: prepareNativeMcpServer(entry.runtime, entry.serverName, context, { negotiation }),
    close() {
      if (closing) {
        return closing;
      }
      connection.closed = true;
      for (const [key, value] of entry.modernConnections) {
        if (value === connection) {
          entry.modernConnections.delete(key);
        }
      }
      connection.unsubscribe?.();
      connection.unsubscribeGrant?.();
      clearContinuations(connection);
      // Publish the join promise before transport closure can reenter through onclose.
      closing = Promise.resolve()
        .then(async () => {
          await settleProjectionExchanges(connection);
          for (const response of connection.responses) {
            response.destroy();
          }
          const transports = await Promise.allSettled([
            connection.modern?.close(),
            connection.legacy?.server.close(),
            connection.legacy?.transport.close(),
          ]);
          // A view binding can still own startup work when its downstream closes.
          // attachView releases a late result; join it before declaring retirement.
          await connection.binding?.catch(() => undefined);
          await connection.legacy?.operations;
          const resources = await Promise.allSettled([
            connection.view?.release(),
            connection.preparing.then(
              (preparation) => preparation.release(),
              () => undefined,
            ),
          ]);
          const failures = [...transports, ...resources].flatMap((result) =>
            result.status === "rejected" ? [result.reason] : [],
          );
          if (failures.length) {
            throw new AggregateError(failures, "Native MCP view cleanup failed");
          }
        })
        .finally(() => {
          entry.connections.delete(connection);
        });
      return closing;
    },
  };
  connection.unsubscribeGrant = registerMcpLoopbackClientGrantRevocationListener((event) => {
    if (event.token !== connection.grantToken) {
      return;
    }
    if (event.kind === "removed" && entry.registration) {
      void connection.close().catch(() => undefined);
      return;
    }
    if (!connection.grant.isCurrent()) {
      clearContinuations(connection);
    }
  });
  // Initialization errors stay observed even if the native peer disconnects first.
  void connection.preparing.catch(() => undefined);
  entry.connections.add(connection);
  return connection;
}

/** Mounted only on the existing authenticated process-owned loopback listener. */
export async function handleNativeMcpProjectionRequest(params: {
  req: IncomingMessage;
  res: ServerResponse;
  ownerToken: string;
  nonOwnerToken: string;
  work: GatewayConnectionWork;
}): Promise<void> {
  const { req, res } = params;
  const path = URL.parse(req.url ?? "", "http://127.0.0.1")?.pathname;
  const auth = validateMcpLoopbackRequest({ ...params, nativeProjection: true });
  if (!auth) {
    return;
  }
  const entry = path ? projectionOwner.entries.get(path) : undefined;
  const grant = auth.boundClientGrant;
  const grantToken = auth.boundGrantToken;
  if (
    !entry ||
    !entry.registration ||
    !grant ||
    !grantToken ||
    grant.context.sessionId !== entry.runtime.sessionId ||
    resolveRequesterPrincipalKey(grant.context) !==
      resolveRequesterPrincipalKey({
        requesterOrigin: entry.registration.policy.capabilityProfile.requesterOrigin,
      })
  ) {
    writeJsonWithoutCharset(res, 401, { error: "unauthorized" });
    return;
  }
  const requestCapture =
    req.method === "POST" ? markMcpLoopbackRequestStarted(grant.captureKey) : undefined;
  const requestAbort = createHttpRequestAbortSignal(req, res);
  const authority: Authority = {
    signal: requestAbort.signal,
    captureKey: grant.captureKey,
    grantToken,
    isCurrent: () =>
      !params.work.isClosing &&
      !entry.closed &&
      Boolean(entry.registration) &&
      grant.isCurrent() &&
      getActiveMcpLoopbackRuntime()?.ownerToken === params.ownerToken,
    assertCurrent() {
      requestAbort.signal.throwIfAborted();
      if (!authority.isCurrent()) {
        throw new Error("Native MCP grant is no longer current");
      }
    },
  };
  let connection: Connection | undefined;
  let bootstrap: Connection | undefined;
  let initializationFailure: { error: unknown } | undefined;
  try {
    authority.assertCurrent();
    const body =
      req.method === "POST"
        ? (JSON.parse(
            await readRequestBodyWithLimit(req, {
              maxBytes: 1_048_576,
              timeoutMs: resolveMcpHttpBodyTimeoutMs(),
              destroyOnLimit: false,
            }),
          ) as unknown)
        : undefined;
    markMcpLoopbackRequestClassified(requestCapture);
    const record = isRecord(body) ? body : undefined;
    // Subscription streams outlive a turn and cannot represent pending tool effects.
    if (record?.method === "subscriptions/listen") {
      markMcpLoopbackRequestFinished(requestCapture);
    }
    const input = isRecord(record?.params) ? record.params : undefined;
    const meta = isRecord(input?._meta) ? input._meta : undefined;
    const sessionId = req.headers["mcp-session-id"];
    connection =
      typeof sessionId === "string"
        ? [...entry.connections].find(
            (candidate) =>
              !candidate.closed &&
              candidate.grantToken === grantToken &&
              candidate.legacy?.transport.sessionId === sessionId,
          )
        : undefined;
    if (req.method !== "DELETE") {
      connection?.responses.add(res);
    }
    if (record?.method === "initialize") {
      const capabilities = ClientCapabilitiesSchema.parse(input?.capabilities ?? {});
      const key = stableStringify([grantToken, capabilities]);
      const pending = entry.modernConnections.get(key);
      if (pending && (await pending.preparing).era === "legacy") {
        connection = pending;
        entry.modernConnections.delete(key);
      } else {
        connection = createConnection(entry, capabilities, authority, "legacy");
      }
      bootstrap = connection;
      connection.responses.add(res);
      connection.grant.isCurrent = authority.isCurrent;
      const preparation = await connection.preparing;
      authority.assertCurrent();
      if (preparation.era !== "legacy") {
        await connection.close();
        throw new ProtocolError(
          ProtocolErrorCode.MethodNotFound,
          "Legacy MCP preparation did not select legacy negotiation",
        );
      }
      const selected = connection;
      const server = new Server(
        { name: entry.serverName, version: "1" },
        {
          capabilities: {
            tools: { listChanged: true },
            resources: { listChanged: true, subscribe: true },
            prompts: { listChanged: true },
            completions: {},
            logging: {},
          },
        },
      );
      const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: randomUUID });
      selected.legacy = {
        server,
        transport,
        operations: Promise.resolve(),
        subscriptions: new Map(),
      };
      const legacy = selected.legacy;
      const initial = Promise.withResolvers<NativeMcpServerView>();
      selected.binding = initial.promise;
      void initial.promise.catch(() => undefined);
      // Both DELETE and local closure must release the native view, including an unfinished bind.
      // oxlint-disable-next-line unicorn/prefer-add-event-listener -- MCP Server is not an EventTarget.
      server.onclose = () => {
        initial.reject(new Error("Native MCP downstream session closed"));
        void selected.close().catch(() => undefined);
      };
      installHandlers(entry, selected, server);
      const send = transport.send.bind(transport);
      let initialized = false;
      transport.send = async (message, options) => {
        if (!initialized && "result" in message && message.id === record.id) {
          initialized = true;
          const exchange = { server, authority, requestId: message.id };
          selected.exchanges.add(exchange);
          try {
            const roots = capabilities.roots
              ? await server.listRoots(
                  {},
                  { signal: authority.signal, relatedRequestId: message.id },
                )
              : { roots: [] };
            authority.assertCurrent();
            const view = await preparation.bind(roots);
            await attachProjectionView(selected, view);
            legacy.rootsKey = stableStringify(roots);
            initial.resolve(view);
            await preparation.release();
            authority.assertCurrent();
            await send(
              {
                ...message,
                result: {
                  protocolVersion: message.result.protocolVersion,
                  capabilities: view.getCapabilities() ?? {},
                  serverInfo: view.getServerInfo() ?? { name: entry.serverName, version: "1" },
                  ...(view.getInstructions() ? { instructions: view.getInstructions() } : {}),
                },
              },
              options,
            );
            return;
          } catch (error) {
            initial.reject(error);
            initializationFailure = { error };
            await send(
              {
                jsonrpc: "2.0",
                id: message.id,
                error: {
                  code: ProtocolErrorCode.InternalError,
                  message: "Native MCP upstream initialization failed",
                },
              },
              options,
            );
            return;
          } finally {
            selected.exchanges.delete(exchange);
          }
        }
        if (!initialized && "error" in message && message.id === record.id) {
          const error = new Error("Native MCP initialization rejected");
          initial.reject(error);
          initializationFailure = { error };
        }
        await send(message, options);
      };
      server.setNotificationHandler("notifications/roots/list_changed", () => {
        const currentAuthority = selected.authority.getStore();
        if (!currentAuthority) {
          throw new Error("Native MCP roots change has no admitted requester");
        }
        return queueLegacyProjectionOperation(selected, async () => {
          const exchange = { server, authority: currentAuthority };
          selected.exchanges.add(exchange);
          const options = {
            signal: currentAuthority.signal,
            assertCurrent: currentAuthority.assertCurrent,
          };
          try {
            const view = await refreshLegacyProjectionView(entry, selected, options);
            await view.rootsChanged(options);
          } finally {
            selected.exchanges.delete(exchange);
          }
        });
      });
      await server.connect(transport);
    } else if (!connection && meta?.[CLIENT_CAPABILITIES_META_KEY]) {
      const capabilities = ClientCapabilitiesSchema.parse(meta[CLIENT_CAPABILITIES_META_KEY]);
      const key = stableStringify([grantToken, capabilities]);
      connection = entry.modernConnections.get(key);
      if (!connection) {
        connection = createConnection(entry, capabilities, authority);
        entry.modernConnections.set(key, connection);
        connection.responses.add(res);
        bootstrap = connection;
      }
      const selected = connection;
      selected.grant.isCurrent = authority.isCurrent;
      const preparation = await selected.preparing;
      authority.assertCurrent();
      if (preparation.era !== "modern") {
        writeJsonWithoutCharset(res, 200, {
          jsonrpc: "2.0",
          id: record?.id ?? null,
          error: { code: ProtocolErrorCode.MethodNotFound, message: "Upstream uses legacy MCP" },
        });
        return;
      }
      selected.binding ??= preparation.bind().then(async (view) => {
        await attachProjectionView(selected, view);
        return view;
      });
      const view = await selected.binding;
      await preparation.release();
      selected.modern ??= createMcpHandler(
        () => {
          const server = new Server(
            view.getServerInfo() ?? { name: entry.serverName, version: "1" },
            { capabilities: view.getCapabilities(), instructions: view.getInstructions() },
          );
          installHandlers(entry, selected, server);
          return server;
        },
        { legacy: "reject" },
      );
    }
    if (!connection) {
      writeJsonWithoutCharset(res, 404, { error: "native_mcp_session_expired" });
      return;
    }
    authority.assertCurrent();
    connection.grant.isCurrent = authority.isCurrent;
    if (connection.legacy) {
      // Stored transport sessions preserve native callbacks; effect authority is never stored there.
      const transport = connection.legacy.transport;
      await connection.authority.run(authority, () => transport.handleRequest(req, res, body));
      if (initializationFailure) {
        throw initializationFailure.error;
      }
      if (bootstrap === connection && res.statusCode >= 400) {
        throw new Error("Native MCP initialization rejected");
      }
    } else if (connection.modern) {
      const handle = toNodeHandler(connection.modern);
      const subscriptions: Array<{ release: () => Promise<void> }> = [];
      try {
        if (record?.method === "subscriptions/listen") {
          const requested = SubscriptionsListenRequestParamsSchema.parse(input);
          const resources = new Set(requested.notifications.resourceSubscriptions ?? []);
          connection.resourceResponses.set(res, resources);
          const watchesCatalog = Boolean(
            requested.notifications.toolsListChanged ||
            requested.notifications.resourcesListChanged ||
            requested.notifications.promptsListChanged,
          );
          if (watchesCatalog) {
            connection.catalogResponses.add(res);
          }
          const view = await connection.binding;
          if (!view) {
            throw new Error("Native MCP initialization is incomplete");
          }
          if (watchesCatalog) {
            authority.assertCurrent();
            await view.runtime.getCatalog();
            authority.assertCurrent();
          }
          for (const uri of resources) {
            subscriptions.push(
              await view.acquireResourceSubscription(
                { uri },
                { signal: authority.signal, assertCurrent: authority.assertCurrent },
              ),
            );
          }
        }
        authority.assertCurrent();
        // Retain upstream subscriptions until the SDK-owned response closes.
        await connection.authority.run(authority, () => handle(req, res, body));
      } finally {
        await Promise.all(subscriptions.map((subscription) => subscription.release()));
      }
    }
  } catch (error) {
    await bootstrap
      ?.close()
      .catch((cleanupError: unknown) =>
        entry.registration?.policy.warn(
          `bundle MCP projection cleanup failed: ${redactMcpDiagnosticError(cleanupError)}`,
        ),
      );
    entry.registration?.policy.warn(
      `bundle MCP skipped unavailable projection ${entry.serverName}${initializationFailure ? " during legacy initialization" : ""}: ${redactMcpDiagnosticError(error)}`,
    );
    if (!res.headersSent) {
      writeJsonWithoutCharset(res, 500, { error: "native_mcp_projection_unavailable" });
    } else {
      res.end();
    }
  } finally {
    connection?.catalogResponses.delete(res);
    connection?.resourceResponses.delete(res);
    connection?.responses.delete(res);
    requestAbort.cleanup();
    markMcpLoopbackRequestFinished(requestCapture);
  }
}
