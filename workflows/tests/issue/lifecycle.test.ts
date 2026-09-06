/** @file Outcome: Production Issue runs correct, independently review and publish with durable recovery. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'bun:test';
import { fixture, Gateway, candidate, passing, report } from './fixtures.ts';
import { useTemporaryWorkflowStorage, temporaryDirectory } from '../shared/fixtures.ts';
import { draftIssueWorkflow } from '../../issue/runner.ts';
import { parsePublicIssueBody } from '../../issue/public-contract.ts';
import {
  loadIssueState,
  saveIssueState,
  issueStatePath,
  issueWorkspace,
} from '../../issue/state.ts';
import { armIntent, clearIntent } from '../../runtime/invocation.ts';
import { acquireWorkflowOwnership } from '../../runtime/ownership.ts';
import type { IssueAgent, IssueReview } from '../../issue/agent.ts';
useTemporaryWorkflowStorage('issue-lifecycle-');
const finding: IssueReview = {
  summary: 'Prose changes the Plan.',
  findings: [
    {
      severity: 'blocking',
      condition: 'Preserve the value 2 requirement.',
      evidence: ['Plan: value 2. Candidate: value 3.'],
      destination: 'author',
    },
  ],
};
function run(f: ReturnType<typeof fixture>, agent: IssueAgent = passing) {
  return draftIssueWorkflow(f.runId, f.input, f.gateway, undefined, agent);
}

test('faithful drafts and advisory findings publish without author work and completed resume does not write', async () => {
  const f = fixture();
  let reviews = 0;
  const agent = {
    ...passing,
    async review() {
      reviews++;
      return {
        ...finding,
        findings: finding.findings.map((v) => ({ ...v, severity: 'advisory' as const })),
      };
    },
  };
  const result = await run(f, agent);
  assert.equal(result.status, 'published');
  assert.equal(reviews, 1);
  assert.deepEqual(parsePublicIssueBody(f.gateway.view().body).plan, report.plan);
  assert.deepEqual(await run(f, agent), result);
  assert.equal(reviews, 1);
  assert.equal(fs.readFileSync(f.remote + '.writes', 'utf8'), 'create\n');
});

test('added, omitted, contradictory and mistranslated requirements return to an independent review', async () => {
  for (const prose of [
    'Also delete all values.',
    'Only rename the file.',
    'Export 3 instead of 2.',
    '値を 3 に更新する。',
  ]) {
    const f = fixture();
    const raw = JSON.parse(fs.readFileSync(f.input, 'utf8'));
    fs.writeFileSync(f.input, JSON.stringify({ ...raw, prose }));
    const events: string[] = [];
    await run(f, {
      async correct(r, c, reason) {
        events.push('author');
        assert.deepEqual(r, report);
        assert.equal(c.prose, prose);
        assert.match(reason, /Preserve/);
        return candidate;
      },
      async review(r, c, body) {
        events.push('review');
        assert.deepEqual(r, report);
        assert.deepEqual(parsePublicIssueBody(body).plan, report.plan);
        return c.prose === prose ? finding : { summary: 'Faithful.', findings: [] };
      },
    });
    assert.deepEqual(events, ['review', 'author', 'review']);
    assert.equal(loadIssueState(f.runId)!.corrections, 1);
  }
});

test('canonical Plan changes stop for Think and never reach an Issue author or publication', async () => {
  const f = fixture();
  await assert.rejects(
    run(f, {
      ...passing,
      async review() {
        return {
          ...finding,
          findings: finding.findings.map((v) => ({ ...v, destination: 'think' as const })),
        };
      },
    }),
    /Next step: think/,
  );
  assert.equal(fs.existsSync(f.remote + '.writes'), false);
  assert.deepEqual(loadIssueState(f.runId)!.report, report);
});

test('indeterminate responses consume attempt budget without semantic correction or reset', async () => {
  for (const failure of ['throw', 'malformed']) {
    const f = fixture();
    let calls = 0;
    const agent = {
      ...passing,
      async review() {
        calls++;
        if (failure === 'throw') throw new Error('model unavailable');
        return {} as IssueReview;
      },
    };
    await assert.rejects(run(f, agent), /Issue blocked/);
    await assert.rejects(run(f, agent), /Issue blocked/);
    assert.equal(calls, 2);
    assert.equal(loadIssueState(f.runId)!.corrections, 0);
    assert.equal(fs.existsSync(f.remote + '.writes'), false);
  }
});

test('correction and retry budgets preserve the author assignment and never reset on resume', async () => {
  const f = fixture();
  let authors = 0;
  await assert.rejects(
    run(f, {
      async review() {
        return finding;
      },
      async correct(_r, _c, reason) {
        authors++;
        assert.match(reason, /Preserve/);
        if (authors === 1) throw new Error('transient outage');
        return candidate;
      },
    }),
    /Issue blocked/,
  );
  assert.equal(authors, 4);
  assert.equal(loadIssueState(f.runId)!.corrections, 3);
  await assert.rejects(run(f), /Issue blocked/);
});

test('unarmed requests, simultaneous runners and changed governing inputs never publish', async () => {
  const unarmed = fixture();
  clearIntent(unarmed.runId);
  await assert.rejects(run(unarmed), /explicit/);
  const busy = fixture();
  {
    using lock = acquireWorkflowOwnership(busy.runId);
    await assert.rejects(run(busy), /active runtime owner/);
    void lock;
  }
  for (const change of ['input', 'report', 'snapshot', 'state']) {
    const f = fixture();
    await assert.rejects(
      run(f, {
        ...passing,
        async review() {
          if (change === 'input') fs.writeFileSync(f.input, '{}');
          if (change === 'report')
            fs.writeFileSync(f.think, JSON.stringify({ ...report, request: 'Changed' }));
          if (change === 'snapshot')
            fs.writeFileSync(
              path.join(issueWorkspace(loadIssueState(f.runId)!), 'value.ts'),
              'Changed',
            );
          if (change === 'state') {
            const s = loadIssueState(f.runId)!;
            s.candidate.prose = 'Changed';
            saveIssueState(s);
          }
          return { summary: 'Faithful.', findings: [] };
        },
      }),
      /changed|stale/,
    );
    assert.equal(fs.existsSync(f.remote + '.writes'), false);
  }
});

test('uncertain create is never repeated, including attempts to arm another invocation', async () => {
  const f = fixture();
  f.gateway.create = function (repository, title, bodyFile) {
    Gateway.prototype.create.call(this, repository, title, bodyFile);
    throw new Error('response lost');
  };
  await assert.rejects(run(f), /response lost/);
  await assert.rejects(run(f), /outcome is unknown/);
  await assert.rejects(run(f), /outcome is unknown/);
  assert.throws(
    () => armIntent({ runId: f.runId, workflow: 'issue', cwd: f.repo }),
    /publication is unresolved/,
  );
  assert.equal(fs.readFileSync(f.remote + '.writes', 'utf8'), 'create\n');
});

test('known create identity and lost update responses reconcile exact content without another write', async () => {
  for (const mode of ['create', 'update'] as const) {
    const f = fixture(mode);
    if (mode === 'create')
      f.gateway.create = function (repository, title, bodyFile, onCreated) {
        Gateway.prototype.create.call(this, repository, title, bodyFile, onCreated);
        throw new Error('view lost');
      };
    else
      f.gateway.edit = function (repository, number, title, bodyFile) {
        Gateway.prototype.edit.call(this, repository, number, title, bodyFile);
        throw new Error('edit response lost');
      };
    if (mode === 'create') await assert.rejects(run(f), /view lost/);
    const result = await run(f);
    assert.equal(result.status, 'published');
    assert.equal(
      fs.readFileSync(f.remote + '.writes', 'utf8'),
      (mode === 'create' ? 'create' : 'edit') + '\n',
    );
  }
});

test('changed remote update targets are preserved', async () => {
  const f = fixture('update');
  await assert.rejects(
    run(f, {
      ...passing,
      async review() {
        fs.writeFileSync(
          f.remote,
          JSON.stringify({ ...f.gateway.view(), title: 'Someone else edited' }),
        );
        return { summary: 'Pass.', findings: [] };
      },
    }),
    /target issue changed/,
  );
  await assert.rejects(run(f), /does not match/);
  assert.equal(f.gateway.view().title, 'Someone else edited');
  assert.equal(fs.existsSync(f.remote + '.writes'), false);
});

async function interrupt(f: ReturnType<typeof fixture>, boundary: string) {
  const script = path.join(temporaryDirectory('issue-process-'), 'run.ts');
  fs.writeFileSync(
    script,
    `
 import fs from 'node:fs';import {mock} from 'bun:test';
 const rename=fs.renameSync;
 fs.renameSync=(...args)=>{rename(...args);if(String(args[1]).endsWith('issue-state.json')){const s=JSON.parse(fs.readFileSync(args[1],'utf8')).state; if(s.phase===${JSON.stringify(boundary)} || (${JSON.stringify(boundary)}==='created'&&s.created_issue!==null))process.exit(73);}};
 mock.module('node:fs',()=>({...fs,default:fs}));
 const {draftIssueWorkflow}=await import(${JSON.stringify(new URL('../../issue/runner.ts', import.meta.url).pathname)});
 const {Gateway,passing}=await import(${JSON.stringify(new URL('./fixtures.ts', import.meta.url).pathname)});
 await draftIssueWorkflow(${JSON.stringify(f.runId)},${JSON.stringify(f.input)},new Gateway(${JSON.stringify(f.remote)}),undefined,passing);
 `,
  );
  const proc = Bun.spawn([process.execPath, script], {
    env: { ...process.env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const err = new Response(proc.stderr).text();
  assert.equal(await proc.exited, 73, await err);
}

test('process exits around review and publication resume accepted work without duplicate creates', async () => {
  for (const boundary of ['review', 'decide', 'publish', 'publishing', 'created', 'completed']) {
    const f = fixture();
    await interrupt(f, boundary);
    let reviews = 0;
    const agent = {
      ...passing,
      async review() {
        reviews++;
        return { summary: 'Faithful.', findings: [] };
      },
    };
    if (boundary === 'publishing') {
      await assert.rejects(run(f, agent), /outcome is unknown/);
      assert.equal(fs.existsSync(f.remote + '.writes'), false);
    } else {
      assert.equal((await run(f, agent)).status, 'published');
      assert.equal(fs.readFileSync(f.remote + '.writes', 'utf8'), 'create\n');
    }
    assert.equal(reviews, boundary === 'review' ? 1 : 0);
  }
}, 15000);

test('changed preview and incompatible state stop before publication and retain recovery evidence', async () => {
  for (const change of ['preview', 'protocol', 'digest']) {
    const f = fixture();
    await interrupt(f, 'publish');
    const file = issueStatePath(f.runId);
    if (change === 'preview') {
      const s = loadIssueState(f.runId)!;
      const { issueArtifactDirectory } = await import('../../runtime/storage.ts');
      fs.writeFileSync(
        path.join(issueArtifactDirectory(f.repo), `issue-${s.invocation}.md`),
        'Changed',
      );
    } else if (change === 'protocol') {
      const s = loadIssueState(f.runId)!;
      Object.assign(s, { protocol: 'old' });
      saveIssueState(s);
    } else fs.writeFileSync(file, '{invalid');
    const before = fs.readFileSync(file, 'utf8');
    await assert.rejects(run(f), /changed|Retain/);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    assert.equal(fs.existsSync(f.remote + '.writes'), false);
  }
});

test('update preflight cannot replace reviewed preview bytes before edit', async () => {
  const f = fixture('update');
  let views = 0;
  f.gateway.view = function () {
    views++;
    if (views === 2) {
      const s = loadIssueState(f.runId)!;
      const file = path.join(path.dirname(f.think), '..', 'issue', `issue-${s.invocation}.md`);
      fs.writeFileSync(file, 'Unreviewed body');
    }
    return Gateway.prototype.view.call(this);
  };
  await assert.rejects(run(f), /preview changed/);
  assert.equal(fs.existsSync(f.remote + '.writes'), false);
});
