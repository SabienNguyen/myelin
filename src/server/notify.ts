import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';

const NOTIFY_SEND_PATH = '/usr/bin/notify-send';
let warned = false;

/** Wraps notify-send. Resolves true only when the notification was actually delivered — callers
 * use this to decide whether to mark their once-per-event ledgers. A send attempted while
 * headless (boot-before-login under linger: no display/D-Bus yet) fails; returning false lets
 * the caller retry on a later tick instead of silently consuming the notification. */
export function sendNotification(title: string, body: string): Promise<boolean> {
  if (!existsSync(NOTIFY_SEND_PATH)) {
    if (!warned) {
      console.warn('[notify] notify-send not found at', NOTIFY_SEND_PATH, '— desktop notifications disabled');
      warned = true;
    }
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    execFile(NOTIFY_SEND_PATH, [title, body], (err) => {
      if (err) {
        console.error('[notify] notify-send failed (will retry next tick):', err.message);
        resolve(false);
      } else {
        resolve(true);
      }
    });
  });
}
