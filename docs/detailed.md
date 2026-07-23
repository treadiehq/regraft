# Detailed implementation reference

Start with the [Introduction](introduction.md), [Getting started](getting-started.md),
and [Concepts](concepts.md). This document describes implementation behavior.

## Architecture

```text
src/cli.ts
  ├── src/commands/*       command orchestration and result DTOs
  ├── src/core/*           Git, manifests, classification, merge, Briefs
  └── src/ui/output.ts     human-readable output
```

Regraft invokes the installed Git executable synchronously. Bare object caches
live under `.regraft/cache/`; project files are read and written directly.

The dependency direction is one way:

1. `src/cli.ts` defines commands, arguments, options, and JSON error handling.
2. `src/commands/*` orchestrates one operation and returns a result object.
   Project commands do not print; the process-level `update` command is the
   exception and streams its own progress and child-process output.
3. `src/core/*` owns parsing, validation, Git access, hashing, classification,
   merging, persistence, locking, and rollback.
4. `src/ui/output.ts` turns command results into human-readable output.

Important core modules:

- `manifest.ts`: consumer state schemas, v1 migration, and atomic v2 writes
- `grafts.ts`: Graft identity, naming, selection, and destination ownership
- `urls.ts`: Source argument parsing and destination defaults
- `git.ts`: remote resolution and bare object-cache access
- `workspace.ts`: root discovery, safe managed paths, locks, and atomic files
- `journal.ts`: in-memory rollback for bounded project mutations
- `classify.ts`: local file status
- `merge.ts`: deterministic diff3 text merging
- `pending.ts`: hydration of migrated pending Update targets
- `brief.ts`: durable judgment context
- `published-manifest.ts`: strict `regraft.yaml` parsing

## Project root and managed files

Consumer-project commands search upward from the current directory for
`regraft.json`. If none exists, `add` treats the current directory as the new
project root. `validate` resolves its file from the current directory;
`completion` and `update` do not discover a consumer project.

Regraft manages:

- `regraft.json`: validated consumer state and source of truth; commit it
- `PATCH.md`: generated projection of Intent history; commit it
- `.regraft/cache/`: ignored bare Git object caches
- `.regraft/briefs/`: ignored generated Briefs
- `.regraft/operation.lock`: ignored project mutation lock
- `.regraft/.gitignore`: initialized with `*` when absent; Regraft never changes
  an existing file

`PATCH.md` is regenerated from `regraft.json`; editing it directly does not
change Regraft state.

## Graft state model

`regraft.json` version 2 stores `grafts` and `intents`.

A Graft contains:

- deterministic ID derived from Source/ref/path/destination
- unique lowercase name
- Git URL, tracked ref, Source path, and local destination
- pinned revision
- per-file state
- durable exclusions for Source files the Graft never owned
- optional `regraft.yaml` publication metadata

Per-file state separates:

- `upstreamHash`: content at the reconciled Source baseline
- `localHash`: accepted local content, including deterministic merge results
- `intentIds`: active explanations for local derivation
- `needsIntent`: accepted state still lacking rationale
- `pending`: durable Update judgment

Separating the two hashes is essential. A merged local result must not become
the upstream baseline; otherwise a later Update could overwrite the adaptation.

The persisted shape is:

```json
{
  "version": 2,
  "grafts": [
    {
      "id": "g_0123456789abcdef",
      "name": "auth",
      "url": "https://github.com/acme/repo.git",
      "remoteRef": "main",
      "path": "src/auth",
      "dest": "src/auth",
      "pinnedSha": "<40-char Git SHA>",
      "ownership": "complete",
      "excluded": [],
      "files": {
        "session.ts": {
          "upstreamHash": "<SHA-256 or null>",
          "localHash": "<SHA-256 or null>",
          "intentIds": [],
          "needsIntent": false,
          "pending": null
        }
      }
    }
  ],
  "intents": []
}
```

