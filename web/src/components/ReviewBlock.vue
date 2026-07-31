<script setup lang="ts">
import { computed, ref } from "vue";
import { highlightLines } from "../lib/highlight";
import type { UiReviewRegion } from "../lib/types";

const props = defineProps<{
  region: UiReviewRegion;
  total: number;
  lang: string | null;
  busy: boolean;
}>();

const emit = defineEmits<{ reopen: [] }>();

const comparing = ref(false);

const STATUS_META: Record<string, { label: string; color: string }> = {
  upstream: { label: "took upstream", color: "var(--color-accent)" },
  local: { label: "kept yours", color: "var(--color-local)" },
  base: { label: "reverted to original", color: "var(--color-fg-dim)" },
  custom: { label: "custom combination", color: "var(--color-info)" },
};

const meta = computed(() => STATUS_META[props.region.status] ?? STATUS_META.custom!);

function html(code: string): string[] {
  return code === "" ? [] : highlightLines(code.replace(/\n$/, ""), props.lang);
}

const chosenHtml = computed(() => html(props.region.text));
const upstreamHtml = computed(() => html(props.region.upstream));
const localHtml = computed(() => html(props.region.local));
</script>

<template>
  <div
    class="rise-in @container mx-3.5 my-2 overflow-hidden rounded-xl border bg-panel"
    :style="{ borderColor: `color-mix(in srgb, ${meta.color} 30%, var(--color-line))` }"
    :data-conflict="region.index"
  >
    <header
      class="flex items-center gap-2 overflow-hidden px-3.5 py-2 whitespace-nowrap"
      :style="{ background: `color-mix(in srgb, ${meta.color} 5%, transparent)` }"
    >
      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" class="shrink-0" :style="{ color: meta.color }">
        <path d="M3 8.5l3.5 3.5L13 5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
      <span class="text-[11.5px] font-semibold" :style="{ color: meta.color }">
        Region {{ region.index + 1 }} of {{ total }} — {{ meta.label }}
      </span>
      <span class="truncate text-[11px] text-fg-dim">line {{ region.line }}</span>
      <div class="ml-auto flex shrink-0 items-center gap-1">
        <button type="button" class="btn-ghost btn !px-2 !py-0.5 !text-[11px]" @click="comparing = !comparing">
          {{ comparing ? "Hide sides" : "Compare sides" }}
        </button>
        <button type="button" class="btn-ghost btn !px-2 !py-0.5 !text-[11px]" :disabled="busy" @click="emit('reopen')">
          <svg width="10" height="10" viewBox="0 0 16 16" fill="none">
            <path d="M3 8a5 5 0 1 1 1.5 3.6M3 8V4.5M3 8h3.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
          Reopen
        </button>
      </div>
    </header>

    <div class="code-grid max-h-56 overflow-auto border-t border-line-soft bg-code px-3 py-1.5">
      <div v-for="(line, i) in chosenHtml" :key="i" class="whitespace-pre" v-html="line" />
      <div v-if="chosenHtml.length === 0" class="py-1 text-[11.5px] text-fg-dim italic">
        resolved by removing these lines
      </div>
    </div>

    <div v-if="comparing" class="grid grid-cols-1 divide-y divide-line-soft border-t border-line-soft @xl:grid-cols-2 @xl:divide-x @xl:divide-y-0">
      <div class="min-w-0 px-3.5 py-2.5">
        <p class="mb-1.5 flex items-center gap-1.5 text-[10.5px] font-semibold tracking-wide text-fg-mid uppercase">
          <span class="size-1.5 rounded-full bg-accent" />
          Upstream said
        </p>
        <div class="code-grid max-h-40 overflow-auto rounded-md bg-code px-3 py-1.5">
          <div v-for="(line, i) in upstreamHtml" :key="i" class="whitespace-pre" v-html="line" />
          <div v-if="upstreamHtml.length === 0" class="py-1 text-[11.5px] text-fg-dim italic">upstream removed these lines</div>
        </div>
      </div>
      <div class="min-w-0 px-3.5 py-2.5">
        <p class="mb-1.5 flex items-center gap-1.5 text-[10.5px] font-semibold tracking-wide text-fg-mid uppercase">
          <span class="size-1.5 rounded-full bg-local" />
          You said
        </p>
        <div class="code-grid max-h-40 overflow-auto rounded-md bg-code px-3 py-1.5">
          <div v-for="(line, i) in localHtml" :key="i" class="whitespace-pre" v-html="line" />
          <div v-if="localHtml.length === 0" class="py-1 text-[11.5px] text-fg-dim italic">you removed these lines</div>
        </div>
      </div>
    </div>
  </div>
</template>
