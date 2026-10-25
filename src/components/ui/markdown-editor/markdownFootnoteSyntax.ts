import type { BlockContext, LeafBlock, LeafBlockParser, MarkdownConfig } from "@lezer/markdown";
import { tags } from "@lezer/highlight";

/**
 * Footnote syntax for the editor parser: `[^label]` references and
 * `[^label]: text` definitions (one paragraph with lazy or indented
 * continuation lines). Mirrors the scan in `document/markdownFootnotes.ts`.
 */

const DEFINITION_START = /^\[\^([^\s[\]]{1,100})\]:/;
const MAX_LABEL_LENGTH = 100;

class FootnoteDefinitionParser implements LeafBlockParser {
  nextLine(_cx: BlockContext, _line: unknown, leaf: LeafBlock): boolean {
    // Keep the whole paragraph a definition: link references, setext headings
    // and tables registered after this parser would otherwise claim it.
    const index = leaf.parsers.indexOf(this);
    if (index >= 0) leaf.parsers.splice(index + 1);
    return false;
  }

  finish(cx: BlockContext, leaf: LeafBlock): boolean {
    const match = DEFINITION_START.exec(leaf.content);
    if (!match) return false;
    const labelEnd = leaf.start + match[0].length;
    cx.addLeafElement(leaf, cx.elt("FootnoteDefinition", leaf.start, leaf.start + leaf.content.length, [
      cx.elt("FootnoteDefinitionMark", leaf.start, labelEnd, [
        cx.elt("FootnoteLabel", leaf.start + 2, labelEnd - 2),
      ]),
      ...cx.parser.parseInline(leaf.content.slice(match[0].length), labelEnd),
    ]));
    return true;
  }
}

export const markdownFootnoteSyntax: MarkdownConfig = {
  defineNodes: [
    { name: "FootnoteReference", style: tags.link },
    { name: "FootnoteMark", style: tags.processingInstruction },
    { name: "FootnoteLabel", style: tags.labelName },
    { name: "FootnoteDefinition", block: true },
    { name: "FootnoteDefinitionMark", style: tags.processingInstruction },
  ],
  parseBlock: [{
    name: "FootnoteDefinition",
    leaf: (_cx, leaf) => DEFINITION_START.test(leaf.content) ? new FootnoteDefinitionParser() : null,
    endLeaf: (_cx, line) => DEFINITION_START.test(line.text.slice(line.pos)),
    before: "LinkReference",
  }],
  parseInline: [{
    name: "FootnoteReference",
    before: "Link",
    parse(cx, next, pos) {
      if (next !== 91 /* [ */ || cx.char(pos + 1) !== 94 /* ^ */) return -1;
      let end = pos + 2;
      while (end < cx.end) {
        const code = cx.char(end);
        if (code === 93 /* ] */) break;
        if (code === 91 || code === 32 || code === 9 || code === 10 || code === 13) return -1;
        end += 1;
        if (end - pos - 2 > MAX_LABEL_LENGTH) return -1;
      }
      if (end >= cx.end || end === pos + 2) return -1;
      return cx.addElement(cx.elt("FootnoteReference", pos, end + 1, [
        cx.elt("FootnoteMark", pos, pos + 2),
        cx.elt("FootnoteLabel", pos + 2, end),
        cx.elt("FootnoteMark", end, end + 1),
      ]));
    },
  }],
};
