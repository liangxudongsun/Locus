<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { ChevronDown, ChevronRight } from "lucide";
import { t } from "../../i18n";
import type { AssetExplorerNode } from "../../composables/useAssetState";
import { useWorkspaceFileVisibility, workspacePathIsHidden } from "../../composables/useWorkspaceFileVisibility";
import { listDirEntriesPage, statWorkspaceEntries, type WorkspaceRef } from "../../services/project";
import { subscribeExplorerFileActions, subscribeWorkspaceFileChanges } from "../../services/workspaceExplorer";
import { normalizeAppError } from "../../services/errors";
import { unityAssetIconClassForPath, unityAssetIconNodeForPath } from "../icons/unityAssetIcons";
import LucideIcon from "../icons/LucideIcon.vue";
import WorkspaceTree from "./WorkspaceTree.vue";
import type { ExplorerResourceRename } from "./explorerResourceActions";
import { WORKSPACE_FILE_ROW_HEIGHT, workspaceFileEntries, type WorkspaceFileEntry } from "./workspaceFileTree";

const props = defineProps<{ workingDir: string; workspaceRef: WorkspaceRef; selectedPath?: string | null; resourceRename?: ExplorerResourceRename | null }>();
const emit = defineEmits<{
  openFile: [file: { path: string; name: string }];
  contextmenu: [entry: WorkspaceFileEntry, event: MouseEvent];
  error: [message: string];
}>();
const visibility = useWorkspaceFileVisibility();
const hiddenRoots = computed(() => {
  const paths = visibility.paths(props.workspaceRef.checkoutId);
  return paths.filter(path => !workspacePathIsHidden(path, paths.filter(parent => parent !== path)));
});
const roots = ref<AssetExplorerNode[]>([]);
const expanded = ref(new Set<string>());
const loading = ref(false);
const error = ref("");
const identity = () => JSON.stringify([props.workingDir, props.workspaceRef]);
let disposed = false, generation = 0, rootsRequest = 0;
let refreshTimer: ReturnType<typeof setTimeout> | undefined;
const releases: Array<() => void> = [];
const valid = (token: number) => !disposed && token === generation;
const rootKey = (path: string) => path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

function node(path: string, name: string, folder: boolean): AssetExplorerNode {
  return folder ? { kind: "folder", path, name, depth: 0, isRoot: false,
    loaded: false, loading: false, hasMore: false, nextOffset: 0, totalCount: 0,
    hasChildFoldersKnown: true, hasChildFolders: true, branchProbeLoading: false, children: [] }
    : { kind: "file", path, name, depth: 0 };
}

async function refreshRoots() {
  const token = generation, request = ++rootsRequest, reference = { ...props.workspaceRef };
  loading.value = true;
  error.value = "";
  try {
    const paths = hiddenRoots.value;
    const stats: Awaited<ReturnType<typeof statWorkspaceEntries>> = [];
    for (let index = 0; index < paths.length; index += 200) {
      stats.push(...await statWorkspaceEntries(paths.slice(index, index + 200), reference));
      if (!valid(token) || request !== rootsRequest) return;
    }
    if (!valid(token) || request !== rootsRequest) return;
    const previous = new Map(roots.value.map(item => [item.path, item]));
    roots.value = stats.filter(stat => stat.exists && (stat.entryKind === "folder" || stat.entryKind === "file"))
      .map(stat => {
        const old = previous.get(stat.path);
        return old?.kind === stat.entryKind ? old : node(stat.path, stat.path.split("/").pop()!, stat.entryKind === "folder");
      }).sort((a, b) => Number(b.kind === "folder") - Number(a.kind === "folder") || a.path.localeCompare(b.path));
  } catch (failure) {
    if (valid(token) && request === rootsRequest) error.value = normalizeAppError(failure).message;
  } finally {
    if (valid(token) && request === rootsRequest) loading.value = false;
  }
}

