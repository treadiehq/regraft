<script setup lang="ts">
import { useToasts } from "../lib/toast";

const toasts = useToasts();
</script>

<template>
  <Teleport to="body">
    <div class="pointer-events-none fixed right-4 bottom-4 z-[60] flex w-80 flex-col gap-2">
      <TransitionGroup name="toast">
        <div
          v-for="item in toasts"
          :key="item.id"
          class="pointer-events-auto flex items-start gap-2.5 rounded-xl border bg-raise/95 px-3.5 py-2.5 shadow-xl backdrop-blur"
          :style="{
            borderColor:
              item.tone === 'ok'
                ? 'color-mix(in srgb, var(--color-accent) 35%, transparent)'
                : item.tone === 'warn'
                  ? 'color-mix(in srgb, var(--color-warn) 35%, transparent)'
                  : 'color-mix(in srgb, var(--color-danger) 40%, transparent)',
          }"
        >
          <span
            class="mt-1 size-1.5 shrink-0 rounded-full"
            :class="item.tone === 'ok' ? 'bg-accent' : item.tone === 'warn' ? 'bg-warn' : 'bg-danger'"
          />
          <p class="text-[12px] leading-relaxed text-fg">{{ item.text }}</p>
        </div>
      </TransitionGroup>
    </div>
  </Teleport>
</template>

<style scoped>
.toast-enter-active,
.toast-leave-active {
  transition: all 220ms ease;
}
.toast-enter-from {
  opacity: 0;
  transform: translateY(6px);
}
.toast-leave-to {
  opacity: 0;
  transform: translateX(12px);
}
</style>
