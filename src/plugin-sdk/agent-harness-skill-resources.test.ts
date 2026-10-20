/** Keeps prepared skill resources separate from the public tool-factory contract. */
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, expectTypeOf, it } from "vitest";
import "../agents/test-helpers/fast-coding-tools.js";
import "../agents/test-helpers/fast-openclaw-tools.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  createOpenClawCodingTools,
  createOpenClawCodingToolsInternal,
} from "../agents/agent-tools.js";
import {
  expectReadWriteEditTools,
  getTextContent,
} from "../agents/test-helpers/agent-tools-fs-helpers.js";
import { createCanonicalFixtureSkill } from "../skills/test-support/test-helpers.js";

const temps = useAutoCleanupTempDirTracker(afterEach);

describe("prepared skill resource boundary", () => {
  it("keeps prepared skill resources out of the public SDK contract", () => {
    type Sdk = typeof import("./agent-harness.js");
    type PublicFactory = Sdk["createOpenClawCodingTools"];
    expectTypeOf<NonNullable<Parameters<PublicFactory>[0]>>().not.toHaveProperty(
      "skillReadResources",
    );
    expectTypeOf<Parameters<PublicFactory>["length"]>().toEqualTypeOf<0 | 1>();
    expectTypeOf<Sdk>().not.toHaveProperty("createOpenClawCodingToolsInternal");
  });

  it.each(["empty", "populated"] as const)(
    "ignores prepared skill resources supplied through public options (%s)",
    async (selection) => {
      const rootDir = temps.make("openclaw-public-skill-resources-");
      const workspaceDir = path.join(rootDir, "workspace");
      await fs.mkdir(workspaceDir);
      const makeSkill = async (name: string, text: string) => {
        const baseDir = path.join(rootDir, `${name}-skill`);
        const filePath = path.join(baseDir, "SKILL.md");
        await fs.mkdir(baseDir);
        await fs.writeFile(filePath, `# ${text}\n`);
        return createCanonicalFixtureSkill({
          name,
          description: text,
          filePath,
          baseDir,
          source: "test",
        });
      };
      const snapshotSkill = await makeSkill("snapshot", "Public snapshot instructions");
      const preparedSkill = await makeSkill("prepared", "Internal prepared instructions");
      const snapshotPath = snapshotSkill.filePath;
      const preparedPath = preparedSkill.filePath;
      // Model JavaScript callers carrying unsupported extra fields.
      const options = {
        workspaceDir,
        config: { tools: { fs: { workspaceOnly: true } } },
        skillsSnapshot: {
          prompt: "",
          skills: [{ name: "snapshot" }],
          resolvedSkills: [snapshotSkill],
        },
        skillReadResources: selection === "empty" ? [] : [preparedSkill],
      };
      const { readTool } = expectReadWriteEditTools(createOpenClawCodingTools(options));
      expect(
        getTextContent(await readTool.execute("public-snapshot", { path: snapshotPath })),
      ).toContain("Public snapshot instructions");
      await expect(readTool.execute("public-prepared", { path: preparedPath })).rejects.toThrow(
        /Path escapes sandbox root/i,
      );

      const { skillReadResources, ...publicOptions } = options;
      const internal = expectReadWriteEditTools(
        createOpenClawCodingToolsInternal(publicOptions, skillReadResources),
      );
      const readPrepared = () =>
        internal.readTool.execute("internal-prepared", { path: preparedPath });
      await expect(
        internal.readTool.execute("internal-snapshot", { path: snapshotPath }),
      ).rejects.toThrow(/Path escapes sandbox root/i);
      if (selection === "populated") {
        expect(getTextContent(await readPrepared())).toContain("Internal prepared instructions");
      } else {
        await expect(readPrepared()).rejects.toThrow(/Path escapes sandbox root/i);
      }
      await expect(
        internal.writeTool.execute("internal-write", {
          path: preparedPath,
          content: "replaced",
        }),
      ).rejects.toThrow(/Path escapes sandbox root|outside-workspace/i);
      await expect(
        internal.editTool.execute("internal-edit", {
          path: preparedPath,
          edits: [{ oldText: "Internal", newText: "replaced" }],
        }),
      ).rejects.toThrow(/Path escapes sandbox root|outside-workspace/i);
    },
  );
});
