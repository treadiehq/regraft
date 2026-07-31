<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import EmptyState from "./components/EmptyState.vue";
import CodePane from "./components/CodePane.vue";
import FileRail from "./components/FileRail.vue";
import NoteModal from "./components/NoteModal.vue";
import ResultPane from "./components/ResultPane.vue";
import SideBar from "./components/SideBar.vue";
import TopBar from "./components/TopBar.vue";
import UiToasts from "./components/UiToasts.vue";
import WarningView from "./components/WarningView.vue";
import { api } from "./lib/api";
import { buildAgentContext } from "./lib/agent";
import { languageForPath } from "./lib/highlight";
import { locateSlice } from "./lib/rows";
import { toast } from "./lib/toast";
import type { ConflictChoice, FileAction, UiFile, UiGraft, UiState } from "./lib/types";

const state = ref<UiState | null>(null);
const loadError = ref<string | null>(null);
const selectedPath = ref<string | null>(null);
const busy = ref(false);
const noteModalOpen = ref(false);
const fileMenuOpen = ref(false);
const undoStack = ref<Map<string, string[]>>(new Map());

// On narrower windows start with the result pane only; both side panes
// can be toggled back on at any width.
const wide = window.innerWidth >= 1360;
const medium = window.innerWidth >= 1000;
const showUpstream = ref(wide);
const showLocal = ref(medium);

const upstreamPane = ref<InstanceType<typeof CodePane> | null>(null);
const localPane = ref<InstanceType<typeof CodePane> | null>(null);
const resultPane = ref<InstanceType<typeof ResultPane> | null>(null);

const pendingFiles = computed<{ graft: UiGraft; file: UiFile }[]>(() => {
  if (!state.value) return [];
  const entries = state.value.grafts.flatMap((graft) =>
    graft.files.filter((file) => file.pending !== null).map((file) => ({ graft, file })),
  );
  const rank = (file: UiFile): number => (file.status === "conflict-unresolved" ? 0 : 1);
  return entries.sort((a, b) => rank(a.file) - rank(b.file) || a.file.path.localeCompare(b.file.path));
});

const selected = computed(() => pendingFiles.value.find((entry) => entry.file.path === selectedPath.value) ?? null);
const lang = computed(() => (selected.value ? languageForPath(selected.value.file.path) : null));
const isContentConflict = computed(() => {
  const kind = selected.value?.file.pending?.kind;
  return kind === "content-conflict" || kind === "legacy-conflict";
});
const conflictsRemaining = computed(() => selected.value?.file.pending?.conflictsRemaining ?? 0);
const canUndo = computed(() => (undoStack.value.get(selectedPath.value ?? "")?.length ?? 0) > 0);
const paneGridClass = computed(() => {
  const visible = 1 + (showUpstream.value ? 1 : 0) + (showLocal.value ? 1 : 0);
  return visible === 3 ? "grid-cols-3" : visible === 2 ? "grid-cols-2" : "grid-cols-1";
});

async function refresh(preserveSelection = true): Promise<void> {
  try {
    const next = await api.state();
    state.value = next;
    loadError.value = null;
    const stillPending = pendingFiles.value.some((entry) => entry.file.path === selectedPath.value);
    if (!preserveSelection || !stillPending) {
      selectedPath.value = pendingFiles.value[0]?.file.path ?? null;
    }
  } catch (error) {
    loadError.value = error instanceof Error ? error.message : String(error);
  }
}

onMounted(() => {
  void refresh(false);
  // The editor and agent flows happen outside this page; catching up on
  // window focus makes the round-trip seamless.
  window.addEventListener("focus", () => {
    if (!busy.value && state.value !== null && !noteModalOpen.value) void refresh();
  });
});

async function applyRegion(index: number, choice: ConflictChoice, text?: string): Promise<void> {
  const entry = selected.value;
  if (!entry) return;
  busy.value = true;
  try {
    const before = entry.file.pending?.working;
    await api.region(entry.file.path, index, choice, text);
    if (before != null) {
      const stack = undoStack.value.get(entry.file.path) ?? [];
      undoStack.value.set(entry.file.path, [...stack, before]);
    }
    await refresh();
  } catch (error) {
    toast("error", error instanceof Error ? error.message : String(error));
  } finally {
    busy.value = false;
  }
}

