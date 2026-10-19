import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { createChatFlowE2eSuite, installMockGateway } from "./chat-flow.test-support.ts";
import { openChatSidePanelType } from "./chat-side-panel.test-support.ts";

const suite = createChatFlowE2eSuite();

suite.define(() => {
  it.each([false, true])(
    "keeps sibling folders usable after a directory refresh (missing: %s)",
    async (missing) => {
      const artifacts = createControlUiE2eArtifactDir(
        missing ? "files-missing-directory" : "files-existing-directory",
      );
      await suite.withPage({}, async ({ page }) => {
        const baseListing = { sessionKey: "main", root: "/workspace", files: [] };
        const rootListing = {
          ...baseListing,
          browser: {
            path: "",
            entries: [
              { kind: "directory", name: "reports", path: "reports" },
              { kind: "directory", name: "other", path: "other" },
            ],
          },
        };
        const directoryListing = (folder: string, name: string) => ({
          ...baseListing,
          browser: {
            path: folder,
            parentPath: "",
            entries: [{ kind: "file", name, path: `${folder}/${name}`, size: 12 }],
          },
        });
        const gateway = await installMockGateway(page, {
          methodResponses: {
            "artifacts.list": { artifacts: [] },
            "sessions.files.list": rootListing,
          },
        });
        await page.goto(`${suite.server.baseUrl}chat`);
        await openChatSidePanelType(page, "Files");
        const rail = page.locator(".workspace-desktop");
        await rail.getByRole("button", { name: "reports", exact: true }).waitFor();
        await gateway.setMethodResponse(
          "sessions.files.list",
          directoryListing("reports", "notes.md"),
        );
        await rail.getByRole("button", { name: "reports", exact: true }).click();
        const originalFile = rail.getByRole("button", {
          name: "reports/notes.md",
          exact: true,
        });
        await originalFile.waitFor();

        // A removed or renamed directory returns a successful listing without browser.
        const refreshedRoot = {
          ...rootListing,
          browser: {
            ...rootListing.browser,
            entries: rootListing.browser.entries.filter(
              (entry) => !missing || entry.path !== "reports",
            ),
          },
        };
        await gateway.setMethodResponse("sessions.files.list", {
          cases: [
            { match: { path: "" }, response: refreshedRoot },
            {
              match: { path: "reports" },
              response: missing ? baseListing : directoryListing("reports", "refreshed.md"),
            },
          ],
        });
        await gateway.emitChatFinal({ runId: "folder-change", text: "Workspace updated." });
        await originalFile.waitFor({ state: "hidden" });
        if (!missing) {
          await rail.getByRole("button", { name: "reports/refreshed.md", exact: true }).waitFor();
        }
        await page.screenshot({ path: path.join(artifacts, "after-refresh.png") });
        await writeFile(
          path.join(artifacts, "requests-before-recovery.json"),
          JSON.stringify(await gateway.getRequests("sessions.files.list"), null, 2),
        );
        await rail.getByRole("button", { name: "other", exact: true }).waitFor();
        await gateway.setMethodResponse(
          "sessions.files.list",
          directoryListing("other", "keep.md"),
        );
        await rail.getByRole("button", { name: "other", exact: true }).click();
        await rail.getByRole("button", { name: "other/keep.md", exact: true }).waitFor();
        await page.screenshot({ path: path.join(artifacts, "sibling-folder.png") });
      });
    },
  );

  it("keeps a newly opened project file selected after an older directory response", async () => {
    const artifacts = createControlUiE2eArtifactDir("files-directory-selection");
    await suite.withPage({}, async ({ page }) => {
      const rootListing = {
        sessionKey: "agent:main:main",
        root: "/workspace",
        files: [],
        browser: { path: "", entries: [{ kind: "directory", name: "reports", path: "reports" }] },
      };
      const reportsListing = {
        ...rootListing,
        browser: {
          path: "reports",
          entries: [
            { kind: "file", name: "inventory.csv", path: "reports/inventory.csv", size: 24 },
          ],
        },
      };
      const gateway = await installMockGateway(page, {
        historyMessages: [
          { role: "assistant", content: [{ type: "text", text: "Open `reports/inventory.csv`." }] },
        ],
        methodResponses: {
          "artifacts.list": { artifacts: [] },
          "sessions.files.list": {
            cases: [
              { match: { path: "" }, response: rootListing },
              { match: { path: "reports" }, response: reportsListing },
            ],
          },
          "sessions.files.get": {
            sessionKey: "agent:main:main",
            root: "/workspace",
            file: {
              name: "inventory.csv",
              path: "reports/inventory.csv",
              workspacePath: "reports/inventory.csv",
              content: "item,count\nnotebooks,3\n",
              previewKind: "text",
              contentEncoding: "utf8",
            },
          },
        },
      });
      await page.goto(`${suite.server.baseUrl}chat`);
      await openChatSidePanelType(page, "Files");
      const rail = page.locator(".workspace-desktop");
      await rail.getByRole("button", { name: "reports", exact: true }).waitFor();
      await gateway.deferNext("sessions.files.list", { path: "" });
      await gateway.emitChatFinal({ runId: "directory-refresh", text: "Report is ready." });
      await expect
        .poll(async () => (await gateway.getRequests("sessions.files.list")).length)
        .toBe(2);
      await page.locator('a.markdown-file-link[data-file-path="reports/inventory.csv"]').click();
      await expect
        .poll(() => page.locator(".chat-files-panel__page:not([hidden]) .cm-content").textContent())
        .toContain("notebooks");
      const fileTab = page.getByRole("tab", { name: "inventory.csv", exact: true });
      expect(await fileTab.getAttribute("aria-selected")).toBe("true");
      await rail.getByRole("button", { name: "reports", exact: true }).click();
      await gateway.resolveDeferred(
        "sessions.files.list",
        {
          ...rootListing,
          browser: {
            ...rootListing.browser,
            entries: [
              ...rootListing.browser.entries,
              { kind: "directory", name: "refreshed-root", path: "refreshed-root" },
            ],
          },
        },
        { match: { path: "" } },
      );
      // This new root entry proves the held response committed before selection is checked.
      await rail.getByRole("button", { name: "refreshed-root", exact: true }).waitFor();
      const row = rail.getByRole("button", { name: "reports/inventory.csv", exact: true });
      await row.waitFor();
      await page.mouse.click(600, 300);
      await page.screenshot({ path: path.join(artifacts, "selection.png") });
      await writeFile(
        path.join(artifacts, "observations.json"),
        JSON.stringify(
          {
            requests: await gateway.getRequests("sessions.files.list"),
            rowClass: await row.getAttribute("class"),
          },
          null,
          2,
        ),
      );
      expect(await row.getAttribute("aria-current")).toBe("true");
      expect(await fileTab.getAttribute("aria-selected")).toBe("true");
      expect(
        await page.locator(".chat-files-panel__page:not([hidden]) .cm-content").textContent(),
      ).toContain("notebooks");
      expect(await gateway.getRequests("sessions.files.get")).toHaveLength(1);
      const requests = await gateway.getRequests("sessions.files.list");
      expect(requests.map((request) => request.params)).toEqual(
        ["", "", "reports"].map((folderPath) => expect.objectContaining({ path: folderPath })),
      );
    });
  });
});
