/** @file Outcome: Every maintained skill has valid closed frontmatter and no unfinished instructions. */

import * as fs from 'node:fs';
import path from 'node:path';

import { parseDocument } from 'yaml';

import { AGENTS_ROOT, isMainModule } from '../workflows/shared/environment.ts';
import { errorMessage } from '../workflows/shared/errors.ts';
import { isObject } from '../workflows/shared/schema.ts';

const MAX_SKILL_NAME_LENGTH = 64;
const ALLOWED_FRONTMATTER_KEYS = new Set([
  'name',
  'description',
  'license',
  'allowed-tools',
  'metadata',
]);
const SKILLS = [
  'skills/build',
  'skills/code',
  'skills/issue',
  'skills/research',
  'skills/think',
  '.ja/skills/build',
  '.ja/skills/code',
  '.ja/skills/issue',
  '.ja/skills/research',
  '.ja/skills/think',
] as const;

interface SkillValidationResult {
  valid: boolean;
  message: string;
}

function result(valid: boolean, message: string): SkillValidationResult {
  return { valid, message };
}

function validateName(value: unknown): SkillValidationResult | null {
  if (typeof value !== 'string') return result(false, 'Name must be a string');
  const name = value.trim();
  if (!name) return result(false, 'Name must not be empty');
  if (!/^[a-z0-9-]+$/u.test(name)) {
    return result(false, `Name '${name}' should be hyphen-case`);
  }
  if (name.startsWith('-') || name.endsWith('-') || name.includes('--')) {
    return result(false, `Name '${name}' has invalid hyphen placement`);
  }
  if (name.length > MAX_SKILL_NAME_LENGTH) {
    return result(false, `Name is too long (${name.length} characters)`);
  }
  return null;
}

function validateDescription(value: unknown): SkillValidationResult | null {
  if (typeof value !== 'string') return result(false, 'Description must be a string');
  const description = value.trim();
  if (!description) return result(false, 'Description must not be empty');
  if (description.startsWith('[TODO:')) {
    return result(false, 'Description contains an unfinished TODO placeholder');
  }
  if (description.includes('<') || description.includes('>')) {
    return result(false, 'Description cannot contain angle brackets (< or >)');
  }
  if (description.length > 1024) {
    return result(false, `Description is too long (${description.length} characters)`);
  }
  return null;
}

function containsUnfinishedTodo(body: string): boolean {
  let fenceMarker: string | null = null;
  let fenceLength = 0;
  for (const line of body.split(/\r?\n/u)) {
    const fence = /^[ \t]*(?:(?:[-+*]|\d+[.)])[ \t]+)?(`{3,}|~{3,})(.*)$/u.exec(line);
    if (fence) {
      const marker = fence[1]!;
      if (fenceMarker === null) {
        fenceMarker = marker[0]!;
        fenceLength = marker.length;
      } else if (marker[0] === fenceMarker && marker.length >= fenceLength && !fence[2]!.trim()) {
        fenceMarker = null;
        fenceLength = 0;
      }
      continue;
    }
    if (fenceMarker === null && /^[ ]{0,3}\[TODO:[^\n]*\][ \t]*$/u.test(line)) return true;
  }
  return false;
}

/** Validates one skill's closed frontmatter and finished instruction body. */
export function validateSkill(skillPath: string): SkillValidationResult {
  const skillFile = path.join(skillPath, 'SKILL.md');
  if (!fs.statSync(skillFile, { throwIfNoEntry: false })?.isFile()) {
    return result(false, 'SKILL.md not found');
  }

  const content = fs.readFileSync(skillFile, 'utf8');
  if (!content.startsWith('---')) return result(false, 'No YAML frontmatter found');
  const frontmatterMatch = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(content);
  if (!frontmatterMatch) return result(false, 'Invalid frontmatter format');

  const document = parseDocument(frontmatterMatch[1]!);
  if (document.errors.length) {
    return result(false, `Invalid YAML in frontmatter: ${document.errors[0]!.message}`);
  }
  const frontmatter: unknown = document.toJS();
  if (!isObject(frontmatter)) return result(false, 'Frontmatter must be a YAML dictionary');

  const unexpected = Object.keys(frontmatter)
    .filter((key) => !ALLOWED_FRONTMATTER_KEYS.has(key))
    .sort();
  if (unexpected.length) {
    return result(false, `Unexpected key(s) in SKILL.md frontmatter: ${unexpected.join(', ')}`);
  }
  if (!Object.hasOwn(frontmatter, 'name')) return result(false, "Missing 'name' in frontmatter");
  if (!Object.hasOwn(frontmatter, 'description')) {
    return result(false, "Missing 'description' in frontmatter");
  }

  const nameFailure = validateName(frontmatter.name);
  if (nameFailure) return nameFailure;
  const descriptionFailure = validateDescription(frontmatter.description);
  if (descriptionFailure) return descriptionFailure;

  const body = content.slice(frontmatterMatch[0].length);
  if (containsUnfinishedTodo(body)) {
    return result(false, 'Skill instructions contain an unfinished TODO placeholder');
  }
  return result(true, 'Skill is valid!');
}

function main(): void {
  const failures: string[] = [];
  for (const skill of SKILLS) {
    const validation = validateSkill(path.join(AGENTS_ROOT, skill));
    process.stdout.write(`${skill}: ${validation.message}\n`);
    if (!validation.valid) failures.push(skill);
  }
  if (failures.length) throw new Error(`skill validation failed: ${failures.join(', ')}`);
}

if (isMainModule(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${errorMessage(error)}\n`);
    process.exitCode = 1;
  }
}
