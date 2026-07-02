---
name: regraft
description: Work safely with vendored upstream code tracked by regraft. Use when the repo contains regraft.json or PATCH.md, when modifying files under a regraft-tracked directory, when pulling upstream updates, or when resolving merge conflicts from a regraft reconciliation brief.
---

# Working in a repo that uses regraft

This repo vendors files from upstream git repos and tracks them with `regraft`
(manifest: `regraft.json`, intent journal: `PATCH.md`). regraft handles the
mechanics (fetching, hashing, three-way merging); **you** handle semantic
reconciliation when merges conflict. Every command supports `--json` for
machine-readable output and exits 0 on clean/success, 1 on drift/stale/conflict/error.

## Rule 1: run `regraft status` first

Before touching anything, run:

```bash
regraft status --json
```

Per file you will see one of: `clean`, `modified+intent`, `modified-unrecorded`,
`missing`, `conflict-unresolved`. Per source, `stale: true` means upstream has new
commits. Exit code 1 means something needs attention before or alongside your task.
Add `--offline` to skip the upstream checks (no network; `stale` becomes `null`).

## Rule 2: after modifying tracked files, ALWAYS record intent

If you edit any file tracked in `regraft.json` (deliberately, as part of your
task), record what you changed and why immediately after:

```bash
regraft note "Added retry with exponential backoff to the fetch wrapper because our API rate-limits aggressively" --files lib/utils.ts
```

- Write the description for a future agent who must re-apply this change on top of
  different upstream code: say what the customization does and why it exists, not
  just which lines moved.
- Run `regraft diff` (optionally with file paths) first to see exactly what
  changed against the vendored baseline — write the note from that, not from
  memory.
- Without `--files`, regraft snapshots every modified tracked file not already
  covered — fine after a focused edit, but prefer explicit `--files` when you
  changed several things.
- Skipping this leaves files `modified-unrecorded`, which fails `regraft status`
  (and therefore CI).

## Pulling upstream updates

```bash
regraft pull --json
```

- To preview what a pull would bring in, run `regraft diff --upstream` (full
  per-file diffs) or `regraft pull --dry-run` (the plan).
- Unmodified files fast-forward; modified files with non-overlapping upstream
  changes merge silently. Only true conflicts need you.
- On conflict, the JSON contains `"conflicts": true` and a `"brief"` path like
  `.regraft/briefs/2026-07-02T14-22-57.230Z.md`. Files with conflicts get inline
  diff3 markers and are listed per source under `conflicts`.
- `--dry-run` previews without writing. `--force` discards local changes in
  conflicting files (destructive — only when explicitly asked).
- The JSON also lists `unrecordedModifications`: tracked files modified without a
  recorded intent at pull time. It never affects the exit code, but record those
  intents (`regraft note ... --files ...`) — briefs can only include recorded context.

## Resolving conflicts from a brief

The brief contains everything you need: the conflicted files, the FULL text of
every intent covering them, the upstream commit log for the range, and
instructions. Workflow:

1. Read the brief top to bottom.
2. Open each conflicted file. Markers are diff3 style:
   - `<<<<<<< local` … local customized version
   - `||||||| base` … the old upstream version both sides started from
   - `>>>>>>> upstream` … the new upstream version
3. **Rebuild what each intent set out to do on top of the new upstream code.** Do
   not blindly keep the local side: upstream may have restructured; the intent
   tells you what the customization must still accomplish.
4. Handle warnings (binary conflicts, files deleted upstream but modified locally)
   by deciding explicitly: keep local, take upstream, or delete.
5. Remove ALL conflict markers.
6. Finish with:

```bash
regraft resolve --note "Re-applied <intent summary> on top of upstream's <what changed>"
```

`resolve` verifies markers are gone (it errors listing offenders otherwise) and
records the resolution intent in one step. If you forgot `--note`, the resolution
is still saved, but it exits 1 and prints the exact `regraft note ... --files ...`
command to run — run it to finish.

7. Verify with `regraft status` — the affected source's files must all be `clean`
   or `modified+intent`.

## Other operations

- Vendor something new: `regraft add owner/repo/tree/main/src/lib vendor/lib`
  (also accepts blob URLs for single files, full GitHub URLs, `owner/repo/pull/<n>`
  for PR heads, and any git URL with `#ref:subpath`). Several sources can go in
  one call (each to its default dest). Then customize, then `note`.
- Start tracking code that was vendored by hand before regraft existed:
  `regraft add <source> <dest> --adopt`. Existing differing files are kept
  as-is and classify as `modified-unrecorded` — immediately record why they
  differ with `regraft note` (use `regraft diff` to see the delta).
- Stop tracking: `regraft remove <query>` where the query is a substring of the
  source URL or its local dest (add `--hard` to delete files). Intent history is
  kept and marked orphaned in PATCH.md.

## Never do

- Never edit `PATCH.md` by hand — it is regenerated from `regraft.json`.
- Never edit `regraft.json` by hand unless a command's error message tells you to.
- Never leave a tracked file modified without a `regraft note` entry.
- Never re-run `regraft pull` to "fix" unresolved conflicts — unresolved files are
  skipped until you run `regraft resolve`.
