import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { Transform, Writable } from "node:stream";

const [root, directory, name] = process.argv.slice(2);
const require = createRequire(path.join(root, "package.json"));
const { Server } = await import(require.resolve("@modelcontextprotocol/server"));
const { StdioServerTransport } = await import(
  require.resolve("@modelcontextprotocol/server/stdio")
);
const record = (kind, data) =>
  fs.appendFileSync(
    path.join(directory, "mcp-events.jsonl"),
    JSON.stringify({
      at: Date.now(),
      pid: process.pid,
      parentPid: process.ppid,
      name,
      kind,
      data,
    }) + "\n",
  );
record("start", {});
let buffered = "";
const input = new Transform({
  transform(chunk, _encoding, callback) {
    buffered += chunk.toString();
    let newline;
    while ((newline = buffered.indexOf("\n")) !== -1) {
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      try {
        record("in", JSON.parse(line));
      } catch {}
    }
    callback(null, chunk);
  },
});
const output = new Writable({
  write(chunk, _encoding, callback) {
    try {
      record("out", JSON.parse(chunk.toString()));
    } catch {}
    process.stdout.write(chunk, callback);
  },
});
const server = new Server(
  { name: "synthetic-" + name, version: "1.0.0" },
  {
    capabilities: {
      tools: { listChanged: true },
      resources: { listChanged: true, subscribe: true },
      prompts: { listChanged: true },
      completions: {},
    },
  },
);
server.setRequestHandler("tools/list", () => {
  record("catalog", {});
  return {
    tools: [
      {
        name: "fixture_probe",
        description: "Return a synthetic proof result.",
        inputSchema: {
          type: "object",
          properties: { value: { type: "string" } },
          required: ["value"],
        },
      },
    ],
  };
});
server.setRequestHandler("tools/call", ({ params }) => {
  record("effect", params);
  return { content: [{ type: "text", text: `synthetic-${name}:${params.arguments.value}` }] };
});
server.setRequestHandler("resources/list", () => ({
  resources: [{ uri: `fixture://${name}/note`, name: "Synthetic note" }],
}));
server.setRequestHandler("resources/templates/list", () => ({
  resourceTemplates: [{ uriTemplate: `fixture://${name}/{key}`, name: "Synthetic template" }],
}));
server.setRequestHandler("resources/read", ({ params }) => ({
  contents: [{ uri: params.uri, text: "synthetic resource" }],
}));
server.setRequestHandler("prompts/list", () => ({
  prompts: [{ name: "synthetic", description: "Synthetic prompt" }],
}));
server.setRequestHandler("prompts/get", () => ({
  description: "Synthetic prompt",
  messages: [{ role: "user", content: { type: "text", text: "Synthetic prompt content." } }],
}));
server.setRequestHandler("completion/complete", () => ({
  completion: { values: ["alpha", "beta"], total: 2, hasMore: false },
}));
server.setRequestHandler("resources/subscribe", () => ({}));
server.setRequestHandler("resources/unsubscribe", () => ({}));
process.stdin.pipe(input);
await server.connect(new StdioServerTransport(input, output));
process.on("exit", (code) => record("exit", { code }));
