import type {
  SessionLifecyclePatchEffects,
  SessionLifecyclePatchInput,
} from "../config/sessions/session-run-lifecycle.types.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import type { AgentRunDelegatedAuthority } from "./agent-run-authority.types.js";
import {
  getAgentRunContext,
  getAgentRunLifecycleGeneration,
  validateAgentRunDelegatedAuthority,
} from "./agent-run-registry.js";
import type { AgentRunContext } from "./agent-run-registry.types.js";

type OperationalRunInstance = AgentRunDelegatedAuthority["operationalRunInstance"];
type TerminalWriteContext = { run: <T>(write: () => T) => T };
export type AgentRunTerminalEntryWrite = {
  target: { agentId?: string; storePath: string; sessionKey: string };
  lifecycle: SessionLifecyclePatchInput;
  run?: TerminalWriteContext["run"];
  assertCurrent?: () => void;
  persist: () => Promise<InternalSessionEntry | null>;
  committed(entry: InternalSessionEntry | null, effects?: SessionLifecyclePatchEffects): void;
};

type DeferredTerminalEntry = {
  prepared: Promise<AgentRunTerminalEntryWrite | undefined>;
  resolve: (entry: InternalSessionEntry | null) => void;
  reject: (error: unknown) => void;
};

export type AgentRunTerminalEntryCommit = {
  write: AgentRunTerminalEntryWrite;
  committed(entry: InternalSessionEntry | null, effects?: SessionLifecyclePatchEffects): void;
  failed(error: unknown): void;
};

type TerminalWrites = {
  owner: AgentRunContext;
  instance: OperationalRunInstance;
  context?: TerminalWriteContext;
  pending: Set<Promise<void>>;
  entry?: "available" | DeferredTerminalEntry;
};

const terminalWrites = new WeakMap<AgentRunContext, TerminalWrites>();
// Execution cleanup cannot discard terminal work already accepted by the lifecycle owner.
const operationalTerminalWrites = new WeakMap<OperationalRunInstance, TerminalWrites>();

function prepareTerminalWrites(owner: AgentRunContext, instance: OperationalRunInstance) {
  let current = terminalWrites.get(owner);
  const retained = operationalTerminalWrites.get(instance);
  if (
    (retained && current !== retained) ||
    (owner.delegatedAuthority && owner.delegatedAuthority.operationalRunInstance !== instance)
  ) {
    throw new Error("Terminal write settlement owner changed");
  }
  if (!current || current.instance !== instance) {
    current = { owner, instance, pending: new Set() };
    terminalWrites.set(owner, current);
  }
  operationalTerminalWrites.set(instance, current);
  return current;
}

/** Register settlement before a projected turn can fail prior to runtime admission. */
export function bindAgentRunTerminalWriteSettlement(
  instance: OperationalRunInstance,
  deferEntry = false,
): void {
  const owner = getAgentRunContext(instance.runId);
  if (owner) {
    const current = prepareTerminalWrites(owner, instance);
    if (deferEntry) {
      current.entry ??= "available";
    }
  }
}

function trackTerminalWrite(current: TerminalWrites, persistence: Promise<void>): void {
  current.pending.add(persistence);
  const settled = () => current.pending.delete(persistence);
  void persistence.then(settled, settled);
}

/** Capture accepted-work settlement independently of permission to perform a write. */
export function captureAgentRunTerminalPersistence(
  runId: string,
  owner = getAgentRunContext(runId),
) {
  const writeContext = captureAgentRunTerminalWriteContext(runId, owner);
  const current = owner ? terminalWrites.get(owner) : undefined;
  return {
    writeContext,
    track:
      writeContext?.track ??
      (current
        ? (persistence: Promise<void>) => trackTerminalWrite(current, persistence)
        : undefined),
  };
}

/** Bind a prepared runtime's write context to its exact live operational owner. */
export function bindAgentRunTerminalWriteContext(
  authority: AgentRunDelegatedAuthority,
  context: TerminalWriteContext,
): void {
  const owner = getAgentRunContext(authority.operationalRunInstance.runId);
  if (owner?.delegatedAuthority !== authority || !validateAgentRunDelegatedAuthority(authority)) {
    throw new Error("Terminal write owner is no longer active");
  }
  const current = prepareTerminalWrites(owner, authority.operationalRunInstance);
  current.context = context;
}

/** A new fallback candidate cannot borrow the preceding runtime's account context. */
export function clearAgentRunTerminalWriteContext(instance: OperationalRunInstance): void {
  const owner = getAgentRunContext(instance.runId);
  const current = owner ? terminalWrites.get(owner) : undefined;
  if (owner && current?.instance === instance) {
    const replacement = { ...current, context: undefined };
    terminalWrites.set(owner, replacement);
    operationalTerminalWrites.set(instance, replacement);
  }
}

