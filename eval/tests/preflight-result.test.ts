import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'bun:test';
import { isRecord } from '../../scripts/shared/values.ts';
import { assessScenario } from '../preflight.ts';

// #401の「操作未開始を期限成功にしない」「実操作の版を照合する」が判定根拠。
// 接続だけをホスト提示のassessScenario APIへ合わせる。実Dockerの証拠ではない。
// 未実装のAPIを代替実装やskipで成功にしない。
async function assess(result: unknown, scenario: unknown, directory: string) {
  const api: unknown = assessScenario;
  assert(typeof api === 'function');
  const assessment: unknown = Reflect.apply(api, undefined, [result, scenario, directory, '1.4.3']);
  await Promise.resolve(assessment);
}

function runtime(role = 'operation') {
  return {
    role,
    bunVersion: '1.4.3',
    execPath: '/usr/local/bin/bun',
    realPath: '/usr/local/bin/bun',
  };
}

async function readScenario(id: string) {
  const fixtures: unknown = JSON.parse(
    await readFile(resolve(import.meta.dir, 'preflight.json'), 'utf8'),
  );
  assert(Array.isArray(fixtures));
  const source: unknown = fixtures.find((value: unknown) => isRecord(value) && value.id === id);
  assert(
    isRecord(source) &&
      typeof source.artifact === 'string' &&
      typeof source.artifactText === 'string' &&
      typeof source.runtimeArtifact === 'string' &&
      typeof source.marker === 'string',
  );
  return {
    ...source,
    artifact: source.artifact,
    artifactText: source.artifactText,
    runtimeArtifact: source.runtimeArtifact,
    marker: source.marker,
    responseSchema: source.responseSchema,
    expectedRejected: source.expectedRejected ?? 1,
  };
}

async function stoppedFixture(id: 'timeout' | 'interrupt') {
  const scenario = await readScenario(id);
  const directory = await mkdtemp(join(tmpdir(), 'preflight-result-'));
  const result = {
    mode: id,
    launched: true,
    execution: id === 'timeout' ? 'timeout' : 'failed',
    reason:
      id === 'timeout'
        ? 'Wall time exhausted; container terminated'
        : 'Interrupted execution: reconcile existing process and evidence before continuing',
    versions: { cli: 'codex-cli synthetic', bun: '1.4.3', git: 'git version synthetic' },
    requests: { requests: 1, rejected: 1, failed: false },
    safety: { containersRemoved: true, networkRemoved: true },
  };
  const observation = {
    running: true,
    artifact: scenario.artifact,
    artifactText: scenario.artifactText,
    runtime: [runtime()],
  };
  // 停止ケースでは成果物snapshotの代わりに、生存中の原観測を公開APIへ渡す。
  await writeFile(join(directory, 'actor.stdout'), '');
  await writeFile(join(directory, 'actor.stderr'), '');
  await writeFile(join(directory, 'operation-observation.json'), JSON.stringify(observation));
  return { directory, result, scenario, observation };
}

type StoppedFixture = Awaited<ReturnType<typeof stoppedFixture>>;

const invalidObservations: [string, (value: StoppedFixture) => Promise<unknown> | void][] = [
  ['開始の原観測がない', ({ directory }) => rm(join(directory, 'operation-observation.json'))],
  [
    '生存していない',
    ({ observation }) => {
      observation.running = false;
    },
  ],
  [
    '別の成果物',
    ({ observation }) => {
      observation.artifact = 'unrelated.txt';
    },
  ],
  [
    '成果物の本文が違う',
    ({ observation }) => {
      observation.artifactText = '未開始';
    },
  ],
  [
    '実操作の版観測がない',
    ({ observation }) => {
      observation.runtime = [];
    },
  ],
  [
    '親actorの版だけ',
    ({ observation }) => {
      observation.runtime = [runtime('actor')];
    },
  ],
  [
    '操作Bunの版が違う',
    ({ observation }) => {
      observation.runtime = [{ ...runtime(), bunVersion: '1.4.2' }];
    },
  ],
  [
    '操作Bunの入口が違う',
    ({ observation }) => {
      observation.runtime = [{ ...runtime(), execPath: '/tmp/bun' }];
    },
  ],
  [
    '操作Bunの実体が違う',
    ({ observation }) => {
      observation.runtime = [{ ...runtime(), realPath: '/tmp/bun' }];
    },
  ],
  [
    '削除未確認',
    ({ result }) => {
      result.safety.containersRemoved = false;
    },
  ],
  [
    'network削除未確認',
    ({ result }) => {
      result.safety.networkRemoved = false;
    },
  ],
  [
    '操作未起動',
    ({ result }) => {
      result.launched = false;
    },
  ],
  [
    '停止後もmetadata fallbackを拒否する',
    ({ directory }) =>
      writeFile(
        join(directory, 'actor.stderr'),
        'WARNING: model metadata not found; using fallback\n',
      ),
  ],
];

