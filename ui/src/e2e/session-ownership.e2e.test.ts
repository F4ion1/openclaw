import type { Page } from "playwright";
import { expect as expectBrowser } from "playwright/test";
import { afterEach, expect, it } from "vitest";
import {
  controlUiSessionUrl,
  installMockGateway,
  pauseVirtualClock,
} from "../test-helpers/control-ui-e2e.ts";
import { closeChatDetails, openChatDetailsPeople } from "./chat-details.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { replaceGatewayClient } from "./new-session-page.test-support.ts";
import {
  collaborativeSessionsList,
  draftSessionsList,
  sessionsList,
} from "./session-ownership-fixtures.test-support.ts";
import {
  captureSessionOwnerPageProof,
  captureSessionOwnerProof,
  captureUiProof,
  captureUiProofEnabled,
  createSessionOwnershipProofContext,
  openSidebarSortMenu,
  routeAvatarFixtures,
} from "./session-ownership-visuals.test-support.ts";
import {
  chooseSidebarOwner,
  chooseSidebarMenuOption,
  closeSidebarMenu,
  openSidebarMenu,
} from "./sidebar-session-menu.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI session ownership",
});

let page: Page | undefined;

suite.define(() => {
  afterEach(async () => {
    await page
      ?.context()
      .close()
      .catch(() => {});
    page = undefined;
  });

  it("keeps collaborative owner stacks legible without shifting session rows", async () => {
    const context = await suite.browser.newContext({ viewport: { height: 800, width: 1200 } });
    const currentPage = await context.newPage();
    page = currentPage;
    await routeAvatarFixtures(currentPage, [
      { id: "profile-ada", background: "#3f6f76", label: "A" },
      { id: "profile-bob", background: "#985b42", label: "B" },
    ]);
    await installMockGateway(currentPage, {
      hasMultipleSessionSharingIdentities: true,
      sessionKey: "agent:main:collaboration",
      historyMessages: [{ role: "assistant", content: [{ type: "text", text: "Ready." }] }],
      methodResponses: { "sessions.list": collaborativeSessionsList() },
    });

    await currentPage.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:collaboration"));
    const collaborativeRow = currentPage.locator('[data-session-key="agent:main:collaboration"]');
    const overflowRow = currentPage.locator('[data-session-key="agent:main:release-planning"]');
    const singleOwnerRow = currentPage.locator('[data-session-key="agent:main:single-owner"]');
    await collaborativeRow.waitFor();
    await overflowRow.waitFor();
    await singleOwnerRow.waitFor();
    await expect.poll(() => collaborativeRow.locator(".session-owner-stack img").count()).toBe(2);
    await expect
      .poll(() =>
        collaborativeRow
          .locator(".session-owner-stack img")
          .evaluateAll((images) =>
            images.every(
              (image) =>
                image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0,
            ),
          ),
      )
      .toBe(true);

    const geometry = await collaborativeRow.evaluate((row) => {
      const stack = row.querySelector<HTMLElement>(".session-owner-stack");
      const back = row.querySelector<HTMLElement>(".session-owner-stack__back .viewer-avatar");
      const front = row.querySelector<HTMLElement>(".session-owner-stack__front");
      const slot = row.querySelector<HTMLElement>(".sidebar-session-indicator");
      const text = row.querySelector<HTMLElement>(".sidebar-recent-session__text");
      if (!stack || !back || !front || !slot || !text) {
        throw new Error("expected complete collaborative session row");
      }
      const stackBounds = stack.getBoundingClientRect();
      const backBounds = back.getBoundingClientRect();
      const frontBounds = front.getBoundingClientRect();
      const slotBounds = slot.getBoundingClientRect();
      const textBounds = text.getBoundingClientRect();
      return {
        backSize: [Math.round(backBounds.width), Math.round(backBounds.height)],
        centerDelta:
          stackBounds.left + stackBounds.width / 2 - (slotBounds.left + slotBounds.width / 2),
        frontSize: [Math.round(frontBounds.width), Math.round(frontBounds.height)],
        overlap: backBounds.right - frontBounds.left,
        reveal: frontBounds.left - backBounds.left,
        slotWidth: slotBounds.width,
        stackSize: [Math.round(stackBounds.width), Math.round(stackBounds.height)],
        textGap: textBounds.left - stackBounds.right,
      };
    });
    expect(geometry).toEqual({
      backSize: [18, 18],
      centerDelta: 0,
      frontSize: [18, 18],
      overlap: 8,
      reveal: 10,
      slotWidth: 20,
      stackSize: [28, 20],
      textGap: 4,
    });
    await expectBrowser(overflowRow.locator(".session-owner-stack__overflow")).toHaveText("+2");
    const rowHeights = await Promise.all([
      collaborativeRow.evaluate((row) => row.getBoundingClientRect().height),
      singleOwnerRow.evaluate((row) => row.getBoundingClientRect().height),
    ]);
    expect(rowHeights[0]).toBeCloseTo(rowHeights[1] ?? 0, 5);
    const titleLefts = await Promise.all(
      [collaborativeRow, singleOwnerRow].map((row) =>
        row
          .locator(".sidebar-recent-session__text")
          .evaluate((text) => text.getBoundingClientRect().left),
      ),
    );
    expect(titleLefts[0]).toBeCloseTo(titleLefts[1] ?? 0, 5);

    if (captureUiProofEnabled) {
      const legacyStyles = await currentPage.addStyleTag({
        content: `
          .session-owner-stack { width: 24px; }
          .session-owner-stack__back { width: 14px; height: 14px; }
          .session-owner-stack__back .viewer-avatar,
          .session-owner-stack__overflow { width: 14px; height: 14px; font-size: 7px; }
          .session-owner-stack__front { width: 20px; height: 20px; }
        `,
      });
      await captureSessionOwnerProof(suite, currentPage, "00-before-light.png");
      await currentPage.evaluate(() =>
        document.documentElement.setAttribute("data-theme-mode", "dark"),
      );
      await captureSessionOwnerProof(suite, currentPage, "01-before-dark.png");
      await legacyStyles.evaluate((style) => style.parentNode?.removeChild(style));
      await captureSessionOwnerProof(suite, currentPage, "02-after-dark.png");
      await currentPage.evaluate(() =>
        document.documentElement.setAttribute("data-theme-mode", "light"),
      );
      await captureSessionOwnerProof(suite, currentPage, "03-after-light.png");
    }
  });

  it("derives People controls and owner filtering from current session owners", async () => {
    const context = await createSessionOwnershipProofContext(suite, "session-owner-stack");
    const currentPage = await context.newPage();
    page = currentPage;
    await routeAvatarFixtures(currentPage, [
      { id: "profile-patrick", background: "#27496d", label: "P" },
      { id: "profile-ada", background: "#3f6f76", label: "A" },
      { id: "profile-bob", background: "#985b42", label: "B" },
    ]);
    const gateway = await installMockGateway(currentPage, {
      hasMultipleSessionSharingIdentities: false,
      sessionKey: "agent:main:ada",
      presenceUsers: [
        {
          self: true,
          id: "profile-patrick",
          name: "Patrick",
          avatarUrl: "/api/users/profile-patrick/avatar?v=1",
        },
      ],
      historyMessages: [{ role: "assistant", content: [{ type: "text", text: "Ready." }] }],
      methodResponses: { "sessions.list": sessionsList(["profile-ada", "profile-bob"], true) },
    });

    await currentPage.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:ada"));
    await chooseSidebarOwner(currentPage, "all");
    await closeSidebarMenu(currentPage);
    await currentPage.getByText("Ada research", { exact: true }).first().waitFor();
    await currentPage.getByText("Bob operations", { exact: true }).first().waitFor();
    await currentPage.locator('[data-session-key="agent:main:ada"] a').click();
    await currentPage.getByText("Ready.", { exact: true }).waitFor();
    for (const sessionKey of ["agent:main:ada", "agent:main:bob"]) {
      await expectBrowser(
        currentPage.locator('[data-session-key="' + sessionKey + '"] openclaw-session-owner-chip'),
      ).toHaveCount(1);
    }
    const people = await openChatDetailsPeople(currentPage);
    await expectBrowser(people.getByRole("link", { name: "Ada Owner", exact: true })).toBeVisible();
    await closeChatDetails(currentPage);

    const ownerMenu = await openSidebarSortMenu(currentPage);
    await ownerMenu.locator("#sidebar-sessions-group").click();
    await expectBrowser(
      ownerMenu.getByRole("option", { name: "Person", exact: true }),
    ).toBeVisible();
    await currentPage.keyboard.press("Escape");
    await ownerMenu.locator("#sidebar-sessions-sort").click();
    await expectBrowser(
      ownerMenu.getByRole("option", { name: "Owners", exact: true }),
    ).toBeVisible();
    await currentPage.keyboard.press("Escape");
    const ownerSelect = currentPage.locator("#sidebar-session-owner-title");
    await ownerSelect.click();
    const ownerRows = currentPage.locator(
      '.sidebar-session-owner-filter [role="option"][data-value^="owner:"]',
    );
    await expectBrowser(ownerRows).toHaveCount(3);
    await expectBrowser(ownerRows.first()).toHaveAttribute("data-value", "owner:profile-patrick");
    await expectBrowser(ownerRows.first()).toContainText("My sessions");
    await captureUiProof(
      suite,
      currentPage.locator(".sidebar-shell"),
      "00-people-controls-from-session-owners.png",
      [ownerSelect],
    );
    await currentPage.keyboard.press("Escape");
    await chooseSidebarMenuOption(ownerMenu.page(), "Group by", "Person");
    await closeSidebarMenu(currentPage);
    await expectBrowser(
      currentPage.locator('[data-session-section="person:profile:profile-ada"]'),
    ).toContainText("Ada research");
    await expectBrowser(
      currentPage.locator('[data-session-section="person:profile:profile-bob"]'),
    ).toContainText("Bob operations");

    const groupedMenu = await openSidebarSortMenu(currentPage);
    await expectBrowser(groupedMenu.locator("#sidebar-sessions-group")).toHaveAccessibleName(
      "Group by: Person",
    );
    await chooseSidebarMenuOption(groupedMenu.page(), "Group by", "Custom groups");
    await closeSidebarMenu(currentPage);

    const sortableMenu = await openSidebarSortMenu(currentPage);
    await chooseSidebarMenuOption(sortableMenu.page(), "Sort by", "Owners");
    await closeSidebarMenu(currentPage);
    const peopleMenu = await openSidebarSortMenu(currentPage);
    await expectBrowser(peopleMenu.locator("#sidebar-sessions-sort")).toHaveAccessibleName(
      "Sort by: Owners",
    );
    await captureUiProof(
      suite,
      peopleMenu.locator(".sidebar-session-filter-panel"),
      "01-people-sort-selected.png",
      [peopleMenu.locator("#sidebar-sessions-sort")],
    );
    const expectOwnerFilter = async (after: number) => {
      // The chat title survives a sidebar refresh; wait for the filtered row itself.
      await expectBrowser(
        currentPage.locator('[data-session-section="category:Research"]'),
      ).toContainText("Ada research");
      await expectBrowser(currentPage.locator('[data-session-key="agent:main:ada"]')).toBeVisible();
      await expectBrowser(currentPage.locator('[data-session-key="agent:main:bob"]')).toHaveCount(
        0,
      );
      await expectBrowser(
        currentPage.locator('[data-session-section="category:Operations"]'),
      ).toHaveCount(0);
      // The shared roster may also refresh, so the filtered request need not be last.
      await expect
        .poll(async () => (await gateway.getRequests("sessions.list")).slice(after))
        .toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              params: expect.objectContaining({ ownerId: "profile-ada" }),
            }),
          ]),
        );
    };
    const beforeSelection = (await gateway.getRequests("sessions.list")).length;
    await openSidebarMenu(currentPage);
    await chooseSidebarOwner(currentPage, "owner:profile-ada");
    await closeSidebarMenu(currentPage);
    await expectOwnerFilter(beforeSelection);
    await captureSessionOwnerProof(suite, currentPage, "04-owner-filter-selected.png");

    const initialConnections = (await gateway.getRequests("connect")).length;
    const beforeReconnect = (await gateway.getRequests("sessions.list")).length;
    await gateway.closeLatest(1012, "owner filter reconnect proof");
    await expect
      .poll(async () => (await gateway.getRequests("connect")).length)
      .toBeGreaterThan(initialConnections);
    await expectOwnerFilter(beforeReconnect);
    await expectBrowser(currentPage.locator("#sidebar-session-owner-title")).toHaveAccessibleName(
      "Owners: Ada",
    );

    await currentPage.reload();
    // Reload starts a new in-page request log, so no earlier traffic can satisfy this.
    await expectOwnerFilter(0);
    await expectBrowser(currentPage.locator("#sidebar-session-owner-title")).toHaveAccessibleName(
      "Owners: Ada",
    );
    await captureSessionOwnerPageProof(
      suite,
      currentPage.locator(".sidebar-shell"),
      "05-owner-filter-restored-after-reload.png",
      [currentPage.locator("#sidebar-session-owner-title")],
    );
  });

  it("keeps unrelated active sessions out of the involving-me filter", async () => {
    const context = await createSessionOwnershipProofContext(suite, "session-owner-stack");
    const currentPage = await context.newPage();
    page = currentPage;
    const allSessions = sessionsList(["profile-ada", "profile-bob"]);
    const gateway = await installMockGateway(currentPage, {
      hasMultipleSessionSharingIdentities: true,
      sessionKey: "agent:main:ada",
      presenceUsers: [{ self: true, id: "profile-ada", name: "Ada" }],
      historyMessages: [{ role: "assistant", content: [{ type: "text", text: "Ready." }] }],
      methodResponses: {
        "config.get": { config: {}, hash: "owner-filter-fixture" },
        "sessions.list": {
          cases: [
            {
              match: { involvingMe: true },
              response: {
                ...allSessions,
                count: 1,
                sessions: allSessions.sessions.filter(
                  (session) => session.key === "agent:main:ada",
                ),
              },
            },
            { response: allSessions },
          ],
        },
      },
    });

    await currentPage.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:ada"));
    await chooseSidebarOwner(currentPage, "all");
    await closeSidebarMenu(currentPage);
    await currentPage.getByText("Bob operations", { exact: true }).first().waitFor();
    await chooseSidebarOwner(currentPage, "involving-me");
    await closeSidebarMenu(currentPage);
    await expect
      .poll(() => currentPage.locator('[data-session-key="agent:main:bob"]').count())
      .toBe(0);
    await expect
      .poll(async () =>
        (await gateway.getRequests("sessions.list")).some(
          (request) =>
            (request.params as { involvingMe?: unknown } | undefined)?.involvingMe === true,
        ),
      )
      .toBe(true);
    await captureSessionOwnerProof(suite, currentPage, "02-involving-me-before-active-event.png");

    await gateway.emitGatewayEvent("session.message", {
      sessionKey: "agent:main:bob",
      key: "agent:main:bob",
      kind: "direct",
      updatedAt: 3,
      archived: false,
      hasActiveRun: true,
      status: "running",
      owner: { actor: { type: "human", id: "profile-bob", label: "Bob" } },
      participants: [],
      participantCount: 0,
    });

    await expect
      .poll(() => currentPage.locator('[data-session-key="agent:main:bob"]').count())
      .toBe(0);
    await expectBrowser(currentPage.locator('[data-session-key="agent:main:ada"]')).toBeVisible();
    await expectBrowser(currentPage.locator("#sidebar-session-owner-title")).toHaveAccessibleName(
      "Owners: Involving me",
    );
    await captureSessionOwnerProof(suite, currentPage, "03-involving-me-after-active-event.png");
    await currentPage.reload();
    await expectBrowser(currentPage.locator('[data-session-key="agent:main:ada"]')).toBeVisible();
    await expect
      .poll(async () =>
        (await gateway.getRequests("sessions.list")).some((request) => {
          const params = request.params as { involvingMe?: unknown; ownerId?: unknown } | undefined;
          return params?.involvingMe === true && params.ownerId === undefined;
        }),
      )
      .toBe(true);
    await expectBrowser(currentPage.locator('[data-session-key="agent:main:bob"]')).toHaveCount(0);
    await expectBrowser(currentPage.locator("#sidebar-session-owner-title")).toHaveAccessibleName(
      "Owners: Involving me",
    );
  });

  it("hides owner avatars with one human and agents, then reveals them for another human", async () => {
    const context = await suite.browser.newContext({ viewport: { height: 800, width: 1200 } });
    const currentPage = await context.newPage();
    page = currentPage;
    const solo = sessionsList(["profile-ada", "profile-ada"]);
    const agent = {
      type: "agent" as const,
      id: "research",
      identity: { type: "agent" as const, id: "research" },
      label: "Research",
    };
    const result = {
      ...solo,
      owners: [...solo.owners, agent],
      sessions: solo.sessions.map((session) =>
        Object.assign({}, session, {
          participants: [{ identity: agent.identity, label: agent.label }],
          participantCount: 5,
        }),
      ),
    };
    const gateway = await installMockGateway(currentPage, {
      sessionKey: "agent:main:ada",
      presenceUsers: [{ self: true, id: "profile-ada", name: "Ada" }],
      historyMessages: [{ role: "assistant", content: [{ type: "text", text: "Ready." }] }],
      methodResponses: { "sessions.list": result },
    });
    await currentPage.clock.install();
    await currentPage.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:ada"));
    await chooseSidebarOwner(currentPage, "all");
    await closeSidebarMenu(currentPage);
    const row = currentPage.locator('[data-session-key="agent:main:ada"]');
    await expectBrowser(row).toBeVisible();
    await currentPage.getByText("Ready.", { exact: true }).waitFor();
    await captureSessionOwnerProof(suite, currentPage, "one-human-with-agents.png");
    await expectBrowser(row.locator("openclaw-session-owner-chip")).toHaveCount(0);

    await pauseVirtualClock(currentPage);
    await currentPage.evaluate(() => {
      Math.random = () => 0;
    });
    const rosterMatch = { includeGlobal: true };
    const initialRequests = (await gateway.getRequests("sessions.list", rosterMatch)).length;
    await gateway.setMethodResponse("sessions.list", sessionsList(["profile-ada", "profile-bob"]));
    await gateway.emitGatewayEvent("sessions.changed", {});
    await currentPage.clock.runFor(4_999);
    expect(await gateway.getRequests("sessions.list", rosterMatch)).toHaveLength(initialRequests);
    await expectBrowser(row.locator("openclaw-session-owner-chip")).toHaveCount(0);
    // Cross the event window and deliver the nested mock response timer.
    await currentPage.clock.runFor(2);
    expect(await gateway.getRequests("sessions.list", rosterMatch)).toHaveLength(
      initialRequests + 1,
    );
    await currentPage.clock.resume();
    await expectBrowser(row.locator("openclaw-session-owner-chip")).toHaveCount(1);
    await captureSessionOwnerProof(suite, currentPage, "multiple-humans.png");
  });

  it("keeps global session actions accessible to keyboard users", async () => {
    const context = await suite.browser.newContext({ viewport: { height: 800, width: 1200 } });
    const currentPage = await context.newPage();
    page = currentPage;
    await installMockGateway(currentPage, {
      sessionKey: "agent:main:ada",
      featureMethods: ["chat.metadata", "chat.startup", "sessions.create"],
      historyMessages: [{ role: "assistant", content: [{ type: "text", text: "Ready." }] }],
      methodResponses: { "sessions.list": sessionsList(["profile-ada", "profile-ada"]) },
    });

    await currentPage.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:ada"));
    await currentPage.getByText("Ada research", { exact: true }).first().waitFor();
    await currentPage.getByText("Bob operations", { exact: true }).first().waitFor();

    const filterAndSort = currentPage.getByRole("button", { name: "Filter & sort", exact: true });
    await filterAndSort.focus();
    await currentPage.keyboard.press("Enter");

    const menu = currentPage.locator(".sidebar-session-sort-menu");
    await menu.getByRole("dialog").waitFor();
    expect(await menu.locator("#sidebar-sessions-owner").count()).toBe(0);
    await menu.locator("#sidebar-sessions-group").click();
    expect(await menu.getByRole("option", { name: "Person", exact: true }).count()).toBe(0);
    await currentPage.keyboard.press("Escape");
    await menu.locator("#sidebar-sessions-sort").click();
    expect(await menu.getByRole("option", { name: "Owners", exact: true }).count()).toBe(0);
    await currentPage.keyboard.press("Escape");
    await chooseSidebarMenuOption(menu.page(), "Group by", "None");
    await closeSidebarMenu(currentPage);

    await expect
      .poll(() => currentPage.locator('[data-session-section^="category:"]').count())
      .toBe(0);
    const threads = currentPage.locator('[data-session-section="ungrouped"]');
    await expect.poll(() => threads.locator(".sidebar-recent-session").count()).toBe(2);

    const newThread = currentPage
      .locator(".sidebar-rail")
      .getByRole("link", { name: "New conversation" });
    await newThread.focus();
    await currentPage.keyboard.press("Enter");
    await expect.poll(() => new URL(currentPage.url()).pathname).toBe("/new");
  });

  it("keeps own drafts subtle and fades admin-visible drafts from other people", async () => {
    const context = await createSessionOwnershipProofContext(suite, "drafts-ux");
    const currentPage = await context.newPage();
    page = currentPage;
    await installMockGateway(currentPage, {
      sessionKey: "agent:main:ada",
      presenceUsers: [{ self: true, id: "profile-ada", name: "Ada" }],
      methodResponses: { "sessions.list": draftSessionsList() },
    });

    await currentPage.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:ada"));
    await chooseSidebarOwner(currentPage, "all");
    await closeSidebarMenu(currentPage);
    const ownDraft = currentPage.locator('[data-session-key="agent:main:ada"]');
    const otherDraft = currentPage.locator('[data-session-key="agent:main:bob"]');
    await ownDraft.waitFor();
    await otherDraft.waitFor();
    await expect
      .poll(() => ownDraft.getAttribute("class"))
      .toContain("session-row-host--draft-owner");
    await expect
      .poll(() => otherDraft.getAttribute("class"))
      .toContain("session-row-host--draft-other");
    expect(await currentPage.locator(".session-row-draft-indicator").count()).toBe(2);
    await captureUiProof(suite, currentPage.locator(".shell"), "01-sidebar-draft-treatment.png", [
      ownDraft,
      otherDraft,
    ]);
    await currentPage.evaluate(() =>
      document.documentElement.setAttribute("data-theme-mode", "dark"),
    );
    await captureUiProof(
      suite,
      currentPage.locator(".shell"),
      "01-sidebar-draft-treatment-dark.png",
      [ownDraft, otherDraft],
    );
  });

  it("creates a draft atomically from the multi-person new-session flow", async () => {
    const context = await createSessionOwnershipProofContext(suite, "drafts-ux");
    const currentPage = await context.newPage();
    page = currentPage;
    const gateway = await installMockGateway(currentPage, {
      allowedSessionVisibilities: ["shared", "draft"],
      featureMethods: ["chat.metadata", "chat.startup", "sessions.create"],
      hasMultipleSessionSharingIdentities: true,
      methodResponses: {
        "sessions.list": sessionsList(["profile-ada", "profile-bob"]),
        "sessions.create": { key: "agent:main:new-draft", runStarted: true },
      },
    });

    await currentPage.goto(`${suite.server?.baseUrl ?? ""}new`);
    // Playwright check()/isChecked() support role="switch" buttons via aria-checked.
    const draftToggle = currentPage.getByRole("switch", { name: "Draft", exact: true });
    await currentPage.locator(".new-session-page__composer .agent-chat__composer-footer").hover();
    await draftToggle.waitFor();
    await captureUiProof(suite, draftToggle, "02-create-draft-available.png", [draftToggle]);
    await draftToggle.check();
    await expectBrowser(draftToggle).toBeChecked();
    await currentPage.locator(".new-session-page__message").fill("work privately first");
    await captureUiProof(suite, draftToggle, "03-create-draft-selected.png", [
      currentPage.locator(".new-session-page__message"),
    ]);
    await currentPage.getByRole("button", { name: "Start session" }).click();

    const create = await gateway.waitForRequest("sessions.create");
    expect(create.params).toMatchObject({
      agentId: "main",
      message: "work privately first",
      visibility: "draft",
    });
  });

  it("keeps rejected visibility-only sharing changes visible after the menu closes", async () => {
    const context = await suite.browser.newContext({ viewport: { height: 800, width: 1200 } });
    const currentPage = await context.newPage();
    page = currentPage;
    const sessions = draftSessionsList();
    const ownerSession = sessions.sessions[0];
    if (!ownerSession) {
      throw new Error("expected owner draft fixture");
    }
    Object.assign(ownerSession, { sharingRole: "owner" });
    const gateway = await installMockGateway(currentPage, {
      sessionKey: "agent:main:ada",
      allowedSessionVisibilities: ["shared", "draft"],
      deferredMethods: ["session.visibility.set"],
      featureMethods: ["chat.metadata", "chat.startup", "session.visibility.set"],
      operatorScopes: ["operator.write"],
      historyMessages: [{ role: "assistant", content: [{ type: "text", text: "Ready." }] }],
      methodResponses: { "sessions.list": sessions },
    });

    await currentPage.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:ada"));
    await currentPage.getByText("Ready.", { exact: true }).waitFor();
    await currentPage.getByRole("button", { name: "Session sharing" }).click();
    const dropdown = currentPage.locator(".chat-pane__sharing-menu");
    const panel = dropdown.locator(".chat-pane__sharing-panel");
    await expect
      .poll(() => panel.evaluate((element) => element.matches(":popover-open")))
      .toBe(true);
    await expectBrowser(dropdown.locator(".chat-pane__sharing-permissions")).toHaveCount(0);
    await dropdown.getByRole("menuitem", { name: "Session access" }).click();
    await dropdown.getByRole("menuitemradio", { name: "Shared", exact: true }).click();
    await gateway.waitForRequest("session.visibility.set");
    await currentPage.getByRole("button", { name: "Session sharing" }).click();
    await expect
      .poll(() => panel.evaluate((element) => element.matches(":popover-open")))
      .toBe(false);
    expect(await gateway.getRequests("session.members.listEvidence")).toHaveLength(0);

    const message = "visibility change rejected";
    await gateway.rejectDeferred("session.visibility.set", {
      code: "INVALID_REQUEST",
      message,
    });
    const alert = currentPage.locator(".chat-error[role=alert]").filter({ hasText: message });
    await expectBrowser(alert).toBeVisible();

    await currentPage.getByRole("button", { name: "Session sharing" }).click();
    await expectBrowser(dropdown.getByRole("alert").filter({ hasText: message })).toBeVisible();
  });

  it("lets a read-scoped owner inspect sharing but blocks mutations", async () => {
    const context = await suite.browser.newContext({ viewport: { height: 800, width: 1200 } });
    const currentPage = await context.newPage();
    page = currentPage;
    const sessions = draftSessionsList();
    const ownerSession = sessions.sessions[0];
    if (!ownerSession) {
      throw new Error("expected owner draft fixture");
    }
    Object.assign(ownerSession, { sharingRole: "owner" });
    const gateway = await installMockGateway(currentPage, {
      sessionKey: "agent:main:ada",
      featureMethods: [
        "chat.metadata",
        "chat.startup",
        "session.visibility.set",
        "session.members.listEvidence",
        "session.members.add",
        "session.members.remove",
      ],
      operatorScopes: ["operator.read"],
      historyMessages: [{ role: "assistant", content: [{ type: "text", text: "Ready." }] }],
      methodResponses: {
        "sessions.list": sessions,
        "session.members.listEvidence": {
          sessionKey: "agent:main:ada",
          members: [],
          identities: [{ type: "human", id: "profile-bob", label: "Bob" }],
          role: "owner",
          allowedVisibilities: ["shared", "draft"],
        },
      },
    });

    await currentPage.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:ada"));
    await currentPage.getByText("Ready.", { exact: true }).waitFor();
    await currentPage.getByRole("button", { name: "Session sharing", exact: true }).click();
    await gateway.waitForRequest("session.members.listEvidence");
    const dropdown = currentPage.locator(".chat-pane__sharing-menu");
    const member = dropdown.getByRole("menuitemcheckbox", { name: "Bob", exact: true });
    await expectBrowser(member).toBeVisible();
    await expectBrowser(member).toBeDisabled();
    await member.evaluate((element) => (element as HTMLButtonElement).click());
    await dropdown.getByRole("menuitem", { name: "Session access" }).click();
    const publish = dropdown.getByRole("menuitemradio", { name: "Shared", exact: true });
    await expectBrowser(publish).toBeVisible();
    await expectBrowser(publish).toBeDisabled();
    await publish.evaluate((element) => (element as HTMLButtonElement).click());

    expect(await gateway.getRequests("session.visibility.set")).toHaveLength(0);
    expect(await gateway.getRequests("session.members.add")).toHaveLength(0);
  });

  it("scrolls the complete sharing directory while keeping access controls visible", async () => {
    const context = await suite.browser.newContext({ viewport: { height: 800, width: 1280 } });
    const currentPage = await context.newPage();
    page = currentPage;
    const sessions = sessionsList(["profile-ada", "profile-bob"]);
    const activeSession = sessions.sessions[0];
    if (!activeSession) {
      throw new Error("expected active session fixture");
    }
    Object.assign(activeSession, { visibility: "shared", sharingRole: "owner" });
    sessions.count = 1;
    sessions.owners = [
      {
        type: "human",
        id: "profile-ada",
        identity: { type: "profile", id: "profile-ada" },
        label: "Ada",
      },
    ];
    sessions.sessions = [activeSession];
    const longMemberLabel =
      "Alexandria Montgomery-Santiago from the International Collaboration Working Group";
    const longMemberId = `profile:${"member-without-a-display-name-".repeat(6)}`;
    const humanIdentities = [
      { type: "human" as const, id: "profile-long-name", label: longMemberLabel },
      { type: "human" as const, id: longMemberId },
      ...Array.from({ length: 28 }, (_, index) => ({
        type: "human" as const,
        id: `profile-member-${index}`,
        label: `Member ${index + 1}`,
      })),
    ];
    const nonHumanIdentities = [
      { type: "agent" as const, id: "agent-design", label: "Design" },
      { type: "system" as const, id: "system-operations", label: "Operations" },
    ];
    const gateway = await installMockGateway(currentPage, {
      sessionKey: "agent:main:ada",
      hasMultipleSessionSharingIdentities: true,
      featureMethods: [
        "chat.metadata",
        "chat.startup",
        "session.members.listEvidence",
        "session.members.add",
        "session.members.remove",
        "session.visibility.set",
      ],
      operatorScopes: ["operator.read", "operator.write"],
      historyMessages: [{ role: "assistant", content: [{ type: "text", text: "Ready." }] }],
      methodResponses: {
        "sessions.list": sessions,
        "session.members.listEvidence": {
          sessionKey: "agent:main:ada",
          members: [{ identityId: longMemberId, addedBy: "profile-ada", addedAt: 1 }],
          identities: [...humanIdentities, ...nonHumanIdentities],
          role: "owner",
          allowedVisibilities: ["shared", "read-only", "suggest", "draft"],
        },
      },
    });

    await currentPage.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:ada"));
    await currentPage.getByText("Ready.", { exact: true }).waitFor();
    await currentPage.locator(".chat-pane__sharing-trigger").click();
    await gateway.waitForRequest("session.members.listEvidence");
    const dropdown = currentPage.locator(".chat-pane__sharing-menu");
    const roster = dropdown.locator(".chat-pane__sharing-roster");
    const people = roster.locator(".chat-pane__sharing-person");
    await expectBrowser(people).toHaveCount(32);
    const longNameItem = dropdown.getByRole("menuitemcheckbox", {
      name: longMemberLabel,
      exact: true,
    });
    const longIdItem = dropdown.getByRole("menuitemcheckbox", {
      name: longMemberId,
      exact: true,
    });
    await longIdItem.scrollIntoViewIfNeeded();
    await expectBrowser(longIdItem).toBeChecked();
    const selectedIndicator = longIdItem.locator(".chat-pane__sharing-member-check");
    await expectBrowser(selectedIndicator).toBeVisible();
    await expectBrowser(selectedIndicator).toHaveAttribute("aria-label", "Member");
    expect(
      await longIdItem.evaluate((item) => {
        const indicator = item.querySelector<HTMLElement>(".chat-pane__sharing-member-check")!;
        const itemRect = item.getBoundingClientRect();
        const indicatorRect = indicator.getBoundingClientRect();
        return indicatorRect.left >= itemRect.left && indicatorRect.right <= itemRect.right;
      }),
    ).toBe(true);

    for (const item of [longNameItem, longIdItem]) {
      const label = item.locator(".chat-pane__sharing-member-label");
      const geometry = await label.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        const menu = element.closest(".chat-pane__sharing-panel")!.getBoundingClientRect();
        return {
          contained: rect.left >= menu.left && rect.right <= menu.right,
          overflow: element.scrollWidth > element.clientWidth,
          ellipsis: getComputedStyle(element).textOverflow,
        };
      });
      expect(geometry).toEqual({ contained: true, overflow: true, ellipsis: "ellipsis" });
    }

    await roster.evaluate((element) => {
      element.scrollTop = 0;
    });
    const readGeometry = () =>
      dropdown.evaluate((element) => {
        const menu = element.querySelector<HTMLElement>(".chat-pane__sharing-panel")!;
        const list = element.querySelector<HTMLElement>(".chat-pane__sharing-roster")!;
        const rows = list.querySelectorAll<HTMLElement>(".chat-pane__sharing-person");
        const menuRect = menu.getBoundingClientRect();
        const listRect = list.getBoundingClientRect();
        return {
          menuTop: menuRect.top,
          menuBottom: menuRect.bottom,
          viewportHeight: innerHeight,
          menuScrollTop: menu.scrollTop,
          scrollTop: list.scrollTop,
          scrollHeight: list.scrollHeight,
          clientHeight: list.clientHeight,
          scrollWidth: list.scrollWidth,
          clientWidth: list.clientWidth,
          firstTop: rows[0]!.getBoundingClientRect().top,
          lastBottom: rows[rows.length - 1]!.getBoundingClientRect().bottom,
          listBottom: listRect.bottom,
          accessTop: element
            .querySelector<HTMLElement>('[data-value="access"]')!
            .getBoundingClientRect().top,
          permissionsTop: element
            .querySelector<HTMLElement>(
              ".chat-pane__sharing-permissions .chat-pane__sharing-section-label",
            )!
            .getBoundingClientRect().top,
        };
      });
    const beforeScroll = await readGeometry();
    await people.last().scrollIntoViewIfNeeded();
    const afterScroll = await readGeometry();
    expect(beforeScroll.menuTop).toBeGreaterThanOrEqual(0);
    expect(beforeScroll.menuBottom).toBeLessThanOrEqual(beforeScroll.viewportHeight);
    expect(beforeScroll.scrollHeight).toBeGreaterThan(beforeScroll.clientHeight);
    expect(beforeScroll.scrollWidth).toBe(beforeScroll.clientWidth);
    expect(afterScroll.scrollTop).toBeGreaterThan(0);
    expect(afterScroll.firstTop).toBeLessThan(beforeScroll.firstTop);
    expect(afterScroll.lastBottom).toBeLessThanOrEqual(afterScroll.listBottom + 1);
    expect(afterScroll.menuScrollTop).toBe(0);
    expect(afterScroll.accessTop).toBeCloseTo(beforeScroll.accessTop, 1);
    expect(afterScroll.permissionsTop).toBeCloseTo(beforeScroll.permissionsTop, 1);
    await expectBrowser(roster.locator("openclaw-session-owner-chip")).toHaveCount(30);
    // All identities share one list; owner-chip presentation remains human-only.
    await expectBrowser(roster.locator(".chat-pane__sharing-member-icon > svg")).toHaveCount(2);
    await expectBrowser(dropdown.getByRole("button", { name: "Next", exact: true })).toHaveCount(0);
    await expectBrowser(
      dropdown.getByRole("button", { name: "Previous", exact: true }),
    ).toHaveCount(0);
  });

  it("clears a selected draft mode when sharing policy becomes unavailable", async () => {
    const context = await suite.browser.newContext({ viewport: { height: 800, width: 1200 } });
    const currentPage = await context.newPage();
    page = currentPage;
    const gateway = await installMockGateway(currentPage, {
      allowedSessionVisibilities: ["shared", "draft"],
      hasMultipleSessionSharingIdentities: true,
      methodResponses: { "sessions.list": sessionsList(["profile-ada", "profile-bob"]) },
    });

    await currentPage.goto(`${suite.server?.baseUrl ?? ""}new`);
    const draftToggle = currentPage.getByRole("switch", { name: "Draft", exact: true });
    await currentPage.locator(".new-session-page__composer .agent-chat__composer-footer").hover();
    await draftToggle.check();
    await gateway.setSessionSharingPolicy({
      allowedSessionVisibilities: ["shared"],
      hasMultipleSessionSharingIdentities: false,
    });
    await replaceGatewayClient(currentPage);
    await expect
      .poll(() => currentPage.getByRole("button", { name: "Draft", exact: true }).count())
      .toBe(0);

    await gateway.setSessionSharingPolicy({
      allowedSessionVisibilities: ["shared", "draft"],
      hasMultipleSessionSharingIdentities: true,
    });
    await replaceGatewayClient(currentPage);
    await currentPage.locator(".new-session-page__composer .agent-chat__composer-footer").hover();
    await draftToggle.waitFor();
    expect(await draftToggle.isChecked()).toBe(false);
  });

  it("aligns the sharing and Details icons in the session toolbar", async () => {
    const context = await suite.browser.newContext({ viewport: { height: 800, width: 1200 } });
    const currentPage = await context.newPage();
    page = currentPage;
    const sessions = sessionsList(["profile-ada", "profile-bob"]);
    const activeSession = sessions.sessions[0];
    if (!activeSession) {
      throw new Error("expected active session fixture");
    }
    Object.assign(activeSession, { visibility: "shared", sharingRole: "owner" });
    await installMockGateway(currentPage, {
      sessionKey: "agent:main:ada",
      featureMethods: ["chat.metadata", "chat.startup", "session.visibility.set"],
      operatorScopes: ["operator.write"],
      historyMessages: [{ role: "assistant", content: [{ type: "text", text: "Ready." }] }],
      methodResponses: { "sessions.list": sessions },
    });

    await currentPage.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:ada"));
    await currentPage.getByText("Ready.", { exact: true }).waitFor();
    const share = currentPage.locator(".chat-pane__sharing-trigger");
    const details = currentPage.locator(".chat-details-toggle");
    await share.waitFor();
    await details.waitFor();
    const measure = (trigger: typeof share) =>
      trigger.evaluate((button) => {
        const bounds = button.getBoundingClientRect();
        const icon = button.querySelector("svg")!.getBoundingClientRect();
        return {
          center: icon.top + icon.height / 2,
          iconOffset: icon.top + icon.height / 2 - (bounds.top + bounds.height / 2),
        };
      });
    const [shareMetrics, detailsMetrics] = await Promise.all([measure(share), measure(details)]);
    expect(shareMetrics.center).toBeCloseTo(detailsMetrics.center, 1);
    expect(shareMetrics.iconOffset).toBeCloseTo(detailsMetrics.iconOffset, 1);
    await share.click({ trial: true });
    await details.click({ trial: true });
  });
});
