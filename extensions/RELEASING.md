# Releasing Figbird Devtools

## Release policy

Chrome releases are private to the Humaans Google Workspace organization. Firefox releases are Mozilla-signed but unlisted and are distributed directly to the team.

Keep store ownership and automation under organization accounts. Do not use personal publisher accounts or commit publisher credentials.

## Prepare a release

1. Update the extension code and listing or privacy copy if its behavior changed.
2. Run `npm test` and `npm run devtools:check`.
3. QA the unpacked Chrome and Firefox builds using `extensions/README.md`.
4. Merge the reviewed extension changes.

## One-time publisher setup

### Chrome

1. Register the Humaans Workspace account in the Chrome Web Store Developer Dashboard and accept the developer agreement.
2. Create the item by uploading `extensions/build/figbird-devtools-chrome.zip`.
3. Complete the listing and privacy forms using `extensions/STORE_LISTING.md`, including the
   store icon and screenshot under `extensions/store-assets`.
4. Set visibility to **Private** and select the `Team - team@humaans.io` trusted tester group.
   This gives the Humaans team access without exposing the listing publicly. Domain publishing
   can replace the group later if it is enabled by a Workspace administrator.
5. Submit the first release manually. Chrome requires a manual publication after changing visibility before API publication can use that setting.
6. Enable the Chrome Web Store API in a Humaans Google Cloud project. Create a service account and add its email under the publisher dashboard's **Account** section.
7. Configure GitHub-to-Google Cloud Workload Identity Federation for this repository and service account. Do not create a long-lived service-account key.

Add these variables to the protected `extension-release` GitHub environment:

- `CHROME_WORKLOAD_IDENTITY_PROVIDER`
- `CHROME_SERVICE_ACCOUNT`
- `CHROME_PUBLISHER_ID`
- `CHROME_EXTENSION_ID`

### Firefox

1. Sign in to the Mozilla Add-ons Developer Hub with an organization-controlled account.
2. Create API credentials on the AMO API key page.
3. Add the organization maintainers as owners or developers in the add-on's **Manage Authors & License** page after its first submission.

Firefox signing runs locally. Store the Mozilla API credentials in macOS Keychain under the
`humaans` account and these service names:

- `figbird-amo-jwt-issuer`
- `figbird-amo-jwt-secret`

Build the release inputs, then run the Keychain-backed signer:

```sh
npm run devtools:package
npm run devtools:sign:firefox:local
```

The signed XPI is written to `extensions/build/firefox-signed`.

The signer uses Node's built-in APIs to upload the unsigned ZIP, wait for Mozilla validation,
submit the version with its source archive, and download the approved XPI. It targets the existing
unlisted Figbird add-on. It does not create store listings or run Mozilla's linter locally.
`devtools:check` runs our type, lint, formatting, and devtools tests and packages the extension;
Mozilla performs extension validation during signing.

Rerunning reuses the version already submitted to Mozilla. It waits up to 15 minutes each for
validation and approval. If approval takes longer, rerun after checking the Developer Hub.
If you change the extension after submission, bump its version before signing again. A rejected
version or a version missing its source archive needs attention in the Developer Hub.

On other platforms, set `AMO_JWT_ISSUER` and `AMO_JWT_SECRET` and run
`node tasks/sign-firefox-devtools.js` after packaging.

After the version-bump PR has merged, update your local `master` checkout and run the complete
local Firefox release:

```sh
git pull --ff-only origin master
make upload-firefox-extension
```

The command builds fresh release inputs, signs the Firefox extension with the Keychain-backed
Mozilla credentials, and uploads `figbird-devtools-firefox-signed.xpi` to the matching
`devtools-v<version>` GitHub release. It exits successfully without signing again if that asset is
already present. If an earlier local run stopped after submission, the signer resumes that version.

## Release both extensions

After merging the extension changes, run:

```sh
make release-extensions
```

The command increases the patch component in `extensions/version.json`, creates a release branch,
commits and pushes it, and opens a version-bump PR. It does not change the current working tree.
Use `make release-extensions VERSION=0.2.0` to choose a different version.

The command checks the Chrome publisher configuration and version before creating the PR. Merge
the PR to submit the private Chrome extension for review. The release workflow saves the Chrome
ZIP in the matching `devtools-v<version>` GitHub prerelease. Then update your local checkout and
run `make upload-firefox-extension` to sign and publish Firefox.

Team members can unzip the Chrome archive and load its folder from `chrome://extensions` using
**Developer mode → Load unpacked** while store review is pending.

To upload or submit Chrome manually, open **Actions → Release browser devtools → Run workflow**
on the default branch:

- **Upload Chrome** uploads the new ZIP but leaves it in the dashboard for inspection.
- **Submit Chrome** uploads and submits it for private-store review. It also enables **Upload Chrome** automatically.

Every workflow run also saves the Chrome ZIP in the versioned GitHub prerelease, independently
of whether the Chrome Web Store upload or submission inputs are enabled.

Use upload-only for the first automated rehearsal. Use submit only after the artifact has passed local QA. Store review can outlive the workflow; check the publisher dashboard if Mozilla selects the add-on for manual review.
