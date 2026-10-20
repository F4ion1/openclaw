import { randomUUID } from "node:crypto";
import type { ClientCapabilities, InputRequiredResult } from "@modelcontextprotocol/client";
import { ElicitResultSchema } from "@modelcontextprotocol/core";
import {
  ProtocolError,
  ProtocolErrorCode,
  type Server,
  type ServerContext,
} from "@modelcontextprotocol/server";
import { stableStringify } from "@openclaw/normalization-core/stable-stringify";
import { normalizeClaudeMcpIdentifierPart } from "../agents/cli-runner/bundle-mcp-claude.js";
import { prepareNativeMcpPolicy } from "../agents/native-mcp-policy.js";
import {
  prepareNativeMcpServer,
  type NativeMcpPreparationContext,
  type NativeMcpRequestOptions,
  type NativeMcpResponse,
  type NativeMcpServerView,
} from "../agents/native-mcp-runtime.js";
import {
  markMcpLoopbackToolCallStarted,
  markMcpLoopbackToolCallFinished,
  recordMcpLoopbackToolCallResult,
  updateMcpLoopbackToolCallCapture,
} from "./mcp-http.loopback-runtime.js";
import type { Connection, Exchange, Projection } from "./native-mcp-projection.js";

export async function attachProjectionView(connection: Connection, view: NativeMcpServerView) {
  if (connection.closed || !connection.grant.isCurrent()) {
    await view.release();
    throw new Error("Native MCP view retired during initialization");
  }
  connection.view = view;
  connection.unsubscribe = view.subscribe((event) => {
    if (event.kind === "closed") {
      void connection.close().catch(() => undefined);
      return;
    }
    if (!connection.grant.isCurrent()) {
      return;
    }
    if (event.kind === "resource-subscription-ended") {
      // Other subscriptions and in-flight calls still belong to this healthy view.
      for (const [response, resources] of connection.resourceResponses) {
        if (resources.has(event.uri)) {
          response.destroy();
        }
      }
      return;
    }
    if (event.kind === "catalog-subscription-ended") {
      for (const response of connection.catalogResponses) {
        response.destroy();
      }
      return;
    }
    if (connection.legacy) {
      void connection.legacy.server.notification(event.notification).catch(() => undefined);
    }
    if (connection.modern && event.notification.method === "notifications/message") {
      for (const exchange of connection.exchanges) {
        exchange.authority.assertCurrent();
        void exchange.notify?.(event.notification).catch(() => undefined);
      }
    }
    const bus = connection.modern?.bus;
    switch (event.notification.method) {
      case "notifications/tools/list_changed":
        bus?.publish({ kind: "tools_list_changed", params: event.notification.params });
        break;
      case "notifications/resources/list_changed":
        bus?.publish({ kind: "resources_list_changed", params: event.notification.params });
        break;
      case "notifications/prompts/list_changed":
        bus?.publish({ kind: "prompts_list_changed", params: event.notification.params });
        break;
      case "notifications/resources/updated":
        bus?.publish({
          kind: "resource_updated",
          uri: event.notification.params.uri,
          params: event.notification.params,
        });
        break;
      case "notifications/cancelled":
      case "notifications/elicitation/complete":
      case "notifications/message":
      case "notifications/progress":
      case "notifications/subscriptions/acknowledged":
        // Request-scoped messages use the active exchange; the bus owns catalog events.
        break;
    }
  });
}

export function createProjectionClientContext(
  entry: Projection,
  capabilities: ClientCapabilities,
  grant: { isCurrent: () => boolean },
  exchanges: Set<Exchange>,
): NativeMcpPreparationContext {
  const currentExchange = () => {
    if (exchanges.size !== 1) {
      throw new Error("MCP callback has no unambiguous downstream requester");
    }
    const exchange = exchanges.values().next().value!;
    exchange.authority.assertCurrent();
    return exchange;
  };
  return {
    capabilityContext: {},
    capabilities,
    assertCurrent() {
      if (entry.closed || !grant.isCurrent()) {
        throw new Error("Native MCP view is no longer authorized");
      }
    },
    ...(capabilities.elicitation
      ? {
          elicit: async (params, { signal }) => {
            const { server, requestId } = currentExchange();
            return server.elicitInput(params, { signal, relatedRequestId: requestId });
          },
        }
      : {}),
    ...(capabilities.sampling
      ? {
          createMessage: async (params, { signal }) => {
            const { server, requestId } = currentExchange();
            return server.createMessage(params, { signal, relatedRequestId: requestId });
          },
        }
      : {}),
    ...(capabilities.extensions?.["openai/elicitation"]
      ? {
          elicitCustom: async (params, { signal }) => {
            const { server, requestId } = currentExchange();
            return server.request(
              { method: "openai/elicitation/create", params },
              ElicitResultSchema,
              { signal, relatedRequestId: requestId },
            );
          },
        }
      : {}),
  };
}

