import { expect, it } from "vitest";
import {
  controlUiBundledSettingsStorageKey,
  waitForControlUiSettingsTakeover,
} from "../test-helpers/control-ui-e2e.ts";
import { closeChatDetails, openChatTaskProgress } from "./chat-details.test-support.ts";
import {
  captureUiProof,
  chatSessionListResponse,
  controlUiSessionUrl,
  createChatFlowE2eSuite,
  installMockGateway,
} from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();

suite.define(() => {
  it("hides and restores chat progress across tabs and reloads while keeping saved Details", async () => {
    const sessionKey = "agent:main:progress-preference";
    await suite.withPage(
      { colorScheme: "dark", locale: "en-US", viewport: { width: 390, height: 900 } },
      async ({ page, context }) => {
        const cardData = {
          sessionKey,
          revision: 1,
          updatedAt: Date.now(),
          steps: [
            { step: "Inspect existing settings", status: "completed" },
            { step: "Verify the new preference", status: "in_progress" },
          ],
        };
        const gateway = await installMockGateway(page, {
          sessionKey,
          featureMethods: ["chat.metadata", "chat.startup", "progressCard.get"],
          historyMessages: [
            {
              role: "user",
              content: [{ type: "text", text: "Check the progress display setting." }],
            },
            {
              role: "assistant",
              content: [
                {
                  type: "text",
                  text: "The task continues whether progress cards are visible or hidden.",
                },
              ],
            },
          ],
          methodResponses: {
            "progressCard.get": { card: cardData },
            "sessions.list": chatSessionListResponse([
              {
                key: sessionKey,
                kind: "direct",
                label: "Progress display preference",
                updatedAt: 1,
              },
            ]),
          },
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
        const pill = page.locator('.activity-pill[data-family="progress"]');
        await pill.waitFor();
        const progress = await openChatTaskProgress(page);
        await progress.locator(".task-progress-details__plan").waitFor();
        await closeChatDetails(page);
        await captureUiProof(suite, page, "progress-preference", "01-cards-enabled.png");

        const settingsPage = await context.newPage();
        await settingsPage.setViewportSize({ width: 1280, height: 900 });
        const settingsGateway = await installMockGateway(settingsPage, { sessionKey });
        await settingsPage.goto(
          `${suite.server.baseUrl}settings/appearance?section=__appearance__#settings-appearance-chat`,
        );
        await waitForControlUiSettingsTakeover(settingsPage);
        const row = (title: string) =>
          settingsPage
            .locator(".settings-row")
            .filter({
              has: settingsPage.locator(".settings-row__title", { hasText: title }),
            })
            .first();
        const showRow = row("Show task progress cards");
        const collapseRow = row("Collapse task progress by default on desktop");
        const enabled = () => showRow.getByRole("switch").isChecked();
        await expect.poll(enabled).toBe(true);
        await expect.poll(() => showRow.textContent()).not.toContain("Using default:");
        await settingsPage
          .locator("#settings-appearance-chat")
          .evaluate((element) => element.scrollIntoView({ block: "start", behavior: "instant" }));
        await captureUiProof(suite, settingsPage, "progress-preference", "02-setting-default.png");

        await collapseRow.click();
        await showRow.click();
        await expect.poll(enabled).toBe(false);
        await expect.poll(() => collapseRow.getByRole("switch").isDisabled()).toBe(true);
        await expect.poll(() => pill.count()).toBe(0);
        await captureUiProof(suite, settingsPage, "progress-preference", "03-setting-disabled.png");
        await captureUiProof(suite, page, "progress-preference", "04-cards-hidden.png");

        const reads = (await gateway.getRequests("progressCard.get")).length;
        await gateway.setMethodResponse("progressCard.get", {
          card: {
            ...cardData,
            revision: 2,
            markdown: "The task progressed while the card was hidden.",
          },
        });
        await gateway.emitGatewayEvent("progressCard.changed", { sessionKey, revision: 2 });
        await expect
          .poll(async () => (await gateway.getRequests("progressCard.get")).length)
          .toBeGreaterThan(reads);
        await openChatTaskProgress(page);
        await expect
          .poll(() => progress.textContent())
          .toContain("The task progressed while the card was hidden.");
        await closeChatDetails(page);
        expect(await pill.count()).toBe(0);
        // Each page-owned request log resets on reload; prove the first phase before losing it.
        expect(await gateway.getRequests("progressCard.put")).toHaveLength(0);
        expect(await gateway.getRequests("chat.abort")).toHaveLength(0);
        expect(await settingsGateway.getRequests("config.patch")).toHaveLength(0);
        await page.reload();
        await page.locator(".agent-chat__composer-combobox textarea").waitFor({ state: "visible" });
        expect(await pill.count()).toBe(0);
        // The preference hides chat presentation; saved Details still reads current progress.
        await gateway.waitForRequest("progressCard.get");
        await openChatTaskProgress(page);
        await expect
          .poll(() => progress.textContent())
          .toContain("The task progressed while the card was hidden.");
        await closeChatDetails(page);
        expect(await pill.count()).toBe(0);
        await settingsPage.reload();
        await waitForControlUiSettingsTakeover(settingsPage);
        await expect.poll(enabled).toBe(false);

        await showRow.click();
        await expect.poll(enabled).toBe(true);
        await pill.waitFor();
        await page.setViewportSize({ width: 1280, height: 900 });
        await page.locator(".chat-details-toggle").waitFor();
        const card = await openChatTaskProgress(page);
        await expect
          .poll(() => card.textContent())
          .toContain("The task progressed while the card was hidden.");
        expect(await card.getAttribute("open")).toBeNull();
        const persisted = await settingsPage.evaluate(
          (key) => JSON.parse(localStorage.getItem(key) ?? "{}"),
          controlUiBundledSettingsStorageKey(suite.server.baseUrl),
        );
        expect(persisted.chatCollapseTaskProgress).toBe(true);
        expect(persisted).not.toHaveProperty("chatShowTaskProgress");
        expect(await gateway.getRequests("progressCard.put")).toHaveLength(0);
        expect(await gateway.getRequests("chat.abort")).toHaveLength(0);
        expect(await settingsGateway.getRequests("config.patch")).toHaveLength(0);
        await settingsPage.close();
      },
    );
  });
});
