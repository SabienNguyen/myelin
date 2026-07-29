import { notarize } from '@electron/notarize';

// electron-builder `afterSign` hook: submit the signed macOS .app to Apple for notarization, which
// is what actually clears the Gatekeeper "unidentified developer" wall (signing alone doesn't).
//
// Opt-in, never required: if the three Apple credentials aren't all present in the environment, this
// no-ops and says so, so a local build and an unsigned CI build both still succeed. Signing is
// turned on purely by adding the secrets — see docs/SIGNING.md.
export default async function notarizing(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const { APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID } = process.env;
  if (!APPLE_ID || !APPLE_APP_SPECIFIC_PASSWORD || !APPLE_TEAM_ID) {
    console.log(
      'notarize: APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID not all set — '
      + 'shipping without notarization (macOS will warn on first launch).',
    );
    return;
  }

  const appPath = `${context.appOutDir}/${context.packager.appInfo.productFilename}.app`;
  console.log(`notarize: submitting ${appPath} to Apple — this can take a few minutes…`);
  await notarize({
    appBundleId: context.packager.appInfo.id,
    appPath,
    appleId: APPLE_ID,
    appleIdPassword: APPLE_APP_SPECIFIC_PASSWORD,
    teamId: APPLE_TEAM_ID,
  });
  console.log('notarize: accepted by Apple, and stapled to the app.');
}
