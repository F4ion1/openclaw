import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { selectChatLayoutAction } from "../test-helpers/chat-layout-menu.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { createChatFlowE2eSuite, installMockGateway } from "./chat-flow.test-support.ts";
import { openChatSidePanelType } from "./chat-side-panel.test-support.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";

const suite = createChatFlowE2eSuite();

suite.define(() => {
  it("retries a failed post-run listing without hiding a rejected retry", async () => {
    const proofRoot = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
    const proof = proofRoot
      ? createControlUiE2eArtifactDir("files-list-recovery", proofRoot)
      : undefined;
    const viewport = { width: 1280, height: 900 };
    const context = await suite.newBrowserContext({
      ...createControlUiE2eContextOptions(),
      viewport,
      ...(proof ? { recordVideo: { dir: proof, size: viewport } } : {}),
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "sessions.files.list": {
          sessionKey: "main",
          root: "/workspace",
          files: [{ kind: "modified", name: "checklist.md", path: "checklist.md", size: 42 }],
        },
        "artifacts.list": { artifacts: [] },
      },
    });
    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      await openChatSidePanelType(page, "Files");
      const rail = page.locator(".workspace-desktop");
      await rail.getByText("checklist.md", { exact: true }).waitFor();
      await gateway.deferNext("sessions.files.list");
      await gateway.emitChatFinal({ runId: "files-revision", text: "Checklist updated." });
      await expect
        .poll(async () => (await gateway.getRequests("sessions.files.list")).length)
        .toBe(2);
      await gateway.rejectDeferred("sessions.files.list", {
        code: "UNAVAILABLE",
        message: "Session workspace changed during file read",
      });
      const error = rail.getByText("Session workspace changed during file read", { exact: true });
      await error.waitFor();
      await selectChatLayoutAction(page, "Collapse session workspace");
      await rail.waitFor({ state: "hidden" });
      await openChatSidePanelType(page, "Files");
      await error.waitFor();
      expect(await gateway.getRequests("sessions.files.list")).toHaveLength(2);
      const retry = rail.getByRole("button", { name: "Retry", exact: true });
      if (proof) {
        const frame = await takeControlUiScreenshotFrame(page, rail, [error], {
          animations: "disabled",
        });
        await writeFile(path.join(proof, "retry.png"), frame.png);
        await page.screenshot({ path: path.join(proof, "retry-context.png") });
      }
      await retry.waitFor();
      await gateway.deferNext("sessions.files.list");
      await retry.click();
      await expect
        .poll(async () => (await gateway.getRequests("sessions.files.list")).length)
        .toBe(3);
      await gateway.rejectDeferred("sessions.files.list", {
        code: "FORBIDDEN",
        message: "Session files are unavailable",
      });
      const denied = rail.getByRole("alert");
      await expect.poll(() => denied.textContent()).toBe("Session files are unavailable");
      expect(await rail.locator(".workspace-desktop__row").count()).toBe(0);
      expect(await gateway.getRequests("sessions.files.list")).toHaveLength(3);
      await retry.click();
      await rail.getByText("checklist.md", { exact: true }).waitFor();
      const requests = await gateway.getRequests("sessions.files.list");
      expect(requests).toHaveLength(4);
      expect(requests[2]?.params).toEqual(requests[1]?.params);
      expect(requests[3]?.params).toEqual(requests[1]?.params);
      expect(await denied.count()).toBe(0);
      expect(await retry.count()).toBe(0);
      if (proof) {
        const frame = await takeControlUiScreenshotFrame(
          page,
          rail,
          [rail.getByText("checklist.md", { exact: true })],
          { animations: "disabled" },
        );
        await writeFile(path.join(proof, "recovered.png"), frame.png);
      }
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("starts the workspace files panel collapsed and toggles it open", async () => {
    const context = await suite.newBrowserContext(createControlUiE2eContextOptions());
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      featureMethods: ["chat.metadata", "chat.startup", "sessions.diff"],
      methodResponses: {
        "artifacts.list": {
          artifacts: [
            {
              download: { mode: "bytes" },
              id: "artifact-1",
              mimeType: "image/png",
              sizeBytes: 128,
              title: "preview.png",
              type: "image",
            },
          ],
        },
        "sessions.files.list": {
          browser: {
            entries: [
              {
                kind: "directory",
                name: "src",
                path: "src",
                sessionKind: "modified",
              },
              {
                kind: "file",
                name: "package.json",
                path: "package.json",
                size: 4096,
              },
            ],
            path: "",
          },
          files: [
            {
              kind: "modified",
              missing: false,
              name: "AGENTS.md",
              path: "/workspace/AGENTS.md",
              size: 2048,
            },
          ],
          root: "/workspace",
          sessionKey: "main",
        },
        "sessions.diff": {
          additions: 1,
          branch: "main",
          deletions: 0,
          files: [
            {
              additions: 1,
              deletions: 0,
              path: "AFTER_RUN.md",
              status: "modified",
            },
          ],
          root: "/workspace",
          sessionKey: "main",
        },
      },
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      expect(await gateway.getRequests("sessions.files.list")).toHaveLength(0);
      expect(await page.locator(".workspace-desktop:visible").count()).toBe(0);

      await openChatSidePanelType(page, "Files");
      await page.locator(".workspace-desktop__row", { hasText: "AGENTS.md" }).waitFor({
        timeout: 10_000,
      });
      await page
        .locator(".workspace-desktop__row", { hasText: "preview.png" })
        .waitFor({ timeout: 10_000 });
      await page.getByText("Project files").waitFor({ timeout: 10_000 });
      await page.locator(".workspace-desktop__row", { hasText: "package.json" }).waitFor({
        timeout: 10_000,
      });
      expect(await gateway.getRequests("sessions.files.list")).toHaveLength(1);
      expect(await gateway.getRequests("artifacts.list")).toHaveLength(1);
      expect(
        await page.locator(".workspace-desktop").evaluate((element) => {
          return window.innerWidth - element.getBoundingClientRect().right;
        }),
      ).toBe(0);

      await selectChatLayoutAction(page, "Collapse session workspace");
      await page.locator(".workspace-desktop").waitFor({ state: "hidden" });
      expect(await page.locator(".workspace-desktop:visible").count()).toBe(0);
      await gateway.setMethodResponse("sessions.files.list", {
        files: [
          {
            kind: "modified",
            name: "AFTER_RUN.md",
            path: "/workspace/AFTER_RUN.md",
          },
        ],
      });
      await gateway.emitChatFinal({
        runId: "workspace-closed-run",
        text: "Workspace stayed closed.",
      });
      await expect.poll(() => page.getByText("Workspace stayed closed.").count()).toBe(1);
      expect(await gateway.getRequests("sessions.files.list")).toHaveLength(1);

      await openChatSidePanelType(page, "Files");
      await expect
        .poll(async () => (await gateway.getRequests("sessions.files.list")).length)
        .toBe(2);
      await page.locator(".workspace-desktop__row", { hasText: "AFTER_RUN.md" }).waitFor({
        timeout: 10_000,
      });
      expect(await gateway.getRequests("sessions.files.list")).toHaveLength(2);

      await openChatSidePanelType(page, "Review");
      await page.locator('[data-panel-slot="detail"]:not([hidden])').waitFor();
      await page.getByRole("button", { name: "Actions for AFTER_RUN.md" }).click();
      await page.locator('openclaw-session-diff-menu button[value="reveal-file"]').click();
      await expect
        .poll(async () => (await gateway.getRequests("sessions.files.list")).length)
        .toBe(3);
      await page.locator(".workspace-desktop__row", { hasText: "AFTER_RUN.md" }).waitFor({
        timeout: 10_000,
      });
      await page.locator(".tabstrip-tab").filter({ hasText: "Review" }).click();
      await gateway.setMethodResponse("sessions.files.list", {
        files: [
          {
            kind: "modified",
            name: "AFTER_REVIEW.md",
            path: "/workspace/AFTER_REVIEW.md",
          },
        ],
      });
      await gateway.emitChatFinal({
        runId: "workspace-inactive-run",
        text: "Workspace stayed inactive.",
      });
      await page.getByText("Workspace stayed inactive.").first().waitFor();
      expect(await gateway.getRequests("sessions.files.list")).toHaveLength(3);

      await page.locator(".tabstrip-tab").filter({ hasText: "Files" }).click();
      await expect
        .poll(async () => (await gateway.getRequests("sessions.files.list")).length)
        .toBe(4);
      await page
        .locator(".workspace-desktop__row", { hasText: "AFTER_REVIEW.md" })
        .waitFor({ timeout: 10_000 });

      await page.setViewportSize({ height: 900, width: 640 });
      const workspaceRail = page.locator(".chat-workspace-mobile");
      await workspaceRail.waitFor();
      await expect
        .poll(async () => {
          const box = await workspaceRail.boundingBox();
          return Boolean(box && box.width > 0 && box.height > 0);
        })
        .toBe(true);
      expect(await page.locator(".chat-workspace-rail__dock").count()).toBe(0);
      expect(await page.locator(".chat-workspace-rail__grip").count()).toBe(0);
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("scrolls long file groups beneath the search toolbar and filters session files", async () => {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 720, width: 1280 },
    });
    const page = await context.newPage();
    const browserEntries = Array.from({ length: 60 }, (_, index) => ({
      kind: "file" as const,
      name: `file-${String(index + 1).padStart(2, "0")}.ts`,
      path: `file-${String(index + 1).padStart(2, "0")}.ts`,
      size: 2048 + index,
    }));
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "sessions.files.list": {
          browser: { entries: browserEntries, path: "" },
          files: [
            ...Array.from({ length: 2 }, (_, index) => ({
              kind: "modified",
              name: `changed-${index + 1}.ts`,
              path: `src/changed-${index + 1}.ts`,
              missing: false,
            })),
            ...["read-file-1.ts", "read-file-2.ts", "notes.md"].map((name) => ({
              kind: "read",
              name,
              path: `src/${name}`,
              missing: false,
            })),
          ],
          root: "/workspace",
          sessionKey: "main",
        },
        "artifacts.list": {
          artifacts: [
            {
              id: "artifact-1",
              title: "preview.png",
              mimeType: "image/png",
              sizeBytes: 2048,
              type: "image",
              download: { mode: "bytes" },
            },
          ],
        },
      },
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      await openChatSidePanelType(page, "Files");
      await page.locator(".workspace-desktop__row", { hasText: "file-60.ts" }).waitFor({
        timeout: 10_000,
      });
      expect(await gateway.getRequests("sessions.files.list")).toHaveLength(1);

      const rail = page.locator(".workspace-desktop");
      const scroll = rail.locator(".workspace-desktop__project-scroll");
      const toolbar = rail.locator(".workspace-desktop__toolbar");
      const before = await toolbar.boundingBox();
      await expect
        .poll(() =>
          scroll.evaluate((element) => ({
            overflows: element.scrollHeight > element.clientHeight,
            overflowY: getComputedStyle(element).overflowY,
          })),
        )
        .toEqual({ overflows: true, overflowY: "auto" });
      await scroll.hover();
      await page.mouse.wheel(0, 600);
      await expect.poll(() => scroll.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
      await scroll.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      const after = await toolbar.boundingBox();
      expect(before).not.toBeNull();
      expect(after).toEqual(before);
      await rail.getByRole("button", { name: "Filter files: All", exact: true }).click();
      await rail.getByRole("menuitemradio", { name: "Read", exact: true }).click();
      await expect
        .poll(() => rail.locator(".workspace-desktop__row:visible").allTextContents())
        .toEqual(["read-file-1.ts", "read-file-2.ts", "notes.md"]);
      await rail.getByRole("button", { name: "Filter files: Read", exact: true }).click();
      expect(
        await rail
          .getByRole("menuitemradio", { name: "Read", exact: true })
          .getAttribute("aria-checked"),
      ).toBe("true");
      await page.keyboard.press("Escape");

      await rail.getByRole("button", { name: "Search files", exact: true }).click();
      await rail.getByRole("searchbox", { name: "Search files", exact: true }).fill("read-file");
      const results = rail.locator(".workspace-desktop__results .workspace-desktop__row:visible");
      await expect
        .poll(() => results.locator(".workspace-desktop__filename").allTextContents())
        .toEqual(["read-file-1.ts", "read-file-2.ts"]);
      expect(
        await results.evaluateAll((buttons) =>
          buttons.map((button) => button.getAttribute("aria-label")),
        ),
      ).toEqual(["src/read-file-1.ts", "src/read-file-2.ts"]);
    } finally {
      await suite.closeBrowserContext(context);
    }
  });
});
