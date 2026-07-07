# regraft detailed reference

The [README](../README.md) covers the idea and the basic loop. This page is the
full reference: how regraft decides what changed, every command and flag, source
syntax, JSON output, file formats, exit codes, and development notes.

## How regraft works

**1. File tracking** — `regraft.json` records each source, the upstream commit
you last pulled from, and a SHA-256 hash for every tracked file. To decide what
to do next, regraft compares three things: the stored hash, the file on disk, and
the latest upstream content.

| stored vs disk | upstream at pinned vs new SHA | pull behavior |
| --- | --- | --- |
| equal (no local edits) | changed | fast-forward to upstream (write/delete to match) |
| differ (local edits) | unchanged | leave alone |
| differ (local edits) | changed | three-way merge (`git merge-file --diff3`) |
| — | file deleted upstream, locally modified | keep local copy, warn, add to brief |

Changes that do not overlap merge quietly. Real conflicts get normal diff3
markers (`<<<<<<< local` / `||||||| base` / `>>>>>>> upstream`) where the
conflict happened. Binary files are tracked by hash and updated when untouched,
but never merged. If a binary changed on both sides, regraft keeps your copy,
prints a warning, and adds it to the brief.

**2. Notes** — every deliberate local change gets a plain-language note
(`regraft note "..."`) that says what changed and why. Notes live in
`regraft.json` and are rendered into the committed `PATCH.md`. When a merge
conflicts, the person or agent fixing it gets the reason for your change, not
just the diff.

regraft also checks that notes stay honest. When you record a note, regraft saves
the current hash of each covered file. Later, `regraft status` marks each local
change as either `modified+intent` (covered by a note) or
`modified-unrecorded` (not covered, exits 1).

## Files regraft manages

| File | Committed | Purpose |
| --- | --- | --- |
| `regraft.json` | yes | Source of truth, validated with zod on read |
| `PATCH.md` | yes | Generated note journal for people and agents |
| `.regraft/` | no | Working directory for `cache/` git clones and `briefs/` conflict briefs. regraft ignores it for you |

regraft fetches with your own `git` into `.regraft/cache/`. That means private
repos work through your existing git auth, and any git remote works: GitHub,
GitLab, self-hosted, or `file://`. `git` must be on PATH; if it is missing,
regraft stops with a clear error.

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

All commands are safe to script. Missing args fail right away with usage and
examples. Running the same command twice is either a no-op or says "already
done". Every command has `--help` with examples, and every command except
`update` supports `--json`.

### `regraft add <source...> [dest]`

Copy code into your project and start tracking it. For each file:
doesn't exist → write it; exists with different content → skip it unless you pass
`--force` or `--adopt`; exists and identical → track it without writing. regraft
records the source, the resolved upstream commit, and each file hash. Supports
`--dry-run`. The default destination is the upstream path basename, or the repo
name for repo roots.

You can add several sources in one call. Each one lands in its default
destination. The last argument is treated as the destination only when it is a
plain path (no URL scheme, no `#ref`, no `/tree/`, `/blob/`, or `/pull/`
segment). A custom destination is only allowed with one source.

Use `--adopt` for code you already copied by hand. Files that already exist with
different content are kept as-is and tracked as local changes. Nothing on disk is
overwritten. Record why those files differ with `regraft note`. `--force` and
`--adopt` cannot be used together: one overwrites, the other keeps.

### `regraft diff [files...]`

No writes. Shows what changed locally compared with the upstream content you
copied from. This is most useful right before writing a note. Missing files are
listed without a diff. Binary files are marked but not diffed. For files fixed
after a conflict, the comparison is still against pinned upstream content, so the
diff shows your full local change.

`--upstream` shows what changed upstream since your pin: the files a future
`regraft pull` would bring in. It reports `modified`, `added`, and `deleted`
entries. Like `git diff`, it exits 1 when there are differences and 0 when
there are none.

### `regraft note "<what and why>"`

Run this after you change copied code. By default, regraft records every tracked
file that changed and is not already covered by a note. Use `--files <paths...>`
to choose files yourself. regraft saves the current file hashes, appends the
note, and regenerates `PATCH.md`. It refuses when there is nothing new to record.

### `regraft status`

No writes. Checks whether upstream moved and labels every file as `clean`,
`modified+intent`, `modified-unrecorded`, `missing`, or `conflict-unresolved`.
Exits 1 when anything needs attention: new upstream commits, unrecorded local
changes, missing files, or unresolved conflicts. This makes it useful in CI.

`--offline` skips upstream checks. It does not use the network or run `git`.
`upstreamSha` and `stale` are `null` for each source, and the exit code reflects
local files only.

### `regraft pull`

