# Agent working contract

The existing estate Git template installs pre-commit, pre-push, commit-msg and
prepare-commit-msg entrypoints in new agent clones and initializations. Linked
worktrees share their repository's hook directory. Checks run at ordinary Git
events; no session-start setup is needed. Pre-commit installs and caches managed
hook environments when first used.

For an existing checkout missing its native hooks, install them once from its
root through the enrolled author identity:

```sh
pre-commit validate-config .pre-commit-config.yaml
pre-commit install --hook-type pre-commit --hook-type pre-push \
  --hook-type commit-msg --hook-type prepare-commit-msg
```

Preserve custom hooks and `core.hooksPath`; integrate their owner rather than
unsetting or overwriting it. Native hook installation does not install system
binaries. Existing host provisioning owns them, including Vale for prose checks;
the established Homebrew declaration supplies Vale through normal package
verification. Repository-native setup owns project dependencies and required files. Missing
prerequisites must fail clearly through the applicable hook or project command.
Do not run project tests merely to install hooks, or rerun installation each
session. `DOTTY_CHECKOUT` selects maintained reviewed source for shared commands.

Use the native hook stages and repository commands. Do not bypass checks with
`--no-verify`, `SKIP`, altered hook paths, or disabled scanners. Correct the finding
and retry. Keep staged-content, commit-message and outgoing-history scans active;
never expose scanner findings containing confidential content. Before every PR create or body edit, validate the exact body file with
`python3 "$DOTTY_CHECKOUT/.github/scripts/pr-body-check.py" --template .github/pull_request_template.md --body-file <body-file>`
(or `--body-file -` for stdin). Publish that same file with `gh pr create --body-file`
or `gh pr edit --body-file` through the appropriate agent identity. This validates
structure; retain applicable content/confidentiality scanning too.

Finish the candidate and relevant local checks before publication. For a new PR,
push successfully, then create it once with the complete title and validated
body. Do not publish a placeholder and immediately replace it, or edit
descriptions just to add CI progress or run links visible on GitHub.

For an existing PR, finish the local changes and prepare any necessary description
update before pushing. Identify the outgoing commit and only checks already
completed; do not claim a future push or hook result. Validate and scan the exact
body file as above. After the normal push succeeds, publish the necessary edit
once, immediately, before polling CI or drafting further prose. Combine title and
body changes in that edit. If the push fails, resolve it and revalidate any changed
candidate or body before publication. Read back the final head, title and body,
then follow CI and Margot through completion.

Keep scope, risk and verification claims accurate for the published head. A push
and a description edit are separate GitHub events; a prompt edit gives native
cancellation an earlier opportunity to stop superseded work but cannot guarantee
zero wasted runner time. Preserve description-triggered scanning, classification
and review, and the existing cancellation behavior.

Test changed behavior through its real interface using the narrowest relevant
existing suite. Do not add implementation-mirroring assertions, test-count quotas
or a new fleet suite. A new regression assertion needs a meaningful negative
control or red/green result; invalid imports or broken fixtures do not count.
Fixture repositories must clear inherited Git routing so tests cannot mutate the
caller's object store. Distinguish source tests from actual installed-agent proof.

## Setup

Node.js 22 or newer. `npm ci` installs everything, including Wrangler as a dev
dependency. Nothing here needs a Cloudflare login: tests and typecheck run
offline, and deploys happen from GitHub (see CI and deploy).

## Configuration

Nothing deployment-specific is committed. `wrangler.json` is generic; the only
values a deployment fills in are its KV namespace ids, which the deploy workflow
injects from the repository variables `RATE_LIMIT_KV_NAMESPACE_ID` (Parcel read
throttle) and `OAUTH_KV_NAMESPACE_ID` (OAuth clients, grants, and tokens). The
Worker's runtime values live on Cloudflare, never in this repository:

```yaml
# Worker secret (set once with `wrangler secret put` or the dashboard)
PARCEL_API_KEY: "<your Parcel API key>"
# Worker variables, dashboard-managed; wrangler.json's keep_vars preserves them
ACCESS_TEAM_DOMAIN: "<team>.cloudflareaccess.com"
ACCESS_AUD: "<Access application AUD tag>"
```

## Build / Test

```sh
npm ci
npm test              # vitest, mock-only: no network, no credentials
npm run typecheck     # tsc --noEmit
npx wrangler deploy --dry-run --outdir /tmp/parcel-mcp-dryrun   # builds the Worker offline
```

## CI and deploy

Every pull request runs the shared estate check (`.github/workflows/ci.yml`,
calling Dotty's `estate-pr-ci.yml@v1`); `Shared / Pre-Merge Checks` is the
required status. Margot reviews; Ollie merges.

Every push to `main` runs `npm ci`, `npm test`, and `npm run typecheck` before
deploying and publishing a source release. These are deployment gates, not an
additional required PR check. The serialized workflow uses the local
`.github/scripts/tag-package-release.sh` to create immutable annotated
`parcel-mcp--v<package version>` tags and GitHub releases.

Deployment runs (`.github/workflows/deploy.yml`): Cloudflare's
`wrangler-action`, SHA-pinned, in the `default-branch` environment. It reads the
secret `CLOUDFLARE_API_TOKEN` and the variables `CLOUDFLARE_ACCOUNT_ID`,
`RATE_LIMIT_KV_NAMESPACE_ID`, and `OAUTH_KV_NAMESPACE_ID` from that environment.
There is no manual deploy path from a workstation. The OAuth variable has to
exist before a deploy of this Worker, or the workflow fails and the previous
version keeps serving.

Regenerate binding declarations after config changes with
`npx wrangler types --include-runtime false`.

## Conventions

- The MCP core (`src/mcp.ts`) is transport-agnostic and takes every side effect
  (identity, fetch, clock, throttle) as an injected dependency, so tests never
  touch the network. Keep it that way: new behaviour gets a mock in `test/`.
- Never log or return delivery contents or the Parcel key. Upstream errors are
  classified into `error_code` values; their bodies are never echoed.
- No deployment identifiers (hostnames, team domains, AUD tags, namespace ids)
  in committed files. They belong in Cloudflare or in GitHub variables.
