// @vitest-environment jsdom
import { createApp, nextTick, ref, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDocumentRecovery } from "../composables/useDocumentRecovery";
import { applyTextDelta, textHash } from "../document/textDelta";
import type { RecoveryUpdate } from "../services/documentRecovery";

const mocks = vi.hoisted(() => ({ read: vi.fn(), update: vi.fn() }));
vi.mock("../services/documentRecovery", () => ({ readDocumentRecovery: mocks.read, updateDocumentRecovery: mocks.update }));
vi.mock("../services/tauriRuntime", () => ({ hasTauriWindowRuntime: () => true }));
let app: App | null = null;
let backendHead: string | null = null;
const record = (overrides: object = {}) => ({ schemaVersion: 2, head: textHash("base"), draft: null, snapshots: [], ...overrides });
async function flush() { for (let i = 0; i < 8; i++) { await Promise.resolve(); await nextTick(); } }
async function mount() {
  const key = ref("a"); const base = ref("base"); const text = ref("base"); const enabled = ref(true);
  let recovery!: ReturnType<typeof useDocumentRecovery>;
  app = createApp({ setup() {
    recovery = useDocumentRecovery({ key: () => key.value, base: () => base.value, text: () => text.value, enabled: () => enabled.value, apply: value => { text.value = value; } });
    return () => null;
  } });
  app.mount(document.createElement("div")); await flush();
  return { key, base, text, enabled, recovery };
}
const requests = () => mocks.update.mock.calls.map(call => call[0] as RecoveryUpdate);
const lastRequest = () => requests()[requests().length - 1]!;
beforeEach(() => {
  vi.useFakeTimers();
  backendHead = textHash("base");
  mocks.read.mockImplementation(async () => record());
  mocks.update.mockImplementation(async (request: RecoveryUpdate) => {
    if (request.head && (request.head.text !== undefined || request.head.base === backendHead)) backendHead = request.head.hash;
    return { head: backendHead, headAccepted: true, draftAccepted: true };
  });
});
afterEach(async () => { app?.unmount(); await flush(); mocks.read.mockReset(); mocks.update.mockReset(); vi.useRealTimers(); });
describe("shared durable document recovery", () => {
  it("writes nothing when an unchanged document is opened", async () => {
    await mount(); await vi.advanceTimersByTimeAsync(1000);
    expect(mocks.update).not.toHaveBeenCalled();
  });
  it("records a changed disk version as a checkpoint", async () => {
    mocks.read.mockResolvedValue(record({ head: textHash("older") }));
    await mount();
    expect(requests()[0]).toEqual({ key: "a", head: { hash: textHash("base"), text: "base", checkpoint: true }, draft: null });
  });
  it("offers a recovered draft without overwriting the current disk contents", async () => {
    mocks.read.mockResolvedValue(record({ draft: { text: "base unsaved", at: 1 } }));
    const { recovery, text } = await mount();
    expect(recovery.pending.value?.text).toBe("base unsaved");
    expect(text.value).toBe("base");
    expect(mocks.update).not.toHaveBeenCalled();
    recovery.restore(recovery.pending.value!); await flush(); await vi.advanceTimersByTimeAsync(301);
    expect(text.value).toBe("base unsaved");
    // The backend already stores exactly this draft.
    expect(mocks.update).not.toHaveBeenCalled();
    text.value = "base unsaved!"; recovery.changed(); await vi.advanceTimersByTimeAsync(301);
    const draft = lastRequest().draft!;
    expect(draft.base).toBe(textHash("base"));
    expect(draft.text).toBeUndefined();
    expect(applyTextDelta("base", draft.delta!)).toBe("base unsaved!");
  });
  it("sends only deltas for drafts and for the acknowledged save", async () => {
    const { recovery, text, base } = await mount();
    text.value = "base and typing"; recovery.changed(); await vi.advanceTimersByTimeAsync(301);
    expect(requests()[0]!.draft).toEqual({ hash: textHash("base and typing"), base: textHash("base"), delta: { from: 4, to: 4, insert: " and typing" } });
    text.value = "base saved and continued"; recovery.changed();
    base.value = "base saved"; await flush();
    const save = lastRequest();
    expect(save.head!.base).toBe(textHash("base"));
    expect(applyTextDelta("base", save.head!.delta!)).toBe("base saved");
    expect(save.draft).toEqual({ hash: textHash("base saved and continued"), base: textHash("base saved"), delta: { from: 10, to: 10, insert: " and continued" } });
    await vi.advanceTimersByTimeAsync(301);
    expect(mocks.update).toHaveBeenCalledTimes(2);
  });
  it("resends full text when another view moved the head", async () => {
    const { recovery, text } = await mount();
    mocks.update.mockResolvedValueOnce({ head: textHash("other view"), headAccepted: true, draftAccepted: false });
    text.value = "base!"; recovery.changed(); await vi.advanceTimersByTimeAsync(301);
    expect(requests()[1]).toEqual({ key: "a", draft: { hash: textHash("base!"), text: "base!" } });
  });
  it("flushes the previous document before switching to a read-only document", async () => {
    const { recovery, text, key, enabled } = await mount();
    text.value = "base unsaved a"; recovery.changed();
    key.value = "b"; enabled.value = false; text.value = "b";
    await flush();
    const request = requests()[0]!;
    expect(request.key).toBe("a");
    expect(applyTextDelta("base", request.draft!.delta!)).toBe("base unsaved a");
  });
  it("keeps a failed recovery read visible and does not overwrite the backup", async () => {
    mocks.read.mockRejectedValue(new Error("corrupt backup"));
    const { recovery, text } = await mount();
    text.value = "new"; recovery.changed(); await vi.advanceTimersByTimeAsync(1000);
    expect(recovery.error.value).toContain("corrupt backup");
    expect(mocks.update).not.toHaveBeenCalled();
  });
});
