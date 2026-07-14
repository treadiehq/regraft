---
name: regraft
description: Work safely with derived code managed as Regraft Grafts. Use when a repository contains regraft.json or PATCH.md, before modifying Grafted paths, when applying upstream Updates, or when resolving a Regraft Brief.
---

# Work safely with Regraft

Regraft tracks code derived from upstream Sources. A Graft records provenance,
the pinned revision, accepted local adaptation, Intent, pending Updates, and
Briefs.

Regraft performs deterministic provenance and reconciliation. The agent handles
only explicit modifications and remaining judgment.

## Before modifying code

Run the stable machine inspection surface without unexpected network access:

```bash
regraft inspect --offline --json
```

Identify:

- which Graft owns the target path
- Source repository, path, and pinned revision
- active Intent that must remain true
- `modified-unrecorded`, `missing`, or pending files
- relevant Brief paths

File statuses:

- `clean`
- `modified+intent`
- `modified-unrecorded`
- `missing`
- `conflict-unresolved`
- `reconciliation-pending`

Do not infer provenance from Git history when inspection already provides it.

## After deliberately modifying a Graft

Inspect the actual delta:

```bash
regraft diff path/to/file
```

Then record why the adaptation must exist:

```bash
regraft note "Use tenant-prefixed Redis keys to isolate customer sessions" \
  --files path/to/file
```

Write Intent for the future person or agent reconciling different upstream
code. Describe the requirement and reason, not just changed lines.

Verify:

```bash
regraft status --offline
```

No deliberately changed file may remain `modified-unrecorded`.

## Applying an upstream Update

Only contact upstream when the task requires it:

```bash
regraft diff --upstream --graft auth
regraft pull auth --dry-run --json
regraft pull auth --json
```

- untouched files fast-forward
- non-overlapping changes merge deterministically
- local derivations and Intent survive consecutive Updates
- conflicts, binaries, deletions, and collisions become durable pending state

Never use `--force` unless the user explicitly wants to discard local behavior
and take upstream for pending files.

## Resolving a Brief

1. Read the complete Brief.
2. Inspect the Graft:

   ```bash
   regraft inspect auth --offline --json
   ```

3. Preserve the requirements stated by relevant Intent.
4. For diff3 conflicts, use:
   - `<<<<<<< local`: adapted local code
   - `||||||| base`: previous pinned Source
   - `>>>>>>> upstream`: target Source
5. For binary, deletion, and collision Updates, choose the desired disk state
   explicitly.
6. Remove all conflict markers.
7. Finish and document judgment:

   ```bash
   regraft resolve --graft auth \
     --note "Retained Redis semantics on upstream's new session API"
   ```

8. Verify with `regraft status --offline`.

Pending judgment is handled before Regraft contacts an even newer upstream
revision. Resolve the current Update first; then pull again if needed.

## Creating a Graft

Direct Source:

```bash
regraft add owner/repo/tree/main/src/lib vendor/lib --name lib
```

Published Source surface:

```bash
regraft add owner/repo#graft=session src/session
```

Already copied code:

```bash
regraft add <source> <destination> --name <name> --adopt
```

Immediately record Intent for adopted differences.

## Never do

- Never edit `PATCH.md` manually.
- Never edit `regraft.json` to bypass validation.
- Never leave deliberate adaptations without Intent.
- Never discard pending state without explicit judgment.
- Never ask a model to reconstruct provenance that `inspect --json` exposes.
- Never treat `regraft update` as a Graft operation; it updates Regraft itself.