Pull new upstream code. If a source is already at the latest upstream commit,
regraft skips it. Otherwise, each file follows the table above. On conflict,
regraft writes diff3 markers in place, marks the file as unresolved, and skips it
on later pulls until you resolve it. That keeps conflict markers from stacking.
If upstream changes or deletes a file that still has unresolved conflict markers,
regraft emits a warning (e.g., "upstream changed this file while it had an
unresolved conflict; skipped until resolved"). It also writes a brief at
`.regraft/briefs/<timestamp>.md` with:

- the conflicted files,
- the full text of every relevant note,
- the upstream commit log between the old and new commit, scoped to the source path,
- clear instructions for the person or agent fixing the conflict.

The pinned commit advances either way. `--force` takes the upstream version for
conflicting files. `--dry-run` reports the plan and writes nothing.

Before merging, `pull` also lists tracked files that changed locally without a
note (`unrecordedModifications` in `--json`). This is a heads-up, not a failure.
Briefs can only explain notes you recorded, so the output prints the exact
`regraft note ... --files ...` command to run.

### `regraft resolve [files...]`

Run this after conflicts are fixed. regraft checks that no conflict markers
remain, clears the files from `unresolved`, and saves the new file hashes. If the
fixed content is not covered by a note, the command exits 1 after saving the
resolution. That exit code means one step remains: record why. Pass
`--note "<description>"` to resolve and record the note in one step.

### `regraft remove <query> [--hard]`

Untrack. The query is a substring match against each source's URL **or** its
local dest, so `regraft remove lib/components` works as naturally as
`regraft remove owner/repo`. Errors with the tracked list when nothing matches,
or with the matching list when ambiguous. `--hard` also deletes the files.
Intent entries are kept as history and marked *orphaned* in PATCH.md.

### `regraft update [version]`

Updates regraft itself. A standalone binary install re-runs the public
installer (downloading the given release tag, default latest); a git checkout
is fetched and rebuilt in place (refusing if the checkout is dirty); a
package-manager install is left to npm/pnpm with a hint. This command streams
installer output and does not take `--json`.

### `regraft completion <shell>`

Prints a completion script for `bash`, `zsh`, or `fish` covering all commands
and their flags:

```bash
echo 'eval "$(regraft completion bash)"' >> ~/.bashrc
regraft completion zsh > ~/.zfunc/_regraft                     # fpath+=(~/.zfunc) before compinit
regraft completion fish > ~/.config/fish/completions/regraft.fish
```

Accepts `--json` to print the script in JSON format instead.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | clean / success / already done |
| `1` | drift, stale, conflict, or error (`status`: anything stale/unrecorded/missing/unresolved; `pull`: any conflict or warning; `resolve`: markers remain or resolution intent missing; `add`: any file skipped; `diff`: any difference found) |

## JSON output shapes

Every command except `update` accepts `--json` and prints one JSON object to
stdout. Errors in `--json` mode print `{ "error": "<message>", "exitCode": 1 }`.
All paths are relative to the project root. These shapes are stable, so scripts
and agents can rely on them.

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

`adopted` lists existing files kept as local changes (`--adopt`). With several
sources in one call, the output is instead
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
      "warnings": [
        { "path": "lib/components/old-conflict.ts", "message": "upstream changed this file while it had an unresolved conflict; skipped until resolved" },
        { "path": "lib/components/logo.png", "message": "binary file changed both locally and upstream; kept the local version (re-run with --force to take upstream)" }
      ]
    }
  ]
}
```

`brief` is `null` when no conflict brief was needed, or when `--dry-run` was
used. `unrecordedModifications` lists tracked files that were changed locally
without a note at pull time. It is informational only and never affects the exit
code.

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

When markers are still present, `exitCode` is 1, `markersRemain` lists the files,
and nothing changes. When files are resolved without `--note` and the new content
is not covered by a note, `exitCode` is 1, `needsNote` lists the files, and
`note` is `null`. The state is still updated; finish with
`regraft note "<why>" --files <paths>`.

### `regraft completion --json`

```json
{
  "command": "completion",
  "exitCode": 0,
  "shell": "zsh",
  "script": "#compdef regraft\n..."
}
```

`shell` is one of `bash`, `zsh`, or `fish`. `script` contains the full completion
script for that shell.

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

`sources[].files` keys are relative to `dest`. The key `""` means the destination
itself is the file, which happens for single-file sources. `intents[].files` keys
are relative to the project root. `regraft.json` is the source of truth;
`PATCH.md` is regenerated from it.

## Scope

regraft tracks live refs: branches, tags, and PR heads that can keep moving.

One-time jobs, like applying a single commit or a `.patch` file, are left to git
(`cherry-pick`, `apply`, `am`). Registries, line-range tracking, and post-pull
hooks are also out of scope. regraft is not trying to be a package manager.

regraft has no authentication code. Fetching uses your existing git credentials,
so regraft works with any host your git can already reach.

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
