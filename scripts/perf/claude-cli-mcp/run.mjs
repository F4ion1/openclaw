import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { appendFileSync, lstatSync, readFileSync, readdirSync, readlinkSync } from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const json = (value) => JSON.stringify(value, null, 2) + "\n";
const write = (file, value) => fs.writeFile(file, json(value));
const read = async (file) => JSON.parse(await fs.readFile(file, "utf8"));
const comparePaths = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
async function optionalJson(file) {
  try {
    return await read(file);
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
    return undefined;
  }
}

function listFiles(root, directory) {
  const files = [];
  for (const entry of readdirSync(path.join(root, directory), { withFileTypes: true })) {
    const file = `${directory}/${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...listFiles(root, file));
    } else {
      files.push(file);
    }
  }
  return files;
}

// Match the capsule's canonical entry format without opening thousands of files at once.
function inspectEntries(root, files) {
  return [...new Set(files)].toSorted(comparePaths).map((file) => {
    const absolute = path.resolve(root, file);
    const relative = path.relative(root, absolute);
    assert(
      relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative),
      "Artifact entry escapes its build root",
    );
    try {
      const stat = lstatSync(absolute);
      if (stat.isSymbolicLink()) {
        return { file, kind: "symlink", target: readlinkSync(absolute) };
      }
      assert(stat.isFile(), `Artifact entry is not a file: ${file}`);
      return {
        file,
        kind: "file",
        sha256: sha256(readFileSync(absolute)),
        executable: Boolean(stat.mode & 0o111),
      };
    } catch (error) {
      if (error.code === "ENOENT") {
        return { file, kind: "missing" };
      }
      throw error;
    }
  });
}

export async function identifyRuntimes() {
  const executable = async (file) => {
    const realpath = await fs.realpath(file);
    return { path: file, realpath, sha256: sha256(await fs.readFile(realpath)) };
  };
  const claude = await executable(execFileSync("which", ["claude"], { encoding: "utf8" }).trim());
  return {
    controller: { ...(await executable(process.execPath)), versions: process.versions },
    claude: {
      ...claude,
      version: execFileSync(claude.path, ["--version"], { encoding: "utf8" }).trim(),
    },
  };
}

export async function inspectBuild(root) {
  const distribution = inspectEntries(root, listFiles(root, "dist"));
  const contentHash = sha256(JSON.stringify(distribution));
  const entrypointSha256 = sha256(await fs.readFile(path.join(root, "openclaw.mjs")));
  const snapshot = await optionalJson(path.join(root, "snapshot-manifest.json"));
  if (snapshot?.hashes) {
    assert.equal(
      contentHash,
      sha256(JSON.stringify(snapshot.hashes)),
      "actual dist inventory differs from snapshot",
    );
  }
  if (snapshot?.contentHash) {
    assert.equal(
      contentHash,
      snapshot.contentHash,
      "actual dist content hash differs from snapshot",
    );
  }
  const require = createRequire(path.join(root, "package.json"));
  async function inspectSdkPackage(name, expected) {
    const packageRoot = path.dirname(path.dirname(require.resolve(name)));
    const pkg = await read(path.join(packageRoot, "package.json"));
    const names = [];
    async function visit(directory) {
      for (const entry of await fs.readdir(path.join(packageRoot, directory), {
        withFileTypes: true,
      })) {
        const file = `${directory}/${entry.name}`;
        if (entry.isDirectory()) {
          await visit(file);
        } else {
          assert(entry.isFile(), `SDK distribution contains a non-regular entry: ${file}`);
          names.push(file);
        }
      }
    }
    await visit("dist");
    const files = names.toSorted(comparePaths).map((file) => ({
      file,
      sha256: sha256(readFileSync(path.join(packageRoot, file))),
    }));
    if (expected) {
      assert.equal(pkg.name, expected.name);
      assert.equal(pkg.version, expected.version);
      const hashes = new Map(files.map((file) => [file.file, file.sha256]));
      for (const target of expected.files) {
        assert.equal(
          hashes.get(target.file),
          target.sha256,
          `installed SDK differs from qualified build: ${name}/${target.file}`,
        );
      }
      if (expected.patchSha256) {
        const patchSha256 = sha256(
          await fs.readFile(
            path.join(root, "patches", `${name.replace("/", "__")}@${pkg.version}.patch`),
          ),
        );
        assert.equal(patchSha256, expected.patchSha256, "SDK patch differs from qualified build");
      }
    }
    return { name: pkg.name, version: pkg.version, files };
  }
  const sdk = {
    ...(await inspectSdkPackage("@modelcontextprotocol/server", snapshot?.sdk)),
    client: await inspectSdkPackage("@modelcontextprotocol/client", snapshot?.sdk?.client),
  };
  let sourceIdentity;
  if (snapshot?.sourceCapsule) {
    assert(snapshot.sdk, "Source capsule snapshot must identify its SDK");
    const source = await read(path.join(root, ".proof", "source.json"));
    const sourceEntries = inspectEntries(
      root,
      source.entries.map((entry) => entry.file),
    );
    const sourceHash = sha256(JSON.stringify(sourceEntries));
    assert.equal(sourceHash, source.sourceHash, "actual source differs from source manifest");
    assert.equal(
      sourceHash,
      snapshot.sourceHash,
      "snapshot source hash differs from actual source",
    );
    assert.equal(source.head, snapshot.head, "snapshot head differs from source manifest");
    const inputHash = sha256(JSON.stringify({ sourceHash, sdk: snapshot.sdk }));
    assert.equal(
      inputHash,
      snapshot.inputHash,
      "actual source and SDK differ from snapshot inputs",
    );
    sourceIdentity = { head: source.head, sourceHash, inputHash };
  }
  const skippedDirectories = new Set([
    ".git",
    "node_modules",
    "dist",
    ".proof",
    ".artifacts",
    ".local",
    "coverage",
  ]);
  const rootInputs = new Set(["pnpm-lock.yaml", "pnpm-workspace.yaml", ".npmrc", ".pnpmfile.cjs"]);
  const dependencyNames = [];
  async function visitInputs(directory = "") {
    for (const entry of await fs.readdir(path.join(root, directory), { withFileTypes: true })) {
      if (skippedDirectories.has(entry.name)) {
        continue;
      }
      const file = directory ? `${directory}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await visitInputs(file);
      } else if (
        entry.name === "package.json" ||
        rootInputs.has(file) ||
        (file.startsWith("patches/") && file.endsWith(".patch"))
      ) {
        assert(entry.isFile(), `Dependency input is not a regular file: ${file}`);
        dependencyNames.push(file);
      }
    }
  }
  await visitInputs();
  for (const required of ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"]) {
    assert(dependencyNames.includes(required), `Qualified build is missing ${required}`);
  }
  const dependencyFiles = dependencyNames.toSorted(comparePaths).map((file) => ({
    file,
    sha256: sha256(readFileSync(path.join(root, file))),
  }));
  return {
    entrypointSha256,
    distribution: { contentHash, entries: distribution.length },
    sdk,
    dependencyInputs: { sha256: sha256(JSON.stringify(dependencyFiles)), files: dependencyFiles },
    ...(sourceIdentity ? { source: sourceIdentity } : {}),
  };
}

