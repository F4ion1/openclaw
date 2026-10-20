import type { JSX } from "@solidjs/web";
import { createMemo, createUniqueId, Show } from "solid-js";
import type { NavigationRouteId } from "../app-navigation.ts";
import { pathForAgentPanel } from "../app-route-paths.ts";
import type { ApplicationNavigationOptions } from "../app/context.ts";
import { t } from "../lib/reactive/i18n.ts";
import { SidebarDropdown } from "./app-sidebar-nav-menus.tsx";
import {
  AGENT_VALUE_PREFIX,
  renderSidebarAgentMenuSwitcher,
  type SidebarAgentMenuSwitcherParams,
} from "./sidebar-agent-menu-switcher.tsx";
import { Icon } from "./solid/icon.tsx";
import type { MenuEntry } from "./solid/menu.tsx";

type SidebarAgentMenuParams = Omit<
  SidebarAgentMenuSwitcherParams,
  "allAgentsScope" | "onAgentSettings"
> & {
  position: { x: number; top: number };
  anchor?: HTMLElement;
  tabFocusTarget?: (backward: boolean) => HTMLElement | undefined;
  basePath: string;
  rosterMode: boolean;
  creationDisabledReason: string | null;
  onShowAllAgents: () => void;
  onPointerEnter: () => void;
  onPointerLeave: () => void;
  onAfterShow: () => void;
  onSwitchAgent: (agentId: string) => void;
  onCreateAgent: () => void;
  onClose: (restoreFocus?: boolean) => void;
  onNavigate: (routeId: NavigationRouteId, options?: ApplicationNavigationOptions) => void;
};

export function renderSidebarAgentMenu(params: SidebarAgentMenuParams): JSX.Element {
  const position = params.position;
  const creationReasonId = createUniqueId();
  const menuLabel = createMemo(() =>
    t(params.rosterMode ? "agentChip.workspaceMenuLabel" : "agentChip.menuLabel"),
  );
  const agentsTitle = <div class="sidebar-customize-menu__title">{t("agentChip.agents")}</div>;
  const items = (): MenuEntry[] => [
    ...(params.agents.length > 0
      ? [
          {
            kind: "content" as const,
            id: "agents-title",
            content: agentsTitle,
          },
        ]
      : []),
    {
      id: "command:new-agent",
      label: t("agentChip.createAgent"),
      class: [
        "sidebar-customize-menu__item sidebar-agent-menu__create",
        { "session-menu__item--described": Boolean(params.creationDisabledReason) },
      ],
      disabled: Boolean(params.creationDisabledReason || params.pendingAgent),
      attributes: {
        "aria-describedby": params.creationDisabledReason ? creationReasonId : undefined,
      },
      closeOnSelect: false,
      content: (
        <span class="sidebar-agent-menu__agent-row">
          <span class="sidebar-agent-menu__create-icon" aria-hidden="true">
            <Icon name="circlePlus" />
          </span>
          <span class="agent-select__option-copy">
            <span
              class="agent-select__option-label"
              role={params.pendingAgent ? "status" : undefined}
            >
              {t(params.pendingAgent ? "agentChip.creatingAgent" : "agentChip.createAgent")}
            </span>
            <Show when={params.creationDisabledReason}>
              {(reason) => (
                <span id={creationReasonId} class="session-menu__description">
                  {reason()}
                </span>
              )}
            </Show>
          </span>
        </span>
      ),
    },
    {
      kind: "group",
      id: "agents",
      class: "sidebar-agent-menu__agent-list",
      items: renderSidebarAgentMenuSwitcher({
        ...params,
        allAgentsScope: params.rosterMode && params.agents.length > 1,
        onAgentSettings: (agentId) => {
          params.onClose(false);
          params.onNavigate("agents", {
            pathname: pathForAgentPanel(agentId, null, params.basePath),
          });
        },
      }),
    },
  ];
  return (
    <SidebarDropdown
      class="sidebar-customize-menu sidebar-agent-menu"
      position={position}
      anchor={params.anchor}
      tabFocusTarget={params.tabFocusTarget}
      label={menuLabel()}
      focusOnOpen={params.openMode !== "hover"}
      items={items()}
      onPointerEnter={params.onPointerEnter}
      onPointerLeave={params.onPointerLeave}
      onAfterShow={params.onAfterShow}
      onClose={params.onClose}
      onSelect={(value) => {
        if (value === "command:new-agent") {
          void params.onCreateAgent();
          return;
        }
        params.onClose(value === "scope:all" && params.rosterMode);
        if (value.startsWith(AGENT_VALUE_PREFIX)) {
          params.onSwitchAgent(decodeURIComponent(value.slice(AGENT_VALUE_PREFIX.length)));
          return;
        }
        switch (value) {
          case "scope:all":
            params.onShowAllAgents();
            break;
        }
      }}
    />
  );
}
