import { readFileSync } from "node:fs";
import { parseDocument } from "yaml";
import { z } from "zod";
import { GRAFT_NAME_RE } from "./grafts";

export const PUBLISHED_MANIFEST_FILE = "regraft.yaml";
export const MAX_PUBLISHED_MANIFEST_BYTES = 256 * 1024;

const publishedPathSchema = z.string().transform((value, ctx) => {
  const trimmed = value.trim();
  if (trimmed === ".") return "";
  if (
    trimmed === "" ||
    trimmed.startsWith("/") ||
    trimmed.endsWith("/") ||
    trimmed.includes("\\") ||
    trimmed.includes("//") ||
    trimmed.split("/").some((part) => part === "." || part === "..")
  ) {
    ctx.addIssue({
      code: "custom",
      message: 'must be a canonical repository-relative POSIX path (use "." for the repository root)',
    });
    return z.NEVER;
  }
  return trimmed;
});

const descriptionSchema = z
  .string()
  .trim()
  .min(1)
  .max(300)
  .refine((value) => !/[\r\n]/.test(value), "must be a single line");

const publishedGraftSchema = z
  .object({
    path: publishedPathSchema,
    description: descriptionSchema,
  })
  .strict();

export const publishedManifestSchema = z
  .object({
    version: z.literal(1),
    grafts: z.record(z.string().regex(GRAFT_NAME_RE).max(63), publishedGraftSchema),
  })
  .strict()
  .superRefine((manifest, ctx) => {
    const count = Object.keys(manifest.grafts).length;
    if (count < 1 || count > 256) {
      ctx.addIssue({ code: "custom", path: ["grafts"], message: "must contain between 1 and 256 Grafts" });
    }
  });

export type PublishedManifest = z.infer<typeof publishedManifestSchema>;
export type PublishedGraft = z.infer<typeof publishedGraftSchema>;

function formatIssues(error: z.ZodError): string {
  return error.issues.map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`).join("\n");
}

export function parsePublishedManifest(text: string, source = PUBLISHED_MANIFEST_FILE): PublishedManifest {
  if (Buffer.byteLength(text, "utf8") > MAX_PUBLISHED_MANIFEST_BYTES) {
    throw new Error(`${source} exceeds the ${MAX_PUBLISHED_MANIFEST_BYTES / 1024} KiB size limit.`);
  }
  const document = parseDocument(text, {
    version: "1.2",
    schema: "core",
    strict: true,
    stringKeys: true,
    uniqueKeys: true,
    merge: false,
    resolveKnownTags: false,
  });
  if (document.errors.length > 0) {
    throw new Error(`${source} is not valid YAML:\n${document.errors.map((error) => `  - ${error.message}`).join("\n")}`);
  }
  if (document.warnings.length > 0) {
    throw new Error(
      `${source} uses unsupported YAML features:\n${document.warnings.map((warning) => `  - ${warning.message}`).join("\n")}`,
    );
  }
  if (document.directives.docEnd || document.directives.docStart) {
    throw new Error(`${source} must contain exactly one plain YAML document.`);
  }
  let value: unknown;
  try {
    value = document.toJS({ maxAliasCount: 0 });
  } catch (error) {
    throw new Error(`${source} uses unsupported YAML aliases or tags: ${(error as Error).message}`);
  }
  const result = publishedManifestSchema.safeParse(value);
  if (!result.success) {
    throw new Error(`${source} failed validation:\n${formatIssues(result.error)}`);
  }
  return result.data;
}

export function loadPublishedManifestFile(path: string): PublishedManifest {
  return parsePublishedManifest(readFileSync(path, "utf8"), path);
}

export function getPublishedGraft(manifest: PublishedManifest, name: string): PublishedGraft {
  const graft = manifest.grafts[name];
  if (!graft) {
    const available = Object.keys(manifest.grafts).sort().join(", ");
    throw new Error(`Published Graft "${name}" was not found. Available Grafts: ${available || "(none)"}.`);
  }
  return graft;
}
