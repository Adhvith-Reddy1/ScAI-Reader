import { describe, it, expect } from "vitest";
import { renderFormattedText } from "./aiText.ts";

function render(text: string): HTMLDivElement {
  const el = document.createElement("div");
  renderFormattedText(el, text);
  return el;
}

describe("renderFormattedText", () => {
  it("renders plain prose as a single paragraph", () => {
    const el = render("A measure of disorder.");
    expect(el.innerHTML).toBe("<p>A measure of disorder.</p>");
    expect(el.textContent).toBe("A measure of disorder.");
  });

  it("splits blank-line-separated text into paragraphs", () => {
    const el = render("First point.\n\nSecond point.");
    expect(el.querySelectorAll("p")).toHaveLength(2);
    expect(el.querySelectorAll("p")[0].textContent).toBe("First point.");
    expect(el.querySelectorAll("p")[1].textContent).toBe("Second point.");
  });

  it("joins soft-wrapped lines within one paragraph with a space", () => {
    const el = render("Line one\nstill line one.");
    expect(el.querySelectorAll("p")).toHaveLength(1);
    expect(el.querySelector("p")!.textContent).toBe("Line one still line one.");
  });

  it("renders consecutive '- ' lines as a bullet list", () => {
    const el = render("- panel a shows X\n- panel b shows Y");
    const items = el.querySelectorAll("li");
    expect(items).toHaveLength(2);
    expect(items[0].textContent).toBe("panel a shows X");
    expect(items[1].textContent).toBe("panel b shows Y");
    expect(el.querySelector("ul")).toBeTruthy();
  });

  it("renders '* ' bullets the same as '- '", () => {
    const el = render("* one\n* two");
    expect(el.querySelectorAll("li")).toHaveLength(2);
  });

  it("mixes a lead-in paragraph with a following bullet list", () => {
    const el = render("Here's why:\n- reason one\n- reason two");
    expect(el.children).toHaveLength(2);
    expect(el.children[0].tagName).toBe("P");
    expect(el.children[1].tagName).toBe("UL");
    expect(el.querySelectorAll("li")).toHaveLength(2);
  });

  it("renders **bold** spans as <strong>", () => {
    const el = render("This is **important** context.");
    const strong = el.querySelector("strong");
    expect(strong).toBeTruthy();
    expect(strong!.textContent).toBe("important");
    expect(el.textContent).toBe("This is important context.");
  });

  it("escapes HTML so model/user text can never inject markup", () => {
    const el = render("<img src=x onerror=alert(1)> & <script>bad</script>");
    expect(el.querySelector("img")).toBeNull();
    expect(el.querySelector("script")).toBeNull();
    expect(el.innerHTML).toContain("&lt;img");
    expect(el.textContent).toBe(
      "<img src=x onerror=alert(1)> & <script>bad</script>",
    );
  });

  it("renders nothing for empty text", () => {
    const el = render("");
    expect(el.children).toHaveLength(0);
  });

  it("replaces previous content on re-render (streaming re-renders)", () => {
    const el = render("partial");
    renderFormattedText(el, "partial, now more");
    expect(el.querySelectorAll("p")).toHaveLength(1);
    expect(el.textContent).toBe("partial, now more");
  });
});
