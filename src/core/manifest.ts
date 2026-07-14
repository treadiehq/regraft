import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import { assertSafeProjectPath, managedFilePath, writeFileEnsuringDir } from "./workspace";

export const MANIFEST_FILE = "regraft.json";
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/, "must be a sha256 hex digest");

function safeProjectPathSchema(label: string, opts: { allowEmpty?: boolean } = {}) {
  return z.string().transform((p, ctx) => {
    try {
      return assertSafeProjectPath(p, label, opts);
    } catch (err) {
      ctx.addIssue({ code: "custom", message: (err as Error).message });
      return z.NEVER;
    }
  });
}

function safeProjectPathRecordSchema(label: string, opts: { allowEmpty?: boolean } = {}) {
  return z.record(z.string(), sha256Schema).transform((rec, ctx) => {
    const safeEntries: [string, string][] = [];
    for (const [path, hash] of Object.entries(rec)) {
      try {
        safeEntries.push([assertSafeProjectPath(path, label, opts), hash]);
      } catch (err) {
        ctx.addIssue({ code: "custom", path: [path], message: (err as Error).message });
      }
    }
    return ctx.issues.length > 0 ? z.NEVER : Object.fromEntries(safeEntries);
  });
}

const sourceSchema = z.object({
  /** Git URL fetched via the user's git (https, ssh, file://, ...). */
  url: z.string().min(1),
  /** Branch (or tag/SHA) name that pulls resolve against. */
  remoteRef: z.string().min(1),
  /** Subpath inside the upstream repo. "" means repo root. */
  path: z.string(),
  /** Local path (project-root-relative) the source is vendored into. */
  dest: safeProjectPathSchema("sources.dest"),
  /** Upstream commit we last reconciled against. */
  pinnedSha: z.string().regex(/^[0-9a-f]{40}$/, "must be a 40-char lowercase git SHA"),
  /**
   * Per-file sha256 of the content regraft last wrote (or accepted at
   * resolve time). Keys are paths relative to dest; "" means dest itself
   * is the file (single-file sources).
   */
  files: safeProjectPathRecordSchema("sources.files key", { allowEmpty: true }),
  /** Files (relative to dest) with unresolved conflict markers from a pull. */
  unresolved: z.array(safeProjectPathSchema("sources.unresolved entry", { allowEmpty: true })),
});

const intentSchema = z.object({
  /** Short random id. */
  id: z.string().min(1),
  /** ISO 8601 timestamp of when the intent was recorded. */
  date: z.string().min(1),
  /** Plain-English description of what was changed and why. */
  description: z.string().min(1),
  /** Project-root-relative path -> sha256 of the file when recorded. */
  files: safeProjectPathRecordSchema("intents.files key"),
});

export const manifestSchema = z.object({
  version: z.literal(1),
  sources: z.array(sourceSchema),
  intents: z.array(intentSchema),
});

export type Manifest = z.infer<typeof manifestSchema>;
export type Source = z.infer<typeof sourceSchema>;
export type Intent = z.infer<typeof intentSchema>;

export function emptyManifest(): Manifest {
  return { version: 1, sources: [], intents: [] };
}

/** Load and validate regraft.json. Returns null if the file does not exist. */
export function loadManifest(root: string): Manifest | null {
  const file = managedFilePath(root, MANIFEST_FILE);
  if (!existsSync(file)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`${MANIFEST_FILE} is not valid JSON: ${(err as Error).message}`);
  }
  const result = manifestSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`${MANIFEST_FILE} failed validation:\n${issues}`);
  }
  return result.data;
}

/** Load regraft.json or throw a helpful error if it does not exist. */
export function requireManifest(root: string): Manifest {
  const manifest = loadManifest(root);
  if (!manifest) {
    throw new Error(
      `No ${MANIFEST_FILE} found in ${root} (or any parent directory). ` +
        `Start tracking a source first, e.g.: regraft add owner/repo/tree/main/src/components`,
    );
  }
  return manifest;
}

/** Write regraft.json with sorted file maps for stable diffs. */
export function saveManifest(root: string, manifest: Manifest): void {
  const sortRecord = (rec: Record<string, string>): Record<string, string> =>
    Object.fromEntries(Object.entries(rec).sort(([a], [b]) => a.localeCompare(b)));
  const canonical: Manifest = {
    version: manifest.version,
    sources: manifest.sources.map((s) => ({
      url: s.url,
      remoteRef: s.remoteRef,
      path: s.path,
      dest: s.dest,
      pinnedSha: s.pinnedSha,
      files: sortRecord(s.files),
      unresolved: [...s.unresolved].sort(),
    })),
    intents: manifest.intents.map((i) => ({
      id: i.id,
      date: i.date,
      description: i.description,
      files: sortRecord(i.files),
    })),
  };
  writeFileEnsuringDir(root, MANIFEST_FILE, JSON.stringify(canonical, null, 2) + "\n");
}
