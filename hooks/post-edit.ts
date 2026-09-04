#!/usr/bin/env bun
/** @file Outcome: Edited source and Japanese Markdown return actionable automated feedback. */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import path from 'node:path';

import { AGENTS_ROOT, isMainModule } from '../workflows/runtime/environment.ts';
import { errorMessage } from '../workflows/shared/errors.ts';

const TEXTLINT_CONFIG = path.join(AGENTS_ROOT, '.textlintrc.json');
const OXFMT_CONFIG = path.join(AGENTS_ROOT, '.oxfmtrc.json');
const OXLINT_CONFIG = path.join(AGENTS_ROOT, '.oxlintrc.json');
const executable = (name: string): string =>
  path.join(
    AGENTS_ROOT,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? `${name}.cmd` : name,
  );
const DEFAULT_EXECUTABLES = {
  oxfmt: executable('oxfmt'),
  oxlint: executable('oxlint'),
  textlint: executable('textlint'),
};
const FORMAT_EXTENSIONS = new Set([
  '.astro',
  '.cjs',
  '.css',
  '.cts',
  '.gql',
  '.graphql',
  '.handlebars',
  '.hbs',
  '.htm',
  '.html',
  '.js',
  '.json',
  '.json5',
  '.jsonc',
  '.jsx',
  '.less',
  '.md',
  '.mdx',
  '.mjs',
  '.mts',
  '.scss',
  '.svelte',
  '.toml',
  '.ts',
  '.tsx',
  '.vue',
  '.yaml',
  '.yml',
]);
const LINT_EXTENSIONS = new Set(['.cjs', '.cts', '.js', '.jsx', '.mjs', '.mts', '.ts', '.tsx']);
const JAPANESE = /[ぁ-んァ-ヶー一-龥]/gu;
export const JAPANESE_THRESHOLD = 50;

interface HookInput {
  cwd?: string;
  tool_name?: string;
  tool_input?: {
    command?: unknown;
    file_path?: unknown;
    path?: unknown;
    [key: string]: unknown;
  };
}

interface HookResponse {
  hookSpecificOutput?: {
    hookEventName: 'PostToolUse';
    additionalContext: string;
  };
}

export interface PostEditExecutables {
  oxfmt: string;
  oxlint: string;
  textlint: string;
}

function readInput(): HookInput {
  try {
    return JSON.parse(fs.readFileSync(0, 'utf8')) as HookInput;
  } catch {
    return {};
  }
}

function patchFiles(command: unknown): string[] {
  if (typeof command !== 'string') return [];
  return [...command.matchAll(/^\*\*\* (?:Add|Update) File: (.+)$|^\*\*\* Move to: (.+)$/gm)].map(
    (match) => (match[1] || match[2] || '').trim(),
  );
}

/** Resolves the unique files touched by one supported editing tool call. */
export function editedFiles(input: HookInput): string[] {
  const files: string[] = [];
  if (input.tool_name === 'Write' || input.tool_name === 'Edit') {
    if (typeof input.tool_input?.file_path === 'string') files.push(input.tool_input.file_path);
    if (typeof input.tool_input?.path === 'string') files.push(input.tool_input.path);
  } else if (input.tool_name === 'apply_patch') {
    files.push(...patchFiles(input.tool_input?.command));
  }
  const cwd = typeof input.cwd === 'string' ? input.cwd : process.cwd();
  return [
    ...new Set(
      files.map((file) => path.resolve(path.isAbsolute(file) ? file : path.join(cwd, file))),
    ),
  ];
}

export function hasJapanese(text: string, threshold = JAPANESE_THRESHOLD): boolean {
  return (text.match(JAPANESE)?.length ?? 0) >= threshold;
}

function requireFile(file: string, label: string): void {
  if (!fs.statSync(file, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`${label} not found: ${file}`);
  }
}

