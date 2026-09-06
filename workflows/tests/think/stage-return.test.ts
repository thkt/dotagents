/** @file Outcome: A checked Think gap returns through bounded Research with durable parent adoption. */
import assert from 'node:assert/strict';
import { test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { runStageReturn } from '../../runtime/stage-return.ts';
import { armIntent } from '../../runtime/invocation.ts';
import { runThinkWorkflow } from '../../think/runner.ts';
import { runResearchWorkflow } from '../../research/runner.ts';
import { loadResearchState, researchPublicationPaths } from '../../research/state.ts';
import { loadThinkState, saveThinkState } from '../../think/state.ts';
import { workflowRunDirectory, workflowInputPath } from '../../runtime/storage.ts';
import { temporaryDirectory, useTemporaryWorkflowStorage } from '../shared/fixtures.ts';
import type { ThinkAgent } from '../../think/agent.ts';
import type { ThinkDraft } from '../../think/contracts.ts';
import type { ResearchAgent } from '../../research/agent.ts';
useTemporaryWorkflowStorage('think-stage-return-');
const gap: ThinkDraft = {
  status: 'research_required',
  plan: null,
  research_questions: ['Which value is exported by value.ts?'],
};
const ready: ThinkDraft = {
  status: 'ready',
  research_questions: [],
  plan: {
    outcome: 'Export value 2.',
    test_command: 'bun test',
    units: [
      {
        goal: 'Export value 2.',
        files: ['value.ts'],
        contract: 'The value is 2.',
        tests: ['The exported value is 2.'],
      },
    ],
  },
};
const researchDraft = {
  answer: 'The value is 1.',
  findings: [
    {
      statement: 'The value is 1.',
      kind: 'fact' as const,
      confidence: 'high' as const,
      qualification: null,
      evidence: [
        {
          kind: 'repository' as const,
          source: 'value.ts',
          locator: 'L1',
          supports: 'The source exports 1.',
        },
      ],
      implication: 'Update it to 2.',
    },
  ],
  rejected: [],
  unknowns: [],
  limitations: [],
};
const research: ResearchAgent = {
  async investigate(_i, _k, snapshot) {
    assert.match(fs.readFileSync(path.join(snapshot, 'value.ts'), 'utf8'), /value = 1/);
    return researchDraft;
  },
  async audit() {
    return { summary: 'Supported.', findings: [] };
  },
};
const thinker: ThinkAgent = {
  async design(_input, reports) {
    return reports.length ? ready : gap;
  },
  async review() {
    return { summary: 'The candidate is supported.', findings: [] };
  },
};
function fixture() {
  const repo = temporaryDirectory('stage-return-repo-');
  execFileSync('git', ['init', '-q', repo]);
  fs.writeFileSync(path.join(repo, 'value.ts'), 'export const value = 1;\n');
  const runId = crypto.randomUUID();
  const intent = armIntent({ runId, workflow: 'think', cwd: repo });
  fs.writeFileSync(
    intent.input_path,
    JSON.stringify({ repo, request: 'Export value 2.', research_reports: [] }),
  );
  return { repo, runId, input: intent.input_path };
}
function returns(runId: string) {
  const state = loadThinkState(runId)!;
  const file = path.join(workflowRunDirectory(runId), `returns-${state.invocation}.json`);
  return JSON.parse(fs.readFileSync(file, 'utf8')).state.entries;
}

test('a reviewed Think gap executes Research and rechecks the designer without parent intervention', async () => {
  const { repo, runId, input } = fixture();
  let reviews = 0;
  const result = await runThinkWorkflow(
    runId,
    input,
    {
      ...thinker,
      async review(_i, candidate) {
        reviews++;
        if (candidate.status === 'research_required')
          fs.writeFileSync(path.join(repo, 'value.ts'), 'live edit');
        return { summary: 'Pass.', findings: [] };
      },
    },
    { research },
  );
  assert.equal(result.status, 'ready');
  assert.equal(reviews, 2);
  assert.equal(returns(runId).length, 1);
  assert.equal(loadThinkState(runId)!.research.length, 1);
  const entry = returns(runId)[0];
  await assert.rejects(
    runResearchWorkflow(entry.id, workflowInputPath(entry.id, 'research'), research),
    /authorized parent/,
  );
  assert.throws(
    () => armIntent({ runId: entry.id, workflow: 'issue', cwd: repo }),
    /parent runner/,
  );
  assert.deepEqual(await runThinkWorkflow(runId, input, thinker, { research }), result);
});

test('unresolved gaps exhaust the shared budget without resetting it on resume', async () => {
  const { runId, input } = fixture();
  const never: ThinkAgent = {
    ...thinker,
    async design() {
      return gap;
    },
  };
  await assert.rejects(runThinkWorkflow(runId, input, never, { research }), /limit of two/);
  assert.equal(returns(runId).length, 2);
  assert.match(loadThinkState(runId)!.reason!, /limit of two/);
  await assert.rejects(runThinkWorkflow(runId, input, never, { research }), /limit of two/);
  assert.equal(returns(runId).length, 2);
});

test('a changed parent cannot adopt a completed child result', async () => {
  const { runId, input } = fixture();
  await assert.rejects(
    runThinkWorkflow(runId, input, thinker, {
      research: {
        ...research,
        async audit() {
          const s = loadThinkState(runId)!;
          s.input.request = 'changed';
          saveThinkState(runId, s);
          return { summary: 'Pass.', findings: [] };
        },
      },
    }),
    /stale Think parent/,
  );
  assert.equal(loadThinkState(runId)!.phase, 'research');
});

async function interrupt(runId: string, input: string, boundary: string) {
  const script = path.join(temporaryDirectory('stage-child-process-'), 'run.ts');
  fs.writeFileSync(
    script,
    `
 import fs from 'node:fs'; import {mock} from 'bun:test';
 const rename=fs.renameSync;
 fs.renameSync=(...args)=>{rename(...args);const file=String(args[1]);
 if(file.includes('returns-')&&file.endsWith('.json')){const entries=JSON.parse(fs.readFileSync(file,'utf8')).state.entries;if(${JSON.stringify(boundary)}==='reserved'&&entries.length===1)process.exit(73);}
 if(${JSON.stringify(boundary)}==='child-stage-completed'&&file.endsWith('research-state.json')){const s=JSON.parse(fs.readFileSync(file,'utf8')).state;if(s.phase==='completed')process.exit(73);}
 if(file.endsWith('think-state.json')){const s=JSON.parse(fs.readFileSync(file,'utf8')).state;if(${JSON.stringify(boundary)}==='adopted'&&s.phase==='design'&&s.research.length===1)process.exit(73);}
 };
 mock.module('node:fs',()=>({...fs,default:fs}));
 const {runThinkWorkflow}=await import(${JSON.stringify(new URL('../../think/runner.ts', import.meta.url).pathname)});
 await runThinkWorkflow(${JSON.stringify(runId)},${JSON.stringify(input)},{async design(_i,r){return r.length?${JSON.stringify(ready)}:${JSON.stringify(gap)};},async review(){return {summary:'Pass.',findings:[]};}},{research:{async investigate(){return ${JSON.stringify(researchDraft)};},async audit(){return {summary:'Pass.',findings:[]};}}});
 `,
  );
  const child = Bun.spawn([process.execPath, script], {
    env: { ...process.env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const err = new Response(child.stderr).text();
  assert.equal(await child.exited, 73, await err);
}

test('parent process exits reuse the reserved child before dispatch, before adoption and after adoption', async () => {
  for (const boundary of ['reserved', 'child-stage-completed', 'adopted']) {
    const { runId, input } = fixture();
    await interrupt(runId, input, boundary);
    const id = returns(runId)[0].id;
    let calls = 0;
    const result = await runThinkWorkflow(runId, input, thinker, {
      research: {
        ...research,
        async investigate(...args) {
          calls++;
          return research.investigate(...args);
        },
      },
    });
    assert.equal(result.status, 'ready');
    assert.equal(calls, boundary === 'reserved' ? 1 : 0);
    assert.equal(returns(runId).length, 1);
    assert.equal(returns(runId)[0].id, id);
    assert.equal(loadThinkState(runId)!.research.length, 1);
  }
}, 15000);

test('an unarmed parent cannot manufacture read-only child authority', async () => {
  const { runId } = fixture();
  await assert.rejects(runStageReturn(runId, 'think', { research }), /verified parent/);
  assert.equal(loadThinkState(runId), null);
});

test('pending child input and corrupt return records reject before model execution', async () => {
  for (const changed of ['input', 'record']) {
    const { runId, input } = fixture();
    await interrupt(runId, input, 'reserved');
    const entry = returns(runId)[0];
    const record = path.join(
      workflowRunDirectory(runId),
      `returns-${loadThinkState(runId)!.invocation}.json`,
    );
    if (changed === 'input') {
      const childInput = workflowInputPath(entry.id, 'research');
      fs.mkdirSync(path.dirname(childInput), { recursive: true });
      fs.writeFileSync(childInput, JSON.stringify({ request: 'mixed Think input' }));
    } else fs.writeFileSync(record, '{invalid');
    let calls = 0;
    await assert.rejects(
      runThinkWorkflow(runId, input, thinker, {
        research: {
          ...research,
          async investigate() {
            calls++;
            return researchDraft;
          },
        },
      }),
      changed === 'input' ? /child input changed/ : /retain it/,
    );
    assert.equal(calls, 0);
    if (changed === 'record') assert.equal(fs.readFileSync(record, 'utf8'), '{invalid');
  }
});

test('completed children revalidate input and repair publications before parent adoption', async () => {
  for (const changed of ['input', 'missing', 'conflict']) {
    const { runId, input } = fixture();
    await interrupt(runId, input, 'child-stage-completed');
    const id = returns(runId)[0].id;
    const paths = researchPublicationPaths(loadResearchState(id)!);
    const original = fs.readFileSync(paths.json, 'utf8');
    if (changed === 'input') {
      fs.writeFileSync(
        workflowInputPath(id, 'research'),
        JSON.stringify({ request: 'wrong input' }),
      );
    } else if (changed === 'missing') {
      fs.unlinkSync(paths.json);
      fs.unlinkSync(paths.markdown);
    } else {
      fs.writeFileSync(paths.json, '{}');
    }
    const noDispatch: ResearchAgent = {
      async investigate() {
        throw new Error('completed Research must not redispatch');
      },
      async audit() {
        throw new Error('completed Research must not repeat audit');
      },
    };
    const resumed = runThinkWorkflow(runId, input, thinker, { research: noDispatch });
    if (changed === 'missing') {
      assert.equal((await resumed).status, 'ready');
      assert.equal(fs.readFileSync(paths.json, 'utf8'), original);
      assert.ok(fs.readFileSync(paths.markdown, 'utf8').length > 0);
      assert.equal(loadThinkState(runId)!.research.length, 1);
    } else {
      await assert.rejects(
        resumed,
        changed === 'input' ? /child input changed/ : /publication conflicts/,
      );
      assert.equal(loadThinkState(runId)!.phase, 'research');
      assert.equal(loadThinkState(runId)!.research.length, 0);
      if (changed === 'conflict') assert.equal(fs.readFileSync(paths.json, 'utf8'), '{}');
    }
    assert.equal(returns(runId).length, 1);
    assert.equal(returns(runId)[0].id, id);
  }
}, 15000);
