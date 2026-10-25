// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const key = "locus-document-editing-settings";
beforeEach(() => { localStorage.clear(); vi.resetModules(); });

describe("document editing settings", () => {
  it("defaults to disabled for absent and non-boolean preferences", async () => {
    const { normalizeDocumentEditingSettings, useDocumentEditingSettings } = await import("../composables/useDocumentEditingSettings");
    expect(useDocumentEditingSettings().state.punctuationPairing).toBe(false);
    for (const value of [null, {}, { punctuationPairing: "true" }, { punctuationPairing: 1 }]) {
      expect(normalizeDocumentEditingSettings(value).punctuationPairing).toBe(false);
    }
  });

  it("defaults to disabled when saved JSON is malformed", async () => {
    localStorage.setItem(key, "{invalid");
    expect((await import("../composables/useDocumentEditingSettings")).useDocumentEditingSettings().state.punctuationPairing).toBe(false);
  });

  it("persists both enabled and disabled choices across reloads", async () => {
    const first = (await import("../composables/useDocumentEditingSettings")).useDocumentEditingSettings();
    first.setPunctuationPairing(true);
    vi.resetModules();
    const second = (await import("../composables/useDocumentEditingSettings")).useDocumentEditingSettings();
    expect(second.state.punctuationPairing).toBe(true);
    second.setPunctuationPairing(false);
    vi.resetModules();
    expect((await import("../composables/useDocumentEditingSettings")).useDocumentEditingSettings().state.punctuationPairing).toBe(false);
  });

  it("persists a normalized comment author name", async () => {
    const first = (await import("../composables/useDocumentEditingSettings")).useDocumentEditingSettings();
    expect(first.state.commentAuthor).toBe("");
    first.setCommentAuthor("  Enno \n Ruschak  ");
    expect(first.state.commentAuthor).toBe("Enno Ruschak");
    vi.resetModules();
    const second = (await import("../composables/useDocumentEditingSettings")).useDocumentEditingSettings();
    expect(second.state.commentAuthor).toBe("Enno Ruschak");
    expect(second.state.punctuationPairing).toBe(false);
  });

  it("updates other windows and returns to disabled when storage is reset", async () => {
    const settings = (await import("../composables/useDocumentEditingSettings")).useDocumentEditingSettings();
    localStorage.setItem(key, JSON.stringify({ punctuationPairing: true }));
    window.dispatchEvent(new StorageEvent("storage", { key }));
    expect(settings.state.punctuationPairing).toBe(true);
    localStorage.clear();
    window.dispatchEvent(new StorageEvent("storage", { key: null }));
    expect(settings.state.punctuationPairing).toBe(false);
  });
});
