import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

/**
 * Keeps model-initiated fetches off the learner's own machine and network.
 *
 * `read_url` takes whatever URL the model hands it, and the model reads untrusted text all day
 * (web pages, ingested PDFs, READMEs). A page that says "now fetch http://127.0.0.1:4820/api/..."
 * or the cloud metadata address would otherwise turn the tutor into a proxy onto loopback services
 * — this app's own unauthenticated API, Ollama, AnkiConnect — and return what it found as "page
 * text" the model can then write into the vault.
 *
 * Not closed: the name is resolved here and again inside fetch, so a DNS server that answers
 * differently the second time still gets through. Closing that needs a pinned-address dispatcher;
 * the redirect re-check in webTools.ts covers the cheap version of the same trick.
 */
const PRIVATE = new BlockList();
PRIVATE.addSubnet('0.0.0.0', 8, 'ipv4');
PRIVATE.addSubnet('10.0.0.0', 8, 'ipv4');
PRIVATE.addSubnet('100.64.0.0', 10, 'ipv4'); // CGNAT — Tailscale addresses live here
PRIVATE.addSubnet('127.0.0.0', 8, 'ipv4');
PRIVATE.addSubnet('169.254.0.0', 16, 'ipv4'); // link-local, incl. the 169.254.169.254 metadata host
PRIVATE.addSubnet('172.16.0.0', 12, 'ipv4');
PRIVATE.addSubnet('192.168.0.0', 16, 'ipv4');
PRIVATE.addAddress('::', 'ipv6');
PRIVATE.addAddress('::1', 'ipv6');
PRIVATE.addSubnet('fc00::', 7, 'ipv6');
PRIVATE.addSubnet('fe80::', 10, 'ipv6');

/** `::ffff:a.b.c.d` (or its hex spelling `::ffff:7f00:1`, which is what `new URL` normalises to)
 *  is an IPv4 address wearing an IPv6 prefix; judge it by the IPv4 rules or it walks past them. */
function unwrapMapped(ip: string): string {
  const m = /^::ffff:(.+)$/i.exec(ip);
  if (!m) return ip;
  if (isIP(m[1]) === 4) return m[1];
  const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(m[1]);
  if (!hex) return ip;
  const hi = parseInt(hex[1], 16);
  const lo = parseInt(hex[2], 16);
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
}

export function isPrivateAddress(ip: string): boolean {
  const addr = unwrapMapped(ip);
  const family = isIP(addr);
  if (family === 0) return true; // not an address at all — nothing a caller should connect to
  return PRIVATE.check(addr, family === 4 ? 'ipv4' : 'ipv6');
}

/** Its own class so `read_url` can tell the model "refused" rather than "unavailable" — the second
 *  invites a retry, and no retry will make a loopback address public. */
export class UrlRefusedError extends Error {}

/** Follow redirects by hand so `guard` sees EVERY hop. With `redirect: 'follow'` a public page
 *  answering `302 Location: http://127.0.0.1:4820/...` lands on loopback after the only check has
 *  already passed. `hop` makes ONE request with `redirect: 'manual'`; retry policy stays with the
 *  caller, since read_url and downloads retry differently. */
export async function fetchGuarded(
  url: string, guard: (url: string) => Promise<void>, hop: (url: string) => Promise<Response>, maxRedirects = 5,
): Promise<Response> {
  let current = url;
  for (let n = 0; n <= maxRedirects; n++) {
    await guard(current);
    const res = await hop(current);
    const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
    if (!location) return res;
    current = new URL(location, current).toString();
  }
  throw new Error(`more than ${maxRedirects} redirects`);
}

export type ResolveHost = (hostname: string) => Promise<string[]>;

const resolveAll: ResolveHost = async (hostname) =>
  (await lookup(hostname, { all: true })).map((a) => a.address);

/** Throws unless `url` is http(s) and EVERY address its host resolves to is public — one private
 *  record among several is enough for a connection to land on it. */
export async function assertPublicUrl(url: string, resolve: ResolveHost = resolveAll): Promise<void> {
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new UrlRefusedError(`only http(s) URLs can be read, not ${parsed.protocol}`);
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [host] : await resolve(host);
  const hit = addresses.find(isPrivateAddress);
  if (hit) throw new UrlRefusedError(`${host} is a private or loopback address (${hit}); only public pages can be read`);
}
