import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import {
  createGraftId,
  deriveGraftName,
  destinationsOverlap,
  GRAFT_ID_RE,
  GRAFT_NAME_RE,
  uniqueGraftName,
} from "./grafts";
import { hashFileIfExists } from "./hash";
import { assertSafeProjectPath, managedFilePath, projectPath, writeFileAtomic } from "./workspace";

export const MANIFEST_FILE = "regraft.json";
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/, "must be a sha256 hex digest");
const contentHashSchema = sha256Schema.nullable();
const gitShaSchema = z.string().regex(/^[0-9a-f]{40}$/, "must be a 40-char lowercase git SHA");

function safeProjectPathSchema(
  label: string,
  opts: { allowEmpty?: boolean; canonicalize?: boolean } = {},
) {
  return z.string().transform((path, ctx) => {
    try {
      const canonical = assertSafeProjectPath(path, label, opts);
      if (canonical !== path && !opts.canonicalize) {
        ctx.addIssue({
          code: "custom",
          message: `${label} must use canonical project-relative form "${canonical}"`,
        });
        return z.NEVER;
      }
      return canonical;
    } catch (error) {
      ctx.addIssue({ code: "custom", message: (error as Error).message });
      return z.NEVER;
    }
  });
}

function safeProjectPathRecordSchema<T extends z.ZodType>(
  valueSchema: T,
  label: string,
  opts: { allowEmpty?: boolean; canonicalize?: boolean } = {},
) {
  return z.record(z.string(), valueSchema).transform((record, ctx) => {
    const safeEntries: [string, z.infer<T>][] = [];
    const seen = new Set<string>();
    for (const [path, value] of Object.entries(record)) {
      try {
        const canonical = assertSafeProjectPath(path, label, opts);
        if (canonical !== path && !opts.canonicalize) {
          ctx.addIssue({
            code: "custom",
            path: [path],
            message: `${label} must use canonical project-relative form "${canonical}"`,
          });
        } else if (seen.has(canonical)) {
          ctx.addIssue({ code: "custom", path: [path], message: `${label} collides with another path` });
        } else {
          seen.add(canonical);
          safeEntries.push([canonical, value as z.infer<T>]);
        }
      } catch (error) {
        ctx.addIssue({ code: "custom", path: [path], message: (error as Error).message });
      }
    }
    return ctx.issues.length > 0 ? z.NEVER : Object.fromEntries(safeEntries);
  });
}

export const pendingKindSchema = z.enum([
  "content-conflict",
  "binary-conflict",
  "upstream-deleted",
  "local-deleted",
  "destination-collision",
  "ownership-unknown",
  "legacy-conflict",
]);

const pendingSchema = z
  .object({
    kind: pendingKindSchema,
    fromSha: gitShaSchema.nullable(),
    toSha: gitShaSchema,
    targetKnown: z.boolean(),
    targetHash: contentHashSchema,
    observedLocalHash: contentHashSchema,
    markerHash: contentHashSchema,
    brief: safeProjectPathSchema("grafts.files.pending.brief").nullable(),
  })
  .strict();

const graftFileSchema = z
  .object({
    upstreamHash: contentHashSchema,
    localHash: contentHashSchema,
    intentIds: z.array(z.string().min(1)),
    needsIntent: z.boolean(),
    pending: pendingSchema.nullable(),
  })
  .strict();

const publicationSchema = z
  .object({
    manifestVersion: z.literal(1),
    name: z.string().regex(GRAFT_NAME_RE),
    description: z.string().min(1).max(300),
  })
  .strict();

const graftSchema = z
  .object({
    id: z.string().regex(GRAFT_ID_RE, "must be a Graft ID such as g_0123456789abcdef"),
    name: z.string().regex(GRAFT_NAME_RE, "must be a lowercase kebab-case Graft name").max(63),
    url: z.string().min(1),
    remoteRef: z.string().min(1),
    path: safeProjectPathSchema("grafts.path", { allowEmpty: true }),
    dest: safeProjectPathSchema("grafts.dest"),
    pinnedSha: gitShaSchema,
    ownership: z.enum(["complete", "legacy-unknown"]).default("complete"),
    excluded: z.array(safeProjectPathSchema("grafts.excluded entry", { allowEmpty: true })).default([]),
    files: safeProjectPathRecordSchema(graftFileSchema, "grafts.files key", { allowEmpty: true }),
    publication: publicationSchema.optional(),
  })
  .strict();

const intentTargetSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("graft-file"),
      graftId: z.string().regex(GRAFT_ID_RE),
      rel: safeProjectPathSchema("intents.targets.rel", { allowEmpty: true }),
      path: safeProjectPathSchema("intents.targets.path"),
      hash: contentHashSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("legacy-orphan"),
      path: safeProjectPathSchema("intents.targets.path"),
      hash: contentHashSchema,
    })
    .strict(),
]);

const intentSchema = z
  .object({
    id: z.string().min(1),
    date: z.string().datetime({ offset: true }),
    description: z.string().min(1),
    targets: z.array(intentTargetSchema).min(1),
  })
  .strict();

export const manifestSchema = z
  .object({
    version: z.literal(2),
    grafts: z.array(graftSchema),
    intents: z.array(intentSchema),
  })
  .strict()
  .superRefine((manifest, ctx) => {
    const ids = new Set<string>();
    const names = new Set<string>();
    for (const [index, graft] of manifest.grafts.entries()) {
      if (ids.has(graft.id)) ctx.addIssue({ code: "custom", path: ["grafts", index, "id"], message: "duplicate Graft ID" });
      if (names.has(graft.name)) {
        ctx.addIssue({ code: "custom", path: ["grafts", index, "name"], message: "duplicate Graft name" });
      }
      ids.add(graft.id);
      names.add(graft.name);
      for (let other = 0; other < index; other += 1) {
        if (destinationsOverlap(manifest.grafts[other]!.dest, graft.dest)) {
          ctx.addIssue({
            code: "custom",
            path: ["grafts", index, "dest"],
            message: `overlaps destination "${manifest.grafts[other]!.dest}"`,
          });
        }
      }
    }
    const intentById = new Map<string, (typeof manifest.intents)[number]>();
    for (const [intentIndex, intent] of manifest.intents.entries()) {
      if (intentById.has(intent.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["intents", intentIndex, "id"],
          message: "duplicate Intent ID",
        });
      }
      intentById.set(intent.id, intent);
      const targetKeys = new Set<string>();
      for (const [targetIndex, target] of intent.targets.entries()) {
        if (target.kind === "legacy-orphan") continue;
        const key = `${target.graftId}\0${target.rel}`;
        if (targetKeys.has(key)) {
          ctx.addIssue({
            code: "custom",
            path: ["intents", intentIndex, "targets", targetIndex],
            message: "duplicate Graft file target",
          });
        }
        targetKeys.add(key);
        const graft = manifest.grafts.find((candidate) => candidate.id === target.graftId);
        if (!graft) {
          ctx.addIssue({
            code: "custom",
            path: ["intents", intentIndex, "targets", targetIndex, "graftId"],
            message: "references unknown Graft",
          });
          continue;
        }
        if (projectPath(graft.dest, target.rel) !== target.path) {
          ctx.addIssue({
            code: "custom",
            path: ["intents", intentIndex, "targets", targetIndex, "path"],
            message: "does not match the Graft destination and relative path",
          });
        }
      }
    }
    for (const [graftIndex, graft] of manifest.grafts.entries()) {
      const excluded = new Set<string>();
      for (const [excludedIndex, rel] of graft.excluded.entries()) {
        if (excluded.has(rel)) {
          ctx.addIssue({
            code: "custom",
            path: ["grafts", graftIndex, "excluded", excludedIndex],
            message: "duplicate excluded file",
          });
        }
        excluded.add(rel);
        if (graft.files[rel]) {
          ctx.addIssue({
            code: "custom",
            path: ["grafts", graftIndex, "excluded", excludedIndex],
            message: "cannot exclude a tracked file",
          });
        }
      }
      for (const [rel, file] of Object.entries(graft.files)) {
        for (const intentId of file.intentIds) {
          const intent = intentById.get(intentId);
          if (!intent) {
            ctx.addIssue({
              code: "custom",
              path: ["grafts", graftIndex, "files", rel, "intentIds"],
              message: `references unknown intent "${intentId}"`,
            });
          } else if (
            !intent.targets.some(
              (target) =>
                target.kind === "graft-file" &&
                target.graftId === graft.id &&
                target.rel === rel &&
                target.path === projectPath(graft.dest, rel),
            )
          ) {
            ctx.addIssue({
              code: "custom",
              path: ["grafts", graftIndex, "files", rel, "intentIds"],
              message: `Intent "${intentId}" does not target this Graft file`,
            });
          }
        }
      }
    }
  });

