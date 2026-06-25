/**
 * Guided, in-app setup for the Anthropic API key that powers AI explanations.
 *
 * A biologist won't have a key or know what one is, so this:
 *   - explains plainly what's needed and why,
 *   - links straight to the Anthropic console to get a key,
 *   - lets them paste it and verifies it before saving,
 *   - shows whether AI is currently on, and lets them remove the key.
 *
 * The key lives on the local backend (see app/ai.py); nothing here stores it
 * in the browser. A nav button reflects on/off status; a first-run banner
 * nudges setup once.
 */

import {
  clearAiKey,
  getAiStatus,
  saveAiKey,
  type AiStatus,
} from "./api.ts";

const CONSOLE_URL = "https://console.anthropic.com/settings/keys";
const NUDGE_DISMISS_KEY = "scai.aiNudgeDismissed";

let lastStatus: AiStatus | null = null;
const statusListeners = new Set<(s: AiStatus) => void>();
let overlay: HTMLDivElement | null = null;

async function refreshStatus(): Promise<AiStatus | null> {
  try {
    const s = await getAiStatus();
    lastStatus = s;
    for (const l of statusListeners) l(s);
    return s;
  } catch {
    return null;
  }
}

/** Nav button that opens the setup dialog and reflects on/off status. */
export function buildAiSetupButton(): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "ai-setup-button";
  const dot = document.createElement("span");
  dot.className = "ai-status-dot";
  const label = document.createElement("span");
  label.textContent = "AI";
  btn.append(dot, label);

  const apply = (s: AiStatus): void => {
    btn.dataset.configured = String(s.configured);
    btn.title = s.configured
      ? "AI explanations are on"
      : "AI explanations are off — click to set up";
  };
  statusListeners.add(apply);
  if (lastStatus) apply(lastStatus);

  btn.addEventListener("click", () => openAiSetup());
  void refreshStatus();
  return btn;
}

function closeOverlay(): void {
  if (overlay) {
    overlay.remove();
    overlay = null;
  }
}

