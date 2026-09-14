import assert from 'node:assert/strict';
import { test, expect } from 'bun:test';
import {
  mkdtemp,
  mkdir,
  writeFile,
  rm,
  symlink,
  readFile,
  realpath,
  readdir,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { captureConfig } from '../capture-config.ts';
import { capturePassed, captureUnavailable, validateCaptureMedia } from '../capture.ts';

const configFile = '/target/config/playwright.config.ts';
const spec = '/target/config/tests/capture[1].spec.ts';
const output = '/evidence/media';
test('capture retains project inputs and confines selection and artifacts to the requested paths', () => {
  const base = {
    testDir: './tests',
    testMatch: /setup/,
    snapshotDir: './baselines',
    expect: { toHaveScreenshot: { pathTemplate: '{testDir}/baselines/{arg}{ext}' } },
    snapshotPathTemplate: '{configDir}/baselines/{projectName}/{arg}{ext}',
    outputDir: './reports',
    use: { baseURL: 'http://localhost:3000', storageState: './auth.json' },
    webServer: [{ command: 'run frontend' }, { command: 'run backend', cwd: '../backend' }],
    projects: [
      { name: 'setup', testMatch: /setup/ },
      {
        name: 'firefox',
        testDir: './tests',
        dependencies: ['setup'],
        use: { browserName: 'firefox' },
        outputDir: './bad',
      },
      { name: 'webkit', testDir: '../elsewhere', use: { browserName: 'webkit' } },
      { testDir: './unnamed' },
    ],
  };
  const config = captureConfig(base, configFile, spec, output);
  expect(config.webServer).toEqual([
    { command: 'run frontend', cwd: '/target/config' },
    { command: 'run backend', cwd: '/target/backend' },
  ]);
  expect(config).toMatchObject({
    forbidOnly: true,
    updateSnapshots: 'none',
    reporter: [['json', { outputFile: '/evidence/media.report.json' }]],
  });
  const [setup, firefox, webkit, unnamed] = config.projects ?? [];
  assert(setup && firefox && webkit && unnamed);
  expect(setup.testDir).toBe('/target/config/tests');
  expect(setup.testMatch).toEqual(/setup/);
  for (const project of [firefox, webkit, unnamed]) {
    expect(project.testDir).toBe('/target/config/tests');
    assert(project.testMatch instanceof RegExp);
    expect(project.testMatch.test(spec)).toBe(true);
    expect(project.testMatch.test(spec.replace('[1]', '1'))).toBe(false);
    expect(project.outputDir).toBe('/evidence/media.artifacts');
    expect(project.snapshotDir).toBe('/target/config/baselines');
    expect(project.snapshotPathTemplate).toBe('/target/config/baselines/{projectName}/{arg}{ext}');
  }
  expect(firefox).toMatchObject({ dependencies: ['setup'], use: { browserName: 'firefox' } });
  expect(webkit).toMatchObject({
    use: { browserName: 'webkit' },
    expect: { toHaveScreenshot: { pathTemplate: '/target/elsewhere/baselines/{arg}{ext}' } },
  });
  expect(base.projects[1]?.outputDir).toBe('./bad');
});

test('single-project capture supports a spec outside testDir and resolves relative hooks', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'capture-config-')));
  try {
    await writeFile(join(root, 'setup.ts'), 'export default () => {};');
    const config = captureConfig(
      {
        testDir: './normal',
        globalSetup: './setup.ts',
        webServer: { command: 'serve', cwd: '.' },
        tsconfig: './tsconfig.json',
      },
      join(root, 'config.ts'),
      join(root, 'outside/demo.spec.ts'),
      output,
    );
    expect(config.testDir).toBe(join(root, 'outside'));
    expect(config.globalSetup).toBe(join(root, 'setup.ts'));
    expect(config.webServer).toEqual({ command: 'serve', cwd: root });
    expect(config.tsconfig).toBe(join(root, 'tsconfig.json'));
    expect(config.projects).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('capture preserves project expect replacement and config-relative screenshot styles', () => {
  const config = captureConfig(
    {
      expect: { timeout: 20, toHaveScreenshot: { stylePath: './base.css' } },
      projects: [
        { name: 'inherited' },
        {
          name: 'own',
          expect: { toHaveScreenshot: { stylePath: ['./hide.css', '../theme.css'] } },
        },
      ],
    },
    configFile,
    spec,
    output,
  );
  expect(config.projects?.[0]?.expect).toEqual({
    timeout: 20,
    toHaveScreenshot: { stylePath: ['/target/config/base.css'] },
  });
  expect(config.projects?.[1]?.expect).toEqual({
    toHaveScreenshot: { stylePath: ['/target/config/hide.css', '/target/theme.css'] },
  });
});

test('capture report rejects non-execution and failures; only launch failures are unavailable', () => {
  const report = {
    stats: { expected: 1, skipped: 0, unexpected: 0, flaky: 0 },
    errors: [],
    config: { rootDir: '/target/config/tests' },
    suites: [
      {
        specs: [
          {
            file: 'capture[1].spec.ts',
            tests: [
              { status: 'expected', expectedStatus: 'passed', results: [{ status: 'passed' }] },
            ],
          },
        ],
      },
    ],
  };
  expect(capturePassed(report, spec)).toBe(true);
  expect(
    capturePassed(
      {
        ...report,
        suites: [
          {
            specs: [
              {
                file: spec,
                tests: [
                  { status: 'expected', expectedStatus: 'failed', results: [{ status: 'failed' }] },
                ],
              },
            ],
          },
        ],
      },
      spec,
    ),
  ).toBe(false);
  expect(capturePassed(report, '/target/config/tests/missing.spec.ts')).toBe(false);
  for (const stats of [{ expected: 0 }, { skipped: 1 }, { unexpected: 1 }, { flaky: 1 }]) {
    expect(capturePassed({ ...report, stats: { ...report.stats, ...stats } }, spec)).toBe(false);
  }
  expect(capturePassed({ ...report, errors: [{ message: 'setup failed' }] }, spec)).toBe(false);
  expect(capturePassed({ stats: report.stats }, spec)).toBe(false);
  expect(
    captureUnavailable({
      message: "browserType.launch: Executable doesn't exist at /cache/firefox",
    }),
  ).toBe(true);
  expect(
    captureUnavailable({
      message:
        'browserType.launch: Target page, context or browser has been closed\nBrowser logs:\nFailed to launch',
    }),
  ).toBe(true);
  expect(captureUnavailable({ message: 'listen EPERM: operation not permitted' })).toBe(true);
  expect(captureUnavailable({ message: 'expect(received).toBe(expected)' })).toBe(false);
});

test('capture CLI fails for missing specs before checking browser availability', async () => {
  const root = await mkdtemp(join(tmpdir(), 'capture-cli-'));
  try {
    const repo = join(root, 'repo'),
      media = join(root, 'media');
    await mkdir(repo);
    await mkdir(media);
    const result = spawnSync(
      process.execPath,
      [resolve(import.meta.dir, '../capture.ts'), 'missing.spec.ts', 'config.ts', media],
      { cwd: repo, encoding: 'utf8' },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('missing.spec.ts');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('capture refuses empty, disguised and linked media', async () => {
  const root = await mkdtemp(join(tmpdir(), 'capture-media-'));
  try {
    const output = join(root, 'media');
    await mkdir(output);
    await assert.rejects(() => validateCaptureMedia(output), /without required media/);
    const image = join(output, 'image.png');
    await writeFile(image, 'not an image despite the extension');
    await assert.rejects(() => validateCaptureMedia(output), /Invalid capture media/);
    await writeFile(
      image,
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=',
        'base64',
      ),
    );
    await validateCaptureMedia(output);
    await writeFile(join(root, 'original.png'), await readFile(image));
    await rm(image);
    await symlink(join(root, 'original.png'), image);
    await assert.rejects(() => validateCaptureMedia(output), /Invalid capture output/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const scenario of ['passed', 'skipped', 'missing_spec'] as const) {
  test(`capture CLI ${scenario} checks execution with valid media and preserves host settings`, async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'capture-adapter-')));
    try {
      const repo = join(root, 'repo'),
        output = join(root, 'media');
      const packageDir = join(repo, 'node_modules/@playwright/test');
      await mkdir(packageDir, { recursive: true });
      await mkdir(join(repo, 'config/tests'), { recursive: true });
      await mkdir(output);
      await writeFile(
        join(packageDir, 'package.json'),
        JSON.stringify({
          name: '@playwright/test',
          type: 'module',
          exports: { './cli': './cli.mjs' },
        }),
      );
      const selectedStatus = scenario === 'skipped' ? 'skipped' : 'passed';
      const specs = [
        {
          file: scenario === 'missing_spec' ? 'setup.spec.ts' : 'capture.spec.ts',
          tests: [
            {
              status: scenario === 'skipped' ? 'skipped' : 'expected',
              expectedStatus: selectedStatus,
              results: [{ status: selectedStatus }],
            },
          ],
        },
      ];
      if (scenario === 'skipped') {
        specs.push({
          file: 'setup.spec.ts',
          tests: [
            { status: 'expected', expectedStatus: 'passed', results: [{ status: 'passed' }] },
          ],
        });
      }
      await writeFile(
        join(packageDir, 'cli.mjs'),
        `import {writeFileSync} from 'node:fs';
const {default: config} = await import(process.argv[process.argv.indexOf('--config') + 1]);
const output = process.env.CAPTURE_OUTPUT;
writeFileSync(output + '.observed.json', JSON.stringify({cache: process.env.PLAYWRIGHT_BROWSERS_PATH, server: config.webServer, projects: config.projects}));
writeFileSync(config.reporter[0][1].outputFile, JSON.stringify({
 config: {rootDir: config.testDir}, stats: {expected: 1, skipped: ${scenario === 'skipped' ? 1 : 0}, unexpected: 0, flaky: 0}, errors: [],
 suites: [{specs: ${JSON.stringify(specs)}}]
}));
writeFileSync(output + '/view.png', Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=', 'base64'));`,
      );
      await writeFile(
        join(repo, 'config/playwright.config.mjs'),
        `export default {testDir:'./tests', webServer: {command:'serve'}, projects:[{name:'webkit', testDir:'./tests', use:{browserName:'webkit'}}]};`,
      );
      await writeFile(join(repo, 'config/tests/capture.spec.ts'), 'export {};');
      const result = spawnSync(
        process.execPath,
        [
          resolve(import.meta.dir, '../capture.ts'),
          'config/tests/capture.spec.ts',
          'config/playwright.config.mjs',
          output,
        ],
        {
          cwd: repo,
          encoding: 'utf8',
          timeout: 10000,
          env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: '/host/browser-cache' },
        },
      );
      expect(result.status).toBe(scenario === 'passed' ? 0 : 1);
      if (scenario === 'passed') {
        expect(result.stderr).toBe('');
      } else {
        expect(result.stderr).toContain('Capture must execute all registered tests successfully');
      }
      expect(JSON.parse(await readFile(output + '.observed.json', 'utf8'))).toMatchObject({
        cache: '/host/browser-cache',
        server: { cwd: join(repo, 'config') },
        projects: [
          {
            testDir: join(repo, 'config/tests'),
            outputDir: output + '.artifacts',
            use: { browserName: 'webkit' },
          },
        ],
      });
      expect(await readdir(join(repo, 'config/tests'))).toEqual(['capture.spec.ts']);
      await validateCaptureMedia(output);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
