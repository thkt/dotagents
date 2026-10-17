import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { command, assertRunning } from '../scripts/shared/process.ts';
import type { EvalConfig } from './data.ts';
import { isRecord } from '../scripts/shared/values.ts';

export function containerArgs(
  name: string,
  image: string,
  network: string,
  runtime: string,
  role: string,
  input?: string,
) {
  const args = [
    'create',
    '--name',
    name,
    '--label',
    'dotagents.skill-eval=true',
    '--pull',
    'never',
    '--network',
    network,
    '--user',
    '1000:1000',
    '--read-only',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--pids-limit',
    '64',
    '--memory',
    '2g',
    '--cpus',
    '2',
    '--log-driver',
    'local',
    '--log-opt',
    'max-size=10m',
    '--log-opt',
    'max-file=1',
    '--log-opt',
    'compress=false',
    '--tmpfs',
    '/work:rw,nosuid,nodev,size=268435456,uid=1000,gid=1000',
    '--tmpfs',
    '/tmp:rw,nosuid,nodev,size=67108864,uid=1000,gid=1000',
    '--mount',
    `type=bind,src=${runtime},dst=/runtime,readonly`,
    '--workdir',
    '/work',
    '--entrypoint',
    '/usr/local/bin/bun',
  ];
  if (role !== 'gateway') {
    args.push('--dns', '127.0.0.1');
  }
  const preflightRole = ['preflight-gateway', 'preflight-canary', 'preflight-control'].includes(
    role,
  );
  if (preflightRole) {
    args.push('--sysctl', 'net.ipv4.ip_forward=0');
  }
  if (role === 'preflight-gateway') {
    args.push('--network-alias', 'gateway');
  }
  if (role === 'preflight-canary') {
    args.push('--network-alias', 'canary');
  }
  if (input) {
    args.push('--mount', `type=bind,src=${input},dst=/input,readonly`);
  }
  if (role === 'gateway') {
    args.push('--env', 'OPENAI_API_KEY', '--sysctl', 'net.ipv4.ip_forward=0');
  }
  args.push(
    image,
    preflightRole ? '/runtime/preflight-container.ts' : '/runtime/container.ts',
    role,
  );
  return args;
}

export function verifyNetwork(value: unknown) {
  assert(
    Array.isArray(value) && value.length === 1 && isRecord(value[0]),
    'Invalid isolation inspection',
  );
  const network = value[0];
  assert(
    network.Internal === true && network.EnableIPv6 === false && network.Driver === 'bridge',
    'Network is not isolated',
  );
  assert(
    isRecord(network.Options) &&
      network.Options['com.docker.network.bridge.gateway_mode_ipv4'] === 'isolated',
    'Host gateway is not isolated',
  );
}

export function verifyImage(value: unknown) {
  assert(
    Array.isArray(value) && value.length === 1 && isRecord(value[0]) && isRecord(value[0].Config),
    'Invalid image inspection',
  );
  const config = value[0].Config;
  assert(
    !config.Volumes || (isRecord(config.Volumes) && Object.keys(config.Volumes).length === 0),
    'Image declares unexpected volumes',
  );
  assert(
    Array.isArray(config.Env) &&
      config.Env.every(
        (entry: unknown) =>
          typeof entry === 'string' &&
          /^(PATH|LANG|LC_ALL|BUN_INSTALL|NODE_VERSION|BUN_VERSION|DEBIAN_FRONTEND)=/.test(entry),
      ),
    'Image environment is not clean',
  );
}

