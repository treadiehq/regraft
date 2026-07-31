<script setup lang="ts">
import { computed } from "vue";
import type { UiFile, UiGraft, UiState } from "../lib/types";

const props = defineProps<{
  state: UiState;
  graft: UiGraft | null;
  file: UiFile | null;
  busy: boolean;
}>();

const emit = defineEmits<{ refresh: [] }>();

const pending = computed(() => props.file?.pending ?? null);

function short(sha: string | null): string {
  return sha ? sha.slice(0, 7) : "———————";
}
</script>

<template>
  <header class="flex h-13 items-center gap-4 border-b border-line bg-panel px-4">
    <div class="flex items-center gap-2.5">
      <img src="../assets/logo.png" alt="regraft" class="size-5" />
      <span class="text-[14px] font-semibold tracking-tight">regraft</span>
      <span class="chip border-line-soft text-fg-mid">{{ state.project.name }}</span>
    </div>

    <div v-if="file && graft" class="mx-auto hidden items-center gap-0 lg:flex">
      <div class="flex items-center gap-2">
        <span class="size-2 rounded-full border border-fg-dim" />
        <div class="leading-tight">
          <p class="text-[11px] text-fg-mid">Upstream <span class="text-fg-dim">· {{ graft.remoteRef }}</span></p>
          <p class="font-mono text-[10px] text-fg-dim">{{ short(pending?.fromSha ?? graft.pinnedSha) }} → {{ short(pending?.toSha ?? null) }}</p>
        </div>
      </div>
      <div class="mx-3 h-px w-10" style="background: linear-gradient(90deg, #3f3f46, #34d399)" />
      <div class="flex items-center gap-2">
        <span class="size-2 rounded-full border border-local bg-local/20" />
        <div class="leading-tight">
          <p class="text-[11px] text-fg-mid">Your version</p>
          <p class="font-mono text-[10px] text-fg-dim">{{ pending?.localExact ? "recovered exactly" : "reconstructed" }}</p>
        </div>
      </div>
      <div class="mx-3 h-px w-10" style="background: linear-gradient(90deg, #a78bfa66, #34d399)" />
      <div class="flex items-center gap-2">
        <span
          class="size-2 rounded-full"
          :class="(pending?.conflictsRemaining ?? 0) > 0 ? 'border border-warn bg-warn/20' : 'bg-accent'"
        />
        <div class="leading-tight">
          <p class="text-[11px] text-fg-mid">Proposed result</p>
          <p class="font-mono text-[10px] text-fg-dim">
            {{ (pending?.conflictsRemaining ?? 0) > 0 ? `${pending?.conflictsRemaining} open` : "complete" }}
          </p>
        </div>
      </div>
    </div>

    <div class="ml-auto flex items-center gap-2">
      <span v-if="state.summary.conflicts > 0" class="chip text-warn-soft" style="border-color: color-mix(in srgb, var(--color-warn) 30%, transparent)">
        {{ state.summary.conflicts }} conflict{{ state.summary.conflicts === 1 ? "" : "s" }}
      </span>
      <span v-if="state.summary.warnings > 0" class="chip text-local" style="border-color: color-mix(in srgb, var(--color-local) 30%, transparent)">
        {{ state.summary.warnings }} to review
      </span>
      <span v-if="state.summary.conflicts === 0 && state.summary.warnings === 0" class="chip text-accent" style="border-color: color-mix(in srgb, var(--color-accent) 30%, transparent)">
        all decided
      </span>
      <button type="button" class="btn btn-ghost !px-2" title="Refresh from disk" :disabled="busy" @click="emit('refresh')">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" :class="busy ? 'animate-spin' : ''">
          <path d="M13.5 8a5.5 5.5 0 11-1.6-3.9M13.5 1.5v3h-3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </button>
    </div>
  </header>
</template>
