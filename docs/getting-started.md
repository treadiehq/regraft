# Getting started

## Install

Regraft requires Git.

### macOS or Linux

```bash
curl -fsSL https://raw.githubusercontent.com/treadiehq/regraft/main/scripts/install.sh | bash
regraft --version
```

### Windows

```powershell
irm https://raw.githubusercontent.com/treadiehq/regraft/main/scripts/install.ps1 | iex
regraft --version
```

### From source

Use Node 20 or newer and pnpm:

```bash
pnpm install
pnpm build
pnpm link --global
```

## Create your first Graft

From the project that will own the copied files:

```bash
regraft add acme/repo/tree/main/src/auth ./src/auth --name auth
```

Regraft copies the Source at its resolved commit and creates:

- `regraft.json`: committed, machine-readable Graft state
- `PATCH.md`: committed, human-readable Intent history
- `.regraft/`: ignored Git cache and generated Briefs

Already have the copied code?

```bash
regraft add acme/repo/tree/main/src/auth ./src/auth \
  --name auth \
  --adopt
```

`--adopt` keeps differing files and marks them as needing Intent.

## Record Intent

Adapt the code, then record why:

```bash
regraft note "Use Redis-backed sessions for stateless application nodes" \
  --files src/auth/session-store.ts
```

Intent should describe the requirement, not merely restate the diff.

## Check for Updates

```bash
regraft status
regraft diff --upstream --graft auth
```

Use offline status when network access is intentionally unavailable:

```bash
regraft status --offline
```

## Update a Graft

```bash
regraft pull auth
```

If the Update is deterministic, Regraft completes it. If judgment remains:

1. Read the Brief path printed by `pull`.
2. Inspect the affected files and Intent.
3. Make the deliberate local resolution.
4. Finish it:

```bash
regraft resolve --graft auth \
  --note "Retained Redis semantics on upstream's new session API"
```

To explicitly discard local state and take upstream for every pending file in
the selected Graft, inspect the pending files first, then run:

```bash
regraft inspect auth --json
regraft pull auth --force
```

## Inspect for an agent

```bash
regraft inspect auth --json
```

This is the canonical machine-readable context summary.
