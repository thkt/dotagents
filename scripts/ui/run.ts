import assert from 'node:assert/strict';
import {
  access,
  open,
  lstat,
  mkdir,
  realpath,
  readdir,
  readFile,
  writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { capturePassed, captureUnavailable } from '../capture/capture.ts';
import { outside } from '../shared/values.ts';
import { completeSweep, sweepTargets, targetKey } from './records.ts';

async function run() {
  const [specPath, configPath, output, ...extra] = process.argv.slice(2);
  assert(
    specPath && configPath && output && isAbsolute(output) && extra.length === 0,
    'Usage: bun scripts/ui/run.ts SPEC CONFIG ABSOLUTE_NEW_OUTPUT',
  );
  const cwd = await realpath(process.cwd());
  const spec = resolve(cwd, specPath);
  const configFile = resolve(cwd, configPath);
  await access(spec);
  await access(configFile);
  assert(outside(cwd, await realpath(dirname(output))), 'Output must be outside checkout');
  const requireTarget = createRequire(configFile);
  // Bunの自動インストールでキャッシュへ解決する前に、対象の依存の存在を確認する。
  const dependencies = requireTarget.resolve.paths('@playwright/test') ?? [];
  const installed = await Promise.all(
    dependencies.map(async (directory) => {
      try {
        await access(join(directory, '@playwright/test/package.json'));
        return true;
      } catch {
        return false;
      }
    }),
  );
  assert(installed.some(Boolean), 'Target @playwright/test/cli dependency is unavailable');
  const cli = requireTarget.resolve('@playwright/test/cli');
  await mkdir(output);
  const outputPath = await realpath(output);
  await mkdir(`${outputPath}.artifacts`);
  const reportFile = await open(`${outputPath}.report.json`, 'wx');
  await reportFile.close();
  const config = `${outputPath}.config.mjs`;
  await writeFile(
    config,
    `import base from ${JSON.stringify(pathToFileURL(configFile).href)};
import { captureConfig } from ${JSON.stringify(pathToFileURL(resolve(import.meta.dir, '../capture/config.ts')).href)};
export default captureConfig(base, ${JSON.stringify(configFile)}, ${JSON.stringify(spec)}, ${JSON.stringify(outputPath)});
`,
    { flag: 'wx' },
  );
  const child = spawn(process.execPath, [cli, 'test', '--config', config], {
    cwd,
    env: { ...process.env, WIDTH_SWEEP_OUTPUT: outputPath },
    stdio: 'inherit',
  });
  const code = await new Promise<number | null>((done) => {
    child.once('error', () => done(null));
    child.once('close', done);
  });
  const report = JSON.parse(await readFile(`${outputPath}.report.json`, 'utf8')) as unknown;
  if (code !== 0 && captureUnavailable(report)) {
    process.exitCode = 78;
    return;
  }
  assert(
    code === 0 && capturePassed(report, spec),
    'All selected tests must execute successfully; skipped or empty runs are not sweeps',
  );
  const records = await readdir(outputPath);
  assert(records.length > 0, 'No sweep records');
  const required = sweepTargets(report, spec);
  const covered = new Set<string>();
  for (const name of records) {
    assert(name.endsWith('.json'), 'Only sweep JSON records belong in output');
    assert(
      (await lstat(resolve(outputPath, name))).isFile(),
      'Sweep records must be regular files',
    );
    const target = completeSweep(JSON.parse(await readFile(resolve(outputPath, name), 'utf8')));
    const key = targetKey(target);
    assert(required.has(key), 'Sweep record does not match a selected test target');
    covered.add(key);
  }
  assert(
    [...required].every((key) => covered.has(key)),
    'Missing sweep record for selected test target',
  );
  console.log(`Width sweep passed: ${outputPath}`);
}

if (import.meta.main) {
  try {
    await run();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
