#!/usr/bin/env bun
/** @file Outcome: Every repository fact cited by a Plan still exists and matches before build starts. */

import * as fs from 'node:fs';
import path from 'node:path';
import {
  absoluteExistingPath,
  cli,
  isObject,
  parseSingletonArgs,
  readJsonFile,
  safeRepoPath,
  stringValue,
  usageError,
} from './cli.ts';
import type { StructuredGateResult } from '../contracts.ts';
import { isMainModule } from '../../shared/environment.ts';
import { realpathInside } from '../../shared/repository.ts';

const PROTOCOL = 'codex-build-revalidate/v1';
const DESCRIPTION_PROTOCOL = 'codex-build-revalidate-description/v1';

interface ValidationTarget {
  source: 'precondition' | 'reference_module' | 'rule';
  path: string;
  pattern: string;
}

interface ValidationResult extends ValidationTarget {
  valid_path: boolean;
  inside_repo: boolean;
  exists: boolean;
  matches: boolean;
}

/** Collects every repository fact the Plan depends on. */
export function targetsFromPlan(plan: unknown): ValidationTarget[] {
  if (!isObject(plan)) throw usageError('plan must be an object');
  const targets: ValidationTarget[] = [];
  for (const entry of Array.isArray(plan.preconditions) ? plan.preconditions : []) {
    targets.push({
      source: 'precondition',
      path: isObject(entry) ? stringValue(entry.path) : '',
      pattern: isObject(entry) ? stringValue(entry.pattern) : '',
    });
  }
  const reference = isObject(plan.reference_module) ? plan.reference_module : null;
  if (reference && reference.path) {
    for (const value of [
      reference.path,
      ...(Array.isArray(reference.files) ? reference.files : []),
    ]) {
      targets.push({ source: 'reference_module', path: String(value || ''), pattern: '' });
    }
  }
  for (const entry of Array.isArray(plan.rules) ? plan.rules : []) {
    targets.push({
      source: 'rule',
      path: isObject(entry) ? stringValue(entry.source) : '',
      pattern: isObject(entry) ? stringValue(entry.quote) : '',
    });
  }
  const seen = new Set<string>();
  return targets.filter((entry) => {
    const key = JSON.stringify([entry.path, entry.pattern]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function verifyTarget(repo: string, entry: ValidationTarget): ValidationResult {
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

/** Rechecks Plan dependencies against the repository immediately before build. */
export function revalidatePlan(plan: unknown, repo: string) {
  const planValue = isObject(plan) && isObject(plan.plan) ? plan.plan : plan;
  const results = targetsFromPlan(planValue).map((entry) => verifyTarget(repo, entry));
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
  } satisfies StructuredGateResult;
}

interface DescriptionResult {
  report: {
    protocol: typeof DESCRIPTION_PROTOCOL;
    command: string;
    verdicts: string[];
  };
}

type RevalidateResult = ReturnType<typeof revalidatePlan>;

function main(argv: readonly ['describe']): DescriptionResult;
function main(argv?: readonly string[]): { report: RevalidateResult; exitCode: number };
function main(argv: readonly string[] = process.argv.slice(2)) {
  if (argv.length === 1 && argv[0] === 'describe') {
    return {
      report: {
        protocol: DESCRIPTION_PROTOCOL,
        command: 'codex-build-revalidate --input <absolute-plan-json> --repo <absolute-git-root>',
        verdicts: ['pass', 'fail'],
      },
    };
  }
  const args = parseSingletonArgs(argv, new Set(['--input', '--repo']));
  const plan = readJsonFile(args['--input']);
  const repo = absoluteExistingPath(args['--repo'], '--repo', 'directory');
  const report = revalidatePlan(plan, repo);
  return { report, exitCode: report.verdict === 'pass' ? 0 : 1 };
}

if (isMainModule(import.meta.url)) cli(() => main(), PROTOCOL);