async function deadline(promise, label, { milliseconds = 90_000, signal } = {}) {
  let timer;
  let onAbort;
  try {
    signal?.throwIfAborted();
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} exceeded ${milliseconds}ms`)),
          milliseconds,
        );
      }),
      ...(signal
        ? [
            new Promise((_, reject) => {
              onAbort = () => reject(new Error("Benchmark cancelled", { cause: signal.reason }));
              signal.addEventListener("abort", onAbort, { once: true });
            }),
          ]
        : []),
    ]);
  } finally {
    clearTimeout(timer);
    if (onAbort) {
      signal.removeEventListener("abort", onAbort);
    }
  }
}

export async function run({ root, directory, role, signal }) {
  signal?.throwIfAborted();
  assert(["baseline", "candidate"].includes(role));
  assert.notEqual(process.platform, "win32", "This process census requires POSIX ps and lsof");
  await fs.mkdir(directory);
  const home = path.join(directory, "home");
  const state = path.join(directory, "state");
  const workspace = path.join(directory, "workspace");
  const native = path.join(home, ".claude");
  const permissionRoot = path.join(directory, "native-permission-root");
  for (const folder of [home, state, workspace, native, permissionRoot]) {
    await fs.mkdir(folder, { recursive: true });
  }
  const fixture = fileURLToPath(new URL("./fixture.mjs", import.meta.url));
  const events = [];
  const record = (kind, data) => {
    const event = { at: Date.now(), kind, data };
    events.push(event);
    appendFileSync(path.join(directory, "proof-events.jsonl"), JSON.stringify(event) + "\n");
    return event;
  };
  const modelSeen = Promise.withResolvers();
  const modelRelease = Promise.withResolvers();
  let effectIssued = false;
  let catalogReceipt;
  let resultObserved = false;
  let providerFailure;
  const sockets = new Set();
  const children = [];
  const knownPids = new Set();
  const processGroups = new Set();
  let env;
  let gateway;
  let agent;
  let failure;
  let measurement;
  let effect;
  let beforeStop;
  let remaining;
  let rescuedRemaining;
  function launch(args, name) {
    signal?.throwIfAborted();
    const child = spawn(
      process.execPath,
      [...(process.versions.bun ? ["--no-install"] : []), path.join(root, "openclaw.mjs"), ...args],
      { cwd: root, env, detached: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "";
    for (const stream of ["stdout", "stderr"]) {
      child[stream].on("data", (chunk) => {
        output += chunk;
        appendFileSync(path.join(directory, `${name}.${stream}.log`), chunk);
      });
    }
    const closed = once(child, "close").then(([code, childSignal]) => ({
      code,
      signal: childSignal,
    }));
    children.push({ child, closed });
    if (child.pid) {
      knownPids.add(child.pid);
      processGroups.add(child.pid);
    }
    return { child, closed, output: () => output };
  }
  function census(timeout) {
    const raw = execFileSync("ps", ["-axo", "pid=,ppid=,pgid=,rss=,command="], {
      encoding: "utf8",
      timeout,
    });
    const rows = raw
      .trim()
      .split("\n")
      .map((line) => {
        const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
        assert(match, "Process census contains an unreadable row");
        return {
          pid: Number(match[1]),
          parentPid: Number(match[2]),
          processGroup: Number(match[3]),
          rssKiB: Number(match[4]),
          command: match[5],
        };
      });
    assert(
      rows.some((row) => row.pid === process.pid),
      "Process census omitted its controller",
    );
    const ids = new Set(
      rows
        .filter(
          (row) =>
            knownPids.has(row.pid) ||
            processGroups.has(row.processGroup) ||
            row.command.includes(directory),
        )
        .map((row) => row.pid),
    );
    let previous;
    do {
      previous = ids.size;
      for (const row of rows) {
        if (ids.has(row.parentPid)) {
          ids.add(row.pid);
        }
      }
    } while (ids.size !== previous);
    for (const pid of ids) {
      knownPids.add(pid);
    }
    return rows.filter((row) => ids.has(row.pid) && row.pid !== process.pid);
  }
  async function nativeSessionRows(snapshot) {
    const all = snapshot.filter((row) =>
      ["claude", "claude.exe"].includes(path.basename(row.command.split(" ")[0])),
    );
    const sessions = [];
    const discoveries = [];
    const unknown = [];
    // Exact model-menu invocation owned by extensions/anthropic/cli-model-discovery.ts.
    const discoveryArgs =
      '--print --input-format stream-json --output-format stream-json --verbose --permission-prompt-tool stdio --setting-sources user --settings {"disableAllHooks":true,"enabledPlugins":{}} --strict-mcp-config --mcp-config {"mcpServers":{}} --tools ';
    for (const row of all) {
      const config = /--mcp-config (?:"([^"]+)"|'([^']+)'|(\S+))/.exec(row.command);
      const configPath = config?.[1] || config?.[2] || config?.[3];
      if (
        / --session-id [^ ]+(?: |$)/.test(row.command) &&
        configPath &&
        /\/openclaw-cli-mcp-[^/]+\/mcp\.json$/.test(configPath)
      ) {
        const generated = await read(configPath);
        for (const name of ["alpha", "beta", "gamma"]) {
          assert(generated.mcpServers[name], `session MCP configuration retains ${name}`);
        }
        sessions.push({ ...row, configPath });
        continue;
      }
      if (row.command.slice(row.command.indexOf(" ") + 1) !== discoveryArgs) {
        unknown.push(row);
        continue;
      }
      assert.deepEqual(
        JSON.parse(configPath),
        { mcpServers: {} },
        "model discovery has no MCP servers",
      );
      const descendants = new Set([row.pid]);
      let previous;
      do {
        previous = descendants.size;
        for (const child of snapshot) {
          if (descendants.has(child.parentPid)) {
            descendants.add(child.pid);
          }
        }
      } while (descendants.size !== previous);
      const fixtureChildren = snapshot.filter(
        (child) => descendants.has(child.pid) && child.command.includes(fixture),
      );
      assert.equal(fixtureChildren.length, 0, "model discovery cannot spawn an MCP fixture");
      discoveries.push(row);
    }
    record("native-process-census", { sessions, discoveries, unknown, all });
    assert.equal(unknown.length, 0, "unexpected additional native Claude process");
    return sessions;
  }
  const handleProviderRequest = async (req, res) => {
    try {
      let body = "";
      for await (const chunk of req) {
        body += chunk;
      }
      const parsed = body ? JSON.parse(body) : {};
      if (req.url.includes("count_tokens")) {
        res.setHeader("content-type", "application/json");
        res.end('{"input_tokens":10}');
        return;
      }
      if (!req.url.includes("messages")) {
        res.writeHead(404);
        res.end();
        return;
      }
      const tools = (parsed.tools ?? []).map((tool) => tool.name);
      const receipt = record("model-request", { tools, model: parsed.model });
      if (!catalogReceipt) {
        for (const name of ["alpha", "beta", "gamma"]) {
          assert(
            tools.includes(`mcp__${name}__fixture_probe`),
            `first real Claude request contains ${name}`,
          );
        }
        catalogReceipt = receipt;
      }
      modelSeen.resolve();
      await modelRelease.promise;
      const results = (parsed.messages ?? []).flatMap((message) =>
        Array.isArray(message.content)
          ? message.content.filter((block) => block.type === "tool_result")
          : [],
      );
      assert.equal(
        new Set(results.map((result) => result.tool_use_id)).size,
        results.length,
        "each tool result appears once",
      );
      resultObserved ||= results.some((result) =>
        JSON.stringify(result.content).includes("synthetic-alpha:effect-once"),
      );
      const useTool = !effectIssued;
      if (useTool) {
        assert(
          tools.includes("mcp__alpha__fixture_probe"),
          "actual Claude catalog contains the requested tool",
        );
      }
      effectIssued = true;
      const content = useTool
        ? [
            {
              type: "tool_use",
              id: "tool_synthetic_alpha",
              name: "mcp__alpha__fixture_probe",
              input: { value: "effect-once" },
            },
          ]
        : [{ type: "text", text: "Synthetic projection proof complete." }];
      const message = {
        id: "msg_synthetic",
        type: "message",
        role: "assistant",
        model: parsed.model,
        content,
        stop_reason: useTool ? "tool_use" : "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 5 },
      };
      if (!parsed.stream) {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(message));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      const emit = (type, value) => res.write(`event: ${type}\ndata: ${JSON.stringify(value)}\n\n`);
      emit("message_start", {
        type: "message_start",
        message: { ...message, content: [], stop_reason: null },
      });
      emit("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: useTool ? { ...content[0], input: {} } : { type: "text", text: "" },
      });
      emit("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: useTool
          ? { type: "input_json_delta", partial_json: JSON.stringify(content[0].input) }
          : { type: "text_delta", text: content[0].text },
      });
      emit("content_block_stop", { type: "content_block_stop", index: 0 });
      emit("message_delta", {
        type: "message_delta",
        delta: { stop_reason: message.stop_reason, stop_sequence: null },
        usage: { output_tokens: 5 },
      });
      emit("message_stop", { type: "message_stop" });
      res.end();
    } catch (error) {
      providerFailure = error;
      modelSeen.reject(error);
      record("provider-error", { message: error.message });
      res.destroy(error);
    }
  };
  const provider = http.createServer((req, res) => {
    void handleProviderRequest(req, res);
  });
  provider.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  try {
    signal?.throwIfAborted();
    provider.listen(0, "127.0.0.1");
    await once(provider, "listening", { signal });
    const providerBase = `http://127.0.0.1:${provider.address().port}`;
    await write(path.join(native, "settings.json"), {
      permissions: { additionalDirectories: [permissionRoot] },
      env: {
        ANTHROPIC_BASE_URL: providerBase,
        ANTHROPIC_API_KEY: "synthetic-not-a-credential",
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        MCP_PROTOCOL_NEGOTIATION: "auto",
      },
    });
    const reservation = http.createServer();
    let port;
    try {
      signal?.throwIfAborted();
      reservation.listen(0, "127.0.0.1");
      await once(reservation, "listening", { signal });
      port = reservation.address().port;
    } finally {
      await new Promise((resolve) => {
        reservation.close(resolve);
      });
    }
    const plugin = path.join(directory, "proof-observer");
    await fs.mkdir(plugin);
    await write(path.join(plugin, "package.json"), {
      name: "projection-proof-observer",
      version: "1.0.0",
      type: "module",
      openclaw: { extensions: ["./index.js"] },
    });
    await write(path.join(plugin, "openclaw.plugin.json"), {
      id: "projection-proof-observer",
      activation: { onStartup: true },
      configSchema: { type: "object", properties: {} },
    });
    await fs.writeFile(
      path.join(plugin, "index.js"),
      `import fs from 'node:fs';export default {id:'projection-proof-observer',register(api){api.on('before_tool_call',(event)=>{if(event.toolName.includes('alpha'))fs.appendFileSync(${JSON.stringify(path.join(directory, "permission-events.jsonl"))},JSON.stringify({at:Date.now(),toolName:event.toolName,toolCallId:event.toolCallId})+'\\n');});}};`,
    );
    const configPath = path.join(directory, "openclaw.json");
    await write(configPath, {
      logging: { file: path.join(directory, "gateway-file.log") },
      gateway: {
        mode: "local",
        port,
        bind: "loopback",
        auth: { mode: "token", token: "synthetic-projection-token" },
        controlUi: { enabled: false },
      },
      agents: {
        defaults: {
          workspace,
          model: "anthropic/claude-haiku-4-5",
          models: { "anthropic/claude-haiku-4-5": { agentRuntime: { id: "claude-cli" } } },
          heartbeat: { every: "0m" },
        },
      },
      tools: { exec: { security: "full", ask: "off" } },
      plugins: {
        allow: ["anthropic", "projection-proof-observer"],
        load: { paths: [plugin] },
        entries: { anthropic: { enabled: true }, "projection-proof-observer": { enabled: true } },
      },
      mcp: {
        servers: Object.fromEntries(
          ["alpha", "beta", "gamma"].map((name) => [
            name,
            { command: process.execPath, args: [fixture, root, directory, name], cwd: workspace },
          ]),
        ),
      },
    });
    env = {
      PATH: process.env.PATH,
      HOME: home,
      TMPDIR: process.env.TMPDIR,
      OPENCLAW_HOME: home,
      OPENCLAW_STATE_DIR: state,
      OPENCLAW_CONFIG_PATH: configPath,
      CLAUDE_CONFIG_DIR: native,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      OPENCLAW_GATEWAY_TOKEN: "synthetic-projection-token",
      OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
      OPENCLAW_SKIP_GMAIL_WATCHER: "1",
      OPENCLAW_SKIP_CANVAS_HOST: "1",
      OPENCLAW_SKIP_STARTUP_MODEL_PREWARM: "1",
      MCP_PROTOCOL_NEGOTIATION: "auto",
    };
    gateway = launch(["gateway", "run", "--port", String(port), "--bind", "loopback"], "gateway");
    const ready = new Promise((resolve) => {
      const observe = () => {
        if (/\[gateway\] (?:gateway )?ready(?:\r?\n|$)/m.test(gateway.output())) {
          gateway.child.stdout.off("data", observe);
          gateway.child.stderr.off("data", observe);
          resolve();
        }
      };
      gateway.child.stdout.on("data", observe);
      gateway.child.stderr.on("data", observe);
      observe();
    });
    await deadline(
      Promise.race([
        ready,
        gateway.closed.then((result) => {
          throw new Error(`Gateway exited before ready: ${json(result)}`);
        }),
      ]),
      "Gateway readiness",
      { signal },
    );
    record("host-load", { platform: process.platform, loadAverage: os.loadavg() });
    const invocationAt = Date.now();
    agent = launch(
      [
        "agent",
        "--agent",
        "main",
        "--session-key",
        "agent:main:synthetic-projection-proof",
        "--message",
        "Reply with a brief synthetic acknowledgement.",
        "--json",
        "--timeout",
        "90",
      ],
      "agent",
    );
    await deadline(
      Promise.race([
        modelSeen.promise,
        agent.closed.then((result) => {
          throw new Error(`Agent exited before model request: ${json(result)}`);
        }),
      ]),
      "Model catalog",
      { signal },
    );
    assert(catalogReceipt.at >= invocationAt, "catalog-ready model request follows invocation");
    const snapshot = census();
    await write(path.join(directory, "active-census.json"), snapshot);
    const nativeRows = await nativeSessionRows(snapshot);
    assert.equal(nativeRows.length, 1, "exactly one session-bearing native Claude process");
    if (role === "candidate") {
      const config = await read(nativeRows[0].configPath);
      const ordinaryUrl = new URL(config.mcpServers.openclaw.url);
      assert.equal(ordinaryUrl.hostname, "127.0.0.1");
      const listeners = execFileSync(
        "lsof",
        ["-t", "-nP", `-iTCP:${ordinaryUrl.port}`, "-sTCP:LISTEN"],
        { encoding: "utf8" },
      )
        .trim()
        .split("\n")
        .filter(Boolean)
        .map(Number);
      const byPid = new Map(snapshot.map((row) => [row.pid, row]));
      const gatewayOwns = (pid) => {
        const seen = new Set();
        let currentPid = pid;
        while (currentPid && !seen.has(currentPid)) {
          if (currentPid === gateway.child.pid) {
            return true;
          }
          seen.add(currentPid);
          currentPid = byPid.get(currentPid)?.parentPid;
        }
        return false;
      };
      assert(
        listeners.length && listeners.every(gatewayOwns),
        "loopback listener belongs to isolated Gateway",
      );
      for (const name of ["alpha", "beta", "gamma"]) {
        const server = config.mcpServers[name];
        assert.equal(server.type, "http");
        assert(!Object.hasOwn(server, "command"));
        const url = new URL(server.url);
        assert.equal(url.origin, ordinaryUrl.origin);
        assert(url.pathname.startsWith("/mcp/native/"));
      }
      record("export-proof", { keys: ["alpha", "beta", "gamma"], transport: "http", listeners });
    }
    const wire = (await fs.readFile(path.join(directory, "mcp-events.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map(JSON.parse);
    const catalogs = wire.filter((event) => event.kind === "catalog");
    const fixturePids = [...new Set(catalogs.map((event) => event.pid))];
    const startedPids = [
      ...new Set(wire.filter((event) => event.kind === "start").map((event) => event.pid)),
    ];
    const fixtureRows = snapshot.filter((row) => fixturePids.includes(row.pid));
    assert.equal(fixturePids.length, role === "baseline" ? 6 : 3);
    assert.equal(
      fixtureRows.length,
      fixturePids.length,
      "every catalog-producing fixture is alive at the sample boundary",
    );
    assert.equal(
      snapshot.filter((row) => startedPids.includes(row.pid)).length,
      fixturePids.length,
      "all started fixtures remain accounted for",
    );
    const claudePid = nativeRows[0].pid;
    assert.equal(
      wire.filter((event) => event.kind === "start" && event.parentPid === claudePid).length,
      role === "baseline" ? 3 : 0,
      "Claude-spawned duplicate count",
    );
    const classify = (pid) =>
      wire.find(
        (event) => event.pid === pid && event.kind === "in" && event.data.method === "initialize",
      )?.data.params.clientInfo?.name ?? "unknown";
    const groups = Object.fromEntries(
      [...new Set(fixturePids.map(classify))].map((owner) => {
        const rows = fixtureRows.filter((row) => classify(row.pid) === owner);
        return [
          owner,
          {
            pids: rows.map((row) => row.pid),
            count: rows.length,
            rssKiB: rows.reduce((sum, row) => sum + row.rssKiB, 0),
          },
        ];
      }),
    );
    measurement = {
      totalOwnedRssKiB: snapshot.reduce((sum, row) => sum + row.rssKiB, 0),
      totalOwnedProcessCount: snapshot.length,
      fixtureRssKiB: fixtureRows.reduce((sum, row) => sum + row.rssKiB, 0),
      fixtureCount: fixturePids.length,
      fixturePids,
      startedPids,
      groups,
      invocationAt,
      modelAt: catalogReceipt.at,
      invocationToCatalogMs: catalogReceipt.at - invocationAt,
      lastFixtureCatalogMs: Math.max(...catalogs.map((event) => event.at)) - invocationAt,
    };
    record("measurement", measurement);
    modelRelease.resolve();
    const result = await deadline(agent.closed, "Agent effect", { signal });
    assert.equal(result.code, 0, "Gateway-mediated agent turn succeeds");
    assert(!providerFailure, providerFailure?.message);
    assert(resultObserved, "real tool result reaches model continuation");
    for (const name of ["alpha", "beta", "gamma"]) {
      assert(
        events
          .find((event) => event.kind === "model-request")
          .data.tools.includes(`mcp__${name}__fixture_probe`),
        `real Claude catalog includes ${name}`,
      );
    }
    const finalWire = (await fs.readFile(path.join(directory, "mcp-events.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map(JSON.parse);
    const permissions = (await fs.readFile(path.join(directory, "permission-events.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map(JSON.parse);
    assert.deepEqual(
      finalWire
        .filter((event) => event.kind === "effect")
        .map((event) => ({
          server: event.name,
          name: event.data.name,
          value: event.data.arguments.value,
        })),
      [{ server: "alpha", name: "fixture_probe", value: "effect-once" }],
    );
    effect = {
      effects: finalWire.filter((event) => event.kind === "effect").length,
      permissions: permissions.length,
    };
    assert.deepEqual(
      effect,
      { effects: 1, permissions: 1 },
      "one tool effect and native permission callback",
    );
    record("effect-proof", effect);
  } catch (error) {
    failure = error;
    record("failure", { message: error.message, stack: error.stack });
  } finally {
    const shutdownDeadline = performance.now() + 10_000;
    const budget = () => Math.max(0, Math.floor(shutdownDeadline - performance.now()));
    const joinChildren = async () => {
      const results = await Promise.allSettled(children.map(({ closed }) => closed));
      const rejected = results.find((result) => result.status === "rejected");
      if (rejected) {
        throw rejected.reason;
      }
    };
    const signalProcess = (pid, name) => {
      try {
        process.kill(pid, name);
      } catch (error) {
        if (error.code !== "ESRCH") {
          failure ??= error;
        }
      }
    };
    try {
      assert(budget() > 0, "Shutdown deadline expired before ownership census");
      beforeStop = census(budget());
      await write(path.join(directory, "before-stop.json"), beforeStop);
    } catch (error) {
      failure ??= error;
    }
    modelRelease.resolve();
    for (const { child } of children) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
      }
    }
    try {
      // Keep the final second of the existing total budget for failed-cleanup rescue.
      await deadline(joinChildren(), "Graceful child shutdown", {
        milliseconds: Math.max(0, budget() - 1_000),
      });
    } catch (error) {
      failure ??= error;
    }
    try {
      assert(budget() > 0, "Shutdown deadline expired before survivor census");
      remaining = census(budget());
    } catch (error) {
      failure ??= error;
    }
    await write(path.join(directory, "after-stop.json"), remaining ?? null);
    if (remaining?.length) {
      failure ??= new Error(
        "Gateway shutdown left task descendants: " + remaining.map((row) => row.pid).join(","),
      );
    }
    if (!beforeStop || !remaining || remaining.length) {
      // Rescue cannot turn a failed retirement assertion into a passing sample.
      record("forced-cleanup", { beforePids: remaining?.map((row) => row.pid) ?? null });
      for (const processGroup of processGroups) {
        signalProcess(-processGroup, "SIGKILL");
      }
      for (const row of remaining ?? []) {
        signalProcess(row.pid, "SIGKILL");
      }
      try {
        assert(budget() > 0, "Shutdown deadline expired before forced child join");
        await deadline(joinChildren(), "Forced child shutdown", { milliseconds: budget() });
        assert(budget() > 0, "Shutdown deadline expired before final survivor census");
        rescuedRemaining = census(budget());
      } catch (error) {
        failure ??= error;
      }
    }
    for (const { child } of children) {
      child.stdin?.destroy();
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref();
    }
    for (const socket of sockets) {
      socket.destroy();
    }
    const providerClosed = new Promise((resolve) => {
      provider.close(resolve);
    });
    try {
      assert(budget() > 0, "Shutdown deadline expired before provider close");
      await deadline(providerClosed, "Provider shutdown", { milliseconds: budget() });
    } catch (error) {
      failure ??= error;
      provider.unref();
    }
    record("shutdown", {
      remainingPids: remaining?.map((row) => row.pid) ?? null,
      rescuedRemainingPids: rescuedRemaining?.map((row) => row.pid) ?? null,
      budgetRemainingMs: budget(),
    });
  }
  const result = {
    directory,
    role,
    measurement,
    effect,
    events,
    remainingPids: remaining?.map((row) => row.pid) ?? null,
    pass: !failure,
    error: failure?.stack,
  };
  await write(path.join(directory, "summary.json"), result);
  return result;
}
