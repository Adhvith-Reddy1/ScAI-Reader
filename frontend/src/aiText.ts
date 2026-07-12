/**
 * Minimal, safe formatter for AI response text: paragraphs, bullet lists,
 * and **bold** spans. Not a general Markdown parser — just enough structure
 * so short model replies read as more than an unbroken blurb. All input is
 * HTML-escaped before any tag is introduced, so model (or user chat) text
 * can never inject markup.
 */

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** `**bold**` only — no nesting, no other inline syntax. */
function renderInline(text: string): string {
  return escapeHtml(text).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
}

const BULLET_RE = /^[-*]\s+/;

/**
 * Render `text` into `el`, replacing its children: blank-line-separated runs
 * become paragraphs, consecutive lines starting with "- " or "* " become a
 * bullet list. Falls back to a single paragraph for plain prose (the common
 * case for the short definition/explanation tooltip).
 */
export function renderFormattedText(el: HTMLElement, text: string): void {
  el.replaceChildren();
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let para: string[] = [];

  const flushPara = () => {
    if (para.length === 0) return;
    const p = document.createElement("p");
    p.innerHTML = renderInline(para.join(" ").trim());
    el.appendChild(p);
    para = [];
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "") {
      flushPara();
      i++;
      continue;
    }
    if (BULLET_RE.test(line.trim())) {
      flushPara();
      const ul = document.createElement("ul");
      while (i < lines.length && BULLET_RE.test(lines[i].trim())) {
        const li = document.createElement("li");
        li.innerHTML = renderInline(lines[i].trim().replace(BULLET_RE, ""));
        ul.appendChild(li);
        i++;
      }
      el.appendChild(ul);
      continue;
    }
    para.push(line.trim());
    i++;
  }
  flushPara();
}
