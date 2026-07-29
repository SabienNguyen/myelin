# Code signing the release builds

The release workflow (`.github/workflows/release.yml`) signs the macOS and Windows installers when
the right repository secrets are present, and otherwise builds them **unsigned** — nothing here is
required to cut a release. Linux (AppImage) is never signed; it isn't gatekept.

Add secrets under **Settings → Secrets and variables → Actions**. Add only the platform(s) you have
a certificate for; the other stays unsigned.

## macOS — sign + notarize

Both are needed to clear Gatekeeper's "unidentified developer" wall: signing alone isn't enough,
Apple must also notarize the app. Requires an **Apple Developer Program** membership ($99/yr).

1. In the Apple Developer portal, create a **Developer ID Application** certificate and export it
   from Keychain Access as a `.p12` with a password.
2. Base64-encode it: `base64 -i cert.p12 | pbcopy`.
3. Create an **app-specific password** for your Apple ID at <https://appleid.apple.com> → Sign-In and
   Security → App-Specific Passwords.

| Secret | Value |
| --- | --- |
| `MACOS_CSC_LINK` | base64 of the `.p12` |
| `MACOS_CSC_KEY_PASSWORD` | the `.p12` export password |
| `APPLE_ID` | your Apple ID email |
| `APPLE_APP_SPECIFIC_PASSWORD` | the app-specific password |
| `APPLE_TEAM_ID` | your 10-character Team ID |

Notarization is done by `electron/notarize.mjs` (an `afterSign` hook); it no-ops if the `APPLE_*`
secrets are absent, so an unsigned build still succeeds. `mac.hardenedRuntime` is already set in
`package.json` (Apple requires it for notarization).

## Windows

The plain-`.pfx` era is mostly over: since June 2023, **new OV/EV certificates must live on an HSM**,
so they can't be exported to a file. Two paths:

### A. Legacy exportable `.pfx` (only if you already hold one)

Base64-encode it and set:

| Secret | Value |
| --- | --- |
| `WINDOWS_CSC_LINK` | base64 of the `.pfx` |
| `WINDOWS_CSC_KEY_PASSWORD` | the `.pfx` password |

That's all the wired workflow needs — electron-builder signs from `CSC_LINK` on the Windows runner.

### B. Azure Trusted Signing (recommended for a new cert, ~$10/mo)

This is HSM-backed cloud signing and does **not** use `CSC_LINK`. It needs one more change that isn't
wired yet: add a `win.azureSignOptions` block to `package.json`'s `build` (electron-builder ≥ 26
supports it) plus the Azure env (`AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, and the
`endpoint` / `codeSigningAccountName` / `certificateProfileName`). See the electron-builder
"Azure Trusted Signing" docs. Ping if you set up an account and I'll wire it.

**Reputation note:** an **EV** certificate clears Windows SmartScreen immediately; an **OV** one
earns trust over downloads and time. Self-signed does nothing for distribution.

## Verifying it worked

- macOS: `spctl -a -vvv /Applications/Myelin.app` should report `accepted` / `source=Notarized
  Developer ID`.
- Windows: right-click the `.exe` → Properties → **Digital Signatures** should list your publisher.
