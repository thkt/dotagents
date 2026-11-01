import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { matches, object } from './config.ts';
import type { FeedbackConfig } from './config.ts';

type VitestAPI = {
  parseCLI: (args: string[]) => { options: Record<string, unknown> };
  createVitest: (
    mode: 'test',
    options: Record<string, unknown>,
  ) => Promise<{
    config: { related?: string[] };
    getRelevantTestSpecifications: () => Promise<{ moduleId: string }[]>;
    close: () => Promise<void>;
  }>;
};

function vitestAPI(value: unknown): asserts value is VitestAPI {
  object(value);
  assert(
    typeof value.parseCLI === 'function' && typeof value.createVitest === 'function',
    '導入版Vitestの公開収集APIを利用できません',
  );
}

// Vitest自身の依存グラフで変更ごとに確認し、到達先不明の入力を混在させない。
export async function selectVitest(
  root: string,
  config: FeedbackConfig,
  quality: string[],
  changed: string[],
  apiPath: string,
) {
  const relative = changed.map((path) => path.slice(root.length + 1));
  const global = [
    'package.json',
    'package-lock.json',
    'bun.lock',
    'bun.lockb',
    '.feedback-loop.json',
    '.dotagents.json',
    'scripts/feedback-loop/**',
    ...config.globalChanges,
  ];
  const reasons = relative.filter(
    (path) => global.some((glob) => matches(path, glob)) || !existsSync(join(root, path)),
  );
  const selected = new Set(quality.filter((path) => relative.includes(path)));
  const pending: string[] = [];
  for (const path of relative) {
    const mapped = config.dependencies.filter((entry) =>
      entry.inputs.some((glob) => matches(path, glob)),
    );
    if (mapped.length > 0) {
      mapped.forEach((entry) => entry.tests.forEach((test) => selected.add(test)));
    } else if (!quality.includes(path)) {
      pending.push(path);
    }
  }
  if (reasons.length === 0 && pending.length > 0) {
    const api: unknown = await import(pathToFileURL(apiPath).href);
    vitestAPI(api);
    const exclude = config.assurance.flatMap((entry) => ['--exclude', join(root, entry.path)]);
    const parsed = api.parseCLI([
      'vitest',
      'related',
      ...pending,
      ...config.testArgs,
      ...exclude,
      '--run',
    ]);
    const context = await api.createVitest('test', { ...parsed.options, watch: false });
    try {
      for (const path of pending) {
        context.config.related = [join(root, path)];
        const specs = await context.getRelevantTestSpecifications();
        const reached = specs
          .map((spec) => spec.moduleId.slice(root.length + 1))
          .filter((file) => quality.includes(file));
        if (reached.length === 0) {
          reasons.push(path);
        }
        reached.forEach((file) => selected.add(file));
      }
    } finally {
      await context.close();
    }
  }
  return {
    files: reasons.length > 0 ? quality : quality.filter((path) => selected.has(path)),
    reasons,
  };
}
