import type { SessionActivitySummary } from "../config/sessions/activity-summary.js";
import type { SessionEntry } from "../config/sessions/types.js";

type Offer = {
  summary: SessionActivitySummary;
  persist(onCommitted: (entry: SessionEntry) => void): Promise<unknown>;
};
export type SessionActivitySummaryCompletion = {
  take(): SessionActivitySummary | undefined;
  committed(entry: SessionEntry): void;
  settle(): Promise<void>;
};
export type PendingSessionActivitySummaryCompletion = {
  pending(): SessionActivitySummary | undefined;
  offer(summary: SessionActivitySummary, persist: Offer["persist"]): void;
  begin(): SessionActivitySummaryCompletion;
  flush(force?: boolean): Promise<void>;
  discard(): void;
};

/** A live completion carries ready recaps; its settled owner flushes late results. */
export function beginActivitySummaryCompletion(
  owner: { completion?: PendingSessionActivitySummaryCompletion },
  committed: (entry: SessionEntry) => void,
  failed: (error: unknown) => void,
): SessionActivitySummaryCompletion {
  if (!owner.completion) {
    let pending: Offer | undefined;
    let live = 0;
    let flushing: Promise<void> | undefined;
    const consume = (offer: Offer | undefined, entry: SessionEntry) => {
      // A receipt for an older offer must not consume a newer model result.
      if (pending === offer) {
        pending = undefined;
      }
      committed(entry);
    };
    const flush = async (force = false) => {
      if (live && !force) {
        return;
      }
      if (flushing) {
        return flushing;
      }
      flushing = (async () => {
        for (;;) {
          if (!pending || (live && !force)) {
            break;
          }
          const offer = pending;
          let received = false;
          await offer.persist((entry) => {
            received = true;
            consume(offer, entry);
          });
          if (!received) {
            break;
          }
        }
      })().catch(failed);
      try {
        await flushing;
      } finally {
        flushing = undefined;
      }
    };
    owner.completion = {
      pending: () => pending?.summary,
      offer(summary, persist) {
        pending = { summary, persist };
      },
      flush,
      discard() {
        pending = undefined;
      },
      begin() {
        live += 1;
        let active = true;
        let taken: Offer | undefined;
        return {
          take() {
            taken = pending;
            return taken?.summary;
          },
          committed(entry) {
            consume(taken, entry);
          },
          async settle() {
            // Both terminal completion and pre-completion failure cleanup may settle.
            if (active) {
              active = false;
              live -= 1;
            }
            await flush();
          },
        };
      },
    };
  }
  return owner.completion.begin();
}