File keys are relative to the Graft destination. The key `""` represents a
single-file Graft whose destination is the file itself. Content hashes are
SHA-256. Pinned revision identifiers are currently validated as 40-character
lowercase Git SHA-1 values.

A pending record contains:

- `kind`
- `fromSha`: previous revision, or `null` for a migrated legacy conflict
- `toSha`: exact target revision
- `targetKnown`: whether target content has been reconstructed
- `targetHash`: target content hash; `null` means a known target deletion when
  `targetKnown` is true, or an unhydrated migrated target when it is false
- `observedLocalHash`: disk state when judgment became pending
- `markerHash`: hash of written conflict markers when applicable
- `brief`: project-relative Brief path, or `null`

Intent entries contain an ID, timestamp, description, and one or more targets.
A current target identifies a Graft ID, Source-relative file key,
project-relative path, and accepted content hash. Removed or ambiguous legacy
targets remain as `legacy-orphan` history.

Validation enforces unique Graft IDs and names, non-overlapping destinations,
canonical project-relative paths, valid Intent references, and consistency
between each file's active `intentIds` and the referenced targets.

## Published Graft state

Publishers commit `regraft.yaml` at the repository root:

```yaml
version: 1

grafts:
  session:
    path: packages/auth/src/session
    description: Session management implementation
```

The schema requires 1–256 Grafts. Names are 1–63 character lowercase
kebab-case identifiers. Paths are canonical repository-relative POSIX paths;
`.` means the repository root. Descriptions are single-line strings of at most
300 characters.

Parsing is deliberately stricter than general YAML:

- the file is limited to 256 KiB
- unknown fields and duplicate keys are rejected
- aliases, merge keys, tags, and multiple documents are rejected
- absolute paths, backslashes, empty segments, `.` segments, and `..` traversal
  are rejected

`regraft validate [file]` applies these rules locally. During
`regraft add ...#graft=name`, Regraft reads `regraft.yaml` from the same resolved
revision as the selected Source, validates it, verifies the selected path
exists, and stores the selected name, description, and manifest version in the Graft.
Existing consumers continue tracking the resolved path; later publication
manifest edits do not silently retarget them.

## Manifest migration

Version 1 stored one ambiguous per-file hash and an `unresolved` path list.
Regraft accepts v1 and constructs v2 in memory:

- Source entries receive deterministic Graft IDs and destination-derived names.
- Stored hashes begin as initial upstream/local state. When current disk content
  matches a legacy Intent snapshot, migration can use that disk hash as the
  accepted local state.
- path-based notes become Graft-scoped Intent where ownership is unambiguous.
- unresolved paths that are also present in the v1 file map become
  `legacy-conflict` pending state.
- migrated Grafts retain `legacy-unknown` ownership because v1 did not record
  skipped Source paths; future new paths require explicit `--force` inclusion
  or local resolution rather than being claimed automatically.
- overlapping destinations prevent migration because ownership cannot be
  inferred safely.

Migration can also fail when otherwise permissive v1 data violates v2
invariants, such as duplicate Intent IDs or empty Intent targets.

The next successful consumer-state write uses version 2 atomically. Read-only
and no-op commands do not rewrite a v1 file. In a multi-Source add, an earlier
successful Source can perform that write even if a later Source makes the
overall invocation exit 1 or throw.

During a later pull, Regraft reads actual content from the pinned Git revision
rather than trusting an ambiguous migrated hash. This preserves previously
merged v1 adaptations.

## Update algorithm

For each file:

- `B`: content at the previous pinned Source revision
- `L`: accepted local state
- `D`: current disk state
- `T`: content at the target Source revision

High-level rules:

1. Pending judgment is handled before contacting a newer upstream revision.
2. If `D == B`, fast-forward to `T`.
3. If `D == T`, accept the manually updated state.
4. If `B == T`, leave local state alone.
5. If both sides changed text, run `git merge-file --diff3`.
6. A clean merge stores `upstreamHash = hash(T)` and
   `localHash = hash(merged)`.
7. Text conflicts, concurrent local/upstream binary changes, deletion
   decisions, and destination collisions become durable `pending` state.
