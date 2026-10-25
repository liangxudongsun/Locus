// @vitest-environment jsdom
import { markdown } from "@codemirror/lang-markdown";
import { EditorSelection, EditorState, Transaction } from "@codemirror/state";
import { history, selectAll, undo } from "@codemirror/commands";
import { EditorView } from "@codemirror/view";
import { GFM } from "@lezer/markdown";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COMMENT_BLOCK_HEADER, createCommentAnchor, findCommentBlock, serializeCommentThread, type CommentThread } from "../document/markdownComments";
import {
  addMarkdownComment,
  commentableRange,
  deleteMarkdownComment,
  markdownCommentExtensions,
  markdownCommentField,
  reanchorStaleComments,
  replyMarkdownComment,
  setMarkdownCommentStatus,
  type MarkdownCommentSync,
} from "../components/ui/markdown-editor/markdownCommentEditing";
import {
  footnoteNumber,
  footnoteText,
  insertMarkdownFootnote,
  markdownFootnoteExtensions,
  markdownFootnoteIndex,
  removeMarkdownFootnote,
  updateMarkdownFootnote,
} from "../components/ui/markdown-editor/markdownFootnoteEditing";
import { markdownFootnoteSyntax } from "../components/ui/markdown-editor/markdownFootnoteSyntax";
import { markdownLivePreview } from "../components/ui/markdown-editor/markdownLivePreview";

let view: EditorView | null = null;

const sync: MarkdownCommentSync = { attach: vi.fn(), detach: vi.fn(), sync: vi.fn() };

function mount(doc: string, options: { hideBlock?: boolean; preview?: boolean } = {}): EditorView {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      extensions: [
        history(),
        markdown({ extensions: [GFM, markdownFootnoteSyntax] }),
        markdownFootnoteExtensions(),
        markdownCommentExtensions({ hideBlock: options.hideBlock ?? true, sync }),
        ...(options.preview ? [markdownLivePreview()] : []),
      ],
    }),
  });
  return view;
}

function documentWith(body: string, threads: CommentThread[]): string {
  return `${body}\n\n${COMMENT_BLOCK_HEADER}\n${threads.map(serializeCommentThread).join("\n")}\n-->\n`;
}

function thread(id: string, body: string, quote: string): CommentThread {
  const from = body.indexOf(quote);
  return {
    id,
    anchor: createCommentAnchor(body, from, from + quote.length),
    status: "open",
    messages: [{ id: "m1", author: "Enno", time: "2026-10-23T00:00:00.000Z", text: "check" }],
  };
}

const field = (target: EditorView) => target.state.field(markdownCommentField);

beforeEach(() => {
  vi.useFakeTimers();
  if (!(Range.prototype as Range & { getClientRects?: unknown }).getClientRects) {
    Object.defineProperty(Range.prototype, "getClientRects", { configurable: true, value: () => [] });
  }
  if (!(Range.prototype as Range & { getBoundingClientRect?: unknown }).getBoundingClientRect) {
    Object.defineProperty(Range.prototype, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 }),
    });
  }
});

afterEach(() => {
  view?.destroy();
  view = null;
  document.body.replaceChildren();
  vi.useRealTimers();
});

describe("markdown comment editor state", () => {
  it("resolves anchors on open and follows edits without rewriting the file", () => {
    const body = `Alpha beta gamma. ${"filler ".repeat(10)}Delta epsilon.`;
    const start = body.indexOf("Delta");
    const target = mount(documentWith(body, [thread("aaaaaa", body, "Delta")]));
    expect(field(target).positions.get("aaaaaa")).toEqual({ from: start, to: start + 5 });
    expect(sync.attach).toHaveBeenCalledWith(target);

    target.dispatch({ changes: { from: 0, insert: "Intro. " }, userEvent: "input.type" });
    expect(field(target).positions.get("aaaaaa")).toEqual({ from: start + 7, to: start + 12 });
    expect(field(target).stale.size).toBe(0);

    // External updates move positions but never mark selectors stale.
    target.dispatch({ changes: { from: start + 7, to: start + 12, insert: "DELTA" } });
    expect(field(target).stale.size).toBe(0);
  });

  it("refreshes stored selectors after a user edits the quoted text", () => {
    const body = "Alpha beta gamma. Delta epsilon.";
    const target = mount(documentWith(body, [thread("aaaaaa", body, "Delta")]));
    target.dispatch({ changes: { from: 19, insert: "x" }, userEvent: "input.type" });
    expect(field(target).stale.has("aaaaaa")).toBe(true);

    vi.advanceTimersByTime(1000);
    const block = findCommentBlock(target.state.doc)!;
    expect(block.threads[0].anchor?.exact).toBe("Dxelta");
    expect(field(target).stale.size).toBe(0);
    expect(field(target).positions.get("aaaaaa")).toEqual({ from: 18, to: 24 });
  });

  it("adds, replies, resolves and deletes threads as undoable edits", () => {
    const body = "Plain text to review.";
    const target = mount(body);
    const range = commentableRange(target.state, 6, 14);
    expect(range).toEqual({ from: 6, to: 13 });
    const id = addMarkdownComment(target, { from: 6, to: 14 }, "why?", "Enno")!;
    expect(target.state.doc.toString().startsWith(`${body}\n\n${COMMENT_BLOCK_HEADER}\n`)).toBe(true);
    expect(field(target).positions.get(id)).toEqual({ from: 6, to: 13 });
    expect(field(target).activeId).toBe(id);

    expect(replyMarkdownComment(target, id, "because", "Ann")).toBe(true);
    expect(setMarkdownCommentStatus(target, id, "resolved")).toBe(true);
    const saved = findCommentBlock(target.state.doc)!.threads[0];
    expect(saved.status).toBe("resolved");
    expect(saved.messages.map((message) => [message.id, message.author, message.text])).toEqual([["m1", "Enno", "why?"], ["m2", "Ann", "because"]]);

    expect(deleteMarkdownComment(target, id)).toBe(true);
    expect(target.state.doc.toString()).toBe(`${body}\n`);
    undo(target);
    expect(findCommentBlock(target.state.doc)?.threads[0].status).toBe("resolved");
    expect(field(target).positions.get(id)).toEqual({ from: 6, to: 13 });
  });

  it("detaches threads whose text disappears", () => {
    const body = "Keep this. Remove that.";
    const target = mount(documentWith(body, [thread("aaaaaa", body, "Remove that")]));
    target.dispatch({ changes: { from: 11, to: 22 }, userEvent: "delete.selection" });
    expect(field(target).positions.has("aaaaaa")).toBe(false);
    expect(field(target).block?.threads).toHaveLength(1);
  });
});

