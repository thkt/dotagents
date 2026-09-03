/** @file Outcome: Issue publishes one Think Plan and Build reads that public Plan once. */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import path from 'node:path';
import { test } from 'bun:test';

import { compileBuildPlan, type BuildPlanAuthoring } from '../../plan/contracts.ts';
import { resolveBuildSource } from '../../build/input.ts';
import { validateIssueInput } from '../../issue/contracts.ts';
import type { GitHubIssue, IssueGateway } from '../../issue/github.ts';
import { draftIssue, publishIssue } from '../../issue/pipeline.ts';
import { parsePublicIssueBody, renderPublicIssueBody } from '../../issue/public-contract.ts';
import { atomicWrite, thinkArtifactDirectory } from '../../shared/storage.ts';
import { THINK_REPORT_PROTOCOL, type ThinkReport } from '../../think/contracts.ts';
import { temporaryDirectory, useTemporaryWorkflowStorage } from '../shared/fixtures.ts';

useTemporaryWorkflowStorage('codex-issue-tests-');

const plan: BuildPlanAuthoring = {
  outcome: '値を保存して取得できる。',
  test_command: 'bun test',
  manual_verification: [],
  units: [
    {
      goal: '値を保存する。',
      files: ['src/value.ts'],
      contract: '保存した値を取得すると同じ値を返す。',
      tests: ['保存した値を取得すると同じ値になる。'],
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
    labels: [],
  };
  views = 0;

  checkAccess(): void {}
  view(): GitHubIssue {
    this.views += 1;
    return { ...this.issue, labels: [...this.issue.labels] };
  }
  findByPublicationId(_repository: string, publicationId: string): GitHubIssue | null {
    return this.issue.body.includes(`publication_id:${publicationId}`) ? this.view() : null;
  }
  ensureLabel(): void {}
  create(_repository: string, title: string, bodyFile: string, label: string): GitHubIssue {
    this.issue = {
      number: 1,
      title,
      body: fs.readFileSync(bodyFile, 'utf8'),
      url: 'https://github.com/owner/repo/issues/1',
      labels: [label],
    };
    return this.view();
  }
  edit(_repository: string, _issue: number, bodyFile: string, label: string): GitHubIssue {
    this.issue = { ...this.issue, body: fs.readFileSync(bodyFile, 'utf8'), labels: [label] };
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
  });
  assert.equal(input.repository, 'owner/repo');
  assert.equal(input.remote, 'origin');
  assert.equal(input.priority, 'medium');
});

test('publishes one JSON Plan with no second encoded or hashed Plan representation', () => {
  const repo = repository();
  const gateway = new Gateway();
  const input = validateIssueInput({
    repo,
    mode: 'create',
    think_report: thinkReport(repo),
    title: '保存',
  });
  const draft = draftIssue(input, gateway);
  const published = publishIssue(draft.draft_json, draft.draft_sha256, gateway);
  const parsed = parsePublicIssueBody(published.issue.body);
  assert.deepEqual(parsed.plan.authoring, plan);
  assert.equal((published.issue.body.match(/## Plan/gu) ?? []).length, 1);
  assert.doesNotMatch(published.issue.body, /base64|plan_sha256|body_sha256/u);
});

test('attaching a Plan preserves existing prose', () => {
  const repo = repository();
  const gateway = new Gateway();
  const input = validateIssueInput({
    repo,
    mode: 'attach-plan',
    target_issue: 1,
    think_report: thinkReport(repo),
  });
  const draft = draftIssue(input, gateway);
  publishIssue(draft.draft_json, draft.draft_sha256, gateway);
  assert.equal(parsePublicIssueBody(gateway.issue.body).visibleBody, '背景説明');
});

test('Build accepts a human-authored terminal JSON Plan and fetches the Issue once', () => {
  const repo = repository();
  const gateway = new Gateway();
  gateway.issue = {
    ...gateway.issue,
    title: '保存',
    body: `背景\n\n## Plan\n\n\`\`\`json\n${JSON.stringify(plan, null, 2)}\n\`\`\`\n`,
  };
  const source = resolveBuildSource({ repo, issue_number: 1 }, repo, gateway);
  assert.deepEqual(source.plan, plan);
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
  });
  assert.throws(() => draftIssue(input, gateway), /must be issue-ready/u);
});

test('publication metadata supports idempotent writes but is not part of the Plan', () => {
  const body = renderPublicIssueBody(
    '背景',
    compileBuildPlan(plan),
    '123e4567-e89b-42d3-a456-426614174000',
  );
  const parsed = parsePublicIssueBody(body);
  assert.equal(parsed.publication_id, '123e4567-e89b-42d3-a456-426614174000');
  assert.deepEqual(Object.keys(parsed.plan.authoring), Object.keys(plan));
});
