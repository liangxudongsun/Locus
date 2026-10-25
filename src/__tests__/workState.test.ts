// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SavedWorkWindow, WindowFrontendPatch } from "../services/workState";
import type { WorkbenchWindowState } from "../types/workbench";
import { applyTextDelta } from "../document/textDelta";

const bridge = vi.hoisted(() => ({
  invoke: vi.fn(), label: "main", listeners: new Map<string, (event: { payload: string }) => void>(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: bridge.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async (name, handler) => {
  bridge.listeners.set(name, handler); return () => bridge.listeners.delete(name);
}) }));
vi.mock("../services/tauriRuntime", () => ({ hasTauriWindowRuntime: () => true, getCurrentTauriWindowLabel: () => bridge.label }));

let windows: Record<string, SavedWorkWindow>;
/** Mirrors `apply_frontend_patch` in src-tauri/src/work_state.rs. */
function applyPatch(frontend: SavedWorkWindow["frontend"], patch: WindowFrontendPatch): SavedWorkWindow["frontend"] {
  const next = (patch.replace ?? frontend ?? {}) as unknown as Record<string, unknown>;
  Object.assign(next, patch.set);
  for (const [field, changes] of Object.entries(patch.maps)) {
    const map = (next[field] ??= {}) as Record<string, unknown>;
    for (const [key, value] of Object.entries(changes ?? {})) {
      if (value === null) { delete map[key]; continue; }
      const { textDelta, ...entry } = value as Record<string, unknown> & {
        textDelta?: { baseRevision: number; revision: number; from: number; to: number; insert: string };
      };
      if (textDelta) {
        const previous = map[key] as { text: string; textRevision?: number };
        if (previous.textRevision !== textDelta.baseRevision) throw new Error("text delta base mismatch");
        entry.text = applyTextDelta(previous.text, textDelta);
        entry.textRevision = textDelta.revision;
      }
      map[key] = entry;
    }
  }
  return next as unknown as SavedWorkWindow["frontend"];
}
function record(label: string, ownerLabel = label): SavedWorkWindow {
  return { label, ownerLabel, visible: true, maximized: false, alwaysOnTop: false,
    frontend: { version: 1, layouts: {}, editors: {}, activeWorkspaceId: null } };
}
function layout(windowId: string): WorkbenchWindowState {
  return { schemaVersion: 1, windowId, sidebar: { width: 327, collapsed: true },
    layout: { kind: "split", splitId: "split", orientation: "horizontal", ratio: .65,
      first: { kind: "group", paneId: "left" }, second: { kind: "group", paneId: "right" } },
    groups: { left: { paneId: "left", tabs: [], activeEditorId: null }, right: { paneId: "right", tabs: [], activeEditorId: null } },
    focusedPaneId: "right" };
}

