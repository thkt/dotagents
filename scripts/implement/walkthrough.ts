import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';

const text = z.string().min(1).regex(/\S/);
const path = text.refine(
  (value) =>
    !isAbsolute(value) &&
    !value.includes('\0') &&
    value
      .split('/')
      .every((part) => part !== '' && part !== '.' && part !== '..' && part !== '.git'),
  'リポジトリ相対パスが必要です',
);
const identity = z.string().regex(/^[a-f0-9]{64}$/);
const location = z
  .strictObject({
    path,
    start: z.number().int().positive(),
    end: z.number().int().positive(),
  })
  .refine((value) => value.end >= value.start);
export const walkthroughSteps = z
  .array(
    z.strictObject({
      title: text,
      intent: text,
      rationale: text,
      code: z.array(location).min(1),
      evidence: z.array(text).min(1),
      limitations: z.array(text),
    }),
  )
  .min(1);
const savedFile = z.strictObject({ path, sha256: identity, content: z.string() });
export const savedWalkthrough = z.strictObject({
  targetId: identity,
  source: identity,
  files: z.array(savedFile).min(1),
});
export type WalkthroughSteps = z.infer<typeof walkthroughSteps>;
export type SavedWalkthrough = z.infer<typeof savedWalkthrough>;
const hash = (content: string | Buffer) => createHash('sha256').update(content).digest('hex');

export function validateWalkthrough(
  steps: WalkthroughSteps,
  saved: SavedWalkthrough,
  files: [string, number, string][],
) {
  assert(
    new Set(saved.files.map((file) => file.path)).size === saved.files.length,
    'ウォークスルーのファイルが重複しています',
  );
  const linesByPath = new Map<string, string[]>();
  for (const file of saved.files) {
    const target = files.find(([path]) => path === file.path);
    assert(
      target && (target[1] & 0o170000) === 0o100000,
      'ウォークスルーの参照は評価対象の通常ファイルである必要があります',
    );
    assert(
      file.sha256 === target[2] && hash(file.content) === file.sha256,
      'ウォークスルーのファイル識別値が一致しません',
    );
    linesByPath.set(file.path, file.content.split('\n'));
  }
  for (const step of steps) {
    for (const ref of step.code) {
      const lines = linesByPath.get(ref.path);
      assert(lines && ref.end <= lines.length, 'ウォークスルーのコード行範囲を確認できません');
    }
  }
  return linesByPath;
}

export async function preserveWalkthrough(
  cwd: string,
  targetId: string,
  source: string,
  files: [string, number, string][],
  steps: WalkthroughSteps | undefined,
): Promise<SavedWalkthrough | undefined> {
  if (!steps) {
    return undefined;
  }
  const paths = new Set(steps.flatMap((step) => step.code.map((ref) => ref.path)));
  const saved: SavedWalkthrough = { targetId, source, files: [] };
  for (const path of paths) {
    const target = files.find(([name]) => name === path);
    assert(
      target && (target[1] & 0o170000) === 0o100000,
      'ウォークスルーの参照は評価対象の通常ファイルである必要があります',
    );
    const filename = resolve(cwd, path);
    assert(
      (await lstat(filename)).isFile(),
      'ウォークスルーのコードは通常ファイルである必要があります',
    );
    const bytes = await readFile(filename);
    const content = bytes.toString('utf8');
    assert(
      Buffer.from(content).equals(bytes),
      'ウォークスルーのコードはUTF-8の文章である必要があります',
    );
    saved.files.push({ path, sha256: target[2], content });
  }
  validateWalkthrough(steps, saved, files);
  return saved;
}
