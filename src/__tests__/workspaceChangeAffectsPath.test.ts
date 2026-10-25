import { describe, expect, it } from "vitest";
import { workspaceChangeAffectsPath } from "../services/workspaceExplorer";

describe("workspaceChangeAffectsPath", () => {
  it("matches the path itself, its ancestors and the whole checkout", () => {
    expect(workspaceChangeAffectsPath("docs/a.md", "docs/a.md")).toBe(true);
    // Watcher overflow rescans and directory deletes name a directory only.
    expect(workspaceChangeAffectsPath("docs", "docs/sub/a.md")).toBe(true);
    expect(workspaceChangeAffectsPath(".", "docs/a.md")).toBe(true);
    expect(workspaceChangeAffectsPath("./docs/", "docs/a.md")).toBe(true);
  });

  it("does not match siblings that only share a name prefix, or descendants of the target", () => {
    expect(workspaceChangeAffectsPath("doc", "docs/a.md")).toBe(false);
    expect(workspaceChangeAffectsPath("docs/a", "docs/a.md")).toBe(false);
    expect(workspaceChangeAffectsPath("docs/a.md/x", "docs/a.md")).toBe(false);
  });

  it("normalizes separators and case", () => {
    expect(workspaceChangeAffectsPath("Assets\\Scenes", "assets/scenes/Main.unity")).toBe(true);
  });

  it("matches a root-prefixed target as a path-segment suffix or infix when unanchored", () => {
    const absolute = "C:/work/project/docs/sub/a.md";
    expect(workspaceChangeAffectsPath("docs/sub/a.md", absolute)).toBe(false);
    expect(workspaceChangeAffectsPath("docs/sub/a.md", absolute, { anchored: false })).toBe(true);
    expect(workspaceChangeAffectsPath("docs", absolute, { anchored: false })).toBe(true);
    expect(workspaceChangeAffectsPath("ocs", absolute, { anchored: false })).toBe(false);
  });
});
