// #401の有限な終了観測を、実Docker・実時間の待機なしで公開入口へ接続する。
// 別プロセスでだけmodule mockを登録し、他テストと通常経路へ漏らさない。
import assert from 'node:assert/strict';
import * as childProcess from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { mock, spyOn } from 'bun:test';
import { evalConfig } from '../data.ts';
import { isRecord } from '../../scripts/shared/values.ts';

// 親はこのパスだけを取得し、mockの登録は子プロセスのmainで行う。
export const exitObservationWorker = import.meta.path;

async function runWorker() {
  const root = process.argv[2];
  const mode = process.argv[3];
  assert(root && mode);
  const runtime = join(root, 'runtime');
  const input = join(root, 'input');
  await mkdir(runtime);
  await mkdir(input);
  const scenarios: unknown = JSON.parse(
    await readFile(resolve(import.meta.dir, 'preflight.json'), 'utf8'),
  );
  assert(Array.isArray(scenarios));
  const scenario: unknown = scenarios.find(
    (entry: unknown) => isRecord(entry) && entry.id === 'boundaries',
  );
  assert(isRecord(scenario) && isRecord(scenario.files));
  await writeFile(join(runtime, 'scenario.json'), JSON.stringify(scenario));
  await writeFile(
    join(runtime, 'settings.json'),
    JSON.stringify({
      model: 'example-model',
      reasoning: 'high',
      maxRequests: 4,
      prompt: scenario.prompt,
      maxOutputTokens: 8000,
      cliVersion: 'codex-cli 0.163.0',
      bunVersion: '1.4.3',
      gitVersion: 'git version 2.39.5',
      expiresAt: Date.now() + 120000,
    }),
  );
  for (const [path, text] of Object.entries(scenario.files)) {
    assert(typeof text === 'string');
    await writeFile(join(input, path), text);
  }

  let now = 1000;
  let actorStarted = false;
  let controls = 0;
  const calls: { args: string[]; timeout: number | null; at: number; kind: string }[] = [];
  const created = new Map<string, string[]>();
  const network = [
    {
      Driver: 'bridge',
      Internal: true,
      EnableIPv6: false,
      Options: { 'com.docker.network.bridge.gateway_mode_ipv4': 'isolated' },
    },
  ];

  function inspect(name: string) {
    const args = created.get(name);
    assert(args, `未作成のinspect: ${name}`);
    const option = (flag: string) => args[args.indexOf(flag) + 1];
    const networkName = option('--network');
    assert(networkName);
    const image = args.at(-3);
    assert(image);
    const mounts = args
      .filter((arg) => arg.startsWith('type=bind'))
      .map((arg) => {
        const source = arg
          .split(',')
          .find((part) => part.startsWith('src='))
          ?.slice(4);
        const destination = arg
          .split(',')
          .find((part) => part.startsWith('dst='))
          ?.slice(4);
        return { Type: 'bind', RW: false, Source: source, Destination: destination };
      });
    return [
      {
        Config: { User: '1000:1000', Image: image },
        Image: image.split('@')[1],
        State: { Running: true, Pid: 123, ExitCode: 0 },
        HostConfig: {
          ReadonlyRootfs: true,
          Privileged: false,
          NetworkMode: networkName,
          PidMode: '',
          UTSMode: '',
          IpcMode: 'private',
          Dns: ['127.0.0.1'],
          Sysctls: { 'net.ipv4.ip_forward': '0' },
          LogConfig: {
            Type: 'local',
            Config: { 'max-size': '10m', 'max-file': '1', compress: 'false' },
          },
          Devices: [],
          DeviceRequests: [],
          ExtraHosts: [],
          Links: [],
          VolumesFrom: [],
          CapDrop: ['ALL'],
          CapAdd: null,
          SecurityOpt: ['no-new-privileges'],
          Memory: 2147483648,
          NanoCpus: 2000000000,
          PidsLimit: 64,
          Tmpfs: {
            '/work': 'rw,nosuid,nodev,size=268435456,uid=1000,gid=1000',
            '/tmp': 'rw,nosuid,nodev,size=67108864,uid=1000,gid=1000',
          },
        },
        Mounts: mounts,
        NetworkSettings: { Networks: { [networkName]: { IPAddress: '172.28.0.2' } } },
      },
    ];
  }

  async function reply(args: string[]) {
    switch (args[0]) {
      case 'image':
        return JSON.stringify([
          {
            Id: args.at(-1)?.split('@')[1],
            Config: { Env: ['PATH=/usr/local/bin:/usr/bin:/bin'], Volumes: null },
          },
        ]);
      case 'network':
        return args[1] === 'inspect' ? JSON.stringify(network) : '';
      case 'create': {
        const name = args[args.indexOf('--name') + 1];
        assert(name);
        created.set(name, args);
        return '';
      }
      case 'inspect':
        return inspectReply(args);
      case 'logs':
        return args.at(-1)?.endsWith('-canary') && !actorStarted
          ? JSON.stringify({ type: 'preflight.canary-ready' })
          : '公開された合成終了ログ\n';
      case 'exec':
        return JSON.stringify({ requests: 2, rejected: 5, failed: false });
      case 'start':
        return startReply(args);
      default:
        return '';
    }
  }

  function inspectReply(args: string[]) {
    if (!args.includes('--format')) {
      return JSON.stringify(inspect(String(args.at(-1))));
    }
    return args.some((arg) => arg.includes('.State.Running')) ? 'false 0 0' : '172.28.0.2';
  }

  async function startReply(args: string[]) {
    if (args.at(-1)?.endsWith('-probe')) {
      return JSON.stringify({
        cli: 'codex-cli 0.163.0',
        bun: '1.4.3',
        entryBun: '1.4.3',
        git: 'git version 2.39.5',
        safety: 'probe-passed',
      });
    }
    if (args.at(-1)?.endsWith('-canary-control')) {
      controls++;
      // 対照の完了を終了観測予算に含める誤りも区別する。
      now += 12000;
      const settings: unknown = JSON.parse(await readFile(join(runtime, 'settings.json'), 'utf8'));
      assert(isRecord(settings) && isRecord(settings.networkCanary));
      const canary = settings.networkCanary;
      return JSON.stringify({
        type: 'preflight.canary-control',
        checks: [canary.ipUrl, canary.dnsUrl].map((url) => ({
          url,
          status: 200,
          body: canary.body,
        })),
      });
    }
    if (args.at(-1)?.endsWith('-actor')) {
      actorStarted = true;
      return JSON.stringify({ type: 'preflight.actor-start' }) + '\n';
    }
    return '';
  }

  function observationKind(args: string[]) {
    if (args[0] === 'exec' && args.some((arg) => arg.includes('/stats'))) {
      return 'stats';
    }
    if (args[0] === 'logs' && actorStarted) {
      return args.at(-1)?.endsWith('-canary') ? 'canary' : 'gateway';
    }
    return '';
  }

  function observationCost(kind: string) {
    if (!kind) {
      return 0;
    }
    if (mode === 'normal' || kind === 'canary') {
      return 100;
    }
    return mode === 'exhausted' ? 2500 : 2400;
  }

  spyOn(performance, 'now').mockImplementation(() => now);
  // ログと削除は同期transport。時計と失敗注入を非同期statsと共有する。
  await mock.module('node:child_process', () => ({
    ...childProcess,
    spawnSync: (
      exe: string,
      args: string[],
      options: { timeout: number; encoding: string; maxBuffer?: number },
    ) => {
      assert.equal(exe, 'docker', '実Docker以外の同期起動を許可しない');
      const kind = observationKind(args);
      calls.push({ args, timeout: options.timeout, at: now, kind: kind || 'cleanup' });
      if (!kind) {
        assert(/^(rm -f |network rm )/.test(args.join(' ')));
        return { status: 0, signal: null, error: undefined, stdout: '', stderr: '' };
      }
      assert.equal(options.encoding, 'utf8');
      assert.equal(options.maxBuffer, 16777216);
      now += observationCost(kind);
      const failed = mode === 'gateway-failure' && kind === 'gateway';
      return {
        status: failed ? 1 : 0,
        signal: null,
        error: undefined,
        stdout: failed ? '' : '公開された合成終了ログ\n',
        stderr: failed ? '合成観測失敗' : '',
      };
    },
  }));
  await mock.module('../../scripts/shared/process.ts', () => ({
    assertRunning() {},
    command: async (
      argv: string[],
      _cwd: string,
      _input: string,
      timeout: number | null,
      prefix?: string,
    ) => {
      assert(argv[0] === 'docker', 'モデルなし経路でDocker以外を起動しない');
      const args = argv.slice(1);
      const kind = observationKind(args);
      calls.push({ args, timeout, at: now, kind });
      const cost = observationCost(kind);
      now += cost;
      const failed =
        (mode === 'stats-failure' && kind === 'stats') ||
        (mode === 'gateway-failure' && kind === 'gateway');
      const stdout = failed ? '' : await reply(args);
      const result = {
        code: failed ? 1 : 0,
        stdout,
        stderr: failed ? '合成観測失敗' : '',
        timedOut: false,
        ms: cost,
      };
      if (prefix) {
        await writeFile(`${prefix}.stdout`, result.stdout);
        await writeFile(`${prefix}.stderr`, result.stderr);
        await writeFile(`${prefix}.json`, JSON.stringify({ ...result, signal: null, error: null }));
      }
      return result;
    },
  }));

  let result: unknown;
  let error: string | null = null;
  try {
    const sandbox: unknown = await import('../sandbox.ts');
    assert(isRecord(sandbox));
    const api: unknown = sandbox.sandboxPreflightTrial;
    assert(typeof api === 'function', 'sandboxPreflightTrialの接続が未実装');
    result = await Reflect.apply(api, undefined, [
      evalConfig.parse({
        repository: 'thkt/dotagents',
        issue: 'https://github.com/thkt/dotagents/issues/401',
        before: 'a'.repeat(40),
        after: 'b'.repeat(40),
        corpusCommit: 'c'.repeat(40),
        workspaceCommit: 'a'.repeat(40),
        workspaceFiles: ['README.md'],
        instructionFiles: ['AGENTS.md', 'skills/scoping/SKILL.md', 'skills/implement/SKILL.md'],
        cases: ['positive'],
        imageReview: '公開された合成環境の模擬検証',
        caseTimeMs: 120000,
        totalTimeMs: 1200000,
        maxTrials: 2,
        outputDirectory: root,
        disclosure: {
          inputs: 'reviewed-public-committed-files-only',
          raw: 'local-only',
          summary: 'manual-issue-or-pr',
        },
        image: `public/eval@sha256:${'d'.repeat(64)}`,
        model: 'example-model',
        reasoning: 'high',
        cliVersion: 'codex-cli 0.163.0',
        bunVersion: '1.4.3',
        gitVersion: 'git version 2.39.5',
        maxModelRequestsPerCase: 4,
        maxOutputTokens: 8000,
      }),
      runtime,
      input,
      Date.now() + 120000,
    ]);
  } catch (failure) {
    error = failure instanceof Error ? failure.message : String(failure);
  }
  const safetyPath = join(root, 'safety.json');
  const safety = await readFile(safetyPath, 'utf8')
    .then((text): unknown => JSON.parse(text))
    .catch(() => null);
  const savedLogs: Record<string, unknown> = {};
  for (const name of ['gateway-logs', 'canary-logs']) {
    savedLogs[name] = await readFile(join(root, `${name}.json`), 'utf8')
      .then((text): unknown => JSON.parse(text))
      .catch(() => null);
  }
  await writeFile(
    join(root, 'observation.json'),
    JSON.stringify({ calls, controls, actorStarted, result, error, safety, savedLogs }),
  );
}

if (import.meta.main) {
  await runWorker();
}
