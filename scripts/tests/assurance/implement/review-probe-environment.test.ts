import assert from 'node:assert/strict';
import { test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { events, object } from '../../support/correction.ts';

async function json(path: string) {
  return object(JSON.parse(await readFile(path, 'utf8')));
}

// Shared process tests cover both handled signals; SIGTERM checks the preflight wiring.
test.each(['mismatch', 'copy', 'SIGTERM'])(
  'a later fixture preflight %s failure prevents every model launch and retains evidence',
  async (failure) => {
    const temp = await realpath(await mkdtemp(join(tmpdir(), 'review-preflight-')));
    try {
      const bin = join(temp, 'bin');
      await mkdir(bin);
      const marker = join(temp, 'model-started');
      await writeFile(
        join(bin, 'codex'),
        `#!${process.execPath}
if(process.argv[2]==='--version') {console.log('simulated-codex');}
else {await Bun.write(${JSON.stringify(marker)},'started');process.exit(1);}
`,
        { mode: 0o755 },
      );
      const preload = join(temp, 'failure.ts');
      const processModule = resolve('scripts/shared/process.ts');
      await writeFile(
        preload,
        `import {mock} from 'bun:test';
import * as crypto from 'node:crypto';
import * as processApi from ${JSON.stringify(processModule)};
import * as fs from 'node:fs/promises';
const original=processApi.command, copy=fs.cp;
const failure=${JSON.stringify(failure)};
let mutations=0, copies=0;
mock.module('node:fs/promises',()=>({...fs,cp:async (...args)=>{
 if(args[1].endsWith('/mutation-copy') && ++copies===2 && failure==='copy') {
  throw Error('Simulated mutation copy failure');
 }
 return copy(...args);
}}));
mock.module('node:crypto',()=>({...crypto,randomInt:()=>0}));
mock.module(${JSON.stringify(processModule)},()=>({...processApi,command:async (...args)=>{
 const failHere=args[0][1]==='test' && args[1].endsWith('/mutation-copy') && ++mutations===2;
 if(failHere && failure.startsWith('SIG')) {
  args[0]=[process.execPath,'-e',
   "import {writeSync} from 'node:fs'; writeSync(1,'partial stdout'); writeSync(2,'partial stderr'); process.kill(process.ppid,"+JSON.stringify(failure)+"); setInterval(()=>{},1000);"];
 }
 const result=await original(...args);
 return failHere && failure==='mismatch'
  ? {...result,code:1,stderr:'Simulated unexpected test failure'} : result;
}}));`,
      );
      const execution = spawnSync(
        process.execPath,
        [
          '--preload',
          preload,
          resolve('scripts/implement/review-probe.ts'),
          '--scenario',
          'test-review',
        ],
        {
          env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TMPDIR: temp },
          encoding: 'utf8',
          timeout: 30000,
        },
      );
      expect(execution.error).toBeUndefined();
      expect(execution.status).toBe(1);
      expect(await Bun.file(marker).exists()).toBe(false);
      const root = execution.stderr.match(/Live review evidence retained at (.+)/)?.[1];
      assert(root);
      const mapping = events(
        JSON.parse(await readFile(join(root, 'host', 'cases.json'), 'utf8')),
      ).map(object);
      expect(mapping.map((entry) => entry.name)).toEqual(['sound', 'unchanged', 'weak']);
      for (const entry of mapping) {
        assert(typeof entry.id === 'string');
        expect(
          (await readdir(join(root, entry.id))).filter((name) => name.startsWith('review-codex-')),
        ).toEqual([]);
      }
      const failed = mapping[1];
      assert(failed && typeof failed.id === 'string');
      const evidence = await json(join(root, 'host', failed.id, 'preflight.json'));
      expect(object(evidence.normal).code).toBe(0);
      expect(object(evidence.normal).stderr).toContain('6 pass');
      expect(object(evidence.original).stdout).toBe('[30,40]\n');
      const stopped = await readFile(join(root, 'stopped.txt'), 'utf8');
      if (failure === 'mismatch') {
        expect(object(evidence.mutated).stderr).toBe('Simulated unexpected test failure');
        expect(stopped).toContain('Unexpected mutation detection');
      } else {
        expect(Object.keys(evidence)).toEqual(['normal', 'original']);
        if (failure === 'copy') {
          expect(stopped).toContain('Simulated mutation copy failure');
        } else {
          expect(stopped).toContain('Interrupted execution');
          const prefix = join(root, 'host', failed.id, 'preflight-mutated');
          expect(await readFile(`${prefix}.stdout`, 'utf8')).toBe('partial stdout');
          expect(await readFile(`${prefix}.stderr`, 'utf8')).toBe('partial stderr');
        }
      }
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  },
  30000,
);
