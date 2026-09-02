/** @file Outcome: Issue publication is single-invocation, immutable, and artifact-backed. */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { test } from 'bun:test';

import { compileContext } from '../../../workflows/knowledge/context.ts';
import { draftIssue, publishIssue } from '../../../workflows/issue/pipeline.ts';
import {
  describeIssue,
  draftIssueWorkflow,
  main as issueMain,
} from '../../../workflows/issue/runner.ts';
import { armIntent, loadIntent } from '../../../workflows/invocation.ts';
import {
  ISSUE_INPUT_PROTOCOL,
  ISSUE_RESULT_PROTOCOL,
  type IssueInput,
} from '../../../workflows/issue/contracts.ts';
import type { GitHubIssue, IssueGateway } from '../../../workflows/issue/github.ts';
import { persistThinkReport } from '../../../workflows/think/artifact.ts';
import { THINK_REPORT_PROTOCOL, type ThinkReport } from '../../../workflows/think/contracts.ts';
import { repositoryInvariant } from '../../../workflows/shared/repository.ts';
import {
  intentPath,
  issueApprovalPath,
  workflowInputPath,
} from '../../../workflows/shared/storage.ts';
import { emptyStageTimings } from '../../../workflows/shared/codex.ts';
import { sha256 } from '../../../workflows/shared/evidence.ts';
import { ProgressReporter, type ProgressEvent } from '../../../workflows/shared/progress.ts';
import {
  BUILD_SOURCE_PROTOCOL,
  resolveBuildSource,
} from '../../../workflows/flow/build/handoff.ts';
import { renderPlanMarkdown } from '../../../workflows/flow/build/authoring.ts';
import { parsePublicIssueBody } from '../../../workflows/issue/public-contract.ts';
import { temporaryDirectory, useTemporaryWorkflowStorage } from '../shared/fixtures.ts';

useTemporaryWorkflowStorage('codex-issue-storage-');

function repoFixture(): string {
  const repo = temporaryDirectory('codex-issue-');
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'README.md'), 'fixture\n');
  execFileSync('git', ['add', '.'], { cwd: repo });
  execFileSync(
    'git',
    ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'fixture'],
    { cwd: repo },
  );
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/owner/repo.git'], {
    cwd: repo,
  });
  return repo;
}

const plan = {
  outcome: 'テスト可能な変更',
  root_cause: null,
  test_command: 'npm test',
  reference_module: {
    kind: 'no-module' as const,
    reason: '単一の変更',
    path: null,
    files: [],
    instances: 0,
    conventions: [],
  },
  preconditions: [],
  backlog_candidates: [],
  rules: [],
  manual_verification: [],
  units: [
    {
      id: 'U-001',
      goal: '変更を実装する',
      files: ['README.md'],
      contract: '既存契約を維持する',
      tests: [{ id: 'T-001', name: '正常系' }],
      seam: false,
    },
  ],
};
function think(repo: string, overrides: Partial<ThinkReport> = {}): string {
  const invariant = repositoryInvariant(repo);
  const report: ThinkReport = {
    protocol: THINK_REPORT_PROTOCOL,
    generated_at: new Date().toISOString(),
    request: 'issue test',
    task_type: 'feature',
    language: 'japanese',
    repository: { head: invariant.head, dirty: false },
    readiness: 'ready',
    outcome: '完了',
    root_cause: null,
    decision: '変更する',
    rationale: '理由',
    alternatives: [],
    evidence: [],
    plan,
    research_questions: [],
    review_notes: [],
    research_reports: [],
    next_step: 'issue',
    timings: emptyStageTimings(),
    ...overrides,
  };
  return persistThinkReport(repo, report).json;
}

function input(repo: string, report: string, extra: Partial<IssueInput> = {}): IssueInput {
  return {
    protocol: ISSUE_INPUT_PROTOCOL,
    repo,
    repository: 'owner/repo',
    remote: 'origin',
    mode: 'create',
    think_report: report,
    title: '堅実な変更',
    target_issue: null,
    priority: 'medium',
    ...extra,
  };
}

