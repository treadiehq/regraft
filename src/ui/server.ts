import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname } from "node:path";
import { noteCommand } from "../commands/note";
import { pullCommand, type PullResult } from "../commands/pull";
import { resolveCommand, type ResolveResult } from "../commands/resolve";
import { statusCommand, type StatusResult } from "../commands/status";
import { applyConflictChoice, reconstructLocal, type ConflictChoice } from "../core/conflicts";
import { ensureCacheRepo, ensureCommit, readFileAt } from "../core/git";
import { readFileIfExists, sha256 } from "../core/hash";
import { requireManifest, type Graft, type GraftFile } from "../core/manifest";
import { hydratePendingTarget } from "../core/pending";
import { analyzeResolution, reopenRegion } from "../core/review";
import {
  cacheRoot,
  managedFilePath,
  projectPath,
  pruneEmptyDirs,
  upstreamPath,
  withWorkspaceLock,
  writeFileEnsuringDir,
} from "../core/workspace";
import { APP_HTML } from "./app-html";
import { openInEditor } from "./editor";
import { buildUiState, readPendingSides, type UiState } from "./state";

export interface UiServerOptions {
  root: string;
  /** 0 (default) picks a free port. */
  port?: number;
}

export interface UiServerHandle {
  url: string;
  port: number;
  token: string;
  close: () => Promise<void>;
}

interface PendingEntry {
  graft: Graft;
  rel: string;
  file: GraftFile;
}

type FileAction = "use-upstream" | "keep-local" | "keep-deleted" | "delete" | "restore-upstream" | "reset";

const ACTIONS_BY_KIND: Record<string, FileAction[]> = {
  "content-conflict": ["use-upstream", "keep-local", "reset"],
  "legacy-conflict": ["use-upstream", "keep-local", "reset"],
  "binary-conflict": ["use-upstream", "keep-local"],
  "upstream-deleted": ["keep-local", "delete"],
  "local-deleted": ["restore-upstream", "keep-deleted"],
  "destination-collision": ["use-upstream", "keep-local"],
  "ownership-unknown": ["use-upstream", "keep-local"],
};

const MAX_BODY = 25 * 1024 * 1024;

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(payload);
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        rejectPromise(new Error("Request body too large."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (chunks.length === 0) {
        resolvePromise({});
        return;
      }
      try {
        resolvePromise(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        rejectPromise(new Error("Request body must be valid JSON."));
      }
    });
    req.on("error", rejectPromise);
  });
}

function findPendingEntry(root: string, path: string): PendingEntry {
  const manifest = requireManifest(root);
  for (const graft of manifest.grafts) {
    for (const [rel, file] of Object.entries(graft.files)) {
      if (projectPath(graft.dest, rel) === path && file.pending) return { graft, rel, file };
    }
  }
  throw new Error(`"${path}" has no pending update.`);
}

function isTrackedPath(root: string, path: string): boolean {
  const manifest = requireManifest(root);
  return manifest.grafts.some((graft) => Object.keys(graft.files).some((rel) => projectPath(graft.dest, rel) === path));
}

function upstreamBufferFor(root: string, entry: PendingEntry): Buffer {
  const pending = entry.file.pending!;
  hydratePendingTarget(root, entry.graft, entry.rel, entry.file);
  if (pending.targetHash === null) {
    throw new Error("Upstream deleted this file; there is no upstream content to use.");
  }
  const cache = ensureCacheRepo(cacheRoot(root), entry.graft.url);
  ensureCommit(cache, entry.graft.url, pending.toSha, entry.graft.remoteRef);
  return readFileAt(cache, pending.toSha, upstreamPath(entry.graft.path, entry.rel));
}

function localTextFor(root: string, entry: PendingEntry, snapshot: string | undefined): string {
  const pending = entry.file.pending!;
  const working = readFileIfExists(managedFilePath(root, projectPath(entry.graft.dest, entry.rel)));
  if (working !== null && pending.observedLocalHash !== null && sha256(working) === pending.observedLocalHash) {
    return working.toString("utf8");
  }
  const source = working?.toString("utf8") ?? snapshot;
  if (source === undefined) throw new Error("No local content is available to restore.");
  return reconstructLocal(source);
}

