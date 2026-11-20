// The drive writer and reader against the real file system: a temp folder always, plus a real FAT32 and exFAT volume
// when HFCM_TEST_FAT32_DIR / HFCM_TEST_EXFAT_DIR are set (see _drive.ts). No substitutes.
import { lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DriveError, DriveWriter } from '../../../src/core/transfer/drive-writer';
import { hasTransfer, objectComplete, openObject, partStates, readDrive, readObjectAt, transferRoot } from '../../../src/core/transfer/drive-reader';
import { manifestName, partPath, partSizes, serializeManifest, type TransferManifest } from '../../../src/core/transfer/format';
import { bytes, COMMIT, sha256, useTempDirs, volume, VOLUMES } from './_drive';

useTempDirs();
const PART = 1000;

/** Writes `content` as the object `etag`, in parts of PART bytes. */
async function put(w: DriveWriter, etag: string, content: Uint8Array, partSize = PART): Promise<void> {
  let start = 0;
  for (const [i, size] of partSizes(content.length, partSize).entries()) {
    const part = await w.openPart(etag, i, 0);
    await part.write(content.subarray(start, start + size));
    await part.close();
    start += size;
  }
}
async function collect(it: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const out: Uint8Array[] = [];
  for await (const c of it) out.push(c);
  return Buffer.concat(out);
}
const manifest = (files: TransferManifest['files'], over: Partial<TransferManifest> = {}): TransferManifest =>
  ({ version: 1, repoId: 'org/name', type: 'model', commit: COMMIT, ref: 'main', exportedAt: 1, files, ...over });

