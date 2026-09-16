import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isRecord } from './input.ts';

export interface WritingSelection {
  documents: string[];
  exclude: string[];
}

function paths(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every(
      (path) =>
        typeof path === 'string' &&
        path.length > 0 &&
        !/[\\*?[\]{}\0]/.test(path) &&
        path
          .replace(/\/$/, '')
          .split('/')
          .every((part) => part !== '' && part !== '.' && part !== '..'),
    )
  );
}

export function writingSelection(value: unknown): WritingSelection {
  if (value === undefined) {
    return { documents: ['README.md', 'docs/'], exclude: [] };
  }
  assert(
    isRecord(value) &&
      paths(value.documents) &&
      (value.exclude === undefined || paths(value.exclude)) &&
      Object.keys(value).every((key) => ['documents', 'exclude'].includes(key)),
    'Invalid writing selection: use repo-relative file paths or directories ending in /',
  );
  return { documents: value.documents, exclude: value.exclude ?? [] };
}

export async function readWritingSelection(cwd: string) {
  let text: string;
  try {
    text = await readFile(join(cwd, '.dotagents.json'), 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return writingSelection(undefined);
    }
    throw error;
  }
  const config: unknown = JSON.parse(text);
  assert(isRecord(config), 'Invalid target configuration');
  return writingSelection(config.writing);
}

// These locations contain instructions, fixtures or Issue drafts even when explicitly selected.
export function excludedWritingPath(name: string) {
  const parts = name.toLowerCase().split('/');
  const file = parts.at(-1) ?? '';
  return (
    !file.endsWith('.md') ||
    /^(agents(?:\.[^.]+)?|skill|claude|gemini|copilot-instructions)\.md$/.test(file) ||
    /^(?:issue|issues)(?:[-_.]|$)/.test(file) ||
    /\.(?:prompt|instructions)\.md$/.test(file) ||
    parts.some((part) =>
      [
        '.agents',
        '.claude',
        '.cursor',
        '.gemini',
        'skills',
        'prompts',
        'instructions',
        'agents',
        'rules',
        'test',
        'tests',
        '__tests__',
        'fixture',
        'fixtures',
        '__fixtures__',
        'issues',
        'issue-drafts',
      ].includes(part),
    ) ||
    name.toLowerCase().includes('.github/issue_template/')
  );
}

export function issueDraft(body: string) {
  const frontmatter = body.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
  return frontmatter !== undefined && /^writing-purpose:\s*["']?issue["']?\s*$/im.test(frontmatter);
}

function matches(name: string, paths: string[]) {
  return paths.some((path) => (path.endsWith('/') ? name.startsWith(path) : name === path));
}

export function selectedDocument(name: string, selection: WritingSelection) {
  return (
    !excludedWritingPath(name) &&
    matches(name, selection.documents) &&
    !matches(name, selection.exclude)
  );
}
