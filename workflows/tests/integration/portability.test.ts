/** @file Outcome: The workflow package remains portable, shared, and self-describing across installations. */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import path from 'node:path';
import { onTestFinished, test } from 'bun:test';
import { fileURLToPath } from 'node:url';

import {
  AGENTS_ROOT,
  defaultWorkflowStateDirectory,
  resolveCodexHome,
} from '../../shared/environment.ts';
import { resolveConfiguredLanguage } from '../../shared/language.ts';

const EXPECTED_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const CODEX_ROOT = path.resolve(EXPECTED_ROOT, '../.codex');

function typeScriptFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === '.git' || entry.name === 'node_modules') return [];
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? typeScriptFiles(file) : file.endsWith('.ts') ? [file] : [];
  });
}

test('documents the outcome of every maintained TypeScript file', () => {
  for (const file of typeScriptFiles(EXPECTED_ROOT)) {
    assert.match(
      fs.readFileSync(file, 'utf8'),
      /^(?:#![^\r\n]+\r?\n)?\/\*\* @file Outcome: [^\r\n]+ \*\/\r?\n/u,
      path.relative(EXPECTED_ROOT, file),
    );
  }
});

test('groups workflow modules by outcome without feature dependencies in shared', () => {
  const workflows = path.join(EXPECTED_ROOT, 'workflows');
  const moduleDirectories = fs
    .readdirSync(workflows, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .filter((entry) => typeScriptFiles(path.join(workflows, entry.name)).length > 0)
    .map((entry) => entry.name)
    .filter((name) => name !== 'tests')
    .sort();
  assert.deepEqual(moduleDirectories, [
    'flow',
    'issue',
    'knowledge',
    'research',
    'shared',
    'think',
  ]);
  assert.deepEqual(
    fs
      .readdirSync(workflows, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
      .map((entry) => entry.name),
    ['invocation.ts'],
  );
  for (const file of typeScriptFiles(path.join(workflows, 'shared'))) {
    assert.doesNotMatch(
      fs.readFileSync(file, 'utf8'),
      /from ['"]\.\.\/(?:flow|issue|research|think|invocation)/u,
      file,
    );
  }
});

test('keeps build implementation and workflow tests with their owning workflow', () => {
  assert.equal(fs.existsSync(path.join(EXPECTED_ROOT, 'skills/build/scripts')), false);
  assert.deepEqual(
    fs
      .readdirSync(path.join(EXPECTED_ROOT, 'workflows/flow/build'))
      .filter((name) => name.endsWith('.ts'))
      .sort(),
    [
      'actions.ts',
      'artifacts.ts',
      'authoring.ts',
      'cli.ts',
      'gates.ts',
      'handoff.ts',
      'plan.ts',
      'pr-body.ts',
      'revalidate.ts',
    ],
  );
  assert.deepEqual(
    fs
      .readdirSync(path.join(EXPECTED_ROOT, 'workflows/tests'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort(),
    ['build', 'flow', 'integration', 'issue', 'knowledge', 'research', 'shared', 'think'],
  );
  for (const file of ['workflows/flow/build/gates.ts', 'workflows/tests/build/gates.test.ts']) {
    const ignored = spawnSync('git', ['check-ignore', '--quiet', file], { cwd: EXPECTED_ROOT });
    assert.equal(ignored.status, 1, `${file} must override global ignore rules`);
  }
});

test('resolves package and Codex state paths without a user-specific home', () => {
  assert.equal(AGENTS_ROOT, EXPECTED_ROOT);
  assert.equal(resolveCodexHome({}, '/Users/example'), '/Users/example/.codex');
  assert.equal(resolveCodexHome({ CODEX_HOME: '/opt/codex' }, '/Users/example'), '/opt/codex');
  assert.equal(
    defaultWorkflowStateDirectory({ CODEX_HOME: '/opt/codex' }, '/Users/example'),
    '/opt/codex/workflow-state/v6',
  );
});

test('resolves the workflow language from the Codex desktop locale', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-language-'));
  onTestFinished(() => fs.rmSync(home, { recursive: true, force: true }));
  const codex = path.join(home, '.codex');
  fs.mkdirSync(codex);
  fs.writeFileSync(
    path.join(codex, 'config.toml'),
    'model = "gpt"\n\n[desktop]\nlocaleOverride = "ja-JP"\n\n[features]\nhooks = true\n',
  );
  assert.equal(resolveConfiguredLanguage('english', {}, home), 'japanese');
  fs.writeFileSync(path.join(codex, 'config.toml'), '[desktop]\nlocaleOverride = "en-US"\n');
  assert.equal(resolveConfiguredLanguage('japanese', {}, home), 'english');
  fs.writeFileSync(path.join(codex, 'config.toml'), '[desktop]\nlocaleOverride = "fr-FR"\n');
  assert.throws(() => resolveConfiguredLanguage('english', {}, home), /not supported.*fr-FR/);
});

test('publishes stable CLI names for every documented executable', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(EXPECTED_ROOT, 'package.json'), 'utf8'));
  assert.deepEqual(packageJson.bin, {
    'codex-build-artifacts': 'workflows/flow/build/artifacts.ts',
    'codex-build-plan': 'workflows/flow/build/plan.ts',
    'codex-build-pr-body': 'workflows/flow/build/pr-body.ts',
    'codex-build-revalidate': 'workflows/flow/build/revalidate.ts',
    'codex-flow': 'workflows/flow/runner.ts',
    'codex-issue': 'workflows/issue/runner.ts',
    'codex-research': 'workflows/research/runner.ts',
    'codex-think': 'workflows/think/runner.ts',
    'codex-post-edit': 'hooks/post-edit.ts',
    'codex-workflow-hook': 'hooks/workflow-enforcer.ts',
  });
  for (const relative of Object.values(packageJson.bin) as string[]) {
    assert.match(
      fs.readFileSync(path.join(EXPECTED_ROOT, relative), 'utf8'),
      /^#!\/usr\/bin\/env bun$/m,
    );
  }
});

test('executes every CLI through a package-manager symlink', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-bin-'));
  onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
  const cases = [
    [
      'codex-flow',
      'workflows/flow/runner.ts',
      ['describe', '--workflow', 'code'],
      'codex-flow-description/v6',
    ],
    [
      'codex-research',
      'workflows/research/runner.ts',
      ['describe'],
      'codex-research-description/v1',
    ],
    ['codex-think', 'workflows/think/runner.ts', ['describe'], 'codex-think-description/v1'],
    ['codex-issue', 'workflows/issue/runner.ts', ['describe'], 'codex-issue-description/v2'],
    [
      'codex-build-artifacts',
      'workflows/flow/build/artifacts.ts',
      ['describe'],
      'codex-build-artifacts-description/v2',
    ],
    [
      'codex-build-plan',
      'workflows/flow/build/plan.ts',
      ['describe'],
      'codex-build-plan-description/v3',
    ],
    [
      'codex-build-pr-body',
      'workflows/flow/build/pr-body.ts',
      ['describe'],
      'codex-build-pr-body-description/v1',
    ],
    [
      'codex-build-revalidate',
      'workflows/flow/build/revalidate.ts',
      ['describe'],
      'codex-build-revalidate-description/v1',
    ],
    ['codex-workflow-hook', 'hooks/workflow-enforcer.ts', [], null],
    ['codex-post-edit', 'hooks/post-edit.ts', [], null],
  ] as const;
  for (const [name, relative, args, protocol] of cases) {
    const executable = path.join(root, name);
    fs.symlinkSync(path.join(EXPECTED_ROOT, relative), executable);
    const result = spawnSync(executable, args, {
      encoding: 'utf8',
      input: name === 'codex-workflow-hook' ? '{}' : undefined,
    });
    assert.equal(result.status, 0, `${name}: ${result.stderr}`);
    const output = JSON.parse(result.stdout);
    if (protocol) assert.equal(output.protocol, protocol, name);
    else assert.deepEqual(output, {}, name);
  }
});

test('workflow hook blocks malformed input instead of returning an empty allow response', () => {
  const result = spawnSync('codex-workflow-hook', [], { input: '{broken', encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const response = JSON.parse(result.stdout);
  assert.equal(response.decision, 'block');
  assert.match(response.reason, /input.*JSON|invalid/i);
});

test('keeps maintained runtime and instruction files independent of a user home', () => {
  const files = [
    'package.json',
    'workflows/shared/environment.ts',
    'hooks/hooks.json',
    'hooks/workflow-enforcer.ts',
    'workflows/flow/controller.ts',
    'workflows/flow/references/shell-gate.md',
    'skills/build/SKILL.md',
    'skills/code/SKILL.md',
    'skills/issue/SKILL.md',
    'skills/code/references/source-verification.md',
    'skills/code/references/testing.md',
    'skills/code/references/skill-authoring.md',
    'skills/code/references/workflow-authoring.md',
    'skills/research/SKILL.md',
    'skills/think/SKILL.md',
    'skills/think/references/decision-writing.md',
    '.ja/workflows/flow/references/shell-gate.md',
    '.ja/skills/build/SKILL.md',
    '.ja/skills/code/SKILL.md',
    '.ja/skills/issue/SKILL.md',
    '.ja/skills/code/references/source-verification.md',
    '.ja/skills/code/references/testing.md',
    '.ja/skills/code/references/skill-authoring.md',
    '.ja/skills/code/references/workflow-authoring.md',
    '.ja/skills/research/SKILL.md',
    '.ja/skills/think/SKILL.md',
    '.ja/skills/think/references/decision-writing.md',
  ].map((relative) => path.join(EXPECTED_ROOT, relative));
  for (const file of files) {
    assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /\/Users\/[^/]+\//u, file);
  }
});

test('keeps package guidance independent of the Claude rules tree', () => {
  const guidance = fs.readFileSync(path.join(EXPECTED_ROOT, '.codex/OUTCOME.md'), 'utf8');
  assert.doesNotMatch(guidance, /(?:\.\/rules|\.claude\/rules)/u);
});

test('keeps hook implementations in the shared agents package only', () => {
  for (const file of ['hooks/package.json', 'hooks/post-edit.ts', 'hooks/workflow-enforcer.ts']) {
    assert.equal(fs.existsSync(path.join(CODEX_ROOT, file)), false, file);
  }
});
