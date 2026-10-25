import { reactive, readonly } from "vue";

const STORAGE_KEY = "locus-document-editing-settings";
const MAX_COMMENT_AUTHOR_LENGTH = 64;

export function normalizeCommentAuthor(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, MAX_COMMENT_AUTHOR_LENGTH) : "";
}

export function normalizeDocumentEditingSettings(value: unknown) {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return {
    punctuationPairing: record.punctuationPairing === true,
    /** Name written on document comments. */
    commentAuthor: normalizeCommentAuthor(record.commentAuthor),
  };
}

function load() {
  try {
    return normalizeDocumentEditingSettings(JSON.parse(localStorage.getItem(STORAGE_KEY) || "null"));
  } catch {
    return normalizeDocumentEditingSettings(null);
  }
}

const state = reactive(load());

// Document and settings windows share the same origin and storage.
if (typeof window !== "undefined") window.addEventListener("storage", (event) => {
  if (event.key === STORAGE_KEY || event.key === null) Object.assign(state, load());
});

function persist(): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch { /* optional persistence */ }
}

export function useDocumentEditingSettings() {
  return {
    state: readonly(state),
    setPunctuationPairing(enabled: boolean) {
      state.punctuationPairing = enabled;
      persist();
    },
    setCommentAuthor(name: string) {
      state.commentAuthor = normalizeCommentAuthor(name);
      persist();
    },
  };
}
