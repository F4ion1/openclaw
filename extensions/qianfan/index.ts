import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { applyQianfanConfig, QIANFAN_DEFAULT_MODEL_REF } from "./onboard.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };

const PROVIDER_ID = "qianfan";

export default defineSingleProviderPluginEntry({
  id: PROVIDER_ID,
  name: "Qianfan Provider",
  description: "Bundled Qianfan provider plugin",
  manifest,
  provider: {
    label: "Qianfan",
    docsPath: "/providers/qianfan",
    manifestAuth: {
      defaultModel: QIANFAN_DEFAULT_MODEL_REF,
      applyConfig: applyQianfanConfig,
    },
    catalog: { liveModelDiscovery: true, discoveryMode: "strict" },
  },
  register(api) {
    api.registerEmbeddingProvider({
      id: PROVIDER_ID,
      transport: "remote",
      authProviderId: PROVIDER_ID,
      async create(options) {
        const { getMemoryEmbeddingProvider } =
          await import("openclaw/plugin-sdk/memory-core-host-engine-embeddings");
        const adapter = getMemoryEmbeddingProvider("openai-compatible", options.config);
        if (!adapter) {
          throw new Error("The OpenAI-compatible embedding provider is unavailable.");
        }
        const result = await adapter.create(options);
        if (result.provider) {
          result.provider.id = PROVIDER_ID;
          // Baidu's per-model batch limits: https://ai.baidu.com/ai-doc/WENXINWORKSHOP/Ultiovtgu
          if (
            ["embedding-v1", "bge-large-zh", "bge-large-en"].includes(
              result.provider.model.toLowerCase(),
            )
          ) {
            result.provider.maxInputsPerRequest = 16;
          }
        }
        if (result.runtime) {
          result.runtime.id = PROVIDER_ID;
        }
        return result;
      },
    });
  },
});
