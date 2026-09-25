import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { command, assertRunning } from '../process.ts';
import type { EvalConfig } from './skill-eval-data.ts';
import { isRecord } from '../values.ts';

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
  if (input) {
    args.push('--mount', `type=bind,src=${input},dst=/input,readonly`);
  }
  if (role === 'gateway') {
    args.push('--env', 'OPENAI_API_KEY', '--sysctl', 'net.ipv4.ip_forward=0');
  }
  args.push(image, '/runtime/skill-eval-container.ts', role);
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

function verifyContainer(value: unknown, network: string, runtime: string, input: string) {
  assert(
    Array.isArray(value) && value.length === 1 && isRecord(value[0]),
    'Invalid container inspection',
  );
  const info = value[0];
  assert(isRecord(info.Config) && info.Config.User === '1000:1000', 'Unexpected container user');
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
    Array.isArray(host.SecurityOpt) && host.SecurityOpt.includes('no-new-privileges'),
    'Privilege escalation allowed',
  );
  assert(Array.isArray(info.Mounts), 'Missing mounts inspection');
  const mounts = info.Mounts.filter((mount: unknown) => isRecord(mount) && mount.Type === 'bind');
  assert(
    mounts.length === 2 &&
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
      Object.keys(info.NetworkSettings.Networks).join() === network,
    'Unexpected actor network',
  );
}

async function docker(args: string[], cwd: string, timeout = 30000, prefix?: string) {
  const result = await command(['docker', ...args], cwd, '', timeout, prefix);
  assert(result.code === 0 && !result.timedOut, `Docker operation failed: ${args[0]}`);
  return result.stdout;
}

function cleanup(names: string[], network: string) {
  // This path also runs after process.ts has latched an interrupt. Do not reset it.
  const containers = names.length
    ? spawnSync('docker', ['rm', '-f', ...names], {
        timeout: 30000,
        encoding: 'utf8',
      })
    : { status: 0 };
  const net = spawnSync('docker', ['network', 'rm', network], { timeout: 30000, encoding: 'utf8' });
  return { containersRemoved: containers.status === 0, networkRemoved: net.status === 0 };
}

export async function sandboxTrial(
  config: EvalConfig,
  runtime: string,
  input: string,
  expiresAt: number,
) {
  const id = `dotagents-eval-${randomUUID()}`;
  const gateway = `${id}-gateway`,
    probe = `${id}-probe`,
    actor = `${id}-actor`;
  const dir = resolve(runtime, '..');
  let launched = false;
  let execution = 'unevaluated';
  let reason = 'Isolation preflight incomplete';
  let versions: unknown = null;
  let usage: unknown = null;
  let safety = { containersRemoved: false, networkRemoved: false };
  let createdNetwork = false;
  const created: string[] = [];
  const remaining = () => {
    const value = expiresAt - Date.now();
    assert(value > 0, 'Time budget exhausted');
    return value;
  };
  const bounded = (args: string[], prefix?: string) =>
    docker(args, dir, Math.min(30000, remaining()), prefix);
  await writeFile(
    resolve(dir, 'containers.json'),
    JSON.stringify({ network: id, gateway, probe, actor }, null, 2),
  );
  try {
    assert(process.env.OPENAI_API_KEY, 'Host model authentication missing');
    verifyImage(JSON.parse(await bounded(['image', 'inspect', config.image])));
    createdNetwork = true;
    await bounded([
      'network',
      'create',
      '--internal',
      '--driver',
      'bridge',
      '--opt',
      'com.docker.network.bridge.gateway_mode_ipv4=isolated',
      id,
    ]);
    verifyNetwork(JSON.parse(await bounded(['network', 'inspect', id])));
    created.push(gateway);
    await bounded(containerArgs(gateway, config.image, 'bridge', runtime, 'gateway'));
    await bounded(['network', 'connect', '--alias', 'gateway', id, gateway]);
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
    await bounded(['start', gateway]);
    created.push(probe);
    await bounded(containerArgs(probe, config.image, id, runtime, 'probe', input));
    verifyContainer(JSON.parse(await bounded(['inspect', probe])), id, runtime, input);
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
    verifyContainer(JSON.parse(await bounded(['inspect', actor])), id, runtime, input);
    const actorTime = remaining();
    launched = true;
    // Docker's PID namespace owns descendants, including setsid children.
    const result = await command(
      ['docker', 'start', '-a', actor],
      dir,
      '',
      actorTime,
      resolve(dir, 'actor'),
    );
    const timedOut = result.timedOut || result.code === 124;
    execution = timedOut ? 'timeout' : result.code === 0 ? 'completed' : 'failed';
    reason = timedOut
      ? 'Wall time exhausted; container terminated'
      : result.code === 0
        ? 'Awaiting independent adjudication'
        : 'Actor failed; no retry';
    usage = await docker(
      [
        'exec',
        gateway,
        '/usr/local/bin/bun',
        '-e',
        `console.log(await (await fetch("http://${address}:8080/stats")).text())`,
      ],
      dir,
      5000,
    )
      .then((text): unknown => JSON.parse(text))
      .catch(() => null);
  } catch (error) {
    execution = launched ? 'failed' : 'unevaluated';
    reason = error instanceof Error ? error.message : 'Execution failed';
  } finally {
    safety = createdNetwork
      ? cleanup(created, id)
      : { containersRemoved: true, networkRemoved: true };
    await writeFile(resolve(dir, 'safety.json'), JSON.stringify(safety));
  }
  return {
    launched,
    execution,
    reason,
    versions,
    requests: usage,
    safety,
  };
}
