import { StateField, type ChangeDesc, type EditorState, type Extension, type Transaction } from "@codemirror/state";
import { isolateHistory } from "@codemirror/commands";
import { EditorView, hoverTooltip, WidgetType } from "@codemirror/view";
import { contentEndBefore, findCommentBlockRange } from "../../../document/markdownComments";
import {
  EMPTY_FOOTNOTE_INDEX,
  footnoteContent,
  footnoteKey,
  indexFootnotes,
  insertFootnoteChanges,
  removeFootnoteChanges,
  scanFootnotes,
  updateFootnoteContentChange,
  type FootnoteDefinitionInfo,
  type FootnoteIndex,
} from "../../../document/markdownFootnotes";
import { t } from "../../../i18n";

export const FOOTNOTE_USER_EVENT = "input.footnote";

function scanState(state: EditorState): FootnoteIndex {
  return scanFootnotes(state.doc, findCommentBlockRange(state.doc)?.from ?? state.doc.length);
}

const RESCAN_CHARACTERS = /[[\]^`~\\\n:]/;

/** Whether a change can alter footnote structure; plain typing only shifts positions. */
function needsRescan(index: FootnoteIndex, tr: Transaction): boolean {
  let rescan = false;
  const items = [...index.references, ...index.definitions.map((item) => ({ from: item.from, to: item.contentTo }))];
  tr.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
    if (rescan) return;
    if (RESCAN_CHARACTERS.test(inserted.sliceString(0, Math.min(inserted.length, 10_000)))
      || (toA - fromA > 10_000) || RESCAN_CHARACTERS.test(tr.startState.doc.sliceString(fromA, toA))) {
      rescan = true;
      return;
    }
    const doc = tr.state.doc;
    const first = doc.lineAt(fromB);
    const last = doc.lineAt(toB);
    if (first.number === last.number ? first.text.includes("[^") : doc.sliceString(first.from, last.to).includes("[^")) {
      rescan = true;
      return;
    }
    // Text typed in or right after a definition may extend it.
    if (index.definitions.some((item) => first.from <= tr.changes.mapPos(item.contentTo, 1) + 1
      && last.to >= tr.changes.mapPos(item.from, -1))) rescan = true;
    if (items.some((item) => fromA <= item.to && toA >= item.from)) rescan = true;
  });
  return rescan;
}

function mapIndex(index: FootnoteIndex, changes: ChangeDesc): FootnoteIndex {
  return indexFootnotes(
    index.references.map((item) => ({ ...item, from: changes.mapPos(item.from, 1), to: changes.mapPos(item.to, -1) })),
    index.definitions.map((item) => ({
      ...item,
      from: changes.mapPos(item.from, 1),
      labelTo: changes.mapPos(item.labelTo, -1),
      contentFrom: changes.mapPos(item.contentFrom, -1),
      contentTo: changes.mapPos(item.contentTo, 1),
    })),
  );
}

export const markdownFootnoteIndex = StateField.define<FootnoteIndex>({
  create: scanState,
  update(value, tr) {
    if (!tr.docChanged) return value;
    if (!value.references.length && !value.definitions.length) {
      // Nothing to map: rescan only when footnote syntax may have appeared.
      return needsRescan(EMPTY_FOOTNOTE_INDEX, tr) ? scanState(tr.state) : value;
    }
    return needsRescan(value, tr) ? scanState(tr.state) : mapIndex(value, tr.changes);
  },
});

export function footnoteDefinition(state: EditorState, key: string): FootnoteDefinitionInfo | null {
  return state.field(markdownFootnoteIndex, false)?.definitionByKey.get(key) ?? null;
}

export function footnoteText(state: EditorState, key: string): string | null {
  const definition = footnoteDefinition(state, key);
  return definition ? footnoteContent(state.doc, definition) : null;
}

export function footnoteNumber(state: EditorState, key: string): number | null {
  return state.field(markdownFootnoteIndex, false)?.numbers.get(key) ?? null;
}

/** End of the document body: before the comment block and trailing whitespace. */
export function markdownBodyEnd(state: EditorState): number {
  const block = findCommentBlockRange(state.doc);
  return block ? contentEndBefore(state.doc, block.from) : contentEndBefore(state.doc, state.doc.length);
}

/** Inserts a footnote at the cursor; returns its label key. */
export function insertMarkdownFootnote(view: EditorView): string | null {
  const state = view.state;
  if (state.readOnly) return null;
  const index = state.field(markdownFootnoteIndex, false) ?? scanState(state);
  const block = findCommentBlockRange(state.doc);
  const limit = block ? block.hideFrom : state.doc.length;
  const at = Math.min(state.selection.main.to, limit);
  const insertion = insertFootnoteChanges(index, at, Math.min(markdownBodyEnd(state), limit));
  const reference = `[^${insertion.label}]`;
  view.dispatch({
    changes: insertion.changes,
    selection: { anchor: at + reference.length },
    annotations: isolateHistory.of("full"),
    userEvent: FOOTNOTE_USER_EVENT,
    scrollIntoView: true,
  });
  return footnoteKey(insertion.label);
}

export function updateMarkdownFootnote(view: EditorView, key: string, text: string): boolean {
  const definition = footnoteDefinition(view.state, key);
  if (!definition || view.state.readOnly) return false;
  const change = updateFootnoteContentChange(definition, text);
  if (view.state.doc.sliceString(change.from, change.to) === change.insert) return false;
  view.dispatch({ changes: change, annotations: isolateHistory.of("full"), userEvent: FOOTNOTE_USER_EVENT });
  return true;
}

export function removeMarkdownFootnote(view: EditorView, key: string): boolean {
  const index = view.state.field(markdownFootnoteIndex, false);
  if (!index || view.state.readOnly) return false;
  const changes = removeFootnoteChanges(view.state.doc, index, key);
  if (!changes.length) return false;
  view.dispatch({ changes, annotations: isolateHistory.of("full"), userEvent: FOOTNOTE_USER_EVENT });
  return true;
}

/** Moves the cursor to the definition text and scrolls it into view. */
export function revealMarkdownFootnote(view: EditorView, key: string): boolean {
  const definition = footnoteDefinition(view.state, key);
  if (!definition) return false;
  view.dispatch({
    selection: { anchor: definition.contentFrom },
    effects: EditorView.scrollIntoView(definition.contentFrom, { y: "center" }),
  });
  view.focus();
  return true;
}

export interface MarkdownFootnoteOpenTarget {
  key: string;
  label: string;
  element: HTMLElement;
}

export class FootnoteReferenceWidget extends WidgetType {
  constructor(
    readonly label: string,
    readonly number: number | null,
    readonly missing: boolean,
    readonly onOpen?: (target: MarkdownFootnoteOpenTarget) => void,
  ) {
    super();
  }

  eq(other: FootnoteReferenceWidget): boolean {
    return other.label === this.label && other.number === this.number
      && other.missing === this.missing && other.onOpen === this.onOpen;
  }

  toDOM(): HTMLElement {
    const element = document.createElement("sup");
    element.className = `cm-footnote-ref${this.missing ? " is-missing" : ""}`;
    element.textContent = this.number === null ? this.label : String(this.number);
    element.dataset.footnoteLabel = this.label;
    if (this.onOpen) {
      element.setAttribute("role", "button");
      element.addEventListener("mousedown", (event) => event.preventDefault());
      element.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.onOpen?.({ key: footnoteKey(this.label), label: this.label, element });
      });
    }
    return element;
  }
}

export class FootnoteDefinitionLabelWidget extends WidgetType {
  constructor(readonly label: string, readonly number: number | null) {
    super();
  }

  eq(other: FootnoteDefinitionLabelWidget): boolean {
    return other.label === this.label && other.number === this.number;
  }

  toDOM(): HTMLElement {
    const element = document.createElement("span");
    element.className = `cm-footnote-def-label${this.number === null ? " is-unreferenced" : ""}`;
    element.textContent = this.number === null ? this.label : String(this.number);
    if (this.number === null) element.title = t("editor.footnote.unreferenced");
    return element;
  }
}

/** Shows the note text when hovering a reference, in both view modes. */
const footnoteHover = hoverTooltip((view, pos, side) => {
  const index = view.state.field(markdownFootnoteIndex, false);
  const reference = index?.references.find((item) => (pos > item.from && pos < item.to)
    || (pos === item.from && side > 0) || (pos === item.to && side < 0));
  if (!index || !reference) return null;
  const text = footnoteText(view.state, reference.key);
  return {
    pos: reference.from,
    end: reference.to,
    above: true,
    create() {
      const dom = document.createElement("div");
      dom.className = `cm-footnote-tooltip${text ? "" : " is-missing"}`;
      dom.textContent = text || t("editor.footnote.missing");
      return { dom };
    },
  };
}, { hoverTime: 250 });

const footnoteTheme = EditorView.baseTheme({
  ".cm-footnote-ref": {
    padding: "0 1px",
    color: "var(--accent-color)",
    fontFamily: "var(--font-ui)",
    fontSize: "0.72em",
    fontWeight: "600",
    lineHeight: "0",
    verticalAlign: "super",
    cursor: "pointer",
  },
  ".cm-footnote-ref:hover": { textDecoration: "underline" },
  ".cm-footnote-ref.is-missing": {
    color: "var(--text-secondary)",
    opacity: "0.7",
  },
  ".cm-line.cm-live-footnote-definition": {
    color: "var(--text-secondary)",
    fontSize: "0.92em",
  },
  ".cm-footnote-def-label": {
    display: "inline-block",
    minWidth: "1.6em",
    color: "var(--accent-color)",
    fontFamily: "var(--font-ui)",
    fontSize: "0.85em",
    fontWeight: "600",
  },
  ".cm-footnote-def-label.is-unreferenced": {
    color: "var(--text-secondary)",
    fontWeight: "400",
  },
  ".cm-tooltip.cm-tooltip-hover:has(.cm-footnote-tooltip)": {
    border: "1px solid var(--border-color)",
    borderRadius: "6px",
    backgroundColor: "var(--elevated-bg, var(--panel-bg))",
    boxShadow: "0 8px 20px rgba(0, 0, 0, 0.18)",
  },
  ".cm-footnote-tooltip": {
    maxWidth: "360px",
    padding: "6px 9px",
    color: "var(--text-color)",
    fontFamily: "var(--font-ui)",
    fontSize: "12px",
    lineHeight: "1.55",
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
  },
  ".cm-footnote-tooltip.is-missing": { color: "var(--text-secondary)" },
});

export function markdownFootnoteExtensions(): Extension {
  return [markdownFootnoteIndex, footnoteHover, footnoteTheme];
}
