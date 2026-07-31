<script setup lang="ts">
import { computed, ref } from "vue";
import type { FileStatus, UiGraft } from "../lib/types";

const props = defineProps<{
  grafts: UiGraft[];
  selectedPath: string | null;
}>();

const emit = defineEmits<{ select: [path: string] }>();

const showSettled = ref<Set<string>>(new Set());

function toggleSettled(graftId: string): void {
  const next = new Set(showSettled.value);
  if (next.has(graftId)) next.delete(graftId);
  else next.add(graftId);
  showSettled.value = next;
}

const groups = computed(() =>
  props.grafts.map((graft) => {
    const pending = graft.files.filter((file) => file.pending !== null);
    const settled = graft.files.filter((file) => file.pending === null);
    return { graft, pending, settled };
  }),
);

function shortSource(url: string): string {
  return url.replace(/^https?:\/\//, "").replace(/\.git$/, "").replace(/^git@([^:]+):/, "$1/");
}

function dotClass(status: FileStatus): string {
  switch (status) {
    case "conflict-unresolved":
      return "bg-warn";
    case "reconciliation-pending":
      return "bg-local";
    case "missing":
      return "bg-danger";
    case "modified-unrecorded":
      return "border border-warn bg-transparent";
    default:
      return "bg-accent/70";
  }
}

function fileName(path: string): string {
  return path.split("/").pop() ?? path;
}

function dirName(path: string): string {
  const parts = path.split("/");
  parts.pop();
  return parts.join("/");
}
</script>

<template>
  <aside class="flex min-h-0 flex-col overflow-y-auto border-r border-line bg-panel">
    <div v-for="group in groups" :key="group.graft.id" class="border-b border-line-soft py-3">
      <div class="px-4 pb-2">
        <p class="text-[12.5px] font-semibold text-fg">{{ group.graft.name }}</p>
        <p class="mt-0.5 truncate font-mono text-[10.5px] text-fg-dim" :title="group.graft.url">
          {{ shortSource(group.graft.url) }}
        </p>
      </div>

      <button
        v-for="file in group.pending"
        :key="file.path"
        type="button"
        class="group flex w-full items-center gap-2.5 px-4 py-[7px] text-left transition-colors"
        :class="file.path === selectedPath ? 'bg-raise' : 'hover:bg-raise/60'"
        @click="emit('select', file.path)"
      >
        <span class="size-2 shrink-0 rounded-full" :class="dotClass(file.status)" />
        <span class="min-w-0">
          <span class="block truncate text-[12.5px]" :class="file.path === selectedPath ? 'text-fg' : 'text-fg-mid group-hover:text-fg'">
            {{ fileName(file.path) }}
          </span>
          <span class="block truncate text-[10.5px] text-fg-dim">{{ dirName(file.path) }}</span>
        </span>
        <span
          v-if="file.pending && file.pending.conflictsRemaining > 0"
          class="ml-auto shrink-0 rounded-full px-1.5 font-mono text-[10px] text-warn-soft"
          style="background: color-mix(in srgb, var(--color-warn) 12%, transparent)"
        >
          {{ file.pending.conflictsRemaining }}
        </span>
      </button>

      <p v-if="group.pending.length === 0" class="px-4 py-1 text-[11.5px] text-fg-dim italic">Nothing pending.</p>

      <button
        v-if="group.settled.length > 0"
        type="button"
        class="mt-1 flex w-full items-center gap-1.5 px-4 py-1 text-[11px] text-fg-dim transition-colors hover:text-fg-mid"
        @click="toggleSettled(group.graft.id)"
      >
        <svg
          width="9"
          height="9"
          viewBox="0 0 16 16"
          fill="none"
          class="transition-transform"
          :class="showSettled.has(group.graft.id) ? 'rotate-90' : ''"
        >
          <path d="M6 4l4 4-4 4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
        <svg width="10" height="10" viewBox="0 0 16 16" fill="none" class="text-accent">
          <path d="M3 8.5l3.5 3.5L13 5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
        {{ group.settled.length }} file{{ group.settled.length === 1 ? "" : "s" }} without pending work
      </button>
      <template v-if="showSettled.has(group.graft.id)">
        <div v-for="file in group.settled" :key="file.path" class="flex items-center gap-2.5 px-4 py-[5px]">
          <span class="size-1.5 shrink-0 rounded-full" :class="dotClass(file.status)" />
          <span class="truncate text-[11.5px] text-fg-dim">{{ file.path }}</span>
          <span v-if="file.status === 'modified-unrecorded'" class="ml-auto text-[9.5px] tracking-wide text-warn-soft/80 uppercase">no note</span>
        </div>
      </template>
    </div>
  </aside>
</template>
