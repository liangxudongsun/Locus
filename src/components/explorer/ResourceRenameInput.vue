<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import { t } from "../../i18n";
import type { ExplorerResourceRename } from "./explorerResourceActions";

const props = defineProps<{ rename: ExplorerResourceRename }>();
const input = ref<HTMLInputElement | null>(null);
const errorId = `resource-rename-error-${crypto.randomUUID()}`;
const composing = ref(false);

onMounted(() => {
  input.value?.focus();
  // Folder names have no extension to keep, e.g. "v1.2".
  const dot = props.rename.target.isDirectory ? -1 : props.rename.name.lastIndexOf(".");
  input.value?.setSelectionRange(0, dot > 0 ? dot : props.rename.name.length);
});
// A virtualized row or its checkout can disappear while being edited.
onBeforeUnmount(() => props.rename.cancel());

function update(event: Event) {
  if (props.rename.busy) return;
  props.rename.name = (event.target as HTMLInputElement).value;
  props.rename.error = "";
}

async function finish(cancel = false) {
  const element = input.value;
  const row = element?.closest(".workspace-tree-row-shell, .adl-row, .alx-row, .asr-row");
  const parent = row?.parentElement;
  const focused = document.activeElement === element;
  if (cancel) props.rename.cancel();
  else await props.rename.submit();
  await nextTick();
  if (focused && document.activeElement === document.body) {
    // Restore keyboard navigation without taking focus from a clicked control.
    const button = row?.isConnected ? row.querySelector<HTMLButtonElement>("button")
      : parent?.querySelector<HTMLButtonElement>("button");
    button?.focus();
  }
}

function keydown(event: KeyboardEvent) {
  if (composing.value || event.isComposing || event.keyCode === 229) return;
  if (event.key !== "Enter" && event.key !== "Escape") return;
  event.preventDefault();
  void finish(event.key === "Escape");
}

function blur() {
  if (props.rename.busy) return;
  if (props.rename.error || composing.value) props.rename.cancel();
  else void props.rename.submit();
}
</script>

<template>
  <span class="resource-rename-editor" @pointerdown.stop @click.stop @dblclick.stop @contextmenu.stop @keydown.stop>
    <input ref="input" class="resource-rename-input" :value="rename.name" :readonly="rename.busy"
      :aria-label="t('knowledge.explorer.rename')" :aria-busy="rename.busy"
      :aria-invalid="!!rename.error" :aria-describedby="rename.error ? errorId : undefined"
      :title="rename.error || undefined" autocomplete="off" spellcheck="false"
      @input="update" @keydown="keydown" @blur="blur"
      @compositionstart="composing = true" @compositionend="composing = false" />
    <span v-if="rename.error" :id="errorId" class="resource-rename-error" role="alert">{{ rename.error }}</span>
  </span>
</template>

<style scoped>
.resource-rename-editor { display: flex; flex: 1; min-width: 0; }
.resource-rename-input {
  width: 100%; min-width: 0; height: 22px; box-sizing: border-box; padding: 0 8px;
  border: 1px solid var(--border-color); border-radius: 6px;
  background: color-mix(in srgb, var(--panel-bg) 82%, var(--bg-color));
  color: var(--text-color); font: inherit; font-family: var(--font-mono-identifier); font-size: 12px;
}
.resource-rename-input:focus {
  outline: none; border-color: var(--accent-color);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent-color) 24%, transparent);
}
.resource-rename-input[aria-invalid="true"] { border-color: var(--status-danger-fg); }
.resource-rename-error { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
</style>
