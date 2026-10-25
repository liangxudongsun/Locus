import { computed, ref, shallowRef } from "vue";
import type { EditorState } from "@codemirror/state";
import type { EditorView, ViewUpdate } from "@codemirror/view";
import type { CommentMessage, CommentStatus } from "../../../document/markdownComments";
import {
  addMarkdownComment,
  commentableRange,
  deleteMarkdownComment,
  deleteMarkdownCommentMessage,
  editMarkdownCommentMessage,
  markdownCommentField,
  reattachMarkdownComment,
  replyMarkdownComment,
  setActiveMarkdownComment,
  setMarkdownCommentDraft,
  setMarkdownCommentStatus,
  setShowResolvedMarkdownComments,
  type CommentPosition,
  type MarkdownCommentFieldValue,
  type MarkdownCommentSync,
} from "./markdownCommentEditing";

/** Container width from which the comment rail is shown (see markdown-document.css). */
export function commentRailMinWidth(hasOutline: boolean): number {
  return hasOutline ? 1400 : 1120;
}

export interface MarkdownCommentThreadView {
  id: string;
  status: CommentStatus;
  messages: readonly CommentMessage[];
  quote: string;
  /** A comment on the whole document. */
  document: boolean;
  /** The quoted text was found in the current document. */
  anchored: boolean;
}

export interface MarkdownCommentDraftView extends CommentPosition {
  quote: string;
}

export type CommentDraftResult = "ok" | "empty" | "tooLong" | "readOnly";

/**
 * Bridges one Markdown editor and the comment UI (rail, popover). The editor
 * state stays the source of truth; this mirrors what the UI renders and
 * forwards actions back as editor transactions.
 */
export class MarkdownCommentController implements MarkdownCommentSync {
  readonly view = shallowRef<EditorView | null>(null);
  readonly threads = shallowRef<readonly MarkdownCommentThreadView[]>([]);
  readonly activeId = ref<string | null>(null);
  readonly draft = shallowRef<MarkdownCommentDraftView | null>(null);
  readonly showResolved = ref(false);
  /** The document can be edited. */
  readonly editable = ref(false);
  /** The comment format version can be written. */
  readonly writable = ref(true);
  /** The rail column is wide enough to show; otherwise threads open as popovers. */
  readonly railAvailable = ref(false);
  /** Bumped when anchor geometry may have moved. */
  readonly layoutTick = ref(0);
  readonly hasRailContent = computed(() => this.threads.value.length > 0 || !!this.draft.value);
  readonly canEdit = computed(() => this.editable.value && this.writable.value);

  private lastValue: MarkdownCommentFieldValue | null = null;
  private anchoredKey = "";

  attach(view: EditorView): void {
    this.view.value = view;
    this.lastValue = null;
    this.anchoredKey = "";
    this.update(view.state);
    this.layoutTick.value += 1;
  }

  detach(view: EditorView): void {
    if (this.view.value !== view) return;
    this.view.value = null;
    this.lastValue = null;
    this.threads.value = [];
    this.activeId.value = null;
    this.draft.value = null;
  }

  sync(update: ViewUpdate): void {
    if (update.view !== this.view.value) return;
    this.update(update.state);
    if (update.docChanged || update.geometryChanged || update.viewportChanged || update.heightChanged) {
      this.layoutTick.value += 1;
    }
  }

  private update(state: EditorState): void {
    this.editable.value = !state.readOnly;
    const value = state.field(markdownCommentField, false) ?? null;
    if (value === this.lastValue) return;
    const previous = this.lastValue;
    this.lastValue = value;
    if (!value) {
      this.threads.value = [];
      this.activeId.value = null;
      this.draft.value = null;
      return;
    }
    this.writable.value = value.block?.writable ?? true;
    const anchoredKey = [...value.positions.keys()].sort().join(" ");
    if (!previous || previous.block?.threads !== value.block?.threads || anchoredKey !== this.anchoredKey) {
      this.anchoredKey = anchoredKey;
      this.threads.value = (value.block?.threads ?? []).map((thread) => ({
        id: thread.id,
        status: thread.status,
        messages: thread.messages,
        quote: thread.anchor?.exact ?? "",
        document: !thread.anchor,
        anchored: value.positions.has(thread.id),
      }));
    }
    if (this.activeId.value !== value.activeId) this.activeId.value = value.activeId;
    if (this.showResolved.value !== value.showResolved) this.showResolved.value = value.showResolved;
    const draft = value.draft;
    if (!draft) {
      if (this.draft.value) this.draft.value = null;
    } else if (!this.draft.value || this.draft.value.from !== draft.from || this.draft.value.to !== draft.to) {
      this.draft.value = { ...draft, quote: state.doc.sliceString(draft.from, draft.to) };
    }
  }

