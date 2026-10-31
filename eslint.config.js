import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const MSG = 'Recursive delete is banned. Enumerate entries and use SafeFs.';
const CORE_MSG = 'src/core must stay pure Node; no electron / child_process';
const BANNED_PKGS = ['rimraf', 'del', 'fs-extra', 'trash', 'execa', 'shelljs', 'cross-spawn', 'rm-rf', 'rmrf', 'del-cli', 'trash-cli'];
const SHELL_MODS = ['child_process', 'node:child_process'];
const bannedImportPaths = [...BANNED_PKGS, ...SHELL_MODS].map((name) => ({ name, message: MSG }));
// The one nvidia-smi call. Exact path; only the execFile import (no exec, spawn, namespace, require, import()).
const CHILD_PROCESS_ALLOWLIST = ['src/main/hardware.ts'];
const bannedImportPatterns = [{ group: BANNED_PKGS.map((n) => `${n}/*`), message: MSG }];
const BANNED_MOD_RE = `/^((node:)?child_process|(${BANNED_PKGS.join('|')})(\\/.*)?)$/`;

// SafeFs is the only mutator: node fs may be imported in src/ only by these files.
// AppLock and Journal need node:fs/promises ('wx' create, append + datasync) inside their own folders.
const FS_IMPORT_ALLOWLIST = ['src/core/fsx.ts', 'src/core/safe-fs.ts', 'src/core/exec/lock.ts', 'src/core/exec/journal.ts'];
// Files that may call nodeFs mutators directly. Not extended by the fs import allowlist.
const NODEFS_MUTATOR_EXEMPT = ['src/core/fsx.ts', 'src/core/safe-fs.ts'];
const FS_MSG = 'node fs may only be imported in src/ by the FS_IMPORT_ALLOWLIST files; mutate through SafeFs.';
const NODEFS_MSG = 'nodeFs mutators may only be called inside fsx/safe-fs; mutate through SafeFs.';
const FS_MODS = ['fs', 'node:fs', 'fs/promises', 'node:fs/promises'];
const FS_MOD_RE = '/^(node:)?fs(\\/promises)?$/';
const NODEFS_MUT_RE = '/^(unlink|rename|rmdir|writeFile|mkdir|symlink|link|open|appendFile|copyFile|truncate|chmod|utimes)$/';
const fsImportSelectors = [
  `ImportExpression[source.value=${FS_MOD_RE}]`,
  `ImportExpression[source.expressions.length=0][source.quasis.0.value.cooked=${FS_MOD_RE}]`,
  `CallExpression[callee.name='require'][arguments.0.value=${FS_MOD_RE}]`,
  `CallExpression[callee.name='require'][arguments.0.expressions.length=0][arguments.0.quasis.0.value.cooked=${FS_MOD_RE}]`,
].map((selector) => ({ selector, message: FS_MSG }));
const nodeFsMutatorSelectors = [
  `MemberExpression[object.name='nodeFs'][property.name=${NODEFS_MUT_RE}]`,
  `MemberExpression[object.name='nodeFs'][property.value=${NODEFS_MUT_RE}]`,
  `VariableDeclarator[init.name='nodeFs'] > ObjectPattern > Property[key.name=${NODEFS_MUT_RE}]`,
  `VariableDeclarator[init.name='nodeFs'] > ObjectPattern > Property[key.value=${NODEFS_MUT_RE}]`,
].map((selector) => ({ selector, message: NODEFS_MSG }));

// The fsx module, by any relative specifier ('./fsx', '../core/fsx', '../fsx.js', ...).
const FSX_SPEC = '(^|/)fsx(\\.[cm]?[jt]s)?$';
const FSX_RE = `/${FSX_SPEC.replaceAll('/', '\\/')}/`;
const NODEFS_IMPORT_MSG = 'nodeFs may only be imported by fsx/safe-fs (NODEFS_MUTATOR_EXEMPT); read through readFs/ReadFs, mutate through SafeFs.';
const FSLIKE_MSG = 'FsLike may only be named by FS_IMPORT_ALLOWLIST files; read-only modules declare ReadFs and default to readFs.';
const FSX_NS_MSG = 'No namespace/dynamic access to nodeFs outside fsx/safe-fs; import readFs/ReadFs by name.';
// a) value or type import of nodeFs; c) namespace imports and `export *` (the rule rejects these when importNames is set).
const nodeFsImportPattern = { regex: FSX_SPEC, importNames: ['nodeFs'], message: NODEFS_IMPORT_MSG };
// b) FsLike, type or value. FS_IMPORT_ALLOWLIST names the exceptions.
// The one exception: only src/main/user-data.ts may import the guarded one-level mkdir.
const MKDIR_MSG = 'mkdirOneLevel may only be imported by src/main/user-data.ts (the guarded userData create); mutate through SafeFs.';
const mkdirImportPattern = { regex: FSX_SPEC, importNames: ['mkdirOneLevel'], message: MKDIR_MSG };
const fsLikeImportPattern = { regex: FSX_SPEC, importNames: ['FsLike'], message: FSLIKE_MSG };
// c) namespace imports of fsx, and every reference to the name nodeFs (member, computed, destructuring,
// specifier, string), which covers `(await import('./fsx')).nodeFs` and `require('./fsx').nodeFs`.
const nodeFsRefSelectors = [
  `ImportDeclaration[source.value=${FSX_RE}] > ImportNamespaceSpecifier`,
  `ExportAllDeclaration[source.value=${FSX_RE}]`,
  ...refSelectors("/^nodeFs$/"),
].map((selector) => ({ selector, message: FSX_NS_MSG }));
const mkdirRefSelectors = refSelectors('/^mkdirOneLevel$/').map((selector) => ({ selector, message: MKDIR_MSG }));
const fsLikeTypeSelectors = [`TSImportType[qualifier.name='FsLike']`].map((selector) => ({ selector, message: FSLIKE_MSG }));

