// @vitest-environment jsdom
import { createApp, defineComponent, h, nextTick, reactive, type App } from "vue";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAssetState } from "../composables/useAssetState";
import { listDirEntriesPage } from "../services/project";

const mocks = vi.hoisted(() => ({
  disk: new Map<string, string>(),
  cache: new Map<string, Array<{ name: string; relPath: string; isDir: boolean }>>(),
  listeners: new Set<(event: any) => void>(),
  start: vi.fn(), stop: vi.fn(),
  pausePath: null as string | null,
  finishListing: null as null | (() => void),
}));
vi.mock("../services/workspaceFileWatch", () => ({ startWorkspaceFileWatch: mocks.start }));
vi.mock("../services/project", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/project")>()),
  listDirEntriesPage: vi.fn(async (path: string, _scope: unknown, offset: number, limit: number, _meta: boolean, hidden: string[]) => {
    // The actual command refreshes at offset 0 and caches the remaining pages.
    if (offset === 0 || !mocks.cache.has(path)) {
      const prefix = path === "." ? "" : `${path}/`;
      const entries = [...mocks.disk].filter(([key, kind]) => key.startsWith(prefix)
        && !key.slice(prefix.length).includes("/") && !(kind === "folder" && hidden.includes(key.slice(prefix.length))))
        .map(([key, kind]) => ({ name: key.slice(prefix.length), relPath: key, isDir: kind === "folder" }))
        .sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name));
      mocks.cache.set(path, entries);
    }
    const entries = mocks.cache.get(path)!;
    const result = { entries: entries.slice(offset, offset + limit), totalCount: entries.length,
      nextOffset: Math.min(entries.length, offset + limit), hasMore: offset + limit < entries.length };
    if (path === mocks.pausePath && limit > 1) {
      mocks.pausePath = null;
      await new Promise<void>(resolve => { mocks.finishListing = resolve; });
    }
    return result;
  }),
  statWorkspaceEntries: vi.fn(async (paths: string[]) => paths.map(path => ({
    path, exists: mocks.disk.has(path), entryKind: mocks.disk.get(path) ?? "missing",
  }))),
  searchWorkspaceEntries: vi.fn(async () => []),
}));
vi.mock("../services/workspaceExplorer", () => ({
  subscribeWorkspaceFileChanges: vi.fn(async (listener: (event: any) => void) => {
    mocks.listeners.add(listener); return () => { mocks.listeners.delete(listener); };
  }),
  subscribeExplorerFileActions: vi.fn(async () => () => {}),
}));
vi.mock("../services/workspaceEventHub", () => ({ listenWorkspaceEvent: vi.fn(async () => () => {}) }));
vi.mock("../services/asset", () => ({ assetDbOverview: vi.fn(), assetDbScanStart: vi.fn(), previewWorkspaceAsset: vi.fn(),
  previewWorkspaceAssetTarget: vi.fn(), getWatcherTuning: vi.fn(), setWatcherTuning: vi.fn() }));

const apps: App[] = [];
const reference = { checkoutId: "audit", expectedGeneration: 1, expectedMaterializationEpoch: 0 };
beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks(); mocks.disk.clear(); mocks.cache.clear(); mocks.listeners.clear();
  mocks.pausePath = null; mocks.finishListing = null;
  mocks.stop.mockResolvedValue(undefined); mocks.start.mockResolvedValue(mocks.stop);
});
afterEach(() => { apps.splice(0).forEach(app => app.unmount()); vi.useRealTimers(); document.body.replaceChildren(); });
async function flush() { for (let i = 0; i < 35; i++) await nextTick(); }
function mount(watchWorkspaceFiles = true) {
  let state!: ReturnType<typeof useAssetState>;
  const props = reactive({ workingDir: "F:/Audit", workspaceRef: { ...reference }, includeFilesInTree: true, watchWorkspaceFiles });
  const app = createApp(defineComponent({ setup() { state = useAssetState(props); return () => h("div"); } }));
  apps.push(app); app.mount(document.createElement("div")); return { state, props };
}
function paths(state: ReturnType<typeof useAssetState>) {
  const result: string[] = [];
  function walk(nodes: typeof state.explorerTree.value) {
    for (const node of nodes) { result.push(node.path); if (node.kind === "folder") walk(node.children); }
  }
  walk(state.explorerTree.value); return result;
}
function emit(path: string, identity = reference, rescan = false) {
  for (const listener of mocks.listeners) listener({ checkoutId: identity.checkoutId, workspaceGeneration: identity.expectedGeneration,
    materializationEpoch: identity.expectedMaterializationEpoch, eventName: "workspace-file-changed",
    payload: { path, kind: mocks.disk.has(path) ? "upsert" : "delete", source: "os_watcher", rescan } });
}