for (const id of ['timeout', 'interrupt'] as const) {
  test(`${id}は実操作の開始・生成物・実Bunの原観測が揃えば受け入れる`, async () => {
    const value = await stoppedFixture(id);
    try {
      await assess(value.result, value.scenario, value.directory);
    } finally {
      await rm(value.directory, { recursive: true, force: true });
    }
  });

  for (const [name, change] of invalidObservations) {
    test(`${id}の誤った成功を拒否する: ${name}`, async () => {
      const value = await stoppedFixture(id);
      try {
        // 同じ入力の正常対照が判定へ到達してから一条件だけ崩す。
        await assess(value.result, value.scenario, value.directory);
        await change(value);
        if (name !== '開始の原観測がない') {
          await writeFile(
            join(value.directory, 'operation-observation.json'),
            JSON.stringify(value.observation),
          );
        }
        await assert.rejects(assess(value.result, value.scenario, value.directory));
      } finally {
        await rm(value.directory, { recursive: true, force: true });
      }
    });
  }
}

async function completedFixture(id: 'scoping' | 'initial' = 'scoping') {
  const value = await stoppedFixture('timeout');
  const scenario = await readScenario(id);
  const result = {
    ...value.result,
    mode: id,
    execution: 'completed',
    reason: 'Awaiting independent adjudication',
    requests: { requests: 2, rejected: 1, failed: false },
  };
  const encode = (path: string, body: string) => ({
    path,
    base64: Buffer.from(body).toString('base64'),
  });
  const files = [
    encode(scenario.artifact, scenario.artifactText),
    encode(scenario.runtimeArtifact, JSON.stringify([runtime()])),
  ];
  if (id === 'initial') {
    files.push(
      encode(
        'actor-records/final.json',
        JSON.stringify({ status: 'repaired', findings: '公開された固定操作を確認しました。' }),
      ),
    );
  }
  const events = [
    { type: 'thread.started', thread_id: 'public-thread' },
    { type: 'turn.started' },
    // CLIの終了0や親actorの版は、操作artifactの観測の代わりにしない。
    {
      type: 'eval.runtime',
      bunVersion: '1.4.3',
      execPath: '/usr/local/bin/bun',
      realPath: '/usr/local/bin/bun',
    },
    {
      type: 'item.completed',
      item: {
        id: 'public-command',
        type: 'command_execution',
        command: 'bun public-operation.ts',
        aggregated_output: scenario.marker,
        exit_code: 0,
        status: 'completed',
      },
    },
    { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } },
  ];
  await rm(join(value.directory, 'operation-observation.json'));
  // 次要求に届いたツール結果を保存する。actorの表示や統計はその代用にしない。
  const gatewayEvents = [
    {
      type: 'preflight.request',
      step: 1,
      body: {
        input: [],
        // #401: 初回担当のschemaを要求へ接続した正常対照から、
        // 最終応答だけを崩す。schemaの指定欠落で先に拒否させない。
        ...(scenario.responseSchema
          ? {
              text: {
                format: {
                  type: 'json_schema',
                  name: 'codex_output_schema',
                  strict: true,
                  schema: scenario.responseSchema,
                },
              },
            }
          : {}),
      },
    },
    {
      type: 'preflight.request',
      step: 2,
      body: {
        input: [
          {
            type: 'custom_tool_call_output',
            call_id: 'public-call',
            output: scenario.marker,
          },
        ],
      },
    },
  ];
  const save = async () => {
    await writeFile(
      join(value.directory, 'gateway.stdout'),
      gatewayEvents.map((event) => JSON.stringify(event)).join('\n') + '\n',
    );
    await writeFile(
      join(value.directory, 'actor.stdout'),
      [...events, { type: 'eval.artifacts', files }]
        .map((event) => JSON.stringify(event))
        .join('\n') + '\n',
    );
  };
  await save();
  return { ...value, result, scenario, files, events, gatewayEvents, save };
}

type CompletedFixture = Awaited<ReturnType<typeof completedFixture>>;

