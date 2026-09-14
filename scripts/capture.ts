import { access, writeFile, readFile, realpath } from 'node:fs/promises';
import { resolve, dirname, basename, isAbsolute, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { isRecord } from './input.ts';

// The controller owns the enclosing process group, timeout and output directory.
async function capture() {
  const [specPath, configPath, output] = process.argv.slice(2);
  if (!specPath || !configPath || !output || !isAbsolute(output)) {
    throw Error('Usage: capture.ts SPEC CONFIG ABSOLUTE_OUTPUT');
  }
  const cwd = await realpath(process.cwd());
  const spec = resolve(cwd, specPath);
  await access(spec); // A missing required definition is a failure, never a skipped capture.
  const outputPath = await realpath(output);
  const relation = relative(cwd, outputPath);
  if (!(relation === '..' || relation.startsWith(`..${sep}`) || isAbsolute(relation))) {
    throw Error('Capture output must be outside checkout');
  }
  const requireTarget = createRequire(resolve(cwd, configPath));
  process.env.PLAYWRIGHT_BROWSERS_PATH = '0';
  try {
    await new Promise<void>((done, reject) => {
      const server = createServer();
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () =>
        server.close((error) => (error ? reject(error) : done())),
      );
    });
    const moduleUrl = pathToFileURL(requireTarget.resolve('@playwright/test')).href;
    const probe = spawnSync(
      process.execPath,
      [
        '-e',
        `const {chromium} = await import(${JSON.stringify(moduleUrl)}); const browser = await chromium.launch(); await browser.close();`,
      ],
      { cwd, env: process.env, timeout: 45000, stdio: 'inherit' },
    );
    if (probe.error || probe.status !== 0) {
      throw Error('Browser launch probe failed');
    }
  } catch (error) {
    console.error(
      'Host cannot start the browser/server; host operator must resolve this environment failure.',
      error,
    );
    process.exitCode = 78;
    return;
  }
  const root = dirname(output);
  const report = `${output}.report.json`;
  const config = `${output}.config.js`;
  const base = pathToFileURL(resolve(cwd, configPath)).href;
  await writeFile(
    config,
    `import base from ${JSON.stringify(base)};
export default { ...base, testDir: ${JSON.stringify(dirname(spec))}, testMatch: ${JSON.stringify(basename(spec))},
  testIgnore: [], forbidOnly: true, retries: 0, repeatEach: 1, workers: 1,
  outputDir: ${JSON.stringify(`${output}.artifacts`)},
  reporter: [['json', {outputFile: ${JSON.stringify(report)}}]] };
`,
  );
  const cli = requireTarget.resolve('@playwright/test/cli');
  const child = spawn(process.execPath, [cli, 'test', '--config', config], {
    cwd,
    env: { ...process.env, CAPTURE_OUTPUT: output },
    stdio: 'inherit',
  });
  const code = await new Promise<number | null>((done, reject) => {
    child.once('error', reject);
    child.once('close', done);
  });
  if (code !== 0) {
    throw Error(`Capture failed; report: ${report}`);
  }
  const value: unknown = JSON.parse(await readFile(report, 'utf8'));
  if (
    !isRecord(value) ||
    !isRecord(value.stats) ||
    typeof value.stats.expected !== 'number' ||
    value.stats.expected <= 0 ||
    value.stats.skipped !== 0 ||
    value.stats.unexpected !== 0 ||
    value.stats.flaky !== 0 ||
    !Array.isArray(value.errors) ||
    value.errors.length
  ) {
    throw Error(`Capture must execute all registered tests successfully; report: ${report}`);
  }
  console.log(`Capture passed: ${value.stats.expected} tests; evidence: ${root}`);
}

try {
  await capture();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
