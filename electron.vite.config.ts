import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import type { Plugin } from 'vite';
import { swapMetaCsp } from './src/main/csp';

/** Dev only: the Vite React preamble is an inline script and HMR needs a websocket, so swap the meta CSP for the dev one. */
function devCspPlugin(): Plugin {
  let origin = 'http://localhost:5173';
  return {
    name: 'hfcm-dev-csp',
    apply: 'serve',
    configureServer(server) {
      server.httpServer?.once('listening', () => {
        const addr = server.httpServer?.address();
        if (addr !== null && addr !== undefined && typeof addr === 'object') origin = `http://localhost:${addr.port}`;
      });
    },
    transformIndexHtml: (html) => swapMetaCsp(html, origin),
  };
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: 'src/main/index.ts', 'scan-worker': 'src/main/scan-worker.ts' },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    root: 'src/renderer',
    plugins: [react(), tailwindcss(), devCspPlugin()],
  },
});
