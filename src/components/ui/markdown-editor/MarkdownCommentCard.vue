<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { Check, Pencil, RotateCcw, Trash2, type IconNode } from "lucide";
import { t } from "../../../i18n";
import LucideIcon from "../../icons/LucideIcon.vue";
import BaseButton from "../BaseButton.vue";
import type { CommentStatus } from "../../../document/markdownComments";
import { formatCommentTime, type MarkdownCommentThreadView } from "./markdownCommentController";

const props = withDefaults(defineProps<{
  /** Existing thread; omitted for a new comment. */
  thread?: MarkdownCommentThreadView | null;
  /** Quoted text of a new comment. */
  draftQuote?: string | null;
  active?: boolean;
  canEdit?: boolean;
  /** Saved author name; empty asks for one in the composer. */
  author?: string;
  /** Show the quoted text (detached threads, popovers). */
  showQuote?: boolean;
  canReattach?: boolean;
  /** Inside a floating panel: no own border. */
  embedded?: boolean;
}>(), {
  thread: null,
  draftQuote: null,
  active: false,
  canEdit: false,
  author: "",
  showQuote: false,
  canReattach: false,
  embedded: false,
});

const emit = defineEmits<{
  activate: [];
  close: [];
  submit: [text: string, author: string];
  cancel: [];
  reply: [text: string, author: string];
  edit: [messageId: string, text: string];
  deleteMessage: [messageId: string];
  status: [status: CommentStatus];
  remove: [];
  reattach: [];
}>();

const composer = ref("");
const authorDraft = ref(props.author);
const editingId = ref<string | null>(null);
const editText = ref("");
const composerRef = ref<HTMLTextAreaElement | null>(null);
const editRef = ref<HTMLTextAreaElement[] | HTMLTextAreaElement | null>(null);

const isDraft = computed(() => !props.thread);
const expanded = computed(() => props.active || isDraft.value);
const needsAuthor = computed(() => !props.author.trim());
const replyCount = computed(() => Math.max(0, (props.thread?.messages.length ?? 0) - 1));
const visibleMessages = computed(() => {
  const messages = props.thread?.messages ?? [];
  return expanded.value ? messages : messages.slice(0, 1);
});
const quoteText = computed(() => {
  if (isDraft.value) return props.showQuote ? props.draftQuote ?? "" : "";
  if (props.thread?.document) return t("editor.comment.document");
  return props.showQuote || !props.thread?.anchored ? props.thread?.quote ?? "" : "";
});
const showComposer = computed(() => props.canEdit && (isDraft.value
  || (props.active && props.thread?.status === "open" && !editingId.value)));
const statusIcon = computed<IconNode>(() => props.thread?.status === "resolved" ? RotateCcw : Check);

watch(() => props.author, (value) => { if (!authorDraft.value.trim()) authorDraft.value = value; });
watch(() => props.active, (active) => {
  if (active) return;
  editingId.value = null;
});

function submit(): void {
  const text = composer.value.trim();
  if (!text) return;
  const author = authorDraft.value.trim() || props.author;
  if (isDraft.value) emit("submit", text, author);
  else emit("reply", text, author);
  composer.value = "";
}

function cancelComposer(): void {
  composer.value = "";
  if (isDraft.value) emit("cancel");
  else emit("close");
}

function startEdit(messageId: string, text: string): void {
  editingId.value = messageId;
  editText.value = text;
  void nextTick(() => {
    const element = Array.isArray(editRef.value) ? editRef.value[0] : editRef.value;
    element?.focus();
  });
}

function saveEdit(): void {
  const id = editingId.value;
  const text = editText.value.trim();
  if (!id || !text) return;
  emit("edit", id, text);
  editingId.value = null;
}

function onComposerKeydown(event: KeyboardEvent): void {
  if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    submit();
  } else if (event.key === "Escape") {
    event.preventDefault();
    cancelComposer();
  }
}

