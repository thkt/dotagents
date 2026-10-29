import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { classification, object, readConfig } from './config.ts';

function stringMap(value: unknown): Record<string, string> {
  object(value);
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    assert(typeof item === 'string', `${key}は文字列で指定してください`);
    result[key] = item;
  }
  return result;
}

function inspect(root: string) {
  const pkg: unknown = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  object(pkg);
  const scripts = stringMap(pkg.scripts ?? {});
  const devDependencies = stringMap(pkg.devDependencies ?? {});
  const dependencies = stringMap(pkg.dependencies ?? {});
  const hints = new Set<string>();
  if (typeof pkg.packageManager === 'string') {
    hints.add(pkg.packageManager.split('@')[0] ?? 'unknown');
  }
  for (const [path, manager] of [
    ['bun.lock', 'bun'],
    ['bun.lockb', 'bun'],
    ['package-lock.json', 'npm'],
    ['yarn.lock', 'unknown'],
    ['pnpm-lock.yaml', 'unknown'],
  ]) {
    if (path && manager && existsSync(join(root, path))) {
      hints.add(manager);
    }
  }
  const first = [...hints][0];
  const packageManager = hints.size === 1 && (first === 'bun' || first === 'npm') ? first : null;
  const configFiles = readdirSync(root, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        /(?:config|lock|mise|bunfig|dotagents|feedback-loop|eslint|prettier|biome|fallow|tsconfig)/.test(
          entry.name,
        ),
    )
    .map((entry) => entry.name);
  const workflow = join(root, '.github/workflows');
  if (existsSync(workflow)) {
    configFiles.push(...readdirSync(workflow).map((name) => `.github/workflows/${name}`));
  }
  return {
    packageManager,
    scripts,
    devDependencies,
    dependencies,
    configFiles: configFiles.sort(),
    runtime: pkg.engines ?? pkg.packageManager ?? null,
    tools: Object.keys({ ...dependencies, ...devDependencies }).filter((name) =>
      /eslint|prettier|biome|oxlint|oxfmt|fallow|typescript|vitest/.test(name),
    ),
    diagnostics: packageManager ? [] : ['package managerが未指定、競合、または未対応です'],
    pkg,
  };
}

function install(root: string, inspected: ReturnType<typeof inspect>, packages: string[]) {
  assert(inspected.packageManager, 'package managerを選択できません');
  assert(packages.length > 0, '--package NAME@固定版を指定してください');
  const missing: string[] = [];
  const requested = new Map<string, string>();
  for (const spec of packages) {
    const match = /^(oxlint|oxfmt|fallow)@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(spec);
    assert(match, `自動導入はoxlint・oxfmt・fallowの固定版だけに対応します: ${spec}`);
    const [, name = '', version] = match;
    assert(version);
    assert(
      !requested.has(name) || requested.get(name) === version,
      `複数の版が指定されています: ${name}`,
    );
    requested.set(name, version);
    const current = inspected.devDependencies[name] ?? inspected.dependencies[name];
    assert(
      current === undefined || current === version,
      `既存版を置換しません: ${name}=${current}`,
    );
    if (current === undefined && !missing.includes(spec)) {
      missing.push(spec);
    }
  }
  if (missing.length === 0) {
    console.log('指定した固定版は導入済みです。変更しません');
    return;
  }
  const args =
    inspected.packageManager === 'bun'
      ? ['add', '--dev', '--exact', ...missing]
      : ['install', '--save-dev', '--save-exact', ...missing];
  console.log(`導入: ${inspected.packageManager} ${args.join(' ')}`);
  const result = spawnSync(inspected.packageManager, args, { cwd: root, stdio: 'inherit' });
  assert(
    !result.error && result.status === 0,
    `依存導入未完了: ${missing.join(', ')}; ${String(result.error ?? result.signal ?? result.status)}。部分変更を保持しています。package.jsonとlockfileを確認してください`,
  );
  const after = inspect(root);
  assert(
    missing.every((spec) => {
      const [name = '', version] = spec.split('@');
      return after.devDependencies[name] === version;
    }),
    '導入後のdevDependenciesが指定した固定版と一致しません',
  );
}