function verifyContainer(
  value: unknown,
  network: string,
  runtime: string,
  input: string | undefined,
  image: string,
  imageId: string,
  networks = [network],
) {
  assert(
    Array.isArray(value) && value.length === 1 && isRecord(value[0]),
    'Invalid container inspection',
  );
  const info = value[0];
  assert(isRecord(info.Config) && info.Config.User === '1000:1000', 'Unexpected container user');
  assert(info.Config.Image === image && info.Image === imageId, 'Unexpected container image');
  const host = info.HostConfig;
  assert(
    isRecord(host) &&
      host.ReadonlyRootfs === true &&
      host.Privileged === false &&
      host.NetworkMode === network &&
      !host.PidMode,
    'Unsafe container namespace',
  );
  assert(
    Array.isArray(host.CapDrop) &&
      host.CapDrop.includes('ALL') &&
      (!host.CapAdd || (Array.isArray(host.CapAdd) && host.CapAdd.length === 0)),
    'Unsafe container capabilities',
  );
  assert(
    Array.isArray(host.SecurityOpt) &&
      host.SecurityOpt.length === 1 &&
      host.SecurityOpt.includes('no-new-privileges'),
    'Privilege escalation allowed',
  );
  assert(
    host.Memory === 2147483648 && host.NanoCpus === 2000000000 && host.PidsLimit === 64,
    'Unexpected resource limits',
  );
  assert(
    isRecord(host.Tmpfs) &&
      Object.keys(host.Tmpfs).sort().join() === '/tmp,/work' &&
      host.Tmpfs['/work'] === 'rw,nosuid,nodev,size=268435456,uid=1000,gid=1000' &&
      host.Tmpfs['/tmp'] === 'rw,nosuid,nodev,size=67108864,uid=1000,gid=1000',
    'Unexpected temporary storage',
  );
  verifyLogging(host.LogConfig);
  verifyConnections(host, input !== undefined || networks.length === 1, input === undefined);
  assert(Array.isArray(info.Mounts), 'Missing mounts inspection');
  const mounts = info.Mounts.filter((mount: unknown) => isRecord(mount) && mount.Type === 'bind');
  assert(
    mounts.length === (input ? 2 : 1) &&
      mounts.every(
        (mount: unknown) =>
          isRecord(mount) &&
          mount.RW === false &&
          ((mount.Destination === '/input' && mount.Source === input) ||
            (mount.Destination === '/runtime' && mount.Source === runtime)),
      ),
    'Unsafe host mounts',
  );
  assert(
    info.Mounts.every(
      (mount: unknown) => isRecord(mount) && ['bind', 'tmpfs'].includes(String(mount.Type)),
    ),
    'Unexpected persistent mount',
  );
  assert(
    isRecord(info.NetworkSettings) &&
      isRecord(info.NetworkSettings.Networks) &&
      Object.keys(info.NetworkSettings.Networks).sort().join() === [...networks].sort().join(),
    'Unexpected container network',
  );
}

function verifyConnections(host: Record<string, unknown>, isolated: boolean, gateway: boolean) {
  assert(
    ['Devices', 'DeviceRequests', 'ExtraHosts', 'Links', 'VolumesFrom'].every(
      (key) => !host[key] || (Array.isArray(host[key]) && host[key].length === 0),
    ),
    'Unexpected host resources',
  );
  assert(!host.UTSMode && (!host.IpcMode || host.IpcMode === 'private'), 'Shared host namespaces');
  if (isolated) {
    assert(
      Array.isArray(host.Dns) && host.Dns.join() === '127.0.0.1',
      'External DNS forwarding enabled',
    );
  }
  if (gateway) {
    assert(
      isRecord(host.Sysctls) && host.Sysctls['net.ipv4.ip_forward'] === '0',
      'Gateway forwarding configuration differs',
    );
  }
}

function verifyLogging(value: unknown) {
  assert(
    isRecord(value) && value.Type === 'local' && isRecord(value.Config),
    'Unexpected log driver',
  );
  assert(
    value.Config['max-size'] === '10m' &&
      value.Config['max-file'] === '1' &&
      value.Config.compress === 'false',
    'Unexpected log retention',
  );
}

async function docker(args: string[], cwd: string, timeout = 30000, prefix?: string) {
  const result = await command(['docker', ...args], cwd, '', timeout, prefix);
  assert(result.code === 0 && !result.timedOut, `Docker operation failed: ${args[0]}`);
  return result.stdout;
}

