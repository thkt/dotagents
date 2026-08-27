#!/usr/bin/env node
import * as fs from 'node:fs';
import path from 'node:path';
import {
  absoluteExistingPath,
  cli,
  isObject,
  isMain,
  parseSingletonArgs,
  readJsonFile,
  realpathInside,
  run,
  usageError,
} from './lib.ts';

export const PROTOCOL = 'codex-build-artifacts/v1';
const BASE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

export function parseNul(buffer: Buffer): string[] {
  return buffer.toString('utf8').split('\0').filter(Boolean);
}

export function gitFileList(repo: string, base: string): string[] {
  if (!BASE_PATTERN.test(base) || base.includes('..')) throw usageError('--base has an invalid shape');
  const diff = run('git', ['diff', '--name-only', '-z', base, '--'], repo, null);
  if (diff.status !== 0 || diff.error) {
    throw new Error(`git diff failed: ${String(diff.stderr || diff.error?.message || '').trim()}`);
  }
  const untracked = run('git', ['ls-files', '--others', '--exclude-standard', '-z'], repo, null);
  if (untracked.status !== 0 || untracked.error) {
    throw new Error(`git ls-files failed: ${String(untracked.stderr || untracked.error?.message || '').trim()}`);
  }
  return [...new Set([...parseNul(diff.stdout), ...parseNul(untracked.stdout)])].sort();
}

export function squeeze(value: unknown): string {
  return String(value).replace(/\s+/gu, '');
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

export function pathCovers(planned: string, changed: string): boolean {
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

export function verifyArtifacts(
  plan: unknown,
  repo: string,
  changedFiles: readonly string[],
  baselineUntracked: unknown = [],
  gateId = 'artifacts',
) {
  if (!isObject(plan) || !Array.isArray(plan.units)) throw usageError('plan.units must be an array');
  if (!Array.isArray(baselineUntracked) || baselineUntracked.some((file: unknown) => typeof file !== 'string')) {
    throw usageError('baseline untracked input must contain only paths');
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9:._-]*$/.test(gateId)) throw usageError('--gate-id has an invalid shape');

  const units = plan.units.filter(isObject);
  const plannedFiles = units.flatMap((unit) =>
    (Array.isArray(unit.files) ? unit.files : []).map((file) => ({ unit, file: String(file) })),
  );
  const relevantChanged = changedFiles.filter((file) => !preexistingPath(file, baselineUntracked));
  const scopeDeviations = relevantChanged.filter(
    (file) => !plannedFiles.some((planned) => pathCovers(planned.file, file)),
  );
  const untouchedPlanFiles = plannedFiles.filter(
    (planned) => !relevantChanged.some((file) => pathCovers(planned.file, file)),
  );

  const testPresence: Array<{ unit_id: string; test_id: string; name: string; found: boolean }> = [];
  for (const unit of units) {
    const contents = (Array.isArray(unit.files) ? unit.files : []).map((file) =>
      squeeze(readText(repo, String(file))),
    );
    for (const scenario of Array.isArray(unit.tests) ? unit.tests : []) {
      if (!isObject(scenario)) continue;
      const needle = squeeze(scenario.name || '');
      testPresence.push({
        unit_id: String(unit.id || ''),
        test_id: String(scenario.id || ''),
        name: String(scenario.name || ''),
        found: Boolean(needle) && contents.some((content) => content.includes(needle)),
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
    ...untouchedPlanFiles.map(({ unit, file }) => ({
      kind: 'untouched_plan_file' as const,
      unit_id: String(unit.id || ''),
      file,
      failure_route: `${Array.isArray(unit.tests) && unit.tests.length ? 'green' : 'direct'}:${unit.id}`,
    })),
    ...missingTests.map((result) => ({
      kind: 'missing_test' as const,
      unit_id: result.unit_id,
      test_id: result.test_id,
      name: result.name,
      failure_route: `red:${result.unit_id}`,
    })),
  ];
  const routes = [...new Set(findings.map((finding) => finding.failure_route))];
  const failureRoute = findings.length ? (routes.length === 1 ? routes[0] : 'triage') : null;
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
      unit_id: String(unit.id || ''),
      file,
    })),
    test_presence: testPresence,
    missing_tests: missingTests,
    findings,
  };
}

export function main(argv: readonly string[] = process.argv.slice(2)) {
  const args = parseSingletonArgs(
    argv,
    new Set(['--gate-id', '--input', '--repo', '--base', '--baseline-untracked']),
  );
  const plan = readJsonFile(args['--input']);
  const repo = absoluteExistingPath(args['--repo'], '--repo', 'directory');
  if (!args['--gate-id']) throw usageError('--gate-id is required');
  if (!args['--base']) throw usageError('--base is required');
  const baseline = args['--baseline-untracked']
    ? readJsonFile(args['--baseline-untracked'], '--baseline-untracked')
    : [];
  const changed = gitFileList(repo, args['--base']);
  const report = verifyArtifacts(plan, repo, changed, baseline, args['--gate-id']);
  return { report, exitCode: report.verdict === 'pass' ? 0 : 1 };
}

if (isMain(import.meta.url)) cli(() => main(), PROTOCOL);