function runTool(label: string, executablePath: string, args: string[]): string | null {
  requireFile(executablePath, `${label} executable`);
  const result = spawnSync(executablePath, args, {
    cwd: AGENTS_ROOT,
    encoding: 'utf8',
    env: process.env,
    timeout: 60_000,
  });
  if (result.error) throw result.error;
  if (result.signal) return `${label} terminated by ${result.signal}`;
  if (result.status === 0) return null;
  const output = [result.stdout, result.stderr]
    .map((value) => value.trim())
    .filter(Boolean)
    .join('\n');
  return `${label} exited with status ${result.status}${output ? `:\n${output}` : ''}`;
}

/** Applies shared textlint fixes only to substantial Japanese Markdown. */
export function fixMarkdown(file: string, executablePath = DEFAULT_EXECUTABLES.textlint): boolean {
  if (!fs.statSync(file, { throwIfNoEntry: false })?.isFile()) return false;
  const source = fs.readFileSync(file, 'utf8');
  if (!hasJapanese(source)) return false;
  requireFile(TEXTLINT_CONFIG, 'textlint config');
  const failure = runTool('textlint', executablePath, ['--fix', file, '--config', TEXTLINT_CONFIG]);
  if (failure) throw new Error(failure);
  return true;
}

function existingFiles(files: string[]): string[] {
  return files.filter((file) => fs.statSync(file, { throwIfNoEntry: false })?.isFile());
}

function filesWithExtensions(files: string[], extensions: ReadonlySet<string>): string[] {
  return files.filter((file) => extensions.has(path.extname(file).toLowerCase()));
}

/** Applies safe fixes, reports changed files, and fails with each unresolved diagnostic. */
export function postEdit(
  input: HookInput,
  executables: PostEditExecutables = DEFAULT_EXECUTABLES,
): HookResponse {
  const files = existingFiles(editedFiles(input));
  const before = new Map(files.map((file) => [file, fs.readFileSync(file)]));
  const failures: string[] = [];
  const sourceFiles = filesWithExtensions(files, LINT_EXTENSIONS);
  const formattedFiles = filesWithExtensions(files, FORMAT_EXTENSIONS);
  const markdownFiles = files.filter((file) => path.extname(file).toLowerCase() === '.md');

  if (sourceFiles.length > 0) {
    requireFile(OXLINT_CONFIG, 'oxlint config');
    const failure = runTool('oxlint', executables.oxlint, [
      '--fix',
      '--format=agent',
      '--config',
      OXLINT_CONFIG,
      ...sourceFiles,
    ]);
    if (failure) failures.push(failure);
  }
  if (formattedFiles.length > 0) {
    requireFile(OXFMT_CONFIG, 'oxfmt config');
    const failure = runTool('oxfmt', executables.oxfmt, [
      '--write',
      '--config',
      OXFMT_CONFIG,
      ...formattedFiles,
    ]);
    if (failure) failures.push(failure);
  }
  for (const file of markdownFiles) {
    try {
      fixMarkdown(file, executables.textlint);
    } catch (error) {
      failures.push(errorMessage(error));
    }
  }

  const changed = files.filter((file) => !before.get(file)?.equals(fs.readFileSync(file)));
  const changeFeedback =
    changed.length > 0
      ? `Automated post-edit fixes changed: ${changed.join(', ')}. Re-read the files before continuing.`
      : '';
  if (failures.length > 0) {
    throw new Error([changeFeedback, ...failures].filter(Boolean).join('\n\n'));
  }
  return changeFeedback
    ? {
        hookSpecificOutput: {
          hookEventName: 'PostToolUse',
          additionalContext: changeFeedback,
        },
      }
    : {};
}

function main(): void {
  try {
    process.stdout.write(`${JSON.stringify(postEdit(readInput()))}\n`);
  } catch (error) {
    process.stderr.write(`${errorMessage(error)}\n`);
    process.exitCode = 1;
  }
}

if (isMainModule(import.meta.url)) main();
