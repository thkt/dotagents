/** @file Outcome: Issue publishes readable prose and one Think Plan that Build reads once. */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import path from 'node:path';
import { test } from 'bun:test';

import type { BuildPlanAuthoring } from '../../plan/contracts.ts';
import { resolveBuildSource } from '../../build/input.ts';
import { validateIssueInput } from '../../issue/contracts.ts';
import type { GitHubIssue, IssueGateway } from '../../issue/github.ts';
import { draftIssue, publishIssue } from '../../issue/pipeline.ts';
import { parsePublicIssueBody, renderPublicIssueBody } from '../../issue/public-contract.ts';
import { atomicWrite, thinkArtifactDirectory } from '../../runtime/storage.ts';
import { THINK_REPORT_PROTOCOL, type ThinkReport } from '../../think/contracts.ts';
import { temporaryDirectory, useTemporaryWorkflowStorage } from '../shared/fixtures.ts';

useTemporaryWorkflowStorage('codex-issue-tests-');

const plan: BuildPlanAuthoring = {
  outcome: '値を保存して取得できる。',
  test_command: 'bun test',
  units: [
    {
      goal: '値を保存する。',
      files: ['src/value.ts'],
      contract: '保存した値を取得すると同じ値を返す。',
      tests: ['保存した値を取得すると同じ値になる。'],
    },
    {
      goal: '保存した値を一覧表示する。',
      files: ['src/list.ts', 'src/list.test.ts'],
      contract: '保存済みの値を作成順に表示する。',
      tests: ['二つの値を保存すると作成順に表示される。', '保存済みの値がないと空一覧を表示する。'],
    },
  ],
};

function repository(): string {
  const repo = temporaryDirectory('codex-issue-repo-');
  spawnSync('git', ['init', '-q', '-b', 'main', repo]);
  spawnSync('git', ['-C', repo, 'remote', 'add', 'origin', 'git@github.com:owner/repo.git']);
  fs.mkdirSync(path.join(repo, 'src'));
  fs.writeFileSync(path.join(repo, 'src/value.ts'), 'export const value = 1;\n');
  spawnSync('git', ['-C', repo, 'add', '.']);
  spawnSync('git', [
    '-C',
    repo,
    '-c',
    'user.name=Issue Test',
    '-c',
    'user.email=issue@example.test',
    'commit',
    '-qm',
    'fixture',
  ]);
  return repo;
}

function thinkReport(repo: string, value: BuildPlanAuthoring | null = plan): string {
  const file = path.join(thinkArtifactDirectory(repo), 'ready.json');
  const report: ThinkReport = {
    protocol: THINK_REPORT_PROTOCOL,
    generated_at: new Date().toISOString(),
    request: '保存を追加する',
    status: value ? 'ready' : 'research_required',
    plan: value,
    research_questions: value ? [] : ['永続化方式は何か。'],
    research_reports: [],
  };
  atomicWrite(file, report);
  return file;
}

class Gateway implements IssueGateway {
  issue: GitHubIssue = {
    number: 1,
    title: '既存 Issue',
    body: '背景説明',
    url: 'https://github.com/owner/repo/issues/1',
  };
  views = 0;
  edits = 0;

  checkAccess(): void {}
  view(): GitHubIssue {
    this.views += 1;
    return { ...this.issue };
  }
  create(_repository: string, title: string, bodyFile: string): GitHubIssue {
    this.issue = {
      number: 1,
      title,
      body: fs.readFileSync(bodyFile, 'utf8'),
      url: 'https://github.com/owner/repo/issues/1',
    };
    return this.view();
  }
  edit(_repository: string, _issue: number, title: string, bodyFile: string): GitHubIssue {
    this.edits += 1;
    this.issue = { ...this.issue, title, body: fs.readFileSync(bodyFile, 'utf8') };
    return this.view();
  }
}

test('Issue input derives repository identity from origin', () => {
  const repo = repository();
  const input = validateIssueInput({
    repo,
    mode: 'create',
    think_report: thinkReport(repo),
    title: '保存',
    prose: '## 背景\n\n値を保存できない。',
  });
  assert.equal(input.repository, 'owner/repo');
  assert.equal(input.remote, 'origin');
});

