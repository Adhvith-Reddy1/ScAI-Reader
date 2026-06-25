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

function stubStatus(status: api.AiStatus) {
  vi.spyOn(api, "getAiStatus").mockResolvedValue(status);
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("buildAiSetupButton", () => {
  it("reflects unconfigured status with an off dot", async () => {
    stubStatus({ configured: false, source: null, editable: true });
    const btn = buildAiSetupButton();
    document.body.appendChild(btn);
    await flush();
    expect(btn.dataset.configured).toBe("false");
    expect(btn.title).toMatch(/set up/i);
  });

  it("reflects configured status", async () => {
    stubStatus({ configured: true, source: "stored", editable: true });
    const btn = buildAiSetupButton();
    await flush();
    expect(btn.dataset.configured).toBe("true");
  });

  it("opens the dialog on click", async () => {
    stubStatus({ configured: false, source: null, editable: true });
    const btn = buildAiSetupButton();
    document.body.appendChild(btn);
    btn.click();
    await flush();
    expect(document.querySelector(".ai-setup-dialog")).not.toBeNull();
  });
});

describe("openAiSetup", () => {
  it("saves a key and shows success", async () => {
    stubStatus({ configured: false, source: null, editable: true });
    const save = vi
      .spyOn(api, "saveAiKey")
      .mockResolvedValue({
        configured: true,
        source: "stored",
        validated: true,
        warning: null,
      });

    openAiSetup();
    await flush();
    const input = document.querySelector(".ai-setup-input") as HTMLInputElement;
    input.value = "sk-ant-abc";
    (document.querySelector(".ai-setup-save") as HTMLButtonElement).click();
    await flush();

    expect(save).toHaveBeenCalledWith("sk-ant-abc");
    const feedback = document.querySelector(".ai-setup-feedback") as HTMLElement;
    expect(feedback.dataset.kind).toBe("ok");
  });

  it("surfaces a rejected key as an error", async () => {
    stubStatus({ configured: false, source: null, editable: true });
    vi.spyOn(api, "saveAiKey").mockRejectedValue(
      new Error("Anthropic rejected that key."),
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
    stubStatus({ configured: false, source: null, editable: true });
    openAiSetup();
    openAiSetup();
    await flush();
    expect(document.querySelectorAll(".ai-setup-dialog").length).toBe(1);
  });
});

describe("maybeShowAiNudge", () => {
  it("shows a banner when AI is not configured", async () => {
    stubStatus({ configured: false, source: null, editable: true });
    await maybeShowAiNudge(document.body);
    expect(document.querySelector(".ai-nudge")).not.toBeNull();
  });

  it("does not show when AI is already configured", async () => {
    stubStatus({ configured: true, source: "stored", editable: true });
    await maybeShowAiNudge(document.body);
    expect(document.querySelector(".ai-nudge")).toBeNull();
  });

  it("stays dismissed across calls", async () => {
    stubStatus({ configured: false, source: null, editable: true });
    await maybeShowAiNudge(document.body);
    (document.querySelector(".ai-nudge-dismiss") as HTMLButtonElement).click();
    expect(document.querySelector(".ai-nudge")).toBeNull();

    await maybeShowAiNudge(document.body);
    expect(document.querySelector(".ai-nudge")).toBeNull();
  });
});