type ToolCapture = {
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
/** Close a request explicitly before its resumable stream loses the transport. */
export async function settleProjectionExchanges(connection: Connection) {
  await Promise.allSettled(
    [...connection.exchanges].map(async ({ server, requestId }) =>
      requestId === undefined
        ? undefined
        : server.transport?.send({
            jsonrpc: "2.0",
            id: requestId,
            error: { code: ProtocolErrorCode.InternalError, message: "Native MCP view retired" },
          }),
    ),
  );
}

export function clearContinuations(connection: Connection) {
  for (const map of [
    connection.continuations.tools,
    connection.continuations.resources,
    connection.continuations.prompts,
  ]) {
    for (const pending of map.values()) {
      finishCapture(pending.capture, undefined, new Error("Native MCP continuation retired"));
    }
    map.clear();
  }
}

function finishCapture(capture: ToolCapture | undefined, result?: unknown, error?: unknown) {
  if (!capture?.handle || capture.handle.finished) {
    return;
  }
  recordMcpLoopbackToolCallResult({
    captureHandle: capture.handle,
    toolName: capture.toolName,
    args: capture.args,
    outcome: error ? "failed" : "completed",
    result: error ? undefined : result,
  });
  markMcpLoopbackToolCallFinished(capture.handle);
}

export function queueLegacyProjectionOperation<T>(
  connection: Connection,
  operation: () => Promise<T>,
): Promise<T> {
  if (!connection.legacy) {
    return operation();
  }
  // Keep roots replacement and the admitted operation together, including subscription changes.
  const pending = connection.legacy.operations.then(operation);
  connection.legacy.operations = pending.then(
    () => undefined,
    () => undefined,
  );
  return pending;
}

async function prepareProjectionPolicy(entry: Projection, view: NativeMcpServerView) {
  const registration = entry.registration;
  if (!registration) {
    throw new Error("Native MCP turn is no longer active");
  }
  return (await prepareNativeMcpPolicy({ ...registration.policy, runtime: view.runtime })).servers[
    entry.serverName
  ];
}

export async function refreshLegacyProjectionView(
  entry: Projection,
  connection: Connection,
  options: NativeMcpRequestOptions,
  requestId?: ServerContext["mcpReq"]["id"],
): Promise<NativeMcpServerView> {
  options.assertCurrent();
  if (connection.closed) {
    throw new Error("Native MCP connection is closed");
  }
  const previous = await connection.binding;
  if (!previous) {
    throw new Error("Native MCP initialization is incomplete");
  }
  const legacy = connection.legacy;
  if (!legacy || !connection.capabilities.roots) {
    return previous;
  }
  // Claude can change worktrees without sending roots/list_changed.
  const roots = await legacy.server.listRoots(
    {},
    {
      signal: options.signal,
      relatedRequestId: requestId,
    },
  );
  options.assertCurrent();
  const rootsKey = stableStringify(roots);
  if (rootsKey === legacy.rootsKey) {
    return previous;
  }
  const preparation = await prepareNativeMcpServer(
    entry.runtime,
    entry.serverName,
    connection.context,
    {
      negotiation: "legacy",
    },
  );
  let next: NativeMcpServerView | undefined;
  let published = false;
  try {
    if (preparation.era !== "legacy") {
      throw new Error("MCP upstream era changed");
    }
    next = await preparation.bind(roots);
    await prepareProjectionPolicy(entry, next);
    options.assertCurrent();
    clearContinuations(connection);
    connection.unsubscribe?.();
    await attachProjectionView(connection, next);
    connection.binding = Promise.resolve(next);
    legacy.rootsKey = rootsKey;
    published = true;
    try {
      for (const subscription of legacy.subscriptions.values()) {
        await next.subscribeResource(subscription, options);
      }
      if (legacy.logging) {
        await next.setLoggingLevel(legacy.logging, options);
      }
      options.assertCurrent();
      return next;
    } catch (error) {
      // A partially restored view cannot keep claiming the old subscription state.
      void connection.close().catch(() => undefined);
      throw error;
    } finally {
      await previous.release();
    }
  } finally {
    if (!published) {
      await next?.release();
    }
    await preparation.release();
  }
}

export function installHandlers(entry: Projection, connection: Connection, server: Server) {
  const authority = () => {
    const admitted = connection.authority.getStore();
    if (!admitted) {
      throw new Error("Native MCP request has no admitted downstream exchange");
    }
    return admitted;
  };
  const run = <T>(
    ctx: ServerContext,
    call: (view: NativeMcpServerView, options: NativeMcpRequestOptions) => Promise<T>,
  ): Promise<T> => {
    const admitted = authority();
    return queueLegacyProjectionOperation(connection, async () => {
      const legSignal = AbortSignal.any([admitted.signal, ctx.mcpReq.signal]);
      const lifetime = new AbortController();
      const abort = () => lifetime.abort(legSignal.reason);
      legSignal.addEventListener("abort", abort, { once: true });
      if (legSignal.aborted) {
        abort();
      }
      const assertCurrent = () => {
        lifetime.signal.throwIfAborted();
        if (connection.closed || !admitted.isCurrent()) {
          throw new Error("Native MCP grant is no longer current");
        }
      };
      const exchange: Exchange = {
        server,
        authority: admitted,
        requestId: ctx.mcpReq.id,
        notify: (message) => ctx.mcpReq.notify(message),
      };
      connection.exchanges.add(exchange);
      try {
        assertCurrent();
        const options: NativeMcpRequestOptions = {
          signal: lifetime.signal,
          assertCurrent,
          ...(ctx.mcpReq._meta?.progressToken !== undefined
            ? {
                onprogress: (progress) => {
                  void ctx.mcpReq
                    .notify({
                      method: "notifications/progress",
                      params: { ...progress, progressToken: ctx.mcpReq._meta!.progressToken! },
                    })
                    .catch(() => undefined);
                },
              }
            : {}),
        };
        const view = await refreshLegacyProjectionView(entry, connection, options, ctx.mcpReq.id);
        assertCurrent();
        const result = await call(view, options);
        assertCurrent();
        return result;
      } finally {
        // A completed HTTP leg closes normally while its input-required continuation remains live.
        legSignal.removeEventListener("abort", abort);
        connection.exchanges.delete(exchange);
      }
    });
  };
  const flow = async <T>(
    ctx: ServerContext,
    signature: string,
    continuations: Map<string, Continuation<T>>,
    options: NativeMcpRequestOptions,
    start: () => Promise<NativeMcpResponse<T>>,
    tool?: {
      name: string;
      args: Record<string, unknown>;
      authorize: () => Promise<void>;
      project: (result: T) => T;
    },
  ): Promise<T | InputRequiredResult> => {
    const captureKey = authority().captureKey;
    const state = ctx.mcpReq.requestState();
    const pending = typeof state === "string" ? continuations.get(state) : undefined;
    if (
      state !== undefined &&
      (!pending || pending.signature !== signature || pending.captureKey !== captureKey)
    ) {
      throw new ProtocolError(ProtocolErrorCode.InvalidRequest, "Native MCP continuation expired");
    }
    let capture = pending?.capture;
    if (!pending && tool) {
      const toolName = `mcp__${normalizeClaudeMcpIdentifierPart(entry.serverName)}__${normalizeClaudeMcpIdentifierPart(tool.name)}`;
      capture = {
        handle: markMcpLoopbackToolCallStarted({ captureKey, toolName, args: tool.args }),
        toolName,
        args: tool.args,
      };
      updateMcpLoopbackToolCallCapture(capture.handle, { toolName, args: tool.args });
    }
    try {
      await tool?.authorize();
      options.assertCurrent();
      if (typeof state === "string") {
        continuations.delete(state);
      }
      const response = pending
        ? await pending.resume(ctx.mcpReq.inputResponses ?? {}, options)
        : await start();
      if (response.kind === "complete") {
        const result = tool ? tool.project(response.result) : response.result;
        finishCapture(capture, result);
        return result;
      }
      const key = randomUUID();
      continuations.set(key, { signature, captureKey, resume: response.resume, capture });
      return { ...response.result, requestState: key };
    } catch (error) {
      if (typeof state === "string") {
        continuations.delete(state);
      }
      finishCapture(capture, undefined, error);
      throw error;
    }
  };
  const capabilities = server.getCapabilities();
  if (capabilities.tools) {
    server.setRequestHandler("tools/list", (request, ctx) =>
      run(ctx, async (view, options) => {
        const allowed = new Set((await prepareProjectionPolicy(entry, view))?.allowedTools ?? []);
        options.assertCurrent();
        const page = await view.listTools(request.params, options);
        return { ...page, tools: page.tools.filter((tool) => allowed.has(tool.name)) };
      }),
    );
    server.setRequestHandler("tools/call", (request, ctx) =>
      run(ctx, async (view, options) => {
        const { name, arguments: args } = request.params;
        return flow(
          ctx,
          stableStringify(["tools/call", name, args]),
          connection.continuations.tools,
          options,
          () => view.callTool(request.params, options),
          {
            name,
            args: args ?? {},
            project: (result) => server.projectCallToolResult(result, undefined),
            authorize: async () => {
              const allowed = new Set(
                (await prepareProjectionPolicy(entry, view))?.allowedTools ?? [],
              );
              options.assertCurrent();
              if (!allowed.has(name)) {
                throw new ProtocolError(
                  ProtocolErrorCode.InvalidParams,
                  "Native MCP tool is unavailable under current policy",
                );
              }
            },
          },
        );
      }),
    );
  }
  if (capabilities.resources) {
    server.setRequestHandler("resources/list", (request, ctx) =>
      run(ctx, (view, options) => view.listResources(request.params, options)),
    );
    server.setRequestHandler("resources/templates/list", (request, ctx) =>
      run(ctx, (view, options) => view.listResourceTemplates(request.params, options)),
    );
  }
  if (capabilities.prompts) {
    server.setRequestHandler("prompts/list", (request, ctx) =>
      run(ctx, (view, options) => view.listPrompts(request.params, options)),
    );
  }
  if (capabilities.completions) {
    server.setRequestHandler("completion/complete", (request, ctx) =>
      run(ctx, (view, options) => view.complete(request.params, options)),
    );
  }
  if (capabilities.resources) {
    server.setRequestHandler("resources/read", (request, ctx) =>
      run(ctx, (view, options) =>
        flow(
          ctx,
          stableStringify(["resources/read", request.params.uri]),
          connection.continuations.resources,
          options,
          () => view.readResource(request.params, options),
        ),
      ),
    );
  }
  if (capabilities.prompts) {
    server.setRequestHandler("prompts/get", (request, ctx) =>
      run(ctx, (view, options) =>
        flow(
          ctx,
          stableStringify(["prompts/get", request.params.name, request.params.arguments]),
          connection.continuations.prompts,
          options,
          () => view.getPrompt(request.params, options),
        ),
      ),
    );
  }
  if (capabilities.resources?.subscribe) {
    server.setRequestHandler("resources/subscribe", (request, ctx) =>
      run(ctx, async (view, options) => {
        const result = await view.subscribeResource(request.params, options);
        connection.legacy?.subscriptions.set(request.params.uri, request.params);
        return result;
      }),
    );
    server.setRequestHandler("resources/unsubscribe", (request, ctx) =>
      run(ctx, async (view, options) => {
        const result = await view.unsubscribeResource(request.params, options);
        connection.legacy?.subscriptions.delete(request.params.uri);
        return result;
      }),
    );
  }
  if (capabilities.logging) {
    server.setRequestHandler("logging/setLevel", (request, ctx) =>
      run(ctx, async (view, options) => {
        const result = await view.setLoggingLevel(request.params, options);
        if (connection.legacy) {
          connection.legacy.logging = request.params;
        }
        return result;
      }),
    );
  }
}