  /** Current position of an anchored thread. */
  position(id: string): CommentPosition | null {
    return this.view.value?.state.field(markdownCommentField, false)?.positions.get(id) ?? null;
  }

  activate(id: string | null): void {
    const view = this.view.value;
    if (view) setActiveMarkdownComment(view, id);
  }

  /** Starts a comment on the current selection. */
  startDraft(): CommentDraftResult {
    const view = this.view.value;
    if (!view || !this.canEdit.value) return "readOnly";
    const selection = view.state.selection.main;
    const range = commentableRange(view.state, selection.from, selection.to);
    if (typeof range === "string") return range;
    setMarkdownCommentDraft(view, range);
    return "ok";
  }

  cancelDraft(): void {
    const view = this.view.value;
    if (view && this.draft.value) setMarkdownCommentDraft(view, null);
  }

  submitDraft(text: string, author: string): boolean {
    const view = this.view.value;
    const draft = view?.state.field(markdownCommentField, false)?.draft;
    return !!view && !!draft && !!addMarkdownComment(view, draft, text, author);
  }

  reply(id: string, text: string, author: string): boolean {
    const view = this.view.value;
    return !!view && replyMarkdownComment(view, id, text, author);
  }

  editMessage(id: string, messageId: string, text: string): boolean {
    const view = this.view.value;
    return !!view && editMarkdownCommentMessage(view, id, messageId, text);
  }

  deleteMessage(id: string, messageId: string): boolean {
    const view = this.view.value;
    return !!view && deleteMarkdownCommentMessage(view, id, messageId);
  }

  setStatus(id: string, status: CommentStatus): boolean {
    const view = this.view.value;
    return !!view && setMarkdownCommentStatus(view, id, status);
  }

  remove(id: string): boolean {
    const view = this.view.value;
    return !!view && deleteMarkdownComment(view, id);
  }

  /** Whether the editor selection can anchor a detached thread. */
  selectionCommentable(): boolean {
    const view = this.view.value;
    if (!view) return false;
    const selection = view.state.selection.main;
    return typeof commentableRange(view.state, selection.from, selection.to) !== "string";
  }

  reattach(id: string): boolean {
    const view = this.view.value;
    if (!view) return false;
    const selection = view.state.selection.main;
    return reattachMarkdownComment(view, id, selection);
  }

  setShowResolved(show: boolean): void {
    const view = this.view.value;
    if (view) setShowResolvedMarkdownComments(view, show);
  }
}

export function createMarkdownCommentController(): MarkdownCommentController {
  return new MarkdownCommentController();
}

export interface CommentCardLayoutItem {
  key: string;
  /** Desired top, relative to the rail. */
  desired: number;
  height: number;
  /** Document position; orders cards that start on the same line. */
  order?: number;
}

/**
 * Card tops for the rail: cards sit at their anchors and are pushed apart
 * where they would overlap. The active card keeps its anchor position; the
 * cards above it move up.
 */
export function layoutCommentCards(items: readonly CommentCardLayoutItem[], activeKey: string | null, gap = 8): Map<string, number> {
  const sorted = [...items].sort((a, b) => (a.desired - b.desired) || ((a.order ?? 0) - (b.order ?? 0)));
  const tops = sorted.map((item) => Math.max(0, item.desired));
  const activeIndex = activeKey ? sorted.findIndex((item) => item.key === activeKey) : -1;
  const pushDown = (start: number) => {
    for (let index = Math.max(1, start); index < sorted.length; index += 1) {
      tops[index] = Math.max(tops[index], tops[index - 1] + sorted[index - 1].height + gap);
    }
  };
  if (activeIndex < 0) {
    pushDown(1);
  } else {
    pushDown(activeIndex + 1);
    for (let index = activeIndex - 1; index >= 0; index -= 1) {
      tops[index] = Math.min(tops[index], tops[index + 1] - gap - sorted[index].height);
    }
    if (tops[0] < 0) {
      tops[0] = 0;
      pushDown(1);
    }
  }
  return new Map(sorted.map((item, index) => [item.key, tops[index]]));
}

/** Compact local time: `MM-DD HH:mm`, with the year when it differs. */
export function formatCommentTime(iso: string, now = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (value: number) => String(value).padStart(2, "0");
  const day = `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return date.getFullYear() === now.getFullYear() ? day : `${date.getFullYear()}-${day}`;
}