class Gateway implements IssueGateway {
  issue: GitHubIssue = {
    number: 7,
    title: '',
    body: '',
    url: 'https://github.com/owner/repo/issues/7',
    labels: [],
  };
  writes = 0;
  checkAccess() {}
  view() {
    return this.issue;
  }
  findByPublicationId(_r: string, publicationId: string) {
    return this.issue.body.includes(`publication_id:${publicationId}`) ? this.issue : null;
  }
  ensureLabel(_r: string, label: string) {
    this.issue.labels = [label];
  }
  create(_r: string, title: string, bodyFile: string, label: string) {
    this.writes++;
    this.issue = { ...this.issue, title, body: fs.readFileSync(bodyFile, 'utf8'), labels: [label] };
    return this.issue;
  }
  edit(_r: string, n: number, bodyFile: string, label: string) {
    if (n !== this.issue.number) throw new Error('drift');
    return this.create(_r, this.issue.title, bodyFile, label);
  }
}

test('issue description uses the language configured by Codex', () => {
  assert.equal(
    describeIssue('japanese').input_template.title,
    '作業内容を具体的に表す短いタイトル',
  );
  assert.equal(
    describeIssue('english').input_template.title,
    'Concise title without a task-type prefix',
  );
  assert.deepEqual(describeIssue('japanese').attach_plan_template, {
    protocol: ISSUE_INPUT_PROTOCOL,
    repo: '/absolute/git-root',
    repository: 'owner/name',
    remote: 'origin',
    mode: 'attach-plan',
    think_report: '/absolute/private-think-report.json',
    title: null,
    target_issue: 123,
    priority: 'medium',
  });
  assert.equal(describeIssue('japanese').cli.stop, 'codex-issue stop --input <hook-supplied-json>');
});

test('missing ready Think artifact stops the pending Issue without input or GitHub write', () => {
  const repo = repoFixture();
  const runId = 'issue-missing-think';
  const pending = armIntent({ runId, workflow: 'issue', cwd: repo });

  const stopped = issueMain(['stop', '--input', pending.input_path, '--run-id', runId]);

  assert.deepEqual(stopped, {
    protocol: ISSUE_RESULT_PROTOCOL,
    status: 'blocked',
    classification: 'missing_decision',
    error: 'ready Think artifact is required before Issue publication',
    next_step: 'think',
  });
  assert.equal(fs.existsSync(pending.input_path), false);
  assert.equal(loadIntent(runId), null);
  assert.equal(fs.existsSync(issueApprovalPath(runId)), false);
});