8. `--force` explicitly takes target upstream state.

`L` determines whether a clean merge is already explained. If current disk
content differs from accepted local state, the merged result remains marked as
needing Intent even when the text merge itself is conflict-free.

The Graft pin advances to the target Update. Successful files carry the new
baseline; incomplete files carry their exact transition in pending state.
Dry runs report the same decisions without advancing the pin.

Before processing Grafts, `pull` reports locally modified files that lack
Intent. This is informational: deterministic work can still proceed, but a
resulting Brief can only explain Intent that was already recorded.

New and deleted paths need additional decisions:

- A new upstream file is written when the destination is absent.
- Identical destination content is adopted as clean upstream state.
- Different existing content becomes `destination-collision` unless
  `--force` takes upstream.
- A file that existed in a migrated v1 Source but was not tracked is added to
  durable exclusions.
- A genuinely new path on a `legacy-unknown` Graft becomes
  `ownership-unknown`; Regraft cannot infer whether v1 intentionally skipped it.
- An untouched file deleted upstream is deleted locally.
- A locally adapted file deleted upstream becomes `upstream-deleted`.
- A locally deleted file changed or reintroduced upstream becomes
  `local-deleted`.

Binary content is hashed and fast-forwarded when only upstream changed. Regraft
does not attempt a binary merge when both sides changed. Its binary heuristic
is a NUL byte in the first 8 KiB.

Text merges use the pinned upstream blob as the base, current disk content as
the local side, and target upstream content as the incoming side. Conflicts
write normal diff3 markers with `local`, `base`, and `upstream` labels.

## Pending Update kinds

- `content-conflict`: both text sides changed and diff3 could not merge cleanly
- `binary-conflict`: binary content changed both locally and upstream
- `upstream-deleted`: upstream removed a locally adapted file
- `local-deleted`: the local file is absent while upstream changed or restored it
- `destination-collision`: new upstream content collides with existing local content
- `ownership-unknown`: migrated v1 state cannot prove ownership of a new path
- `legacy-conflict`: unresolved state migrated from a v1 manifest

Plain `pull` repeats pending context without stacking markers. `pull --force`
takes upstream at the recorded target revision. `resolve` accepts the deliberate
disk state and records whether additional Intent is required.

Pending is handled before remote-head lookup. Until judgment is resolved or
forced, a later upstream revision is not layered on top of the unresolved
transition.

`pull` has no pending-file selector. `pull <grafts...> --force` takes upstream
for every pending file in every selected Graft, including deleting a local file
when the recorded target is a deletion. Inspect the selected Grafts first.

## Brief generation

Fresh pending Updates generate a Markdown Brief containing:

- Graft identity
- Source URL and ref
- previous and target revision
- affected files and pending decisions
- Source commit log scoped to the Graft path
- relevant Intent
- resolution instructions

The pending state references the Brief path, and `inspect --json` exposes both.

One Brief can contain sections for several selected Grafts. Each section records
the exact revision transition and a path-scoped upstream commit log. Relevant
Intent is selected from the active Intent IDs of affected files.

If a file has active historical Intent plus a newer unrecorded edit, the Brief
can still include that active Intent. The separate `pull` output reports the
unrecorded file; the Brief does not prove that every current edit is explained.

Content conflicts are listed as files with diff3 markers. Other pending kinds
appear as warnings with an actionable explanation. Re-running plain `pull` on
pending state reuses the recorded Brief path and does not create another Brief.

## Source parsing

Supported forms:

```text
owner/repo
owner/repo#ref
owner/repo#ref:path
owner/repo#:path
owner/repo/tree/ref/path
owner/repo/blob/ref/path
owner/repo/pull/42
https://github.com/owner/repo
https://github.com/owner/repo/tree/ref/path
https://github.com/owner/repo/blob/ref/path
https://github.com/owner/repo/pull/42
https://git.example.com/team/repo.git#ref:path
ssh://git.example.com/team/repo.git#ref:path
git@git.example.com:team/repo.git#ref:path
file:///local/repo#ref:path
owner/repo#graft=name
```