export type CapturedAgentRunTerminalWriteContext = TerminalWriteContext & {
  assertCurrent: () => void;
  track: (persistence: Promise<void>) => void;
  prepareEntry?: (
    persist: (
      defer?: (write: AgentRunTerminalEntryWrite) => Promise<InternalSessionEntry | null>,
    ) => Promise<void>,
  ) => Promise<void>;
};

/** Capture before async session resolution; a replaced candidate revokes this exact capture. */
function captureAgentRunTerminalWriteContext(
  runId: string,
  owner: AgentRunContext | undefined,
): CapturedAgentRunTerminalWriteContext | undefined {
  if (!owner?.lifecycleGeneration) {
    return undefined;
  }
  const refuse = (): never => {
    throw new Error("Terminal write owner changed before commit");
  };
  const authority = owner.delegatedAuthority;
  const current = authority
    ? prepareTerminalWrites(owner, authority.operationalRunInstance)
    : terminalWrites.get(owner);
  if (!current) {
    return undefined;
  }
  // Execution may already be revoked. Settlement retains only this run's
  // lifecycle/candidate binding; the session writer checks its durable target.
  const lifecycleGeneration = owner.lifecycleGeneration;
  const captured = current;
  const context = captured.context;
  const assertCurrent = () => {
    const currentOwner = getAgentRunContext(runId);
    if (
      getAgentRunLifecycleGeneration() !== lifecycleGeneration ||
      (currentOwner && currentOwner !== owner) ||
      terminalWrites.get(owner) !== captured ||
      captured.context !== context ||
      (owner.delegatedAuthority &&
        owner.delegatedAuthority.operationalRunInstance !== captured.instance)
    ) {
      refuse();
    }
  };
  return {
    assertCurrent,
    run: (write) => {
      assertCurrent();
      return context ? context.run(write) : write();
    },
    track: (persistence) => trackTerminalWrite(captured, persistence),
    prepareEntry: captured.entry
      ? (persist) => {
          if (captured.entry !== "available") {
            return persist();
          }
          const ready = Promise.withResolvers<AgentRunTerminalEntryWrite | undefined>();
          const result = Promise.withResolvers<InternalSessionEntry | null>();
          captured.entry = {
            prepared: ready.promise,
            resolve: result.resolve,
            reject: result.reject,
          };
          const settled = persist((write) => {
            ready.resolve({
              ...write,
              run: context?.run,
              persist: () => (context ? context.run(write.persist) : write.persist()),
            });
            return result.promise;
          });
          void settled.then(
            () => ready.resolve(undefined),
            () => ready.resolve(undefined),
          );
          return settled;
        }
      : undefined,
  };
}

/** Transfer a prepared lifecycle patch to the same target's final actor transaction. */
export async function takeAgentRunTerminalEntry(
  instance: OperationalRunInstance,
  target: AgentRunTerminalEntryWrite["target"],
): Promise<AgentRunTerminalEntryCommit | undefined> {
  const current = operationalTerminalWrites.get(instance);
  if (!current) {
    return undefined;
  }
  const entry = current.entry;
  if (!entry || entry === "available") {
    current.entry = undefined;
    return undefined;
  }
  const write = await entry.prepared;
  if (
    !write ||
    write.target.storePath !== target.storePath ||
    write.target.sessionKey !== target.sessionKey ||
    write.target.agentId !== target.agentId
  ) {
    return undefined;
  }
  current.entry = undefined;
  return {
    write,
    committed(postimage, effects) {
      try {
        write.committed(postimage, effects);
        entry.resolve(postimage);
      } catch (error) {
        entry.reject(error);
      }
    },
    failed: entry.reject,
  };
}

/** Join accepted terminal writes, then retire their binding; execution close stays immediate. */
export async function drainAgentRunTerminalWrites(instance: OperationalRunInstance): Promise<void> {
  const current = operationalTerminalWrites.get(instance);
  if (current) {
    const entry = current.entry;
    current.entry = undefined;
    if (entry && entry !== "available") {
      try {
        entry.resolve((await (await entry.prepared)?.persist()) ?? null);
      } catch (error) {
        entry.reject(error);
      }
    }
    while (current.pending.size > 0) {
      await Promise.allSettled(current.pending);
    }
    if (terminalWrites.get(current.owner)?.instance === instance) {
      terminalWrites.delete(current.owner);
    }
    operationalTerminalWrites.delete(instance);
  }
}
