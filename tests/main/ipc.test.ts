import { beforeEach, expect, test, vi } from 'vitest';
import type { InvokeMethod } from '../../src/shared/api';
import { API_METHODS, CHANNELS } from '../../src/shared/api';
import { adaptIpcMain, isTrustedSender, registerIpc } from '../../src/main/ipc';
import type { IpcEventLike, IpcHandler, IpcRegistry, ServiceSurface } from '../../src/main/ipc';
import { useCanaries } from '../helpers/canary';

useCanaries();
beforeEach(() => expect.hasAssertions());

const good: IpcEventLike = { senderFrame: { url: 'file:///app/out/renderer/index.html' } };
const OPTS = { rendererFile: '/app/out/renderer/index.html', devOrigin: null };
const trust = (url: string): boolean => isTrustedSender(url, OPTS);

function setup(): { handlers: Map<string, IpcHandler>; svc: Record<InvokeMethod, ReturnType<typeof vi.fn>> } {
  const handlers = new Map<string, IpcHandler>();
  const ipc: IpcRegistry = { handle: (ch, fn) => { handlers.set(ch, fn); } };
  const svc = Object.fromEntries(API_METHODS.map((m) => [m, vi.fn(() => Promise.resolve({ ok: true, data: null }))])) as Record<InvokeMethod, ReturnType<typeof vi.fn>>;
  registerIpc(ipc, svc as unknown as ServiceSurface, trust);
  return { handlers, svc };
}
const h = (m: Map<string, IpcHandler>, ch: string): IpcHandler => {
  const fn = m.get(ch);
  if (fn === undefined) throw new Error(`no handler for ${ch}`);
  return fn;
};

test('registers exactly one handler per channel', () => {
  const { handlers } = setup();
  expect([...handlers.keys()].sort()).toEqual(Object.values(CHANNELS).sort());
});

test('a valid call reaches the service with the parsed arguments, as a method call', async () => {
  const { handlers, svc } = setup();
  const id = crypto.randomUUID();
  const fp = 'a'.repeat(64);
  expect(await h(handlers, 'hfcm:executePlan')(good, id, fp, 'hold', null)).toEqual({ ok: true, data: null });
  expect(svc.executePlan).toHaveBeenCalledExactlyOnceWith(id, fp, 'hold', null);
  await h(handlers, 'hfcm:scan')(good);
  expect(svc.scan).toHaveBeenCalledExactlyOnceWith();
});

test('invalid input never reaches services and the message never echoes values', async () => {
  const { handlers, svc } = setup();
  const r = await h(handlers, 'hfcm:planDelete')(good, { repos: [{ repoId: '/etc', whole: true }] });
  expect(r).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  expect(JSON.stringify(r)).not.toContain('/etc');
  expect(JSON.stringify(r)).toContain('repos.0.repoId');
  expect(svc.planDelete).not.toHaveBeenCalled();
});

test('a path smuggled in an extra field or extra argument is rejected without echoing it', async () => {
  const { handlers, svc } = setup();
  const r = await h(handlers, 'hfcm:executePlan')(good, crypto.randomUUID(), 'a'.repeat(64), 'hold', null, { path: '/secret-dir' });
  expect(r).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  const r2 = await h(handlers, 'hfcm:executeSync')(good, crypto.randomUUID(), { allowMassRemoval: false, path: '/secret-dir' });
  expect(r2).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  expect(JSON.stringify([r, r2])).not.toContain('secret-dir');
  expect(svc.executePlan).not.toHaveBeenCalled();
  expect(svc.executeSync).not.toHaveBeenCalled();
});

test('a failure with an empty path is reported as args', async () => {
  const { handlers } = setup();
  expect(await h(handlers, 'hfcm:scan')(good, 'x')).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT', message: 'Invalid arguments: args' } });
});

test('untrusted, missing or malformed sender frame is FORBIDDEN and nothing is called', async () => {
  const { handlers, svc } = setup();
  const bad: IpcEventLike[] = [
    { senderFrame: { url: 'https://evil.example/' } }, { senderFrame: null }, { senderFrame: { url: 'file:///tmp/evil.html' } },
    { senderFrame: { url: 'not a url' } },
  ];
  for (const ch of Object.values(CHANNELS)) {
    for (const e of bad) expect(await h(handlers, ch)(e), `${ch} ${JSON.stringify(e)}`).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
  }
  for (const m of API_METHODS) expect(svc[m]).not.toHaveBeenCalled();
});

