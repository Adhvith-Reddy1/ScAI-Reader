/**
 * Prompt shown when a reader hits the site's shared daily AI quota (see
 * backend/app/quota.py). Lets them paste their own API key so they can keep
 * using AI explanations without waiting for tomorrow's reset. The key is
 * stored only in this browser (see userApiKey.ts) and sent as a per-request
 * header — the server never writes it to disk.
 */

import { setUserApiKey } from "./userApiKey.ts";

let overlay: HTMLDivElement | null = null;

function closeOverlay(): void {
  if (overlay) {
    overlay.remove();
    overlay = null;
  }
}

/**
 * Open the "bring your own key" prompt. `onSaved` runs after a key is saved,
 * so the caller can retry whatever request just got throttled. Safe to call
 * repeatedly (no-op if already open).
 */
export function openUserKeyPrompt(onSaved?: () => void): void {
  if (overlay) return;

  overlay = document.createElement("div");
  overlay.className = "ai-setup-overlay";
  overlay.addEventListener("pointerdown", (e) => {
    if (e.target === overlay) closeOverlay();
  });

  const dialog = document.createElement("div");
  dialog.className = "ai-setup-dialog";
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-label", "Add your own API key");

  dialog.innerHTML = `
    <button class="ai-setup-close" type="button" aria-label="Close">×</button>
    <h2>Daily free AI limit reached</h2>
    <p class="ai-setup-intro">
      This site's shared AI budget is used up for today. Paste your own API
      key to keep going with no daily limit — it stays in this browser and
      is only ever sent along with your own requests.
    </p>
    <label class="ai-setup-field">
      <span>API key</span>
      <input class="ai-setup-input" type="password" autocomplete="off"
        spellcheck="false" placeholder="sk-..." aria-label="API key" />
    </label>
    <div class="ai-setup-actions">
      <button class="ai-setup-save" type="button">Save and retry</button>
    </div>
    <p class="ai-setup-feedback" role="status"></p>
  `;

  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

  const input = dialog.querySelector(".ai-setup-input") as HTMLInputElement;
  const saveBtn = dialog.querySelector(".ai-setup-save") as HTMLButtonElement;
  const feedback = dialog.querySelector(".ai-setup-feedback") as HTMLElement;
  const closeBtn = dialog.querySelector(".ai-setup-close") as HTMLButtonElement;

  closeBtn.addEventListener("click", closeOverlay);
  const onKeydown = (e: KeyboardEvent): void => {
    if (e.key === "Escape") {
      closeOverlay();
      document.removeEventListener("keydown", onKeydown);
    }
  };
  document.addEventListener("keydown", onKeydown);

  const doSave = (): void => {
    const key = input.value.trim();
    if (!key) {
      feedback.textContent = "Paste your API key first.";
      feedback.dataset.kind = "error";
      return;
    }
    setUserApiKey(key);
    closeOverlay();
    onSaved?.();
  };

  saveBtn.addEventListener("click", doSave);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") doSave();
  });

  input.focus();
}

/** Test-only: reset module state. */
export function _resetForTest(): void {
  closeOverlay();
}
