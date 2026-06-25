/**
 * Tiny transient toast. Shared by the Cmd-S trap and the highlight-cap notice.
 * Appends a `.toast` element to <body> that fades out and removes itself.
 */
export function showToast(message: string): void {
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => el.classList.add("toast-out"), 1800);
  setTimeout(() => el.remove(), 2200);
}
