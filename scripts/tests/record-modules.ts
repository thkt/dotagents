import { plugin } from 'bun';
import { appendFileSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

// Bun 1.4.4のplugin()のonLoad（https://bun.com/docs/runtime/plugins）で、読み込んだモジュールをテストファイルごとに記録します。
// 公式文書はonLoadの戻り値を説明しません。1.4.4はundefinedを返すと "onLoad() expects an object returned" で失敗するため、
// 対象の拡張子だけをcontentsとloaderを付けて返します。対象外の拡張子はBun既定の読み込みに任せ、記録しません。

export const recorderPath = import.meta.path;

export const recordDirVariable = 'DOTAGENTS_RECORD_DIR';
// テストファイルを起動した側が決めた持ち主です。子のbunは環境変数で引き継ぎます。
export const recordOwnerVariable = 'DOTAGENTS_RECORD_TEST';

export const testFilePattern = /[._](?:test|spec)\.[cm]?[jt]sx?$/;
const recordedPattern = /^(?!.*[\\/]node_modules[\\/]).*\.(?:[cm]?[jt]sx?|json|toml)$/;
const loaders = new Map<string, Bun.Loader>([
  ['ts', 'ts'],
  ['mts', 'ts'],
  ['cts', 'ts'],
  ['tsx', 'tsx'],
  ['js', 'js'],
  ['mjs', 'js'],
  ['cjs', 'js'],
  ['jsx', 'jsx'],
  ['json', 'json'],
  ['toml', 'toml'],
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
  // 起動したテストファイルが決めた持ち主を子のbunが受け取った場合は、子が読むテストファイルで持ち主を変えません。
  const inherited = process.env[recordOwnerVariable];
  const recordFile = join(recordDir, `${process.pid}.jsonl`);
  const written = new Set<string>();
  let owner = inherited;

  plugin({
    name: 'record-modules',
    setup(build) {
      build.onLoad({ filter: recordedPattern }, (args) => {
        const path = args.path;
        if (inherited === undefined && testFilePattern.test(path)) {
          owner = path;
          process.env[recordOwnerVariable] = path;
        }
        if (owner !== undefined && isAbsolute(path)) {
          const line = JSON.stringify([owner, path]);
          if (!written.has(line)) {
            written.add(line);
            appendFileSync(recordFile, `${line}\n`);
          }
        }
        const loader = loaders.get(path.slice(path.lastIndexOf('.') + 1));
        if (loader === undefined) {
          throw new Error(`No loader for recorded module: ${path}`);
        }
        return { contents: readFileSync(path), loader };
      });
    },
  });
}

const activeRecordDir = process.env[recordDirVariable];
if (activeRecordDir !== undefined && activeRecordDir !== '') {
  register(activeRecordDir);
}
