# Introduction

Regraft keeps copied and adapted source code connected to its upstream origin.

## The gap

Git records the history of files in your repository. It does not inherently
know that `src/auth/` was copied from a particular path in another repository,
which upstream revision formed the base, or why your version intentionally
differs.

Package managers preserve a dependency relationship, but only while code stays
an external package. Once source is copied into a project and deeply adapted,
the package abstraction no longer describes it.

Regraft manages that third category: **derived code**.

## The product object

A **Graft** connects one upstream Source surface to one local destination.
Regraft records its pinned revision, per-file upstream and local state, Intent,
pending Updates, and Briefs.

```bash
regraft add acme/auth/tree/main/src/session src/session --name session
regraft status
regraft pull session
```

`resolve` is an exception path used only when an Update requires judgment.

## When to use Regraft

Use Regraft when code must become editable project code but future upstream
work still matters:

- an implementation copied from an open-source repository
- a starter kit that will be customized after generation
- vendored source that cannot remain a package
- source brought into a project by a coding agent
- a private or self-hosted Git implementation shared across products

Do not use Regraft as a deployment updater, package manager, Git replacement,
or full Git-tree mirroring system.

## Deterministic first

Regraft fetches commits, hashes content, classifies local state, and performs
three-way reconciliation. It creates a Brief only for the remaining ambiguity.
An agent receives the provenance and Intent rather than being asked to infer
them from repository history.
