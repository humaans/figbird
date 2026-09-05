# Releasing Figbird Devtools

From an up-to-date, clean `master` checkout, run:

```sh
make release-devtools
```

This cuts the next extension version, runs the tests, builds both browsers, submits Chrome for
private-store review, signs Firefox with Mozilla, and publishes both archives in a GitHub release.
Everything runs on your machine. No GitHub Actions workflow or version-bump PR is involved.
Chrome review can finish later; completion means the submission was accepted, not approved.
Firefox remains unlisted, and Chrome remains private to the Humaans organization.

The command builds in a separate worktree under `.devtools-release`. The version bump is committed
on the release tag, leaving `master` unchanged. The next version is calculated from the highest
extension release tag and `extensions/version.json`. Use `make release-devtools VERSION=0.4.0`
when you want to choose the version yourself.

## First-time setup

Install Node, npm, Git, `zip`, GitHub CLI, and Google Cloud CLI. Sign in:

```sh
gh auth login
gcloud auth login
```

Chrome publisher IDs and the service account are in `extensions/publishers.json`. Your Google
account needs **Service Account Token Creator** on that service account. The service account must
be authorized in the Chrome Web Store publisher account, with the Chrome Web Store API and IAM
Service Account Credentials API enabled in its project. The command mints a short-lived scoped
token using your Google login. It does not need a service account key or GitHub Actions secrets.
A pre-issued `CHROME_ACCESS_TOKEN` can also be supplied.

For Firefox, keep the Mozilla API credentials in macOS Keychain under account `humaans`:

- Service `figbird-amo-jwt-issuer`: the AMO JWT issuer.
- Service `figbird-amo-jwt-secret`: the AMO JWT secret.

The existing Figbird add-on must belong to that Mozilla account. The command checks both browser
credentials before cutting a version. Keep publisher ownership under organization accounts.

## If a release stops

Fix the reported problem and run the same command again:

```sh
make release-devtools
```

Progress is saved in `.devtools-release/state.json`. Reruns keep the same version and built files,
finish the pending browser, and skip completed steps. A Chrome failure does not prevent the
Firefox step from running, or vice versa. The GitHub release stays a draft until both finish.
The command creates that release itself, so there is no workflow to wait for.

Chrome checks whether that version is already submitted or published before uploading. Firefox
reuses a version already submitted to Mozilla and waits for its signed XPI. Mozilla validation or
approval can take more than 15 minutes; check the Developer Hub and rerun later. Rejected versions
need attention in the relevant store dashboard. Never change the pending release's built files;
finish or resolve it before cutting a new version.

Do not delete `.devtools-release` during a pending release. If the process was killed and left a
lock, first confirm no release is running, then remove `.devtools-release/lock`. The progress file
and versioned worktrees contain no credentials. Completed worktrees are retained for inspection.
Running again from the same source commit after completion reports that it is already released.

## Local QA

Before merging changes, run `npm test` and `npm run devtools:check`, then exercise both unpacked
extensions using `extensions/README.md`. Mozilla's full extension validation runs during upload;
there is no local `addons-linter` dependency.

To build and sign Firefox without publishing a release:

```sh
npm run devtools:package
npm run devtools:sign:firefox:local
```

This signs the version in `extensions/version.json`. On other platforms, the underlying signer
accepts `AMO_JWT_ISSUER` and `AMO_JWT_SECRET` through the environment, but the combined release
command currently uses the macOS Keychain wrapper.
