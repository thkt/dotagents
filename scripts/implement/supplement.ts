import assert from 'node:assert/strict';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { fixedSupplementShape, supplementShape } from './human-decision-schema.ts';
import type { FixedSupplement } from './human-decision-schema.ts';
import { hash } from './record-observation.ts';

export async function readSupplement(file: string, issue: string, original: string) {
  assert((await lstat(file)).isFile(), '補足合意は通常ファイルで指定してください');
  const path = await realpath(file);
  const content = await readFile(path);
  const agreement = supplementShape.parse(JSON.parse(content.toString('utf8')));
  const saved: unknown = JSON.parse(original);
  assert(typeof saved === 'object' && saved !== null && 'updatedAt' in saved);
  assert(
    agreement.issue === issue &&
      agreement.issueUpdatedAt === saved.updatedAt &&
      agreement.issueSha256 === hash(original),
    '補足合意の対象Issue・版が一致しません',
  );
  return { path, sha256: hash(content), agreement };
}

export async function observeSupplement(path: string) {
  assert((await lstat(path)).isFile(), '補足合意の種別が変わりました');
  const content = await readFile(path);
  return {
    sha256: hash(content),
    agreement: supplementShape.parse(JSON.parse(content.toString('utf8'))),
  };
}

export async function verifySupplement(
  input?: FixedSupplement,
  observed?: Awaited<ReturnType<typeof observeSupplement>>,
) {
  if (!input) {
    return;
  }
  fixedSupplementShape.parse(input);
  const actual = observed ?? (await observeSupplement(input.path));
  assert(
    actual.sha256 === input.sha256 &&
      JSON.stringify(actual.agreement) === JSON.stringify(input.agreement),
    '固定した補足合意が変わりました',
  );
}

export function supplementContext(input?: FixedSupplement) {
  return input
    ? `人が採用した固定の補足合意: ${JSON.stringify(input.agreement)}\n元のIssueを保持し、この対象Issueと版へだけ適用してください。hash一致は内容の同一性であり、人の承認の証明ではありません。適用範囲や出典を照合できなければ停止してください。`
    : '';
}