function inspectionEvidence(output: string): unknown {
  try {
    const value: unknown = JSON.parse(output);
    if (Array.isArray(value)) {
      for (const item of value) {
        if (isRecord(item) && isRecord(item.Config) && Array.isArray(item.Config.Env)) {
          item.Config.Env = item.Config.Env.map((entry: unknown) =>
            typeof entry === 'string' ? `${entry.split('=')[0]}=<redacted>` : '<redacted>',
          );
        }
      }
    }
    return value;
  } catch {
    return output;
  }
}

async function saveGatewayLogs(name: string, dir: string, deadline: number, prefix: string) {
  // 割込みがlatchedでも、観測だけは有界に行い原記録を保存する。
  const timeout = Math.min(2500, Math.floor(deadline - performance.now()));
  // timeout: 0 は無期限になるため、予算切れでは起動せず失敗を記録する。
  const output =
    timeout > 0
      ? spawnSync('docker', ['logs', name], {
          timeout,
          encoding: 'utf8',
          maxBuffer: 16 * 1024 * 1024,
        })
      : {
          status: null,
          signal: null,
          error: new Error('Observation budget exhausted'),
          stdout: '',
          stderr: '',
        };
  await writeFile(resolve(dir, `${prefix}.stdout`), output.stdout ?? '');
  await writeFile(resolve(dir, `${prefix}.stderr`), output.stderr ?? '');
  await writeFile(
    resolve(dir, `${prefix}-logs.json`),
    JSON.stringify({ code: output.status, signal: output.signal, error: output.error?.message }),
  );
  assert(output.status === 0 && !output.signal && !output.error, 'Gateway logs unavailable');
}

function cleanup(names: string[], networks: string[]) {
  // This path also runs after process.ts has latched an interrupt. Do not reset it.
  const containers = names.length
    ? spawnSync('docker', ['rm', '-f', ...names], {
        timeout: 30000,
        encoding: 'utf8',
      })
    : { status: 0 };
  const net = networks.length
    ? spawnSync('docker', ['network', 'rm', ...networks], { timeout: 30000, encoding: 'utf8' })
    : { status: 0 };
  return { containersRemoved: containers.status === 0, networkRemoved: net.status === 0 };
}

async function finishSession(
  networks: string[],
  created: string[],
  gateway: string,
  dir: string,
  deadline = performance.now() + 5000,
) {
  let safety = { containersRemoved: false, networkRemoved: false };
  try {
    const server = created.find((name) => name.endsWith('-canary'));
    const failures: unknown[] = [];
    for (const [name, prefix] of [
      [gateway, 'gateway'],
      [server, 'canary'],
    ]) {
      if (name && prefix && created.includes(name)) {
        try {
          await saveGatewayLogs(name, dir, deadline, prefix);
        } catch (error) {
          failures.push(error);
        }
      }
    }
    assert(failures.length === 0, 'Gateway logs unavailable');
  } finally {
    // ログ保存の失敗でも所有資源の削除と終了記録を省略しない。
    safety = cleanup(created, networks);
    await writeFile(resolve(dir, 'safety.json'), JSON.stringify(safety));
  }
  return safety;
}

type BoundedDocker = (args: string[], prefix?: string) => Promise<string>;

interface Canary {
  network: string;
  server: string;
  control: string;
  ipUrl: string;
  dnsUrl: string;
  body: string;
  before: unknown;
}

async function isolatedNetwork(name: string, bounded: BoundedDocker) {
  await bounded([
    'network',
    'create',
    '--internal',
    '--driver',
    'bridge',
    '--opt',
    'com.docker.network.bridge.gateway_mode_ipv4=isolated',
    '--label',
    'dotagents.skill-eval=true',
    name,
  ]);
  verifyNetwork(JSON.parse(await bounded(['network', 'inspect', name])));
}

