// Turn-level provisioning resolution regressions (#92015).
// Covers invocation-scoped cwd decisions: mixed bindings on one agent and
// workspace-equal cwds keep standard bootstrap behavior.
import { describe, beforeEach, expect, it } from "vitest";
import { resolveConfiguredAcpBindingRecord } from "../acp/persistent-bindings.resolve.js";
import type { ChannelConfiguredBindingProvider } from "../channels/plugins/types.adapters.js";
import type { OpenClawConfig } from "../config/config.js";
import type { SessionAcpMeta } from "../config/sessions/types.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import { resolveAcpAgentWorkspaceProvisioningForTurn } from "./acp-workspace-provisioning.js";

const identityBindings: ChannelConfiguredBindingProvider = {
  compileConfiguredBinding: ({ conversationId }) => {
    const normalized = conversationId.trim();
    return normalized ? { conversationId: normalized } : null;
  },
  matchInboundConversation: ({ compiledBinding, conversationId }) =>
    compiledBinding.conversationId === conversationId ? { conversationId, matchPriority: 2 } : null,
};

beforeEach(() => {
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: "discord",
        plugin: { ...createChannelTestPluginBase({ id: "discord" }), bindings: identityBindings },
        source: "test",
      },
    ]),
  );
});

function acpBinding(
  conversationId: string,
  cwd?: string,
): NonNullable<OpenClawConfig["bindings"]>[number] {
  return {
    type: "acp",
    agentId: "codex",
    match: { channel: "discord", peer: { kind: "channel", id: conversationId } },
    ...(cwd ? { acp: { cwd } } : {}),
  } as NonNullable<OpenClawConfig["bindings"]>[number];
}

const baseCfg: OpenClawConfig = {
  agents: {
    defaults: { workspace: "/shared-ws" },
    entries: { main: {}, codex: { runtime: { type: "acp" } } },
  },
};

function sessionAcpMeta(cwd?: string): SessionAcpMeta {
  return {
    backend: "acpx",
    agent: "codex",
    runtimeSessionName: "rs",
    mode: "persistent",
    ...(cwd ? { cwd } : {}),
    state: "idle",
    lastActivityAt: 0,
  };
}

async function bindingSessionKey(cfg: OpenClawConfig, conversationId: string): Promise<string> {
  const resolved = resolveConfiguredAcpBindingRecord({
    cfg,
    channel: "discord",
    accountId: "default",
    conversationId,
  });
  return resolved?.record.targetSessionKey ?? "";
}

function expectProvisioning(
  expected: "standard" | "runtime-managed-implicit",
  params: Partial<Parameters<typeof resolveAcpAgentWorkspaceProvisioningForTurn>[0]> = {},
) {
  return expect(
    resolveAcpAgentWorkspaceProvisioningForTurn({ cfg: baseCfg, agentId: "codex", ...params }),
  ).resolves.toBe(expected);
}

describe("resolveAcpAgentWorkspaceProvisioningForTurn", () => {
  it("scopes the skip to the turn bound to a cwd-bearing binding (mixed bindings)", async () => {
    const cfg: OpenClawConfig = {
      ...baseCfg,
      bindings: [acpBinding("111", "/projects/app"), acpBinding("222")],
    };
    const keyWithCwd = await bindingSessionKey(cfg, "111");
    const keyWithoutCwd = await bindingSessionKey(cfg, "222");
    expect(keyWithCwd).not.toBe(keyWithoutCwd);

    await expectProvisioning("runtime-managed-implicit", { cfg, sessionKey: keyWithCwd });
    await expectProvisioning("standard", { cfg, sessionKey: keyWithoutCwd });
  });

  it("uses the live session ACP meta cwd as the invocation cwd", async () => {
    await expectProvisioning("runtime-managed-implicit", {
      sessionEntry: { acp: sessionAcpMeta("/projects/app") },
    });
    await expectProvisioning("standard", { sessionEntry: { acp: sessionAcpMeta() } });
  });

  it("keeps standard provisioning for embedded agents and explicit workspaces", async () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: { workspace: "/shared-ws" },
        entries: {
          work: { runtime: { type: "embedded" } },
          pinned: { workspace: "/explicit-ws", runtime: { type: "acp" } },
        },
      },
    };
    await expectProvisioning("standard", {
      cfg,
      agentId: "work",
      sessionEntry: { acp: sessionAcpMeta("/projects/app") },
    });
    await expectProvisioning("standard", {
      cfg,
      agentId: "pinned",
      sessionEntry: { acp: sessionAcpMeta("/projects/app") },
    });
  });

  it("falls back to the agent-global runtime acp.cwd default", async () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: { workspace: "/shared-ws" },
        entries: { codex: { runtime: { type: "acp", acp: { cwd: "/projects/app" } } } },
      },
    };
    await expectProvisioning("runtime-managed-implicit", { cfg });
  });
});