describe("hidden comment block", () => {
  const body = "Body text.";
  const source = () => documentWith(body, [thread("aaaaaa", body, "Body")]);

  it("keeps selections and typing in front of the block", () => {
    const target = mount(source());
    const hideFrom = field(target).block!.hideFrom;
    selectAll(target);
    expect(target.state.selection.main.to).toBe(hideFrom);
    target.dispatch({ selection: EditorSelection.cursor(target.state.doc.length) });
    expect(target.state.selection.main.head).toBe(hideFrom);

    const before = target.state.doc.toString();
    target.dispatch({ changes: { from: target.state.doc.length, insert: "x" }, userEvent: "input.type" });
    target.dispatch({ changes: { from: hideFrom, to: target.state.doc.length }, userEvent: "delete.forward" });
    expect(target.state.doc.toString()).toBe(before);

    target.dispatch({ changes: { from: hideFrom, insert: "More" }, userEvent: "input.type" });
    expect(target.state.doc.toString().startsWith(`${body}\nMore\n${COMMENT_BLOCK_HEADER}`)).toBe(true);
    expect(field(target).block?.threads).toHaveLength(1);
  });

  it("leaves the block editable in source mode", () => {
    const target = mount(source(), { hideBlock: false });
    target.dispatch({ changes: { from: target.state.doc.length - 4, to: target.state.doc.length }, userEvent: "delete.backward" });
    expect(field(target).block).toBeNull();
  });

  it("keeps the block when undo history and external sync change it", () => {
    const target = mount(source());
    target.dispatch({ changes: { from: 0, to: target.state.doc.length, insert: body }, annotations: Transaction.addToHistory.of(false) });
    expect(target.state.doc.toString()).toBe(body);
    expect(field(target).block).toBeNull();
  });
});

describe("markdown footnotes in the editor", () => {
  it("inserts, edits and removes numbered footnotes", () => {
    const body = "First sentence. Second sentence.";
    const target = mount(documentWith(body, [thread("aaaaaa", body, "Second")]));
    target.dispatch({ selection: EditorSelection.cursor(15) });
    const key = insertMarkdownFootnote(target)!;
    expect(key).toBe("1");
    expect(target.state.doc.toString().startsWith(`First sentence.[^1] Second sentence.\n\n[^1]: \n\n${COMMENT_BLOCK_HEADER}`)).toBe(true);
    expect(field(target).positions.get("aaaaaa")).toEqual({ from: 20, to: 26 });

    expect(updateMarkdownFootnote(target, key, "Note text\nsecond line")).toBe(true);
    expect(footnoteText(target.state, key)).toBe("Note text\nsecond line");
    expect(target.state.field(markdownFootnoteIndex).definitions).toHaveLength(1);

    target.dispatch({ selection: EditorSelection.cursor(4) });
    expect(insertMarkdownFootnote(target)).toBe("2");
    expect(footnoteNumber(target.state, "2")).toBe(1);
    expect(footnoteNumber(target.state, "1")).toBe(2);

    expect(removeMarkdownFootnote(target, "1")).toBe(true);
    expect(target.state.doc.toString()).toContain("Firs[^2]t sentence. Second sentence.\n\n[^2]: \n\n");
    expect(target.state.doc.toString()).not.toContain("[^1]");
  });

  it("renders references as superscript numbers in rendered mode", () => {
    const target = mount("See[^b] and[^a].\n\n[^a]: A\n[^b]: B\n", { preview: true });
    const refs = [...target.contentDOM.querySelectorAll("sup.cm-footnote-ref")].map((element) => element.textContent);
    expect(refs).toEqual(["1", "2"]);
    const labels = [...target.contentDOM.querySelectorAll(".cm-footnote-def-label")].map((element) => element.textContent);
    expect(labels).toEqual(["2", "1"]);
  });

  it("renders comment anchors as underlined marks", () => {
    const body = "Alpha beta gamma.";
    const target = mount(documentWith(body, [thread("aaaaaa", body, "beta")]), { preview: true });
    const anchor = target.contentDOM.querySelector<HTMLElement>(".cm-comment-anchor");
    expect(anchor?.textContent).toBe("beta");
    expect(anchor?.dataset.commentId).toBe("aaaaaa");
    expect(target.contentDOM.textContent).not.toContain("locus:comments");
  });

  it("keeps reanchoring a no-op without stale threads", () => {
    const target = mount("text");
    expect(reanchorStaleComments(target)).toBe(false);
  });
});