// Every reference form (member, computed, destructuring key, import/export specifier, string) of names.
function refSelectors(re) {
  return [
    `MemberExpression[property.name=${re}]`,
    `MemberExpression[property.value=${re}]`,
    `Property[key.name=${re}]`,
    `Property[key.value=${re}]`,
    `ImportSpecifier[imported.name=${re}]`,
    `ImportSpecifier[imported.value=${re}]`,
    `ExportSpecifier[local.name=${re}]`,
    `ExportSpecifier[local.value=${re}]`,
    `Literal[value=${re}]`,
    `TemplateLiteral[quasis.0.value.cooked=${re}]`,
  ];
}
// Network code lives only in the Hub client, plus core-port's existing Ollama registry fetch
// injection; tests and E2E run loopback fakes. Everywhere else: no global fetch, no node:http/https/net/tls, no undici.
export const NET_ALLOWLIST = ['src/main/hub/**', 'src/main/core-port.ts', 'tests/**', 'e2e/**'];
const NET_MSG = 'Network access lives only in src/main/hub/; inject a fetch from there.';
const NET_MODS = ['http', 'https', 'http2', 'net', 'tls', 'undici'].flatMap((m) => (m === 'undici' ? [m] : [m, `node:${m}`]));
const NET_MOD_RE = '/^((node:)?(https?|http2|net|tls)|undici(\\/.*)?)$/';
const NET_GLOBALS = '/^(globalThis|global|window|self)$/';
const netSelectors = [
  `ImportExpression[source.value=${NET_MOD_RE}]`,
  `ImportExpression[source.expressions.length=0][source.quasis.0.value.cooked=${NET_MOD_RE}]`,
  `CallExpression[callee.name='require'][arguments.0.value=${NET_MOD_RE}]`,
  `CallExpression[callee.name='require'][arguments.0.expressions.length=0][arguments.0.quasis.0.value.cooked=${NET_MOD_RE}]`,
  `MemberExpression[object.name=${NET_GLOBALS}][property.name='fetch']`,
  `MemberExpression[object.name=${NET_GLOBALS}][property.value='fetch']`,
  `VariableDeclarator[init.name=${NET_GLOBALS}] > ObjectPattern > Property[key.name='fetch']`,
  // Aliases of the global object (`const g = globalThis; g.fetch(u)`) and Reflect.get(globalThis, ...).
  `VariableDeclarator[id.type='Identifier'][init.name=${NET_GLOBALS}]`,
  `CallExpression[callee.object.name='Reflect'][arguments.0.name=${NET_GLOBALS}]`,
  // Electron's own network stack (net.fetch / net.request) is the same door.
  `ImportDeclaration[source.value='electron'] > ImportSpecifier[imported.name='net']`,
  `MemberExpression[object.name='electron'][property.name='net']`,
  `VariableDeclarator[init.callee.name='require'][init.arguments.0.value='electron'] > ObjectPattern > Property[key.name='net']`,
].map((selector) => ({ selector, message: NET_MSG }));

const RM = '/^(rm|rmSync)$/';
const RD = '/^(rmdir|rmdirSync)$/';
const TRASH = '/^(trashItem|moveItemToTrash)$/';

