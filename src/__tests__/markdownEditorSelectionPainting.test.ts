// @vitest-environment jsdom
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import {
  markdownEditorBaseExtensions,
  markdownEditorLanguageExtension,
  markdownEditorModeExtension,
  markdownEditorReadOnlyExtension,
} from "../components/ui/markdown-editor/codeMirrorMarkdownExtensions";

let view: EditorView | undefined;
afterEach(() => {
  view?.destroy();
  view = undefined;
  document.body.replaceChildren();
});

describe("Markdown native selection painting", () => {
  // jsdom cannot rasterize ::selection. This guards the scoped CSS contract;
  // the full-line -> partial-line transition also needs a Chromium pixel test.
  it.each([
    ["rendered", false],
    ["rendered", true],
    ["native", false],
    ["native", true],
  ] as const)("keeps native selection almost transparent in %s mode (readOnly=%s)", (mode, readOnly) => {
    const parent = document.createElement("div");
    document.body.append(parent);
    view = new EditorView({
      parent,
      state: EditorState.create({
        doc: "普通文字与 **强调文字**，选区回缩不能重复绘制整行。",
        extensions: [
          ...markdownEditorBaseExtensions(() => undefined),
          markdownEditorLanguageExtension("markdown"),
          markdownEditorModeExtension(mode, "markdown"),
          markdownEditorReadOnlyExtension(readOnly),
        ],
      }),
    });

    const expected = document.createElement("span");
    expected.style.backgroundColor = "#00000001";
    const rules = Array.from(document.styleSheets).flatMap(sheet => Array.from(sheet.cssRules))
      .filter((rule): rule is CSSStyleRule => rule instanceof CSSStyleRule);
    const selectionRule = rules.find(rule =>
      rule.selectorText.includes(".cm-content .cm-line::selection")
      && rule.style.backgroundColor === expected.style.backgroundColor);
    expect(selectionRule).toBeDefined();
    expect(selectionRule!.style.getPropertyPriority("background-color")).toBe("important");
    expect(selectionRule!.selectorText).toContain(".cm-content .cm-line ::selection");

    const selectors = selectionRule!.selectorText
      .replaceAll(" ::selection", " *")
      .replaceAll("::selection", "");
    const line = view.contentDOM.querySelector(".cm-line")!;
    expect(line.matches(selectors)).toBe(true);
    const inline = document.createElement("span");
    line.append(inline);
    expect(inline.matches(selectors)).toBe(true);
    const outside = document.createElement("div");
    outside.className = "cm-content";
    outside.innerHTML = '<div class="cm-line">Other editor</div>';
    document.body.append(outside);
    expect(outside.firstElementChild!.matches(selectors)).toBe(false);
  });
});
