import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EventCallback } from "@tauri-apps/api/event";

const mocks = vi.hoisted(() => ({ listen: vi.fn(), label: "workspace-app-a" as string | null }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));
vi.mock("../services/tauriRuntime", () => ({ getCurrentTauriWindowLabel: () => mocks.label }));
import { listenWindowEvent, windowEventName } from "../services/windowEventTransport";

describe("window-specific event channels", () => {
  beforeEach(() => { mocks.listen.mockReset(); mocks.label = "workspace-app-a"; });

  it("subscribes to the global and owning-window channels, never another window's channel", async () => {
    const listeners = new Map<string, EventCallback<string>>();
    const releases = [vi.fn(), vi.fn()];
    mocks.listen.mockImplementation(async (name: string, handler: EventCallback<string>) => {
      listeners.set(name, handler);
      return releases[listeners.size - 1];
    });
    const handler = vi.fn();
    const release = await listenWindowEvent("locus://workspace-event", handler);
    expect([...listeners.keys()]).toEqual(["locus://workspace-event", "locus://workspace-event/workspace-app-a"]);
    for (const channel of ["locus://workspace-event", windowEventName("locus://workspace-event", "workspace-app-a"), windowEventName("locus://workspace-event", "workspace-app-b")]) {
      listeners.get(channel)?.({ event: channel, id: 1, payload: "event" });
    }
    expect(handler).toHaveBeenCalledTimes(2);
    release();
    expect(releases[0]).toHaveBeenCalledOnce();
    expect(releases[1]).toHaveBeenCalledOnce();
  });

  it("cleans up the first listener when targeted registration fails", async () => {
    const releaseGlobal = vi.fn();
    mocks.listen.mockResolvedValueOnce(releaseGlobal).mockRejectedValueOnce(new Error("registration failed"));
    await expect(listenWindowEvent("stream-event", vi.fn())).rejects.toThrow("registration failed");
    expect(releaseGlobal).toHaveBeenCalledOnce();
  });
});
