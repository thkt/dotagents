import assert from 'node:assert/strict';
import { command } from '../shared/process.ts';
import { reconcileExecutions } from './execution-history.ts';
import { DecisionObservation, verifyDecisionContents } from './human-decision-records.ts';
import { humanDecisionShape } from './human-decision-schema.ts';
import type { HumanDecision } from './human-decision-schema.ts';

export async function verifyHumanDecision(
  input: HumanDecision,
  cwd: string,
  runDirectory: string,
  publicationHead?: string,
  observation = new DecisionObservation(),
) {
  humanDecisionShape.parse(input);
  const identity = await command(
    ['git', 'rev-parse', 'HEAD', '--symbolic-full-name', 'HEAD'],
    cwd,
    '',
    10000,
  );
  assert(
    identity.code === 0 &&
      !identity.timedOut &&
      identity.stdout.trim() === `${publicationHead ?? input.head}\nrefs/heads/${input.branch}`,
    '判断待ち復帰中のHEAD・branchが変更されました',
  );
  if (publicationHead) {
    const parent = await command(['git', 'rev-parse', `${publicationHead}^`], cwd, '', 10000);
    assert(
      parent.code === 0 && !parent.timedOut && parent.stdout.trim() === input.head,
      '公開commitの親が判断待ちのHEADと一致しません',
    );
  }
  await verifyDecisionContents(input, cwd, observation);
  await reconcileExecutions({ previousRun: input.previousRun, runDirectory }, cwd);
}
