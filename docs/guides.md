# Guides

## Copy code from GitHub

```bash
regraft add acme/repo/tree/main/src/auth src/auth --name auth
```

For one file:

```bash
regraft add acme/repo/blob/main/src/retry.ts src/retry.ts --name retry
```

## Track starter-kit code

Generate or copy the starter first, then adopt it:

```bash
regraft add acme/starter/tree/main/app starter --name starter --adopt
regraft status --offline
regraft note "Keep our existing routes and deployment configuration"
```

Review destination ownership before Grafting a repository root: one Graft
reserves its whole destination against overlap.

## Track vendored source

```bash
regraft add ssh://git.example.com/platform/runtime.git#main:src/runtime \
  vendor/runtime \
  --name runtime
```

Private and self-hosted repositories use normal Git credentials. If `git
ls-remote <url>` works in the same environment, Regraft can resolve it.

## Track a local clone

```bash
regraft add "file:///Users/me/src/runtime#main:src/runtime" \
  vendor/runtime \
  --name runtime
```

The local repository must have committed revisions; Regraft reads Git objects,
not uncommitted working-tree changes.

## Track source copied by a coding agent

Have the agent create the Graft before adapting files:

```bash
regraft add acme/auth#graft=session src/session
regraft inspect session --json
```

After changes, require Intent:

```bash
regraft status --offline
regraft note "Use tenant-prefixed Redis keys" --files src/session/store.ts
```

## Use with Claude Code, OpenCode, or Codex

The tool-specific integration can vary, but the safe protocol is the same:

1. Run `regraft inspect --offline --json` before modifying Grafted paths.
2. Preserve active Intent.
3. Run `regraft status --offline` after edits.
4. Record new Intent for every unrecorded adaptation.
5. Run `regraft pull <name>` only when upstream network access is intended.
6. On pending judgment, read the Brief and resolve deliberately.
7. Never use `--force` unless discarding local behavior is explicitly desired.

The repository skill at [`../skills/regraft/SKILL.md`](../skills/regraft/SKILL.md)
encodes this workflow for compatible coding agents.

## CI

```bash
regraft status
```

Exit code 1 means an upstream Update exists or local state needs attention.
Intent-covered adaptations do not fail status.

For network-free checks:

```bash
regraft status --offline
```

## Prepare Update pull requests in CI

Run Regraft from a customer-controlled CI environment when provider-published
integration code should receive scheduled Update pull requests. The workflow
must create an isolated branch before `pull`, parse command JSON rather than
treating every exit code `1` as an error, consume pending Briefs in the same
job, and run customer tests before pushing.

See [Customer-controlled maintenance](automation.md) for the reference
orchestrator, optional agent adapter, GitHub Actions workflow, and security
boundary.
