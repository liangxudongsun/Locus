import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ listen: vi.fn(), invoke: vi.fn(), order: [] as string[] }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("../services/tauriRuntime", () => ({
  hasTauriWindowRuntime: () => true,
  getCurrentTauriWindowLabel: () => "workspace-app-owner",
}));

beforeEach(() => {
  vi.resetModules();
  mocks.order.length = 0;
  mocks.listen.mockReset().mockImplementation(async (name: string) => {
    mocks.order.push(`listen:${name}`);
    return vi.fn();
  });
  mocks.invoke.mockReset().mockImplementation(async (command: string) => { mocks.order.push(command); });
});

describe("workspace interest transport integration", () => {
  it("installs both channels before acknowledging interest and releases the final owner", async () => {
    const hub = await import("../services/workspaceEventHub");
    const { flushWindowEventInterests } = await import("../services/windowEventInterests");
    const interest = { sessionId: "session-shared" };
    const first = await hub.listenWorkspaceEvent("main-pane", vi.fn(), { interests: [interest] });
    const floating = await hub.listenWorkspaceEvent("teleported-pane", vi.fn(), { interests: [interest] });
    expect(mocks.order.slice(0, 3)).toEqual([
      "listen:locus://workspace-event",
      "listen:locus://workspace-event/workspace-app-owner",
      "set_workspace_event_interests",
    ]);
    expect(hub.snapshotWorkspaceEvents().nativeListenerCount).toBe(2);
    first();
    await flushWindowEventInterests();
    expect(mocks.invoke).toHaveBeenLastCalledWith("set_workspace_event_interests", {
      interests: { sessions: ["session-shared"], checkouts: [], streamCheckouts: [] },
    });
    floating();
    await flushWindowEventInterests();
    expect(mocks.invoke).toHaveBeenLastCalledWith("set_workspace_event_interests", {
      interests: { sessions: [], checkouts: [], streamCheckouts: [] },
    });
    hub.resetWorkspaceEventHubForTests();
  });

  it("an aborted consumer cannot leave a checkout interest behind while channels are registering", async () => {
    let finish!: (release: () => void) => void;
    mocks.listen.mockImplementationOnce(() => new Promise<() => void>(resolve => { finish = resolve; }));
    const hub = await import("../services/workspaceEventHub");
    const { flushWindowEventInterests } = await import("../services/windowEventInterests");
    const controller = new AbortController();
    const pending = hub.listenWorkspaceEvent("closing-preview", vi.fn(), {
      signal: controller.signal,
      interests: [{ workspaceRef: { checkoutId: "a", expectedGeneration: 1 } }],
    });
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    controller.abort();
    finish(vi.fn());
    const release = await pending;
    release();
    await flushWindowEventInterests();
    expect(mocks.invoke).toHaveBeenLastCalledWith("set_workspace_event_interests", {
      interests: { sessions: [], checkouts: [], streamCheckouts: [] },
    });
    expect(hub.snapshotWorkspaceEvents().subscribers).toEqual([]);
    hub.resetWorkspaceEventHubForTests();
  });
});