async function reopenRegion(index: number): Promise<void> {
  const entry = selected.value;
  if (!entry) return;
  busy.value = true;
  try {
    const before = entry.file.pending?.working;
    await api.reopen(entry.file.path, index);
    if (before != null) {
      const stack = undoStack.value.get(entry.file.path) ?? [];
      undoStack.value.set(entry.file.path, [...stack, before]);
    }
    await refresh();
  } catch (error) {
    toast("error", error instanceof Error ? error.message : String(error));
  } finally {
    busy.value = false;
  }
}

async function openEditor(): Promise<void> {
  const entry = selected.value;
  if (!entry) return;
  const pending = entry.file.pending;
  let line = pending?.review?.find((region) => region.status === "unresolved")?.line;
  if (line === undefined && pending?.working != null) {
    const markerLine = pending.working.split("\n").findIndex((text) => text.startsWith("<<<<<<<"));
    if (markerLine !== -1) line = markerLine + 1;
  }
  try {
    const result = await api.openEditor(entry.file.path, line);
    toast("ok", `Opened in ${result.editor}. Your edits show up here when you come back.`);
  } catch (error) {
    toast("error", error instanceof Error ? error.message : String(error));
  }
}

async function undo(): Promise<void> {
  const path = selectedPath.value;
  if (path === null) return;
  const stack = undoStack.value.get(path) ?? [];
  const previous = stack[stack.length - 1];
  if (previous === undefined) return;
  busy.value = true;
  try {
    await api.restore(path, previous);
    undoStack.value.set(path, stack.slice(0, -1));
    await refresh();
  } catch (error) {
    toast("error", error instanceof Error ? error.message : String(error));
  } finally {
    busy.value = false;
  }
}

async function fileAction(action: FileAction): Promise<void> {
  const entry = selected.value;
  if (!entry) return;
  busy.value = true;
  try {
    const result = await api.fileAction(entry.file.path, action);
    if (action === "reset") {
      undoStack.value.set(entry.file.path, []);
      toast("ok", "File restored to the original merge state.");
    } else if (result.resolve && result.resolve.needsNote.length > 0) {
      toast("warn", "Decided. Add a note when you can — the empty state has a shortcut.");
    } else {
      toast("ok", `Decided: ${entry.file.path.split("/").pop()}`);
    }
    await refresh();
  } catch (error) {
    toast("error", error instanceof Error ? error.message : String(error));
  } finally {
    busy.value = false;
  }
}

async function acceptResult(note: string | null): Promise<void> {
  const entry = selected.value;
  if (!entry) return;
  busy.value = true;
  try {
    const result = await api.resolve([entry.file.path], note ?? undefined);
    if (result.markersRemain.length > 0) {
      toast("error", "Conflict markers are still present in the file on disk.");
    } else if (result.needsNote.length > 0) {
      toast("warn", "Accepted. regraft still wants a note — the empty state has a shortcut.");
    } else {
      toast("ok", `Accepted: ${entry.file.path.split("/").pop()}`);
    }
    noteModalOpen.value = false;
    undoStack.value.set(entry.file.path, []);
    await refresh();
  } catch (error) {
    toast("error", error instanceof Error ? error.message : String(error));
  } finally {
    busy.value = false;
  }
}

function jumpToConflict(index: number): void {
  const entry = selected.value;
  const pending = entry?.file.pending;
  if (!entry || !pending) return;
  resultPane.value?.scrollToConflict(index);
  let slices: { local: string; upstream: string } | null = null;
  const reviewRegion = pending.review?.find((region) => region.index === index);
  if (reviewRegion) {
    slices = { local: reviewRegion.local, upstream: reviewRegion.upstream };
  } else {
    const segment = pending.segments?.find((candidate) => candidate.type === "conflict" && candidate.index === index);
    if (segment && segment.type === "conflict") slices = { local: segment.local, upstream: segment.upstream };
  }
  if (slices) {
    if (pending.upstream !== null) {
      const line = locateSlice(pending.upstream, slices.upstream);
      if (line !== null) upstreamPane.value?.scrollToLine(line);
    }
    if (pending.local !== null) {
      const line = locateSlice(pending.local, slices.local);
      if (line !== null) localPane.value?.scrollToLine(line);
    }
  }
}

