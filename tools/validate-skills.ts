import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const AGENTS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PYTHON = process.platform === 'win32'
  ? path.join(AGENTS_ROOT, '.venv', 'Scripts', 'python.exe')
  : path.join(AGENTS_ROOT, '.venv', 'bin', 'python');
const VALIDATOR = path.resolve(
  AGENTS_ROOT,
  '../.codex/skills/.system/skill-creator/scripts/quick_validate.py',
);
const SKILLS = [
  'skills/build',
  'skills/code',
  '.ja/skills/build',
  '.ja/skills/code',
] as const;

function requireFile(file: string, label: string): void {
  if (!fs.statSync(file, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`${label} not found: ${file}`);
  }
}

export function main(): void {
  requireFile(PYTHON, 'virtualenv Python');
  requireFile(VALIDATOR, 'skill validator');

  const failures: string[] = [];
  for (const skill of SKILLS) {
    const skillPath = path.join(AGENTS_ROOT, skill);
    const result = spawnSync(PYTHON, [VALIDATOR, skillPath], {
      cwd: AGENTS_ROOT,
      encoding: 'utf8',
      env: process.env,
    });
    const detail = (result.stdout || result.stderr || result.error?.message || 'validation failed').trim();
    process.stdout.write(`${skill}: ${detail}\n`);
    if (result.status !== 0 || result.error) failures.push(skill);
  }

  if (failures.length) {
    throw new Error(`skill validation failed: ${failures.join(', ')}`);
  }
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
