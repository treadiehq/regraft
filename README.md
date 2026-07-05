# Copy the code. Keep the updates

regraft lets you copy code from any git repo into your project, change it, and
still pull new upstream updates later.

The hard part is what happens after you edit copied code. Upstream keeps moving.
Your copy usually gets stuck. regraft keeps the link.

regraft does two things:

1. **It remembers what you copied.** `regraft.json` pins the upstream commit and
   hashes each tracked file. That tells regraft what changed here, what changed
   upstream, and what changed in both places.
2. **It remembers why you changed it.** After editing, write one sentence with
   `regraft note "..."`. Those notes go in `PATCH.md`, so future updates come
   with context.

If upstream changes files you did not touch, regraft updates them automatically.
If both sides changed the same area, regraft writes normal conflict markers and
a short brief that explains what to fix.

## Quickstart

```bash
# 1. Copy a directory (or a single file) from any git repo
regraft add owner/repo/tree/main/src/components lib/components

# 2. Change the files however you like, then say why
regraft note "Swapped the default tokens for our brand palette"

# 3. Later: check for upstream updates or local edits without notes
regraft status

# 4. Pull updates
regraft pull

# 5. If something conflicts: read the brief, fix the files, then
regraft resolve --note "Re-applied our palette on the new token system"
```

That's the whole loop: add → edit → note → pull → resolve.

## Install

**macOS / Linux** (needs `curl`):

```bash
curl -fsSL https://useregraft.com/install.sh | bash
```

**Windows** (PowerShell):

```powershell
irm https://useregraft.com/install.ps1 | iex
```

**From source** (needs Node ≥ 20 and pnpm):

```bash
pnpm install
pnpm build           # produces dist/cli.js
pnpm link --global   # optional: puts `regraft` on your PATH
```

## Good to know

- Merges use `git merge-file --diff3`, so conflicts show your version, the old
  upstream version, and the new upstream version.
- `regraft diff` shows what you changed locally. `regraft diff --upstream` shows
  what upstream changed since your pin.
- Already copied code in by hand? `regraft add <source> <dest> --adopt` starts
  tracking it without overwriting your edits. Those edits just wait for a note.
- A GitHub PR is a moving branch, so you can track one:
  `regraft add owner/repo/pull/42`.
- `regraft status` exits 1 when anything needs attention: new upstream commits,
  edits without a note, missing files, or unresolved conflicts. That makes it
  useful in CI.
- Sources are fetched with your own `git`. If `git clone` works (GitHub,
  GitLab, self-hosted, private), regraft works. No tokens, no rate limits.
- regraft handles the mechanical work: fetch, hash, merge. When a merge needs
  judgment, it writes a brief instead of guessing. If an agent works in your
  repo, point it at [`skills/regraft/SKILL.md`](skills/regraft/SKILL.md).
- Every command takes `--json` (except `update`); `add` and `pull` take `--dry-run`.
- `regraft status --offline` skips the upstream checks (no network), and
  `regraft completion bash|zsh|fish` gives you tab-completion.
- Commit `regraft.json` and `PATCH.md`. The `.regraft/` folder ignores itself.

## More

See [`docs/detailed.md`](docs/detailed.md) for the full reference: the
classification model, every command and flag, source syntax, JSON output,
exit codes, and the manifest format.

## License

[FSL-1.1-MIT](LICENSE)
