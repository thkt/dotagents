/** @file Outcome: Issue lifecycle tests exercise the public runner against durable fixture-only GitHub state. */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { temporaryDirectory } from '../shared/fixtures.ts';
import { armIntent } from '../../runtime/invocation.ts';
import { atomicWrite, thinkArtifactDirectory } from '../../runtime/storage.ts';
import type { IssueAgent, IssueCandidate } from '../../issue/agent.ts';
import type { IssueGateway, GitHubIssue } from '../../issue/github.ts';
import type { ThinkReport } from '../../think/contracts.ts';
export const report: ThinkReport = {
  protocol: 'codex-think-report',
  generated_at: '2026-09-07T00:00:00.000Z',
  request: 'Export value 2.',
  status: 'ready',
  research_questions: [],
  research_reports: [],
  plan: {
    outcome: 'Export value 2.',
    test_command: 'git diff --check',
    units: [
      {
        goal: 'Export value 2.',
        files: ['value.ts'],
        contract: 'The exported value is 2.',
        tests: ['The exported value equals 2.'],
      },
    ],
  },
};
export const candidate: IssueCandidate = {
  title: '値を更新する',
  prose: '値を 2 に更新する。',
  plan_markdown: null,
};
export const passing: IssueAgent = {
  async correct() {
    throw new Error('unexpected correction');
  },
  async review() {
    return { summary: 'Faithful.', findings: [] };
  },
};
export class Gateway implements IssueGateway {
  readonly file: string;
  constructor(file: string) {
    this.file = file;
  }
  checkAccess(): void {}
  view(): GitHubIssue {
    return JSON.parse(fs.readFileSync(this.file, 'utf8'));
  }
  create(
    _repository: string,
    title: string,
    bodyFile: string,
    onCreated?: (issue: number) => void,
  ): GitHubIssue {
    fs.appendFileSync(this.file + '.writes', 'create\n');
    const issue = {
      number: 7,
      title,
      body: fs.readFileSync(bodyFile, 'utf8'),
      url: 'https://github.com/owner/repo/issues/7',
    };
    fs.writeFileSync(this.file, JSON.stringify(issue));
    onCreated?.(7);
    return issue;
  }
  edit(_repository: string, _number: number, title: string, bodyFile: string): GitHubIssue {
    fs.appendFileSync(this.file + '.writes', 'edit\n');
    const issue = { ...this.view(), title, body: fs.readFileSync(bodyFile, 'utf8') };
    fs.writeFileSync(this.file, JSON.stringify(issue));
    return issue;
  }
}
export function fixture(mode: 'create' | 'update' = 'create') {
  const repo = temporaryDirectory('issue-lifecycle-repo-');
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', 'git@github.com:owner/repo.git']);
  fs.writeFileSync(path.join(repo, 'value.ts'), 'export const value = 1;\n');
  const runId = crypto.randomUUID();
  const input = armIntent({ runId, workflow: 'issue', cwd: repo }).input_path;
  const think = path.join(thinkArtifactDirectory(repo), 'ready.json');
  atomicWrite(think, report);
  atomicWrite(input, {
    repo,
    mode,
    ...(mode === 'update' ? { target_issue: 7 } : {}),
    think_report: think,
    title: candidate.title,
    prose: candidate.prose,
  });
  const remote = path.join(temporaryDirectory('issue-remote-'), 'issue.json');
  const gateway = new Gateway(remote);
  if (mode === 'update')
    fs.writeFileSync(
      remote,
      JSON.stringify({
        number: 7,
        title: 'Old',
        body: 'Old',
        url: 'https://github.com/owner/repo/issues/7',
      }),
    );
  return { repo, runId, input, think, gateway, remote };
}