A bare fragment such as `#session` first attempts resolution as a Git ref. If
ref lookup or fetching throws for any reason, Regraft attempts to resolve it as
a published Graft from the default branch. If both attempts fail, the error
reports both failures.

The `/tree/` and `/blob/` forms treat the ref as one URL path segment. Use
`#ref:path` when a branch or tag name contains `/`.

With no explicit ref, Regraft resolves the remote `HEAD` and stores its symbolic
default branch name when the server provides one; otherwise it stores `HEAD`.
A 40-character SHA is pinned directly. GitHub `/pull/<number>` tracks
`pull/<number>/head`, so later pushes to that pull request can appear as
Updates.

## Add behavior

`regraft add <sources...> [destination]` resolves each Source to a concrete Git
revision before recording it. A named annotated tag can retain the tag-object
SHA while Git dereferences it for tree access.

The last positional argument is treated as a destination only when it does not
look like a Source: it has no URL scheme, SCP-style remote form, fragment, or
GitHub `/tree/`, `/blob/`, or `/pull/` segment. An explicit destination and
`--name` are supported only for a single Source.

A trailing bare `owner/repo` is ambiguous to the multi-Source heuristic and is
treated as a destination. Add bare repository shorthands one at a time, or make
each Source unambiguous with a URL, fragment, or GitHub tree/blob/PR form.

Without an explicit destination, Regraft uses the Source path basename, the
published Graft name, or the repository name. Without `--name`, it derives a
lowercase name from the destination and adds a numeric suffix when necessary.
The Graft ID is a truncated SHA-256 over a version marker, URL, resolved ref,
Source path, and destination.

For each Source file:

- missing destination: write and track it
- identical destination: track it without rewriting
- different destination with `--adopt`: keep it and mark it as needing Intent
- different destination with `--force`: overwrite it with upstream
- different destination without either option: fail with a skipped-file result

A single-Source add is atomic across its files: if one file is skipped or a
later write fails, earlier writes from that add are rolled back and no Graft is
saved. In a multi-Source invocation, each Source is a separate bounded add; an
earlier successful Source remains if a later Source fails. A returned
skipped-file result does not stop later Sources; a thrown error does.

Operational cache state is outside this atomic boundary. A failed or dry-run
add can still leave `.regraft/.gitignore` and fetched Git objects.

Adding the exact same URL, resolved ref, path, and destination again is a no-op
that reports the existing Graft. Destination roots cannot overlap another
Graft, including equal, parent/child, case-only, or Unicode-normalization
equivalents.

## Intent and `PATCH.md`

`regraft note "<description>"` records why current local content intentionally
differs.

Without `--files`, it selects tracked files classified
`modified-unrecorded`. This includes unaccepted disk edits and accepted local
state still lacking Intent; it excludes files classified as missing or pending.
With `--files`, every path must be tracked. A missing file can be explicitly
recorded as an intentional deletion with a `null` hash.

Recording Intent:

1. snapshots the current content hash
2. creates an eight-hex-character random Intent ID and ISO timestamp
3. appends Graft-scoped targets
4. updates each file's accepted `localHash`
5. adds the Intent ID and clears `needsIntent`
6. atomically regenerates `regraft.json` and `PATCH.md` within the operation's
   rollback boundary

Historical Intent remains in the manifest and `PATCH.md`. Removing a Graft
converts its targets to `legacy-orphan`. Taking upstream clears active Intent
from the affected file without deleting history.

## Status classification

Local classification follows this exact precedence:

1. `content-conflict` or `legacy-conflict` pending → `conflict-unresolved`
2. any other pending kind → `reconciliation-pending`
3. disk differs from accepted `localHash` → `modified-unrecorded` or `missing`
4. disk equals `upstreamHash` → `clean`
5. accepted local state has active Intent and does not need more → `modified+intent`
6. otherwise → `modified-unrecorded`

