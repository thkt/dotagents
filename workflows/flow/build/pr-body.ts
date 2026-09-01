#!/usr/bin/env bun
/** @file Outcome: Draft PR bodies expose complete mechanical verification facts without unsafe rendering. */

import * as fs from 'node:fs';
import path from 'node:path';

import { cli, isObject, parseSingletonArgs, readJsonFile, usageError } from './cli.ts';
import { isMainModule } from '../../shared/environment.ts';
import { resolveConfiguredLanguage, type ConfiguredLanguage } from '../../shared/language.ts';

const PROTOCOL = 'codex-build-pr-body/v1';
const DESCRIPTION_PROTOCOL = 'codex-build-pr-body-description/v1';
const REQUIRED_KEYS = ['issue', 'tests_pass', 'gates_pass'];

const LABELS = {
  english: {
    header:
      '_Automated build verification. It checks the diff against the issue plan; it is not a deep code review._',
    manual: 'Manual verification checklist (complete before merge)',
    scope: "Files outside the plan's scope",
    untouched: 'Planned files never changed',
    missing: 'Planned test statements not found',
    advisories: 'Advisory findings (not mechanically reproduced)',
    output: 'verify output',
  },
  japanese: {
    header:
      '_build の自動検証結果。issue plan と diff の機械的な突合であり、深いコードレビューではない。_',
    manual: '実機確認（merge 前に実施）',
    scope: 'Plan スコープ外の変更ファイル',
    untouched: '一度も変更されていない plan の files',
    missing: '見つからなかった plan のテスト言明',
    advisories: '助言的な指摘（機械的な再現なし）',
    output: 'verify 出力',
  },
} as const;

interface PrBodyPayload {
  issue: string | number;
  tests_pass: boolean;
  gates_pass: boolean;
  language?: unknown;
  scope_deviations?: unknown;
  untouched_plan_files?: unknown;
  missing_tests?: unknown;
  manual_checks?: unknown;
  advisories?: unknown;
  verification_output?: unknown;
}

function oneLine(value: unknown): string {
  return String(value).replace(/\s+/gu, ' ').trim();
}

function inlineCode(value: unknown): string {
  const text = oneLine(value);
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((match) => match[0].length));
  const fence = '`'.repeat(Math.max(1, longest + 1));
  return `${fence}${text}${fence}`;
}

export function codeFence(value: unknown): string {
  const text = String(value);
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((match) => match[0].length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}\n${text}\n${fence}`;
}

function list(value: unknown, key: string): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw usageError(`${key} must be an array`);
  return value;
}

function renderSection<T>(
  label: string,
  items: readonly T[],
  renderItem: (item: T) => string,
): string | null {
  if (!items.length) return null;
  return `**${label}**\n${items.map((item) => `- ${renderItem(item)}`).join('\n')}`;
}

/** Narrows untrusted controller data to the closed PR rendering contract. */
export function validatePayload(payload: unknown): asserts payload is PrBodyPayload {
  if (!isObject(payload)) throw usageError('input must be a JSON object');
  const missing = REQUIRED_KEYS.filter((key) => !Object.hasOwn(payload, key));
  if (missing.length) throw usageError(`input is missing required key(s): ${missing.join(', ')}`);
  if (!/^\d+$/.test(String(payload.issue)) || Number(payload.issue) < 1) {
    throw usageError('issue must be a positive integer');
  }
  for (const key of ['tests_pass', 'gates_pass']) {
    if (typeof payload[key] !== 'boolean') throw usageError(`${key} must be boolean`);
  }
}

/** Renders verified build facts as a bounded Markdown PR body. */
export function render(payload: unknown): string {
  validatePayload(payload);
  const language =
    typeof payload.language === 'string' ? payload.language.toLowerCase() : 'english';
  const labels = language in LABELS ? LABELS[language as keyof typeof LABELS] : LABELS.english;
  const scope = list(payload.scope_deviations, 'scope_deviations');
  const untouched = list(payload.untouched_plan_files, 'untouched_plan_files');
  const missing = list(payload.missing_tests, 'missing_tests');
  const manual = list(payload.manual_checks, 'manual_checks');
  const advisories = list(payload.advisories, 'advisories');
  const tests = payload.tests_pass ? 'pass' : 'FAIL';
  const gates = payload.gates_pass ? 'pass' : 'FAIL';
  const status = [
    `<code>verify tests=${tests} gates=${gates}</code>`,
    `<code>scope-deviations ${scope.length}</code>`,
    `<code>untouched-plan-files ${untouched.length}</code>`,
    `<code>missing-tests ${missing.length}</code>`,
  ].join(' · ');

  const folded = [];
  if ((!payload.tests_pass || !payload.gates_pass) && payload.verification_output) {
    folded.push(
      `<details><summary>${labels.output}</summary>\n\n${codeFence(payload.verification_output)}\n\n</details>`,
    );
  }
  for (const section of [
    renderSection(labels.manual, manual, (item) => `[ ] ${oneLine(item)}`),
    renderSection(labels.scope, scope, inlineCode),
    renderSection(labels.untouched, untouched, (item) =>
      inlineCode(isObject(item) ? item.file : item),
    ),
    renderSection(labels.missing, missing, (item) => {
      if (!isObject(item)) return oneLine(item);
      return `${inlineCode(item.test_id || '?')} ${oneLine(item.name || '')}`.trim();
    }),
    renderSection(labels.advisories, advisories, oneLine),
  ]) {
    if (section) folded.push(section);
  }

  const verification = folded.length
    ? `<details>\n<summary>${status}</summary>\n\n${folded.join('\n\n')}\n\n</details>`
    : status;
  return `\n\n---\n\n${labels.header}\n\nCloses #${payload.issue}\n\n${verification}\n`;
}

export function describe(language: ConfiguredLanguage = resolveConfiguredLanguage('japanese')) {
  return {
    protocol: DESCRIPTION_PROTOCOL,
    renders_with: PROTOCOL,
    command: 'codex-build-pr-body --input <absolute-json> --output <absolute-markdown>',
    input_template: {
      issue: 123,
      tests_pass: true,
      gates_pass: true,
      scope_deviations: [],
      untouched_plan_files: [],
      missing_tests: [],
      manual_checks: [],
      advisories: [],
      verification_output: '',
      language,
    },
    required_keys: [...REQUIRED_KEYS],
    languages: Object.keys(LABELS),
  };
}

export function main(argv: readonly string[] = process.argv.slice(2)) {
  if (argv[0] === 'describe') {
    if (argv.length !== 1) throw usageError('describe accepts no arguments');
    return { report: describe(), exitCode: 0 };
  }
  const args = parseSingletonArgs(argv, new Set(['--input', '--output']));
  const payload = readJsonFile(args['--input']);
  const output = render(payload);
  if (args['--output']) {
    if (!path.isAbsolute(args['--output'])) throw usageError('--output must be absolute');
    fs.mkdirSync(path.dirname(args['--output']), { recursive: true, mode: 0o700 });
    fs.writeFileSync(args['--output'], output, { mode: 0o600 });
  }
  return { output, exitCode: 0 };
}

if (isMainModule(import.meta.url)) cli(() => main(), PROTOCOL);
