import fs from "node:fs/promises";
import path from "node:path";

// Only the benchmark's isolated home and captured logs are inspected.
export async function readPhaseTimings({
  directory,
  invocationAt,
  nativeSessionId,
  nativeProcessIdentity,
  fixtureProcessIdentities,
}) {
  const issues = [];
  const stamp = (atMs, source) => ({ atMs, sinceInvocationMs: atMs - invocationAt, source });
  const source = (file, line) => ({ file, line });
  const entries = async (file) => {
    try {
      return await fs.readdir(path.join(directory, file), { withFileTypes: true });
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
      return [];
    }
  };
  const records = async (file) => {
    let text;
    try {
      text = await fs.readFile(path.join(directory, file), "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
      issues.push({ file, kind: "missing-log" });
      return [];
    }
    return text.split("\n").flatMap((line, index) => {
      if (!line.trim()) {
        return [];
      }
      try {
        return [{ value: JSON.parse(line), source: source(file, index + 1) }];
      } catch {
        issues.push({ ...source(file, index + 1), kind: "invalid-json" });
        return [];
      }
    });
  };
  const gatewayLifecycle = [];
  const sqliteSpans = [];
  const registrations = [];
  for (const { value, source: origin } of await records("gateway-file.log")) {
    const atMs = Date.parse(value._meta?.date ?? value.time);
    if (!Number.isFinite(atMs)) {
      issues.push({ ...origin, kind: "missing-timestamp" });
      continue;
    }
    const data = value["1"];
    if (value.message === "session controller phase") {
      gatewayLifecycle.push({
        ...stamp(atMs, origin),
        phase: data?.phase,
        status: data?.status,
        reason: data?.reason,
        traceId: value.traceId,
        sessionScopeHash: data?.sessionScopeHash,
        sessionIdHash: data?.sessionIdHash,
      });
    }
    if (value.message?.startsWith("cli live session start:")) {
      registrations.push({
        ...stamp(atMs, origin),
        traceId: value.traceId,
        meaning: "JavaScript session-handle registration; not process spawn or readiness",
      });
    }
    if (
      ["slow SQLite session write", "slow agent database reservation"].includes(value.message) &&
      Number.isFinite(data?.elapsedMs)
    ) {
      sqliteSpans.push({
        ...stamp(atMs, origin),
        operation: data.operation,
        workerOperations: data.workerOperations,
        traceId: value.traceId,
        elapsedMs: data.elapsedMs,
        queueWaitMs: data.queueWaitMs,
        writerExecutionMs: data.writerExecutionMs,
        completionDelayMs: data.completionDelayMs,
        derivedStartAtMs: atMs - data.elapsedMs,
        meaning:
          "End log timestamp plus reported duration; start is reconstructed, spans may overlap",
      });
    }
  }

  const servers = {};
  const cacheRoot = "home/Library/Caches/claude-cli-nodejs";
  if (nativeSessionId) {
    for (const workspace of await entries(cacheRoot)) {
      if (!workspace.isDirectory()) {
        continue;
      }
      for (const name of ["alpha", "beta", "gamma", "openclaw"]) {
        const folder = path.join(cacheRoot, workspace.name, `mcp-logs-${name}`);
        for (const file of await entries(folder)) {
          if (!file.isFile() || !file.name.endsWith(".jsonl")) {
            continue;
          }
          for (const { value, source: origin } of await records(path.join(folder, file.name))) {
            if (value.sessionId !== nativeSessionId) {
              continue;
            }
            const message = value.debug ?? "";
            const kind = message.startsWith("Initializing HTTP transport to ")
              ? "transport-start"
              : message.startsWith("Starting connection with timeout")
                ? "connection-start"
                : message === "Received ListRoots request from server"
                  ? "roots-request-received"
                  : message.startsWith("Successfully connected (transport:")
                    ? "connected"
                    : undefined;
            if (!kind) {
              continue;
            }
            const atMs = Date.parse(value.timestamp);
            if (!Number.isFinite(atMs)) {
              issues.push({ ...origin, kind: "missing-timestamp" });
              continue;
            }
            (servers[name] ??= []).push({ ...stamp(atMs, origin), kind });
          }
        }
      }
    }
  }
  for (const events of Object.values(servers)) {
    events.sort((a, b) => a.atMs - b.atMs);
  }

  const upstream = [];
  const probes = [];
  const pendingProbes = new Map();
  const pendingInitializations = new Map();
  for (const { value, source: origin } of await records("mcp-events.jsonl")) {
    if (!Number.isFinite(value.at)) {
      issues.push({ ...origin, kind: "missing-timestamp" });
      continue;
    }
    const method = value.data?.method;
    const kind =
      value.kind === "start" || value.kind === "catalog"
        ? value.kind
        : value.kind === "in" && ["server/discover", "initialize", "tools/list"].includes(method)
          ? method
          : undefined;
    const event = {
      ...stamp(value.at, origin),
      server: value.name,
      pid: value.pid,
      kind,
      requestId: value.data?.id,
      clientName:
        value.data?.params?.clientInfo?.name ??
        value.data?.params?._meta?.["io.modelcontextprotocol/clientInfo"]?.name,
    };
    if (kind) {
      upstream.push(event);
    }
    const key = JSON.stringify([value.pid, value.data?.id]);
    if (value.kind === "in" && method === "initialize") {
      pendingInitializations.set(key, event);
    } else if (value.kind === "out" && pendingInitializations.has(key)) {
      upstream.push({
        ...event,
        kind: "initialize-result",
        errorCode: value.data?.error?.code,
        protocolVersion: value.data?.result?.protocolVersion,
      });
      pendingInitializations.delete(key);
    }
    if (
      value.kind === "in" &&
      method === "server/discover" &&
      String(value.data?.id).startsWith("server-discover-probe-")
    ) {
      const probe = { ...event, response: undefined };
      probes.push(probe);
      pendingProbes.set(key, probe);
    } else if (value.kind === "out" && pendingProbes.has(key)) {
      pendingProbes.get(key).response = {
        ...stamp(value.at, origin),
        errorCode: value.data?.error?.code,
      };
      pendingProbes.delete(key);
    }
  }
  for (const probe of probes) {
    probe.clientName ??= upstream.find(
      (event) => event.pid === probe.pid && event.kind === "initialize",
    )?.clientName;
  }
  const priorLifecycle = new Map();
  const gatewayLifecycleSpans = [];
  for (const event of gatewayLifecycle) {
    const key = JSON.stringify([event.traceId, event.sessionScopeHash, event.phase]);
    const previous = priorLifecycle.get(key);
    if (previous) {
      gatewayLifecycleSpans.push({
        phase: event.phase,
        traceId: event.traceId,
        from: previous,
        to: event,
        durationMs: event.atMs - previous.atMs,
        meaning: "Time between adjacent logged phase observations; not exclusive execution time",
      });
    }
    priorLifecycle.set(key, event);
  }
  const birthAtMicros = nativeProcessIdentity?.startTimeMicros;
  return {
    invocationAtMs: invocationAt,
    nativeSessionId,
    nativeBirth: Number.isFinite(birthAtMicros)
      ? {
          ...stamp(birthAtMicros / 1000, { kind: "kernel-process-identity" }),
          atMicros: birthAtMicros,
          pid: nativeProcessIdentity.pid,
          resolutionMicros: nativeProcessIdentity.startTimeResolutionMicros,
        }
      : { unavailable: "Process birth was not captured" },
    fixtureBirths: (fixtureProcessIdentities ?? []).map((identity) =>
      Number.isFinite(identity?.startTimeMicros)
        ? {
            atMs: identity.startTimeMicros / 1000,
            sinceInvocationMs: identity.startTimeMicros / 1000 - invocationAt,
            source: { kind: "kernel-process-identity" },
            atMicros: identity.startTimeMicros,
            pid: identity.pid,
            resolutionMicros: identity.startTimeResolutionMicros,
          }
        : { unavailable: "Fixture process identity was unavailable" },
    ),
    registrations,
    gatewayLifecycle,
    gatewayLifecycleSpans,
    sqliteSpans,
    nativeMcp: {
      servers,
      unavailable: !nativeSessionId
        ? "No native session identity; native cache was not read"
        : Object.keys(servers).length === 0
          ? "No matching macOS native MCP cache records"
          : undefined,
    },
    upstream,
    probes,
    probeCount: probes.length,
    eraCache: {
      inferredMisses: probes.filter((probe) => probe.clientName === "openclaw-bundle-mcp").length,
      meaning: "Gateway-owned wire discovery probes; cache lookup is not timestamped",
    },
    unknownPhases: [
      "Actual HTTP request receipt and preparation/cache lookup entry are not logged",
      "Bind entry/exit is not logged; roots/initialize may bound it using the source contract",
      "Native initialize-ready control response is not logged",
    ],
    issues,
  };
}