const sourceV1Schema = z
  .object({
    url: z.string().min(1),
    remoteRef: z.string().min(1),
    path: safeProjectPathSchema("sources.path", { allowEmpty: true, canonicalize: true }),
    dest: safeProjectPathSchema("sources.dest", { canonicalize: true }),
    pinnedSha: gitShaSchema,
    files: safeProjectPathRecordSchema(sha256Schema, "sources.files key", {
      allowEmpty: true,
      canonicalize: true,
    }),
    unresolved: z.array(
      safeProjectPathSchema("sources.unresolved entry", { allowEmpty: true, canonicalize: true }),
    ),
  })
  .passthrough();

const intentV1Schema = z
  .object({
    id: z.string().min(1),
    date: z.string().min(1),
    description: z.string().min(1),
    files: safeProjectPathRecordSchema(sha256Schema, "intents.files key", { canonicalize: true }),
  })
  .passthrough();

export const manifestV1Schema = z
  .object({
    version: z.literal(1),
    sources: z.array(sourceV1Schema),
    intents: z.array(intentV1Schema),
  })
  .passthrough();

export type Manifest = z.infer<typeof manifestSchema>;
export type Graft = z.infer<typeof graftSchema>;
/** Backward-compatible internal alias while command DTOs retain `source(s)` keys. */
export type Source = Graft;
export type GraftFile = z.infer<typeof graftFileSchema>;
export type PendingReconciliation = z.infer<typeof pendingSchema>;
export type PendingKind = z.infer<typeof pendingKindSchema>;
export type Intent = z.infer<typeof intentSchema>;
export type IntentTarget = z.infer<typeof intentTargetSchema>;
type ManifestV1 = z.infer<typeof manifestV1Schema>;

export function emptyManifest(): Manifest {
  return { version: 2, grafts: [], intents: [] };
}