async function askAgent(): Promise<void> {
  const entry = selected.value;
  if (!entry) return;
  try {
    await navigator.clipboard.writeText(buildAgentContext(entry.graft, entry.file));
    toast("ok", "Context copied — paste it to your coding agent, then hit refresh here.");
  } catch {
    toast("error", "Could not write to the clipboard.");
  }
}
</script>

<template>
  <div class="grid h-screen grid-rows-[52px_1fr] overflow-hidden">
    <template v-if="state">
      <TopBar :state="state" :graft="selected?.graft ?? null" :file="selected?.file ?? null" :busy="busy" @refresh="refresh()" />

      <div v-if="pendingFiles.length > 0" class="grid min-h-0 grid-cols-[240px_minmax(0,1fr)_300px]">
        <FileRail :grafts="state.grafts" :selected-path="selectedPath" @select="(path) => (selectedPath = path)" />

        <main v-if="selected" :key="selected.file.path" class="flex min-h-0 min-w-0 flex-col">
          <div class="flex h-9 shrink-0 items-center gap-2 overflow-hidden border-b border-line bg-panel px-4">
            <span class="truncate font-mono text-[12px] text-fg">{{ selected.file.path }}</span>
            <span v-if="selected.file.pending" class="hidden truncate text-[10.5px] text-fg-dim sm:inline">
              {{ selected.graft.name }} · {{ selected.file.pending.kind.replace(/-/g, " ") }}
            </span>
            <button
              type="button"
              class="btn btn-ghost shrink-0 !px-2 !py-0.5 !text-[11px]"
              :class="isContentConflict ? '' : 'ml-auto'"
              title="Open this file in your editor (set REGRAFT_EDITOR to override)"
              @click="openEditor"
            >
              <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
                <path d="M6 3H3.5A1.5 1.5 0 0 0 2 4.5v8A1.5 1.5 0 0 0 3.5 14h8a1.5 1.5 0 0 0 1.5-1.5V10" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
                <path d="M9.5 2H14v4.5M14 2L7.5 8.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
              Open in editor
            </button>
            <div v-if="isContentConflict" class="ml-auto flex shrink-0 items-center gap-1">
              <button
                type="button"
                class="chip cursor-pointer transition-colors"
                :class="showUpstream ? 'border-accent/40 text-accent' : 'border-line-soft text-fg-dim hover:text-fg-mid'"
                @click="showUpstream = !showUpstream"
              >
                Upstream
              </button>
              <button
                type="button"
                class="chip cursor-pointer transition-colors"
                :class="showLocal ? 'border-local/40 text-local' : 'border-line-soft text-fg-dim hover:text-fg-mid'"
                @click="showLocal = !showLocal"
              >
                Yours
              </button>
            </div>
          </div>

          <template v-if="isContentConflict && selected.file.pending">
            <div class="grid min-h-0 flex-1 divide-x divide-line" :class="paneGridClass">
              <CodePane
                v-if="showUpstream"
                ref="upstreamPane"
                title="Upstream"
                :meta="selected.file.pending.toSha.slice(0, 7)"
                tone="upstream"
                :text="selected.file.pending.upstream"
                :base="selected.file.pending.base"
                :lang="lang"
              >
                <template #empty>Upstream no longer has this file.</template>
              </CodePane>
              <CodePane
                v-if="showLocal"
                ref="localPane"
                title="Your version"
                :meta="selected.file.pending.localExact ? 'exact' : 'reconstructed'"
                tone="local"
                :text="selected.file.pending.local"
                :base="selected.file.pending.base"
                :lang="lang"
              >
                <template #empty>No local version could be reconstructed.</template>
              </CodePane>
              <ResultPane ref="resultPane" :file="selected.file" :lang="lang" :busy="busy" @region="applyRegion" @reopen="reopenRegion" />
            </div>

            <footer class="flex h-13 shrink-0 items-center gap-1.5 border-t border-line bg-panel px-4">
              <button type="button" class="btn btn-ghost" :disabled="busy || !canUndo" @click="undo">Undo</button>
              <button type="button" class="btn btn-ghost" :disabled="busy" @click="askAgent">
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
                  <path d="M8 1.5l1.4 3.6 3.6 1.4-3.6 1.4L8 11.5 6.6 7.9 3 6.5l3.6-1.4L8 1.5z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" />
                  <path d="M13 10.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7.7-1.8z" fill="currentColor" opacity="0.7" />
                </svg>
                Ask agent
              </button>
              <div class="ml-auto flex items-center gap-2">
                <span v-if="conflictsRemaining > 0" class="hidden text-[11px] text-fg-dim md:inline">
                  {{ conflictsRemaining }} decision{{ conflictsRemaining === 1 ? "" : "s" }} left
                </span>
                <div class="relative">
                  <button type="button" class="btn" :disabled="busy" @click="fileMenuOpen = !fileMenuOpen">
                    Whole file
                    <svg width="10" height="10" viewBox="0 0 16 16" fill="none">
                      <path d="M4 6l4 4 4-4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
                    </svg>
                  </button>
                  <div v-if="fileMenuOpen" class="fixed inset-0 z-30" @click="fileMenuOpen = false" />
                  <div
                    v-if="fileMenuOpen"
                    class="rise-in absolute right-0 bottom-11 z-40 w-64 overflow-hidden rounded-xl border border-line bg-raise shadow-2xl"
                  >
                    <button type="button" class="menu-item" @click="fileMenuOpen = false; fileAction('keep-local')">
                      <span class="font-medium">Keep your version</span>
                      <span class="text-[10.5px] text-fg-dim">Every region resolves to your side</span>
                    </button>
                    <button type="button" class="menu-item" @click="fileMenuOpen = false; fileAction('use-upstream')">
                      <span class="font-medium">Use upstream version</span>
                      <span class="text-[10.5px] text-fg-dim">Your adaptations to this file are dropped</span>
                    </button>
                    <button type="button" class="menu-item border-t border-line-soft" @click="fileMenuOpen = false; fileAction('reset')">
                      <span class="font-medium">Reset to merge state</span>
                      <span class="text-[10.5px] text-fg-dim">Restore the original markers from this session</span>
                    </button>
                  </div>
                </div>
                <button
                  type="button"
                  class="btn btn-primary"
                  :disabled="busy || conflictsRemaining > 0"
                  :title="conflictsRemaining > 0 ? `${conflictsRemaining} decision${conflictsRemaining === 1 ? '' : 's'} left in this file` : ''"
                  @click="noteModalOpen = true"
                >
                  <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
                    <path d="M3 8.5l3.5 3.5L13 5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
                  </svg>
                  Accept result
                </button>
              </div>
            </footer>
          </template>

          <WarningView v-else :file="selected.file" :busy="busy" @action="fileAction" />
        </main>

        <SideBar v-if="selected" :graft="selected.graft" :file="selected.file" @jump="jumpToConflict" />
      </div>

      <EmptyState v-else :state="state" @refresh="refresh(false)" />
    </template>

    <template v-else>
      <div />
      <div class="flex items-center justify-center">
        <div v-if="loadError" class="card max-w-md p-6 text-center">
          <p class="text-[14px] font-semibold text-danger">Could not load state</p>
          <p class="mt-2 text-[12.5px] leading-relaxed text-fg-mid">{{ loadError }}</p>
          <button type="button" class="btn mt-4" @click="refresh(false)">Retry</button>
        </div>
        <div v-else class="pulse-soft flex items-center gap-2.5 text-fg-dim">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
            <path d="M12 21V9" stroke="#34d399" stroke-width="2" stroke-linecap="round" />
            <path d="M12 13c0-3 2.5-5 6-5" stroke="#34d399" stroke-width="2" stroke-linecap="round" />
            <circle cx="12" cy="6" r="2.4" stroke="#a1a1aa" stroke-width="1.6" />
          </svg>
          <span class="text-[13px]">Reading your grafts…</span>
        </div>
      </div>
    </template>

    <NoteModal v-if="noteModalOpen && selectedPath" :path="selectedPath" :busy="busy" @submit="acceptResult" @close="noteModalOpen = false" />
    <UiToasts />
  </div>
</template>
