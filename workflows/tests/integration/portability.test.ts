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
  defaultWorkflowRuntimeDirectory,
  resolveCodexHome,
} from '../../shared/environment.ts';
import { workflowArtifactDirectory } from '../../shared/storage.ts';

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

test('keeps shared workflow code independent of feature modules', () => {
  for (const file of typeScriptFiles(path.join(EXPECTED_ROOT, 'workflows/shared'))) {
    assert.doesNotMatch(
      fs.readFileSync(file, 'utf8'),
      /from ['"]\.\.\/(?:build|code|flow|issue|plan|research|think|invocation)/u,
      file,
    );
  }
});

test('centralizes every runtime GitHub CLI invocation in the shared registry', () => {
  const owner = path.join(EXPECTED_ROOT, 'workflows/shared/github.ts');
  const runtimeFiles = [
    ...typeScriptFiles(path.join(EXPECTED_ROOT, 'hooks')),
    ...typeScriptFiles(path.join(EXPECTED_ROOT, 'workflows')).filter(
      (file) => !file.includes(`${path.sep}workflows${path.sep}tests${path.sep}`),
    ),
  ];
  for (const file of runtimeFiles) {
    if (file === owner) continue;
    assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /['"]gh['"]/u, file);
  }
});

test('centralizes every runtime Codex SDK client behind the sandboxed environment factory', () => {
  const owner = path.join(EXPECTED_ROOT, 'workflows/shared/codex.ts');
  const runtimeFiles = [
    ...typeScriptFiles(path.join(EXPECTED_ROOT, 'hooks')),
    ...typeScriptFiles(path.join(EXPECTED_ROOT, 'workflows')).filter(
      (file) => !file.includes(`${path.sep}workflows${path.sep}tests${path.sep}`),
    ),
  ];
  for (const file of runtimeFiles) {
    if (file === owner) continue;
    const source = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(source, /from ['"]@openai\/codex-sdk['"]/u, file);
    assert.doesNotMatch(source, /new Codex\s*\(/u, file);
  }
});

test('routes every model turn through streaming activity and idle detection', () => {
  for (const relative of [
    'workflows/think/agent.ts',
    'workflows/research/agent.ts',
    'workflows/flow/agent.ts',
  ]) {
    const source = fs.readFileSync(path.join(EXPECTED_ROOT, relative), 'utf8');
    assert.match(source, /modelRun:/u, relative);
    assert.doesNotMatch(source, /AbortSignal\.timeout/u, relative);
  }
  const boundary = fs.readFileSync(path.join(EXPECTED_ROOT, 'workflows/shared/codex.ts'), 'utf8');
  assert.match(boundary, /\.runStreamed\(/u);
  assert.match(boundary, /idleController\.abort/u);
});

test('uses only stable versionless protocol identifiers at runtime', () => {
  const runtimeFiles = [
    ...typeScriptFiles(path.join(EXPECTED_ROOT, 'hooks')),
    ...typeScriptFiles(path.join(EXPECTED_ROOT, 'workflows')).filter(
      (file) => !file.includes(`${path.sep}workflows${path.sep}tests${path.sep}`),
    ),
  ];
  const actual = [
    ...new Set(
      runtimeFiles
        .flatMap((file) => [...fs.readFileSync(file, 'utf8').matchAll(/codex-[a-z0-9-]+\/v\d+/gu)])
        .map((match) => match[0]),
    ),
  ].sort();
  assert.deepEqual(actual, []);
});

test('keeps Build and Plan implementation in the workflow package', () => {
  assert.equal(fs.existsSync(path.join(EXPECTED_ROOT, 'skills/build/scripts')), false);
  assert.equal(fs.existsSync(path.join(EXPECTED_ROOT, 'workflows/flow/build')), false);
  for (const file of ['workflows/build/compile.ts', 'workflows/tests/build/compile.test.ts']) {
    const ignored = spawnSync('git', ['check-ignore', '--quiet', file], { cwd: EXPECTED_ROOT });
    assert.equal(ignored.status, 1, `${file} must override global ignore rules`);
  }
});

test('resolves package and stable sandbox-writable runtime paths without a user-specific home', () => {
  assert.equal(AGENTS_ROOT, EXPECTED_ROOT);
  assert.equal(resolveCodexHome({}, '/Users/example'), '/Users/example/.codex');
  assert.equal(resolveCodexHome({ CODEX_HOME: '/opt/codex' }, '/Users/example'), '/opt/codex');
  assert.equal(
    defaultWorkflowRuntimeDirectory('/private/tmp/example', 501),
    '/private/tmp/example/codex-flow-runtime-501',
  );
});

test('keeps durable handoff cache repository-local, ignored, and versionless', () => {
  const directory = workflowArtifactDirectory(EXPECTED_ROOT);
  assert.equal(directory, path.join(EXPECTED_ROOT, '.codex', 'workflow-artifacts'));
  assert.doesNotMatch(directory, /(?:^|[/\\])v\d+(?:$|[/\\])/u);
  const ignored = spawnSync(
    'git',
    ['check-ignore', '--quiet', '.codex/workflow-artifacts/probe.json'],
    { cwd: EXPECTED_ROOT },
  );
  assert.equal(ignored.status, 0);
});

test('publishes stable CLI names for every documented executable', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(EXPECTED_ROOT, 'package.json'), 'utf8'));
  assert.deepEqual(packageJson.bin, {
    'codex-build-artifacts': 'workflows/build/artifacts.ts',
    'codex-build-plan': 'workflows/plan/validation.ts',
    'codex-build-pr-body': 'workflows/build/pr-body.ts',
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
      'codex-flow-description',
    ],
    ['codex-research', 'workflows/research/runner.ts', ['describe'], 'codex-research-description'],
    ['codex-think', 'workflows/think/runner.ts', ['describe'], 'codex-think-description'],
    ['codex-issue', 'workflows/issue/runner.ts', ['describe'], 'codex-issue-description'],
    [
      'codex-build-artifacts',
      'workflows/build/artifacts.ts',
      ['describe'],
      'codex-build-artifacts-description',
    ],
    [
      'codex-build-plan',
      'workflows/plan/validation.ts',
      ['describe'],
      'codex-build-plan-description',
    ],
    [
      'codex-build-pr-body',
      'workflows/build/pr-body.ts',
      ['describe'],
      'codex-build-pr-body-description',
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
