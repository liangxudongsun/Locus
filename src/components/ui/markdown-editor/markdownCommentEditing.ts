import {
  EditorSelection,
  EditorState,
  Facet,
  StateEffect,
  StateField,
  Transaction,
  type Extension,
  type Text,
} from "@codemirror/state";
import { isolateHistory } from "@codemirror/commands";
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import {
  MAX_COMMENT_QUOTE_LENGTH,
  contentEndBefore,
  createCommentAnchor,
  createCommentId,
  findCommentBlock,
  insertCommentThreadChange,
  nextCommentMessageId,
  removeCommentThreadChange,
  replaceCommentThreadChange,
  resolveCommentAnchor,
  type CommentAnchorSelector,
  type CommentBlock,
  type CommentStatus,
  type CommentThread,
  type TextChange,
} from "../../../document/markdownComments";
import { frontmatterEndOffset } from "../../../document/markdownFootnotes";

/**
 * Editor state for review comments stored in the trailing comment block
 * (see `document/markdownComments.ts`). Anchor positions follow every edit;
 * selectors in the file are refreshed only after user edits touch a quote or
 * its context, so opening or syncing a document never rewrites it.
 */

export const COMMENT_USER_EVENT = "input.comment";
const REANCHOR_DELAY_MS = 800;

export interface CommentPosition {
  from: number;
  to: number;
}

export interface MarkdownCommentFieldValue {
  block: CommentBlock | null;
  /** Current positions of anchored threads; missing ids are detached. */
  positions: ReadonlyMap<string, CommentPosition>;
  /** Threads whose stored selectors no longer describe their position. */
  stale: ReadonlySet<string>;
  activeId: string | null;
  /** Selection being commented, before the thread exists. */
  draft: CommentPosition | null;
  showResolved: boolean;
}

export const setCommentPositions = StateEffect.define<ReadonlyArray<CommentPosition & { id: string }>>();
export const setActiveComment = StateEffect.define<string | null>();
export const setCommentDraft = StateEffect.define<CommentPosition | null>();
export const setShowResolvedComments = StateEffect.define<boolean>();
const clearStaleComments = StateEffect.define<readonly string[]>();

const EMPTY_POSITIONS: ReadonlyMap<string, CommentPosition> = new Map();
const EMPTY_STALE: ReadonlySet<string> = new Set();

function resolvePositions(
  doc: Text,
  block: CommentBlock,
  keep: ReadonlyMap<string, CommentPosition> = EMPTY_POSITIONS,
): Map<string, CommentPosition> {
  const positions = new Map<string, CommentPosition>();
  let body: string | null = null;
  const minFrom = frontmatterEndOffset(doc);
  for (const thread of block.threads) {
    if (!thread.anchor) continue;
    const kept = keep.get(thread.id);
    if (kept) {
      positions.set(thread.id, kept);
      continue;
    }
    body ??= doc.sliceString(0, block.from);
    const resolved = resolveCommentAnchor(body, thread.anchor, minFrom);
    if (resolved) positions.set(thread.id, resolved);
  }
  return positions;
}

function sameAnchor(a: CommentAnchorSelector | null, b: CommentAnchorSelector | null): boolean {
  if (!a || !b) return a === b;
  return a.exact === b.exact && a.prefix === b.prefix && a.suffix === b.suffix;
}

function shiftBlock(block: CommentBlock, delta: number): CommentBlock {
  if (!delta) return block;
  return {
    ...block,
    from: block.from + delta,
    hideFrom: block.hideFrom + delta,
    headerTo: block.headerTo + delta,
    closerFrom: block.closerFrom + delta,
    to: block.to + delta,
    lines: block.lines.map((line) => ({ ...line, from: line.from + delta, to: line.to + delta })),
  };
}

function tailMayHaveBlock(doc: Text): boolean {
  return doc.sliceString(Math.max(0, doc.length - 64)).trimEnd().endsWith("-->");
}

/** User edits that may move text away from its stored selector. */
function isAnchorEdit(tr: Transaction): boolean {
  const event = tr.annotation(Transaction.userEvent);
  return !!event && !tr.isUserEvent(COMMENT_USER_EVENT) && !tr.isUserEvent("input.restore");
}

