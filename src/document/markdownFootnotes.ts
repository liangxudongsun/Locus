import type { Text } from "@codemirror/state";
import type { TextChange } from "./markdownComments";

/**
 * Standard Markdown footnotes: `[^label]` references and `[^label]: text`
 * definitions. Numbers follow the order of first reference, as on GitHub.
 * The scan skips frontmatter, fenced code and inline code so the numbering
 * matches what the editor renders.
 */

export interface FootnoteReferenceInfo {
  label: string;
  key: string;
  from: number;
  to: number;
}

export interface FootnoteDefinitionInfo {
  label: string;
  key: string;
  /** Start of `[^label]:`. */
  from: number;
  /** End of `[^label]:`. */
  labelTo: number;
  contentFrom: number;
  /** End of the definition's last line. */
  contentTo: number;
}

export interface FootnoteIndex {
  references: FootnoteReferenceInfo[];
  definitions: FootnoteDefinitionInfo[];
  /** Display number per label key, by first reference. */
  numbers: Map<string, number>;
  definitionByKey: Map<string, FootnoteDefinitionInfo>;
}

export const EMPTY_FOOTNOTE_INDEX: FootnoteIndex = {
  references: [],
  definitions: [],
  numbers: new Map(),
  definitionByKey: new Map(),
};

export const FOOTNOTE_LABEL_SOURCE = "[^\\s\\[\\]]{1,100}";
const DEFINITION_PATTERN = new RegExp(`^( {0,3})\\[\\^(${FOOTNOTE_LABEL_SOURCE})\\]:[\\t ]?`);
const REFERENCE_PATTERN = new RegExp(`\\[\\^(${FOOTNOTE_LABEL_SOURCE})\\]`, "g");
const FENCE_PATTERN = /^ {0,3}(`{3,}|~{3,})/;
const FRONTMATTER_OPEN = new RegExp("^\uFEFF?---[\t ]*$");
/** Lines that end a definition paragraph (CommonMark interrupting blocks). */
const INTERRUPT_PATTERN = /^ {0,3}(?:#{1,6}(?:[\t ]|$)|`{3,}|~{3,}|>|[-+*](?:[\t ]|$)|\d{1,9}[.)](?:[\t ]|$)|([-*_])(?:[\t ]*\1){2,}[\t ]*$|<)/;

export function footnoteKey(label: string): string {
  return label.toLowerCase();
}

export function isFootnoteDefinitionLine(text: string): boolean {
  return DEFINITION_PATTERN.test(text);
}

/** Replaces inline code spans with spaces, keeping offsets. */
function maskInlineCode(text: string): string {
  if (!text.includes("`")) return text;
  let result = "";
  let index = 0;
  while (index < text.length) {
    if (text[index] !== "`") {
      result += text[index];
      index += 1;
      continue;
    }
    let run = 1;
    while (text[index + run] === "`") run += 1;
    const fence = "`".repeat(run);
    let search = index + run;
    let close = -1;
    while (search <= text.length) {
      const found = text.indexOf(fence, search);
      if (found < 0) break;
      let end = found + run;
      if (text[end] !== "`" && text[found - 1] !== "`") { close = found; break; }
      while (text[end] === "`") end += 1;
      search = end;
    }
    if (close < 0) {
      result += fence;
      index += run;
      continue;
    }
    result += " ".repeat(close + run - index);
    index = close + run;
  }
  return result;
}

function frontmatterEndLine(doc: Text): number {
  if (doc.lines < 2 || !FRONTMATTER_OPEN.test(doc.line(1).text)) return 0;
  for (let number = 2; number <= doc.lines; number += 1) {
    if (/^(?:---|\.\.\.)[\t ]*$/.test(doc.line(number).text)) return number;
  }
  return 0;
}

/** Offset after the frontmatter block (its closing line), or 0. */
export function frontmatterEndOffset(doc: Text): number {
  const line = frontmatterEndLine(doc);
  return line ? doc.line(line).to : 0;
}

/** Native substring search over text chunks; `[^` never spans a line break. */
function mayContainFootnotes(doc: Text, end: number): boolean {
  let position = 0;
  for (const iterator = doc.iter(); position < end && !iterator.next().done;) {
    if (!iterator.lineBreak && iterator.value.includes("[^")) return true;
    position += iterator.value.length;
  }
  return false;
}

