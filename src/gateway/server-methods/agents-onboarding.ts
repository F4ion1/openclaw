import type {
  AgentsCreateParams,
  AgentsCreateResult,
} from "../../../packages/gateway-protocol/src/schema/agents-models-skills.js";
import { buildAssistantMessage, buildUsageWithNoCost } from "../../agents/stream-message-shared.js";
import { applyAgentConfig } from "../../commands/agents.config.js";
import { readConfigFileSnapshot } from "../../config/config.js";
import {
  getRuntimeConfigAppliedHash,
  hashRuntimeConfigValue,
} from "../../config/runtime-snapshot.js";
import { resolveAgentMainSessionKey } from "../../config/sessions/main-session.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { buildAgentOnboardingGreeting } from "../../shared/agent-onboarding.js";
import { runOutsideAsyncWorkScope } from "../../shared/async-work-scope.js";
import {
  OPENCLAW_TRANSCRIPT_ARTIFACT_API,
  OPENCLAW_TRANSCRIPT_ARTIFACT_PROVIDER,
} from "../../shared/transcript-only-openclaw-assistant.js";
import { verifySetupInferenceConfig } from "../../system-agent/setup-inference-turn.js";
import { resolveGatewayOperatorRoleActor } from "../operator-role-policy.js";
import { startSessionCreateDiagnostics } from "../session-create-diagnostics.js";
import { createGatewaySession } from "../session-create-service.js";
import { resolveOperatorSessionCreation } from "../session-creation-provenance.js";
import { handleTrustedInternalChatSend } from "./chat-send-handler.js";
import { emitSessionsChanged } from "./session-change-event.js";
import { readGatewayRequestMutationAuthority } from "./session-mutation-guards.js";
import { createSystemAgentGatewayRuntime } from "./system-agent-execution.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

export type PreparedAgentOnboarding = {
  expectedConfigHash: string | null;
  assertCurrent: () => void;
};

/** Verify the primary route before the creation owner writes any agent state. */
export async function prepareAgentOnboarding(
  options: GatewayRequestHandlerOptions,
  agentId: string,
  params: AgentsCreateParams,
): Promise<PreparedAgentOnboarding> {
  const authority = readGatewayRequestMutationAuthority(options);
  const runtimeConfig = options.context.getRuntimeConfig();
  const appliedHash = getRuntimeConfigAppliedHash();
  const assertCurrent = () => {
    authority.assertCurrent();
    if (
      appliedHash === null ||
      !options.context.isConfigReloadSettled() ||
      options.context.getRuntimeConfig() !== runtimeConfig ||
      getRuntimeConfigAppliedHash() !== appliedHash
    ) {
      throw new Error(
        "Gateway settings changed or are not active yet. Wait for application to finish, then retry creation.",
      );
    }
  };
  assertCurrent();
  const snapshot = await readConfigFileSnapshot();
  assertCurrent();
  if (
    !snapshot.exists ||
    !snapshot.valid ||
    hashRuntimeConfigValue(snapshot.sourceConfig) !== appliedHash
  ) {
    throw new Error(
      "Gateway settings are saved but not active yet. Wait for application to finish, then retry creation.",
    );
  }
  // Match creation's prospective model/workspace without publishing its roster entry.
  const candidate = applyAgentConfig(runtimeConfig, {
    agentId,
    ...(params.model ? { model: params.model } : {}),
    ...(params.workspace ? { workspace: params.workspace } : {}),
  });
  const verification = await verifySetupInferenceConfig({
    config: candidate,
    agentId,
    modelTarget: "primary",
    requireExecutionOwner: false,
    runtime: createSystemAgentGatewayRuntime(),
    assertSourceCurrent: assertCurrent,
    signal: options.signal,
  });
  assertCurrent();
  if (!verification.ok) {
    throw new Error(verification.error);
  }
  return {
    expectedConfigHash: snapshot.hash ?? null,
    assertCurrent,
  };
}

