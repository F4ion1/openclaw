import fs from "node:fs/promises";
import path from "node:path";
import type { CreateMessageResultWithTools } from "@modelcontextprotocol/client";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  openFixtureReceiptChannel,
  type FixtureReceiptChannel,
} from "../../test/helpers/fixture-receipts.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createSessionMcpRuntime } from "./agent-bundle-mcp-runtime.js";
import type { SessionMcpRuntime } from "./agent-bundle-mcp-types.js";
import { prepareNativeMcpServer } from "./native-mcp-runtime.js";
import {
  context,
  options,
  payload,
  processId,
  writeNativeMcpFixture,
} from "./native-mcp-runtime.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const runtimes: SessionMcpRuntime[] = [];
let receipts: FixtureReceiptChannel;
beforeAll(async () => {
  receipts = await openFixtureReceiptChannel();
});
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
});
afterAll(async () => {
  await receipts.close();
});

async function fixture(era: "legacy" | "modern" | "dual", terminateProbe = false) {
  const directory = tempDirs.make("native-mcp-staged-");
  const file = path.join(directory, "server.mjs");
  await writeNativeMcpFixture(file, receipts.endpoint, era === "dual" ? "modern" : era);
  if (era === "dual") {
    const source = await fs.readFile(file, "utf8");
    await fs.writeFile(file, source.replace('{ legacy: "reject" }', '{ legacy: "serve" }'));
  }
  if (terminateProbe) {
    const source = await fs.readFile(file, "utf8");
    await fs.writeFile(
      file,
      source.replace(
        'record("recv " + message.method);',
        'record("recv " + message.method); if (message.method === "server/discover") process.exit(23);',
      ),
    );
  }
  const runtime = createSessionMcpRuntime({
    sessionId: `staged-${era}`,
    workspaceDir: directory,
    cfg: {
      plugins: { enabled: false },
      mcp: { servers: { fixture: { command: process.execPath, args: [file] } } },
    },
  });
  runtimes.push(runtime);
  const log = async () => (await fs.readFile(file + ".log", "utf8")).trim().split("\n");
  return { runtime, file, log };
}

