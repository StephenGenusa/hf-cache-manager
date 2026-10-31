// Hub endpoint, redirect and token rules. Pure functions; no network access here.

export interface HubEndpoint {
  /** scheme://host:port; what the token check compares. */
  origin: string;
  /** origin plus the HF_ENDPOINT path prefix, no trailing slash; URLs are built from this. */
  base: string;
  /** The endpoint is plain http on 127.0.0.1, localhost or [::1] (tests, local mirrors). */
  loopbackHttp: boolean;
}

const DEFAULT_ENDPOINT = 'https://huggingface.co';
export const MAX_REDIRECTS = 5;

export const isLoopbackHost = (hostname: string): boolean => hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]';

function parseUrl(text: string): URL | null {
  try {
    return new URL(text);
  } catch {
    return null;
  }
}

export function endpointFromEnv(env: NodeJS.ProcessEnv): { endpoint: HubEndpoint; offline: boolean } | { error: string } {
  const offline = ['1', 'true', 'yes', 'on'].includes((env.HF_HUB_OFFLINE ?? '').trim().toLowerCase());
  const raw = (env.HF_ENDPOINT ?? '').trim().replace(/\/+$/, '') || DEFAULT_ENDPOINT;
  const url = parseUrl(raw);
  if (!url || (url.protocol !== 'https:' && url.protocol !== 'http:')) {
    return { error: `HF_ENDPOINT must be an http(s) URL: '${raw}'` };
  }
  if (url.username || url.password || url.search || url.hash || /[?#]/.test(raw)) {
    return { error: `HF_ENDPOINT must not contain credentials, a query or a fragment: '${raw}'` };
  }
  const loopbackHttp = url.protocol === 'http:' && isLoopbackHost(url.hostname);
  if (url.protocol === 'http:' && !loopbackHttp) {
    return { error: 'HF_ENDPOINT must use https (plain http is only allowed for 127.0.0.1 / localhost / [::1])' };
  }
  return { endpoint: { origin: url.origin, base: url.origin + url.pathname.replace(/\/+$/, ''), loopbackHttp }, offline };
}

/** The token goes only to the configured endpoint's exact origin, never to a redirect target. */
export function authHeader(url: string, ep: HubEndpoint, token: string | null): Record<string, string> {
  if (!token) return {};
  const u = parseUrl(url);
  return u && u.origin === ep.origin && (u.protocol === 'https:' || ep.loopbackHttp) ? { Authorization: `Bearer ${token}` } : {};
}

export function checkRedirect(
  from: string,
  location: string,
  ep: HubEndpoint,
  hop: number,
): { ok: true; url: string } | { ok: false; reason: string } {
  if (hop > MAX_REDIRECTS) return { ok: false, reason: `Too many redirects (more than ${MAX_REDIRECTS})` };
  const base = parseUrl(from);
  let target: URL | null = null;
  if (base) {
    try {
      target = new URL(location, base);
    } catch {
      target = null;
    }
  }
  if (!base || !target) return { ok: false, reason: `Invalid redirect location: '${location}'` };
  if (target.username || target.password) return { ok: false, reason: 'Redirect carries credentials' };
  if (target.protocol === 'https:') return { ok: true, url: target.href };
  if (target.protocol === 'http:') {
    if (base.protocol !== 'http:') return { ok: false, reason: 'Redirect from HTTPS to HTTP refused' };
    if (ep.loopbackHttp && isLoopbackHost(target.hostname)) return { ok: true, url: target.href };
    return { ok: false, reason: `Redirect to non-HTTPS host refused: ${target.host}` };
  }
  return { ok: false, reason: `Redirect to unsupported scheme refused: ${target.protocol}` };
}
