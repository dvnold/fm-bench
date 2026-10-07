# Releasing

`fm-bench` uses semver tags (`v*.*.*`). A release tag runs the **Release** workflow: lint/test/package check, npm publish with provenance, a GitHub release whose body is the matching section of **`CHANGELOG.md`** (plus a compare link), and an install check of the published package.

## npm authentication

The Release workflow runs on Node 24 (npm 11) with `id-token: write`, so it publishes through **npm trusted publishing** (OIDC) when the package trusts this workflow. No long-lived token is needed, and provenance is attached automatically. Set it up once (requires an npm login with publish rights and 2FA):

```sh
npm login
npm trust github fm-bench --repo dvnold/fm-bench --file release.yml
npm trust list fm-bench
```

or on npmjs.com: **fm-bench → Settings → Trusted publishing → GitHub Actions**, organization/user `dvnold`, repository `fm-bench`, workflow `release.yml`.

Without trusted publishing, npm falls back to the **`NPM_TOKEN`** repository secret (a granular access token with publish rights). npm limits those tokens to 90 days, so an old token fails with `E401`/`E403`/`E404`.

When publishing fails, the workflow still creates or updates the GitHub release (its notes say npm publish failed) and then fails the run, so the problem is visible. Fix the authentication, then re-run the workflow for the tag. An already-published version is skipped.

Provenance also requires `repository.url` in `package.json` to match the repository the workflow runs in (`git+https://github.com/dvnold/fm-bench.git`). Update it if the repository is renamed or transferred.

## Before tagging

```sh
npm run check     # lint + tests + npm pack integrity
npm run publish:dry-run
actionlint        # if workflows changed
```

Then add a `## X.Y.Z` section to `CHANGELOG.md`; the release notes come from that section.

## Option A — GitHub Actions (recommended)

1. Open **Actions → Version → Run workflow**.
2. Choose `patch`, `minor`, `major`, or an exact semver.
3. The job runs `npm version`, pushes the commit and tag to `main`, and dispatches **Release** for the new tag. (A tag pushed with the workflow's `GITHUB_TOKEN` does not trigger other workflows by itself, so Version starts Release explicitly.)

## Option B — Local

```sh
npm ci && npm run check
npm version minor   # or patch / major
git push origin main --follow-tags   # the tag push triggers Release
```

## Re-run Release without republishing

If npm already has the version but the GitHub release failed (or vice versa), use **Actions → Release → Run workflow** and enter the existing tag (for example `v0.8.0`). The workflow skips npm publish when that version is already on the registry. If the GitHub release already exists, it **updates the release notes** from `CHANGELOG.md`.

```sh
gh workflow run release.yml --repo dvnold/fm-bench -f tag=v0.8.0
```

Refresh notes locally without re-publishing:

```sh
node scripts/changelog-release-notes.mjs 0.8.0 > notes.md
gh release edit v0.8.0 --notes-file notes.md --repo dvnold/fm-bench
```

## Verifying a release

The workflow installs the published version into a clean directory and runs it against the fake `fm`. To check by hand:

```sh
gh release view v0.8.0 --repo dvnold/fm-bench
npm view fm-bench version            # registry version
npm view fm-bench@0.8.0 dist.attestations --json   # provenance

mkdir -p fm-bench-check && cd fm-bench-check
npm install fm-bench@0.8.0
./node_modules/.bin/fm-bench --version
./node_modules/.bin/fm-bench doctor
./node_modules/.bin/fm-bench --profile quick --runs 3
```

## Dry run

```sh
npm run publish:dry-run
npm run check:pack
```

CI runs the dry run on every push to `main` and on pull requests.