it("starts before reading the tree, scopes events and releases when leaving file mode", async () => {
  mocks.start.mockImplementation(async () => { expect(mocks.listeners.size).toBe(1); return mocks.stop; });
  const { state } = mount(); await flush(); expect(mocks.start).toHaveBeenCalledWith(reference);
  mocks.disk.set("new.md", "file");
  emit("new.md", { ...reference, checkoutId: "sibling" });
  emit("new.md", { ...reference, expectedGeneration: 2 });
  emit("new.md", { ...reference, expectedMaterializationEpoch: 1 });
  await vi.advanceTimersByTimeAsync(200); expect(paths(state)).not.toContain("new.md");
  emit("new.md"); await vi.advanceTimersByTimeAsync(120); expect(paths(state)).toContain("new.md");
  apps.pop()!.unmount(); expect(mocks.stop).toHaveBeenCalledOnce(); expect(mocks.listeners.size).toBe(0);
});

it("does not start the general watcher for Unity or session-mode consumers", async () => {
  mount(false); await flush(); expect(mocks.start).not.toHaveBeenCalled();
  mocks.disk.set("Assets", "folder"); mocks.disk.set("ProjectSettings/ProjectVersion.txt", "file");
  mount(); await flush(); expect(mocks.start).not.toHaveBeenCalled();
});

it("updates a loaded nested folder after create, rename and delete while retaining expansion", async () => {
  mocks.disk.set("Docs", "folder"); const { state } = mount(); await flush(); await state.togglePath("Docs");
  mocks.disk.set("Docs/new.md", "file"); emit("Docs/new.md"); await vi.advanceTimersByTimeAsync(120);
  expect(paths(state)).toContain("Docs/new.md"); expect(state.isPathExpanded("Docs")).toBe(true);
  mocks.disk.delete("Docs/new.md"); mocks.disk.set("Docs/renamed.md", "file"); emit("Docs/new.md"); emit("Docs/renamed.md");
  await vi.advanceTimersByTimeAsync(120);
  expect(paths(state)).not.toContain("Docs/new.md"); expect(paths(state)).toContain("Docs/renamed.md");
  mocks.disk.delete("Docs/renamed.md"); emit("Docs/renamed.md"); await vi.advanceTimersByTimeAsync(120);
  expect(paths(state)).not.toContain("Docs/renamed.md");
});

it("does not starve refreshes during continuous disk changes", async () => {
  const { state } = mount(); await flush(); mocks.disk.set("new.md", "file");
  emit("new.md"); await vi.advanceTimersByTimeAsync(100); emit("new.md"); await vi.advanceTimersByTimeAsync(20);
  expect(paths(state)).toContain("new.md");
});

it("refreshes the paging snapshot without skipping or duplicating entries", async () => {
  for (let i = 0; i < 201; i++) mocks.disk.set(`f${String(i).padStart(3, "0")}.txt`, "file");
  const { state } = mount(); await flush(); expect(paths(state)).not.toContain("f200.txt");
  mocks.disk.set("a-new.txt", "file"); emit("a-new.txt"); await vi.advanceTimersByTimeAsync(120);
  expect(paths(state)).toContain("a-new.txt"); await state.loadMoreFolder(".");
  expect(paths(state)).toContain("f200.txt"); expect(paths(state)).toHaveLength(203);
  expect(new Set(paths(state)).size).toBe(203);
  mocks.disk.delete("f005.txt"); emit("f005.txt"); await vi.advanceTimersByTimeAsync(120);
  expect(paths(state)).not.toContain("f005.txt"); expect(paths(state)).toHaveLength(202);
});

it("replays changes during the initial directory read", async () => {
  mocks.pausePath = "."; const { state } = mount(); await flush();
  expect(mocks.finishListing).not.toBeNull(); expect(mocks.listeners.size).toBe(1);
  mocks.disk.set("during-load.md", "file"); emit("during-load.md");
  await vi.advanceTimersByTimeAsync(500); mocks.finishListing!(); await flush();
  await vi.advanceTimersByTimeAsync(120); expect(paths(state)).toContain("during-load.md");
});

