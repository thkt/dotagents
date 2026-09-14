import assert from 'node:assert/strict';
import { test, expect } from 'bun:test';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { command } from '../correction.ts';

test('writing retains output and stops descendants on host timeout', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'writing-process-'));
  const worker = join(dir, 'worker.ts'),
    wrapper = join(dir, 'wrapper.ts');
  await writeFile(
    wrapper,
    `import {spawn} from 'node:child_process'; import {writeFileSync} from 'node:fs';
const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
writeFileSync(${JSON.stringify(join(dir, 'pid'))},String(child.pid));
console.log('partial output'); console.error('partial diagnostic'); setInterval(()=>{},1000);`,
  );
  await writeFile(
    worker,
    `import {runWritingCommand} from ${JSON.stringify(resolve(import.meta.dir, '../writing.ts'))};
await runWritingCommand([process.execPath,${JSON.stringify(wrapper)}],${JSON.stringify(dir)},'',${JSON.stringify(join(dir, 'model'))},10000);`,
  );
  let pid: number | undefined;
  try {
    const result = await command([process.execPath, worker], dir, '', 700);
    pid = Number(await readFile(join(dir, 'pid'), 'utf8'));
    expect(result.timedOut).toBe(true);
    expect(result.code).not.toBe(0);
    expect(await readFile(join(dir, 'model.stdout'), 'utf8')).toContain('partial output');
    expect(await readFile(join(dir, 'model.stderr'), 'utf8')).toContain('partial diagnostic');
    let alive = true;
    for (let i = 0; i < 20; i++) {
      try {
        process.kill(pid, 0);
      } catch {
        alive = false;
        break;
      }
      await new Promise((done) => setTimeout(done, 25));
    }
    expect(alive).toBe(false);
  } finally {
    if (pid) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {}
    }
    await rm(dir, { recursive: true, force: true });
  }
});

const failureReasons: Record<string, RegExp> = {
  success_response_nonzero_exit: /Writing model failed after a success response/,
  numeric_crash: /Writing model failed;/,
};

function modelOutput(scenario: { name: string; status: string; response?: string }) {
  const init = JSON.stringify({
    event: 'init',
    init: { model: 'gemini-3.8-flash-high' },
  });
  const result = JSON.stringify({
    event: 'result',
    result: {
      status: scenario.status,
      error: '503 service unavailable',
      response: scenario.response,
    },
  });
  return scenario.name === 'partial_timeout'
    ? `${init}\n${result.slice(0, 40)}`
    : `${init}\n${result}`;
}

for (const scenario of [
  {
    name: 'success_response_nonzero_exit',
    status: 'SUCCESS',
    response: JSON.stringify({ documents: [{ name: 'test.md', body: 'rewritten' }] }),
  },
  {
    name: 'numeric_crash',
    status: 'ERROR',
    output: '',
    stderr: 'TypeError: unexpected value at /cli.js:503:12',
  },
  { name: 'service_error_child', status: 'ERROR', skip: true, descendant: true },
  // The timeout can cut a result line in the middle; that is still a timeout, not invalid output.
  {
    name: 'partial_timeout',
    status: 'SUCCESS',
    skip: true,
    descendant: true,
    response: 'not JSON',
  },
]) {
  test(`writing process classifies ${scenario.name} without hiding invalid output`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'writing-availability-'));
    const worker = join(dir, 'writing-review.ts');
    const timedOut = scenario.name === 'partial_timeout';
    const descendant = `const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'}); writeFileSync(${JSON.stringify(join(dir, 'pid'))},String(child.pid));`;
    await writeFile(
      join(dir, 'agy'),
      `#!${process.execPath}\nimport {spawn} from 'node:child_process'; import {writeFileSync} from 'node:fs';
console.log(${JSON.stringify(scenario.output ?? modelOutput(scenario))});
${timedOut ? "console.error('partial diagnostic');" : ''}
${scenario.skip ? '' : `console.error(${JSON.stringify(scenario.stderr ?? '503 service unavailable')});`}
${scenario.descendant ? descendant : ''}
${timedOut ? 'setInterval(()=>{},1000);' : 'process.exit(1);'}
`,
      { mode: 0o755 },
    );
    await writeFile(
      worker,
      `import {runWritingCommand, reviewWriting} from ${JSON.stringify(resolve(import.meta.dir, '../writing.ts'))};
process.env.PATH=${JSON.stringify(dir)};
console.log(JSON.stringify(await reviewWriting([{name:'test.md',body:'original'}],'facts',${JSON.stringify(join(dir, 'review'))},(argv,cwd,input,prefix)=>runWritingCommand(argv,cwd,input,prefix,${timedOut ? 1500 : 5000}))));`,
    );
    try {
      const result = await command([process.execPath, worker, '--worker'], dir, '', 10000);
      expect(result.timedOut).toBe(false);
      expect(result.code === 0).toBe(Boolean(scenario.skip));
      const receipt = await readFile(join(dir, 'review/skipped.json'), 'utf8').catch(
        (error: unknown) => {
          assert(error instanceof Error && 'code' in error && error.code === 'ENOENT');
          return null;
        },
      );
      expect(receipt !== null).toBe(Boolean(scenario.skip));
      if (scenario.skip) {
        assert(receipt !== null);
        expect(JSON.parse(receipt)).toMatchObject({
          status: 'skipped',
          reason: timedOut ? 'timeout' : 'service_unavailable',
        });
        expect(JSON.parse(result.stdout)).toEqual([{ name: 'test.md', body: 'original' }]);
      } else {
        const reason = failureReasons[scenario.name];
        assert(reason);
        expect(result.stderr).toMatch(reason);
      }
      if (timedOut) {
        expect(await readFile(join(dir, 'review/gemini.stdout'), 'utf8')).toContain('init');
        expect(await readFile(join(dir, 'review/gemini.stderr'), 'utf8')).toContain(
          'partial diagnostic',
        );
      }
      if (scenario.descendant) {
        const pid = Number(await readFile(join(dir, 'pid'), 'utf8'));
        await new Promise((done) => setTimeout(done, 100));
        expect(() => process.kill(pid, 0)).toThrow();
      }
    } finally {
      const pid = Number(await readFile(join(dir, 'pid'), 'utf8').catch(() => '0'));
      stopChild(pid);
      await rm(dir, { recursive: true, force: true });
    }
  });
}

function stopChild(pid: number | undefined) {
  if (pid) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {}
  }
}

test('successful writing returns response text while preserving the raw event log', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'writing-success-'));
  const worker = join(dir, 'worker.ts');
  const response = JSON.stringify({ documents: [{ name: 'README.md', body: '確認済み。' }] });
  const raw = modelOutput({ name: 'success', status: 'SUCCESS', response });
  await writeFile(join(dir, 'agy'), `#!${process.execPath}\nconsole.log(${JSON.stringify(raw)});`, {
    mode: 0o755,
  });
  await writeFile(
    worker,
    `import {runWritingCommand} from ${JSON.stringify(resolve(import.meta.dir, '../writing.ts'))};
    process.env.PATH=${JSON.stringify(dir)};
    console.log(await runWritingCommand(['agy'], ${JSON.stringify(dir)}, '', ${JSON.stringify(join(dir, 'model'))}));`,
  );
  try {
    const result = await command([process.execPath, worker], dir, '', 10000);
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe(response);
    expect(await readFile(join(dir, 'model.stdout'), 'utf8')).toBe(raw + '\n');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
