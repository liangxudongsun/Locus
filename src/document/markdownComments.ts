import type { Text } from "@codemirror/state";

/**
 * Review comments stored inside a Markdown file. All threads live in one HTML
 * comment at the very end of the document, one JSON object per line:
 *
 *     <!-- locus:comments v1
 *     {"id":"k3x9q2","anchor":{"exact":"…","prefix":"…","suffix":"…"},"status":"open","messages":[…]}
 *     -->
 *
 * Standard renderers hide the block. `<` and `>` inside JSON strings are
 * written as JSON unicode escapes (u003c / u003e), so a line can never contain `-->`. Anchors
 * quote the commented text with some context instead of storing offsets, so
 * edits elsewhere never touch the block.
 */

export const COMMENT_BLOCK_VERSION = 1;
export const COMMENT_BLOCK_HEADER = `<!-- locus:comments v${COMMENT_BLOCK_VERSION}`;
export const COMMENT_BLOCK_CLOSER = "-->";
/** Context characters stored on each side of the quote; grown when the quote is ambiguous. */
export const COMMENT_CONTEXT_SIZES = [32, 64, 128] as const;
export const MAX_COMMENT_QUOTE_LENGTH = 2000;

const HEADER_PATTERN = /^<!-- locus:comments v(\d+)[\t ]*$/;
const THREAD_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_BLOCK_SCAN_LINES = 20_000;
const MAX_ANCHOR_CANDIDATES = 2000;

export type CommentStatus = "open" | "resolved";

export interface CommentAnchorSelector {
  exact: string;
  prefix: string;
  suffix: string;
}

export interface CommentMessage {
  id: string;
  author: string;
  /** ISO 8601 creation time. */
  time: string;
  text: string;
  /** ISO 8601 time of the last edit. */
  edited?: string;
  /** Unknown fields, preserved on rewrite. */
  extra?: Record<string, unknown>;
}

export interface CommentThread {
  id: string;
  /** Null for a comment on the whole document. */
  anchor: CommentAnchorSelector | null;
  status: CommentStatus;
  messages: CommentMessage[];
  /** Unknown fields, preserved on rewrite. */
  extra?: Record<string, unknown>;
}

export interface CommentBlockLine {
  from: number;
  to: number;
  text: string;
  /** Null for blank or unreadable lines; they are kept as written. */
  thread: CommentThread | null;
}

export interface CommentBlockRange {
  /** Start of the header line. */
  from: number;
  /** Start of the hidden region: the line break before the header, or 0. */
  hideFrom: number;
  /** End of the header line. */
  headerTo: number;
  /** Start of the closing `-->` line. */
  closerFrom: number;
  /** Document length. */
  to: number;
  version: number;
}

export interface CommentBlock extends CommentBlockRange {
  lines: CommentBlockLine[];
  threads: CommentThread[];
  /** False for a newer format version; such a block is shown but never rewritten. */
  writable: boolean;
}

export interface TextChange {
  from: number;
  to?: number;
  insert?: string;
}

const isBlank = (text: string) => text.trim() === "";

/** Locates the trailing comment block without parsing its threads. */
export function findCommentBlockRange(doc: Text): CommentBlockRange | null {
  if (doc.length === 0) return null;
  let number = doc.lines;
  while (number >= 1 && isBlank(doc.line(number).text)) number -= 1;
  if (number < 2) return null;
  const closer = doc.line(number);
  if (closer.text.trim() !== COMMENT_BLOCK_CLOSER) return null;
  const lowest = Math.max(1, number - MAX_BLOCK_SCAN_LINES);
  for (let current = number - 1; current >= lowest; current -= 1) {
    const line = doc.line(current);
    const header = HEADER_PATTERN.exec(line.text);
    if (header) {
      return {
        from: line.from,
        hideFrom: line.from > 0 ? line.from - 1 : 0,
        headerTo: line.to,
        closerFrom: closer.from,
        to: doc.length,
        version: Number(header[1]),
      };
    }
    if (line.text.includes(COMMENT_BLOCK_CLOSER)) return null;
  }
  return null;
}

