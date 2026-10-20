import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  buildMentionRegexes,
  matchesMentionPatterns,
  stripMentions,
  stripStructuralPrefixes,
} from "./mentions.js";

function mention(name: string, emoji?: string) {
  const cfg: OpenClawConfig = {
    agents: { entries: { agent: { identity: { name, emoji } } } },
  };
  const regexes = buildMentionRegexes(cfg, "agent");
  return {
    regexes,
    matches: (...texts: string[]) => {
      for (const text of texts) {
        expect(matchesMentionPatterns(text, regexes), text).toBe(true);
      }
    },
    rejects: (...texts: string[]) => {
      for (const text of texts) {
        expect(matchesMentionPatterns(text, regexes), text).toBe(false);
      }
    },
    strip: (text: string) => stripMentions(text, {}, cfg, "agent"),
  };
}

describe("stripStructuralPrefixes", () => {
  it("returns empty string for empty input", () => {
    expect(stripStructuralPrefixes("")).toBe("");
  });

  it("strips slash-like display labels only after an envelope", () => {
    expect(stripStructuralPrefixes("[Telegram /reset id:123] /reset: hello")).toBe("hello");
  });

  it("does not treat a payload marker literal as structure", () => {
    const body = "please explain [Current message - respond to this] /status";
    expect(stripStructuralPrefixes(body)).toBe(body);
  });

  it("does not mine commands from ambiguous flat history", () => {
    const marker = "[Recent chat messages - for context]";
    const body = `${marker}\nOther: quoted [Current message - respond to this] /reset\n\n[Current message - respond to this]\nOwner: /status`;
    expect(stripStructuralPrefixes(body)).toBe(body);
  });

  it("preserves real line breaks in slash commands for downstream command parsing", () => {
    expect(stripStructuralPrefixes("/reset soft\nre-read persona files")).toBe(
      "/reset soft\nre-read persona files",
    );
    expect(stripStructuralPrefixes("/reset \\nsoft")).toBe("/reset soft");
  });
});

describe("derived mention matching and stripping", () => {
  it("matches single-character Han names without matching Unicode substrings", () => {
    const bot = mention("包");
    bot.matches("@包 你好", "包 你好");
    bot.rejects("前包後", "包みを開ける", "包\u0301");
    expect(bot.strip("@包 你好")).toBe("你好");
    expect(bot.strip("包みを開ける")).toBe("包みを開ける");
  });

  it("keeps explicit configured patterns on their existing regex flags", () => {
    const regexes = buildMentionRegexes({
      messages: { groupChat: { mentionPatterns: [String.raw`\bopenclaw\b`] } },
    });
    expect(regexes[0]?.flags).toBe("i");
  });

  it("accepts interior decoration once, as whitespace, or omitted", () => {
    const bot = mention("Papillon🦋Bot");
    bot.matches("Papillon🦋Bot help", "papillon bot help", "PapillonBot help");
    bot.rejects("Papillon🦋🦋Bot /status", "papillon...bot help");
    expect(bot.strip("Papillon🦋🦋Bot /status")).toBe("Papillon🦋🦋Bot /status");
    expect(bot.strip("Papillon🦋Bot /status")).toBe("/status");
  });

  it("keeps punctuation required when it shares a gap with decoration", () => {
    const bot = mention("Clawd ・🦋 Bot");
    bot.matches("clawd ・🦋 bot status");
    bot.rejects("clawd bot status", "clawd🦋bot status");
  });

  it("strips a spaced gap whose raw spelling also carries a joiner", () => {
    const bot = mention("क‍ ख");
    bot.matches("क ख नमस्ते");
    bot.rejects("कख नमस्ते");
    expect(bot.strip("क‍ ख /status")).toBe("/status");
  });

  it("matches a configured identity emoji that carries a joiner", () => {
    const bot = mention("Clawd", "👩‍👧");
    bot.matches("👩‍👧 status", "clawd status");
  });

  it("accepts the identity's numeric keycap without accepting bare or foreign digits", () => {
    const bot = mention("Bot1️⃣");
    bot.matches("bot 早安", "bot1️⃣ 早安");
    bot.rejects("bot1 早安", "botx 早安", "bot3️⃣ 早安");
    expect(bot.strip("bot /status")).toBe("/status");
    expect(bot.strip("bot1️⃣ /status")).toBe("/status");
    expect(bot.strip("bot1 /status")).toBe("bot1 /status");
    expect(bot.strip("bot3️⃣ /status")).toBe("bot3️⃣ /status");
  });

  it("reads spaced interior decoration once while keeping a separator floor", () => {
    const bot = mention("Clawd 🦋 ★ Bot");
    bot.matches("clawd 🦋 ★ bot status", "clawd🦋★bot status", "clawd bot status");
    bot.rejects("clawd 🦋 🦋 ★ bot status", "clawdbot status", "@clawdbot status");
  });

  it("derives no pattern from an identity that normalization empties", () => {
    const bot = mention("\u200D");
    expect(bot.regexes).toHaveLength(0);
    bot.rejects("hello!");
  });

  it("strips markless edge joiners without stripping part of a joined word", () => {
    const trailing = mention("क‍");
    const leading = mention("‍क");
    trailing.matches("क नमस्ते");
    leading.matches("क नमस्ते");
    expect(trailing.strip("क‍ /status")).toBe("/status");
    expect(leading.strip("‍क /status")).toBe("/status");
    expect(trailing.strip("क /status")).toBe("/status");
    trailing.rejects("कख नमस्ते");
    expect(trailing.strip("क‍ख नमस्ते")).toBe("क‍ख नमस्ते");
  });

  it("rejects a long joined suffix without quadratic stripping", () => {
    const bot = mention("Bot🦋");
    const message = `Bot${"\u200D".repeat(32_768)}X /status`;
    const startedAt = performance.now();
    expect(bot.strip(message)).toBe(message);
    expect(performance.now() - startedAt).toBeLessThan(500);
  });
});
