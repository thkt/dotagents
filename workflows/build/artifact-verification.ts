#!/usr/bin/env bun
/** @file Outcome: Build changes stay within the paths allowed by the Issue Plan. */

import {
  absoluteExistingPath,
  cli,
  parseSingletonArgs,
  readJsonFile,
  run,
} from '../runtime/cli.ts';
import type { StructuredGateResult } from '../execution/contracts.ts';
import { isMainModule } from '../runtime/environment.ts';
import { usageError } from '../shared/errors.ts';
import { nulPaths } from '../shared/repository.ts';
import { isObject } from '../shared/schema.ts';

const PROTOCOL = 'codex-build-artifacts';
const DESCRIPTION_PROTOCOL = 'codex-build-artifacts-description';
const BASE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

export function gitFileList(repo: string, base: string): string[] {
  if (!BASE_PATTERN.test(base) || base.includes('..'))
    throw usageError('--base has an invalid shape');
  const diff = run('git', ['diff', '--name-only', '-z', base, '--'], repo, null);
  if (diff.status !== 0 || diff.error) throw new Error('git diff failed');
  const untracked = run('git', ['ls-files', '--others', '--exclude-standard', '-z'], repo, null);
  if (untracked.status !== 0 || untracked.error) throw new Error('git ls-files failed');
  return [...new Set([...nulPaths(diff.stdout), ...nulPaths(untracked.stdout)])].sort();
}

function pathCovers(planned: string, changed: string): boolean {
  const prefix = planned.endsWith('/') ? planned : `${planned}/`;
  return changed === planned || changed.startsWith(prefix);
}

function preexistingPath(file: string, baseline: readonly string[]): boolean {
  return baseline.some((entry) => pathCovers(entry, file));
}

export function verifyArtifacts(
  input: unknown,
  _repo: string,
  changedFiles: readonly string[],
  baselineUntracked: unknown = [],
  gateId = 'artifacts',
) {
  const plan = isObject(input) && isObject(input.plan) ? input.plan : input;
  if (!isObject(plan) || !Array.isArray(plan.units))
    throw usageError('plan.units must be an array');
  if (
    !Array.isArray(baselineUntracked) ||
    baselineUntracked.some((file) => typeof file !== 'string')
  ) {
    throw usageError('baseline changed input must contain only paths');
  }
  const plannedPaths = plan.units
    .filter(isObject)
    .flatMap((unit) => (Array.isArray(unit.files) ? unit.files : []))
    .filter((file): file is string => typeof file === 'string');
  const changed = changedFiles.filter((file) => !preexistingPath(file, baselineUntracked));
  const scopeDeviations = changed.filter(
    (file) => !plannedPaths.some((planned) => pathCovers(planned, file)),
  );
  return {
    protocol: PROTOCOL,
    gate_id: gateId,
    verdict: scopeDeviations.length ? 'blocked' : 'pass',
    classification: scopeDeviations.length ? 'scope_deviation' : 'pass',
    reason_codes: scopeDeviations.length ? ['scope_deviation'] : [],
    failure_route: scopeDeviations.length ? 'blocked' : null,
    changed_files: changed,
    scope_deviations: scopeDeviations,
  } satisfies StructuredGateResult;
}

interface DescriptionResult {
  report: { protocol: typeof DESCRIPTION_PROTOCOL; command: string; verdicts: string[] };
}

type ArtifactsResult = ReturnType<typeof verifyArtifacts>;

export function main(argv: readonly ['describe']): DescriptionResult;
export function main(argv?: readonly string[]): { report: ArtifactsResult; exitCode: number };
export function main(argv: readonly string[] = process.argv.slice(2)) {
  if (argv.length === 1 && argv[0] === 'describe') {
    return {
      report: {
        protocol: DESCRIPTION_PROTOCOL,
        command:
          'codex-build-artifacts --gate-id <id> --input <absolute-plan-json> --repo <absolute-git-root> --base <git-ref> [--baseline-changed <absolute-json>]',
        verdicts: ['pass', 'blocked'],
      },
    };
  }
  const args = parseSingletonArgs(
    argv,
    new Set(['--gate-id', '--input', '--repo', '--base', '--baseline-changed']),
  );
  const plan = readJsonFile(args['--input']);
  const repo = absoluteExistingPath(args['--repo'], '--repo', 'directory');
  if (!args['--gate-id']) throw usageError('--gate-id is required');
  if (!args['--base']) throw usageError('--base is required');
  const baseline = args['--baseline-changed']
    ? readJsonFile(args['--baseline-changed'], '--baseline-changed')
    : [];
  const report = verifyArtifacts(
    plan,
    repo,
    gitFileList(repo, args['--base']),
    baseline,
    args['--gate-id'],
  );
  return { report, exitCode: report.verdict === 'pass' ? 0 : 1 };
}

if (isMainModule(import.meta.url)) cli(() => main(), PROTOCOL);
