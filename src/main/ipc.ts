// The IPC boundary: the app's trust boundary. Every handler checks the sender first (FORBIDDEN), then
// validates the arguments against the strict schema (INVALID_INPUT, naming only the paths of the bad fields, never
// their values), then calls the service. Whatever the service does, the renderer gets an ApiResult, never a thrown stack.
import { pathToFileURL } from 'node:url';
import { API_METHODS, CHANNELS } from '../shared/api';
import type { ApiResult, InvokeMethod } from '../shared/api';
import { parseArgs } from '../shared/ipc-schemas';
import type { AppServices } from './services';

export interface IpcEventLike { senderFrame: { url: string } | null }
export type IpcHandler = (e: IpcEventLike, ...a: unknown[]) => Promise<unknown>;
export interface IpcRegistry { handle(ch: string, fn: IpcHandler): void }
export type ServiceSurface = Pick<AppServices, InvokeMethod>;

export interface TrustOptions {
  /** The built renderer's index.html (an absolute path). */
  rendererFile: string;
  /** The dev server origin (dev only, already validated by `resolveRendererUrl`), else null. */
  devOrigin: string | null;
}

/** True iff `url` is the bundled renderer file (a hash is ignored) or lies on the dev server's origin. */
export function isTrustedSender(url: string, opts: TrustOptions): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol === 'file:') {
    u.hash = '';
    return u.href === pathToFileURL(opts.rendererFile).href;
  }
  return (u.protocol === 'http:' || u.protocol === 'https:') && opts.devOrigin !== null && u.origin === opts.devOrigin;
}

const forbidden = (): ApiResult<never> => ({ ok: false, error: { code: 'FORBIDDEN', message: 'This request did not come from the app window.' } });
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Registers one handler per channel. `trust` decides, from the sender frame's URL alone, whether a call is accepted. */
export function registerIpc(ipc: IpcRegistry, svc: ServiceSurface, trust: (url: string) => boolean): void {
  for (const method of API_METHODS) {
    ipc.handle(CHANNELS[method], async (e, ...args) => {
      if (e.senderFrame === null || !trust(e.senderFrame.url)) return forbidden();
      const parsed = parseArgs(method, args);
      if (!parsed.ok) return { ok: false, error: { code: 'INVALID_INPUT', message: `Invalid arguments: ${parsed.paths.join(', ')}` } };
      try {
        return await (svc[method] as (...a: unknown[]) => Promise<unknown>).apply(svc, parsed.args);
      } catch (err) {
        return { ok: false, error: { code: 'INTERNAL', message: errText(err) } } satisfies ApiResult<never>;
      }
    });
  }
}

export interface ElectronIpcEvent { sender: object; senderFrame: { url: string; parent: object | null } | null }
export interface ElectronIpcMainLike { handle(ch: string, fn: (e: ElectronIpcEvent, ...a: unknown[]) => Promise<unknown>): void }

/**
 * Narrows an electron `ipcMain` to the registry `registerIpc` uses: a call counts only when it comes from the top-level
 * frame of the main window's webContents (`isMainSender`); any other sender or a sub-frame gets a null frame, so FORBIDDEN.
 */
export function adaptIpcMain(ipcMain: ElectronIpcMainLike, isMainSender: (sender: object) => boolean): IpcRegistry {
  return {
    handle: (ch, fn) => ipcMain.handle(ch, (e, ...a) => {
      const f = e.senderFrame;
      const topFrame = isMainSender(e.sender) && f !== null && f.parent === null;
      return fn({ senderFrame: topFrame ? { url: f.url } : null }, ...a);
    }),
  };
}
