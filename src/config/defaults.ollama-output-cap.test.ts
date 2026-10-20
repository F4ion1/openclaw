import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadPluginManifest } from "../plugins/manifest.js";
import { createPluginManifestRecordFixture } from "../plugins/plugin-metadata.test-support.js";
import { applyModelDefaults } from "./defaults.js";
import type { ModelDefinitionConfig } from "./types.models.js";
import { validateConfigObjectRaw } from "./validation-core.js";

const rootDir = path.resolve("extensions/ollama");
const loaded = loadPluginManifest(rootDir);
if (!loaded.ok) {
  throw new Error(loaded.error);
}
const manifestRegistry = {
  plugins: [createPluginManifestRecordFixture({ ...loaded.manifest, rootDir })],
};

function materialize(
  provider: string,
  id: string,
  baseUrl: string,
  model: Partial<ModelDefinitionConfig> = {},
  maxTokens?: number,
) {
  const config = { baseUrl, api: "ollama", maxTokens, models: [{ id, name: id, ...model }] };
  const parsed = validateConfigObjectRaw({ models: { providers: { [provider]: config } } });
  if (!parsed.ok) {
    throw new Error(JSON.stringify(parsed.issues));
  }
  return applyModelDefaults(parsed.config, { manifestRegistry }).models?.providers?.[provider]
    ?.models[0];
}

describe("Ollama configured output budgets", () => {
  it.each([
    ["kimi-k2.6", 262_144],
    ["kimi-k2.7-code", 262_144],
    ["kimi-k3", 1_048_576],
    ["deepseek-v4-pro", 1_048_576],
    ["deepseek-v4-pro:0813", 1_048_576],
    ["gemma4", 262_144],
    ["gemma4:31b", 262_144],
    ["glm-5.2", 131_072],
    ["gpt-oss:120b", 131_072],
    ["gpt-oss:20b", 131_072],
    ["minimax-m2.7", 196_608],
    ["minimax-m3", 524_288],
    ["mistral-large-3:675b", 262_144],
    ["nemotron-3-nano:30b", 262_144],
    ["nemotron-3-super", 262_144],
    ["nemotron-3-ultra", 262_144],
  ])("materializes %s from the authored cloud catalog", (id, expected) => {
    expect(materialize("ollama-cloud", id, "https://ollama.com")?.maxTokens).toBe(expected);
  });

  it.each([
    { id: "custom", baseUrl: "https://ollama.com", expected: 262_144 },
    { id: "custom:cloud", baseUrl: "http://127.0.0.1:11434", expected: 262_144 },
    { id: "custom", baseUrl: "http://127.0.0.1:11434", expected: 8192 },
    { id: "minimax-m3", baseUrl: "http://127.0.0.1:11434", expected: 8192 },
    { id: "kimi-k3", baseUrl: "http://127.0.0.1:11434", expected: 8192 },
    {
      id: "minimax-m3",
      baseUrl: "http://127.0.0.1:11434",
      modelBaseUrl: "https://ollama.com",
      expected: 8192,
    },
    {
      id: "minimax-m3",
      baseUrl: "https://ollama.com",
      modelBaseUrl: "http://127.0.0.1:11434",
      expected: 262_144,
    },
    { id: "minimax-m3", baseUrl: "https://ollama.com", expected: 262_144 },
    { id: "kimi-k3:cloud", baseUrl: "http://127.0.0.1:11434", expected: 262_144 },
    { id: "minimax-m3", baseUrl: "http://127.0.0.1:11434", maxTokens: 1024, expected: 1024 },
    { id: "custom", baseUrl: "https://ollama.com", maxTokens: 1024, expected: 1024 },
    { id: "custom", baseUrl: "https://ollama.com", providerMaxTokens: 2048, expected: 2048 },
  ])(
    "materializes $id at $baseUrl (model URL $modelBaseUrl) with authored cap $maxTokens",
    ({ id, baseUrl, modelBaseUrl, maxTokens, providerMaxTokens, expected }) => {
      expect(
        materialize(
          "ollama",
          id,
          baseUrl,
          {
            baseUrl: modelBaseUrl,
            contextWindow: 262_144,
            maxTokens,
            params: { num_predict: -1 },
          },
          providerMaxTokens,
        ),
      ).toMatchObject({
        maxTokens: expected,
        params: { num_predict: -1 },
      });
    },
  );
});
