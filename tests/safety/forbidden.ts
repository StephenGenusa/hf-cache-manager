export const FORBIDDEN: ReadonlyArray<{ id: string; re: RegExp }> = [
  { id: 'fs-rm', re: /(?<![\w$-])rm(?:Sync)?(?![\w$-])/ },
  { id: 'rmdir-recursive', re: /\brmdir(?:Sync)?\s*\((?:[^()]|\((?:[^()]|\([^()]*\))*\))*?\brecursive\b/ },
  { id: 'rimraf', re: /\brimraf\b/ },
  { id: 'del-pkg', re: /(?:from\s+|require\(\s*|import\(\s*)['"`]del['"`]/ },
  { id: 'fs-extra', re: /['"`]fs-extra(?:\/[^'"`]*)?['"`]/ },
  { id: 'trash', re: /\b(?:trashItem|moveItemToTrash)\b|(?:from\s+|require\(\s*|import\(\s*)['"`]trash['"`]/ },
  { id: 'shell-rm-r', re: /\brm\s+-[a-zA-Z]*[rR]/ },
  { id: 'shell-rm-argv', re: /['"`]rm['"`]\s*,\s*\[[^\]]*['"`]-[a-zA-Z]*[rR]/ },
  { id: 'win-rd-s', re: /\b(?:rd|rmdir)\s+\/s\b/i },
  { id: 'child-process', re: /['"`](?:node:)?child_process['"`]|['"`](?:execa|shelljs|cross-spawn|rm-rf|rmrf|del-cli|trash-cli)(?:\/[^'"`]*)?['"`]/ },
  { id: 'long-recursive', re: /--recursive\b/ },
  { id: 'remove-item', re: /\bRemove-Item\b/i },
  { id: 'win-del-s', re: /\bdel\s+(?:\/\w+\s+)*\/s\b/i },
  { id: 'find-delete', re: /(?<![\w-])-delete\b/ },
  { id: 'empty-dir', re: /\bemptyDir(?:Sync)?\b/ },
];

export const BANNED_PACKAGES = ['rimraf', 'del', 'fs-extra', 'trash', 'execa', 'shelljs', 'cross-spawn', 'rm-rf', 'rmrf', 'del-cli', 'trash-cli'] as const;

export function findForbidden(text: string): string[] {
  return FORBIDDEN.filter((f) => f.re.test(text)).map((f) => f.id);
}

// Network access only in NETWORK_ALLOWLIST. Plain-text belt to ESLint's scope-aware braces.
export const NETWORK_FORBIDDEN: ReadonlyArray<{ id: string; re: RegExp }> = [
  { id: 'global-fetch', re: /(?<![\w$.])fetch\s*\(|\b(?:globalThis|global|window|self)\s*(?:\??\.\s*|\[\s*['"`])fetch\b/ },
  { id: 'net-module', re: /['"`](?:node:)?(?:https?|http2|net|tls)['"`]|['"`]undici(?:\/[^'"`]*)?['"`]/ },
  { id: 'electron-net', re: /\bimport\s*\{[^}]*\bnet\b[^}]*\}\s*from\s*['"`]electron['"`]|\belectron\s*\.\s*net\b/ },
];

/** The paths (prefixes) where network code may live; must equal eslint.config.js NET_ALLOWLIST. */
export const NETWORK_ALLOWLIST = ['src/main/hub/**', 'src/main/core-port.ts', 'tests/**', 'e2e/**'] as const;

export function networkAllowed(rel: string): boolean {
  return NETWORK_ALLOWLIST.some((g) => (g.endsWith('/**') ? rel.startsWith(g.slice(0, -2)) : rel === g));
}

export function findNetwork(text: string): string[] {
  return NETWORK_FORBIDDEN.filter((f) => f.re.test(text)).map((f) => f.id);
}
