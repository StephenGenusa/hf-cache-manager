import { describe, expect, test } from 'vitest';
import { authHeader, checkRedirect, endpointFromEnv, type HubEndpoint } from '../../src/main/hub/policy';

const def: HubEndpoint = { origin: 'https://huggingface.co', base: 'https://huggingface.co', loopbackHttp: false };
const loop: HubEndpoint = { origin: 'http://127.0.0.1:8080', base: 'http://127.0.0.1:8080', loopbackHttp: true };

describe('endpointFromEnv', () => {
  test('default endpoint', () =>
    expect(endpointFromEnv({})).toEqual({ endpoint: def, offline: false }));
  test('trailing slash normalised', () => {
    expect(endpointFromEnv({ HF_ENDPOINT: 'https://hub.example.com/' })).toEqual({
      endpoint: { origin: 'https://hub.example.com', base: 'https://hub.example.com', loopbackHttp: false },
      offline: false,
    });
    expect(endpointFromEnv({ HF_ENDPOINT: ' https://hub.example.com// ' })).toMatchObject({
      endpoint: { origin: 'https://hub.example.com' },
    });
  });
  test('empty HF_ENDPOINT falls back to the default', () =>
    expect(endpointFromEnv({ HF_ENDPOINT: '' })).toMatchObject({ endpoint: def }));
  test('loopback http endpoints', () => {
    expect(endpointFromEnv({ HF_ENDPOINT: 'http://127.0.0.1:8080' })).toEqual({ endpoint: loop, offline: false });
    expect(endpointFromEnv({ HF_ENDPOINT: 'http://localhost:9' })).toMatchObject({
      endpoint: { origin: 'http://localhost:9', base: 'http://localhost:9', loopbackHttp: true },
    });
    expect(endpointFromEnv({ HF_ENDPOINT: 'http://[::1]:9' })).toMatchObject({
      endpoint: { origin: 'http://[::1]:9', loopbackHttp: true },
    });
    expect(endpointFromEnv({ HF_ENDPOINT: 'https://127.0.0.1:9' })).toMatchObject({
      endpoint: { loopbackHttp: false },
    });
  });
  test('plain http is only allowed for loopback', () => {
    for (const bad of ['http://10.0.0.1:9', 'http://hub.example.com', 'http://127.0.0.1.evil.com'])
      expect(endpointFromEnv({ HF_ENDPOINT: bad }), bad).toEqual({
        error: 'HF_ENDPOINT must use https (plain http is only allowed for 127.0.0.1 / localhost / [::1])',
      });
  });
  test('a path prefix is kept in base, origin stays the origin', () => {
    expect(endpointFromEnv({ HF_ENDPOINT: 'https://mirror.example.com/hf/' })).toMatchObject({
      endpoint: { origin: 'https://mirror.example.com', base: 'https://mirror.example.com/hf' },
    });
    expect(endpointFromEnv({ HF_ENDPOINT: 'http://127.0.0.1:5/a/b' })).toMatchObject({
      endpoint: { origin: 'http://127.0.0.1:5', base: 'http://127.0.0.1:5/a/b', loopbackHttp: true },
    });
  });
  test('userinfo, query and fragment are rejected', () => {
    for (const bad of ['https://u:p@hub.example.com', 'https://u@hub.example.com', 'https://h.com/?a=1', 'https://h.com/#f', 'https://h.com?'])
      expect(endpointFromEnv({ HF_ENDPOINT: bad }), bad).toHaveProperty('error');
  });
  test('non-http(s) or unparsable endpoints are errors', () => {
    for (const bad of ['ftp://x.com', 'file:///etc', 'huggingface.co', 'javascript:alert(1)'])
      expect(endpointFromEnv({ HF_ENDPOINT: bad }), bad).toHaveProperty('error');
  });
  test('HF_HUB_OFFLINE', () => {
    for (const v of ['1', 'true', 'TRUE', 'yes', 'ON'])
      expect(endpointFromEnv({ HF_HUB_OFFLINE: v }), v).toMatchObject({ offline: true });
    for (const v of ['0', '', 'false', 'no'])
      expect(endpointFromEnv({ HF_HUB_OFFLINE: v }), v).toMatchObject({ offline: false });
  });
});

