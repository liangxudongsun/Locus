import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentTauriWindowLabel, hasTauriWindowRuntime } from "./tauriRuntime";
import type { WorkbenchEditorTransferSnapshot, WorkbenchWindowState } from "../types/workbench";
import { singleSpanDelta } from "../document/textDelta";

export interface WindowFrontendState {
  version: 1;
  activeWorkspaceId: string | null;
  activePage?: string;
  sidebar?: WorkbenchWindowState["sidebar"];
  layouts: Record<string, WorkbenchWindowState>;
  editors: Record<string, WorkbenchEditorTransferSnapshot>;
  navigation?: Record<string, {
    expanded: string[];
    secondary: { section: import("../components/workbench/workspaceSecondaryNavigation").WorkspaceSecondarySection;
      projectId: string; checkoutId: string; editorId?: string } | null;
  }>;
}

export interface SavedWorkWindow {
  label: string;
  ownerLabel: string;
  bounds?: { x: number; y: number; width: number; height: number } | null;
  maximized: boolean;
  alwaysOnTop: boolean;
  visible: boolean;
  frontend: WindowFrontendState | null;
}

interface DesktopWorkState {
  schemaVersion: number;
  windows: Record<string, SavedWorkWindow>;
  focusedWindow?: string | null;
  legacyAuxImportPending: boolean;
}

const CAPTURE_DELAY_MS = 400;
const SCROLL_CAPTURE_DELAY_MS = 2000;

/** Frontend fields whose entries are compared and sent one by one. */
const MAP_FIELDS = ["editors", "layouts", "navigation"] as const;
type MapField = typeof MAP_FIELDS[number];
const isMapField = (field: string): field is MapField => (MAP_FIELDS as readonly string[]).includes(field);

/**
 * Only changed fields and map entries reach the backend. `replace` carries a
 * whole frontend once, when a window is new or its saved state was imported.
 */
export interface WindowFrontendPatch {
  replace?: WindowFrontendState;
  set: Record<string, unknown>;
  maps: Partial<Record<MapField, Record<string, unknown>>>;
}

const records = new Map<string, SavedWorkWindow>();
/** Windows that need a save call even without changes (registration, reveal). */
const dirty = new Set<string>();
const patches = new Map<string, WindowFrontendPatch>();
const providers = new Map<string, () => void | Promise<void>>();
const flushHooks = new Set<(exiting: boolean) => void | Promise<void>>();
let ownerLabel: string | null = null;
let initialized: Promise<void> | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let timerDueAt = 0;
let saving = Promise.resolve();
let exiting = false;
let legacyAuxImport = false;
let captureInstalled = false;

const layoutPrefix = (label: string) => `locus:workbench-window:${label}`;
const pageKey = (label: string) => label === "main" ? "locus:activePage:v1" : `locus:activePage:v1:${label}`;
const emptyFrontend = (): WindowFrontendState => ({ version: 1, activeWorkspaceId: null, layouts: {}, editors: {} });

export function savedWindowState(label: string): WindowFrontendState | null {
  return records.get(label)?.frontend ?? null;
}

/** Structural equality without serializing; large equal strings compare by reference first. */
export function sameWorkStateValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (typeof left !== "object" || typeof right !== "object" || !left || !right) return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  if (Array.isArray(left)) {
    const other = right as unknown[];
    return left.length === other.length && left.every((item, index) => sameWorkStateValue(item, other[index]));
  }
  const a = left as Record<string, unknown>;
  const b = right as Record<string, unknown>;
  const keys = Object.keys(a).filter(key => a[key] !== undefined);
  if (keys.length !== Object.keys(b).filter(key => b[key] !== undefined).length) return false;
  return keys.every(key => Object.prototype.hasOwnProperty.call(b, key) && sameWorkStateValue(a[key], b[key]));
}

function clone<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value)) as T;
}

function pendingPatch(label: string): WindowFrontendPatch {
  let patch = patches.get(label);
  if (!patch) { patch = { set: {}, maps: {} }; patches.set(label, patch); }
  return patch;
}

function markReplace(label: string): void {
  const frontend = records.get(label)?.frontend;
  if (frontend) patches.set(label, { replace: clone(frontend), set: {}, maps: {} });
}

/** Unsaved buffers at least this long are sent as deltas after the first save. */
const TEXT_DELTA_MIN_LENGTH = 8192;
interface SentText { text: string; revision: number }
/** Large buffers the backend acknowledged, per window and editor. */
const sentTexts = new Map<string, Map<string, SentText>>();
/**
 * Identifies a sent buffer version. The backend applies a delta only to the
 * revision it was computed from, so no content hash of the buffer is needed.
 */
