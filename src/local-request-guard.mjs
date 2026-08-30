// Shared local-request trust primitives for the two loopback surfaces:
// the isolated 3210 hub API (src/hub/index.mjs) and the 3080→3210
// official-web bridge (src/official-web-bridge.mjs). One implementation keeps
// the two guards from drifting apart again.
//
// Trust model (see docs/ui-surfaces.md): both surfaces are loopback-only and
// have no bearer token by design — every process running as the local user is
// inside the trust boundary. The guards exist to keep off-machine browsers,
// DNS-rebinding pages, and cross-machine proxies out, not to authenticate
// local users. `localRequestCore` proves the peer is this machine (loopback
// socket, local Host header, browser fetch-metadata pass); each surface then
// layers its own Origin policy on top — the hub accepts any loopback origin
// because the 3080 panel calls it cross-port, while the bridge requires an
// exact authority match because it only serves its own same-origin client.

function isIpv4Loopback(a) { return /^127(\.\d{1,3}){3}$/.test(a); }

export function isLoopbackAddress(address) {
  if (!address) return false;
  const n = address.toLowerCase().split('%', 1)[0];
  if (n === '::1' || isIpv4Loopback(n)) return true;
  if (!n.startsWith('::ffff:')) return false;
  return isIpv4Loopback(n.slice(7));
}

export function isLocalHostname(hostname) {
  return hostname === 'localhost' || hostname === '::1' || hostname === '[::1]' || isIpv4Loopback(hostname);
}

/**
 * Core of both guards: loopback peer, loopback Host header, and (when the
 * client is a browser) a same-origin/none fetch-metadata request. Returns
 * false for anything that cannot be proven local.
 */
export function localRequestCore(req) {
  if (!isLoopbackAddress(req?.socket?.remoteAddress)) return false;
  const host = typeof req?.headers?.host === 'string' ? req.headers.host.trim().toLowerCase() : '';
  if (!host) return false;
  let authority;
  try { authority = new URL(`http://${host}`); } catch { return false; }
  if (!isLocalHostname(authority.hostname.toLowerCase())) return false;
  const fetchSite = String(req?.headers?.['sec-fetch-site'] ?? '').toLowerCase();
  if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') return false;
  return true;
}

/** Hub Origin policy: an Origin, when present, must name a loopback host. */
export function originLoopback(originHeader) {
  if (typeof originHeader !== 'string') return false;
  let parsed;
  try { parsed = new URL(originHeader); } catch { return false; }
  return isLocalHostname(parsed.hostname.toLowerCase());
}

/** Bridge Origin policy: the Origin authority must equal the request authority. */
export function originAuthorityMatches(originHeader, host) {
  if (!originLoopback(originHeader)) return false;
  const parsed = new URL(originHeader);
  return parsed.host.toLowerCase() === String(host).trim().toLowerCase();
}
