/**
 * Left-side sidebar shell with tabbed panels. Owns layout and tab switching;
 * panels (search, outline, future ones) plug in via `mountSidebarPanel` and
 * stay agnostic of each other.
 *
 *   const handle = mountSidebarPanel("search", "Search", buildSearchPanel());
 *   handle.show();  // make this the visible tab
 *
 * The sidebar element starts hidden and becomes visible the moment any panel
 * mounts. Hides again when the last panel unmounts.
 */

let sidebarEl: HTMLElement | null = null;
let tabsEl: HTMLElement | null = null;
let panelsEl: HTMLElement | null = null;
let active: string | null = null;

interface PanelEntry {
  label: string;
  element: HTMLElement;
  tab: HTMLButtonElement;
}
const panels = new Map<string, PanelEntry>();

export interface SidebarPanelHandle {
  show(): void;
  hide(): void;
  destroy(): void;
  isActive(): boolean;
}

export function initSidebar(el: HTMLElement): void {
  sidebarEl = el;
  el.innerHTML = "";
  tabsEl = document.createElement("div");
  tabsEl.className = "sidebar-tabs";
  panelsEl = document.createElement("div");
  panelsEl.className = "sidebar-panels";
  el.append(tabsEl, panelsEl);
  el.hidden = true;
}

export function mountSidebarPanel(
  name: string,
  label: string,
  element: HTMLElement,
): SidebarPanelHandle {
  if (!sidebarEl || !tabsEl || !panelsEl) {
    throw new Error("sidebar not initialized; call initSidebar first");
  }
  if (panels.has(name)) {
    throw new Error(`sidebar panel "${name}" is already mounted`);
  }

  const tab = document.createElement("button");
  tab.type = "button";
  tab.className = "sidebar-tab";
  tab.textContent = label;
  tab.dataset.panel = name;
  tab.setAttribute("aria-selected", "false");
  tab.addEventListener("click", () => show());
  tabsEl.appendChild(tab);

  element.classList.add("sidebar-panel");
  element.hidden = true;
  panelsEl.appendChild(element);

  panels.set(name, { label, element, tab });
  sidebarEl.hidden = false;

  const show = (): void => {
    active = name;
    for (const [n, p] of panels) {
      p.element.hidden = n !== name;
      p.tab.setAttribute("aria-selected", n === name ? "true" : "false");
    }
  };

  const hide = (): void => {
    element.hidden = true;
    tab.setAttribute("aria-selected", "false");
    if (active === name) active = null;
  };

  const destroy = (): void => {
    panels.delete(name);
    tab.remove();
    element.remove();
    if (active === name) active = null;
    if (panels.size === 0 && sidebarEl) sidebarEl.hidden = true;
  };

  // First-mounted panel becomes the active tab so the sidebar isn't blank.
  if (active === null) show();

  return { show, hide, destroy, isActive: () => active === name };
}

/** For tests. */
export function _resetForTest(): void {
  panels.clear();
  active = null;
  sidebarEl = null;
  tabsEl = null;
  panelsEl = null;
}