let textRevision = Date.now();

type SentTexts = Map<string, SentText | null>;

/** Replaces large editor buffers that the backend already holds with single-span deltas. */
function encodeTextDeltas(label: string, patch: WindowFrontendPatch): { payload: WindowFrontendPatch; sent: SentTexts } {
  const sent: SentTexts = new Map();
  const editors = patch.replace
    ? patch.replace.editors as Record<string, unknown>
    : patch.maps.editors;
  if (!editors) return { payload: patch, sent };
  const known = patch.replace ? undefined : sentTexts.get(label);
  const encoded: Record<string, unknown> = {};
  for (const [id, entry] of Object.entries(editors)) {
    const text = entry && typeof entry === "object" ? (entry as { text?: unknown }).text : undefined;
    if (typeof text !== "string" || text.length < TEXT_DELTA_MIN_LENGTH) {
      sent.set(id, null);
      encoded[id] = entry;
      continue;
    }
    const previous = known?.get(id);
    const { text: _text, ...rest } = entry as Record<string, unknown>;
    if (previous && previous.text === text) {
      sent.set(id, previous);
      encoded[id] = { ...rest, textDelta: { baseRevision: previous.revision, revision: previous.revision, from: 0, to: 0, insert: "" } };
      continue;
    }
    const revision = ++textRevision;
    sent.set(id, { text, revision });
    const delta = previous ? singleSpanDelta(previous.text, text) : null;
    encoded[id] = previous && delta && delta.insert.length < text.length / 2
      ? { ...rest, textDelta: { baseRevision: previous.revision, revision, ...delta } }
      : { ...(entry as Record<string, unknown>), textRevision: revision };
  }
  if (patch.replace) {
    return { payload: { ...patch, replace: { ...patch.replace, editors: encoded as WindowFrontendState["editors"] } }, sent };
  }
  return { payload: { ...patch, maps: { ...patch.maps, editors: encoded } }, sent };
}

function rememberSentTexts(label: string, sent: SentTexts, replaced: boolean): void {
  const texts = replaced ? new Map<string, SentText>() : sentTexts.get(label) ?? new Map<string, SentText>();
  for (const [id, value] of sent) {
    if (value) texts.set(id, value); else texts.delete(id);
  }
  if (texts.size) sentTexts.set(label, texts); else sentTexts.delete(label);
}

/** Re-queues a patch whose save failed underneath anything recorded since. */
function requeuePatch(label: string, failed: WindowFrontendPatch): void {
  const newer = patches.get(label);
  if (!newer) { patches.set(label, failed); return; }
  if (newer.replace) return;
  if (failed.replace) { markReplace(label); return; }
  const merged: WindowFrontendPatch = { set: { ...failed.set, ...newer.set }, maps: { ...failed.maps } };
  for (const field of MAP_FIELDS) {
    if (newer.maps[field]) merged.maps[field] = { ...merged.maps[field], ...newer.maps[field] };
  }
  patches.set(label, merged);
}

function readLegacyFrontend(label: string): WindowFrontendState {
  const state = emptyFrontend();
  try {
    state.activePage = localStorage.getItem(pageKey(label)) ?? undefined;
    for (const key of Object.keys(localStorage)) {
      const prefix = layoutPrefix(label);
      if (key !== prefix && !key.startsWith(`${prefix}:workspace:`)) continue;
      try {
        const layout = JSON.parse(localStorage.getItem(key)!);
        if (layout?.schemaVersion !== 1 || layout.windowId !== label || !layout.groups) continue;
        const scope = key === prefix ? "" : decodeURIComponent(key.slice(`${prefix}:workspace:`.length));
        state.layouts[scope] = layout;
      } catch { /* One damaged old layout must not discard the other workspaces. */ }
    }
  } catch (error) { console.warn("[work-state] legacy layout unavailable", error); }
  return state;
}

