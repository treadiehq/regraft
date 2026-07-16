# Changelog

## Unreleased

## 0.1.6 - 2026-07-16

### Fixed

- Reused existing Intent when resolving content that matches a recorded
  snapshot instead of requiring a redundant note.
- Made `regraft add --dry-run` consistently describe planned, rather than
  completed, writes and Graft creation.
- Formatted `regraft update` failures as normal CLI errors without raw stack
  traces.
- Rejected empty destination selectors such as `regraft remove .` to prevent
  unintended Graft removal.
- Reported missing tracked files in the `regraft status` summary instead of
  labeling affected Grafts as up to date.

## 0.1.5 - 2026-07-15

### Fixed

- Corrected `regraft add` output so matching files are not reported as tracked
  when Graft creation rolls back or runs as a dry-run plan.

## 0.1.4 - 2026-07-14

### Added

- First-class named Grafts with stable IDs and exclusive destination ownership.
- `regraft inspect [grafts...] --json` for agent-readable provenance, Intent,
  local status, upstream status, pending Updates, and Briefs.
- Exact Graft selectors for `pull`, `diff`, `resolve`, and `remove`.
- Versioned, validated repository publication manifests through `regraft.yaml`.
- Published Graft selectors through `#graft=name` and friendly `#name`
  fallback.
- `regraft validate [file]`.
- Structured, durable judgment state for text, binary, deletion, local deletion,
  and destination-collision Updates.
- A complete local session-Graft demonstration.

### Changed

- Consumer state now writes `regraft.json` version 2 with `grafts`, separate
  upstream/local hashes, scoped Intent, and structured pending Updates.
- Version 1 manifests migrate conservatively on the first successful
  consumer-state write.
  Because v1 did not record skipped Source paths, newly appearing paths require
  explicit ownership judgment after migration.
- Human output and help are organized around Grafts, Sources, Intent, Updates,
  and Briefs.
- `PATCH.md` now renders Graft-scoped Intent.
- Manifest and `PATCH.md` replacement is atomic.
- State-changing operations are serialized per project, and multi-file
  mutations roll back if a later step fails.

### Fixed

- Intentional adaptations now survive consecutive clean upstream merges.
- Conflict resolutions remain local adaptations during later Updates.
- Binary, deletion, and collision warnings remain retryable after the pin
  advances.
- Current local state must match accepted Intent; stale historical snapshots no
  longer hide later edits.
- Historical or discarded Intent no longer appears as active context after
  force, removal, or destination reuse.
- Partial adds remain safely retryable without persisting partial ownership.
- Source files that were never owned remain durably excluded across deletion
  and reintroduction.
- Noncanonical manifest paths are rejected before they can collapse distinct
  file identities.

### Compatibility

- Existing command names remain available.
- `regraft update` still updates Regraft itself; Graft Updates use
  `regraft pull`.
- Existing machine result keys such as `source` and `sources` remain, with
  additive Graft identity fields.

## 0.1.3 and earlier

Initial provenance, note, status, diff, pull, resolve, remove, completion,
installer, and self-update functionality.