describe("staged native MCP ownership", () => {
  it("defers explicit legacy until roots bind and keeps auto era observations separate", async ({
    signal,
  }) => {
    const { runtime, file, log } = await fixture("dual");
    const caller = context();
    const prepareLegacy = () =>
      prepareNativeMcpServer(runtime, "fixture", caller, { negotiation: "legacy" });
    const legacy = await prepareLegacy();
    expect(legacy.era).toBe("legacy");
    await expect(fs.stat(file + ".log")).rejects.toMatchObject({ code: "ENOENT" });
    if (legacy.era !== "legacy") {
      throw new Error("Expected explicit legacy preparation");
    }
    const legacyView = await legacy.bind(caller.roots);
    await legacy.release();
    expect(legacyView.getProtocolEra()).toBe("legacy");
    expect((await log()).filter((line) => line.startsWith("started "))).toHaveLength(1);

    const modern = await prepareNativeMcpServer(runtime, "fixture", caller, {
      negotiation: "auto",
    });
    expect(modern.era).toBe("modern");
    if (modern.era !== "modern") {
      throw new Error("Expected auto modern preparation");
    }
    const modernView = await modern.bind();
    await modern.release();
    expect(modernView.getProtocolEra()).toBe("modern");
    expect((await log()).filter((line) => line.startsWith("started "))).toHaveLength(2);

    const again = await prepareLegacy();
    if (again.era !== "legacy") {
      throw new Error("Expected explicit legacy preparation");
    }
    const sameLegacyView = await again.bind(caller.roots);
    await again.release();
    expect(sameLegacyView.getProtocolEra()).toBe("legacy");
    const autoAgain = await prepareNativeMcpServer(runtime, "fixture", caller);
    if (autoAgain.era !== "modern") {
      throw new Error("Explicit legacy overwrote auto observation");
    }
    const sameModernView = await autoAgain.bind();
    await autoAgain.release();
    expect(sameModernView.getProtocolEra()).toBe("modern");
    await sameLegacyView.listTools(undefined, options(signal));
    await sameModernView.listTools(undefined, options(signal));
    expect((await log()).filter((line) => line.startsWith("started "))).toHaveLength(2);
    await Promise.all([
      legacyView.release(),
      modernView.release(),
      sameLegacyView.release(),
      sameModernView.release(),
    ]);
  });

  it("rejects explicit legacy for a modern-only upstream after binding", async () => {
    const { runtime, file, log } = await fixture("modern");
    const prepared = await prepareNativeMcpServer(runtime, "fixture", context(), {
      negotiation: "legacy",
    });
    if (prepared.era !== "legacy") {
      throw new Error("Expected explicit legacy preparation");
    }
    await expect(fs.stat(file + ".log")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(prepared.bind({ roots: [] })).rejects.toThrow();
    await prepared.release();
    expect((await log()).filter((line) => line.startsWith("started "))).toHaveLength(1);
    const auto = await prepareNativeMcpServer(runtime, "fixture", context());
    expect(auto.era).toBe("modern");
    await auto.release();
  });

  it.for([false, true])(
    "binds roots before legacy initialization and reuses the detected era (probe exit: %s)",
    async (terminateProbe, { signal }) => {
      const { runtime, log } = await fixture("legacy", terminateProbe);
      const caller = context();
      const prepared = await prepareNativeMcpServer(runtime, "fixture", caller);
      expect(prepared.era).toBe("legacy");
      expect(await log()).not.toContain("recv initialize");
      if (prepared.era !== "legacy") {
        throw new Error("Expected legacy preparation");
      }
      const first = await prepared.bind(caller.roots);
      await prepared.release();
      const firstValue = payload(
        await first.callTool({ name: "probe", arguments: {} }, options(signal)),
      );
      expect(firstValue).toMatchObject({ roots: caller.roots });
      const firstPid = processId(firstValue);
      const beforeReuse = await log();
      const again = await prepareNativeMcpServer(runtime, "fixture", caller);
      expect(await log()).toEqual(beforeReuse);
      if (again.era !== "legacy") {
        throw new Error("Expected cached legacy era");
      }
      const second = await again.bind(caller.roots);
      await again.release();
      expect(
        processId(
          payload(await second.callTool({ name: "probe", arguments: {} }, options(signal))),
        ),
      ).toBe(firstPid);
      const changedRoots = { roots: [{ uri: "file:///workspace/changed" }] };
      const changed = await prepareNativeMcpServer(runtime, "fixture", caller);
      if (changed.era !== "legacy") {
        throw new Error("Expected cached legacy era");
      }
      const third = await changed.bind(changedRoots);
      await changed.release();
      const thirdValue = payload(
        await third.callTool({ name: "probe", arguments: {} }, options(signal)),
      );
      expect(thirdValue).toMatchObject({ roots: changedRoots });
      const thirdPid = processId(thirdValue);
      expect(thirdPid).not.toBe(firstPid);
      const lines = await log();
      expect(lines.filter((line) => line === "recv server/discover")).toHaveLength(1);
      expect(lines.filter((line) => line.startsWith("started "))).toHaveLength(
        terminateProbe ? 3 : 2,
      );
      await Promise.all([first.release(), second.release(), third.release()]);
      for (const line of lines.filter((entry) => entry.startsWith("started "))) {
        expect(() => process.kill(Number(line.slice(8)), 0)).toThrow(
          expect.objectContaining({ code: "ESRCH" }),
        );
      }
    },
  );

  it("binds modern discovery without an invented roots snapshot and preserves continuation input", async ({
    signal,
  }) => {
    const { runtime, log } = await fixture("modern");
    const caller = context();
    Object.defineProperty(caller, "roots", {
      get() {
        throw new Error("Modern prepare read legacy roots");
      },
    });
    const prepared = await prepareNativeMcpServer(runtime, "fixture", caller);
    expect(prepared.era).toBe("modern");
    if (prepared.era !== "modern") {
      throw new Error("Expected modern preparation");
    }
    const beforeBind = await log();
    expect(beforeBind.filter((line) => line.startsWith("started "))).toHaveLength(1);
    const view = await prepared.bind();
    await prepared.release();
    try {
      const pending = await view.callTool({ name: "probe", arguments: {} }, options(signal));
      if (pending.kind !== "input-required") {
        throw new Error("Expected native roots continuation");
      }
      expect(pending.result.inputRequests).toEqual({ roots: { method: "roots/list" } });
      expect(
        payload(
          await pending.resume(
            { roots: { roots: [{ uri: "file:///from-continuation" }] } },
            options(signal),
          ),
        ),
      ).toMatchObject({ responses: { roots: { roots: [{ uri: "file:///from-continuation" }] } } });
      expect((await log()).filter((line) => line.startsWith("started "))).toHaveLength(1);
    } finally {
      await view.release();
    }
  });

  it("preserves rich sampling responses through the native continuation", async ({ signal }) => {
    const { runtime, file } = await fixture("modern");
    const source = await fs.readFile(file, "utf8");
    await fs.writeFile(
      file,
      source.replace(
        'inputRequests: { roots: { method: "roots/list" } }',
        'inputRequests: { sampling: { method: "sampling/createMessage", params: { messages: [], maxTokens: 8, tools: [{ name: "lookup", inputSchema: { type: "object", properties: {} } }] } } }',
      ),
    );
    const sampling: CreateMessageResultWithTools = {
      role: "assistant",
      model: "fixture",
      content: [{ type: "tool_use", id: "lookup-1", name: "lookup", input: { key: "value" } }],
      stopReason: "toolUse",
      _meta: { source: "downstream", nested: { preserved: true } },
    };
    const prepared = await prepareNativeMcpServer(runtime, "fixture", {
      ...context(),
      capabilities: { sampling: { tools: {} } },
      createMessage: async () => sampling,
    });
    if (prepared.era !== "modern") {
      throw new Error("Expected modern preparation");
    }
    const view = await prepared.bind();
    await prepared.release();
    try {
      const pending = await view.callTool({ name: "probe" }, options(signal));
      if (pending.kind !== "input-required") {
        throw new Error("Expected sampling continuation");
      }
      expect(pending.result.inputRequests.sampling).toMatchObject({
        method: "sampling/createMessage",
      });
      const responses = { sampling };
      expect(payload(await pending.resume(responses, options(signal)))).toMatchObject({
        responses,
      });
    } finally {
      await view.release();
    }
  });

  it("retires an unbound prepared upstream without waiting for native roots", async () => {
    const { runtime, log } = await fixture("legacy");
    const prepared = await prepareNativeMcpServer(runtime, "fixture", context());
    const pids = (await log())
      .filter((line) => line.startsWith("started "))
      .map((line) => Number(line.slice(8)));
    await prepared.release();
    await prepared.release();
    for (const pid of pids) {
      expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
    }
    if (prepared.era !== "legacy") {
      throw new Error("Expected legacy preparation");
    }
    await expect(prepared.bind({ roots: [] })).rejects.toThrow("no longer available");
  });

  it.for(["env", "args", "cwd"] as const)(
    "detects a changed %s launch definition independently",
    async (changed) => {
      const { runtime, file, log } = await fixture("legacy");
      const source = await fs.readFile(file, "utf8");
      await fs.writeFile(
        file,
        source.replace(
          'const era = "legacy";',
          'const era = process.env.NATIVE_MCP_FIXTURE_ERA ?? process.argv[2] ?? (process.cwd().endsWith("modern") ? "modern" : "legacy");',
        ),
      );
      const caller = context();
      const first = await prepareNativeMcpServer(runtime, "fixture", caller);
      expect(first.era).toBe("legacy");
      await first.release();
      const directory = path.dirname(file);
      const modernDirectory = path.join(directory, "modern");
      await fs.mkdir(modernDirectory);
      const updated = createSessionMcpRuntime({
        sessionId: `changed-${changed}`,
        workspaceDir: directory,
        cfg: {
          plugins: { enabled: false },
          mcp: {
            servers: {
              fixture: {
                command: process.execPath,
                args: [file, ...(changed === "args" ? ["modern"] : [])],
                ...(changed === "env" ? { env: { NATIVE_MCP_FIXTURE_ERA: "modern" } } : {}),
                ...(changed === "cwd" ? { cwd: modernDirectory } : {}),
              },
            },
          },
        },
      });
      runtimes.push(updated);
      const second = await prepareNativeMcpServer(updated, "fixture", caller);
      expect(second.era).toBe("modern");
      await second.release();
      expect((await log()).filter((line) => line.startsWith("started "))).toHaveLength(2);
    },
  );
});
