import type { ReviewReport } from './input.ts';

// Host-only criteria: never add these answers to the reviewed checkout or prompt.
export function reviewTrial(
  provenance: 'live_model' | 'display_sample',
  broken: boolean,
): NonNullable<ReviewReport['trial']> {
  return {
    provenance,
    startedAt: null,
    finishedAt: null,
    question: broken
      ? '非zero offsetで件数が不足する既知の欠陥を、誤指摘なく具体的に検出できるか。'
      : '指定の要求を満たす正常例を、誤指摘なくレビューできるか。',
    criteria: `${
      broken
        ? '既知の欠陥を同じ対象で独立再現し、その欠陥への具体的な指摘を確認する。'
        : '独立した確認で指定の要求を満たすことを確認する。'
    } 誤指摘がなく、必要な指摘の裁定と証拠が揃うこと。同一原因の複数指摘を複数の欠陥検出とは数えない。未知の欠陥がないことや一般的な成功率は保証しない。`,
    judgment: {
      at: null,
      conclusion: null,
      reason: null,
      evidence: [],
      unmet: [],
      unconfirmed: ['ホストによる要求・同じ対象の再現・指摘の裁定の照合待ち。'],
    },
  };
}
