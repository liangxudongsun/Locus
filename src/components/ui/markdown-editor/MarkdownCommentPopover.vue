<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { t } from "../../../i18n";
import { useWindowSurface } from "../../../composables/useWindowSurface";
import { useDocumentEditingSettings } from "../../../composables/useDocumentEditingSettings";
import MarkdownCommentCard from "./MarkdownCommentCard.vue";
import MarkdownFloatingPanel from "./MarkdownFloatingPanel.vue";
import type { MarkdownCommentController } from "./markdownCommentController";
import type { FloatingAnchorRect, FloatingCloseReason } from "./markdownFloating";

/** Thread card next to its anchor when the comment rail is hidden. */
const props = defineProps<{ controller: MarkdownCommentController }>();

const { ownerDocument } = useWindowSurface();
const { state: settings, setCommentAuthor } = useDocumentEditingSettings();
const scrollTick = ref(0);

const activeThread = computed(() => {
  const id = props.controller.activeId.value;
  return id ? props.controller.threads.value.find((thread) => thread.id === id) ?? null : null;
});
const draft = computed(() => props.controller.draft.value);
const open = computed(() => !props.controller.railAvailable.value && (!!draft.value || !!activeThread.value));

const anchor = computed<FloatingAnchorRect | null>(() => {
  void scrollTick.value;
  void props.controller.layoutTick.value;
  const view = props.controller.view.value;
  if (!view || !open.value) return null;
  const position = draft.value ?? (activeThread.value ? props.controller.position(activeThread.value.id) : null);
  const coords = position ? view.coordsAtPos(position.from, 1) : null;
  if (coords) return { left: coords.left, top: coords.top, bottom: coords.bottom };
  const rect = view.contentDOM.getBoundingClientRect();
  return { left: rect.left + 16, top: rect.top, bottom: rect.top + 8 };
});

function rememberAuthor(author: string): void {
  if (!settings.commentAuthor && author.trim()) setCommentAuthor(author);
}

function close(reason: FloatingCloseReason): void {
  // An unfinished comment stays open until it is submitted or cancelled.
  if (draft.value) {
    if (reason === "escape") props.controller.cancelDraft();
    return;
  }
  props.controller.activate(null);
}

function onScroll(): void {
  if (open.value) scrollTick.value += 1;
}

onMounted(() => ownerDocument.addEventListener("scroll", onScroll, true));
onBeforeUnmount(() => ownerDocument.removeEventListener("scroll", onScroll, true));
</script>

<template>
  <MarkdownFloatingPanel
    v-if="open && anchor"
    :anchor="anchor"
    :width="300"
    :aria-label="t('editor.comment.rail')"
    @close="close"
  >
    <MarkdownCommentCard
      v-if="draft"
      embedded
      show-quote
      :draft-quote="draft.quote"
      :can-edit="controller.canEdit.value"
      :author="settings.commentAuthor"
      @submit="(text, author) => { rememberAuthor(author); controller.submitDraft(text, author); }"
      @cancel="controller.cancelDraft()"
    />
    <MarkdownCommentCard
      v-else-if="activeThread"
      embedded
      active
      show-quote
      can-reattach
      :thread="activeThread"
      :can-edit="controller.canEdit.value"
      :author="settings.commentAuthor"
      @close="controller.activate(null)"
      @reply="(text, author) => { rememberAuthor(author); controller.reply(activeThread!.id, text, author); }"
      @edit="(messageId, text) => controller.editMessage(activeThread!.id, messageId, text)"
      @delete-message="(messageId) => controller.deleteMessage(activeThread!.id, messageId)"
      @status="(status) => controller.setStatus(activeThread!.id, status)"
      @remove="controller.remove(activeThread!.id)"
      @reattach="controller.reattach(activeThread!.id)"
    />
  </MarkdownFloatingPanel>
</template>
