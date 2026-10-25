<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from "vue";
import type { Text } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { undo, undoDepth } from "@codemirror/commands";
import { LocateFixed, Trash2 } from "lucide";
import { t } from "../../../i18n";
import LucideIcon from "../../icons/LucideIcon.vue";
import BaseButton from "../BaseButton.vue";
import MarkdownFloatingPanel from "./MarkdownFloatingPanel.vue";
import {
  footnoteNumber,
  footnoteText,
  removeMarkdownFootnote,
  revealMarkdownFootnote,
  updateMarkdownFootnote,
} from "./markdownFootnoteEditing";
import type { FloatingAnchorRect } from "./markdownFloating";

const props = defineProps<{
  view: EditorView;
  footnoteKey: string;
  label: string;
  anchor: FloatingAnchorRect;
  /** Just inserted: an empty note is removed again when the panel closes. */
  insertedDoc?: Text | null;
}>();

const emit = defineEmits<{ close: [] }>();
const textareaRef = ref<HTMLTextAreaElement | null>(null);
const initial = footnoteText(props.view.state, props.footnoteKey) ?? "";
const text = ref(initial);
const editable = computed(() => !props.view.state.readOnly);
const number = footnoteNumber(props.view.state, props.footnoteKey);
const title = computed(() => t("editor.footnote.title", number ?? props.label));
const dirty = computed(() => text.value.trim() !== initial.trim());
let closed = false;

function discardFreshNote(): void {
  const view = props.view;
  if (props.insertedDoc && view.state.doc === props.insertedDoc && undoDepth(view.state) > 0) undo(view);
  else removeMarkdownFootnote(view, props.footnoteKey);
}

function finish(): void {
  if (closed) return;
  closed = true;
  if (editable.value) {
    if (props.insertedDoc && !text.value.trim()) discardFreshNote();
    else if (dirty.value) updateMarkdownFootnote(props.view, props.footnoteKey, text.value);
  }
  emit("close");
  props.view.focus();
}

function reveal(): void {
  if (editable.value && dirty.value) updateMarkdownFootnote(props.view, props.footnoteKey, text.value);
  closed = true;
  emit("close");
  revealMarkdownFootnote(props.view, props.footnoteKey);
}

function remove(): void {
  closed = true;
  removeMarkdownFootnote(props.view, props.footnoteKey);
  emit("close");
  props.view.focus();
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    finish();
  }
}

onMounted(() => {
  if (props.insertedDoc) void nextTick(() => textareaRef.value?.focus());
});
</script>

<template>
  <MarkdownFloatingPanel :anchor="anchor" :width="300" :aria-label="title" @close="finish">
    <div class="footnote-popover">
      <div class="footnote-popover-head">
        <span class="footnote-popover-title">{{ title }}</span>
        <button
          type="button"
          class="footnote-icon-button"
          :title="t('editor.footnote.reveal')"
          :aria-label="t('editor.footnote.reveal')"
          @click="reveal"
        >
          <LucideIcon :icon="LocateFixed" :size="13" />
        </button>
        <button
          v-if="editable"
          type="button"
          class="footnote-icon-button"
          :title="t('editor.footnote.remove')"
          :aria-label="t('editor.footnote.remove')"
          @click="remove"
        >
          <LucideIcon :icon="Trash2" :size="13" />
        </button>
      </div>
      <textarea
        v-if="editable"
        ref="textareaRef"
        v-model="text"
        class="footnote-textarea"
        rows="3"
        :placeholder="t('editor.footnote.placeholder')"
        :aria-label="t('editor.footnote.placeholder')"
        @keydown="onKeydown"
      />
      <p v-else class="footnote-text" :class="{ 'is-missing': !text }">{{ text || t("editor.footnote.missing") }}</p>
      <div v-if="editable && (dirty || insertedDoc)" class="footnote-actions">
        <BaseButton variant="primary" @click="finish">{{ t("editor.footnote.done") }}</BaseButton>
      </div>
    </div>
  </MarkdownFloatingPanel>
</template>

<style scoped>
.footnote-popover {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 8px 10px;
  font-family: var(--font-ui);
  font-size: 12px;
  line-height: 1.55;
}

.footnote-popover-head {
  display: flex;
  align-items: center;
  gap: 2px;
}

.footnote-popover-title {
  flex: 1;
  min-width: 0;
  color: var(--text-secondary);
  font-weight: 600;
}

.footnote-icon-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: 4px;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
}

.footnote-icon-button:hover,
.footnote-icon-button:focus-visible {
  border-color: var(--border-color);
  background: var(--hover-bg);
  color: var(--text-color);
  outline: none;
}

.footnote-textarea {
  box-sizing: border-box;
  width: 100%;
  min-height: 60px;
  max-height: 240px;
  padding: 5px 8px;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  background: var(--input-bg, var(--bg-color));
  color: var(--text-color);
  font: inherit;
  outline: none;
  resize: none;
  field-sizing: content;
}

.footnote-textarea:focus {
  border-color: var(--accent-border, var(--accent-color));
}

.footnote-text {
  margin: 0;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}

.footnote-text.is-missing {
  color: var(--text-secondary);
}

.footnote-actions {
  display: flex;
  justify-content: flex-end;
}
</style>
