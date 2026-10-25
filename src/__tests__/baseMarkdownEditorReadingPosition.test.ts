// @vitest-environment jsdom
import { createApp, h, nextTick, ref, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import BaseMarkdownEditor from "../components/ui/BaseMarkdownEditor.vue";
import { MarkdownEditorSessionCache } from "../components/ui/markdown-editor/markdownEditorSessionCache";
import type { ReadingTarget } from "../services/readingPosition";

const mocks = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn() }));
vi.mock("../services/readingPosition", () => ({
  getReadingPosition: mocks.get,
  putReadingPosition: mocks.put,
  readingTargetKey: (target: ReadingTarget) => JSON.stringify([target.checkoutId ?? null, ...target.resource]),
  registerReadingPositionCapture: () => () => {},
}));

let app: App<Element> | null = null;

beforeEach(() => {
  mocks.get.mockReset().mockResolvedValue(null);
  mocks.put.mockReset();
  for (const method of ["getClientRects", "getBoundingClientRect"] as const) {
    if (!(Range.prototype as unknown as Record<string, unknown>)[method]) {
      Object.defineProperty(Range.prototype, method, {
        configurable: true,
        value: method === "getClientRects" ? () => [] : () => ({ left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 }),
      });
    }
  }
});

afterEach(() => {
  app?.unmount();
  app = null;
  document.body.replaceChildren();
});

async function settle() {
  for (let i = 0; i < 4; i += 1) { await Promise.resolve(); await nextTick(); }
}

function mount(state: { contentKey: string; target: ReadingTarget | null; text?: string }, sessionCache?: MarkdownEditorSessionCache) {
  const root = document.createElement("div");
  document.body.appendChild(root);
  const props = ref(state);
  app = createApp({ setup: () => () => h(BaseMarkdownEditor, {
    modelValue: props.value.text ?? `# ${props.value.contentKey}\n\nbody`,
    contentKey: props.value.contentKey,
    readingPosition: props.value.target,
    sessionCache: sessionCache ?? null,
  }) });
  app.mount(root);
  return { props, root };
}

const target = (name: string): ReadingTarget => ({ checkoutId: "checkout", resource: ["file", `${name}.md`] });

describe("BaseMarkdownEditor reading positions", () => {
  it("restores once the target of a still-loading document is known", async () => {
    const { props } = mount({ contentKey: "a", target: null });
    await settle();
    expect(mocks.get).not.toHaveBeenCalled();
    props.value = { ...props.value, target: target("a") };
    await settle();
    expect(mocks.get).toHaveBeenCalledTimes(1);
    expect(mocks.get).toHaveBeenCalledWith(target("a"));
  });

  it("does not jump after the user scrolled before the target arrived", async () => {
    const { props, root } = mount({ contentKey: "a", target: null });
    await settle();
    // Without an outer scroller the editor's own scroll element tracks input.
    root.querySelector(".cm-scroller")!.dispatchEvent(new WheelEvent("wheel"));
    props.value = { ...props.value, target: target("a") };
    await settle();
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it("uses the in-memory session instead of the durable position and records on switch", async () => {
    const cache = new MarkdownEditorSessionCache();
    const { props } = mount({ contentKey: "a", target: target("a") }, cache);
    await settle();
    expect(mocks.get).toHaveBeenCalledTimes(1);
    props.value = { contentKey: "b", target: target("b") };
    await settle();
    expect(mocks.get).toHaveBeenLastCalledWith(target("b"));
    // Leaving a document at its top removes its stored position.
    expect(mocks.put).toHaveBeenCalledWith(target("a"), null);
    props.value = { contentKey: "a", target: target("a") };
    await settle();
    expect(mocks.get).toHaveBeenCalledTimes(2);
  });

  it("moves the position to the new identity of a renamed document", async () => {
    const { props } = mount({ contentKey: "a", target: target("old") });
    await settle();
    props.value = { ...props.value, target: target("new") };
    await settle();
    expect(mocks.put).toHaveBeenCalledWith(target("new"), null);
    expect(mocks.put).toHaveBeenCalledWith(target("old"), null);
    expect(mocks.get).toHaveBeenCalledTimes(1);
  });
});
