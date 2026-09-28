// Synthetic history and host-only mutation checks for the optional test-review scenario.
import assert from 'node:assert/strict';
import { cp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { command } from '../shared/process.ts';

const baseline = {
  '01-start': 'expect(page([10,20,30,40],0,2)).toEqual([10,20]);',
  '02-empty': 'expect(page([],0,3)).toEqual([]);',
  '03-exhausted': 'expect(page([10,20],2,2)).toEqual([]);',
  '04-zero': 'expect(page([10,20],0,0)).toEqual([]);',
  '05-preserve': 'const x=[10,20,30]; page(x,0,2); expect(x).toEqual([10,20,30]);',
  '06-invalid':
    'for(const v of [-1,0.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1]) { expect(()=>page([10],v,1)).toThrow(RangeError); expect(()=>page([10],0,v)).toThrow(RangeError); }',
};
const contract =
  'page(items, offset, limit) returns at most limit items starting at offset, without mutating the input. Offset and limit must be nonnegative safe integers; otherwise throw RangeError. Empty or exhausted input returns []. Item references are preserved.';

async function git(cwd: string, ...args: string[]) {
  const result = await command(
    ['git', '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args],
    cwd,
    '',
    30000,
  );
  assert(result.code === 0 && !result.timedOut, result.stderr);
  return result.stdout.trim();
}

async function testFile(cwd: string, name: string, title: string, body: string) {
  await writeFile(
    join(cwd, 'tests', `${name}.test.ts`),
    `import {test,expect} from 'bun:test';\nimport {page} from '../page.ts';\ntest(${JSON.stringify(title)},()=>{ ${body} });\n`,
  );
}

async function preflight(cwd: string, host: string, name: string, source: string) {
  const path = join(host, 'preflight.json');
  const evidence: Record<string, Awaited<ReturnType<typeof command>>> = {};
  async function check(stage: string, argv: string[], directory: string) {
    // Retain streams even when command throws on interruption, and completed
    // results before a later command or filesystem operation can fail.
    const result = await command(argv, directory, '', 30000, join(host, `preflight-${stage}`));
    evidence[stage] = result;
    await writeFile(path, JSON.stringify(evidence, null, 2));
    return result;
  }
  const oracle =
    "import {page} from './page.ts'; console.log(JSON.stringify(page([10,20,30,40],2,2)));";
  const normal = await check('normal', [process.execPath, 'test'], cwd);
  const original = await check('original', [process.execPath, '-e', oracle], cwd);
  const copy = join(host, 'mutation-copy');
  await cp(cwd, copy, { recursive: true, filter: (path) => !path.endsWith('/.git') });
  await writeFile(join(copy, 'page.ts'), source.replace('offset + limit', 'limit'));
  const mutated = await check('mutated', [process.execPath, 'test'], copy);
  const reproduction = await check('reproduction', [process.execPath, '-e', oracle], copy);
  assert(
    Object.values(evidence).every((result) => !result.timedOut),
    `Preflight timed out: ${path}`,
  );
  assert(
    normal.code === 0 && original.code === 0 && original.stdout.trim() === '[30,40]',
    `Invalid original fixture: ${path}`,
  );
  assert(
    reproduction.code === 0 && reproduction.stdout.trim() === '[]',
    `Invalid mutation: ${path}`,
  );
  if (name === 'sound') {
    assert(
      mutated.code === 1 &&
        /7 pass/.test(mutated.stderr) &&
        /1 fail/.test(mutated.stderr) &&
        /\(fail\) returns a window away from the start/.test(mutated.stderr) &&
        mutated.stderr.includes('07-offset.test.ts') &&
        mutated.stderr.includes('expect(received).toEqual(expected)'),
      `Unexpected mutation failure: ${path}`,
    );
  } else {
    assert(mutated.code === 0, `Unexpected mutation detection: ${path}`);
  }
  return path;
}

export async function prepareTestReview(cwd: string, host: string, name: string, source: string) {
  assert(['weak', 'sound', 'unchanged'].includes(name), 'Unknown test-review condition');
  await mkdir(host, { recursive: true });
  await mkdir(join(cwd, 'tests'));
  await writeFile(join(cwd, 'page.ts'), source);
  await writeFile(join(cwd, 'README.md'), `# Array pagination\n\n${contract} Run \`bun test\`.\n`);
  for (const [file, body] of Object.entries(baseline)) {
    await testFile(cwd, file, file, body);
  }
  await git(cwd, 'add', '.');
  await git(cwd, 'commit', '-qm', 'Initial snapshot');
  const baseCommit = await git(cwd, 'rev-parse', 'HEAD');
  if (name !== 'unchanged') {
    const offset = name === 'weak' ? 0 : 2;
    const expected = name === 'weak' ? '[10,20]' : '[30,40]';
    await testFile(
      cwd,
      '07-offset',
      'returns a window away from the start',
      `expect(page([10,20,30,40,50],${offset},2)).toEqual(${expected});`,
    );
    await testFile(
      cwd,
      '08-reference',
      'preserves item identity',
      'const a={id:1}; const b={id:2}; const input=[a,b]; const out=page(input,0,1); expect(out[0]).toBe(a); expect(out).not.toBe(input);',
    );
  }
  await git(cwd, 'add', '.');
  await git(cwd, 'commit', '--allow-empty', '-qm', 'Current snapshot');
  const headCommit = await git(cwd, 'rev-parse', 'HEAD');
  const baseTree = await git(cwd, 'rev-parse', `${baseCommit}^{tree}`);
  const headTree = await git(cwd, 'rev-parse', 'HEAD^{tree}');
  assert((baseTree === headTree) === (name === 'unchanged'), 'Fixture tree mismatch');
  const evidence = await preflight(cwd, host, name, source);
  return {
    baseCommit,
    headCommit,
    baseTree,
    headTree,
    preflight: evidence,
    modelTimeMs: 180000,
    body: `${contract}\nReview the tests in the current checkout after an update. The previous review covered tests/01-start.test.ts through tests/06-invalid.test.ts against the implementation at commit ${baseCommit}. Confirm the current version and changes, then inspect the tests that need review. Passing tests alone do not establish their adequacy: check the behavior they distinguish and overlap with existing checks. Explain when the prior review still applies to unchanged content. Report concrete problems only; no finding is required. Read and verify locally; do not edit the checkout. No media or publication is required.`,
  };
}
