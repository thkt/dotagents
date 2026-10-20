import assert from 'node:assert/strict';
import { z } from 'zod';
import { inputConfig } from './data.ts';

const lightOrders = [
  [
    'before-storage-fields',
    'after-storage-fields',
    'after-completion-message',
    'before-completion-message',
  ],
  [
    'before-retry-limit',
    'after-retry-limit',
    'after-guide-link',
    'before-guide-link',
    'before-work-area',
    'after-work-area',
    'after-cli-description',
    'before-cli-description',
    'before-history-record',
    'after-history-record',
    'after-save-diagnostics',
    'before-save-diagnostics',
  ],
];
export const lightConfig = inputConfig
  .extend({
    authentication: z.literal('chatgpt'),
    stage: z.union([z.literal(1), z.literal(2)]),
    permissionProfile: z.literal('eval-light'),
    boundaryEvidence: z.string().min(1).optional(),
    cliExecutable: z.string().startsWith('/').optional(),
  })
  .superRefine((config, context) => {
    const order = lightOrders[config.stage - 1];
    assert(order);
    const cases = [...new Set(order.map((id) => id.replace(/^(before|after)-/, '')))];
    const valid =
      JSON.stringify(order) === JSON.stringify(config.trialOrder) &&
      JSON.stringify(cases) === JSON.stringify(config.cases) &&
      config.maxTrials === order.length &&
      config.caseTimeMs <= 600000 &&
      config.totalTimeMs <= (config.stage === 1 ? 2400000 : 7200000) &&
      config.before === 'fd28ac54d7d089f494d8d7be7ffe15bb8b5c8092' &&
      config.after === '6181233d17a29c711a84f20549f78507c5c3e5fb' &&
      config.corpusCommit === '0c7316253a9768844eb1c224961e00be52dcdcf2' &&
      config.workspaceCommit === config.corpusCommit &&
      config.model === 'gpt-6.1-sol' &&
      config.reasoning === 'medium' &&
      config.bunVersion === '1.4.3' &&
      config.workspaceFiles.every((path) => path.startsWith('eval/fixtures/workspace/'));
    if (!valid) {
      context.addIssue({
        code: 'custom',
        message: 'Issue #409の固定入力・段階・順序・上限と一致しません',
      });
    }
  });
export type LightConfig = z.infer<typeof lightConfig>;

export function requireChatGPTAuthentication(result: {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}) {
  const text = `${result.stdout}\n${result.stderr}`.trim();
  assert(
    !result.timedOut && result.code === 0 && text === 'Logged in using ChatGPT',
    'ChatGPT認証を確認できません。推論は開始しません。ログインとアカウント選択は人の操作です。',
  );
}

// 子の起動hook・資格情報・provider設定を列挙して消す方式ではなく、必要な公開環境だけを選ぶ。
export function lightEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    ['PATH', 'HOME', 'CODEX_HOME', 'TMPDIR'].flatMap((key) =>
      source[key] === undefined ? [] : [[key, source[key]]],
    ),
  );
}
