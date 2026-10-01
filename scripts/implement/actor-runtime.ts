import { constants } from 'node:fs';
import { access, lstat, readFile, readdir, realpath, stat } from 'node:fs/promises';
import { delimiter, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { spawn } from 'node:child_process';

function observation<T extends z.ZodType>(value: T) {
  return z.union([
    z.strictObject({ value, reason: z.null() }),
    z.strictObject({ value: z.null(), reason: z.string().trim().min(1) }),
  ]);
}
const text = observation(z.string().min(1));
const scope =
  'implement/shared direct *.ts + package.json + bun.lock; sorted path/mode/content SHA-256; regular files only';
export const runtimeShape = z.strictObject({
  cli: z.strictObject({ entry: text, realpath: text, version: text }),
  harness: z.strictObject({
    commit: text,
    trackedDirty: observation(z.boolean()),
    codeHash: text,
    scope: z.literal(scope),
  }),
});

const unavailable = (reason: string) => ({ value: null, reason });
const observed = <T>(value: T) => ({ value, reason: null });
function failure(error: unknown) {
  return unavailable(error instanceof Error ? error.message : String(error));
}

async function entry(cwd: string, env: NodeJS.ProcessEnv) {
  for (const part of (env.PATH ?? '').split(delimiter)) {
    const path = resolve(cwd, part, 'codex');
    try {
      await access(path, constants.X_OK);
      if ((await stat(path)).isFile()) {
        return observed(path);
      }
    } catch {
      // symlinkの参照先へ置き換えず、PATH検索を続けます。
    }
  }
  return unavailable('executable codex not found in PATH');
}

type TextObservation = { value: string; reason: null } | { value: null; reason: string };

function stopObservation(pid: number | undefined) {
  if (pid === undefined) {
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) {
      throw error;
    }
  }
}

async function output(
  argv: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<TextObservation> {
  try {
    return await new Promise<TextObservation>((done) => {
      const [executable, ...args] = argv;
      if (!executable) {
        throw Error('observation executable unavailable');
      }
      // 監視役がgroupを管理し、終了したwrapperの子孫も停止対象に含めます。
      // ホストがactorを強制停止した場合も、このgroupを回収します。
      const child = spawn(
        process.execPath,
        [join(import.meta.dir, 'actor-runtime.ts'), String(process.pid), executable, ...args],
        {
          cwd,
          env,
          detached: true,
          stdio: ['ignore', 'pipe', 'ignore'],
        },
      );
      let stdout = '',
        bytes = 0,
        settled = false;
      const finish = (result: TextObservation) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        try {
          stopObservation(child.pid);
          done(result);
        } catch (error) {
          done(failure(error));
        } finally {
          child.stdout.destroy();
        }
      };
      // wrapperの子孫がpipeを保持し得るため、closeを待たずに期限で停止します。
      const timer = setTimeout(() => finish(unavailable('timeout')), 2000);
      child.stdout.setEncoding('utf8').on('data', (data: string) => {
        bytes += Buffer.byteLength(data);
        if (bytes > 64 * 1024) {
          finish(unavailable('output exceeds 64 KiB'));
        } else {
          stdout += data;
        }
      });
      child.stdout.on('error', (error) => finish(failure(error)));
      child.on('error', (error) => finish(failure(error)));
      child.on('close', (code) =>
        finish(
          code !== 0
            ? unavailable(`exit code ${code}`)
            : stdout.trim()
              ? observed(stdout.trim())
              : unavailable('empty output'),
        ),
      );
    });
  } catch (error) {
    return failure(error);
  }
}

async function codeHash(root: string) {
  try {
    const paths = ['package.json', 'bun.lock'];
    for (const directory of ['scripts/implement', 'scripts/shared']) {
      for (const name of await readdir(join(root, directory))) {
        if (name.endsWith('.ts')) {
          paths.push(`${directory}/${name}`);
        }
      }
    }
    const manifest = [];
    for (const path of paths.sort()) {
      const info = await lstat(join(root, path));
      if (!info.isFile()) {
        throw Error(`not a regular file: ${path}`);
      }
      manifest.push({
        path,
        mode: info.mode & 0o777,
        sha256: createHash('sha256')
          .update(await readFile(join(root, path)))
          .digest('hex'),
      });
    }
    return observed(createHash('sha256').update(JSON.stringify(manifest)).digest('hex'));
  } catch (error) {
    return failure(error);
  }
}

export async function observeRuntime(
  cwd: string,
  env: NodeJS.ProcessEnv,
  harnessRoot = resolve(import.meta.dir, '../..'),
) {
  const launch = await entry(cwd, env);
  const resolved =
    launch.value === null
      ? unavailable('launch entry unavailable')
      : await realpath(launch.value).then(observed, failure);
  const version =
    launch.value === null
      ? unavailable('launch entry unavailable')
      : await output([launch.value, '--version'], cwd, env);
  // Git観測は対象checkoutではなく、ハーネスのrootに帰属します。
  // 継承したGit環境から別のHEADやindexを選ばないようにします。
  // CLI観測とexecには元の環境をそのまま渡します。
  const gitEnv = { ...env };
  for (const key of Object.keys(gitEnv)) {
    if (key.startsWith('GIT_')) {
      delete gitEnv[key];
    }
  }
  const top = await output(['git', 'rev-parse', '--show-toplevel'], harnessRoot, gitEnv);
  const belongs =
    top.value !== null &&
    (await realpath(top.value).catch(() => null)) ===
      (await realpath(harnessRoot).catch(() => null));
  const commit = belongs
    ? await output(['git', 'rev-parse', 'HEAD'], harnessRoot, gitEnv)
    : unavailable(top.reason ?? 'harness root is not a repository root');
  let trackedDirty: { value: boolean | null; reason: string | null } = unavailable(
    'harness repository unavailable',
  );
  if (belongs) {
    const result = await output(
      ['git', 'status', '--porcelain=v1', '--untracked-files=no'],
      harnessRoot,
      gitEnv,
    );
    trackedDirty =
      result.value !== null
        ? observed(true)
        : result.reason === 'empty output'
          ? observed(false)
          : result;
  }
  return {
    cli: { entry: launch, realpath: resolved, version },
    harness: { commit, trackedDirty, codeHash: await codeHash(harnessRoot), scope },
  };
}

function superviseObservation() {
  // 私的な監視役が観測groupのleaderとしてwrapper終了後も残り、
  // ホストがactorを強制停止した場合にgroupを回収します。
  const [ownerText, executable, ...args] = process.argv.slice(2);
  const owner = Number(ownerText);
  if (!executable || !Number.isInteger(owner) || owner <= 0) {
    throw Error('Observation owner and executable are required');
  }
  function stop() {
    process.kill(-process.pid, 'SIGKILL');
  }
  function ownerAlive() {
    try {
      process.kill(owner, 0);
      return true;
    } catch {
      return false;
    }
  }
  if (!ownerAlive()) {
    stop();
  }
  const watch = setInterval(() => {
    if (!ownerAlive()) {
      stop();
    }
  }, 50);
  const child = spawn(executable, args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  child.stdout.pipe(process.stdout);
  child.on('error', () => {
    clearInterval(watch);
    process.exit(1);
  });
  // CLIのwrapperが終了しても、子孫がstdoutを保持する間は監視役を残します。
  // actor側の期限に達したらgroup全体を停止します。
  child.on('close', (code) => {
    clearInterval(watch);
    process.exit(code ?? 1);
  });
}

if (import.meta.main) {
  superviseObservation();
}