function onEditKeydown(event: KeyboardEvent): void {
  if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    saveEdit();
  } else if (event.key === "Escape") {
    event.preventDefault();
    editingId.value = null;
  }
}

function onCardClick(event: MouseEvent): void {
  if (props.active || isDraft.value) return;
  const target = event.target as Element | null;
  if (target?.closest("button, textarea, input, a")) return;
  emit("activate");
}

function removeMessage(index: number, messageId: string): void {
  if (index === 0) emit("remove");
  else emit("deleteMessage", messageId);
}

onMounted(() => {
  if (isDraft.value) void nextTick(() => composerRef.value?.focus());
});

defineExpose({ focusComposer: () => composerRef.value?.focus() });
</script>

<template>
  <article
    class="markdown-comment-card"
    :class="{
      'is-active': expanded,
      'is-resolved': thread?.status === 'resolved',
      'is-embedded': embedded,
    }"
    @click="onCardClick"
  >
    <p v-if="quoteText" class="comment-card-quote" :title="quoteText">{{ quoteText }}</p>
    <template v-if="thread">
      <div v-for="(message, index) in visibleMessages" :key="message.id" class="comment-message">
        <div class="comment-message-head">
          <span class="comment-author">{{ message.author || t("editor.comment.unnamed") }}</span>
          <span class="comment-time">
            {{ formatCommentTime(message.time) }}<template v-if="message.edited"> · {{ t("editor.comment.edited") }}</template>
          </span>
          <span v-if="active && canEdit" class="comment-actions">
            <button
              v-if="index === 0"
              type="button"
              class="comment-icon-button"
              :title="t(thread.status === 'resolved' ? 'editor.comment.reopen' : 'editor.comment.resolve')"
              :aria-label="t(thread.status === 'resolved' ? 'editor.comment.reopen' : 'editor.comment.resolve')"
              @click.stop="emit('status', thread.status === 'resolved' ? 'open' : 'resolved')"
            >
              <LucideIcon :icon="statusIcon" :size="13" />
            </button>
            <button
              type="button"
              class="comment-icon-button"
              :title="t('editor.comment.edit')"
              :aria-label="t('editor.comment.edit')"
              @click.stop="startEdit(message.id, message.text)"
            >
              <LucideIcon :icon="Pencil" :size="12" />
            </button>
            <button
              type="button"
              class="comment-icon-button"
              :title="t(index === 0 ? 'editor.comment.delete' : 'editor.comment.deleteReply')"
              :aria-label="t(index === 0 ? 'editor.comment.delete' : 'editor.comment.deleteReply')"
              @click.stop="removeMessage(index, message.id)"
            >
              <LucideIcon :icon="Trash2" :size="12" />
            </button>
          </span>
          <span v-else-if="index === 0 && thread.status === 'resolved'" class="comment-status">{{ t("editor.comment.resolved") }}</span>
        </div>
        <div v-if="editingId === message.id" class="comment-composer">
          <textarea
            ref="editRef"
            v-model="editText"
            class="comment-textarea"
            rows="2"
            :aria-label="t('editor.comment.edit')"
            @keydown="onEditKeydown"
          />
          <div class="comment-composer-actions">
            <BaseButton @click.stop="editingId = null">{{ t("editor.comment.cancel") }}</BaseButton>
            <BaseButton variant="primary" :disabled="!editText.trim()" @click.stop="saveEdit">{{ t("editor.comment.save") }}</BaseButton>
          </div>
        </div>
        <p v-else class="comment-message-text" :class="{ 'is-clamped': !expanded }">{{ message.text }}</p>
      </div>
      <div v-if="!expanded && replyCount" class="comment-replies">{{ t("editor.comment.replies", replyCount) }}</div>
      <BaseButton
        v-if="active && canEdit && canReattach && !thread.anchored && !thread.document"
        class="comment-reattach"
        @click.stop="emit('reattach')"
      >
        {{ t("editor.comment.reattach") }}
      </BaseButton>
    </template>
    <div v-if="showComposer" class="comment-composer">
      <input
        v-if="needsAuthor"
        v-model="authorDraft"
        class="comment-author-input"
        type="text"
        maxlength="64"
        spellcheck="false"
        :placeholder="t('editor.comment.authorPlaceholder')"
        :aria-label="t('editor.comment.authorPlaceholder')"
        @keydown="onComposerKeydown"
      />
      <textarea
        ref="composerRef"
        v-model="composer"
        class="comment-textarea"
        rows="2"
        :placeholder="t(isDraft ? 'editor.comment.placeholder' : 'editor.comment.replyPlaceholder')"
        :aria-label="t(isDraft ? 'editor.comment.placeholder' : 'editor.comment.replyPlaceholder')"
        @keydown="onComposerKeydown"
      />
      <div v-if="isDraft || composer.trim()" class="comment-composer-actions">
        <BaseButton @click.stop="cancelComposer">{{ t("editor.comment.cancel") }}</BaseButton>
        <BaseButton variant="primary" :disabled="!composer.trim()" @click.stop="submit">
          {{ t(isDraft ? "editor.comment.submit" : "editor.comment.reply") }}
        </BaseButton>
      </div>
    </div>
  </article>
