/** @file Outcome: Real SDK client wiring selects the installed CLI and Astra/high while preserving sandboxing and safe usage telemetry. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'bun:test';
import {
  createSignedInCodexClient,
  IMPLEMENTATION_THREAD_OPTIONS,
  readOnlyThreadOptions,
} from '../../shared/codex.ts';
import { ProgressReporter, type ProgressEvent } from '../../shared/progress.ts';
import { temporaryDirectory } from './fixtures.ts';

function clientFixture() {
  const root = temporaryDirectory('codex-client-');
  const bin = path.join(root, 'bin');
  const home = path.join(root, 'home');
  fs.mkdirSync(bin);
  fs.mkdirSync(home);
  fs.writeFileSync(path.join(home, 'auth.json'), '{"fixture":true}');
  const executable = path.join(bin, 'codex');
  fs.writeFileSync(
    executable,
    `#!${process.execPath}
await Bun.stdin.text();
const response = {
  args: process.argv.slice(2),
  home: process.env.HOME,
  codexHome: process.env.CODEX_HOME,
  apiKeyPresent: Boolean(process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY),
};
for (const event of [
  {type: 'thread.started', thread_id: 'controlled'},
  {type: 'item.completed', item: {id: 'response', type: 'agent_message', text: JSON.stringify(response)}},
  {type: 'turn.completed', usage: process.env.FIXTURE_USAGE ? JSON.parse(process.env.FIXTURE_USAGE) : {input_tokens: 1, output_tokens: 1, cached_input_tokens: 0}},
]) process.stdout.write(JSON.stringify(event) + '\\n');
`,
    { mode: 0o700 },
  );
  return {
    root,
    executable,
    env: {
      PATH: bin,
      CODEX_HOME: home,
      OPENAI_API_KEY: 'synthetic-key',
      CODEX_API_KEY: 'synthetic-key',
    },
  };
}

for (const override of [false, true])
  test(`real SDK uses ${override ? 'explicit CLI override' : 'PATH CLI'} with Astra/high and sandbox restrictions`, async () => {
    const { root, executable, env } = clientFixture();
    const alternate = path.join(root, 'explicit codex');
    if (override) fs.renameSync(executable, alternate);
    const usage = {
      input_tokens: 12,
      output_tokens: 3,
      cached_input_tokens: 0,
      cache_write_input_tokens: 2,
      reasoning_output_tokens: 1,
    };
    const client = createSignedInCodexClient({
      ...env,
      ...(override ? { CODEX_CLI_PATH: alternate, PATH: '' } : {}),
      FIXTURE_USAGE: JSON.stringify({ ...usage, private_text: 'never expose this' }),
    });
    const lines: string[] = [];
    const progress = new ProgressReporter({ write: (line) => lines.push(line) });
    await progress.run({ workflow: 'code', stage: 'actor_model_call' }, async (stage) => {
      for (const options of [
        readOnlyThreadOptions(root),
        {
          ...readOnlyThreadOptions(root),
          ...IMPLEMENTATION_THREAD_OPTIONS,
          sandboxMode: 'workspace-write' as const,
        },
      ]) {
        const result = await client.startThread(options).run('private prompt', {
          modelRun: {
            label: 'controlled SDK',
            idleCode: 'fixture_idle',
            onActivity: (activity) => stage.activity(activity),
          },
        });
        const observed = JSON.parse(result.finalResponse);
        const args: string[] = observed.args;
        assert.equal(args[args.indexOf('--model') + 1], 'gpt-6-astra');
        assert(args.includes('model_reasoning_effort="high"'));
        assert.equal(args[args.indexOf('--sandbox') + 1], options.sandboxMode);
        assert.equal(args[args.indexOf('--cd') + 1], root);
        assert(args.includes('approval_policy="never"'));
        assert(args.includes('sandbox_workspace_write.network_access=false'));
        assert(args.includes('web_search="disabled"'));
        assert.equal(observed.apiKeyPresent, false);
        assert.equal(observed.home, observed.codexHome);
        assert.notEqual(observed.codexHome, env.CODEX_HOME);
        assert.deepEqual(result.usage, usage);
      }
    });
    const events = lines.map((line) => JSON.parse(line) as ProgressEvent);
    const turns = events.filter((event) => event.event_type === 'turn.completed');
    assert.equal(turns.length, 2, 'each fast turn survives without waiting for a heartbeat');
    for (const turn of turns) {
      assert.equal(turn.model, 'gpt-6-astra');
      assert.equal(turn.model_reasoning_effort, 'high');
      assert.deepEqual(turn.usage, usage);
    }
    assert.doesNotMatch(
      lines.join(''),
      /private prompt|private_text|never expose|synthetic-key|args|codexHome/,
    );
  });

test('telemetry failures cannot change the real SDK verdict', async () => {
  const { env } = clientFixture();
  const activities: unknown[] = [];
  const result = await createSignedInCodexClient(env)
    .startThread()
    .run('prompt', {
      modelRun: {
        label: 'controlled SDK',
        idleCode: 'fixture_idle',
        onActivity(activity) {
          activities.push(activity.usage);
          throw new Error('broken telemetry');
        },
      },
    });
  assert.equal(result.usage?.input_tokens, 1);
  assert(activities.length > 0);
  assert(activities.some((usage) => usage !== undefined));
  const args: string[] = JSON.parse(result.finalResponse).args;
  assert.equal(args[args.indexOf('--model') + 1], 'gpt-6-astra');
  assert(args.includes('model_reasoning_effort="high"'));
});

test('a missing installed CLI or invalid override cannot fall back to the SDK-bundled binary', () => {
  const { root, env } = clientFixture();
  for (const missing of [
    { ...env, PATH: path.join(root, 'missing') },
    { ...env, CODEX_CLI_PATH: path.join(root, 'missing') },
  ]) {
    assert.throws(() => createSignedInCodexClient(missing), /Installed Codex CLI not found/);
  }
});