/** Open the AI setup dialog. Safe to call repeatedly (no-op if already open). */
export function openAiSetup(): void {
  if (overlay) return;

  overlay = document.createElement("div");
  overlay.className = "ai-setup-overlay";
  overlay.addEventListener("pointerdown", (e) => {
    if (e.target === overlay) closeOverlay();
  });

  const dialog = document.createElement("div");
  dialog.className = "ai-setup-dialog";
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-label", "AI setup");

  dialog.innerHTML = `
    <button class="ai-setup-close" type="button" aria-label="Close">×</button>
    <h2>Set up AI explanations</h2>
    <p class="ai-setup-intro">
      ScAI-Reader can explain terms and figures right inside your paper. This
      uses Anthropic's Claude and needs a one-time API key. Reading,
      highlighting, and search work without it.
    </p>
    <ol class="ai-setup-steps">
      <li>Open the <a class="ai-setup-link" target="_blank" rel="noopener"
        href="${CONSOLE_URL}">Anthropic console</a> and create a key
        (it starts with <code>sk-ant-</code>).</li>
      <li>Paste it below and click Save. Usage is billed to your Anthropic
        account.</li>
    </ol>
    <div class="ai-setup-form">
      <input class="ai-setup-input" type="password" autocomplete="off"
        spellcheck="false" placeholder="sk-ant-..." aria-label="Anthropic API key" />
      <button class="ai-setup-save" type="button">Save</button>
    </div>
    <p class="ai-setup-feedback" role="status"></p>
    <div class="ai-setup-configured" hidden>
      <span class="ai-setup-on">✓ AI explanations are on.</span>
      <button class="ai-setup-remove" type="button">Remove key</button>
    </div>
  `;

  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

  const input = dialog.querySelector(".ai-setup-input") as HTMLInputElement;
  const saveBtn = dialog.querySelector(".ai-setup-save") as HTMLButtonElement;
  const feedback = dialog.querySelector(".ai-setup-feedback") as HTMLElement;
  const configured = dialog.querySelector(".ai-setup-configured") as HTMLElement;
  const removeBtn = dialog.querySelector(".ai-setup-remove") as HTMLButtonElement;
  const form = dialog.querySelector(".ai-setup-form") as HTMLElement;
  const onLabel = dialog.querySelector(".ai-setup-on") as HTMLElement;

  const closeBtn = dialog.querySelector(".ai-setup-close") as HTMLButtonElement;
  closeBtn.addEventListener("click", closeOverlay);

  const onKeydown = (e: KeyboardEvent): void => {
    if (e.key === "Escape") {
      closeOverlay();
      document.removeEventListener("keydown", onKeydown);
    }
  };
  document.addEventListener("keydown", onKeydown);

  const setFeedback = (msg: string, kind: "info" | "error" | "ok"): void => {
    feedback.textContent = msg;
    feedback.dataset.kind = kind;
  };

  const renderStatus = (s: AiStatus | null): void => {
    if (!s) {
      setFeedback("Couldn't reach the backend to check AI status.", "error");
      return;
    }
    if (s.source === "env") {
      configured.hidden = false;
      removeBtn.hidden = true;
      form.hidden = true;
      onLabel.textContent =
        "✓ AI is on — the key comes from your environment.";
      return;
    }
    configured.hidden = !s.configured;
    removeBtn.hidden = !s.configured;
    onLabel.textContent = "✓ AI explanations are on.";
  };

  const doSave = async (): Promise<void> => {
    const key = input.value.trim();
    if (!key) {
      setFeedback("Paste your API key first.", "error");
      return;
    }
    saveBtn.disabled = true;
    setFeedback("Checking your key…", "info");
    try {
      const result = await saveAiKey(key);
      input.value = "";
      await refreshStatus();
      renderStatus(lastStatus);
      setFeedback(
        result.warning ?? "Saved — AI explanations are on.",
        result.warning ? "info" : "ok",
      );
    } catch (err) {
      setFeedback((err as Error).message, "error");
    } finally {
      saveBtn.disabled = false;
    }
  };

  saveBtn.addEventListener("click", () => void doSave());
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") void doSave();
  });

  removeBtn.addEventListener("click", async () => {
    removeBtn.disabled = true;
    try {
      await clearAiKey();
      await refreshStatus();
      renderStatus(lastStatus);
      setFeedback("Key removed. AI explanations are off.", "info");
    } catch (err) {
      setFeedback((err as Error).message, "error");
    } finally {
      removeBtn.disabled = false;
    }
  });

  // Reflect current status as soon as it's known.
  if (lastStatus) renderStatus(lastStatus);
  void refreshStatus().then(renderStatus);
  input.focus();
}

/**
 * One-time, dismissible banner nudging first-time users to turn on AI.
 * No-op if AI is already configured or the user dismissed it before.
 */
export async function maybeShowAiNudge(parent: HTMLElement): Promise<void> {
  let dismissed = false;
  try {
    dismissed = localStorage.getItem(NUDGE_DISMISS_KEY) === "1";
  } catch {
    /* localStorage may be unavailable; just show the nudge */
  }
  if (dismissed) return;

  const status = await refreshStatus();
  if (!status || status.configured) return;

  const banner = document.createElement("div");
  banner.className = "ai-nudge";
  banner.innerHTML = `
    <span>💡 Turn on AI explanations to define terms and figures inside your paper.</span>
    <span class="ai-nudge-actions">
      <button class="ai-nudge-setup" type="button">Set up AI</button>
      <button class="ai-nudge-dismiss" type="button">Not now</button>
    </span>
  `;
  const dismiss = (): void => {
    try {
      localStorage.setItem(NUDGE_DISMISS_KEY, "1");
    } catch {
      /* ignore */
    }
    banner.remove();
  };
  (banner.querySelector(".ai-nudge-setup") as HTMLButtonElement).addEventListener(
    "click",
    () => {
      dismiss();
      openAiSetup();
    },
  );
  (
    banner.querySelector(".ai-nudge-dismiss") as HTMLButtonElement
  ).addEventListener("click", dismiss);
  parent.appendChild(banner);
}

/** Test-only: reset module state. */
export function _resetForTest(): void {
  lastStatus = null;
  statusListeners.clear();
  closeOverlay();
}
