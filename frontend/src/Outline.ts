/**
 * Sidebar panel: document outline / bookmarks.
 *
 * Renders the recursive tree returned by GET /documents/{id}/outline. Each
 * node is one row; rows with children get an expand/collapse caret. Clicks
 * jump the active PageList via [[pageNav.jumpToPage]].
 *
 * The panel watches pageNav for the active doc. When the doc_id changes we
 * refetch the outline; when no doc is active we render an empty state.
 */

import { fetchOutline, type OutlineNode } from "./api.ts";
import { jumpToPage, subscribePageInfo } from "./pageNav.ts";

const INDENT_PX = 16;

export function buildOutlinePanel(): HTMLElement {
  const root = document.createElement("div");
  root.className = "outline-panel";

  let currentDocId: string | null = null;

  const renderEmpty = (text: string): void => {
    root.innerHTML = "";
    const p = document.createElement("p");
    p.className = "outline-empty";
    p.textContent = text;
    root.appendChild(p);
  };

  const renderTree = (nodes: OutlineNode[]): void => {
    root.innerHTML = "";
    if (nodes.length === 0) {
      renderEmpty("No outline in this document.");
      return;
    }
    const list = document.createElement("div");
    list.className = "outline-list";
    for (const node of nodes) {
      list.appendChild(buildNode(node, 0));
    }
    root.appendChild(list);
  };

  renderEmpty("Open a document to see its outline.");

  subscribePageInfo((info) => {
    const nextId = info?.doc_id ?? null;
    if (nextId === currentDocId) return;
    currentDocId = nextId;
    if (!nextId) {
      renderEmpty("Open a document to see its outline.");
      return;
    }
    renderEmpty("Loading outline…");
    const docIdAtFetch = nextId;
    fetchOutline(nextId).then(
      (nodes) => {
        // Guard against races: only render if this is still the active doc.
        if (docIdAtFetch !== currentDocId) return;
        renderTree(nodes);
      },
      () => {
        if (docIdAtFetch !== currentDocId) return;
        renderEmpty("Could not load outline.");
      },
    );
  });

  return root;
}

function buildNode(node: OutlineNode, depth: number): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "outline-node";

  const row = document.createElement("div");
  row.className = "outline-row";
  row.style.paddingLeft = `${depth * INDENT_PX}px`;
  if (node.page == null) row.classList.add("outline-row-inert");
  wrap.appendChild(row);

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "outline-toggle";
  const hasChildren = node.children.length > 0;

  // Top-level chapters render expanded so the user sees the table of contents
  // at a glance; deeper levels (sections/subsections) start collapsed so a
  // textbook with hundreds of nested entries isn't a wall of text.
  let expanded = depth === 0;
  const childList = document.createElement("div");
  childList.className = "outline-children";
  childList.hidden = !expanded;

  const setExpanded = (v: boolean): void => {
    expanded = v;
    childList.hidden = !expanded;
    toggle.textContent = expanded ? "▾" : "▸";
    toggle.setAttribute("aria-label", expanded ? "Collapse" : "Expand");
    toggle.setAttribute("aria-expanded", String(expanded));
  };

  if (hasChildren) {
    setExpanded(expanded);
    toggle.addEventListener("click", (e) => {
      e.stopPropagation();
      setExpanded(!expanded);
    });
  } else {
    // Keep a same-width placeholder so titles align across rows.
    toggle.classList.add("outline-toggle-placeholder");
    toggle.setAttribute("aria-hidden", "true");
    toggle.tabIndex = -1;
  }
  row.appendChild(toggle);

  const title = document.createElement("span");
  title.className = "outline-title";
  title.textContent = node.title;
  row.appendChild(title);

  const page = document.createElement("span");
  page.className = "outline-page";
  page.textContent = node.page == null ? "" : String(node.page);
  row.appendChild(page);

  // Row click behavior: jump if the node has a destination; else (or in
  // addition, for nodes without a page) toggle expand/collapse so the user
  // doesn't have to hit the tiny caret target.
  row.addEventListener("click", () => {
    if (node.page != null) {
      jumpToPage(node.page);
    } else if (hasChildren) {
      setExpanded(!expanded);
    }
  });
  if (node.page != null) row.classList.add("outline-row-clickable");
  else if (hasChildren) row.classList.add("outline-row-clickable");

  if (hasChildren) {
    for (const child of node.children) {
      childList.appendChild(buildNode(child, depth + 1));
    }
    wrap.appendChild(childList);
  }

  return wrap;
}
