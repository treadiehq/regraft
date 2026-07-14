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
