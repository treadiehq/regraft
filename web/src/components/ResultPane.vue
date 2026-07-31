<script setup lang="ts">
import { computed, ref } from "vue";
import { highlightLines } from "../lib/highlight";
import { resultRows, reviewResultRows, type ConflictRegion, type ResultRow, type ReviewRow } from "../lib/rows";
import type { ConflictChoice, UiFile, UiReviewRegion } from "../lib/types";
import ConflictBlock from "./ConflictBlock.vue";
import ReviewBlock from "./ReviewBlock.vue";

const props = defineProps<{
  file: UiFile;
  lang: string | null;
  busy: boolean;
}>();

const emit = defineEmits<{
  region: [index: number, choice: ConflictChoice, text?: string];
  reopen: [index: number];
}>();

const expanded = ref<Set<number>>(new Set());
const container = ref<HTMLElement | null>(null);

const segments = computed(() => props.file.pending?.segments ?? []);
const review = computed<UiReviewRegion[] | null>(() => props.file.pending?.review ?? null);
const working = computed(() => props.file.pending?.working ?? "");

const unresolvedCount = computed(() =>
  review.value !== null
    ? review.value.filter((region) => region.status === "unresolved").length
    : (props.file.pending?.conflictsRemaining ?? 0),
);
const decidedCount = computed(() =>
  review.value === null ? 0 : review.value.length - unresolvedCount.value,
);
const totalRegions = computed(() =>
  review.value !== null ? review.value.length : unresolvedCount.value,
);

const rows = computed<(ResultRow | ReviewRow)[]>(() =>
  review.value !== null
    ? reviewResultRows(working.value, review.value, expanded.value)
    : resultRows(segments.value, expanded.value),
);

const statusText = computed(() => {
  if (unresolvedCount.value === 0) return "ready to accept";
  const left = `${unresolvedCount.value} decision${unresolvedCount.value === 1 ? "" : "s"} left`;
  return decidedCount.value > 0 ? `${decidedCount.value} decided · ${left}` : left;
});

/**
 * Highlighted HTML per on-disk line number. In review mode the whole working
 * file is highlighted once (region lines are rendered inside their blocks and
 * simply unused); in fallback mode only plain segments are highlighted.
 */
const renderedByNo = computed<Map<number, string>>(() => {
  const map = new Map<number, string>();
  if (review.value !== null) {
    const html = highlightLines(working.value.replace(/\n$/, ""), props.lang);
    for (let i = 0; i < html.length; i += 1) map.set(i + 1, html[i]!);
    return map;
  }
  const plainText = segments.value.map((segment) => (segment.type === "text" ? segment.text : "")).join("");
  const html = highlightLines(plainText.replace(/\n$/, ""), props.lang);
  // resultRows numbers plain lines by their on-disk position; rebuild the same
  // numbering here to pair each plain line with its highlighted HTML.
  let htmlIndex = 0;
  let lineNo = 1;
  for (const segment of segments.value) {
    if (segment.type === "conflict") {
      lineNo += 3 + count(segment.local) + count(segment.upstream);
      lineNo += segment.base === "" ? 1 : 1 + count(segment.base);
      continue;
    }
    const n = count(segment.text);
    for (let i = 0; i < n; i += 1) {
      map.set(lineNo + i, html[htmlIndex] ?? "");
      htmlIndex += 1;
    }
    lineNo += n;
  }
  return map;
});

function count(text: string): number {
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.length;
}

function asConflictRegion(region: UiReviewRegion): ConflictRegion {
  return {
    index: region.index,
    local: region.local,
    base: region.base,
    upstream: region.upstream,
    lineStart: region.line,
  };
}

/**
 * `/api/region` addresses conflicts by their ordinal among the markers still
 * on disk; review regions are numbered across all decisions. Map one to the
 * other by counting the open regions that precede this one.
 */
function markerOrdinal(region: UiReviewRegion): number {
  if (review.value === null) return region.index;
  return review.value.filter(
    (candidate) => candidate.status === "unresolved" && candidate.start < region.start,
  ).length;
}

function expandFold(id: number): void {
  const next = new Set(expanded.value);
  next.add(id);
  expanded.value = next;
}

function scrollToConflict(index: number): void {
  requestAnimationFrame(() => {
    container.value?.querySelector(`[data-conflict="${index}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" });
  });
}

defineExpose({ scrollToConflict });
</script>

<template>
  <section class="flex min-w-0 flex-col overflow-hidden">
    <header class="flex h-9 shrink-0 items-center gap-2 overflow-hidden border-b border-line-soft bg-panel px-3.5 whitespace-nowrap">
      <span class="size-1.5 shrink-0 rounded-full" :class="unresolvedCount > 0 ? 'bg-warn' : 'bg-accent'" />
      <span class="truncate text-[11.5px] font-semibold tracking-[0.08em] text-fg-mid uppercase">Proposed result</span>
      <span class="ml-auto shrink-0 text-[10.5px]" :class="unresolvedCount > 0 ? 'text-warn-soft' : 'text-accent'">
        {{ statusText }}
      </span>
    </header>

    <div ref="container" class="code-grid min-h-0 flex-1 overflow-auto bg-code py-2">
      <template v-for="(row, i) in rows" :key="i">
        <button v-if="row.kind === 'fold'" type="button" class="fold-bar" @click="expandFold(row.id)">
          <svg width="10" height="10" viewBox="0 0 16 16" fill="none" class="opacity-70">
            <path d="M4 6l4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
          {{ row.count }} unchanged lines
        </button>
        <ConflictBlock
          v-else-if="row.kind === 'conflict'"
          :region="row.region"
          :total="totalRegions"
          :lang="lang"
          :busy="busy"
          @choose="(choice, text) => emit('region', row.region.index, choice, text)"
        />
        <template v-else-if="row.kind === 'region'">
          <ConflictBlock
            v-if="row.region.status === 'unresolved'"
            :region="asConflictRegion(row.region)"
            :total="totalRegions"
            :lang="lang"
            :busy="busy"
            @choose="(choice, text) => emit('region', markerOrdinal(row.region), choice, text)"
          />
          <ReviewBlock
            v-else
            :region="row.region"
            :total="totalRegions"
            :lang="lang"
            :busy="busy"
            @reopen="emit('reopen', row.region.index)"
          />
        </template>
        <div v-else class="code-line" :data-ln="row.line.no">
          <span class="ln">{{ row.line.no }}</span>
          <span class="lc" v-html="renderedByNo.get(row.line.no) ?? ''" />
        </div>
      </template>
    </div>
  </section>
</template>
