import assert from 'node:assert/strict';
import { expect, test } from 'bun:test';
import { isRecord } from '../../scripts/shared/values.ts';
import { lightEnvironment, requireChatGPTAuthentication } from '../light.ts';

// 内部接続名はホスト提示契約。期待値はIssueの認証専用契約から定める。
// 静的importで既存の未使用検査へ接続し、内部exportの公開契約は追加しない。
const authenticated = { code: 0, stdout: '', stderr: 'Logged in using ChatGPT\n', timedOut: false };

for (const [name, value] of [
  ['未ログイン', { ...authenticated, code: 1, stderr: 'Not logged in\n' }],
  ['API認証', { ...authenticated, stderr: 'Logged in using an API key\n' }],
  ['不明な認証', { ...authenticated, stderr: 'Unknown authentication method\n' }],
  ['空の確認結果', { ...authenticated, stderr: '' }],
  ['認証確認失敗', { ...authenticated, code: 1 }],
  ['認証確認の時間切れ', { ...authenticated, timedOut: true }],
  ['認証種別の矛盾', { ...authenticated, stdout: 'Logged in using an API key\n' }],
] as const) {
  test(`ChatGPT専用の認証判定は${name}を拒否する`, () => {
    const authenticate = requireChatGPTAuthentication;
    expect(() => {
      Reflect.apply(authenticate, undefined, [authenticated]);
    }).not.toThrow();
    expect(() => {
      Reflect.apply(authenticate, undefined, [value]);
    }).toThrow();
  });
}

test('APIキー・provider上書き・起動hookの環境を軽量サブプロセスへ配らない', () => {
  const publicEnvironment = {
    PATH: '/usr/bin:/bin',
    CODEX_HOME: '/synthetic/auth-home',
    HOME: '/synthetic/home',
  };
  const credentials = {
    OPENAI_API_KEY: 'SYNTHETIC_API_KEY',
    OPENAI_BASE_URL: 'https://synthetic-provider.invalid',
    OPENAI_ORG_ID: 'SYNTHETIC_ORGANIZATION',
    OPENAI_PROJECT_ID: 'SYNTHETIC_PROJECT',
    CODEX_API_KEY: 'SYNTHETIC_CODEX_KEY',
    CODEX_CONFIG: 'SYNTHETIC_PROVIDER_OVERRIDE',
    NODE_OPTIONS: '--require=SYNTHETIC_HOOK',
    BUN_OPTIONS: '--preload=SYNTHETIC_HOOK',
    GITHUB_TOKEN: 'SYNTHETIC_GITHUB_TOKEN',
    AWS_SECRET_ACCESS_KEY: 'SYNTHETIC_AWS_KEY',
    PRIVATE_CANARY: 'SYNTHETIC_PRIVATE_ENVIRONMENT',
  };
  const input = { ...publicEnvironment, ...credentials };
  const before = { ...input };
  const clean: unknown = Reflect.apply(lightEnvironment, undefined, [publicEnvironment]);
  const hostile: unknown = Reflect.apply(lightEnvironment, undefined, [input]);
  assert(isRecord(clean) && isRecord(hostile));
  expect(clean.PATH).toBe(publicEnvironment.PATH);
  expect(hostile).toEqual(clean);
  expect(input).toEqual(before);
  for (const value of Object.values(credentials)) {
    expect(JSON.stringify(hostile)).not.toContain(value);
  }
});
