/** @file Outcome: verify ephemeral Knowledge/Decision context compilation. */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { compileContext } from '../../knowledge/context.ts';
import { researchArtifactDirectory, issueArtifactDirectory } from '../../shared/storage.ts';
import { sha256 } from '../../shared/evidence.ts';
import { draftIssue, publishIssue } from '../../issue/pipeline.ts';
import { persistThinkReport } from '../../think/artifact.ts';
import { THINK_REPORT_PROTOCOL, type ThinkReport } from '../../think/contracts.ts';
import { repositoryInvariant } from '../../shared/repository.ts';
import { emptyStageTimings } from '../../shared/codex.ts';
import type { GitHubIssue, IssueGateway } from '../../issue/github.ts';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-context-'));
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-state-'));
  process.env.CODEX_FLOW_STATE_DIR = state;
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  fs.writeFileSync(path.join(root, 'src.ts'), 'export const x = 1;\n');
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync(
    'git',
    ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'fixture'],
    { cwd: root },
  );
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/owner/repo.git'], {
    cwd: root,
  });
  test.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(state, { recursive: true, force: true });
  });
  return { root, state };
}

const reportBase = {
  protocol: 'codex-research-report/v3',
  generated_at: new Date().toISOString(),
  question: 'q',
  mode: 'plan',
  language: 'japanese',
  scope_paths: [],
  external_sources: 'broad',
  repository: { head: null, dirty: false },
  answer: 'a',
  unknowns: [],
  rejected: [],
  limitations: [],
  prior_reports: [],
  next_step: 'think',
  timings: emptyStageTimings(),
};
function researchReport(findings: unknown[]) {
  return { ...reportBase, findings };
}
const repositoryEvidence = (sha = sha256(Buffer.from('export const x = 1;\n'))) => ({
  kind: 'repository',
  source: 'src.ts',
  locator: 'L1',
  supports: 's',
  source_sha256: sha,
});
const webEvidence = { kind: 'web', source: 'https://example.com', locator: 'p1', supports: 's' };
function writeResearch(repo: string, name: string, findings: unknown[]) {
  const dir = researchArtifactDirectory(repo);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), JSON.stringify(researchReport(findings)));
}

test('empty authoritative artifact set loads and performs no writes', () => {
  const { root, state } = fixture();
  const before = fs.readdirSync(state);
  assert.deepEqual(compileContext(root, 'research'), { status: 'loaded', entries: [] });
  assert.deepEqual(fs.readdirSync(state), before);
  assert.equal(fs.existsSync(issueArtifactDirectory(root)), false);
});

test('does not follow a symlinked research artifact directory', () => {
  const { root } = fixture();
  const directory = researchArtifactDirectory(root);
  fs.mkdirSync(path.dirname(directory), { recursive: true });
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-outside-'));
  fs.symlinkSync(outside, directory, 'dir');
  test.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  assert.deepEqual(compileContext(root, 'research'), { status: 'degraded', entries: [] });
});

test('research mode does not scan malformed issue artifacts', () => {
  const { root } = fixture();
  const directory = issueArtifactDirectory(root);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'broken.published.json'), '{not-json');
  assert.deepEqual(compileContext(root, 'research'), { status: 'loaded', entries: [] });
});

test('corrupt research artifact degrades and is omitted', () => {
  const { root } = fixture();
  const dir = researchArtifactDirectory(root);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'broken.json'), '{');
  const result = compileContext(root, 'research');
  assert.equal(result.status, 'degraded');
  assert.deepEqual(result.entries, []);
});

test('research json symlink degrades and is not injected', () => {
  const { root } = fixture();
  const dir = researchArtifactDirectory(root);
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(root, 'target.json');
  fs.writeFileSync(target, JSON.stringify(researchReport([])));
  fs.symlinkSync(target, path.join(dir, 'candidate.json'));
  const result = compileContext(root, 'research');
  assert.equal(result.status, 'degraded');
  assert.deepEqual(result.entries, []);
});

test('invalid publication chain is degraded and no decision is compiled', () => {
  const { root } = fixture();
  const dir = issueArtifactDirectory(root);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'draft.json.published.json'), '{}');
  const result = compileContext(root, 'think');
  assert.equal(result.status, 'degraded');
  assert.equal(
    result.entries.some((entry) => entry.kind === 'decision'),
    false,
  );
});

