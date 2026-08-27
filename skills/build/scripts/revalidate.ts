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
  safeRepoPath,
  usageError,
} from './lib.ts';

export const PROTOCOL = 'codex-build-revalidate/v1';

export interface ValidationTarget {
  source: 'precondition' | 'reference_module';
  path: string;
  pattern: string;
}

export interface ValidationResult extends ValidationTarget {
  valid_path: boolean;
  inside_repo: boolean;
  exists: boolean;
  matches: boolean;
}

export function targetsFromPlan(plan: unknown): ValidationTarget[] {
  if (!isObject(plan)) throw usageError('plan must be an object');
  const targets: ValidationTarget[] = [];
  for (const entry of Array.isArray(plan.preconditions) ? plan.preconditions : []) {
    targets.push({
      source: 'precondition',
      path: isObject(entry) ? String(entry.path || '') : '',
      pattern: isObject(entry) ? String(entry.pattern || '') : '',
    });
  }
  const reference = isObject(plan.reference_module) ? plan.reference_module : null;
  if (reference && reference.path) {
    for (const value of [reference.path, ...(Array.isArray(reference.files) ? reference.files : [])]) {
      targets.push({ source: 'reference_module', path: String(value || ''), pattern: '' });
    }
  }
  const seen = new Set<string>();
  return targets.filter((entry) => {
    const key = JSON.stringify([entry.path, entry.pattern]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function verifyTarget(repo: string, entry: ValidationTarget): ValidationResult {
  const validPath = safeRepoPath(entry.path);
  const target = validPath ? path.resolve(repo, entry.path) : '';
  const insideRepo = validPath && realpathInside(repo, target);
  let exists = false;
  let matches = false;
  if (insideRepo) {
    try {
      const stat = fs.statSync(target);
      exists = entry.pattern ? stat.isFile() : true;
      if (!entry.pattern) {
        matches = exists;
      } else if (exists) {
        matches = fs.readFileSync(target).includes(Buffer.from(entry.pattern));
      }
    } catch {
      exists = false;
      matches = false;
    }
  }
  return { ...entry, valid_path: validPath, inside_repo: insideRepo, exists, matches };
}

export function revalidatePlan(plan: unknown, repo: string) {
  const results = targetsFromPlan(plan).map((entry) => verifyTarget(repo, entry));
  const drift = results.filter(
    (result) => !result.valid_path || !result.inside_repo || !result.exists || !result.matches,
  );
  return {
    protocol: PROTOCOL,
    verdict: drift.length ? 'fail' : 'pass',
    classification: drift.length ? 'plan_drift' : 'pass',
    reason_codes: drift.length ? ['plan_drift'] : [],
    failure_route: drift.length ? 'blocked' : null,
    results,
    drift,
  };
}

export function main(argv: readonly string[] = process.argv.slice(2)) {
  const args = parseSingletonArgs(argv, new Set(['--input', '--repo']));
  const plan = readJsonFile(args['--input']);
  const repo = absoluteExistingPath(args['--repo'], '--repo', 'directory');
  const report = revalidatePlan(plan, repo);
  return { report, exitCode: report.verdict === 'pass' ? 0 : 1 };
}

if (isMain(import.meta.url)) cli(() => main(), PROTOCOL);