/** Creation has committed; greeting publication failure must retain that agent's receipt. */
export async function completeAgentOnboarding(
  options: GatewayRequestHandlerOptions,
  agentId: string,
  agentName?: string,
): Promise<NonNullable<AgentsCreateResult["onboarding"]>> {
  using diagnostics = startSessionCreateDiagnostics();
  const cfg = options.context.getRuntimeConfig();
  const sessionKey = resolveAgentMainSessionKey({ cfg, agentId });
  try {
    const authority = readGatewayRequestMutationAuthority(options);
    const created = await createGatewaySession({
      cfg,
      getCurrentConfig: options.context.getRuntimeConfig,
      agentId,
      key: sessionKey,
      commandSource: "webchat",
      creation: resolveOperatorSessionCreation(options.client),
      requestingOperatorScopes: options.client?.connect.scopes,
      requestingOperatorProfileId: options.client?.authenticatedUserProfile?.profileId,
      operatorRoleActor: resolveGatewayOperatorRoleActor(options.client),
      commitGuard: authority.assertCurrent,
      initialAssistantMessage: {
        // This is saved conversation, not model output or a delivery-only mirror.
        message: buildAssistantMessage({
          model: {
            api: OPENCLAW_TRANSCRIPT_ARTIFACT_API,
            provider: OPENCLAW_TRANSCRIPT_ARTIFACT_PROVIDER,
            id: "onboarding",
          },
          content: [{ type: "text", text: buildAgentOnboardingGreeting(agentName) }],
          stopReason: "stop",
          usage: buildUsageWithNoCost({}),
        }),
        idempotencyKey: `agents.create:${agentId}:opening`,
      },
      onPhase: diagnostics?.mark,
      onCreatedSessionCommitted: (session) =>
        options.sessionMutationAuthorization?.recordCreatedSession?.({
          agentId,
          sessionKey,
          storePath: session.storePath,
          sessionId: session.entry.sessionId,
          entry: session.entry,
          lifecycleRevision: session.entry.lifecycleRevision,
        }),
    });
    if (!created.ok) {
      throw new Error(created.error.message);
    }
    emitSessionsChanged(options.context, { agentId, sessionKey, reason: "created" });
    return { sessionKey, status: "completed" };
  } catch (error) {
    return { sessionKey, status: "error", error: formatErrorMessage(error) };
  }
}

/** Start the first real agent turn after the create receipt has reached the UI. */
export async function startAgentOnboardingConversation(
  options: GatewayRequestHandlerOptions,
  agentId: string,
  sessionKey: string,
): Promise<void> {
  const releaseAuthorization = options.sessionMutationAuthorization?.retain?.();
  using _ = { [Symbol.dispose]: () => releaseAuthorization?.() };
  let response: Parameters<GatewayRequestHandlerOptions["respond"]> | undefined;
  try {
    await runOutsideAsyncWorkScope(() =>
      handleTrustedInternalChatSend(
        {
          ...options,
          req: { ...options.req, method: "chat.send" },
          params: {
            sessionKey,
            agentId,
            message: [
              "A short introduction has already been saved in this agent's conversation. Call the ask_user tool now to continue onboarding; do not show the choices as plain text or use tool_search/dispatch_action.",
              'Use exactly this Ask User question shape: {"questions":[{"id":"primary_focus","header":"Main focus","question":"What do you want me helping with most?","multiSelect":false,"options":[{"label":"Calendar and scheduling"},{"label":"Notion notes and tasks"},{"label":"Research and summaries"},{"label":"Errands like shopping or bookings"}]}]}. Keep the short header separate from the full question. Do not add option values or other fields.',
              "After the user selects an option, ask one open-ended follow-up to learn a bit more about the specific thing they want to achieve. Tailor it to their selection, but do not provide another list or hard-code the follow-up wording. Then continue normally after they answer.",
              "This agent already exists. Do not propose creating an agent or ask the user to approve its creation.",
            ].join("\n\n"),
            idempotencyKey: `agents.create:${agentId}:onboarding-question`,
            deliver: false,
            suppressCommandInterpretation: true,
            systemInputProvenance: {
              kind: "internal_system",
              sourceTool: "agents_create_onboarding",
            },
          },
          respond: (...args) => {
            response ??= args;
          },
        },
        undefined,
        {
          transcript: { display: false },
          toolsAllow: ["ask_user"],
        },
      ),
    );
    if (response && !response[0]) {
      throw new Error(formatErrorMessage(response[2]));
    }
  } catch (error) {
    options.context.logGateway.warn(
      `could not start onboarding for agent ${agentId}: ${formatErrorMessage(error)}`,
    );
  }
}