Online `status` resolves each tracked remote ref. `--offline` skips Git and
network access and returns `null` for upstream revision and staleness.

The command exits 1 for a stale upstream ref, unrecorded modification, missing
file, conflict, or other pending judgment. An Intent-covered adaptation is
reported as drift from upstream but does not make the command fail.

## Diff behavior

Local `regraft diff` compares disk content with the Source blob at the pinned
revision. This deliberately shows the full derivation from upstream, not merely
changes since the latest recorded Intent. Missing and binary files are reported
without text patches.

`regraft diff --upstream` compares the pinned Source tree with the current
remote head and reports added, modified, and deleted paths. Both forms accept
project-relative file filters and exact Graft names or IDs.

Like `git diff`, either mode exits 1 when differences exist and 0 when none
exist. Local diff may initialize or fetch the bare cache when the pinned revision
is not already available.

## Resolving pending judgment

`regraft resolve [files...]` accepts deliberately reconciled disk state for
pending files. Exact Graft selectors can narrow the operation.

For migrated pending state whose target is not yet known, `resolve` first
hydrates target content from the recorded target revision. For text and legacy
conflicts, it refuses to proceed while recognized conflict markers remain.

When accepted:

- `upstreamHash` becomes the pending target hash
- `localHash` becomes the current disk hash, including `null` for deletion
- pending state is cleared
- matching target content becomes clean and clears active Intent
- a retained local adaptation keeps existing applicable Intent when the disk
  still matches its previously accepted local state
- otherwise the file is saved with `needsIntent` and the command exits 1

`--note` records new Intent in the same rollback-protected operation. Resolving
selected files does not accept or change the disk content of other pending
files. It can, however, hydrate and persist previously unknown target metadata
for every pending file in the selected Grafts before applying the file filter.
Usually the note targets retained adaptations. If none of the selected files
retain an adaptation, the current implementation records the supplied note
against the resolved files even when they match upstream.

## Destination ownership

Each Graft reserves its entire destination root. Equal, parent/child, and
case-only overlaps are rejected for portable behavior across filesystems.

The same Source may be Grafted to multiple disjoint destinations.

## Safety

- manifest-controlled paths reject absolute paths, NUL bytes, and `..`
- persisted paths must already be canonical rather than silently collapsing
  different file identities
- managed paths refuse symlink traversal below the real project root
- `regraft.json` and `PATCH.md` use same-directory temporary files and atomic rename
- project-state-changing commands use `.regraft/operation.lock`
- add, note, pull, resolve, and remove use a rollback journal if a later file,
  Brief, or state write fails
- dry runs do not change tracked project files, consumer manifest state, or
  Briefs
- existing Git authentication is reused; Regraft does not store credentials
- published YAML is size-limited, strictly parsed, and rejects aliases, merge
  keys, tags, duplicate keys, and unknown fields

Git caches may still be created or updated during failed adds, dry runs, local
or upstream diffs, and online inspection. `.regraft/.gitignore` can be created
when absent but is never updated. Dry-run and rollback guarantees apply to
tracked project content and consumer state, not operational caches.

The rollback journal is in memory and protects handled command failures. It is
not a crash-recovery log. If a process is terminated, the lock directory may
remain; the error message tells the user to remove it only after confirming no
Regraft process is running.

Atomic replacement applies to each state file. The surrounding journal restores
both files and any managed content when a later handled step fails.

## Machine-readable compatibility

Existing command result keys such as `source`, `sources`, and Intent `files`
remain for automation compatibility, with additive Graft IDs, names, scoped
Intent targets, and `schemaVersion: 1` JSON envelopes.

`inspect --json` is the canonical machine-readable context summary and includes
`schemaVersion: 1`.

The persisted manifest and machine inspection schema are versioned
independently.

Every command except `update` supports `--json`. Successful command results are
wrapped with top-level `schemaVersion: 1`. Runtime failures and Commander
argument errors also produce a JSON error envelope when `--json` is present.
Human result output and runtime error diagnostics for project commands go
through `src/ui/output.ts`. Commander owns non-JSON help, usage, and argument
diagnostics. The self-update command prints and streams process output directly.