async function canaryDefinition(runtime: string) {
  const scenario: unknown = JSON.parse(await readFile(resolve(runtime, 'scenario.json'), 'utf8'));
  assert(isRecord(scenario), 'Missing preflight scenario');
  if (scenario.networkCanary === undefined) {
    return;
  }
  const value = scenario.networkCanary;
  assert(
    scenario.id === 'boundaries' &&
      isRecord(value) &&
      typeof value.path === 'string' &&
      /^\/[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(value.path) &&
      typeof value.body === 'string' &&
      value.body.length > 0,
    'Invalid network canary',
  );
  return { path: value.path, body: value.body };
}

async function canaryReady(server: string, bounded: BoundedDocker) {
  const end = Date.now() + 3000;
  while (Date.now() < end) {
    const output = await bounded(['logs', server]);
    if (
      output.split('\n').some((line) => {
        try {
          const value: unknown = JSON.parse(line);
          return isRecord(value) && value.type === 'preflight.canary-ready';
        } catch {
          return false;
        }
      })
    ) {
      return;
    }
    await new Promise<void>((done) => setTimeout(done, 25));
  }
  throw new Error('Canary listener not ready');
}

async function prepareCanary(context: {
  id: string;
  runtime: string;
  image: string;
  imageId: string;
  created: string[];
  networks: string[];
  bounded: BoundedDocker;
  dir: string;
}) {
  const definition = await canaryDefinition(context.runtime);
  if (!definition) {
    return;
  }
  const { id, runtime, image, imageId, created, networks, bounded, dir } = context;
  const network = `${id}-canary-net`,
    server = `${id}-canary`,
    control = `${id}-canary-control`;
  networks.push(network);
  await isolatedNetwork(network, bounded);
  created.push(server);
  await bounded(containerArgs(server, image, network, runtime, 'preflight-canary'));
  verifyContainer(
    JSON.parse(await bounded(['inspect', server])),
    network,
    runtime,
    undefined,
    image,
    imageId,
  );
  await bounded(['start', server]);
  await canaryReady(server, bounded);
  const info: unknown = JSON.parse(await bounded(['inspect', server]));
  verifyContainer(info, network, runtime, undefined, image, imageId);
  assert(
    Array.isArray(info) &&
      isRecord(info[0]) &&
      isRecord(info[0].State) &&
      info[0].State.Running === true &&
      isRecord(info[0].NetworkSettings) &&
      isRecord(info[0].NetworkSettings.Networks),
    'Canary not running',
  );
  const connection = info[0].NetworkSettings.Networks[network];
  assert(
    isRecord(connection) &&
      typeof connection.IPAddress === 'string' &&
      /^\d+\.\d+\.\d+\.\d+$/.test(connection.IPAddress),
    'Missing canary address',
  );
  const canary: Canary = {
    before: undefined,
    network,
    server,
    control,
    ipUrl: `http://${connection.IPAddress}:8081${definition.path}`,
    dnsUrl: `http://canary:8081${definition.path}`,
    body: definition.body,
  };
  const path = resolve(runtime, 'settings.json');
  const settings: unknown = JSON.parse(await readFile(path, 'utf8'));
  assert(isRecord(settings), 'Missing preflight settings');
  await writeFile(
    path,
    JSON.stringify({
      ...settings,
      networkCanary: { ipUrl: canary.ipUrl, dnsUrl: canary.dnsUrl, body: canary.body },
    }),
  );
  created.push(control);
  await bounded(containerArgs(control, image, network, runtime, 'preflight-control'));
  canary.before = await measureCanary(canary, runtime, image, imageId, bounded, dir, 'before');
  await writeFile(resolve(dir, 'network-canary.json'), JSON.stringify(canary));
  return canary;
}

async function measureCanary(
  canary: Canary,
  runtime: string,
  image: string,
  imageId: string,
  bounded: BoundedDocker,
  dir: string,
  stage: 'before' | 'after',
) {
  verifyContainer(
    JSON.parse(await bounded(['inspect', canary.control])),
    canary.network,
    runtime,
    undefined,
    image,
    imageId,
  );
  const output = await bounded(
    ['start', '-a', canary.control],
    resolve(dir, `canary-control-${stage}`),
  );
  const state = (
    await bounded([
      'inspect',
      '--format',
      '{{.State.Running}} {{.State.Pid}} {{.State.ExitCode}}',
      canary.control,
    ])
  ).trim();
  assert(state === 'false 0 0', 'Canary control termination unconfirmed');
  const value: unknown = JSON.parse(output);
  assert(
    isRecord(value) &&
      value.type === 'preflight.canary-control' &&
      Array.isArray(value.checks) &&
      value.checks.length === 2,
    'Invalid canary control output',
  );
  const expected = [canary.ipUrl, canary.dnsUrl];
  return value.checks.map((check: unknown, index: number) => {
    assert(
      isRecord(check) &&
        typeof check.url === 'string' &&
        check.url === expected[index] &&
        check.status === 200 &&
        check.body === canary.body,
      'Canary positive control failed',
    );
    return { url: check.url, status: check.status, body: check.body };
  });
}

function actorOutcome(result: { timedOut: boolean; code: number | null }) {
  if (result.timedOut || result.code === 124) {
    return { execution: 'timeout', reason: 'Wall time exhausted; container terminated' };
  }
  return result.code === 0
    ? { execution: 'completed', reason: 'Awaiting independent adjudication' }
    : { execution: 'failed', reason: 'Actor failed; no retry' };
}

async function sandboxSession(
  config: EvalConfig,
  runtime: string,
  input: string,
  expiresAt: number,
  preflight: boolean,
) {
  const id = `dotagents-eval-${randomUUID()}`;
  const gatewayMode = preflight
    ? { network: id, role: 'preflight-gateway', networks: [id] }
    : { network: 'bridge', role: 'gateway', networks: ['bridge', id] };
  const gateway = `${id}-gateway`,
    probe = `${id}-probe`,
    actor = `${id}-actor`;
  const dir = resolve(runtime, '..');
  let launched = false;
  let execution = 'unevaluated';
  let reason = 'Isolation preflight incomplete';
  let versions: unknown = null;
  let usage: unknown = null;
  let observationDeadline: number | undefined;
  let safety = { containersRemoved: false, networkRemoved: false };
  const networks: string[] = [];
  let canary: Canary | undefined;
  const created: string[] = [];
  const remaining = () => {
    const value = expiresAt - Date.now();
    assert(value > 0, 'Time budget exhausted');
    return value;
  };
  const inspections: unknown[] = [];
  const bounded = async (args: string[], prefix?: string) => {
    const output = await docker(args, dir, Math.min(30000, remaining()), prefix);
    if (args.includes('inspect')) {
      inspections.push({ argv: args, output: inspectionEvidence(output) });
      await writeFile(resolve(dir, 'inspections.json'), JSON.stringify(inspections, null, 2));
    }
    return output;
  };
  await writeFile(
    resolve(dir, 'containers.json'),
    JSON.stringify({ network: id, gateway, probe, actor }, null, 2),
  );
  try {
    assert(preflight || process.env.OPENAI_API_KEY, 'Host model authentication missing');
    const imageInfo: unknown = JSON.parse(await bounded(['image', 'inspect', config.image]));
    verifyImage(imageInfo);
    assert(
      Array.isArray(imageInfo) && isRecord(imageInfo[0]) && typeof imageInfo[0].Id === 'string',
      'Image identity missing',
    );
    const imageId = imageInfo[0].Id;
    networks.push(id);
    await isolatedNetwork(id, bounded);
    if (preflight) {
      canary = await prepareCanary({
        id,
        runtime,
        image: config.image,
        imageId,
        created,
        networks,
        bounded,
        dir,
      });
    }
    created.push(gateway);
    await bounded(
      containerArgs(gateway, config.image, gatewayMode.network, runtime, gatewayMode.role),
    );
    if (!preflight) {
      await bounded(['network', 'connect', '--alias', 'gateway', id, gateway]);
    }
    verifyContainer(
      JSON.parse(await bounded(['inspect', gateway])),
      gatewayMode.network,
      runtime,
      undefined,
      config.image,
      imageId,
      gatewayMode.networks,
    );
    await bounded(['start', gateway]);
    const address = (
      await bounded([
        'inspect',
        '--format',
        `{{(index .NetworkSettings.Networks "${id}").IPAddress}}`,
        gateway,
      ])
    ).trim();
    assert(/^\d+\.\d+\.\d+\.\d+$/.test(address), 'Missing isolated gateway address');
    const settingsPath = resolve(runtime, 'settings.json');
    const settings: unknown = JSON.parse(await readFile(settingsPath, 'utf8'));
    assert(isRecord(settings), 'Invalid actor settings');
    await writeFile(settingsPath, JSON.stringify({ ...settings, gatewayAddress: address }));
    verifyContainer(
      JSON.parse(await bounded(['inspect', gateway])),
      gatewayMode.network,
      runtime,
      undefined,
      config.image,
      imageId,
      gatewayMode.networks,
    );
    created.push(probe);
    await bounded(containerArgs(probe, config.image, id, runtime, 'probe', input));
    verifyContainer(
      JSON.parse(await bounded(['inspect', probe])),
      id,
      runtime,
      input,
      config.image,
      imageId,
    );
    const output = await docker(
      ['start', '-a', probe],
      dir,
      Math.min(30000, remaining()),
      resolve(dir, 'probe'),
    );
    const state = (
      await bounded([
        'inspect',
        '--format',
        '{{.State.Running}} {{.State.Pid}} {{.State.ExitCode}}',
        probe,
      ])
    ).trim();
    assert(state === 'false 0 0', 'Probe or detached child termination unconfirmed');
    versions = JSON.parse(output);
    assert(
      isRecord(versions) &&
        versions.cli === config.cliVersion &&
        versions.bun === config.bunVersion &&
        versions.git === config.gitVersion,
      'Effective tool versions differ from plan',
    );
    assertRunning();
    assert(remaining() > 1000, 'Time budget exhausted before launch');
    created.push(actor);
    await bounded(containerArgs(actor, config.image, id, runtime, 'actor', input));
    verifyContainer(
      JSON.parse(await bounded(['inspect', actor])),
      id,
      runtime,
      input,
      config.image,
      imageId,
    );
    const actorTime = remaining();
    launched = true;
    if (preflight) {
      console.log(JSON.stringify({ type: 'preflight.actor-start', actor }));
    }
    // Docker's PID namespace owns descendants, including setsid children.
    const result = await command(
      ['docker', 'start', '-a', actor],
      dir,
      '',
      actorTime,
      resolve(dir, 'actor'),
    );
    ({ execution, reason } = actorOutcome(result));
    if (canary) {
      const after = await measureCanary(
        canary,
        runtime,
        config.image,
        imageId,
        bounded,
        dir,
        'after',
      );
      await writeFile(resolve(dir, 'network-canary.json'), JSON.stringify({ ...canary, after }));
    }
    // statsと両ログのDocker待機は合計5秒、削除はコンテナー・network各30秒に制限する。
    observationDeadline = performance.now() + 5000;
    usage = await docker(
      [
        'exec',
        gateway,
        '/usr/local/bin/bun',
        '-e',
        `console.log(await (await fetch("http://${address}:8080/stats")).text())`,
      ],
      dir,
      2500,
    )
      .then((text): unknown => JSON.parse(text))
      .catch(() => null);
  } catch (error) {
    execution = launched ? 'failed' : 'unevaluated';
    reason = error instanceof Error ? error.message : 'Execution failed';
  } finally {
    safety = await finishSession(networks, created, gateway, dir, observationDeadline);
  }
  return {
    mode: preflight ? 'model-free-preflight' : 'evaluation',
    launched,
    execution,
    reason,
    versions,
    requests: usage,
    safety,
  };
}

// 本番中継はmockへ切り替えない。別entrypointを隔離網だけへ起動する。
export function sandboxTrial(
  config: EvalConfig,
  runtime: string,
  input: string,
  expiresAt: number,
) {
  return sandboxSession(config, runtime, input, expiresAt, false);
}

export function sandboxPreflightTrial(
  config: EvalConfig,
  runtime: string,
  input: string,
  expiresAt: number,
) {
  return sandboxSession(config, runtime, input, expiresAt, true);
}
