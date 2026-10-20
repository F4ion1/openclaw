import type { RouteLocation } from "@openclaw/uirouter";
import { vi } from "vitest";
import type { AgentsListResult } from "../api/types.ts";
import type { ApplicationRouter, RouteId } from "../app-routes.ts";
import type { ShellNavigationOwner } from "./app-shell-navigation.ts";
import { createApplicationConfigCapability } from "./config.ts";
import type { ApplicationContext } from "./context.ts";

export type ShellRouteCommitState = {
  runtime: { context: ApplicationContext };
  activeSessionKey: string;
  didConsiderNativeRouteRestore: boolean;
  shellNavigation: ShellNavigationOwner;
};

export type ShellCustodianRouteState = {
  custodianMinimizeRequestId: number;
  shellNavigation: ShellNavigationOwner;
};

export type ShellKeyboardState = {
  element: HTMLElement;
  runtime: { context: ApplicationContext };
};

export function resetAppHostTestGlobals(): void {
  vi.useRealTimers();
  Reflect.deleteProperty(window, "webkit");
  document.documentElement.classList.remove(
    "openclaw-native-macos",
    "openclaw-native-nav",
    "openclaw-native-web-chrome",
  );
  vi.unstubAllGlobals();
}

export type TestOptionalCustomElement = {
  tagName: string;
  label: string;
  loadModule: () => Promise<unknown>;
};

let lazyElementSequence = 0;

export function createLazyElementSpec(
  label: string,
  options: { firstError?: Error } = {},
): TestOptionalCustomElement {
  lazyElementSequence += 1;
  const tagName = `openclaw-app-host-lazy-${lazyElementSequence}`;
  let attempt = 0;
  return {
    tagName,
    label,
    loadModule: async () => {
      if (++attempt === 1 && options.firstError) {
        throw options.firstError;
      }
      customElements.define(tagName, class extends HTMLElement {});
    },
  };
}

/** Model rendering as soon as the module defines the tag. */
export function stubRenderedWhenDefined(shell: object): void {
  Object.defineProperty(shell, "queryRenderedElement", {
    configurable: true,
    value: (tagName: string) =>
      customElements.get(tagName) ? document.createElement(tagName) : null,
  });
}

export function committedRouterState(
  routeId: RouteId,
  pathname: string,
  data?: unknown,
): ReturnType<ApplicationRouter["getState"]> {
  const location = { pathname, search: "", hash: "" } satisfies RouteLocation;
  return {
    location,
    resolvedLocation: location,
    status: "success",
    matches: [{ routeId, location, data }],
    pendingMatches: [],
    cachedMatches: [],
  } as unknown as ReturnType<ApplicationRouter["getState"]>;
}

export function createShellConfigFixture() {
  const config = createApplicationConfigCapability({ resourceBasePath: "" });
  config.refresh = vi.fn(async () => null);
  return config;
}

export function createRosterRefreshContext(params: {
  previous: AgentsListResult;
  next: AgentsListResult;
  selectedId: string;
}) {
  const agentsState = { agentsList: params.previous };
  const selectionState = { selectedId: params.selectedId, scopeId: params.selectedId };
  const refreshList = vi.fn(async () => {
    agentsState.agentsList = params.next;
    return params.next;
  });
  const actions = {
    refreshList,
    invalidateFiles: vi.fn(),
    invalidateIdentity: vi.fn(),
    ensureIdentity: vi.fn(async () => undefined),
    setSelection: vi.fn((agentId: string) => {
      Object.assign(selectionState, { selectedId: agentId, scopeId: agentId });
    }),
    refreshConfig: vi.fn(async () => null),
  };
  const context = {
    config: createShellConfigFixture(),
    agents: { state: agentsState, refreshList, invalidateFiles: actions.invalidateFiles },
    agentIdentity: { invalidate: actions.invalidateIdentity, ensure: actions.ensureIdentity },
    agentSelection: { state: selectionState, set: actions.setSelection },
    runtimeConfig: {
      state: { configFormDirty: false },
      refresh: actions.refreshConfig,
    },
  } as unknown as ApplicationContext;
  return { context, ...actions };
}
