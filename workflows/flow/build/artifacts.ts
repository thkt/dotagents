#!/usr/bin/env bun
/** @file Outcome: Each build unit changes its planned files and supplies its planned test evidence. */

import * as fs from 'node:fs';
import path from 'node:path';
import {
  absoluteExistingPath,
  cli,
  isObject,
  parseSingletonArgs,
  readJsonFile,
  run,
  stringValue,
  usageError,
} from './cli.ts';
import type { StructuredGateResult } from '../contracts.ts';
import { isMainModule } from '../../shared/environment.ts';
import { nulPaths, realpathInside } from '../../shared/repository.ts';

const PROTOCOL = 'codex-build-artifacts';
const DESCRIPTION_PROTOCOL = 'codex-build-artifacts-description';
const BASE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

export function gitFileList(repo: string, base: string): string[] {
  if (!BASE_PATTERN.test(base) || base.includes('..'))
    throw usageError('--base has an invalid shape');
  const diff = run('git', ['diff', '--name-only', '-z', base, '--'], repo, null);
  if (diff.status !== 0 || diff.error) {
    throw new Error(`git diff failed: ${String(diff.stderr || diff.error?.message || '').trim()}`);
  }
  const untracked = run('git', ['ls-files', '--others', '--exclude-standard', '-z'], repo, null);
  if (untracked.status !== 0 || untracked.error) {
    throw new Error(
      `git ls-files failed: ${String(untracked.stderr || untracked.error?.message || '').trim()}`,
    );
  }
  return [...new Set([...nulPaths(diff.stdout), ...nulPaths(untracked.stdout)])].sort();
}

function squeeze(value: unknown): string {
  return String(value).replace(/\s+/gu, '');
}

function testEvidenceAliases(name: string): string[] {
  const aliases = [name];
  const colon = name.indexOf(':');
  if (colon > 0) aliases.push(name.slice(0, colon).trim());
  return aliases;
}

function readText(repo: string, file: string): string {
  try {
    const target = path.resolve(repo, file);
    if (!realpathInside(repo, target)) return '';
    if (!fs.statSync(target).isFile()) return '';
    return fs.readFileSync(target, 'utf8');
  } catch {
    return '';
  }
}

function pathCovers(planned: string, changed: string): boolean {
  const prefix = planned.endsWith('/') ? planned : `${planned}/`;
  return changed === planned || changed.startsWith(prefix);
}

function preexistingPath(file: string, baseline: readonly string[]): boolean {
  return baseline.some((entry) => pathCovers(entry, file));
}

interface ArtifactFinding {
  kind: 'scope_deviation' | 'untouched_plan_file' | 'missing_test';
  failure_route: string;
  file?: string;
  unit_id?: string;
  test_id?: string;
  name?: string;
}

