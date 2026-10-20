import type { SessionActivitySummary } from "../config/sessions/activity-summary.js";
import type { SessionEntry } from "../config/sessions/types.js";

export type SessionActivitySummaryCompletion = {
  take(): SessionActivitySummary | undefined;
  committed(entry: SessionEntry): void;
};

export type PendingSessionActivitySummaryCompletion = SessionActivitySummaryCompletion & {
  pending(): SessionActivitySummary | undefined;
  offer(summary: SessionActivitySummary): void;
};

/** Keep one recap with its bounded session owner until a reply completion commits it. */
export function beginActivitySummaryCompletion(
  owner: { completion?: PendingSessionActivitySummaryCompletion },
  committed: (entry: SessionEntry) => void,
): SessionActivitySummaryCompletion {
  if (!owner.completion) {
    let pending: SessionActivitySummary | undefined;
    let taken: SessionActivitySummary | undefined;
    owner.completion = {
      pending: () => pending,
      offer(summary) {
        pending = summary;
      },
      take() {
        // Never wait for optional model work. Late recaps ride the next completion.
        taken = pending;
        return taken;
      },
      committed(entry) {
        if (pending === taken) {
          pending = undefined;
        }
        committed(entry);
      },
    };
  }
  return owner.completion;
}
