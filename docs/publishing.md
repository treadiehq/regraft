# Publishing Grafts

Repository maintainers publish intentional source surfaces by committing
`regraft.yaml` at the repository root.

```yaml
version: 1

grafts:
  session:
    path: packages/auth/src/session
    description: Session management implementation

  oauth:
    path: packages/auth/src/oauth
    description: OAuth provider implementation
```

Publishing means committing and pushing this file. There is no publish command
or hosted registry.

## Validate

```bash
regraft validate
regraft validate path/to/regraft.yaml
regraft validate --json
```

Local validation checks the manifest schema. Consumer `add` also verifies the
selected path exists in the exact resolved Git commit.

## Schema version 1

Top level:

- `version`: required integer `1`
- `grafts`: required mapping containing 1–256 entries

Each Graft:

- name: lowercase kebab-case, 1–63 characters
- `path`: canonical repository-relative POSIX path; use `.` for repository root
- `description`: required single line, at most 300 characters

Unknown fields, duplicate keys, traversal, aliases, merge keys, custom tags,
multiple documents, and manifests over 256 KiB are rejected.

The distributable JSON Schema is
[`../schemas/regraft-yaml.v1.schema.json`](../schemas/regraft-yaml.v1.schema.json).
`regraft validate` remains authoritative for YAML-level restrictions.

## Naming

Names are public ecosystem identifiers. Prefer a stable capability:

- `session`
- `oauth`
- `http-client`

Avoid implementation versions, repository-internal team names, and names that
only make sense beside the current directory structure.

Changing a published name is breaking for new consumers. Existing Grafts keep
tracking their resolved concrete Source path and do not silently follow later
manifest changes.

## Consumption

Explicit selector:

```bash
regraft add better-auth/better-auth#graft=session src/session
```

Friendly selector:

```bash
regraft add better-auth/better-auth#session src/session
```

For compatibility, a bare fragment first resolves as a Git ref. It falls back
to a published Graft only when that ref is not reachable. Use `#graft=session`
when the distinction matters.

Self-hosted and local examples:

```bash
regraft add "ssh://git.example.com/team/auth.git#graft=session" src/session
regraft add "file:///Users/me/auth#graft=session" src/session
```

## Versioning policy

Manifest versioning describes schema compatibility, not code compatibility.
Future incompatible schema changes will use a new numeric version. Regraft
rejects versions it does not understand.

Source compatibility remains the maintainer's responsibility. Descriptions
should explain what is safe to Graft, and paths should identify cohesive
surfaces rather than incidental directories.

## Future registry boundary

The open manifest is sufficient for direct Git discovery. A future public
registry would add search, ownership verification, indexing, metadata,
version-policy signals, and abuse controls. None of those are required to
publish or consume a Graft today.
