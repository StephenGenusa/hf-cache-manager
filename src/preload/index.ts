// The only thing the sandboxed renderer gets: the typed API, built from the channel table. No ipcRenderer, no Node.
// Imports only `electron` and the shared contract (bundled into the preload; nothing else is `require`d at runtime).
import { contextBridge, ipcRenderer } from 'electron';
import { API_METHODS, CHANNELS, DOWNLOAD_DONE_EVENT, DOWNLOAD_PROGRESS_EVENT, SCAN_PROGRESS_EVENT } from '../shared/api';
import type { EventMethod, HfcmApi } from '../shared/api';

const invokers = Object.fromEntries(
  API_METHODS.map((m) => [m, (...a: unknown[]): Promise<unknown> => ipcRenderer.invoke(CHANNELS[m], ...a)]),
) as unknown as Omit<HfcmApi, EventMethod>;

/** A subscription that hands the callback only the payload (never the IPC event) and returns its unsubscribe. */
function subscribe<T>(channel: string): (cb: (p: T) => void) => () => void {
  return (cb) => {
    const listener = (_e: unknown, p: T): void => cb(p);
    ipcRenderer.on(channel, listener);
    return () => { ipcRenderer.removeListener(channel, listener); };
  };
}

const api: HfcmApi = {
  ...invokers,
  onScanProgress: subscribe(SCAN_PROGRESS_EVENT),
  onDownloadProgress: subscribe(DOWNLOAD_PROGRESS_EVENT),
  onDownloadDone: subscribe(DOWNLOAD_DONE_EVENT),
};

contextBridge.exposeInMainWorld('api', api);