beforeEach(() => {
  vi.resetModules(); vi.useFakeTimers(); localStorage.clear(); bridge.invoke.mockReset(); bridge.listeners.clear(); bridge.label = "main";
  windows = { main: record("main") };
  bridge.invoke.mockImplementation(async (command: string, args?: { label: string; patch: WindowFrontendPatch }) => {
    if (command === "load_desktop_work_state") return JSON.parse(JSON.stringify({ schemaVersion: 1, windows, legacyAuxImportPending: false }));
    if (command === "save_window_work_state_patch" && args) {
      windows[args.label] ??= { ...record(args.label, bridge.label), frontend: null };
      windows[args.label]!.frontend = applyPatch(windows[args.label]!.frontend, JSON.parse(JSON.stringify(args.patch)));
    }
  });
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe("durable desktop work state", () => {
  it("keeps the last window sidebar geometry when startup first loads the older unscoped layout", async () => {
    const old = layout("main"); old.sidebar.width = 300;
    const active = layout("main"); active.sidebar.width = 410;
    windows.main!.frontend = { version: 1, activeWorkspaceId: "checkout-a", sidebar: active.sidebar,
      layouts: { "": old, "checkout-a": active }, editors: {} };
    const service = await import("../services/workState");
    await service.initializeWorkState("main");
    const { createPinia, setActivePinia } = await import("pinia");
    const { useWorkbenchStore } = await import("../stores/workbench");
    setActivePinia(createPinia());
    const store = useWorkbenchStore();
    store.ensureWindow("main");
    expect(store.switchWorkspaceScope("main", "checkout-a").sidebar.width).toBe(410);
    expect(store.switchWorkspaceScope("main", "checkout-b").sidebar.width).toBe(410);
  });
  it("round trips window identity, scoped layouts, active page and dirty editor buffers through a fresh renderer", async () => {
    let service = await import("../services/workState");
    await service.initializeWorkState("main");
    service.recordWorkbenchLayout("main", "checkout-a", layout("main"));
    service.recordActivePage("settings");
    service.registerWorkStateProvider("main", () => service.updateWindowWorkState("main", { editors: {
      text: { kind: "workspaceFile", text: "unsaved", contentHash: "disk-v1", originalLineEnding: "\r\n", dirty: true,
        selection: { anchor: 2, head: 5 }, scrollTop: 160 },
      chat: { kind: "session", composerDraft: { text: "pending input", images: [{ path: "image.png" }] } },
    } }));
    await service.flushWorkState();
    const expected = JSON.parse(JSON.stringify(windows.main!.frontend));
    localStorage.clear(); vi.resetModules();
    service = await import("../services/workState");
    await service.initializeWorkState("main");
    expect(service.savedWindowState("main")).toEqual(expected);
    expect(JSON.parse(localStorage.getItem("locus:workbench-window:main:workspace:checkout-a")!)).toEqual(layout("main"));
    expect(localStorage.getItem("locus:activePage:v1")).toBe("settings");
  });

  it("hydrates and restores only the requesting renderer's floating windows", async () => {
    windows["workspace-app-a"] = record("workspace-app-a");
    windows["workbench-a"] = record("workbench-a", "workspace-app-a");
    windows["workbench-main"] = record("workbench-main", "main");
    windows["workbench-a"]!.frontend!.layouts[""] = layout("workbench-a");
    bridge.label = "workspace-app-a";
    const service = await import("../services/workState");
    await service.initializeWorkState(bridge.label);
    expect(service.restoredAuxWindows().map(window => window.label)).toEqual(["workbench-a"]);
    expect(service.savedWindowState("main")).toBeNull();
    expect(service.savedWindowState("workbench-main")).toBeNull();
    expect(localStorage.getItem("locus:workbench-window:workbench-a")).not.toBeNull();
  });

  it("imports main legacy layouts without reopening historical windows or replacing other checkout layouts", async () => {
    windows.main!.frontend = null;
    localStorage.setItem("locus:workbench-window:main:workspace:checkout%2Fa", JSON.stringify(layout("main")));
    localStorage.setItem("locus:workbench-window:main:workspace:bad", "broken");
    localStorage.setItem("locus:workbench-window:workspace-app-a", JSON.stringify(layout("workspace-app-a")));
    localStorage.setItem("locus:workbench-window:workbench-closed", JSON.stringify(layout("workbench-closed")));
    const service = await import("../services/workState");
    await service.initializeWorkState("main");
    service.recordWorkbenchLayout("main", "checkout-b", layout("main"));
    service.recordWorkbenchLayout("workspace-app-a", "checkout-a", layout("workspace-app-a"));
    await service.flushWorkState();
    expect(Object.keys(windows.main!.frontend!.layouts)).toEqual(["checkout/a", "checkout-b"]);
    expect(Object.keys(windows)).toEqual(["main"]);
    expect(service.savedWindowState("workspace-app-a")).toBeNull();
    expect(service.restoredAuxWindows()).toEqual([]);
    expect(bridge.invoke).not.toHaveBeenCalledWith("save_window_work_state_patch", expect.objectContaining({ label: "workspace-app-a" }));
    // Historical layouts remain available as cached data, not an open-window list.
    expect(localStorage.getItem("locus:workbench-window:workspace-app-a")).not.toBeNull();
  });

  it("excludes prewarmed windows until claimed and forgets closed windows before a queued write", async () => {
    const service = await import("../services/workState");
    await service.initializeWorkState("main");
    service.recordWorkbenchLayout("workbench-shared-pool-hidden", null, layout("workbench-shared-pool-hidden"));
    await service.flushWorkState();
    expect(windows["workbench-shared-pool-hidden"]).toBeUndefined();
    service.ensureWorkWindow("workbench-claimed");
    service.recordWorkbenchLayout("workbench-claimed", null, layout("workbench-claimed"));
    await service.flushWorkState();
    expect(windows["workbench-claimed"]?.ownerLabel).toBe("main");
    bridge.invoke.mockClear();
    service.updateWindowWorkState("workbench-claimed", { activePage: "settings" });
    service.forgetWorkWindow("workbench-claimed");
    await service.flushWorkState();
    expect(bridge.invoke).not.toHaveBeenCalledWith("save_window_work_state_patch", expect.objectContaining({ label: "workbench-claimed" }));
  });

  it("captures the final edit before acknowledging app exit and stops scheduling background writes", async () => {
    const service = await import("../services/workState");
    await service.initializeWorkState("main");
    service.registerWorkStateProvider("main", () => service.updateWindowWorkState("main", { activePage: "plugins" }));
    bridge.listeners.get("locus-work-state-save-requested")!({ payload: "exit-token" });
    await service.flushWorkState();
    await Promise.resolve();
    expect(service.isWorkStateExiting()).toBe(true);
    const calls = bridge.invoke.mock.calls.map(call => call[0]);
    expect(calls.indexOf("save_window_work_state_patch")).toBeLessThan(calls.indexOf("acknowledge_work_state_save"));
    expect(windows.main!.frontend!.activePage).toBe("plugins");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("sends only the changed editor entries and fields", async () => {
    const service = await import("../services/workState");
    await service.initializeWorkState("main");
    const big = "x".repeat(100_000);
    service.updateWindowWorkState("main", { editors: {
      a: { kind: "workspaceFile", dirty: true, text: big, contentHash: "h", originalLineEnding: "\n", scrollTop: 1 },
      b: { kind: "session" },
    } });
    await service.flushWorkState();
    bridge.invoke.mockClear();
    service.updateWindowWorkState("main", { editors: {
      a: { kind: "workspaceFile", dirty: true, text: big, contentHash: "h", originalLineEnding: "\n", scrollTop: 2 },
    }, activePage: "settings" });
    await service.flushWorkState();
    const patch = bridge.invoke.mock.calls.find(call => call[0] === "save_window_work_state_patch")![1].patch as WindowFrontendPatch;
    expect(patch.set).toEqual({ activePage: "settings" });
    expect(Object.keys(patch.maps.editors!)).toEqual(["b", "a"]);
    expect(patch.maps.editors!.b).toBeNull();
    // The backend already holds the unchanged 100 KB buffer.
    expect(patch.maps.editors!.a).toEqual(expect.objectContaining({ scrollTop: 2, textDelta: expect.objectContaining({ insert: "" }) }));
    expect(patch.maps.editors!.a).not.toHaveProperty("text");
    expect(windows.main!.frontend!.editors).toEqual({ a: expect.objectContaining({ scrollTop: 2, text: big }) });
    bridge.invoke.mockClear();
    service.updateWindowWorkState("main", { editors: {
      a: { kind: "workspaceFile", dirty: true, text: `${big}typed`, contentHash: "h", originalLineEnding: "\n", scrollTop: 2 },
    } });
    await service.flushWorkState();
    const typed = bridge.invoke.mock.calls.find(call => call[0] === "save_window_work_state_patch")![1].patch as WindowFrontendPatch;
    expect((typed.maps.editors!.a as { textDelta: { insert: string } }).textDelta.insert).toBe("typed");
    expect((windows.main!.frontend!.editors.a as { text: string }).text).toBe(`${big}typed`);
  });

  it("waits longer after scrolling than after edits", async () => {
    const service = await import("../services/workState");
    await service.initializeWorkState("main");
    await service.flushWorkState();
    bridge.invoke.mockClear();
    service.registerWorkStateProvider("main", () => service.updateWindowWorkState("main", { activePage: `p${Date.now()}` }));
    document.dispatchEvent(new Event("scroll"));
    await vi.advanceTimersByTimeAsync(500);
    expect(bridge.invoke).not.toHaveBeenCalled();
    document.dispatchEvent(new Event("input"));
    await vi.advanceTimersByTimeAsync(450);
    expect(bridge.invoke).toHaveBeenCalledWith("save_window_work_state_patch", expect.anything());
  });

  it("does not continuously reschedule unchanged snapshots and retries a failed durable write", async () => {
    const service = await import("../services/workState");
    await service.initializeWorkState("main");
    service.registerWorkStateProvider("main", () => service.recordWorkbenchLayout("main", "checkout-a", layout("main")));
    await service.flushWorkState();
    await vi.advanceTimersByTimeAsync(800);
    expect(vi.getTimerCount()).toBe(0);
    service.recordActivePage("settings");
    bridge.invoke.mockRejectedValueOnce(new Error("disk full"));
    await expect(service.flushWorkState()).rejects.toThrow("disk full");
    await service.flushWorkState();
    expect(windows.main!.frontend!.activePage).toBe("settings");
  });
});
