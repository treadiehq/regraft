<script setup lang="ts">
import { computed, ref } from "vue";
import { highlightLines } from "../lib/highlight";
import type { ConflictRegion } from "../lib/rows";
import type { ConflictChoice } from "../lib/types";

const props = defineProps<{
  region: ConflictRegion;
  total: number;
  lang: string | null;
  busy: boolean;
}>();

const emit = defineEmits<{ choose: [choice: ConflictChoice, text?: string] }>();

const customizing = ref(false);
const customText = ref("");
const showBase = ref(false);

function html(code: string): string[] {
  return highlightLines(code.replace(/\n$/, ""), props.lang);
}

const upstreamHtml = computed(() => (props.region.upstream === "" ? [] : html(props.region.upstream)));
const localHtml = computed(() => (props.region.local === "" ? [] : html(props.region.local)));
const baseHtml = computed(() => (props.region.base === "" ? [] : html(props.region.base)));

function startCustom(): void {
  customText.value = `${props.region.local}${props.region.upstream}`.replace(/\n$/, "");
  customizing.value = true;
}

function applyCustom(): void {
  emit("choose", "custom", customText.value === "" ? "" : `${customText.value}\n`);
  customizing.value = false;
}
</script>

<template>
  <div
    class="rise-in @container mx-3.5 my-2 overflow-hidden rounded-xl border bg-panel"
    style="border-color: color-mix(in srgb, var(--color-warn) 35%, var(--color-line))"
    :data-conflict="region.index"
  >
    <header
      class="flex items-center gap-2 overflow-hidden px-3.5 py-2 whitespace-nowrap"
      style="background: color-mix(in srgb, var(--color-warn) 5%, transparent)"
    >
      <span class="size-1.5 shrink-0 rounded-full bg-warn" />
      <span class="text-[11.5px] font-semibold text-warn-soft">Region {{ region.index + 1 }} of {{ total }}</span>
      <span class="truncate text-[11px] text-fg-dim">line {{ region.lineStart }}</span>
      <button
        type="button"
        class="btn-ghost btn ml-auto shrink-0 !px-2 !py-0.5 !text-[11px]"
        @click="showBase = !showBase"
      >
        {{ showBase ? "Hide" : "Show" }} original
      </button>
    </header>

    <div v-if="showBase" class="border-t border-line-soft px-3.5 py-2">
      <p class="mb-1 text-[10.5px] font-medium tracking-wide text-fg-dim uppercase">What both sides started from</p>
      <div class="code-grid overflow-x-auto rounded-md bg-code px-3 py-1.5 opacity-70">
        <div v-for="(line, i) in baseHtml" :key="i" class="whitespace-pre" v-html="line" />
        <div v-if="baseHtml.length === 0" class="text-fg-dim">(empty)</div>
      </div>
    </div>

    <div
      v-if="!customizing"
      class="grid grid-cols-1 divide-y divide-line-soft border-t border-line-soft @xl:grid-cols-2 @xl:divide-x @xl:divide-y-0"
    >
      <div class="flex min-w-0 flex-col">
        <div class="flex items-center gap-1.5 px-3.5 pt-2.5 pb-1.5">
          <span class="size-1.5 rounded-full bg-accent" />
          <span class="text-[10.5px] font-semibold tracking-wide text-fg-mid uppercase">Upstream now says</span>
        </div>
        <div class="code-grid mx-3.5 mb-2.5 max-h-56 flex-1 overflow-auto rounded-md bg-code px-3 py-1.5">
          <div v-for="(line, i) in upstreamHtml" :key="i" class="whitespace-pre" v-html="line" />
          <div v-if="upstreamHtml.length === 0" class="py-1 text-[11.5px] text-fg-dim italic">upstream removed these lines</div>
        </div>
        <div class="px-3.5 pb-3">
          <button type="button" class="btn w-full justify-center !text-[12px]" :disabled="busy" @click="emit('choose', 'upstream')">
            Use upstream
          </button>
        </div>
      </div>

      <div class="flex min-w-0 flex-col">
        <div class="flex items-center gap-1.5 px-3.5 pt-2.5 pb-1.5">
          <span class="size-1.5 rounded-full bg-local" />
          <span class="text-[10.5px] font-semibold tracking-wide text-fg-mid uppercase">Your version says</span>
        </div>
        <div class="code-grid mx-3.5 mb-2.5 max-h-56 flex-1 overflow-auto rounded-md bg-code px-3 py-1.5">
          <div v-for="(line, i) in localHtml" :key="i" class="whitespace-pre" v-html="line" />
          <div v-if="localHtml.length === 0" class="py-1 text-[11.5px] text-fg-dim italic">you removed these lines</div>
        </div>
        <div class="px-3.5 pb-3">
          <button type="button" class="btn w-full justify-center !text-[12px]" :disabled="busy" @click="emit('choose', 'local')">
            Keep yours
          </button>
        </div>
      </div>
    </div>

    <div v-else class="border-t border-line-soft p-3.5">
      <p class="mb-1.5 text-[10.5px] font-medium tracking-wide text-fg-dim uppercase">Write the combination</p>
      <textarea
        v-model="customText"
        class="code-grid h-44 w-full resize-y rounded-md border border-line bg-code px-3 py-2 text-fg outline-none focus:border-accent/50"
        spellcheck="false"
      />
      <div class="mt-2 flex justify-end gap-2">
        <button type="button" class="btn btn-ghost !text-[12px]" @click="customizing = false">Cancel</button>
        <button type="button" class="btn btn-primary !text-[12px]" :disabled="busy" @click="applyCustom">Apply combination</button>
      </div>
    </div>

    <footer v-if="!customizing" class="flex items-center border-t border-line-soft px-3.5 py-1.5">
      <button type="button" class="btn-ghost btn !px-2 !py-1 !text-[11.5px]" :disabled="busy" @click="startCustom">
        <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
          <path d="M11.5 2.5l2 2L6 12l-2.7.7L4 10l7.5-7.5z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" />
        </svg>
        Combine by hand
      </button>
    </footer>
  </div>
</template>
