import { createHash } from "node:crypto";
import type { ProtocolEra } from "@modelcontextprotocol/client";
import { stableStringify } from "@openclaw/normalization-core/stable-stringify";
import type { McpToolCatalog, SessionMcpRuntime } from "./agent-bundle-mcp-types.js";
import {
  applyMcpConnectionOverride,
  type McpServerConnectionResolved,
} from "./mcp-connection-resolver.js";
import { resolveMcpTransportConfig } from "./mcp-transport-config.js";
import type { createNativeMcpClientBridge } from "./native-mcp-runtime-client.js";
import {
  nativeMcpRuntimeBindings,
  type NativeMcpPreparationContext,
  type NativeMcpRuntimeContext,
  type NativeMcpServerPreparation,
  type NativeMcpServerView,
} from "./native-mcp-runtime.js";

// Only era facts cross capability lifecycles; catalogs and transports never do.
const nativeMcpEras = new Map<string, Promise<ProtocolEra>>();

export type NativeMcpStage = {
  era?: ProtocolEra;
  bound: Promise<void>;
  detected: (era: ProtocolEra) => void;
  activate?: () => void;
};

export type NativeMcpServerRuntime = SessionMcpRuntime & {
  readonly pluginOwned: boolean;
  resetStartupBackoff: () => void;
  readonly nativeContextKey: string | undefined;
  readonly nativeCapabilityContext: object | undefined;
  readonly nativeViewCount: number;
  bindNativeView: (
    context: NativeMcpRuntimeContext,
    era: ProtocolEra,
  ) => Promise<NativeMcpServerView>;
};

// Creation, registration, leases, and retirement stay with the session runtime.
export type NativeMcpPreparationOwner = {
  serverName: string;
  assertCurrent: () => void;
  getServerConfig: () => unknown;
  getConnectionOverride: () => McpServerConnectionResolved | undefined;
  children: ReadonlySet<NativeMcpServerRuntime>;
  createChild: (context: NativeMcpRuntimeContext, stage: NativeMcpStage) => NativeMcpServerRuntime;
  cleanupChild: (child: NativeMcpServerRuntime) => Promise<void>;
  bindView: (context: NativeMcpRuntimeContext, era: ProtocolEra) => Promise<NativeMcpServerView>;
};

export function nativeMcpContextKey(context: NativeMcpRuntimeContext, era?: ProtocolEra) {
  return stableStringify({ era, capabilities: context.capabilities, roots: context.roots });
}

export function recordNativeMcpEra(stage: NativeMcpStage | undefined, era: ProtocolEra) {
  if (!stage) {
    return;
  }
  if (stage.era && stage.era !== era) {
    throw new Error("MCP server changed its negotiated protocol era");
  }
  stage.era = era;
  stage.detected(era);
}

export async function bindNativeMcpChild(
  owner: NativeMcpPreparationOwner,
  context: NativeMcpRuntimeContext,
  era: ProtocolEra,
): Promise<NativeMcpServerView> {
  const key = nativeMcpContextKey(context, era);
  let child = [...owner.children].find(
    (candidate) =>
      candidate.nativeContextKey === key &&
      candidate.nativeCapabilityContext === context.capabilityContext,
  );
  if (!child) {
    child = owner.createChild(context, {
      era,
      bound: Promise.resolve(),
      detected() {},
    });
  }
  const selected = child;
  try {
    const view = await selected.bindNativeView(context, era);
    let releasePromise: Promise<void> | undefined;
    return {
      ...view,
      release() {
        return (releasePromise ??= (async () => {
          try {
            await view.release();
          } finally {
            await owner.cleanupChild(selected);
          }
        })());
      },
    };
  } catch (error) {
    await owner.cleanupChild(selected);
    throw error;
  }
}

