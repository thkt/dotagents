// ホスト側の独立した割込み対象。actorへホスト設定や証拠をmountしない。
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { withInterrupts } from '../scripts/shared/process.ts';
import { isRecord } from '../scripts/shared/values.ts';
import { evalConfig } from './data.ts';
import { sandboxPreflightTrial } from './sandbox.ts';

export const preflightWorkerEntrypoint = import.meta.path;

if (import.meta.main) {
  const dir = process.argv[2];
  assert(dir, 'Missing preflight directory');
  const config = evalConfig.parse(
    JSON.parse(await readFile(resolve(dir, 'host-config.json'), 'utf8')),
  );
  const settings: unknown = JSON.parse(
    await readFile(resolve(dir, 'runtime/settings.json'), 'utf8'),
  );
  assert(isRecord(settings) && typeof settings.expiresAt === 'number', 'Missing deadline');
  const expiresAt = settings.expiresAt;
  try {
    await withInterrupts(async () => {
      const result = await sandboxPreflightTrial(
        config,
        resolve(dir, 'runtime'),
        resolve(dir, 'input'),
        expiresAt,
      );
      await writeFile(resolve(dir, 'session.json'), JSON.stringify(result, null, 2));
    });
  } catch (cause) {
    console.error(cause instanceof Error ? cause.message : 'Interrupted preflight');
    process.exitCode = 1;
  }
}