</template>

<style scoped>
.markdown-comment-card {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 100%;
  padding: 8px 10px;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  background: var(--panel-bg);
  color: var(--text-color);
  font-family: var(--font-ui);
  font-size: 12px;
  line-height: 1.55;
  cursor: pointer;
  transition: border-color 0.12s ease, background 0.12s ease;
}

.markdown-comment-card:hover:not(.is-active) {
  border-color: var(--border-strong, var(--border-color));
}

.markdown-comment-card.is-active {
  border-color: color-mix(in srgb, var(--accent-color) 55%, var(--border-color));
  cursor: default;
}

.markdown-comment-card.is-resolved:not(.is-active) {
  opacity: 0.72;
}

.markdown-comment-card.is-embedded {
  border: 0;
  border-radius: 0;
  background: transparent;
}

.comment-card-quote {
  margin: 0;
  padding-left: 8px;
  border-left: 2px solid color-mix(in srgb, var(--accent-color) 45%, transparent);
  overflow: hidden;
  color: var(--text-secondary);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.comment-message {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.comment-message + .comment-message {
  padding-top: 8px;
  border-top: 1px solid color-mix(in srgb, var(--border-color) 70%, transparent);
}

.comment-message-head {
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 22px;
  min-width: 0;
}

.comment-author {
  overflow: hidden;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.comment-time,
.comment-status {
  flex-shrink: 0;
  color: var(--text-secondary);
  font-size: 11px;
}

.comment-status {
  margin-left: auto;
}

.comment-actions {
  display: inline-flex;
  flex-shrink: 0;
  gap: 2px;
  margin-left: auto;
}

.comment-icon-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: 4px;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
}

.comment-icon-button:hover,
.comment-icon-button:focus-visible {
  border-color: var(--border-color);
  background: var(--hover-bg);
  color: var(--text-color);
  outline: none;
}

.comment-message-text {
  margin: 0;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}

.comment-message-text.is-clamped {
  display: -webkit-box;
  overflow: hidden;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
}

.comment-replies {
  color: var(--text-secondary);
  font-size: 11px;
}

.comment-reattach {
  align-self: flex-start;
}

.comment-composer {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.comment-author-input,
.comment-textarea {
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  padding: 5px 8px;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  background: var(--input-bg, var(--bg-color));
  color: var(--text-color);
  font: inherit;
  outline: none;
}

.comment-textarea {
  min-height: 52px;
  max-height: 220px;
  resize: none;
  field-sizing: content;
}

.comment-author-input:focus,
.comment-textarea:focus {
  border-color: var(--accent-border, var(--accent-color));
}

.comment-composer-actions {
  display: flex;
  justify-content: flex-end;
  gap: 4px;
}
</style>