Exit code 1 is contextual:

- `status`: stale upstream or local state requiring attention
- `inspect`: the same attention state reported by its composed status check
- `diff`: differences found
- `pull`: conflict or warning requiring judgment
- `resolve`: markers remain or accepted local state still needs Intent
- other commands: validation or operation failure

`inspect --json` composes status and upstream diff information into:

- Graft identity and Source provenance
- publication metadata and ownership confidence
- pinned and current upstream revisions
- changed upstream files
- local file statuses and durable exclusions
- active Intent
- exact pending transitions and decisions
- Brief paths

`inspect --offline --json` skips remote lookup while retaining local provenance,
Intent, pending state, and Brief context.

## Removal

`regraft remove <selector>` prefers an exact Graft name or ID. For compatibility,
it falls back to a unique substring match against Source URL or destination.
Ambiguous and missing matches fail with the known Graft list.

Without `--hard`, files remain on disk and only tracking is removed. With
`--hard`, Regraft deletes the files recorded in that Graft, prunes empty
directories, and rolls them back if a later state write fails. It does not
delete unrelated untracked files under the destination.

Intent is retained as orphaned history and `PATCH.md` is regenerated.

## Distribution

- Node 20+ source build through tsup
- standalone binaries built through Bun
- x64 and ARM64 binaries for macOS and Linux
- x64 binary for Windows, including ARM64 through emulation
- shell and PowerShell release installers
- `regraft update` updates standalone and source installs, or prints
  package-manager instructions

Graft reconciliation intentionally remains `regraft pull` to avoid overloading
the self-update command.

A standalone self-update reruns the platform installer. A source checkout
refuses to update while dirty, fetches the selected ref, checks out
`FETCH_HEAD`, installs dependencies, and rebuilds. A package-manager install
prints npm and pnpm update suggestions.

Source self-update is not transactional: if dependency installation or the
build fails after checkout, the checkout remains advanced. Repair the
unfinished dependency-installation and build steps manually; a retry at the
same fetched revision can otherwise be reported as already up to date without
running either step.

## Package and release verification

The npm package includes the built CLI, skills, documentation, schemas, the
session-Graft example, changelog, README, license, and package metadata.
`prepack` rebuilds `dist/cli.js`.

Pushing a version tag runs the release quality gate:

1. install from the frozen pnpm lockfile
2. verify the tag matches `package.json`
3. run TypeScript lint, tests, and the Node build
4. validate the example publication manifest
5. run the complete local session-Graft scenario
6. run the customer-controlled maintenance fixture
7. inspect the package with `pnpm pack --dry-run`

Only after that gate passes does the workflow build the platform binaries,
smoke-test binaries matching their runner architecture, format-check cross
builds, attest the artifacts, and create the GitHub Release.

## Current limitations

Regraft tracks Git blob content, not complete Git tree semantics:

- executable modes are not preserved
- upstream symlinks are not recreated as symlinks
- Git LFS pointers are not materialized
- submodules are not treated as ordinary source trees
- renames appear as deletion plus addition
- a file-to-directory transition can succeed because the old file is removed
  before child paths are written
- a directory-to-file transition currently stops and rolls back for manual
  re-Grafting
- pinned revision IDs are currently expected to be 40-character SHA-1 values

Git operations are synchronous. There is no hosted Graft registry, built-in
credential store, package installation for Grafted code, line-range tracking,
or post-pull hook system.

## Development verification

```bash
pnpm install
pnpm lint
pnpm test:run
pnpm build
node dist/cli.js validate examples/session-graft/regraft.yaml
bash examples/session-graft/run.sh
bash examples/session-graft/automation/run.sh
pnpm pack --dry-run
```

Tests use temporary local Git repositories so reconciliation, migration,
publication, rollback, and repeated-Update behavior can be exercised without
depending on public repositories.
