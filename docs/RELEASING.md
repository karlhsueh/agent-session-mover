---
summary: How to cut a release, what the release workflow builds, and the one-time setup of the macOS signing and notarization secrets.
read_when:
  - Cutting a release or tagging a version
  - Changing .github/workflows/release.yml or the electron-builder config in package.json
  - Adding or rotating the Apple signing or notarization secrets
---

# Releasing

Pushing a tag `v<version>` runs `.github/workflows/release.yml`. It builds the app on macOS, Windows, and Linux runners and attaches the installers to a draft GitHub release. Nothing is public until you publish the draft.

| File | Platform |
| --- | --- |
| `agent-sessions-<version>-mac-arm64.dmg`, `.zip` | macOS on Apple silicon |
| `agent-sessions-<version>-mac-x64.dmg`, `.zip` | macOS on Intel |
| `agent-sessions-<version>-win-x64.exe` | Windows x64 (NSIS installer) |
| `agent-sessions-<version>-linux-x86_64.AppImage` | Linux x64 |
| `agent-sessions-<version>-linux-amd64.deb` | Debian and Ubuntu x64 |
| `SHA256SUMS` | SHA-256 of every file above |

electron-builder names the Linux arch the way each format expects, so the AppImage says `x86_64` and the deb says `amd64`.

The macOS app is signed with the Developer ID certificate and notarized when the five secrets below are set. With none set, the workflow still builds. The app is then ad-hoc signed and not notarized, and the job log shows an "Unsigned macOS build" warning. With only some set, the job fails, so a typo cannot ship an unsigned build by accident. Windows and Linux builds are unsigned. There is no auto-update.

To build the installers for your own OS locally, run `pnpm dist`. On a Mac without the certificate, run `CSC_IDENTITY_AUTO_DISCOVERY=false pnpm dist`. The files land in `dist/`.

## Cut a release

1. Set `"version"` in `package.json` to the new version, such as `0.1.0`. The workflow fails when the tag and this field differ.
2. Commit it with `git commit -am "chore(release): 0.1.0"`.
3. Tag and push.

   ```sh
   git tag v0.1.0
   git push origin main v0.1.0
   ```

4. Watch the run with `gh run watch`. Check the macOS job log for the signing line or the unsigned warning.
5. Review the draft with `gh release view v0.1.0`. Download the installer for each OS you can and open it. On a Mac, open the dmg and check notarization of the app inside it with `spctl -a -vv "/Volumes/<dmg volume>/Agent Sessions.app"`. A notarized app reports `source=Notarized Developer ID`.

6. Edit the generated notes if needed, then publish with `gh release edit v0.1.0 --draft=false`.

Re-running the workflow on the same tag replaces the files on the draft. It refuses to touch a release that is already published. To fix a published release, bump the version and tag again.

Users can check a download with `shasum -a 256 -c SHA256SUMS --ignore-missing`.

## One-time setup of the macOS secrets

The workflow reads five repository secrets. Run the `gh` commands from this repo's folder, or add `-R karlhsueh/agent-sessions`.

| Secret | Holds |
| --- | --- |
| `CSC_LINK` | The Developer ID Application certificate and its private key, as a base64 `.p12` |
| `CSC_KEY_PASSWORD` | The password you gave the `.p12` on export |
| `APPLE_API_KEY` | The contents of the App Store Connect API key file `AuthKey_<KEY_ID>.p8` |
| `APPLE_API_KEY_ID` | The key's ID, 10 characters |
| `APPLE_API_ISSUER` | The issuer ID, a UUID |

`APPLE_API_KEY` holds the file's text, not a path. The workflow writes it to a temporary `.p8` file on the runner and points electron-builder at that file.

### Developer ID certificate

Only the Apple Developer account holder can create a Developer ID Application certificate.

1. In Xcode, open Settings, then Accounts. Select your team, click Manage Certificates, click +, and choose Developer ID Application. Xcode creates the private key in your login keychain and installs the certificate.

   Without Xcode, open Keychain Access, choose Certificate Assistant, then Request a Certificate From a Certificate Authority, and save the request to disk. Upload it at developer.apple.com under Certificates, IDs & Profiles, as a Developer ID Application certificate with the G2 Sub-CA. Download the `.cer` and double-click it to install it beside its key.

2. In Keychain Access, open the login keychain, then My Certificates. Right-click "Developer ID Application: <your name> (<TEAM_ID>)" and choose Export. Save it as `DeveloperID.p12` with a strong password. The certificate must show a disclosure triangle with its private key, or the export has no key.
3. Store both secrets.

   ```sh
   base64 -i DeveloperID.p12 | gh secret set CSC_LINK
   gh secret set CSC_KEY_PASSWORD
   ```

   The second command prompts for the password.

### App Store Connect API key

1. In App Store Connect, open Users and Access, then Integrations, then App Store Connect API. Under Team Keys, click + and create a key with the Developer role.
2. Download `AuthKey_<KEY_ID>.p8`. Apple lets you download it only once.
3. Copy the Key ID from the key's row and the Issuer ID from above the table.
4. Store the three secrets.

   ```sh
   gh secret set APPLE_API_KEY < AuthKey_ABC123DEFG.p8
   gh secret set APPLE_API_KEY_ID --body ABC123DEFG
   gh secret set APPLE_API_ISSUER --body 00000000-0000-0000-0000-000000000000
   ```

5. Check that all five exist with `gh secret list`.

Keep the `.p12`, its password, and the `.p8` in a password manager, then move the local copies to the Trash with `trash DeveloperID.p12 AuthKey_ABC123DEFG.p8`.

## What users see from unsigned builds

- Windows SmartScreen warns about an unknown publisher. Click More info, then Run anyway.
- The AppImage needs `chmod +x` before it runs. The deb installs with `sudo apt install ./agent-sessions-<version>-linux-amd64.deb`.
- An ad-hoc signed Mac build is blocked on first open. Open System Settings, then Privacy & Security, and click Open Anyway.