function hydrate(record: SavedWorkWindow): void {
  const imported = record.frontend?.version !== 1;
  const state = imported ? readLegacyFrontend(record.label) : record.frontend!;
  record.frontend = state;
  const counts = [Object.keys(state.layouts ?? {}).length, Object.keys(state.editors ?? {}).length];
  state.layouts = Object.fromEntries(Object.entries(state.layouts ?? {}).filter(([, layout]) =>
    layout?.schemaVersion === 1 && layout.windowId === record.label && layout.groups && layout.layout));
  state.editors = Object.fromEntries(Object.entries(state.editors ?? {}).filter(([, editor]) =>
    editor && typeof editor === "object" && typeof editor.kind === "string"));
  const filtered = counts[0] !== Object.keys(state.layouts).length || counts[1] !== Object.keys(state.editors).length;
  state.sidebar ??= state.layouts[state.activeWorkspaceId ?? ""]?.sidebar;
  try {
    for (const [scope, layout] of Object.entries(state.layouts)) {
      if (layout.windowId !== record.label) continue;
      const key = scope ? `${layoutPrefix(record.label)}:workspace:${encodeURIComponent(scope)}` : layoutPrefix(record.label);
      // Sidebar geometry belongs to the native window. Seed the unscoped cache
      // too, because the store carries that geometry into the active checkout.
      localStorage.setItem(key, JSON.stringify({ ...layout, sidebar: state.sidebar ?? layout.sidebar }));
    }
    if (state.activePage) localStorage.setItem(pageKey(record.label), state.activePage);
  } catch (error) { console.warn("[work-state] layout cache hydrate failed", error); }
  records.set(record.label, record);
  // The backend still holds the unimported or unfiltered state; send it once whole.
  if (imported || filtered) markReplace(record.label);
}

export function initializeWorkState(label: string): Promise<void> {
  if (!hasTauriWindowRuntime()) return Promise.resolve();
  if (initialized) return initialized;
  ownerLabel = label;
  initialized = (async () => {
    await listen<string>("locus-work-state-save-requested", ({ payload }) => {
      exiting = true;
      void flushWorkState().then(() => invoke("acknowledge_work_state_save", { requestId: payload }))
        .catch(error => console.error("[work-state] exit save failed", error));
    });
    const snapshot = await invoke<DesktopWorkState>("load_desktop_work_state");
    if (snapshot.schemaVersion !== 1) throw new Error("Unsupported desktop work state version");
    legacyAuxImport = label === "main" && snapshot.legacyAuxImportPending;
    for (const record of Object.values(snapshot.windows)) {
      if (record.ownerLabel === label) hydrate(record);
    }
    if (!records.has(label)) hydrate({ label, ownerLabel: label, visible: true, maximized: false, alwaysOnTop: false, frontend: null });
    if (!captureInstalled) {
      captureInstalled = true;
      // Capture view-only changes as well as edits. No periodic whole-app polling.
      // Scrolling changes only view state, so it waits for a longer pause.
      for (const type of ["input", "change", "pointerup", "scroll", "focusout"]) {
        document.addEventListener(type, scheduleWorkStateCaptureForEvent, { capture: true, passive: true });
      }
      window.addEventListener("pagehide", () => { void flushWorkState(); });
    }
  })().catch(error => { initialized = null; throw error; });
  return initialized;
}

export function registerWorkStateProvider(label: string, provider: () => void | Promise<void>): () => void {
  providers.set(label, provider);
  return () => { if (providers.get(label) === provider) providers.delete(label); };
}

/** Runs before each flush; `exiting` is true for the final save before app exit. */
export function registerWorkStateFlushHook(hook: (exiting: boolean) => void | Promise<void>): () => void {
  flushHooks.add(hook);
  return () => { flushHooks.delete(hook); };
}

export function ensureWorkWindow(label: string): void {
  if (!ownerLabel || records.has(label)) return;
  hydrate({ label, ownerLabel, visible: true, maximized: false, alwaysOnTop: false, frontend: null });
  dirty.add(label);
}

export function updateWindowWorkState(label: string, patch: Partial<WindowFrontendState>): void {
  if (!ownerLabel) return;
  ensureWorkWindow(label);
  const record = records.get(label)!;
  const current = record.frontend! as unknown as Record<string, unknown>;
  const set: Record<string, unknown> = {};
  const maps: WindowFrontendPatch["maps"] = {};
  for (const [field, value] of Object.entries({ ...patch, version: 1 })) {
    if (isMapField(field)) {
      const before = (current[field] ?? {}) as Record<string, unknown>;
      const after = (value ?? {}) as Record<string, unknown>;
      const changes: Record<string, unknown> = {};
      for (const key of Object.keys(before)) if (!(key in after)) changes[key] = null;
      for (const [key, entry] of Object.entries(after)) {
        if (!sameWorkStateValue(before[key], entry)) changes[key] = entry;
      }
      if (Object.keys(changes).length) maps[field] = changes;
    } else if (!sameWorkStateValue(current[field], value)) {
      set[field] = value ?? null;
    }
  }
  if (!Object.keys(set).length && !Object.keys(maps).length) return;
  record.frontend = { ...record.frontend!, ...patch, version: 1 as const };
  const pending = pendingPatch(label);
  if (pending.replace) {
    pending.replace = clone(record.frontend);
  } else {
    // Copy before enqueuing so later reactive mutations cannot change a queued write.
    Object.assign(pending.set, clone(set));
    // Map entries are fresh snapshots from their providers; large unsaved
    // buffers are not copied again.
    for (const [field, changes] of Object.entries(maps) as [MapField, Record<string, unknown>][]) {
      pending.maps[field] = { ...pending.maps[field], ...changes };
    }
  }
  scheduleWorkStateCapture();
}

