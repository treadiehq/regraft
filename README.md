# Regraft

**Keep copied code up to date.**

Sometimes you need to copy code into your project and make it your own. Regraft
remembers where that code came from, why you changed it, and helps you bring in
future updates.

The files stay in your repository. You can edit them however you like.

## Install

Regraft requires Git. On macOS or Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/treadiehq/regraft/main/scripts/install.sh | bash
```

See [Getting started](docs/getting-started.md) for Windows and source installs.

## Quick start

```bash
# Copy and track an upstream directory
regraft add acme/repo/tree/main/src/auth ./src/auth --name auth

# After changing the copied code, record why
regraft note "Use Redis-backed sessions" --files src/auth/session-store.ts

# Check for upstream changes and bring them in
regraft status
regraft pull auth
```

Regraft handles straightforward updates automatically. If an update needs a
decision, it gives you the source, your changes, and your notes so you can
resolve it without guessing.

Commit `regraft.json` and `PATCH.md` with your code.

For provider-published integration code, a customer-controlled CI job can use
the same workflow to prepare a tested Update pull request without giving the
provider access to the customer repository.

## Learn more

- [Getting started](docs/getting-started.md)
- [How Regraft works](docs/concepts.md)
- [Guides](docs/guides.md)
- [Automating Update pull requests](docs/automation.md)
- [Command reference](docs/reference.md)
- [Detailed implementation reference](docs/detailed.md)
- [Publishing graftable code](docs/publishing.md)
- [Using Regraft with coding agents](skills/regraft/SKILL.md)
- [Changelog](CHANGELOG.md)

## License

[FSL-1.1-MIT](LICENSE)
