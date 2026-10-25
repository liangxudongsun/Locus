import { editProperties, parseProperties, propertyRows, type MarkdownProperty, type PropertyEdit } from "../document/markdownProperties";
import type { KnowledgeDocumentType } from "../types";
import { ipcInvoke } from "./ipc";
import { knowledgeListPage } from "./knowledge";
import { getLocusRuntime } from "./locusRuntime";
import { listDirEntriesPage, WORKSPACE_EVENT_NAME, workspaceMaterializationMatches, type RoutedWorkspaceEvent, type WorkspaceRef } from "./project";

/** Serializable within a checkout. Keep the resolved sourceId returned by read(). */
export type ViewDocumentRef =
  | { kind: "workspace"; path: string }
  | { kind: "knowledge"; type: KnowledgeDocumentType; path: string; sourceId?: string };
export type DocumentPropertyValue = null | string | number | boolean | DocumentPropertyValue[] | { [key: string]: DocumentPropertyValue };
export interface ViewDocumentSnapshot {
  reference: ViewDocumentRef;
  /** Physical path for display, opening the original, and matching file notifications. */
  path: string;
  /** Exact original Markdown including frontmatter. */
  content: string;
  /** Markdown after the closing frontmatter delimiter, including original blank lines. */
  body: string;
  propertiesYaml: string;
  properties: Record<string, DocumentPropertyValue>;
  propertyRows: MarkdownProperty[];
  revision: string;
  readOnly: boolean;
  reservedKeys: string[];
}
interface NativeSnapshot extends Omit<ViewDocumentSnapshot, "body" | "propertiesYaml" | "properties" | "propertyRows"> {}
export interface ViewDocumentEdit {
  properties?: PropertyEdit[];
  body?: string;
}
export interface ViewDocumentWriteOptions { expectedRevision: string }
export type ViewDocumentListOptions =
  | { kind: "knowledge"; type?: KnowledgeDocumentType; pathPrefix?: string; cursor?: string | null; limit?: number }
  | { kind: "workspace"; path: string; cursor?: string | null; limit?: number };
export interface ViewDocumentListPage {
  items: Array<{ reference: ViewDocumentRef; title: string }>;
  /** Immediate workspace subdirectories; call list() on each to traverse further. */
  directories: string[];
  nextCursor: string | null;
}
export interface ViewDocumentChange {
  kind: "workspace" | "knowledge" | "document";
  path?: string;
  reference?: ViewDocumentRef;
  /** A directory, source policy, or broad catalog update; reload the relevant collection. */
  subtree: boolean;
}

function documentError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code: `document.${code}` });
}

function assertValue(value: unknown, seen = new Set<object>(), depth = 0): asserts value is DocumentPropertyValue {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value)) return;
  if (!value || typeof value !== "object" || depth > 30 || seen.has(value)
    || !Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw documentError("invalid_value", "Properties must contain finite JSON-compatible values.");
  }
  seen.add(value);
  for (const item of Object.values(value)) assertValue(item, seen, depth + 1);
  seen.delete(value);
}

/** Keep BOM, delimiters, body bytes and document newline convention outside YAML serialization. */
export function splitViewDocument(content: string) {
  const bom = content.startsWith("\ufeff") ? "\ufeff" : "";
  const opening = /^\ufeff?---[\t ]*\r?\n/.exec(content);
  if (!opening) return { yaml: "", body: content.slice(bom.length), prefix: bom, suffix: "", hasProperties: false };
  const tail = content.slice(opening[0].length);
  const closing = /^(?:---|\.\.\.)[\t ]*(?:\r?\n|$)/m.exec(tail);
  if (!closing) throw documentError("invalid_yaml", "The YAML properties block is not terminated.");
  return { yaml: tail.slice(0, closing.index), body: tail.slice(closing.index + closing[0].length),
    prefix: opening[0], suffix: closing[0], hasProperties: true };
}

function fromNative(snapshot: NativeSnapshot): ViewDocumentSnapshot {
  const parts = splitViewDocument(snapshot.content);
  const properties: unknown = parseProperties(parts.yaml).toJS({ maxAliasCount: 20 }) ?? {};
  assertValue(properties);
  return { ...snapshot, body: parts.body, propertiesYaml: parts.yaml,
    properties: properties as Record<string, DocumentPropertyValue>, propertyRows: propertyRows(parts.yaml) };
}

export function applyViewDocumentEdit(snapshot: ViewDocumentSnapshot, edit: ViewDocumentEdit): string {
  if (snapshot.readOnly) throw documentError("read_only", "Document is read-only.");
  if (edit.body !== undefined && typeof edit.body !== "string") throw documentError("invalid_body", "Document body must be text.");
  const parts = splitViewDocument(snapshot.content);
  let yaml = parts.yaml;
  for (const change of edit.properties ?? []) {
    if (snapshot.reservedKeys.includes(change.key) || change.newKey && snapshot.reservedKeys.includes(change.newKey)) {
      throw documentError("reserved_property", `Property '${change.key}' is managed by Knowledge settings.`);
    }
    if (Object.prototype.hasOwnProperty.call(change, "value")) assertValue(change.value);
    yaml = editProperties(yaml, change);
  }
  const body = edit.body ?? parts.body;
  if (yaml === parts.yaml) {
    return parts.hasProperties ? parts.prefix + yaml + parts.suffix + body : parts.prefix + body;
  }
  const newline = snapshot.content.includes("\r\n") ? "\r\n" : "\n";
  yaml = yaml.replace(/\r?\n/g, newline);
  return parts.hasProperties ? parts.prefix + yaml + parts.suffix + body
    : parts.prefix + `---${newline}${yaml}---${newline}` + body;
}

