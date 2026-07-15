/**
 * Normalize the endpoint accepted by `borg assimilate --host <host>`.
 *
 * Bare hosts default to HTTPS, including loopback: the ratified v1 server
 * architecture requires TLS for every authority. Plaintext endpoints are
 * rejected even on loopback so enrollment credentials never cross HTTP.
 */
export function normalizeServerEndpoint(input: string): string {
  const raw = input.trim();
  if (!raw) throw new Error('--host requires a host or URL');

  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw);
  let url: URL;
  try {
    url = new URL(hasScheme ? raw : `https://${raw}`);
  } catch {
    // Never echo the raw input: malformed URLs may contain pasted credentials.
    throw new Error('invalid Borg server endpoint');
  }

  if (url.protocol !== 'https:') {
    throw new Error('Borg server endpoints must use https://');
  }
  if (url.username || url.password) {
    throw new Error('Borg server endpoints must not contain credentials');
  }
  if (url.search || url.hash) {
    throw new Error('Borg server endpoints must not contain a query string or fragment');
  }
  if (url.pathname !== '/' && url.pathname !== '') {
    throw new Error('Borg server endpoints must not contain a path');
  }
  if (url.hostname === '0.0.0.0' || url.hostname === '[::]') {
    throw new Error('Borg server endpoints must not use a wildcard address');
  }

  return url.origin;
}
