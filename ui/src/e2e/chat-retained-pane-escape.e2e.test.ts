import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT } from "../../../src/gateway/control-ui-contract.js";
import { SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD } from "../lib/session-pull-requests.ts";
import {
  controlUiSessionPath,
  installMockGateway,
  startControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI retained pane Escape",
  startServer: () => startControlUiE2eServer(),
  startServerBeforeBrowser: true,
});
const captureProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const sessionKeys = ["agent:main:review-a", "agent:main:review-b"] as const;

suite.define(() => {
  it("dismisses the visible PR menu after a keyboard session switch", async () => {
    const viewport = { height: 900, width: 1440 };
    const context = await suite.newBrowserContext({
      colorScheme: "light",
      locale: "en-US",
      serviceWorkers: "block",
      viewport,
      ...(captureProof ? { recordVideo: { dir: suite.artifactDir, size: viewport } } : {}),
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      featureMethods: ["chat.metadata", "chat.startup", SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD],
      methodResponses: {
        [SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD]: { subscribed: true },
        "sessions.list": {
          count: sessionKeys.length,
          defaults: { contextTokens: null, model: "gpt-5.6-luna", modelProvider: "openai" },
          path: "",
          sessions: sessionKeys.map((key, index) => ({
            key,
            kind: "direct",
            label: `Review ${index === 0 ? "A" : "B"}`,
            updatedAt: sessionKeys.length - index,
          })),
          ts: 1,
        },
      },
      sessionKey: sessionKeys[0],
    });
    try {
      await page.goto(new URL(controlUiSessionPath(sessionKeys[0]), suite.server.baseUrl).href);
      for (const [index, key] of sessionKeys.entries()) {
        if (index > 0) {
          const link = page.locator(`.sidebar-recent-session[data-session-key="${key}"] a`);
          await link.focus();
          await link.press("Enter");
          await expect.poll(() => new URL(page.url()).pathname).toBe(controlUiSessionPath(key));
        }
        await expect
          .poll(async () => {
            const requests = await gateway.getRequests(SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD);
            return (requests.at(-1)?.params as { sessionKeys?: string[] } | undefined)?.sessionKeys;
          })
          .toContain(key);
        await gateway.emitGatewayEvent(CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT, {
          sessions: {
            [key]: {
              pullRequests: [
                {
                  number: 101 + index,
                  owner: "example",
                  repo: "release-planning",
                  branch: `review-${index === 0 ? "a" : "b"}`,
                  title: "Review release checklist",
                  url: `https://github.com/example/release-planning/pull/${101 + index}`,
                  state: "open",
                  checks: { state: "passing", passed: 4, failed: 0, skipped: 0, running: 0 },
                },
              ],
              rateLimited: false,
              status: "ok",
            },
          },
        });
        // Keep this regression keyboard-only: a pointer click would light-dismiss
        // the previous pane's CI disclosure before Escape is exercised.
        const pane = page.locator('openclaw-chat-pane[aria-hidden="false"]');
        await pane.getByRole("button", { name: "Details", exact: true }).press("Enter");
        await expect
          .poll(() => pane.locator('[data-details-group="pull-requests"]').getAttribute("open"))
          .not.toBeNull();
        const actions = pane.locator(".chat-pr__actions-trigger");
        await actions.focus();
        await actions.press("Enter");
        const menu = pane.locator(".chat-pr-menu");
        await menu.waitFor();
        await menu.locator('[data-value="monitoring"]').press("Enter");
        await menu.locator(".chat-pr-menu__page:visible").waitFor();
      }
      await expect.poll(() => page.locator("openclaw-chat-pane").count()).toBe(2);
      const hiddenPane = page.locator('openclaw-chat-pane[aria-hidden="true"][inert]');
      const visiblePane = page.locator('openclaw-chat-pane[aria-hidden="false"]');
      const hiddenMenu = hiddenPane.locator(".chat-pr-menu");
      const visibleMenu = visiblePane.locator(".chat-pr-menu");
      expect(
        await hiddenPane.locator(".chat-pr__actions-trigger").getAttribute("aria-expanded"),
      ).toBe("false");
      expect(await hiddenMenu.isVisible()).toBe(false);
      await expect.poll(() => visibleMenu.isVisible()).toBe(true);
      if (captureProof) {
        await page.screenshot({ path: path.join(suite.artifactDir, "before-escape.png") });
      }
      await page.keyboard.press("Escape");
      await expect.poll(() => visibleMenu.locator(".chat-pr-menu__page:visible").count()).toBe(0);
      expect(await visibleMenu.isVisible()).toBe(true);
      await page.keyboard.press("Escape");
      await expect.poll(() => visibleMenu.isVisible()).toBe(false);
      expect(
        await visiblePane.locator(".chat-pr__actions-trigger").getAttribute("aria-expanded"),
      ).toBe("false");
      expect(
        await hiddenPane.locator(".chat-pr__actions-trigger").getAttribute("aria-expanded"),
      ).toBe("false");
      expect(await hiddenMenu.isVisible()).toBe(false);
    } finally {
      if (captureProof) {
        await page.screenshot({ path: path.join(suite.artifactDir, "after-escape.png") });
        const panes = await page.locator("openclaw-chat-pane").evaluateAll((elements) =>
          elements.map((element) => ({
            sessionKey: (element as HTMLElement & { sessionKey?: string }).sessionKey,
            hidden: element.getAttribute("aria-hidden"),
            openActions: element
              .querySelector(".chat-pr__actions-trigger")
              ?.getAttribute("aria-expanded"),
          })),
        );
        await writeFile(path.join(suite.artifactDir, "panes.json"), JSON.stringify(panes, null, 2));
      }
      await suite.closeBrowserContext(context);
    }
  });
});
