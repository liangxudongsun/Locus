import { describe, expect, it, vi } from "vitest";
import { createWindowEventInterests, type WindowEventInterests } from "../services/windowEventInterests";

const scope = { checkoutId: "checkout-a", expectedGeneration: 7, expectedMaterializationEpoch: 2 };

describe("window event interests", () => {
  it("unions shared panes and only removes a session after its last owner releases it", async () => {
    const send = vi.fn(async (_snapshot: WindowEventInterests) => {});
    const registry = createWindowEventInterests(send);
    const main = registry.retain({ sessionId: "session-a" });
    const floating = registry.retain({ sessionId: "session-a" });
    const preview = registry.retain({ workspaceRef: scope });
    await registry.flush();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenLastCalledWith({ sessions: ["session-a"], checkouts: [scope], streamCheckouts: [] });
    main();
    await registry.flush();
    expect(registry.snapshot().sessions).toEqual(["session-a"]);
    floating(); preview(); preview();
    await registry.flush();
    expect(send).toHaveBeenLastCalledWith({ sessions: [], checkouts: [], streamCheckouts: [] });
  });

  it("serializes updates and flush waits for the latest interest, not just the in-flight snapshot", async () => {
    let acknowledge!: () => void;
    const send = vi.fn((_snapshot: WindowEventInterests) => new Promise<void>(resolve => { acknowledge = resolve; }));
    const registry = createWindowEventInterests(send);
    const release = registry.retain({ streamWorkspaceRef: scope });
    const ready = registry.flush();
    expect(send).toHaveBeenCalledTimes(1);
    registry.retain({ sessionId: "new-session" });
    release();
    let completed = false;
    void ready.then(() => { completed = true; });
    acknowledge();
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(completed).toBe(false);
    expect(send).toHaveBeenLastCalledWith({ sessions: ["new-session"], checkouts: [], streamCheckouts: [] });
    acknowledge();
    await ready;
    expect(completed).toBe(true);
  });

  it("coalesces a pane reparent without an empty subscription in between", async () => {
    const send = vi.fn(async (_snapshot: WindowEventInterests) => {});
    const registry = createWindowEventInterests(send);
    const release = registry.retain({ sessionId: "moving" });
    await registry.flush();
    release();
    registry.retain({ sessionId: "moving" });
    await registry.flush();
    expect(send.mock.calls.every(([value]) => value.sessions.includes("moving"))).toBe(true);
  });

  it("does not leak interests between independent renderer registries or unclaimed pools", async () => {
    const first = createWindowEventInterests(async () => {});
    const secondSend = vi.fn(async () => {});
    const second = createWindowEventInterests(secondSend);
    first.retain({ sessionId: "only-first" });
    await first.flush(); await second.flush();
    expect(second.snapshot()).toEqual({ sessions: [], checkouts: [], streamCheckouts: [] });
    expect(secondSend).toHaveBeenCalledExactlyOnceWith({ sessions: [], checkouts: [], streamCheckouts: [] });
  });

  it("keeps generation and materialization identities in checkout interests", async () => {
    const registry = createWindowEventInterests(async () => {});
    registry.retain({ workspaceRef: scope });
    registry.retain({ workspaceRef: { ...scope, expectedMaterializationEpoch: 3 } });
    await registry.flush();
    expect(registry.snapshot().checkouts).toHaveLength(2);
  });

  it("never rejects a caller when registration fails and keeps retrying in the background", async () => {
    vi.useFakeTimers();
    try {
      let failures = 5;
      const send = vi.fn(async (_snapshot: WindowEventInterests) => {
        if (failures > 0) { failures -= 1; throw new Error("ipc unavailable"); }
      });
      const warn = vi.fn();
      const registry = createWindowEventInterests(send, { retryDelaysMs: [1, 1], backgroundRetryMs: [100, 100], warn });
      registry.retain({ sessionId: "launching" });
      // The microtask flush makes three quick attempts, then gives up without throwing.
      await vi.advanceTimersByTimeAsync(10);
      expect(send).toHaveBeenCalledTimes(3);
      expect(warn).toHaveBeenCalledTimes(1);
      // A launch awaiting the registration proceeds.
      const launch = registry.flush();
      await vi.advanceTimersByTimeAsync(10);
      await expect(launch).resolves.toBeUndefined();
      // Background retries continue until the backend accepts the snapshot.
      failures = 0;
      await vi.advanceTimersByTimeAsync(250);
      expect(send).toHaveBeenLastCalledWith({ sessions: ["launching"], checkouts: [], streamCheckouts: [] });
      const calls = send.mock.calls.length;
      await registry.flush();
      await vi.advanceTimersByTimeAsync(1000);
      expect(send).toHaveBeenCalledTimes(calls);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not resend an unchanged interest set", async () => {
    const send = vi.fn(async (_snapshot: WindowEventInterests) => {});
    const registry = createWindowEventInterests(send);
    const first = registry.retain({ sessionId: "a" });
    await registry.flush();
    registry.retain({ sessionId: "b" })();
    await registry.flush();
    first();
    registry.retain({ sessionId: "a" });
    await registry.flush();
    expect(send).toHaveBeenCalledTimes(1);
    registry.retain({ workspaceRef: scope });
    await registry.flush();
    expect(send).toHaveBeenCalledTimes(2);
  });
});
