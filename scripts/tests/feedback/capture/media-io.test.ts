import { test, expect } from 'bun:test';
import { z } from 'zod';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

// 子プロセス内だけでI/Oを観測し、他のテストへmockを漏らさない。
async function mediaIo(mode: string, length = 1024 * 1024) {
  const root = await mkdtemp(join(tmpdir(), 'capture-io-'));
  try {
    const output = join(root, 'media');
    await mkdir(output);
    const file = join(output, 'image.png');
    const bytes = Buffer.alloc(length);
    Buffer.from('89504e470d0a1a0a', 'hex').copy(bytes);
    if (mode === 'invalid') {
      bytes[0] = 0;
    }
    await writeFile(file, bytes);
    const entry = join(root, 'observe.ts');
    await writeFile(
      entry,
      `import {mock} from 'bun:test';
import * as filesystem from 'node:fs/promises';
const fs = {...filesystem};
const file = ${JSON.stringify(file)};
const mode = ${JSON.stringify(mode)};
const observed = {whole:0, opened:0, closed:0, read:0, requested:[], error:''};
mock.module('node:fs/promises', () => ({...fs,
  lstat: async (path,...args) => {
    const stat = await fs.lstat(path,...args);
    if (String(path) !== file || mode !== 'eof') return stat;
    // 属性の取得後に短くなったファイルでも、EOFを長さの証拠とする。
    return new Proxy(stat, {get(target,key) {return key === 'size' ? 1048576 : Reflect.get(target,key,target);}});
  },
  readFile: async (path,...args) => {
    if (String(path) === file) observed.whole++;
    return fs.readFile(path,...args);
  },
  open: async (path,...args) => {
    const handle = await fs.open(path,...args);
    if (String(path) !== file) return handle;
    observed.opened++;
    let cursor = 0;
    return new Proxy(handle, {get(target,key) {
      if (key === 'close') return async () => {await target.close(); observed.closed++;};
      if (key === 'readFile') return async (...args) => {observed.whole++; return target.readFile(...args);};
      if (key === 'read') return async (buffer,offset,length,position) => {
        const options = ArrayBuffer.isView(buffer) ? {buffer,offset:offset ?? 0,length:length ?? buffer.byteLength,position} : buffer;
        const destination = options.buffer;
        const start = options.position ?? cursor;
        const size = options.length ?? destination.byteLength - (options.offset ?? 0);
        observed.requested.push([start,size]);
        if (mode === 'error' || (mode === 'partial-error' && cursor > 0)) throw Error('injected media read failure');
        const result = await target.read(destination, options.offset ?? 0, mode === 'short' || mode === 'partial-error' ? Math.min(3,size) : size, start);
        cursor = start + result.bytesRead;
        observed.read += result.bytesRead;
        return result;
      };
      const value = Reflect.get(target,key,target);
      return typeof value === 'function' ? value.bind(target) : value;
    }});
  }
}));
const {validateCaptureMedia} = await import(${JSON.stringify(resolve(import.meta.dir, '../../../capture/capture.ts'))});
try { await validateCaptureMedia(${JSON.stringify(output)}); } catch(error) {observed.error = error.message;}
console.log(JSON.stringify(observed));`,
    );
    const result = spawnSync(process.execPath, [entry], { encoding: 'utf8', timeout: 10000 });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    return z
      .object({
        whole: z.number(),
        opened: z.number(),
        closed: z.number(),
        read: z.number(),
        requested: z.array(z.tuple([z.number(), z.number()])),
        error: z.string(),
      })
      .parse(JSON.parse(result.stdout));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

for (const mode of ['normal', 'short', 'invalid', 'eof', 'error', 'partial-error']) {
  test(`撮影媒体の読み取り上限と解放: ${mode}`, async () => {
    const result = await mediaIo(mode, mode === 'eof' ? 12 : undefined);
    expect(result.whole).toBe(0);
    expect(result.opened).toBeGreaterThan(0);
    expect(result.closed).toBe(result.opened);
    expect(result.requested.length).toBeGreaterThan(0);
    expect(result.read).toBeLessThanOrEqual(13);
    for (const [position, length] of result.requested) {
      expect(position).toBeGreaterThanOrEqual(0);
      expect(length).toBeGreaterThan(0);
      expect(position + length).toBeLessThanOrEqual(13);
    }
    if (mode === 'error' || mode === 'partial-error') {
      expect(result.error).toContain('injected media read failure');
      if (mode === 'partial-error') {
        expect(result.read).toBeGreaterThan(0);
      }
    } else if (mode === 'invalid' || mode === 'eof') {
      expect(result.error).toContain('Invalid capture media');
    } else {
      expect(result.error).toBe('');
      expect(result.read).toBe(13);
    }
  });
}
