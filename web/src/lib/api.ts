import type {
  ConflictChoice,
  FileAction,
  PullResult,
  ResolveResult,
  StatusResult,
  UiState,
} from "./types";

const token = new URLSearchParams(window.location.search).get("token") ?? "";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      "x-regraft-token": token,
      ...(init?.body !== undefined ? { "content-type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  const body: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message =
      typeof body === "object" && body !== null && "error" in body ? String((body as { error: unknown }).error) : response.statusText;
    throw new Error(message);
  }
  return body as T;
}

function post<T>(path: string, payload: unknown): Promise<T> {
  return request<T>(path, { method: "POST", body: JSON.stringify(payload) });
}

export const api = {
  state: () => request<UiState>("/api/state"),
  check: () => post<StatusResult>("/api/check", {}),
  pull: (grafts?: string[]) => post<PullResult>("/api/pull", { grafts }),
  region: (path: string, index: number, choice: ConflictChoice, text?: string) =>
    post<{ ok: true }>("/api/region", { path, index, choice, text }),
  reopen: (path: string, index: number) => post<{ ok: true }>("/api/reopen", { path, index }),
  openEditor: (path: string, line?: number) => post<{ ok: true; editor: string }>("/api/open-editor", { path, line }),
  fileAction: (path: string, action: FileAction) =>
    post<{ ok: true; resolve: ResolveResult | null }>("/api/file-action", { path, action }),
  resolve: (files?: string[], note?: string) => post<ResolveResult>("/api/resolve", { files, note }),
  restore: (path: string, text: string) => post<{ ok: true }>("/api/restore", { path, text }),
  note: (description: string, files?: string[]) => post<{ ok: true }>("/api/note", { description, files }),
};
