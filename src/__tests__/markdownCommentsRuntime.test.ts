// @vitest-environment jsdom
import type { EditorView } from "@codemirror/view";
import { createApp, h, nextTick, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import BaseMarkdownEditor from "../components/ui/BaseMarkdownEditor.vue";
import { createMarkdownCommentController, layoutCommentCards } from "../components/ui/markdown-editor/markdownCommentController";
import { findCommentBlock } from "../document/markdownComments";
import { Text } from "@codemirror/state";
import { useDocumentEditingSettings } from "../composables/useDocumentEditingSettings";

type EditorExpose = { getEditorView(): EditorView | null };

let app: App<Element> | null = null;

beforeEach(() => {
  if (!(Range.prototype as Range & { getClientRects?: unknown }).getClientRects) {
    Object.defineProperty(Range.prototype, "getClientRects", { configurable: true, value: () => [] });
  }
  if (!(Range.prototype as Range & { getBoundingClientRect?: unknown }).getBoundingClientRect) {
    Object.defineProperty(Range.prototype, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 }),
    });
  }
});

afterEach(() => {
  app?.unmount();
  app = null;
  useDocumentEditingSettings().setCommentAuthor("");
  document.body.replaceChildren();
});

async function settle(): Promise<void> {
  for (let index = 0; index < 4; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    await nextTick();
  }
}

function press(view: EditorView, key: string): void {
  view.contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key, ctrlKey: true, altKey: true, bubbles: true, cancelable: true }));
}

function type(element: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  element.value = value;
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

function mountEditor(initial: string) {
  const root = document.createElement("div");
  document.body.appendChild(root);
  const controller = createMarkdownCommentController();
  const model = { value: initial };
  let editor: EditorExpose | null = null;
  app = createApp({
    setup: () => () => h(BaseMarkdownEditor, {
      ref: (value: unknown) => { editor = value as EditorExpose | null; },
      modelValue: model.value,
      contentPath: "notes.md",
      contentKey: "notes",
      viewMode: "rendered",
      comments: controller,
      "onUpdate:modelValue": (value: string) => { model.value = value; },
    }),
  });
  app.mount(root);
  return { controller, model, view: () => editor!.getEditorView()! };
}

describe("markdown comments in the editor", () => {
  it("creates a comment from the selection and remembers the author name", async () => {
    const { controller, model, view } = mountEditor("Alpha beta gamma.");
    await nextTick();
    view().dispatch({ selection: { anchor: 6, head: 10 } });
    press(view(), "m");
    await settle();
    expect(controller.draft.value?.quote).toBe("beta");

    const author = document.body.querySelector<HTMLInputElement>(".comment-author-input")!;
    const text = document.body.querySelector<HTMLTextAreaElement>(".comment-textarea")!;
    type(author, "Enno");
    type(text, "Why beta?");
    await nextTick();
    const buttons = document.body.querySelectorAll<HTMLButtonElement>(".comment-composer-actions button");
    const submit = buttons[buttons.length - 1]!;
    submit.click();
    await settle();

    const block = findCommentBlock(Text.of(model.value.split("\n")))!;
    expect(block.threads).toHaveLength(1);
    expect(block.threads[0].anchor?.exact).toBe("beta");
    expect(block.threads[0].messages[0]).toMatchObject({ author: "Enno", text: "Why beta?" });
    expect(useDocumentEditingSettings().state.commentAuthor).toBe("Enno");
    expect(controller.threads.value.map((thread) => thread.id)).toEqual([block.threads[0].id]);
    expect(controller.activeId.value).toBe(block.threads[0].id);
    expect(view().contentDOM.querySelector(".cm-comment-anchor")?.textContent).toBe("beta");
  });

  it("inserts a footnote and writes the text entered in its panel", async () => {
    const { model, view } = mountEditor("First line.");
    await nextTick();
    view().dispatch({ selection: { anchor: 5 } });
    press(view(), "f");
    await settle();
    const textarea = document.body.querySelector<HTMLTextAreaElement>(".footnote-textarea")!;
    expect(textarea).not.toBeNull();
    type(textarea, "A note");
    await nextTick();
    document.body.querySelector<HTMLButtonElement>(".footnote-actions button")!.click();
    await settle();
    expect(model.value).toBe("First[^1] line.\n\n[^1]: A note");
    expect(document.body.querySelector(".footnote-textarea")).toBeNull();
  });

  it("removes a new footnote again when its panel closes empty", async () => {
    const { model, view } = mountEditor("First line.");
    await nextTick();
    view().dispatch({ selection: { anchor: 5 } });
    press(view(), "f");
    await settle();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await settle();
    expect(model.value).toBe("First line.");
  });
});

describe("comment rail layout", () => {
  it("keeps cards at their anchors and pushes overlapping ones down", () => {
    const tops = layoutCommentCards([
      { key: "a", desired: 100, height: 80 },
      { key: "b", desired: 120, height: 40 },
      { key: "c", desired: 400, height: 40 },
    ], null);
    expect([...tops]).toEqual([["a", 100], ["b", 188], ["c", 400]]);
  });

  it("puts the active card at its anchor and moves earlier cards up", () => {
    const tops = layoutCommentCards([
      { key: "a", desired: 100, height: 80 },
      { key: "b", desired: 120, height: 40 },
    ], "b");
    expect([...tops]).toEqual([["a", 32], ["b", 120]]);
    const clamped = layoutCommentCards([
      { key: "a", desired: 10, height: 80 },
      { key: "b", desired: 20, height: 40 },
    ], "b");
    expect([...clamped]).toEqual([["a", 0], ["b", 88]]);
  });

  it("orders cards on the same line by document position", () => {
    const tops = layoutCommentCards([
      { key: "later", desired: 100, height: 40, order: 30 },
      { key: "earlier", desired: 100, height: 40, order: 5 },
    ], null);
    expect([...tops]).toEqual([["earlier", 100], ["later", 148]]);
  });
});
