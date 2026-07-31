<script setup lang="ts">
import { ref } from "vue";

defineProps<{
  path: string;
  busy: boolean;
}>();

const emit = defineEmits<{ submit: [note: string | null]; close: [] }>();

const note = ref("");
</script>

<template>
  <Teleport to="body">
    <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6 backdrop-blur-[2px]" @click.self="emit('close')">
      <div class="rise-in card w-full max-w-lg border-line bg-panel p-5 shadow-2xl">
        <h3 class="text-[15px] font-semibold">Accept the result</h3>
        <p class="mt-1 text-[12.5px] leading-relaxed text-fg-mid">
          One sentence on how you reconciled
          <span class="font-mono text-[11.5px] text-fg">{{ path.split("/").pop() }}</span>
          keeps future updates decidable — the next conflict arrives with your reasons attached.
        </p>
        <textarea
          v-model="note"
          class="mt-3.5 h-24 w-full resize-none rounded-lg border border-line bg-code px-3 py-2.5 text-[13px] leading-relaxed outline-none placeholder:text-fg-dim focus:border-accent/50"
          placeholder="e.g. Re-applied our Redis-backed session store on top of upstream's new event API"
          autofocus
          @keydown.meta.enter="note.trim() && emit('submit', note.trim())"
        />
        <div class="mt-4 flex items-center justify-between">
          <button type="button" class="btn btn-ghost" :disabled="busy" @click="emit('close')">Cancel</button>
          <div class="flex gap-2">
            <button type="button" class="btn" :disabled="busy" @click="emit('submit', null)">Accept without note</button>
            <button type="button" class="btn btn-primary" :disabled="busy || note.trim() === ''" @click="emit('submit', note.trim())">
              Accept with note
            </button>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>
