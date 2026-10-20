import assert from 'node:assert/strict';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { isRecord } from '../../scripts/shared/values.ts';

export const lightCliFixture = import.meta.path;

// 実CLI・認証・providerへ委譲しない模擬CLI。controlはホストだけが作る合成JSON。
// { auth, scenario, events }を受ける。eventsは原操作記録の保存先。
// sandboxの成立を偽装せず、診断要求には未対応を返す。
const scenarios = new Set([
  'normal',
  'task-failure',
  'cli-failure',
  'auth-error',
  'quota-error',
  'timeout',
  'missing-jsonl',
  'invalid-usage',
  'log-overflow',
  'artifact-file-overflow',
  'artifact-total-overflow',
  'artifact-count-overflow',
]);

function event(value: unknown) {
  console.log(JSON.stringify(value));
}

async function artifact(scenario: string) {
  const dir = resolve('synthetic-artifacts');
  await mkdir(dir, { recursive: true });
  const count =
    scenario === 'artifact-count-overflow' ? 2001 : scenario === 'artifact-total-overflow' ? 9 : 1;
  const size =
    scenario === 'artifact-file-overflow'
      ? 1048577
      : scenario === 'artifact-total-overflow'
        ? 1048576
        : 1;
  for (let index = 0; index < count; index++) {
    await writeFile(join(dir, `${index}.txt`), Buffer.alloc(size, 120));
  }
}

async function execution(scenario: string, args: string[]) {
  if (scenario === 'missing-jsonl') {
    return;
  }
  if (scenario === 'log-overflow') {
    const block = 'x'.repeat(65536);
    for (let index = 0; index < 257; index++) {
      console.log(block);
    }
    return;
  }
  if (scenario.startsWith('artifact-')) {
    await artifact(scenario);
  }
  if (scenario === 'timeout') {
    // 通常の子処理を含む終了観測用。別session・daemonへ逃がさない。
    const child = Bun.spawn(['/bin/sh', '-c', 'sleep 600'], { stdout: 'ignore', stderr: 'ignore' });
    event({ type: 'fixture.ready', parentPid: process.pid, childPid: child.pid });
    await child.exited;
    return;
  }
  if (['cli-failure', 'auth-error', 'quota-error'].includes(scenario)) {
    const message =
      scenario === 'auth-error'
        ? 'Authentication failed (synthetic)'
        : scenario === 'quota-error'
          ? 'Usage limit reached (synthetic)'
          : 'CLI failed (synthetic)';
    event({ type: 'turn.failed', error: { message } });
    process.exitCode = 1;
    return;
  }
  if (scenario === 'task-failure') {
    event({
      type: 'item.completed',
      item: {
        id: 'command',
        type: 'command_execution',
        command: 'false',
        exit_code: 1,
        status: 'failed',
        aggregated_output: 'synthetic task failure',
      },
    });
  }
  const reply = JSON.stringify({
    status: 'repaired',
    findings: '合成応答。要求充足の証拠ではない。',
  });
  const outputIndex = args.findIndex((arg) => arg === '--output-last-message' || arg === '-o');
  if (outputIndex >= 0) {
    const path = args[outputIndex + 1];
    assert(path);
    await writeFile(path, reply);
  }
  event({ type: 'item.completed', item: { id: 'reply', type: 'agent_message', text: reply } });
  event({
    type: 'turn.completed',
    usage: {
      input_tokens: scenario === 'invalid-usage' ? -1 : 12,
      cached_input_tokens: 3,
      output_tokens: 4,
    },
  });
}

async function main() {
  const [control, ...args] = process.argv.slice(2);
  assert(control);
  const settings: unknown = JSON.parse(await readFile(control, 'utf8'));
  assert(
    isRecord(settings) &&
      typeof settings.auth === 'string' &&
      typeof settings.scenario === 'string' &&
      typeof settings.events === 'string',
  );
  assert(scenarios.has(settings.scenario), '未知の合成シナリオ');
  await appendFile(
    settings.events,
    `${JSON.stringify({ args, cwd: process.cwd(), pid: process.pid, environmentKeys: Object.keys(process.env).sort() })}\n`,
  );
  if (args.includes('--version')) {
    console.log('codex-cli 0.163.0');
    return;
  }
  if (args.includes('login') && args[args.indexOf('login') + 1] === 'status') {
    const statuses: Record<string, [string, number]> = {
      chatgpt: ['Logged in using ChatGPT', 0],
      api: ['Logged in using an API key', 0],
      absent: ['Not logged in', 1],
      unknown: ['Unrecognized authentication state (synthetic)', 0],
    };
    const status = statuses[settings.auth];
    assert(status, '未知の合成認証状態');
    console.error(status[0]);
    process.exitCode = status[1];
    return;
  }
  if (args.includes('exec')) {
    await execution(settings.scenario, args);
    return;
  }
  console.error('Synthetic CLI: native sandbox boundary unavailable');
  process.exitCode = 78;
}

if (import.meta.main) {
  await main();
}