async function apply(
  root: string,
  inspected: ReturnType<typeof inspect>,
  feedback: string | undefined,
) {
  assert(inspected.packageManager, 'package managerを選択できません');
  assert(feedback?.trim(), '--feedback-commandに診断用コマンドを指定してください');
  const config = readConfig(root);
  classification(root, config);
  const target = join(root, '.dotagents.json');
  const dotagents: unknown = JSON.parse(readFileSync(target, 'utf8'));
  object(dotagents);
  let runtime = { bun: 'bun', vitest: 'node' }[config.runner];
  if (config.bunArgs.includes('--no-env-file')) {
    runtime += ' --no-env-file';
  }
  const commands = {
    'test:affected': `${runtime} scripts/feedback-loop/runtime.mjs affected`,
    'check:classification': `${runtime} scripts/feedback-loop/runtime.mjs classification`,
    'check:feedback': feedback,
  };
  for (const [name, command] of Object.entries(commands)) {
    assert(
      inspected.scripts[name] === undefined || inspected.scripts[name] === command,
      `既存コマンドと衝突しています: ${name}`,
    );
  }
  const feedbackCheck = [inspected.packageManager, 'run', 'check:feedback'];
  assert(
    dotagents.feedbackCheck === undefined ||
      JSON.stringify(dotagents.feedbackCheck) === JSON.stringify(feedbackCheck) ||
      dotagents.feedbackCheck === feedbackCheck.join(' '),
    '既存feedbackCheckと衝突しています',
  );
  const cwd = process.cwd();
  let build;
  try {
    process.chdir(resolve(import.meta.dir, '../..'));
    build = await Bun.build({
      entrypoints: [join(import.meta.dir, 'runtime.ts')],
      target: 'node',
      format: 'esm',
      minify: false,
    });
  } finally {
    process.chdir(cwd);
  }
  assert(
    build.success,
    `補助ファイルの生成に失敗しました: ${build.logs.map((log) => log.message).join('\n')}`,
  );
  assert(build.outputs[0]);
  const generated = new Map([
    [
      'scripts/feedback-loop/runtime.mjs',
      '// 生成元: thkt/dotagents scripts/feedback-loop/setup.ts\n' +
        (await build.outputs[0].text()),
    ],
  ]);
  if (config.runner === 'bun') {
    generated.set(
      'scripts/feedback-loop/record-modules.ts',
      readFileSync(join(import.meta.dir, '../test-runtime/record-modules.ts'), 'utf8'),
    );
  }
  const source = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: resolve(import.meta.dir, '../..'),
    encoding: 'utf8',
  });
  assert(source.status === 0, '導入元の版を取得できません');
  generated.set(
    'scripts/feedback-loop/generated.json',
    JSON.stringify(
      {
        generator: 'thkt/dotagents/scripts/feedback-loop/setup.ts',
        commit: source.stdout.trim(),
        bun: Bun.version,
        sources: Object.fromEntries(
          [
            'setup.ts',
            'config.ts',
            'runtime.ts',
            'vitest.ts',
            '../test-runtime/affected.ts',
            '../test-runtime/affected-records.ts',
            '../test-runtime/report.ts',
            '../shared/values.ts',
          ].map((path) => [
            path,
            createHash('sha256')
              .update(readFileSync(join(import.meta.dir, path)))
              .digest('hex'),
          ]),
        ),
        files: Object.fromEntries(
          [...generated].map(([path, body]) => [
            path,
            createHash('sha256').update(body).digest('hex'),
          ]),
        ),
      },
      null,
      2,
    ) + '\n',
  );
  const updates = new Map<string, string>();
  for (const [path, body] of generated) {
    if (existsSync(join(root, path))) {
      assert(
        readFileSync(join(root, path), 'utf8') === body,
        `配置済みファイルと衝突しています: ${path}`,
      );
    } else {
      updates.set(path, body);
    }
  }
  const nextPackage = { ...inspected.pkg, scripts: { ...inspected.scripts, ...commands } };
  const nextDotagents = { ...dotagents, feedbackCheck: dotagents.feedbackCheck ?? feedbackCheck };
  if (JSON.stringify(nextPackage) !== JSON.stringify(inspected.pkg)) {
    updates.set('package.json', `${JSON.stringify(nextPackage, null, 2)}\n`);
  }
  if (JSON.stringify(nextDotagents) !== JSON.stringify(dotagents)) {
    updates.set('.dotagents.json', `${JSON.stringify(nextDotagents, null, 2)}\n`);
  }
  console.log(JSON.stringify({ scripts: commands, feedbackCheck }));
  for (const [path, body] of updates) {
    console.log(`配置: ${path}`);
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  console.log(
    '補助ファイルとfeedbackCheckを接続しました。静的検査・通常check・CIの接続と動作確認は導入担当が完了してください',
  );
}

try {
  const [operation, ...args] = process.argv.slice(2);
  let root: string | undefined, feedback: string | undefined;
  const packages: string[] = [];
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i],
      value = args[i + 1];
    assert(value, `${key}の値がありません`);
    if (key === '--repo') {
      assert(root === undefined, '--repoが重複しています');
      root = value;
    } else if (key === '--feedback-command') {
      assert(feedback === undefined, '--feedback-commandが重複しています');
      feedback = value;
    } else {
      assert(key === '--package', `未対応の引数: ${key}`);
      packages.push(value);
    }
  }
  assert(root && isAbsolute(root), '--repoにGit checkoutの絶対パスが必要です');
  const git = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: root, encoding: 'utf8' });
  assert(
    git.status === 0 && resolve(git.stdout.trim()) === resolve(root),
    '--repoはGit checkoutのルートを指定してください',
  );
  const inspected = inspect(root);
  if (operation === 'inspect') {
    const { pkg: _pkg, ...report } = inspected;
    console.log(JSON.stringify(report, null, 2));
  } else if (operation === 'install') {
    install(root, inspected, packages);
  } else {
    assert(operation === 'apply', '操作はinspect・install・applyです');
    await apply(root, inspected, feedback);
  }
} catch (error) {
  console.error(
    `setup-feedback-loop未完了: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
}
