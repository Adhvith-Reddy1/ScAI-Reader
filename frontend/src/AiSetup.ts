/**
 * Guided, in-app setup for the AI provider that powers explanations.
 *
 * A researcher won't have a key or know what one is, so this:
 *   - lets them pick a provider (Anthropic, OpenAI, or any OpenAI-compatible
 *     endpoint incl. local models via a base URL),
 *   - explains plainly what's needed and links to where to get a key,
 *   - lets them paste it (plus model/URL when relevant) and verifies it,
 *   - shows what's currently active, and lets them remove it.
 *
 * The config lives on the local backend (see app/ai.py); nothing here is
 * stored in the browser. A nav button reflects on/off status; a first-run
 * banner nudges setup once.
 */

import {
  clearAiKey,
  getAiStatus,
  saveAiConfig,
  type AiProvider,
  type AiStatus,
} from "./api.ts";

const NUDGE_DISMISS_KEY = "scai.aiNudgeDismissed";

interface ProviderMeta {
  label: string;
  keyPlaceholder: string;
  keyUrl: string;
  keyUrlLabel: string;
  modelPlaceholder: string;
  needsBaseUrl: boolean;
}

const PROVIDERS: { value: AiProvider; meta: ProviderMeta }[] = [
  {
    value: "anthropic",
    meta: {
      label: "Anthropic (Claude)",
      keyPlaceholder: "sk-ant-...",
      keyUrl: "https://console.anthropic.com/settings/keys",
      keyUrlLabel: "Anthropic console",
      modelPlaceholder: "claude-sonnet-4-6 (default)",
      needsBaseUrl: false,
    },
  },
  {
    value: "openai",
    meta: {
      label: "OpenAI (GPT)",
      keyPlaceholder: "sk-...",
      keyUrl: "https://platform.openai.com/api-keys",
      keyUrlLabel: "OpenAI dashboard",
      modelPlaceholder: "gpt-4o (default)",
      needsBaseUrl: false,
    },
  },
  {
    value: "openai_compatible",
    meta: {
      label: "OpenAI-compatible (OpenRouter, Groq, Ollama, …)",
      keyPlaceholder: "key (any value for local servers)",
      keyUrl: "",
      keyUrlLabel: "",
      modelPlaceholder: "e.g. llama3.1 (required)",
      needsBaseUrl: true,
    },
  },
];

function metaFor(p: AiProvider): ProviderMeta {
  return (PROVIDERS.find((x) => x.value === p) ?? PROVIDERS[0]).meta;
}

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
      ? `AI explanations are on (${s.provider ?? "configured"})`
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

  const providerOptions = PROVIDERS.map(
    (p) => `<option value="${p.value}">${p.meta.label}</option>`,
  ).join("");

  dialog.innerHTML = `
    <button class="ai-setup-close" type="button" aria-label="Close">×</button>
    <h2>Set up AI explanations</h2>
    <p class="ai-setup-intro">
      ScAI-Reader can explain terms and figures right inside your paper. Pick a
      provider and add an API key. Reading, highlighting, and search work
      without it.
    </p>
    <label class="ai-setup-field">
      <span>Provider</span>
      <select class="ai-setup-provider">${providerOptions}</select>
    </label>
    <label class="ai-setup-field ai-setup-baseurl-field" hidden>
      <span>Base URL</span>
      <input class="ai-setup-baseurl" type="text" autocomplete="off"
        spellcheck="false" placeholder="http://localhost:11434/v1" />
    </label>
    <label class="ai-setup-field">
      <span>API key <a class="ai-setup-link" target="_blank" rel="noopener" href="#">get one ↗</a></span>
      <input class="ai-setup-input" type="password" autocomplete="off"
        spellcheck="false" placeholder="sk-ant-..." aria-label="API key" />
    </label>
    <label class="ai-setup-field">
      <span>Model <span class="ai-setup-optional">(optional)</span></span>
      <input class="ai-setup-model" type="text" autocomplete="off"
        spellcheck="false" placeholder="" />
    </label>
    <div class="ai-setup-actions">
      <button class="ai-setup-save" type="button">Save</button>
    </div>
    <p class="ai-setup-feedback" role="status"></p>
    <div class="ai-setup-configured" hidden>
      <span class="ai-setup-on">✓ AI explanations are on.</span>
      <button class="ai-setup-remove" type="button">Remove</button>
    </div>
  `;

  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

  const providerSel = dialog.querySelector(
    ".ai-setup-provider",
  ) as HTMLSelectElement;
  const baseUrlField = dialog.querySelector(
    ".ai-setup-baseurl-field",
  ) as HTMLElement;
  const baseUrlInput = dialog.querySelector(
    ".ai-setup-baseurl",
  ) as HTMLInputElement;
  const input = dialog.querySelector(".ai-setup-input") as HTMLInputElement;
  const modelInput = dialog.querySelector(".ai-setup-model") as HTMLInputElement;
  const link = dialog.querySelector(".ai-setup-link") as HTMLAnchorElement;
  const saveBtn = dialog.querySelector(".ai-setup-save") as HTMLButtonElement;
  const feedback = dialog.querySelector(".ai-setup-feedback") as HTMLElement;
  const configured = dialog.querySelector(".ai-setup-configured") as HTMLElement;
  const removeBtn = dialog.querySelector(".ai-setup-remove") as HTMLButtonElement;
  const onLabel = dialog.querySelector(".ai-setup-on") as HTMLElement;
  const closeBtn = dialog.querySelector(".ai-setup-close") as HTMLButtonElement;

  const applyProviderMeta = (): void => {
    const meta = metaFor(providerSel.value as AiProvider);
    input.placeholder = meta.keyPlaceholder;
    modelInput.placeholder = meta.modelPlaceholder;
    baseUrlField.hidden = !meta.needsBaseUrl;
    if (meta.keyUrl) {
      link.href = meta.keyUrl;
      link.textContent = `get one from ${meta.keyUrlLabel} ↗`;
      link.hidden = false;
    } else {
      link.hidden = true;
    }
  };
  providerSel.addEventListener("change", applyProviderMeta);
  applyProviderMeta();

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
      onLabel.textContent = `✓ AI is on via ${s.provider ?? "environment"} — the key comes from your environment.`;
      return;
    }
    configured.hidden = !s.configured;
    removeBtn.hidden = !s.configured;
    if (s.configured) {
      const model = s.model ? ` · ${s.model}` : "";
      onLabel.textContent = `✓ AI is on — ${s.provider}${model}.`;
      if (s.provider) providerSel.value = s.provider;
      applyProviderMeta();
    }
  };

  const doSave = async (): Promise<void> => {
    const provider = providerSel.value as AiProvider;
    const key = input.value.trim();
    if (!key) {
      setFeedback("Paste your API key first.", "error");
      return;
    }
    saveBtn.disabled = true;
    setFeedback("Checking your key…", "info");
    try {
      const result = await saveAiConfig({
        provider,
        apiKey: key,
        model: modelInput.value.trim() || undefined,
        baseUrl: baseUrlInput.value.trim() || undefined,
      });
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
      setFeedback("Removed. AI explanations are off.", "info");
    } catch (err) {
      setFeedback((err as Error).message, "error");
    } finally {
      removeBtn.disabled = false;
    }
  });

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
