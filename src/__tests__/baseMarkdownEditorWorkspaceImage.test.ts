// @vitest-environment jsdom
import type { EditorView } from "@codemirror/view";
import { createApp, h, nextTick, ref, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import BaseMarkdownEditor from "../components/ui/BaseMarkdownEditor.vue";

import type { RoutedWorkspaceEvent } from "../services/project";
import type { WorkspaceFileChangedPayload } from "../services/workspaceExplorer";

type FileChange = RoutedWorkspaceEvent<WorkspaceFileChangedPayload>;
const imageMocks = vi.hoisted(() => ({
  resolve: vi.fn(),
  listeners: new Set<(event: FileChange) => void>(),
}));

vi.mock("../services/workspaceExplorer", async importOriginal => ({
  ...await importOriginal<typeof import("../services/workspaceExplorer")>(),
  subscribeWorkspaceFileChanges: async (listener: (event: FileChange) => void) => {
    imageMocks.listeners.add(listener); return () => { imageMocks.listeners.delete(listener); };
  },
}));

vi.mock("../services/markdownImage", () => ({
  resolveMarkdownImage: imageMocks.resolve,
}));

type EditorExpose = { getEditorView(): EditorView | null };
let app: App<Element> | null = null;

beforeEach(() => {
  imageMocks.resolve.mockReset();
  imageMocks.resolve.mockResolvedValue({
    url: "data:image/png;base64,AA==",
    mimeType: "image/png",
    byteSize: 1,
    displayPath: "Assets/Docs/preview.png",
  });
  if (!Range.prototype.getClientRects) {
    Object.defineProperty(Range.prototype, "getClientRects", {
      configurable: true,
      value: () => [],
    });
  }
  if (!Range.prototype.getBoundingClientRect) {
    Object.defineProperty(Range.prototype, "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        left: 0,
        right: 0,
        top: 0,
        bottom: 0,
        width: 0,
        height: 0,
      }),
    });
  }
});

afterEach(() => {
  app?.unmount();
  app = null;
  imageMocks.listeners.clear();
  document.body.replaceChildren();
});

describe("BaseMarkdownEditor workspace images", () => {
  it("invalidates cached images for related subtree batches without rescanning document text", async () => {
    const root = document.createElement("div"); document.body.append(root);
    app = createApp({ render: () => h(BaseMarkdownEditor, {
      modelValue: "![Preview](Assets/Docs/preview.png)\n\n" + "Long document text. ".repeat(1000),
      viewMode: "rendered", contentPath: "design/rendering.md", contentKey: "image-storm",
      workspaceRef: { checkoutId: "checkout-a", expectedGeneration: 7 },
    }) });
    app.mount(root);
    await vi.waitFor(() => expect(imageMocks.resolve).toHaveBeenCalledTimes(1));
    const emit = (path: string, rescan = false) => {
      for (const listener of imageMocks.listeners) listener({
        eventName: "workspace-file-changed", streamRevision: 1, projectId: "project-a",
        checkoutId: "checkout-a", workspaceGeneration: 7,
        payload: { path, rescan, seq: 1, generation: 1, kind: "upsert", source: "os_watcher" },
      });
    };
    const lower = String.prototype.toLocaleLowerCase;
    let fullScans = 0;
    const spy = vi.spyOn(String.prototype, "toLocaleLowerCase").mockImplementation(function(this: string, ...args) {
      if (this.length > 10_000) fullScans++;
      return lower.apply(this, args);
    });
    try {
      for (let i = 0; i < 1000; i++) emit(`node_modules/picture-${i}.png`);
      emit("node_modules", true);
      expect(fullScans).toBe(0);
      expect(imageMocks.resolve).toHaveBeenCalledTimes(1);
    } finally { spy.mockRestore(); }
    for (let i = 0; i < 50; i++) emit("Assets/Docs", true);
    await vi.waitFor(() => expect(imageMocks.resolve).toHaveBeenCalledTimes(2));
    emit(".", true);
    await vi.waitFor(() => expect(imageMocks.resolve).toHaveBeenCalledTimes(3));
  });

  it("resolves local markdown images in the active checkout", async () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const editorRef = ref<EditorExpose | null>(null);
    app = createApp({
      setup() {
        return () => h(BaseMarkdownEditor, {
          ref: editorRef,
          modelValue: "![Preview](Assets/Docs/preview.png)",
          viewMode: "rendered",
          contentPath: "design/rendering.md",
          contentKey: "checkout-a:design/rendering.md:body",
          workspaceRef: { checkoutId: "checkout-a", expectedGeneration: 7 },
        });
      },
    });
    app.mount(root);
    await nextTick();

    await vi.waitFor(() => expect(imageMocks.resolve).toHaveBeenCalledWith(
      { checkoutId: "checkout-a", expectedGeneration: 7 },
      "Assets/Docs/preview.png",
      "design/rendering.md",
    ));
    await vi.waitFor(() => expect(
      root.querySelector<HTMLImageElement>(".cm-live-image")?.getAttribute("src"),
    ).toBe("data:image/png;base64,AA=="));
    expect(editorRef.value?.getEditorView()?.state.doc.toString()).toContain("Assets/Docs/preview.png");
  });
});
