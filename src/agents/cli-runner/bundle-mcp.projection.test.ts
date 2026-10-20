import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  clearActiveMcpLoopbackRuntimeByOwnerToken,
  setActiveMcpLoopbackRuntime,
} from "../../gateway/mcp-http.loopback-runtime.js";
import { peekSessionMcpRuntime } from "../agent-bundle-mcp-manager-api.js";
import {
  readMcpConfig,
  trackMcpPreparation,
  userMcpConfig,
} from "./bundle-mcp-fixtures.test-support.js";
import { prepareCliBundleMcpCaptureAttempt, prepareCliBundleMcpConfig } from "./bundle-mcp.js";
import {
  cliBundleMcpHarness,
  cliNativeMcpPolicyContext,
  setupCliBundleMcpTestHarness,
} from "./bundle-mcp.test-support.js";

setupCliBundleMcpTestHarness();

const ownerToken = "projection-config-test-owner";
afterEach(() => clearActiveMcpLoopbackRuntimeByOwnerToken(ownerToken));

function activateListener(port = 23456) {
  // This test inspects the generated client config; protocol and socket behavior
  // are exercised by the Gateway projection integration suite.
  setActiveMcpLoopbackRuntime({ port, ownerToken, nonOwnerToken: "projection-test-non-owner" });
}

async function prepare(config: OpenClawConfig, sessionId: string, token = "projection-token") {
  return await trackMcpPreparation(
    prepareCliBundleMcpConfig({
      enabled: true,
      mode: "claude-config-file",
      backend: { command: "claude", args: ["--print"] },
      workspaceDir: cliBundleMcpHarness.bundleProbeWorkspaceDir,
      config,
      env: { OPENCLAW_MCP_TOKEN: token, OPENCLAW_MCP_CLI_CAPTURE_KEY: "" },
      nativeMcpPolicy: cliNativeMcpPolicyContext(config, sessionId),
    }),
  );
}

describe("Claude native MCP projection config", () => {
  it("replaces stdio commands with authenticated routes without starting discovery", async () => {
    activateListener();
    const startedPath = path.join(cliBundleMcpHarness.bundleProbeWorkspaceDir, "unexpected-start");
    const config = userMcpConfig({
      "docs.prod": {
        command: process.execPath,
        args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(startedPath)}, 'started')`],
        env: { FIXTURE: "stdio-secret" },
      },
    });
    const prepared = await prepare(config, "projection-command");
    const result = await readMcpConfig(prepared);
    expect(Object.keys(result.mcpServers ?? {})).toEqual(["docs.prod"]);
    expect(result.mcpServers?.["docs.prod"]).toEqual({
      type: "http",
      url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:23456\/mcp\/native\//),
      headers: {
        Authorization: "Bearer projection-token",
        "x-openclaw-cli-capture-key": "",
      },
    });
    expect(peekSessionMcpRuntime({ sessionId: "projection-command" })?.peekCatalog()).toBeNull();
    await expect(fs.stat(startedPath)).rejects.toMatchObject({ code: "ENOENT" });

    await prepareCliBundleMcpCaptureAttempt({
      preparedBackend: prepared,
      captureKey: "next-attempt",
    });
    expect(Object.keys((await readMcpConfig(prepared)).mcpServers ?? {})).toEqual(["docs.prod"]);
    expect((await readMcpConfig(prepared)).mcpServers?.["docs.prod"]?.headers).toEqual({
      Authorization: "Bearer projection-token",
      "x-openclaw-cli-capture-key": "next-attempt",
    });
  });

  it("keeps resume identity across generated routes but invalidates changed definitions", async () => {
    const config = userMcpConfig({ docs: { command: process.execPath, args: ["first.mjs"] } });
    activateListener(23456);
    const first = await prepare(config, "projection-resume", "first-token");
    activateListener(23457);
    const next = await prepare(config, "projection-resume", "second-token");
    expect(next.mcpResumeHash).toBe(first.mcpResumeHash);
    expect((await readMcpConfig(next)).mcpServers?.docs?.url).not.toBe(
      (await readMcpConfig(first)).mcpServers?.docs?.url,
    );
    const changed = await prepare(
      userMcpConfig({ docs: { command: process.execPath, args: ["second.mjs"] } }),
      "projection-resume",
    );
    expect(changed.mcpResumeHash).not.toBe(first.mcpResumeHash);
    const restricted = await prepare(
      { ...config, tools: { deny: ["docs__delete_docs"] } },
      "projection-resume",
    );
    expect(restricted.mcpResumeHash).not.toBe(first.mcpResumeHash);
  });

  it("omits stdio with a diagnostic when no authenticated listener is available", async () => {
    const warn = vi.fn();
    const config = userMcpConfig({
      docs: { command: process.execPath, args: ["never-start.mjs"] },
    });
    const prepared = await trackMcpPreparation(
      prepareCliBundleMcpConfig({
        enabled: true,
        mode: "claude-config-file",
        backend: { command: "claude" },
        workspaceDir: cliBundleMcpHarness.bundleProbeWorkspaceDir,
        config,
        nativeMcpPolicy: cliNativeMcpPolicyContext(config, "projection-unavailable"),
        warn,
      }),
    );
    expect((await readMcpConfig(prepared)).mcpServers).toEqual({});
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("docs"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("loopback"));
  });
});