function syntax({ rmdirExempt, core, fsBan, nodeFsBan, allowMkdir, allowNet }) {
  const sel = [
    ...refSelectors(RM).map((selector) => ({ selector, message: MSG })),
    ...refSelectors(TRASH).map((selector) => ({ selector, message: MSG })),
    { selector: `CallExpression[callee.name='require'][arguments.0.value=${BANNED_MOD_RE}]`, message: MSG },
    { selector: `ImportExpression[source.value=${BANNED_MOD_RE}]`, message: MSG },
  ];
  if (rmdirExempt) {
    sel.push(
      { selector: `CallExpression[callee.property.name=${RD}][arguments.length>1]`, message: 'rmdir takes no options. ' + MSG },
      { selector: `CallExpression[callee.property.name=${RD}] > SpreadElement`, message: 'rmdir takes no spread args. ' + MSG },
    );
  } else {
    sel.push(...refSelectors(RD).map((selector) => ({ selector, message: 'rmdir only allowed in fsx/safe-fs/test helpers. ' + MSG })));
  }
  if (core) sel.push({ selector: "ImportExpression[source.value='electron']", message: CORE_MSG });
  if (fsBan) sel.push(...fsImportSelectors);
  if (fsBan) sel.push(...fsLikeTypeSelectors);
  if (nodeFsBan) sel.push(...nodeFsMutatorSelectors, ...nodeFsRefSelectors);
  if (nodeFsBan && allowMkdir !== true) sel.push(...mkdirRefSelectors);
  if (allowNet !== true) sel.push(...netSelectors);
  return ['error', ...sel];
}
function imports({ core, fsBan, nodeFsBan, allowMkdir, allowExecFile, allowNet }) {
  const paths = bannedImportPaths.map((p) =>
    allowExecFile === true && SHELL_MODS.includes(p.name) ? { ...p, allowImportNames: ['execFile'] } : p,
  );
  const patterns = [...bannedImportPatterns];
  // Type-only imports of node fs cannot mutate, so they stay allowed.
  if (fsBan) paths.push(...FS_MODS.map((name) => ({ name, message: FS_MSG, allowTypeImports: true })));
  if (fsBan) patterns.push(fsLikeImportPattern);
  if (nodeFsBan) patterns.push(nodeFsImportPattern);
  if (nodeFsBan && allowMkdir !== true) patterns.push(mkdirImportPattern);
  // Type-only imports (AddressInfo, ...) open no socket.
  if (allowNet !== true) {
    paths.push(...NET_MODS.map((name) => ({ name, message: NET_MSG, allowTypeImports: true })));
    patterns.push({ group: ['undici/*'], message: NET_MSG, allowTypeImports: true });
  }
  if (core) {
    paths.push({ name: 'electron', message: CORE_MSG });
    patterns.push({ group: ['electron/*'], message: CORE_MSG });
  }
  return ['error', { paths, patterns }];
}
const block = (files, o) => ({
  files,
  rules: {
    'no-restricted-imports': imports(o),
    'no-restricted-syntax': syntax(o),
    'no-restricted-globals': o.allowNet === true ? 'off' : ['error', { name: 'fetch', message: NET_MSG }],
  },
});
const ALL = ['**/*.{ts,tsx,js,mjs,cjs,mts,cts}'];

export default tseslint.config(
  { ignores: ['node_modules/', 'out/', 'dist/', 'coverage/', 'reports/', '.stryker-tmp/', 'test-results/', 'playwright-report/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    linterOptions: { noInlineConfig: true },
    languageOptions: { globals: { ...globals.node } },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  // Later blocks replace earlier rule options for the files they match, so order matters.
  block(ALL, { rmdirExempt: false, core: false }),
  block(NET_ALLOWLIST.filter((g) => !g.startsWith('src/')), { rmdirExempt: false, core: false, allowNet: true }),
  block(['src/**'], { rmdirExempt: false, core: false, fsBan: true, nodeFsBan: true }),
  block(NET_ALLOWLIST.filter((g) => g.startsWith('src/')), { rmdirExempt: false, core: false, fsBan: true, nodeFsBan: true, allowNet: true }),
  block(['src/core/**'], { rmdirExempt: false, core: true, fsBan: true, nodeFsBan: true }),
  block(FS_IMPORT_ALLOWLIST, { rmdirExempt: false, core: true, fsBan: false, nodeFsBan: true }),
  block(NODEFS_MUTATOR_EXEMPT, { rmdirExempt: true, core: true, fsBan: false, nodeFsBan: false }),
  block(['src/main/user-data.ts'], { rmdirExempt: false, core: false, fsBan: true, nodeFsBan: true, allowMkdir: true }),
  block(CHILD_PROCESS_ALLOWLIST, { rmdirExempt: false, core: false, fsBan: true, nodeFsBan: true, allowExecFile: true }),
  block(['tests/helpers/tmp.ts', 'tests/helpers/guarded-fs.ts'], { rmdirExempt: true, core: false, allowNet: true }),
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
  },
);
