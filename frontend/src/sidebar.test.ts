import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  _resetForTest,
  initSidebar,
  isSidebarVisible,
  mountSidebarPanel,
  setSidebarVisible,
  subscribeSidebarVisibility,
  toggleSidebar,
} from "./sidebar.ts";

function makeSidebarEl(): HTMLElement {
  const el = document.createElement("aside");
  el.id = "sidebar";
  document.body.appendChild(el);
  return el;
}

beforeEach(() => {
  _resetForTest();
  document.body.innerHTML = "";
});

afterEach(() => {
  _resetForTest();
  document.body.innerHTML = "";
});

describe("sidebar shell", () => {
  it("starts hidden and shows when first panel mounts", () => {
    const el = makeSidebarEl();
    initSidebar(el);
    expect(el.hidden).toBe(true);

    const panel = document.createElement("div");
    panel.textContent = "search";
    mountSidebarPanel("search", "Search", panel);
    expect(el.hidden).toBe(false);
  });

  it("renders one tab per mounted panel and makes the first one active", () => {
    initSidebar(makeSidebarEl());
    const a = document.createElement("div");
    const b = document.createElement("div");
    mountSidebarPanel("search", "Search", a);
    mountSidebarPanel("outline", "Outline", b);

    const tabs = document.querySelectorAll(".sidebar-tab");
    expect(tabs.length).toBe(2);
    expect((tabs[0] as HTMLElement).getAttribute("aria-selected")).toBe("true");
    expect((tabs[1] as HTMLElement).getAttribute("aria-selected")).toBe("false");
    expect(a.hidden).toBe(false);
    expect(b.hidden).toBe(true);
  });

  it("clicking a tab switches the active panel", () => {
    initSidebar(makeSidebarEl());
    const a = document.createElement("div");
    const b = document.createElement("div");
    mountSidebarPanel("search", "Search", a);
    mountSidebarPanel("outline", "Outline", b);

    const outlineTab = document.querySelector(
      '.sidebar-tab[data-panel="outline"]',
    ) as HTMLButtonElement;
    outlineTab.click();

    expect(a.hidden).toBe(true);
    expect(b.hidden).toBe(false);
    expect(outlineTab.getAttribute("aria-selected")).toBe("true");
  });

  it("handle.show() makes the panel active programmatically", () => {
    initSidebar(makeSidebarEl());
    const a = document.createElement("div");
    const b = document.createElement("div");
    const ha = mountSidebarPanel("search", "Search", a);
    const hb = mountSidebarPanel("outline", "Outline", b);

    expect(ha.isActive()).toBe(true);
    hb.show();
    expect(hb.isActive()).toBe(true);
    expect(ha.isActive()).toBe(false);
  });

  it("destroy removes the tab + panel and hides the sidebar when empty", () => {
    const el = makeSidebarEl();
    initSidebar(el);
    const h = mountSidebarPanel("search", "Search", document.createElement("div"));
    expect(el.hidden).toBe(false);
    h.destroy();
    expect(document.querySelectorAll(".sidebar-tab").length).toBe(0);
    expect(el.hidden).toBe(true);
  });

  it("throws if a panel with the same name is mounted twice", () => {
    initSidebar(makeSidebarEl());
    mountSidebarPanel("search", "Search", document.createElement("div"));
    expect(() =>
      mountSidebarPanel("search", "Search 2", document.createElement("div")),
    ).toThrow();
  });

  it("close button hides the sidebar, preserves the user's choice", () => {
    const el = makeSidebarEl();
    initSidebar(el);
    mountSidebarPanel("outline", "Outline", document.createElement("div"));
    expect(el.hidden).toBe(false);
    (el.querySelector(".sidebar-close") as HTMLButtonElement).click();
    expect(el.hidden).toBe(true);
    expect(isSidebarVisible()).toBe(false);

    // Mounting another panel should NOT re-show the sidebar — the user
    // explicitly closed it.
    mountSidebarPanel("search", "Search", document.createElement("div"));
    expect(el.hidden).toBe(true);
  });

  it("toggleSidebar / setSidebarVisible flip the user-visibility state", () => {
    const el = makeSidebarEl();
    initSidebar(el);
    mountSidebarPanel("outline", "Outline", document.createElement("div"));
    expect(el.hidden).toBe(false);
    toggleSidebar();
    expect(el.hidden).toBe(true);
    setSidebarVisible(true);
    expect(el.hidden).toBe(false);
  });

  it("subscribeSidebarVisibility fires on state change only", () => {
    initSidebar(makeSidebarEl());
    mountSidebarPanel("outline", "Outline", document.createElement("div"));
    const seen: boolean[] = [];
    subscribeSidebarVisibility((v) => seen.push(v));
    setSidebarVisible(true); // no-op (already visible)
    setSidebarVisible(false);
    setSidebarVisible(false); // no-op
    setSidebarVisible(true);
    expect(seen).toEqual([false, true]);
  });
});
