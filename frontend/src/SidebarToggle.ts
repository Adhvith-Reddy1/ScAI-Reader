/**
 * Toolbar button to show/hide the sidebar. State is mirrored from
 * [[sidebar.isSidebarVisible]] / subscribeSidebarVisibility.
 */

import {
  isSidebarVisible,
  subscribeSidebarVisibility,
  toggleSidebar,
} from "./sidebar.ts";

export function buildSidebarToggle(): HTMLElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "sidebar-toggle";
  btn.title = "Toggle sidebar";
  btn.setAttribute("aria-label", "Toggle sidebar");
  // Simple panel-with-bar glyph; works at small sizes.
  btn.innerHTML =
    '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">' +
    '<rect x="2" y="3" width="12" height="10" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.2"/>' +
    '<line x1="6" y1="3" x2="6" y2="13" stroke="currentColor" stroke-width="1.2"/>' +
    "</svg>";
  btn.addEventListener("click", () => toggleSidebar());

  const render = (visible: boolean): void => {
    btn.setAttribute("aria-pressed", String(visible));
    btn.dataset.active = String(visible);
  };
  render(isSidebarVisible());
  subscribeSidebarVisibility(render);

  return btn;
}
