<script setup lang="ts">
import { computed, ref } from "vue";
import { api } from "../lib/api";
import { toast } from "../lib/toast";
import type { StatusResult, UiState } from "../lib/types";

const props = defineProps<{
  state: UiState;
}>();

const emit = defineEmits<{ refresh: [] }>();

const checking = ref(false);
const pulling = ref(false);
const checked = ref<StatusResult | null>(null);
const noteText = ref("");
const savingNote = ref(false);

const staleness = computed(() => new Map((checked.value?.sources ?? []).map((source) => [source.id, source.stale])));
const anyStale = computed(() => (checked.value?.sources ?? []).some((source) => source.stale === true));

const needsNoteFiles = computed(() =>
  props.state.grafts.flatMap((graft) =>
    graft.files.filter((file) => file.status === "modified-unrecorded").map((file) => file.path),
  ),
);

function shortSource(url: string, path: string): string {
  const base = url.replace(/^https?:\/\//, "").replace(/\.git$/, "").replace(/^git@([^:]+):/, "$1/");
  return path ? `${base}/${path}` : base;
}

async function check(): Promise<void> {
  checking.value = true;
  try {
    checked.value = await api.check();
    if (!checked.value.stale) toast("ok", "Every graft is at its upstream head.");
  } catch (error) {
    toast("error", error instanceof Error ? error.message : String(error));
  } finally {
    checking.value = false;
  }
}

async function pull(): Promise<void> {
  pulling.value = true;
  try {
    const result = await api.pull();
    const updated = result.sources.reduce(
      (n, s) => n + s.added.length + s.fastForwarded.length + s.merged.length,
      0,
    );
    const conflicts = result.sources.reduce((n, s) => n + s.conflicts.length, 0);
    const warnings = result.sources.reduce((n, s) => n + s.warnings.length, 0);
    if (conflicts + warnings > 0) {
      toast("warn", `${updated} files merged cleanly · ${conflicts + warnings} need your judgment.`);
    } else if (updated > 0) {
      toast("ok", `${updated} file${updated === 1 ? "" : "s"} updated cleanly. Nothing needs review.`);
    } else {
      toast("ok", "Already up to date.");
    }
    checked.value = null;
    emit("refresh");
  } catch (error) {
    toast("error", error instanceof Error ? error.message : String(error));
  } finally {
    pulling.value = false;
  }
}

async function saveNote(): Promise<void> {
  savingNote.value = true;
  try {
    await api.note(noteText.value.trim(), needsNoteFiles.value);
    toast("ok", "Intent recorded — PATCH.md updated.");
    noteText.value = "";
    emit("refresh");
  } catch (error) {
    toast("error", error instanceof Error ? error.message : String(error));
  } finally {
    savingNote.value = false;
  }
}
</script>

<template>
  <div class="flex min-h-0 flex-1 items-start justify-center overflow-y-auto">
    <div class="w-full max-w-2xl px-6 py-14">
      <div class="rise-in text-center">
        <div
          class="mx-auto flex size-14 items-center justify-center rounded-2xl"
          style="background: color-mix(in srgb, var(--color-accent) 12%, transparent)"
        >
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none">
            <path d="M5 12.5l4.5 4.5L19 7.5" stroke="#34d399" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </div>
        <h1 class="mt-4 text-[19px] font-semibold tracking-tight">Nothing needs your judgment</h1>
        <p class="mx-auto mt-1.5 max-w-md text-[13px] leading-relaxed text-fg-mid">
          {{ state.summary.tracked }} tracked file{{ state.summary.tracked === 1 ? "" : "s" }} across
          {{ state.summary.grafts }} graft{{ state.summary.grafts === 1 ? "" : "s" }} — every update decision has been made.
        </p>
      </div>

      <div v-if="needsNoteFiles.length > 0" class="card rise-in mt-8 p-4">
        <p class="text-[12.5px] font-semibold text-warn-soft">
          {{ needsNoteFiles.length }} adapted file{{ needsNoteFiles.length === 1 ? " has" : "s have" }} no recorded intent
        </p>
        <p class="mt-1 text-[11.5px] leading-relaxed text-fg-mid">
          When these conflict someday, the review will arrive without your reasons. One sentence now saves that future you.
        </p>
        <div class="mt-2.5 flex flex-wrap gap-1.5">
          <span v-for="path in needsNoteFiles" :key="path" class="chip border-line-soft font-mono text-[10px] text-fg-mid">{{ path }}</span>
        </div>
        <div class="mt-3 flex gap-2">
          <input
            v-model="noteText"
            type="text"
            class="min-w-0 flex-1 rounded-lg border border-line bg-code px-3 py-2 text-[12.5px] outline-none placeholder:text-fg-dim focus:border-accent/50"
            placeholder="What changed, and why?"
            @keydown.enter="noteText.trim() && saveNote()"
          />
          <button type="button" class="btn btn-primary" :disabled="savingNote || noteText.trim() === ''" @click="saveNote">
            Record intent
          </button>
        </div>
      </div>

      <div class="card rise-in mt-6 overflow-hidden">
        <div class="flex items-center justify-between px-4 py-3">
          <p class="text-[12.5px] font-semibold">Grafts</p>
          <div class="flex gap-2">
            <button type="button" class="btn" :disabled="checking" @click="check">
              <span v-if="checking" class="pulse-soft">Checking…</span>
              <span v-else>Check for updates</span>
            </button>
            <button v-if="anyStale" type="button" class="btn btn-primary" :disabled="pulling" @click="pull">
              <span v-if="pulling" class="pulse-soft">Pulling…</span>
              <span v-else>Pull updates</span>
            </button>
          </div>
        </div>
        <table class="w-full border-t border-line-soft text-left">
          <tbody>
            <tr v-for="graft in state.grafts" :key="graft.id" class="border-b border-line-soft last:border-0">
              <td class="px-4 py-2.5">
                <p class="text-[12.5px] font-medium">{{ graft.name }}</p>
                <p class="mt-0.5 font-mono text-[10.5px] text-fg-dim">{{ shortSource(graft.url, graft.sourcePath) }}</p>
              </td>
              <td class="px-4 py-2.5 text-right">
                <p class="font-mono text-[10.5px] text-fg-dim">pinned {{ graft.pinnedSha.slice(0, 7) }}</p>
              </td>
              <td class="w-36 px-4 py-2.5 text-right">
                <span v-if="staleness.get(graft.id) === true" class="chip text-warn-soft" style="border-color: color-mix(in srgb, var(--color-warn) 30%, transparent)">
                  update available
                </span>
                <span v-else-if="staleness.get(graft.id) === false" class="chip text-accent" style="border-color: color-mix(in srgb, var(--color-accent) 30%, transparent)">
                  up to date
                </span>
                <span v-else class="chip border-line-soft text-fg-dim">not checked</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <p class="mt-6 text-center text-[11px] text-fg-dim">
        Local only — this page talks to <span class="font-mono">regraft</span> on 127.0.0.1 and never leaves your machine.
      </p>
    </div>
  </div>
</template>
