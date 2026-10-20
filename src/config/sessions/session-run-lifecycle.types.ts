import type { AgentRunTerminalOutcome } from "../../agents/agent-run-terminal-outcome.types.js";
import type { ProviderReviewTerminalFact } from "./provider-review.types.js";

export type SessionLifecycleProviderReview = Pick<
  ProviderReviewTerminalFact,
  "target" | "expectedWriterRunId" | "review"
>;

export type SessionLifecyclePatchInput = {
  event: LifecycleEventLike;
  currentLifecycleGeneration: string;
  lastRunError?: string;
  canonicalKey: string;
  lifecycleRevision?: string;
  exactCronRun: boolean;
  providerReview?: SessionLifecycleProviderReview;
  expectedWriter?: {
    requireYielded?: true;
    runId: string;
    sessionId: string;
    lifecycleRevision?: string;
  };
};

export type SessionLifecyclePatchEffects = {
  terminalRecovery?: { runId: string; outcome: AgentRunTerminalOutcome };
  failedRun?: {
    runId: string;
    error: unknown;
    errorKind?: "state_contention";
    suppressErrorNotice?: boolean;
  };
};

export type LifecyclePhase = "start" | "end" | "error";

export type LifecycleEventLike = { ts: number; sessionId?: string } & {
  controlUiVisible?: boolean;
  isHeartbeat?: boolean;
  contextClaimId?: string;
  runId?: string;
  clientRunId?: string;
  lifecycleGeneration?: string;
  mainSessionRestartRecovery?: true;
  data?: {
    phase?: unknown;
    startedAt?: unknown;
    endedAt?: unknown;
    aborted?: unknown;
    stopReason?: unknown;
    error?: unknown;
    errorKind?: unknown;
    suppressErrorNotice?: unknown;
    executionStarted?: unknown;
    livenessState?: unknown;
    timeoutPhase?: unknown;
    providerStarted?: unknown;
    yielded?: unknown;
    status?: unknown;
  };
};
