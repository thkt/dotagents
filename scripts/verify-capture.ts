// The common suite must not require a target repository's browser installation.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, realpath, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { command, withInterrupts } from './process.ts';
import { validateCaptureMedia } from './capture.ts';

async function availablePort() {
  const server = createServer();
  await new Promise<void>((done, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', done);
  });
  const address = server.address();
  assert(address && typeof address !== 'string');
  await new Promise<void>((done, reject) =>
    server.close((error) => (error ? reject(error) : done())),
  );
  return address.port;
}

const [target, browser] = process.argv.slice(2);
assert(
  target && browser && ['chromium', 'firefox', 'webkit'].includes(browser),
  'Host only: bun scripts/verify-capture.ts TARGET_REPO chromium|firefox|webkit',
);
const requireTarget = createRequire(resolve(target, 'package.json'));
const playwright = requireTarget.resolve('@playwright/test/package.json');
const root = await realpath(await mkdtemp(join(tmpdir(), 'capture-integration-')));
const repo = join(root, 'repo');
await mkdir(join(repo, 'config/tests'), { recursive: true });
await mkdir(join(repo, 'outside'));
await mkdir(join(repo, 'node_modules/@playwright'), { recursive: true });
await symlink(resolve(playwright, '..'), join(repo, 'node_modules/@playwright/test'));
const config = join(repo, 'config/playwright.config.mjs');
const port = await availablePort();
await writeFile(join(repo, 'package.json'), '{"type":"module"}');
await writeFile(
  join(repo, 'config/server.ts'),
  `import {writeFileSync} from 'node:fs';
writeFileSync(process.env.CAPTURE_OUTPUT + '.cwd', process.cwd());
const server = Bun.serve({port: ${port}, hostname: '127.0.0.1', fetch: () => new Response('capture fixture')});
console.log('READY ' + server.port);`,
);
await writeFile(
  join(repo, 'config/tests/setup.spec.ts'),
  `import { test } from '@playwright/test';
import { writeFileSync } from 'node:fs';
test('setup', () => {
 writeFileSync(process.env.CAPTURE_OUTPUT + '.setup', 'ready');
 // Otherwise empty media could hide a missing execution check for skipped or absent specs.
 writeFileSync(process.env.CAPTURE_OUTPUT + '/setup.png', Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=', 'base64'));
});`,
);
const definition = `import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
test('capture selected browser', async ({page, browserName}) => {
 expect(browserName).toBe(${JSON.stringify(browser)});
 expect(readFileSync(process.env.CAPTURE_OUTPUT + '.setup', 'utf8')).toBe('ready');
 await page.setContent('<h1>Capture integration</h1>');
 await page.screenshot({path: join(process.env.CAPTURE_OUTPUT, 'view.png')});
});`;
const normalSpec = join(repo, 'config/tests/capture[1].spec.ts');
const outsideSpec = join(repo, 'outside/capture[1].spec.ts');
await writeFile(normalSpec, definition);
await writeFile(outsideSpec, definition);
await writeFile(
  join(repo, 'config/tests/unselected.spec.ts'),
  "throw Error('unselected spec ran');",
);
function configSource(unavailable = false) {
  return `export default {
 testDir: './tests', reporter: [['html', {outputFolder: './bad-report'}]],
 webServer: { command: ${JSON.stringify(`${process.execPath} server.ts`)}, url: ${JSON.stringify(`http://127.0.0.1:${port}`)}, reuseExistingServer: false },
 projects: [
  {name: 'setup', testMatch: /setup.spec.ts/},
  {name: 'selected', testDir: './tests', dependencies: ['setup'], outputDir: './bad-artifacts',
   use: {browserName: ${JSON.stringify(browser)}, ${unavailable ? "launchOptions: {executablePath: '/nonexistent/capture-browser'}," : ''}}
  }
 ]
};`;
}
async function contents() {
  const paths = (await readdir(repo, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
  return Promise.all(paths.map(async (path) => [path, (await readFile(path)).toString('base64')]));
}
async function verify(name: string, spec: string, status: number, rejection?: RegExp) {
  const output = join(root, name);
  await mkdir(output);
  const before = await contents();
  const result = await withInterrupts(() =>
    command(
      [process.execPath, resolve(import.meta.dir, 'capture.ts'), spec, config, output],
      repo,
      '',
      60000,
      join(root, name + '.log'),
    ),
  );
  assert(
    !result.timedOut && result.code === status,
    `${name}: expected ${status}; inspect ${root}`,
  );
  assert.deepEqual(await contents(), before, `Capture changed checkout: ${name}`);
  if (rejection) {
    assert.match(result.stderr, rejection);
  }
  if (name === 'skipped' || name === 'zero') {
    await validateCaptureMedia(output);
  }
  if (status === 0) {
    assert.equal(await readFile(output + '.cwd', 'utf8'), join(repo, 'config'));
    assert((await readdir(output)).includes('view.png'));
  }
}
console.log(
  `Host capture integration evidence: ${root}; Playwright: ${playwright}; browser: ${browser}`,
);
await writeFile(config, configSource());
await verify('normal', normalSpec, 0);
await verify('outside', outsideSpec, 0);
await writeFile(
  outsideSpec,
  "import {test} from '@playwright/test'; test.skip('not executed', () => {});",
);
await verify('skipped', outsideSpec, 1, /Capture must execute all registered tests successfully/);
await writeFile(outsideSpec, 'export {};');
await verify('zero', outsideSpec, 1, /Capture must execute all registered tests successfully/);
await writeFile(
  outsideSpec,
  "import {test, expect} from '@playwright/test'; test('failure', () => expect(1).toBe(2));",
);
await verify('failed', outsideSpec, 1, /Capture must execute all registered tests successfully/);
await writeFile(
  outsideSpec,
  `import {test} from '@playwright/test'; import {writeFileSync} from 'node:fs';
test('invalid media', () => writeFileSync(process.env.CAPTURE_OUTPUT + '/view.png', 'not an image'));`,
);
await verify('invalid-media', outsideSpec, 1, /Invalid capture media: view\.png/);
await writeFile(outsideSpec, definition);
await writeFile(config, configSource(true));
await verify('unavailable', outsideSpec, 78);
console.log(`Host capture integration passed; retained evidence: ${root}`);
