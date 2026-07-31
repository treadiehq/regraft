<script setup lang="ts">
import { computed, ref } from "vue";
import { highlightLines } from "../lib/highlight";
import { foldRows, linesVsBase, type PaneRow } from "../lib/rows";

const props = defineProps<{
  title: string;
  meta?: string;
  /** Visual identity of this pane: upstream (emerald) or local (violet). */
  tone: "upstream" | "local";
  text: string | null;
  /** Reference text used to tint changed lines; null disables tinting. */
  base: string | null;
  lang: string | null;
  note?: string;
}>();

const expanded = ref<Set<number>>(new Set());
const container = ref<HTMLElement | null>(null);

const lines = computed(() => (props.text === null ? [] : linesVsBase(props.text, props.base)));
const rendered = computed(() => (props.text === null ? [] : highlightLines(props.text, props.lang)));
const rows = computed<PaneRow[]>(() => foldRows(lines.value, expanded.value));
const changedCount = computed(() => lines.value.filter((line) => line.changed).length);

function expandFold(id: number): void {
  const next = new Set(expanded.value);
  next.add(id);
  expanded.value = next;
}

function scrollToLine(no: number): void {
  // Make sure the target is not inside a collapsed fold.
  for (const row of rows.value) {
    if (row.kind === "fold" && row.lines.some((line) => line.no === no)) expandFold(row.id);
  }
  requestAnimationFrame(() => {
    const el = container.value?.querySelector(`[data-ln="${no}"]`);
    el?.scrollIntoView({ block: "center", behavior: "smooth" });
    el?.classList.add("flash-line");
    window.setTimeout(() => el?.classList.remove("flash-line"), 1200);
  });
}

defineExpose({ scrollToLine });

const toneDot = computed(() => (props.tone === "upstream" ? "bg-accent" : "bg-local"));
const chgClass = computed(() => (props.tone === "upstream" ? "chg-upstream" : "chg-local"));
</script>

<template>
  <section class="flex min-w-0 flex-col overflow-hidden">
    <header class="flex h-9 shrink-0 items-center gap-2 overflow-hidden border-b border-line-soft bg-panel px-3.5 whitespace-nowrap">
      <span class="size-1.5 shrink-0 rounded-full" :class="toneDot" />
      <span class="truncate text-[11.5px] font-semibold tracking-[0.08em] text-fg-mid uppercase">{{ title }}</span>
      <span v-if="meta" class="shrink-0 font-mono text-[10.5px] text-fg-dim">{{ meta }}</span>
      <span class="ml-auto flex shrink-0 items-center gap-2 text-[10.5px] text-fg-dim">
        <span v-if="note" class="text-fg-dim">{{ note }}</span>
        <span v-if="changedCount > 0" class="font-mono">{{ changedCount }} changed</span>
      </span>
    </header>

    <div ref="container" class="code-grid min-h-0 flex-1 overflow-auto bg-code py-2">
      <template v-if="text !== null">
        <template v-for="(row, i) in rows" :key="i">
          <button v-if="row.kind === 'fold'" type="button" class="fold-bar" @click="expandFold(row.id)">
            <svg width="10" height="10" viewBox="0 0 16 16" fill="none" class="opacity-70">
              <path d="M4 6l4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
            {{ row.count }} unchanged lines
          </button>
          <div v-else class="code-line" :class="row.line.changed ? chgClass : ''" :data-ln="row.line.no">
            <span class="ln">{{ row.line.no }}</span>
            <span class="lc" v-html="rendered[row.line.no - 1] ?? ''" />
          </div>
        </template>
      </template>
      <div v-else class="flex h-full items-center justify-center px-6 text-center text-[12.5px] text-fg-dim">
        <slot name="empty">No content on this side.</slot>
      </div>
    </div>
  </section>
</template>

<style scoped>
.flash-line {
  transition: background-color 600ms ease;
  background: color-mix(in srgb, var(--color-warn) 14%, transparent) !important;
}
</style>
