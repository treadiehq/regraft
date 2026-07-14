import { basename } from "node:path";
import { sha256 } from "./hash";
import type { Graft, Manifest } from "./manifest";

export const GRAFT_NAME_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
export const GRAFT_ID_RE = /^g_[0-9a-f]{16}$/;

export function createGraftId(input: {
  url: string;
  remoteRef: string;
  path: string;
  dest: string;
}): string {
  return `g_${sha256(["regraft-graft-v2", input.url, input.remoteRef, input.path, input.dest].join("\0")).slice(0, 16)}`;
}

export function normalizeGraftName(value: string): string {
  return value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/\.[^.]+$/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function deriveGraftName(dest: string): string {
  const candidate = normalizeGraftName(basename(dest));
  return candidate && /^[a-z]/.test(candidate) ? candidate : `graft-${candidate || "source"}`;
}

export function uniqueGraftName(base: string, existing: ReadonlySet<string>): string {
  if (!existing.has(base)) return base;
  let suffix = 2;
  while (existing.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

export function validateGraftName(name: string): void {
  if (!GRAFT_NAME_RE.test(name) || name.length > 63) {
    throw new Error(
      `Invalid Graft name "${name}". Use 1-63 lowercase letters, numbers, and single hyphens, starting with a letter.`,
    );
  }
}

function portablePathKey(path: string): string {
  return path.normalize("NFC").replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/+$/, "").toLowerCase();
}

export function destinationsOverlap(left: string, right: string): boolean {
  const a = portablePathKey(left);
  const b = portablePathKey(right);
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

export function assertDestinationAvailable(grafts: readonly Graft[], dest: string, exceptId?: string): void {
  const owner = grafts.find((graft) => graft.id !== exceptId && destinationsOverlap(graft.dest, dest));
  if (owner) {
    throw new Error(
      `Destination "${dest}" overlaps Graft "${owner.name}" at "${owner.dest}". ` +
        "Each project path can belong to only one Graft.",
    );
  }
}

export function resolveGrafts(manifest: Manifest, selectors?: readonly string[]): Graft[] {
  if (!selectors || selectors.length === 0) return [...manifest.grafts];
  const selected = new Set<string>();
  for (const selector of selectors) {
    const graft = manifest.grafts.find((candidate) => candidate.name === selector || candidate.id === selector);
    if (!graft) {
      const known =
        manifest.grafts.map((candidate) => `  ${candidate.name} [${candidate.id}] → ${candidate.dest}`).join("\n") ||
        "  (none)";
      throw new Error(`No Graft named or identified by "${selector}". Known Grafts:\n${known}`);
    }
    selected.add(graft.id);
  }
  return manifest.grafts.filter((graft) => selected.has(graft.id));
}
