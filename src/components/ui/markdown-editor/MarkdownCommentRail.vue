<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch, type ComponentPublicInstance } from "vue";
import type { EditorView } from "@codemirror/view";
import { t } from "../../../i18n";
import { useWindowSurface } from "../../../composables/useWindowSurface";
import { useDocumentEditingSettings } from "../../../composables/useDocumentEditingSettings";
import MarkdownCommentCard from "./MarkdownCommentCard.vue";
import {
  commentRailMinWidth,
  layoutCommentCards,
  type MarkdownCommentController,
  type MarkdownCommentThreadView,
} from "./markdownCommentController";

/**
 * Right margin of a document page: comment cards aligned with the line of
 * their anchor. Hosts place it in the `.document-workspace` grid; it is shown
 * only when the container is wide enough (see markdown-document.css).
 */
const props = defineProps<{ controller: MarkdownCommentController }>();

const DRAFT_KEY = "__comment-draft__";
const { ownerWindow } = useWindowSurface();
const { state: settings, setCommentAuthor } = useDocumentEditingSettings();
const railRef = ref<HTMLElement | null>(null);
const footerRef = ref<HTMLElement | null>(null);
const tops = shallowRef<ReadonlyMap<string, number>>(new Map());
const footerTop = ref(0);
const railHeight = ref(0);
const cardElements = new Map<string, HTMLElement>();
let frame = 0;
/** A new draft card is focused once it has been placed (it is hidden until then). */
let focusDraft = false;
let cardObserver: ResizeObserver | null = null;
let scrollerObserver: ResizeObserver | null = null;
let layoutObserver: MutationObserver | null = null;

interface PlacedItem {
  key: string;
  thread: MarkdownCommentThreadView | null;
}

const controller = computed(() => props.controller);
const visible = (thread: MarkdownCommentThreadView) => thread.status === "open"
  || controller.value.showResolved.value || thread.id === controller.value.activeId.value;

const placedItems = computed<PlacedItem[]>(() => {
  const items: PlacedItem[] = controller.value.threads.value
    .filter((thread) => (thread.anchored || thread.document) && visible(thread))
    .map((thread) => ({ key: thread.id, thread }));
  if (controller.value.draft.value) items.push({ key: DRAFT_KEY, thread: null });
  return items;
});
const detachedThreads = computed(() => controller.value.threads.value
  .filter((thread) => !thread.anchored && !thread.document && visible(thread)));
const resolvedCount = computed(() => controller.value.threads.value.filter((thread) => thread.status === "resolved").length);

function setCardRef(key: string, value: Element | ComponentPublicInstance | null): void {
  const element = value instanceof Element ? value : (value?.$el as Element | undefined) ?? null;
  const previous = cardElements.get(key);
  if (previous && previous !== element) cardObserver?.unobserve(previous);
  if (element instanceof HTMLElement) {
    cardElements.set(key, element);
    cardObserver?.observe(element);
  } else {
    cardElements.delete(key);
  }
}

function anchorTop(view: EditorView, position: number, railTop: number): number {
  const coords = view.coordsAtPos(position, 1);
  if (coords) return coords.top - railTop;
  return view.documentTop + view.lineBlockAt(position).top - railTop;
}

function measure(): void {
  const current = controller.value;
  const view = current.view.value;
  const rail = railRef.value;
  if (!view || !rail || !current.railAvailable.value || !rail.offsetParent) return;
  const railTop = rail.getBoundingClientRect().top;
  const documentTop = view.documentTop - railTop;
  const items = placedItems.value.map((item) => {
    const position = item.thread
      ? (item.thread.document ? null : current.position(item.key))
      : current.draft.value;
    return {
      key: item.key,
      desired: position ? anchorTop(view, position.from, railTop) : documentTop,
      height: cardElements.get(item.key)?.offsetHeight ?? 64,
      order: position?.from ?? -1,
    };
  });
  const activeKey = current.draft.value ? DRAFT_KEY : current.activeId.value;
  const next = layoutCommentCards(items, activeKey);
  tops.value = next;
  let bottom = 0;
  for (const item of items) bottom = Math.max(bottom, (next.get(item.key) ?? 0) + item.height);
  footerTop.value = items.length ? bottom + 16 : Math.max(0, documentTop);
  railHeight.value = footerTop.value + (footerRef.value?.offsetHeight ?? 0);
  if (focusDraft && next.has(DRAFT_KEY)) {
    focusDraft = false;
    void nextTick(() => cardElements.get(DRAFT_KEY)?.querySelector<HTMLTextAreaElement>(".comment-textarea")?.focus());
  }
}

function scheduleMeasure(): void {
  if (frame) return;
  frame = ownerWindow.requestAnimationFrame(() => {
    frame = 0;
    measure();
  });
}

function rememberAuthor(author: string): void {
  if (!settings.commentAuthor && author.trim()) setCommentAuthor(author);
}

function submitDraft(text: string, author: string): void {
  rememberAuthor(author);
  controller.value.submitDraft(text, author);
}

function reply(id: string, text: string, author: string): void {
  rememberAuthor(author);
  controller.value.reply(id, text, author);
}

watch(
  () => controller.value.draft.value ? `${controller.value.draft.value.from}:${controller.value.draft.value.to}` : "",
  (key, previous) => { if (key && key !== previous) focusDraft = true; },
);

