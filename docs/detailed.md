# regraft — detailed reference

The [README](../README.md) covers the idea and the loop. This document goes
deep: the classification model, every command, source syntax, JSON shapes,
file formats, exit codes, and development notes.

## The two-layer model

**1. Mechanical layer** — a committed manifest (`regraft.json`) records, per source:
the upstream URL, the pinned commit SHA you last reconciled against, and a SHA-256
hash of every file as regraft last wrote it. Comparing three states — the *stored*
hash, the *disk* hash, and the *upstream* content — classifies every file
deterministically:

| stored vs disk | upstream at pinned vs new SHA | pull behavior |
| --- | --- | --- |
| equal (no local edits) | changed | fast-forward to upstream (write/delete to match) |
| differ (local edits) | unchanged | leave alone |
| differ (local edits) | changed | three-way merge (`git merge-file --diff3`) |
| — | file deleted upstream, locally modified | keep local copy, warn, add to brief |

Non-overlapping changes merge silently. Only true conflicts produce inline diff3
markers (`<<<<<<< local` / `||||||| base` / `>>>>>>> upstream`) at the conflict
site. Binary files are tracked by hash, fast-forwarded when unmodified, and never
merged — conflicting binaries are skipped with a warning and reported in the brief.

**2. Intent layer** — every deliberate local customization is recorded as a
plain-English entry (`regraft note "..."`): what was changed and why. Entries live
in the manifest and are rendered into a generated, committed `PATCH.md`. When a
merge conflicts, the resolver gets the reasoning behind each local change, not
just the diff, so it can rebuild the change on top of the new upstream code.

Intent integrity is **enforced**: recording an entry snapshots the disk hash of each
covered file, and `regraft status` classifies every locally modified tracked file
as either `modified+intent` (disk hash matches a snapshot) or `modified-unrecorded`
(fails the exit code). That is what keeps PATCH.md trustworthy over time.

## Files regraft manages

| File | Committed | Purpose |
| --- | --- | --- |
| `regraft.json` | yes | The manifest — single source of truth, validated with zod on read |
| `PATCH.md` | yes | Generated intent journal (human/agent-readable view of the manifest) |
| `.regraft/` | no | Working dir: `cache/` (git clones), `briefs/` (reconciliation briefs). regraft writes `.regraft/.gitignore` containing `*` so you never have to think about it |

Fetching is **git-native**: upstreams are fetched with your own `git` into
`.regraft/cache/`, so it works with private repos through your existing git auth
and with any git remote (GitHub, GitLab, self-hosted, even `file://`). `git`
must be on PATH; regraft fails fast with a clear error if it is missing.

## Accepted source forms

```text
owner/repo                                   whole repo, default branch
owner/repo#ref                               whole repo at a branch/tag
owner/repo/tree/<ref>/<path>                 directory
owner/repo/blob/<ref>/<file>                 single file
owner/repo/pull/<number>                     whole repo at the PR head (a live ref)
https://github.com/owner/repo[...]           same four forms as web URLs
<git-url>#<ref>                              any git remote at a ref
<git-url>#<ref>:<subpath>                    any git remote, ref + subpath
<git-url>#:<subpath>                         default branch + subpath
```

`<git-url>` may be `https://`, `ssh://`, `file://`, or scp-style
(`git@host:repo.git`). Note for `/tree/` and `/blob/` forms: the ref is taken as a
single path segment, so branch names containing `/` need the `#<ref>:<subpath>`
syntax instead.

