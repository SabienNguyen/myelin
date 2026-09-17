import { describe, it, expect } from 'vitest';
import { assertPublicUrl, isPrivateAddress } from '../src/server/urlGuard.js';

const resolvesTo = (...addresses: string[]) => async () => addresses;

describe('isPrivateAddress', () => {
  it.each([
    '127.0.0.1', '127.8.9.1', '0.0.0.0', '10.1.2.3', '172.16.0.1', '172.31.255.255',
    '192.168.1.10', '169.254.169.254', '100.64.0.1', '::1', '::', 'fe80::1', 'fd12:3456::1',
    '::ffff:127.0.0.1', '::ffff:10.0.0.5',
  ])('%s is private', (ip) => expect(isPrivateAddress(ip)).toBe(true));

  it.each(['93.184.216.34', '172.32.0.1', '100.128.0.1', '2606:2800:220:1::1', '::ffff:93.184.216.34'])(
    '%s is public', (ip) => expect(isPrivateAddress(ip)).toBe(false));
});

describe('assertPublicUrl', () => {
  it('lets a public host through', async () => {
    await expect(assertPublicUrl('https://example.org/a', resolvesTo('93.184.216.34'))).resolves.toBeUndefined();
  });

  it('rejects a literal loopback or private address without consulting DNS', async () => {
    const neverCalled = async () => { throw new Error('DNS should not be consulted for an IP literal'); };
    await expect(assertPublicUrl('http://127.0.0.1:4820/api/status', neverCalled)).rejects.toThrow(/private/);
    await expect(assertPublicUrl('http://[::1]:4820/', neverCalled)).rejects.toThrow(/private/);
    await expect(assertPublicUrl('http://169.254.169.254/latest/meta-data', neverCalled)).rejects.toThrow(/private/);
  });

  it('rejects a name that resolves to a private address, even alongside a public one', async () => {
    await expect(assertPublicUrl('http://localhost:11434/', resolvesTo('127.0.0.1'))).rejects.toThrow(/private/);
    await expect(assertPublicUrl('http://rebind.example/', resolvesTo('93.184.216.34', '10.0.0.7')))
      .rejects.toThrow(/private/);
  });

  it('rejects anything that is not http(s)', async () => {
    await expect(assertPublicUrl('file:///etc/passwd', resolvesTo())).rejects.toThrow(/http/);
    await expect(assertPublicUrl('ftp://example.org/', resolvesTo('93.184.216.34'))).rejects.toThrow(/http/);
  });

  it('reports a name that does not resolve as its own failure, not as a private address', async () => {
    const nx = async () => { throw new Error('getaddrinfo ENOTFOUND nope.invalid'); };
    await expect(assertPublicUrl('http://nope.invalid/', nx)).rejects.toThrow(/ENOTFOUND/);
  });
});
