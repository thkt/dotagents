import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const skillsRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const agentsRoot = path.resolve(skillsRoot, '..');
const skillDocuments = [
  'build/SKILL.md',
  'build/references/native-build-protocol.md',
  'build/references/shipping-and-stops.md',
  'code/SKILL.md',
];
const pairs = [
  ...skillDocuments.map((relative) => [
    path.join(skillsRoot, relative),
    path.join(agentsRoot, '.ja/skills', relative),
  ]),
  ...['gate-protocol.md', 'workflow-controller.md'].map((file) => [
    path.join(agentsRoot, 'workflows/references', file),
    path.join(agentsRoot, '.ja/workflows/references', file),
  ]),
];

function lineCount(content: string): number {
  return content.trimEnd().split(/\r?\n/).length;
}

function localLinks(content: string): string[] {
  return [...content.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)]
    .map((match) => match[1])
    .filter((target) => !target.startsWith('#') && !target.includes('://'));
}

function markdownShape(content: string): string[] {
  return content.split(/\r?\n/).flatMap((line) => {
    const heading = /^(#{1,6}) /.exec(line);
    if (heading) return [`heading:${heading[1].length}`];
    const fence = /^(```|~~~)/.exec(line);
    if (fence) return [`fence:${fence[1]}`];
    return [];
  });
}

test('keeps skill entrypoints and references within a 60-line disclosure limit', () => {
  for (const pair of pairs) {
    for (const documentPath of pair) {
      assert.ok(lineCount(readFileSync(documentPath, 'utf8')) <= 60,
        path.relative(agentsRoot, documentPath));
    }
  }
});

test('resolves every local Markdown link from the declaring document', () => {
  for (const pair of pairs) {
    for (const documentPath of pair) {
      for (const target of localLinks(readFileSync(documentPath, 'utf8'))) {
        assert.equal(existsSync(path.resolve(path.dirname(documentPath), target)), true,
          `${path.relative(agentsRoot, documentPath)} -> ${target}`);
      }
    }
  }
});

test('keeps the Japanese mirror structurally aligned with the English documents', () => {
  for (const [englishPath, japanesePath] of pairs) {
    const english = readFileSync(englishPath, 'utf8');
    const japanese = readFileSync(japanesePath, 'utf8');
    const label = path.relative(agentsRoot, englishPath);
    assert.deepEqual(markdownShape(japanese), markdownShape(english), label);
    assert.deepEqual(localLinks(japanese), localLinks(english), label);
  }
});

test('requires explicit invocation metadata for both workflow skills and mirrors', () => {
  for (const relative of [
    'skills/build/agents/openai.yaml',
    'skills/code/agents/openai.yaml',
    '.ja/skills/build/agents/openai.yaml',
    '.ja/skills/code/agents/openai.yaml',
  ]) {
    assert.match(
      readFileSync(path.join(agentsRoot, relative), 'utf8').trim(),
      /^policy:\n  allow_implicit_invocation: false$/u,
      relative,
    );
  }
});

test('keeps executable transition policy out of instruction documents', () => {
  const instructionDocuments = pairs.flat();
  const executablePolicy = [
    /flow-control\.js/,
    /verify-command\.js/,
    /PreToolUse|PostToolUse/,
    /\bcursor\b/,
    /immediately followed|直後には/,
    /only `report` can mutate|stateをmutateできるのは/,
    /On `fail`|`fail`では/,
    /\breason_codes\b/,
    /unexpected_pass|unexpected_failure|missing_required_output|forbidden_output/,
    /Build manifest order|Artifact and correction routing|Stable stopped reasons|Migration boundary/,
    /```json/,
  ];
  for (const documentPath of instructionDocuments) {
    const content = readFileSync(documentPath, 'utf8');
    for (const pattern of executablePolicy) {
      assert.doesNotMatch(content, pattern, path.relative(agentsRoot, documentPath));
    }
  }
});

test('keeps every build support module and test on the TypeScript runtime path', () => {
  for (const directory of ['scripts', 'tests']) {
    const entries = readdirSync(path.join(skillsRoot, 'build', directory));
    assert.equal(entries.some((entry) => entry.endsWith('.js')), false, directory);
    assert.equal(entries.some((entry) => entry.endsWith('.ts')), true, directory);
  }
});

test('keeps the shared Node toolchain at the agents root', () => {
  for (const file of [
    'package.json',
    'package-lock.json',
    'pyproject.toml',
    'tools/validate-skills.ts',
    'tsconfig.json',
  ]) {
    assert.equal(existsSync(path.join(agentsRoot, file)), true, file);
  }
  for (const file of [
    'workflows/package.json',
    'workflows/package-lock.json',
    'workflows/tsconfig.json',
    'skills/build/package.json',
    'requirements-dev.txt',
  ]) {
    assert.equal(existsSync(path.join(agentsRoot, file)), false, file);
  }

  const packageJson = JSON.parse(readFileSync(path.join(agentsRoot, 'package.json'), 'utf8')) as {
    scripts?: Record<string, string>;
  };
  assert.equal(
    packageJson.scripts?.['setup:python'],
    'python3 -m venv .venv && .venv/bin/python -m pip install --group dev',
  );
  assert.equal(packageJson.scripts?.['validate:skills'], 'node tools/validate-skills.ts');
  const pyproject = readFileSync(path.join(agentsRoot, 'pyproject.toml'), 'utf8');
  assert.match(pyproject, /^\[dependency-groups\]$/m);
  assert.match(pyproject, /^\s*"PyYAML==6\.0\.3",$/m);
  assert.match(readFileSync(path.join(agentsRoot, '.gitignore'), 'utf8'), /^\.venv\/$/m);
});
