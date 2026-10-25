<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useWindowSurface } from "../../../composables/useWindowSurface";
import { clampFloatingPosition } from "../floatingPosition";
import type { FloatingAnchorRect, FloatingCloseReason } from "./markdownFloating";

const props = withDefaults(defineProps<{
  anchor: FloatingAnchorRect | null;
  width?: number;
  ariaLabel?: string;
}>(), {
  width: 300,
  ariaLabel: "",
});

const emit = defineEmits<{ close: [reason: FloatingCloseReason] }>();
const { ownerWindow, ownerDocument } = useWindowSurface();
const panelRef = ref<HTMLElement | null>(null);
const position = ref({ x: -9999, y: -9999 });

async function place(): Promise<void> {
  await nextTick();
  const panel = panelRef.value;
  const anchor = props.anchor;
  if (!panel || !anchor) return;
  const viewport = {
    width: ownerWindow.innerWidth || ownerDocument.documentElement.clientWidth,
    height: ownerWindow.innerHeight || ownerDocument.documentElement.clientHeight,
  };
  const size = { width: panel.offsetWidth, height: panel.offsetHeight };
  const below = anchor.bottom + 6;
  const y = below + size.height > viewport.height - 8 && anchor.top - size.height - 6 >= 8
    ? anchor.top - size.height - 6
    : below;
  position.value = clampFloatingPosition({ x: anchor.left - 8, y }, size, viewport);
}

function onPointerDown(event: PointerEvent): void {
  const target = event.target as Node | null;
  if (target && panelRef.value?.contains(target)) return;
  emit("close", "outside");
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key !== "Escape" || event.defaultPrevented) return;
  event.preventDefault();
  emit("close", "escape");
}

let resizeObserver: ResizeObserver | null = null;

watch(() => props.anchor, () => { void place(); }, { deep: true });

onMounted(() => {
  void place();
  ownerDocument.addEventListener("pointerdown", onPointerDown, true);
  ownerDocument.addEventListener("keydown", onKeydown);
  if (typeof ResizeObserver !== "undefined" && panelRef.value) {
    resizeObserver = new ResizeObserver(() => { void place(); });
    resizeObserver.observe(panelRef.value);
  }
});

onBeforeUnmount(() => {
  ownerDocument.removeEventListener("pointerdown", onPointerDown, true);
  ownerDocument.removeEventListener("keydown", onKeydown);
  resizeObserver?.disconnect();
});

defineExpose({ place });
</script>

<template>
  <Teleport :to="ownerDocument.body">
    <div
      ref="panelRef"
      class="markdown-floating-panel"
      role="dialog"
      :aria-label="ariaLabel || undefined"
      :style="{ left: `${position.x}px`, top: `${position.y}px`, width: `${width}px` }"
      @mousedown.stop
      @contextmenu.stop
    >
      <slot />
    </div>
  </Teleport>
</template>

<style scoped>
.markdown-floating-panel {
  position: fixed;
  z-index: 10000;
  box-sizing: border-box;
  max-width: calc(100vw - 16px);
  max-height: calc(100vh - 16px);
  overflow: auto;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  background: var(--elevated-bg, var(--panel-bg));
  box-shadow: 0 12px 28px rgba(0, 0, 0, 0.22);
  color: var(--text-color);
}
</style>