describe('authHeader', () => {
  test('cross-host redirect drops Authorization', () =>
    expect(authHeader('https://cdn-lfs.hf.co/x', def, 't')).toEqual({}));
  test('same origin sends the bearer token', () =>
    expect(authHeader('https://huggingface.co/a/b/resolve/main/f', def, 't')).toEqual({
      Authorization: 'Bearer t',
    }));
  test('same host, other port, gets nothing', () => {
    expect(authHeader('http://127.0.0.1:9999/x', loop, 't')).toEqual({});
    expect(authHeader('http://127.0.0.1:8080/x', loop, 't')).toEqual({ Authorization: 'Bearer t' });
  });
  test('other scheme gets nothing', () =>
    expect(authHeader('http://huggingface.co/x', def, 't')).toEqual({}));
  test('no token, empty token or bad url gets nothing', () => {
    expect(authHeader('https://huggingface.co/x', def, null)).toEqual({});
    expect(authHeader('https://huggingface.co/x', def, '')).toEqual({});
    expect(authHeader('not a url', def, 't')).toEqual({});
  });
  test('plain http gets nothing unless the endpoint is loopback http', () => {
    expect(authHeader('http://huggingface.co/x', { ...def, origin: 'http://huggingface.co' }, 't')).toEqual({});
    expect(authHeader('http://10.0.0.1/x', { origin: 'http://10.0.0.1', base: 'http://10.0.0.1', loopbackHttp: false }, 't')).toEqual({});
  });
  test('default port and host case are the same origin', () => {
    expect(authHeader('https://huggingface.co:443/x', def, 't')).toEqual({ Authorization: 'Bearer t' });
    expect(authHeader('HTTPS://HuggingFace.CO/x', def, 't')).toEqual({ Authorization: 'Bearer t' });
  });
  test('userinfo trick does not match', () =>
    expect(authHeader('https://huggingface.co@evil.com/x', def, 't')).toEqual({}));
});

describe('checkRedirect', () => {
  test('an unparsable source URL refuses any location, even an absolute https one', () =>
    expect(checkRedirect('not a url', 'https://cdn-lfs.hf.co/x', def, 1)).toMatchObject({ ok: false, reason: expect.stringContaining('Invalid redirect') }));
  const from = 'https://huggingface.co/a/b/resolve/main/f';
  test('https to https is fine, up to hop 5', () => {
    expect(checkRedirect(from, 'https://cdn-lfs.hf.co/x?y=1', def, 1)).toEqual({
      ok: true,
      url: 'https://cdn-lfs.hf.co/x?y=1',
    });
    expect(checkRedirect(from, 'https://cdn-lfs.hf.co/x', def, 5)).toMatchObject({ ok: true });
  });
  test('hop 6 is refused', () =>
    expect(checkRedirect(from, 'https://cdn-lfs.hf.co/x', def, 6)).toMatchObject({ ok: false }));
  test('relative Location resolves against from', () => {
    expect(checkRedirect(from, '/other/path', def, 1)).toEqual({ ok: true, url: 'https://huggingface.co/other/path' });
    expect(checkRedirect(from, 'g', def, 1)).toEqual({ ok: true, url: 'https://huggingface.co/a/b/resolve/main/g' });
  });
  test('https to http is refused, even against a loopback endpoint', () => {
    expect(checkRedirect(from, 'http://cdn.example.com/x', def, 1)).toMatchObject({ ok: false });
    expect(checkRedirect('https://127.0.0.1:8080/x', 'http://127.0.0.1:9/x', loop, 1)).toMatchObject({ ok: false });
  });
  test('http endpoint that is not loopback: redirects to http are refused', () =>
    expect(
      checkRedirect('http://10.0.0.1/x', 'http://10.0.0.1:81/x', { origin: 'http://10.0.0.1', base: 'http://10.0.0.1', loopbackHttp: false }, 1),
    ).toMatchObject({ ok: false }));
  test('loopback endpoint allows other loopback http ports only', () => {
    const f = 'http://127.0.0.1:8080/x';
    expect(checkRedirect(f, 'http://127.0.0.1:9090/blob', loop, 1)).toEqual({
      ok: true,
      url: 'http://127.0.0.1:9090/blob',
    });
    expect(checkRedirect(f, 'http://localhost:9090/blob', loop, 1)).toMatchObject({ ok: true });
    expect(checkRedirect(f, 'http://10.0.0.1/x', loop, 1)).toMatchObject({ ok: false });
    expect(checkRedirect(f, 'https://cdn.example.com/x', loop, 1)).toMatchObject({ ok: true });
  });
  test('other schemes, bad locations and credentials are refused', () => {
    for (const loc of ['ftp://x.com/a', 'file:///etc/passwd', 'https://u:p@cdn.example.com/x', 'http://[bad'])
      expect(checkRedirect(from, loc, def, 1), loc).toMatchObject({ ok: false });
  });
  test('protocol-relative Location resolves to the scheme of from', () => {
    expect(checkRedirect(from, '//evil.com/x', def, 1)).toEqual({ ok: true, url: 'https://evil.com/x' });
    expect(authHeader('https://evil.com/x', def, 't')).toEqual({});
  });
  test('IPv6 loopback endpoint allows other IPv6 loopback ports', () => {
    const ep = { origin: 'http://[::1]:8080', base: 'http://[::1]:8080', loopbackHttp: true };
    expect(checkRedirect('http://[::1]:8080/x', 'http://[::1]:9/y', ep, 1)).toMatchObject({ ok: true });
  });
  test('refusals carry a reason', () => {
    const r = checkRedirect(from, 'http://x.com/', def, 1);
    expect(r.ok === false && r.reason.length > 0).toBe(true);
  });
});
