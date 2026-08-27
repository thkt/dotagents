import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  AGENTS_ROOT,
  defaultWorkflowStateDirectory,
  resolveCodexHome,
} from '../../runtime/paths.ts';

const EXPECTED_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CODEX_ROOT = path.resolve(EXPECTED_ROOT, '../.codex');

test('resolves package and Codex state paths without a user-specific home', () => {
  assert.equal(AGENTS_ROOT, EXPECTED_ROOT);
  assert.equal(resolveCodexHome({}, '/Users/example'), '/Users/example/.codex');
  assert.equal(
    resolveCodexHome({ CODEX_HOME: '/opt/codex' }, '/Users/example'),
    '/opt/codex',
  );
  assert.equal(
    defaultWorkflowStateDirectory({ CODEX_HOME: '/opt/codex' }, '/Users/example'),
    '/opt/codex/workflow-state/v1',
  );
});

test('publishes stable CLI names for every documented executable', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(EXPECTED_ROOT, 'package.json'), 'utf8'));
  assert.deepEqual(packageJson.bin, {
    'codex-build-plan': 'skills/build/scripts/validate-plan.ts',
    'codex-build-pr-body': 'skills/build/scripts/render-pr-body.ts',
    'codex-flow': 'workflows/core/flow-control.ts',
  });
  for (const relative of Object.values(packageJson.bin) as string[]) {
    assert.match(fs.readFileSync(path.join(EXPECTED_ROOT, relative), 'utf8'), /^#!\/usr\/bin\/env node$/m);
  }
});

test('executes every CLI through a package-manager symlink', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-bin-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cases = [
    ['codex-flow', 'workflows/core/flow-control.ts', ['describe', '--workflow', 'code'], 'codex-flow-description/v1'],
    ['codex-build-plan', 'skills/build/scripts/validate-plan.ts', ['describe'], 'codex-build-plan-description/v1'],
    ['codex-build-pr-body', 'skills/build/scripts/render-pr-body.ts', ['describe'], 'codex-build-pr-body-description/v1'],
  ] as const;
  for (const [name, relative, args, protocol] of cases) {
    const executable = path.join(root, name);
    fs.symlinkSync(path.join(EXPECTED_ROOT, relative), executable);
    const result = spawnSync(executable, args, { encoding: 'utf8' });
    assert.equal(result.status, 0, `${name}: ${result.stderr}`);
    assert.equal(JSON.parse(result.stdout).protocol, protocol, name);
  }
});

test('keeps maintained runtime and instruction files independent of a user home', () => {
  const files = [
    'package.json',
    'runtime/paths.ts',
    'workflows/core/flow-control.ts',
    'workflows/references/workflow-controller.md',
    'skills/build/SKILL.md',
    'skills/code/SKILL.md',
    'skills/build/references/native-build-protocol.md',
    'skills/build/references/shipping-and-stops.md',
    '.ja/workflows/references/workflow-controller.md',
    '.ja/skills/build/SKILL.md',
    '.ja/skills/code/SKILL.md',
    '.ja/skills/build/references/native-build-protocol.md',
    '.ja/skills/build/references/shipping-and-stops.md',
  ].map((relative) => path.join(EXPECTED_ROOT, relative));
  files.push(
    path.join(CODEX_ROOT, 'hooks.json'),
    path.join(CODEX_ROOT, 'hooks/workflow-enforcer.ts'),
    path.join(CODEX_ROOT, 'hooks/textlint-fix.ts'),
  );
  for (const file of files) {
    assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /\/Users\/[^/]+\//u, file);
  }
});

test('documents only the stable CLI surface', () => {
  for (const relative of ['skills/build/SKILL.md', 'skills/code/SKILL.md', '.ja/skills/build/SKILL.md', '.ja/skills/code/SKILL.md']) {
    assert.match(
      fs.readFileSync(path.join(EXPECTED_ROOT, relative), 'utf8'),
      /codex-flow start --manifest \/absolute\/path\/to\/manifest\.json/u,
      relative,
    );
  }
  for (const relative of ['workflows/references/workflow-controller.md', '.ja/workflows/references/workflow-controller.md']) {
    assert.match(fs.readFileSync(path.join(EXPECTED_ROOT, relative), 'utf8'), /codex-flow describe --workflow code/u, relative);
  }
  for (const relative of ['skills/build/references/native-build-protocol.md', '.ja/skills/build/references/native-build-protocol.md']) {
    assert.match(fs.readFileSync(path.join(EXPECTED_ROOT, relative), 'utf8'), /codex-build-plan describe/u, relative);
  }
  for (const relative of ['skills/build/references/shipping-and-stops.md', '.ja/skills/build/references/shipping-and-stops.md']) {
    assert.match(fs.readFileSync(path.join(EXPECTED_ROOT, relative), 'utf8'), /codex-build-pr-body describe/u, relative);
  }
});