async function prepareNativeMcpRuntime(
  owner: NativeMcpPreparationOwner,
  name: string,
  context: NativeMcpPreparationContext,
  options?: { negotiation: "auto" | "legacy" },
): Promise<NativeMcpServerPreparation> {
  const { serverName } = owner;
  owner.assertCurrent();
  context.assertCurrent();
  if (name !== serverName) {
    throw new Error(`MCP server "${name}" has no projection owner`);
  }
  if (context.capabilities.elicitation && !context.elicit) {
    throw new Error("MCP elicitation capability requires a handler");
  }
  if (context.capabilities.sampling && !context.createMessage) {
    throw new Error("MCP sampling capability requires a handler");
  }
  if (context.capabilities.extensions?.["openai/elicitation"] && !context.elicitCustom) {
    throw new Error("MCP custom elicitation capability requires a handler");
  }
  const rawServer = owner.getServerConfig();
  const override = owner.getConnectionOverride();
  const definition = resolveMcpTransportConfig(
    serverName,
    override ? applyMcpConnectionOverride(rawServer, override) : rawServer,
  );
  if (!definition) {
    throw new Error(`MCP server "${name}" has no supported transport`);
  }
  const eraKey =
    definition.kind === "stdio"
      ? createHash("sha256")
          .update(
            stableStringify({
              command: definition.command,
              args: definition.args,
              env: definition.env,
              cwd: definition.cwd ?? process.cwd(),
            }),
          )
          .digest("hex")
      : undefined;
  const cached =
    options?.negotiation !== "legacy" && eraKey ? nativeMcpEras.get(eraKey) : undefined;
  let stagedChild: NativeMcpServerRuntime | undefined;
  let stagedContext: NativeMcpRuntimeContext | undefined;
  let allowBinding: (() => void) | undefined;
  let rejectBinding: ((error: Error) => void) | undefined;
  let startup: Promise<McpToolCatalog> | undefined;
  let era: ProtocolEra;
  if (options?.negotiation === "legacy") {
    era = "legacy";
  } else if (cached) {
    era = await cached;
  } else {
    const detected = Promise.withResolvers<ProtocolEra>();
    const binding = Promise.withResolvers<void>();
    // A preparation can be released before startup reaches its binding gate.
    void binding.promise.catch(() => undefined);
    allowBinding = () => binding.resolve();
    rejectBinding = binding.reject;
    stagedContext = { ...context };
    stagedChild = owner.createChild(stagedContext, {
      bound: binding.promise,
      detected: (value) => detected.resolve(value),
      activate: () => binding.resolve(),
    });
    if (eraKey) {
      nativeMcpEras.set(eraKey, detected.promise);
    }
    startup = stagedChild.getCatalog();
    void startup.then((value) => {
      detected.reject(
        new Error(value.diagnostics?.[0]?.message ?? "MCP server did not negotiate an era"),
      );
    }, detected.reject);
    try {
      era = await detected.promise;
    } catch (error) {
      if (eraKey && nativeMcpEras.get(eraKey) === detected.promise) {
        nativeMcpEras.delete(eraKey);
      }
      rejectBinding(new Error("MCP preparation failed"));
      await owner.cleanupChild(stagedChild);
      throw error;
    }
  }
  let used = false;
  let released = false;
  let releasePromise: Promise<void> | undefined;
  const release = () =>
    (releasePromise ??= (async () => {
      released = true;
      if (!used && stagedChild) {
        rejectBinding?.(new Error("MCP preparation released"));
        await owner.cleanupChild(stagedChild);
        await startup?.catch(() => undefined);
      }
    })());
  const bind = async (roots?: NativeMcpRuntimeContext["roots"]) => {
    owner.assertCurrent();
    context.assertCurrent();
    if (released || used) {
      throw new Error("MCP preparation is no longer available");
    }
    used = true;
    const boundContext = roots ? { ...context, roots } : context;
    if (stagedContext) {
      const existing = [...owner.children].find(
        (candidate) =>
          candidate !== stagedChild &&
          candidate.nativeViewCount > 0 &&
          candidate.nativeContextKey === nativeMcpContextKey(boundContext, era) &&
          candidate.nativeCapabilityContext === context.capabilityContext,
      );
      if (existing && stagedChild) {
        rejectBinding?.(new Error("MCP preparation reused an existing context"));
        await owner.cleanupChild(stagedChild);
      } else {
        Object.assign(stagedContext, boundContext);
        allowBinding?.();
      }
    }
    try {
      return await owner.bindView(boundContext, era);
    } catch (error) {
      if (stagedChild) {
        await owner.cleanupChild(stagedChild);
      }
      throw error;
    }
  };
  const preparation: NativeMcpServerPreparation =
    era === "legacy"
      ? { era, bind: (roots) => bind(roots), release }
      : { era, bind: () => bind(), release };
  return preparation;
}

export function createNativeMcpServerView(
  runtime: SessionMcpRuntime,
  bound: ReturnType<ReturnType<typeof createNativeMcpClientBridge>["bind"]>,
  releaseView: () => void,
): NativeMcpServerView {
  let releasePromise: Promise<void> | undefined;
  return {
    runtime,
    ...bound.protocol,
    release() {
      return (releasePromise ??= (async () => {
        try {
          await bound.detach();
        } finally {
          releaseView();
        }
      })());
    },
  };
}

export function registerNativeMcpRuntime(
  owner: NativeMcpPreparationOwner,
  runtime: NativeMcpServerRuntime,
  getCatalog: () => Promise<McpToolCatalog>,
): void {
  nativeMcpRuntimeBindings.set(runtime, {
    hasServer: (name) => name === owner.serverName,
    async getCatalog(name) {
      if (name !== owner.serverName) {
        throw new Error(`MCP server "${name}" has no projection owner`);
      }
      return getCatalog();
    },
    prepare: (name, context, options) => prepareNativeMcpRuntime(owner, name, context, options),
  });
}
