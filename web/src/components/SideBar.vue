<script setup lang="ts">
import { computed } from "vue";
import type { RegionStatus, UiFile, UiGraft } from "../lib/types";

const props = defineProps<{
  graft: UiGraft;
  file: UiFile;
}>();

const emit = defineEmits<{ jump: [index: number] }>();

const pending = computed(() => props.file.pending);

interface DecisionItem {
  index: number;
  status: RegionStatus;
}

/** All decision regions when the review model is available, else open markers. */
const decisions = computed<DecisionItem[]>(() => {
  const review = pending.value?.review;
  if (review != null) return review.map((region) => ({ index: region.index, status: region.status }));
  return (pending.value?.segments ?? [])
    .filter((segment) => segment.type === "conflict")
    .map((segment) => ({ index: (segment as { index: number }).index, status: "unresolved" as RegionStatus }));
});

const DECISION_META: Record<RegionStatus, { label: string; color: string }> = {
  unresolved: { label: "open", color: "var(--color-warn)" },
  upstream: { label: "took upstream", color: "var(--color-accent)" },
  local: { label: "kept yours", color: "var(--color-local)" },
  base: { label: "reverted", color: "var(--color-fg-dim)" },
  custom: { label: "custom", color: "var(--color-info)" },
};

function formatDate(iso: string): string {
  return iso.slice(0, 10);
}
</script>

<template>
  <aside class="flex min-h-0 flex-col gap-3 overflow-y-auto border-l border-line bg-panel p-3.5">
    <div v-if="pending" class="card p-3.5">
      <p class="text-[12.5px] leading-snug font-semibold">{{ pending.headline }}</p>
      <p class="mt-1.5 text-[11.5px] leading-relaxed text-fg-mid">{{ pending.detail }}</p>
    </div>

    <div class="card p-3.5">
      <p class="flex items-center gap-1.5 text-[10.5px] font-semibold tracking-[0.1em] text-fg-dim uppercase">
        <span class="size-1.5 rounded-full bg-local" />
        Why you changed this
      </p>
      <template v-if="file.intents.length > 0">
        <div
          v-for="intent in file.intents"
          :key="intent.id"
          class="mt-2.5 border-l-2 pl-2.5"
          style="border-color: color-mix(in srgb, var(--color-local) 45%, transparent)"
        >
          <p class="text-[12px] leading-relaxed text-fg">{{ intent.description }}</p>
          <p class="mt-1 font-mono text-[10px] text-fg-dim">{{ formatDate(intent.date) }} · {{ intent.id }}</p>
        </div>
      </template>
      <p v-else class="mt-2 text-[11.5px] leading-relaxed text-fg-dim italic">
        No note was recorded for this file. Decide from the code, then record why with your resolution.
      </p>
    </div>

    <div v-if="pending && pending.upstreamCommits.length > 0" class="card p-3.5">
      <p class="flex items-center gap-1.5 text-[10.5px] font-semibold tracking-[0.1em] text-fg-dim uppercase">
        <span class="size-1.5 rounded-full bg-accent" />
        What upstream did
      </p>
      <div v-for="commit in pending.upstreamCommits.slice(0, 8)" :key="commit.sha" class="mt-2 flex gap-2">
        <span class="shrink-0 font-mono text-[10.5px] text-accent/80">{{ commit.sha }}</span>
        <span class="truncate text-[11.5px] text-fg-mid" :title="commit.subject">{{ commit.subject }}</span>
      </div>
      <p v-if="pending.upstreamCommits.length > 8" class="mt-1.5 text-[10.5px] text-fg-dim">
        +{{ pending.upstreamCommits.length - 8 }} more commits
      </p>
    </div>

    <div v-if="decisions.length > 0" class="card p-3.5">
      <p class="text-[10.5px] font-semibold tracking-[0.1em] text-fg-dim uppercase">Decisions</p>
      <button
        v-for="decision in decisions"
        :key="decision.index"
        type="button"
        class="mt-1.5 flex w-full items-center gap-2 rounded-lg border border-line-soft px-2.5 py-1.5 text-left transition-colors hover:bg-raise"
        @click="emit('jump', decision.index)"
      >
        <span class="size-1.5 shrink-0 rounded-full" :style="{ background: DECISION_META[decision.status].color }" />
        <span class="truncate text-[11.5px] text-fg-mid">
          Region {{ decision.index + 1 }}
          <span class="text-fg-dim">— {{ DECISION_META[decision.status].label }}</span>
        </span>
        <svg width="10" height="10" viewBox="0 0 16 16" fill="none" class="ml-auto shrink-0 text-fg-dim">
          <path d="M6 4l4 4-4 4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </button>
    </div>

    <div class="card p-3.5">
      <p class="text-[10.5px] font-semibold tracking-[0.1em] text-fg-dim uppercase">Provenance</p>
      <dl class="mt-2 space-y-1.5 text-[11px]">
        <div class="flex justify-between gap-2">
          <dt class="text-fg-dim">Source</dt>
          <dd class="truncate font-mono text-[10.5px] text-fg-mid" :title="graft.url">{{ graft.url.replace(/^https?:\/\//, "") }}</dd>
        </div>
        <div class="flex justify-between gap-2">
          <dt class="text-fg-dim">Ref</dt>
          <dd class="font-mono text-[10.5px] text-fg-mid">{{ graft.remoteRef }}</dd>
        </div>
        <div v-if="pending" class="flex justify-between gap-2">
          <dt class="text-fg-dim">Update</dt>
          <dd class="font-mono text-[10.5px] text-fg-mid">
            {{ pending.fromSha?.slice(0, 7) ?? "?" }} → {{ pending.toSha.slice(0, 7) }}
          </dd>
        </div>
        <div v-if="pending?.brief" class="flex justify-between gap-2">
          <dt class="text-fg-dim">Brief</dt>
          <dd class="truncate font-mono text-[10.5px] text-fg-mid" :title="pending.brief">{{ pending.brief }}</dd>
        </div>
      </dl>
    </div>
  </aside>
</template>
