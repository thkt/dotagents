/** @file Outcome: Workflow skills resolve their resources and run through the shared validation path. */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'bun:test';
import { fileURLToPath } from 'node:url';

const skillsRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const agentsRoot = path.resolve(skillsRoot, '..');
const skillDocuments = [
  'cleanup/SKILL.md',
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
    'skills/cleanup/agents/openai.yaml',
    '.ja/skills/cleanup/agents/openai.yaml',
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
  for (const command of [
    'verify:research',
    'lint',
    'format:check',
    'typecheck',
    'knip',
    'test',
    'validate:skills',
  ]) {
    assert.match(check, new RegExp(`(?:^|&&\\s*)bun run ${command}(?:\\s*&&|$)`, 'u'), command);
  }
});

test('pins persistent first-attempt network approval for guarded workflow prefixes', () => {
  for (const [relative, command] of [
    ['skills/research/SKILL.md', '["codex-research", "run"]'],
    ['.ja/skills/research/SKILL.md', '["codex-research", "run"]'],
    ['skills/think/SKILL.md', '["codex-think", "run"]'],
    ['.ja/skills/think/SKILL.md', '["codex-think", "run"]'],
    ['skills/issue/SKILL.md', '["codex-issue", "draft"]'],
    ['.ja/skills/issue/SKILL.md', '["codex-issue", "draft"]'],
    ['skills/build/SKILL.md', '["codex-build", "run"]'],
    ['.ja/skills/build/SKILL.md', '["codex-build", "run"]'],
  ] as const) {
    const content = readFileSync(path.join(agentsRoot, relative), 'utf8');
    assert.match(
      content,
      /first bound (?:workflow|controller|`codex-issue draft`) command itself with network escalation|最初の(?:束縛された workflow| hook-bound `codex-issue draft`|束縛された controller) command 自体を network escalation/u,
      relative,
    );
    assert.match(content, /persistent approval for prefix|prefix .*永続的な許可/u, relative);
    assert.equal(content.includes(command), true, relative);
  }
});

test('pins non-persistent first-attempt escalation for workflows that can write', () => {
  for (const [relative, command] of [
    ['skills/code/SKILL.md', 'codex-code run'],
    ['.ja/skills/code/SKILL.md', 'codex-code run'],
  ] as const) {
    const content = readFileSync(path.join(agentsRoot, relative), 'utf8');
    assert.match(
      content,
      /first .*command itself with network escalation|最初の.*command 自体を network escalation/u,
      relative,
    );
    assert.equal(content.includes(command), true, relative);
    assert.match(content, /Do not request persistent approval|永続的な許可は要求しない/u, relative);
  }
});

test('mirrored workflow and skill guidance preserves the complete waiting interaction and authority chain', () => {
  const documents = [
    '.codex/OUTCOME.md',
    'workflows/README.md',
    ...['research', 'think', 'build'].map((name) => `skills/${name}/SKILL.md`),
  ];
  const requirements = [
    [/investigator- or designer-authored/, /investigator または designer が作成/],
    [/Independent audit or review must accept/, /独立した audit または review が質問全体を受理/],
    [/two or three distinct choices with descriptions/, /説明付きで 2 つまたは 3 つ/],
    [/otherwise as text/, /同じ全文をテキスト/],
    [/explicit listed selection or free-text answer/, /明示的な選択回答または自由記述/],
    [
      /owner binding, complete displayed question context and verbatim answer/,
      /owner binding、表示した質問の全コンテキスト、回答原文/,
    ],
    [
      /exact original root command under the same task identity/,
      /同じ task identity.*元の root command/,
    ],
    [
      /Empty, cancelled, timed-out, absent, silent, inferred and prose-only/,
      /空・取消・timeout・回答なし・沈黙・推測・説明文/,
    ],
    [/immutable startup snapshot/, /変更不能な起動時 snapshot/],
    [/accepted history, correction and retry budgets/, /受理済み履歴、correction と retry の予算/],
    [
      /Refreshing repository evidence requires a new explicit invocation/,
      /repository evidence を更新するには、新たな明示的 invocation/,
    ],
    [/publishing only a verified ready Plan/, /検証済み ready Plan だけを公開/],
    [/separate Issue publication and a new Build/, /別の Issue 公開と新たな Build/],
    [
      /never authorize Issue publication.*authorize Ship/,
      /Issue 公開の承認.*Ship の承認には使わない/,
    ],
  ];
  for (const document of documents)
    for (const [index, prefix] of (document.startsWith('.codex/')
      ? ['']
      : ['', '.ja/']
    ).entries()) {
      const content = readFileSync(path.join(agentsRoot, prefix + document), 'utf8');
      for (const pair of requirements) assert.match(content, pair[index]!, prefix + document);
      if (!document.startsWith('.codex/'))
        for (const field of [
          'clarification_answers',
          'owner',
          'question_id',
          'prompt',
          'choices',
          'recommendation',
          'selection',
          'answer',
        ])
          assert(content.includes('`' + field + '`'), `${prefix}${document}: ${field}`);
      if (document === 'skills/think/SKILL.md')
        assert.match(
          content,
          index === 0
            ? /canonical JSON Plans in English.*visible Plan Markdown, and final reports use the configured language/s
            : /canonical JSON Plan は英語.*表示する Plan Markdown・最終報告は設定言語/s,
        );

      for (const route of [
        'Think → Research',
        'Build → Research',
        'Build → Think',
        'Build → Think → Research',
      ])
        assert(content.includes(route), `${prefix}${document}: ${route}`);
    }
});
