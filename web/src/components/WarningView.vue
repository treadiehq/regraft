<script setup lang="ts">
import { computed } from "vue";
import { languageForPath } from "../lib/highlight";
import type { FileAction, UiFile } from "../lib/types";
import CodePane from "./CodePane.vue";

const props = defineProps<{
  file: UiFile;
  busy: boolean;
}>();

const emit = defineEmits<{ action: [action: FileAction] }>();

const pending = computed(() => props.file.pending!);
const lang = computed(() => languageForPath(props.file.path));

interface ActionSpec {
  action: FileAction;
  label: string;
  consequence: string;
  primary: boolean;
}

const actions = computed<ActionSpec[]>(() => {
  switch (pending.value.kind) {
    case "binary-conflict":
      return [
        { action: "keep-local", label: "Keep your file", consequence: "Your binary stays; this upstream change is skipped.", primary: true },
        { action: "use-upstream", label: "Take upstream", consequence: "Your local binary is replaced with the upstream one.", primary: false },
      ];
    case "upstream-deleted":
      return [
        { action: "keep-local", label: "Keep your file", consequence: "The file stays in your repo as fully yours; upstream stops shipping it.", primary: true },
        { action: "delete", label: "Delete it too", consequence: "Follows upstream — the file is removed from your repo.", primary: false },
      ];
    case "local-deleted":
      return [
        { action: "keep-deleted", label: "Keep it deleted", consequence: "Your intentional deletion stands; upstream changes to it are ignored.", primary: true },
        { action: "restore-upstream", label: "Restore upstream version", consequence: "The new upstream file is written back into your repo.", primary: false },
      ];
    case "destination-collision":
      return [
        { action: "keep-local", label: "Keep your file", consequence: "Your file stays; the colliding upstream file is skipped.", primary: true },
        { action: "use-upstream", label: "Use upstream file", consequence: "Your file is replaced with the new upstream one.", primary: false },
      ];
    case "ownership-unknown":
      return [
        { action: "keep-local", label: "Keep local state", consequence: "Whatever is on disk right now is kept and tracked.", primary: true },
        { action: "use-upstream", label: "Use upstream file", consequence: "The upstream version is written and tracked as unmodified.", primary: false },
      ];
    default:
      return [];
  }
});

const showUpstreamPane = computed(
  () => !pending.value.binary && pending.value.upstream !== null,
);
const showLocalPane = computed(() => !pending.value.binary && pending.value.local !== null);
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <div class="mx-auto w-full max-w-3xl px-6 pt-8">
      <div class="card rise-in p-5">
        <div class="flex items-start gap-3">
          <span class="mt-1 flex size-8 shrink-0 items-center justify-center rounded-lg" style="background: color-mix(in srgb, var(--color-local) 14%, transparent)">
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none" class="text-local">
              <path d="M8 5.5v3.5M8 11.5v.01" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
              <path d="M8 1.5l6.5 11.5H1.5L8 1.5z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" />
            </svg>
          </span>
          <div>
            <h2 class="text-[15px] font-semibold">{{ pending.headline }}</h2>
            <p class="mt-1 text-[12.5px] leading-relaxed text-fg-mid">{{ pending.detail }}</p>
            <p class="mt-2 font-mono text-[11px] text-fg-dim">{{ file.path }}</p>
          </div>
        </div>

        <div class="mt-5 grid gap-2.5 sm:grid-cols-2">
          <button
            v-for="spec in actions"
            :key="spec.action"
            type="button"
            class="rounded-xl border p-3.5 text-left transition-colors"
            :class="spec.primary ? 'border-accent/40 hover:bg-accent/5' : 'border-line hover:bg-raise'"
            :disabled="busy"
            @click="emit('action', spec.action)"
          >
            <p class="text-[13px] font-semibold" :class="spec.primary ? 'text-accent' : 'text-fg'">{{ spec.label }}</p>
            <p class="mt-1 text-[11.5px] leading-relaxed text-fg-mid">{{ spec.consequence }}</p>
          </button>
        </div>
      </div>
    </div>

    <div v-if="showUpstreamPane || showLocalPane" class="mt-6 grid min-h-0 flex-1 border-t border-line" :class="showUpstreamPane && showLocalPane ? 'grid-cols-2 divide-x divide-line' : 'grid-cols-1'">
      <CodePane
        v-if="showUpstreamPane"
        title="Upstream version"
        :meta="pending.toSha.slice(0, 7)"
        tone="upstream"
        :text="pending.upstream"
        :base="pending.base"
        :lang="lang"
      />
      <CodePane
        v-if="showLocalPane"
        title="Your version"
        :meta="pending.localExact ? 'exact' : 'best effort'"
        tone="local"
        :text="pending.local"
        :base="pending.base"
        :lang="lang"
      />
    </div>
    <div v-else-if="pending.binary" class="mt-6 flex flex-1 items-center justify-center text-[12.5px] text-fg-dim">
      Binary content — no preview available.
    </div>
  </div>
</template>