export function findCommentBlock(doc: Text): CommentBlock | null {
  const range = findCommentBlockRange(doc);
  if (!range) return null;
  const lines: CommentBlockLine[] = [];
  const threads: CommentThread[] = [];
  const ids = new Set<string>();
  const first = doc.lineAt(range.headerTo).number + 1;
  const last = doc.lineAt(range.closerFrom).number - 1;
  for (let number = first; number <= last; number += 1) {
    const line = doc.line(number);
    let thread = parseCommentThread(line.text);
    if (thread && ids.has(thread.id)) thread = null;
    if (thread) {
      ids.add(thread.id);
      threads.push(thread);
    }
    lines.push({ from: line.from, to: line.to, text: line.text, thread });
  }
  return { ...range, lines, threads, writable: range.version === COMMENT_BLOCK_VERSION };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function extraFields(record: Record<string, unknown>, known: readonly string[]): Record<string, unknown> | undefined {
  const extra = Object.fromEntries(Object.entries(record).filter(([key]) => !known.includes(key)));
  return Object.keys(extra).length ? extra : undefined;
}

const THREAD_KEYS = ["id", "anchor", "status", "messages"] as const;
const MESSAGE_KEYS = ["id", "author", "time", "text", "edited"] as const;

function parseAnchor(value: unknown): CommentAnchorSelector | null | undefined {
  if (value === null || value === undefined) return null;
  if (!isRecord(value) || typeof value.exact !== "string" || !value.exact) return undefined;
  return {
    exact: value.exact,
    prefix: typeof value.prefix === "string" ? value.prefix : "",
    suffix: typeof value.suffix === "string" ? value.suffix : "",
  };
}

export function parseCommentThread(line: string): CommentThread | null {
  const text = line.trim();
  if (!text.startsWith("{")) return null;
  let value: unknown;
  try { value = JSON.parse(text); } catch { return null; }
  if (!isRecord(value) || typeof value.id !== "string" || !THREAD_ID_PATTERN.test(value.id)) return null;
  if (!Array.isArray(value.messages)) return null;
  const anchor = parseAnchor(value.anchor);
  if (anchor === undefined) return null;
  const messages: CommentMessage[] = [];
  for (const [index, item] of value.messages.entries()) {
    if (!isRecord(item) || typeof item.text !== "string") return null;
    const message: CommentMessage = {
      id: typeof item.id === "string" && item.id ? item.id : `m${index + 1}`,
      author: typeof item.author === "string" ? item.author : "",
      time: typeof item.time === "string" ? item.time : "",
      text: item.text,
    };
    if (typeof item.edited === "string") message.edited = item.edited;
    const extra = extraFields(item, MESSAGE_KEYS);
    if (extra) message.extra = extra;
    messages.push(message);
  }
  const thread: CommentThread = {
    id: value.id,
    anchor,
    status: value.status === "resolved" ? "resolved" : "open",
    messages,
  };
  const extra = extraFields(value, THREAD_KEYS);
  if (extra) thread.extra = extra;
  return thread;
}

/** JSON with `<` and `>` escaped, so the line cannot close the HTML comment. */
export function escapeCommentJson(json: string): string {
  return json.replace(/[<>]/g, (char) => char === "<" ? "\\u003c" : "\\u003e");
}

export function serializeCommentThread(thread: CommentThread): string {
  const value: Record<string, unknown> = {
    id: thread.id,
    anchor: thread.anchor ? { exact: thread.anchor.exact, prefix: thread.anchor.prefix, suffix: thread.anchor.suffix } : null,
    status: thread.status,
    messages: thread.messages.map((message) => ({
      id: message.id,
      author: message.author,
      time: message.time,
      text: message.text,
      ...(message.edited ? { edited: message.edited } : {}),
      ...(message.extra ?? {}),
    })),
    ...(thread.extra ?? {}),
  };
  return escapeCommentJson(JSON.stringify(value));
}

/** Start of the trailing whitespace before `end` (the end of the document body). */
export function contentEndBefore(doc: Text, end: number): number {
  let position = end;
  while (position > 0) {
    const chunk = doc.sliceString(Math.max(0, position - 256), position);
    const trimmed = chunk.replace(/\s+$/, "");
    if (trimmed.length) return position - chunk.length + trimmed.length;
    position -= chunk.length;
  }
  return 0;
}

/** Changes that append a thread, creating the block when the document has none. */
export function insertCommentThreadChange(doc: Text, block: CommentBlockRange | null, thread: CommentThread): TextChange {
  const line = serializeCommentThread(thread);
  if (block) return { from: block.closerFrom, insert: `${line}\n` };
  const tail = doc.sliceString(Math.max(0, doc.length - 2));
  const separator = doc.length === 0 || tail === "\n\n" ? "" : tail.endsWith("\n") ? "\n" : "\n\n";
  return { from: doc.length, insert: `${separator}${COMMENT_BLOCK_HEADER}\n${line}\n${COMMENT_BLOCK_CLOSER}\n` };
}

export function replaceCommentThreadChange(block: CommentBlock, thread: CommentThread): TextChange | null {
  const line = block.lines.find((item) => item.thread?.id === thread.id);
  if (!line) return null;
  const text = serializeCommentThread(thread);
  return text === line.text ? null : { from: line.from, to: line.to, insert: text };
}

/** Removes a thread; the block goes away with its last line. */
export function removeCommentThreadChange(doc: Text, block: CommentBlock, id: string): TextChange | null {
  const line = block.lines.find((item) => item.thread?.id === id);
  if (!line) return null;
  const remaining = block.lines.some((item) => item !== line && !isBlank(item.text));
  if (remaining) return { from: line.from, to: Math.min(doc.length, line.to + 1) };
  const contentEnd = contentEndBefore(doc, block.from);
  const cut = contentEnd > 0 && doc.sliceString(contentEnd, contentEnd + 1) === "\n" ? contentEnd + 1 : contentEnd;
  return { from: cut, to: doc.length };
}

function safeStart(text: string, index: number): number {
  const code = text.charCodeAt(index);
  return code >= 0xdc00 && code <= 0xdfff ? index + 1 : index;
}

function safeEnd(text: string, index: number): number {
  const code = text.charCodeAt(index - 1);
  return code >= 0xd800 && code <= 0xdbff ? index - 1 : index;
}

function occursOnce(body: string, needle: string): boolean {
  const first = body.indexOf(needle);
  return first >= 0 && body.indexOf(needle, first + 1) < 0;
}

/** Quote selector for `body[from, to)`, with enough context to be unique when possible. */
export function createCommentAnchor(body: string, from: number, to: number): CommentAnchorSelector {
  const exact = body.slice(from, to);
  let prefix = "";
  let suffix = "";
  for (const size of COMMENT_CONTEXT_SIZES) {
    prefix = body.slice(safeStart(body, Math.max(0, from - size)), from);
    suffix = body.slice(to, safeEnd(body, Math.min(body.length, to + size)));
    if (occursOnce(body, prefix + exact + suffix)) break;
  }
  return { exact, prefix, suffix };
}

function sharedSuffixLength(a: string, b: string): number {
  let count = 0;
  while (count < a.length && count < b.length && a.charCodeAt(a.length - 1 - count) === b.charCodeAt(b.length - 1 - count)) count += 1;
  return count;
}

function sharedPrefixLength(a: string, b: string): number {
  let count = 0;
  while (count < a.length && count < b.length && a.charCodeAt(count) === b.charCodeAt(count)) count += 1;
  return count;
}

/**
 * Finds the quoted text in `body`, preferring the occurrence whose context
 * matches best. When the quote itself was rewritten, the text between its
 * surviving prefix and suffix is used instead.
 */
export function resolveCommentAnchor(
  body: string,
  anchor: CommentAnchorSelector,
  minFrom = 0,
): { from: number; to: number } | null {
  const { exact, prefix, suffix } = anchor;
  if (!exact) return null;
  let best = -1;
  let bestScore = -1;
  const perfect = prefix.length + suffix.length;
  let index = body.indexOf(exact, minFrom);
  for (let count = 0; index >= 0 && count < MAX_ANCHOR_CANDIDATES; count += 1) {
    const before = body.slice(Math.max(0, index - prefix.length), index);
    const after = body.slice(index + exact.length, index + exact.length + suffix.length);
    const score = sharedSuffixLength(before, prefix) + sharedPrefixLength(after, suffix);
    if (score > bestScore) {
      best = index;
      bestScore = score;
      if (score === perfect) break;
    }
    index = body.indexOf(exact, index + 1);
  }
  if (best >= 0) return { from: best, to: best + exact.length };
  if (prefix.length < 4 || suffix.length < 4) return null;
  const span = Math.max(exact.length * 4, 400);
  let start = body.indexOf(prefix, minFrom);
  for (let count = 0; start >= 0 && count < MAX_ANCHOR_CANDIDATES; count += 1) {
    const from = start + prefix.length;
    const end = body.indexOf(suffix, from);
    if (end > from && end - from <= span && body.slice(from, end).trim()) return { from, to: end };
    start = body.indexOf(prefix, start + 1);
  }
  return null;
}

export function createCommentId(existing: Iterable<string>): string {
  const used = new Set(existing);
  for (;;) {
    const id = Math.random().toString(36).slice(2, 8).padEnd(6, "0");
    if (!used.has(id)) return id;
  }
}

export function nextCommentMessageId(thread: CommentThread): string {
  let max = 0;
  for (const message of thread.messages) {
    const match = /^m(\d+)$/.exec(message.id);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `m${Math.max(max, thread.messages.length) + 1}`;
}
