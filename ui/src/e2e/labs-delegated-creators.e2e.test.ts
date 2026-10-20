import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { applyMergePatch } from "../../../src/config/merge-patch.js";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway, waitForControlUiRoute } from "../test-helpers/control-ui-e2e.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";
import { requestRaw } from "./model-providers.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Delegated creator Lab",
  startServerBeforeBrowser: true,
});

suite.define(() => {
  it("defaults off, persists opt-in and removes only its override when disabled", async () => {
    await suite.withPage(
      { ...createControlUiE2eContextOptions(), viewport: { width: 1280, height: 960 } },
      async ({ page }) => {
        let config: unknown = {
          agents: { defaults: { experimental: { decisionAssistance: true } } },
        };
        let revision = 0;
        const snapshot = () => ({
          config,
          sourceConfig: config,
          raw: JSON.stringify(config),
          hash: `creator-lab-${revision}`,
          valid: true,
          issues: [],
        });
        const gateway = await installMockGateway(page, {
          methodResponses: { "config.get": snapshot() },
        });
        await page.goto(`${suite.server.baseUrl}settings/labs`);
        await waitForControlUiRoute(page, { pathname: "/settings/labs", routeId: "labs" });
        const row = page.locator(".settings-row").filter({
          has: page.locator(".settings-row__title", { hasText: "Delegated human creators" }),
        });
        const toggle = row.getByRole("switch");
        await toggle.waitFor();
        expect(await toggle.isChecked()).toBe(false);
        const artifactDir = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR
          ? createControlUiE2eArtifactDir("delegated-creators")
          : undefined;
        async function capture(name: string) {
          if (!artifactDir) {
            return;
          }
          const frame = await takeControlUiScreenshotFrame(
            page,
            row,
            [row.locator(".settings-toggle__control")],
            { animations: "disabled", scrollTo: row },
          );
          await writeFile(path.join(artifactDir, name + ".png"), frame.png);
        }
        await capture("after-default-off");
        for (const enabled of [true, false]) {
          const before = (await gateway.getRequests("config.patch")).length;
          await gateway.deferNext("config.patch");
          await toggle.click();
          const patch = requestRaw(await gateway.waitForRequest("config.patch", { after: before }));
          expect(patch).toEqual({
            agents: {
              defaults: { experimental: { delegatedCreatorAttribution: enabled || null } },
            },
          });
          config = applyMergePatch(config, patch);
          revision++;
          await gateway.setMethodResponse("config.get", snapshot());
          await gateway.resolveDeferred("config.patch", {
            ok: true,
            config,
            hash: `creator-lab-${revision}`,
          });
          await expect.poll(() => toggle.isEnabled()).toBe(true);
          await page.reload();
          await waitForControlUiRoute(page, { pathname: "/settings/labs", routeId: "labs" });
          await expect.poll(() => toggle.isChecked()).toBe(enabled);
          if (enabled) {
            await capture("after-enabled");
          }
        }
        const decision = page
          .locator(".settings-row")
          .filter({ has: page.locator(".settings-row__title", { hasText: "Decision assistance" }) })
          .getByRole("switch");
        expect(await decision.isChecked()).toBe(true);
      },
    );
  });
});