/** Scans footnotes in `doc[0, end)` (end excludes the trailing comment block). */
export function scanFootnotes(doc: Text, end = doc.length): FootnoteIndex {
  if (!mayContainFootnotes(doc, end)) return EMPTY_FOOTNOTE_INDEX;
  const references: FootnoteReferenceInfo[] = [];
  const definitions: FootnoteDefinitionInfo[] = [];
  const lastLine = doc.lineAt(Math.max(0, Math.min(end, doc.length))).number;
  let fence: { char: string; size: number } | null = null;
  let definition: FootnoteDefinitionInfo | null = null;
  for (let number = frontmatterEndLine(doc) + 1; number <= lastLine; number += 1) {
    const line = doc.line(number);
    if (line.from >= end && number > 1) break;
    const text = line.text;
    if (fence) {
      const closing = new RegExp(`^ {0,3}${fence.char === "`" ? "`" : "~"}{${fence.size},}[\\t ]*$`);
      if (closing.test(text)) fence = null;
      continue;
    }
    const opening = FENCE_PATTERN.exec(text);
    if (opening) {
      definition = null;
      fence = { char: opening[1][0], size: opening[1].length };
      continue;
    }
    if (!text.trim()) {
      definition = null;
      continue;
    }
    const masked = maskInlineCode(text);
    let scanFrom = 0;
    const definitionMatch = DEFINITION_PATTERN.exec(masked);
    if (definitionMatch) {
      const label = definitionMatch[2];
      const labelFrom = line.from + definitionMatch[1].length;
      definition = {
        label,
        key: footnoteKey(label),
        from: labelFrom,
        labelTo: labelFrom + label.length + 4,
        contentFrom: line.from + definitionMatch[0].length,
        contentTo: line.to,
      };
      definitions.push(definition);
      scanFrom = definitionMatch[0].length;
    } else if (definition) {
      const indented = /^(?: {4}|\t)/.test(text);
      if (indented || !INTERRUPT_PATTERN.test(text)) definition.contentTo = line.to;
      else definition = null;
    }
    REFERENCE_PATTERN.lastIndex = scanFrom;
    for (let match = REFERENCE_PATTERN.exec(masked); match; match = REFERENCE_PATTERN.exec(masked)) {
      if (masked[match.index - 1] === "\\") continue;
      references.push({
        label: match[1],
        key: footnoteKey(match[1]),
        from: line.from + match.index,
        to: line.from + match.index + match[0].length,
      });
    }
  }
  return indexFootnotes(references, definitions);
}

export function indexFootnotes(references: FootnoteReferenceInfo[], definitions: FootnoteDefinitionInfo[]): FootnoteIndex {
  const numbers = new Map<string, number>();
  for (const reference of references) {
    if (!numbers.has(reference.key)) numbers.set(reference.key, numbers.size + 1);
  }
  const definitionByKey = new Map<string, FootnoteDefinitionInfo>();
  for (const definition of definitions) {
    if (!definitionByKey.has(definition.key)) definitionByKey.set(definition.key, definition);
  }
  return { references, definitions, numbers, definitionByKey };
}

/** Definition text without the continuation indentation. */
export function footnoteContent(doc: Text, definition: FootnoteDefinitionInfo): string {
  return doc.sliceString(definition.contentFrom, definition.contentTo)
    .split("\n")
    .map((line, index) => index === 0 ? line : line.replace(/^(?: {1,4}|\t)/, ""))
    .join("\n")
    .trim();
}

/** Definition text as written in the file: one paragraph, continuation lines indented. */
export function formatFootnoteContent(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n    ");
}

export function nextFootnoteLabel(index: FootnoteIndex): string {
  let max = 0;
  for (const item of [...index.references, ...index.definitions]) {
    if (/^\d{1,9}$/.test(item.label)) max = Math.max(max, Number(item.label));
  }
  return String(max + 1);
}

export interface FootnoteInsertion {
  changes: TextChange[];
  label: string;
}

/**
 * Inserts a numbered reference at `at` and an empty definition at the end of
 * the body (`bodyEnd` excludes the trailing comment block and whitespace).
 * Definitions already closing the body stay grouped.
 */
export function insertFootnoteChanges(index: FootnoteIndex, at: number, bodyEnd: number): FootnoteInsertion {
  const label = nextFootnoteLabel(index);
  const reference = `[^${label}]`;
  const lastDefinition = index.definitions[index.definitions.length - 1];
  const grouped = !!lastDefinition && lastDefinition.contentTo >= bodyEnd;
  const definition = `[^${label}]: `;
  if (at >= bodyEnd) return { label, changes: [{ from: at, insert: `${reference}\n\n${definition}` }] };
  return {
    label,
    changes: [
      { from: at, insert: reference },
      { from: bodyEnd, insert: `${grouped ? "\n" : "\n\n"}${definition}` },
    ],
  };
}

/** Removes every reference to the label and its definition. */
export function removeFootnoteChanges(doc: Text, index: FootnoteIndex, key: string): TextChange[] {
  const definition = index.definitionByKey.get(key);
  const changes: TextChange[] = index.references
    .filter((reference) => reference.key === key
      && !(definition && reference.from >= definition.from && reference.to <= definition.contentTo))
    .map((reference) => ({ from: reference.from, to: reference.to }));
  if (definition) {
    const lineFrom = doc.lineAt(definition.from).from;
    const before = doc.sliceString(Math.max(0, lineFrom - 2), lineFrom);
    const precedingBreaks = before === "\n\n" ? 2 : before.endsWith("\n") ? 1 : 0;
    let from = lineFrom;
    let to = definition.contentTo;
    if (doc.sliceString(to, to + 1) === "\n") {
      to += 1;
      // Drop the blank line that separated a lone definition from the body.
      const after = doc.sliceString(to, to + 1);
      if (precedingBreaks === 2 && (after === "" || after === "\n")) from -= 1;
    } else {
      from -= precedingBreaks;
    }
    changes.push({ from, to });
  }
  return changes.sort((a, b) => a.from - b.from);
}

/** Replaces the definition text of a label. */
export function updateFootnoteContentChange(definition: FootnoteDefinitionInfo, text: string): TextChange {
  return { from: definition.contentFrom, to: definition.contentTo, insert: formatFootnoteContent(text) };
}
