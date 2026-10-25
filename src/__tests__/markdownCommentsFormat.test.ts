import { Text } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import {
  COMMENT_BLOCK_HEADER,
  createCommentAnchor,
  findCommentBlock,
  findCommentBlockRange,
  insertCommentThreadChange,
  parseCommentThread,
  removeCommentThreadChange,
  replaceCommentThreadChange,
  resolveCommentAnchor,
  serializeCommentThread,
  type CommentThread,
  type TextChange,
} from "../document/markdownComments";
import {
  footnoteContent,
  formatFootnoteContent,
  insertFootnoteChanges,
  nextFootnoteLabel,
  removeFootnoteChanges,
  scanFootnotes,
} from "../document/markdownFootnotes";

const doc = (text: string) => Text.of(text.split("\n"));

function apply(text: string, changes: TextChange | TextChange[]): string {
  const list = (Array.isArray(changes) ? changes : [changes]).slice().sort((a, b) => b.from - a.from);
  let result = text;
  for (const change of list) result = result.slice(0, change.from) + (change.insert ?? "") + result.slice(change.to ?? change.from);
  return result;
}

function thread(id: string, text: string, anchor: CommentThread["anchor"] = { exact: "beta", prefix: "alpha ", suffix: " gamma" }): CommentThread {
  return { id, anchor, status: "open", messages: [{ id: "m1", author: "Enno", time: "2026-10-23T09:12:00.000Z", text }] };
}

describe("markdown comment block format", () => {
  it("creates, extends and removes the trailing block", () => {
    const body = "alpha beta gamma";
    const first = apply(body, insertCommentThreadChange(doc(body), null, thread("aaaaaa", "first")));
    expect(first).toBe(`${body}\n\n${COMMENT_BLOCK_HEADER}\n${serializeCommentThread(thread("aaaaaa", "first"))}\n-->\n`);

    const block = findCommentBlock(doc(first));
    expect(block?.threads.map((item) => item.id)).toEqual(["aaaaaa"]);
    expect(block?.hideFrom).toBe(body.length + 1);

    const second = apply(first, insertCommentThreadChange(doc(first), block, thread("bbbbbb", "second")));
    const both = findCommentBlock(doc(second))!;
    expect(both.threads.map((item) => item.id)).toEqual(["aaaaaa", "bbbbbb"]);

    const updated = { ...both.threads[0], status: "resolved" as const };
    const resolved = apply(second, replaceCommentThreadChange(both, updated)!);
    expect(findCommentBlock(doc(resolved))?.threads[0].status).toBe("resolved");

    const oneLeft = apply(resolved, removeCommentThreadChange(doc(resolved), findCommentBlock(doc(resolved))!, "aaaaaa")!);
    expect(findCommentBlock(doc(oneLeft))?.threads.map((item) => item.id)).toEqual(["bbbbbb"]);
    const none = apply(oneLeft, removeCommentThreadChange(doc(oneLeft), findCommentBlock(doc(oneLeft))!, "bbbbbb")!);
    expect(none).toBe(`${body}\n`);
  });

  it("never writes a line that closes the HTML comment", () => {
    const line = serializeCommentThread(thread("aaaaaa", "a --> b <!-- c </script>"));
    expect(line).not.toContain("-->");
    expect(line).not.toMatch(/[<>]/);
    expect(parseCommentThread(line)?.messages[0].text).toBe("a --> b <!-- c </script>");
  });

  it("only recognizes the block at the end of the document", () => {
    const block = `${COMMENT_BLOCK_HEADER}\n${serializeCommentThread(thread("aaaaaa", "x"))}\n-->`;
    expect(findCommentBlockRange(doc(`text\n\n${block}\n\n  \n`))).not.toBeNull();
    expect(findCommentBlockRange(doc(`text\n\n${block}\nmore text`))).toBeNull();
    expect(findCommentBlockRange(doc(`${COMMENT_BLOCK_HEADER}\n<!-- other -->\n-->`))).toBeNull();
    expect(findCommentBlockRange(doc("text\n-->"))).toBeNull();
    expect(findCommentBlockRange(doc(`text\n\n<!-- locus:comments v2\n{}\n-->`))?.version).toBe(2);
    expect(findCommentBlock(doc(`text\n\n<!-- locus:comments v2\n{}\n-->`))?.writable).toBe(false);
  });

  it("keeps unreadable lines and unknown fields", () => {
    const known = serializeCommentThread(thread("aaaaaa", "x"));
    const custom = JSON.stringify({ ...JSON.parse(known), id: "cccccc", color: "red", messages: [{ text: "y", mood: 1 }] });
    const source = `text\n\n${COMMENT_BLOCK_HEADER}\nnot json\n${custom}\n${known}\n${known}\n-->\n`;
    const block = findCommentBlock(doc(source))!;
    expect(block.threads.map((item) => item.id)).toEqual(["cccccc", "aaaaaa"]);
    expect(block.lines.filter((line) => !line.thread).map((line) => line.text)).toEqual(["not json", known]);
    const rewritten = serializeCommentThread({ ...block.threads[0], status: "resolved" });
    expect(JSON.parse(rewritten)).toMatchObject({ color: "red", status: "resolved", messages: [{ id: "m1", text: "y", mood: 1 }] });
  });
});

