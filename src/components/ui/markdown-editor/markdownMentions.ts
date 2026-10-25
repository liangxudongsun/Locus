import { EditorState, Prec, StateEffect, StateField, type Extension } from "@codemirror/state";
import { isolateHistory } from "@codemirror/commands";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { EditorView, showTooltip, ViewPlugin, type TooltipView, type ViewUpdate } from "@codemirror/view";
import { h, render } from "vue";
import type { WorkspaceRef } from "../../../services/project";
import { createMentionSearchQueue } from "../../chat/mentionSearchQueue";
import MarkdownMentionList from "./MarkdownMentionList.vue";
import { markdownMentionText, searchMarkdownMentionResources, type MarkdownMentionResource } from "./markdownMentionResources";

interface MentionContext { workspaceRef: WorkspaceRef; contentPath: string; key: string }
interface MentionRange { from: number; to: number; query: string }
interface MentionSession extends MentionRange {
  context: MentionContext;
  request: object;
  entries: MarkdownMentionResource[];
  selected: number;
  loading: boolean;
  pending: boolean;
  error: string;
}

/** Inspect only the current line and syntax ancestors; never stringify the document on input. */
export function markdownMentionRange(state: EditorState): MentionRange | null {
  const selection = state.selection.main;
  if (state.readOnly || !selection.empty || state.selection.ranges.length !== 1) return null;
  const to = selection.head;
  const line = state.doc.lineAt(to);
  const start = Math.max(line.from, to - 256);
  const before = state.sliceDoc(start, to);
  const at = before.lastIndexOf("@");
  if (at < 0 || (at > 0 && /[\w./\\@]/.test(before[at - 1]!))) return null;
  const query = before.slice(at + 1);
  if (/[\r\n@`\[\]<>]/.test(query) || /^\s/.test(query)) return null;
  const from = start + at;
  // Markdown frontmatter is not part of the Markdown grammar, including in source mode.
  if (/^\uFEFF?---\s*$/.test(state.doc.line(1).text)) {
    let closed = false;
    for (let number = 2; number < line.number; number++) {
      if (/^(?:---|\.\.\.)\s*$/.test(state.doc.line(number).text)) { closed = true; break; }
    }
    if (!closed) return null;
  }
  const tree = ensureSyntaxTree(state, to, 10) ?? syntaxTree(state);
  for (let node = tree.resolveInner(from, 1); node; node = node.parent!) {
    if (/^(?:FencedCode|CodeBlock|InlineCode|Link|Image|Autolink|HTMLBlock|HTMLTag|LinkReference|CommentBlock|FootnoteReference|FootnoteDefinitionMark)$/.test(node.name)) return null;
  }
  return { from, to, query };
}

function sameContext(left: MentionContext, right: MentionContext | null): boolean {
  return !!right && left.key === right.key && left.contentPath === right.contentPath
    && left.workspaceRef.checkoutId === right.workspaceRef.checkoutId
    && left.workspaceRef.expectedGeneration === right.workspaceRef.expectedGeneration
    && left.workspaceRef.expectedMaterializationEpoch === right.workspaceRef.expectedMaterializationEpoch;
}

let nextId = 0;

export function markdownMentions(options: {
  context: () => MentionContext | null;
  search?: typeof searchMarkdownMentionResources;
  insert?: typeof markdownMentionText;
}): Extension {
  const id = `md-mentions-${++nextId}`;
  const close = StateEffect.define<void>();
  const patch = StateEffect.define<{ request: object; value: Partial<Pick<MentionSession, "entries" | "selected" | "loading" | "pending" | "error">> }>();
  const field = StateField.define<MentionSession | null>({
    create: () => null,
    update(value, transaction) {
      const context = options.context();
      if (!context || transaction.state.readOnly || transaction.reconfigured
        || transaction.effects.some(effect => effect.is(close))) return null;
      if (value && !sameContext(value.context, context)) return null;
      for (const effect of transaction.effects) {
        if (effect.is(patch) && value?.request === effect.value.request) value = { ...value, ...effect.value.value };
      }
      if (!transaction.docChanged) {
        if (transaction.selection && (!transaction.newSelection.main.empty || transaction.newSelection.main.head !== value?.to)) return null;
        return value;
      }
      // External synchronization, undo and paste must not reopen a dismissed mention.
      if (!transaction.isUserEvent("input.type") && !transaction.isUserEvent("delete.backward")) return null;
      const range = markdownMentionRange(transaction.state);
      if (!range) return null;
      if (value && transaction.changes.mapPos(value.from, -1) !== range.from) return null;
      if (!value) {
        let typedAt = false;
        transaction.changes.iterChanges((_from, _to, from, to, inserted) => {
          if (from <= range.from && to > range.from && inserted.sliceString(range.from - from, range.from - from + 1) === "@") typedAt = true;
        });
        if (!typedAt) return null;
      }
      if (value && range.query === value.query && range.from === value.from && range.to === value.to) return value;
      return { ...range, context: { ...context, workspaceRef: { ...context.workspaceRef } }, request: {},
        entries: [], selected: 0, loading: true, pending: false, error: "" };
    },
    provide: source => showTooltip.from(source, value => value ? { pos: value.to, create: createTooltip, above: false } : null),
  });

  function current(view: EditorView) { return view.state.field(field, false); }
  function updateSession(view: EditorView, session: MentionSession, value: Parameters<typeof patch.of>[0]["value"]) {
    view.dispatch({ effects: patch.of({ request: session.request, value }) });
  }
  function highlight(view: EditorView, index: number) {
    const session = current(view);
    if (session && !session.pending) updateSession(view, session, { selected: index });
  }
  async function select(view: EditorView, index: number) {
    const session = current(view);
    const resource = session?.entries[index];
    if (!session || !resource || session.pending || view.state.readOnly) return;
    const owner = view.plugin(plugin);
    const document = view.state.doc;
    const valid = () => !owner?.disposed && current(view)?.request === session.request
      && view.state.doc === document && !view.state.readOnly && sameContext(session.context, options.context());
    updateSession(view, session, { pending: true, error: "" });
    try {
      const text = await (options.insert ?? markdownMentionText)(resource, session.context.workspaceRef, session.context.contentPath);
      if (!valid()) return;
      view.dispatch({ changes: { from: session.from, to: session.to, insert: text },
        selection: { anchor: session.from + text.length }, effects: close.of(),
        annotations: isolateHistory.of("full"), userEvent: "input.mention", scrollIntoView: true });
      view.focus();
    } catch {
      if (valid()) updateSession(view, session, { pending: false, error: "无法插入引用" });
    }
  }

  function keydown(view: EditorView, event: KeyboardEvent): boolean {
    const session = current(view);
    if (!session || event.isComposing || event.keyCode === 229 || view.composing || view.plugin(plugin)?.composing) return false;
    if (event.key === "Escape") { view.dispatch({ effects: close.of() }); view.focus(); return true; }
    if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return false;
    if (["ArrowDown", "ArrowUp", "PageDown", "PageUp"].includes(event.key)) {
      const count = session.entries.length;
      const step = event.key.startsWith("Page") ? 6 : 1;
      const next = session.selected + (event.key.endsWith("Down") ? step : -step);
      if (count) highlight(view, step === 1 ? (next + count) % count : Math.max(0, Math.min(count - 1, next)));
      return true;
    }
    if (event.key === "Enter" || event.key === "Tab") {
      if (session.pending || session.loading) return true;
      if (session.entries.length) { void select(view, session.selected); return true; }
      view.dispatch({ effects: close.of() });
    }
    return false;
  }

  function createTooltip(view: EditorView): TooltipView {
    const dom = view.dom.ownerDocument.createElement("div");
    dom.className = "cm-mention-tooltip";
    dom.addEventListener("keydown", event => { if (keydown(view, event)) { event.preventDefault(); event.stopPropagation(); } });
    const refresh = () => {
      const session = current(view);
      if (!session) return;
      render(h(MarkdownMentionList, { id, entries: session.entries, selected: session.selected,
        loading: session.loading, pending: session.pending, error: session.error,
        onSelect: index => { void select(view, index); }, onHighlight: index => highlight(view, index) }), dom);
    };
    refresh();
    return { dom, offset: { x: 0, y: 4 }, update: refresh, destroy: () => render(null, dom) };
  }

  const plugin = ViewPlugin.fromClass(class {
    disposed = false;
    composing = false;
    request: object | null = null;
    timer: ReturnType<typeof setTimeout> | undefined;
    queue = createMentionSearchQueue();
    constructor(readonly view: EditorView) { view.dom.ownerDocument.addEventListener("pointerdown", this.outside); }
    outside = (event: PointerEvent) => {
      if (!this.view.dom.contains(event.target as Node) && current(this.view)) this.view.dispatch({ effects: close.of() });
    };
    update(_update: ViewUpdate) { this.schedule(); }
    schedule() {
      const session = current(this.view);
      if ((session?.request ?? null) === this.request) return;
      clearTimeout(this.timer); this.queue.clear();
      this.request = session?.request ?? null;
      if (!session || this.composing) { this.request = null; return; }
      this.timer = setTimeout(() => {
        const valid = () => !this.disposed && !this.composing && current(this.view)?.request === session.request && sameContext(session.context, options.context());
        void this.queue.run(() => (options.search ?? searchMarkdownMentionResources)(session.query, session.context.workspaceRef))
          .then(entries => { if (entries && valid()) updateSession(this.view, session, { entries, loading: false }); })
          .catch(() => { if (valid()) updateSession(this.view, session, { loading: false, error: "资源搜索失败" }); });
      }, 120);
    }
    destroy() {
      this.disposed = true; clearTimeout(this.timer); this.queue.clear();
      this.view.dom.ownerDocument.removeEventListener("pointerdown", this.outside);
    }
  }, { eventHandlers: {
    keydown(event) { return keydown(this.view, event); },
    compositionstart() { this.composing = true; clearTimeout(this.timer); this.queue.clear(); this.request = null; return false; },
    compositionend() { this.composing = false; this.schedule(); return false; },
    blur(event) {
      if (current(this.view) && (!event.relatedTarget || !this.view.dom.contains(event.relatedTarget as Node))) this.view.dispatch({ effects: close.of() });
      return false;
    },
    pointerdown(event) {
      if (!(event.target as Element).closest?.(".cm-mention-tooltip") && current(this.view)) this.view.dispatch({ effects: close.of() });
      return false;
    },
  } });

  return [field, Prec.highest(plugin), EditorView.contentAttributes.compute([field], (state): Record<string, string> => {
    const session = state.field(field);
    return session ? { "aria-autocomplete": "list", "aria-controls": id,
      "aria-activedescendant": session.entries[session.selected] ? `${id}-${session.selected}` : "" } : {};
  }), EditorView.theme({
    ".cm-tooltip.cm-mention-tooltip": { width: "360px", maxWidth: "calc(100vw - 16px)", maxHeight: "300px", display: "flex", flexDirection: "column",
      overflow: "hidden", padding: "4px", boxSizing: "border-box", border: "1px solid var(--border-color)", borderRadius: "8px",
      backgroundColor: "var(--bg-color)", color: "var(--text-color)", boxShadow: "0 4px 16px rgba(0, 0, 0, 0.12)", zIndex: "100" },
  })];
}
