// Byte-exact listing of a view tree, produced identically by scripts/golden/list_tree.py (the CLI side).
// One line per entry under `root` (never `root` itself), sorted by the UTF-8 bytes of the relative path:
//   <rel>\tD                                  directory
//   <rel>\tL\t<link text>                     symlink (hubReal -> @HUB@, then caseDir -> @CASE@); never followed
//   <rel>\tF\t<size>\t<sha256 hex>            regular file
// In a .hfhub-state.json the timestamps ("YYYY-MM-DDTHH:MM:SS") are replaced by "@TIME@" before the size and hash
// are taken, so the listing does not depend on when the run happened.
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, readlinkSync } from 'node:fs';
import path from 'node:path';

export const STATE_NAME = '.hfhub-state.json';
const TIME = /"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d"/g;

/** The state file text with its timestamps masked ('' when the file is absent). */
export function maskedState(root: string): string {
  try {
    return readFileSync(path.join(root, STATE_NAME), 'utf8').replace(TIME, '"@TIME@"');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw e;
  }
}

export function treeListing(root: string, hubReal: string, caseDir: string): string {
  const rows: Array<{ rel: string; line: string }> = [];
  const walk = (abs: string, rel: string): void => {
    for (const name of readdirSync(abs)) {
      const p = path.join(abs, name);
      const r = rel === '' ? name : `${rel}/${name}`;
      const st = lstatSync(p);
      if (st.isSymbolicLink()) {
        const text = readlinkSync(p).split(hubReal).join('@HUB@').split(caseDir).join('@CASE@');
        rows.push({ rel: r, line: `${r}\tL\t${text}` });
      } else if (st.isDirectory()) {
        rows.push({ rel: r, line: `${r}\tD` });
        walk(p, r);
      } else {
        let data = readFileSync(p);
        if (name === STATE_NAME) data = Buffer.from(data.toString('utf8').replace(TIME, '"@TIME@"'), 'utf8');
        rows.push({ rel: r, line: `${r}\tF\t${data.length}\t${createHash('sha256').update(data).digest('hex')}` });
      }
    }
  };
  walk(root, '');
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.rel, 'utf8'), Buffer.from(b.rel, 'utf8')));
  return rows.map((x) => `${x.line}\n`).join('');
}