export const markdownCommentField = StateField.define<MarkdownCommentFieldValue>({
  create(state) {
    const block = findCommentBlock(state.doc);
    return {
      block,
      positions: block ? resolvePositions(state.doc, block) : EMPTY_POSITIONS,
      stale: EMPTY_STALE,
      activeId: null,
      draft: null,
      showResolved: false,
    };
  },
  update(value, tr) {
    if (!tr.docChanged && !tr.effects.length) return value;
    let { block, positions, stale, activeId, draft, showResolved } = value;
    if (tr.docChanged) {
      const changes = tr.changes;
      const mapped = new Map<string, CommentPosition>();
      for (const [id, position] of positions) {
        const from = changes.mapPos(position.from, 1);
        const to = changes.mapPos(position.to, -1);
        if (to > from) mapped.set(id, { from, to });
      }
      if (draft) {
        const from = changes.mapPos(draft.from, 1);
        const to = changes.mapPos(draft.to, -1);
        draft = to > from ? { from, to } : null;
      }
      if (positions.size && isAnchorEdit(tr)) {
        const nextStale = new Set(stale);
        const threads = new Map(block?.threads.map((thread) => [thread.id, thread]));
        changes.iterChangedRanges((fromA, toA) => {
          for (const [id, position] of positions) {
            const anchor = threads.get(id)?.anchor;
            const context = anchor ? Math.max(anchor.prefix.length, anchor.suffix.length, 1) : 1;
            if (fromA <= position.to + context && toA >= position.from - context) nextStale.add(id);
          }
        });
        stale = nextStale;
      }
      positions = mapped;

      let touched = false;
      if (block) {
        const hideFrom = block.hideFrom;
        changes.iterChangedRanges((_fromA, toA) => { if (toA >= hideFrom) touched = true; });
      }
      if (block && !touched) {
        block = shiftBlock(block, tr.state.doc.length - tr.startState.doc.length);
      } else if (block || tailMayHaveBlock(tr.state.doc)) {
        const next = findCommentBlock(tr.state.doc);
        if (!next) {
          block = null;
          positions = EMPTY_POSITIONS;
          stale = EMPTY_STALE;
        } else {
          const previous = new Map(block?.threads.map((thread) => [thread.id, thread]));
          const keep = new Map<string, CommentPosition>();
          for (const thread of next.threads) {
            const old = previous.get(thread.id);
            const position = positions.get(thread.id);
            if (old && position && sameAnchor(old.anchor, thread.anchor)) keep.set(thread.id, position);
          }
          positions = next.threads.some((thread) => thread.anchor && !keep.has(thread.id))
            ? resolvePositions(tr.state.doc, next, keep)
            : keep;
          const ids = new Set(next.threads.map((thread) => thread.id));
          stale = new Set([...stale].filter((id) => ids.has(id)));
          block = next;
        }
      }
    }
    for (const effect of tr.effects) {
      if (effect.is(setCommentPositions)) {
        const next = new Map(positions);
        for (const item of effect.value) next.set(item.id, { from: item.from, to: item.to });
        positions = next;
      } else if (effect.is(setActiveComment)) {
        activeId = effect.value;
      } else if (effect.is(setCommentDraft)) {
        draft = effect.value;
      } else if (effect.is(setShowResolvedComments)) {
        showResolved = effect.value;
      } else if (effect.is(clearStaleComments)) {
        const next = new Set(stale);
        for (const id of effect.value) next.delete(id);
        stale = next;
      }
    }
    if (activeId && !block?.threads.some((thread) => thread.id === activeId)) activeId = null;
    if (block === value.block && positions === value.positions && stale === value.stale
      && activeId === value.activeId && draft === value.draft && showResolved === value.showResolved) return value;
    return { block, positions, stale, activeId, draft, showResolved };
  },
});

export function markdownCommentState(state: EditorState): MarkdownCommentFieldValue | null {
  return state.field(markdownCommentField, false) ?? null;
}

/** True when the trailing comment block is hidden in this editor. */
const commentBlockHidden = Facet.define<boolean, boolean>({ combine: (values) => values.some(Boolean) });

/** Whether a position falls inside the hidden comment block (for search filtering). */
export function isInHiddenCommentBlock(state: EditorState, from: number): boolean {
  if (!state.facet(commentBlockHidden)) return false;
  const block = state.field(markdownCommentField, false)?.block;
  return !!block && from >= block.hideFrom;
}

