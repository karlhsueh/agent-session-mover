---
summary: How to cut a release, what the release workflow builds, and the one-time setup of the macOS signing and notarization secrets.
read_when:
  - Cutting a release
  - Changing .github/workflows/release.yml or the electron-builder config in package.json
  - Adding or rotating the Apple signing or notarization secrets
---

# Releasing

The Release workflow in `.github/workflows/release.yml` raises the version, tags it, builds the app on macOS, Windows, and Linux runners, checks the files, and publishes a GitHub release with them. Then it updates the Homebrew cask.

| File | Platform |
| --- | --- |
| `agent-sessions-mac-arm64.dmg`, `.zip` | macOS on Apple silicon |
| `agent-sessions-mac-x64.dmg`, `.zip` | macOS on Intel. Built on the same Apple silicon runner and never run on an Intel Mac in CI. |
| `agent-sessions-win-x64.exe` | Windows x64 (NSIS installer) |
| `agent-sessions-linux-x86_64.AppImage` | Linux x64 |
| `agent-sessions-linux-amd64.deb` | Debian and Ubuntu x64 |
| `latest-mac.yml`, `latest.yml`, `latest-linux.yml` | Update metadata. The installed app reads these to find a newer version and its hash. |
| `*.blockmap` | Lets the updater download only the changed parts of an installer |
| `SHA256SUMS` | SHA-256 of every file above |

electron-builder names the Linux arch the way each format expects, so the AppImage says `x86_64` and the deb says `amd64`.

When the five secrets below are set, the workflow signs both macOS apps with the Developer ID certificate, notarizes them, and checks each with `spctl`. With none set, it builds an ad-hoc signed app that is not notarized, and only a draft release is allowed, since installed apps refuse an update signed by anyone else. With only some set, the job fails, so a typo cannot ship an unsigned build by accident. Windows and Linux builds are unsigned.

To build the installers for your own OS locally, run `pnpm dist`. On a Mac without the certificate, run `CSC_IDENTITY_AUTO_DISCOVERY=false pnpm dist`. The files land in `dist/`.

## Cut a release

1. Check that CI passed on the newest commit of `main`. The workflow refuses to release a commit whose CI did not pass.
2. Start the workflow. Raise the patch version with

   ```sh
   gh workflow run release.yml -f bump=patch
   ```

   Use `bump=minor` or `bump=major` for a bigger step. In the browser, open Actions, then Release, then Run workflow.
3. Watch it with `gh run watch`. It takes about 5 minutes.
4. Run `git pull`. The workflow committed the new version to `main` as `chore(release): <version>` and tagged it.
5. Rewrite the release notes for the people who install the app. `scripts/release-notes.sh` drafts them from the `feat`, `fix`, and `perf` commit subjects since the previous tag. It leaves out the `site` and `demo` scopes, and it misses an app change committed under another type or scope. Open with what changed for users, then edit with `gh release edit v<version> --notes-file notes.md`. To preview a draft before releasing, run `scripts/release-notes.sh HEAD`.

The workflow runs these jobs in order. Each one stops the release if it fails.

