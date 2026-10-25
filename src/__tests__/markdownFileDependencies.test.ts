// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { collectMarkdownFileDependencies, MarkdownFileDependencies, markdownDependencyPath } from "../composables/markdownFileDependencies";
import { workspaceFileChangeMatches } from "../composables/useFileChangeRevalidation";

const scope = { checkoutId: "checkout", expectedGeneration: 7, expectedMaterializationEpoch: 2 };
const event = (path: string, rescan = false) => ({ checkoutId: "checkout", workspaceGeneration: 7, materializationEpoch: 2,
  payload: { path, rescan, seq: 1, generation: 1, kind: "upsert" as const, source: "os_watcher" as const } });

describe("Markdown file dependencies", () => {
  it("normalizes local, absolute, encoded image and document-relative references", () => {
    const deps = new MarkdownFileDependencies();
    deps.add("file:///F:/Game/Docs/My%20%23Image.png?v=1", "F:/Game", true);
    deps.add("../Images/preview.png", "F:/Game", true, "Docs/guide.md");
    deps.add("src/100%done#tag.ts", "F:/Game");
    expect(deps.matches("docs/my #image.png")).toBe(true);
    expect(deps.matches("Images\\preview.png")).toBe(true);
    expect(deps.matches("src/100%done#tag.ts")).toBe(true);
    expect(deps.matches("Docs")).toBe(true);
    expect(deps.matches("Doc")).toBe(false);
    expect(deps.matches("node_modules/preview.png")).toBe(false);
    expect(markdownDependencyPath("F:/Other/preview.png", "F:/Game")).toBeNull();
    expect(markdownDependencyPath("../../outside.png", "F:/Game")).toBeNull();
  });

  it("indexes rendered references, not incidental prose, fenced code or remote images", () => {
    const root = document.createElement("div");
    root.innerHTML = '<p>docs/incidental.png</p><pre>src/not-a-reference.ts</pre>'
      + '<span data-file-path="Assets/Hero.prefab"></span><span data-scene-path="Assets/Main.unity"></span>'
      + '<img data-md-image-source="images/local.png"><img data-md-image-source="https://host/remote.png">';
    const deps = collectMarkdownFileDependencies(root, "F:/Game", ["src/not-yet-created.ts"]);
    expect(deps.matches("docs/incidental.png")).toBe(false);
    expect(deps.matches("src/not-a-reference.ts")).toBe(false);
    expect(deps.matches("remote.png")).toBe(false);
    expect(deps.matches("src/not-yet-created.ts")).toBe(true);
    expect(deps.matches("Assets/Hero.prefab.meta")).toBe(true);
    expect(deps.matches("Assets/Main.unity")).toBe(true);
    expect(deps.matches("images/local.png", true)).toBe(true);
    expect(deps.matches("Assets/Hero.prefab", true)).toBe(false);
    expect(deps.matches(".", true)).toBe(true);
    expect(deps.matches("node_modules", true)).toBe(false);
    expect(new MarkdownFileDependencies().matches(".")).toBe(false);
  });

  it("invalidates referenced files after overflow and directory changes, without crossing scope", () => {
    expect(workspaceFileChangeMatches(event(".", true), scope, "docs/file.md")).toBe(true);
    expect(workspaceFileChangeMatches(event("docs"), scope, "docs/file.md")).toBe(true);
    expect(workspaceFileChangeMatches(event("node_modules", true), scope, "docs/file.md")).toBe(false);
    expect(workspaceFileChangeMatches(event("doc"), scope, "docs/file.md")).toBe(false);
    expect(workspaceFileChangeMatches({ ...event(".", true), checkoutId: "other" }, scope, "docs/file.md")).toBe(false);
    expect(workspaceFileChangeMatches({ ...event(".", true), workspaceGeneration: 6 }, scope, "docs/file.md")).toBe(false);
    expect(workspaceFileChangeMatches({ ...event(".", true), materializationEpoch: 1 }, scope, "docs/file.md")).toBe(false);
    expect(workspaceFileChangeMatches(event(".", true), scope, null)).toBe(false);
  });
});
