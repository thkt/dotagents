/** @file Outcome: Workflow skills stay compact, portable, aligned across languages, and free of executable policy. */

import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { test } from 'bun:test';
import { fileURLToPath } from 'node:url';

const skillsRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const agentsRoot = path.resolve(skillsRoot, '..');
const skillDocuments = [
  'build/SKILL.md',
  'code/SKILL.md',
  'issue/SKILL.md',
  'research/SKILL.md',
  'think/SKILL.md',
];
const skillReferences = [
  'code/references/source-verification.md',
  'code/references/testing.md',
  'code/references/skill-authoring.md',
  'code/references/workflow-authoring.md',
  'think/references/decision-writing.md',
];
const pairs: Array<readonly [string, string]> = [
  ...[...skillDocuments, ...skillReferences].map((relative): readonly [string, string] => [
    path.join(skillsRoot, relative),
    path.join(agentsRoot, '.ja/skills', relative),
  ]),
  ...['shell-gate.md'].map((file): readonly [string, string] => [
    path.join(agentsRoot, 'workflows/flow/references', file),
    path.join(agentsRoot, '.ja/workflows/flow/references', file),
  ]),
];

function lineCount(content: string): number {
  return content.trimEnd().split(/\r?\n/).length;
}

function localLinks(content: string): string[] {
  return [...content.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)]
    .map((match) => match[1])
    .filter(
      (target): target is string =>
        typeof target === 'string' && !target.startsWith('#') && !target.includes('://'),
    );
}

function markdownShape(content: string): string[] {
  return content.split(/\r?\n/).flatMap((line) => {
    const heading = /^(#{1,6}) /.exec(line);
    if (heading) return [`heading:${heading[1]!.length}`];
    const fence = /^(```|~~~)/.exec(line);
    if (fence) return [`fence:${fence[1]!}`];
    return [];
  });
}

test('keeps skill entrypoints and references within a 60-line disclosure limit', () => {
  const overflow = pairs
    .flat()
    .map((documentPath) => ({
      path: path.relative(agentsRoot, documentPath),
      lines: lineCount(readFileSync(documentPath, 'utf8')),
    }))
    .filter(({ lines }) => lines > 60)
    .map(({ path: documentPath, lines }) => ({ path: documentPath, lines, over_by: lines - 60 }));
  assert.deepEqual(overflow, []);
});

test('resolves every local Markdown link from the declaring document', () => {
  for (const pair of pairs) {
    for (const documentPath of pair) {
      for (const target of localLinks(readFileSync(documentPath, 'utf8'))) {
        assert.equal(
          existsSync(path.resolve(path.dirname(documentPath), target)),
          true,
          `${path.relative(agentsRoot, documentPath)} -> ${target}`,
        );
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
    'skills/issue/agents/openai.yaml',
    'skills/research/agents/openai.yaml',
    'skills/think/agents/openai.yaml',
    '.ja/skills/build/agents/openai.yaml',
    '.ja/skills/code/agents/openai.yaml',
    '.ja/skills/issue/agents/openai.yaml',
    '.ja/skills/research/agents/openai.yaml',
    '.ja/skills/think/agents/openai.yaml',
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
    /(?:flow-control|controller)\.(?:js|ts)/,
    /(?:verify-command|shell-verifier|shell-gate)\.(?:js|ts)/,
    /PreToolUse|PostToolUse/,
    /\bcursor\b/,
    /immediately followed|直後には/,
    /only `report` can mutate|stateをmutateできるのは/,
    /On `fail`|`fail`では/,
    /\breason_codes\b/,
    /unexpected_pass|unexpected_failure|missing_required_output|forbidden_output/,
    /Build manifest order|Artifact and correction routing|Stable stopped reasons|Migration boundary/,
    /hook-supplied|hook から渡された/,
    /--run-id/,
    /codex-flow-manifest\/v\d+/,
    /codex-flow (?:start|status|next|report)/,
    /codex-build-(?:plan|revalidate|artifacts|pr-body) describe/,
    /\$(?:code|build)\b/,
    /`(?:done|ship-ready|blocked)`/,
    /\breport_result\b/,
    /typed directives?|型付き指示/,
    /reserved (?:input|output)|予約済みの(?:入力|出力)/,
    /```json/,
  ];
  for (const documentPath of instructionDocuments) {
    const content = readFileSync(documentPath, 'utf8');
    for (const pattern of executablePolicy) {
      assert.doesNotMatch(content, pattern, path.relative(agentsRoot, documentPath));
    }
  }
});

test('keeps build implementation and skill documentation tests on the TypeScript runtime path', () => {
  for (const directory of [
    path.join(agentsRoot, 'workflows/flow/build'),
    path.join(skillsRoot, 'tests'),
  ]) {
    const entries = readdirSync(directory);
    assert.equal(
      entries.some((entry) => entry.endsWith('.js')),
      false,
      directory,
    );
    assert.equal(
      entries.some((entry) => entry.endsWith('.ts')),
      true,
      directory,
    );
  }
});

test('keeps the shared Bun toolchain at the agents root', () => {
  for (const file of [
    '.oxfmtrc.json',
    '.oxlintrc.json',
    'knip.json',
    'package.json',
    'bun.lock',
    'skills/validate.ts',
    'tsconfig.json',
  ]) {
    assert.equal(existsSync(path.join(agentsRoot, file)), true, file);
  }
  const packageJson = JSON.parse(readFileSync(path.join(agentsRoot, 'package.json'), 'utf8')) as {
    devDependencies?: Record<string, string>;
    scripts?: Record<string, string>;
  };
  assert.deepEqual(packageJson.scripts, {
    check:
      'bun run lint && bun run format:check && bun run typecheck && bun run knip && bun run test && bun run validate:skills',
    format: 'oxfmt --write .',
    'format:check': 'oxfmt --check .',
    'fix:text': "textlint --fix '.ja/**/*.md'",
    lint: 'oxlint .',
    'lint:fix': 'oxlint --fix .',
    'lint:text': "textlint '.ja/**/*.md'",
    knip: 'knip',
    test: 'bun test --timeout=15000 --parallel=8 --no-isolate workflows/tests skills/tests',
    typecheck: 'tsc -p tsconfig.json',
    'verify:clean': 'bun install --frozen-lockfile --ignore-scripts && bun run check',
    'validate:skills': 'bun skills/validate.ts',
  });
  assert.match(packageJson.devDependencies?.oxfmt ?? '', /^\^0\./u);
  assert.equal(packageJson.devDependencies?.['@types/bun'], '1.4.0');
  assert.match(packageJson.devDependencies?.oxlint ?? '', /^\^1\./u);
  assert.match(packageJson.devDependencies?.['oxlint-tsgolint'] ?? '', /^\^7\./u);
  assert.match(packageJson.devDependencies?.knip ?? '', /^\^6\./u);
  assert.match(packageJson.devDependencies?.yaml ?? '', /^\^2\./u);

  const oxlint = JSON.parse(readFileSync(path.join(agentsRoot, '.oxlintrc.json'), 'utf8')) as {
    categories?: Record<string, string>;
    options?: Record<string, unknown>;
  };
  assert.deepEqual(oxlint.categories, { correctness: 'error' });
  assert.equal(oxlint.options?.typeAware, true);
  assert.equal(oxlint.options?.typeCheck, undefined);

  const oxfmt = JSON.parse(readFileSync(path.join(agentsRoot, '.oxfmtrc.json'), 'utf8')) as {
    singleQuote?: boolean;
  };
  assert.equal(oxfmt.singleQuote, true);
});
