import type {
  Client,
  McpSubscription,
  RequestOptions,
  SubscribeRequestParams,
} from "@modelcontextprotocol/client";
import type { NativeMcpRequestOptions } from "./native-mcp-runtime.js";

export type NativeMcpResourceLease = { release: () => Promise<void> };
type ResourceOwner = { resources: Set<string>; assertCurrent: () => void };
type ResourceSubscription<Owner> = {
  owners: Map<Owner, number>;
  opened: Promise<void>;
  stream?: McpSubscription;
  ended: boolean;
  closing?: Promise<void>;
};
type OpenRequest = <T>(
  request: (options: RequestOptions & { signal: AbortSignal }) => Promise<T>,
) => Promise<T>;

/** One wire subscription per URI, shared only inside its native capability context. */
export function createNativeMcpResourceSubscriptions<Owner extends ResourceOwner>(params: {
  client: Client;
  signal: AbortSignal;
  isClosed: () => boolean;
  ended: (uri: string, owners: Set<Owner>) => void;
  closeLegacy: (uri: string) => Promise<unknown>;
}) {
  const subscriptions = new Map<string, ResourceSubscription<Owner>>();
  const leases = new Map<Owner, Set<NativeMcpResourceLease>>();
  const defaults = new Map<Owner, Map<string, Promise<NativeMcpResourceLease>>>();
  const assertCurrent = (owner: Owner, options: NativeMcpRequestOptions) => {
    owner.assertCurrent();
    options.signal.throwIfAborted();
    options.assertCurrent();
  };
  const close = (uri: string, subscription: ResourceSubscription<Owner>) =>
    (subscription.closing ??= (async () => {
      try {
        await subscription.opened.catch(() => undefined);
        if (!subscription.ended) {
          subscription.ended = true;
          if (subscription.stream) {
            await subscription.stream.close();
          } else if (!params.isClosed() && !params.signal.aborted) {
            await params.closeLegacy(uri);
          }
        }
      } finally {
        if (subscriptions.get(uri) === subscription) {
          subscriptions.delete(uri);
        }
      }
    })());

  async function acquire(
    owner: Owner,
    input: SubscribeRequestParams,
    options: NativeMcpRequestOptions,
    run: OpenRequest,
  ): Promise<NativeMcpResourceLease> {
    assertCurrent(owner, options);
    let subscription = subscriptions.get(input.uri);
    while (subscription?.closing) {
      await subscription.closing;
      assertCurrent(owner, options);
      subscription = subscriptions.get(input.uri);
    }
    if (!subscription) {
      const created: ResourceSubscription<Owner> = {
        owners: new Map(),
        opened: Promise.resolve(),
        ended: false,
      };
      subscription = created;
      subscriptions.set(input.uri, created);
      created.opened = run(async (request) => {
        if (params.client.getProtocolEra() !== "modern") {
          await params.client.request({ method: "resources/subscribe", params: input }, request);
          return;
        }
        const opening = new AbortController();
        const onAbort = () => opening.abort(request.signal.reason);
        request.signal.addEventListener("abort", onAbort, { once: true });
        if (request.signal.aborted) {
          onAbort();
        }
        try {
          created.stream = await params.client.listen(
            { resourceSubscriptions: [input.uri] },
            { ...request, signal: AbortSignal.any([params.signal, opening.signal]) },
          );
          if (!created.stream.honoredFilter.resourceSubscriptions?.includes(input.uri)) {
            throw new Error("MCP server did not subscribe to the requested resource");
          }
          void created.stream.closed.then((reason) => {
            if (created.ended) {
              return;
            }
            created.ended = true;
            if (subscriptions.get(input.uri) === created) {
              subscriptions.delete(input.uri);
              for (const holder of created.owners.keys()) {
                holder.resources.delete(input.uri);
                defaults.get(holder)?.delete(input.uri);
              }
            }
            if (reason !== "local") {
              params.ended(input.uri, new Set(created.owners.keys()));
            }
          });
        } finally {
          // The admission request bounds startup; the shared resource state owns the stream afterward.
          request.signal.removeEventListener("abort", onAbort);
        }
      }).catch(async (error: unknown) => {
        created.ended = true;
        try {
          if (created.stream) {
            await created.stream.close();
          } else if (
            params.client.getProtocolEra() === "legacy" &&
            !params.isClosed() &&
            !params.signal.aborted
          ) {
            // A post-response authority check can reject after the peer accepted subscribe.
            await params.closeLegacy(input.uri);
          }
        } finally {
          if (subscriptions.get(input.uri) === created) {
            subscriptions.delete(input.uri);
          }
        }
        throw error;
      });
    }
    const owned = subscription;
    owned.owners.set(owner, (owned.owners.get(owner) ?? 0) + 1);
    owner.resources.add(input.uri);
    let ownerLeases = leases.get(owner);
    if (!ownerLeases) {
      ownerLeases = new Set();
      leases.set(owner, ownerLeases);
    }
    const retainedLeases = ownerLeases;
    let releasePromise: Promise<void> | undefined;
    const lease: NativeMcpResourceLease = {
      release() {
        return (releasePromise ??= (async () => {
          retainedLeases.delete(lease);
          if (retainedLeases.size === 0) {
            leases.delete(owner);
          }
          const remaining = owned.owners.get(owner)! - 1;
          if (remaining === 0) {
            owned.owners.delete(owner);
            const current = subscriptions.get(input.uri);
            if (!current || current === owned || !current.owners.has(owner)) {
              owner.resources.delete(input.uri);
            }
          } else {
            owned.owners.set(owner, remaining);
          }
          if (owned.owners.size === 0) {
            await close(input.uri, owned);
          }
        })());
      },
    };
    retainedLeases.add(lease);
    try {
      await owned.opened;
      assertCurrent(owner, options);
      if (owned.ended) {
        throw new Error("MCP resource subscription closed during admission");
      }
      return lease;
    } catch (error) {
      await lease.release();
      throw error;
    }
  }
  return {
    acquire,
    async subscribe(
      owner: Owner,
      input: SubscribeRequestParams,
      options: NativeMcpRequestOptions,
      run: OpenRequest,
    ) {
      assertCurrent(owner, options);
      let ownerDefaults = defaults.get(owner);
      if (!ownerDefaults) {
        ownerDefaults = new Map();
        defaults.set(owner, ownerDefaults);
      }
      const retained = ownerDefaults;
      let lease = retained.get(input.uri);
      if (!lease) {
        lease = acquire(owner, input, options, run);
        retained.set(input.uri, lease);
      }
      try {
        await lease;
        assertCurrent(owner, options);
        return {};
      } catch (error) {
        if (retained.get(input.uri) === lease) {
          retained.delete(input.uri);
        }
        throw error;
      }
    },
    async unsubscribe(
      owner: Owner,
      input: SubscribeRequestParams,
      options: NativeMcpRequestOptions,
    ) {
      assertCurrent(owner, options);
      const ownerDefaults = defaults.get(owner);
      const lease = ownerDefaults?.get(input.uri);
      ownerDefaults?.delete(input.uri);
      await (await lease)?.release();
      return {};
    },
    releaseOwner(owner: Owner): Promise<PromiseSettledResult<void>[]> {
      defaults.delete(owner);
      return Promise.allSettled([...(leases.get(owner) ?? [])].map((lease) => lease.release()));
    },
  };
}