describe.each(VOLUMES)('on a $name', ({ base }) => {
  it('prepare makes the folder, FORMAT, objects/ and manifests/, and can be run again', async () => {
    const vol = await volume(base);
    expect(await hasTransfer(vol)).toBe(false);
    expect(await readDrive(vol)).toBe(null);
    const w = new DriveWriter(vol);
    await w.prepare();
    await w.prepare();
    expect((await readdir(transferRoot(vol))).sort()).toEqual(['FORMAT', 'manifests', 'objects']);
    expect(await readFile(join(transferRoot(vol), 'FORMAT'), 'utf8')).toBe('1\n');
    expect(await hasTransfer(vol)).toBe(true);
    expect(await readDrive(vol)).toEqual({ repos: [], notes: [], objects: new Map() });
  });

  it('leaves a transfer folder of another format version alone', async () => {
    const vol = await volume(base);
    await mkdir(transferRoot(vol));
    await writeFile(join(transferRoot(vol), 'FORMAT'), '2\n');
    await expect(new DriveWriter(vol).prepare()).rejects.toMatchObject({ name: 'DriveError', code: 'LAYOUT' });
    expect(await readFile(join(transferRoot(vol), 'FORMAT'), 'utf8')).toBe('2\n');
    expect(await readdir(transferRoot(vol))).toEqual(['FORMAT']);
    expect(await hasTransfer(vol)).toBe(false);
  });

  it('refuses a volume that is not there, and a file where the transfer folder belongs', async () => {
    const vol = await volume(base);
    await expect(new DriveWriter(join(vol, 'missing')).prepare()).rejects.toMatchObject({ code: 'NO_DRIVE' });
    await writeFile(transferRoot(vol), 'mine');
    await expect(new DriveWriter(vol).prepare()).rejects.toMatchObject({ code: 'LAYOUT' });
    expect(await readFile(transferRoot(vol), 'utf8')).toBe('mine');
  });

  it('an object written in parts reads back whole, from any byte, and by position', async () => {
    const vol = await volume(base);
    const w = new DriveWriter(vol);
    await w.prepare();
    const content = bytes(2500);
    const etag = sha256(content);
    const o = { etag, size: content.length, partSize: PART };
    expect(await objectComplete(w.root, o)).toBe(false);
    await put(w, etag, content);
    expect(await partStates(w.root, o)).toEqual([1000, 1000, 500]);
    expect(await objectComplete(w.root, o)).toBe(true);
    expect((await readdir(join(w.root, 'objects', etag.slice(0, 2)))).sort()).toEqual([`${etag}.000`, `${etag}.001`, `${etag}.002`]);
    expect((await collect(openObject(w.root, o, 0))).equals(Buffer.from(content))).toBe(true);
    for (const from of [1, 999, 1000, 1001, 2499, 2500]) {
      expect((await collect(openObject(w.root, o, from))).equals(Buffer.from(content.subarray(from)))).toBe(true);
    }
    expect(Buffer.from(await readObjectAt(w.root, o, 990, 30)).equals(Buffer.from(content.subarray(990, 1020)))).toBe(true);
    expect(await readObjectAt(w.root, o, 2490, 100)).toHaveLength(10);
    expect(await readObjectAt(w.root, o, 2500, 10)).toHaveLength(0);
    await expect(collect(openObject(w.root, o, 2501))).rejects.toThrow();
  });

  it('an empty file is one empty part', async () => {
    const vol = await volume(base);
    const w = new DriveWriter(vol);
    await w.prepare();
    const etag = sha256('');
    await put(w, etag, new Uint8Array(0));
    const o = { etag, size: 0, partSize: PART };
    expect(await partStates(w.root, o)).toEqual([0]);
    expect(await objectComplete(w.root, o)).toBe(true);
    expect(await collect(openObject(w.root, o, 0))).toHaveLength(0);
  });

  it('a short part is continued by appending; nothing already written changes', async () => {
    const vol = await volume(base);
    const w = new DriveWriter(vol);
    await w.prepare();
    const content = bytes(1500, 7);
    const etag = sha256(content);
    const first = await w.openPart(etag, 0, 0);
    await first.write(content.subarray(0, 300));
    await first.abandon();
    const o = { etag, size: content.length, partSize: PART };
    expect(await partStates(w.root, o)).toEqual([300, null]);
    const rest = await w.openPart(etag, 0, 300);
    await rest.write(content.subarray(300, 1000));
    await rest.close();
    const second = await w.openPart(etag, 1, 0);
    await second.write(content.subarray(1000));
    await second.close();
    expect((await collect(openObject(w.root, o, 0))).equals(Buffer.from(content))).toBe(true);
  });

  it('never opens a part whose size is not what the caller saw (LAYOUT, the part untouched)', async () => {
    const vol = await volume(base);
    const w = new DriveWriter(vol);
    await w.prepare();
    const etag = 'a'.repeat(64);
    const p = await w.openPart(etag, 0, 0);
    await p.write(bytes(10));
    await p.close();
    const file = join(w.root, ...partPath(etag, 0).split('/'));
    await expect(w.openPart(etag, 0, 0)).rejects.toMatchObject({ code: 'LAYOUT' });   // a create must not replace it
    await expect(w.openPart(etag, 0, 4)).rejects.toMatchObject({ code: 'LAYOUT' });
    await expect(w.openPart(etag, 1, 5)).rejects.toMatchObject({ code: 'LAYOUT' });   // absent, but bytes were expected
    expect(Buffer.from(await readFile(file)).equals(Buffer.from(bytes(10)))).toBe(true);
    await mkdir(join(w.root, ...partPath(etag, 2).split('/')));
    await expect(w.openPart(etag, 2, 0)).rejects.toMatchObject({ code: 'LAYOUT' });
    expect(await partStates(w.root, { etag, size: 2500, partSize: PART })).toEqual([10, null, -1]);
  });

  it('a manifest is added under the hash of its text, once; a cut-short file of that name is left and bypassed', async () => {
    const vol = await volume(base);
    const w = new DriveWriter(vol);
    await w.prepare();
    const text = serializeManifest(manifest([{ path: 'a.bin', size: 5, etag: 'a'.repeat(64), lfs: true, partSize: PART }]));
    const dir = join(w.root, 'manifests');
    await writeFile(join(dir, manifestName(text)), text.slice(0, 20));   // an earlier write that stopped part-way
    expect(await w.addManifest(text)).toBe(manifestName(text, 1));
    expect(await w.addManifest(text)).toBe(manifestName(text, 1));
    expect((await readdir(dir)).sort()).toEqual([manifestName(text, 1), manifestName(text)].sort());
    expect(await readFile(join(dir, manifestName(text)), 'utf8')).toBe(text.slice(0, 20));
    expect(await readFile(join(dir, manifestName(text, 1)), 'utf8')).toBe(text);
  });

  it('readDrive lists a repo only with the files whose parts are all there at full size, and says what it left out', async () => {
    const vol = await volume(base);
    const w = new DriveWriter(vol);
    await w.prepare();
    const whole = bytes(2200, 2);
    const cut = bytes(1800, 3);
    const gone = bytes(40, 4);
    await put(w, sha256(whole), whole);
    const part = await w.openPart(sha256(cut), 0, 0);   // first part complete, second missing
    await part.write(cut.subarray(0, 1000));
    await part.close();
    const files = [
      { path: 'whole.gguf', size: whole.length, etag: sha256(whole), lfs: true, partSize: PART },
      { path: 'sub/alias.gguf', size: whole.length, etag: sha256(whole), lfs: true, partSize: PART },
      { path: 'cut.gguf', size: cut.length, etag: sha256(cut), lfs: true, partSize: PART },
      { path: 'gone.bin', size: gone.length, etag: sha256(gone), lfs: true, partSize: PART },
    ];
    await w.addManifest(serializeManifest(manifest(files)));
    await writeFile(join(w.root, 'manifests', `${'0'.repeat(64)}.json`), '{"version":1}');   // does not match its name
    await writeFile(join(w.root, 'manifests', 'notes.txt'), 'the user may keep files here');
    const d = (await readDrive(vol))!;
    expect(d.repos).toHaveLength(1);
    const r = d.repos[0]!;
    expect(r.key).toBe(`model:org/name@${COMMIT}`);
    expect(r.ref).toBe('main');
    expect(r.files.map((f) => f.path)).toEqual(['sub/alias.gguf', 'whole.gguf']);
    expect(r.incomplete).toEqual(['cut.gguf', 'gone.bin']);
    expect(r.bytes).toBe(4400);
    expect([...d.objects.keys()]).toEqual([sha256(whole)]);
    expect(d.notes).toEqual(['1 export record on the drive could not be read and was left out.']);
  });

  it('a part that is shorter on the drive than the manifest says fails the read and makes the file incomplete', async () => {
    const vol = await volume(base);
    const w = new DriveWriter(vol);
    await w.prepare();
    const content = bytes(1500, 5);
    const etag = sha256(content);
    const p0 = await w.openPart(etag, 0, 0);
    await p0.write(content.subarray(0, 600));
    await p0.close();
    const o = { etag, size: 1500, partSize: PART };
    expect(await objectComplete(w.root, o)).toBe(false);
    await expect(collect(openObject(w.root, o, 0))).rejects.toThrow(/shorter than expected/);
  });

  it('stops reading between chunks when the signal aborts', async () => {
    const vol = await volume(base);
    const w = new DriveWriter(vol);
    await w.prepare();
    const content = bytes(2500, 6);
    await put(w, sha256(content), content);
    const ctl = new AbortController();
    const it = openObject(w.root, { etag: sha256(content), size: 2500, partSize: PART }, 0, ctl.signal);
    expect((await it.next()).done).toBe(false);
    ctl.abort(new Error('stop'));
    await expect(it.next()).rejects.toThrow('stop');
  });

  it('writes only inside the transfer folder: the rest of the volume is as it was', async () => {
    const vol = await volume(base);
    await writeFile(join(vol, 'holiday.jpg'), 'the user owns this');
    await mkdir(join(vol, 'Documents'));
    const w = new DriveWriter(vol);
    await w.prepare();
    await put(w, 'a'.repeat(64), bytes(10));
    expect((await readdir(vol)).sort()).toEqual(['Documents', 'hf-cache-manager-transfer', 'holiday.jpg']);
    expect(await readFile(join(vol, 'holiday.jpg'), 'utf8')).toBe('the user owns this');
    expect(await readdir(join(vol, 'Documents'))).toEqual([]);
    expect((await lstat(join(vol, 'holiday.jpg'))).size).toBe(18);
  });
});

describe('DriveError', () => {
  it('carries its code and path', () => {
    const e = new DriveError('FULL', '/x', 'The drive is full.');
    expect(e).toMatchObject({ name: 'DriveError', code: 'FULL', path: '/x', message: 'The drive is full.' });
  });
});