test('publishes visible Plan details and the same canonical Build source', () => {
  const repo = repository();
  const gateway = new Gateway();
  const input = validateIssueInput({
    repo,
    mode: 'create',
    think_report: thinkReport(repo),
    title: '保存',
    prose: '## 背景\n\n値を保存できない。\n\n## 決定\n\n永続化を追加する。',
  });
  const draft = draftIssue(input, gateway);
  const published = publishIssue(draft, gateway);
  const parsed = parsePublicIssueBody(published.issue.body);
  assert.deepEqual(parsed.plan, plan);
  assert.match(parsed.prose, /## 背景[\s\S]*## 決定/u);
  assert.equal((published.issue.body.match(/## Plan/gu) ?? []).length, 1);
  const visible = published.issue.body.split('<details>')[0]!;
  for (const value of [
    plan.outcome,
    plan.test_command,
    ...plan.units.flatMap((unit) => [unit.goal, ...unit.files, unit.contract, ...unit.tests]),
  ]) {
    assert.ok(visible.includes(value), `Plan value must be visible outside details: ${value}`);
  }
  assert.match(visible, /### 1\. 値を保存する。/u);
  assert.match(visible, /### 2\. 保存した値を一覧表示する。/u);
  assert.match(visible, /- Test command: `bun test`/u);
  const jsonBlocks = [...published.issue.body.matchAll(/```json\n([\s\S]*?)\n```/gu)];
  assert.equal(jsonBlocks.length, 1);
  assert.deepEqual(JSON.parse(jsonBlocks[0]![1]!), plan);
  const views = gateway.views;
  const source = resolveBuildSource(
    { repo, issue_number: 1, ship: false, screenshots: [] },
    repo,
    gateway,
  );
  assert.deepEqual(source.plan, plan);
  assert.equal(gateway.views, views + 1);
});

test('updates the complete human-readable Issue around the Think Plan', () => {
  const repo = repository();
  const gateway = new Gateway();
  const input = validateIssueInput({
    repo,
    mode: 'update',
    target_issue: 1,
    think_report: thinkReport(repo),
    title: '保存機能を追加する',
    prose:
      '## 背景\n\nResearchで保存機能の不足を確認した。\n\n## 決定\n\nThinkで永続化を採用した。',
  });
  const draft = draftIssue(input, gateway);
  publishIssue(draft, gateway);
  assert.equal(gateway.issue.title, '保存機能を追加する');
  assert.equal(
    parsePublicIssueBody(gateway.issue.body).prose,
    '## 背景\n\nResearchで保存機能の不足を確認した。\n\n## 決定\n\nThinkで永続化を採用した。',
  );
  assert.equal(gateway.edits, 1);
});

test('Build reads a direct JSON Plan once with optional delivery input', () => {
  const repo = repository();
  const gateway = new Gateway();
  gateway.issue = {
    ...gateway.issue,
    title: '保存',
    body: `## 背景\n\n保存機能が必要。\n\n## Plan\n\n\`\`\`json\n${JSON.stringify(plan, null, 2)}\n\`\`\`\n`,
  };
  const source = resolveBuildSource(
    {
      repo,
      issue_number: 1,
      ship: true,
      screenshots: [{ name: 'result.png', alt: 'Completed result' }],
    },
    repo,
    gateway,
  );
  assert.deepEqual(source.plan, plan);
  assert.deepEqual(source.screenshots, [{ name: 'result.png', alt: 'Completed result' }]);
  assert.equal(gateway.views, 1);
});

test('Issue refuses a Think result that still requires Research', () => {
  const repo = repository();
  const gateway = new Gateway();
  const input = validateIssueInput({
    repo,
    mode: 'create',
    think_report: thinkReport(repo, null),
    title: '保存',
    prose: '## 背景\n\n保存機能が必要。',
  });
  assert.throws(() => draftIssue(input, gateway), /must be issue-ready/u);
});

test('round-trips visible Plan Markdown and collapsed canonical JSON', () => {
  const body = renderPublicIssueBody('## 背景\n\n保存機能が必要。', plan);
  const parsed = parsePublicIssueBody(body);
  assert.equal(parsed.prose, '## 背景\n\n保存機能が必要。');
  assert.match(body, /<details>\n<summary>Build Plan JSON<\/summary>/u);
  assert.deepEqual(parsed.plan, plan);
});

test('reads the Plan independently of surrounding presentation markup', () => {
  const body = `## Background

Storage is required.

## Plan

<section data-view="custom">

\`\`\`json
${JSON.stringify(plan, null, 2)}
\`\`\`

</section>

## Notes

\`\`\`json
{"not":"a Plan"}
\`\`\`
`;
  const parsed = parsePublicIssueBody(body);
  assert.deepEqual(parsed.plan, plan);
});

test('rejects a second Plan authored in human prose', () => {
  const repo = repository();
  assert.throws(
    () =>
      validateIssueInput({
        repo,
        mode: 'create',
        think_report: thinkReport(repo),
        title: '保存',
        prose: '## Plan\n\n手書きのPlan',
      }),
    /reserved Plan section/u,
  );
});

test('stops an update when the target changed after draft validation', () => {
  const repo = repository();
  const gateway = new Gateway();
  const input = validateIssueInput({
    repo,
    mode: 'update',
    target_issue: 1,
    think_report: thinkReport(repo),
    title: '保存機能を追加する',
    prose: '## 背景\n\n保存機能が必要。',
  });
  const draft = draftIssue(input, gateway);
  gateway.issue = { ...gateway.issue, body: '第三者が更新した本文' };
  assert.throws(() => publishIssue(draft, gateway), /target issue changed/u);
  assert.equal(gateway.edits, 0);
});