function formatValidationError(error: z.ZodError): string {
  return error.issues.map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`).join("\n");
}

function migrateV1(root: string, legacy: ManifestV1): Manifest {
  const names = new Set<string>();
  const grafts: Graft[] = legacy.sources.map((source) => {
    const name = uniqueGraftName(deriveGraftName(source.dest), names);
    names.add(name);
    const id = createGraftId(source);
    const files: Record<string, GraftFile> = {};
    for (const [rel, storedHash] of Object.entries(source.files)) {
      const path = projectPath(source.dest, rel);
      const diskHash = hashFileIfExists(managedFilePath(root, path));
      files[rel] = {
        upstreamHash: storedHash,
        localHash: storedHash,
        intentIds: [],
        needsIntent: false,
        pending: source.unresolved.includes(rel)
          ? {
              kind: "legacy-conflict",
              fromSha: null,
              toSha: source.pinnedSha,
              targetKnown: false,
              targetHash: null,
              observedLocalHash: diskHash,
              markerHash: diskHash,
              brief: null,
            }
          : null,
      };
    }
    return {
      id,
      name,
      url: source.url,
      remoteRef: source.remoteRef,
      path: source.path,
      dest: source.dest,
      pinnedSha: source.pinnedSha,
      ownership: "legacy-unknown",
      excluded: [],
      files,
    };
  });

  const owners = new Map<string, { graft: Graft; rel: string }[]>();
  for (const graft of grafts) {
    for (const rel of Object.keys(graft.files)) {
      const path = projectPath(graft.dest, rel);
      const entries = owners.get(path) ?? [];
      entries.push({ graft, rel });
      owners.set(path, entries);
    }
  }

  const intents: Intent[] = legacy.intents.map((legacyIntent) => {
    const targets: IntentTarget[] = [];
    for (const [path, hash] of Object.entries(legacyIntent.files)) {
      const matches = owners.get(path) ?? [];
      if (matches.length !== 1) {
        targets.push({ kind: "legacy-orphan", path, hash });
        continue;
      }
      const { graft, rel } = matches[0]!;
      targets.push({ kind: "graft-file", graftId: graft.id, rel, path, hash });
      const file = graft.files[rel]!;
      const diskHash = hashFileIfExists(managedFilePath(root, path));
      if (diskHash === hash || file.localHash === hash) {
        file.localHash = diskHash === hash ? diskHash : file.localHash;
        file.intentIds.push(legacyIntent.id);
      }
    }
    return {
      id: legacyIntent.id,
      date: Number.isNaN(Date.parse(legacyIntent.date)) ? new Date(0).toISOString() : new Date(legacyIntent.date).toISOString(),
      description: legacyIntent.description,
      targets,
    };
  });

  for (const graft of grafts) {
    for (const [rel, file] of Object.entries(graft.files)) {
      const diskHash = hashFileIfExists(managedFilePath(root, projectPath(graft.dest, rel)));
      if (diskHash !== file.localHash && file.pending === null) file.needsIntent = true;
    }
  }

  const migrated: Manifest = { version: 2, grafts, intents };
  const validated = manifestSchema.safeParse(migrated);
  if (!validated.success) {
    throw new Error(
      `${MANIFEST_FILE} version 1 cannot be migrated safely:\n${formatValidationError(validated.error)}\n` +
        "Resolve overlapping destinations or invalid legacy state before retrying.",
    );
  }
  return validated.data;
}

/** Load and validate regraft.json. Version 1 is migrated safely in memory. */
export function loadManifest(root: string): Manifest | null {
  const file = managedFilePath(root, MANIFEST_FILE);
  if (!existsSync(file)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`${MANIFEST_FILE} is not valid JSON: ${(error as Error).message}`);
  }
  const version = (parsed as { version?: unknown } | null)?.version;
  if (version === 1) {
    const legacy = manifestV1Schema.safeParse(parsed);
    if (!legacy.success) {
      throw new Error(`${MANIFEST_FILE} failed validation:\n${formatValidationError(legacy.error)}`);
    }
    return migrateV1(root, legacy.data);
  }
  if (version !== 2) {
    throw new Error(`${MANIFEST_FILE} failed validation:\n  - version: unsupported manifest version ${String(version)}; supported: 1, 2`);
  }
  const result = manifestSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`${MANIFEST_FILE} failed validation:\n${formatValidationError(result.error)}`);
  }
  return result.data;
}

export function requireManifest(root: string): Manifest {
  const manifest = loadManifest(root);
  if (!manifest) {
    throw new Error(
      `No ${MANIFEST_FILE} found in ${root} (or any parent directory). ` +
        "Create a Graft first, e.g.: regraft add owner/repo/tree/main/src/components",
    );
  }
  return manifest;
}

/** Validate and atomically write manifest v2 with deterministic ordering. */
export function saveManifest(root: string, manifest: Manifest): void {
  const sortRecord = <T>(record: Record<string, T>): Record<string, T> =>
    Object.fromEntries(Object.entries(record).sort(([left], [right]) => left.localeCompare(right)));
  const canonical: Manifest = {
    version: 2,
    grafts: manifest.grafts.map((graft) => ({
      id: graft.id,
      name: graft.name,
      url: graft.url,
      remoteRef: graft.remoteRef,
      path: graft.path,
      dest: graft.dest,
      pinnedSha: graft.pinnedSha,
      ownership: graft.ownership,
      excluded: [...graft.excluded].sort(),
      files: sortRecord(
        Object.fromEntries(
          Object.entries(graft.files).map(([rel, file]) => [
            rel,
            {
              upstreamHash: file.upstreamHash,
              localHash: file.localHash,
              intentIds: [...new Set(file.intentIds)].sort(),
              needsIntent: file.needsIntent,
              pending: file.pending,
            },
          ]),
        ),
      ),
      ...(graft.publication ? { publication: graft.publication } : {}),
    })),
    intents: manifest.intents.map((intent) => ({
      id: intent.id,
      date: intent.date,
      description: intent.description,
      targets: [...intent.targets].sort((left, right) => left.path.localeCompare(right.path)),
    })),
  };
  const validated = manifestSchema.safeParse(canonical);
  if (!validated.success) {
    throw new Error(`Refusing to write invalid ${MANIFEST_FILE}:\n${formatValidationError(validated.error)}`);
  }
  writeFileAtomic(root, MANIFEST_FILE, JSON.stringify(validated.data, null, 2) + "\n");
}
