/** @file Outcome: A checked Think gap returns through bounded Research with durable parent adoption. */
import assert from 'node:assert/strict';
import { test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { runStageReturn, saveStageReturnTransition } from '../../runtime/stage-return.ts';
import { armIntent, loadIntent } from '../../runtime/invocation.ts';
import { handle } from '../../../hooks/workflow-enforcer.ts';
import { runThinkWorkflow } from '../../think/runner.ts';
import { runResearchWorkflow } from '../../research/runner.ts';
import { loadResearchState, researchPublicationPaths } from '../../research/state.ts';
import { loadThinkState, saveThinkState, thinkDigest } from '../../think/state.ts';
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

async function rejectMissingJournal(runId: string, input: string): Promise<void> {
  const parent = loadThinkState(runId)!;
  const file = path.join(workflowRunDirectory(runId), `returns-${parent.invocation}.json`);
  const journal = fs.readFileSync(file, 'utf8');
  const entries = JSON.parse(journal).state.entries as {
    id: string;
    route: 'think' | 'research';
  }[];
  const children = entries.map((e) =>
    e.route === 'think' ? loadThinkState(e.id) : loadResearchState(e.id),
  );
  const originalInput = fs.readFileSync(input, 'utf8');
  let calls = 0;
  const forbidden = async (): Promise<never> => {
    calls++;
    throw Error('No dispatch without existing ownership');
  };
  fs.unlinkSync(file);
  try {
    await assert.rejects(
      runThinkWorkflow(
        runId,
        input,
        { design: forbidden, review: forbidden },
        {
          research: { investigate: forbidden, audit: forbidden },
        },
      ),
      /missing cross-stage ownership record.*retain/,
    );
    if (parent.phase === 'research')
      await assert.rejects(
        runStageReturn(runId, 'think', {
          research: { investigate: forbidden, audit: forbidden },
        }),
        /missing cross-stage ownership record/,
      );
    for (const prompt of ['Private', '$think Replace the Plan.']) {
      const hook = handle({
        hook_event_name: 'UserPromptSubmit',
        session_id: runId,
        cwd: parent.input.repo,
        prompt,
      });
      assert.equal(hook.decision, 'block');
      assert.match(hook.reason!, /missing cross-stage ownership record/);
    }
    assert.throws(
      () =>
        saveStageReturnTransition(runId, 'think', thinkDigest(parent), thinkDigest(parent), () => {
          calls++;
          throw Error('No parent persistence without ownership');
        }),
      /missing cross-stage ownership record/,
    );
    assert.equal(calls, 0);
    assert.equal(fs.existsSync(file), false);
    assert.equal(fs.readFileSync(input, 'utf8'), originalInput);
    assert.deepEqual(loadThinkState(runId), parent);
    assert.deepEqual(
      entries.map((e) => (e.route === 'think' ? loadThinkState(e.id) : loadResearchState(e.id))),
      children,
    );
  } finally {
    fs.writeFileSync(file, journal);
  }
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

for (const waiting of [false, true])
  test(`a changed parent cannot adopt a ${waiting ? 'waiting' : 'completed'} child result`, async () => {
    const { runId, input } = fixture();
    await assert.rejects(
      runThinkWorkflow(runId, input, thinker, {
        research: {
          ...research,
          async investigate() {
            return waiting
              ? {
                  status: 'waiting',
                  question: {
                    id: 'scope',
                    prompt: 'Which deployment policy applies?',
                    choices: [
                      { label: 'Public', description: 'Allow public access.' },
                      { label: 'Private', description: 'Require authentication.' },
                    ],
                    recommendation: null,
                  },
                }
              : researchDraft;
          },
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
    const state = loadThinkState(runId)!;
    const journal = JSON.parse(
      fs.readFileSync(
        path.join(workflowRunDirectory(runId), `returns-${state.invocation}.json`),
        'utf8',
      ),
    ).state;
    assert.equal(journal.waiting, null);
    assert.deepEqual(journal.parents, {});
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
 if(${JSON.stringify(boundary)}==='child-state'&&file.endsWith('research-state.json'))process.exit(73);
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
  for (const boundary of ['reserved', 'child-state', 'child-stage-completed', 'adopted']) {
    const { runId, input } = fixture();
    await interrupt(runId, input, boundary);
    const id = returns(runId)[0].id;
    await rejectMissingJournal(runId, input);
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
    assert.equal(calls, ['reserved', 'child-state'].includes(boundary) ? 1 : 0);
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

test('multiple Think questions remain one assignment without verified independence or extra returns', async () => {
  const { runId, input } = fixture();
  const questions = [
    'Which value is exported?',
    'Which file contains the export?',
    'Which line declares it?',
  ];
  const assignments: string[] = [];
  const result = await runThinkWorkflow(
    runId,
    input,
    {
      ...thinker,
      async design(_i, reports) {
        return reports.length ? ready : { ...gap, research_questions: questions };
      },
    },
    {
      research: {
        ...research,
        async investigate(i, k, s, c, a) {
          assert.equal(i.question, questions.join('\n'));
          assert.equal(i.subquestions, undefined);
          assignments.push(a!.question);
          return research.investigate(i, k, s, c, a);
        },
      },
    },
  );
  assert.equal(result.status, 'ready');
  assert.deepEqual(assignments, [questions.join('\n')]);
  assert.equal(returns(runId).length, 1);
});

test('Think to Research waiting accepts only the original root append and retains its leaf identity', async () => {
  const { runId, input } = fixture();
  let calls = 0;
  const question = {
    id: 'policy',
    prompt: 'Which deployment policy should this investigation cover?',
    choices: [
      { label: 'Public', description: 'Public access.' },
      { label: 'Private', description: 'Private access.' },
    ],
    recommendation: null,
  };
  const worker: ResearchAgent = {
    ...research,
    async investigate(i) {
      calls++;
      return i.clarification_answers?.length ? researchDraft : { status: 'waiting', question };
    },
  };
  const waiting = await runThinkWorkflow(runId, input, thinker, { research: worker });
  assert(waiting.status === 'waiting');
  assert.equal(waiting.owner.task, runId);
  assert.deepEqual(await runThinkWorkflow(runId, input, thinker, { research: worker }), waiting);
  assert.equal(calls, 1);
  const original = JSON.parse(fs.readFileSync(input, 'utf8'));
  const answer = {
    owner: waiting.owner,
    question_id: question.id,
    prompt: question.prompt,
    choices: question.choices,
    recommendation: null,
    selection: 'Public',
    answer: null,
  };
  fs.writeFileSync(input, JSON.stringify({ ...original, clarification_answers: [answer] }));
  const result = await runThinkWorkflow(runId, input, thinker, { research: worker });
  assert.equal(result.status, 'ready');
  assert.equal(calls, 2);
  assert.equal(returns(runId).length, 1);
  assert.equal(returns(runId)[0].id, waiting.owner.leaf);
  assert.deepEqual(loadResearchState(waiting.owner.leaf)!.clarification_history, [answer]);
  assert.deepEqual(await runThinkWorkflow(runId, input, thinker, { research: worker }), result);
});

test('answered Research publication failures and interrupted parent diagnostics remain resumable', async () => {
  for (const boundary of ['throw-json', 'throw-markdown', 'intent', 'parent', 'settled']) {
    const { runId, input } = fixture();
    const question = {
      id: 'publication-policy',
      prompt: 'Which user-owned deployment policy should the investigation cover?',
      choices: [
        { label: 'Public', description: 'Cover public deployment.' },
        { label: 'Private', description: 'Cover private deployment.' },
      ],
      recommendation: null,
    };
    const waiting = await runThinkWorkflow(runId, input, thinker, {
      research: {
        ...research,
        async investigate() {
          return { status: 'waiting', question };
        },
      },
    });
    assert(waiting.status === 'waiting');
    const answer = {
      owner: waiting.owner,
      question_id: question.id,
      prompt: question.prompt,
      choices: question.choices,
      recommendation: null,
      selection: 'Private',
      answer: null,
    };
    fs.writeFileSync(
      input,
      JSON.stringify({
        ...JSON.parse(fs.readFileSync(input, 'utf8')),
        clarification_answers: [answer],
      }),
    );
    const paths = researchPublicationPaths(loadResearchState(waiting.owner.leaf)!);
    const failure = 'Temporary child publication failure';
    const directory = temporaryDirectory('answered-publication-failure-');
    const script = path.join(directory, 'run.ts');
    const calls = path.join(directory, 'calls');
    const failedPath = boundary === 'throw-markdown' ? paths.markdown : paths.json;
    fs.writeFileSync(
      script,
      `
      import fs from 'node:fs'; import {mock} from 'bun:test';
      const rename=fs.renameSync;
      let failed=false;
      fs.renameSync=(...args)=>{
        const file=String(args[1]);
        if(!failed && file===${JSON.stringify(failedPath)}){failed=true;fs.appendFileSync(${JSON.stringify(calls)},'publication\\n');throw Error(${JSON.stringify(failure)});}
        rename(...args);
        if(!failed)return;
        if(file.includes('returns-') && file.endsWith('.json')){
          const s=JSON.parse(fs.readFileSync(file,'utf8')).state;
          if(${JSON.stringify(boundary)}==='intent' && s.parent_transition)process.exit(73);
          if(${JSON.stringify(boundary)}==='settled' && !s.parent_transition)process.exit(73);
        }
        if(${JSON.stringify(boundary)}==='parent' && file.endsWith('think-state.json') && JSON.parse(fs.readFileSync(file,'utf8')).state.reason===${JSON.stringify(failure)})process.exit(73);
      };
      mock.module('node:fs',()=>({...fs,default:fs}));
      const {runThinkWorkflow}=await import(${JSON.stringify(new URL('../../think/runner.ts', import.meta.url).pathname)});
      try {
        await runThinkWorkflow(${JSON.stringify(runId)},${JSON.stringify(input)},
          {async design(){throw Error('No design before publication recovery');},async review(){throw Error('No review before publication recovery');}},
          {research:{async investigate(){fs.appendFileSync(${JSON.stringify(calls)},'investigate\\n');return ${JSON.stringify(researchDraft)};},async audit(){fs.appendFileSync(${JSON.stringify(calls)},'audit\\n');return {summary:'Supported.',findings:[]};}}});
      } catch(error) { if(error.message!==${JSON.stringify(failure)})throw error;process.exit(74); }
      process.exit(75);
    `,
    );
    const child = Bun.spawn([process.execPath, script], {
      env: { ...process.env },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stderr = new Response(child.stderr).text();
    const stdout = new Response(child.stdout).text();
    assert.equal(await child.exited, boundary.startsWith('throw-') ? 74 : 73, await stderr);
    await stdout;
    assert.equal(fs.readFileSync(calls, 'utf8'), 'investigate\naudit\npublication\n');
    const leaf = loadResearchState(waiting.owner.leaf)!;
    assert.equal(leaf.phase, 'publish');
    assert.deepEqual(leaf.clarification_history, [answer]);
    const journalFile = path.join(
      workflowRunDirectory(runId),
      `returns-${waiting.owner.root}.json`,
    );
    const journal = JSON.parse(fs.readFileSync(journalFile, 'utf8')).state;
    assert.equal(journal.adoption.phase, 'routed');
    assert.equal(Boolean(journal.parent_transition), ['intent', 'parent'].includes(boundary));
    if (boundary === 'throw-json' || boundary === 'parent') {
      const original = loadThinkState(runId)!;
      saveThinkState(runId, { ...original, reason: 'Unjournaled edit' });
      await assert.rejects(
        runThinkWorkflow(runId, input, thinker, { research }),
        /authority changed|parent changed/,
      );
      saveThinkState(runId, original);
    }
    const noRedispatch: ResearchAgent = {
      async investigate() {
        throw Error('Accepted investigator must not repeat');
      },
      async audit() {
        throw Error('Accepted audit must not repeat');
      },
    };
    const result = await runThinkWorkflow(runId, input, thinker, { research: noRedispatch });
    assert.equal(result.status, 'ready');
    const resumed = loadResearchState(waiting.owner.leaf)!;
    assert.deepEqual(resumed.clarification_history, [answer]);
    assert.deepEqual(resumed.dispatch_history, leaf.dispatch_history);
    assert.equal(resumed.corrections, leaf.corrections);
    assert.equal(loadThinkState(runId)!.research.length, 1);
    assert.deepEqual(
      returns(runId).map((entry: { id: string }) => entry.id),
      [waiting.owner.leaf],
    );
    assert(fs.existsSync(paths.json) && fs.existsSync(paths.markdown));
    assert.deepEqual(
      await runThinkWorkflow(runId, input, thinker, { research: noRedispatch }),
      result,
    );
  }
}, 20000);

test('root and child answer journals survive exits before adoption, after root adoption, routing, and leaf adoption', async () => {
  for (const boundary of ['before-root', 'root', 'routing', 'leaf', 'leaf-completed']) {
    const { runId, input } = fixture();
    const question = {
      id: 'policy',
      prompt: 'Which policy must this investigation cover?',
      choices: [
        { label: 'Public', description: 'Public access.' },
        { label: 'Private', description: 'Private access.' },
      ],
      recommendation: null,
    };
    const waiting = await runThinkWorkflow(runId, input, thinker, {
      research: {
        ...research,
        async investigate() {
          return { status: 'waiting', question };
        },
      },
    });
    assert(waiting.status === 'waiting');
    await rejectMissingJournal(runId, input);
    const raw = JSON.parse(fs.readFileSync(input, 'utf8'));
    const answer = {
      owner: waiting.owner,
      question_id: question.id,
      prompt: question.prompt,
      choices: question.choices,
      recommendation: null,
      selection: 'Private',
      answer: null,
    };
    fs.writeFileSync(input, JSON.stringify({ ...raw, clarification_answers: [answer] }));
    const script = path.join(temporaryDirectory('waiting-exit-'), 'run.ts');
    fs.writeFileSync(
      script,
      `
      import fs from 'node:fs'; import {mock} from 'bun:test';
      const rename=fs.renameSync;
      fs.renameSync=(...args)=>{
        const file=String(args[1]);
        if(${JSON.stringify(boundary)}==='before-root' && file.includes('returns-'))process.exit(73);
        rename(...args);
        if(file.includes('returns-') && ${JSON.stringify(boundary)}==='root' && JSON.parse(fs.readFileSync(file,'utf8')).state.adoption?.phase==='adopting')process.exit(73);
        if(file.endsWith('research-input.json') && ${JSON.stringify(boundary)}==='routing')process.exit(73);
        if(file.endsWith('research-state.json')){
          const s=JSON.parse(fs.readFileSync(file,'utf8')).state;
          if(s.clarification_history.length===1 && ((${JSON.stringify(boundary)}==='leaf' && s.phase==='investigate') || (${JSON.stringify(boundary)}==='leaf-completed' && s.phase==='completed')))process.exit(73);
        }
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
    const stderr = new Response(child.stderr).text();
    assert.equal(await child.exited, 73, await stderr);
    await rejectMissingJournal(runId, input);
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
    assert.equal(calls, boundary === 'leaf-completed' ? 0 : 1);
    assert.deepEqual(loadResearchState(waiting.owner.leaf)!.clarification_history, [answer]);
    assert.equal(returns(runId).length, 1);
    assert.equal(returns(runId)[0].id, waiting.owner.leaf);
  }
}, 20000);

test('a root Think question after automatic Research uses the same original root submission', async () => {
  const { runId, input } = fixture();
  const question = {
    id: 'post-research-policy',
    prompt: 'Which user-owned deployment policy must the Plan preserve?',
    choices: [
      { label: 'Public', description: 'Public deployment.' },
      { label: 'Private', description: 'Private deployment.' },
    ],
    recommendation: null,
  };
  const worker: ThinkAgent = {
    ...thinker,
    async design(i, reports) {
      return !reports.length
        ? gap
        : i.clarification_answers?.length
          ? ready
          : { status: 'waiting', plan: null, research_questions: [], question };
    },
  };
  const waiting = await runThinkWorkflow(runId, input, worker, { research });
  assert(waiting.status === 'waiting');
  assert.equal(waiting.owner.leaf, runId);
  assert.deepEqual(await runThinkWorkflow(runId, input, worker, { research }), waiting);
  const raw = JSON.parse(fs.readFileSync(input, 'utf8'));
  fs.writeFileSync(
    input,
    JSON.stringify({
      ...raw,
      clarification_answers: [
        {
          owner: waiting.owner,
          question_id: question.id,
          prompt: question.prompt,
          choices: question.choices,
          recommendation: null,
          selection: 'Public',
          answer: null,
        },
      ],
    }),
  );
  assert.equal((await runThinkWorkflow(runId, input, worker, { research })).status, 'ready');
  assert.equal(returns(runId).length, 1);
});

test('automatic Research inherits accepted root answers without manufacturing a new answer submission', async () => {
  const { runId, input } = fixture();
  const question = {
    id: 'root-policy',
    prompt: 'Which user-owned policy should the Plan preserve?',
    choices: [
      { label: 'Public', description: 'Public policy.' },
      { label: 'Private', description: 'Private policy.' },
    ],
    recommendation: null,
  };
  const worker: ThinkAgent = {
    ...thinker,
    async design(i, reports) {
      return reports.length
        ? ready
        : i.clarification_answers?.length
          ? gap
          : { status: 'waiting', plan: null, research_questions: [], question };
    },
  };
  const child: ResearchAgent = {
    ...research,
    async investigate(i, ...args) {
      const prior = i.clarification_answers?.[0] as { question_id: string } | undefined;
      assert(prior);
      assert.equal(prior.question_id, question.id);
      return research.investigate(i, ...args);
    },
  };
  const waiting = await runThinkWorkflow(runId, input, worker, { research: child });
  assert(waiting.status === 'waiting');
  const raw = JSON.parse(fs.readFileSync(input, 'utf8'));
  fs.writeFileSync(
    input,
    JSON.stringify({
      ...raw,
      clarification_answers: [
        {
          owner: waiting.owner,
          question_id: question.id,
          prompt: question.prompt,
          choices: question.choices,
          recommendation: null,
          selection: 'Public',
          answer: null,
        },
      ],
    }),
  );
  assert.equal((await runThinkWorkflow(runId, input, worker, { research: child })).status, 'ready');
  assert.equal(returns(runId).length, 1);
  assert.equal(loadResearchState(returns(runId)[0].id)!.clarification_history.length, 1);
});

test('edited cross-stage dispatch bindings reject before adopting a valid root answer', async () => {
  const { runId, input } = fixture();
  const question = {
    id: 'bound-policy',
    prompt: 'Which policy must the investigation cover?',
    choices: [
      { label: 'Public', description: 'Public access.' },
      { label: 'Private', description: 'Private access.' },
    ],
    recommendation: null,
  };
  let investigators = 0;
  const worker: ResearchAgent = {
    ...research,
    async investigate(i) {
      investigators++;
      return i.clarification_answers?.length ? researchDraft : { status: 'waiting', question };
    },
  };
  const waiting = await runThinkWorkflow(runId, input, thinker, { research: worker });
  assert(waiting.status === 'waiting');
  const rawInput = JSON.parse(fs.readFileSync(input, 'utf8'));
  const answer = {
    owner: waiting.owner,
    question_id: question.id,
    prompt: question.prompt,
    choices: question.choices,
    recommendation: null,
    selection: 'Public',
    answer: null,
  };
  fs.writeFileSync(input, JSON.stringify({ ...rawInput, clarification_answers: [answer] }));
  const file = path.join(workflowRunDirectory(runId), `returns-${waiting.owner.root}.json`);
  const original = fs.readFileSync(file, 'utf8');
  const childInput = workflowInputPath(waiting.owner.leaf, 'research');
  const originalChild = fs.readFileSync(childInput, 'utf8');
  const { thinkDigest } = await import('../../think/state.ts');
  for (const field of ['key', 'parent', 'input', 'inherited', 'source', 'snapshot'] as const) {
    const edited = JSON.parse(original);
    const entry = edited.state.entries[0];
    if (field === 'input') entry.input.question += ' Edited.';
    else if (field === 'inherited') entry.inherited = [answer];
    else if (field === 'key' || field === 'source') entry[field] = 'a'.repeat(64);
    else if (field === 'snapshot') entry.snapshot += '-other';
    else entry.parent = 'another-parent';
    edited.digest = thinkDigest(edited.state);
    const bytes = JSON.stringify(edited);
    fs.writeFileSync(file, bytes);
    await assert.rejects(
      runThinkWorkflow(runId, input, thinker, { research: worker }),
      /dispatch entry changed/,
    );
    assert.equal(fs.readFileSync(file, 'utf8'), bytes);
    assert.equal(fs.readFileSync(childInput, 'utf8'), originalChild);
    assert.equal(investigators, 1);
  }
  fs.writeFileSync(file, original);
  // Even a correctly shaped answer cannot be supplied directly to the child input.
  fs.writeFileSync(
    childInput,
    JSON.stringify({ ...JSON.parse(originalChild), clarification_answers: [answer] }),
  );
  await assert.rejects(
    runThinkWorkflow(runId, input, thinker, { research: worker }),
    /child input changed/,
  );
  assert.equal(investigators, 1);
  fs.writeFileSync(childInput, originalChild);
  assert.equal(
    (await runThinkWorkflow(runId, input, thinker, { research: worker })).status,
    'ready',
  );
  assert.equal(investigators, 2);
});

test.each(['transport', 'question'] as const)(
  'terminal Think consumes fresh authorization before recovering its answered child journal (%s)',
  async (failure) => {
    const { repo, runId, input } = fixture();
    fs.mkdirSync(path.join(repo, '.codex'));
    fs.writeFileSync(
      path.join(repo, '.codex/OUTCOME.md'),
      '# Project outcome\n\nExport value 2.\n',
    );
    const question = {
      id: 'terminal-policy',
      prompt: 'Which deployment policy should this investigation cover?',
      choices: [
        { label: 'Public', description: 'Cover public deployment.' },
        { label: 'Private', description: 'Cover private deployment.' },
      ],
      recommendation: null,
    };
    let investigations = 0;
    let audits = 0;
    const failing: ResearchAgent = {
      ...research,
      async investigate(i) {
        investigations++;
        if (i.clarification_answers?.length) {
          if (failure === 'transport') throw Error('Investigation unavailable');
          return {
            status: 'waiting',
            question: { ...question, id: `unnecessary-${investigations}` },
          };
        }
        return { status: 'waiting', question };
      },
      async audit(i) {
        audits++;
        return i.clarification_answers?.length
          ? {
              summary: 'No further user decision is necessary.',
              findings: [
                {
                  severity: 'blocking',
                  condition: 'Ask only necessary questions.',
                  message: 'Use the accepted answer to complete the evidence.',
                  evidence: [],
                },
              ],
            }
          : { summary: 'The scope decision is necessary.', findings: [] };
      },
    };
    const waiting = await runThinkWorkflow(runId, input, thinker, { research: failing });
    assert(waiting.status === 'waiting');
    const original = fs.readFileSync(input, 'utf8');
    const invocation = loadThinkState(runId)!.invocation;
    assert.throws(() => armIntent({ runId, workflow: 'think', cwd: repo }), /Think is active/);
    assert.deepEqual(await runThinkWorkflow(runId, input, thinker, { research: failing }), waiting);
    assert.equal(investigations, 1);
    const answer = {
      owner: waiting.owner,
      question_id: question.id,
      prompt: question.prompt,
      choices: question.choices,
      recommendation: null,
      selection: 'Private',
      answer: null,
    };
    fs.writeFileSync(
      input,
      JSON.stringify({ ...JSON.parse(original), clarification_answers: [answer] }),
    );
    await assert.rejects(
      runThinkWorkflow(runId, input, thinker, { research: failing }),
      /Research blocked/,
    );
    const terminal = loadThinkState(runId)!;
    assert.equal(terminal.phase, 'blocked');
    const expectedInvestigations = failure === 'transport' ? 3 : 5;
    assert.equal(investigations, expectedInvestigations);
    assert.equal(audits, failure === 'transport' ? 1 : 5);
    const childTerminal = loadResearchState(waiting.owner.leaf)!;
    assert.equal(childTerminal.phase, 'blocked');
    assert.equal(childTerminal.corrections, failure === 'transport' ? 0 : 3);
    if (failure === 'question') {
      assert.equal(childTerminal.pending_question!.id, 'unnecessary-5');
      assert.deepEqual(childTerminal.audit!.findings[0]!.evidence, []);
    }
    const journalFile = path.join(workflowRunDirectory(runId), `returns-${invocation}.json`);
    const journalBytes = fs.readFileSync(journalFile, 'utf8');
    const journal = JSON.parse(journalBytes).state;
    assert.equal(journal.adoption.phase, 'routed');
    for (const cwd of [repo, temporaryDirectory('terminal-think-conversation-')])
      assert.deepEqual(
        handle({
          hook_event_name: 'UserPromptSubmit',
          session_id: runId,
          cwd,
          prompt: 'Explain how Array.map works.',
        }),
        {},
      );
    await assert.rejects(
      runThinkWorkflow(runId, input, thinker, { research: failing }),
      /Think blocked/,
    );
    assert.equal(investigations, expectedInvestigations);

    const fresh = {
      repo,
      request: 'Prepare a fresh Plan under a new explicit invocation.',
      research_reports: [],
    };
    fs.writeFileSync(input, JSON.stringify(fresh));
    await assert.rejects(
      runThinkWorkflow(runId, input, thinker, { research: failing }),
      /exact original input/,
    );
    assert.deepEqual(loadThinkState(runId), terminal);
    armIntent({ runId, workflow: 'research', cwd: repo });
    await assert.rejects(runThinkWorkflow(runId, input, thinker), /explicit \$think/);
    assert.deepEqual(loadThinkState(runId), terminal);
    fs.unlinkSync(journalFile);
    const authorized = handle({
      hook_event_name: 'UserPromptSubmit',
      session_id: runId,
      cwd: repo,
      prompt: '$think Prepare a fresh Plan under a new explicit invocation.',
    });
    assert.equal(authorized.decision, undefined);
    assert.match(authorized.hookSpecificOutput!.additionalContext!, /Explicit \$think is armed/);
    let designs = 0,
      reviews = 0;
    const result = await runThinkWorkflow(
      runId,
      input,
      {
        async design(i, reports) {
          designs++;
          assert.equal(i.request, fresh.request);
          assert.equal(i.clarification_answers, undefined);
          assert.deepEqual(reports, []);
          return ready;
        },
        async review() {
          reviews++;
          return { summary: 'Fresh Plan verified.', findings: [] };
        },
      },
      { research: failing },
    );
    assert.equal(result.status, 'ready');
    const completed = loadThinkState(runId)!;
    assert.notEqual(completed.invocation, invocation);
    assert.equal(completed.corrections, 0);
    assert.deepEqual(completed.clarification_history, []);
    assert.equal(loadIntent(runId), null);
    assert.equal(designs, 1);
    assert.equal(reviews, 1);
    assert.equal(investigations, expectedInvestigations);
    assert.equal(fs.existsSync(journalFile), false);
    fs.writeFileSync(journalFile, journalBytes);
    assert.deepEqual(loadResearchState(waiting.owner.leaf)!.clarification_history, [answer]);
    assert.deepEqual(loadResearchState(waiting.owner.leaf), childTerminal);
  },
);

test('Think initialization publishes ownership before root state and retains direct waiting ownership', async () => {
  for (const boundary of ['journal', 'root']) {
    const { runId, input } = fixture();
    const directory = workflowRunDirectory(runId);
    const script = path.join(temporaryDirectory('think-initialize-'), 'run.ts');
    fs.writeFileSync(
      script,
      `
      import fs from 'node:fs'; import {mock} from 'bun:test';
      const rename=fs.renameSync;
      fs.renameSync=(...args)=>{rename(...args);const file=String(args[1]);
        if((${JSON.stringify(boundary)}==='journal' && file.includes('returns-')) ||
          (${JSON.stringify(boundary)}==='root' && file.endsWith('think-state.json')))process.exit(73);
      };
      mock.module('node:fs',()=>({...fs,default:fs}));
      const {runThinkWorkflow}=await import(${JSON.stringify(new URL('../../think/runner.ts', import.meta.url).pathname)});
      await runThinkWorkflow(${JSON.stringify(runId)},${JSON.stringify(input)}, {
        async design(){throw Error('No design before initialization');},
        async review(){throw Error('No review before initialization');}
      });
    `,
    );
    const child = Bun.spawn([process.execPath, script], {
      env: { ...process.env },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stderr = new Response(child.stderr).text();
    assert.equal(await child.exited, 73, await stderr);
    const journalName = fs.readdirSync(directory).find((name) => name.startsWith('returns-'))!;
    const journalFile = path.join(directory, journalName);
    const initialized = fs.readFileSync(journalFile, 'utf8');
    assert.deepEqual(JSON.parse(initialized).state.entries, []);
    if (boundary === 'root') await rejectMissingJournal(runId, input);
    else {
      assert.equal(loadThinkState(runId), null);
      // Losing an unused journal before any root state or dispatch exists is legitimate initialization.
      fs.unlinkSync(journalFile);
    }
    const question = {
      id: 'initial-policy',
      prompt: 'Which deployment policy should the Plan cover?',
      choices: [
        { label: 'Public', description: 'Cover public access.' },
        { label: 'Private', description: 'Cover private access.' },
      ],
      recommendation: null,
    };
    let designs = 0;
    const agent: ThinkAgent = {
      async design(i) {
        designs++;
        return i.clarification_answers?.length
          ? ready
          : { status: 'waiting', plan: null, research_questions: [], question };
      },
      async review() {
        return { summary: 'Necessary policy decision or verified Plan.', findings: [] };
      },
    };
    const waiting = await runThinkWorkflow(runId, input, agent);
    assert(waiting.status === 'waiting');
    await rejectMissingJournal(runId, input);
    assert.deepEqual(await runThinkWorkflow(runId, input, agent), waiting);
    assert.equal(designs, 1);
    const answer = {
      owner: waiting.owner,
      question_id: question.id,
      prompt: question.prompt,
      choices: question.choices,
      recommendation: null,
      selection: 'Private',
      answer: null,
    };
    fs.writeFileSync(
      input,
      JSON.stringify({
        ...JSON.parse(fs.readFileSync(input, 'utf8')),
        clarification_answers: [answer],
      }),
    );
    await rejectMissingJournal(runId, input);
    assert.equal((await runThinkWorkflow(runId, input, agent)).status, 'ready');
    assert.equal(designs, 2);
    assert.deepEqual(returns(runId), []);
  }
}, 15000);
