# Session Graft demo

This executable, network-free walkthrough models a product that derives session
code from an upstream authentication repository.

The product intentionally:

- replaces database-backed session operations with Redis
- keeps trusted devices for 30 days instead of the upstream default

Upstream then:

- adds deterministic expired-session cleanup
- changes the same trusted-device policy, requiring judgment
- later adds active-session refresh

The walkthrough proves:

1. a maintainer can publish `session` through `regraft.yaml`
2. a consumer can create a named Graft
3. Intent is persisted for meaningful local adaptations
4. non-overlapping upstream work merges automatically
5. conflicting policy work produces diff3 markers and a useful Brief
6. resolution is recorded as new Intent
7. a consecutive Update preserves the Redis and policy adaptations

Run from the repository after building:

```bash
pnpm build
bash examples/session-graft/run.sh
```

The script creates temporary Git repositories and deletes them on exit. It does
not contact the network or modify the Regraft repository.

## Customer-controlled Update pull requests

The [`automation`](automation) directory extends the same provider/consumer
scenario into an unattended maintenance workflow:

- `maintain.mjs` checks for upstream Updates, applies deterministic work,
  delegates only pending judgment, and runs consumer tests
- `cursor-resolve.mjs` is an optional Cursor SDK adapter running with the
  customer's credential on the customer's runner
- `regraft-maintenance.yml` creates an isolated maintenance branch and opens or
  updates one GitHub pull request after verification
- `run.sh` proves the orchestration without network or agent credentials

Run the automation fixture:

```bash
pnpm build
bash examples/session-graft/automation/run.sh
```

The fixture covers no Update, a clean merge, an agent-required policy conflict,
a repeated no-op run, branch isolation, and a consumer test failure that blocks
the pull request.

See [Customer-controlled maintenance](../../docs/automation.md) before copying
the workflow into a consumer repository.