test('only strict current repository facts are active; leads are review_required', () => {
  const { root } = fixture();
  writeResearch(root, 'facts.json', [
    {
      id: 'F-001',
      statement: 'fact',
      kind: 'fact',
      confidence: 'high',
      qualification: null,
      evidence: [repositoryEvidence()],
      implication: 'i',
    },
    {
      id: 'F-002',
      statement: 'inference',
      kind: 'inference',
      confidence: 'high',
      qualification: null,
      evidence: [repositoryEvidence()],
      implication: 'i',
    },
    {
      id: 'F-003',
      statement: 'qualified',
      kind: 'fact',
      confidence: 'high',
      qualification: '条件付き',
      evidence: [repositoryEvidence()],
      implication: 'i',
    },
    {
      id: 'F-004',
      statement: 'web',
      kind: 'fact',
      confidence: 'high',
      qualification: null,
      evidence: [webEvidence],
      implication: 'i',
    },
  ]);
  assert.deepEqual(
    compileContext(root, 'research').entries.map((e) => [e.source_id, e.status]),
    [
      ['F-001', 'active'],
      ['F-002', 'review_required'],
      ['F-003', 'review_required'],
      ['F-004', 'review_required'],
    ],
  );
  assert.equal(compileContext(root, 'think').entries.length, 1);
});

test('stale repository evidence is omitted while context remains loaded', () => {
  const { root } = fixture();
  writeResearch(root, 'stale.json', [
    {
      id: 'F-001',
      statement: 'stale',
      kind: 'fact',
      confidence: 'high',
      qualification: null,
      evidence: [repositoryEvidence('0'.repeat(64))],
      implication: 'i',
    },
  ]);
  const result = compileContext(root, 'research');
  assert.equal(result.status, 'loaded');
  assert.deepEqual(result.entries, []);
});

test('valid published issue receipt with sibling draft and ready Think artifact yields active decision', () => {
  const { root } = fixture();
  const inv = repositoryInvariant(root);
  const report: ThinkReport = {
    protocol: THINK_REPORT_PROTOCOL,
    generated_at: new Date().toISOString(),
    request: 'q',
    task_type: 'feature',
    language: 'japanese',
    repository: { head: inv.head, dirty: false },
    readiness: 'ready',
    outcome: 'o',
    root_cause: null,
    decision: '決定',
    rationale: 'r',
    alternatives: [],
    evidence: [],
    research_questions: [],
    review_notes: [],
    research_reports: [],
    next_step: 'issue',
    timings: emptyStageTimings(),
    plan: {
      outcome: 'o',
      root_cause: null,
      test_command: 'npm test',
      reference_module: {
        kind: 'no-module',
        reason: 'r',
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
          goal: 'g',
          files: ['README.md'],
          contract: 'c',
          tests: [{ id: 'T-001', name: 't' }],
          seam: false,
        },
      ],
    },
  };
  const thinkFile = persistThinkReport(root, report).json;
  class Gateway implements IssueGateway {
    issue: GitHubIssue = {
      number: 1,
      title: '',
      body: '',
      url: 'https://github.com/owner/repo/issues/1',
      labels: [],
    };
    view() {
      return this.issue;
    }
    ensureLabel(_r: string, label: string) {
      this.issue.labels = [label];
    }
    create(_r: string, title: string, bodyFile: string, label: string) {
      this.issue = {
        ...this.issue,
        title,
        body: fs.readFileSync(bodyFile, 'utf8'),
        labels: [label],
      };
      return this.issue;
    }
    edit() {
      return this.issue;
    }
  }
  const gateway = new Gateway();
  assert.equal(
    compileContext(root, 'think').entries.some((e) => e.kind === 'decision'),
    false,
  );
  const preview = draftIssue(
    {
      protocol: 'codex-issue-input/v1',
      repo: root,
      repository: 'owner/repo',
      remote: 'origin',
      mode: 'create',
      think_report: thinkFile,
      title: '変更',
      target_issue: null,
      priority: 'medium',
    },
    gateway,
  );
  publishIssue(preview.draft_json, preview.draft_sha256, gateway);
  const result = compileContext(root, 'think');
  assert.equal(result.status, 'loaded');
  assert.equal(result.entries[0]?.status, 'active');
  assert.equal(result.entries[0]?.statement, '決定');
});

test('digest mismatch degrades and emits no decision; ordering is deterministic and capped at 20', () => {
  const { root } = fixture();
  for (let i = 0; i < 25; i++)
    writeResearch(root, `${String(25 - i).padStart(2, '0')}.json`, [
      {
        id: 'F-001',
        statement: String(i),
        kind: 'inference',
        confidence: 'low',
        qualification: null,
        evidence: [webEvidence],
        implication: 'i',
      },
    ]);
  const entries = compileContext(root, 'research').entries;
  assert.equal(entries.length, 20);
  assert.deepEqual(
    entries.map((e) => e.source_artifact),
    Array.from({ length: 20 }, (_, i) => `${String(i + 1).padStart(2, '0')}.json`),
  );
});