export function recordWorkbenchLayout(label: string, scope: string | null, layout: WorkbenchWindowState): void {
  if (!ownerLabel || !records.has(label)) return;
  const state = savedWindowState(label)!;
  const key = scope ?? "";
  const previous = state.layouts[key];
  // Copy so later reactive mutations of the store cannot change the saved layout.
  const copy = previous && sameWorkStateValue(previous, layout) ? previous : clone(layout);
  updateWindowWorkState(label, { layouts: { ...state.layouts, [key]: copy }, activeWorkspaceId: scope, sidebar: copy.sidebar });
}

export function recordActivePage(page: string): void {
  if (ownerLabel) updateWindowWorkState(ownerLabel, { activePage: page });
}

/** Document listener: scrolling changes only view state and waits for a longer pause. */
export function scheduleWorkStateCaptureForEvent(event: Event): void {
  scheduleWorkStateCapture(event.type === "scroll" ? SCROLL_CAPTURE_DELAY_MS : CAPTURE_DELAY_MS);
}

/** A capture runs at most once per delay; a shorter request moves it earlier. */
export function scheduleWorkStateCapture(delay = CAPTURE_DELAY_MS): void {
  if (!ownerLabel || exiting) return;
  const dueAt = Date.now() + delay;
  if (timer) {
    if (timerDueAt <= dueAt) return;
    clearTimeout(timer);
  }
  timerDueAt = dueAt;
  timer = setTimeout(() => {
    timer = null;
    void flushWorkState().catch(error => console.warn("[work-state] save failed", error));
  }, delay);
}

export function flushWorkState(): Promise<void> {
  if (timer) clearTimeout(timer);
  timer = null;
  const operation = async () => {
    for (const hook of flushHooks) {
      try { await hook(exiting); } catch (error) { console.warn("[work-state] flush hook failed", error); }
    }
    for (const provider of providers.values()) await provider();
    for (const label of new Set([...dirty, ...patches.keys()])) {
      if (!records.has(label)) { dirty.delete(label); patches.delete(label); continue; }
      const patch = patches.get(label) ?? { set: {}, maps: {} };
      patches.delete(label);
      dirty.delete(label);
      const encoded = encodeTextDeltas(label, patch);
      try {
        await invoke("save_window_work_state_patch", { label, patch: encoded.payload });
        rememberSentTexts(label, encoded.sent, !!patch.replace);
      } catch (error) {
        // The backend may hold another buffer now; the retry sends full text.
        sentTexts.delete(label);
        if (records.has(label)) { requeuePatch(label, patch); dirty.add(label); }
        throw error;
      }
    }
  };
  saving = saving.catch(() => {}).then(operation);
  return saving;
}

export function forgetWorkWindow(label: string): void {
  records.delete(label);
  dirty.delete(label);
  patches.delete(label);
  sentTexts.delete(label);
  providers.delete(label);
}

export function isWorkStateExiting(): boolean { return exiting; }

export function restoredAuxWindows(): SavedWorkWindow[] {
  return [...records.values()].filter(record => record.label !== record.ownerLabel && record.ownerLabel === ownerLabel);
}

export function shouldImportLegacyAuxWindows(): boolean { return legacyAuxImport; }

export async function finishWorkStateRestore(): Promise<void> {
  await flushWorkState();
  if (ownerLabel === "main") {
    await invoke("finish_work_state_migration");
    legacyAuxImport = false;
  }
}

export async function revealWorkStateWindow(label = getCurrentTauriWindowLabel() ?? "main"): Promise<void> {
  if (!hasTauriWindowRuntime()) return;
  ensureWorkWindow(label);
  dirty.add(label);
  await flushWorkState();
  await invoke("show_work_state_window", { label });
}