export function startUiServer(options: UiServerOptions): Promise<UiServerHandle> {
  const root = options.root;
  const token = randomBytes(16).toString("hex");
  /** Original marker files captured at first sight, for per-file reset. */
  const snapshots = new Map<string, string>();

  const captureSnapshots = (state: UiState): void => {
    for (const graft of state.grafts) {
      for (const file of graft.files) {
        if (file.pending?.working != null && file.pending.segments !== null && !snapshots.has(file.path)) {
          snapshots.set(file.path, file.pending.working);
        }
      }
    }
  };

  const authorized = (req: IncomingMessage, url: URL): boolean => {
    const host = req.headers.host ?? "";
    if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host)) return false;
    const origin = req.headers.origin;
    if (origin !== undefined && new URL(origin).host !== host) return false;
    const provided = req.headers["x-regraft-token"] ?? url.searchParams.get("token");
    return provided === token;
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (!authorized(req, url)) {
      json(res, 403, { error: "Missing or invalid token. Re-open the URL printed by `regraft ui`." });
      return;
    }

    if (!url.pathname.startsWith("/api/")) {
      if (req.method !== "GET") {
        json(res, 405, { error: "Method not allowed." });
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(APP_HTML);
      return;
    }

    const route = `${req.method} ${url.pathname}`;
    switch (route) {
      case "GET /api/state": {
        const state = buildUiState(root, requireManifest(root));
        captureSnapshots(state);
        json(res, 200, state);
        return;
      }
      case "POST /api/check": {
        const result: StatusResult = statusCommand({ cwd: root, offline: false });
        json(res, 200, result);
        return;
      }
      case "POST /api/pull": {
        const body = (await readBody(req)) as { grafts?: string[] };
        const result: PullResult = pullCommand({ cwd: root, grafts: body.grafts });
        json(res, 200, result);
        return;
      }
      case "POST /api/region": {
        const body = (await readBody(req)) as {
          path?: string;
          index?: number;
          choice?: ConflictChoice;
          text?: string;
        };
        if (typeof body.path !== "string" || typeof body.index !== "number" || !body.choice) {
          throw new Error("region requires path, index, and choice.");
        }
        withWorkspaceLock(root, () => {
          const entry = findPendingEntry(root, body.path!);
          const kind = entry.file.pending!.kind;
          if (kind !== "content-conflict" && kind !== "legacy-conflict") {
            throw new Error("Only content conflicts have resolvable regions.");
          }
          const abs = managedFilePath(root, body.path!);
          const working = readFileIfExists(abs);
          if (working === null) throw new Error(`"${body.path}" is missing on disk.`);
          const next = applyConflictChoice(working.toString("utf8"), body.index!, body.choice!, body.text);
          writeFileEnsuringDir(root, body.path!, next);
        });
        json(res, 200, { ok: true });
        return;
      }
      case "POST /api/reopen": {
        const body = (await readBody(req)) as { path?: string; index?: number };
        if (typeof body.path !== "string" || typeof body.index !== "number") {
          throw new Error("reopen requires path and index.");
        }
        withWorkspaceLock(root, () => {
          const entry = findPendingEntry(root, body.path!);
          const kind = entry.file.pending!.kind;
          if (kind !== "content-conflict" && kind !== "legacy-conflict") {
            throw new Error("Only content conflicts have reopenable regions.");
          }
          const sides = readPendingSides(root, entry.graft, entry.rel, entry.file);
          if (!sides.localExact || sides.base === null || sides.upstream === null || sides.local === null || sides.working === null) {
            throw new Error("This decision cannot be reopened: the original version of the file is unavailable.");
          }
          const analysis = analyzeResolution({
            base: sides.base,
            local: sides.local,
            upstream: sides.upstream,
            working: sides.working,
          });
          if (!analysis) throw new Error("Could not re-derive the conflict layout for this file.");
          writeFileEnsuringDir(root, body.path!, reopenRegion(sides.working, analysis, body.index!));
        });
        json(res, 200, { ok: true });
        return;
      }
      case "POST /api/open-editor": {
        const body = (await readBody(req)) as { path?: string; line?: number };
        if (typeof body.path !== "string") throw new Error("open-editor requires path.");
        if (!isTrackedPath(root, body.path)) throw new Error(`"${body.path}" is not a tracked file.`);
        const line = typeof body.line === "number" && body.line > 0 ? Math.floor(body.line) : 1;
        const editor = await openInEditor(managedFilePath(root, body.path), line);
        json(res, 200, { ok: true, editor });
        return;
      }
      case "POST /api/file-action": {
        const body = (await readBody(req)) as { path?: string; action?: FileAction };
        if (typeof body.path !== "string" || !body.action) throw new Error("file-action requires path and action.");
        const resolveAfter = withWorkspaceLock(root, () => {
          const entry = findPendingEntry(root, body.path!);
          const allowed = ACTIONS_BY_KIND[entry.file.pending!.kind] ?? [];
          if (!allowed.includes(body.action!)) {
            throw new Error(`"${body.action}" does not apply to a ${entry.file.pending!.kind} file.`);
          }
          switch (body.action!) {
            case "use-upstream":
            case "restore-upstream":
              writeFileEnsuringDir(root, body.path!, upstreamBufferFor(root, entry));
              return true;
            case "keep-local": {
              const kind = entry.file.pending!.kind;
              if (kind === "content-conflict" || kind === "legacy-conflict") {
                writeFileEnsuringDir(root, body.path!, localTextFor(root, entry, snapshots.get(body.path!)));
              }
              return true;
            }
            case "keep-deleted":
              return true;
            case "delete":
              rmSync(managedFilePath(root, body.path!), { force: true });
              pruneEmptyDirs(root, dirname(body.path!));
              return true;
            case "reset": {
              const snapshot = snapshots.get(body.path!);
              if (snapshot === undefined) throw new Error("No snapshot to reset to in this session.");
              writeFileEnsuringDir(root, body.path!, snapshot);
              return false;
            }
          }
        });
        // resolveCommand takes the workspace lock itself, so run it after the
        // write lock above has been released.
        const result: ResolveResult | null = resolveAfter ? resolveCommand({ cwd: root, files: [body.path] }) : null;
        json(res, 200, { ok: true, resolve: result });
        return;
      }
      case "POST /api/resolve": {
        const body = (await readBody(req)) as { files?: string[]; note?: string };
        const result: ResolveResult = resolveCommand({ cwd: root, files: body.files, note: body.note });
        json(res, 200, result);
        return;
      }
      case "POST /api/note": {
        const body = (await readBody(req)) as { description?: string; files?: string[] };
        if (typeof body.description !== "string" || body.description.trim() === "") {
          throw new Error("note requires a description.");
        }
        json(res, 200, noteCommand(body.description, { cwd: root, files: body.files }));
        return;
      }
      case "POST /api/restore": {
        const body = (await readBody(req)) as { path?: string; text?: string };
        if (typeof body.path !== "string" || typeof body.text !== "string") {
          throw new Error("restore requires path and text.");
        }
        withWorkspaceLock(root, () => {
          findPendingEntry(root, body.path!); // only files with pending judgment may be rewritten
          writeFileEnsuringDir(root, body.path!, body.text!);
        });
        json(res, 200, { ok: true });
        return;
      }
      default:
        json(res, 404, { error: `Unknown route: ${route}` });
    }
  };

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      if (!res.headersSent) json(res, 400, { error: message });
      else res.end();
    });
  });

  return new Promise((resolvePromise, rejectPromise) => {
    server.on("error", rejectPromise);
    server.listen(options.port ?? 0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      resolvePromise({
        url: `http://127.0.0.1:${port}/?token=${token}`,
        port,
        token,
        close: () =>
          new Promise<void>((closed, closeFailed) => {
            server.close((error) => (error ? closeFailed(error) : closed()));
            server.closeAllConnections();
          }),
      });
    });
  });
}