it("replays a change while a nested folder is being loaded", async () => {
  mocks.disk.set("Docs", "folder"); const { state } = mount(); await flush();
  mocks.pausePath = "Docs"; const loading = state.togglePath("Docs"); await flush();
  mocks.disk.set("Docs/during-load.md", "file"); emit("Docs/during-load.md");
  await vi.advanceTimersByTimeAsync(120); mocks.finishListing!(); await loading;
  await vi.advanceTimersByTimeAsync(120); expect(paths(state)).toContain("Docs/during-load.md");
});

it("rescans loaded directories on an overflow and preserves configured hidden directories", async () => {
  mocks.disk.set("Docs", "folder"); const { state } = mount(); await flush(); await state.togglePath("Docs");
  mocks.disk.set("Docs/new.md", "file"); mocks.disk.set("node_modules", "folder");
  emit(".", reference, true); await vi.advanceTimersByTimeAsync(120);
  expect(paths(state)).toContain("Docs/new.md"); expect(paths(state)).not.toContain("node_modules");
});

it("ignores hidden subtree overflow but refreshes visible subtree contents", async () => {
  mocks.disk.set("Docs", "folder");
  const { state } = mount(); await flush(); await state.togglePath("Docs");
  vi.mocked(listDirEntriesPage).mockClear();
  emit("node_modules/packages", reference, true);
  await vi.advanceTimersByTimeAsync(150);
  expect(listDirEntriesPage).not.toHaveBeenCalled();
  mocks.disk.set("Docs/new.md", "file");
  emit("Docs", reference, true);
  await vi.advanceTimersByTimeAsync(120);
  expect(paths(state)).toContain("Docs/new.md");
});

it("reconciles only a rescanned subtree, including its loaded descendants", async () => {
  // The watcher collapses an overflow into the narrowest covering directory.
  mocks.disk.set("Docs", "folder"); mocks.disk.set("Docs/Inner", "folder"); mocks.disk.set("Other", "folder");
  const { state } = mount(); await flush();
  await state.togglePath("Docs"); await state.togglePath("Docs/Inner"); await state.togglePath("Other");
  vi.mocked(listDirEntriesPage).mockClear();
  mocks.disk.set("Docs/Inner/new.md", "file"); mocks.disk.set("Other/unrelated.md", "file");
  emit("Docs", reference, true); await vi.advanceTimersByTimeAsync(150);
  expect(paths(state)).toContain("Docs/Inner/new.md");
  expect(vi.mocked(listDirEntriesPage).mock.calls.map(([path]) => path)).not.toContain("Other");
  expect(paths(state)).not.toContain("Other/unrelated.md");
});

it("releases a watcher that finishes starting after unmount", async () => {
  let finish!: (release: () => Promise<void>) => void;
  mocks.start.mockReturnValue(new Promise(resolve => { finish = resolve; }));
  mount(); await flush(); apps.pop()!.unmount(); finish(mocks.stop); await flush();
  expect(mocks.stop).toHaveBeenCalledOnce(); expect(mocks.listeners.size).toBe(0);
});

it("keeps the directory usable and reports a native watcher startup failure", async () => {
  mocks.start.mockRejectedValue(new Error("Native watcher unavailable"));
  mocks.disk.set("existing.md", "file"); const { state } = mount(); await flush();
  expect(paths(state)).toContain("existing.md");
  expect(state.error.value).toContain("Native watcher unavailable");
});

it("reuses the watcher when reloading the same checkout and handles rescan in sibling consumers", async () => {
  const { state } = mount(); await flush(); await state.initializeExplorer();
  expect(mocks.start).toHaveBeenCalledOnce();
  const sibling = mount(false); await flush();
  mocks.disk.set("new.md", "file"); emit(".", reference, true); await vi.advanceTimersByTimeAsync(120);
  expect(paths(state)).toEqual([".", "new.md"]);
  expect(paths(sibling.state)).toEqual([".", "new.md"]);
});

it("replaces the watcher on checkout changes and ignores an old in-flight listing", async () => {
  mocks.disk.set("old.md", "file"); const { state, props } = mount(); await flush();
  mocks.pausePath = "."; emit("old.md"); await vi.advanceTimersByTimeAsync(120);
  const finishOld = mocks.finishListing!;
  mocks.disk.clear(); mocks.disk.set("new-checkout.md", "file");
  props.workspaceRef = { ...reference, checkoutId: "other" }; props.workingDir = "F:/Other"; await flush();
  finishOld(); await flush(); expect(mocks.stop).toHaveBeenCalledOnce();
  expect(mocks.start).toHaveBeenLastCalledWith({ ...reference, checkoutId: "other" });
  expect(paths(state)).toContain("new-checkout.md"); expect(paths(state)).not.toContain("old.md");
});
