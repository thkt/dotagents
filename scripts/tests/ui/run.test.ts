import { test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('Bun entry uses target Playwright and rejects successful tests without complete sweep records', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sweep-entry-'));
  const repo = join(root, 'repo');
  const entry = resolve(import.meta.dir, '../../ui/run.ts');
  try {
    await mkdir(repo);
    await writeFile(join(repo, 'width.spec.ts'), '');
    await writeFile(join(repo, 'playwright.config.ts'), 'export default {};');
    const execute = (mode: string, output = join(root, mode)) =>
      spawnSync(process.execPath, [entry, 'width.spec.ts', 'playwright.config.ts', output], {
        cwd: repo,
        env: { ...process.env, SWEEP_TEST_MODE: mode },
        encoding: 'utf8',
      });
    const unavailable = execute('unavailable');
    expect(unavailable.status).toBe(1);
    expect(unavailable.stderr).toContain('Target @playwright/test/cli dependency is unavailable');
    expect(existsSync(join(root, 'unavailable'))).toBe(false);
    const dependency = join(repo, 'node_modules/@playwright/test');
    await mkdir(dependency, { recursive: true });
    await writeFile(
      join(dependency, 'package.json'),
      JSON.stringify({ name: '@playwright/test', exports: { './cli': './cli.js' } }),
    );
    // 模擬コマンドでアダプターの接続を確認し、ブラウザーは起動しない。
    await writeFile(
      join(dependency, 'cli.js'),
      `
      import { writeFileSync } from 'node:fs';
      import { join } from 'node:path';
      const out = process.env.WIDTH_SWEEP_OUTPUT;
      const tests = ['chromium', ...(process.env.SWEEP_TEST_MODE.startsWith('multi-') ? ['firefox'] : [])].map(projectName => ({projectName,status:'expected',expectedStatus:'passed',results:[{status:'passed'}]}));
      writeFileSync(out + '.report.json', JSON.stringify({
        stats: {expected:tests.length,skipped:0,unexpected:0,flaky:0}, errors:[],
        config: {rootDir:process.cwd()},
        suites: [{specs:[{file:'width.spec.ts',title:'sweep',line:1,column:0,tests}]}]
      }));
      if (process.env.SWEEP_TEST_MODE !== 'no-record') {
        writeFileSync(join(out, 'sweep.json'), JSON.stringify({status:'passed',error:'',source:'control snapshot',browser:'chromium mock',conditions:'mock DOM',limitations:'no browser',height:900,tolerance:1,minWidth:848,maxWidth:852,
          target:{file:join(process.cwd(),'width.spec.ts'),projectName:'chromium',title:'sweep',line:1,column:0},
          states:[{name:'normal',url:'https://example.test'}],samples:[848,849,850,851,852].map(width=>process.env.SWEEP_TEST_MODE==='duplicate-width'?848:width).map(width=>({state:'normal',url:'https://example.test',width,measurement:{innerWidth:width,clientWidth:width,scrollWidth:width},pageOverflow:false,candidates:[]}))}));
      }
      if (process.env.SWEEP_TEST_MODE === 'multi-complete') {
        const {readFileSync} = await import('node:fs');
        const record = JSON.parse(readFileSync(join(out, 'sweep.json'), 'utf8'));
        record.target.projectName = 'firefox'; record.browser = 'firefox mock';
        writeFileSync(join(out, 'firefox.json'), JSON.stringify(record));
      }
    `,
    );
    const partial = execute('multi-missing');
    expect(partial.status).toBe(1);
    expect(partial.stderr).toContain('Missing sweep record for selected test target');
    expect(execute('multi-complete').status).toBe(0);
    const normal = execute('normal');
    expect(normal.status).toBe(0);
    const source = await readFile(join(root, 'normal.config.mjs'), 'utf8');
    expect(source).toContain('captureConfig');
    expect(source).toContain('playwright.config.ts');
    const before = await readFile(join(root, 'normal/sweep.json'), 'utf8');
    expect(execute('normal').status).toBe(1);
    expect(await readFile(join(root, 'normal/sweep.json'), 'utf8')).toBe(before);
    const absent = execute('no-record');
    expect(absent.status).toBe(1);
    expect(absent.stderr).toContain('No sweep records');
    const duplicate = execute('duplicate-width');
    expect(duplicate.status).toBe(1);
    expect(duplicate.stderr).toContain('Duplicate measured width');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
