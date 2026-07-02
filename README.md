# regraft

Vendor code from any git repo, rewrite it to fit your project, and still pull
upstream updates later.

The problem with vendoring is what happens after you edit your copy: upstream
keeps improving, but their changes have nowhere to land, so your copy slowly
goes stale. regraft fixes that with two habits:

1. **It remembers what it gave you.** A committed manifest (`regraft.json`)
   pins each source to a commit and hashes every file it wrote. So it always
   knows whether you changed a file, upstream did, or both.
2. **It remembers why you changed things.** After editing, you write one
   sentence with `regraft note "..."`. Notes collect in a committed `PATCH.md`.
   When an update collides with your edits, whoever fixes it (you or your
   coding agent) gets your reasons, not just a diff.

Updates that don't touch your edits merge on their own. Real collisions get
normal conflict markers plus a short brief with everything needed to fix them.

## Quickstart

```bash
# 1. Vendor a directory (or a single file) from any git repo
regraft add owner/repo/tree/main/src/components lib/components

# 2. Change the files however you like, then say why
regraft note "Swapped the default tokens for our brand palette"

# 3. Later: anything new upstream? anything changed here without a note?
regraft status

# 4. Pull updates
regraft pull

# 5. If something collided: read the brief, fix the files, then
regraft resolve --note "Re-applied our palette on the new token system"
```

That's the whole loop: add → edit → note → pull → resolve.

## Install

```bash
pnpm install
pnpm build           # produces dist/cli.js
pnpm link --global   # optional: puts `regraft` on your PATH
```

## Good to know

- Merges are real three-way merges (`git merge-file --diff3`). regraft knows
  the version your edits started from, and conflict markers include it, so you
  can see what both sides changed.
- `regraft diff` shows what you changed since vendoring; `regraft diff
  --upstream` shows what upstream changed since your pin. Handy right before
  writing a note or pulling.
- Already copied code in by hand a while ago? `regraft add <source> <dest>
  --adopt` starts tracking it without overwriting your edits — they just show
  up as modifications waiting for a note.
- A GitHub PR is a moving branch, so you can track one:
  `regraft add owner/repo/pull/42`.
- `regraft status` exits 1 when anything needs attention: new upstream
  commits, edits without a note, missing files, unresolved conflicts. Useful
  as a CI step.
- Sources are fetched with your own `git`. If `git clone` works (GitHub,
  GitLab, self-hosted, private), regraft works. No tokens, no rate limits.
- regraft does the deterministic work: fetch, hash, merge. When a merge needs
  judgment, it stops and writes a brief instead of guessing. Whoever picks up
  the brief, you or a coding agent — makes the call. If an agent works in
  your repo, point it at [`skills/regraft/SKILL.md`](skills/regraft/SKILL.md).
- Every command takes `--json`; `add` and `pull` take `--dry-run`.
- `regraft status --offline` skips the upstream checks (no network), and
  `regraft completion bash|zsh|fish` gives you tab-completion.
- Commit `regraft.json` and `PATCH.md`. The `.regraft/` folder ignores itself.

## More

See [`docs/detailed.md`](docs/detailed.md) for the full reference: the
classification model, every command and flag, source syntax, JSON output,
exit codes, and the manifest format.
