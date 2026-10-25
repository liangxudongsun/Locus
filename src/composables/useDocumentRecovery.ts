import { onBeforeUnmount, ref, shallowRef, watch } from "vue";
import { hasTauriWindowRuntime } from "../services/tauriRuntime";
import {
  readDocumentRecovery,
  updateDocumentRecovery,
  type DocumentSnapshot,
  type RecoveryUpdate,
  type RecoveryVersion,
} from "../services/documentRecovery";
import { singleSpanDelta, textHash } from "../document/textDelta";

/** What the backend holds for one document key, as far as this view knows. */
interface RecoveryState {
  /** Hash of the backend head version. */
  head: string | null;
  /** Text of the backend head, when this view knows it; enables deltas. */
  headText: string | null;
  /** Hash of the stored draft; null when none is stored. */
  draftHash: string | null;
}

interface RecoveryOperation {
  key: string;
  head?: { text: string; checkpoint: boolean };
  draft?: string;
}

function version(text: string, hash: string, base: { text: string | null; hash: string | null }, checkpoint?: boolean): RecoveryVersion {
  if (base.text !== null && base.hash) {
    const delta = singleSpanDelta(base.text, text);
    // A delta that replaces most of the text is no cheaper than the text itself.
    if (delta && delta.insert.length < text.length) {
      return { hash, base: base.hash, delta, ...(checkpoint ? { checkpoint } : {}) };
    }
  }
  return { hash, text, ...(checkpoint ? { checkpoint } : {}) };
}

/**
 * Persist outside the workspace, without putting draft state into Markdown files.
 * Writes are deltas against the last acknowledged version: a keystroke pause
 * sends only the edited span, a save sends the saved span plus the draft.
 */
export function useDocumentRecovery(options: {
  key: () => string;
  base: () => string;
  text: () => string | { toString(): string };
  enabled: () => boolean;
  apply: (text: string) => void;
}) {
  const pending = shallowRef<DocumentSnapshot | null>(null);
  const snapshots = shallowRef<DocumentSnapshot[]>([]);
  const error = ref("");
  const historyOpen = ref(false);
  const states = new Map<string, RecoveryState>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let serial = Promise.resolve();
  let activeKey = "";
  let loaded = false;
  let disposed = false;
  let activeBase = "";
  let latestText: string | { toString(): string } = "";

  async function send(operation: RecoveryOperation): Promise<void> {
    const state = states.get(operation.key) ?? { head: null, headText: null, draftHash: null };
    const headHash = operation.head ? textHash(operation.head.text) : null;
    const draftHash = operation.draft === undefined ? null : textHash(operation.draft);
    const nextHead = headHash ?? state.head;
    const nextHeadText = operation.head ? operation.head.text : state.headText;
    const request: RecoveryUpdate = { key: operation.key };
    const headChanged = !!operation.head && headHash !== state.head;
    if (operation.head && headChanged) {
      request.head = version(operation.head.text, headHash!, { text: state.headText, hash: state.head }, operation.head.checkpoint);
    }
    if (operation.draft !== undefined) {
      const stored = draftHash === nextHead ? null : draftHash;
      if (headChanged || stored !== state.draftHash) {
        request.draft = stored === null ? null : version(operation.draft, draftHash!, { text: nextHeadText, hash: nextHead });
      }
    }
    if (!request.head && request.draft === undefined) return;
    let result = await updateDocumentRecovery(request);
    if (!result.headAccepted || !result.draftAccepted) {
      // Another view moved the head; resend as full text.
      const retry: RecoveryUpdate = { key: operation.key };
      if (operation.head && headHash !== result.head) retry.head = { hash: headHash!, text: operation.head.text, ...(operation.head.checkpoint ? { checkpoint: true } : {}) };
      if (request.draft) retry.draft = { hash: draftHash!, text: operation.draft! };
      result = await updateDocumentRecovery(retry);
    }
    const previousHead = state.head;
    state.head = result.head;
    if (operation.head && result.head === headHash) state.headText = operation.head.text;
    else if (result.head !== previousHead) state.headText = null;
    if (operation.draft !== undefined) state.draftHash = draftHash === result.head ? null : draftHash;
    if (operation.key === activeKey) states.set(operation.key, state);
    else states.delete(operation.key);
  }

  function enqueue(operation: RecoveryOperation) {
    serial = serial.then(async () => {
      await send(operation);
      if (!disposed && activeKey === operation.key) error.value = "";
    }).catch(reason => { if (!disposed && activeKey === operation.key) error.value = `草稿备份失败：${String(reason)}`; });
  }
  function flush() {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    if (!loaded || !activeKey || pending.value) return;
    enqueue({ key: activeKey, draft: latestText.toString() });
  }
  function changed() {
    latestText = options.text();
    if (!loaded || !activeKey || pending.value) return;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(flush, 300);
  }
  watch(() => [options.key(), options.enabled()] as const, async ([key, enabled]) => {
    flush();
    activeKey = enabled && hasTauriWindowRuntime() ? key : "";
    loaded = false; pending.value = null; snapshots.value = []; historyOpen.value = false;
    activeBase = options.base(); latestText = options.text();
    if (!activeKey) return;
    const identity = activeKey;
    try {
      await serial;
      const record = await readDocumentRecovery(identity);
      if (disposed || activeKey !== identity) return;
      const base = options.base();
      const baseHash = textHash(base);
      states.set(identity, {
        head: record.head,
        headText: record.head === baseHash ? base : null,
        draftHash: record.draft ? textHash(record.draft.text) : null,
      });
      snapshots.value = record.snapshots;
      const current = options.text().toString();
      if (record.draft && record.draft.text !== base && record.draft.text !== current) pending.value = record.draft;
      loaded = true;
      if (pending.value) return;
      // Opening an unchanged document writes nothing.
      if (record.head !== baseHash) enqueue({ key: identity, head: { text: base, checkpoint: true }, draft: current });
      else if (record.draft) enqueue({ key: identity, draft: current });
      changed();
    } catch (reason) { if (activeKey === identity) error.value = `无法读取草稿：${String(reason)}`; }
  }, { immediate: true });
  watch(options.base, (base) => {
    activeBase = base;
    if (loaded && activeKey && !pending.value) {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      latestText = options.text();
      enqueue({ key: activeKey, head: { text: base, checkpoint: false }, draft: latestText.toString() });
    }
  });
  function restore(snapshot: DocumentSnapshot) {
    // Keep the current contents available before a deliberate restoration.
    if (activeKey && loaded) enqueue({ key: activeKey, head: { text: options.text().toString(), checkpoint: true } });
    pending.value = null; historyOpen.value = false;
    options.apply(snapshot.text); changed();
  }
  function dismiss() {
    pending.value = null;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    if (!loaded || !activeKey) return;
    latestText = options.text();
    enqueue({ key: activeKey, head: { text: activeBase, checkpoint: true }, draft: latestText.toString() });
  }
  async function openHistory() {
    if (!activeKey) return;
    const key = activeKey;
    try { await serial; const record = await readDocumentRecovery(key, true); if (activeKey === key && !disposed) { snapshots.value = record.snapshots; historyOpen.value = true; } }
    catch (reason) { error.value = String(reason); }
  }
  const beforeUnload = () => flush();
  window.addEventListener("pagehide", beforeUnload);
  onBeforeUnmount(() => { flush(); disposed = true; window.removeEventListener("pagehide", beforeUnload); });
  return { pending, snapshots, error, historyOpen, changed, flush, restore, dismiss, openHistory };
}
