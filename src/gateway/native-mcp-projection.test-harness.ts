import fs from "node:fs/promises";
import path from "node:path";
import {
  Client,
  type ClientCapabilities,
  StreamableHTTPClientTransport,
  type ListRootsResult,
  type CreateMessageResultWithTools,
} from "@modelcontextprotocol/client";
import { afterAll, afterEach, beforeAll } from "vitest";
import { z } from "zod";
import {
  openFixtureReceiptChannel,
  type FixtureReceiptChannel,
} from "../../test/helpers/fixture-receipts.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createSessionMcpRuntime } from "../agents/agent-bundle-mcp-runtime.js";
import type { SessionMcpRuntime } from "../agents/agent-bundle-mcp-types.js";
import { resolveConversationCapabilityProfile } from "../agents/conversation-capability-profile.js";
import { revokeMcpLoopbackClientGrant } from "./mcp-grant-store.js";
import {
  captureGrant,
  prepareAdmission,
  runtime as loopbackRuntime,
} from "./mcp-http-request.test-support.js";
import { closeMcpLoopbackServer, ensureMcpLoopbackServer } from "./mcp-http.js";
import { clearMcpLoopbackToolCallCapture } from "./mcp-http.loopback-runtime.js";
import { closeNativeMcpProjections, registerNativeMcpProjection } from "./native-mcp-projection.js";
import {
  writeProjectionFixture,
  connectDirect,
  type ProjectionFixtureOptions,
} from "./native-mcp-projection.test-support.js";