The `/pull/<number>` form tracks `refs/pull/<number>/head` — a PR head is a
branch that moves as the author pushes, so `pull` keeps following it. (This is
different from applying a PR's diff once; that job belongs to git.)

## Command reference

All commands are non-interactive (missing args produce an immediate error plus
usage/examples), idempotent (running twice is a no-op or an explicit "already
done"), have `--help` with an Examples section, and support `--json`.

### `regraft add <source...> [dest]`

Vendor and start tracking. Per file: doesn't exist → write; exists untracked with
different content → skip (needs `--force` or `--adopt`); exists and identical →
track silently. Records the source with the pinned SHA (resolved HEAD of the ref)
and per-file hashes. Supports `--dry-run`. Default dest: basename of the upstream
path, or the repo name for repo roots.

Several sources can be added in one call, each landing in its default dest. The
last argument is treated as the dest only when it is a plain path (no URL scheme,
no `#ref`, no `/tree/`, `/blob/`, or `/pull/` segment), and a dest is only
allowed with a single source.

`--adopt` is for code you vendored by hand before using regraft: files that
already exist with different content are tracked as-is instead of skipped.
Nothing on disk is overwritten; the stored baseline is upstream's content at the
pinned SHA, so your existing edits immediately classify as local modifications —
record why with `regraft note`. (`--force` and `--adopt` are mutually
exclusive: one overwrites, the other keeps.)

### `regraft diff [files...]`

No writes to the project. Shows unified diffs of every modified tracked file
against its vendored baseline (the upstream content at the pinned SHA), so you
can see exactly what you changed — most useful right before writing a note.
Missing files are listed without a diff; binary files are flagged and not
diffed. For files that were resolved after a conflict, the baseline is still
the pinned upstream content, so the diff shows your full customization.

`--upstream` flips direction: it compares upstream at the pinned SHA against
the current remote head, per file — what a `pull` would bring in, shown as
`modified` / `added` / `deleted` entries. Exits 1 when there are differences,
0 when there are none (like `git diff`).

### `regraft note "<what and why>"`

Record intent AFTER customizing. Default file set: every tracked file whose disk
hash differs from the stored hash and is not already covered by an intent snapshot
at its current hash. Use `--files <paths...>` to scope explicitly (explicit files
may be snapshotted even if unmodified). Refuses when there is nothing to cover.
Snapshots current disk hashes, appends the entry, and regenerates `PATCH.md`.

### `regraft status`

No writes. Checks each upstream ref for a new SHA and classifies every file:
`clean` / `modified+intent` / `modified-unrecorded` / `missing` /
`conflict-unresolved`. Exits 1 if anything is stale, unrecorded, missing, or
unresolved — run it in CI to catch drift before it compounds.

`--offline` skips the upstream checks entirely (no network, and `git` is not
invoked): `upstreamSha` and `stale` are reported as `null` per source, and the
exit code reflects local state only.

### `regraft pull`

The core. Per source: if the pinned SHA equals the upstream SHA, skip. Otherwise
each file is handled per the classification table above. On conflict, diff3 markers
are written in place, the file is added to the source's `unresolved` list (and
**skipped on subsequent pulls** until resolved, so markers never stack), and a
reconciliation brief is generated at `.regraft/briefs/<timestamp>.md` containing:

- the conflicted file list,
- the FULL text of every intent whose files intersect the conflicts,
- the upstream commit log between the old and new SHA scoped to the source path,
- explicit instructions for the resolving agent.

The pinned SHA advances either way. `--force` takes upstream wholesale for
conflicting files; `--dry-run` reports the plan and writes nothing.

Before merging, pull also lists tracked files that are modified but not covered
by any intent (`unrecordedModifications` in `--json`). This is a heads-up, never
a failure — it exists because a brief can only include intent context that was
recorded, so it prints the exact `regraft note ... --files ...` command to run.

### `regraft resolve [files...]`

Run after the agent/human fixes conflicts. Verifies no markers remain (errors
listing offenders otherwise), clears the files from `unresolved` (default: all of
them), and sets stored hash = disk hash. If the resolved content is not covered
by an intent snapshot it exits 1 — the resolution itself **has succeeded** and is
saved; the exit code only signals the one remaining step (record the intent, and
the output prints the exact command). Pass `--note "<description>"` to do both
in one step.

### `regraft remove <query> [--hard]`

Untrack. The query is a substring match against each source's URL **or** its
local dest, so `regraft remove lib/components` works as naturally as
`regraft remove owner/repo`. Errors with the tracked list when nothing matches,
or with the matching list when ambiguous. `--hard` also deletes the files.
Intent entries are kept as history and marked *orphaned* in PATCH.md.

### `regraft completion <shell>`

Prints a completion script for `bash`, `zsh`, or `fish` covering all commands
and their flags:

```bash
echo 'eval "$(regraft completion bash)"' >> ~/.bashrc
regraft completion zsh > ~/.zfunc/_regraft                     # fpath+=(~/.zfunc) before compinit
regraft completion fish > ~/.config/fish/completions/regraft.fish
```

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | clean / success / already done |
| `1` | drift, stale, conflict, or error (`status`: anything stale/unrecorded/missing/unresolved; `pull`: any conflict or warning; `resolve`: markers remain or resolution intent missing; `add`: any file skipped; `diff`: any difference found) |

## JSON output shapes

Every command accepts `--json` and prints exactly one JSON object to stdout.
Errors in `--json` mode print `{ "error": "<message>", "exitCode": 1 }`.
All paths are project-root-relative. Agents can pattern-match on these shapes;
they are stable.

### `regraft add --json`

```json
{
  "command": "add",
  "exitCode": 0,
  "dryRun": false,
  "alreadyTracked": false,
  "source": {
    "url": "https://github.com/owner/repo.git",
    "remoteRef": "main",
    "path": "src/components",
    "dest": "lib/components",
    "pinnedSha": "<40-hex>"
  },
  "written": ["lib/components/button.tsx"],
  "identical": ["lib/components/index.ts"],
  "adopted": [],
  "skipped": [{ "path": "lib/components/theme.ts", "reason": "exists with different content (re-run with --force to overwrite, or --adopt to keep it)" }]
}
```

`adopted` lists existing differing files tracked as local modifications
(`--adopt`). With several sources in one call, the output is instead
`{ "command": "add", "exitCode": 0|1, "dryRun": bool, "results": [...] }` where
each item of `results` has the single-source shape above.

### `regraft diff --json`

```json
{
  "command": "diff",
  "exitCode": 1,
  "upstream": false,
  "sources": [
    {
      "url": "https://github.com/owner/repo.git",
      "remoteRef": "main",
      "path": "src/components",
      "dest": "lib/components",
      "pinnedSha": "<40-hex>",
      "upstreamSha": null,
      "files": [
        {
          "path": "lib/components/theme.ts",
          "change": "modified",
          "binary": false,
          "diff": "diff --git a/lib/components/theme.ts b/lib/components/theme.ts\n...",
          "note": null
        }
      ]
    }
  ]
}
```

Only files with differences appear. `change` is `modified` or `missing` in
local mode; `modified`, `added`, or `deleted` with `--upstream` (where
`upstreamSha` is the resolved remote head). `diff` is empty for binary or
missing files, with `note` explaining why.

### `regraft note --json`

```json
{
  "command": "note",
  "exitCode": 0,
  "intent": {
    "id": "a1b2c3d4",
    "date": "2026-07-02T14:00:00.000Z",
    "description": "Replaced default theme tokens with our brand palette",
    "files": { "lib/components/theme.ts": "<sha256>" }
  }
}
```

### `regraft status --json`

```json
{
  "command": "status",
  "exitCode": 1,
  "offline": false,
  "clean": false,
  "stale": true,
  "drifted": true,
  "sources": [
    {
      "url": "https://github.com/owner/repo.git",
      "remoteRef": "main",
      "path": "src/components",
      "dest": "lib/components",
      "pinnedSha": "<40-hex>",
      "upstreamSha": "<40-hex>",
      "stale": true,
      "files": [
        { "path": "lib/components/button.tsx", "status": "clean" },
        { "path": "lib/components/theme.ts", "status": "modified+intent" }
      ]
    }
  ]
}
```

File `status` is one of `clean`, `modified+intent`, `modified-unrecorded`,
`missing`, `conflict-unresolved`. `stale` = some source's upstream ref moved past
its pinned SHA. `drifted` = some tracked file differs from its stored hash
(including intent-covered ones). `clean` = neither. With `--offline`, per-source
`upstreamSha` and `stale` are `null` and the top-level `stale` is always `false`.

### `regraft pull --json`

```json
{
  "command": "pull",
  "exitCode": 1,
  "dryRun": false,
  "conflicts": true,
  "brief": ".regraft/briefs/2026-07-02T14-22-57.230Z.md",
  "unrecordedModifications": ["lib/components/local-hack.ts"],
  "sources": [
    {
      "url": "https://github.com/owner/repo.git",
      "remoteRef": "main",
      "dest": "lib/components",
      "oldSha": "<40-hex>",
      "newSha": "<40-hex>",
      "upToDate": false,
      "added": ["lib/components/new-widget.tsx"],
      "fastForwarded": ["lib/components/index.ts"],
      "merged": ["lib/components/button.tsx"],
      "forced": [],
      "deleted": ["lib/components/legacy.ts"],
      "conflicts": ["lib/components/theme.ts"],
      "skipped": [{ "path": "lib/components/old-conflict.ts", "reason": "unresolved conflict from a previous pull; run `regraft resolve` first" }],
      "warnings": [{ "path": "lib/components/logo.png", "message": "binary file changed both locally and upstream; kept the local version (re-run with --force to take upstream)" }]
    }
  ]
}
```

`brief` is `null` when there was nothing to reconcile (or with `--dry-run`).
`unrecordedModifications` lists tracked files that were locally modified without
a recorded intent at pull time — informational only, it never affects the exit code.

### `regraft resolve --json`

```json
{
  "command": "resolve",
  "exitCode": 0,
  "resolved": ["lib/components/theme.ts"],
  "markersRemain": [],
  "needsNote": [],
  "note": {
    "id": "e5f6a7b8",
    "date": "2026-07-02T15:00:00.000Z",
    "description": "Re-applied brand palette on top of upstream's new token system",
    "files": { "lib/components/theme.ts": "<sha256>" }
  }
}
```

When markers are still present: `exitCode` 1, `markersRemain` lists the offenders,
nothing changes. When resolved without `--note` and uncovered: `exitCode` 1,
`needsNote` lists the files, `note` is `null` (state IS updated; record the intent
with `regraft note "<why>" --files <paths>`).

### `regraft remove --json`

```json
{
  "command": "remove",
  "exitCode": 0,
  "hard": true,
  "removed": {
    "url": "https://github.com/owner/repo.git",
    "remoteRef": "main",
    "path": "src/components",
    "dest": "lib/components"
  },
  "deletedFiles": ["lib/components/button.tsx"]
}
```

## The manifest (`regraft.json`)

```json
{
  "version": 1,
  "sources": [
    {
      "url": "https://github.com/owner/repo.git",
      "remoteRef": "main",
      "path": "src/components",
      "dest": "lib/components",
      "pinnedSha": "<40-hex>",
      "files": { "button.tsx": "<sha256>", "theme.ts": "<sha256>" },
      "unresolved": ["theme.ts"]
    }
  ],
  "intents": [
    {
      "id": "a1b2c3d4",
      "date": "2026-07-02T14:00:00.000Z",
      "description": "Replaced default theme tokens with our brand palette",
      "files": { "lib/components/theme.ts": "<sha256>" }
    }
  ]
}
```

`sources[].files` keys are relative to `dest`; the key `""` means dest itself is
the file (single-file sources). `intents[].files` keys are project-root-relative.
The manifest is the source of truth; `PATCH.md` is regenerated from it.

## Scope

regraft tracks live refs — branches, tags, and PR heads that keep moving.

One-shot jobs like applying a single commit or a `.patch` file are left to git
(`cherry-pick`, `apply`, `am`). Registries, line-range tracking, and post-pull
hooks are also out of scope: regraft is not trying to be a package manager.

There is no authentication code at all. Fetching uses your existing git
credentials, which is what lets regraft work with any host your git can already
reach.

## Development

```bash
pnpm install
pnpm lint       # tsc --noEmit (strict)
pnpm test       # vitest watch
pnpm test:run   # single run
pnpm build      # tsup -> dist/cli.js
```

Layering is one-way: `src/cli.ts` (commander wiring) → `src/commands/*` (one file
per command, no printing) → `src/core/*` (pure logic, never prints, throws on
failure) → `src/ui/*` (all output). Integration tests build local `file://` git
fixture repos in temp dirs.