async function load(folder: Extract<AssetExplorerNode, { kind: "folder" }>, append = false) {
  if (folder.loading) return;
  const token = generation;
  folder.loading = true;
  try {
    const page = await listDirEntriesPage(folder.path, props.workspaceRef,
      append ? folder.nextOffset : 0, append ? 200 : Math.max(200, folder.nextOffset), true);
    if (!valid(token)) return;
    const previous = new Map(folder.children.map(item => [item.path, item]));
    const children = page.entries.map(entry => {
      const old = previous.get(entry.relPath);
      return old?.kind === (entry.isDir ? "folder" : "file") ? old : node(entry.relPath, entry.name, entry.isDir);
    });
    folder.children = append ? [...folder.children, ...children] : children;
    folder.loaded = true;
    folder.hasMore = page.hasMore;
    folder.nextOffset = page.nextOffset;
    folder.totalCount = page.totalCount;
  } catch (failure) {
    if (valid(token)) emit("error", normalizeAppError(failure).message);
  } finally { folder.loading = false; }
}

const entries = computed(() => workspaceFileEntries(roots.value, path => expanded.value.has(path), t("asset.explorer.loadMore"))
  .map(entry => ({ ...entry, treeRow: { ...entry.treeRow!,
    // Root paths distinguish identically named files hidden from different folders.
    name: entry.treeRow!.depth === 0 && !entry.loadMore ? entry.node.path : entry.treeRow!.name,
    title: `${props.workingDir.replace(/[\\/]$/, "")}/${entry.node.path}`,
    selected: !entry.loadMore && props.selectedPath === entry.node.path,
  } })));

async function activate(entry: WorkspaceFileEntry) {
  const item = entry.node;
  if (item.kind === "file") { emit("openFile", item); return; }
  if (entry.loadMore) { await load(item, true); return; }
  const next = new Set(expanded.value);
  if (next.has(item.path)) next.delete(item.path);
  else next.add(item.path);
  expanded.value = next;
  if (next.has(item.path) && !item.loaded) await load(item);
}
function visibleRange(range: { start: number; end: number }) {
  for (const entry of entries.value.slice(range.start, range.end + 1)) {
    if (entry.loadMore && entry.node.kind === "folder" && !entry.node.loading && entry.node.hasMore) void load(entry.node, true);
  }
}

function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(async () => {
    const token = generation;
    await refreshRoots();
    if (!valid(token)) return;
    async function refreshFolders(nodes: AssetExplorerNode[]) {
      for (const item of nodes) {
        if (!valid(token)) return;
        if (item.kind !== "folder" || !item.loaded) continue;
        await load(item);
        await refreshFolders(item.children);
      }
    }
    await refreshFolders(roots.value);
  }, 150);
}
watch(identity, () => { generation++; roots.value = []; expanded.value = new Set(); }, { flush: "sync" });
watch([identity, hiddenRoots], () => { void refreshRoots(); }, { immediate: true });
for (const subscription of [
  subscribeWorkspaceFileChanges(event => {
    if (event.checkoutId === props.workspaceRef.checkoutId) scheduleRefresh();
  }, () => props.workspaceRef),
  subscribeExplorerFileActions(event => { if (rootKey(event.root) === rootKey(props.workingDir)) scheduleRefresh(); }),
]) void subscription.then(release => { if (disposed) release(); else releases.push(release); }).catch(() => {});
onBeforeUnmount(() => { disposed = true; generation++; clearTimeout(refreshTimer); releases.forEach(release => release()); });
</script>

<template>
  <WorkspaceTree class="workspace-archived-files" navigation :items="entries" :row-height="WORKSPACE_FILE_ROW_HEIGHT"
    :resource-rename="resourceRename"
    :base-indent="12" :row-tab-index="0" @activate="activate($event as WorkspaceFileEntry)" @visible-range-change="visibleRange"
    @contextmenu="(item, event) => !(item as WorkspaceFileEntry).loadMore && emit('contextmenu', item as WorkspaceFileEntry, event)">
    <template #icon="{ item, size }">
      <LucideIcon :icon="(item as WorkspaceFileEntry).node.kind === 'folder' ? item.treeRow?.expanded ? ChevronDown : ChevronRight
        : unityAssetIconNodeForPath((item as WorkspaceFileEntry).node.path, { isFolder: false })"
        :class="(item as WorkspaceFileEntry).node.kind === 'file' ? unityAssetIconClassForPath((item as WorkspaceFileEntry).node.path, { isFolder: false }) : undefined" :size="size" />
    </template>
    <template #empty><div class="archived-files-empty">{{ error || t(loading ? 'common.loading' : 'development.archivedFiles.empty') }}</div></template>
  </WorkspaceTree>
</template>

<style scoped>
.archived-files-empty { padding: 12px; color: var(--text-secondary); font-size: 12px; }
</style>
