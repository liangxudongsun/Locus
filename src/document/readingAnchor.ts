import { EditorView } from "@codemirror/view";
import type { Text } from "@codemirror/state";
import { textHash } from "./textDelta";

/**
 * A reading position tied to document text rather than pixels. Heights of
 * off-screen lines are estimates in CodeMirror and change with width, zoom and
 * late images, so a pixel offset would land elsewhere after reopening.
 */
export type ReadingAnchor =
  | {
      /** 1-based line containing the character at the viewport top. */
      line: number;
      /** UTF-16 offset of that character within the line. */
      column: number;
      lineHash: string;
      /** Pixels that visual line has scrolled past the viewport top. */
      offset: number;
    }
  | {
      /** Viewport top lies above the editor body (title, properties). */
      before: number;
    };

const RELOCATE_RADIUS = 500;

function viewportTop(scroller: HTMLElement): number {
  const scrolling = scroller.ownerDocument.scrollingElement;
  return scroller === scrolling ? 0 : scroller.getBoundingClientRect().top;
}

/** The anchor at the scroller's top edge, or null when it is scrolled to the top. */
export function captureReadingAnchor(view: EditorView, scroller: HTMLElement): ReadingAnchor | null {
  if (scroller.scrollTop <= 1) return null;
  const top = viewportTop(scroller);
  const content = view.contentDOM.getBoundingClientRect();
  if (top < content.top) return { before: Math.round(scroller.scrollTop) };
  const pos = view.posAtCoords({ x: content.left + 1, y: top + 1 }, false);
  const line = view.state.doc.lineAt(pos);
  const coords = view.coordsAtPos(pos, 1);
  return {
    line: line.number,
    column: pos - line.from,
    lineHash: textHash(line.text),
    offset: coords ? Math.max(0, Math.round(top - coords.top)) : 0,
  };
}

/** Document position of an anchor, relocated by line hash after external edits. */
export function resolveReadingAnchor(doc: Text, anchor: ReadingAnchor): number | null {
  if ("before" in anchor) return null;
  const at = Math.min(doc.lines, Math.max(1, Math.floor(anchor.line)));
  const position = (number: number) => {
    const line = doc.line(number);
    return line.from + Math.min(line.length, Math.max(0, Math.floor(anchor.column)));
  };
  if (textHash(doc.line(at).text) === anchor.lineHash) return position(at);
  for (let distance = 1; distance <= RELOCATE_RADIUS; distance += 1) {
    for (const candidate of [at - distance, at + distance]) {
      if (candidate >= 1 && candidate <= doc.lines && textHash(doc.line(candidate).text) === anchor.lineHash) {
        return position(candidate);
      }
    }
    if (at - distance < 1 && at + distance > doc.lines) break;
  }
  return position(at);
}

export function restoreReadingAnchor(view: EditorView, scroller: HTMLElement, anchor: ReadingAnchor): boolean {
  if ("before" in anchor) {
    scroller.scrollTop = anchor.before;
    return true;
  }
  const pos = resolveReadingAnchor(view.state.doc, anchor);
  if (pos === null) return false;
  view.dispatch({
    effects: EditorView.scrollIntoView(pos, { y: "start", yMargin: -Math.max(0, anchor.offset) }),
  });
  return true;
}

export function isReadingAnchor(value: unknown): value is ReadingAnchor {
  if (!value || typeof value !== "object") return false;
  const anchor = value as Record<string, unknown>;
  return typeof anchor.before === "number"
    || (typeof anchor.line === "number" && typeof anchor.column === "number"
      && typeof anchor.lineHash === "string" && typeof anchor.offset === "number");
}