describe("markdown comment anchors", () => {
  it("adds context until the quote is unique and resolves it", () => {
    const body = "the cat sat. the cat ran. the cat sat again.";
    const from = body.lastIndexOf("cat");
    const anchor = createCommentAnchor(body, from, from + 3);
    expect(anchor.exact).toBe("cat");
    expect(resolveCommentAnchor(body, anchor)).toEqual({ from, to: from + 3 });
  });

  it("prefers the occurrence with matching context after edits", () => {
    const body = "intro. alpha beta gamma. omega beta delta.";
    const from = body.indexOf("beta");
    const anchor = createCommentAnchor(body, from, from + 4);
    const edited = `new first line beta\n${body}`;
    expect(resolveCommentAnchor(edited, anchor)).toEqual({ from: edited.indexOf("alpha beta") + 6, to: edited.indexOf("alpha beta") + 10 });
  });

  it("falls back to the text between the surviving context", () => {
    const body = "Before the change we migrate everything at once and then test it.";
    const from = body.indexOf("migrate");
    const anchor = createCommentAnchor(body, from, from + "migrate everything".length);
    const edited = body.replace("migrate everything", "move each module");
    expect(resolveCommentAnchor(edited, anchor)).toEqual({ from, to: from + "move each module".length });
    expect(resolveCommentAnchor("unrelated", anchor)).toBeNull();
  });
});

describe("markdown footnotes", () => {
  it("numbers footnotes by first reference and skips code", () => {
    const text = [
      "---",
      "title: x[^skip]",
      "---",
      "One[^b] two[^a] `[^code]` again[^b] \\[^esc].",
      "```",
      "[^fenced]",
      "```",
      "",
      "[^a]: Note A",
      "    continued",
      "[^b]: Note B",
      "",
      "After.",
    ].join("\n");
    const index = scanFootnotes(doc(text));
    expect(index.references.map((item) => item.label)).toEqual(["b", "a", "b"]);
    expect([...index.numbers]).toEqual([["b", 1], ["a", 2]]);
    expect(index.definitions.map((item) => item.label)).toEqual(["a", "b"]);
    expect(footnoteContent(doc(text), index.definitionByKey.get("a")!)).toBe("Note A\ncontinued");
    expect(nextFootnoteLabel(index)).toBe("1");
  });

  it("stops before the comment block", () => {
    const text = `Body[^1].\n\n[^1]: Note\n\n${COMMENT_BLOCK_HEADER}\n{"id":"aaaaaa","anchor":null,"status":"open","messages":[{"text":"see [^2]"}]}\n-->\n`;
    const end = findCommentBlockRange(doc(text))!.from;
    expect(scanFootnotes(doc(text), end).references.map((item) => item.label)).toEqual(["1"]);
  });

  it("inserts grouped definitions and removes them again", () => {
    const text = "First line.\nSecond line.";
    const first = insertFootnoteChanges(scanFootnotes(doc(text)), 5, text.length);
    const once = apply(text, first.changes);
    expect(once).toBe("First[^1] line.\nSecond line.\n\n[^1]: ");
    const filled = apply(once, { from: once.length, insert: "Note one" });
    const second = insertFootnoteChanges(scanFootnotes(doc(filled)), filled.indexOf("Second") + 6, filled.length);
    const twice = apply(filled, second.changes);
    expect(twice).toBe("First[^1] line.\nSecond[^2] line.\n\n[^1]: Note one\n[^2]: ");

    const withoutTwo = apply(twice, removeFootnoteChanges(doc(twice), scanFootnotes(doc(twice)), "2"));
    expect(withoutTwo).toBe(filled.replace(/\n$/, ""));
    const withoutOne = apply(filled, removeFootnoteChanges(doc(filled), scanFootnotes(doc(filled)), "1"));
    expect(withoutOne).toBe(text);
  });

  it("writes multi-line content as one indented paragraph", () => {
    expect(formatFootnoteContent("a\r\n\r\n b \n")).toBe("a\n    b");
  });
});