test('the trust check runs before validation (invalid input from a bad sender is FORBIDDEN)', async () => {
  const { handlers } = setup();
  expect(await h(handlers, 'hfcm:repoDetail')({ senderFrame: null }, '/etc')).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
});

test('service throw becomes INTERNAL without a stack', async () => {
  const { handlers, svc } = setup();
  svc.scan.mockRejectedValueOnce(Object.assign(new Error('disk on fire'), { stack: 'Error: disk on fire\n    at /secret/file.ts:1' }));
  const r = await h(handlers, 'hfcm:scan')(good);
  expect(r).toEqual({ ok: false, error: { code: 'INTERNAL', message: 'disk on fire' } });
  expect(JSON.stringify(r)).not.toContain('secret');
  svc.scan.mockRejectedValueOnce('plain string');
  expect(await h(handlers, 'hfcm:scan')(good)).toEqual({ ok: false, error: { code: 'INTERNAL', message: 'plain string' } });
  svc.scan.mockImplementationOnce(() => { throw new Error('sync throw'); });
  expect(await h(handlers, 'hfcm:scan')(good)).toEqual({ ok: false, error: { code: 'INTERNAL', message: 'sync throw' } });
});

test('isTrustedSender', () => {
  expect(isTrustedSender('file:///app/out/renderer/index.html#/x', OPTS)).toBe(true);
  expect(isTrustedSender('file:///app/out/renderer/index.html', OPTS)).toBe(true);
  expect(isTrustedSender('file:///tmp/evil.html', OPTS)).toBe(false);
  expect(isTrustedSender('file:///app/out/renderer/index.html?x=1', OPTS)).toBe(false);
  expect(isTrustedSender('http://localhost:5173/', { rendererFile: '/x', devOrigin: 'http://localhost:5173' })).toBe(true);
  expect(isTrustedSender('http://localhost:5173/#/a', { rendererFile: '/x', devOrigin: 'http://localhost:5173' })).toBe(true);
  expect(isTrustedSender('http://localhost:5174/', { rendererFile: '/x', devOrigin: 'http://localhost:5173' })).toBe(false);
  expect(isTrustedSender('http://localhost:5173/', OPTS)).toBe(false);
  expect(isTrustedSender('http://localhost:5173.evil.com/', { rendererFile: '/x', devOrigin: 'http://localhost:5173' })).toBe(false);
  expect(isTrustedSender('', { rendererFile: '/x', devOrigin: 'http://localhost:5173' })).toBe(false);
  expect(isTrustedSender('file:///x', { rendererFile: '/x', devOrigin: 'null' })).toBe(true);
  expect(isTrustedSender('about:blank', { rendererFile: '/x', devOrigin: 'null' })).toBe(false);
});

test('adaptIpcMain only passes the frame of the main window top-level webContents', async () => {
  const main = {};
  const other = {};
  const reg = new Map<string, (e: { sender: object; senderFrame: { url: string; parent: object | null } | null }, ...a: unknown[]) => Promise<unknown>>();
  const adapted = adaptIpcMain({ handle: (ch, fn) => { reg.set(ch, fn); } }, (s) => s === main);
  const seen: Array<IpcEventLike> = [];
  adapted.handle('c', (e) => { seen.push(e); return Promise.resolve(1); });
  const fn = reg.get('c');
  if (fn === undefined) throw new Error('not registered');
  const frame = { url: 'file:///a', parent: null };
  await fn({ sender: main, senderFrame: frame }, 1);
  await fn({ sender: other, senderFrame: frame });
  await fn({ sender: main, senderFrame: { url: 'file:///a', parent: {} } });
  await fn({ sender: main, senderFrame: null });
  expect(seen).toEqual([{ senderFrame: { url: 'file:///a' } }, { senderFrame: null }, { senderFrame: null }, { senderFrame: null }]);
});
