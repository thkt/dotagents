import { plugin } from 'bun';
import { afterAll } from 'bun:test';
import { appendFileSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join } from 'node:path';

// Bun 1.4.4のplugin()で読み込むモジュールをテストごとに記録します。
// onLoadはundefined返却を拒否するため、コードをUTF-8文字列とloaderで返します。
// JSON/TOMLは既定のloaderを使い、onResolveと完了時のキャッシュから記録します。

export const recorderPath = import.meta.path;

export const recordDirVariable = 'DOTAGENTS_RECORD_DIR';
// テストファイルを起動した側が決めた持ち主です。子のbunは環境変数で引き継ぎます。
export const recordOwnerVariable = 'DOTAGENTS_RECORD_TEST';

export const testFilePattern = /[._](?:test|spec)\.[cm]?[jt]sx?$/;
const recordedPattern = /^(?!.*[\\/]node_modules[\\/]).*\.(?:[cm]?[jt]sx?)$/;
const loaders = new Map<string, Bun.Loader>([
  ['ts', 'ts'],
  ['mts', 'ts'],
  ['cts', 'ts'],
  ['tsx', 'tsx'],
  ['js', 'js'],
  ['mjs', 'js'],
  ['cjs', 'js'],
  ['jsx', 'jsx'],
]);

export function recorderEnv(
  env: NodeJS.ProcessEnv,
  recordDir: string,
  preloadPath: string = recorderPath,
): NodeJS.ProcessEnv {
  if (/\s/.test(preloadPath)) {
    throw new Error(
      `BUN_OPTIONS cannot carry a recorder path with whitespace / 空白を含む記録器のパスは渡せません: ${preloadPath}`,
    );
  }
  const preload = `--preload=${preloadPath}`;
  const options = (env.BUN_OPTIONS ?? '').split(/\s+/).filter(Boolean);
  const next: NodeJS.ProcessEnv = {
    ...env,
    BUN_OPTIONS: [...options.filter((o) => o !== preload), preload].join(' '),
    [recordDirVariable]: recordDir,
  };
  delete next[recordOwnerVariable];
  return next;
}

export async function readRecords(recordDir: string): Promise<Map<string, Set<string>>> {
  const records = new Map<string, Set<string>>();
  for (const name of readdirSync(recordDir)) {
    if (!name.endsWith('.jsonl')) {
      continue;
    }
    const lines = readFileSync(join(recordDir, name), 'utf8').split('\n').filter(Boolean);
    for (const line of lines) {
      const entry: unknown = JSON.parse(line);
      const pair: unknown[] = Array.isArray(entry) && entry.length === 2 ? entry : [];
      const [owner, module] = pair;
      if (typeof owner !== 'string' || typeof module !== 'string') {
        throw new Error(`Invalid record line in ${join(recordDir, name)}: ${line}`);
      }
      const modules = records.get(owner) ?? new Set<string>();
      modules.add(module);
      records.set(owner, modules);
    }
  }
  return records;
}

function register(recordDir: string) {
  mkdirSync(recordDir, { recursive: true });
  // 後からテストがnode:fsをmockしても、記録器の読み書きを製品のI/O観測へ混ぜません。
  const readModule = readFileSync;
  const appendRecord = appendFileSync;
  // 起動したテストファイルが決めた持ち主を子のbunが受け取った場合は、子が読むテストファイルで持ち主を変えません。
  const inherited = process.env[recordOwnerVariable];
  const recordFile = join(recordDir, `${process.pid}.jsonl`);
  const written = new Set<string>();
  let owner = inherited;

  const record = (path: string) => {
    if (owner !== undefined && isAbsolute(path) && !path.split(/[\\/]/).includes('node_modules')) {
      const line = JSON.stringify([owner, path]);
      if (!written.has(line)) {
        written.add(line);
        appendRecord(recordFile, `${line}\n`);
      }
    }
  };

  // Bun 1.4.4の省略JSON importはonResolveを通らないため、読み込み済みのパスを補います。
  const recordCachedData = () => {
    for (const path of Object.keys(createRequire(import.meta.url).cache)) {
      if (/\.(?:json|toml)$/.test(path)) {
        record(path);
      }
    }
  };
  try {
    afterAll(recordCachedData);
  } catch (error) {
    // 同じpreloadを使う通常の子Bunにはテストのライフサイクルがありません。
    if (
      !(error instanceof Error) ||
      !error.message.startsWith('Cannot use afterAll() outside of the test runner.')
    ) {
      throw error;
    }
    process.on('exit', recordCachedData);
  }

  let resolvingData = false;
  plugin({
    name: 'record-modules',
    setup(build) {
      // データはBun既定のloaderで読みます。1.4.4のonLoadはJSONのcontentsを解釈できません。
      build.onResolve({ filter: /\.(?:json|toml)$/ }, (args) => {
        // resolveSyncもこのcallbackを通るため、再入時は既定の解決へ渡します。
        if (resolvingData) {
          return;
        }
        resolvingData = true;
        try {
          const path = Bun.resolveSync(args.path, dirname(args.importer));
          record(path);
          return { path };
        } finally {
          resolvingData = false;
        }
      });
      build.onLoad({ filter: recordedPattern }, (args) => {
        const path = args.path;
        if (inherited === undefined && testFilePattern.test(path)) {
          owner = path;
          process.env[recordOwnerVariable] = path;
        }
        record(path);
        const loader = loaders.get(path.slice(path.lastIndexOf('.') + 1));
        if (loader === undefined) {
          throw new Error(`No loader for recorded module: ${path}`);
        }
        return { contents: readModule(path, 'utf8'), loader };
      });
    },
  });
}

const activeRecordDir = process.env[recordDirVariable];
if (activeRecordDir !== undefined && activeRecordDir !== '') {
  register(activeRecordDir);
}
