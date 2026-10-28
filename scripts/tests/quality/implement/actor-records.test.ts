import { expect, test } from 'bun:test';
import { expectActorAssociation } from '../../support/actor-records.ts';

const root = '/fixture/run';
const path = `${root}/repair-codex-fixture/actor.json`;
const normal = {
  run: root,
  prefix: `${root}/implementation`,
  role: 'repair',
  path,
  sha256: 'a'.repeat(64),
  reason: null,
};
const missing = {
  run: root,
  prefix: `${root}/implementation`,
  role: 'repair',
  reason: '付属actor runtime原記録なし（外部actorまたは欠落）',
};

test('検証工程の原記録はrunとverification内の工程を分けて照合する', () => {
  const verification = {
    ...normal,
    path: `${root}/verification/repair-codex-fixture/actor.json`,
    prefix: `${root}/verification/repair-1`,
  };
  const check = (runtimeRecords: unknown) =>
    expectActorAssociation(
      { runtimeRecords },
      verification.path,
      root,
      'verification/repair-1',
      'repair',
    );
  expect(() => check([verification])).not.toThrow();
  // 保存ディレクトリをrunと取り違えた旧呼出しは、正常な対応を誤って拒否します。
  expect(() =>
    expectActorAssociation(
      { runtimeRecords: [verification] },
      verification.path,
      `${root}/verification`,
      'repair-1',
      'repair',
    ),
  ).toThrow();
  expect(() => check([{ ...verification, run: '/fixture/other-run' }])).toThrow();
  expect(() => check([{ ...verification, prefix: `${root}/verification/repair-2` }])).toThrow();
  expect(() => check([verification, { ...missing, prefix: verification.prefix }])).toThrow();
});

test('正常な工程対応は原記録を参照し、別run・別工程の欠落とは区別する', () => {
  expect(() =>
    expectActorAssociation(
      {
        runtimeRecords: [
          normal,
          { ...missing, run: '/fixture/other-run' },
          { ...missing, prefix: `${root}/verification/repair-1` },
        ],
      },
      path,
      root,
      'implementation',
      'repair',
    ),
  ).not.toThrow();
});

for (const runtimeRecords of [
  [normal, missing],
  [missing, normal],
]) {
  test('正常な原記録と同じrun・工程の欠落が併存すれば工程対応の判定は失敗する', () => {
    expect(() =>
      expectActorAssociation({ runtimeRecords }, path, root, 'implementation', 'repair'),
    ).toThrow();
  });
}
