import assert from 'node:assert/strict';
import { lstat, readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { verifyInterruptedProcesses } from './interrupted-processes.ts';
import { isCommandArray, isRecord } from '../shared/values.ts';
import type { Reader } from '../shared/target.ts';
import { hash } from './record-observation.ts';
import { verifyGitLocks } from './git-locks.ts';

const path = z.string().min(1).refine(isAbsolute);
export const localPublicationShape = z.strictObject({
  kind: z.literal('adopted_local_publication'),
  previousRun: path,
  localCheckout: path,
  publishedCheckout: path,
  source: z.string().regex(/^[a-f0-9]{64}$/),
  head: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
  branch: z.string().min(1),
  url: z.string().url(),
  authorization: z.literal(true),
  records: z
    .array(
      z.strictObject({
        path,
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
        mode: z.number().int(),
      }),
    )
    .min(1),
});
export type LocalPublication = z.infer<typeof localPublicationShape>;

export async function verifyLocalPublication(
  input: LocalPublication | undefined,
  cwd: string,
  runDirectory: string,
  read: Reader,
) {
  if (!input) {
    return;
  }
  localPublicationShape.parse(input);
  assert(input.publishedCheckout === cwd, '採用した公開checkoutが一致しません');
  for (const ref of input.records) {
    const stat = await lstat(ref.path);
    assert(stat.isFile() && stat.mode === ref.mode, `旧原記録のmodeが変わりました: ${ref.path}`);
    assert(
      hash(await readFile(ref.path)) === ref.sha256,
      `旧原記録のhashが変わりました: ${ref.path}`,
    );
  }
  const locked = await lstat(`${input.previousRun}/verification/lock`).then(
    () => true,
    (error: unknown) => {
      assert(isRecord(error) && error.code === 'ENOENT', '旧runのlockを観測できません');
      return false;
    },
  );
  assert(!locked, '旧runに管理lockがあります');
  const config: unknown = JSON.parse(
    await readFile(`${input.previousRun}/verification-config.json`, 'utf8'),
  );
  assert(
    isRecord(config) && isCommandArray(config.review) && isCommandArray(config.check),
    '旧runの実行契約が不正です',
  );
  const processes = await read(['ps', '-axo', 'pid=,ppid=,lstart=,command='], cwd);
  await verifyInterruptedProcesses(processes, {
    previousRun: input.previousRun,
    runDirectory,
    review: config.review,
    check: config.check,
    entry: '--adopt-local-run',
  });
  await verifyGitLocks(input.localCheckout);
  await verifyGitLocks(cwd);
}
