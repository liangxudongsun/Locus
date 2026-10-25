import { shouldResolveMarkdownImageSource } from "./markdownImages";
import { parseUnityPropertyFence } from "./unityPropertyFence";

/** Canonical workspace-relative key. Absolute references outside this checkout
 * cannot be invalidated by its watcher; URLs and embedded images are not files. */
export function markdownDependencyPath(source: string, workingDir: string, contentPath = "", imageSource = false): string | null {
  let path = source.trim().replace(/\\/g, "/");
  if (!path || /^(?:https?:|data:|blob:|\/\/)/i.test(path)) return null;
  if (imageSource || /^file:\/\//i.test(path)) {
    path = path.replace(/[?#].*$/, "");
    try { path = decodeURIComponent(path); } catch { /* Literal malformed percent escape. */ }
  }
  if (/^file:\/\//i.test(path)) {
    path = path.replace(/^file:\/\//i, "").replace(/^\/([a-z]:\/)/i, "$1");
  }
  const absolute = (value: string) => /^(?:[a-z]:\/|\/)/i.test(value);
  if (!absolute(path) && contentPath) {
    const parent = contentPath.replace(/\\/g, "/").replace(/[^/]*$/, "");
    path = parent + path;
  }
  const normalize = (value: string) => {
    const parts: string[] = [];
    for (const part of value.split("/")) {
      if (!part || part === ".") continue;
      if (part === "..") {
        if (!parts.length) return null;
        parts.pop();
      } else parts.push(part);
    }
    return parts.join("/").toLocaleLowerCase();
  };
  const normalized = normalize(path);
  if (!normalized) return null;
  if (!absolute(path)) return normalized;
  const root = normalize(workingDir);
  return root && normalized.startsWith(`${root}/`) ? normalized.slice(root.length + 1) : null;
}

/** Index of rendered references: event dispatch never scans message text.
 * Ancestors cover folder rename/delete events; matching is a Set lookup. */
export class MarkdownFileDependencies {
  private readonly paths = new Set<string>();
  private readonly images = new Set<string>();

  get empty(): boolean { return this.paths.size === 0; }

  add(source: string, workingDir: string, image = false, contentPath = ""): void {
    const path = markdownDependencyPath(source, workingDir, contentPath, image);
    if (!path) return;
    if (/^(?:assets|packages)\//.test(path)) this.paths.add(`${path}.meta`);
    let key = path;
    while (key) {
      this.paths.add(key);
      if (image) this.images.add(key);
      const slash = key.lastIndexOf("/");
      if (slash < 0) break;
      key = key.slice(0, slash);
    }
  }

  matches(path: string, imagesOnly = false): boolean {
    const paths = imagesOnly ? this.images : this.paths;
    if (!paths.size) return false;
    // A rescan is scoped to its path; only "." invalidates the entire checkout.
    if (path === ".") return true;
    const key = markdownDependencyPath(path, "");
    return key != null && paths.has(key);
  }
}

export function collectMarkdownFileDependencies(
  root: ParentNode | null,
  workingDir: string,
  inlinePaths: readonly string[] = [],
  propertySource = (host: HTMLElement) => host.querySelector("[data-md-unity-property-source]")?.textContent ?? "",
): MarkdownFileDependencies {
  const dependencies = new MarkdownFileDependencies();
  for (const path of inlinePaths) dependencies.add(path, workingDir);
  for (const element of root?.querySelectorAll<HTMLElement>(
    "[data-file-path], [data-asset-path], [data-scene-path], img[data-md-image-source]",
  ) ?? []) {
    const image = element.dataset.mdImageSource;
    if (image && shouldResolveMarkdownImageSource(image)) dependencies.add(image, workingDir, true);
    for (const path of [element.dataset.scenePath, element.dataset.assetPath, element.dataset.filePath]) {
      if (path) dependencies.add(path, workingDir);
    }
  }
  for (const host of root?.querySelectorAll<HTMLElement>("[data-md-unity-property-fence='true']") ?? []) {
    for (const { target } of parseUnityPropertyFence(propertySource(host)).entries) {
      if (target.path) dependencies.add(target.path, workingDir);
      if (target.scenePath) dependencies.add(target.scenePath, workingDir);
    }
  }
  return dependencies;
}
