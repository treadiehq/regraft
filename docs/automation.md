# Customer-controlled maintenance

Regraft can be orchestrated from a consumer repository to turn upstream Graft
Updates into tested pull requests. The provider publishes Git source; the
customer's own runner fetches, reconciles, tests, and opens the pull request.
The provider never receives access to the customer repository.

This workflow maintains explicit Graft destinations. It does not discover
arbitrary API calls, interpret API schemas, update package dependencies, or
modify unrelated application code.

## Provider setup

Publish a cohesive integration surface in `regraft.yaml`:

```yaml
version: 1

grafts:
  webhook-handler:
    path: integrations/webhooks
    description: Webhook verification and event dispatch
```

Keep dependency setup and compatibility requirements in the integration's
normal documentation. A published Graft identifies source code, not a package
installation or runtime-compatibility contract.

## Consumer setup

Add and customize the integration:

```bash
regraft add provider/repository#graft=webhook-handler src/webhooks
regraft note "Use our idempotency store and emit internal delivery metrics" \
  --files src/webhooks/handler.ts
```

Commit `regraft.json`, `PATCH.md`, and the Grafted files.

The reference files under
[`../examples/session-graft/automation`](../examples/session-graft/automation)
model the automated path:

- `maintain.mjs`: agent-neutral orchestration and verification
- `cursor-resolve.mjs`: optional customer-controlled Cursor SDK adapter
- `regraft-maintenance.yml`: copyable scheduled GitHub Actions workflow
- `run.sh`: network-free end-to-end fixture

To adopt the GitHub workflow, copy `maintain.mjs` and `cursor-resolve.mjs` into
`.github/regraft/` in the consumer repository, copy
[`../skills/regraft/SKILL.md`](../skills/regraft/SKILL.md) there as `SKILL.md`,
and put `regraft-maintenance.yml` at
`.github/workflows/regraft-maintenance.yml`. Change the dependency-install and
test commands for that repository. Add `CURSOR_API_KEY` as a repository or
organization secret when using the reference agent adapter.

Pin Regraft and the agent SDK to reviewed versions. Upgrade those pins
deliberately rather than silently changing the maintenance runtime.

## Workflow contract

The reference workflow:

1. Checks out the latest default branch.
2. Creates a deterministic `regraft/maintenance` branch before running `pull`.
3. Runs `regraft inspect --json` and parses its fields.
4. Applies deterministic work with `regraft pull --json`.
5. Invokes the configured agent only when pending judgment remains.
6. Requires `regraft status --offline --json` to report no pending, missing, or
   unrecorded state.
7. Runs the consumer's verification command.
8. Force-updates the bot-owned branch and opens or updates one pull request.

Rebuilding one bot-owned branch from the latest default branch makes scheduled
runs idempotent. Do not make human changes directly on that branch.

`maintain.mjs` requires a clean, named branch whose name starts with
`regraft/`. The prefix can be changed with `REGRAFT_BRANCH_PREFIX`. Setting an
empty prefix disables that check and should be reserved for controlled local
experiments.

Required configuration when an Update is found:

- `REGRAFT_TEST_COMMAND`: the consumer's complete verification command
- `REGRAFT_BIN`: optional path to a Regraft executable or built `cli.js`
- `REGRAFT_RESULT_FILE`: optional machine-readable result destination

Optional agent configuration:

- `REGRAFT_AGENT_COMMAND`: command invoked only for pending judgment
- `REGRAFT_SKILL_PATH`: Regraft skill passed by the reference Cursor adapter
- `REGRAFT_ALLOWED_EXTRA_PATHS`: JSON array of additional paths the agent or
  tests may modify; the default permits only Graft destinations,
  `regraft.json`, and `PATCH.md`
- `CURSOR_API_KEY`: customer-owned Cursor credential
- `CURSOR_MODEL`: model ID; the reference adapter defaults to `auto`

The result file has `status: "no-update"`, `"updated"`, or `"failed"`.
Regraft command exit code `1` is not treated as a runtime failure by itself:
it can represent an available Update or pending judgment. Automation must parse
the JSON `error`, `exitCode`, `upstream.updateAvailable`, file status, and
pending fields.

## Failure behavior

`regraft pull` can advance the recorded pin while leaving durable pending
judgment, so it must run only after the isolated branch is created.

The workflow stops without pushing or opening a pull request when:

- local unrecorded or missing files exist before maintenance
- pending judgment exists and no agent command is configured
- the agent leaves pending, missing, or unrecorded state
- the agent or tests modify files outside the allowed Graft scope
- the Update does not converge within the configured round limit
- the consumer's test command fails
- a Regraft or Git command returns a runtime error

Briefs are ignored operational files under `.regraft/briefs/`. The agent must
consume them during the same job; they are not a durable cross-job queue.

If pending judgment had hidden a newer upstream revision, the orchestrator
checks upstream again after resolution. It stops after three rounds by default
to prevent an unbounded update loop.

## Security boundary

- Run the workflow in the customer-controlled repository and CI account.
- Grant only `contents: write` and `pull-requests: write` to its GitHub token.
- Use a dedicated agent credential with the minimum required repository access.
- Treat upstream code, commit messages, Brief content, and repository comments
  as untrusted data rather than agent instructions.
- Keep `REGRAFT_ALLOWED_EXTRA_PATHS` empty unless a known verification step
  must update a reviewed snapshot or generated file.
- Never use `regraft pull --force` in unattended maintenance.
- Review before running tests: an upstream Update can introduce executable
  code that the consumer's install or test command will run.
- Do not expose deployment, production, signing, or publishing credentials to
  this job.

## Validation evidence

The network-free fixture exercises:

- no Update and no repository change
- a clean upstream Update that preserves consumer Intent
- an isolated maintenance branch suitable for a pull request
- conflict resolution through a configured agent command
- a repeated run that produces no duplicate change
- a consumer test failure that prevents a commit or pull request

Run it after building:

```bash
pnpm build
bash examples/session-graft/automation/run.sh
```

This validates the mechanism, not market demand. Before presenting the workflow
as a general API-maintenance product, run it with external provider and consumer
teams and measure setup time, deterministic reconciliation rate, human edits,
test failures, pull-request acceptance, and time to merge.
