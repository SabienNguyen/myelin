import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';

const NOTIFY_SEND_PATH = '/usr/bin/notify-send';
let warned = false;

/** Wraps notify-send. Gracefully no-ops (with a one-time console warning) if the binary is absent. */
export function sendNotification(title: string, body: string): void {
  if (!existsSync(NOTIFY_SEND_PATH)) {
    if (!warned) {
      console.warn('[notify] notify-send not found at', NOTIFY_SEND_PATH, '— desktop notifications disabled');
      warned = true;
    }
    return;
  }
  execFile(NOTIFY_SEND_PATH, [title, body], (err) => {
    if (err) console.error('[notify] notify-send failed:', err);
  });
}