test('one explicit issue invocation publishes the exact draft and returns build context', () => {
  const repo = repoFixture();
  const report = think(repo);
  const gateway = new Gateway();
  const inputFile = workflowInputPath('issue-test');
  fs.mkdirSync(path.dirname(inputFile), { recursive: true });
  fs.writeFileSync(inputFile, JSON.stringify(input(repo, report)));
  armIntent({ runId: 'issue-test', workflow: 'issue', cwd: repo });
  const events: ProgressEvent[] = [];
  const publishedResult = draftIssueWorkflow(
    'issue-test',
    inputFile,
    gateway,
    new ProgressReporter({
      write: (line) => events.push(JSON.parse(line) as ProgressEvent),
      setInterval: () => ({}),
      clearInterval: () => undefined,
    }),
  );
  assert.equal(gateway.writes, 1);
  assert.equal(gateway.issue.title, '[機能] 堅実な変更');
  assert.doesNotMatch(gateway.issue.body, /issue test/);
  assert.match(gateway.issue.body, /## 目的\n\n完了/);
  assert.match(gateway.issue.body, /- 契約:\n  - 既存契約を維持する/);
  assert.match(gateway.issue.body, /<!-- codex-public-build-contract\n/u);
  assert.doesNotMatch(gateway.issue.body, /<!-- codex-public-build-contract\/v1\n/u);
  assert.doesNotMatch(gateway.issue.body, /<!-- codex-public-build-contract\/v2\n/u);
  const wireMarker = '\n\n<!-- codex-public-build-contract\n';
  const wireStart = gateway.issue.body.indexOf(wireMarker);
  assert.notEqual(wireStart, -1);
  const sealedVisibleBody = gateway.issue.body.slice(0, wireStart);
  const encodedWire = gateway.issue.body
    .slice(wireStart + wireMarker.length)
    .trimEnd()
    .slice(0, -'\n-->'.length);
  const wire = JSON.parse(Buffer.from(encodedWire, 'base64url').toString('utf8')) as Record<
    string,
    unknown
  >;
  assert.deepEqual(Object.keys(wire).sort(), ['body_sha256', 'plan', 'protocol']);
  assert.equal(wire.protocol, 'codex-public-build-contract');
  assert.equal(wire.body_sha256, sha256(sealedVisibleBody));
  assert.ok(sealedVisibleBody.endsWith(renderPlanMarkdown(plan, 'japanese').trimEnd()));
  const publicationId = parsePublicIssueBody(gateway.issue.body).publication_id;
  assert.ok(publicationId);
  assert.match(
    gateway.issue.body,
    new RegExp(`<!-- codex-issue-publication\\npublication_id:${publicationId}\\n-->`, 'u'),
  );
  assert.equal(fs.existsSync(issueApprovalPath('issue-test')), false);
  assert.equal(fs.existsSync(intentPath('issue-test')), false);
  assert.equal(publishedResult.status, 'published');
  assert.deepEqual(publishedResult.build_source, {
    protocol: BUILD_SOURCE_PROTOCOL,
    repository: 'owner/repo',
    issue_number: gateway.issue.number,
  });
  assert.equal('receipt' in publishedResult.build_source, false);
  assert.equal(
    compileContext(repo, 'think').entries.some((e) => e.kind === 'decision'),
    true,
  );
  assert.equal(
    JSON.parse(fs.readFileSync(publishedResult.receipt_json, 'utf8')).body,
    gateway.issue.body,
  );
  const resolved = resolveBuildSource(
    {
      protocol: BUILD_SOURCE_PROTOCOL,
      repository: 'owner/repo',
      issue_number: gateway.issue.number,
    },
    repo,
    gateway,
  );
  assert.equal(resolved.issue, gateway.issue.number);
  assert.equal(resolved.title, gateway.issue.title);
  assert.equal(resolved.body, gateway.issue.body);
  assert.equal(resolved.plan.outcome, plan.outcome);
  assert.equal(resolved.plan.test_command, plan.test_command);
  assert.deepEqual(
    events.map(({ stage, status }) => [stage, status]),
    [
      ['issue_draft', 'started'],
      ['issue_draft', 'completed'],
      ['issue_publish', 'started'],
      ['issue_publish', 'completed'],
    ],
  );
});

test('Build rejects an obsolete v1 public contract and requires Issue recreation', () => {
  const repo = repoFixture();
  const visibleBody = renderPlanMarkdown(plan, 'japanese').trimEnd();
  const contract = Buffer.from(
    JSON.stringify({
      protocol: 'codex-public-build-contract/v1',
      body_sha256: sha256(visibleBody),
      plan,
    }),
  ).toString('base64url');
  const gateway = new Gateway();
  gateway.issue = {
    number: 7,
    title: '[機能] 既存の Issue',
    body: `${visibleBody}\n\n<!-- codex-public-build-contract/v1\n${contract}\n-->\n`,
    url: 'https://github.com/owner/repo/issues/7',
    labels: ['priority:medium'],
  };

  assert.throws(
    () =>
      resolveBuildSource(
        { protocol: BUILD_SOURCE_PROTOCOL, repository: 'owner/repo', issue_number: 7 },
        repo,
        gateway,
      ),
    /obsolete public build contract; recreate it with the current \$issue workflow/u,
  );
});

test('Build rejects an obsolete v2 public contract and requires Issue recreation', () => {
  const repo = repoFixture();
  const publicationId = '00000000-0000-4000-8000-000000000007';
  const visibleBody = renderPlanMarkdown(plan, 'japanese').trimEnd();
  const contract = Buffer.from(
    JSON.stringify({
      protocol: 'codex-public-build-contract/v2',
      body_sha256: sha256(visibleBody),
      plan,
    }),
  ).toString('base64url');
  const gateway = new Gateway();
  gateway.issue = {
    number: 7,
    title: '[機能] 移行中の Issue',
    body: `${visibleBody}\n\n<!-- codex-public-build-contract/v2\npublication_id:${publicationId}\n${contract}\n-->\n`,
    url: 'https://github.com/owner/repo/issues/7',
    labels: ['priority:medium'],
  };

  assert.throws(
    () =>
      resolveBuildSource(
        { protocol: BUILD_SOURCE_PROTOCOL, repository: 'owner/repo', issue_number: 7 },
        repo,
        gateway,
      ),
    /obsolete public build contract; recreate it with the current \$issue workflow/u,
  );
});

test('new issue title and report must match the language configured by Codex', () => {
  const repo = repoFixture();
  const gateway = new Gateway();
  assert.throws(
    () => draftIssue(input(repo, think(repo), { title: 'English title' }), gateway, 'japanese'),
    /title must be written in japanese/,
  );
  assert.throws(
    () => draftIssue(input(repo, think(repo), { title: '日本語 title' }), gateway, 'english'),
    /think report.language must match.*english/,
  );
  assert.equal(gateway.writes, 0);
});

test('publication requires the approval created by the explicit issue invocation', () => {
  const repo = repoFixture();
  const report = think(repo);
  const gateway = new Gateway();
  const runId = 'issue-missing-approval';
  const pending = armIntent({ runId, workflow: 'issue', cwd: repo });
  fs.writeFileSync(pending.input_path, JSON.stringify(input(repo, report)));
  fs.unlinkSync(issueApprovalPath(runId));

  assert.throws(
    () => draftIssueWorkflow(runId, pending.input_path, gateway),
    /explicit \$issue publication approval is required/,
  );
  assert.equal(gateway.writes, 0);
  assert.equal(fs.existsSync(intentPath(runId)), true);
});

test('GitHub access failure preserves the Issue intent and publication approval', () => {
  const repo = repoFixture();
  const report = think(repo);
  const gateway = new Gateway();
  gateway.checkAccess = () => {
    throw new Error('error connecting to api.github.com');
  };
  const runId = 'issue-github-access-failure';
  const pending = armIntent({ runId, workflow: 'issue', cwd: repo });
  fs.writeFileSync(pending.input_path, JSON.stringify(input(repo, report)));

  assert.throws(
    () => draftIssueWorkflow(runId, pending.input_path, gateway),
    /error connecting to api.github.com/,
  );
  assert.equal(gateway.writes, 0);
  assert.equal(fs.existsSync(intentPath(runId)), true);
  assert.equal(fs.existsSync(issueApprovalPath(runId)), true);
});

test('publication approval is bound to the repository and consumed before GitHub writes', () => {
  const repo = repoFixture();
  const report = think(repo);
  const gateway = new Gateway();
  const runId = 'issue-wrong-approval-repo';
  const pending = armIntent({ runId, workflow: 'issue', cwd: repo });
  const approval = JSON.parse(fs.readFileSync(issueApprovalPath(runId), 'utf8')) as Record<
    string,
    unknown
  >;
  fs.writeFileSync(
    issueApprovalPath(runId),
    JSON.stringify({ ...approval, repo: path.dirname(repo) }),
  );
  fs.writeFileSync(pending.input_path, JSON.stringify(input(repo, report)));

  assert.throws(
    () => draftIssueWorkflow(runId, pending.input_path, gateway),
    /issue publication approval has an invalid shape/,
  );
  assert.equal(gateway.writes, 0);
});

test('GitHub write failures cannot reuse a consumed publication approval', () => {
  const repo = repoFixture();
  const report = think(repo);
  const runId = 'issue-failed-publication';
  const pending = armIntent({ runId, workflow: 'issue', cwd: repo });
  fs.writeFileSync(pending.input_path, JSON.stringify(input(repo, report)));
  const gateway = new Gateway();
  gateway.create = () => {
    gateway.writes++;
    throw new Error('GitHub unavailable');
  };

  assert.throws(() => draftIssueWorkflow(runId, pending.input_path, gateway), /GitHub unavailable/);
  assert.equal(gateway.writes, 1);
  assert.equal(fs.existsSync(issueApprovalPath(runId)), false);
  assert.equal(fs.existsSync(intentPath(runId)), false);
});

test('recovers an exact issue when creation succeeds before the local receipt is written', () => {
  const repo = repoFixture();
  const gateway = new Gateway();
  const preview = draftIssue(input(repo, think(repo)), gateway);
  const create = gateway.create.bind(gateway);
  gateway.create = (repository, title, bodyFile, label) => {
    create(repository, title, bodyFile, label);
    throw new Error('connection dropped after create');
  };

  const published = publishIssue(preview.draft_json, preview.draft_sha256, gateway);

  assert.equal(gateway.writes, 1);
  assert.equal(published.issue.number, gateway.issue.number);
  assert.equal(fs.existsSync(published.receipt_json), true);
  assert.match(
    gateway.issue.body,
    new RegExp(`publication_id:${preview.draft.publication_id}`, 'u'),
  );
});

test('rejects stale/changed evidence and preserves ignored-only changes', () => {
  const repo = repoFixture();
  fs.writeFileSync(path.join(repo, '.ignored'), 'x');
  fs.writeFileSync(path.join(repo, '.gitignore'), '.ignored\n');
  execFileSync('git', ['add', '.gitignore'], { cwd: repo });
  execFileSync(
    'git',
    ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'ignore'],
    { cwd: repo },
  );
  const report = think(repo);
  const gateway = new Gateway();
  assert.doesNotThrow(() => draftIssue(input(repo, report), gateway));
  fs.writeFileSync(path.join(repo, 'README.md'), 'changed\n');
  assert.throws(() => draftIssue(input(repo, report), gateway), /repository state|stale/u);
});

