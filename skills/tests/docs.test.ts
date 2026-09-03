/** @file Outcome: Workflow skills resolve their resources and run through the shared validation path. */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
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
const pairs: Array<readonly [string, string]> = [...skillDocuments, ...skillReferences].map(
  (relative): readonly [string, string] => [
    path.join(skillsRoot, relative),
    path.join(agentsRoot, '.ja/skills', relative),
  ],
);

function localLinks(content: string): string[] {
  return [...content.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)]
    .map((match) => match[1])
    .filter(
      (target): target is string =>
        typeof target === 'string' && !target.startsWith('#') && !target.includes('://'),
    );
}

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

test('the shared check runs code, test, and Skill validation', () => {
  const packageJson = JSON.parse(readFileSync(path.join(agentsRoot, 'package.json'), 'utf8')) as {
    scripts?: Record<string, string>;
  };
  const check = packageJson.scripts?.check ?? '';
  for (const command of ['lint', 'format:check', 'typecheck', 'knip', 'test', 'validate:skills']) {
    assert.match(check, new RegExp(`(?:^|&&\\s*)bun run ${command}(?:\\s*&&|$)`, 'u'), command);
  }
});
