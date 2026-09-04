#!/usr/bin/env bun
/** @file Outcome: Draft PR bodies expose only observed Build verification facts. */

import * as fs from 'node:fs';
import path from 'node:path';

import { cli, parseSingletonArgs, readJsonFile } from '../runtime/cli.ts';
import { isMainModule } from '../runtime/environment.ts';
import { usageError } from '../shared/errors.ts';
import { isObject } from '../shared/schema.ts';
import { markdownScreenshotAlt, SCREENSHOT_CAP, safeScreenshotName } from './screenshots.ts';

const PROTOCOL = 'codex-build-pr-body';
const DESCRIPTION_PROTOCOL = 'codex-build-pr-body-description';
const REQUIRED_KEYS = ['issue', 'outcome', 'unit_goals', 'tests_pass', 'gates_pass'];

const LABELS = {
  summary: 'Summary',
  verification: 'Verification',
  header:
    '_Automated build verification, including an independent semantic review of the diff against the published issue Plan._',
  scope: "Files outside the plan's scope",
  advisories: 'Advisory findings (not mechanically reproduced)',
  screenshots: 'Screenshots',
} as const;

interface PrBodyPayload {
  issue: string | number;
  outcome: string;
  unit_goals: string[];
  tests_pass: boolean;
  gates_pass: boolean;
  scope_deviations?: unknown;
  advisories?: unknown;
  screenshots?: unknown;
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

function list(value: unknown, key: string): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw usageError(`${key} must be an array`);
  return value;
}

function text(value: unknown, key: string): string {
  if (typeof value !== 'string' || !value.trim()) throw usageError(`${key} must be non-empty text`);
  return oneLine(value);
}

function textList(value: unknown, key: string): string[] {
  const items = list(value, key);
  if (!items.length) throw usageError(`${key} must contain at least one item`);
  return items.map((item, index) => text(item, `${key}[${index}]`));
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
  text(payload.outcome, 'outcome');
  textList(payload.unit_goals, 'unit_goals');
  for (const key of ['tests_pass', 'gates_pass']) {
    if (typeof payload[key] !== 'boolean') throw usageError(`${key} must be boolean`);
  }
  const screenshots = list(payload.screenshots, 'screenshots');
  if (screenshots.length > SCREENSHOT_CAP) {
    throw usageError(`screenshots may contain at most ${SCREENSHOT_CAP} items`);
  }
  for (const [index, screenshot] of screenshots.entries()) {
    if (
      !isObject(screenshot) ||
      !safeScreenshotName(screenshot.name) ||
      typeof screenshot.alt !== 'string' ||
      !screenshot.alt.trim()
    ) {
      throw usageError(`screenshots[${index}] must contain a safe image name and alt text`);
    }
  }
}

/** Renders verified build facts as a bounded Markdown PR body. */
export function render(payload: unknown): string {
  validatePayload(payload);
  const scope = list(payload.scope_deviations, 'scope_deviations');
  const advisories = list(payload.advisories, 'advisories');
  const screenshots = list(payload.screenshots, 'screenshots');
  const outcome = text(payload.outcome, 'outcome');
  const unitGoals = textList(payload.unit_goals, 'unit_goals');
  const tests = payload.tests_pass ? 'pass' : 'FAIL';
  const gates = payload.gates_pass ? 'pass' : 'FAIL';
  const status = [
    `<code>verify tests=${tests} gates=${gates}</code>`,
    `<code>scope-deviations ${scope.length}</code>`,
  ].join(' · ');

  const folded = [];
  for (const section of [
    renderSection(LABELS.scope, scope, inlineCode),
    renderSection(LABELS.advisories, advisories, oneLine),
  ]) {
    if (section) folded.push(section);
  }

  const verification = folded.length
    ? `<details>\n<summary>${status}</summary>\n\n${folded.join('\n\n')}\n\n</details>`
    : status;
  const visualEvidence = screenshots.length
    ? `\n\n## ${LABELS.screenshots}\n\n${screenshots
        .map((item) =>
          isObject(item)
            ? `![${markdownScreenshotAlt(String(item.alt))}](./${String(item.name)})`
            : '',
        )
        .join('\n\n')}`
    : '';
  const summary = `${outcome}\n\n${unitGoals.map((goal) => `- ${goal}`).join('\n')}`;
  return `## ${LABELS.summary}\n\n${summary}\n\n## ${LABELS.verification}\n\n${LABELS.header}\n\n${verification}${visualEvidence}\n\nCloses #${payload.issue}\n`;
}

export function describe() {
  return {
    protocol: DESCRIPTION_PROTOCOL,
    renders_with: PROTOCOL,
    command: 'codex-build-pr-body --input <absolute-json> --output <absolute-markdown>',
    input_template: {
      issue: 123,
      outcome: 'The requested behavior is implemented.',
      unit_goals: ['Implement the planned behavior.'],
      tests_pass: true,
      gates_pass: true,
      scope_deviations: [],
      advisories: [],
      screenshots: [],
    },
    required_keys: [...REQUIRED_KEYS],
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
