/** Promote a hover-open menu without letting the first Create row steal selection focus. */
export function focusSidebarAgentMenu(element: HTMLElement): void {
  const dropdown = element.querySelector<HTMLElement>(".sidebar-agent-menu");
  const target =
    dropdown?.querySelector<HTMLElement>(".sidebar-agent-menu__agent-switch--active") ??
    dropdown?.querySelector<HTMLElement>('[role^="menuitem"]:not([disabled])');
  target?.focus();
}
