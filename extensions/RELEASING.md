# Releasing Figbird Devtools

## Release policy

Chrome releases are private to the Humaans Google Workspace organization. Firefox releases are Mozilla-signed but unlisted and are distributed directly to the team.

Keep store ownership and automation under organization accounts. Do not use personal publisher accounts or commit publisher credentials.

## Prepare a release

1. Increase the version in `extensions/version.json`. Browser extension versions can contain one to four dot-separated integers.
2. Update the extension code and listing or privacy copy if its behavior changed.
3. Run `npm test` and `npm run devtools:check`.
4. QA the unpacked Chrome and Firefox builds using `extensions/README.md`.
5. Merge the reviewed version change before running the release workflow.

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

Add these secrets to the protected `extension-release` GitHub environment:

- `AMO_JWT_ISSUER`
- `AMO_JWT_SECRET`

Mozilla exposes the secret only when it is created. Store it directly in GitHub Actions and rotate it if it is ever copied elsewhere.

## Run the workflow

Open **Actions → Release browser devtools → Run workflow** on the default branch.

- **Sign Firefox** submits the unlisted build and source archive to Mozilla, then saves the
  signed XPI as both a workflow artifact and a `devtools-v<version>` GitHub prerelease asset.
- **Upload Chrome** uploads the new ZIP but leaves it in the dashboard for inspection.
- **Submit Chrome** uploads and submits it for private-store review. It also enables **Upload Chrome** automatically.

Use upload-only for the first automated rehearsal. Use submit only after the artifact has passed local QA. Store review can outlive the workflow; check the publisher dashboard if Mozilla selects the add-on for manual review.
