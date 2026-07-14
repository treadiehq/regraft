# Concepts

Regraft intentionally uses a small vocabulary.

## Graft

The primary object. A Graft is a durable relationship between a Source surface
and a local destination.

Each Graft has:

- a stable ID and unique human name
- a Source repository, ref, and path
- a pinned upstream revision
- one exclusively owned local destination
- per-file upstream and accepted local hashes
- associated Intent
- pending Update state and Brief references

Graft destinations cannot overlap. This prevents two upstream relationships
from claiming or deleting the same local file.

## Source

The upstream Git repository, tracked ref, and path. Sources can use GitHub
shorthand, HTTPS, SSH, SCP-style remotes, or `file://` local repositories.
Regraft uses the installed Git client and its existing authentication.

The tracked ref can move. The pinned revision identifies the upstream state
already reconciled into the Graft.

## Intent

The reason local code intentionally differs from Source code.

Intent is bound to Graft file identities and content snapshots. Historical
Intent remains in `PATCH.md` after a Graft is removed, but it no longer
classifies unrelated code as explained.

Good Intent:

> Use Redis-backed sessions because application nodes are stateless.

Weak Intent:

> Changed session-store.ts.

## Update

Upstream change since a Graft's pinned revision.

Regraft evaluates each affected file from:

- content at the previous pinned Source revision
- current local content
- content at the target Source revision

Successful files advance their upstream baseline. Locally derived content keeps
its own accepted hash, so adaptations survive consecutive Updates.

Warnings and conflicts persist as pending Update state. They remain retryable
even after the Graft records the target revision.

## Brief

Structured context for an Update requiring judgment. A Markdown Brief contains:

- Graft identity and Source
- previous and target revisions
- conflicts and warnings
- relevant upstream commits
- relevant Intent
- resolution instructions

The same pending information is available through `regraft inspect --json`.