export function createProjectionHarness() {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  const runtimes: SessionMcpRuntime[] = [];
  const clients: Client[] = [];
  const admissions: ReturnType<typeof prepareAdmission>[] = [];
  const tokens: string[] = [];
  const captureKeys: string[] = [];
  let receipts: FixtureReceiptChannel;
  let nextRun = 0;
  const roots: ListRootsResult = {
    roots: [{ uri: "file:///fixture/workspace", name: "Synthetic workspace" }],
    _meta: { source: "downstream-handshake" },
  };
  const metadata = { fixture: "kept", nested: { value: 7 } };
  const samplingResult: CreateMessageResultWithTools = {
    role: "assistant",
    model: "synthetic",
    stopReason: "toolUse",
    content: [
      {
        type: "tool_use",
        name: "catalog-tool",
        id: "fixture-tool-call",
        input: { count: 7 },
        _meta: metadata,
      },
    ],
    _meta: metadata,
  };

  beforeAll(async () => {
    receipts = await openFixtureReceiptChannel();
    await ensureMcpLoopbackServer(0);
  });
  afterEach(async () => {
    for (const token of tokens.splice(0)) {
      revokeMcpLoopbackClientGrant(token);
    }
    for (const key of captureKeys.splice(0)) {
      clearMcpLoopbackToolCallCapture(key);
    }
    await Promise.all(clients.splice(0).map((client) => client.close()));
    await closeNativeMcpProjections();
    await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
    for (const admission of admissions.splice(0)) {
      admission.close();
    }
  });
  afterAll(async () => {
    await closeMcpLoopbackServer();
    await receipts.close();
  });

  async function fixture(
    era: "legacy" | "modern" | "dual",
    options: ProjectionFixtureOptions = {},
  ) {
    const directory = tempDirs.make("native-mcp-http-");
    const file = path.join(directory, "server.mjs");
    await writeProjectionFixture(file, receipts.endpoint, era, options);
    const definition = { command: process.execPath, args: [file] };
    const runtime = createSessionMcpRuntime({
      sessionId: `http-projection-${++nextRun}`,
      workspaceDir: directory,
      cfg: { plugins: { enabled: false }, mcp: { servers: { fixture: definition } } },
    });
    runtimes.push(runtime);
    const requesterOrigin = {
      sessionKey: "agent:main:projection",
      messageProvider: "telegram",
      accountId: "synthetic",
      senderId: "alice",
    };
    const diagnostics: string[] = [];
    const register = (denyAll = false, deniedTools: string[] = []) =>
      registerNativeMcpProjection({
        runtime,
        serverName: "fixture",
        definition,
        policy: {
          workspaceDir: directory,
          capabilityProfile: resolveConversationCapabilityProfile({
            config: { tools: { deny: deniedTools } },
            requesterOrigin,
          }),
          ...(denyAll ? { runtimeToolsAllow: [] } : {}),
          warn: (message) => diagnostics.push(message),
        },
      });
    const grant = async (senderId = "alice") => {
      const listener = loopbackRuntime();
      const runId = `projection-turn-${++nextRun}`;
      const admission = prepareAdmission(runId, "native-mcp-projection-test");
      admissions.push(admission);
      const result = captureGrant(
        {
          context: {
            sessionKey: "agent:main:projection",
            sessionId: runtime.sessionId,
            requesterOrigin: { ...requesterOrigin, senderId },
            senderIsOwner: true,
            runId,
          },
          runtimeOwnerToken: listener.ownerToken,
          admittedRunContext: await admission.admit("gateway", runId),
          toolPolicyConfig: {},
        },
        runId,
        (token) => tokens.push(token),
      );
      return { ...result, retireAdmission: () => admission.close() };
    };
    const log = async () => (await fs.readFile(file + ".log", "utf8")).trim().split("\n");
    return { runtime, file, register, grant, log, diagnostics };
  }

  async function connect(params: {
    url: string;
    grant: Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>["grant"]>>;
    mode: "legacy" | "auto";
    sampleDuringCatalog?: boolean;
    beforeRootsResponse?: () => void;
    roots?: () => ListRootsResult;
    supportedProtocolVersions?: string[];
    forbidPreInitializationGet?: boolean;
    elicitation?: boolean;
  }) {
    let activeGrant = params.grant;
    const persistentStream = Promise.withResolvers<{
      response: Response;
      signal: AbortSignal | null | undefined;
    }>();
    let initialized = false;
    let rootsRequests = 0;
    const samplingRequests: unknown[] = [];
    const client = new Client(
      { name: "projection-consumer", version: "1" },
      {
        capabilities: {
          roots: { listChanged: true },
          ...(params.elicitation
            ? {
                elicitation: { form: {}, url: {} },
                extensions: { "openai/elicitation": { form: {} } },
              }
            : {}),
          ...(params.sampleDuringCatalog
            ? { sampling: { tools: {} }, extensions: { "io.openclaw.test/sample-during-list": {} } }
            : {}),
        },
        versionNegotiation: { mode: params.mode },
        supportedProtocolVersions: params.supportedProtocolVersions,
      },
    );
    clients.push(client);
    client.setRequestHandler("roots/list", async () => {
      rootsRequests++;
      params.beforeRootsResponse?.();
      return params.roots?.() ?? roots;
    });
    if (params.sampleDuringCatalog) {
      client.setRequestHandler("sampling/createMessage", async (request) => {
        samplingRequests.push(request.params);
        return samplingResult;
      });
    }
    const elicited: unknown[] = [];
    if (params.elicitation) {
      client.setRequestHandler("elicitation/create", async (request) => {
        elicited.push(request.params);
        return request.params.mode === "url"
          ? { action: "accept", _meta: metadata }
          : { action: "accept", content: { choice: "fixture" }, _meta: metadata };
      });
      client.setRequestHandler(
        "openai/elicitation/create",
        { params: z.record(z.string(), z.unknown()) },
        async (elicitation) => {
          elicited.push(elicitation);
          return { action: "accept", content: { choice: "custom" }, _meta: metadata };
        },
      );
    }
    const transport = new StreamableHTTPClientTransport(new URL(params.url), {
      fetch: async (input, init) => {
        const headers = new Headers(init?.headers);
        headers.set("authorization", `Bearer ${activeGrant.token}`);
        headers.set("x-openclaw-cli-capture-key", activeGrant.captureKey);
        const request: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
        if (
          typeof request === "object" &&
          request !== null &&
          "method" in request &&
          request.method === "notifications/initialized"
        ) {
          initialized = true;
        }
        if (params.forbidPreInitializationGet && init?.method === "GET" && !initialized) {
          throw new Error("Standalone GET opened before initialize completed");
        }
        const response = await fetch(input, { ...init, headers });
        if (
          init?.method === "GET" ||
          (typeof request === "object" &&
            request !== null &&
            "method" in request &&
            request.method === "subscriptions/listen")
        ) {
          persistentStream.resolve({ response, signal: init?.signal });
        }
        return response;
      },
    });
    await client.connect(transport);
    return {
      client,
      transport,
      elicited,
      persistentStream: persistentStream.promise,
      rootsRequests: () => rootsRequests,
      samplingRequests: () => samplingRequests,
      setGrant: (grant: typeof activeGrant) => {
        activeGrant = grant;
      },
    };
  }

  return {
    fixture,
    connect,
    connectDirect: (
      file: string,
      mode?: "auto" | "legacy",
      capabilities?: ClientCapabilities,
      supportedProtocolVersions?: string[],
    ) => connectDirect(file, clients, mode, capabilities, supportedProtocolVersions),
    roots,
    metadata,
    samplingResult,
    captureKeys,
    get receipts() {
      return receipts;
    },
  };
}