| Job | What it does |
| --- | --- |
| Bump the version and tag | Runs `npm version` on `package.json`, commits it, tags `v<version>`, and pushes both together. If `main` moved after the run started, it pushes neither. |
| Build | Builds each platform from the tag. On macOS it checks that Gatekeeper reports the app as `Notarized Developer ID`. |
| Publish the GitHub release | Checks that every file in the table above is present and that each `latest*.yml` names the new version. Uploads them to a draft with notes from `scripts/release-notes.sh`, writes `SHA256SUMS`, then publishes it as the latest release. |
| Update the Homebrew tap | Runs `.github/workflows/tap.yml`, which renders `packaging/homebrew/agent-sessions.rb` with the new version and both dmg hashes into `Casks/agent-sessions.rb` in [karlhsueh/homebrew-tap](https://github.com/karlhsueh/homebrew-tap) and pushes it. |

Publishing offers the update. Installed apps from 0.1.4 on read the update metadata of the latest published release and show an Update button.

To look over a release before anyone can see it, run with `-f draft=true`. The workflow stops at the draft and skips the tap. Publish it with `gh release edit v<version> --draft=false --latest`, which also runs the tap workflow. To run the tap workflow again for a tag, use `gh workflow run tap.yml -f tag=v0.1.4`.

If a build fails, fix the cause and run `gh run rerun <run-id> --failed`. The version commit and tag stay, and the rerun builds the same tag. The workflow never replaces the files of a published release. To fix a published release, run the workflow again for the next version.

`packaging/homebrew/agent-sessions.rb` is the cask template. Each release overwrites the tap's copy with it, so change the cask here, never in the tap.

Users can check a download with `shasum -a 256 -c SHA256SUMS --ignore-missing`.

## One-time setup of the secrets

The workflow reads five repository secrets. GitHub encrypts them and never shows them again, so keep your own copies in a password manager. Run the `gh` commands from this repo's folder, or add `-R karlhsueh/agent-sessions`.

| Secret | Holds |
| --- | --- |
| `CSC_LINK` | The Developer ID Application certificate and its private key, as a base64 `.p12` |
| `CSC_KEY_PASSWORD` | The password you gave the `.p12` on export |
| `APPLE_API_KEY` | The contents of the App Store Connect API key file `AuthKey_<KEY_ID>.p8` |
| `APPLE_API_KEY_ID` | The key's ID, 10 characters |
| `APPLE_API_ISSUER` | The issuer ID, a UUID |

`APPLE_API_KEY` holds the file's text, not a path. The workflow writes it to a temporary `.p8` file on the runner and points electron-builder at that file.

### Before you start

- Sign in at [developer.apple.com/account](https://developer.apple.com/account) and accept any updated agreement shown in the banner. Until you do, Apple refuses certificate and key requests with "PLA Update available".
- Check Membership details. Only the Account Holder can create a Developer ID certificate. An Individual enrollment makes you the Account Holder. In an Organization enrollment, ask the Account Holder to create the certificate and send you the `.p12`.

### Developer ID certificate

Do these steps on one Mac. Keychain Access creates the private key on the Mac that makes the request, and the certificate works only alongside that key.

1. Create a certificate request. Open Keychain Access. Spotlight may open the Passwords app instead, so if it does, open `/System/Library/CoreServices/Applications/Keychain Access.app`. From the Keychain Access menu, choose Certificate Assistant, then Request a Certificate From a Certificate Authority. Enter your Apple ID email and a name, leave CA Email empty, choose Saved to disk, and save the `.certSigningRequest`.
2. At [Certificates, IDs & Profiles](https://developer.apple.com/account/resources/certificates/list), click +, choose Developer ID Application, pick the G2 Sub-CA, upload the request, and download the `.cer`.
3. Double-click the `.cer` to install it in the login keychain. Then check that macOS can sign with it.

   ```sh
   security find-identity -v -p codesigning
   ```

   It should list `Developer ID Application: <your name> (<TEAM_ID>)` as 1 valid identity. If it shows 0 valid identities while `security find-identity -p codesigning` lists the certificate, the Mac lacks Apple's intermediate certificate. Download [Developer ID - G2](https://www.apple.com/certificateauthority/DeveloperIDG2CA.cer) from Apple and double-click it.

   Xcode can do steps 1 to 3 in Settings, then Accounts, then Manage Certificates. It sometimes shows an Account Holder as Admin and refuses with "This operation can only be performed by the Account Holder". The website steps above avoid that.
4. In Keychain Access, open the login keychain, then My Certificates. Right-click the Developer ID Application certificate and choose Export. Save it as `DeveloperID.p12` with a strong password. The certificate must show a disclosure triangle with its private key, or the export has no key.
5. Check that the file opens with that password before you store it. Keychain Access exports with an older cipher, so OpenSSL needs `-legacy`.

   ```sh
   openssl pkcs12 -legacy -in DeveloperID.p12 -noout && echo PASSWORD-OK
   ```

6. Store both secrets. The second command prompts for the password, so paste it from your password manager rather than typing it.

   ```sh
   base64 -i DeveloperID.p12 | gh secret set CSC_LINK
   gh secret set CSC_KEY_PASSWORD
   ```

### App Store Connect API key

1. In [App Store Connect](https://appstoreconnect.apple.com), open Users and Access, then Integrations, then App Store Connect API. Under Team Keys, click + and create a key with the Developer role. Any name works.
2. Download `AuthKey_<KEY_ID>.p8`. Apple lets you download it only once.
3. Copy the Key ID from the key's row and the Issuer ID from above the table.
4. Store the three secrets.

   ```sh
   gh secret set APPLE_API_KEY < AuthKey_ABC123DEFG.p8
   gh secret set APPLE_API_KEY_ID --body ABC123DEFG
   gh secret set APPLE_API_ISSUER --body 00000000-0000-0000-0000-000000000000
   ```

5. Check that all five exist with `gh secret list`.

Keep the `.p12`, its password, the `.p8`, the Key ID, and the Issuer ID in a password manager, then move the local copies to the Trash with `trash DeveloperID.p12 AuthKey_ABC123DEFG.p8`.

### Homebrew tap deploy key

The tap workflow pushes to another repository, so it needs a deploy key. A deploy key is an SSH key that can write to `karlhsueh/homebrew-tap` and nothing else. It is not tied to a GitHub account and does not expire. Without it, the workflow fails and the cask keeps the old version.

1. Create a key pair in a temporary folder.

   ```sh
   ssh-keygen -t ed25519 -N '' -C 'agent-sessions tap workflow' -f /tmp/tap-deploy
   ```

2. Give the public key write access to the tap, and store the private key as a secret in this repo.

   ```sh
   gh repo deploy-key add /tmp/tap-deploy.pub -R karlhsueh/homebrew-tap --allow-write --title 'agent-sessions tap workflow'
   gh secret set HOMEBREW_TAP_DEPLOY_KEY < /tmp/tap-deploy
   trash /tmp/tap-deploy /tmp/tap-deploy.pub
   ```

To rotate the key, delete it under the tap's Settings, then Deploy keys, and repeat both steps. Nothing else needs a copy of the private key.

### When the macOS job fails

| Log line | Cause | Fix |
| --- | --- | --- |
| `Only N of the 5 macOS signing secrets are set` | A secret is missing or misnamed | Compare `gh secret list` with the table above. |
| `MAC verification failed during PKCS12 import (wrong password?)` | `CSC_KEY_PASSWORD` does not open the `.p12` in `CSC_LINK` | Run step 5 of the certificate setup, then set both secrets again from the same file. |
| A notarization error that names the API key | The key was revoked, or the key, Key ID, and Issuer ID do not belong together | Create a new key and set all three `APPLE_API_*` secrets again. |

After fixing secrets, rerun the failed job with `gh run rerun <run-id> --failed`. A rerun reads the current secrets.

## What users see from unsigned builds

- Windows SmartScreen warns about an unknown publisher. Click More info, then Run anyway.
- The AppImage needs `chmod +x` before it runs. The deb installs with `sudo apt install ./agent-sessions-linux-amd64.deb`.
- macOS blocks an ad-hoc signed build on first open. Open System Settings, then Privacy & Security, and click Open Anyway.