const hiddenBlockDecorations = new WeakMap<CommentBlock, DecorationSet>();

function hiddenDecorations(state: EditorState): DecorationSet {
  const block = state.field(markdownCommentField, false)?.block;
  if (!block || block.to <= block.hideFrom) return Decoration.none;
  let set = hiddenBlockDecorations.get(block);
  if (!set) {
    set = Decoration.set([Decoration.replace({}).range(block.hideFrom, block.to)]);
    hiddenBlockDecorations.set(block, set);
  }
  return set;
}

function isProtectedEdit(tr: Transaction): boolean {
  return (tr.isUserEvent("input") || tr.isUserEvent("delete") || tr.isUserEvent("move"))
    && !tr.isUserEvent(COMMENT_USER_EVENT) && !tr.isUserEvent("input.restore");
}

/**
 * Rendered mode: hide the block, keep selections in front of it and reject
 * typing or deletion that would reach it. Undo, external sync and comment
 * operations still change it.
 */
function hiddenBlockExtensions(): Extension {
  return [
    commentBlockHidden.of(true),
    EditorView.decorations.compute([markdownCommentField], hiddenDecorations),
    EditorView.atomicRanges.of((view) => hiddenDecorations(view.state)),
    EditorState.transactionFilter.of((tr) => {
      if (!tr.selection) return tr;
      const block = tr.state.field(markdownCommentField, false)?.block;
      if (!block) return tr;
      const limit = block.hideFrom;
      if (tr.selection.ranges.every((range) => range.to <= limit)) return tr;
      const selection = EditorSelection.create(
        tr.selection.ranges.map((range) => EditorSelection.range(Math.min(range.anchor, limit), Math.min(range.head, limit))),
        tr.selection.mainIndex,
      );
      return [tr, { selection, sequential: true }];
    }),
    EditorState.changeFilter.of((tr) => {
      if (!isProtectedEdit(tr)) return true;
      const block = tr.startState.field(markdownCommentField, false)?.block;
      if (!block) return true;
      let after = false;
      tr.changes.iterChangedRanges((fromA) => { if (fromA > block.hideFrom) after = true; });
      return after ? false : [block.hideFrom, tr.startState.doc.length];
    }),
  ];
}

const commentAnchorDecorations = EditorView.decorations.compute([markdownCommentField], (state) => {
  const value = state.field(markdownCommentField, false);
  if (!value || (!value.positions.size && !value.draft)) return Decoration.none;
  const ranges = [];
  for (const thread of value.block?.threads ?? []) {
    const position = value.positions.get(thread.id);
    if (!position) continue;
    const active = thread.id === value.activeId;
    if (thread.status === "resolved" && !value.showResolved && !active) continue;
    ranges.push(Decoration.mark({
      class: `cm-comment-anchor${active ? " is-active" : ""}${thread.status === "resolved" ? " is-resolved" : ""}`,
      attributes: { "data-comment-id": thread.id },
    }).range(position.from, position.to));
  }
  if (value.draft) ranges.push(Decoration.mark({ class: "cm-comment-anchor is-active is-draft" }).range(value.draft.from, value.draft.to));
  return Decoration.set(ranges, true);
});

const commentTheme = EditorView.baseTheme({
  ".cm-comment-anchor": {
    textDecorationLine: "underline",
    textDecorationColor: "color-mix(in srgb, var(--accent-color) 55%, transparent)",
    textDecorationThickness: "1.5px",
    textUnderlineOffset: "3px",
    cursor: "pointer",
  },
  ".cm-comment-anchor.is-resolved": {
    textDecorationStyle: "dashed",
    textDecorationColor: "color-mix(in srgb, var(--text-secondary) 55%, transparent)",
  },
  ".cm-comment-anchor.is-active": {
    textDecorationColor: "var(--accent-color)",
    textDecorationThickness: "2px",
    backgroundColor: "color-mix(in srgb, var(--accent-color) 10%, transparent)",
  },
});

