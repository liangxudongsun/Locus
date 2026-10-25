// @vitest-environment jsdom
import { Text } from "@codemirror/state";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveReadingAnchor } from "../document/readingAnchor";
import { textHash } from "../document/textDelta";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), hooks: [] as ((exiting: boolean) => Promise<void> | void)[] }));
vi.mock("../services/ipc", () => ({ ipcInvoke: mocks.invoke }));
vi.mock("../services/tauriRuntime", () => ({ hasTauriWindowRuntime: () => true }));
vi.mock("../services/workState", () => ({ registerWorkStateFlushHook: (hook: (exiting: boolean) => void) => { mocks.hooks.push(hook); return () => {}; } }));

const doc = (lines: string[]) => Text.of(lines);

describe("reading anchors", () => {
  it("relocates by line text after lines were inserted above", () => {
    const anchor = { line: 3, column: 4, lineHash: textHash("## Target heading"), offset: 6 };
    const moved = doc(["intro", "new line", "new line 2", "other", "## Target heading", "tail"]);
    expect(resolveReadingAnchor(moved, anchor)).toBe(moved.line(5).from + 4);
  });
  it("falls back to the saved line and clamps the column", () => {
    const anchor = { line: 9, column: 99, lineHash: textHash("gone"), offset: 0 };
    const shorter = doc(["a", "bb", "ccc"]);
    expect(resolveReadingAnchor(shorter, anchor)).toBe(shorter.line(3).to);
  });
  it("keeps positions above the body out of the document", () => {
    expect(resolveReadingAnchor(doc(["x"]), { before: 120 })).toBeNull();
  });
});

describe("reading position service", () => {
  beforeEach(() => { vi.resetModules(); vi.useFakeTimers(); mocks.invoke.mockReset(); mocks.hooks.length = 0; });
  afterEach(() => { vi.useRealTimers(); });

  it("reads concurrent requests in one call and caches them", async () => {
    mocks.invoke.mockResolvedValue([{ line: 4, column: 1, lineHash: "h", offset: 2 }, null]);
    const service = await import("../services/readingPosition");
    const [a, b] = await Promise.all([
      service.getReadingPosition({ checkoutId: "c", resource: ["file", "a.md"] }),
      service.getReadingPosition({ checkoutId: "c", resource: ["file", "b.md"] }),
    ]);
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    expect(a).toEqual({ line: 4, column: 1, lineHash: "h", offset: 2 });
    expect(b).toBeNull();
    await service.getReadingPosition({ checkoutId: "c", resource: ["file", "a.md"] });
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
  });

  it("sends only changed positions, batched, and flushes before exit", async () => {
    mocks.invoke.mockResolvedValue(undefined);
    const service = await import("../services/readingPosition");
    const target = { checkoutId: null, resource: ["file", "c:/notes.md"] };
    service.putReadingPosition(target, { line: 10, column: 0, lineHash: "x", offset: 0 });
    service.putReadingPosition(target, { line: 12, column: 0, lineHash: "y", offset: 3 });
    await vi.advanceTimersByTimeAsync(600);
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    expect(mocks.invoke.mock.calls[0]![1]).toEqual({ updates: [{ target: { checkoutId: null, resource: target.resource },
      position: { line: 12, column: 0, lineHash: "y", offset: 3 } }] });
    service.putReadingPosition(target, { line: 12, column: 0, lineHash: "y", offset: 3 });
    await vi.advanceTimersByTimeAsync(600);
    expect(mocks.invoke).toHaveBeenCalledTimes(1);

    const capture = vi.fn(() => service.putReadingPosition(target, null));
    service.registerReadingPositionCapture(capture);
    await mocks.hooks[0]!(true);
    expect(capture).toHaveBeenCalled();
    expect(mocks.invoke).toHaveBeenLastCalledWith("reading_position_put", { updates: [{ target: { checkoutId: null, resource: target.resource }, position: null }] });
  });
});