test('rejects stale Think evidence before any GitHub write', () => {
  const repo = repoFixture();
  const report = think(repo, {
    evidence: [
      {
        id: 'E-001',
        kind: 'repository',
        source: 'README.md',
        locator: 'L1',
        supports: 'fixture',
        source_sha256: '0'.repeat(64),
      },
    ],
  });
  assert.throws(() => draftIssue(input(repo, report), new Gateway()), /stale/u);
});

test('rejects changed draft body and digest before writing', () => {
  const repo = repoFixture();
  const gateway = new Gateway();
  const preview = draftIssue(input(repo, think(repo)), gateway);
  fs.appendFileSync(preview.body_markdown, '\nchanged\n');
  assert.throws(
    () => publishIssue(preview.draft_json, sha256(Buffer.from('wrong')), gateway),
    /body was changed|digest/u,
  );
  const clean = draftIssue(input(repo, think(repo, { request: 'another issue' })), gateway);
  assert.throws(
    () => publishIssue(clean.draft_json, sha256(Buffer.from('wrong')), gateway),
    /digest/u,
  );
  assert.equal(gateway.writes, 0);
});

test('attach-plan preserves the existing title, appends one Plan, and rejects target drift', () => {
  const repo = repoFixture();
  const gateway = new Gateway();
  gateway.issue = {
    number: 7,
    title: 'Existing title',
    body: '## Context\n\nKeep this.\n',
    url: 'https://github.com/owner/repo/issues/7',
    labels: [],
  };
  const preview = draftIssue(
    input(repo, think(repo), { mode: 'attach-plan', title: null, target_issue: 7 }),
    gateway,
  );
  assert.equal(preview.draft.title, 'Existing title');
  const attachedBody = fs.readFileSync(preview.body_markdown, 'utf8');
  assert.equal((attachedBody.match(/^## Plan\b/gmu) ?? []).length, 1);
  gateway.issue = { ...gateway.issue, body: '## Context\n\nDrifted.\n' };
  assert.throws(
    () => publishIssue(preview.draft_json, preview.draft_sha256, gateway),
    /target issue changed/u,
  );
  assert.equal(gateway.writes, 0);
});