/** Rewrites the selectors of threads whose context was edited. */
export function reanchorStaleComments(view: EditorView): boolean {
  const value = view.state.field(markdownCommentField, false);
  if (!value?.stale.size) return false;
  const stale = [...value.stale];
  const block = value.block;
  if (!block?.writable || view.state.readOnly) {
    view.dispatch({ effects: clearStaleComments.of(stale) });
    return false;
  }
  const body = view.state.doc.sliceString(0, block.from);
  const changes: TextChange[] = [];
  const positions: Array<CommentPosition & { id: string }> = [];
  for (const id of stale) {
    const thread = block.threads.find((item) => item.id === id);
    const position = value.positions.get(id);
    if (!thread?.anchor || !position) continue;
    const anchor = createCommentAnchor(body, position.from, position.to);
    if (sameAnchor(anchor, thread.anchor)) continue;
    const change = replaceCommentThreadChange(block, { ...thread, anchor });
    if (!change) continue;
    changes.push(change);
    positions.push({ id, ...position });
  }
  view.dispatch({
    changes,
    effects: [setCommentPositions.of(positions), clearStaleComments.of(stale)],
    annotations: Transaction.addToHistory.of(false),
    userEvent: `${COMMENT_USER_EVENT}.anchor`,
  });
  return changes.length > 0;
}

const reanchorPlugin = ViewPlugin.fromClass(class {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;

  constructor(private readonly view: EditorView) {}

  update(update: ViewUpdate): void {
    const value = update.state.field(markdownCommentField, false);
    if (!value?.stale.size || update.state.readOnly) return;
    if (update.docChanged || this.timer === null) this.schedule();
  }

  private schedule(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.destroyed) return;
      if (this.view.composing) {
        this.schedule();
        return;
      }
      reanchorStaleComments(this.view);
    }, REANCHOR_DELAY_MS);
  }

  destroy(): void {
    this.destroyed = true;
    if (this.timer !== null) clearTimeout(this.timer);
  }
});

export interface MarkdownCommentSync {
  attach(view: EditorView): void;
  detach(view: EditorView): void;
  sync(update: ViewUpdate): void;
}

export interface MarkdownCommentExtensionOptions {
  /** Hide the block (rendered mode). */
  hideBlock: boolean;
  /** Comment UI bridge; underlines and clicks are active only with it. */
  sync?: MarkdownCommentSync | null;
}

export function markdownCommentExtensions(options: MarkdownCommentExtensionOptions): Extension {
  const extensions: Extension[] = [markdownCommentField, reanchorPlugin];
  if (options.hideBlock) extensions.push(hiddenBlockExtensions());
  const sync = options.sync;
  if (sync) {
    extensions.push(
      commentAnchorDecorations,
      commentTheme,
      ViewPlugin.define((view) => {
        sync.attach(view);
        return {
          update: (update) => sync.sync(update),
          destroy: () => sync.detach(view),
        };
      }),
      EditorView.domEventHandlers({
        click(event, view) {
          const target = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-comment-id]") : null;
          const id = target && view.contentDOM.contains(target) ? target.dataset.commentId ?? null : null;
          const current = view.state.field(markdownCommentField, false)?.activeId ?? null;
          if (id !== current) view.dispatch({ effects: setActiveComment.of(id) });
          return false;
        },
      }),
    );
  }
  return extensions;
}

function dispatchCommentChange(view: EditorView, changes: TextChange | TextChange[], effects: StateEffect<unknown>[] = []): void {
  view.dispatch({
    changes,
    effects,
    annotations: isolateHistory.of("full"),
    userEvent: COMMENT_USER_EVENT,
  });
}

function canWriteComments(state: EditorState): boolean {
  const block = state.field(markdownCommentField, false)?.block;
  return !state.readOnly && (!block || block.writable);
}

export type CommentRangeResult = CommentPosition | "empty" | "tooLong";

/** The part of a selection that can carry a comment: body text without surrounding whitespace. */
export function commentableRange(state: EditorState, from: number, to: number): CommentRangeResult {
  const block = state.field(markdownCommentField, false)?.block;
  const limit = block ? contentEndBefore(state.doc, block.from) : state.doc.length;
  let start = Math.max(Math.min(from, to), frontmatterEndOffset(state.doc));
  let end = Math.min(Math.max(from, to), limit);
  const text = end > start ? state.doc.sliceString(start, end) : "";
  const leading = text.length - text.trimStart().length;
  const trailing = text.length - text.trimEnd().length;
  start += leading;
  end -= trailing;
  if (end <= start) return "empty";
  if (end - start > MAX_COMMENT_QUOTE_LENGTH) return "tooLong";
  return { from: start, to: end };
}

function nowIso(): string {
  return new Date().toISOString();
}

