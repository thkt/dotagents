/** @file Outcome: A direct change request becomes a validated Code manifest without Git actions. */

import * as fs from 'node:fs';
import path from 'node:path';

import type { FlowManifest } from '../execution/contracts.ts';
import {
  implementationSteps,
  DEFAULT_MAX_CORRECTIONS,
  validateManifest,
} from '../execution/manifest.ts';

import { SHELL_CONTROL, shellWords } from '../shared/command.ts';
import { FlowError } from '../shared/errors.ts';
import { gitRoot, normalizeRepoPath } from '../shared/repository.ts';
import { isObject, requiredString, stringArray } from '../shared/schema.ts';

export interface CodeInput {
  repo: string;
  request: string;
  scope_paths: string[];
  test_command: string;
}

function inferredTestCommand(repo: string): string {
  const hasBun =
    fs.existsSync(path.join(repo, 'bun.lock')) || fs.existsSync(path.join(repo, 'bun.lockb'));
  const packageFile = path.join(repo, 'package.json');
  if (fs.existsSync(packageFile)) {
    try {
      const packageJson = JSON.parse(fs.readFileSync(packageFile, 'utf8')) as {
        scripts?: Record<string, unknown>;
      };
      if (typeof packageJson.scripts?.check === 'string') {
        return hasBun ? 'bun run check' : 'npm run check';
      }
    } catch {
      // Input validation stays focused on the requested change; the inferred fallback remains usable.
    }
  }
  if (hasBun) return 'bun test';
  if (fs.existsSync(packageFile)) return 'npm test';
  if (fs.existsSync(path.join(repo, 'Cargo.toml'))) return 'cargo test';
  if (fs.existsSync(path.join(repo, 'pyproject.toml'))) return 'pytest';
  return 'git diff --check';
}

function safeTestCommand(value: string): string {
  if (value.includes('\0') || SHELL_CONTROL.test(value)) {
    throw new FlowError(
      'code input.test_command must be one command without shell control operators',
    );
  }
  if (shellWords(value).some((word) => /(?:^|[\\/])gh$/u.test(word))) {
    throw new FlowError('code input.test_command may not invoke GitHub CLI');
  }
  return value;
}

export function parseCodeInput(raw: unknown): CodeInput {
  if (!isObject(raw)) throw new FlowError('code input must be an object');
  const repo = gitRoot(
    requiredString(raw.repo, 'code input.repo'),
    'code input.repo must be a Git worktree',
  );
  const scopes = stringArray(raw.scope_paths ?? ['.'], 'code input.scope_paths').map((scope) => {
    if (scope === '.') return scope;
    const normalized = normalizeRepoPath(scope);
    if (!normalized) throw new FlowError('code input.scope_paths must stay outside .git');
    return normalized;
  });
  if (!scopes.length) scopes.push('.');
  const command =
    raw.test_command === undefined
      ? inferredTestCommand(repo)
      : requiredString(raw.test_command, 'code input.test_command');
  return {
    repo,
    request: requiredString(raw.request, 'code input.request'),
    scope_paths: [...new Set(scopes)],
    test_command: safeTestCommand(command),
  };
}

export function compileCodeManifest(input: CodeInput): FlowManifest {
  return validateManifest({
    protocol: 'codex-flow-manifest',
    workflow: 'code',
    repo: input.repo,
    max_corrections: DEFAULT_MAX_CORRECTIONS,
    shipping_authorized: false,
    steps: implementationSteps(
      [
        {
          id: 'U-001',
          outcome: input.request,
          contract: '',
          tests: [],
          scope_paths: input.scope_paths,
        },
      ],
      input.test_command,
    ),
  });
}

export function describeCodeInput() {
  return {
    repo: '/absolute/git-root',
    request: 'One direct repository change',
    scope_paths: [],
  };
}