/** Bound once to the View/tool lifetime and checkout; no global active-workspace lookup. */
export function createViewDocuments(workspaceRef: WorkspaceRef, options: { signal?: AbortSignal } = {}) {
  const scope = Object.freeze({ ...workspaceRef });
  function assertLive() { if (options.signal?.aborted) throw documentError("cancelled", "Document access was cancelled."); }
  async function read(reference: ViewDocumentRef): Promise<ViewDocumentSnapshot> {
    assertLive();
    const result = await ipcInvoke<NativeSnapshot>("view_document_read", { workspaceRef: scope, reference });
    assertLive();
    return fromNative(result);
  }
  async function update(reference: ViewDocumentRef, edit: ViewDocumentEdit, writeOptions: ViewDocumentWriteOptions): Promise<ViewDocumentSnapshot> {
    assertLive();
    if (!writeOptions?.expectedRevision) throw documentError("revision_required", "Pass the revision returned by read().");
    const snapshot = await read(reference);
    if (snapshot.revision !== writeOptions.expectedRevision) throw documentError("conflict", "Document changed since it was read. Read it again before editing.");
    const content = applyViewDocumentEdit(snapshot, edit);
    assertLive();
    const result = await ipcInvoke<NativeSnapshot>("view_document_write", { workspaceRef: scope,
      request: { reference: snapshot.reference, content, expectedRevision: writeOptions.expectedRevision } });
    assertLive();
    return fromNative(result);
  }
  async function list(input: ViewDocumentListOptions): Promise<ViewDocumentListPage> {
    assertLive();
    const limit = input.limit ?? 200;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw documentError("invalid_limit", "Limit must be between 1 and 500.");
    if (input.kind === "knowledge") {
      const page = await knowledgeListPage(input, scope);
      assertLive();
      return { items: page.items.filter((doc) => /\.(md|markdown)$/i.test(doc.path)).map((doc) => ({
        reference: { kind: "knowledge", type: doc.type, path: doc.path }, title: doc.title,
      })), directories: [], nextCursor: page.nextCursor ?? null };
    }
    const offset = input.cursor ? Number(input.cursor) : 0;
    if (!Number.isSafeInteger(offset) || offset < 0) throw documentError("invalid_cursor", "Invalid document list cursor.");
    const page = await listDirEntriesPage(input.path, scope, offset, limit);
    assertLive();
    return { items: page.entries.filter((entry) => !entry.isDir && /\.(md|markdown)$/i.test(entry.name)).map((entry) => ({
      reference: { kind: "workspace", path: entry.relPath }, title: entry.name,
    })), directories: page.entries.filter((entry) => entry.isDir).map((entry) => entry.relPath),
    nextCursor: page.hasMore ? String(page.nextOffset) : null };
  }
  async function onChanged(handler: (change: ViewDocumentChange) => void): Promise<() => void> {
    assertLive();
    const release = await getLocusRuntime().subscribe<RoutedWorkspaceEvent<Record<string, unknown>>>(WORKSPACE_EVENT_NAME, (event) => {
      if (options.signal?.aborted || event.checkoutId !== scope.checkoutId || event.workspaceGeneration !== scope.expectedGeneration
        || !workspaceMaterializationMatches(scope.expectedMaterializationEpoch, event.materializationEpoch)) return;
      const payload = event.payload;
      if (event.eventName === "view-document-changed") handler({ kind: "document", path: payload.path as string,
        reference: payload.reference as ViewDocumentRef, subtree: false });
      else if (event.eventName === "knowledge-changed") handler({ kind: "knowledge", path: typeof payload.path === "string" ? payload.path : undefined,
        reference: payload.targetKind === "document" && typeof payload.path === "string" && typeof payload.docType === "string"
          ? { kind: "knowledge", type: payload.docType as KnowledgeDocumentType, path: payload.path } : undefined,
        subtree: !!payload.subtree || payload.targetKind !== "document" });
      else if (event.eventName === "workspace-file-changed") handler({ kind: "workspace", path: payload.path as string, subtree: true });
    }, { owner: "view.documents", signal: options.signal, interests: [{ workspaceRef: scope }] });
    if (options.signal?.aborted) { release(); assertLive(); }
    return release;
  }
  return {
    workspace: (path: string): ViewDocumentRef => ({ kind: "workspace", path }),
    knowledge: (type: KnowledgeDocumentType, path: string): ViewDocumentRef => ({ kind: "knowledge", type, path }),
    list, read, update, onChanged,
    setProperties: (reference: ViewDocumentRef, properties: Record<string, DocumentPropertyValue>, writeOptions: ViewDocumentWriteOptions) =>
      update(reference, { properties: Object.entries(properties).map(([key, value]) => ({ key, value })) }, writeOptions),
    removeProperties: (reference: ViewDocumentRef, keys: string[], writeOptions: ViewDocumentWriteOptions) =>
      update(reference, { properties: keys.map((key) => ({ key, remove: true })) }, writeOptions),
    writeBody: (reference: ViewDocumentRef, body: string, writeOptions: ViewDocumentWriteOptions) => update(reference, { body }, writeOptions),
  };
}
export type ViewDocuments = ReturnType<typeof createViewDocuments>;