export function addMarkdownComment(view: EditorView, range: CommentPosition, text: string, author: string): string | null {
  const state = view.state;
  if (!canWriteComments(state) || !text.trim()) return null;
  const target = commentableRange(state, range.from, range.to);
  if (typeof target === "string") return null;
  const block = state.field(markdownCommentField, false)?.block ?? null;
  const body = state.doc.sliceString(0, block?.from ?? state.doc.length);
  const id = createCommentId(block?.threads.map((thread) => thread.id) ?? []);
  const thread: CommentThread = {
    id,
    anchor: createCommentAnchor(body, target.from, target.to),
    status: "open",
    messages: [{ id: "m1", author, time: nowIso(), text: text.trim() }],
  };
  dispatchCommentChange(view, insertCommentThreadChange(state.doc, block, thread), [
    setCommentPositions.of([{ id, ...target }]),
    setCommentDraft.of(null),
    setActiveComment.of(id),
  ]);
  return id;
}

function updateThread(view: EditorView, id: string, mutate: (thread: CommentThread) => CommentThread | null): boolean {
  const state = view.state;
  const block = state.field(markdownCommentField, false)?.block;
  const thread = block?.threads.find((item) => item.id === id);
  if (!block || !thread || !canWriteComments(state)) return false;
  const next = mutate(thread);
  const change = next ? replaceCommentThreadChange(block, next) : removeCommentThreadChange(state.doc, block, id);
  if (!change) return false;
  dispatchCommentChange(view, change, next ? [] : [setActiveComment.of(null)]);
  return true;
}

export function replyMarkdownComment(view: EditorView, id: string, text: string, author: string): boolean {
  if (!text.trim()) return false;
  return updateThread(view, id, (thread) => ({
    ...thread,
    messages: [...thread.messages, { id: nextCommentMessageId(thread), author, time: nowIso(), text: text.trim() }],
  }));
}

export function editMarkdownCommentMessage(view: EditorView, id: string, messageId: string, text: string): boolean {
  if (!text.trim()) return false;
  return updateThread(view, id, (thread) => ({
    ...thread,
    messages: thread.messages.map((message) => message.id === messageId && message.text !== text.trim()
      ? { ...message, text: text.trim(), edited: nowIso() }
      : message),
  }));
}

/** Deletes one message; the thread goes away with its last message. */
export function deleteMarkdownCommentMessage(view: EditorView, id: string, messageId: string): boolean {
  return updateThread(view, id, (thread) => {
    const messages = thread.messages.filter((message) => message.id !== messageId);
    return messages.length ? { ...thread, messages } : null;
  });
}

export function setMarkdownCommentStatus(view: EditorView, id: string, status: CommentStatus): boolean {
  return updateThread(view, id, (thread) => thread.status === status ? thread : { ...thread, status });
}

export function deleteMarkdownComment(view: EditorView, id: string): boolean {
  return updateThread(view, id, () => null);
}

/** Moves a thread's anchor to a new range (for detached threads). */
export function reattachMarkdownComment(view: EditorView, id: string, range: CommentPosition): boolean {
  const state = view.state;
  const block = state.field(markdownCommentField, false)?.block;
  const thread = block?.threads.find((item) => item.id === id);
  const target = commentableRange(state, range.from, range.to);
  if (!block || !thread || typeof target === "string" || !canWriteComments(state)) return false;
  const anchor = createCommentAnchor(state.doc.sliceString(0, block.from), target.from, target.to);
  const change = replaceCommentThreadChange(block, { ...thread, anchor });
  if (!change) return false;
  dispatchCommentChange(view, change, [setCommentPositions.of([{ id, ...target }]), setActiveComment.of(id)]);
  return true;
}

export function setActiveMarkdownComment(view: EditorView, id: string | null): void {
  if ((view.state.field(markdownCommentField, false)?.activeId ?? null) === id) return;
  view.dispatch({ effects: setActiveComment.of(id) });
}

export function setMarkdownCommentDraft(view: EditorView, range: CommentPosition | null): void {
  view.dispatch({ effects: [setCommentDraft.of(range), ...(range ? [setActiveComment.of(null)] : [])] });
}

export function setShowResolvedMarkdownComments(view: EditorView, show: boolean): void {
  view.dispatch({ effects: setShowResolvedComments.of(show) });
}