watch(
  () => [
    controller.value.layoutTick.value,
    placedItems.value,
    detachedThreads.value.length,
    controller.value.activeId.value,
    controller.value.railAvailable.value,
    controller.value.showResolved.value,
  ],
  scheduleMeasure,
  { flush: "post" },
);

onMounted(() => {
  if (typeof ResizeObserver !== "undefined") {
    cardObserver = new ResizeObserver(scheduleMeasure);
    if (railRef.value) cardObserver.observe(railRef.value);
    for (const element of cardElements.values()) cardObserver.observe(element);
    const scroller = railRef.value?.closest<HTMLElement>(".document-scroller");
    const workspace = railRef.value?.parentElement;
    if (scroller) {
      // Mirrors the container queries, independent of whether comments exist
      // yet, so a new comment opens straight in the rail.
      let width = scroller.clientWidth;
      const update = () => {
        const hasOutline = !!workspace?.classList.contains("has-outline");
        controller.value.railAvailable.value = width >= commentRailMinWidth(hasOutline);
      };
      scrollerObserver = new ResizeObserver((entries) => {
        width = entries[entries.length - 1]?.contentRect.width ?? scroller.clientWidth;
        update();
      });
      scrollerObserver.observe(scroller);
      if (workspace && typeof MutationObserver !== "undefined") {
        layoutObserver = new MutationObserver(update);
        layoutObserver.observe(workspace, { attributes: true, attributeFilter: ["class"] });
      }
    }
  }
  scheduleMeasure();
});

onBeforeUnmount(() => {
  if (frame) ownerWindow.cancelAnimationFrame(frame);
  frame = 0;
  cardObserver?.disconnect();
  scrollerObserver?.disconnect();
  layoutObserver?.disconnect();
  controller.value.railAvailable.value = false;
});
</script>

<template>
  <aside
    ref="railRef"
    class="document-comment-rail"
    :aria-label="t('editor.comment.rail')"
    :style="{ minHeight: `${railHeight}px` }"
  >
    <template v-if="controller.railAvailable.value">
      <div
        v-for="item in placedItems"
        :key="item.key"
        :ref="(element) => setCardRef(item.key, element)"
        class="document-comment-rail-item"
        :class="{ 'is-pending': !tops.has(item.key) }"
        :style="{ top: `${tops.get(item.key) ?? 0}px` }"
      >
        <MarkdownCommentCard
          v-if="item.thread"
          :thread="item.thread"
          :active="item.thread.id === controller.activeId.value"
          :can-edit="controller.canEdit.value"
          :author="settings.commentAuthor"
          @activate="controller.activate(item.key)"
          @close="controller.activate(null)"
          @reply="(text, author) => reply(item.key, text, author)"
          @edit="(messageId, text) => controller.editMessage(item.key, messageId, text)"
          @delete-message="(messageId) => controller.deleteMessage(item.key, messageId)"
          @status="(status) => controller.setStatus(item.key, status)"
          @remove="controller.remove(item.key)"
        />
        <MarkdownCommentCard
          v-else
          :draft-quote="controller.draft.value?.quote ?? ''"
          :can-edit="controller.canEdit.value"
          :author="settings.commentAuthor"
          @submit="submitDraft"
          @cancel="controller.cancelDraft()"
        />
      </div>
      <div ref="footerRef" class="document-comment-rail-footer" :style="{ top: `${footerTop}px` }">
        <template v-if="detachedThreads.length">
          <div class="document-comment-rail-label">{{ t("editor.comment.detached") }}</div>
          <MarkdownCommentCard
            v-for="thread in detachedThreads"
            :key="thread.id"
            :thread="thread"
            :active="thread.id === controller.activeId.value"
            :can-edit="controller.canEdit.value"
            :author="settings.commentAuthor"
            can-reattach
            @activate="controller.activate(thread.id)"
            @close="controller.activate(null)"
            @reply="(text, author) => reply(thread.id, text, author)"
            @edit="(messageId, text) => controller.editMessage(thread.id, messageId, text)"
            @delete-message="(messageId) => controller.deleteMessage(thread.id, messageId)"
            @status="(status) => controller.setStatus(thread.id, status)"
            @remove="controller.remove(thread.id)"
            @reattach="controller.reattach(thread.id)"
          />
        </template>
        <button
          v-if="resolvedCount"
          type="button"
          class="document-comment-rail-toggle"
          @click="controller.setShowResolved(!controller.showResolved.value)"
        >
          {{ controller.showResolved.value ? t("editor.comment.hideResolved") : t("editor.comment.showResolved", resolvedCount) }}
        </button>
      </div>
    </template>
  </aside>
</template>

<style scoped>
.document-comment-rail-item {
  position: absolute;
  left: 0;
  right: 0;
  transition: top 0.12s ease;
}

.document-comment-rail-item.is-pending {
  visibility: hidden;
}

.document-comment-rail-footer {
  position: absolute;
  left: 0;
  right: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.document-comment-rail-label {
  color: var(--text-secondary);
  font-family: var(--font-ui);
  font-size: 11px;
}

.document-comment-rail-toggle {
  align-self: flex-start;
  padding: 2px 6px;
  border: 1px solid transparent;
  border-radius: 4px;
  background: transparent;
  color: var(--text-secondary);
  font-family: var(--font-ui);
  font-size: 11px;
  cursor: pointer;
}

.document-comment-rail-toggle:hover,
.document-comment-rail-toggle:focus-visible {
  border-color: var(--border-color);
  background: var(--hover-bg);
  color: var(--text-color);
  outline: none;
}
</style>
