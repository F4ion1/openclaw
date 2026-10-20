import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionMcpRuntime } from "../agents/agent-bundle-mcp-types.js";
import {
  createHarnessMcpFormResourceContext,
  type AgentHarnessMcpFormResourceParamsV1 as FormParams,
} from "./codex-mcp-projection.js";
type Origin = FormParams["origin"];

const mocks = vi.hoisted(() => ({
  create: vi.fn<(params: { origin: Origin }) => Promise<undefined>>(),
  upload: vi.fn<typeof import("../agents/mcp-form-resource-upload.js").prepareMcpAppFormUpload>(),
}));
vi.mock("../gateway/mcp-app-form-resources.js", () => ({
  createMcpAppFormResourceContext: mocks.create,
}));
vi.mock("../agents/mcp-form-resource-upload.js", () => ({ prepareMcpAppFormUpload: mocks.upload }));
beforeEach(() => {
  vi.resetAllMocks();
});

const runtime: SessionMcpRuntime = {
  sessionId: "form-session",
  sessionKey: "agent:main:form",
  workspaceDir: "/workspace",
  configFingerprint: "test",
  createdAt: 0,
  lastUsedAt: 0,
  getCatalog: async () => {
    throw new Error("unexpected discovery");
  },
  peekCatalog: () => null,
  markUsed: () => {},
  callTool: async () => {
    throw new Error("unexpected tool call");
  },
  dispose: async () => {},
};
function formParams(origin: Partial<Origin> = {}): FormParams {
  return {
    version: 1,
    requestId: "request",
    snapshot: {},
    signal: new AbortController().signal,
    origin: {
      runtime,
      serverName: "server",
      agentId: "main",
      sessionKey: "agent:main:form",
      assertCurrent: vi.fn(),
      ...origin,
    },
  };
}

describe("harness form capability boundary", () => {
  it("does not pass Gateway request options or an upload implementation to the harness", async () => {
    const prepareToolCall = vi.fn<NonNullable<Origin["prepareToolCall"]>>(async () => {});
    const params = formParams({ prepareToolCall });
    const { signal } = params;
    const { assertCurrent } = params.origin;
    await createHarnessMcpFormResourceContext(params);
    const created = mocks.create.mock.calls[0]![0];
    const publicRequest = {
      toolName: "preview",
      input: { id: "part" },
      assertCurrent,
      signal,
    };
    // Structural extras must not cross the SDK boundary.
    const request = { ...publicRequest, options: { secretDispatchState: "must stay in core" } };
    await created.origin.prepareToolCall?.(request);
    expect(prepareToolCall).toHaveBeenCalledWith(publicRequest);
    expect(created).not.toHaveProperty("version");
    expect(mocks.upload).toHaveBeenCalledOnce();
  });

  it("refuses resource preparation after origin closure", async () => {
    const params = formParams({
      assertCurrent: () => {
        throw new Error("origin closed");
      },
    });
    await expect(createHarnessMcpFormResourceContext(params)).rejects.toThrow("origin closed");
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.upload).not.toHaveBeenCalled();
  });
});
