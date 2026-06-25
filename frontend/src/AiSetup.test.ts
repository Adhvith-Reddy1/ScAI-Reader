import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  buildAiSetupButton,
  maybeShowAiNudge,
  openAiSetup,
  _resetForTest,
} from "./AiSetup.ts";
import * as api from "./api.ts";

beforeEach(() => {
  document.body.innerHTML = "";
  localStorage.clear();
  _resetForTest();
  vi.restoreAllMocks();
});

function stubStatus(status: Partial<api.AiStatus>) {
  vi.spyOn(api, "getAiStatus").mockResolvedValue({
    configured: false,
    source: null,
    provider: null,
    model: null,
    base_url: null,
    editable: true,
    ...status,
  });
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("buildAiSetupButton", () => {
  it("reflects unconfigured status with an off dot", async () => {
    stubStatus({ configured: false });
    const btn = buildAiSetupButton();
    document.body.appendChild(btn);
    await flush();
    expect(btn.dataset.configured).toBe("false");
    expect(btn.title).toMatch(/set up/i);
    expect(btn.textContent).toContain("AI off");
  });

  it("reflects configured status", async () => {
    stubStatus({ configured: true, source: "stored", provider: "anthropic" });
    const btn = buildAiSetupButton();
    await flush();
    expect(btn.dataset.configured).toBe("true");
    expect(btn.textContent).toContain("AI on");
  });

  it("opens the dialog on click", async () => {
    stubStatus({ configured: false });
    const btn = buildAiSetupButton();
    document.body.appendChild(btn);
    btn.click();
    await flush();
    expect(document.querySelector(".ai-setup-dialog")).not.toBeNull();
  });
});

describe("openAiSetup", () => {
  it("saves the selected provider + key and shows success", async () => {
    stubStatus({ configured: false });
    const save = vi.spyOn(api, "saveAiConfig").mockResolvedValue({
      configured: true,
      source: "stored",
      provider: "openai",
      model: "gpt-4o",
      validated: true,
      warning: null,
    });

    openAiSetup();
    await flush();
    (document.querySelector(".ai-setup-provider") as HTMLSelectElement).value =
      "openai";
    const input = document.querySelector(".ai-setup-input") as HTMLInputElement;
    input.value = "sk-openai";
    (document.querySelector(".ai-setup-model") as HTMLInputElement).value =
      "gpt-4o";
    (document.querySelector(".ai-setup-save") as HTMLButtonElement).click();
    await flush();

    expect(save).toHaveBeenCalledWith({
      provider: "openai",
      apiKey: "sk-openai",
      model: "gpt-4o",
      baseUrl: undefined,
    });
    const feedback = document.querySelector(".ai-setup-feedback") as HTMLElement;
    expect(feedback.dataset.kind).toBe("ok");
  });

  it("shows an optional model field for cloud providers (no base URL)", async () => {
    stubStatus({ configured: false });
    openAiSetup();
    await flush();
    // Default provider (anthropic): model shown and labelled optional; the
    // base URL is hidden, and the default model is named in the placeholder.
    const modelField = document.querySelector(
      ".ai-setup-model-field",
    ) as HTMLElement;
    const baseField = document.querySelector(
      ".ai-setup-baseurl-field",
    ) as HTMLElement;
    const modelInput = document.querySelector(
      ".ai-setup-model",
    ) as HTMLInputElement;
    const modelLabel = document.querySelector(
      ".ai-setup-model-label",
    ) as HTMLElement;
    expect(modelField.hidden).toBe(false);
    expect(baseField.hidden).toBe(true);
    expect(modelLabel.textContent).toMatch(/optional/i);
    expect(modelInput.placeholder).toContain("claude-haiku-4-5");
    // The Advanced toggle is gone.
    expect(document.querySelector(".ai-setup-advanced")).toBeNull();
  });

  it("shows the model (required) for OpenAI-compatible", async () => {
    stubStatus({ configured: false });
    openAiSetup();
    await flush();
    const sel = document.querySelector(".ai-setup-provider") as HTMLSelectElement;
    sel.value = "openai_compatible";
    sel.dispatchEvent(new Event("change"));
    const modelField = document.querySelector(
      ".ai-setup-model-field",
    ) as HTMLElement;
    const modelLabel = document.querySelector(
      ".ai-setup-model-label",
    ) as HTMLElement;
    expect(modelField.hidden).toBe(false);
    expect(modelLabel.textContent).not.toMatch(/optional/i);
  });

  it("shows the base URL field for an OpenAI-compatible provider", async () => {
    stubStatus({ configured: false });
    openAiSetup();
    await flush();
    const sel = document.querySelector(".ai-setup-provider") as HTMLSelectElement;
    const baseField = document.querySelector(
      ".ai-setup-baseurl-field",
    ) as HTMLElement;
    expect(baseField.hidden).toBe(true);
    sel.value = "openai_compatible";
    sel.dispatchEvent(new Event("change"));
    expect(baseField.hidden).toBe(false);
  });

  it("surfaces a rejected key as an error", async () => {
    stubStatus({ configured: false });
    vi.spyOn(api, "saveAiConfig").mockRejectedValue(
      new Error("The provider rejected that key."),
    );

    openAiSetup();
    await flush();
    const input = document.querySelector(".ai-setup-input") as HTMLInputElement;
    input.value = "sk-ant-bad";
    (document.querySelector(".ai-setup-save") as HTMLButtonElement).click();
    await flush();

    const feedback = document.querySelector(".ai-setup-feedback") as HTMLElement;
    expect(feedback.dataset.kind).toBe("error");
    expect(feedback.textContent).toMatch(/rejected/i);
  });

  it("is a no-op to open twice (single dialog)", async () => {
    stubStatus({ configured: false });
    openAiSetup();
    openAiSetup();
    await flush();
    expect(document.querySelectorAll(".ai-setup-dialog").length).toBe(1);
  });
});

describe("maybeShowAiNudge", () => {
  it("shows a banner when AI is not configured", async () => {
    stubStatus({ configured: false });
    await maybeShowAiNudge(document.body);
    expect(document.querySelector(".ai-nudge")).not.toBeNull();
  });

  it("does not show when AI is already configured", async () => {
    stubStatus({ configured: true, source: "stored", provider: "anthropic" });
    await maybeShowAiNudge(document.body);
    expect(document.querySelector(".ai-nudge")).toBeNull();
  });

  it("stays dismissed across calls", async () => {
    stubStatus({ configured: false });
    await maybeShowAiNudge(document.body);
    (document.querySelector(".ai-nudge-dismiss") as HTMLButtonElement).click();
    expect(document.querySelector(".ai-nudge")).toBeNull();

    await maybeShowAiNudge(document.body);
    expect(document.querySelector(".ai-nudge")).toBeNull();
  });
});