/** Verifies that each selected unit changed its planned files and exposes planned test evidence. */
export function verifyArtifacts(
  input: unknown,
  repo: string,
  changedFiles: readonly string[],
  baselineUntracked: unknown = [],
  gateId = 'artifacts',
  unitId?: string,
) {
  const plan = isObject(input) && isObject(input.plan) ? input.plan : input;
  if (!isObject(plan) || !Array.isArray(plan.units))
    throw usageError('plan.units must be an array');
  if (
    !Array.isArray(baselineUntracked) ||
    baselineUntracked.some((file: unknown) => typeof file !== 'string')
  ) {
    throw usageError('baseline untracked input must contain only paths');
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9:._-]*$/.test(gateId))
    throw usageError('--gate-id has an invalid shape');

  const allUnits = plan.units.filter(isObject);
  const units = unitId === undefined ? allUnits : allUnits.filter((unit) => unit.id === unitId);
  if (unitId !== undefined && !units.length) throw usageError(`plan has no unit ${unitId}`);
  const allPlannedFiles = allUnits.flatMap((unit) =>
    (Array.isArray(unit.files) ? unit.files : []).map((file) => ({ unit, file: String(file) })),
  );
  const plannedFiles = units.flatMap((unit) =>
    (Array.isArray(unit.files) ? unit.files : []).map((file) => ({ unit, file: String(file) })),
  );
  const relevantChanged = changedFiles.filter((file) => !preexistingPath(file, baselineUntracked));
  const scopeDeviations = relevantChanged.filter(
    (file) => !allPlannedFiles.some((planned) => pathCovers(planned.file, file)),
  );
  const untouchedPlanFiles = plannedFiles.filter(
    (planned) => !relevantChanged.some((file) => pathCovers(planned.file, file)),
  );

  const testPresence: Array<{ unit_id: string; test_id: string; name: string; found: boolean }> =
    [];
  for (const unit of units) {
    const contents = (Array.isArray(unit.files) ? unit.files : []).map((file) =>
      squeeze(readText(repo, String(file))),
    );
    for (const scenario of Array.isArray(unit.tests) ? unit.tests : []) {
      if (!isObject(scenario)) continue;
      const needle = squeeze(stringValue(scenario.name));
      const aliases = testEvidenceAliases(needle);
      testPresence.push({
        unit_id: stringValue(unit.id),
        test_id: stringValue(scenario.id),
        name: stringValue(scenario.name),
        found: aliases.some(
          (alias) => Boolean(alias) && contents.some((content) => content.includes(alias)),
        ),
      });
    }
  }
  const missingTests = testPresence.filter((result) => !result.found);

  const findings: ArtifactFinding[] = [
    ...scopeDeviations.map((file) => ({
      kind: 'scope_deviation' as const,
      file,
      failure_route: 'triage',
    })),
    ...untouchedPlanFiles.map(({ unit, file }) => {
      const unitId = stringValue(unit.id);
      return {
        kind: 'untouched_plan_file' as const,
        unit_id: unitId,
        file,
        failure_route: `${Array.isArray(unit.tests) && unit.tests.length ? 'green' : 'direct'}:${unitId}`,
      };
    }),
    ...missingTests.map((result) => ({
      kind: 'missing_test' as const,
      unit_id: result.unit_id,
      test_id: result.test_id,
      name: result.name,
      failure_route: `red:${result.unit_id}`,
    })),
  ];
  const routes = [...new Set(findings.map((finding) => finding.failure_route))];
  const failureRoute = findings.length ? (routes.length === 1 ? routes[0]! : 'triage') : null;
  const reasonCodes = [...new Set(findings.map((finding) => finding.kind))];
  return {
    protocol: PROTOCOL,
    gate_id: gateId,
    verdict: findings.length ? 'fail' : 'pass',
    classification: reasonCodes[0] || 'pass',
    reason_codes: reasonCodes,
    failure_route: failureRoute,
    changed_files: relevantChanged,
    scope_deviations: scopeDeviations,
    untouched_plan_files: untouchedPlanFiles.map(({ unit, file }) => ({
      unit_id: stringValue(unit.id),
      file,
    })),
    test_presence: testPresence,
    missing_tests: missingTests,
    findings,
  } satisfies StructuredGateResult;
}

interface DescriptionResult {
  report: {
    protocol: typeof DESCRIPTION_PROTOCOL;
    command: string;
    verdicts: string[];
  };
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
          'codex-build-artifacts --gate-id <id> --unit <U-NNN> --input <absolute-plan-json> --repo <absolute-git-root> --base <git-ref> [--baseline-changed <absolute-json>]',
        verdicts: ['pass', 'fail'],
      },
    };
  }
  const args = parseSingletonArgs(
    argv,
    new Set(['--gate-id', '--unit', '--input', '--repo', '--base', '--baseline-changed']),
  );
  const plan = readJsonFile(args['--input']);
  const repo = absoluteExistingPath(args['--repo'], '--repo', 'directory');
  if (!args['--gate-id']) throw usageError('--gate-id is required');
  if (!args['--unit'] || !/^U-\d{3}$/u.test(args['--unit']))
    throw usageError('--unit must be U-NNN');
  if (!args['--base']) throw usageError('--base is required');
  const baseline = args['--baseline-changed']
    ? readJsonFile(args['--baseline-changed'], '--baseline-changed')
    : [];
  const changed = gitFileList(repo, args['--base']);
  const report = verifyArtifacts(plan, repo, changed, baseline, args['--gate-id'], args['--unit']);
  return { report, exitCode: report.verdict === 'pass' ? 0 : 1 };
}

if (isMainModule(import.meta.url)) cli(() => main(), PROTOCOL);
