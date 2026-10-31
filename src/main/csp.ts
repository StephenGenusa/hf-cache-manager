/** Content-Security-Policy strings. Kept free of any `electron` import so the build config can use it too. */

export const PROD_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; " +
  "connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'";

/**
 * The production policy, or (dev only) the policy with inline scripts allowed for the Vite React preamble and the
 * dev server's origin plus its websocket allowed for HMR.
 */
export function cspFor(dev: boolean, devServerOrigin?: string): string {
  if (!dev) return PROD_CSP;
  let csp = PROD_CSP.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'");
  if (devServerOrigin !== undefined) {
    const host = new URL(devServerOrigin).host;
    csp = csp.replace("connect-src 'self'", `connect-src 'self' ${devServerOrigin} ws://${host}`);
  }
  return csp;
}

/** Dev only: swaps the production meta CSP in index.html for the dev one. Throws if the expected meta text is absent. */
export function swapMetaCsp(html: string, devServerOrigin: string): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${PROD_CSP}">`;
  if (!html.includes(meta)) throw new Error('index.html does not contain the expected production CSP meta; dev CSP swap refused');
  return html.replace(meta, () => `<meta http-equiv="Content-Security-Policy" content="${cspFor(true, devServerOrigin)}">`);
}
