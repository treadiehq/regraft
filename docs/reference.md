# Reference

## CLI

### `regraft add <sources...> [destination]`

Create one or more Grafts.

- `--name <name>`: name a single Graft
- `--adopt`: keep existing differing files and mark them as needing Intent
- `--force`: overwrite existing differing files
- `--dry-run`: do not change tracked files or manifest state
- `--json`: machine-readable result

Source forms include GitHub shorthand, GitHub tree/blob/PR URLs, HTTPS, SSH,
SCP-style remotes, `file://`, `#ref:path`, and published `#graft=name`.

### `regraft status`

Classify local files and check tracked refs.

- `--offline`
- `--json`

### `regraft diff [files...]`

Show local derivation from the pinned Source.

- `--upstream`: show Source changes since the pin
- `--graft <names-or-ids...>`
- `--json`

### `regraft note <description>`

Record Intent.

- `--files <paths...>`
- `--json`

### `regraft pull [grafts...]`

Apply deterministic Updates to all Grafts or exact selected names/IDs.

- `--dry-run`
- `--force`: take upstream wherever local judgment would otherwise be required,
  including every existing pending file in selected Grafts
- `--json`

### `regraft resolve [files...]`

Finish pending judgment after files have been deliberately reconciled.

- `--graft <names-or-ids...>`
- `--note <description>`
- `--json`

### `regraft inspect [grafts...]`

Return Graft provenance, Intent, local status, upstream status, pending Updates,
and Briefs.

- `--offline`
- `--json`

Machine output includes `schemaVersion: 1`.

All CLI `--json` success and error envelopes include `schemaVersion: 1`.
Commander argument errors also use a JSON envelope when `--json` is present.

### `regraft remove <selector>`

Stop tracking a Graft. Exact name or ID is preferred; unique legacy URL or
destination substrings remain supported.

- `--hard`: also delete tracked files
- `--json`

### `regraft validate [file]`

Validate a publishable `regraft.yaml`.

- `--json`

### `regraft update [version]`

Update standalone binaries and source checkouts. Package-manager installs
receive manual npm/pnpm update instructions. Graft reconciliation uses `pull`;
this command is intentionally not overloaded.

### `regraft completion bash|zsh|fish`

Generate shell completion.

## Exit codes

- `0`: operation succeeded and no required attention remains
- `1`: error, upstream Update, unrecorded local state, missing file, or pending
  judgment depending on the command

`diff` follows Git-like semantics: 1 means differences were found.

## Consumer state: `regraft.json`

Current format version: `2`.

Top-level fields:

- `version`
- `grafts`
- `intents`

Each Graft stores identity, Source, destination, pinned SHA, optional
publication metadata, ownership confidence, and Graft-level exclusions. Each
entry in its `files` record stores:

- `upstreamHash`
- `localHash`
- `intentIds`
- `needsIntent`
- `pending`

`excluded` is the Graft-level list of durable paths Regraft must never claim
because they were not owned when the Graft was established.

Pending state records whether target content is known, its target/local hashes,
the exact Source revision transition, and the generated Brief.

Version 1 manifests using `sources`, one stored hash, and `unresolved` paths are
migrated in memory. The next successful consumer-state write uses version 2.
Old binaries reject version 2 rather than silently dropping new state.

## Publisher state: `regraft.yaml`

See [Publishing Grafts](publishing.md).

## `PATCH.md`

Generated committed projection of Intent history. Do not edit it directly.

## `.regraft/`

Ignored operational state:

- `cache/`: bare Git object caches
- `briefs/`: generated Markdown Briefs

## File-status values

- `clean`
- `modified+intent`
- `modified-unrecorded`
- `missing`
- `conflict-unresolved`
- `reconciliation-pending`

## Limitations

Regraft tracks Git blobs, not complete Git tree semantics. Executable modes,
symlinks, submodules, and Git LFS materialization are not preserved. Renames
appear as deletion and addition. File-to-directory transitions can succeed;
directory-to-file transitions stop and roll back for manual re-Grafting. Git
SHA-1 revision identifiers are currently expected.
