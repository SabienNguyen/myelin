// notify.ts's whole contract is its RETURN VALUE: the scheduler marks its once-per-event ledger
// only on true, so a false that should be true means silent double-notifications later, and a
// true that should be false means a decay warning consumed while nobody was logged in to see it.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const execFile = vi.fn();
const existsSync = vi.fn();
vi.mock('node:child_process', () => ({ execFile: (...a: any[]) => execFile(...a) }));
vi.mock('node:fs', () => ({ existsSync: (...a: any[]) => existsSync(...a) }));

beforeEach(() => { execFile.mockReset(); existsSync.mockReset(); });

describe('sendNotification', () => {
  it('resolves true only when notify-send actually ran clean', async () => {
    existsSync.mockReturnValue(true);
    execFile.mockImplementation((_cmd: string, _args: string[], cb: (e: Error | null) => void) => cb(null));
    const { sendNotification } = await import('../src/server/notify.js');
    await expect(sendNotification('t', 'b')).resolves.toBe(true);
    expect(execFile).toHaveBeenCalledWith('/usr/bin/notify-send', ['t', 'b'], expect.any(Function));
  });

  it('a failed send (headless boot, no D-Bus) resolves false so the caller retries', async () => {
    existsSync.mockReturnValue(true);
    execFile.mockImplementation((_c: string, _a: string[], cb: (e: Error | null) => void) =>
      cb(new Error('Failed to connect to the bus')));
    vi.resetModules();
    const { sendNotification } = await import('../src/server/notify.js');
    await expect(sendNotification('t', 'b')).resolves.toBe(false);
  });

  it('a machine without notify-send resolves false and warns exactly once', async () => {
    existsSync.mockReturnValue(false);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.resetModules();
    const { sendNotification } = await import('../src/server/notify.js');
    await expect(sendNotification('a', 'b')).resolves.toBe(false);
    await expect(sendNotification('c', 'd')).resolves.toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(execFile).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