const invalidCompleted: [string, (value: CompletedFixture) => void][] = [
  [
    'CLI終了0でもturn未完了',
    ({ events }) => {
      const index = events.findIndex((event) => event.type === 'turn.completed');
      assert(index >= 0);
      events.splice(index, 1);
    },
  ],
  [
    'CLI終了0でもturn失敗',
    ({ events }) => {
      const event = events.find((entry) => entry.type === 'turn.completed');
      assert(event);
      event.type = 'turn.failed';
    },
  ],
  [
    '要求未到達',
    ({ result }) => {
      result.requests.requests = 0;
    },
  ],
  [
    'provider失敗',
    ({ result }) => {
      result.requests.failed = true;
    },
  ],
  [
    'CLI終了0でも既知のコマンド失敗',
    ({ events }) => {
      const event = events.find((entry) => entry.type === 'item.completed');
      assert(event?.item);
      event.item.exit_code = 1;
      event.item.status = 'failed';
    },
  ],
  [
    'markerのない正常終了',
    ({ events, gatewayEvents }) => {
      const event = events.find((entry) => entry.type === 'item.completed');
      const output = gatewayEvents.find((entry) => entry.step === 2)?.body.input[0];
      assert(event?.item && output);
      event.item.aggregated_output = 'markerなし';
      output.output = 'markerなし';
    },
  ],
  [
    'actor表示だけのmarker',
    ({ gatewayEvents }) => {
      gatewayEvents.length = 0;
    },
  ],
  [
    '要求以外のイベントのmarker',
    ({ gatewayEvents }) => {
      const event = gatewayEvents.find((entry) => entry.step === 2);
      assert(event);
      event.type = 'unrelated.event';
    },
  ],
  [
    '操作runtimeファイル欠落',
    ({ files }) => {
      files.pop();
    },
  ],
  [
    '操作Bunの版不一致',
    ({ files }) => {
      const file = files[1];
      assert(file);
      file.base64 = Buffer.from(JSON.stringify([{ ...runtime(), bunVersion: '1.4.2' }])).toString(
        'base64',
      );
    },
  ],
  [
    '親actorだけの観測',
    ({ files }) => {
      const file = files[1];
      assert(file);
      file.base64 = Buffer.from(JSON.stringify([runtime('actor')])).toString('base64');
    },
  ],
  [
    '操作Bunの入口不一致',
    ({ files }) => {
      const file = files[1];
      assert(file);
      file.base64 = Buffer.from(JSON.stringify([{ ...runtime(), execPath: '/tmp/bun' }])).toString(
        'base64',
      );
    },
  ],
  [
    '操作Bunの実体不一致',
    ({ files }) => {
      const file = files[1];
      assert(file);
      file.base64 = Buffer.from(JSON.stringify([{ ...runtime(), realPath: '/tmp/bun' }])).toString(
        'base64',
      );
    },
  ],
  [
    '成果物本文不一致',
    ({ files }) => {
      const file = files[0];
      assert(file);
      file.base64 = Buffer.from('未生成').toString('base64');
    },
  ],
  [
    '予期しない追加の拒否',
    ({ result }) => {
      result.requests.rejected = 2;
    },
  ],
];

test('正常終了は実成果物snapshotの操作runtimeを照合する', async () => {
  const value = await completedFixture();
  try {
    await assess(value.result, value.scenario, value.directory);
  } finally {
    await rm(value.directory, { recursive: true, force: true });
  }
});

for (const [name, change] of invalidCompleted) {
  test(`正常終了の誤った成功を拒否する: ${name}`, async () => {
    const value = await completedFixture();
    try {
      await assess(value.result, value.scenario, value.directory);
      change(value);
      await value.save();
      await assert.rejects(assess(value.result, value.scenario, value.directory));
    } finally {
      await rm(value.directory, { recursive: true, force: true });
    }
  });
}

// #401の初回実装経路では、CLI終了・marker・通常成果物とは別に
// 実際の最終応答が初回担当のschemaを満たす必要がある。
for (const [name, body] of [
  ['欠落', null],
  ['JSON不正', '{'],
  ['必須findings欠落', JSON.stringify({ status: 'repaired' })],
  ['未知status', JSON.stringify({ status: 'completed', findings: '公開結果' })],
  ['未知フィールド', JSON.stringify({ status: 'repaired', findings: '公開結果', extra: true })],
] as const) {
  test(`初回実装の応答schema不正を拒否する: ${name}`, async () => {
    const value = await completedFixture('initial');
    try {
      await assess(value.result, value.scenario, value.directory);
      const file = value.files.find((entry) => entry.path === 'actor-records/final.json');
      assert(file);
      if (body === null) {
        value.files.splice(value.files.indexOf(file), 1);
      } else {
        file.base64 = Buffer.from(body).toString('base64');
      }
      await value.save();
      await assert.rejects(assess(value.result, value.scenario, value.directory));
    } finally {
      await rm(value.directory, { recursive: true, force: true });
    }
  });
}

for (const reason of ['Command failed', 'Interrupted by SIGINT']) {
  test(`任意のfailedを割込み成功に読み替えない: ${reason}`, async () => {
    const value = await stoppedFixture('interrupt');
    try {
      await assess(value.result, value.scenario, value.directory);
      value.result.reason = reason;
      await assert.rejects(assess(value.result, value.scenario, value.directory));
    } finally {
      await rm(value.directory, { recursive: true, force: true });
    }
  });
}
