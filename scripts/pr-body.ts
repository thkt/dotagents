import assert from 'node:assert/strict';
import type { Review } from './review.ts';

// Select public facts from the accepted assessment, never the internal summary/history.
// Replace path tokens, not the surrounding finding, limitation or required action.
function publicText(value: string, localRoots: string[]) {
  // Do not infer Japanese prose adjacent to a log filename to be part of that filename.
  const suffix = /[A-Za-z0-9_./\\:@%+~=-]*/.source;
  for (const root of [...localRoots].sort((a, b) => b.length - a.length)) {
    const escaped = root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    value = value.replace(
      new RegExp(`(?<![\\w/:])${escaped}(?![\\w.-])${suffix}`, 'g'),
      '（内部パス省略）',
    );
  }
  // Directory names alone cannot distinguish public routes from filesystem paths.
  // Outside the known roots, redact only explicit filesystem notation.
  return value.replace(
    new RegExp(`(?<![\\w/:])(?:file:///|~/|[A-Za-z]:\\\\)${suffix}`, 'g'),
    '（内部パス省略）',
  );
}

export function prBody(input: {
  review: Review | undefined;
  repository: string;
  number: string;
  commit: string;
  check: string[];
  ciChecks: string[];
  media: string[];
  localRoots: string[];
}) {
  const { review, repository, number, commit, check, ciChecks, media } = input;
  assert(review?.status === 'accepted', 'Public PR description requires an accepted review');
  const text = (value: string) => publicText(value, input.localRoots);
  const sections = [
    `Closes #${number}`,
    '## 変更と理由',
    text(review.assessments.code),
    '## 要求との対応',
    text(review.assessments.requirements),
    '## 検証と未確認事項',
    `対象commit: ${commit}`,
    `CLI: 検証済み成果物との同一性を照合。ローカルcheck（${text(JSON.stringify(check))}）成功。独立評価: accepted。`,
    text(review.assessments.tests),
    ...(review.items.length ? ['## 指摘への対応'] : []),
    ...review.items.map((item) =>
      item.disposition === 'open'
        ? `- ${item.kind} / open: ${text(item.condition)} 影響: ${text(item.impact)} 判断・対応: ${text(item.reason)} 必要な対応: ${text(item.action)}`
        : `- ${item.kind} / ${item.disposition}: ${text(item.reason)}`,
    ),
    '## 文書と根拠',
    text(review.assessments.documentation),
    ...review.documents.map(
      (doc) =>
        `- [${doc.path}](https://github.com/${repository}/blob/${commit}/${doc.path.split('/').map(encodeURIComponent).join('/')}) (${doc.role}): ${text(doc.reason)}`,
    ),
    '## 残作業と担当',
    '本文作成時点ではdraft公開・CI・本文と媒体の確認・ready切替・人の承認は未完了です。詳細は[公開後確認とreadyへの切替](https://github.com/thkt/dotagents/blob/main/scripts/README.md#公開後確認とreadyへの切替)を参照してください。',
    `- CLI: PRをdraftで公開し、同じheadのCI（${ciChecks.join('・')}）の登録と成功を確認する。`,
    ...(media.length
      ? [
          `- CLI: 対象commitの媒体を添付する（${media.join('、')}）。`,
          '- 担当AI: 添付後の実際のPR画面で媒体の表示・再生と説明・配置を確認する（rendered_media_check）。',
        ]
      : []),
    ...review.handoff.map((action) => `- ${text(action)}`),
    '- 担当AI: 最新の公開本文をIssue・対象commit・accepted評価・検証結果と照合する（published_body_check）。本文・必要媒体と同じheadのCIの確認後、ガイドに従い再照合・ready切替・読戻しを行う（mark_ready）。未確認ならdraftを維持する。',
    '- 人: 要求や権限の変更を判断し、レビュー・承認・マージを判断する。',
  ];
  return sections.join('\n\n') + '\n';
}
