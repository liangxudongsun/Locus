import { h, render } from "vue";
import { closeSearchPanel, findNext, findPrevious, getSearchQuery, search, SearchQuery, setSearchQuery } from "@codemirror/search";
import type { EditorView, Panel, ViewUpdate } from "@codemirror/view";
import type { EditorState } from "@codemirror/state";
import FindBar from "../FloatingFindBar.vue";
import { isInHiddenCommentBlock } from "./markdownCommentEditing";

/** Matches inside the hidden comment block are not part of the visible document. */
const visibleMatch = (_match: string, state: EditorState, from: number) => !isInHiddenCommentBlock(state, from);

/** Keep CodeMirror's document search and viewport highlights, using our shared controls. */
export function markdownEditorSearch() {
  return search({ top: true, literal: true, createPanel: createFindPanel });
}

function createFindPanel(view: EditorView): Panel {
  const dom = view.dom.ownerDocument.createElement("div");
  let matches: Array<{ from: number; to: number }> = [];
  function refresh(recount: boolean) {
    const query = getSearchQuery(view.state);
    if (recount) {
      matches = [];
      if (query.valid) {
        const cursor = query.getCursor(view.state);
        for (let item = cursor.next(); !item.done; item = cursor.next()) matches.push(item.value);
      }
    }
    const selection = view.state.selection.main;
    const current = matches.findIndex((match) => match.from === selection.from && match.to === selection.to) + 1;
    render(h(FindBar, {
      anchor: view.dom.closest<HTMLElement>("[data-search-surface]") ?? view.dom,
      query: query.search, count: matches.length, current,
      "onUpdate:query": (value: string) => {
        view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: value, literal: true, test: visibleMatch })) });
        if (value) {
          // Keep typing stable: prefer the match at the current selection's start.
          const match = matches.find((item) => item.from >= view.state.selection.main.from) ?? matches[0];
          if (match) view.dispatch({ selection: { anchor: match.from, head: match.to }, scrollIntoView: true });
        }
      },
      onNext: () => { findNext(view); },
      onPrevious: () => { findPrevious(view); },
      onClose: () => { closeSearchPanel(view); },
    }), dom);
  }
  return {
    dom, top: true,
    mount() { refresh(true); },
    update(update: ViewUpdate) {
      refresh(update.docChanged || update.transactions.some((transaction) => transaction.effects.some((effect) => effect.is(setSearchQuery))));
    },
    destroy() { render(null, dom); },
  };
}
