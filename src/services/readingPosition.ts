import { ipcInvoke } from "./ipc";
import { hasTauriWindowRuntime } from "./tauriRuntime";
import { registerWorkStateFlushHook } from "./workState";
import { isReadingAnchor, type ReadingAnchor } from "../document/readingAnchor";

/**
 * Durable per-document reading positions. The backend scopes `checkoutId` to
 * its project, so every worktree of a project shares one position.
 */
export interface ReadingTarget {
  checkoutId?: string | null;
  resource: string[];
}

interface StoredPosition {
  line: number;
  column: number;
  lineHash?: string;
  offset: number;
  before?: number;
}

const FLUSH_DELAY_MS = 500;
const cache = new Map<string, ReadingAnchor | null>();
const pending = new Map<string, { target: ReadingTarget; anchor: ReadingAnchor | null }>();
const captures = new Set<() => void>();
let batch: { target: ReadingTarget; key: string; resolve: (anchor: ReadingAnchor | null) => void }[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let flushing: Promise<void> = Promise.resolve();

export function readingTargetKey(target: ReadingTarget): string {
  return JSON.stringify([target.checkoutId ?? null, ...target.resource]);
}

function toStored(anchor: ReadingAnchor): StoredPosition {
  return "before" in anchor
    ? { line: 0, column: 0, offset: 0, before: anchor.before }
    : { line: anchor.line, column: anchor.column, lineHash: anchor.lineHash, offset: anchor.offset };
}

function fromStored(position: StoredPosition | null | undefined): ReadingAnchor | null {
  if (!position) return null;
  const anchor: unknown = typeof position.before === "number"
    ? { before: position.before }
    : { line: position.line, column: position.column, lineHash: position.lineHash ?? "", offset: position.offset ?? 0 };
  return isReadingAnchor(anchor) ? anchor : null;
}

function sameAnchor(left: ReadingAnchor | null | undefined, right: ReadingAnchor | null): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right);
}

async function runBatch(): Promise<void> {
  const requests = batch;
  batch = [];
  try {
    const positions = await ipcInvoke<(StoredPosition | null)[]>("reading_position_get", {
      targets: requests.map(({ target }) => ({ checkoutId: target.checkoutId ?? null, resource: target.resource })),
    });
    requests.forEach((request, index) => {
      const anchor = pending.get(request.key)?.anchor ?? fromStored(positions[index]);
      cache.set(request.key, anchor);
      request.resolve(anchor);
    });
  } catch (error) {
    console.warn("[reading-position] read failed", error);
    for (const request of requests) request.resolve(null);
  }
}

/** Requests in the same task are sent as one IPC call. */
export function getReadingPosition(target: ReadingTarget): Promise<ReadingAnchor | null> {
  if (!hasTauriWindowRuntime()) return Promise.resolve(null);
  const key = readingTargetKey(target);
  if (pending.has(key)) return Promise.resolve(pending.get(key)!.anchor);
  if (cache.has(key)) return Promise.resolve(cache.get(key)!);
  return new Promise((resolve) => {
    if (!batch.length) queueMicrotask(() => { void runBatch(); });
    batch.push({ target, key, resolve });
  });
}

/** Records a position; null removes it (the document is read from the top). */
export function putReadingPosition(target: ReadingTarget, anchor: ReadingAnchor | null): void {
  if (!hasTauriWindowRuntime()) return;
  const key = readingTargetKey(target);
  const known = pending.has(key) ? pending.get(key)!.anchor : cache.get(key);
  if ((pending.has(key) || cache.has(key)) && sameAnchor(known, anchor)) return;
  cache.set(key, anchor);
  pending.set(key, { target, anchor });
  if (timer === null) timer = setTimeout(() => { void flushReadingPositions(); }, FLUSH_DELAY_MS);
}

export function flushReadingPositions(): Promise<void> {
  if (timer !== null) clearTimeout(timer);
  timer = null;
  const updates = [...pending.values()];
  pending.clear();
  if (!updates.length) return flushing;
  flushing = flushing.catch(() => {}).then(async () => {
    await ipcInvoke("reading_position_put", {
      updates: updates.map(({ target, anchor }) => ({
        target: { checkoutId: target.checkoutId ?? null, resource: target.resource },
        position: anchor ? toStored(anchor) : null,
      })),
    });
  }).catch((error) => { console.warn("[reading-position] save failed", error); });
  return flushing;
}

/** Editors register a capture so the final position is saved on app exit. */
export function registerReadingPositionCapture(capture: () => void): () => void {
  captures.add(capture);
  return () => { captures.delete(capture); };
}

registerWorkStateFlushHook(async (exiting) => {
  if (exiting) for (const capture of captures) {
    try { capture(); } catch (error) { console.warn("[reading-position] capture failed", error); }
  }
  await flushReadingPositions();
});
